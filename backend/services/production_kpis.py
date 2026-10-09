"""Indicadores de producción: UNA sola cuenta para el dashboard de Planeación y
para los reportes por correo (report_scheduler). Si un número sale aquí, sale
igual en pantalla y en el correo.

Mismas definiciones que los registros oficiales de 2026 ("2026 Billing Records",
hoja Notes), para que el correo cuadre con ellos:
  hits (prints, impresiones) = suma de quantity_produced de production_logs.
           Cada captura es una pasada en una ubicación (FRENTE / ESPALDA / MANGA):
           frente + espalda = 2 hits.
  units (piezas) = dentro de cada periodo y orden, se suma por ubicación y se
           toma la ubicación MÁS grande. Frente 5,000 + espalda 5,000 =
           5,000 units y 10,000 hits. Por eso las units de la semana NO son la
           suma de las units de cada día (una orden con frente el lunes y
           espalda el martes son 5,000 piezas en la semana).
  Se excluyen capturas de PRUEBA de máquina: orden cuyo número contiene
  TEST, UNDO, PROD_ o MACHINE_ (no confundir con el programa "Test Orders",
  que son órdenes reales y sí cuentan).
  Clientes: Goodie Two Sleeves, Spektrum y Miscellaneous (todo lo demás).

Día operativo: el turno de noche (TURNO 2) cruza la medianoche y su producción
capturada antes de las 07:00 pertenece al día en que EMPEZÓ el turno. Con la
semana regular de lunes a jueves esto no mueve los totales semanales (la
noche del jueves cae el viernes de madrugada, misma semana).
"""
from collections import defaultdict
from datetime import date, datetime, time, timedelta, timezone
from typing import Iterable, Optional
import zoneinfo

from deps import db, logger
from services import planner_engine as pe

TZ = zoneinfo.ZoneInfo("America/Tijuana")
NIGHT_SHIFT = "TURNO 2"
NIGHT_CUTOFF_HOUR = 7
EXCLUDED_ORDER_MARKERS = ("TEST", "UNDO", "PROD_", "MACHINE_")
CLIENT_GROUPS = (("Goodie Two Sleeves", ("GOODIE",)), ("Spektrum", ("SPEKTRUM",)))
MISC = "Miscellaneous"
SHIFT_LABELS = {"TURNO 1": {"en": "Day", "es": "Día"},
                "TURNO 2": {"en": "Night", "es": "Noche"},
                "": {"en": "No shift", "es": "Sin turno"}}


def op_date(dt_local: datetime, shift: str) -> date:
    """Día operativo de una captura (hora local)."""
    if shift == NIGHT_SHIFT and dt_local.hour < NIGHT_CUTOFF_HOUR:
        return dt_local.date() - timedelta(days=1)
    return dt_local.date()


def op_today(now_local: datetime) -> date:
    """Día operativo en curso: antes de las 07:00 sigue corriendo la noche de ayer."""
    if now_local.hour < NIGHT_CUTOFF_HOUR:
        return now_local.date() - timedelta(days=1)
    return now_local.date()


def is_machine_test(order_number) -> bool:
    up = str(order_number or "").upper()
    return any(m in up for m in EXCLUDED_ORDER_MARKERS)


def client_group(client) -> str:
    up = str(client or "").upper()
    for name, keys in CLIENT_GROUPS:
        if any(k in up for k in keys):
            return name
    return MISC


def measure(rows: Iterable[dict]) -> dict:
    """{hits, units} de un conjunto de capturas: units = por orden, la
    ubicación con más impresiones."""
    hits = 0
    per = defaultdict(lambda: defaultdict(int))
    for r in rows:
        hits += r["n"]
        per[r["order"]][r["pos"]] += r["n"]
    return {"hits": hits, "units": sum(max(p.values()) for p in per.values() if p)}


def _utc(d: date, hour: int = 0) -> str:
    return datetime.combine(d, time(hour), tzinfo=TZ).astimezone(timezone.utc).isoformat()


async def produced_window(d_from: date, d_to: date) -> dict:
    """Capturas de producción por día operativo entre d_from y d_to (inclusive),
    ya sin pruebas de máquina. {"rows": [{date, shift, machine, order, pos, client, group, n}],
    "excluded": n}. Se miden con measure()."""
    q = {"created_at": {"$gte": _utc(d_from), "$lt": _utc(d_to + timedelta(days=1), NIGHT_CUTOFF_HOUR)}}
    rows, excluded, no_client = [], 0, set()
    async for lg in db.production_logs.find(
            q, {"_id": 0, "created_at": 1, "shift": 1, "machine": 1, "order_id": 1, "order_number": 1,
                "design_type": 1, "client": 1, "quantity_produced": 1}).batch_size(500):
        try:
            dt = datetime.fromisoformat(str(lg["created_at"])).astimezone(TZ)
        except (KeyError, ValueError):
            continue
        shift = lg.get("shift") or ""
        d = op_date(dt, shift)
        if not (d_from <= d <= d_to):
            continue
        if is_machine_test(lg.get("order_number")):
            excluded += 1
            continue
        oid = lg.get("order_id") or "#" + str(lg.get("order_number"))
        if not lg.get("client"):
            no_client.add(oid)
        rows.append({"date": d.isoformat(), "shift": shift, "machine": lg.get("machine") or "",
                     "order": oid, "pos": str(lg.get("design_type") or "").strip().upper(),
                     "client": lg.get("client") or "", "n": int(lg.get("quantity_produced") or 0)})
    if no_client:   # capturas viejas sin cliente: se toma el de la orden
        ids = list(no_client)
        names = {}
        for i in range(0, len(ids), 400):
            async for o in db.orders.find({"order_id": {"$in": ids[i:i + 400]}}, {"_id": 0, "order_id": 1, "client": 1}):
                names[o["order_id"]] = o.get("client") or ""
        for r in rows:
            if not r["client"]:
                r["client"] = names.get(r["order"], "")
    for r in rows:
        r["group"] = client_group(r["client"])
    return {"rows": rows, "excluded": excluded}


async def test_order_ids(order_ids, cfg: dict) -> set:
    """De estas órdenes, cuáles son Test Orders (por branding, pe.is_test_branding)."""
    ids = [i for i in order_ids if i and not str(i).startswith("#")]
    out = set()
    for i in range(0, len(ids), 400):
        async for o in db.orders.find({"order_id": {"$in": ids[i:i + 400]}}, {"_id": 0, "order_id": 1, "branding": 1}):
            if pe.is_test_branding(o.get("branding"), cfg):
                out.add(o["order_id"])
    return out


def between(window: dict, d_from: date, d_to: date) -> list:
    a, b = d_from.isoformat(), d_to.isoformat()
    return [r for r in window["rows"] if a <= r["date"] <= b]


def sum_days(window: dict, d_from: date, d_to: date) -> dict:
    return measure(between(window, d_from, d_to))


def by(rows: list, key: str) -> dict:
    out = defaultdict(list)
    for r in rows:
        out[r[key]].append(r)
    return {k: measure(v) for k, v in out.items()}


def by_client(rows: list) -> list:
    m = by(rows, "group")
    return [{"client": name, **m.get(name, {"hits": 0, "units": 0})}
            for name in [g[0] for g in CLIENT_GROUPS] + [MISC]]


def _pct(n, goal):
    return round(n / goal * 100, 1) if goal else None


def _day_block(window: dict, d: date, goals: dict) -> dict:
    rows = between(window, d, d)
    tot = measure(rows)
    g = goals.get(d.isoformat()) or {}
    goal_shifts = g.get("shifts") or {}
    per_shift = by(rows, "shift")
    shifts = []
    for key in sorted(set(per_shift) | {k for k, v in goal_shifts.items() if v}):
        b = per_shift.get(key) or {"hits": 0, "units": 0}
        shifts.append({"shift": key, **b, "goal": goal_shifts.get(key) or None,
                       "pct": _pct(b["hits"], goal_shifts.get(key))})
    machines = sorted(({"machine": m, **b} for m, b in by(rows, "machine").items()), key=lambda x: -x["hits"])
    return {"date": d.isoformat(), **tot, "goal": g.get("day") or None, "pct": _pct(tot["hits"], g.get("day")),
            "shifts": shifts, "machines": machines, "clients": by_client(rows)}


async def build_executive(now: Optional[datetime] = None) -> dict:
    """Todo lo que lleva el Reporte Ejecutivo de Producción. Cada sección se
    calcula aparte: si una falla, va en `unavailable` y las demás salen."""
    from routers.production import _goals_for_days
    from routers.planner import build_dashboard, build_audit, _config

    now = (now or datetime.now(TZ)).astimezone(TZ)
    today = op_today(now)
    yesterday = today - timedelta(days=1)
    w0 = pe.week_start(today)
    out = {"generated_at": now.isoformat(), "today": None, "yesterday": None, "week": None,
           "next_week": None, "test_orders": None, "shipments": None, "exceptions": None,
           "op_today": today.isoformat(), "week_start": w0.isoformat(), "unavailable": []}

    try:
        first = min(w0, yesterday)
        window = await produced_window(first, today)
        days = [first + timedelta(days=k) for k in range((today - first).days + 1)]
        goals = await _goals_for_days([d.isoformat() for d in days])
        out["today"] = _day_block(window, today, goals)
        out["today"]["as_of"] = now.strftime("%H:%M")
        out["yesterday"] = _day_block(window, yesterday, goals)
        out["week_days"] = [{"date": d.isoformat(), **sum_days(window, d, d),
                             "goal": (goals.get(d.isoformat()) or {}).get("day") or None}
                            for d in days if d >= w0]
        out["excluded_test_captures"] = window["excluded"]
        week_rows = between(window, w0, today)
        week_prod = measure(week_rows)
        out["week_clients"] = by_client(week_rows)
        # Lo impreso de Test Orders (programa SPENCERS TEST: órdenes reales,
        # branding ~ test_branding_patterns), con la misma regla de units.
        test_ids = await test_order_ids({r["order"] for r in window["rows"]}, await _config())
        out["test_printed"] = {
            "yesterday": measure(r for r in between(window, yesterday, yesterday) if r["order"] in test_ids),
            "today": measure(r for r in between(window, today, today) if r["order"] in test_ids),
            "week": measure(r for r in week_rows if r["order"] in test_ids)}
    except Exception as e:
        logger.error(f"[kpis] producción por día falló: {e}")
        out["unavailable"].append("production")
        week_prod = None

    try:
        dash = await build_dashboard()
        tw, nw = dash["this_week"], dash["next_week"]
        out["week"] = {"produced_hits": week_prod["hits"] if week_prod else tw["produced"],
                       "produced_units": week_prod["units"] if week_prod else tw.get("produced_units"),
                       "pending_hits": tw["pending"], "pending_units": tw.get("pending_units"),
                       "capacity": tw["capacity"], "capacity_regular": tw["capacity_regular"],
                       "capacity_overtime": tw["capacity_overtime"], "delta": tw["delta"],
                       "pull_ahead": tw["pull_ahead"]}
        out["next_week"] = {"demand_hits": nw["demand"], "demand_units": nw.get("demand_units"),
                            "capacity": nw["capacity"], "capacity_regular": nw["capacity_regular"],
                            "capacity_overtime": nw["capacity_overtime"], "delta": nw["delta"]}
        out["overtime_loaded"] = dash["overtime_loaded"]
        out["test_orders"] = dash["test_orders"]
        out["shipments"] = [s for s in dash["shipments_by_day"]
                            if s["date"] < (now.date() + timedelta(days=7)).isoformat()]
    except Exception as e:
        logger.error(f"[kpis] dashboard falló: {e}")
        out["unavailable"].append("planning")

    try:
        a = await build_audit()
        c = a["checks"]
        out["exceptions"] = {"status_behind": c["status_behind"]["count"],
                             "status_behind_hits": c["status_behind"]["impressions"],
                             "no_movement": c["no_movement"]["count"],
                             "machine_no_capture": c["machine_no_capture"]["count"],
                             "overprint": c["overprint"]["count"],
                             "thresholds": a["thresholds"]}
    except Exception as e:
        logger.error(f"[kpis] auditoría falló: {e}")
        out["unavailable"].append("audit")
    return out
