"""Reportes automáticos por correo: un CATÁLOGO FIJO de tipos de reporte.

Cada tipo de reporte tiene UNA configuración propia (activo, hora Tijuana,
días de la semana, destinatarios, asunto y opciones del tipo). No se crean ni
se borran reportes: se prenden, se apagan y se les asignan correos. Corre
dentro del proceso de FastAPI con APScheduler: un solo job revisa cada 60s, y
un claim atómico por (reporte, día) en Mongo hace el envío idempotente aunque
haya varios workers.

Tipos (REPORT_TYPES, en el orden en que se muestran):
  production_daily      -> schedule_id "daily_production". El reporte diario de
                           siempre: Excel/PDF de producción adjunto + quotes de
                           Printavo pendientes de MOS.
  executive_production  -> schedule_id "executive_production". Reporte Ejecutivo
                           de Producción: indicadores en el cuerpo del correo
                           (prints y unidades de ayer/hoy, semana, próxima semana,
                           Test Orders, envíos, excepciones). Sale de
                           services/production_kpis, la misma cuenta del
                           dashboard de Planeación.
Agregar un tipo = una entrada en REPORT_TYPES + su constructor en BUILDERS.

Colecciones:
  report_schedules  {schedule_id, report_type, enabled, hour, minute,
                     weekdays[0=lun..6=dom], recipients, subject, last_sent_date, ...opciones}
                    Migración automática: la configuración única vieja
                    ({config_id: daily_production}) y un ejecutivo creado con
                    la versión anterior (schedule_id rsch_...) se adoptan como
                    los registros fijos, sin perder destinatarios ni horario.
  report_sends      bitácora de cada envío (auto / manual / prueba), con error.

Endpoints:
  GET  /api/report-schedules                los reportes del catálogo + últimos envíos
  PUT  /api/report-schedules/{id}           edita (admin)
  POST /api/report-schedules/{id}/run-now   envía ya; body.to = prueba a un solo correo (admin)
  GET  /api/report-schedules/{id}/preview   asunto + HTML sin enviar (admin)
  GET/PUT /api/report-schedule, POST /api/report-schedule/run-now
                                            compatibilidad: el reporte diario.

Si APScheduler no está instalado la app arranca igual y "enviar ahora"
funciona; sólo se salta el envío automático.
"""
from fastapi import APIRouter, HTTPException, Request
from deps import db, require_auth, require_admin, log_activity, logger
from routers.production import build_production_report
from datetime import datetime, timezone
import zoneinfo
import os
import uuid
import asyncio
import resend

router = APIRouter(prefix="/api")

resend.api_key = os.environ.get('RESEND_API_KEY', '')
SENDER_EMAIL = os.environ.get('SENDER_EMAIL', 'onboarding@resend.dev')
TIJUANA = zoneinfo.ZoneInfo("America/Tijuana")

LEGACY_ID = "daily_production"
_VALID_PRESETS = ("today", "yesterday", "week", "month")
ALL_DAYS = [0, 1, 2, 3, 4, 5, 6]

COMMON_DEFAULTS = {
    "enabled": False,
    "hour": 19,            # Tijuana local time
    "minute": 0,
    "weekdays": ALL_DAYS,  # 0 = lunes … 6 = domingo
    "recipients": [],
    "last_sent_date": None,  # YYYY-MM-DD (Tijuana) del último envío automático
}

REPORT_TYPES = {
    "production_daily": {
        "schedule_id": LEGACY_ID,
        "name": "Reporte diario de producción",
        "defaults": {
            "preset": "today",     # rango del reporte
            "format": "excel",
            "subject": "Reporte Diario de Producción",
            "quotes_report": True,   # adjuntar el 2o reporte: quotes de Printavo pendientes de MOS
            "quotes_days": 30,       # ventana de quotes (creados en los últimos N días)
        },
    },
    "executive_production": {
        "schedule_id": "executive_production",
        "name": "Reporte ejecutivo de producción",
        "defaults": {
            "hour": 7, "minute": 15,   # después del cierre del turno de noche: "ayer" ya está completo
            "lang": "en",
            "subject": "Production Report",
        },
    },
}


CATALOG_IDS = [t["schedule_id"] for t in REPORT_TYPES.values()]


def _full(doc: dict) -> dict:
    rtype = doc.get("report_type") or "production_daily"
    meta = REPORT_TYPES.get(rtype, REPORT_TYPES["production_daily"])
    return {**COMMON_DEFAULTS, **meta["defaults"], **doc, "report_type": rtype, "name": meta["name"]}


_migrated = False


async def _ensure_catalog():
    """Un registro por tipo de reporte, con su schedule_id fijo. Adopta lo que
    ya exista (config única vieja; ejecutivo creado con la versión anterior)
    sin tocar destinatarios, horario ni estado; si no hay nada, lo crea APAGADO."""
    global _migrated
    if _migrated:
        return
    await db.report_schedules.update_many(
        {"config_id": LEGACY_ID, "schedule_id": {"$exists": False}},
        {"$set": {"schedule_id": LEGACY_ID, "report_type": "production_daily"}})
    for rtype, meta in REPORT_TYPES.items():
        sid = meta["schedule_id"]
        if await db.report_schedules.find_one({"schedule_id": sid}):
            continue
        older = await db.report_schedules.find_one(
            {"report_type": rtype, "schedule_id": {"$nin": CATALOG_IDS}}, sort=[("created_at", 1)])
        if older:
            await db.report_schedules.update_one({"_id": older["_id"]}, {"$set": {"schedule_id": sid}})
            await db.report_sends.update_many({"schedule_id": older.get("schedule_id")},
                                              {"$set": {"schedule_id": sid}})
        else:
            doc = {k: v for k, v in _full({"report_type": rtype}).items() if k != "name"}
            doc["schedule_id"] = sid
            if sid == LEGACY_ID:
                doc["config_id"] = LEGACY_ID
            await db.report_schedules.insert_one(doc)
    _migrated = True


async def _get(schedule_id: str) -> dict:
    await _ensure_catalog()
    doc = await db.report_schedules.find_one({"schedule_id": schedule_id}, {"_id": 0})
    if not doc:
        raise HTTPException(404, "Programación no encontrada")
    return _full(doc)


def _mos_url() -> str:
    try:
        from routers.auth import FRONTEND_URL
        return FRONTEND_URL
    except Exception:
        return ""


# ── Email ───────────────────────────────────────────────────────────────────
async def _send_report_email(recipients, subject, html, attachments):
    """attachments = [{filename, content_b64}, ...] — cero, uno o varios."""
    if not resend.api_key:
        raise RuntimeError("RESEND_API_KEY no configurado")
    params = {"from": SENDER_EMAIL, "to": recipients, "subject": subject, "html": html}
    if attachments:
        params["attachments"] = [{"filename": a["filename"], "content": a["content_b64"]} for a in attachments]
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


# ── Constructores por tipo: devuelven {subject, html, attachments} ──────────
async def _build_production_daily(cfg, report_date, intro, subject_suffix="", preview=False):
    attachments = []
    if not preview:
        result = await build_production_report(fmt=cfg.get("format", "excel"),
                                               preset=cfg.get("preset", "today"), filters={})
        attachments.append({"filename": result["filename"], "content_b64": result["data"]})
        # 2o reporte: quotes de Printavo (status Quote) que aún no están en MOS.
        # Si falla (WAF, token), NO tumba el reporte de producción.
        if cfg.get("quotes_report", True):
            try:
                from services.quotes_report import build_pending_quotes_report
                q = await build_pending_quotes_report(days=int(cfg.get("quotes_days", 30)))
                if q:
                    attachments.append({"filename": q["filename"], "content_b64": q["data"]})
            except Exception as e:
                logger.error(f"[report-scheduler] quotes report failed: {e}")
    n = len(attachments) or (2 if cfg.get("quotes_report", True) else 1)
    subject = f"{cfg.get('subject') or 'Reporte Diario de Producción'} — {report_date}{subject_suffix}"
    return {"subject": subject, "html": _report_html(report_date, intro, n_attach=n), "attachments": attachments}


async def _build_executive(cfg, report_date, intro, subject_suffix="", preview=False):
    from services import production_kpis, executive_report
    k = await production_kpis.build_executive()
    lang = cfg.get("lang", "en")
    return {"subject": executive_report.subject(k, lang, cfg.get("subject", "")) + subject_suffix,
            "html": executive_report.render(k, lang, _mos_url()), "attachments": [], "kpis": k}


BUILDERS = {"production_daily": _build_production_daily, "executive_production": _build_executive}


async def _generate_and_send(cfg, report_date, recipients, intro, subject_suffix="", trigger="auto", user=None):
    try:
        built = await BUILDERS[cfg["report_type"]](cfg, report_date, intro, subject_suffix)
        await _send_report_email(recipients, built["subject"], built["html"], built["attachments"])
    except Exception as e:
        await _log_send(cfg, recipients, trigger, None, str(e), user)
        raise
    await _log_send(cfg, recipients, trigger, built["subject"], None, user)
    logger.info(f"[report-scheduler] {cfg['schedule_id']}: sent {len(built['attachments'])} attachment(s) "
                f"for {report_date} to {recipients}")
    return built


async def _log_send(cfg, recipients, trigger, subject, error, user):
    try:
        await db.report_sends.insert_one({
            "send_id": f"rsend_{uuid.uuid4().hex[:12]}", "schedule_id": cfg.get("schedule_id"),
            "report_type": cfg.get("report_type"), "name": cfg.get("name"), "recipients": recipients,
            "trigger": trigger, "subject": subject, "ok": error is None, "error": error,
            "by": (user or {}).get("email"), "at": datetime.now(timezone.utc).isoformat()})
    except Exception as e:
        logger.error(f"[report-scheduler] no se pudo registrar el envío: {e}")


# ── Scheduler tick (cada 60s) ───────────────────────────────────────────────
def _due(cfg: dict, now: datetime) -> bool:
    """¿Toca mandar esta programación ahora? Se dispara una vez, en el primer
    tick dentro de la hora siguiente a la programada, en sus días."""
    if not cfg.get("enabled") or not [r for r in cfg.get("recipients", []) if r]:
        return False
    if now.weekday() not in (cfg.get("weekdays") or ALL_DAYS):
        return False
    if cfg.get("last_sent_date") == now.strftime("%Y-%m-%d"):
        return False
    scheduled = now.replace(hour=int(cfg.get("hour", 19)), minute=int(cfg.get("minute", 0)),
                            second=0, microsecond=0)
    return 0 <= (now - scheduled).total_seconds() <= 3600


async def _tick():
    try:
        await _ensure_catalog()
        now = datetime.now(TIJUANA)
        today = now.strftime("%Y-%m-%d")
        docs = [d async for d in db.report_schedules.find({"enabled": True, "schedule_id": {"$in": CATALOG_IDS}},
                                                          {"_id": 0})]
        for doc in docs:
            cfg = _full(doc)
            if not _due(cfg, now):
                continue
            # Claim atómico por (programación, día): devuelve el doc ANTERIOR, o None si ya lo tomó otro worker.
            claimed = await db.report_schedules.find_one_and_update(
                {"schedule_id": cfg["schedule_id"], "last_sent_date": {"$ne": today}},
                {"$set": {"last_sent_date": today}})
            if not claimed:
                continue
            recipients = [r for r in cfg.get("recipients", []) if r]
            try:
                await _generate_and_send(cfg, today, recipients, "Resumen automático de producción del día.")
            except Exception as e:
                logger.error(f"[report-scheduler] {cfg['schedule_id']} send failed, releasing claim to retry: {e}")
                await db.report_schedules.update_one(
                    {"schedule_id": cfg["schedule_id"], "last_sent_date": today},
                    {"$set": {"last_sent_date": claimed.get("last_sent_date")}})
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


# ── Validación ──────────────────────────────────────────────────────────────
def _sanitize(body: dict, rtype: str) -> dict:
    allowed = {}
    if "enabled" in body:
        allowed["enabled"] = bool(body["enabled"])
    if "hour" in body:
        allowed["hour"] = max(0, min(23, int(body["hour"])))
    if "minute" in body:
        allowed["minute"] = max(0, min(59, int(body["minute"])))
    if "weekdays" in body:
        days = sorted({int(d) for d in (body["weekdays"] or []) if str(d).lstrip("-").isdigit() and 0 <= int(d) <= 6})
        if not days:
            raise HTTPException(400, "Elige al menos un día de la semana")
        allowed["weekdays"] = days
    if "recipients" in body:
        allowed["recipients"] = list(dict.fromkeys(str(r).strip().lower() for r in body["recipients"] if str(r).strip()))
    if "subject" in body:
        allowed["subject"] = str(body["subject"])[:200]
    if rtype == "production_daily":
        if "preset" in body and body["preset"] in _VALID_PRESETS:
            allowed["preset"] = body["preset"]
        if "format" in body and body["format"] in ("excel", "pdf"):
            allowed["format"] = body["format"]
        if "quotes_report" in body:
            allowed["quotes_report"] = bool(body["quotes_report"])
        if "quotes_days" in body:
            allowed["quotes_days"] = max(1, min(365, int(body["quotes_days"])))
    if rtype == "executive_production" and body.get("lang") in ("en", "es"):
        allowed["lang"] = body["lang"]
    return allowed


async def _update(schedule_id: str, body: dict, user) -> dict:
    cfg = await _get(schedule_id)
    allowed = _sanitize(body, cfg["report_type"])
    await db.report_schedules.update_one({"schedule_id": schedule_id}, {"$set": allowed})
    await log_activity(user, "update_report_schedule", {"schedule_id": schedule_id, **allowed})
    return await _get(schedule_id)


async def _run_now(schedule_id: str, request: Request, user) -> dict:
    cfg = await _get(schedule_id)
    try:
        body = await request.json()
    except Exception:
        body = {}
    test_to = (body or {}).get("to") or request.query_params.get("to")
    recipients = [test_to] if test_to else [r for r in cfg.get("recipients", []) if r]
    if not recipients:
        raise HTTPException(400, "No hay destinatarios configurados")
    if not resend.api_key:
        raise HTTPException(500, "RESEND_API_KEY no configurado en el backend")
    report_date = datetime.now(TIJUANA).strftime("%Y-%m-%d")
    built = await _generate_and_send(cfg, report_date, recipients, "Envío manual del reporte de producción.",
                                     subject_suffix=" (manual)", trigger="test" if test_to else "manual", user=user)
    await log_activity(user, "run_report_now", {"schedule_id": schedule_id, "recipients": recipients})
    return {"status": "sent", "recipients": recipients,
            "filename": built["attachments"][0]["filename"] if built["attachments"] else None,
            "subject": built["subject"]}


# ── Endpoints ───────────────────────────────────────────────────────────────
@router.get("/report-schedules")
async def list_schedules(request: Request):
    await require_auth(request)
    await _ensure_catalog()
    by_id = {d["schedule_id"]: _full(d) async for d in
             db.report_schedules.find({"schedule_id": {"$in": CATALOG_IDS}}, {"_id": 0})}
    sends = [x async for x in db.report_sends.find({}, {"_id": 0}).sort("at", -1).limit(50)]
    return {"schedules": [by_id[i] for i in CATALOG_IDS if i in by_id], "sends": sends}


@router.put("/report-schedules/{schedule_id}")
async def update_schedule(schedule_id: str, request: Request):
    user = await require_admin(request)
    return await _update(schedule_id, await request.json(), user)


@router.post("/report-schedules/{schedule_id}/run-now")
async def run_schedule_now(schedule_id: str, request: Request):
    user = await require_admin(request)
    return await _run_now(schedule_id, request, user)


@router.get("/report-schedules/{schedule_id}/preview")
async def preview_schedule(schedule_id: str, request: Request):
    """Asunto + HTML tal como saldría, sin enviar (el diario no genera sus adjuntos)."""
    await require_admin(request)
    cfg = await _get(schedule_id)
    report_date = datetime.now(TIJUANA).strftime("%Y-%m-%d")
    built = await BUILDERS[cfg["report_type"]](cfg, report_date, "Vista previa.", preview=True)
    return {"subject": built["subject"], "html": built["html"], "kpis": built.get("kpis")}


# Compatibilidad: la pantalla y scripts viejos hablan de "la" programación.
@router.get("/report-schedule")
async def get_report_schedule(request: Request):
    await require_auth(request)
    return await _get(LEGACY_ID)


@router.put("/report-schedule")
async def update_report_schedule(request: Request):
    user = await require_admin(request)
    return await _update(LEGACY_ID, await request.json(), user)


@router.post("/report-schedule/run-now")
async def run_report_now(request: Request):
    """Generate and email the report immediately. `?to`/body.to overrides recipients
    for a test send. Does not touch the daily idempotency claim."""
    user = await require_admin(request)
    return await _run_now(LEGACY_ID, request, user)
