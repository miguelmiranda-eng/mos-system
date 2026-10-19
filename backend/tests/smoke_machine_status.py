"""Smoke — estado de máquinas en vivo (routers/machine_status.py).

Contrato:
  · GET /api/machine-status: una fila por tablero MAQUINA<n> (orden numérico),
    con estado actual, órdenes del tablero y recap por estado.
  · PUT /{machine}: solo admin nivel 3+; valida máquina, estado activo y orden.
    Cierra el evento anterior con su duración; mismo estado+orden+nota = sin cambio.
  · PUT /states: agrega estados; los base no se borran; uno en uso tampoco.
  · GET /history: minutos por estado en el día de planta.

    set MONGODB_URL=mongodb://localhost:27017
    python backend/tests/smoke_machine_status.py
"""
import asyncio
import os
import sys

BE = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
SMOKE_DB = os.environ.get("SMOKE_DB_NAME", "mos-smoke-machine-status")
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
    for uid, role, lvl in (("u_l3", "admin", 3), ("u_l2", "admin", 2)):
        sdb.users.insert_one({"user_id": uid, "email": f"{uid}@test.local", "name": uid,
                              "password_hash": bcrypt.hash("smoke123"), "role": role,
                              "admin_level": lvl, "active": True})
    sdb.board_config.insert_one({"config_id": "boards",
                                 "boards": ["SCHEDULING", "MAQUINA10", "MAQUINA2", "BLANKS"]})
    sdb.orders.insert_many([
        {"order_id": "o1", "order_number": "3787", "client": "GOODIE TWO SLEEVES", "board": "MAQUINA2",
         "production_status": "EN PRODUCCION"},
        {"order_id": "o2", "order_number": "3317", "client": "SPEKTRUM", "board": "MAQUINA2",
         "production_status": "LISTO PARA ENVIO"},
    ])


async def login(c, uid):
    r = await c.post("/api/auth/login", json={"email": f"{uid}@test.local", "password": "smoke123"})
    return {"Authorization": f"Bearer {r.json().get('session_token')}"}


async def main():
    sembrar()
    from httpx import ASGITransport, AsyncClient
    from server import app
    tr = ASGITransport(app=app)
    async with AsyncClient(transport=tr, base_url="http://t") as a3, \
            AsyncClient(transport=tr, base_url="http://t") as a2:
        H3, H2 = await login(a3, "u_l3"), await login(a2, "u_l2")

        print("== Lista")
        r = await a3.get("/api/machine-status", headers=H3)
        d = r.json()
        check("200", r.status_code == 200, r.text[:200])
        check("solo tableros MAQUINA, en orden numérico", [m["machine"] for m in d["machines"]] == ["MAQUINA2", "MAQUINA10"],
              [m["machine"] for m in d["machines"]])
        check("6 estados base", len(d["states"]) == 6)
        check("admin 3 puede editar", d["can_edit"] is True)
        m2 = d["machines"][0]
        check("órdenes del tablero, las listas al final", [o["order_number"] for o in m2["board_orders"]] == ["3787", "3317"],
              m2["board_orders"])
        check("sin estado al inicio (recap _none=2)", d["recap"].get("_none") == 2, d["recap"])
        r = await a2.get("/api/machine-status", headers=H2)
        check("admin 2 ve pero no edita", r.status_code == 200 and r.json()["can_edit"] is False)

        print("== Cambiar estado")
        r = await a2.put("/api/machine-status/MAQUINA2", json={"state": "setup"}, headers=H2)
        check("admin 2 no puede cambiar = 403", r.status_code == 403, r.status_code)
        r = await a3.put("/api/machine-status/MAQUINA99", json={"state": "setup"}, headers=H3)
        check("máquina inexistente = 404", r.status_code == 404, r.status_code)
        r = await a3.put("/api/machine-status/MAQUINA2", json={"state": "volando"}, headers=H3)
        check("estado inválido = 400", r.status_code == 400, r.status_code)
        r = await a3.put("/api/machine-status/MAQUINA2", json={"state": "setup", "order_number": "0000"}, headers=H3)
        check("orden inexistente = 404", r.status_code == 404, r.status_code)
        r = await a3.put("/api/machine-status/maquina2", json={"state": "setup", "order_number": "3787"}, headers=H3)
        check("setup con orden (minúsculas ok)", r.status_code == 200 and r.json().get("client") == "GOODIE TWO SLEEVES", r.text[:200])
        r = await a3.put("/api/machine-status/MAQUINA2", json={"state": "setup", "order_number": "3787"}, headers=H3)
        check("mismo estado = sin cambio", r.json().get("unchanged") is True)
        check("un solo evento", sdb.machine_state_events.count_documents({"machine": "MAQUINA2"}) == 1)
        # Simula 25 min en setup: retrocede el inicio del evento abierto.
        from datetime import datetime, timedelta, timezone
        back = (datetime.now(timezone.utc) - timedelta(minutes=25)).isoformat()
        sdb.machine_states.update_one({"machine": "MAQUINA2"}, {"$set": {"since": back}})
        sdb.machine_state_events.update_one({"machine": "MAQUINA2", "ended_at": None}, {"$set": {"started_at": back}})
        r = await a3.put("/api/machine-status/MAQUINA2",
                         json={"state": "aprobacion", "order_number": "3787", "note": "con el cliente"}, headers=H3)
        check("pasa a aprobación", r.status_code == 200)
        ev = sdb.machine_state_events.find_one({"machine": "MAQUINA2", "state": "setup"})
        check("cierra setup con ~25 min", ev and ev.get("ended_at") and 24.5 <= (ev.get("minutes") or 0) <= 26, ev and ev.get("minutes"))
        d = (await a3.get("/api/machine-status", headers=H3)).json()
        m2 = d["machines"][0]
        check("estado actual + nota", m2["state"] == "aprobacion" and m2["note"] == "con el cliente", m2)
        check("recap cuenta aprobación 1 y sin estado 1", d["recap"].get("aprobacion") == 1 and d["recap"].get("_none") == 1, d["recap"])

        print("== Historial")
        r = await a3.get("/api/machine-status/history", headers=H3)
        mins = next(x for x in r.json()["machines"] if x["machine"] == "MAQUINA2")["minutes"]
        check("historial suma setup ~25 min", 24.5 <= mins.get("setup", 0) <= 26, mins)
        r = await a3.get("/api/machine-status/history?date=2026-13-01", headers=H3)
        check("fecha mala = 400", r.status_code == 400)

        print("== Catálogo de estados")
        states = d["states"]
        new = states + [{"label": "Sin operador", "color": "#0ea5e9"}]
        r = await a2.put("/api/machine-status/states", json={"states": new}, headers=H2)
        check("admin 2 no edita catálogo = 403", r.status_code == 403)
        r = await a3.put("/api/machine-status/states", json={"states": new}, headers=H3)
        keys = [s["key"] for s in r.json().get("states", [])]
        check("agrega 'Sin operador' con llave", "sin_operador" in keys, keys)
        r = await a3.put("/api/machine-status/MAQUINA10", json={"state": "sin_operador"}, headers=H3)
        check("se puede usar el estado nuevo", r.status_code == 200, r.text[:200])
        r = await a3.put("/api/machine-status/states", json={"states": states}, headers=H3)
        check("no borra estado en uso = 400", r.status_code == 400, r.text[:200])
        no_base = [s for s in new if s.get("key") != "setup"]
        r = await a3.put("/api/machine-status/states", json={"states": no_base}, headers=H3)
        check("no borra estado base = 400", r.status_code == 400)
        off = [dict(s, active=False) if s.get("key") == "libre" else s for s in new]
        r = await a3.put("/api/machine-status/states", json={"states": off}, headers=H3)
        check("desactivar base sí", r.status_code == 200)
        r = await a3.put("/api/machine-status/MAQUINA10", json={"state": "libre"}, headers=H3)
        check("estado desactivado no se puede usar = 400", r.status_code == 400)

    print(f"\n{ok} PASS, {fail} FAIL")
    raw.drop_database(SMOKE_DB)
    sys.exit(1 if fail else 0)


asyncio.run(main())
