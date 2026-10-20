"""Módulo de Cuadros (mallas) — reemplaza al tablero SCREENS, que se RETIRÓ
(scripts/retire_screens_board.py). Cuadros ya no es una etapa del flujo sino un
componente en paralelo: BLANKS --(contado)--> NECK, y Cuadros trabaja aquí.

Cuadros trabaja sobre el PLAN de Planeación, no sobre un tablero: todas las
órdenes con cuadros pendientes, priorizadas por cuándo arrancarían si la
preparación (blank, cuadros, label) estuviera hecha (order_modules.simulate).

  Pendientes   las que el plan programa, en orden de arranque.
  Adelantar    el resto (sin lugar en el plan: falta el ejemplo, fuera de
               horizonte…). Si Cuadros termina lo pendiente, adelanta de aquí.
  Preórdenes   las que Arte marcó listas para Cuadros (art_ready_for_screens)
               y no se han convertido. Al convertirse en orden heredan los
               cuadros palomeados (orders.py, linked_preorder_id).

Los cuadros se marcan POR POSICIÓN (la unidad del planner es orden × posición:
el frente puede imprimir mientras se queman los de la espalda):

  orders.screens_positions  {"FRENTE": {"at": iso, "by": nombre}, ...}
  orders.screens            True cuando TODAS las posiciones están listas
                            (la bandera de siempre: la leen el CRM, Arte,
                            Ejemplos, automatizaciones y el planner).

Escribe por PUT /api/orders/{id} (update_order): bitácora, automatizaciones y
broadcast iguales que palomear la casilla en el CRM. No mueve tablero.
No tiene colección propia; la cola sale de la simulación compartida de los
módulos (services/order_modules.py, requisito "cuadros").

Endpoints (prefijo /api/screens):
  GET  /queue                       pendientes + adelantar + preórdenes
  POST /{order_id}/position         {position, ready}  palomea una posición
  POST /{order_id}/all              {ready}            todas las posiciones
"""
import zoneinfo
from datetime import datetime, timezone

from fastapi import APIRouter, HTTPException, Request

from deps import db, require_auth, user_roles, OrderUpdate, SUPER_ROLES
from services import planner_engine as pe
from services import order_modules as om

router = APIRouter(prefix="/api/screens")

TZ = zoneinfo.ZoneInfo("America/Tijuana")
ADVANCE_MAX = 500          # tope de seguridad; el buscador del módulo filtra todo
ORDER_PROJ = {"_id": 0, "order_id": 1, "order_number": 1, "client": 1, "branding": 1, "board": 1,
              "quantity": 1, "cancel_date": 1, "print_positions": 1, "hits_impresiones": 1,
              "colors": 1, "design_#": 1, "style": 1, "color": 1, "screens": 1, "screens_positions": 1,
              "blank_status": 1, "production_status": 1, "priority": 1, "customer_po": 1,
              "trim_status": 1, "artwork_status": 1, "art_sep_status": 1, "art_neck_status": 1,
              "job_title_a": 1, "job_title_b": 1, "design_number": 1}
WRITE_ROLES = {"screens"} | SUPER_ROLES

async def _can_edit(user: dict) -> bool:
    """Palomean cuadros sólo los del rol `screens` (aditivo, se combina con
    otros) y admin/supersu. Los demás ven el módulo en solo lectura."""
    return bool(user_roles(user) & WRITE_ROLES)


def _positions(order: dict) -> list:
    return list(pe.positions_of(order).keys())


def _ready_map(order: dict) -> dict:
    """{posición: bool}. Una orden con la casilla vieja `screens` en True y sin
    detalle por posición tiene todas listas."""
    sp = order.get("screens_positions") or {}
    legacy = order.get("screens") is True and not sp
    return {p: bool(legacy or sp.get(p)) for p in _positions(order)}


def _card(order: dict, extra: dict) -> dict:
    ready = _ready_map(order)
    return {"order_id": order["order_id"], "order_number": str(order.get("order_number") or ""),
            "client": order.get("client") or "", "branding": order.get("branding") or "",
            "board": order.get("board") or "", "quantity": order.get("quantity") or 0,
            "cancel_date": order.get("cancel_date"), "design": str(order.get("design_#") or order.get("design_number") or "").strip(),
            "style": order.get("style") or "", "color": order.get("color") or "",
            "colors": order.get("colors") or None, "priority": order.get("priority") or "",
            "customer_po": order.get("customer_po") or "",
            "positions": [{"position": p, "ready": r,
                           "at": ((order.get("screens_positions") or {}).get(p) or {}).get("at")}
                          for p, r in ready.items()],
            "screens": order.get("screens") is True,
            "printavo_url": om.printavo_url(order), "components": om.components(order), **extra}


@router.get("/queue")
async def queue(request: Request):
    user = await require_auth(request)
    sim = await om.simulate()
    by_order = om.group_by_order(sim, "cuadros")
    orders = {o["order_id"]: o async for o in db.orders.find({"order_id": {"$in": list(by_order)}}, ORDER_PROJ)}
    # Lo palomeado después de la simulación (dato vivo) ya no es pendiente.
    orders = {k: o for k, o in orders.items() if not all(_ready_map(o).values())}
    pendientes, adelantar, alertas = om.split_plan(sim, by_order, orders, _card, ADVANCE_MAX)

    preorders = [o async for o in db.orders.find(
        {"is_preorder": True, "art_ready_for_screens": True, "artwork_status": {"$ne": "CONVERTED"}},
        ORDER_PROJ).sort("cancel_date", 1)]
    # "Hoy" de planta (Tijuana), comparado contra sellos en UTC.
    midnight = datetime.now(TZ).replace(hour=0, minute=0, second=0, microsecond=0)
    done_today = await db.orders.count_documents(
        {"screens_done_at": {"$gte": midnight.astimezone(timezone.utc).isoformat()}})
    return {"sim_at": sim["at"],
            "pendientes": pendientes, "adelantar": adelantar, "alertas": alertas,
            "preordenes": [_card(o, {}) for o in preorders if not all(_ready_map(o).values())],
            "done_today": done_today, "can_edit": await _can_edit(user)}


async def _write(order_id: str, request: Request, set_ready) -> dict:
    """set_ready(positions) -> {posición: bool} con lo que cambia."""
    from routers.orders import update_order   # lazy (evita ciclo)
    user = await require_auth(request)
    if not await _can_edit(user):
        raise HTTPException(403, "Sólo el rol Cuadros (screens) puede palomear cuadros")
    order = await db.orders.find_one({"order_id": order_id}, ORDER_PROJ)
    if not order:
        raise HTTPException(404, "Orden no encontrada")
    positions = _positions(order)
    changes = set_ready(positions)
    if not changes:
        raise HTTPException(400, "Posición inválida")
    now = datetime.now(timezone.utc).isoformat()
    sp = {p: v for p, v in (order.get("screens_positions") or {}).items() if p in positions}
    if order.get("screens") is True and not sp:
        # Casilla vieja: todas estaban listas; se materializan antes de cambiar una.
        sp = {p: {"at": None, "by": None} for p in positions}
    for p, ready in changes.items():
        if ready:
            sp.setdefault(p, {"at": now, "by": user.get("name") or user.get("email")})
        else:
            sp.pop(p, None)
    all_ready = all(p in sp for p in positions)
    payload = {"screens_positions": sp, "screens": all_ready}
    if all_ready and order.get("screens") is not True:
        payload["screens_done_at"] = now
    elif not all_ready and order.get("screens") is True:
        payload["screens_done_at"] = None      # deshecho: ya no cuenta como lista
    om.invalidate()                     # cuadros cambian la simulación de todos los módulos
    return await update_order(order_id, OrderUpdate(**payload), request)


@router.post("/{order_id}/position")
async def mark_position(order_id: str, request: Request):
    body = await request.json()
    pos = str(body.get("position") or "")
    ready = bool(body.get("ready"))
    return await _write(order_id, request, lambda ps: {pos: ready} if pos in ps else {})


@router.post("/{order_id}/all")
async def mark_all(order_id: str, request: Request):
    body = await request.json()
    ready = bool(body.get("ready", True))
    return await _write(order_id, request, lambda ps: {p: ready for p in ps})
