"""Smoke: la caja que nace en el conteo ciclico usa la secuencia del sistema
y trae su lote (pais de origen + composicion).

QUE CAMBIO (2026-08-03)
───────────────────────
En la resolucion de supervisor, cuando una caja escaneada no existe el operador
puede crearla. Antes:

  · el box_id era EL CODIGO ESCANEADO ('A-123'), asi que la caja quedaba fuera
    del consecutivo BOX-###### del almacen: no seguia la secuencia, no se podia
    reimprimir su etiqueta con el formato de la casa y convivia con box_ids de
    formatos arbitrarios.
  · nacia SIN pais de origen y SIN composicion. Esos dos campos son la identidad
    del LOTE (services/inventory_ledger.py): sin ellos la caja firma vacia, no
    casa con ningun renglon y el reescritor la trata como lote aparte. Ademas el
    pais es requisito legal de etiquetado en confeccion importada a EUA — es
    justo el dato que hubo que limpiar de 748 cajas este mismo mes.

Ahora el box_id se reserva de `counters` igual que en recepcion, el codigo
escaneado se conserva como `physical_lpn` (para que volver a escanearlo
encuentre la caja) y el lote viaja en el payload.

SEGURIDAD: base DESECHABLE, se niega contra produccion, se borra al terminar.

USO
───
    set MONGODB_URL=mongodb://localhost:27017
    python backend/tests/smoke_wms_cc_crear_caja.py
"""
import asyncio
import os
import re
import sys

BE = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
SMOKE_DB = os.environ.get("SMOKE_DB_NAME", "mos-smoke-cc-crear")
PROD_DB = os.environ.get("PROD_DB_NAME", "mos-system")
MONGO = os.environ.get("MONGODB_URL") or os.environ.get("MONGO_URL")

if not MONGO:
    sys.exit("Falta MONGODB_URL")
if SMOKE_DB == PROD_DB:
    sys.exit(f"NEGADO: SMOKE_DB_NAME es la base de produccion ('{PROD_DB}').")

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

LOC = "PS12-C40"
ESCANEADO = "A-123"          # etiqueta fisica del carton, ajena al formato BOX-
SEQ_BASE = 4200              # consecutivo ya usado por el almacen


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
              "wms_cycle_counts", "wms_incidents", "users", "user_sessions",
              "counters", "wms_catalog_options"]:
        sdb[c].delete_many({})
    sdb.wms_locations.insert_one({"name": LOC, "location_id": "loc_" + LOC})
    # Consecutivo vivo del almacen: la caja nueva debe CONTINUARLO.
    sdb.counters.insert_one({"_id": "wms_box_seq", "seq": SEQ_BASE})
    sdb.wms_boxes.insert_one({
        "box_id": f"BOX-{SEQ_BASE:06d}", "seq_num": SEQ_BASE, "style": "5000",
        "sku": "5000-BLACK-M", "color": "BLACK", "size": "M", "location": LOC,
        "units": 60, "qty": 60, "status": "located",
        "country_of_origin": "HONDURAS", "coo": "HONDURAS",
        "fabric_content": "100% COTTON"})
    # Ubicacion en revision de supervisor con un codigo desconocido escaneado.
    sdb.wms_cycle_counts.insert_one({
        "count_id": "cc_crear", "name": "smoke crear", "status": "pending",
        "mode": "box_scan", "is_general": False,
        "scan_locations": [{
            "loc_id": "ccl_crear", "location": LOC, "pass": 2,
            "status": "supervisor",
            "expected_boxes": [f"BOX-{SEQ_BASE:06d}"],
            "scanned_boxes": [f"BOX-{SEQ_BASE:06d}", ESCANEADO],
            "unknown_boxes": [ESCANEADO],
            "missing": [], "extra": [ESCANEADO], "history": [],
        }],
        "total_scan_locations": 1,
        "created_at": "2026-08-03T00:00:00+00:00"})
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

        print("\n== Crear la caja desconocida desde la resolucion de supervisor ==")
        r = await c.post("/api/wms/cycle-counts/cc_crear/resolve-supervisor", json={
            "location": LOC,
            "resolutions": [{
                "box_id": ESCANEADO, "action": "create", "units": 48,
                "style": "5000", "color": "WHITE", "size": "L",
                "customer": "GOODIE TWO SLEEVES",
                "country_of_origin": "NICARAGUA",
                "fabric_content": "100% COTTON",
            }]})
        d = r.json() if r.status_code == 200 else {}
        check("resolve-supervisor responde 200", r.status_code == 200, f"{r.status_code} {r.text[:200]}")
        check("reporta 1 creada", d.get("created") == 1, f"{d}")

        item = next((i for i in (d.get("items") or []) if i.get("action") == "create"), {})
        nuevo = item.get("box_id", "")

        print("\n== 1. El numero de caja sigue la secuencia del sistema ==")
        check("la respuesta trae el box_id asignado", bool(nuevo), f"{d.get('items')}")
        check("tiene formato BOX-######", bool(re.fullmatch(r"BOX-\d{6}", nuevo or "")), f"{nuevo!r}")
        check("NO es el codigo escaneado", nuevo != ESCANEADO, f"{nuevo!r}")
        check(f"continua el consecutivo ({SEQ_BASE} -> {SEQ_BASE + 1})",
              nuevo == f"BOX-{SEQ_BASE + 1:06d}", f"{nuevo!r}")
        cont = sdb.counters.find_one({"_id": "wms_box_seq"})
        check("el contador global avanzo", (cont or {}).get("seq") == SEQ_BASE + 1, f"{cont}")

        caja = sdb.wms_boxes.find_one({"box_id": nuevo}, {"_id": 0})
        check("la caja existe con ese box_id", caja is not None, f"{nuevo}")
        check("seq_num guardado", (caja or {}).get("seq_num") == SEQ_BASE + 1, f"{(caja or {}).get('seq_num')}")
        check("barcode == box_id (es la etiqueta a imprimir)",
              (caja or {}).get("barcode") == nuevo, f"{(caja or {}).get('barcode')}")

        print("\n== 2. El lote viaja: pais de origen y composicion ==")
        check("country_of_origin guardado",
              (caja or {}).get("country_of_origin") == "NICARAGUA",
              f"{(caja or {}).get('country_of_origin')}")
        check("coo (alias que usa la firma) tambien",
              (caja or {}).get("coo") == "NICARAGUA", f"{(caja or {}).get('coo')}")
        check("fabric_content guardado",
              (caja or {}).get("fabric_content") == "100% COTTON",
              f"{(caja or {}).get('fabric_content')}")
        check("unidades y ubicacion correctas",
              (caja or {}).get("units") == 48 and (caja or {}).get("location") == LOC,
              f"{(caja or {}).get('units')} @ {(caja or {}).get('location')}")

        print("\n== 3. La etiqueta fisica escaneada no se pierde ==")
        check("el codigo escaneado quedo como physical_lpn",
              (caja or {}).get("physical_lpn") == ESCANEADO,
              f"{(caja or {}).get('physical_lpn')}")
        check("la respuesta informa que codigo se escaneo",
              item.get("codigo_escaneado") == ESCANEADO, f"{item}")
        # Volver a escanear 'A-123' debe encontrar ESTA caja.
        r2 = await c.post("/api/wms/recon/resolve-scan",
                          json={"location": LOC, "code": ESCANEADO})
        d2 = r2.json() if r2.status_code == 200 else {}
        check("re-escanear el codigo fisico encuentra la caja nueva",
              d2.get("matched") is True and d2.get("box_id") == nuevo, f"{d2}")

        print("\n== 4. El renglon de inventario nace con SU lote ==")
        filas = list(sdb.wms_inventory.find({"location": LOC, "size": "L"}, {"_id": 0}))
        check("se creo un renglon para el material nuevo", len(filas) == 1, f"{filas}")
        f0 = filas[0] if filas else {}
        check("el renglon lleva el pais de la caja",
              f0.get("country_of_origin") == "NICARAGUA", f"{f0.get('country_of_origin')}")
        check("el renglon cuadra con la caja (48u/1c)",
              f0.get("units_on_hand") == 48 and f0.get("total_boxes") == 1,
              f"{f0.get('units_on_hand')}u/{f0.get('total_boxes')}c")
        check("no se toco el lote HONDURAS que ya estaba",
              sdb.wms_boxes.find_one({"box_id": f"BOX-{SEQ_BASE:06d}"}).get("country_of_origin") == "HONDURAS")

        mv = sdb.wms_movements.find_one({"type": "cycle_count_manual_create"}, {"_id": 0})
        check("el movimiento registra el lote y el codigo escaneado",
              (mv or {}).get("details", {}).get("country_of_origin") == "NICARAGUA"
              and (mv or {}).get("details", {}).get("codigo_escaneado") == ESCANEADO,
              f"{(mv or {}).get('details')}")


try:
    asyncio.run(main())
finally:
    raw.drop_database(SMOKE_DB)
    print(f"\n== Base {SMOKE_DB} eliminada ==")
    print(f"{ok} PASS · {fail} FAIL")
    sys.exit(1 if fail else 0)
