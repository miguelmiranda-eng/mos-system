"""Invitado shipping: vista de Envíos programados para un proveedor externo.

El proveedor (rol `shipping_guest`) ve TODAS las órdenes programadas (todo el
historial, decisión 2026-10-07) y sólo puede llenar SHIPPING FROM y CARRIER.

Seguridad (decisión 2026-10-07):
  - deps.get_current_user le NIEGA al rol cualquier ruta fuera de
    deps.GUEST_SURFACE (default-deny): casi todo MOS sólo pide sesión, así que
    esconder pantallas no bastaría.
  - Estos endpoints devuelven sólo las columnas de la fila del programador
    (sin enlaces al packing, notas internas de la orden, bulk ni cantidades
    embarcadas del WMS).
  - Cada cambio queda en la bitácora de Movimientos con el nombre del invitado.
  - supersu también puede usarlos (para revisar lo que ve el proveedor).

  GET "/lines"          → exports + líneas (todo el historial)
  PUT "/lines/{id}"     → {ship_from?, carrier?}
"""
from datetime import datetime, timezone

from fastapi import APIRouter, Request, HTTPException

from deps import db, require_auth, log_activity, SHIPPING_GUEST_ROLE
from services import shipping_journal as jr
from routers.scheduled_shipments import _rows, _export_out, _derive_shipping_no, _txt

router = APIRouter(prefix="/api/guest-shipping", tags=["guest-shipping"])

GUEST_EDITABLE = {"ship_from": "SHIPPING FROM", "carrier": "CARRIER"}
LINE_FIELDS = ("shipment_id", "export_id", "ship_date", "position", "order_number", "client", "branding",
               "customer_po", "design_num", "pcs", "status_effective", "priority", "ship_notes",
               "delivery_to", "ship_from", "carrier", "late", "cancel_date")
EXPORT_FIELDS = ("export_id", "date", "position", "export_no", "shipping_no", "pl_numbers", "truck",
                 "cutoff_time", "export_time")


async def _require_guest(request: Request) -> dict:
    user = await require_auth(request)
    if user.get("role") not in (SHIPPING_GUEST_ROLE, "supersu"):
        raise HTTPException(status_code=403, detail="Vista exclusiva del invitado shipping")
    return user


def _line_out(r: dict) -> dict:
    return {k: r.get(k) for k in LINE_FIELDS}


@router.get("/lines")
async def guest_lines(request: Request):
    await _require_guest(request)
    exports = await db.shipping_exports.find(
        {}, {"_id": 0},
    ).sort([("date", 1), ("position", 1), ("created_at", 1)]).to_list(1000)
    ids = [e["export_id"] for e in exports]
    scheds = await db.scheduled_shipments.find(
        {"export_id": {"$in": ids}}, {"_id": 0},
    ).sort([("position", 1), ("created_at", 1)]).to_list(5000) if ids else []
    rows = await _rows(scheds)
    exp_out = [_export_out(e) for e in exports]
    await _derive_shipping_no(exports, exp_out)
    return {
        "exports": [{k: e.get(k) for k in EXPORT_FIELDS} for e in exp_out],
        "lines": [_line_out(r) for r in rows],
    }


@router.put("/lines/{shipment_id}")
async def guest_update_line(shipment_id: str, request: Request):
    user = await _require_guest(request)
    body = await request.json()
    extra = set(body or {}) - set(GUEST_EDITABLE)
    if extra or not body:
        raise HTTPException(status_code=400, detail="Sólo se pueden editar SHIPPING FROM y CARRIER")
    before = await db.scheduled_shipments.find_one({"shipment_id": shipment_id}, {"_id": 0})
    if not before or not before.get("export_id"):
        raise HTTPException(status_code=404, detail="Orden programada no encontrada")
    upd = {k: _txt(body[k], 120) for k in GUEST_EDITABLE if k in body}
    cambios = [f"{GUEST_EDITABLE[k]} {jr.val(before.get(k))} → {jr.val(v)}"
               for k, v in upd.items() if (before.get(k) or None) != v]
    if cambios:
        upd["updated_at"] = datetime.now(timezone.utc).isoformat()
        await db.scheduled_shipments.update_one({"shipment_id": shipment_id}, {"$set": upd})
        after = await db.scheduled_shipments.find_one({"shipment_id": shipment_id}, {"_id": 0})
        await log_activity(user, "guest_update_shipping_line",
                           {"shipment_id": shipment_id, "order_number": before.get("order_number"), **upd})
        await jr.record(user, "lines_update", f"#{before.get('order_number')}: {' · '.join(cambios)}",
                        lines=[(shipment_id, before, after)])
    else:
        after = before
    return _line_out((await _rows([after]))[0])
