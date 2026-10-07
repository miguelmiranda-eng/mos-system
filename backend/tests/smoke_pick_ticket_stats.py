"""Smoke — /pick-tickets/stats soporta los DOS formatos de picked_sizes.

Contrato:
  · picked_sizes SIMPLE (talla→número) y NUEVO anidado
    (talla→{"total": N, "details": {...}}) y MIXTO suman sin crashear.
  · Las piezas por operador se acumulan correcto entre formatos.
  · _sum_size_map normaliza ambos (y None/valores basura -> 0).

Regresión del 2026-10-07: int() sobre el dict anidado tumbaba el endpoint
(2854 de 3474 tickets lo traían).

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
raw = pymongo.MongoClient(MONGO)
sdb = raw[SMOKE_DB]
ok = fail = 0


def check(n, cond, d=""):
    global ok, fail
    print(("   PASS  " if cond else "   FAIL  ") + n + ("" if cond else f"  {d}"))
    ok += bool(cond); fail += (not cond)


def sembrar():
    raw.drop_database(SMOKE_DB)
    sdb.wms_pick_tickets.insert_many([
        # A — Ana, SIMPLE, completado. sizes 100, picked 80.
        {"ticket_id": "A", "assigned_to_name": "Ana", "picking_status": "completed",
         "sizes": {"S": 40, "M": 60}, "picked_sizes": {"S": 30, "M": 50}},
        # C — Ana, MIXTO (simple + anidado), pendiente. sizes 30, picked 15.
        {"ticket_id": "C", "assigned_to_name": "Ana", "picking_status": "pending",
         "sizes": {"S": 20, "M": 10},
         "picked_sizes": {"S": 10, "M": {"total": 5, "details": {"L1": 5}}}},
        # B — Beto, NUEVO anidado, en progreso. sizes 100, picked 83.
        {"ticket_id": "B", "assigned_to_name": "Beto", "picking_status": "in_progress",
         "sizes": {"S": 50, "L": 50},
         "picked_sizes": {"S": {"total": 41, "details": {"R1": 41}},
                          "L": {"total": 42, "details": {"R2": 42}}}},
        # D — sin operador (se cuenta en totales, no en operadores).
        {"ticket_id": "D", "assigned_to_name": "", "picking_status": "pending",
         "sizes": {}, "picked_sizes": {}},
    ])


async def run():
    from routers import wms as wmsmod

    # Monkeypatch auth para llamar el endpoint real sin login.
    async def _fake_auth(request):
        return {"user_id": "u", "name": "t", "role": "admin"}
    wmsmod.require_auth = _fake_auth

    # Helper directo
    sm = wmsmod._sum_size_map
    check("_sum_size_map simple", sm({"S": 30, "M": 50}) == 80)
    check("_sum_size_map anidado", sm({"S": {"total": 41}, "L": {"total": 42, "details": {}}}) == 83)
    check("_sum_size_map mixto", sm({"S": 10, "M": {"total": 5}}) == 15)
    check("_sum_size_map vacío", sm({}) == 0 and sm(None) == 0)
    check("_sum_size_map None/basura -> 0", sm({"S": None, "M": {"total": None}}) == 0)

    # Endpoint real (antes crasheaba con TypeError)
    res = await wmsmod.pick_ticket_stats(None)
    check("endpoint NO crashea", isinstance(res, dict) and "operators" in res)
    check("totales: 1 completed / 1 in_progress / 2 pending",
          res["completed"] == 1 and res["in_progress"] == 1 and res["pending"] == 2, d=str(res))
    ops = {o["name"]: o for o in res["operators"]}
    check("Ana picked=95 (80+15), total=130", ops.get("Ana", {}).get("picked_pieces") == 95
          and ops["Ana"]["total_pieces"] == 130, d=str(ops.get("Ana")))
    check("Ana completed=1 / assigned=1", ops["Ana"]["completed"] == 1 and ops["Ana"]["assigned"] == 1)
    check("Beto picked=83 (anidado), total=100", ops.get("Beto", {}).get("picked_pieces") == 83
          and ops["Beto"]["total_pieces"] == 100, d=str(ops.get("Beto")))


if __name__ == "__main__":
    sembrar()
    asyncio.run(run())
    print(f"\n   {ok} PASS / {fail} FAIL")
    raw.drop_database(SMOKE_DB)
    sys.exit(1 if fail else 0)
