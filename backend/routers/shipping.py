from fastapi import APIRouter, Request, HTTPException, UploadFile, File, Form
from typing import List, Optional
from deps import db, require_auth, log_activity
from services.qty_embarcada import qty_embarcada_por_orden, entero_o_none
from datetime import datetime, timezone
import os
import uuid
import shutil
from pathlib import Path

router = APIRouter(prefix="/api/shipping", tags=["shipping"])

UPLOAD_DIR = Path("uploads/shipping")
UPLOAD_DIR.mkdir(parents=True, exist_ok=True)


# ── Catálogo de delay_code (Tarea 6.2) ───────────────────────────────────────
# CERRADO y CORTO a propósito — regla del jefe: esto NO es un TMS. El código
# existe para poder AGREGAR (contar retrasos por causa) sin parsear texto; el
# detalle libre sigue viviendo en `notes`. Agregar una causa nueva es tocar
# este dict (cambio aditivo de contrato), no aceptar texto libre.
DELAY_CODES = {
    "customer_request":   "El cliente pidió mover la fecha",
    "production_delay":   "Producción no llegó a tiempo",
    "materials_shortage": "Faltó material o insumo",
    "carrier_issue":      "Problema con el transportista",
    "documentation":      "Documentación (aduana, permisos, papeles)",
    "weather":            "Clima u otra fuerza mayor",
    "other":              "Otra causa (detallar en notes)",
}


def _valida_delay_code(valor):
    """None/vacío = sin retraso declarado (no se inventa). Fuera del catálogo
    → 400: el catálogo es cerrado (Tarea 6.2)."""
    if valor is None or not str(valor).strip():
        return None
    v = str(valor).strip().lower()
    if v not in DELAY_CODES:
        raise HTTPException(400, f"delay_code inválido: {str(valor).strip()!r}. "
                                 f"Catálogo: {', '.join(sorted(DELAY_CODES))}.")
    return v


async def _ordenes_desconocidas(numeros):
    """Tarea 6.1: qué números capturados NO corresponden a una orden viva
    (fuera de PAPELERA). Se valida contra órdenes reales, no contra un
    catálogo aparte."""
    if not numeros:
        return []
    existentes = set(await db.orders.distinct(
        "order_number",
        {"order_number": {"$in": numeros}, "board": {"$ne": "PAPELERA DE RECICLAJE"}}))
    return [n for n in numeros if n not in existentes]


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
    # Tarea 6.2: causa de retraso del catálogo cerrado (400 fuera de él).
    delay_code: Optional[str] = Form(None),
    # Tarea 6.1: strict=true rechaza números que no son órdenes vivas (400).
    # Default false: se guarda igual y se AVISA (unknown_orders) — así ni el
    # frontend ni Command se rompen mientras adoptan la validación.
    strict: bool = Form(False),
):
    user = await require_auth(request)
    delay = _valida_delay_code(delay_code)

    # Process order numbers (comma or space separated)
    orders = [o.strip() for o in order_numbers.replace(",", " ").split() if o.strip()]

    # Tarea 6.1: validación contra órdenes reales. Siempre se calcula (queda
    # como foto en el registro y viaja en la respuesta); strict decide si es
    # muro o aviso.
    desconocidas = await _ordenes_desconocidas(orders)
    if strict:
        if not orders:
            raise HTTPException(400, "order_numbers no trae ningún número de orden.")
        if desconocidas:
            raise HTTPException(400, "Órdenes inexistentes (o en papelera): "
                                     + ", ".join(desconocidas))

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
        # Tarea 6.2: causa de retraso (catálogo cerrado); null = sin retraso.
        "delay_code": delay,
        # Tarea 6.1: FOTO al registrar — números que no eran órdenes vivas en
        # ese momento. No se recalcula sobre historia.
        "unknown_orders": desconocidas,
        "created_by": user.get("user_id"),
        "created_by_name": user.get("name", user.get("email")),
        "created_at": datetime.now(timezone.utc).isoformat()
    }

    await db.shipping_records.insert_one(record)

    return {"message": "Envío registrado con éxito", "shipping_id": record["shipping_id"],
            "unknown_orders": desconocidas}


async def _con_detalle_de_ordenes(records):
    """Tarea 4.1: agrega a cada registro `orders_detail` — por cada número
    capturado en `order_numbers`, el par qty_ordered (orders.quantity) vs
    qty_shipped (derivado de la bitácora del WMS, ver
    services/qty_embarcada.py). `order_numbers` sigue siendo texto libre hasta
    la tarea 6.1: cuando el número no corresponde a una orden viva,
    qty_ordered viene null (qty_shipped puede sumar igual — la bitácora se
    consulta por número, exista o no la orden)."""
    nums = sorted({str(n).strip() for r in records
                   for n in (r.get("order_numbers") or []) if str(n).strip()})
    if not nums:
        for r in records:
            r["orders_detail"] = []
        return records
    ordenes = await db.orders.find(
        {"order_number": {"$in": nums}, "board": {"$ne": "PAPELERA DE RECICLAJE"}},
        {"_id": 0, "order_number": 1, "order_id": 1, "quantity": 1},
    ).to_list(None)
    por_num = {o.get("order_number"): o for o in ordenes}
    embarcado = await qty_embarcada_por_orden(db, [
        {"order_number": n, "order_id": por_num.get(n, {}).get("order_id")}
        for n in nums])
    for r in records:
        r["orders_detail"] = [
            {"order_number": num,
             "qty_ordered": entero_o_none(por_num.get(num, {}).get("quantity")),
             "qty_shipped": embarcado.get(num, 0)}
            for num in (str(n).strip() for n in (r.get("order_numbers") or []))
            if num]
    return records


@router.get("/delay-codes")
async def list_delay_codes(request: Request):
    """Tarea 6.2: el catálogo cerrado de causas de retraso, consultable para
    que el frontend y Command pinten opciones sin hardcodearlas."""
    await require_auth(request)
    return {"delay_codes": [{"code": c, "label": l} for c, l in DELAY_CODES.items()]}


@router.put("/{shipping_id}")
async def update_shipping_timestamps(shipping_id: str, request: Request):
    """Completa un envio ya registrado: hitos packed_at / dispatched_at /
    delivered_at (Tareas 3.2-3.4, ISO 8601 con zona horaria) y/o delay_code
    (Tarea 6.2, catalogo cerrado; null lo limpia). Solo toca los campos que
    vienen en el body."""
    user = await require_auth(request)
    body = await request.json()
    cambios = {}
    for campo in ("packed_at", "dispatched_at", "delivered_at"):
        if campo in body:
            cambios[campo] = _parse_ts(campo, body.get(campo))
    if "delay_code" in body:
        cambios["delay_code"] = _valida_delay_code(body.get("delay_code"))
    if not cambios:
        raise HTTPException(400, "Manda al menos uno de: packed_at, dispatched_at, "
                                 "delivered_at, delay_code.")

    res = await db.shipping_records.update_one({"shipping_id": shipping_id}, {"$set": cambios})
    if not res.matched_count:
        raise HTTPException(404, f"No existe el registro de envío {shipping_id}.")
    await log_activity(user, "shipping_timestamps_updated",
                       {"shipping_id": shipping_id, "campos": sorted(cambios)})
    doc = await db.shipping_records.find_one({"shipping_id": shipping_id}, {"_id": 0})
    return (await _con_detalle_de_ordenes([doc]))[0]

@router.get("")
async def get_shipping_records(request: Request, date: Optional[str] = None,
                               skip: Optional[int] = None,
                               limit: Optional[int] = None):
    await require_auth(request)

    query = {}
    if date:
        # Simple date match (YYYY-MM-DD)
        query["created_at"] = {"$regex": f"^{date}"}

    # Tarea 5.2: paginación bajo demanda. Mandar `skip` (aunque sea 0) activa
    # el sobre {total, skip, limit, items}; sin `skip` la respuesta sigue
    # siendo la lista plana histórica (consumidores actuales intactos), donde
    # `limit` solo ajusta su tamaño (default histórico: 100).
    limit_v = max(1, min(limit if limit is not None else 100, 5000))
    cursor = db.shipping_records.find(query, {"_id": 0}).sort("created_at", -1)
    if skip is None:
        records = await cursor.to_list(limit_v)
        return await _con_detalle_de_ordenes(records)
    skip_v = max(0, skip)
    total = await db.shipping_records.count_documents(query)
    records = await cursor.skip(skip_v).limit(limit_v).to_list(limit_v)
    return {"total": total, "skip": skip_v, "limit": limit_v,
            "items": await _con_detalle_de_ordenes(records)}

# Static file serving handled in server.py (will add mount)
