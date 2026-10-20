"""Piezas compartidas de los MÓDULOS que reemplazan tableros (Cuadros, Blanks…).

En el modelo de módulos la orden no se mueve de tablero: cada módulo trabaja
su COMPONENTE (cuadros, blank contado, label…) y su cola sale de Planeación.

  simulate(relax)   corre el motor de Planeación SIN guardar nada contando
                    como cumplido el requisito `relax` ("cuadros", "contado"…):
                    sale cuándo y en qué máquina ARRANCARÍA cada orden que hoy
                    espera ese componente (el motor real no las programa).
  group_by_order()  por orden: arranque más temprano, máquina y qué MÁS falta.
  split_window()    Programadas (arrancarían dentro de N días) / Pendientes.
  components()      mini tabla de componentes de la tarjeta (sólo lectura).
  printavo_url()    work order de Printavo (Job Title A/B).
"""
import time
from datetime import datetime, timedelta, timezone

from deps import db
from services import planner_engine as pe

SIM_TTL_S = 45            # varias pantallas o palomeos seguidos reutilizan la misma
_cache: dict = {}         # relax -> {"at": monotonic, "data": {...}}
_live: dict = {}          # regla vigente de Planeación vista en la última simulación


def invalidate(relax: str = None) -> None:
    if relax:
        _cache.pop(relax, None)
    else:
        _cache.clear()


async def simulate(relax: str) -> dict:
    """Misma simulación del programa (ajustes manuales, candados, filas,
    calendario); lo único distinto es que el requisito `relax` cuenta como
    listo. Devuelve los trabajos (orden × posición) que esperaban ese
    requisito, con su arranque estimado. 2-5 s de lecturas: caché corta."""
    from routers.planner import _context, _active_overrides, _resolve_overrides
    hit = _cache.get(relax)
    if hit and time.monotonic() - hit["at"] < SIM_TTL_S:
        return hit["data"]
    ctx = await _context()
    need = {}                     # job_id -> qué más le falta (aparte de `relax`)
    for j in ctx["jobs"]:
        ready = j.get("ready") or {}
        if ready.get(relax, True):
            continue
        need[j["job_id"]] = sorted(k for k, v in ready.items() if not v and k != relax)
        j["ready"] = {**ready, relax: True}
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
            continue                  # retenidas y Test Orders: no son trabajo del módulo
        s = sched_by.get(j["job_id"]) or {}
        jobs.append({"order_id": j["order_id"], "position": j["position"],
                     "start": s.get("start"), "machine": (s.get("machines") or [None])[0],
                     "target_date": j.get("target_date"), "cancel_date": j.get("cancel_date"),
                     "missing": need[j["job_id"]]})
    data = {"at": datetime.now(timezone.utc).isoformat(), "now": ctx["now"], "cfg": ctx["cfg"], "jobs": jobs}
    _live["blank_ok"] = blank_ok_from(ctx["cfg"])     # la regla vigente, para components()
    _cache[relax] = {"at": time.monotonic(), "data": data}
    return data


def group_by_order(sim: dict) -> dict:
    """{order_id: {start, machine, missing:set, target_date, cancel_date}} con
    el arranque más temprano de sus posiciones."""
    out = {}
    for j in sim["jobs"]:
        b = out.setdefault(j["order_id"], {"start": None, "machine": None, "missing": set(),
                                           "target_date": j["target_date"], "cancel_date": j["cancel_date"]})
        b["missing"] |= set(j["missing"])
        if j["start"] and (not b["start"] or j["start"] < b["start"]):
            b["start"], b["machine"] = j["start"], j["machine"]
    return out


def split_window(sim: dict, by_order: dict, orders: dict, days: float, card, limit: int = 500):
    """(programadas, pendientes). Programada = el motor la arrancaría dentro de
    los próximos `days` días (si tiene hora es porque va a correr). Pendientes:
    lo demás, sin zombis (cancel vencido > fill_max_overdue_days), primero lo
    que sólo espera este componente (por arranque) y luego por fecha objetivo.
    `card(order, extra)` arma la tarjeta del módulo."""
    cutoff = sim["now"] + timedelta(days=days)
    max_od = int(sim["cfg"].get("fill_max_overdue_days") or 0)
    oldest = (sim["now"].date() - timedelta(days=max_od)).isoformat() if max_od > 0 else ""
    prog, pend = [], []
    for oid, b in by_order.items():
        o = orders.get(oid)
        if not o:
            continue
        extra = {"machine": b["machine"], "start": b["start"], "target_date": b["target_date"],
                 "missing": sorted(b["missing"])}
        if b["start"] and datetime.fromisoformat(b["start"]) <= cutoff:
            prog.append(card(o, extra))
        elif not (oldest and (b["cancel_date"] or "9999-12-31") < oldest):
            pend.append(card(o, extra))
    prog.sort(key=lambda c: c["start"])
    pend.sort(key=lambda c: (c["start"] is None or bool(c["missing"]), c["start"] or "", c["target_date"] or "9999"))
    return prog, pend[:limit]


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
    label_val = prod if prod.upper() in LABEL_OK | LABEL_STEPS else ""
    label_state = _state(label_val, LABEL_OK)
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
