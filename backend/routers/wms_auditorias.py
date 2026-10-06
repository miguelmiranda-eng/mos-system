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


# ── Sesiones de auditoría por caja (Sampling) ─────────────────────────────────
def _http(e: "auditorias.AuditError"):
    return HTTPException(e.status, e.detail)


@router.get("/sessions")
async def sessions_list(request: Request):
    await require_action(request, "auditorias.view")
    qp = request.query_params
    try:
        limit = int(qp.get("limit") or 50)
    except (TypeError, ValueError):
        limit = 50
    return await auditorias.list_sessions(limit)


@router.post("/sessions")
async def sessions_create(request: Request):
    user = await require_action(request, "auditorias.manage")
    body = await request.json() if request.headers.get("content-length") else {}
    return await auditorias.create_session(user, (body or {}).get("note") or "")


@router.get("/sessions/{session_id}")
async def sessions_get(session_id: str, request: Request):
    await require_action(request, "auditorias.view")
    s = await auditorias.get_session(session_id)
    if not s:
        raise HTTPException(404, "Sesión de auditoría no encontrada.")
    return s


@router.delete("/sessions/{session_id}")
async def sessions_delete(session_id: str, request: Request):
    user = await require_action(request, "auditorias.manage")
    res = await auditorias.delete_session(session_id)
    await log_activity(user, "wms_auditoria_session_delete", {"session_id": session_id, **res})
    return res


@router.post("/sessions/{session_id}/boxes")
async def sessions_add_box(session_id: str, request: Request):
    await require_action(request, "auditorias.manage")
    body = await request.json()
    try:
        return await auditorias.add_box(session_id, (body or {}).get("box_id") or "")
    except auditorias.AuditError as e:
        raise _http(e)


@router.put("/sessions/{session_id}/boxes/{box_id}")
async def sessions_set_box(session_id: str, box_id: str, request: Request):
    user = await require_action(request, "auditorias.manage")
    body = await request.json()
    try:
        return await auditorias.set_box_count(
            session_id, box_id, user,
            counted_units=(body or {}).get("counted_units"),
            content_ok=bool((body or {}).get("content_ok", True)),
            located_ok=bool((body or {}).get("located_ok", True)))
    except auditorias.AuditError as e:
        raise _http(e)


@router.delete("/sessions/{session_id}/boxes/{box_id}")
async def sessions_remove_box(session_id: str, box_id: str, request: Request):
    await require_action(request, "auditorias.manage")
    try:
        return await auditorias.remove_box(session_id, box_id)
    except auditorias.AuditError as e:
        raise _http(e)


@router.post("/sessions/{session_id}/close")
async def sessions_close(session_id: str, request: Request):
    user = await require_action(request, "auditorias.manage")
    try:
        s = await auditorias.close_session(session_id)
    except auditorias.AuditError as e:
        raise _http(e)
    await log_activity(user, "wms_auditoria_session_close",
                       {"session_id": session_id, "metrics": s.get("metrics")})
    return s


@router.post("/adjust")
async def adjust(request: Request):
    """Ajuste de inventario disparado por auditoría. Body: {box_id, counted_units,
    reason (del catálogo), located_ok?, session_id?}. Valida el motivo y rutea por
    el escritor único; registra un movimiento 'auditoria_adjustment'."""
    user = await require_action(request, "auditorias.manage")
    body = await request.json()
    try:
        res = await auditorias.apply_adjustment(
            user,
            box_id=(body or {}).get("box_id") or "",
            counted_units=(body or {}).get("counted_units"),
            reason=(body or {}).get("reason") or "",
            located_ok=bool((body or {}).get("located_ok", True)),
            session_id=(body or {}).get("session_id"))
    except auditorias.AuditError as e:
        raise _http(e)
    await log_activity(user, "wms_auditoria_adjust",
                       {"box_id": res.get("box_id"), "delta_units": res.get("delta_units")})
    return res
