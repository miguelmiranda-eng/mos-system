"""WMS (Warehouse Management System) routes."""
from fastapi import APIRouter, HTTPException, Request, Response, UploadFile, File
from fastapi.responses import StreamingResponse
from deps import db, get_current_user, require_auth, require_admin
from ws_manager import ws_manager
from datetime import datetime, timezone
import uuid, io, json, logging

router = APIRouter(prefix="/api/wms")
logger = logging.getLogger(__name__)

def now_iso():
    return datetime.now(timezone.utc).isoformat()

def gen_id(prefix="wms"):
    return f"{prefix}_{uuid.uuid4().hex[:12]}"

async def log_movement(user, movement_type, details):
    await db.wms_movements.insert_one({
        "movement_id": gen_id("mov"),
        "type": movement_type,
        "details": details,
        "user_id": user.get("user_id"),
        "user_name": user.get("name", user.get("email", "")),
        "created_at": now_iso()
    })

# ==================== LOCATIONS ====================

@router.post("/locations")
async def create_location(request: Request):
    user = await require_auth(request)
    body = await request.json()
    name = body.get("name", "").strip()
    zone = body.get("zone", "").strip()
    loc_type = body.get("type", "rack")
    if not name:
        raise HTTPException(400, "Nombre de ubicacion requerido")
    existing = await db.wms_locations.find_one({"name": name})
    if existing:
        raise HTTPException(400, "Ubicacion ya existe")
    loc = {
        "location_id": gen_id("loc"), "name": name, "zone": zone,
        "type": loc_type, "active": True, "created_at": now_iso()
    }
    await db.wms_locations.insert_one(loc)
    loc.pop("_id", None)
    return loc

@router.get("/locations")
async def list_locations(request: Request):
    await require_auth(request)
    locs = await db.wms_locations.find({}, {"_id": 0}).sort("name", 1).to_list(500)
    return locs

@router.delete("/locations/{location_id}")
async def delete_location(location_id: str, request: Request):
    user = await require_auth(request)
    result = await db.wms_locations.delete_one({"location_id": location_id})
    if result.deleted_count == 0:
        raise HTTPException(404, "Ubicacion no encontrada")
    return {"message": "Ubicacion eliminada"}

# ==================== RECEIVING ====================

@router.post("/receive-purchase")
async def create_receiving(request: Request):
    user = await require_auth(request)
    body = await request.json()
    customer = body.get("customer", "").strip()
    manufacturer = body.get("manufacturer", "").strip()
    style = body.get("style", "").strip()
    color = body.get("color", "").strip()
    size = body.get("size", "").strip()
    description = body.get("description", "").strip()
    country_of_origin = body.get("country_of_origin", "").strip()
    fabric_content = body.get("fabric_content", "").strip()
    inv_location = body.get("inv_location", "").strip()
    lot_number = body.get("lot_number", "").strip()
    sku = body.get("sku", "").strip()
    dozens = int(body.get("dozens", 0) or 0)
    pieces = int(body.get("pieces", 0) or 0)
    units = int(body.get("units", 0) or 0)
    vendor = body.get("vendor", manufacturer).strip()
    items = body.get("items", [])

    if not style:
        raise HTTPException(400, "Style requerido")

    # Auto-generate SKU if not provided
    if not sku and style:
        base = style.upper().replace(' ', '-')
        parts = [base]
        if color: parts.append(color.upper().replace(' ', '-')[:10])
        if size: parts.append(size.upper())
        sku = '-'.join(parts)
        # Check for existing SKU and append sequence if duplicate
        existing = await db.wms_inventory.find_one({"sku": {"$regex": f"^{sku}$", "$options": "i"}})
        if not existing:
            existing_box = await db.wms_boxes.find_one({"sku": {"$regex": f"^{sku}$", "$options": "i"}})
        # SKU is fine as-is (reuse if exists or create new)

    # Calculate total units: if units provided use it, else dozens*12 + pieces
    total_units = units if units > 0 else (dozens * 12 + pieces)
    if total_units <= 0 and not items:
        raise HTTPException(400, "Debe ingresar cantidad (dozens/pieces/units)")

    receiving_id = gen_id("rcv")

    # If legacy items format
    if items and not total_units:
        last_box = await db.wms_boxes.find_one(sort=[("seq_num", -1)])
        seq = (last_box.get("seq_num", 0) if last_box else 0)
        all_boxes = []
        total_units = 0
        for item in items:
            item_size = item.get("size", "").strip()
            boxes_count = int(item.get("boxes", 1))
            units_per_box = int(item.get("units_per_box", 1))
            item_total = boxes_count * units_per_box
            total_units += item_total
            for i in range(boxes_count):
                seq += 1
                box_id = f"BOX-{seq:06d}"
                box = {
                    "box_id": box_id, "barcode": box_id,
                    "receiving_id": receiving_id,
                    "vendor": vendor, "customer": customer,
                    "manufacturer": manufacturer, "style": style,
                    "sku": sku or style, "color": color, "size": item_size,
                    "description": description,
                    "units": units_per_box, "seq_num": seq,
                    "location": inv_location or None,
                    "status": "received" if not inv_location else "stored",
                    "state": "raw", "created_at": now_iso()
                }
                all_boxes.append(box)
        if all_boxes:
            await db.wms_boxes.insert_many([{k: v for k, v in b.items()} for b in all_boxes])
        box_ids = [b["box_id"] for b in all_boxes]
    else:
        # New format: single entry with dozens/pieces/units
        last_box = await db.wms_boxes.find_one(sort=[("seq_num", -1)])
        seq = (last_box.get("seq_num", 0) if last_box else 0)
        seq += 1
        box_id = f"BOX-{seq:06d}"
        box = {
            "box_id": box_id, "barcode": box_id,
            "receiving_id": receiving_id,
            "vendor": vendor, "customer": customer,
            "manufacturer": manufacturer, "style": style,
            "sku": sku or style, "color": color, "size": size,
            "description": description,
            "units": total_units, "seq_num": seq,
            "location": inv_location or None,
            "status": "received" if not inv_location else "stored",
            "state": "raw", "created_at": now_iso()
        }
        await db.wms_boxes.insert_one(box)
        box_ids = [box_id]

    receiving_doc = {
        "receiving_id": receiving_id,
        "customer": customer, "manufacturer": manufacturer,
        "style": style, "color": color, "size": size,
        "description": description,
        "country_of_origin": country_of_origin,
        "fabric_content": fabric_content,
        "inv_location": inv_location, "vendor": vendor,
        "lot_number": lot_number, "sku": sku,
        "dozens": dozens, "pieces": pieces,
        "total_units": total_units,
        "box_ids": box_ids,
        "received_by": user.get("user_id"),
        "received_by_name": user.get("name", ""),
        "created_at": now_iso()
    }
    await db.wms_receiving.insert_one(receiving_doc)
    receiving_doc.pop("_id", None)
    await log_movement(user, "receiving", {"receiving_id": receiving_id, "total_units": total_units})
    if size:
        await _update_inventory(style, color, size, total_units, "add")
    elif items:
        for item in items:
            item_size = item.get("size", "").strip()
            item_qty = int(item.get("boxes", 1)) * int(item.get("units_per_box", 1))
            await _update_inventory(style, color, item_size, item_qty, "add")
    if inv_location:
        existing_loc = await db.wms_locations.find_one({"name": inv_location})
        if not existing_loc:
            zone = inv_location.split('-')[0] if '-' in inv_location else "DEFAULT"
            await db.wms_locations.insert_one({"location_id": gen_id("loc"), "name": inv_location, "zone": zone, "type": "rack", "active": True, "created_at": now_iso()})
    receiving_doc["total_units"] = total_units
    return receiving_doc

@router.get("/receiving")
async def list_receiving(request: Request):
    await require_auth(request)
    docs = await db.wms_receiving.find({}, {"_id": 0}).sort("created_at", -1).to_list(500)
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

# ==================== BOXES ====================

@router.get("/stocktakes")
async def list_boxes(request: Request, sku: str = "", color: str = "", size: str = "",
                     location: str = "", status: str = "", state: str = "", po: str = ""):
    await require_auth(request)
    query = {}
    if sku: query["sku"] = {"$regex": sku, "$options": "i"}
    if color: query["color"] = {"$regex": color, "$options": "i"}
    if size: query["size"] = {"$regex": size, "$options": "i"}
    if location: query["location"] = location
    if status: query["status"] = status
    if state: query["state"] = state
    if po: query["po"] = {"$regex": po, "$options": "i"}
    boxes = await db.wms_boxes.find(query, {"_id": 0}).sort("created_at", -1).to_list(1000)
    return boxes

@router.get("/stocktakes/{box_id}")
async def get_box(box_id: str, request: Request):
    await require_auth(request)
    box = await db.wms_boxes.find_one({"box_id": box_id}, {"_id": 0})
    if not box:
        raise HTTPException(404, "Caja no encontrada")
    return box

# ==================== PUTAWAY ====================

@router.post("/putaway")
async def putaway_box(request: Request):
    user = await require_auth(request)
    body = await request.json()
    box_id = body.get("box_id", "").strip()
    location = body.get("location", "").strip()
    if not box_id or not location:
        raise HTTPException(400, "box_id y location requeridos")
    box = await db.wms_boxes.find_one({"box_id": box_id})
    if not box:
        raise HTTPException(404, "Caja no encontrada")
    loc = await db.wms_locations.find_one({"name": location})
    if not loc:
        raise HTTPException(404, "Ubicacion no encontrada")
    old_location = box.get("location")
    await db.wms_boxes.update_one({"box_id": box_id}, {"$set": {"location": location, "status": "stored"}})
    await log_movement(user, "putaway", {"box_id": box_id, "from": old_location, "to": location, "sku": box.get("sku"), "units": box.get("units")})
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
            await db.wms_boxes.update_one({"box_id": box_id}, {"$set": {"location": location, "status": "stored"}})
            results.append({"box_id": box_id, "location": location})
    await log_movement(user, "putaway_bulk", {"count": len(results)})
    return {"message": f"{len(results)} cajas ubicadas", "results": results}

# ==================== INVENTORY ====================

async def _update_inventory(sku, color, size, qty, operation="add"):
    key = {"$or": [{"sku": sku}, {"style": sku}], "color": color or "", "size": size or ""}
    inv = await db.wms_inventory.find_one(key)
    if not inv:
        if operation == "add":
            await db.wms_inventory.insert_one({
                "sku": sku, "style": sku, "color": color or "", "size": size or "",
                "inventory_id": gen_id("inv"),
                "on_hand": qty, "allocated": 0, "available": qty,
                "updated_at": now_iso()
            })
    else:
        doc_key = {"_id": inv["_id"]}
        if operation == "add":
            await db.wms_inventory.update_one(doc_key, {"$inc": {"on_hand": qty, "available": qty}, "$set": {"updated_at": now_iso()}})
        elif operation == "allocate":
            await db.wms_inventory.update_one(doc_key, {"$inc": {"allocated": qty, "available": -qty}, "$set": {"updated_at": now_iso()}})
        elif operation == "deallocate":
            await db.wms_inventory.update_one(doc_key, {"$inc": {"allocated": -qty, "available": qty}, "$set": {"updated_at": now_iso()}})
        elif operation == "deduct":
            await db.wms_inventory.update_one(doc_key, {"$inc": {"on_hand": -qty, "allocated": -qty}, "$set": {"updated_at": now_iso()}})
        elif operation == "deduct_raw":
            await db.wms_inventory.update_one(doc_key, {"$inc": {"on_hand": -qty, "available": -qty}, "$set": {"updated_at": now_iso()}})

@router.get("/inventory")
async def get_inventory(request: Request, sku: str = "", color: str = "", size: str = "", location: str = "", customer: str = "", category: str = "", style: str = ""):
    await require_auth(request)
    query = {}
    if sku: query["sku"] = {"$regex": sku, "$options": "i"}
    if style: query["style"] = {"$regex": style, "$options": "i"}
    if color: query["color"] = {"$regex": color, "$options": "i"}
    if size: query["size"] = {"$regex": size, "$options": "i"}
    if customer: query["customer"] = {"$regex": customer, "$options": "i"}
    if category: query["category"] = {"$regex": category, "$options": "i"}
    if location: query["inv_location"] = {"$regex": location, "$options": "i"}
    inventory = await db.wms_inventory.find(query, {"_id": 0}).sort("sku", 1).to_list(5000)
    return inventory

@router.put("/inventory/{inventory_id}")
async def inventory_filters(request: Request):
    """Return unique filter values for inventory dropdowns."""
    await require_auth(request)
    customers = await db.wms_inventory.distinct("customer")
    categories = await db.wms_inventory.distinct("category")
    manufacturers = await db.wms_inventory.distinct("manufacturer")
    styles = await db.wms_inventory.distinct("style")
    return {
        "customers": sorted([c for c in customers if c]),
        "categories": sorted([c for c in categories if c]),
        "manufacturers": sorted([m for m in manufacturers if m]),
        "styles": sorted([s for s in styles if s])
    }

@router.get("/inventory/locations-lookup")
async def locations_lookup(request: Request, style: str = "", color: str = ""):
    """Lookup inventory locations for a style+color, grouped by size."""
    await require_auth(request)
    if not style:
        raise HTTPException(400, "Style requerido")
    query = {"$or": [{"style": {"$regex": f"^{style}$", "$options": "i"}}, {"sku": {"$regex": f"^{style}$", "$options": "i"}}]}
    if color:
        query["color"] = {"$regex": f"^{color}$", "$options": "i"}
    records = await db.wms_inventory.find(query, {"_id": 0}).to_list(5000)
    # Group by size, aggregate locations
    by_size = {}
    for r in records:
        sz = r.get("size", "")
        if sz not in by_size:
            by_size[sz] = {"size": sz, "locations": [], "total_available": 0, "total_boxes": 0}
        loc = r.get("inv_location", "")
        avail = r.get("available", r.get("on_hand", 0))
        boxes = r.get("total_boxes", 0)
        if loc and avail > 0:
            by_size[sz]["locations"].append({"location": loc, "available": avail, "boxes": boxes, "customer": r.get("customer", "")})
        by_size[sz]["total_available"] += avail
        by_size[sz]["total_boxes"] += boxes
    # Sort locations within each size by available desc
    for sz in by_size:
        by_size[sz]["locations"].sort(key=lambda x: -x["available"])
    return {"style": style, "color": color, "sizes": by_size}

@router.get("/inventory/options")
async def inventory_options(request: Request, customer: str = "", manufacturer: str = "", style: str = ""):
    """Return unique dropdown values from inventory, case-insensitive dedup, filtered by customer and cascading."""
    await require_auth(request)
    base = {}
    if customer:
        base["customer"] = {"$regex": f"^{customer}$", "$options": "i"}

    # Manufacturers: filter by customer only
    mfr_match = {k: v for k, v in base.items()}
    mfr_pipeline = [
        {"$match": mfr_match},
        {"$group": {"_id": {"$toLower": "$manufacturer"}, "val": {"$first": "$manufacturer"}}},
        {"$match": {"_id": {"$ne": ""}}},
        {"$sort": {"_id": 1}}
    ]

    # Styles: filter by customer + manufacturer (if given)
    style_match = {k: v for k, v in base.items()}
    if manufacturer:
        style_match["manufacturer"] = {"$regex": f"^{manufacturer}$", "$options": "i"}
    style_pipeline = [
        {"$match": style_match},
        {"$group": {"_id": {"$toLower": "$style"}, "val": {"$first": "$style"}}},
        {"$match": {"_id": {"$ne": ""}}},
        {"$sort": {"_id": 1}}
    ]

    # Colors: filter by customer + style (if given)
    color_match = {k: v for k, v in base.items()}
    if style:
        color_match["$or"] = [
            {"style": {"$regex": f"^{style}$", "$options": "i"}},
            {"sku": {"$regex": f"^{style}$", "$options": "i"}}
        ]
    color_pipeline = [
        {"$match": color_match},
        {"$group": {"_id": {"$toLower": "$color"}, "val": {"$first": "$color"}}},
        {"$match": {"_id": {"$ne": ""}}},
        {"$sort": {"_id": 1}}
    ]

    mfrs = await db.wms_inventory.aggregate(mfr_pipeline).to_list(500)
    styles = await db.wms_inventory.aggregate(style_pipeline).to_list(500)
    colors = await db.wms_inventory.aggregate(color_pipeline).to_list(500)

    # Customers list (always unfiltered)
    cust_pipeline = [
        {"$group": {"_id": {"$toLower": "$customer"}, "val": {"$first": "$customer"}}},
        {"$match": {"_id": {"$ne": ""}}},
        {"$sort": {"_id": 1}}
    ]
    custs = await db.wms_inventory.aggregate(cust_pipeline).to_list(500)

    return {
        "customers": [c["val"] for c in custs],
        "manufacturers": [m["val"] for m in mfrs],
        "styles": [s["val"] for s in styles],
        "colors": [c["val"] for c in colors]
    }

@router.get("/movements/summary")
async def inventory_summary(request: Request):
    await require_auth(request)
    pipeline = [
        {"$group": {
            "_id": None,
            "total_on_hand": {"$sum": "$on_hand"},
            "total_allocated": {"$sum": "$allocated"},
            "total_available": {"$sum": "$available"},
            "total_skus": {"$sum": 1},
            "total_boxes_sum": {"$sum": "$total_boxes"}
        }}
    ]
    result = await db.wms_inventory.aggregate(pipeline).to_list(1)
    agg = result[0] if result else {}
    total_locations = await db.wms_locations.count_documents({"active": True})
    low_stock = await db.wms_inventory.find(
        {"available": {"$lte": 10}, "on_hand": {"$gt": 0}}, {"_id": 0}
    ).sort("available", 1).to_list(20)
    return {
        "total_on_hand": agg.get("total_on_hand", 0),
        "total_allocated": agg.get("total_allocated", 0),
        "total_available": agg.get("total_available", 0),
        "total_skus": agg.get("total_skus", 0),
        "total_boxes": agg.get("total_boxes_sum", 0),
        "total_locations": total_locations,
        "low_stock_items": len(low_stock),
        "low_stock": low_stock
    }

# ==================== ORDERS (from CRM) ====================

@router.get("/orders")
async def list_wms_orders(request: Request, status: str = ""):
    await require_auth(request)
    # Only show orders from BLANKS board OR with partial blank_status
    query = {"$or": [
        {"board": {"$regex": "^blanks$", "$options": "i"}},
        {"blank_status": {"$regex": "partial|parcial", "$options": "i"}}
    ]}
    if status:
        query["wms_status"] = status
    orders = await db.orders.find(query, {"_id": 0}).sort("created_at", -1).to_list(500)
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
        "created_at": now_iso()
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

@router.post("/move-stock")
async def create_pick_ticket(request: Request):
    user = await require_auth(request)
    body = await request.json()

    # Support direct pick ticket creation (new flow) or allocation-based
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
            "created_at": now_iso()
        }
    else:
        # Direct pick ticket creation (new flow matching physical label)
        order_number = body.get("order_number", "").strip()
        customer = body.get("customer", "").strip()
        client = body.get("client", "").strip()
        manufacturer = body.get("manufacturer", "").strip()
        style = body.get("style", "").strip()
        color = body.get("color", "").strip()
        quantity = int(body.get("quantity", 0))
        sizes = body.get("sizes", {})  # { "XS": 0, "S": 216, "M": 0, ... }

        if not order_number or not style:
            raise HTTPException(400, "Numero de orden y style requeridos")

        ticket_id = gen_id("pick")
        total_qty = sum(int(v) for v in sizes.values() if v)

        # Auto-lookup locations for each size from inventory
        size_locations = {}
        for sz, qty in sizes.items():
            qty = int(qty) if qty else 0
            if qty > 0:
                inv_query = {
                    "$or": [{"style": {"$regex": f"^{style}$", "$options": "i"}}, {"sku": {"$regex": f"^{style}$", "$options": "i"}}],
                    "size": {"$regex": f"^{sz}$", "$options": "i"},
                    "available": {"$gt": 0}
                }
                if color:
                    inv_query["color"] = {"$regex": f"^{color}$", "$options": "i"}
                inv_records = await db.wms_inventory.find(inv_query, {"_id": 0, "inv_location": 1, "available": 1, "total_boxes": 1, "customer": 1}).sort("available", -1).to_list(50)
                locs = [{"location": r.get("inv_location", ""), "available": r.get("available", 0), "boxes": r.get("total_boxes", 0)} for r in inv_records if r.get("inv_location")]
                size_locations[sz] = locs

        # Operator assignment (optional)
        assigned_to = body.get("assigned_to", "").strip()
        assigned_to_name = body.get("assigned_to_name", "").strip()

        ticket_doc = {
            "ticket_id": ticket_id,
            "order_number": order_number,
            "customer": customer,
            "client": client,
            "manufacturer": manufacturer,
            "style": style,
            "color": color,
            "quantity": quantity,
            "sizes": sizes,
            "size_locations": size_locations,
            "total_pick_qty": total_qty,
            "status": "pending",
            "picking_status": "assigned" if assigned_to else "unassigned",
            "assigned_to": assigned_to or None,
            "assigned_to_name": assigned_to_name or None,
            "assigned_at": now_iso() if assigned_to else None,
            "picked_sizes": {},
            "created_by": user.get("user_id"),
            "created_by_name": user.get("name", ""),
            "created_at": now_iso()
        }

    await db.wms_pick_tickets.insert_one(ticket_doc)
    ticket_doc.pop("_id", None)
    await log_movement(user, "pick_ticket_created", {"ticket_id": ticket_id, "order_number": ticket_doc.get("order_number", "")})
    # Notify operator in real-time if assigned
    if assigned_to:
        await ws_manager.broadcast("ticket_assigned", {
            "ticket_id": ticket_id,
            "assigned_to": assigned_to,
            "assigned_to_name": assigned_to_name,
            "order_number": order_number,
            "message": f"Nuevo pick ticket: {ticket_id} (PO: {order_number})"
        })
    return ticket_doc

@router.get("/inventory/field-options")
async def get_inventory_field_options(request: Request):
    """Get unique values for description, country_of_origin, fabric_content from inventory."""
    await require_auth(request)
    desc_pipeline = [
        {"$match": {"description": {"$ne": None, "$nin": ["", "."]}}},
        {"$group": {"_id": {"$toLower": "$description"}, "val": {"$first": "$description"}}},
        {"$sort": {"_id": 1}}
    ]
    country_pipeline = [
        {"$match": {"country_of_origin": {"$ne": None, "$nin": ["", "."]}}},
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
    fabrics = await db.wms_inventory.aggregate(fabric_pipeline).to_list(500)
    return {
        "descriptions": [d["val"] for d in descs],
        "countries": [c["val"] for c in countries],
        "fabrics": [f["val"] for f in fabrics]
    }

@router.get("/pick-tickets")
async def list_pick_tickets(request: Request, status: str = ""):
    await require_auth(request)
    query = {}
    if status: query["status"] = status
    tickets = await db.wms_pick_tickets.find(query, {"_id": 0}).sort("created_at", -1).to_list(500)
    return tickets

# ==================== OPERATOR MODULE ====================

@router.get("/operators")
async def list_operators(request: Request):
    """List all users with role 'operator' or 'picker'."""
    await require_auth(request)
    operators = await db.users.find({"role": {"$in": ["operator", "picker"]}}, {"_id": 0, "password_hash": 0}).to_list(200)
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

    picking_status = "completed" if is_complete else "in_progress"
    update = {
        "picked_sizes": picked_sizes,
        "picking_status": picking_status,
        "last_picked_by": user.get("user_id"),
        "last_picked_by_name": user.get("name", user.get("email", "")),
        "last_picked_at": now_iso()
    }
    if is_complete:
        update["completed_at"] = now_iso()
        update["status"] = "confirmed"

    await db.wms_pick_tickets.update_one({"ticket_id": ticket_id}, {"$set": update})
    await log_movement(user, "pick_progress", {
        "ticket_id": ticket_id,
        "picking_status": picking_status,
        "picked_sizes": picked_sizes
    })
    return {"message": f"Progreso guardado ({picking_status})", "ticket_id": ticket_id, "picking_status": picking_status}

@router.post("/stocktakes/{stocktake_id}/finalize")
async def confirm_pick(ticket_id: str, request: Request):
    user = await require_auth(request)
    body = await request.json()
    confirmed_lines = body.get("lines", [])
    ticket = await db.wms_pick_tickets.find_one({"ticket_id": ticket_id})
    if not ticket:
        raise HTTPException(404, "Pick ticket no encontrado")
    for line in confirmed_lines:
        box_id = line.get("box_id")
        qty = int(line.get("qty", 0))
        box = await db.wms_boxes.find_one({"box_id": box_id})
        if box:
            new_units = max(0, box.get("units", 0) - qty)
            update = {"units": new_units}
            if new_units == 0:
                update["status"] = "picked"
            await db.wms_boxes.update_one({"box_id": box_id}, {"$set": update})
            await _update_inventory(box["sku"], box.get("color", ""), box.get("size", ""), qty, "deduct")
    await db.wms_pick_tickets.update_one({"ticket_id": ticket_id}, {"$set": {"status": "confirmed", "confirmed_at": now_iso(), "confirmed_by": user.get("user_id")}})
    await db.orders.update_one({"order_id": ticket.get("order_id")}, {"$set": {"wms_status": "picked"}})
    await log_movement(user, "pick_confirmed", {"ticket_id": ticket_id, "lines": len(confirmed_lines)})
    return {"message": "Pick confirmado", "ticket_id": ticket_id}

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
    for field in ["order_number", "customer", "client", "manufacturer", "style", "color", "quantity"]:
        if field in body:
            update[field] = body[field]
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

    # Re-lookup locations if style/color changed
    new_style = update.get("style", ticket.get("style", ""))
    new_color = update.get("color", ticket.get("color", ""))
    if "style" in update or "color" in update:
        size_locations = {}
        new_sizes = update.get("sizes", ticket.get("sizes", {}))
        for sz, qty in new_sizes.items():
            if int(qty) <= 0: continue
            inv_items = await db.wms_inventory.find(
                {"style": {"$regex": f"^{new_style}$", "$options": "i"}, "color": {"$regex": f"^{new_color}$", "$options": "i"}, "size": sz},
                {"_id": 0, "inv_location": 1, "available": 1}
            ).to_list(50)
            locs = [{"location": it["inv_location"], "available": it.get("available", 0)} for it in inv_items if it.get("inv_location")]
            size_locations[sz] = {"locations": locs, "total_available": sum(l["available"] for l in locs)}
        update["size_locations"] = size_locations

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
        old_state = box.get("state", "raw")
        await db.wms_boxes.update_one({"box_id": box_id}, {"$set": {"state": target_state, "status": "in_production" if target_state == "wip" else ("finished" if target_state == "finished" else box.get("status"))}})
        moved.append({"box_id": box_id, "from": old_state, "to": target_state})
    move_doc = {
        "move_id": gen_id("pmov"), "box_ids": box_ids,
        "target_state": target_state, "moved": moved,
        "moved_by": user.get("user_id"),
        "moved_by_name": user.get("name", ""),
        "created_at": now_iso()
    }
    await db.wms_production_moves.insert_one(move_doc)
    move_doc.pop("_id", None)
    await log_movement(user, "production_move", {"target_state": target_state, "count": len(moved)})
    return move_doc

@router.get("/production")
async def list_production(request: Request, state: str = ""):
    await require_auth(request)
    query = {}
    if state: query["state"] = state
    else: query["state"] = {"$in": ["wip", "finished"]}
    boxes = await db.wms_boxes.find(query, {"_id": 0}).sort("created_at", -1).to_list(1000)
    return boxes

# ==================== FINISHED GOODS ====================

@router.get("/finished-goods")
async def list_finished_goods(request: Request):
    await require_auth(request)
    boxes = await db.wms_boxes.find({"state": "finished"}, {"_id": 0}).sort("created_at", -1).to_list(1000)
    return boxes

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
        "created_at": now_iso()
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
async def export_inventory(request: Request):
    await require_auth(request)
    inventory = await db.wms_inventory.find({}, {"_id": 0}).sort("sku", 1).to_list(20000)
    import xlsxwriter
    buf = io.BytesIO()
    wb = xlsxwriter.Workbook(buf)
    ws = wb.add_worksheet("Inventory")
    headers = ["Customer", "Style", "Color", "Size", "Description", "Category",
               "Manufacturer", "Location", "Total Boxes", "On Hand", "Allocated", "Available",
               "Country of Origin", "Fabric Content"]
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
        ws.write(row, 7, inv.get("inv_location", ""))
        ws.write(row, 8, inv.get("total_boxes", 0))
        ws.write(row, 9, inv.get("on_hand", 0))
        ws.write(row, 10, inv.get("allocated", 0))
        ws.write(row, 11, inv.get("available", 0))
        ws.write(row, 12, inv.get("country_of_origin", ""))
        ws.write(row, 13, inv.get("fabric_content", ""))
    wb.close()
    buf.seek(0)
    return StreamingResponse(buf, media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                             headers={"Content-Disposition": "attachment; filename=inventory.xlsx"})

# ==================== IMPORT INVENTORY ====================

@router.post("/import/inventory")
async def import_inventory(request: Request, file: UploadFile = File(...)):
    user = await require_auth(request)
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
    inventory_docs = []
    locations_set = set()
    skipped = 0

    for row in rows[1:]:
        style = get(row, 'Style', '')
        if not style:
            skipped += 1
            continue

        color = get(row, 'Color', '')
        size = get(row, 'Size', '')
        inv_loc = get(row, 'InvLocation', '')
        total_boxes = int(float(get(row, 'Total Boxes', 0) or 0))
        total_units = int(float(get(row, 'TotalUnits', 0) or 0))

        if inv_loc:
            locations_set.add(inv_loc)

        inventory_docs.append({
            "inventory_id": f"inv_{uuid.uuid4().hex[:12]}",
            "customer": get(row, 'CustomerID', ''),
            "style": style,
            "sku": style,
            "color": color,
            "size": size,
            "size_header": get(row, 'SizeHeader', ''),
            "manufacturer": get(row, 'Manufacturer', ''),
            "description": get(row, 'Description', ''),
            "category": get(row, 'Category', ''),
            "country_of_origin": get(row, 'CountryofOrigin', ''),
            "fabric_content": get(row, 'FabricContent', ''),
            "import_number": get(row, 'ImportNumber', ''),
            "po": get(row, 'PO', ''),
            "bpo": get(row, 'BPO', ''),
            "inv_location": inv_loc,
            "total_boxes": total_boxes,
            "on_hand": total_units,
            "allocated": 0,
            "available": total_units,
            "updated_at": now
        })

    # Clear existing imported inventory and bulk insert
    await db.wms_inventory.delete_many({})
    if inventory_docs:
        batch_size = 1000
        for i in range(0, len(inventory_docs), batch_size):
            await db.wms_inventory.insert_many(inventory_docs[i:i+batch_size])

    # Auto-create locations
    locations_created = 0
    for loc_name in locations_set:
        existing = await db.wms_locations.find_one({"name": loc_name})
        if not existing:
            zone = loc_name.split('-')[0] if '-' in loc_name else "DEFAULT"
            await db.wms_locations.insert_one({
                "location_id": f"loc_{uuid.uuid4().hex[:12]}",
                "name": loc_name,
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

    if not name:
        raise HTTPException(400, "Nombre del conteo requerido")

    # Build query to get inventory items for this count
    query = {}
    if location_filter:
        query["inv_location"] = {"$regex": location_filter, "$options": "i"}
    if customer_filter:
        query["customer"] = {"$regex": f"^{customer_filter}$", "$options": "i"}
    if style_filter:
        query["style"] = {"$regex": f"^{style_filter}$", "$options": "i"}

    # Get inventory items matching filters
    items = await db.wms_inventory.find(query, {"_id": 0}).to_list(2000)
    if not items:
        raise HTTPException(400, "No se encontraron items con los filtros proporcionados")

    # Build count lines
    count_lines = []
    for item in items:
        count_lines.append({
            "line_id": gen_id("cl"),
            "style": item.get("style", ""),
            "color": item.get("color", ""),
            "size": item.get("size", ""),
            "inv_location": item.get("inv_location", ""),
            "sku": item.get("sku", ""),
            "system_qty": item.get("on_hand", 0),
            "counted_qty": None,
            "discrepancy": None,
            "counted": False
        })

    count_id = gen_id("cc")
    count_doc = {
        "count_id": count_id,
        "name": name,
        "status": "pending",
        "location_filter": location_filter,
        "customer_filter": customer_filter,
        "style_filter": style_filter,
        "assigned_to": assigned_to or None,
        "assigned_to_name": assigned_to_name or None,
        "total_lines": len(count_lines),
        "counted_lines": 0,
        "lines": count_lines,
        "created_by": user.get("user_id"),
        "created_by_name": user.get("name", ""),
        "created_at": now_iso()
    }
    await db.wms_cycle_counts.insert_one(count_doc)
    count_doc.pop("_id", None)
    await log_movement(user, "cycle_count_created", {"count_id": count_id, "total_lines": len(count_lines)})

    if assigned_to:
        await ws_manager.broadcast("cycle_count_assigned", {
            "count_id": count_id,
            "assigned_to": assigned_to,
            "assigned_to_name": assigned_to_name,
            "name": name
        })

    return count_doc

@router.get("/cycle-counts")
async def list_cycle_counts(request: Request):
    """List all cycle counts."""
    await require_auth(request)
    counts = await db.wms_cycle_counts.find({}, {"_id": 0, "lines": 0}).sort("created_at", -1).to_list(200)
    return counts

@router.get("/cycle-counts/{count_id}")
async def get_cycle_count(count_id: str, request: Request):
    """Get a cycle count with all lines."""
    await require_auth(request)
    count = await db.wms_cycle_counts.find_one({"count_id": count_id}, {"_id": 0})
    if not count:
        raise HTTPException(404, "Conteo no encontrado")
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
    for line in lines:
        lid = line["line_id"]
        if lid in counted_items:
            qty = int(counted_items[lid])
            line["counted_qty"] = qty
            line["discrepancy"] = qty - (line.get("system_qty", 0) or 0)
            line["counted"] = True
            line["counted_by"] = user.get("user_id")
            line["counted_at"] = now_iso()
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
    await log_movement(user, "cycle_count_progress", {"count_id": count_id, "counted": counted_count, "total": len(lines)})
    return {"message": f"Progreso guardado ({counted_count}/{len(lines)})", "status": status}

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
    for line in count.get("lines", []):
        if line.get("discrepancy") and line["discrepancy"] != 0:
            # Adjust inventory
            await db.wms_inventory.update_one(
                {"style": line["style"], "color": line["color"], "size": line["size"], "inv_location": line["inv_location"]},
                {"$set": {"on_hand": line["counted_qty"], "available": line["counted_qty"] - (line.get("allocated", 0) or 0)}}
            )
            adjustments += 1

    await db.wms_cycle_counts.update_one({"count_id": count_id}, {"$set": {
        "status": "approved",
        "approved_by": user.get("user_id"),
        "approved_by_name": user.get("name", ""),
        "approved_at": now_iso(),
        "adjustments": adjustments
    }})
    await log_movement(user, "cycle_count_approved", {"count_id": count_id, "adjustments": adjustments})
    return {"message": f"Conteo aprobado. {adjustments} ajustes aplicados al inventario.", "adjustments": adjustments}
