"""Auditorías del WMS — puerta HTTP (Fase 1). La lógica vive en
services/auditorias.py. Solo lectura: KPIs IRA/ILA, vistas derivadas de la
bitácora, y el catálogo de motivos (lectura/edición)."""
from datetime import date, timedelta

from fastapi import APIRouter, HTTPException, Request

from routers.wms import log_activity, require_action
from services import auditorias

router = APIRouter(prefix="/api/wms/auditorias")


def _default_range():
    today = date.today()
    return (today - timedelta(days=30)).isoformat(), today.isoformat()


@router.get("/kpis")
async def kpis(request: Request):
    """Serie IRA/ILA diaria/semanal vs meta. Query: since, until, group=day|week."""
    await require_action(request, "auditorias.view")
    qp = request.query_params
    d_since, d_until = _default_range()
    since = (qp.get("since") or d_since)[:10]
    until = (qp.get("until") or d_until)[:10]
    group = qp.get("group") if qp.get("group") in ("day", "week") else "day"
    return await auditorias.kpis_rollup(since, until, group)


@router.get("/feed/{kind}")
async def feed(kind: str, request: Request):
    """Vista derivada de wms_movements: kind = pick | putaway | receiving.
    Query: since, until, q, limit."""
    await require_action(request, "auditorias.view")
    qp = request.query_params
    try:
        limit = int(qp.get("limit") or 500)
    except (TypeError, ValueError):
        limit = 500
    return await auditorias.movement_feed(
        kind, qp.get("since") or "", qp.get("until") or "", qp.get("q") or "", limit)


@router.get("/config")
async def config_get(request: Request):
    """Catálogo de motivos de auditoría (lo lee el módulo)."""
    await require_action(request, "auditorias.view")
    return await auditorias.get_cfg()


@router.put("/config")
async def config_put(request: Request):
    user = await require_action(request, "auditorias.manage")
    try:
        cfg = await auditorias.save_cfg(await request.json(), user)
    except ValueError as e:
        raise HTTPException(400, str(e))
    await log_activity(user, "wms_auditorias_config_update", cfg)
    return cfg
