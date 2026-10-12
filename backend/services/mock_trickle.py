"""Goteo de mocks de Printavo para el tablero visual de Planeación.

El tablero muestra el mock de cada orden igual que la ficha del work order,
pero NO puede pedirlos todos al abrirse: ~60 órdenes = ~60 consultas
`invoice(id:)` seguidas, justo la ráfaga que el WAF de Printavo castiga
bloqueando el token (403 HTML), y ese token es el MISMO del sync de
producción. Por eso:

- Cada orden se consulta UNA sola vez en su vida: el mock se guarda en
  order.images (como la ficha) y `printavo_mocks_at`/`printavo_mocks_v` la marcan
  como revisada; la siguiente vez sale de MOS, sin tocar Printavo.
- Las consultas van de una en una, con `INTERVAL_S` segundos entre una y otra
  (por omisión 30 s = 2 por minuto), desde un único worker por proceso.
- Antes de consultar se reclama la orden en la BD (`printavo_mocks_claim_at`), así
  dos procesos o una ficha abierta al mismo tiempo no repiten la llamada.
- Ante un rechazo de Printavo (403/WAF, 429, error) el worker se detiene
  `PAUSE_ON_BLOCK_S` (30 min) y la orden no se reintenta en `RETRY_FAIL_S` (24 h).

Nada de esto corre con DISABLE_SCHEDULERS=1 (pruebas) ni sin credenciales.
"""
import asyncio
import logging
import os
from collections import OrderedDict
from datetime import datetime, timedelta, timezone

from deps import db

logger = logging.getLogger(__name__)

INTERVAL_S = float(os.environ.get("MOCKS_TRICKLE_SECONDS", "30"))
PAUSE_ON_BLOCK_S = 30 * 60
RETRY_FAIL_S = 24 * 3600
CLAIM_TTL_S = 10 * 60
QUEUE_MAX = 500
SYSTEM_USER = {"user_id": "system_mock_trickle", "name": "Tablero de Planeación (goteo de mocks)",
               "email": "system@mos"}

_queue: "OrderedDict[str, None]" = OrderedDict()
_task = None
_paused_until = None


def enabled() -> bool:
    if os.environ.get("DISABLE_SCHEDULERS") == "1":
        return False
    try:
        import printavo_client
        return printavo_client.is_configured()
    except Exception:          # noqa: BLE001
        return False


def pending_filter(version: int) -> dict:
    """Órdenes de Printavo que aún no se revisan con la versión vigente y que no
    fallaron en las últimas RETRY_FAIL_S horas."""
    fail_cut = (datetime.now(timezone.utc) - timedelta(seconds=RETRY_FAIL_S)).isoformat()
    return {"printavo_invoice_id": {"$nin": [None, ""]},
            "printavo_mocks_v": {"$not": {"$gte": version}},
            "$or": [{"printavo_mocks_fail_at": {"$exists": False}},
                    {"printavo_mocks_fail_at": {"$lt": fail_cut}}]}


def enqueue(order_ids) -> int:
    """Agrega órdenes al goteo (sin duplicar). Regresa cuántas quedan en fila."""
    if not enabled():
        return 0
    for oid in order_ids:
        if oid and oid not in _queue and len(_queue) < QUEUE_MAX:
            _queue[oid] = None
    _ensure_worker()
    return len(_queue)


def status() -> dict:
    return {"queued": len(_queue), "interval_s": INTERVAL_S,
            "paused_until": _paused_until.isoformat() if _paused_until else None}


def _ensure_worker():
    global _task
    if _queue and (_task is None or _task.done()):
        _task = asyncio.create_task(_worker())


async def _claim(order_id: str, version: int) -> bool:
    now = datetime.now(timezone.utc)
    stale = (now - timedelta(seconds=CLAIM_TTL_S)).isoformat()
    res = await db.orders.update_one(
        {"order_id": order_id, **pending_filter(version),
         "$and": [{"$or": [{"printavo_mocks_claim_at": {"$exists": False}},
                           {"printavo_mocks_claim_at": {"$lt": stale}}]}]},
        {"$set": {"printavo_mocks_claim_at": now.isoformat()}})
    return res.modified_count == 1


async def _worker():
    global _paused_until
    from routers.orders import traer_mocks_de_orden, MOCKS_VERSION
    while _queue:
        if _paused_until and datetime.now(timezone.utc) < _paused_until:
            await asyncio.sleep((_paused_until - datetime.now(timezone.utc)).total_seconds())
            continue
        _paused_until = None
        order_id, _ = _queue.popitem(last=False)
        try:
            if not await _claim(order_id, MOCKS_VERSION):
                continue                       # ya revisada, falló hace poco, o la tomó otro
            try:
                r = await traer_mocks_de_orden(order_id, SYSTEM_USER)
                logger.info(f"[mock-trickle] {order_id}: {r.get('traidas', 0)} traída(s) "
                            f"de {r.get('en_printavo', 0)} en Printavo; {len(_queue)} en fila")
            except Exception as e:             # noqa: BLE001 — HTTPException incluida
                detail = getattr(e, "detail", None) or str(e)
                await db.orders.update_one({"order_id": order_id},
                                           {"$set": {"printavo_mocks_fail_at": datetime.now(timezone.utc).isoformat()},
                                            "$unset": {"printavo_mocks_claim_at": ""}})
                # Cualquier rechazo de Printavo (WAF 403, 429, tiempo) detiene el
                # goteo: más vale tardar que tumbar el token del sync.
                if str(detail).startswith(("Printavo rechazó", "Printavo tardó")):
                    _paused_until = datetime.now(timezone.utc) + timedelta(seconds=PAUSE_ON_BLOCK_S)
                    logger.warning(f"[mock-trickle] Printavo rechazó {order_id} ({str(detail)[:160]}); "
                                   f"pausa hasta {_paused_until.isoformat()}")
                else:
                    logger.warning(f"[mock-trickle] {order_id}: {str(detail)[:160]}")
        except Exception as e:                 # noqa: BLE001 — el worker no se cae
            logger.error(f"[mock-trickle] {order_id}: {e}")
        await asyncio.sleep(INTERVAL_S)
