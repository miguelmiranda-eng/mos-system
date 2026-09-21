"""Gmail intake for the Printavo reverse engine: customer PO PDF arrives by
email -> parsed with the SAME deterministic parsers as the upload button ->
waits in a review inbox -> a human confirms and the quotes are created with
the SAME create_quotes_for() as today. Nothing here writes to Printavo on its
own.

How it finds mail
  The poller reads ONE mailbox (the MOS user who clicked "Conectar Gmail"),
  restricted to ONE Gmail label (the filter `to:gts@prosper-mfg.com` -> label
  lives in Gmail, not here). Search is `has:attachment filename:pdf newer_than:Nd`
  inside that label; everything else in the mailbox is never queried.

How it decides what is an order
  It never classifies the email. It classifies each PDF attachment: the parser
  returns styles -> it is a PO; zero styles -> it is not (packing list, art,
  invoice, printed email). No AI, ever (see memory: printavo-pdf-sin-ia).

Funnel (cheap -> expensive)
  1. sender domain allow-list (From + Reply-To; group rewrites From)
  2. parse every PDF attachment                     -> 0 styles = ignore
  3. SHA-256 of the PDF already seen                -> skip (replies re-attach)
     same PO#, different PDF                        -> flag new_version
  4. PO# already an order in MOS (customer_po/store_po) -> flag existing_order
  5. human: inbox in PO -> Quote Printavo (Crear / Descartar)

Trail left in Gmail (labels, so anyone can see what MOS did without MOS):
  MOS/Orden  MOS/Procesado  MOS/Ignorado   (set by MOS)
  MOS/Revisar                              (set by a human = force reprocess)

OAuth: same user-token pattern as gsheets.py / google_calendar.py
(`user_google_tokens`, include_granted_scopes, refresh in threadpool).
"""
import asyncio
import base64
import hashlib
import os
import re
import unicodedata
from datetime import datetime, timezone
from email.utils import parseaddr, parsedate_to_datetime

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import RedirectResponse
from starlette.concurrency import run_in_threadpool
from google_auth_oauthlib.flow import Flow
from googleapiclient.discovery import build
from google.oauth2.credentials import Credentials
from google.auth.transport.requests import Request as GoogleRequest

os.environ['OAUTHLIB_RELAX_TOKEN_SCOPE'] = '1'
from deps import db, require_auth, require_admin, log_activity, logger
import printavo_client
from routers.printavo_export import parse_po_bytes, create_quotes_for

router = APIRouter(prefix="/api/gmail-intake")

CLIENT_ID = os.environ.get("GOOGLE_CLIENT_ID", "").strip()
CLIENT_SECRET = os.environ.get("GOOGLE_CLIENT_SECRET", "").strip()

ENV = os.environ.get('ENV', 'local').lower()
IS_PROD = ENV == 'production'
if IS_PROD:
    REDIRECT_URI = "https://mosdatabase-backend.k9pirj.easypanel.host/api/gmail-intake/google/callback"
    FRONTEND_URL = "https://mosdatabase-frontend.k9pirj.easypanel.host"
else:
    REDIRECT_URI = os.environ.get("GMAIL_INTAKE_REDIRECT_URI", "http://localhost:8000/api/gmail-intake/google/callback")
    FRONTEND_URL = os.environ.get("FRONTEND_URL", "http://localhost:3000").rstrip('/')

# readonly to read; modify ONLY to add/remove the MOS/* labels (never delete,
# move, send). Both are needed: labels.modify is not covered by readonly.
SCOPES = [
    'https://www.googleapis.com/auth/gmail.readonly',
    'https://www.googleapis.com/auth/gmail.modify',
]
GMAIL_SCOPE = SCOPES[1]

CONFIG_ID = "gmail_intake"
DEFAULTS = {
    "config_id": CONFIG_ID,
    "enabled": False,
    "user_id": None,            # MOS user whose Google token the poller uses
    "email": None,              # that user's Gmail address (informative)
    "label_name": "ordenes de goodies",
    "allowed_domains": ["goodietwosleeves.com"],
    "poll_minutes": int(os.environ.get("GMAIL_INTAKE_POLL_MINUTES", "5")),
    "days_back": 7,             # newer_than:Nd — keeps the first run from eating history
    "max_messages": 50,         # per tick
    "last_run_at": None,
    "last_error": None,
    "auth_error": None,         # set when the token is dead -> UI shows "reconectar"
    "seen_count": 0,            # messages evaluated (cumulative)
    "order_count": 0,           # intake items created (cumulative)
}

LABEL_ORDEN = "MOS/Orden"
LABEL_PROCESADO = "MOS/Procesado"
LABEL_IGNORADO = "MOS/Ignorado"
LABEL_REVISAR = "MOS/Revisar"
MOS_LABELS = (LABEL_ORDEN, LABEL_PROCESADO, LABEL_IGNORADO, LABEL_REVISAR)

_run_lock = asyncio.Lock()
REASON_DOMAIN = "remitente fuera de la lista blanca"


# ── Config ───────────────────────────────────────────────────────────────────
async def _get_config() -> dict:
    cfg = await db.gmail_intake.find_one({"config_id": CONFIG_ID}, {"_id": 0})
    if not cfg:
        cfg = dict(DEFAULTS)
        await db.gmail_intake.insert_one(dict(cfg))
    return {**DEFAULTS, **cfg}


async def _set_config(update: dict):
    await db.gmail_intake.update_one({"config_id": CONFIG_ID}, {"$set": update}, upsert=True)


# ── OAuth (same pattern as gsheets.py) ───────────────────────────────────────
def _get_flow():
    if not CLIENT_ID or not CLIENT_SECRET:
        raise HTTPException(status_code=500, detail="Google API credentials not configured in .env")
    client_config = {
        "web": {
            "client_id": CLIENT_ID,
            "project_id": "mos-system-gmail-intake",
            "auth_uri": "https://accounts.google.com/o/oauth2/auth",
            "token_uri": "https://oauth2.googleapis.com/token",
            "auth_provider_x509_cert_url": "https://www.googleapis.com/oauth2/v1/certs",
            "client_secret": CLIENT_SECRET,
            "redirect_uris": [REDIRECT_URI],
        }
    }
    return Flow.from_client_config(client_config, scopes=SCOPES, redirect_uri=REDIRECT_URI)


@router.get("/auth-url")
async def auth_url(request: Request):
    """Consent URL. Only an admin can bind their mailbox to the intake."""
    user = await require_admin(request)
    flow = _get_flow()
    url, state = flow.authorization_url(
        access_type='offline',
        include_granted_scopes='true',   # keeps Calendar/Sheets grants
        prompt='consent',
    )
    await db.google_auth_states.insert_one({
        "user_id": user["user_id"],
        "state": state,
        "purpose": "gmail_intake",
        "created_at": datetime.now(timezone.utc).isoformat(),
    })
    return {"url": url}


@router.get("/google/callback")
async def callback(request: Request, code: str, state: str):
    state_doc = await db.google_auth_states.find_one({"state": state})
    if not state_doc:
        raise HTTPException(status_code=400, detail="Invalid auth state or session expired")
    user_id = state_doc["user_id"]

    flow = _get_flow()
    await run_in_threadpool(flow.fetch_token, code=code)
    creds = flow.credentials
    creds_data = {
        'token': creds.token,
        'refresh_token': creds.refresh_token,
        'token_uri': creds.token_uri,
        'client_id': creds.client_id,
        'client_secret': creds.client_secret,
        'scopes': creds.scopes,
        'expiry': creds.expiry.isoformat() if creds.expiry else None,
    }
    await db.user_google_tokens.update_one(
        {"user_id": user_id},
        {"$set": {"user_id": user_id, "credentials": creds_data,
                  "updated_at": datetime.now(timezone.utc).isoformat()}},
        upsert=True,
    )
    await db.google_auth_states.delete_one({"state": state})

    # Bind the intake to this mailbox and record which address it is.
    email = None
    try:
        svc = build('gmail', 'v1', credentials=creds)
        prof = await run_in_threadpool(lambda: svc.users().getProfile(userId='me').execute())
        email = prof.get("emailAddress")
    except Exception as e:
        logger.warning(f"[gmail-intake] getProfile failed after connect: {e}")
    await _set_config({"user_id": user_id, "email": email, "auth_error": None})
    return RedirectResponse(url=f"{FRONTEND_URL}/printavo-export?gmail_connected=true")


@router.post("/disconnect")
async def disconnect(request: Request):
    """Unbind the mailbox. Does NOT delete the user's Google token (Calendar/
    Sheets share it); the intake simply stops using it."""
    user = await require_admin(request)
    await _set_config({"user_id": None, "email": None, "enabled": False, "auth_error": None})
    await log_activity(user, "gmail_intake_disconnected")
    return {"status": "disconnected"}


async def _get_gmail_service(user_id: str):
    """Authenticated Gmail client for the bound user, or None (+ reason)."""
    token_doc = await db.user_google_tokens.find_one({"user_id": user_id})
    if not token_doc:
        return None, "sin token de Google para el usuario"
    creds_data = token_doc["credentials"]
    if GMAIL_SCOPE not in (creds_data.get("scopes") or []):
        return None, "el token no incluye el permiso de Gmail"

    expiry = None
    if creds_data.get('expiry'):
        try:
            expiry = datetime.fromisoformat(creds_data['expiry']).replace(tzinfo=None)
        except Exception:
            pass
    creds = Credentials(
        token=creds_data['token'],
        refresh_token=creds_data.get('refresh_token'),
        token_uri=creds_data['token_uri'],
        client_id=creds_data['client_id'],
        client_secret=creds_data['client_secret'],
        scopes=creds_data['scopes'],
        expiry=expiry,
    )
    try:
        if creds.expired and creds.refresh_token:
            await run_in_threadpool(creds.refresh, GoogleRequest())
            creds_data['token'] = creds.token
            creds_data['expiry'] = creds.expiry.isoformat() if creds.expiry else None
            await db.user_google_tokens.update_one(
                {"user_id": user_id},
                {"$set": {"credentials": creds_data,
                          "updated_at": datetime.now(timezone.utc).isoformat()}},
            )
        return build('gmail', 'v1', credentials=creds), None
    except Exception as e:
        # A revoked/expired refresh token lands here (password change, admin
        # revoke). Reported as auth_error so the UI says "reconectar".
        return None, f"no se pudo autenticar con Google: {str(e)[:200]}"


# ── Gmail helpers (sync; always called through run_in_threadpool) ────────────
def _label_map(svc) -> dict:
    """name -> id for every label in the mailbox."""
    res = svc.users().labels().list(userId='me').execute()
    return {l["name"]: l["id"] for l in res.get("labels", [])}


def _ensure_mos_labels(svc, labels: dict) -> dict:
    for name in MOS_LABELS:
        if name not in labels:
            created = svc.users().labels().create(userId='me', body={
                "name": name, "labelListVisibility": "labelShow", "messageListVisibility": "show",
            }).execute()
            labels[name] = created["id"]
    return labels


def _find_label_id(labels: dict, wanted: str):
    """Case/space/accent-insensitive match so 'ordenes de goodies' finds
    'Órdenes de Goodies'. Nested labels keep their 'Parent/Child' path."""
    def norm(x):
        x = unicodedata.normalize("NFKD", x or "")
        x = "".join(c for c in x if not unicodedata.combining(c))
        return re.sub(r"\s+", " ", x.strip().lower())
    for name, lid in labels.items():
        if norm(name) == norm(wanted):
            return lid
    return None


def _list_message_ids(svc, label_id: str, q: str, max_results: int) -> list:
    kwargs = {"userId": 'me', "labelIds": [label_id], "maxResults": max_results}
    if q:
        kwargs["q"] = q
    res = svc.users().messages().list(**kwargs).execute()
    return [m["id"] for m in res.get("messages", [])]


def _get_message(svc, msg_id: str) -> dict:
    return svc.users().messages().get(userId='me', id=msg_id, format='full').execute()


def _get_attachment(svc, msg_id: str, att_id: str) -> bytes:
    res = svc.users().messages().attachments().get(userId='me', messageId=msg_id, id=att_id).execute()
    return base64.urlsafe_b64decode(res["data"].encode("ascii"))


def _modify_labels(svc, msg_id: str, add: list, remove: list):
    body = {}
    if add:
        body["addLabelIds"] = add
    if remove:
        body["removeLabelIds"] = remove
    if body:
        svc.users().messages().modify(userId='me', id=msg_id, body=body).execute()


def _walk_parts(payload):
    """Yield every MIME part (depth-first)."""
    stack = [payload]
    while stack:
        p = stack.pop()
        yield p
        stack.extend(reversed(p.get("parts", []) or []))  # keep document order


def _headers(msg: dict) -> dict:
    return {h["name"].lower(): h["value"] for h in (msg.get("payload", {}).get("headers") or [])}


def _body_text(msg: dict, limit: int = 4000) -> str:
    """text/plain body (first part), decoded and truncated — shown next to the
    parsed styles as context, never parsed for data."""
    for p in _walk_parts(msg.get("payload", {})):
        if p.get("mimeType") == "text/plain" and p.get("body", {}).get("data"):
            try:
                txt = base64.urlsafe_b64decode(p["body"]["data"].encode("ascii")).decode("utf-8", "replace")
                return txt[:limit]
            except Exception:
                return ""
    return msg.get("snippet", "")[:limit]


def _pdf_parts(msg: dict) -> list:
    """[(filename, attachmentId, size)] for every PDF attachment."""
    out = []
    for p in _walk_parts(msg.get("payload", {})):
        fn = p.get("filename") or ""
        body = p.get("body", {}) or {}
        is_pdf = fn.lower().endswith(".pdf") or p.get("mimeType") == "application/pdf"
        if fn and is_pdf and body.get("attachmentId"):
            out.append((fn, body["attachmentId"], int(body.get("size") or 0)))
    return out


def _pdf_text_head(data: bytes, limit: int = 4000) -> str:
    import io
    import pdfplumber
    with pdfplumber.open(io.BytesIO(data)) as pdf:
        if not pdf.pages:
            return ""
        return (pdf.pages[0].extract_text() or "")[:limit]


def _sender_emails(h: dict) -> list:
    """Real senders: Reply-To first (the Google Group rewrites From to
    'X via GTS Client Support <gts@...>'), then From."""
    out = []
    for key in ("reply-to", "from"):
        for part in (h.get(key) or "").split(","):
            _, addr = parseaddr(part)
            if addr:
                out.append(addr.lower())
    return out


def _domain_allowed(emails: list, allowed: list) -> bool:
    if not allowed:
        return True
    allowed = [a.strip().lower().lstrip("@") for a in allowed if a and a.strip()]
    for e in emails:
        dom = e.split("@")[-1]
        if any(dom == a or dom.endswith("." + a) for a in allowed):
            return True
    return False


def _received_at(h: dict, msg: dict) -> str:
    try:
        return parsedate_to_datetime(h.get("date")).astimezone(timezone.utc).isoformat()
    except Exception:
        ms = int(msg.get("internalDate") or 0)
        return datetime.fromtimestamp(ms / 1000, tz=timezone.utc).isoformat() if ms else None


# ── One pass ─────────────────────────────────────────────────────────────────
async def _existing_order_for(po_number: str, store_po: str):
    """Order in MOS already carrying this PO (layer 4). Returns order_number or None."""
    ors = []
    if po_number:
        ors += [{"customer_po": po_number}, {"store_po": po_number}]
    if store_po:
        ors += [{"customer_po": store_po}, {"store_po": store_po}]
    if not ors:
        return None
    doc = await db.orders.find_one({"$or": ors}, {"_id": 0, "order_number": 1})
    return (doc or {}).get("order_number")


async def _process_message(svc, cfg: dict, labels: dict, msg_id: str, forced: bool) -> dict:
    """Evaluate one message. Returns {'orders': n, 'ignored': bool, 'skipped': bool}."""
    seen = await db.gmail_intake_messages.find_one({"message_id": msg_id})
    if seen and not forced:
        return {"skipped": True}

    msg = await run_in_threadpool(_get_message, svc, msg_id)
    h = _headers(msg)
    senders = _sender_emails(h)
    subject = h.get("subject") or "(sin asunto)"
    thread_id = msg.get("threadId")
    now = datetime.now(timezone.utc).isoformat()

    reason = None
    created = 0
    duplicates = 0
    if not _domain_allowed(senders, cfg.get("allowed_domains") or []):
        reason = REASON_DOMAIN
    else:
        pdfs = _pdf_parts(msg)
        if not pdfs:
            reason = "sin PDF adjunto"
        body_text = _body_text(msg) if pdfs else ""
        for fn, att_id, size in pdfs:
            try:
                data = await run_in_threadpool(_get_attachment, svc, msg_id, att_id)
            except Exception as e:
                logger.error(f"[gmail-intake] attachment {fn} of {msg_id}: {e}")
                continue
            sha = hashlib.sha256(data).hexdigest()
            # Layer 3: same PDF already in the inbox (reply re-attached it).
            if await db.printavo_intake.find_one({"pdf_sha256": sha}, {"_id": 1}):
                duplicates += 1
                continue
            try:
                records, engine = await run_in_threadpool(parse_po_bytes, data)
            except Exception as e:
                logger.warning(f"[gmail-intake] parse failed {fn}: {e}")
                records, engine = [], "error"
            if not records:
                continue  # Layer 2: not a PO
            po_number = next((r.get("po_number") for r in records if r.get("po_number")), None)
            # First-page text (what the regexes actually see) travels with the item
            # so an unrecognized store can be diagnosed without asking for the file.
            try:
                text_head = await run_in_threadpool(_pdf_text_head, data)
            except Exception:
                text_head = None
            store_po = next((r.get("store_po") for r in records if r.get("store_po")), None)
            flags = []
            if po_number and await db.printavo_intake.find_one(
                    {"po_number": po_number, "pdf_sha256": {"$ne": sha}}, {"_id": 1}):
                flags.append("new_version")
            existing = await _existing_order_for(po_number, store_po)
            if existing:
                flags.append("existing_order")
            # Parser-level flags (store not recognized, store PO missing) bubble up
            # so the inbox row warns before anyone opens the item.
            for f in ("retailer_missing", "store_po_missing", "po_missing"):
                if any(f in (r.get("flags") or []) for r in records):
                    flags.append(f)
            item = {
                "item_id": hashlib.sha1(f"{msg_id}:{sha}".encode()).hexdigest()[:16],
                "status": "pendiente",
                "flags": flags,
                "existing_order": existing,
                "po_number": po_number,
                "store_po": store_po,
                "engine": engine,
                "styles": records,
                "style_count": len(records),
                "qty_total": sum(int(r.get("qty") or 0) for r in records),
                "pdf_filename": fn,
                "pdf_size": size or len(data),
                "pdf_sha256": sha,
                "gmail_message_id": msg_id,
                "gmail_thread_id": thread_id,
                "gmail_link": f"https://mail.google.com/mail/u/0/#all/{thread_id}" if thread_id else None,
                "subject": subject,
                "from_email": senders[0] if senders else None,
                "from_name": parseaddr(h.get("reply-to") or h.get("from") or "")[0] or None,
                "received_at": _received_at(h, msg),
                "body_text": body_text,
                "pdf_text_head": text_head,
                "created_at": now,
                "created_quotes": None,
                "resolved_at": None,
                "resolved_by": None,
            }
            await db.printavo_intake.insert_one(item)
            created += 1
        if created == 0 and reason is None:
            reason = ("PDF ya visto (re-adjuntado en el hilo)" if duplicates
                      else "ningún PDF adjunto es una orden reconocida")

    # Trail in Gmail + seen record. Label failures must not lose the DB state.
    add = [labels[LABEL_PROCESADO], labels[LABEL_ORDEN] if created else labels[LABEL_IGNORADO]]
    remove = [labels[LABEL_REVISAR]] if forced else []
    try:
        await run_in_threadpool(_modify_labels, svc, msg_id, add, remove)
    except Exception as e:
        logger.warning(f"[gmail-intake] label update failed for {msg_id}: {e}")
    await db.gmail_intake_messages.update_one(
        {"message_id": msg_id},
        {"$set": {"message_id": msg_id, "thread_id": thread_id, "subject": subject,
                  "from_email": senders[0] if senders else None, "orders": created,
                  "reason": reason, "evaluated_at": now, "forced": forced}},
        upsert=True,
    )
    return {"orders": created, "ignored": created == 0}


async def run_once(cfg: dict) -> dict:
    """One intake pass. Raises on auth/config problems (caller records them)."""
    if not cfg.get("user_id"):
        raise RuntimeError("no hay buzón conectado")
    svc, err = await _get_gmail_service(cfg["user_id"])
    if not svc:
        raise PermissionError(err)

    labels = await run_in_threadpool(_label_map, svc)
    src_id = _find_label_id(labels, cfg.get("label_name") or "")
    if not src_id:
        raise RuntimeError(f"la etiqueta '{cfg.get('label_name')}' no existe en el buzón")
    labels = await run_in_threadpool(_ensure_mos_labels, svc, labels)

    days = max(1, int(cfg.get("days_back") or 7))
    limit = max(1, min(200, int(cfg.get("max_messages") or 50)))
    q = f"has:attachment filename:pdf newer_than:{days}d"
    normal_ids = await run_in_threadpool(_list_message_ids, svc, src_id, q, limit)
    forced_ids = await run_in_threadpool(_list_message_ids, svc, labels[LABEL_REVISAR], "", limit)

    summary = {"evaluated": 0, "orders": 0, "ignored": 0, "skipped": 0, "forced": len(forced_ids)}
    for msg_id in forced_ids:
        r = await _process_message(svc, cfg, labels, msg_id, forced=True)
        summary["evaluated"] += 1
        summary["orders"] += r.get("orders", 0)
        summary["ignored"] += 1 if r.get("ignored") else 0
    for msg_id in normal_ids:
        if msg_id in forced_ids:
            continue
        r = await _process_message(svc, cfg, labels, msg_id, forced=False)
        if r.get("skipped"):
            summary["skipped"] += 1
            continue
        summary["evaluated"] += 1
        summary["orders"] += r.get("orders", 0)
        summary["ignored"] += 1 if r.get("ignored") else 0
    return summary


async def _run_guarded() -> dict:
    async with _run_lock:
        cfg = await _get_config()
        now = datetime.now(timezone.utc).isoformat()
        try:
            res = await run_once(cfg)
            await _set_config({
                "last_run_at": now, "last_error": None, "auth_error": None,
                "seen_count": int(cfg.get("seen_count") or 0) + res["evaluated"],
                "order_count": int(cfg.get("order_count") or 0) + res["orders"],
            })
            return res
        except PermissionError as e:
            await _set_config({"last_run_at": now, "auth_error": str(e)[:300], "last_error": str(e)[:300]})
            raise
        except Exception as e:
            await _set_config({"last_run_at": now, "last_error": str(e)[:500]})
            raise


# ── Scheduler ────────────────────────────────────────────────────────────────
async def _tick():
    try:
        cfg = await db.gmail_intake.find_one({"config_id": CONFIG_ID}, {"_id": 0})
        if not cfg or not cfg.get("enabled") or not cfg.get("user_id"):
            return
        if _run_lock.locked():
            logger.info("[gmail-intake] tick skipped — a pass is already running")
            return
        res = await _run_guarded()
        if res.get("orders"):
            logger.info(f"[gmail-intake] {res['orders']} orden(es) nueva(s) en la bandeja")
    except Exception as e:
        logger.error(f"[gmail-intake] tick error: {e}")


_scheduler = None


def start_gmail_intake_scheduler():
    global _scheduler
    if _scheduler is not None:
        return
    try:
        from apscheduler.schedulers.asyncio import AsyncIOScheduler
        from apscheduler.triggers.interval import IntervalTrigger
        minutes = int(os.environ.get("GMAIL_INTAKE_POLL_MINUTES", "5"))
        _scheduler = AsyncIOScheduler(timezone="America/Tijuana")
        _scheduler.add_job(_tick, IntervalTrigger(minutes=max(1, minutes)), id="gmail_intake_tick",
                           replace_existing=True, max_instances=1, coalesce=True)
        _scheduler.start()
        logger.info(f"[gmail-intake] started (checks every {minutes} min)")
    except Exception as e:
        logger.error(f"[gmail-intake] not started ({e}).")


# ── Endpoints ────────────────────────────────────────────────────────────────
@router.get("/status")
async def status(request: Request):
    await require_auth(request)
    cfg = await _get_config()
    cfg["google_configured"] = bool(CLIENT_ID and CLIENT_SECRET)
    cfg["printavo_configured"] = printavo_client.is_configured()
    cfg["connected"] = bool(cfg.get("user_id"))
    cfg["pending"] = await db.printavo_intake.count_documents({"status": "pendiente"})
    return cfg


@router.put("/config")
async def update_config(request: Request):
    user = await require_admin(request)
    body = await request.json()
    allowed = {}
    if "enabled" in body:
        allowed["enabled"] = bool(body["enabled"])
    if "label_name" in body:
        allowed["label_name"] = str(body["label_name"]).strip() or DEFAULTS["label_name"]
    if "allowed_domains" in body:
        doms = body["allowed_domains"]
        if isinstance(doms, str):
            doms = re.split(r"[,\s;]+", doms)
        allowed["allowed_domains"] = sorted({d.strip().lower().lstrip("@") for d in doms if d and d.strip()})
    if "days_back" in body:
        allowed["days_back"] = max(1, min(60, int(body["days_back"])))
    if "poll_minutes" in body:
        allowed["poll_minutes"] = max(1, min(1440, int(body["poll_minutes"])))
    if not allowed:
        raise HTTPException(400, "Nada que actualizar")
    await _set_config(allowed)
    # Widening the allow-list must reach the mail already rejected by it:
    # forget those evaluations so the next pass looks at them again (their
    # MOS/* labels get rewritten with the new verdict).
    if "allowed_domains" in allowed:
        res = await db.gmail_intake_messages.delete_many({"reason": REASON_DOMAIN})
        if res.deleted_count:
            logger.info(f"[gmail-intake] {res.deleted_count} correo(s) se reevaluarán tras cambiar dominios")
    await log_activity(user, "gmail_intake_config", allowed)
    return await _get_config()


@router.post("/run-now")
async def run_now(request: Request):
    user = await require_admin(request)
    if _run_lock.locked():
        raise HTTPException(409, "Ya hay una pasada en curso")
    try:
        res = await _run_guarded()
    except Exception as e:
        raise HTTPException(400, str(e)[:300])
    await log_activity(user, "gmail_intake_run_now", res)
    return res


@router.get("/items")
async def list_items(request: Request, status: str = "pendiente", limit: int = 100):
    await require_auth(request)
    q = {} if status == "all" else {"status": status}
    cur = db.printavo_intake.find(q, {"_id": 0, "body_text": 0, "pdf_text_head": 0}).sort("received_at", -1).limit(max(1, min(500, limit)))
    return {"items": await cur.to_list(length=None)}


@router.get("/items/{item_id}")
async def get_item(request: Request, item_id: str):
    await require_auth(request)
    doc = await db.printavo_intake.find_one({"item_id": item_id}, {"_id": 0})
    if not doc:
        raise HTTPException(404, "No existe")
    return doc


@router.post("/items/{item_id}/discard")
async def discard_item(request: Request, item_id: str):
    user = await require_admin(request)
    now = datetime.now(timezone.utc).isoformat()
    res = await db.printavo_intake.update_one(
        {"item_id": item_id, "status": "pendiente"},
        {"$set": {"status": "descartado", "resolved_at": now, "resolved_by": user.get("email")}})
    if not res.matched_count:
        raise HTTPException(404, "No existe o ya fue resuelto")
    await log_activity(user, "gmail_intake_discard", {"item_id": item_id})
    return {"status": "descartado"}


@router.post("/items/{item_id}/restore")
async def restore_item(request: Request, item_id: str):
    user = await require_admin(request)
    res = await db.printavo_intake.update_one(
        {"item_id": item_id, "status": "descartado"},
        {"$set": {"status": "pendiente", "resolved_at": None, "resolved_by": None}})
    if not res.matched_count:
        raise HTTPException(404, "No existe o no está descartado")
    await log_activity(user, "gmail_intake_restore", {"item_id": item_id})
    return {"status": "pendiente"}


@router.post("/items/{item_id}/create")
async def create_from_item(request: Request, item_id: str):
    """Same as POST /printavo-export/create, but bound to an inbox item: the
    reviewed styles come from the UI (edited), and the item is marked created
    with the resulting quote numbers. Only pending items can be confirmed."""
    user = await require_admin(request)
    if not printavo_client.is_configured():
        raise HTTPException(400, "Credenciales de Printavo no configuradas")
    body = await request.json()
    contact_id = (body.get("contact_id") or "").strip()
    styles = body.get("styles") or []
    if not contact_id:
        raise HTTPException(400, "Falta el contacto/cliente de Printavo")
    if not styles:
        raise HTTPException(400, "No hay estilos para crear")
    item = await db.printavo_intake.find_one({"item_id": item_id})
    if not item:
        raise HTTPException(404, "No existe")
    if item.get("status") != "pendiente":
        raise HTTPException(409, f"El elemento ya está '{item.get('status')}'")

    result = await create_quotes_for(user, contact_id, styles)
    if result.get("created"):
        await db.printavo_intake.update_one({"item_id": item_id}, {"$set": {
            "status": "creado",
            "resolved_at": datetime.now(timezone.utc).isoformat(),
            "resolved_by": user.get("email"),
            "contact_id": contact_id,
            "created_quotes": [x for x in result.get("results", []) if x.get("ok")],
        }})
    return result
