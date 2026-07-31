"""Smoke test de los KPIs de inventario del reporte de cicloconteo
(GET /cycle-counts/{id}/report -> inventory_kpis).

QUÉ FIJA
────────
El bloque `inventory_kpis` que alimenta la pestaña KPIs: Total piezas/cajas en
sistema, Discrepancia neta/absoluta (en CAJAS para box_scan), ILA (Inventory
Location Accuracy, por ubicación) e IRA (Inventory Record Accuracy, ponderado
por piezas). Todo sale del SNAPSHOT del conteo, no de datos vivos — de modo que
un conteo ya resuelto no muestra cifras que su propia resolución acaba de cuadrar.

ESCENARIO (conteo general box_scan, 2 ubicaciones)
──────────────────────────────────────────────────
  • PS01-A01: sistema espera BOX-A1(50u) + BOX-A2(30u) = 80u / 2 cajas.
    El contador escanea las dos -> cuadra al pase 1 -> ubicación PERFECTA.
  • PS01-B01: sistema espera BOX-B1(40u) + BOX-B2(60u) = 100u / 2 cajas.
    El contador solo encuentra BOX-B1 en dos pases -> discrepancia CONFIRMADA
    -> BOX-B2 (60u) se agota (merma). Ubicación con hallazgo.

  Esperado:
    system_pieces  = 80 + 100      = 180   (Σ system_qty de las líneas snapshot)
    system_boxes   = 2 + 2         = 4     (Σ expected_boxes)
    net (cajas)    = 0 sobrantes − 1 faltante = -1
    abs (cajas)    = 0 + 1         = 1
    ILA            = 1 perfecta / 2 cerradas = 50.0%
    IRA            = 1 − 60/180    = 66.7%  (60 piezas faltantes de BOX-B2,
                                             recuperadas del cycle_count_shrink)

SEGURIDAD: base DESECHABLE, se niega contra producción, se dropea al terminar.

USO
───
    set MONGODB_URL=mongodb://usuario:clave@host:27017/?authSource=admin
    python backend/tests/smoke_wms_cc_inventory_kpis.py
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
    sdb.wms_locations.insert_many([
        {"name": "PS01-A01", "location_id": "loc_A01", "active": True},
        {"name": "PS01-B01", "location_id": "loc_B01", "active": True},
    ])
    # Marcadores de inventario (de aquí salen las líneas snapshot -> system_qty).
    sdb.wms_inventory.insert_many([
        {"inventory_id": "inv_A", "sku": "ST-A", "style": "ST-A", "color": "BLACK",
         "size": "M", "location": "PS01-A01", "units_on_hand": 80, "total_boxes": 2,
         "units_allocated": 0},
        {"inventory_id": "inv_B", "sku": "ST-B", "style": "ST-B", "color": "BLACK",
         "size": "M", "location": "PS01-B01", "units_on_hand": 100, "total_boxes": 2,
         "units_allocated": 0},
    ])
    sdb.wms_boxes.insert_many([
        {"box_id": "BOX-A1", "sku": "ST-A", "style": "ST-A", "color": "BLACK",
         "size": "M", "location": "PS01-A01", "units": 50, "qty": 50, "status": "located"},
        {"box_id": "BOX-A2", "sku": "ST-A", "style": "ST-A", "color": "BLACK",
         "size": "M", "location": "PS01-A01", "units": 30, "qty": 30, "status": "located"},
        {"box_id": "BOX-B1", "sku": "ST-B", "style": "ST-B", "color": "BLACK",
         "size": "M", "location": "PS01-B01", "units": 40, "qty": 40, "status": "located"},
        {"box_id": "BOX-B2", "sku": "ST-B", "style": "ST-B", "color": "BLACK",
         "size": "M", "location": "PS01-B01", "units": 60, "qty": 60, "status": "located"},
    ])
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

        print("\n== Crear conteo general box_scan ==")
        r = await c.post("/api/wms/cycle-counts",
                         json={"name": "kpi-smoke", "is_general": True, "mode": "box_scan"})
        check("crear 200", r.status_code == 200, f"{r.status_code} {r.text[:200]}")
        if r.status_code != 200:
            return
        cc = r.json()
        cid = cc["count_id"]
        check("2 líneas snapshot", cc.get("total_lines") == 2, f"{cc.get('total_lines')}")
        check("2 ubicaciones a escanear", cc.get("total_scan_locations") == 2,
              f"{cc.get('total_scan_locations')}")

        async def scan(loc, box):
            return await c.post(f"/api/wms/cycle-counts/{cid}/scan-location",
                                json={"location": loc, "box_id": box})

        async def close(loc):
            return await c.post(f"/api/wms/cycle-counts/{cid}/close-location",
                                json={"location": loc})

        print("\n== PS01-A01: cuadra al pase 1 (perfecta) ==")
        await scan("PS01-A01", "BOX-A1")
        await scan("PS01-A01", "BOX-A2")
        r = await close("PS01-A01")
        d = r.json() if r.status_code == 200 else {}
        check("A01 cuadra", d.get("matched") is True, f"{r.status_code} {d}")

        print("\n== PS01-B01: falta BOX-B2, se confirma en 2 pases (merma) ==")
        await scan("PS01-B01", "BOX-B1")
        r = await close("PS01-B01")
        d = r.json() if r.status_code == 200 else {}
        check("B01 pase 1 no cuadra -> 2do conteo",
              r.status_code == 200 and not d.get("matched") and d.get("pass") == 2, f"{d}")
        await scan("PS01-B01", "BOX-B1")
        r = await close("PS01-B01")
        d = r.json() if r.status_code == 200 else {}
        check("B01 pase 2 confirma y merma 1 caja",
              (d.get("resolution") or {}).get("shrunk") == 1, f"{d.get('resolution')}")
        b2 = sdb.wms_boxes.find_one({"box_id": "BOX-B2"}, {"_id": 0, "units": 1, "status": 1})
        check("BOX-B2 agotada", b2 and b2.get("units") == 0 and b2.get("status") == "depleted", f"{b2}")

        print("\n== Reporte -> inventory_kpis ==")
        r = await c.get(f"/api/wms/cycle-counts/{cid}/report")
        check("reporte 200", r.status_code == 200, f"{r.status_code} {r.text[:200]}")
        inv = (r.json() or {}).get("inventory_kpis") or {}
        check("es box_scan", inv.get("is_box_scan") is True, f"{inv}")
        check("piezas en sistema = 180", inv.get("system_pieces") == 180, f"{inv.get('system_pieces')}")
        check("cajas en sistema = 4", inv.get("system_boxes") == 4, f"{inv.get('system_boxes')}")
        check("discrepancia en cajas", inv.get("discrepancy_unit") == "cajas", f"{inv.get('discrepancy_unit')}")
        check("discrepancia neta = -1", inv.get("net_discrepancy") == -1, f"{inv.get('net_discrepancy')}")
        check("discrepancia absoluta = 1", inv.get("abs_discrepancy") == 1, f"{inv.get('abs_discrepancy')}")
        check("ILA = 50.0%", inv.get("ila_pct") == 50.0, f"{inv.get('ila_pct')}")
        check("piezas discrepancia (IRA) = 60", inv.get("abs_discrepancy_pieces") == 60,
              f"{inv.get('abs_discrepancy_pieces')}")
        check("IRA = 66.7% (1 - 60/180)", inv.get("ira_pct") == 66.7, f"{inv.get('ira_pct')}")


try:
    asyncio.run(main())
finally:
    raw.drop_database(SMOKE_DB)
    print(f"\n== Base {SMOKE_DB} eliminada ==")
    print(f"{ok} PASS · {fail} FAIL")
    sys.exit(1 if fail else 0)
