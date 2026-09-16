"""Smoke — buscador global: escanear una UBICACIÓN.

Contrato de GET /locations/lookup?code=:
  · Resuelve por nombre sin distinguir mayúsculas (la etiqueta codifica el nombre).
  · Cuenta solo cajas EN STOCK (units > 0 y estado vivo): las depleted /
    embarcadas no cuentan, pero sí en boxes_total.
  · Desglose por cliente/estilo/color/talla y lista de cajas ordenada.
  · Ubicación que solo existe en cajas (custom / fantasma) → found con exists=False.
  · Código desconocido → found=False (la UI cae al historial de caja).

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


def box(bid, loc, style, color, size, units, status="received", **extra):
    return {"box_id": bid, "location": loc, "customer": "GOODIE TWO SLEEVES", "style": style, "color": color, "size": size,
            "units": units, "qty": units, "status": status, "state": "raw", **extra}


def sembrar():
    raw.drop_database(SMOKE_DB)
    sdb.users.insert_one({"user_id": "u_op", "email": "u_op@test.local", "name": "op",
                          "password_hash": bcrypt.hash("smoke123"), "role": "user", "active": True})
    sdb.wms_locations.insert_many([
        {"location_id": "l1", "name": "53277-18", "zone": "53277", "type": "rack", "active": True},
        {"location_id": "l2", "name": "53277-19", "zone": "53277", "type": "rack", "active": True},
    ])
    sdb.wms_boxes.insert_many([
        box("B1", "53277-18", "5000", "BLACK", "L", 72, part_number="GTS-SS100CNI"),
        box("B2", "53277-18", "5000", "BLACK", "L", 30, units_allocated=10),
        box("B3", "53277-18", "5000", "WHITE", "M", 50),
        box("B4", "53277-18", "5000", "WHITE", "M", 0, status="depleted"),   # vacía: no cuenta
        box("B5", "53277-18", "64000", "SAND", "S", 20, status="shipped"),   # embarcada: no cuenta
        box("B6", "PO#1849", "2000", "RED", "XL", 12),                        # ubicación custom, no catalogada
    ])


async def main():
    sembrar()
    from httpx import ASGITransport, AsyncClient
    from server import app
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://smoke") as c:
        r = await c.post("/api/auth/login", json={"email": "u_op@test.local", "password": "smoke123"})
        check("login (usuario normal basta)", r.status_code == 200)

        print("\n== 1. Rack con cajas ==")
        r = await c.get("/api/wms/locations/lookup", params={"code": "53277-18"})
        d = r.json()
        check("found + catalogada", r.status_code == 200 and d["found"] and d["location"]["exists"] and d["location"]["zone"] == "53277", d)
        check("3 cajas / 152 unidades en stock (depleted y shipped fuera)", d["boxes_in_stock"] == 3 and d["units_in_stock"] == 152, (d["boxes_in_stock"], d["units_in_stock"]))
        check("boxes_total cuenta las 5 físicas/históricas", d["boxes_total"] == 5, d["boxes_total"])
        check("comprometidas: 10", d["units_allocated"] == 10, d["units_allocated"])
        sk = [(x["style"], x["color"], x["size"], x["boxes"], x["units"]) for x in d["by_sku"]]
        check("desglose por producto ordenado por unidades", sk == [("5000", "BLACK", "L", 2, 102), ("5000", "WHITE", "M", 1, 50)], sk)
        ids = [b["box_id"] for b in d["boxes"]]
        check("lista de cajas vivas ordenada", ids == ["B1", "B2", "B3"] and d["boxes"][0]["part_number"] == "GTS-SS100CNI", ids)
        check("sin truncar", d["boxes_truncated"] == 0)

        print("\n== 2. Variantes del código ==")
        r = await c.get("/api/wms/locations/lookup", params={"code": "  53277-18 "})
        check("espacios alrededor", r.json()["found"] and r.json()["boxes_in_stock"] == 3)
        r = await c.get("/api/wms/locations/lookup", params={"code": "53277-19"})
        d = r.json()
        check("rack catalogado pero vacío → found, 0 cajas", d["found"] and d["boxes_in_stock"] == 0 and d["boxes_total"] == 0 and d["location"]["exists"], d)
        r = await c.get("/api/wms/locations/lookup", params={"code": "po#1849"})
        d = r.json()
        check("ubicación custom (solo en cajas), minúsculas → found, exists=False, 1 caja", d["found"] and d["location"]["exists"] is False and d["location"]["name"] == "PO#1849" and d["boxes_in_stock"] == 1, d)
        r = await c.get("/api/wms/locations/lookup", params={"code": "NOEXISTE"})
        check("desconocido → found=False", r.status_code == 200 and r.json()["found"] is False)
        r = await c.get("/api/wms/locations/lookup", params={"code": ""})
        check("vacío → 400", r.status_code == 400)
        r = await c.get("/api/wms/locations/lookup", params={"code": "53277-1"})
        check("no es prefijo: '53277-1' no encuentra '53277-18'", r.json()["found"] is False)

    print(f"\n===== {ok} PASS / {fail} FAIL =====")
    raw.drop_database(SMOKE_DB)
    print(f"base {SMOKE_DB} eliminada")
    sys.exit(1 if fail else 0)


if __name__ == "__main__":
    asyncio.run(main())
