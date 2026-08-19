"""Smoke del módulo de Final Bill: columna Total Amount y edición de la fecha.

Fija dos cosas que se acaban de conectar:

1. TOTAL AMOUNT viene del campo `invoice` de la orden — el total FACTURADO que
   la pasada de Final Bill de Printavo copia sobre la orden que cruza por
   `order_number == visualId`. Antes el módulo devolvía None a ciegas.
   Lo que se fija:
     · una orden con `invoice` numérico devuelve ese número,
     · una orden sin el campo, o con `invoice: null`, devuelve None (la columna
       dice "—") y NO entra a la suma como 0,
     · `invoice: 0` SÍ se devuelve como 0.0: una factura de cero dólares es un
       dato real y distinto de "todavía no se factura",
     · la suma de la tarjeta es de TODO el filtro, no de la página, y viene
       acompañada de cuántas órdenes la componen (`amount_orders`),
     · sin ninguna orden facturada la suma es None, no 0.0,
     · se puede ordenar por la columna.

2. LA FECHA DE FINAL BILL se edita como la columna de calendario del tablero:
   por PUT /api/orders/{id}, y el módulo la relee al recargar. No hay endpoint
   propio a propósito — ese camino ya deja bitácora y hace el broadcast que
   limpia la caché de /api/orders.

SEGURIDAD: base DESECHABLE, se niega contra prod, se borra al terminar.
USO: set MONGODB_URL=... ; backend/venv/Scripts/python.exe backend/tests/smoke_final_bill_monto_y_fecha.py
"""
import asyncio
import os
import sys

BE = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
SMOKE_DB = os.environ.get("SMOKE_DB_NAME", "mos-smoke-final-bill")
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

ENVIO = "LISTO PARA ENVIO"
INVENTARIO = "LISTO PARA INVENTARIO"


def check(n, cond, det=""):
    global ok, fail
    if cond:
        ok += 1
        print(f"   PASS  {n}")
    else:
        fail += 1
        print(f"   FAIL  {n}  {det}")


def fecha(order_id):
    return (sdb.orders.find_one({"order_id": order_id}) or {}).get("final_bill")


def sembrar():
    print(f"== Sembrando {SMOKE_DB} ==")
    for c in ["users", "user_sessions", "orders", "activity_logs"]:
        sdb[c].delete_many({})
    sdb.users.insert_one({
        "user_id": "u_a", "email": "a@test.local", "name": "Admin",
        "password_hash": bcrypt.hash("ad123"), "role": "admin", "active": True,
    })
    # Cuatro maneras distintas en que la base guarda (o no) el total facturado.
    sdb.orders.insert_many([
        {"order_id": "o1", "order_number": "1001", "board": "MASTER",
         "production_status": ENVIO, "cancel_date": "2026-01-01",
         "final_bill": "2026-02-01", "quantity": 100, "invoice": 1500.5},
        {"order_id": "o2", "order_number": "1002", "board": "MASTER",
         "production_status": ENVIO, "cancel_date": "2026-01-02",
         "quantity": 200},                                   # sin campo invoice
        {"order_id": "o3", "order_number": "1003", "board": "MASTER",
         "production_status": ENVIO, "cancel_date": "2026-01-03",
         "quantity": 300, "invoice": None},                  # invoice nulo
        {"order_id": "o4", "order_number": "1004", "board": "MASTER",
         "production_status": ENVIO, "cancel_date": "2026-01-04",
         "quantity": 400, "invoice": 0},                     # facturada en cero
        # En la otra bandeja: no debe contaminar la suma de la primera.
        {"order_id": "o5", "order_number": "1005", "board": "MASTER",
         "production_status": INVENTARIO, "cancel_date": "2026-01-05",
         "quantity": 500, "invoice": 9999.0},
    ])


async def main():
    sembrar()
    from httpx import ASGITransport, AsyncClient
    from server import app

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://smoke") as c:
        r = await c.post("/api/auth/login", json={"email": "a@test.local", "password": "ad123"})
        check("login admin", r.status_code == 200, f"{r.status_code}")

        print("\n== 1. Total Amount sale del campo `invoice` ==")
        r = await c.get("/api/final-bill?tab=envio&page_size=50&sort_by=order_number")
        check("la bandeja responde 200", r.status_code == 200, f"{r.status_code}")
        body = r.json()
        monto = {x["order_number"]: x["total_amount"] for x in body["rows"]}
        check("orden con invoice numérico -> el número", monto.get("1001") == 1500.5, f"{monto}")
        check("orden sin campo invoice -> None", monto.get("1002", "x") is None, f"{monto}")
        check("orden con invoice null -> None", monto.get("1003", "x") is None, f"{monto}")
        check("orden facturada en 0 -> 0.0 (no None)", monto.get("1004") == 0.0, f"{monto}")

        print("\n== 2. la suma de la tarjeta es del filtro, no de la página ==")
        totals = body.get("totals") or {}
        check("suma = 1500.5 (las no facturadas no entran como 0)",
              totals.get("amount") == 1500.5, f"{totals}")
        check("amount_orders = 2 (la de 1500.5 y la de 0)",
              totals.get("amount_orders") == 2, f"{totals}")
        check("la orden de la otra bandeja NO entra en la suma",
              totals.get("amount") != 11499.5, f"{totals}")

        r = await c.get("/api/final-bill?tab=envio&page_size=1&sort_by=order_number")
        chico = r.json()
        check("con page_size=1 la suma no cambia (es del filtro)",
              (chico.get("totals") or {}).get("amount") == 1500.5, f"{chico.get('totals')}")

        r = await c.get("/api/final-bill?tab=envio&client=NO_EXISTE")
        vacio = (r.json().get("totals") or {})
        check("filtro sin órdenes facturadas -> amount None, no 0.0",
              vacio.get("amount") is None and vacio.get("amount_orders") == 0, f"{vacio}")

        print("\n== 3. se puede ordenar por Total Amount ==")
        r = await c.get("/api/final-bill?tab=envio&page_size=50&sort_by=total_amount&sort_dir=desc")
        check("sort_by=total_amount responde 200", r.status_code == 200, f"{r.status_code}")
        primeros = [x["order_number"] for x in r.json()["rows"]]
        check("descendente pone arriba la de 1500.5", primeros[0] == "1001", f"{primeros}")

        print("\n== 4. la fecha de Final Bill se edita por PUT /api/orders ==")
        r = await c.put("/api/orders/o2", json={"final_bill": "2026-03-15"})
        check("PUT con final_bill responde 200", r.status_code == 200, f"{r.status_code}")
        check("Mongo quedó con la fecha nueva", fecha("o2") == "2026-03-15", f"{fecha('o2')}")
        r = await c.get("/api/final-bill?tab=envio&page_size=50&sort_by=order_number")
        fechas = {x["order_number"]: x["final_bill"] for x in r.json()["rows"]}
        check("el módulo la relee", fechas.get("1002") == "2026-03-15", f"{fechas}")

        # Vaciarla debe dejarla vacía, no borrar el renglón ni romper la bandeja.
        r = await c.put("/api/orders/o2", json={"final_bill": ""})
        check("vaciar la fecha responde 200", r.status_code == 200, f"{r.status_code}")
        r = await c.get("/api/final-bill?tab=envio&page_size=50&sort_by=order_number")
        fechas = {x["order_number"]: x["final_bill"] for x in r.json()["rows"]}
        check("queda vacía y la orden sigue en la bandeja",
              fechas.get("1002", "x") == "" and len(fechas) == 4, f"{fechas}")

        # El filtro por fecha debe seguir cuadrando con lo que se guardó.
        await c.put("/api/orders/o3", json={"final_bill": "2026-04-20"})
        r = await c.get("/api/final-bill?tab=envio&final_bill=2026-04-20")
        nums = [x["order_number"] for x in r.json()["rows"]]
        check("el filtro por Final Bill encuentra la fecha recién guardada",
              nums == ["1003"], f"{nums}")

        print("\n== 5. la edición queda en la bitácora (no es un escritor mudo) ==")
        logs = list(sdb.activity_logs.find({"action": "update_order"}))
        check("hay update_order registrados", len(logs) >= 3, f"{len(logs)}")
        campos = [(l.get("details") or {}).get("changed_fields", []) for l in logs]
        check("el log trae el campo final_bill",
              any("final_bill" in cs for cs in campos), f"{campos}")


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
        print("EXCEPCIÓN:\n" + _err)
    print(f"{ok} PASS · {fail} FAIL")
    sys.exit(1 if (fail or _err) else 0)
