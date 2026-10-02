"""Correo saliente a nombre de un usuario de MOS (Resend, como el resto del sistema).

Resend sólo envía desde dominios verificados. Si el correo del usuario es del
mismo dominio que SENDER_EMAIL (p. ej. @prosper-mfg.com verificado), el correo
sale DESDE su dirección; si no, sale como "Nombre vía MOS <SENDER_EMAIL>". En
ambos casos lleva Reply-To al usuario y copia para él, para que la respuesta del
cliente le llegue a quien hizo la actividad.

Env: RESEND_API_KEY, SENDER_EMAIL (mismas que automations.py / report_scheduler.py).
"""
import asyncio
import base64
import logging
import os
import re

logger = logging.getLogger(__name__)
EMAIL_RE = re.compile(r"^[A-Za-z0-9._%+'-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$")


def parse_recipients(raw) -> tuple[list, list]:
    """'a@x.com, b@y.com; c@z.com' (o lista) → (válidos, inválidos), sin repetidos."""
    items = raw if isinstance(raw, list) else re.split(r"[\s,;]+", str(raw or ""))
    ok, bad = [], []
    for it in items:
        e = str(it).strip().strip("<>").lower()
        if not e:
            continue
        (ok if EMAIL_RE.match(e) else bad).append(e)
    return list(dict.fromkeys(ok)), list(dict.fromkeys(bad))


def _sender() -> str:
    return os.environ.get("SENDER_EMAIL", "onboarding@resend.dev")


def from_for(user: dict) -> tuple[str, bool]:
    """(remitente, sale_desde_su_correo)."""
    sender = _sender()
    dom = sender.rsplit("@", 1)[-1].lower()
    email = str(user.get("email") or "").strip().lower()
    name = (str(user.get("name") or "").strip() or email or "MOS").replace('"', "")
    if email and email.rsplit("@", 1)[-1] == dom and dom != "resend.dev":
        return f"{name} <{email}>", True
    return f"{name} vía MOS <{sender}>", False


async def send_as_user(user: dict, to: list, subject: str, html: str, attachments=None) -> dict:
    """Envía y devuelve {sent, id?, from, error?}. Nunca lanza."""
    key = os.environ.get("RESEND_API_KEY")
    frm, own = from_for(user)
    if not key:
        return {"sent": False, "from": frm, "error": "El servidor no tiene configurado el envío de correo (RESEND_API_KEY)"}
    email = str(user.get("email") or "").strip().lower()
    payload = {"from": frm, "to": to, "subject": subject, "html": html}
    if email and EMAIL_RE.match(email):
        payload["reply_to"] = [email]
        if email not in to:
            payload["cc"] = [email]
    if attachments:
        payload["attachments"] = [{"filename": n, "content": base64.b64encode(b).decode()} for n, b in attachments]
    try:
        import resend
        resend.api_key = key
        res = await asyncio.to_thread(resend.Emails.send, payload)
        return {"sent": True, "id": (res or {}).get("id"), "from": frm, "from_own_address": own}
    except Exception as e:  # noqa: BLE001 — el correo nunca tumba la operación que lo pide
        logger.exception("[mailer] fallo al enviar")
        return {"sent": False, "from": frm, "error": f"No se pudo enviar el correo: {e}"}
