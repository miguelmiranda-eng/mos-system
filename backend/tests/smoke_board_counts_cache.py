"""Smoke: caché y lock de /api/orders/board-counts.

Contexto: en producción se midieron 8 llamadas a este endpoint en 460 ms. Su
agregación no lleva $match, así que cada una recorre la colección `orders`
COMPLETA — ocho barridos seguidos, con el CPU disparado.

Lo que se fija aquí no es el valor devuelto (eso ya funcionaba) sino CUÁNTAS
VECES se golpea la base, que es lo que costaba:
  - una ráfaga de llamadas concurrentes hace UNA sola agregación (el lock),
  - las llamadas siguientes no vuelven a la base (la caché),
  - un broadcast invalida la caché, así que el contador nunca se queda pegado,
  - el resultado sigue siendo el mismo con caché que sin ella.

SEGURIDAD: base DESECHABLE, se niega contra prod, se borra al terminar.
USO: set MONGODB_URL=... ; backend/venv/Scripts/python.exe backend/tests/smoke_board_counts_cache.py
"""
import asyncio
import os
import sys

BE = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
SMOKE_DB = os.environ.get("SMOKE_DB_NAME", "mos-smoke-test")
PROD_DB = os.environ.get("PROD_DB_NAME", "mos-system")
MONGO = os.environ.get("MONGODB_URL") or os.environ.get("MONGO_URL")
if not MONGO:
    sys.exit("Falta MONGODB_URL")
if SMOKE_DB == PROD_DB:
    sys.exit(f"NEGADO: SMOKE_DB_NAME es la base de producción ('{PROD_DB}').")

os.environ["MONGODB_URL"] = MONGO
os.environ["DB_NAME"] = SMOKE_DB
os.environ.setdefault("JWT_SECRET", "smoke_secret")
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


def check(n, cond, det=""):
    global ok, fail
    if cond:
        ok += 1; print(f"   PASS  {n}")
    else:
        fail += 1; print(f"   FAIL  {n}  {det}")


def sembrar():
    print(f"== Sembrando {SMOKE_DB} ==")
    for c in ["users", "user_sessions", "orders"]:
        sdb[c].delete_many({})
    sdb.users.insert_one({
        "user_id": "u_a", "email": "a@test.local", "name": "Admin",
        "password_hash": bcrypt.hash("ad123"), "role": "admin", "active": True,
    })
    sdb.orders.insert_many(
        [{"order_id": f"o{i}", "order_number": f"OC-{i}", "board": "BLANKS"} for i in range(5)]
        + [{"order_id": f"e{i}", "order_number": f"ED-{i}", "board": "EDI"} for i in range(3)]
    )


async def main():
    sembrar()
    from httpx import ASGITransport, AsyncClient
    from server import app
    import routers.orders as ordmod
    from ws_manager import ws_manager

    # Contador de agregaciones reales contra la colección `orders`: es la
    # métrica que importa, porque cada una es un barrido completo.
    # Se parchea en la CLASE, no en una instancia: `db.orders` devuelve un
    # objeto Collection nuevo en cada acceso, así que parchear el que se obtiene
    # aquí no afecta al que usa el endpoint (por eso el contador daba 0).
    from motor.motor_asyncio import AsyncIOMotorCollection
    agregaciones = {"n": 0}
    original = AsyncIOMotorCollection.aggregate

    def contando(self, *a, **kw):
        if self.name == "orders":
            agregaciones["n"] += 1
        return original(self, *a, **kw)

    AsyncIOMotorCollection.aggregate = contando

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://smoke") as c:
        r = await c.post("/api/auth/login", json={"email": "a@test.local", "password": "ad123"})
        check("login admin", r.status_code == 200, f"{r.status_code}")

        print("\n== ráfaga concurrente: 8 llamadas a la vez ==")
        ordmod._orders_cache.clear()
        agregaciones["n"] = 0
        rs = await asyncio.gather(*[c.get("/api/orders/board-counts") for _ in range(8)])
        check("las 8 responden 200", all(x.status_code == 200 for x in rs),
              f"{[x.status_code for x in rs]}")
        cuerpos = [x.json() for x in rs]
        check("las 8 devuelven lo mismo", all(b == cuerpos[0] for b in cuerpos), f"{cuerpos[:2]}")
        check("el conteo es correcto (5 BLANKS / 3 EDI)",
              cuerpos[0].get("BLANKS") == 5 and cuerpos[0].get("EDI") == 3, f"{cuerpos[0]}")
        check(f"8 peticiones -> 1 sola agregación (fueron {agregaciones['n']})",
              agregaciones["n"] == 1, f"n={agregaciones['n']}")

        print("\n== las siguientes salen de caché ==")
        agregaciones["n"] = 0
        for _ in range(5):
            await c.get("/api/orders/board-counts")
        check(f"5 peticiones más -> 0 agregaciones (fueron {agregaciones['n']})",
              agregaciones["n"] == 0, f"n={agregaciones['n']}")

        print("\n== la caché no deja el contador pegado ==")
        # Un cambio hecho por fuera NO debe verse: es lo que hace la caché.
        sdb.orders.insert_one({"order_id": "nuevo", "order_number": "OC-99", "board": "BLANKS"})
        d = (await c.get("/api/orders/board-counts")).json()
        check("un cambio externo no se refleja mientras la caché está viva",
              d.get("BLANKS") == 5, f"{d}")
        # Cualquier actualización del sistema emite un broadcast, y eso invalida.
        await ws_manager.broadcast({"type": "test"})
        agregaciones["n"] = 0
        d = (await c.get("/api/orders/board-counts")).json()
        check("tras un broadcast el contador se actualiza (6 BLANKS)",
              d.get("BLANKS") == 6, f"{d}")
        check("y volvió a consultar la base exactamente una vez",
              agregaciones["n"] == 1, f"n={agregaciones['n']}")

        print("\n== sin sesión sigue sin poder consultarse ==")
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://smoke") as anon:
            r = await anon.get("/api/orders/board-counts")
            check("sin login -> 401/403", r.status_code in (401, 403), f"{r.status_code}")

    AsyncIOMotorCollection.aggregate = original


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
