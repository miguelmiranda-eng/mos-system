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

    # _publish_final_bill toca deps.log_activity (Mongo real) y ws_manager, así que
    # se sustituye por un espía: aquí solo verificamos QUE se dispare por escritura.
    published = []

    async def fake_publish(order, set_fields):
        published.append((order.get("order_id"), dict(set_fields)))

    ps._publish_final_bill = fake_publish

    # 1. total de piezas desde el invoice maestro real
    with open(os.path.join(BE, "master_invoice_23686706.json"), encoding="utf-8") as f:
        inv = json.load(f)
    reals = ps._real_line_items(inv)
    total = sum(ps._billed_qty(li, q) for li, _, q in reals)
    print(f"\n== master invoice {inv.get('visualId')}: {len(reals)} garment line(s), total={total} ==")
    check("total quantity > 0", total > 0, f"got {total}")
    check("total facturado presente", inv.get("total") is not None)

    # 1b. `size_other` (talla que la grilla del invoice no sabe rotular) ya no se
    # tira: sin descripción que la desglose las 20u no producen renglón de talla,
    # pero SÍ cuentan en la cantidad, así que _map_sizes y `items` coinciden.
    li_other = {"items": 265, "color": "WHITE",
                "sizes": [{"count": 245, "size": "size_s"}, {"count": 20, "size": "size_other"}]}
    sz_other, sz_qty = ps._map_sizes(li_other)
    check("size_other cuenta en la cantidad", sz_qty == 265, f"got {sz_qty}")
    check("size_other no inventa renglón de talla", sz_other == {"S": 245}, f"got {sz_other}")
    check("_billed_qty usa items (265, no 245)", ps._billed_qty(li_other, sz_qty) == 265,
          f"got {ps._billed_qty(li_other, sz_qty)}")
    check("_billed_qty cae a tallas si items=0", ps._billed_qty({"items": 0}, 77) == 77)

    # 2. apply_final_bill escribe invoice + total_quantity en la orden base
    vid = str(inv["visualId"])
    await fake.orders.insert_one({"order_id": "o1", "order_number": vid, "board": "SCHEDULING"})
    applied = await ps.apply_final_bill(inv)
    order = await fake.orders.find_one({"order_id": "o1"})
    check("apply True cuando existe la orden", applied is True)
    check("columna invoice = total facturado",
          order.get("invoice") == round(float(inv["total"]), 2), f"got {order.get('invoice')}")
    check("columna total_quantity = suma de piezas", order.get("total_quantity") == total,
          f"got {order.get('total_quantity')}")
    check("marca final_bill_applied_at", bool(order.get("final_bill_applied_at")))
    check("publica el cambio (broadcast + log)", published and published[-1][0] == "o1",
          f"got {published}")

    # 2b. invoice ya pagado: la columna lleva lo FACTURADO, no el saldo (0)
    await fake.orders.insert_one({"order_id": "oPaid", "order_number": "555555", "board": "SCHEDULING"})
    paid = dict(inv, visualId="555555", total=1000.0, amountOutstanding=0.0, amountPaid=1000.0)
    await ps.apply_final_bill(paid)
    opaid = await fake.orders.find_one({"order_id": "oPaid"})
    check("pagado: invoice = 1000.0 (no el saldo 0)", opaid.get("invoice") == 1000.0,
          f"got {opaid.get('invoice')}")

    # 3. sin orden que coincida -> False (se reintenta luego)
    check("apply False sin orden", await ps.apply_final_bill(dict(inv, visualId="999999")) is False)

    # 3b. invoice sin lineas de prenda parseables -> escribe invoice, NO pisa total_quantity
    await fake.orders.insert_one({"order_id": "o0", "order_number": "777777",
                                  "board": "SCHEDULING", "total_quantity": 99})
    inv0 = {"visualId": "777777", "total": 205444.8, "lineItemGroups": {"nodes": []}}
    await ps.apply_final_bill(inv0)
    o0 = await fake.orders.find_one({"order_id": "o0"})
    check("0 piezas: escribe invoice", o0.get("invoice") == 205444.8, f"got {o0.get('invoice')}")
    check("0 piezas: NO pisa total_quantity", o0.get("total_quantity") == 99,
          f"got {o0.get('total_quantity')}")

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

    new_inv = dict(inv, id="gid://new", visualId="700001", total=300.15)
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

    # 6b. force_apply (backfill): escribe en el PRIMER run sin seed
    fake3 = FakeDB()
    ps.db = fake3
    await fake3.orders.insert_one({"order_id": "oB", "order_number": vid, "board": "SCHEDULING"})

    async def fake_resolve_fb(names):
        return ["523159"]

    async def fake_fetch_one(status_ids, first=25, after=None):
        return {"nodes": [inv], "pageInfo": {"hasNextPage": False, "endCursor": None}}

    pc.resolve_status_ids = fake_resolve_fb
    pc.fetch_invoices_by_status = fake_fetch_one
    r_bf = await ps.finalize_once({"final_bill_status_names": ["Final Bill"]}, force_apply=True)
    ob = await fake3.orders.find_one({"order_id": "oB"})
    check("backfill (force_apply) escribe en el primer run",
          r_bf.get("finalized") == 1 and ob.get("invoice") is not None, f"got {r_bf}")
    seeded_doc = await fake3.printavo_sync.find_one({"config_id": ps.CONFIG_ID})
    check("backfill marca final_bill_seeded", bool(seeded_doc and seeded_doc.get("final_bill_seeded")))

    # 6b-bis: backfill ESCRIBE aunque el invoice ya esté reclamado (seed previo)
    fake3b = FakeDB()
    ps.db = fake3b
    await fake3b.orders.insert_one({"order_id": "oC", "order_number": vid, "board": "SCHEDULING"})
    await fake3b.printavo_finalized.insert_one({"_id": inv.get("id") or "gid://master",
                                                "claimed_at": "seeded"})
    pc.resolve_status_ids = fake_resolve_fb
    pc.fetch_invoices_by_status = fake_fetch_one
    r_bf2 = await ps.finalize_once({"final_bill_status_names": ["Final Bill"], "final_bill_seeded": True},
                                   force_apply=True)
    oc = await fake3b.orders.find_one({"order_id": "oC"})
    check("backfill ignora claim previo y escribe",
          r_bf2.get("finalized") == 1 and oc.get("invoice") is not None, f"got {r_bf2}")

    # 6c. apply_final_bill_by_visual_id: aplica uno puntual (ignora claim)
    fake4 = FakeDB()
    ps.db = fake4
    await fake4.orders.insert_one({"order_id": "oV", "order_number": vid, "board": "SCHEDULING"})
    pc.fetch_invoices_by_status = fake_fetch_one
    rv = await ps.apply_final_bill_by_visual_id(vid, {"final_bill_status_names": ["Final Bill"]})
    ov = await fake4.orders.find_one({"order_id": "oV"})
    check("by_visual_id encuentra y aplica",
          rv.get("found") and rv.get("applied") and ov.get("invoice") is not None, f"got {rv}")
    rv_miss = await ps.apply_final_bill_by_visual_id("000000", {"final_bill_status_names": ["Final Bill"]})
    check("by_visual_id no encontrado -> found False", rv_miss.get("found") is False)

    # 6d. barrido profundo: el rezagado vive DEBAJO de la primera página ya reclamada.
    # La pasada superficial corta ahí (won==0) y nunca lo ve; deep=True sigue.
    fake5 = FakeDB()
    ps.db = fake5
    inv_a = dict(inv, id="gid://A", visualId="800001")          # ya reclamado
    inv_b = dict(inv, id="gid://B", visualId="800002", total=55.5)  # rezagado
    await fake5.printavo_finalized.insert_one({"_id": "gid://A", "claimed_at": "prev"})
    await fake5.orders.insert_one({"order_id": "oDeep", "order_number": "800002", "board": "SCHEDULING"})

    async def fake_fetch_2pages(status_ids, first=25, after=None):
        if after is None:
            return {"nodes": [inv_a], "pageInfo": {"hasNextPage": True, "endCursor": "c1"}}
        return {"nodes": [inv_b], "pageInfo": {"hasNextPage": False, "endCursor": None}}

    pc.resolve_status_ids = fake_resolve_fb
    pc.fetch_invoices_by_status = fake_fetch_2pages
    cfg_deep = {"final_bill_status_names": ["Final Bill"], "final_bill_seeded": True}
    r_shallow = await ps.finalize_once(cfg_deep)
    od_shallow = await fake5.orders.find_one({"order_id": "oDeep"})
    check("superficial NO alcanza al rezagado",
          r_shallow.get("finalized") == 0 and od_shallow.get("invoice") is None, f"got {r_shallow}")
    r_deep = await ps.finalize_once(cfg_deep, deep=True)
    od_deep = await fake5.orders.find_one({"order_id": "oDeep"})
    check("profundo sí lo alcanza y escribe 55.5",
          r_deep.get("finalized") == 1 and od_deep.get("invoice") == 55.5, f"got {r_deep}")

    # 6e. cadencia del barrido profundo (_deep_due)
    from routers.printavo_scheduler import _deep_due
    from datetime import datetime, timedelta, timezone as _tz
    check("nunca barrido -> toca", _deep_due({"final_bill_deep_every_minutes": 360}) is True)
    recent = (datetime.now(_tz.utc) - timedelta(minutes=10)).isoformat()
    check("barrido reciente -> no toca",
          _deep_due({"final_bill_deep_every_minutes": 360, "last_deep_finalize_at": recent}) is False)
    old = (datetime.now(_tz.utc) - timedelta(hours=7)).isoformat()
    check("barrido viejo -> toca",
          _deep_due({"final_bill_deep_every_minutes": 360, "last_deep_finalize_at": old}) is True)
    check("0 minutos -> desactivado",
          _deep_due({"final_bill_deep_every_minutes": 0}) is False)

    # 7. status sin match -> pass omitido, sin tronar
    async def fake_resolve_none(names):
        return []
    pc.resolve_status_ids = fake_resolve_none
    check("status sin match -> resolved False",
          (await ps.finalize_once({"final_bill_status_names": ["Nope"]})).get("resolved") is False)


asyncio.run(main())
print(f"\n{ok} PASS · {fail} FAIL")
sys.exit(1 if fail else 0)
