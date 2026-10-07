"""Smoke — 2o reporte: quotes de Printavo pendientes de MOS.

Contrato (sin pegarle a Printavo; se monkeypatchea fetch_quotes_page):
  · se EXCLUYE un quote cuyo visualId ya es orden en MOS (incluye base 'NNNN-2').
  · se EXCLUYE un quote fuera de la ventana de N días.
  · se cuentan piezas desde sizes/items.
  · genera un .xlsx con solo los pendientes.

Base DESECHABLE.
"""
import asyncio
import os
import sys
from datetime import datetime, timezone, timedelta

BE = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
SMOKE_DB = os.environ.get("SMOKE_DB_NAME", "mos-smoke-test")
PROD_DB = os.environ.get("PROD_DB_NAME", "mos-system")
MONGO = os.environ.get("MONGODB_URL") or os.environ.get("MONGO_URL")
if not MONGO:
    sys.exit("Falta MONGODB_URL")
if SMOKE_DB == PROD_DB:
    sys.exit(f"NEGADO: SMOKE_DB_NAME es prod ('{PROD_DB}').")
os.environ["MONGODB_URL"] = MONGO
os.environ["DB_NAME"] = SMOKE_DB
os.environ.setdefault("JWT_SECRET", "x"); os.environ.setdefault("MASTER_API_KEY", "x")
os.environ.setdefault("INTERNAL_SYNC_TOKEN", "x"); os.environ.setdefault("ENV", "local")
os.environ.setdefault("DISABLE_SCHEDULERS", "1")
sys.path.insert(0, BE); os.chdir(BE)

import pymongo  # noqa: E402
raw = pymongo.MongoClient(MONGO); sdb = raw[SMOKE_DB]
ok = fail = 0


def check(n, cond, d=""):
    global ok, fail
    print(("   PASS  " if cond else "   FAIL  ") + n + ("" if cond else f"  {d}"))
    ok += bool(cond); fail += (not cond)


def _node(vid, created, pieces_sizes=None, items=None, company="ACME", total=100.0):
    lis = {"items": items, "sizes": [{"count": c, "size": s} for s, c in (pieces_sizes or {}).items()]}
    return {
        "visualId": vid, "createdAt": created, "nickname": f"Q{vid}", "total": total,
        "customerDueAt": created, "dueAt": created, "url": f"http://x/{vid}",
        "status": {"name": "Quote"},
        "contact": {"fullName": "Juan", "customer": {"companyName": company}},
        "lineItemGroups": {"nodes": [{"lineItems": {"nodes": [lis]}}]},
    }


async def run():
    import printavo_client
    from services import quotes_report

    today = datetime.now(timezone.utc).date().isoformat()
    old = (datetime.now(timezone.utc) - timedelta(days=60)).date().isoformat() + "T00:00:00Z"

    # Órdenes YA en MOS: 3655 directo y 3240 vía hermana 3240-2.
    sdb.orders.insert_many([{"order_number": "3655"}, {"order_number": "3240-2"}])

    calls = {"n": 0}
    async def fake_fetch(first=25, after=None):
        calls["n"] += 1
        return {"nodes": [
            _node("9001", today + "T10:00:00Z", pieces_sizes={"M": 20, "L": 28}),   # NUEVO -> entra (48 pzs)
            _node("3655", today + "T09:00:00Z", items=10),                          # ya en MOS -> fuera
            _node("3240", today + "T08:00:00Z", items=5),                           # base 3240 en MOS -> fuera
            _node("7000", old, items=99),                                           # fuera de ventana -> fuera
        ], "has_next": False, "end_cursor": None}

    printavo_client.is_configured = lambda: True
    printavo_client.fetch_quotes_page = fake_fetch

    res = await quotes_report.build_pending_quotes_report(days=30)
    check("genera reporte", res is not None and res.get("count") is not None, d=str(res))
    check("solo 1 quote pendiente (9001)", res["count"] == 1, d=str(res["count"]))
    check("una sola llamada paginada", calls["n"] == 1, d=str(calls["n"]))
    check("xlsx no vacío", len(res["data"]) > 500)
    check("filename correcto", res["filename"].startswith("QUOTES_PENDIENTES_MOS_") and res["filename"].endswith(".xlsx"))

    # piezas: sizes manda (20+28=48)
    check("piezas por sizes = 48", quotes_report._pieces(_node("x", today, pieces_sizes={"M": 20, "L": 28})) == 48)
    check("piezas por items cuando no hay sizes = 7", quotes_report._pieces(_node("x", today, items=7)) == 7)

    # Printavo no configurado -> None
    printavo_client.is_configured = lambda: False
    none_res = await quotes_report.build_pending_quotes_report(days=30)
    check("sin Printavo -> None", none_res is None)


if __name__ == "__main__":
    raw.drop_database(SMOKE_DB)
    asyncio.run(run())
    print(f"\n   {ok} PASS / {fail} FAIL")
    raw.drop_database(SMOKE_DB)
    sys.exit(1 if fail else 0)
