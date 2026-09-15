"""Smoke — cabos de fase 2/3: borrar un recibo revierte la LÍNEA y editar la
entrada no renumera las líneas.

Contrato:
  · DELETE /receiving/{id} de un recibo con asn_line_no revierte esa línea
    exacta (el sku del recibo es el estilo, no el número de parte) y recalcula
    el estado de la entrada; nunca deja la línea en negativo.
  · Recibos viejos (sin asn_line_no) siguen revirtiendo por part_number == sku.
  · PUT /asn/{id}: una línea existente conserva su line_no aunque se borre
    otra anterior; las nuevas toman max+1; qty_received se preserva; las
    cajas siguen atribuidas a la línea correcta en GET /asn/{id}.

Base DESECHABLE.
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


def sembrar():
    raw.drop_database(SMOKE_DB)
    sdb.users.insert_one({"user_id": "u_admin", "email": "u_admin@test.local", "name": "admin",
                          "password_hash": bcrypt.hash("smoke123"), "role": "supersu", "admin_level": 5, "active": True})
    sdb.wms_locations.insert_one({"name": "UBICACION TEMPORAL", "location_id": "loc_tmp", "type": "transit", "active": True})


def recibo(style, color, size, units, country, fabric, asn, line_no=None):
    b = {"customer": "GOODIE TWO SLEEVES", "manufacturer": "GILDAN", "style": style, "color": color, "size": size,
         "description": "MENS SS", "country_of_origin": country, "fabric_content": fabric,
         "items": [{"size": size, "boxes": 1, "units_per_box": units}], "units": units, "asn_reference": asn}
    if line_no is not None:
        b["asn_line_no"] = line_no
    return b


def lines(asn_id):
    a = sdb.wms_asn.find_one({"asn_id": asn_id})
    return [(it["line_no"], it["part_number"], it["qty_received"]) for it in a["items"]], a.get("status")


async def main():
    sembrar()
    from httpx import ASGITransport, AsyncClient
    from server import app
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://smoke") as c:
        r = await c.post("/api/auth/login", json={"email": "u_admin@test.local", "password": "smoke123"})
        check("login", r.status_code == 200)
        ASN = "156053-GOD01-D"
        r = await c.post("/api/wms/asn", json={"asn_id": ASN, "customer": "GOODIE TWO SLEEVES", "items": [
            {"description": "CAMISETA HOMBRE MANGA CORTA 100% ALGODON", "garment": "SS", "fabric": "100% ALGODON", "country": "CHN", "qty_expected": 100},
            {"description": "CAMISETA HOMBRE MANGA CORTA 50% ALGODON 50% POLIESTER", "garment": "SS", "fabric": "50% ALGODON 50% POLIESTER", "country": "CHN", "qty_expected": 40},
            {"description": "CAMISETA MUJER MANGA CORTA 100% ALGODON", "garment": "SS", "gender": "W", "fabric": "100% ALGODON", "country": "CHN", "qty_expected": 30},
        ]})
        check("entrada creada", r.status_code == 200, r.text[:200])

        print("\n== 1. Borrar recibo revierte la línea exacta ==")
        # Hombre y mujer 100C CN son dos partes candidatas (el género no se
        # deduce de la caja) → el operador elige: line_no explícito.
        r = await c.post("/api/wms/receiving", json=recibo("M1163", "BRACKEN", "L", 60, "CHINA", "100% ALGODON", ASN, line_no=1))
        check("recibe 60 contra la línea 1", r.status_code == 200, r.text[:150])
        rid1 = r.json().get("receiving_id")
        r = await c.post("/api/wms/receiving", json=recibo("M1163", "BRACKEN", "M", 10, "CHINA", "50% ALGODON 50% POLIESTER", ASN))
        rid2 = r.json().get("receiving_id")
        ls, st = lines(ASN)
        check("recibidos: línea 1 = 60, línea 2 = 10, parcial", [x[2] for x in ls] == [60, 10, 0] and st == "partial", (ls, st))
        r = await c.delete(f"/api/wms/receiving/{rid1}")
        check("delete recibo 1 → 200", r.status_code == 200, r.text[:150])
        ls, st = lines(ASN)
        check("línea 1 vuelve a 0, línea 2 sigue en 10", [x[2] for x in ls] == [0, 10, 0], ls)
        check("cajas del recibo borradas", sdb.wms_boxes.count_documents({"receiving_id": rid1}) == 0)
        r = await c.delete(f"/api/wms/receiving/{rid2}")
        ls, st = lines(ASN)
        check("sin recibos: todo en 0 y estado pending", [x[2] for x in ls] == [0, 0, 0] and st == "pending", (ls, st))

        print("\n== 2. La reversa nunca deja negativo ==")
        r = await c.post("/api/wms/receiving", json=recibo("M1163", "BRACKEN", "L", 20, "CHINA", "100% ALGODON", ASN, line_no=1))
        rid3 = r.json().get("receiving_id")
        sdb.wms_asn.update_one({"asn_id": ASN, "items.line_no": 1}, {"$set": {"items.$.qty_received": 5}})  # histórico chueco
        await c.delete(f"/api/wms/receiving/{rid3}")
        ls, _ = lines(ASN)
        check("5 - 20 se acota a 0", ls[0][2] == 0, ls)

        print("\n== 3. Recibo viejo (sin asn_line_no) sigue por part_number == sku ==")
        sdb.wms_asn.insert_one({"asn_id": "VIEJA-3", "vendor": "GILDAN", "status": "partial", "items": [
            {"line_no": 1, "part_number": "5000", "qty_expected": 100, "qty_received": 12, "country": "NIC"}]})
        sdb.wms_receiving.insert_one({"receiving_id": "rcv_old1", "asn_reference": "VIEJA-3", "sku": "5000", "style": "5000",
                                      "total_units": 12, "boxes": [{"box_id": "OLD-3", "units": 12}], "customer": "X"})
        sdb.wms_boxes.insert_one({"box_id": "OLD-3", "receiving_id": "rcv_old1", "style": "5000", "sku": "5000", "color": "BLACK", "size": "L",
                                  "units": 12, "status": "putaway_pending", "state": "raw", "location": "UBICACION TEMPORAL"})
        r = await c.delete("/api/wms/receiving/rcv_old1")
        ls, st = lines("VIEJA-3")
        check("revierte por part_number (12 → 0)", r.status_code == 200 and ls[0][2] == 0, (r.status_code, ls))

        print("\n== 4. Editar la entrada conserva line_no ==")
        r = await c.post("/api/wms/receiving", json=recibo("M1163", "BRACKEN", "L", 10, "CHINA", "50% ALGODON 50% POLIESTER", ASN))
        check("recibe 10 contra la línea 2", r.status_code == 200 and sdb.wms_boxes.find_one({"receiving_id": r.json()["receiving_id"]})["asn_line_no"] == 2)
        a = sdb.wms_asn.find_one({"asn_id": ASN}, {"_id": 0})
        items = [it for it in a["items"] if it["line_no"] != 1]  # el líder borra la línea 1
        items.append({"description": "SUDADERA HOMBRE 100% ALGODON", "garment": "CW", "fabric": "100% ALGODON", "country": "CHN", "qty_expected": 15})
        r = await c.put(f"/api/wms/asn/{ASN}", json={"items": items})
        check("PUT ok", r.status_code == 200, r.text[:200])
        ls, _ = lines(ASN)
        check("líneas 2 y 3 conservan su número; la nueva es 4", [x[0] for x in ls] == [2, 3, 4], ls)
        check("qty_received de la línea 2 se preserva (10)", ls[0][2] == 10, ls)
        r = await c.get(f"/api/wms/asn/{ASN}")
        d = r.json()
        bx = d["boxes"][0]
        check("la caja sigue en la línea 2 / GTS-SS50C50PCN", bx["asn_line_no_resolved"] == 2 and bx["part_number_resolved"] == "GTS-SS50C50PCN", (bx["asn_line_no_resolved"], bx["part_number_resolved"]))
        bl = {l["line_no"]: l for l in d["summary"]["by_line"]}
        check("by_line: línea 2 con 1 caja / 10 en stock; línea 3 vacía", bl[2]["boxes"] == 1 and bl[2]["qty_in_stock"] == 10 and bl[3]["boxes"] == 0, {k: (v["boxes"], v["qty_in_stock"]) for k, v in bl.items()})
        # Un line_no que el cliente inventa (no existe) se trata como nueva.
        r = await c.put(f"/api/wms/asn/{ASN}", json={"items": items[:2] + [{**items[2], "line_no": 99}]})
        ls, _ = lines(ASN)
        check("line_no desconocido → toma max+1 (5), no 99", [x[0] for x in ls] == [2, 3, 5], ls)

    print(f"\n===== {ok} PASS / {fail} FAIL =====")
    raw.drop_database(SMOKE_DB)
    print(f"base {SMOKE_DB} eliminada")
    sys.exit(1 if fail else 0)


if __name__ == "__main__":
    asyncio.run(main())
