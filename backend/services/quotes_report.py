"""2o reporte programado: QUOTES de Printavo pendientes de MOS.

Lista los quotes (cotizaciones) de Printavo creados en los últimos N días cuyo
visualId AÚN no existe en MOS como orden (`db.orders.order_number`). El sync de
MOS solo crea órdenes desde invoices "Scheduled" y nunca toca la lista de
quotes, así que esto es la visibilidad de ese pipeline previo a producción.

Se adjunta (Excel) al correo diario del reporte de producción
(report_scheduler._generate_and_send). Comparte horario y destinatarios.

WAF/rate-limit (token compartido con el sync de prod): se PAGINA la lista de
quotes (una llamada por ~25), nunca una por quote; se corta al salir de la
ventana de N días. Si Printavo no está configurado, devuelve None (no adjunta).
"""
import base64
import io
from datetime import datetime, timezone, timedelta

from deps import db, logger
import printavo_client

MAX_PAGES = 40  # 40 × 25 = hasta 1000 quotes; tope de seguridad


async def _existing_order_bases() -> set:
    """Bases de order_number ya en MOS ('3210-2' -> '3210'). Un quote cuyo
    visualId caiga aquí ya se convirtió/creó, no va al reporte."""
    bases = set()
    async for o in db.orders.find({}, {"_id": 0, "order_number": 1}):
        base = str(o.get("order_number") or "").split("-")[0].strip()
        if base:
            bases.add(base)
    return bases


def _pieces(node: dict) -> int:
    total = 0
    for g in ((node.get("lineItemGroups") or {}).get("nodes") or []):
        for li in ((g.get("lineItems") or {}).get("nodes") or []):
            sizes = li.get("sizes") or []
            if sizes:
                total += sum(int(s.get("count") or 0) for s in sizes)
            else:
                try:
                    total += int(li.get("items") or 0)
                except (TypeError, ValueError):
                    pass
    return total


async def build_pending_quotes_report(days: int = 30):
    """Devuelve {data(b64), content_type, filename, count} o None si Printavo no
    está configurado."""
    if not printavo_client.is_configured():
        logger.info("[quotes-report] Printavo no configurado; omito el 2o reporte")
        return None

    cutoff_date = (datetime.now(timezone.utc) - timedelta(days=days)).date().isoformat()
    existing = await _existing_order_bases()

    rows, after, pages = [], None, 0
    while pages < MAX_PAGES:
        page = await printavo_client.fetch_quotes_page(first=25, after=after)
        nodes = page.get("nodes") or []
        stop = False
        for n in nodes:
            created = str(n.get("createdAt") or "")
            if created and created[:10] < cutoff_date:
                stop = True  # viene desc por visualId (≈ por fecha): más viejos -> cortar
                continue
            vid = str(n.get("visualId") or "").strip()
            if not vid or vid.split("-")[0] in existing:
                continue  # ya está en MOS como orden
            contact = n.get("contact") or {}
            cust = contact.get("customer") or {}
            rows.append({
                "visual": vid,
                "cliente": cust.get("companyName") or contact.get("fullName") or "",
                "nombre": n.get("nickname") or "",
                "creado": created[:10],
                "due": str(n.get("customerDueAt") or n.get("dueAt") or "")[:10],
                "total": n.get("total") or 0,
                "piezas": _pieces(n),
                "status": ((n.get("status") or {}).get("name") or ""),
                "url": n.get("url") or "",
            })
        pages += 1
        if stop or not page.get("has_next"):
            break
        after = page.get("end_cursor")
        if not after:
            break

    rows.sort(key=lambda r: r["creado"], reverse=True)
    logger.info(f"[quotes-report] {len(rows)} quotes pendientes de MOS (últimos {days}d, {pages} páginas)")
    return _to_excel(rows, days)


def _to_excel(rows, days):
    import xlsxwriter
    out = io.BytesIO()
    wb = xlsxwriter.Workbook(out, {"in_memory": True})
    ws = wb.add_worksheet("QUOTES PENDIENTES")
    f_title = wb.add_format({"bold": True, "size": 14})
    f_hdr = wb.add_format({"bold": True, "bg_color": "#1f2937", "font_color": "white", "border": 1})
    f_cell = wb.add_format({"border": 1})
    f_num = wb.add_format({"border": 1, "num_format": "#,##0"})
    f_money = wb.add_format({"border": 1, "num_format": "$#,##0.00"})

    ws.write(0, 0, f"Quotes en Printavo sin orden en MOS — últimos {days} días ({len(rows)})", f_title)
    cols = [("#", 11), ("Cliente", 30), ("Nombre", 26), ("Creado", 12),
            ("Due", 12), ("Total", 14), ("Piezas", 10), ("Status", 14), ("URL", 42)]
    for i, (h, w) in enumerate(cols):
        ws.write(2, i, h, f_hdr)
        ws.set_column(i, i, w)
    for r, q in enumerate(rows, 3):
        ws.write(r, 0, q["visual"], f_cell)
        ws.write(r, 1, q["cliente"], f_cell)
        ws.write(r, 2, q["nombre"], f_cell)
        ws.write(r, 3, q["creado"], f_cell)
        ws.write(r, 4, q["due"], f_cell)
        try:
            ws.write_number(r, 5, float(q["total"] or 0), f_money)
        except (TypeError, ValueError):
            ws.write(r, 5, q["total"], f_cell)
        ws.write_number(r, 6, int(q["piezas"] or 0), f_num)
        ws.write(r, 7, q["status"], f_cell)
        ws.write(r, 8, q["url"], f_cell)
    wb.close()
    out.seek(0)
    ts = datetime.now().strftime("%Y%m%d_%H%M")
    return {
        "data": base64.b64encode(out.read()).decode(),
        "content_type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "filename": f"QUOTES_PENDIENTES_MOS_{ts}.xlsx",
        "count": len(rows),
    }
