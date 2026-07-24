"""Smoke OFFLINE del paso Final Bill de Printavo (no necesita Mongo ni API).

Cubre: cálculo del total de piezas desde un invoice real, apply_final_bill
escribiendo las columnas `invoice` / `total_quantity` en la orden base, claim
idempotente, y finalize_once en sus dos modos (seed en el primer run vs.
aplicación en régimen). Usa un fake en memoria para `db` y para printavo_client,
así corre en cualquier lado sin infra.

USO
───
    backend/venv/Scripts/python.exe backend/tests/smoke_printavo_final_bill.py
"""
import asyncio
import json
import os
import sys

BE = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
os.environ.setdefault("MONGODB_URL", "mongodb://localhost:27017")
os.environ.setdefault("DB_NAME", "mos-offline-test")
os.environ.setdefault("JWT_SECRET", "offline_secret")
os.environ.setdefault("ENV", "local")
sys.path.insert(0, BE)

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

ok = fail = 0


def check(name, cond, detail=""):
    global ok, fail
    if cond:
        ok += 1
        print(f"   PASS  {name}")
    else:
        fail += 1
        print(f"   FAIL  {name}  {detail}")


class FakeCollection:
    def __init__(self):
        self.docs = []

    @staticmethod
    def _match(doc, flt):
        for k, v in flt.items():
            if isinstance(v, dict) and "$ne" in v:
                if doc.get(k) == v["$ne"]:
                    return False
            elif doc.get(k) != v:
                return False
        return True

    async def find_one(self, flt, proj=None):
        for d in self.docs:
            if self._match(d, flt):
                return dict(d)
        return None

    async def insert_one(self, doc):
        from pymongo.errors import DuplicateKeyError
        _id = doc.get("_id")
        if _id is not None and any(d.get("_id") == _id for d in self.docs):
            raise DuplicateKeyError("dup")
        self.docs.append(dict(doc))

    async def update_one(self, flt, update, upsert=False):
        for d in self.docs:
            if self._match(d, flt):
                d.update(update.get("$set", {}))
                return
        if upsert:
            nd = dict(flt)
            nd.update(update.get("$set", {}))
            self.docs.append(nd)

    async def delete_one(self, flt):
        for i, d in enumerate(self.docs):
            if self._match(d, flt):
                self.docs.pop(i)
                return


class FakeDB:
    def __init__(self):
        self.orders = FakeCollection()
        self.printavo_finalized = FakeCollection()
        self.printavo_sync = FakeCollection()


async def main():
    import printavo_sync as ps
    import printavo_client as pc

    fake = FakeDB()
    ps.db = fake

    # 1. total de piezas desde el invoice maestro real
    with open(os.path.join(BE, "master_invoice_23686706.json"), encoding="utf-8") as f:
        inv = json.load(f)
    reals = ps._real_line_items(inv)
    total = sum(q for _, _, q in reals)
    print(f"\n== master invoice {inv.get('visualId')}: {len(reals)} garment line(s), total={total} ==")
    check("total quantity > 0", total > 0, f"got {total}")
    check("amountOutstanding presente", inv.get("amountOutstanding") is not None)

    # 2. apply_final_bill escribe invoice + total_quantity en la orden base
    vid = str(inv["visualId"])
    await fake.orders.insert_one({"order_id": "o1", "order_number": vid, "board": "SCHEDULING"})
    applied = await ps.apply_final_bill(inv)
    order = await fake.orders.find_one({"order_id": "o1"})
    check("apply True cuando existe la orden", applied is True)
    check("columna invoice = amountOutstanding",
          order.get("invoice") == round(float(inv["amountOutstanding"]), 2), f"got {order.get('invoice')}")
    check("columna total_quantity = suma de piezas", order.get("total_quantity") == total,
          f"got {order.get('total_quantity')}")
    check("marca final_bill_applied_at", bool(order.get("final_bill_applied_at")))

    # 3. sin orden que coincida -> False (se reintenta luego)
    check("apply False sin orden", await ps.apply_final_bill(dict(inv, visualId="999999")) is False)

    # 4. orden en papelera se ignora
    await fake.orders.insert_one({"order_id": "o2", "order_number": "888888", "board": ps.TRASH_BOARD})
    check("orden en papelera no matchea", await ps.apply_final_bill(dict(inv, visualId="888888")) is False)

    # 5. claim idempotente
    check("primer claim gana", await ps._claim_finalize("inv-A") is True)
    check("segundo claim pierde", await ps._claim_finalize("inv-A") is False)

    # 6. finalize_once: seed en el primer run, luego aplica
    fake2 = FakeDB()
    ps.db = fake2
    await fake2.orders.insert_one({"order_id": "oX", "order_number": vid, "board": "SCHEDULING"})

    async def fake_resolve(names):
        return ["523155"] if names else []

    async def fake_fetch(status_ids, first=30, after=None):
        return {"nodes": [inv], "pageInfo": {"hasNextPage": False, "endCursor": None}}

    pc.resolve_status_ids = fake_resolve
    pc.fetch_invoices_by_status = fake_fetch

    r_seed = await ps.finalize_once({"final_bill_status_names": ["Final Bill"]})
    seeded_order = await fake2.orders.find_one({"order_id": "oX"})
    check("primer run = seed (no escribe)",
          r_seed.get("seeded") is True and seeded_order.get("invoice") is None)

    new_inv = dict(inv, id="gid://new", visualId="700001", amountOutstanding=300.15)
    await fake2.orders.insert_one({"order_id": "oNew", "order_number": "700001", "board": "SCHEDULING"})

    async def fake_fetch2(status_ids, first=30, after=None):
        return {"nodes": [new_inv], "pageInfo": {"hasNextPage": False, "endCursor": None}}

    pc.fetch_invoices_by_status = fake_fetch2
    r_go = await ps.finalize_once({"final_bill_status_names": ["Final Bill"], "final_bill_seeded": True})
    new_order = await fake2.orders.find_one({"order_id": "oNew"})
    check("régimen finaliza 1", r_go.get("finalized") == 1, f"got {r_go}")
    check("régimen escribe invoice=300.15", new_order.get("invoice") == 300.15, f"got {new_order.get('invoice')}")

    r_again = await ps.finalize_once({"final_bill_status_names": ["Final Bill"], "final_bill_seeded": True})
    check("re-run idempotente (finaliza 0)", r_again.get("finalized") == 0, f"got {r_again}")

    # 7. status sin match -> pass omitido, sin tronar
    async def fake_resolve_none(names):
        return []
    pc.resolve_status_ids = fake_resolve_none
    check("status sin match -> resolved False",
          (await ps.finalize_once({"final_bill_status_names": ["Nope"]})).get("resolved") is False)


asyncio.run(main())
print(f"\n{ok} PASS · {fail} FAIL")
sys.exit(1 if fail else 0)
