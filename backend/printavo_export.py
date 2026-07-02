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
SPECIAL_NOTES_HEADER = "SPECIAL NOTES:"
CUSTOMER_NOTE = "DIGITAL PACKING LIST."
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
    m = next((_STYLE_RE.match(l) for l in text.split("\n") if _STYLE_RE.match(l)), None)
    if not m:
        return None

    po = re.search(r"^\d+\s+\d+\s+(\d+)$", text, re.M)                    # 4 26 21505 -> 21505
    # CUST PO = first token of the value row under the "CUST PO ... SHIP MODE" header
    # (numeric for Spencers like "322586", alphanumeric for Tractor like "PWA").
    store = re.search(r"CUST PO.*?SHIP MODE\s*\n\s*(\S+)", text, re.S)
    store_notes = re.search(r"\b([A-Z]+)\s+PO\s+(\d+)\b", text)           # "SPENCER PO 322586" (notes)
    # CUST can run into "ISSUE DATE" with no space ("...COMPANISSUE DATE").
    cust = re.search(r"CUST\s+(.+?)\s*ISSUE ?DATE\s+([\dA-Z\-]+)", text)
    ship = re.search(r"\bSHIP\s+(\d{1,2}-[A-Z]{3}-\d{2})", text)
    cancel = re.search(r"CANCEL\s+(\d{1,2}-[A-Z]{3}-\d{2})", text)
    colorln = re.search(r"^([A-Z]+)\s+Category", text, re.M)
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
        "description": m.group("desc").strip(),
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
    """2-group SPENCERS template (matches quote #2110)."""
    pack_txt = "\n".join(r["pack_lines"])
    packing_desc = f"{r['brand_prefix']} PO {r['store_po']}\nPACK\n\n{pack_txt}\n\n{PACK_REFERENCES}"
    front = r["front_print"] if (r["front_print"] and "FRONT PRINT" in r["front_print"]) \
        else ("FRONT PRINT\n" + r["front_print"] if r["front_print"] else "FRONT PRINT\nNECK LABEL\nFINISHING")
    g1 = [
        _li(PRODUCTION_DEPT),
        _li(_garment_description(r), color=r["color"], sizes=sizes_input, price=r["unit_price"]),
        _li(SAMPLES_DEFAULT),
        _li(front),
        _li("APPROVAL METHOD:\n" + (r["approval_method"] or "")),
        _li(ALLOWED_SHORTAGE_DEFAULT),
        _li(SPECIAL_NOTES_HEADER + ("\n" + r["blanks_trim"] if r["blanks_trim"] else "")),
    ]
    g2 = [_li(PACKING_DEPT), _li(packing_desc), _li(NEW_BOXES), _li(SPECIAL_NOTES_HEADER)]
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
    # The re-size instructions (SIZED: RE-SIZE ...) belong to SPECIAL NOTES in G1.
    special_notes = SPECIAL_NOTES_HEADER + ("\n" + r["resize"] if r["resize"] else "")

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
        _li(PACK_REFERENCES),
        _li(NEW_BOXES, price=2.50),
        _li(SPECIAL_NOTES_HEADER),
    ]
    return [g1, g2, g3]


def build_quote_input(r: dict, contact_id: str, contact: dict = None, owner_id: str = None) -> dict:
    """Assemble a Printavo QuoteCreateInput. Picks the SPENCERS (2-group) or
    TRACTOR SUPPLY (3-group) template by brand. `contact` supplies the customer's
    billing/shipping addresses, which Printavo does not auto-copy from the contact."""
    sizes_input = [
        {"size": MOS_TO_PRINTAVO_SIZE[k], "count": v}
        for k, v in r["sizes"].items() if k in MOS_TO_PRINTAVO_SIZE
    ]
    is_tractor = "TRACTOR" in (r.get("brand") or "").upper()
    groups = _tractor_groups(r, sizes_input) if is_tractor else _spencers_groups(r, sizes_input)
    for grp in groups:
        for idx, item in enumerate(grp):
            item["position"] = idx

    status = r["status"] or ""
    brand = r.get("brand") or "SPENCERS"
    if is_tractor:
        # Matches the corrected quote #2127 header: "TRACTOR SUPPLY PO#21649 - AER0154J1358 - N/A"
        nickname = f"{brand} PO#{r['po_number']} - {r['design_num']} - {r['store_po'] or 'N/A'}"
    else:
        nickname = f"{brand} PO# {r['po_number']} - {r['store_po']} - {r['design_num']}"
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
