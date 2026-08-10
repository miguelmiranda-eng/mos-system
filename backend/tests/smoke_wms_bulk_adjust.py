"""Smoke de flujo — /inventory/bulk-adjust con celdas de VARIOS renglones.

INCIDENTE QUE BLINDA (2026-08-10, 3001-HEATHER CLAY-4X @ RP-GEN)
────────────────────────────────────────────────────────────────
La celda tenía 3 renglones del mismo style/color/size (lotes con país y
composición distintos: 31 BAN 52/48 · 48 PAK 52/48 · 1013 BAN 60/40 = 1092).
El ajuste masivo casaba con find_one SIN país/composición: agarraba un renglón
arbitrario (el de 31) y una resta de -72 marcaba "quedaría negativo (-41)"
con 1092 unidades en la celda. Además, varias filas del archivo sobre la misma
línea se validaban cada una contra la MISMA foto (sin acumular).

Lo que se asegura aquí:
  · resta sin COO en celda multi-renglón: valida contra la SUMA y se reparte
    (chico→grande) entre renglones, rebajando las cajas del lote correcto
  · fila con COO: casa el renglón exacto de ese lote
  · suma (+) en celda multi-renglón sin COO: error pidiendo identidad
  · filas del mismo material en un archivo se ACUMULAN antes de validar
  · dry_run no escribe nada
  · regresión: línea única y creación de línea nueva siguen igual

SEGURIDAD: base DESECHABLE, se niega contra producción, se borra al terminar.

USO
───
    set MONGODB_URL=mongodb://usuario:clave@host:27017/?authSource=admin
    python backend/tests/smoke_wms_bulk_adjust.py
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


def fila(style, color, size, location, qty, **extra):
    d = {"style": style, "color": color, "size": size, "location": location, "on_hand": qty}
    d.update(extra)
    return d


def sembrar():
    print(f"== Sembrando {SMOKE_DB} ==")
    for c in ["wms_inventory", "wms_boxes", "wms_locations", "wms_movements",
              "wms_incidents", "wms_catalog_options", "users", "user_sessions"]:
        sdb[c].delete_many({})
    sdb.wms_locations.insert_one({"name": "RP-GEN", "location_id": "loc_RP-GEN"})
    # El caso real: 3 lotes del mismo material en la celda.
    sdb.wms_inventory.insert_many([
        {"inventory_id": "inv_ban_5248", "sku": "3001-HEATHER CLAY-4X", "style": "3001",
         "color": "HEATHER CLAY", "size": "4X", "location": "RP-GEN", "customer": "LIF",
         "country_of_origin": "BANGLADESH", "fabric_content": "52/48",
         "units_on_hand": 31, "units_allocated": 0, "total_boxes": 2},
        {"inventory_id": "inv_pak_5248", "sku": "3001-HEATHER CLAY-4X", "style": "3001",
         "color": "HEATHER CLAY", "size": "4X", "location": "RP-GEN", "customer": "LIF",
         "country_of_origin": "PAKISTAN", "fabric_content": "52/48",
         "units_on_hand": 48, "units_allocated": 0, "total_boxes": 1},
        {"inventory_id": "inv_ban_6040", "sku": "3001-HEATHER CLAY-4X", "style": "3001",
         "color": "HEATHER CLAY", "size": "4X", "location": "RP-GEN", "customer": "LIF",
         "country_of_origin": "BANGLADESH", "fabric_content": "60/40",
         "units_on_hand": 1013, "units_allocated": 0, "total_boxes": 2},
    ])
    # Cajas SIN inventory_id (como las reales): el lote se distingue por coo/fabric.
    sdb.wms_boxes.insert_many([
        {"box_id": "SMK-A1", "sku": "3001-HEATHER CLAY-4X", "style": "3001", "color": "HEATHER CLAY",
         "size": "4X", "location": "RP-GEN", "units": 8, "qty": 8, "status": "located",
         "country_of_origin": "BANGLADESH", "fabric_content": "52/48"},
        {"box_id": "SMK-A2", "sku": "3001-HEATHER CLAY-4X", "style": "3001", "color": "HEATHER CLAY",
         "size": "4X", "location": "RP-GEN", "units": 23, "qty": 23, "status": "located",
         "country_of_origin": "BANGLADESH", "fabric_content": "52/48"},
        {"box_id": "SMK-B1", "sku": "3001-HEATHER CLAY-4X", "style": "3001", "color": "HEATHER CLAY",
         "size": "4X", "location": "RP-GEN", "units": 48, "qty": 48, "status": "located",
         "country_of_origin": "Pakistan", "fabric_content": "52/48"},
        {"box_id": "SMK-C1", "sku": "3001-HEATHER CLAY-4X", "style": "3001", "color": "HEATHER CLAY",
         "size": "4X", "location": "RP-GEN", "units": 500, "qty": 500, "status": "located",
         "country_of_origin": "BANGLADESH", "fabric_content": "60/40"},
        {"box_id": "SMK-C2", "sku": "3001-HEATHER CLAY-4X", "style": "3001", "color": "HEATHER CLAY",
         "size": "4X", "location": "RP-GEN", "units": 513, "qty": 513, "status": "located",
         "country_of_origin": "BANGLADESH", "fabric_content": "60/40"},
        # Línea única para la regresión.
        {"box_id": "SMK-S1", "sku": "5000-BLACK-L", "style": "5000", "color": "BLACK",
         "size": "L", "location": "RP-GEN", "units": 20, "qty": 20, "status": "located",
         "country_of_origin": "NICARAGUA", "fabric_content": "100% COTTON"},
    ])
    sdb.wms_inventory.insert_one({
        "inventory_id": "inv_single", "sku": "5000-BLACK-L", "style": "5000",
        "color": "BLACK", "size": "L", "location": "RP-GEN", "customer": "LIF",
        "country_of_origin": "NICARAGUA", "fabric_content": "100% COTTON",
        "units_on_hand": 20, "units_allocated": 0, "total_boxes": 1,
    })
    sdb.users.insert_one({
        "user_id": "u_smoke", "email": "smoke@test.local", "name": "Smoke Tester",
        "password_hash": bcrypt.hash("smoke123"),
        "role": "supersu", "admin_level": 5, "inventory_level": 5, "active": True,
    })


def suma_celda():
    return sum(r.get("units_on_hand", 0) for r in
               sdb.wms_inventory.find({"style": "3001", "location": "RP-GEN"}))


def suma_cajas_celda():
    return sum(b.get("units", 0) for b in
               sdb.wms_boxes.find({"style": "3001", "location": "RP-GEN"}))


async def main():
    sembrar()
    from httpx import ASGITransport, AsyncClient
    from server import app

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://smoke") as c:
        r = await c.post("/api/auth/login",
                         json={"email": "smoke@test.local", "password": "smoke123"})
        check("login", r.status_code == 200, f"{r.status_code}")

        BA = "/api/wms/inventory/bulk-adjust"

        print("\n== DRY RUN: celda multi-renglón ==")
        r = await c.post(BA, json={"dry_run": True, "rows": [
            fila("3001", "HEATHER CLAY", "4X", "RP-GEN", -72),                       # suma de lotes
            fila("3001", "HEATHER CLAY", "4X", "RP-GEN", 10),                        # + sin COO -> error
            fila("3001", "HEATHER CLAY", "4X", "RP-GEN", -5, country_of_origin="NICARAGUA"),  # lote inexistente
        ]})
        check("dry_run 200", r.status_code == 200, f"{r.status_code} {r.text[:200]}")
        rows = r.json()["rows"] if r.status_code == 200 else []
        check("resta -72 valida contra la SUMA (1092) y es Ajuste",
              rows and rows[0]["status"] == "adjust" and rows[0]["current"] == 1092
              and rows[0]["new"] == 1020,
              f"{rows and rows[0]}")
        check("la resta se reparte entre renglones (split)",
              rows and len(rows[0].get("split") or []) >= 2, f"{rows and rows[0].get('split')}")
        check("suma (+) sin COO en celda multi-renglón pide identidad",
              rows and rows[1]["status"] == "error" and "Country of Origin" in rows[1]["message"],
              f"{rows and rows[1]}")
        check("COO que no existe en la celda: error claro, no 'no existe la línea'",
              rows and rows[2]["status"] == "error" and "coincide" in rows[2]["message"],
              f"{rows and rows[2]}")
        check("dry_run NO escribió nada", suma_celda() == 1092, f"{suma_celda()}")

        print("\n== DRY RUN: filas del mismo material se ACUMULAN ==")
        r = await c.post(BA, json={"dry_run": True, "rows": [
            fila("3001", "HEATHER CLAY", "4X", "RP-GEN", -1000),
            fila("3001", "HEATHER CLAY", "4X", "RP-GEN", -72),
            fila("3001", "HEATHER CLAY", "4X", "RP-GEN", -30),
        ]})
        rows = r.json()["rows"] if r.status_code == 200 else []
        check("fila 2 ve el remanente de la fila 1 (1092-1000=92 -> 20)",
              rows and rows[1]["status"] == "adjust" and rows[1]["current"] == 92
              and rows[1]["new"] == 20, f"{rows and rows[1]}")
        check("fila 3 truena: 20-30 quedaría negativo",
              rows and rows[2]["status"] == "error" and "negativo" in rows[2]["message"],
              f"{rows and rows[2]}")

        print("\n== APLICAR: -10 con COO=Pakistan (casa el lote exacto) ==")
        r = await c.post(BA, json={"dry_run": False, "reason": "smoke lote PAK", "rows": [
            fila("3001", "HEATHER CLAY", "4X", "RP-GEN", -10, country_of_origin="Pakistan"),
        ]})
        check("apply 200", r.status_code == 200, f"{r.status_code} {r.text[:200]}")
        pak = sdb.wms_inventory.find_one({"inventory_id": "inv_pak_5248"})
        check("solo el renglón PAKISTAN bajó (48->38)",
              pak and pak.get("units_on_hand") == 38, f"{pak and pak.get('units_on_hand')}")
        caja_pak = sdb.wms_boxes.find_one({"box_id": "SMK-B1"})
        check("la caja del lote PAK se rebajó (48->38)",
              caja_pak and caja_pak.get("units") == 38, f"{caja_pak and caja_pak.get('units')}")
        check("los otros renglones intactos (31 y 1013)",
              sdb.wms_inventory.find_one({"inventory_id": "inv_ban_5248"}).get("units_on_hand") == 31
              and sdb.wms_inventory.find_one({"inventory_id": "inv_ban_6040"}).get("units_on_hand") == 1013)

        print("\n== APLICAR: -72 sin COO (reparto chico→grande entre lotes) ==")
        r = await c.post(BA, json={"dry_run": False, "reason": "smoke reparto", "rows": [
            fila("3001", "HEATHER CLAY", "4X", "RP-GEN", -72),
        ]})
        check("apply 200", r.status_code == 200, f"{r.status_code} {r.text[:200]}")
        a = sdb.wms_inventory.find_one({"inventory_id": "inv_ban_5248"})
        b = sdb.wms_inventory.find_one({"inventory_id": "inv_pak_5248"})
        cc = sdb.wms_inventory.find_one({"inventory_id": "inv_ban_6040"})
        # 31 (chico) se vacía, PAK 38 se vacía, y 72-31-38=3 salen del grande.
        check("renglón chico BAN 52/48 quedó en 0", a and a.get("units_on_hand") == 0,
              f"{a and a.get('units_on_hand')}")
        check("renglón PAK quedó en 0", b and b.get("units_on_hand") == 0,
              f"{b and b.get('units_on_hand')}")
        check("renglón grande BAN 60/40 puso el resto (1013-3=1010)",
              cc and cc.get("units_on_hand") == 1010, f"{cc and cc.get('units_on_hand')}")
        check("las cajas del lote chico 52/48 se eliminaron al vaciarse",
              sdb.wms_boxes.count_documents({"box_id": {"$in": ["SMK-A1", "SMK-A2", "SMK-B1"]}}) == 0)
        check("conservación: papel de la celda = físico en cajas (1010)",
              suma_celda() == 1010 and suma_cajas_celda() == 1010,
              f"papel={suma_celda()} cajas={suma_cajas_celda()}")
        movs = list(sdb.wms_movements.find({"type": "inventory_adjustment",
                                            "details.split": True}))
        check("auditoría por renglón tocado en el reparto (3 partes)",
              len(movs) == 3, f"{len(movs)}")

        print("\n== REGRESIÓN: línea única y línea nueva ==")
        r = await c.post(BA, json={"dry_run": False, "reason": "smoke single", "rows": [
            fila("5000", "BLACK", "L", "RP-GEN", -5),
            fila("NEW1", "RED", "M", "RP-GEN", 25, customer="LIF"),
        ]})
        check("apply 200", r.status_code == 200, f"{r.status_code} {r.text[:200]}")
        s = sdb.wms_inventory.find_one({"inventory_id": "inv_single"})
        check("línea única: 20-5=15", s and s.get("units_on_hand") == 15,
              f"{s and s.get('units_on_hand')}")
        check("su caja bajó a 15",
              sdb.wms_boxes.find_one({"box_id": "SMK-S1"}).get("units") == 15)
        nueva = sdb.wms_inventory.find_one({"style": "NEW1", "location": "RP-GEN"})
        check("línea nueva creada con 25", nueva and nueva.get("units_on_hand") == 25,
              f"{nueva and nueva.get('units_on_hand')}")
        check("con su caja de ajuste",
              sdb.wms_boxes.count_documents({"style": "NEW1", "is_adjustment": True}) == 1)

    print(f"\n== {ok} PASS · {fail} FAIL ==")
    raw.drop_database(SMOKE_DB)
    print(f"(base {SMOKE_DB} eliminada)")
    sys.exit(1 if fail else 0)


asyncio.run(main())
