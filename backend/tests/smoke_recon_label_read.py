"""Smoke: /wms/recon/label-read — lectura de la etiqueta para el modal de captura.
Lo que fija:
  - la respuesta SIEMPRE trae todos los campos (los ilegibles vienen vacíos), así
    el modal se puede pintar pase lo que pase,
  - los barcodes mandan en `carton` y `sku`, y quedan marcados como fuente
    "barcode" (son los campos de identidad: ahí no se admite un dato inferido),
  - si la lectura por visión no está configurada, NO truena: avisa y deja que el
    operador capture a mano,
  - un archivo que no es imagen da 400 con mensaje claro (no un modal en blanco),
  - sin sesión no se puede usar; el endpoint no escribe nada.

Con ANTHROPIC_API_KEY presente prueba además la lectura completa por visión;
sin ella verifica la degradación, que es el caso que se ve en una PDA sin
configurar.

SEGURIDAD: base DESECHABLE, se niega contra prod, se borra al terminar.
USO: set MONGODB_URL=... ; backend/venv/Scripts/python.exe backend/tests/smoke_recon_label_read.py
"""
import asyncio
import io
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
from PIL import Image  # noqa: E402

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

raw = pymongo.MongoClient(MONGO)
sdb = raw[SMOKE_DB]
ok = fail = 0

CARTON = "A2524611066"
SKU = "71603"
FOTO = os.environ.get("LABEL_FOTO", r"C:\Users\gerar\Downloads\foto buena.png")


def check(n, cond, det=""):
    global ok, fail
    if cond:
        ok += 1; print(f"   PASS  {n}")
    else:
        fail += 1; print(f"   FAIL  {n}  {det}")


def blanco() -> bytes:
    buf = io.BytesIO()
    Image.new("L", (800, 600), 255).save(buf, format="PNG")
    return buf.getvalue()


def sembrar():
    print(f"== Sembrando {SMOKE_DB} ==")
    for c in ["users", "user_sessions", "wms_photo_lines", "wms_movements"]:
        sdb[c].delete_many({})
    sdb.users.insert_one({
        "user_id": "u_pick", "email": "p1@test.local", "name": "Picker",
        "password_hash": bcrypt.hash("pk123"), "role": "picker", "active": True,
    })


def foto(c, data, nombre="etiqueta.png", tipo="image/png"):
    return c.post("/api/wms/recon/label-read", files={"file": (nombre, data, tipo)})


async def main():
    sembrar()
    from httpx import ASGITransport, AsyncClient
    from server import app
    from services.label_ocr import CAMPOS, ocr_disponible

    con_ocr = ocr_disponible()
    print(f"\n== OCR local: {'disponible' if con_ocr else 'NO disponible'} ==")

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://smoke") as c:
        r = await foto(c, blanco())
        check("sin login -> 401/403", r.status_code in (401, 403), f"{r.status_code}")

        r = await c.post("/api/auth/login", json={"email": "p1@test.local", "password": "pk123"})
        check("login picker", r.status_code == 200, f"{r.status_code}")

        print("\n== etiqueta real ==")
        if not os.path.exists(FOTO):
            check(f"existe {os.path.basename(FOTO)}", False, "no encontrada — set LABEL_FOTO")
        else:
            r = await foto(c, open(FOTO, "rb").read(), os.path.basename(FOTO), "image/png")
            d = r.json() if r.status_code == 200 else {}
            campos, fuentes = d.get("campos", {}), d.get("fuentes", {})
            check("responde 200", r.status_code == 200, f"{r.status_code} {r.text[:160]}")
            check("trae TODOS los campos del modal",
                  set(campos) == set(CAMPOS), f"faltan={set(CAMPOS) - set(campos)}")
            check(f"carton == {CARTON}", campos.get("carton") == CARTON, f"{campos.get('carton')!r}")
            check(f"sku == {SKU}", campos.get("sku") == SKU, f"{campos.get('sku')!r}")
            check("carton marcado como leído del barcode", fuentes.get("carton") == "barcode",
                  f"{fuentes.get('carton')!r}")
            check("sku marcado como leído del barcode", fuentes.get("sku") == "barcode",
                  f"{fuentes.get('sku')!r}")
            if con_ocr:
                check("lee el style", campos.get("style") == "5000", f"{campos.get('style')!r}")
                check("lee el color", campos.get("color", "").upper() == "NAVY",
                      f"{campos.get('color')!r}")
                check("lee el tipo de prenda", "SHIRT" in campos.get("description", "").upper(),
                      f"{campos.get('description')!r}")
                check("lee el país de origen",
                      "DOMINICANA" in campos.get("country_of_origin", "").upper(),
                      f"{campos.get('country_of_origin')!r}")
                check("lee el porcentaje de tela", "COTTON" in campos.get("fabric_content", "").upper(),
                      f"{campos.get('fabric_content')!r}")
                check("lee la cantidad", campos.get("units") == "72", f"{campos.get('units')!r}")
                check("los campos de texto se marcan como leídos por OCR",
                      fuentes.get("style") == "ocr", f"{fuentes.get('style')!r}")
            else:
                check("sin Tesseract avisa y no inventa",
                      any("mano" in a.lower() for a in d.get("avisos", [])) and not campos.get("style"),
                      f"{d.get('avisos')} style={campos.get('style')!r}")

        print("\n== imagen sin nada legible ==")
        r = await foto(c, blanco())
        d = r.json() if r.status_code == 200 else {}
        check("responde 200 (no rompe)", r.status_code == 200, f"{r.status_code} {r.text[:160]}")
        check("no inventa cartón", not d.get("campos", {}).get("carton"), f"{d.get('campos')}")
        check("avisa que no se pudo leer y qué hacer",
              any("foto de frente" in a.lower() for a in d.get("avisos", [])), f"{d.get('avisos')}")
        # Los códigos de barras son opcionales: su ausencia NO se le reclama al
        # operador, porque no es algo que pueda resolver.
        check("no reclama códigos de barras",
              not any("código de barras" in a.lower() for a in d.get("avisos", [])),
              f"{d.get('avisos')}")

        print("\n== entradas inválidas ==")
        r = await foto(c, b"esto no es una imagen", "nota.txt", "text/plain")
        check("archivo no-imagen -> 400", r.status_code == 400, f"{r.status_code} {r.text[:120]}")
        check("el 400 explica qué pasó", "imagen" in r.text.lower(), f"{r.text[:120]}")
        r = await foto(c, b"", "vacia.png")
        check("foto vacía -> 400", r.status_code == 400, f"{r.status_code}")

        print("\n== la lectura no escribe nada ==")
        check("no crea renglones", sdb.wms_photo_lines.count_documents({}) == 0)
        check("no deja movimientos", sdb.wms_movements.count_documents({}) == 0)


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
