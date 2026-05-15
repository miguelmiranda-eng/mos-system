from fastapi import APIRouter, HTTPException, Request
from typing import List, Optional
from deps import db, require_auth, ArtLogCreate, logger, IS_PROD
from datetime import datetime, timezone, timedelta
import uuid

router = APIRouter(prefix="/api/art")

# Helper: en local no requerimos sesion para no bloquear el desarrollo
async def get_user_or_mock(request: Request):
    if IS_PROD:
        return await require_auth(request)
    # Mock user para entorno local
    return {"user_id": "local_dev", "name": "Developer (Local)", "role": "admin"}


@router.post("/log")
async def log_art_work(request: Request, log_data: ArtLogCreate):
    user = await get_user_or_mock(request)
    
    # 1. Verify order exists
    order = await db.orders.find_one({"order_id": log_data.order_id})
    if not order:
        order = await db.orders.find_one({"order_number": log_data.order_number})
        if not order:
            raise HTTPException(status_code=404, detail="Orden no encontrada")

    # 2. Create the log entry
    log_entry = {
        "log_id": f"art_{uuid.uuid4().hex[:12]}",
        "order_id": order["order_id"],
        "order_number": order["order_number"],
        "client": order.get("client", "Unknown"),
        "type": log_data.type,  # 'SEPARATION' | 'NECK'
        "details": log_data.details,
        "user_id": user["user_id"],
        "user_name": user["name"],
        "is_preorder": order.get("is_preorder", False),
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "date": datetime.now(timezone.utc).strftime("%Y-%m-%d")
    }
    
    await db.art_logs.insert_one(log_entry)

    # 3. Update the order status for quick visual feedback
    update_field = "art_sep_status" if log_data.type == 'SEPARATION' else "art_neck_status"
    await db.orders.update_one(
        {"order_id": order["order_id"]},
        {"$set": {update_field: True}}
    )

    # 4. Notify via WebSocket
    from ws_manager import ws_manager
    await ws_manager.broadcast({
        "type": "ORDER_UPDATED",
        "order_id": order["order_id"],
        "user": user["name"],
        "action": f"Registered Art {log_data.type}"
    })

    return {"status": "success", "log_id": log_entry["log_id"]}


@router.get("/pending")
async def get_pending_art(request: Request, status: str = 'pending'):
    await get_user_or_mock(request)

    # Tableros excluidos - ordenes en estos tableros no necesitan seguimiento de arte
    excluded_boards = [
        'MASTER', 'EJEMPLOS', 'PAPELERA DE RECICLAJE', 'COMPLETOS',
        'INVENTARIO', 'EDI', 'FINAL BILL', 'RESPALDO MONDAY', 'CANCELLED'
    ]

    if status == 'worked':
        # Mostrar ordenes donde AL MENOS UNO de los estados sea True
        query = {
            "board": {"$nin": excluded_boards},
            "$or": [
                {"art_sep_status": True},
                {"art_neck_status": True}
            ]
        }
    elif status == 'ready_for_screens':
        # Nuevo apartado: Listo para cuadros. Excluimos las ya convertidas.
        query = {
            "board": "SCREENS",
            "is_preorder": True,
            "artwork_status": {"$ne": "CONVERTED"}
        }
    elif status == 'converted':
        # Historial de pre-ordenes ya convertidas (MUERTAS)
        query = {
            "is_preorder": True,
            "artwork_status": "CONVERTED"
        }
    else:
        # Default: pending. Excluimos SCREENS y las ya CONVERTIDAS.
        query = {
            "board": {"$nin": excluded_boards + ["SCREENS"]},
            "artwork_status": {"$ne": "CONVERTED"}
        }

    cursor = db.orders.find(query, {
        "order_id": 1, "order_number": 1, "client": 1, "board": 1,
        "art_sep_status": 1, "art_neck_status": 1, "priority": 1, "due_date": 1,
        "cancel_date": 1, "artwork_status": 1, "betty_column": 1, 
        "design_number": 1, "ref_link": 1, "screens": 1, "sample": 1,
        "job_title_a": 1, "job_title_b": 1, "is_preorder": 1,
        "_id": 0
    }).sort([("created_at", -1)]).limit(500)

    pending = await cursor.to_list(length=500)
    
    # Extra safety: ensure no ObjectId survives
    for p in pending:
        if "_id" in p:
            p.pop("_id")
            
    found_boards = set(o.get('board') for o in pending if o.get('board'))
    logger.info(f"Art /pending: {len(pending)} orders in boards: {found_boards}")

    return pending


@router.get("/stats/daily")
async def get_daily_art_stats(request: Request):
    user = await get_user_or_mock(request)
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")

    match_query = {"date": today}
    if IS_PROD and user.get("role") not in ("admin", "supersu", "inspector_qc"):
        match_query["user_id"] = user["user_id"]

    cursor = db.art_logs.find(match_query, {"_id": 0}).sort("timestamp", -1)
    logs = await cursor.to_list(length=100)

    # Extra safety: ensure no ObjectId survives
    for l in logs:
        if "_id" in l:
            l.pop("_id")

    total_seps = sum(1 for l in logs if l["type"] == 'SEPARATION')
    total_necks = sum(1 for l in logs if l["type"] == 'NECK')

    return {
        "total_separations": total_seps,
        "total_necks": total_necks,
        "recent_logs": logs
    }


@router.get("/stats/history")
async def get_art_history(request: Request):
    """Returns aggregated stats for charts: Daily (last 14 days), Weekly (last 8 weeks), Monthly (last 6 months)."""
    user = await get_user_or_mock(request)
    now = datetime.now(timezone.utc)
    
    # Define time ranges
    thirty_days_ago = (now - timedelta(days=30)).isoformat()
    
    # Base match query
    match_query = {"timestamp": {"$gte": thirty_days_ago}}
    if IS_PROD and user.get("role") not in ("admin", "supersu", "inspector_qc"):
        match_query["user_id"] = user["user_id"]

    # Daily Aggregation (Last 14 days for the chart)
    daily_pipeline = [
        {"$match": match_query},
        {"$group": {
            "_id": "$date",
            "separations_real": {"$sum": {"$cond": [{"$and": [{"$eq": ["$type", "SEPARATION"]}, {"$ne": ["$is_preorder", True]}]}, 1, 0]}},
            "separations_pre": {"$sum": {"$cond": [{"$and": [{"$eq": ["$type", "SEPARATION"]}, {"$eq": ["$is_preorder", True]}]}, 1, 0]}},
            "necks_real": {"$sum": {"$cond": [{"$and": [{"$eq": ["$type", "NECK"]}, {"$ne": ["$is_preorder", True]}]}, 1, 0]}},
            "necks_pre": {"$sum": {"$cond": [{"$and": [{"$eq": ["$type", "NECK"]}, {"$eq": ["$is_preorder", True]}]}, 1, 0]}}
        }},
        {"$sort": {"_id": 1}},
        {"$limit": 30}
    ]
    daily_stats = await db.art_logs.aggregate(daily_pipeline).to_list(30)

    # Weekly Aggregation
    weekly_pipeline = [
        {"$match": {"timestamp": {"$gte": (now - timedelta(weeks=12)).isoformat()}}},
        {"$addFields": {
            "ts_date": {"$dateFromString": {"dateString": "$timestamp"}}
        }},
        {"$group": {
            "_id": {
                "year": {"$year": "$ts_date"},
                "week": {"$week": "$ts_date"}
            },
            "separations_real": {"$sum": {"$cond": [{"$and": [{"$eq": ["$type", "SEPARATION"]}, {"$ne": ["$is_preorder", True]}]}, 1, 0]}},
            "separations_pre": {"$sum": {"$cond": [{"$and": [{"$eq": ["$type", "SEPARATION"]}, {"$eq": ["$is_preorder", True]}]}, 1, 0]}},
            "necks_real": {"$sum": {"$cond": [{"$and": [{"$eq": ["$type", "NECK"]}, {"$ne": ["$is_preorder", True]}]}, 1, 0]}},
            "necks_pre": {"$sum": {"$cond": [{"$and": [{"$eq": ["$type", "NECK"]}, {"$eq": ["$is_preorder", True]}]}, 1, 0]}},
            "date": {"$first": "$date"}
        }},
        {"$sort": {"_id.year": 1, "_id.week": 1}},
        {"$limit": 12}
    ]
    weekly_stats = await db.art_logs.aggregate(weekly_pipeline).to_list(12)

    # Monthly Aggregation
    monthly_pipeline = [
        {"$match": {"timestamp": {"$gte": (now - timedelta(days=365)).isoformat()}}},
        {"$addFields": {
            "ts_date": {"$dateFromString": {"dateString": "$timestamp"}}
        }},
        {"$group": {
            "_id": {
                "year": {"$year": "$ts_date"},
                "month": {"$month": "$ts_date"}
            },
            "separations_real": {"$sum": {"$cond": [{"$and": [{"$eq": ["$type", "SEPARATION"]}, {"$ne": ["$is_preorder", True]}]}, 1, 0]}},
            "separations_pre": {"$sum": {"$cond": [{"$and": [{"$eq": ["$type", "SEPARATION"]}, {"$eq": ["$is_preorder", True]}]}, 1, 0]}},
            "necks_real": {"$sum": {"$cond": [{"$and": [{"$eq": ["$type", "NECK"]}, {"$ne": ["$is_preorder", True]}]}, 1, 0]}},
            "necks_pre": {"$sum": {"$cond": [{"$and": [{"$eq": ["$type", "NECK"]}, {"$eq": ["$is_preorder", True]}]}, 1, 0]}}
        }},
        {"$sort": {"_id.year": 1, "_id.month": 1}},
        {"$limit": 12}
    ]
    monthly_raw = await db.art_logs.aggregate(monthly_pipeline).to_list(12)
    
    # Map month numbers to names
    month_names = ["", "Ene", "Feb", "Mar", "Abr", "May", "Jun", "Jul", "Ago", "Sep", "Oct", "Nov", "Dic"]
    monthly_stats = [
        {
            "label": f"{month_names[m['_id']['month']]} {m['_id']['year']}",
            "separations": m["separations_real"] + m["separations_pre"],
            "separations_pre": m["separations_pre"],
            "necks": m["necks_real"] + m["necks_pre"],
            "necks_pre": m["necks_pre"]
        } for m in monthly_raw
    ]

    weekly_stats = [
        {
            "label": f"Sem {w['_id']['week']}",
            "separations": w["separations_real"] + w["separations_pre"],
            "separations_pre": w["separations_pre"],
            "necks": w["necks_real"] + w["necks_pre"],
            "necks_pre": w["necks_pre"]
        } for w in weekly_stats
    ]

    daily_stats = [
        {
            "label": d["_id"][-5:] if "-" in d["_id"] else d["_id"],
            "separations": d["separations_real"] + d["separations_pre"],
            "separations_pre": d["separations_pre"],
            "necks": d["necks_real"] + d["necks_pre"],
            "necks_pre": d["necks_pre"]
        } for d in daily_stats
    ]

    return {
        "daily": daily_stats,
        "weekly": weekly_stats,
        "monthly": monthly_stats
    }

@router.post("/preorder")
async def create_preorder(request: Request, data: dict):
    user = await get_user_or_mock(request)
    
    # Generate a temporary order number if not provided
    order_number = data.get("order_number")
    if not order_number:
        count = await db.orders.count_documents({"is_preorder": True})
        order_number = f"PRE-{count + 1:04d}"
        
    new_order = {
        "order_id": str(uuid.uuid4()),
        "order_number": order_number,
        "client": data.get("client", "N/A"),
        "design_number": data.get("design_number", "").strip().upper(),
        "ref_link": data.get("ref_link", ""),   # Temporal: solo visible en pre-ordenes
        "screens": data.get("screens", False),
        "sample": data.get("sample", ""),
        "artwork_status": data.get("artwork_status", "NEW"),
        "betty_column": data.get("betty_column", ""),
        "cancel_date": data.get("cancel_date"),
        "board": "PRE-ORDENES",
        "is_preorder": True,
        "art_sep_status": False,
        "art_neck_status": False,
        "created_at": datetime.now(timezone.utc).isoformat(),
        "created_by": user["name"]
    }
    
    await db.orders.insert_one(new_order)
    
    # Remove _id as it is not JSON serializable (ObjectId)
    if "_id" in new_order:
        new_order.pop("_id")
    
    from ws_manager import ws_manager
    await ws_manager.broadcast({
        "type": "ORDER_CREATED",
        "order": new_order,
        "user": user["name"]
    })
    
    return {"status": "success", "order_id": new_order["order_id"], "order_number": order_number}

@router.get("/preorder/check/{design_number}")
async def check_preorder_design(design_number: str, request: Request):
    await get_user_or_mock(request)
    
    clean_design = design_number.strip().upper()
    if not clean_design:
        raise HTTPException(400, "Design number cannot be empty")
        
    preorder = await db.orders.find_one({
        "is_preorder": True,
        "design_number": clean_design,
        "artwork_status": {"$ne": "CONVERTED"}
    }, {"_id": 0})
    
    if not preorder:
        return {"found": False}
        
    return {
        "found": True,
        "data": {
            "client": preorder.get("client", ""),
            "job_title_a": preorder.get("job_title_a", ""),
            "job_title_b": preorder.get("job_title_b", ""),
            "screens": preorder.get("screens", False),
            "sample": preorder.get("sample", ""),
            "artwork_status": preorder.get("artwork_status", "NEW"),
            "betty_column": preorder.get("betty_column", ""),
            "art_sep_status": preorder.get("art_sep_status", False),
            "art_neck_status": preorder.get("art_neck_status", False),
            "preorder_id": preorder.get("order_id")
        }
    }
