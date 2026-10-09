"""Módulo de Planeación (Planner) — fase 1: configuración, proyección y motor
en MODO SOMBRA.

Modo sombra = el motor calcula el programa completo (qué orden × posición va
en qué máquina, día y turno) y qué movimientos de tablero HARÍA, pero NO toca
ninguna orden. Sirve para compararlo contra el Sheet del planeador antes de
dejarlo mover tableros solo. Las reglas viven en services/planner_engine.py.

Colecciones propias (no ensucian `orders`):
  planner_config    {config_id: "main", ...reglas}
  planner_machines  {machine: "MAQUINA<n>", active, heads, preferred_client, notes}
  planner_calendar  {cal_id, kind, date_from, date_to, shift, crews, note}
  planner_runs      corridas del motor (se guardan las últimas 20)
  planner_overrides ajustes manuales del planeador (reprogramar/fijar,
                    prioridad, forzar entrada, retener). Nunca se borran:
                    deshacer = active False, queda el historial.

Las máquinas salen de los tableros MAQUINA<n> (get_machines), como en todo
MOS: dar de alta un tablero da de alta la máquina aquí.

Endpoints (prefijo /api/planner):
  GET  /config                  reglas + máquinas + calendario + eficiencia
  PUT  /config                  edita reglas (admin)
  PUT  /machines/{machine}      activa/cabezas/cliente preferido (admin)
  POST /calendar                alta de festivo / tiempo extra / cuadrillas (admin)
  PUT  /calendar/{cal_id}       edita una excepción (admin)
  DELETE /calendar/{cal_id}     (admin)
  GET  /holidays?year=          festivos oficiales + propios
  GET  /projection              demanda vs capacidad por semana
  POST /projection/simulate     igual, con excepciones de calendario hipotéticas
  POST /shadow-run              corre el motor (no mueve nada) y guarda la corrida;
                                409 si el motor está apagado (engine_mode = off)
  GET  /shadow-run/latest       última corrida
  GET  /data-quality            órdenes abiertas con datos faltantes
  GET  /alerts                  órdenes impresas que no cambiaron de estatus
  GET  /overrides               ajustes activos + historial
  POST /overrides               nuevo ajuste (admin)
  DELETE /overrides/{id}        deshacer un ajuste (admin)
  POST /moves/apply             AUTORIZA movimientos de la última corrida (admin):
                                mueve la orden a su MAQUINA por el mismo camino
                                que el CRM (orders.move_order_core)
  GET  /moves/applied           movimientos aplicados (bitácora)
  POST /moves/applied/{id}/revert  regresa la orden a su tablero de origen (admin)

Los ajustes aplican al PROGRAMA del módulo. No tocan la orden del CRM.
El ÚNICO punto que escribe en `orders` es /moves/apply (y su revert), y sólo
cuando un administrador autoriza movimientos concretos.
"""
import uuid
import zoneinfo
from datetime import datetime, timedelta, timezone, date

from fastapi import APIRouter, HTTPException, Request

from deps import (db, require_auth, require_admin, log_activity, get_machines, machine_number,
                  DESIGN_POSITIONS)
from services import planner_engine as pe
from services import production_kpis as kpis

router = APIRouter(prefix="/api/planner")
TZ = zoneinfo.ZoneInfo("America/Tijuana")
KINDS = {"holiday", "workday", "crews", "overtime"}
SHIFT_KEYS = {"DIA", "NOCHE", "AMBOS"}
RUNS_KEPT = 20


# ── Carga de contexto ──────────────────────────────────────────────────────
async def _config() -> dict:
    saved = await db.planner_config.find_one({"config_id": "main"}, {"_id": 0}) or {}
    return pe.merge_config(saved)


async def _machines() -> list:
    names = await get_machines()
    saved = {m["machine"]: m async for m in db.planner_machines.find({}, {"_id": 0})}
    out = []
    for n in names:
        out.append({"machine": n, "number": machine_number(n),
                    **pe.MACHINE_DEFAULTS, **{k: v for k, v in saved.get(n, {}).items()
                                              if k in ("active", "heads", "preferred_client", "notes",
                                                       "dedicated", "pallet_size", "has_folder")}})
    return out


async def _calendar_entries() -> list:
    return [e async for e in db.planner_calendar.find({}, {"_id": 0}).sort("date_from", 1)]


def _shift_date(dt_local: datetime, shift: str) -> date:
    # La noche que cruza la medianoche pertenece al día en que empezó
    # (regla única en services/production_kpis.op_date).
    return kpis.op_date(dt_local, shift)


SHIFT_FROM_LOG = {"TURNO 1": "DIA", "TURNO 2": "NOCHE"}


async def _measured_efficiency(cfg: dict) -> dict:
    """Capacidad histórica medida en production_logs (últimas 8 semanas). La
    cuenta vive en pe.measure_history; aquí sólo se leen los registros."""
    today = datetime.now(TZ).date()
    since_day = pe.week_start(today) - timedelta(weeks=8)
    since = datetime.combine(since_day, datetime.min.time(), tzinfo=TZ).astimezone(timezone.utc).isoformat()
    records = []
    cursor = db.production_logs.find(
        {"created_at": {"$gte": since}},
        {"_id": 0, "created_at": 1, "machine": 1, "shift": 1, "quantity_produced": 1, "order_id": 1},
    ).batch_size(500)
    async for log in cursor:
        try:
            dt = datetime.fromisoformat(str(log["created_at"])).astimezone(TZ)
        except (KeyError, ValueError):
            continue
        shift = log.get("shift") or ""
        records.append({"date": _shift_date(dt, shift), "shift": SHIFT_FROM_LOG.get(shift, shift),
                        "machine": log.get("machine"), "qty": int(log.get("quantity_produced") or 0),
                        "dt": dt, "order_id": log.get("order_id")})
    # Tamaño de corrida = piezas de la orden (la misma clase Bajo/Medio/Alto del motor).
    ids = list({r["order_id"] for r in records if r["order_id"]})
    order_qty = {}
    for i in range(0, len(ids), 500):
        async for o in db.orders.find({"order_id": {"$in": ids[i:i + 500]}}, {"_id": 0, "order_id": 1, "quantity": 1}):
            order_qty[o["order_id"]] = o.get("quantity") or 0
    for r in records:
        r["order_qty"] = order_qty.get(r["order_id"], 0)
    hist = pe.measure_history(records, cfg, today, since_day)
    runs = pe.measure_run_rates([r for r in records if r["order_id"] and r["date"] < today], cfg)
    hist["run_rates"] = runs
    # Eficiencia "automática" = velocidad real promedio de todas las corridas
    # contra la de la regla (rate_pph).
    if runs.get("global_rate"):
        hist["value"] = round(runs["global_rate"] / float(cfg["rate_pph"]), 3)
    return hist


async def _efficiency(cfg: dict) -> dict:
    measured = await _measured_efficiency(cfg)
    if cfg["efficiency_mode"] == "manual" or measured["value"] is None:
        applied = float(cfg["efficiency_manual_pct"]) / 100.0
    else:
        applied = measured["value"]
    return {"mode": cfg["efficiency_mode"], "measured": measured, "applied": applied}


async def _orders_and_production(cfg: dict, machines: list):
    boards = list(cfg["demand_boards"]) + [m["machine"] for m in machines]
    proj = {"_id": 0, "order_id": 1, "order_number": 1, "client": 1, "branding": 1, "board": 1,
            "quantity": 1, "print_positions": 1, "hits_impresiones": 1, "colors": 1,
            "cancel_date": 1, "blank_status": 1, "screens": 1, "production_status": 1,
            "priority": 1, "color": 1, "aprobaciones": 1, "sample": 1, "artwork_status": 1,
            "design_#": 1, "customer_po": 1, "packing_type": 1, "work_order.lines": 1}
    orders = [o async for o in db.orders.find({"board": {"$in": boards}}, proj).batch_size(200)]
    ids = [o["order_id"] for o in orders if o.get("order_id")]
    produced = {}
    if ids:
        pipe = [{"$match": {"order_id": {"$in": ids}}},
                {"$group": {"_id": {"o": "$order_id", "p": "$design_type"},
                            "n": {"$sum": "$quantity_produced"}}}]
        async for r in db.production_logs.aggregate(pipe):
            produced.setdefault(r["_id"]["o"], {})[(r["_id"].get("p") or "").upper()] = r["n"]
    return orders, produced


async def _sample_approved() -> set:
    """order_id con su ejemplo APROBADO en el módulo de Ejemplos."""
    return {t["order_id"] async for t in db.sample_tasks.find(
        {"approval": "APROBADO", "order_id": {"$nin": [None, ""]}}, {"_id": 0, "order_id": 1})}


OVERRIDE_KINDS = {"assign", "priority", "force", "hold"}
PRIORITY_LEVELS = {"TOP", "UP", "DOWN"}


async def _active_overrides() -> list:
    return [o async for o in db.planner_overrides.find({"active": True}, {"_id": 0}).sort("created_at", 1)]


def _resolve_overrides(jobs: list, active: list) -> dict:
    """{job_id: {kind: params}}. Lo de la orden completa (posición "*") aplica
    a todas sus posiciones; un ajuste de la posición gana sobre el de la orden."""
    by_target = {}
    for o in active:
        by_target.setdefault(o["target"], {})[o["kind"]] = o.get("params") or {}
    out = {}
    for j in jobs:
        merged = {**by_target.get(f"{j['order_id']}:*", {}), **by_target.get(j["job_id"], {})}
        if merged:
            out[j["job_id"]] = merged
    return out


async def _context(extra_entries=None):
    cfg = await _config()
    machines = await _machines()
    entries = await _calendar_entries() + list(extra_entries or [])
    active = [m for m in machines if m.get("active")]
    cal = pe.Calendar(cfg, entries, max_machines=len(active))
    eff = await _efficiency(cfg)
    orders, produced = await _orders_and_production(cfg, machines)
    now = datetime.now(TZ)
    jobs, issues = pe.build_jobs(orders, produced, cfg, cal, [m["machine"] for m in machines], now.date(),
                                 await _sample_approved())
    return {"cfg": cfg, "machines": machines, "active": active, "entries": entries, "cal": cal,
            "eff": eff, "orders": orders, "jobs": jobs, "issues": issues, "now": now}


# ── Configuración ──────────────────────────────────────────────────────────
@router.get("/config")
async def get_config(request: Request):
    await require_auth(request)
    cfg = await _config()
    return {"config": cfg, "defaults": pe.DEFAULT_CONFIG, "machines": await _machines(),
            "calendar": await _calendar_entries(), "efficiency": await _efficiency(cfg),
            "heads_range": [pe.HEADS_MIN, pe.HEADS_MAX]}


def _validate_config(body: dict) -> dict:
    clean = {}
    for k, v in body.items():
        if k not in pe.DEFAULT_CONFIG:
            raise HTTPException(400, f"Regla desconocida: {k}")
        default = pe.DEFAULT_CONFIG[k]
        if isinstance(default, bool):
            if not isinstance(v, bool):
                raise HTTPException(400, f"{k} debe ser sí/no")
        elif isinstance(default, (int, float)):
            try:
                v = float(v)
            except (TypeError, ValueError):
                raise HTTPException(400, f"{k} debe ser un número")
            if v < 0:
                raise HTTPException(400, f"{k} no puede ser negativo")
            v = int(v) if isinstance(default, int) and v.is_integer() else v
        elif isinstance(default, list):
            if not isinstance(v, list):
                raise HTTPException(400, f"{k} debe ser una lista")
        elif isinstance(default, str) and not isinstance(v, str):
            raise HTTPException(400, f"{k} debe ser texto")
        clean[k] = v
    if "shifts" in clean:
        shifts = []
        for s in clean["shifts"]:
            if s.get("key") not in ("DIA", "NOCHE"):
                raise HTTPException(400, "Los turnos son DIA y NOCHE")
            try:
                datetime.strptime(str(s.get("start")), "%H:%M")
                hours, crews = float(s.get("hours")), int(s.get("crews"))
            except (TypeError, ValueError):
                raise HTTPException(400, "Turno inválido: inicio HH:MM, horas y cuadrillas numéricas")
            if not (0 < hours <= 24) or crews < 0:
                raise HTTPException(400, "Turno inválido: horas 1–24, cuadrillas ≥ 0")
            shifts.append({"key": s["key"], "start": s["start"], "hours": hours, "crews": crews})
        clean["shifts"] = shifts
    if "base_weekdays" in clean and not all(isinstance(d, int) and 0 <= d <= 6 for d in clean["base_weekdays"]):
        raise HTTPException(400, "Días base: números 0 (lunes) a 6 (domingo)")
    if clean.get("efficiency_mode", "auto") not in ("auto", "manual"):
        raise HTTPException(400, "efficiency_mode: auto o manual")
    if clean.get("engine_mode", "off") not in ("off", "shadow"):
        raise HTTPException(400, "Por ahora el motor sólo puede estar apagado o en modo sombra")
    for key in ("packing_priority", "position_order"):
        if key in clean:
            vals = [str(x).strip() for x in clean[key]]
            if any(not x for x in vals) or len(set(vals)) != len(vals):
                raise HTTPException(400, f"{key}: valores no vacíos y sin repetir")
            clean[key] = vals
    if "volume_low_max" in clean or "volume_high_min" in clean:
        pass  # la relación entre ambos se revisa con la config completa
    return clean


@router.put("/config")
async def put_config(request: Request):
    user = await require_admin(request)
    body = await request.json()
    clean = _validate_config(body or {})
    before = await _config()
    merged = {**before, **clean}
    if merged["volume_low_max"] > merged["volume_high_min"]:
        raise HTTPException(400, "El límite de Bajo no puede ser mayor que el de Alto")
    await db.planner_config.update_one({"config_id": "main"},
                                       {"$set": {**clean, "updated_at": datetime.now(timezone.utc).isoformat(),
                                                 "updated_by": user.get("email")}}, upsert=True)
    await log_activity(user, "planner_config_update", {"changes": clean},
                       {k: before.get(k) for k in clean})
    return {"config": await _config()}


@router.put("/machines/{machine}")
async def put_machine(machine: str, request: Request):
    user = await require_admin(request)
    if machine not in await get_machines():
        raise HTTPException(404, "Esa máquina no existe como tablero MAQUINA<n>")
    body = await request.json() or {}
    upd = {}
    if "active" in body:
        upd["active"] = bool(body["active"])
    if "heads" in body:
        try:
            heads = int(body["heads"])
        except (TypeError, ValueError):
            raise HTTPException(400, "Cabezas debe ser un número")
        if not pe.HEADS_MIN <= heads <= pe.HEADS_MAX:
            raise HTTPException(400, f"Cabezas entre {pe.HEADS_MIN} y {pe.HEADS_MAX}")
        upd["heads"] = heads
    if "preferred_client" in body:
        upd["preferred_client"] = str(body["preferred_client"] or "").strip()
    if "dedicated" in body:
        upd["dedicated"] = bool(body["dedicated"])
    if "notes" in body:
        upd["notes"] = str(body["notes"] or "").strip()[:300]
    if "pallet_size" in body:
        upd["pallet_size"] = str(body["pallet_size"] or "").strip()[:40]
    if "has_folder" in body:
        upd["has_folder"] = bool(body["has_folder"])
    if not upd:
        raise HTTPException(400, "Nada que cambiar")
    before = await db.planner_machines.find_one({"machine": machine}, {"_id": 0})
    await db.planner_machines.update_one(
        {"machine": machine},
        {"$set": {**upd, "updated_at": datetime.now(timezone.utc).isoformat(), "updated_by": user.get("email")}},
        upsert=True)
    await log_activity(user, "planner_machine_update", {"machine": machine, "changes": upd}, before)
    return {"machines": await _machines()}


@router.delete("/machines/{machine}")
async def delete_machine_settings(machine: str, request: Request):
    """Limpia los ajustes del planner de una máquina (cabezas, cliente, activa).
    Se llama al eliminar su tablero MAQUINA<n> para que una máquina recreada con
    el mismo nombre no herede ajustes viejos. NO toca el tablero ni las órdenes:
    de eso se encarga el CRUD de tableros del CRM (/api/config/boards)."""
    user = await require_admin(request)
    before = await db.planner_machines.find_one({"machine": machine}, {"_id": 0})
    res = await db.planner_machines.delete_one({"machine": machine})
    if before:
        await log_activity(user, "planner_machine_settings_delete", {"machine": machine}, before)
    return {"deleted": res.deleted_count}


# ── Calendario ─────────────────────────────────────────────────────────────
def _validate_entry(body: dict) -> dict:
    kind = body.get("kind")
    if kind not in KINDS:
        raise HTTPException(400, "Tipo: holiday, workday, crews u overtime")
    d_from = pe.parse_date(body.get("date_from"))
    d_to = pe.parse_date(body.get("date_to")) or d_from
    if not d_from or d_to < d_from:
        raise HTTPException(400, "Fechas inválidas")
    if (d_to - d_from).days > 366:
        raise HTTPException(400, "Rango máximo de un año")
    shift = body.get("shift") or "AMBOS"
    if shift not in SHIFT_KEYS:
        raise HTTPException(400, "Turno: DIA, NOCHE o AMBOS")
    entry = {"kind": kind, "date_from": d_from.isoformat(), "date_to": d_to.isoformat(),
             "shift": shift, "note": str(body.get("note") or "").strip()[:200]}
    if kind in ("crews", "overtime"):
        try:
            entry["crews"] = int(body.get("crews"))
        except (TypeError, ValueError):
            raise HTTPException(400, "Indica cuántas cuadrillas")
        if entry["crews"] < 0:
            raise HTTPException(400, "Cuadrillas no puede ser negativo")
    if kind == "overtime":
        # Horas del tiempo extra (opcional): sin horas = turno completo.
        if body.get("hours") not in (None, ""):
            try:
                hours = float(body.get("hours"))
            except (TypeError, ValueError):
                raise HTTPException(400, "Horas debe ser un número")
            if not 0 < hours <= 24:
                raise HTTPException(400, "Horas entre 0.5 y 24")
            entry["hours"] = round(hours, 2)
        if body.get("start"):
            try:
                datetime.strptime(str(body.get("start")), "%H:%M")
            except ValueError:
                raise HTTPException(400, "Hora de inicio HH:MM")
            entry["start"] = str(body.get("start"))
    return entry


@router.post("/calendar")
async def add_calendar(request: Request):
    user = await require_admin(request)
    entry = _validate_entry(await request.json() or {})
    entry.update({"cal_id": f"cal_{uuid.uuid4().hex[:10]}",
                  "created_at": datetime.now(timezone.utc).isoformat(), "created_by": user.get("email")})
    await db.planner_calendar.insert_one(dict(entry))
    await log_activity(user, "planner_calendar_add", entry)
    return {"calendar": await _calendar_entries()}


@router.put("/calendar/{cal_id}")
async def edit_calendar(cal_id: str, request: Request):
    """Edita una excepción (p. ej. cambiar horas o cuadrillas del tiempo extra)."""
    user = await require_admin(request)
    before = await db.planner_calendar.find_one({"cal_id": cal_id}, {"_id": 0})
    if not before:
        raise HTTPException(404, "No existe")
    entry = _validate_entry(await request.json() or {})
    entry.update({"updated_at": datetime.now(timezone.utc).isoformat(), "updated_by": user.get("email")})
    unset = {k: "" for k in ("hours", "start", "crews") if k in before and k not in entry}
    ops = {"$set": entry}
    if unset:
        ops["$unset"] = unset
    await db.planner_calendar.update_one({"cal_id": cal_id}, ops)
    await log_activity(user, "planner_calendar_edit", {"cal_id": cal_id, **entry}, before)
    return {"calendar": await _calendar_entries()}


@router.delete("/calendar/{cal_id}")
async def delete_calendar(cal_id: str, request: Request):
    user = await require_admin(request)
    before = await db.planner_calendar.find_one({"cal_id": cal_id}, {"_id": 0})
    if not before:
        raise HTTPException(404, "No existe")
    await db.planner_calendar.delete_one({"cal_id": cal_id})
    await log_activity(user, "planner_calendar_delete", {"cal_id": cal_id}, before)
    return {"calendar": await _calendar_entries()}


@router.get("/holidays")
async def holidays(request: Request, year: int = 0):
    await require_auth(request)
    year = year or datetime.now(TZ).year
    official = [{"date": d, "name": n, "source": "oficial"} for d, n in sorted(pe.mx_holidays(year).items())]
    own = [e for e in await _calendar_entries()
           if e["kind"] in ("holiday", "workday") and e["date_from"][:4] <= str(year) <= e["date_to"][:4]]
    return {"year": year, "official": official, "custom": own}


# ── Proyección ─────────────────────────────────────────────────────────────
async def _projection(extra_entries=None):
    ctx = await _context(extra_entries)
    res = pe.projection(ctx["jobs"], ctx["cfg"], ctx["cal"], ctx["now"].date(),
                        ctx["eff"]["applied"], len(ctx["active"]), ctx["eff"]["measured"].get("run_rates"))
    res.update({"efficiency": ctx["eff"], "active_machines": len(ctx["active"]),
                "shifts": ctx["cfg"]["shifts"], "people_per_crew": ctx["cfg"]["people_per_crew"],
                "generated_at": ctx["now"].isoformat()})
    return res


@router.get("/projection")
async def get_projection(request: Request):
    await require_auth(request)
    return await _projection()


@router.post("/projection/simulate")
async def simulate_projection(request: Request):
    """Escenario "¿y si…?": las excepciones del cuerpo se suman al calendario
    SOLO para este cálculo. No se guarda nada."""
    await require_auth(request)
    body = await request.json() or {}
    entries = [_validate_entry(e) for e in (body.get("entries") or [])][:50]
    return await _projection(entries)


# ── Motor en modo sombra ───────────────────────────────────────────────────
def _moves(scheduled: list, orders: list, now: datetime, cfg: dict):
    """Movimientos de tablero que el motor HARÍA: órdenes cuyo trabajo arranca
    dentro del turno en curso o el siguiente y cuyo tablero no es la máquina
    que les toca (regla: la máquina con el job más grande)."""
    by_order = {}
    for j in scheduled:
        by_order.setdefault(j["order_id"], []).append(j)
    board_now = {o["order_id"]: o.get("board") for o in orders}
    horizon = now + timedelta(hours=max(float(s.get("hours") or 12) for s in cfg["shifts"]))
    moves = []
    for oid, js in by_order.items():
        starts = [j["start"] for j in js if j.get("start")]
        if not starts or datetime.fromisoformat(min(starts)) > horizon:
            continue
        # Si alguna posición ya corre en la máquina donde está la orden, la
        # orden se queda ahí: no se desmonta lo que está montado.
        if board_now.get(oid) in {m for j in js for m in j.get("machines", [])}:
            continue
        target = pe.board_for_order(js)
        if target and board_now.get(oid) != target:
            j0 = js[0]
            moves.append({"order_id": oid, "order_number": j0["order_number"], "client": j0["client"],
                          "from_board": board_now.get(oid), "to_board": target, "start": min(starts),
                          "positions": [{"position": j["position"], "machines": j["machines"]} for j in js],
                          "reason": "Arranca en el turno actual o el siguiente"})
    return sorted(moves, key=lambda m: m["start"])


def _calendar_windows(ctx) -> list:
    """Todos los turnos del horizonte, semana completa (lunes a domingo),
    con cuántas cuadrillas corren y el festivo si lo hay. La grilla los pinta
    aunque estén vacíos: un viernes sin tiempo extra se ve como "sin turno"."""
    ws = pe.week_start(ctx["now"].date())
    out = []
    for i in range(int(ctx["cfg"]["horizon_weeks"]) * 7):
        d = ws + timedelta(days=i)
        hol = ctx["cal"].holiday_name(d)
        for s in ctx["cfg"]["shifts"]:
            st, hrs = ctx["cal"].window(d, s["key"], s["start"], float(s.get("hours") or 12))
            out.append({"date": d.isoformat(), "shift": s["key"],
                        "crews": ctx["cal"].crews(d, s["key"]), "holiday": hol,
                        "start": st, "hours": hrs, "overtime": d.weekday() not in ctx["cal"].base_weekdays})
    return out


@router.post("/shadow-run")
async def shadow_run(request: Request, trigger: str = "manual", max_age: int = 0):
    """trigger: manual | auto_timer | auto_change | override | config (sólo etiqueta).
    max_age (segundos): si la última corrida es más nueva que eso, se regresa
    ésa en vez de recalcular. Lo usan los recálculos automáticos: con varias
    pantallas abiertas, un mismo cambio de orden dispara una sola corrida."""
    user = await require_auth(request)
    if trigger not in ("manual", "auto_timer", "auto_change", "override", "config"):
        trigger = "manual"
    if max_age > 0:
        last = await db.planner_runs.find_one({}, {"_id": 0}, sort=[("created_at", -1)])
        if last:
            age = (datetime.now(timezone.utc) - datetime.fromisoformat(last["created_at"])).total_seconds()
            if age < max_age:
                return {**last, "reused": True}
    ctx = await _context()
    if ctx["cfg"]["engine_mode"] != "shadow":
        raise HTTPException(409, "El motor está apagado. Enciéndelo desde el módulo de Planeación.")
    board_of = {o["order_id"]: o.get("board") for o in ctx["orders"]}
    active_ov = await _active_overrides()
    ov = _resolve_overrides(ctx["jobs"], active_ov)
    scheduled = pe.schedule(ctx["jobs"], ctx["machines"], ctx["cfg"], ctx["cal"], ctx["now"],
                            ctx["eff"]["applied"], board_of, ov,
                            ctx["eff"]["measured"].get("run_rates"))
    in_plan = {j["job_id"] for j in scheduled}
    blocked = []
    for j in ctx["jobs"]:
        if j["job_id"] in in_plan:
            continue
        row = {k: j[k] for k in ("job_id", "order_id", "order_number", "client", "branding", "board",
                                 "position", "remaining", "cancel_date", "target_date", "ready", "volume",
                                 "kind", "sample_state", "has_extra_work", "extra_work")}
        row["held"] = "hold" in ov.get(j["job_id"], {})
        row["manual"] = sorted(ov.get(j["job_id"], {}))
        blocked.append(row)

    # Impacto contra la corrida anterior: qué trabajos cambiaron de estatus.
    prev = await db.planner_runs.find_one({}, {"_id": 0, "jobs.job_id": 1, "jobs.status": 1,
                                                "blocked.job_id": 1}, sort=[("created_at", -1)])
    impact = []
    if prev:
        before = {j["job_id"]: j.get("status") for j in prev.get("jobs", [])}
        before.update({b["job_id"]: "BLOQUEADA" for b in prev.get("blocked", [])})
        now_status = {j["job_id"]: (j["order_number"], j["position"], j["status"]) for j in scheduled}
        now_status.update({b["job_id"]: (b["order_number"], b["position"], "BLOQUEADA") for b in blocked})
        for jid, (num, pos, st) in now_status.items():
            was = before.get(jid)
            if was and was != st:
                impact.append({"job_id": jid, "order_number": num, "position": pos, "from": was, "to": st})
    counts = {}
    for j in scheduled:
        counts[j["status"]] = counts.get(j["status"], 0) + 1
    run = {
        "run_id": f"prun_{uuid.uuid4().hex[:10]}",
        "mode": "shadow", "trigger": trigger,
        "created_at": datetime.now(timezone.utc).isoformat(),
        "created_by": user.get("email"),
        "now_local": ctx["now"].isoformat(),
        "efficiency": ctx["eff"]["applied"],
        "hits_per_shift": ctx["cfg"]["hits_per_shift"],
        "active_machines": [m["machine"] for m in ctx["active"]],
        "stats": {"jobs_total": len(ctx["jobs"]), "scheduled": len(scheduled), "blocked": len(blocked),
                  "by_status": counts,
                  "hits_scheduled": sum(j["remaining"] for j in scheduled)},
        "jobs": sorted(scheduled, key=lambda j: j.get("start") or "9999"),
        "blocked": sorted(blocked, key=lambda j: j.get("target_date") or "9999"),
        "moves": _moves(scheduled, ctx["orders"], ctx["now"], ctx["cfg"]),
        "impact": impact,
        "overrides_active": len(active_ov),
        "windows": _calendar_windows(ctx),
        "data_issues": len(ctx["issues"]),
    }
    await db.planner_runs.insert_one(dict(run))
    old = [r["run_id"] async for r in db.planner_runs.find({}, {"run_id": 1}).sort("created_at", -1).skip(RUNS_KEPT)]
    if old:
        await db.planner_runs.delete_many({"run_id": {"$in": old}})
    return run


@router.get("/shadow-run/latest")
async def latest_run(request: Request):
    await require_auth(request)
    run = await db.planner_runs.find_one({}, {"_id": 0}, sort=[("created_at", -1)])
    return run or {}


@router.get("/lookup")
async def lookup(request: Request, q: str = ""):
    """Buscador global del módulo: órdenes por número, PO de cliente, cliente,
    branding o diseño, con la RAZÓN por la que están o no en la planeación
    (sirve para "¿por qué no veo la 3215?"). Sólo lectura."""
    import re
    await require_auth(request)
    q = (q or "").strip()
    if len(q) < 2:
        return {"rows": []}
    rx = {"$regex": re.escape(q), "$options": "i"}
    cfg = await _config()
    machines = await get_machines()
    demand = set(cfg["demand_boards"]) | set(machines)
    printed = {s.upper() for s in cfg["printed_statuses"]}
    cur = db.orders.find(
        {"board": {"$ne": "PAPELERA DE RECICLAJE"},
         "$or": [{"order_number": rx}, {"customer_po": rx}, {"client": rx}, {"branding": rx}, {"design_#": rx}]},
        {"_id": 0, "order_id": 1, "order_number": 1, "customer_po": 1, "client": 1, "branding": 1,
         "board": 1, "production_status": 1, "cancel_date": 1, "quantity": 1, "design_#": 1},
    ).sort("order_number", -1).limit(25)
    rows = []
    async for o in cur:
        status = str(o.get("production_status") or "").strip().upper()
        if o.get("board") not in demand:
            reason, code = f"Tablero {o.get('board')}: no cuenta como demanda", "board"
        elif status in printed:
            reason, code = f"Ya impresa ({o.get('production_status')})", "printed"
        elif not pe.parse_date(o.get("cancel_date")):
            reason, code = "Sin cancel date", "no_cancel"
        else:
            reason, code = "", "in_plan"
        rows.append({**o, "design": o.pop("design_#", None), "reason": reason, "reason_code": code})
    return {"rows": rows}


@router.get("/data-quality")
async def data_quality(request: Request):
    await require_auth(request)
    ctx = await _context()
    summary = {}
    for i in ctx["issues"]:
        for f in i["flags"]:
            summary[f] = summary.get(f, 0) + 1
    return {"orders_open": len(ctx["orders"]), "with_issues": len(ctx["issues"]), "summary": summary,
            "rows": sorted(ctx["issues"], key=lambda r: r.get("cancel_date") or "9999"),
            "default_colors": ctx["cfg"]["default_colors"]}


# ── Alertas ────────────────────────────────────────────────────────────────
# Tableros donde una orden ya está cerrada o fuera del flujo: no alertan.
ALERT_EXCLUDED_BOARDS = ["PAPELERA DE RECICLAJE", "CANCELLED", "COMPLETOS", "FINAL BILL",
                         "EDI", "INVENTARIO", "EJEMPLOS", "RESPALDO MONDAY"]


@router.get("/alerts")
async def alerts(request: Request):
    """Órdenes impresas (según production_logs) que no cambiaron de estatus.
    Parte de lo capturado en los últimos 90 días; no depende del motor."""
    await require_auth(request)
    cfg = await _config()
    since = (datetime.now(timezone.utc) - timedelta(days=90)).isoformat()
    produced, last_log = {}, {}
    pipe = [{"$match": {"created_at": {"$gte": since}}},
            {"$group": {"_id": {"o": "$order_id", "p": "$design_type"},
                        "n": {"$sum": "$quantity_produced"}, "last": {"$max": "$created_at"}}}]
    async for r in db.production_logs.aggregate(pipe):
        oid = r["_id"]["o"]
        produced.setdefault(oid, {})[(r["_id"].get("p") or "").upper()] = r["n"]
        if r["last"] and str(r["last"]) > str(last_log.get(oid, "")):
            last_log[oid] = r["last"]
    orders = []
    ids = list(produced)
    for i in range(0, len(ids), 500):
        async for o in db.orders.find(
                {"order_id": {"$in": ids[i:i + 500]}, "board": {"$nin": ALERT_EXCLUDED_BOARDS}},
                {"_id": 0, "order_id": 1, "order_number": 1, "client": 1, "branding": 1, "board": 1,
                 "production_status": 1, "cancel_date": 1, "quantity": 1, "print_positions": 1,
                 "hits_impresiones": 1}):
            orders.append(o)
    rows = pe.stale_printed(orders, produced, last_log, cfg, datetime.now(timezone.utc))
    return {"printed_stale": rows, "days": cfg["printed_alert_days"], "pct": cfg["printed_complete_pct"]}


# ── Terminadas de pintar (seguimiento post-impresión) ──────────────────────
# "Terminada de pintar" = ya se imprimió y entró a empaque (production_status).
# Se ocultan las que ya terminaron su flujo (board terminal / facturadas).
PAINT_DONE_STATUS = "EN PROCESO DE EMPAQUE"
PAINT_DONE_EXCLUDED_BOARDS = ["FINAL BILL", "COMPLETOS", "CANCELLED",
                             "PAPELERA DE RECICLAJE", "INVENTARIO", "EJEMPLOS"]


@router.get("/paint-followup")
async def paint_followup(request: Request):
    """Órdenes que terminaron de imprimirse (production_status EN PROCESO DE
    EMPAQUE) y siguen en proceso, para darles seguimiento desde MOS. Sólo
    lectura; no depende del motor."""
    await require_auth(request)
    orders = []
    async for o in db.orders.find(
            {"production_status": PAINT_DONE_STATUS, "board": {"$nin": PAINT_DONE_EXCLUDED_BOARDS}},
            {"_id": 0, "order_id": 1, "order_number": 1, "client": 1, "branding": 1, "board": 1,
             "production_status": 1, "production_status_at": 1, "updated_at": 1,
             "cancel_date": 1, "quantity": 1, "customer_po": 1}):
        orders.append({
            "order_id": o.get("order_id"), "order_number": o.get("order_number"),
            "client": o.get("client"), "branding": o.get("branding"), "board": o.get("board"),
            "production_status": o.get("production_status"),
            "since": o.get("production_status_at") or o.get("updated_at"),
            "cancel_date": o.get("cancel_date"), "quantity": o.get("quantity"),
            "customer_po": o.get("customer_po"),
        })
    orders.sort(key=lambda r: str(r.get("since") or ""), reverse=True)
    return {"status": PAINT_DONE_STATUS, "count": len(orders), "orders": orders}


# ── Dashboard de producción (una sola fuente de verdad, solo lectura) ───────
@router.get("/dashboard")
async def dashboard(request: Request):
    """Resumen de producción para piso/dirección: producido esta semana,
    pendiente, capacidad para adelantar (regular + extra), demanda de la próxima
    semana, brecha, envíos por día, Test Orders separadas y excepciones de la
    auditoría. Solo lectura; no mueve nada."""
    await require_auth(request)
    return await build_dashboard()


async def build_dashboard() -> dict:
    """Cuenta del dashboard sin Request: la usa también el reporte por correo
    (services/production_kpis). Hits y piezas (units) siempre por separado."""
    ctx = await _context()
    cfg, cal, jobs, now = ctx["cfg"], ctx["cal"], ctx["jobs"], ctx["now"]
    eff = ctx["eff"]["applied"]
    today = now.date()
    w0 = pe.week_start(today)
    cap_shift = cfg["hits_per_shift"] * eff

    def week_cap(ws):   # capacidad futura de la semana, separando regular vs extra
        reg = ot = 0.0
        for k in range(7):
            d = ws + timedelta(days=k)
            if d < today:
                continue
            for s in cfg["shifts"]:
                full_h = float(s.get("hours") or 12)
                c = cal.crews(d, s["key"])
                _, hrs = cal.window(d, s["key"], "00:00", full_h)
                cap = c * cap_shift * (hrs / full_h)
                if d.weekday() in cal.base_weekdays:
                    reg += cap
                else:
                    ot += cap
        return round(reg), round(ot)

    # Demanda por semana (misma cuenta que la proyección), sólo this/next.
    res = pe.projection(jobs, cfg, cal, today, eff, len(ctx["active"]), None)
    weeks = res["weeks"]
    this_reg, this_ot = week_cap(w0)
    next_reg, next_ot = week_cap(w0 + timedelta(weeks=1))

    # Producido real esta semana (production_logs), por DÍA OPERATIVO: la noche
    # del domingo que se captura el lunes de madrugada es de la semana pasada.
    prod_week = kpis.sum_days(await kpis.produced_window(w0, today), w0, today)

    # Producido por orden + última captura por máquina/orden (para test y excepciones).
    oids = [o["order_id"] for o in ctx["orders"] if o.get("order_id")]
    produced, last_order = {}, {}
    for i in range(0, len(oids), 400):
        async for r in db.production_logs.aggregate([
                {"$match": {"order_id": {"$in": oids[i:i + 400]}}},
                {"$group": {"_id": "$order_id", "n": {"$sum": "$quantity_produced"},
                            "last": {"$max": "$created_at"}}}]):
            produced[r["_id"]] = r["n"]
            last_order[r["_id"]] = r["last"]
    last_machine = {}
    async for r in db.production_logs.aggregate([
            {"$group": {"_id": "$machine", "last": {"$max": "$created_at"}}}]):
        last_machine[r["_id"]] = r["last"]

    order_by_id = {o["order_id"]: o for o in ctx["orders"]}

    def req(o):
        pos = len([x for x in (o.get("print_positions") or []) if x]) or 1
        return int(o.get("quantity") or 0) * pos

    # Piezas pendientes por orden = las de la ubicación más atrasada (misma
    # regla que kpis.measure: la ubicación más grande manda). Un job es una
    # ubicación; sus piezas = hits restantes ÷ hits por pieza de esa ubicación.
    order_units = {}
    for j in jobs:
        mult = (j["hits"] / j["quantity"]) if j.get("quantity") else 1
        order_units[j["order_id"]] = max(order_units.get(j["order_id"], 0), j["remaining"] / (mult or 1))

    def units_once(j, seen):   # cada orden suma sus piezas una sola vez
        if j["order_id"] in seen:
            return 0
        seen.add(j["order_id"])
        return order_units.get(j["order_id"], 0)

    # Piezas por semana: mismo reparto que pe.projection (atrasado pesa hoy,
    # sin fecha o más allá del horizonte no entra).
    week_units, seen_w = {0: 0.0, 1: 0.0}, set()
    for j in jobs:
        t = pe.parse_date(j.get("target_date"))
        if t is None:
            continue
        t = max(t, today)
        k = (pe.week_start(t) - w0).days // 7
        if k in week_units:
            week_units[k] += units_once(j, seen_w)

    # Test Orders separadas (branding ~ TEST): pendiente por semana + producido.
    test_pend = test_this = test_next = test_prod = 0
    test_pend_u, seen_t = 0.0, set()
    test_this_u, seen_tt, test_next_u, seen_tn = 0.0, set(), 0.0, set()
    test_oids = set()
    test_job_pend = {}   # order_id -> [hits pendientes, piezas pendientes]
    for j in jobs:
        o = order_by_id.get(j["order_id"]) or {}
        if pe.is_test_branding(o.get("branding") or j.get("branding"), cfg):
            test_oids.add(j["order_id"])
            test_pend += j["remaining"]
            test_pend_u += units_once(j, seen_t)
            acc = test_job_pend.setdefault(j["order_id"], [0, 0.0])
            acc[0] += j["remaining"]
            acc[1] = order_units.get(j["order_id"], 0)
            t = pe.parse_date(j.get("target_date"))
            if t and t < today:
                t = today
            if t and w0 <= t < w0 + timedelta(days=7):
                test_this += j["remaining"]
                test_this_u += units_once(j, seen_tt)
            elif t and w0 + timedelta(days=7) <= t < w0 + timedelta(days=14):
                test_next += j["remaining"]
                test_next_u += units_once(j, seen_tn)
    for oid in test_oids:
        test_prod += produced.get(oid, 0)

    # Programa TEST completo (todos los tableros, no solo demanda) para que
    # cuadre con lo que se ve en MASTER: abiertas = por imprimir + ya impresas
    # en proceso. "Abierta" = no en tablero terminal ni ya enviada/cancelada.
    patterns = [str(p) for p in cfg.get("test_branding_patterns", []) if str(p).strip()]
    test_open = test_toprint = test_printed = 0
    test_items = []
    if patterns:
        brx = {"$regex": "|".join(patterns), "$options": "i"}
        demand_set = set(cfg["demand_boards"]) | {m["machine"] for m in ctx["machines"]}
        term = {"FINAL BILL", "COMPLETOS", "CANCELLED", "PAPELERA DE RECICLAJE"}
        ship_st = {"LISTO PARA ENVIO", "LISTO PARA INVENTARIO", "ENVIADO TIJANA-SAN DIEGO", "CANCELLED"}
        printed_st = {s.upper() for s in cfg["printed_statuses"]}
        async for o in db.orders.find({"branding": brx}, {"_id": 0, "order_id": 1, "order_number": 1, "board": 1,
                                                          "production_status": 1, "cancel_date": 1, "quantity": 1}):
            st = (o.get("production_status") or "").upper()
            if o.get("board") in term or st in ship_st:
                continue
            test_open += 1
            to_print = o.get("board") in demand_set and st not in printed_st
            if to_print:
                test_toprint += 1
            else:
                test_printed += 1
            pend = test_job_pend.get(o.get("order_id"), [0, 0])
            cd = pe.parse_date(o.get("cancel_date"))
            test_items.append({"order_number": str(o.get("order_number") or ""), "board": o.get("board"),
                               "production_status": o.get("production_status"), "quantity": o.get("quantity"),
                               "stage": "to_print" if to_print else "in_process",
                               "pending": pend[0], "pending_units": round(pend[1]),
                               "cancel_date": cd.isoformat() if cd else None})
        # Primero las que faltan por imprimir, por fecha de cancelación.
        test_items.sort(key=lambda x: (x["stage"] != "to_print", x["cancel_date"] or "9999", x["order_number"]))

    # Envíos comprometidos por día (próximos 10 días, por cancel date).
    ship, seen_s = {}, set()
    for j in jobs:
        cd = pe.parse_date(j.get("cancel_date"))
        if cd and today <= cd < today + timedelta(days=10):
            acc = ship.setdefault(cd.isoformat(), [0, 0.0])
            acc[0] += j["remaining"]
            acc[1] += units_once(j, seen_s)
    shipments = [{"date": d, "impressions": n, "units": round(u)} for d, (n, u) in sorted(ship.items())]

    # Excepciones de la auditoría.
    PRINTED = {s.upper() for s in cfg["printed_statuses"]}
    status_behind = []
    for oid, o in order_by_id.items():
        r = req(o); p = produced.get(oid, 0)
        st = (o.get("production_status") or "").upper()
        if r and p / r >= 0.90 and st not in PRINTED and st != "CANCELLED":
            status_behind.append({"order_number": o.get("order_number"), "board": o.get("board"),
                                  "production_status": o.get("production_status"),
                                  "printed_pct": round(p / r * 100), "impressions": p})
    status_behind.sort(key=lambda x: -x["impressions"])

    cutoff = (now - timedelta(hours=24)).astimezone(timezone.utc).isoformat()
    machines_no_capture = [m["machine"] for m in ctx["active"]
                           if str(last_machine.get(m["machine"], "")) < cutoff]
    cut3 = (now - timedelta(days=3)).astimezone(timezone.utc).isoformat()
    machine_names = {m["machine"] for m in ctx["machines"]}
    no_movement = []
    for oid, o in order_by_id.items():
        if o.get("board") in machine_names and str(last_order.get(oid, "")) < cut3:
            no_movement.append({"order_number": o.get("order_number"), "board": o.get("board"),
                                "production_status": o.get("production_status")})

    return {
        "today": today.isoformat(), "week_start": w0.isoformat(),
        "unit_note": "1 impresión = 1 print; frente+espalda = 2. units = piezas (hits ÷ hits por pieza)",
        "this_week": {"produced": prod_week["hits"], "produced_units": prod_week["units"],
                      "pending": weeks[0]["demand"], "pending_units": round(week_units[0]),
                      "capacity_regular": this_reg, "capacity_overtime": this_ot,
                      "capacity": this_reg + this_ot, "demand": weeks[0]["demand"],
                      "delta": (this_reg + this_ot) - weeks[0]["demand"],
                      "pull_ahead": max(0, (this_reg + this_ot) - weeks[0]["demand"])},
        "next_week": {"capacity_regular": next_reg, "capacity_overtime": next_ot,
                      "capacity": next_reg + next_ot, "demand": weeks[1]["demand"],
                      "demand_units": round(week_units[1]),
                      "delta": (next_reg + next_ot) - weeks[1]["demand"]},
        "test_orders": {"open": test_open, "to_print": test_toprint,
                        "printed_in_process": test_printed, "pending": test_pend,
                        "pending_units": round(test_pend_u),
                        "pending_this_week": test_this, "pending_next_week": test_next,
                        "pending_this_week_units": round(test_this_u), "pending_next_week_units": round(test_next_u),
                        "produced": test_prod, "items": test_items},
        "shipments_by_day": shipments,
        "exceptions": {"status_behind": status_behind,
                       "machines_no_capture": machines_no_capture,
                       "no_movement": no_movement[:50], "no_movement_count": len(no_movement)},
        "overtime_loaded": bool(ctx["entries"]),
    }


# ── Auditoría de producción (excepciones; se corre cada hora) ───────────────
@router.get("/audit")
async def audit(request: Request):
    """Revisa lo que NO cuadra entre producción (registros) y MOS: (1) impresas
    sin avanzar status, (2) órdenes sin movimiento, (3) máquinas sin captura,
    (4) sobreimpresión. Solo lectura; umbrales en Reglas."""
    await require_auth(request)
    return await build_audit()


async def build_audit() -> dict:
    """Cuenta de la auditoría sin Request (la usa también el reporte por correo)."""
    ctx = await _context()
    cfg, now = ctx["cfg"], ctx["now"]
    pct = float(cfg.get("audit_printed_pct", 90)) / 100.0
    over_pct = float(cfg.get("audit_overprint_pct", 115)) / 100.0
    nm_days = int(cfg.get("audit_no_movement_days", 3))
    nc_hours = int(cfg.get("audit_no_capture_hours", 24))
    PRINTED = {s.upper() for s in cfg["printed_statuses"]}
    orders = {o["order_id"]: o for o in ctx["orders"]}
    machine_names = {m["machine"] for m in ctx["machines"]}

    oids = [oid for oid in orders if oid]
    produced, last_order = {}, {}
    for i in range(0, len(oids), 400):
        async for r in db.production_logs.aggregate([
                {"$match": {"order_id": {"$in": oids[i:i + 400]}}},
                {"$group": {"_id": "$order_id", "n": {"$sum": "$quantity_produced"},
                            "last": {"$max": "$created_at"}}}]):
            produced[r["_id"]] = r["n"]
            last_order[r["_id"]] = r["last"]
    last_machine = {}
    async for r in db.production_logs.aggregate([
            {"$group": {"_id": "$machine", "last": {"$max": "$created_at"}}}]):
        last_machine[r["_id"]] = r["last"]

    def req(o):
        pos = len([x for x in (o.get("print_positions") or []) if x]) or 1
        return int(o.get("quantity") or 0) * pos

    status_behind, overprint, no_movement = [], [], []
    cut_nm = (now - timedelta(days=nm_days)).astimezone(timezone.utc).isoformat()
    for oid, o in orders.items():
        r = req(o)
        p = produced.get(oid, 0)
        st = (o.get("production_status") or "").upper()
        row = {"order_number": o.get("order_number"), "client": o.get("client"),
               "board": o.get("board"), "production_status": o.get("production_status"),
               "produced": p, "required": r}
        if r and p / r >= pct and st not in PRINTED and st != "CANCELLED":
            status_behind.append({**row, "printed_pct": round(p / r * 100)})
        if r and p > r * over_pct and st != "CANCELLED":
            overprint.append({**row, "over_pct": round(p / r * 100)})
        if o.get("board") in machine_names and str(last_order.get(oid, "")) < cut_nm and st not in PRINTED:
            last = last_order.get(oid)
            days = round((now - datetime.fromisoformat(last).astimezone(TZ)).total_seconds() / 86400) if last else None
            no_movement.append({**row, "days": days, "last": last})
    status_behind.sort(key=lambda x: -x["produced"])
    overprint.sort(key=lambda x: -x["over_pct"])
    no_movement.sort(key=lambda x: (x["days"] is None, -(x["days"] or 0)))

    cut_nc = (now - timedelta(hours=nc_hours)).astimezone(timezone.utc).isoformat()
    machine_no_capture = [{"machine": m["machine"], "last": last_machine.get(m["machine"])}
                          for m in ctx["active"] if str(last_machine.get(m["machine"], "")) < cut_nc]

    return {
        "generated_at": now.isoformat(),
        "thresholds": {"printed_pct": cfg.get("audit_printed_pct", 90),
                       "no_movement_days": nm_days, "no_capture_hours": nc_hours,
                       "overprint_pct": cfg.get("audit_overprint_pct", 115)},
        "checks": {
            "status_behind": {"count": len(status_behind),
                              "impressions": sum(x["produced"] for x in status_behind),
                              "items": status_behind[:200]},
            "no_movement": {"count": len(no_movement), "items": no_movement[:200]},
            "machine_no_capture": {"count": len(machine_no_capture), "items": machine_no_capture},
            "overprint": {"count": len(overprint), "items": overprint[:200]},
        },
    }


# ── Ajustes manuales ───────────────────────────────────────────────────────
@router.get("/overrides")
async def list_overrides(request: Request):
    await require_auth(request)
    history = [o async for o in db.planner_overrides.find({"active": False}, {"_id": 0})
               .sort("removed_at", -1).limit(100)]
    return {"active": await _active_overrides(), "history": history}


def _validate_override(body: dict, machines: list) -> tuple:
    kind = body.get("kind")
    if kind not in OVERRIDE_KINDS:
        raise HTTPException(400, "Tipo de ajuste: assign, priority, force u hold")
    raw = body.get("params") or {}
    params = {}
    if kind == "assign":
        if raw.get("machine"):
            if raw["machine"] not in machines:
                raise HTTPException(400, "Esa máquina no existe")
            params["machine"] = raw["machine"]
        if raw.get("queue_pos") not in (None, ""):
            try:
                qp = int(raw["queue_pos"])
            except (TypeError, ValueError):
                raise HTTPException(400, "Lugar en la cola: número")
            if qp < 1:
                raise HTTPException(400, "Lugar en la cola: 1 o más")
            params["queue_pos"] = qp
        if raw.get("not_before"):
            nb = pe.parse_date(raw["not_before"])
            if not nb:
                raise HTTPException(400, "Fecha de inicio mínima inválida")
            params["not_before"] = nb.isoformat()
        if not params.get("machine") and not params.get("not_before"):
            raise HTTPException(400, "Indica la máquina o la fecha de inicio mínima")
    elif kind == "priority":
        if raw.get("level") not in PRIORITY_LEVELS:
            raise HTTPException(400, "Prioridad: TOP, UP o DOWN")
        params["level"] = raw["level"]
    elif kind == "hold":
        if raw.get("until"):
            until = pe.parse_date(raw["until"])
            if not until:
                raise HTTPException(400, "Fecha límite de retención inválida")
            params["until"] = until.isoformat()
    return kind, params


@router.post("/overrides")
async def add_override(request: Request):
    user = await require_admin(request)
    body = await request.json() or {}
    order = await db.orders.find_one({"order_id": body.get("order_id")},
                                     {"_id": 0, "order_id": 1, "order_number": 1})
    if not order:
        raise HTTPException(404, "La orden no existe")
    position = str(body.get("position") or "*").strip().upper()
    if position != "*" and position not in DESIGN_POSITIONS and not position.startswith("HIT "):
        raise HTTPException(400, "Posición inválida")
    kind, params = _validate_override(body, await get_machines())
    target = f"{order['order_id']}:{position}"
    now = datetime.now(timezone.utc).isoformat()
    # Un solo ajuste activo por (orden·posición, tipo): el nuevo reemplaza al
    # anterior, que queda en el historial.
    replaced = [o async for o in db.planner_overrides.find(
        {"target": target, "kind": kind, "active": True}, {"_id": 0})]
    if replaced:
        await db.planner_overrides.update_many(
            {"target": target, "kind": kind, "active": True},
            {"$set": {"active": False, "removed_at": now, "removed_by": user.get("email"),
                      "removed_reason": "reemplazado"}})
    doc = {"override_id": f"pov_{uuid.uuid4().hex[:10]}", "target": target,
           "order_id": order["order_id"], "order_number": str(order.get("order_number") or ""),
           "position": position, "kind": kind, "params": params,
           "reason": str(body.get("reason") or "").strip()[:300], "active": True,
           "created_at": now, "created_by": user.get("email"), "created_by_name": user.get("name")}
    await db.planner_overrides.insert_one(dict(doc))
    await log_activity(user, "planner_override_add", doc, replaced[0] if replaced else None)
    return {"override": doc, "replaced": len(replaced)}


@router.delete("/overrides/{override_id}")
async def remove_override(override_id: str, request: Request):
    user = await require_admin(request)
    before = await db.planner_overrides.find_one({"override_id": override_id, "active": True}, {"_id": 0})
    if not before:
        raise HTTPException(404, "Ese ajuste no existe o ya se quitó")
    await db.planner_overrides.update_one(
        {"override_id": override_id},
        {"$set": {"active": False, "removed_at": datetime.now(timezone.utc).isoformat(),
                  "removed_by": user.get("email"), "removed_reason": "deshecho"}})
    await log_activity(user, "planner_override_remove", {"override_id": override_id}, before)
    return {"ok": True}


# ── Autorizar movimientos ──────────────────────────────────────────────────
# El motor sigue en modo sombra: PROPONE. Aquí un administrador AUTORIZA
# movimientos concretos de la última corrida y MOS los aplica por el mismo
# camino que un movimiento manual del CRM (orders.move_order_core: candado QC,
# guardas, bitácora, automatizaciones, avisos). Cada aplicación queda en
# planner_applied con lo necesario para revertirla.
WEEKDAY_EN = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"]


async def _latest_run(fields=None):
    return await db.planner_runs.find_one({}, fields or {"_id": 0}, sort=[("created_at", -1)])


@router.post("/moves/apply")
async def apply_moves(request: Request):
    """Cuerpo: {run_id, order_ids: [...]}. Sólo movimientos de la ÚLTIMA
    corrida, y sólo si la orden sigue en el tablero de origen (si alguien ya la
    movió, no se pisa). Resultado por orden: applied | skipped | blocked."""
    from routers.orders import move_order_core   # import tardío: evita ciclo
    user = await require_admin(request)
    body = await request.json() or {}
    run = await _latest_run({"_id": 0, "run_id": 1, "moves": 1, "created_at": 1})
    if not run or run.get("run_id") != body.get("run_id"):
        raise HTTPException(409, "Hay una corrida más nueva: recalcula y vuelve a revisar los movimientos")
    wanted = set(body.get("order_ids") or [])
    if not wanted:
        raise HTTPException(400, "Indica qué órdenes aplicar")
    moves = {m["order_id"]: m for m in run.get("moves") or [] if m["order_id"] in wanted}
    results = []
    for oid in wanted:
        m = moves.get(oid)
        if not m:
            results.append({"order_id": oid, "result": "skipped", "reason": "No está en los movimientos propuestos"})
            continue
        order = await db.orders.find_one({"order_id": oid}, {"_id": 0, "board": 1, "order_number": 1,
                                                             "scheduled_day": 1, "queue_status": 1})
        if not order:
            results.append({"order_id": oid, "order_number": m["order_number"], "result": "skipped",
                            "reason": "La orden ya no existe"})
            continue
        if order.get("board") != m["from_board"]:
            results.append({"order_id": oid, "order_number": m["order_number"], "result": "skipped",
                            "reason": f"Ya no está en {m['from_board']} (ahora en {order.get('board')})"})
            continue
        # Día del arranque programado y en cola: el operador la activa al montarla.
        try:
            day = WEEKDAY_EN[datetime.fromisoformat(m["start"]).weekday()]
        except (KeyError, ValueError, TypeError):
            day = None
        extra = {"queue_status": "queued"}
        if day:
            extra["scheduled_day"] = day
        try:
            await move_order_core(user, oid, m["to_board"], extra_set=extra)
        except HTTPException as e:
            results.append({"order_id": oid, "order_number": m["order_number"], "result": "blocked",
                            "reason": str(e.detail)})
            continue
        doc = {"apply_id": f"pap_{uuid.uuid4().hex[:10]}", "run_id": run["run_id"], "order_id": oid,
               "order_number": m["order_number"], "client": m.get("client"),
               "from_board": m["from_board"], "to_board": m["to_board"], "start": m.get("start"),
               "positions": m.get("positions"),
               "previous": {"scheduled_day": order.get("scheduled_day"), "queue_status": order.get("queue_status")},
               "status": "applied", "applied_at": datetime.now(timezone.utc).isoformat(),
               "applied_by": user.get("email"), "applied_by_name": user.get("name")}
        await db.planner_applied.insert_one(dict(doc))
        results.append({"order_id": oid, "order_number": m["order_number"], "result": "applied",
                        "apply_id": doc["apply_id"], "to_board": m["to_board"]})
    await log_activity(user, "planner_moves_apply", {"run_id": run["run_id"], "results": results})
    return {"results": results,
            "applied": sum(1 for r in results if r["result"] == "applied")}


@router.get("/moves/applied")
async def applied_moves(request: Request, limit: int = 100):
    await require_auth(request)
    rows = [r async for r in db.planner_applied.find({}, {"_id": 0}).sort("applied_at", -1).limit(max(1, min(limit, 500)))]
    return {"rows": rows}


@router.post("/moves/applied/{apply_id}/revert")
async def revert_move(apply_id: str, request: Request):
    """Regresa la orden a su tablero de origen (con su día y cola de antes),
    sólo si sigue donde la dejó el planeador: si alguien ya la movió, no se pisa."""
    from routers.orders import move_order_core
    user = await require_admin(request)
    doc = await db.planner_applied.find_one({"apply_id": apply_id}, {"_id": 0})
    if not doc:
        raise HTTPException(404, "No existe")
    if doc.get("status") != "applied":
        raise HTTPException(409, "Ese movimiento ya se revirtió")
    order = await db.orders.find_one({"order_id": doc["order_id"]}, {"_id": 0, "board": 1})
    if not order or order.get("board") != doc["to_board"]:
        raise HTTPException(409, f"La orden ya no está en {doc['to_board']}: no se revierte para no pisar otro cambio")
    prev = doc.get("previous") or {}
    await move_order_core(user, doc["order_id"], doc["from_board"],
                          extra_set={"scheduled_day": prev.get("scheduled_day"), "queue_status": prev.get("queue_status")})
    await db.planner_applied.update_one(
        {"apply_id": apply_id},
        {"$set": {"status": "reverted", "reverted_at": datetime.now(timezone.utc).isoformat(),
                  "reverted_by": user.get("email")}})
    await log_activity(user, "planner_move_revert", {"apply_id": apply_id, "order_number": doc["order_number"]}, doc)
    return {"ok": True}
