"""Automatización 'Barrido a BLANKS' (switch encendido/apagado).

Cuando está ENCENDIDA, cada `sweep_minutes` (default 10) barre todas las órdenes
del tablero SCHEDULING que tengan un `cancel_date` válido y las mueve al tablero
BLANKS, distribuyéndolas por día según ese cancel_date:
  - scheduled_date = cancel_date (YYYY-MM-DD)  → se ubica en la vista Calendario
  - scheduled_day  = día de la semana de esa fecha → se agrupa en la vista Tabla
Las órdenes SIN cancel_date válido NO se mueven (se quedan en SCHEDULING) y se
reportan en el conteo. Las bloqueadas por QC tampoco se tocan.

Corre dentro del proceso FastAPI vía APScheduler (tick de 60s), igual que
report_scheduler.py / printavo_scheduler.py. Arranca APAGADA. Se prende/apaga con
PUT /api/blanks-sweep (solo Admin nivel 5 + supersu) y se puede probar sin esperar
el tick con POST /api/blanks-sweep/run-now.

Es un ESCRITOR PROPIO y SILENCIOSO: hace un $set mínimo y un solo broadcast de
WebSocket al final. A propósito NO reusa el endpoint bulk-move, porque ese dispara
automations "move" por orden + notificaciones, lo que a cada 10 min sería una
tormenta. Si en el futuro se quiere que dispare automations, es un cambio acotado.
"""
import asyncio
from datetime import datetime, timezone, timedelta

from fastapi import APIRouter, HTTPException, Request

from deps import db, require_auth, require_admin_level, log_activity, logger

router = APIRouter(prefix="/api")

CONFIG_ID = "blanks_sweep"
SOURCE_BOARD = "SCHEDULING"
TARGET_BOARD = "BLANKS"
BATCH_SIZE = 200  # Mongo prod resetea respuestas grandes: leemos en lotes chicos.
MIN_MINUTES = 1
MAX_MINUTES = 24 * 60

DEFAULTS = {
    "config_id": CONFIG_ID,
    "enabled": False,          # arranca APAGADA
    "sweep_minutes": 10,       # cadencia del barrido
    "last_run_at": None,       # ISO UTC del último barrido (tick automático)
    "last_result": None,       # dict con el conteo del último barrido
    "last_error": None,        # último error, si hubo
    "moved_total": 0,          # órdenes movidas acumuladas
}

# Serializa cualquier barrido (tick + run-now) dentro de este proceso, para que dos
# pasadas no se encimen sobre las mismas órdenes.
_sweep_lock = asyncio.Lock()


async def _get_config():
    cfg = await db.automation_config.find_one({"config_id": CONFIG_ID}, {"_id": 0})
    if not cfg:
        await db.automation_config.insert_one({**DEFAULTS})
        return {**DEFAULTS}
    return {**DEFAULTS, **cfg}


def _parse_cancel_date(raw):
    """cancel_date → date, o None si falta/es inválido. Acepta 'YYYY-MM-DD' o ISO."""
    if not raw:
        return None
    s = str(raw).strip()
    if not s:
        return None
    try:
        return datetime.strptime(s[:10], "%Y-%m-%d").date()
    except (ValueError, TypeError):
        pass
    try:
        return datetime.fromisoformat(s).date()
    except (ValueError, TypeError):
        return None


# ── Núcleo del barrido ──────────────────────────────────────────────────────────
async def _sweep_core(trigger: str):
    """Barre SCHEDULING → BLANKS distribuyendo por cancel_date. Devuelve el conteo.

    Debe llamarse con `_sweep_lock` tomado. NO toca `last_run_at` (eso lo maneja el
    claim atómico del tick); sí actualiza contadores/last_result/last_error.
    """
    from routers.orders import WEEKDAY_NAMES  # import perezoso: evita ciclo de imports

    now_iso = datetime.now(timezone.utc).isoformat()
    moved = 0
    skipped_no_cancel = 0
    skipped_qc = 0
    scanned = 0
    # Agrupa por (scheduled_date, scheduled_day) para hacer pocos update_many.
    buckets = {}  # (date_iso, weekday) -> [order_id...]

    last_id = None
    while True:
        query = {"board": SOURCE_BOARD}
        if last_id is not None:
            query["order_id"] = {"$gt": last_id}
        batch = await db.orders.find(
            query,
            {"_id": 0, "order_id": 1, "cancel_date": 1, "locked_by_qc": 1},
        ).sort("order_id", 1).limit(BATCH_SIZE).to_list(BATCH_SIZE)
        if not batch:
            break
        for o in batch:
            scanned += 1
            oid = o.get("order_id")
            if not oid:
                continue
            if o.get("locked_by_qc"):
                skipped_qc += 1
                continue
            d = _parse_cancel_date(o.get("cancel_date"))
            if d is None:
                skipped_no_cancel += 1
                continue
            key = (d.isoformat(), WEEKDAY_NAMES[d.weekday()])
            buckets.setdefault(key, []).append(oid)
        if len(batch) < BATCH_SIZE:
            break
        last_id = batch[-1].get("order_id")

    for (date_iso, weekday), ids in buckets.items():
        # Escritura en sub-lotes para no pasar arrays gigantes a Mongo.
        for i in range(0, len(ids), BATCH_SIZE):
            chunk = ids[i:i + BATCH_SIZE]
            res = await db.orders.update_many(
                {"order_id": {"$in": chunk}, "board": SOURCE_BOARD},
                {"$set": {
                    "board": TARGET_BOARD,
                    "scheduled_date": date_iso,
                    "scheduled_day": weekday,
                    "queue_status": "active",  # BLANKS soporta cola; entra activa
                    "updated_at": now_iso,
                }},
            )
            moved += res.modified_count

    result = {
        "trigger": trigger,
        "at": now_iso,
        "scanned": scanned,
        "moved": moved,
        "skipped_no_cancel": skipped_no_cancel,
        "skipped_qc": skipped_qc,
    }

    await db.automation_config.update_one(
        {"config_id": CONFIG_ID},
        {"$set": {"last_result": result, "last_error": None},
         "$inc": {"moved_total": moved}},
        upsert=True,
    )

    if moved:
        try:
            from routers.orders import ws_manager
            await ws_manager.broadcast(
                "order_change",
                {"action": "bulk_move", "boards": [SOURCE_BOARD, TARGET_BOARD]},
            )
        except Exception as e:  # el barrido no debe fallar por el broadcast
            logger.error(f"[blanks-sweep] broadcast falló: {e}")

    logger.info(f"[blanks-sweep] {trigger}: {result}")
    return result


# ── Tick del scheduler (corre cada 60s) ──────────────────────────────────────────
async def _tick():
    try:
        cfg = await db.automation_config.find_one({"config_id": CONFIG_ID}, {"_id": 0})
        if not cfg or not cfg.get("enabled"):
            return

        minutes = int(cfg.get("sweep_minutes") or DEFAULTS["sweep_minutes"])
        minutes = max(MIN_MINUTES, min(MAX_MINUTES, minutes))
        threshold = (datetime.now(timezone.utc) - timedelta(minutes=minutes)).isoformat()
        now_iso = datetime.now(timezone.utc).isoformat()

        # Claim atómico: solo un worker/tick gana la corrida de esta ventana. Compara
        # last_run_at (ISO UTC, mismo formato → orden lexicográfico == cronológico).
        claimed = await db.automation_config.find_one_and_update(
            {"config_id": CONFIG_ID, "enabled": True,
             "$or": [
                 {"last_run_at": None},
                 {"last_run_at": {"$exists": False}},
                 {"last_run_at": {"$lt": threshold}},
             ]},
            {"$set": {"last_run_at": now_iso}},
        )
        if not claimed:
            return

        async with _sweep_lock:
            try:
                await _sweep_core("scheduler")
            except Exception as e:
                logger.error(f"[blanks-sweep] barrido falló: {e}")
                await db.automation_config.update_one(
                    {"config_id": CONFIG_ID},
                    {"$set": {"last_error": str(e)}},
                )
    except Exception as e:
        logger.error(f"[blanks-sweep] tick error: {e}")


_scheduler = None


def start_blanks_sweep_scheduler():
    """Arranca el tick de 60s. Seguro de llamar una vez en el startup; no-op si ya
    arrancó o si APScheduler no está instalado."""
    global _scheduler
    if _scheduler is not None:
        return
    try:
        from apscheduler.schedulers.asyncio import AsyncIOScheduler
        from apscheduler.triggers.interval import IntervalTrigger
        _scheduler = AsyncIOScheduler(timezone="UTC")
        _scheduler.add_job(_tick, IntervalTrigger(seconds=60), id="blanks_sweep_tick",
                           replace_existing=True, max_instances=1, coalesce=True)
        _scheduler.start()
        logger.info("[blanks-sweep] started (checks every 60s)")
    except Exception as e:
        logger.error(f"[blanks-sweep] not started ({e}). Install 'apscheduler' to enable.")


# ── Endpoints ─────────────────────────────────────────────────────────────────
@router.get("/blanks-sweep")
async def get_blanks_sweep(request: Request):
    await require_auth(request)
    return await _get_config()


@router.put("/blanks-sweep")
async def update_blanks_sweep(request: Request):
    user = await require_admin_level(request, 5)  # Admin L5 + supersu
    body = await request.json()
    allowed = {}
    if "enabled" in body:
        allowed["enabled"] = bool(body["enabled"])
    if "sweep_minutes" in body:
        allowed["sweep_minutes"] = max(MIN_MINUTES, min(MAX_MINUTES, int(body["sweep_minutes"])))
    if not allowed:
        raise HTTPException(status_code=400, detail="Nada que actualizar")
    await db.automation_config.update_one(
        {"config_id": CONFIG_ID}, {"$set": allowed}, upsert=True,
    )
    await log_activity(user, "update_blanks_sweep", allowed)
    return await _get_config()


@router.post("/blanks-sweep/run-now")
async def run_blanks_sweep_now(request: Request):
    """Dispara el barrido de inmediato (sin esperar el tick ni exigir enabled).
    Útil para probar. No altera la cadencia (no toca last_run_at)."""
    user = await require_admin_level(request, 5)
    async with _sweep_lock:
        try:
            result = await _sweep_core("manual")
        except Exception as e:
            await db.automation_config.update_one(
                {"config_id": CONFIG_ID}, {"$set": {"last_error": str(e)}},
            )
            raise HTTPException(status_code=500, detail=f"Barrido falló: {e}")
    await log_activity(user, "run_blanks_sweep_now", result)
    return {"status": "ok", **result}
