"""Módulo de Neck — reemplazará al tablero NECK (y a READY TO SCHEDULED).

Como Cuadros y Blanks, no trabaja sobre un tablero sino sobre el PLAN de
Planeación (services/order_modules.py). Manda la columna Production Status,
como siempre: una orden NECESITA neck sólo si su estatus es NECESITA LABEL
(o ya está en proceso de label). Sin estatus de label NO entra.

Une las TRES cosas de neck que hoy no se hablan:
  · el estatus del label (production_status: NECESITA LABEL → PROCESO DE
    NECK LABEL → LABEL LISTO),
  · el corte de neck capturado (neck_logs: piezas por operador y turno; de
    ahí sale el Neck %),
  · el conteo de neck del WMS (wms_neck_counts: talla × país contra surtido),
  · y muestra el arte de neck (art_neck_status), que NO es el label.

  Programados   el plan las arranca en los próximos N días.
  Pendientes    NECESITA LABEL y el plan las programa, en orden de arranque.
  Adelantar     NECESITA LABEL sin lugar en el plan.
  En proceso    PROCESO DE NECK LABEL / PROCESO DE LABEL.
  Sugeridas     corte capturado ≥ cantidad pero el estatus no dice LABEL LISTO:
                el sistema SUGIERE, una persona confirma.
  Alertas       ya en máquina sin label listo.
  LABEL LISTO (o cualquier estatus posterior) sale del módulo.

Escribe sólo `production_status`, por PUT /api/orders/{id} (update_order):
bitácora, sello production_status_at, automatizaciones ("MOVER A LISTO PARA
MAQUINA" mientras exista el tablero NECK) y broadcast. La captura de corte usa
el endpoint de siempre (POST /api/neck-logs). Editan el rol `neck` + admin/supersu.

Endpoints (prefijo /api/neck):
  GET  /queue?days=3          programados, pendientes, adelantar, proceso, sugeridas, alertas
  POST /{order_id}/status     {status}  cambia el estatus del label
  POST /{order_id}/confirm    LABEL LISTO
"""
from fastapi import APIRouter, HTTPException, Request

from deps import db, require_auth, user_roles, SUPER_ROLES, OrderUpdate
from services import order_modules as om

router = APIRouter(prefix="/api/neck")

LIST_MAX = 500
WRITE_ROLES = {"neck"} | SUPER_ROLES
READY_STATUS = "LABEL LISTO"
NEEDS = "NECESITA LABEL"
IN_PROCESS = {"PROCESO DE NECK LABEL", "PROCESO DE LABEL"}
# Lo que el módulo deja elegir (el resto del catálogo de producción es de
# otras áreas: empaque, QC, envío…).
LABEL_STATUSES = [NEEDS, "PROCESO DE NECK LABEL", "PROCESO DE LABEL", READY_STATUS]
ORDER_PROJ = {"_id": 0, "order_id": 1, "order_number": 1, "client": 1, "branding": 1, "board": 1,
              "quantity": 1, "cancel_date": 1, "design_#": 1, "design_number": 1, "style": 1, "color": 1,
              "priority": 1, "customer_po": 1, **om.COMPONENT_FIELDS}


def _status(o: dict) -> str:
    return str(o.get("production_status") or "").strip().upper()


def _group(o: dict) -> str:
    s = _status(o)
    if s in IN_PROCESS:
        return "proceso"
    return "needs"


async def _neck_progress(orders: dict) -> dict:
    """{order_id: {cut, last_operator, last_at, wms_counted}} en dos consultas."""
    ids = list(orders)
    out = {oid: {"cut": 0, "last_operator": "", "last_at": None, "wms_counted": None} for oid in ids}
    if not ids:
        return out
    pipe = [{"$match": {"order_id": {"$in": ids}}},
            {"$sort": {"created_at": 1}},
            {"$group": {"_id": "$order_id", "cut": {"$sum": "$quantity_neck_cut"},
                        "last_operator": {"$last": "$operator"}, "last_at": {"$last": "$created_at"}}}]
    async for r in db.neck_logs.aggregate(pipe):
        out[r["_id"]].update(cut=int(r.get("cut") or 0), last_operator=r.get("last_operator") or "",
                             last_at=r.get("last_at"))
    num_to_id = {str(o.get("order_number")): oid for oid, o in orders.items() if o.get("order_number")}
    async for c in db.wms_neck_counts.find({"order_number": {"$in": list(num_to_id)}},
                                           {"_id": 0, "order_number": 1, "counts": 1}):
        oid = num_to_id.get(str(c.get("order_number")))
        if oid:
            n = sum(int(v or 0) for v in (c.get("counts") or {}).values())
            out[oid]["wms_counted"] = (out[oid]["wms_counted"] or 0) + n
    return out


def _card_factory(prog: dict):
    def card(o: dict, extra: dict) -> dict:
        p = prog.get(o["order_id"]) or {}
        qty = int(o.get("quantity") or 0)
        cut = int(p.get("cut") or 0)
        return {"order_id": o["order_id"], "order_number": str(o.get("order_number") or ""),
                "client": o.get("client") or "", "branding": o.get("branding") or "",
                "board": o.get("board") or "", "quantity": qty,
                "cancel_date": o.get("cancel_date"), "priority": o.get("priority") or "",
                "design": str(o.get("design_#") or o.get("design_number") or "").strip(),
                "style": o.get("style") or "", "color": o.get("color") or "",
                "customer_po": o.get("customer_po") or "",
                "label_status": str(o.get("production_status") or "").strip(),
                "art_neck": o.get("art_neck_status") is True,
                "cut": cut, "cut_pct": round(100.0 * cut / qty) if qty else None,
                "last_operator": p.get("last_operator") or "", "last_cut_at": p.get("last_at"),
                "wms_counted": p.get("wms_counted"),
                "suggest_ready": bool(qty) and cut >= qty,
                "printavo_url": om.printavo_url(o), "components": om.components(o, include_screens=True),
                **extra}
    return card


@router.get("/queue")
async def queue(request: Request, days: float = om.DEFAULT_WINDOW_DAYS):
    user = await require_auth(request)
    sim = await om.simulate()
    sim_ids = list({j["order_id"] for j in sim["jobs"]})
    orders = {o["order_id"]: o async for o in db.orders.find({"order_id": {"$in": sim_ids}}, ORDER_PROJ)}
    # Sólo lo que NECESITA neck (NECESITA LABEL) o ya está en proceso de label.
    # Sin estatus de label no entra; LABEL LISTO o posterior ya salió.
    orders = {k: o for k, o in orders.items() if _status(o) == NEEDS or _status(o) in IN_PROCESS}
    by_order = om.group_by_order(sim, "label", only=set(orders))
    card = _card_factory(await _neck_progress(orders))
    plan, rest, alertas = om.split_plan(sim, by_order, orders, card, LIST_MAX)
    tabs = {"pendientes": [], "adelantar": [], "proceso": []}
    # Programados = el plan los arranca en los próximos N días (cualquier
    # estatus); salen de Pendientes. Las pestañas por estatus los conservan.
    programados, _ = om.split_window(sim, plan, days)
    prog_ids = {c["order_id"] for c in programados}
    for lst, is_plan in ((plan, True), (rest, False)):
        for c in lst:
            g = _group(orders[c["order_id"]])
            if g == "needs" and c["order_id"] in prog_ids:
                continue
            tabs[("pendientes" if is_plan else "adelantar") if g == "needs" else g].append(c)
    sugeridas = [c for c in alertas + plan + rest if c["suggest_ready"]]
    return await om.with_comments({"sim_at": sim["at"], "statuses": LABEL_STATUSES, "confirm_status": READY_STATUS,
            "days": om.window_days(days), "programados": programados, **tabs, "sugeridas": sugeridas, "alertas": alertas,
            "can_edit": bool(user_roles(user) & WRITE_ROLES)})


async def _set_status(order_id: str, status: str, request: Request) -> dict:
    from routers.orders import update_order   # lazy (evita ciclo)
    user = await require_auth(request)
    if not (user_roles(user) & WRITE_ROLES):
        raise HTTPException(403, "Sólo el rol Neck puede cambiar el Production Status de neck")
    status = str(status or "").strip().upper()
    if status not in LABEL_STATUSES:
        raise HTTPException(400, f"Production Status no válido para neck: {status}")
    if not await db.orders.find_one({"order_id": order_id}, {"_id": 1}):
        raise HTTPException(404, "Orden no encontrada")
    om.invalidate()                     # el label cambia la simulación de todos los módulos
    return await update_order(order_id, OrderUpdate(production_status=status), request)


@router.post("/{order_id}/status")
async def set_status(order_id: str, request: Request):
    body = await request.json()
    return await _set_status(order_id, body.get("status"), request)


@router.post("/{order_id}/confirm")
async def confirm_ready(order_id: str, request: Request):
    return await _set_status(order_id, READY_STATUS, request)
