"""Smoke OFFLINE de las acciones nuevas + multi-acción (Fase 3, Track 3).

Congela execute_action para: add_comment (db.comments), set_date (fija fecha
hoy/hoy+N reusando assign_field), notify_push (web-push) y multi (varias acciones
en orden, sin anidar). Usa un db falso que registra las escrituras; parchea
push_notify y log_activity.

USO
───
    backend/venv/Scripts/python.exe backend/tests/smoke_automations_actions.py
"""
import asyncio
import os
import sys
from datetime import date, timedelta

BE = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
for k in ("MONGODB_URL", "DB_NAME", "JWT_SECRET", "MASTER_API_KEY", "INTERNAL_SYNC_TOKEN", "ENV", "RESEND_API_KEY"):
    os.environ.setdefault(k, "smoke")
sys.path.insert(0, BE)
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

import routers.automations as autos  # noqa: E402
import services.push_notify as pn    # noqa: E402
from routers.automations import _fmt  # noqa: E402

ok = fail = 0


def check(name, cond, detail=""):
    global ok, fail
    if cond:
        ok += 1
        print(f"   PASS  {name}")
    else:
        fail += 1
        print(f"   FAIL  {name}  {detail}")


class FakeColl:
    def __init__(self, docs=None):
        self.inserted = []
        self.updates = []
        self.docs = docs or {}

    async def insert_one(self, doc):
        self.inserted.append(doc)

    async def find_one(self, q, proj=None):
        return self.docs.get(q.get("order_id") or q.get("invoice_id"), {})

    async def update_one(self, q, upd):
        self.updates.append((q, upd))


class FakeDB:
    def __init__(self):
        self.comments = FakeColl()
        self.orders = FakeColl({"o1": {"order_number": "3213"}})
        self.invoices = FakeColl()


PUSHES = []


async def fake_push(db, title, body, url="/x", tag="x"):
    PUSHES.append({"title": title, "body": body, "url": url, "tag": tag})


async def noop_log(*a, **k):
    return None


ORDER = {"order_id": "o1", "order_number": "3213"}
USER = {"user_id": "u1", "name": "Tester"}


async def main():
    autos.db = FakeDB()
    autos.log_activity = noop_log
    pn.send_push_to_all = fake_push

    print("\n1) add_comment (con plantilla {order_number})")
    await autos.execute_action("add_comment", {"content": "Orden {order_number} lista"}, ORDER, USER)
    c = autos.db.comments.inserted
    check("insertó 1 comentario", len(c) == 1, f"{len(c)}")
    check("plantilla resuelta", c and c[0]["content"] == "Orden 3213 lista", f"{c and c[0]['content']!r}")
    check("marcado via=automation", c and c[0].get("via") == "automation")

    print("\n2) set_date: hoy y hoy+7 (reusa assign_field)")
    await autos.execute_action("set_date", {"field": "due_date", "mode": "today"}, ORDER, USER)
    upds = autos.db.orders.updates
    hoy = date.today().isoformat()
    check("due_date = hoy", upds and upds[-1][1]["$set"].get("due_date") == hoy, f"{upds and upds[-1][1]['$set']}")
    await autos.execute_action("set_date", {"field": "cancel_date", "mode": "offset", "days": 7}, ORDER, USER)
    mas7 = (date.today() + timedelta(days=7)).isoformat()
    check("cancel_date = hoy+7", autos.db.orders.updates[-1][1]["$set"].get("cancel_date") == mas7,
          f"{autos.db.orders.updates[-1][1]['$set']}")

    print("\n3) notify_push (web push)")
    PUSHES.clear()
    await autos.execute_action("notify_push", {"title": "MOS", "message": "orden {order_number} atención"}, ORDER, USER)
    check("disparó 1 push", len(PUSHES) == 1, f"{len(PUSHES)}")
    check("cuerpo con plantilla", PUSHES and PUSHES[0]["body"] == "orden 3213 atención", f"{PUSHES}")

    print("\n4) multi: varias acciones en orden (sin anidar)")
    autos.db = FakeDB(); PUSHES.clear()
    await autos.execute_action("multi", {"actions": [
        {"action_type": "add_comment", "action_params": {"content": "paso 1"}},
        {"action_type": "notify_push", "action_params": {"message": "paso 2"}},
        {"action_type": "multi", "action_params": {"actions": []}},  # anidado -> ignorado
    ]}, ORDER, USER)
    check("multi ejecutó el comentario", len(autos.db.comments.inserted) == 1, f"{len(autos.db.comments.inserted)}")
    check("multi ejecutó el push", len(PUSHES) == 1, f"{len(PUSHES)}")

    print("\n5) _fmt tolerante a campos faltantes")
    check("campo presente se resuelve", _fmt("orden {order_number}", ORDER) == "orden 3213", f"{_fmt('orden {order_number}', ORDER)!r}")
    check("campo faltante -> crudo, no revienta", _fmt("x {missing}", ORDER) == "x {missing}", f"{_fmt('x {missing}', ORDER)!r}")
    check("None -> vacío", _fmt("x={client}", {"order_number": "1", "client": None}) == "x=", f"{_fmt('x={client}', {'client': None})!r}")

    print(f"\n{'='*60}\n   {ok} PASS / {fail} FAIL\n{'='*60}")
    sys.exit(1 if fail else 0)


asyncio.run(main())
