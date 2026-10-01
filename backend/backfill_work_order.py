# -*- coding: utf-8 -*-
"""Backfill del contenido de WORK ORDER en ordenes historicas.

El sync (printavo_sync._work_order_content) ya guarda, para las ordenes NUEVAS,
las lineas no-prenda del invoice (instrucciones de empaque, approval, shortage,
samples, notes...) en order["work_order"]. Las ordenes creadas ANTES de ese
cambio no lo tienen porque ese dato se descartaba y no vive en Mongo: hay que
re-leerlo de Printavo.

Este script pagina la lista de invoices de Printavo (NO una llamada por invoice
-> respeta el WAF/rate-limit) y, por cada invoice, estampa order["work_order"]
en TODAS las ordenes que comparten su printavo_invoice_id (las hermanas por
color). Solo ACTUALIZA ordenes existentes; nunca crea. Idempotente.

Correr EN EL SERVIDOR (necesita el token de Printavo y MONGO_URL del backend):

    python backfill_work_order.py --pages 40 --delay 1.5
    python backfill_work_order.py --dry-run        # no escribe, solo cuenta

Flags:
    --pages N   maximo de paginas a recorrer (default 40; ~25 invoices/pagina)
    --size N    invoices por pagina (default 25, tope 30 por complejidad)
    --delay S   segundos de espera entre paginas (default 1.5, amable con el WAF)
    --dry-run   no escribe en Mongo, solo reporta cuanto cambiaria
"""
import argparse
import asyncio
from datetime import datetime, timezone

from deps import db, logger
from printavo_client import fetch_invoices_page, is_configured
from printavo_sync import _work_order_content

TRASH = "PAPELERA DE RECICLAJE"


async def run(pages: int, size: int, delay: float, dry_run: bool) -> None:
    if not is_configured():
        print("ERROR: faltan credenciales de Printavo (PRINTAVO_API_EMAIL / PRINTAVO_API_TOKEN).")
        return

    after = None
    seen_invoices = 0
    with_content = 0
    orders_updated = 0
    page_no = 0

    while page_no < pages:
        page_no += 1
        page = await fetch_invoices_page(first=size, after=after)
        nodes = page["nodes"]
        if not nodes:
            break
        seen_invoices += len(nodes)

        for inv in nodes:
            inv_id = inv.get("id")
            if not inv_id:
                continue
            wo = _work_order_content(inv)
            if not wo:
                continue
            with_content += 1
            query = {"printavo_invoice_id": inv_id, "board": {"$ne": TRASH}}
            if dry_run:
                orders_updated += await db.orders.count_documents(query)
            else:
                res = await db.orders.update_many(
                    query,
                    {"$set": {
                        "work_order": wo,
                        "work_order_backfilled_at": datetime.now(timezone.utc).isoformat(),
                    }},
                )
                orders_updated += res.modified_count

        print(f"  pagina {page_no}: {seen_invoices} invoices vistos, "
              f"{with_content} con work order, {orders_updated} ordenes "
              f"{'que cambiarian' if dry_run else 'actualizadas'}...")

        if not page["has_next"]:
            break
        after = page["end_cursor"]
        if after is None:
            break
        await asyncio.sleep(delay)  # amable con el WAF

    modo = "DRY-RUN (no se escribio nada)" if dry_run else "aplicado"
    print(f"\n[{modo}] paginas: {page_no} | invoices: {seen_invoices} | "
          f"con work order: {with_content} | ordenes "
          f"{'afectables' if dry_run else 'actualizadas'}: {orders_updated}")
    logger.info("[backfill_work_order] %s | invoices=%d updated=%d", modo, seen_invoices, orders_updated)


def main() -> None:
    ap = argparse.ArgumentParser(description="Backfill del work order en ordenes historicas.")
    ap.add_argument("--pages", type=int, default=40)
    ap.add_argument("--size", type=int, default=25)
    ap.add_argument("--delay", type=float, default=1.5)
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()
    asyncio.run(run(args.pages, args.size, args.delay, args.dry_run))


if __name__ == "__main__":
    main()
