"""Módulo de Blanks — reemplazará al tablero BLANKS.

Como Cuadros, no trabaja sobre un tablero sino sobre lo que PLANEACIÓN va a
correr: corre el motor en simulación contando el blank como contado
(services/order_modules.py, requisito "contado") y sale cuándo y en qué
máquina ARRANCARÍA cada orden que hoy espera su blank.

  Pendientes   SIN estatus de blank y el plan las programa, en orden de
               arranque (el plan supone blank, cuadros y label hechos:
               order_modules.simulate).
  Adelantar    SIN estatus y sin lugar en el plan (falta el ejemplo, fuera de
               horizonte, cancel muy vencido…).
  Surtido      estatus SURTIDO.
  Parciales    estatus parcial (PARTIAL, REPORTADO PARCIAL, APPROVED PARTIAL…).
  En proceso   cualquier otro estatus (PICK TICKET, FROM USA, DYE HOUSE…).
  CONTADO      sale del módulo (blank terminado); la orden sigue en el maestro.
  Alertas      ya está en máquina / EN PRODUCCION sin blank listo: se imprime
               (o se va a imprimir) sin blank contado; hay que revisarla.
  Sugeridas    el WMS ya surtió el 100 % de lo pedido en sus pick tickets pero
               el estatus no dice CONTADO/SURTIDO: el sistema SUGIERE, una
               persona confirma (botón "Confirmar CONTADO").

Cada tarjeta trae el avance REAL del almacén (WMS), por talla:
  pedido   = sizes de sus pick tickets (wms_pick_tickets)
  surtido  = bitácora pick_deduction (wms_movements), por orden y talla
  stock    = wms_inventory disponible (on_hand - allocated) por estilo+color+talla
"Blank listo" = UNA sola lista: la regla de Planeación (ready_blank_statuses,
editable en Planeación → Reglas), vía order_modules.blank_ok_from.

Escribe sólo `blank_status`, por PUT /api/orders/{id} (update_order): bitácora,
sello blank_status_at, automatizaciones (CONTADO → "mover a cuadros") y
broadcast iguales que cambiarlo en el CRM. Sólo el rol `blanks` + admin/supersu.

Endpoints (prefijo /api/blanks):
  GET  /queue                 pendientes + adelantar + sugeridas
  POST /{order_id}/status     {status}  cambia el estatus (catálogo blank_statuses)
  POST /{order_id}/confirm    confirma CONTADO (la sugerida por el WMS)
"""
import re
import zoneinfo
from datetime import datetime, timezone

from fastapi import APIRouter, HTTPException, Request

from deps import db, require_auth, user_roles, SUPER_ROLES, DEFAULT_OPTIONS, OrderUpdate
from services import order_modules as om
from services import planner_engine as pe
from wms_constants import TICKET_OPEN_QUERY

router = APIRouter(prefix="/api/blanks")

LIST_MAX = 500
TZ = zoneinfo.ZoneInfo("America/Tijuana")
CONFIRM_STATUS = "CONTADO"          # lo que pone "Confirmar CONTADO"
# Blank TERMINADO para el módulo: sale de la lista. SURTIDO sigue aquí (en su
# pestaña) aunque Planeación ya lo cuente como listo para imprimir.
DONE_STATUSES = {"CONTADO", "CONTADO/PICKED"}


def _group(status: str) -> str:
    s = str(status or "").strip().upper()
    if not s:
        return "none"
    if s.startswith("SURTIDO") and "ENVIADO" not in s:
        return "surtido"
    if "PARTIAL" in s or "PARCIAL" in s:
        return "parciales"
    return "proceso"


# Cambian el estatus sólo los del rol `blanks` (aditivo) y admin/supersu.
WRITE_ROLES = {"blanks"} | SUPER_ROLES
ORDER_PROJ = {"_id": 0, "order_id": 1, "order_number": 1, "client": 1, "branding": 1, "board": 1,
              "quantity": 1, "cancel_date": 1, "design_#": 1, "design_number": 1, "style": 1, "color": 1,
              "priority": 1, "customer_po": 1, "blank_source": 1, "bpo_(blank_po#)": 1, "sizes": 1,
              **om.COMPONENT_FIELDS}
_SIZE_ORDER = ["XS", "S", "M", "L", "XL", "2X", "2XL", "XXL", "3X", "3XL", "4X", "4XL", "5X", "5XL"]


def _size_key(sz: str):
    u = str(sz or "").upper()
    return (_SIZE_ORDER.index(u) if u in _SIZE_ORDER else len(_SIZE_ORDER), u)


def _norm(s) -> str:
    return re.sub(r"\s+", " ", str(s or "")).strip().upper()


async def _wms_for(order_numbers: list) -> dict:
    """{order_number: {tickets, ordered{talla:n}, picked{talla:n}, styles[(style,color)]}}
    en tres consultas para toda la cola (no una por orden)."""
    out = {n: {"tickets": [], "ordered": {}, "picked": {}, "styles": set()} for n in order_numbers}
    if not order_numbers:
        return out
    async for t in db.wms_pick_tickets.find(
            {"order_number": {"$in": order_numbers}, "status": {"$ne": "cancelled"}},
            {"_id": 0, "ticket_id": 1, "order_number": 1, "style": 1, "color": 1, "sizes": 1,
             "total_pick_qty": 1, "status": 1, "picking_status": 1, "assigned_to_name": 1}):
        w = out.get(str(t.get("order_number")))
        if w is None:
            continue
        w["tickets"].append({"ticket_id": t.get("ticket_id"), "style": t.get("style") or "",
                             "color": t.get("color") or "", "status": t.get("status") or "",
                             "picking_status": t.get("picking_status") or "",
                             "assigned_to": t.get("assigned_to_name") or "",
                             "total": int(t.get("total_pick_qty") or 0)})
        w["styles"].add((_norm(t.get("style")), _norm(t.get("color"))))
        for sz, n in (t.get("sizes") or {}).items():
            try:
                n = int(n or 0)
            except (TypeError, ValueError):
                n = 0
            if n > 0:
                w["ordered"][sz] = w["ordered"].get(sz, 0) + n
    pipe = [{"$match": {"type": "pick_deduction", "details.order_number": {"$in": order_numbers}}},
            {"$project": {"o": "$details.order_number", "sz": "$details.size",
                          "n": {"$add": [{"$sum": {"$ifNull": ["$details.boxes.taken", []]}},
                                         {"$ifNull": ["$details.no_box_units", 0]}]}}},
            {"$group": {"_id": {"o": "$o", "sz": "$sz"}, "n": {"$sum": "$n"}}}]
    async for r in db.wms_movements.aggregate(pipe):
        w = out.get(str(r["_id"].get("o")))
        if w is not None and r["n"]:
            sz = r["_id"].get("sz") or "?"
            w["picked"][sz] = w["picked"].get(sz, 0) + int(r["n"])
    return out


async def _stock_for(pairs: set) -> dict:
    """{(STYLE, COLOR): {talla: disponible}} desde wms_inventory."""
    if not pairs:
        return {}
    styles = sorted({s for s, _ in pairs if s})
    out = {}
    async for r in db.wms_inventory.find(
            {"style": {"$in": styles}, "units_on_hand": {"$gt": 0}},
            {"_id": 0, "style": 1, "color": 1, "size": 1, "units_on_hand": 1, "units_allocated": 1}):
        key = (_norm(r.get("style")), _norm(r.get("color")))
        if key not in pairs:
            continue
        free = int(r.get("units_on_hand") or 0) - int(r.get("units_allocated") or 0)
        if free > 0:
            d = out.setdefault(key, {})
            d[r.get("size") or "?"] = d.get(r.get("size") or "?", 0) + free
    return out


def _card_factory(wms: dict, stock: dict, ok_set: set):
    def card(o: dict, extra: dict) -> dict:
        num = str(o.get("order_number") or "")
        w = wms.get(num) or {"tickets": [], "ordered": {}, "picked": {}, "styles": set()}
        pairs = set(w["styles"]) or ({(_norm(o.get("style")), _norm(o.get("color")))} if o.get("style") else set())
        avail = {}
        for p in pairs:
            for sz, n in (stock.get(p) or {}).items():
                avail[sz] = avail.get(sz, 0) + n
        sizes = sorted(set(w["ordered"]) | set(w["picked"]), key=_size_key)
        rows = [{"size": sz, "ordered": w["ordered"].get(sz, 0), "picked": w["picked"].get(sz, 0),
                 "stock": avail.get(sz, 0)} for sz in sizes]
        ordered = sum(w["ordered"].values())
        picked = sum(min(w["picked"].get(sz, 0), n) for sz, n in w["ordered"].items())
        status = str(o.get("blank_status") or "").strip()
        return {"order_id": o["order_id"], "order_number": num,
                "client": o.get("client") or "", "branding": o.get("branding") or "",
                "board": o.get("board") or "", "quantity": o.get("quantity") or 0,
                "cancel_date": o.get("cancel_date"), "priority": o.get("priority") or "",
                "design": str(o.get("design_#") or o.get("design_number") or "").strip(),
                "style": o.get("style") or "", "color": o.get("color") or "",
                "customer_po": o.get("customer_po") or "", "bpo": o.get("bpo_(blank_po#)") or "",
                "blank_source": o.get("blank_source") or "", "blank_status": status,
                "blank_ok": status.upper() in ok_set,
                "tickets": w["tickets"], "sizes": rows, "ordered": ordered, "picked": picked,
                "pct": round(100.0 * picked / ordered) if ordered else None,
                "suggest_contado": bool(ordered) and picked >= ordered and status.upper() not in ok_set,
                "printavo_url": om.printavo_url(o), "components": om.components(o, include_screens=True, blank_ok=ok_set),
                **extra}
    return card


@router.get("/queue")
async def queue(request: Request, days: float = om.DEFAULT_WINDOW_DAYS):
    user = await require_auth(request)
    sim = await om.simulate()
    ok_set = om.blank_ok_from(sim["cfg"])
    sim_ids = list({j["order_id"] for j in sim["jobs"]})
    orders = {o["order_id"]: o async for o in db.orders.find({"order_id": {"$in": sim_ids}}, ORDER_PROJ)}
    # Dato vivo: CONTADO (blank terminado) sale del módulo.
    orders = {k: o for k, o in orders.items()
              if str(o.get("blank_status") or "").strip().upper() not in DONE_STATUSES}
    by_order = om.group_by_order(sim, "contado", only=set(orders))
    nums = sorted({str(o.get("order_number")) for o in orders.values() if o.get("order_number") not in (None, "")})
    wms = await _wms_for(nums)
    pairs = set()
    for o in orders.values():
        w = wms.get(str(o.get("order_number"))) or {}
        pairs |= set(w.get("styles") or set())
        if o.get("style"):
            pairs.add((_norm(o.get("style")), _norm(o.get("color"))))
    stock = await _stock_for(pairs)
    card = _card_factory(wms, stock, DONE_STATUSES)
    plan, rest, alertas = om.split_plan(sim, by_order, orders, card, LIST_MAX)
    # Sin estatus: plan → Pendientes, resto → Adelantar. Con estatus (ya en
    # proceso): una pestaña por grupo, en el orden del plan y luego el resto.
    tabs = {"pendientes": [], "adelantar": [], "surtido": [], "parciales": [], "proceso": []}
    # Programados = el plan los arranca en los próximos N días (cualquier
    # estatus); salen de Pendientes. Las pestañas por estatus los conservan.
    programados, _ = om.split_window(sim, plan, days)
    prog_ids = {c["order_id"] for c in programados}
    for lst, is_plan in ((plan, True), (rest, False)):
        for c in lst:
            g = _group(c["blank_status"])
            if g == "none" and c["order_id"] in prog_ids:
                continue
            tabs[("pendientes" if is_plan else "adelantar") if g == "none" else g].append(c)
    sugeridas = [c for c in alertas + plan + rest if c["suggest_contado"]]
    midnight = datetime.now(TZ).replace(hour=0, minute=0, second=0, microsecond=0)
    done_today = await db.orders.count_documents({
        "blank_status_at": {"$gte": midnight.astimezone(timezone.utc).isoformat()},
        "blank_status": {"$in": [x for x in (await _statuses()) if x.upper() in DONE_STATUSES] or list(DONE_STATUSES)}})
    return {"sim_at": sim["at"], "ok_statuses": sorted(ok_set),
            "statuses": await _statuses(), "confirm_status": CONFIRM_STATUS,
            "days": om.window_days(days), "programados": programados, **tabs, "alertas": alertas,
            "sugeridas": sugeridas, "done_today": done_today,
            "can_edit": bool(user_roles(user) & WRITE_ROLES)}


async def _statuses() -> list:
    """Catálogo de estatus de blank (Configuración → opciones, o el default)."""
    doc = await db.config_options.find_one({"config_id": "main"}, {"_id": 0, "blank_statuses": 1}) or {}
    return list(doc.get("blank_statuses") or DEFAULT_OPTIONS.get("blank_statuses") or [])


async def _set_status(order_id: str, status: str, request: Request) -> dict:
    from routers.orders import update_order   # lazy (evita ciclo)
    user = await require_auth(request)
    if not (user_roles(user) & WRITE_ROLES):
        raise HTTPException(403, "Sólo el rol Blanks puede cambiar el estatus del blank")
    status = str(status or "").strip()
    allowed = {x.upper(): x for x in await _statuses()}
    if status.upper() not in allowed:
        raise HTTPException(400, f"Estatus fuera del catálogo: {status}")
    order = await db.orders.find_one({"order_id": order_id}, {"_id": 0, "blank_status": 1})
    if not order:
        raise HTTPException(404, "Orden no encontrada")
    om.invalidate()                     # el blank cambia la simulación de todos los módulos
    return await update_order(order_id, OrderUpdate(blank_status=allowed[status.upper()]), request)


@router.post("/{order_id}/status")
async def set_status(order_id: str, request: Request):
    body = await request.json()
    return await _set_status(order_id, body.get("status"), request)


@router.post("/{order_id}/confirm")
async def confirm_contado(order_id: str, request: Request):
    return await _set_status(order_id, CONFIRM_STATUS, request)
