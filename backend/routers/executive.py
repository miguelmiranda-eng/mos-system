"""Vista ejecutiva: dashboards de SOLO LECTURA para jefes (rol ceo y supersu).

Una orden vive en UNA etapa del proceso, deducida de lo que MOS ya sabe
(production_status, board y blank_status). La regla vive SOLO aquí: el
frontend no reclasifica, sólo pinta lo que este módulo devuelve.

  Etapa          Regla (en este orden de precedencia; la primera que aplica gana)
  ─────────────  ───────────────────────────────────────────────────────────────
  (fuera)        production_status ∈ LISTO PARA ENVIO / INVENTARIO / FULFILLMENT:
                 ya no es trabajo en proceso; se mide como LLEGADAS (ver abajo)
  empaque        production_status ∈ NECESITA EMPACAR / EN PROCESO DE EMPAQUE
  qc             production_status ∈ NECESITA QC / CORRECIÓN DE QC / RECHAZADO
                 POR QC, o tablero CONTROL DE CALIDAD
  produccion     production_status EN PRODUCCION, o tablero MAQUINA<n>
  blanks         blank_status que NO está en BLANKS_DONE (incluye vacío = nunca
                 se capturó), sin importar el tablero
  por_producir   lo demás: blanks ya contados/surtidos, esperando máquina

BLANKS_DONE usa los valores que SÍ existen en prod (medido 2026-10-13: CONTADO
98, SURTIDO 46, NECK CUT 4…), no la lista de deps.py ("CONTADO/PICKED" no lo
usa nadie). Si se agrega un estado de blanks nuevo, decidir aquí de qué lado va.

Universo: se ignoran papelera, canceladas, ejemplos y el respaldo de Monday,
y los tableros terminales (COMPLETOS, EDI, INVENTARIO, FINAL BILL): una orden
ahí con un status viejo es dato sucio, no trabajo pendiente.

"Listas para envío" NO es un acumulado (COMPLETOS/FINAL BILL guardan órdenes
que ya se fueron hace meses): es cuántas LLEGARON a listo en un periodo — hoy,
ayer, esta semana (lunes a hoy) o un rango. Se usa `production_status_at`, que
orders.py y las automatizaciones sellan SOLO cuando el estado cambia de verdad;
la fecha es el día calendario de la planta (America/Tijuana). Una orden que
llegó el lunes y se facturó el miércoles sigue siendo una llegada del lunes. Si
después alguien le cambia el estado, el sello se mueve (no hay foto diaria).

Endpoints (prefijo /api/executive):
  GET /pipeline  → etapas en proceso + llegadas a listo hoy/ayer/semana.
                   Caché compartido con el de órdenes (se invalida en cada
                   order_change, TTL 60 s).
  GET /listo     → llegadas a listo en un rango (date_from/date_to), por día,
                   con las órdenes. Máximo LISTO_MAX_DAYS días.
  GET /kpis      → lo mismo que el Reporte Ejecutivo por correo
                   (production_kpis.build_executive), caché de 60 s.
"""
import asyncio
import time
from collections import defaultdict
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, HTTPException, Request, Response

from deps import db, require_auth, user_roles, logger
from routers.orders import get_orders_cached, _cache_and_respond, _orders_cache_locks
from services.production_kpis import TZ, op_today
from services import planner_engine as pe

router = APIRouter(prefix="/api/executive")

EXEC_ROLES = {"ceo", "supersu"}

IGNORED_BOARDS = ["PAPELERA DE RECICLAJE", "CANCELLED", "EJEMPLOS", "RESPALDO MONDAY"]
TERMINAL_BOARDS = {"COMPLETOS", "EDI", "INVENTARIO", "FINAL BILL"}

LISTO = {"LISTO PARA ENVIO", "LISTO PARA INVENTARIO", "LISTO PARA FULFILLMENT"}
EMPAQUE = {"NECESITA EMPACAR", "EN PROCESO DE EMPAQUE"}
QC = {"NECESITA QC", "CORRECIÓN DE QC", "CORRECCIÓN DE QC", "RECHAZADO POR QC"}
BLANKS_DONE = {"CONTADO", "CONTADO/PICKED", "SURTIDO", "NECK CUT", "CANCELLED"}

STAGES = ["blanks", "por_producir", "produccion", "qc", "empaque"]
AGING_BUCKETS = [(2, "0-2"), (7, "3-7"), (14, "8-14"), (None, "15+")]
LISTO_MAX_DAYS = 93
MAX_ROWS = 400

PROJECTION = {"_id": 0, "order_id": 1, "order_number": 1, "client": 1, "branding": 1,
              "customer_po": 1, "quantity": 1, "board": 1, "production_status": 1,
              "production_status_at": 1, "blank_status": 1, "cancel_date": 1,
              "created_at": 1, "updated_at": 1, "priority": 1}


async def require_exec(request: Request) -> dict:
    user = await require_auth(request)
    if not (user_roles(user) & EXEC_ROLES):
        raise HTTPException(status_code=403, detail="Vista ejecutiva: sólo rol ceo o supersu")
    return user


def _up(v) -> str:
    return str(v or "").strip().upper()


def _qty(v) -> int:
    try:
        return max(0, int(float(str(v).replace(",", "").strip())))
    except (TypeError, ValueError):
        return 0


def _local_dt(v):
    """ISO (UTC) o datetime → datetime con zona de la planta."""
    if not v:
        return None
    try:
        dt = v if isinstance(v, datetime) else datetime.fromisoformat(str(v).replace("Z", "+00:00"))
    except ValueError:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(TZ)


def stage_of(o: dict):
    status, board = _up(o.get("production_status")), _up(o.get("board"))
    if status == "CANCELLED":
        return None
    if status in LISTO or board in TERMINAL_BOARDS:
        return None
    if status in EMPAQUE:
        return "empaque"
    if status in QC or board == "CONTROL DE CALIDAD":
        return "qc"
    if status == "EN PRODUCCION" or board.startswith("MAQUINA"):
        return "produccion"
    if _up(o.get("blank_status")) not in BLANKS_DONE:
        return "blanks"
    return "por_producir"


def _aging_label(days: int) -> str:
    for limit, label in AGING_BUCKETS:
        if limit is None or days <= limit:
            return label
    return AGING_BUCKETS[-1][1]


def _row(o: dict, stage: str, now: datetime, today) -> dict:
    # Antigüedad: en blanks, desde que existe la orden (nadie sella cuándo
    # cambió blank_status); en las demás, desde que entró a su status actual.
    since_raw = o.get("created_at") if stage == "blanks" else (o.get("production_status_at") or o.get("updated_at"))
    since = _local_dt(since_raw)
    days = max(0, (now - since).days) if since else None
    cd = pe.parse_date(o.get("cancel_date"))
    return {
        "order_id": o.get("order_id"), "order_number": o.get("order_number"),
        "client": o.get("client") or "—", "branding": o.get("branding"),
        "customer_po": o.get("customer_po"), "quantity": _qty(o.get("quantity")),
        "board": o.get("board"), "production_status": o.get("production_status"),
        "blank_status": o.get("blank_status"), "priority": o.get("priority"),
        "cancel_date": cd.isoformat() if cd else None,
        "late": bool(cd and cd < today), "days_to_cancel": (cd - today).days if cd else None,
        "since": since.isoformat() if since else None, "days": days,
    }


def _summarize(key: str, rows: list) -> dict:
    by_status = defaultdict(lambda: [0, 0])
    by_client = defaultdict(lambda: [0, 0])
    aging = {label: 0 for _, label in AGING_BUCKETS}
    late = late_pcs = due7 = 0
    for r in rows:
        sub = (r["blank_status"] or "SIN CAPTURAR") if key == "blanks" else (r["production_status"] or "SIN STATUS")
        by_status[_up(sub)][0] += 1
        by_status[_up(sub)][1] += r["quantity"]
        by_client[r["client"]][0] += 1
        by_client[r["client"]][1] += r["quantity"]
        if r["days"] is not None:
            aging[_aging_label(r["days"])] += 1
        if r["late"]:
            late += 1
            late_pcs += r["quantity"]
        elif r["days_to_cancel"] is not None and r["days_to_cancel"] <= 7:
            due7 += 1
    rows.sort(key=lambda r: (not r["late"], r["cancel_date"] or "9999", -(r["days"] or 0)))
    pack = lambda d, name: sorted(({name: k, "count": v[0], "pieces": v[1]} for k, v in d.items()),
                                  key=lambda x: -x["pieces"])
    return {"key": key, "count": len(rows), "pieces": sum(r["quantity"] for r in rows),
            "late": late, "late_pieces": late_pcs, "due_7d": due7, "aging": aging,
            "by_status": pack(by_status, "status"), "by_client": pack(by_client, "client")[:10],
            "orders": rows[:MAX_ROWS], "truncated": len(rows) > MAX_ROWS}


async def build_pipeline(now: datetime = None) -> dict:
    now = (now or datetime.now(TZ)).astimezone(TZ)
    today = op_today(now)
    buckets = {k: [] for k in STAGES}
    async for o in db.orders.find({"board": {"$nin": IGNORED_BOARDS}}, PROJECTION):
        st = stage_of(o)
        if st:
            buckets[st].append(_row(o, st, now, today))

    stages = [_summarize(k, buckets[k]) for k in STAGES]
    cal_today = now.date()
    w0 = pe.week_start(cal_today)
    yday = cal_today - timedelta(days=1)
    arr = await listo_arrivals(min(w0, yday), cal_today, now)

    def total(d_from, d_to):
        ds = [d for d in arr["days"] if d_from.isoformat() <= d["date"] <= d_to.isoformat()]
        return {"count": sum(d["count"] for d in ds), "pieces": sum(d["pieces"] for d in ds)}

    return {
        "generated_at": now.isoformat(), "today": today.isoformat(),
        "stages": stages,
        "listo": {"today": total(cal_today, cal_today), "yesterday": total(yday, yday),
                  "week": total(w0, cal_today), "week_start": w0.isoformat()},
    }


def _day_start_utc(d) -> str:
    return datetime.combine(d, datetime.min.time(), tzinfo=TZ).astimezone(timezone.utc).isoformat()


async def listo_arrivals(d_from, d_to, now: datetime = None) -> dict:
    """Órdenes que LLEGARON a un status listo entre d_from y d_to (días de la
    planta, inclusive). Incluye FINAL BILL/COMPLETOS: lo que cuenta es el día
    de llegada, no dónde está hoy."""
    now = (now or datetime.now(TZ)).astimezone(TZ)
    today = op_today(now)
    n_days = (d_to - d_from).days + 1
    days = {(d_from + timedelta(days=i)).isoformat(): {"count": 0, "pieces": 0, "by_status": defaultdict(int)}
            for i in range(n_days)}
    rows = []
    async for o in db.orders.find(
            {"production_status": {"$in": sorted(LISTO)},
             "production_status_at": {"$gte": _day_start_utc(d_from), "$lt": _day_start_utc(d_to + timedelta(days=1))},
             "board": {"$nin": IGNORED_BOARDS}}, PROJECTION):
        at = _local_dt(o.get("production_status_at"))
        d = at.date().isoformat() if at else None
        if d not in days:
            continue
        q = _qty(o.get("quantity"))
        days[d]["count"] += 1
        days[d]["pieces"] += q
        days[d]["by_status"][_up(o.get("production_status"))] += q
        rows.append({**_row(o, "listo", now, today), "arrived_on": d, "arrived_at": at.strftime("%H:%M")})
    rows.sort(key=lambda r: (r["arrived_on"], r["arrived_at"]), reverse=True)
    by_status, by_client = defaultdict(lambda: [0, 0]), defaultdict(lambda: [0, 0])
    for r in rows:
        for bucket, k in ((by_status, _up(r["production_status"])), (by_client, r["client"])):
            bucket[k][0] += 1
            bucket[k][1] += r["quantity"]
    pack = lambda d, name: sorted(({name: k, "count": v[0], "pieces": v[1]} for k, v in d.items()),
                                  key=lambda x: -x["pieces"])
    return {
        "date_from": d_from.isoformat(), "date_to": d_to.isoformat(),
        "count": len(rows), "pieces": sum(r["quantity"] for r in rows),
        "days": [{"date": k, "count": v["count"], "pieces": v["pieces"], "by_status": dict(v["by_status"])}
                 for k, v in sorted(days.items())],
        "by_status": pack(by_status, "status"), "by_client": pack(by_client, "client")[:10],
        "orders": rows[:MAX_ROWS * 2], "truncated": len(rows) > MAX_ROWS * 2,
    }


@router.get("/listo")
async def listo(request: Request, date_from: str = None, date_to: str = None):
    await require_exec(request)
    today = datetime.now(TZ).date()
    d_from = pe.parse_date(date_from) or today
    d_to = pe.parse_date(date_to) or d_from
    if d_from > d_to:
        d_from, d_to = d_to, d_from
    d_to = min(d_to, today)
    d_from = min(d_from, d_to)
    if (d_to - d_from).days + 1 > LISTO_MAX_DAYS:
        raise HTTPException(status_code=400, detail=f"Rango máximo: {LISTO_MAX_DAYS} días")
    return await listo_arrivals(d_from, d_to)


@router.get("/pipeline")
async def pipeline(request: Request):
    await require_exec(request)
    # Misma caché que board-counts: las llaves que no son ("orders", …) se
    # tiran en CADA order_change, y el TTL de 60 s mueve el corte de día.
    key = ("executive_pipeline",)
    cached = get_orders_cached(key)
    if cached is not None:
        return Response(content=cached, media_type="application/json")
    lock = _orders_cache_locks.setdefault(key, asyncio.Lock())
    async with lock:
        cached = get_orders_cached(key)
        if cached is not None:
            return Response(content=cached, media_type="application/json")
        return _cache_and_respond(key, await build_pipeline())


_kpis_cache = {"data": None, "ts": 0.0}
_kpis_lock = asyncio.Lock()
_KPIS_TTL = 60


@router.get("/kpis")
async def kpis(request: Request):
    """Producción y programación: la MISMA cuenta que el Reporte Ejecutivo por
    correo, para que pantalla y correo nunca difieran. Es pesada (planeador +
    auditoría), por eso un caché corto propio."""
    await require_exec(request)
    if _kpis_cache["data"] and time.time() - _kpis_cache["ts"] < _KPIS_TTL:
        return _kpis_cache["data"]
    async with _kpis_lock:
        if _kpis_cache["data"] and time.time() - _kpis_cache["ts"] < _KPIS_TTL:
            return _kpis_cache["data"]
        from services import production_kpis
        try:
            data = await production_kpis.build_executive()
        except Exception as e:
            logger.error(f"[executive] kpis falló: {e}")
            raise HTTPException(status_code=500, detail="No se pudieron calcular los indicadores")
        _kpis_cache.update(data=data, ts=time.time())
        return data
