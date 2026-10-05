"""Resurtido: reponer piezas sobre el MISMO pick ticket.

EL HUECO QUE LLENA
Cuando producción se queda corta (piezas dañadas, merma, error de conteo, un
resize que cambia tallas), la única salida era crear OTRO pick ticket para la
misma orden — 360 combinaciones orden+style+color con más de un ticket al
2026-10-05 — o la "reposición" de Reportar incidencia, que descontaba por FIFO
ciego desde el escritorio, sin que nadie fuera al rack ni escaneara caja.

EL MODELO
Un resurtido es una RONDA del ticket original: un ticket hijo con id
"<padre>-R<n>" (pick_ab12-R1, -R2…). Para el picker es un ticket más en su
PDA — mismo escaneo de caja, mismas reglas, sin FIFO — y para la operación es
el mismo ticket: el hijo apunta al padre y el padre lleva el resumen de sus
rondas. Por qué hijo y no rondas dentro del documento: el flujo de surtido
(pick-size / pick-boxes / pick-progress / confirm) es el código más delicado
del WMS; un ticket hijo lo reutiliza intacto en lugar de enseñarle rondas.

REGLAS (decisión del usuario 2026-10-05)
  · Pedirlo: acción picking.resupply (default admin nivel 3).
  · Si lo resurtido acumulado del ticket pasa del umbral (default 10 % de lo
    pedido originalmente), solo picking.resupply_over (default admin nivel 5).
  · Se pueden pedir tallas que el ticket no traía (resize).
  · Motivos configurables (config_options.wms_resupply).

CONTABILIDAD
Lo resurtido SÍ sale del inventario y SÍ genera su caja de surtido para la
orden, pero sus `pick_deduction` llevan `resupply: true` y NO cuentan como
embarcado ni como empaque: reponen piezas que se perdieron, no son más pedido.
"""
from __future__ import annotations

import re
import time

from deps import db

CONFIG_ID = "wms_resupply"
DEFAULT_CFG = {
    "reasons": ["Faltante en producción", "Dañado", "Merma", "Error de conteo", "Resize"],
    "threshold_pct": 10,
}
_RID = re.compile(r"-R\d+$")
_CACHE = {"cfg": None, "at": 0.0}
_TTL = 60.0


class ResupplyError(Exception):
    def __init__(self, status: int, detail):
        super().__init__(str(detail))
        self.status = status
        self.detail = detail


def _now():
    from datetime import datetime, timezone
    return datetime.now(timezone.utc).isoformat()


def is_resupply_id(ticket_id) -> bool:
    return bool(ticket_id) and bool(_RID.search(str(ticket_id)))


def normalize_cfg(raw: dict) -> dict:
    reasons = []
    for r in raw.get("reasons") or []:
        r = " ".join(str(r or "").split())
        if r and r.upper() not in {x.upper() for x in reasons}:
            reasons.append(r)
    if not reasons:
        raise ValueError("Debe haber al menos un motivo de resurtido")
    try:
        pct = float(raw.get("threshold_pct", DEFAULT_CFG["threshold_pct"]))
    except (TypeError, ValueError):
        raise ValueError("El umbral debe ser un número")
    if not 0 <= pct <= 100:
        raise ValueError("El umbral debe estar entre 0 y 100 %")
    return {"reasons": reasons, "threshold_pct": pct}


async def get_cfg(force: bool = False) -> dict:
    c = _CACHE
    if not force and c["cfg"] is not None and time.monotonic() - c["at"] < _TTL:
        return c["cfg"]
    doc = await db.config_options.find_one({"config_id": CONFIG_ID}, {"_id": 0}) or {}
    try:
        cfg = normalize_cfg({**DEFAULT_CFG, **{k: doc[k] for k in DEFAULT_CFG if k in doc}})
    except ValueError:
        cfg = normalize_cfg(DEFAULT_CFG)
    c.update({"cfg": cfg, "at": time.monotonic()})
    return cfg


async def save_cfg(raw: dict, user: dict) -> dict:
    cfg = normalize_cfg(raw)
    await db.config_options.update_one(
        {"config_id": CONFIG_ID},
        {"$set": {**cfg, "updated_at": _now(), "updated_by": user.get("email")}}, upsert=True)
    _CACHE["cfg"] = None
    return await get_cfg(force=True)


def _is_closed(t: dict) -> bool:
    from wms_constants import TICKET_CLOSED_STATUSES, PickingStatus, TicketStatus
    return (t.get("status") in [*TICKET_CLOSED_STATUSES, TicketStatus.IN_NECK_CUTTING]
            or t.get("picking_status") == PickingStatus.COMPLETED)


def _norm_sizes(sizes: dict) -> dict:
    out = {}
    for k, v in (sizes or {}).items():
        k = str(k or "").strip().upper()
        try:
            q = int(v or 0)
        except (TypeError, ValueError):
            raise ResupplyError(400, f"Cantidad inválida para la talla {k}")
        if q < 0:
            raise ResupplyError(400, f"Cantidad negativa para la talla {k}")
        if k and q > 0:
            out[k] = out.get(k, 0) + q
    return out


def _base_qty(parent: dict) -> int:
    base = sum(int(v or 0) for v in (parent.get("sizes") or {}).values())
    return base or int(parent.get("total_pick_qty") or parent.get("quantity") or 0)


async def rounds_of(parent_id: str) -> list:
    return await db.wms_pick_tickets.find(
        {"parent_ticket_id": parent_id}, {"_id": 0}).sort("resupply_round", 1).to_list(100)


async def preview(parent_id: str, sizes: dict) -> dict:
    """Cuánto representa este resurtido (acumulado) sobre lo pedido."""
    parent = await db.wms_pick_tickets.find_one({"ticket_id": parent_id}, {"_id": 0})
    if not parent:
        raise ResupplyError(404, "Pick ticket no encontrado")
    cfg = await get_cfg()
    prior = sum(int(r.get("total_pick_qty") or 0) for r in await rounds_of(parent_id)
                if r.get("status") != "cancelled")
    new = sum(_norm_sizes(sizes).values())
    base = _base_qty(parent)
    pct = round((prior + new) * 100.0 / base, 1) if base else 100.0
    return {"base": base, "prior": prior, "new": new, "pct": pct,
            "threshold_pct": cfg["threshold_pct"], "over": pct > cfg["threshold_pct"]}


async def create_round(*, user: dict, parent_id: str, sizes: dict, reason: str, notes: str = "",
                       assigned_to: str = "", assigned_to_name: str = "", can_over: bool = False) -> dict:
    from routers.wms import internal_create_picking_ticket, log_movement
    from wms_constants import TICKET_OPEN_QUERY

    parent = await db.wms_pick_tickets.find_one({"ticket_id": parent_id}, {"_id": 0})
    if not parent:
        raise ResupplyError(404, "Pick ticket no encontrado")
    if parent.get("parent_ticket_id"):
        raise ResupplyError(400, f"Pide el resurtido sobre el ticket original ({parent['parent_ticket_id']})")
    if parent.get("status") == "cancelled":
        raise ResupplyError(409, "El ticket está cancelado")
    if not _is_closed(parent):
        raise ResupplyError(409, "El ticket aún no termina de surtirse: agrega las piezas en el mismo surtido")
    sizes = _norm_sizes(sizes)
    if not sizes:
        raise ResupplyError(400, "Captura al menos una talla con cantidad")
    cfg = await get_cfg()
    reason = " ".join(str(reason or "").split())
    if reason.upper() not in {r.upper() for r in cfg["reasons"]}:
        raise ResupplyError(400, f"Motivo inválido. Opciones: {', '.join(cfg['reasons'])}")
    abierta = await db.wms_pick_tickets.find_one(
        {"parent_ticket_id": parent_id, **TICKET_OPEN_QUERY}, {"_id": 0, "ticket_id": 1})
    if abierta:
        raise ResupplyError(409, f"Ya hay un resurtido abierto para este ticket ({abierta['ticket_id']}): termínalo o cancélalo primero")

    pv = await preview(parent_id, sizes)
    if pv["over"] and not can_over:
        raise ResupplyError(403, (
            f"El resurtido acumulado sería {pv['pct']}% de lo pedido ({pv['prior'] + pv['new']} de "
            f"{pv['base']} pz) y pasa del {cfg['threshold_pct']:g}%: solo lo puede autorizar admin nivel 5"))

    n = await db.wms_pick_tickets.count_documents({"parent_ticket_id": parent_id}) + 1
    child_id = f"{parent_id}-R{n}"
    total = sum(sizes.values())
    data = {
        "order_number": parent.get("order_number", ""), "customer": parent.get("customer", ""),
        "client": parent.get("client", ""), "manufacturer": parent.get("manufacturer", ""),
        "style": parent.get("style", ""), "color": parent.get("color", ""),
        "quantity": total, "sizes": sizes, "board_category": parent.get("board_category", "UNSET"),
        "destination": parent.get("destination", "production"), "blank_status": parent.get("blank_status", ""),
        "assigned_to": assigned_to or "", "assigned_to_name": assigned_to_name or "",
        "force_duplicate": True,
    }
    extra = {
        "kind": "resupply", "parent_ticket_id": parent_id, "resupply_round": n,
        "resupply_reason": reason, "resupply_notes": (notes or "").strip(),
        "resupply_pct": pv["pct"], "resupply_over_threshold": pv["over"],
        "order_id": parent.get("order_id"),
    }
    child = await internal_create_picking_ticket(data, user, ticket_id=child_id, extra=extra)
    await db.wms_pick_tickets.update_one({"ticket_id": parent_id}, {
        "$push": {"resupplies": {"ticket_id": child_id, "round": n, "sizes": sizes, "total": total,
                                 "reason": reason, "created_at": _now(),
                                 "created_by_name": user.get("name", "")}},
        "$inc": {"resupply_units": total}})
    await log_movement(user, "pick_resupply_created", {
        "ticket_id": child_id, "parent_ticket_id": parent_id, "order_number": parent.get("order_number"),
        "round": n, "sizes": sizes, "qty": total, "reason": reason, "pct": pv["pct"],
        "over_threshold": pv["over"]})
    return child


async def cancel_round(*, user: dict, ticket_id: str) -> dict:
    """Cancelar una ronda pedida por error. Solo si aún no se surtió nada."""
    from routers.wms import log_movement
    t = await db.wms_pick_tickets.find_one({"ticket_id": ticket_id}, {"_id": 0})
    if not t or not t.get("parent_ticket_id"):
        raise ResupplyError(404, "Resurtido no encontrado")
    if t.get("status") == "cancelled":
        return t
    if t.get("deducted_map") or _is_closed(t):
        raise ResupplyError(409, "Este resurtido ya se surtió (total o parcial); no se puede cancelar")
    await db.wms_pick_tickets.update_one({"ticket_id": ticket_id}, {"$set": {
        "status": "cancelled", "picking_status": "cancelled", "cancelled_at": _now(),
        "cancelled_by_name": user.get("name", "")}})
    await db.wms_pick_tickets.update_one(
        {"ticket_id": t["parent_ticket_id"], "resupplies.ticket_id": ticket_id},
        {"$set": {"resupplies.$.status": "cancelled"},
         "$inc": {"resupply_units": -int(t.get("total_pick_qty") or 0)}})
    await log_movement(user, "pick_resupply_cancelled", {
        "ticket_id": ticket_id, "parent_ticket_id": t["parent_ticket_id"],
        "order_number": t.get("order_number"), "qty": int(t.get("total_pick_qty") or 0)})
    return {**t, "status": "cancelled"}
