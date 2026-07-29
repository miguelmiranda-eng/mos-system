"""Smoke: renglones de "Inventario por foto" (/wms/recon/photo/*).
Fija lo que puede salir caro si se rompe:
  - el mismo cartón NO se cuenta dos veces (ni entre operadores distintos),
  - una cantidad inválida no entra,
  - el SKU sin país/contenido aparece como "sin catalogar" (bloquea la salida),
  - el catálogo de material NO lo edita un picker, y no se guarda incompleto,
  - un operador borra lo suyo pero NO lo de otro,
  - la herramienta jamás escribe en wms_boxes / wms_inventory.

SEGURIDAD: base DESECHABLE, se niega contra prod, se borra al terminar.
USO: set MONGODB_URL=... ; backend/venv/Scripts/python.exe backend/tests/smoke_recon_photo_lines.py
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

LOTE = "RP-GEN"
CARTON = "A2524611066"
CARTON2 = "A2524611099"
SKU = "71603"


def check(n, cond, det=""):
    global ok, fail
    if cond:
        ok += 1; print(f"   PASS  {n}")
    else:
        fail += 1; print(f"   FAIL  {n}  {det}")


def sembrar():
    print(f"== Sembrando {SMOKE_DB} ==")
    for c in ["users", "user_sessions", "wms_photo_lines", "wms_photo_skus",
              "wms_boxes", "wms_inventory", "wms_movements"]:
        sdb[c].delete_many({})
    sdb.users.insert_many([
        {"user_id": "u_p1", "email": "p1@test.local", "name": "Picker Uno",
         "password_hash": bcrypt.hash("pk123"), "role": "picker", "active": True},
        {"user_id": "u_p2", "email": "p2@test.local", "name": "Picker Dos",
         "password_hash": bcrypt.hash("pk123"), "role": "picker", "active": True},
        {"user_id": "u_su", "email": "su@test.local", "name": "Super",
         "password_hash": bcrypt.hash("su123"), "role": "supersu", "active": True},
    ])


async def main():
    sembrar()
    from httpx import ASGITransport, AsyncClient
    from server import app
    tr = ASGITransport(app=app)

    async with AsyncClient(transport=tr, base_url="http://smoke") as p1, \
               AsyncClient(transport=tr, base_url="http://smoke") as p2, \
               AsyncClient(transport=tr, base_url="http://smoke") as su:
        for c, mail, pw, quien in ((p1, "p1@test.local", "pk123", "picker 1"),
                                   (p2, "p2@test.local", "pk123", "picker 2"),
                                   (su, "su@test.local", "su123", "supersu")):
            r = await c.post("/api/auth/login", json={"email": mail, "password": pw})
            check(f"login {quien}", r.status_code == 200, f"{r.status_code}")

        print("\n== captura de un renglón ==")
        r = await p1.post("/api/wms/recon/photo/line",
                          json={"carton": CARTON, "sku": SKU, "units": 72, "lote": LOTE})
        d = r.json() if r.status_code == 200 else {}
        check("picker captura (200 ok:true)", r.status_code == 200 and d.get("ok") is True,
              f"{r.status_code} {r.text[:160]}")
        check("guarda cantidad y cartón", (d.get("line") or {}).get("units") == 72
              and (d.get("line") or {}).get("carton") == CARTON, f"{d.get('line')}")
        check("avisa que el SKU no está catalogado", d.get("sku_catalogado") is False, f"{d}")

        print("\n== doble conteo: el mismo cartón NO entra dos veces ==")
        r = await p1.post("/api/wms/recon/photo/line",
                          json={"carton": CARTON, "sku": SKU, "units": 40, "lote": LOTE})
        d = r.json() if r.status_code == 200 else {}
        check("mismo operador -> duplicado:true", d.get("duplicado") is True, f"{r.text[:160]}")
        r = await p2.post("/api/wms/recon/photo/line",
                          json={"carton": CARTON, "sku": SKU, "units": 99, "lote": LOTE})
        d = r.json() if r.status_code == 200 else {}
        check("OTRO operador -> duplicado:true", d.get("duplicado") is True, f"{r.text[:160]}")
        n = sdb.wms_photo_lines.count_documents({"lote": LOTE, "carton": CARTON})
        check("sigue habiendo UN solo renglón", n == 1, f"n={n}")
        b = sdb.wms_photo_lines.find_one({"carton": CARTON})
        check("el duplicado NO pisó la cantidad original", b.get("units") == 72, f"units={b.get('units')}")

        print("\n== cantidades inválidas ==")
        for bad in (0, -5, "muchas", None):
            r = await p1.post("/api/wms/recon/photo/line",
                              json={"carton": f"A99{bad}", "sku": SKU, "units": bad, "lote": LOTE})
            check(f"units={bad!r} -> 400", r.status_code == 400, f"{r.status_code}")

        print("\n== resumen y SKU pendientes ==")
        await p1.post("/api/wms/recon/photo/line",
                      json={"carton": CARTON2, "sku": SKU, "units": 24, "lote": LOTE})
        r = await p1.get("/api/wms/recon/photo/lines", params={"lote": LOTE})
        d = r.json() if r.status_code == 200 else {}
        res = d.get("resumen", {})
        check("2 cartones / 96 unidades / 1 sku",
              res.get("cartones") == 2 and res.get("unidades") == 96 and res.get("skus") == 1, f"{res}")
        check("el SKU aparece como pendiente de catalogar",
              res.get("skus_sin_catalogar") == [SKU], f"{res.get('skus_sin_catalogar')}")

        # La PDA pide pocas líneas para ir ligera: el total NO puede venir de la
        # página, o el contador de piso mentiría.
        r = await p1.get("/api/wms/recon/photo/lines", params={"lote": LOTE, "limit": 1})
        d = r.json() if r.status_code == 200 else {}
        check("con limit=1 devuelve 1 línea", len(d.get("lines", [])) == 1, f"{len(d.get('lines', []))}")
        check("pero el resumen sigue siendo del lote completo (2 / 96)",
              d.get("resumen", {}).get("cartones") == 2 and d.get("resumen", {}).get("unidades") == 96,
              f"{d.get('resumen')}")

        print("\n== catálogo de material (país y contenido) ==")
        r = await p1.post("/api/wms/recon/photo/sku", json={"sku": SKU, "country_of_origin": "HONDURAS",
                                                           "fabric_content": "100% COTTON"})
        check("un picker NO edita el catálogo (403)", r.status_code == 403, f"{r.status_code}")

        r = await su.post("/api/wms/recon/photo/sku", json={"sku": SKU, "style": "5000", "color": "BLACK"})
        check("sin país/contenido -> 400", r.status_code == 400, f"{r.status_code} {r.text[:140]}")

        r = await su.post("/api/wms/recon/photo/sku", json={
            "sku": SKU, "style": "5000", "color": "BLACK", "size": "L",
            "country_of_origin": "HONDURAS", "fabric_content": "100% COTTON",
            "customer": "GLO", "manufacturer": "GILDAN"})
        check("supersu con todo -> 200", r.status_code == 200, f"{r.status_code} {r.text[:140]}")

        r = await p1.get("/api/wms/recon/photo/lines", params={"lote": LOTE})
        d = r.json() if r.status_code == 200 else {}
        check("ya no quedan SKU pendientes",
              d.get("resumen", {}).get("skus_sin_catalogar") == [], f"{d.get('resumen')}")
        l0 = (d.get("lines") or [{}])[0]
        check("el renglón trae el material para el Excel",
              (l0.get("sku_info") or {}).get("country_of_origin") == "HONDURAS",
              f"{l0.get('sku_info')}")

        print("\n== borrar renglones ==")
        lid = sdb.wms_photo_lines.find_one({"carton": CARTON2})["line_id"]
        r = await p2.delete(f"/api/wms/recon/photo/line/{lid}")
        check("un picker NO borra el renglón de otro (403)", r.status_code == 403, f"{r.status_code}")
        r = await p1.delete(f"/api/wms/recon/photo/line/{lid}")
        check("el que capturó sí puede borrarlo", r.status_code == 200, f"{r.status_code} {r.text[:140]}")
        check("el renglón se fue", sdb.wms_photo_lines.count_documents({"carton": CARTON2}) == 0)
        lid1 = sdb.wms_photo_lines.find_one({"carton": CARTON})["line_id"]
        r = await su.delete(f"/api/wms/recon/photo/line/{lid1}")
        check("administración borra cualquiera", r.status_code == 200, f"{r.status_code}")

        print("\n== la herramienta no toca el inventario ==")
        check("wms_boxes intacto", sdb.wms_boxes.count_documents({}) == 0)
        check("wms_inventory intacto", sdb.wms_inventory.count_documents({}) == 0)


_err = None
try:
    asyncio.run(main())
except Exception:
    import traceback
    _err = traceback.format_exc()
finally:
    try:
        raw.drop_database(SMOKE_DB)
    except Exception:
        pass
    print(f"\n== Base {SMOKE_DB} eliminada ==")
    if _err:
        print("EXCEPCIÓN:\n" + _err)
    print(f"{ok} PASS · {fail} FAIL")
    sys.exit(1 if (fail or _err) else 0)
