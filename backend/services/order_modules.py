"""Piezas compartidas de los MÓDULOS que reemplazan tableros (Cuadros, Blanks…).

En el modelo de módulos la orden NO se mueve de tablero: se queda en
SCHEDULING (el maestro) y cada módulo actualiza su COMPONENTE (blank contado,
cuadros, label…). La prioridad sale del PLAN de Planeación.

  simulate()        corre el motor de Planeación SIN guardar nada contando como
                    listos los componentes de PREPARACIÓN (PREP_RELAX: blank,
                    cuadros y label; el ejemplo NO, depende del cliente). Es
                    "el plan": cuándo y en qué máquina arrancaría cada orden si
                    la preparación estuviera hecha. UNA sola simulación para
                    todos los módulos, así todos priorizan igual.
  group_by_order()  por orden, sólo las que esperan el componente del módulo:
                    arranque más temprano, máquina y qué MÁS le falta.
  split_plan()      Pendientes = las que el plan programa, por arranque;
                    Adelantar  = el resto (sin lugar en el plan: les falta el
                    ejemplo, están retenidas por fecha, fuera de horizonte…).
  components()      mini tabla de componentes de la tarjeta (sólo lectura).
  printavo_url()    work order de Printavo (Job Title A/B).

Las órdenes del tablero de ENTRADA (DATA ENTRY) no aparecen en los módulos
hasta que data entry las manda a SCHEDULING.
"""
import time
from datetime import datetime, timezone

from deps import db, INTAKE_BOARD
from services import planner_engine as pe

SIM_TTL_S = 45            # varias pantallas o palomeos seguidos reutilizan la misma
PREP_RELAX = ("contado", "cuadros", "label")
_cache: dict = {}         # {"at": monotonic, "data": {...}}
_live: dict = {}          # regla vigente de Planeación vista en la última simulación


def invalidate(*_args) -> None:
    _cache.clear()


async def simulate() -> dict:
    """Misma simulación del programa (ajustes manuales, candados, filas,
    calendario); lo único distinto es que blank, cuadros y label cuentan como
    listos. Devuelve TODOS los trabajos (orden × posición) de la demanda con
    su estado real (`ready`) y su arranque en el plan. 2-5 s: caché corta."""
    from routers.planner import _context, _active_overrides, _resolve_overrides
    hit = _cache.get("plan")
    if hit and time.monotonic() - hit["at"] < SIM_TTL_S:
        return hit["data"]
    ctx = await _context()
    real = {}
    for j in ctx["jobs"]:
        ready = dict(j.get("ready") or {})
        real[j["job_id"]] = ready
        j["ready"] = {**ready, **{k: True for k in PREP_RELAX if k in ready}}
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
        o = ov.get(j["job_id"], {})
        if "hold" in o or pe.is_manual_test(j, o, ctx["cfg"]):
            continue                  # retenidas y Test Orders: no son trabajo de los módulos
        if (j.get("board") or "") == INTAKE_BOARD:
            continue                  # DATA ENTRY: aún no la mandan a SCHEDULING
        s = sched_by.get(j["job_id"]) or {}
        jobs.append({"order_id": j["order_id"], "position": j["position"], "board": j.get("board"),
                     "start": s.get("start"), "machine": (s.get("machines") or [None])[0],
                     "target_date": j.get("target_date"), "cancel_date": j.get("cancel_date"),
                     "ready": real[j["job_id"]]})
    data = {"at": datetime.now(timezone.utc).isoformat(), "now": ctx["now"], "cfg": ctx["cfg"], "jobs": jobs}
    _live["blank_ok"] = blank_ok_from(ctx["cfg"])     # la regla vigente, para components()
    _cache["plan"] = {"at": time.monotonic(), "data": data}
    return data


def group_by_order(sim: dict, component: str, only: set = None) -> dict:
    """{order_id: {start, machine, missing:set, target_date, cancel_date}} sólo
    de las órdenes con alguna posición esperando `component` (o, si viene
    `only`, de esas órdenes: el módulo decide con su propia regla); `missing`
    = lo que además le falta (real, no lo supuesto por la simulación)."""
    out = {}
    pending = set(only) if only is not None else         {j["order_id"] for j in sim["jobs"] if not (j.get("ready") or {}).get(component, True)}
    for j in sim["jobs"]:
        if j["order_id"] not in pending:
            continue
        b = out.setdefault(j["order_id"], {"start": None, "machine": None, "missing": set(),
                                           "target_date": j["target_date"], "cancel_date": j["cancel_date"]})
        b["missing"] |= {k for k, v in (j.get("ready") or {}).items() if not v and k != component}
        if j["start"] and (not b["start"] or j["start"] < b["start"]):
            b["start"], b["machine"] = j["start"], j["machine"]
    return out


DEFAULT_WINDOW_DAYS = 3


def window_days(days) -> float:
    try:
        return max(0.5, min(float(days or DEFAULT_WINDOW_DAYS), 30.0))
    except (TypeError, ValueError):
        return DEFAULT_WINDOW_DAYS


def split_window(sim: dict, plan: list, days) -> tuple:
    """(programados, resto) de una lista del plan: PROGRAMADOS = el plan las
    arranca dentro de los próximos `days` días (pestaña Programados de cada
    módulo); el resto sigue en Pendientes."""
    from datetime import timedelta
    cutoff = sim["now"] + timedelta(days=window_days(days))
    prog = [c for c in plan if c.get("start") and datetime.fromisoformat(c["start"]) <= cutoff]
    ids = {c["order_id"] for c in prog}
    return prog, [c for c in plan if c["order_id"] not in ids]


PRINTING_STATUSES = {"EN PRODUCCION"}


def in_production(o: dict) -> str:
    """Máquina donde la orden YA está (tablero MAQUINA<n>) o "EN PRODUCCION"
    si el estatus lo dice; "" si todavía no se imprime."""
    board = str(o.get("board") or "").upper()
    if board.startswith("MAQUINA"):
        return board
    if str(o.get("production_status") or "").strip().upper() in PRINTING_STATUSES:
        return "EN PRODUCCION"
    return ""


def split_plan(sim: dict, by_order: dict, orders: dict, card, limit: int = 500):
    """(pendientes, adelantar, alertas).
      Alertas    la orden YA está en máquina / EN PRODUCCION y aun así le falta
                 el componente del módulo: no es trabajo normal, es algo que
                 revisar (se imprimió sin blank contado, sin cuadros…).
      Pendientes el plan les da arranque, en ese orden (lo que la planta va a
                 necesitar primero).
      Adelantar  sin lugar en el plan, por fecha objetivo; las de cancel muy
                 vencido (> fill_max_overdue_days) al final, marcadas `stale`.
    `missing` (qué más falta) no cuenta el label si el estatus ya pasó de LABEL
    LISTO (la regla del planner sólo acepta LABEL LISTO). `card(order, extra)`
    arma la tarjeta."""
    from datetime import timedelta
    max_od = int(sim["cfg"].get("fill_max_overdue_days") or 0)
    oldest = (sim["now"].date() - timedelta(days=max_od)).isoformat() if max_od > 0 else ""
    pend, adv, alerts = [], [], []
    for oid, b in by_order.items():
        o = orders.get(oid)
        if not o:
            continue
        missing = set(b["missing"])
        if str(o.get("production_status") or "").strip().upper() in LABEL_OK:
            missing.discard("label")
        printing_on = in_production(o)
        stale = bool(oldest and (b["cancel_date"] or "9999-12-31") < oldest)
        extra = {"machine": b["machine"], "start": b["start"], "target_date": b["target_date"],
                 "missing": [] if printing_on else sorted(missing), "stale": stale,
                 "alert": bool(printing_on), "printing_on": printing_on}
        (alerts if printing_on else pend if b["start"] else adv).append(card(o, extra))
    alerts.sort(key=lambda c: (c["start"] or "9999", c["target_date"] or "9999"))
    pend.sort(key=lambda c: c["start"])
    adv.sort(key=lambda c: (c["stale"], c["target_date"] or "9999"))
    return pend[:limit], adv[:limit], alerts


# ── Componentes (mini tabla de la tarjeta) ──────────────────────────────────
# Sólo LECTURA de los campos de siempre del CRM; "ok" = ya no detiene la
# impresión. BLANK_OK sale de la regla de Planeación (ready_blank_statuses).
BLANK_OK = {s.upper() for s in pe.DEFAULT_CONFIG["ready_blank_statuses"]}
TRIM_OK = {"COMPLETE TRIM", "N/A"}
ART_OK = {"SEPS DONE", "REORDER", "N/A"}
# Neck label listo = LABEL LISTO o cualquier estatus posterior del flujo.
LABEL_OK = {"LABEL LISTO", "EN PRODUCCION", "NECESITA EMPACAR", "EN PROCESO DE EMPAQUE", "NECESITA QC",
            "CORRECIÓN DE QC", "LISTO PARA FULFILLMENT", "LISTO PARA ENVIO", "LISTO PARA INVENTARIO"}
LABEL_STEPS = {"NECESITA LABEL", "PROCESO DE NECK LABEL", "PROCESO DE LABEL"}
COMPONENT_FIELDS = {"blank_status": 1, "trim_status": 1, "artwork_status": 1, "art_sep_status": 1,
                    "art_neck_status": 1, "production_status": 1, "screens": 1, "screens_positions": 1,
                    "job_title_a": 1, "job_title_b": 1}


def _state(value, ok_set) -> str:
    v = str(value or "").strip().upper()
    if not v:
        return "empty"
    return "ok" if v in ok_set else "pending"


def components(o: dict, include_screens: bool = False, blank_ok: set = None) -> list:
    """blank_ok: estatus que cuentan como blank listo; por defecto los de la
    regla de Planeación (planner_config.ready_blank_statuses, una sola lista)."""
    art = str(o.get("artwork_status") or "").strip()
    sep = o.get("art_sep_status") is True
    art_state = "ok" if (sep or art.upper() in ART_OK) else _state(art, ART_OK)
    prod = str(o.get("production_status") or "").strip()
    # El neck label se LEE del Production Status, pero sólo se muestra lo que
    # dice del label: en un paso de label, ese paso; ya pasado (NECESITA
    # EMPACAR, EN PROCESO DE EMPAQUE…), "LABEL LISTO ✓". El estatus completo va
    # en su propio recuadro (prod), si no se leía "neck label: necesita empacar".
    pu = prod.upper()
    label_val = prod if pu in LABEL_STEPS or pu == "LABEL LISTO" else ("LABEL LISTO ✓" if pu in LABEL_OK else "")
    label_state = "ok" if pu in LABEL_OK else _state(label_val, LABEL_OK)
    if o.get("art_neck_status") is True and label_state != "ok":
        label_val = (label_val + " · " if label_val else "") + "arte neck ✓"
    out = [
        {"key": "blanks", "value": o.get("blank_status") or "", "state": _state(o.get("blank_status"), blank_ok or _live.get("blank_ok") or BLANK_OK)},
        {"key": "trim", "value": o.get("trim_status") or "", "state": _state(o.get("trim_status"), TRIM_OK)},
        {"key": "art", "value": " · ".join(x for x in (art, "SEP ✓" if sep else "") if x), "state": art_state},
        {"key": "neck", "value": label_val, "state": label_state},
    ]
    if include_screens:
        sp = o.get("screens_positions") or {}
        done = o.get("screens") is True
        val = "✓" if done else (" · ".join(sorted(sp)) + " ✓" if sp else "")
        out.append({"key": "screens", "value": val, "state": "ok" if done else ("pending" if sp else "empty")})
    out.append({"key": "prod", "value": prod, "state": "info" if prod else "empty"})
    return out


def blank_ok_from(cfg: dict) -> set:
    """La ÚNICA lista de "blank listo": la regla de Planeación (editable en
    Planeación → Reglas). Módulos y componentes la leen de aquí."""
    return {str(s).strip().upper() for s in (cfg.get("ready_blank_statuses") or [])} or BLANK_OK


def printavo_url(o: dict) -> str:
    """Work order de Printavo: el enlace capturado en Job Title A (o B)."""
    for f in ("job_title_a", "job_title_b"):
        v = o.get(f)
        url = (v.get("url") if isinstance(v, dict) else v) or ""
        if str(url).startswith("http") and "printavo" in str(url).lower():
            return str(url)
    return ""
