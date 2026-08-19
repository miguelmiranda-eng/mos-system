"""Smoke del flujo OAuth del conector MCP — el que Claude exige de verdad.

POR QUE EXISTE
Con token fijo en la cabecera el servidor respondia perfecto, pero Claude
fallaba con "Couldn't register with ... sign-in service": su interfaz no ofrece
pegar un token, intenta REGISTRARSE por OAuth. Aqui se fija el camino completo.

LO QUE SE FIJA
Descubrimiento (sin esto Claude no encuentra donde autenticarse):
  · el 401 del endpoint MCP trae WWW-Authenticate con resource_metadata,
  · /.well-known/oauth-protected-resource existe en la raiz Y bajo /api/mcp,
  · el campo `resource` coincide EXACTO con la URL que el usuario escribe,
  · los metadatos del servidor anuncian S256 y el registration_endpoint.

Flujo completo, de punta a punta:
  · registro dinamico del cliente,
  · pantalla de login,
  · credencial mala -> no entra,
  · usuario valido pero NO autorizado -> no entra (y con el MISMO mensaje, para
    no delatar que correos existen),
  · usuario autorizado -> codigo -> token -> el endpoint MCP lo acepta,
  · refresh rota el token viejo,
  · quitar a alguien de la lista le corta el paso AL INSTANTE, sin esperar a
    que caduque su token.

Seguridad del protocolo:
  · PKCE obligatorio: sin S256 no arranca, y un verifier equivocado no canjea,
  · el codigo es de un solo uso,
  · redirect_uri no registrada se rechaza (si no, es un redirector abierto),
  · codigos y tokens se guardan HASHEADOS.

SEGURIDAD: base DESECHABLE, se niega contra prod, se borra al terminar.
USO: set MONGODB_URL=... ; backend/venv/Scripts/python.exe backend/tests/smoke_mcp_oauth.py
"""
import asyncio
import base64
import hashlib
import os
import sys

BE = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
SMOKE_DB = os.environ.get("SMOKE_DB_NAME", "mos-smoke-mcp-oauth")
PROD_DB = os.environ.get("PROD_DB_NAME", "mos-system")
MONGO = os.environ.get("MONGODB_URL") or os.environ.get("MONGO_URL")
if not MONGO:
    sys.exit("Falta MONGODB_URL")
if SMOKE_DB == PROD_DB:
    sys.exit(f"NEGADO: SMOKE_DB_NAME es la base de producción ('{PROD_DB}').")

BASE = "https://mos.example.test"
os.environ["MONGODB_URL"] = MONGO
os.environ["DB_NAME"] = SMOKE_DB
os.environ["MCP_PUBLIC_URL"] = BASE
os.environ.setdefault("JWT_SECRET", "smoke_secret")
os.environ.setdefault("MASTER_API_KEY", "smoke_master_key")
os.environ.setdefault("INTERNAL_SYNC_TOKEN", "smoke_sync_token")
os.environ.setdefault("ENV", "local")
sys.path.insert(0, BE)
os.chdir(BE)

import pymongo  # noqa: E402
from passlib.hash import bcrypt  # noqa: E402

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

raw = pymongo.MongoClient(MONGO)
sdb = raw[SMOKE_DB]
ok = fail = 0

REDIR = "https://claude.ai/api/mcp/auth_callback"
VERIFIER = "un-verificador-pkce-suficientemente-largo-para-el-spec-123456"
RETO = base64.urlsafe_b64encode(hashlib.sha256(VERIFIER.encode()).digest()).decode().rstrip("=")


def check(n, cond, det=""):
    global ok, fail
    if cond:
        ok += 1
        print(f"   PASS  {n}")
    else:
        fail += 1
        print(f"   FAIL  {n}  {det}")


def sembrar():
    print(f"== Sembrando {SMOKE_DB} ==")
    for c in ["users", "orders", "connector_access", "connector_tokens",
              "connector_calls", "oauth_clients", "oauth_codes", "oauth_tokens",
              "oauth_consents", "user_sessions"]:
        sdb[c].delete_many({})
    sdb.users.insert_many([
        {"user_id": "u1", "email": "jefe@prosper-mfg.com", "name": "El Jefe",
         "password_hash": bcrypt.hash("clave-del-jefe"), "role": "admin", "active": True},
        {"user_id": "u2", "email": "ajeno@prosper-mfg.com", "name": "Ajeno",
         "password_hash": bcrypt.hash("otra-clave"), "role": "admin", "active": True},
        # Como los 88 usuarios reales que entran con Google: SIN contraseña local.
        {"user_id": "u3", "email": "google@prosper-mfg.com", "name": "Con Google",
         "role": "supersu", "active": True},
    ])
    # Solo el jefe esta autorizado. El "ajeno" tiene cuenta de MOS y hasta rol
    # admin: sirve para probar que tener cuenta NO alcanza.
    sdb.connector_access.insert_many([
        {"email": "jefe@prosper-mfg.com", "revoked": False},
        {"email": "google@prosper-mfg.com", "revoked": False},
    ])
    # Sesión de MOS abierta en el navegador, como tras entrar con Google.
    from datetime import datetime, timedelta, timezone
    sdb.user_sessions.insert_one({
        "session_token": "sesion-de-google",
        "user_id": "u3",
        "expires_at": (datetime.now(timezone.utc) + timedelta(days=7)).isoformat(),
    })
    sdb.orders.insert_one({"order_id": "o1", "order_number": "2653", "board": "EMPAQUE",
                           "client": "GOODIE TWO SLEEVES", "quantity": 222, "invoice": 1500.5})


async def main():
    sembrar()
    from httpx import ASGITransport, AsyncClient
    from server import app

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://smoke") as c:
        print("\n== 1. Descubrimiento: como Claude encuentra el login ==")
        r = await c.post("/api/mcp", json={"jsonrpc": "2.0", "id": 1, "method": "tools/list"})
        wa = r.headers.get("www-authenticate", "")
        check("el 401 trae resource_metadata",
              r.status_code == 401 and "resource_metadata=" in wa, f"{r.status_code} {wa}")
        check("apunta al documento correcto",
              f"{BASE}/.well-known/oauth-protected-resource" in wa, wa)

        for ruta in ("/.well-known/oauth-protected-resource",
                     "/.well-known/oauth-protected-resource/api/mcp"):
            r = await c.get(ruta)
            check(f"{ruta} responde 200", r.status_code == 200, f"{r.status_code}")
        d = r.json()
        check("`resource` coincide EXACTO con la URL del conector",
              d["resource"] == f"{BASE}/api/mcp", f"{d.get('resource')}")
        check("apunta al servidor de autorizacion",
              d["authorization_servers"] == [BASE], f"{d.get('authorization_servers')}")

        r = await c.get("/.well-known/oauth-authorization-server")
        m = r.json()
        check("anuncia PKCE S256 (Claude lo verifica antes de empezar)",
              m["code_challenge_methods_supported"] == ["S256"], f"{m}")
        check("anuncia el registration_endpoint (DCR)",
              m["registration_endpoint"].endswith("/api/mcp/oauth/register"), f"{m}")

        print("\n== 2. Registro dinamico del cliente ==")
        r = await c.post("/api/mcp/oauth/register",
                         json={"redirect_uris": [REDIR], "client_name": "Claude"})
        check("register responde 201", r.status_code == 201, f"{r.status_code} {r.text[:90]}")
        cid = r.json()["client_id"]
        check("devuelve client_id y auth method 'none' (cliente publico)",
              bool(cid) and r.json()["token_endpoint_auth_method"] == "none")

        print("\n== 3. La pantalla de login ==")
        q = {"client_id": cid, "redirect_uri": REDIR, "state": "xyz",
             "code_challenge": RETO, "code_challenge_method": "S256"}
        r = await c.get("/api/mcp/oauth/authorize", params=q)
        check("muestra el formulario", r.status_code == 200 and "Conectar MOS" in r.text)
        check("dice que es solo consulta", "No puede modificar nada" in r.text)

        r = await c.get("/api/mcp/oauth/authorize", params={**q, "redirect_uri": "https://malo.test/x"})
        check("redirect_uri no registrada -> 400 (no es redirector abierto)",
              r.status_code == 400, f"{r.status_code}")
        r = await c.get("/api/mcp/oauth/authorize", params={**q, "code_challenge_method": "plain"})
        check("sin PKCE S256 -> 400", r.status_code == 400, f"{r.status_code}")

        print("\n== 4. Quien entra y quien no ==")
        form = dict(q)
        r = await c.post("/api/mcp/oauth/authorize",
                         data={**form, "email": "jefe@prosper-mfg.com", "password": "mala"})
        check("contrasena incorrecta -> no entra", r.status_code == 401, f"{r.status_code}")
        malo = r.text

        r = await c.post("/api/mcp/oauth/authorize",
                         data={**form, "email": "ajeno@prosper-mfg.com", "password": "otra-clave"})
        check("cuenta valida pero NO autorizada -> no entra", r.status_code == 401, f"{r.status_code}")
        check("mismo mensaje que la contrasena mala (no delata correos)",
              ("Correo, contraseña o autorización inválidos." in r.text
               and "Correo, contraseña o autorización inválidos." in malo))

        r = await c.post("/api/mcp/oauth/authorize",
                         data={**form, "email": "jefe@prosper-mfg.com",
                               "password": "clave-del-jefe"},
                         follow_redirects=False)
        check("el jefe entra y lo redirige con codigo", r.status_code == 302, f"{r.status_code}")
        loc = r.headers.get("location", "")
        check("conserva el state", "state=xyz" in loc, loc[:110])
        codigo = loc.split("code=")[1].split("&")[0]
        check("el codigo se guarda HASHEADO",
              sdb.oauth_codes.count_documents({"code_hash": hashlib.sha256(codigo.encode()).hexdigest()}) == 1
              and sdb.oauth_codes.count_documents({"code": codigo}) == 0)

        print("\n== 4b. Cuenta de Google: sin contrasena, con sesion de MOS ==")
        # 88 de 125 usuarios reales entran con Google y NO tienen password_hash.
        # Pedirles contrasena era pedirles algo que no existe.
        gal = {"Cookie": "session_token=sesion-de-google"}
        r = await c.get("/api/mcp/oauth/authorize", params=q, headers=gal)
        check("con sesion de MOS NO pide contrasena",
              "Sesión de MOS activa" in r.text and "Contraseña de MOS" not in r.text,
              r.text[:120])
        check("dice de quien es la sesion", "google@prosper-mfg.com" in r.text)
        nonce = r.text.split('name="consent_nonce" value="')[1].split('"')[0]

        r = await c.post("/api/mcp/oauth/authorize", headers=gal,
                         data={**form, "consent_nonce": nonce}, follow_redirects=False)
        check("un clic en Autorizar entrega el codigo", r.status_code == 302, f"{r.status_code}")
        cod_g = r.headers["location"].split("code=")[1].split("&")[0]

        r2 = await c.post("/api/mcp/oauth/authorize", headers=gal,
                          data={**form, "consent_nonce": nonce}, follow_redirects=False)
        check("el nonce es de un solo uso", r2.status_code == 401, f"{r2.status_code}")

        r = await c.post("/api/mcp/oauth/token",
                         data={"grant_type": "authorization_code", "code": cod_g,
                               "redirect_uri": REDIR, "client_id": cid,
                               "code_verifier": VERIFIER})
        check("y ese codigo canjea token", r.status_code == 200, f"{r.text[:90]}")

        r = await c.get("/api/mcp/oauth/authorize", params=q)
        check("sin sesion, sigue el formulario y explica lo de Google",
              "Contraseña de MOS" in r.text and "Google" in r.text)

        print("\n== 5. Canje del codigo (PKCE de verdad) ==")
        base_form = {"grant_type": "authorization_code", "code": codigo,
                     "redirect_uri": REDIR, "client_id": cid}
        r = await c.post("/api/mcp/oauth/token", data={**base_form, "code_verifier": "equivocado"})
        check("verifier equivocado -> invalid_grant",
              r.status_code == 400 and r.json()["error"] == "invalid_grant", f"{r.text[:80]}")

        r = await c.post("/api/mcp/oauth/token", data={**base_form, "code_verifier": VERIFIER})
        check("verifier correcto -> token", r.status_code == 200, f"{r.text[:110]}")
        tok = r.json()
        check("devuelve access, refresh y expires_in",
              tok.get("access_token") and tok.get("refresh_token") and tok.get("expires_in"))
        check("el access token se guarda HASHEADO",
              sdb.oauth_tokens.count_documents({"access_token": tok["access_token"]}) == 0)

        r = await c.post("/api/mcp/oauth/token", data={**base_form, "code_verifier": VERIFIER})
        check("el codigo es de UN SOLO uso",
              r.status_code == 400 and r.json()["error"] == "invalid_grant", f"{r.text[:80]}")

        print("\n== 6. El token sirve en el endpoint MCP ==")
        h = {"Authorization": f"Bearer {tok['access_token']}",
             "MCP-Protocol-Version": "2026-07-28", "Mcp-Method": "tools/list"}
        r = await c.post("/api/mcp", headers=h, json={
            "jsonrpc": "2.0", "id": 1, "method": "tools/list",
            "params": {"_meta": {"io.modelcontextprotocol/protocolVersion": "2026-07-28"}}})
        check("tools/list con token OAuth -> 8 herramientas",
              r.status_code == 200 and len(r.json()["result"]["tools"]) == 8, f"{r.text[:110]}")

        h2 = {**h, "Mcp-Method": "tools/call", "Mcp-Name": "estado_orden"}
        r = await c.post("/api/mcp", headers=h2, json={
            "jsonrpc": "2.0", "id": 2, "method": "tools/call",
            "params": {"name": "estado_orden", "arguments": {"orden": "2653"},
                       "_meta": {"io.modelcontextprotocol/protocolVersion": "2026-07-28"}}})
        d = r.json()["result"]["structuredContent"]
        check("y responde datos reales", d.get("tablero") == "EMPAQUE", f"{d}")
        check("la consulta queda registrada a nombre del jefe",
              sdb.connector_calls.count_documents({"token_name": "jefe@prosper-mfg.com"}) >= 1)

        print("\n== 7. Refresh con rotacion ==")
        r = await c.post("/api/mcp/oauth/token",
                         data={"grant_type": "refresh_token",
                               "refresh_token": tok["refresh_token"], "client_id": cid})
        check("el refresh entrega un token nuevo", r.status_code == 200, f"{r.text[:90]}")
        nuevo = r.json()
        check("el access token cambio", nuevo["access_token"] != tok["access_token"])
        r = await c.post("/api/mcp/oauth/token",
                         data={"grant_type": "refresh_token",
                               "refresh_token": tok["refresh_token"], "client_id": cid})
        check("el refresh viejo ya no sirve (rotacion)",
              r.status_code == 400 and r.json()["error"] == "invalid_grant", f"{r.text[:80]}")

        print("\n== 8. Quitar el acceso corta AL INSTANTE ==")
        sdb.connector_access.update_one({"email": "jefe@prosper-mfg.com"},
                                        {"$set": {"revoked": True}})
        r = await c.post("/api/mcp",
                         headers={"Authorization": f"Bearer {nuevo['access_token']}",
                                  "MCP-Protocol-Version": "2026-07-28", "Mcp-Method": "tools/list"},
                         json={"jsonrpc": "2.0", "id": 3, "method": "tools/list",
                               "params": {"_meta": {"io.modelcontextprotocol/protocolVersion": "2026-07-28"}}})
        check("token vigente pero fuera de la lista -> 401",
              r.status_code == 401, f"{r.status_code}")


_err = None
try:
    asyncio.run(main())
except Exception:
    import traceback
    _err = traceback.format_exc()
finally:
    try:
        raw.drop_database(SMOKE_DB)
    except Exception:
        pass
    print(f"\n== Base {SMOKE_DB} eliminada ==")
    if _err:
        print("EXCEPCIÓN:\n" + _err)
    print(f"{ok} PASS · {fail} FAIL")
    sys.exit(1 if (fail or _err) else 0)
