"""Smoke: BULK PACK en Envíos programados (routers/scheduled_shipments.py:
_attach_bulk). Hermanas = órdenes vivas con el mismo cliente + customer PO.

Contrato:
  - Sólo hay `bulk` si el PO tiene 2+ órdenes vivas (canceladas y papelera no cuentan).
  - COMPLETO = todas las hermanas en el MISMO export de la fila y todas en
    LISTO PARA ENVIO; si no, se dice cuántas están aquí y cuántas listas.
  - Cada hermana trae dónde va (export_no/fecha) o nada si no está programada.
  - Mismo PO de OTRO cliente no es hermana.

SEGURIDAD: base DESECHABLE, se niega contra producción, se borra al terminar.

    set MONGODB_URL=mongodb://localhost:27017
    python backend/tests/smoke_shipping_bulk.py
"""
import asyncio
import os
import sys

BE = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
SMOKE_DB = os.environ.get("SMOKE_DB_NAME", "mos-smoke-shipping-bulk")
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
GTS = "GOODIE TWO SLEEVES"


def check(name, cond, detail=""):
    global ok, fail
    ok, fail = (ok + 1, fail) if cond else (ok, fail + 1)
    print(f"   {'PASS' if cond else 'FAIL'}  {name}" + ("" if cond else f"  {detail}"))


def sembrar():
    for c in ["orders", "users", "user_sessions", "activity_logs", "scheduled_shipments",
              "shipping_exports", "shipping_movements", "config_options"]:
        sdb[c].delete_many({})
    sdb.users.insert_one({"user_id": "u_sup", "email": "sup@x.com", "name": "Sup", "role": "supersu",
                          "admin_level": 5, "password_hash": bcrypt.hash("p"), "active": True})
    o = lambda n, po, ps, client=GTS, board="COMPLETOS": {  # noqa: E731
        "order_id": "o" + n, "order_number": n, "client": client, "customer_po": po, "board": board,
        "production_status": ps, "quantity": 100}
    sdb.orders.insert_many([
        o("3736", "23237", "LISTO PARA ENVIO"), o("3737", "23237", "LISTO PARA ENVIO"),       # completo
        o("3740", "23239", "LISTO PARA ENVIO"), o("3741", "23239", "EN PRODUCCION"),           # 1 no lista
        o("3742", "23239", "LISTO PARA ENVIO"),                                                 # …y no programada
        o("3750", "23300", "LISTO PARA ENVIO"), o("3751", "23300", "LISTO PARA ENVIO"),       # partido en 2 exports
        o("3760", "23400", "LISTO PARA ENVIO"),                                                 # PO de una sola orden
        o("3761", "23400", "CANCELLED"),                                                        # cancelada: no cuenta
        o("3762", "23400", "LISTO PARA ENVIO", board="PAPELERA DE RECICLAJE"),                  # papelera: no cuenta
        o("3770", "23237", "LISTO PARA ENVIO", client="SPEKTRUM"),                              # mismo PO, otro cliente
    ])
    sdb.shipping_exports.insert_many([
        {"export_id": "eA", "date": "2026-10-07", "position": 0, "export_no": 90},
        {"export_id": "eB", "date": "2026-10-08", "position": 0, "export_no": 91},
    ])
    lines = [("3736", "eA"), ("3737", "eA"), ("3740", "eA"), ("3741", "eA"),
             ("3750", "eA"), ("3751", "eB"), ("3760", "eA"), ("3770", "eA")]
    for i, (n, e) in enumerate(lines):
        sdb.scheduled_shipments.insert_one({"shipment_id": f"s{n}", "order_number": n, "export_id": e,
                                            "ship_date": "2026-10-07" if e == "eA" else "2026-10-08", "position": i})


async def main():
    sembrar()
    from httpx import ASGITransport, AsyncClient
    from server import app
    API = "/api/scheduled-shipments"
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://smoke") as c:
        await c.post("/api/auth/login", json={"email": "sup@x.com", "password": "p"})
        L = {l["order_number"]: l for l in (await c.get(f"{API}/week?start=2026-10-05")).json()["lines"]}

        print("== Agrupación ==")
        b = L["3736"].get("bulk") or {}
        check("PO 23237: 2 hermanas, completo (mismo export + listas)",
              b.get("n") == 2 and b.get("in_export") == 2 and b.get("ready") == 2 and b.get("complete") is True, b)
        check("mismo PO de otro cliente no es hermana", "3770" not in [s["order_number"] for s in b.get("sisters", [])]
              and not L["3770"].get("bulk"), L["3770"].get("bulk"))
        check("PO con una sola orden viva (otra cancelada y otra en papelera) → sin bulk", not L["3760"].get("bulk"),
              L["3760"].get("bulk"))

        print("\n== Incompletos ==")
        b = L["3740"]["bulk"]
        check("PO 23239: 3 hermanas, 2 aquí, 2 listas → incompleto",
              b["n"] == 3 and b["in_export"] == 2 and b["ready"] == 2 and b["complete"] is False, b)
        sis = {s["order_number"]: s for s in b["sisters"]}
        check("la no programada viene sin exports", sis["3742"]["exports"] == [], sis["3742"])
        check("trae el production status de cada hermana", sis["3741"]["production_status"] == "EN PRODUCCION")
        b = L["3750"]["bulk"]
        sis = {s["order_number"]: s for s in b["sisters"]}
        check("PO 23300 partido: 1/2 en este export → incompleto aunque estén listas",
              b["in_export"] == 1 and b["ready"] == 2 and b["complete"] is False, b)
        check("dice en qué export va la otra (EXP#91)", sis["3751"]["exports"][0]["export_no"] == 91, sis["3751"])
        check("desde el otro export también se ve partido", L["3751"]["bulk"]["in_export"] == 1)

        print("\n== Se completa ==")
        r = await c.post(f"{API}/lines", json={"export_id": "eA", "order_numbers": "3742"})
        check("al agregar la faltante la respuesta trae su bulk", (r.json()["added"][0].get("bulk") or {}).get("in_export") == 3,
              r.text[:300])
        await c.post(f"{API}/lines/move", json={"shipment_ids": ["s3751"], "export_id": "eA"})
        sdb.orders.update_one({"order_number": "3741"}, {"$set": {"production_status": "LISTO PARA ENVIO"}})
        L = {l["order_number"]: l for l in (await c.get(f"{API}/week?start=2026-10-05")).json()["lines"]}
        check("PO 23239 completo al estar las 3 aquí y listas", L["3740"]["bulk"]["complete"] is True, L["3740"]["bulk"])
        check("PO 23300 completo al mover la hermana", L["3750"]["bulk"]["complete"] is True, L["3750"]["bulk"])

        print("\n== ENVIADO al sembrar el packing (sólo en el programador) ==")
        sdb.orders.update_one({"order_number": "3741"}, {"$set": {"production_status": "EN PRODUCCION"}})
        L = {l["order_number"]: l for l in (await c.get(f"{API}/week?start=2026-10-05")).json()["lines"]}
        check("antes de sembrar: espejo de MOS (EN PRODUCCION) y el bulk no está listo",
              L["3741"]["status_effective"] == "EN PRODUCCION" and L["3740"]["bulk"]["complete"] is False, L["3741"]["status_effective"])
        r = await c.post("/api/orders/seed-packing-link", json={
            "order_numbers": ["3741"], "label": "PLGTS 10-26-0091", "url": "https://docs.google.com/spreadsheets/d/x/edit"})
        check("siembra OK", r.status_code == 200 and r.json()["seeded_count"] == 1, r.text[:200])
        L = {l["order_number"]: l for l in (await c.get(f"{API}/week?start=2026-10-05")).json()["lines"]}
        check("con packing sembrado el programador la muestra ENVIADO", L["3741"]["status_effective"] == "ENVIADO", L["3741"])
        check("…y conserva lo que dice MOS en status_auto", L["3741"]["status_auto"] == "EN PRODUCCION")
        check("la orden en MOS NO cambia de production status",
              sdb.orders.find_one({"order_number": "3741"})["production_status"] == "EN PRODUCCION")
        check("en el bulk la hermana enviada cuenta como lista → completo",
              L["3740"]["bulk"]["ready"] == 3 and L["3740"]["bulk"]["complete"] is True, L["3740"]["bulk"])
        sis = {x["order_number"]: x for x in L["3740"]["bulk"]["sisters"]}
        check("la hermana trae shipped=True", sis["3741"]["shipped"] is True and sis["3740"]["shipped"] is False)
    raw.drop_database(SMOKE_DB)
    print(f"\n{ok} PASS · {fail} FAIL")
    sys.exit(1 if fail else 0)


asyncio.run(main())
