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
ALLOWED_SHORTAGE_DEFAULT = "ALLOWED SHORTAGE:\n0%"
SAMPLES_DEFAULT = "SAMPLES\nN/A"
SPECIAL_NOTES_HEADER = "SPECIAL NOTES"
PACK_REFERENCES = (
    "INCLUDES REFERENCES TO:\nPrice Ticket\nHang Tag\nBag/No Bag\n"
    "Bag Size (if specified)\nFolding Type\nFolding Size (if specified)\n"
    "Box Type\nBox Size (if specified)"
)

# design color [colorfull] ln wh ref cloth  description...  qty price extn
_STYLE_RE = re.compile(
    r"^(?P<design>\S+)\s+(?P<color>\S+)(?:\s+\S+)?\s+(?P<ln>\d+)\s+(?P<wh>[A-Z]{2})\s+"
    r"(?P<ref>\S+)\s+(?P<cloth>\S+)\s+(?P<desc>.+?)\s+(?P<qty>[\d,]+)\s+[\d,.]+\s+[\d,.]+\s*$"
)


def _parse_goodie_page(text):
    """Parse one page of a Goodie Two Sleeves Master Cut Ticket. Returns None if
    the page has no style line (e.g. a summary page)."""
    m = next((_STYLE_RE.match(l) for l in text.split("\n") if _STYLE_RE.match(l)), None)
    if not m:
        return None

    po = re.search(r"^\d+\s+\d+\s+(\d+)$", text, re.M)                    # 4 26 21505 -> 21505
    store = re.search(r"CUST PO.*?\n\s*(\d+)", text, re.S)                # table CUST PO (authoritative)
    store_notes = re.search(r"\b([A-Z]+)\s+PO\s+(\d+)\b", text)           # "SPENCER PO 322586" (notes)
    cust = re.search(r"CUST\s+(.+?)\s+ISSUE DATE\s+([\dA-Z\-]+)", text)
    ship = re.search(r"\bSHIP\s+(\d{1,2}-[A-Z]{3}-\d{2})", text)
    cancel = re.search(r"CANCEL\s+(\d{1,2}-[A-Z]{3}-\d{2})", text)
    colorln = re.search(r"^([A-Z]+)\s+Category", text, re.M)
    status = re.search(r"\n(ORIGINAL|REORDER|NEW|ROLLOUT[ /A-Z]*)\n", text)

    # Front print / division / approval / blanks come from the "** **" note blocks.
    # Each note is a single line; stop at the next line to avoid swallowing the
    # PACK block or the page footer.
    division = re.search(r"\*\*DIVISION:\s*\*\*\s*\n([^\n]+)", text)
    approval = re.search(r"\*\*APPROVAL METHOD:\s*\*\*\s*\n([^\n]+)", text)
    blanks = re.search(r"\*\*BLANKS & TRIM\s*\*\*\s*\n([^\n]+)", text)
    # print/finishing lines sit between the "$.90" cost line and the first "** **".
    fp = re.search(r"BREAKDOWN COSTS INCLUDE[^\n]*\n(.+?)(?=\n\*\*)", text, re.S)

    # Sizes from the clean PACK notes block (the table block is misaligned in text).
    sizes, total = {}, 0
    pack_lines = []
    for sz, q in re.findall(r"([A-Z0-9]{1,4})\s*-\s*(\d+)", text):
        ms = SIZES_MAP.get(sz.upper())
        if ms:
            sizes[ms] = sizes.get(ms, 0) + int(q)
            total += int(q)
            pack_lines.append(f"{sz.upper()} - {q}")

    qty_declared = int(m.group("qty").replace(",", ""))
    return {
        "po_number": po.group(1) if po else None,
        "store_po": store.group(1) if store else (store_notes.group(2) if store_notes else None),
        "store_po_notes": store_notes.group(2) if store_notes else None,
        "brand_prefix": store_notes.group(1) if store_notes else "SPENCER",  # e.g. "SPENCER"
        "retailer": cust.group(1).strip() if cust else None,
        "issue_date": cust.group(2) if cust else None,
        "ship_date": ship.group(1) if ship else None,
        "cancel_date": cancel.group(1) if cancel else None,
        "design_num": m.group("design"),
        "blank": m.group("cloth"),
        "color": colorln.group(1) if colorln else m.group("color"),
        "description": m.group("desc").strip(),
        "status": (status.group(1).strip() if status else "ORIGINAL"),
        "division": (division.group(1).strip() if division else ""),
        "front_print": (fp.group(1).strip() if fp else ""),
        "approval_method": (approval.group(1).strip() if approval else ""),
        "blanks_trim": (blanks.group(1).strip() if blanks else ""),
        "qty": qty_declared,
        "sizes": sizes,
        "pack_lines": pack_lines,
        "qty_from_sizes": total,
        "sizes_match": qty_declared == total,
        "po_discrepancy": bool(store and store_notes and store.group(1) != store_notes.group(2)),
    }


def parse_pdf(pdf_bytes: bytes) -> list:
    """Parse a customer PO PDF into one record per style (each = one quote)."""
    out = []
    with pdfplumber.open(io.BytesIO(pdf_bytes)) as pdf:
        for page in pdf.pages:
            rec = _parse_goodie_page(page.extract_text() or "")
            if rec:
                out.append(rec)
    return out


def _iso(d):
    """'18-JUN-26' -> '2026-06-18' (best effort)."""
    if not d:
        return None
    months = {"JAN": "01", "FEB": "02", "MAR": "03", "APR": "04", "MAY": "05", "JUN": "06",
              "JUL": "07", "AUG": "08", "SEP": "09", "OCT": "10", "NOV": "11", "DEC": "12"}
    m = re.match(r"(\d{1,2})-([A-Z]{3})-(\d{2})", d)
    if not m:
        return None
    return f"20{m.group(3)}-{months.get(m.group(2), '01')}-{int(m.group(1)):02d}"


def _garment_description(r):
    """Rebuild the multi-line garment description (matches the invoice template)."""
    pack = "\n".join(r["pack_lines"])
    parts = [r["description"], r["design_num"], r["status"], r["blank"], r["division"], "", pack]
    return "\n".join(p for p in parts if p is not None)


def build_quote_input(r: dict, contact_id: str) -> dict:
    """Assemble a Printavo QuoteCreateInput reproducing the 11-section template."""
    sizes_input = [
        {"size": MOS_TO_PRINTAVO_SIZE[k], "count": v}
        for k, v in r["sizes"].items() if k in MOS_TO_PRINTAVO_SIZE
    ]
    pack_txt = "\n".join(r["pack_lines"])
    packing_desc = f"{r['brand_prefix']} PO {r['store_po']}\nPACK\n\n{pack_txt}\n\n{PACK_REFERENCES}"

    def li(desc, color=None, sizes=None, price=None):
        item = {"description": desc}
        if color:
            item["color"] = color
        if sizes:
            item["sizes"] = sizes
        if price is not None:
            item["price"] = price
        return item

    line_items = [
        li(PRODUCTION_DEPT),
        li(_garment_description(r), color=r["color"], sizes=sizes_input, price=0.90),
        li(SAMPLES_DEFAULT),
        li("FRONT PRINT\n" + r["front_print"] if r["front_print"] and "FRONT PRINT" not in r["front_print"] else (r["front_print"] or "FRONT PRINT\nNECK LABEL\nFINISHING")),
        li("APPROVAL METHOD:\n" + (r["approval_method"] or "")),
        li(ALLOWED_SHORTAGE_DEFAULT),
        li(SPECIAL_NOTES_HEADER + ("\n" + r["blanks_trim"] if r["blanks_trim"] else "")),
        li(PACKING_DEPT),
        li(packing_desc),
        li(NEW_BOXES),
        li(SPECIAL_NOTES_HEADER),
    ]

    nickname = f"SPENCERS PO# {r['po_number']} - {r['store_po']} - {r['design_num']} - {r['status']}"
    return {
        "contact": {"id": contact_id},
        "customerDueAt": _iso(r["cancel_date"]) or _iso(r["ship_date"]),
        "nickname": nickname,
        "visualPoNumber": r["po_number"],
        "lineItemGroups": [{"lineItems": line_items}],
    }
