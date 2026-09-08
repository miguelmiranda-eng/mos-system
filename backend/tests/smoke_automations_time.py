"""Smoke OFFLINE de las reglas por TIEMPO / SLA (Fase 3, Track 1).

Congela time_rule_due / time_conditions_ok (predicados puros) y el flujo de
evaluate_time_rules: barre órdenes, dispara la acción y reclama (regla, orden)
para no re-disparar. Usa un db falso; parchea push_notify y log_activity.

USO
───
    backend/venv/Scripts/python.exe backend/tests/smoke_automations_time.py
"""
import asyncio
import os
import sys
from datetime import datetime, timezone, timedelta

BE = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
for k in ("MONGODB_URL", "DB_NAME", "JWT_SECRET", "MASTER_API_KEY", "INTERNAL_SYNC_TOKEN", "ENV", "RESEND_API_KEY"):
    os.environ.setdefault(k, "smoke")
sys.path.insert(0, BE)
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

from pymongo.errors import DuplicateKeyError  # noqa: E402
from routers.automations import time_rule_due, time_conditions_ok  # noqa: E402
import routers.automation_scheduler as sched  # noqa: E402
import routers.automations as autos  # noqa: E402
import services.push_notify as pn  # noqa: E402

ok = fail = 0


def check(name, cond, detail=""):
    global ok, fail
    if cond:
        ok += 1
        print(f"   PASS  {name}")
    else:
        fail += 1
        print(f"   FAIL  {name}  {detail}")


NOW = datetime(2026, 9, 8, 12, 0, tzinfo=timezone.utc)


def iso(dt):
    return dt.isoformat()


print("\n1) time_rule_due: elapsed (status_at)")
o = {"production_status_at": iso(NOW - timedelta(days=4))}
check("4 días en status, umbral 3d -> due", time_rule_due({"basis": "production_status_at", "amount": 3, "unit": "days"}, o, NOW))
check("umbral 5d -> no due", not time_rule_due({"basis": "production_status_at", "amount": 5, "unit": "days"}, o, NOW))
o2 = {"production_status_at": iso(NOW - timedelta(hours=26))}
check("26h en status, umbral 24h -> due", time_rule_due({"basis": "production_status_at", "amount": 24, "unit": "hours"}, o2, NOW))
check("sin la marca -> no due", not time_rule_due({"basis": "production_status_at", "amount": 1, "unit": "days"}, {}, NOW))

print("\n2) time_rule_due: fechas (before / after)")
due_soon = {"cancel_date": (NOW + timedelta(days=1)).date().isoformat()}
check("cancel en 1d, 'before' 2d -> due (dentro de la ventana)",
      time_rule_due({"basis": "cancel_date", "amount": 2, "unit": "days", "direction": "before"}, due_soon, NOW))
check("cancel en 1d, 'before' 0d -> no due (aún no llega)",
      not time_rule_due({"basis": "cancel_date", "amount": 0, "unit": "days", "direction": "before"}, due_soon, NOW))
overdue = {"cancel_date": (NOW - timedelta(days=3)).date().isoformat()}
check("cancel hace 3d, 'after' 2d -> due (vencida por 2+)",
      time_rule_due({"basis": "cancel_date", "amount": 2, "unit": "days", "direction": "after"}, overdue, NOW))
check("cancel hace 3d, 'after' 5d -> no due",
      not time_rule_due({"basis": "cancel_date", "amount": 5, "unit": "days", "direction": "after"}, overdue, NOW))

print("\n3) time_conditions_ok: flags + avanzadas estrictas")
order = {"production_status": "EN PRODUCCION", "sample_printavo": "SI", "quantity": 2000}
check("flag SI casa", time_conditions_ok({"basis": "x", "sample_printavo": "SI"}, order))
check("flag NO no casa", not time_conditions_ok({"sample_printavo": "NO"}, order))
check("avanzada qty>1500 casa", time_conditions_ok({"advanced": [{"field": "quantity", "op": "gt", "value": "1500"}]}, order))
check("campo ausente estricto no casa", not time_conditions_ok({"final_bill": "x"}, order))


# ── fake db para evaluate_time_rules ──
class Chain:
    def __init__(self, docs):
        self.docs = list(docs); self._skip = 0; self._limit = None

    def skip(self, n):
        self._skip = n; return self

    def limit(self, n):
        self._limit = n; return self

    async def to_list(self, n):
        d = self.docs[self._skip:]
        return d[:self._limit] if self._limit is not None else d


class AutosColl:
    def __init__(self, docs):
        self.docs = docs

    def find(self, q, proj=None):
        tt = q.get("trigger_type"); act = q.get("is_active")
        return Chain([d for d in self.docs
                      if (tt is None or d.get("trigger_type") == tt)
                      and (act is None or d.get("is_active") == act)])


class OrdersColl:
    def __init__(self, docs):
        self.docs = docs

    def find(self, q, proj=None):
        return Chain(self.docs)


class FiresColl:
    def __init__(self):
        self.ids = set()

    async def insert_one(self, doc):
        if doc["_id"] in self.ids:
            raise DuplicateKeyError("dup")
        self.ids.add(doc["_id"])

    async def delete_many(self, q):
        return None


class FakeDB:
    def __init__(self, rules, orders):
        self.automations = AutosColl(rules)
        self.orders = OrdersColl(orders)
        self.automation_fires = FiresColl()


PUSHES = []


async def fake_push(db, title, body, url="/x", tag="x"):
    PUSHES.append({"title": title, "body": body})


async def noop_log(*a, **k):
    return None


async def main():
    global ok, fail
    print("\n4) evaluate_time_rules: dispara y reclama (una vez)")
    RULE = {"automation_id": "auto_t1", "name": "SLA parada", "trigger_type": "time", "is_active": True,
            "boards": [], "trigger_conditions": {"basis": "production_status_at", "amount": 3, "unit": "days"},
            "action_type": "notify_push", "action_params": {"title": "SLA", "message": "orden {order_number} parada"}}
    ORDERS = [
        {"order_id": "o1", "order_number": "3001", "board": "MAQUINA1", "production_status_at": iso(NOW - timedelta(days=4))},
        {"order_id": "o2", "order_number": "3002", "board": "MAQUINA1", "production_status_at": iso(NOW - timedelta(days=1))},  # no vencida
    ]
    fake = FakeDB([RULE], ORDERS)
    sched.db = fake
    autos.db = fake
    sched.log_activity = noop_log
    pn.send_push_to_all = fake_push
    PUSHES.clear()

    res = await sched.evaluate_time_rules(NOW)
    check("evaluó 1 regla", res["rules"] == 1, f"{res}")
    check("disparó 1 (solo la vencida)", res["fired"] == 1, f"{res}")
    check("push a la orden vencida", len(PUSHES) == 1 and PUSHES[0]["body"] == "orden 3001 parada", f"{PUSHES}")

    # Segunda pasada: la claim impide re-disparar.
    PUSHES.clear()
    res2 = await sched.evaluate_time_rules(NOW)
    check("2da pasada -> no re-dispara (claim)", res2["fired"] == 0, f"{res2}")
    check("sin push repetido", len(PUSHES) == 0, f"{PUSHES}")

    print(f"\n{'='*60}\n   {ok} PASS / {fail} FAIL\n{'='*60}")
    sys.exit(1 if fail else 0)


asyncio.run(main())
