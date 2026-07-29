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

# Proporciones fijas de la plantilla, medidas sobre las fotos de referencia
# (nítida y arrugada, que coincidieron en 1.493 y 1.497): permiten anclar aunque
# sólo se lea uno de los dos códigos.
# Alto al que se lleva cada banda antes de leerla, en píxeles. Es el tamaño con
# el que se calibró: normalizar aquí hace que una foto de 8 MP y una de 1 MP se
# lean igual de bien.
_ALTO_BANDA = 520
_ALTO_LINEA = 150          # alto al que se lleva una línea suelta antes de leerla

_PROP_H_W = 1.495          # distancia entre códigos ÷ ancho del código de cartón
_PROP_SKU_W = 0.384        # ancho del código de SKU ÷ ancho del código de cartón

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


def _lineas_pagina(img):
    """Todas las líneas de la imagen con su caja. Se usa cuando no hay códigos
    de barras que sirvan de ancla: los rótulos de la plantilla hacen ese papel."""
    try:
        d = pytesseract.image_to_data(img, config="--psm 4",
                                      output_type=pytesseract.Output.DICT)
    except Exception:
        return []
    ls = {}
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
        c = ls.setdefault(k, {"t": [], "x0": 10**9, "y0": 10**9, "x1": 0, "y1": 0})
        c["t"].append(t)
        c["x0"] = min(c["x0"], d["left"][i]); c["y0"] = min(c["y0"], d["top"][i])
        c["x1"] = max(c["x1"], d["left"][i] + d["width"][i])
        c["y1"] = max(c["y1"], d["top"][i] + d["height"][i])
    out = []
    for c in ls.values():
        c["texto"] = " ".join(c["t"])
        c["cy"] = (c["y0"] + c["y1"]) / 2
        c["alto"] = c["y1"] - c["y0"]
        out.append(c)
    return sorted(out, key=lambda l: l["cy"])


def _parecido(linea, rotulo) -> float:
    u = re.sub(r"[^A-Z]", "", linea["texto"].upper())
    if not u:
        return 0.0
    if rotulo in u:
        return 0.97
    return max(difflib.SequenceMatcher(None, rotulo, u).ratio(),
               difflib.SequenceMatcher(None, rotulo, u[:len(rotulo) + 2]).ratio())


# Rótulo de cada campo, en el orden vertical de la plantilla.
_ORDEN = [("customer", "CUSTOMER"), ("manufacturer", "MANUFACTURER"),
          ("style", "STYLE"), ("color", "COLOR"), ("size", "SIZE"),
          ("description", "DESCRIPTION"), ("country_of_origin", "COUNTRYOFORIGIN"),
          ("fabric_content", "FABRICCONTENT"), ("dozens", "DOZENS"),
          ("pieces", "PIECES"), ("units", "UNITS")]


# Posición vertical de cada rótulo en la plantilla, en las mismas coordenadas
# normalizadas que _BANDAS. Permiten reconstruir la geometría sin códigos.
_U_ROTULO = {c: _BANDAS[c][0] for c, _ in _ORDEN if c in _BANDAS}
_PROP_XA = 0.087           # xA ≈ borde izquierdo de los rótulos + esto × W


def _anclas_rotulos(lineas):
    """Rótulos detectados, en el orden vertical de la plantilla."""
    anclas, piso = {}, -1.0
    for campo, rot in _ORDEN:
        cands = [ln for ln in lineas if ln["cy"] > piso and _parecido(ln, rot) >= 0.82]
        if not cands:
            continue
        ln = min(cands, key=lambda l: l["cy"])
        anclas[campo] = ln
        piso = ln["cy"]
    return anclas


def _geometria_por_rotulos(img):
    """Deriva (xA, yA, W, H) de los rótulos, para cuando no hay códigos.

    Con dos rótulos cualesquiera basta: se conoce su posición en la plantilla,
    así que una recta da escala y desplazamiento, y de ahí salen las mismas
    bandas que ya están calibradas. Así un rótulo ilegible deja de costar su
    campo — lo cubren los demás."""
    lineas = _lineas_pagina(img)
    if not lineas:
        return None, []
    anclas = _anclas_rotulos(lineas)
    pts = [(_U_ROTULO[c], ln["cy"]) for c, ln in anclas.items() if c in _U_ROTULO]
    if len(pts) < 2:
        return None, lineas
    n = len(pts)
    su = sum(p[0] for p in pts); sy = sum(p[1] for p in pts)
    suu = sum(p[0] * p[0] for p in pts); suy = sum(p[0] * p[1] for p in pts)
    den = n * suu - su * su
    if abs(den) < 1e-9:
        return None, lineas
    H = (n * suy - su * sy) / den          # cy = yA + u·H  (mínimos cuadrados)
    yA = (sy - H * su) / n
    if H <= 0:
        return None, lineas
    W = H / _PROP_H_W
    izq = [ln["x0"] for c, ln in anclas.items() if c not in ("size", "units", "pieces")]
    xA = (min(izq) if izq else 0) + _PROP_XA * W
    return (xA, yA, W, H), lineas


def _por_rotulos(img, campos):
    """Lee la etiqueta anclándose en sus rótulos, sin necesitar los códigos.

    Los rótulos se buscan EN ORDEN: exigir que aparezcan de arriba abajo como en
    la plantilla descarta los falsos positivos, que es lo que antes mandaba el
    valor de un campo al campo de al lado."""
    lineas = _lineas_pagina(img)
    if not lineas:
        return campos
    anclas, piso = {}, -1.0
    for campo, rot in _ORDEN:
        cands = [ln for ln in lineas if ln["cy"] > piso and _parecido(ln, rot) >= 0.82]
        if not cands:
            continue
        ln = min(cands, key=lambda l: l["cy"])
        anclas[campo] = ln
        piso = ln["cy"]

    for campo, ln in anclas.items():
        margen = (ln["x1"] - ln["x0"]) * 0.6 + ln["alto"]
        x0, x1 = ln["x0"] - margen, ln["x1"] + margen
        cands = [o for o in lineas
                 if o is not ln
                 and ln["cy"] + ln["alto"] * 0.4 < o["cy"] < ln["cy"] + ln["alto"] * 3.2
                 and min(x1, o["x1"]) - max(x0, o["x0"]) > 0
                 and not _es_rotulo(o["texto"])]
        if not cands:
            continue
        v = min(cands, key=lambda l: l["cy"])
        m = max(4, (v["y1"] - v["y0"]) // 5)
        recorte = img.crop((max(0, v["x0"] - m), max(0, v["y0"] - m),
                            min(img.width, v["x1"] + m), min(img.height, v["y1"] + m)))
        f = max(0.6, min(6.0, _ALTO_LINEA / max(1, recorte.height)))
        recorte = recorte.resize((max(1, int(recorte.width * f)),
                                  max(1, int(recorte.height * f))), Image.LANCZOS)
        wl = _BANDAS[campo][4] if campo in _BANDAS else None
        valor = _VALIDA[campo](_consenso(recorte, wl))
        if valor:
            campos[campo] = valor
    return campos


def _por_bandas(img, campos, xA, yA, W, H):
    """Recorta cada campo por su banda y lo lee. `xA/yA/W/H` es la geometría de
    la etiqueta, venga de los códigos o derivada de los rótulos."""
    for campo, (y0, y1, x0, x1, wl) in _BANDAS.items():
        if campos.get(campo):
            continue
        box = (max(0, int(xA + x0 * W)), max(0, int(yA + y0 * H)),
               min(img.width, int(xA + x1 * W)), min(img.height, int(yA + y1 * H)))
        if box[2] - box[0] < 8 or box[3] - box[1] < 8:
            continue
        banda = img.crop(box)
        # Normalizar el alto de la banda en vez de escalar x3 a ciegas. Con una
        # foto de tablet de 8 MP, el x3 dejaba recortes enormes y Tesseract se
        # degradaba: llegó a leer "12" donde la etiqueta dice "72" — y la
        # cantidad es justo el dato que no puede salir mal.
        f = max(0.5, min(4.0, _ALTO_BANDA / max(1, banda.height)))
        banda = banda.resize((max(1, int(banda.width * f)),
                              max(1, int(banda.height * f))), Image.LANCZOS)
        ln = _linea_valor(banda, wl)
        if not ln:
            continue
        m = max(4, (ln["y1"] - ln["y0"]) // 5)      # margen para no cortar trazos
        recorte = banda.crop((max(0, ln["x0"] - m), max(0, ln["y0"] - m),
                              min(banda.width, ln["x1"] + m),
                              min(banda.height, ln["y1"] + m)))
        campos[campo] = _VALIDA[campo](_consenso(recorte, wl))
    return campos


def _cajas_de(res):
    return {b["data"]: b for b in res.get("barcodes", [])}


def _bien_orientada(cajas, carton, sku) -> bool:
    """En la etiqueta derecha el código de cartón es claramente apaisado y el de
    SKU queda por debajo."""
    c = cajas.get(carton)
    if not c or c["width"] <= c["height"] * 1.5:
        return False
    s = cajas.get(sku)
    return True if not s else s["top"] > c["top"]


def _enderezar(image_bytes, bc):
    """Devuelve (imagen enderezada, cajas de los códigos en esa imagen).

    Se rota y se vuelve a decodificar en lugar de transformar las coordenadas a
    mano: una llamada más a zbar cuesta poco y evita toda una clase de errores
    de conversión, que es justo lo que rompía la lectura."""
    from services.label_barcode import base_image, rotacion_de, decode_label as _dec
    base = base_image(image_bytes)
    rot = rotacion_de(bc.get("variante", ""))
    img0 = base.rotate(rot, expand=True) if rot else base
    cajas0 = _cajas_de(bc)
    carton, sku = bc.get("carton", ""), bc.get("sku", "")
    if _bien_orientada(cajas0, carton, sku):
        return ImageOps.autocontrast(img0, cutoff=1), cajas0

    c = cajas0.get(carton) or cajas0.get(sku)
    # Si el código se ve más alto que ancho, la etiqueta está acostada.
    candidatas = (90, 270, 180) if (c and c["height"] > c["width"]) else (180, 90, 270)
    for ang in candidatas:
        rotada = img0.rotate(ang, expand=True)
        buf = io.BytesIO()
        rotada.save(buf, format="PNG")
        res = _dec(buf.getvalue())
        cajas = _cajas_de(res)
        if _bien_orientada(cajas, res.get("carton", ""), res.get("sku", "")):
            return ImageOps.autocontrast(rotada, cutoff=1), cajas
    return ImageOps.autocontrast(img0, cutoff=1), cajas0


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

    # Enderezar la etiqueta ANTES de recortar. Las bandas están definidas sobre
    # la etiqueta vertical; si la foto se tomó de lado —cosa normal con una
    # tablet— los recortes caen en el vacío y el modal sale entero vacío aunque
    # el texto se vea perfecto. El barcode de cartón es la brújula: en la
    # etiqueta derecha es mucho más ancho que alto.
    img, cajas = _enderezar(image_bytes, bc)
    a_cart, a_sku = cajas.get(campos["carton"]), cajas.get(campos["sku"])

    # Sin ningún código legible se lee igual, anclando en los rótulos. Los
    # códigos son una ayuda (dan la geometría exacta y el nº de cartón gratis),
    # NO un requisito: en el piso se pierden por reflejo, distancia o movimiento,
    # y el texto de la etiqueta sigue perfectamente legible.
    if not a_cart and not a_sku:
        geo, _ = _geometria_por_rotulos(img)
        if not geo:
            return campos
        xA, yA, W, H = geo
        campos = _por_bandas(img, campos, xA, yA, W, H)
        return _por_rotulos(img, campos)

    # Geometría. Con los dos códigos sale exacta. Con uno solo se usa la
    # proporción de la plantilla, que es constante (medida sobre las fotos de
    # referencia: la distancia entre códigos es 1.495x el ancho del de cartón,
    # y el de SKU mide 0.384x ese ancho). Esto importa: el código de abajo es
    # chico y se pierde en fotos de lejos, y sin este respaldo la etiqueta
    # entera se devolvía vacía aunque el texto fuera perfectamente legible.
    if a_cart and a_sku:
        yA = a_cart["top"] + a_cart["height"] / 2
        H = (a_sku["top"] + a_sku["height"] / 2) - yA
        xA, W = a_cart["left"], a_cart["width"]
    elif a_cart:
        yA = a_cart["top"] + a_cart["height"] / 2
        xA, W = a_cart["left"], a_cart["width"]
        H = W * _PROP_H_W
    elif a_sku:
        W = a_sku["width"] / _PROP_SKU_W
        H = W * _PROP_H_W
        yA = (a_sku["top"] + a_sku["height"] / 2) - H
        xA = a_sku["left"] + a_sku["width"] / 2 - W / 2
    else:
        return campos

    if H <= 0 or W <= 0:
        return campos

    campos = _por_bandas(img, campos, xA, yA, W, H)

    # Lo que la geometría no alcanzó a sacar, se reintenta por rótulos: son dos
    # caminos independientes y rara vez fallan en lo mismo.
    if any(not campos[c] for c, _ in _ORDEN):
        campos = _por_rotulos(img, campos)
    return campos
