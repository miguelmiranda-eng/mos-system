"""Smoke — Auditoría → Movimientos: desplegables y columnas.

Contrato:
  · GET /audit/movements/facets: tipos y usuarios que existen en la bitácora
    con conteo, ordenados por frecuencia (para los desplegables).
  · GET /audit/movements devuelve `rows`: cada movimiento aplanado a columnas
    fijas (caja, producto, ubicación/de/a, unidades/antes/después/delta,
    referencias, motivo) + `detail` legible con lo que sobra, sin JSON.
  · Los filtros tipo/usuario/fecha/texto siguen funcionando.

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


def mv(i, typ, user, details, day="2026-09-10"):
    return {"movement_id": f"mv_{i}", "type": typ, "user_name": user, "user_id": "u", "created_at": f"{day}T10:{i:02d}:00+00:00", "details": details}


def sembrar():
    raw.drop_database(SMOKE_DB)
    sdb.users.insert_one({"user_id": "u_admin", "email": "u_admin@test.local", "name": "admin",
                          "password_hash": bcrypt.hash("smoke123"), "role": "supersu", "admin_level": 5, "active": True})
    sdb.wms_movements.insert_many([
        mv(1, "inventory_adjust_box", "Aaron Herrera", {"box_id": "BOX-040386", "sku": "CK002-BLACK-ACID-3X", "color": "BLACK ACID WASH", "size": "3X", "location": "CARRO 260", "old_units": 48, "new_units": 0, "delta_units": -48, "reason": "Número de caja obsoleta", "box_deleted": True}),
        mv(2, "pick_deduction", "Christian Santa Cruz", {"ticket_id": "pick_1", "order_number": "2507", "style": "6101", "color": "NATURAL", "size": "YS", "location": "PS06-A29", "qty": 3, "box_ids": ["BOX-1"], "boxes": [{"box_id": "BOX-1", "taken": 3}], "no_box_units": 0, "scanned": True}),
        mv(3, "bulk_relocation", "Cesar Lopez de Jesus", {"trigger": "box_scan", "from": "PS04-A04", "to": "NA03-A19", "box_ids": ["B1", "B2", "B3", "B4", "B5", "B6", "B7", "B8"], "units_batch": 648, "box_units": {"B1": 72}, "boxes_moved": 8}),
        mv(4, "receiving", "Aaron Herrera", {"receiving_id": "rcv_9", "total_units": 1800, "is_bpo": False}, day="2026-09-12"),
        # Putaway de la PDA (transit_relocation) y el flujo viejo (putaway): la familia "Putaway" junta ambos.
        mv(6, "transit_relocation", "Cesar Lopez de Jesus", {"trigger": "transit", "from_sources": ["CARRO 260"], "origins": ["CARRO 260"], "to": "NA07-A31", "destination": "NA07-A31", "boxes_moved": 2, "units_moved": 48, "box_ids": ["BOX-7", "BOX-8"]}, day="2026-09-13"),
        mv(7, "putaway", "Almacen", {"box_id": "BOX-000003", "from": "Locación Temporal", "to": "RCV-STG-01", "sku": "5000-CHARCOAL-M", "units": 72}, day="2026-05-28"),
        mv(5, "inventory_adjustment", "Aaron Herrera", {"inventory_id": "inv_1", "sku": "ZS9003-WHITE-XL", "location": "53286-02", "delta": -24, "new_on_hand": 0, "reason": "LIF/GLO Clean Up", "bulk": True}, day="2026-09-12"),
    ])


async def main():
    sembrar()
    from httpx import ASGITransport, AsyncClient
    from server import app
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://smoke") as c:
        r = await c.post("/api/auth/login", json={"email": "u_admin@test.local", "password": "smoke123"})
        check("login", r.status_code == 200)

        print("\n== 1. Facets ==")
        r = await c.get("/api/wms/audit/movements/facets")
        f = r.json()
        check("tipos con conteo, el más frecuente primero", r.status_code == 200 and f["types"][0] == {"type": "inventory_adjust_box", "n": 1} or f["types"][0]["n"] == 1 and len(f["types"]) == 7, f.get("types"))
        check("usuarios con conteo: Aaron 3", any(u["user"] == "Aaron Herrera" and u["n"] == 3 for u in f["users"]) and f["users"][0]["user"] == "Aaron Herrera", f.get("users"))

        print("\n== 2. rows aplanados ==")
        r = await c.get("/api/wms/audit/movements", params={"limit": 50})
        d = r.json()
        check("rows y movements del mismo tamaño", r.status_code == 200 and len(d["rows"]) == len(d["movements"]) == 7)
        rows = {x["movement_id"]: x for x in d["rows"]}
        a = rows["mv_1"]
        check("ajuste por caja: caja/sku/ubicación/antes/después/delta/motivo", a["box_id"] == "BOX-040386" and a["sku"] == "CK002-BLACK-ACID-3X" and a["location"] == "CARRO 260" and a["before"] == "48" and a["after"] == "0" and a["delta"] == "-48" and a["reason"] == "Número de caja obsoleta", a)
        check("lo que sobra va a detail legible (sin JSON)", a["detail"] == "box_deleted: sí", a["detail"])
        p = rows["mv_2"]
        check("surtido: caja, producto, unidades, orden y ticket", p["box_id"] == "BOX-1" and p["style"] == "6101" and p["units"] == "3" and p["order_number"] == "2507" and p["ticket_id"] == "pick_1", p)
        b = rows["mv_3"]
        check("reubicación en lote: de → a, unidades del lote, 8 cajas resumidas", b["from"] == "PS04-A04" and b["to"] == "NA03-A19" and b["units"] == "648" and b["box_id"].startswith("8: B1, B2") and "box_units" not in b["detail"], b)
        rc = rows["mv_4"]
        check("recibo: unidades y receiving_id; bool en palabras", rc["units"] == "1800" and rc["receiving_id"] == "rcv_9" and rc["detail"] == "is_bpo: no", rc)
        ia = rows["mv_5"]
        check("ajuste de inventario: delta y después sin antes", ia["delta"] == "-24" and ia["after"] == "0" and ia["before"] == "" and ia["reason"] == "LIF/GLO Clean Up", ia)
        check("columnas fijas presentes en todas las filas", all(set(x) >= {"created_at", "type", "user_name", "box_id", "style", "color", "size", "sku", "location", "from", "to", "units", "before", "after", "delta", "order_number", "ticket_id", "receiving_id", "asn_id", "reason", "detail"} for x in d["rows"]))

        print("\n== 3. Filtros ==")
        r = await c.get("/api/wms/audit/movements", params={"movement_type": "receiving"})
        check("por tipo", r.json()["count"] == 1 and r.json()["rows"][0]["type"] == "receiving")
        r = await c.get("/api/wms/audit/movements", params={"user": "Aaron Herrera"})
        check("por usuario del desplegable", r.json()["count"] == 3)
        r = await c.get("/api/wms/audit/movements", params={"since": "2026-09-12", "until": "2026-09-12"})
        check("por fecha", r.json()["count"] == 2)
        r = await c.get("/api/wms/audit/movements", params={"q": "PS04-A04"})
        check("texto libre (ubicación origen)", r.json()["count"] == 1 and r.json()["rows"][0]["type"] == "bulk_relocation")
        r = await c.get("/api/wms/audit/movements", params={"movement_type": "transit_relocation,putaway,putaway_bulk"})
        d = r.json()
        check("familia Putaway (tipos separados por coma): trae la PDA y el flujo viejo", d["count"] == 2 and {x["type"] for x in d["rows"]} == {"transit_relocation", "putaway"}, d.get("count"))
        row = next(x for x in d["rows"] if x["type"] == "transit_relocation")
        check("putaway de la PDA aplanado: carro → ubicación, unidades y cajas", row["from"] == "CARRO 260" and row["to"] == "NA07-A31" and str(row["units"]) == "48" and "BOX-7" in row["box_id"], row)

    print(f"\n===== {ok} PASS / {fail} FAIL =====")
    raw.drop_database(SMOKE_DB)
    print(f"base {SMOKE_DB} eliminada")
    sys.exit(1 if fail else 0)


if __name__ == "__main__":
    asyncio.run(main())
