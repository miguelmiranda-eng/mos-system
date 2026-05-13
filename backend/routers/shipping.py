from fastapi import APIRouter, Request, HTTPException, UploadFile, File, Form
from typing import List, Optional
from deps import db, require_auth
from datetime import datetime, timezone
import os
import uuid
import shutil
from pathlib import Path

router = APIRouter(prefix="/api/shipping", tags=["shipping"])

UPLOAD_DIR = Path("uploads/shipping")
UPLOAD_DIR.mkdir(parents=True, exist_ok=True)

@router.post("")
async def create_shipping_record(
    request: Request,
    order_numbers: str = Form(...),
    notes: Optional[str] = Form(""),
    files: List[UploadFile] = File([])
):
    user = await require_auth(request)
    
    # Process order numbers (comma or space separated)
    orders = [o.strip() for o in order_numbers.replace(",", " ").split() if o.strip()]
    
    evidence = []
    for file in files:
        file_ext = Path(file.filename).suffix.lower()
        # Allowed extensions
        if file_ext not in [".jpg", ".jpeg", ".png", ".pdf", ".xlsx", ".xls", ".csv"]:
            continue
            
        file_id = str(uuid.uuid4())
        file_name = f"{file_id}{file_ext}"
        file_path = UPLOAD_DIR / file_name
        
        with open(file_path, "wb") as buffer:
            shutil.copyfileobj(file.file, buffer)
            
        evidence.append({
            "id": file_id,
            "filename": file.filename,
            "url": f"/api/shipping/static/{file_name}",
            "type": file_ext.replace(".", "")
        })

    record = {
        "shipping_id": str(uuid.uuid4()),
        "order_numbers": orders,
        "notes": notes,
        "evidence": evidence,
        "created_by": user.get("user_id"),
        "created_by_name": user.get("name", user.get("email")),
        "created_at": datetime.now(timezone.utc).isoformat()
    }
    
    await db.shipping_records.insert_one(record)
    
    return {"message": "Envío registrado con éxito", "shipping_id": record["shipping_id"]}

@router.get("")
async def get_shipping_records(request: Request, date: Optional[str] = None):
    await require_auth(request)
    
    query = {}
    if date:
        # Simple date match (YYYY-MM-DD)
        query["created_at"] = {"$regex": f"^{date}"}
    
    records = await db.shipping_records.find(query, {"_id": 0}).sort("created_at", -1).to_list(100)
    return records

# Static file serving handled in server.py (will add mount)
