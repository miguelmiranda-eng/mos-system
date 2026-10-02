"""Smoke: cambios de rendimiento del 2026-10 (diagnóstico de lentitud).

Lo que se fija aquí:
  - order_change lleva en `boards` el tablero FINAL cuando una automatización
    mueve la orden a un tercer tablero (update, move, bulk-move, create). Los
    clientes ahora solo recargan si su tablero viene en `boards`: si faltara el
    tablero final, quien lo ve no se enteraría (y la caché del server tampoco).
  - /api/scheduled-shipments/map da exactamente el mismo mapa que el Dashboard
    armaba antes desde el listado completo.
  - La búsqueda por corpus ve los cambios después de un order_change (no se
    queda con el corpus viejo) y no los ve si nadie avisó (mismo contrato que
    la caché de listados).

SEGURIDAD: base DESECHABLE, se niega contra prod, se borra al terminar.
USO: set MONGODB_URL=mongodb://localhost:27017 ;
     backend/venv/Scripts/python.exe backend/tests/smoke_rendimiento_oct2026.py
"""
import asyncio
import time
import os
import sys

BE = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
SMOKE_DB = os.environ.get("SMOKE_DB_NAME", "mos-smoke-rendimiento")
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
    for c in sdb.list_collection_names():
        sdb[c].delete_many({})
    sdb.users.insert_one({
        "user_id": "u_a", "email": "a@test.local", "name": "Admin",
        "password_hash": bcrypt.hash("ad123"), "role": "admin", "active": True,
    })
    sdb.orders.insert_many([
        {"order_id": f"o{i}", "order_number": f"RN-{i}", "board": "BLANKS", "client": "ACME",
         "created_at": f"2026-01-01T12:00:0{i}+00:00"} for i in range(4)
    ])
    # Programaciones: dos para la misma orden (la última escritura en el
    # recorrido created_at desc gana, igual que en el Dashboard viejo).
    sdb.scheduled_shipments.insert_many([
        {"shipment_id": "s1", "order_number": "RN-0", "scheduled_export_date": "2026-10-05",
         "created_at": "2026-09-01T00:00:00+00:00"},
        {"shipment_id": "s2", "order_number": "RN-0", "scheduled_export_date": "2026-10-09",
         "created_at": "2026-09-02T00:00:00+00:00"},
        {"shipment_id": "s3", "order_number": "RN-1", "scheduled_export_date": None,
         "created_at": "2026-09-03T00:00:00+00:00"},
        {"shipment_id": "s4", "order_number": "", "scheduled_export_date": "2026-10-10",
         "created_at": "2026-09-04T00:00:00+00:00"},
    ])


def automatizar(trigger, target):
    sdb.automations.delete_many({})
    sdb.automations.insert_one({
        "automation_id": f"auto_{trigger}", "name": f"auto {trigger}", "trigger_type": trigger,
        "trigger_conditions": {}, "action_type": "move_board",
        "action_params": {"target_board": target}, "is_active": True, "boards": [],
    })


async def main():
    sembrar()
    from httpx import ASGITransport, AsyncClient
    from server import app
    import routers.orders as ordmod
    from ws_manager import ws_manager

    eventos = []
    real = ws_manager.broadcast

    async def espia(event_type, data=None):
        eventos.append((event_type, data or {}))
        return await real(event_type, data)
    ws_manager.broadcast = espia

    def ultimo_order_change():
        oc = [d for t, d in eventos if t == "order_change"]
        return oc[-1] if oc else {}

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://smoke") as c:
        r = await c.post("/api/auth/login", json={"email": "a@test.local", "password": "ad123"})
        check("login admin", r.status_code == 200, f"{r.status_code}")

        print("\n== update con automatización que lleva la orden a un 3er tablero ==")
        automatizar("move", "NECK")
        r = await c.put("/api/orders/o0", json={"board": "SCREENS"})
        check("PUT responde 200", r.status_code == 200, f"{r.status_code} {r.text[:200]}")
        final = sdb.orders.find_one({"order_id": "o0"})["board"]
        check("la automatización sí movió la orden a NECK", final == "NECK", final)
        b = ultimo_order_change().get("boards") or []
        check("boards incluye origen, destino pedido y final",
              {"BLANKS", "SCREENS", "NECK"} <= set(b), f"{b}")

        print("\n== move con automatización ==")
        r = await c.post("/api/orders/o1/move", json={"board": "SCREENS"})
        check("move responde 200", r.status_code == 200, f"{r.status_code} {r.text[:200]}")
        b = ultimo_order_change().get("boards") or []
        check("boards de move incluye el tablero final (NECK)",
              {"BLANKS", "SCREENS", "NECK"} <= set(b), f"{b}")

        print("\n== bulk-move con automatización ==")
        r = await c.post("/api/orders/bulk-move", json={"order_ids": ["o2"], "board": "SCREENS"})
        check("bulk-move responde 200", r.status_code == 200, f"{r.status_code} {r.text[:200]}")
        b = ultimo_order_change().get("boards") or []
        check("boards de bulk-move incluye el tablero final (NECK)",
              {"BLANKS", "SCREENS", "NECK"} <= set(b), f"{b}")

        print("\n== create con automatización ==")
        automatizar("create", "EJEMPLOS")
        r = await c.post("/api/orders", json={"order_number": "RN-NEW", "board": "SCHEDULING", "client": "ACME"})
        check("create responde 200", r.status_code == 200, f"{r.status_code} {r.text[:200]}")
        b = ultimo_order_change().get("boards") or []
        check("boards de create incluye el tablero final (EJEMPLOS)",
              {"SCHEDULING", "EJEMPLOS"} <= set(b), f"{b}")
        sdb.automations.delete_many({})

        print("\n== sin automatización: boards no cambia ==")
        r = await c.put("/api/orders/o3", json={"board": "SCREENS"})
        b = ultimo_order_change().get("boards") or []
        check("update simple: boards == [BLANKS, SCREENS]", b == ["BLANKS", "SCREENS"], f"{b}")

        print("\n== /scheduled-shipments/map ==")
        r = await c.get("/api/scheduled-shipments/map")
        check("map responde 200", r.status_code == 200, f"{r.status_code}")
        nuevo = r.json().get("map")
        lst = (await c.get("/api/scheduled-shipments")).json()
        viejo = {}
        for it in lst.get("items", []):
            if it.get("order_number"):
                viejo[it["order_number"]] = it.get("scheduled_export_date") or ""
        check("map == el mapa que el Dashboard armaba del listado", nuevo == viejo, f"{nuevo} vs {viejo}")
        check("la más antigua gana en RN-0 (mismo recorrido que antes)",
              nuevo.get("RN-0") == "2026-10-05", f"{nuevo}")
        r = await c.get("/api/scheduled-shipments/map", headers={"Authorization": "Bearer nada"},
                        cookies={"session_token": "nada"})
        check("map sin sesión válida -> 401", r.status_code == 401, f"{r.status_code}")

        print("\n== corpus de búsqueda ==")
        r = await c.get("/api/orders?search=RN-3")
        check("encuentra RN-3", [o["order_number"] for o in r.json()] == ["RN-3"], r.text[:200])
        sdb.orders.update_one({"order_id": "o3"}, {"$set": {"client": "ZETA-CORP"}})
        r = await c.get("/api/orders?search=zeta-corp")
        check("cambio externo SIN aviso no se ve (corpus vigente)", r.json() == [], r.text[:200])
        await ws_manager.broadcast("order_change", {"action": "test", "boards": ["SCREENS"]})
        r = await c.get("/api/orders?search=zeta-corp")
        check("tras order_change el corpus se reconstruye y lo encuentra",
              [o["order_id"] for o in r.json()] == ["o3"], r.text[:200])
        check("la búsqueda no deja llaves en la caché de listados",
              not any(k[0] == "orders" and k[1] is None and k[2] != 1000 for k in ordmod._orders_cache
                      if isinstance(k, tuple)), f"{list(ordmod._orders_cache)}")

        print("\n== corpus incremental (2026-10-02) ==")
        # Corpus caliente
        await c.get("/api/orders?search=RN-")
        antes = ordmod._search_corpus["entries"]
        r = await c.put("/api/orders/o3", json={"client": "OMEGA-PATCH"})
        check("PUT 200", r.status_code == 200, r.text[:200])
        check("update con order_id solo marca sucia (no tira el corpus)",
              ordmod._search_corpus["entries"] is antes and "o3" in ordmod._search_corpus["dirty"],
              f"dirty={ordmod._search_corpus['dirty']}")
        r = await c.get("/api/orders?search=omega-patch")
        check("la búsqueda ve el cambio parchado", [o["order_id"] for o in r.json()] == ["o3"], r.text[:200])
        check("y siguió siendo el MISMO corpus (sin reconstruir)",
              ordmod._search_corpus["entries"] is antes and not ordmod._search_corpus["dirty"])
        r = await c.post("/api/orders/o3/move", json={"board": "BLANKS"})
        check("move responde 200", r.status_code == 200, f"{r.status_code} {r.text[:300]}")
        r = await c.get("/api/orders?search=omega-patch")
        check("move parchado: el resultado trae el tablero nuevo",
              r.json() and r.json()[0]["board"] == "BLANKS", r.text[:200])
        check("move tampoco reconstruyó", ordmod._search_corpus["entries"] is antes)
        r = await c.delete("/api/orders/o3")
        r1 = (await c.get("/api/orders?search=omega-patch")).json()
        r2 = (await c.get("/api/orders?search=omega-patch&skip=0&limit=200&hide_trash=true")).json()
        check("delete (papelera) parchado: sin hide_trash sigue apareciendo en papelera",
              r1 and r1[0]["board"] == "PAPELERA DE RECICLAJE", f"{r1}")
        check("con hide_trash no aparece y el total es 0",
              r2.get("total") == 0 and r2.get("items") == [], f"{r2}")
        r = await c.post("/api/orders", json={"order_number": "RN-NUEVA-77", "board": "BLANKS", "client": "ACME"})
        check("create tira el corpus completo", ordmod._search_corpus["entries"] is None)
        r = await c.get("/api/orders?search=rn-nueva-77")
        check("y la orden nueva se encuentra", len(r.json()) == 1, r.text[:200])
        # Orden que el corpus no conocía marcada como sucia -> reconstruye
        sdb.orders.insert_one({"order_id": "fantasma1", "order_number": "RN-FANT", "board": "BLANKS",
                               "created_at": "2026-01-02T00:00:00+00:00"})
        ordmod._search_corpus_mark({"action": "update", "order_id": "fantasma1"})
        r = await c.get("/api/orders?search=rn-fant")
        check("orden desconocida marcada sucia -> reconstrucción y aparece",
              [o["order_id"] for o in r.json()] == ["fantasma1"], r.text[:200])
        # Corte por generación: un cambio completo durante la lectura no se pisa
        ordmod._search_corpus["entries"] = None
        # Se parchea en la CLASE: db.orders devuelve un objeto nuevo en cada acceso.
        from motor.motor_asyncio import AsyncIOMotorCollection
        real_find = AsyncIOMotorCollection.find
        disparado = {"v": False}

        def find_con_cambio(self, *a, **kw):
            if self.name == "orders" and not disparado["v"]:
                disparado["v"] = True
                ordmod._search_corpus_mark({"action": "create"})   # cambio completo a media lectura
            return real_find(self, *a, **kw)
        AsyncIOMotorCollection.find = find_con_cambio
        try:
            await c.get("/api/orders?search=rn-")
        finally:
            AsyncIOMotorCollection.find = real_find
        check("(el cambio sí se disparó a media lectura)", disparado["v"])
        check("cambio completo durante la lectura: el resultado NO se guarda",
              ordmod._search_corpus["entries"] is None)
        # TTL vencido: se sirve lo que hay y se rehace en segundo plano
        await c.get("/api/orders?search=rn-")
        viejo = ordmod._search_corpus["entries"]
        ordmod._search_corpus["ts"] -= 3600
        r = await c.get("/api/orders?search=rn-0")
        check("TTL vencido: responde con el corpus actual sin bloquear",
              r.status_code == 200 and ordmod._search_corpus["refreshing"] is True)
        for _ in range(50):
            if not ordmod._search_corpus["refreshing"]:
                break
            await asyncio.sleep(0.05)
        check("y la reconstrucción en segundo plano termina con corpus nuevo",
              ordmod._search_corpus["entries"] is not viejo
              and time.time() - ordmod._search_corpus["ts"] < 60)
        # Paginado + total
        r = (await c.get("/api/orders?search=rn-&skip=0&limit=2&hide_trash=true")).json()
        r_all = (await c.get("/api/orders?search=rn-&hide_trash=true")).json()
        sin_papelera = [o for o in r_all if o["board"] != "PAPELERA DE RECICLAJE"]
        check("paginado: 2 items y total = coincidencias fuera de papelera",
              len(r["items"]) == 2 and r["total"] == len(sin_papelera), f"{r.get('total')} vs {len(sin_papelera)}")

    print("\n== retención: activity_logs 30 días + sesiones vencidas ==")
    from datetime import datetime, timedelta, timezone
    import server
    from deps import db as appdb
    now = datetime(2026, 10, 1, 12, 0, tzinfo=timezone.utc)
    iso = lambda d: (now - timedelta(days=d)).isoformat()
    sdb.activity_logs.delete_many({})
    sdb.activity_logs.insert_many(
        [{"activity_id": f"old{i}", "timestamp": iso(31 + i)} for i in range(7)]
        + [{"activity_id": f"new{i}", "timestamp": iso(29 - i)} for i in range(3)])
    sdb.user_sessions.delete_many({})
    sdb.user_sessions.insert_many([
        {"session_token": "vencida", "expires_at": (now - timedelta(hours=1)).isoformat()},
        {"session_token": "vigente", "expires_at": (now + timedelta(days=6)).isoformat()},
    ])
    r = await server.purge_retention(appdb, now=now, pause=0)
    check("borra los 7 logs de más de 30 días", r["activity_logs"] == 7, f"{r}")
    quedan = sorted(d["activity_id"] for d in sdb.activity_logs.find({}, {"activity_id": 1}))
    check("conserva los 3 logs de los últimos 30 días", quedan == ["new0", "new1", "new2"], f"{quedan}")
    ses = [d["session_token"] for d in sdb.user_sessions.find({})]
    check("borra solo la sesión vencida", r["sessions"] == 1 and ses == ["vigente"], f"{r} {ses}")
    sdb.activity_logs.insert_many([{"activity_id": f"lote{i}", "timestamp": iso(40)} for i in range(12)])
    n = await server._purge_by_batches(appdb.activity_logs, {"timestamp": {"$lt": iso(30)}}, batch=5, pause=0)
    check("por lotes (5) borra los 12 completos", n == 12, f"{n}")

    raw.drop_database(SMOKE_DB)
    print(f"\n== Base {SMOKE_DB} eliminada ==")
    print(f"{ok} PASS · {fail} FAIL")
    sys.exit(1 if fail else 0)


asyncio.run(main())
