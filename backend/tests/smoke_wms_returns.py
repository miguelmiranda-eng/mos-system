"""Smoke del retorno de material de producción (/api/wms/returns/*).

Fija lo que este módulo NO puede equivocarse, que es exactamente donde falló el
flujo viejo (`/boxes/generate` en Mover):

  - país de origen y composición son OBLIGATORIOS. El 78% de las cajas retornadas
    por la puerta vieja entró sin país, contra 1% en la recepción normal, porque
    ahí eran texto libre opcional. Aquí sin ellos no entra.
  - los valores tienen que venir del catálogo curado de Configuración WMS; un
    color inventado se rechaza.
  - la caja nace marcada como retorno, en estado `raw` (material crudo sobrante)
    y NO `finished`, que es como la etiquetaba el endpoint viejo.
  - el inventario sube por la cantidad retornada, con la identidad completa.
  - mientras está en acopio aparece en la lista de pendientes; al mandarla a su
    ubicación con putaway/bulk sale de la lista pero sigue siendo trazable.

SEGURIDAD: base DESECHABLE, se niega contra producción, se borra al terminar.

USO
    set MONGODB_URL=mongodb://usuario:clave@host:27017/?authSource=admin
    backend/venv/Scripts/python.exe backend/tests/smoke_wms_returns.py
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
sys.path.insert(0, BE)
os.chdir(BE)

import pymongo  # noqa: E402
from passlib.hash import bcrypt  # noqa: E402

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

raw = pymongo.MongoClient(MONGO)
sdb = raw[SMOKE_DB]
ok = fail = 0

CLIENTE, STYLE, COLOR, SIZE = "CLIENTE X", "5000B", "NATURAL", "M"
PAIS, COMPO = "HONDURAS", "100% COTTON"
DESTINO = "RP10-A26"


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
    for c in ["users", "user_sessions", "wms_boxes", "wms_inventory", "wms_locations",
              "wms_catalog_options", "wms_returns", "wms_movements", "wms_counters",
              "config_options"]:
        sdb[c].delete_many({})
    sdb.users.insert_one({
        "user_id": "u_sup", "email": "sup@test.local", "name": "Supervisor",
        "password_hash": bcrypt.hash("sup123"),
        "role": "supersu", "admin_level": 5, "inventory_level": 5, "active": True,
    })
    # Catálogo curado de Configuración WMS: la unica fuente valida de los selects.
    sdb.wms_catalog_options.insert_many([
        {"type": "customers", "value": CLIENTE},
        {"type": "styles", "value": STYLE, "customer": CLIENTE},
        {"type": "colors", "value": COLOR},
        {"type": "sizes", "value": SIZE},
        {"type": "countries", "value": PAIS},
        {"type": "fabrics", "value": COMPO},
    ])
    sdb.wms_locations.insert_one({
        "location_id": "loc_dest", "name": DESTINO, "zone": "RP10",
        "type": "rack", "active": True,
    })


async def main():
    sembrar()
    from httpx import ASGITransport, AsyncClient
    from server import app

    base = {"customer": CLIENTE, "style": STYLE, "color": COLOR, "size": SIZE,
            "units": 48, "country_of_origin": PAIS, "fabric_content": COMPO}

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://smoke") as c:
        r = await c.post("/api/auth/login", json={"email": "sup@test.local", "password": "sup123"})
        check("login", r.status_code == 200, f"{r.status_code} {r.text[:120]}")

        print("\n== la identidad completa es obligatoria ==")
        for campo, etiqueta in [("country_of_origin", "país de origen"),
                                ("fabric_content", "composición"),
                                ("style", "estilo"), ("size", "talla")]:
            payload = {**base, campo: ""}
            r = await c.post("/api/wms/returns/receive", json=payload)
            check(f"sin {etiqueta} -> 400", r.status_code == 400, f"{r.status_code} {r.text[:140]}")

        r = await c.post("/api/wms/returns/receive", json={**base, "units": 0})
        check("cantidad 0 -> 400", r.status_code == 400, f"{r.status_code} {r.text[:140]}")

        print("\n== los valores tienen que estar en el catálogo curado ==")
        r = await c.post("/api/wms/returns/receive", json={**base, "color": "VERDE INVENTADO"})
        check("color fuera del catálogo -> 400", r.status_code == 400, f"{r.status_code} {r.text[:160]}")
        r = await c.post("/api/wms/returns/receive", json={**base, "country_of_origin": "NARNIA"})
        check("país fuera del catálogo -> 400", r.status_code == 400, f"{r.status_code} {r.text[:160]}")

        print("\n== retorno válido: genera caja marcada, en acopio ==")
        r = await c.post("/api/wms/returns/receive", json=base)
        check("retorno válido -> 200", r.status_code == 200, f"{r.status_code} {r.text[:200]}")
        box = r.json() if r.status_code == 200 else {}
        box_id = box.get("box_id", "")
        check("devuelve un box_id para imprimir", box_id.startswith("BOX-"), f"box_id={box_id!r}")

        b = sdb.wms_boxes.find_one({"box_id": box_id}) or {}
        check("marcada como retorno", b.get("source") == "production_return" and b.get("is_return") is True,
              f"source={b.get('source')!r} is_return={b.get('is_return')!r}")
        check("estado 'raw', NO 'finished'", b.get("state") == "raw", f"state={b.get('state')!r}")
        check("queda pendiente de ubicar", b.get("status") == "putaway_pending", f"status={b.get('status')!r}")
        check("conserva el país de origen", b.get("country_of_origin") == PAIS, f"{b.get('country_of_origin')!r}")
        check("conserva la composición", b.get("fabric_content") == COMPO, f"{b.get('fabric_content')!r}")
        check("las unidades son las capturadas", int(b.get("units") or 0) == 48, f"units={b.get('units')}")

        inv = sdb.wms_inventory.find_one({"color": COLOR, "size": SIZE}) or {}
        check("el inventario subió 48", int(inv.get("units_on_hand") or 0) == 48,
              f"units_on_hand={inv.get('units_on_hand')}")
        check("el inventario guarda el país de origen", inv.get("country_of_origin") == PAIS,
              f"{inv.get('country_of_origin')!r}")

        check("queda rastro en wms_returns", sdb.wms_returns.count_documents({"box_id": box_id}) == 1)
        check("NO ensucia los recibos de proveedor", sdb.wms_receiving.count_documents({}) == 0,
              f"wms_receiving={sdb.wms_receiving.count_documents({})}")

        print("\n== la lista de acopio ==")
        r = await c.get("/api/wms/returns/pending")
        data = r.json()
        check("lista la caja recién recibida", any(i["box_id"] == box_id for i in data.get("items", [])),
              f"{data}")
        check("suma las unidades en acopio", data.get("total_units") == 48, f"{data.get('total_units')}")

        # Una segunda caja, para mover varias a la vez.
        r2 = await c.post("/api/wms/returns/receive", json={**base, "units": 12})
        box2 = r2.json().get("box_id", "")
        r = await c.get("/api/wms/returns/pending")
        check("se acumulan las cajas", r.json().get("total") == 2, f"{r.json().get('total')}")

        print("\n== mandar las seleccionadas a su ubicación ==")
        r = await c.post("/api/wms/putaway/bulk", json={
            "assignments": [{"box_id": box_id, "location": DESTINO},
                            {"box_id": box2, "location": DESTINO}]})
        check("putaway de las 2 -> 200", r.status_code == 200, f"{r.status_code} {r.text[:200]}")
        b = sdb.wms_boxes.find_one({"box_id": box_id}) or {}
        check("la caja quedó en el destino", b.get("location") == DESTINO, f"{b.get('location')!r}")
        check("y ya no está pendiente", b.get("status") == "stored", f"status={b.get('status')!r}")

        r = await c.get("/api/wms/returns/pending")
        check("el acopio quedó vacío", r.json().get("total") == 0, f"{r.json().get('total')}")
        check("pero la caja sigue siendo trazable como retorno",
              sdb.wms_boxes.count_documents({"source": "production_return"}) == 2)


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
