"""Printavo invoice -> MOS order mapping and sync.

Turns a Printavo invoice (GraphQL node) into one or more MOS orders using the
SAME creation path as the manual "New Order" engine (internal_create_order),
so automations, notifications and WebSocket broadcasts all fire identically.

Design decisions (see NewOrderForm / import_router for the manual analogue):
  * order_number  <- invoice visualId. If an invoice has multiple line items,
                     extra items get a "-2", "-3" suffix to keep numbers unique.
  * client        <- contact.customer.companyName (fallback contact.fullName),
                     uppercased per the system-wide identity convention.
  * due_date + cancel_date <- customerDueAt (matches manual import convention).
  * customer_po / store_po / design_# <- parsed from the invoice nickname when it
                     follows the "BRAND PO# cust - store - design" header format.
  * sizes         <- LineItemSizeCount, normalized via import_router.SIZES_MAP.
                     Youth/toddler sizes are kept in the order data even though the
                     manual 9-size grid doesn't render them (no data loss).
  * board         <- SCHEDULING (same default as the manual engine).
  * source        <- "printavo_auto" so these are distinguishable from manual/ceo.
"""
import re
from datetime import datetime, timezone
from fastapi import HTTPException

from deps import db, logger, OrderCreate
from routers.import_router import SIZES_MAP

# Mock admin identity used for system-driven creation (mirrors deps.py sync user).
SYNC_USER = {
    "user_id": "printavo_sync",
    "email": "api@prosper-mfg.com",
    "name": "Printavo Sync",
    "role": "admin",
}

CONFIG_ID = "invoice_sync"

# "SPENCERS PO# 19291 - 311381 - GFM0118M1000 - REORDER"
# g1 branding, g2 customer PO, g3 store PO, g4 design #
_HEADER_PO_RE = re.compile(
    r"(?:([\w\-]+)\s+)?PO#\s*([\w-]+)\s*-\s*([\w-]+)\s*-\s*([\w-]+)", re.I
)

_URL_RE = re.compile(r"https?://[^\s\"'<>]+", re.I)
_TAG_RE = re.compile(r"<[^>]+>")
# Legal-entity suffixes stripped from the customer name (e.g. "... LLC" -> "...").
_SUFFIX_RE = re.compile(r"[\s,]+(L\.?L\.?C\.?|INC\.?|CORP\.?|CO\.|LTD\.?|L\.?L\.?P\.?)\s*$", re.I)


def _strip_company_suffix(name: str) -> str:
    s = (name or "").strip()
    prev = None
    while s and s != prev:
        prev = s
        s = _SUFFIX_RE.sub("", s).strip()
    return s


def _blank_style(description: str) -> str:
    """The garment/blank style code lives on the 4th line of the Printavo
    description (product name / design# / status / BLANK STYLE / ...).
    Falls back to the first line if the description is shorter."""
    lines = [l.strip() for l in str(description or "").replace("\r", "").split("\n") if l.strip()]
    if len(lines) >= 4:
        return lines[3]
    return lines[0] if lines else ""


def _extract_note_link(customer_note: str):
    """Pull the first URL (and a short label) out of Printavo's HTML customerNote."""
    if not customer_note:
        return None, None
    m = _URL_RE.search(customer_note)
    if not m:
        return None, None
    url = m.group(0)
    text = _TAG_RE.sub(" ", customer_note).replace("\xa0", " ")
    label = re.sub(r"\s+", " ", _URL_RE.sub("", text)).strip() or "Customer Notes"
    return url, label[:100]


def _up(v):
    return v.strip().upper() if isinstance(v, str) and v.strip() else v


def _vid_int(v):
    """Best-effort integer value of a visualId for high-water-mark comparison."""
    try:
        return int(str(v).strip())
    except (TypeError, ValueError):
        return None


def _size_label(sz):
    """LineItemSizeCount.size may be a plain string or an object; normalize."""
    if isinstance(sz, dict):
        sz = sz.get("name") or sz.get("size") or sz.get("value") or ""
    raw = str(sz or "").strip()
    # Printavo returns an enum like "size_s", "size_2xl", "size_other".
    if raw.lower().startswith("size_"):
        raw = raw[5:]
    return raw.upper()


def _flatten_line_items(invoice: dict) -> list:
    items = []
    for grp in ((invoice.get("lineItemGroups") or {}).get("nodes")) or []:
        for li in ((grp.get("lineItems") or {}).get("nodes")) or []:
            items.append(li)
    return items


def _map_sizes(line_item: dict):
    """Return ({mos_size: qty}, total_qty) from a Printavo line item.

    Printavo's LineItemSizeCount is {count: Int, size: LineItemSize}, where
    `size` is an enum-like scalar (e.g. "S", "2XL") and `count` is the quantity.
    """
    sizes_out, total = {}, 0
    for sc in line_item.get("sizes") or []:
        label = _size_label(sc.get("size"))
        mos_size = SIZES_MAP.get(label)
        if not mos_size:
            continue
        try:
            qty = int(sc.get("count") or 0)
        except (TypeError, ValueError):
            qty = 0
        if qty <= 0:
            continue
        sizes_out[mos_size] = sizes_out.get(mos_size, 0) + qty
        total += qty
    # Fallback: no per-size breakdown -> use the line item's total `items`.
    if total == 0:
        try:
            total = int(line_item.get("items") or 0)
        except (TypeError, ValueError):
            total = 0
    return sizes_out, total


def _parse_nickname(nickname: str):
    """Extract (branding, customer_po, store_po, design_#) from the invoice nickname."""
    if not nickname:
        return "", "", "", ""
    m = _HEADER_PO_RE.search(nickname)
    if not m:
        return "", "", "", ""
    return (m.group(1) or "", m.group(2) or "", m.group(3) or "", m.group(4) or "")


def invoice_to_orders(invoice: dict) -> list:
    """Map one Printavo invoice into a list of OrderCreate-ready dicts."""
    visual_id = str(invoice.get("visualId") or "").strip()
    if not visual_id:
        return []

    contact = invoice.get("contact") or {}
    customer = (contact.get("customer") or {}).get("companyName")
    # Strip legal suffix: "GOODIE TWO SLEEVES LLC" -> "GOODIE TWO SLEEVES".
    client = _up(_strip_company_suffix(customer or contact.get("fullName") or ""))

    due = invoice.get("customerDueAt") or invoice.get("dueAt") or ""
    if isinstance(due, str) and len(due) >= 10:
        due = due[:10]  # ISO date -> YYYY-MM-DD

    nickname = (invoice.get("nickname") or "").strip()
    # Branding = first word of the nickname (e.g. "SPENCERS TEST PO#..." -> "SPENCERS").
    branding = _up(nickname.split()[0]) if nickname else ""
    _, customer_po, store_po, design_num = _parse_nickname(nickname)

    # Work order link (for JOB TITLE A) and the customer-note link (for the order's
    # links section shown in the comments modal).
    workorder_url = invoice.get("workorderUrl") or invoice.get("url") or ""
    note_url, note_label = _extract_note_link(invoice.get("customerNote"))

    # A Printavo work order carries many non-garment "line items": department
    # headers (PRODUCTION/PACKING "DO NOT EDIT"), notes, approval method,
    # allowed shortage, sample specs, etc. The actual garment lines are the ones
    # with a real quantity. Keep only those so we don't create junk orders.
    real = []
    for li in _flatten_line_items(invoice):
        sizes, qty = _map_sizes(li)
        if qty > 0:
            real.append((li, sizes, qty))

    orders = []
    for idx, (li, sizes, qty) in enumerate(real):
        order_number = visual_id if idx == 0 else f"{visual_id}-{idx + 1}"
        # STYLE = blank style code (4th line of the description, e.g. "GI5000").
        style = _up(_blank_style(li.get("description")) or li.get("itemNumber") or "IMPORTADO PRINTAVO")
        order = {
            "order_number": order_number,
            "client": client,
            "branding": branding,
            "style": style,
            "color": _up(li.get("color") or ""),
            "customer_po": customer_po,
            "store_po": store_po,
            "store_po#": store_po,
            "design_#": _up(design_num),
            "due_date": due,
            "cancel_date": due,
            "quantity": qty,
            "sizes": sizes or None,
            "board": "SCHEDULING",
            "source": "printavo_auto",
            "printavo_invoice_id": invoice.get("id"),
            "notes": f"Auto-importado de Printavo Invoice #{visual_id}",
        }
        # JOB TITLE A = work order link + its title (the nickname).
        if workorder_url:
            order["job_title_a"] = {"url": workorder_url, "desc": nickname[:120] or "Printavo WO"}
        order = {k: v for k, v in order.items() if v not in (None, "", {})}
        # Customer-note link -> the order's links section (shown in the comments modal).
        if note_url:
            order["links"] = [{
                "url": note_url,
                "description": note_label or "Customer Notes",
                "created_at": datetime.now(timezone.utc).isoformat(),
                "added_by": "Printavo Sync",
            }]
        orders.append(order)

    return orders


async def process_invoice(invoice: dict) -> int:
    """Create MOS orders for one invoice. Returns count of orders created."""
    from routers.orders import internal_create_order  # lazy import to avoid cycles

    created = 0
    for data in invoice_to_orders(invoice):
        order_number = data.get("order_number")
        # Skip if an active order already exists (idempotent re-polling).
        existing = await db.orders.find_one(
            {"order_number": order_number, "board": {"$ne": "PAPELERA DE RECICLAJE"}},
            {"_id": 1},
        )
        if existing:
            continue
        try:
            await internal_create_order(OrderCreate(**data), SYNC_USER)
            created += 1
            logger.info(f"[printavo] created order {order_number} from invoice")
        except HTTPException as e:
            # Duplicate (race) or validation issue -> log and move on.
            logger.warning(f"[printavo] skip order {order_number}: {e.detail}")
        except Exception as e:
            logger.error(f"[printavo] failed to create order {order_number}: {e}")
    return created


async def sync_once(cfg: dict) -> dict:
    """Fetch recent invoices and create orders for the new ones.

    First run (no watermark) seeds the high-water mark WITHOUT importing the
    backlog, so enabling the sync never floods MOS with historical invoices.
    """
    from printavo_client import fetch_recent_invoices

    fetch_size = int(cfg.get("fetch_size") or 25)
    nodes = await fetch_recent_invoices(fetch_size)

    last_int = _vid_int(cfg.get("last_visual_id"))
    max_int = last_int

    # First-ever run: seed watermark to newest, create nothing.
    if last_int is None:
        seed = max((v for v in (_vid_int(n.get("visualId")) for n in nodes) if v is not None), default=None)
        return {"initialized": True, "created": 0, "seen": len(nodes), "watermark": seed}

    # Process oldest-first among the not-yet-seen invoices so the watermark
    # advances monotonically even if we crash mid-batch.
    new_nodes = []
    for n in nodes:
        vint = _vid_int(n.get("visualId"))
        if vint is None or vint > last_int:
            new_nodes.append((vint, n))
    new_nodes.sort(key=lambda t: (t[0] is None, t[0] or 0))

    created_total = 0
    for vint, node in new_nodes:
        created_total += await process_invoice(node)
        if vint is not None and (max_int is None or vint > max_int):
            max_int = vint

    return {"initialized": False, "created": created_total, "seen": len(nodes), "watermark": max_int}
