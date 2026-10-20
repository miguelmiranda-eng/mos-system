"""Módulo de Cuadros (mallas) — reemplaza al tablero SCREENS, que se RETIRÓ
(scripts/retire_screens_board.py). Cuadros ya no es una etapa del flujo sino un
componente en paralelo: BLANKS --(contado)--> NECK, y Cuadros trabaja aquí.

Cuadros trabaja sobre lo que PLANEACIÓN va a correr, no sobre un tablero.
El motor de Planeación no programa una orden sin cuadros, así que el módulo
corre el motor en simulación (sin guardar nada) contando los cuadros como
listos: sale cuándo y en qué máquina ARRANCARÍA cada orden que espera cuadros.

  Programadas  el motor las arrancaría dentro de la ventana (próximos N días,
               ?days=): son lo que la planta necesita ya, en orden de arranque.
  Adelantar    lo que sigue después: arranque fuera de la ventana, o que
               además espera blank/label/ejemplo. Si Cuadros termina lo
               programado, adelanta de aquí (con buscador en la pantalla).
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
No tiene colección propia; la cola sale de una simulación del motor del planner.

Endpoints (prefijo /api/screens):
  GET  /queue?days=3                programadas + adelantar + preórdenes
  POST /{order_id}/position         {position, ready}  palomea una posición
  POST /{order_id}/all              {ready}            todas las posiciones
"""
import time
import zoneinfo
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, HTTPException, Request

from deps import db, require_auth, user_roles, OrderUpdate, SUPER_ROLES
from services import planner_engine as pe

router = APIRouter(prefix="/api/screens")

TZ = zoneinfo.ZoneInfo("America/Tijuana")
ADVANCE_MAX = 500          # tope de seguridad; el buscador del módulo filtra todo
DEFAULT_WINDOW_DAYS = 3    # Programadas = arrancarían en los próximos N días
ORDER_PROJ = {"_id": 0, "order_id": 1, "order_number": 1, "client": 1, "branding": 1, "board": 1,
              "quantity": 1, "cancel_date": 1, "print_positions": 1, "hits_impresiones": 1,
              "colors": 1, "design_#": 1, "style": 1, "color": 1, "screens": 1, "screens_positions": 1,
              "blank_status": 1, "production_status": 1, "priority": 1, "customer_po": 1,
              "trim_status": 1, "artwork_status": 1, "art_sep_status": 1, "art_neck_status": 1,
              "job_title_a": 1, "job_title_b": 1, "design_number": 1}
WRITE_ROLES = {"screens"} | SUPER_ROLES

# Componentes de la orden (mini tabla de la tarjeta). Sólo LECTURA de los
# campos de siempre del CRM; "ok" = ese componente ya no detiene la impresión.
BLANK_OK = {"CONTADO", "CONTADO/PICKED", "SURTIDO"}          # = ready_blank_statuses del planner
TRIM_OK = {"COMPLETE TRIM", "N/A"}
ART_OK = {"SEPS DONE", "REORDER", "N/A"}
# Neck label listo = LABEL LISTO o cualquier estatus posterior del flujo.
LABEL_OK = {"LABEL LISTO", "EN PRODUCCION", "NECESITA EMPACAR", "EN PROCESO DE EMPAQUE", "NECESITA QC",
            "CORRECIÓN DE QC", "LISTO PARA FULFILLMENT", "LISTO PARA ENVIO", "LISTO PARA INVENTARIO"}
LABEL_STEPS = {"NECESITA LABEL", "PROCESO DE NECK LABEL", "PROCESO DE LABEL"}


def _state(value, ok_set) -> str:
    v = str(value or "").strip().upper()
    if not v:
        return "empty"
    return "ok" if v in ok_set else "pending"


def _components(o: dict) -> list:
    art = str(o.get("artwork_status") or "").strip()
    sep = o.get("art_sep_status") is True
    art_state = "ok" if (sep or art.upper() in ART_OK) else _state(art, ART_OK)
    prod = str(o.get("production_status") or "").strip()
    label_val = prod if prod.upper() in LABEL_OK | LABEL_STEPS else ""
    label_state = _state(label_val, LABEL_OK)
    if o.get("art_neck_status") is True and label_state != "ok":
        label_val = (label_val + " · " if label_val else "") + "arte neck ✓"
    return [
        {"key": "blanks", "value": o.get("blank_status") or "", "state": _state(o.get("blank_status"), BLANK_OK)},
        {"key": "trim", "value": o.get("trim_status") or "", "state": _state(o.get("trim_status"), TRIM_OK)},
        {"key": "art", "value": " · ".join(x for x in (art, "SEP ✓" if sep else "") if x), "state": art_state},
        {"key": "neck", "value": label_val, "state": label_state},
    ]


def _printavo_url(o: dict) -> str:
    """Work order de Printavo: el enlace capturado en Job Title A (o B)."""
    for f in ("job_title_a", "job_title_b"):
        v = o.get(f)
        url = (v.get("url") if isinstance(v, dict) else v) or ""
        if str(url).startswith("http") and "printavo" in str(url).lower():
            return str(url)
    return ""


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
            "printavo_url": _printavo_url(order), "components": _components(order), **extra}


# Simulación "si Cuadros ya hubiera terminado": 2-5 s de lecturas (_context);
# varias pantallas o un palomeo seguido reutilizan la misma por unos segundos.
_SIM_TTL_S = 45
_sim_cache = {"at": 0.0, "data": None}


async def _simulate() -> dict:
    """Corre el motor de Planeación SIN guardar nada, contando los cuadros como
    listos. Así sale cuándo y en qué máquina ARRANCARÍA cada orden que hoy
    espera cuadros (el motor real no las programa: exige cuadros). Es la misma
    simulación del programa (ajustes manuales, candados, filas, calendario); lo
    único distinto es el requisito de cuadros."""
    from routers.planner import _context, _active_overrides, _resolve_overrides
    if _sim_cache["data"] and time.monotonic() - _sim_cache["at"] < _SIM_TTL_S:
        return _sim_cache["data"]
    ctx = await _context()
    need = {}                     # job_id -> qué más le falta (aparte de cuadros)
    for j in ctx["jobs"]:
        ready = j.get("ready") or {}
        if ready.get("cuadros", True):
            continue
        need[j["job_id"]] = sorted(k for k, v in ready.items() if not v and k != "cuadros")
        j["ready"] = {**ready, "cuadros": True}
        j["is_ready"] = all(j["ready"].values())
    ov = _resolve_overrides(ctx["jobs"], await _active_overrides())
    prev = await db.planner_runs.find_one({}, {"_id": 0, "locks": 1}, sort=[("created_at", -1)])
    job_ids = {j["job_id"] for j in ctx["jobs"]}
    locks = {k: v for k, v in ((prev or {}).get("locks") or {}).items() if k in job_ids}
    board_of = {o["order_id"]: o.get("board") for o in ctx["orders"]}
    scheduled = pe.schedule(ctx["jobs"], ctx["machines"], ctx["cfg"], ctx["cal"], ctx["now"],
                            ctx["eff"]["applied"], board_of, ov,
                            ctx["eff"]["measured"].get("run_rates"), locks, {})
    sched_by = {j["job_id"]: j for j in scheduled}
    jobs = []
    for j in ctx["jobs"]:
        if j["job_id"] not in need:
            continue
        o = ov.get(j["job_id"], {})
        if "hold" in o or pe.is_manual_test(j, o, ctx["cfg"]):
            continue                  # retenidas y Test Orders: no son trabajo de Cuadros
        s = sched_by.get(j["job_id"]) or {}
        jobs.append({"order_id": j["order_id"], "position": j["position"],
                     "start": s.get("start"), "machine": (s.get("machines") or [None])[0],
                     "target_date": j.get("target_date"), "cancel_date": j.get("cancel_date"),
                     "missing": need[j["job_id"]]})
    data = {"at": datetime.now(timezone.utc).isoformat(), "now": ctx["now"], "cfg": ctx["cfg"], "jobs": jobs}
    _sim_cache.update(at=time.monotonic(), data=data)
    return data


@router.get("/queue")
async def queue(request: Request, days: float = DEFAULT_WINDOW_DAYS):
    user = await require_auth(request)
    days = max(0.5, min(float(days or DEFAULT_WINDOW_DAYS), 30.0))
    sim = await _simulate()
    cutoff = sim["now"] + timedelta(days=days)
    max_od = int(sim["cfg"].get("fill_max_overdue_days") or 0)
    oldest = (sim["now"].date() - timedelta(days=max_od)).isoformat() if max_od > 0 else ""

    # Por orden: el arranque más temprano de sus posiciones sin cuadros.
    by_order = {}
    for j in sim["jobs"]:
        b = by_order.setdefault(j["order_id"], {"start": None, "machine": None, "missing": set(),
                                                "target_date": j["target_date"], "cancel_date": j["cancel_date"]})
        b["missing"] |= set(j["missing"])
        if j["start"] and (not b["start"] or j["start"] < b["start"]):
            b["start"], b["machine"] = j["start"], j["machine"]

    orders = {o["order_id"]: o async for o in db.orders.find({"order_id": {"$in": list(by_order)}}, ORDER_PROJ)}
    # Lo palomeado después de la simulación (dato vivo) ya no es pendiente.
    orders = {k: o for k, o in orders.items() if not all(_ready_map(o).values())}

    programadas, adelantar = [], []
    for oid, b in by_order.items():
        o = orders.get(oid)
        if not o:
            continue
        extra = {"machine": b["machine"], "start": b["start"], "target_date": b["target_date"],
                 "missing": sorted(b["missing"])}
        # Programada: el motor la arrancaría dentro de la ventana. Si tiene
        # hora es porque va a correr (lista con cuadros, o ya está en su
        # tablero MAQUINA / forzada aunque le falte otra cosa).
        if b["start"] and datetime.fromisoformat(b["start"]) <= cutoff:
            programadas.append(_card(o, extra))
        elif not (oldest and (b["cancel_date"] or "9999-12-31") < oldest):
            adelantar.append(_card(o, extra))      # zombis (cancel muy vencido) fuera
    programadas.sort(key=lambda c: c["start"])
    # Adelantar: primero lo que sólo espera cuadros (por arranque estimado);
    # luego lo que además espera otra cosa, por fecha objetivo.
    adelantar.sort(key=lambda c: (c["start"] is None or bool(c["missing"]), c["start"] or "",
                                  c["target_date"] or "9999"))
    adelantar = adelantar[:ADVANCE_MAX]

    preorders = [o async for o in db.orders.find(
        {"is_preorder": True, "art_ready_for_screens": True, "artwork_status": {"$ne": "CONVERTED"}},
        ORDER_PROJ).sort("cancel_date", 1)]
    # "Hoy" de planta (Tijuana), comparado contra sellos en UTC.
    midnight = datetime.now(TZ).replace(hour=0, minute=0, second=0, microsecond=0)
    done_today = await db.orders.count_documents(
        {"screens_done_at": {"$gte": midnight.astimezone(timezone.utc).isoformat()}})
    return {"sim_at": sim["at"], "days": days,
            "programadas": programadas, "adelantar": adelantar,
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
    _sim_cache["data"] = None
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
