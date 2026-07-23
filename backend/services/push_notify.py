"""Alertas push reales al celular (Web Push / VAPID) — pedido del usuario
2026-07-23: "quiero alertas reales que se vean en las notificaciones de mi
celular Android".

CÓMO FUNCIONA
─────────────
· Las llaves VAPID se generan UNA vez y viven en Mongo (wms_push_config), así
  sobreviven deploys sin tocar variables de entorno.
· Cada dispositivo se suscribe desde el WMS (campana en el sidebar, solo
  admin/supersu) y su suscripción queda en wms_push_subs.
· `send_push_to_all` manda la notificación a todos los dispositivos
  suscritos; las suscripciones muertas (404/410: app desinstalada, permiso
  revocado) se borran solas.
· Los DISPARADORES viven en wms.py: incidencias ROJAS al momento de
  registrarse + resumen del job nocturno cuando amanecen fantasmas nuevos.

pywebpush es bloqueante (HTTP síncrono): siempre se llama vía
asyncio.to_thread para no congelar el event loop del backend.
"""

import asyncio
import base64
import json
import logging

logger = logging.getLogger(__name__)

try:
    from py_vapid import Vapid
    from pywebpush import webpush, WebPushException
    _PUSH_OK = True
except Exception:  # pragma: no cover — backend viejo sin la dependencia
    _PUSH_OK = False

_CONFIG_ID = "vapid_keys"


def push_disponible():
    return _PUSH_OK


async def ensure_vapid_keys(db):
    """Devuelve {private_pem, public_key_b64url}; las crea la primera vez."""
    cfg = await db.wms_push_config.find_one({"_id": _CONFIG_ID})
    if cfg:
        return cfg
    if not _PUSH_OK:
        raise RuntimeError("pywebpush no está instalado")
    from cryptography.hazmat.primitives import serialization
    v = Vapid()
    v.generate_keys()
    private_pem = v.private_pem().decode()
    raw = v.public_key.public_bytes(
        serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint)
    public_b64 = base64.urlsafe_b64encode(raw).decode().rstrip("=")
    cfg = {"_id": _CONFIG_ID, "private_pem": private_pem, "public_key_b64url": public_b64}
    await db.wms_push_config.insert_one(cfg)
    logger.info("Llaves VAPID generadas y guardadas (wms_push_config).")
    return cfg


def _send_one(sub, payload, private_pem, claims):
    webpush(
        subscription_info=sub,
        data=json.dumps(payload),
        vapid_private_key=private_pem,
        vapid_claims=dict(claims),  # pywebpush muta el dict; copia por envío
        ttl=3600,
    )


async def send_push_to_all(db, title, body, url="/wms", tag="wms-alerta"):
    """Notifica a TODOS los dispositivos suscritos. Devuelve (enviadas, muertas).
    Nunca truena: una alerta que falla se loguea y la vida sigue."""
    if not _PUSH_OK:
        return (0, 0)
    try:
        cfg = await ensure_vapid_keys(db)
        subs = await db.wms_push_subs.find({}, {"_id": 0}).to_list(500)
        if not subs:
            return (0, 0)
        payload = {"title": title, "body": body, "url": url, "tag": tag}
        claims = {"sub": "mailto:tech@prosper-mfg.com"}
        enviadas, muertas = 0, []
        for s in subs:
            try:
                await asyncio.to_thread(_send_one, s["subscription"], payload,
                                        cfg["private_pem"], claims)
                enviadas += 1
            except WebPushException as e:
                status = getattr(getattr(e, "response", None), "status_code", None)
                if status in (404, 410):
                    muertas.append(s["subscription"].get("endpoint"))
                else:
                    logger.warning("push falló (%s): %s", status, e)
            except Exception:
                logger.exception("push falló")
        if muertas:
            await db.wms_push_subs.delete_many(
                {"subscription.endpoint": {"$in": muertas}})
        return (enviadas, len(muertas))
    except Exception:
        logger.exception("send_push_to_all falló")
        return (0, 0)
