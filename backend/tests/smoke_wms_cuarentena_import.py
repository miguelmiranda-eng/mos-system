"""Smoke de la cuarentena del inventario importado por Excel.

QUE ES
──────
El material que entro por el import de Excel no tiene identidad confiable: sus
cajas se INVENTARON a partir de un agregado ("en RP10-A26 hay 5 cajas / 35 u"),
asi que su box_id (LPN<hex>) no esta impreso en ningun carton, sus unidades son
un reparto ficticio y muchas no traen pais ni composicion. Medido el 2026-08-03:
34,557 cajas / 1,600,875 u en 1,680 ubicaciones — el 62% del almacen, y el
origen de casi todos los descuadres que este modulo persigue.

CUARENTENA, NO BLOQUEO. El 10% de los surtidos toca estas cajas: bloquearlas
pararia el almacen. Cuando el piso se topa con una se AVISA y se levanta una
tarea de auditoria con su ubicacion. La cola se prioriza sola — lo que mas se
toca, primero — en vez de obligar a decidir por donde empezar entre 1,680
ubicaciones.

Este smoke fija los dos contratos que importan: que el aviso salga donde el
operador escanea, y que NADA se bloquee.

SEGURIDAD: base DESECHABLE, se niega contra produccion, se borra al terminar.

USO
───
    set MONGODB_URL=mongodb://localhost:27017
    python backend/tests/smoke_wms_cuarentena_import.py
"""
import asyncio
import os
import sys

BE = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
SMOKE_DB = os.environ.get("SMOKE_DB_NAME", "mos-smoke-cuarentena")
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

LOC = "RP10-A26"
DEST = "RP10-B01"
IMPORTADA = "LPN9F3A2C1D"          # caja del import: box_id sintetico
BUENA = "BOX-055501"               # caja nacida en el sistema
SANEADA = "LPN00AA11BB"            # del import pero ya auditada


def check(nombre, cond, detalle=""):
    global ok, fail
    if cond:
        ok += 1
        print(f"   PASS  {nombre}")
    else:
        fail += 1
        print(f"   FAIL  {nombre}  {detalle}")


def caja(bid, units, extra=None):
    d = {"box_id": bid, "barcode": bid, "lpn_id": bid, "style": "3001",
         "sku": "3001-BLACK-M", "color": "BLACK", "size": "M", "location": LOC,
         "units": units, "qty": units, "status": "located",
         "customer": "LIF", "country_of_origin": "BANGLADESH",
         "fabric_content": "100% COTTON"}
    d.update(extra or {})
    return d


def sembrar():
    print(f"== Sembrando {SMOKE_DB} ==")
    for c in ["wms_inventory", "wms_boxes", "wms_locations", "wms_movements",
              "wms_quarantine_locations", "users", "user_sessions", "counters"]:
        sdb[c].delete_many({})
    for n in (LOC, DEST):
        sdb.wms_locations.insert_one({"name": n, "location_id": "loc_" + n})
    sdb.wms_boxes.insert_one(caja(IMPORTADA, 35))
    sdb.wms_boxes.insert_one(caja(BUENA, 60))
    sdb.wms_boxes.insert_one(caja(SANEADA, 20, {"saneada_at": "2026-08-01T10:00:00+00:00"}))
    sdb.wms_inventory.insert_one({
        "inventory_id": "inv_q", "style": "3001", "sku": "3001-BLACK-M",
        "color": "BLACK", "size": "M", "location": LOC,
        "country_of_origin": "BANGLADESH", "fabric_content": "100% COTTON",
        "units_on_hand": 115, "total_boxes": 3, "units_allocated": 0})
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

        print("\n== 1. El aviso sale donde el operador consulta la caja ==")
        r = await c.get(f"/api/wms/boxes/{IMPORTADA}")
        d = r.json() if r.status_code == 200 else {}
        check("caja del import -> inventario_corrupto=True",
              d.get("inventario_corrupto") is True, f"{d.get('inventario_corrupto')}")
        check("trae el aviso para la PDA", bool(d.get("corrupto_aviso")), f"{d.get('corrupto_aviso')}")
        check("pide escanear la ubicacion", d.get("corrupto_pide_ubicacion") is True)

        r = await c.get(f"/api/wms/boxes/{BUENA}")
        d = r.json() if r.status_code == 200 else {}
        check("caja BOX- del sistema -> NO corrupta",
              d.get("inventario_corrupto") is False, f"{d.get('inventario_corrupto')}")

        r = await c.get(f"/api/wms/boxes/{SANEADA}")
        d = r.json() if r.status_code == 200 else {}
        check("caja del import YA auditada -> NO corrupta (saneada_at)",
              d.get("inventario_corrupto") is False, f"{d.get('inventario_corrupto')}")

        print("\n== 2. Tambien en el escaneo de conciliacion ==")
        r = await c.post("/api/wms/recon/resolve-scan",
                         json={"location": LOC, "code": IMPORTADA})
        d = r.json() if r.status_code == 200 else {}
        check("resolve-scan marca la caja del import",
              d.get("matched") is True and d.get("inventario_corrupto") is True, f"{d}")

        print("\n== 3. Reportar levanta la tarea de auditoria de la UBICACION ==")
        r = await c.post("/api/wms/quarantine/report",
                         json={"location": LOC, "box_id": IMPORTADA})
        d = r.json() if r.status_code == 200 else {}
        check("responde 200", r.status_code == 200, f"{r.status_code} {r.text[:200]}")
        # De las 3 cajas de la ubicacion solo UNA sigue en cuarentena: la BOX-
        # nacio en el sistema y la LPN saneada ya se auditó.
        check("cuenta solo la caja del import sin auditar (1 de 3)",
              d.get("cajas_import") == 1, f"{d.get('cajas_import')}")
        check("suma sus unidades (35; la saneada NO cuenta)",
              d.get("unidades_import") == 35, f"{d.get('unidades_import')}")
        check("reporta las 3 cajas totales de la ubicacion",
              d.get("cajas_totales") == 3, f"{d.get('cajas_totales')}")
        check("primer encuentro", d.get("encuentros") == 1, f"{d.get('encuentros')}")

        print("\n== 4. La cola se prioriza por cuanto estorba ==")
        # Otra ubicacion, tocada una sola vez.
        sdb.wms_locations.insert_one({"name": "RP11-C09", "location_id": "loc_x"})
        sdb.wms_boxes.insert_one({**caja("LPNZZZ111", 10), "location": "RP11-C09"})
        await c.post("/api/wms/quarantine/report", json={"location": "RP11-C09"})
        # La primera se vuelve a topar dos veces mas.
        for _ in range(2):
            await c.post("/api/wms/quarantine/report",
                         json={"location": LOC, "box_id": IMPORTADA})
        r = await c.get("/api/wms/quarantine/locations")
        d = r.json() if r.status_code == 200 else {}
        items = d.get("items") or []
        check("las dos ubicaciones estan en la cola", len(items) == 2, f"{len(items)}")
        check("idempotente por ubicacion (3 reportes = 1 fila, 3 encuentros)",
              items and items[0]["location"] == LOC and items[0]["encuentros"] == 3,
              f"{[(i['location'], i['encuentros']) for i in items]}")
        check("la mas tocada va primero",
              items and items[0]["location"] == LOC, f"{[i['location'] for i in items]}")

        print("\n== 5. NADA se bloquea: la caja del import se sigue moviendo ==")
        r = await c.post("/api/wms/boxes/relocate",
                         json={"box_ids": [IMPORTADA], "to": DEST})
        check("relocate de una caja del import responde 200", r.status_code == 200,
              f"{r.status_code} {r.text[:200]}")
        movida = sdb.wms_boxes.find_one({"box_id": IMPORTADA}, {"_id": 0, "location": 1})
        check("la caja SI se movio", (movida or {}).get("location") == DEST, f"{movida}")

        print("\n== 6. Auditada -> sale de la cola ==")
        r = await c.post("/api/wms/quarantine/resolve",
                         json={"location": LOC, "nota": "contada y reetiquetada"})
        check("resolve responde 200", r.status_code == 200, f"{r.status_code} {r.text[:160]}")
        r = await c.get("/api/wms/quarantine/locations")
        pend = [i["location"] for i in (r.json() or {}).get("items", [])]
        check("ya no aparece entre las pendientes", LOC not in pend, f"{pend}")
        r = await c.get("/api/wms/quarantine/locations?status=todos")
        todas = {i["location"]: i.get("status") for i in (r.json() or {}).get("items", [])}
        check("queda registrada como auditada", todas.get(LOC) == "auditada", f"{todas}")


try:
    asyncio.run(main())
finally:
    raw.drop_database(SMOKE_DB)
    print(f"\n== Base {SMOKE_DB} eliminada ==")
    print(f"{ok} PASS · {fail} FAIL")
    sys.exit(1 if fail else 0)
