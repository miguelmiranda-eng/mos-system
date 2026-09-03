"""Printavo invoice -> MOS order mapping and sync.

Turns a Printavo invoice (GraphQL node) into one or more MOS orders using the
SAME creation path as the manual "New Order" engine (internal_create_order),
so automations, notifications and WebSocket broadcasts all fire identically.

Design decisions (see NewOrderForm / import_router for the manual analogue):
  * order_number  <- invoice visualId. Garment lines are CONSOLIDATED BY COLOR
                     (2026-08-13): un invoice trae varios estilos (tipo de prenda:
                     tee / long sleeve / hoodie) del MISMO color y la nave lo opera
                     como UNA orden con cantidad y tallas sumadas — así lo venía
                     corrigiendo a mano el equipo (2501, 2500, 2450...). Cada color
                     adicional sí es una orden hermana con sufijo "-2", "-3".
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

# Printavo status name(s) that mean "the job is billed"; reaching one triggers
# copying the billed total + total quantity onto the matching MOS order.
# Overridable per-install via cfg["final_bill_status_names"].
DEFAULT_FINAL_BILL_STATUSES = ["Final Bill"]

TRASH_BOARD = "PAPELERA DE RECICLAJE"


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


# Renglón de talla ("M - 15", "2XL: 8") que en algunos invoices ocupa la 4ª
# línea de la descripción; NO es un estilo de prenda (produjo órdenes con
# style "M - 15" — ver 2450/2500/2501/2829/2832).
_SIZE_ROW_RE = re.compile(
    r"^(X{0,5}S|X{0,5}L|SM|MD|LG|M|[2-5]\s?XL?|[2-5]X|Y(XS|S|M|L|XL)|[2-5]T)\s*[-–:]\s*\d+$", re.I
)

# Renglón de talla dentro de la descripción del line item, en cualquiera de los
# formatos que teclea el equipo de Printavo: "SM - 61", "MD- 62", "LG-61",
# "3X : 15", "2XL 20". Se usa para RECUPERAR las tallas que la grilla del
# invoice no puede expresar (ver _map_sizes / size_other).
_DESC_SIZE_ROW_RE = re.compile(
    r"^[\s*•\-]*"
    r"(YXS|YXL|YS|YM|YL|X{2,5}L|XS|XL|SM|MD|LG|[2-5]\s?XL|[2-5]\s?X|[2-5]T|S|M|L)"
    r"[\s:.\-–—]+(\d{1,5})\s*$",
    re.I | re.M,
)


def _norm_size(raw) -> str:
    """Normaliza una etiqueta de talla (de la API o de la descripción) a la talla
    MOS. Acepta lo que ya vive en SIZES_MAP y además cualquier variante NX / NXL
    y XX…L, para que una talla nueva no se pierda por no estar en el diccionario."""
    s = re.sub(r"[^A-Z0-9]", "", str(raw or "").upper())
    # Acepta también el enum crudo de la API ("size_3xl") sin pasar por _size_label.
    if s.startswith("SIZE") and len(s) > 4:
        s = s[4:]
    if not s:
        return ""
    if s in SIZES_MAP:
        return SIZES_MAP[s]
    m = re.fullmatch(r"([2-9])XL?", s)        # 3X, 3XL, 7XL...
    if m:
        return f"{m.group(1)}X"
    m = re.fullmatch(r"(X{2,6})L", s)          # XXL, XXXL, XXXXL...
    if m:
        return f"{len(m.group(1))}X"
    return ""


def _sizes_from_description(description) -> dict:
    """Desglose {talla_mos: qty} leído de los renglones de talla de la descripción."""
    out = {}
    text = str(description or "").replace("\r\n", "\n").replace("\r", "\n")
    for m in _DESC_SIZE_ROW_RE.finditer(text):
        mos = _norm_size(m.group(1))
        if not mos:
            continue
        try:
            qty = int(m.group(2))
        except (TypeError, ValueError):
            continue
        if qty > 0:
            out[mos] = out.get(mos, 0) + qty
    return out


def _blank_style(description: str) -> str:
    """The garment/blank style code lives on the 4th line of the Printavo
    description (product name / design# / status / BLANK STYLE / ...).
    Falls back to the first line if the description is shorter. Returns ""
    when the candidate is a size row ("M - 15") so the caller can fall back
    to itemNumber / the product name instead of saving junk."""
    lines = [l.strip() for l in str(description or "").replace("\r", "").split("\n") if l.strip()]
    candidate = lines[3] if len(lines) >= 4 else (lines[0] if lines else "")
    return "" if _SIZE_ROW_RE.match(candidate) else candidate


def _line_style(li: dict) -> str:
    """Best usable style for one garment line: blank-style code, then
    itemNumber, then the product name (1st description line — donde vive el
    tipo de prenda: tee / long sleeve / hoodie). "" si no hay nada usable."""
    style = _blank_style(li.get("description"))
    if style:
        return style
    item = (li.get("itemNumber") or "").strip()
    if item:
        return item
    lines = [l.strip() for l in str(li.get("description") or "").replace("\r", "").split("\n") if l.strip()]
    return lines[0][:60] if lines else ""


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


# Líneas de SERVICIO/acabado que heredan el desglose de tallas del garment y
# por eso pasaban el filtro de abajo, creando órdenes basura e inflando el
# Final Bill (2148: SETUP FEE + NECK LABEL; 2328: instrucciones de empaque).
# Solo se descartan cuando la línea NO tiene color: una prenda real siempre
# trae color, un fee/instrucción no.
_SERVICE_LINE_RE = re.compile(
    r"SETUP\s+FEE|NECK\s+LABEL|POLY(ETHYLENE)?\s*BAG|UPC\s+LABEL|FOLDED\s+\d|^\s*\d+\s*\)",
    re.I,
)


def _is_service_line(li: dict) -> bool:
    if (li.get("color") or "").strip():
        return False
    text = str(li.get("description") or "")
    return bool(_SERVICE_LINE_RE.search(text))


def _real_line_items(invoice: dict) -> list:
    """Return only the GARMENT line items as (line_item, sizes, qty) tuples.

    A Printavo work order carries many non-garment lines (department headers,
    notes, approval method, allowed shortage, sample specs, ...). The real
    garment lines are the ones with a positive quantity AND either a size
    breakdown or a color, excluding known service/finishing lines (which copy
    the garment's size breakdown but aren't pieces). Shared by order creation
    (invoice_to_orders) and the Final Bill total-quantity calc so both agree
    on what counts as a garment.
    """
    real = []
    for li in _flatten_line_items(invoice):
        if _is_service_line(li):
            continue
        sizes, qty = _map_sizes(li)
        if qty > 0 and (bool(sizes) or bool((li.get("color") or "").strip())):
            real.append((li, sizes, qty))
    return real


def _billed_qty(line_item: dict, sizes_qty: int) -> int:
    """Piece count of one garment line FOR BILLING (columna Total Quantity).

    Printavo's own `items` is the authoritative line quantity, so it wins here.
    The size breakdown drops every size outside SIZES_MAP — notably `size_other`,
    Printavo's catch-all — which silently undercounts (a line with 245 in normal
    sizes + 20 in `size_other` summed to 245). Falls back to the size sum when
    `items` is missing/0, which is what `_map_sizes` already returns.
    """
    try:
        items = int(line_item.get("items") or 0)
    except (TypeError, ValueError):
        items = 0
    return items if items > 0 else sizes_qty


def _map_sizes(line_item: dict):
    """Return ({mos_size: qty}, total_qty) from a Printavo line item.

    Printavo's LineItemSizeCount is {count: Int, size: LineItemSize}, where
    `size` is an enum-like scalar (e.g. "S", "2XL") and `count` is the quantity.

    OJO con `size_other`: la grilla de tallas del invoice NO tiene una columna
    por talla. En esta cuenta son XS/S/M/L/XL/2XL + `size_other`, así que una
    prenda con 3X (o 4X/5X, o tallas raras) llega toda amontonada en
    `size_other` — el work order impreso sí la rotula "3XL", la API no. Antes
    esas piezas se tiraban en silencio: la 2395 se creó con 285u y sin renglón
    3X cuando el invoice traía 300 (15 de 3X), y alguien tuvo que corregir la
    cantidad a mano. Ahora se intenta recuperar la talla real desde los
    renglones de la descripción y, si no se puede, las piezas igual se cuentan
    en la cantidad y queda un WARNING con el line item para poder rastrearlo.
    """
    sizes_out, total = {}, 0
    unmapped, unmapped_labels = 0, []
    for sc in line_item.get("sizes") or []:
        label = _size_label(sc.get("size"))
        try:
            qty = int(sc.get("count") or 0)
        except (TypeError, ValueError):
            qty = 0
        if qty <= 0:
            continue
        mos_size = _norm_size(label)
        if not mos_size:
            unmapped += qty
            unmapped_labels.append(f"{label or '?'}={qty}")
            continue
        sizes_out[mos_size] = sizes_out.get(mos_size, 0) + qty
        total += qty

    if unmapped > 0:
        ref = (line_item.get("itemNumber") or "").strip() or _line_style(line_item) or "(línea sin estilo)"
        # Solo sirven las tallas de la descripción que la grilla NO trajo: las
        # que ya vinieron de la API mandan (son el dato duro) y repetirlas
        # duplicaría piezas. Se exige que cuadren exacto con el remanente.
        recovered = {s: q for s, q in _sizes_from_description(line_item.get("description")).items()
                     if s not in sizes_out}
        if recovered and sum(recovered.values()) == unmapped:
            sizes_out.update(recovered)
            total += unmapped
            logger.info(f"[printavo] {ref}: {unmapped}u en tallas no mapeables "
                        f"({', '.join(unmapped_labels)}) recuperadas de la descripción como "
                        f"{recovered}")
        else:
            total += unmapped
            logger.warning(f"[printavo] {ref}: {unmapped}u en tallas no mapeables "
                           f"({', '.join(unmapped_labels)}) que la descripción no permite "
                           f"desglosar (candidatas: {recovered or '—'}); cuentan en la cantidad "
                           f"pero la orden queda sin ese renglón de talla")

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

    # Keep only the garment lines (see _real_line_items) so we don't create junk
    # orders from department headers / notes / sample specs.
    real = _real_line_items(invoice)

    # Consolidación POR COLOR: un invoice trae varios estilos (tipo de prenda:
    # tee / long sleeve / hoodie) del MISMO color y la nave lo opera como UNA
    # orden con cantidad y tallas sumadas (antes cada línea era una orden
    # hermana "-2"/"-3" que el equipo tiraba a papelera y consolidaba a mano,
    # dejando la principal con las tallas de un solo estilo — ver 2501).
    # Los grupos conservan el orden de aparición en el invoice.
    groups = []          # [{color, lines: [(li, sizes, qty)]}] en orden
    by_color = {}
    for li, sizes, qty in real:
        color = _up(li.get("color") or "") or ""
        g = by_color.get(color)
        if g is None:
            g = {"color": color, "lines": []}
            by_color[color] = g
            groups.append(g)
        g["lines"].append((li, sizes, qty))

    orders = []
    for idx, g in enumerate(groups):
        order_number = visual_id if idx == 0 else f"{visual_id}-{idx + 1}"
        # Suma de tallas y unidades de TODOS los estilos del color.
        merged_sizes, total_qty = {}, 0
        for _, sizes, qty in g["lines"]:
            for s, q in (sizes or {}).items():
                merged_sizes[s] = merged_sizes.get(s, 0) + q
            total_qty += qty
        # STYLE = estilos únicos del grupo unidos con " / " (blank style, luego
        # itemNumber, luego nombre de la prenda — ver _line_style).
        styles = []
        for li, _, _ in g["lines"]:
            st = _up(_line_style(li))
            if st and st not in styles:
                styles.append(st)
        style = " / ".join(styles)[:80] or "IMPORTADO PRINTAVO"

        notes = f"Auto-importado de Printavo Invoice #{visual_id}"
        if len(g["lines"]) > 1:
            # Desglose por línea para auditoría: la consolidación nunca debe
            # esconder qué estilos y cuántas piezas de cada uno trae la orden.
            partes = []
            for li, sizes, qty in g["lines"]:
                st = _up(_line_style(li)) or "(sin estilo)"
                det = " ".join(f"{s}{q}" for s, q in sizes.items()) if sizes else "sin tallas"
                partes.append(f"• {st}: {qty}u [{det}]")
            notes += f"\n{len(g['lines'])} estilos consolidados (mismo color):\n" + "\n".join(partes)

        order = {
            "order_number": order_number,
            "client": client,
            "branding": branding,
            "style": style,
            "color": g["color"],
            "customer_po": customer_po,
            "store_po": store_po,
            "store_po#": store_po,
            "design_#": _up(design_num),
            "due_date": due,
            "cancel_date": due,
            "quantity": total_qty,
            "sizes": merged_sizes or None,
            "board": "SCHEDULING",
            "source": "printavo_auto",
            "printavo_invoice_id": invoice.get("id"),
            "notes": notes,
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


async def refresh_note_links(nodes: list) -> int:
    """Re-lee el customerNote de los invoices visibles en esta pasada y actualiza
    el link que el propio sync sembró en las órdenes existentes.

    El link de packing se copiaba UNA sola vez al crear la orden; los quotes en
    Printavo se arman duplicando el anterior, así que si el invoice se convertía
    antes de que la nota recibiera su packing list definitivo, MOS congelaba el
    link heredado del quote clonado y la corrección posterior en Printavo nunca
    se propagaba (casos 2622 y 2568, 2026-08). Esta pasada corre en cada tick
    sobre los MISMOS nodos ya traídos (costo API cero) y cierra esa ventana:

      * solo toca la entrada cuyo added_by == "Printavo Sync" — una edición
        humana toma posesión del link y el sync no la vuelve a pisar;
      * si la orden no tiene ningún link y la nota ya trae URL, lo agrega
        (sana órdenes cuya nota estaba vacía al crearse);
      * nunca borra: si la nota quedó sin URL se conserva el último conocido.

    Solo alcanza la ventana de invoices recientes del poll; una divergencia más
    vieja que eso se corrige a mano (la orden ya viajó a producción de todos modos).
    """
    from deps import log_activity  # lazy: keeps the module import side-effect free

    refreshed = 0
    for node in nodes:
        inv_id = node.get("id")
        if not inv_id:
            continue
        note_url, note_label = _extract_note_link(node.get("customerNote"))
        if not note_url:
            continue
        orders = await db.orders.find(
            {"printavo_invoice_id": inv_id, "board": {"$ne": TRASH_BOARD}},
            {"_id": 0, "order_id": 1, "order_number": 1, "links": 1},
        ).to_list(20)
        for order in orders:
            links = order.get("links") or []
            idx = next((i for i, l in enumerate(links)
                        if l.get("added_by") == SYNC_USER["name"]), None)
            if idx is None and links:
                continue  # un humano curó los links de esta orden: no intervenir
            old = links[idx] if idx is not None else None
            if old and old.get("url") == note_url:
                continue  # sin cambio
            entry = {
                "url": note_url,
                "description": note_label or "Customer Notes",
                "created_at": datetime.now(timezone.utc).isoformat(),
                "added_by": SYNC_USER["name"],
            }
            update = {"$set": {f"links.{idx}": entry}} if idx is not None \
                else {"$push": {"links": entry}}
            await db.orders.update_one({"order_id": order["order_id"]}, update)
            refreshed += 1
            logger.info(f"[printavo] link refresh {order.get('order_number')}: "
                        f"{(old or {}).get('url')} -> {note_url}")
            try:
                await log_activity(SYNC_USER, "printavo_link_refresh", {
                    "order_id": order["order_id"],
                    "order_number": order.get("order_number"),
                    "from_url": (old or {}).get("url"),
                    "to_url": note_url,
                })
            except Exception as e:
                logger.warning(f"[printavo] link refresh log failed: {e}")
    if refreshed:
        # Flush del cache de /api/orders (sin TTL, solo lo limpia el broadcast).
        try:
            from ws_manager import ws_manager
            await ws_manager.broadcast("order_change", {"action": "link_refresh"})
        except Exception as e:
            logger.warning(f"[printavo] link refresh broadcast failed: {e}")
    return refreshed


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

    # Propaga correcciones del customerNote a órdenes ya importadas (todos los
    # nodos visibles, no solo los ready: la nota puede corregirse en cualquier
    # momento mientras el invoice siga dentro de la ventana del poll).
    refreshed = 0
    try:
        refreshed = await refresh_note_links(nodes)
    except Exception as e:
        logger.warning(f"[printavo] note-link refresh failed: {e}")

    return {"initialized": False, "created": created_total, "refreshed": refreshed,
            "seen": len(nodes), "watermark": watermark}


# ── Final Bill pass ──────────────────────────────────────────────────────────
# Separate lifecycle from creation: an invoice reaches "Final Bill" long after it
# was created, so it is claimed in its OWN collection (printavo_finalized), not
# the create-side printavo_processed. Idempotent: each invoice is applied once.

async def _claim_finalize(invoice_id) -> bool:
    """Atomically claim an invoice for the Final Bill pass (mirrors _claim_invoice).
    Returns True the first time this invoice is finalized, False afterwards."""
    if not invoice_id:
        return False
    try:
        await db.printavo_finalized.insert_one({
            "_id": str(invoice_id),
            "claimed_at": datetime.now(timezone.utc).isoformat(),
        })
        return True
    except DuplicateKeyError:
        return False


async def apply_final_bill(invoice: dict) -> bool:
    """Copy the invoice's billed total and total item count onto the matching MOS
    order (order_number == visualId). Returns True if a live order was found and
    updated, False if no order matched (caller releases the claim so a later tick
    retries once the order is imported)."""
    visual_id = str(invoice.get("visualId") or "").strip()
    if not visual_id:
        return False

    # Base order only: an invoice occasionally splits into visualId, visualId-2…
    # The billed total is a single invoice-level figure, so it lives on the base.
    order = await db.orders.find_one(
        {"order_number": visual_id, "board": {"$ne": TRASH_BOARD}},
        {"_id": 0, "order_id": 1, "order_number": 1, "board": 1,
         "invoice": 1, "total_quantity": 1},
    )
    if not order:
        logger.info(f"[printavo] final-bill {visual_id}: no matching MOS order (yet), skipped")
        return False

    reals = _real_line_items(invoice)
    if len(reals) > 1:
        logger.warning(
            f"[printavo] final-bill {visual_id}: invoice has {len(reals)} garment lines; "
            f"writing invoice-level total + piece count on the base order only")
    total_qty = sum(_billed_qty(li, q) for li, _, q in reals)
    # `total` (what the job was billed for), NOT `amountOutstanding`: the balance
    # drops with every payment, so an invoice already paid when the pass ran would
    # freeze a 0 in the column — and the claim means it is never rewritten.
    try:
        amount = round(float(invoice.get("total") or 0), 2)
    except (TypeError, ValueError):
        amount = 0.0

    now = datetime.now(timezone.utc).isoformat()
    set_fields = {
        "invoice": amount,                # column key for "INVOICE"
        "final_bill_applied_at": now,
        "updated_at": now,
    }
    # Only write Total Quantity when we actually parsed garment pieces. A 0 here
    # means the invoice had no size/color breakdown we could read (seen on some
    # old/large invoices) — writing 0 would be misleading, so leave the column be.
    if total_qty > 0:
        set_fields["total_quantity"] = total_qty  # column key for "Total Quantity"
    else:
        logger.warning(f"[printavo] final-bill {visual_id}: 0 parseable garment lines; "
                       f"writing invoice only, leaving total_quantity untouched")

    await db.orders.update_one({"order_id": order["order_id"]}, {"$set": set_fields})
    logger.info(f"[printavo] final-bill {visual_id}: set invoice={amount}, "
                f"total_quantity={total_qty if total_qty > 0 else '(skipped)'}")
    await _publish_final_bill(order, set_fields)
    return True


async def _publish_final_bill(order: dict, set_fields: dict) -> None:
    """Log the write to the order history and broadcast it.

    The broadcast is NOT cosmetic: routers.orders serves /api/orders from an
    in-memory cache with no TTL that is only cleared by ws_manager.broadcast, so
    without this the board keeps serving the pre-final-bill docs (the INVOICE /
    Total Quantity columns look empty) until some unrelated edit flushes it.
    Failures here must not undo the write, so everything is best-effort.
    """
    from deps import log_activity  # lazy: keeps the module import side-effect free
    from ws_manager import ws_manager

    changed = {k: v for k, v in set_fields.items()
               if k not in ("updated_at", "final_bill_applied_at")}
    try:
        await log_activity(SYNC_USER, "printavo_final_bill", {
            "order_id": order["order_id"],
            "order_number": order.get("order_number"),
            "changed_fields": list(changed.keys()),
            "changes": {k: {"from": order.get(k), "to": v} for k, v in changed.items()},
        })  # sin previous_data a propósito: un undo dejaría la columna vacía y el
            # claim impide que la pasada la vuelva a escribir.
    except Exception as e:
        logger.warning(f"[printavo] final-bill log_activity failed: {e}")
    try:
        await ws_manager.broadcast("order_change", {
            "action": "update",
            "order_id": order["order_id"],
            "boards": [order.get("board")] if order.get("board") else [],
        })
    except Exception as e:
        logger.warning(f"[printavo] final-bill broadcast failed: {e}")


async def finalize_once(cfg: dict, force_apply: bool = False, deep: bool = False) -> dict:
    """Fetch invoices currently in a Final Bill status and apply each to its order.

    First run SEEDS: it claims the invoices already in Final Bill WITHOUT writing,
    so enabling the sync doesn't back-fill the whole billed history in one sweep
    (mirrors sync_once's seeding). New transitions after that are applied normally.

    force_apply=True skips seeding and WRITES even on the first run — used by the
    manual backfill endpoint to fill orders already in Final Bill on demand.

    deep=True walks the WHOLE Final Bill window instead of stopping at the first
    fully-claimed page. The shallow pass is sorted by VISUAL_ID desc, so it only
    sees invoices billed in visual-id order; one that reaches Final Bill late (a
    straggler with enough newer invoices already billed above it) sits below the
    window and would never be applied. The deep sweep is the catch-all — it costs
    one heavy query per page, so the scheduler runs it on its own slow cadence
    (final_bill_deep_every_minutes), not every tick.
    """
    from printavo_client import resolve_status_ids, fetch_invoices_by_status

    names = cfg.get("final_bill_status_names") or DEFAULT_FINAL_BILL_STATUSES
    status_ids = await resolve_status_ids(names)
    if not status_ids:
        logger.warning(f"[printavo] final-bill: no Printavo status matched {names}; pass skipped")
        return {"finalized": 0, "seen": 0, "resolved": False}

    fetch_size = int(cfg.get("final_bill_fetch_size") or 25)
    if deep:
        max_pages = max(1, int(cfg.get("final_bill_deep_pages") or 40))
    else:
        max_pages = max(1, int(cfg.get("final_bill_max_pages") or 5))
    seeding = (not force_apply) and (not cfg.get("final_bill_seeded"))

    finalized = seen = 0
    after = None
    for _ in range(max_pages):
        page = await fetch_invoices_by_status(status_ids, fetch_size, after)
        nodes = page.get("nodes") or []
        seen += len(nodes)
        won = 0  # invoices we processed this page (0 => the page is all previously-seen)
        for node in nodes:
            inv_id = node.get("id")
            # Backfill (force_apply) re-processes every invoice, even ones a prior
            # seed already claimed; the scheduled pass claims-first for idempotency.
            if not force_apply:
                if not await _claim_finalize(inv_id):
                    continue
            won += 1
            if seeding:
                continue  # first run: claim only, don't write history
            try:
                if await apply_final_bill(node):
                    finalized += 1
                    if force_apply:
                        # Mark claimed so the steady-state pass won't re-touch it.
                        try:
                            await db.printavo_finalized.insert_one({
                                "_id": str(inv_id),
                                "claimed_at": datetime.now(timezone.utc).isoformat(),
                            })
                        except DuplicateKeyError:
                            pass
                elif not force_apply:
                    # No order matched yet — release so a later tick can retry.
                    await db.printavo_finalized.delete_one({"_id": str(inv_id)})
            except Exception as e:
                logger.error(f"[printavo] final-bill {node.get('visualId')} failed: {e}")
                if not force_apply:
                    await db.printavo_finalized.delete_one({"_id": str(inv_id)})
        info = page.get("pageInfo") or {}
        # Shallow pass: stop once we hit a page of already-claimed invoices (steady
        # state: new Final Bills float to the top by VISUAL_ID) or run out. The deep
        # sweep keeps going — that's the whole point, the stragglers live below.
        if not info.get("hasNextPage") or (won == 0 and not deep):
            break
        after = info.get("endCursor")

    if seeding:
        await db.printavo_sync.update_one(
            {"config_id": CONFIG_ID}, {"$set": {"final_bill_seeded": True}}, upsert=True
        )
        return {"finalized": 0, "seen": seen, "resolved": True, "seeded": True}
    if force_apply and not cfg.get("final_bill_seeded"):
        # A manual backfill IS the seed: mark it so the scheduled pass runs in
        # steady state (apply new transitions) instead of seeding afterwards.
        await db.printavo_sync.update_one(
            {"config_id": CONFIG_ID}, {"$set": {"final_bill_seeded": True}}, upsert=True
        )
    return {"finalized": finalized, "seen": seen, "resolved": True, "deep": deep}


async def apply_final_bill_by_visual_id(visual_id: str, cfg: dict) -> dict:
    """Force-apply the Final Bill values to ONE order by visualId, ignoring the
    claim so it can be re-run for testing. Returns {found, applied, resolved}."""
    from printavo_client import resolve_status_ids, fetch_invoices_by_status

    vid = str(visual_id).strip()
    if not vid:
        return {"found": False, "applied": False, "resolved": True}
    status_ids = await resolve_status_ids(cfg.get("final_bill_status_names") or DEFAULT_FINAL_BILL_STATUSES)
    if not status_ids:
        return {"found": False, "applied": False, "resolved": False}

    after = None
    for _ in range(40):  # up to 1000 Final Bill invoices deep
        page = await fetch_invoices_by_status(status_ids, 25, after)
        nodes = page.get("nodes") or []
        for node in nodes:
            if str(node.get("visualId") or "").strip() == vid:
                applied = await apply_final_bill(node)
                if applied:
                    await _claim_finalize(node.get("id"))  # keep the steady-state pass off it
                return {"found": True, "applied": bool(applied), "resolved": True}
        info = page.get("pageInfo") or {}
        if not info.get("hasNextPage"):
            break
        after = info.get("endCursor")
    return {"found": False, "applied": False, "resolved": True}
