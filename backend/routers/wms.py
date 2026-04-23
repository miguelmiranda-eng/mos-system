"""WMS (Warehouse Management System) routes."""
from fastapi import APIRouter, HTTPException, Request, Response, UploadFile, File
from fastapi.responses import StreamingResponse
from deps import db, get_current_user, require_auth, require_admin, DEFAULT_OPTIONS
from ws_manager import ws_manager
from datetime import datetime, timezone, timedelta
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
        "created_at": now_iso(),
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
        "type": loc_type, "active": True, "created_at": now_iso(),
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

@router.post("/receiving")
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
    inv_location = body.get("inv_location", "").strip() or "Locación Temporal"
    lot_number = body.get("lot_number", "").strip()
    sku = body.get("sku", "").strip()
    dozens = int(body.get("dozens", 0) or 0)
    pieces = int(body.get("pieces", 0) or 0)
    units = int(body.get("units", 0) or 0)
    vendor = body.get("vendor", manufacturer).strip()
    items = body.get("items", [])
    is_bpo = body.get("is_bpo", False)

    if not style:
        raise HTTPException(400, "Style requerido")

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

    # Box generation
    last_box = await db.wms_boxes.find_one(sort=[("seq_num", -1)])
    seq = (last_box.get("seq_num", 0) if last_box else 0)
    
    box_docs = []
    if items:
        for item in items:
            item_size = item.get("size", "").strip()
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
                    "lpn_id": box_id, "coo": country_of_origin, "lot_number": lot_number,
                    "asn_reference": body.get("asn_reference", "").strip(),
                    "created_at": now_iso(),
                })
    else:
        seq += 1
        box_id = f"BOX-{seq:06d}"
        box_docs.append({
            "box_id": box_id, "barcode": box_id, "receiving_id": receiving_id,
            "customer": customer, "manufacturer": manufacturer, "style": style,
            "sku": sku or style, "color": color, "size": size,
            "units": total_units, "seq_num": seq, "location": inv_location,
            "status": "putaway_pending", "state": "raw", "is_bpo": is_bpo,
            "lpn_id": box_id, "coo": country_of_origin, "lot_number": lot_number,
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
        "received_by": user.get("user_id"), "received_by_name": user.get("name", ""),
        "created_at": now_iso(),
    }
    await db.wms_receiving.insert_one(receiving_doc)
    await log_movement(user, "receiving", {"receiving_id": receiving_id, "total_units": total_units, "is_bpo": is_bpo})
    
    # Update inventory
    if items:
        for item in items:
            await _update_inventory_enhanced(style, color, item.get("size"), int(item.get("boxes", 1)) * int(item.get("units_per_box", 1)), "add", customer, inv_location, is_bpo)
    else:
        await _update_inventory_enhanced(style, color, size, total_units, "add", customer, inv_location, is_bpo)

    # Ensure location exists
    existing_loc = await db.wms_locations.find_one({"name": inv_location})
    if not existing_loc:
        await db.wms_locations.insert_one({
            "location_id": gen_id("loc"), "name": inv_location, 
            "zone": inv_location.split('-')[0] if '-' in inv_location else "RECEIVING",
            "type": "rack", "active": True, "created_at": now_iso(),
        })

    receiving_doc.pop("_id", None)
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

async def _update_inventory_enhanced(sku, color, size, qty, operation, customer="", location="", is_bpo=False):
    key = {"sku": sku, "color": color or "", "size": size or "", "location": location or ""}
    inv = await db.wms_inventory.find_one(key)
    if not inv and operation == "add":
        await db.wms_inventory.insert_one({
            "sku": sku, "style": sku, "color": color or "", "size": size or "",
            "inventory_id": gen_id("inv"), "customer": customer,
            "location": location, "is_bpo": is_bpo,
            "units_on_hand": qty, "units_allocated": 0, "total_boxes": 1,
            "updated_at": now_iso()
        })
    elif inv:
        doc_key = {"_id": inv["_id"]}
        if operation == "add":
            await db.wms_inventory.update_one(doc_key, {"$inc": {"units_on_hand": qty, "total_boxes": 1}, "$set": {"updated_at": now_iso(), "is_bpo": is_bpo}})
        elif operation == "allocate":
            await db.wms_inventory.update_one(doc_key, {"$inc": {"units_allocated": qty}, "$set": {"updated_at": now_iso()}})
        elif operation == "deallocate":
            await db.wms_inventory.update_one(doc_key, {"$inc": {"units_allocated": -qty}, "$set": {"updated_at": now_iso()}})
        elif operation == "deduct":
            await db.wms_inventory.update_one(doc_key, {"$inc": {"units_on_hand": -qty, "units_allocated": -qty}, "$set": {"updated_at": now_iso()}})

            # WMS 2.0 Cycle Count Trigger
            new_hand = inv.get("on_hand", 0) - qty
            if new_hand < 50:
                existing_cc = await db.wms_tasks.find_one({"task_type": "cycle_count", "context.sku": sku, "status": "pending"})
                if not existing_cc:
                    await db.wms_tasks.insert_one({
                        "task_id": gen_id("tsk"), "task_type": "cycle_count", "priority": "HIGH", "status": "pending",
                        "assigned_to": None, "context": {"sku": sku, "suggested_zone": location, "reason": "Threshold breach (<50)"},
                        "created_at": now_iso(),
                    })

async def _update_inventory(sku, color, size, qty, operation="add", location=""):
    # Standard fallback for old calls
    await _update_inventory_enhanced(sku, color, size, qty, operation, location=location)

@router.get("/inventory")
async def get_inventory(request: Request, sku: str = "", color: str = "", size: str = "", location: str = "", customer: str = "", category: str = "", style: str = ""):
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
    
    # Use aggregation to project/alias for frontend compatibility
    pipeline = [
        {"$match": query},
        {"$project": {
            "_id": 0,
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
            "on_hand": "$units_on_hand",
            "allocated": "$units_allocated",
            "available": {"$subtract": ["$units_on_hand", "$units_allocated"]},
            "inv_location": "$location",
            "units_on_hand": 1,
            "units_allocated": 1,
        }},
        {"$sort": {"sku": 1}}
    ]
    inventory = await db.wms_inventory.aggregate(pipeline).to_list(5000)
    return inventory

@router.get("/inventory/filters")
async def inventory_filters_v2(request: Request):
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
        loc = r.get("location", r.get("inv_location", ""))
        avail = r.get("units_on_hand", r.get("available", 0)) - r.get("units_allocated", 0)
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

    mfrs = await db.wms_inventory.aggregate(mfr_pipeline).to_list(5000)
    styles = await db.wms_inventory.aggregate(style_pipeline).to_list(5000)
    colors = await db.wms_inventory.aggregate(color_pipeline).to_list(5000)

    # Customers list: Fetch directly from MOS Orders (client column)
    cust_pipeline = [
        {"$match": {"client": {"$nin": [None, "", " "]}}},
        {"$group": {"_id": {"$toLower": "$client"}, "val": {"$first": "$client"}}},
        {"$sort": {"_id": 1}}
    ]
    custs = await db.orders.aggregate(cust_pipeline).to_list(1000)
    merged_customers = sorted(list(set([c["val"] for c in custs])))

    return {
        "customers": merged_customers,
        "manufacturers": [m["val"] for m in mfrs if m and m.get("val")],
        "styles": [s["val"] for s in styles if s and s.get("val")],
        "colors": [c["val"] for c in colors if c and c.get("val")]
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

async def internal_create_picking_ticket(data: dict, user: dict) -> dict:
    """
    Internal function to create a pick ticket.
    Expected data: order_number, customer, client, manufacturer, style, color, quantity, sizes, board_category, assigned_to...
    """
    ticket_id = gen_id("pick")
    order_number = data.get("order_number", "").strip()
    style = data.get("style", "").strip()
    
    # Validation for manual creation might be stricter than automated skeleton
    if not order_number:
        raise HTTPException(400, "Numero de orden requerido")

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
                    "available": {"$gt": 0}
                }
                if color:
                    inv_query["color"] = {"$regex": f"^{re.escape(color)}$", "$options": "i"}
                inv_records = await db.wms_inventory.find(inv_query, {"_id": 0, "inv_location": 1, "available": 1, "total_boxes": 1, "customer": 1}).sort("available", -1).to_list(50)
                locs = [{"location": r.get("inv_location", ""), "available": r.get("available", 0), "boxes": r.get("total_boxes", 0)} for r in inv_records if r.get("inv_location")]
                size_locations[sz] = locs

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
        "total_pick_qty": total_qty,
        "status": "pending",
        "board_category": data.get("board_category", "UNSET"),
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
        return ticket_doc
    else:
        return await internal_create_picking_ticket(body, user)

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
    query = {"status": status} if status else {}
    
    # Unified aggregation to get tickets + order info in one go
    pipeline = [
        {"$match": query},
        {"$sort": {"created_at": -1}},
        {"$limit": 1000},
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
    
    real_tickets = await db.wms_pick_tickets.aggregate(pipeline).to_list(1000)
    
    # Process job titles and other order info
    for rt in real_tickets:
        oi = rt.pop("order_info", None)
        if oi:
            for k in ["job_title_a", "job_title_b"]:
                rt[k] = oi.get(k)
            # Optionally sync more info if needed
            if not rt.get("customer"): rt["customer"] = oi.get("client") or oi.get("branding")
            
    # --- VIRTUAL TICKETS LOGIC ---
    # Automatically include orders in SCHEDULING or BLANKS that don't have a ticket yet
    if not status or status == "pending":
        existing_order_numbers = {t.get("order_number") for t in real_tickets if t.get("order_number")}
        
        virtual_query = {
            "board": {"$regex": "^scheduling$|^blanks$", "$options": "i"},
            "order_number": {"$nin": list(existing_order_numbers)}
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
                "style": "",
                "color": "",
                "quantity": vo.get("quantity") or 0,
                "total_pick_qty": vo.get("quantity") or 0,
                "status": "pending",
                "blank_status": vo.get("blank_status") or "PENDIENTE",
                "picking_status": "unassigned",
                "board_category": vo.get("board", "UNSET").upper(),
                "job_title_a": vo.get("job_title_a"),
                "job_title_b": vo.get("job_title_b"),
                "created_at": vo.get("created_at") or now_iso(),
                "is_virtual": True
            })

    return real_tickets

@router.post("/pick-tickets/{ticket_id}/incidents")
async def report_incident(ticket_id: str, request: Request):
    user = await require_auth(request)
    body = await request.json()
    incident = {
        "incident_id": gen_id("inc"),
        "ticket_id": ticket_id,
        "sku": body.get("sku"),
        "qty": int(body.get("qty", 1)),
        "reason": body.get("reason", "Dañado"),
        "operator_id": user.get("user_id"),
        "operator_name": user.get("name", user.get("email", "")),
        "timestamp": now_iso()
    }
    await db.wms_incidents.insert_one(incident)
    await log_movement(user, "incident_reported", {"ticket_id": ticket_id, "sku": incident["sku"], "qty": incident["qty"]})
    return {"message": "Incidencia reportada", "incident_id": incident["incident_id"]}

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
        # DISCOUNT INVENTORY logic
        try:
            # picked_sizes format: { "S": { "total": 10, "details": { "LOC1": 5, "LOC2": 5 } } }
            for sz, data in picked_sizes.items():
                if isinstance(data, dict) and "details" in data:
                    for loc, qty in data["details"].items():
                        if qty > 0:
                            # Subtract from wms_inventory
                            await db.wms_inventory.update_one(
                                {
                                    "style": {"$regex": f"^{re.escape(ticket.get('style', '').strip())}$", "$options": "i"},
                                    "size": {"$regex": f"^{re.escape(sz.strip())}$", "$options": "i"},
                                    "color": {"$regex": f"^{re.escape(ticket.get('color', '').strip())}$", "$options": "i"} if ticket.get("color") else {"$exists": True},
                                    "inv_location": loc
                                },
                                {"$inc": {"available": -qty}}
                            )
        except Exception as e:
            print(f"Error discounting inventory: {e}")

    await db.wms_pick_tickets.update_one({"ticket_id": ticket_id}, {"$set": update})
    await log_movement(user, "pick_progress", {
        "ticket_id": ticket_id,
        "picking_status": picking_status,
        "picked_sizes": picked_sizes
    })
    return {"message": f"Progreso guardado ({picking_status})", "ticket_id": ticket_id, "picking_status": picking_status}

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

    # Handle confirmed lines (legacy or explicit)
    if confirmed_lines:
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
                await _update_inventory(box["sku"], box.get("color", ""), box.get("size", ""), qty, "deduct", location=box.get("location", ""))
    else:
        # Newer flow: Use picked_sizes to auto-deduct from available boxes
        picked_sizes = ticket.get("picked_sizes") or ticket.get("sizes") or {}
        style = ticket.get("style", "")
        color = ticket.get("color", "")
        for sz, qty in picked_sizes.items():
            try:
                qty_int = int(qty)
            except (ValueError, TypeError):
                continue
            if qty_int <= 0: continue
            
            # Find boxes for this SKU/Color/Size
            query = {
                "$or": [{"style": style}, {"sku": style}],
                "color": color, "size": sz, "status": "stored", "state": "raw", "units": {"$gt": 0}
            }
            boxes = await db.wms_boxes.find(query).sort("seq_num", 1).to_list(100)
            remaining = qty_int
            for box in boxes:
                if remaining <= 0: break
                take = min(box["units"], remaining)
                new_units = box["units"] - take
                upd = {"units": new_units}
                if new_units == 0: upd["status"] = "picked"
                await db.wms_boxes.update_one({"_id": box["_id"]}, {"$set": upd})
                await _update_inventory(box["sku"], box.get("color", ""), box.get("size", ""), take, "deduct", location=box.get("location", ""))
                remaining -= take

    await db.wms_pick_tickets.update_one({"ticket_id": target_id}, {"$set": {
        "status": "confirmed", 
        "picking_status": "completed", 
        "confirmed_at": now_iso(), 
        "confirmed_by": user.get("user_id")
    }})
    await db.orders.update_one({"order_id": ticket.get("order_id")}, {"$set": {"wms_status": "picked"}})
    await log_movement(user, "pick_confirmed", {
        "ticket_id": target_id, 
        "items_confirmed": len(confirmed_lines) if confirmed_lines else "auto"
    })
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
        "created_at": now_iso(),
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
async def export_inventory(request: Request):
    await require_auth(request)
    inventory = await db.wms_inventory.find({}, {"_id": 0}).sort("sku", 1).to_list(20000)
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
        ws.write(row, 7, inv.get("inv_location", ""))
        ws.write(row, 8, inv.get("total_boxes", 0))
        ws.write(row, 9, inv.get("on_hand", 0))
        ws.write(row, 10, inv.get("allocated", 0))
        ws.write(row, 11, inv.get("available", 0))
        ws.write(row, 12, inv.get("country_of_origin", ""))
        ws.write(row, 13, inv.get("fabric_content", ""))
        ws.write(row, 14, "YES" if inv.get("is_bpo") else "NO")
    wb.close()
    buf.seek(0)
    return StreamingResponse(buf, media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                             headers={"Content-Disposition": "attachment; filename=inventory.xlsx"})


# ==================== ASN (Advanced Shipping Notice) ====================

@router.post("/asn")
async def create_asn(request: Request):
    user = await require_auth(request)
    body = await request.json()
    asn_id = gen_id("asn")
    
    items = body.get("items", [])
    if not items:
        raise HTTPException(400, "El ASN debe contener al menos un item")
        
    normalized_items = []
    for it in items:
        normalized_items.append({
            "sku": str(it.get("sku", "")).strip().upper(),
            "color": str(it.get("color", "")).strip().upper(),
            "size": str(it.get("size", "")).strip().upper(),
            "quantity": int(it.get("quantity", 0))
        })
        
    doc = {
        "asn_id": asn_id,
        "vendor": body.get("vendor", "").strip().upper(),
        "expected_date": body.get("expected_date", ""),
        "items": normalized_items,
        "status": "pending",
        "created_at": now_iso(),
        "created_by": user.get("user_id")
    }
    
    await db.wms_asn.insert_one(doc)
    doc.pop("_id", None)
    return doc

@router.get("/asn")
async def list_asn(request: Request):
    await require_auth(request)
    return await db.wms_asn.find({}, {"_id": 0}).sort("created_at", -1).to_list(100)

@router.post("/asn/import")
async def import_asn(request: Request, file: UploadFile = File(...)):
    user = await require_auth(request)
    import openpyxl
    contents = await file.read()
    wb = openpyxl.load_workbook(io.BytesIO(contents), read_only=True)
    ws = wb.active
    rows = list(ws.iter_rows(values_only=True))
    if len(rows) < 2:
        raise HTTPException(400, "Archivo vacio")
        
    headers = [str(h).strip() for h in rows[0]]
    col_map = {h: i for i, h in enumerate(headers)}
    
    def get(row, name):
        idx = col_map.get(name)
        if idx is None or idx >= len(row): return ""
        return str(row[idx]).strip() if row[idx] is not None else ""

    items = []
    for row in rows[1:]:
        sku = get(row, "SKU").upper() or get(row, "Style").upper()
        if not sku: continue
        items.append({
            "sku": sku,
            "color": get(row, "Color").upper(),
            "size": get(row, "Size").upper(),
            "quantity": int(float(get(row, "Quantity") or 0))
        })
        
    doc = {
        "asn_id": gen_id("asn"),
        "vendor": "EXCEL_IMPORT",
        "expected_date": now_iso(),
        "items": items,
        "status": "pending",
        "created_at": now_iso(),
        "created_by": user.get("user_id")
    }
    await db.wms_asn.insert_one(doc)
    return {"status": "success", "asn_id": doc["asn_id"], "items_count": len(items)}

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

        if inv_loc:
            locations_set.add(inv_loc)

        inventory_id = f"inv_{uuid.uuid4().hex[:12]}"
        inventory_docs.append({
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
            "total_boxes": total_boxes,
            "units_on_hand": total_units,
            "units_allocated": 0,
            "updated_at": now
        })

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
                    "location": inv_loc,
                    "state": "putaway",
                    "customer": get(row, 'CustomerID', '').strip().upper(),
                    "coo": coo,
                    "created_at": now
                })

    # Clear old data (WMS 2.0 Fresh Start)
    await db.wms_inventory.delete_many({})
    await db.wms_boxes.delete_many({})

    await db.wms_inventory.delete_many({})
    if inventory_docs:
        batch_size = 1000
        for i in range(0, len(inventory_docs), batch_size):
            await db.wms_inventory.insert_many(inventory_docs[i:i+batch_size])
    if box_docs:
        batch_size = 1000
        for i in range(0, len(box_docs), batch_size):
            await db.wms_boxes.insert_many(box_docs[i:i+batch_size])


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
        "created_at": now_iso(),
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
    return {"message": "Task successfully executed"}
