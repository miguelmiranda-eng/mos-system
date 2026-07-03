"""Departamento de Pinturas — calendarización de mezcla de tinta por día y prioridad.

Capa de scheduling sobre las órdenes: cada `paint_task` apunta a una orden real
(order_id) y guarda solo lo propio de pinturas (día programado, prioridad,
estatus de tinta, colores, mezclador). Los datos de la orden (cliente, cantidad,
fecha, prioridad) se unen EN VIVO desde `orders` — no se duplican.
"""
from fastapi import APIRouter, HTTPException, Request
from deps import db, require_auth, require_role, log_activity, logger
from datetime import datetime, timezone, timedelta
import uuid

router = APIRouter(prefix="/api/paint")

WRITE_ROLES = ["paint", "paint_lead"]          # + admin/supersu siempre (SUPER_ROLES)
INK_STATUSES = ("pendiente", "mezclando", "lista")
HOT_PRIORITIES = {"RUSH", "SPECIAL RUSH", "OVERSOLD", "EVENT"}
EXCLUDED_BOARDS = ["PAPELERA DE RECICLAJE", "COMPLETOS", "EDI", "FINAL BILL",
                   "MASTER", "RESPALDO MONDAY", "CANCELLED"]

# Campos de la orden que se muestran en la tarjeta (unidos en vivo).
_ORDER_FIELDS = {"_id": 0, "order_id": 1, "order_number": 1, "client": 1,
                 "branding": 1, "quantity": 1, "color": 1, "priority": 1,
                 "due_date": 1, "cancel_date": 1, "board": 1, "production_status": 1}


def now_iso():
    return datetime.now(timezone.utc).isoformat()


def gen_id(prefix="paint"):
    return f"{prefix}_{uuid.uuid4().hex[:12]}"


async def require_paint_write(request: Request):
    return await require_role(request, WRITE_ROLES)


def _is_hot(order):
    return (order.get("priority") or "").upper() in HOT_PRIORITIES


async def _broadcast(order_id):
    try:
        from ws_manager import ws_manager
        await ws_manager.broadcast({"type": "PAINT_UPDATED", "order_id": order_id})
    except Exception as e:
        logger.error(f"[paint] broadcast failed: {e}")


async def _enrich(tasks):
    """Join each task with its live order fields under `.order`."""
    ids = [t["order_id"] for t in tasks if t.get("order_id")]
    omap = {}
    if ids:
        async for o in db.orders.find({"order_id": {"$in": ids}}, _ORDER_FIELDS):
            omap[o["order_id"]] = o
    for t in tasks:
        t["order"] = omap.get(t.get("order_id"), {})
    return tasks


# ── Tablero de la semana ─────────────────────────────────────────────────────
@router.get("/board")
async def paint_board(request: Request, week: str = ""):
    """Semana lun–sáb. `week` = cualquier fecha de la semana (YYYY-MM-DD)."""
    await require_auth(request)
    try:
        base = datetime.strptime(week, "%Y-%m-%d").date() if week else datetime.now(timezone.utc).date()
    except ValueError:
        base = datetime.now(timezone.utc).date()
    monday = base - timedelta(days=base.weekday())
    days_iso = [(monday + timedelta(days=i)).isoformat() for i in range(6)]   # lun..sáb

    tasks = await db.paint_tasks.find(
        {"scheduled_date": {"$in": days_iso}}, {"_id": 0}
    ).sort([("is_hot", -1), ("priority_rank", 1)]).to_list(2000)
    await _enrich(tasks)

    by_day = {d: [] for d in days_iso}
    for t in tasks:
        by_day.setdefault(t.get("scheduled_date"), []).append(t)
    return {
        "week_start": monday.isoformat(),
        "days": [{"date": d, "tasks": by_day.get(d, [])} for d in days_iso],
        "hot_count": sum(1 for t in tasks if t.get("is_hot")),
        "ready_count": sum(1 for t in tasks if t.get("ink_status") == "lista"),
        "total": len(tasks),
    }


# ── Backlog (sin programar) + sugeridas (arte listo, no en pinturas) ─────────
@router.get("/backlog")
async def paint_backlog(request: Request):
    await require_auth(request)
    tasks = await db.paint_tasks.find(
        {"$or": [{"scheduled_date": None}, {"scheduled_date": {"$exists": False}}]},
        {"_id": 0}
    ).sort([("is_hot", -1), ("priority_rank", 1)]).to_list(500)
    await _enrich(tasks)

    existing = {d["order_id"] for d in
                await db.paint_tasks.find({}, {"_id": 0, "order_id": 1}).to_list(10000)}
    suggested = []
    q = {"board": {"$nin": EXCLUDED_BOARDS},
         "$or": [{"art_sep_status": True}, {"art_neck_status": True}]}
    async for o in db.orders.find(q, _ORDER_FIELDS).limit(300):
        if o.get("order_id") not in existing:
            suggested.append(o)
        if len(suggested) >= 60:
            break
    return {"backlog": tasks, "suggested": suggested}


# ── Agregar una orden a la cola de pinturas ──────────────────────────────────
@router.post("/tasks")
async def add_task(request: Request):
    user = await require_paint_write(request)
    body = await request.json()
    oid = (body.get("order_id") or "").strip()
    onum = (body.get("order_number") or "").strip()
    order = None
    if oid:
        order = await db.orders.find_one({"order_id": oid}, _ORDER_FIELDS)
    if not order and onum:
        order = await db.orders.find_one(
            {"order_number": {"$regex": f"^{onum}$", "$options": "i"}}, _ORDER_FIELDS)
    if not order:
        raise HTTPException(404, "Orden no encontrada")
    if await db.paint_tasks.find_one({"order_id": order["order_id"]}, {"_id": 0}):
        raise HTTPException(409, "La orden ya está en la cola de pinturas")

    doc = {
        "paint_task_id": gen_id(),
        "order_id": order["order_id"],
        "order_number": order.get("order_number"),
        "client": order.get("client"),
        "scheduled_date": body.get("scheduled_date") or None,
        "priority_rank": 0,
        "is_hot": _is_hot(order),
        "ink_status": "pendiente",
        "ink_type": body.get("ink_type") or "",
        "colors": body.get("colors") or [],
        "mixer": "", "mixer_id": "",
        "notes": body.get("notes") or "",
        "started_at": None, "completed_at": None,
        "created_at": now_iso(), "updated_at": now_iso(),
        "created_by": user.get("name"),
    }
    await db.paint_tasks.insert_one(doc)
    doc.pop("_id", None)
    await _enrich([doc])
    await log_activity(user, "paint_task_added", {"order_number": doc["order_number"]})
    await _broadcast(order["order_id"])
    return doc


# ── Actualizar (día, prioridad, colores, tipo, notas) ────────────────────────
@router.put("/tasks/{task_id}")
async def update_task(task_id: str, request: Request):
    user = await require_paint_write(request)
    body = await request.json()
    allowed = ("scheduled_date", "priority_rank", "is_hot", "ink_type", "colors", "mixer", "notes")
    upd = {k: body[k] for k in allowed if k in body}
    if not upd:
        raise HTTPException(400, "Nada que actualizar")
    upd["updated_at"] = now_iso()
    res = await db.paint_tasks.update_one({"paint_task_id": task_id}, {"$set": upd})
    if res.matched_count == 0:
        raise HTTPException(404, "Tarea no encontrada")
    task = await db.paint_tasks.find_one({"paint_task_id": task_id}, {"_id": 0})
    await _enrich([task])
    await _broadcast(task.get("order_id"))
    return task


# ── Reordenar / mover a un día (persiste el drag-and-drop) ───────────────────
@router.post("/reorder")
async def reorder(request: Request):
    user = await require_paint_write(request)
    body = await request.json()
    date = body.get("date")            # None => backlog
    ordered = body.get("ordered_ids") or []
    for i, tid in enumerate(ordered):
        await db.paint_tasks.update_one(
            {"paint_task_id": tid},
            {"$set": {"scheduled_date": date, "priority_rank": i, "updated_at": now_iso()}})
    return {"ok": True, "count": len(ordered)}


# ── Cambiar estatus de tinta (pendiente → mezclando → lista) ─────────────────
@router.put("/tasks/{task_id}/status")
async def set_status(task_id: str, request: Request):
    user = await require_paint_write(request)
    body = await request.json()
    status = (body.get("ink_status") or "").strip().lower()
    if status not in INK_STATUSES:
        raise HTTPException(400, f"ink_status debe ser uno de {INK_STATUSES}")
    upd = {"ink_status": status, "updated_at": now_iso(),
           "mixer": user.get("name"), "mixer_id": user.get("user_id")}
    if status == "mezclando":
        upd["started_at"] = now_iso()
    if status == "lista":
        upd["completed_at"] = now_iso()
    task = await db.paint_tasks.find_one({"paint_task_id": task_id}, {"_id": 0})
    if not task:
        raise HTTPException(404, "Tarea no encontrada")
    await db.paint_tasks.update_one({"paint_task_id": task_id}, {"$set": upd})
    # Señal para producción: la tinta de esta orden ya está lista.
    await db.orders.update_one({"order_id": task["order_id"]},
                               {"$set": {"ink_ready": status == "lista"}})
    await log_activity(user, "paint_status", {"order_number": task.get("order_number"), "ink_status": status})
    await _broadcast(task["order_id"])
    task.update(upd)
    await _enrich([task])
    return task


# ── Sacar de la cola ─────────────────────────────────────────────────────────
@router.delete("/tasks/{task_id}")
async def delete_task(task_id: str, request: Request):
    user = await require_paint_write(request)
    task = await db.paint_tasks.find_one({"paint_task_id": task_id}, {"_id": 0})
    if not task:
        raise HTTPException(404, "Tarea no encontrada")
    await db.paint_tasks.delete_one({"paint_task_id": task_id})
    await log_activity(user, "paint_task_removed", {"order_number": task.get("order_number")})
    await _broadcast(task.get("order_id"))
    return {"ok": True}
