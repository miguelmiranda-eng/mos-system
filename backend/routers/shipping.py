from fastapi import APIRouter, Request, HTTPException, UploadFile, File, Form
from typing import List, Optional
from deps import db, require_auth, log_activity
from datetime import datetime, timezone
import os
import uuid
import shutil
from pathlib import Path

router = APIRouter(prefix="/api/shipping", tags=["shipping"])

UPLOAD_DIR = Path("uploads/shipping")
UPLOAD_DIR.mkdir(parents=True, exist_ok=True)


def _parse_ts(nombre: str, valor: Optional[str]) -> Optional[str]:
    """Timestamps del envio (Tareas 3.2-3.4): ISO 8601 CON zona horaria,
    normalizados a UTC al guardar. Vacio/None = no capturado (no se inventa)."""
    if valor is None or not str(valor).strip():
        return None
    s = str(valor).strip().replace("Z", "+00:00")
    try:
        dt = datetime.fromisoformat(s)
    except ValueError:
        raise HTTPException(400, f"`{nombre}` no es ISO 8601 válido "
                                 f"(ej. 2026-08-28T15:30:00-07:00).")
    if dt.tzinfo is None:
        raise HTTPException(400, f"`{nombre}` debe incluir zona horaria "
                                 f"(ej. …-07:00, o Z para UTC).")
    return dt.astimezone(timezone.utc).isoformat()

@router.post("")
async def create_shipping_record(
    request: Request,
    order_numbers: str = Form(...),
    notes: Optional[str] = Form(""),
    files: List[UploadFile] = File([]),
    # Tareas 3.2-3.4: momento exacto de cada hito, ISO 8601 con zona horaria.
    packed_at: Optional[str] = Form(None),
    dispatched_at: Optional[str] = Form(None),
    delivered_at: Optional[str] = Form(None),
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
        # Tareas 3.2-3.4. dispatched_at: registrar el envio ES el despacho, asi
        # que sin valor explicito se sella AHORA. packed_at/delivered_at no se
        # inventan: quedan null hasta que alguien los capture (la entrega llega
        # dias despues via PUT /api/shipping/{id}).
        "packed_at": _parse_ts("packed_at", packed_at),
        "dispatched_at": _parse_ts("dispatched_at", dispatched_at)
                         or datetime.now(timezone.utc).isoformat(),
        "delivered_at": _parse_ts("delivered_at", delivered_at),
        "created_by": user.get("user_id"),
        "created_by_name": user.get("name", user.get("email")),
        "created_at": datetime.now(timezone.utc).isoformat()
    }

    await db.shipping_records.insert_one(record)

    return {"message": "Envío registrado con éxito", "shipping_id": record["shipping_id"]}


@router.put("/{shipping_id}")
async def update_shipping_timestamps(shipping_id: str, request: Request):
    """Completa los hitos de un envio ya registrado (Tareas 3.2-3.4): recibe
    JSON con cualquiera de packed_at / dispatched_at / delivered_at (ISO 8601
    con zona horaria). Pensado para capturar la ENTREGA cuando ocurre, dias
    despues del despacho. Solo toca los campos que vienen en el body."""
    user = await require_auth(request)
    body = await request.json()
    cambios = {}
    for campo in ("packed_at", "dispatched_at", "delivered_at"):
        if campo in body:
            cambios[campo] = _parse_ts(campo, body.get(campo))
    if not cambios:
        raise HTTPException(400, "Manda al menos uno de: packed_at, dispatched_at, delivered_at.")

    res = await db.shipping_records.update_one({"shipping_id": shipping_id}, {"$set": cambios})
    if not res.matched_count:
        raise HTTPException(404, f"No existe el registro de envío {shipping_id}.")
    await log_activity(user, "shipping_timestamps_updated",
                       {"shipping_id": shipping_id, "campos": sorted(cambios)})
    return await db.shipping_records.find_one({"shipping_id": shipping_id}, {"_id": 0})

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
