"""Smoke — fase 2: el recibo hereda entrada + línea + número de parte.

Contrato:
  · POST /asn/{id}/match-line decide la línea con lo que se sabe del cartón:
    estilo/color (si la línea los trae), país y composición. Un solo número
    de parte candidato → matched (la primera línea con saldo); varios →
    ambiguous; ninguno → none. Las muestras (MS) nunca son candidatas.
  · POST /receiving contra una entrada del formato único: resuelve la línea
    (o usa asn_line_no explícito), la caja y el recibo guardan asn_line_no +
    part_number, y la línea descuenta exacto. Sin línea → 422 (none/ambiguous).
  · Dos líneas iguales (1200 + 983) se llenan en orden.
  · Una entrada VIEJA (sin formato) sigue como antes: casa por
    part_number == style y nunca bloquea.

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


async def main():
    sembrar()
    from httpx import ASGITransport, AsyncClient
    from server import app
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://smoke") as c:
        r = await c.post("/api/auth/login", json={"email": "u_admin@test.local", "password": "smoke123"})
        check("login", r.status_code == 200)

        # Entrada del formato único: dos líneas iguales (tu packing list), una de
        # otra composición, una con estilo/color explícitos y una muestra.
        r = await c.post("/api/wms/asn", json={"asn_id": "156053-GOD01-A", "customer": "GOODIE TWO SLEEVES", "items": [
            {"description": "CAMISETA HOMBRE MANGA CORTA 100% ALGODON", "garment": "SS", "fabric": "100% ALGODON", "country": "CHN", "qty_expected": 100},
            {"description": "CAMISETA HOMBRE MANGA CORTA 100% ALGODON", "garment": "SS", "fabric": "100% ALGODON", "country": "CHN", "qty_expected": 50},
            {"description": "CAMISETA HOMBRE MANGA CORTA 50% ALGODON 50% POLIESTER", "garment": "SS", "fabric": "50% ALGODON 50% POLIESTER", "country": "CHN", "qty_expected": 40},
            {"description": "CAMISETA HOMBRE MANGA CORTA 100% ALGODON", "garment": "SS", "fabric": "100% ALGODON", "country": "HND", "qty_expected": 30, "style": "5000", "color": "BLACK"},
            {"description": "CAMISETA HOMBRE MANGA CORTA 100% ALGODON", "garment": "SS", "fabric": "100% ALGODON", "country": "CHN", "qty_expected": 2, "sample": True},
        ]})
        check("entrada creada", r.status_code == 200, r.text[:200])
        pns = [it["part_number"] for it in r.json()["items"]]
        check("números de parte", pns == ["GTS-SS100CCN", "GTS-SS100CCN", "GTS-SS50C50PCN", "GTS-SS100CHN", "GTS-SS100CCNMS"], pns)
        M = "/api/wms/asn/156053-GOD01-A/match-line"

        print("\n== 1. match-line ==")
        r = await c.post(M, json={"style": "M1163", "color": "BRACKEN", "country_of_origin": "CHINA", "fabric_content": "100% ALGODON"})
        d = r.json()
        check("China 100C → línea 1 (primera con saldo, no la muestra)", d["status"] == "matched" and d["line"]["line_no"] == 1, d)
        r = await c.post(M, json={"style": "M1163", "color": "BRACKEN", "country_of_origin": "CHINA", "fabric_content": ""})
        d = r.json()
        check("sin composición: dos números de parte posibles → ambiguous", d["status"] == "ambiguous" and len({x["part_number"] for x in d["candidates"]}) == 2, d.get("status"))
        r = await c.post(M, json={"style": "5000", "color": "BLACK", "country_of_origin": "HONDURAS", "fabric_content": "100% ALGODON"})
        check("estilo+color explícitos → línea 4", r.json()["line"]["line_no"] == 4, r.json())
        r = await c.post(M, json={"style": "5000", "color": "WHITE", "country_of_origin": "HONDURAS", "fabric_content": "100% ALGODON"})
        check("mismo estilo, color distinto y país sin otra línea → none", r.json()["status"] == "none", r.json())
        r = await c.post(M, json={"style": "9999", "color": "RED", "country_of_origin": "MEXICO", "fabric_content": "100% ALGODON"})
        check("país que no viene → none", r.json()["status"] == "none", r.json())

        print("\n== 2. Recibo hereda línea y número de parte ==")
        r = await c.post("/api/wms/receiving", json=recibo("M1163", "BRACKEN", "L", 60, "CHINA", "100% ALGODON", "156053-GOD01-A"))
        check("recibe 60 contra línea 1", r.status_code == 200, r.text[:200])
        box = sdb.wms_boxes.find_one({"asn_reference": "156053-GOD01-A"})
        rc = sdb.wms_receiving.find_one({"asn_reference": "156053-GOD01-A"})
        check("caja: asn_line_no=1 y part_number", box and box.get("asn_line_no") == 1 and box.get("part_number") == "GTS-SS100CCN", box and {k: box.get(k) for k in ("asn_line_no", "part_number")})
        check("recibo: asn_line_no=1 y part_number", rc and rc.get("asn_line_no") == 1 and rc.get("part_number") == "GTS-SS100CCN")
        a = sdb.wms_asn.find_one({"asn_id": "156053-GOD01-A"})
        check("línea 1 descontó 60", a["items"][0]["qty_received"] == 60, a["items"][0]["qty_received"])
        r = await c.post("/api/wms/receiving", json=recibo("M1163", "BRACKEN", "L", 40, "CHINA", "100% ALGODON", "156053-GOD01-A"))
        a = sdb.wms_asn.find_one({"asn_id": "156053-GOD01-A"})
        check("otros 40 completan la línea 1 (100/100)", r.status_code == 200 and a["items"][0]["qty_received"] == 100, (r.status_code, a["items"][0]["qty_received"]))
        r = await c.post("/api/wms/receiving", json=recibo("M1163", "BRACKEN", "M", 30, "CHINA", "100% ALGODON", "156053-GOD01-A"))
        a = sdb.wms_asn.find_one({"asn_id": "156053-GOD01-A"})
        check("el siguiente cartón cae en la línea 2 (misma parte)", r.status_code == 200 and a["items"][1]["qty_received"] == 30 and a["items"][0]["qty_received"] == 100, (r.status_code, [i["qty_received"] for i in a["items"]]))
        box2 = sdb.wms_boxes.find_one({"asn_reference": "156053-GOD01-A", "size": "M"})
        check("esa caja lleva línea 2", box2 and box2.get("asn_line_no") == 2, box2 and box2.get("asn_line_no"))

        print("\n== 3. Bloqueos ==")
        r = await c.post("/api/wms/receiving", json=recibo("M1163", "BRACKEN", "L", 10, "MEXICO", "100% ALGODON", "156053-GOD01-A"))
        check("cartón de México: no viene en la entrada → 422", r.status_code == 422 and "no viene en la entrada" in r.text, f"{r.status_code} {r.text[:120]}")
        check("nada se recibió", sdb.wms_boxes.count_documents({"country_of_origin": "MEXICO"}) == 0)
        r = await c.post("/api/wms/receiving", json=recibo("M1163", "BRACKEN", "L", 10, "CHINA", "", "156053-GOD01-A"))
        check("sin composición y dos partes posibles → 422 pide elegir", r.status_code == 422 and "Elige la línea" in r.text, f"{r.status_code} {r.text[:120]}")
        r = await c.post("/api/wms/receiving", json=recibo("M1163", "BRACKEN", "L", 10, "CHINA", "50% ALGODON 50% POLIESTER", "156053-GOD01-A", line_no=3))
        a = sdb.wms_asn.find_one({"asn_id": "156053-GOD01-A"})
        check("con asn_line_no explícito (3) recibe y descuenta esa línea", r.status_code == 200 and a["items"][2]["qty_received"] == 10, (r.status_code, r.text[:100]))
        r = await c.post("/api/wms/receiving", json=recibo("M1163", "BRACKEN", "L", 10, "CHINA", "100% ALGODON", "156053-GOD01-A", line_no=99))
        check("línea inexistente → 422", r.status_code == 422, r.status_code)

        print("\n== 4. Entrada vieja (sin formato) no cambia ==")
        sdb.wms_asn.insert_one({"asn_id": "VIEJA-1", "vendor": "GILDAN", "status": "pending", "items": [
            {"line_no": 1, "part_number": "5000", "qty_expected": 100, "qty_received": 0, "country": "NIC"}]})
        r = await c.post("/api/wms/receiving", json=recibo("5000", "BLACK", "L", 12, "NICARAGUA", "100% ALGODON", "VIEJA-1"))
        a = sdb.wms_asn.find_one({"asn_id": "VIEJA-1"})
        check("casa por part_number == style y descuenta", r.status_code == 200 and a["items"][0]["qty_received"] == 12, (r.status_code, r.text[:100]))
        r = await c.post("/api/wms/receiving", json=recibo("64000", "SAND", "L", 5, "NICARAGUA", "100% ALGODON", "VIEJA-1"))
        check("estilo que no está: sigue permisivo (200 con aviso)", r.status_code == 200, f"{r.status_code} {r.text[:100]}")

    print(f"\n===== {ok} PASS / {fail} FAIL =====")
    raw.drop_database(SMOKE_DB)
    print(f"base {SMOKE_DB} eliminada")
    sys.exit(1 if fail else 0)


if __name__ == "__main__":
    asyncio.run(main())
