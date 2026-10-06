"""Smoke: SHIPPING# en el encabezado del export + color de fila tipo Excel
(routers/scheduled_shipments.py: _derive_shipping_no, PUT /exports, row_color,
POST /lines/color).

Contrato:
  - Export sin SHIPPING# propio → el más común de sus líneas (sin escribirlo).
  - Editar el encabezado lo guarda en el export y manda sobre las líneas.
  - Editar OTRO campo del export no pierde el SHIPPING# derivado.
  - row_color: paleta fija, por línea y en lote; null = sin color; 400 si no
    es de la paleta; queda en la bitácora y se puede revertir.

SEGURIDAD: base DESECHABLE, se niega contra producción, se borra al terminar.

    set MONGODB_URL=mongodb://localhost:27017
    python backend/tests/smoke_shipping_header_color.py
"""
import asyncio
import os
import sys

BE = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
SMOKE_DB = os.environ.get("SMOKE_DB_NAME", "mos-smoke-shipping-header-color")
MONGO = os.environ.get("MONGODB_URL") or os.environ.get("MONGO_URL")
if not MONGO:
    sys.exit("Falta MONGODB_URL")
if SMOKE_DB == os.environ.get("PROD_DB_NAME", "mos-system"):
    sys.exit("NEGADO: base de producción")
os.environ.update({"MONGODB_URL": MONGO, "MONGO_URL": MONGO, "DB_NAME": SMOKE_DB})
for k, v in (("JWT_SECRET", "s"), ("MASTER_API_KEY", "m"), ("INTERNAL_SYNC_TOKEN", "t"),
             ("DISABLE_SCHEDULERS", "1"), ("ENV", "local")):
    os.environ.setdefault(k, v)
sys.path.insert(0, BE)
os.chdir(BE)

import pymongo  # noqa: E402
from passlib.hash import bcrypt  # noqa: E402

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
raw = pymongo.MongoClient(MONGO)
sdb = raw[SMOKE_DB]
ok = fail = 0


def check(name, cond, detail=""):
    global ok, fail
    ok, fail = (ok + 1, fail) if cond else (ok, fail + 1)
    print(f"   {'PASS' if cond else 'FAIL'}  {name}" + ("" if cond else f"  {detail}"))


def sembrar():
    for c in ["orders", "users", "user_sessions", "activity_logs", "scheduled_shipments",
              "shipping_exports", "shipping_movements", "config_options"]:
        sdb[c].delete_many({})
    sdb.users.insert_one({"user_id": "u_sup", "email": "sup@x.com", "name": "Sup", "role": "supersu",
                          "admin_level": 5, "password_hash": bcrypt.hash("p"), "active": True})
    for n in ("3301", "3302", "3303", "3304"):
        sdb.orders.insert_one({"order_id": "o" + n, "order_number": n, "board": "FINAL BILL", "client": "GTS"})
    # Export "viejo": sin shipping_no propio; sus líneas traen #2 (x2) y #1 (x1).
    sdb.shipping_exports.insert_many([
        {"export_id": "e_old", "date": "2026-10-07", "position": 0, "cutoff_time": "11:30", "export_time": "16:00"},
        {"export_id": "e_empty", "date": "2026-10-08", "position": 0, "cutoff_time": "11:30", "export_time": "16:00"},
    ])
    for i, (n, sn) in enumerate([("3301", "#2"), ("3302", "#2"), ("3303", "#1")]):
        sdb.scheduled_shipments.insert_one({"shipment_id": f"s{i}", "order_number": n, "export_id": "e_old",
                                            "ship_date": "2026-10-07", "position": i, "shipping_no": sn})
    sdb.scheduled_shipments.insert_one({"shipment_id": "s9", "order_number": "3304", "export_id": "e_empty",
                                        "ship_date": "2026-10-08", "position": 0})


async def main():
    sembrar()
    from httpx import ASGITransport, AsyncClient
    from server import app
    API = "/api/scheduled-shipments"
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://smoke") as c:
        await c.post("/api/auth/login", json={"email": "sup@x.com", "password": "p"})
        week = lambda: c.get(f"{API}/week?start=2026-10-05")  # noqa: E731

        print("== SHIPPING# en el encabezado ==")
        w = (await week()).json()
        ex = {e["export_id"]: e for e in w["exports"]}
        check("export viejo muestra el SHIPPING# más común de sus líneas", ex["e_old"]["shipping_no"] == "#2", ex["e_old"])
        check("export sin valores → vacío", ex["e_empty"]["shipping_no"] is None)
        check("…y no se escribió nada en la base", "shipping_no" not in sdb.shipping_exports.find_one({"export_id": "e_old"}))
        r = await c.put(f"{API}/exports/e_old", json={"pl_numbers": "PLGTS 10-26-0090"})
        check("editar OTRO campo conserva el SHIPPING# derivado", r.status_code == 200 and r.json()["shipping_no"] == "#2", r.text[:200])
        r = await c.put(f"{API}/exports/e_old", json={"shipping_no": " #3 "})
        check("editar el encabezado lo guarda en el export", r.json()["shipping_no"] == "#3"
              and sdb.shipping_exports.find_one({"export_id": "e_old"})["shipping_no"] == "#3", r.text[:200])
        ex = {e["export_id"]: e for e in (await week()).json()["exports"]}
        check("el del export manda sobre el de las líneas", ex["e_old"]["shipping_no"] == "#3")
        r = await c.put(f"{API}/exports/e_old", json={"shipping_no": ""})
        ex = {e["export_id"]: e for e in (await week()).json()["exports"]}
        check("borrarlo lo deja vacío (no regresa al de las líneas)", ex["e_old"]["shipping_no"] is None, ex["e_old"])
        mv = sdb.shipping_movements.find_one({"action": "export_update", "summary": {"$regex": "SHIPPING#"}})
        check("queda en la bitácora como SHIPPING#", bool(mv), [m["summary"] for m in sdb.shipping_movements.find()])

        print("\n== Color de fila ==")
        r = await c.put(f"{API}/s0", json={"row_color": "amarillo"})
        check("una fila: se guarda en mayúsculas", r.status_code == 200 and r.json()["row_color"] == "AMARILLO", r.text[:200])
        r = await c.put(f"{API}/s0", json={"row_color": "FUCSIA"})
        check("color fuera de la paleta → 400", r.status_code == 400 and "AMARILLO" in r.text)
        r = await c.post(f"{API}/lines/color", json={"shipment_ids": ["s0", "s1", "s2"], "color": "VERDE"})
        check("en lote: pinta las 3", r.status_code == 200 and r.json()["colored"] == 3, r.text)
        lines = {l["shipment_id"]: l for l in (await week()).json()["lines"]}
        check("/week devuelve row_color", all(lines[s]["row_color"] == "VERDE" for s in ("s0", "s1", "s2")))
        r = await c.post(f"{API}/lines/color", json={"shipment_ids": ["s0", "s1", "s2"], "color": "VERDE"})
        check("repetir el mismo color no cuenta ni ensucia la bitácora", r.json()["colored"] == 0)
        mv = sdb.shipping_movements.find_one({"summary": {"$regex": "^Pintó"}})
        check("bitácora: 'Pintó … · VERDE'", bool(mv) and "VERDE" in mv["summary"], mv and mv["summary"])
        r = await c.post(f"{API}/movements/{mv['movement_id']}/revert")
        check("se puede revertir el pintado", r.status_code == 200, r.text[:200])
        check("…y vuelve el color anterior (s0 amarillo, s1/s2 sin color)",
              sdb.scheduled_shipments.find_one({"shipment_id": "s0"}).get("row_color") == "AMARILLO"
              and not sdb.scheduled_shipments.find_one({"shipment_id": "s1"}).get("row_color"))
        r = await c.post(f"{API}/lines/color", json={"shipment_ids": ["s0"], "color": None})
        check("color null = sin color", r.json()["colored"] == 1
              and sdb.scheduled_shipments.find_one({"shipment_id": "s0"}).get("row_color") is None)
        r = await c.post(f"{API}/lines/color", json={"shipment_ids": [], "color": "AZUL"})
        check("sin ids → 400", r.status_code == 400)
    raw.drop_database(SMOKE_DB)
    print(f"\n{ok} PASS · {fail} FAIL")
    sys.exit(1 if fail else 0)


asyncio.run(main())
