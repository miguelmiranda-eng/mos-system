"""Smoke OFFLINE de la pasada de creación POR STATUS (fix del hueco de la ventana).

Congela create_from_status: pagina invoices en 'Scheduled', reclama (claim) y crea
las que aún no existen; salta las ya reclamadas (creadas/seeded/trasheadas); acotada
a create_status_pages. Cubre el bug de conversiones tardías quote->Scheduled que
caían fuera de la ventana de recientes.

USO
───
    backend/venv/Scripts/python.exe backend/tests/smoke_printavo_create_by_status.py
"""
import asyncio
import os
import sys

BE = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
for k in ("MONGODB_URL", "DB_NAME", "JWT_SECRET", "MASTER_API_KEY", "INTERNAL_SYNC_TOKEN", "ENV"):
    os.environ.setdefault(k, "smoke")
sys.path.insert(0, BE)
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

from pymongo.errors import DuplicateKeyError  # noqa: E402
import printavo_sync as ps  # noqa: E402
import printavo_client as pc  # noqa: E402

ok = fail = 0


def check(name, cond, detail=""):
    global ok, fail
    if cond:
        ok += 1
        print(f"   PASS  {name}")
    else:
        fail += 1
        print(f"   FAIL  {name}  {detail}")


class FakeProcessed:
    def __init__(self, pre=()):
        self.ids = set(pre)

    async def insert_one(self, doc):
        if doc["_id"] in self.ids:
            raise DuplicateKeyError("dup")
        self.ids.add(doc["_id"])

    async def delete_one(self, q):
        self.ids.discard(q.get("_id"))


class FakeDB:
    def __init__(self, pre=()):
        self.printavo_processed = FakeProcessed(pre)


CREATED = []


async def fake_process_invoice(node):
    CREATED.append(str(node.get("visualId")))
    return 1  # una orden por invoice


async def fake_resolve(names):
    return ["sid_scheduled"]


def _pages(pages):
    """pages: lista de (nodes, hasNext). Devuelve una fake fetch_invoices_by_status."""
    async def _fetch(status_ids, first=25, after=None):
        idx = 0 if after is None else int(after)
        nodes, has_next = pages[idx]
        return {"nodes": nodes, "pageInfo": {"hasNextPage": has_next, "endCursor": str(idx + 1)}}
    return _fetch


def inv(vid, iid=None):
    return {"id": iid or f"gid://{vid}", "visualId": vid}


async def main():
    global ok, fail
    ps.process_invoice = fake_process_invoice
    pc.resolve_status_ids = fake_resolve

    print("\n1) crea las no reclamadas, salta las ya reclamadas")
    CREATED.clear()
    ps.db = FakeDB(pre={"gid://3468"})  # 3468 ya reclamada (ya creada antes)
    pc.fetch_invoices_by_status = _pages([
        ([inv("3468"), inv("3467"), inv("3466")], True),   # pág 1
        ([inv("3400")], False),                             # pág 2
    ])
    n = await ps.create_from_status({"required_statuses": ["Scheduled"], "create_status_pages": 6})
    check("creó 3 (3467, 3466, 3400) — salta 3468 reclamada", n == 3, f"n={n}")
    check("no recreó 3468", "3468" not in CREATED, f"{CREATED}")
    check("sí creó 3466 y 3467 (fuera de ventana)", "3466" in CREATED and "3467" in CREATED, f"{CREATED}")

    print("\n2) idempotente: segunda corrida no recrea nada")
    CREATED.clear()
    n2 = await ps.create_from_status({"required_statuses": ["Scheduled"], "create_status_pages": 6})
    check("segunda corrida crea 0 (todas reclamadas)", n2 == 0, f"n2={n2}")

    print("\n3) acotada: create_status_pages limita las páginas escaneadas")
    CREATED.clear()
    ps.db = FakeDB()
    pc.fetch_invoices_by_status = _pages([
        ([inv("9001")], True),
        ([inv("1840")], True),   # histórico viejo — NO debe alcanzarse con pages=1
        ([inv("500")], False),
    ])
    n3 = await ps.create_from_status({"required_statuses": ["Scheduled"], "create_status_pages": 1})
    check("pages=1 -> solo la 1ª página (no llega al histórico viejo)", CREATED == ["9001"], f"{CREATED}")
    check("no alcanzó 1840 ni 500", "1840" not in CREATED and "500" not in CREATED)

    print("\n4) sin status resuelto -> no hace nada")
    pc.resolve_status_ids = lambda names: _empty()
    n4 = await ps.create_from_status({"required_statuses": ["NoExiste"]})
    check("status sin match -> 0", n4 == 0, f"n4={n4}")

    print(f"\n{'='*60}\n   {ok} PASS / {fail} FAIL\n{'='*60}")
    sys.exit(1 if fail else 0)


async def _empty():
    return []


asyncio.run(main())
