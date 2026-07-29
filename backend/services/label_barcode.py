"""Motor de lectura de etiquetas de cartón (Quasar Systems WMS) por BARCODE.

Para la herramienta "Inventario por foto" de Conciliación: el cartón físico no
trae el box_id sintético del WMS, pero SÍ trae dos barcodes impresos —arriba el
número de cartón (A#########) y abajo el SKU—. Se decodifican con pyzbar (zbar),
que es determinista: o lee el código o no lo lee, nunca "adivina" mal.

Por qué barcode y no OCR: el OCR (Tesseract) se probó a fondo sobre estas
etiquetas y resultó inconsistente justo en Style y Units — inaceptable para
inventario. zbar decodifica ambos barcodes incluso en fotos arrugadas.

Estrategia: se intentan variantes de la imagen de la más barata a la más cara
(directa -> gris/contraste -> escalada -> rotada -> binarizada) y se corta en
cuanto se obtienen los dos códigos. Una foto buena resuelve en el primer intento.

Requiere la librería del sistema `libzbar0` (Docker: apt-get install libzbar0;
en Windows el wheel de pyzbar ya trae las DLLs).
"""
import io
import re

try:
    from pyzbar import pyzbar
    from PIL import Image, ImageOps
    _ZBAR_OK = True
    _ZBAR_ERR = ""
except Exception as e:  # pragma: no cover - depende del entorno
    _ZBAR_OK = False
    _ZBAR_ERR = str(e)

# Nº de cartón: una o dos letras + dígitos (visto: A2524611066).
_RE_CARTON = re.compile(r"^[A-Z]{1,2}\d{8,}$")
# SKU: numérico corto (visto: 71603).
_RE_SKU = re.compile(r"^\d{3,8}$")

# Tope de píxeles para no reventar memoria con fotos de 12 MP en la PDA.
_MAX_PIXELS = 4000


def barcode_disponible() -> bool:
    return _ZBAR_OK


def motor_error() -> str:
    return _ZBAR_ERR


def _base_image(image_bytes: bytes):
    img = Image.open(io.BytesIO(image_bytes))
    img = ImageOps.exif_transpose(img)      # respeta la orientación de la cámara
    img = img.convert("L")                  # zbar trabaja en gris; ahorra memoria
    w, h = img.size
    if max(w, h) > _MAX_PIXELS:
        f = _MAX_PIXELS / max(w, h)
        img = img.resize((max(1, int(w * f)), max(1, int(h * f))))
    return img


def _variantes(img):
    """Variantes de la imagen, de la más barata a la más cara. Generador: si el
    primer intento ya trae los dos códigos, las caras nunca se calculan."""
    yield "directa", img
    yield "autocontraste", ImageOps.autocontrast(img, cutoff=1)
    w, h = img.size
    if max(w, h) < 2000:                    # foto chica: al barcode le falta resolución
        yield "escalada2x", img.resize((w * 2, h * 2))
    for ang in (90, 180, 270):              # etiqueta fotografiada de lado
        yield f"rot{ang}", img.rotate(ang, expand=True)
    # Último recurso: blanco y negro duro (arrugas y sombras suaves).
    yield "binarizada", ImageOps.autocontrast(img, cutoff=1).point(lambda p: 0 if p < 128 else 255)


def _decode(img):
    out = []
    for s in pyzbar.decode(img):
        try:
            data = s.data.decode("utf-8", "ignore").strip().upper()
        except Exception:
            continue
        if not data:
            continue
        out.append({
            "data": data,
            "type": s.type,
            "top": int(s.rect.top),
            "left": int(s.rect.left),
            "width": int(s.rect.width),
            "height": int(s.rect.height),
        })
    return out


def _clasificar(barcodes: list) -> tuple:
    """(carton, sku). Primero por forma del código; si empata, por posición: en
    la plantilla el barcode de arriba es el cartón y el de abajo el SKU."""
    carton = next((b["data"] for b in barcodes if _RE_CARTON.match(b["data"])), "")
    sku = next((b["data"] for b in barcodes
                if _RE_SKU.match(b["data"]) and b["data"] != carton), "")
    if not carton or not sku:
        # Fallback posicional sobre lo que quedó sin clasificar.
        libres = sorted([b for b in barcodes if b["data"] not in (carton, sku)],
                        key=lambda b: b["top"])
        if not carton and libres:
            carton = libres.pop(0)["data"]
        if not sku and libres:
            sku = libres[-1]["data"]
    return carton, sku


def decode_label(image_bytes: bytes) -> dict:
    """Lee los barcodes de una foto de etiqueta.

    Devuelve {ok, carton, sku, barcodes, variante}. `ok` es True sólo si salieron
    los DOS códigos: con uno solo el renglón no sirve, así que la PDA debe pedir
    otra foto en vez de dejar que el operador teclee (que es donde entra el error).
    """
    if not _ZBAR_OK:
        raise RuntimeError(f"Lector de barcode no disponible (pyzbar/libzbar0): {_ZBAR_ERR}")

    img = _base_image(image_bytes)
    mejor, mejor_var = [], ""
    for nombre, variante in _variantes(img):
        found = _decode(variante)
        # Nos quedamos con la variante que más códigos distintos dio.
        if len({b["data"] for b in found}) > len({b["data"] for b in mejor}):
            mejor, mejor_var = found, nombre
        carton, sku = _clasificar(mejor)
        if carton and sku:
            return {"ok": True, "carton": carton, "sku": sku,
                    "barcodes": mejor, "variante": mejor_var}

    carton, sku = _clasificar(mejor)
    return {"ok": False, "carton": carton, "sku": sku,
            "barcodes": mejor, "variante": mejor_var,
            "error": "No se pudieron leer los dos barcodes. Acerca la cámara a la "
                     "etiqueta, con luz pareja y el cartón lo más plano posible."}
