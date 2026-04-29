from fastapi import APIRouter, HTTPException, Request
from typing import List, Optional
from deps import db, require_auth, require_admin, log_activity, WorkOrderModel, logger
from ws_manager import ws_manager
from datetime import datetime, timezone
import uuid

router = APIRouter(prefix="/api/work-orders")

@router.get("")
async def get_work_orders(request: Request, status: str = None, operator_id: str = None, search: str = None):
    await require_auth(request)
    query = {}
    if status:
        query["production_status"] = status
    if operator_id:
        query["assigned_operator"] = operator_id
    if search:
        query["$or"] = [
            {"work_order_id": {"$regex": search, "$options": "i"}},
            {"source_invoice_id": {"$regex": search, "$options": "i"}},
            {"production_notes": {"$regex": search, "$options": "i"}}
        ]
    
    work_orders = await db.work_orders.find(query, {"_id": 0}).sort("created_at", -1).to_list(1000)
    return work_orders

@router.get("/{work_order_id}")
async def get_work_order(work_order_id: str, request: Request):
    await require_auth(request)
    wo = await db.work_orders.find_one({"work_order_id": work_order_id}, {"_id": 0})
    if not wo:
        raise HTTPException(status_code=404, detail="Work Order not found")
    return wo

@router.post("")
async def create_work_order(wo_data: WorkOrderModel, request: Request):
    user = await require_auth(request)
    
    if not wo_data.work_order_id or wo_data.work_order_id == "string":
        wo_data.work_order_id = f"WO-{uuid.uuid4().hex[:8].upper()}"
    
    existing = await db.work_orders.find_one({"work_order_id": wo_data.work_order_id})
    if existing:
        raise HTTPException(status_code=400, detail="Work Order ID already exists")
    
    doc = wo_data.model_dump()
    doc["created_at"] = datetime.now(timezone.utc).isoformat()
    doc["updated_at"] = datetime.now(timezone.utc).isoformat()
    
    await db.work_orders.insert_one(doc)
    
    # Update linked invoice
    await db.invoices.update_one(
        {"invoice_id": wo_data.source_invoice_id},
        {"$push": {"linked_work_orders": wo_data.work_order_id}}
    )
    
    await log_activity(user, "create_work_order", {"work_order_id": doc["work_order_id"], "invoice_id": doc["source_invoice_id"]})
    await ws_manager.broadcast("work_order_change", {"action": "create", "work_order_id": doc["work_order_id"]})
    
    return doc

@router.put("/{work_order_id}")
async def update_work_order(work_order_id: str, wo_data: dict, request: Request):
    user = await require_auth(request)
    existing = await db.work_orders.find_one({"work_order_id": work_order_id})
    if not existing:
        raise HTTPException(status_code=404, detail="Work Order not found")
    
    wo_data["updated_at"] = datetime.now(timezone.utc).isoformat()
    
    await db.work_orders.update_one({"work_order_id": work_order_id}, {"$set": wo_data})
    
    await log_activity(user, "update_work_order", {"work_order_id": work_order_id})
    await ws_manager.broadcast("work_order_change", {"action": "update", "work_order_id": work_order_id})
    
    updated = await db.work_orders.find_one({"work_order_id": work_order_id}, {"_id": 0})
    return updated

@router.post("/{work_order_id}/assign")
async def assign_work_order(work_order_id: str, request: Request):
    user = await require_auth(request)
    body = await request.json()
    operator_id = body.get("operator_id")
    
    if not operator_id:
        raise HTTPException(status_code=400, detail="Operator ID required")
        
    await db.work_orders.update_one(
        {"work_order_id": work_order_id},
        {"$set": {"assigned_operator": operator_id, "updated_at": datetime.now(timezone.utc).isoformat()}}
    )
    
    await log_activity(user, "assign_work_order", {"work_order_id": work_order_id, "operator_id": operator_id})
    await ws_manager.broadcast("work_order_change", {"action": "assign", "work_order_id": work_order_id})
    
    return {"message": "Assigned successfully"}

@router.delete("/{work_order_id}")
async def delete_work_order(work_order_id: str, request: Request):
    user = await require_admin(request)
    existing = await db.work_orders.find_one({"work_order_id": work_order_id})
    if not existing:
        raise HTTPException(status_code=404, detail="Work Order not found")
    
    # Remove from invoice list
    await db.invoices.update_one(
        {"invoice_id": existing.get("source_invoice_id")},
        {"$pull": {"linked_work_orders": work_order_id}}
    )
    
    await db.work_orders.delete_one({"work_order_id": work_order_id})
    await log_activity(user, "delete_work_order", {"work_order_id": work_order_id})
    await ws_manager.broadcast("work_order_change", {"action": "delete", "work_order_id": work_order_id})
    
    return {"message": "Work Order deleted"}
