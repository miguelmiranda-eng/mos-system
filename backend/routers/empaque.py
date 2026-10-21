"""Módulo de Empaque — reemplazará al tablero EMPAQUE.

Como Neck, manda la columna Production Status: una orden ENTRA cuando dice
NECESITA EMPACAR o EN PROCESO DE EMPAQUE, esté en el tablero que esté (la
orden ya no se mueve: se queda en SCHEDULING / su máquina). SALE al pasar a
NECESITA QC: ahí empaque entrega a QC, que sigue en su módulo (/qc) con su
candado (locked_by_qc) y es quien la deja LISTO PARA ENVIO.

A diferencia de Blanks / Cuadros / Neck, el plan de máquinas NO prioriza
aquí (la orden ya se imprimió): lo urgente lo marca el ENVÍO. La fecha de
cada orden = su próxima salida en Envíos programados (scheduled_shipments
con export); sin envío programado, su cancel date.

  (Sin Programados: empaque sólo trabaja órdenes ya impresas, no hay nada
  que adelantar.)
  Por empacar   TODAS las NECESITA EMPACAR, por fecha; cada una dice en qué
                máquina se pintó o se está pintando.
  En proceso    EN PROCESO DE EMPAQUE, por fecha.
  Por llegar    (sólo lectura) en máquina con EN PRODUCCION: lo que viene.
  Sugeridas     el DPL (packing list digital de la orden) ya suma la cantidad
                pero el estatus no dice NECESITA QC: el sistema SUGIERE, una
                persona confirma.
  Alertas       en proceso más de STUCK_DAYS días, o la fecha ya pasó.

El DPL se lee de Google Sheets (services/export_packing.fetch_dpl). Nunca
bloquea la cola: se responde con lo que ya está en caché y lo que falta se
descarga en segundo plano (`dpl_pending` > 0 → el frontend recarga una vez).

Escribe sólo `production_status`, por PUT /api/orders/{id} (update_order):
bitácora, guardas, candado de QC, automatizaciones y broadcast. Editan el
rol `empaque` + admin/supersu.

Endpoints (prefijo /api/empaque):
  GET  /queue                 pendientes, proceso, llegando, sugeridas, alertas
  POST /{order_id}/status     {status}
  POST /{order_id}/confirm    NECESITA QC (mandar a QC)
"""
import asyncio
import time
from datetime import datetime, timezone, timedelta, date

import httpx
from fastapi import APIRouter, HTTPException, Request

from deps import db, require_auth, user_roles, SUPER_ROLES, OrderUpdate, get_dynamic_boards, INTAKE_BOARD
from services import order_modules as om
from services import export_packing as pk

router = APIRouter(prefix="/api/empaque")

LIST_MAX = 500
WRITE_ROLES = {"empaque"} | SUPER_ROLES
NEEDS = "NECESITA EMPACAR"
IN_PROCESS = "EN PROCESO DE EMPAQUE"
QC_STATUS = "NECESITA QC"
PRINTING = "EN PRODUCCION"
# Lo que el módulo deja elegir. LISTO PARA ENVIO es de QC.
PACK_STATUSES = [NEEDS, IN_PROCESS, QC_STATUS]
STUCK_DAYS = 3
# Tableros donde una orden ya NO es trabajo vivo de empaque.
DEAD_BOARDS = {"FINAL BILL", "COMPLETOS", "EDI", "CANCELLED", "INVENTARIO", "RESPALDO MONDAY",
               "PAPELERA DE RECICLAJE", "EJEMPLOS", INTAKE_BOARD}
ORDER_PROJ = {"_id": 0, "order_id": 1, "order_number": 1, "client": 1, "branding": 1, "board": 1,
              "quantity": 1, "cancel_date": 1, "ship_by": 1, "design_#": 1, "design_number": 1,
              "style": 1, "color": 1, "priority": 1, "customer_po": 1, "packing_type": 1,
              "production_status_at": 1, "links": 1, "packing_link": 1, "packing_link_label": 1,
              "locked_by_qc": 1, **om.COMPONENT_FIELDS}

# DPL por orden: {order_id: (monotonic, url, parsed|None, error|None)}
DPL_TTL_S = 10 * 60
DPL_CONCURRENCY = 4
_dpl: dict = {}
_dpl_running: set = set()


def _status(o: dict) -> str:
    return str(o.get("production_status") or "").strip().upper()


def _day(v) -> str | None:
    s = str(v or "").strip()[:10]
    try:
        return date.fromisoformat(s).isoformat()
    except ValueError:
        return None


async def _ship_dates(nums: list) -> dict:
    """{order_number: {date, export_id}} — la PRÓXIMA salida de cada orden en
    Envíos programados (sólo el formato actual, con export). Si todas sus
    líneas ya pasaron, la más reciente de las últimas 2 semanas (vencida)."""
    today = date.today().isoformat()
    floor = (date.today() - timedelta(days=14)).isoformat()
    out: dict = {}
    if not nums:
        return out
    cur = db.scheduled_shipments.find(
        {"order_number": {"$in": nums}, "export_id": {"$exists": True, "$ne": None}, "ship_date": {"$gte": floor}},
        {"_id": 0, "order_number": 1, "ship_date": 1, "export_id": 1})
    async for s in cur:
        d = _day(s.get("ship_date"))
        if not d:
            continue
        n = s["order_number"]
        prev = out.get(n)
        if prev is None:
            out[n] = {"date": d, "export_id": s.get("export_id")}
            continue
        # Preferir la próxima futura; entre vencidas, la más reciente.
        pf, nf = prev["date"] >= today, d >= today
        if (nf and (not pf or d < prev["date"])) or (not nf and not pf and d > prev["date"]):
            out[n] = {"date": d, "export_id": s.get("export_id")}
    return out


async def _refresh_dpl(items: list) -> None:
    sem = asyncio.Semaphore(DPL_CONCURRENCY)
    async with httpx.AsyncClient(headers={"User-Agent": "MOS-empaque/1.0"}) as client:
        async def one(oid, url):
            async with sem:
                try:
                    parsed, err = await pk.fetch_dpl(client, url)
                except Exception as e:  # noqa: BLE001 — un DPL raro no tumba la cola
                    parsed, err = None, f"no se pudo leer el DPL ({type(e).__name__})"
                _dpl[oid] = (time.monotonic(), url, parsed, err)
                _dpl_running.discard(oid)
        await asyncio.gather(*(one(oid, url) for oid, url in items))


def _dpl_for(orders: dict) -> tuple[dict, int]:
    """Lo que hay en caché, y en segundo plano descarga lo que falta/venció."""
    now = time.monotonic()
    out, todo = {}, []
    for oid, o in orders.items():
        url = pk.dpl_url(o)
        if not url:
            out[oid] = None
            continue
        hit = _dpl.get(oid)
        if hit and hit[1] == url:
            out[oid] = {"url": url, "data": hit[2], "error": hit[3]}
            if now - hit[0] < DPL_TTL_S:
                continue
        else:
            out[oid] = {"url": url, "data": None, "error": None, "loading": True}
        if oid not in _dpl_running:
            _dpl_running.add(oid)
            todo.append((oid, url))
    if todo:
        asyncio.get_running_loop().create_task(_refresh_dpl(todo))
    pending = sum(1 for v in out.values() if v and v.get("loading"))
    return out, pending


async def _printed_on(orders: dict) -> dict:
    """{order_id: {machine, printing, last_at}}: en qué máquina se pintó la orden.
    Si sigue en un tablero MAQUINA, ésa (se está pintando); si no, la máquina de
    su última captura de producción (production_logs)."""
    out = {}
    ids = list(orders)
    if ids:
        pipe = [{"$match": {"order_id": {"$in": ids}, "machine": {"$regex": "^MAQUINA"}}},
                {"$sort": {"created_at": 1}},
                {"$group": {"_id": "$order_id", "machine": {"$last": "$machine"}, "last_at": {"$last": "$created_at"},
                            "machines": {"$addToSet": "$machine"}}}]
        async for r in db.production_logs.aggregate(pipe):
            out[r["_id"]] = {"machine": r["machine"], "machines": sorted(r.get("machines") or []),
                             "last_at": r.get("last_at"), "printing": False}
    for oid, o in orders.items():
        b = str(o.get("board") or "")
        if b.startswith("MAQUINA"):
            out[oid] = {**out.get(oid, {}), "machine": b, "printing": True}
    return out


def _card_factory(ships: dict, dpls: dict, caps: dict, today: str, machines: dict = None):
    machines = machines or {}
    def card(o: dict) -> dict:
        qty = int(o.get("quantity") or 0)
        ship = ships.get(str(o.get("order_number") or "")) or {}
        cancel = _day(o.get("ship_by")) or _day(o.get("cancel_date"))
        due = ship.get("date") or cancel
        d = dpls.get(o["order_id"]) or {}
        data = d.get("data") or {}
        # La captura de la estación (iPad) manda sobre el DPL de Google.
        cap = caps.get(o["order_id"])
        if cap and cap.get("boxes"):
            data = {"total": cap["packed"], "boxes": cap["boxes"], "pallets": cap["pallets"],
                    "date_packed": cap.get("last_at"), "packer": None}
        packed = int(data.get("total") or 0)
        st = _status(o)
        since = o.get("production_status_at")
        stuck = False
        if st == IN_PROCESS and since:
            try:
                ts = datetime.fromisoformat(str(since).replace("Z", "+00:00"))
                stuck = datetime.now(timezone.utc) - ts > timedelta(days=STUCK_DAYS)
            except ValueError:
                pass
        return {"order_id": o["order_id"], "order_number": str(o.get("order_number") or ""),
                "client": o.get("client") or "", "branding": o.get("branding") or "",
                "board": o.get("board") or "", "quantity": qty,
                "cancel_date": o.get("cancel_date"), "priority": o.get("priority") or "",
                "design": str(o.get("design_#") or o.get("design_number") or "").strip(),
                "style": o.get("style") or "", "color": o.get("color") or "",
                "customer_po": o.get("customer_po") or "",
                "packing_type": o.get("packing_type") or "",
                "status": str(o.get("production_status") or "").strip(),
                "status_at": since, "locked_by_qc": bool(o.get("locked_by_qc")),
                "ship_date": ship.get("date"), "due": due, "due_source": "ship" if ship.get("date") else "cancel",
                "overdue": bool(due and due < today),
                "dpl_url": d.get("url"), "dpl_error": d.get("error"), "dpl_loading": bool(d.get("loading")),
                "packed": packed if data else None, "packed_source": "station" if (cap and cap.get("boxes")) else ("dpl" if data else None), "boxes": data.get("boxes"), "pallets": data.get("pallets"),
                "packer": data.get("packer"), "date_packed": str(data.get("date_packed") or "")[:10] or None,
                # floor: 7,480 / 7,485 no debe decir 100 %
                "packed_pct": (100 * packed // qty) if (data and qty) else None,
                "pl_label": o.get("packing_link_label") or "", "pl_url": o.get("packing_link") or "",
                "suggest_qc": bool(data) and bool(qty) and packed >= qty and st in (NEEDS, IN_PROCESS),
                "stuck": stuck,
                "printed_on": (machines.get(o["order_id"]) or {}).get("machine"),
                "printed_on_all": (machines.get(o["order_id"]) or {}).get("machines") or [],
                "printing_now": bool((machines.get(o["order_id"]) or {}).get("printing")),
                "printavo_url": om.printavo_url(o), "components": om.components(o, include_screens=True)}
    return card


def _by_due(c: dict):
    return (c["due"] or "9999-12-31", c["order_number"])


@router.get("/queue")
async def queue(request: Request):
    user = await require_auth(request)
    boards = [b for b in await get_dynamic_boards() if str(b).strip().upper() not in DEAD_BOARDS]
    wanted = [NEEDS, IN_PROCESS, PRINTING]
    orders = {o["order_id"]: o async for o in db.orders.find(
        {"board": {"$in": boards}, "production_status": {"$in": wanted}}, ORDER_PROJ).limit(3000)}
    # Por llegar = en máquina imprimiendo (en SCHEDULING con EN PRODUCCION
    # todavía no tiene máquina: no es trabajo inminente de empaque).
    packing = {k: o for k, o in orders.items() if _status(o) in (NEEDS, IN_PROCESS)}
    ships = await _ship_dates([str(o.get("order_number")) for o in orders.values() if o.get("order_number")])
    dpls, dpl_pending = _dpl_for(packing)
    from routers.pack_station import packed_totals   # lazy (pack_station importa este módulo)
    caps = await packed_totals(list(packing))
    machines = await _printed_on(orders)
    today = date.today().isoformat()
    card = _card_factory(ships, dpls, caps, today, machines)

    tabs = {"pendientes": [], "proceso": [], "llegando": [],
            "sugeridas": [], "alertas": []}
    for o in orders.values():
        st, c = _status(o), None
        if st in (NEEDS, IN_PROCESS):
            c = card(o)
            # Por empacar = TODAS las NECESITA EMPACAR, por fecha. Sin pestaña
            # Programados: empaque sólo trabaja órdenes ya impresas, no hay nada
            # que adelantar (decisión del usuario 2026-10-21).
            tabs["proceso" if st == IN_PROCESS else "pendientes"].append(c)
            if c["suggest_qc"]:
                tabs["sugeridas"].append(c)
            if c["stuck"] or c["overdue"]:
                tabs["alertas"].append(c)
        elif st == PRINTING and str(o.get("board") or "").startswith("MAQUINA"):
            tabs["llegando"].append(card(o))
    for k, lst in tabs.items():
        lst.sort(key=_by_due)
        tabs[k] = lst[:LIST_MAX]
    return {"statuses": PACK_STATUSES, "confirm_status": QC_STATUS, "stuck_days": STUCK_DAYS,
            "dpl_pending": dpl_pending, **tabs,
            "can_edit": bool(user_roles(user) & WRITE_ROLES)}


@router.get("/kpis")
async def kpis(request: Request):
    """KPIs del día para la pestaña Resumen (lo de la cola sale de /queue):
    empacado en la estación hoy (cajas y piezas) y órdenes mandadas a QC hoy y
    en los últimos 7 días (bitácora: Production Status → NECESITA QC). "Hoy" es
    el día de Tijuana."""
    import zoneinfo
    await require_auth(request)
    tz = zoneinfo.ZoneInfo("America/Tijuana")
    start = datetime.now(tz).replace(hour=0, minute=0, second=0, microsecond=0)
    today_utc = start.astimezone(timezone.utc).isoformat()
    week_utc = (start - timedelta(days=6)).astimezone(timezone.utc).isoformat()
    packed = {"boxes": 0, "pcs": 0, "packers": 0}
    async for r in db.pack_boxes.aggregate([
            {"$match": {"created_at": {"$gte": today_utc}, "voided": {"$ne": True}}},
            {"$group": {"_id": None, "boxes": {"$sum": 1}, "pcs": {"$sum": "$total"}, "packers": {"$addToSet": "$packer"}}}]):
        packed = {"boxes": r["boxes"], "pcs": int(r["pcs"] or 0), "packers": len(r.get("packers") or [])}
    to_qc = {"today": 0, "week": 0}
    async for r in db.activity_logs.aggregate([
            {"$match": {"timestamp": {"$gte": week_utc}, "action": "update_order",
                        "details.changes.production_status.to": QC_STATUS}},
            {"$group": {"_id": {"$gte": ["$timestamp", today_utc]}, "orders": {"$addToSet": "$details.order_id"}}}]):
        n = len(r.get("orders") or [])
        to_qc["week"] += n
        if r["_id"]:
            to_qc["today"] = n
    return {"packed_today": packed, "to_qc": to_qc}


async def _set_status(order_id: str, status: str, request: Request) -> dict:
    from routers.orders import update_order   # lazy (evita ciclo)
    user = await require_auth(request)
    if not (user_roles(user) & WRITE_ROLES):
        raise HTTPException(403, "Sólo el rol Empaque puede cambiar el Production Status de empaque")
    status = str(status or "").strip().upper()
    if status not in PACK_STATUSES:
        raise HTTPException(400, f"Production Status no válido para empaque: {status}")
    o = await db.orders.find_one({"order_id": order_id}, {"_id": 0, "production_status": 1})
    if not o:
        raise HTTPException(404, "Orden no encontrada")
    if _status(o) not in (NEEDS, IN_PROCESS):
        # Ya está en QC (o en otra área): el módulo no la regresa.
        raise HTTPException(409, f"La orden ya no está en empaque ({o.get('production_status') or 'sin estatus'})")
    return await update_order(order_id, OrderUpdate(production_status=status), request)


@router.post("/{order_id}/status")
async def set_status(order_id: str, request: Request):
    body = await request.json()
    return await _set_status(order_id, body.get("status"), request)


@router.post("/{order_id}/confirm")
async def confirm_qc(order_id: str, request: Request):
    return await _set_status(order_id, QC_STATUS, request)
