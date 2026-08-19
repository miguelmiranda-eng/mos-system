"""Smoke de /recon/commit: NO puede fundir lotes ni borrar lo comprometido.

QUE BLINDA
──────────
recon_commit borra TODOS los renglones de una ubicacion y los reinserta desde
lo que el picker escaneo. Es el escritor mas destructivo del WMS y esta abierto
al rol picker. Hasta 2026-08-03 tenia tres defectos, cada uno capaz de destruir
datos que no se recuperan solos:

  1. Agrupaba por (style, color, size) A SECAS, con los metadatos de la PRIMERA
     caja del cursor. Una ubicacion con cajas de Honduras y de Nicaragua del
     mismo style/color/talla se fundia en UN renglon con el pais de una de las
     dos, al azar. El pais de origen es requisito legal de etiquetado en
     confeccion importada a EUA. Simulacion sobre 1,200 ubicaciones reales: 43
     fundian paises distintos, hasta 3,545 u en una sola celda.
  2. Reinsertaba con units_allocated=0: cualquier compromiso de picking abierto
     ahi desaparecia del papel sin dejar rastro.
  3. Ligaba las cajas a su renglon con un regex de style/color/size que NO
     distingue lotes, asi que reasignaba las cajas de Honduras al renglon de
     Nicaragua.

Este smoke ejercita el endpoint REAL por HTTP y fija los tres contratos.

SEGURIDAD: igual que los demas smoke — base DESECHABLE, se niega contra
produccion y borra la base al terminar.

USO
───
    set MONGODB_URL=mongodb://localhost:27017
    python backend/tests/smoke_wms_recon_commit_lotes.py
"""
import asyncio
import os
import sys

BE = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
SMOKE_DB = os.environ.get("SMOKE_DB_NAME", "mos-smoke-recon-lotes")
PROD_DB = os.environ.get("PROD_DB_NAME", "mos-system")
MONGO = os.environ.get("MONGODB_URL") or os.environ.get("MONGO_URL")

if not MONGO:
    sys.exit("Falta MONGODB_URL")
if SMOKE_DB == PROD_DB:
    sys.exit(f"NEGADO: SMOKE_DB_NAME es la base de produccion ('{PROD_DB}'). "
             f"Este script BORRA la base al terminar.")

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

LOC = "PS09-A11"
FAB = "100% COTTON"


def check(nombre, cond, detalle=""):
    global ok, fail
    if cond:
        ok += 1
        print(f"   PASS  {nombre}")
    else:
        fail += 1
        print(f"   FAIL  {nombre}  {detalle}")


def caja(bid, pais, units):
    return {"box_id": bid, "barcode": bid, "lpn_id": bid,
            "style": "18000", "sku": "18000-SAND-2X", "color": "SAND", "size": "2X",
            "location": LOC, "units": units, "qty": units, "status": "located",
            "customer": "GOODIE TWO SLEEVES", "manufacturer": "GILDAN",
            "country_of_origin": pais, "coo": pais, "fabric_content": FAB}


def sembrar():
    print(f"== Sembrando {SMOKE_DB} ==")
    for c in ["wms_inventory", "wms_boxes", "wms_locations", "wms_movements",
              "wms_incidents", "wms_reconciled_locations", "wms_recon_bak",
              "users", "user_sessions", "counters"]:
        sdb[c].delete_many({})
    sdb.wms_locations.insert_one({"name": LOC, "location_id": "loc_" + LOC})

    # El caso canonico documentado en services/inventory_ledger.py: DOS lotes
    # legitimos del MISMO style/color/talla conviviendo en una ubicacion.
    for bid, u in [("BOX-090001", 36), ("BOX-090002", 36)]:
        sdb.wms_boxes.insert_one(caja(bid, "HONDURAS", u))
    for bid, u in [("BOX-090003", 60), ("BOX-090004", 60)]:
        sdb.wms_boxes.insert_one(caja(bid, "NICARAGUA", u))

    # Un renglon por lote, y el de HONDURAS con material COMPROMETIDO.
    sdb.wms_inventory.insert_one({
        "inventory_id": "inv_hon", "style": "18000", "sku": "18000-SAND-2X",
        "color": "SAND", "size": "2X", "location": LOC,
        "country_of_origin": "HONDURAS", "fabric_content": FAB,
        "units_on_hand": 72, "total_boxes": 2, "units_allocated": 24,
        "customer": "GOODIE TWO SLEEVES"})
    sdb.wms_inventory.insert_one({
        "inventory_id": "inv_nic", "style": "18000", "sku": "18000-SAND-2X",
        "color": "SAND", "size": "2X", "location": LOC,
        "country_of_origin": "NICARAGUA", "fabric_content": FAB,
        "units_on_hand": 120, "total_boxes": 2, "units_allocated": 0,
        "customer": "GOODIE TWO SLEEVES"})

    sdb.users.insert_one({
        "user_id": "u_smoke", "email": "smoke@test.local", "name": "Smoke Tester",
        "password_hash": bcrypt.hash("smoke123"),
        "role": "supersu", "admin_level": 5, "inventory_level": 5, "active": True,
    })


async def main():
    sembrar()
    from httpx import ASGITransport, AsyncClient
    from server import app

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://smoke") as c:
        r = await c.post("/api/auth/login",
                         json={"email": "smoke@test.local", "password": "smoke123"})
        check("login", r.status_code == 200, f"{r.status_code} {r.text[:160]}")
        if r.status_code != 200:
            return

        print("\n== Conciliar la ubicacion escaneando las 4 cajas (2 lotes) ==")
        r = await c.post("/api/wms/recon/commit", json={
            "location": LOC,
            "scanned_box_ids": ["BOX-090001", "BOX-090002", "BOX-090003", "BOX-090004"]})
        d = r.json() if r.status_code == 200 else {}
        check("commit responde 200", r.status_code == 200, f"{r.status_code} {r.text[:200]}")
        check("4 cajas confirmadas", d.get("confirmadas") == 4, f"{d}")
        check("0 faltantes", d.get("faltantes") == 0, f"{d}")

        filas = list(sdb.wms_inventory.find({"location": LOC}, {"_id": 0}))
        por_pais = {f.get("country_of_origin"): f for f in filas}

        print("\n== 1. Los lotes NO se funden ==")
        check("quedan DOS renglones, uno por lote", len(filas) == 2,
              f"{len(filas)} renglon(es): {[(f.get('country_of_origin'), f.get('units_on_hand')) for f in filas]}")
        check("existe el renglon de HONDURAS", "HONDURAS" in por_pais, f"{list(por_pais)}")
        check("existe el renglon de NICARAGUA", "NICARAGUA" in por_pais, f"{list(por_pais)}")
        check("HONDURAS con 72u/2c",
              (por_pais.get("HONDURAS") or {}).get("units_on_hand") == 72
              and (por_pais.get("HONDURAS") or {}).get("total_boxes") == 2,
              f"{por_pais.get('HONDURAS')}")
        check("NICARAGUA con 120u/2c",
              (por_pais.get("NICARAGUA") or {}).get("units_on_hand") == 120
              and (por_pais.get("NICARAGUA") or {}).get("total_boxes") == 2,
              f"{por_pais.get('NICARAGUA')}")
        check("el total fisico se conserva (192u)",
              sum(int(f.get("units_on_hand") or 0) for f in filas) == 192,
              f"{sum(int(f.get('units_on_hand') or 0) for f in filas)}")

        print("\n== 2. Lo comprometido sobrevive ==")
        check("HONDURAS conserva units_allocated=24",
              (por_pais.get("HONDURAS") or {}).get("units_allocated") == 24,
              f"{(por_pais.get('HONDURAS') or {}).get('units_allocated')}")
        check("NICARAGUA sigue en 0 comprometido",
              (por_pais.get("NICARAGUA") or {}).get("units_allocated") == 0,
              f"{(por_pais.get('NICARAGUA') or {}).get('units_allocated')}")

        print("\n== 3. Cada caja apunta al renglon de SU lote ==")
        id_hon = (por_pais.get("HONDURAS") or {}).get("inventory_id")
        id_nic = (por_pais.get("NICARAGUA") or {}).get("inventory_id")
        cajas = {b["box_id"]: b.get("inventory_id")
                 for b in sdb.wms_boxes.find({"location": LOC}, {"_id": 0, "box_id": 1, "inventory_id": 1})}
        check("BOX-090001 (HONDURAS) -> renglon de HONDURAS",
              cajas.get("BOX-090001") == id_hon, f"{cajas.get('BOX-090001')} vs {id_hon}")
        check("BOX-090002 (HONDURAS) -> renglon de HONDURAS",
              cajas.get("BOX-090002") == id_hon, f"{cajas.get('BOX-090002')} vs {id_hon}")
        check("BOX-090003 (NICARAGUA) -> renglon de NICARAGUA",
              cajas.get("BOX-090003") == id_nic, f"{cajas.get('BOX-090003')} vs {id_nic}")
        check("BOX-090004 (NICARAGUA) -> renglon de NICARAGUA",
              cajas.get("BOX-090004") == id_nic, f"{cajas.get('BOX-090004')} vs {id_nic}")
        check("ninguna caja quedo cruzada de lote",
              id_hon != id_nic and len({cajas.get(b) for b in cajas}) == 2,
              f"{cajas}")

        print("\n== 4. Un compromiso que se queda sin lote fisico se reporta ==")
        # Segunda ubicacion: el renglon comprometido es de un lote cuyas cajas
        # NO se escanean, asi que su allocation no tiene a donde volver.
        L2 = "PS09-B22"
        sdb.wms_locations.insert_one({"name": L2, "location_id": "loc_" + L2})
        b = caja("BOX-090010", "HAITI", 48); b["location"] = L2
        sdb.wms_boxes.insert_one(b)
        sdb.wms_inventory.insert_one({
            "inventory_id": "inv_fantasma", "style": "18000", "sku": "18000-SAND-2X",
            "color": "SAND", "size": "2X", "location": L2,
            "country_of_origin": "PAKISTAN", "fabric_content": FAB,
            "units_on_hand": 90, "total_boxes": 1, "units_allocated": 30})
        r = await c.post("/api/wms/recon/commit",
                         json={"location": L2, "scanned_box_ids": ["BOX-090010"]})
        check("commit responde 200", r.status_code == 200, f"{r.status_code} {r.text[:200]}")
        f2 = list(sdb.wms_inventory.find({"location": L2}, {"_id": 0}))
        check("queda solo el lote fisico (HAITI 48u)",
              len(f2) == 1 and f2[0].get("country_of_origin") == "HAITI"
              and f2[0].get("units_on_hand") == 48, f"{f2}")
        inc = sdb.wms_incidents.find_one({"kind": "recon_allocation_huerfana"}, {"_id": 0})
        check("se registro la incidencia de allocation huerfana", inc is not None, f"{inc}")
        check("la incidencia dice cuantas unidades quedaron sin respaldo",
              (inc or {}).get("unidades") == 30, f"{(inc or {}).get('unidades')}")


try:
    asyncio.run(main())
finally:
    raw.drop_database(SMOKE_DB)
    print(f"\n== Base {SMOKE_DB} eliminada ==")
    print(f"{ok} PASS · {fail} FAIL")
    sys.exit(1 if fail else 0)
