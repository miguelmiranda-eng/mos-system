"""Smoke test de integración de los endpoints de Stock Fantasma (Conciliación).

Contraparte HTTP de tests/test_wms_phantom_scan.py: aquél fija la clasificación
en memoria, éste verifica que el router realmente la sirva — auth supersu,
escaneo, persistencia del `registro` a través de escaneos, atender y cierre
automático de lo que ya cuadró.

Siembra el escenario real que originó el módulo (2026-07-23): NA03-C20 con el
renglón en 0 y dos cajas de papel (60u + 71u), más un saldo sin cajas y una
caja sin identidad.

SEGURIDAD: igual que smoke_wms_movements.py — base DESECHABLE, se niega a
correr contra producción y borra la base al terminar.

USO
───
    set MONGODB_URL=mongodb://usuario:clave@host:27017/?authSource=admin
    python backend/tests/smoke_wms_phantom.py
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
              "wms_incidents", "wms_recon_phantom", "wms_recon_adjustments",
              "users", "user_sessions"]:
        sdb[c].delete_many({})
    for name in ["NA03-C20", "RP99-Z01"]:
        sdb.wms_locations.insert_one({"name": name, "location_id": f"loc_{name}"})
    # Caso canónico: renglón en 0, dos cajas de papel.
    sdb.wms_inventory.insert_one({
        "inventory_id": "inv_smoke_na03", "sku": "5000-NAVY-L", "style": "5000",
        "color": "NAVY", "size": "L", "location": "NA03-C20",
        "country_of_origin": "HONDURAS", "fabric_content": "100% COTTON",
        "units_on_hand": 0, "total_boxes": 2, "units_allocated": 0,
    })
    for bid, u in [("LPN7079CDEA1DDD", 60), ("LPN756ED59E653C", 71)]:
        sdb.wms_boxes.insert_one({
            "box_id": bid, "style": "5000", "color": "NAVY", "size": "L",
            "location": "NA03-C20", "units": u, "status": "stored",
            "country_of_origin": "HONDURAS", "fabric_content": "100% COTTON",
        })
    # Fantasma clásico: saldo sin ninguna caja.
    sdb.wms_inventory.insert_one({
        "inventory_id": "inv_smoke_fantasma", "sku": "3001-BLACK-M", "style": "3001",
        "color": "BLACK", "size": "M", "location": "RP99-Z01",
        "country_of_origin": "BANGLADESH", "fabric_content": "60% COTTON 40% POLYESTER",
        "units_on_hand": 144, "total_boxes": 0, "units_allocated": 0,
    })
    # Caja sin identidad (placeholder del PDA).
    sdb.wms_boxes.insert_one({
        "box_id": "BOX-SMOKE-01", "style": "(SIN IDENTIFICAR)", "sku": "BOX-SMOKE-01",
        "color": "", "size": "", "location": "RP99-Z01", "units": 72,
        "status": "located",
    })
    sdb.users.insert_one({
        "user_id": "u_smoke", "email": "smoke@test.local", "name": "Smoke Tester",
        "password_hash": bcrypt.hash("smoke123"),
        "role": "supersu", "admin_level": 5, "inventory_level": 5, "active": True,
    })
    sdb.users.insert_one({
        "user_id": "u_admin", "email": "admin@test.local", "name": "Admin Normal",
        "password_hash": bcrypt.hash("admin123"),
        "role": "admin", "admin_level": 3, "inventory_level": 3, "active": True,
    })


async def main():
    sembrar()
    from httpx import ASGITransport, AsyncClient
    from server import app

    # Un cliente POR ROL: la cookie del último login pisa al Bearer.
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://smoke") as su, \
               AsyncClient(transport=ASGITransport(app=app), base_url="http://smoke") as adm:
        print("\n== Autenticación ==")
        r = await su.post("/api/auth/login",
                          json={"email": "smoke@test.local", "password": "smoke123"})
        check("login supersu", r.status_code == 200, f"{r.status_code} {r.text[:160]}")
        r = await adm.post("/api/auth/login",
                           json={"email": "admin@test.local", "password": "admin123"})
        check("login admin", r.status_code == 200, f"{r.status_code} {r.text[:160]}")
        if fail:
            return

        print("\n== Permisos: solo supersu ==")
        r = await adm.post("/api/wms/recon/phantom/scan")
        check("scan como admin -> 403", r.status_code == 403, f"{r.status_code}")
        r = await adm.get("/api/wms/recon/phantom")
        check("lista como admin -> 403", r.status_code == 403, f"{r.status_code}")

        print("\n== Escaneo ==")
        r = await su.post("/api/wms/recon/phantom/scan")
        check("scan 200", r.status_code == 200, f"{r.status_code} {r.text[:200]}")
        d = r.json() if r.status_code == 200 else {}
        check("3 fantasmas detectados", d.get("count") == 3, f"{d}")
        check("3 nuevos", d.get("nuevos") == 3, f"{d}")

        r = await su.get("/api/wms/recon/phantom")
        d = r.json()
        check("lista 3 pendientes", d.get("count") == 3, f"{d.get('count')}")
        tipos = sorted(i["tipo"] for i in d.get("items", []))
        check("tipos correctos",
              tipos == ["cajas_de_papel", "saldo_sin_cajas", "sin_identidad"], f"{tipos}")
        papel = next((i for i in d["items"] if i["tipo"] == "cajas_de_papel"), {})
        check("NA03-C20 con 131u en duda",
              papel.get("location") == "NA03-C20" and papel.get("delta") == 131, f"{papel}")
        pid = papel.get("phantom_id")

        print("\n== Registro (campo de caminata) ==")
        r = await su.post("/api/wms/recon/phantom/registro",
                          json={"phantom_id": pid, "registro": "Piso confirmó vacío 23-jul"})
        check("guardar registro", r.status_code == 200, f"{r.status_code} {r.text[:160]}")
        r = await su.post("/api/wms/recon/phantom/registro",
                          json={"phantom_id": "ph_no_existe", "registro": "x"})
        check("registro inexistente -> 404", r.status_code == 404, f"{r.status_code}")

        # Re-escanear NO debe pisar el registro (upsert por id determinista).
        r = await su.post("/api/wms/recon/phantom/scan")
        d = r.json()
        check("re-scan: 0 nuevos", d.get("nuevos") == 0, f"{d}")
        r = await su.get("/api/wms/recon/phantom")
        papel2 = next((i for i in r.json()["items"] if i["phantom_id"] == pid), {})
        check("registro sobrevive al re-scan",
              papel2.get("registro") == "Piso confirmó vacío 23-jul", f"{papel2.get('registro')}")

        print("\n== Cierre automático al cuadrar ==")
        # El conteo físico procede: cajas de papel a 0 (writeoff) -> ya cuadra.
        sdb.wms_boxes.update_many({"location": "NA03-C20"},
                                  {"$set": {"units": 0, "qty": 0, "status": "depleted"}})
        r = await su.post("/api/wms/recon/phantom/scan")
        d = r.json()
        check("re-scan tras writeoff: 1 resuelto solo", d.get("resueltos") == 1, f"{d}")
        r = await su.get("/api/wms/recon/phantom")
        check("quedan 2 pendientes", r.json()["count"] == 2, f"{r.json()['count']}")
        r = await su.get("/api/wms/recon/phantom", params={"status": "resuelta"})
        res = r.json()["items"]
        check("el resuelto conserva su registro",
              len(res) == 1 and res[0].get("registro") == "Piso confirmó vacío 23-jul",
              f"{[(i.get('status'), i.get('registro')) for i in res]}")

        print("\n== Atender ==")
        r = await su.get("/api/wms/recon/phantom")
        fantasma = next((i for i in r.json()["items"] if i["tipo"] == "saldo_sin_cajas"), {})
        r = await su.post("/api/wms/recon/phantom/atender",
                          json={"phantom_id": fantasma.get("phantom_id"),
                                "registro": "Conteo hecho, baja registrada"})
        check("atender 200", r.status_code == 200, f"{r.status_code} {r.text[:160]}")
        r = await su.get("/api/wms/recon/phantom")
        check("queda 1 pendiente", r.json()["count"] == 1, f"{r.json()['count']}")

        print("\n== Rastro ==")
        check("ajustes registrados (3 escaneos)",
              sdb.wms_recon_adjustments.count_documents({"type": "phantom_scan"}) == 3)
        check("incidencia informativa por escaneo",
              sdb.wms_incidents.count_documents({"kind": "phantom_scan"}) == 3)


try:
    asyncio.run(main())
finally:
    raw.drop_database(SMOKE_DB)
    print(f"\n== Base {SMOKE_DB} eliminada ==")
    print(f"{ok} PASS · {fail} FAIL")
    sys.exit(1 if fail else 0)
