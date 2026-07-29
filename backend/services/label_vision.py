"""Lectura de la etiqueta de cartón COMPLETA por visión (Claude).

Para "Inventario por foto": el material de RP-GEN sale del país y no está en el
sistema, así que el renglón de exportación tiene que armarse con lo que dice la
etiqueta física — incluidos país de origen y contenido, que son datos aduanales
y NO viajan en ningún barcode.

Por qué visión y no Tesseract: Tesseract se probó a fondo sobre estas etiquetas
y falla justo en Style y Units. Un modelo de visión lee la plantilla entera.

Se combina con `label_barcode`: los dos CODE39 dan cartón y SKU de forma
determinista, y esos ganan sobre lo que haya leído el modelo — son los campos de
identidad, donde un dígito mal arruina el conteo. Todo lo demás lo confirma el
operador en pantalla antes de guardarse.
"""
import base64
import io
import os

from PIL import Image, ImageOps

from claude_client import get_client, text_of, json_from_text

# Opus 5 admite imagen de hasta 2576 px de lado largo. La etiqueta tiene texto
# chico (contenido de tela), así que conviene resolución alta; el tope acota
# tanto el costo por foto como la memoria del backend.
MODEL = os.environ.get("LABEL_VISION_MODEL", "claude-opus-5")
EFFORT = os.environ.get("LABEL_VISION_EFFORT", "low")
_MAX_EDGE = 2000

CAMPOS = ("customer", "manufacturer", "style", "color", "size", "description",
          "country_of_origin", "fabric_content", "dozens", "pieces", "units",
          "sku", "carton")

_SCHEMA = {
    "type": "object",
    "properties": {c: {"type": "string"} for c in CAMPOS},
    "required": list(CAMPOS),
    "additionalProperties": False,
}

_PROMPT = """Esta es la foto de una etiqueta de cartón de un almacén textil
(plantilla "Quasar Systems WMS"). Extrae los campos EXACTAMENTE como aparecen
impresos.

Reglas:
- Copia el texto tal cual lo ves. No traduzcas, no corrijas, no completes.
- Si un campo no se alcanza a leer o no está en la etiqueta, devuelve "".
  Es preferible vacío a un dato inventado: un operador va a revisar y completar.
- `carton` es el número largo del barcode de arriba (formato A#########).
- `sku` es el número corto del barcode de abajo.
- `dozens`, `pieces` y `units` son la fila de cantidades; devuélvelos solo con
  dígitos. `units` es el total de piezas del cartón y es el dato más importante.
- `country_of_origin` y `fabric_content` se usan para exportar el material, así
  que cópialos completos (ej. "100% COTTON", "REPUBLICA DOMINICANA")."""


def vision_disponible() -> bool:
    """Hay forma de autenticar contra Anthropic. No garantiza que la llave sirva."""
    return bool(os.environ.get("ANTHROPIC_API_KEY"))


def _preparar(image_bytes: bytes) -> tuple:
    """Normaliza a JPEG y acota el lado largo. Devuelve (base64, media_type)."""
    img = Image.open(io.BytesIO(image_bytes))
    img = ImageOps.exif_transpose(img)          # respeta la orientación de la cámara
    if img.mode not in ("RGB", "L"):
        img = img.convert("RGB")
    w, h = img.size
    if max(w, h) > _MAX_EDGE:
        f = _MAX_EDGE / max(w, h)
        img = img.resize((max(1, int(w * f)), max(1, int(h * f))))
    buf = io.BytesIO()
    img.convert("RGB").save(buf, format="JPEG", quality=88)
    return base64.standard_b64encode(buf.getvalue()).decode("utf-8"), "image/jpeg"


async def read_label(image_bytes: bytes) -> dict:
    """Lee la etiqueta completa. Devuelve un dict con todos los campos de CAMPOS
    (los que no se pudieron leer quedan en "")."""
    b64, media_type = _preparar(image_bytes)
    client = await get_client()
    msg = await client.messages.create(
        model=MODEL,
        max_tokens=4000,                  # cubre thinking + respuesta en Opus 5
        output_config={
            "effort": EFFORT,
            "format": {"type": "json_schema", "schema": _SCHEMA},
        },
        messages=[{
            "role": "user",
            "content": [
                {"type": "image", "source": {"type": "base64",
                                             "media_type": media_type, "data": b64}},
                {"type": "text", "text": _PROMPT},
            ],
        }],
    )
    if getattr(msg, "stop_reason", None) == "refusal":
        raise RuntimeError("El modelo no pudo procesar la imagen.")
    datos = json_from_text(text_of(msg)) or {}
    return {c: str(datos.get(c) or "").strip() for c in CAMPOS}
