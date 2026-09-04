"""Reverse engine: parse a customer PO PDF and build a Printavo QUOTE payload.

Mirror image of the forward sync (printavo_sync.py). A customer "Master Cut
Ticket / Purchase Order" PDF is parsed into one record per style (each page =
one style = one quote), then assembled into a Printavo `quoteCreate` input that
reproduces the SAME 11-section work-order template used by the existing invoices
(PRODUCTION DEPARTMENT, the garment, SAMPLES, FRONT PRINT, APPROVAL METHOD,
ALLOWED SHORTAGE, SPECIAL NOTES, PACKING DEPARTMENT, <BRAND> PO/PACK, NEW BOXES,
SPECIAL NOTES). Boilerplate text is copied verbatim from a real invoice (2103).

Currently supports the Goodie Two Sleeves format; add more retailers by writing
another _parse_<retailer> and registering it in detect_and_parse().
"""
import io
import re
from datetime import date
import pdfplumber

from routers.import_router import SIZES_MAP

# MOS size -> Printavo LineItemSize enum (reverse of the forward size mapping).
# Canónico MOS = 2X/3X/…; Printavo usa el enum size_2xl/size_3xl/…
MOS_TO_PRINTAVO_SIZE = {
    "YXS": "size_yxs", "YS": "size_ys", "YM": "size_ym", "YL": "size_yl", "YXL": "size_yxl",
    "XS": "size_xs", "S": "size_s", "M": "size_m", "L": "size_l", "XL": "size_xl",
    "2X": "size_2xl", "3X": "size_3xl", "4X": "size_4xl", "5X": "size_5xl",
    "2T": "size_2t", "3T": "size_3t", "4T": "size_4t", "5T": "size_5t",
}

# Boilerplate sections copied verbatim from invoice 2103 (static text).
PRODUCTION_DEPT = "PRODUCTION DEPARTMENT\n(DO NOT EDIT)"
PACKING_DEPT = "PACKING DEPARTMENT\n(DO NOT EDIT)"
NEW_BOXES = "NEW BOXES\nINCLUDE # ON QUANTITY COLUMN"
NEW_BOXES_PRICE = 2.50  # master invoice 2406 lo trae con 2.50 (antes 0.00 en SPENCERS)
ALLOWED_SHORTAGE_DEFAULT = "ALLOWED SHORTAGE:\n0%"
SAMPLES_DEFAULT = "SAMPLES\nN/A"
SPECIAL_NOTES_HEADER = "SPECIAL NOTES:"
# Notas del quote — texto FIJO en NEGRITA, copiado verbatim del master invoice
# #2406. Printavo guarda customerNote/productionNote como HTML; el <strong> es lo
# que en la revision se ve "en letra negrita" (ver instruccion de las capturas).
# El link de Google Sheets del packing list NO va aqui: Viviana lo pega por orden.
CUSTOMER_NOTE = "<div><strong>DIGITAL PACKING LIST.</strong></div>"
# Mensaje fijo de PRODUCTION NOTES — va SIEMPRE, tal cual el master invoice
# (respeta los dobles espacios y el "DEPARTAMENT" original). El equipo solo
# rellena los links debajo de ART LINK / SEPS al revisar.
PRODUCTION_NOTE = (
    "<div><strong>ART LINKS ONLY.  FOR ART  DEPARTAMENT ONLY.<br>"
    "NO ADDITIONAL NOTES. DON'T OVERCROWD WITH INFORMATION.<br><br>"
    "ART LINK:<br><br><br>SEPS:</strong></div>"
)
# Categoria de line item que Printavo debe dejar SIEMPRE en las lineas de
# impresion (ver captura "DEJAR ESTA OPCION SIEMPRE"). Se resuelve a su ID en
# printavo_client.find_category_id_by_name() porque LineItemCreateInput.category
# es un IDInput, no el nombre.
SCREEN_PRINTING_CATEGORY = "Screen Printing"
# APPROVAL METHOD estandarizado (master invoice 2406 usa este texto fijo en
# lugar del que trae el PDF — Viviana normaliza al armar el quote).
APPROVAL_METHOD_DEFAULT = "Please follow APPROVED SAMPLE and send picture for REFERENCE."
PACK_REFERENCES = (
    "INCLUDES REFERENCES TO:\nPrice Ticket\nHang Tag\nBag/No Bag\n"
    "Bag Size (if specified)\nFolding Type\nFolding Size (if specified)\n"
    "Box Type\nBox Size (if specified)"
)

# ── Culture Kings / Spektrum: boilerplate calcado al quote maestro #3182 ──────
# Texto verbatim del #3182. Los precios de estas líneas van en 0.0 (no vienen en
# el PO): Viviana los completa en la revisión, igual que en Goodie.
CK_FRONT_PRINT_DEFAULT = "FRONT PRINT\nNECK LABEL\nFINISHING"   # placeholder editable
CK_PRINTED_NECK_LABEL = "PRINTED NECK LABEL"                     # línea estándar (siempre)
CK_APPROVAL_DEFAULT = "APPROVAL METHOD:\nPHOTO FOR APPROVAL"
CK_SETUP_FEE = "SETUP FEE (Applies when order quantity is less than 1,500 pcs)"
CK_BULK_PACK = "BULK PACK\nRECYCLED BOXES / CAJA RECICLADA\nINCLUDE # ON QUANTITY COLUMN"
CK_TRANSPORT = "Transportation Charges - SHIPPING (40 dlls per pallet)"
CK_PACKING_SPECIAL_NOTES = (
    "SPECIAL NOTES:\n"
    "Para empaquetar estos pedidos utilizamos cajas recicladas, las mismas cajas "
    "en las que se enviaron originalmente las piezas en blanco.\n"
    "- Coloca la etiqueta de la caja en el lado más corto de la caja.\n"
    "- Coloque la etiqueta UPC junto a la etiqueta de la caja.\n"
    "- Cada caja contiene 50 unidades.\n"
    "- Para unidades parciales, puede combinar tamaños dentro del mismo estilo/gráfico "
    "para completar la cantidad de la caja."
)
# El setup fee del #3182 aplica cuando la cantidad es menor a este umbral.
CK_SETUP_FEE_THRESHOLD = 1500

# design color [colorfull] ln wh ref cloth  description...  qty price extn
_STYLE_RE = re.compile(
    r"^(?P<design>\S+)\s+(?P<color>\S+)(?:\s+\S+)?\s+(?P<ln>\d+)\s+(?P<wh>[A-Z]{2})\s+"
    r"(?P<ref>\S+)\s+(?P<cloth>\S+)\s+(?P<desc>.+?)\s+(?P<qty>[\d,]+)\s+(?P<price>[\d,.]+)\s+[\d,.]+\s*$"
)

_SIZE_TOKENS = set(SIZES_MAP.keys())
# Nickname brand per retailer (first CUST word -> brand). Matches existing invoices.
RETAILER_BRAND = {"SPENCER": "SPENCERS", "TRACTOR": "TRACTOR SUPPLY"}


def _sizes_from_pack_text(text: str):
    """Sizes from the clean PACK notes block, e.g. 'MD - 288'. Returns (sizes, total, pack_lines)."""
    sizes, total, pack_lines = {}, 0, []
    for sz, q in re.findall(r"([A-Z0-9]{1,4})\s*-\s*(\d+)", text):
        ms = SIZES_MAP.get(sz.upper())
        if ms:
            sizes[ms] = sizes.get(ms, 0) + int(q)
            total += int(q)
            pack_lines.append(f"{sz.upper()} - {q}")
    return sizes, total, pack_lines


def _color_from_position(page):
    """Extrae el color aislando el RECTANGULO de la columna COLOR con page.crop() y
    extrayendo texto SOLO de esa region. Robusto contra:
      - pdfplumber juntando descripcion con color en 'WHOLE MILKWHITE'
      - la palabra 'SA' de la columna WH que se pegaba por tolerancia X
      - colores multi-palabra donde 'LIGHT' y 'PINK' pueden estar desalineados
        y no matchear al mismo top_max con extract_words().

    Approach:
      1) localizar el header 'COLOR' -> x0, top.
      2) localizar el siguiente header ('Ln'/'WH'/...) para el borde derecho.
      3) localizar 'Category' -> borde inferior.
      4) page.crop(color_x0, color_top+altura_del_header, next_x0, category_top).
      5) extract_text() del crop → varias lineas, la ULTIMA es el nombre completo
         (ej: crop devuelve 'LPK\\nLIGHT PINK' -> tomamos 'LIGHT PINK').
    """
    try:
        words = page.extract_words()
    except Exception:
        return None
    color_hdr = next((w for w in words if w["text"].strip().upper() == "COLOR"), None)
    cat = next((w for w in words if w["text"].strip() == "Category"), None)
    if not color_hdr or not cat:
        return None
    # El nombre COMPLETO del color ('LIGHT PINK') vive en la misma FILA que la
    # palabra 'Category', a su IZQUIERDA (misma linea: 'LIGHT PINK   Category :').
    # La fila de ARRIBA (fila del estilo) trae solo la abreviacion ('LPK LPK').
    # Estrategia robusta: recolectar palabras-letra en la columna COLOR entre el
    # header y la fila de Category (inclusive), agrupar por fila (top) y devolver
    # la fila mas cercana a Category (el nombre completo, no la abreviacion).
    #
    # x0: NO usar color_hdr.x0 (el header 'COLOR' esta corrido a la derecha del
    # inicio real del texto del color, truncaba 'BLACK'->'ACK'). Usar el borde
    # derecho del header 'STYLE' — el color siempre empieza despues de esa columna.
    style_hdr = next((w for w in words if w["text"].strip().upper() == "STYLE"), None)
    NEXT_HDRS = {"Ln", "WH", "REF", "CLOTH", "DESCRIPTION", "QTY", "PRICE"}
    next_hdr = None
    for w in words:
        if abs(w["top"] - color_hdr["top"]) > 3:
            continue
        if w["x0"] <= color_hdr["x1"]:
            continue
        if w["text"].strip() not in NEXT_HDRS:
            continue
        if next_hdr is None or w["x0"] < next_hdr["x0"]:
            next_hdr = w
    x0 = (style_hdr["x1"] + 2) if style_hdr else (color_hdr["x0"] - 30)
    x1 = (next_hdr["x0"] - 2) if next_hdr else (color_hdr["x1"] + 45)
    top = color_hdr["bottom"] + 1
    bottom = cat["bottom"] + 2
    if x1 <= x0 or bottom <= top:
        return None
    # Palabras-letra dentro del rectangulo de la columna COLOR. `VVL0009M1000`
    # (columna STYLE, si se colara) queda excluido por tener digitos.
    cand = []
    for w in words:
        cx = (w["x0"] + w["x1"]) / 2
        if not (x0 <= cx < x1):
            continue
        if not (top <= w["top"] <= bottom):
            continue
        if not re.match(r"^[A-Z]+$", w["text"]):
            continue
        cand.append(w)
    if not cand:
        return None
    # Agrupar por fila (top) y quedarse con la fila mas abajo = nombre completo.
    top_max = max(c["top"] for c in cand)
    row = [c for c in cand if abs(c["top"] - top_max) < 3]
    row.sort(key=lambda w: w["x0"])
    return " ".join(w["text"] for w in row).strip() or None


def _pack_raw_from_text(text: str) -> str:
    """Extract the PACK block VERBATIM from the PO PDF text so the Printavo quote
    preserves the original formatting (e.g. 'MD- 60', 'LG-60', 'XL-60' con espaciados
    inconsistentes tal como salen del PDF). Sin esta captura, `pack_lines` normaliza
    a 'MD - 60' y el master invoice deja de coincidir. Devuelve solo las lineas de
    talla (una por linea), no el 'PACK' header."""
    m = re.search(r"\bPACK\b\s*\n(.+?)(?=\n\s*TOPS NEEDED\b|\n\s*\*\*|\n\s*INCLUDES REFERENCES\b|\Z)",
                  text, re.S)
    if not m:
        return ""
    raw = m.group(1).strip("\n")
    # Filtrar solo lineas con formato de talla ("SM - 60", "MD- 60", "XXL 96", etc.)
    out = []
    for ln in raw.split("\n"):
        s = ln.strip()
        if not s:
            continue
        if re.match(r"^[A-Z0-9]{1,4}\s*[-]?\s*\d+\s*$", s):
            out.append(s)
    return "\n".join(out)


def _extract_sizes_by_position(page):
    """Align the SIZE/QTY table columns by x-position. Used for POs (e.g. Tractor
    Supply) that lack a PACK text block — the table's text extraction is misaligned,
    but each QTY value sits directly under its SIZE label. Returns (sizes, total, pack_lines)."""
    labels, nums = [], []
    for w in page.extract_words():
        t = w["text"].strip().upper()
        cx = (w["x0"] + w["x1"]) / 2
        if t in _SIZE_TOKENS:
            labels.append((cx, w["top"], t))
        elif t.isdigit() and len(t) <= 5:      # excludes 12-digit UPCs
            nums.append((cx, w["top"], int(t)))
    sizes, total, pack_lines = {}, 0, []
    for cx, top, token in labels:
        best, best_d = None, 1e9
        for ncx, ntop, val in nums:            # the qty word directly below this label
            if 0 < (ntop - top) < 22 and abs(ncx - cx) < 18:
                d = (ntop - top) + abs(ncx - cx)
                if d < best_d:
                    best_d, best = d, val
        if best is not None:
            ms = SIZES_MAP.get(token)
            if ms:
                sizes[ms] = sizes.get(ms, 0) + best
                total += best
                pack_lines.append(f"{token} - {best}")
    return sizes, total, pack_lines


def _parse_goodie_page(page):
    """Parse one page of a Goodie Two Sleeves Master Cut Ticket. Returns None if
    the page has no style line (e.g. a summary page)."""
    text = page.extract_text() or ""
    lines = text.split("\n")
    m = next((_STYLE_RE.match(l) for l in lines if _STYLE_RE.match(l)), None)
    if not m:
        return None

    # The garment name can wrap: extra words sit on the line(s) between the style
    # line and the "<color> Category" line (e.g. "...BACK IN THE\nSADDLE\nWHITE Category").
    desc = m.group("desc").strip()
    si = next((i for i, l in enumerate(lines) if _STYLE_RE.match(l)), -1)
    for l in (lines[si + 1:] if si >= 0 else []):
        if not l.strip() or "Category" in l:
            break
        desc += " " + l.strip()

    po = re.search(r"^\d+\s+\d+\s+(\d+)$", text, re.M)                    # 4 26 21505 -> 21505
    # CUST PO = first token of the value row under the "CUST PO ... SHIP MODE" header
    # (numeric for Spencers like "322586", alphanumeric for Tractor like "PWA").
    store = re.search(r"CUST PO.*?SHIP MODE\s*\n\s*(\S+)", text, re.S)
    store_notes = re.search(r"\b([A-Z]+)\s+PO\s+(\d+)\b", text)           # "SPENCER PO 322586" (notes)
    # CUST can run into "ISSUE DATE" with no space ("...COMPANISSUE DATE").
    cust = re.search(r"CUST\s+(.+?)\s*ISSUE ?DATE\s+([\dA-Z\-]+)", text)
    ship = re.search(r"\bSHIP\s+(\d{1,2}-[A-Z]{3}-\d{2})", text)
    cancel = re.search(r"CANCEL\s+(\d{1,2}-[A-Z]{3}-\d{2})", text)
    # Color: preferimos POSICION (x-column) via _color_from_position porque
    # pdfplumber junta la ultima linea de la DESCRIPTION con la del COLOR cuando
    # estan cercanas en Y (bug reportado 2026-07-13: 'WHOLE MILKWHITE',
    # 'STRAWBERRY MILKLIGHT PINK', 'EVERYTHING HURTSBLACK'). El regex sobre
    # texto plano queda como fallback para PDFs donde extract_words no funciona.
    color_from_pos = _color_from_position(page)
    colorln = re.search(
        r"^([A-Z]+(?:\s+[A-Z]+)*?)(?:\s+|\s*\n\s*)Category\b",
        text, re.M
    )
    status = re.search(r"\n(ORIGINAL|REORDER|NEW|ROLLOUT[ /A-Z]*)\n", text)

    # Front print / division / approval / blanks come from the "** **" note blocks.
    # Each note is a single line; stop at the next line to avoid swallowing the
    # PACK block or the page footer.
    # Division can be inline ("**DIVISION: JUNIORS**") or on the next line ("**DIVISION: **\nMEN SS").
    div_inline = re.search(r"\*\*DIVISION:\s*([^\n*]+?)\s*\*\*", text)
    div_next = re.search(r"\*\*DIVISION:\s*\*\*\s*\n([^\n]+)", text)
    division = (div_inline.group(1).strip() if div_inline else "") \
        or (div_next.group(1).strip() if div_next else "")
    approval = re.search(r"\*\*APPROVAL METHOD:\s*\*\*\s*\n([^\n]+)", text)
    blanks = re.search(r"\*\*BLANKS & TRIM\s*\*\*\s*\n([^\n]+)", text)
    # print/finishing lines sit between the "$.90" cost line and the first "** **".
    fp = re.search(r"BREAKDOWN COSTS INCLUDE[^\n]*\n(.+?)(?=\n\*\*)", text, re.S)
    # Tractor-specific note blocks.
    b2u = re.search(r"\*\*BLANKS TO BE USE FOR THIS STYLE:\s*([^\n*]+?)\s*\*\*", text)
    rs = re.search(r"(SIZED:\s*RE-SIZE.*?)(?=\nNote :|\Z)", text, re.S)
    photo_approval = bool(re.search(r"\*\*PHOTO APPROVAL\*\*", text))

    qty_declared = int(m.group("qty").replace(",", ""))

    # Sizes: prefer the clean PACK notes block (preserves the exact Spencers format);
    # fall back to x-position column alignment for POs without a PACK block (Tractor).
    sizes, total, pack_lines = _sizes_from_pack_text(text)
    if not sizes or total != qty_declared:
        sizes, total, pack_lines = _extract_sizes_by_position(page)
    # Bloque PACK LITERAL del PDF — para reproducir el formato del master invoice
    # (que copia el pack tal cual, con sus 'MD- 60' 'LG-60' inconsistentes).
    pack_raw = _pack_raw_from_text(text)

    # Branding for the nickname: retailer's first word, mapped (SPENCER -> SPENCERS).
    retailer = cust.group(1).strip() if cust else ""
    first_word = retailer.split()[0] if retailer else "SPENCER"
    brand = RETAILER_BRAND.get(first_word, first_word)
    # Packing-line prefix ("SPENCER PO 322586"): from the notes if present, else brand.
    brand_prefix = store_notes.group(1) if store_notes else first_word
    return {
        "po_number": po.group(1) if po else None,
        "store_po": store.group(1) if store else (store_notes.group(2) if store_notes else None),
        "store_po_notes": store_notes.group(2) if store_notes else None,
        "brand": brand,                # nickname brand (e.g. SPENCERS / TRACTOR SUPPLY)
        "brand_prefix": brand_prefix,  # packing-line prefix (e.g. SPENCER)
        "retailer": retailer or None,
        "issue_date": cust.group(2) if cust else None,
        "ship_date": ship.group(1) if ship else None,
        "cancel_date": cancel.group(1) if cancel else None,
        "design_num": m.group("design"),
        "blank": m.group("cloth"),
        "color": color_from_pos or (colorln.group(1) if colorln else m.group("color")),
        "description": desc,
        "status": (status.group(1).strip() if status else "ORIGINAL"),
        "division": division,
        "front_print": (fp.group(1).strip() if fp else ""),
        "approval_method": (approval.group(1).strip() if approval else ""),
        "blanks_trim": (blanks.group(1).strip() if blanks else ""),
        "blanks_to_use": (b2u.group(1).strip() if b2u else ""),   # e.g. GI5000-WHITE
        "resize": (rs.group(1).strip() if rs else ""),            # SIZED: RE-SIZE ... block
        "photo_approval": photo_approval,
        "qty": qty_declared,
        "unit_price": float(m.group("price").replace(",", "")) if m.group("price") else 0.0,
        "sizes": sizes,
        "pack_lines": pack_lines,
        "qty_from_sizes": total,
        "sizes_match": qty_declared == total,
        "po_discrepancy": bool(store and store_notes and store.group(1) != store_notes.group(2)),
        "pack_raw": pack_raw,  # bloque PACK verbatim del PDF (para preservar en el packing block del quote)
    }


def parse_pdf(pdf_bytes: bytes) -> list:
    """Parse a customer PO PDF into one record per style (each = one quote)."""
    out = []
    with pdfplumber.open(io.BytesIO(pdf_bytes)) as pdf:
        for page in pdf.pages:
            rec = _parse_goodie_page(page)
            if rec:
                out.append(rec)
    return out


def _iso(d):
    """'18-JUN-26' or '5/8/2026' -> 'YYYY-MM-DD' (best effort)."""
    if not d:
        return None
    d = d.strip()
    # Ya-ISO 'YYYY-MM-DD' (el PO de Culture Kings trae la fecha así en 'Due Date').
    # Sin este passthrough _iso devolvía None y la quote quedaba sin due date.
    m_iso = re.match(r"(\d{4})-(\d{2})-(\d{2})\b", d)
    if m_iso:
        return f"{m_iso.group(1)}-{m_iso.group(2)}-{m_iso.group(3)}"
    m2 = re.match(r"(\d{1,2})/(\d{1,2})/(\d{2,4})", d)   # M/D/YYYY (Culture Kings)
    if m2:
        y = m2.group(3)
        y = ("20" + y) if len(y) == 2 else y
        return f"{y}-{int(m2.group(1)):02d}-{int(m2.group(2)):02d}"
    months = {"JAN": "01", "FEB": "02", "MAR": "03", "APR": "04", "MAY": "05", "JUN": "06",
              "JUL": "07", "AUG": "08", "SEP": "09", "OCT": "10", "NOV": "11", "DEC": "12"}
    m = re.match(r"(\d{1,2})-([A-Z]{3})-(\d{2})", d)
    if not m:
        return None
    return f"20{m.group(3)}-{months.get(m.group(2), '01')}-{int(m.group(1)):02d}"


# ── Spektrum / Culture Kings: mapeo del record ───────────────────────────────
# El PO de Culture Kings se lee determinista de la capa de texto
# (_parse_culturekings_text más abajo). _spektrum_record recibe ese dict —
# mismas llaves que se documentan ahí — y arma el record que consume
# build_quote_input.
def _spektrum_record(data: dict) -> dict:
    sizes, pack_lines, total = {}, [], 0
    for sz, q in (data.get("sizes") or {}).items():
        ms = SIZES_MAP.get(str(sz).upper())
        try:
            q = int(q)
        except (TypeError, ValueError):
            q = 0
        if ms and q:
            sizes[ms] = sizes.get(ms, 0) + q
            total += q
            pack_lines.append(f"{str(sz).upper()} - {q}")
    units = data.get("units") or total
    return {
        "brand": (data.get("retailer") or "CULTURE KINGS").upper(),
        "retailer": data.get("retailer"),
        "po_number": data.get("po_number"),
        "store_po": data.get("po_number"),
        "store_po_notes": None,
        "brand_prefix": (data.get("retailer") or "CULTURE KINGS").upper(),
        "design_num": data.get("po_number"),
        "description": (data.get("name") or "").strip(),
        "color": (data.get("color") or "").strip(),
        "blank": (data.get("blank") or "").strip(),
        "division": "", "status": "", "front_print": "", "approval_method": "",
        "blanks_trim": "", "blanks_to_use": "", "resize": "", "photo_approval": False,
        "range_name": data.get("range_name"),
        "sizes": sizes, "pack_lines": pack_lines,
        "qty": units, "qty_from_sizes": total, "unit_price": 0.0,
        "cancel_date": data.get("due_date"), "ship_date": data.get("due_date"), "issue_date": None,
        "sizes_match": units == total, "po_discrepancy": False,
        # Molde #3182: pasos de empaque, un line item c/u.
        "packing_instructions": data.get("packing_instructions") or [],
    }


# ── Culture Kings / Spektrum: lectura DETERMINISTA de la capa de texto ────────
# El PO de Culture Kings viene como un formulario con capa de texto (campos
# etiquetados 'Name:', 'Color:', 'Blank:', 'Units:', 'RANGE NAME:', 'PO #:', y
# una línea de tallas 'XS: 5, S: 35, ... Total: N'). No hace falta visión: se
# parsea igual que el motor de Goodie (parse_pdf) y se arma el MISMO record que
# devuelve _spektrum_record, así build_quote_input no cambia.
# Etiquetas ancladas a inicio de línea: 'Name:' NO debe matchear dentro de
# 'RANGE NAME:', por eso ^ (re.M) en vez de \b.
_CK_LABEL_RES = {
    "range_name": re.compile(r"^\s*RANGE NAME:\s*(.+)", re.I | re.M),
    "name":       re.compile(r"^\s*Name:\s*(.+)", re.I | re.M),
    "color":      re.compile(r"^\s*Color:\s*(.+)", re.I | re.M),
    "blank":      re.compile(r"^\s*Blank:\s*(.+)", re.I | re.M),
}
_CK_UNITS_RE = re.compile(r"^\s*Units:\s*(\d+)", re.I | re.M)
_CK_DUE_RE = re.compile(r"Due Date\s+(\d{4}-\d{2}-\d{2})", re.I)
# El número de PO cae en la línea ANTERIOR a la etiqueta ('4004681\nPO #:'); se
# intenta primero número-antes-de-etiqueta y luego el orden natural.
_CK_PO_BEFORE_RE = re.compile(r"(\d{4,})\s*\n\s*PO\s*#\s*:", re.I)
_CK_PO_AFTER_RE = re.compile(r"PO\s*#\s*:\s*(\d+)", re.I)
# Tallas 'TOK: n'. El \b inicial impide partir 'Total' en 'otal' (el {1,4} sin
# ancla capturaba los últimos 4 chars de una palabra larga).
_CK_SIZE_LINE_RE = re.compile(r"\b([A-Za-z0-9]{1,4})\s*:\s*(\d+)")


def _ck_first(rx, text):
    m = rx.search(text)
    return m.group(1).strip() if m else ""


def _parse_culturekings_text(text: str) -> dict:
    """Parse one Culture Kings/Spektrum PO page's text into the SAME dict shape
    that extract_spektrum's vision returns (retailer/range_name/po_number/name/
    color/blank/units/due_date/sizes), or None if the page isn't a CK PO."""
    if not text:
        return None
    name = _ck_first(_CK_LABEL_RES["name"], text)
    # Línea de tallas: la que trae varios 'TOK: n' (la del desglose), no la de un
    # solo campo. Se toma la primera línea con 2+ pares.
    sizes = {}
    for ln in text.splitlines():
        pairs = _CK_SIZE_LINE_RE.findall(ln)
        pairs = [(t, n) for t, n in pairs if t.upper() != "TOTAL"]
        if len(pairs) >= 2:
            for tok, n in pairs:
                sizes[tok.upper()] = sizes.get(tok.upper(), 0) + int(n)
            break
    # Firma de un PO de Culture Kings: nombre + desglose de tallas presentes.
    if not name or not sizes:
        return None

    po = ""
    mb = _CK_PO_BEFORE_RE.search(text)
    if mb:
        po = mb.group(1)
    else:
        ma = _CK_PO_AFTER_RE.search(text)
        po = ma.group(1) if ma else ""

    up = text.upper()
    retailer = "CULTURE KINGS" if "CULTURE KINGS" in up else ("SPEKTRUM" if "SPEKTRUM" in up else "")
    units = _ck_first(_CK_UNITS_RE, text)
    return {
        "retailer": retailer or None,
        "range_name": _ck_first(_CK_LABEL_RES["range_name"], text) or None,
        "po_number": po or None,
        "name": name,
        "color": _ck_first(_CK_LABEL_RES["color"], text) or None,
        "blank": _ck_first(_CK_LABEL_RES["blank"], text) or None,
        "units": int(units) if units else None,
        "due_date": _ck_first(_CK_DUE_RE, text) or None,
        "sizes": sizes,
        # Pasos de empaque: el molde #3182 los baja del PO (un line item c/u).
        "packing_instructions": _ck_packing_instructions(text),
    }


# PACKAGING INSTRUCTIONS: bloque de pasos numerados ('1)... 2)...'); en el quote
# #3182 cada paso es su propio line item en el PACKING DEPARTMENT.
_CK_PACK_INSTR_RE = re.compile(
    r"PACKAGING INSTRUCTIONS\s*(.+?)(?=\n\s*AGREGAR\b|\n\s*Name:|\Z)", re.I | re.S)


def _ck_packing_instructions(text: str) -> list:
    """Lista de pasos de empaque del PO (uno por número), desenvolviendo los
    saltos de línea con los que el PDF parte cada oración."""
    m = _CK_PACK_INSTR_RE.search(text or "")
    if not m:
        return []
    block = re.sub(r"\s+", " ", m.group(1)).strip()
    parts = re.split(r"(?=\b\d+\s*\))", block)
    return [p.strip() for p in parts if p.strip()]


def parse_culturekings_pdf(pdf_bytes: bytes) -> list:
    """Parse a Culture Kings/Spektrum PO PDF (text layer) into one record per
    page/style, mirroring parse_pdf for the Goodie formats. Deterministic — no AI."""
    out = []
    with pdfplumber.open(io.BytesIO(pdf_bytes)) as pdf:
        for page in pdf.pages:
            data = _parse_culturekings_text(page.extract_text() or "")
            if data and data.get("po_number"):
                out.append(_spektrum_record(data))
    return out


def _garment_description(r):
    """Rebuild the multi-line garment description (matches the invoice template).

    El STATUS (3ra linea) va VACIO: el PDF trae 'ORIGINAL' (Cut/Make) pero el
    invoice real lo lleva a 'ROLLOUT'/'REORDER'/etc. que Viviana decide al armar
    el quote. Dejamos la linea en blanco como placeholder para que la complete
    en la revision editable, en vez de asumir un valor incorrecto."""
    # Lista fija de 5 lineas: la 3ra (status) queda "" a proposito.
    parts = [r["description"] or "", r["design_num"] or "", "", r["blank"] or "", r["division"] or ""]
    body = "\n".join(parts)
    return f"{body}\n\n" + "\n".join(r["pack_lines"])


def _addr_input(addr: dict, company: str, person: str) -> dict:
    """Map a Printavo Address (read) -> CustomerAddressInput (write)."""
    out = {"companyName": company, "customerName": person,
           "address1": addr.get("address1"), "address2": addr.get("address2"),
           "city": addr.get("city"), "stateIso": addr.get("stateIso"),
           "zipCode": addr.get("zipCode"), "countryIso": addr.get("countryIso") or "US"}
    return {k: v for k, v in out.items() if v}


def _li(desc, color=None, sizes=None, price=0.0, category_id=None):
    """One line item; every item carries an explicit price (0.0 for text sections).
    `category_id` (opcional) fija la categoria del line item (p.ej. Screen
    Printing). Printavo espera un IDInput, por eso va como {'id': ...}."""
    item = {"description": desc, "price": price}
    if color:
        item["color"] = color
    if sizes:
        item["sizes"] = sizes
    if category_id:
        item["category"] = {"id": category_id}
    return item


def _status_disp(r):
    s = r["status"] or ""
    return "n/a" if s.upper() == "ORIGINAL" else s


def _spencers_groups(r, sizes_input, category_id=None):
    """2-group SPENCERS template. Alineado con el master invoice #2406
    (SPENCERS PO#21767 - 323354 - THT0109M1000 - ROLLOUT):
      - Packing usa el PACK verbatim del PDF (pack_raw), no el reformateado.
      - Separadores: 1 salto entre PACK y tallas, 4 saltos antes de INCLUDES.
      - APPROVAL METHOD es texto estandarizado (Viviana lo normaliza asi).
      - SPECIAL NOTES G1 sin blanks_trim (no aparece en el master).
      - NEW BOXES price = 2.50."""
    pack_txt = r.get("pack_raw") or "\n".join(r["pack_lines"])
    packing_desc = (
        f"{r['brand_prefix']} PO {r['store_po']}\nPACK\n{pack_txt}"
        f"\n\n\n\n{PACK_REFERENCES}"
    )
    front = r["front_print"] if (r["front_print"] and "FRONT PRINT" in r["front_print"]) \
        else ("FRONT PRINT\n" + r["front_print"] if r["front_print"] else "FRONT PRINT\nNECK LABEL\nFINISHING")
    g1 = [
        _li(PRODUCTION_DEPT),
        _li(_garment_description(r), color=r["color"], sizes=sizes_input, price=r["unit_price"]),
        # Bloque de muestras: el detalle (1 MD, 1 LG, ECOM SAMPLE, M-1...) NO
        # esta en el PDF; Viviana lo completa. Dejamos solo el header editable.
        # TOPS NEEDED y FRONT PRINT llevan categoria Screen Printing (master #2406).
        _li("TOPS NEEDED:", category_id=category_id),
        _li(front, category_id=category_id),
        _li("APPROVAL METHOD:\n" + APPROVAL_METHOD_DEFAULT),
        _li(ALLOWED_SHORTAGE_DEFAULT),
        _li(SPECIAL_NOTES_HEADER),
    ]
    g2 = [_li(PACKING_DEPT), _li(packing_desc), _li(NEW_BOXES, price=NEW_BOXES_PRICE), _li(SPECIAL_NOTES_HEADER)]
    return [g1, g2]


def _tractor_groups(r, sizes_input, category_id=None):
    """3-group TRACTOR SUPPLY template (matches corrected quote #2127):
      G1 production (garment + notes; the re-size block lives in SPECIAL NOTES),
      G2 the PACKING DEPARTMENT header alone,
      G3 the packing references + NEW BOXES + SPECIAL NOTES.
    There is NO warehouse/blank-pull group and ALLOWED SHORTAGE is 0%."""
    size_lines = "\n".join(r["pack_lines"])
    front = r["front_print"] or "FRONT PRINT\nNECK LABEL\nFINISHING\nPICK & PACK"
    garment = "\n".join(p for p in [r["description"], r["design_num"], _status_disp(r),
                                    r["division"], size_lines] if p)
    approval = r["approval_method"] or ("PHOTO APPROVAL" if r["photo_approval"] else _status_disp(r))
    # The re-size instructions (SIZED: RE-SIZE ...) belong to SPECIAL NOTES in G1,
    # separated by a blank line (matches quote #2127).
    special_notes = SPECIAL_NOTES_HEADER + ("\n\n" + r["resize"] if r["resize"] else "")

    g1 = [
        _li(PRODUCTION_DEPT),
        _li(garment, color=r["color"], sizes=sizes_input, price=r["unit_price"]),
        _li("N/A"),
        _li(front, category_id=category_id),
        _li("APPROVAL METHOD:\n" + approval),
        _li("ALLOWED SHORTAGE:\n0%"),
        _li(special_notes),
    ]
    g2 = [_li(PACKING_DEPT)]
    g3 = [
        _li("\n" + PACK_REFERENCES),   # leading blank line, matches quote #2127
        _li(NEW_BOXES, price=2.50),
        _li(SPECIAL_NOTES_HEADER),
    ]
    return [g1, g2, g3]


def _spektrum_groups(r, sizes_input, category_id=None):
    """Plantilla CULTURE KINGS / SPEKTRUM calcada al quote maestro #3182.

    El motor RELLENA del PO: la prenda (color/tallas/nombre/blank), los pasos de
    PACKAGING INSTRUCTIONS (un line item por paso) y la etiqueta de cuello si el
    PO la pide. Todo lo demás es boilerplate verbatim del #3182. Los PRECIOS van
    en 0.0 a propósito — no vienen en el PO; Viviana los completa en la revisión,
    igual que en Goodie. El garment lleva el desglose de tallas como texto con
    formato ':' ('XS: 5') para reproducir el #3182."""
    # Desglose de tallas como texto (formato ':' del #3182), preservando la
    # etiqueta original del PO ('2XL', no '2X').
    size_lines = "\n".join(pl.replace(" - ", ": ") for pl in r["pack_lines"])
    garment = "\n".join(p for p in [r["description"], r["blank"]] if p)
    if size_lines:
        garment += "\n" + size_lines

    g1 = [
        _li(PRODUCTION_DEPT),
        # La prenda NO lleva categoría (en el #3182 el garment va sin Screen Printing).
        _li(garment, color=r["color"], sizes=sizes_input, price=r["unit_price"]),
        _li(SAMPLES_DEFAULT),
        _li(CK_FRONT_PRINT_DEFAULT, category_id=category_id),
        # PRINTED NECK LABEL va SIEMPRE en Culture Kings (decisión de negocio
        # 2026-09): es una línea estándar del quote, no depende del PO.
        _li(CK_PRINTED_NECK_LABEL, category_id=category_id),
    ]
    g1.append(_li(CK_APPROVAL_DEFAULT))
    g1.append(_li(ALLOWED_SHORTAGE_DEFAULT))
    try:
        units = int(r.get("qty") or 0)
    except (TypeError, ValueError):
        units = 0
    if 0 < units < CK_SETUP_FEE_THRESHOLD:
        g1.append(_li(CK_SETUP_FEE))

    g2 = [_li(PACKING_DEPT)]
    # Un line item por paso de empaque del PO (el #3182 los trae así, 1/1/1).
    for step in (r.get("packing_instructions") or []):
        g2.append(_li(step))
    g2.append(_li(CK_BULK_PACK))
    g2.append(_li(CK_TRANSPORT))
    g2.append(_li(CK_PACKING_SPECIAL_NOTES))
    return [g1, g2]


def build_quote_input(r: dict, contact_id: str, contact: dict = None, owner_id: str = None,
                      category_id: str = None, invoice_date: str = None) -> dict:
    """Assemble a Printavo QuoteCreateInput. Picks the SPENCERS (2-group) or
    TRACTOR SUPPLY (3-group) template by brand. `contact` supplies the customer's
    billing/shipping addresses, which Printavo does not auto-copy from the contact.
    `category_id` fija la categoria Screen Printing en las lineas de impresion;
    `invoice_date` (ISO YYYY-MM-DD) fija el Invoice Date — por defecto HOY, igual
    a la fecha de creacion (ver instruccion de las capturas)."""
    sizes_input = [
        {"size": MOS_TO_PRINTAVO_SIZE[k], "count": v}
        for k, v in r["sizes"].items() if k in MOS_TO_PRINTAVO_SIZE
    ]
    brand_up = (r.get("brand") or "").upper()
    is_tractor = "TRACTOR" in brand_up
    is_spektrum = "CULTURE KING" in brand_up or "SPEKTRUM" in brand_up
    if is_tractor:
        groups = _tractor_groups(r, sizes_input, category_id)
    elif is_spektrum:
        groups = _spektrum_groups(r, sizes_input, category_id)
    else:
        groups = _spencers_groups(r, sizes_input, category_id)
    for grp in groups:
        for idx, item in enumerate(grp):
            item["position"] = idx

    status = r["status"] or ""
    brand = r.get("brand") or "SPENCERS"
    if is_tractor:
        # Matches the corrected quote #2127 header: "TRACTOR SUPPLY PO#21649 - AER0154J1358 - N/A"
        nickname = f"{brand} PO#{r['po_number']} - {r['design_num']} - {r['store_po'] or 'N/A'}"
    elif is_spektrum:
        # Calcado al #3182: "CULTURE KINGS - PO#4004615 - DOOM VERSUS AVENGERS TEE - NEW".
        # El status ('NEW'/'REORDER') lo agrega Viviana en la revisión (el PO no lo trae).
        nickname = f"{brand} - PO#{r['po_number']} - {r['description']}"
    else:
        # Nickname alineado con master invoice #2406: "PO#21767" (sin espacio).
        nickname = f"{brand} PO#{r['po_number']} - {r['store_po']} - {r['design_num']}"
    # SPENCERS: el status ('ROLLOUT'/'REORDER') lo agrega Viviana al nickname en la
    # revision (el PDF trae 'ORIGINAL' que no corresponde). No lo anexamos aqui.
    # TRACTOR / SPEKTRUM conservan su comportamiento previo (status del PDF).
    if (is_tractor or is_spektrum) and status and status.upper() != "ORIGINAL":
        nickname += f" - {status}"

    due_date = _iso(r["cancel_date"]) or _iso(r["ship_date"])
    quote = {
        "contact": {"id": contact_id},
        "customerDueAt": due_date,
        "dueAt": (due_date + "T00:00:00Z") if due_date else None,
        # Invoice Date = fecha de creacion (hoy). Master #2406: invoiceAt == createdAt.
        "invoiceAt": invoice_date or date.today().isoformat(),
        "nickname": nickname,
        "visualPoNumber": r["po_number"],
        "customerNote": CUSTOMER_NOTE,
        "productionNote": PRODUCTION_NOTE,
        "lineItemGroups": [{"position": i, "lineItems": g} for i, g in enumerate(groups)],
    }
    if owner_id:
        quote["owner"] = {"id": owner_id}

    cust = (contact or {}).get("customer") or {}
    company = cust.get("companyName") or ""
    person = (contact or {}).get("fullName") or ""
    if cust.get("billingAddress"):
        quote["billingAddress"] = _addr_input(cust["billingAddress"], company, person)
    if cust.get("shippingAddress"):
        quote["shippingAddress"] = _addr_input(cust["shippingAddress"], company, person)
    return quote
