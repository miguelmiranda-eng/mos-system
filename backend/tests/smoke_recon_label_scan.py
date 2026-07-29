"""Smoke: /wms/recon/label-scan — lectura de etiqueta de cartón por barcode.
Fija:
  - sin sesión -> no autorizado (no es un endpoint abierto),
  - un PICKER sí puede usarlo (va liberado como el resto de conciliación),
  - una etiqueta con sus dos CODE39 -> ok:true con carton y SKU EXACTOS,
  - la clasificación no depende del orden: el A######### es el cartón aunque
    zbar lo devuelva después,
  - etiqueta girada 90° (foto de lado) -> igual la lee,
  - imagen sin barcodes -> ok:false con mensaje, NO 500 y NO inventa datos,
  - archivo que no es imagen / foto vacía -> 400.

Las etiquetas se generan aquí mismo (CODE39 dibujado con PIL), así el smoke no
depende de fotos sueltas en disco. Para probar además con fotos reales:
  set LABEL_FOTOS=C:\\ruta\\foto1.png;C:\\ruta\\foto2.jpg

SEGURIDAD: base DESECHABLE, se niega contra prod, se borra al terminar.
USO: set MONGODB_URL=... ; backend/venv/Scripts/python.exe backend/tests/smoke_recon_label_scan.py
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
from PIL import Image, ImageDraw  # noqa: E402

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

raw = pymongo.MongoClient(MONGO)
sdb = raw[SMOKE_DB]
ok = fail = 0

CARTON = "A2524611066"      # barcode superior real de la etiqueta Quasar
SKU = "71603"               # barcode inferior real

# CODE39: cada carácter son 9 elementos (barra/espacio alternando, empieza en
# barra); n = angosto, w = ancho. '*' es el delimitador de arranque y cierre.
_C39 = {
    "0": "nnnwwnwnn", "1": "wnnwnnnnw", "2": "nnwwnnnnw", "3": "wnwwnnnnn",
    "4": "nnnwwnnnw", "5": "wnnwwnnnn", "6": "nnwwwnnnn", "7": "nnnwnnwnw",
    "8": "wnnwnnwnn", "9": "nnwwnnwnn", "A": "wnnnnwnnw", "B": "nnwnnwnnw",
    "C": "wnwnnwnnn", "D": "nnnnwwnnw", "E": "wnnnwwnnn", "F": "nnwnwwnnn",
    "G": "nnnnnwwnw", "H": "wnnnnwwnn", "I": "nnwnnwwnn", "J": "nnnnwwwnn",
    "K": "wnnnnnnww", "L": "nnwnnnnww", "M": "wnwnnnnwn", "N": "nnnnwnnww",
    "O": "wnnnwnnwn", "P": "nnwnwnnwn", "Q": "nnnnnnwww", "R": "wnnnnnwwn",
    "S": "nnwnnnwwn", "T": "nnnnwnwwn", "U": "wwnnnnnnw", "V": "nwwnnnnnw",
    "W": "wwwnnnnnn", "X": "nwnnwnnnw", "Y": "wwnnwnnnn", "Z": "nwwnwnnnn",
    "-": "nwnnnnwnw", ".": "wwnnnnwnn", " ": "nwwnnnwnn", "*": "nwnnwnwnn",
}
NARROW, WIDE, ALTO, QUIET = 3, 9, 120, 40


def code39(texto: str) -> Image.Image:
    """Dibuja `texto` como un CODE39 legible por zbar."""
    tramos = []
    for ch in f"*{texto.upper()}*":
        patron = _C39[ch]
        for i, e in enumerate(patron):
            tramos.append((i % 2 == 0, WIDE if e == "w" else NARROW))  # par = barra
        tramos.append((False, NARROW))                                  # separador
    ancho = QUIET * 2 + sum(w for _, w in tramos)
    img = Image.new("L", (ancho, ALTO + 20), 255)
    d = ImageDraw.Draw(img)
    x = QUIET
    for barra, w in tramos:
        if barra:
            d.rectangle([x, 10, x + w - 1, 10 + ALTO], fill=0)
        x += w
    return img


def etiqueta(arriba: str, abajo: str, rot: int = 0) -> bytes:
    """Etiqueta sintética: barcode de cartón arriba, de SKU abajo."""
    a, b = code39(arriba), code39(abajo)
    W = max(a.width, b.width) + 60
    H = a.height + b.height + 180
    img = Image.new("L", (W, H), 255)
    img.paste(a, ((W - a.width) // 2, 40))
    img.paste(b, ((W - b.width) // 2, 40 + a.height + 100))
    if rot:
        img = img.rotate(rot, expand=True, fillcolor=255)
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


def blanco() -> bytes:
    buf = io.BytesIO()
    Image.new("L", (800, 600), 255).save(buf, format="PNG")
    return buf.getvalue()


def check(n, cond, det=""):
    global ok, fail
    if cond:
        ok += 1; print(f"   PASS  {n}")
    else:
        fail += 1; print(f"   FAIL  {n}  {det}")


def sembrar():
    print(f"== Sembrando {SMOKE_DB} ==")
    for c in ["users", "user_sessions", "wms_movements", "config_options"]:
        sdb[c].delete_many({})
    sdb.users.insert_one({
        "user_id": "u_pick", "email": "picker@test.local", "name": "Picker",
        "password_hash": bcrypt.hash("pk123"), "role": "picker", "active": True,
    })


def foto(c, png, nombre="etiqueta.png", tipo="image/png"):
    return c.post("/api/wms/recon/label-scan", files={"file": (nombre, png, tipo)})


async def main():
    sembrar()
    from httpx import ASGITransport, AsyncClient
    from server import app

    # El motor debe estar disponible; si no, el resto del smoke no prueba nada.
    from services.label_barcode import barcode_disponible, motor_error
    check("pyzbar/libzbar disponible", barcode_disponible(), motor_error())
    if not barcode_disponible():
        return

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://smoke") as c:
        print("\n== sin sesión: no autorizado ==")
        r = await foto(c, etiqueta(CARTON, SKU))
        check("sin login -> 401/403", r.status_code in (401, 403), f"{r.status_code} {r.text[:120]}")

        r = await c.post("/api/auth/login", json={"email": "picker@test.local", "password": "pk123"})
        check("login picker", r.status_code == 200, f"{r.status_code}")

        print("\n== etiqueta normal: los dos códigos, exactos ==")
        r = await foto(c, etiqueta(CARTON, SKU))
        d = r.json() if r.status_code == 200 else {}
        check("picker autorizado (200)", r.status_code == 200, f"{r.status_code} {r.text[:160]}")
        check("ok:true", d.get("ok") is True, f"{d}")
        check(f"carton == {CARTON}", d.get("carton") == CARTON, f"carton={d.get('carton')!r}")
        check(f"sku == {SKU}", d.get("sku") == SKU, f"sku={d.get('sku')!r}")

        print("\n== invertida: el A######### sigue siendo el cartón ==")
        r = await foto(c, etiqueta(SKU, CARTON))   # SKU arriba, cartón abajo
        d = r.json() if r.status_code == 200 else {}
        check("clasifica por forma, no por posición",
              d.get("carton") == CARTON and d.get("sku") == SKU,
              f"carton={d.get('carton')!r} sku={d.get('sku')!r}")

        print("\n== foto de lado (90°) ==")
        r = await foto(c, etiqueta(CARTON, SKU, rot=90))
        d = r.json() if r.status_code == 200 else {}
        check("etiqueta girada -> igual la lee",
              d.get("ok") is True and d.get("carton") == CARTON and d.get("sku") == SKU,
              f"{ {k: d.get(k) for k in ('ok', 'carton', 'sku', 'variante')} }")

        print("\n== casos que NO deben inventar datos ==")
        r = await foto(c, blanco())
        d = r.json() if r.status_code == 200 else {}
        check("imagen sin barcode -> 200 ok:false (no 500)",
              r.status_code == 200 and d.get("ok") is False, f"{r.status_code} {r.text[:160]}")
        check("sin barcode no devuelve carton ni sku",
              not d.get("carton") and not d.get("sku"), f"{d}")
        check("sin barcode explica qué hacer", bool(d.get("error")), f"{d}")

        r = await foto(c, b"esto no es una imagen", "nota.txt", "text/plain")
        check("archivo no-imagen -> 400", r.status_code == 400, f"{r.status_code} {r.text[:120]}")

        r = await foto(c, b"", "vacia.png")
        check("foto vacía -> 400", r.status_code == 400, f"{r.status_code} {r.text[:120]}")

        print("\n== la lectura no escribe nada en la base ==")
        check("no deja movimientos", sdb.wms_movements.count_documents({}) == 0,
              f"movs={sdb.wms_movements.count_documents({})}")

        rutas = os.environ.get("LABEL_FOTOS", "")
        if rutas:
            print("\n== fotos reales ==")
            for p in [x for x in rutas.split(";") if x.strip()]:
                if not os.path.exists(p):
                    check(f"existe {os.path.basename(p)}", False, "no encontrada"); continue
                r = await foto(c, open(p, "rb").read(), os.path.basename(p), "image/jpeg")
                d = r.json() if r.status_code == 200 else {}
                check(f"{os.path.basename(p)} -> {CARTON}/{SKU}",
                      d.get("carton") == CARTON and d.get("sku") == SKU,
                      f"{ {k: d.get(k) for k in ('ok', 'carton', 'sku', 'variante')} }")


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
