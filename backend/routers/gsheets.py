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


# ── Formato de celda (Google -> modelo de MOS) ────────────────────────────────
# Se traduce el formato que el usuario aplicó en Google (colores, negrita,
# alineación, combinadas, anchos) para que el packing list se vea PARECIDO dentro
# de MOS. Los bordes por celda no tienen equivalente en el modelo de MOS (solo
# hay gridlines on/off por hoja), así que no viajan.

def _color_hex(col):
    if not col:
        return None
    r = col.get("red", 0); g = col.get("green", 0); b = col.get("blue", 0)
    return "#%02x%02x%02x" % (round(r * 255), round(g * 255), round(b * 255))


def _casi_blanco(col):
    return bool(col) and col.get("red", 0) >= 0.996 and col.get("green", 0) >= 0.996 and col.get("blue", 0) >= 0.996


def _casi_negro(col):
    # Sin color = negro por defecto en el modelo de Google (canales ausentes = 0).
    return (not col) or (col.get("red", 0) <= 0.004 and col.get("green", 0) <= 0.004 and col.get("blue", 0) <= 0.004)


def _formato_de_celda(celda):
    """Extrae solo lo NO-predeterminado; devuelve None si la celda no aporta estilo."""
    uf = celda.get("userEnteredFormat")
    if not uf:
        return None
    out = {}
    bg = uf.get("backgroundColor")
    if bg and not _casi_blanco(bg):
        out["fill"] = _color_hex(bg)
    tf = uf.get("textFormat") or {}
    if tf.get("bold"):
        out["bold"] = True
    if tf.get("italic"):
        out["italic"] = True
    if tf.get("underline"):
        out["underline"] = True
    fg = tf.get("foregroundColor")
    if fg and not _casi_negro(fg):
        out["color"] = _color_hex(fg)
    fam = tf.get("fontFamily")
    if fam and fam.lower() not in ("arial", "calibri", "default"):
        out["fontFamily"] = fam
    fs = tf.get("fontSize")
    if fs and fs != 10:
        out["fontSize"] = fs
    ha = uf.get("horizontalAlignment")
    if ha in ("LEFT", "CENTER", "RIGHT"):
        out["align"] = ha.lower()
    if uf.get("wrapStrategy") == "WRAP":
        out["wrap"] = True
    return out or None


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

# Tope de filas que se procesan por pestaña. Los packing lists son chicos; el
# tope evita que una hoja enorme entre entera al modelo del navegador.
MAX_FILAS_LECTURA = 2000


def _col_letra(n_cols):
    """Letra A1 de la ULTIMA columna dado el numero de columnas (26 -> 'Z')."""
    idx = max(1, int(n_cols or 1))
    letras = ""
    while idx > 0:
        idx, rem = divmod(idx - 1, 26)
        letras = chr(65 + rem) + letras
    return letras


def _leer_formato(service, sheet_id, props_hojas):
    """
    Lee el formato (colores, negrita, alineacion, combinadas, anchos) por pestaña.
    BEST-EFFORT: ante cualquier problema devuelve lo que haya (o {}) y la hoja
    abre igual con su contenido; el formato nunca debe dejar la hoja en blanco.
    Se acota el rango por pestaña para no traer una respuesta enorme.
    """
    out = {}
    err = None
    try:
        ranges = []
        for p in props_hojas:
            t = p.get("title")
            if not t:
                continue
            grid = p.get("gridProperties") or {}
            rows = min(int(grid.get("rowCount") or 0) or MAX_FILAS_LECTURA, MAX_FILAS_LECTURA)
            cols = min(int(grid.get("columnCount") or 0) or 26, 64)
            ranges.append(f"'{t}'!A1:{_col_letra(cols)}{rows}")
        if not ranges:
            return out, err
        resp = service.spreadsheets().get(
            spreadsheetId=sheet_id,
            includeGridData=True,
            ranges=ranges,
            fields=(
                "sheets.properties.title,sheets.merges,"
                "sheets.data(startRow,startColumn,columnMetadata.pixelSize,"
                "rowData.values(userEnteredFormat(backgroundColor,horizontalAlignment,"
                "wrapStrategy,textFormat(bold,italic,underline,foregroundColor,"
                "fontFamily,fontSize))))"
            ),
        ).execute()
        for sh in resp.get("sheets", []):
            titulo = (sh.get("properties") or {}).get("title")
            if not titulo:
                continue
            data0 = (sh.get("data") or [{}])[0]
            base_r = int(data0.get("startRow", 0) or 0)
            base_c = int(data0.get("startColumn", 0) or 0)
            row_data = data0.get("rowData") or []
            col_meta = data0.get("columnMetadata") or []
            formats = []
            for r, fila in enumerate(row_data):
                for c, celda in enumerate(fila.get("values") or []):
                    f = _formato_de_celda(celda)
                    if f:
                        f["r"] = base_r + r
                        f["c"] = base_c + c
                        formats.append(f)
            merges = []
            for m in sh.get("merges") or []:
                merges.append({
                    "r1": m.get("startRowIndex", 0),
                    "c1": m.get("startColumnIndex", 0),
                    "r2": m.get("endRowIndex", 1) - 1,
                    "c2": m.get("endColumnIndex", 1) - 1,
                })
            col_widths = {}
            for i, cm in enumerate(col_meta):
                px = cm.get("pixelSize")
                if px:
                    col_widths[str(base_c + i)] = px
            out[titulo] = {"formats": formats, "merges": merges, "colWidths": col_widths}
    except Exception as e:
        err = str(e)[:600]
        logging.warning(f"GSHEETS formato best-effort fallo (se abre sin formato): {e}")
    return out, err


@router.get("/read")
async def read_sheet(request: Request, url: str):
    """
    Lee un Google Sheet (todas sus pestañas) con CONTENIDO y FORMATO, y lo
    devuelve como:
      { name, googleId, googleUrl, sheets: [{
          name,
          values:    [[texto, ...], ...],            # valor mostrado por Google
          formats:   [{ r, c, bold, fill, ... }, ...],# solo celdas con estilo
          merges:    [{ r1, c1, r2, c2 }, ...],
          colWidths: { "0": px, ... },
      }] }
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

    # 1) Titulos y dimensiones (llamada chica y confiable).
    try:
        meta = service.spreadsheets().get(
            spreadsheetId=sheet_id,
            fields="properties.title,sheets.properties(title,gridProperties(rowCount,columnCount))",
        ).execute()
    except Exception as e:
        msg = str(e)
        if "403" in msg or "PERMISSION" in msg.upper():
            raise HTTPException(status_code=403, detail="no_access")
        if "404" in msg:
            raise HTTPException(status_code=404, detail="No se encontró la hoja.")
        logging.error(f"GSHEETS read meta error: {e}")
        raise HTTPException(status_code=502, detail="Error leyendo la hoja de Google.")

    props_hojas = [(s.get("properties") or {}) for s in meta.get("sheets", [])]
    titulos = [p.get("title") for p in props_hojas if p.get("title")]
    if not titulos:
        raise HTTPException(status_code=422, detail="La hoja no tiene pestañas legibles.")

    # 2) Valores (camino probado: el valor MOSTRADO por Google).
    try:
        valores = service.spreadsheets().values().batchGet(
            spreadsheetId=sheet_id,
            ranges=[f"'{t}'" for t in titulos],
            majorDimension="ROWS",
        ).execute()
        rangos = valores.get("valueRanges", [])
    except Exception as e:
        logging.error(f"GSHEETS read values error: {e}")
        raise HTTPException(status_code=502, detail="Error leyendo los valores de la hoja.")

    # 3) Formato (best-effort): si falla, la hoja abre igual con su contenido.
    fmt_por_titulo, fmt_error = _leer_formato(service, sheet_id, props_hojas)

    sheets = []
    for i, t in enumerate(titulos):
        extra = fmt_por_titulo.get(t, {})
        sheets.append({
            "name": t,
            "values": (rangos[i].get("values", []) if i < len(rangos) else []),
            "formats": extra.get("formats", []),
            "merges": extra.get("merges", []),
            "colWidths": extra.get("colWidths", {}),
        })

    await log_activity(user, "gsheets_read", {"sheet_id": sheet_id})

    # DIAGNOSTICO TEMPORAL — quitar cuando formato/guardado queden cerrados.
    # Deja ver, abriendo /api/gsheets/read?url=... en el navegador (con sesion),
    # por que el formato no aparece y si el scope permite escribir.
    token_doc = await db.user_google_tokens.find_one({"user_id": user["user_id"]})
    scopes = (token_doc or {}).get("credentials", {}).get("scopes") or []
    diag = {
        "build": "gsheets-diag-2",
        "titulos": titulos,
        "formato_entradas": {t: len(fmt_por_titulo.get(t, {}).get("formats", [])) for t in titulos},
        "formato_error": fmt_error,
        "puede_escribir": SHEETS_SCOPE in scopes,
        "scopes": scopes,
    }

    return {
        "name": (meta.get("properties") or {}).get("title", "Google Sheet"),
        "googleId": sheet_id,
        "googleUrl": url,
        "sheets": sheets,
        "_diag": diag,
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
        valores = s.get("values") or []
        # Una pestaña vacia (p.ej. una "Hoja1" sin contenido) NO entra al
        # batchUpdate: Google rechaza con 400 un ValueRange sin valores y eso
        # tumbaba TODO el guardado. Solo se limpia (batchClear ya la cubre).
        if valores:
            data.append({"range": f"'{nombre}'!A1", "values": valores})

    if not a_borrar:
        logging.error(f"GSHEETS write: sin coincidencias. pedidas={[str(s.get('name','')) for s in entrada]} existentes={sorted(existentes)}")
        raise HTTPException(
            status_code=422,
            detail=f"Ninguna pestaña coincide. En Google hay: {sorted(existentes)}; se intento: {[str(s.get('name','')) for s in entrada]}.",
        )

    try:
        # Primero se limpian los valores (para reflejar filas/columnas borradas),
        # sin tocar el formato; luego se escriben los nuevos.
        service.spreadsheets().values().batchClear(
            spreadsheetId=sheet_id, body={"ranges": a_borrar}).execute()
        if data:
            service.spreadsheets().values().batchUpdate(
                spreadsheetId=sheet_id,
                body={"valueInputOption": "USER_ENTERED", "data": data}).execute()
    except Exception as e:
        msg = str(e)
        if "403" in msg or "PERMISSION" in msg.upper():
            raise HTTPException(status_code=403, detail="no_edit")
        logging.error(f"GSHEETS write error: {e}")
        # DIAGNOSTICO TEMPORAL: se devuelve el error real de Google para verlo en
        # el toast. Volver a "Error escribiendo en la hoja de Google." al cerrar.
        raise HTTPException(status_code=502, detail=f"Error escribiendo en Google: {msg[:400]}")

    await log_activity(user, "gsheets_write", {"sheet_id": sheet_id, "tabs": len(data)})
    return {"ok": True, "written": len(data), "skipped": omitidas}


@router.get("/ping")
async def ping():
    """
    Sin auth: confirma QUE version del router de gsheets esta desplegada.
    Sirve para saber, desde fuera, si EasyPanel ya tomo el ultimo commit del
    backend. TEMPORAL — quitar cuando el modulo quede cerrado.
    """
    return {
        "build": "gsheets-diag-2",
        "has_write": True,
        "has_format_read": True,
        "creds_configured": bool(CLIENT_ID and CLIENT_SECRET),
    }
