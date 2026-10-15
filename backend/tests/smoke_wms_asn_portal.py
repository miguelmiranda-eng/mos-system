"""Smoke — entradas (ASN) dadas de alta desde el portal del cliente.

Contrato (acordado con Luke 2026-10-15: MOS hace todo, el portal solo
captura, empuja y lee):
  · Llave de API (header X-API-Key) crea entradas SOLO de sus clientes;
    queda source='portal' y portal_meta; mismo número = 409 (reintento).
  · Lista y detalle con llave: `customer` obligatorio y solo lo suyo.
  · trace-sku, PUT y DELETE quedan fuera de la superficie de la llave.
  · Captura a mano del mismo cliente + PO con entrada del portal abierta:
    409 code=portal_asn_open; con confirm_duplicate se guarda.
  · Documentos: subir (tipo y kind validados), bajar por doc_id, borrar solo
    personal de MOS.

Corre contra una base DESECHABLE:
    set MONGODB_URL=mongodb://localhost:27017
    python backend/tests/smoke_wms_asn_portal.py
"""
import asyncio
import os
import sys

BE = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
SMOKE_DB = os.environ.get("SMOKE_DB_NAME", "mos-smoke-asn-portal")
PROD_DB = os.environ.get("PROD_DB_NAME", "mos-system")
MONGO = os.environ.get("MONGODB_URL") or os.environ.get("MONGO_URL")

if not MONGO:
    sys.exit("Falta MONGODB_URL")
if SMOKE_DB == PROD_DB:
    sys.exit(f"NEGADO: SMOKE_DB_NAME es la base de producción ('{PROD_DB}').")

os.environ["MONGODB_URL"] = MONGO
os.environ["DB_NAME"] = SMOKE_DB
os.environ.setdefault("JWT_SECRET", "smoke_secret")
os.environ.setdefault("MASTER_API_KEY", "smoke_master_key")
os.environ.setdefault("INTERNAL_SYNC_TOKEN", "smoke_sync_token")
os.environ.setdefault("ENV", "local")
os.environ.setdefault("DISABLE_SCHEDULERS", "1")
sys.path.insert(0, BE)
os.chdir(BE)

import pymongo  # noqa: E402
from passlib.hash import bcrypt  # noqa: E402

raw = pymongo.MongoClient(MONGO)
sdb = raw[SMOKE_DB]
ok = fail = 0
LLAVE = "mos_smoke_portal_key"


def check(nombre, cond, detalle=""):
    global ok, fail
    if cond:
        ok += 1
        print(f"   PASS  {nombre}")
    else:
        fail += 1
        print(f"   FAIL  {nombre}  {detalle}")


def sembrar():
    from deps import hash_api_key
    raw.drop_database(SMOKE_DB)
    sdb.users.insert_one({
        "user_id": "u_admin", "email": "u_admin@test.local", "name": "u_admin",
        "password_hash": bcrypt.hash("smoke123"),
        "role": "supersu", "admin_level": 5, "inventory_level": 5, "active": True,
    })
    sdb.api_keys.insert_one({
        "key_id": "ak_smoke", "name": "Portal smoke", "customers": ["ACME"],
        "key_hash": hash_api_key(LLAVE), "prefix": LLAVE[:9], "active": True,
    })
    # Entrada de otro cliente, capturada a mano: la llave no debe verla.
    sdb.wms_asn.insert_one({"asn_id": "OTRO-1", "customer": "OTRO", "po_number": "9",
                            "items": [], "status": "pending", "created_at": "2026-10-01T00:00:00+00:00"})


ITEM = {"sku": "TEE100", "color": "BLACK", "size": "M", "qty_expected": 100}


async def main():
    sembrar()
    from httpx import ASGITransport, AsyncClient
    from server import app

    tr = ASGITransport(app=app)
    key = {"X-API-Key": LLAVE}
    async with AsyncClient(transport=tr, base_url="http://t") as api, \
            AsyncClient(transport=tr, base_url="http://t") as adm:
        r = await adm.post("/api/auth/login", json={"email": "u_admin@test.local", "password": "smoke123"})
        H = {"Authorization": f"Bearer {r.json().get('session_token')}"}

        print("== Alta desde el portal")
        body = {"asn_id": "ASN-2610-0007", "customer": "ACME", "po_number": "PO-5001",
                "items": [ITEM], "portal_meta": {"Carrier": "FedEx", "tracking": "123", "bol": "B-9"}}
        r = await api.post("/api/wms/asn", json=body, headers=key)
        d = r.json() if r.status_code == 200 else {}
        check("llave crea entrada de su cliente", r.status_code == 200, r.text[:200])
        check("queda source=portal", d.get("source") == "portal", d.get("source"))
        check("guarda portal_meta normalizado", (d.get("portal_meta") or {}).get("carrier") == "FedEx", d.get("portal_meta"))
        r = await api.post("/api/wms/asn", json=body, headers=key)
        check("mismo número = 409 (reintento no duplica)", r.status_code == 409, r.status_code)
        check("sigue habiendo una sola", sdb.wms_asn.count_documents({"asn_id": "ASN-2610-0007"}) == 1)
        r = await api.post("/api/wms/asn", json={**body, "asn_id": "ASN-X", "customer": "OTRO"}, headers=key)
        check("cliente fuera de alcance = 403", r.status_code == 403, r.status_code)

        print("== Lectura con llave")
        r = await api.get("/api/wms/asn", headers=key)
        check("lista sin customer = 403", r.status_code == 403, r.status_code)
        r = await api.get("/api/wms/asn?customer=ACME", headers=key)
        ids = [a["asn_id"] for a in r.json()] if r.status_code == 200 else []
        check("lista solo trae lo suyo", ids == ["ASN-2610-0007"], ids)
        r = await api.get("/api/wms/asn?customer=OTRO", headers=key)
        check("lista de otro cliente = 403", r.status_code == 403, r.status_code)
        r = await api.get("/api/wms/asn/ASN-2610-0007?customer=ACME", headers=key)
        check("detalle propio = 200 con summary", r.status_code == 200 and "summary" in r.json(), r.status_code)
        r = await api.get("/api/wms/asn/OTRO-1?customer=ACME", headers=key)
        check("detalle ajeno = 403", r.status_code == 403, r.status_code)
        r = await api.get("/api/wms/asn/trace-sku?q=TEE100&customer=ACME", headers=key)
        check("trace-sku fuera de la superficie = 403", r.status_code == 403, r.status_code)
        r = await api.put("/api/wms/asn/ASN-2610-0007?customer=ACME", json={"po_number": "X"}, headers=key)
        check("PUT con llave = 403", r.status_code == 403, r.status_code)
        r = await api.delete("/api/wms/asn/ASN-2610-0007?customer=ACME", headers=key)
        check("DELETE con llave = 403", r.status_code == 403, r.status_code)

        print("== Duplicado capturado a mano")
        manual = {"asn_id": "PL-777", "customer": "acme", "po_number": "PO-5001", "items": [ITEM]}
        r = await adm.post("/api/wms/asn", json=manual, headers=H)
        det = (r.json() or {}).get("detail") if r.status_code == 409 else {}
        check("mismo cliente+PO abierto del portal = 409 portal_asn_open",
              isinstance(det, dict) and det.get("code") == "portal_asn_open" and det.get("asn_id") == "ASN-2610-0007",
              f"{r.status_code} {r.text[:200]}")
        r = await adm.post("/api/wms/asn", json={**manual, "confirm_duplicate": True}, headers=H)
        check("con confirm_duplicate se guarda (source=manual)",
              r.status_code == 200 and r.json().get("source") == "manual", r.text[:200])
        r = await adm.post("/api/wms/asn", json={**manual, "asn_id": "PL-778", "po_number": "PO-OTRO"}, headers=H)
        check("otro PO no avisa", r.status_code == 200, r.status_code)

        print("== Documentos")
        pdf = b"%PDF-1.4 smoke"
        r = await api.post("/api/wms/asn/ASN-2610-0007/documents?customer=ACME", headers=key,
                           files={"file": ("BOL #1 ñ.pdf", pdf, "application/pdf")}, data={"kind": "bol"})
        doc = r.json() if r.status_code == 200 else {}
        check("portal sube BOL", r.status_code == 200 and doc.get("kind") == "bol", r.text[:200])
        check("no expone storage_key", "storage_key" not in doc)
        check("documento marcado como del portal", doc.get("source") == "portal", doc.get("source"))
        r = await api.post("/api/wms/asn/ASN-2610-0007/documents?customer=ACME", headers=key,
                           files={"file": ("x.exe", b"MZ", "application/x-msdownload")}, data={"kind": "bol"})
        check("tipo no permitido = 400", r.status_code == 400, r.status_code)
        r = await api.post("/api/wms/asn/ASN-2610-0007/documents?customer=ACME", headers=key,
                           files={"file": ("a.pdf", pdf, "application/pdf")}, data={"kind": "selfie"})
        check("kind inválido = 400", r.status_code == 400, r.status_code)
        r = await api.post("/api/wms/asn/OTRO-1/documents?customer=ACME", headers=key,
                           files={"file": ("a.pdf", pdf, "application/pdf")}, data={"kind": "bol"})
        check("subir a entrada ajena = 403", r.status_code == 403, r.status_code)
        did = doc.get("doc_id")
        r = await api.get(f"/api/wms/asn/ASN-2610-0007/documents/{did}?customer=ACME", headers=key)
        check("portal baja por doc_id con el mismo contenido",
              r.status_code == 200 and r.content == pdf and r.headers.get("content-type", "").startswith("application/pdf"),
              r.status_code)
        r = await adm.get(f"/api/wms/asn/ASN-2610-0007/documents/{did}", headers=H)
        check("MOS también lo baja", r.status_code == 200, r.status_code)
        r = await api.delete(f"/api/wms/asn/ASN-2610-0007/documents/{did}?customer=ACME", headers=key)
        check("portal no borra = 403", r.status_code == 403, r.status_code)
        r = await adm.delete(f"/api/wms/asn/ASN-2610-0007/documents/{did}", headers=H)
        check("MOS borra", r.status_code == 200, r.text[:200])
        r = await adm.get(f"/api/wms/asn/ASN-2610-0007/documents/{did}", headers=H)
        check("borrado ya no se baja", r.status_code == 404, r.status_code)

    print(f"\n{ok} PASS, {fail} FAIL")
    raw.drop_database(SMOKE_DB)
    sys.exit(1 if fail else 0)


asyncio.run(main())
