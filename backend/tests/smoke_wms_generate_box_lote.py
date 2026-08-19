"""Smoke de /boxes/generate: la caja de MOVER nace con su lote y su consecutivo.

POR QUE
───────
El modulo MOVER > "Generar caja" crea cajas para material que llega de
produccion sin etiqueta. El backend ya aceptaba country_of_origin y
fabric_content, pero el formulario NUNCA los mandaba: cada caja generada nacia
con la firma de lote VACIA. Sin lote no casa con ningun renglon, el reescritor
la trata como lote aparte, y el pais —requisito de etiquetado al exportar—
quedaba en blanco.

_assert_curated_identity ignora los vacios, asi que nada lo impedia ni lo
reportaba. El hueco era mudo.

Este smoke fija el contrato que el formulario usa ahora, sobre el endpoint real:
consecutivo del sistema, lote persistido en los dos campos que lee la firma, y
el renglon de inventario naciendo con ese lote.

SEGURIDAD: base DESECHABLE, se niega contra produccion, se borra al terminar.

USO
───
    set MONGODB_URL=mongodb://localhost:27017
    python backend/tests/smoke_wms_generate_box_lote.py
"""
import asyncio
import os
import re
import sys

BE = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
SMOKE_DB = os.environ.get("SMOKE_DB_NAME", "mos-smoke-genbox")
PROD_DB = os.environ.get("PROD_DB_NAME", "mos-system")
MONGO = os.environ.get("MONGODB_URL") or os.environ.get("MONGO_URL")

if not MONGO:
    sys.exit("Falta MONGODB_URL")
if SMOKE_DB == PROD_DB:
    sys.exit(f"NEGADO: SMOKE_DB_NAME es la base de produccion ('{PROD_DB}').")

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

LOC = "PS20-D14"
SEQ_BASE = 7700


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
              "wms_catalog_options", "users", "user_sessions", "counters",
              "config_options"]:
        sdb[c].delete_many({})
    sdb.wms_locations.insert_one({"name": LOC, "location_id": "loc_" + LOC})
    sdb.counters.insert_one({"_id": "wms_box_seq", "seq": SEQ_BASE})
    # Catalogo curado: el endpoint valida contra el, y el formulario ofrece
    # exactamente estas opciones (allowCreate=false).
    for t, v in [("styles", "18000"), ("colors", "SAND"), ("sizes", "2X"),
                 ("countries", "HONDURAS"), ("countries", "NICARAGUA"),
                 ("fabrics", "100% COTTON"),
                 ("customers", "GOODIE TWO SLEEVES")]:
        sdb.wms_catalog_options.insert_one({"type": t, "value": v, "active": True})
    sdb.users.insert_one({
        "user_id": "u_smoke", "email": "smoke@test.local", "name": "Smoke Tester",
        "password_hash": bcrypt.hash("smoke123"),
        "role": "supersu", "admin_level": 5, "inventory_level": 5, "active": True})


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

        print("\n== Generar caja con su lote (lo que manda el formulario ahora) ==")
        r = await c.post("/api/wms/boxes/generate", json={
            "style": "18000", "color": "SAND", "size": "2X", "units": 72,
            "customer": "GOODIE TWO SLEEVES", "location": LOC,
            "country_of_origin": "HONDURAS", "fabric_content": "100% COTTON"})
        d = r.json() if r.status_code == 200 else {}
        check("responde 200", r.status_code == 200, f"{r.status_code} {r.text[:220]}")
        nuevo = d.get("box_id", "")

        print("\n== 1. Consecutivo del sistema ==")
        check("formato BOX-######", bool(re.fullmatch(r"BOX-\d{6}", nuevo or "")), f"{nuevo!r}")
        check(f"continua el consecutivo ({SEQ_BASE} -> {SEQ_BASE + 1})",
              nuevo == f"BOX-{SEQ_BASE + 1:06d}", f"{nuevo!r}")

        caja = sdb.wms_boxes.find_one({"box_id": nuevo}, {"_id": 0})
        print("\n== 2. El lote queda en la CAJA, en los dos campos ==")
        check("country_of_origin", (caja or {}).get("country_of_origin") == "HONDURAS",
              f"{(caja or {}).get('country_of_origin')}")
        # `coo` es el campo al que CAE la firma cuando country_of_origin esta vacio.
        check("coo (respaldo de la firma)", (caja or {}).get("coo") == "HONDURAS",
              f"{(caja or {}).get('coo')}")
        check("fabric_content", (caja or {}).get("fabric_content") == "100% COTTON",
              f"{(caja or {}).get('fabric_content')}")

        print("\n== 3. El renglon de inventario nace con ese lote ==")
        fila = sdb.wms_inventory.find_one({"location": LOC}, {"_id": 0})
        check("existe el renglon", fila is not None)
        check("renglon con el pais", (fila or {}).get("country_of_origin") == "HONDURAS",
              f"{(fila or {}).get('country_of_origin')}")
        check("renglon con la composicion", (fila or {}).get("fabric_content") == "100% COTTON",
              f"{(fila or {}).get('fabric_content')}")
        check("renglon cuadra con la caja (72u/1c)",
              (fila or {}).get("units_on_hand") == 72 and (fila or {}).get("total_boxes") == 1,
              f"{(fila or {}).get('units_on_hand')}u/{(fila or {}).get('total_boxes')}c")
        check("la caja apunta a ese renglon",
              (caja or {}).get("inventory_id") == (fila or {}).get("inventory_id"),
              f"{(caja or {}).get('inventory_id')}")

        print("\n== 4. Dos lotes del mismo material NO se funden ==")
        r = await c.post("/api/wms/boxes/generate", json={
            "style": "18000", "color": "SAND", "size": "2X", "units": 60,
            "customer": "GOODIE TWO SLEEVES", "location": LOC,
            "country_of_origin": "NICARAGUA", "fabric_content": "100% COTTON"})
        check("segunda caja responde 200", r.status_code == 200, f"{r.status_code} {r.text[:200]}")
        filas = list(sdb.wms_inventory.find({"location": LOC}, {"_id": 0}))
        paises = sorted((f.get("country_of_origin") or "") for f in filas)
        check("quedan DOS renglones, uno por pais", len(filas) == 2, f"{paises}")
        check("HONDURAS y NICARAGUA separados", paises == ["HONDURAS", "NICARAGUA"], f"{paises}")

        print("\n== 5. Un pais fuera del catalogo se rechaza ==")
        r = await c.post("/api/wms/boxes/generate", json={
            "style": "18000", "color": "SAND", "size": "2X", "units": 10,
            "customer": "GOODIE TWO SLEEVES", "location": LOC,
            "country_of_origin": "WASH COLD", "fabric_content": "100% COTTON"})
        check("rechaza 'WASH COLD' en el campo pais (400)", r.status_code == 400,
              f"{r.status_code} {r.text[:160]}")


try:
    asyncio.run(main())
finally:
    raw.drop_database(SMOKE_DB)
    print(f"\n== Base {SMOKE_DB} eliminada ==")
    print(f"{ok} PASS · {fail} FAIL")
    sys.exit(1 if fail else 0)
