"""Backfill de `sample_printavo` en órdenes ya importadas de Printavo.

Re-lee los invoices de Printavo con la query de LISTA PAGINADA (25 por página,
gentil con el WAF — NO una llamada por invoice) y corre el MISMO clasificador
del forward sync (printavo_sync._sample_signal) sobre la sección de muestra,
estampando `sample_printavo` (SI/NO) + `sample_printavo_raw` en las órdenes que
cruzan por `order_number == visualId`.

  · "desconocido" (el invoice no trae la sección) -> NO se escribe (ausente ≠ NO).
  · Solo escribe donde el campo AÚN NO existe (idempotente).
  · Refleja lo que Printavo tiene HOY: quotes Spencers viejos con TOPS NEEDED
    vacío salen NO aunque el PO dijera SAMPLE Y (eso solo lo arregla el fix del
    export, hacia adelante).

CUIDADO: comparte token con el forward sync de producción. Por eso va PAGINADO,
con pausa entre páginas y backoff ante 403; si el WAF bloquea, ABORTA en vez de
insistir. Credenciales por entorno. DRY-RUN por defecto; --apply para escribir.

    venv/Scripts/python.exe backfill_sample_printavo.py            # dry-run
    venv/Scripts/python.exe backfill_sample_printavo.py --apply    # escribe
"""
import asyncio
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

from dotenv import load_dotenv
import httpx
from motor.motor_asyncio import AsyncIOMotorClient

BE = Path(__file__).parent
load_dotenv(BE / ".env")
# NO forzar DB_NAME (debe ser la base real). Solo lo que deps.py exige para importar.
for k in ("JWT_SECRET", "MASTER_API_KEY", "INTERNAL_SYNC_TOKEN", "ENV"):
    os.environ.setdefault(k, "backfill")
sys.path.insert(0, str(BE))
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

from printavo_sync import _sample_signal  # el MISMO lector del forward sync

TRASH = "PAPELERA DE RECICLAJE"
ENDPOINT = os.environ.get("PRINTAVO_API_URL", "https://www.printavo.com/api/v2")
EMAIL = os.environ.get("PRINTAVO_API_EMAIL", "")
TOKEN = os.environ.get("PRINTAVO_API_TOKEN", "")
PAGE_DELAY = 2.0          # pausa entre páginas (gentil con el WAF)
PAGE_SIZE = 25            # límite de complejidad de esta connection
MAX_PAGES = 120           # tope de seguridad

PAGE_QUERY = """
query Page($first:Int!, $after:String) {
  invoices(first:$first, after:$after, sortOn:VISUAL_ID, sortDescending:true) {
    pageInfo { hasNextPage endCursor }
    nodes { visualId lineItemGroups(first:6){nodes{lineItems(first:25){nodes{description color items}}}} }
  }
}
"""


async def _fetch_page(client, after):
    """Una página. Ante 403/no-json hace backoff y reintenta; si insiste, lanza."""
    for attempt in range(4):
        r = await client.post(ENDPOINT, json={"query": PAGE_QUERY, "variables": {"first": PAGE_SIZE, "after": after}},
                              headers={"email": EMAIL, "token": TOKEN, "Content-Type": "application/json"})
        try:
            d = r.json()
        except Exception:
            wait = 30 * (attempt + 1)
            print(f"   WAF/403 (HTTP {r.status_code}); backoff {wait}s (intento {attempt + 1}/4)")
            await asyncio.sleep(wait)
            continue
        if d.get("errors"):
            raise RuntimeError(f"GraphQL errors: {d['errors']}")
        return (d.get("data") or {}).get("invoices") or {}
    raise RuntimeError("Bloqueo persistente del WAF; abortando para no afectar el sync de producción.")


async def main(apply: bool):
    if not (EMAIL and TOKEN):
        print("Faltan PRINTAVO_API_EMAIL / PRINTAVO_API_TOKEN en el entorno."); return
    db = AsyncIOMotorClient(os.environ["MONGODB_URL"])[os.environ.get("DB_NAME", "mos-system")]

    live = {"board": {"$ne": TRASH}, "source": "printavo_auto", "sample_printavo": {"$exists": False}}
    # visualId(str) -> [order_ids]  (base del order_number: '3210-2' -> '3210')
    vid_orders = {}
    min_vid = None
    async for o in db.orders.find(live, {"_id": 0, "order_id": 1, "order_number": 1}):
        base = str(o.get("order_number") or "").split("-")[0]
        vid_orders.setdefault(base, []).append(o["order_id"])
        if base.isdigit():
            n = int(base)
            min_vid = n if min_vid is None else min(min_vid, n)
    total_orders = sum(len(v) for v in vid_orders.values())
    print(f"órdenes pendientes: {total_orders}  visualId a matchear: {len(vid_orders)}  min_vid={min_vid}")
    if not vid_orders:
        print("Nada pendiente."); return

    # Recorre la lista de invoices (desc por visualId) hasta pasar min_vid.
    results = {}  # order_id -> (flag, raw)
    tally = {"SI": 0, "NO": 0, "desconocido": 0}
    after, pages, matched = None, 0, 0
    async with httpx.AsyncClient(timeout=40.0) as client:
        while pages < MAX_PAGES:
            conn = await _fetch_page(client, after)
            nodes = conn.get("nodes") or []
            pages += 1
            page_min = None
            for inv in nodes:
                vid = str(inv.get("visualId") or "").strip()
                if vid.isdigit():
                    page_min = int(vid) if page_min is None else min(page_min, int(vid))
                oids = vid_orders.get(vid)
                if not oids:
                    continue
                flag, raw = _sample_signal(inv)
                matched += len(oids)
                if flag is None:
                    tally["desconocido"] += len(oids)
                else:
                    tally[flag] += len(oids)
                    for oid in oids:
                        results[oid] = (flag, raw)
            info = conn.get("pageInfo") or {}
            print(f"  pág {pages}: {len(nodes)} invoices, page_min={page_min}, matcheadas acumuladas={matched}/{total_orders}")
            if not info.get("hasNextPage") or (page_min is not None and min_vid is not None and page_min <= min_vid):
                break
            after = info.get("endCursor")
            await asyncio.sleep(PAGE_DELAY)

    print("\n── Reparto (órdenes) ──")
    print(f"   SI           {tally['SI']}")
    print(f"   NO           {tally['NO']}")
    print(f"   desconocido  {tally['desconocido']}  (no se escriben)")
    print(f"   sin match en Printavo: {total_orders - matched}")

    if not apply:
        print("\nDRY-RUN. Nada escrito. Corre con --apply para estampar.")
        return

    now = datetime.now(timezone.utc).isoformat()
    written = 0
    # agrupa por (flag,raw) para pocos update_many
    for oid, (flag, raw) in results.items():
        res = await db.orders.update_one(
            {"order_id": oid, "sample_printavo": {"$exists": False}},
            {"$set": {"sample_printavo": flag, "sample_printavo_raw": raw,
                      "sample_printavo_backfill_at": now}},
        )
        written += res.modified_count
    print(f"\nAPLICADO: {written} órdenes estampadas (SI/NO). 'desconocido' quedó sin campo.")


if __name__ == "__main__":
    asyncio.run(main(apply="--apply" in sys.argv))
