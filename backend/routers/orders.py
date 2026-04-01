"""Orders routes: CRUD, comments, images, bulk-move, export."""
from fastapi import APIRouter, HTTPException, Request
from deps import db, require_auth, require_admin, log_activity, OrderCreate, OrderUpdate, CommentCreate, BOARDS, get_dynamic_boards, UPLOADS_DIR, logger
from ws_manager import ws_manager
from datetime import datetime, timezone
import uuid, base64, os

router = APIRouter()

# Helper to create notifications for all users except the actor
async def _notify_all(actor, notif_type, message, order_id=None, order_number=None):
    all_users = await db.users.find({}, {"_id": 0, "user_id": 1}).to_list(200)
    actor_id = actor.get("user_id", actor.get("email"))
    docs = []
    for u in all_users:
        uid = u.get("user_id")
        if uid and uid != actor_id:
            docs.append({
                "notification_id": f"notif_{uuid.uuid4().hex[:12]}", "user_id": uid,
                "type": notif_type, "message": message,
                "order_id": order_id, "order_number": order_number,
                "read": False, "created_at": datetime.now(timezone.utc).isoformat()
            })
    if docs:
        await db.notifications.insert_many(docs)

# Lazy import to avoid circular - automations engine is in its own file
async def _run_automations(trigger_type, order, user, context=None):
    from routers.automations import run_automations
    return await run_automations(trigger_type, order, user, context)

@router.get("/api/orders")
async def get_orders(request: Request, board: str = None, search: str = None):
    await require_auth(request)
    query = {}
    if board == "MASTER":
        # Exclude trash AND ghost orders (null/missing board) from MASTER view
        query["board"] = {"$nin": ["PAPELERA DE RECICLAJE", None]}
        query["$expr"] = {"$ne": [{"$type": "$board"}, "missing"]}
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
    orders = await db.orders.find(query, {"_id": 0}).sort("created_at", -1).to_list(1000)
    return orders

@router.get("/api/orders/board-counts")
async def get_board_counts(request: Request):
    await require_auth(request)
    pipeline = [{"$group": {"_id": "$board", "count": {"$sum": 1}}}]
    results = await db.orders.aggregate(pipeline).to_list(1000)
    # Convert to simple key-value: {BOARD_NAME: COUNT}
    counts = {r["_id"]: r["count"] for r in results if r["_id"]}
    return counts

@router.get("/api/orders/check-number")
async def check_order_number(request: Request, order_number: str = None):
    await require_auth(request)
    if not order_number or not order_number.strip():
        return {"exists": False}
    exists = await db.orders.find_one({"order_number": order_number.strip()})
    return {"exists": bool(exists)}

@router.get("/api/orders/{order_id}")
async def get_order(order_id: str, request: Request):
    await require_auth(request)
    order = await db.orders.find_one({"order_id": order_id}, {"_id": 0})
    if not order:
        order = await db.orders.find_one({"order_number": order_id}, {"_id": 0})
    if not order:
        raise HTTPException(status_code=404, detail="Order not found")
    return order

@router.post("/api/orders")
async def create_order(order: OrderCreate, request: Request):
    user = await require_auth(request)
    order_id = f"ord_{uuid.uuid4().hex[:12]}"
    order_data = order.model_dump()
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
        
    await _notify_all(user, "create", f"{user['name']} creo orden {order.order_number}", order_id, order.order_number)
    await ws_manager.broadcast("order_change", {"action": "create", "boards": [order.board]})
    return created

@router.put("/api/orders/{order_id}")
async def update_order(order_id: str, order: OrderUpdate, request: Request):
    user = await require_auth(request)
    existing = await db.orders.find_one({"order_id": order_id}, {"_id": 0})
    if not existing:
        raise HTTPException(status_code=404, detail="Order not found")
    update_data = {k: v for k, v in order.model_dump(exclude_unset=True).items() if v is not None}
    # Safety: if board is explicitly set to empty/null, reject it
    if "board" in update_data and not update_data["board"]:
        logger.warning(f"Attempt to set board=null on order {order_id}, ignoring board field")
        del update_data["board"]
    extra = order.model_extra or {}
    update_data.update(extra)
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
    return {**(final_order or updated), "_automations_executed": executed_automations}

@router.post("/api/orders/{order_id}/move")
async def move_order(order_id: str, request: Request):
    user = await require_auth(request)
    body = await request.json()
    target_board = body.get("board")
    boards = await get_dynamic_boards()
    if target_board not in boards:
        raise HTTPException(status_code=400, detail=f"Invalid board")
    existing = await db.orders.find_one({"order_id": order_id}, {"_id": 0})
    if not existing:
        raise HTTPException(status_code=404, detail="Order not found")
    old_board = existing.get("board")
    await db.orders.update_one({"order_id": order_id}, {"$set": {"board": target_board, "updated_at": datetime.now(timezone.utc).isoformat()}})
    updated = await db.orders.find_one({"order_id": order_id}, {"_id": 0})
    await log_activity(user, "move_order", {"order_id": order_id, "order_number": existing.get("order_number"), "from_board": old_board, "to_board": target_board}, previous_data={"order_id": order_id, "fields": {"board": old_board}})
    await _run_automations("move", updated, user, {"from_board": old_board, "to_board": target_board})
    await _notify_all(user, "move", f"{user['name']} movio orden {existing.get('order_number', order_id)} de {old_board} a {target_board}", order_id, existing.get("order_number"))
    await ws_manager.broadcast("order_change", {"action": "move", "boards": [old_board, target_board]})
    return updated

@router.delete("/api/orders/{order_id}")
async def delete_order(order_id: str, request: Request):
    user = await require_auth(request)
    existing = await db.orders.find_one({"order_id": order_id}, {"_id": 0})
    if not existing:
        raise HTTPException(status_code=404, detail="Order not found")
    await db.orders.update_one({"order_id": order_id}, {"$set": {"board": "PAPELERA DE RECICLAJE", "updated_at": datetime.now(timezone.utc).isoformat()}})
    await log_activity(user, "delete_order", {"order_id": order_id, "order_number": existing.get("order_number")}, previous_data={"order_id": order_id, "fields": {"board": existing.get("board")}})
    await ws_manager.broadcast("order_change", {"action": "delete", "boards": [existing.get("board")]})
    return {"message": "Order moved to trash"}

@router.delete("/api/orders/{order_id}/permanent")
async def permanent_delete_order(order_id: str, request: Request):
    user = await require_auth(request)
    existing = await db.orders.find_one({"order_id": order_id}, {"_id": 0})
    if not existing:
        raise HTTPException(status_code=404, detail="Order not found")
    await db.orders.delete_one({"order_id": order_id})
    await log_activity(user, "permanent_delete_order", {"order_id": order_id, "order_number": existing.get("order_number")})
    return {"message": "Order permanently deleted"}

@router.post("/api/orders/bulk-move")
async def bulk_move_orders(request: Request):
    user = await require_auth(request)
    body = await request.json()
    order_ids = body.get("order_ids", [])
    target_board = body.get("board")
    if not order_ids or not target_board:
        raise HTTPException(status_code=400, detail="order_ids and board required")
    boards = await get_dynamic_boards()
    if target_board not in boards:
        raise HTTPException(status_code=400, detail="Invalid board")
    original_orders = await db.orders.find({"order_id": {"$in": order_ids}}, {"_id": 0, "order_id": 1, "board": 1}).to_list(len(order_ids))
    original_boards = {o["order_id"]: o["board"] for o in original_orders}
    result = await db.orders.update_many({"order_id": {"$in": order_ids}}, {"$set": {"board": target_board, "updated_at": datetime.now(timezone.utc).isoformat()}})
    await log_activity(user, "bulk_move_orders", {"order_count": len(order_ids), "target_board": target_board}, previous_data={"order_ids": order_ids, "original_boards": original_boards})
    affected_boards = list(set(original_boards.values())) + [target_board]
    await _notify_all(user, "move", f"{user['name']} movio {len(order_ids)} ordenes a {target_board}", None, None)
    await ws_manager.broadcast("order_change", {"action": "bulk_move", "boards": affected_boards})
    return {"modified_count": result.modified_count}

@router.post("/api/orders/export")
async def export_orders(request: Request):
    user = await require_auth(request)
    body = await request.json()
    order_ids = body.get("order_ids", [])
    if not order_ids:
        raise HTTPException(status_code=400, detail="order_ids required")
    orders = await db.orders.find({"order_id": {"$in": order_ids}}, {"_id": 0}).to_list(len(order_ids))
    await log_activity(user, "export_orders", {"order_count": len(orders)})
    return {"orders": orders}

# ==================== LINKS ====================

@router.get("/api/orders/{order_id}/links")
async def get_order_links(order_id: str, request: Request):
    await require_auth(request)
    order = await db.orders.find_one({"order_id": order_id}, {"_id": 0})
    if not order:
        raise HTTPException(status_code=404, detail="Order not found")
    return order.get("links", [])

@router.post("/api/orders/{order_id}/links")
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

@router.delete("/api/orders/{order_id}/links/{link_index}")
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

@router.get("/api/orders/{order_id}/comments")
async def get_comments(order_id: str, request: Request):
    await require_auth(request)
    comments = await db.comments.find({"order_id": order_id}, {"_id": 0}).sort("created_at", 1).to_list(500)
    return comments

@router.post("/api/orders/{order_id}/comments")
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
        if uid == current_user_id:
            continue
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
                "read": False, "created_at": datetime.now(timezone.utc).isoformat()
            })
    else:
        for u in all_users:
            uid = u.get("user_id", u.get("email"))
            if uid != current_user_id:
                notif_docs.append({
                    "notification_id": f"notif_{uuid.uuid4().hex[:12]}", "user_id": uid, "type": "comment",
                    "message": f"{user['name']} comento en orden {order.get('order_number', order_id)}",
                    "order_id": order_id, "order_number": order.get("order_number"),
                    "read": False, "created_at": datetime.now(timezone.utc).isoformat()
                })
    if notif_docs:
        await db.notifications.insert_many(notif_docs)
    
    await ws_manager.broadcast("order_change", {"action": "add_comment", "order_id": order_id})
    return {**{k: v for k, v in comment_doc.items() if k not in ["_id", "reactions"]}, "reactions": {}}

@router.put("/api/orders/{order_id}/comments/{comment_id}")
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

@router.delete("/api/orders/{order_id}/comments/{comment_id}")
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

@router.post("/api/orders/{order_id}/comments/{comment_id}/react")
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

# ==================== FILE UPLOAD (stored in MongoDB) ====================

@router.post("/api/orders/{order_id}/images")
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
        base64.b64decode(raw_b64)
        # Store in MongoDB collection 'file_uploads'
        unique_suffix = uuid.uuid4().hex[:8]
        storage_key = f"{order_id}_{unique_suffix}_{filename}"
        await db.file_uploads.insert_one({
            "storage_key": storage_key, "data": raw_b64, "content_type": content_type,
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

@router.get("/api/uploads/{filename}")
async def get_uploaded_file(filename: str):
    from fastapi.responses import Response
    # Try MongoDB first
    doc = await db.file_uploads.find_one({"storage_key": filename}, {"_id": 0})
    if doc:
        image_bytes = base64.b64decode(doc["data"])
        return Response(content=image_bytes, media_type=doc.get("content_type", "image/png"))
    # Fallback to disk for old files
    file_path = UPLOADS_DIR / filename
    if file_path.exists():
        from fastapi.responses import FileResponse
        return FileResponse(file_path)
    raise HTTPException(status_code=404, detail="File not found")

# ==================== EXPORT ORDERS WITH COMMENTS & IMAGES ====================

@router.post("/api/orders/export-complete")
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

@router.post("/api/orders/import-complete")
async def import_orders_complete(request: Request):
    """Import orders with their comments and images."""
    user = await require_auth(request)
    if user.get("role") != "admin":
        raise HTTPException(status_code=403, detail="Admin only")
    body = await request.json()
    orders_data = body.get("orders", [])
    stats = {"orders": 0, "comments": 0, "images": 0, "skipped_orders": 0}

    for entry in orders_data:
        oid = entry.get("order_id")
        if not oid:
            continue
        comments = entry.pop("_comments", [])
        image_files = entry.pop("_image_files", [])

        # Upsert order
        existing = await db.orders.find_one({"order_id": oid})
        if existing:
            stats["skipped_orders"] += 1
        else:
            await db.orders.insert_one({k: v for k, v in entry.items() if k != "_id"})
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
