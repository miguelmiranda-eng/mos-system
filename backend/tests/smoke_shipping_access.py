"""Smoke: Envíos programados — lo VEN todos, lo EDITAN sólo los de la lista
(routers/scheduled_shipments.py: require_editor, GET/PUT /access).

Contrato:
  - Sin lista guardada, editan quienes ya tienen movimientos en la bitácora
    (para que el deploy no deje fuera a la supervisora de Envíos).
  - Con lista: sólo ellos + supersu. El nivel de admin NO cuenta (admin 5 fuera
    de la lista = sólo lectura).
  - Las 12 escrituras dan 403 al que no edita; las lecturas y el PACKING siguen.
  - Sólo supersu cambia la lista.

SEGURIDAD: base DESECHABLE, se niega contra producción, se borra al terminar.

    set MONGODB_URL=mongodb://localhost:27017
    python backend/tests/smoke_shipping_access.py
"""
import asyncio
import os
import sys

BE = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
SMOKE_DB = os.environ.get("SMOKE_DB_NAME", "mos-smoke-shipping-access")
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


def check(name, cond, detail=""):
    global ok, fail
    ok, fail = (ok + 1, fail) if cond else (ok, fail + 1)
    print(f"   {'PASS' if cond else 'FAIL'}  {name}" + ("" if cond else f"  {detail}"))


USERS = [  # (user_id, email, role, admin_level)
    ("u_sup", "sup@x.com", "supersu", 5),
    ("u_mar", "maritza@x.com", "admin", 3),   # supervisora de Envíos
    ("u_a5", "prod5@x.com", "admin", 5),      # admin 5 de producción: sólo ve
    ("u_gen", "gen@x.com", "general", None),
    ("u_cov", "cubre@x.com", "admin", 3),     # quien la cubre en su ausencia
]


def sembrar():
    for c in ["orders", "users", "user_sessions", "activity_logs", "scheduled_shipments",
              "shipping_exports", "shipping_movements", "config_options"]:
        sdb[c].delete_many({})
    sdb.users.insert_many([{"user_id": u, "email": e, "name": u, "password_hash": bcrypt.hash("p"),
                            "role": r, "admin_level": lv, "active": True} for u, e, r, lv in USERS])
    sdb.orders.insert_one({"order_id": "o1", "order_number": "3319", "board": "FINAL BILL", "client": "GTS"})
    # Bitácora previa: Maritza ya editaba (y el supersu, que no cuenta para la lista).
    sdb.shipping_movements.insert_many([
        {"movement_id": "m0", "user_id": "u_mar", "action": "export_update", "at": "2026-09-30T00:00:00Z"},
        {"movement_id": "m1", "user_id": "u_sup", "action": "export_update", "at": "2026-09-30T00:00:00Z"},
    ])


async def main():
    sembrar()
    from httpx import ASGITransport, AsyncClient
    from server import app
    API = "/api/scheduled-shipments"
    cs = {}
    for u, e, _, _ in USERS:
        c = AsyncClient(transport=ASGITransport(app=app), base_url="http://smoke")
        r = await c.post("/api/auth/login", json={"email": e, "password": "p"})
        assert r.status_code == 200, (e, r.text)
        cs[u] = c
    try:
        print("== Sin lista guardada: editan los que ya editaban ==")
        acc = {u: (await cs[u].get(f"{API}/access")).json() for u in cs}
        check("Maritza (admin 3, con movimientos) edita", acc["u_mar"]["can_edit"] is True, acc["u_mar"])
        check("admin 5 sin movimientos NO edita", acc["u_a5"]["can_edit"] is False, acc["u_a5"])
        check("general NO edita", acc["u_gen"]["can_edit"] is False)
        check("supersu edita y administra (recibe usuarios)",
              acc["u_sup"]["can_edit"] and acc["u_sup"]["can_manage"] and len(acc["u_sup"].get("users", [])) == 5, acc["u_sup"])
        check("no-supersu no administra ni recibe usuarios",
              not acc["u_a5"]["can_manage"] and "users" not in acc["u_a5"])
        check("todos ven quién edita (sin el supersu en la lista)",
              [x["user_id"] for x in acc["u_gen"]["editors"]] == ["u_mar"], acc["u_gen"]["editors"])

        print("\n== Las 12 escrituras: 403 al que sólo ve ==")
        r = await cs["u_mar"].post(f"{API}/exports", json={"date": "2026-10-07"})
        check("Maritza crea export", r.status_code == 200, r.text[:200])
        exp_id = r.json().get("export_id")
        r = await cs["u_mar"].post(f"{API}/lines", json={"export_id": exp_id, "order_numbers": "3319"})
        check("Maritza agrega línea", r.status_code == 200 and r.json()["added"], r.text[:200])
        sid = r.json()["added"][0]["shipment_id"]
        mov = sdb.shipping_movements.find_one({"user_id": "u_mar", "movement_id": {"$nin": ["m0"]}})
        writes = [
            ("POST", f"{API}/exports", {"date": "2026-10-07"}),
            ("PUT", f"{API}/exports/{exp_id}", {"notes": "x"}),
            ("POST", f"{API}/exports/{exp_id}/assign-number", None),
            ("DELETE", f"{API}/exports/{exp_id}", None),
            ("POST", f"{API}/lines", {"export_id": exp_id, "order_numbers": "3319"}),
            ("POST", f"{API}/lines/{sid}/duplicate", None),
            ("POST", f"{API}/lines/move", {"shipment_ids": [sid], "move_to_date": "2026-10-08"}),
            ("POST", f"{API}/lines/delete", {"shipment_ids": [sid]}),
            ("POST", f"{API}", {"order_number": "3319", "ship_date": "2026-10-07"}),
            ("PUT", f"{API}/{sid}", {"pcs": 10}),
            ("DELETE", f"{API}/{sid}", None),
            ("POST", f"{API}/movements/{(mov or {}).get('movement_id', 'x')}/revert", None),
        ]
        for who in ("u_a5", "u_gen"):
            codes = []
            for m, url, body in writes:
                r = await cs[who].request(m, url, json=body) if body is not None else await cs[who].request(m, url)
                codes.append(r.status_code)
            check(f"{who}: las 12 escrituras → 403", codes == [403] * 12, codes)
        check("…y no se tocó nada", sdb.shipping_exports.count_documents({}) == 1
              and sdb.scheduled_shipments.count_documents({}) == 1)
        r = await cs["u_a5"].put(f"{API}/{sid}", json={"pcs": 10})
        check("el 403 explica qué hacer", "supersu" in r.text and "editor" in r.text, r.text)

        print("\n== Lecturas y PACKING siguen abiertas ==")
        for url in [f"{API}/week?start=2026-10-05", f"{API}/search?q=3319", f"{API}/summary?year=2026",
                    f"{API}/movements", f"{API}/exports/{exp_id}/packing/clients", f"{API}/map"]:
            r = await cs["u_gen"].get(url)
            check(f"general GET {url.split(API)[1].split('?')[0] or '/'} → 200", r.status_code == 200, r.status_code)
        r = await cs["u_gen"].post(f"{API}/exports/{exp_id}/packing")
        check("general puede pedir PACKING (no es 403)", r.status_code != 403, r.status_code)

        print("\n== Sólo supersu cambia la lista ==")
        r = await cs["u_mar"].put(f"{API}/access", json={"editors": ["u_mar", "u_cov"]})
        check("Maritza (editora) no puede cambiar la lista", r.status_code == 403, r.status_code)
        r = await cs["u_sup"].put(f"{API}/access", json={"editors": ["nadie"]})
        check("usuario inexistente → 400", r.status_code == 400 and "nadie" in r.text, r.text)
        r = await cs["u_sup"].put(f"{API}/access", json={"editors": "u_cov"})
        check("editors no-lista → 400", r.status_code == 400)

        print("\n== Ausencia: supersu pone a quien cubre y quita a Maritza ==")
        r = await cs["u_sup"].put(f"{API}/access", json={"editors": ["u_cov", "u_sup", "u_cov"]})
        check("guardado (sin duplicados ni supersu)", r.status_code == 200
              and [x["user_id"] for x in r.json()["editors"]] == ["u_cov"], r.text[:300])
        check("queda en la bitácora con el antes", bool(sdb.activity_logs.find_one(
            {"action": "update_shipping_editors", "details.before": ["u_mar"]})))
        r = await cs["u_cov"].put(f"{API}/{sid}", json={"pcs": 12})
        check("quien cubre ya edita", r.status_code == 200, r.text[:200])
        r = await cs["u_mar"].put(f"{API}/{sid}", json={"pcs": 13})
        check("Maritza fuera de la lista → sólo lectura (la bitácora ya no la cuela)", r.status_code == 403, r.status_code)
        r = await cs["u_sup"].put(f"{API}/{sid}", json={"pcs": 14})
        check("supersu sigue editando aunque no esté en la lista", r.status_code == 200)

        print("\n== Regresa Maritza ==")
        r = await cs["u_sup"].put(f"{API}/access", json={"editors": ["u_mar"]})
        acc = {u: (await cs[u].get(f"{API}/access")).json()["can_edit"] for u in ("u_mar", "u_cov")}
        check("Maritza edita otra vez y quien cubría ya no", acc == {"u_mar": True, "u_cov": False}, acc)
        r = await cs["u_sup"].put(f"{API}/access", json={"editors": []})
        check("lista vacía = sólo supersu (no regresa al default de bitácora)",
              (await cs["u_mar"].get(f"{API}/access")).json()["can_edit"] is False)
    finally:
        for c in cs.values():
            await c.aclose()
        raw.drop_database(SMOKE_DB)
    print(f"\n{ok} PASS · {fail} FAIL")
    sys.exit(1 if fail else 0)


asyncio.run(main())
