"""
Lectura de Google Sheets desde MOS (packing lists compartidos en comentarios).

Reusa el MISMO patron de OAuth que google_calendar.py: consentimiento del
usuario, token guardado por usuario en `user_google_tokens`, y refresco
automatico. Aqui se pide ademas el scope de Sheets (solo lectura) y se construye
el servicio 'sheets','v4'.

Como se usa `include_granted_scopes='true'`, conectar Sheets NO borra el permiso
de Calendar si ya lo tenia (Google devuelve la union de scopes). El token se
guarda en la misma coleccion, asi que ambos modulos comparten la conexion.

FASE 2 — solo lectura. Escribir de vuelta a Google seria un scope 'spreadsheets'
completo y un endpoint aparte; se deja para despues.
"""
from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import RedirectResponse
from google_auth_oauthlib.flow import Flow
from googleapiclient.discovery import build
from google.oauth2.credentials import Credentials
from google.auth.transport.requests import Request as GoogleRequest
import os
import re
import logging
from datetime import datetime, timezone

os.environ['OAUTHLIB_RELAX_TOKEN_SCOPE'] = '1'
from deps import db, require_auth, log_activity

router = APIRouter(prefix="/api/gsheets")

CLIENT_ID = os.environ.get("GOOGLE_CLIENT_ID", "").strip()
CLIENT_SECRET = os.environ.get("GOOGLE_CLIENT_SECRET", "").strip()

ENV = os.environ.get('ENV', 'local').lower()
IS_PROD = ENV == 'production'

if IS_PROD:
    REDIRECT_URI = "https://mosdatabase-backend.k9pirj.easypanel.host/api/gsheets/callback"
    FRONTEND_URL = "https://mosdatabase-frontend.k9pirj.easypanel.host"
else:
    REDIRECT_URI = os.environ.get("GSHEETS_REDIRECT_URI", "http://localhost:8000/api/gsheets/callback")
    FRONTEND_URL = os.environ.get("FRONTEND_URL", "http://localhost:3000").rstrip('/')

# Lectura Y escritura: el objetivo es editar los packing lists sin salir a
# Google. 'spreadsheets' (completo) da acceso a las hojas que el usuario pueda
# abrir por su URL. Es un scope restringido: si el consentimiento OAuth es
# External, Google puede pedir verificacion; si es Internal (dominio), no.
SCOPES = ['https://www.googleapis.com/auth/spreadsheets']

SHEETS_SCOPE = SCOPES[0]


def _get_flow():
    if not CLIENT_ID or not CLIENT_SECRET:
        raise HTTPException(status_code=500, detail="Google API credentials not configured in .env")
    client_config = {
        "web": {
            "client_id": CLIENT_ID,
            "project_id": "mos-system-sheets",
            "auth_uri": "https://accounts.google.com/o/oauth2/auth",
            "token_uri": "https://oauth2.googleapis.com/token",
            "auth_provider_x509_cert_url": "https://www.googleapis.com/oauth2/v1/certs",
            "client_secret": CLIENT_SECRET,
            "redirect_uris": [REDIRECT_URI],
        }
    }
    return Flow.from_client_config(client_config, scopes=SCOPES, redirect_uri=REDIRECT_URI)


def _id_de_url(url: str):
    m = re.search(r"/spreadsheets/d/([a-zA-Z0-9\-_]+)", url or "")
    return m.group(1) if m else None


# ── Conexion OAuth ────────────────────────────────────────────────────────────

@router.get("/auth-url")
async def auth_url(request: Request):
    """URL de consentimiento de Google para conceder acceso de lectura a Sheets."""
    user = await require_auth(request)
    flow = _get_flow()
    url, state = flow.authorization_url(
        access_type='offline',
        include_granted_scopes='true',   # conserva Calendar si ya estaba
        prompt='consent',
    )
    await db.google_auth_states.insert_one({
        "user_id": user["user_id"],
        "state": state,
        "purpose": "gsheets",
        "created_at": datetime.now(timezone.utc).isoformat(),
    })
    return {"url": url}


@router.get("/callback")
async def callback(request: Request, code: str, state: str):
    state_doc = await db.google_auth_states.find_one({"state": state})
    if not state_doc:
        raise HTTPException(status_code=400, detail="Invalid auth state or session expired")
    user_id = state_doc["user_id"]

    flow = _get_flow()
    flow.fetch_token(code=code)
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
    return RedirectResponse(url=f"{FRONTEND_URL}/sheets?google_connected=true")


@router.get("/status")
async def status(request: Request):
    """¿El usuario tiene conexion con Google que incluya el permiso de Sheets?"""
    user = await require_auth(request)
    token_doc = await db.user_google_tokens.find_one({"user_id": user["user_id"]})
    if not token_doc:
        return {"connected": False, "has_sheets": False}
    scopes = token_doc.get("credentials", {}).get("scopes") or []
    return {"connected": True, "has_sheets": SHEETS_SCOPE in scopes}


# ── Servicio autenticado ──────────────────────────────────────────────────────

async def _get_sheets_service(user_id: str):
    token_doc = await db.user_google_tokens.find_one({"user_id": user_id})
    if not token_doc:
        return None
    creds_data = token_doc["credentials"]
    if SHEETS_SCOPE not in (creds_data.get("scopes") or []):
        return None   # conectado, pero sin permiso de Sheets

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
            creds.refresh(GoogleRequest())
            creds_data['token'] = creds.token
            creds_data['expiry'] = creds.expiry.isoformat() if creds.expiry else None
            await db.user_google_tokens.update_one(
                {"user_id": user_id},
                {"$set": {"credentials": creds_data,
                          "updated_at": datetime.now(timezone.utc).isoformat()}},
            )
        return build('sheets', 'v4', credentials=creds)
    except Exception as e:
        logging.error(f"GSHEETS: no se pudo construir el servicio: {e}")
        return None


# ── Lectura ───────────────────────────────────────────────────────────────────

@router.get("/read")
async def read_sheet(request: Request, url: str):
    """
    Lee un Google Sheet (todas sus pestañas) y lo devuelve como estructura simple:
      { name, googleId, googleUrl, sheets: [{ name, values: [[...], ...] }] }
    Codigos utiles para el front:
      401 need_connect  -> falta conectar Google (o falta el permiso de Sheets)
      403 no_access     -> conectado, pero no tiene acceso a esa hoja
    """
    user = await require_auth(request)
    sheet_id = _id_de_url(url)
    if not sheet_id:
        raise HTTPException(status_code=400, detail="El enlace no es un Google Sheet válido.")

    service = await _get_sheets_service(user["user_id"])
    if not service:
        raise HTTPException(status_code=401, detail="need_connect")

    try:
        meta = service.spreadsheets().get(
            spreadsheetId=sheet_id,
            fields="properties.title,sheets.properties.title",
        ).execute()
    except Exception as e:
        msg = str(e)
        if "403" in msg or "PERMISSION" in msg.upper():
            raise HTTPException(status_code=403, detail="no_access")
        if "404" in msg:
            raise HTTPException(status_code=404, detail="No se encontró la hoja.")
        logging.error(f"GSHEETS read meta error: {e}")
        raise HTTPException(status_code=502, detail="Error leyendo la hoja de Google.")

    titulos = [s["properties"]["title"] for s in meta.get("sheets", []) if s.get("properties")]
    if not titulos:
        raise HTTPException(status_code=422, detail="La hoja no tiene pestañas legibles.")

    try:
        valores = service.spreadsheets().values().batchGet(
            spreadsheetId=sheet_id,
            ranges=[f"'{t}'" for t in titulos],
            majorDimension="ROWS",
        ).execute()
    except Exception as e:
        logging.error(f"GSHEETS read values error: {e}")
        raise HTTPException(status_code=502, detail="Error leyendo los valores de la hoja.")

    rangos = valores.get("valueRanges", [])
    sheets = []
    for i, t in enumerate(titulos):
        sheets.append({"name": t, "values": (rangos[i].get("values", []) if i < len(rangos) else [])})

    await log_activity(user, "gsheets_read", {"sheet_id": sheet_id})
    return {
        "name": meta.get("properties", {}).get("title", "Google Sheet"),
        "googleId": sheet_id,
        "googleUrl": url,
        "sheets": sheets,
    }


@router.post("/write")
async def write_sheet(request: Request):
    """
    Escribe de vuelta los valores a un Google Sheet, para poder editar el packing
    list dentro de MOS sin abrir Google. Recibe:
      { googleId, sheets: [{ name, values: [[...], ...] }] }
    Por cada pestaña EXISTENTE (por nombre) borra sus valores y escribe los
    nuevos. Solo toca valores: el formato de Google no se altera. Las pestañas
    nuevas que no existan en Google se omiten (v1).
      401 need_connect -> falta conectar / permiso
      403 no_edit      -> el usuario no puede editar esa hoja
    """
    user = await require_auth(request)
    body = await request.json()
    sheet_id = body.get("googleId")
    entrada = body.get("sheets", [])
    if not sheet_id or not isinstance(entrada, list):
        raise HTTPException(status_code=400, detail="Falta googleId o sheets.")

    service = await _get_sheets_service(user["user_id"])
    if not service:
        raise HTTPException(status_code=401, detail="need_connect")

    try:
        meta = service.spreadsheets().get(
            spreadsheetId=sheet_id, fields="sheets.properties.title").execute()
    except Exception as e:
        msg = str(e)
        if "403" in msg or "PERMISSION" in msg.upper():
            raise HTTPException(status_code=403, detail="no_edit")
        if "404" in msg:
            raise HTTPException(status_code=404, detail="No se encontró la hoja.")
        raise HTTPException(status_code=502, detail="Error accediendo a la hoja de Google.")

    existentes = {s["properties"]["title"] for s in meta.get("sheets", []) if s.get("properties")}

    a_borrar = []
    data = []
    omitidas = []
    for s in entrada:
        nombre = str(s.get("name", ""))
        if nombre not in existentes:
            omitidas.append(nombre)
            continue
        a_borrar.append(f"'{nombre}'")
        data.append({"range": f"'{nombre}'!A1", "values": s.get("values", [])})

    if not data:
        raise HTTPException(status_code=422, detail="Ninguna pestaña coincide con las de Google. No se escribió nada.")

    try:
        # Primero se limpian los valores (para reflejar filas/columnas borradas),
        # sin tocar el formato; luego se escriben los nuevos.
        service.spreadsheets().values().batchClear(
            spreadsheetId=sheet_id, body={"ranges": a_borrar}).execute()
        service.spreadsheets().values().batchUpdate(
            spreadsheetId=sheet_id,
            body={"valueInputOption": "USER_ENTERED", "data": data}).execute()
    except Exception as e:
        msg = str(e)
        if "403" in msg or "PERMISSION" in msg.upper():
            raise HTTPException(status_code=403, detail="no_edit")
        logging.error(f"GSHEETS write error: {e}")
        raise HTTPException(status_code=502, detail="Error escribiendo en la hoja de Google.")

    await log_activity(user, "gsheets_write", {"sheet_id": sheet_id, "tabs": len(data)})
    return {"ok": True, "written": len(data), "skipped": omitidas}
