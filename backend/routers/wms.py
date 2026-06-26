"""WMS (Warehouse Management System) routes."""
from fastapi import APIRouter, HTTPException, Request, Response, UploadFile, File, Query
from typing import Optional
from fastapi.responses import StreamingResponse
from deps import db, get_current_user, require_auth, require_admin, require_supersu, DEFAULT_OPTIONS
from ws_manager import ws_manager
from wms_constants import (
    BoxStatus, TicketStatus, PickingStatus, CycleCountStatus,
    TaskType, TaskStatus, PickDestination, MovementType, AsnStatus,
)
from datetime import datetime, timezone, timedelta
from pymongo import ReturnDocument
import uuid, io, json, logging, re, asyncio

router = APIRouter(prefix="/api/wms")
logger = logging.getLogger(__name__)

# In-process cache for the expensive inventory_summary aggregation in /locations.
# 30s TTL is enough to absorb the burst of N users opening the Ubicaciones screen
# at the same time without serving data that's perceptibly stale.
_LOC_SUMMARY_CACHE = {"data": None, "ts": 0.0}
_LOC_SUMMARY_TTL = 30.0


def now_iso():
    return datetime.now(timezone.utc).isoformat()

def gen_id(prefix="wms"):
    return f"{prefix}_{uuid.uuid4().hex[:12]}"


async def _reserve_box_seqs(n=1):
    """Atomically reserve `n` sequential box sequence numbers; return the FIRST.
    Uses the `counters` collection so two concurrent receivings (or a receiving +
    a move/split) can't mint the same BOX-id — the old read-max-then-+1 race. The
    counter is seeded from the current max at startup (ensure_wms_indexes); the
    guard below re-bases it the first time if that seed somehow didn't run, so a
    freshly-created counter can never hand out ids that collide with existing
    boxes (box_id is also uniquely indexed as a last-resort backstop)."""
    n = max(1, int(n or 1))
    doc = await db.counters.find_one_and_update(
        {"_id": "wms_box_seq"}, {"$inc": {"seq": n}},
        upsert=True, return_document=ReturnDocument.AFTER,
    )
    end = int(doc.get("seq", 0) or 0)
    if end <= n:  # counter was just created near zero — re-base off the real max
        last = await db.wms_boxes.find_one(sort=[("seq_num", -1)], projection={"seq_num": 1})
        base = int((last or {}).get("seq_num", 0) or 0)
        if base >= end:
            doc = await db.counters.find_one_and_update(
                {"_id": "wms_box_seq"}, {"$set": {"seq": base + n}},
                return_document=ReturnDocument.AFTER,
            )
            end = int(doc.get("seq", base + n))
    return end - n + 1


# Canonical name for the warehouse-wide holding location where boxes wait when
# they are received without a final destination. Lives next to the regular
# locations in wms_locations so the rest of the system (Locations module,
# move-location, aggregations) treats it like any other slot.
TRANSIT_LOCATION_NAME = "UBICACION TEMPORAL"

# Physical carts the Receiving operator can choose between when parking boxes
# before putaway. Each cart is a regular wms_location with type="transit" so the
# rest of the system (inventory, movements) treats them like any slot.
# These are just the DEFAULT carts seeded on first boot — admins can create more
# from Putaway 2.0; everything below treats ANY "CARRO <n>" as a cart by pattern.
TRANSIT_CART_NAMES = [f"CARRO {i}" for i in range(1, 51)]

# Every location managed by the Putaway 2.0 module. Legacy UBICACION TEMPORAL
# is kept so boxes received before the carts existed still surface.
SYSTEM_TRANSIT_LOCATIONS = [TRANSIT_LOCATION_NAME] + TRANSIT_CART_NAMES

# A transit slot is the legacy UBICACION TEMPORAL or ANY cart named "CARRO <n>".
# Matching by pattern (not a fixed list) lets admins add carts beyond the seeded
# 50 without code changes — newly created carts work everywhere automatically.
TRANSIT_NAME_REGEX = r"^(UBICACION TEMPORAL|CARRO \d+)$"
_CART_NAME_REGEX = r"^CARRO \d+$"


def _is_transit_name(name):
    return bool(re.match(TRANSIT_NAME_REGEX, (name or "").strip(), re.IGNORECASE))


def _transit_loc_filter():
    """Mongo value-filter matching any transit slot by name pattern."""
    return {"$regex": TRANSIT_NAME_REGEX, "$options": "i"}


async def _list_cart_locations():
    """All cart locations (CARRO <n>) in wms_locations, sorted by cart number."""
    docs = await db.wms_locations.find(
        {"name": {"$regex": _CART_NAME_REGEX, "$options": "i"}},
        {"_id": 0, "name": 1, "location_id": 1},
    ).to_list(5000)

    def _num(d):
        m = re.search(r"(\d+)", d.get("name") or "")
        return int(m.group(1)) if m else 0
    return sorted(docs, key=_num)


async def _ensure_transit_location():
    """Idempotently insert UBICACION TEMPORAL + the carts if they aren't in
    wms_locations yet. Safe to call on every request that may need to write
    there — bulk find + (optional) inserts."""
    existing = await db.wms_locations.find({
        "name": {"$in": SYSTEM_TRANSIT_LOCATIONS}
    }, {"_id": 0}).to_list(None)
    by_name = {l["name"]: l for l in existing}
    to_insert = []
    for name in SYSTEM_TRANSIT_LOCATIONS:
        if name in by_name:
            continue
        doc = {
            "location_id": gen_id("loc"),
            "name": name,
            # Group the carts under a single "CARROS" zone so they're easy to
            # find by zone (e.g. the manual-inventory modal). UBICACION TEMPORAL
            # keeps the generic TRANSIT zone.
            "zone": "CARROS" if name.upper().startswith("CARRO") else "TRANSIT",
            "type": "transit",
            "active": True,
            "is_custom": True,
            "created_at": now_iso(),
        }
        to_insert.append(doc)
        by_name[name] = doc
    if to_insert:
        await db.wms_locations.insert_many(to_insert)
    return by_name[TRANSIT_LOCATION_NAME]

async def log_movement(user, movement_type, details):
    await db.wms_movements.insert_one({
        "movement_id": gen_id("mov"),
        "type": movement_type,
        "details": details,
        "user_id": user.get("user_id"),
        "user_name": user.get("name", user.get("email", "")),
        "created_at": now_iso(),
    })

async def get_sku_movement_history(style: str, color: str = "", size: str = "", limit: int = 200):
    """Return movements that touch a given SKU dimension, newest first.

    wms_movements have heterogeneous shapes — sometimes the SKU is in
    details.sku, sometimes in details.style, sometimes only the box_id
    is present (in which case we resolve via wms_boxes). This handles
    all three.
    """
    # Direct match in details
    or_clauses = [
        {"details.style": {"$regex": f"^{re.escape(style)}$", "$options": "i"}},
        {"details.sku": {"$regex": f"^{re.escape(style)}$", "$options": "i"}},
    ]

    # Indirect match: find boxes with this SKU, then look up movements by their box_id
    box_query = {"style": {"$regex": f"^{re.escape(style)}$", "$options": "i"}}
    if color:
        box_query["color"] = {"$regex": f"^{re.escape(color)}$", "$options": "i"}
    if size:
        box_query["size"] = size
    matching_box_ids = await db.wms_boxes.distinct("box_id", box_query)
    if matching_box_ids:
        or_clauses.append({"details.box_id": {"$in": matching_box_ids}})

    movements = await db.wms_movements.find({"$or": or_clauses}, {"_id": 0}).sort("created_at", -1).to_list(limit)

    # Optional secondary filter on color/size when present in details
    if color or size:
        filtered = []
        for m in movements:
            d = m.get("details", {})
            if color and d.get("color") and d.get("color").lower() != color.lower():
                continue
            if size and d.get("size") and d.get("size") != size:
                continue
            filtered.append(m)
        return filtered
    return movements


@router.get("/inventory/history")
async def inventory_history(request: Request, style: str = "", color: str = "", size: str = "", limit: int = 200):
    """Audit trail for a specific SKU dimension (style + optional color/size)."""
    await require_auth(request)
    if not style:
        raise HTTPException(400, "style requerido")
    movements = await get_sku_movement_history(style, color, size, limit)
    return {"style": style, "color": color, "size": size, "count": len(movements), "movements": movements}


async def notify_badge_change(badge: str = "all"):
    """Tell connected WMS clients that a sidebar badge count may have changed.
    Frontend listens for `wms_badge_changed` and refreshes counts."""
    try:
        await ws_manager.broadcast("wms_badge_changed", {"badge": badge})
    except Exception as e:
        logger.warning(f"Failed to broadcast badge change: {e}")


# ==================== CATALOG OPTIONS (admin-managed dropdown values) ====================

# Receiving identity catalogs (customers/colors/styles) join the original
# descriptive ones. These drive the locked dropdowns in Receiving: operators can
# only pick existing values; only a lead/supervisor may add/rename/clean them.
CATALOG_TYPES = {"descriptions", "countries", "fabrics", "customers", "colors", "styles"}

# Roles allowed to MUTATE catalogs (add / rename / delete / clean). Maps the
# business notion of "líder o supervisor" onto the existing elevated roles —
# change this single set if a dedicated 'supervisor' role is added later.
CATALOG_MANAGER_ROLES = {"admin", "supersu", "ceo"}


def _assert_catalog_manager(user):
    """Raise 403 unless the user is a catalog manager (lead/supervisor)."""
    if (user or {}).get("role") not in CATALOG_MANAGER_ROLES:
        raise HTTPException(
            status_code=403,
            detail="Solo personal líder/supervisor puede modificar los catálogos.",
        )


@router.get("/catalogs")
async def list_catalogs(request: Request):
    """Return admin-curated dropdown values, grouped by type."""
    await require_auth(request)
    docs = await db.wms_catalog_options.find({}, {"_id": 0}).sort([("type", 1), ("value", 1)]).to_list(2000)
    grouped = {t: [] for t in CATALOG_TYPES}
    for d in docs:
        grouped.setdefault(d.get("type"), []).append(d)
    return grouped

@router.post("/catalogs")
async def add_catalog_option(request: Request):
    """Add a value to a catalog. Case-insensitive dedupe per type.
    Restricted to lead/supervisor (catalog manager)."""
    user = await require_auth(request)
    _assert_catalog_manager(user)
    body = await request.json()
    ctype = (body.get("type") or "").strip()
    value = (body.get("value") or "").strip()
    # Styles are scoped per customer (each client has its own valid style list).
    customer = (body.get("customer") or "").strip().upper()
    if ctype not in CATALOG_TYPES:
        raise HTTPException(400, f"type debe ser uno de {sorted(CATALOG_TYPES)}")
    if not value:
        raise HTTPException(400, "value es obligatorio")
    if ctype == "styles" and not customer:
        raise HTTPException(400, "customer es obligatorio para estilos")
    # Case-insensitive dedupe — scoped by customer for styles.
    dedupe = {"type": ctype, "value": {"$regex": f"^{re.escape(value)}$", "$options": "i"}}
    if ctype == "styles":
        dedupe["customer"] = customer
    existing = await db.wms_catalog_options.find_one(dedupe)
    if existing:
        where = f"{ctype} de {customer}" if customer else ctype
        raise HTTPException(400, f"'{value}' ya existe en {where}")
    doc = {
        "catalog_id": gen_id("cat"),
        "type": ctype,
        "value": value,
        "created_at": now_iso(),
        "created_by_name": user.get("name") or user.get("email", ""),
    }
    if customer:
        doc["customer"] = customer
    await db.wms_catalog_options.insert_one(doc)
    doc.pop("_id", None)
    return doc

@router.get("/catalogs/styles")
async def list_customer_styles(request: Request, customer: str = ""):
    """Curated style list for a customer — the locked options shown in Receiving.
    Returns just the style strings, sorted. Empty if the customer has no curated
    styles yet (so Receiving can fall back / show nothing to type-create)."""
    await require_auth(request)
    cust = (customer or "").strip().upper()
    if not cust:
        return {"customer": "", "styles": []}
    docs = await db.wms_catalog_options.find(
        {"type": "styles", "customer": cust}, {"_id": 0, "value": 1}
    ).sort("value", 1).to_list(2000)
    return {"customer": cust, "styles": [d.get("value") for d in docs if d.get("value")]}


@router.delete("/catalogs/{catalog_id}")
async def delete_catalog_option(catalog_id: str, request: Request):
    """Remove a value from a catalog. Does NOT alter existing inventory/receiving rows.
    Restricted to lead/supervisor (catalog manager)."""
    user = await require_auth(request)
    _assert_catalog_manager(user)
    res = await db.wms_catalog_options.delete_one({"catalog_id": catalog_id})
    if res.deleted_count == 0:
        raise HTTPException(404, "Opción no encontrada")
    return {"message": "Opción eliminada"}


# Map catalog type → (collection, field) it sources/normalizes.
_CATALOG_FIELD_MAP = {
    "countries":    ("country_of_origin", ["wms_inventory", "wms_receiving"]),
    "descriptions": ("description",       ["wms_inventory", "wms_receiving"]),
    "fabrics":      ("fabric_content",    ["wms_inventory", "wms_receiving"]),
    # Identity fields also live on the physical boxes, so a rename/clean here must
    # sweep wms_boxes too or the box mirror drifts from inventory (picking matches
    # boxes by style/color).
    "customers":    ("customer", ["wms_inventory", "wms_receiving", "wms_boxes"]),
    "colors":       ("color",    ["wms_inventory", "wms_receiving", "wms_boxes"]),
    "styles":       ("style",    ["wms_inventory", "wms_receiving", "wms_boxes"]),
}


@router.get("/catalogs/{ctype}/sources")
async def list_catalog_sources(ctype: str, request: Request, limit: int = 500):
    """List the distinct values currently present in inventory/receiving for
    the given catalog type, with usage counts. Powers the "Fuentes desde
    inventario" panel in WMS Configuration so admins can see + clean typos."""
    await require_auth(request)
    if ctype not in _CATALOG_FIELD_MAP:
        raise HTTPException(400, f"type debe ser uno de {sorted(_CATALOG_FIELD_MAP)}")
    field, collections = _CATALOG_FIELD_MAP[ctype]

    # Aggregate counts across all source collections (inventory + receiving).
    counts: dict[str, int] = {}
    for coll_name in collections:
        coll = getattr(db, coll_name)
        cursor = coll.aggregate([
            {"$match": {field: {"$ne": None, "$nin": ["", "."]}}},
            {"$group": {"_id": f"${field}", "count": {"$sum": 1}}},
        ])
        async for doc in cursor:
            v = (doc.get("_id") or "").strip()
            if not v:
                continue
            counts[v] = counts.get(v, 0) + int(doc.get("count", 0))

    # Mark which ones are already in the curated catalog so the UI can show a badge.
    curated_docs = await db.wms_catalog_options.find(
        {"type": ctype}, {"_id": 0, "value": 1}
    ).to_list(2000)
    curated_set = {(c.get("value") or "").strip().upper() for c in curated_docs}

    items = [
        {
            "value": v,
            "count": c,
            "in_catalog": v.strip().upper() in curated_set,
        }
        for v, c in counts.items()
    ]
    items.sort(key=lambda x: (-x["count"], x["value"].lower()))
    return {
        "type": ctype,
        "field": field,
        "total_distinct": len(items),
        "items": items[: max(1, min(limit, 5000))],
    }


@router.post("/catalogs/{ctype}/rename")
async def rename_catalog_value(ctype: str, request: Request):
    """Bulk-rename a value across all source collections for a catalog type.
    Example: rename {old: 'BANGLANDESH', new: 'BANGLADESH'} sweeps every
    inventory + receiving row with the typo and fixes it in place.
    Restricted to lead/supervisor (catalog manager)."""
    user = await require_auth(request)
    _assert_catalog_manager(user)
    if ctype not in _CATALOG_FIELD_MAP:
        raise HTTPException(400, f"type debe ser uno de {sorted(_CATALOG_FIELD_MAP)}")
    body = await request.json()
    old = (body.get("old") or "").strip()
    new = (body.get("new") or "").strip()
    if not old or not new:
        raise HTTPException(400, "old y new son requeridos")
    if old == new:
        raise HTTPException(400, "old y new no pueden ser iguales")
    field, collections = _CATALOG_FIELD_MAP[ctype]
    new_upper = new.upper()

    total_matched = 0
    total_modified = 0
    for coll_name in collections:
        coll = getattr(db, coll_name)
        res = await coll.update_many(
            {field: old},
            {"$set": {field: new_upper}},
        )
        total_matched += res.matched_count
        total_modified += res.modified_count

    await log_movement(user, "catalog_rename", {
        "type": ctype, "field": field, "old": old, "new": new_upper,
        "modified": total_modified,
    })
    return {
        "type": ctype, "old": old, "new": new_upper,
        "matched": total_matched, "modified": total_modified,
    }


@router.delete("/catalogs/{ctype}/sources")
async def delete_catalog_value(ctype: str, request: Request):
    """Bulk-clear a value (set to empty) across source collections.
    Useful for purging junk like a stray '%' string.
    Restricted to lead/supervisor (catalog manager)."""
    user = await require_auth(request)
    _assert_catalog_manager(user)
    if ctype not in _CATALOG_FIELD_MAP:
        raise HTTPException(400, f"type debe ser uno de {sorted(_CATALOG_FIELD_MAP)}")
    body = await request.json()
    value = (body.get("value") or "").strip()
    if not value:
        raise HTTPException(400, "value es requerido")
    field, collections = _CATALOG_FIELD_MAP[ctype]

    total_modified = 0
    for coll_name in collections:
        coll = getattr(db, coll_name)
        res = await coll.update_many({field: value}, {"$set": {field: ""}})
        total_modified += res.modified_count

    await log_movement(user, "catalog_value_clear", {
        "type": ctype, "field": field, "value": value, "modified": total_modified,
    })
    return {"value": value, "modified": total_modified}


# ==================== LOCATIONS ====================

# ==================== LOCATION HOLDS (SAT) ====================
# Locations placed on HOLD (e.g. SAT customs hold) must NOT be touched — no
# putaway, picking, moves or edits — until a SUPERUSER releases them. The flag
# lives on the wms_locations doc (on_hold=True) so the Locations module and the
# inventory export can surface/filter it without a second collection.

async def _hold_location_names():
    """UPPERCASE names of every location currently on HOLD."""
    docs = await db.wms_locations.find({"on_hold": True}, {"_id": 0, "name": 1}).to_list(20000)
    return {(d.get("name") or "").strip().upper() for d in docs if d.get("name")}


async def _assert_not_on_hold(user, *locations):
    """Raise 423 if a non-supersu tries to touch a HOLD location. Supersu is the
    only role allowed to move stock in/out of a hold or release it."""
    if (user or {}).get("role") == "supersu":
        return
    wanted = {(l or "").strip().upper() for l in locations if l and str(l).strip()}
    if not wanted:
        return
    held = await db.wms_locations.find_one(
        {"on_hold": True, "name": {"$in": list(wanted)}}, {"_id": 0, "name": 1}
    )
    if held:
        raise HTTPException(
            status_code=423,
            detail=f"Locación {held.get('name')} está en HOLD (SAT) — no se puede tocar hasta que un superusuario la libere.",
        )


@router.get("/location-holds")
async def list_location_holds(request: Request):
    """Read the hold list (any authenticated user — used by the UI badge and the
    export 'exclude hold' option)."""
    await require_auth(request)
    docs = await db.wms_locations.find(
        {"on_hold": True},
        {"_id": 0, "name": 1, "hold_reason": 1, "hold_at": 1, "hold_by_name": 1},
    ).sort("name", 1).to_list(20000)
    return {"count": len(docs), "locations": docs}


@router.post("/location-holds")
async def add_location_holds(request: Request):
    """Place one or more locations on HOLD (supersu only). Body:
    { locations: ["RP09-A03", ...] } or { location: "RP09-A03" }, optional reason."""
    user = await require_supersu(request)
    body = await request.json()
    raw = body.get("locations") or ([body.get("location")] if body.get("location") else [])
    names = sorted({(n or "").strip().upper() for n in raw if (n or "").strip()})
    if not names:
        raise HTTPException(400, "Proporciona al menos una locación")
    reason = (body.get("reason") or "SAT").strip()
    hold_meta = {
        "on_hold": True, "hold_reason": reason, "hold_at": now_iso(),
        "hold_by": user.get("user_id"), "hold_by_name": user.get("name", ""),
    }
    updated, created = 0, 0
    for name in names:
        res = await db.wms_locations.update_one(
            {"name": {"$regex": f"^{re.escape(name)}$", "$options": "i"}},
            {"$set": hold_meta},
        )
        if res.matched_count:
            updated += 1
        else:
            await db.wms_locations.insert_one({
                "location_id": gen_id("loc"), "name": name,
                "zone": name.split("-")[0] if "-" in name else "HOLD",
                "type": "rack", "active": True, "is_custom": False,
                "created_at": now_iso(), **hold_meta,
            })
            created += 1
    await log_movement(user, "location_hold_add", {"count": len(names), "reason": reason})
    return {"status": "ok", "held": len(names), "updated": updated, "created": created}


@router.delete("/location-holds/{name}")
async def release_location_hold(name: str, request: Request):
    """Release a location from HOLD (supersu only)."""
    user = await require_supersu(request)
    clean = (name or "").strip()
    res = await db.wms_locations.update_one(
        {"name": {"$regex": f"^{re.escape(clean)}$", "$options": "i"}},
        {"$set": {"on_hold": False, "hold_released_at": now_iso(),
                  "hold_released_by": user.get("user_id"), "hold_released_by_name": user.get("name", "")}},
    )
    if not res.matched_count:
        raise HTTPException(404, f"Locación {clean} no encontrada")
    await log_movement(user, "location_hold_release", {"location": clean.upper()})
    return {"status": "released", "location": clean.upper()}


@router.post("/locations")
async def create_location(request: Request):
    user = await require_auth(request)
    body = await request.json()
    name = body.get("name", "").strip().upper()
    zone = body.get("zone", "").strip().upper()
    loc_type = body.get("type", "rack")
    if not name:
        raise HTTPException(400, "Nombre de ubicacion requerido")
    
    # Búsqueda insensible a mayúsculas para evitar duplicados como "a1" y "A1"
    existing = await db.wms_locations.find_one({"name": {"$regex": f"^{re.escape(name)}$", "$options": "i"}})
    if existing:
        raise HTTPException(400, f"La ubicación '{name}' ya existe")
        
    loc = {
        "location_id": gen_id("loc"), "name": name, "zone": zone,
        "type": loc_type, "active": True, "created_at": now_iso(),
        "is_custom": True
    }
    await db.wms_locations.insert_one(loc)
    loc.pop("_id", None)
    return loc

@router.get("/locations")
async def list_locations(request: Request, summary: bool = True, skip: int = 0, limit: int = 20000):
    """List locations. Query params:
      - summary=false → skip the expensive inventory aggregation (use for dropdowns)
      - skip / limit  → paginate. Hard-capped at 20000 to prevent runaway
        responses while still fitting the full catalog (NARRO rack adds 6,688
        rows on top of the existing ~3k system slots).
    """
    await require_auth(request)

    skip = max(0, skip)
    limit = max(1, min(limit, 20000))

    locs = await db.wms_locations.find({}, {"_id": 0}).sort("name", 1).skip(skip).limit(limit).to_list(limit)

    if not summary:
        return locs

    import time
    now = time.monotonic()
    cached = _LOC_SUMMARY_CACHE.get("data")
    if cached is not None and (now - _LOC_SUMMARY_CACHE["ts"]) < _LOC_SUMMARY_TTL:
        loc_summary = cached
    else:
        pipeline = [
            {"$match": {"units_on_hand": {"$gt": 0}, "location": {"$nin": [None, ""]}}},
            {"$group": {
                "_id": {"location": "$location", "style": "$style"},
                "style_units": {"$sum": "$units_on_hand"}
            }},
            {"$group": {
                "_id": "$_id.location",
                "total_units": {"$sum": "$style_units"},
                "skus_count": {"$sum": 1},
                "items": {"$push": {"style": {"$ifNull": ["$_id.style", "N/A"]}, "units": "$style_units"}}
            }}
        ]
        cursor = db.wms_inventory.aggregate(pipeline)
        loc_summary = {}
        async for doc in cursor:
            items = sorted(doc["items"], key=lambda x: x["units"], reverse=True)[:5]
            loc_summary[doc["_id"]] = {
                "total_units": doc["total_units"],
                "skus_count": doc["skus_count"],
                "items": items,
            }

        # Transit slots (CARRO <n> + UBICACION TEMPORAL) hold physical boxes that
        # may have NO wms_inventory row yet: stock received straight into a cart,
        # or a ledger row that drifted away while the boxes stayed put. Without
        # this fallback a cart shows "Vacío" here while Putaway counts its boxes
        # (e.g. CARRO 73: 0 inventory rows but 24 cajas). The picker/inventory
        # report already reads boxes for these slots — mirror it. Inventory wins
        # when a row exists for the slot, so we never double-count.
        box_pipeline = [
            {"$match": {"location": _transit_loc_filter(), "units": {"$gt": 0}}},
            {"$group": {
                "_id": {"location": "$location", "style": {"$ifNull": ["$style", "$sku"]}},
                "style_units": {"$sum": "$units"},
            }},
            {"$group": {
                "_id": "$_id.location",
                "total_units": {"$sum": "$style_units"},
                "skus_count": {"$sum": 1},
                "items": {"$push": {"style": {"$ifNull": ["$_id.style", "N/A"]}, "units": "$style_units"}},
            }},
        ]
        async for doc in db.wms_boxes.aggregate(box_pipeline):
            if doc["_id"] in loc_summary:
                continue  # ledger already covers this slot — trust it, don't double-count
            items = sorted(doc["items"], key=lambda x: x["units"], reverse=True)[:5]
            loc_summary[doc["_id"]] = {
                "total_units": doc["total_units"],
                "skus_count": doc["skus_count"],
                "items": items,
            }

        _LOC_SUMMARY_CACHE["data"] = loc_summary
        _LOC_SUMMARY_CACHE["ts"] = now

    for loc in locs:
        loc["inventory_summary"] = loc_summary.get(
            loc["name"], {"total_units": 0, "skus_count": 0, "items": []}
        )

    return locs

@router.post("/move-location")
async def move_location_bulk(request: Request):
    """Move ALL inventory from one location to another in one operation.
    Body: { from: str, to: str }. Both must already exist. Performs:
      1. wms_boxes.update_many({location: from}, {location: to})
      2. wms_inventory: handles duplicate SKUs at the destination by merging
         (sum units_on_hand + units_allocated + total_boxes, delete source row).
      3. Single 'bulk_relocation' movement logged with totals.
    """
    user = await require_auth(request)
    body = await request.json()
    src = (body.get("from") or "").strip().upper()
    dst = (body.get("to") or "").strip().upper()
    if not src or not dst:
        raise HTTPException(400, "from y to son obligatorios")
    if src == dst:
        raise HTTPException(400, "from y to no pueden ser iguales")

    # Both locations must exist
    src_loc = await db.wms_locations.find_one({"name": {"$regex": f"^{re.escape(src)}$", "$options": "i"}})
    dst_loc = await db.wms_locations.find_one({"name": {"$regex": f"^{re.escape(dst)}$", "$options": "i"}})
    if not src_loc:
        raise HTTPException(404, f"Ubicación origen '{src}' no encontrada")
    if not dst_loc:
        raise HTTPException(404, f"Ubicación destino '{dst}' no encontrada. Créala primero.")
    await _assert_not_on_hold(user, src, dst)

    # 1. Bulk move boxes (no merge logic needed; box_id is unique).
    # Capture the moved box ids first so the per-box history (Case# 003) can
    # surface this relocation; update_many only returns a count.
    src_box_filter = {"location": {"$regex": f"^{re.escape(src)}$", "$options": "i"}}
    moved_box_ids = await db.wms_boxes.distinct("box_id", src_box_filter)
    box_res = await db.wms_boxes.update_many(src_box_filter, {"$set": {"location": dst}})
    boxes_moved = box_res.modified_count

    # 2. Inventory: merge per SKU at destination
    src_rows = await db.wms_inventory.find(
        {"location": {"$regex": f"^{re.escape(src)}$", "$options": "i"}, "units_on_hand": {"$gt": 0}}
    ).to_list(5000)
    units_moved = 0
    skus_moved = 0
    for row in src_rows:
        sku = row.get("sku") or row.get("style")
        color = row.get("color", "")
        size = row.get("size", "")
        on_hand = row.get("units_on_hand", 0)
        allocated = row.get("units_allocated", 0)
        boxes_cnt = row.get("total_boxes", 0)

        # Look for existing row at destination
        existing = await db.wms_inventory.find_one({
            "sku": sku, "color": color, "size": size, "location": dst
        })
        if existing:
            await db.wms_inventory.update_one(
                {"_id": existing["_id"]},
                {"$inc": {"units_on_hand": on_hand, "units_allocated": allocated, "total_boxes": boxes_cnt},
                 "$set": {"updated_at": now_iso()}}
            )
            await db.wms_inventory.delete_one({"_id": row["_id"]})
        else:
            await db.wms_inventory.update_one(
                {"_id": row["_id"]},
                {"$set": {"location": dst, "updated_at": now_iso()}}
            )
        units_moved += on_hand
        skus_moved += 1

    await log_movement(user, MovementType.BULK_RELOCATION, {
        "from": src, "to": dst,
        "boxes_moved": boxes_moved,
        "skus_moved": skus_moved,
        "units_moved": units_moved,
        "box_ids": moved_box_ids[:50],  # cap log payload
    })
    await notify_badge_change("all")

    return {
        "message": f"Movidas {skus_moved} SKUs ({units_moved} unidades, {boxes_moved} cajas) de {src} a {dst}",
        "from": src, "to": dst,
        "skus_moved": skus_moved, "units_moved": units_moved, "boxes_moved": boxes_moved,
    }


@router.get("/transit/info")
async def transit_info(request: Request):
    """Tell the frontend the canonical transit location, the cart names and
    how many boxes each one currently holds. Receiving uses this to populate
    its 'Recibir a Carro' dropdown; the Putaway 2.0 module uses it for tabs."""
    await require_auth(request)
    loc = await _ensure_transit_location()

    # Per-location count in a single aggregation. Only count boxes that still
    # hold stock — a box fully picked out (units=0) has left the cart even though
    # the doc lingers for traceability, so it must not inflate the cart count.
    pipeline = [
        {"$match": {"location": _transit_loc_filter(), "units": {"$gt": 0}}},
        {"$group": {"_id": "$location", "n": {"$sum": 1}}},
    ]
    counts = {row["_id"]: row["n"] async for row in db.wms_boxes.aggregate(pipeline)}

    # Carts come from the DB (any "CARRO <n>"), so admin-created carts show up.
    cart_docs = await _list_cart_locations()
    carts = [{
        "name": c["name"],
        "location_id": c.get("location_id"),
        "boxes": counts.get(c["name"], 0),
    } for c in cart_docs]

    return {
        "name": TRANSIT_LOCATION_NAME,
        "location_id": loc.get("location_id"),
        "boxes_in_transit": sum(counts.values()),
        "legacy_boxes": counts.get(TRANSIT_LOCATION_NAME, 0),
        "carts": carts,
    }


@router.get("/transit/boxes")
async def transit_boxes(request: Request, customer: str = "", style: str = "",
                        search: str = "", cart: str = "", limit: int = 1000):
    """List every box currently sitting in a transit slot (the carts +
    legacy UBICACION TEMPORAL). Optional `cart` narrows to a single slot;
    text filters help triage when there are hundreds of pending boxes."""
    await require_auth(request)
    await _ensure_transit_location()

    if cart:
        cart_norm = cart.strip().upper()
        if not _is_transit_name(cart_norm):
            raise HTTPException(400, f"'{cart}' no es una ubicación de tránsito válida")
        query = {"location": cart_norm}
    else:
        query = {"location": _transit_loc_filter()}
    # Hide boxes that have been fully picked out (units=0) — they've physically
    # left the cart; the doc only survives for traceability.
    query["units"] = {"$gt": 0}
    if customer:
        query["customer"] = {"$regex": re.escape(customer), "$options": "i"}
    if style:
        query["style"] = {"$regex": re.escape(style), "$options": "i"}
    if search:
        # Free-text search across the most useful fields.
        rx = {"$regex": re.escape(search), "$options": "i"}
        query["$or"] = [
            {"box_id": rx}, {"sku": rx}, {"style": rx}, {"color": rx},
            {"description": rx}, {"customer": rx}, {"manufacturer": rx},
        ]
    boxes = await db.wms_boxes.find(query, {"_id": 0}).sort("created_at", 1).to_list(limit)
    cart_names = [c["name"] for c in await _list_cart_locations()]
    return {
        "transit_location": TRANSIT_LOCATION_NAME,
        "transit_locations": [TRANSIT_LOCATION_NAME] + cart_names,
        "carts": cart_names,
        "count": len(boxes),
        "boxes": boxes,
    }


@router.post("/transit/relocate")
async def transit_relocate(request: Request):
    """Move specific boxes out of UBICACION TEMPORAL into a real warehouse slot.

    Body: { box_ids: [str, ...], to: str }
    - box_ids must currently live at the transit location (silently skipped
      otherwise so concurrent moves don't error out).
    - `to` must be an existing wms_location.
    - Updates each box's location, decrements/clears the transit inventory
      row(s) and increments (or creates) the destination inventory row(s).
    - Logs a single transit_relocation movement with a summary.
    """
    user = await require_auth(request)
    body = await request.json()
    box_ids = body.get("box_ids") or []
    dst = (body.get("to") or "").strip().upper()
    if not box_ids:
        raise HTTPException(400, "box_ids es obligatorio")
    if not dst:
        raise HTTPException(400, "to es obligatorio")
    if _is_transit_name(dst):
        raise HTTPException(400, "El destino no puede ser una ubicación de tránsito (carro / temporal)")

    dst_loc = await db.wms_locations.find_one(
        {"name": {"$regex": f"^{re.escape(dst)}$", "$options": "i"}}
    )
    if not dst_loc:
        raise HTTPException(404, f"Ubicación destino '{dst}' no encontrada. Créala primero.")
    dst_name = dst_loc.get("name", dst)
    await _assert_not_on_hold(user, dst_name)

    # Pull the boxes that ACTUALLY are in any transit slot right now (5 carts
    # + legacy UBICACION TEMPORAL).
    boxes = await db.wms_boxes.find(
        {"box_id": {"$in": box_ids}, "location": _transit_loc_filter()},
        {"_id": 0},
    ).to_list(len(box_ids))
    if not boxes:
        return {
            "message": "Ninguna de las cajas indicadas está en una ubicación de tránsito.",
            "moved": 0, "units_moved": 0, "to": dst_name,
        }

    # 1. Move the boxes in one shot.
    moved_ids = [b["box_id"] for b in boxes]
    await db.wms_boxes.update_many(
        {"box_id": {"$in": moved_ids}},
        {"$set": {"location": dst_name, "state": "located", "status": "located"}},
    )

    # 2. Aggregate units per (source_location, sku, color, size) — each box's
    # source location matters because inventory rows are keyed per-location.
    from collections import defaultdict
    bucket = defaultdict(lambda: {"units": 0, "boxes": 0, "sample": None})
    for b in boxes:
        key = (
            b.get("location") or TRANSIT_LOCATION_NAME,
            b.get("sku") or b.get("style") or "",
            b.get("color", ""),
            b.get("size", ""),
        )
        bucket[key]["units"] += int(b.get("units") or b.get("qty") or 0)
        bucket[key]["boxes"] += 1
        if bucket[key]["sample"] is None:
            bucket[key]["sample"] = b

    units_moved = 0
    skus_moved = 0
    sources_set = set()
    for (src_location, sku, color, size), agg in bucket.items():
        units = agg["units"]
        boxes_cnt = agg["boxes"]
        sample = agg["sample"] or {}
        units_moved += units
        skus_moved += 1
        sources_set.add(src_location)

        # Decrement the source inventory row (or delete it if it would go to 0).
        src_inv = await db.wms_inventory.find_one({
            "sku": sku, "color": color, "size": size, "location": src_location,
        })
        if src_inv:
            new_on_hand = max(0, int(src_inv.get("units_on_hand", 0)) - units)
            new_total_boxes = max(0, int(src_inv.get("total_boxes", 0)) - boxes_cnt)
            if new_on_hand == 0 and new_total_boxes == 0:
                await db.wms_inventory.delete_one({"_id": src_inv["_id"]})
            else:
                await db.wms_inventory.update_one(
                    {"_id": src_inv["_id"]},
                    {"$set": {
                        "units_on_hand": new_on_hand,
                        "total_boxes": new_total_boxes,
                        "updated_at": now_iso(),
                    }},
                )

        # Increment (or create) the destination inventory row.
        dst_inv = await db.wms_inventory.find_one({
            "sku": sku, "color": color, "size": size, "location": dst_name,
        })
        if dst_inv:
            await db.wms_inventory.update_one(
                {"_id": dst_inv["_id"]},
                {"$inc": {"units_on_hand": units, "total_boxes": boxes_cnt},
                 "$set": {"updated_at": now_iso()}},
            )
        else:
            await db.wms_inventory.insert_one({
                "inventory_id": gen_id("inv"),
                "sku": sku,
                "style": sample.get("style") or sku,
                "color": color,
                "size": size,
                "customer": sample.get("customer", ""),
                "manufacturer": sample.get("manufacturer", ""),
                "description": sample.get("description", ""),
                "country_of_origin": sample.get("country_of_origin", "") or sample.get("coo", ""),
                "fabric_content": sample.get("fabric_content", ""),
                "location": dst_name,
                "total_boxes": boxes_cnt,
                "units_on_hand": units,
                "units_allocated": 0,
                "updated_at": now_iso(),
            })

    await log_movement(user, MovementType.TRANSIT_RELOCATION, {
        "to": dst_name,
        "from_sources": sorted(sources_set),
        "boxes_moved": len(moved_ids),
        "skus_moved": skus_moved,
        "units_moved": units_moved,
        "box_ids": moved_ids[:50],  # cap log payload
    })
    await notify_badge_change("all")

    return {
        "message": f"Movidas {len(moved_ids)} cajas ({units_moved} unidades, {skus_moved} SKUs) a {dst_name}",
        "moved": len(moved_ids),
        "units_moved": units_moved,
        "skus_moved": skus_moved,
        "to": dst_name,
    }


@router.post("/boxes/relocate")
async def boxes_relocate(request: Request):
    """Generic per-box relocation. Unlike /transit/relocate, doesn't restrict
    the source location — works from any source to any destination. Used by
    the Locations detail modal to let an admin pick individual LPNs out of a
    bin and ship them elsewhere.

    Body: { box_ids: [str, ...], to: str }
    """
    user = await require_auth(request)
    body = await request.json()
    box_ids = body.get("box_ids") or []
    dst = (body.get("to") or "").strip().upper()
    if not box_ids:
        raise HTTPException(400, "box_ids es obligatorio")
    if not dst:
        raise HTTPException(400, "to es obligatorio")

    dst_loc = await db.wms_locations.find_one(
        {"name": {"$regex": f"^{re.escape(dst)}$", "$options": "i"}}
    )
    if not dst_loc:
        raise HTTPException(404, f"Ubicación destino '{dst}' no encontrada. Créala primero.")
    dst_name = dst_loc.get("name", dst)

    # Load the boxes; silently skip those already at the destination so
    # accidental double-clicks don't error out.
    boxes_raw = await db.wms_boxes.find(
        {"box_id": {"$in": box_ids}}, {"_id": 0},
    ).to_list(len(box_ids))
    boxes = [b for b in boxes_raw if (b.get("location") or "").upper() != dst_name.upper()]
    if not boxes:
        return {
            "message": "Las cajas seleccionadas ya están en la ubicación destino.",
            "moved": 0, "units_moved": 0, "skus_moved": 0, "to": dst_name,
        }

    # 1. Bulk update box locations.
    moved_ids = [b["box_id"] for b in boxes]
    await db.wms_boxes.update_many(
        {"box_id": {"$in": moved_ids}},
        {"$set": {"location": dst_name, "state": "located", "status": "located"}},
    )

    # 2. Rebalance inventory: bucket by (source_location, sku, color, size) so
    #    moves spanning multiple source bins still decrement the right rows.
    from collections import defaultdict
    bucket = defaultdict(lambda: {"units": 0, "boxes": 0, "sample": None})
    for b in boxes:
        src = (b.get("location") or "")
        key = (src, b.get("sku") or b.get("style") or "", b.get("color", ""), b.get("size", ""))
        bucket[key]["units"] += int(b.get("units") or b.get("qty") or 0)
        bucket[key]["boxes"] += 1
        if bucket[key]["sample"] is None:
            bucket[key]["sample"] = b

    units_moved = 0
    skus_moved = 0
    sources_touched = set()
    for (src, sku, color, size), agg in bucket.items():
        units = agg["units"]
        boxes_cnt = agg["boxes"]
        sample = agg["sample"] or {}
        units_moved += units
        skus_moved += 1
        if src:
            sources_touched.add(src)

        # Decrement the source inventory row (delete if it would hit 0/0).
        if src:
            src_inv = await db.wms_inventory.find_one({
                "sku": sku, "color": color, "size": size, "location": src,
            })
            if src_inv:
                new_on_hand = max(0, int(src_inv.get("units_on_hand", 0)) - units)
                new_total_boxes = max(0, int(src_inv.get("total_boxes", 0)) - boxes_cnt)
                if new_on_hand == 0 and new_total_boxes == 0:
                    await db.wms_inventory.delete_one({"_id": src_inv["_id"]})
                else:
                    await db.wms_inventory.update_one(
                        {"_id": src_inv["_id"]},
                        {"$set": {
                            "units_on_hand": new_on_hand,
                            "total_boxes": new_total_boxes,
                            "updated_at": now_iso(),
                        }},
                    )

        # Increment (or create) the destination inventory row.
        dst_inv = await db.wms_inventory.find_one({
            "sku": sku, "color": color, "size": size, "location": dst_name,
        })
        if dst_inv:
            await db.wms_inventory.update_one(
                {"_id": dst_inv["_id"]},
                {"$inc": {"units_on_hand": units, "total_boxes": boxes_cnt},
                 "$set": {"updated_at": now_iso()}},
            )
        else:
            await db.wms_inventory.insert_one({
                "inventory_id": gen_id("inv"),
                "sku": sku,
                "style": sample.get("style") or sku,
                "color": color,
                "size": size,
                "customer": sample.get("customer", ""),
                "manufacturer": sample.get("manufacturer", ""),
                "description": sample.get("description", ""),
                "country_of_origin": sample.get("country_of_origin", "") or sample.get("coo", ""),
                "fabric_content": sample.get("fabric_content", ""),
                "location": dst_name,
                "total_boxes": boxes_cnt,
                "units_on_hand": units,
                "units_allocated": 0,
                "updated_at": now_iso(),
            })

    # Use the transit movement type when EVERY source was a transit slot
    # (cart or legacy UBICACION TEMPORAL), so the Movements module surfaces it
    # under the same bucket as /transit/relocate.
    move_type = (
        MovementType.TRANSIT_RELOCATION
        if sources_touched and all(_is_transit_name(s) for s in sources_touched)
        else MovementType.BULK_RELOCATION
    )
    await log_movement(user, move_type, {
        "to": dst_name,
        "sources": sorted(sources_touched),
        "boxes_moved": len(moved_ids),
        "skus_moved": skus_moved,
        "units_moved": units_moved,
        "box_ids": moved_ids[:50],  # cap log payload
    })
    await notify_badge_change("all")

    return {
        "message": f"Movidas {len(moved_ids)} cajas ({units_moved} unidades) a {dst_name}",
        "moved": len(moved_ids),
        "units_moved": units_moved,
        "skus_moved": skus_moved,
        "to": dst_name,
    }


@router.post("/move-units")
async def move_units(request: Request):
    """Move a partial quantity of ONE sku/color/size from one location to another
    — the picker 'Mover > Unidades (consolidar)' flow. Consumes source boxes FIFO:
    a box taken in full is relocated, a box taken in part is split (source box
    reduced, a fresh box created at the destination). Inventory rows are kept in
    lockstep with the physical boxes the whole way so the two never drift."""
    user = await require_auth(request)
    body = await request.json()
    src = (body.get("from") or "").strip().upper()
    dst = (body.get("to") or "").strip().upper()
    sku = (body.get("sku") or body.get("style") or "").strip()
    color = (body.get("color") or "").strip()
    size = (body.get("size") or "").strip()
    try:
        units = int(body.get("units") or 0)
    except (TypeError, ValueError):
        raise HTTPException(400, "Cantidad (units) inválida")

    if not src or not dst:
        raise HTTPException(400, "Ubicación origen y destino son obligatorias")
    if src == dst:
        raise HTTPException(400, "El origen y el destino no pueden ser iguales")
    if not sku:
        raise HTTPException(400, "SKU/Style es obligatorio")
    if units <= 0:
        raise HTTPException(400, "La cantidad debe ser mayor a 0")

    dst_loc = await db.wms_locations.find_one(
        {"name": {"$regex": f"^{re.escape(dst)}$", "$options": "i"}}
    )
    if not dst_loc:
        raise HTTPException(404, f"Ubicación destino '{dst}' no encontrada. Créala primero.")
    dst_name = dst_loc.get("name", dst)
    await _assert_not_on_hold(user, src, dst_name)

    # Block oversell: can't move more than what's physically at the source
    # (reuses the same availability check as picking — boxes OR inventory row).
    avail = await _available_units(sku, color, size, src)
    if units > avail:
        raise HTTPException(409, f"No hay suficiente en {src}: pides {units}, disponible {avail}")

    # Consume source boxes FIFO.
    q = {
        "$or": [{"sku": sku}, {"style": sku}], "color": color, "size": size,
        "location": {"$regex": f"^{re.escape(src)}$", "$options": "i"},
        "units": {"$gt": 0},
    }
    boxes = await db.wms_boxes.find(q).sort("created_at", 1).to_list(1000)
    sample = boxes[0] if boxes else {}
    remaining = units
    whole_count = 0   # boxes that left the source entirely
    split_count = 0   # boxes split → a new partial box created at the destination
    moved_box_ids = []  # every box touched (whole + shrunk source + split child) for box history
    next_seq = None

    for box in boxes:
        if remaining <= 0:
            break
        b_qty = int((box.get("units") if box.get("units") is not None else box.get("qty", 0)) or 0)
        if b_qty <= 0:
            continue
        take = min(b_qty, remaining)
        if take >= b_qty:
            # Whole box relocates to the destination.
            await db.wms_boxes.update_one(
                {"_id": box["_id"]},
                {"$set": {"location": dst_name, "status": "stored"}},
            )
            whole_count += 1
            moved_box_ids.append(box.get("box_id"))
        else:
            # Partial: shrink the source box, create a fresh box at the destination.
            await db.wms_boxes.update_one(
                {"_id": box["_id"]},
                {"$set": {"units": b_qty - take, "qty": b_qty - take}},
            )
            next_seq = await _reserve_box_seqs(1)
            new_box_id = f"BOX-{next_seq:06d}"
            child = {k: v for k, v in box.items() if k != "_id"}
            child.update({
                "box_id": new_box_id, "barcode": new_box_id, "lpn_id": new_box_id,
                "seq_num": next_seq, "location": dst_name,
                "units": take, "qty": take, "status": "stored",
                "split_from": box.get("box_id"), "created_at": now_iso(),
            })
            child.pop("inventory_id", None)
            await db.wms_boxes.insert_one(child)
            split_count += 1
            moved_box_ids.extend([box.get("box_id"), new_box_id])
        remaining -= take

    # Inventory lockstep: decrement the source row by the full requested units and
    # by the boxes that physically left it; increment/create the destination row by
    # the units and every box that arrived there (whole + split).
    boxes_added = whole_count + split_count
    src_inv = await db.wms_inventory.find_one(
        {"sku": sku, "color": color, "size": size,
         "location": {"$regex": f"^{re.escape(src)}$", "$options": "i"}}
    ) or await db.wms_inventory.find_one(
        {"style": {"$regex": f"^{re.escape(sku)}$", "$options": "i"},
         "color": color, "size": size,
         "location": {"$regex": f"^{re.escape(src)}$", "$options": "i"}}
    )
    if src_inv:
        # Atomic decrement-and-clamp (same race-free pattern as the picking fix):
        # one document op so concurrent moves from the same row can't lose an
        # update or drive stock negative.
        updated = await db.wms_inventory.find_one_and_update(
            {"_id": src_inv["_id"]},
            [{"$set": {
                "units_on_hand": {"$max": [0, {"$subtract": [{"$ifNull": ["$units_on_hand", 0]}, units]}]},
                "total_boxes": {"$max": [0, {"$subtract": [{"$ifNull": ["$total_boxes", 0]}, whole_count]}]},
                "updated_at": now_iso(),
            }}],
            return_document=ReturnDocument.AFTER,
        )
        # Drop the row only once it is fully empty (no units, no boxes, nothing reserved).
        if (updated and int(updated.get("units_on_hand", 0) or 0) <= 0
                and int(updated.get("total_boxes", 0) or 0) <= 0
                and int(updated.get("units_allocated", 0) or 0) <= 0):
            await db.wms_inventory.delete_one({"_id": src_inv["_id"]})

    dst_inv = await db.wms_inventory.find_one(
        {"sku": sku, "color": color, "size": size, "location": dst_name}
    )
    if dst_inv:
        await db.wms_inventory.update_one(
            {"_id": dst_inv["_id"]},
            {"$inc": {"units_on_hand": units, "total_boxes": boxes_added},
             "$set": {"updated_at": now_iso()}},
        )
    else:
        await db.wms_inventory.insert_one({
            "inventory_id": gen_id("inv"),
            "sku": sku, "style": sample.get("style") or sku,
            "color": color, "size": size,
            "customer": sample.get("customer", ""),
            "manufacturer": sample.get("manufacturer", ""),
            "description": sample.get("description", ""),
            "country_of_origin": sample.get("country_of_origin", "") or sample.get("coo", ""),
            "fabric_content": sample.get("fabric_content", ""),
            "location": dst_name, "total_boxes": boxes_added,
            "units_on_hand": units, "units_allocated": 0, "updated_at": now_iso(),
        })

    await log_movement(user, MovementType.BULK_RELOCATION, {
        "from": src, "to": dst_name, "sku": sku, "color": color, "size": size,
        "units_moved": units, "boxes_relocated": whole_count, "boxes_split": split_count,
        "box_ids": [b for b in moved_box_ids if b][:50],  # cap log payload
    })
    await notify_badge_change("all")
    return {
        "message": f"Movidas {units} unidades de {sku} de {src} a {dst_name}",
        "from": src, "to": dst_name, "units_moved": units,
        "boxes_relocated": whole_count, "boxes_split": split_count,
    }


@router.post("/boxes/reconcile-lpn")
async def reconcile_lpn(request: Request):
    """Reconcile a migrated 'generic' LPN box with the box's REAL physical license
    plate, on the fly during a relocation.

    The bulk Excel import minted one box per case with a synthetic id
    (`LPN_xxxx`) — that id is never printed on the carton, which still carries its
    pre-WMS label (e.g. barcode A2600510001). So the operator can't scan the
    generic id; instead they identify the box by Location + Product, then scan the
    physical LPN to stamp it onto the box. 1:1, no split: exactly one pending
    generic box of that product at that location is matched, its barcode/lpn_id is
    set to the physical LPN, its quantity is corrected to the real count, and it is
    moved to the destination slot. The internal `box_id` is deliberately left
    untouched so nothing that references it (tasks, movements, splits) breaks —
    scanning the physical LPN resolves via the barcode/lpn_id fallback in get_box.

    Body: { location, sku|style, color, size, physical_lpn, units, destination }
    """
    user = await require_auth(request)
    body = await request.json()
    location = (body.get("location") or "").strip()
    sku = (body.get("sku") or body.get("style") or "").strip()
    color = (body.get("color") or "").strip()
    size = (body.get("size") or "").strip()
    physical_lpn = (body.get("physical_lpn") or "").strip().upper()
    destination = (body.get("destination") or "").strip()
    try:
        units = int(body.get("units") or 0)
    except (TypeError, ValueError):
        raise HTTPException(400, "Cantidad (units) inválida")

    if not location:
        raise HTTPException(400, "Ubicación de origen es obligatoria")
    if not sku:
        raise HTTPException(400, "SKU/Style es obligatorio")
    if not physical_lpn:
        raise HTTPException(400, "El LPN físico es obligatorio")
    if not destination:
        raise HTTPException(400, "Ubicación de destino es obligatoria")
    if units <= 0:
        raise HTTPException(400, "La cantidad debe ser mayor a 0")

    # Destination must exist (same rule as the other relocate endpoints).
    dst_loc = await db.wms_locations.find_one(
        {"name": {"$regex": f"^{re.escape(destination)}$", "$options": "i"}}
    )
    if not dst_loc:
        raise HTTPException(404, f"Ubicación destino '{destination}' no encontrada. Créala primero.")
    dst_name = dst_loc.get("name", destination)
    await _assert_not_on_hold(user, location, dst_name)

    # Guard: a physical LPN must be unique — never collide with an existing
    # box_id/barcode/lpn_id on a DIFFERENT box (a double-reconcile or a typo).
    clash = await db.wms_boxes.find_one(
        {"$or": [{"box_id": physical_lpn}, {"barcode": physical_lpn}, {"lpn_id": physical_lpn}]},
        {"_id": 0, "box_id": 1, "lpn_id": 1},
    )
    if clash:
        raise HTTPException(
            409,
            f"El LPN físico '{physical_lpn}' ya está en uso por la caja {clash.get('box_id')}.",
        )

    # Find ONE pending generic box of this product still sitting at the origin.
    # 'Generic' = a synthetic import id (the migration mints either "LPN_<uuid>" or
    # "LPN<uuid>" — no underscore — so match "^LPN") that hasn't been reconciled yet.
    candidate = await db.wms_boxes.find_one(
        {
            "$or": [{"sku": _ci_eq(sku)}, {"style": _ci_eq(sku)}],
            "color": _ci_eq(color), "size": _ci_eq(size),
            "location": _ci_eq(location),
            "box_id": {"$regex": "^LPN", "$options": "i"},
            "lpn_reconciled_at": {"$exists": False},
            "units": {"$gt": 0},
        },
        sort=[("created_at", 1)],
    )
    if not candidate:
        raise HTTPException(
            404,
            f"No hay caja genérica pendiente de {sku} {color} {size} en {location}.",
        )

    box_id = candidate["box_id"]
    old_units = int(
        candidate.get("units") if candidate.get("units") is not None else candidate.get("qty", 0) or 0
    )

    # 1. Decrement the SOURCE inventory row by the box's CURRENT units + 1 box.
    #    Match on sku first, then fall back to style (Excel rows can carry the real
    #    value in `style` with sku missing/"None"). Drop the row only if it empties.
    src_inv = await db.wms_inventory.find_one(
        {"sku": sku, "color": color, "size": size,
         "location": {"$regex": f"^{re.escape(location)}$", "$options": "i"}}
    ) or await db.wms_inventory.find_one(
        {"style": {"$regex": f"^{re.escape(sku)}$", "$options": "i"},
         "color": color, "size": size,
         "location": {"$regex": f"^{re.escape(location)}$", "$options": "i"}}
    )
    if src_inv:
        new_on_hand = max(0, int(src_inv.get("units_on_hand", 0)) - old_units)
        new_total_boxes = max(0, int(src_inv.get("total_boxes", 0) or 0) - 1)
        if (new_on_hand == 0 and new_total_boxes == 0
                and int(src_inv.get("units_allocated", 0) or 0) <= 0):
            await db.wms_inventory.delete_one({"_id": src_inv["_id"]})
        else:
            await db.wms_inventory.update_one(
                {"_id": src_inv["_id"]},
                {"$set": {"units_on_hand": new_on_hand, "total_boxes": new_total_boxes,
                          "updated_at": now_iso()}},
            )

    # 2. Stamp the physical LPN onto the box, correct its qty, move it. box_id stays.
    await db.wms_boxes.update_one(
        {"_id": candidate["_id"]},
        {"$set": {
            "barcode": physical_lpn,
            "lpn_id": physical_lpn,
            "units": units,
            "qty": units,
            "location": dst_name,
            "status": "stored",
            "state": "located",
            "generic_lpn": box_id,            # remember the synthetic id we replaced
            "lpn_reconciled_at": now_iso(),
            "lpn_reconciled_by": user.get("user_id"),
            "updated_at": now_iso(),
        }},
    )

    # 3. Increment (or create) the DESTINATION inventory row by the NEW units + 1 box.
    dst_inv = await db.wms_inventory.find_one(
        {"sku": sku, "color": color, "size": size, "location": dst_name}
    )
    if dst_inv:
        await db.wms_inventory.update_one(
            {"_id": dst_inv["_id"]},
            {"$inc": {"units_on_hand": units, "total_boxes": 1},
             "$set": {"updated_at": now_iso()}},
        )
    else:
        await db.wms_inventory.insert_one({
            "inventory_id": gen_id("inv"),
            "sku": sku,
            "style": candidate.get("style") or sku,
            "color": color,
            "size": size,
            "customer": candidate.get("customer", ""),
            "manufacturer": candidate.get("manufacturer", ""),
            "description": candidate.get("description", ""),
            "country_of_origin": candidate.get("country_of_origin", "") or candidate.get("coo", ""),
            "fabric_content": candidate.get("fabric_content", ""),
            "location": dst_name,
            "total_boxes": 1,
            "units_on_hand": units,
            "units_allocated": 0,
            "updated_at": now_iso(),
        })

    # 4. Audit trail.
    await log_movement(user, MovementType.LPN_RECONCILED, {
        "box_id": box_id,
        "generic_lpn": box_id,
        "physical_lpn": physical_lpn,
        "sku": sku, "color": color, "size": size,
        "from": location, "to": dst_name,
        "old_units": old_units, "new_units": units, "delta_units": units - old_units,
    })
    await notify_badge_change("all")

    return {
        "message": f"LPN {physical_lpn} casado ({units} u) y movido a {dst_name}",
        "box_id": box_id,
        "physical_lpn": physical_lpn,
        "from": location, "to": dst_name,
        "units": units, "old_units": old_units,
    }


@router.delete("/locations/{location_id}")
async def delete_location(location_id: str, request: Request, force: bool = False):
    """Delete a location. Two guards:
      1. System-protected slots (the canonical UBICACION TEMPORAL) can never
         be deleted — they're hard-wired to other modules (En Tránsito flow,
         Receiving "Recibir a Temporal" button) so removing them silently
         breaks those features.
      2. Regular slots are blocked when the bin still has boxes or inventory
         rows pointing to it — otherwise the operator orphans stock that
         can't be surfaced anywhere in the UI. Pass `?force=true` to
         override this second guard (advanced; doesn't bypass #1)."""
    await require_auth(request)
    loc = await db.wms_locations.find_one({"location_id": location_id})
    if not loc:
        raise HTTPException(404, "Ubicacion no encontrada")
    name = loc.get("name") or ""

    # Guard 1 — system-protected locations are off-limits, even with force.
    if _is_transit_name(name):
        raise HTTPException(
            status_code=403,
            detail=(
                f"'{name}' es una ubicación del sistema (módulo Putaway 2.0) "
                "y no se puede eliminar."
            ),
        )

    # Guard 2 — stock-bearing bins are blocked unless ?force=true is passed.
    if not force:
        n_boxes = await db.wms_boxes.count_documents({"location": name})
        n_inv = await db.wms_inventory.count_documents({
            "location": name, "units_on_hand": {"$gt": 0},
        })
        if n_boxes or n_inv:
            raise HTTPException(
                status_code=409,
                detail=(
                    f"'{name}' tiene contenido: {n_boxes} cajas / {n_inv} líneas con stock. "
                    "Vácila primero (Mover) o pasa ?force=true para forzar."
                ),
            )

    result = await db.wms_locations.delete_one({"location_id": location_id})
    if result.deleted_count == 0:
        raise HTTPException(404, "Ubicacion no encontrada")
    return {"message": f"Ubicacion '{name}' eliminada"}

@router.put("/locations/{location_id}")
async def update_location(location_id: str, request: Request):
    user = await require_auth(request)
    body = await request.json()
    new_name = body.get("name", "").strip().upper()
    new_zone = body.get("zone", "").strip().upper()

    existing_loc = await db.wms_locations.find_one({"location_id": location_id})
    if not existing_loc:
        raise HTTPException(404, "Ubicación no encontrada")

    old_name = existing_loc.get("name")

    # System-protected: the canonical transit slot and the 5 carts cannot be
    # renamed because the Putaway 2.0 module + Receiving "Recibir a Carro"
    # button look them up by exact string match.
    if _is_transit_name(old_name) and new_name and new_name != old_name:
        raise HTTPException(
            status_code=403,
            detail=(
                f"'{old_name}' es una ubicación del sistema (módulo Putaway 2.0) "
                "y no se puede renombrar."
            ),
        )

    update_doc = {}
    if new_name:
        if new_name != old_name:
            dup = await db.wms_locations.find_one({"name": {"$regex": f"^{re.escape(new_name)}$", "$options": "i"}, "location_id": {"$ne": location_id}})
            if dup:
                raise HTTPException(400, f"La ubicación '{new_name}' ya existe")
            update_doc["name"] = new_name
    if new_zone:
        update_doc["zone"] = new_zone
        
    if update_doc:
        await db.wms_locations.update_one({"location_id": location_id}, {"$set": update_doc})
        if "name" in update_doc:
            await db.wms_inventory.update_many({"location": old_name}, {"$set": {"location": new_name}})
            await db.wms_boxes.update_many({"location": old_name}, {"$set": {"location": new_name}})
            await log_movement(user, "location_renamed", {"old_name": old_name, "new_name": new_name})
            
    updated_loc = await db.wms_locations.find_one({"location_id": location_id}, {"_id": 0})
    return updated_loc

@router.get("/locations/print")
async def print_locations(request: Request, ids: str = "all", zone: str = ""):
    """Generate a PDF for Zebra Label Printers (4x2 inch) for WMS locations.
    Selection precedence (first match wins):
      - zone=X   → all locations in that zone
      - ids=A,B  → explicit list of location_ids
      - ids=all  → every location (default)
    """
    await require_auth(request)

    from reportlab.lib.pagesizes import landscape
    from reportlab.lib.units import inch
    from reportlab.pdfgen import canvas
    from reportlab.graphics.barcode import code128
    from reportlab.graphics.shapes import Drawing
    from reportlab.graphics import renderPDF

    # 1. Fetch locations
    if zone:
        zone_query = {"zone": {"$regex": f"^{re.escape(zone)}$", "$options": "i"}}
        locs = await db.wms_locations.find(zone_query, {"_id": 0}).sort("name", 1).to_list(3000)
    elif ids == "all":
        locs = await db.wms_locations.find({}, {"_id": 0}).sort("name", 1).to_list(3000)
    else:
        id_list = ids.split(",")
        locs = await db.wms_locations.find({"location_id": {"$in": id_list}}, {"_id": 0}).sort("name", 1).to_list(3000)

    if not locs:
        raise HTTPException(404, "No se encontraron ubicaciones para imprimir")

    # 2. Create PDF buffer
    buffer = io.BytesIO()
    # Zebra labels are usually 4x2 inches
    label_width = 4 * inch
    label_height = 2 * inch
    c = canvas.Canvas(buffer, pagesize=(label_width, label_height))

    for loc in locs:
        name = loc.get("name", "N/A").upper()
        zone = loc.get("zone", "N/A").upper()
        
        # Draw Location Name (Large)
        c.setFont("Helvetica-Bold", 45)
        c.drawCentredString(label_width / 2, label_height - 50, name)
        
        # Draw Zone (Small)
        c.setFont("Helvetica", 12)
        c.drawCentredString(label_width / 2, label_height - 75, f"ZONA: {zone}")
        
        # Draw Barcode (Code128)
        try:
            # Code128 widget from reportlab.graphics.barcode
            barcode = code128.Code128(name, barHeight=0.5*inch, barWidth=1.0)
            
            # Center the barcode
            x_pos = (label_width - barcode.width) / 2
            
            # Draw directly to canvas (Y position lowered to 15 to avoid overlap)
            barcode.drawOn(c, x_pos, 15)
        except Exception as e:
            logger.error(f"Error generating barcode for {name}: {e}")
            c.setFont("Helvetica-Oblique", 8)
            c.drawCentredString(label_width / 2, 35, f"(Error: {str(e)[:30]})")

        c.showPage()

    c.save()
    buffer.seek(0)
    
    filename = f"Etiquetas_WMS_{datetime.now().strftime('%Y%m%d')}.pdf"
    return StreamingResponse(
        buffer, 
        media_type="application/pdf",
        headers={"Content-Disposition": f"inline; filename={filename}"}
    )

@router.post("/receiving")
async def create_receiving(request: Request):
    user = await require_auth(request)
    body = await request.json()
    customer = body.get("customer", "").strip()
    manufacturer = body.get("manufacturer", "").strip()
    # Normalize the identity dimensions to UPPERCASE on write so inventory/boxes
    # stay consistent (no more 'Sand' vs 'SAND' splitting matches/reports).
    style = body.get("style", "").strip().upper()
    color = body.get("color", "").strip().upper()
    size = body.get("size", "").strip().upper()
    description = body.get("description", "").strip()
    country_of_origin = body.get("country_of_origin", "").strip()
    fabric_content = body.get("fabric_content", "").strip()
    inv_location = body.get("inv_location", "").strip() or "Locación Temporal"
    lot_number = body.get("lot_number", "").strip()
    sku = body.get("sku", "").strip().upper()
    dozens = int(body.get("dozens", 0) or 0)
    pieces = int(body.get("pieces", 0) or 0)
    units = int(body.get("units", 0) or 0)
    vendor = body.get("vendor", manufacturer).strip()
    items = body.get("items", [])
    is_bpo = body.get("is_bpo", False)

    if not style:
        raise HTTPException(400, "Style requerido")
    # Block receiving against an ASN whose receiving process was finished.
    asn_ref = str(body.get("asn_reference", "")).strip()
    if asn_ref:
        ref_asn = await db.wms_asn.find_one({"asn_id": asn_ref}, {"_id": 0, "closed": 1})
        if ref_asn and ref_asn.get("closed"):
            raise HTTPException(409, f"El ASN {asn_ref} ya cerró su recibo. Reábrelo para recibir más.")
    if not country_of_origin:
        raise HTTPException(400, "País de origen (country_of_origin) es obligatorio")
    if not fabric_content:
        raise HTTPException(400, "Contenido / fabric_content es obligatorio")

    # Auto-generate SKU if not provided
    if not sku and style:
        base = style.upper().replace(' ', '-')
        parts = [base]
        if color: parts.append(color.upper().replace(' ', '-')[:10])
        if size: parts.append(size.upper())
        sku = '-'.join(parts)

    # Calculate total units
    total_units = units if units > 0 else (dozens * 12 + pieces)
    if total_units <= 0 and not items:
        raise HTTPException(400, "Debe ingresar cantidad (dozens/pieces/units)")

    receiving_id = gen_id("rcv")

    # Box generation — reserve a contiguous block of sequence numbers atomically
    # so two concurrent receivings can't mint the same BOX-id.
    _total_boxes = sum(int(it.get("boxes", 1) or 1) for it in items) if items else 1
    seq = await _reserve_box_seqs(_total_boxes) - 1

    box_docs = []
    if items:
        for item in items:
            item_size = item.get("size", "").strip().upper()
            boxes_count = int(item.get("boxes", 1))
            units_per_box = int(item.get("units_per_box", 1))
            for _ in range(boxes_count):
                seq += 1
                box_id = f"BOX-{seq:06d}"
                box_docs.append({
                    "box_id": box_id, "barcode": box_id, "receiving_id": receiving_id,
                    "customer": customer, "manufacturer": manufacturer, "style": style,
                    "sku": sku or style, "color": color, "size": item_size,
                    "units": units_per_box, "seq_num": seq, "location": inv_location,
                    "status": "putaway_pending", "state": "raw", "is_bpo": is_bpo,
                    "lpn_id": box_id, "coo": country_of_origin,
                    "country_of_origin": country_of_origin,
                    "fabric_content": fabric_content,
                    "description": description,
                    "lot_number": lot_number,
                    "asn_reference": body.get("asn_reference", "").strip(),
                    "upc": str(body.get("upc", "")).strip().upper(),
                    "created_at": now_iso(),
                })
    else:
        seq += 1
        box_id = f"BOX-{seq:06d}"
        box_docs.append({
            "box_id": box_id, "barcode": box_id, "receiving_id": receiving_id,
            "customer": customer, "manufacturer": manufacturer, "style": style,
            "sku": sku or style, "color": color, "size": size,
            "units": total_units, "qty": total_units, "seq_num": seq, "location": inv_location,
            "status": "putaway_pending", "state": "raw", "is_bpo": is_bpo,
            "lpn_id": box_id, "coo": country_of_origin,
            "country_of_origin": country_of_origin,
            "fabric_content": fabric_content,
            "description": description,
            "lot_number": lot_number,
            "asn_reference": body.get("asn_reference", "").strip(),
            "created_at": now_iso(),
        })
    
    if box_docs:
        await db.wms_boxes.insert_many(box_docs)
        
        # WMS 2.0: Directed Work Task Generator (Cross-Dock vs Putaway)
        tasks_to_insert = []
        for box in box_docs:
            bd_style = box.get("style", "").upper()
            bd_color = box.get("color", "")
            
            # Busqueda de demanda (Backorders)
            demand_query = {
                "board": {"$regex": "^scheduling$|^blanks$|^crm$", "$options": "i"},
                "style": {"$regex": f"^{bd_style}$", "$options": "i"}
            }
            if bd_color:
                demand_query["color"] = {"$regex": f"^{bd_color}$", "$options": "i"}
                
            urgent_order = await db.orders.find_one(demand_query)
            
            task_type = "cross_dock" if urgent_order else "putaway"
            priority = "HOT" if urgent_order and urgent_order.get("priority", "").upper() == "HOT" else "NORMAL"
            suggested_zone = "ZONA PRODUCCION" if task_type == "cross_dock" else inv_location
            
            tasks_to_insert.append({
                "task_id": gen_id("tsk"),
                "lpn_id": box["box_id"],
                "task_type": task_type,
                "priority": priority,
                "status": "pending",
                "assigned_to": None,
                "context": {
                    "suggested_zone": suggested_zone, 
                    "sku": box["sku"],
                    "order_number": urgent_order.get("order_number") if urgent_order else None
                },
                "created_at": now_iso(),
            })
            
        if tasks_to_insert:
            await db.wms_tasks.insert_many(tasks_to_insert)

    receiving_doc = {
        "receiving_id": receiving_id, "customer": customer, "manufacturer": manufacturer,
        "style": style, "color": color, "size": size, "description": description,
        "country_of_origin": country_of_origin, "fabric_content": fabric_content,
        "inv_location": inv_location, "lot_number": lot_number, "sku": sku,
        "total_units": total_units, "is_bpo": is_bpo,
        # Traceability — linked back to the ASN + UPC the operator captured.
        "asn_reference": body.get("asn_reference", "").strip(),
        "upc": str(body.get("upc", "")).strip().upper(),
        "received_by": user.get("user_id"), "received_by_name": user.get("name", ""),
        "created_at": now_iso(),
        "boxes": [{"box_id": b["box_id"], "units": b["units"]} for b in box_docs]
    }
    await db.wms_receiving.insert_one(receiving_doc)
    await log_movement(user, "receiving", {"receiving_id": receiving_id, "total_units": total_units, "is_bpo": is_bpo})
    
    # Update inventory — pass through the receiving metadata so the inventory
    # row mirrors what the operator captured (Cliente, Manufacturer, COO, etc.).
    # We collect the inventory_id returned by each call so we can link the
    # freshly-created box docs to their inventory row in a single bulk update
    # below. Keyed by item_size so multi-size receiving stays per-line.
    meta = {
        "manufacturer": manufacturer,
        "description": description,
        "country_of_origin": country_of_origin,
        "fabric_content": fabric_content,
    }
    inv_id_by_size: dict[str, str] = {}
    if items:
        for item in items:
            item_size = item.get("size") or ""
            item_boxes = int(item.get("boxes", 1))
            inv_id = await _update_inventory_enhanced(
                style, color, item_size,
                item_boxes * int(item.get("units_per_box", 1)),
                "add", customer, inv_location, is_bpo, **meta,
                box_count=item_boxes,
            )
            if inv_id:
                inv_id_by_size[item_size] = inv_id
    else:
        inv_id = await _update_inventory_enhanced(
            style, color, size, total_units, "add",
            customer, inv_location, is_bpo, **meta,
        )
        if inv_id:
            inv_id_by_size[size or ""] = inv_id

    # Link every box we just inserted to the inventory row it physically
    # represents. Without this link the Locations modal can't match LPNs back
    # to inventory items and the "Cajas" drawer renders empty.
    if inv_id_by_size and box_docs:
        from collections import defaultdict
        by_inv: dict[str, list[str]] = defaultdict(list)
        for b in box_docs:
            target_inv = inv_id_by_size.get(b.get("size") or "")
            if target_inv:
                by_inv[target_inv].append(b["box_id"])
        for target_inv, box_ids in by_inv.items():
            await db.wms_boxes.update_many(
                {"box_id": {"$in": box_ids}},
                {"$set": {"inventory_id": target_inv}},
            )

    # Ensure location exists
    inv_location_upper = inv_location.upper()
    existing_loc = await db.wms_locations.find_one({"name": {"$regex": f"^{re.escape(inv_location_upper)}$", "$options": "i"}})
    if not existing_loc:
        await db.wms_locations.insert_one({
            "location_id": gen_id("loc"), "name": inv_location_upper, 
            "zone": inv_location_upper.split('-')[0] if '-' in inv_location_upper else "RECEIVING",
            "type": "rack", "active": True, "created_at": now_iso(),
        })

    receiving_doc.pop("_id", None)
    await notify_badge_change("putaway")

    # ASN reconciliation (warning-permissive: never blocks, surfaces mismatches in response).
    # Two modes:
    #   1. asn_line_no provided -> all received qty decrements that exact line
    #      (operator confirmed which line they're receiving; style is irrelevant)
    #   2. asn_line_no missing  -> fall back to style-based match per part_number
    asn_warnings: list[dict] = []
    asn_ref = body.get("asn_reference", "").strip()
    asn_line_no_raw = body.get("asn_line_no")
    try:
        asn_line_no = int(asn_line_no_raw) if asn_line_no_raw not in (None, "", 0) else None
    except (TypeError, ValueError):
        asn_line_no = None

    if asn_ref and box_docs:
        total_units_received = sum(int(b.get("units", 0) or 0) for b in box_docs)
        try:
            if asn_line_no is not None:
                asn_result = await _apply_receiving_to_asn(
                    asn_ref, {}, user, target_line_no=asn_line_no,
                    target_qty=total_units_received,
                )
            else:
                received_by_pn: dict[str, int] = {}
                for b in box_docs:
                    key = (b.get("style") or b.get("sku") or "").strip().upper()
                    if not key:
                        continue
                    received_by_pn[key] = received_by_pn.get(key, 0) + int(b.get("units", 0) or 0)
                asn_result = await _apply_receiving_to_asn(asn_ref, received_by_pn, user)
            asn_warnings = asn_result.get("mismatched", [])
        except Exception as e:
            logger.exception(f"ASN reconciliation failed for {asn_ref}: {e}")
            asn_warnings = [{"reason": "reconcile_error", "detail": str(e)}]

    receiving_doc["asn_warnings"] = asn_warnings
    return receiving_doc

@router.get("/receiving")
async def list_receiving(request: Request, search: str = "", customer: str = "", limit: int = 200):
    """Search-driven receiving list. The UI no longer dumps the latest 500 — it
    queries by:
      - search:   matches receiving_id / style / sku / customer (free text)
      - customer: restricts to one customer (exact-ish, case-insensitive)
    With NO filter we return [] so the screen stays empty until the operator
    searches (by receipt number or by customer)."""
    await require_auth(request)
    search = (search or "").strip()
    customer = (customer or "").strip()
    if not search and not customer:
        return []
    query = {}
    if search:
        rx = {"$regex": re.escape(search), "$options": "i"}
        query["$or"] = [{"receiving_id": rx}, {"style": rx}, {"sku": rx}, {"customer": rx}]
    if customer:
        query["customer"] = {"$regex": re.escape(customer), "$options": "i"}
    limit = max(1, min(int(limit or 200), 1000))
    docs = await db.wms_receiving.find(query, {"_id": 0}).sort("created_at", -1).to_list(limit)
    return docs

@router.get("/receiving/{receiving_id}")
async def get_receiving(receiving_id: str, request: Request):
    await require_auth(request)
    doc = await db.wms_receiving.find_one({"receiving_id": receiving_id}, {"_id": 0})
    if not doc:
        raise HTTPException(404, "Receiving no encontrado")
    boxes = await db.wms_boxes.find({"receiving_id": receiving_id}, {"_id": 0}).to_list(500)
    doc["boxes"] = boxes
    return doc

@router.put("/receiving/{receiving_id}")
async def update_receiving(receiving_id: str, request: Request):
    user = await require_auth(request)
    body = await request.json()
    
    # Extract only metadata fields (no quantity/sku changes allowed here to protect inventory integrity)
    update_data = {}
    for field in ["customer", "manufacturer", "description", "country_of_origin", "fabric_content", "lot_number", "inv_location"]:
        if field in body:
            update_data[field] = body[field].strip()
            
    if not update_data:
        return {"message": "Nada que actualizar"}
        
    doc = await db.wms_receiving.find_one({"receiving_id": receiving_id})
    if not doc:
        raise HTTPException(404, "Receiving no encontrado")
        
    # Update the receiving record
    await db.wms_receiving.update_one({"receiving_id": receiving_id}, {"$set": update_data})
    
    # Also update the boxes
    box_update = {}
    if "customer" in update_data: box_update["customer"] = update_data["customer"]
    if "manufacturer" in update_data: box_update["manufacturer"] = update_data["manufacturer"]
    if "lot_number" in update_data: box_update["lot_number"] = update_data["lot_number"]
    if "country_of_origin" in update_data: box_update["coo"] = update_data["country_of_origin"]
    if "inv_location" in update_data: box_update["location"] = update_data["inv_location"]
    
    if box_update:
        await db.wms_boxes.update_many({"receiving_id": receiving_id}, {"$set": box_update})
        
    await log_movement(user, "receiving_update", {"receiving_id": receiving_id, "updated_fields": list(update_data.keys())})
    return {"message": "Registro actualizado exitosamente"}

@router.delete("/receiving/{receiving_id}")
async def delete_receiving(receiving_id: str, request: Request):
    user = await require_auth(request)
    doc = await db.wms_receiving.find_one({"receiving_id": receiving_id})
    if not doc:
        raise HTTPException(404, "Receiving no encontrado")
    
    # Revert inventory added by this receiving
    boxes = await db.wms_boxes.find({"receiving_id": receiving_id}).to_list(1000)

    # Guard: once a box has been put away / picked / processed, its units may now
    # live in a different location, so deleting the receiving can no longer cleanly
    # reverse the inventory — that is exactly what historically left phantom stock
    # (system shows material that is not physically there). Block it and tell the
    # user to adjust via Entradas/Salidas instead of deleting the receipt.
    RAW_STATES = {None, "", "raw"}
    RAW_STATUSES = {None, "", "putaway_pending", "received", "pending"}
    moved = [b for b in boxes
             if (b.get("state") not in RAW_STATES) or (b.get("status") not in RAW_STATUSES)
             or int(b.get("units_allocated", 0) or 0) > 0]
    if moved:
        raise HTTPException(
            409,
            f"No se puede eliminar: {len(moved)} de {len(boxes)} caja(s) ya fueron "
            "movidas (putaway), surtidas o procesadas. Borrar ahora dejaria inventario "
            "fantasma. Ajusta el inventario con Entradas/Salidas, o regresa/reubica las "
            "cajas a su estado original, antes de eliminar el recibo.",
        )

    for box in boxes:
        box_style = box.get("style")
        box_color = box.get("color")
        box_size = box.get("size")
        box_units = box.get("units", 0)
        box_location = box.get("location")

        if box_style and box_units > 0:
            # Revert the units AND the box this receiving added. ("remove" was
            # never a real op in _update_inventory_enhanced, so deletes used to
            # leave inventory inflated with no boxes behind it.)
            rev_inv = await db.wms_inventory.find_one({
                "sku": box_style, "color": box_color or "", "size": box_size or "", "location": box_location or "",
            }) or await db.wms_inventory.find_one({
                "style": {"$regex": f"^{re.escape(box_style)}$", "$options": "i"},
                "color": box_color or "", "size": box_size or "", "location": box_location or "",
            })
            if rev_inv:
                new_hand = max(0, int(rev_inv.get("units_on_hand", 0)) - box_units)
                new_boxes = max(0, int(rev_inv.get("total_boxes", 0) or 0) - 1)
                if new_hand == 0 and new_boxes == 0 and int(rev_inv.get("units_allocated", 0) or 0) <= 0:
                    await db.wms_inventory.delete_one({"_id": rev_inv["_id"]})
                else:
                    await db.wms_inventory.update_one(
                        {"_id": rev_inv["_id"]},
                        {"$set": {"units_on_hand": new_hand, "total_boxes": new_boxes, "updated_at": now_iso()}},
                    )
            
    box_ids = [b["box_id"] for b in boxes if "box_id" in b]
    if box_ids:
        await db.wms_tasks.delete_many({"lpn_id": {"$in": box_ids}})
        await db.wms_boxes.delete_many({"receiving_id": receiving_id})
        
    await db.wms_receiving.delete_one({"receiving_id": receiving_id})
    
    # Revert ASN progress if linked
    asn_ref = doc.get("asn_reference")
    if asn_ref:
        pn = (doc.get("sku") or doc.get("style") or "").upper()
        if pn:
            await _apply_receiving_to_asn(
                asn_ref,
                {pn: -int(doc.get("total_units", 0))},
                user
            )
            
    await log_movement(user, "deallocate", {
        "receiving_id": receiving_id, 
        "details": f"Eliminado registro de receiving y revertidas {len(boxes)} cajas"
    })
    await notify_badge_change("putaway")
    return {"message": "Receiving eliminado y revertido exitosamente"}

# ==================== BOXES ====================

@router.get("/stocktakes")
@router.get("/boxes")
async def list_boxes(request: Request, sku: str = "", color: str = "", size: str = "",
                     location: str = "", status: str = "", state: str = "", po: str = "",
                     inventory_id: str = ""):
    """List boxes. Add `inventory_id=...` to fetch every LPN belonging to a
    single SKU+location inventory row — used by the Inventory and Locations
    UIs to expand a 'Cajas' cell into the actual LPN list."""
    await require_auth(request)
    query = {}
    if sku: query["sku"] = {"$regex": sku, "$options": "i"}
    if color: query["color"] = {"$regex": color, "$options": "i"}
    if size: query["size"] = {"$regex": size, "$options": "i"}
    if location: query["location"] = location
    if status:
        if status == "received":
            query["status"] = {"$in": ["received", "putaway_pending"]}
        else:
            query["status"] = status
    if state: query["state"] = state
    if po: query["po"] = {"$regex": po, "$options": "i"}
    if inventory_id: query["inventory_id"] = inventory_id
    boxes = await db.wms_boxes.find(query, {"_id": 0}).sort("created_at", -1).to_list(2000)
    return boxes

@router.get("/stocktakes/{box_id}")
@router.get("/boxes/{box_id}")
async def get_box(box_id: str, request: Request):
    await require_auth(request)
    box = await db.wms_boxes.find_one({"box_id": box_id}, {"_id": 0})
    if not box:
        # Resolve by the box's REAL physical license plate too: once a migrated box
        # is reconciled (POST /boxes/reconcile-lpn), its printed LPN lives in
        # barcode/lpn_id while box_id stays the internal key, so a scan of that
        # label must still find the box.
        box = await db.wms_boxes.find_one(
            {"$or": [{"barcode": box_id}, {"lpn_id": box_id}]}, {"_id": 0}
        )
    if not box:
        # Fallback: if it's a receiving ID, return the first box associated with this receiving
        if box_id.upper().startswith("RCV_"):
            box = await db.wms_boxes.find_one({"receiving_id": box_id.lower()}, {"_id": 0})
            if box:
                box = dict(box)
                box["box_id"] = box_id
                return box
        raise HTTPException(404, "Caja no encontrada")
    return box


# Fields the operator can edit after a box is received. Excludes box_id /
# location / created_at / receiving_id / asn_reference / upc — those tie the
# box to its origin and to physical putaway, so the relocate endpoints own
# those mutations.
_BOX_EDITABLE_FIELDS = {
    "customer", "manufacturer", "description",
    "country_of_origin", "fabric_content", "lot_number",
    "units",  # qty mirror is kept in sync below
}


@router.put("/boxes/{box_id}")
async def update_box(box_id: str, request: Request):
    """Edit a received box. If `units` changes, the inventory row for the
    box's location is rebalanced by the delta so the on-hand stays accurate.
    Other field edits propagate to the box doc only — they don't affect
    inventory aggregations because those bucket on (sku, color, size,
    location), not on description/country/fabric/lot."""
    user = await require_auth(request)
    body = await request.json()

    box = await db.wms_boxes.find_one({"box_id": box_id}, {"_id": 0})
    if not box:
        raise HTTPException(404, f"Caja {box_id} no encontrada")
    await _assert_not_on_hold(user, box.get("location"))

    update_doc = {}
    for k, v in body.items():
        if k not in _BOX_EDITABLE_FIELDS:
            continue
        if k == "units":
            try:
                update_doc["units"] = int(v)
                update_doc["qty"] = int(v)  # qty mirrors units in the schema
            except (TypeError, ValueError):
                raise HTTPException(400, "units debe ser un entero")
        else:
            update_doc[k] = (str(v).strip() if v is not None else "")

    if not update_doc:
        raise HTTPException(400, "Nada por actualizar")

    update_doc["updated_at"] = now_iso()
    update_doc["updated_by"] = user.get("user_id")

    # 1. Inventory rebalance if units changed.
    old_units = int(box.get("units") or box.get("qty") or 0)
    new_units = update_doc.get("units", old_units)
    delta = new_units - old_units
    if delta != 0:
        sku = box.get("sku") or box.get("style") or ""
        color = box.get("color", "")
        size = box.get("size", "")
        location = box.get("location", "")
        inv = await db.wms_inventory.find_one({
            "sku": sku, "color": color, "size": size, "location": location,
        })
        if inv:
            new_on_hand = max(0, int(inv.get("units_on_hand", 0)) + delta)
            # Keep total_boxes in step: this box crossing to/from 0 units adds or
            # removes exactly one counted box at the slot.
            box_delta = -1 if (old_units > 0 and new_units == 0) else (1 if (old_units == 0 and new_units > 0) else 0)
            new_total_boxes = max(0, int(inv.get("total_boxes", 0) or 0) + box_delta)
            await db.wms_inventory.update_one(
                {"_id": inv["_id"]},
                {"$set": {"units_on_hand": new_on_hand, "total_boxes": new_total_boxes, "updated_at": now_iso()}},
            )
            # If the inventory row is empty AND has no other boxes pointing
            # at it, delete it so it doesn't ghost the Inventory listing.
            if new_on_hand == 0:
                still = await db.wms_boxes.count_documents({
                    "sku": sku, "color": color, "size": size, "location": location,
                    "box_id": {"$ne": box_id}, "units": {"$gt": 0},
                })
                if not still:
                    await db.wms_inventory.delete_one({"_id": inv["_id"]})

    # 2. Patch the box.
    await db.wms_boxes.update_one({"box_id": box_id}, {"$set": update_doc})

    # 3. Audit trail.
    await log_movement(user, "box_edited", {
        "box_id": box_id,
        "changes": {k: v for k, v in update_doc.items() if k not in ("updated_at", "updated_by")},
        "old_units": old_units,
        "new_units": new_units,
        "delta_units": delta,
    })
    await notify_badge_change("all")

    updated = await db.wms_boxes.find_one({"box_id": box_id}, {"_id": 0})
    return updated


@router.delete("/boxes/{box_id}")
async def delete_box(box_id: str, request: Request):
    """Delete a box (LPN). Super-user only. Deducts the box's units from the
    location's inventory row (mirrors the rebalance in update_box) and removes
    the inventory row entirely if it empties out and no other box feeds it."""
    user = await require_supersu(request)

    box = await db.wms_boxes.find_one({"box_id": box_id}, {"_id": 0})
    if not box:
        raise HTTPException(404, f"Caja {box_id} no encontrada")

    units = int(box.get("units") or box.get("qty") or 0)
    sku = box.get("sku") or box.get("style") or ""
    color = box.get("color", "")
    size = box.get("size", "")
    location = box.get("location", "")

    if units > 0 and location:
        inv = await db.wms_inventory.find_one({
            "sku": sku, "color": color, "size": size, "location": location,
        })
        if inv:
            new_on_hand = max(0, int(inv.get("units_on_hand", 0)) - units)
            new_total_boxes = max(0, int(inv.get("total_boxes", 0)) - 1)
            still = await db.wms_boxes.count_documents({
                "sku": sku, "color": color, "size": size, "location": location,
                "box_id": {"$ne": box_id}, "units": {"$gt": 0},
            })
            if new_on_hand == 0 and new_total_boxes == 0 and not still:
                await db.wms_inventory.delete_one({"_id": inv["_id"]})
            else:
                await db.wms_inventory.update_one(
                    {"_id": inv["_id"]},
                    {"$set": {"units_on_hand": new_on_hand, "total_boxes": new_total_boxes, "updated_at": now_iso()}},
                )

    await db.wms_boxes.delete_one({"box_id": box_id})
    await log_movement(user, "box_deleted", {
        "box_id": box_id, "sku": sku, "color": color, "size": size,
        "location": location, "units": units,
    })
    await notify_badge_change("all")
    return {"status": "deleted", "box_id": box_id}


@router.post("/boxes/{box_id}/adjust")
async def adjust_box_count(box_id: str, request: Request):
    """Case# 002 — adjust inventory at the physical box level.

    The operator scans a box (by box_id, printed barcode or lpn_id) and types
    the REAL counted units for that single box. We set the box to that exact
    count and rebalance the box's location inventory row by the delta — so an
    adjustment is always tied to a concrete box number (auditable in the box's
    movement history, Case# 003).

    Guards:
      • A reason is mandatory (free text) so every adjustment is justified.
      • A downward adjustment is blocked when it would push the row's on-hand
        below its allocated (committed) units, mirroring the manual-out guard.
      • Honors location HOLDs.
    Side effects:
      • If the new count is 0 the box is deleted (no zero-unit ghosts).
      • An empty inventory row (no units, no other boxes) is dropped.
    """
    user = await require_auth(request)
    body = await request.json()

    # Resolve by internal key first, then by the physical label (barcode/lpn_id)
    # so a scan of the printed plate of a reconciled box still finds it.
    box = await db.wms_boxes.find_one({"box_id": box_id}, {"_id": 0})
    if not box:
        box = await db.wms_boxes.find_one(
            {"$or": [{"barcode": box_id}, {"lpn_id": box_id}]}, {"_id": 0}
        )
    if not box:
        raise HTTPException(404, f"Caja {box_id} no encontrada")
    real_box_id = box["box_id"]

    await _assert_not_on_hold(user, box.get("location"))

    reason = str(body.get("reason", "") or "").strip()
    if not reason:
        raise HTTPException(400, "El motivo del ajuste es obligatorio")

    try:
        counted = int(float(body.get("counted_units")))
    except (TypeError, ValueError):
        raise HTTPException(400, "Las unidades contadas deben ser un número entero")
    if counted < 0:
        raise HTTPException(400, "Las unidades contadas no pueden ser negativas")

    old_units = int(box.get("units") or box.get("qty") or 0)
    delta = counted - old_units
    if delta == 0:
        raise HTTPException(400, f"La caja ya tiene {old_units} unidades; nada por ajustar")

    sku = box.get("sku") or box.get("style") or ""
    color = box.get("color", "")
    size = box.get("size", "")
    location = box.get("location", "")

    # Rebalance the location's inventory row by the same delta.
    inv = None
    if location:
        inv = (
            (box.get("inventory_id") and await db.wms_inventory.find_one({"inventory_id": box["inventory_id"]}))
            or await db.wms_inventory.find_one({"sku": sku, "color": color, "size": size, "location": location})
        )
    if inv:
        on_hand = int(inv.get("units_on_hand", 0) or 0)
        allocated = int(inv.get("units_allocated", 0) or 0)
        new_on_hand = on_hand + delta
        if new_on_hand < allocated:
            raise HTTPException(
                400,
                f"No puedes dejar {new_on_hand} en existencia: {allocated} unidades están "
                f"comprometidas (allocated) en esta ubicación. Libera la asignación primero.",
            )
        new_on_hand = max(0, new_on_hand)
        # This box crossing to/from 0 units adds or removes one counted box.
        box_delta = -1 if (old_units > 0 and counted == 0) else (1 if (old_units == 0 and counted > 0) else 0)
        new_total_boxes = max(0, int(inv.get("total_boxes", 0) or 0) + box_delta)
        await db.wms_inventory.update_one(
            {"_id": inv["_id"]},
            {"$set": {"units_on_hand": new_on_hand, "total_boxes": new_total_boxes, "updated_at": now_iso()}},
        )
        # Drop a fully-empty row so an adjusted-to-zero slot doesn't ghost.
        if new_on_hand == 0:
            still = await db.wms_boxes.count_documents({
                "sku": sku, "color": color, "size": size, "location": location,
                "box_id": {"$ne": real_box_id}, "units": {"$gt": 0},
            })
            if not still:
                await db.wms_inventory.delete_one({"_id": inv["_id"]})

    # Apply to the box itself: delete when emptied, otherwise set the new count.
    if counted == 0:
        await db.wms_boxes.delete_one({"box_id": real_box_id})
    else:
        await db.wms_boxes.update_one(
            {"box_id": real_box_id},
            {"$set": {"units": counted, "qty": counted,
                      "updated_at": now_iso(), "updated_by": user.get("user_id")}},
        )

    await log_movement(user, "inventory_adjust_box", {
        "box_id": real_box_id,
        "sku": sku, "color": color, "size": size, "location": location,
        "old_units": old_units, "new_units": counted, "delta_units": delta,
        "reason": reason,
        "box_deleted": counted == 0,
    })
    await notify_badge_change("all")

    return {
        "status": "adjusted",
        "box_id": real_box_id,
        "old_units": old_units,
        "new_units": counted,
        "delta_units": delta,
        "box_deleted": counted == 0,
        "location": location,
    }


@router.get("/boxes/{box_id}/history")
async def box_history(box_id: str, request: Request, limit: int = 300):
    """Case# 003 — full transaction timeline for a single box / LPN.

    Resolves the box by internal id, printed barcode or lpn_id, then returns:
      • box_events — every movement that names this box (details.box_id, or this
        box inside a bulk move's details.box_ids), plus the receiving event that
        created it. Newest first.
      • sku_context — movements at the SKU/location level that don't name a box
        (allocation, picking, manual adjustments, cycle counts). Helps diagnose
        discrepancies but is not specific to this box.

    Read-only; any authenticated WMS user.
    """
    await require_auth(request)

    box = await db.wms_boxes.find_one({"box_id": box_id}, {"_id": 0})
    if not box:
        box = await db.wms_boxes.find_one(
            {"$or": [{"barcode": box_id}, {"lpn_id": box_id}]}, {"_id": 0}
        )

    # Every identifier this box has answered to. A deleted box still leaves
    # movements keyed by its original id, so fall back to the raw input.
    keys = set()
    if box:
        for k in (box.get("box_id"), box.get("lpn_id"), box.get("barcode")):
            if k:
                keys.add(k)
    keys.add(box_id)
    keys = list(keys)

    or_clauses = [
        {"details.box_id": {"$in": keys}},     # single-box events
        {"details.box_ids": {"$in": keys}},    # this box inside a bulk move
    ]
    # The creation (receiving) event is keyed by receiving_id, not box_id.
    receiving_id = (box or {}).get("receiving_id")
    if receiving_id:
        or_clauses.append({"details.receiving_id": receiving_id})

    box_events = await db.wms_movements.find(
        {"$or": or_clauses}, {"_id": 0}
    ).sort("created_at", -1).to_list(limit)
    box_event_ids = {m.get("movement_id") for m in box_events}

    # Receiving-linked events (receiving / receiving_update / deallocate) only log
    # the receiving_id + a grand total. Join the receiving doc so the timeline
    # shows the product, this box's received units, lot, ASN/UPC, etc.
    rcv_ids = {m.get("details", {}).get("receiving_id") for m in box_events}
    rcv_ids.discard(None)
    if rcv_ids:
        rcv_map = {}
        async for r in db.wms_receiving.find({"receiving_id": {"$in": list(rcv_ids)}}, {"_id": 0}):
            rcv_map[r.get("receiving_id")] = r
        for m in box_events:
            d = m.get("details") or {}
            r = rcv_map.get(d.get("receiving_id"))
            if not r:
                continue
            for k in ("customer", "manufacturer", "style", "color", "size", "sku",
                      "description", "country_of_origin", "fabric_content",
                      "lot_number", "asn_reference", "upc"):
                if r.get(k) and not d.get(k):
                    d[k] = r.get(k)
            # This specific box's received units, pulled from the receiving's box list.
            for b in (r.get("boxes") or []):
                if b.get("box_id") in keys:
                    d["box_units_received"] = b.get("units")
                    break
            if r.get("received_by_name") and not m.get("user_name"):
                m["user_name"] = r["received_by_name"]
            m["details"] = d

    # SKU/location context — only when we still know the box's dimensions.
    sku_context = []
    if box:
        sku = box.get("sku") or box.get("style") or ""
        if sku:
            ctx = await get_sku_movement_history(sku, box.get("color", ""), box.get("size", ""), limit)
            sku_context = [m for m in ctx if m.get("movement_id") not in box_event_ids]

    return {
        "box_id": (box or {}).get("box_id", box_id),
        "found": bool(box),
        "box": box,
        "box_events": box_events,
        "box_event_count": len(box_events),
        "sku_context": sku_context,
        "sku_context_count": len(sku_context),
    }


# ==================== PUTAWAY ====================

async def _adjust_inventory_boxes(inv_id, delta):
    """Keep total_boxes in step with a physical box event on a single inventory
    row. Clamped at zero. Deletes the row if it ends up fully empty (no units,
    no boxes, no allocation) so a picked-out slot doesn't ghost the listing.

    total_boxes is a denormalized cache of wms_boxes; every path that creates,
    moves, empties or deletes a box must adjust it here so the two never drift
    (the cause of "report shows boxes but 0 product")."""
    if not inv_id or not delta:
        return
    row = await db.wms_inventory.find_one({"inventory_id": inv_id})
    if not row:
        return
    new_boxes = max(0, int(row.get("total_boxes", 0) or 0) + delta)
    if (new_boxes == 0 and int(row.get("units_on_hand", 0) or 0) <= 0
            and int(row.get("units_allocated", 0) or 0) <= 0):
        await db.wms_inventory.delete_one({"_id": row["_id"]})
    else:
        await db.wms_inventory.update_one(
            {"_id": row["_id"]},
            {"$set": {"total_boxes": new_boxes, "updated_at": now_iso()}},
        )


async def _move_box_inventory(box, old_loc, new_loc):
    if old_loc == new_loc:
        return
    sku = box.get("style") or box.get("sku")
    color = box.get("color") or ""
    size = box.get("size") or ""
    qty = box.get("units") or 0
    customer = box.get("customer") or ""
    is_bpo = box.get("is_bpo", False)

    # 1. Deduct from old location in wms_inventory (units AND the one box we're
    #    moving out). Only drop the row when it truly empties (no boxes, no units,
    #    no allocation) — total_boxes alone staying >0 must keep the row alive.
    if old_loc:
        old_inv = await db.wms_inventory.find_one({"sku": sku, "color": color, "size": size, "location": old_loc})
        if old_inv:
            new_qty = max(0, old_inv.get("units_on_hand", 0) - qty)
            new_boxes = max(0, int(old_inv.get("total_boxes", 0) or 0) - 1)
            if new_qty == 0 and new_boxes == 0 and int(old_inv.get("units_allocated", 0) or 0) <= 0:
                await db.wms_inventory.delete_one({"_id": old_inv["_id"]})
            else:
                await db.wms_inventory.update_one({"_id": old_inv["_id"]}, {"$set": {"units_on_hand": new_qty, "total_boxes": new_boxes, "updated_at": now_iso()}})

    # 2. Add to new location in wms_inventory (units AND the box that arrived).
    await db.wms_inventory.update_one(
        {"sku": sku, "color": color, "size": size, "location": new_loc},
        {"$inc": {"units_on_hand": qty, "total_boxes": 1}, "$set": {"updated_at": now_iso(), "customer": customer, "is_bpo": is_bpo, "style": sku}},
        upsert=True
    )


def _ci_eq(v):
    """Case-insensitive exact match for a Mongo string field. Inventory and boxes
    store the same color/style with inconsistent casing (e.g. 'Sand' vs 'SAND'),
    and the picker UI (_compute_size_locations) matches case-insensitively — so
    the stock check AND the deduction must too. Exact matching here silently found
    nothing, which blocked legit picks and (before the guard) never deducted →
    ghost inventory."""
    return {"$regex": f"^{re.escape(v or '')}$", "$options": "i"}


async def _deduct_pick_boxes(style, color, size, location, qty, inv_operation,
                             customer="", order_number=None, order_id=None):
    """Deduct `qty` units for a pick from the physical boxes (FIFO) AND the
    inventory row, keeping wms_boxes / units_on_hand / total_boxes in lockstep.
    Used by both pick flows so neither leaves boxes full while stock drops (the
    drift that made a box read 21 units while inventory showed 0). Falls back to
    an inventory-only deduct for the leftover when no boxes back the slot
    (e.g. Excel-imported bulk)."""
    remaining = int(qty or 0)
    if remaining <= 0:
        return
    q = {"$or": [{"sku": _ci_eq(style)}, {"style": _ci_eq(style)}],
         "color": _ci_eq(color), "size": _ci_eq(size), "units": {"$gt": 0}}
    if location:
        q["location"] = _ci_eq(location)
    boxes = await db.wms_boxes.find(q).sort("created_at", 1).to_list(500)
    for box in boxes:
        if remaining <= 0:
            break
        b_qty = box.get("units") if box.get("units") is not None else box.get("qty", 0)
        if b_qty <= 0:
            continue
        take = min(b_qty, remaining)
        new_b = b_qty - take
        upd = {"units": new_b, "qty": new_b}
        if order_number is not None:
            upd["order_number"] = order_number
        if order_id is not None:
            upd["last_order_id"] = order_id
        await db.wms_boxes.update_one({"_id": box["_id"]}, {"$set": upd})
        # Key the inventory deduct the SAME way _move_box_inventory / receiving
        # CREATE the row: short style first (e.g. "5000"), composite sku only as
        # fallback. Boxes carry the composite sku ("5000-BLACK-XL") but shelf
        # inventory rows are keyed by the short style — deducting by the box's
        # composite sku missed the row entirely, so the box emptied while the
        # ledger stayed full (the NA04-A17 ghost-inventory case).
        inv_id = await _update_inventory_enhanced(
            box.get("style") or box.get("sku") or style, box.get("color", color), box.get("size", size),
            take, inv_operation, location=box.get("location", location),
            customer=box.get("customer", customer),
        )
        if new_b == 0:
            await _adjust_inventory_boxes(inv_id, -1)
        remaining -= take
    # Leftover with no backing box: deduct straight from inventory (legacy/Excel).
    if remaining > 0:
        await _update_inventory_enhanced(style, color, size, remaining, inv_operation,
                                         location=location, customer=customer)


async def _available_units(style, color, size, location=""):
    """Physical units available to pick for a SKU dimension. Stock can live as
    physical boxes AND/OR as a wms_inventory row, and the two mirrors can drift,
    so we take the GREATER of the two. That blocks genuine oversell (BOTH mirrors
    short of the request) without false-rejecting a pick when only one mirror
    lags behind (e.g. Excel-imported rows with no boxes, or boxes whose inventory
    row hasn't caught up)."""
    style = (style or "").strip()
    color = (color or "").strip()
    sz = (size or "").strip()
    # Case-insensitive match (Sand vs SAND) so this agrees with what the picker
    # sees in _compute_size_locations — otherwise a legit pick is blocked with
    # "disponible 0" even though the stock is right there.
    base = {"$or": [{"sku": _ci_eq(style)}, {"style": _ci_eq(style)}], "color": _ci_eq(color), "size": _ci_eq(sz)}

    box_q = {**base, "units": {"$gt": 0}}
    if location:
        box_q["location"] = _ci_eq(location)
    box_units = 0
    for b in await db.wms_boxes.find(box_q, {"_id": 0, "units": 1, "qty": 1}).to_list(5000):
        box_units += int((b.get("units") if b.get("units") is not None else b.get("qty", 0)) or 0)

    inv_q = dict(base)
    if location:
        inv_q["location"] = _ci_eq(location)
    inv_units = 0
    for r in await db.wms_inventory.find(inv_q, {"_id": 0, "units_on_hand": 1}).to_list(5000):
        inv_units += int(r.get("units_on_hand", 0) or 0)

    return max(box_units, inv_units)


async def _open_discrepancy_task(style, color, size, location, requested, available, user):
    """Open (or reuse) a pending discrepancy cycle-count task so the warehouse
    reconciles a slot whose system stock fell short of a pick request."""
    existing = await db.wms_tasks.find_one({
        "task_type": "discrepancy", "status": "pending",
        "context.style": style, "context.color": color or "",
        "context.size": (size or "").strip(), "context.location": location or "",
    })
    if existing:
        return
    await db.wms_tasks.insert_one({
        "task_id": gen_id("tsk"), "task_type": "discrepancy", "priority": "HIGH",
        "status": "pending", "assigned_to": None,
        "context": {
            "style": style, "color": color or "", "size": (size or "").strip(),
            "location": location or "", "requested": int(requested), "available": int(available),
            "suggested_zone": location or "",
            "reason": "Pick oversell bloqueado: solicitado > disponible",
        },
        "created_by": (user or {}).get("user_id"),
        "created_at": now_iso(),
    })


async def _assert_pick_stock(style, color, picked_sizes, user):
    """WMS-002: block a pick (HTTP 409) that asks for more units than physically
    available, BEFORE any deduction runs, and open a discrepancy task per
    shortfall so the warehouse reconciles. Standalone Mongo has no multi-document
    transactions, so we gate up-front; the per-row deduct is also atomic-clamped
    (_update_inventory_enhanced) as a last-resort guard for the microsecond race
    on the final units."""
    style = (style or "").strip()
    color = (color or "").strip()
    shortfalls = []
    for sz, data in (picked_sizes or {}).items():
        sz_clean = (sz or "").strip()
        if isinstance(data, dict) and data.get("details"):
            for loc, qty in data["details"].items():
                q = int(qty or 0)
                if q <= 0:
                    continue
                avail = await _available_units(style, color, sz_clean, loc)
                if q > avail:
                    shortfalls.append({"size": sz_clean, "location": loc, "requested": q, "available": avail})
        else:
            q = int(data.get("total", 0)) if isinstance(data, dict) else int(data or 0)
            if q <= 0:
                continue
            avail = await _available_units(style, color, sz_clean, "")
            if q > avail:
                shortfalls.append({"size": sz_clean, "location": "", "requested": q, "available": avail})

    if not shortfalls:
        return
    for s in shortfalls:
        await _open_discrepancy_task(style, color, s["size"], s["location"], s["requested"], s["available"], user)
    detail = "; ".join(
        f"{style} {color} {s['size']}".strip()
        + (f" @ {s['location']}" if s["location"] else "")
        + f": pidió {s['requested']}, disponible {s['available']}"
        for s in shortfalls
    )
    raise HTTPException(409, f"Stock insuficiente para surtir; se abrió conteo de discrepancia. {detail}")


@router.post("/putaway")
async def putaway_box(request: Request):
    user = await require_auth(request)
    body = await request.json()
    box_id = body.get("box_id", "").strip()
    location = body.get("location", "").strip()
    if not box_id or not location:
        raise HTTPException(400, "box_id y location requeridos")
    
    loc = await db.wms_locations.find_one({"name": location})
    if not loc:
        raise HTTPException(404, "Ubicacion no encontrada")
    await _assert_not_on_hold(user, location)

    box = await db.wms_boxes.find_one({"box_id": box_id})
    if not box:
        # Fallback: if it's a receiving_id, find all received boxes of that receiving event
        if box_id.upper().startswith("RCV_"):
            boxes = await db.wms_boxes.find({"receiving_id": box_id.lower()}).to_list(1000)
            if not boxes:
                raise HTTPException(404, f"No se encontraron cajas para el Receiving ID: {box_id}")
            await _assert_not_on_hold(user, *{b.get("location") for b in boxes})
            for b in boxes:
                old_loc = b.get("location")
                await db.wms_boxes.update_one({"box_id": b["box_id"]}, {"$set": {"location": location, "status": "stored"}})
                await log_movement(user, "putaway", {"box_id": b["box_id"], "from": old_loc, "to": location, "sku": b.get("sku"), "units": b.get("units")})
                await _move_box_inventory(b, old_loc, location)
            await notify_badge_change("putaway")
            return {"message": f"Se ubicaron exitosamente {len(boxes)} cajas del receiving {box_id} en {location}", "box_id": box_id, "location": location}
        raise HTTPException(404, "Caja no encontrada")

    old_location = box.get("location")
    await _assert_not_on_hold(user, old_location)
    await db.wms_boxes.update_one({"box_id": box_id}, {"$set": {"location": location, "status": "stored"}})
    await log_movement(user, "putaway", {"box_id": box_id, "from": old_location, "to": location, "sku": box.get("sku"), "units": box.get("units")})
    await _move_box_inventory(box, old_location, location)
    await notify_badge_change("putaway")
    return {"message": f"Caja {box_id} ubicada en {location}", "box_id": box_id, "location": location}

@router.post("/putaway/bulk")
async def putaway_bulk(request: Request):
    user = await require_auth(request)
    body = await request.json()
    assignments = body.get("assignments", [])
    results = []
    for a in assignments:
        box_id = a.get("box_id", "").strip()
        location = a.get("location", "").strip()
        if box_id and location:
            box = await db.wms_boxes.find_one({"box_id": box_id})
            if box:
                old_loc = box.get("location")
                await _assert_not_on_hold(user, location, old_loc)
                await db.wms_boxes.update_one({"box_id": box_id}, {"$set": {"location": location, "status": "stored"}})
                await _move_box_inventory(box, old_loc, location)
                results.append({"box_id": box_id, "location": location})
    await log_movement(user, "putaway_bulk", {
        "count": len(results),
        "box_ids": [r["box_id"] for r in results][:50],  # cap log payload
    })
    await notify_badge_change("putaway")
    return {"message": f"{len(results)} cajas ubicadas", "results": results}

# ==================== INVENTORY ====================

async def _update_inventory_enhanced(
    sku, color, size, qty, operation, customer="", location="", is_bpo=False,
    *, manufacturer="", description="", country_of_origin="", fabric_content="",
    box_count=1,
):
    """Add/allocate/deallocate/deduct stock. The inventory key is now
    (sku, color, size, location, fabric_content, country_of_origin) so two
    batches of the same SKU at the same shelf with different fabric content
    or country of origin stay as separate rows instead of being silently
    merged. For non-add operations we fall back to the legacy 4-field key
    to keep picking/move flows working when callers don't supply meta."""
    full_key = {
        "sku": sku, "color": color or "", "size": size or "",
        "location": location or "",
        "fabric_content": fabric_content or "",
        "country_of_origin": country_of_origin or "",
    }
    inv = await db.wms_inventory.find_one(full_key)
    # Excel-imported inventory may have sku='None' with real value in 'style'
    if not inv and sku:
        style_key = {
            "style": {"$regex": f"^{re.escape(sku)}$", "$options": "i"},
            **{k: v for k, v in full_key.items() if k != "sku"},
        }
        inv = await db.wms_inventory.find_one(style_key)
    # Loose fallback: if caller didn't pass meta, match by the legacy 4-field
    # key so picks/moves that don't know fabric/COO still find existing rows.
    if not inv and (not fabric_content and not country_of_origin):
        loose_key = {"sku": sku, "color": color or "", "size": size or "", "location": location or ""}
        inv = await db.wms_inventory.find_one(loose_key)
        if not inv and sku:
            inv = await db.wms_inventory.find_one({
                "style": {"$regex": f"^{re.escape(sku)}$", "$options": "i"},
                **{k: v for k, v in loose_key.items() if k != "sku"},
            })
    if not inv and operation == "add":
        new_inv_id = gen_id("inv")
        await db.wms_inventory.insert_one({
            "sku": sku, "style": sku, "color": color or "", "size": size or "",
            "inventory_id": new_inv_id, "customer": customer,
            "manufacturer": manufacturer or "",
            "description": description or "",
            "country_of_origin": country_of_origin or "",
            "fabric_content": fabric_content or "",
            "location": location, "is_bpo": is_bpo,
            "units_on_hand": qty, "units_allocated": 0, "total_boxes": max(0, int(box_count or 0)),
            "updated_at": now_iso()
        })
        return new_inv_id
    elif inv:
        doc_key = {"_id": inv["_id"]}
        if operation == "add":
            # Backfill empty metadata fields on existing rows so re-receiving
            # the same SKU into the same location heals legacy gaps.
            backfill = {}
            for field, value in (
                ("manufacturer", manufacturer),
                ("description", description),
                ("country_of_origin", country_of_origin),
                ("fabric_content", fabric_content),
            ):
                if value and not (inv.get(field) or "").strip():
                    backfill[field] = value
            await db.wms_inventory.update_one(
                doc_key,
                {
                    "$inc": {"units_on_hand": qty, "total_boxes": max(0, int(box_count or 0))},
                    "$set": {"updated_at": now_iso(), "is_bpo": is_bpo, **backfill},
                },
            )
        elif operation == "allocate":
            await db.wms_inventory.update_one(doc_key, {"$inc": {"units_allocated": qty}, "$set": {"updated_at": now_iso()}})
        elif operation == "deallocate":
            # Guard: allocation can never go below zero.
            new_alloc = max(0, inv.get("units_allocated", 0) - qty)
            await db.wms_inventory.update_one(doc_key, {"$set": {"units_allocated": new_alloc, "updated_at": now_iso()}})
        elif operation == "deduct":
            # ATOMIC deduction (WMS-001). An aggregation-pipeline update lets a
            # SINGLE document operation subtract-and-clamp-at-zero, so two
            # concurrent picks can no longer both read the same units_on_hand and
            # lose an update (the RP04-B42 oversell). True oversell is blocked
            # up-front by _assert_pick_stock(); this clamp is the last-resort
            # guard that keeps a row from ever going negative under a race.
            updated = await db.wms_inventory.find_one_and_update(
                doc_key,
                [{"$set": {
                    "units_on_hand": {"$max": [0, {"$subtract": ["$units_on_hand", qty]}]},
                    "units_allocated": {"$max": [0, {"$subtract": ["$units_allocated", qty]}]},
                    "updated_at": now_iso(),
                }}],
                return_document=ReturnDocument.AFTER,
            )
            new_hand = int((updated or {}).get("units_on_hand", 0) or 0)

            # WMS 2.0 Cycle Count Trigger
            if new_hand < 50:
                existing_cc = await db.wms_tasks.find_one({"task_type": "cycle_count", "context.sku": sku, "status": "pending"})
                if not existing_cc:
                    await db.wms_tasks.insert_one({
                        "task_id": gen_id("tsk"), "task_type": "cycle_count", "priority": "HIGH", "status": "pending",
                        "assigned_to": None, "context": {"sku": sku, "suggested_zone": location, "reason": "Threshold breach (<50)"},
                        "created_at": now_iso(),
                    })
        elif operation == "pick_to_neck":
            # 1. ATOMIC deduct-and-clamp from the current shelf (same race-free
            #    guard as "deduct" above).
            await db.wms_inventory.find_one_and_update(
                doc_key,
                [{"$set": {
                    "units_on_hand": {"$max": [0, {"$subtract": ["$units_on_hand", qty]}]},
                    "units_allocated": {"$max": [0, {"$subtract": ["$units_allocated", qty]}]},
                    "updated_at": now_iso(),
                }}],
            )
            # 2. Add to CUTTING_NECK (keep it allocated/reserved for the order)
            # Use the same sku/style as the source record for consistency
            inv_sku = inv.get("sku") or inv.get("style") or sku
            neck_key = {"sku": inv_sku, "color": color or "", "size": size or "", "location": "CUTTING_NECK"}
            await db.wms_inventory.update_one(
                neck_key,
                {"$inc": {"units_on_hand": qty, "units_allocated": qty}, "$set": {"updated_at": now_iso(), "customer": customer, "style": inv.get("style", sku)}},
                upsert=True
            )
        # Surface the inventory_id so callers (e.g. receiving) can link the
        # boxes they just created to the inventory row that holds them.
        return inv.get("inventory_id")
    return None


async def _update_inventory(sku, color, size, qty, operation="add", location=""):
    # Standard fallback for old calls
    await _update_inventory_enhanced(sku, color, size, qty, operation, location=location)

@router.get("/inventory")
async def get_inventory(
    request: Request,
    sku: str = "", color: str = "", size: str = "", location: str = "",
    customer: str = "", category: str = "", style: str = "",
    description: str = "", country_of_origin: str = "", fabric_content: str = "",
    paginated: bool = False, skip: int = 0, limit: int = 5000,
    exclude_hold: bool = False,
):
    """List inventory rows.
      - Default (legacy): returns bare array, all rows up to 5000.
      - paginated=true   : returns { items, total, has_more } with skip/limit.
                            Allows the UI to load in chunks without freezing.
    """
    await require_auth(request)
    query = {}
    if sku: query["sku"] = {"$regex": sku, "$options": "i"}
    if style: query["style"] = {"$regex": style, "$options": "i"}
    if color: query["color"] = {"$regex": color, "$options": "i"}
    if size: query["size"] = {"$regex": size, "$options": "i"}
    if customer: query["customer"] = {"$regex": customer, "$options": "i"}
    if category == "LOW_STOCK":
        query["units_on_hand"] = {"$lte": 10, "$gt": 0}
    elif category:
        query["category"] = {"$regex": category, "$options": "i"}
    if location: query["location"] = {"$regex": location, "$options": "i"}
    if description: query["description"] = {"$regex": description, "$options": "i"}
    if country_of_origin: query["country_of_origin"] = {"$regex": country_of_origin, "$options": "i"}
    if fabric_content: query["fabric_content"] = {"$regex": fabric_content, "$options": "i"}
    # Optionally hide stock parked in SAT-held locations.
    if exclude_hold and not location:
        held = await _hold_location_names()
        if held:
            query["location"] = {"$nin": list(held)}

    skip = max(0, skip)
    limit = max(1, min(limit, 5000))

    # Use aggregation to project/alias for frontend compatibility
    pipeline = [
        {"$match": query},
        {"$sort": {"sku": 1}},
        {"$skip": skip},
        {"$limit": limit},
        {"$project": {
            "_id": 0,
            "inventory_id": 1,  # needed so the Locations modal can link items to their LPNs
            "sku": 1,
            "style": 1,
            "color": 1,
            "size": 1,
            "description": 1,
            "customer": 1,
            "manufacturer": 1,
            "category": 1,
            "location": 1,
            "total_boxes": 1,
            "last_updated": 1,
            "country_of_origin": 1,
            "fabric_content": 1,
            "size_header": 1,
            "po": 1,
            "bpo": 1,
            "import_number": 1,
            "on_hand": "$units_on_hand",
            "allocated": "$units_allocated",
            "available": {"$subtract": ["$units_on_hand", "$units_allocated"]},
            "inv_location": "$location",
            "units_on_hand": 1,
            "units_allocated": 1,
        }},
    ]
    inventory = await db.wms_inventory.aggregate(pipeline).to_list(limit)

    if not paginated:
        return inventory

    total = await db.wms_inventory.count_documents(query)
    return {"items": inventory, "total": total, "has_more": (skip + len(inventory)) < total}

@router.get("/inventory/filters")
async def inventory_filters_v2(request: Request):
    """Return unique filter values for inventory dropdowns."""
    await require_auth(request)
    customers = await db.wms_inventory.distinct("customer")
    categories = await db.wms_inventory.distinct("category")
    manufacturers = await db.wms_inventory.distinct("manufacturer")
    styles = await db.wms_inventory.distinct("style")

    # If the admin curated a country catalog, use that as the authoritative
    # list. Otherwise fall back to inventory distinct, filtering out leaked
    # fabric-content rows (anything with "%").
    curated_countries = await db.wms_catalog_options.find(
        {"type": "countries"}, {"_id": 0, "value": 1}
    ).to_list(2000)
    curated_country_vals = [c["value"] for c in curated_countries if c.get("value")]
    if curated_country_vals:
        country_list = curated_country_vals
    else:
        raw_countries = await db.wms_inventory.distinct("country_of_origin")
        country_list = [c for c in raw_countries if c and "%" not in c]

    raw_fabrics = await db.wms_inventory.distinct("fabric_content")
    fabrics = sorted([f for f in raw_fabrics if f and isinstance(f, str)])

    return {
        "customers": sorted([c for c in customers if c]),
        "categories": sorted([c for c in categories if c]),
        "manufacturers": sorted([m for m in manufacturers if m]),
        "styles": sorted([s for s in styles if s]),
        "countries": sorted(country_list),
        "fabrics": fabrics,
    }

_STYLE_INFO_CACHE = {}  # {style_upper: (timestamp, payload)}
_STYLE_INFO_TTL = 60.0


@router.get("/inventory/style-info")
async def inventory_style_info(request: Request, style: str = ""):
    """Cascade data for the manual-entry modal: given a style, returns the
    distinct colors and sizes already in inventory, plus the "template" fields
    (customer, description, country_of_origin, category) taken from an existing
    row. One aggregation round-trip + 60s in-process cache so repeated clicks
    on the same style are instant.
    """
    await require_auth(request)
    if not style:
        raise HTTPException(400, "Style requerido")

    import time
    key = style.strip().upper()
    cached = _STYLE_INFO_CACHE.get(key)
    if cached and (time.monotonic() - cached[0]) < _STYLE_INFO_TTL:
        return cached[1]

    # Exact match on the upper-cased value: import_inventory stores everything
    # already upper-cased, so equality is fine and lets the index kick in.
    match = {"$or": [{"style": key}, {"sku": key}]}
    pipeline = [
        {"$match": match},
        {"$group": {
            "_id": None,
            "colors": {"$addToSet": "$color"},
            "sizes": {"$addToSet": "$size"},
            "template": {"$first": "$$ROOT"},
        }},
    ]
    docs = await db.wms_inventory.aggregate(pipeline).to_list(1)
    if not docs:
        raise HTTPException(404, f"No existe inventario para style '{style}'")

    agg = docs[0]
    colors = sorted(c for c in agg.get("colors", []) if c)
    SIZE_ORDER = ['XS', 'S', 'M', 'L', 'XL', '2X', '3X', '4X', '5X', '6X']
    raw_sizes = {s for s in agg.get("sizes", []) if s}
    ordered = [s for s in SIZE_ORDER if s in raw_sizes]
    sizes = ordered + sorted(raw_sizes - set(ordered))
    template = agg.get("template") or {}
    payload = {
        "style": template.get("style") or template.get("sku") or key,
        "colors": colors,
        "sizes": sizes,
        "customer": template.get("customer", ""),
        "description": template.get("description", ""),
        "country_of_origin": template.get("country_of_origin", ""),
        "category": template.get("category", ""),
        "manufacturer": template.get("manufacturer", ""),
        "size_header": template.get("size_header", ""),
        "fabric_content": template.get("fabric_content", ""),
    }
    _STYLE_INFO_CACHE[key] = (time.monotonic(), payload)
    return payload


@router.get("/inventory/locations-lookup")
async def locations_lookup(request: Request, style: str = "", color: str = ""):
    """Lookup inventory locations for a style+color, grouped by size.

    Queries BOTH wms_inventory (permanent locations + Excel imports) AND
    wms_boxes (physical boxes, including putaway/transit/temporary locations)
    so pickers always see stock regardless of where it physically sits.
    """
    await require_auth(request)
    if not style:
        raise HTTPException(400, "Style requerido")

    style_rx = {"$regex": f"^{re.escape(style)}$", "$options": "i"}
    color_rx  = {"$regex": f"^{re.escape(color)}$",  "$options": "i"} if color else None

    # ── 1. wms_inventory (aggregated rows, permanent + Excel) ──────────────
    inv_query = {"$or": [{"style": style_rx}, {"sku": style_rx}]}
    if color_rx:
        inv_query["color"] = color_rx
    records = await db.wms_inventory.find(inv_query, {"_id": 0}).to_list(5000)

    # by_size[sz][loc] = {"available": int, "boxes": int, "customer": str, "country_of_origin": str}
    by_loc: dict[str, dict[str, dict]] = {}  # by_loc[sz][loc] = merged entry

    for r in records:
        sz  = r.get("size", "")
        loc = r.get("location") or r.get("inv_location") or ""
        avail = r.get("units_on_hand", r.get("available", 0)) - r.get("units_allocated", 0)
        if not loc or avail <= 0:
            continue
        by_loc.setdefault(sz, {})
        if loc in by_loc[sz]:
            by_loc[sz][loc]["available"] += avail
            by_loc[sz][loc]["boxes"]     += r.get("total_boxes", 0)
        else:
            by_loc[sz][loc] = {
                "location": loc, "available": avail,
                "boxes": r.get("total_boxes", 0),
                "customer": r.get("customer", ""),
                "country_of_origin": r.get("country_of_origin", ""),
                "_from_boxes": False,
            }

    # ── 2. wms_boxes (physical boxes — covers putaway / transit / temp locs) ─
    box_query = {
        "$or": [{"sku": style_rx}, {"style": style_rx}],
        "units": {"$gt": 0},
        "location": {"$exists": True, "$ne": ""},
    }
    if color_rx:
        box_query["color"] = color_rx
    boxes = await db.wms_boxes.find(
        box_query, {"_id": 0, "size": 1, "location": 1, "units": 1, "qty": 1, "customer": 1, "country_of_origin": 1}
    ).to_list(5000)

    for b in boxes:
        sz  = b.get("size", "")
        loc = b.get("location", "")
        units = int(b.get("units") or b.get("qty") or 0)
        if not loc or units <= 0:
            continue
        by_loc.setdefault(sz, {})
        if loc in by_loc[sz]:
            # Location already covered by wms_inventory — don't double-count;
            # only bump if the box count actually exceeds what inventory says
            # (signals an out-of-sync row — trust the higher value).
            existing = by_loc[sz][loc]
            if not existing["_from_boxes"]:
                pass  # trust wms_inventory for this location
        else:
            # Location NOT in wms_inventory → add from boxes (putaway / transit)
            if loc not in by_loc[sz]:
                by_loc[sz][loc] = {
                    "location": loc, "available": 0,
                    "boxes": 0, "customer": b.get("customer", ""),
                    "country_of_origin": b.get("country_of_origin", ""),
                    "_from_boxes": True,
                }
            by_loc[sz][loc]["available"] += units
            by_loc[sz][loc]["boxes"]     += 1

    # ── 3. Build final response ────────────────────────────────────────────
    by_size: dict = {}
    for sz, locs_dict in by_loc.items():
        locs = [
            {k: v for k, v in e.items() if k != "_from_boxes"}
            for e in locs_dict.values() if e["available"] > 0
        ]
        locs.sort(key=lambda x: -x["available"])
        total_avail = sum(l["available"] for l in locs)
        total_boxes = sum(l["boxes"] for l in locs)
        for l in locs:
            l["percentage"] = round((l["available"] / total_avail) * 100) if total_avail else 0
        by_size[sz] = {"size": sz, "locations": locs, "total_available": total_avail, "total_boxes": total_boxes}

    return {"style": style, "color": color, "sizes": by_size}

@router.get("/inventory/options")
async def inventory_options(request: Request, customer: str = "", manufacturer: str = "", style: str = ""):
    """Return unique dropdown values from inventory, case-insensitive dedup, filtered by customer and cascading."""
    await require_auth(request)
    base = {}
    # The user requested to see ALL items from the WMS excel (wms_inventory), 
    # so we must NOT filter by customer, as it hides options if the order client name
    # doesn't match the wms_inventory customer name exactly.
    # if customer:
    #     base["customer"] = {"$regex": f"^{customer}$", "$options": "i"}

    # Manufacturers: filter by customer only
    mfr_match = {k: v for k, v in base.items()}
    mfr_pipeline = [
        {"$match": mfr_match},
        {"$group": {"_id": {"$toLower": "$manufacturer"}, "val": {"$first": "$manufacturer"}}},
        {"$match": {"_id": {"$ne": ""}}},
        {"$sort": {"_id": 1}}
    ]

    # Styles: no cascaded filters, show all
    style_match = {k: v for k, v in base.items()}
    style_pipeline = [
        {"$match": style_match},
        {"$group": {"_id": {"$toLower": "$style"}, "val": {"$first": "$style"}}},
        {"$match": {"_id": {"$nin": ["", None]}}},
        {"$sort": {"_id": 1}}
    ]

    # Colors: no cascaded filters, show all
    color_match = {k: v for k, v in base.items()}
    color_pipeline = [
        {"$match": color_match},
        {"$group": {"_id": {"$toLower": "$color"}, "val": {"$first": "$color"}}},
        {"$match": {"_id": {"$nin": ["", None]}}},
        {"$sort": {"_id": 1}}
    ]

    # Locations: show all unique locations
    loc_pipeline = [
        {"$group": {"_id": {"$toLower": "$location"}, "val": {"$first": "$location"}}},
        {"$match": {"_id": {"$nin": ["", None]}}},
        {"$sort": {"_id": 1}}
    ]

    mfrs = await db.wms_inventory.aggregate(mfr_pipeline).to_list(5000)
    styles = await db.wms_inventory.aggregate(style_pipeline).to_list(5000)
    colors = await db.wms_inventory.aggregate(color_pipeline).to_list(5000)
    locs = await db.wms_inventory.aggregate(loc_pipeline).to_list(5000)

    # Customers list: Read directly from config_options (same source as MOS Dashboard)
    config = await db.config_options.find_one({"config_id": "main"}, {"clients": 1, "_id": 0})
    merged_customers = sorted(config.get("clients", []), key=lambda s: s.lower()) if config else []

    return {
        "customers": merged_customers,
        "manufacturers": [m["val"] for m in mfrs if m and m.get("val")],
        "styles": [s["val"] for s in styles if s and s.get("val")],
        "colors": [c["val"] for c in colors if c and c.get("val")],
        "locations": [l["val"] for l in locs if l and l.get("val")]
    }

@router.get("/movements/summary")
async def inventory_summary(request: Request, customer: str = ""):
    await require_auth(request)
    match_query = {}
    if customer:
        match_query["customer"] = {"$regex": customer, "$options": "i"}
    
    pipeline = [
        {"$match": match_query},
        {"$group": {
            "_id": None,
            "total_on_hand": {"$sum": "$units_on_hand"},
            "total_allocated": {"$sum": "$units_allocated"},
            "total_available": {"$sum": {"$subtract": ["$units_on_hand", "$units_allocated"]}},
            "total_skus": {"$sum": 1},
            "total_boxes_sum": {"$sum": "$total_boxes"}
        }}
    ]
    result = await db.wms_inventory.aggregate(pipeline).to_list(1)
    agg = result[0] if result else {}
    
    # Locations count depends on the same customer filter if specified
    if customer:
        total_locations = len(await db.wms_inventory.distinct("location", match_query))
    else:
        total_locations = await db.wms_locations.count_documents({"active": True})
        
    low_stock_query = {"units_on_hand": {"$lte": 10, "$gt": 0}}
    if customer:
        low_stock_query["customer"] = {"$regex": customer, "$options": "i"}
        
    low_stock = await db.wms_inventory.find(
        low_stock_query, {"_id": 0}
    ).sort("units_on_hand", 1).to_list(20)
    
    summary = {
        "total_on_hand": agg.get("total_on_hand", 0),
        "total_allocated": agg.get("total_allocated", 0),
        "total_available": agg.get("total_available", 0),
        "total_skus": agg.get("total_skus", 0),
        "total_boxes": agg.get("total_boxes_sum", 0),
        "total_locations": total_locations,
        "low_stock_items": len(low_stock),
        "low_stock": low_stock
    }
    return summary

@router.get("/inventory/summary")
async def inventory_summary_alias(request: Request, customer: str = ""):
    """Explicitly support the InventoryModule's summary call path."""
    return await inventory_summary(request, customer)

@router.get("/inventory/chart-data")
async def get_inventory_chart_data(request: Request, customer: str = ""):
    await require_auth(request)
    match_query = {}
    if customer:
        match_query["customer"] = {"$regex": customer, "$options": "i"}

    # 1. Top 10 SKUs by total available units
    top_skus_pipeline = [
        {"$match": match_query},
        {"$group": {"_id": "$sku", "available": {"$sum": "$units_on_hand"}}},
        {"$sort": {"available": -1}},
        {"$limit": 10},
        {"$project": {"name": "$_id", "value": "$available", "_id": 0}}
    ]
    top_skus = await db.wms_inventory.aggregate(top_skus_pipeline).to_list(10)

    # 2. Units by Status/State (Finished Goods vs Raw vs WIP) — queried from wms_boxes
    box_match = {}
    if customer:
        box_match["customer"] = {"$regex": customer, "$options": "i"}
    state_pipeline = [
        {"$match": box_match},
        {"$group": {"_id": "$status", "count": {"$sum": "$qty"}}},
        {"$match": {"_id": {"$ne": None}}},
        {"$project": {"name": {"$ifNull": ["$_id", "unknown"]}, "value": "$count", "_id": 0}}
    ]
    by_state = await db.wms_boxes.aggregate(state_pipeline).to_list(10)

    # 3. Units by Manufacturer/Category
    cat_pipeline = [
        {"$match": match_query},
        {"$group": {"_id": "$manufacturer", "count": {"$sum": "$units_on_hand"}}},
        {"$sort": {"count": -1}},
        {"$limit": 8},
        {"$project": {"name": "$_id", "value": "$count", "_id": 0}}
    ]
    by_manufacturer = await db.wms_inventory.aggregate(cat_pipeline).to_list(8)

    # 4. Activity History (last 15 days)
    # We group movements by day. We filter movements by customer if details.customer matches
    from datetime import timedelta
    cutoff_date = (datetime.now(timezone.utc) - timedelta(days=15)).strftime("%Y-%m-%d")
    movement_query = {"created_at": {"$gte": cutoff_date}}
    if customer:
        movement_query["$or"] = [
            {"details.customer": {"$regex": customer, "$options": "i"}},
            {"details.receiving_id": {"$exists": True}}  # Always include receiving events
        ]

    # Activity count by day for last 15 days
    activity_pipeline = [
        {"$match": movement_query},
        {"$addFields": {"date": {"$substr": ["$created_at", 0, 10]}}},
        {"$group": {"_id": "$date", "count": {"$sum": 1}}},
        {"$sort": {"_id": 1}},
        {"$limit": 15},
        {"$project": {"date": "$_id", "count": 1, "_id": 0}}
    ]
    activity_history = await db.wms_movements.aggregate(activity_pipeline).to_list(15)

    return {
        "top_skus": top_skus,
        "by_state": by_state,
        "by_manufacturer": by_manufacturer,
        "activity_history": activity_history
    }

# ==================== ORDERS (from CRM) ====================

@router.get("/orders")
async def list_wms_orders(request: Request, status: str = ""):
    await require_auth(request)
    # Broaden query: include orders from relevant boards for WMS
    # Logic: include anything in scheduling/blanks, or with wms activity
    query = {"$or": [
        {"board": {"$regex": "^blanks$|^crm$|^ventas$|^sales$|^scheduling$|^production$|^final bill$", "$options": "i"}},
        {"blank_status": {"$regex": "partial|parcial|pending|ready|todo|picked", "$options": "i"}},
        {"wms_status": {"$exists": True}}
    ]}
    if status:
        query["wms_status"] = status
    orders = await db.orders.find(query, {"_id": 0}).sort("created_at", -1).to_list(1000)
    return orders

@router.get("/orders/{order_id}")
async def get_wms_order(order_id: str, request: Request):
    await require_auth(request)
    order = await db.orders.find_one({"order_id": order_id}, {"_id": 0})
    if not order:
        order = await db.orders.find_one({"order_number": order_id}, {"_id": 0})
    if not order:
        raise HTTPException(404, "Orden no encontrada")
    allocations = await db.wms_allocations.find({"order_id": order.get("order_id")}, {"_id": 0}).to_list(100)
    order["allocations"] = allocations
    return order

# ==================== ALLOCATION ====================


@router.post("/allocations")
@router.post("/stocktakes")
async def create_allocation(request: Request):
    user = await require_auth(request)
    body = await request.json()
    order_id = body.get("order_id", "").strip()
    items = body.get("items", [])
    if not order_id or not items:
        raise HTTPException(400, "order_id e items requeridos")
    order = await db.orders.find_one({"$or": [{"order_id": order_id}, {"order_number": order_id}]})
    if not order:
        raise HTTPException(404, "Orden no encontrada")
    allocation_id = gen_id("alloc")
    alloc_items = []
    for item in items:
        sku = item.get("sku", "")
        color = item.get("color", "")
        size = item.get("size", "")
        qty = int(item.get("qty", 0))
        inv = await db.wms_inventory.find_one({"sku": sku, "color": color, "size": size})
        if not inv or inv.get("available", 0) < qty:
            raise HTTPException(400, f"Inventario insuficiente para {sku} {color} {size}. Disponible: {inv.get('available', 0) if inv else 0}")
        await _update_inventory(sku, color, size, qty, "allocate")
        alloc_items.append({"sku": sku, "color": color, "size": size, "qty": qty})
    alloc_doc = {
        "allocation_id": allocation_id,
        "order_id": order.get("order_id"),
        "order_number": order.get("order_number"),
        "items": alloc_items,
        "status": "allocated",
        "allocated_by": user.get("user_id"),
        "allocated_by_name": user.get("name", ""),
        "created_at": now_iso(),
    }
    await db.wms_allocations.insert_one(alloc_doc)
    alloc_doc.pop("_id", None)
    await db.orders.update_one({"order_id": order.get("order_id")}, {"$set": {"wms_status": "allocated"}})
    await log_movement(user, "allocation", {"allocation_id": allocation_id, "order_number": order.get("order_number"), "items": alloc_items})
    return alloc_doc

@router.get("/allocations")
async def list_allocations(request: Request, order_id: str = ""):
    await require_auth(request)
    query = {}
    if order_id: query["$or"] = [{"order_id": order_id}, {"order_number": order_id}]
    allocs = await db.wms_allocations.find(query, {"_id": 0}).sort("created_at", -1).to_list(500)
    return allocs

@router.delete("/allocations/{allocation_id}")
async def delete_allocation(allocation_id: str, request: Request):
    user = await require_auth(request)
    alloc = await db.wms_allocations.find_one({"allocation_id": allocation_id})
    if not alloc:
        raise HTTPException(404, "Allocation no encontrada")
    for item in alloc.get("items", []):
        await _update_inventory(item["sku"], item.get("color", ""), item.get("size", ""), item["qty"], "deallocate")
    await db.wms_allocations.delete_one({"allocation_id": allocation_id})
    await log_movement(user, "deallocate", {"allocation_id": allocation_id, "order_number": alloc.get("order_number")})
    return {"message": "Allocation eliminada"}

# ==================== PICK TICKETS ====================

# Valid picking strategies — keep in sync with frontend Picking.js dropdown
PICK_STRATEGIES = {"default", "proximity", "origin"}

def _location_sort_key_proximity(loc_obj: dict):
    """Sort by location-name prefix (everything before first '-'), then full name.
    Groups RP01-* together, then RP02-*, etc."""
    name = (loc_obj.get("location") or "").upper()
    prefix = name.split("-", 1)[0] if "-" in name else name
    return (prefix, name)

def _location_sort_key_origin(loc_obj: dict):
    """Group by country_of_origin first, then by location name."""
    coo = (loc_obj.get("country_of_origin") or "").upper() or "ZZZ"  # unknowns last
    name = (loc_obj.get("location") or "").upper()
    return (coo, name)

def apply_picking_strategy(size_locations: dict, strategy: str) -> dict:
    """Reorder the `locations` array inside each size of size_locations
    according to the chosen strategy. Default keeps backend's existing order."""
    if strategy not in {"proximity", "origin"} or not size_locations:
        return size_locations
    key_fn = _location_sort_key_proximity if strategy == "proximity" else _location_sort_key_origin
    for sz_data in size_locations.values():
        if isinstance(sz_data, dict) and "locations" in sz_data:
            sz_data["locations"].sort(key=key_fn)
    return size_locations


async def _compute_size_locations(style: str, color: str, sizes: dict, strategy: str = "default") -> dict:
    """Build {size: {locations:[...], total_available}} from CURRENT inventory.

    Used so pickers always see live availability (not the snapshot captured when
    the ticket was created). Color is matched exactly first; if a size finds no
    location that way it retries with a contains match (handles naming variants
    like 'OLIVE' vs 'OLIVE GREEN') so available stock isn't hidden by a label
    mismatch.
    """
    style = (style or "").strip()
    color = (color or "").strip()
    size_locations: dict = {}
    if not style:
        return size_locations

    async def _run(q):
        recs = await db.wms_inventory.find(
            q, {"_id": 0, "location": 1, "units_on_hand": 1, "units_allocated": 1, "total_boxes": 1, "customer": 1, "country_of_origin": 1}
        ).sort("units_on_hand", -1).to_list(50)
        locs = [{
            "location": r.get("location", ""),
            "available": r.get("units_on_hand", 0) - r.get("units_allocated", 0),
            "boxes": r.get("total_boxes", 0),
            "country_of_origin": r.get("country_of_origin", ""),
        } for r in recs if r.get("location")]
        return [l for l in locs if l["available"] > 0]

    for sz, qty in (sizes or {}).items():
        try:
            qn = int(qty) if qty else 0
        except (TypeError, ValueError):
            qn = 0
        if qn <= 0:
            continue
        base = {
            "$or": [
                {"style": {"$regex": f"^{re.escape(style)}$", "$options": "i"}},
                {"sku": {"$regex": f"^{re.escape(style)}$", "$options": "i"}},
            ],
            "size": {"$regex": f"^{re.escape(sz)}$", "$options": "i"},
            "units_on_hand": {"$gt": 0},
        }
        if color:
            exact = dict(base); exact["color"] = {"$regex": f"^{re.escape(color)}$", "$options": "i"}
            locs = await _run(exact)
            if not locs:
                loose = dict(base); loose["color"] = {"$regex": re.escape(color), "$options": "i"}
                locs = await _run(loose)
        else:
            locs = await _run(base)
        # Merge rows that share the SAME physical location (inventory is also
        # split by country_of_origin/fabric, so one shelf can yield several rows).
        # Without this the picker sees duplicate inputs for the same location and
        # typing in one mirrors the other.
        merged: dict = {}
        for l in locs:
            key = l["location"]
            if key in merged:
                m = merged[key]
                m["available"] += l["available"]
                m["boxes"] += l.get("boxes", 0)
                coo = l.get("country_of_origin")
                if coo and coo not in m["_origins"]:
                    m["_origins"].append(coo)
            else:
                merged[key] = {**l, "_origins": [l["country_of_origin"]] if l.get("country_of_origin") else []}

        # Surface material that lives only as PHYSICAL BOXES — carts (CARRO N),
        # transit and putaway-pending slots — so the picker sees stock wherever it
        # physically sits, even when no inventory row backs it (or the row drifted).
        # Shelves already covered by wms_inventory keep the inventory figure; we
        # don't double-count those. Picking from such a location deducts the cart
        # boxes directly (see _deduct_pick_boxes), which is exactly what we want.
        box_q = {
            "$or": [
                {"sku": {"$regex": f"^{re.escape(style)}$", "$options": "i"}},
                {"style": {"$regex": f"^{re.escape(style)}$", "$options": "i"}},
            ],
            "size": {"$regex": f"^{re.escape(sz)}$", "$options": "i"},
            "units": {"$gt": 0},
            "location": {"$exists": True, "$ne": ""},
        }
        if color:
            box_q["color"] = {"$regex": f"^{re.escape(color)}$", "$options": "i"}
        for b in await db.wms_boxes.find(
            box_q, {"_id": 0, "location": 1, "units": 1, "qty": 1, "country_of_origin": 1}
        ).to_list(2000):
            loc = b.get("location", "")
            if not loc or loc in merged:
                continue  # inventory already accounts for this location — trust it
            u = int((b.get("units") if b.get("units") is not None else b.get("qty", 0)) or 0)
            if u <= 0:
                continue
            e = merged.setdefault(loc, {
                "location": loc, "available": 0, "boxes": 0,
                "country_of_origin": b.get("country_of_origin", ""), "_origins": [],
            })
            e["available"] += u
            e["boxes"] += 1
            coo = b.get("country_of_origin")
            if coo and coo not in e["_origins"]:
                e["_origins"].append(coo)

        locs = []
        for m in merged.values():
            m["country_of_origin"] = ", ".join(o for o in m.pop("_origins", []) if o)
            locs.append(m)
        total = sum(l["available"] for l in locs)
        for l in locs:
            l["percentage"] = round((l["available"] / total) * 100) if total > 0 else 0
        size_locations[sz] = {"locations": locs, "total_available": total}

    return apply_picking_strategy(size_locations, strategy if strategy in PICK_STRATEGIES else "default")


async def internal_create_picking_ticket(data: dict, user: dict) -> dict:
    """
    Internal function to create a pick ticket.
    Expected data: order_number, customer, client, manufacturer, style, color, quantity, sizes, board_category, assigned_to...
    """
    ticket_id = gen_id("pick")
    order_number = data.get("order_number", "").strip()
    style = data.get("style", "").strip()
    force_duplicate = bool(data.get("force_duplicate", False))

    # Validation for manual creation might be stricter than automated skeleton
    if not order_number:
        raise HTTPException(400, "Numero de orden requerido")

    # --- Duplicate guard -----------------------------------------------------------
    # Prevent creating multiple active pick tickets for the same order unless the
    # caller explicitly confirms they want a duplicate (force_duplicate=True).
    if not force_duplicate:
        existing = await db.wms_pick_tickets.find_one(
            {
                "order_number": order_number,
                "status": {"$nin": ["confirmed", "cancelled"]},
            },
            {"_id": 0, "ticket_id": 1, "created_by_name": 1, "created_at": 1,
             "style": 1, "color": 1, "total_pick_qty": 1, "status": 1, "picking_status": 1},
        )
        if existing:
            raise HTTPException(
                409,
                {
                    "message": f"Ya existe un pick ticket activo para la orden {order_number}.",
                    "existing_ticket": existing,
                },
            )
    # -------------------------------------------------------------------------------

    sizes = data.get("sizes", {})
    total_qty = sum(int(v) for v in sizes.values() if v)
    if total_qty == 0 and data.get("quantity"):
         total_qty = int(data.get("quantity"))

    style = data.get("style", "").strip()
    color = data.get("color", "").strip()
    
    # Auto-lookup locations for each size from inventory
    size_locations = {}
    if style:
        for sz, qty in sizes.items():
            qty = int(qty) if qty else 0
            if qty > 0:
                inv_query = {
                    "$or": [{"style": {"$regex": f"^{style}$", "$options": "i"}}, {"sku": {"$regex": f"^{style}$", "$options": "i"}}],
                    "size": {"$regex": f"^{sz}$", "$options": "i"},
                    "units_on_hand": {"$gt": 0}
                }
                if color:
                    inv_query["color"] = {"$regex": f"^{re.escape(color)}$", "$options": "i"}
                inv_records = await db.wms_inventory.find(inv_query, {"_id": 0, "location": 1, "units_on_hand": 1, "units_allocated": 1, "total_boxes": 1, "customer": 1, "country_of_origin": 1}).sort("units_on_hand", -1).to_list(50)
                locs = [{"location": r.get("location", ""), "available": r.get("units_on_hand", 0) - r.get("units_allocated", 0), "boxes": r.get("total_boxes", 0), "country_of_origin": r.get("country_of_origin", "")} for r in inv_records if r.get("location")]
                locs = [l for l in locs if l["available"] > 0]
                total_sz_avail = sum(l["available"] for l in locs)
                for l in locs:
                    l["percentage"] = round((l["available"] / total_sz_avail) * 100) if total_sz_avail > 0 else 0
                size_locations[sz] = {"locations": locs, "total_available": total_sz_avail}

    # Apply picking strategy (proximity / origin / default)
    strategy = data.get("strategy", "default")
    if strategy not in PICK_STRATEGIES:
        strategy = "default"
    size_locations = apply_picking_strategy(size_locations, strategy)

    assigned_to = data.get("assigned_to", "").strip()
    assigned_to_name = data.get("assigned_to_name", "").strip()

    ticket_doc = {
        "ticket_id": ticket_id,
        "order_number": order_number,
        "customer": data.get("customer", "").strip(),
        "client": data.get("client", "").strip(),
        "manufacturer": data.get("manufacturer", "").strip(),
        "style": style,
        "color": data.get("color", "").strip(),
        "quantity": int(data.get("quantity", 0)),
        "sizes": sizes,
        "size_locations": size_locations,
        "strategy": strategy,
        "total_pick_qty": total_qty,
        "status": "pending",
        "board_category": data.get("board_category", "UNSET"),
        "destination": data.get("destination", "production"),
        "blank_status": data.get("blank_status", ""),
        "picking_status": "assigned" if assigned_to else "unassigned",
        "assigned_to": assigned_to or None,
        "assigned_to_name": assigned_to_name or None,
        "assigned_at": now_iso() if assigned_to else None,
        "picked_sizes": {},
        "created_by": user.get("user_id"),
        "created_by_name": user.get("name", ""),
        "created_at": now_iso(),
        "sla_deadline": (datetime.now(timezone.utc) + timedelta(hours=24)).isoformat(),
        "sla_status": "on_time"
    }

    await db.wms_pick_tickets.insert_one(ticket_doc)
    ticket_doc.pop("_id", None)
    
    await log_movement(user, "pick_ticket_created", {"ticket_id": ticket_id, "order_number": order_number})
    
    if assigned_to:
        await ws_manager.broadcast("ticket_assigned", {
            "ticket_id": ticket_id,
            "assigned_to": assigned_to,
            "assigned_to_name": assigned_to_name,
            "order_number": order_number,
            "message": f"Nuevo pick ticket: {ticket_id} (PO: {order_number})"
        })
    
    return ticket_doc

@router.post("/pick-tickets")
@router.post("/move-stock")
async def create_pick_ticket(request: Request):
    user = await require_auth(request)
    body = await request.json()
    
    allocation_id = body.get("allocation_id", "").strip()
    if allocation_id:
        # Legacy allocation-based flow
        alloc = await db.wms_allocations.find_one({"allocation_id": allocation_id}, {"_id": 0})
        if not alloc:
            raise HTTPException(404, "Allocation no encontrada")
        ticket_id = gen_id("pick")
        pick_lines = []
        for item in alloc.get("items", []):
            boxes = await db.wms_boxes.find({
                "sku": item["sku"], "color": item.get("color", ""), "size": item.get("size", ""),
                "status": "stored", "state": "raw"
            }, {"_id": 0}).sort("seq_num", 1).to_list(100)
            remaining = item["qty"]
            for box in boxes:
                if remaining <= 0:
                    break
                pick_qty = min(box["units"], remaining)
                pick_lines.append({
                    "box_id": box["box_id"], "sku": item["sku"],
                    "color": item.get("color", ""), "size": item.get("size", ""),
                    "location": box.get("location", ""), "qty": pick_qty
                })
                remaining -= pick_qty
        ticket_doc = {
            "ticket_id": ticket_id, "allocation_id": allocation_id,
            "order_id": alloc.get("order_id"), "order_number": alloc.get("order_number"),
            "lines": pick_lines, "status": "pending",
            "created_by": user.get("user_id"),
            "created_by_name": user.get("name", ""),
            "created_at": now_iso(),
        }
        await db.wms_pick_tickets.insert_one(ticket_doc)
        ticket_doc.pop("_id", None)
        await log_movement(user, "pick_ticket_created", {"ticket_id": ticket_id, "order_number": ticket_doc.get("order_number", "")})
        await notify_badge_change("picking")
        return ticket_doc
    else:
        result = await internal_create_picking_ticket(body, user)
        await notify_badge_change("picking")
        return result

@router.get("/inventory/field-options")
async def get_inventory_field_options(request: Request):
    """Get unique values for description, country_of_origin, fabric_content from inventory."""
    await require_auth(request)
    desc_pipeline = [
        {"$match": {"description": {"$ne": None, "$nin": ["", "."]}}},
        {"$group": {"_id": {"$toLower": "$description"}, "val": {"$first": "$description"}}},
        {"$sort": {"_id": 1}}
    ]
    # Some imported Excel rows shifted columns and dumped fabric-content strings
    # ("52% COTTON 48% POLYESTER", "100% COTTON", etc.) into country_of_origin.
    # Filter those out so the Receiving "País de origen" dropdown stays clean.
    country_pipeline = [
        {"$match": {
            "country_of_origin": {"$ne": None, "$nin": ["", "."]},
            "$expr": {"$eq": [{"$indexOfCP": ["$country_of_origin", "%"]}, -1]},
        }},
        {"$group": {"_id": {"$toLower": "$country_of_origin"}, "val": {"$first": "$country_of_origin"}}},
        {"$sort": {"_id": 1}}
    ]
    fabric_pipeline = [
        {"$match": {"fabric_content": {"$ne": None, "$nin": ["", "."]}}},
        {"$group": {"_id": {"$toLower": "$fabric_content"}, "val": {"$first": "$fabric_content"}}},
        {"$sort": {"_id": 1}}
    ]
    descs = await db.wms_inventory.aggregate(desc_pipeline).to_list(500)
    countries = await db.wms_inventory.aggregate(country_pipeline).to_list(500)

    # Fabric: merge from wms_inventory + wms_receiving + standard seed list
    fabrics_inv = await db.wms_inventory.aggregate(fabric_pipeline).to_list(500)
    fabrics_rcv = await db.wms_receiving.aggregate(fabric_pipeline).to_list(500)

    FABRIC_SEED = [
        "100% COTTON", "100% POLYESTER", "100% NYLON", "100% RAYON",
        "50% COTTON / 50% POLYESTER", "60% COTTON / 40% POLYESTER",
        "65% POLYESTER / 35% COTTON", "52% COTTON / 48% POLYESTER",
        "90% COTTON / 10% POLYESTER", "80% COTTON / 20% POLYESTER",
        "95% COTTON / 5% SPANDEX", "97% COTTON / 3% SPANDEX",
        "95% POLYESTER / 5% SPANDEX", "88% POLYESTER / 12% SPANDEX",
        "100% COMBED COTTON", "100% RING-SPUN COTTON",
        "50% POLYESTER / 25% COTTON / 25% RAYON",
        "60% COTTON / 40% RAYON", "55% HEMP / 45% COTTON",
        "100% LINEN", "100% BAMBOO", "100% MODAL",
    ]

    seen = set()
    all_fabrics = []
    for f in fabrics_inv:
        key = f["val"].strip().upper()
        if key not in seen:
            seen.add(key)
            all_fabrics.append(key)
    for f in fabrics_rcv:
        key = f["val"].strip().upper()
        if key not in seen:
            seen.add(key)
            all_fabrics.append(key)
    for seed in FABRIC_SEED:
        key = seed.strip().upper()
        if key not in seen:
            seen.add(key)
            all_fabrics.append(key)

    # Merge admin-curated catalog values (case-insensitive)
    catalog_docs = await db.wms_catalog_options.find({}, {"_id": 0, "type": 1, "value": 1}).to_list(2000)
    catalog_by_type = {"descriptions": [], "countries": [], "fabrics": []}
    for d in catalog_docs:
        if d.get("type") in catalog_by_type:
            catalog_by_type[d["type"]].append(d.get("value", ""))

    def merge_unique(base_list, extras):
        s = {v.strip().upper() for v in base_list}
        for x in extras:
            k = (x or "").strip().upper()
            if k and k not in s:
                s.add(k)
                base_list.append(x)
        return base_list

    # If the admin curated a catalog for a given type, that becomes the SOLE
    # source of truth — the inventory distinct (which is full of typos like
    # REPIBLICA / BANGLANDESH / RAPUBLICA DOMINICANA) is ignored. When the
    # catalog is empty we fall back to inventory distinct so existing installs
    # don't suddenly show empty dropdowns.
    def authoritative_or_merge(inv_list, curated):
        curated_clean = [c for c in curated if (c or "").strip()]
        return curated_clean if curated_clean else merge_unique(inv_list, curated_clean)

    descs_list = authoritative_or_merge([d["val"] for d in descs], catalog_by_type["descriptions"])
    countries_list = authoritative_or_merge([c["val"] for c in countries], catalog_by_type["countries"])
    fabrics_list = authoritative_or_merge(all_fabrics, catalog_by_type["fabrics"])

    fabrics_list.sort()
    descs_list.sort(key=lambda x: x.lower())
    countries_list.sort(key=lambda x: x.lower())

    return {
        "descriptions": descs_list,
        "countries": countries_list,
        "fabrics": fabrics_list,
    }

@router.get("/pick-tickets")
async def list_pick_tickets(
    request: Request,
    status: str = "",
    paginated: bool = False, skip: int = 0, limit: int = 1000,
):
    """List pick tickets.
      - Default (legacy): bare array, up to 1000 newest.
      - paginated=true   : { items, total, has_more } using skip/limit.
        Virtual tickets (orders without a ticket) are only added when
        paginated=false OR when skip=0, to keep pagination semantics clean.
    """
    await require_auth(request)
    query = {"status": status} if status else {}

    skip = max(0, skip)
    limit = max(1, min(limit, 1000))

    # Unified aggregation to get tickets + order info in one go
    pipeline = [
        {"$match": query},
        {"$sort": {"created_at": -1}},
        {"$skip": skip},
        {"$limit": limit},
        {"$lookup": {
            "from": "orders",
            "localField": "order_number",
            "foreignField": "order_number",
            "as": "order_data"
        }},
        {"$addFields": {
            "order_info": {"$arrayElemAt": ["$order_data", 0]}
        }},
        {"$project": {
            "_id": 0,
            "order_data": 0
        }}
    ]

    real_tickets = await db.wms_pick_tickets.aggregate(pipeline).to_list(limit)
    
    # Process job titles and other order info
    for rt in real_tickets:
        oi = rt.pop("order_info", None)
        if oi:
            for k in ["job_title_a", "job_title_b"]:
                rt[k] = oi.get(k)
            # Optionally sync more info if needed
            if not rt.get("customer"): rt["customer"] = oi.get("client") or oi.get("branding")
            
    # --- VIRTUAL TICKETS LOGIC ---
    # Synthesize a pre-ticket for every active order that doesn't have a real ticket yet.
    # When paginated, only include them on the first page (skip=0) to keep cursor semantics.
    if (not status or status == "pending") and (not paginated or skip == 0):
        existing_order_numbers = {t.get("order_number") for t in real_tickets if t.get("order_number")}

        # Also exclude admin-dismissed pre-tickets
        dismissed_docs = await db.wms_dismissed_pretickets.find({}, {"_id": 0, "order_number": 1}).to_list(2000)
        dismissed_order_numbers = {d["order_number"] for d in dismissed_docs if d.get("order_number")}
        excluded_order_numbers = list(existing_order_numbers | dismissed_order_numbers)

        virtual_query = {
            "status": {"$nin": ["cancelled", "shipped", "completed", "COMPLETADO", "CERRADO"]},
            "wms_status": {"$ne": "picked"},
            # Orders that already finished picking (or never need it) must NOT resurface
            # as pre-tickets. Terminal/backup/shipped/inventory boards are excluded.
            # (case-insensitive; orders with no board still pass.)
            "board": {"$not": {"$regex": r"(?i)^\s*(FINAL BILL|COMPLETOS|CANCELLED|PAPELERA|RESPALDO MONDAY|EDI|INVENTARIO)\b"}},
            "order_number": {"$nin": excluded_order_numbers}
        }
        
        # Limit to 500 to avoid performance issues
        virtual_orders = await db.orders.find(virtual_query, {"_id": 0}).sort("created_at", -1).to_list(500)
        
        for vo in virtual_orders:
            real_tickets.append({
                "ticket_id": f"virt_{vo.get('order_id')}",
                "order_number": vo.get("order_number"),
                "customer": vo.get("client") or vo.get("customer") or vo.get("branding") or "No Client",
                "client": vo.get("client") or vo.get("customer") or vo.get("branding"),
                "manufacturer": vo.get("manufacturer") or vo.get("branding"),
                "style": vo.get("style") or vo.get("garment_style") or "",
                "color": vo.get("color") or vo.get("garment_color") or "",
                "sizes": vo.get("sizes", {}),
                "quantity": vo.get("quantity") or 0,
                "total_pick_qty": vo.get("quantity") or 0,
                "status": "pending",
                "blank_status": vo.get("blank_status") or "PENDIENTE",
                "picking_status": "unassigned",
                "board_category": vo.get("board", "UNSET").upper(),
                "destination": "neck_cutting" if vo.get("art_neck_status") else "production",
                "job_title_a": vo.get("job_title_a"),
                "job_title_b": vo.get("job_title_b"),
                "created_at": vo.get("created_at") or now_iso(),
                "is_virtual": True
            })

    # Sort the combined list by created_at descending so newest orders/tickets appear first
    real_tickets.sort(key=lambda x: x.get("created_at", ""), reverse=True)

    if not paginated:
        return real_tickets

    total = await db.wms_pick_tickets.count_documents(query)
    # has_more is based on real tickets only; virtual tickets are computed every call
    has_more = (skip + len(real_tickets)) < total
    return {"items": real_tickets, "total": total, "has_more": has_more}

@router.put("/pick-tickets/virtual/{order_number}/dismiss")
async def dismiss_preticket(order_number: str, request: Request):
    """Admin-only: permanently hide a virtual pre-ticket (order without a real pick ticket).
    Stores the order_number in wms_dismissed_pretickets so the virtual query excludes it."""
    user = await require_auth(request)
    role = user.get("role", "")
    if role not in ("admin", "supersu", "ceo"):
        raise HTTPException(status_code=403, detail="Solo administradores pueden eliminar pre-tickets")
    
    # Idempotent upsert — safe to call multiple times
    await db.wms_dismissed_pretickets.update_one(
        {"order_number": order_number},
        {"$set": {
            "order_number": order_number,
            "dismissed_by": user.get("user_id"),
            "dismissed_by_name": user.get("name", ""),
            "dismissed_at": now_iso()
        }},
        upsert=True
    )
    await log_movement(user, "preticket_dismissed", {"order_number": order_number})
    return {"message": "Pre-ticket ocultado correctamente", "order_number": order_number}


@router.post("/pick-tickets/{ticket_id}/incidents")
async def report_incident(ticket_id: str, request: Request):
    user = await require_auth(request)
    body = await request.json()

    ticket = await db.wms_pick_tickets.find_one({"ticket_id": ticket_id})
    if not ticket:
        raise HTTPException(404, "Pick ticket no encontrado")

    replacement_sizes = {k: int(v) for k, v in (body.get("replacement_sizes") or {}).items() if int(v or 0) > 0}
    replacement_qty = sum(replacement_sizes.values())

    incident = {
        "incident_id": gen_id("inc"),
        "ticket_id": ticket_id,
        "order_number": ticket.get("order_number"),
        "sku": body.get("sku"),
        "qty": int(body.get("qty", 1)),
        "reason": body.get("reason", "Dañado"),
        "replacement_sizes": replacement_sizes,
        "replacement_qty": replacement_qty,
        "replacement_description": body.get("replacement_description", ""),
        "notes": body.get("notes", ""),
        "inventory_deducted": False,
        "operator_id": user.get("user_id"),
        "operator_name": user.get("name", user.get("email", "")),
        "timestamp": now_iso()
    }

    # Deduct replacement units from inventory (FIFO por caja)
    if replacement_sizes:
        style = ticket.get("style", "")
        color = ticket.get("color", "")
        deduct_errors = []
        for size, qty in replacement_sizes.items():
            try:
                await _deduct_pick_boxes(
                    style, color, size, location=None, qty=qty,
                    inv_operation="incident_replacement",
                    customer=ticket.get("customer", ""),
                    order_number=ticket.get("order_number"),
                )
            except Exception as e:
                deduct_errors.append(f"{size}: {str(e)}")
        incident["inventory_deducted"] = len(deduct_errors) == 0
        if deduct_errors:
            incident["deduct_errors"] = deduct_errors

    await db.wms_incidents.insert_one(incident)
    await log_movement(user, "incident_reported", {
        "ticket_id": ticket_id,
        "sku": incident["sku"],
        "qty": incident["qty"],
        "replacement_sizes": replacement_sizes,
        "replacement_qty": replacement_qty,
        "inventory_deducted": incident["inventory_deducted"],
    })
    return {
        "message": "Incidencia reportada",
        "incident_id": incident["incident_id"],
        "inventory_deducted": incident["inventory_deducted"],
        "replacement_qty": replacement_qty,
    }

# ==================== OPERATOR MODULE ====================

@router.get("/operators")
async def list_operators(request: Request):
    """List all users with role 'operator' or 'picker'."""
    await require_auth(request)
    operators = await db.users.find({"role": {"$in": ["operator", "picker"]}}, {"_id": 0, "password_hash": 0}).to_list(200)
    
    # Inject Contador 1 alias / virtual user to encapsulate users
    if not any(op.get("user_id") == "contador_1" or op.get("name") == "Contador 1" for op in operators):
        operators.insert(0, {
            "user_id": "contador_1",
            "name": "Contador 1",
            "email": "contador1@mos.system",
            "role": "operator",
            "active": True
        })
    return operators

@router.put("/pick-tickets/{ticket_id}/assign")
async def assign_pick_ticket(ticket_id: str, request: Request):
    """Admin assigns a pick ticket to an operator."""
    user = await require_admin(request)
    body = await request.json()
    operator_id = body.get("operator_id", "").strip()
    operator_name = body.get("operator_name", "").strip()
    if not operator_id:
        raise HTTPException(400, "operator_id requerido")
    result = await db.wms_pick_tickets.update_one(
        {"ticket_id": ticket_id},
        {"$set": {
            "assigned_to": operator_id,
            "assigned_to_name": operator_name,
            "picking_status": "assigned",
            "assigned_at": now_iso()
        }}
    )
    if result.matched_count == 0:
        raise HTTPException(404, "Pick ticket no encontrado")
    await log_movement(user, "pick_ticket_assigned", {"ticket_id": ticket_id, "operator_id": operator_id, "operator_name": operator_name})
    # Notify operator in real-time via WebSocket
    await ws_manager.broadcast("ticket_assigned", {
        "ticket_id": ticket_id,
        "assigned_to": operator_id,
        "assigned_to_name": operator_name,
        "message": f"Nuevo ticket asignado: {ticket_id}"
    })
    return {"message": f"Ticket {ticket_id} asignado a {operator_name}", "ticket_id": ticket_id}

@router.get("/operator/my-tickets")
async def get_operator_tickets(request: Request):
    """Get pick tickets assigned to the current operator."""
    user = await require_auth(request)
    user_id = user.get("user_id", "")
    email = user.get("email", "")
    # Match by user_id or email
    query = {
        "$or": [{"assigned_to": user_id}, {"assigned_to": email}],
        "status": {"$ne": "confirmed"}
    }
    tickets = await db.wms_pick_tickets.find(query, {"_id": 0}).sort("assigned_at", -1).to_list(200)
    # Refresh available pick locations from CURRENT inventory so the operator
    # always sees where the stock actually is now (the stored size_locations is
    # only a snapshot taken when the ticket was created).
    # Recompute in parallel (was sequential — N round-trips in series for an
    # operator with many tickets). A semaphore bounds concurrency so we don't
    # flood the Mongo connection pool when a picker has a large queue.
    pending = [tk for tk in tickets if tk.get("picking_status") != "completed"]
    sem = asyncio.Semaphore(8)

    async def _attach(tk):
        async with sem:
            try:
                tk["size_locations"] = await _compute_size_locations(
                    tk.get("style", ""), tk.get("color", ""), tk.get("sizes", {}),
                    tk.get("strategy", "default"),
                )
            except Exception as e:
                logger.error(f"[my-tickets] live size_locations failed for {tk.get('ticket_id')}: {e}")

    await asyncio.gather(*[_attach(tk) for tk in pending])
    return tickets

@router.get("/operator/completed-tickets")
async def get_operator_completed_tickets(request: Request):
    """Get completed pick tickets for the current operator."""
    user = await require_auth(request)
    user_id = user.get("user_id", "")
    email = user.get("email", "")
    query = {
        "$or": [{"assigned_to": user_id}, {"assigned_to": email}],
        "picking_status": "completed"
    }
    tickets = await db.wms_pick_tickets.find(query, {"_id": 0}).sort("completed_at", -1).to_list(200)
    return tickets

def _normalize_picked(ps):
    """Flatten a picked_sizes payload into {size: {location: qty}}.

    picked_sizes arrives as either { "S": { "total": 10, "details": {loc: q} } }
    or the simple { "S": 10 }. We collapse it to a per-(size, location) map so the
    incremental deducer can diff it against what was already deducted. The simple
    format (no shelf chosen) lands under location "" (deduct FIFO across shelves)."""
    out = {}
    for sz, data in (ps or {}).items():
        szk = (sz or "").strip()
        if isinstance(data, dict) and "details" in data:
            for loc, q in (data.get("details") or {}).items():
                qi = int(q or 0)
                if qi:
                    out.setdefault(szk, {})[loc] = out.setdefault(szk, {}).get(loc, 0) + qi
        else:
            qi = int(data.get("total", 0)) if isinstance(data, dict) else int(data or 0)
            if qi:
                out.setdefault(szk, {})[""] = out.setdefault(szk, {}).get("", 0) + qi
    return out


@router.put("/pick-tickets/{ticket_id}/pick-progress")
async def save_pick_progress(ticket_id: str, request: Request):
    """Operator saves picking progress (partial or complete)."""
    user = await require_auth(request)
    body = await request.json()
    picked_sizes = body.get("picked_sizes", {})  # { "S": 100, "M": 50, ... }
    is_complete = body.get("is_complete", False)

    ticket = await db.wms_pick_tickets.find_one({"ticket_id": ticket_id}, {"_id": 0})
    if not ticket:
        raise HTTPException(404, "Pick ticket no encontrado")

    # Authorization: an operator may only save progress on a ticket assigned to
    # them. Unassigned tickets are left open (operators never see those in
    # /my-tickets, so this only guards direct API calls). Admin/supersu/ceo bypass.
    assignee = (ticket.get("assigned_to") or "").strip()
    caller_ids = {user.get("user_id", ""), user.get("email", "")}
    elevated = user.get("role") in {"admin", "supersu", "ceo"}
    if assignee and assignee not in caller_ids and not elevated:
        raise HTTPException(403, "Este pick ticket está asignado a otro operador")

    # HOLD guard: stock in a SAT-held location can't be picked until released.
    picked_locs = [loc for d in picked_sizes.values() if isinstance(d, dict)
                   for loc in (d.get("details") or {}).keys()]
    if picked_locs:
        await _assert_not_on_hold(user, *picked_locs)

    # Destination + completeness drive the final status. A partial "complete"
    # must NOT close the ticket (Case# 005): it stays active/in_progress so an
    # admin can reassign it when more material arrives. Only a FULL pick closes.
    is_neck = ticket.get("destination") == "neck_cutting"
    required_total = sum(int(v or 0) for v in (ticket.get("sizes") or {}).values())
    picked_total = sum(
        int((c.get("total") if isinstance(c, dict) else c) or 0)
        for c in picked_sizes.values()
    )
    is_full = required_total > 0 and picked_total >= required_total
    finalize = is_complete and is_full
    partial_close = is_complete and not is_full
    picking_status = ("in_neck_cutting" if is_neck else "completed") if finalize else "in_progress"

    # Idempotency: once a ticket is finalized no more progress is applied here
    # (further changes go through the edit endpoint). Partial tickets stay open so
    # the operator can keep picking — each save only deducts the NEW delta below.
    if ticket.get("status") in ("confirmed", "in_neck_cutting"):
        return {
            "message": "El pick ya fue finalizado; no se aplican más cambios aquí",
            "ticket_id": ticket_id,
            "picking_status": ticket.get("picking_status"),
        }

    update = {
        "picked_sizes": picked_sizes,
        "picking_status": picking_status,
        "partial_closed": partial_close,
        "last_picked_by": user.get("user_id"),
        "last_picked_by_name": user.get("name", user.get("email", "")),
        "last_picked_at": now_iso()
    }
    # INCREMENTAL DEDUCTION (ghost-inventory fix). Stock is deducted AS THE
    # OPERATOR PICKS — on every save, partial or complete — not only at the end.
    # We deduct the DELTA between what's picked now and what was already deducted
    # (tracked in `deducted_map`), so a partial save removes exactly the newly
    # picked units, re-saving the same numbers is a no-op (no double counting),
    # and a correction downward returns those units to the shelf.
    inv_op = "pick_to_neck" if is_neck else "deduct"
    style = ticket.get('style', '').strip()
    color = ticket.get('color', '').strip()
    customer = ticket.get('customer', '')
    _ord_no = ticket.get("order_number")
    _ord_id = ticket.get("order_id")

    new_map = _normalize_picked(picked_sizes)
    old_map = ticket.get("deducted_map") or {}
    pos, neg = [], []
    cells = {(sz, loc) for sz, locs in new_map.items() for loc in locs} | \
            {(sz, loc) for sz, locs in old_map.items() for loc in locs}
    for (sz, loc) in cells:
        d = new_map.get(sz, {}).get(loc, 0) - old_map.get(sz, {}).get(loc, 0)
        if d > 0:
            pos.append((sz, loc, d))
        elif d < 0:
            neg.append((sz, loc, -d))

    # WMS-002: block oversell on the NEW units being pulled now (the delta),
    # before mutating anything (raises 409 + opens a discrepancy task).
    if pos:
        delta_ps = {}
        for sz, loc, d in pos:
            cell = delta_ps.setdefault(sz, {"total": 0, "details": {}})
            cell["details"][loc] = cell["details"].get(loc, 0) + d
            cell["total"] += d
        await _assert_pick_stock(style, color, delta_ps, user)

    # WMS-003: a failure must ABORT the save — never leave the ticket updated with
    # stock not deducted (that was a ghost-inventory source).
    try:
        for sz, loc, d in pos:
            await _deduct_pick_boxes(style, color, sz, loc, d, inv_op, customer, _ord_no, _ord_id)
        for sz, loc, d in neg:
            # Correction downward: return the units to the shelf they came from.
            await _update_inventory_enhanced(style, color, sz, d, "add", location=loc, customer=customer)
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("Error aplicando deducción incremental de picking")
        raise HTTPException(500, "No se pudo actualizar inventario; no se guardó el progreso")

    update["deducted_map"] = new_map

    if finalize:
        # Full pick → close the ticket (to production or neck cutting).
        update["completed_at"] = now_iso()
        update["status"] = "in_neck_cutting" if is_neck else "confirmed"
    elif partial_close:
        # Stock ran out: the picked units were already deducted incrementally
        # above. Record who closed it short and leave it ACTIVE so an admin can
        # reassign it when more material arrives (Case# 005).
        update["partial_closed_at"] = now_iso()
        update["partial_closed_by_name"] = user.get("name", user.get("email", ""))

    await db.wms_pick_tickets.update_one({"ticket_id": ticket_id}, {"$set": update})
    await log_movement(user, "pick_progress", {
        "ticket_id": ticket_id,
        "picking_status": picking_status,
        "partial_closed": partial_close,
        "picked_sizes": picked_sizes
    })
    return {
        "message": "Cerrado parcial — material descontado, el ticket queda activo" if partial_close
                   else f"Progreso guardado ({picking_status})",
        "ticket_id": ticket_id,
        "picking_status": picking_status,
        "partial_closed": partial_close,
        "is_full": is_full,
    }

@router.put("/pick-tickets/{ticket_id}/pick-size")
async def pick_size(ticket_id: str, request: Request):
    """Deduct ONE size the instant the operator OKs it — no need to wait for the
    full pick or a partial close. Scoped strictly to the given size: it diffs
    that size's cells against deducted_map and pulls only the NEW units, so
    re-OKing the same numbers is a no-op (no double counting) and lowering the
    amount returns the difference to the shelf. Other (not-yet-OK'd) sizes are
    never touched. Uses the same _deduct_pick_boxes / _assert_pick_stock guards
    as the incremental save, so boxes and inventory always move in lockstep.

    Body: { size: str, details: { location: qty, ... } }  (location "" = FIFO)
    """
    user = await require_auth(request)
    body = await request.json()
    size = (body.get("size") or "").strip()
    details = {str(k): int(v or 0) for k, v in (body.get("details") or {}).items()}
    if not size:
        raise HTTPException(400, "size requerido")

    ticket = await db.wms_pick_tickets.find_one({"ticket_id": ticket_id}, {"_id": 0})
    if not ticket:
        raise HTTPException(404, "Pick ticket no encontrado")

    # Same authorization as save_pick_progress.
    assignee = (ticket.get("assigned_to") or "").strip()
    caller_ids = {user.get("user_id", ""), user.get("email", "")}
    elevated = user.get("role") in {"admin", "supersu", "ceo"}
    if assignee and assignee not in caller_ids and not elevated:
        raise HTTPException(403, "Este pick ticket está asignado a otro operador")
    if ticket.get("status") in ("confirmed", "in_neck_cutting"):
        raise HTTPException(409, "El pick ya fue finalizado; no se aceptan más descuentos")

    # HOLD guard on the shelves being pulled.
    hold_locs = [l for l in details.keys() if l]
    if hold_locs:
        await _assert_not_on_hold(user, *hold_locs)

    is_neck = ticket.get("destination") == "neck_cutting"
    inv_op = "pick_to_neck" if is_neck else "deduct"
    style = ticket.get("style", "").strip()
    color = ticket.get("color", "").strip()
    customer = ticket.get("customer", "")
    _ord_no = ticket.get("order_number")
    _ord_id = ticket.get("order_id")

    # New cumulative picked_sizes with THIS size replaced by the OK'd numbers.
    picked_sizes = dict(ticket.get("picked_sizes") or {})
    total = sum(details.values())
    required = int((ticket.get("sizes") or {}).get(size, 0) or 0)
    if required and total > required:
        raise HTTPException(400, f"Talla {size}: {total} excede lo requerido ({required})")
    picked_sizes[size] = {"total": total, "details": dict(details)}

    new_map = _normalize_picked(picked_sizes)
    old_map = ticket.get("deducted_map") or {}
    # Restrict the diff to THIS size's cells only.
    cells = {(size, loc) for loc in new_map.get(size, {})} | \
            {(size, loc) for loc in old_map.get(size, {})}
    pos, neg = [], []
    for (sz, loc) in cells:
        d = new_map.get(sz, {}).get(loc, 0) - old_map.get(sz, {}).get(loc, 0)
        if d > 0:
            pos.append((sz, loc, d))
        elif d < 0:
            neg.append((sz, loc, -d))

    # WMS-002: block oversell on the NEW units before mutating anything.
    if pos:
        delta_ps = {}
        for sz, loc, d in pos:
            cell = delta_ps.setdefault(sz, {"total": 0, "details": {}})
            cell["details"][loc] = cell["details"].get(loc, 0) + d
            cell["total"] += d
        await _assert_pick_stock(style, color, delta_ps, user)

    # WMS-003: abort on failure so we never record a deduction that didn't apply.
    try:
        for sz, loc, d in pos:
            await _deduct_pick_boxes(style, color, sz, loc, d, inv_op, customer, _ord_no, _ord_id)
        for sz, loc, d in neg:
            await _update_inventory_enhanced(style, color, sz, d, "add", location=loc, customer=customer)
    except HTTPException:
        raise
    except Exception:
        logger.exception("Error descontando talla en pick-size")
        raise HTTPException(500, "No se pudo descontar la talla; no se guardó")

    # Merge only this size's deducted cells into the map.
    merged_map = {k: dict(v) for k, v in old_map.items()}
    merged_map[size] = new_map.get(size, {})

    await db.wms_pick_tickets.update_one({"ticket_id": ticket_id}, {"$set": {
        "picked_sizes": picked_sizes,
        "deducted_map": merged_map,
        "picking_status": "in_progress",
        "last_picked_by": user.get("user_id"),
        "last_picked_by_name": user.get("name", user.get("email", "")),
        "last_picked_at": now_iso(),
    }})
    await log_movement(user, "pick_size", {"ticket_id": ticket_id, "size": size, "details": details})
    return {"message": f"Talla {size} descontada ({total} pz)", "ticket_id": ticket_id,
            "size": size, "deducted": total}

@router.put("/pick-tickets/{ticket_id}/confirm")
@router.post("/stocktakes/{stocktake_id}/finalize")
async def confirm_pick(ticket_id: str, request: Request, stocktake_id: str = None):
    # Use ticket_id if provided via newer route, else stocktake_id from older legacy route
    target_id = ticket_id or stocktake_id
    user = await require_auth(request)
    body = await request.json()
    confirmed_lines = body.get("lines", [])
    ticket = await db.wms_pick_tickets.find_one({"ticket_id": target_id})
    if not ticket:
        raise HTTPException(404, "Pick ticket no encontrado")

    # Guard: skip if already processed by pick-progress completion
    if ticket.get("status") in ("confirmed", "in_neck_cutting"):
        return {"message": "Pick ya fue procesado previamente", "ticket_id": target_id}

    # If picking already deducted incrementally (pick-progress with deducted_map),
    # inventory is settled — just finalize status, NEVER deduct again here, or the
    # stock would be double-counted.
    if ticket.get("deducted_map"):
        new_status = "in_neck_cutting" if ticket.get("destination") == "neck_cutting" else "confirmed"
        await db.wms_pick_tickets.update_one({"ticket_id": target_id}, {"$set": {
            "status": new_status,
            "picking_status": "completed" if new_status == "confirmed" else "in_neck_cutting",
            "confirmed_at": now_iso(), "confirmed_by": user.get("user_id"),
        }})
        await db.orders.update_one({"order_id": ticket.get("order_id")}, {"$set": {"wms_status": "picked"}})
        await log_movement(user, "pick_confirmed", {"ticket_id": target_id, "items_confirmed": "incremental"})
        await notify_badge_change("picking")
        return {"message": "Pick confirmado", "ticket_id": target_id}

    # HOLD guard: stock in a SAT-held location can't be picked until released.
    confirm_locs = [line.get("location") for line in confirmed_lines if line.get("location")]
    confirm_locs += [loc for d in (ticket.get("picked_sizes") or {}).values()
                     if isinstance(d, dict) for loc in (d.get("details") or {}).keys()]
    if confirm_locs:
        await _assert_not_on_hold(user, *confirm_locs)

    is_neck_cutting = ticket.get("destination") == "neck_cutting"
    inv_operation = "pick_to_neck" if is_neck_cutting else "deduct"

    # Handle confirmed lines (legacy or explicit)
    if confirmed_lines:
        for line in confirmed_lines:
            box_id = line.get("box_id")
            pick_qty = int(line.get("qty", 0))
            box = await db.wms_boxes.find_one({"box_id": box_id})
            if box:
                # Support both 'units' and 'qty' field names
                current_qty = box.get("units") if box.get("units") is not None else box.get("qty", 0)
                new_qty = max(0, current_qty - pick_qty)
                
                # Update box: just reduce units and link to order
                box_update = {
                    "units": new_qty, 
                    "qty": new_qty,
                    "order_number": ticket.get("order_number"),
                    "last_order_id": ticket.get("order_id")
                }
                await db.wms_boxes.update_one({"box_id": box_id}, {"$set": box_update})

                # Move to neck process area OR deduct from global
                _inv_id = await _update_inventory_enhanced(box["sku"], box.get("color", ""), box.get("size", ""), pick_qty, inv_operation, location=box.get("location", ""), customer=box.get("customer", ""))
                # Box emptied out -> drop it from the location's box count.
                if new_qty == 0:
                    await _adjust_inventory_boxes(_inv_id, -1)
    else:
        # Newer flow: deduct from picked_sizes. Delegate to _deduct_pick_boxes —
        # the SAME deducer the incremental PDA flow uses — so the physical boxes
        # AND the inventory row always drop in lockstep. The previous hand-rolled
        # version queried boxes by {"sku": style} (e.g. "5000"), but boxes store
        # the COMPOSITE sku ("5000-CHARCOAL-M") with the short style in `style`;
        # that match found almost nothing and silently fell back to an
        # inventory-only deduct, leaving the physical boxes full → ghost boxes
        # (the boxes↔inventory drift behind the cart discrepancies).
        picked_sizes = ticket.get("picked_sizes") or ticket.get("sizes") or {}
        style = ticket.get("style", "")
        color = ticket.get("color", "")
        order_number = ticket.get("order_number")
        order_id = ticket.get("order_id")
        customer = ticket.get("customer", "")
        # WMS-002: block oversell before deducting anything in this flow too.
        await _assert_pick_stock(style, color, picked_sizes, user)
        for sz, data in picked_sizes.items():
            # Formats: {sz: qty} or {sz: {total: X, details: {loc: q}}}.
            if isinstance(data, dict):
                if "details" in data:
                    for loc, loc_qty in (data.get("details") or {}).items():
                        if int(loc_qty or 0) > 0:
                            await _deduct_pick_boxes(style, color, sz, loc, int(loc_qty),
                                                     inv_operation, customer, order_number, order_id)
                    continue
                qty_to_pick = int(data.get("total", 0))
            else:
                qty_to_pick = int(data or 0)
            # No shelf chosen → FIFO across this SKU's boxes (location="").
            if qty_to_pick > 0:
                await _deduct_pick_boxes(style, color, sz, "", qty_to_pick,
                                         inv_operation, customer, order_number, order_id)

    new_status = "in_neck_cutting" if is_neck_cutting else "confirmed"
    
    await db.wms_pick_tickets.update_one({"ticket_id": target_id}, {"$set": {
        "status": new_status, 
        "picking_status": "completed" if not is_neck_cutting else "in_neck_cutting", 
        "confirmed_at": now_iso(), 
        "confirmed_by": user.get("user_id")
    }})
    await db.orders.update_one({"order_id": ticket.get("order_id")}, {"$set": {"wms_status": "picked"}})
    await log_movement(user, "pick_confirmed", {
        "ticket_id": target_id,
        "items_confirmed": len(confirmed_lines) if confirmed_lines else "auto"
    })
    await notify_badge_change("picking")
    return {"message": "Pick confirmado", "ticket_id": target_id}

@router.put("/pick-tickets/{ticket_id}/edit")
async def edit_pick_ticket(ticket_id: str, request: Request):
    """Edit an existing pick ticket (only if not confirmed/completed)."""
    user = await require_auth(request)
    body = await request.json()
    ticket = await db.wms_pick_tickets.find_one({"ticket_id": ticket_id}, {"_id": 0})
    if not ticket:
        raise HTTPException(404, "Pick ticket no encontrado")
    if ticket.get("status") == "confirmed" or ticket.get("picking_status") == "completed":
        raise HTTPException(400, "No se puede editar un ticket confirmado/completado")

    update = {}
    force_duplicate = bool(body.get("force_duplicate", False))
    new_order_number = body.get("order_number", ticket.get("order_number", "")).strip()

    # --- Duplicate guard for edits -------------------------------------------------
    if not force_duplicate and new_order_number:
        existing = await db.wms_pick_tickets.find_one(
            {
                "order_number": new_order_number,
                "ticket_id": {"$ne": ticket_id},
                "status": {"$nin": ["confirmed", "cancelled"]},
            },
            {"_id": 0, "ticket_id": 1, "created_by_name": 1, "created_at": 1,
             "style": 1, "color": 1, "total_pick_qty": 1, "status": 1, "picking_status": 1},
        )
        if existing:
            raise HTTPException(
                409,
                {
                    "message": f"Ya existe otro pick ticket activo para la orden {new_order_number}.",
                    "existing_ticket": existing,
                },
            )
    # -------------------------------------------------------------------------------

    for field in ["order_number", "customer", "client", "manufacturer", "style", "color", "quantity", "destination"]:
        if field in body:
            update[field] = str(body[field]).strip() if isinstance(body[field], str) else body[field]
    if "sizes" in body:
        update["sizes"] = {k: int(v) for k, v in body["sizes"].items()}
        update["total_pick_qty"] = sum(update["sizes"].values())
    if "assigned_to" in body:
        update["assigned_to"] = body.get("assigned_to") or None
        update["assigned_to_name"] = body.get("assigned_to_name", "")
        if body.get("assigned_to"):
            update["picking_status"] = "assigned"
            update["assigned_at"] = now_iso()
        else:
            update["picking_status"] = "unassigned"
            update["assigned_at"] = None

    # Allow updating the picking strategy
    if "strategy" in body and body["strategy"] in PICK_STRATEGIES:
        update["strategy"] = body["strategy"]

    # Re-lookup locations if style/color changed (also re-apply strategy if changed)
    new_style = update.get("style", ticket.get("style", ""))
    new_color = update.get("color", ticket.get("color", ""))
    needs_relookup = "style" in update or "color" in update
    if needs_relookup:
        size_locations = {}
        new_sizes = update.get("sizes", ticket.get("sizes", {}))
        for sz, qty in new_sizes.items():
            if int(qty) <= 0: continue
            inv_items = await db.wms_inventory.find(
                {"style": {"$regex": f"^{re.escape(new_style)}$", "$options": "i"}, "color": {"$regex": f"^{re.escape(new_color)}$", "$options": "i"}, "size": {"$regex": f"^{re.escape(sz)}$", "$options": "i"}},
                {"_id": 0, "location": 1, "units_on_hand": 1, "units_allocated": 1, "total_boxes": 1, "country_of_origin": 1}
            ).sort("units_on_hand", -1).to_list(50)
            locs = [{"location": it.get("location", ""), "available": it.get("units_on_hand", 0) - it.get("units_allocated", 0), "boxes": it.get("total_boxes", 0), "country_of_origin": it.get("country_of_origin", "")} for it in inv_items if it.get("location")]
            locs = [l for l in locs if l["available"] > 0]
            total_sz_avail = sum(l["available"] for l in locs)
            for l in locs:
                l["percentage"] = round((l["available"] / total_sz_avail) * 100) if total_sz_avail > 0 else 0
            size_locations[sz] = {"locations": locs, "total_available": total_sz_avail}
        update["size_locations"] = size_locations
    # Re-apply strategy if it changed (use freshly-built or existing size_locations)
    if "strategy" in update:
        target = update.get("size_locations") or ticket.get("size_locations") or {}
        update["size_locations"] = apply_picking_strategy(target, update["strategy"])

    update["updated_at"] = now_iso()
    update["updated_by"] = user.get("user_id")
    await db.wms_pick_tickets.update_one({"ticket_id": ticket_id}, {"$set": update})
    await log_movement(user, "pick_ticket_edited", {"ticket_id": ticket_id, "changes": list(update.keys())})
    updated = await db.wms_pick_tickets.find_one({"ticket_id": ticket_id}, {"_id": 0})
    return updated

@router.get("/orders-with-tickets")
async def get_orders_with_tickets(request: Request):
    """Get orders with their pick ticket assignments and progress."""
    await require_auth(request)
    # Get all pick tickets grouped by order_number
    tickets = await db.wms_pick_tickets.find({}, {"_id": 0}).to_list(1000)
    ticket_map = {}
    for t in tickets:
        on = t.get("order_number", "")
        if on not in ticket_map:
            ticket_map[on] = []
        ticket_map[on].append({
            "ticket_id": t.get("ticket_id"),
            "assigned_to_name": t.get("assigned_to_name", ""),
            "picking_status": t.get("picking_status", "unassigned"),
            "status": t.get("status", "pending"),
            "total_pick_qty": t.get("total_pick_qty", 0),
            "picked_sizes": t.get("picked_sizes", {}),
            "sizes": t.get("sizes", {}),
        })
    return ticket_map

@router.get("/pick-tickets/stats")
async def pick_ticket_stats(request: Request):
    """Dashboard stats for picker productivity."""
    await require_auth(request)
    tickets = await db.wms_pick_tickets.find({}, {"_id": 0}).to_list(2000)
    operators_map = {}
    total_completed = 0
    total_in_progress = 0
    total_pending = 0
    for t in tickets:
        ps = t.get("picking_status", "unassigned")
        if ps == "completed": total_completed += 1
        elif ps == "in_progress": total_in_progress += 1
        else: total_pending += 1
        name = t.get("assigned_to_name", "")
        if not name: continue
        if name not in operators_map:
            operators_map[name] = {"name": name, "completed": 0, "in_progress": 0, "assigned": 0, "total_pieces": 0, "picked_pieces": 0}
        op = operators_map[name]
        if ps == "completed": op["completed"] += 1
        elif ps == "in_progress": op["in_progress"] += 1
        else: op["assigned"] += 1
        sizes = t.get("sizes", {})
        picked = t.get("picked_sizes", {})
        op["total_pieces"] += sum(int(v) for v in sizes.values())
        op["picked_pieces"] += sum(int(v) for v in picked.values())
    return {
        "total_tickets": len(tickets),
        "completed": total_completed,
        "in_progress": total_in_progress,
        "pending": total_pending,
        "operators": list(operators_map.values())
    }

# ==================== PRODUCTION ====================

@router.post("/production/move")
async def production_move(request: Request):
    user = await require_auth(request)
    body = await request.json()
    box_ids = body.get("box_ids", [])
    target_state = body.get("target_state", "wip")
    if not box_ids:
        raise HTTPException(400, "box_ids requeridos")
    if target_state not in ["raw", "wip", "finished"]:
        raise HTTPException(400, "target_state debe ser raw, wip o finished")
    moved = []
    for box_id in box_ids:
        box = await db.wms_boxes.find_one({"box_id": box_id})
        if not box:
            continue
        await _assert_not_on_hold(user, box.get("location"))
        old_state = box.get("state", "raw")
        await db.wms_boxes.update_one({"box_id": box_id}, {"$set": {"state": target_state, "status": "in_production" if target_state == "wip" else ("finished" if target_state == "finished" else box.get("status"))}})
        moved.append({"box_id": box_id, "from": old_state, "to": target_state})
    move_doc = {
        "move_id": gen_id("pmov"), "box_ids": box_ids,
        "target_state": target_state, "moved": moved,
        "moved_by": user.get("user_id"),
        "moved_by_name": user.get("name", ""),
        "created_at": now_iso(),
    }
    await db.wms_production_moves.insert_one(move_doc)
    move_doc.pop("_id", None)
    await log_movement(user, "production_move", {"target_state": target_state, "count": len(moved)})
    return move_doc

    return boxes

@router.get("/neck-cutting")
async def list_neck_cutting(request: Request):
    await require_auth(request)
    tickets = await db.wms_pick_tickets.find({"status": "in_neck_cutting"}, {"_id": 0}).sort("order_number", 1).to_list(1000)
    
    grouped = {}
    for t in tickets:
        ono = t.get("order_number") or "SIN_ORDEN"
        if ono not in grouped:
            grouped[ono] = {
                "ticket_id": t.get("ticket_id"),
                "order_number": ono,
                "customer": t.get("customer", ""),
                "style": t.get("style", ""),
                "items": [],
                "total_qty": 0,
                "last_order_id": t.get("order_id")
            }
        
        picked = t.get("picked_sizes", {})
        if not picked:
            picked = t.get("sizes", {})
            
        for sz, data in picked.items():
            qty = 0
            if isinstance(data, dict):
                qty = int(data.get("total", 0))
            else:
                qty = int(data)
                
            if qty > 0:
                # Mock box_id for UI compatibility if needed, but we don't strictly need it 
                # since we are no longer updating box units from the UI here.
                grouped[ono]["items"].append({
                    "sku": t.get("style", ""),
                    "size": sz,
                    "qty": qty,
                    "units": qty,
                    "box_id": f"dummy_{sz}"
                })
                grouped[ono]["total_qty"] += qty
                
    return list(grouped.values())

@router.post("/neck-cutting/deliver")
async def deliver_to_production(request: Request):
    user = await require_auth(request)
    body = await request.json()
    order_number = body.get("order_number")
    
    if not order_number:
        raise HTTPException(400, "order_number requerido")
        
    ticket = await db.wms_pick_tickets.find_one({"order_number": order_number, "status": "in_neck_cutting"})
    if not ticket:
        raise HTTPException(404, "No hay material en Neck Cutting para esta orden")
        
    picked_sizes = ticket.get("picked_sizes") or ticket.get("sizes") or {}
    style = ticket.get("style", "")
    color = ticket.get("color", "")
    
    delivered_count = 0
    for sz, data in picked_sizes.items():
        qty = 0
        if isinstance(data, dict):
            qty = int(data.get("total", 0))
        else:
            qty = int(data)
            
        if qty > 0:
            # REAL DEDUCT from inventory (Final removal from CUTTING_NECK).
            # Match the neck row by EITHER the composite sku or the short style:
            # neck rows have been created under BOTH conventions (the row's sku is
            # whatever the source box carried, often composite like "1717-IVORY-M"),
            # and the old {"sku": style} lookup missed the composite ones — so the
            # deduct fell through to the shelf fallback and left the neck row's
            # reserved units stranded (units_allocated > units_on_hand).
            neck_inv = await db.wms_inventory.find_one({
                "$or": [{"sku": _ci_eq(style)}, {"style": _ci_eq(style)}],
                "color": _ci_eq(color or ""), "size": _ci_eq(sz or ""), "location": "CUTTING_NECK",
            })
            if neck_inv:
                await _update_inventory_enhanced(
                    neck_inv.get("sku") or style, color, sz, qty, "deduct", location="CUTTING_NECK"
                )
            else:
                # FALLBACK: CUTTING_NECK record missing (pick_to_neck never ran)
                # Deduct from original shelf locations using picked_sizes details
                logger.warning(f"Deliver fallback: no CUTTING_NECK record for {style}/{color}/{sz}, deducting from original locations")
                if isinstance(data, dict) and "details" in data:
                    for loc, loc_qty in data["details"].items():
                        if loc_qty > 0:
                            await _update_inventory_enhanced(
                                style, color, sz, loc_qty, "deduct", location=loc
                            )
                else:
                    # Last resort: deduct without location
                    await _update_inventory_enhanced(style, color, sz, qty, "deduct")
            delivered_count += qty
            
    # Mark ticket as completed
    await db.wms_pick_tickets.update_one(
        {"_id": ticket["_id"]}, 
        {"$set": {"status": "confirmed", "picking_status": "completed", "delivered_at": now_iso()}}
    )
        
    await log_movement(user, "neck_cut_delivery", {"order_number": order_number, "qty": delivered_count})
    await notify_badge_change("neck_cutting")
    return {"message": f"Entrega a producción exitosa: {delivered_count} piezas", "order_number": order_number}

# ==================== FINISHED GOODS ====================

@router.get("/finished-goods")
async def list_finished_goods(request: Request, is_bpo: bool = None):
    await require_auth(request)
    query = {"state": "finished"}
    if is_bpo is not None:
        query["is_bpo"] = is_bpo
    boxes = await db.wms_boxes.find(query, {"_id": 0}).sort("created_at", -1).to_list(1000)
    return boxes

@router.put("/finished-goods/{box_id}")
async def edit_finished_good(box_id: str, request: Request):
    user = await require_admin(request)
    body = await request.json()
    update = {k: v for k, v in body.items() if k in ["units", "location", "po", "is_bpo", "sku", "color", "size"]}
    result = await db.wms_boxes.update_one({"box_id": box_id}, {"$set": update})
    if result.matched_count == 0:
        raise HTTPException(404, "Caja no encontrada")
    await log_movement(user, "edit_finished_good", {"box_id": box_id, "changes": update})
    return {"message": "Caja actualizada", "box_id": box_id}

# ==================== SHIPPING ====================

@router.post("/movements")
async def create_shipment(request: Request):
    user = await require_auth(request)
    body = await request.json()
    order_id = body.get("order_id", "")
    box_ids = body.get("box_ids", [])
    pallet = body.get("pallet", "")
    carrier = body.get("carrier", "")
    tracking = body.get("tracking", "")
    if not box_ids:
        raise HTTPException(400, "box_ids requeridos")
    shipment_id = gen_id("ship")
    shipped_boxes = []
    for box_id in box_ids:
        box = await db.wms_boxes.find_one({"box_id": box_id})
        if box:
            await db.wms_boxes.update_one({"box_id": box_id}, {"$set": {"status": "shipped", "shipment_id": shipment_id}})
            shipped_boxes.append({"box_id": box_id, "sku": box.get("sku"), "color": box.get("color"), "size": box.get("size"), "units": box.get("units", 0)})
    total_units = sum(b.get("units", 0) for b in shipped_boxes)
    shipment_doc = {
        "shipment_id": shipment_id, "order_id": order_id,
        "boxes": shipped_boxes, "total_boxes": len(shipped_boxes),
        "total_units": total_units, "pallet": pallet,
        "carrier": carrier, "tracking": tracking,
        "shipped_by": user.get("user_id"),
        "shipped_by_name": user.get("name", ""),
        "created_at": now_iso(),
    }
    await db.wms_shipments.insert_one(shipment_doc)
    shipment_doc.pop("_id", None)
    if order_id:
        await db.orders.update_one({"$or": [{"order_id": order_id}, {"order_number": order_id}]}, {"$set": {"wms_status": "shipped"}})
    await log_movement(user, "shipment", {"shipment_id": shipment_id, "total_boxes": len(shipped_boxes), "total_units": total_units})
    return shipment_doc

@router.get("/shipments")
async def list_shipments(request: Request):
    await require_auth(request)
    ships = await db.wms_shipments.find({}, {"_id": 0}).sort("created_at", -1).to_list(500)
    return ships

# ==================== MOVEMENTS (AUDIT) ====================

@router.get("/movements")
async def list_movements(request: Request, movement_type: str = "", limit: int = 200):
    await require_auth(request)
    query = {}
    if movement_type: query["type"] = movement_type
    movements = await db.wms_movements.find(query, {"_id": 0}).sort("created_at", -1).to_list(limit)
    return movements

# ==================== LABELS (PDF) ====================

@router.get("/labels/box/{box_id}")
async def generate_box_label(box_id: str, request: Request):
    await require_auth(request)
    box = await db.wms_boxes.find_one({"box_id": box_id}, {"_id": 0})
    if not box:
        raise HTTPException(404, "Caja no encontrada")
    from reportlab.lib.pagesizes import landscape
    from reportlab.lib.units import inch, mm
    from reportlab.pdfgen import canvas as pdf_canvas
    import barcode
    from barcode.writer import ImageWriter
    buf = io.BytesIO()
    page_w, page_h = 4*inch, 3*inch
    c = pdf_canvas.Canvas(buf, pagesize=(page_w, page_h))
    c.setFont("Helvetica-Bold", 14)
    c.drawString(10, page_h - 25, box["box_id"])
    c.setFont("Helvetica", 9)
    c.drawString(10, page_h - 42, f"SKU: {box.get('sku', '')}")
    c.drawString(10, page_h - 55, f"Color: {box.get('color', '')}  Size: {box.get('size', '')}")
    c.drawString(10, page_h - 68, f"Units: {box.get('units', 0)}  PO: {box.get('po', '')}")
    # Generate barcode image
    try:
        code128 = barcode.get('code128', box["box_id"], writer=ImageWriter())
        bc_buf = io.BytesIO()
        code128.write(bc_buf, options={"write_text": False, "module_height": 10, "module_width": 0.3})
        bc_buf.seek(0)
        from reportlab.lib.utils import ImageReader
        c.drawImage(ImageReader(bc_buf), 10, 5, width=page_w - 20, height=50)
    except Exception as e:
        logger.error(f"Barcode generation error: {e}")
        c.drawString(10, 30, box["box_id"])
    c.save()
    buf.seek(0)
    return StreamingResponse(buf, media_type="application/pdf",
                             headers={"Content-Disposition": f"inline; filename=label_{box_id}.pdf"})

@router.get("/labels/boxes")
async def generate_multi_box_labels(request: Request, box_ids: str = ""):
    await require_auth(request)
    ids = [b.strip() for b in box_ids.split(",") if b.strip()]
    if not ids:
        raise HTTPException(400, "box_ids requeridos (separados por coma)")
    from reportlab.lib.units import inch
    from reportlab.pdfgen import canvas as pdf_canvas
    import barcode
    from barcode.writer import ImageWriter
    from reportlab.lib.utils import ImageReader
    buf = io.BytesIO()
    page_w, page_h = 4*inch, 3*inch
    c = pdf_canvas.Canvas(buf, pagesize=(page_w, page_h))
    for i, bid in enumerate(ids):
        box = await db.wms_boxes.find_one({"box_id": bid}, {"_id": 0})
        if not box:
            continue
        if i > 0:
            c.showPage()
        c.setFont("Helvetica-Bold", 14)
        c.drawString(10, page_h - 25, box["box_id"])
        c.setFont("Helvetica", 9)
        c.drawString(10, page_h - 42, f"SKU: {box.get('sku', '')}")
        c.drawString(10, page_h - 55, f"Color: {box.get('color', '')}  Size: {box.get('size', '')}")
        c.drawString(10, page_h - 68, f"Units: {box.get('units', 0)}  PO: {box.get('po', '')}")
        try:
            code128 = barcode.get('code128', box["box_id"], writer=ImageWriter())
            bc_buf = io.BytesIO()
            code128.write(bc_buf, options={"write_text": False, "module_height": 10, "module_width": 0.3})
            bc_buf.seek(0)
            c.drawImage(ImageReader(bc_buf), 10, 5, width=page_w - 20, height=50)
        except Exception:
            c.drawString(10, 30, box["box_id"])
    c.save()
    buf.seek(0)
    return StreamingResponse(buf, media_type="application/pdf",
                             headers={"Content-Disposition": "inline; filename=box_labels.pdf"})

# ==================== EXPORT ====================

@router.get("/export/inventory")
async def export_inventory(request: Request, exclude_hold: bool = False):
    await require_auth(request)
    # to_list(None) returns ALL rows. A fixed cap (e.g. 20000) silently dropped
    # the alphabetical tail (W/X/Y/Z SKUs) once the catalog grew past it.
    # Skip fully-empty orphan rows (no units, no boxes, no allocations) so the
    # report never shows phantom lines — e.g. a row left behind after a move/pick
    # decremented one counter but not the other.
    inventory = await db.wms_inventory.find(
        {"$or": [
            {"units_on_hand": {"$gt": 0}},
            {"total_boxes": {"$gt": 0}},
            {"units_allocated": {"$gt": 0}},
        ]},
        {"_id": 0},
    ).sort("sku", 1).to_list(None)
    # Optionally drop rows sitting in SAT-held locations (case-insensitive match
    # against the hold list).
    if exclude_hold:
        held = await _hold_location_names()
        if held:
            inventory = [r for r in inventory if (r.get("location") or "").strip().upper() not in held]
    import xlsxwriter
    buf = io.BytesIO()
    wb = xlsxwriter.Workbook(buf)
    ws = wb.add_worksheet("Inventory")
    headers = ["Customer", "Style", "Color", "Size", "Description", "Category",
               "Manufacturer", "Location", "Total Boxes", "On Hand", "Allocated", "Available",
               "Country of Origin", "Fabric Content", "Is BPO"]
    bold = wb.add_format({"bold": True})
    for i, h in enumerate(headers):
        ws.write(0, i, h, bold)
    for row, inv in enumerate(inventory, 1):
        ws.write(row, 0, inv.get("customer", ""))
        ws.write(row, 1, inv.get("style", inv.get("sku", "")))
        ws.write(row, 2, inv.get("color", ""))
        ws.write(row, 3, inv.get("size", ""))
        ws.write(row, 4, inv.get("description", ""))
        ws.write(row, 5, inv.get("category", ""))
        ws.write(row, 6, inv.get("manufacturer", ""))
        ws.write(row, 7, inv.get("location", ""))
        ws.write(row, 8, inv.get("total_boxes", 0))
        ws.write(row, 9, inv.get("units_on_hand", 0))
        ws.write(row, 10, inv.get("units_allocated", 0))
        ws.write(row, 11, inv.get("units_on_hand", 0) - inv.get("units_allocated", 0))
        ws.write(row, 12, inv.get("country_of_origin", ""))
        ws.write(row, 13, inv.get("fabric_content", ""))
        ws.write(row, 14, "YES" if inv.get("is_bpo") else "NO")

    # ── Sheet 2: box-level detail (Case# 007) ────────────────────────────────
    # Which physical box / LPN sits in each location — the aggregated sheet above
    # buckets by SKU+location and hides the box numbers. Reports need both.
    boxes = await db.wms_boxes.find(
        {"$or": [{"units": {"$gt": 0}}, {"qty": {"$gt": 0}}]},
        {"_id": 0},
    ).sort([("location", 1), ("sku", 1)]).to_list(None)
    if exclude_hold and held:
        boxes = [b for b in boxes if (b.get("location") or "").strip().upper() not in held]
    ws2 = wb.add_worksheet("Cajas - LPNs")
    box_headers = ["Box / LPN", "Customer", "Style", "Color", "Size", "Location",
                   "Units", "Status", "Country of Origin", "Fabric Content", "Description"]
    for i, h in enumerate(box_headers):
        ws2.write(0, i, h, bold)
    for row, b in enumerate(boxes, 1):
        ws2.write(row, 0, b.get("box_id", b.get("lpn_id", "")))
        ws2.write(row, 1, b.get("customer", ""))
        ws2.write(row, 2, b.get("style", b.get("sku", "")))
        ws2.write(row, 3, b.get("color", ""))
        ws2.write(row, 4, b.get("size", ""))
        ws2.write(row, 5, b.get("location", ""))
        ws2.write(row, 6, int(b.get("units") or b.get("qty") or 0))
        ws2.write(row, 7, b.get("status", b.get("state", "")))
        ws2.write(row, 8, b.get("country_of_origin", b.get("coo", "")))
        ws2.write(row, 9, b.get("fabric_content", ""))
        ws2.write(row, 10, b.get("description", ""))

    wb.close()
    buf.seek(0)
    return StreamingResponse(buf, media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                             headers={"Content-Disposition": "attachment; filename=inventory.xlsx"})


# ==================== ASN (Advanced Shipping Notice) ====================

# Field -> list of header keywords (lowercase, accent-free). A column matches
# a field if any of the field's keywords appears in the normalized header text.
# Both R5 (English) and R6 (Spanish) headers are merged per column before
# matching, so a column with just the Spanish label still resolves correctly.
_ASN_HEADER_KEYWORDS = {
    "part_number":  ["part number", "no. de parte", "numero de parte", "no de parte", "n de parte", "style", "sku", "pn"],
    "description":  ["description", "descripcion espanol", "descripcion ingles", "english description", "descripcion"],
    "qty":          ["qty", "quantity", "cantidad"],
    "country":      ["country", "pais origen", "pais de origen", "country of origin", "coo"],
    "brand":        ["brand", "marca"],
    "po":           ["po number", "entry number", "numero de entrada", "numeor de entrada", "po"],
}
# Required fields — if any is missing after detection the import refuses.
_ASN_REQUIRED_FIELDS = ("part_number", "qty")

# Box statuses that mean the units already LEFT inventory (consumed/in process/
# shipped). Anything else with units>0 is considered still on hand. Whitelisting
# the "out" set keeps legacy/empty statuses counted as in-stock.
_BOX_OUT_STATUSES = {"shipped", "in_production", "finished", "in_neck_cutting", "confirmed"}

def _box_in_stock(b) -> bool:
    units = int(b.get("units") or b.get("qty") or 0)
    return units > 0 and (b.get("status") or "") not in _BOX_OUT_STATUSES

def _box_keys(b) -> set:
    """Identifiers a box can be matched to an ASN line by."""
    return {str(b.get(k) or "").strip().upper() for k in ("upc", "sku", "style") if b.get(k)}

def _normalize_header(s) -> str:
    """Lowercase, strip accents, collapse whitespace, drop punctuation."""
    if s is None:
        return ""
    import unicodedata
    t = unicodedata.normalize("NFKD", str(s))
    t = "".join(ch for ch in t if not unicodedata.combining(ch))
    t = t.lower()
    # Replace common separators with spaces; drop other punctuation
    out = []
    for ch in t:
        if ch.isalnum() or ch == " ":
            out.append(ch)
        elif ch in "-_/.,:;":
            out.append(" ")
    return " ".join("".join(out).split())

def _detect_sheet_kind(name: str) -> str | None:
    """Return a label for the sheet kind, or None if it's not a packing-list sheet.
    The kind is informational only — column detection is name-based per sheet."""
    n = (name or "").upper()
    if "RAW MATERIAL" in n or "MATERIA PRIMA" in n:
        return "raw"
    if "EQUIPMENT" in n or "EQUIPO" in n:
        return "equipment"
    if "FINISHED GOODS" in n or "PRODUCTO TERM" in n or "PRODUCTOTERM" in n:
        return "finished_goods"
    return None

def _find_asn_number(ws) -> str:
    """Scan top-left region for a cell labelled 'ASN' and return the neighbour value."""
    for r in range(1, 12):
        for c in range(1, 20):
            v = ws.cell(row=r, column=c).value
            if v is None:
                continue
            if str(v).strip().upper() == "ASN":
                for dc in range(1, 5):
                    rv = ws.cell(row=r, column=c + dc).value
                    if rv not in (None, ""):
                        return str(rv).strip()
    return ""

_LABEL_DENYLIST = {
    "PACKING LIST", "BILL OF MATERIALS", "RAW MATERIAL", "EQUIPMENT",
    "FINISHED GOODS", "MATERIA PRIMA", "EQUIPO", "PRODUCTO TERMINADO",
    "RAW MATERIALS",
}

def _find_label_value(ws, *label_aliases, rows=8, max_cols=20, scan_right=6, max_gap=3) -> str:
    """Find a header label (e.g. 'Cliente:') anywhere in the top of the sheet
    and return the value next to it. Stops after `max_gap` consecutive blanks
    so we don't latch onto an unrelated heading further down the row."""
    aliases = {a.strip().upper().rstrip(':') for a in label_aliases}
    for r in range(1, rows + 1):
        for c in range(1, max_cols + 1):
            v = ws.cell(row=r, column=c).value
            if v is None:
                continue
            key = str(v).strip().upper().rstrip(':')
            if key not in aliases:
                continue
            blanks = 0
            for dc in range(1, scan_right + 1):
                rv = ws.cell(row=r, column=c + dc).value
                if rv in (None, ""):
                    blanks += 1
                    if blanks >= max_gap:
                        break
                    continue
                blanks = 0
                text = str(rv).strip()
                if not text:
                    continue
                upper = text.upper().rstrip(':')
                if text.endswith(':') or upper in aliases or upper in _LABEL_DENYLIST:
                    continue  # adjacent cell is another label, not a value
                return text
    return ""

# Patterns like "100% DE ALGODÓN", "50% ALGODON", "50% POLIESTER".
# Captures the percentage word + the material word (with common diacritics).
_FABRIC_PATTERN = re.compile(
    r"\d+\s*%\s*(?:DE\s+)?[A-ZÁÉÍÓÚÑ/]+(?:\s+[A-ZÁÉÍÓÚÑ/]+)?",
    re.IGNORECASE,
)
_STOP_FABRIC_WORDS = {"DE", "DEL", "LA", "EL", "PARA", "CON", "Y"}

def _extract_fabric_from_description(desc: str) -> str:
    """Pull fabric composition out of a free-form description.
    Examples:
      'CAMISETA ... 100% DE ALGODON'           -> '100% ALGODON'
      'CAMISETA ... 50% ALGODON, 50% POLIESTER' -> '50% ALGODON, 50% POLIESTER'
    Returns '' when no percentage pattern is found.
    """
    if not desc:
        return ""
    text = str(desc).upper()
    matches = _FABRIC_PATTERN.findall(text)
    cleaned = []
    for m in matches:
        # Normalise: drop "DE" connector, collapse whitespace, strip trailing slash/comma
        parts = [p for p in re.split(r"\s+", m) if p and p.upper() != "DE"]
        result = " ".join(parts).rstrip("/,. ")
        if result:
            cleaned.append(result)
    return ", ".join(cleaned)

def _detect_columns(ws, scan_rows: int = 15) -> tuple[dict[str, int], int]:
    """Find the header row and map field -> 0-based column index by header name.

    Strategy:
      1. For each row in 1..scan_rows, score how many fields can be located in
         that row's cells.
      2. Take the best row. If the next row also has hits, merge them column-
         wise (bilingual templates put English + Spanish on consecutive rows).
      3. Resolve each field to a column index using the field's keyword list.

    Returns (column_map, data_start_row). data_start_row = best + 1 (or +2 if
    we merged with the row below).
    """
    max_col = min(ws.max_column or 50, 50)
    # Per-row, per-field: which column matched (or -1)
    per_row: list[dict[str, int]] = []
    for r in range(1, scan_rows + 1):
        row_map: dict[str, int] = {}
        for c in range(1, max_col + 1):
            text = _normalize_header(ws.cell(row=r, column=c).value)
            if not text:
                continue
            for field, kws in _ASN_HEADER_KEYWORDS.items():
                if field in row_map:
                    continue  # first match wins per row
                if any(kw in text for kw in kws):
                    row_map[field] = c - 1  # 0-based for openpyxl iter_rows tuples
                    break
        per_row.append(row_map)

    # Pick the row with the most field hits
    best_row, best_score = 0, 0
    for i, rm in enumerate(per_row):
        score = sum(1 for f in _ASN_HEADER_KEYWORDS if f in rm)
        if score > best_score:
            best_row, best_score = i, score

    if best_score == 0:
        return {}, 0

    merged = dict(per_row[best_row])
    data_start = best_row + 1 + 1  # 1-based row right after header

    # If the next row also hits any field not in best_row, merge it (bilingual)
    if best_row + 1 < len(per_row):
        for f, c in per_row[best_row + 1].items():
            merged.setdefault(f, c)
        if per_row[best_row + 1]:
            data_start = best_row + 2 + 1

    return merged, data_start

def _parse_packing_list(ws) -> tuple[list[dict], str, dict[str, int]]:
    """Return (items, po_number, detected_column_map) from a worksheet.

    Column detection is by header name (see _detect_columns) so layout shifts
    across vendor revisions don't break the parse — as long as the header text
    is recognizable.
    """
    col_map, data_start = _detect_columns(ws)
    missing = [f for f in _ASN_REQUIRED_FIELDS if f not in col_map]
    if missing:
        raise HTTPException(
            400,
            f"No se detectaron columnas obligatorias: {', '.join(missing)}. "
            "Revisa que los encabezados del archivo incluyan al menos "
            "'Part Number' y 'Qty'/'Cantidad'."
        )

    pn_col = col_map["part_number"]
    qty_col = col_map["qty"]

    def cell_at(row, field):
        c = col_map.get(field)
        if c is None or c >= len(row) or row[c] is None:
            return ""
        return str(row[c]).strip()

    items: list[dict] = []
    po_number = ""
    line_no = 0
    for row in ws.iter_rows(min_row=data_start, values_only=True):
        if not row:
            continue
        if pn_col >= len(row):
            continue
        pn_raw = row[pn_col]
        if pn_raw is None:
            continue
        pn = str(pn_raw).strip()
        if not pn or pn.upper() == "TOTAL":
            continue
        try:
            qty = int(float(row[qty_col] if qty_col < len(row) and row[qty_col] is not None else 0))
        except (TypeError, ValueError):
            qty = 0
        if qty <= 0:
            continue
        if not po_number:
            po_number = cell_at(row, "po")
        line_no += 1
        desc = cell_at(row, "description")
        items.append({
            "line_no": line_no,
            "part_number": pn.upper(),
            "description": desc,
            "fabric_content": _extract_fabric_from_description(desc),
            "qty_expected": qty,
            "qty_received": 0,
            "country": cell_at(row, "country").upper(),
            "brand": cell_at(row, "brand").upper(),
        })
    return items, po_number, col_map


def _parse_packing_list_pdf(contents: bytes) -> dict:
    """Parse an aduanal-style 'Lista de Empaque / Packing List' PDF.

    Layout: a key/value header (NO. FACTURA / INVOICE = the ASN number,
    REMITENTE / SHIPPER = vendor, VENDEDOR / SELLER = brand) followed by a
    merchandise table where each item begins with '(N) <part_number>'. On that
    same line the quantity is the positive WHOLE number (net weight is
    fractional; bulk/package qty are zero), and 'Pais Origen:' gives the COO.
    Header values are read via word coordinates because the page has 3 columns.

    Returns { asn_id, vendor, brand, customer, po_number, items }.
    """
    import pdfplumber

    lines: list[str] = []
    header_words: list[dict] = []
    with pdfplumber.open(io.BytesIO(contents)) as pdf:
        for pi, page in enumerate(pdf.pages):
            lines.extend((page.extract_text(x_tolerance=1.5) or "").split("\n"))
            if pi == 0:
                header_words = page.extract_words(x_tolerance=1.5)
    full = "\n".join(lines)

    # Header value sitting directly below a label word, kept within the label's
    # column so 3-column layouts don't bleed into the neighbour.
    def value_below(*labels):
        lab = None
        for w in header_words:
            up = w["text"].upper()
            if any(l in up for l in labels):
                lab = w
                break
        if not lab:
            return ""
        lx, ltop = lab["x0"], lab["top"]
        below = [w for w in header_words if w["top"] > ltop + 2 and (lx - 20) <= w["x0"] <= (lx + 200)]
        if not below:
            return ""
        below.sort(key=lambda w: (w["top"], w["x0"]))
        first_top = below[0]["top"]
        row_words = [w for w in below if abs(w["top"] - first_top) <= 4]
        return " ".join(w["text"] for w in sorted(row_words, key=lambda w: w["x0"])).strip()

    asn_id = ""
    m = re.search(r"(?:NO\.?\s*FACTURA|INVOICE)\s*[:/#]*\s*([0-9][0-9A-Za-z\-]{2,})", full, re.I)
    if m:
        asn_id = m.group(1).strip()

    vendor = value_below("SHIPPER", "REMITENTE")
    seller = value_below("SELLER", "VENDEDOR")
    brand = (seller.split()[0] if seller else "").upper()

    NUM = re.compile(r"\d[\d,]*\.\d+|\d[\d,]*")
    item_re = re.compile(r"^\((\d+)\)\s*(\S+)?")
    items: list[dict] = []
    cur: dict | None = None

    def flush():
        nonlocal cur
        if cur and cur.get("part_number"):
            desc = " ".join(cur.pop("_desc", [])).strip()
            cur["description"] = desc
            cur["fabric_content"] = _extract_fabric_from_description(desc)
            items.append(cur)
        cur = None

    for ln in lines:
        s = ln.strip()
        if not s:
            continue
        mi = item_re.match(s)
        if mi:
            flush()
            part = (mi.group(2) or "").strip().upper()
            rest = s[mi.end():]
            nums = [float(x.replace(",", "")) for x in NUM.findall(rest)]
            whole_pos = [n for n in nums if n > 0 and abs(n - round(n)) < 1e-6]
            qty = int(round(whole_pos[0])) if whole_pos else (int(round(max(nums))) if nums else 0)
            cur = {
                "line_no": int(mi.group(1)),
                "part_number": part,
                "_desc": [],
                "qty_expected": qty,
                "qty_received": 0,
                "country": "",
                "brand": brand,
            }
            continue
        if cur is None:
            continue
        u = s.upper()
        cm = re.match(r"PA[IÍ]S\s*ORIGEN\s*[:]?\s*([A-Za-z]{2,3})", u)
        if cm:
            cur["country"] = cm.group(1).upper()
            continue
        if u.startswith(("FRACCION", "FRACCIÓN", "PO:", "LOT:", "PESO", "NET WT", "U.M.C", "UMC")):
            continue
        if not s.startswith("(") and len(cur["_desc"]) < 4:
            cur["_desc"].append(s)
    flush()

    return {
        "asn_id": asn_id,
        "vendor": (vendor or "").upper(),
        "brand": brand,
        "customer": vendor or "",
        "po_number": "",
        "items": items,
    }


@router.post("/asn")
async def create_asn(request: Request):
    """Manual ASN creation. Caller supplies asn_id; we don't auto-generate so the
    physical packing-list number stays as the source of truth."""
    user = await require_auth(request)
    body = await request.json()

    asn_id = str(body.get("asn_id", "")).strip()
    if not asn_id:
        raise HTTPException(400, "asn_id requerido (numero del packing list)")

    items = body.get("items", [])
    if not items:
        raise HTTPException(400, "El ASN debe contener al menos un item")

    if await db.wms_asn.find_one({"asn_id": asn_id}, {"_id": 1}):
        raise HTTPException(409, f"ASN {asn_id} ya existe")

    normalized_items = []
    for idx, it in enumerate(items, start=1):
        qty = int(it.get("qty_expected", it.get("quantity", 0)) or 0)
        normalized_items.append({
            "line_no": idx,
            "part_number": str(it.get("part_number", it.get("sku", ""))).strip().upper(),
            "description": str(it.get("description", "")).strip(),
            "qty_expected": qty,
            "qty_received": 0,
            "country": str(it.get("country", "")).strip().upper(),
            "brand": str(it.get("brand", "")).strip().upper(),
        })

    doc = {
        "asn_id": asn_id,
        "po_number": str(body.get("po_number", "")).strip(),
        "vendor": str(body.get("vendor", "")).strip().upper(),
        "expected_date": body.get("expected_date", ""),
        "source_sheet": "",
        "source_file": "",
        "items": normalized_items,
        "status": AsnStatus.PENDING,
        "created_at": now_iso(),
        "created_by": user.get("user_id"),
    }
    await db.wms_asn.insert_one(doc)
    doc.pop("_id", None)
    return doc

@router.get("/asn")
async def list_asn(request: Request):
    await require_auth(request)
    return await db.wms_asn.find({}, {"_id": 0}).sort("created_at", -1).to_list(200)

# NOTE: declared BEFORE /asn/{asn_id} so "trace-sku" isn't captured as an asn_id.
@router.get("/asn/trace-sku")
async def trace_sku(request: Request, q: str = Query(...)):
    """Given a SKU/style/UPC, return which ASN(s) it came from, with how much is
    still in stock, where, and the box counts/dates. Boxes without an
    asn_reference are grouped under '(SIN ASN)'."""
    await require_auth(request)
    qn = (q or "").strip().upper()
    if not qn:
        raise HTTPException(400, "Parámetro 'q' requerido")
    rx = {"$regex": f"^{re.escape(qn)}$", "$options": "i"}
    boxes = await db.wms_boxes.find({"$or": [{"sku": rx}, {"style": rx}, {"upc": qn}]}, {"_id": 0}).to_list(20000)
    if not boxes:
        contains = {"$regex": re.escape(qn), "$options": "i"}
        boxes = await db.wms_boxes.find({"$or": [{"sku": contains}, {"style": contains}]}, {"_id": 0}).to_list(20000)

    groups: dict[str, dict] = {}
    for b in boxes:
        ref = (b.get("asn_reference") or "").strip() or "(SIN ASN)"
        u = int(b.get("units") or b.get("qty") or 0)
        g = groups.setdefault(ref, {
            "asn_reference": ref, "units_in_stock": 0, "units_total": 0,
            "boxes": 0, "boxes_in_stock": 0, "locations": set(), "skus": set(),
            "first_at": None, "last_at": None,
        })
        g["boxes"] += 1
        g["units_total"] += u
        if _box_in_stock(b):
            g["units_in_stock"] += u
            g["boxes_in_stock"] += 1
            if b.get("location"):
                g["locations"].add(str(b["location"]).strip())
        if b.get("sku") or b.get("style"):
            g["skus"].add(str(b.get("sku") or b.get("style")).strip())
        ca = b.get("created_at")
        if ca:
            g["first_at"] = min(g["first_at"], ca) if g["first_at"] else ca
            g["last_at"] = max(g["last_at"], ca) if g["last_at"] else ca

    results = []
    for ref, g in groups.items():
        asn = None
        if ref != "(SIN ASN)":
            asn = await db.wms_asn.find_one({"asn_id": ref}, {"_id": 0, "vendor": 1, "po_number": 1, "status": 1})
        results.append({
            **g,
            "locations": sorted(g["locations"]),
            "skus": sorted(g["skus"]),
            "vendor": (asn or {}).get("vendor", ""),
            "po_number": (asn or {}).get("po_number", ""),
            "asn_status": (asn or {}).get("status", ""),
            "exists": asn is not None,
        })
    results.sort(key=lambda x: (-x["units_in_stock"], x["asn_reference"]))
    return {"query": qn, "total_boxes": len(boxes), "groups": results}

@router.get("/asn/{asn_id}")
async def get_asn_detail(asn_id: str, request: Request):
    """Return ASN doc + every receiving event + every box tied to this ASN.

    Trazabilidad: el frontend muestra un summary, una lista de recepciones
    (con quién, cuándo, lote, ubicación) y la tabla detallada de cajas.
    """
    await require_auth(request)
    asn = await db.wms_asn.find_one({"asn_id": asn_id}, {"_id": 0})
    if not asn:
        raise HTTPException(404, f"ASN {asn_id} no encontrado")

    boxes = await db.wms_boxes.find(
        {"asn_reference": asn_id}, {"_id": 0}
    ).sort("created_at", -1).to_list(5000)

    receivings = await db.wms_receiving.find(
        {"asn_reference": asn_id}, {"_id": 0}
    ).sort("created_at", -1).to_list(2000)

    # Aggregated summary across boxes (since boxes are the granular unit and
    # cover historical records that pre-date the receiving.asn_reference field).
    total_units = sum(int(b.get("units") or b.get("qty") or 0) for b in boxes)
    total_boxes = len(boxes)
    receivers = sorted({(r.get("received_by_name") or "").strip() for r in receivings if r.get("received_by_name")})
    distinct_styles = sorted({(b.get("style") or "").strip() for b in boxes if b.get("style")})
    distinct_locations = sorted({(b.get("location") or "").strip() for b in boxes if b.get("location")})
    dates = [r.get("created_at") for r in receivings if r.get("created_at")] + \
            [b.get("created_at") for b in boxes if b.get("created_at")]
    first_at = min(dates) if dates else None
    last_at = max(dates) if dates else None

    # ── Traceability: split current stock vs material that already left ──────
    units_expected = sum(int(it.get("qty_expected") or 0) for it in asn.get("items", []))
    units_received = sum(int(it.get("qty_received") or 0) for it in asn.get("items", []))
    in_stock_boxes = [b for b in boxes if _box_in_stock(b)]
    units_in_stock = sum(int(b.get("units") or b.get("qty") or 0) for b in in_stock_boxes)
    boxes_in_stock = len(in_stock_boxes)
    units_out = max(0, units_received - units_in_stock)

    # In-stock units grouped by location, and by SKU (what's left and where).
    by_location: dict[str, dict] = {}
    by_sku: dict[str, dict] = {}
    for b in in_stock_boxes:
        u = int(b.get("units") or b.get("qty") or 0)
        loc = (b.get("location") or "—").strip() or "—"
        l = by_location.setdefault(loc, {"location": loc, "units": 0, "boxes": 0})
        l["units"] += u; l["boxes"] += 1
        sku = (b.get("sku") or b.get("style") or "—").strip() or "—"
        s = by_sku.setdefault(sku, {"sku": sku, "style": b.get("style") or "", "color": b.get("color") or "", "size": b.get("size") or "", "units": 0, "boxes": 0, "locations": set()})
        s["units"] += u; s["boxes"] += 1; s["locations"].add(loc)
    by_sku_list = [{**v, "locations": sorted(v["locations"])} for v in by_sku.values()]

    # Per ASN line: how much of that line is still on hand (best-effort match by
    # part_number against each box's upc/sku/style).
    by_line = []
    for it in asn.get("items", []):
        pn = str(it.get("part_number") or "").strip().upper()
        line_stock = sum(
            int(b.get("units") or b.get("qty") or 0)
            for b in in_stock_boxes if pn and pn in _box_keys(b)
        )
        by_line.append({
            "line_no": it.get("line_no"),
            "part_number": it.get("part_number"),
            "qty_expected": int(it.get("qty_expected") or 0),
            "qty_received": int(it.get("qty_received") or 0),
            "qty_in_stock": line_stock,
        })

    summary = {
        "total_units": total_units,
        "total_boxes": total_boxes,
        "total_receivings": len(receivings),
        "receivers": receivers,
        "distinct_styles": distinct_styles,
        "distinct_locations": distinct_locations,
        "first_received_at": first_at,
        "last_received_at": last_at,
        # Traceability
        "units_expected": units_expected,
        "units_received": units_received,
        "units_in_stock": units_in_stock,
        "units_out": units_out,
        "boxes_in_stock": boxes_in_stock,
        "by_location": sorted(by_location.values(), key=lambda x: -x["units"]),
        "by_sku": sorted(by_sku_list, key=lambda x: -x["units"]),
        "by_line": by_line,
    }

    return {"asn": asn, "boxes": boxes, "receivings": receivings, "summary": summary}

@router.delete("/asn/{asn_id}")
async def delete_asn(asn_id: str, request: Request):
    """Delete an ASN. Received boxes are kept (their asn_reference becomes
    informational only) so historical traceability is preserved."""
    user = await require_auth(request)
    asn = await db.wms_asn.find_one({"asn_id": asn_id}, {"_id": 0})
    if not asn:
        raise HTTPException(404, f"ASN {asn_id} no encontrado")
    boxes_count = await db.wms_boxes.count_documents({"asn_reference": asn_id})
    await db.wms_asn.delete_one({"asn_id": asn_id})
    await log_movement(user, MovementType.ASN_IMPORTED, {
        "asn_id": asn_id, "deleted": True,
        "po_number": asn.get("po_number"),
        "had_boxes": boxes_count,
    })
    return {"status": "deleted", "asn_id": asn_id, "boxes_kept": boxes_count}

@router.put("/asn/{asn_id}")
async def update_asn(asn_id: str, request: Request):
    """Edit an ASN's header and packing-list lines. Admin / super-user.
    Received quantities are preserved (matched by line_no, then part_number),
    and status is recomputed from expected vs received."""
    user = await require_admin(request)
    asn = await db.wms_asn.find_one({"asn_id": asn_id}, {"_id": 0})
    if not asn:
        raise HTTPException(404, f"ASN {asn_id} no encontrado")
    body = await request.json()

    update = {}
    for k in ("po_number", "vendor", "expected_date"):
        if k in body:
            v = str(body.get(k) or "").strip()
            update[k] = v.upper() if k == "vendor" else v

    if "items" in body:
        incoming = body.get("items") or []
        if not incoming:
            raise HTTPException(400, "El ASN debe contener al menos un item")
        prev = asn.get("items", [])
        by_line = {it.get("line_no"): it for it in prev}
        by_part = {}
        for it in prev:
            by_part.setdefault(str(it.get("part_number", "")).upper(), it)
        normalized = []
        for idx, it in enumerate(incoming, start=1):
            part = str(it.get("part_number", it.get("sku", ""))).strip().upper()
            # Preserve received qty: match by the original line_no, then part_number.
            # IMPORTANT: only fall back to by_part when the item already has a line_no
            # (i.e. it is an existing line being edited). A brand-new item (no line_no)
            # must always start with qty_received = 0, even if the same part_number
            # already appears on another line.
            line_no_key = it.get("line_no")
            if line_no_key is not None:
                src = by_line.get(line_no_key) or by_part.get(part) or {}
            else:
                src = by_line.get(line_no_key) or {}   # new item → no inherited qty
            normalized.append({
                "line_no": idx,
                "part_number": part,
                "description": str(it.get("description", "")).strip(),
                "qty_expected": int(it.get("qty_expected", it.get("quantity", 0)) or 0),
                "qty_received": int(src.get("qty_received", 0) or 0),
                "country": str(it.get("country", "")).strip().upper(),
                "brand": str(it.get("brand", "")).strip().upper(),
            })
        update["items"] = normalized

        total_exp = sum(i["qty_expected"] for i in normalized)
        total_rcv = sum(i["qty_received"] for i in normalized)
        if total_rcv <= 0:
            update["status"] = AsnStatus.PENDING
        elif total_rcv >= total_exp and all(i["qty_received"] >= i["qty_expected"] for i in normalized):
            update["status"] = AsnStatus.RECEIVED
        else:
            update["status"] = AsnStatus.PARTIAL

    if not update:
        raise HTTPException(400, "Nada por actualizar")

    update["updated_at"] = now_iso()
    update["updated_by"] = user.get("user_id")
    await db.wms_asn.update_one({"asn_id": asn_id}, {"$set": update})
    await log_movement(user, MovementType.ASN_IMPORTED, {
        "asn_id": asn_id, "edited": True,
        "fields": [k for k in update if k not in ("updated_at", "updated_by")],
    })
    return await db.wms_asn.find_one({"asn_id": asn_id}, {"_id": 0})


def _asn_discrepancies(asn: dict) -> list:
    """Per-line expected vs received differences (snapshot of the discrepancy log)."""
    out = []
    for it in asn.get("items", []):
        exp = int(it.get("qty_expected") or 0)
        rcv = int(it.get("qty_received") or 0)
        diff = rcv - exp
        if diff != 0:
            out.append({
                "line_no": it.get("line_no"),
                "part_number": it.get("part_number"),
                "description": it.get("description", ""),
                "qty_expected": exp,
                "qty_received": rcv,
                "difference": diff,
                "type": "SOBRANTE" if diff > 0 else "FALTANTE",
            })
    return out


@router.post("/asn/{asn_id}/close")
async def close_asn(asn_id: str, request: Request):
    """Finish the receiving process for an ASN even with discrepancies. Snapshots
    the per-line discrepancy log, marks the ASN closed (and status received), and
    blocks further receiving against it until reopened."""
    user = await require_auth(request)
    body = await request.json()
    asn = await db.wms_asn.find_one({"asn_id": asn_id}, {"_id": 0})
    if not asn:
        raise HTTPException(404, f"ASN {asn_id} no encontrado")

    discrepancies = _asn_discrepancies(asn)
    update = {
        "closed": True,
        "closed_at": now_iso(),
        "closed_by": user.get("user_id"),
        "closed_by_name": user.get("name", user.get("email", "")),
        "closure_note": str(body.get("note", "")).strip(),
        "discrepancies": discrepancies,
        "status": AsnStatus.RECEIVED,
        "received_at": asn.get("received_at") or now_iso(),
    }
    await db.wms_asn.update_one({"asn_id": asn_id}, {"$set": update})
    await log_movement(user, MovementType.ASN_RECEIPT, {
        "asn_id": asn_id, "closed": True, "discrepancy_lines": len(discrepancies),
    })
    return await db.wms_asn.find_one({"asn_id": asn_id}, {"_id": 0})


@router.post("/asn/{asn_id}/reopen")
async def reopen_asn(asn_id: str, request: Request):
    """Reopen a closed ASN so receiving can continue. Admin / super-user."""
    user = await require_admin(request)
    asn = await db.wms_asn.find_one({"asn_id": asn_id}, {"_id": 0})
    if not asn:
        raise HTTPException(404, f"ASN {asn_id} no encontrado")
    total_exp = sum(int(it.get("qty_expected") or 0) for it in asn.get("items", []))
    total_rcv = sum(int(it.get("qty_received") or 0) for it in asn.get("items", []))
    status = AsnStatus.PENDING if total_rcv <= 0 else (AsnStatus.RECEIVED if total_rcv >= total_exp else AsnStatus.PARTIAL)
    await db.wms_asn.update_one({"asn_id": asn_id}, {
        "$set": {"closed": False, "status": status},
        "$unset": {"closed_at": "", "closed_by": "", "closed_by_name": "", "closure_note": "", "discrepancies": ""},
    })
    await log_movement(user, MovementType.ASN_RECEIPT, {"asn_id": asn_id, "reopened": True})
    return await db.wms_asn.find_one({"asn_id": asn_id}, {"_id": 0})

@router.post("/asn/import")
async def import_asn(
    request: Request,
    file: UploadFile = File(...),
    sheet_name: Optional[str] = Query(default=None),
):
    """Two-phase import:
       - Phase 1 (no sheet_name): inspect the file and return its sheets + detected
         ASN# per sheet so the user can choose which to import.
       - Phase 2 (with sheet_name): parse that sheet and persist.
    """
    user = await require_auth(request)
    import openpyxl
    try:
        contents = await file.read()
    except Exception as e:
        logger.exception("ASN import: failed to read uploaded file")
        raise HTTPException(400, f"No se pudo leer el archivo subido: {e}")
    if not contents:
        raise HTTPException(400, "Archivo vacio o no recibido")

    # ── PDF branch: aduanal "Lista de Empaque / Packing List" ────────────────
    is_pdf = (file.filename or "").lower().endswith(".pdf") or \
             (file.content_type or "").lower() == "application/pdf" or \
             contents[:5] == b"%PDF-"
    if is_pdf:
        try:
            parsed = _parse_packing_list_pdf(contents)
        except Exception as e:
            logger.exception("ASN import: PDF parse failed")
            raise HTTPException(400, f"No se pudo leer el PDF del packing list: {e}")
        asn_id = parsed.get("asn_id") or ""
        items = parsed.get("items") or []
        if not asn_id:
            raise HTTPException(400, "No se encontró el número de factura/INVOICE en el PDF")
        if not items:
            raise HTTPException(400, "No se detectaron líneas de mercancía en el PDF")
        PDF_SHEET = "PACKING LIST (PDF)"

        # Phase 1: inspect → present a single virtual sheet for confirmation.
        if not sheet_name:
            return {"action": "select_sheet", "filename": file.filename, "sheets": [{
                "name": PDF_SHEET,
                "kind": "pdf",
                "detected_asn_id": asn_id,
                "detected_customer": parsed.get("vendor") or "",
                "row_count": len(items),
                "detected_columns": {"part_number": "PDF", "qty": "PDF", "country": "PDF"},
                "missing_required": [],
            }]}

        # Phase 2: persist.
        if await db.wms_asn.find_one({"asn_id": asn_id}, {"_id": 1}):
            raise HTTPException(409, f"ASN {asn_id} ya existe en el sistema")
        doc = {
            "asn_id": asn_id,
            "po_number": parsed.get("po_number") or "",
            "customer": parsed.get("customer") or "",
            "vendor": parsed.get("vendor") or "",
            "expected_date": now_iso(),
            "source_sheet": PDF_SHEET,
            "source_file": file.filename or "",
            "items": items,
            "status": AsnStatus.PENDING,
            "created_at": now_iso(),
            "created_by": user.get("user_id"),
        }
        await db.wms_asn.insert_one(doc)
        await log_movement(user, MovementType.ASN_IMPORTED, {
            "asn_id": asn_id, "items": len(items), "source": "pdf",
            "total_qty": sum(it.get("qty_expected", 0) for it in items),
        })
        return {
            "status": "success",
            "asn_id": asn_id,
            "po_number": doc["po_number"],
            "vendor": doc["vendor"],
            "items_count": len(items),
            "total_qty_expected": sum(it.get("qty_expected", 0) for it in items),
            "detected_columns": {},
        }

    try:
        wb = openpyxl.load_workbook(io.BytesIO(contents), data_only=True)
    except Exception as e:
        logger.exception("ASN import: openpyxl could not open workbook")
        raise HTTPException(400, f"No se pudo leer el archivo Excel: {e}")

    # Helper: convert 0-based col index to Excel letter for the UI
    def _col_letter(idx: int) -> str:
        n, s = idx + 1, ""
        while n > 0:
            n, r = divmod(n - 1, 26)
            s = chr(65 + r) + s
        return s

    # Phase 1: inspect
    if not sheet_name:
        sheets = []
        for sn in wb.sheetnames:
            kind = _detect_sheet_kind(sn)
            if not kind:
                continue
            ws = wb[sn]
            asn_num = _find_asn_number(ws)
            col_map, data_start = _detect_columns(ws)
            count = 0
            if "part_number" in col_map:
                pn_col = col_map["part_number"]
                for row in ws.iter_rows(min_row=data_start, values_only=True):
                    if not row or pn_col >= len(row):
                        continue
                    pn = row[pn_col]
                    if pn and str(pn).strip().upper() != "TOTAL":
                        count += 1
            sheets.append({
                "name": sn,
                "kind": kind,
                "detected_asn_id": asn_num,
                "detected_customer": _find_label_value(ws, "Cliente", "Client", "Customer"),
                "row_count": count,
                "detected_columns": {f: _col_letter(c) for f, c in col_map.items()},
                "missing_required": [f for f in _ASN_REQUIRED_FIELDS if f not in col_map],
            })
        if not sheets:
            raise HTTPException(400, "No se encontraron hojas compatibles (RAW MATERIAL / EQUIPMENT / FINISHED GOODS)")
        return {"action": "select_sheet", "filename": file.filename, "sheets": sheets}

    # Phase 2: import the chosen sheet
    if sheet_name not in wb.sheetnames:
        raise HTTPException(400, f"Hoja '{sheet_name}' no existe en el archivo")
    if not _detect_sheet_kind(sheet_name):
        raise HTTPException(400, f"Hoja '{sheet_name}' no es de un tipo soportado")

    ws = wb[sheet_name]
    asn_id = _find_asn_number(ws)
    if not asn_id:
        raise HTTPException(400, "No se encontro el numero de ASN en la hoja (celda contigua al label 'ASN')")

    if await db.wms_asn.find_one({"asn_id": asn_id}, {"_id": 1}):
        raise HTTPException(409, f"ASN {asn_id} ya existe en el sistema")

    items, po_number, col_map = _parse_packing_list(ws)
    if not items:
        raise HTTPException(400, "No se encontraron lineas con cantidad > 0 en la hoja")

    # Vendor: most common brand wins, fallback to first
    brands = [it["brand"] for it in items if it.get("brand")]
    vendor = max(set(brands), key=brands.count) if brands else ""

    # Customer: pulled from the "Cliente:" label at the top of the sheet
    customer = _find_label_value(ws, "Cliente", "Client", "Customer")

    doc = {
        "asn_id": asn_id,
        "po_number": po_number,
        "customer": customer,
        "vendor": vendor,
        "expected_date": now_iso(),
        "source_sheet": sheet_name,
        "source_file": file.filename or "",
        "items": items,
        "status": AsnStatus.PENDING,
        "created_at": now_iso(),
        "created_by": user.get("user_id"),
    }
    await db.wms_asn.insert_one(doc)

    detected_columns = {f: _col_letter(c) for f, c in col_map.items()}
    await log_movement(user, MovementType.ASN_IMPORTED, {
        "asn_id": asn_id, "po_number": po_number,
        "items": len(items), "sheet": sheet_name,
        "total_qty": sum(it["qty_expected"] for it in items),
        "detected_columns": detected_columns,
    })

    return {
        "status": "success",
        "asn_id": asn_id,
        "po_number": po_number,
        "vendor": vendor,
        "items_count": len(items),
        "total_qty_expected": sum(it["qty_expected"] for it in items),
        "detected_columns": detected_columns,
    }


async def _apply_receiving_to_asn(
    asn_id: str,
    received_by_pn: dict,
    user: dict,
    target_line_no: int | None = None,
    target_qty: int = 0,
) -> dict:
    """Increment qty_received on an ASN.

    Two modes:
      - target_line_no provided: increment that exact line by target_qty. The
        received_by_pn dict is ignored. Used when the operator explicitly
        picked which ASN line they're receiving (style vocabulary may not match).
      - target_line_no None: increment per part_number using received_by_pn.
        Lines not in the ASN come back as mismatched.

    Returns {matched: [...], mismatched: [...]} for caller to surface warnings.
    """
    result = {"matched": [], "mismatched": []}
    if not asn_id:
        return result

    asn = await db.wms_asn.find_one({"asn_id": asn_id})
    if not asn:
        if target_line_no is not None:
            result["mismatched"] = [{"line_no": target_line_no, "qty": target_qty, "reason": "asn_not_found"}]
        else:
            result["mismatched"] = [{"part_number": pn, "qty": q, "reason": "asn_not_found"}
                                    for pn, q in received_by_pn.items()]
        return result

    if target_line_no is not None:
        # Direct line-level decrement — bypasses style matching entirely
        line = next((it for it in asn.get("items", []) if it.get("line_no") == target_line_no), None)
        if line is None:
            result["mismatched"].append({
                "line_no": target_line_no, "qty": target_qty,
                "reason": "line_not_in_asn",
            })
        elif target_qty > 0:
            await db.wms_asn.update_one(
                {"asn_id": asn_id, "items.line_no": target_line_no},
                {"$inc": {"items.$.qty_received": int(target_qty)}},
            )
            result["matched"].append({
                "line_no": target_line_no,
                "part_number": line.get("part_number"),
                "qty": target_qty,
            })
    else:
        if not received_by_pn:
            return result
        items_by_pn = {it.get("part_number", "").upper(): it for it in asn.get("items", [])}
        for pn, qty in received_by_pn.items():
            pn_u = pn.upper()
            if pn_u in items_by_pn:
                await db.wms_asn.update_one(
                    {"asn_id": asn_id, "items.part_number": pn_u},
                    {"$inc": {"items.$.qty_received": int(qty)}},
                )
                result["matched"].append({"part_number": pn_u, "qty": qty})
            else:
                result["mismatched"].append({
                    "part_number": pn_u, "qty": qty,
                    "reason": "part_not_in_asn",
                })

    # Recalculate status
    fresh = await db.wms_asn.find_one({"asn_id": asn_id}, {"items": 1})
    items = fresh.get("items", []) if fresh else []
    total_exp = sum(it.get("qty_expected", 0) for it in items)
    total_rcv = sum(it.get("qty_received", 0) for it in items)
    if total_rcv <= 0:
        new_status = AsnStatus.PENDING
    elif total_rcv >= total_exp and all(
        it.get("qty_received", 0) >= it.get("qty_expected", 0) for it in items
    ):
        new_status = AsnStatus.RECEIVED
    else:
        new_status = AsnStatus.PARTIAL

    update = {"status": new_status}
    if new_status == AsnStatus.RECEIVED:
        update["received_at"] = now_iso()
    await db.wms_asn.update_one({"asn_id": asn_id}, {"$set": update})

    await log_movement(user, MovementType.ASN_RECEIPT, {
        "asn_id": asn_id,
        "received_by_pn": received_by_pn,
        "mismatched": result["mismatched"],
        "new_status": new_status,
    })

    return result

# ==================== SUPERVISOR OVERRIDES ====================

@router.put("/pick-tickets/{ticket_id}/prioritize")
async def prioritize_ticket(ticket_id: str, request: Request):
    user = await require_admin(request)
    res = await db.wms_pick_tickets.update_one(
        {"ticket_id": ticket_id},
        {"": {"priority": "HOT", "updated_at": now_iso()}}
    )
    if res.modified_count == 0:
        raise HTTPException(404, "Ticket no encontrado")
        
    await db.wms_tasks.update_many(
        {"context.ticket_id": ticket_id},
        {"$set": {"priority": "HOT", "updated_at": now_iso()}}
    )
    
    await log_movement(user, "ticket_prioritized", {"ticket_id": ticket_id})
    return {"status": "success", "message": "Ticket escalado a HOT"}

# ==================== MANUAL INVENTORY ENTRY ====================

@router.post("/inventory")
async def add_inventory_manual(request: Request):
    """Add a single inventory line manually. Accumulates with any existing row
    matching (style, color, size, location); creates a new row otherwise.
    Auto-creates the location if missing and generates LPN boxes for any new
    cases added by this call. Mirrors POST /import/inventory semantics for one
    line so the data shape stays consistent.
    """
    user = await require_auth(request)
    body = await request.json()

    def s(field, default=""):
        v = body.get(field, default)
        return str(v).strip().upper() if isinstance(default, str) else v

    style = s("style") or s("sku")
    if not style:
        raise HTTPException(400, "Style/SKU es requerido")

    location = s("location")
    if not location:
        raise HTTPException(400, "Ubicación es requerida")

    try:
        total_boxes = int(float(body.get("total_boxes", 0) or 0))
        total_units = int(float(body.get("total_units", 0) or 0))
    except (TypeError, ValueError):
        raise HTTPException(400, "Cantidades inválidas")

    if total_units <= 0:
        raise HTTPException(400, "Total de unidades debe ser mayor a 0")
    if total_boxes < 0:
        raise HTTPException(400, "Total de cajas no puede ser negativo")

    color = s("color")
    size = s("size")
    now = now_iso()

    # Operation: "add" (default, entrada) or "remove" (salida / ajuste a la baja).
    operation = str(body.get("operation", "add")).strip().lower()

    # Wider key so two batches of the same SKU with different fabric/COO
    # stay as separate inventory rows (mirrors the import + receiving keys).
    fabric_key = s("fabric_content")
    coo_key = s("country_of_origin")
    existing = await db.wms_inventory.find_one({
        "style": style, "color": color, "size": size, "location": location,
        "fabric_content": fabric_key, "country_of_origin": coo_key,
    })

    # ── Salida manual (remove): resta de una línea existente ──────────────────
    if operation == "remove":
        # Fall back to the core key when fabric/COO weren't supplied so the
        # operator can pull stock out without re-typing every metadata field.
        if not existing:
            existing = await db.wms_inventory.find_one(
                {"style": style, "color": color, "size": size, "location": location},
                sort=[("units_on_hand", -1)],
            )
        if not existing:
            raise HTTPException(404, "No existe inventario para esa combinación (SKU+color+talla+ubicación)")

        reason = s("reason")
        if not reason:
            raise HTTPException(400, "El motivo de la salida es obligatorio")

        on_hand = int(existing.get("units_on_hand", 0) or 0)
        allocated = int(existing.get("units_allocated", 0) or 0)
        cur_boxes = int(existing.get("total_boxes", 0) or 0)
        if total_units > on_hand:
            raise HTTPException(400, f"No puedes sacar {total_units}: solo hay {on_hand} en existencia")
        if on_hand - total_units < allocated:
            raise HTTPException(
                400,
                f"No puedes sacar {total_units}: {allocated} están comprometidas (allocated). Disponible libre: {on_hand - allocated}",
            )
        if total_boxes > cur_boxes:
            raise HTTPException(400, f"No puedes sacar {total_boxes} cajas: solo hay {cur_boxes} registradas")

        inventory_id = existing["inventory_id"]
        await db.wms_inventory.update_one(
            {"inventory_id": inventory_id},
            {"$inc": {"total_boxes": -total_boxes, "units_on_hand": -total_units},
             "$set": {"updated_at": now}},
        )
        # Drop the oldest LPN boxes for this row to match the case count removed.
        if total_boxes > 0:
            old_box_ids = [
                b["box_id"] for b in await db.wms_boxes.find(
                    {"inventory_id": inventory_id}, {"_id": 0, "box_id": 1}
                ).sort("created_at", 1).to_list(total_boxes)
            ]
            if old_box_ids:
                await db.wms_boxes.delete_many({"box_id": {"$in": old_box_ids}})

        await log_movement(user, "manual_inventory_remove", {
            "inventory_id": inventory_id, "mode": "removed",
            "style": style, "color": color, "size": size, "location": location,
            "removed_boxes": total_boxes, "removed_units": total_units,
        })
        return {
            "inventory_id": inventory_id, "mode": "removed", "location_created": False,
            "removed_boxes": total_boxes, "removed_units": total_units,
            "added_boxes": -total_boxes, "added_units": -total_units,
        }

    # Case# 006: link a positive adjustment to a REAL box number the operator
    # scans/types, instead of the synthetic LPN generated by default. When
    # supplied, exactly one real box is created (total_boxes forced to 1).
    manual_box_id = str(body.get("box_id", "") or "").strip().upper()
    if manual_box_id:
        clash = await db.wms_boxes.find_one(
            {"$or": [{"box_id": manual_box_id}, {"barcode": manual_box_id}, {"lpn_id": manual_box_id}]},
            {"_id": 0, "box_id": 1},
        )
        if clash:
            raise HTTPException(400, f"La caja {manual_box_id} ya existe; usa un número distinto")
        total_boxes = 1

    if existing:
        inventory_id = existing["inventory_id"]
        await db.wms_inventory.update_one(
            {"inventory_id": inventory_id},
            {"$inc": {"total_boxes": total_boxes, "units_on_hand": total_units},
             "$set": {"updated_at": now}},
        )
        mode = "accumulated"
    else:
        inventory_id = f"inv_{uuid.uuid4().hex[:12]}"
        await db.wms_inventory.insert_one({
            "inventory_id": inventory_id,
            "customer": s("customer"),
            "style": style,
            "sku": style,
            "color": color,
            "size": size,
            "size_header": s("size_header"),
            "manufacturer": s("manufacturer"),
            "description": s("description"),
            "category": s("category"),
            "country_of_origin": s("country_of_origin"),
            "fabric_content": s("fabric_content"),
            "import_number": body.get("import_number", ""),
            "po": body.get("po", ""),
            "bpo": body.get("bpo", ""),
            "location": location,
            "total_boxes": total_boxes,
            "units_on_hand": total_units,
            "units_allocated": 0,
            "updated_at": now,
        })
        mode = "created"

    # Generate the box(es) for the units we just added.
    if manual_box_id:
        # One real, scannable box stamped with the operator's number (Case# 006).
        await db.wms_boxes.insert_one({
            "box_id": manual_box_id, "barcode": manual_box_id, "lpn_id": manual_box_id,
            "inventory_id": inventory_id,
            "sku": style, "color": color, "size": size,
            "units": total_units, "qty": total_units,
            "location": location, "state": "putaway",
            "customer": s("customer"), "coo": coo_key, "country_of_origin": coo_key,
            "fabric_content": fabric_key, "description": s("description"),
            "manufacturer": s("manufacturer"), "created_at": now,
        })
    elif total_boxes > 0:
        # Fallback: synthetic LPNs (bulk multi-line add / no number supplied).
        units_per_box = total_units // total_boxes
        remainder = total_units % total_boxes
        box_docs = [{
            "box_id": f"LPN_{uuid.uuid4().hex[:8].upper()}",
            "inventory_id": inventory_id,
            "sku": style,
            "color": color,
            "size": size,
            "units": units_per_box + (1 if i < remainder else 0),
            "qty": units_per_box + (1 if i < remainder else 0),
            "location": location,
            "state": "putaway",
            "customer": s("customer"),
            "coo": coo_key,
            "country_of_origin": coo_key,
            "fabric_content": fabric_key,
            "description": s("description"),
            "manufacturer": s("manufacturer"),
            "created_at": now,
        } for i in range(total_boxes)]
        await db.wms_boxes.insert_many(box_docs)

    # Auto-create location if missing (case-insensitive check).
    loc_existing = await db.wms_locations.find_one(
        {"name": {"$regex": f"^{re.escape(location)}$", "$options": "i"}}
    )
    location_created = False
    if not loc_existing:
        zone = location.split("-")[0] if "-" in location else "DEFAULT"
        await db.wms_locations.insert_one({
            "location_id": f"loc_{uuid.uuid4().hex[:12]}",
            "name": location,
            "zone": zone,
            "type": "rack",
            "active": True,
            "created_at": now,
        })
        location_created = True

    await log_movement(user, "manual_inventory_add", {
        "inventory_id": inventory_id,
        "mode": mode,
        "reason": s("reason"),
        "style": style,
        "color": color,
        "size": size,
        "location": location,
        "added_boxes": total_boxes,
        "added_units": total_units,
        "box_id": manual_box_id or None,
    })

    return {
        "inventory_id": inventory_id,
        "mode": mode,
        "location_created": location_created,
        "added_boxes": total_boxes,
        "added_units": total_units,
        "box_id": manual_box_id or None,
    }


@router.delete("/inventory/{inventory_id}")
async def delete_inventory_row(inventory_id: str, request: Request):
    """Admin-only: remove a single inventory line (and its linked LPN boxes)
    from a location. Used by the Locations detail modal to clear contents.
    Matches strictly by inventory_id, so it never touches other locations or
    duplicate rows of the same SKU."""
    user = await require_admin(request)
    inv = await db.wms_inventory.find_one({"inventory_id": inventory_id})
    if not inv:
        raise HTTPException(404, "Inventario no encontrado")
    await db.wms_inventory.delete_one({"inventory_id": inventory_id})
    box_res = await db.wms_boxes.delete_many({"inventory_id": inventory_id})
    await log_movement(user, "inventory_deleted", {
        "inventory_id": inventory_id,
        "sku": inv.get("sku"), "style": inv.get("style"),
        "color": inv.get("color"), "size": inv.get("size"),
        "location": inv.get("location"),
        "units_removed": inv.get("units_on_hand", 0),
        "boxes_removed": box_res.deleted_count,
    })
    return {"message": "Inventario eliminado", "inventory_id": inventory_id, "boxes_removed": box_res.deleted_count}


# ==================== IMPORT INVENTORY ====================

@router.post("/import/inventory")
async def import_inventory(request: Request, file: UploadFile = File(...)):
    # Admin-only: this endpoint REPLACES the entire warehouse (see wipe below).
    user = await require_admin(request)
    if not file.filename.endswith(('.xlsx', '.xls')):
        raise HTTPException(400, "Solo archivos Excel (.xlsx)")

    import openpyxl
    contents = await file.read()
    wb = openpyxl.load_workbook(io.BytesIO(contents), read_only=True)
    ws = wb.active
    rows = list(ws.iter_rows(values_only=True))
    if len(rows) < 2:
        raise HTTPException(400, "El archivo esta vacio")

    headers = [str(h).strip() if h else '' for h in rows[0]]
    col_map = {h: i for i, h in enumerate(headers)}

    def get(row, name, default=""):
        idx = col_map.get(name)
        if idx is None or idx >= len(row) or row[idx] is None:
            return default
        return str(row[idx]).strip() if isinstance(default, str) else row[idx]

    now = now_iso()
    inventory_by_key = {}
    box_docs = []
    locations_set = set()
    skipped = 0


    for row in rows[1:]:
        style = get(row, 'Style', '').strip().upper()
        if not style:
            skipped += 1
            continue

        color = get(row, 'Color', '').strip().upper()
        size = str(get(row, 'Size', '')).strip().upper()
        inv_loc = get(row, 'InvLocation', '').strip().upper()
        total_boxes = int(float(get(row, 'Total Boxes', 0) or 0))
        total_units = int(float(get(row, 'TotalUnits', 0) or 0))
        description = get(row, 'Description', '').strip().upper()
        coo = get(row, 'CountryofOrigin', '').strip().upper()
        fabric = get(row, 'FabricContent', '').strip().upper()

        if inv_loc:
            locations_set.add(inv_loc)

        # Include fabric + COO in the key so distinct batches at the same shelf
        # stay separate (matches _update_inventory_enhanced behavior).
        key = (style, color, size, inv_loc, fabric, coo)
        if key not in inventory_by_key:
            inventory_id = f"inv_{uuid.uuid4().hex[:12]}"
            inventory_by_key[key] = {
                "inventory_id": inventory_id,
                "customer": get(row, 'CustomerID', '').strip().upper(),
                "style": style,
                "sku": style,
                "color": color,
                "size": size,
                "size_header": get(row, 'SizeHeader', '').strip().upper(),
                "manufacturer": get(row, 'Manufacturer', '').strip().upper(),
                "description": description,
                "category": get(row, 'Category', '').strip().upper(),
                "country_of_origin": coo,
                "fabric_content": get(row, 'FabricContent', '').strip().upper(),
                "import_number": get(row, 'ImportNumber', ''),
                "po": get(row, 'PO', ''),
                "bpo": get(row, 'BPO', ''),
                "location": inv_loc,
                "total_boxes": 0,
                "units_on_hand": 0,
                "units_allocated": 0,
                "updated_at": now
            }

        # Accumulate quantities
        inventory_by_key[key]["total_boxes"] += total_boxes
        inventory_by_key[key]["units_on_hand"] += total_units

        # Retrieve the consolidated inventory_id for the boxes
        inventory_id = inventory_by_key[key]["inventory_id"]

        # Generate LPNs (boxes) for this line item
        if total_boxes > 0:
            units_per_box = total_units // total_boxes
            remainder = total_units % total_boxes
            for i in range(total_boxes):
                box_units = units_per_box + (1 if i < remainder else 0)
                box_docs.append({
                    "box_id": f"LPN_{uuid.uuid4().hex[:8].upper()}",
                    "inventory_id": inventory_id,
                    "sku": style,
                    "color": color,
                    "size": size,
                    "units": box_units,
                    "qty": box_units,
                    "location": inv_loc,
                    "state": "putaway",
                    "customer": get(row, 'CustomerID', '').strip().upper(),
                    "manufacturer": get(row, 'Manufacturer', '').strip().upper(),
                    "description": description,
                    "coo": coo,
                    "country_of_origin": coo,
                    "fabric_content": fabric,
                    "created_at": now
                })

    inventory_docs = list(inventory_by_key.values())

    # SAFETY GUARD — this endpoint REPLACES the whole warehouse. Before this guard
    # existed a wrong/empty Excel wiped everything (real 2026-05-29 incident).
    # Refuse to wipe when the upload parsed to nothing or skipped most rows
    # (mis-mapped headers), and snapshot the current data into *_prev collections
    # in Mongo first so a bad import is recoverable.
    data_rows = max(0, len(rows) - 1)
    if not inventory_docs:
        raise HTTPException(400, "El archivo no produjo inventario válido (¿encabezados mal mapeados?). No se borró nada.")
    if data_rows and skipped > data_rows * 0.5:
        raise HTTPException(400, f"Se omitieron {skipped} de {data_rows} filas — revisa el archivo/encabezados. No se borró nada para proteger el inventario.")

    # Durable rollback snapshot (server-side copy) before the destructive replace.
    await db.wms_inventory.aggregate([{"$out": "wms_inventory_prev"}]).to_list(1)
    await db.wms_boxes.aggregate([{"$out": "wms_boxes_prev"}]).to_list(1)

    # Clear old data (WMS 2.0 Fresh Start)
    await db.wms_inventory.delete_many({})
    await db.wms_boxes.delete_many({})
    await db.wms_tasks.delete_many({})
    await db.wms_allocations.delete_many({})
    if inventory_docs:
        batch_size = 1000
        for i in range(0, len(inventory_docs), batch_size):
            await db.wms_inventory.insert_many(inventory_docs[i:i+batch_size])
    if box_docs:
        batch_size = 1000
        for i in range(0, len(box_docs), batch_size):
            await db.wms_boxes.insert_many(box_docs[i:i+batch_size])


    # Auto-create locations with strict case-insensitive check
    locations_created = 0
    for loc_name in locations_set:
        # Normalizar el nombre para la busqueda
        clean_name = loc_name.strip().upper()
        if not clean_name: continue
        
        existing = await db.wms_locations.find_one({"name": {"$regex": f"^{re.escape(clean_name)}$", "$options": "i"}})
        if not existing:
            zone = clean_name.split('-')[0] if '-' in clean_name else "DEFAULT"
            await db.wms_locations.insert_one({
                "location_id": f"loc_{uuid.uuid4().hex[:12]}",
                "name": clean_name,
                "zone": zone,
                "type": "rack",
                "active": True,
                "created_at": now
            })
            locations_created += 1

    # Log movement
    await db.wms_movements.insert_one({
        "movement_id": f"mov_{uuid.uuid4().hex[:12]}",
        "type": "import",
        "description": f"Imported {len(inventory_docs)} inventory records from {file.filename}",
        "user": user.get("name", user.get("email", "")),
        "timestamp": now
    })

    wb.close()
    return {
        "imported": len(inventory_docs),
        "skipped": skipped,
        "locations_created": locations_created,
        "total_locations": len(locations_set)
    }


# ==================== SKU GENERATION ====================

@router.get("/generate-sku")
async def generate_sku(request: Request, style: str = "", color: str = "", size: str = ""):
    """Preview auto-generated SKU for a style+color+size combination."""
    await require_auth(request)
    if not style:
        return {"sku": ""}
    base = style.upper().replace(' ', '-')
    parts = [base]
    if color: parts.append(color.upper().replace(' ', '-')[:10])
    if size: parts.append(size.upper())
    sku = '-'.join(parts)
    return {"sku": sku}

# ==================== CYCLE COUNT ====================

@router.post("/cycle-counts")
async def create_cycle_count(request: Request):
    """Create a new cycle count task."""
    user = await require_admin(request)
    body = await request.json()
    name = body.get("name", "").strip()
    location_filter = body.get("location_filter", "").strip()
    customer_filter = body.get("customer_filter", "").strip()
    style_filter = body.get("style_filter", "").strip()
    assigned_to = body.get("assigned_to", "").strip()
    assigned_to_name = body.get("assigned_to_name", "").strip()
    is_general = body.get("is_general", False) or (not location_filter and not customer_filter and not style_filter)

    if not name:
        raise HTTPException(400, "Nombre del conteo requerido")

    # Build query to get inventory items for this count
    query = {}
    if not is_general:
        if location_filter:
            # Prefix search for locations sharing the prefix
            query["location"] = {"$regex": f"^{re.escape(location_filter)}", "$options": "i"}
        if customer_filter:
            query["customer"] = {"$regex": f"^{customer_filter}$", "$options": "i"}
        if style_filter:
            query["style"] = {"$regex": f"^{style_filter}$", "$options": "i"}

    # Get inventory items matching filters - Increase limit to 50,000 for general counts
    items = await db.wms_inventory.find(query, {"_id": 0}).to_list(50000)
    if not items:
        raise HTTPException(400, "No se encontraron items con los filtros proporcionados")

    # Build count lines. We snapshot the descriptive fields at creation time
    # (description / customer / country / fabric / manufacturer) so the counter
    # has full context on the item without an extra fetch. Old counts created
    # before this change get enriched lazily on GET (see get_cycle_count below).
    count_lines = []
    for item in items:
        count_lines.append({
            "line_id": gen_id("cl"),
            "style": item.get("style", ""),
            "color": item.get("color", ""),
            "size": item.get("size", ""),
            "inv_location": item.get("location", ""),
            "sku": item.get("sku", ""),
            "system_qty": item.get("units_on_hand", 0),
            "description": item.get("description", ""),
            "customer": item.get("customer", ""),
            "manufacturer": item.get("manufacturer", ""),
            "country_of_origin": item.get("country_of_origin", ""),
            "fabric_content": item.get("fabric_content", ""),
            "counted_qty": None,
            "discrepancy": None,
            "counted": False
        })

    count_id = gen_id("cc")
    count_doc = {
        "count_id": count_id,
        "name": name,
        "status": "pending",
        "is_general": is_general,
        "location_filter": location_filter if not is_general else "",
        "customer_filter": customer_filter if not is_general else "",
        "style_filter": style_filter if not is_general else "",
        "assigned_to": assigned_to or None,
        "assigned_to_name": assigned_to_name or None,
        "total_lines": len(count_lines),
        "counted_lines": 0,
        "lines": count_lines,
        "created_by": user.get("user_id"),
        "created_by_name": user.get("name", ""),
        "created_at": now_iso(),
    }
    await db.wms_cycle_counts.insert_one(count_doc)
    count_doc.pop("_id", None)
    await log_movement(user, "cycle_count_created", {"count_id": count_id, "total_lines": len(count_lines), "is_general": is_general})

    if assigned_to:
        await ws_manager.broadcast("cycle_count_assigned", {
            "count_id": count_id,
            "assigned_to": assigned_to,
            "assigned_to_name": assigned_to_name,
            "name": name
        })

    await notify_badge_change("cycle_count")
    return count_doc

@router.get("/cycle-counts")
async def list_cycle_counts(request: Request):
    """List all cycle counts."""
    await require_auth(request)
    counts = await db.wms_cycle_counts.find({}, {"_id": 0, "lines": 0}).sort("created_at", -1).to_list(200)
    return counts

@router.get("/cycle-counts/{count_id}")
async def get_cycle_count(count_id: str, request: Request):
    """Get a cycle count with all lines. For counts created before we started
    snapshotting description/customer/country/fabric/manufacturer onto each
    line, enrich on the fly by joining against current wms_inventory so the
    counter always sees the full context."""
    await require_auth(request)
    count = await db.wms_cycle_counts.find_one({"count_id": count_id}, {"_id": 0})
    if not count:
        raise HTTPException(404, "Conteo no encontrado")

    lines = count.get("lines") or []
    if lines:
        missing_idx = [
            i for i, l in enumerate(lines)
            if not l.get("description") and not l.get("customer") and not l.get("fabric_content")
        ]
        if missing_idx:
            # One inventory lookup per missing line, keyed on the (sku, location)
            # pair that uniquely identifies each inventory row.
            keys = []
            for i in missing_idx:
                line = lines[i]
                keys.append({
                    "sku": line.get("sku") or line.get("style") or "",
                    "color": line.get("color") or "",
                    "size": line.get("size") or "",
                    "location": line.get("inv_location") or "",
                })
            # Build a single Mongo $or query for the join.
            or_clauses = [{"sku": k["sku"], "color": k["color"], "size": k["size"], "location": k["location"]} for k in keys if k["sku"]]
            inv_map = {}
            if or_clauses:
                async for inv in db.wms_inventory.find(
                    {"$or": or_clauses},
                    {"_id": 0, "sku": 1, "color": 1, "size": 1, "location": 1,
                     "description": 1, "customer": 1, "manufacturer": 1,
                     "country_of_origin": 1, "fabric_content": 1},
                ):
                    k = (inv.get("sku", ""), inv.get("color", ""), inv.get("size", ""), inv.get("location", ""))
                    inv_map[k] = inv
            for i in missing_idx:
                line = lines[i]
                k = (
                    line.get("sku") or line.get("style") or "",
                    line.get("color") or "",
                    line.get("size") or "",
                    line.get("inv_location") or "",
                )
                inv = inv_map.get(k)
                if inv:
                    line["description"] = line.get("description") or inv.get("description", "")
                    line["customer"] = line.get("customer") or inv.get("customer", "")
                    line["manufacturer"] = line.get("manufacturer") or inv.get("manufacturer", "")
                    line["country_of_origin"] = line.get("country_of_origin") or inv.get("country_of_origin", "")
                    line["fabric_content"] = line.get("fabric_content") or inv.get("fabric_content", "")
            count["lines"] = lines
    return count

@router.put("/cycle-counts/{count_id}/count")
async def save_count_progress(count_id: str, request: Request):
    """Save counting progress - operator submits counted quantities."""
    user = await require_auth(request)
    body = await request.json()
    counted_items = body.get("counted_items", {})  # { line_id: counted_qty }

    count = await db.wms_cycle_counts.find_one({"count_id": count_id}, {"_id": 0})
    if not count:
        raise HTTPException(404, "Conteo no encontrado")
    if count.get("status") == "approved":
        raise HTTPException(400, "Este conteo ya fue aprobado")

    lines = count.get("lines", [])
    counted_count = 0
    adjustments = 0
    for line in lines:
        lid = line["line_id"]
        if lid in counted_items:
            qty = int(counted_items[lid])
            line["counted_qty"] = qty
            line["discrepancy"] = qty - (line.get("system_qty", 0) or 0)
            line["counted"] = True
            line["counted_by"] = user.get("user_id")
            line["counted_at"] = now_iso()
            # IMMEDIATE ADJUSTMENT (requirement): apply the variance to inventory
            # the moment the auditor saves this line — no longer wait for the admin
            # to approve the finished count. It's an absolute SET (units_on_hand =
            # counted_qty), so it's idempotent: re-saving the same number is a
            # no-op and a recount cleanly overwrites the previous adjustment.
            if line["discrepancy"]:
                res = await db.wms_inventory.update_one(
                    {"style": line["style"], "color": line["color"], "size": line["size"], "location": line["inv_location"]},
                    {"$set": {"units_on_hand": qty, "updated_at": now_iso()}},
                )
                if res.matched_count:
                    line["adjusted"] = True
                    line["adjusted_at"] = now_iso()
                    line["adjusted_by"] = user.get("user_id")
                    adjustments += 1
                    await log_movement(user, "cycle_count_adjustment", {
                        "count_id": count_id, "line_id": lid,
                        "sku": line.get("sku") or line.get("style"),
                        "location": line.get("inv_location"),
                        "from": line.get("system_qty", 0), "to": qty,
                        "discrepancy": line["discrepancy"],
                    })
        if line.get("counted"):
            counted_count += 1

    status = "completed" if counted_count >= len(lines) else "in_progress"
    await db.wms_cycle_counts.update_one({"count_id": count_id}, {"$set": {
        "lines": lines,
        "counted_lines": counted_count,
        "status": status,
        "last_updated_by": user.get("user_id"),
        "last_updated_at": now_iso()
    }})
    await log_movement(user, "cycle_count_progress", {"count_id": count_id, "counted": counted_count, "total": len(lines), "adjustments": adjustments})
    if adjustments:
        await notify_badge_change("cycle_count")
    msg = f"Progreso guardado ({counted_count}/{len(lines)})"
    if adjustments:
        msg += f" · {adjustments} ajuste(s) aplicado(s) al inventario"
    return {"message": msg, "status": status, "adjustments": adjustments}

@router.put("/cycle-counts/{count_id}/approve")
async def approve_cycle_count(count_id: str, request: Request):
    """Admin approves cycle count and adjusts inventory."""
    user = await require_admin(request)
    count = await db.wms_cycle_counts.find_one({"count_id": count_id}, {"_id": 0})
    if not count:
        raise HTTPException(404, "Conteo no encontrado")
    if count.get("status") != "completed":
        raise HTTPException(400, "El conteo debe estar completado antes de aprobar")

    adjustments = 0
    already = 0
    for line in count.get("lines", []):
        if line.get("discrepancy") and line["discrepancy"] != 0:
            # Variances are now applied the instant the auditor saves the line
            # (see save_count_progress). Skip lines already adjusted so approval
            # is just a sign-off and never clobbers stock that legitimately
            # changed between the count and the approval.
            if line.get("adjusted"):
                already += 1
                continue
            res = await db.wms_inventory.update_one(
                {"style": line["style"], "color": line["color"], "size": line["size"], "location": line["inv_location"]},
                {"$set": {"units_on_hand": line["counted_qty"], "updated_at": now_iso()}}
            )
            if res.matched_count:
                line["adjusted"] = True
                line["adjusted_at"] = now_iso()
                adjustments += 1

    await db.wms_cycle_counts.update_one({"count_id": count_id}, {"$set": {
        "status": "approved",
        "lines": count.get("lines", []),
        "approved_by": user.get("user_id"),
        "approved_by_name": user.get("name", ""),
        "approved_at": now_iso(),
        "adjustments": adjustments + already
    }})
    await log_movement(user, "cycle_count_approved", {"count_id": count_id, "adjustments": adjustments, "already_applied": already})
    await notify_badge_change("cycle_count")
    return {"message": f"Conteo aprobado. {already} ajuste(s) aplicados durante el conteo, {adjustments} nuevo(s) al aprobar.", "adjustments": adjustments + already}

@router.delete("/cycle-counts/{count_id}")
async def delete_cycle_count(count_id: str, request: Request):
    """Admin deletes a cycle count."""
    user = await require_admin(request)
    count = await db.wms_cycle_counts.find_one({"count_id": count_id})
    if not count:
        raise HTTPException(404, "Conteo no encontrado")
    await db.wms_cycle_counts.delete_one({"count_id": count_id})
    await log_movement(user, "cycle_count_deleted", {"count_id": count_id, "name": count.get("name")})
    await notify_badge_change("cycle_count")
    return {"message": "Conteo ciclico eliminado correctamente"}

# ==================== QUICK INLINE UPDATES ====================

@router.put("/pick-tickets/{ticket_id}/status")
async def quick_status_update(ticket_id: str, request: Request):
    user = await require_auth(request)
    body = await request.json()
    if "blank_status" in body:
        new_status = body["blank_status"]
        # Determine if it's a virtual ticket or a real one
        order_number = None
        if ticket_id.startswith("virt_"):
            # If virtual, the ID is virt_ORDER_ID. BUT wait, let's look at list_pick_tickets logic.
            # It uses virt_vo.get('order_id')
            order_id = ticket_id.replace("virt_", "")
            order = await db.orders.find_one({"order_id": order_id})
            if order:
                order_number = order.get("order_number")
        else:
            ticket = await db.wms_pick_tickets.find_one({"ticket_id": ticket_id})
            if ticket:
                await db.wms_pick_tickets.update_one({"ticket_id": ticket_id}, {"$set": {"blank_status": new_status}})
                order_number = ticket.get("order_number")
        
        if order_number:
            await db.orders.update_one({"order_number": order_number}, {"$set": {"blank_status": new_status}})
            
    return {"status": "ok"}

# ==================== WMS 2.0 DIRECTED TASKS ====================

@router.get("/tasks/next")
async def get_next_task(request: Request, user_zone: str = ""):
    """Directed Work System: Retrieves the single highest priority task for the operator."""
    user = await require_auth(request)
    
    # Try finding HOT priority first
    hot_query = {"status": "pending", "priority": "HOT"}
    if user_zone:
        hot_query["context.suggested_zone"] = {"$regex": f"^{user_zone}$", "$options": "i"}
        
    next_task = await db.wms_tasks.find_one(hot_query, sort=[("created_at", 1)])
    
    # Fallback to NORMAL
    if not next_task:
        normal_query = {"status": "pending"}
        if user_zone:
            normal_query["context.suggested_zone"] = {"$regex": f"^{user_zone}$", "$options": "i"}
        # Fetch top 50 to sort by Travel Sequence in memory
        tasks = await db.wms_tasks.find(normal_query).sort("created_at", 1).to_list(50)
        if tasks:
            def get_sort_key(t):
                loc = t.get("context", {}).get("suggested_zone", "ZZ-99-9")
                parts = loc.split("-")
                aisle = parts[0] if len(parts) > 0 else "ZZ"
                section = parts[1] if len(parts) > 1 else "99"
                level = parts[2] if len(parts) > 2 else "9"
                return (aisle, section, level)
            tasks.sort(key=get_sort_key)
            next_task = tasks[0]
        else:
            next_task = None
        
    if not next_task:
        return {"task": None, "message": "No pending tasks."}
        
    # Claim it for the user
    task_id = next_task["task_id"]
    await db.wms_tasks.update_one(
        {"task_id": task_id},
        {"$set": {"status": "assigned", "assigned_to": user.get("user_id"), "assigned_at": now_iso()}}
    )
    
    # Hydrate lpn_details automatically
    lpn_id = next_task.get("lpn_id")
    if lpn_id:
        lpn = await db.wms_boxes.find_one({"box_id": lpn_id}, {"_id": 0})
        next_task["lpn_details"] = lpn
        
    next_task.pop("_id", None)
    return {"task": next_task}

@router.post("/tasks/{task_id}/complete")
async def complete_task(task_id: str, request: Request):
    """Marks a directed task as complete and permanently updates core objects."""
    user = await require_auth(request)
    body = await request.json()
    scan_validation = body.get("scan", "")
    
    task = await db.wms_tasks.find_one({"task_id": task_id})
    if not task:
        raise HTTPException(404, "Task not found")
        
    lpn_id = task.get("lpn_id")
    if lpn_id and scan_validation != lpn_id:
        raise HTTPException(400, "Validation failed: Scanned LPN does not match Task LPN.")
        
    # Execution Logic
    if task["task_type"] == "putaway":
        dest_location = body.get("destination_location", "").strip()
        if not dest_location:
            raise HTTPException(400, "destination_location is required for putaway")
        await db.wms_boxes.update_one({"box_id": lpn_id}, {"$set": {"location": dest_location, "status": "stored"}})
        
    elif task["task_type"] == "cross_dock":
        dest_location = body.get("destination_location", "Produccion")
        await db.wms_boxes.update_one({"box_id": lpn_id}, {"$set": {"location": dest_location, "status": "cross_docked"}})
        
    await db.wms_tasks.update_one({"task_id": task_id}, {
        "$set": {"status": "completed", "completed_at": now_iso(), "completed_by": user.get("name", "")}
    })
    
    await log_movement(user, "task_completed", {"task_id": task_id, "type": task["task_type"]})
    await notify_badge_change("all")
    return {"message": "Task successfully executed"}


# ==================== UPC PRODUCT CATALOG ====================
# Single source of truth for what a UPC means. Receiving (and the inline
# Crear ASN modal later) look up by UPC to autofill style/color/size/etc
# so the same product never lands twice with conflicting descriptions.
#
# Collection: wms_upc_catalog. Unique key: upc (normalized to digits-only
# uppercase). Other fields are the canonical product metadata.


def _norm_upc(raw) -> str:
    """Strip whitespace and uppercase. Don't restrict to digits because some
    customers use alphanumeric internal codes — but trim aggressively so a
    typo'd trailing space doesn't bypass uniqueness."""
    return str(raw or "").strip().upper()


@router.get("/upc/{upc}")
async def get_upc(upc: str, request: Request):
    """Lookup a UPC. Returns 404 if not in the catalog so the frontend can
    show the 'Crear UPC' button."""
    await require_auth(request)
    code = _norm_upc(upc)
    if not code:
        raise HTTPException(400, "upc requerido")
    doc = await db.wms_upc_catalog.find_one({"upc": code}, {"_id": 0})
    if not doc:
        raise HTTPException(404, f"UPC {code} no encontrado")
    return doc


@router.get("/upc")
async def list_upc(request: Request, search: str = "", customer: str = "",
                    style: str = "", limit: int = 200):
    """List the catalog with optional filters. Used by the typeahead in the
    Receiving form so the operator can pick a UPC without typing it whole."""
    await require_auth(request)
    query = {}
    if customer:
        query["customer"] = {"$regex": re.escape(customer), "$options": "i"}
    if style:
        query["style"] = {"$regex": re.escape(style), "$options": "i"}
    if search:
        rx = {"$regex": re.escape(search), "$options": "i"}
        query["$or"] = [
            {"upc": rx}, {"style": rx}, {"description": rx},
            {"color": rx}, {"customer": rx}, {"brand": rx},
        ]
    limit = max(1, min(limit, 1000))
    docs = await db.wms_upc_catalog.find(query, {"_id": 0}).sort("upc", 1).to_list(limit)
    return docs


@router.post("/upc")
async def create_upc(request: Request):
    """Create a UPC catalog entry. Idempotent: returns the existing doc if the
    UPC is already registered (so a race between two operators capturing the
    same UPC doesn't error out — the second one just gets the existing one)."""
    user = await require_auth(request)
    body = await request.json()
    code = _norm_upc(body.get("upc"))
    if not code:
        raise HTTPException(400, "upc es obligatorio")

    existing = await db.wms_upc_catalog.find_one({"upc": code}, {"_id": 0})
    if existing:
        return existing  # idempotent return

    doc = {
        "upc": code,
        "customer": str(body.get("customer", "")).strip().upper(),
        "manufacturer": str(body.get("manufacturer", "")).strip().upper(),
        "style": str(body.get("style", "")).strip().upper(),
        "color": str(body.get("color", "")).strip().upper(),
        "size": str(body.get("size", "")).strip().upper(),
        "description": str(body.get("description", "")).strip(),
        "country_of_origin": str(body.get("country_of_origin", "")).strip().upper(),
        "fabric_content": str(body.get("fabric_content", "")).strip(),
        "brand": str(body.get("brand", "")).strip().upper(),
        "sku": str(body.get("sku", "")).strip().upper(),
        "created_at": now_iso(),
        "created_by": user.get("user_id"),
        "created_by_name": user.get("name", ""),
    }
    if not doc["style"]:
        raise HTTPException(400, "style es obligatorio para crear un UPC")
    await db.wms_upc_catalog.insert_one(doc)
    doc.pop("_id", None)
    return doc


@router.put("/upc/{upc}")
async def update_upc(upc: str, request: Request):
    """Admin-only edit. Useful when a description or country was captured
    wrong on first sight and needs correction (propagation to past receipts
    is NOT automatic — only future ones inherit the new value)."""
    user = await require_admin(request)
    code = _norm_upc(upc)
    body = await request.json()
    existing = await db.wms_upc_catalog.find_one({"upc": code})
    if not existing:
        raise HTTPException(404, f"UPC {code} no encontrado")
    allowed = ["customer", "manufacturer", "style", "color", "size", "description",
               "country_of_origin", "fabric_content", "brand", "sku"]
    update = {}
    for k in allowed:
        if k in body:
            update[k] = (str(body[k]).strip().upper() if k != "description" and k != "fabric_content"
                          else str(body[k]).strip())
    if not update:
        raise HTTPException(400, "Nada que actualizar")
    update["updated_at"] = now_iso()
    update["updated_by"] = user.get("user_id")
    await db.wms_upc_catalog.update_one({"upc": code}, {"$set": update})
    return await db.wms_upc_catalog.find_one({"upc": code}, {"_id": 0})


@router.post("/upc/{upc}/correct")
async def correct_upc(upc: str, request: Request):
    """Admin-only: fix a UPC captured with wrong attributes and cascade the fix
    to the stock already received with it.
      - Identity fields (style/sku, color, size) change the inventory line, so we
        MOVE each affected box's units from its old line to the corrected line
        (same location), keeping on_hand / total_boxes consistent.
      - Descriptive fields (description, country_of_origin, fabric_content,
        customer, manufacturer, brand) are updated in place on the boxes,
        receivings, catalog and the boxes' inventory lines.
    dry-run by default; apply=true commits. Refuses if any affected source line
    has allocated units, so open order allocations never desync."""
    user = await require_admin(request)
    code = _norm_upc(upc)
    body = await request.json()
    apply = bool(body.get("apply", False))
    raw_changes = body.get("changes") or {}

    cat = await db.wms_upc_catalog.find_one({"upc": code})
    if not cat:
        raise HTTPException(404, f"UPC {code} no encontrado")

    from collections import defaultdict

    UPPER = {"style", "sku", "color", "size", "country_of_origin", "customer", "manufacturer", "brand"}
    ALLOWED = ["style", "sku", "color", "size", "description", "country_of_origin",
               "fabric_content", "customer", "manufacturer", "brand"]
    changes = {}
    for k in ALLOWED:
        if k in raw_changes and raw_changes[k] is not None:
            v = str(raw_changes[k]).strip()
            v = v.upper() if k in UPPER else v
            cur = str(cat.get(k, "") or "").strip()
            cur = cur.upper() if k in UPPER else cur
            if v != cur:
                changes[k] = v
    if not changes:
        raise HTTPException(400, "No hay cambios para aplicar")
    # Inventory keys on sku; keep it in lockstep with style.
    if "style" in changes and "sku" not in changes:
        changes["sku"] = changes["style"]

    KEY = {"sku", "color", "size"}  # fields that move inventory between lines
    key_changed = bool(KEY & set(changes.keys()))

    rcvs = await db.wms_receiving.find({"upc": code}, {"receiving_id": 1}).to_list(2000)
    rcv_ids = [r["receiving_id"] for r in rcvs]
    or_clauses = [{"upc": code}]
    if rcv_ids:
        or_clauses.append({"receiving_id": {"$in": rcv_ids}})
    boxes = await db.wms_boxes.find({"$or": or_clauses}, {"_id": 0}).to_list(5000)

    def src_key(b):
        return (b.get("sku") or b.get("style") or "", b.get("color", ""), b.get("size", ""), b.get("location", ""))

    def tgt_key(b):
        sku = changes.get("sku", b.get("sku") or b.get("style") or "")
        color = changes.get("color", b.get("color", ""))
        size = changes.get("size", b.get("size", ""))
        return (sku, color, size, b.get("location", ""))

    # Guard allocations on the source lines we would move from.
    blocked, moved_units, moved_boxes = [], 0, 0
    if key_changed:
        checked = set()
        for b in boxes:
            sk = src_key(b)
            if sk == tgt_key(b):
                continue
            moved_units += int(b.get("units") or b.get("qty") or 0)
            moved_boxes += 1
            if sk in checked:
                continue
            checked.add(sk)
            s_sku, s_color, s_size, s_loc = sk
            inv = await db.wms_inventory.find_one(
                {"sku": s_sku, "color": s_color, "size": s_size, "location": s_loc}
            )
            if inv and int(inv.get("units_allocated", 0) or 0) > 0:
                blocked.append({"location": s_loc, "allocated": int(inv["units_allocated"])})

    preview = {
        "upc": code, "changes": changes, "receivings": len(rcv_ids),
        "boxes_total": len(boxes), "moved_boxes": moved_boxes,
        "moved_units": moved_units, "key_changed": key_changed, "blocked": blocked,
    }
    if not apply:
        return {"applied": False, "preview": preview}
    if blocked:
        raise HTTPException(
            409,
            f"No se puede corregir: hay unidades asignadas a ordenes en {len(blocked)} "
            "ubicacion(es). Desasigna esas ordenes primero.",
        )

    # 1) Move units between inventory lines for identity changes (per box).
    if key_changed:
        for b in boxes:
            sk, tk = src_key(b), tgt_key(b)
            if sk == tk:
                continue
            units = int(b.get("units") or b.get("qty") or 0)
            s_sku, s_color, s_size, s_loc = sk
            t_sku, t_color, t_size, t_loc = tk
            src_inv = await db.wms_inventory.find_one(
                {"sku": s_sku, "color": s_color, "size": s_size, "location": s_loc}
            )
            if src_inv:
                noh = max(0, int(src_inv.get("units_on_hand", 0)) - units)
                ntb = max(0, int(src_inv.get("total_boxes", 0) or 0) - 1)
                if noh == 0 and ntb == 0:
                    await db.wms_inventory.delete_one({"_id": src_inv["_id"]})
                else:
                    await db.wms_inventory.update_one(
                        {"_id": src_inv["_id"]},
                        {"$set": {"units_on_hand": noh, "total_boxes": ntb, "updated_at": now_iso()}},
                    )
            tgt_inv = await db.wms_inventory.find_one(
                {"sku": t_sku, "color": t_color, "size": t_size, "location": t_loc}
            )
            if tgt_inv:
                await db.wms_inventory.update_one(
                    {"_id": tgt_inv["_id"]},
                    {"$inc": {"units_on_hand": units, "total_boxes": 1}, "$set": {"updated_at": now_iso()}},
                )
            else:
                await db.wms_inventory.insert_one({
                    "inventory_id": gen_id("inv"),
                    "sku": t_sku, "style": changes.get("style", b.get("style") or t_sku),
                    "color": t_color, "size": t_size,
                    "customer": changes.get("customer", b.get("customer", "")),
                    "manufacturer": changes.get("manufacturer", b.get("manufacturer", "")),
                    "description": changes.get("description", b.get("description", "")),
                    "country_of_origin": changes.get("country_of_origin", b.get("country_of_origin", "") or b.get("coo", "")),
                    "fabric_content": changes.get("fabric_content", b.get("fabric_content", "")),
                    "location": t_loc, "is_bpo": b.get("is_bpo", False),
                    "total_boxes": 1, "units_on_hand": units, "units_allocated": 0,
                    "updated_at": now_iso(),
                })

    # 2) Descriptive-only changes: update the boxes' (post-move) inventory lines.
    meta_inv = {k: v for k, v in changes.items()
                if k in ("description", "country_of_origin", "fabric_content", "customer", "manufacturer")}
    if meta_inv:
        seen = set()
        for b in boxes:
            tk = tgt_key(b)
            if tk in seen:
                continue
            seen.add(tk)
            t_sku, t_color, t_size, t_loc = tk
            await db.wms_inventory.update_many(
                {"sku": t_sku, "color": t_color, "size": t_size, "location": t_loc},
                {"$set": {**meta_inv, "updated_at": now_iso()}},
            )

    # 3) Update the boxes themselves with every changed field.
    box_set = dict(changes)
    if "country_of_origin" in changes:
        box_set["coo"] = changes["country_of_origin"]
    box_set["upc"] = code
    box_set["updated_at"] = now_iso()
    box_ids = [b["box_id"] for b in boxes]
    if box_ids:
        await db.wms_boxes.update_many({"box_id": {"$in": box_ids}}, {"$set": box_set})

    # 4) Update the receiving metadata.
    if rcv_ids:
        rcv_set = {k: v for k, v in changes.items()
                   if k in ("style", "sku", "color", "size", "description",
                            "country_of_origin", "fabric_content", "customer", "manufacturer")}
        if rcv_set:
            rcv_set["updated_at"] = now_iso()
            await db.wms_receiving.update_many({"receiving_id": {"$in": rcv_ids}}, {"$set": rcv_set})

    # 5) Update the catalog + log + notify.
    cat_set = dict(changes)
    cat_set["updated_at"] = now_iso()
    cat_set["updated_by"] = user.get("user_id")
    await db.wms_upc_catalog.update_one({"upc": code}, {"$set": cat_set})
    await log_movement(user, "upc_correction", {
        "upc": code, "changes": changes, "moved_boxes": moved_boxes,
        "moved_units": moved_units, "receivings": rcv_ids[:50],
    })
    try:
        await notify_badge_change("all")
    except Exception:
        pass
    return {"applied": True, "result": preview}


@router.delete("/upc/{upc}")
async def delete_upc(upc: str, request: Request):
    """Admin-only delete. Existing receiving records keep their data — they
    don't reference the catalog by FK, they just inherited values at capture
    time."""
    user = await require_admin(request)
    code = _norm_upc(upc)
    res = await db.wms_upc_catalog.delete_one({"upc": code})
    if res.deleted_count == 0:
        raise HTTPException(404, f"UPC {code} no encontrado")
    await log_movement(user, "upc_deleted", {"upc": code})
    return {"message": f"UPC {code} eliminado"}
