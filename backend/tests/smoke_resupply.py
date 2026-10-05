"""Smoke del RESURTIDO sobre el mismo pick ticket (services/resupply.py +
routers/wms_resupply.py).

Fija que:
  - admin nivel 2 no puede; admin 3 sí, hasta el umbral (default 10 %),
  - la ronda es un ticket hijo "<padre>-R1" que el picker surte escaneando caja,
  - su pick_deduction va marcado resupply y crea caja de surtido para la orden,
  - lo resurtido NO cuenta como embarcado (qty_embarcada),
  - no se abren dos rondas a la vez; tallas nuevas (resize) sí se aceptan,
  - arriba del umbral solo admin 5; la config (motivos/umbral) es de admin 5,
  - cancelar solo si no se ha surtido; motivo fuera de catálogo -> 400,
  - no se resurte un ticket abierto ni una ronda,
  - la incidencia ya no repone por FIFO (400).

SEGURIDAD: base DESECHABLE, se niega contra producción, se borra al terminar.

USO
    set MONGODB_URL=mongodb://usuario:clave@host:27017/?authSource=admin
    backend/venv/Scripts/python.exe backend/tests/smoke_resupply.py
"""
import asyncio
import os
import sys

BE = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
SMOKE_DB = os.environ.get("SMOKE_DB_NAME", "mos-smoke-resupply")
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
os.environ["DISABLE_SCHEDULERS"] = "1"
sys.path.insert(0, BE)
os.chdir(BE)

import pymongo  # noqa: E402
from passlib.hash import bcrypt  # noqa: E402

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

raw = pymongo.MongoClient(MONGO)
sdb = raw[SMOKE_DB]
ok = fail = 0

STYLE, COLOR, LOC = "STY5000", "BLACK", "A1-01"
PARENT, OPEN_T = "pick_parent1", "pick_open1"
ORDER = "9100"


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
    for c in sdb.list_collection_names():
        sdb[c].delete_many({})
    for uid, lvl in [("a2", 2), ("a3", 3), ("a5", 5)]:
        sdb.users.insert_one({
            "user_id": f"u_{uid}", "email": f"{uid}@test.local", "name": f"Admin {lvl}",
            "password_hash": bcrypt.hash("pw123"), "role": "admin", "admin_level": lvl,
            "inventory_level": 0, "active": True})
    for bid, size in [("BOX-000001", "M"), ("BOX-000002", "XL")]:
        sdb.wms_boxes.insert_one({
            "box_id": bid, "barcode": bid, "lpn_id": bid, "style": STYLE, "sku": STYLE,
            "color": COLOR, "size": size, "location": LOC, "units": 100, "qty": 100,
            "status": "stored", "state": "raw", "customer": "CLIENTE X"})
    base = {"order_number": ORDER, "order_id": "ord_9100", "style": STYLE, "color": COLOR,
            "customer": "CLIENTE X", "sizes": {"M": 100, "L": 100}, "total_pick_qty": 200,
            "destination": "production", "assigned_to": ""}
    sdb.wms_pick_tickets.insert_one({**base, "ticket_id": PARENT, "status": "confirmed",
                                     "picking_status": "completed", "picked_sizes": {}, "deducted_map": {}})
    sdb.wms_pick_tickets.insert_one({**base, "ticket_id": OPEN_T, "order_number": "9101",
                                     "status": "pending", "picking_status": "unassigned"})
    sdb.orders.insert_one({"order_number": ORDER, "order_id": "ord_9100", "client": "CLIENTE X",
                           "board": "BLANKS", "blank_status": "SURTIDO"})


async def login(c, who):
    c.cookies.clear()
    r = await c.post("/api/auth/login", json={"email": f"{who}@test.local", "password": "pw123"})
    check(f"login {who}", r.status_code == 200, f"{r.status_code} {r.text[:120]}")


async def main():
    sembrar()
    from httpx import ASGITransport, AsyncClient
    from server import app
    from deps import db as adb
    from services.qty_embarcada import qty_embarcada_por_orden

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://smoke") as c:
        url = f"/api/wms/resupply/{PARENT}"

        print("\n== Permisos ==")
        await login(c, "a2")
        r = await c.post(url, json={"sizes": {"M": 10}, "reason": "Dañado"})
        check("admin 2 -> 403", r.status_code == 403, f"{r.status_code} {r.text[:160]}")

        await login(c, "a3")
        r = await c.get("/api/wms/resupply/config")
        check("config trae motivos y umbral 10", r.status_code == 200 and r.json()["threshold_pct"] == 10
              and "Dañado" in r.json()["reasons"] and r.json()["can_over"] is False, r.text[:200])

        print("\n== Validaciones ==")
        r = await c.post(url, json={"sizes": {"M": 10}, "reason": "Porque sí"})
        check("motivo fuera de catálogo -> 400", r.status_code == 400, r.text[:160])
        r = await c.post(url, json={"sizes": {}, "reason": "Dañado"})
        check("sin tallas -> 400", r.status_code == 400, r.text[:160])
        r = await c.post(f"/api/wms/resupply/{OPEN_T}", json={"sizes": {"M": 5}, "reason": "Dañado"})
        check("ticket aún abierto -> 409", r.status_code == 409, r.text[:160])

        print("\n== Ronda R1 (admin 3, 5 %) ==")
        r = await c.post(f"{url}/preview", json={"sizes": {"M": 10}})
        check("preview 5 %", r.status_code == 200 and r.json()["pct"] == 5.0 and not r.json()["over"], r.text[:200])
        r = await c.post(url, json={"sizes": {"m": 10}, "reason": "dañado", "notes": "Rotas en máquina 4"})
        check("crea R1 -> 200", r.status_code == 200, f"{r.status_code} {r.text[:200]}")
        r1 = r.json() if r.status_code == 200 else {}
        check("id <padre>-R1, kind resupply, talla M:10",
              r1.get("ticket_id") == f"{PARENT}-R1" and r1.get("kind") == "resupply" and r1.get("sizes") == {"M": 10},
              str({k: r1.get(k) for k in ("ticket_id", "kind", "sizes")}))
        p = sdb.wms_pick_tickets.find_one({"ticket_id": PARENT})
        check("padre lleva el resumen (resupply_units 10)", p.get("resupply_units") == 10 and len(p.get("resupplies", [])) == 1,
              str(p.get("resupplies")))
        r = await c.post(url, json={"sizes": {"M": 1}, "reason": "Dañado"})
        check("segunda ronda con R1 abierta -> 409", r.status_code == 409, r.text[:160])
        r = await c.post(f"/api/wms/resupply/{PARENT}-R1", json={"sizes": {"M": 1}, "reason": "Dañado"})
        check("resurtir sobre una ronda -> 400", r.status_code == 400, r.text[:160])

        print("\n== El picker surte R1 escaneando caja ==")
        r = await c.put(f"/api/wms/pick-tickets/{PARENT}-R1/pick-size",
                        json={"size": "M", "details": {LOC: {"qty": 10, "box_id": "BOX-000001"}}})
        check("pick-size R1 -> 200", r.status_code == 200, f"{r.status_code} {r.text[:200]}")
        check("caja bajó a 90", sdb.wms_boxes.find_one({"box_id": "BOX-000001"})["units"] == 90)
        mv = sdb.wms_movements.find_one({"type": "pick_deduction", "details.ticket_id": f"{PARENT}-R1"})
        check("pick_deduction marcado resupply", bool(mv) and mv["details"].get("resupply") is True, str(mv and mv.get("details")))
        stg = sdb.wms_staged_boxes.find_one({"ticket_id": f"{PARENT}-R1"})
        check("caja de surtido para la orden", bool(stg) and stg["order_number"] == ORDER and stg["units"] == 10, str(stg))
        r = await c.put(f"/api/wms/pick-tickets/{PARENT}-R1/confirm", json={"lines": []})
        check("confirm R1 -> 200", r.status_code == 200, f"{r.status_code} {r.text[:200]}")
        emb = await qty_embarcada_por_orden(adb, [{"order_number": ORDER}])
        check("lo resurtido NO cuenta como embarcado", emb.get(ORDER, 0) == 0, str(emb))
        r = await c.post(f"/api/wms/resupply/{PARENT}-R1/cancel")
        check("cancelar R1 ya surtido -> 409", r.status_code == 409, r.text[:160])

        print("\n== Umbral: R2 con talla nueva (resize) acumula 12.5 % ==")
        r = await c.post(url, json={"sizes": {"XL": 15}, "reason": "Resize"})
        check("admin 3 arriba del 10 % -> 403", r.status_code == 403 and "nivel 5" in r.text, f"{r.status_code} {r.text[:200]}")
        await login(c, "a5")
        r = await c.post(url, json={"sizes": {"XL": 15}, "reason": "Resize"})
        check("admin 5 -> 200", r.status_code == 200, f"{r.status_code} {r.text[:200]}")
        r2 = r.json() if r.status_code == 200 else {}
        check("R2 con XL y marcado arriba del umbral",
              r2.get("ticket_id") == f"{PARENT}-R2" and r2.get("sizes") == {"XL": 15} and r2.get("resupply_over_threshold") is True,
              str({k: r2.get(k) for k in ("ticket_id", "sizes", "resupply_over_threshold", "resupply_pct")}))

        print("\n== Cancelar R2 (sin surtir) ==")
        await login(c, "a3")
        r = await c.post(f"/api/wms/resupply/{PARENT}-R2/cancel")
        check("cancelar R2 -> 200", r.status_code == 200 and r.json().get("status") == "cancelled", r.text[:160])
        p = sdb.wms_pick_tickets.find_one({"ticket_id": PARENT})
        check("padre regresa a 10 resurtidas", p.get("resupply_units") == 10, str(p.get("resupply_units")))

        print("\n== Configuración ==")
        r = await c.put("/api/wms/resupply/config", json={"reasons": ["Dañado"], "threshold_pct": 30})
        check("admin 3 no configura -> 403", r.status_code == 403, r.text[:160])
        await login(c, "a5")
        r = await c.put("/api/wms/resupply/config", json={"reasons": ["Dañado", "Hilo suelto"], "threshold_pct": 30})
        check("admin 5 configura -> 200", r.status_code == 200 and "Hilo suelto" in r.json()["reasons"], r.text[:160])
        r = await c.put("/api/wms/resupply/config", json={"reasons": [], "threshold_pct": 30})
        check("sin motivos -> 400", r.status_code == 400, r.text[:160])
        await login(c, "a3")
        r = await c.post(url, json={"sizes": {"XL": 15}, "reason": "Hilo suelto"})
        check("con umbral 30 % admin 3 ya puede (R3)", r.status_code == 200 and r.json()["ticket_id"] == f"{PARENT}-R3",
              f"{r.status_code} {r.text[:200]}")

        print("\n== La incidencia ya no repone por FIFO ==")
        r = await c.post(f"/api/wms/pick-tickets/{PARENT}/incidents",
                         json={"sku": STYLE, "qty": 1, "reason": "Dañado", "replacement_sizes": {"M": 3}})
        check("incidencia con reposición -> 400", r.status_code == 400 and "Resurtir" in r.text, r.text[:160])
        check("la caja M no se tocó (90)", sdb.wms_boxes.find_one({"box_id": "BOX-000001"})["units"] == 90)
        r = await c.post(f"/api/wms/pick-tickets/{PARENT}/incidents", json={"sku": STYLE, "qty": 1, "reason": "Dañado"})
        check("incidencia solo como reporte -> 200", r.status_code == 200, r.text[:160])


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
        print("EXCEPCIÓN en el smoke:\n" + _err)
    print(f"{ok} PASS · {fail} FAIL")
    sys.exit(1 if (fail or _err) else 0)
