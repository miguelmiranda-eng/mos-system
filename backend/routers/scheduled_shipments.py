"""Envíos programados (Scheduled Shipments).

Programador de envíos: se toman órdenes que AÚN no se han enviado (sin el
"camioncito" = sin `packing_link`) y se programan asignándoles una fecha de
exportación planeada y un destino. La programación vive en su propia colección
`db.scheduled_shipments` (no ensucia el modelo de orden); la tabla une esos datos
con la info viva de la orden (cliente, qty, status, cancel_date…) al leer.

'Days Com.' = días desde hoy hasta el cancel_date de la orden (negativo = vencida).

Endpoints (prefijo /api/scheduled-shipments):
  GET    ""              → lista programados (unidos con datos de la orden)
  POST   ""             → programa una orden (idempotente por order_number)
  PUT    "/{id}"        → edita fecha export / destino / PL / estado
  DELETE "/{id}"        → desprograma
"""
import uuid
from datetime import datetime, timezone

from fastapi import APIRouter, Request, HTTPException

from deps import db, require_auth, log_activity

router = APIRouter(prefix="/api/scheduled-shipments", tags=["scheduled-shipments"])

# Campos de la orden que la tabla necesita mostrar (unidos al leer).
_ORDER_PROJ = {
    "_id": 0, "order_number": 1, "customer_po": 1, "design_#": 1, "design_num": 1,
    "cancel_date": 1, "client": 1, "branding": 1, "quantity": 1,
    "production_status": 1, "board": 1, "notes": 1,
    "packing_link": 1, "packing_link_label": 1,
}


def _parse_date(raw):
    if not raw:
        return None
    s = str(raw).strip()
    if not s:
        return None
    try:
        return datetime.strptime(s[:10], "%Y-%m-%d").date()
    except (ValueError, TypeError):
        try:
            return datetime.fromisoformat(s).date()
        except (ValueError, TypeError):
            return None


def _days_com(cancel_date):
    """Días desde hoy (UTC) hasta cancel_date. Negativo = vencida. None si no hay fecha."""
    d = _parse_date(cancel_date)
    if d is None:
        return None
    return (d - datetime.now(timezone.utc).date()).days


def _valid_month(v):
    m = int(v)
    if not (1 <= m <= 12):
        raise ValueError
    return m


def _valid_week(v):
    w = int(v)
    if not (1 <= w <= 5):
        raise ValueError
    return w


def _row(sched: dict, order: dict | None) -> dict:
    o = order or {}
    return {
        "shipment_id": sched.get("shipment_id"),
        "order_number": sched.get("order_number"),
        "scheduled_year": sched.get("scheduled_year"),
        "scheduled_month": sched.get("scheduled_month"),   # 1..12
        "scheduled_week": sched.get("scheduled_week"),     # 1..5 (semana del mes)
        "scheduled_export_date": sched.get("scheduled_export_date"),
        "delivery_to": sched.get("delivery_to"),
        "pl_export": sched.get("pl_export"),
        "status": sched.get("status"),
        # Unidos de la orden (fuente de verdad viva)
        "customer_po": o.get("customer_po"),
        "design_num": o.get("design_#") or o.get("design_num"),
        "cancel_date": o.get("cancel_date"),
        "client": o.get("client"),
        "branding": o.get("branding"),
        "quantity": o.get("quantity"),
        "production_status": o.get("production_status"),
        "board": o.get("board"),
        "notes": o.get("notes"),
        "packing_link": o.get("packing_link"),
        "packing_link_label": o.get("packing_link_label"),
        "days_com": _days_com(o.get("cancel_date")),
        "order_exists": order is not None,
        "created_at": sched.get("created_at"),
        "updated_at": sched.get("updated_at"),
    }


@router.get("")
async def list_scheduled(request: Request):
    await require_auth(request)
    scheds = await db.scheduled_shipments.find({}, {"_id": 0}).sort("created_at", -1).to_list(5000)
    nums = [s.get("order_number") for s in scheds if s.get("order_number")]
    orders = await db.orders.find({"order_number": {"$in": nums}}, _ORDER_PROJ).to_list(len(nums) or 1)
    by_num = {o["order_number"]: o for o in orders if o.get("order_number")}
    return {"items": [_row(s, by_num.get(s.get("order_number"))) for s in scheds]}


@router.post("")
async def schedule_shipment(request: Request):
    user = await require_auth(request)
    body = await request.json()
    order_number = str(body.get("order_number") or "").strip()
    if not order_number:
        raise HTTPException(status_code=400, detail="order_number requerido")

    order = await db.orders.find_one(
        {"order_number": order_number, "board": {"$ne": "PAPELERA DE RECICLAJE"}}, _ORDER_PROJ,
    )
    if not order:
        raise HTTPException(status_code=404, detail=f"Orden {order_number} no encontrada")

    # Slot obligatorio: mes (1..12) + semana del mes (1..5). Año default = actual.
    try:
        month = _valid_month(body.get("scheduled_month"))
        week = _valid_week(body.get("scheduled_week"))
    except (TypeError, ValueError):
        raise HTTPException(status_code=400, detail="scheduled_month (1..12) y scheduled_week (1..5) requeridos")
    try:
        year = int(body.get("scheduled_year") or datetime.now(timezone.utc).year)
    except (TypeError, ValueError):
        year = datetime.now(timezone.utc).year

    now = datetime.now(timezone.utc).isoformat()
    fields = {
        "scheduled_year": year,
        "scheduled_month": month,
        "scheduled_week": week,
        "scheduled_export_date": (body.get("scheduled_export_date") or None),
        "delivery_to": (body.get("delivery_to") or None),
        "pl_export": (body.get("pl_export") or None),
        "status": (body.get("status") or None),
        "updated_at": now,
    }
    # Idempotente por order_number: si ya estaba programada, actualiza; si no, crea.
    existing = await db.scheduled_shipments.find_one({"order_number": order_number}, {"_id": 0, "shipment_id": 1})
    if existing:
        await db.scheduled_shipments.update_one(
            {"order_number": order_number}, {"$set": fields},
        )
        sid = existing["shipment_id"]
    else:
        sid = str(uuid.uuid4())
        await db.scheduled_shipments.insert_one({
            "shipment_id": sid,
            "order_number": order_number,
            **fields,
            "created_by": user.get("user_id"),
            "created_by_name": user.get("name", user.get("email")),
            "created_at": now,
        })
    await log_activity(user, "schedule_shipment", {"order_number": order_number})
    sched = await db.scheduled_shipments.find_one({"shipment_id": sid}, {"_id": 0})
    return _row(sched, order)


@router.put("/{shipment_id}")
async def update_scheduled(shipment_id: str, request: Request):
    user = await require_auth(request)
    body = await request.json()
    allowed = {}
    for k in ("scheduled_export_date", "delivery_to", "pl_export", "status"):
        if k in body:
            allowed[k] = body[k] or None
    # Mover a otro mes/semana/año (con validación).
    try:
        if "scheduled_month" in body:
            allowed["scheduled_month"] = _valid_month(body["scheduled_month"])
        if "scheduled_week" in body:
            allowed["scheduled_week"] = _valid_week(body["scheduled_week"])
        if "scheduled_year" in body:
            allowed["scheduled_year"] = int(body["scheduled_year"])
    except (TypeError, ValueError):
        raise HTTPException(status_code=400, detail="mes (1..12), semana (1..5) o año inválidos")
    if not allowed:
        raise HTTPException(status_code=400, detail="Nada que actualizar")
    allowed["updated_at"] = datetime.now(timezone.utc).isoformat()
    res = await db.scheduled_shipments.update_one({"shipment_id": shipment_id}, {"$set": allowed})
    if res.matched_count == 0:
        raise HTTPException(status_code=404, detail="Programación no encontrada")
    sched = await db.scheduled_shipments.find_one({"shipment_id": shipment_id}, {"_id": 0})
    order = await db.orders.find_one({"order_number": sched.get("order_number")}, _ORDER_PROJ)
    await log_activity(user, "update_scheduled_shipment", {"shipment_id": shipment_id, **allowed})
    return _row(sched, order)


@router.delete("/{shipment_id}")
async def unschedule(shipment_id: str, request: Request):
    user = await require_auth(request)
    sched = await db.scheduled_shipments.find_one({"shipment_id": shipment_id}, {"_id": 0})
    if not sched:
        raise HTTPException(status_code=404, detail="Programación no encontrada")
    await db.scheduled_shipments.delete_one({"shipment_id": shipment_id})
    await log_activity(user, "unschedule_shipment", {"order_number": sched.get("order_number")})
    return {"message": "Envío desprogramado", "order_number": sched.get("order_number")}
