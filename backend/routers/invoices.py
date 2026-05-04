from fastapi import APIRouter, HTTPException, Request, UploadFile, File, Response
import os
import shutil
import uuid
from typing import List, Optional
from deps import db, require_auth, require_admin, log_activity, InvoiceModel, InvoiceItem, WorkOrderModel, logger
from ws_manager import ws_manager
from datetime import datetime, timezone
import uuid
import os
import resend
import asyncio
from pymongo import ReturnDocument

resend.api_key = os.environ.get('RESEND_API_KEY', '')
SENDER_EMAIL = os.environ.get('SENDER_EMAIL', 'billing@prosper-mfg.com')
PUBLIC_URL = os.environ.get('BACKEND_PUBLIC_URL', 'http://localhost:3000')

router = APIRouter(prefix="/api/invoices")

# Rutas de archivos
UPLOAD_DIR = "uploads/invoices"
os.makedirs(UPLOAD_DIR, exist_ok=True)

@router.post("/upload")
async def upload_invoice_file(file: UploadFile = File(...)):
    try:
        # Generar un nombre único para evitar colisiones
        file_ext = os.path.splitext(file.filename)[1]
        unique_name = f"{uuid.uuid4().hex}{file_ext}"
        file_path = os.path.join(UPLOAD_DIR, unique_name)
        
        with open(file_path, "wb") as buffer:
            shutil.copyfileobj(file.file, buffer)
            
        # Devolver la URL relativa
        # Usamos /api/invoices/static/ para que el router lo maneje o sea servido externamente
        return {"url": f"/api/invoices/static/{unique_name}", "name": file.filename}
    except Exception as e:
        logger.error(f"Upload failed: {str(e)}")
        raise HTTPException(status_code=500, detail=f"Upload failed: {str(e)}")


async def send_invoice_notification(invoice: dict, user_email: str, subject_prefix: str = "New Document"):
    if not resend.api_key:
        logger.warning("Resend API key not configured")
        return
    
    try:
        approval_url = f"{PUBLIC_URL}/dashboard/invoices/{invoice['invoice_id']}"
        html_content = f"""
        <div style="font-family: sans-serif; max-width: 600px; margin: auto;">
            <h2 style="color: #0EA5E9;">Prosper Manufacturing</h2>
            <p>Hello,</p>
            <p>You have received a {invoice['type']} from Prosper Manufacturing.</p>
            <div style="background: #f8fafc; padding: 20px; border-radius: 8px; margin: 20px 0;">
                <p><strong>Document ID:</strong> {invoice['invoice_id']}</p>
                <p><strong>Total Amount:</strong> ${invoice['amounts']['total']:,.2f}</p>
                <p><strong>Due Date:</strong> {invoice['dates']['due']}</p>
            </div>
            <a href="{approval_url}" style="background: #0EA5E9; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; display: inline-block; font-weight: bold;">
                View & Approve Document
            </a>
            <p style="margin-top: 30px; font-size: 12px; color: #64748b;">
                If you have any questions, please contact us at billing@prosper-mfg.com
            </p>
        </div>
        """
        
        email_params = {
            "from": SENDER_EMAIL,
            "to": [user_email],
            "subject": f"{subject_prefix}: {invoice['invoice_id']} - {invoice['client']}",
            "html": html_content
        }
        await asyncio.to_thread(resend.Emails.send, email_params)
        logger.info(f"Notification sent to {user_email} for invoice {invoice['invoice_id']}")
    except Exception as e:
        logger.error(f"Failed to send invoice notification: {e}")

@router.get("")
async def get_invoices(request: Request, status: str = None, type: str = None, search: str = None, show_deleted: bool = False):
    await require_auth(request)
    query = {}
    
    # Filter by deleted status
    if not show_deleted:
        query["is_deleted"] = {"$ne": True}
    else:
        query["is_deleted"] = True

    if status:
        query["status"] = status
    if type:
        query["type"] = type
    if search:
        query["$or"] = [
            {"invoice_id": {"$regex": search, "$options": "i"}},
            {"order_number": {"$regex": search, "$options": "i"}},
            {"client": {"$regex": search, "$options": "i"}},
            {"customer_po": {"$regex": search, "$options": "i"}}
        ]
    
    # Optimization: Do not return heavy attachments in the list view
    projection = {
        "_id": 0,
        "attachments": 0,
        "production_attachments": 0,
        "items.attachments": 0
    }
    
    invoices = await db.invoices.find(query, projection).sort("created_at", -1).to_list(1000)
    return invoices

@router.get("/{invoice_id}")
async def get_invoice(invoice_id: str, request: Request):
    await require_auth(request)
    invoice = await db.invoices.find_one({"invoice_id": invoice_id}, {"_id": 0})
    if not invoice:
        raise HTTPException(status_code=404, detail="Invoice not found")
    return invoice

@router.get("/public/{invoice_id}")
async def get_public_invoice(invoice_id: str):
    # Ruta pública para producción (sin require_auth)
    invoice = await db.invoices.find_one({"invoice_id": invoice_id}, {"_id": 0})
    if not invoice:
        raise HTTPException(status_code=404, detail="Order data not found")
    return invoice

async def get_next_invoice_number():
    """Gets and increments a sequential invoice number from the database."""
    try:
        counter = await db.counters.find_one_and_update(
            {"_id": "invoice_number"},
            {"$inc": {"sequence_value": 1}},
            upsert=True,
            return_document=ReturnDocument.AFTER # Correct usage
        )
        if counter and "sequence_value" in counter:
            return counter["sequence_value"]
        
        # Fallback for first time if find_one_and_update behavior varies
        await db.counters.update_one({"_id": "invoice_number"}, {"$set": {"sequence_value": 1}}, upsert=True)
        return 1
    except Exception as e:
        logger.error(f"Counter error: {e}")
        # Emergency fallback to timestamp if DB counter fails
        return int(datetime.now().timestamp() % 10000)

@router.post("")
async def create_invoice(invoice_data: InvoiceModel, request: Request):
    user = await require_auth(request)
    
    try:
        # Generar el siguiente número secuencial
        invoice_num = await get_next_invoice_number()
        formatted_num = f"{invoice_num:02d}"
        final_id = f"M-{formatted_num}"
        
        doc = invoice_data.model_dump()
        doc["invoice_id"] = final_id
        doc["invoice_number"] = invoice_num
        doc["order_number"] = final_id
        doc["created_at"] = datetime.now(timezone.utc).isoformat()
        doc["updated_at"] = datetime.now(timezone.utc).isoformat()
        
        await db.invoices.insert_one(doc)
        await log_activity(user, "create_invoice", {"invoice_id": doc["invoice_id"], "type": doc["type"]})
        
        # Sincronización Automática con MOS (Orden de Producción)
        try:
            await sync_invoice_to_mos_order(doc, user)
        except Exception as sync_err:
            logger.error(f"Sync failed but invoice created: {sync_err}")

        # AUTOMATION: Auto-generate Work Order immediately
        wo_id = f"WO-{uuid.uuid4().hex[:8].upper()}"
        new_wo = {
            "work_order_id": wo_id,
            "source_invoice_id": doc["invoice_id"],
            "production_status": "artwork_pending",
            "art_links": doc.get("art_links", []),
            "production_notes": doc.get("production_notes", f"Auto-generated from Invoice {doc['invoice_id']}"),
            "packing_details": {"bags": "individual", "labels": "hanging", "boxes": "master"},
            "created_at": datetime.now(timezone.utc).isoformat(),
            "updated_at": datetime.now(timezone.utc).isoformat()
        }
        await db.work_orders.insert_one(new_wo)
        await db.invoices.update_one(
            {"invoice_id": doc["invoice_id"]},
            {"$push": {"linked_work_orders": wo_id}}
        )

        # Broadcast changes
        await ws_manager.broadcast("invoice_change", {"action": "create", "invoice_id": doc["invoice_id"]})
        await ws_manager.broadcast("work_order_change", {"action": "create", "work_order_id": wo_id})
        
        # Remove MongoDB _id to avoid serialization error
        doc.pop("_id", None)
        return doc
    except Exception as e:
        # CAJA NEGRA: Escribir el error real en un archivo para que yo pueda leerlo
        with open("create_error.txt", "w") as f:
            f.write(f"ERROR: {str(e)}\n")
            import traceback
            f.write(traceback.format_exc())
        logger.error(f"Global create_invoice error: {e}")
        raise HTTPException(status_code=500, detail=str(e))

async def sync_invoice_to_mos_order(invoice: dict, user: dict):
    """Fuses Invoice data with MOS Order structure and saves it to the 'orders' collection."""
    try:
        # URL base del dashboard para producción (configurable vía env)
        base_url = os.environ.get("DASHBOARD_URL", "http://localhost:3000")
        public_link = f"{base_url}/public/production/{invoice['invoice_id']}"
        
        # Calculate total quantity and sizes across all items
        total_qty = 0
        merged_sizes = {}
        for item in invoice.get("items", []):
            qty = item.get("quantity", 0)
            total_qty += qty
            item_sizes = item.get("sizes", {})
            if isinstance(item_sizes, dict):
                for sz, count in item_sizes.items():
                    try:
                        val = int(count) if count is not None and str(count).strip() else 0
                        merged_sizes[sz] = merged_sizes.get(sz, 0) + val
                    except (ValueError, TypeError):
                        continue
        
        # Extract style and color from items if missing at top level
        items = invoice.get("items", [])
        first_item = items[0] if items else {}
        
        # Style logic: use global style, or first item's item_number
        style_value = invoice.get("style") or first_item.get("item_number")
        # Color logic: use global color, or first item's color
        color_value = invoice.get("color") or first_item.get("color")

        # Job Title A Logic: Prioritize Job Title A from the invoice
        inv_jta = invoice.get("job_title_a")
        jta_value = public_link
        if isinstance(inv_jta, dict) and inv_jta.get("url"):
            jta_value = inv_jta["url"]
        elif isinstance(inv_jta, str) and inv_jta:
            jta_value = inv_jta

        # Build MOS Order document
        mos_order = {
            "order_id": f"mos_{uuid.uuid4().hex[:12]}",
            "order_number": invoice.get("order_number") or invoice.get("invoice_id"),
            "customer_po": invoice.get("customer_po"),
            "store_po": invoice.get("store_po"),
            "design_#": invoice.get("design_num"),
            "job_title_a": jta_value, 
            "cancel_date": invoice.get("cancel_date"),
            "sample": invoice.get("sample"),
            "client": invoice.get("client"),
            "style": style_value,
            "color": color_value,
            "branding": invoice.get("branding"),
            "priority": invoice.get("priority") or "PRIORITY 2",
            "blank_status": invoice.get("blank_status") or "PENDIENTE",
            "production_status": invoice.get("production_status") or "EN ESPERA",
            "artwork_status": invoice.get("artwork_status") or "NEW",
            "quantity": total_qty,
            "sizes": merged_sizes,
            "due_date": invoice.get("dates", {}).get("due"),
            "notes": invoice.get("production_notes"),
            "board": "SCHEDULING", 
            "created_by": user.get("user_id"),
            "created_at": datetime.now(timezone.utc).isoformat(),
            "updated_at": datetime.now(timezone.utc).isoformat(),
            "source": "ceo_dashboard",
            "invoice_ref": invoice.get("invoice_id"),
            "attachments": invoice.get("attachments", []),
            "art_name": invoice.get("art_name"),
            "print_location": invoice.get("print_location"),
            "ink_colors": invoice.get("ink_colors"),
            "garment_info": invoice.get("garment_info"),
            "finishing_notes": invoice.get("finishing_notes")
        }
        
        # Art links transformation
        art_links = invoice.get("art_links")
        if art_links:
            if isinstance(art_links, str):
                # Split by newline and filter out empty lines
                links_list = [l.strip() for l in art_links.split('\n') if l.strip()]
                mos_order["links"] = [{"url": l, "desc": "Art File/Note"} for l in links_list]
            elif isinstance(art_links, list):
                mos_order["links"] = [{"url": link, "desc": "Art File"} for link in art_links if link]

        await db.orders.update_one(
            {"invoice_ref": invoice.get("invoice_id")},
            {"$set": mos_order},
            upsert=True
        )
        logger.info(f"MOS Order synced/updated: {mos_order['order_number']} from Invoice {invoice['invoice_id']}")
        
        # Broadcast to MOS dashboard
        await ws_manager.broadcast("order_change", {"action": "create", "order_id": mos_order["order_id"]})
        
    except Exception as e:
        with open("sync_error.txt", "a") as f:
            f.write(f"\n[{datetime.now().isoformat()}] SYNC ERROR: {str(e)}\n")
            import traceback
            f.write(traceback.format_exc())
        logger.error(f"Failed to sync Invoice to MOS Order: {e}")

@router.post("/{invoice_id}/approve")
async def approve_invoice(invoice_id: str, request: Request):
    user = await require_auth(request)
    existing = await db.invoices.find_one({"invoice_id": invoice_id})
    if not existing:
        raise HTTPException(status_code=404, detail="Invoice not found")
    
    if existing.get("approval_status") == "approved":
        return {"message": "Already approved"}
    
    update = {
        "approval_status": "approved",
        "status": "sent",
        "updated_at": datetime.now(timezone.utc).isoformat()
    }
    
    await db.invoices.update_one({"invoice_id": invoice_id}, {"$set": update})
    
    # Automations: Auto-generate Work Order on approval
    wo_id = f"WO-{uuid.uuid4().hex[:8].upper()}"
    new_wo = {
        "work_order_id": wo_id,
        "source_invoice_id": invoice_id,
        "production_status": "artwork_pending",
        "art_links": existing.get("art_links", []),
        "production_notes": existing.get("production_notes", f"Auto-generated from Invoice {invoice_id}"),
        "packing_details": {"bags": "individual", "labels": "hanging", "boxes": "master"},
        "created_at": datetime.now(timezone.utc).isoformat(),
        "updated_at": datetime.now(timezone.utc).isoformat()
    }
    
    await db.work_orders.insert_one(new_wo)
    await db.invoices.update_one(
        {"invoice_id": invoice_id},
        {"$push": {"linked_work_orders": wo_id}}
    )
    
    await log_activity(user, "approve_invoice", {"invoice_id": invoice_id})
    await ws_manager.broadcast("invoice_change", {"action": "approve", "invoice_id": invoice_id})
    await ws_manager.broadcast("work_order_change", {"action": "create", "work_order_id": wo_id})
    
    return {"message": "Approved successfully", "work_order_id": wo_id}

@router.post("/{invoice_id}/payment-intent")
async def create_payment_intent(invoice_id: str, request: Request):
    await require_auth(request)
    invoice = await db.invoices.find_one({"invoice_id": invoice_id})
    if not invoice:
        raise HTTPException(status_code=404, detail="Invoice not found")
    
    total = invoice.get("amounts", {}).get("total", 0)
    if total <= 0:
        raise HTTPException(status_code=400, detail="Invalid invoice total")
    
    # Integration with Stripe would go here
    # pi = stripe.PaymentIntent.create(...)
    
    # For now, simulate success or return a mock ID
    mock_pi_id = f"pi_mock_{uuid.uuid4().hex[:12]}"
    
    await db.invoices.update_one(
        {"invoice_id": invoice_id},
        {"$set": {"payment.stripe_payment_intent_id": mock_pi_id, "updated_at": datetime.now(timezone.utc).isoformat()}}
    )
    
    return {"client_secret": "mock_secret", "payment_intent_id": mock_pi_id}

@router.put("/{invoice_id}")
async def update_invoice(invoice_id: str, request: Request):
    user = await require_auth(request)
    data = await request.json()
    
    # Prevenir que cambien el invoice_id original
    if "invoice_id" in data:
        del data["invoice_id"]
    if "_id" in data:
        del data["_id"]
        
    data["updated_at"] = datetime.now(timezone.utc).isoformat()
    
    result = await db.invoices.update_one(
        {"invoice_id": invoice_id},
        {"$set": data}
    )
    
    if result.matched_count == 0:
        raise HTTPException(status_code=404, detail="Invoice not found")
        
    # SYNC TO MOS: Update the linked order in the 'orders' collection
    # We update common fields that might have changed
    mos_update = {}
    sync_fields = [
        "customer_po", "store_po", "design_num", "client", "style", "branding", 
        "priority", "blank_status", "production_status", "artwork_status", 
        "color", "production_notes", "sample", "cancel_date"
    ]
    
    for field in sync_fields:
        if field in data:
            mos_update[field] = data[field]
            if field == "design_num":
                mos_update["design_#"] = data[field]
    
    # Also update due_date if dates.due changed
    if "dates" in data and isinstance(data["dates"], dict) and "due" in data["dates"]:
        mos_update["due_date"] = data["dates"]["due"]

    if mos_update:
        mos_update["updated_at"] = datetime.now(timezone.utc).isoformat()
        await db.orders.update_many({"invoice_ref": invoice_id}, {"$set": mos_update})
        # Broadcast to MOS dashboard
        await ws_manager.broadcast("order_change", {"action": "update", "invoice_ref": invoice_id})

    await log_activity(user, "update_invoice", {"invoice_id": invoice_id})
    await ws_manager.broadcast("invoice_change", {"action": "update", "invoice_id": invoice_id})
    
    updated_invoice = await db.invoices.find_one({"invoice_id": invoice_id})
    if updated_invoice and "_id" in updated_invoice:
        updated_invoice["_id"] = str(updated_invoice["_id"])
    return updated_invoice

@router.delete("/{invoice_id}")
async def delete_invoice(invoice_id: str, request: Request):
    user = await require_auth(request)
    
    # Check if invoice exists
    invoice = await db.invoices.find_one({"invoice_id": invoice_id})
    if not invoice:
        raise HTTPException(status_code=404, detail="Invoice not found")
        
    # If it's already in the trash, perform a PERMANENT delete (Hard Delete)
    if invoice.get("is_deleted"):
        # 1. Hard delete the invoice
        await db.invoices.delete_one({"invoice_id": invoice_id})
        
        # 2. Hard delete linked MOS orders
        await db.orders.delete_many({"invoice_ref": invoice_id})
        
        # 3. Hard delete linked Work Orders
        await db.work_orders.delete_many({"source_invoice_id": invoice_id})
        
        await log_activity(user, "permanent_delete_invoice", {"invoice_id": invoice_id})
        return {"message": "Invoice and linked records permanently deleted"}

    # If it's NOT in the trash, perform a SOFT delete (Move to Trash)
    now = datetime.now(timezone.utc).isoformat()
    result = await db.invoices.update_one(
        {"invoice_id": invoice_id},
        {"$set": {
            "is_deleted": True,
            "deleted_at": now,
            "status": "cancelled"
        }}
    )
    
    if result.matched_count == 0:
        raise HTTPException(status_code=400, detail="Failed to mark invoice as deleted")
        
    # CASCADE TO MOS: Move linked orders to Trash instead of permanent deletion
    order_result = await db.orders.update_many(
        {"invoice_ref": invoice_id},
        {"$set": {
            "board": "PAPELERA DE RECICLAJE",
            "deleted_at": now,
            "updated_at": now
        }}
    )
    
    await db.work_orders.update_many(
        {"source_invoice_id": invoice_id},
        {"$set": {"is_deleted": True, "status": "cancelled"}}
    )
    
    await log_activity(user, "delete_invoice", {"invoice_id": invoice_id, "client": invoice.get("client")})
    
    await ws_manager.broadcast("invoice_change", {"action": "delete", "invoice_id": invoice_id})
    await ws_manager.broadcast("order_change", {"action": "delete", "invoice_ref": invoice_id})
    await ws_manager.broadcast("work_order_change", {"action": "delete", "source_invoice_id": invoice_id})
    
    return {"message": "Invoice and linked orders moved to trash"}

@router.post("/{invoice_id}/restore")
async def restore_invoice(invoice_id: str, request: Request):
    user = await require_auth(request)
    
    # 1. Restore the invoice
    result = await db.invoices.update_one(
        {"invoice_id": invoice_id},
        {"$set": {"is_deleted": False, "status": "sent"}}
    )
    
    if result.matched_count == 0:
        raise HTTPException(status_code=404, detail="Invoice not found")
        
    # 2. Restore linked MOS orders
    await db.orders.update_many(
        {"invoice_ref": invoice_id},
        {"$set": {"board": "SCHEDULING"}}
    )
    
    # 3. Restore work orders
    await db.work_orders.update_many(
        {"source_invoice_id": invoice_id},
        {"$set": {"is_deleted": False}}
    )
    
    await log_activity(user, "restore_invoice", {"invoice_id": invoice_id})
    return {"message": "Invoice and linked orders restored"}
