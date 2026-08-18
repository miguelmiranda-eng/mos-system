"""Herramientas de planeación: pronóstico de consumo de blocker.

Calcula, sobre las órdenes que aún no pasan por impresión (tableros previos a
producción), cuántos hits faltan y cuánto Velocity blocker grey requieren,
comparado contra el stock vivo del almacén de mantenimiento (MaintOps/Supabase).

Regla de negocio (usuario, ago 2026): la prenda con algodón alto NO lleva
blocker — 100% algodón, 90/10 y 80/20 (umbral: >= 70% algodón). El blocker
aplica solo a mezclas con poliéster significativo (60/40, 58/42, 52/48, 50/50,
poliéster puro...) que además sean oscuras o lleven diseños de 5+ colores.
La tela de cada orden se resuelve vía pick tickets del WMS
(orden → estilo → fabric_content del inventario).
"""
import re
from datetime import datetime, timezone, timedelta
from fastapi import APIRouter, Request
import httpx
import os

from deps import db, require_auth, logger

router = APIRouter(prefix="/api")

# Factor recalibrado con la regla de algodón (ago 2026): 125 gal consumidos en
# jul-ago repartidos entre ~211,500 hits con blocker (prenda de mezcla oscura +
# 15% de la clara de mezcla). El frontend lo puede sobreescribir por query param.
DEFAULT_ML_PER_HIT = 2.24
# Proporción de hits de prenda clara DE MEZCLA que llevan blocker (5+ colores).
DEFAULT_LIGHT_FACTOR = 0.15
# Posiciones de impresión promedio cuando la orden no trae print_positions.
DEFAULT_POSITIONS_FALLBACK = 1.6
# A partir de este % de algodón la prenda NO lleva blocker (100, 90/10, 80/20).
COTTON_NO_BLOCKER_PCT = 70
# Participación de prenda sin-blocker medida en la ventana jul-ago 2026, usada
# como descuento cuando una orden pendiente aún no tiene ticket (tela desconocida).
DARK_COTTON_SHARE = 0.67
LIGHT_COTTON_SHARE = 0.49

ML_PER_BUCKET = 5 * 3785.41  # cubeta de 5 galones

# Tableros donde la orden todavía no se imprime (definidos por el usuario
# 2026-08-07): scheduling, blanks, screens y neck. "SCHEDULING" se incluye por
# si el tablero se renombra de vuelta; hoy el nombre vivo es READY TO SCHEDULED.
PENDING_BOARDS = ["SCHEDULING", "READY TO SCHEDULED", "BLANKS", "SCREENS", "NECK"]

# Misma clasificación de prenda oscura usada en el reporte de consumo.
DARK_COLORS = {
    "BLACK", "BLACK ACIDWASH", "BLACK - WHITE", "BLACK WASH",
    "BLACK - RED - WHITE", "CHARCOAL", "WASHED CHARCOAL", "MAROON", "NAVY",
    "GARNET MILL DYE", "FOREST GREEN MI", "FOREST GREEN", "TWILIGHT PURPLE",
    "DARK HTR", "BROWN SAVANA", "MULTI", "TEXAS ORANGE",
}

# El anon key de MaintOps es público por diseño (viaja en su frontend); la
# tabla inventory permite SELECT anónimo. Sobreescribible por env.
MAINTOPS_URL = os.environ.get("MAINTOPS_SUPABASE_URL", "https://kegbjsjlzvwhakacmytm.supabase.co")
MAINTOPS_KEY = os.environ.get(
    "MAINTOPS_SUPABASE_ANON_KEY",
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImtlZ2Jqc2psenZ3aGFrYWNteXRtIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzc5OTg4ODMsImV4cCI6MjA5MzU3NDg4M30.4wNQ_cWKQNuEliR15CN6YT_Fa9rQZm7uSXoStS82i5o",
)
BLOCKER_ITEM_ID = 134  # Velocity blocker grey / Base Grey (cubeta 5 gal)

_COTTON_PCT_RE = re.compile(
    r"(\d+)\s*%?\s*(?:RING[ -]?SPUN\s+|COMBED\s+|PRE-SHRUNK\s+|RINGSPUN\s+|COMED\s+)*(?:COTTON|C\b)"
)


def _cotton_pct(fabric):
    """% de algodón de la composición; None si no hay dato interpretable."""
    f = (fabric or "").strip().upper()
    if not f:
        return None
    m = _COTTON_PCT_RE.search(f)
    if m:
        return int(m.group(1))
    if "COTTON" in f or re.search(r"\bC\b", f):
        return None  # menciona algodón pero sin % legible
    return 0  # composición conocida sin algodón (poliéster, nylon...)


async def _fetch_blocker_stock():
    """Stock vivo de Velocity blocker en MaintOps. None si no hay conexión."""
    try:
        async with httpx.AsyncClient(timeout=8) as client:
            r = await client.get(
                f"{MAINTOPS_URL}/rest/v1/inventory",
                params={"id": f"eq.{BLOCKER_ITEM_ID}", "select": "name,stock_current,stock_min,unit"},
                headers={"apikey": MAINTOPS_KEY, "Authorization": f"Bearer {MAINTOPS_KEY}"},
            )
            r.raise_for_status()
            rows = r.json()
            return rows[0] if rows else None
    except Exception as e:
        logger.warning(f"[blocker-forecast] MaintOps sin conexión: {e}")
        return None


async def _fabric_by_order():
    """order_number -> fabric_content, resuelto ticket → estilo → inventario WMS."""
    fab_by_style = {}
    async for r in db.wms_inventory.aggregate([
        {"$match": {"style": {"$nin": [None, ""]}}},
        {"$group": {"_id": {"s": "$style", "f": {"$ifNull": ["$fabric_content", ""]}},
                    "u": {"$sum": "$units_on_hand"}}},
    ]):
        s = r["_id"]["s"].strip().upper()
        f = (r["_id"]["f"] or "").strip().upper()
        u = r["u"] or 0
        if s not in fab_by_style or u > fab_by_style[s][1]:
            fab_by_style[s] = (f, u)

    fab_by_order = {}
    async for t in db.wms_pick_tickets.find(
        {}, {"_id": 0, "order_number": 1, "style": 1, "total_pick_qty": 1, "quantity": 1}
    ):
        on = str(t.get("order_number") or "").strip()
        st = (t.get("style") or "").strip().upper()
        if not on or st not in fab_by_style:
            continue
        qty = t.get("total_pick_qty") or t.get("quantity") or 0
        if on not in fab_by_order or qty > fab_by_order[on][1]:
            fab_by_order[on] = (fab_by_style[st][0], qty)
    return {on: v[0] for on, v in fab_by_order.items()}


def _positions_count(order) -> float:
    for field in ("print_positions", "print_positions_inferred"):
        pos = order.get(field)
        if isinstance(pos, list) and pos:
            return float(len(pos))
    return 0.0


async def _compute_blocker_forecast(
    ml_per_hit: float = DEFAULT_ML_PER_HIT,
    light_factor: float = DEFAULT_LIGHT_FACTOR,
    positions_fallback: float = DEFAULT_POSITIONS_FALLBACK,
):
    """Calculo del pronostico, sin HTTP. Lo llama la ruta y tambien el job que
    guarda la foto diaria (que no tiene Request de donde colgarse)."""
    orders = await db.orders.find(
        {"board": {"$in": PENDING_BOARDS}},
        {"_id": 0, "order_id": 1, "order_number": 1, "client": 1, "color": 1,
         "quantity": 1, "board": 1, "print_positions": 1,
         "print_positions_inferred": 1, "design_#": 1},
    ).to_list(5000)

    order_ids = [o["order_id"] for o in orders if o.get("order_id")]
    produced = {}
    for i in range(0, len(order_ids), 200):
        chunk = order_ids[i:i + 200]
        async for row in db.production_logs.aggregate([
            {"$match": {"order_id": {"$in": chunk}}},
            {"$group": {"_id": "$order_id", "hits": {"$sum": "$quantity_produced"}}},
        ]):
            produced[row["_id"]] = row["hits"]

    fabric_map = await _fabric_by_order()

    by_board = {}
    detail = []
    total_hits = total_ml = cotton_hits = 0.0
    fabric_known = 0
    for o in orders:
        qty = o.get("quantity") or 0
        if not isinstance(qty, (int, float)) or qty <= 0:
            continue
        positions = _positions_count(o) or positions_fallback
        expected = qty * positions
        pending = max(0.0, expected - produced.get(o.get("order_id"), 0))
        if pending <= 0:
            continue
        color = (o.get("color") or "").strip().upper()
        is_dark = (color in DARK_COLORS) or not color

        fabric = fabric_map.get(str(o.get("order_number") or "").strip())
        pct = _cotton_pct(fabric)
        no_blocker = None if pct is None else (pct >= COTTON_NO_BLOCKER_PCT)
        if no_blocker is not None:
            fabric_known += 1

        # Regla: algodón alto (>=70%: 100, 90/10, 80/20) no lleva blocker.
        # Tela desconocida usa el descuento medido en produccion jul-ago 2026.
        if no_blocker is True:
            factor = 0.0
        elif no_blocker is False:
            factor = 1.0 if is_dark else light_factor
        else:
            factor = ((1 - DARK_COTTON_SHARE) if is_dark
                      else light_factor * (1 - LIGHT_COTTON_SHARE))

        ml = pending * ml_per_hit * factor

        total_hits += pending
        if no_blocker is True:
            cotton_hits += pending
        total_ml += ml
        b = o.get("board") or "?"
        agg = by_board.setdefault(b, {"board": b, "orders": 0, "pending_hits": 0.0, "ml": 0.0})
        agg["orders"] += 1
        agg["pending_hits"] += pending
        agg["ml"] += ml
        detail.append({
            "order_number": o.get("order_number"),
            "client": o.get("client"),
            "color": o.get("color"),
            "board": b,
            "pending_hits": round(pending),
            "is_dark": is_dark,
            "fabric": ("ALGODON" if no_blocker is True else
                       "MEZCLA" if no_blocker is False else "SIN DATO"),
            "ml": round(ml),
        })

    stock = await _fetch_blocker_stock()
    stock_ml = (stock["stock_current"] * ML_PER_BUCKET) if stock else None
    coverage = (stock_ml / total_ml * 100) if (stock_ml is not None and total_ml > 0) else None

    detail.sort(key=lambda x: -x["ml"])
    return {
        "params": {"ml_per_hit": ml_per_hit, "light_factor": light_factor,
                   "positions_fallback": positions_fallback,
                   "cotton_no_blocker_pct": COTTON_NO_BLOCKER_PCT,
                   "dark_cotton_share": DARK_COTTON_SHARE,
                   "light_cotton_share": LIGHT_COTTON_SHARE},
        "totals": {
            "orders": sum(b["orders"] for b in by_board.values()),
            "pending_hits": round(total_hits),
            "cotton_hits": round(cotton_hits),
            "fabric_known_orders": fabric_known,
            "ml": round(total_ml),
            "liters": round(total_ml / 1000, 1),
            "gallons": round(total_ml / 3785.41, 1),
            "buckets": round(total_ml / ML_PER_BUCKET, 2),
        },
        "stock": None if not stock else {
            "name": stock.get("name"),
            "buckets": stock.get("stock_current"),
            "min": stock.get("stock_min"),
            "ml": round(stock_ml),
            "coverage_pct": round(coverage, 1) if coverage is not None else None,
        },
        "by_board": sorted(by_board.values(), key=lambda x: -x["ml"]),
        "top_orders": detail[:15],
    }


# ══════════════════ HISTORIAL DE BLOCKER (foto diaria) ══════════════════
#
# POR QUE EXISTE
# ──────────────
# Esta pantalla nacio como una foto instantanea: leia el stock vivo de MaintOps
# y calculaba el backlog al vuelo, sin guardar nada. Cuando el 2026-08-18 se
# pregunto "nos quedamos sin blocker ayer, ¿el sistema lo advirtio?", no habia
# NADA con que contestar: ni registro propio, ni acceso al historial de MaintOps
# (inventory_logs esta cerrada por RLS para el anon key). Desde aqui se archiva
# una foto por dia para que esa pregunta tenga respuesta la proxima vez.
#
# Se escribe por dos vias, a proposito:
#   · cada vez que alguien abre la pantalla (upsert idempotente del dia), y
#   · un job que despierta cada hora y reclama la foto del dia en la BASE.
# La segunda es la que sostiene el historial los dias que nadie entra; la
# primera es la que capta las bajadas de stock a media jornada.
BLOCKER_SNAP_HORA_UTC = 14      # ~07:00 en el almacen (America/Tijuana)
BLOCKER_SNAP_PERIODO_H = 20     # no repetir la foto programada del dia
BLOCKER_SNAP_ATRASO_H = 30      # catch-up si un reinicio se comio el dia


def _almacen_hoy() -> str:
    """Fecha local del almacen (YYYY-MM-DD). El dia contable es el del piso, no
    el UTC: a las 17:00 de Tijuana el UTC ya cambio de dia y la foto de la tarde
    se archivaria como del dia siguiente."""
    try:
        from zoneinfo import ZoneInfo
        return datetime.now(ZoneInfo("America/Tijuana")).strftime("%Y-%m-%d")
    except Exception:
        return datetime.now(timezone.utc).strftime("%Y-%m-%d")


async def _snapshot_blocker(source: str = "ui"):
    """Archiva (upsert) la foto de HOY en `blocker_snapshots`.

    Guarda el ultimo valor visto del dia y ADEMAS `stock_low`, el minimo que se
    vio: si el almacen se queda en cero a medio dia y en la tarde entra una
    compra, un simple "ultimo valor" borraria justo el evento que importa.
    """
    try:
        fc = await _compute_blocker_forecast()
    except Exception as e:
        logger.warning(f"[blocker-snapshot] no se pudo calcular el pronostico: {e}")
        return None

    stock = fc.get("stock") or {}
    buckets = stock.get("buckets")
    stock_min = stock.get("min")
    hoy = _almacen_hoy()
    ahora = datetime.now(timezone.utc).isoformat()

    doc = {
        "date": hoy,
        "captured_at": ahora,
        "source": source,
        "stock_buckets": buckets,
        "stock_min": stock_min,
        "below_min": (None if (buckets is None or stock_min is None) else buckets < stock_min),
        "empty": (None if buckets is None else buckets <= 0),
        "required_buckets": fc["totals"]["buckets"],
        "pending_hits": fc["totals"]["pending_hits"],
        "orders": fc["totals"]["orders"],
        "coverage_pct": (stock.get("coverage_pct") if stock else None),
    }

    prev = await db.blocker_snapshots.find_one({"date": hoy}, {"_id": 0, "stock_low": 1})
    low = prev.get("stock_low") if prev else None
    if buckets is not None:
        low = buckets if low is None else min(low, buckets)
    doc["stock_low"] = low

    await db.blocker_snapshots.update_one(
        {"date": hoy},
        {"$set": doc, "$setOnInsert": {"first_seen_at": ahora}, "$inc": {"samples": 1}},
        upsert=True,
    )
    return doc


@router.get("/tools/blocker-history")
async def blocker_history(request: Request, days: int = 120):
    """Serie de fotos diarias para el calendario de la calculadora.

    Devuelve tambien `first_date`: antes de esa fecha NO hay registro (la
    bitacora arranco el dia que se desplego esto), y el calendario tiene que
    pintar esos dias como 'sin dato' en vez de como 'todo bien'.
    """
    await require_auth(request)
    days = max(1, min(days, 730))
    desde = (datetime.now(timezone.utc) - timedelta(days=days)).strftime("%Y-%m-%d")
    rows = await db.blocker_snapshots.find(
        {"date": {"$gte": desde}}, {"_id": 0}
    ).sort("date", 1).to_list(1000)
    primera = await db.blocker_snapshots.find_one({}, {"_id": 0, "date": 1}, sort=[("date", 1)])
    return {
        "days": days,
        "first_date": (primera or {}).get("date"),
        "today": _almacen_hoy(),
        "snapshots": rows,
    }


async def _claim_blocker_snapshot(ventana_h: int) -> bool:
    """Reclama la foto del dia en la BASE (no en memoria).

    Mismo patron que el job nocturno de stock fantasma: un temporizador en
    memoria se reinicia con cada deploy y el job termina no corriendo NUNCA.
    El claim es atomico, asi que dos instancias no duplican la foto.
    """
    corte = (datetime.now(timezone.utc) - timedelta(hours=ventana_h)).isoformat()
    res = await db.wms_counters.update_one(
        {"_id": "blocker_snapshot", "$or": [
            {"last_run": {"$lt": corte}}, {"last_run": {"$exists": False}},
        ]},
        {"$set": {"last_run": datetime.now(timezone.utc).isoformat()}},
        upsert=True,
    )
    return bool(res.modified_count or res.upserted_id)


async def blocker_snapshot_loop():
    """Despierta cada hora y archiva la foto del dia cuando toca."""
    import asyncio as _asyncio
    await _asyncio.sleep(240)   # gracia de arranque
    while True:
        try:
            ahora = datetime.now(timezone.utc)
            en_horario = ahora.hour == BLOCKER_SNAP_HORA_UTC
            ventana = BLOCKER_SNAP_PERIODO_H if en_horario else BLOCKER_SNAP_ATRASO_H
            if await _claim_blocker_snapshot(ventana):
                doc = await _snapshot_blocker("job")
                if doc:
                    logger.info(
                        "[blocker-snapshot] %s: stock=%s min=%s requerido=%s cub",
                        doc["date"], doc["stock_buckets"], doc["stock_min"],
                        doc["required_buckets"],
                    )
        except Exception as e:
            logger.error(f"[blocker-snapshot] el job fallo: {e}")
        await _asyncio.sleep(3600)


@router.get("/tools/blocker-forecast")
async def blocker_forecast(
    request: Request,
    ml_per_hit: float = DEFAULT_ML_PER_HIT,
    light_factor: float = DEFAULT_LIGHT_FACTOR,
    positions_fallback: float = DEFAULT_POSITIONS_FALLBACK,
):
    await require_auth(request)
    fc = await _compute_blocker_forecast(ml_per_hit, light_factor, positions_fallback)
    # Abrir la pantalla deja registro: es lo que capta las bajadas de stock a
    # media jornada, que la foto programada de la manana no ve. Nunca debe
    # tumbar la respuesta, por eso va blindado.
    try:
        await _snapshot_blocker("ui")
    except Exception as e:
        logger.warning(f"[blocker-snapshot] no se archivo la foto: {e}")
    return fc
