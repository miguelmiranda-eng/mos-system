"""Smoke del guard de duplicados de pick tickets. Fija el invariante que se
rompió en producción:

    UN TICKET QUE EL TABLERO NO MUESTRA NO PUEDE BLOQUEAR LA CREACIÓN DE OTRO.

Historia: el guard bloqueaba con `status $nin [confirmed, cancelled]` mientras el
tablero ocultaba `picking_status == completed`. Los tickets cerrados con la
convención vieja (status="completed", que se dejó de escribir el 19-jun-2026)
caían justo en medio: invisibles en las tres pestañas pero bloqueando la
creación. Dejó 319 órdenes imposibles de surtir — el equipo no encontraba el
ticket por ningún lado y al crear otro salía "ya existe".

Fija además la granularidad de la llave: una orden trae varios estilos/colores,
así que el duplicado se juzga por (orden + style + color), no por orden sola.

SEGURIDAD: base DESECHABLE, se niega contra producción, se borra al terminar.

USO
    set MONGODB_URL=mongodb://usuario:clave@host:27017/?authSource=admin
    backend/venv/Scripts/python.exe backend/tests/smoke_pick_ticket_visible_o_no_bloquea.py
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

STYLE, COLOR = "5000B", "NATURAL"


def check(nombre, cond, detalle=""):
    global ok, fail
    if cond:
        ok += 1
        print(f"   PASS  {nombre}")
    else:
        fail += 1
        print(f"   FAIL  {nombre}  {detalle}")


def ticket(tid, orden, status, picking_status, style=STYLE, color=COLOR):
    return {
        "ticket_id": tid, "order_number": orden, "customer": "CLIENTE X",
        "style": style, "color": color, "sizes": {"M": 10}, "total_pick_qty": 10,
        "status": status, "picking_status": picking_status,
        "assigned_to": None, "picked_sizes": {}, "created_at": "2026-06-01T10:00:00+00:00",
    }


def sembrar():
    print(f"== Sembrando {SMOKE_DB} ==")
    for c in ["users", "user_sessions", "wms_pick_tickets", "wms_boxes", "wms_inventory",
              "orders", "wms_movements", "wms_dismissed_pretickets", "config_options"]:
        sdb[c].delete_many({})
    sdb.users.insert_one({
        "user_id": "u_sup", "email": "sup@test.local", "name": "Supervisor",
        "password_hash": bcrypt.hash("sup123"),
        "role": "supersu", "admin_level": 5, "inventory_level": 5, "active": True,
    })
    sdb.wms_pick_tickets.insert_many([
        # Cerrado con la convención VIEJA. Invisible en el tablero -> no debe bloquear.
        ticket("tk_legacy", "OC-100", "completed", "completed"),
        # Cerrado con la convención NUEVA. También invisible -> no debe bloquear.
        ticket("tk_confirmado", "OC-200", "confirmed", "completed"),
        # ABIERTO de verdad: visible en el tablero -> sí debe bloquear.
        ticket("tk_abierto", "OC-300", "pending", "unassigned"),
    ])


async def main():
    sembrar()
    from httpx import ASGITransport, AsyncClient
    from server import app
    from wms_constants import TICKET_OPEN_QUERY

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://smoke") as c:
        r = await c.post("/api/auth/login", json={"email": "sup@test.local", "password": "sup123"})
        check("login", r.status_code == 200, f"{r.status_code} {r.text[:120]}")

        def nuevo(orden, style=STYLE, color=COLOR):
            return {"order_number": orden, "customer": "CLIENTE X", "style": style,
                    "color": color, "sizes": {"M": 10}}

        print("\n== un ticket CERRADO no bloquea, en ninguna de las dos convenciones ==")
        r = await c.post("/api/wms/pick-tickets", json=nuevo("OC-100"))
        check("legacy status='completed' NO bloquea", r.status_code == 200,
              f"{r.status_code} {r.text[:200]}")
        r = await c.post("/api/wms/pick-tickets", json=nuevo("OC-200"))
        check("status='confirmed' NO bloquea", r.status_code == 200,
              f"{r.status_code} {r.text[:200]}")

        print("\n== un ticket ABIERTO sí bloquea ==")
        r = await c.post("/api/wms/pick-tickets", json=nuevo("OC-300"))
        check("mismo orden+style+color -> 409", r.status_code == 409,
              f"{r.status_code} {r.text[:200]}")
        check("el 409 dice cuál es el ticket existente",
              "tk_abierto" in r.text, r.text[:200])

        print("\n== la llave es orden+style+color, no la orden sola ==")
        r = await c.post("/api/wms/pick-tickets", json=nuevo("OC-300", style="5000"))
        check("misma orden, OTRO style -> se permite", r.status_code == 200,
              f"{r.status_code} {r.text[:200]}")
        r = await c.post("/api/wms/pick-tickets", json=nuevo("OC-300", color="MAROON"))
        check("misma orden, OTRO color -> se permite", r.status_code == 200,
              f"{r.status_code} {r.text[:200]}")
        r = await c.post("/api/wms/pick-tickets", json=nuevo("OC-300", color="natural"))
        check("el color compara sin importar mayúsculas -> 409", r.status_code == 409,
              f"{r.status_code} {r.text[:200]}")

        print("\n== force_duplicate sigue siendo la salida explícita ==")
        payload = nuevo("OC-300")
        payload["force_duplicate"] = True
        r = await c.post("/api/wms/pick-tickets", json=payload)
        check("force_duplicate -> 200", r.status_code == 200, f"{r.status_code} {r.text[:200]}")

        print("\n== EL INVARIANTE: lo que bloquea es exactamente lo que se lista ==")
        r = await c.get("/api/wms/pick-tickets?exclude_completed=true&paginated=true&limit=1000")
        check("el tablero responde 200", r.status_code == 200, f"{r.status_code}")
        listados = {t["ticket_id"] for t in r.json().get("items", []) if not t.get("is_virtual")}
        bloqueantes = {t["ticket_id"] for t in sdb.wms_pick_tickets.find(dict(TICKET_OPEN_QUERY))}
        check("ningún ticket bloquea sin ser visible en el tablero",
              bloqueantes - listados == set(), f"invisibles pero bloqueantes: {bloqueantes - listados}")
        check("los cerrados no aparecen ni bloquean",
              "tk_legacy" not in listados and "tk_legacy" not in bloqueantes,
              f"listados={listados}")

        print("\n== has_more no se infla con los pre-tickets virtuales ==")
        # 60 órdenes sin ticket -> 60 pre-tickets virtuales en la primera página.
        sdb.orders.insert_many([
            {"order_id": f"o{i}", "order_number": f"V-{i}", "status": "active",
             "client": "CLIENTE X", "created_at": "2026-07-01T10:00:00+00:00"}
            for i in range(60)
        ])
        r = await c.get("/api/wms/pick-tickets?exclude_completed=true&paginated=true&limit=2&skip=0")
        data = r.json()
        reales = [t for t in data.get("items", []) if not t.get("is_virtual")]
        virtuales = [t for t in data.get("items", []) if t.get("is_virtual")]
        check("la primera página trae los virtuales", len(virtuales) > 0, f"{len(virtuales)}")
        check("has_more mide tickets reales, no virtuales",
              data.get("has_more") is True,
              f"has_more={data.get('has_more')} reales={len(reales)} "
              f"virtuales={len(virtuales)} total={data.get('total')}")


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
