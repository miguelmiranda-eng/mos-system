"""Módulo de Final Bill: revisión de órdenes ya terminadas de producción.

Sirve la bandeja del encargado de Final Bill. Solo entran las órdenes cuyo
`production_status` es LISTO PARA ENVIO o LISTO PARA INVENTARIO — son las dos
etapas donde la orden ya salió de producción y toca facturarla.

MARCAR "REVISADA" NO MUEVE LA ORDEN
───────────────────────────────────
La revisión se guarda como una BANDERA en la orden (`final_bill_review`), no
como un cambio de `production_status` ni de tablero. Esos dos campos los leen
producción, envíos y el WMS: moverlos desde aquí sacaría la orden de los
tableros de otra gente para resolver un problema que solo es de este módulo.
La bandera es reversible y deja quién y cuándo.

La tercera pestaña filtra POR LA BANDERA, sin mirar el status: una orden ya
revisada sigue en el historial aunque después avance de etapa.
"""
from fastapi import APIRouter, HTTPException, Request
from datetime import datetime, timezone

from deps import db, require_auth, require_admin, log_activity, logger

router = APIRouter(prefix="/api/final-bill")

READY_SHIPPING = "LISTO PARA ENVIO"
READY_INVENTORY = "LISTO PARA INVENTARIO"
TABS = {"envio": READY_SHIPPING, "inventario": READY_INVENTORY}

# Campos que la tabla muestra. `design_#` y `total_amount` van explicados abajo.
PROJECTION = {
    "_id": 0, "order_id": 1, "order_number": 1, "customer_po": 1,
    "cancel_date": 1, "final_bill": 1, "design_#": 1, "desing_#": 1,
    "client": 1, "branding": 1, "quantity": 1, "total_quantity": 1,
    "production_status": 1, "board": 1, "final_bill_review": 1,
    "production_status_at": 1, "invoice": 1,
}

# El orden de la tabla se pide por la LLAVE DE LA COLUMNA, no por el campo de
# Mongo: son distintos (design → `design_#`) y aceptar el campo crudo dejaría
# que cualquiera ordenara por un campo arbitrario del documento.
SORTABLE = {
    "order_number": "order_number",
    "customer_po": "customer_po",
    "cancel_date": "cancel_date",
    "final_bill": "final_bill",
    "design": "design_#",
    "client": "client",
    "branding": "branding",
    "qty": "quantity",
    "status_at": "production_status_at",
    "total_amount": "invoice",
}


def _amount(v):
    """El total facturado como número, o None si la orden no lo tiene.

    En la base hay órdenes con `invoice: null` (creadas antes de la pasada de
    Printavo) y órdenes sin el campo. Las dos deben terminar en None para que
    la columna diga "—" y no arrastren un 0 a la suma de la tarjeta.
    """
    if isinstance(v, bool) or v is None:
        return None
    if isinstance(v, (int, float)):
        return round(float(v), 2)
    try:
        return round(float(str(v).replace("$", "").replace(",", "").strip()), 2)
    except (TypeError, ValueError):
        return None


def _row(o: dict) -> dict:
    """Documento de Mongo → renglón de la tabla.

    · design: hay órdenes con la llave bien escrita (`design_#`) y otras con el
      typo heredado del Monday viejo (`desing_#`). Se leen las dos para no
      dejar el renglón vacío por una falta de ortografía de hace dos años.
    · total_amount: es el campo `invoice` de la orden — el total FACTURADO que
      la pasada de Final Bill de Printavo copia sobre la orden que cruza por
      `order_number == visualId` (printavo_sync.apply_final_bill). NO es la
      colección `invoices`, que tiene 4 documentos sueltos y no cruza con nada.
      Se lee sin convertir: los pocos valores que no son número están en None,
      y un renglón sin facturar debe decir "—", no 0 — cero es una factura de
      cero dólares y eso es un dato distinto de "todavía no se factura".
    """
    rev = o.get("final_bill_review") or {}
    return {
        "order_id": o.get("order_id"),
        "order_number": o.get("order_number"),
        "customer_po": o.get("customer_po") or "",
        "cancel_date": o.get("cancel_date") or "",
        "final_bill": o.get("final_bill") or "",
        "design": o.get("design_#") or o.get("desing_#") or "",
        "client": o.get("client") or "",
        "branding": o.get("branding") or "",
        "qty": o.get("quantity") or o.get("total_quantity") or 0,
        "total_amount": _amount(o.get("invoice")),
        # Cuándo entró la orden a su estado actual. Se sella en orders.py al
        # cambiar el status y se rellenó hacia atrás desde activity_logs
        # (scripts/backfill_production_status_at.py). Vacío = no hay evento
        # registrado; no se sustituye por updated_at, que cualquier edición
        # posterior pisa.
        "status_at": o.get("production_status_at") or "",
        "production_status": o.get("production_status") or "",
        "reviewed": bool(rev.get("reviewed")),
        "reviewed_by_name": rev.get("by_name") or "",
        "reviewed_at": rev.get("at") or "",
    }


def _build_query(tab: str, params: dict) -> dict:
    if tab == "revisadas":
        query: dict = {"final_bill_review.reviewed": True}
    else:
        status = TABS.get(tab)
        if not status:
            raise HTTPException(400, "Pestaña inválida (envio | inventario | revisadas)")
        # Una orden ya revisada sale de las dos primeras pestañas: si se quedara,
        # el encargado la volvería a revisar cada mañana sin saber que ya estaba.
        query = {"production_status": status, "final_bill_review.reviewed": {"$ne": True}}

    search = (params.get("search") or "").strip()
    if search:
        import re as _re
        rx = {"$regex": _re.escape(search), "$options": "i"}
        query["$or"] = [
            {"order_number": rx}, {"customer_po": rx}, {"client": rx},
            {"branding": rx}, {"design_#": rx}, {"store_po": rx},
        ]
    for key, field in (("client", "client"), ("design", "design_#"), ("branding", "branding")):
        val = (params.get(key) or "").strip()
        if val:
            query[field] = val
    # Las fechas viven como texto YYYY-MM-DD, así que la igualdad exacta basta.
    for key, field in (("cancel_date", "cancel_date"), ("final_bill", "final_bill")):
        val = (params.get(key) or "").strip()
        if val:
            query[field] = val
    return query


@router.get("")
async def list_final_bill(
    request: Request,
    tab: str = "envio",
    search: str = "",
    client: str = "",
    design: str = "",
    branding: str = "",
    cancel_date: str = "",
    final_bill: str = "",
    page: int = 1,
    page_size: int = 10,
    sort_by: str = "cancel_date",
    sort_dir: str = "asc",
):
    """Página de la tabla + totales de TODO el filtro (no solo de la página).

    Pagina en el servidor a propósito: son ~1,700 órdenes en estos dos estados
    y bajarlas completas a cada filtro es justo el patrón que ya castigó a otras
    pantallas de este sistema.
    """
    await require_auth(request)
    page = max(1, page)
    page_size = max(1, min(page_size, 200))
    query = _build_query(tab, {
        "search": search, "client": client, "design": design,
        "branding": branding, "cancel_date": cancel_date, "final_bill": final_bill,
    })

    field = SORTABLE.get(sort_by, "cancel_date")
    direction = -1 if str(sort_dir).lower() == "desc" else 1

    total = await db.orders.count_documents(query)
    rows = await db.orders.find(query, PROJECTION) \
        .sort([(field, direction), ("order_number", 1)]) \
        .skip((page - 1) * page_size).limit(page_size).to_list(page_size)

    # Los totales de las tarjetas son de todo el filtro; se calculan en Mongo
    # para no depender de la página que se esté viendo.
    #
    # El monto suma SOLO las órdenes cuyo `invoice` es número. Las que no lo
    # tienen no entran como 0: se cuentan aparte (`amount_orders`) para que la
    # tarjeta pueda decir de cuántas órdenes de las filtradas es esa suma. Sin
    # ese denominador, "$669,856" sobre 1,705 órdenes se lee como el total de
    # todas cuando en realidad es el de 364.
    units = 0
    amount = None
    amount_orders = 0
    async for r in db.orders.aggregate([
        {"$match": query},
        {"$group": {
            "_id": None,
            "u": {"$sum": {"$ifNull": ["$quantity", 0]}},
            "a": {"$sum": {"$cond": [{"$isNumber": "$invoice"}, "$invoice", 0]}},
            "n": {"$sum": {"$cond": [{"$isNumber": "$invoice"}, 1, 0]}},
        }},
    ]):
        units = r.get("u") or 0
        amount_orders = r.get("n") or 0
        # Ninguna orden facturada → None, para que la tarjeta diga "—" en vez
        # de un $0.00 que parecería una suma real de ceros.
        amount = round(float(r.get("a") or 0), 2) if amount_orders else None

    counts = {}
    for key in ("envio", "inventario", "revisadas"):
        counts[key] = await db.orders.count_documents(_build_query(key, {}))

    return {
        "tab": tab,
        "page": page,
        "page_size": page_size,
        "total": total,
        "pages": max(1, -(-total // page_size)),
        "rows": [_row(o) for o in rows],
        "totals": {"orders": total, "units": units,
                   "amount": amount, "amount_orders": amount_orders},
        "tab_counts": counts,
    }


@router.get("/options")
async def final_bill_options(request: Request):
    """Valores para los selects de Cliente / Design / Branding.

    Se sacan SOLO de las órdenes que este módulo puede mostrar: ofrecer los
    ~800 clientes del catálogo completo para filtrar 1,700 órdenes deja al
    encargado eligiendo opciones que no devuelven nada.
    """
    await require_auth(request)
    base = {"$or": [
        {"production_status": {"$in": [READY_SHIPPING, READY_INVENTORY]}},
        {"final_bill_review.reviewed": True},
    ]}
    out = {}
    for key, field in (("clients", "client"), ("designs", "design_#"), ("brandings", "branding")):
        vals = await db.orders.distinct(field, base)
        out[key] = sorted({str(v).strip() for v in vals if v not in (None, "")})
    return out


@router.post("/{order_id}/review")
async def set_review(order_id: str, request: Request):
    """Marca (o desmarca) la orden como revisada por Final Bill.

    Restringido a admin/supersu: es el sello del encargado del módulo y decide
    qué sale de la bandeja de trabajo del resto del equipo.
    """
    user = await require_admin(request)
    body = await request.json()
    reviewed = bool(body.get("reviewed", True))

    order = await db.orders.find_one(
        {"order_id": order_id}, {"_id": 0, "order_number": 1, "final_bill_review": 1}
    )
    if not order:
        raise HTTPException(404, "Orden no encontrada")

    if reviewed:
        update = {"$set": {"final_bill_review": {
            "reviewed": True,
            "by": user.get("user_id"),
            "by_name": user.get("name") or user.get("email") or "",
            "at": datetime.now(timezone.utc).isoformat(),
        }}}
    else:
        # Se borra la bandera completa: dejar `reviewed: False` con el nombre de
        # quien la marcó haría creer que esa persona la reviso y la rechazo.
        update = {"$unset": {"final_bill_review": ""}}

    await db.orders.update_one({"order_id": order_id}, update)
    await log_activity(
        user,
        "final_bill_review" if reviewed else "final_bill_unreview",
        {"order_id": order_id, "order_number": order.get("order_number")},
        previous_data={"final_bill_review": order.get("final_bill_review")},
    )
    logger.info(
        "[final-bill] orden %s %s por %s",
        order.get("order_number"), "revisada" if reviewed else "desmarcada",
        user.get("name"),
    )
    return {"ok": True, "order_id": order_id, "reviewed": reviewed}


@router.post("/review-bulk")
async def set_review_bulk(request: Request):
    """Mismo sello, en lote (la selección con casillas de la tabla)."""
    user = await require_admin(request)
    body = await request.json()
    ids = [str(i) for i in (body.get("order_ids") or []) if str(i).strip()]
    reviewed = bool(body.get("reviewed", True))
    if not ids:
        raise HTTPException(400, "Sin órdenes seleccionadas")

    if reviewed:
        update = {"$set": {"final_bill_review": {
            "reviewed": True,
            "by": user.get("user_id"),
            "by_name": user.get("name") or user.get("email") or "",
            "at": datetime.now(timezone.utc).isoformat(),
        }}}
    else:
        update = {"$unset": {"final_bill_review": ""}}

    res = await db.orders.update_many({"order_id": {"$in": ids}}, update)
    await log_activity(
        user,
        "final_bill_review_bulk" if reviewed else "final_bill_unreview_bulk",
        {"order_ids": ids, "count": res.modified_count},
    )
    return {"ok": True, "modified": res.modified_count, "reviewed": reviewed}
