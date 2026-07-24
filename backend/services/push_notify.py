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


def _pem_to_der_b64url(private_pem):
    """pywebpush recibe la llave como string SOLO en RAW/DER-base64url
    (Vapid.from_string no entiende PEM); el PEM guardado en Mongo se
    convierte aquí en cada tanda de envíos."""
    from cryptography.hazmat.primitives import serialization
    key = serialization.load_pem_private_key(private_pem.encode(), password=None)
    der = key.private_bytes(
        serialization.Encoding.DER,
        serialization.PrivateFormat.PKCS8,
        serialization.NoEncryption(),
    )
    return base64.urlsafe_b64encode(der).decode().rstrip("=")


def _send_one(sub, payload, private_key_b64url, claims):
    webpush(
        subscription_info=sub,
        data=json.dumps(payload),
        vapid_private_key=private_key_b64url,
        vapid_claims=dict(claims),  # pywebpush muta el dict; copia por envío
        ttl=3600,
    )


async def _send_to_subs(db, subs, title, body, url, tag):
    """Envía `payload` a una lista de suscripciones ya resuelta. Devuelve
    (enviadas, muertas); limpia las suscripciones muertas (404/410)."""
    if not subs:
        return (0, 0)
    cfg = await ensure_vapid_keys(db)
    payload = {"title": title, "body": body, "url": url, "tag": tag}
    claims = {"sub": "mailto:tech@prosper-mfg.com"}
    private_key_b64url = _pem_to_der_b64url(cfg["private_pem"])
    enviadas, muertas = 0, []
    for s in subs:
        try:
            await asyncio.to_thread(_send_one, s["subscription"], payload,
                                    private_key_b64url, claims)
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


async def send_push_to_all(db, title, body, url="/wms", tag="wms-alerta"):
    """Notifica a TODOS los dispositivos suscritos. Devuelve (enviadas, muertas).
    Nunca truena: una alerta que falla se loguea y la vida sigue."""
    if not _PUSH_OK:
        return (0, 0)
    try:
        subs = await db.wms_push_subs.find({}, {"_id": 0}).to_list(500)
        return await _send_to_subs(db, subs, title, body, url, tag)
    except Exception:
        logger.exception("send_push_to_all falló")
        return (0, 0)


async def send_push_to_users(db, user_ids, title, body, url="/wms", tag="wms-alerta"):
    """Notifica sólo a los dispositivos de `user_ids` (los que hayan suscrito).
    Un usuario opt-in sin dispositivo suscrito simplemente no recibe nada.
    Nunca truena."""
    if not _PUSH_OK:
        return (0, 0)
    ids = [u for u in (user_ids or []) if u]
    if not ids:
        return (0, 0)
    try:
        subs = await db.wms_push_subs.find(
            {"user_id": {"$in": ids}}, {"_id": 0}).to_list(500)
        return await _send_to_subs(db, subs, title, body, url, tag)
    except Exception:
        logger.exception("send_push_to_users falló")
        return (0, 0)
