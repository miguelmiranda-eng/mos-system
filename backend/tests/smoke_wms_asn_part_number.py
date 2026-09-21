"""Smoke — número de parte automático en las líneas de entrada (fase 1).

Contrato:
  · GET /asn/part-number/config: defaults fusionados; PUT (admin) suma un
    cliente/prefijo sin borrar los demás.
  · POST /asn/part-number/propose: lee la descripción, propone prenda/género/
    composición y compone; lo explícito manda; errores legibles, nunca guarda.
  · POST /asn: cada línea con prenda+composición+país compone su número de
    parte (part_number_auto=True) y guarda composición canónica; una línea
    sin esos datos conserva el part_number que traiga (auto=False).
  · PUT /asn/{id}: recompone al editar; cambiar el país cambia el código.

Base DESECHABLE (igual que los otros smokes).
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


def check(nombre, cond, detalle=""):
    global ok, fail
    if cond:
        ok += 1
        print(f"   PASS  {nombre}")
    else:
        fail += 1
        print(f"   FAIL  {nombre}  {detalle}")


def sembrar():
    raw.drop_database(SMOKE_DB)
    sdb.users.insert_one({"user_id": "u_admin", "email": "u_admin@test.local", "name": "admin",
                          "password_hash": bcrypt.hash("smoke123"), "role": "supersu", "admin_level": 5, "active": True})


async def main():
    sembrar()
    from httpx import ASGITransport, AsyncClient
    from server import app
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://smoke") as c:
        r = await c.post("/api/auth/login", json={"email": "u_admin@test.local", "password": "smoke123"})
        check("login", r.status_code == 200)

        print("\n== 1. Config ==")
        r = await c.get("/api/wms/asn/part-number/config")
        cfg = r.json()
        check("defaults: GTS/SKT/RRB/SWK", r.status_code == 200 and cfg["customers"]["GOODIE TWO SLEEVES"] == "GTS" and cfg["customers"]["ROCK REBEL"] == "RRB", str(cfg.get("customers")))
        check("prendas incluyen CW y MOCK (nuevas)", {g["code"] for g in cfg["garments"]} >= {"SS", "LS", "HO", "MZHO", "CW", "MOCK", "TANK", "TOP", "PANS", "LG", "JK"})
        r = await c.put("/api/wms/asn/part-number/config", json={"customers": {"cliente nuevo": "cnv"}})
        cfg = r.json()
        check("PUT suma cliente y conserva los demás", r.status_code == 200 and cfg["customers"]["CLIENTE NUEVO"] == "CNV" and cfg["customers"]["SPEKTRUM"] == "SKT", str(cfg.get("customers")))
        r = await c.put("/api/wms/asn/part-number/config", json={"basura": 1})
        check("PUT sin llaves válidas → 400", r.status_code == 400)
        r = await c.put("/api/wms/asn/part-number/config", json={"customers": {**cfg["customers"], "GTS BUCEES": ""}})
        cfg = r.json()
        check("valor vacío retira un cliente (hasta uno de fábrica)", r.status_code == 200 and "GTS BUCEES" not in cfg["customers"] and cfg["customers"]["CLIENTE NUEVO"] == "CNV", str(cfg.get("customers")))
        # Catálogo de composiciones (desplegable de la hoja): canónico y validado.
        check("defaults traen composiciones canónicas", "100% ALGODON" in cfg["compositions"] and "58% ALGODON 42% POLIESTER" in cfg["compositions"] and len(cfg["compositions"]) >= 30, len(cfg.get("compositions", [])))
        r = await c.put("/api/wms/asn/part-number/config", json={"compositions": ["100% COTTON", "42% poly 58% cotton", "60% ALGODON 40% POLIESTER", "  ", "100% ALGODON"]})
        cfg = r.json()
        check("PUT canoniza, reordena y quita duplicados por código", r.status_code == 200 and cfg["compositions"] == ["100% ALGODON", "58% ALGODON 42% POLIESTER", "60% ALGODON 40% POLIESTER"], cfg.get("compositions"))
        r = await c.put("/api/wms/asn/part-number/config", json={"compositions": ["100% ALGODON", "67% COTTON 38% POLYESTER 5% SPANDEX", "50% ALGODON 50% BAMBU"]})
        check("composición inválida → 400 nombrando cada error", r.status_code == 400 and "110%" in r.text and "BAMBU" in r.text, r.text[:200])
        r = await c.get("/api/wms/asn/part-number/config")
        check("el 400 no guardó nada", r.json()["compositions"] == ["100% ALGODON", "58% ALGODON 42% POLIESTER", "60% ALGODON 40% POLIESTER"])
        r = await c.put("/api/wms/asn/part-number/config", json={"compositions": []})
        check("lista vacía → regresan los defaults", r.status_code == 200 and len(r.json()["compositions"]) >= 30)
        # Las descripciones NO son parte de este config (salen del catálogo
        # curado de Configuración → Catálogos, el mismo que Recepción).
        r = await c.get("/api/wms/asn/part-number/config")
        check("el config ya no trae descripciones", "descriptions" not in r.json(), sorted(r.json()))
        r = await c.put("/api/wms/asn/part-number/config", json={"descriptions": ["CAMISETA MANGA CORTA PARA HOMBRE DE PUNTO 100% ALGODÓN"]})
        check("PUT descriptions → 400 (llave que ya no existe)", r.status_code == 400, r.text[:200])

        print("\n== 2. Propuesta desde la descripción ==")
        r = await c.post("/api/wms/asn/part-number/propose", json={
            "customer": "GOODIE TWO SLEEVES", "country": "CHN",
            "description": "CAMISETA PARA HOMBRE MANGA CORTA DE PUNTO 100% ALGODÓN"})
        d = r.json()
        check("propone SS / hombre / 100% ALGODON", d["proposed"]["garment"] == "SS" and d["proposed"]["gender"] == "" and d["proposed"]["fabric"] == "100% ALGODON", d)
        check("compone GTS-SS100CCN", d["ok"] and d["part_number"] == "GTS-SS100CCN", d)
        r = await c.post("/api/wms/asn/part-number/propose", json={
            "customer": "GOODIE TWO SLEEVES", "country": "HONDURAS", "gender": "W", "garment": "LS",
            "description": "CAMISETA PARA HOMBRE MANGA CORTA 58% ALGODON 42% POLIESTER"})
        d = r.json()
        check("lo explícito manda (W + LS) aunque la descripción diga otra cosa", d["part_number"] == "GTS-WLS58C42PHN", d)
        r = await c.post("/api/wms/asn/part-number/propose", json={"customer": "GOODIE TWO SLEEVES", "country": "CHN", "description": "CAMISETA 100% BAMBOO"})
        d = r.json()
        check("fibra desconocida: sin código y error legible", not d["ok"] and d["part_number"] == "" and "BAMBOO" in d["errors"][0], d)
        r = await c.post("/api/wms/asn/part-number/propose", json={"customer": "GOODIE TWO SLEEVES", "country": "CHN", "description": "CAMISETA MANGA CORTA 100% ALGODON", "sample": True})
        check("muestra → sufijo MS", r.json()["part_number"] == "GTS-SS100CCNMS", r.text[:120])

        print("\n== 3. Crear entrada: el servidor compone ==")
        r = await c.post("/api/wms/asn", json={
            "asn_id": "156053-GOD01-A", "tipo": "ASN", "customer": "GOODIE TWO SLEEVES", "vendor": "GOODIE TWO SLEEVES",
            "items": [
                {"description": "CAMISETA PARA HOMBRE MANGA CORTA DE PUNTO 100% ALGODÓN", "garment": "SS", "gender": "",
                 "fabric": "100% ALGODÓN", "country": "CHN", "qty_expected": 1200, "unit": "PZA", "import_type": "Temporal",
                 "po": "19736", "color": "BRACKEN", "part_number": "LO-QUE-SEA", "unit_cost": "2", "net_weight": 0.123, "bundles": 1, "package_type": "PALLET"},
                {"description": "CAMISETA PARA HOMBRE MANGA CORTA DE PUNTO 100% ALGODÓN", "garment": "SS",
                 "fabric": "100% ALGODÓN", "country": "CHN", "qty_expected": 983, "sample": True},
                {"part_number": "5000", "qty_expected": 10, "country": "NIC"},   # línea sin formato: se respeta
            ]})
        d = r.json()
        check("crea", r.status_code == 200, r.text[:200])
        it = d["items"]
        check("línea 1: compuesta, ignora el part_number que mandó el cliente", it[0]["part_number"] == "GTS-SS100CCN" and it[0]["part_number_auto"] is True, it[0])
        check("línea 1: composición canónica y código", it[0]["fabric"] == "100% ALGODON" and it[0]["composition_code"] == "100C" and it[0]["country_code"] == "CN", it[0])
        check("línea 1: datos de aduana y opcionales", it[0]["unit"] == "PZA" and it[0]["import_type"] == "Temporal" and it[0]["po"] == "19736" and it[0]["color"] == "BRACKEN" and it[0]["unit_cost"] == 2.0 and it[0]["bundles"] == 1.0 and it[0]["package_type"] == "PALLET", it[0])
        check("línea 2: muestra → MS", it[1]["part_number"] == "GTS-SS100CCNMS" and it[1]["sample"] is True, it[1])
        check("línea 3: sin prenda/composición conserva '5000' (auto=False)", it[2]["part_number"] == "5000" and it[2]["part_number_auto"] is False, it[2])
        check("cabecera guarda el cliente", d["customer"] == "GOODIE TWO SLEEVES")

        print("\n== 4. Editar: recompone ==")
        r = await c.put("/api/wms/asn/156053-GOD01-A", json={"items": [
            {"line_no": 1, "description": "CAMISETA PARA HOMBRE MANGA CORTA DE PUNTO 100% ALGODÓN", "garment": "SS",
             "fabric": "100% ALGODÓN", "country": "HND", "qty_expected": 1200},
        ]})
        d = sdb.wms_asn.find_one({"asn_id": "156053-GOD01-A"})
        check("cambiar país recompone (CN → HN)", r.status_code == 200 and d["items"][0]["part_number"] == "GTS-SS100CHN", (r.status_code, d["items"][0].get("part_number")))
        r = await c.put("/api/wms/asn/156053-GOD01-A", json={"customer": "ROCK REBEL", "items": [
            {"line_no": 1, "garment": "HO", "fabric": "50% ALGODON 50% POLIESTER", "country": "NIC", "qty_expected": 1200}]})
        d = sdb.wms_asn.find_one({"asn_id": "156053-GOD01-A"})
        check("cambiar cliente usa el prefijo nuevo (RRB)", d["items"][0]["part_number"] == "RRB-HO50C50PNI", d["items"][0].get("part_number"))
        r = await c.post("/api/wms/asn", json={"asn_id": "X-1", "customer": "SIN PREFIJO SA", "items": [
            {"garment": "SS", "fabric": "100% ALGODON", "country": "CHN", "qty_expected": 5, "part_number": "MANUAL-1"}]})
        it = r.json()["items"][0]
        check("cliente sin prefijo: no compone, conserva el manual", it["part_number"] == "MANUAL-1" and it["part_number_auto"] is False, it)

        print("\n== 5. Modo estricto: composición y país fuera de catálogo → 400 ==")
        r = await c.post("/api/wms/asn", json={"asn_id": "STRICT-1", "customer": "GOODIE TWO SLEEVES", "items": [
            {"garment": "SS", "fabric": "100% ALGODON", "country": "CHN", "qty_expected": 5},
            {"garment": "SS", "fabric": "61% ALGODON 39% POLIESTER", "country": "CHN", "qty_expected": 5},
            {"garment": "SS", "fabric": "100% ALGODON", "country": "XX", "qty_expected": 5},
            {"garment": "SS", "fabric": "100% BAMBU", "country": "MARTE", "qty_expected": 5},
        ]})
        check("cliente con prefijo + valores fuera de catálogo → 400", r.status_code == 400, r.text[:200])
        det = r.json().get("detail", "") if r.status_code == 400 else ""
        check("el 400 nombra línea, valor y pestaña de Configuración",
              "Línea 2" in det and "61% ALGODON 39% POLIESTER" in det and "Composiciones" in det
              and "Línea 3" in det and "'XX'" in det and "Países" in det
              and "Línea 4" in det and "BAMBU" in det and "MARTE" in det and "Línea 1" not in det, det)
        check("el 400 no guardó nada", sdb.wms_asn.count_documents({"asn_id": "STRICT-1"}) == 0)
        r = await c.post("/api/wms/asn", json={"asn_id": "STRICT-2", "customer": "GOODIE TWO SLEEVES", "items": [
            {"garment": "SS", "fabric": "42% poliéster 58% algodón", "country": "china", "qty_expected": 5},
            {"part_number": "5000", "qty_expected": 10, "country": "NIC"},
        ]})
        check("catálogo por código/sin acentos + línea sin composición → 200", r.status_code == 200 and r.json()["items"][0]["part_number"] == "GTS-SS58C42PCN", r.text[:200])
        r = await c.post("/api/wms/asn", json={"asn_id": "STRICT-3", "customer": "SIN PREFIJO SA", "items": [
            {"fabric": "100% BAMBU", "country": "MARTE", "qty_expected": 5, "part_number": "MANUAL-2"}]})
        check("cliente sin prefijo sigue permisivo", r.status_code == 200, r.text[:200])
        r = await c.put("/api/wms/asn/STRICT-2", json={"items": [
            {"line_no": 1, "garment": "SS", "fabric": "61% ALGODON 39% POLIESTER", "country": "CHN", "qty_expected": 5}]})
        check("PUT en entrada formateada también valida → 400", r.status_code == 400 and "61% ALGODON" in r.text, r.text[:200])
        sdb.wms_asn.insert_one({"asn_id": "LEGACY-1", "customer": "GOODIE TWO SLEEVES", "status": "pending", "items": [
            {"line_no": 1, "part_number": "5000", "description": "MENS SS", "fabric": "100% BAMBU", "country": "MARTE", "qty_expected": 10, "qty_received": 0}]})
        r = await c.put("/api/wms/asn/LEGACY-1", json={"po_number": "PO-9", "items": [
            {"line_no": 1, "part_number": "5000", "description": "MENS SS", "fabric": "100% BAMBU", "country": "MARTE", "qty_expected": 12}]})
        check("PUT en entrada VIEJA (sin número compuesto) sigue permisivo", r.status_code == 200, r.text[:200])
        r = await c.put("/api/wms/asn/part-number/config", json={"compositions": ["61% ALGODON 39% POLIESTER"]})
        check("agregar la composición al catálogo…", r.status_code == 200)
        r = await c.put("/api/wms/asn/STRICT-2", json={"items": [
            {"line_no": 1, "garment": "SS", "fabric": "61% ALGODON 39% POLIESTER", "country": "CHN", "qty_expected": 5}]})
        check("…y la misma línea ya entra (GTS-SS61C39PCN)", r.status_code == 200 and r.json()["items"][0]["part_number"] == "GTS-SS61C39PCN", r.text[:200])

    print(f"\n===== {ok} PASS / {fail} FAIL =====")
    raw.drop_database(SMOKE_DB)
    print(f"base {SMOKE_DB} eliminada")
    sys.exit(1 if fail else 0)


if __name__ == "__main__":
    asyncio.run(main())
