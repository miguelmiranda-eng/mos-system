"""Activity log, notifications, undo routes."""
from fastapi import APIRouter, HTTPException, Request
from deps import db, require_auth, require_admin, log_activity, logger
from datetime import datetime, timezone

router = APIRouter(prefix="/api")

@router.get("/notifications")
async def get_notifications(request: Request, limit: int = 50):
    user = await require_auth(request)
    user_id = user.get("user_id", user.get("email"))
    notifs = await db.notifications.find({"user_id": user_id}, {"_id": 0}).sort("created_at", -1).limit(limit).to_list(limit)
    unread_count = await db.notifications.count_documents({"user_id": user_id, "read": False})
    return {"notifications": notifs, "unread_count": unread_count}

@router.put("/notifications/read")
async def mark_notifications_read(request: Request):
    user = await require_auth(request)
    user_id = user.get("user_id", user.get("email"))
    await db.notifications.update_many({"user_id": user_id, "read": False}, {"$set": {"read": True}})
    return {"message": "All notifications marked as read"}

@router.get("/activity")
async def get_activity_logs(request: Request, limit: int = 100, offset: int = 0, action_filter: str = None):
    await require_admin(request)
    query = {}
    if action_filter:
        query["action"] = action_filter
    total = await db.activity_logs.count_documents(query)
    logs = await db.activity_logs.find(query, {"_id": 0}).sort("timestamp", -1).skip(offset).limit(limit).to_list(limit)
    return {"total": total, "logs": logs, "limit": limit, "offset": offset}

@router.post("/undo/{activity_id}")
async def undo_action(activity_id: str, request: Request):
    user = await require_admin(request)
    log_entry = await db.activity_logs.find_one({"activity_id": activity_id}, {"_id": 0})
    if not log_entry:
        raise HTTPException(status_code=404, detail="Activity not found")
    if not log_entry.get("undoable"):
        raise HTTPException(status_code=400, detail="This action cannot be undone")
    if log_entry.get("undone"):
        raise HTTPException(status_code=400, detail="This action has already been undone")
    prev = log_entry.get("previous_data", {})
    action = log_entry.get("action")
    try:
        if action == "update_order":
            order_id = prev.get("order_id")
            fields = prev.get("fields", {})
            if order_id and fields:
                fields["updated_at"] = datetime.now(timezone.utc).isoformat()
                await db.orders.update_one({"order_id": order_id}, {"$set": fields})
        elif action == "move_order":
            order_id = prev.get("order_id")
            fields = prev.get("fields", {})
            if order_id and "board" in fields:
                await db.orders.update_one({"order_id": order_id}, {"$set": {"board": fields["board"], "updated_at": datetime.now(timezone.utc).isoformat()}})
        elif action == "delete_order":
            order_id = prev.get("order_id")
            fields = prev.get("fields", {})
            original_board = fields.get("board", "SCHEDULING")
            if order_id:
                await db.orders.update_one({"order_id": order_id}, {"$set": {"board": original_board, "updated_at": datetime.now(timezone.utc).isoformat()}})
        elif action == "create_order":
            order_id = prev.get("order_id")
            if order_id:
                await db.orders.update_one({"order_id": order_id}, {"$set": {"board": "PAPELERA DE RECICLAJE", "updated_at": datetime.now(timezone.utc).isoformat()}})
        elif action == "bulk_move_orders":
            original_boards = prev.get("original_boards", {})
            for oid, board in original_boards.items():
                await db.orders.update_one({"order_id": oid}, {"$set": {"board": board, "updated_at": datetime.now(timezone.utc).isoformat()}})
        else:
            raise HTTPException(status_code=400, detail=f"Undo not supported for action: {action}")
        await db.activity_logs.update_one({"activity_id": activity_id}, {"$set": {"undone": True}})
        await log_activity(user, "undo_action", {"undone_activity_id": activity_id, "undone_action": action, "details": log_entry.get("details", {})})
        return {"message": "Action undone successfully", "undone_action": action}
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Undo error: {e}")
        raise HTTPException(status_code=500, detail=f"Failed to undo: {str(e)}")
