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
import os
import json
import re
import pdfplumber

from routers.import_router import SIZES_MAP

# MOS size -> Printavo LineItemSize enum (reverse of the forward size mapping).
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
CUSTOMER_NOTE = "DIGITAL PACKING LIST."
# APPROVAL METHOD estandarizado (master invoice 2406 usa este texto fijo en
# lugar del que trae el PDF — Viviana normaliza al armar el quote).
APPROVAL_METHOD_DEFAULT = "Please follow APPROVED SAMPLE and send picture for REFERENCE."
PACK_REFERENCES = (
    "INCLUDES REFERENCES TO:\nPrice Ticket\nHang Tag\nBag/No Bag\n"
    "Bag Size (if specified)\nFolding Type\nFolding Size (if specified)\n"
    "Box Type\nBox Size (if specified)"
)

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
    # Color multi-palabra: 'LIGHT PINK', 'SPORT GREY', 'HOT PINK', etc.
    # Antes: r"^([A-Z]+)\s+Category" solo tomaba UNA palabra ("LIGHT" no matchea
    # con " PINK Category" atras), asi que el fallback cae a la abreviacion de
    # la tabla ("LPK", "SG"). Ahora acepta 1..N palabras alfabeticas separadas
    # por espacios simples.
    colorln = re.search(r"^([A-Z]+(?:\s+[A-Z]+)*)\s+Category", text, re.M)
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
        "color": colorln.group(1) if colorln else m.group("color"),
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


# ── Spektrum / Culture Kings: image-based PO read with Claude vision ──────────
_VISION_PROMPT = """You are reading a Culture Kings / Spektrum apparel "cut ticket" purchase order (mostly images).
Return ONLY valid JSON (no markdown fences) with exactly these keys:
{"retailer": string, "range_name": string, "po_number": string, "name": string,
 "color": string, "blank": string, "units": integer, "due_date": string,
 "sizes": {"<SIZE>": integer}}
Sizes labels are like XS, S, M, L, XL, 2XL, 3XL. Use the sizes summary line. Null for missing fields."""


async def _gemini_key() -> str:
    from deps import db
    from cryptography.fernet import Fernet
    config = await db.insights_config.find_one({"config_id": "main"}, {"_id": 0})
    if not config or not config.get("encrypted_gemini_key"):
        raise RuntimeError("Gemini API key no configurada (modulo Insights).")
    enc = os.environ.get("MOS_ENCRYPTION_KEY")
    return Fernet(enc.encode()).decrypt(config["encrypted_gemini_key"].encode()).decode()


def _json_from_text(txt: str):
    t = (txt or "").strip()
    if t.startswith("```"):
        t = re.sub(r"^```[a-zA-Z]*\n?", "", t).rstrip("`").strip()
    try:
        return json.loads(t)
    except Exception:
        m = re.search(r"\{.*\}", t, re.S)
        return json.loads(m.group(0)) if m else None


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
    }


async def extract_spektrum(pdf_bytes: bytes) -> list:
    """Extract an image-based Culture Kings/Spektrum PO via Claude vision (one page = one style)."""
    import base64
    from claude_client import get_client, json_from_text, text_of, VISION_MODEL
    client = await get_client()
    # Render each page to PNG bytes for Claude's image input.
    pngs = []
    with pdfplumber.open(io.BytesIO(pdf_bytes)) as pdf:
        for p in pdf.pages:
            buf = io.BytesIO()
            p.to_image(resolution=150).original.save(buf, format="PNG")
            pngs.append(buf.getvalue())
    records = []
    for png in pngs:
        b64 = base64.standard_b64encode(png).decode("utf-8")
        msg = await client.messages.create(
            model=VISION_MODEL, max_tokens=1024,
            messages=[{"role": "user", "content": [
                {"type": "image", "source": {"type": "base64", "media_type": "image/png", "data": b64}},
                {"type": "text", "text": _VISION_PROMPT},
            ]}],
        )
        data = json_from_text(text_of(msg))
        if data and data.get("po_number"):
            records.append(_spektrum_record(data))
    return records


def _garment_description(r):
    """Rebuild the multi-line garment description (matches the invoice template)."""
    # "ORIGINAL" is not a meaningful status for the quote -> show it as n/a.
    status = "n/a" if (r["status"] or "").upper() == "ORIGINAL" else r["status"]
    # Body then a blank line then the pack lines — matches quote #2110 exactly.
    body = "\n".join(p for p in [r["description"], r["design_num"], status, r["blank"], r["division"]] if p)
    return f"{body}\n\n" + "\n".join(r["pack_lines"])


def _addr_input(addr: dict, company: str, person: str) -> dict:
    """Map a Printavo Address (read) -> CustomerAddressInput (write)."""
    out = {"companyName": company, "customerName": person,
           "address1": addr.get("address1"), "address2": addr.get("address2"),
           "city": addr.get("city"), "stateIso": addr.get("stateIso"),
           "zipCode": addr.get("zipCode"), "countryIso": addr.get("countryIso") or "US"}
    return {k: v for k, v in out.items() if v}


def _li(desc, color=None, sizes=None, price=0.0):
    """One line item; every item carries an explicit price (0.0 for text sections)."""
    item = {"description": desc, "price": price}
    if color:
        item["color"] = color
    if sizes:
        item["sizes"] = sizes
    return item


def _status_disp(r):
    s = r["status"] or ""
    return "n/a" if s.upper() == "ORIGINAL" else s


def _spencers_groups(r, sizes_input):
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
        _li(SAMPLES_DEFAULT),
        _li(front),
        _li("APPROVAL METHOD:\n" + APPROVAL_METHOD_DEFAULT),
        _li(ALLOWED_SHORTAGE_DEFAULT),
        _li(SPECIAL_NOTES_HEADER),
    ]
    g2 = [_li(PACKING_DEPT), _li(packing_desc), _li(NEW_BOXES, price=NEW_BOXES_PRICE), _li(SPECIAL_NOTES_HEADER)]
    return [g1, g2]


def _tractor_groups(r, sizes_input):
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
        _li(front),
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


def _spektrum_groups(r, sizes_input):
    """First-pass CULTURE KINGS / SPEKTRUM template (2 groups). No reference quote
    yet — meant to be reviewed and perfected, then aligned like the others."""
    size_lines = "\n".join(r["pack_lines"])
    garment = "\n".join(p for p in [r["description"], r["color"], r["blank"], size_lines] if p)
    g1 = [
        _li(PRODUCTION_DEPT),
        _li(garment, color=r["color"], sizes=sizes_input, price=r["unit_price"]),
        _li(SPECIAL_NOTES_HEADER),
    ]
    g2 = [
        _li(PACKING_DEPT),
        _li("\n" + PACK_REFERENCES),
        _li(NEW_BOXES, price=2.50),
        _li(SPECIAL_NOTES_HEADER),
    ]
    return [g1, g2]


def build_quote_input(r: dict, contact_id: str, contact: dict = None, owner_id: str = None) -> dict:
    """Assemble a Printavo QuoteCreateInput. Picks the SPENCERS (2-group) or
    TRACTOR SUPPLY (3-group) template by brand. `contact` supplies the customer's
    billing/shipping addresses, which Printavo does not auto-copy from the contact."""
    sizes_input = [
        {"size": MOS_TO_PRINTAVO_SIZE[k], "count": v}
        for k, v in r["sizes"].items() if k in MOS_TO_PRINTAVO_SIZE
    ]
    brand_up = (r.get("brand") or "").upper()
    is_tractor = "TRACTOR" in brand_up
    is_spektrum = "CULTURE KING" in brand_up or "SPEKTRUM" in brand_up
    if is_tractor:
        groups = _tractor_groups(r, sizes_input)
    elif is_spektrum:
        groups = _spektrum_groups(r, sizes_input)
    else:
        groups = _spencers_groups(r, sizes_input)
    for grp in groups:
        for idx, item in enumerate(grp):
            item["position"] = idx

    status = r["status"] or ""
    brand = r.get("brand") or "SPENCERS"
    if is_tractor:
        # Matches the corrected quote #2127 header: "TRACTOR SUPPLY PO#21649 - AER0154J1358 - N/A"
        nickname = f"{brand} PO#{r['po_number']} - {r['design_num']} - {r['store_po'] or 'N/A'}"
    elif is_spektrum:
        nickname = f"{brand} PO#{r['po_number']} - {r.get('range_name') or ''} - {r['description']}".replace(" -  - ", " - ")
    else:
        # Nickname alineado con master invoice #2406: "PO#21767" (sin espacio).
        nickname = f"{brand} PO#{r['po_number']} - {r['store_po']} - {r['design_num']}"
    if status and status.upper() != "ORIGINAL":
        nickname += f" - {status}"

    due_date = _iso(r["cancel_date"]) or _iso(r["ship_date"])
    quote = {
        "contact": {"id": contact_id},
        "customerDueAt": due_date,
        "dueAt": (due_date + "T00:00:00Z") if due_date else None,
        "nickname": nickname,
        "visualPoNumber": r["po_number"],
        "customerNote": CUSTOMER_NOTE,
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
