"""Smoke F3 del proyecto "sin FIFO": mover unidades (consolidar) exige la CAJA
seleccionada/escaneada — nunca agarra "la más vieja" automáticamente. Fija:
  - /move-units sin box_id -> 400 (pide seleccionar/escanear caja),
  - con box_id de OTRO material -> 409 (cross-check),
  - con box_id + parcial -> 200: la caja origen baja y nace una caja en el destino,
  - pidiendo más de lo que tiene la caja -> 409.

SEGURIDAD: base DESECHABLE, se niega contra producción, se borra al terminar.
USO: set MONGODB_URL=... ; backend/venv/Scripts/python.exe backend/tests/smoke_move_requires_box.py
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

STYLE, COLOR, SIZE = "STY5000", "BLACK", "M"
SRC, DST, BOX = "AA01-01", "BB02-02", "BOX-000001"
OTHERBOX = "BOX-000002"


def check(n, cond, det=""):
    global ok, fail
    if cond:
        ok += 1; print(f"   PASS  {n}")
    else:
        fail += 1; print(f"   FAIL  {n}  {det}")


def sembrar():
    print(f"== Sembrando {SMOKE_DB} ==")
    for c in ["users", "user_sessions", "wms_boxes", "wms_inventory",
              "wms_locations", "wms_movements", "config_options"]:
        sdb[c].delete_many({})
    sdb.users.insert_one({
        "user_id": "u_sup", "email": "sup@test.local", "name": "Sup",
        "password_hash": bcrypt.hash("sup123"),
        "role": "supersu", "admin_level": 5, "inventory_level": 5, "active": True,
    })
    sdb.wms_locations.insert_many([{"name": SRC}, {"name": DST}])
    sdb.wms_boxes.insert_one({
        "box_id": BOX, "barcode": BOX, "lpn_id": BOX, "style": STYLE, "sku": STYLE,
        "color": COLOR, "size": SIZE, "location": SRC, "units": 50, "qty": 50,
        "status": "stored", "state": "located", "customer": "CLIENTE X",
        "country_of_origin": "REP DOM", "fabric_content": "100% COTTON",
    })
    # Caja de OTRO material en el mismo origen (para el cross-check).
    sdb.wms_boxes.insert_one({
        "box_id": OTHERBOX, "barcode": OTHERBOX, "lpn_id": OTHERBOX, "style": STYLE,
        "sku": STYLE, "color": "WHITE", "size": SIZE, "location": SRC, "units": 30,
        "qty": 30, "status": "stored", "state": "located", "customer": "CLIENTE X",
    })


async def main():
    sembrar()
    from httpx import ASGITransport, AsyncClient
    from server import app
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://smoke") as c:
        r = await c.post("/api/auth/login", json={"email": "sup@test.local", "password": "sup123"})
        check("login", r.status_code == 200, f"{r.status_code}")
        url = "/api/wms/move-units"
        base = {"from": SRC, "to": DST, "sku": STYLE, "color": COLOR, "size": SIZE}

        print("\n== SIN box_id -> 400 (FIFO deshabilitado) ==")
        r = await c.post(url, json={**base, "units": 20})
        check("sin box_id -> 400", r.status_code == 400, f"{r.status_code} {r.text[:160]}")
        check("la caja NO se tocó (sigue 50)",
              int(sdb.wms_boxes.find_one({"box_id": BOX})["units"]) == 50)

        print("\n== box_id de OTRO material -> 409 (cross-check) ==")
        r = await c.post(url, json={**base, "units": 5, "box_id": OTHERBOX})
        check("caja de otro material -> 409", r.status_code == 409, f"{r.status_code} {r.text[:160]}")

        print("\n== box_id + parcial 20 -> 200, parte la caja ==")
        r = await c.post(url, json={**base, "units": 20, "box_id": BOX})
        check("move con caja -> 200", r.status_code == 200, f"{r.status_code} {r.text[:200]}")
        src_box = sdb.wms_boxes.find_one({"box_id": BOX})
        check("caja origen bajó a 30", int(src_box["units"]) == 30, f"units={src_box['units']}")
        dst_boxes = list(sdb.wms_boxes.find({"location": DST, "units": {"$gt": 0}}))
        dst_units = sum(int(b.get("units") or 0) for b in dst_boxes)
        check("destino recibió 20 en una caja nueva", dst_units == 20 and len(dst_boxes) >= 1,
              f"dst_units={dst_units} cajas={len(dst_boxes)}")

        print("\n== pedir más de lo que tiene la caja -> 409 ==")
        r = await c.post(url, json={**base, "units": 999, "box_id": BOX})
        check("units > caja -> 409", r.status_code == 409, f"{r.status_code} {r.text[:160]}")


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
