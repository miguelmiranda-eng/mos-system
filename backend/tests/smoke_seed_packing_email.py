"""Smoke: sembrar enlace de packing + enviar el packing por correo (Excel adjunto)
a nombre de quien siembra (routers/orders.py seed-packing-link, services/mailer.py).

Resend y la descarga del Sheet se sustituyen (no se manda correo real ni hay red).

SEGURIDAD: base DESECHABLE, se niega contra producción, se borra al terminar.

    set MONGODB_URL=mongodb://localhost:27017
    python backend/tests/smoke_seed_packing_email.py
"""
import asyncio
import base64
import os
import sys

BE = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
SMOKE_DB = os.environ.get("SMOKE_DB_NAME", "mos-smoke-seed-email")
MONGO = os.environ.get("MONGODB_URL") or os.environ.get("MONGO_URL")
if not MONGO:
    sys.exit("Falta MONGODB_URL")
if SMOKE_DB == os.environ.get("PROD_DB_NAME", "mos-system"):
    sys.exit("NEGADO: base de producción")
os.environ.update({"MONGODB_URL": MONGO, "MONGO_URL": MONGO, "DB_NAME": SMOKE_DB,
                   "SENDER_EMAIL": "mos@prosper-mfg.com", "RESEND_API_KEY": "re_fake"})
for k, v in (("JWT_SECRET", "s"), ("MASTER_API_KEY", "m"), ("INTERNAL_SYNC_TOKEN", "t"),
             ("DISABLE_SCHEDULERS", "1"), ("ENV", "local")):
    os.environ.setdefault(k, v)
sys.path.insert(0, BE)
os.chdir(BE)

import pymongo  # noqa: E402
from passlib.hash import bcrypt  # noqa: E402

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
raw = pymongo.MongoClient(MONGO)
sdb = raw[SMOKE_DB]
ok = fail = 0


def check(name, cond, detail=""):
    global ok, fail
    ok, fail = (ok + 1, fail) if cond else (ok, fail + 1)
    print(f"   {'PASS' if cond else 'FAIL'}  {name}" + ("" if cond else f"  {detail}"))


def sembrar():
    for c in ["orders", "users", "user_sessions", "comments", "activity_logs", "scheduled_shipments"]:
        sdb[c].delete_many({})
    sdb.orders.insert_many([
        {"order_id": "o1", "order_number": "3319", "board": "FINAL BILL"},
        {"order_id": "o2", "order_number": "3266", "board": "FINAL BILL"},
    ])
    # Renglón del programador de 3319: destino y fecha para el correo sin etiqueta completa.
    sdb.scheduled_shipments.insert_one({"shipment_id": "s1", "order_number": "3319", "export_id": "e1",
                                        "ship_date": "2026-10-02", "delivery_to": "RL JONES"})
    sdb.users.insert_many([
        {"user_id": "u1", "email": "jesus.mercado@prosper-mfg.com", "name": "Jesus Mercado",
         "password_hash": bcrypt.hash("p"), "role": "admin", "active": True},
        {"user_id": "u2", "email": "otro@gmail.com", "name": "Externo",
         "password_hash": bcrypt.hash("p"), "role": "admin", "active": True},
    ])


async def main():
    sembrar()
    import resend
    from services import export_packing
    sent = []

    def fake_send(payload):
        sent.append(payload)
        return {"id": "email_123"}
    resend.Emails.send = fake_send
    downloads = {"ok": True}

    async def fake_download(url):
        return (b"PK\x03\x04fake-xlsx", None) if downloads["ok"] else (None, "el archivo no es público")
    export_packing.download_xlsx = fake_download

    from httpx import ASGITransport, AsyncClient
    from server import app
    URL = "https://docs.google.com/spreadsheets/d/19iFwnOhpKw3nF8VqGXMSwx6jt5xVHQHu/edit"
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://smoke") as c, \
            AsyncClient(transport=ASGITransport(app=app), base_url="http://smoke") as c2:
        await c.post("/api/auth/login", json={"email": "jesus.mercado@prosper-mfg.com", "password": "p"})
        await c2.post("/api/auth/login", json={"email": "otro@gmail.com", "password": "p"})
        API = "/api/orders/seed-packing-link"

        print("== Validación ==")
        r = await c.post(API, json={"order_numbers": ["3319"], "label": "PL GTS 09-26-0085", "url": URL,
                                    "email_to": "cliente@acme.com, mal-correo"})
        check("correo inválido → 400 antes de sembrar", r.status_code == 400 and "mal-correo" in r.text, r.text[:200])
        check("…y no sembró nada", sdb.comments.count_documents({}) == 0)

        print("\n== Siembra + correo a nombre del usuario ==")
        r = await c.post(API, json={"order_numbers": ["3319", "3266", "9999"], "label": "PL GTS 09-26-0085 SHIPPING 09-29-2026",
                                    "url": URL, "email_to": "cliente@acme.com; Broker@tsc.com"})
        d = r.json()
        e = d.get("email") or {}
        check("siembra igual que antes", r.status_code == 200 and d["seeded_count"] == 2 and d["not_found"] == ["9999"], d)
        check("correo enviado con Excel adjunto", e.get("sent") and e.get("attached"), e)
        p = sent[-1]
        check("sale DESDE el correo del usuario (mismo dominio verificado)",
              p["from"] == "Jesus Mercado <jesus.mercado@prosper-mfg.com>" and e.get("from_own_address"), p["from"])
        check("destinatarios normalizados", p["to"] == ["cliente@acme.com", "broker@tsc.com"], p["to"])
        check("Responder-a y copia para quien siembra",
              p.get("reply_to") == ["jesus.mercado@prosper-mfg.com"] and p.get("cc") == ["jesus.mercado@prosper-mfg.com"], p)
        att = (p.get("attachments") or [{}])[0]
        check("adjunto = etiqueta.xlsx con el archivo descargado",
              att.get("filename") == "PL GTS 09-26-0085 SHIPPING 09-29-2026.xlsx"
              and base64.b64decode(att.get("content", "")).startswith(b"PK"), att.get("filename"))
        check("asunto = etiqueta; cuerpo como el correo de Envíos (cliente, ruta y fecha de la etiqueta)",
              p["subject"] == "PL GTS 09-26-0085 SHIPPING 09-29-2026" and p["html"].startswith("<p>Hi All,</p>")
              and "Please find attached the Packing List for <b><u>GTS- SAN DIEGO - RL JONES</u></b>" in p["html"]
              and "it shipped on <b>09-29-2026</b>" in p["html"], p["html"])
        check("con Excel adjunto el cuerpo no lleva el enlace", URL not in p["html"])
        log = sdb.activity_logs.find_one({"action": "send_packing_email"})
        check("queda en la bitácora", bool(log), log)

        print("\n== Usuario de otro dominio / archivo no público / sin servicio de correo ==")
        downloads["ok"] = False
        r = await c2.post(API, json={"order_numbers": ["3319"], "label": "PL X", "url": URL, "email_to": "cliente@acme.com"})
        e = r.json()["email"]
        p = sent[-1]
        check("dominio no verificado: 'Nombre vía MOS' + Responder-a al usuario",
              p["from"] == "Externo vía MOS <mos@prosper-mfg.com>" and p["reply_to"] == ["otro@gmail.com"], p)
        check("archivo no descargable: se manda con el enlace y lo avisa",
              e["sent"] and not e["attached"] and "no es público" in (e.get("attach_error") or "") and "attachments" not in p
              and URL in p["html"], e)
        check("etiqueta sin cliente/fecha: salen de las órdenes y del programador",
              "GTS- SAN DIEGO - RL JONES" in p["html"] and "it shipped on <b>10-02-2026</b>" in p["html"], p["html"])
        os.environ.pop("RESEND_API_KEY")
        r = await c.post(API, json={"order_numbers": ["3266"], "label": "PL Y", "url": URL + "?v=2", "email_to": "a@b.com"})
        d = r.json()
        check("sin RESEND_API_KEY: la siembra se hace y el correo explica el error",
              d["seeded_count"] == 1 and not d["email"]["sent"] and "RESEND_API_KEY" in d["email"]["error"], d)
        r = await c.post(API, json={"order_numbers": ["3266"], "label": "PL Z", "url": URL + "?v=3"})
        check("sin correo capturado: email = null (comportamiento de siempre)", r.json().get("email") is None, r.json())


try:
    asyncio.run(main())
finally:
    raw.drop_database(SMOKE_DB)
    print(f"\n{ok} PASS · {fail} FAIL")
    sys.exit(1 if fail else 0)
