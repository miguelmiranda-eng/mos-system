"""Smoke: renglones de "Inventario por foto" (/wms/recon/photo/*).
Este material sale del país, así que lo que se fija aquí es lo que puede salir
caro si se rompe:
  - el mismo cartón NO se cuenta dos veces (ni entre operadores distintos),
  - una cantidad inválida o un cartón vacío no entran,
  - el renglón guarda TODO el material de la etiqueta (no depende de catálogos),
  - los renglones sin país de origen / contenido quedan marcados para que no se
    exporte un manifiesto con huecos aduanales,
  - un operador corrige y borra lo suyo, pero NO lo de otro,
  - el resumen es del contenedor completo aunque la PDA pida pocas líneas,
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

CONT = "CONTENEDOR 1"
CARTON = "A2524611066"
CARTON2 = "A2524611099"
CARTON3 = "A2524611100"

ETIQUETA = {
    "sku": "71603", "style": "5000", "color": "BLACK", "size": "L",
    "description": "T-SHIRT", "country_of_origin": "HONDURAS",
    "fabric_content": "100% COTTON", "customer": "GLO", "manufacturer": "GILDAN",
    "dozens": "6", "pieces": "72",
}


def check(n, cond, det=""):
    global ok, fail
    if cond:
        ok += 1; print(f"   PASS  {n}")
    else:
        fail += 1; print(f"   FAIL  {n}  {det}")


def sembrar():
    print(f"== Sembrando {SMOKE_DB} ==")
    for c in ["users", "user_sessions", "wms_photo_lines",
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
    L = "/api/wms/recon/photo/line"

    async with AsyncClient(transport=tr, base_url="http://smoke") as p1, \
               AsyncClient(transport=tr, base_url="http://smoke") as p2, \
               AsyncClient(transport=tr, base_url="http://smoke") as su:
        for c, mail, pw, quien in ((p1, "p1@test.local", "pk123", "picker 1"),
                                   (p2, "p2@test.local", "pk123", "picker 2"),
                                   (su, "su@test.local", "su123", "supersu")):
            r = await c.post("/api/auth/login", json={"email": mail, "password": pw})
            check(f"login {quien}", r.status_code == 200, f"{r.status_code}")

        print("\n== captura de un cartón con toda su etiqueta ==")
        r = await p1.post(L, json={"container": CONT, "carton": CARTON, "units": 72, **ETIQUETA})
        d = r.json() if r.status_code == 200 else {}
        line = d.get("line") or {}
        check("picker captura (200 ok:true)", r.status_code == 200 and d.get("ok") is True,
              f"{r.status_code} {r.text[:160]}")
        check("guarda cantidad y cartón", line.get("units") == 72 and line.get("carton") == CARTON,
              f"{line}")
        check("guarda el material completo de la etiqueta",
              all(line.get(k) == v for k, v in ETIQUETA.items()),
              f"{ {k: line.get(k) for k in ETIQUETA} }")
        check("marcado como completo (tiene país y contenido)", line.get("completo") is True, f"{line}")

        print("\n== doble conteo: el mismo cartón NO entra dos veces ==")
        r = await p1.post(L, json={"container": CONT, "carton": CARTON, "units": 40})
        check("mismo operador -> duplicado:true", r.json().get("duplicado") is True, f"{r.text[:160]}")
        r = await p2.post(L, json={"container": CONT, "carton": CARTON, "units": 99})
        check("OTRO operador -> duplicado:true", r.json().get("duplicado") is True, f"{r.text[:160]}")
        n = sdb.wms_photo_lines.count_documents({"container": CONT, "carton": CARTON})
        check("sigue habiendo UN solo renglón", n == 1, f"n={n}")
        check("el duplicado NO pisó la cantidad original",
              sdb.wms_photo_lines.find_one({"carton": CARTON}).get("units") == 72)

        print("\n== capturas inválidas ==")
        for bad in (0, -5, "muchas", None):
            r = await p1.post(L, json={"container": CONT, "carton": f"A99{bad}", "units": bad})
            check(f"units={bad!r} -> 400", r.status_code == 400, f"{r.status_code}")
        r = await p1.post(L, json={"container": CONT, "carton": "  ", "units": 10})
        check("cartón vacío -> 400", r.status_code == 400, f"{r.status_code}")

        print("\n== renglón sin datos aduanales: entra, pero queda marcado ==")
        r = await p1.post(L, json={"container": CONT, "carton": CARTON2, "units": 24, "style": "2000"})
        d = r.json() if r.status_code == 200 else {}
        check("se guarda igual (no frena al piso)", d.get("ok") is True, f"{r.text[:160]}")
        check("completo:false (falta país/contenido)", (d.get("line") or {}).get("completo") is False,
              f"{d.get('line')}")

        print("\n== resumen del contenedor ==")
        r = await p1.get("/api/wms/recon/photo/lines", params={"container": CONT})
        res = (r.json() if r.status_code == 200 else {}).get("resumen", {})
        check("2 cartones / 96 unidades / 1 sin aduana",
              res.get("cartones") == 2 and res.get("unidades") == 96 and res.get("sin_aduana") == 1,
              f"{res}")
        r = await p1.get("/api/wms/recon/photo/lines", params={"container": CONT, "limit": 1})
        d = r.json() if r.status_code == 200 else {}
        check("con limit=1 devuelve 1 línea", len(d.get("lines", [])) == 1, f"{len(d.get('lines', []))}")
        check("pero el resumen sigue siendo del contenedor completo",
              d.get("resumen", {}).get("cartones") == 2 and d.get("resumen", {}).get("unidades") == 96,
              f"{d.get('resumen')}")

        print("\n== corregir un renglón mal confirmado ==")
        lid2 = sdb.wms_photo_lines.find_one({"carton": CARTON2})["line_id"]
        r = await p2.put(f"{L}/{lid2}", json={"units": 30})
        check("un picker NO corrige el renglón de otro (403)", r.status_code == 403, f"{r.status_code}")
        r = await p1.put(f"{L}/{lid2}", json={"units": 30, "country_of_origin": "NICARAGUA",
                                             "fabric_content": "50% COTTON 50% POLY"})
        d = r.json() if r.status_code == 200 else {}
        check("el que capturó sí puede corregirlo", r.status_code == 200, f"{r.status_code} {r.text[:140]}")
        check("la corrección se guardó", (d.get("line") or {}).get("units") == 30, f"{d.get('line')}")
        check("al completar aduana pasa a completo:true", (d.get("line") or {}).get("completo") is True,
              f"{d.get('line')}")
        r = await p1.get("/api/wms/recon/photo/lines", params={"container": CONT})
        check("ya no quedan renglones sin aduana",
              r.json().get("resumen", {}).get("sin_aduana") == 0, f"{r.json().get('resumen')}")

        print("\n== contenedores separados: el mismo cartón puede ir en otro ==")
        r = await p1.post(L, json={"container": "CONTENEDOR 2", "carton": CARTON, "units": 12})
        check("mismo cartón en OTRO contenedor -> se permite", r.json().get("ok") is True, f"{r.text[:160]}")
        r = await p1.get("/api/wms/recon/photo/lines", params={"container": CONT})
        check("y no contamina el resumen del primero",
              r.json().get("resumen", {}).get("cartones") == 2, f"{r.json().get('resumen')}")

        print("\n== borrar renglones ==")
        r = await p1.post(L, json={"container": CONT, "carton": CARTON3, "units": 5})
        lid3 = r.json()["line"]["line_id"]
        r = await p2.delete(f"{L}/{lid3}")
        check("un picker NO borra el renglón de otro (403)", r.status_code == 403, f"{r.status_code}")
        r = await p1.delete(f"{L}/{lid3}")
        check("el que capturó sí puede borrarlo", r.status_code == 200, f"{r.status_code}")
        check("el renglón se fue", sdb.wms_photo_lines.count_documents({"carton": CARTON3}) == 0)
        r = await su.delete(f"{L}/{lid2}")
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
