"""Lectura de la etiqueta de cartón (Quasar Systems WMS) — LOCAL y determinista.

Sin IA, sin nube, sin costo por foto: Tesseract en el propio servidor.

Cómo funciona, y por qué los intentos anteriores fallaban:

1. ANCLAS. Los dos barcodes de la etiqueta se decodifican con zbar, que además
   devuelve su posición. Como la plantilla es fija, esas dos cajas dan escala y
   posición exactas, y cada campo se puede recortar por su lugar. Los intentos
   previos buscaban los rótulos por texto ("Style", "Color") — y son justo lo
   que peor lee el OCR, así que un rótulo mal leído mandaba el valor de otro
   campo al campo equivocado.

2. UNA LÍNEA A LA VEZ. Dentro de cada banda se localiza la línea del valor
   (descartando la del rótulo) y se relee sola con `--psm 7`. Esto importa más
   de lo que parece: con `--psm 6` sobre la banda entera, Tesseract leía "9000"
   donde la etiqueta dice "5000" — de forma reproducible. Psm 6 asume un bloque
   de texto uniforme y la banda tiene dos tamaños de letra muy distintos.

3. CONSENSO. Cada línea se lee con tres preprocesos distintos y sólo se acepta
   el valor en que coincidan al menos dos. Si discrepan, el campo va vacío.

4. VALIDACIÓN. Las tallas contra la lista de tallas, el país contra la lista de
   países, las cantidades sólo dígitos. Lo que no valida, va vacío.

Los puntos 3 y 4 existen por una razón: esto alimenta un manifiesto de salida
del país. Un campo vacío se ve y el operador lo escribe; un dato equivocado no
se ve y se exporta. Ante la duda, vacío.
"""
import io
import os
import re
import difflib

try:
    import pytesseract
    from PIL import Image, ImageOps, ImageFilter
    _OCR_OK = True
    _OCR_ERR = ""
except Exception as e:  # pragma: no cover - depende del entorno
    _OCR_OK = False
    _OCR_ERR = str(e)

_WIN = r"C:\Program Files\Tesseract-OCR\tesseract.exe"
if _OCR_OK:
    _cmd = os.environ.get("TESSERACT_CMD") or (_WIN if os.path.exists(_WIN) else None)
    if _cmd:
        pytesseract.pytesseract.tesseract_cmd = _cmd

CAMPOS = ("customer", "manufacturer", "style", "color", "size", "description",
          "country_of_origin", "fabric_content", "dozens", "pieces", "units",
          "sku", "carton")

_DIG = "0123456789"
_ALFA = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"

# Bandas (y0, y1, x0, x1) en coordenadas normalizadas: `y` respecto a la
# distancia entre los centros de los dos barcodes, `x` respecto al ancho del
# barcode de cartón. Cada banda cubre el par rótulo+valor con margen.
# `wl` = caracteres permitidos; None = sin restricción (los valores con espacios
# la necesitan libre, porque el config de Tesseract se parte por espacios).
_BANDAS = {
    "customer":          (0.100, 0.215, -0.10, 0.62, None),
    "manufacturer":      (0.205, 0.315, -0.10, 0.45, None),
    "style":             (0.318, 0.418, -0.10, 0.32, _DIG + _ALFA + "-"),
    "color":             (0.428, 0.528, -0.10, 0.45, None),
    "size":              (0.436, 0.536,  0.76, 1.00, _ALFA + _DIG),
    "description":       (0.528, 0.628, -0.10, 0.62, None),
    "country_of_origin": (0.650, 0.752, -0.10, 0.68, None),
    "fabric_content":    (0.746, 0.846, -0.10, 0.58, None),
    "dozens":            (0.824, 0.952, -0.10, 0.14, _DIG),
    "pieces":            (0.824, 0.952,  0.20, 0.42, _DIG),
    "units":             (0.824, 0.952,  0.84, 1.08, _DIG),
}

_ROTULOS = ["CUSTOMER", "MANUFACTURER", "STYLE", "COLOR", "SIZE", "DESCRIPTION",
            "COUNTRYOFORIGIN", "FABRICCONTENT", "DOZENS", "PIECES", "UNITS",
            "PURCHASEORDER", "LOTNUMBER", "SKU", "QUASARSYSTEMS"]

_TALLAS = {"XS", "S", "M", "L", "XL", "XXL", "2X", "2XL", "3X", "3XL", "4X", "4XL",
           "5X", "6X", "YXS", "YS", "YM", "YL", "YXL", "2T", "3T", "4T", "5T"}
_PAISES = ["REPUBLICA DOMINICANA", "HAITI", "HONDURAS", "NICARAGUA", "GUATEMALA",
           "EL SALVADOR", "MEXICO", "COSTA RICA", "BANGLADESH", "PAKISTAN", "INDIA",
           "VIETNAM", "CHINA", "CAMBODIA", "INDONESIA", "PERU", "COLOMBIA", "USA",
           "UNITED STATES", "EGYPT", "JORDAN", "TURKEY"]


def ocr_disponible() -> bool:
    return _OCR_OK


def motor_error() -> str:
    return _OCR_ERR


# ── validación por campo ─────────────────────────────────────────────────────

def _v_digitos(v):
    d = re.sub(r"[^\d]", "", v or "")
    return d if d.isdigit() and len(d) <= 6 else ""


def _v_texto(v):
    v = re.sub(r"\s+", " ", (v or "")).strip(" :.-_|")
    return v if len(v) >= 2 and re.search(r"[A-Za-z]", v) else ""


def _v_size(v):
    u = re.sub(r"[^A-Z0-9]", "", (v or "").upper())
    return u if u in _TALLAS else ""


def _v_pais(v):
    u = _v_texto(v).upper()
    if len(u) < 4:
        return ""
    m = difflib.get_close_matches(u, _PAISES, n=1, cutoff=0.7)
    return m[0] if m else u


def _v_fabric(v):
    u = re.sub(r"\s+", " ", (v or "")).strip().upper()
    ok = "%" in u or re.search(r"COTTON|POLY|RAYON|SPANDEX|LINEN|MODAL|VISCOSE|NYLON", u)
    return u if ok and len(u) >= 4 else ""


def _v_style(v):
    u = re.sub(r"\s+", "", (v or "").upper())
    return u if re.fullmatch(r"[A-Z0-9][A-Z0-9\-]{1,14}", u or "") else ""


_VALIDA = {
    "customer": _v_texto, "manufacturer": _v_texto, "style": _v_style,
    "color": _v_texto, "size": _v_size, "description": _v_texto,
    "country_of_origin": _v_pais, "fabric_content": _v_fabric,
    "dozens": _v_digitos, "pieces": _v_digitos, "units": _v_digitos,
}


def _es_rotulo(t: str) -> bool:
    u = re.sub(r"[^A-Z]", "", (t or "").upper())
    if not u:
        return False                       # puro número: es un valor
    for r in _ROTULOS:
        if r in u or difflib.SequenceMatcher(None, r, u).ratio() >= 0.72:
            return True
    return False


def _lee(img, wl, psm="7") -> str:
    cfg = f"--psm {psm}" if not wl else f"--psm {psm} -c tessedit_char_whitelist={wl}"
    try:
        return pytesseract.image_to_string(img, config=cfg).strip()
    except Exception:
        return ""


def _linea_valor(banda, wl):
    """Dentro de la banda, la caja de la primera línea que no es un rótulo."""
    try:
        d = pytesseract.image_to_data(banda, config="--psm 6",
                                      output_type=pytesseract.Output.DICT)
    except Exception:
        return None
    lineas = {}
    for i, txt in enumerate(d["text"]):
        t = (txt or "").strip()
        if not t:
            continue
        try:
            if int(float(d["conf"][i])) < 20:
                continue
        except (TypeError, ValueError):
            continue
        k = (d["block_num"][i], d["par_num"][i], d["line_num"][i])
        c = lineas.setdefault(k, {"t": [], "x0": 10**9, "y0": 10**9, "x1": 0, "y1": 0})
        c["t"].append(t)
        c["x0"] = min(c["x0"], d["left"][i]); c["y0"] = min(c["y0"], d["top"][i])
        c["x1"] = max(c["x1"], d["left"][i] + d["width"][i])
        c["y1"] = max(c["y1"], d["top"][i] + d["height"][i])
    for k in sorted(lineas, key=lambda k: lineas[k]["y0"]):
        c = lineas[k]
        if not _es_rotulo(" ".join(c["t"])):
            return c
    return None


def _consenso(img, wl) -> str:
    """Lecturas del mismo recorte; se acepta lo que repitan al menos dos.

    Se prueba psm 7 (una línea) y, si no hubo acuerdo, psm 8 y 10 (una palabra /
    un carácter), que rescatan los valores de un solo símbolo como la talla."""
    variantes = (img, img.filter(ImageFilter.SHARPEN),
                 img.point(lambda p: 0 if p < 140 else 255))
    for psm in ("7", "8", "10"):
        votos = {}
        for v in variantes:
            k = re.sub(r"\s+", " ", _lee(v, wl, psm)).strip()
            if k:
                votos[k] = votos.get(k, 0) + 1
        if votos:
            mejor, n = max(votos.items(), key=lambda kv: kv[1])
            if n >= 2:
                return mejor
    return ""


def parse_label(image_bytes: bytes) -> dict:
    """Lee la etiqueta apoyándose en los barcodes como anclas.

    Devuelve todos los campos de CAMPOS; los que no se pudieron leer con
    confianza quedan vacíos para que el operador los escriba. `carton` y `sku`
    vienen del barcode (exactos); el resto, del OCR por regiones.
    """
    if not _OCR_OK:
        raise RuntimeError(f"OCR no disponible (pytesseract/tesseract): {_OCR_ERR}")
    from services.label_barcode import decode_label

    campos = {c: "" for c in CAMPOS}
    bc = decode_label(image_bytes)
    campos["carton"], campos["sku"] = bc.get("carton", ""), bc.get("sku", "")

    cajas = {b["data"]: b for b in bc.get("barcodes", [])}
    a_cart, a_sku = cajas.get(campos["carton"]), cajas.get(campos["sku"])
    if not a_cart or not a_sku:
        # Sin las dos anclas no hay geometría fiable: mejor devolver los códigos
        # que sí se leyeron y dejar el resto al operador que inventar posiciones.
        return campos

    img = ImageOps.exif_transpose(Image.open(io.BytesIO(image_bytes))).convert("L")
    img = ImageOps.autocontrast(img, cutoff=1)
    yA = a_cart["top"] + a_cart["height"] / 2
    H = (a_sku["top"] + a_sku["height"] / 2) - yA
    xA, W = a_cart["left"], a_cart["width"]
    if H <= 0 or W <= 0:
        return campos

    for campo, (y0, y1, x0, x1, wl) in _BANDAS.items():
        box = (max(0, int(xA + x0 * W)), max(0, int(yA + y0 * H)),
               min(img.width, int(xA + x1 * W)), min(img.height, int(yA + y1 * H)))
        if box[2] - box[0] < 8 or box[3] - box[1] < 8:
            continue
        banda = img.crop(box)
        banda = banda.resize((banda.width * 3, banda.height * 3), Image.LANCZOS)
        ln = _linea_valor(banda, wl)
        if not ln:
            continue
        m = max(4, (ln["y1"] - ln["y0"]) // 5)      # margen para no cortar trazos
        recorte = banda.crop((max(0, ln["x0"] - m), max(0, ln["y0"] - m),
                              min(banda.width, ln["x1"] + m),
                              min(banda.height, ln["y1"] + m)))
        campos[campo] = _VALIDA[campo](_consenso(recorte, wl))
    return campos
