"""Smoke test del parche 2026-07-23: el escaneo de cicloconteo limpia
`recon_pending`.

INCIDENTE QUE BLINDA
────────────────────
Una caja marcada `recon_pending` por una conciliación PDA seguía marcada aunque
un cicloconteo posterior la escaneara físicamente y la ubicación cerrara 'ok'
(pestaña Cuadradas) — el cierre del pase 1 "no toca inventario". El writeoff
339273a1 (2026-07-22) barría por status y borró 21 cajas físicamente
confirmadas (1,138u; restauradas con restore_ccok_writeoff_boxes.py).

El parche vive en /cycle-counts/{id}/scan-location: un escaneo físico ES
presencia — la caja recon_pending que se escanea vuelve a 'located' ahí mismo,
con movimiento `cycle_count_recon_cleared` de rastro. Este smoke fija ese
contrato contra el router real.

SEGURIDAD: igual que los otros smoke — base DESECHABLE, se niega contra
producción y borra la base al terminar.

USO
───
    set MONGODB_URL=mongodb://usuario:clave@host:27017/?authSource=admin
    python backend/tests/smoke_wms_cyclecount_recon.py
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
    sys.exit(f"NEGADO: SMOKE_DB_NAME es la base de producción ('{PROD_DB}'). "
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
    for c in ["wms_inventory", "wms_boxes", "wms_locations", "wms_movements",
              "wms_cycle_counts", "wms_incidents", "users", "user_sessions"]:
        sdb[c].delete_many({})
    sdb.wms_locations.insert_one({"name": "PS05-A09", "location_id": "loc_PS05-A09"})
    # La caja del incidente: físicamente en el rack, pero una conciliación vieja
    # la dio por faltante y quedó recon_pending.
    sdb.wms_boxes.insert_one({
        "box_id": "BOX-019001", "style": "5000", "color": "BLACK", "size": "XL",
        "location": "PS05-A09", "units": 72, "qty": 72,
        "status": "recon_pending", "recon_pending": True,
        "recon_missing_from": "PS05-A09",
        "recon_flagged_at": "2026-07-09T20:11:00+00:00",
    })
    # Una compañera sana, para que el conteo tenga más de una esperada.
    sdb.wms_boxes.insert_one({
        "box_id": "BOX-019002", "style": "5000", "color": "BLACK", "size": "XL",
        "location": "PS05-A09", "units": 72, "qty": 72, "status": "located",
    })
    # Conteo cíclico box_scan con la ubicación pendiente (misma forma que crea
    # el endpoint /cycle-counts).
    sdb.wms_cycle_counts.insert_one({
        "count_id": "cc_smoke_recon", "name": "smoke", "status": "pending",
        "mode": "box_scan", "is_general": False,
        "scan_locations": [{
            "loc_id": "ccl_smoke", "location": "PS05-A09", "pass": 1,
            "status": "pending",
            "expected_boxes": ["BOX-019001", "BOX-019002"],
            "scanned_boxes": [], "missing": [], "extra": [],
            "counted_by": None, "counted_by_name": None, "counted_at": None,
            "history": [],
        }],
        "total_scan_locations": 1,
        "created_at": "2026-07-23T00:00:00+00:00",
    })
    # Escenario 2 (ola 1 de un-solo-escritor): merma confirmada por doble
    # conteo — el marcador debe REESCRIBIRSE desde las cajas, no restarse.
    sdb.wms_locations.insert_one({"name": "PS05-B01", "location_id": "loc_PS05-B01"})
    sdb.wms_inventory.insert_one({
        "inventory_id": "inv_smoke_merma", "sku": "3001-GREY-M", "style": "3001",
        "color": "GREY", "size": "M", "location": "PS05-B01",
        "country_of_origin": "BANGLADESH", "fabric_content": "60% COTTON 40% POLYESTER",
        "units_on_hand": 194, "total_boxes": 2, "units_allocated": 0,
    })
    for bid, u in [("BOX-M1", 122), ("BOX-M2", 72)]:
        sdb.wms_boxes.insert_one({
            "box_id": bid, "style": "3001", "sku": "3001-GREY-M", "color": "GREY",
            "size": "M", "location": "PS05-B01", "units": u, "qty": u, "status": "located",
            "country_of_origin": "BANGLADESH", "fabric_content": "60% COTTON 40% POLYESTER",
        })
    sdb.wms_cycle_counts.insert_one({
        "count_id": "cc_smoke_merma", "name": "merma", "status": "pending",
        "mode": "box_scan", "is_general": False,
        "scan_locations": [{
            "loc_id": "ccl_merma", "location": "PS05-B01", "pass": 1,
            "status": "pending", "expected_boxes": ["BOX-M1", "BOX-M2"],
            "scanned_boxes": [], "missing": [], "extra": [],
            "counted_by": None, "counted_by_name": None, "counted_at": None,
            "history": [],
        }],
        "total_scan_locations": 1,
        "created_at": "2026-07-23T00:00:00+00:00",
    })
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

        print("\n== Escanear la caja recon_pending la limpia ==")
        r = await c.post("/api/wms/cycle-counts/cc_smoke_recon/scan-location",
                         json={"location": "PS05-A09", "box_id": "BOX-019001"})
        check("scan 200", r.status_code == 200, f"{r.status_code} {r.text[:200]}")
        d = r.json() if r.status_code == 200 else {}
        check("caja esperada aquí", d.get("expected_here") is True, f"{d}")
        box = sdb.wms_boxes.find_one({"box_id": "BOX-019001"}, {"_id": 0})
        check("status -> located", box.get("status") == "located", f"{box.get('status')}")
        check("recon_pending limpio", box.get("recon_pending") is False, f"{box.get('recon_pending')}")
        check("recon_missing_from limpio", box.get("recon_missing_from") is None,
              f"{box.get('recon_missing_from')}")
        check("rastro de por qué se limpió",
              box.get("recon_cleared_via") == "cycle_count_scan"
              and box.get("recon_cleared_count_id") == "cc_smoke_recon", f"{box}")
        mv = sdb.wms_movements.find_one({"type": "cycle_count_recon_cleared"}, {"_id": 0})
        check("movimiento cycle_count_recon_cleared",
              mv is not None and mv["details"].get("box_id") == "BOX-019001"
              and mv["details"].get("was_missing_from") == "PS05-A09", f"{mv}")
        # Las unidades NO se tocan: limpiar el status no es ajustar inventario.
        check("unidades intactas", box.get("units") == 72, f"{box.get('units')}")

        print("\n== Una caja sana no genera rastro de rescate ==")
        r = await c.post("/api/wms/cycle-counts/cc_smoke_recon/scan-location",
                         json={"location": "PS05-A09", "box_id": "BOX-019002"})
        check("scan 200", r.status_code == 200, f"{r.status_code}")
        n = sdb.wms_movements.count_documents({"type": "cycle_count_recon_cleared"})
        check("solo 1 movimiento de rescate", n == 1, f"{n}")
        box2 = sdb.wms_boxes.find_one({"box_id": "BOX-019002"}, {"_id": 0})
        check("caja sana sin marcas de rescate", "recon_cleared_via" not in box2, f"{box2}")

        print("\n== El cierre 'ok' (Cuadradas) ya no deja cajas marcadas ==")
        r = await c.post("/api/wms/cycle-counts/cc_smoke_recon/close-location",
                         json={"location": "PS05-A09"})
        check("close 200", r.status_code == 200, f"{r.status_code} {r.text[:200]}")
        d = r.json() if r.status_code == 200 else {}
        check("ubicación cuadra (matched)", d.get("matched") is True, f"{d}")
        check("cero recon_pending al final",
              sdb.wms_boxes.count_documents({"status": "recon_pending"}) == 0)

        print("\n== Merma por doble conteo: el marcador se REESCRIBE desde cajas ==")
        # Pase 1: solo aparece BOX-M1 -> discrepancia -> pase 2.
        r = await c.post("/api/wms/cycle-counts/cc_smoke_merma/scan-location",
                         json={"location": "PS05-B01", "box_id": "BOX-M1"})
        check("pase 1: scan BOX-M1", r.status_code == 200, f"{r.status_code}")
        r = await c.post("/api/wms/cycle-counts/cc_smoke_merma/close-location",
                         json={"location": "PS05-B01"})
        d = r.json() if r.status_code == 200 else {}
        check("pase 1 no cuadra -> va al 2do conteo",
              r.status_code == 200 and not d.get("matched"), f"{r.status_code} {d}")
        # Pase 2: el segundo contador ve lo mismo -> discrepancia CONFIRMADA.
        r = await c.post("/api/wms/cycle-counts/cc_smoke_merma/scan-location",
                         json={"location": "PS05-B01", "box_id": "BOX-M1"})
        check("pase 2: scan BOX-M1", r.status_code == 200, f"{r.status_code}")
        r = await c.post("/api/wms/cycle-counts/cc_smoke_merma/close-location",
                         json={"location": "PS05-B01"})
        d = r.json() if r.status_code == 200 else {}
        check("pase 2 confirma y resuelve", r.status_code == 200 and d.get("resolution") is not None,
              f"{r.status_code} {d}")
        check("1 caja mermada", (d.get("resolution") or {}).get("shrunk") == 1, f"{d.get('resolution')}")
        b2 = sdb.wms_boxes.find_one({"box_id": "BOX-M2"}, {"_id": 0, "units": 1, "status": 1})
        check("BOX-M2 agotada (0u, depleted)",
              b2 and b2.get("units") == 0 and b2.get("status") == "depleted", f"{b2}")
        fila = sdb.wms_inventory.find_one({"location": "PS05-B01", "style": "3001"}, {"_id": 0})
        check("marcador REESCRITO == caja restante (122u/1c)",
              fila and fila.get("units_on_hand") == 122 and fila.get("total_boxes") == 1,
              f"{fila and (fila.get('units_on_hand'), fila.get('total_boxes'))}")
        check("lote del marcador preservado (BANGLADESH)",
              fila and fila.get("country_of_origin") == "BANGLADESH",
              f"{fila and fila.get('country_of_origin')}")


try:
    asyncio.run(main())
finally:
    raw.drop_database(SMOKE_DB)
    print(f"\n== Base {SMOKE_DB} eliminada ==")
    print(f"{ok} PASS · {fail} FAIL")
    sys.exit(1 if fail else 0)
