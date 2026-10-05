"""Surtido por orden: cajas de surtido en tránsito / OM / entregadas a piso.

La lógica vive en services/staging.py (ahí está el porqué del modelo). Este
router es la puerta HTTP: listar, buscar, guardar en OM, entregar a piso y la
configuración de ubicaciones.
"""
import re

from fastapi import APIRouter, HTTPException, Request

from deps import db, require_auth
from routers.wms import require_action
from services import staging

router = APIRouter(prefix="/api/wms/staging")


def _http(e: staging.StagingError):
    return HTTPException(e.status, e.detail)


@router.get("/config")
async def staging_config_get(request: Request):
    """Config vigente + las ubicaciones dadas de alta que caen en los destinos."""
    await require_auth(request)
    cfg = await staging.get_cfg()
    return {**cfg, "destination_locations": await staging.destination_locations(cfg)}


@router.put("/config")
async def staging_config_put(request: Request):
    user = await require_action(request, "staging.config")
    body = await request.json()
    try:
        cfg = await staging.save_cfg(body, user)
    except ValueError as e:
        raise HTTPException(400, str(e))
    from routers.wms import log_activity
    await log_activity(user, "wms_staging_config_update", cfg)
    return {**cfg, "destination_locations": await staging.destination_locations(cfg)}


@router.get("")
async def staging_list(request: Request, q: str = "", location: str = ""):
    """Cajas de surtido vivas (tránsito + guardadas), con resumen por orden y
    por ubicación. `q` filtra por orden, caja SRT, estilo o color."""
    await require_auth(request)
    await staging.auto_issue_closed_orders()
    match = {"status": {"$in": list(staging.LIVE)}}
    loc = (location or "").strip().upper()
    if loc:
        match["location"] = loc
    qq = (q or "").strip()
    if qq:
        rx = {"$regex": re.escape(qq), "$options": "i"}
        match["$or"] = [{"order_number": rx}, {"staged_id": rx}, {"style": rx}, {"color": rx}]
    boxes = await db[staging.COLL].find(match, {"_id": 0, "origins": 0, "history": 0}) \
        .sort([("order_number", 1), ("style", 1), ("color", 1), ("size", 1)]).to_list(5000)

    by_order, by_loc = {}, {}
    for b in boxes:
        o = by_order.setdefault(b.get("order_number") or "", {
            "order_number": b.get("order_number") or "", "customer": b.get("customer", ""),
            "boxes": 0, "units": 0, "transit_units": 0, "locations": set()})
        o["boxes"] += 1
        o["units"] += int(b.get("units") or 0)
        if b.get("status") == staging.TRANSIT:
            o["transit_units"] += int(b.get("units") or 0)
        o["locations"].add(b.get("location"))
        lc = by_loc.setdefault(b.get("location"), {"location": b.get("location"), "boxes": 0,
                                                   "units": 0, "orders": set()})
        lc["boxes"] += 1
        lc["units"] += int(b.get("units") or 0)
        lc["orders"].add(b.get("order_number") or "")

    # Estado CRM de cada orden: ayuda a decidir qué entregar primero y marca
    # las canceladas (ese material hay que regresarlo al almacén).
    nums = [n for n in by_order if n]
    crm = {d["order_number"]: d async for d in db.orders.find(
        {"order_number": {"$in": nums}},
        {"_id": 0, "order_number": 1, "board": 1, "blank_status": 1, "production_status": 1, "branding": 1})}
    orders = []
    for n, o in by_order.items():
        c = crm.get(n, {})
        orders.append({**o, "locations": sorted(x for x in o["locations"] if x),
                       "board": c.get("board"), "blank_status": c.get("blank_status"),
                       "production_status": c.get("production_status"), "branding": c.get("branding")})
    orders.sort(key=lambda x: x["order_number"])
    locations = sorted(({**v, "orders": sorted(v["orders"])} for v in by_loc.values()),
                       key=lambda x: x["location"] or "")
    cfg = await staging.get_cfg()
    return {"boxes": boxes, "orders": orders, "locations": locations,
            "totals": {"boxes": len(boxes), "units": sum(int(b.get("units") or 0) for b in boxes)},
            "transit": cfg["transit"], "destination_locations": await staging.destination_locations(cfg)}


@router.get("/lookup")
async def staging_lookup(request: Request, code: str):
    """Resuelve un escaneo: caja de surtido (cualquier estado) o ubicación."""
    await require_auth(request)
    c = (code or "").strip().upper()
    if not c:
        raise HTTPException(400, "code requerido")
    box = await db[staging.COLL].find_one({"staged_id": c}, {"_id": 0, "origins": 0})
    if box:
        return {"kind": "box", "box": box}
    cfg = await staging.get_cfg()
    if staging.is_destination(cfg, c) or staging.is_transit(cfg, c):
        boxes = await db[staging.COLL].find(
            {"location": c, "status": {"$in": list(staging.LIVE)}},
            {"_id": 0, "origins": 0, "history": 0}).to_list(2000)
        return {"kind": "location", "location": c, "is_transit": staging.is_transit(cfg, c), "boxes": boxes}
    raise HTTPException(404, f"{c} no es una caja de surtido ni una ubicación de surtido")


@router.get("/order/{order_number}")
async def staging_order(order_number: str, request: Request):
    """Todo el surtido de una orden, incluido lo ya entregado a piso."""
    await require_auth(request)
    boxes = await db[staging.COLL].find({"order_number": str(order_number)}, {"_id": 0, "origins": 0}) \
        .sort([("style", 1), ("color", 1), ("size", 1)]).to_list(2000)
    return {"order_number": str(order_number), "boxes": boxes}


@router.post("/store")
async def staging_store(request: Request):
    """Body: {staged_ids: [...], location: "OM-A12"}."""
    user = await require_action(request, "staging.operate")
    body = await request.json()
    try:
        return await staging.store(user=user, staged_ids=body.get("staged_ids") or [],
                                   location=body.get("location") or "")
    except staging.StagingError as e:
        raise _http(e)


@router.post("/issue")
async def staging_issue(request: Request):
    """Entregar a piso. Body: {staged_ids: [...]}."""
    user = await require_action(request, "staging.operate")
    body = await request.json()
    try:
        return await staging.issue(user=user, staged_ids=body.get("staged_ids") or [])
    except staging.StagingError as e:
        raise _http(e)
