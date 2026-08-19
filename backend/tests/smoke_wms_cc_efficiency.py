"""Smoke test del endpoint de eficiencia de contadores (Conteo Cíclico).

GET /cycle-counts/efficiency devuelve los eventos crudos de cierre de
ubicación (history de wms_cycle_counts) en una ventana UTC: quién, cuándo,
qué ubicación y cuántas cajas. La pestaña Eficiencia agrega en el navegador.
Este smoke fija: el gate de nivel 3, el filtro de ventana, el conteo de cajas
por evento y que cada pase cerrado es un evento distinto.

SEGURIDAD: base DESECHABLE, se niega contra producción, se borra al terminar.

USO
───
    set MONGODB_URL=mongodb://usuario:clave@host:27017/?authSource=admin
    python backend/tests/smoke_wms_cc_efficiency.py
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

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

raw = pymongo.MongoClient(MONGO)
sdb = raw[SMOKE_DB]
ok = fail = 0


def check(nombre, cond, detalle=""):
    global ok, fail
    if cond:
        ok += 1
        print(f"   PASS  {nombre}")
    else:
        fail += 1
        print(f"   FAIL  {nombre}  {detalle}")


def sembrar():
    print(f"== Sembrando {SMOKE_DB} ==")
    for c in ["wms_cycle_counts", "users", "user_sessions"]:
        sdb[c].delete_many({})
    # Un conteo con dos contadores: Elvis cierra 2 ubicaciones (3 y 2 cajas) el
    # 20-jul; Cesar cierra 1 (1 caja) el 20-jul y otra FUERA de la ventana el
    # 21-jul. NA-2 tiene dos pases (history doble) = 2 eventos.
    sdb.wms_cycle_counts.insert_one({
        "count_id": "cc_eff", "name": "eff", "status": "pending", "mode": "box_scan",
        "scan_locations": [
            {"loc_id": "l1", "location": "NA-1", "status": "ok", "history": [
                {"pass": 1, "scanned": ["B1", "B2", "B3"], "matched": True,
                 "by": "u_elvis", "by_name": "Elvis", "at": "2026-07-20T15:10:00+00:00"},
            ]},
            {"loc_id": "l2", "location": "NA-2", "status": "ok", "history": [
                {"pass": 1, "scanned": ["B4"], "matched": False,
                 "by": "u_elvis", "by_name": "Elvis", "at": "2026-07-20T15:40:00+00:00"},
                {"pass": 2, "scanned": ["B4", "B5"], "matched": True,
                 "by": "u_elvis", "by_name": "Elvis", "at": "2026-07-20T17:05:00+00:00"},
            ]},
            {"loc_id": "l3", "location": "NA-3", "status": "ok", "history": [
                {"pass": 1, "scanned": ["B6"], "matched": True,
                 "by": "u_cesar", "by_name": "Cesar", "at": "2026-07-20T16:00:00+00:00"},
            ]},
            {"loc_id": "l4", "location": "NA-4", "status": "ok", "history": [
                {"pass": 1, "scanned": ["B7"], "matched": True,
                 "by": "u_cesar", "by_name": "Cesar", "at": "2026-07-21T09:00:00+00:00"},
            ]},
        ],
    })
    # Un conteo por líneas (mode!=box_scan): NO debe aparecer.
    sdb.wms_cycle_counts.insert_one({
        "count_id": "cc_lines", "name": "lineas", "status": "pending", "mode": "lines",
        "scan_locations": [],
    })
    sdb.users.insert_one({
        "user_id": "u_sup", "email": "sup@test.local", "name": "Supervisor",
        "password_hash": bcrypt.hash("sup123"),
        "role": "supersu", "admin_level": 5, "inventory_level": 5, "active": True,
    })
    sdb.users.insert_one({
        "user_id": "u_n1", "email": "n1@test.local", "name": "Nivel Uno",
        "password_hash": bcrypt.hash("n1123"),
        "role": "inventory", "admin_level": 0, "inventory_level": 1, "active": True,
    })


async def main():
    sembrar()
    from httpx import ASGITransport, AsyncClient
    from server import app

    # Un cliente POR ROL: la cookie del último login pisa al Bearer.
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://smoke") as sup, \
               AsyncClient(transport=ASGITransport(app=app), base_url="http://smoke") as n1:
        r = await sup.post("/api/auth/login", json={"email": "sup@test.local", "password": "sup123"})
        check("login supervisor", r.status_code == 200, f"{r.status_code}")
        r = await n1.post("/api/auth/login", json={"email": "n1@test.local", "password": "n1123"})
        check("login nivel 1", r.status_code == 200, f"{r.status_code}")

        VENTANA = {"from_utc": "2026-07-20T00:00:00+00:00", "to_utc": "2026-07-21T00:00:00+00:00"}

        print("\n== Gate ==")
        r = await n1.get("/api/wms/cycle-counts/efficiency", params=VENTANA)
        check("nivel 1 -> 403", r.status_code == 403, f"{r.status_code}")
        r = await sup.get("/api/wms/cycle-counts/efficiency")
        check("sin ventana -> 400", r.status_code == 400, f"{r.status_code}")

        print("\n== Ventana y eventos ==")
        r = await sup.get("/api/wms/cycle-counts/efficiency", params=VENTANA)
        check("200", r.status_code == 200, f"{r.status_code} {r.text[:200]}")
        d = r.json()
        check("4 eventos en ventana (el del 21-jul queda fuera)", d.get("count") == 4, f"{d.get('count')}")
        evs = d.get("events", [])
        check("orden cronológico", [e["at"] for e in evs] == sorted(e["at"] for e in evs))
        elvis = [e for e in evs if e["by_name"] == "Elvis"]
        cesar = [e for e in evs if e["by_name"] == "Cesar"]
        check("Elvis: 3 eventos (2 pases de NA-2 cuentan aparte)", len(elvis) == 3, f"{len(elvis)}")
        check("Elvis: 6 cajas", sum(e["boxes"] for e in elvis) == 6,
              f"{sum(e['boxes'] for e in elvis)}")
        check("Cesar: 1 evento / 1 caja", len(cesar) == 1 and cesar[0]["boxes"] == 1, f"{cesar}")
        check("ubicación y pase presentes",
              all(e.get("location") and e.get("pass") for e in evs))


try:
    asyncio.run(main())
finally:
    raw.drop_database(SMOKE_DB)
    print(f"\n== Base {SMOKE_DB} eliminada ==")
    print(f"{ok} PASS · {fail} FAIL")
    sys.exit(1 if fail else 0)
