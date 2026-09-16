"""Smoke — tarea "Location Check" (el picker no encuentra una caja).

Contrato:
  · POST /location-checks (cualquier usuario, p. ej. picker): crea la tarea
    abierta con ubicación, caja (datos de la caja si existe), ticket/orden, nota;
    movimiento location_check_created.
  · Misma ubicación + caja con tarea abierta → no duplica: suma reportes y
    reportadores.
  · GET /location-checks?status=open|resolved|all + open_count; /badges trae
    location_checks y lo suma al badge de cycle_count.
  · POST /location-checks/{id}/resolve: inventarios (inventory_level ≥ 1 o
    admin) cierra con found|relocated|missing|other + nota; un picker sin nivel
    NO puede (403); resolver dos veces → 404; resolución inválida → 400.

Base DESECHABLE.
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
os.environ.setdefault("DISABLE_SCHEDULERS", "1")
sys.path.insert(0, BE)
os.chdir(BE)

import pymongo  # noqa: E402
from passlib.hash import bcrypt  # noqa: E402

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
    raw.drop_database(SMOKE_DB)
    sdb.users.insert_many([
        {"user_id": "u_picker", "email": "picker@test.local", "name": "Picker Uno", "role": "picker", "password_hash": bcrypt.hash("smoke123"), "active": True},
        {"user_id": "u_picker2", "email": "picker2@test.local", "name": "Picker Dos", "role": "picker", "password_hash": bcrypt.hash("smoke123"), "active": True},
        {"user_id": "u_inv", "email": "inv@test.local", "name": "Inventarios", "role": "inventory", "inventory_level": 3, "password_hash": bcrypt.hash("smoke123"), "active": True},
    ])
    sdb.wms_boxes.insert_one({"box_id": "BOX-000777", "location": "PS06-A29", "customer": "GOODIE TWO SLEEVES", "style": "6101", "color": "NATURAL", "size": "YS",
                              "units": 36, "qty": 36, "status": "received", "state": "raw"})


async def login(transport, email):
    from httpx import AsyncClient
    c = AsyncClient(transport=transport, base_url="http://smoke")
    r = await c.post("/api/auth/login", json={"email": email, "password": "smoke123"})
    check(f"login {email}", r.status_code == 200, r.text[:100])
    return c


async def main():
    sembrar()
    from httpx import ASGITransport
    from server import app
    transport = ASGITransport(app=app)
    picker = await login(transport, "picker@test.local")
    picker2 = await login(transport, "picker2@test.local")
    inv = await login(transport, "inv@test.local")

    print("\n== 1. El picker declara ==")
    r = await picker.post("/api/wms/location-checks", json={"location": "ps06-a29", "box_id": "BOX-000777", "ticket_id": "pick_1", "order_number": "2507", "note": "no está en el rack"})
    d = r.json()
    check("crea la tarea abierta", r.status_code == 200 and d["created"] and d["check"]["status"] == "open", r.text[:200])
    ck = d["check"]
    check("ubicación en mayúsculas y datos de la caja heredados", ck["location"] == "PS06-A29" and ck["style"] == "6101" and ck["size"] == "YS" and ck["expected_units"] == 36 and ck["customer"] == "GOODIE TWO SLEEVES", ck)
    check("ticket/orden/nota/reportador", ck["ticket_id"] == "pick_1" and ck["order_number"] == "2507" and ck["note"] == "no está en el rack" and ck["reported_by_name"] == "Picker Uno", ck)
    check("movimiento location_check_created", sdb.wms_movements.count_documents({"type": "location_check_created", "details.check_id": ck["check_id"]}) == 1)
    r = await picker.post("/api/wms/location-checks", json={"location": "X"})
    check("sin caja: ubicación vacía también vale", r.status_code == 200 and r.json()["check"]["box_id"] == "")
    r = await picker.post("/api/wms/location-checks", json={"box_id": "BOX-1"})
    check("sin ubicación → 400", r.status_code == 400)

    print("\n== 2. Otro picker reporta lo mismo → se suma, no duplica ==")
    r = await picker2.post("/api/wms/location-checks", json={"location": "PS06-A29", "box_id": "BOX-000777"})
    d = r.json()
    check("created=False, mismo check, 2 reportes", r.status_code == 200 and d["created"] is False and d["check"]["check_id"] == ck["check_id"] and d["check"]["reports"] == 2, d)
    doc = sdb.wms_location_checks.find_one({"check_id": ck["check_id"]})
    check("reportadores acumulados", sorted(doc["reporters"]) == ["Picker Dos", "Picker Uno"] and doc["last_reported_by"] == "Picker Dos", doc.get("reporters"))
    check("solo 2 tareas abiertas (la de la caja y la vacía)", sdb.wms_location_checks.count_documents({"status": "open"}) == 2)

    print("\n== 3. Listado y badge ==")
    r = await inv.get("/api/wms/location-checks", params={"status": "open"})
    check("open: 2 y open_count 2", r.json()["open_count"] == 2 and len(r.json()["items"]) == 2, r.json())
    r = await inv.get("/api/wms/badges")
    check("badge location_checks=2 y cycle_count lo incluye", r.json()["location_checks"] == 2 and r.json()["cycle_count"] == 2, r.json())

    print("\n== 4. Resolver ==")
    r = await picker.post(f"/api/wms/location-checks/{ck['check_id']}/resolve", json={"resolution": "found"})
    check("un picker sin nivel no resuelve → 403", r.status_code == 403, r.status_code)
    r = await inv.post(f"/api/wms/location-checks/{ck['check_id']}/resolve", json={"resolution": "nope"})
    check("resolución inválida → 400", r.status_code == 400)
    r = await inv.post(f"/api/wms/location-checks/{ck['check_id']}/resolve", json={"resolution": "relocated", "note": "estaba en PS06-A30, movida"})
    d = r.json()
    check("inventarios resuelve: relocated + nota + quién", r.status_code == 200 and d["check"]["status"] == "resolved" and d["check"]["resolution"] == "relocated" and d["check"]["resolved_by_name"] == "Inventarios" and d["check"]["resolution_note"].startswith("estaba"), r.text[:200])
    check("movimiento location_check_resolved", sdb.wms_movements.count_documents({"type": "location_check_resolved", "details.check_id": ck["check_id"], "details.resolution": "relocated"}) == 1)
    r = await inv.post(f"/api/wms/location-checks/{ck['check_id']}/resolve", json={"resolution": "found"})
    check("resolver dos veces → 404", r.status_code == 404)
    r = await inv.get("/api/wms/location-checks", params={"status": "all"})
    check("all: 2 tareas, open_count 1", len(r.json()["items"]) == 2 and r.json()["open_count"] == 1)
    r = await inv.get("/api/wms/location-checks", params={"status": "resolved"})
    check("resolved: 1", len(r.json()["items"]) == 1 and r.json()["items"][0]["resolution"] == "relocated")
    r = await picker.post("/api/wms/location-checks", json={"location": "PS06-A29", "box_id": "BOX-000777"})
    check("tras resolver, un nuevo reporte crea otra tarea", r.status_code == 200 and r.json()["created"] is True and r.json()["check"]["check_id"] != ck["check_id"])

    for c in (picker, picker2, inv):
        await c.aclose()
    print(f"\n===== {ok} PASS / {fail} FAIL =====")
    raw.drop_database(SMOKE_DB)
    print(f"base {SMOKE_DB} eliminada")
    sys.exit(1 if fail else 0)


if __name__ == "__main__":
    asyncio.run(main())
