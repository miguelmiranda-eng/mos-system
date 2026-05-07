"""Orders routes: CRUD, comments, images, bulk-move, export."""
from fastapi import APIRouter, HTTPException, Request, File, UploadFile, Form, Response
from typing import Optional
import json
from deps import db, require_auth, require_admin, log_activity, OrderCreate, OrderUpdate, CommentCreate, BOARDS, get_dynamic_boards, logger, MASTER_API_KEY
from ws_manager import ws_manager
from datetime import datetime, timezone
import uuid, base64, os, io, re
import pandas as pd
from reportlab.lib.pagesizes import letter
from reportlab.lib import colors
from reportlab.platypus import SimpleDocTemplate, Table, TableStyle, Paragraph, Spacer, Image, PageBreak
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.units import inch
import time
import asyncio

router = APIRouter(prefix="/api/orders")

UPLOADS_DIR = Path("uploads") / "invoices"
UPLOADS_DIR.mkdir(parents=True, exist_ok=True)

# ==================== CACHE SYSTEM FOR ORDERS ====================
_orders_cache = {}
_orders_cache_locks = {}

def get_orders_cached(key: str):
    # No TTL needed because we invalidate explicitly on every broadcast
    return _orders_cache.get(key)

# Intercept ws_manager.broadcast to invalidate cache on any system update
original_broadcast = ws_manager.broadcast
async def patched_broadcast(*args, **kwargs):
    _orders_cache.clear()
    return await original_broadcast(*args, **kwargs)
ws_manager.broadcast = patched_broadcast
# =================================================================


def _merge_custom_fields(order: dict):
    if not order:
        return order
    custom = order.get("custom_fields")
    if isinstance(custom, dict):
        return {**custom, **order}
    return order

# Helper to create notifications for all users except the actor
async def _notify_all(actor, notif_type, message, order_id=None, order_number=None):
    # System disabled general notifications as per user request
    # Only mentions are allowed now (handled in specific routes)
    return

# Lazy import to avoid circular - automations engine is in its own file
async def _run_automations(trigger_type, order, user, context=None):
    from routers.automations import run_automations
    return await run_automations(trigger_type, order, user, context)

@router.get("")
async def get_orders(request: Request, board: str = None, search: str = None, limit: int = 1000):
    api_key = request.query_params.get("api_key")
    if api_key != MASTER_API_KEY:
        await require_auth(request)
    
    # Cache stampede protection
    cache_key = f"orders_{board}_{search}_{limit}"
    cached = get_orders_cached(cache_key)
    if cached is not None: return cached

    if cache_key not in _orders_cache_locks:
        _orders_cache_locks[cache_key] = asyncio.Lock()
        
    async with _orders_cache_locks[cache_key]:
        cached = get_orders_cached(cache_key)
        if cached is not None: return cached

        query = {}
        if board == "MASTER":
            # Exclude trash AND ghost orders (null/missing board) using an indexable query
            # We use $in with dynamic boards because $nin causes a full collection scan
            from deps import get_dynamic_boards
            active_boards = await get_dynamic_boards()
            query["board"] = {"$in": active_boards}
        elif board:
            query["board"] = board
        if search:
            query["$or"] = [
                {"order_number": {"$regex": search, "$options": "i"}},
                {"store_po": {"$regex": search, "$options": "i"}},
                {"customer_po": {"$regex": search, "$options": "i"}},
                {"client": {"$regex": search, "$options": "i"}},
                {"branding": {"$regex": search, "$options": "i"}},
                {"notes": {"$regex": search, "$options": "i"}}
            ]
        # Exclude 'comments' and 'activity_logs' from dashboard list to keep payload small.
        # These are fetched individually when opening the order details.
        projection = {"_id": 0, "comments": 0, "activity_logs": 0, "history": 0}
        orders_raw = await db.orders.find(query, projection).sort("created_at", -1).to_list(limit)
        
        # Safety loop to avoid serialization/merging crashes
        cleaned_orders = []
        for order in orders_raw:
            try:
                merged = _merge_custom_fields(order)
                cleaned_orders.append(merged)
            except Exception as e:
                logger.error(f"Error merging fields for order {order.get('order_id')}: {e}")
                cleaned_orders.append(order)
                
        _orders_cache[cache_key] = cleaned_orders
        return cleaned_orders

@router.get("/board-counts")
async def get_board_counts(request: Request):
    api_key = request.query_params.get("api_key")
    if api_key != MASTER_API_KEY:
        await require_auth(request)
    pipeline = [{"$group": {"_id": "$board", "count": {"$sum": 1}}}]
    results = await db.orders.aggregate(pipeline).to_list(1000)
    # Convert to simple key-value: {BOARD_NAME: COUNT}
    counts = {r["_id"]: r["count"] for r in results if r["_id"]}
    return counts

@router.get("/check-number")
async def check_order_number(request: Request, order_number: str = None):
    await require_auth(request)
    if not order_number or not order_number.strip():
        return {"exists": False}
    
    order_num = order_number.strip()
    # Try to find an ACTIVE duplicate first
    exists = await db.orders.find_one({"order_number": order_num, "board": {"$ne": "PAPELERA DE RECICLAJE"}})
    
    # If no active duplicate, check if one exists in the trash
    if not exists:
        exists = await db.orders.find_one({"order_number": order_num, "board": "PAPELERA DE RECICLAJE"})
        
    if not exists:
        return {"exists": False, "order": None, "in_trash": False}
        
    order_data = {k: v for k, v in exists.items() if k != "_id"}
    in_trash = order_data.get("board") == "PAPELERA DE RECICLAJE"
    return {
        "exists": True,
        "order": order_data,
        "in_trash": in_trash
    }

@router.get("/{order_id}")
async def get_order(order_id: str, request: Request):
    await require_auth(request)
    order = await db.orders.find_one({"order_id": order_id}, {"_id": 0})
    if not order:
        # Prioritize active orders if searching by order number
        order = await db.orders.find_one({"order_number": order_id, "board": {"$ne": "PAPELERA DE RECICLAJE"}}, {"_id": 0})
        if not order:
            # Fallback to trash if no active order found
            order = await db.orders.find_one({"order_number": order_id}, {"_id": 0})
    if not order:
        raise HTTPException(status_code=404, detail="Order not found")
    return _merge_custom_fields(order)

async def internal_create_order(order: OrderCreate, user: dict) -> dict:
    """Core logic for order creation, reusable by API and internal processes."""
    # Security: block duplicates only if existing order is NOT in the trash
    if order.order_number and order.order_number.strip():
        active_existing = await db.orders.find_one({
            "order_number": order.order_number.strip(),
            "board": {"$ne": "PAPELERA DE RECICLAJE"}
        })
        if active_existing:
            existing_board = active_existing.get("board", "")
            raise HTTPException(
                status_code=400,
                detail=f"La orden {order.order_number} ya existe en el tablero '{existing_board}'."
            )

    order_id = f"ord_{uuid.uuid4().hex[:12]}"
    order_data = order.model_dump(by_alias=True)
    # Merge extra fields to ensure they are at the root level in the DB
    extra = order.model_extra or {}
    order_data.update(extra)
    
    # CRITICAL: Prevent nested custom_fields from persisting
    if "custom_fields" in order_data:
        nested = order_data.pop("custom_fields")
        if isinstance(nested, dict):
            for k, v in nested.items():
                if k not in order_data:
                    order_data[k] = v
    
    # Safety: ensure board is NEVER null — default to SCHEDULING
    if not order_data.get("board"):
        logger.warning(f"Order created without a board, defaulting to SCHEDULING (order: {order_data.get('order_number')})")
        order_data["board"] = "SCHEDULING"
    order_doc = {**order_data, "order_id": order_id, "created_at": datetime.now(timezone.utc).isoformat(), "updated_at": datetime.now(timezone.utc).isoformat()}
    await db.orders.insert_one(order_doc)
    await log_activity(user, "create_order", {"order_id": order_id, "order_number": order.order_number})
    
    # Use in-memory doc for automations to avoid potential consistency delays or None issues
    created = {k: v for k, v in order_doc.items() if k != "_id"}
    try:
        await _run_automations("create", created, user)
    except Exception as e:
        logger.error(f"Error running automations after order creation: {e}")
        
    await _notify_all(user, "create", f"{user.get('name', 'Sistema')} creo orden {order.order_number}", order_id, order.order_number)
    await ws_manager.broadcast("order_change", {"action": "create", "boards": [order.board]})
    return created

@router.post("")
async def create_order(order: OrderCreate, request: Request):
    user = await require_auth(request)
    return await internal_create_order(order, user)

@router.put("/{order_id}")
async def update_order(order_id: str, order: OrderUpdate, request: Request):
    user = await require_auth(request)
    existing = await db.orders.find_one({"order_id": order_id}, {"_id": 0})
    if not existing:
        raise HTTPException(status_code=404, detail="Order not found")
    update_data = order.model_dump(exclude_unset=True, by_alias=True)
    # Merge extra fields provided in the update payload
    extra = order.model_extra or {}
    update_data.update(extra)
    
    # CRITICAL: Prevent nested custom_fields from persisting
    if "custom_fields" in update_data:
        nested = update_data.pop("custom_fields")
        if isinstance(nested, dict):
            for k, v in nested.items():
                # On updates, we always merge to ensure root-level visibility
                update_data[k] = v
    
    # Remove board=null check to allow clearing or moving via direct update if needed, 
    # but ensure it exists if requested.
    if "board" in update_data and update_data["board"] is None:
        # If explicitly clearing board, we might want to default to SCHEDULING or allow it?
        # Following the "flattening" philosophy, let's allow it but warn.
        logger.warning(f"Board being cleared for order {order_id}")
    update_data["updated_at"] = datetime.now(timezone.utc).isoformat()
    old_board = existing.get("board")
    new_board = update_data.get("board")
    await db.orders.update_one({"order_id": order_id}, {"$set": update_data})
    updated = await db.orders.find_one({"order_id": order_id}, {"_id": 0})
    changed_data = {k: v for k, v in update_data.items() if k != "updated_at"}
    prev_values = {k: existing.get(k) for k in changed_data}
    await log_activity(user, "update_order", {
        "order_id": order_id, "order_number": existing.get("order_number"), "changed_fields": list(changed_data.keys())
    }, previous_data={"order_id": order_id, "fields": prev_values})
    # Auto-create QC record when production_status changes to "NECESITA QC"
    old_status = existing.get("production_status", "")
    new_status = update_data.get("production_status", "")
    if new_status == "NECESITA QC" and old_status != "NECESITA QC":
        already_exists = await db.qc_records.find_one({"order_id": order_id, "auto_generated": True, "request_date": datetime.now(timezone.utc).date().isoformat()})
        if not already_exists:
            today = datetime.now(timezone.utc).date().isoformat()
            qc_doc = {
                "qc_id": f"qc_{__import__('uuid').uuid4().hex[:12]}",
                "order_id": order_id,
                "order_number": existing.get("order_number", ""),
                "client": existing.get("client", ""),
                "inspector": user.get("name", user.get("email", "")),
                "inspector_id": user.get("user_id", ""),
                "request_date": today,
                "inspection_date": today,
                "finding_type": "OTHER",
                "severity": "MINOR",
                "result": "PASS",
                "quantity_inspected": 0,
                "quantity_rejected": 0,
                "findings": "",
                "corrective_action": "",
                "quantity": existing.get("quantity", ""),
                "job_title_a": existing.get("job_title_a", ""),
                "auto_generated": True,
                "created_at": datetime.now(timezone.utc).isoformat(),
                "updated_at": datetime.now(timezone.utc).isoformat(),
            }
            await db.qc_records.insert_one(qc_doc)
            await log_activity(user, "auto_create_qc", {"order_id": order_id, "order_number": existing.get("order_number"), "reason": "NECESITA QC"})

    executed_automations = []
    if new_board and old_board != new_board:
        executed_automations += await _run_automations("move", updated, user, {"from_board": old_board, "to_board": new_board})
    else:
        executed_automations += await _run_automations("update", updated, user, {"changed_fields": list(update_data.keys())})
    changed_status_fields = [f for f in update_data if f not in ["updated_at", "board"] and existing.get(f) != update_data[f]]
    if changed_status_fields:
        executed_automations += await _run_automations("status_change", updated, user, {
            "changed_fields": changed_status_fields, "old_values": {f: existing.get(f) for f in changed_status_fields}
        })
    final_order = await db.orders.find_one({"order_id": order_id}, {"_id": 0})
    boards_affected = [old_board]
    if new_board and old_board != new_board:
        boards_affected.append(new_board)
    await ws_manager.broadcast("order_change", {"action": "update", "order_id": order_id, "boards": boards_affected})
    return {**(_merge_custom_fields(final_order or updated)), "_automations_executed": executed_automations}

@router.post("/{order_id}/move")
async def move_order(order_id: str, request: Request):
    user = await require_auth(request)
    body = await request.json()
    target_board = body.get("board")
    boards = await get_dynamic_boards()
    if target_board not in boards and target_board != "PAPELERA DE RECICLAJE":
        raise HTTPException(status_code=400, detail=f"Invalid board")
    existing = await db.orders.find_one({"order_id": order_id}, {"_id": 0})
    if not existing:
        raise HTTPException(status_code=404, detail="Order not found")
    if existing.get("locked_by_qc") and user.get("role") != "admin":
        raise HTTPException(status_code=403, detail="locked_by_qc")
    old_board = existing.get("board")
    await db.orders.update_one({"order_id": order_id}, {"$set": {"board": target_board, "updated_at": datetime.now(timezone.utc).isoformat()}})
    updated = await db.orders.find_one({"order_id": order_id}, {"_id": 0})
    await log_activity(user, "move_order", {"order_id": order_id, "order_number": existing.get("order_number"), "from_board": old_board, "to_board": target_board}, previous_data={"order_id": order_id, "fields": {"board": old_board}})
    executed_automations = await _run_automations("move", updated, user, {"from_board": old_board, "to_board": target_board})
    final_order = await db.orders.find_one({"order_id": order_id}, {"_id": 0})
    await _notify_all(user, "move", f"{user['name']} movio orden {existing.get('order_number', order_id)} de {old_board} a {target_board}", order_id, existing.get("order_number"))
    await ws_manager.broadcast("order_change", {"action": "move", "boards": [old_board, target_board]})
    return {**(_merge_custom_fields(final_order or updated)), "_automations_executed": executed_automations}

@router.delete("/{order_id}")
async def delete_order(order_id: str, request: Request):
    user = await require_auth(request)
    existing = await db.orders.find_one({"order_id": order_id}, {"_id": 0})
    if not existing:
        raise HTTPException(status_code=404, detail="Order not found")
    
    now = datetime.now(timezone.utc).isoformat()
    await db.orders.update_one(
        {"order_id": order_id}, 
        {"$set": {
            "board": "PAPELERA DE RECICLAJE", 
            "deleted_at": now,
            "updated_at": now
        }}
    )
    
    await log_activity(user, "delete_order", {"order_id": order_id, "order_number": existing.get("order_number")}, previous_data={"order_id": order_id, "fields": {"board": existing.get("board")}})
    await ws_manager.broadcast("order_change", {"action": "delete", "boards": [existing.get("board"), "PAPELERA DE RECICLAJE"]})
    return {"message": "Order moved to trash", "deleted_at": now}

@router.delete("/{order_id}/permanent")
async def permanent_delete_order(order_id: str, request: Request):
    user = await require_auth(request)
    
    # Debug log to see what ID we are receiving
    logger.info(f"Attempting permanent delete for order: {order_id}")
    
    # Robust lookup: check both order_id and _id if necessary
    existing = await db.orders.find_one({
        "$or": [
            {"order_id": order_id},
            {"id": order_id},
            {"order_number": order_id}
        ]
    }, {"_id": 0})
    
    if not existing:
        logger.error(f"Permanent delete failed: Order {order_id} not found in DB")
        raise HTTPException(status_code=404, detail="Order not found")
        
    # Get invoice reference before deleting
    invoice_ref = existing.get("invoice_ref")
    
    # 1. Delete the order
    await db.orders.delete_one({"order_id": order_id})
    
    # 2. CASCADE DELETE: Remove the linked invoice if it exists
    if invoice_ref:
        inv_result = await db.invoices.delete_one({"invoice_id": invoice_ref})
        if inv_result.deleted_count > 0:
            logger.info(f"Cascade delete: Invoice {invoice_ref} removed because order {order_id} was permanently deleted")
            await ws_manager.broadcast("invoice_change", {"action": "delete", "invoice_id": invoice_ref})

    # 3. CASCADE DELETE: Remove linked Work Orders
    wo_result = await db.work_orders.delete_many({"source_invoice_id": invoice_ref} if invoice_ref else {"order_id": order_id})
    if wo_result.deleted_count > 0:
        await ws_manager.broadcast("work_order_change", {"action": "delete", "order_id": order_id})

    await log_activity(user, "permanent_delete_order", {"order_id": order_id, "order_number": existing.get("order_number")})
    return {"message": "Order and linked invoice deleted permanently"}

@router.post("/bulk-move")
async def bulk_move_orders(request: Request):
    user = await require_auth(request)
    body = await request.json()
    order_ids = body.get("order_ids", [])
    target_board = body.get("board")
    if not order_ids or not target_board:
        raise HTTPException(status_code=400, detail="order_ids and board required")
    boards = await get_dynamic_boards()
    if target_board not in boards and target_board != "PAPELERA DE RECICLAJE":
        raise HTTPException(status_code=400, detail="Invalid board")
    original_orders = await db.orders.find({"order_id": {"$in": order_ids}}, {"_id": 0, "order_id": 1, "board": 1, "order_number": 1, "locked_by_qc": 1}).to_list(len(order_ids))
    original_boards = {o["order_id"]: o["board"] for o in original_orders}

    # Block non-admins if any order is locked by QC
    if user.get("role") != "admin":
        locked = [o.get("order_number", o["order_id"]) for o in original_orders if o.get("locked_by_qc")]
        if locked:
            raise HTTPException(status_code=403, detail=f"locked_by_qc:{','.join(locked)}")

    result = await db.orders.update_many({"order_id": {"$in": order_ids}}, {"$set": {"board": target_board, "updated_at": datetime.now(timezone.utc).isoformat()}})
    await log_activity(user, "bulk_move_orders", {"order_count": len(order_ids), "target_board": target_board}, previous_data={"order_ids": order_ids, "original_boards": original_boards})
    
    executed_automations = []
    updated_orders = await db.orders.find({"order_id": {"$in": order_ids}}, {"_id": 0}).to_list(len(order_ids))
    for order in updated_orders:
        old_board = original_boards.get(order["order_id"])
        autos = await _run_automations("move", order, user, {"from_board": old_board, "to_board": target_board})
        executed_automations.extend(autos)

    affected_boards = list(set(original_boards.values())) + [target_board]
    await _notify_all(user, "move", f"{user['name']} movio {len(order_ids)} ordenes a {target_board}", None, None)
    await ws_manager.broadcast("order_change", {"action": "bulk_move", "boards": affected_boards})
    return {"modified_count": result.modified_count, "_automations_executed": executed_automations}

@router.post("/export")
async def export_orders(request: Request):
    user = await require_auth(request)
    body = await request.json()
    order_ids = body.get("order_ids", [])
    if not order_ids:
        raise HTTPException(status_code=400, detail="order_ids required")
    orders = await db.orders.find({"order_id": {"$in": order_ids}}, {"_id": 0}).to_list(len(order_ids))
    await log_activity(user, "export_orders", {"order_count": len(orders)})
    return {"orders": [_merge_custom_fields(order) for order in orders]}

# ==================== LINKS ====================

@router.get("/{order_id}/links")
async def get_order_links(order_id: str, request: Request):
    await require_auth(request)
    order = await db.orders.find_one({"order_id": order_id}, {"_id": 0})
    if not order:
        raise HTTPException(status_code=404, detail="Order not found")
    return order.get("links", [])

@router.post("/{order_id}/links")
async def add_order_link(order_id: str, request: Request):
    user = await require_auth(request)
    body = await request.json()
    url = body.get("url", "").strip()
    description = body.get("description", "").strip()
    if not url:
        raise HTTPException(status_code=400, detail="URL required")
    link = {"url": url, "description": description, "created_at": datetime.now(timezone.utc).isoformat(), "added_by": user["name"]}
    await db.orders.update_one({"order_id": order_id}, {"$push": {"links": link}})
    await ws_manager.broadcast("order_change", {"action": "add_link", "order_id": order_id})
    return link

@router.delete("/{order_id}/links/{link_index}")
async def delete_order_link(order_id: str, link_index: int, request: Request):
    await require_auth(request)
    order = await db.orders.find_one({"order_id": order_id}, {"_id": 0})
    if not order:
        raise HTTPException(status_code=404, detail="Order not found")
    links = order.get("links", [])
    if link_index < 0 or link_index >= len(links):
        raise HTTPException(status_code=400, detail="Invalid link index")
    links.pop(link_index)
    await db.orders.update_one({"order_id": order_id}, {"$set": {"links": links}})
    await ws_manager.broadcast("order_change", {"action": "delete_link", "order_id": order_id})
    return {"message": "Link deleted"}

# ==================== COMMENTS ====================

@router.post("/{order_id}/comments/{comment_id}/pin")
async def pin_comment(order_id: str, comment_id: str, request: Request):
    """Toggle the pinned state of a comment. Only admins can pin."""
    user = await require_auth(request)
    if user.get("role") != "admin":
        raise HTTPException(status_code=403, detail="Solo los administradores pueden anclar comentarios")
    comment = await db.comments.find_one({"comment_id": comment_id, "order_id": order_id})
    if not comment:
        raise HTTPException(status_code=404, detail="Comment not found")
    currently_pinned = comment.get("pinned", False)
    new_pinned = not currently_pinned
    update = {"pinned": new_pinned}
    if new_pinned:
        update["pinned_at"] = datetime.now(timezone.utc).isoformat()
        update["pinned_by"] = user["name"]
    else:
        update["pinned_at"] = None
        update["pinned_by"] = None
    await db.comments.update_one({"comment_id": comment_id}, {"$set": update})
    await ws_manager.broadcast("order_change", {"action": "pin_comment", "order_id": order_id})
    return {"pinned": new_pinned, "action": "pinned" if new_pinned else "unpinned"}

@router.post("/{order_id}/comments/{comment_id}/react")
async def react_to_comment(order_id: str, comment_id: str, request: Request):
    user = await require_auth(request)
    body = await request.json()
    emoji = body.get("emoji")
    if not emoji:
        raise HTTPException(status_code=400, detail="Emoji required")
    
    user_id = user["user_id"]
    logger.info(f"Reaction toggle: user {user_id}, comment {comment_id}, emoji {emoji}")
    
    comment = await db.comments.find_one({"comment_id": comment_id, "order_id": order_id})
    if not comment:
        logger.warning(f"Comment {comment_id} not found for order {order_id}")
        raise HTTPException(status_code=404, detail="Comment not found")
    
    # Ensure reactions exists
    reactions = comment.get("reactions")
    if not isinstance(reactions, dict):
        reactions = {}
    
    user_id_str = str(user_id)
    
    # Toggle reaction
    current_emoji_users = reactions.get(emoji, [])
    if not isinstance(current_emoji_users, list):
        current_emoji_users = []
        
    if user_id_str in current_emoji_users:
        current_emoji_users.remove(user_id_str)
        action = "removed"
    else:
        current_emoji_users.append(user_id_str)
        action = "added"
    
    if not current_emoji_users:
        reactions.pop(emoji, None)
    else:
        reactions[emoji] = current_emoji_users
    
    await db.comments.update_one({"comment_id": comment_id}, {"$set": {"reactions": reactions}})
    await ws_manager.broadcast("order_change", {"action": "comment_reaction", "order_id": order_id})
    logger.info(f"Reaction {action} for {comment_id}. Current reactions: {list(reactions.keys())}")
    return {"reactions": reactions, "action": action}

@router.get("/{order_id}/comments")
async def get_comments(order_id: str, request: Request):
    await require_auth(request)
    comments = await db.comments.find({"order_id": order_id}, {"_id": 0}).sort("created_at", 1).to_list(500)
    return comments

@router.post("/{order_id}/comments")
async def create_comment(order_id: str, comment: CommentCreate, request: Request):
    user = await require_auth(request)
    order = await db.orders.find_one({"order_id": order_id}, {"_id": 0})
    if not order:
        raise HTTPException(status_code=404, detail="Order not found")
    comment_id = f"comment_{uuid.uuid4().hex[:12]}"
    # Detect @mentions by matching against real user names/emails
    all_users = await db.users.find({}, {"_id": 0, "email": 1, "user_id": 1, "name": 1}).to_list(200)
    current_user_id = user.get("user_id", user.get("email"))
    content_lower = comment.content.lower()
    mentioned_users = []
    mentions = []
    for u in all_users:
        uid = u.get("user_id", u.get("email"))
        uname = (u.get("name") or "").strip()
        uemail = (u.get("email") or "").strip()
        if uname and f"@{uname.lower()}" in content_lower:
            mentioned_users.append(u)
            mentions.append(uname)
        elif uemail and f"@{uemail.lower()}" in content_lower:
            mentioned_users.append(u)
            mentions.append(uemail)
        elif uemail and f"@{uemail.split('@')[0].lower()}" in content_lower:
            mentioned_users.append(u)
            mentions.append(uemail.split('@')[0])
    comment_doc = {
        "comment_id": comment_id, "order_id": order_id, "content": comment.content,
        "parent_id": comment.parent_id, "user_id": user["user_id"],
        "user_name": user["name"], "user_picture": user.get("picture"),
        "mentions": mentions,
        "created_at": datetime.now(timezone.utc).isoformat()
    }
    await db.comments.insert_one(comment_doc)
    await log_activity(user, "add_comment", {"order_id": order_id, "order_number": order.get("order_number"), "comment_id": comment_id})
    notif_docs = []
    if mentioned_users:
        for u in mentioned_users:
            uid = u.get("user_id", u.get("email"))
            notif_docs.append({
                "notification_id": f"notif_{uuid.uuid4().hex[:12]}", "user_id": uid, "type": "mention",
                "message": f"{user['name']} te menciono en orden {order.get('order_number', order_id)}",
                "order_id": order_id, "order_number": order.get("order_number"),
                "comment_id": comment_id,
                "sender_name": user.get("name"),
                "sender_picture": user.get("picture"),
                "read": False, "created_at": datetime.now(timezone.utc).isoformat()
            })
    if notif_docs:
        await db.notifications.insert_many(notif_docs)
    
    await ws_manager.broadcast("order_change", {"action": "add_comment", "order_id": order_id})
    return {**{k: v for k, v in comment_doc.items() if k not in ["_id", "reactions"]}, "reactions": {}}

@router.put("/{order_id}/comments/{comment_id}")
async def update_comment(order_id: str, comment_id: str, request: Request):
    user = await require_auth(request)
    body = await request.json()
    content = body.get("content", "").strip()
    if not content:
        raise HTTPException(status_code=400, detail="Content required")
    comment = await db.comments.find_one({"comment_id": comment_id, "order_id": order_id}, {"_id": 0})
    if not comment:
        raise HTTPException(status_code=404, detail="Comment not found")
    if comment.get("user_id") != user["user_id"] and user.get("role") != "admin":
        raise HTTPException(status_code=403, detail="Not allowed to edit this comment")
    await db.comments.update_one(
        {"comment_id": comment_id},
        {"$set": {"content": content, "edited_at": datetime.now(timezone.utc).isoformat()}}
    )
    await ws_manager.broadcast("order_change", {"action": "update_comment", "order_id": order_id})
    updated = await db.comments.find_one({"comment_id": comment_id}, {"_id": 0})
    return updated

@router.delete("/{order_id}/comments/{comment_id}")
async def delete_comment(order_id: str, comment_id: str, request: Request):
    user = await require_auth(request)
    comment = await db.comments.find_one({"comment_id": comment_id, "order_id": order_id}, {"_id": 0})
    if not comment:
        raise HTTPException(status_code=404, detail="Comment not found")
    if comment.get("user_id") != user["user_id"] and user.get("role") != "admin":
        raise HTTPException(status_code=403, detail="Not allowed to delete this comment")
    await db.comments.delete_one({"comment_id": comment_id})
    await ws_manager.broadcast("order_change", {"action": "delete_comment", "order_id": order_id})
    return {"message": "Comment deleted"}


# ==================== FILE UPLOAD (stored in MongoDB) ====================

@router.post("/{order_id}/images")
async def upload_attachment(order_id: str, request: Request):
    """Upload an attachment (image, pdf, excel, etc.) for an order."""
    user = await require_auth(request)
    body = await request.json()
    file_data = body.get("image_data") or body.get("file_data")
    filename = body.get("filename", f"file_{uuid.uuid4().hex[:8]}")
    if not file_data:
        raise HTTPException(status_code=400, detail="file_data required")
    order = await db.orders.find_one({"order_id": order_id}, {"_id": 0})
    if not order:
        raise HTTPException(status_code=404, detail="Order not found")
    try:
        # Extract pure base64 (remove data:...;base64, prefix)
        raw_b64 = file_data
        content_type = "application/octet-stream"
        if "," in raw_b64:
            header = raw_b64.split(",")[0]
            if ":" in header and ";" in header:
                content_type = header.split(":")[1].split(";")[0]
            raw_b64 = raw_b64.split(",")[1]
        # Validate it decodes
        file_bytes = base64.b64decode(raw_b64)
        
        # Save to disk instead of MongoDB data field
        unique_suffix = uuid.uuid4().hex[:8]
        storage_key = f"{order_id}_{unique_suffix}_{filename}"
        
        file_path = UPLOADS_DIR / storage_key
        with open(file_path, "wb") as f:
            f.write(file_bytes)

        # Store metadata only in MongoDB
        await db.file_uploads.insert_one({
            "storage_key": storage_key, "content_type": content_type,
            "order_id": order_id, "filename": filename, "uploaded_at": datetime.now(timezone.utc).isoformat()
        })
        
        backend_url = os.environ.get("BACKEND_PUBLIC_URL", "")
        file_url = f"{backend_url}/api/uploads/{storage_key}"
        # Update order's generic attachments/images list
        await db.orders.update_one({"order_id": order_id}, {"$push": {"images": {"filename": filename, "url": file_url, "uploaded_at": datetime.now(timezone.utc).isoformat()}}})
        await log_activity(user, "upload_attachment", {"order_id": order_id, "filename": filename, "type": content_type})
        return {"url": file_url, "filename": filename, "storage_key": storage_key, "content_type": content_type}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Upload failed: {str(e)}")

# ==================== EXPORT ORDERS WITH COMMENTS & IMAGES ====================

    return {"total": len(result), "orders": result}

@router.post("/export-pdf")
async def export_orders_pdf(request: Request):
    """Export selected orders with their comments and images to a professional PDF."""
    user = await require_auth(request)
    body = await request.json()
    order_ids = body.get("order_ids", [])
    if not order_ids:
        raise HTTPException(status_code=400, detail="No order_ids provided")

    output = io.BytesIO()
    doc = SimpleDocTemplate(output, pagesize=letter, leftMargin=50, rightMargin=50, topMargin=50, bottomMargin=50)
    styles = getSampleStyleSheet()
    
    # Custom styles
    title_style = styles['Title']
    h1_style = styles['Heading1']
    h2_style = styles['Heading2']
    normal_style = styles['Normal']
    
    comment_style = ParagraphStyle(
        'Comment',
        parent=styles['Normal'],
        fontSize=9,
        leading=11,
        leftIndent=20,
        spaceBefore=5,
        spaceAfter=5,
        textColor=colors.HexColor('#444444')
    )

    caption_style = ParagraphStyle(
        'Caption',
        parent=styles['Italic'],
        fontSize=7,
        leading=8,
        alignment=1, # Center
        textColor=colors.grey
    )

    elements = []
    
    # Add Logo/Header if exists? For now just text
    elements.append(Paragraph("MOS SYSTEM - REPORTE DE ÓRDENES", title_style))
    elements.append(Paragraph(f"Generado el: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}", normal_style))
    elements.append(Paragraph(f"Por: {user.get('name')}", normal_style))
    elements.append(Spacer(1, 0.5 * inch))

    def format_links(text):
        if not text or not isinstance(text, str): return text
        # Escape XML special chars first to prevent ReportLab crashes
        text = text.replace('&', '&amp;').replace('<', '&lt;').replace('>', '&gt;')
        url_pattern = r'(https?://[^\s<>"]+|www\.[^\s<>"]+)'
        def replace_url(match):
            url = match.group(0)
            href = url if url.startswith('http') else f'http://{url}'
            return f'<font color="blue"><u><a href="{href}">{url}</a></u></font>'
        return re.sub(url_pattern, replace_url, text)

    for idx, oid in enumerate(order_ids):
        order = await db.orders.find_one({"order_id": oid}, {"_id": 0})
        if not order:
            continue
            
        if idx > 0:
            elements.append(PageBreak())

        elements.append(Paragraph(f"Orden: {order.get('order_number', 'N/A')}", h1_style))
        
        # Summary Table - Values wrapped in Paragraph for link support
        order_data = [
            ["ID Interno", Paragraph(order.get("order_id", ""), normal_style)],
            ["PO Cliente", Paragraph(order.get("customer_po", ""), normal_style)],
            ["Store PO", Paragraph(order.get("store_po", ""), normal_style)],
            ["Cliente", Paragraph(order.get("client", ""), normal_style)],
            ["Branding", Paragraph(order.get("branding", ""), normal_style)],
            ["Prioridad", Paragraph(order.get("priority", ""), normal_style)],
            ["Cantidad", Paragraph(str(order.get("quantity", 0)), normal_style)],
            ["Fecha Entrega", Paragraph(order.get("due_date", ""), normal_style)],
            ["Estado Prod.", Paragraph(order.get("production_status", ""), normal_style)],
            ["Tablero Actual", Paragraph(order.get("board", ""), normal_style)]
        ]
        
        # Add non-standard fields to the table
        standard_keys = {
            "order_id", "order_number", "customer_po", "store_po", "client", "branding", 
            "priority", "quantity", "due_date", "production_status", "board", "created_at", 
            "updated_at", "images", "links", "comments", "cancel_date", "_id", "sizes", "style",
            "custom_fields"
        }
        for k, v in order.items():
            if k not in standard_keys and v is not None:
                val_str = str(v)
                order_data.append([f"Custom: {k}", Paragraph(format_links(val_str), normal_style)])

        t = Table(order_data, colWidths=[1.5 * inch, 4 * inch])
        t.setStyle(TableStyle([
            ('BACKGROUND', (0, 0), (0, -1), colors.HexColor('#f0f0f0')),
            ('GRID', (0, 0), (-1, -1), 0.5, colors.grey),
            ('FONTNAME', (0, 0), (0, -1), 'Helvetica-Bold'),
            ('VALIGN', (0, 0), (-1, -1), 'MIDDLE'),
            ('PADDING', (0, 0), (-1, -1), 6),
        ]))
        elements.append(t)
        elements.append(Spacer(1, 0.3 * inch))        # Comments
        comments = await db.comments.find({"order_id": oid}, {"_id": 0}).sort("created_at", 1).to_list(100)
        if comments:
            elements.append(Paragraph("Comentarios", h2_style))
            for c in comments:
                ts = c.get("created_at", "")[:16].replace("T", " ")
                author = c.get("user_name", "Usuario")
                text = c.get("content", "")
                # Compact: Author and text in one paragraph
                elements.append(Paragraph(f"<b>{author}</b> <font color='grey' size='8'>({ts})</font>: {text}", comment_style))
            elements.append(Spacer(1, 0.2 * inch))

        # Images - Optimized to 2 per row
        image_docs = await db.file_uploads.find({"order_id": oid}, {"_id": 0}).to_list(100)
        if image_docs:
            elements.append(Paragraph("Imágenes Adjuntas", h2_style))
            img_grid = []
            current_row = []
            
            for img_doc in image_docs:
                try:
                    img_data = img_doc.get("data")
                    if not img_data: continue
                    
                    img_bytes = base64.b64decode(img_data)
                    img_io = io.BytesIO(img_bytes)
                    img = Image(img_io)
                    
                    # Resize for 2nd column grid
                    max_w = 2.6 * inch
                    iW, iH = img.imageWidth, img.imageHeight
                    aspect = iH / float(iW)
                    img.drawWidth = max_w
                    img.drawHeight = max_w * aspect
                    
                    # Wrap image and caption in a list for the table cell
                    cell_content = [img, Paragraph(img_doc.get("filename", "imagen")[:30], caption_style)]
                    current_row.append(cell_content)
                    
                    if len(current_row) == 2:
                        img_grid.append(current_row)
                        current_row = []
                except: continue
                
            if current_row:
                current_row.append("") # padding
                img_grid.append(current_row)
                
            if img_grid:
                img_table = Table(img_grid, colWidths=[2.8 * inch, 2.8 * inch])
                img_table.setStyle(TableStyle([
                    ('VALIGN', (0,0), (-1,-1), 'TOP'),
                    ('ALIGN', (0,0), (-1,-1), 'CENTER'),
                    ('BOTTOMPADDING', (0,0), (-1,-1), 12),
                ]))
                elements.append(img_table)

    doc.build(elements)
    output.seek(0)
    data_b64 = base64.b64encode(output.read()).decode()
    
    await log_activity(user, "export_orders_pdf", {"order_count": len(order_ids)})
    
    return {
        "filename": f"reporte_ordenes_{datetime.now().strftime('%Y%m%d_%H%M%S')}.pdf",
        "data": data_b64,
        "content_type": "application/pdf"
    }

@router.post("/export-complete")
async def export_orders_complete(request: Request):
    """Export selected orders with their comments and images (base64)."""
    user = await require_auth(request)
    body = await request.json()
    order_ids = body.get("order_ids", [])
    include_comments = body.get("include_comments", True)
    include_images = body.get("include_images", True)
    if not order_ids:
        raise HTTPException(status_code=400, detail="order_ids required")

    result = []
    for oid in order_ids:
        order = await db.orders.find_one({"order_id": oid}, {"_id": 0})
        if not order:
            continue
        entry = {**order}
        if include_comments:
            comments = await db.comments.find({"order_id": oid}, {"_id": 0}).sort("created_at", 1).to_list(500)
            entry["_comments"] = comments
        if include_images:
            # Get image files from file_uploads collection
            image_docs = []
            async for doc in db.file_uploads.find({"order_id": oid}, {"_id": 0}):
                image_docs.append(doc)
            entry["_image_files"] = image_docs
        result.append(entry)

    return {"total": len(result), "orders": result}

@router.post("/import-complete")
async def import_orders_complete(request: Request):
    """Import orders with their comments and images."""
    user = await require_auth(request)
    if user.get("role") != "admin":
        raise HTTPException(status_code=403, detail="Admin only")
    body = await request.json()
    orders_data = body.get("orders", [])
    update_existing = body.get("update_existing", False)
    stats = {"orders": 0, "comments": 0, "images": 0, "skipped_orders": 0, "updated_orders": 0}

    for entry in orders_data:
        oid = entry.get("order_id")
        if not oid:
            continue
        comments = entry.pop("_comments", [])
        image_files = entry.pop("_image_files", [])

        # Cleanup entry before sync/insert
        clean_entry = {k: v for k, v in entry.items() if k != "_id"}

        # Upsert order logic
        existing = await db.orders.find_one({"order_id": oid})
        if existing:
            if update_existing:
                # Sync all fields except protected ones to ensure flat custom fields are included
                exclude_fields = {"_id", "order_id", "created_at", "updated_at", "_comments", "_image_files"}
                update_doc = {k: v for k, v in clean_entry.items() if k not in exclude_fields}

                update_doc["updated_at"] = datetime.now(timezone.utc).isoformat()
                
                await db.orders.update_one({"order_id": oid}, {"$set": update_doc})
                stats["updated_orders"] += 1
            else:
                stats["skipped_orders"] += 1
        else:
            await db.orders.insert_one(clean_entry)
            stats["orders"] += 1

        # Import comments
        for c in comments:
            cid = c.get("comment_id")
            if cid:
                exists = await db.comments.find_one({"comment_id": cid})
                if not exists:
                    await db.comments.insert_one({k: v for k, v in c.items() if k != "_id"})
                    stats["comments"] += 1

        # Import images
        for img in image_files:
            key = img.get("storage_key")
            if key:
                exists = await db.file_uploads.find_one({"storage_key": key})
                if not exists:
                    await db.file_uploads.insert_one({k: v for k, v in img.items() if k != "_id"})
                    stats["images"] += 1

    return stats

@router.post("/import-excel")
async def import_orders_excel(
    request: Request,
    file: UploadFile = File(...),
    update_existing: bool = False,
    column_mapping: Optional[str] = Form(None)
):
    """Import orders from an Excel file (.xlsx, .xls) with optional column mapping."""
    user = await require_auth(request)
    if user.get("role") != "admin":
        raise HTTPException(status_code=403, detail="Solo los administradores pueden importar Excel")

    try:
        content = await file.read()
        df = pd.read_excel(io.BytesIO(content))
        
        # Definir campos conocidos (base) para separar de los personalizados
        KNOWN_FIELDS = {
            "order_number", "customer_po", "store_po", "client", "branding", 
            "priority", "quantity", "due_date", "cancel_date", "notes", "color",
            "design_#", "board", "blank_status", "production_status",
            "trim_status", "trim_box", "sample", "artwork_status", "betty_column",
            "job_title_a", "job_title_b", "shipping", "final_bill"
        }

        # User defined mapping (if provided)
        user_mapping = {}
        if column_mapping:
            try:
                user_mapping = json.loads(column_mapping)
                # No pasamos a minúsculas las llaves (internal_col) para preservar la integridad de campos personalizados
            except Exception as e:
                logger.error(f"Error parsing column_mapping: {e}")

        # Default mapping from common names to internal field names
        default_mapping = {
            "order #": "order_number",
            "order_number": "order_number",
            "order number": "order_number",
            "po #": "customer_po",
            "po": "customer_po",
            "customer po": "customer_po",
            "store po": "store_po",
            "store #": "store_po",
            "client": "client",
            "branding": "branding",
            "priority": "priority",
            "qty": "quantity",
            "quantity": "quantity",
            "notes": "notes",
            "color": "color",
            "due date": "due_date",
            "cancel date": "cancel_date",
            "design #": "design_#",
            "design_#": "design_#",
            "board": "board"
        }

        # Normalize Excel columns for matching (lowercase)
        excel_cols_lower = {str(c).strip().lower(): str(c) for c in df.columns}
        
        # Build actual mapping: Excel Column Name (original) -> Internal Field Key
        actual_mapping = {}
        
        # 1. Process user defined mapping
        for internal_key, excel_col_name in user_mapping.items():
            if not excel_col_name:
                continue
            # Buscamos el nombre original de la columna en el Excel (ignorando mayúsculas en el match)
            match_name = excel_cols_lower.get(str(excel_col_name).strip().lower())
            if match_name:
                actual_mapping[match_name] = internal_key

        # 2. Fill missing with defaults if they exist in Excel
        for lower_name, internal_key in default_mapping.items():
            if internal_key not in actual_mapping.values():
                match_name = excel_cols_lower.get(lower_name)
                if match_name:
                    actual_mapping[match_name] = internal_key

        logger.info(f"Excel Import Mapping: {actual_mapping}")

        # Final check: at least order_number must be mapped
        if not any(v == "order_number" for v in actual_mapping.values()):
            raise HTTPException(status_code=400, detail="El archivo Excel debe contener una columna para el número de orden (ej: 'Order #') o debe haber sido mapeada.")

        stats = {"total_rows": len(df), "created": 0, "updated": 0, "skipped": 0, "errors": 0}
        
        for index, row in df.iterrows():
            try:
                # Build order data from row
                order_data = {}
                
                for excel_col, internal_key in actual_mapping.items():
                    val = row[excel_col]
                    
                    # Handle nulls
                    if pd.isna(val) or str(val).strip().lower() == "nan":
                        val = None
                    
                    # Handle date conversion to YYYY-MM-DD
                    if internal_key in ["due_date", "cancel_date", "final_bill"] and val:
                        if hasattr(val, "strftime"):
                            val = val.strftime("%Y-%m-%d")
                        elif isinstance(val, str):
                            # Try to clean up string dates
                            val = val.split(' ')[0]

                    # Map to correct structure (FLATTENED)
                    if internal_key == "quantity":
                        try:
                            order_data["quantity"] = int(float(val)) if val is not None else 0
                        except:
                            order_data["quantity"] = 0
                    elif internal_key == "order_number":
                        # CRITICAL: Handle float order numbers (e.g., 101.0 -> "101")
                        if val is not None:
                            try:
                                f_val = float(val)
                                if f_val == int(f_val):
                                    order_data["order_number"] = str(int(f_val))
                                else:
                                    order_data["order_number"] = str(val).strip()
                            except:
                                order_data["order_number"] = str(val).strip()
                        else:
                            order_data["order_number"] = None
                    else:
                        order_data[internal_key] = str(val).strip() if val is not None else None

                # 3. Add ALL other columns as custom fields at root (Dynamic detection)
                excluded_cols = set(actual_mapping.keys())
                for col in df.columns:
                    if col not in excluded_cols:
                        val = row[col]
                        if not pd.isna(val) and str(val).strip().lower() != "nan":
                            clean_key = str(col).strip().replace(" ", "_").lower()
                            if clean_key not in order_data:
                                order_data[clean_key] = str(val).strip()

                order_num = order_data.get("order_number")
                if not order_num or not str(order_num).strip():
                    stats["skipped"] += 1
                    continue

                order_num = str(order_num).strip()

                # Check if it exists
                existing = await db.orders.find_one({"order_number": order_num})
                
                if existing:
                    if update_existing:
                        # Update order
                        oid = existing["order_id"]
                        order_data["updated_at"] = datetime.now(timezone.utc).isoformat()
                        await db.orders.update_one({"order_id": oid}, {"$set": order_data})
                        stats["updated"] += 1
                    else:
                        stats["skipped"] += 1
                else:
                    # Create new order
                    order_id = f"ord_{uuid.uuid4().hex[:12]}"
                    if not order_data.get("board"):
                        order_data["board"] = "SCHEDULING"
                    
                    full_doc = {
                        **order_data,
                        "order_id": order_id,
                        "created_at": datetime.now(timezone.utc).isoformat(),
                        "updated_at": datetime.now(timezone.utc).isoformat()
                    }
                    await db.orders.insert_one(full_doc)
                    stats["created"] += 1
                    await log_activity(user, "create_order_excel", {"order_id": order_id, "order_number": order_num})

            except Exception as e:
                logger.error(f"Error importing row {index} in excel: {e}")
                stats["errors"] += 1

        # Broadcast sync
        if stats["created"] > 0 or stats["updated"] > 0:
            await ws_manager.broadcast("order_change", {"action": "excel_import"})
            await _notify_all(user, "import", f"{user['name']} importó {stats['created']} órdenes nuevas y actualizó {stats['updated']}")

        return stats

    except Exception as e:
        logger.error(f"Excel import error: {e}")
        if isinstance(e, HTTPException):
            raise e
        raise HTTPException(status_code=500, detail=f"Error al procesar el archivo Excel: {str(e)}")
