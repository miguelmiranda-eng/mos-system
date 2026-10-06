"""Baja el corpus de POs reales que usa `smoke_po_golden.py`.

Los PDFs son work orders del cliente (~31 MB) y NO viven en el repo: se vuelven a
bajar de los mismos correos que el intake ya proceso, usando el token de Google
que el propio intake tiene guardado. Un archivo por PDF distinto (dedup por
sha256), asi que correrlo dos veces no duplica nada.

USO
───
    backend/venv/Scripts/python.exe backend/tests/fetch_po_corpus.py

Necesita: acceso a la base de produccion (MONGODB_URL en backend/.env) y que el
buzon del intake siga conectado.
"""
import asyncio
import base64
import os
import sys

BE = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
sys.path.insert(0, BE)

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

from datetime import datetime  # noqa: E402

from google.auth.transport.requests import Request as GoogleRequest  # noqa: E402
from google.oauth2.credentials import Credentials  # noqa: E402
from googleapiclient.discovery import build  # noqa: E402

from deps import db  # noqa: E402

DEST = os.path.join(os.path.dirname(__file__), "fixtures", "po")


async def _gmail():
    """Cliente de Gmail con el token que el intake guardo para su buzon."""
    cfg = await db.gmail_intake.find_one({"config_id": "gmail_intake"}, {"_id": 0, "user_id": 1})
    if not cfg or not cfg.get("user_id"):
        raise SystemExit("el intake no tiene buzon conectado")
    tok = await db.user_google_tokens.find_one({"user_id": cfg["user_id"]})
    if not tok:
        raise SystemExit("no hay token de Google para ese usuario")
    c = tok["credentials"]
    expiry = None
    if c.get("expiry"):
        try:
            expiry = datetime.fromisoformat(c["expiry"]).replace(tzinfo=None)
        except ValueError:
            pass
    creds = Credentials(
        token=c["token"], refresh_token=c.get("refresh_token"), token_uri=c["token_uri"],
        client_id=c["client_id"], client_secret=c["client_secret"], scopes=c["scopes"], expiry=expiry,
    )
    if creds.expired and creds.refresh_token:
        creds.refresh(GoogleRequest())
    return build("gmail", "v1", credentials=creds)


def _attachment_id(payload, filename):
    stack = [payload]
    while stack:
        p = stack.pop()
        if (p.get("filename") or "") == filename:
            return (p.get("body") or {}).get("attachmentId")
        stack.extend(p.get("parts") or [])
    return None


async def main():
    os.makedirs(DEST, exist_ok=True)
    svc = await _gmail()
    vistos, bajados, saltados, fallidos = set(), 0, 0, 0

    cur = db.printavo_intake.find({}, {"_id": 0, "po_number": 1, "pdf_filename": 1,
                                       "gmail_message_id": 1, "pdf_sha256": 1})
    async for it in cur:
        sha = it.get("pdf_sha256")
        if sha in vistos:
            continue
        vistos.add(sha)
        destino = os.path.join(DEST, (it.get("pdf_filename") or f"{sha}.pdf").replace(" ", "_"))
        if os.path.exists(destino):
            saltados += 1
            continue
        try:
            msg = svc.users().messages().get(
                userId="me", id=it["gmail_message_id"], format="full").execute()
            aid = _attachment_id(msg["payload"], it["pdf_filename"])
            if not aid:
                fallidos += 1
                continue
            res = svc.users().messages().attachments().get(
                userId="me", messageId=it["gmail_message_id"], id=aid).execute()
            with open(destino, "wb") as fh:
                fh.write(base64.urlsafe_b64decode(res["data"].encode()))
            bajados += 1
        except Exception as e:                        # noqa: BLE001
            print(f"   fallo {it.get('po_number')}: {str(e)[:80]}")
            fallidos += 1

    print(f"bajados: {bajados} | ya estaban: {saltados} | fallidos: {fallidos}")
    print(f"corpus en: {DEST}")


if __name__ == "__main__":
    asyncio.run(main())
