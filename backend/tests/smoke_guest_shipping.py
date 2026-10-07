"""Smoke: invitado shipping (rol shipping_guest) — default-deny + su vista.

Contrato:
  - Barrido de TODAS las rutas: el invitado no obtiene NADA que no obtenga un
    visitante SIN sesión (rutas públicas preexistentes), salvo deps.GUEST_SURFACE.
    Fuera de eso responde 403 (o 405/422 de validación, que ocurren antes y no
    exponen datos).
  - GET /api/guest-shipping/lines: TODO el historial, sólo las columnas de la
    fila (sin pl_url, notas internas, bulk, qty embarcada).
  - PUT /api/guest-shipping/lines/{id}: sólo ship_from y carrier; cualquier otro
    campo → 400; también en envíos viejos; queda en la bitácora.
  - Un usuario interno normal no puede usar la vista del invitado (403).

SEGURIDAD: base DESECHABLE, se niega contra producción, se borra al terminar.

    set MONGODB_URL=mongodb://localhost:27017
    python backend/tests/smoke_guest_shipping.py
"""
import asyncio
import os
import re
import sys
from datetime import date, timedelta

BE = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
SMOKE_DB = os.environ.get("SMOKE_DB_NAME", "mos-smoke-guest-shipping")
MONGO = os.environ.get("MONGODB_URL") or os.environ.get("MONGO_URL")
if not MONGO:
    sys.exit("Falta MONGODB_URL")
if SMOKE_DB == os.environ.get("PROD_DB_NAME", "mos-system"):
    sys.exit("NEGADO: base de producción")
os.environ.update({"MONGODB_URL": MONGO, "MONGO_URL": MONGO, "DB_NAME": SMOKE_DB})
for k, v in (("JWT_SECRET", "s"), ("MASTER_API_KEY", "m"), ("INTERNAL_SYNC_TOKEN", "t"),
             ("DISABLE_SCHEDULERS", "1"), ("ENV", "local")):
    os.environ.setdefault(k, v)
sys.path.insert(0, BE)
os.chdir(BE)

import pymongo  # noqa: E402
from passlib.hash import bcrypt  # noqa: E402

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
raw = pymongo.MongoClient(MONGO)
sdb = raw[SMOKE_DB]
ok = fail = 0
HOY = date.today()


def check(name, cond, detail=""):
    global ok, fail
    ok, fail = (ok + 1, fail) if cond else (ok, fail + 1)
    print(f"   {'PASS' if cond else 'FAIL'}  {name}" + ("" if cond else f"  {detail}"))


def sembrar():
    for c in sdb.list_collection_names():
        sdb[c].drop()
    h = bcrypt.hash("p")
    sdb.users.insert_many([
        {"user_id": "u_guest", "email": "proveedor@x.com", "name": "Proveedor", "role": "shipping_guest",
         "password_hash": h, "active": True},
        {"user_id": "u_gen", "email": "gen@x.com", "name": "Interno", "role": "general",
         "password_hash": h, "active": True},
    ])
    sdb.orders.insert_many([
        {"order_id": "o1", "order_number": "3301", "client": "GTS", "branding": "SPENCER", "customer_po": "23237",
         "board": "COMPLETOS", "production_status": "LISTO PARA ENVIO", "notes": "NOTA INTERNA SECRETA",
         "packing_link": "https://docs.google.com/x", "quantity": 100},
        {"order_id": "o2", "order_number": "3302", "client": "GTS", "customer_po": "23237", "board": "COMPLETOS",
         "production_status": "LISTO PARA ENVIO", "quantity": 100},
        {"order_id": "o3", "order_number": "3000", "client": "GTS", "customer_po": "1", "board": "FINAL BILL"},
    ])
    viejo = (HOY - timedelta(days=30)).isoformat()
    hoy = HOY.isoformat()
    sdb.shipping_exports.insert_many([
        {"export_id": "eOld", "date": viejo, "position": 0, "export_no": 10},
        {"export_id": "eNow", "date": hoy, "position": 0, "export_no": 90, "shipping_no": "#2"},
    ])
    sdb.scheduled_shipments.insert_many([
        {"shipment_id": "sOld", "order_number": "3000", "export_id": "eOld", "ship_date": viejo, "position": 0},
        {"shipment_id": "s1", "order_number": "3301", "export_id": "eNow", "ship_date": hoy, "position": 0, "pcs": 100},
        {"shipment_id": "s2", "order_number": "3302", "export_id": "eNow", "ship_date": hoy, "position": 1, "pcs": 100},
    ])


# Login/registro: no dependen de la sesión.
PUBLICAS = re.compile(r"^/api/auth/(google|callback|login|forgot-password|reset-password|session|register)")


async def main():
    sembrar()
    from httpx import ASGITransport, AsyncClient
    from fastapi.routing import APIRoute
    from server import app
    from deps import guest_surface_permitida
    API = "/api/guest-shipping"
    import routers.art as art
    art.IS_PROD = True  # en local art.py usa un usuario de prueba; en prod pide sesión
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://smoke") as g, \
            AsyncClient(transport=ASGITransport(app=app), base_url="http://smoke") as n, \
            AsyncClient(transport=ASGITransport(app=app), base_url="http://smoke") as anon:
        r = await g.post("/api/auth/login", json={"email": "proveedor@x.com", "password": "p"})
        check("el invitado inicia sesión", r.status_code == 200 and r.json()["role"] == "shipping_guest", r.text[:200])
        await n.post("/api/auth/login", json={"email": "gen@x.com", "password": "p"})

        print("\n== Default-deny: barrido de TODAS las rutas ==")
        fugas, revisadas, publicas = [], 0, set()
        for route in app.routes:
            if not isinstance(route, APIRoute):
                continue
            path = re.sub(r"\{[^}]+\}", "x", route.path)
            for m in route.methods - {"HEAD", "OPTIONS"}:
                if guest_surface_permitida(m, path) or PUBLICAS.match(path) or path == "/api/auth/logout":
                    continue
                revisadas += 1
                body = {} if m in ("POST", "PUT", "PATCH") else None
                try:
                    code = (await g.request(m, path, json=body)).status_code
                except Exception as e:  # noqa: BLE001
                    code = f"EXC {type(e).__name__}"
                if code in (403, 405, 422):
                    continue
                # ¿Responde igual a alguien SIN sesión? Entonces es pública
                # (preexistente) y el invitado no gana nada; si no, es una fuga.
                try:
                    code_anon = (await anon.request(m, path, json=body)).status_code
                except Exception as e:  # noqa: BLE001
                    code_anon = f"EXC {type(e).__name__}"
                if code_anon == code:
                    publicas.add(f"{m} {route.path}")
                else:
                    fugas.append(f"{m} {route.path} → invitado {code} / anónimo {code_anon}")
        print(f"   ({revisadas} combinaciones método/ruta revisadas)")
        print(f"   públicas preexistentes (responden igual SIN sesión): {', '.join(sorted(publicas)) or 'ninguna'}")
        check("ninguna ruta interna responde datos al invitado", not fugas, "\n      " + "\n      ".join(fugas[:40]))
        r = await g.get("/api/orders")
        check("ejemplo: /api/orders → 403 con mensaje claro", r.status_code == 403 and "invitado" in r.text, r.text[:200])
        r = await g.put("/api/scheduled-shipments/s1", json={"pcs": 1})
        check("ejemplo: editar el programador normal → 403", r.status_code == 403, r.status_code)
        r = await g.get("/api/auth/me")
        check("/api/auth/me sí responde", r.status_code == 200 and r.json()["role"] == "shipping_guest")

        print("\n== Su vista ==")
        d = (await g.get(f"{API}/lines")).json()
        nums = [x["order_number"] for x in d["lines"]]
        check("todo el historial (incluye el envío de hace 30 días)", nums == ["3000", "3301", "3302"], nums)
        d["lines"] = [l for l in d["lines"] if l["order_number"] != "3000"]
        x = d["lines"][0]
        check("sin enlaces, notas internas, bulk ni qty embarcada",
              not ({"pl_url", "pl_number", "notes", "bulk", "qty_shipped", "qty_ordered"} & set(x)), sorted(x))
        check("trae las columnas de la fila", x["client"] == "GTS" and x["customer_po"] == "23237"
              and x["status_effective"] == "ENVIADO" and x["pcs"] == 100, x)  # 3301 ya tiene packing sembrado
        check("la que no tiene packing muestra el status de MOS",
              d["lines"][1]["status_effective"] == "LISTO PARA ENVIO", d["lines"][1])
        check("export con SHIPPING# y sin datos de más", d["exports"][-1]["shipping_no"] == "#2"
              and "transport_company" not in d["exports"][-1], d["exports"])

        print("\n== Sólo ship_from y carrier ==")
        r = await g.put(f"{API}/lines/s1", json={"ship_from": " ST ANDREWS ", "carrier": "UPS GROUND"})
        check("guarda sus dos campos", r.status_code == 200 and r.json()["ship_from"] == "ST ANDREWS"
              and r.json()["carrier"] == "UPS GROUND", r.text[:200])
        r = await g.put(f"{API}/lines/s1", json={"carrier": "FEDEX", "pcs": 5})
        check("cualquier otro campo → 400 (y no guarda nada)", r.status_code == 400
              and sdb.scheduled_shipments.find_one({"shipment_id": "s1"})["carrier"] == "UPS GROUND", r.status_code)
        r = await g.put(f"{API}/lines/sOld", json={"carrier": "X"})
        check("también edita envíos viejos", r.status_code == 200 and r.json()["carrier"] == "X", r.text[:200])
        r = await g.put(f"{API}/lines/nope", json={"carrier": "X"})
        check("línea inexistente → 404", r.status_code == 404, r.status_code)
        mv = sdb.shipping_movements.find_one({"user_id": "u_guest"})
        check("queda en Movimientos con su nombre", bool(mv) and mv["user_name"] == "Proveedor"
              and "CARRIER" in mv["summary"], mv and mv.get("summary"))

        print("\n== Un interno no usa la vista del invitado ==")
        r = await n.get(f"{API}/lines")
        check("usuario general → 403", r.status_code == 403, r.status_code)
    raw.drop_database(SMOKE_DB)
    print(f"\n{ok} PASS · {fail} FAIL")
    sys.exit(1 if fail else 0)


asyncio.run(main())
