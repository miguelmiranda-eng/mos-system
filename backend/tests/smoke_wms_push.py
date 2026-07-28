"""Smoke de las alertas push (Web Push/VAPID) — canal de notificaciones al
celular para descuadres ROJOS y el resumen del job nocturno.

Fija: gate de admin nivel 2, generación/persistencia de llaves VAPID,
alta/baja de suscripciones, el endpoint de prueba con una suscripción falsa
(el envío falla contra el endpoint inventado y el sistema NO truena), y que
registrar una incidencia ROJA no revienta aunque el push falle.

SEGURIDAD: base DESECHABLE, se niega contra producción, se borra al terminar.

USO
───
    set MONGODB_URL=mongodb://usuario:clave@host:27017/?authSource=admin
    python backend/tests/smoke_wms_push.py
"""
import asyncio
import os
import sys

BE = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
SMOKE_DB = os.environ.get("SMOKE_DB_NAME", "mos-smoke-test")
PROD_DB = os.environ.get("PROD_DB_NAME", "mos-system")
MONGO = os.environ.get("MONGODB_URL") or os.environ.get("MONGO_URL")

if not MONGO:
    sys.exit("Falta MONGODB_URL")
if SMOKE_DB == PROD_DB:
    sys.exit(f"NEGADO: SMOKE_DB_NAME es la base de producción ('{PROD_DB}').")

os.environ["MONGODB_URL"] = MONGO
os.environ["DB_NAME"] = SMOKE_DB
os.environ.setdefault("JWT_SECRET", "smoke_secret")
os.environ.setdefault("ENV", "local")
sys.path.insert(0, BE)
os.chdir(BE)

import pymongo  # noqa: E402
from passlib.hash import bcrypt  # noqa: E402

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

raw = pymongo.MongoClient(MONGO)
sdb = raw[SMOKE_DB]
ok = fail = 0


def check(nombre, cond, detalle=""):
    global ok, fail
    if cond:
        ok += 1
        print(f"   PASS  {nombre}")
    else:
        fail += 1
        print(f"   FAIL  {nombre}  {detalle}")


def sembrar():
    print(f"== Sembrando {SMOKE_DB} ==")
    for c in ["wms_push_config", "wms_push_subs", "wms_incidents",
              "users", "user_sessions"]:
        sdb[c].delete_many({})
    sdb.users.insert_one({
        "user_id": "u_sup", "email": "sup@test.local", "name": "Supervisor",
        "password_hash": bcrypt.hash("sup123"),
        "role": "supersu", "admin_level": 5, "inventory_level": 5, "active": True,
    })
    sdb.users.insert_one({
        "user_id": "u_op", "email": "op@test.local", "name": "Operador",
        "password_hash": bcrypt.hash("op123"),
        "role": "inventory", "admin_level": 0, "inventory_level": 1, "active": True,
    })


FAKE_SUB = {
    "endpoint": "https://fcm.googleapis.com/fcm/send/FAKE-SMOKE-ENDPOINT",
    "keys": {"p256dh": "BNo_fakekey_fakekey_fakekey_fakekey_fakekey_fakekey_fakekey_fake",
             "auth": "fakeauthfakeauth"},
}


async def main():
    sembrar()
    from httpx import ASGITransport, AsyncClient
    from server import app

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://smoke") as sup, \
               AsyncClient(transport=ASGITransport(app=app), base_url="http://smoke") as op:
        r = await sup.post("/api/auth/login", json={"email": "sup@test.local", "password": "sup123"})
        check("login supervisor", r.status_code == 200, f"{r.status_code}")
        r = await op.post("/api/auth/login", json={"email": "op@test.local", "password": "op123"})
        check("login operador", r.status_code == 200, f"{r.status_code}")

        print("\n== Gate ==")
        r = await op.get("/api/wms/push/vapid-public-key")
        check("operador -> 403", r.status_code == 403, f"{r.status_code}")

        print("\n== Llaves VAPID ==")
        r = await sup.get("/api/wms/push/vapid-public-key")
        check("200 con llave", r.status_code == 200 and bool(r.json().get("public_key")),
              f"{r.status_code} {r.text[:120]}")
        k1 = r.json().get("public_key")
        r = await sup.get("/api/wms/push/vapid-public-key")
        check("la llave PERSISTE (misma en 2a llamada)", r.json().get("public_key") == k1)

        print("\n== La llave privada es digerible por pywebpush ==")
        # pywebpush recibe la llave como string vía Vapid.from_string, que SOLO
        # entiende RAW/DER-b64url — pasarle el PEM de Mongo truena y ninguna
        # push sale (así se cayó el canal completo el 2026-07-23).
        from services.push_notify import _pem_to_der_b64url
        from py_vapid import Vapid
        import base64
        from cryptography.hazmat.primitives import serialization
        cfg = sdb.wms_push_config.find_one({"_id": "vapid_keys"})
        try:
            v = Vapid.from_string(_pem_to_der_b64url(cfg["private_pem"]))
            raw_pub = v.public_key.public_bytes(
                serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint)
            pub = base64.urlsafe_b64encode(raw_pub).decode().rstrip("=")
            check("PEM→DER-b64url pasa por Vapid.from_string y la pública coincide",
                  pub == cfg["public_key_b64url"], "la pública derivada no coincide")
        except Exception as e:
            check("PEM→DER-b64url pasa por Vapid.from_string y la pública coincide",
                  False, repr(e))

        print("\n== Suscripción ==")
        r = await sup.post("/api/wms/push/subscribe", json={"subscription": FAKE_SUB})
        check("subscribe 200", r.status_code == 200, f"{r.status_code} {r.text[:120]}")
        check("guardada", sdb.wms_push_subs.count_documents({}) == 1)
        r = await sup.post("/api/wms/push/subscribe", json={"subscription": FAKE_SUB})
        check("re-subscribe idempotente (sigue 1)",
              r.status_code == 200 and sdb.wms_push_subs.count_documents({}) == 1)
        r = await sup.post("/api/wms/push/subscribe", json={"subscription": {"endpoint": ""}})
        check("suscripción inválida -> 400", r.status_code == 400, f"{r.status_code}")

        print("\n== Envío (contra endpoint falso: falla SIN tronar) ==")
        r = await sup.post("/api/wms/push/test")
        check("push/test 200 aunque el envío truene",
              r.status_code == 200, f"{r.status_code} {r.text[:150]}")

        print("\n== Incidencia ROJA dispara push sin romper el registro ==")
        from routers.wms import _record_incident
        await _record_incident("inventory_conservation_violation",
                               {"user_id": "u_sup", "name": "Supervisor"},
                               "smoke: violación de conservación de prueba")
        await asyncio.sleep(0.5)  # deja correr el fire-and-forget
        check("incidencia registrada",
              sdb.wms_incidents.count_documents({"kind": "inventory_conservation_violation"}) == 1)

        print("\n== Baja ==")
        r = await sup.post("/api/wms/push/unsubscribe", json={"endpoint": FAKE_SUB["endpoint"]})
        check("unsubscribe 200", r.status_code == 200 and r.json().get("removed") in (0, 1),
              f"{r.status_code} {r.text[:100]}")
        check("sin suscripciones", sdb.wms_push_subs.count_documents({}) == 0)


try:
    asyncio.run(main())
finally:
    raw.drop_database(SMOKE_DB)
    print(f"\n== Base {SMOKE_DB} eliminada ==")
    print(f"{ok} PASS · {fail} FAIL")
    sys.exit(1 if fail else 0)
