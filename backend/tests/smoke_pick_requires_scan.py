"""Smoke F0 del proyecto "sin FIFO": el descuento por talla (pick-size) es
SIEMPRE por caja escaneada. Fija que:
  - un descuento con delta positivo SIN box_id -> 400 (pide escanear),
  - el mismo descuento CON box_id -> 200 y descuenta de ESA caja,
  - ya no hay fallback FIFO ciego (pick_requires_scan forzado ON).

SEGURIDAD: base DESECHABLE, se niega contra producción, se borra al terminar.

USO
    set MONGODB_URL=mongodb://usuario:clave@host:27017/?authSource=admin
    backend/venv/Scripts/python.exe backend/tests/smoke_pick_requires_scan.py
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

STYLE, COLOR, SIZE, LOC, BOX = "STY5000", "BLACK", "M", "A1-01", "BOX-000001"
TICKET = "tkt_smoke_1"


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
    for c in ["users", "user_sessions", "wms_pick_tickets", "wms_boxes",
              "wms_inventory", "config_options", "wms_movements", "wms_tasks"]:
        sdb[c].delete_many({})
    sdb.users.insert_one({
        "user_id": "u_sup", "email": "sup@test.local", "name": "Supervisor",
        "password_hash": bcrypt.hash("sup123"),
        "role": "supersu", "admin_level": 5, "inventory_level": 5, "active": True,
    })
    # Caja física con stock en la ubicación (basta cajas: _available_units toma el
    # mayor entre cajas e inventario).
    sdb.wms_boxes.insert_one({
        "box_id": BOX, "barcode": BOX, "lpn_id": BOX, "style": STYLE, "sku": STYLE,
        "color": COLOR, "size": SIZE, "location": LOC, "units": 50, "qty": 50,
        "status": "stored", "state": "raw", "customer": "CLIENTE X",
    })
    # Pick ticket abierto que pide 10 de la talla M.
    sdb.wms_pick_tickets.insert_one({
        "ticket_id": TICKET, "style": STYLE, "color": COLOR, "customer": "CLIENTE X",
        "sizes": {SIZE: 10}, "destination": "warehouse", "status": "in_progress",
        "assigned_to": "", "deducted_map": {}, "picked_sizes": {},
    })
    # Ticket LEGACY: trae picked_sizes pero SIN deducted_map y SIN box -> antes
    # el confirm caía al FIFO ciego; ahora debe rechazarse (enforce_scan).
    sdb.wms_pick_tickets.insert_one({
        "ticket_id": "tkt_smoke_2", "style": STYLE, "color": COLOR, "customer": "CLIENTE X",
        "sizes": {SIZE: 10}, "destination": "warehouse", "status": "in_progress",
        "assigned_to": "",
        "picked_sizes": {SIZE: {"total": 5, "details": {LOC: 5}}},
    })


async def main():
    sembrar()
    from httpx import ASGITransport, AsyncClient
    from server import app

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://smoke") as c:
        r = await c.post("/api/auth/login", json={"email": "sup@test.local", "password": "sup123"})
        check("login", r.status_code == 200, f"{r.status_code} {r.text[:120]}")

        url = f"/api/wms/pick-tickets/{TICKET}/pick-size"

        print("\n== Descuento SIN caja -> 400 (pide escanear) ==")
        r = await c.put(url, json={"size": SIZE, "details": {LOC: {"qty": 5}}})
        check("sin box_id -> 400", r.status_code == 400, f"{r.status_code} {r.text[:160]}")
        check("mensaje pide escanear",
              "escanear" in r.text.lower() or "scan" in r.text.lower(), r.text[:160])
        # La caja NO debió tocarse.
        b = sdb.wms_boxes.find_one({"box_id": BOX})
        check("la caja sigue con 50 (no se descontó)", int(b.get("units", 0)) == 50,
              f"units={b.get('units')}")

        print("\n== Descuento CON caja -> 200 y descuenta de ESA caja ==")
        r = await c.put(url, json={"size": SIZE, "details": {LOC: {"qty": 5, "box_id": BOX}}})
        check("con box_id -> 200", r.status_code == 200, f"{r.status_code} {r.text[:200]}")
        b = sdb.wms_boxes.find_one({"box_id": BOX})
        check("la caja bajó a 45", int(b.get("units", 0)) == 45, f"units={b.get('units')}")

        print("\n== Aunque el config diga OFF, sigue exigiendo caja (forzado) ==")
        # Ya hay 5 descontados en M@LOC. Un delta POSITIVO (qty 9 -> +4) sin caja
        # debe seguir rechazandose aunque el config diga OFF (require_scan forzado).
        sdb.config_options.update_one({"config_id": "main"},
                                      {"$set": {"pick_requires_scan": False}}, upsert=True)
        r = await c.put(url, json={"size": SIZE, "details": {LOC: {"qty": 9}}})
        check("config OFF ignorado -> delta+ sin caja sigue 400", r.status_code == 400, f"{r.status_code} {r.text[:160]}")

        print("\n== F1: confirm legacy (picked_sizes sin caja) -> bloqueado, NO FIFO ==")
        r = await c.put("/api/wms/pick-tickets/tkt_smoke_2/confirm", json={"lines": []})
        check("confirm sin caja -> 400 (FIFO bloqueado)", r.status_code == 400, f"{r.status_code} {r.text[:180]}")
        t2 = sdb.wms_pick_tickets.find_one({"ticket_id": "tkt_smoke_2"})
        check("el ticket NO quedó confirmado", t2.get("status") != "confirmed", f"status={t2.get('status')}")


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
        print("EXCEPCIÓN en el smoke:\n" + _err)
    print(f"{ok} PASS · {fail} FAIL")
    sys.exit(1 if (fail or _err) else 0)
