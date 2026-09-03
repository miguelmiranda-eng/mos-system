"""Printavo invoice auto-sync scheduler.

Polls the Printavo GraphQL API on a configurable interval and creates a MOS
order for every new invoice (see printavo_sync.py for the mapping). Runs inside
the FastAPI process via APScheduler, mirroring report_scheduler.py.

Starts DISABLED. Enable + set the interval via PUT /api/printavo-sync, then use
POST /api/printavo-sync/run-now to test without waiting for the next tick. If
APScheduler or the Printavo credentials are missing, the app still boots and the
automatic poll is simply skipped.
"""
import asyncio
import os
from datetime import datetime, timezone

from fastapi import APIRouter, HTTPException, Request

from deps import db, require_auth, require_admin, log_activity, logger
import printavo_client
from printavo_sync import (
    sync_once, finalize_once, apply_final_bill_by_visual_id,
    backfill_sample_flags,
    CONFIG_ID, DEFAULT_FINAL_BILL_STATUSES,
)

router = APIRouter(prefix="/api")

# Serializes every sync pass (scheduler tick + manual run-now) inside this process.
# Without it, two overlapping passes read the same stale watermark and each recreate
# the same invoice — the dedup in process_invoice is check-then-insert and NOT atomic,
# so concurrent passes produced duplicate orders (e.g. invoice 2103 created 3x).
_sync_lock = asyncio.Lock()

DEFAULTS = {
    "config_id": CONFIG_ID,
    "enabled": False,
    "poll_minutes": int(os.environ.get("PRINTAVO_POLL_MINUTES", "5")),
    "fetch_size": 25,
    "last_visual_id": None,   # high-water mark (highest processed invoice number)
    "last_run_at": None,      # ISO timestamp of last poll attempt
    "last_error": None,       # last error message, if any
    "created_count": 0,       # cumulative orders created by the sync
    # ── Final Bill pass ──────────────────────────────────────────────────────
    "final_bill_enabled": True,                            # run the finalize pass each tick
    "final_bill_status_names": DEFAULT_FINAL_BILL_STATUSES,  # Printavo status name(s) to match
    "final_bill_max_pages": 5,          # shallow pass: pages of 25 scanned each tick
    "final_bill_deep_pages": 40,        # deep sweep: pages walked end-to-end (40x25 = 1000)
    "final_bill_deep_every_minutes": 360,  # how often the deep sweep runs (0 = never)
    "finalized_count": 0,     # cumulative orders whose invoice/total were filled
    "last_finalize_at": None,
    "last_finalize_error": None,
    "last_deep_finalize_at": None,
}


def _deep_due(cfg: dict) -> bool:
    """True when the deep Final Bill sweep is due.

    The shallow pass only sees invoices billed in VISUAL_ID order; a straggler
    that reaches Final Bill late sits below its window forever. The deep sweep
    walks the whole list to catch those, but each page is a heavy GraphQL query,
    so it runs on its own slow cadence instead of every tick.
    """
    every = int(cfg.get("final_bill_deep_every_minutes") or 0)
    if every <= 0:
        return False
    last = cfg.get("last_deep_finalize_at")
    if not last:
        return True  # never swept
    try:
        prev = datetime.fromisoformat(str(last))
    except ValueError:
        return True
    if prev.tzinfo is None:
        prev = prev.replace(tzinfo=timezone.utc)
    return (datetime.now(timezone.utc) - prev).total_seconds() >= every * 60


async def _get_config() -> dict:
    cfg = await db.printavo_sync.find_one({"config_id": CONFIG_ID}, {"_id": 0})
    if not cfg:
        await db.printavo_sync.insert_one({**DEFAULTS})
        return {**DEFAULTS}
    return {**DEFAULTS, **cfg}


async def _run_sync(cfg: dict) -> dict:
    """Run one sync pass and persist the resulting state. Returns a summary."""
    now = datetime.now(timezone.utc).isoformat()
    try:
        result = await sync_once(cfg)
        update = {"last_run_at": now, "last_error": None}
        if result.get("watermark") is not None:
            update["last_visual_id"] = str(result["watermark"])
        if result.get("created"):
            update["created_count"] = int(cfg.get("created_count") or 0) + int(result["created"])
        await db.printavo_sync.update_one({"config_id": CONFIG_ID}, {"$set": update}, upsert=True)
    except Exception as e:
        logger.error(f"[printavo-sync] run error: {e}")
        await db.printavo_sync.update_one(
            {"config_id": CONFIG_ID}, {"$set": {"last_run_at": now, "last_error": str(e)[:500]}}, upsert=True
        )
        raise

    # Final Bill pass runs independently: an invoice reaching Final Bill has
    # nothing to do with which invoices were just created, and a finalize failure
    # must not fail (or roll back) the create pass. Errors are recorded, not raised.
    if cfg.get("final_bill_enabled", True):
        deep = _deep_due(cfg)
        try:
            fin = await finalize_once(cfg, deep=deep)
            fupd = {"last_finalize_at": now, "last_finalize_error": None}
            if deep:
                fupd["last_deep_finalize_at"] = now
            if fin.get("finalized"):
                fupd["finalized_count"] = int(cfg.get("finalized_count") or 0) + int(fin["finalized"])
            await db.printavo_sync.update_one({"config_id": CONFIG_ID}, {"$set": fupd}, upsert=True)
            result["finalized"] = fin.get("finalized", 0)
            result["deep"] = bool(fin.get("deep"))
        except Exception as e:
            logger.error(f"[printavo-sync] finalize error: {e}")
            ferr = {"last_finalize_at": now, "last_finalize_error": str(e)[:500]}
            if deep:
                # Stamp it anyway: a deep sweep that fails (rate limit, timeout)
                # must wait its normal cadence, not retry 40 heavy pages next tick.
                ferr["last_deep_finalize_at"] = now
            await db.printavo_sync.update_one(
                {"config_id": CONFIG_ID}, {"$set": ferr}, upsert=True,
            )
    return result


async def _sync_guarded() -> dict:
    """Run one sync pass under the process-wide lock, reading a FRESH config inside
    the lock. A caller that queued behind a running pass therefore uses the updated
    watermark instead of reprocessing the invoices the previous pass just created."""
    async with _sync_lock:
        cfg = await _get_config()
        return await _run_sync(cfg)


# ── Scheduler tick ───────────────────────────────────────────────────────────
async def _tick():
    try:
        cfg = await db.printavo_sync.find_one({"config_id": CONFIG_ID}, {"_id": 0})
        if not cfg or not cfg.get("enabled"):
            return
        if not printavo_client.is_configured():
            return
        # Skip this tick if a pass (manual or a previous tick) is still running.
        if _sync_lock.locked():
            logger.info("[printavo-sync] tick skipped — a sync pass is already running")
            return
        result = await _sync_guarded()
        if result.get("created"):
            logger.info(f"[printavo-sync] created {result['created']} order(s) this tick")
    except Exception as e:
        logger.error(f"[printavo-sync] tick error: {e}")


_scheduler = None


def start_printavo_scheduler():
    """Start the polling scheduler. Safe to call once on app startup;
    no-ops if already started or if APScheduler isn't installed."""
    global _scheduler
    if _scheduler is not None:
        return
    try:
        from apscheduler.schedulers.asyncio import AsyncIOScheduler
        from apscheduler.triggers.interval import IntervalTrigger
        minutes = int(os.environ.get("PRINTAVO_POLL_MINUTES", "5"))
        _scheduler = AsyncIOScheduler(timezone="America/Tijuana")
        _scheduler.add_job(_tick, IntervalTrigger(minutes=max(1, minutes)), id="printavo_sync_tick",
                           replace_existing=True, max_instances=1, coalesce=True)
        _scheduler.start()
        logger.info(f"[printavo-sync] started (checks every {minutes} min)")
    except Exception as e:
        logger.error(f"[printavo-sync] not started ({e}). Install 'apscheduler' to enable automatic polling.")


# ── Endpoints ────────────────────────────────────────────────────────────────
@router.get("/printavo-sync")
async def get_printavo_sync(request: Request):
    await require_auth(request)
    cfg = await _get_config()
    cfg["configured"] = printavo_client.is_configured()
    return cfg


@router.put("/printavo-sync")
async def update_printavo_sync(request: Request):
    user = await require_admin(request)
    body = await request.json()
    allowed = {}
    if "enabled" in body:
        allowed["enabled"] = bool(body["enabled"])
    if "poll_minutes" in body:
        allowed["poll_minutes"] = max(1, min(1440, int(body["poll_minutes"])))
    if "fetch_size" in body:
        allowed["fetch_size"] = max(1, min(30, int(body["fetch_size"])))
    # Allow resetting the watermark (e.g. to re-seed or force a backfill window).
    if "last_visual_id" in body:
        allowed["last_visual_id"] = str(body["last_visual_id"]).strip() or None
    # ── Final Bill pass config ───────────────────────────────────────────────
    if "final_bill_enabled" in body:
        allowed["final_bill_enabled"] = bool(body["final_bill_enabled"])
    if "final_bill_status_names" in body:
        raw = body["final_bill_status_names"]
        if isinstance(raw, str):
            raw = [s for s in (p.strip() for p in raw.split(",")) if s]
        allowed["final_bill_status_names"] = [str(s).strip() for s in (raw or []) if str(s).strip()]
    if "final_bill_max_pages" in body:
        allowed["final_bill_max_pages"] = max(1, min(40, int(body["final_bill_max_pages"])))
    if "final_bill_deep_pages" in body:
        allowed["final_bill_deep_pages"] = max(1, min(200, int(body["final_bill_deep_pages"])))
    if "final_bill_deep_every_minutes" in body:
        # 0 disables the deep sweep (shallow pass only).
        allowed["final_bill_deep_every_minutes"] = max(0, min(10080, int(body["final_bill_deep_every_minutes"])))
    # Setting final_bill_seeded=false re-arms the finalize pass to back-fill every
    # invoice currently in Final Bill (one-shot catch-up) on the next run.
    if "final_bill_seeded" in body:
        allowed["final_bill_seeded"] = bool(body["final_bill_seeded"])
    await db.printavo_sync.update_one({"config_id": CONFIG_ID}, {"$set": allowed}, upsert=True)
    await log_activity(user, "update_printavo_sync", allowed)
    cfg = await _get_config()
    cfg["configured"] = printavo_client.is_configured()
    return cfg


@router.post("/printavo-sync/run-now")
async def run_printavo_sync_now(request: Request):
    """Run one sync pass immediately (respects the watermark; seeds it on first run)."""
    user = await require_admin(request)
    if not printavo_client.is_configured():
        raise HTTPException(400, "Credenciales de Printavo no configuradas (PRINTAVO_API_EMAIL / PRINTAVO_API_TOKEN)")
    # Reject overlapping manual runs (double-click / run while a tick is polling) so
    # two passes can't reprocess the same invoices and create duplicate orders.
    if _sync_lock.locked():
        raise HTTPException(409, "Ya hay una sincronización en curso. Espera unos segundos e intenta de nuevo.")
    result = await _sync_guarded()
    await log_activity(user, "run_printavo_sync_now", {"created": result.get("created", 0)})
    return {"status": "ok", **result}


@router.post("/printavo-sync/finalize-now")
async def finalize_printavo_now(request: Request):
    """Manually apply the Final Bill values (total facturado + total quantity)
    to orders already in Final Bill — a one-shot BACKFILL, and the way to test.

    Body (optional):
      {"visual_id": "1236"}  -> apply just that order (re-runnable, ignores claim).
      {}                     -> backfill EVERY invoice currently in Final Bill.
    """
    user = await require_admin(request)
    if not printavo_client.is_configured():
        raise HTTPException(400, "Credenciales de Printavo no configuradas (PRINTAVO_API_EMAIL / PRINTAVO_API_TOKEN)")
    if _sync_lock.locked():
        raise HTTPException(409, "Ya hay una sincronización en curso. Espera unos segundos e intenta de nuevo.")
    try:
        body = await request.json()
    except Exception:
        body = {}
    visual_id = str((body or {}).get("visual_id") or "").strip()

    async with _sync_lock:
        cfg = await _get_config()
        if visual_id:
            res = await apply_final_bill_by_visual_id(visual_id, cfg)
        else:
            # Backfill: force-apply, paginating deep enough to cover the whole
            # Final Bill backlog (40 pages × 25 = up to 1000 invoices).
            bcfg = {**cfg, "final_bill_max_pages": 40, "final_bill_fetch_size": 25}
            res = await finalize_once(bcfg, force_apply=True)
            fin = int(res.get("finalized") or 0)
            if fin:
                await db.printavo_sync.update_one(
                    {"config_id": CONFIG_ID},
                    {"$set": {
                        "finalized_count": int(cfg.get("finalized_count") or 0) + fin,
                        "last_finalize_at": datetime.now(timezone.utc).isoformat(),
                    }}, upsert=True,
                )
    await log_activity(user, "printavo_finalize_now", {"visual_id": visual_id or None, "result": res})
    return {"status": "ok", **res}


@router.post("/printavo-sync/backfill-samples")
async def backfill_samples_now(request: Request):
    """Rellena requires_sample/sample_spec en órdenes YA importadas de Printavo,
    releyendo la línea SAMPLES de cada invoice. SOLO escribe esos dos campos.

    Body (opcional):
      {"order_number": "2299"}          -> solo esa orden (re-ejecutable).
      {"limit": 500, "only_missing": true} -> lote; only_missing (default true)
        procesa solo las que aún no tienen el campo. only_missing=false re-lee todas.
    """
    user = await require_admin(request)
    if not printavo_client.is_configured():
        raise HTTPException(400, "Credenciales de Printavo no configuradas (PRINTAVO_API_EMAIL / PRINTAVO_API_TOKEN)")
    if _sync_lock.locked():
        raise HTTPException(409, "Ya hay una sincronización en curso. Espera unos segundos e intenta de nuevo.")
    try:
        body = await request.json()
    except Exception:
        body = {}
    order_number = str((body or {}).get("order_number") or "").strip()
    only_missing = bool((body or {}).get("only_missing", True))
    try:
        limit = int((body or {}).get("limit") or 500)
    except (TypeError, ValueError):
        limit = 500

    async with _sync_lock:
        res = await backfill_sample_flags(limit=limit, only_missing=only_missing,
                                          order_number=order_number)
    await log_activity(user, "printavo_backfill_samples",
                       {"order_number": order_number or None, "result": res})
    return {"status": "ok", **res}
