"""Daily production report scheduler.

Generates the production report (PDF) on a configurable daily schedule
(America/Tijuana) and emails it as an attachment to a recipient list. Runs inside
the FastAPI process via APScheduler — a single job ticks every 60s, and an atomic
per-day claim in Mongo makes the send idempotent even across multiple workers.

Starts DISABLED. Configure recipients + time via PUT /api/report-schedule, then
enable. If APScheduler isn't installed the app still boots and the manual
/run-now endpoint still works — only the automatic daily fire is skipped.
"""
from fastapi import APIRouter, HTTPException, Request
from deps import db, require_auth, require_admin, log_activity, logger
from routers.production import build_production_report
from datetime import datetime
import zoneinfo
import os
import asyncio
import resend

router = APIRouter(prefix="/api")

resend.api_key = os.environ.get('RESEND_API_KEY', '')
SENDER_EMAIL = os.environ.get('SENDER_EMAIL', 'onboarding@resend.dev')
TIJUANA = zoneinfo.ZoneInfo("America/Tijuana")

CONFIG_ID = "daily_production"
_VALID_PRESETS = ("today", "yesterday", "week", "month")
DEFAULTS = {
    "config_id": CONFIG_ID,
    "enabled": False,
    "hour": 19,            # Tijuana local time
    "minute": 0,
    "recipients": [],      # list of email addresses
    "preset": "today",     # report date range
    "format": "excel",
    "subject": "Reporte Diario de Producción",
    "quotes_report": True,   # adjuntar el 2o reporte: quotes de Printavo pendientes de MOS
    "quotes_days": 30,       # ventana de quotes (creados en los últimos N días)
    "last_sent_date": None,  # YYYY-MM-DD (Tijuana) of the last successful send
}


async def _get_config():
    cfg = await db.report_schedules.find_one({"config_id": CONFIG_ID}, {"_id": 0})
    if not cfg:
        await db.report_schedules.insert_one({**DEFAULTS})
        return {**DEFAULTS}
    return {**DEFAULTS, **cfg}


# ── Email with attachment ───────────────────────────────────────────────────────
async def _send_report_email(recipients, subject, html, attachments):
    """attachments = [{filename, content_b64}, ...] — soporta uno o varios adjuntos."""
    if not resend.api_key:
        raise RuntimeError("RESEND_API_KEY no configurado")
    params = {
        "from": SENDER_EMAIL,
        "to": recipients,
        "subject": subject,
        "html": html,
        "attachments": [{"filename": a["filename"], "content": a["content_b64"]} for a in attachments],
    }
    return await asyncio.to_thread(resend.Emails.send, params)


def _report_html(report_date, intro, n_attach=1):
    extra = " y el de quotes pendientes de MOS" if n_attach > 1 else ""
    return f"""
    <div style="font-family:Arial,sans-serif;color:#0F172A">
      <h2 style="color:#0091D5">Reporte Diario de Producción</h2>
      <p>Fecha: <strong>{report_date}</strong></p>
      <p>{intro}</p>
      <p>Se adjunta el reporte de producción en Excel{extra}.</p>
      <p style="color:#64748B;font-size:12px">MOS System · Prosper Manufacturing</p>
    </div>"""


async def _generate_and_send(cfg, report_date, recipients, intro, subject_suffix=""):
    fmt = cfg.get("format", "excel")
    result = await build_production_report(fmt=fmt, preset=cfg.get("preset", "today"), filters={})
    attachments = [{"filename": result["filename"], "content_b64": result["data"]}]
    # 2o reporte: quotes de Printavo (status Quote) que aún no están en MOS.
    # Comparte correo/destinatarios. Si falla (WAF, token), NO tumba el reporte
    # de producción: se registra el error y se manda lo demás.
    if cfg.get("quotes_report", True):
        try:
            from services.quotes_report import build_pending_quotes_report
            q = await build_pending_quotes_report(days=int(cfg.get("quotes_days", 30)))
            if q:
                attachments.append({"filename": q["filename"], "content_b64": q["data"]})
        except Exception as e:
            logger.error(f"[report-scheduler] quotes report failed: {e}")
    subject = f"{cfg.get('subject', 'Reporte Diario de Producción')} — {report_date}{subject_suffix}"
    html = _report_html(report_date, intro, n_attach=len(attachments))
    await _send_report_email(recipients, subject, html, attachments)
    logger.info(f"[report-scheduler] Sent {len(attachments)} attachment(s) for {report_date} to {recipients}")
    return result["filename"]


# ── Scheduler tick (runs every 60s) ─────────────────────────────────────────────
async def _tick():
    try:
        cfg = await db.report_schedules.find_one({"config_id": CONFIG_ID}, {"_id": 0})
        if not cfg or not cfg.get("enabled"):
            return
        recipients = [r for r in cfg.get("recipients", []) if r]
        if not recipients:
            return

        now = datetime.now(TIJUANA)
        today = now.strftime("%Y-%m-%d")
        if cfg.get("last_sent_date") == today:
            return

        scheduled = now.replace(hour=int(cfg.get("hour", 19)),
                                minute=int(cfg.get("minute", 0)),
                                second=0, microsecond=0)
        delta = (now - scheduled).total_seconds()
        # Fire once on the first tick within an hour after the scheduled time.
        if not (0 <= delta <= 3600):
            return

        # Atomic per-day claim — returns the PRE-update doc, or None if already claimed.
        claimed = await db.report_schedules.find_one_and_update(
            {"config_id": CONFIG_ID, "last_sent_date": {"$ne": today}},
            {"$set": {"last_sent_date": today}},
        )
        if not claimed:
            return

        try:
            await _generate_and_send(cfg, today, recipients,
                                     "Resumen automático de producción del día.")
        except Exception as e:
            logger.error(f"[report-scheduler] send failed, releasing claim to retry: {e}")
            await db.report_schedules.update_one(
                {"config_id": CONFIG_ID, "last_sent_date": today},
                {"$set": {"last_sent_date": claimed.get("last_sent_date")}},
            )
    except Exception as e:
        logger.error(f"[report-scheduler] tick error: {e}")


_scheduler = None


def start_report_scheduler():
    """Start the 60s ticking scheduler. Safe to call once on app startup;
    no-ops if already started or if APScheduler isn't installed."""
    global _scheduler
    if _scheduler is not None:
        return
    try:
        from apscheduler.schedulers.asyncio import AsyncIOScheduler
        from apscheduler.triggers.interval import IntervalTrigger
        _scheduler = AsyncIOScheduler(timezone="America/Tijuana")
        _scheduler.add_job(_tick, IntervalTrigger(seconds=60), id="daily_report_tick",
                           replace_existing=True, max_instances=1, coalesce=True)
        _scheduler.start()
        logger.info("[report-scheduler] started (checks every 60s)")
    except Exception as e:
        logger.error(f"[report-scheduler] not started ({e}). Install 'apscheduler' to enable automatic sends.")


# ── Endpoints ────────────────────────────────────────────────────────────────
@router.get("/report-schedule")
async def get_report_schedule(request: Request):
    await require_auth(request)
    return await _get_config()


@router.put("/report-schedule")
async def update_report_schedule(request: Request):
    user = await require_admin(request)
    body = await request.json()
    allowed = {}
    if "enabled" in body:
        allowed["enabled"] = bool(body["enabled"])
    if "hour" in body:
        allowed["hour"] = max(0, min(23, int(body["hour"])))
    if "minute" in body:
        allowed["minute"] = max(0, min(59, int(body["minute"])))
    if "recipients" in body:
        allowed["recipients"] = [str(r).strip() for r in body["recipients"] if str(r).strip()]
    if "preset" in body and body["preset"] in _VALID_PRESETS:
        allowed["preset"] = body["preset"]
    if "subject" in body:
        allowed["subject"] = str(body["subject"])[:200]
    if "format" in body and body["format"] in ("excel", "pdf"):
        allowed["format"] = body["format"]
    if "quotes_report" in body:
        allowed["quotes_report"] = bool(body["quotes_report"])
    if "quotes_days" in body:
        allowed["quotes_days"] = max(1, min(365, int(body["quotes_days"])))
    await db.report_schedules.update_one({"config_id": CONFIG_ID}, {"$set": allowed}, upsert=True)
    await log_activity(user, "update_report_schedule", allowed)
    return await _get_config()


@router.post("/report-schedule/run-now")
async def run_report_now(request: Request):
    """Generate and email the report immediately. `?to`/body.to overrides recipients
    for a test send. Does not touch the daily idempotency claim."""
    user = await require_admin(request)
    cfg = await _get_config()
    try:
        body = await request.json()
    except Exception:
        body = {}
    test_to = body.get("to") or request.query_params.get("to")
    recipients = [test_to] if test_to else [r for r in cfg.get("recipients", []) if r]
    if not recipients:
        raise HTTPException(400, "No hay destinatarios configurados")
    if not resend.api_key:
        raise HTTPException(500, "RESEND_API_KEY no configurado en el backend")
    report_date = datetime.now(TIJUANA).strftime("%Y-%m-%d")
    filename = await _generate_and_send(cfg, report_date, recipients,
                                        "Envío manual del reporte de producción.",
                                        subject_suffix=" (manual)")
    await log_activity(user, "run_report_now", {"recipients": recipients})
    return {"status": "sent", "recipients": recipients, "filename": filename}
