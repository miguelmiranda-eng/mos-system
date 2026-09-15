"""Smoke — descuento en LOTE de la PDA (PUT /pick-tickets/{id}/pick-boxes) y
my-tickets ligero + size-locations por ticket.

Contrato:
  · Un lote de N cajas (varias tallas, misma ubicación) descuenta cada caja
    de SU caja escaneada, deja picked_sizes/deducted_map acumulados por
    (talla, ubicación), un solo movimiento pick_boxes y el renglón de
    inventario reproyectado UNA vez por celda (cajas == renglón).
  · Rechaza: lote vacío, caja repetida, exceder lo requerido, caja de otro
    material (409 sin tocar nada), ticket de otro operador (403).
  · Idempotencia de la PDA: re-mandar las mismas cajas ya vacías → 409 y no
    descuenta doble.
  · my-tickets?light=1 no trae size_locations ni deducted_map; el endpoint
    por ticket sí calcula las ubicaciones vivas.

Corre contra una base DESECHABLE (igual que smoke_wms_movements.py).
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


LOC = "PS09-A32"
LOTE = {"country_of_origin": "NICARAGUA", "fabric_content": "100% COTTON"}


def box(i, size, units):
    return {"box_id": f"PB-{i}", "style": "5000", "sku": f"5000-BLACK-{size}", "color": "BLACK",
            "size": size, "location": LOC, "units": units, "status": "located", "state": "located",
            "customer": "GOODIE TWO SLEEVES", **LOTE}


def sembrar():
    raw.drop_database(SMOKE_DB)
    sdb.wms_locations.insert_one({"name": LOC, "location_id": "loc_pb", "active": True})
    for role, uid in (("operator", "u_pick"), ("operator", "u_otro")):
        sdb.users.insert_one({"user_id": uid, "email": f"{uid}@test.local", "name": uid,
                              "password_hash": bcrypt.hash("smoke123"), "role": role, "active": True})
    # 3 cajas L (72, 72, 30) y 2 cajas M (48, 48) en la misma ubicación.
    for i, (sz, u) in enumerate([("L", 72), ("L", 72), ("L", 30), ("M", 48), ("M", 48)]):
        sdb.wms_boxes.insert_one(box(i, sz, u))
    for sz, u, n in (("L", 174, 3), ("M", 96, 2)):
        sdb.wms_inventory.insert_one({"inventory_id": f"inv_pb_{sz}", "sku": f"5000-BLACK-{sz}", "style": "5000",
                                      "color": "BLACK", "size": sz, "location": LOC, "units_on_hand": u,
                                      "total_boxes": n, "units_allocated": 0, "customer": "GOODIE TWO SLEEVES", **LOTE})
    # Caja de OTRO material en la misma ubicación (para el cross-check).
    sdb.wms_boxes.insert_one({**box(9, "L", 24), "box_id": "PB-OTRO", "style": "64000", "sku": "64000-BLACK-L"})
    sdb.wms_pick_tickets.insert_one({
        "ticket_id": "pick_smoke_pb", "order_number": "9999", "style": "5000", "color": "BLACK",
        "customer": "GOODIE TWO SLEEVES", "sizes": {"L": 150, "M": 100}, "picked_sizes": {}, "deducted_map": {},
        "status": "pending", "picking_status": "pending", "assigned_to": "u_pick",
        "assigned_at": "2026-09-15T00:00:00+00:00", "size_locations": {"L": {"snapshot": True}},
    })


def units(box_id):
    return int((sdb.wms_boxes.find_one({"box_id": box_id}) or {}).get("units", -1))


def row(sz):
    return sdb.wms_inventory.find_one({"location": LOC, "style": "5000", "size": sz}) or {}


async def login(c, uid):
    r = await c.post("/api/auth/login", json={"email": f"{uid}@test.local", "password": "smoke123"})
    return r.status_code == 200


async def main():
    sembrar()
    from httpx import ASGITransport, AsyncClient
    from server import app
    tr = ASGITransport(app=app)
    async with AsyncClient(transport=tr, base_url="http://smoke") as cp, \
               AsyncClient(transport=tr, base_url="http://smoke") as co:
        check("login picker / otro", await login(cp, "u_pick") and await login(co, "u_otro"))
        T = "/api/wms/pick-tickets/pick_smoke_pb"

        print("\n== 1. my-tickets ligero + ubicaciones por ticket ==")
        r = await cp.get("/api/wms/operator/my-tickets?light=1")
        tk = r.json()[0] if r.status_code == 200 and r.json() else {}
        check("lista ligera responde", r.status_code == 200 and tk.get("ticket_id") == "pick_smoke_pb", r.text[:120])
        check("sin size_locations ni deducted_map", "size_locations" not in tk and "deducted_map" not in tk, list(tk))
        check("trae lo que la lista pinta", all(k in tk for k in ("sizes", "picked_sizes", "style", "color", "customer", "order_number")))
        r = await cp.get(f"{T}/size-locations")
        sl = r.json().get("size_locations", {}) if r.status_code == 200 else {}
        locs_L = (sl.get("L") or {}).get("locations") or sl.get("L") or []
        check("size-locations calcula stock VIVO (L en PS09-A32)", any((l.get("location") or "").upper() == LOC for l in locs_L), str(sl)[:200])
        r = await co.get(f"{T}/size-locations")
        check("otro operador no ve el ticket (403)", r.status_code == 403, r.status_code)

        print("\n== 2. Validaciones sin tocar stock ==")
        for body, why in (
            ({"location": LOC, "boxes": []}, "lote vacío"),
            ({"location": LOC, "boxes": [{"box_id": "PB-0", "size": "L", "qty": 10}, {"box_id": "PB-0", "size": "L", "qty": 5}]}, "caja repetida"),
            ({"location": LOC, "boxes": [{"box_id": "PB-0", "size": "L", "qty": 72}, {"box_id": "PB-1", "size": "L", "qty": 72}, {"box_id": "PB-2", "size": "L", "qty": 30}]}, "excede lo requerido (174 > 150)"),
        ):
            r = await cp.put(f"{T}/pick-boxes", json=body)
            check(f"rechaza {why} (400)", r.status_code == 400, f"{r.status_code} {r.text[:100]}")
        r = await co.put(f"{T}/pick-boxes", json={"location": LOC, "boxes": [{"box_id": "PB-0", "size": "L", "qty": 10}]})
        check("otro operador no descuenta (403)", r.status_code == 403, r.status_code)
        r = await cp.put(f"{T}/pick-boxes", json={"location": LOC, "boxes": [{"box_id": "PB-OTRO", "size": "L", "qty": 10}]})
        check("caja de otro material → 409", r.status_code == 409, f"{r.status_code} {r.text[:120]}")
        check("nada se movió", units("PB-0") == 72 and units("PB-OTRO") == 24 and row("L").get("units_on_hand") == 174)
        check("ticket intacto", not sdb.wms_pick_tickets.find_one({"ticket_id": "pick_smoke_pb"}).get("deducted_map"))

        print("\n== 3. Lote real: 2 tallas, 4 cajas, un viaje ==")
        r = await cp.put(f"{T}/pick-boxes", json={"location": LOC, "boxes": [
            {"box_id": "PB-0", "size": "L", "qty": 72}, {"box_id": "PB-1", "size": "L", "qty": 50},
            {"box_id": "PB-3", "size": "M", "qty": 48}, {"box_id": "PB-4", "size": "M", "qty": 12},
        ]})
        d = r.json() if r.status_code == 200 else {}
        check("lote 200", r.status_code == 200, r.text[:200])
        check("resumen: 182 pz, per_size L=122 M=60", d.get("deducted") == 182 and d.get("per_size") == {"L": 122, "M": 60}, d)
        check("cada caja bajó lo suyo", (units("PB-0"), units("PB-1"), units("PB-2"), units("PB-3"), units("PB-4")) == (0, 22, 30, 0, 36),
              (units("PB-0"), units("PB-1"), units("PB-2"), units("PB-3"), units("PB-4")))
        check("renglón L reproyectado = suma de cajas (52)", row("L").get("units_on_hand") == 52 and row("L").get("total_boxes") == 2, row("L"))
        check("renglón M reproyectado = suma de cajas (36)", row("M").get("units_on_hand") == 36 and row("M").get("total_boxes") == 1, row("M"))
        t = sdb.wms_pick_tickets.find_one({"ticket_id": "pick_smoke_pb"})
        check("picked_sizes acumulado", t["picked_sizes"]["L"] == {"total": 122, "details": {LOC: 122}} and t["picked_sizes"]["M"]["total"] == 60, t["picked_sizes"])
        check("deducted_map acumulado", t["deducted_map"] == {"L": {LOC: 122}, "M": {LOC: 60}}, t["deducted_map"])
        check("UN movimiento pick_boxes con 4 cajas",
              sdb.wms_movements.count_documents({"type": "pick_boxes"}) == 1
              and len(sdb.wms_movements.find_one({"type": "pick_boxes"})["details"]["boxes"]) == 4)
        check("4 pick_deduction (rastro por caja)", sdb.wms_movements.count_documents({"type": "pick_deduction"}) == 4)

        print("\n== 4. Segundo lote y tope ==")
        r = await cp.put(f"{T}/pick-boxes", json={"location": LOC, "boxes": [{"box_id": "PB-1", "size": "L", "qty": 22}, {"box_id": "PB-2", "size": "L", "qty": 6}]})
        check("segundo lote acumula (L 150/150)", r.status_code == 200 and sdb.wms_pick_tickets.find_one({"ticket_id": "pick_smoke_pb"})["deducted_map"]["L"][LOC] == 150, r.text[:160])
        r = await cp.put(f"{T}/pick-boxes", json={"location": LOC, "boxes": [{"box_id": "PB-2", "size": "L", "qty": 1}]})
        check("ya completa: 1 más excede (400)", r.status_code == 400, f"{r.status_code} {r.text[:100]}")
        r = await cp.put(f"{T}/pick-boxes", json={"location": LOC, "boxes": [{"box_id": "PB-3", "size": "M", "qty": 1}]})
        check("caja ya vacía → 409, no descuenta doble", r.status_code == 409 and units("PB-3") == 0, f"{r.status_code} {r.text[:120]}")
        check("renglón L final = cajas (24)", row("L").get("units_on_hand") == 24, row("L"))

    print(f"\n===== {ok} PASS / {fail} FAIL =====")
    raw.drop_database(SMOKE_DB)
    print(f"base {SMOKE_DB} eliminada")
    sys.exit(1 if fail else 0)


if __name__ == "__main__":
    asyncio.run(main())
