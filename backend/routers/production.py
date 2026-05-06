"""Production logs, gantt data, capacity plan, email routes."""
from fastapi import APIRouter, HTTPException, Request
from deps import db, require_auth, require_admin, log_activity, ProductionLogCreate, EmailRequest, MACHINES, logger, MASTER_API_KEY
from ws_manager import ws_manager
from datetime import datetime, timezone
import uuid, os, asyncio, time
import resend
from typing import Any

router = APIRouter(prefix="/api")

resend.api_key = os.environ.get('RESEND_API_KEY', '')
SENDER_EMAIL = os.environ.get('SENDER_EMAIL', 'onboarding@resend.dev')

# ==================== CACHING SYSTEM ====================
# Simple in-memory cache to reduce CPU load on heavy aggregations
_cache = {}
_cache_locks = {}
_CACHE_TTL = 300 # 5 minutes

def get_cached(key: str):
    now = time.time()
    if key in _cache:
        entry = _cache[key]
        if now - entry['timestamp'] < _CACHE_TTL:
            return entry['data']
        else:
            del _cache[key]
    return None

def set_cache(key: str, data: Any):
    _cache[key] = {
        'data': data,
        'timestamp': time.time()
    }

def invalidate_cache(prefix: str = None):
    if prefix:
        keys_to_del = [k for k in _cache.keys() if k.startswith(prefix)]
        for k in keys_to_del:
            del _cache[k]
    else:
        _cache.clear()

# ==================== OPERATORS CRUD ====================

@router.get("/operators")
async def list_operators(request: Request):
    await require_auth(request)
    operators = await db.operators.find({}, {"_id": 0}).sort("name", 1).to_list(500)
    return operators

@router.post("/operators")
async def create_operator(request: Request):
    user = await require_admin(request)
    body = await request.json()
    name = (body.get("name") or "").strip()
    if not name:
        raise HTTPException(status_code=400, detail="Operator name is required")
    existing = await db.operators.find_one({"name": {"$regex": f"^{name}$", "$options": "i"}}, {"_id": 0})
    if existing:
        raise HTTPException(status_code=400, detail="Operator already exists")
    doc = {
        "operator_id": f"op_{uuid.uuid4().hex[:12]}",
        "name": name,
        "active": True,
        "created_at": datetime.now(timezone.utc).isoformat()
    }
    await db.operators.insert_one(doc)
    await log_activity(user, "create_operator", {"name": name})
    return {k: v for k, v in doc.items() if k != "_id"}

@router.put("/operators/{operator_id}")
async def update_operator(operator_id: str, request: Request):
    user = await require_admin(request)
    body = await request.json()
    existing = await db.operators.find_one({"operator_id": operator_id}, {"_id": 0})
    if not existing:
        raise HTTPException(status_code=404, detail="Operator not found")
    update_data = {}
    if "name" in body:
        name = (body["name"] or "").strip()
        if not name:
            raise HTTPException(status_code=400, detail="Name cannot be empty")
        dup = await db.operators.find_one({"name": {"$regex": f"^{name}$", "$options": "i"}, "operator_id": {"$ne": operator_id}}, {"_id": 0})
        if dup:
            raise HTTPException(status_code=400, detail="Operator name already exists")
        update_data["name"] = name
    if "active" in body:
        update_data["active"] = bool(body["active"])
    if update_data:
        await db.operators.update_one({"operator_id": operator_id}, {"$set": update_data})
        await log_activity(user, "update_operator", {"operator_id": operator_id, **update_data})
    updated = await db.operators.find_one({"operator_id": operator_id}, {"_id": 0})
    return updated

@router.delete("/operators/{operator_id}")
async def delete_operator(operator_id: str, request: Request):
    user = await require_admin(request)
    existing = await db.operators.find_one({"operator_id": operator_id}, {"_id": 0})
    if not existing:
        raise HTTPException(status_code=404, detail="Operator not found")
    await db.operators.delete_one({"operator_id": operator_id})
    await log_activity(user, "delete_operator", {"operator_id": operator_id, "name": existing.get("name")})
    return {"message": "Operator deleted"}

@router.post("/production-logs")
async def create_production_log(log: ProductionLogCreate, request: Request):
    user = await require_auth(request)
    order = await db.orders.find_one({"order_id": log.order_id}, {"_id": 0})
    if not order:
        raise HTTPException(status_code=404, detail="Order not found")
    if log.machine not in MACHINES:
        raise HTTPException(status_code=400, detail=f"Invalid machine")
    log_doc = {
        "log_id": f"plog_{uuid.uuid4().hex[:12]}", "order_id": log.order_id,
        "order_number": order.get("order_number", ""), "quantity_produced": log.quantity_produced,
        "machine": log.machine, "setup": log.setup or 0,
        "operator": log.operator or user.get("name", ""),
        "shift": log.shift or "",
        "design_type": log.design_type or "",
        "stop_cause": log.stop_cause or "",
        "supervisor": log.supervisor or "",
        "client": order.get("client", ""),
        "user_id": user.get("user_id"), "user_name": user.get("name"), "user_email": user.get("email"),
        "created_at": datetime.now(timezone.utc).isoformat()
    }
    await db.production_logs.insert_one(log_doc)
    
    try:
        await log_activity(user, "register_production", {
            "order_id": log.order_id, 
            "order_number": order.get("order_number"), 
            "quantity_produced": log.quantity_produced, 
            "machine": log.machine
        })
    except Exception as e:
        logger.error(f"Error logging production activity: {e}")

    await ws_manager.broadcast("production_update", {"order_id": log.order_id})
    invalidate_cache("prod_") # Invalidate production-related caches
    return {k: v for k, v in log_doc.items() if k != "_id"}

@router.get("/production-logs/{order_id}")
async def get_production_logs(order_id: str, request: Request):
    await require_auth(request)
    logs = await db.production_logs.find({"order_id": order_id}, {"_id": 0}).sort("created_at", -1).to_list(500)
    total_produced = sum(entry.get("quantity_produced", 0) for entry in logs)
    return {"logs": logs, "total_produced": total_produced}

@router.get("/production-summary")
async def get_production_summary(request: Request, date_from: str = None, date_to: str = None):
    api_key = request.query_params.get("api_key")
    if api_key != MASTER_API_KEY:
        await require_auth(request)
    cache_key = "prod_summary"
    cached = get_cached(cache_key)
    if cached and not date_from and not date_to: return cached

    query = {}
    if date_from or date_to:
        from datetime import datetime, timezone, timedelta
        UTC_OFFSET = 7  # hours behind UTC (Arizona MST = UTC-7)
        dt_query = {}
        if date_from:
            # Local midnight (00:00 local) = 07:00 UTC same day
            dt_start = datetime.strptime(date_from, "%Y-%m-%d").replace(
                hour=0, minute=0, second=0, tzinfo=timezone.utc
            ) + timedelta(hours=UTC_OFFSET)
            dt_query["$gte"] = dt_start.isoformat()
        if date_to:
            # Local end of day (23:59:59 local) = next day 06:59:59 UTC
            dt_end = datetime.strptime(date_to, "%Y-%m-%d").replace(
                hour=23, minute=59, second=59, tzinfo=timezone.utc
            ) + timedelta(hours=UTC_OFFSET)
            dt_query["$lte"] = dt_end.isoformat()
        query["created_at"] = dt_query

    pipeline = [
        {"$match": query},
        {"$group": {
            "_id": "$order_number", 
            "total_produced": {"$sum": "$quantity_produced"}, 
            "log_count": {"$sum": 1},
            "last_date": {"$max": "$created_at"}
        }}
    ]
    results = await db.production_logs.aggregate(pipeline).to_list(10000)
    summary = {r["_id"]: {
        "total_produced": r["total_produced"], 
        "log_count": r["log_count"],
        "last_date": r["last_date"]
    } for r in results if r["_id"]}
    
    if not date_from and not date_to:
        set_cache(cache_key, summary)
    return summary

@router.delete("/production-logs/{log_id}")
async def delete_production_log(log_id: str, request: Request):
    user = await require_admin(request)
    existing = await db.production_logs.find_one({"log_id": log_id}, {"_id": 0})
    if not existing:
        raise HTTPException(status_code=404, detail="Production log not found")
    await db.production_logs.delete_one({"log_id": log_id})
    await log_activity(user, "delete_production_log", {"log_id": log_id, "order_id": existing.get("order_id"), "quantity_produced": existing.get("quantity_produced")})
    return {"message": "Production log deleted"}

# ==================== GANTT & CAPACITY PLAN ====================

@router.get("/gantt-data")
async def get_gantt_data(request: Request, start_date: str = None, end_date: str = None):
    await require_auth(request)
    query = {}
    if start_date:
        query["created_at"] = {"$gte": start_date}
    if end_date:
        query.setdefault("created_at", {})["$lte"] = end_date
    logs = await db.production_logs.find(query, {"_id": 0}).sort("created_at", 1).to_list(10000)
    all_orders = await db.orders.find({"board": {"$ne": "PAPELERA DE RECICLAJE"}}, {"_id": 0, "order_id": 1, "order_number": 1, "client": 1, "quantity": 1, "board": 1, "priority": 1}).to_list(10000)
    orders_map = {o["order_id"]: o for o in all_orders}
    prod_summary = {}
    for log in logs:
        key = (log["machine"], log["order_id"])
        if key not in prod_summary:
            prod_summary[key] = {"machine": log["machine"], "order_id": log["order_id"], "order_number": log.get("order_number", ""), "total_produced": 0, "first_date": log["created_at"], "last_date": log["created_at"], "log_count": 0}
        prod_summary[key]["total_produced"] += log.get("quantity_produced", 0)
        prod_summary[key]["last_date"] = log["created_at"]
        prod_summary[key]["log_count"] += 1
    completed_bars = []
    for (machine, order_id), data in prod_summary.items():
        order_info = orders_map.get(order_id, {})
        completed_bars.append({
            "machine": machine, "order_id": order_id, "order_number": data["order_number"],
            "client": order_info.get("client", ""), "quantity_total": order_info.get("quantity", 0),
            "quantity_produced": data["total_produced"], "start_date": data["first_date"],
            "end_date": data["last_date"], "log_count": data["log_count"],
            "status": "completed" if data["total_produced"] >= order_info.get("quantity", 0) else "in_progress",
            "priority": order_info.get("priority", ""), "board": order_info.get("board", "")
        })
    total_by_order = {}
    for log in await db.production_logs.find({}, {"_id": 0, "order_id": 1, "quantity_produced": 1}).to_list(10000):
        total_by_order[log["order_id"]] = total_by_order.get(log["order_id"], 0) + log.get("quantity_produced", 0)
    pending_orders = []
    for o in all_orders:
        produced = total_by_order.get(o["order_id"], 0)
        qty = o.get("quantity", 0)
        if qty > 0 and produced < qty:
            pending_orders.append({"order_id": o["order_id"], "order_number": o.get("order_number", ""), "client": o.get("client", ""), "quantity_total": qty, "quantity_produced": produced, "remaining": qty - produced, "priority": o.get("priority", ""), "board": o.get("board", "")})
    total_pieces_system = sum(o.get("quantity", 0) for o in all_orders)
    return {"bars": completed_bars, "pending": pending_orders, "total_pieces_system": total_pieces_system}

async def _compute_capacity_plan():
    # Get all active orders with their boards
    all_orders = await db.orders.find({"board": {"$ne": "PAPELERA DE RECICLAJE"}}, {"_id": 0, "order_id": 1, "quantity": 1, "board": 1, "order_number": 1, "client": 1, "priority": 1}).to_list(10000)
    orders_map = {o["order_id"]: o for o in all_orders}
    # Orders physically in each machine board
    machine_boards = {f"MAQUINA{i}" for i in range(1, 15)}
    orders_by_machine = {}
    for o in all_orders:
        if o.get("board") in machine_boards:
            orders_by_machine.setdefault(o["board"], []).append(o)
    # Completed orders
    completed_orders = [o for o in all_orders if o.get("board") == "COMPLETOS"]
    total_completed = sum(o.get("quantity", 0) for o in completed_orders)
    in_production_total = sum(o.get("quantity", 0) for o in all_orders if o.get("board") in machine_boards)
    # Production logs only for orders physically in machine boards right now
    machine_order_ids = [o["order_id"] for o in all_orders if o.get("board") in machine_boards]
    # Get production stats only for current machine orders (for avg_daily, active_days)
    pipeline_daily = []
    if machine_order_ids:
        pipeline_daily = [
            {"$match": {"order_id": {"$in": machine_order_ids}}},
            {"$group": {"_id": {"machine": "$machine", "date": {"$substr": ["$created_at", 0, 10]}}, "daily_produced": {"$sum": "$quantity_produced"}}},
            {"$group": {"_id": "$_id.machine", "active_days": {"$sum": 1}, "avg_daily_production": {"$avg": "$daily_produced"}, "max_daily_production": {"$max": "$daily_produced"}}}
        ]
    stats_map = {}
    if pipeline_daily:
        machine_stats = await db.production_logs.aggregate(pipeline_daily).to_list(100)
        stats_map = {s["_id"]: s for s in machine_stats}
    # Build machine plan based on PHYSICAL orders in each machine board
    # Get total produced per order from production logs
    all_machine_order_ids = [o["order_id"] for o in all_orders if o.get("board") in machine_boards]
    produced_by_order = {}
    if all_machine_order_ids:
        prod_pipeline = [
            {"$match": {"order_id": {"$in": all_machine_order_ids}}},
            {"$group": {"_id": "$order_id", "total_produced": {"$sum": "$quantity_produced"}}}
        ]
        prod_results = await db.production_logs.aggregate(prod_pipeline).to_list(10000)
        produced_by_order = {r["_id"]: r["total_produced"] for r in prod_results}

    machines_plan = []
    for i in range(1, 15):
        machine_name = f"MAQUINA{i}"
        physical_orders = orders_by_machine.get(machine_name, [])
        stats = stats_map.get(machine_name, {})
        avg_daily = stats.get("avg_daily_production", 0)
        # Calculate remaining per order: quantity - produced
        orders_detail = []
        total_remaining = 0
        for o in physical_orders:
            qty = o.get("quantity", 0)
            produced = produced_by_order.get(o["order_id"], 0)
            rem = max(0, qty - produced)
            total_remaining += rem
            orders_detail.append({
                "order_id": o["order_id"], "order_number": o.get("order_number", ""),
                "remaining": rem, "total": qty, "produced": produced,
                "client": o.get("client", ""), "priority": o.get("priority", "")
            })
        est_days = total_remaining / avg_daily if avg_daily > 0 and total_remaining > 0 else 0
        load_status = "idle" if len(physical_orders) == 0 else "green" if est_days <= 3 else "yellow" if est_days <= 7 else "red"
        machines_plan.append({
            "machine": machine_name, "total_produced": 0,
            "active_days": stats.get("active_days", 0), "avg_daily_production": round(avg_daily, 1),
            "max_daily_production": stats.get("max_daily_production", 0), "remaining_pieces": total_remaining,
            "estimated_days": round(est_days, 1), "load_status": load_status,
            "orders_in_progress": orders_detail, "order_count": len(physical_orders)
        })
    return {
        "machines": machines_plan,
        "total_pieces_system": sum(o.get("quantity", 0) for o in all_orders),
        "total_completed": total_completed,
        "in_production": in_production_total
    }

@router.get("/capacity-plan")
async def get_capacity_plan(request: Request):
    api_key = request.query_params.get("api_key")
    if api_key != MASTER_API_KEY:
        await require_auth(request)
    cache_key = "capacity_plan"
    
    cached = get_cached(cache_key)
    if cached is not None: return cached

    if cache_key not in _cache_locks:
        _cache_locks[cache_key] = asyncio.Lock()
        
    async with _cache_locks[cache_key]:
        cached = get_cached(cache_key)
        if cached is not None: return cached

        try:
            result = await _compute_capacity_plan()
        except Exception as e:
            import traceback
            logger.error(f"capacity-plan crash: {traceback.format_exc()}")
            raise HTTPException(status_code=500, detail=f"Error computing capacity plan: {str(e)}")
        set_cache(cache_key, result)
        return result

# ==================== PRODUCTION ANALYTICS ====================

def _get_preset_query(preset: str, date_from: str = None, date_to: str = None):
    from datetime import timedelta
    now = datetime.now(timezone.utc)
    query = {}
    if preset:
        if preset == 'today':
            TZ_OFFSET = 7  # UTC-7 (Mountain Time)
            DAY_START_HOUR = 7
            DAY_END_HOUR = 19  # daily cycle ends at 19:00 local
            local_now = now - timedelta(hours=TZ_OFFSET)
            local_start = local_now.replace(hour=DAY_START_HOUR, minute=0, second=0, microsecond=0)
            if local_now.hour < DAY_START_HOUR:
                local_start -= timedelta(days=1)
            utc_start = local_start + timedelta(hours=TZ_OFFSET)
            if local_now.hour >= DAY_END_HOUR:
                # After 19:00 local — cap query at end of day so next-day logs aren't included
                local_end = local_now.replace(hour=DAY_END_HOUR, minute=0, second=0, microsecond=0)
                utc_end = local_end + timedelta(hours=TZ_OFFSET)
                query["created_at"] = {"$gte": utc_start.isoformat(), "$lte": utc_end.isoformat()}
            else:
                query["created_at"] = {"$gte": utc_start.isoformat()}
        elif preset == 'yesterday':
            start = (now - timedelta(days=1)).replace(hour=0, minute=0, second=0, microsecond=0)
            end = now.replace(hour=0, minute=0, second=0, microsecond=0)
            query["created_at"] = {"$gte": start.isoformat(), "$lt": end.isoformat()}
        elif preset == 'week':
            start = (now - timedelta(days=7)).replace(hour=0, minute=0, second=0, microsecond=0)
            query["created_at"] = {"$gte": start.isoformat()}
        elif preset == 'month':
            start = (now - timedelta(days=30)).replace(hour=0, minute=0, second=0, microsecond=0)
            query["created_at"] = {"$gte": start.isoformat()}

    # Fallback to date_from/date_to if query is still empty or forced
    if not query.get("created_at") and (date_from or date_to):
        date_q = {}
        if date_from: date_q["$gte"] = date_from + "T00:00:00"
        if date_to: date_q["$lte"] = date_to + "T23:59:59"
        if date_q: query["created_at"] = date_q
    return query

async def _compute_production_analytics(preset, date_from, date_to, machine, operator, client, order_number):

    query = _get_preset_query(preset, date_from, date_to)
    if machine: query["machine"] = machine
    if operator: query["operator"] = {"$regex": operator, "$options": "i"}
    if client: query["client"] = {"$regex": client, "$options": "i"}
    if order_number: query["order_number"] = {"$regex": order_number, "$options": "i"}
    
    # Use aggregation for heavy lifting
    pipeline = [
        {"$match": query},
        {"$facet": {
            "metrics": [
                {"$group": {
                    "_id": None,
                    "total_produced": {"$sum": "$quantity_produced"},
                    "total_logs": {"$sum": 1},
                    "avg_setup": {"$avg": {"$cond": [{"$gt": ["$setup", 0]}, "$setup", None]}}
                }}
            ],
            "by_machine": [
                {"$group": {
                    "_id": "$machine",
                    "produced": {"$sum": "$quantity_produced"},
                    "setup_sum": {"$sum": "$setup"},
                    "setup_count": {"$sum": {"$cond": [{"$gt": ["$setup", 0]}, 1, 0]}},
                    "count": {"$sum": 1}
                }},
                {"$sort": {"_id": 1}}
            ],
            "by_operator": [
                {"$group": {
                    "_id": "$operator",
                    "produced": {"$sum": "$quantity_produced"},
                    "count": {"$sum": 1}
                }},
                {"$sort": {"produced": -1}},
                {"$limit": 50}
            ],
            "by_shift": [
                {"$group": {
                    "_id": "$shift",
                    "produced": {"$sum": "$quantity_produced"},
                    "count": {"$sum": 1}
                }}
            ],
            "by_client": [
                {"$group": {
                    "_id": "$client",
                    "produced": {"$sum": "$quantity_produced"},
                    "count": {"$sum": 1}
                }},
                {"$sort": {"produced": -1}},
                {"$limit": 50}
            ],
            "by_po": [
                {"$group": {
                    "_id": {"order_id": "$order_id", "order_number": "$order_number"},
                    "produced": {"$sum": "$quantity_produced"},
                    "count": {"$sum": 1}
                }},
                {"$sort": {"produced": -1}},
                {"$limit": 100}
            ],
            "recent_logs": [
                {"$sort": {"created_at": -1}},
                {"$limit": 100},
                {"$project": {"_id": 0}}
            ],
            "by_day": [
                {"$group": {
                    "_id": {"$substr": ["$created_at", 0, 10]},
                    "produced": {"$sum": "$quantity_produced"}
                }},
                {"$sort": {"_id": 1}},
                {"$limit": 90}
            ]
        }}
    ]
    
    agg_results = await db.production_logs.aggregate(pipeline).to_list(1)
    result = agg_results[0] if agg_results else {}
    
    metrics = result.get("metrics", [{}])[0] if result.get("metrics") else {}
    total_produced = metrics.get("total_produced", 0)
    avg_setup = metrics.get("avg_setup", 0) or 0
    total_logs = metrics.get("total_logs", 0)
    
    # Process group data
    machines_data = [
        {
            "machine": m["_id"] or "?", 
            "produced": m["produced"], 
            "avg_setup": int(round(m["setup_sum"] / max(m["setup_count"], 1))), 
            "count": m["count"]
        } for m in result.get("by_machine", [])
    ]
    
    operators_data = [
        {"operator": o["_id"] or "?", "produced": o["produced"], "count": o["count"]} 
        for o in result.get("by_operator", [])
    ]
    
    shifts_data = [
        {"shift": s["_id"] or "Sin turno", "produced": s["produced"], "count": s["count"]} 
        for s in result.get("by_shift", [])
    ]
    
    clients_data = [
        {"client": c["_id"] or "Sin cliente", "produced": c["produced"], "count": c["count"]} 
        for c in result.get("by_client", [])
    ]
    
    # Get all unique order_ids in this period to calculate total_target correctly
    # We do a separate aggregation for this to avoid fetching all logs
    target_pipeline = [
        {"$match": query},
        {"$group": {"_id": "$order_id"}},
        {"$lookup": {
            "from": "orders",
            "localField": "_id",
            "foreignField": "order_id",
            "as": "order_info"
        }},
        {"$unwind": "$order_info"},
        {"$group": {
            "_id": None,
            "total_target": {"$sum": "$order_info.quantity"}
        }}
    ]
    target_agg = await db.production_logs.aggregate(target_pipeline).to_list(1)
    total_target = target_agg[0].get("total_target", 0) if target_agg else 0
    total_remaining = max(total_target - total_produced, 0)

    # Get target qty for the TOP POs for the table display
    order_ids_top = [po["_id"]["order_id"] for po in result.get("by_po", []) if po["_id"].get("order_id")]
    orders_top = await db.orders.find({"order_id": {"$in": order_ids_top}}, {"_id": 0, "order_id": 1, "quantity": 1}).to_list(1000)
    order_qty_map = {o["order_id"]: o.get("quantity", 0) for o in orders_top}
    
    po_data = [
        {
            "order_number": po["_id"].get("order_number") or "?", 
            "produced": po["produced"], 
            "target": order_qty_map.get(po["_id"].get("order_id"), 0), 
            "count": po["count"]
        } for po in result.get("by_po", [])
    ]

    # Trend analysis granularity
    granularity = "hour" if preset == 'today' else "day"
    if preset == 'custom' and date_from and date_to:
        from datetime import date
        d1 = date.fromisoformat(date_from)
        d2 = date.fromisoformat(date_to)
        if (d2 - d1).days <= 1: granularity = "hour"
        else: granularity = "day"
    
    # Separate aggregation for trend to keep it clean
    substr_len = 13 if granularity == "hour" else 10
    trend_pipeline = [
        {"$match": query},
        {"$group": {
            "_id": {"$substr": ["$created_at", 0, substr_len]},
            "produced": {"$sum": "$quantity_produced"}
        }},
        {"$sort": {"_id": 1}}
    ]
    trend_results = await db.production_logs.aggregate(trend_pipeline).to_list(1000)
    trend_data = [{"label": r["_id"], "produced": r["produced"]} for r in trend_results]

    # Distinct filters
    distinct_machines = sorted([m["machine"] for m in machines_data if m["machine"] != "?"])
    distinct_operators = sorted([o["operator"] for o in operators_data if o["operator"] != "?"])
    distinct_clients = sorted([c["client"] for c in clients_data if c["client"] != "Sin cliente"])

    # Production status summary
    all_active_orders = await db.orders.find(
        {"board": {"$nin": ["PAPELERA DE RECICLAJE", "COMPLETOS"]}},
        {"_id": 0, "production_status": 1, "quantity": 1}
    ).to_list(10000)
    by_prod_status = {}
    for o in all_active_orders:
        ps = o.get("production_status") or "Sin estado"
        qty = o.get("quantity", 0) or 0
        if ps not in by_prod_status:
            by_prod_status[ps] = {"count": 0, "quantity": 0}
        by_prod_status[ps]["count"] += 1
        by_prod_status[ps]["quantity"] += qty
    prod_status_data = [{"status": k, "count": v["count"], "quantity": v["quantity"]} for k, v in sorted(by_prod_status.items(), key=lambda x: x[1]["quantity"], reverse=True)]

    by_day_data = [
        {"date": d["_id"], "produced": d["produced"]} 
        for d in result.get("by_day", [])
    ]

    response_data = {
        "total_produced": total_produced, "total_target": total_target,
        "total_remaining": total_remaining,
        "efficiency": round(total_produced / max(total_target, 1) * 100, 1),
        "avg_setup": int(round(avg_setup)), "total_logs": total_logs,
        "by_machine": machines_data, "by_operator": operators_data,
        "by_shift": shifts_data, "by_client": clients_data,
        "by_po": po_data, "by_day": by_day_data, "trend_data": trend_data, "granularity": granularity,
        "by_production_status": prod_status_data,
        "filters": {"machines": distinct_machines, "operators": distinct_operators, "clients": distinct_clients},
        "logs": result.get("recent_logs", [])
    }
    
    return response_data

@router.get("/production-analytics")
async def get_production_analytics(request: Request, date_from: str = None, date_to: str = None, preset: str = None, machine: str = None, operator: str = None, client: str = None, order_number: str = None):
    api_key = request.query_params.get("api_key")
    if api_key != MASTER_API_KEY:
        await require_auth(request)
    

    cache_key = f"prod_analytics_{preset}_{date_from}_{date_to}_{machine}_{operator}_{client}_{order_number}"
    cached = get_cached(cache_key)
    if cached is not None: return cached

    if cache_key not in _cache_locks:
        _cache_locks[cache_key] = asyncio.Lock()

    async with _cache_locks[cache_key]:
        cached = get_cached(cache_key)
        if cached is not None: return cached

        try:
            result = await _compute_production_analytics(preset, date_from, date_to, machine, operator, client, order_number)
        except Exception as e:
            import traceback
            logger.error(f"production-analytics crash: {traceback.format_exc()}")
            raise HTTPException(status_code=500, detail=f"Error computing analytics: {str(e)}")
        set_cache(cache_key, result)
        return result

@router.post("/production-report")
async def generate_production_report(request: Request):
    user = await require_auth(request)
    body = await request.json()
    fmt = body.get("format", "excel")
    preset = body.get("preset")
    filters = body.get("filters", {})
    
    # Build query using helper
    query = _get_preset_query(preset, filters.get("date_from"), filters.get("date_to"))
    if filters.get("shift"): query["shift"] = filters["shift"]
    if filters.get("supervisor"): query["supervisor"] = {"$regex": filters["supervisor"], "$options": "i"}
    if filters.get("machine"): query["machine"] = filters["machine"]
    
    logger.info(f"Generating report: format={fmt}, preset={preset}, filters={filters}")
    logger.info(f"Final Query: {query}")
    
    logs = await db.production_logs.find(query, {"_id": 0}).sort("created_at", 1).to_list(50000)
    logger.info(f"Found {len(logs)} logs for report")
    
    # Save debug info to a file we can read
    with open("report_debug.log", "a") as f:
        f.write(f"\n[{datetime.now().isoformat()}] Report Request: {fmt}, {preset}, {filters}\n")
        f.write(f"Query: {query}\n")
        f.write(f"Logs found: {len(logs)}\n")
        if logs:
            f.write(f"Sample log date: {logs[0].get('created_at')}\n")
    
    # Summary calculation for the report
    total_produced = sum(l.get("quantity_produced", 0) for l in logs)
    setup_logs = [l.get("setup", 0) for l in logs if l.get("setup", 0) > 0]
    avg_setup = sum(setup_logs) / max(len(setup_logs), 1)
    
    # Get target quantity for summary per PO
    order_ids = list(set(l.get("order_id") for l in logs if l.get("order_id")))
    orders_info = await db.orders.find({"order_id": {"$in": order_ids}}, {"_id": 0, "order_id": 1, "quantity": 1, "order_number": 1, "client": 1}).to_list(10000)
    order_map = {o["order_id"]: o for o in orders_info}
    
    by_po = {}
    by_machine = {}
    by_client = {}
    for l in logs:
        oid = l.get("order_id")
        if oid:
            if oid not in by_po: by_po[oid] = {"order_number": l.get("order_number", "?"), "client": l.get("client", ""), "target": order_map.get(oid, {}).get("quantity", 0), "produced": 0}
            by_po[oid]["produced"] += l.get("quantity_produced", 0)
        
        m = l.get("machine", "Desconocida")
        by_machine[m] = by_machine.get(m, 0) + l.get("quantity_produced", 0)
        
        c = l.get("client", "Sin Cliente")
        by_client[c] = by_client.get(c, 0) + l.get("quantity_produced", 0)
    
    summary = {
        "total_produced": total_produced,
        "avg_setup": int(round(avg_setup)),
        "efficiency": round((total_produced / sum(o.get("target", 0) for o in by_po.values())) * 100, 1) if by_po else 0,
        "by_po": sorted(list(by_po.values()), key=lambda x: x["produced"], reverse=True),
        "by_machine": sorted([{"machine": k, "produced": v} for k, v in by_machine.items()], key=lambda x: x["produced"], reverse=True),
        "by_client": sorted([{"client": k, "produced": v} for k, v in by_client.items()], key=lambda x: x["produced"], reverse=True)
    }

    # Generate a unique timestamped filename
    ts = datetime.now().strftime("%Y%m%d_%H%M")
    
    if fmt == "pdf":
        result = await _generate_pdf_report(logs, summary, filters)
        result["filename"] = f"DASHBOARD_CEO_{ts}.pdf"
        return result
    else:
        result = await _generate_excel_report(logs, summary, filters)
        result["filename"] = f"ANALISIS_CEO_{ts}.xlsx"
        return result

async def _generate_excel_report(logs, summary, filters):
    import xlsxwriter, io, base64
    output = io.BytesIO()
    wb = xlsxwriter.Workbook(output, {'in_memory': True})
    
    # Format tokens
    title_fmt = wb.add_format({'bold': True, 'size': 18, 'font_color': '#1a1a2e'})
    subtitle_fmt = wb.add_format({'size': 12, 'font_color': '#666666'})
    header_fmt = wb.add_format({'bold': True, 'bg_color': '#1f2937', 'font_color': 'white', 'border': 1, 'align': 'center'})
    
    # KPI Cards Formats
    kpi_label_emerald = wb.add_format({'bold': True, 'bg_color': '#ecfdf5', 'font_color': '#065f46', 'border': 1, 'align': 'center', 'valign': 'vcenter'})
    kpi_value_emerald = wb.add_format({'bold': True, 'size': 16, 'bg_color': '#ecfdf5', 'font_color': '#059669', 'border': 1, 'align': 'center', 'valign': 'vcenter'})
    
    kpi_label_rose = wb.add_format({'bold': True, 'bg_color': '#fff1f2', 'font_color': '#9f1239', 'border': 1, 'align': 'center', 'valign': 'vcenter'})
    kpi_value_rose = wb.add_format({'bold': True, 'size': 16, 'bg_color': '#fff1f2', 'font_color': '#e11d48', 'border': 1, 'align': 'center', 'valign': 'vcenter'})
    
    kpi_label_blue = wb.add_format({'bold': True, 'bg_color': '#eff6ff', 'font_color': '#1e40af', 'border': 1, 'align': 'center', 'valign': 'vcenter'})
    kpi_value_blue = wb.add_format({'bold': True, 'size': 16, 'bg_color': '#eff6ff', 'font_color': '#2563eb', 'border': 1, 'align': 'center', 'valign': 'vcenter'})

    cell_fmt = wb.add_format({'border': 1, 'valign': 'vcenter'})
    num_fmt = wb.add_format({'border': 1, 'num_format': '#,##0', 'align': 'right'})

    # --- SHEET 1: PANEL EJECUTIVO ---
    ws_res = wb.add_worksheet("📊 DASHBOARD")
    ws_res.hide_gridlines(2) # Hide all gridlines for a clean look
    
    ws_res.set_column('A:A', 5)
    ws_res.set_column('B:E', 25)
    
    # Header Row
    ws_res.set_row(1, 40)
    ws_res.write(1, 1, "REPORTE ESTRATÉGICO DE OPERACIONES", title_fmt)
    
    period_str = "Resumen Gerencial"
    if filters.get("date_from"):
        period_str = f"Periodo: {filters['date_from']} al {filters.get('date_to', '')}"
    ws_res.write(2, 1, period_str, subtitle_fmt)
    
    # KPI SECTION - Make them TALL and prominent
    ws_res.set_row(4, 30) # Label row
    ws_res.set_row(5, 50) # Value row
    
    # Piezas Producidas Card
    ws_res.write(4, 1, "PIEZAS PRODUCIDAS", kpi_label_emerald)
    ws_res.write(5, 1, f"{summary.get('total_produced', 0):,}", kpi_value_emerald)
    
    # Eficiencia Card
    ws_res.write(4, 2, "EFICIENCIA GLOBAL", kpi_label_blue)
    ws_res.write(5, 2, f"{summary.get('efficiency', 0)}%", kpi_value_blue)
    
    # Setup Card
    ws_res.write(4, 3, "PROMEDIO SETUP", kpi_label_rose)
    ws_res.write(5, 3, f"{summary.get('avg_setup', 0)} min", kpi_value_rose)

    # Detailed Table
    ws_res.write(8, 1, "RENDIMIENTO POR ORDEN DE TRABAJO", wb.add_format({'bold': True, 'size': 14, 'bottom': 2}))
    po_headers = ['Orden', 'Cliente', 'Meta', 'Producido', 'Avance %']
    for i, h in enumerate(po_headers):
        ws_res.write(9, i+1, h, header_fmt)

    for row, po in enumerate(summary.get("by_po", [])[:20], 10):
        target = po.get("target", 0)
        produced = po.get("produced", 0)
        progress = (produced / target) if target > 0 else 0
        ws_res.write(row, 1, po.get("order_number", ""), cell_fmt)
        ws_res.write(row, 2, po.get("client", ""), cell_fmt)
        ws_res.write(row, 3, target, num_fmt)
        ws_res.write(row, 4, produced, num_fmt)
        ws_res.write(row, 5, progress, wb.add_format({'border': 1, 'num_format': '0.0%', 'align': 'center'}))

    # Add Charts
    if summary.get("by_machine"):
        chart = wb.add_chart({'type': 'column'})
        # Data for chart (we'll hide it in a separate sheet)
        ws_data = wb.add_worksheet("_internal_data")
        for i, m in enumerate(summary["by_machine"][:8]):
            ws_data.write(i, 0, m["machine"])
            ws_data.write(i, 1, m["produced"])
        
        chart.add_series({
            'name': 'Producción',
            'categories': '=_internal_data!$A$1:$A$8',
            'values': '=_internal_data!$B$1:$B$8',
            'fill': {'color': '#10b981'}
        })
        chart.set_title({'name': 'Producción por Máquina'})
        chart.set_legend({'position': 'none'})
        ws_res.insert_chart('B32', chart, {'x_scale': 1.5, 'y_scale': 1.5})

    # --- SHEET 3: DETALLES ---
    ws = wb.add_worksheet("TRANSACCIONES")
    for i, h in enumerate(['Fecha/Hora', 'Orden', 'Cliente', 'Maquina', 'Operador', 'Turno', 'Diseno', 'Cantidad', 'Setup', 'Supervisor', 'Parada']):
        ws.write(0, i, h, header_fmt)
        ws.set_column(i, i, 16)
    for row, l in enumerate(logs, 1):
        ws.write(row, 0, l.get("created_at", "")[:19].replace("T", " "), cell_fmt)
        ws.write(row, 1, l.get("order_number", ""), cell_fmt)
        ws.write(row, 2, l.get("client", ""), cell_fmt)
        ws.write(row, 3, l.get("machine", ""), cell_fmt)
        ws.write(row, 4, l.get("operator", l.get("user_name", "")), cell_fmt)
        ws.write(row, 5, l.get("shift", ""), cell_fmt)
        ws.write(row, 6, l.get("design_type", ""), cell_fmt)
        ws.write(row, 7, l.get("quantity_produced", 0), cell_fmt)
        ws.write(row, 8, l.get("setup", 0), cell_fmt)
        ws.write(row, 9, l.get("supervisor", ""), cell_fmt)
        ws.write(row, 10, l.get("stop_cause", ""), cell_fmt)
    
    wb.close()
    output.seek(0)
    data_b64 = base64.b64encode(output.read()).decode()
    return {"data": data_b64, "content_type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"}

async def _generate_pdf_report(logs, summary, filters):
    from reportlab.lib.pagesizes import landscape, letter
    from reportlab.lib import colors
    from reportlab.platypus import SimpleDocTemplate, Table, TableStyle, Paragraph, Spacer, PageBreak
    from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
    from reportlab.graphics.shapes import Drawing
    from reportlab.graphics.charts.barcharts import VerticalBarChart
    import io, base64
    
    output = io.BytesIO()
    doc = SimpleDocTemplate(output, pagesize=landscape(letter), leftMargin=30, rightMargin=30, topMargin=40, bottomMargin=40)
    styles = getSampleStyleSheet()
    
    # Custom Styles
    styles.add(ParagraphStyle(name='ExecutiveTitle', parent=styles['Title'], fontSize=24, textColor=colors.HexColor('#111827'), spaceAfter=10))
    styles.add(ParagraphStyle(name='ExecutiveSub', parent=styles['Normal'], fontSize=10, textColor=colors.HexColor('#6b7280'), spaceAfter=20))
    styles.add(ParagraphStyle(name='MetricValue', parent=styles['Normal'], fontSize=24, spaceBefore=10, spaceAfter=5, textColor=colors.HexColor('#e94560'), alignment=1, fontName='Helvetica-Bold'))
    styles.add(ParagraphStyle(name='MetricLabel', parent=styles['Normal'], fontSize=10, textColor=colors.HexColor('#6b7280'), alignment=1, fontName='Helvetica-Bold'))

    elements = []
    
    # PDF Title
    elements.append(Paragraph("DASHBOARD ESTRATÉGICO DE PRODUCCIÓN", styles['ExecutiveTitle']))
    elements.append(Paragraph(f"Generado el: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')} | Prosper Manufacturing", styles['ExecutiveSub']))
    elements.append(Spacer(1, 10))
    header_table_data = [[
        Paragraph("<b>MOS SYSTEM | OPERATIONAL REPORT</b>", ParagraphStyle(name='H', fontSize=10, textColor=colors.white)),
        Paragraph(datetime.now().strftime("%d %b %Y | %H:%M"), ParagraphStyle(name='T', fontSize=10, textColor=colors.white, alignment=2))
    ]]
    ht = Table(header_table_data, colWidths=[550, 150])
    ht.setStyle(TableStyle([
        ('BACKGROUND', (0, 0), (-1, -1), colors.HexColor('#111827')),
        ('TOPPADDING', (0, 0), (-1, -1), 10),
        ('BOTTOMPADDING', (0, 0), (-1, -1), 10),
    ]))
    elements.append(ht)
    elements.append(Spacer(1, 20))

    elements.append(Paragraph("DASHBOARD ESTRATÉGICO DE PRODUCCIÓN", styles['ExecutiveTitle']))
    period_str = "Status Gerencial"
    if filters.get("date_from"): period_str = f"Rango: {filters['date_from']} al {filters.get('date_to','')}"
    elements.append(Paragraph(period_str, styles['Normal']))
    elements.append(Spacer(1, 20))
    
    # 2. KPI CARDS (More illustrative)
    # Wrap KPIs in a table to look like cards
    kpi_table_data = [
        [
            Paragraph("PIEZAS PRODUCIDAS", styles['MetricLabel']),
            Paragraph("EFICIENCIA GLOBAL", styles['MetricLabel']),
            Paragraph("PROMEDIO SETUP", styles['MetricLabel'])
        ],
        [
            Paragraph(f"{summary.get('total_produced', 0):,}", styles['MetricValue']),
            Paragraph(f"{summary.get('efficiency', 0)}%", styles['MetricValue']),
            Paragraph(f"{summary.get('avg_setup', 0)} min", styles['MetricValue'])
        ]
    ]
    kpi_table = Table(kpi_table_data, colWidths=[240, 240, 240])
    kpi_table.setStyle(TableStyle([
        ('BACKGROUND', (0, 0), (-1, 0), colors.HexColor('#f9fafb')),
        ('BOX', (0, 0), (-1, -1), 1, colors.HexColor('#e5e7eb')),
        ('BOTTOMPADDING', (0, 0), (-1, -1), 15),
        ('TOPPADDING', (0, 0), (-1, -1), 15),
        ('VALIGN', (0, 0), (-1, -1), 'MIDDLE'),
    ]))
    elements.append(kpi_table)
    elements.append(Spacer(1, 40))
    
    # 3. CHARTS & RECOGNITION (Simulation of charts since graphics in reportlab can be complex)
    elements.append(Paragraph("PRODUCCIÓN POR MÁQUINA (TOP 5)", styles['Heading2']))
    
    # Table representation of a chart for better reliability
    max_prod = max([m["produced"] for m in summary["by_machine"]]) if summary["by_machine"] else 1
    chart_data = []
    for m in summary["by_machine"][:5]:
        width = (m["produced"] / max_prod) * 400
        # We can simulate a "bar" with a table cell background
        chart_data.append([
            m["machine"], 
            m["produced"], 
            Table([[""]], colWidths=[width], rowHeights=[12], style=[('BACKGROUND', (0, 0), (-1, -1), colors.HexColor('#3b82f6'))])
        ])
    
    ct = Table(chart_data, colWidths=[150, 100, 450])
    ct.setStyle(TableStyle([
        ('FONTNAME', (0, 0), (-1, -1), 'Helvetica-Bold'),
        ('VALIGN', (0, 0), (-1, -1), 'MIDDLE'),
        ('BOTTOMPADDING', (0, 0), (-1, -1), 8),
    ]))
    elements.append(ct)
    elements.append(Spacer(1, 40))

    # 4. TOP CLIENTS & SUMMARY
    elements.append(Paragraph("DISTRIBUCIÓN POR CLIENTE", styles['Heading2']))
    client_data = [['Cliente', 'Unidades', '% del Total']]
    total = summary.get("total_produced") or 1
    for c in summary["by_client"][:8]:
        perc = (c["produced"] / total) * 100
        client_data.append([c["client"], f"{c['produced']:,}", f"{perc:.1f}%"])
    
    clt = Table(client_data, colWidths=[300, 150, 150])
    clt.setStyle(TableStyle([
        ('BACKGROUND', (0, 0), (-1, 0), colors.HexColor('#111827')),
        ('TEXTCOLOR', (0, 0), (-1, 0), colors.white),
        ('GRID', (0, 0), (-1, -1), 0.5, colors.grey),
        ('ALIGN', (1, 0), (-1, -1), 'CENTER'),
        ('ROWBACKGROUNDS', (0, 1), (-1, -1), [colors.white, colors.HexColor('#f3f4f6')]),
    ]))
    elements.append(clt)
    
    # Detailed logs on next page
    elements.append(PageBreak())
    elements.append(Paragraph("REGISTRO DETALLADO DE PRODUCCIÓN", styles['Heading2']))
    
    headers = ['Fecha', 'Orden', 'Cliente', 'Maquina', 'Operador', 'Turno', 'Cant.', 'Setup', 'Supervisor', 'Parada']
    data = [headers]
    for l in logs:
        data.append([
            l.get("created_at", "")[:16].replace("T", " "),
            l.get("order_number", ""), l.get("client", "")[:15],
            l.get("machine", "").replace("MAQUINA", "M"), l.get("operator", l.get("user_name", ""))[:15],
            l.get("shift", ""), 
            str(l.get("quantity_produced", 0)), str(l.get("setup", 0)),
            l.get("supervisor", "")[:15], l.get("stop_cause", "")[:15]
        ])
    
    t = Table(data, repeatRows=1, colWidths=[90, 80, 100, 60, 90, 60, 50, 50, 80, 80])
    t.setStyle(TableStyle([
        ('BACKGROUND', (0, 0), (-1, 0), colors.HexColor('#111827')),
        ('TEXTCOLOR', (0, 0), (-1, 0), colors.white),
        ('FONTSIZE', (0, 0), (-1, -1), 7),
        ('GRID', (0, 0), (-1, -1), 0.2, colors.grey),
        ('VALIGN', (0, 0), (-1, -1), 'MIDDLE'),
    ]))
    elements.append(t)
    
    doc.build(elements)
    output.seek(0)
    data_b64 = base64.b64encode(output.read()).decode()
    return {"filename": "reporte_ejecutivo_premium.pdf", "data": data_b64, "content_type": "application/pdf"}

# ==================== EMAIL ROUTE ====================

@router.post("/send-email")
async def send_email(email_request: EmailRequest, request: Request):
    user = await require_auth(request)
    if not resend.api_key:
        raise HTTPException(status_code=500, detail="Email service not configured")
    params = {"from": SENDER_EMAIL, "to": [email_request.recipient_email], "subject": email_request.subject, "html": email_request.html_content}
    try:
        email = await asyncio.to_thread(resend.Emails.send, params)
        await log_activity(user, "send_email", {"recipient": email_request.recipient_email})
        return {"status": "success", "email_id": email.get("id")}
    except Exception as e:
        logger.error(f"Email send error: {e}")
        raise HTTPException(status_code=500, detail=f"Failed to send email: {str(e)}")
