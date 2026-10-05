"""Resurtido sobre el mismo pick ticket — puerta HTTP. El porqué y las reglas
viven en services/resupply.py."""
from fastapi import APIRouter, HTTPException, Request

import wms_actions as wa
from deps import require_auth
from routers.wms import get_action_levels, log_activity, require_action
from services import resupply

router = APIRouter(prefix="/api/wms/resupply")


def _http(e: resupply.ResupplyError):
    return HTTPException(e.status, e.detail)


async def _can(user: dict, action_id: str) -> bool:
    levels = await get_action_levels()
    lv = levels.get(action_id) or wa.defaults().get(action_id)
    return bool(lv) and wa.allows(lv, user)


@router.get("/config")
async def resupply_config_get(request: Request):
    """Motivos + umbral (lo lee el modal de Resurtir) y si este usuario puede
    pasar del umbral."""
    user = await require_auth(request)
    return {**await resupply.get_cfg(), "can_over": await _can(user, "picking.resupply_over")}


@router.put("/config")
async def resupply_config_put(request: Request):
    user = await require_action(request, "picking.resupply_config")
    try:
        cfg = await resupply.save_cfg(await request.json(), user)
    except ValueError as e:
        raise HTTPException(400, str(e))
    await log_activity(user, "wms_resupply_config_update", cfg)
    return cfg


@router.post("/{ticket_id}/preview")
async def resupply_preview(ticket_id: str, request: Request):
    """Body {sizes}. Porcentaje acumulado sobre lo pedido y si pasa el umbral."""
    user = await require_action(request, "picking.resupply")
    body = await request.json()
    try:
        pv = await resupply.preview(ticket_id, body.get("sizes") or {})
    except resupply.ResupplyError as e:
        raise _http(e)
    return {**pv, "can_over": await _can(user, "picking.resupply_over")}


@router.post("/{ticket_id}")
async def resupply_create(ticket_id: str, request: Request):
    """Abre la ronda R<n> sobre el ticket. Body {sizes, reason, notes?,
    assigned_to?, assigned_to_name?}."""
    user = await require_action(request, "picking.resupply")
    body = await request.json()
    try:
        return await resupply.create_round(
            user=user, parent_id=ticket_id, sizes=body.get("sizes") or {},
            reason=body.get("reason") or "", notes=body.get("notes") or "",
            assigned_to=(body.get("assigned_to") or "").strip(),
            assigned_to_name=(body.get("assigned_to_name") or "").strip(),
            can_over=await _can(user, "picking.resupply_over"))
    except resupply.ResupplyError as e:
        raise _http(e)


@router.get("/{ticket_id}/rounds")
async def resupply_rounds(ticket_id: str, request: Request):
    await require_auth(request)
    return {"ticket_id": ticket_id, "rounds": await resupply.rounds_of(ticket_id)}


@router.post("/{ticket_id}/cancel")
async def resupply_cancel(ticket_id: str, request: Request):
    """Cancela una ronda pedida por error (solo si no se ha surtido nada)."""
    user = await require_action(request, "picking.resupply")
    try:
        return await resupply.cancel_round(user=user, ticket_id=ticket_id)
    except resupply.ResupplyError as e:
        raise _http(e)
