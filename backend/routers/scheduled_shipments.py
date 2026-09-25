"""Envíos programados (Scheduled Shipments) — programador tipo hoja de embarques.

Reemplaza a la hoja de Google "shipping miranda" (una pestaña por semana): la
semana se ve Lunes→Viernes con FECHAS REALES y cada día tiene uno o varios
bloques de EXPORT (embarque = un camión que cruza):

  EXPORT#76 · PLGTS 09-26-0076 & PLSKT 09-26-0076 · TEC.184 / 53145 · VERDE
  MARTES 22 SEP · CORTE 03:00 PM · EXPORT HR 05:00 PM
  CUSTOMER | SHIPPING# | DELIVER TO | BRANDING | ORDER | CUSTOMER PO | DESIGN # | PCS | STATUS | …

Modelo (dos colecciones):
  db.shipping_exports    → el bloque (encabezado): fecha, nº de export, PL,
                           transporte, semáforo aduanal, hora de corte / salida.
  db.scheduled_shipments → las LÍNEAS (una orden dentro de un export). Una orden
                           puede ir en varias líneas (parciales: "304 - #1/#2").
                           Cliente / branding / PO / design / qty se unen EN VIVO
                           desde la orden al leer; la línea sólo guarda lo propio
                           del embarque (PCS, shipping#, destino, status…).
                           Una línea "manual" (orden que no existe en el CRM)
                           guarda esos datos en `manual_fields`.

Formato anterior (ago-2026, mes → semana 1..5 → envío): sus documentos NO tienen
`export_id` y siguen intactos (GET "" y el POST "" histórico los atienden para la
API de clientes y el Dashboard); el programador nuevo sólo muestra líneas con
`export_id`.

Endpoints (prefijo /api/scheduled-shipments):
  GET    ""                          → todas las líneas unidas (forma histórica {items, weeks})
  POST   ""                          → [histórico] programa por mes/semana (idempotente por orden)
  GET    "/week?start=YYYY-MM-DD"    → exports + líneas de la semana (lunes..domingo)
  GET    "/summary?year=YYYY"        → conteos por semana del año (navegador Año → Mes → Semana)
  POST   "/exports"                  → crea un bloque de export en una fecha
  PUT    "/exports/{export_id}"      → edita encabezado (o lo mueve de fecha, arrastrando líneas)
  POST   "/exports/{export_id}/assign-number" → siguiente EXPORT# consecutivo
  DELETE "/exports/{export_id}"      → borra el bloque (409 si tiene líneas, salvo ?cascade=true)
  POST   "/lines"                    → agrega orden(es) a un export
  POST   "/lines/{shipment_id}/duplicate" → clona una línea (para partir un envío)
  PUT    "/{shipment_id}"            → edita una línea (o la mueve de export / fecha)
  DELETE "/{shipment_id}"            → quita la línea
"""
import re
import uuid
from datetime import datetime, timezone, date, timedelta

from fastapi import APIRouter, Request, HTTPException

from deps import db, require_auth, log_activity, require_api_customer
from services.qty_embarcada import qty_embarcada, qty_embarcada_por_orden, entero_o_none

# Extrae etiqueta|url de un comentario [file]etiqueta|url[/file] (packing_link_seed).
_FILE_RE = re.compile(r"\[file\](.*?)\|(.*?)\[/file\]")
_TIME_RE = re.compile(r"^([01]\d|2[0-3]):[0-5]\d$")

router = APIRouter(prefix="/api/scheduled-shipments", tags=["scheduled-shipments"])

PAPELERA = "PAPELERA DE RECICLAJE"

# Catálogos de la hoja (validación de lo que se escribe). STATUSES = el
# desplegable de la pestaña "21 SEP - 25 SEP", en su mismo orden.
STATUSES = ["READY TO SHIP", "IN SETUP", "SURTIDO A PISO", "NECK READY", "PRINTED", "PACKAGED READY",
            "QC READY", "CANCELLED", "SE MUEVE FECHA", "PRINTING", "PRIORITY"]
# STATUS automático = equivalencia con MOS definida por Envíos (2026-09-25).
# READY TO SHIP y PRIORITY son SÓLO manuales. EN PRODUCCION se parte por piezas
# impresas (production_logs): sin piezas = IN SETUP, con piezas = PRINTING.
# Status de MOS sin equivalencia → sin status automático (se elige a mano).
AUTO_FROM_PRODUCTION = {
    "CANCELLED": "CANCELLED",
    "LISTO PARA ENVIO": "QC READY",
    "NECESITA QC": "PACKAGED READY",
    "NECESITA EMPACAR": "PRINTED",
    "LABEL LISTO": "NECK READY",
}
BLANK_COUNTED = ("CONTADO", "CONTADO/PICKED")     # → SURTIDO A PISO
# Status de MOS posteriores a la impresión sin equivalencia: ahí el blank
# contado ya no describe la orden (mostraría SURTIDO A PISO a una orden en
# empaque), así que quedan sin status automático.
PAST_FLOOR = {"EN PROCESO DE EMPAQUE", "CORRECIÓN DE QC", "CORRECCION DE QC",
              "LISTO PARA FULFILLMENT", "LISTO PARA INVENTARIO"}


def _auto_status(order: dict | None) -> str | None:
    """STATUS que corresponde a la orden según MOS (None = sin equivalencia)."""
    if not order:
        return None
    ps = str(order.get("production_status") or "").strip().upper()
    if ps == "EN PRODUCCION":
        return "PRINTING" if (order.get("_printed") or 0) > 0 else "IN SETUP"
    if ps in AUTO_FROM_PRODUCTION:
        return AUTO_FROM_PRODUCTION[ps]
    if ps in PAST_FLOOR:
        return None
    if str(order.get("blank_status") or "").strip().upper() in BLANK_COUNTED:
        return "SURTIDO A PISO"
    return None
CUSTOMS_LIGHTS = ["VERDE", "ROJO"]
PRIORITIES = [1, 2, 3, 4]
DEFAULT_CUTOFF = "15:00"
DEFAULT_EXPORT_TIME = "17:00"
# Sugerencias iniciales de autocompletado (se suman a lo ya capturado).
DEFAULT_SUGGEST = {
    "delivery_to": ["ST ANDREWS", "RL JONES"],
    "ship_from": ["ST ANDREWS"],
    "carrier": ["UPS GROUND", "FEDEX GROUND"],
}
MANUAL_KEYS = ("client", "branding", "customer_po", "design_num", "quantity")

# Campos de la orden que la tabla necesita mostrar (unidos al leer).
_ORDER_PROJ = {
    "_id": 0, "order_id": 1, "order_number": 1, "customer_po": 1, "design_#": 1, "design_num": 1,
    "cancel_date": 1, "ship_by": 1, "client": 1, "branding": 1, "quantity": 1,
    "production_status": 1, "board": 1, "notes": 1, "blank_status": 1,
    "packing_link": 1, "packing_link_label": 1, "packing_link_at": 1,
}


def _now():
    return datetime.now(timezone.utc).isoformat()


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


def _req_date(raw, campo="date") -> str:
    d = _parse_date(raw)
    if d is None:
        raise HTTPException(status_code=400, detail=f"{campo} (YYYY-MM-DD) requerido")
    return d.isoformat()


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


MAX_ENVIOS = 50


def _valid_shipment_no(v):
    n = int(v)
    if not (1 <= n <= MAX_ENVIOS):
        raise ValueError
    return n


def _txt(v, maxlen=200):
    """Texto libre normalizado: None si viene vacío."""
    if v is None:
        return None
    s = str(v).strip()[:maxlen]
    return s or None


def _time(v, campo):
    s = _txt(v, 5)
    if s is None:
        return None
    if not _TIME_RE.match(s):
        raise HTTPException(status_code=400, detail=f"{campo} debe ser HH:MM (24 h)")
    return s


def _int_or_none(v, campo, lo=0, hi=10_000_000):
    if v in (None, ""):
        return None
    try:
        n = int(float(str(v).replace(",", "")))
    except (TypeError, ValueError):
        raise HTTPException(status_code=400, detail=f"{campo} debe ser numérico")
    if not (lo <= n <= hi):
        raise HTTPException(status_code=400, detail=f"{campo} fuera de rango")
    return n


def _qty_int(v):
    """qty de la orden como entero; tolera texto con separador de miles ("10,436")."""
    n = entero_o_none(v)
    if n is None and isinstance(v, str):
        n = entero_o_none(v.replace(",", "").strip())
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
    mf = sched.get("manual_fields") or {}
    # PL (packing list): campo packing_link* de la orden, o el comentario
    # packing_link_seed más fresco. Misma lógica que el modal de comentarios.
    pl_label = o.get("packing_link_label")
    pl_url = o.get("packing_link")
    pl_at = str(o.get("packing_link_at") or "")
    if pl_seed and (not pl_url or str(pl_seed.get("at") or "") >= pl_at):
        pl_label = pl_seed.get("label") or pl_label
        pl_url = pl_seed.get("url") or pl_url
    deadline = o.get("ship_by") or o.get("cancel_date")
    ship_d = _parse_date(sched.get("ship_date"))
    dl = _parse_date(deadline)
    return {
        "pl_number": pl_label or None,
        "pl_url": pl_url or None,
        "shipment_id": sched.get("shipment_id"),
        "order_number": sched.get("order_number"),
        # ── Programador por export (formato actual) ──
        "export_id": sched.get("export_id"),
        "ship_date": sched.get("ship_date"),
        "pcs": sched.get("pcs"),
        "shipping_no": sched.get("shipping_no"),
        "priority": sched.get("priority"),
        "ship_notes": sched.get("ship_notes"),
        "ship_from": sched.get("ship_from"),
        "carrier": sched.get("carrier"),
        "manual": bool(sched.get("manual")),
        "position": sched.get("position"),
        # LATE: la fecha de salida cae después del límite de la orden.
        "late": bool(ship_d and dl and ship_d > dl),
        # STATUS: `status` es lo elegido a mano (override); si está vacío manda
        # el automático de MOS. `status_effective` es lo que se muestra.
        "status_auto": _auto_status(order),
        "status_effective": sched.get("status") or _auto_status(order),
        # SE MUEVE FECHA: el cancel date cambió desde que se programó.
        "cancel_date_at_schedule": sched.get("cancel_date_at_schedule"),
        "cancel_moved": bool(
            order and sched.get("cancel_date_at_schedule")
            and str(o.get("cancel_date") or "")[:10] != str(sched["cancel_date_at_schedule"])[:10]),
        # ── Formato anterior (mes → semana → envío) ──
        "scheduled_year": sched.get("scheduled_year"),
        "scheduled_month": sched.get("scheduled_month"),   # 1..12
        "scheduled_week": sched.get("scheduled_week"),     # 1..5 (semana del mes)
        "shipment_no": sched.get("shipment_no") or 1,      # envío dentro de la semana

        "scheduled_export_date": sched.get("scheduled_export_date"),
        "delivery_to": sched.get("delivery_to"),
        "pl_export": sched.get("pl_export"),
        "status": sched.get("status"),
        # Unidos de la orden (fuente de verdad viva); línea manual = sus propios datos.
        "customer_po": o.get("customer_po") or mf.get("customer_po"),
        "design_num": o.get("design_#") or o.get("design_num") or mf.get("design_num"),
        "cancel_date": o.get("cancel_date"),
        # Tarea 3.1: fecha limite de ENVIO, independiente de cancel_date.
        "ship_by": o.get("ship_by"),
        "client": o.get("client") or mf.get("client"),
        "branding": o.get("branding") or mf.get("branding"),
        "quantity": o.get("quantity") if order else mf.get("quantity"),
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
        "days_com": _days_com(deadline),
        "order_exists": order is not None,
        "created_at": sched.get("created_at"),
        "updated_at": sched.get("updated_at"),
    }


async def _orders_for(nums):
    """Órdenes vivas (sin papelera) + PL sembrado más fresco, por número."""
    nums = [n for n in nums if n]
    if not nums:
        return {}, {}
    # Excluir PAPELERA: hay order_number gemelos y la copia vieja vive en la basura
    # sin packing; sin esto el join podía traer los datos de la gemela equivocada.
    orders = await db.orders.find(
        {"order_number": {"$in": nums}, "board": {"$ne": PAPELERA}}, _ORDER_PROJ,
    ).to_list(5000)
    by_num = {o["order_number"]: o for o in orders if o.get("order_number")}
    # Piezas impresas (production_logs) sólo de las que están EN PRODUCCION:
    # es lo que separa IN SETUP de PRINTING en el STATUS automático.
    en_prod = [o["order_id"] for o in orders
               if o.get("order_id") and str(o.get("production_status") or "").strip().upper() == "EN PRODUCCION"]
    if en_prod:
        printed = await db.production_logs.aggregate([
            {"$match": {"order_id": {"$in": en_prod}}},
            {"$group": {"_id": "$order_id", "n": {"$sum": "$quantity_produced"}}},
        ]).to_list(5000)
        n_by_oid = {r["_id"]: r.get("n") or 0 for r in printed}
        for o in orders:
            if o.get("order_id") in n_by_oid:
                o["_printed"] = n_by_oid[o["order_id"]]
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
    return by_num, pl_by_num


async def _rows(scheds, by_num=None, pl_by_num=None):
    nums = [s.get("order_number") for s in scheds if s.get("order_number")]
    if by_num is None:
        by_num, pl_by_num = await _orders_for(list(set(nums)))
    # Tarea 4.1: unidades embarcadas por orden en un solo cálculo para toda la
    # lista (se piden por número aunque la orden ya no exista — la bitácora manda).
    embarcado = await qty_embarcada_por_orden(db, [
        {"order_number": n, "order_id": by_num.get(n, {}).get("order_id")} for n in set(nums)])
    return [_row(s, by_num.get(s.get("order_number")), (pl_by_num or {}).get(s.get("order_number")),
                 qty_shipped=embarcado.get(s.get("order_number"), 0))
            for s in scheds]


async def _one_row(sched):
    return (await _rows([sched]))[0]


def _export_out(e: dict) -> dict:
    return {k: e.get(k) for k in (
        "export_id", "date", "position", "export_no", "pl_numbers", "truck", "customs_light",
        "cutoff_time", "export_time", "notes", "created_at", "updated_at", "created_by_name")}


async def _get_export(export_id) -> dict:
    exp = await db.shipping_exports.find_one({"export_id": export_id}, {"_id": 0})
    if not exp:
        raise HTTPException(status_code=404, detail="Export no encontrado")
    return exp


async def _new_export(user, day_iso: str, cutoff=None, export_time=None) -> dict:
    count = await db.shipping_exports.count_documents({"date": day_iso})
    now = _now()
    doc = {
        "export_id": str(uuid.uuid4()),
        "date": day_iso,
        "position": count,
        "export_no": None,
        "pl_numbers": None,
        "truck": None,
        "customs_light": None,
        "cutoff_time": cutoff or DEFAULT_CUTOFF,
        "export_time": export_time or DEFAULT_EXPORT_TIME,
        "notes": None,
        "created_by": user.get("user_id"),
        "created_by_name": user.get("name", user.get("email")),
        "created_at": now,
        "updated_at": now,
    }
    await db.shipping_exports.insert_one(dict(doc))
    return doc


def _date_fields(day_iso: str) -> dict:
    """Campos de fecha que viajan con la línea. `scheduled_export_date` lo lee
    el Dashboard (reloj + dd/mm en la tarjeta de la orden)."""
    d = _parse_date(day_iso)
    return {"ship_date": day_iso, "scheduled_export_date": day_iso,
            "scheduled_year": d.year, "scheduled_month": d.month}


# ─────────────────────────────────────────────────────────────────────────────
# Lectura
# ─────────────────────────────────────────────────────────────────────────────

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
    by_num, pl_by_num = await _orders_for(list({s.get("order_number") for s in scheds}))
    # Config del calendario del formato anterior (se conserva en la respuesta
    # por contrato; el programador actual no la usa).
    weeks = await db.scheduled_week_envios.find({}, {"_id": 0}).to_list(5000)
    # Tarea 2.3: con llave de API se filtra ANTES de derivar cantidades — no
    # se paga el cálculo de órdenes que no van a salir.
    if filtro_cliente:
        scheds = [s for s in scheds
                  if _orden_del_cliente(by_num.get(s.get("order_number")), filtro_cliente)]
    items = await _rows(scheds, by_num, pl_by_num)
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


@router.get("/week")
async def get_week(request: Request, start: str | None = None):
    """Semana del programador: exports (bloques) y líneas de lunes a domingo
    de la semana que contiene `start` (default: hoy)."""
    await require_auth(request)
    d = _parse_date(start) or datetime.now(timezone.utc).date()
    monday = d - timedelta(days=d.weekday())
    sunday = monday + timedelta(days=6)
    exports = await db.shipping_exports.find(
        {"date": {"$gte": monday.isoformat(), "$lte": sunday.isoformat()}}, {"_id": 0},
    ).sort([("date", 1), ("position", 1), ("created_at", 1)]).to_list(500)
    ids = [e["export_id"] for e in exports]
    scheds = await db.scheduled_shipments.find(
        {"export_id": {"$in": ids}}, {"_id": 0},
    ).sort([("position", 1), ("created_at", 1)]).to_list(5000) if ids else []
    lines = await _rows(scheds)
    # Siguiente EXPORT# sugerido = el mayor capturado + 1.
    top = await db.shipping_exports.find(
        {"export_no": {"$ne": None}}, {"_id": 0, "export_no": 1},
    ).sort("export_no", -1).limit(1).to_list(1)
    suggest = {}
    for k, base in DEFAULT_SUGGEST.items():
        vals = await db.scheduled_shipments.distinct(k, {"export_id": {"$exists": True}})
        suggest[k] = sorted({*(v for v in vals if v), *base})
    return {
        "week_start": monday.isoformat(),
        "week_end": sunday.isoformat(),
        "exports": [_export_out(e) for e in exports],
        "lines": lines,
        "next_export_no": ((top[0]["export_no"] if top else 0) or 0) + 1,
        "statuses": STATUSES,
        "customs_lights": CUSTOMS_LIGHTS,
        "suggest": suggest,
    }


@router.get("/summary")
async def year_summary(request: Request, year: int | None = None):
    """Conteos por semana (lunes) de un año para el navegador Año → Mes →
    Semana: exports, líneas y piezas. Incluye las semanas que cruzan de año."""
    await require_auth(request)
    y = year or datetime.now(timezone.utc).year
    if not (2000 <= y <= 2100):
        raise HTTPException(status_code=400, detail="year fuera de rango")
    lo = (date(y, 1, 1) - timedelta(days=6)).isoformat()
    hi = (date(y, 12, 31) + timedelta(days=6)).isoformat()
    exports = await db.shipping_exports.find(
        {"date": {"$gte": lo, "$lte": hi}}, {"_id": 0, "export_id": 1, "date": 1}).to_list(5000)
    week_of = {}
    weeks = {}
    for e in exports:
        d = _parse_date(e.get("date"))
        if not d:
            continue
        ws = (d - timedelta(days=d.weekday())).isoformat()
        week_of[e["export_id"]] = ws
        weeks.setdefault(ws, {"week_start": ws, "exports": 0, "lines": 0, "pcs": 0})["exports"] += 1
    if week_of:
        agg = await db.scheduled_shipments.aggregate([
            {"$match": {"export_id": {"$in": list(week_of)}}},
            {"$group": {"_id": "$export_id", "n": {"$sum": 1},
                        "pcs": {"$sum": {"$cond": [{"$eq": ["$status", "CANCELLED"]}, 0, {"$ifNull": ["$pcs", 0]}]}}}},
        ]).to_list(5000)
        for r in agg:
            w = weeks[week_of[r["_id"]]]
            w["lines"] += r["n"]
            w["pcs"] += r["pcs"] or 0
    # Años con datos (para listar años anteriores al actual si los hay).
    first = await db.shipping_exports.find({}, {"_id": 0, "date": 1}).sort("date", 1).limit(1).to_list(1)
    return {"year": y, "weeks": sorted(weeks.values(), key=lambda w: w["week_start"]),
            "first_year": int(first[0]["date"][:4]) if first else None}


# ─────────────────────────────────────────────────────────────────────────────
# Exports (bloques / encabezados)
# ─────────────────────────────────────────────────────────────────────────────

@router.post("/exports")
async def create_export(request: Request):
    user = await require_auth(request)
    body = await request.json()
    day_iso = _req_date(body.get("date"))
    doc = await _new_export(user, day_iso,
                            _time(body.get("cutoff_time"), "cutoff_time"),
                            _time(body.get("export_time"), "export_time"))
    await log_activity(user, "create_shipping_export", {"export_id": doc["export_id"], "date": day_iso})
    return _export_out(doc)


@router.put("/exports/{export_id}")
async def update_export(export_id: str, request: Request):
    user = await require_auth(request)
    exp = await _get_export(export_id)
    body = await request.json()
    upd = {}
    if "export_no" in body:
        upd["export_no"] = _int_or_none(body["export_no"], "export_no", 1, 1_000_000)
    for k, n in (("pl_numbers", 200), ("truck", 120), ("notes", 500)):
        if k in body:
            upd[k] = _txt(body[k], n)
    if "customs_light" in body:
        v = _txt(body["customs_light"])
        v = v.upper() if v else None
        if v and v not in CUSTOMS_LIGHTS:
            raise HTTPException(status_code=400, detail=f"customs_light debe ser {CUSTOMS_LIGHTS}")
        upd["customs_light"] = v
    for k in ("cutoff_time", "export_time"):
        if k in body:
            upd[k] = _time(body[k], k)
    moved_to = None
    if "date" in body:
        new_day = _req_date(body["date"])
        if new_day != exp.get("date"):
            moved_to = new_day
            upd["date"] = new_day
            upd["position"] = await db.shipping_exports.count_documents({"date": new_day})
    if not upd:
        raise HTTPException(status_code=400, detail="Nada que actualizar")
    upd["updated_at"] = _now()
    await db.shipping_exports.update_one({"export_id": export_id}, {"$set": upd})
    if moved_to:
        # El día es del EXPORT: moverlo arrastra todas sus líneas.
        await db.scheduled_shipments.update_many(
            {"export_id": export_id}, {"$set": {**_date_fields(moved_to), "updated_at": upd["updated_at"]}})
    await log_activity(user, "update_shipping_export", {"export_id": export_id, **upd})
    return _export_out(await _get_export(export_id))


@router.post("/exports/{export_id}/assign-number")
async def assign_export_number(export_id: str, request: Request):
    """Asigna el siguiente EXPORT# consecutivo (mayor capturado + 1)."""
    user = await require_auth(request)
    exp = await _get_export(export_id)
    if exp.get("export_no"):
        return _export_out(exp)
    top = await db.shipping_exports.find(
        {"export_no": {"$ne": None}}, {"_id": 0, "export_no": 1},
    ).sort("export_no", -1).limit(1).to_list(1)
    nxt = ((top[0]["export_no"] if top else 0) or 0) + 1
    await db.shipping_exports.update_one(
        {"export_id": export_id, "export_no": None}, {"$set": {"export_no": nxt, "updated_at": _now()}})
    await log_activity(user, "assign_export_number", {"export_id": export_id, "export_no": nxt})
    return _export_out(await _get_export(export_id))


@router.delete("/exports/{export_id}")
async def delete_export(export_id: str, request: Request, cascade: bool = False):
    user = await require_auth(request)
    exp = await _get_export(export_id)
    n = await db.scheduled_shipments.count_documents({"export_id": export_id})
    if n and not cascade:
        raise HTTPException(status_code=409, detail=f"El export tiene {n} línea(s); confirma para borrarlas también")
    if n:
        await db.scheduled_shipments.delete_many({"export_id": export_id})
    await db.shipping_exports.delete_one({"export_id": export_id})
    await log_activity(user, "delete_shipping_export",
                       {"export_id": export_id, "date": exp.get("date"), "export_no": exp.get("export_no"), "lines": n})
    return {"message": "Export eliminado", "lines_deleted": n}


# ─────────────────────────────────────────────────────────────────────────────
# Líneas
# ─────────────────────────────────────────────────────────────────────────────

def _split_numbers(raw) -> list:
    if isinstance(raw, list):
        items = raw
    else:
        items = re.split(r"[\s,;]+", str(raw or ""))
    out = []
    for x in items:
        s = str(x).strip().lstrip("#")
        if s and s not in out:
            out.append(s)
    return out


@router.post("/lines")
async def add_lines(request: Request):
    """Agrega una o varias órdenes a un export. Las que no existen en el CRM se
    reportan en `not_found` (o se agregan como línea manual con manual=true).
    Una orden ya presente en ESTE export se omite (para partirla: duplicar)."""
    user = await require_auth(request)
    body = await request.json()
    exp = await _get_export(body.get("export_id"))
    nums = _split_numbers(body.get("order_numbers") or body.get("order_number"))
    if not nums:
        raise HTTPException(status_code=400, detail="order_numbers requerido")
    if len(nums) > 200:
        raise HTTPException(status_code=400, detail="Máximo 200 órdenes por captura")
    manual = bool(body.get("manual"))
    by_num, pl_by_num = await _orders_for(nums)
    existing = await db.scheduled_shipments.find(
        {"export_id": exp["export_id"]}, {"_id": 0},
    ).sort([("position", 1), ("created_at", 1)]).to_list(5000)
    in_export = {s.get("order_number") for s in existing}
    # Otras exports donde ya va la orden (aviso, no bloqueo: puede ser parcial).
    elsewhere = await db.scheduled_shipments.find(
        {"order_number": {"$in": nums}, "export_id": {"$exists": True, "$ne": exp["export_id"]}},
        {"_id": 0, "order_number": 1, "ship_date": 1},
    ).to_list(1000)
    also_in = {}
    for s in elsewhere:
        also_in.setdefault(s["order_number"], []).append(s.get("ship_date"))
    # Heredan lo que suele repetirse en el bloque (como arrastrar la celda en la
    # hoja): el último valor capturado de cada campo, aunque el renglón final
    # lo tenga vacío.
    inherit = {}
    for k in ("shipping_no", "delivery_to", "ship_from", "carrier"):
        inherit[k] = next((s.get(k) for s in reversed(existing) if s.get(k)), None)
    pos = (max((s.get("position") or 0) for s in existing) + 1) if existing else 0
    now = _now()
    added, not_found, dup = [], [], []
    for n in nums:
        if n in in_export:
            dup.append(n)
            continue
        order = by_num.get(n)
        if not order and not manual:
            not_found.append(n)
            continue
        doc = {
            "shipment_id": str(uuid.uuid4()),
            "order_number": n,
            "export_id": exp["export_id"],
            **_date_fields(exp["date"]),
            "position": pos,
            "pcs": _qty_int(order.get("quantity")) if order else None,
            # Base para detectar SE MUEVE FECHA (cancel date cambió después).
            "cancel_date_at_schedule": (order or {}).get("cancel_date") or None,
            **inherit,
            "status": None,
            "priority": None,
            "ship_notes": None,
            "manual": order is None,
            "manual_fields": {},
            "created_by": user.get("user_id"),
            "created_by_name": user.get("name", user.get("email")),
            "created_at": now,
            "updated_at": now,
        }
        await db.scheduled_shipments.insert_one(dict(doc))
        added.append(doc)
        in_export.add(n)
        pos += 1
    if added:
        await log_activity(user, "add_shipping_lines", {
            "export_id": exp["export_id"], "date": exp["date"],
            "orders": [d["order_number"] for d in added]})
    rows = await _rows(added, by_num, pl_by_num) if added else []
    return {"added": rows, "not_found": not_found, "duplicates": dup,
            "also_in": {k: v for k, v in also_in.items() if k in {d["order_number"] for d in added}}}


@router.post("/lines/{shipment_id}/duplicate")
async def duplicate_line(shipment_id: str, request: Request):
    """Clona una línea en su mismo export (envío partido: "304 - #1 / #2")."""
    user = await require_auth(request)
    src = await db.scheduled_shipments.find_one({"shipment_id": shipment_id}, {"_id": 0})
    if not src or not src.get("export_id"):
        raise HTTPException(status_code=404, detail="Línea no encontrada")
    now = _now()
    doc = {**src, "shipment_id": str(uuid.uuid4()), "position": (src.get("position") or 0) + 0.5,
           "pcs": None, "created_by": user.get("user_id"),
           "created_by_name": user.get("name", user.get("email")), "created_at": now, "updated_at": now}
    await db.scheduled_shipments.insert_one(dict(doc))
    await _renumber(src["export_id"])
    await log_activity(user, "duplicate_shipping_line", {"from": shipment_id, "order_number": src.get("order_number")})
    return await _one_row(await db.scheduled_shipments.find_one({"shipment_id": doc["shipment_id"]}, {"_id": 0}))


async def _renumber(export_id):
    lines = await db.scheduled_shipments.find(
        {"export_id": export_id}, {"_id": 0, "shipment_id": 1, "position": 1, "created_at": 1},
    ).to_list(5000)
    lines.sort(key=lambda s: (s.get("position") or 0, s.get("created_at") or ""))
    for i, s in enumerate(lines):
        if s.get("position") != i:
            await db.scheduled_shipments.update_one({"shipment_id": s["shipment_id"]}, {"$set": {"position": i}})


# ─────────────────────────────────────────────────────────────────────────────
# Formato anterior (API de clientes): programar por mes / semana del mes
# ─────────────────────────────────────────────────────────────────────────────

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
        {"order_number": order_number, "board": {"$ne": PAPELERA}}, _ORDER_PROJ,
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

    now = _now()
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
    # Idempotente por order_number DENTRO del formato anterior: nunca pisa una
    # línea del programador por export (esas no tienen esta semántica).
    legacy_q = {"order_number": order_number, "export_id": {"$exists": False}}
    existing = await db.scheduled_shipments.find_one(legacy_q, {"_id": 0, "shipment_id": 1})
    if existing:
        await db.scheduled_shipments.update_one(legacy_q, {"$set": fields})
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


# ─────────────────────────────────────────────────────────────────────────────
# Edición / borrado de una línea (ambos formatos)
# ─────────────────────────────────────────────────────────────────────────────

@router.put("/{shipment_id}")
async def update_scheduled(shipment_id: str, request: Request):
    user = await require_auth(request)
    sched0 = await db.scheduled_shipments.find_one({"shipment_id": shipment_id}, {"_id": 0})
    if not sched0:
        raise HTTPException(status_code=404, detail="Programación no encontrada")
    # Tarea 2.3: con llave de API, la programación debe ser del cliente
    # (verificado ANTES de escribir nada).
    filtro_cliente = require_api_customer(user, request)
    if filtro_cliente:
        orden0 = await db.orders.find_one(
            {"order_number": sched0.get("order_number"), "board": {"$ne": PAPELERA}},
            {"_id": 0, "client": 1})
        if not _orden_del_cliente(orden0, filtro_cliente):
            raise HTTPException(status_code=403, detail="La programación no pertenece al cliente consultado.")
    body = await request.json()
    allowed = {}
    for k in ("scheduled_export_date", "pl_export"):
        if k in body:
            allowed[k] = body[k] or None
    for k, n in (("delivery_to", 120), ("shipping_no", 40), ("ship_from", 120),
                 ("carrier", 120), ("ship_notes", 500)):
        if k in body:
            allowed[k] = _txt(body[k], n)
    if "status" in body:
        st = _txt(body["status"])
        st = st.upper() if st else None
        if st and sched0.get("export_id") and st not in STATUSES:
            raise HTTPException(status_code=400, detail=f"status inválido; opciones: {STATUSES}")
        allowed["status"] = st
    if "pcs" in body:
        allowed["pcs"] = _int_or_none(body["pcs"], "pcs")
    if "priority" in body:
        p = _int_or_none(body["priority"], "priority", 1, 4)
        allowed["priority"] = p
    if "manual_fields" in body:
        if not sched0.get("manual"):
            raise HTTPException(status_code=400, detail="Solo las líneas manuales editan cliente/branding/PO/design")
        mf = dict(sched0.get("manual_fields") or {})
        for k in MANUAL_KEYS:
            if k in (body["manual_fields"] or {}):
                mf[k] = _txt(body["manual_fields"][k], 120)
        allowed["manual_fields"] = mf
    # Mover de export (mismo u otro día) o a otra fecha (primer export de ese
    # día; si no hay, se crea uno con horarios default).
    target = None
    if body.get("export_id") and body["export_id"] != sched0.get("export_id"):
        target = await _get_export(body["export_id"])
    elif body.get("move_to_date"):
        day_iso = _req_date(body["move_to_date"], "move_to_date")
        target = await db.shipping_exports.find_one(
            {"date": day_iso}, {"_id": 0}, sort=[("position", 1), ("created_at", 1)])
        if not target:
            target = await _new_export(user, day_iso)
    if target:
        n_target = await db.scheduled_shipments.count_documents({"export_id": target["export_id"]})
        allowed.update({"export_id": target["export_id"], "position": n_target, **_date_fields(target["date"])})
    # Formato anterior: mover a otro mes/semana/año/envío (con validación).
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
    allowed["updated_at"] = _now()
    await db.scheduled_shipments.update_one({"shipment_id": shipment_id}, {"$set": allowed})
    if target and sched0.get("export_id"):
        await _renumber(sched0["export_id"])
    sched = await db.scheduled_shipments.find_one({"shipment_id": shipment_id}, {"_id": 0})
    await log_activity(user, "update_scheduled_shipment", {
        "shipment_id": shipment_id, "order_number": sched0.get("order_number"),
        **{k: v for k, v in allowed.items() if k != "manual_fields"}})
    return await _one_row(sched)


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
            {"order_number": sched.get("order_number"), "board": {"$ne": PAPELERA}},
            {"_id": 0, "client": 1})
        if not _orden_del_cliente(orden0, filtro_cliente):
            raise HTTPException(status_code=403, detail="La programación no pertenece al cliente consultado.")
    await db.scheduled_shipments.delete_one({"shipment_id": shipment_id})
    if sched.get("export_id"):
        await _renumber(sched["export_id"])
    await log_activity(user, "unschedule_shipment", {
        "order_number": sched.get("order_number"), "export_id": sched.get("export_id"),
        "ship_date": sched.get("ship_date")})
    return {"message": "Envío desprogramado", "order_number": sched.get("order_number")}
