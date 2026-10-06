"""Gmail intake for the Printavo reverse engine: customer PO PDF arrives by
email -> parsed with the SAME deterministic parsers as the upload button ->
if the PO is CLEAN and auto-create is on, the quotes are created right away
with the SAME create_quotes_for() as the button (fixed Printavo contact) ->
anything not clean waits in the inbox as an exception for a human.

"Clean" (see _auto_block_reason): store + PO# recognized, sizes add up, PDF not
seen before, PO# not already created/known, not a revision of a created PO.
Store PO may be missing only for TRACTOR SUPPLY (their nickname carries N/A).

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
from routers.printavo_export import parse_po_bytes, create_quotes_for, plantillas_activas

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
    "auto_create": False,       # create quotes in Printavo without a click (clean POs only)
    "auto_contact_id": None,    # fixed Printavo contact for auto-created quotes
    "auto_contact_name": None,
    "auto_created_count": 0,
    "last_auto_error": None,
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
LABEL_QUOTE = "MOS/Quote creada"
MOS_LABELS = (LABEL_ORDEN, LABEL_PROCESADO, LABEL_IGNORADO, LABEL_REVISAR, LABEL_QUOTE)

_run_lock = asyncio.Lock()
REASON_DOMAIN = "remitente fuera de la lista blanca"


# ── Config ───────────────────────────────────────────────────────────────────
async def _get_config() -> dict:
    cfg = await db.gmail_intake.find_one({"config_id": CONFIG_ID}, {"_id": 0})
    if not cfg:
        cfg = dict(DEFAULTS)
        await db.gmail_intake.insert_one(dict(cfg))
    return {**DEFAULTS, **cfg}


def fuentes_de(cfg: dict) -> list:
    """Las fuentes que el poller va a recorrer, una por cliente.

    ADAPTADOR DE LECTURA, no migracion: mientras `fuentes` no exista en el
    documento, se arma UNA fuente con los campos sueltos de siempre
    (label_name / allowed_domains / auto_contact_*). Asi el intake de Goodie
    sigue corriendo exactamente igual y el cambio es reversible borrando la
    lista. En cuanto alguien da de alta un segundo cliente, manda la lista.

    Cada fuente trae lo que distingue a un cliente: su etiqueta de Gmail, de que
    dominios acepta correo, y a que contacto de Printavo se le crean las quotes.
    Lo que es del BUZON (que cuenta, cada cuanto, cuantos dias atras) sigue
    siendo global: es un solo buzon para todos."""
    lista = cfg.get("fuentes")
    if isinstance(lista, list) and lista:
        return [f for f in lista if f.get("activa", True)]
    return [{
        "id": "principal",
        "nombre": cfg.get("nombre_cliente") or "Principal",
        "label_name": cfg.get("label_name"),
        "allowed_domains": cfg.get("allowed_domains") or [],
        "auto_create": bool(cfg.get("auto_create")),
        "auto_contact_id": cfg.get("auto_contact_id"),
        "auto_contact_name": cfg.get("auto_contact_name"),
        "activa": True,
    }]


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
    # `?fuente=<id>` = boton "Conectar con Gmail" de UN cliente: el buzon de
    # quien de clic queda como el de ese cliente. Sin el parametro, es la
    # conexion general de siempre (la que usan los clientes sin buzon propio).
    fuente_id = (request.query_params.get("fuente") or "").strip() or None
    if fuente_id and fuente_id not in {f.get("id") for f in _todas_las_fuentes(await _get_config())}:
        raise HTTPException(400, "Guarda el cliente antes de conectar su Gmail")
    flow = _get_flow()
    url, state = flow.authorization_url(
        access_type='offline',
        # El buzon de un cliente pide SOLO Gmail; la conexion general conserva
        # los permisos de Calendar/Sheets del usuario porque comparte su token.
        include_granted_scopes='false' if fuente_id else 'true',
        prompt='consent select_account' if fuente_id else 'consent',
    )
    await db.google_auth_states.insert_one({
        "user_id": user["user_id"],
        "user_email": user.get("email"),
        "user_name": user.get("name"),
        "state": state,
        "purpose": "gmail_intake",
        "fuente_id": fuente_id,
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
    fuente_id = state_doc.get("fuente_id")
    if fuente_id:
        # Buzon de UN cliente: se guarda aparte y no toca el token personal
        # (Calendar/Sheets) de quien conecto.
        email = None
        try:
            svc = build('gmail', 'v1', credentials=creds)
            prof = await run_in_threadpool(lambda: svc.users().getProfile(userId='me').execute())
            email = prof.get("emailAddress")
        except Exception as e:
            logger.warning(f"[gmail-intake] getProfile failed after connect ({fuente_id}): {e}")
        await db.gmail_intake_buzones.update_one(
            {"fuente_id": fuente_id},
            {"$set": {"fuente_id": fuente_id, "email": email, "credentials": creds_data,
                      "auth_error": None,
                      "connected_by": {"user_id": user_id, "email": state_doc.get("user_email"),
                                       "name": state_doc.get("user_name")},
                      "connected_at": datetime.now(timezone.utc).isoformat()}},
            upsert=True,
        )
        await db.google_auth_states.delete_one({"state": state})
        await log_activity({"user_id": user_id, "email": state_doc.get("user_email"),
                            "name": state_doc.get("user_name")},
                           "gmail_intake_buzon_conectado", {"fuente_id": fuente_id, "buzon": email})
        return RedirectResponse(url=f"{FRONTEND_URL}/printavo-export?gmail_connected={fuente_id}")

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


@router.post("/fuentes/{fuente_id}/disconnect")
async def disconnect_buzon(request: Request, fuente_id: str):
    """Quita el buzon propio de un cliente. El cliente vuelve a leerse del buzon
    general (si hay uno conectado)."""
    user = await require_admin(request)
    res = await db.gmail_intake_buzones.delete_one({"fuente_id": fuente_id})
    if not res.deleted_count:
        raise HTTPException(404, "Ese cliente no tiene buzón propio")
    await log_activity(user, "gmail_intake_buzon_desconectado", {"fuente_id": fuente_id})
    return {"status": "disconnected"}


async def _get_gmail_service(user_id: str):
    """Authenticated Gmail client for the bound user, or None (+ reason)."""
    token_doc = await db.user_google_tokens.find_one({"user_id": user_id})
    if not token_doc:
        return None, "sin token de Google para el usuario"

    async def guardar(creds_data):
        await db.user_google_tokens.update_one(
            {"user_id": user_id},
            {"$set": {"credentials": creds_data,
                      "updated_at": datetime.now(timezone.utc).isoformat()}},
        )
    return await _svc_desde_creds(token_doc["credentials"], guardar)


async def _get_buzon_service(fuente_id: str):
    """Gmail del buzon conectado PARA ESE CLIENTE (boton "Conectar con Gmail"
    del cliente), o (None, None) si el cliente no tiene buzon propio.

    El token vive en `gmail_intake_buzones`, NO en user_google_tokens: ahi esta
    el Calendar/Sheets de quien conecta, y conectar el buzon de un cliente con
    otra cuenta de Google le cambiaba esas integraciones sin avisar."""
    doc = await db.gmail_intake_buzones.find_one({"fuente_id": fuente_id})
    if not doc:
        return None, None

    async def guardar(creds_data):
        await db.gmail_intake_buzones.update_one(
            {"fuente_id": fuente_id}, {"$set": {"credentials": creds_data}})
    svc, err = await _svc_desde_creds(doc["credentials"], guardar)
    await db.gmail_intake_buzones.update_one(
        {"fuente_id": fuente_id}, {"$set": {"auth_error": err}})
    return svc, err


async def _servicio_para(cfg: dict, fuente: dict):
    """El buzon que le toca a un cliente: el suyo si lo conectaron con su boton,
    si no el general. Devuelve (svc, usuario, error, clave, es_general).

    `clave` identifica el buzon (para abrirlo una vez por pasada) y `usuario` es
    a nombre de quien se crean sus quotes: quien conecto ese buzon, o None para
    usar el del buzon general como siempre. Misma regla para la pasada y para
    "releer" un item: si no, un item de Spektrum se releeria en el buzon de
    Goodie, donde ese correo no existe."""
    fid = fuente.get("id")
    propio = await db.gmail_intake_buzones.find_one(
        {"fuente_id": fid}, {"_id": 0, "connected_by": 1, "email": 1})
    if propio:
        svc, err = await _get_buzon_service(fid)
        if err:
            err = f"buzón {propio.get('email') or ''}: {err}"
        return svc, propio.get("connected_by"), err, f"f:{fid}", False
    if not cfg.get("user_id"):
        return None, None, "sin buzón: conecta el Gmail de este cliente", "general", True
    svc, err = await _get_gmail_service(cfg["user_id"])
    return svc, None, err, "general", True


def _todas_las_fuentes(cfg: dict) -> list:
    """Como fuentes_de pero CON las inactivas (para la pantalla y para conectar)."""
    lista = cfg.get("fuentes")
    return lista if isinstance(lista, list) and lista else fuentes_de(cfg)


async def _svc_desde_creds(creds_data: dict, guardar):
    """Arma el cliente de Gmail y refresca el token si vencio (`guardar` persiste
    el refrescado donde corresponda). Devuelve (svc, None) o (None, motivo)."""
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
            await guardar(creds_data)
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


def _list_message_ids(svc, label_id, q: str, max_results: int) -> list:
    """`label_id` puede ser una etiqueta o una lista: Gmail las combina con AND.
    Con varias se piden los correos que tienen TODAS — asi se separa el
    "MOS/Revisar" de un cliente del de otro."""
    ids = label_id if isinstance(label_id, (list, tuple)) else [label_id]
    kwargs = {"userId": 'me', "labelIds": list(ids), "maxResults": max_results}
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
async def _existing_order_for(po_number: str, store_po: str = None):
    """Order in MOS already carrying this Goodie PO# (layer 4). Returns
    order_number or None. Matches customer_po ONLY: the store PO is shared
    between sibling POs (Meijer 23036/23038 both carry 219888217), so matching
    it flagged POs that were not in MOS."""
    if not po_number:
        return None
    doc = await db.orders.find_one({"customer_po": po_number}, {"_id": 0, "order_number": 1})
    return (doc or {}).get("order_number")


# `totales_no_cuadran`: el PDF trae totales de pagina que no cuadran con sus
# renglones (CK formato tabla). Sube al item y bloquea el auto-crear.
PARSER_FLAGS = ("retailer_missing", "store_po_missing", "po_missing", "totales_no_cuadran")


def _marcar_creados(styles: list, results: list) -> list:
    """Anota `ya_creado` en los estilos cuya quote SI se creo (los resultados
    vienen en el mismo orden que los estilos). Si de 27 truena la 16, el item se
    queda pendiente; sin esta marca quien lo termine a mano volveria a crear las
    15 que ya estaban en Printavo."""
    out = []
    for r, res in zip(styles, list(results) + [None] * (len(styles) - len(results))):
        r = dict(r)
        if res and res.get("ok"):
            r["ya_creado"] = True
            r["quote_visual_id"] = res.get("visual_id")
        out.append(r)
    return out


async def _marcar_existentes(records: list, store_po=None):
    """Revisa CADA PO del PDF contra MOS y contra lo ya creado por el intake.

    Devuelve (pos, existentes {po: orden}, creados {po}) y anota en cada estilo
    `ya_en_mos` / `ya_creado`: al revisarlo a mano esos vienen desmarcados, y
    crear el resto no duplica nada. Goodie trae un PO por PDF (ahi nada cambia);
    Spektrum manda hojas con 27, y revisar solo el primero dejaba pasar
    duplicados del resto."""
    pos = list(dict.fromkeys(r.get("po_number") for r in records if r.get("po_number")))
    existentes = {}
    for p in pos:
        o = await _existing_order_for(p, store_po)
        if o:
            existentes[p] = o
    creados = set()
    if pos:
        async for it in db.printavo_intake.find(
                {"status": "creado", "$or": [{"po_numbers": {"$in": pos}}, {"po_number": {"$in": pos}}]},
                {"_id": 0, "po_numbers": 1, "po_number": 1}):
            creados |= set(it.get("po_numbers") or [it.get("po_number")]) & set(pos)
    for r in records:
        r["ya_en_mos"] = existentes.get(r.get("po_number"))
        r["ya_creado"] = r.get("po_number") in creados
    return pos, existentes, creados


def _plan_auto(item: dict):
    """Que estilos se pueden crear solos. Devuelve (indices, motivo, esperan).

    Un PDF de UN solo PO (Goodie) es todo o nada, como siempre: si algo no esta
    limpio, espera entero (`motivo`). Una HOJA con varios PO (Spektrum) son
    ordenes independientes: se crean las limpias y las que tienen problema
    esperan en la bandeja (`esperan` = {po: motivo}). Sin esto, un solo PO que no
    cuadra (en los PDFs reales pasa: 2174838 trae 1,200 vs 1,201; 2151359 y
    2151360, 250 vs 251) bloqueaba la hoja entera y el auto-crear nunca corria."""
    styles = item.get("styles") or []
    pos = item.get("po_numbers") or list(dict.fromkeys(
        r.get("po_number") for r in styles if r.get("po_number")))
    if len(pos) <= 1:
        why = _auto_block_reason(item)
        return ([] if why else list(range(len(styles)))), why, {}
    flags = set(item.get("flags") or [])
    # Lo que es del PDF entero sigue frenando todo.
    for f, m in (("retailer_missing", "tienda no detectada"), ("po_missing", "PO# no detectado"),
                 ("new_version", "revisión de un PO ya visto")):
        if f in flags:
            return [], m, {}
    idx, esperan = [], {}
    for i, r in enumerate(styles):
        po = r.get("po_number")
        if r.get("ya_creado"):
            continue                                  # ya esta en Printavo: ni crear ni esperar
        if r.get("ya_en_mos"):
            continue                                  # ya es orden en MOS
        if "totales_no_cuadran" in (r.get("flags") or []):
            esperan[po] = "los totales del PDF no cuadran"
        elif not r.get("sizes_match", True):
            esperan[po] = f"tallas ≠ cantidad ({r.get('qty_from_sizes')} vs {r.get('qty')})"
        elif not (r.get("brand") or "").strip():
            esperan[po] = "tienda no detectada"
        else:
            idx.append(i)
    why = None if idx else ("; ".join(f"PO {p}: {m}" for p, m in esperan.items())
                            or "todos sus PO ya existen o ya se crearon")
    return idx, why, esperan


def _auto_block_reason(item: dict):
    """Why an item must wait for a human instead of being auto-created. None = clean."""
    flags = set(item.get("flags") or [])
    records = item.get("styles") or []
    if not records:
        return "sin estilos"
    if "retailer_missing" in flags:
        return "tienda no detectada"
    if "po_missing" in flags:
        return "PO# no detectado"
    if "new_version" in flags:
        return "revisión de un PO ya visto"
    if "existing_order" in flags:
        return f"ya existe la orden {item.get('existing_order')} en MOS"
    if "already_created" in flags:
        return "ya se creó una quote para este PO#"
    if "totales_no_cuadran" in flags or any("totales_no_cuadran" in (r.get("flags") or []) for r in records):
        return "los totales del PDF no cuadran con sus renglones"
    brands = {(r.get("brand") or "").upper() for r in records}
    if "store_po_missing" in flags and not all("TRACTOR" in b for b in brands):
        return "PO de tienda no detectado"
    if any(not r.get("sizes_match", True) for r in records):
        return "tallas ≠ cantidad"
    return None


async def _bound_user(cfg: dict) -> dict:
    u = await db.users.find_one({"user_id": cfg.get("user_id")}, {"_id": 0, "user_id": 1, "email": 1, "name": 1})
    return u or {"user_id": cfg.get("user_id"), "email": cfg.get("email"), "name": "Gmail intake"}


async def _maybe_auto_create(cfg: dict, fuente: dict, item: dict) -> bool:
    """Create the quotes for a clean item with the fixed contact. Returns True
    when the item ended up 'creado'. Never raises: a failure is recorded on the
    item (auto_error) and on the config (last_auto_error) and the item stays
    pending for a human.

    El contacto sale de LA FUENTE: cada cliente factura al suyo. Un cliente puede
    tener auto-crear encendido y otro apagado."""
    if not fuente.get("auto_create") or not fuente.get("auto_contact_id"):
        return False
    if not printavo_client.is_configured():
        return False
    idx, why, esperan = _plan_auto(item)
    if not idx:
        await db.printavo_intake.update_one({"item_id": item["item_id"]}, {"$set": {"auto_skipped": why}})
        return False
    user = fuente.get("_usuario") or await _bound_user(cfg)
    elegidos = [item["styles"][i] for i in idx]
    try:
        result = await create_quotes_for(user, fuente["auto_contact_id"], elegidos)
    except Exception as e:
        err = str(e)[:300]
        logger.error(f"[gmail-intake] auto-create failed for PO {item.get('po_number')}: {err}")
        await db.printavo_intake.update_one({"item_id": item["item_id"]}, {"$set": {"auto_error": err}})
        await _set_config({"last_auto_error": f"PO {item.get('po_number')}: {err}"})
        return False
    ok = [x for x in result.get("results", []) if x.get("ok")]
    failed = [x for x in result.get("results", []) if not x.get("ok")]
    # Los resultados vienen en el orden de `elegidos`; se regresan a su lugar en
    # la lista completa para marcar justo esos estilos.
    por_estilo = [None] * len(item["styles"])
    for i, res in zip(idx, result.get("results", [])):
        por_estilo[i] = res
    styles = _marcar_creados(item["styles"], por_estilo)
    upd = {"created_quotes": ok, "contact_id": fuente["auto_contact_id"], "auto": True, "styles": styles}
    if failed:
        # Partial or total failure: stays pending, with the errors visible.
        upd["auto_error"] = "; ".join(f"{x.get('design_num')}: {x.get('error')}" for x in failed)[:500]
        await _set_config({"last_auto_error": f"PO {item.get('po_number')}: {upd['auto_error']}"})
    if esperan:
        # Hoja con varios PO: se crearon los limpios y estos esperan a una persona.
        upd["auto_skipped"] = "; ".join(f"PO {p}: {m}" for p, m in esperan.items())[:500]
    if all(r.get("ya_creado") or r.get("ya_en_mos") for r in styles):
        upd.update({"status": "creado", "resolved_at": datetime.now(timezone.utc).isoformat(),
                    "resolved_by": "auto"})
    await db.printavo_intake.update_one({"item_id": item["item_id"]}, {"$set": upd})
    if ok:
        await _set_config({"auto_created_count": int(cfg.get("auto_created_count") or 0) + len(ok)})
        cfg["auto_created_count"] = int(cfg.get("auto_created_count") or 0) + len(ok)
    logger.info(f"[gmail-intake] auto-created {len(ok)} quote(s) for PO {item.get('po_number')} "
                f"({len(failed)} failed, {len(esperan)} esperan)")
    # True si se creo ALGO: el correo lleva la etiqueta "MOS/Quote creada".
    return bool(ok)


async def _process_message(svc, cfg: dict, fuente: dict, labels: dict, msg_id: str, forced: bool) -> dict:
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
    auto_created = 0
    duplicates = 0
    if not _domain_allowed(senders, fuente.get("allowed_domains") or []):
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
            prior = await db.printavo_intake.find_one({"pdf_sha256": sha}, {"_id": 0, "item_id": 1, "status": 1, "flags": 1})
            if prior and not (forced and prior.get("status") == "pendiente"):
                duplicates += 1
                continue
            try:
                records, engine = await run_in_threadpool(parse_po_bytes, data, cfg.get("_plantillas") or [])
            except Exception as e:
                logger.warning(f"[gmail-intake] parse failed {fn}: {e}")
                records, engine = [], "error"
            if not records:
                continue  # Layer 2: not a PO
            if prior:
                # MOS/Revisar on a pending item = "read it again with the current
                # parser" (e.g. after a parser fix): refresh styles + flags in place.
                pflags = [f for f in (prior.get("flags") or []) if f not in PARSER_FLAGS]
                pflags += [f for f in PARSER_FLAGS if any(f in (r.get("flags") or []) for r in records)]
                pos_r, _, _ = await _marcar_existentes(
                    records, next((r.get("store_po") for r in records if r.get("store_po")), None))
                await db.printavo_intake.update_one({"item_id": prior["item_id"]}, {"$set": {
                    "styles": records, "engine": engine, "style_count": len(records),
                    "qty_total": sum(int(r.get("qty") or 0) for r in records),
                    "po_numbers": pos_r,
                    "po_number": next((r.get("po_number") for r in records if r.get("po_number")), None),
                    "store_po": next((r.get("store_po") for r in records if r.get("store_po")), None),
                    "flags": pflags, "reparsed_at": now,
                }})
                created += 1
                continue
            po_number = next((r.get("po_number") for r in records if r.get("po_number")), None)
            # First-page text (what the regexes actually see) travels with the item
            # so an unrecognized store can be diagnosed without asking for the file.
            try:
                text_head = await run_in_threadpool(_pdf_text_head, data)
            except Exception:
                text_head = None
            store_po = next((r.get("store_po") for r in records if r.get("store_po")), None)
            # TODOS los PO del PDF, no solo el primero. Goodie trae uno por PDF
            # (y ahi nada cambia), pero Spektrum manda hojas con 27: revisar solo
            # el primero dejaba pasar duplicados del resto, o cerraba el PDF
            # entero porque el primero ya existia.
            pos, existentes, creados = await _marcar_existentes(records, store_po)
            existing = ", ".join(dict.fromkeys(existentes.values())) or None
            flags = []
            if pos and await db.printavo_intake.find_one(
                    {"$or": [{"po_numbers": {"$in": pos}}, {"po_number": {"$in": pos}}],
                     "pdf_sha256": {"$ne": sha}}, {"_id": 1}):
                flags.append("new_version")
            if existentes:
                flags.append("existing_order")
            if creados:
                flags.append("already_created")
            # Parser-level flags (store not recognized, store PO missing) bubble up
            # so the inbox row warns before anyone opens the item.
            for f in PARSER_FLAGS:
                if any(f in (r.get("flags") or []) for r in records):
                    flags.append(f)
            item = {
                "item_id": hashlib.sha1(f"{msg_id}:{sha}".encode()).hexdigest()[:16],
                "status": "pendiente",
                "flags": flags,
                "existing_order": existing,
                "po_number": po_number,
                "po_numbers": pos,
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
                "fuente": fuente.get("id"),
                "fuente_nombre": fuente.get("nombre"),
                "created_at": now,
                "created_quotes": None,
                "resolved_at": None,
                "resolved_by": None,
            }
            # Already in MOS -> resolved on the spot; nothing to do for anyone.
            # Solo si TODOS sus PO existen: con uno nuevo, alguien tiene que verlo.
            if pos and len(existentes) == len(pos):
                item.update({"status": "ya_existe", "resolved_at": now, "resolved_by": "auto"})
            # Same PO already waiting: the OLDER PDF is superseded by this one
            # (original vs Rev1 in the same pass); only the newest waits. If the
            # older one was already created, this stays a 'new_version' for a human.
            # Con varios PO por PDF solo se reemplaza al que queda CUBIERTO: si el
            # nuevo no trae todos los PO del viejo, tirar el viejo de la bandeja
            # perderia los que faltan. En ese caso se quedan los dos.
            elif pos:
                async for old in db.printavo_intake.find(
                        {"$or": [{"po_numbers": {"$in": pos}}, {"po_number": {"$in": pos}}],
                         "status": "pendiente", "pdf_sha256": {"$ne": sha}},
                        {"_id": 0, "item_id": 1, "received_at": 1, "po_numbers": 1, "po_number": 1}):
                    viejos = set(old.get("po_numbers") or [old.get("po_number")])
                    if (old.get("received_at") or "") <= (item["received_at"] or ""):
                        if viejos <= set(pos):
                            await db.printavo_intake.update_one({"item_id": old["item_id"]}, {"$set": {
                                "status": "reemplazado", "resolved_at": now, "resolved_by": "auto",
                                "replaced_by": item["item_id"]}})
                    elif set(pos) <= viejos:
                        # This PDF is older than one already waiting: it is the superseded one.
                        item.update({"status": "reemplazado", "resolved_at": now, "resolved_by": "auto",
                                     "replaced_by": old["item_id"]})
                if item["status"] == "pendiente" and "new_version" in flags and not creados:
                    flags.remove("new_version")
            await db.printavo_intake.insert_one(item)
            created += 1
            if item["status"] == "pendiente" and await _maybe_auto_create(cfg, fuente, item):
                auto_created += 1
        if created == 0 and reason is None:
            reason = ("PDF ya visto (re-adjuntado en el hilo)" if duplicates
                      else "ningún PDF adjunto es una orden reconocida")

    # Trail in Gmail + seen record. Label failures must not lose the DB state.
    add = [labels[LABEL_PROCESADO], labels[LABEL_ORDEN] if created else labels[LABEL_IGNORADO]]
    if auto_created:
        add.append(labels[LABEL_QUOTE])
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
    return {"orders": created, "ignored": created == 0, "auto_created": auto_created}


async def run_once(cfg: dict) -> dict:
    """One intake pass. Raises on auth/config problems (caller records them).

    Cada cliente se lee de SU buzon (el que se conecto con su boton) o, si no
    tiene, del buzon general. Un buzon caido se anota y no detiene a los demas
    clientes; solo si NINGUNO se pudo leer la pasada falla."""
    fuentes = fuentes_de(cfg)
    if not fuentes:
        raise RuntimeError("no hay ningún cliente dado de alta en el intake")

    # Las plantillas de cliente se leen UNA vez por pasada y viajan en la config:
    # `parse_po_bytes` corre en un hilo aparte y no puede consultar la base, y
    # pedirlas por cada correo seria una consulta de mas por mensaje.
    cfg["_plantillas"] = await plantillas_activas()

    # Un buzon se abre (y se leen sus etiquetas) una sola vez por pasada aunque
    # lo usen varios clientes: el general lo comparten todos los que no tienen
    # buzon propio.
    abiertos = {}
    error_general = None

    async def buzon_de(fuente):
        """(svc, labels, usuario, error) del buzon que le toca a este cliente."""
        nonlocal error_general
        svc, usuario, err, clave, es_general = await _servicio_para(cfg, fuente)
        if clave not in abiertos:
            labels = None
            if svc:
                try:
                    labels = await run_in_threadpool(_label_map, svc)
                    labels = await run_in_threadpool(_ensure_mos_labels, svc, labels)
                except Exception as e:                # noqa: BLE001
                    svc, err = None, f"no se pudieron leer las etiquetas: {str(e)[:200]}"
            abiertos[clave] = (svc, labels, err)
        svc, labels, err = abiertos[clave]
        if err and es_general and cfg.get("user_id"):
            error_general = err
        return svc, labels, usuario, err

    days = max(1, int(cfg.get("days_back") or 7))
    limit = max(1, min(200, int(cfg.get("max_messages") or 50)))
    q = f"has:attachment filename:pdf newer_than:{days}d"

    summary = {"evaluated": 0, "orders": 0, "ignored": 0, "skipped": 0,
               "forced": 0, "auto_created": 0, "por_cliente": {}}
    faltantes = []

    leidos = 0
    for fuente in fuentes:
        svc, labels, usuario, err = await buzon_de(fuente)
        if not svc:
            faltantes.append(f"{fuente.get('nombre')}: {err}")
            continue
        leidos += 1
        # Copia: no ensuciar la config con datos de la pasada. `_usuario` es a
        # nombre de quien se crean las quotes de ESTE cliente (quien conecto su
        # buzon); sin buzon propio, el del buzon general como siempre.
        fuente = {**fuente, "_usuario": usuario}
        src_id = _find_label_id(labels, fuente.get("label_name") or "")
        if not src_id:
            # Una etiqueta mal escrita no debe dejar sin leer a los demas
            # clientes: se anota y se sigue. Si NINGUNA existe, se avisa al final.
            faltantes.append(f"{fuente.get('nombre')}: la etiqueta '{fuente.get('label_name')}' no existe")
            continue
        # El "revisar a mano" se acota a ESTE cliente pidiendo las dos etiquetas:
        # Gmail las combina con AND.
        forced_ids = await run_in_threadpool(
            _list_message_ids, svc, [src_id, labels[LABEL_REVISAR]], "", limit)
        normal_ids = await run_in_threadpool(_list_message_ids, svc, src_id, q, limit)

        parcial = {"evaluated": 0, "orders": 0, "auto_created": 0}
        for msg_id in forced_ids:
            r = await _process_message(svc, cfg, fuente, labels, msg_id, forced=True)
            summary["forced"] += 1
            for k, c in (("evaluated", 1), ("orders", r.get("orders", 0)),
                         ("auto_created", r.get("auto_created", 0))):
                summary[k] += c
                parcial[k] += c
            summary["ignored"] += 1 if r.get("ignored") else 0
        for msg_id in normal_ids:
            if msg_id in forced_ids:
                continue
            r = await _process_message(svc, cfg, fuente, labels, msg_id, forced=False)
            if r.get("skipped"):
                summary["skipped"] += 1
                continue
            for k, c in (("evaluated", 1), ("orders", r.get("orders", 0)),
                         ("auto_created", r.get("auto_created", 0))):
                summary[k] += c
                parcial[k] += c
            summary["ignored"] += 1 if r.get("ignored") else 0
        summary["por_cliente"][fuente.get("nombre") or fuente.get("id")] = parcial

    if faltantes and len(faltantes) == len(fuentes):
        # Nada se pudo leer. Si fue el buzon general, se reporta como problema
        # de autenticacion para que la pantalla ofrezca "reconectar".
        if not leidos and error_general:
            raise PermissionError(error_general)
        raise RuntimeError("; ".join(faltantes))
    summary["avisos"] = faltantes
    summary["auth_error_general"] = error_general
    return summary


async def _run_guarded() -> dict:
    async with _run_lock:
        cfg = await _get_config()
        now = datetime.now(timezone.utc).isoformat()
        try:
            res = await run_once(cfg)
            avisos = res.get("avisos") or []
            await _set_config({
                # Un cliente con problema (etiqueta inexistente, su buzon caido)
                # se ve en la pantalla aunque los demas se hayan leido bien.
                "last_run_at": now, "last_error": "; ".join(avisos)[:500] or None,
                "auth_error": res.get("auth_error_general"),
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
        if not cfg or not cfg.get("enabled"):
            return
        # Sin buzon general Y sin ningun buzon de cliente no hay nada que leer.
        if not cfg.get("user_id") and not await db.gmail_intake_buzones.count_documents({}):
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
    cfg["pending"] = await db.printavo_intake.count_documents({"status": "pendiente"})
    # Siempre normalizadas: la pantalla no tiene que saber si el documento ya
    # tiene la lista o todavia son los campos sueltos de un solo cliente.
    # Con las inactivas tambien: la pantalla las muestra para poder prenderlas.
    cfg["fuentes"] = _todas_las_fuentes(cfg)
    # El buzon propio de cada cliente (sin credenciales: solo que cuenta es y
    # quien la conecto). Un cliente sin buzon propio se lee del general.
    cfg["buzones"] = {
        b["fuente_id"]: {"email": b.get("email"), "auth_error": b.get("auth_error"),
                         "connected_by": (b.get("connected_by") or {}).get("name")
                         or (b.get("connected_by") or {}).get("email"),
                         "connected_at": b.get("connected_at")}
        async for b in db.gmail_intake_buzones.find({}, {"_id": 0, "credentials": 0})
    }
    cfg["connected"] = bool(cfg.get("user_id")) or bool(cfg["buzones"])
    cfg["multi"] = isinstance(cfg.get("fuentes"), list) and len(cfg["fuentes"]) > 1
    return cfg


def _limpiar_fuentes(lista) -> list:
    """Normaliza y valida la lista de clientes del intake.

    Se valida aqui y no en la pantalla porque esta lista decide a QUE contacto de
    Printavo se le crean quotes solas: una fuente con la etiqueta de un cliente y
    el contacto de otro le facturaria al equivocado. Dos reglas duras: etiqueta
    obligatoria, y no se puede encender auto-crear sin contacto."""
    if not isinstance(lista, list):
        raise HTTPException(400, "Las fuentes deben venir como lista")
    out, vistas = [], set()
    for i, f in enumerate(lista):
        if not isinstance(f, dict):
            raise HTTPException(400, "Cada fuente debe ser un objeto")
        etiqueta = str(f.get("label_name") or "").strip()
        nombre = str(f.get("nombre") or "").strip() or f"Cliente {i + 1}"
        if not etiqueta:
            raise HTTPException(400, f"«{nombre}»: falta la etiqueta de Gmail")
        clave = _norm_etiqueta(etiqueta)
        if clave in vistas:
            raise HTTPException(400, f"La etiqueta «{etiqueta}» está repetida en dos clientes")
        vistas.add(clave)
        doms = f.get("allowed_domains") or []
        if isinstance(doms, str):
            doms = re.split(r"[,\s;]+", doms)
        doms = sorted({d.strip().lower().lstrip("@") for d in doms if d and str(d).strip()})
        auto = bool(f.get("auto_create"))
        contacto = (str(f.get("auto_contact_id") or "").strip() or None)
        if auto and not contacto:
            raise HTTPException(400, f"«{nombre}»: elige el contacto de Printavo antes de activar auto-crear")
        out.append({
            "id": str(f.get("id") or "").strip() or f"f{i + 1}",
            "nombre": nombre,
            "label_name": etiqueta,
            "allowed_domains": doms,
            "auto_create": auto,
            "auto_contact_id": contacto,
            "auto_contact_name": (str(f.get("auto_contact_name") or "").strip() or None),
            "activa": bool(f.get("activa", True)),
        })
    ids = [f["id"] for f in out]
    if len(set(ids)) != len(ids):
        raise HTTPException(400, "Hay dos clientes con el mismo identificador")
    return out


def _norm_etiqueta(s: str) -> str:
    x = unicodedata.normalize("NFKD", s or "")
    x = "".join(c for c in x if not unicodedata.combining(c))
    return re.sub(r"\s+", " ", x.strip().lower())


@router.put("/config")
async def update_config(request: Request):
    user = await require_admin(request)
    body = await request.json()
    allowed = {}
    if "enabled" in body:
        allowed["enabled"] = bool(body["enabled"])
    if "fuentes" in body:
        allowed["fuentes"] = _limpiar_fuentes(body["fuentes"])
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
    if "auto_create" in body:
        allowed["auto_create"] = bool(body["auto_create"])
    if "auto_contact_id" in body:
        allowed["auto_contact_id"] = (str(body["auto_contact_id"] or "").strip() or None)
        allowed["auto_contact_name"] = (str(body.get("auto_contact_name") or "").strip() or None)
    if allowed.get("auto_create") and not (allowed.get("auto_contact_id") or (await _get_config()).get("auto_contact_id")):
        raise HTTPException(400, "Elige el contacto de Printavo antes de activar auto-crear")
    if not allowed:
        raise HTTPException(400, "Nada que actualizar")
    await _set_config(allowed)
    # Cliente borrado de la lista = su buzon ya no se usa: se tira el token en
    # vez de dejar credenciales de Gmail guardadas sin dueño.
    if "fuentes" in allowed:
        res = await db.gmail_intake_buzones.delete_many(
            {"fuente_id": {"$nin": [f["id"] for f in allowed["fuentes"]]}})
        if res.deleted_count:
            logger.info(f"[gmail-intake] {res.deleted_count} buzón(es) de clientes borrados se desconectaron")
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
    if status == "all":
        q = {}
    elif status == "resueltos":
        q = {"status": {"$ne": "pendiente"}}
    else:
        q = {"status": status}
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
        {"item_id": item_id, "status": {"$in": ["descartado", "ya_existe", "reemplazado"]}},
        {"$set": {"status": "pendiente", "resolved_at": None, "resolved_by": None}})
    if not res.matched_count:
        raise HTTPException(404, "No existe o no se puede restaurar")
    await log_activity(user, "gmail_intake_restore", {"item_id": item_id})
    return {"status": "pendiente"}


@router.post("/items/{item_id}/reparse")
async def reparse_item(request: Request, item_id: str):
    """Fetch the item's email again and re-read its PDF with the CURRENT parser
    (same path as the MOS/Revisar label, without leaving MOS). Pending only."""
    user = await require_admin(request)
    item = await db.printavo_intake.find_one({"item_id": item_id}, {"_id": 0})
    if not item:
        raise HTTPException(404, "No existe")
    if item.get("status") != "pendiente":
        raise HTTPException(409, f"El elemento ya está '{item.get('status')}'")
    cfg = await _get_config()
    if _run_lock.locked():
        raise HTTPException(409, "Ya hay una pasada en curso; intenta en un momento")
    # De qué cliente es este ítem: los nuevos lo traen anotado; los de antes del
    # multi-cliente no, y para ésos la primera fuente es la correcta porque era
    # la única que existía.
    fuentes = _todas_las_fuentes(cfg)
    fuente = next((f for f in fuentes if f.get("id") == item.get("fuente")), None) or fuentes[0]
    cfg["_plantillas"] = await plantillas_activas()

    async with _run_lock:
        # El correo vive en el buzon de SU cliente, no necesariamente en el general.
        svc, usuario, err, _, _ = await _servicio_para(cfg, fuente)
        if not svc:
            raise HTTPException(400, err or "No hay buzón conectado")
        fuente = {**fuente, "_usuario": usuario}
        labels = await run_in_threadpool(_label_map, svc)
        labels = await run_in_threadpool(_ensure_mos_labels, svc, labels)
        try:
            await _process_message(svc, cfg, fuente, labels, item["gmail_message_id"], forced=True)
        except Exception as e:
            raise HTTPException(400, f"No se pudo releer: {str(e)[:200]}")
    await log_activity(user, "gmail_intake_reparse", {"item_id": item_id})
    return await db.printavo_intake.find_one({"item_id": item_id}, {"_id": 0, "body_text": 0, "pdf_text_head": 0})


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
