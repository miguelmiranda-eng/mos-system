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
from pymongo.errors import DuplicateKeyError

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

# Only import invoices whose Printavo status is one of these (case-insensitive).
# The `invoices` GraphQL list already excludes anything in "Quote" status (those are
# in the separate `quotes` list the sync never queries), so this is a second, explicit
# gate: it guarantees an order is never created before it reaches "Scheduled", even if
# Printavo ever surfaces some other non-Quote intermediate status in the invoices list.
# Overridable per-install via cfg["required_statuses"].
DEFAULT_REQUIRED_STATUSES = ["Scheduled"]


def _status_ok(node: dict, allowed: set) -> bool:
    if not allowed:
        return True
    name = ((node.get("status") or {}).get("name") or "").strip().lower()
    return name in allowed

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
        has_sizes = bool(sizes)
        has_color = bool((li.get("color") or "").strip())
        if qty > 0 and (has_sizes or has_color):
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


async def _claim_invoice(invoice_id) -> bool:
    """Atomically claim a Printavo invoice so exactly one pass/worker processes it.

    Inserts into printavo_processed keyed by the invoice's stable id (unique by
    definition). The insert is atomic ACROSS PROCESSES, so unlike the in-process
    asyncio lock it also stops a multi-worker deployment from double-creating.
    Returns True if we won the claim (first time seen), False if already processed.

    This also fixes the out-of-order bug the VISUAL_ID watermark had: an invoice is
    claimed the first time it is SEEN, regardless of how its number compares to the
    others — a late quote->invoice conversion is no longer skipped by a high mark.
    Works alongside the uniq_printavo_order_number index as defense-in-depth.
    """
    if not invoice_id:
        return False
    try:
        await db.printavo_processed.insert_one({
            "_id": str(invoice_id),
            "claimed_at": datetime.now(timezone.utc).isoformat(),
        })
        return True
    except DuplicateKeyError:
        return False


async def _flag_prov_matches(order_number: str) -> None:
    """Marca en la orden real los sample_task provisionales que la UI debería
    ofrecer fusionar. Se llama después de crear una orden desde Printavo.
    Match: mismo style+client, due_date dentro de ±5 días.
    """
    if not order_number:
        return
    real = await db.orders.find_one(
        {"order_number": order_number, "board": {"$ne": "PAPELERA DE RECICLAJE"}},
        {"_id": 0, "order_id": 1, "style": 1, "client": 1, "due_date": 1,
         "is_provisional": 1},
    )
    if not real or real.get("is_provisional"):
        return
    style = (real.get("style") or "").strip().upper()
    client = (real.get("client") or "").strip().upper()
    if not style or not client:
        return
    prov_orders = await db.orders.find(
        {"is_provisional": True, "style": style, "client": client,
         "board": {"$ne": "PAPELERA DE RECICLAJE"}},
        {"_id": 0, "order_id": 1, "due_date": 1},
    ).to_list(20)
    if not prov_orders:
        return
    real_due = (real.get("due_date") or "").strip()
    matched_ids = []
    for p in prov_orders:
        pdue = (p.get("due_date") or "").strip()
        if real_due and pdue:
            try:
                d1 = datetime.strptime(real_due[:10], "%Y-%m-%d").date()
                d2 = datetime.strptime(pdue[:10], "%Y-%m-%d").date()
                if abs((d1 - d2).days) > 5:
                    continue
            except ValueError:
                pass
        matched_ids.append(p["order_id"])
    if not matched_ids:
        return
    # Filtra a los que sí tengan un sample_task activo, para no ofrecer
    # banners fantasmas cuando el PROV- ya fue borrado del calendario.
    active = await db.sample_tasks.find(
        {"order_id": {"$in": matched_ids}}, {"_id": 0, "order_id": 1}
    ).to_list(50)
    active_ids = [t["order_id"] for t in active]
    if not active_ids:
        return
    await db.orders.update_one(
        {"order_id": real["order_id"]},
        {"$set": {"sample_prov_matches": active_ids,
                  "sample_prov_matches_at": datetime.now(timezone.utc).isoformat()}},
    )


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
            # Auto-match: si algún ejemplo PROV- coincide en style+client+due_date,
            # se etiqueta la orden real para que la UI de Ejemplos ofrezca fusionar.
            try:
                await _flag_prov_matches(order_number)
            except Exception as e:
                logger.warning(f"[printavo] prov-match check failed for {order_number}: {e}")
        except DuplicateKeyError:
            # The uniq_printavo_order_number index rejected a same-number insert.
            # This is the intended idempotent outcome — the order already exists.
            logger.warning(f"[printavo] skip order {order_number}: already exists (unique index)")
        except HTTPException as e:
            # Duplicate (race) or validation issue -> log and move on.
            logger.warning(f"[printavo] skip order {order_number}: {e.detail}")
        except Exception as e:
            logger.error(f"[printavo] failed to create order {order_number}: {e}")
    return created


def _max_visual_id(nodes) -> str:
    vids = [_vid_int(n.get("visualId")) for n in nodes]
    top = max((v for v in vids if v is not None), default=None)
    return str(top) if top is not None else None


async def sync_once(cfg: dict) -> dict:
    """Fetch recent invoices and create an order for each NEW one.

    Dedup is per-invoice via an atomic claim (printavo_processed) instead of a
    VISUAL_ID watermark. That works across processes AND picks up invoices whose
    quote converts out of numeric order (the watermark used to skip those). The
    uniq_printavo_order_number index and the process-wide sync lock stay as
    defense-in-depth.

    First run seeds every currently-visible invoice as processed WITHOUT importing
    it, so enabling the sync never floods MOS with the historical backlog.
    """
    from printavo_client import fetch_recent_invoices

    fetch_size = int(cfg.get("fetch_size") or 25)
    nodes = await fetch_recent_invoices(fetch_size)
    watermark = _max_visual_id(nodes)  # cosmetic only: shown in the UI as "last invoice"
    allowed = {s.strip().lower() for s in (cfg.get("required_statuses") or DEFAULT_REQUIRED_STATUSES)}

    # Only act on invoices already in a "ready" status. Non-ready ones are NOT claimed,
    # so they get picked up on a later tick once they reach "Scheduled".
    ready = [n for n in nodes if _status_ok(n, allowed)]

    # First run: claim the ready invoices so we don't backfill the existing history.
    if not cfg.get("seeded"):
        for n in ready:
            await _claim_invoice(n.get("id"))
        await db.printavo_sync.update_one(
            {"config_id": CONFIG_ID}, {"$set": {"seeded": True}}, upsert=True
        )
        return {"initialized": True, "created": 0, "seen": len(nodes), "watermark": watermark}

    created_total = 0
    for node in ready:
        inv_id = node.get("id")
        if not await _claim_invoice(inv_id):
            continue  # already processed (a prior tick, or another worker)
        try:
            created_total += await process_invoice(node)
        except Exception as e:
            # Release the claim so a failed invoice is retried on the next tick.
            logger.error(f"[printavo] invoice {node.get('visualId')} failed, releasing claim: {e}")
            await db.printavo_processed.delete_one({"_id": str(inv_id)})

    return {"initialized": False, "created": created_total, "seen": len(nodes), "watermark": watermark}
