"""Envíos programados (Scheduled Shipments).

Programador de envíos: se toman órdenes que AÚN no se han enviado (sin el
"camioncito" = sin `packing_link`) y se programan asignándoles una fecha de
exportación planeada y un destino. La programación vive en su propia colección
`db.scheduled_shipments` (no ensucia el modelo de orden); la tabla une esos datos
con la info viva de la orden (cliente, qty, status, cancel_date…) al leer.

'Days Com.' = días desde hoy hasta la fecha límite de envío: ship_by si la
orden lo tiene (Tarea 3.1), si no cancel_date (negativo = vencida).

Endpoints (prefijo /api/scheduled-shipments):
  GET    ""              → lista programados (unidos con datos de la orden)
  POST   ""             → programa una orden (idempotente por order_number)
  PUT    "/{id}"        → edita fecha export / destino / PL / estado
  DELETE "/{id}"        → desprograma
  POST   "/week-config"  → nº de envíos (grupos) de una semana
  POST   "/envio-day"    → coloca un envío en un día de la semana (envio_days)

La cascada del calendario es mes → semana → día → envío: el DÍA es propiedad
del ENVÍO (envio_days en scheduled_week_envios), no de cada orden — mover un
envío de día arrastra sus órdenes. Envíos sin día asignado = "Sin día".
"""
import re
import uuid
from datetime import datetime, timezone

from fastapi import APIRouter, Request, HTTPException

from deps import db, require_auth, log_activity, require_api_customer
from services.qty_embarcada import qty_embarcada, qty_embarcada_por_orden, entero_o_none

# Extrae etiqueta|url de un comentario [file]etiqueta|url[/file] (packing_link_seed).
_FILE_RE = re.compile(r"\[file\](.*?)\|(.*?)\[/file\]")

router = APIRouter(prefix="/api/scheduled-shipments", tags=["scheduled-shipments"])

# Campos de la orden que la tabla necesita mostrar (unidos al leer).
_ORDER_PROJ = {
    "_id": 0, "order_id": 1, "order_number": 1, "customer_po": 1, "design_#": 1, "design_num": 1,
    "cancel_date": 1, "ship_by": 1, "client": 1, "branding": 1, "quantity": 1,
    "production_status": 1, "board": 1, "notes": 1,
    "packing_link": 1, "packing_link_label": 1, "packing_link_at": 1,
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


def _valid_day(v):
    """Día de la semana 1..7 (1=Lunes) para un ENVÍO (grupo). Falsy → None
    ("Sin día"): ahí viven los envíos aún no distribuidos en la semana."""
    if v in (None, "", 0, "0"):
        return None
    d = int(v)
    if not (1 <= d <= 7):
        raise ValueError
    return d


MAX_ENVIOS = 50


def _valid_shipment_no(v):
    n = int(v)
    if not (1 <= n <= MAX_ENVIOS):
        raise ValueError
    return n


def _orden_del_cliente(order: dict | None, filtro_cliente) -> bool:
    """Tarea 2.3: ¿la orden unida pertenece al cliente de la llave? La
    programación no trae cliente propio — lo hereda de su orden; sin orden
    resoluble, para una llave de API la respuesta conservadora es NO."""
    if not order:
        return False
    rx = filtro_cliente["client"]["$regex"]
    return bool(re.match(rx, str(order.get("client") or ""), re.IGNORECASE))


def _row(sched: dict, order: dict | None, pl_seed: dict | None = None,
         qty_shipped: int = 0) -> dict:
    o = order or {}
    # PL (packing list): campo packing_link* de la orden, o el comentario
    # packing_link_seed más fresco. Misma lógica que el modal de comentarios.
    pl_label = o.get("packing_link_label")
    pl_url = o.get("packing_link")
    pl_at = str(o.get("packing_link_at") or "")
    if pl_seed and (not pl_url or str(pl_seed.get("at") or "") >= pl_at):
        pl_label = pl_seed.get("label") or pl_label
        pl_url = pl_seed.get("url") or pl_url
    return {
        "pl_number": pl_label or None,
        "pl_url": pl_url or None,
        "shipment_id": sched.get("shipment_id"),
        "order_number": sched.get("order_number"),
        "scheduled_year": sched.get("scheduled_year"),
        "scheduled_month": sched.get("scheduled_month"),   # 1..12
        "scheduled_week": sched.get("scheduled_week"),     # 1..5 (semana del mes)
        "shipment_no": sched.get("shipment_no") or 1,      # envío dentro de la semana

        "scheduled_export_date": sched.get("scheduled_export_date"),
        "delivery_to": sched.get("delivery_to"),
        "pl_export": sched.get("pl_export"),
        "status": sched.get("status"),
        # Unidos de la orden (fuente de verdad viva)
        "customer_po": o.get("customer_po"),
        "design_num": o.get("design_#") or o.get("design_num"),
        "cancel_date": o.get("cancel_date"),
        # Tarea 3.1: fecha limite de ENVIO, independiente de cancel_date.
        "ship_by": o.get("ship_by"),
        "client": o.get("client"),
        "branding": o.get("branding"),
        "quantity": o.get("quantity"),
        # Tarea 4.1: el par pedido-vs-embarcado. quantity queda tal cual
        # (consumidores actuales); qty_ordered es su lectura numérica y
        # qty_shipped se deriva de la bitácora del WMS (services/qty_embarcada.py).
        "qty_ordered": entero_o_none(o.get("quantity")),
        "qty_shipped": qty_shipped,
        "production_status": o.get("production_status"),
        "board": o.get("board"),
        "notes": o.get("notes"),
        "packing_link": o.get("packing_link"),
        "packing_link_label": o.get("packing_link_label"),
        # days_com: contra ship_by cuando existe; si no, cae a cancel_date
        # (comportamiento historico intacto mientras ship_by no se capture).
        "days_com": _days_com(o.get("ship_by") or o.get("cancel_date")),
        "order_exists": order is not None,
        "created_at": sched.get("created_at"),
        "updated_at": sched.get("updated_at"),
    }


@router.get("")
async def list_scheduled(request: Request, skip: int | None = None,
                         limit: int | None = None):
    user = await require_auth(request)
    # Tarea 2.3: llaves de API solo ven programaciones de SU cliente. El
    # cliente vive en la orden unida, así que se trae todo, se filtra ya
    # unido y la paginación corta al final (volumen chico: es el calendario).
    filtro_cliente = require_api_customer(user, request)
    # Tarea 5.3: paginación bajo demanda. Mandar `skip` (aunque sea 0) activa
    # el sobre {total, skip, limit, items, weeks}; sin `skip` la forma
    # histórica {items, weeks} no cambia (frontend interno intacto) y `limit`
    # solo recorta la lista (default histórico: 5000 = todo).
    limit_v = max(1, min(limit if limit is not None else 5000, 5000))
    cursor = db.scheduled_shipments.find({}, {"_id": 0}).sort("created_at", -1)
    total = skip_v = None
    if filtro_cliente or skip is None:
        scheds = await cursor.to_list(5000 if filtro_cliente else limit_v)
    else:
        skip_v = max(0, skip)
        total = await db.scheduled_shipments.count_documents({})
        scheds = await cursor.skip(skip_v).limit(limit_v).to_list(limit_v)
    nums = [s.get("order_number") for s in scheds if s.get("order_number")]
    # Excluir PAPELERA: hay order_number gemelos y la copia vieja vive en la basura
    # sin packing; sin esto el join podía traer los datos de la gemela equivocada.
    orders = await db.orders.find(
        {"order_number": {"$in": nums}, "board": {"$ne": "PAPELERA DE RECICLAJE"}}, _ORDER_PROJ,
    ).to_list(5000)
    by_num = {o["order_number"]: o for o in orders if o.get("order_number")}
    # PL desde los comentarios packing_link_seed (por order_id), el más fresco por orden.
    oids = [o.get("order_id") for o in orders if o.get("order_id")]
    pl_by_num = {}
    if oids:
        seeds = await db.comments.find(
            {"order_id": {"$in": oids}, "source": "packing_link_seed"},
            {"_id": 0, "order_id": 1, "content": 1, "created_at": 1},
        ).sort("created_at", 1).to_list(5000)
        pl_by_oid = {}
        for c in seeds:  # cronológico: el último gana
            m = _FILE_RE.search(c.get("content") or "")
            if m:
                pl_by_oid[c["order_id"]] = {"label": m.group(1), "url": m.group(2), "at": c.get("created_at") or ""}
        for o in orders:
            seed = pl_by_oid.get(o.get("order_id"))
            if seed and o.get("order_number"):
                pl_by_num[o["order_number"]] = seed
    # Conteo de envíos configurado por semana (para grupos vacíos que sobreviven recarga).
    weeks = await db.scheduled_week_envios.find({}, {"_id": 0}).to_list(5000)
    # Tarea 4.1: unidades embarcadas por orden en un solo cálculo para toda la
    # lista (se piden por número aunque la orden ya no exista — la bitácora manda).
    # Tarea 2.3: con llave de API se filtra ANTES de derivar cantidades — no
    # se paga el cálculo de órdenes que no van a salir.
    if filtro_cliente:
        scheds = [s for s in scheds
                  if _orden_del_cliente(by_num.get(s.get("order_number")), filtro_cliente)]
        nums = [s.get("order_number") for s in scheds if s.get("order_number")]
    embarcado = await qty_embarcada_por_orden(db, [
        {"order_number": n, "order_id": by_num.get(n, {}).get("order_id")} for n in nums])
    items = [_row(s, by_num.get(s.get("order_number")), pl_by_num.get(s.get("order_number")),
                  qty_shipped=embarcado.get(s.get("order_number"), 0))
             for s in scheds]
    if filtro_cliente:
        if skip is not None:
            skip_v, total = max(0, skip), len(items)
            items = items[skip_v:skip_v + limit_v]
        else:
            items = items[:limit_v]
    respuesta = {"items": items, "weeks": weeks}
    if total is not None:
        respuesta = {"total": total, "skip": skip_v, "limit": limit_v, **respuesta}
    return respuesta


@router.post("/week-config")
async def set_week_envios(request: Request):
    """Fija cuántos 'envíos' (grupos) tiene una semana. Permite tener grupos vacíos
    (Envío 3) antes de asignarles órdenes."""
    user = await require_auth(request)
    body = await request.json()
    try:
        year = int(body.get("scheduled_year") or datetime.now(timezone.utc).year)
        month = _valid_month(body.get("scheduled_month"))
        week = _valid_week(body.get("scheduled_week"))
        envios = int(body.get("envios"))
        if not (1 <= envios <= MAX_ENVIOS):
            raise ValueError
    except (TypeError, ValueError):
        raise HTTPException(status_code=400, detail="year/month(1..12)/week(1..5)/envios(1..50) requeridos")
    key = {"scheduled_year": year, "scheduled_month": month, "scheduled_week": week}
    await db.scheduled_week_envios.update_one(key, {"$set": {**key, "envios": envios}}, upsert=True)
    await log_activity(user, "set_week_envios", {**key, "envios": envios})
    doc = await db.scheduled_week_envios.find_one(key, {"_id": 0})
    return doc or {**key, "envios": envios}


@router.post("/envio-day")
async def set_envio_day(request: Request):
    """Coloca un ENVÍO (grupo) en un día de la semana: envio_days["<n>"] = 1..7
    (null = "Sin día"). El día vive en el envío, no en cada orden: mover el
    envío de día arrastra todas sus órdenes."""
    user = await require_auth(request)
    body = await request.json()
    try:
        year = int(body.get("scheduled_year") or datetime.now(timezone.utc).year)
        month = _valid_month(body.get("scheduled_month"))
        week = _valid_week(body.get("scheduled_week"))
        shipment_no = _valid_shipment_no(body.get("shipment_no"))
        day = _valid_day(body.get("day"))
    except (TypeError, ValueError):
        raise HTTPException(status_code=400, detail="year/month(1..12)/week(1..5)/shipment_no(1..50)/day(1..7|null) requeridos")
    key = {"scheduled_year": year, "scheduled_month": month, "scheduled_week": week}
    # $setOnInsert formaliza el conteo cuando la semana aún no tiene config
    # (sus envíos existían solo por órdenes presentes).
    await db.scheduled_week_envios.update_one(
        key,
        {"$set": {f"envio_days.{shipment_no}": day}, "$setOnInsert": {"envios": shipment_no}},
        upsert=True,
    )
    await log_activity(user, "set_envio_day", {**key, "shipment_no": shipment_no, "day": day})
    doc = await db.scheduled_week_envios.find_one(key, {"_id": 0})
    return doc


@router.post("")
async def schedule_shipment(request: Request):
    user = await require_auth(request)
    # Tarea 2.3: con llave de API, la orden a programar debe ser del cliente.
    filtro_cliente = require_api_customer(user, request)
    body = await request.json()
    order_number = str(body.get("order_number") or "").strip()
    if not order_number:
        raise HTTPException(status_code=400, detail="order_number requerido")

    order = await db.orders.find_one(
        {"order_number": order_number, "board": {"$ne": "PAPELERA DE RECICLAJE"}}, _ORDER_PROJ,
    )
    if not order:
        raise HTTPException(status_code=404, detail=f"Orden {order_number} no encontrada")
    if filtro_cliente and not _orden_del_cliente(order, filtro_cliente):
        raise HTTPException(status_code=403, detail="La orden no pertenece al cliente consultado.")

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
    try:
        shipment_no = _valid_shipment_no(body.get("shipment_no") or 1)
    except (TypeError, ValueError):
        shipment_no = 1

    now = datetime.now(timezone.utc).isoformat()
    fields = {
        "scheduled_year": year,
        "scheduled_month": month,
        "scheduled_week": week,
        "shipment_no": shipment_no,
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
    return _row(sched, order, qty_shipped=await qty_embarcada(db, order))


@router.put("/{shipment_id}")
async def update_scheduled(shipment_id: str, request: Request):
    user = await require_auth(request)
    # Tarea 2.3: con llave de API, la programación debe ser del cliente
    # (verificado ANTES de escribir nada).
    filtro_cliente = require_api_customer(user, request)
    if filtro_cliente:
        sched0 = await db.scheduled_shipments.find_one({"shipment_id": shipment_id}, {"_id": 0})
        if not sched0:
            raise HTTPException(status_code=404, detail="Programación no encontrada")
        orden0 = await db.orders.find_one(
            {"order_number": sched0.get("order_number"), "board": {"$ne": "PAPELERA DE RECICLAJE"}},
            {"_id": 0, "client": 1})
        if not _orden_del_cliente(orden0, filtro_cliente):
            raise HTTPException(status_code=403, detail="La programación no pertenece al cliente consultado.")
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
        if "shipment_no" in body:
            allowed["shipment_no"] = _valid_shipment_no(body["shipment_no"])
    except (TypeError, ValueError):
        raise HTTPException(status_code=400, detail="mes (1..12), semana (1..5), año o envío inválidos")
    if not allowed:
        raise HTTPException(status_code=400, detail="Nada que actualizar")
    allowed["updated_at"] = datetime.now(timezone.utc).isoformat()
    res = await db.scheduled_shipments.update_one({"shipment_id": shipment_id}, {"$set": allowed})
    if res.matched_count == 0:
        raise HTTPException(status_code=404, detail="Programación no encontrada")
    sched = await db.scheduled_shipments.find_one({"shipment_id": shipment_id}, {"_id": 0})
    order = await db.orders.find_one({"order_number": sched.get("order_number")}, _ORDER_PROJ)
    await log_activity(user, "update_scheduled_shipment", {"shipment_id": shipment_id, **allowed})
    return _row(sched, order, qty_shipped=await qty_embarcada(
        db, {"order_number": sched.get("order_number"),
             "order_id": (order or {}).get("order_id")}))


@router.delete("/{shipment_id}")
async def unschedule(shipment_id: str, request: Request):
    user = await require_auth(request)
    # Tarea 2.3: con llave de API, solo se puede desprogramar lo del cliente.
    filtro_cliente = require_api_customer(user, request)
    sched = await db.scheduled_shipments.find_one({"shipment_id": shipment_id}, {"_id": 0})
    if not sched:
        raise HTTPException(status_code=404, detail="Programación no encontrada")
    if filtro_cliente:
        orden0 = await db.orders.find_one(
            {"order_number": sched.get("order_number"), "board": {"$ne": "PAPELERA DE RECICLAJE"}},
            {"_id": 0, "client": 1})
        if not _orden_del_cliente(orden0, filtro_cliente):
            raise HTTPException(status_code=403, detail="La programación no pertenece al cliente consultado.")
    await db.scheduled_shipments.delete_one({"shipment_id": shipment_id})
    await log_activity(user, "unschedule_shipment", {"order_number": sched.get("order_number")})
    return {"message": "Envío desprogramado", "order_number": sched.get("order_number")}
