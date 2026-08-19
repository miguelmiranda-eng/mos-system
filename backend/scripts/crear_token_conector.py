"""Crea, lista o revoca los tokens del conector MCP.

El token se IMPRIME UNA SOLA VEZ. En la base solo queda su hash: si se pierde,
no se recupera — se revoca y se crea otro. Es a propósito; guardar el token en
claro convertiría la colección en una lista de llaves usables, que es
exactamente el problema que este sistema ya tuvo con la MASTER_API_KEY.

Uso:
    python backend/scripts/crear_token_conector.py crear "Miguel - Claude"
    python backend/scripts/crear_token_conector.py listar
    python backend/scripts/crear_token_conector.py revocar "Miguel - Claude"
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


async def main():
    if len(sys.argv) < 2:
        raise SystemExit(__doc__)
    accion = sys.argv[1]
    if accion == "listar":
        await listar()
    elif accion in ("crear", "revocar"):
        if len(sys.argv) < 3:
            raise SystemExit(f"Falta el nombre: ...py {accion} \"Miguel - Claude\"")
        await (crear if accion == "crear" else revocar)(sys.argv[2])
    else:
        raise SystemExit(__doc__)


asyncio.run(main())
