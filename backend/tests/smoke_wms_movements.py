"""Smoke test de integración de los endpoints de movimiento del WMS.

Ejercita el cableado HTTP real —FastAPI + rutas + auth + Motor— contra una base
de datos DESECHABLE. Es la contraparte de tests/test_wms_inventory_ledger.py:
aquél cubre las invariantes en memoria, éste cubre que los endpoints realmente
las usen.

No es decorativo: en su primera ejecución (2026-07-22) detectó un KeyError '_id'
que crasheaba /boxes/relocate al agotar una fila reconciliada. Las 25 pruebas
unitarias no podían verlo porque no ejercitan el router.

SEGURIDAD
─────────
Se niega a correr si la base destino es la de producción. Al terminar la
elimina. Nunca apuntes SMOKE_DB_NAME a una base con datos reales.

USO
───
    set MONGODB_URL=mongodb://usuario:clave@host:27017/?authSource=admin
    python backend/tests/smoke_wms_movements.py

Variables: MONGODB_URL (requerida), SMOKE_DB_NAME (por defecto 'mos-smoke-test'),
PROD_DB_NAME (por defecto 'mos-system', se usa sólo para rechazarla).
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

# La app lee su configuración del entorno al importarse: hay que fijarla antes.
os.environ["MONGODB_URL"] = MONGO
os.environ["DB_NAME"] = SMOKE_DB
os.environ.setdefault("JWT_SECRET", "smoke_secret")
os.environ.setdefault("ENV", "local")
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


def total(loc):
    return sum(r.get("units_on_hand", 0) for r in sdb.wms_inventory.find({"location": loc}))


def filas(loc, style):
    return sdb.wms_inventory.count_documents({"location": loc, "style": style})


def sembrar():
    """Escenario del incidente CK001: fila keyed COMPUESTO, cajas con style CORTO."""
    print(f"== Sembrando {SMOKE_DB} ==")
    for c in ["wms_inventory", "wms_boxes", "wms_locations", "wms_movements",
              "wms_incidents", "users", "user_sessions"]:
        sdb[c].delete_many({})
    for name in ["PS07-A25", "NA08-C37", "NA08-C38"]:
        sdb.wms_locations.insert_one({"name": name, "location_id": f"loc_{name}"})
    sdb.wms_inventory.insert_one({
        "inventory_id": "inv_smoke_ck001", "sku": "CK001-PFD-M", "style": "CK001",
        "color": "PFD", "size": "M", "location": "PS07-A25",
        "units_on_hand": 480, "total_boxes": 10, "units_allocated": 0,
        "customer": "SPEKTRUM", "updated_at": "2026-07-01T00:00:00+00:00",
    })
    for i in range(10):
        sdb.wms_boxes.insert_one({
            "box_id": f"SMOKE-{i:03d}", "style": "CK001", "sku": "CK001-PFD-M",
            "color": "PFD", "size": "M", "location": "PS07-A25", "units": 48,
            "inventory_id": "inv_smoke_ck001", "status": "located", "state": "located",
        })
    # Caja huérfana: existe físicamente, ninguna fila la respalda (~3.3% del real).
    sdb.wms_boxes.insert_one({
        "box_id": "SMOKE-ORPHAN", "style": "9999", "sku": "9999-RED-L",
        "color": "RED", "size": "L", "location": "PS07-A25", "units": 24,
        "status": "located", "state": "located",
    })
    sdb.users.insert_one({
        "user_id": "u_smoke", "email": "smoke@test.local", "name": "Smoke Tester",
        "password_hash": bcrypt.hash("smoke123"),
        "role": "supersu", "admin_level": 5, "inventory_level": 5, "active": True,
    })


async def main():
    sembrar()
    # Todo dentro de UN event loop: Motor se ata al primero que ve, y TestClient
    # crea uno por petición ("RuntimeError: Event loop is closed").
    from httpx import ASGITransport, AsyncClient
    from server import app

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://smoke") as c:
        print("\n== Autenticación ==")
        r = await c.post("/api/auth/login",
                         json={"email": "smoke@test.local", "password": "smoke123"})
        check("login", r.status_code == 200, f"{r.status_code} {r.text[:160]}")
        if r.status_code != 200:
            return
        tok = r.json().get("session_token")
        H = {"Authorization": f"Bearer {tok}"} if tok else {}

        print("\n== 1. /boxes/relocate: caja style-corto vs fila sku-compuesto (EL BUG) ==")
        r = await c.post("/api/wms/boxes/relocate",
                         json={"box_ids": [f"SMOKE-{i:03d}" for i in range(4)],
                               "to": "NA08-C37"}, headers=H)
        check("mueve sin error", r.status_code == 200, r.text[:160])
        check("origen DESCONTADO (el bug dejaba 480)", total("PS07-A25") == 288,
              f"origen={total('PS07-A25')} esperado=288")
        check("destino con 192", total("NA08-C37") == 192, f"={total('NA08-C37')}")
        check("conservación: sigue habiendo 480",
              total("PS07-A25") + total("NA08-C37") == 480)
        check("SIN fila duplicada en origen", filas("PS07-A25", "CK001") == 1,
              f"filas={filas('PS07-A25', 'CK001')}")

        print("\n== 2. /move-location: regreso completo, debe FUSIONAR no duplicar ==")
        r = await c.post("/api/wms/move-location",
                         json={"from": "NA08-C37", "to": "PS07-A25"}, headers=H)
        check("regreso sin error", r.status_code == 200, r.text[:160])
        check("UNA sola fila CK001 en PS07-A25", filas("PS07-A25", "CK001") == 1,
              f"filas={filas('PS07-A25', 'CK001')}")
        check("origen vuelve a 480", total("PS07-A25") == 480, f"={total('PS07-A25')}")
        check("NA08-C37 vacía", total("NA08-C37") == 0, f"={total('NA08-C37')}")

        print("\n== 3. Caja huérfana: se reconcilia y queda auditada ==")
        r = await c.post("/api/wms/boxes/relocate",
                         json={"box_ids": ["SMOKE-ORPHAN"], "to": "NA08-C38"}, headers=H)
        check("movimiento permitido", r.status_code == 200, r.text[:160])
        check("destino con las 24 u", total("NA08-C38") == 24, f"={total('NA08-C38')}")
        check("auditado en wms_incidents",
              sdb.wms_incidents.count_documents({"kind": "orphan_boxes_reconciled"}) == 1)
        check("auditado en wms_movements",
              sdb.wms_movements.count_documents({"type": "inventory_row_reconciled"}) == 1)

        print("\n== 4. /move-units: destino con la fila keyed al OTRO formato ==")
        # El destino se busca con la cadena que manda el frontend ('CK001', el
        # style corto). Por eso la fila del destino se siembra keyed COMPUESTO:
        # es el caso que el find_one({"sku": ...}) viejo NO encontraba, creando
        # una SEGUNDA fila. Sembrarla en corto haría esta prueba decorativa.
        sdb.wms_inventory.insert_one({
            "inventory_id": "inv_smoke_comp", "sku": "CK001-PFD-M", "style": "CK001",
            "color": "PFD", "size": "M", "location": "NA08-C37",
            "units_on_hand": 0, "total_boxes": 0, "units_allocated": 0,
        })
        antes_total = total("PS07-A25") + total("NA08-C37")
        r = await c.post("/api/wms/move-units",
                         json={"from": "PS07-A25", "to": "NA08-C37", "sku": "CK001",
                               "color": "PFD", "size": "M", "units": 96}, headers=H)
        check("mueve unidades sin error", r.status_code == 200, r.text[:160])
        check("UNA sola fila en el destino", filas("NA08-C37", "CK001") == 1,
              f"filas={filas('NA08-C37', 'CK001')} (2 = volvio el bug)")
        check("destino con 96", total("NA08-C37") == 96, f"={total('NA08-C37')}")
        check("conservacion en move-units",
              total("PS07-A25") + total("NA08-C37") == antes_total,
              f"antes={antes_total} despues={total('PS07-A25') + total('NA08-C37')}")

        print("\n== 5. /move-units con caja PARTIDA (cantidad no multiplo de 48) ==")
        antes_total = total("PS07-A25") + total("NA08-C38")
        r = await c.post("/api/wms/move-units",
                         json={"from": "PS07-A25", "to": "NA08-C38", "sku": "CK001",
                               "color": "PFD", "size": "M", "units": 20}, headers=H)
        check("parte la caja sin error", r.status_code == 200, r.text[:160])
        check("conservacion con split",
              total("PS07-A25") + total("NA08-C38") == antes_total,
              f"antes={antes_total} despues={total('PS07-A25') + total('NA08-C38')}")
        check("existe la caja hija", sdb.wms_boxes.count_documents(
            {"location": "NA08-C38", "split_from": {"$ne": None}, "units": 20}) == 1)

        print("\n== 6. Dos paises en la misma ubicacion: lotes SEPARADOS ==")
        # Caso real: 18000/SAND/2X @ CARRO 262 = HONDURAS + NICARAGUA. Antes los
        # movimientos los fusionaban, destruyendo trazabilidad aduanera.
        for coo, n, uid in (("HONDURAS", 3, "hn"), ("NICARAGUA", 2, "ni")):
            sdb.wms_inventory.insert_one({
                "inventory_id": f"inv_smoke_{uid}", "sku": "18000-SAND-2X", "style": "18000",
                "color": "SAND", "size": "2X", "location": "PS07-A25",
                "country_of_origin": coo, "fabric_content": "100% COTTON",
                "units_on_hand": 36 * n, "total_boxes": n, "units_allocated": 0,
            })
            for i in range(n):
                sdb.wms_boxes.insert_one({
                    "box_id": f"SMOKE-{uid.upper()}{i}", "style": "18000", "sku": "18000-SAND-2X",
                    "color": "SAND", "size": "2X", "location": "PS07-A25", "units": 36,
                    "country_of_origin": coo, "fabric_content": "100% COTTON",
                    "inventory_id": f"inv_smoke_{uid}", "status": "located", "state": "located",
                })
        r = await c.post("/api/wms/boxes/relocate",
                         json={"box_ids": ["SMOKE-HN0", "SMOKE-HN1"], "to": "NA08-C38"}, headers=H)
        check("mueve solo el lote de Honduras", r.status_code == 200, r.text[:160])
        hn = sdb.wms_inventory.find_one({"location": "PS07-A25", "style": "18000",
                                         "country_of_origin": "HONDURAS"})
        ni = sdb.wms_inventory.find_one({"location": "PS07-A25", "style": "18000",
                                         "country_of_origin": "NICARAGUA"})
        check("Honduras descontado", hn and hn["units_on_hand"] == 36, f"{hn and hn['units_on_hand']}")
        check("Nicaragua INTACTO", ni and ni["units_on_hand"] == 72,
              f"{ni and ni['units_on_hand']} (72 esperado; si bajo, se fusionaron lotes)")
        check("destino hereda el COO correcto",
              (sdb.wms_inventory.find_one({"location": "NA08-C38", "style": "18000"}) or {})
              .get("country_of_origin") == "HONDURAS")
        check("NO se fusionaron las dos filas de origen",
              sdb.wms_inventory.count_documents({"location": "PS07-A25", "style": "18000"}) == 2)

        print("\n== 7. /move-units con FIFO que cruza DOS lotes ==")
        antes = sum(r["units_on_hand"] for r in sdb.wms_inventory.find({"style": "18000"}))
        r = await c.post("/api/wms/move-units",
                         json={"from": "PS07-A25", "to": "NA08-C37", "sku": "18000",
                               "color": "SAND", "size": "2X", "units": 108}, headers=H)
        check("mueve cruzando lotes", r.status_code == 200, r.text[:160])
        despues = sum(r["units_on_hand"] for r in sdb.wms_inventory.find({"style": "18000"}))
        check("conservacion cruzando lotes", antes == despues, f"antes={antes} despues={despues}")
        dst_rows = list(sdb.wms_inventory.find({"location": "NA08-C37", "style": "18000"}))
        check("el destino mantiene un lote por pais", len(dst_rows) == 2,
              f"filas={len(dst_rows)} coos={[x.get('country_of_origin') for x in dst_rows]}")

        print("\n== 8. PICKING: descuenta la fila correcta y no vacia la ubicacion ==")
        # El caso PS06-A01: la fila quedaba en 0 mientras las cajas seguian con
        # material, porque el descuento buscaba la fila con UNA sola forma del sku.
        sdb.wms_inventory.delete_many({"location": "PS09-A32"})
        sdb.wms_boxes.delete_many({"location": "PS09-A32"})
        sdb.wms_locations.update_one({"name": "PS09-A32"}, {"$set": {"name": "PS09-A32"}}, upsert=True)
        sdb.wms_inventory.insert_one({
            "inventory_id": "inv_pick", "sku": "5000-BLACK-L", "style": "5000",
            "color": "BLACK", "size": "L", "location": "PS09-A32",
            "country_of_origin": "NICARAGUA", "fabric_content": "100% COTTON",
            "units_on_hand": 208, "total_boxes": 4, "units_allocated": 0,
        })
        for i, u in enumerate([51, 13, 72, 72]):
            sdb.wms_boxes.insert_one({
                "box_id": f"PICK-{i}", "style": "5000", "sku": "5000-BLACK-L",
                "color": "BLACK", "size": "L", "location": "PS09-A32", "units": u,
                "country_of_origin": "NICARAGUA", "fabric_content": "100% COTTON",
                "inventory_id": "inv_pick", "status": "located", "state": "located",
            })
        r = await c.post("/api/wms/move-units",
                         json={"from": "PS09-A32", "to": "NA08-C37", "sku": "5000",
                               "color": "BLACK", "size": "L", "units": 51}, headers=H)
        check("descuento sin error", r.status_code == 200, r.text[:160])
        fila = sdb.wms_inventory.find_one({"location": "PS09-A32", "style": "5000"})
        cajas = [b for b in sdb.wms_boxes.find({"location": "PS09-A32"}) if (b.get("units") or 0) > 0]
        fisico = sum(int(b["units"]) for b in cajas)
        check("la fila NO se vacia", (fila or {}).get("units_on_hand", 0) > 0,
              f"fila={(fila or {}).get('units_on_hand')} (0 = volvio el bug de PS06-A01)")
        check("fila == cajas restantes", (fila or {}).get("units_on_hand") == fisico,
              f"fila={(fila or {}).get('units_on_hand')} fisico={fisico}")

        print("\n== 9. BLINDAJE: el indice unico frena a los puntos NO migrados ==")
        # Quedan ~47 puntos en wms.py con la llave vieja (conteos ciclicos,
        # ajustes, generar caja...). El indice unico los detiene a TODOS a nivel
        # de base de datos, y el handler traduce el rechazo en un 409 accionable
        # en vez de un 500 con jerga de Mongo.
        sdb.wms_inventory.create_index(
            [("style", 1), ("color", 1), ("size", 1), ("location", 1),
             ("country_of_origin", 1), ("fabric_content", 1)],
            unique=True, name="uniq_inventory_material_lote")
        fila = sdb.wms_inventory.find_one({"location": "PS07-A25", "style": "CK001"})
        check("hay fila para intentar duplicar", fila is not None)
        try:
            copia = {k: v for k, v in fila.items() if k != "_id"}
            copia["inventory_id"] = "inv_intento_duplicado"
            sdb.wms_inventory.insert_one(copia)
            check("la BD RECHAZA el duplicado", False, "se inserto: el indice no funciono")
        except Exception as e:
            check("la BD RECHAZA el duplicado", "E11000" in str(e) or "duplicate" in str(e).lower(),
                  str(e)[:100])
        check("no quedo la fila duplicada",
              sdb.wms_inventory.count_documents({"location": "PS07-A25", "style": "CK001"}) == 1)
        sdb.wms_inventory.drop_index("uniq_inventory_material_lote")

        print("\n== 9. Material duplicado: BLOQUEA con 409 sin escribir nada ==")
        sdb.wms_inventory.insert_one({
            "inventory_id": "inv_smoke_dup", "sku": "CK001", "style": "CK001",
            "color": "PFD", "size": "M", "location": "PS07-A25",
            "units_on_hand": 480, "total_boxes": 10, "units_allocated": 0,
        })
        # Caja elegida dinámicamente: las pruebas anteriores movieron cajas, así
        # que fijar un box_id concreto haría este bloque dependiente del orden.
        cobaya = sdb.wms_boxes.find_one({"location": "PS07-A25", "style": "CK001"})
        check("hay una caja en PS07-A25 para probar", cobaya is not None)
        if not cobaya:
            return
        antes_src, antes_dst = total("PS07-A25"), total("NA08-C37")
        r = await c.post("/api/wms/boxes/relocate",
                         json={"box_ids": [cobaya["box_id"]], "to": "NA08-C37"}, headers=H)
        check("responde 409", r.status_code == 409, f"fue {r.status_code}: {r.text[:120]}")
        check("mensaje accionable", "duplicad" in r.text.lower(), r.text[:120])
        # ALERTA: el bloqueo debe quedar registrado, no morir en la pantalla.
        inc = sdb.wms_incidents.find_one({"kind": "material_duplicado"})
        check("queda INCIDENCIA del bloqueo", inc is not None,
              "el 409 no dejo rastro en wms_incidents")
        if inc:
            check("la incidencia dice el material", "CK001" in str(inc.get("material", "")))
            check("la incidencia dice la ubicacion", inc.get("location") == "PS07-A25")
            check("la incidencia dice el endpoint",
                  "boxes/relocate" in str(inc.get("endpoint") or ""), str(inc.get("endpoint")))
            check("la incidencia dice el usuario", bool(inc.get("user_name")))
        check("CERO cambios: destino intacto", total("NA08-C37") == antes_dst,
              f"{total('NA08-C37')} != {antes_dst}")
        check("CERO cambios: origen intacto", total("PS07-A25") == antes_src)
        check("la caja NO se movió",
              (sdb.wms_boxes.find_one({"box_id": cobaya["box_id"]}) or {}).get("location") == "PS07-A25")


if __name__ == "__main__":
    try:
        asyncio.run(main())
    finally:
        print(f"\n===== {ok} PASS / {fail} FAIL =====")
        raw.drop_database(SMOKE_DB)
        print(f"base {SMOKE_DB} eliminada")
    sys.exit(1 if fail else 0)
