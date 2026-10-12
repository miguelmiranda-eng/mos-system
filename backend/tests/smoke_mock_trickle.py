"""Smoke del goteo de mocks de Printavo (services/mock_trickle.py).

Fija lo que protege el token de Printavo (el mismo del sync de producción):
una consulta por orden y nunca dos veces, de una en una, respetando el candado
de la BD, saltando órdenes ya revisadas / sin invoice / que fallaron hace poco,
y PAUSA ante un rechazo de Printavo. Printavo NO se llama: la consulta se
sustituye por una falsa que registra las llamadas.

SEGURIDAD: base DESECHABLE, se niega contra producción, se borra al terminar.

USO
───
    set MONGODB_URL=mongodb://usuario:clave@host:27017/?authSource=admin
    python backend/tests/smoke_mock_trickle.py
"""
import asyncio
import os
import sys
from datetime import datetime, timedelta, timezone

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
os.environ.pop("DISABLE_SCHEDULERS", None)
sys.path.insert(0, BE)
os.chdir(BE)

import pymongo  # noqa: E402
from fastapi import HTTPException  # noqa: E402

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

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
    sdb.orders.delete_many({})
    hace_1h = (datetime.now(timezone.utc) - timedelta(hours=1)).isoformat()
    sdb.orders.insert_many([
        {"order_id": "o1", "printavo_invoice_id": "inv1"},                          # pendiente
        {"order_id": "o2", "printavo_invoice_id": "inv2", "printavo_mocks_v": 2},   # ya revisada
        {"order_id": "o3"},                                                         # no es de Printavo
        {"order_id": "o4", "printavo_invoice_id": "inv4", "printavo_mocks_fail_at": hace_1h},  # falló hace poco
        {"order_id": "o5", "printavo_invoice_id": "inv5"},                          # Printavo la rechaza
        {"order_id": "o6", "printavo_invoice_id": "inv6"},                          # va después del rechazo
        {"order_id": "o7", "printavo_invoice_id": "inv7",
         "printavo_mocks_claim_at": datetime.now(timezone.utc).isoformat()},        # la tiene otro
        {"order_id": "o8", "printavo_invoice_id": "inv8", "printavo_mocks_v": 1},   # revisada con la v1
    ])


async def esperar(mt, tope=10.0):
    t = 0.0
    while (mt._queue or (mt._task and not mt._task.done())) and t < tope:
        await asyncio.sleep(0.05)
        t += 0.05


async def main():
    import printavo_client
    import routers.orders as orders
    from services import mock_trickle as mt

    printavo_client.is_configured = lambda: True
    mt.INTERVAL_S = 0.05
    mt.PAUSE_ON_BLOCK_S = 0.5
    llamadas = []
    momentos = []

    async def falsa(order_id, user):
        llamadas.append(order_id)
        momentos.append(asyncio.get_running_loop().time())
        if order_id == "o5":
            raise HTTPException(status_code=400, detail="Printavo rechazó la consulta: 403 HTML")
        await orders.db.orders.update_one({"order_id": order_id}, {"$set": {
            "printavo_mocks_at": datetime.now(timezone.utc).isoformat(), "printavo_mocks_v": orders.MOCKS_VERSION}})
        return {"traidas": 1, "en_printavo": 1}

    orders.traer_mocks_de_orden = falsa

    print("== Una consulta por orden, sólo las pendientes ==")
    n = mt.enqueue(["o1", "o2", "o3", "o4", "o1", "o7", "o8"])
    check("encolar no duplica (o1 dos veces = una)", n == 6, n)
    await esperar(mt)
    check("sólo consulta las pendientes (o1 y la v1 o8)", llamadas == ["o1", "o8"], llamadas)
    check("o7 reclamada por otro: no se consulta", "o7" not in llamadas)
    mt.enqueue(["o1", "o8"])
    await esperar(mt)
    check("una orden revisada nunca se vuelve a consultar", llamadas == ["o1", "o8"], llamadas)

    print("\n== Pausa ante un rechazo de Printavo ==")
    llamadas.clear()
    momentos.clear()
    mt.enqueue(["o5", "o6"])
    await asyncio.sleep(0.25)
    check("tras el rechazo, el goteo se pausa", mt._paused_until is not None and llamadas == ["o5"], (llamadas, mt.status()))
    check("la siguiente sigue en fila durante la pausa", "o6" in mt._queue)
    await esperar(mt)
    check("al terminar la pausa sigue con la siguiente", llamadas == ["o5", "o6"], llamadas)
    check("la pausa se respetó (≥ 0.5 s entre o5 y o6)", len(momentos) == 2 and momentos[1] - momentos[0] >= 0.5,
          [round(m - momentos[0], 2) for m in momentos])
    o5 = sdb.orders.find_one({"order_id": "o5"})
    check("la rechazada queda marcada y sin candado", o5.get("printavo_mocks_fail_at") and "printavo_mocks_claim_at" not in o5, o5)
    llamadas.clear()
    mt.enqueue(["o5"])
    await esperar(mt)
    check("la rechazada no se reintenta en 24 h", llamadas == [], llamadas)

    print("\n== De una en una ==")
    sdb.orders.insert_many([{"order_id": f"s{i}", "printavo_invoice_id": f"is{i}"} for i in range(4)])
    mt.INTERVAL_S = 0.2
    llamadas.clear()
    momentos.clear()
    mt.enqueue([f"s{i}" for i in range(4)])
    await esperar(mt)
    gaps = [momentos[i + 1] - momentos[i] for i in range(len(momentos) - 1)]
    check("4 órdenes = 4 consultas", llamadas == [f"s{i}" for i in range(4)], llamadas)
    check("separadas por el intervalo (≥ 0.2 s)", gaps and min(gaps) >= 0.19, [round(g, 2) for g in gaps])

    print("\n== Apagado en pruebas ==")
    os.environ["DISABLE_SCHEDULERS"] = "1"
    sdb.orders.insert_one({"order_id": "o9", "printavo_invoice_id": "inv9"})
    check("con DISABLE_SCHEDULERS=1 no encola nada", mt.enqueue(["o9"]) == 0 and not mt.enabled())
    os.environ.pop("DISABLE_SCHEDULERS", None)
    printavo_client.is_configured = lambda: False
    check("sin credenciales no encola nada", mt.enqueue(["o9"]) == 0)


if __name__ == "__main__":
    print(f"== Sembrando {SMOKE_DB} ==")
    sembrar()
    try:
        asyncio.run(main())
    finally:
        raw.drop_database(SMOKE_DB)
        print(f"\n== Base {SMOKE_DB} eliminada ==")
    print(f"{ok} PASS · {fail} FAIL")
    sys.exit(1 if fail else 0)
