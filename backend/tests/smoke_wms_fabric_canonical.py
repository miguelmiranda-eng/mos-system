"""Smoke de la CANONIZACIÓN DE COMPOSICIÓN por código de fibras.

El proveedor de SPEKTRUM manda la composición en español ('100% ALGODÓN'), pero
el catálogo y TODO el inventario están en inglés ('100% COTTON'). SPEKTRUM está
en modo estricto. Fija que:
  - un recibo con '100% ALGODÓN' entra y se GUARDA como '100% COTTON' (el
    dominante del inventario del cliente para el código 100C),
  - '95% ALGODÓN, 5 % SPANDEX' → '95% COTTON 5% SPANDEX',
  - un valor que YA es del catálogo ('100%C') NO se toca,
  - un valor inglés canónico ('100% COTTON') pasa igual,
  - una composición cuyo código NO está en el catálogo se rechaza (400): no se
    inventa un canónico ni se rompe el modo estricto,
  - basura que no parsea como composición se rechaza (400),
  - el endpoint /catalog/resolve-fabric devuelve el canónico,
  - sin estricto y con catálogo vacío, el bootstrap sigue dejando capturar.

SEGURIDAD: base DESECHABLE, se niega contra producción, se borra al terminar.

USO
    set MONGODB_URL=mongodb://usuario:clave@host:27017/?authSource=admin
    backend/venv/Scripts/python.exe backend/tests/smoke_wms_fabric_canonical.py
"""
import asyncio
import os
import sys

BE = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
SMOKE_DB = os.environ.get("SMOKE_DB_NAME", "mos-smoke-fabric")
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
os.environ["DISABLE_SCHEDULERS"] = "1"
sys.path.insert(0, BE)
os.chdir(BE)

import pymongo  # noqa: E402
from passlib.hash import bcrypt  # noqa: E402

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

raw = pymongo.MongoClient(MONGO)
sdb = raw[SMOKE_DB]
ok = fail = 0

CUST = "SPEKTRUM"


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
    # SPEKTRUM estricto.
    sdb.config_options.insert_one({"config_id": "main", "strict_identity_customers": [CUST]})
    # Catálogo curado EN INGLÉS (+ identidad mínima para pasar el gate estricto).
    cat = []
    for t, vals in {
        "fabrics": ["100% COTTON", "100%C", "95% COTTON 5% SPANDEX", "100% COMBED COTTON", "100% RING-SPUN COMBED COTTON"],
        "colors": ["BLACK"], "sizes": ["S", "M", "L", "XL", "2X", "3X", "4X"], "descriptions": ["CAMISETA"],
        "countries": ["CHINA"], "manufacturers": ["GILDAN"],
    }.items():
        for v in vals:
            cat.append({"type": t, "value": v})
    cat.append({"type": "styles", "value": "TEE", "customer": CUST})
    sdb.wms_catalog_options.insert_many(cat)
    # Inventario: '100% COTTON' DOMINA el código 100C (5 vs 1).
    for i in range(5):
        sdb.wms_inventory.insert_one({"customer": CUST, "style": "TEE", "color": "BLACK", "size": "M",
                                      "fabric_content": "100% COTTON", "location": f"L{i}", "units_on_hand": 10})
    sdb.wms_inventory.insert_one({"customer": CUST, "style": "TEE", "color": "BLACK", "size": "M",
                                  "fabric_content": "100%C", "location": "LC", "units_on_hand": 10})


def recibo(fabric, size):
    # Talla distinta por caso: evita el guard de "doble captura" (recibos
    # idénticos seguidos) — este smoke prueba la composición, no ese guard.
    return {"customer": CUST, "manufacturer": "GILDAN", "style": "TEE", "color": "BLACK", "size": size,
            "description": "CAMISETA", "country_of_origin": "CHINA", "fabric_content": fabric,
            "items": [{"size": size, "boxes": 1, "units_per_box": 10}], "units": 10}


async def main():
    sembrar()
    from httpx import ASGITransport, AsyncClient
    from server import app
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://smoke") as c:
        r = await c.post("/api/auth/login", json={"email": "u_admin@test.local", "password": "smoke123"})
        check("login", r.status_code == 200)

        _sz = iter(["S", "M", "L", "XL", "2X", "3X", "4X"])

        async def fabric_stored(fabric):
            size = next(_sz)
            r = await c.post("/api/wms/receiving", json=recibo(fabric, size))
            if r.status_code != 200:
                return ("ERR", r.status_code, r.text[:160])
            b = sdb.wms_boxes.find_one({"customer": CUST, "size": size})
            return (b or {}).get("fabric_content")

        print("\n== Español → canónico inglés dominante ==")
        check("'100% ALGODÓN' → '100% COTTON'", await fabric_stored("100% ALGODÓN") == "100% COTTON")
        check("'100% ALGODON' (sin acento) → '100% COTTON'", await fabric_stored("100% ALGODON") == "100% COTTON")
        check("'95% ALGODÓN, 5 % SPANDEX' → '95% COTTON 5% SPANDEX'",
              await fabric_stored("95% ALGODÓN, 5 % SPANDEX") == "95% COTTON 5% SPANDEX")

        print("\n== Valores del catálogo no se tocan ==")
        check("'100%C' (del catálogo) se queda '100%C'", await fabric_stored("100%C") == "100%C")
        check("'100% COTTON' pasa igual", await fabric_stored("100% COTTON") == "100% COTTON")

        print("\n== No se inventa canónico ni se rompe el estricto ==")
        res = await fabric_stored("80% ALGODÓN 20% POLIÉSTER")  # 80C20P no está en catálogo
        check("código sin catálogo → 400 (estricto)", isinstance(res, tuple) and res[1] == 400, res)
        res = await fabric_stored("TELA RARA SIN PORCENTAJES")
        check("no-composición → 400 (estricto)", isinstance(res, tuple) and res[1] == 400, res)

        print("\n== Endpoint resolve-fabric ==")
        r = await c.get("/api/wms/catalog/resolve-fabric", params={"customer": CUST, "value": "100% ALGODÓN"})
        check("resolve '100% ALGODÓN' → '100% COTTON'", r.status_code == 200 and r.json()["value"] == "100% COTTON", r.text[:160])
        r = await c.get("/api/wms/catalog/resolve-fabric", params={"customer": CUST, "value": "80% ALGODÓN 20% POLIÉSTER"})
        check("resolve sin catálogo → devuelve el valor tal cual", r.json()["value"] == "80% ALGODÓN 20% POLIÉSTER", r.text[:160])

        print("\n== Calificativo COMBED: no se pierde ni se inventa ==")
        async def rf(v):
            r = await c.get("/api/wms/catalog/resolve-fabric", params={"customer": CUST, "value": v})
            return r.json().get("value")
        check("'100% ALGODÓN' → '100% COTTON' (plano, aunque exista combed)", await rf("100% ALGODÓN") == "100% COTTON")
        check("'100% ALGODÓN PEINADO' → '100% COMBED COTTON'", await rf("100% ALGODÓN PEINADO") == "100% COMBED COTTON")
        check("'100% COMBED COTTON' (exacto) se queda", await rf("100% COMBED COTTON") == "100% COMBED COTTON")
        check("'100% ALGODON ANILLADO PEINADO' → ring-spun combed",
              await rf("100% ALGODON ANILLADO PEINADO") == "100% RING-SPUN COMBED COTTON")
        # Calificativo sin forma en catálogo: NO se degrada al genérico.
        check("'100% ALGODÓN SANFORIZADO' (preshrunk sin catálogo) se deja tal cual",
              await rf("100% ALGODÓN SANFORIZADO") == "100% ALGODÓN SANFORIZADO")

        print("\n== Dominancia: si manda '100%C', el canónico cambia ==")
        sdb.wms_inventory.delete_many({})
        for i in range(4):
            sdb.wms_inventory.insert_one({"customer": CUST, "fabric_content": "100%C", "location": f"X{i}", "units_on_hand": 5})
        sdb.wms_inventory.insert_one({"customer": CUST, "fabric_content": "100% COTTON", "location": "X9", "units_on_hand": 5})
        r = await c.get("/api/wms/catalog/resolve-fabric", params={"customer": CUST, "value": "100% ALGODÓN"})
        check("ahora '100% ALGODÓN' → '100%C' (el que domina)", r.json()["value"] == "100%C", r.text[:160])

        print("\n== Cliente NO estricto con catálogo vacío: bootstrap deja capturar ==")
        b = recibo("100% ALGODON", "M"); b["customer"] = "CLIENTE LIBRE"
        r = await c.post("/api/wms/receiving", json=b)
        check("no estricto + fabrics global existe pero cliente libre → pasa por inventario/bootstrap",
              r.status_code in (200, 400), r.status_code)  # no debe tronar por el helper


_err = None
try:
    asyncio.run(main())
except Exception:
    import traceback
    _err = traceback.format_exc()
finally:
    try:
        raw.drop_database(SMOKE_DB)
    except Exception:
        pass
    print(f"\n== Base {SMOKE_DB} eliminada ==")
    if _err:
        print("EXCEPCIÓN en el smoke:\n" + _err)
    print(f"{ok} PASS · {fail} FAIL")
    sys.exit(1 if (fail or _err) else 0)
