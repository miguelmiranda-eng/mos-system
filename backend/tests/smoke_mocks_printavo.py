"""Smoke: traer los mocks del invoice de Printavo a la ficha del work order.

Sin red ni base: Printavo (GraphQL), la descarga de imagenes y Mongo son falsos.
Comprueba:
  1. fetch_invoice_mockups lee la forma de la API v2 (grupo -> imprints ->
     mockups) en el orden en que se ven en el invoice;
  2. el endpoint guarda cada imagen en disco + order.images, como una subida a
     mano, con su printavo_mockup_id;
  3. un PDF (el PO escaneado que a veces se pega como mockup) se salta;
  4. es idempotente: la segunda vez no repite;
  5. orden sin invoice de Printavo -> 400 claro; Printavo caido -> 502 claro.

Corre: backend/venv/Scripts/python.exe backend/tests/smoke_mocks_printavo.py
"""
import asyncio
import copy
import os
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
os.environ.setdefault("MONGODB_URL", "mongodb://localhost:27017")
os.environ.setdefault("DB_NAME", "mos-offline-test")
os.environ.setdefault("JWT_SECRET", "offline_secret")
os.environ.setdefault("MASTER_API_KEY", "smoke_master_key")
os.environ.setdefault("INTERNAL_SYNC_TOKEN", "smoke_sync_token")

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

import httpx  # noqa: E402
from fastapi import HTTPException  # noqa: E402
import printavo_client as pc  # noqa: E402
import routers.orders as ro  # noqa: E402

ok = fail = 0


def check(nombre, cond, detalle=""):
    global ok, fail
    if cond:
        ok += 1
        print(f"   PASS  {nombre}")
    else:
        fail += 1
        print(f"   FAIL  {nombre}  {detalle}")


# Respuesta con la forma de la doc de la API v2 (invoice 3470: dos grupos; el
# primero trae el PO escaneado como PDF, el segundo el arte).
RESPUESTA = {"invoice": {"id": "24800000", "lineItemGroups": {"nodes": [
    {"position": 1, "imprints": {"nodes": [{"id": "i1", "mockups": {"nodes": [
        {"id": "m_po", "fullImageUrl": "https://cdn/po.pdf", "thumbnailUrl": "https://cdn/po_t.png",
         "mimeType": "application/pdf"}]}}]}},
    {"position": 2, "imprints": {"nodes": [{"id": "i2", "mockups": {"nodes": [
        {"id": "m_arte", "fullImageUrl": "https://cdn/arte.png", "thumbnailUrl": "https://cdn/arte_t.png",
         "mimeType": "image/png"}]}}]}},
    {"position": 3, "imprints": {"nodes": []}},
]}}}


class Col:
    def __init__(self, docs=()):
        self.docs = [copy.deepcopy(d) for d in docs]

    async def find_one(self, q, proj=None):
        return next((copy.deepcopy(d) for d in self.docs if all(d.get(k) == v for k, v in q.items())), None)

    async def insert_one(self, doc):
        self.docs.append(copy.deepcopy(doc))

    async def update_one(self, q, upd, upsert=False):
        for d in self.docs:
            if all(d.get(k) == v for k, v in q.items()):
                d.update(copy.deepcopy(upd.get("$set", {})))
                for k, v in (upd.get("$push") or {}).items():
                    d.setdefault(k, []).extend(v["$each"] if isinstance(v, dict) else [v])


class DB:
    def __init__(self, ordenes):
        self.orders = Col(ordenes)
        self.file_uploads = Col()


class Resp:
    def __init__(self, url):
        self.url = url
        self.content = b"\x89PNG fake" if url.endswith(".png") else b"%PDF fake"
        self.headers = {"content-type": "image/png" if url.endswith(".png") else "application/pdf"}

    def raise_for_status(self):
        pass


class Cliente:
    bajadas = []

    def __init__(self, *a, **kw):
        pass

    async def __aenter__(self):
        return self

    async def __aexit__(self, *a):
        return False

    async def get(self, url):
        Cliente.bajadas.append(url)
        return Resp(url)


class Req:
    pass


async def main():
    print("\n1) fetch_invoice_mockups lee grupo -> imprints -> mockups")
    llamadas = []

    async def gql(q, v):
        llamadas.append(v)
        return copy.deepcopy(RESPUESTA)
    pc._graphql = gql
    ms = await pc.fetch_invoice_mockups("24800000")
    check("2 mockups en el orden del invoice", [m["id"] for m in ms] == ["m_po", "m_arte"], f"{ms}")
    check("con su mime y grupo", ms[1]["mime"] == "image/png" and ms[1]["group"] == 2, f"{ms[1]}")
    check("una sola llamada a Printavo, por id", llamadas == [{"id": "24800000"}], f"{llamadas}")

    print("\n2-4) endpoint: guarda el arte, salta el PDF, no repite")
    tmp = Path(tempfile.mkdtemp())
    ro.UPLOADS_DIR = tmp
    ro.db = DB([{"order_id": "ord_1", "order_number": "3470", "printavo_invoice_id": "24800000", "images": []}])
    ro.httpx = httpx
    httpx.AsyncClient = Cliente

    async def auth(request):
        return {"user_id": "u", "email": "x@prosper-mfg.com"}

    async def log(*a, **kw):
        pass
    ro.require_auth = auth
    ro.log_activity = log
    pc.is_configured = lambda: True

    r = await ro.traer_mocks_printavo("ord_1", Req())
    orden = ro.db.orders.docs[0]
    check("trae 1 (el arte)", r["traidas"] == 1 and r["en_printavo"] == 2, f"{r}")
    check("el PDF del PO se salta, con motivo", any("application/pdf" in x for x in r["omitidas"]), f"{r['omitidas']}")
    check("ni siquiera se descarga el PDF", "https://cdn/po.pdf" not in Cliente.bajadas, f"{Cliente.bajadas}")
    img = (orden.get("images") or [{}])[0]
    check("queda en order.images con printavo_mockup_id", img.get("printavo_mockup_id") == "m_arte", f"{img}")
    check("el archivo esta en disco", any(tmp.iterdir()), f"{list(tmp.iterdir())}")
    check("y registrado en file_uploads", len(ro.db.file_uploads.docs) == 1)
    check("marca printavo_mocks_at (la ficha no vuelve a buscar sola)", bool(orden.get("printavo_mocks_at")))
    check("devuelve las imagenes para pintarlas", len(r["images"]) == 1, f"{r['images']}")

    r2 = await ro.traer_mocks_printavo("ord_1", Req())
    check("la 2a vez no repite", r2["traidas"] == 0 and len(ro.db.orders.docs[0]["images"]) == 1, f"{r2}")

    print("\n5) errores claros")
    ro.db = DB([{"order_id": "ord_2", "order_number": "9", "images": []}])
    try:
        await ro.traer_mocks_printavo("ord_2", Req())
        check("orden sin invoice debia fallar", False)
    except HTTPException as e:
        check("orden sin invoice de Printavo -> 400 claro", e.status_code == 400 and "Printavo" in e.detail, e.detail)

    async def caido(q, v):
        raise RuntimeError("HTTP 403 (WAF)")
    pc._graphql = caido
    ro.db = DB([{"order_id": "ord_3", "printavo_invoice_id": "1", "images": []}])
    try:
        await ro.traer_mocks_printavo("ord_3", Req())
        check("Printavo caido debia fallar", False)
    except HTTPException as e:
        check("Printavo caido -> 502 con el motivo", e.status_code == 502 and "403" in e.detail, e.detail)

    print(f"\n{'=' * 60}\n   {ok} PASS / {fail} FAIL\n{'=' * 60}")
    return 1 if fail else 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
