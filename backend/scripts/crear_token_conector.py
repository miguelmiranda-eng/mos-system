"""Crea, lista o revoca los tokens del conector MCP.

El token se IMPRIME UNA SOLA VEZ. En la base solo queda su hash: si se pierde,
no se recupera — se revoca y se crea otro. Es a propósito; guardar el token en
claro convertiría la colección en una lista de llaves usables, que es
exactamente el problema que este sistema ya tuvo con la MASTER_API_KEY.

ADEMAS: la lista de quien puede conectarse por OAuth
Claude no deja pegar un token: la persona entra con su cuenta de MOS. Pero no
basta con tener cuenta — el correo tiene que estar en esta lista. Se autorizo
que el conector muestre montos facturados y hay 27 cuentas admin/supersu,
demasiadas para ese dato.

Uso:
    python backend/scripts/crear_token_conector.py permitir miguel@prosper-mfg.com
    python backend/scripts/crear_token_conector.py quitar   miguel@prosper-mfg.com
    python backend/scripts/crear_token_conector.py acceso

    python backend/scripts/crear_token_conector.py crear "Miguel - script"
    python backend/scripts/crear_token_conector.py listar
    python backend/scripts/crear_token_conector.py revocar "Miguel - script"
"""
import asyncio
import hashlib
import os
import secrets
import sys
from datetime import datetime, timezone

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

MONGO = os.environ.get("MONGODB_URL") or os.environ.get("MONGO_URL")
if not MONGO:
    try:
        from dotenv import dotenv_values
        MONGO = (dotenv_values(os.path.join(os.path.dirname(__file__), "..", ".env"))
                 or {}).get("MONGODB_URL")
    except Exception:
        MONGO = None
if not MONGO:
    raise SystemExit("Falta MONGODB_URL en el entorno (o en backend/.env)")

from motor.motor_asyncio import AsyncIOMotorClient  # noqa: E402

DB = os.environ.get("DB_NAME") or "mos-system"
db = AsyncIOMotorClient(MONGO)[DB]


async def crear(nombre: str):
    if await db.connector_tokens.find_one({"name": nombre, "revoked": {"$ne": True}}):
        raise SystemExit(f"Ya existe un token activo llamado {nombre!r}. Revócalo primero.")
    token = "mos_mcp_" + secrets.token_urlsafe(32)
    await db.connector_tokens.insert_one({
        "token_hash": hashlib.sha256(token.encode()).hexdigest(),
        "name": nombre,
        "revoked": False,
        "calls": 0,
        "created_at": datetime.now(timezone.utc).isoformat(),
    })
    print("\n" + "=" * 68)
    print(f"  Token para: {nombre}")
    print("=" * 68)
    print(f"\n  {token}\n")
    print("  Se muestra UNA SOLA VEZ. Cópialo ahora.")
    print("  En la base solo queda su hash; si lo pierdes, revócalo y crea otro.")
    print("\n  Al dar de alta el conector, la URL es:")
    print("    https://mosdatabase-backend.k9pirj.easypanel.host/api/mcp")
    print("  y el token va como  Authorization: Bearer <token>")
    print("=" * 68 + "\n")


async def listar():
    docs = await db.connector_tokens.find({}, {"_id": 0, "token_hash": 0}).to_list(100)
    if not docs:
        print("No hay tokens.")
        return
    print(f"{'nombre':28} {'estado':10} {'usos':>6}  último uso")
    print("-" * 74)
    for d in docs:
        estado = "REVOCADO" if d.get("revoked") else "activo"
        print(f"{str(d.get('name'))[:28]:28} {estado:10} {d.get('calls', 0):>6}  "
              f"{(d.get('last_used_at') or '—')[:19]}")


async def revocar(nombre: str):
    r = await db.connector_tokens.update_one(
        {"name": nombre, "revoked": {"$ne": True}}, {"$set": {
            "revoked": True, "revoked_at": datetime.now(timezone.utc).isoformat()}})
    if r.modified_count:
        print(f"Token {nombre!r} revocado. Deja de servir en la siguiente petición.")
    else:
        print(f"No había un token activo llamado {nombre!r}.")


async def permitir(correo: str):
    correo = correo.strip().lower()
    u = await db.users.find_one({"email": correo}, {"_id": 0, "name": 1, "role": 1})
    if not u:
        raise SystemExit(f"No existe un usuario de MOS con el correo {correo!r}. "
                         f"Primero dale acceso a MOS.")
    await db.connector_access.update_one(
        {"email": correo},
        {"$set": {"email": correo, "revoked": False,
                  "added_at": datetime.now(timezone.utc).isoformat()}},
        upsert=True)
    print(f"Autorizado: {u.get('name')} <{correo}> (rol {u.get('role')})")
    print("Ya puede agregar el conector en Claude y entrar con su cuenta de MOS.")


async def quitar(correo: str):
    correo = correo.strip().lower()
    r = await db.connector_access.update_one(
        {"email": correo}, {"$set": {"revoked": True,
                                     "revoked_at": datetime.now(timezone.utc).isoformat()}})
    # Tambien se matan sus tokens vivos: el acceso se revisa en cada peticion,
    # pero revocarlos corta la sesion ya en vez de esperar a que caduque.
    await db.oauth_tokens.update_many({"user_email": correo}, {"$set": {"revoked": True}})
    print(f"Acceso retirado a {correo}." if r.modified_count else f"{correo} no estaba autorizado.")


async def acceso():
    docs = await db.connector_access.find({}, {"_id": 0}).to_list(100)
    if not docs:
        print("Nadie autorizado todavia. Usa: ...py permitir correo@prosper-mfg.com")
        return
    print(f"{'correo':38} estado")
    print("-" * 52)
    for d in docs:
        print(f"{d['email']:38} {'RETIRADO' if d.get('revoked') else 'autorizado'}")


async def main():
    if len(sys.argv) < 2:
        raise SystemExit(__doc__)
    accion = sys.argv[1]
    if accion == "listar":
        await listar()
    elif accion == "acceso":
        await acceso()
    elif accion in ("permitir", "quitar"):
        if len(sys.argv) < 3:
            raise SystemExit(f"Falta el correo: ...py {accion} alguien@prosper-mfg.com")
        await (permitir if accion == "permitir" else quitar)(sys.argv[2])
    elif accion in ("crear", "revocar"):
        if len(sys.argv) < 3:
            raise SystemExit(f"Falta el nombre: ...py {accion} \"Miguel - Claude\"")
        await (crear if accion == "crear" else revocar)(sys.argv[2])
    else:
        raise SystemExit(__doc__)


asyncio.run(main())
