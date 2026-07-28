"""Smoke: conciliación de cajas LPN por la PDA (liberada a pickers).
Fija:
  - un PICKER puede usar los endpoints de recon (liberado),
  - resolve-scan de un LPN físico SIN ligar -> matched:false + candidatos,
  - bind-lpn liga el LPN a la caja placeholder elegida,
  - resolve-scan del mismo LPN -> ahora matched:true (misma ubicación),
  - recon/commit YA NO bloquea por LPN y cuenta la caja LPN como presente,
  - una caja LPN NO escaneada cae en faltantes (no se cuenta).

SEGURIDAD: base DESECHABLE, se niega contra prod, se borra al terminar.
USO: set MONGODB_URL=... ; backend/venv/Scripts/python.exe backend/tests/smoke_recon_lpn.py
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

LOC = "LP01-A01"
LPNBOX = "LPN_ABC123"       # caja placeholder (box_id LPN, sin physical_lpn)
LPNBOX2 = "LPN_DEF456"      # otra placeholder que NO se escaneará (debe faltar)
PHYS = "A2600510001"       # etiqueta física real del cartón
STYLE, COLOR, SIZE = "STY5000", "BLACK", "M"


def check(n, cond, det=""):
    global ok, fail
    if cond:
        ok += 1; print(f"   PASS  {n}")
    else:
        fail += 1; print(f"   FAIL  {n}  {det}")


def sembrar():
    print(f"== Sembrando {SMOKE_DB} ==")
    for c in ["users", "user_sessions", "wms_boxes", "wms_inventory", "wms_locations",
              "wms_reconciled_locations", "wms_recon_bak", "wms_movements", "config_options"]:
        sdb[c].delete_many({})
    sdb.users.insert_one({
        "user_id": "u_pick", "email": "picker@test.local", "name": "Picker",
        "password_hash": bcrypt.hash("pk123"), "role": "picker", "active": True,
    })
    sdb.wms_locations.insert_one({"name": LOC})
    for bid in (LPNBOX, LPNBOX2):
        sdb.wms_boxes.insert_one({
            "box_id": bid, "barcode": bid, "lpn_id": bid, "location": LOC,
            "style": STYLE, "sku": STYLE, "color": COLOR, "size": SIZE,
            "units": 40, "qty": 40, "status": "located", "state": "located",
            "customer": "CLIENTE X", "country_of_origin": "REP DOM", "fabric_content": "100% COTTON",
        })


async def main():
    sembrar()
    from httpx import ASGITransport, AsyncClient
    from server import app
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://smoke") as c:
        r = await c.post("/api/auth/login", json={"email": "picker@test.local", "password": "pk123"})
        check("login picker", r.status_code == 200, f"{r.status_code}")

        print("\n== picker liberado: recon/location responde (no 403) ==")
        r = await c.get(f"/api/wms/recon/location/{LOC}")
        check("picker puede leer la ubicación (no 403)", r.status_code == 200, f"{r.status_code} {r.text[:120]}")

        print("\n== resolve-scan de LPN físico SIN ligar -> candidatos ==")
        r = await c.post("/api/wms/recon/resolve-scan", json={"location": LOC, "code": PHYS})
        d = r.json() if r.status_code == 200 else {}
        cand_ids = [x.get("box_id") for x in d.get("candidates", [])]
        check("resolve sin ligar -> matched:false", r.status_code == 200 and d.get("matched") is False, f"{r.status_code} {r.text[:160]}")
        check("candidatos incluyen las placeholder", LPNBOX in cand_ids and LPNBOX2 in cand_ids, f"cands={cand_ids}")

        print("\n== bind-lpn liga el LPN a la caja elegida ==")
        r = await c.post("/api/wms/recon/bind-lpn", json={"location": LOC, "lpn": PHYS, "box_id": LPNBOX})
        check("bind-lpn ok", r.status_code == 200 and r.json().get("status") == "ok", f"{r.status_code} {r.text[:160]}")
        b = sdb.wms_boxes.find_one({"box_id": LPNBOX})
        check("la caja quedó con physical_lpn", (b.get("physical_lpn") or "").upper() == PHYS, f"pl={b.get('physical_lpn')}")

        print("\n== resolve-scan del mismo LPN -> ahora matched:true ==")
        r = await c.post("/api/wms/recon/resolve-scan", json={"location": LOC, "code": PHYS})
        d = r.json() if r.status_code == 200 else {}
        check("resolve ligado -> matched:true a la caja correcta",
              d.get("matched") is True and d.get("box_id") == LPNBOX and d.get("here") is True, f"{r.text[:180]}")

        print("\n== commit YA NO bloquea por LPN; cuenta la escaneada, la otra falta ==")
        r = await c.post("/api/wms/recon/commit", json={"location": LOC, "scanned_box_ids": [LPNBOX]})
        check("commit no bloquea (200)", r.status_code == 200, f"{r.status_code} {r.text[:200]}")
        res = r.json() if r.status_code == 200 else {}
        check("la LPN escaneada cuenta como presente (confirmadas>=1)", int(res.get("confirmadas", 0)) >= 1, f"{res}")
        check("la LPN NO escaneada cae en faltantes (>=1)", int(res.get("faltantes", 0)) >= 1, f"{res}")
        # inventario reconstruido incluye la presente (40u), no la faltante
        inv = list(sdb.wms_inventory.find({"location": LOC}))
        tot = sum(int(x.get("units_on_hand") or 0) for x in inv)
        check("inventario reconstruido = 40 (solo la presente)", tot == 40, f"tot={tot}")
        b2 = sdb.wms_boxes.find_one({"box_id": LPNBOX2})
        check("la faltante quedó recon_pending", b2.get("status") == "recon_pending", f"status={b2.get('status')}")


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
