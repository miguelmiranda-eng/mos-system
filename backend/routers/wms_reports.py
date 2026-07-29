"""Reportes del WMS: recibos, putaway y pick tickets.

Va en su propio archivo y no dentro de routers/wms.py, que ya pasa de 12.000
líneas: son consultas de sólo lectura y no comparten estado con la operación.

Cuatro vistas, cada una respondiendo a una pregunta distinta:
  · pendientes     — ¿a qué hay que correrle hoy?
  · productividad  — ¿cuánto hizo cada quién en un periodo?
  · historial      — ¿qué entró y salió de este cliente / esta orden?
  · excepciones    — ¿dónde se está rompiendo el proceso?

NADA aquí escribe. Los reportes se leen mientras el piso opera, así que una
consulta pesada no debe poder alterar inventario ni bloquear una escritura.

Sobre las fechas: `created_at` se guarda como texto ISO, así que los rangos se
filtran comparando cadenas. El límite superior es el DÍA SIGUIENTE con `$lt`,
no el mismo día con `$lte`: así entra cualquier hora del último día sin importar
si el timestamp trae zona horaria, milisegundos o 'Z'.
"""
from fastapi import APIRouter, HTTPException, Request
from datetime import datetime, timedelta, timezone

from deps import db, require_auth, get_admin_level

router = APIRouter(prefix="/api/wms/reports")

_MOVS_PUTAWAY = ["putaway", "putaway_bulk"]
_TICKET_ABIERTO = {"$nin": ["completed", "cancelled"]}


async def _supervision(request: Request):
    """Un reporte cruza el trabajo de todos los operadores: es material de
    supervisión, no del piso.

    Se incluye a `ceo` explícitamente porque `get_admin_level` le asigna 0 y el
    menú del WMS sí le muestra los módulos `adminOnly` — sin esto vería la
    entrada y recibiría un 403 al abrirla. Todo aquí es de sólo lectura."""
    user = await require_auth(request)
    if user.get("role") == "ceo" or get_admin_level(user) >= 1:
        return user
    raise HTTPException(403, "Los reportes son para supervisión")


def _dia_siguiente(fecha: str) -> str:
    """'2026-07-31' -> '2026-08-01'. Límite superior exclusivo del rango."""
    try:
        d = datetime.strptime(fecha[:10], "%Y-%m-%d") + timedelta(days=1)
        return d.strftime("%Y-%m-%d")
    except ValueError:
        raise HTTPException(400, f"Fecha inválida: {fecha!r} (se espera AAAA-MM-DD)")


def _rango(desde: str, hasta: str, campo: str = "created_at") -> dict:
    """Filtro de rango por fecha. Vacío si no se pidió ninguna."""
    q = {}
    if desde:
        q["$gte"] = desde[:10]
    if hasta:
        q["$lt"] = _dia_siguiente(hasta)
    return {campo: q} if q else {}


def _ahora() -> str:
    return datetime.now(timezone.utc).isoformat()


# ── 1. PENDIENTES — la foto de hoy ───────────────────────────────────────────

@router.get("/pendientes")
async def pendientes(request: Request):
    """Lo que está sin cerrar AHORA: cajas por guardar (con su antigüedad),
    tickets abiertos y vencidos, y lo recibido hoy."""
    await _supervision(request)
    ahora = datetime.now(timezone.utc)
    hoy = ahora.strftime("%Y-%m-%d")

    # Putaway pendiente por antigüedad. Una caja recibida y no guardada es
    # inventario que el sistema cree tener disponible y el piso no encuentra:
    # entre más vieja, peor.
    def _dia_atras(n):
        return (ahora - timedelta(days=n)).strftime("%Y-%m-%d")

    # Los tramos son contiguos y cubren todo, para que la suma cuadre siempre
    # con el total: cada uno abierto por abajo y cerrado por arriba.
    d0, d2, d7 = _dia_atras(0), _dia_atras(2), _dia_atras(7)
    cortes = [("hoy", {"$gte": d0}),
              ("1 a 2 días", {"$gte": d2, "$lt": d0}),
              ("3 a 7 días", {"$gte": d7, "$lt": d2}),
              ("más de 7 días", {"$lt": d7})]
    tramos = []
    for etiqueta, filtro in cortes:
        agg = await db.wms_boxes.aggregate([
            {"$match": {"status": "putaway_pending", "units": {"$gt": 0}, "created_at": filtro}},
            {"$group": {"_id": None, "cajas": {"$sum": 1}, "unidades": {"$sum": "$units"}}},
        ]).to_list(1)
        tramos.append({"tramo": etiqueta,
                       "cajas": int(agg[0]["cajas"]) if agg else 0,
                       "unidades": int(agg[0]["unidades"]) if agg else 0})

    putaway_total = await db.wms_boxes.aggregate([
        {"$match": {"status": "putaway_pending", "units": {"$gt": 0}}},
        {"$group": {"_id": None, "cajas": {"$sum": 1}, "unidades": {"$sum": "$units"}}},
    ]).to_list(1)

    # Las 30 más viejas, para poder ir por ellas.
    viejas = await db.wms_boxes.find(
        {"status": "putaway_pending", "units": {"$gt": 0}},
        {"_id": 0, "box_id": 1, "sku": 1, "style": 1, "color": 1, "size": 1,
         "units": 1, "location": 1, "created_at": 1, "customer": 1},
    ).sort("created_at", 1).to_list(30)

    # Tickets abiertos: los vencidos primero, que son los que duelen.
    abiertos = await db.wms_pick_tickets.find(
        {"status": _TICKET_ABIERTO},
        {"_id": 0, "ticket_id": 1, "order_number": 1, "customer": 1, "style": 1,
         "total_pick_qty": 1, "status": 1, "picking_status": 1, "assigned_to_name": 1,
         "created_at": 1, "sla_deadline": 1},
    ).sort("sla_deadline", 1).to_list(500)
    ahora_iso = _ahora()
    vencidos = [t for t in abiertos if (t.get("sla_deadline") or "") and t["sla_deadline"] < ahora_iso]
    sin_asignar = [t for t in abiertos if not t.get("assigned_to_name")]

    recibos_hoy = await db.wms_receiving.aggregate([
        {"$match": {"created_at": {"$gte": hoy}}},
        {"$group": {"_id": None, "recibos": {"$sum": 1}, "unidades": {"$sum": "$total_units"}}},
    ]).to_list(1)

    return {
        "generado": ahora_iso,
        "putaway": {
            "cajas": int(putaway_total[0]["cajas"]) if putaway_total else 0,
            "unidades": int(putaway_total[0]["unidades"]) if putaway_total else 0,
            "por_antiguedad": tramos,
            "mas_viejas": viejas,
        },
        "picking": {
            "abiertos": len(abiertos),
            "vencidos": len(vencidos),
            "sin_asignar": len(sin_asignar),
            "tickets": abiertos[:100],
        },
        "recibos_hoy": {
            "recibos": int(recibos_hoy[0]["recibos"]) if recibos_hoy else 0,
            "unidades": int(recibos_hoy[0]["unidades"]) if recibos_hoy else 0,
        },
    }


# ── 2. PRODUCTIVIDAD — cuánto hizo cada quién ────────────────────────────────

@router.get("/productividad")
async def productividad(request: Request, desde: str = "", hasta: str = "", operador: str = ""):
    """Recibos, putaway y picking por operador en un rango, más la serie diaria."""
    await _supervision(request)
    rec_q = _rango(desde, hasta)
    if operador:
        rec_q["received_by_name"] = operador

    recibos = await db.wms_receiving.aggregate([
        {"$match": rec_q},
        {"$group": {"_id": "$received_by_name", "recibos": {"$sum": 1},
                    "unidades": {"$sum": "$total_units"}}},
    ]).to_list(500)

    mov_q = {**_rango(desde, hasta), "type": {"$in": _MOVS_PUTAWAY}}
    if operador:
        mov_q["user_name"] = operador
    # putaway_bulk guarda cuántas cajas movió en details.count; el putaway de a
    # una no trae contador, así que cuenta como 1.
    putaway = await db.wms_movements.aggregate([
        {"$match": mov_q},
        {"$group": {"_id": "$user_name", "eventos": {"$sum": 1},
                    "cajas": {"$sum": {"$ifNull": ["$details.count", 1]}}}},
    ]).to_list(500)

    tk_q = {**_rango(desde, hasta, "completed_at"), "status": "completed"}
    if operador:
        tk_q["assigned_to_name"] = operador
    picking = await db.wms_pick_tickets.aggregate([
        {"$match": tk_q},
        {"$group": {"_id": "$assigned_to_name", "tickets": {"$sum": 1},
                    "unidades": {"$sum": {"$ifNull": ["$total_pick_qty", 0]}}}},
    ]).to_list(500)

    # Una fila por persona, aunque sólo aparezca en una de las tres actividades.
    filas = {}

    def _fila(nombre):
        n = (nombre or "").strip() or "(sin nombre)"
        return filas.setdefault(n, {"operador": n, "recibos": 0, "unidades_recibidas": 0,
                                    "putaway_eventos": 0, "putaway_cajas": 0,
                                    "tickets": 0, "unidades_surtidas": 0})

    for r in recibos:
        f = _fila(r["_id"]); f["recibos"] = r["recibos"]; f["unidades_recibidas"] = int(r["unidades"] or 0)
    for p in putaway:
        f = _fila(p["_id"]); f["putaway_eventos"] = p["eventos"]; f["putaway_cajas"] = int(p["cajas"] or 0)
    for t in picking:
        f = _fila(t["_id"]); f["tickets"] = t["tickets"]; f["unidades_surtidas"] = int(t["unidades"] or 0)

    dias = {}
    for coll, campo, clave in ((db.wms_receiving, "created_at", "recibos"),
                               (db.wms_pick_tickets, "completed_at", "tickets")):
        q = {**_rango(desde, hasta, campo)}
        if coll is db.wms_pick_tickets:
            q["status"] = "completed"
        for d in await coll.aggregate([
            {"$match": q},
            {"$group": {"_id": {"$substr": [f"${campo}", 0, 10]}, "n": {"$sum": 1}}},
        ]).to_list(400):
            if d["_id"]:
                dias.setdefault(d["_id"], {"dia": d["_id"], "recibos": 0, "tickets": 0})[clave] = d["n"]

    return {
        "desde": desde, "hasta": hasta, "operador": operador,
        "operadores": sorted(filas.values(),
                             key=lambda f: -(f["recibos"] + f["tickets"] + f["putaway_eventos"])),
        "por_dia": sorted(dias.values(), key=lambda d: d["dia"]),
    }


# ── 3. HISTORIAL — qué entró y qué salió ─────────────────────────────────────

@router.get("/historial")
async def historial(request: Request, desde: str = "", hasta: str = "",
                    customer: str = "", orden: str = "", style: str = "", limit: int = 2000):
    """Recibos y pick tickets del periodo, filtrables por cliente, orden o estilo."""
    await _supervision(request)
    limit = max(1, min(limit, 5000))

    rec_q = _rango(desde, hasta)
    if customer:
        rec_q["customer"] = {"$regex": f"^{customer}", "$options": "i"}
    if style:
        rec_q["style"] = {"$regex": f"^{style}", "$options": "i"}
    if orden:
        # Los recibos no llevan nº de orden propio: el vínculo es el ASN.
        rec_q["asn_reference"] = {"$regex": orden, "$options": "i"}
    recibos = await db.wms_receiving.find(rec_q, {
        "_id": 0, "receiving_id": 1, "created_at": 1, "customer": 1, "manufacturer": 1,
        "style": 1, "color": 1, "size": 1, "total_units": 1, "received_by_name": 1,
        "asn_reference": 1, "lot_number": 1, "country_of_origin": 1, "inv_location": 1,
    }).sort("created_at", -1).to_list(limit)

    tk_q = _rango(desde, hasta)
    if customer:
        tk_q["customer"] = {"$regex": f"^{customer}", "$options": "i"}
    if style:
        tk_q["style"] = {"$regex": f"^{style}", "$options": "i"}
    if orden:
        tk_q["order_number"] = {"$regex": orden, "$options": "i"}
    tickets = await db.wms_pick_tickets.find(tk_q, {
        "_id": 0, "ticket_id": 1, "order_number": 1, "customer": 1, "style": 1, "color": 1,
        "total_pick_qty": 1, "status": 1, "assigned_to_name": 1, "created_at": 1,
        "completed_at": 1, "destination": 1,
    }).sort("created_at", -1).to_list(limit)

    return {
        "recibos": recibos,
        "tickets": tickets,
        "totales": {
            "recibos": len(recibos),
            "unidades_recibidas": sum(int(r.get("total_units") or 0) for r in recibos),
            "tickets": len(tickets),
            "unidades_surtidas": sum(int(t.get("total_pick_qty") or 0) for t in tickets
                                     if t.get("status") == "completed"),
        },
    }


# ── 4. EXCEPCIONES — dónde se rompe el proceso ───────────────────────────────

@router.get("/excepciones")
async def excepciones(request: Request, desde: str = "", hasta: str = "", limit: int = 1000):
    """Recibos forzados y tickets fuera de SLA.

    Cada excepción se autoriza en el momento por una razón válida; el problema
    es cuando se vuelven costumbre. Por eso se listan juntas y con quién las
    autorizó."""
    await _supervision(request)
    limit = max(1, min(limit, 5000))
    rango = _rango(desde, hasta)

    forzados = await db.wms_receiving.find({
        **rango,
        "$or": [{"duplicate_forced": True}, {"upc_required_bypass": True},
                {"tolerance_override": {"$exists": True, "$ne": None}}],
    }, {
        "_id": 0, "receiving_id": 1, "created_at": 1, "customer": 1, "style": 1, "color": 1,
        "size": 1, "total_units": 1, "received_by_name": 1, "asn_reference": 1,
        "duplicate_forced": 1, "upc_required_bypass": 1, "tolerance_override": 1,
    }).sort("created_at", -1).to_list(limit)

    for r in forzados:
        tipos = []
        if r.get("duplicate_forced"):
            tipos.append("recibo duplicado forzado")
        if r.get("upc_required_bypass"):
            tipos.append("sin UPC (cliente lo exige)")
        if r.get("tolerance_override"):
            tipos.append("fuera de tolerancia")
        r["excepcion"] = " · ".join(tipos)

    ahora_iso = _ahora()
    # Fuera de SLA: se completó después del plazo, o sigue abierto y ya venció.
    tarde = await db.wms_pick_tickets.find({
        **rango, "sla_deadline": {"$exists": True, "$ne": None},
        "$or": [
            {"status": "completed", "$expr": {"$gt": ["$completed_at", "$sla_deadline"]}},
            {"status": _TICKET_ABIERTO, "sla_deadline": {"$lt": ahora_iso}},
        ],
    }, {
        "_id": 0, "ticket_id": 1, "order_number": 1, "customer": 1, "style": 1,
        "total_pick_qty": 1, "status": 1, "assigned_to_name": 1, "created_at": 1,
        "completed_at": 1, "sla_deadline": 1,
    }).sort("sla_deadline", 1).to_list(limit)

    for t in tarde:
        t["situacion"] = ("completado tarde" if t.get("status") == "completed"
                          else "vencido sin completar")

    por_persona = {}
    for r in forzados:
        n = (r.get("received_by_name") or "").strip() or "(sin nombre)"
        por_persona.setdefault(n, {"persona": n, "recibos_forzados": 0, "tickets_tarde": 0})
        por_persona[n]["recibos_forzados"] += 1
    for t in tarde:
        n = (t.get("assigned_to_name") or "").strip() or "(sin asignar)"
        por_persona.setdefault(n, {"persona": n, "recibos_forzados": 0, "tickets_tarde": 0})
        por_persona[n]["tickets_tarde"] += 1

    return {
        "recibos_forzados": forzados,
        "tickets_fuera_sla": tarde,
        "por_persona": sorted(por_persona.values(),
                              key=lambda p: -(p["recibos_forzados"] + p["tickets_tarde"])),
        "totales": {"recibos_forzados": len(forzados), "tickets_fuera_sla": len(tarde)},
    }
