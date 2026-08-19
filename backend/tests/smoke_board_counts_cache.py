"""Smoke: caché de respuestas de /api/orders (listados y board-counts).

Contexto: en producción se midieron 8 llamadas a board-counts en 460 ms. Su
agregación no lleva $match, así que cada una recorre la colección `orders`
COMPLETA — ocho barridos seguidos, con el CPU disparado.

Lo que se fija aquí no es el valor devuelto (eso ya funcionaba) sino CUÁNTAS
VECES se golpea la base, que es lo que costaba:
  - una ráfaga de llamadas concurrentes hace UNA sola agregación (el lock),
  - las llamadas siguientes no vuelven a la base (la caché),
  - un broadcast de order_change invalida la caché (el contador no se pega),
  - un broadcast de production_update NO la invalida (invalidación quirúrgica:
    las capturas del taller no tocan la colección orders),
  - order_change con `boards` invalida solo esos tableros + MASTER +
    board_counts; los demás tableros sobreviven; boards dudoso → vaciar todo,
  - los bytes cacheados del listado son idénticos byte a byte al render
    default de FastAPI (incluso con datetimes crudos tipo import de Excel),
  - las búsquedas (?search=) no dejan llaves en el caché,
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
os.environ.setdefault("MASTER_API_KEY", "smoke_master_key")
os.environ.setdefault("INTERNAL_SYNC_TOKEN", "smoke_sync_token")
os.environ.setdefault("ENV", "local")
sys.path.insert(0, BE)
os.chdir(BE)

import pymongo  # noqa: E402
from passlib.hash import bcrypt  # noqa: E402
from datetime import datetime, timezone  # noqa: E402

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
    # created_at como datetime CRUDO (BSON date, como las que dejan los imports
    # de Excel): la serialización cacheada debe tragárselo igual que FastAPI.
    # Distintos entre sí para que el sort sea total y el orden determinista
    # (con empates, Mongo no garantiza orden estable entre dos queries).
    docs = [{"order_id": f"o{i}", "order_number": f"OC-{i}", "board": "BLANKS",
             "created_at": datetime(2026, 1, 1, 12, 0, i, tzinfo=timezone.utc)}
            for i in range(5)]
    sdb.orders.insert_many(
        docs
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

    # Mismo truco para find(): es lo que usa el listado /api/orders, y es la
    # métrica de la invalidación selectiva (qué tablero se recomputa y cuál no).
    consultas = {"n": 0}
    original_find = AsyncIOMotorCollection.find

    def contando_find(self, *a, **kw):
        if self.name == "orders":
            consultas["n"] += 1
        return original_find(self, *a, **kw)

    AsyncIOMotorCollection.find = contando_find

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
        # production_update se emite POR CADA captura del taller y no toca la
        # colección orders: NO debe invalidar (si invalidara, el caché viviría
        # permanentemente frío en horas de captura).
        await ws_manager.broadcast("production_update", {"order_id": "o0"})
        agregaciones["n"] = 0
        d = (await c.get("/api/orders/board-counts")).json()
        check("production_update NO invalida (sigue 5 BLANKS)",
              d.get("BLANKS") == 5, f"{d}")
        check("y no volvió a la base", agregaciones["n"] == 0, f"n={agregaciones['n']}")
        # Las mutaciones de órdenes emiten order_change, y eso SÍ invalida.
        await ws_manager.broadcast("order_change", {"action": "test"})
        agregaciones["n"] = 0
        d = (await c.get("/api/orders/board-counts")).json()
        check("tras order_change el contador se actualiza (6 BLANKS)",
              d.get("BLANKS") == 6, f"{d}")
        check("y volvió a consultar la base exactamente una vez",
              agregaciones["n"] == 1, f"n={agregaciones['n']}")

        print("\n== listados: bytes cacheados e invalidación selectiva ==")
        # A esta altura BLANKS tiene 6 órdenes: las 5 sembradas (con datetime
        # crudo) + OC-99 que insertó la sección anterior.
        r1 = await c.get("/api/orders?board=BLANKS")
        check("BLANKS responde 200 con 6 órdenes (5 con datetime crudo)",
              r1.status_code == 200 and len(r1.json()) == 6,
              f"{r1.status_code} {len(r1.json()) if r1.status_code == 200 else ''}")
        check("content-type es application/json",
              r1.headers.get("content-type", "").startswith("application/json"),
              r1.headers.get("content-type", ""))
        await c.get("/api/orders?board=EDI")
        r_master = await c.get("/api/orders?board=MASTER")
        check("MASTER excluye terminales (6 órdenes, sin las 3 de EDI)",
              len(r_master.json()) == 6, f"{len(r_master.json())}")
        consultas["n"] = 0
        r2 = await c.get("/api/orders?board=BLANKS")
        check("hit de caché: 0 consultas a la base", consultas["n"] == 0, f"n={consultas['n']}")
        check("y la respuesta es idéntica byte a byte", r2.content == r1.content, "difieren")
        # El contrato de los bytes: iguales al render default de FastAPI. La
        # ruta de búsqueda NO pasa por el caché (FastAPI serializa normal) y
        # 'oc-' matchea las 5 órdenes de BLANKS en el mismo orden.
        r_search = await c.get("/api/orders?board=BLANKS&search=oc-")
        check("bytes cacheados == render default de FastAPI (vía ?search=)",
              r_search.content == r1.content, "difieren")

        # order_change con boards=["EDI"]: EDI y MASTER caen, BLANKS sobrevive.
        await ws_manager.broadcast("order_change", {"action": "update", "boards": ["EDI"]})
        consultas["n"] = 0
        await c.get("/api/orders?board=BLANKS")
        check("BLANKS sobrevive a un cambio en EDI (0 consultas)",
              consultas["n"] == 0, f"n={consultas['n']}")
        await c.get("/api/orders?board=EDI")
        check("EDI sí se recomputa (1 consulta)", consultas["n"] == 1, f"n={consultas['n']}")
        await c.get("/api/orders?board=MASTER")
        check("MASTER siempre se recomputa (2 consultas)", consultas["n"] == 2, f"n={consultas['n']}")
        agregaciones["n"] = 0
        await c.get("/api/orders/board-counts")
        check("board_counts también cae con invalidación selectiva (1 agregación)",
              agregaciones["n"] == 1, f"n={agregaciones['n']}")

        # boards dudoso (None adentro, como delete de orden fantasma) → vaciar todo.
        await ws_manager.broadcast("order_change",
                                   {"action": "delete", "boards": [None, "PAPELERA DE RECICLAJE"]})
        consultas["n"] = 0
        await c.get("/api/orders?board=BLANKS")
        check("payload dudoso vació todo (BLANKS se recomputa)",
              consultas["n"] == 1, f"n={consultas['n']}")

        # Las búsquedas no dejan llaves ni locks (el autocomplete de arte pega
        # una request POR TECLA; cachearlas era una fuga sin tope).
        n_llaves = len(ordmod._orders_cache)
        n_locks = len(ordmod._orders_cache_locks)
        await c.get("/api/orders?search=OC-1")
        await c.get("/api/orders?search=OC-2")
        check("las búsquedas no dejan llaves en el caché",
              len(ordmod._orders_cache) == n_llaves and len(ordmod._orders_cache_locks) == n_locks,
              f"{list(ordmod._orders_cache)}")

        print("\n== sin sesión sigue sin poder consultarse ==")
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://smoke") as anon:
            r = await anon.get("/api/orders/board-counts")
            check("sin login -> 401/403", r.status_code in (401, 403), f"{r.status_code}")

    AsyncIOMotorCollection.aggregate = original
    AsyncIOMotorCollection.find = original_find


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
