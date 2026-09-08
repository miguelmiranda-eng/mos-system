"""Scheduler de automatizaciones por TIEMPO / SLA (Fase 3, Track 1).

El motor normal de automatizaciones es síncrono (dispara en el CRUD de la orden).
Las reglas trigger_type:"time" no las puede disparar ningún CRUD porque el evento
es el paso del tiempo — este scheduler barre las órdenes cada N minutos y evalúa
esas reglas (time_rule_due + time_conditions_ok de automations.py), ejecutando su
acción con execute_action (reusa notify_push/add_comment/move_board/multi/...).

Idempotencia: cada (regla, orden) dispara UNA vez (claim en automation_fires) para
no re-alertar en cada tick. Si se re-entra a la condición NO se re-dispara (v1);
run-now con reset=true limpia los claims de una regla para poder re-probar.

Arranca DESHABILITADO. Habilita + intervalo con PUT /api/automation-sla; prueba con
POST /api/automation-sla/run-now. Mirror de printavo_scheduler.py.
"""
import asyncio
import os
from datetime import datetime, timezone

from fastapi import APIRouter, HTTPException, Request
from pymongo.errors import DuplicateKeyError

from deps import db, require_auth, require_admin, log_activity, logger

router = APIRouter(prefix="/api")

TRASH = "PAPELERA DE RECICLAJE"
CONFIG_ID = "automation_sla"
SCHED_USER = {"user_id": "automation_time", "email": "system@prosper-mfg.com",
              "name": "Automatización (tiempo)", "role": "admin"}

DEFAULTS = {
    "config_id": CONFIG_ID,
    "enabled": False,
    "poll_minutes": int(os.environ.get("AUTOMATION_SLA_MINUTES", "15")),
    "last_run_at": None,
    "last_error": None,
    "fired_count": 0,
}

_lock = asyncio.Lock()


async def _claim_fire(automation_id, order_id) -> bool:
    """Reclama (regla, orden) para que dispare UNA sola vez. True la 1ª vez."""
    if not (automation_id and order_id):
        return False
    try:
        await db.automation_fires.insert_one({
            "_id": f"{automation_id}:{order_id}",
            "automation_id": automation_id, "order_id": order_id,
            "at": datetime.now(timezone.utc).isoformat(),
        })
        return True
    except DuplicateKeyError:
        return False


async def evaluate_time_rules(now=None) -> dict:
    """Barre las órdenes y dispara las reglas de tiempo vencidas. Devuelve
    {rules, fired}."""
    from routers.automations import time_rule_due, time_conditions_ok, execute_action
    now = now or datetime.now(timezone.utc)
    rules = await db.automations.find({"trigger_type": "time", "is_active": True}, {"_id": 0}).to_list(200)
    if not rules:
        return {"rules": 0, "fired": 0}

    # Sin las columnas pesadas (memoria: prod resetea respuestas grandes). Las
    # reglas de tiempo usan ACCIONES, no requisitos, así que 'images' no se necesita.
    proj = {"comments": 0, "activity_logs": 0, "history": 0, "images": 0}
    PAGE = 200
    fired = 0
    for rule in rules:
        cond = rule.get("trigger_conditions") or {}
        q = {"board": {"$ne": TRASH}}
        boards = rule.get("boards") or []
        if boards:
            q["board"] = {"$in": boards}
        skip = 0
        while True:
            page = await db.orders.find(q, proj).skip(skip).limit(PAGE).to_list(PAGE)
            if not page:
                break
            for order in page:
                try:
                    if not time_rule_due(cond, order, now):
                        continue
                    if not time_conditions_ok(cond, order):
                        continue
                    if not await _claim_fire(rule.get("automation_id"), order.get("order_id")):
                        continue
                    await execute_action(rule.get("action_type"), rule.get("action_params") or {}, order, SCHED_USER)
                    fired += 1
                    await log_activity(SCHED_USER, "automation_triggered", {
                        "automation_id": rule.get("automation_id"),
                        "automation_name": rule.get("name"),
                        "target_id": order.get("order_id"), "target_type": "order", "via": "time",
                    })
                except Exception as e:
                    logger.error(f"[auto-time] regla '{rule.get('name')}' orden {order.get('order_number')}: {e}")
            if len(page) < PAGE:
                break
            skip += PAGE
    return {"rules": len(rules), "fired": fired}


# ── Scheduler ────────────────────────────────────────────────────────────────
_sched = None


async def _tick():
    try:
        cfg = await db.automation_scheduler.find_one({"config_id": CONFIG_ID}, {"_id": 0})
        if not cfg or not cfg.get("enabled"):
            return
        if _lock.locked():
            return
        now = datetime.now(timezone.utc).isoformat()
        async with _lock:
            res = await evaluate_time_rules()
        upd = {"last_run_at": now, "last_error": None}
        if res.get("fired"):
            upd["fired_count"] = int(cfg.get("fired_count") or 0) + int(res["fired"])
        await db.automation_scheduler.update_one({"config_id": CONFIG_ID}, {"$set": upd}, upsert=True)
        if res.get("fired"):
            logger.info(f"[auto-time] disparó {res['fired']} acción(es) este tick")
    except Exception as e:
        logger.error(f"[auto-time] tick error: {e}")
        await db.automation_scheduler.update_one(
            {"config_id": CONFIG_ID},
            {"$set": {"last_run_at": datetime.now(timezone.utc).isoformat(), "last_error": str(e)[:500]}},
            upsert=True)


def start_automation_scheduler():
    """Arranca el poller (idempotente). No-op si APScheduler no está."""
    global _sched
    if _sched is not None:
        return
    try:
        from apscheduler.schedulers.asyncio import AsyncIOScheduler
        from apscheduler.triggers.interval import IntervalTrigger
        minutes = int(os.environ.get("AUTOMATION_SLA_MINUTES", "15"))
        _sched = AsyncIOScheduler(timezone="America/Tijuana")
        _sched.add_job(_tick, IntervalTrigger(minutes=max(1, minutes)), id="automation_time_tick",
                       replace_existing=True, max_instances=1, coalesce=True)
        _sched.start()
        logger.info(f"[auto-time] scheduler started (every {minutes} min)")
    except Exception as e:
        logger.error(f"[auto-time] not started ({e}). Instala 'apscheduler' para el barrido automático.")


# ── Endpoints ────────────────────────────────────────────────────────────────
async def _get_config() -> dict:
    cfg = await db.automation_scheduler.find_one({"config_id": CONFIG_ID}, {"_id": 0})
    if not cfg:
        await db.automation_scheduler.insert_one({**DEFAULTS})
        return {**DEFAULTS}
    return {**DEFAULTS, **cfg}


@router.get("/automation-sla")
async def get_sla(request: Request):
    await require_auth(request)
    return await _get_config()


@router.put("/automation-sla")
async def update_sla(request: Request):
    user = await require_admin(request)
    body = await request.json()
    allowed = {}
    if "enabled" in body:
        allowed["enabled"] = bool(body["enabled"])
    if "poll_minutes" in body:
        allowed["poll_minutes"] = max(1, min(1440, int(body["poll_minutes"])))
    await db.automation_scheduler.update_one({"config_id": CONFIG_ID}, {"$set": allowed}, upsert=True)
    await log_activity(user, "update_automation_sla", allowed)
    return await _get_config()


@router.post("/automation-sla/run-now")
async def run_sla_now(request: Request):
    """Corre una pasada YA. Body opcional {"reset_automation_id": "auto_..."} limpia
    los claims de esa regla para poder re-dispararla (pruebas)."""
    user = await require_admin(request)
    if _lock.locked():
        raise HTTPException(409, "Ya hay una pasada de SLA en curso.")
    try:
        body = await request.json()
    except Exception:
        body = {}
    reset_id = (body or {}).get("reset_automation_id")
    if reset_id:
        await db.automation_fires.delete_many({"automation_id": reset_id})
    async with _lock:
        res = await evaluate_time_rules()
    await log_activity(user, "run_automation_sla_now", {"fired": res.get("fired", 0), "reset": reset_id})
    return {"status": "ok", **res}
