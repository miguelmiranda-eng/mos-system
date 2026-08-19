"""OAuth para el conector MCP: es lo que Claude exige para conectarse.

POR QUÉ EXISTE
El conector funcionaba con un token fijo en la cabecera, pero Claude no ofrece
esa opción al usuario final: intenta REGISTRARSE por OAuth y, si no encuentra
dónde, falla con "Couldn't register with … sign-in service". Ese es el error
exacto que salía. Claude soporta OAuth con Dynamic Client Registration de
fábrica, así que se implementa ese camino.

QUIÉN PUEDE CONECTARSE
No basta con tener cuenta en MOS: el correo tiene que estar en la LISTA
`connector_access`. Se autorizó que el conector exponga montos facturados, y
hay 27 personas con rol admin/supersu — demasiadas para ese dato. La lista se
maneja con backend/scripts/crear_token_conector.py.

QUÉ NO SE GUARDA EN CLARO
Ni los códigos ni los tokens: solo su hash, igual que las contraseñas. Si
alguien lee la base no obtiene credenciales usables.
"""
import base64
import hashlib
import os
import secrets
from datetime import datetime, timedelta, timezone
from urllib.parse import urlencode

from fastapi import APIRouter, Form, Request
from fastapi.responses import HTMLResponse, JSONResponse, RedirectResponse
from passlib.hash import bcrypt

from deps import db, logger

router = APIRouter()

# La URL pública del backend. El campo `resource` de los metadatos DEBE
# coincidir EXACTAMENTE con lo que el usuario escribe en Claude, incluida la
# ruta; si no coincide, Claude rechaza el descubrimiento sin decir por qué.
BASE = (os.environ.get("MCP_PUBLIC_URL")
        or "https://mosdatabase-backend.k9pirj.easypanel.host").rstrip("/")
RECURSO = f"{BASE}/api/mcp"

VIDA_CODIGO = timedelta(minutes=5)
VIDA_TOKEN = timedelta(hours=12)
VIDA_REFRESH = timedelta(days=30)


def _hash(v: str) -> str:
    return hashlib.sha256(v.encode()).hexdigest()


def _ahora():
    return datetime.now(timezone.utc)


# ── descubrimiento ──────────────────────────────────────────────────────────
# Claude sondea primero la ruta con el path del servidor y luego la raíz. Se
# sirven las dos para no depender de cuál intente.
@router.get("/.well-known/oauth-protected-resource/api/mcp")
@router.get("/.well-known/oauth-protected-resource")
async def recurso_protegido():
    """RFC 9728: dice DÓNDE está el servidor de autorización."""
    return JSONResponse({
        "resource": RECURSO,
        "authorization_servers": [BASE],
        "scopes_supported": ["mos.read"],
        "bearer_methods_supported": ["header"],
    })


@router.get("/.well-known/oauth-authorization-server")
@router.get("/.well-known/oauth-authorization-server/api/mcp")
async def metadatos_autorizacion():
    """RFC 8414. `code_challenge_methods_supported` con S256 no es opcional:
    Claude manda PKCE siempre y verifica que se anuncie antes de empezar."""
    return JSONResponse({
        "issuer": BASE,
        "authorization_endpoint": f"{BASE}/api/mcp/oauth/authorize",
        "token_endpoint": f"{BASE}/api/mcp/oauth/token",
        "registration_endpoint": f"{BASE}/api/mcp/oauth/register",
        "scopes_supported": ["mos.read"],
        "response_types_supported": ["code"],
        "grant_types_supported": ["authorization_code", "refresh_token"],
        "code_challenge_methods_supported": ["S256"],
        "token_endpoint_auth_methods_supported": ["none"],
    })


# ── registro dinámico de cliente (RFC 7591) ─────────────────────────────────
@router.post("/api/mcp/oauth/register")
async def registrar_cliente(request: Request):
    """Claude se registra solo la primera vez. Cliente PÚBLICO, sin secreto:
    corre en el navegador del usuario y no puede guardar uno."""
    try:
        cuerpo = await request.json()
    except Exception:
        return JSONResponse({"error": "invalid_client_metadata"}, status_code=400)

    redirects = cuerpo.get("redirect_uris") or []
    if not isinstance(redirects, list) or not redirects:
        return JSONResponse({"error": "invalid_redirect_uri"}, status_code=400)

    client_id = "mos_" + secrets.token_urlsafe(24)
    doc = {
        "client_id": client_id,
        "redirect_uris": [str(u) for u in redirects],
        "client_name": cuerpo.get("client_name") or "cliente MCP",
        "created_at": _ahora().isoformat(),
    }
    await db.oauth_clients.insert_one(dict(doc))
    return JSONResponse({
        "client_id": client_id,
        "redirect_uris": doc["redirect_uris"],
        "client_name": doc["client_name"],
        "token_endpoint_auth_method": "none",
        "grant_types": ["authorization_code", "refresh_token"],
        "response_types": ["code"],
    }, status_code=201)


# ── autorización: aquí la persona se identifica ─────────────────────────────
_PAGINA = """<!doctype html><html lang="es"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Conectar MOS</title><style>
:root{color-scheme:light dark}
body{font-family:system-ui,-apple-system,"Segoe UI",sans-serif;background:#f1f4f7;color:#16202b;
display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0;padding:1rem}
@media(prefers-color-scheme:dark){body{background:#10161c;color:#e4eaef}
.c{background:#182129!important;border-color:#2c3945!important}
input{background:#10161c!important;color:#e4eaef!important;border-color:#2c3945!important}}
.c{background:#fff;border:1px solid #d3dbe2;border-radius:10px;padding:2rem;max-width:380px;width:100%;
box-shadow:0 10px 30px -18px rgba(0,0,0,.4)}
h1{font-size:1.15rem;margin:0 0 .4rem}p{color:#5a6773;font-size:.88rem;margin:0 0 1.2rem;line-height:1.5}
label{display:block;font-size:.78rem;font-weight:600;margin:.9rem 0 .3rem}
input{width:100%;padding:.6rem .7rem;border:1px solid #d3dbe2;border-radius:6px;font-size:.95rem;box-sizing:border-box}
button{width:100%;margin-top:1.4rem;padding:.7rem;border:0;border-radius:6px;background:#145f6e;color:#fff;
font-size:.95rem;font-weight:600;cursor:pointer}
.e{background:#f7e3e6;color:#9e2b3f;padding:.6rem .7rem;border-radius:6px;font-size:.85rem;margin-bottom:1rem}
.n{font-size:.74rem;color:#7c8b98;margin-top:1.2rem;line-height:1.5}
</style></head><body><div class="c">
<h1>Conectar MOS con __APP__</h1>
<p>Entra con tu cuenta de MOS. __APP__ podrá <b>consultar</b> órdenes, producción,
inventario y facturación. No puede modificar nada.</p>
__ERROR__
<form method="post" action="/api/mcp/oauth/authorize">
__CAMPOS__
<label for="email">Correo</label>
<input id="email" name="email" type="email" required autocomplete="username" autofocus>
<label for="password">Contraseña</label>
<input id="password" name="password" type="password" required autocomplete="current-password">
<button type="submit">Autorizar</button>
</form>
<p class="n">Solo pueden conectarse las cuentas autorizadas para el conector.
Cada consulta queda registrada.</p>
</div></body></html>"""


def _pagina(params: dict, error: str = "", app: str = "Claude") -> HTMLResponse:
    campos = "".join(
        f'<input type="hidden" name="{k}" value="{_escapa(v)}">' for k, v in params.items() if v)
    html = (_PAGINA.replace("__CAMPOS__", campos)
            .replace("__APP__", _escapa(app))
            .replace("__ERROR__", f'<div class="e">{_escapa(error)}</div>' if error else ""))
    return HTMLResponse(html, status_code=200 if not error else 401)


def _escapa(v) -> str:
    return (str(v).replace("&", "&amp;").replace("<", "&lt;")
            .replace(">", "&gt;").replace('"', "&quot;"))


@router.get("/api/mcp/oauth/authorize")
async def autorizar_form(request: Request):
    q = dict(request.query_params)
    cliente = await db.oauth_clients.find_one({"client_id": q.get("client_id")}, {"_id": 0})
    if not cliente:
        return HTMLResponse("<p>client_id desconocido.</p>", status_code=400)
    if q.get("redirect_uri") not in (cliente.get("redirect_uris") or []):
        # No se redirige a una URI no registrada ni para dar el error: sería un
        # redirector abierto.
        return HTMLResponse("<p>redirect_uri no registrada para este cliente.</p>", status_code=400)
    if q.get("code_challenge_method") != "S256" or not q.get("code_challenge"):
        return HTMLResponse("<p>Se requiere PKCE con S256.</p>", status_code=400)
    return _pagina(q, app=cliente.get("client_name") or "Claude")


@router.post("/api/mcp/oauth/authorize")
async def autorizar(
    request: Request,
    email: str = Form(...),
    password: str = Form(...),
    client_id: str = Form(...),
    redirect_uri: str = Form(...),
    code_challenge: str = Form(...),
    code_challenge_method: str = Form("S256"),
    state: str = Form(""),
    scope: str = Form(""),
    resource: str = Form(""),
):
    q = {"client_id": client_id, "redirect_uri": redirect_uri, "state": state,
         "scope": scope, "code_challenge": code_challenge,
         "code_challenge_method": code_challenge_method, "resource": resource}

    cliente = await db.oauth_clients.find_one({"client_id": client_id}, {"_id": 0})
    if not cliente or redirect_uri not in (cliente.get("redirect_uris") or []):
        return HTMLResponse("<p>Cliente o redirect_uri inválidos.</p>", status_code=400)
    if code_challenge_method != "S256":
        return HTMLResponse("<p>Se requiere PKCE con S256.</p>", status_code=400)

    correo = (email or "").strip().lower()
    usuario = await db.users.find_one({"email": correo}, {"_id": 0})
    # Mismo mensaje para credencial mala y para cuenta sin permiso: distinguirlos
    # le diría a un extraño qué correos existen y cuáles están autorizados.
    generico = "Correo, contraseña o autorización inválidos."
    if (not usuario or not usuario.get("password_hash")
            or usuario.get("active") is False
            or not bcrypt.verify(password, usuario["password_hash"])):
        logger.warning("[mcp-oauth] intento fallido para %s", correo)
        return _pagina(q, generico, cliente.get("client_name") or "Claude")

    permitido = await db.connector_access.find_one(
        {"email": correo, "revoked": {"$ne": True}}, {"_id": 0})
    if not permitido:
        logger.warning("[mcp-oauth] %s no está en la lista del conector", correo)
        return _pagina(q, generico, cliente.get("client_name") or "Claude")

    codigo = secrets.token_urlsafe(32)
    await db.oauth_codes.insert_one({
        "code_hash": _hash(codigo),
        "client_id": client_id,
        "redirect_uri": redirect_uri,
        "code_challenge": code_challenge,
        "user_email": correo,
        "user_name": usuario.get("name") or correo,
        "expires_at": (_ahora() + VIDA_CODIGO).isoformat(),
        "used": False,
    })
    destino = redirect_uri + ("&" if "?" in redirect_uri else "?") + urlencode(
        {"code": codigo, **({"state": state} if state else {})})
    return RedirectResponse(destino, status_code=302)


# ── canje de tokens ─────────────────────────────────────────────────────────
async def _emitir(email: str, nombre: str, client_id: str) -> dict:
    acceso = "mos_at_" + secrets.token_urlsafe(32)
    refresco = "mos_rt_" + secrets.token_urlsafe(32)
    await db.oauth_tokens.insert_one({
        "access_hash": _hash(acceso),
        "refresh_hash": _hash(refresco),
        "user_email": email,
        "user_name": nombre,
        "client_id": client_id,
        "issued_at": _ahora().isoformat(),
        "access_expires_at": (_ahora() + VIDA_TOKEN).isoformat(),
        "refresh_expires_at": (_ahora() + VIDA_REFRESH).isoformat(),
        "revoked": False,
    })
    return {"access_token": acceso, "refresh_token": refresco,
            "token_type": "Bearer", "expires_in": int(VIDA_TOKEN.total_seconds()),
            "scope": "mos.read"}


@router.post("/api/mcp/oauth/token")
async def token(
    grant_type: str = Form(...),
    code: str = Form(""),
    redirect_uri: str = Form(""),
    client_id: str = Form(""),
    code_verifier: str = Form(""),
    refresh_token: str = Form(""),
):
    """Recibe form-urlencoded, no JSON: es lo que manda Claude (RFC 6749)."""
    if grant_type == "authorization_code":
        doc = await db.oauth_codes.find_one({"code_hash": _hash(code)}, {"_id": 0})
        if not doc or doc.get("used"):
            return JSONResponse({"error": "invalid_grant"}, status_code=400)
        if doc["expires_at"] < _ahora().isoformat():
            return JSONResponse({"error": "invalid_grant"}, status_code=400)
        if doc["client_id"] != client_id or doc["redirect_uri"] != redirect_uri:
            return JSONResponse({"error": "invalid_grant"}, status_code=400)
        # PKCE: base64url(sha256(verifier)) sin relleno debe dar el challenge.
        reto = base64.urlsafe_b64encode(
            hashlib.sha256(code_verifier.encode()).digest()).decode().rstrip("=")
        if reto != doc["code_challenge"]:
            return JSONResponse({"error": "invalid_grant"}, status_code=400)
        # Un solo uso: marcarlo ANTES de emitir cierra la ventana de repetición.
        await db.oauth_codes.update_one({"code_hash": doc["code_hash"]}, {"$set": {"used": True}})
        return JSONResponse(await _emitir(doc["user_email"], doc["user_name"], client_id))

    if grant_type == "refresh_token":
        doc = await db.oauth_tokens.find_one(
            {"refresh_hash": _hash(refresh_token), "revoked": {"$ne": True}}, {"_id": 0})
        if not doc or doc["refresh_expires_at"] < _ahora().isoformat():
            # `invalid_grant` y no otro código: es lo que Claude espera para
            # saber que debe rehacer el login en vez de reintentar en bucle.
            return JSONResponse({"error": "invalid_grant"}, status_code=400)
        # Rotación: el refresh viejo muere al usarse. Lo exige el spec para
        # clientes públicos, y limita el daño si uno se filtra.
        sigue = await db.connector_access.find_one(
            {"email": doc["user_email"], "revoked": {"$ne": True}}, {"_id": 0})
        if not sigue:
            return JSONResponse({"error": "invalid_grant"}, status_code=400)
        await db.oauth_tokens.update_one({"refresh_hash": doc["refresh_hash"]},
                                         {"$set": {"revoked": True}})
        return JSONResponse(await _emitir(doc["user_email"], doc["user_name"],
                                          doc.get("client_id") or client_id))

    return JSONResponse({"error": "unsupported_grant_type"}, status_code=400)


# ── lo que usa el endpoint MCP para validar un token de acceso ──────────────
async def usuario_de_token(crudo: str):
    """Devuelve {email, name} si el access token sirve, o None."""
    doc = await db.oauth_tokens.find_one(
        {"access_hash": _hash(crudo), "revoked": {"$ne": True}}, {"_id": 0})
    if not doc or doc["access_expires_at"] < _ahora().isoformat():
        return None
    # El acceso se revisa en CADA petición, no solo al entrar: quitar a alguien
    # de la lista debe cortarle el paso ya, sin esperar a que expire su token.
    permitido = await db.connector_access.find_one(
        {"email": doc["user_email"], "revoked": {"$ne": True}}, {"_id": 0})
    if not permitido:
        return None
    return {"email": doc["user_email"], "name": doc.get("user_name")}
