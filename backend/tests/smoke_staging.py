"""Smoke del SURTIDO EN TRÁNSITO → OM (services/staging.py + routers/wms_staging.py).

Fija que:
  - surtir crea una caja de surtido (ticket × talla) en tránsito con la orden,
    y un segundo descuento de la misma talla ENGORDA esa caja (no abre otra),
  - pick-boxes también la crea (una por talla),
  - corregir a la baja descuenta de la caja de surtido,
  - las cajas de surtido NO cuentan en wms_boxes / wms_inventory (no surtibles),
  - guardar en OM valida que sea destino configurado; fuera de rango -> 400,
  - surtir más de una talla ya guardada abre caja nueva en tránsito,
  - entregar a piso la saca de la lista viva,
  - la config se valida y un destino nuevo (OM-D*) se acepta al instante,
  - una orden en FINAL BILL cierra sus cajas sola (auto),
  - surtido a neck cutting NO genera caja de surtido.

SEGURIDAD: base DESECHABLE, se niega contra producción, se borra al terminar.

USO
    set MONGODB_URL=mongodb://usuario:clave@host:27017/?authSource=admin
    backend/venv/Scripts/python.exe backend/tests/smoke_staging.py
"""
import asyncio
import os
import sys

BE = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
SMOKE_DB = os.environ.get("SMOKE_DB_NAME", "mos-smoke-staging")
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
TICKET, NECK = "tkt_stg_1", "tkt_stg_neck"
ORDER = "9001"


def check(nombre, cond, detalle=""):
    global ok, fail
    if cond:
        ok += 1
        print(f"   PASS  {nombre}")
    else:
        fail += 1
        print(f"   FAIL  {nombre}  {detalle}")


def live(**q):
    return list(sdb.wms_staged_boxes.find({"status": {"$in": ["transit", "stored"]}, **q}))


def sembrar():
    print(f"== Sembrando {SMOKE_DB} ==")
    for c in sdb.list_collection_names():
        sdb[c].delete_many({})
    sdb.users.insert_one({
        "user_id": "u_sup", "email": "sup@test.local", "name": "Supervisor",
        "password_hash": bcrypt.hash("sup123"),
        "role": "supersu", "admin_level": 5, "inventory_level": 5, "active": True,
    })
    for bid, size, units in [("BOX-000001", "M", 50), ("BOX-000002", "L", 40), ("BOX-000003", "S", 30)]:
        sdb.wms_boxes.insert_one({
            "box_id": bid, "barcode": bid, "lpn_id": bid, "style": STYLE, "sku": STYLE,
            "color": COLOR, "size": size, "location": LOC, "units": units, "qty": units,
            "status": "stored", "state": "raw", "customer": "CLIENTE X",
        })
    # TRANSITO SURTIDO NO se siembra: el sistema debe darla de alta solo.
    for name in ["OM-A01", "OM-A07", "OM-A38", "OM-D07"]:
        sdb.wms_locations.insert_one({"name": name, "zone": name.split("-")[0], "type": "rack", "active": True})
    sdb.wms_pick_tickets.insert_one({
        "ticket_id": TICKET, "order_number": ORDER, "order_id": "ord_9001",
        "style": STYLE, "color": COLOR, "customer": "CLIENTE X",
        "sizes": {"M": 10, "L": 10}, "destination": "warehouse", "status": "in_progress",
        "assigned_to": "", "deducted_map": {}, "picked_sizes": {},
    })
    sdb.wms_pick_tickets.insert_one({
        "ticket_id": NECK, "order_number": "9002", "order_id": "ord_9002",
        "style": STYLE, "color": COLOR, "customer": "CLIENTE X",
        "sizes": {"S": 5}, "destination": "neck_cutting", "status": "in_progress",
        "assigned_to": "", "deducted_map": {}, "picked_sizes": {},
    })
    sdb.orders.insert_one({"order_number": ORDER, "order_id": "ord_9001", "client": "CLIENTE X",
                           "board": "BLANKS", "blank_status": "SURTIDO"})


async def main():
    sembrar()
    from httpx import ASGITransport, AsyncClient
    from server import app

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://smoke") as c:
        r = await c.post("/api/auth/login", json={"email": "sup@test.local", "password": "sup123"})
        check("login", r.status_code == 200, f"{r.status_code} {r.text[:120]}")
        size_url = f"/api/wms/pick-tickets/{TICKET}/pick-size"

        print("\n== Surtir M (5) crea caja de surtido en tránsito ==")
        r = await c.put(size_url, json={"size": "M", "details": {LOC: {"qty": 5, "box_id": "BOX-000001"}}})
        check("pick-size 200", r.status_code == 200, f"{r.status_code} {r.text[:200]}")
        s = live(ticket_id=TICKET, size="M")
        check("una caja de surtido M", len(s) == 1, str(s))
        check("en TRANSITO SURTIDO con 5 u y la orden",
              s and s[0]["location"] == "TRANSITO SURTIDO" and s[0]["units"] == 5 and s[0]["order_number"] == ORDER,
              str(s and {k: s[0].get(k) for k in ("location", "units", "order_number")}))
        check("id SRT-", s and s[0]["staged_id"].startswith("SRT-"), str(s and s[0].get("staged_id")))
        check("origen BOX-000001", s and "BOX-000001" in s[0]["origins"][0]["box_ids"], str(s and s[0].get("origins")))
        loc_t = sdb.wms_locations.find_one({"name": "TRANSITO SURTIDO"})
        check("TRANSITO SURTIDO se dio de alta sola (tipo transit)",
              bool(loc_t) and loc_t.get("type") == "transit", str(loc_t))

        print("\n== Surtir 3 más de M engorda la MISMA caja ==")
        r = await c.put(size_url, json={"size": "M", "details": {LOC: {"qty": 8, "box_id": "BOX-000001"}}})
        check("pick-size 200", r.status_code == 200, f"{r.status_code} {r.text[:200]}")
        s = live(ticket_id=TICKET, size="M")
        check("sigue siendo una caja, ahora 8 u", len(s) == 1 and s[0]["units"] == 8, str([(x["staged_id"], x["units"]) for x in s]))

        print("\n== pick-boxes (L) crea su propia caja de surtido ==")
        r = await c.put(f"/api/wms/pick-tickets/{TICKET}/pick-boxes",
                        json={"location": LOC, "boxes": [{"box_id": "BOX-000002", "size": "L", "qty": 4}]})
        check("pick-boxes 200", r.status_code == 200, f"{r.status_code} {r.text[:200]}")
        sl = live(ticket_id=TICKET, size="L")
        check("caja L con 4 u", len(sl) == 1 and sl[0]["units"] == 4, str(sl))

        print("\n== Corrección a la baja M 8 -> 6 descuenta de la caja de surtido ==")
        r = await c.put(size_url, json={"size": "M", "details": {LOC: {"qty": 6}}})
        check("pick-size 200", r.status_code == 200, f"{r.status_code} {r.text[:200]}")
        s = live(ticket_id=TICKET, size="M")
        check("caja M baja a 6", len(s) == 1 and s[0]["units"] == 6, str([(x["staged_id"], x["units"]) for x in s]))

        print("\n== Las cajas de surtido NO son inventario disponible ==")
        check("wms_boxes no tiene SRT-", sdb.wms_boxes.count_documents({"box_id": {"$regex": "^SRT-"}}) == 0)
        # Nota: la corrección a la baja regresa las piezas al RENGLÓN de
        # inventario (_update_inventory_enhanced "add"), no a la caja: es la
        # semántica previa (ola 3 del un-solo-escritor), no la toca este cambio.
        _b1 = sdb.wms_boxes.find_one({"box_id": "BOX-000001"})["units"]
        check("BOX-000001 quedó en 42 (se surtieron 8 de ella)", _b1 == 42, f"units={_b1}")
        check("wms_inventory sin ubicación de tránsito",
              sdb.wms_inventory.count_documents({"location": "TRANSITO SURTIDO"}) == 0)

        print("\n== Guardar en OM ==")
        sid_m = s[0]["staged_id"]
        r = await c.post("/api/wms/staging/store", json={"staged_ids": [sid_m], "location": "OM-A01"})
        check("OM-A01 (fuera de rango) -> 400", r.status_code == 400, f"{r.status_code} {r.text[:160]}")
        r = await c.post("/api/wms/staging/store", json={"staged_ids": [sid_m], "location": "OM-D07"})
        check("OM-D07 (fila D no configurada) -> 400", r.status_code == 400, f"{r.status_code} {r.text[:160]}")
        r = await c.post("/api/wms/staging/store", json={"staged_ids": [sid_m], "location": "om-a07"})
        check("OM-A07 -> 200", r.status_code == 200 and r.json()["moved"], f"{r.status_code} {r.text[:160]}")
        b = sdb.wms_staged_boxes.find_one({"staged_id": sid_m})
        check("quedó stored en OM-A07", b["status"] == "stored" and b["location"] == "OM-A07", str(b.get("status")))

        print("\n== Surtir más M con la caja ya guardada abre caja nueva ==")
        r = await c.put(size_url, json={"size": "M", "details": {LOC: {"qty": 8, "box_id": "BOX-000001"}}})
        check("pick-size 200", r.status_code == 200, f"{r.status_code} {r.text[:200]}")
        s = live(ticket_id=TICKET, size="M")
        nuevas = [x for x in s if x["status"] == "transit"]
        check("2 cajas M: una en OM (6) y otra en tránsito (2)",
              len(s) == 2 and len(nuevas) == 1 and nuevas[0]["units"] == 2,
              str([(x["staged_id"], x["status"], x["units"]) for x in s]))

        print("\n== Consultas ==")
        r = await c.get("/api/wms/staging/lookup", params={"code": "OM-A07"})
        check("lookup OM-A07 -> 1 caja", r.status_code == 200 and len(r.json()["boxes"]) == 1, r.text[:200])
        r = await c.get("/api/wms/staging", params={"q": ORDER})
        j = r.json()
        o = (j.get("orders") or [{}])[0]
        check("lista por orden: 12 u (6+2+4)", r.status_code == 200 and o.get("units") == 12, str(o))
        check("trae estado CRM de la orden", o.get("board") == "BLANKS", str(o))

        print("\n== Entregar a piso ==")
        r = await c.post("/api/wms/staging/issue", json={"staged_ids": [sid_m]})
        check("issue 200", r.status_code == 200 and r.json()["issued"], f"{r.status_code} {r.text[:160]}")
        check("ya no está viva", not live(staged_id=sid_m))
        r = await c.post("/api/wms/staging/issue", json={"staged_ids": [sid_m]})
        check("re-entregar -> error informado, sin duplicar", r.status_code == 200 and r.json()["errors"], r.text[:160])
        check("movimiento staged_issue", sdb.wms_movements.count_documents({"type": "staged_issue"}) == 1)

        print("\n== Configuración ==")
        r = await c.put("/api/wms/staging/config", json={"transit": ["OM-A10"], "destinations": ["OM-A07..OM-A38"]})
        check("tránsito dentro de destino -> 400", r.status_code == 400, f"{r.status_code} {r.text[:160]}")
        r = await c.put("/api/wms/staging/config", json={"transit": ["TRANSITO SURTIDO"],
                                                         "destinations": ["OM-A07..OM-A38", "OM-D*"],
                                                         "auto_issue_boards": ["FINAL BILL"]})
        check("config válida -> 200", r.status_code == 200, f"{r.status_code} {r.text[:160]}")
        check("OM-D07 ahora es destino", "OM-D07" in r.json().get("destination_locations", []), r.text[:200])
        r = await c.put("/api/wms/staging/config", json={"transit": ["TRANSITO SURTIDO", "MESA SURTIDO"],
                                                         "destinations": ["OM-A07..OM-A38", "OM-D*"],
                                                         "auto_issue_boards": ["FINAL BILL"]})
        check("tránsito nuevo en config -> 200", r.status_code == 200, r.text[:160])
        check("MESA SURTIDO se dio de alta sola", sdb.wms_locations.count_documents({"name": "MESA SURTIDO"}) == 1)
        check("TRANSITO SURTIDO no se duplicó", sdb.wms_locations.count_documents({"name": "TRANSITO SURTIDO"}) == 1)
        sid_l = sl[0]["staged_id"]
        r = await c.post("/api/wms/staging/store", json={"staged_ids": [sid_l], "location": "OM-D07"})
        check("OM-D07 -> 200 tras configurar", r.status_code == 200 and r.json()["moved"], r.text[:160])

        print("\n== Orden en FINAL BILL cierra sola ==")
        sdb.orders.update_one({"order_number": ORDER}, {"$set": {"board": "FINAL BILL"}})
        r = await c.get("/api/wms/staging")
        check("lista vacía", r.status_code == 200 and r.json()["totals"]["boxes"] == 0, r.text[:200])
        check("cerradas con motivo auto",
              sdb.wms_staged_boxes.count_documents({"order_number": ORDER, "issue_reason": "auto"}) == 2)

        print("\n== Neck cutting NO genera caja de surtido ==")
        r = await c.put(f"/api/wms/pick-tickets/{NECK}/pick-size",
                        json={"size": "S", "details": {LOC: {"qty": 5, "box_id": "BOX-000003"}}})
        check("pick-size neck 200", r.status_code == 200, f"{r.status_code} {r.text[:200]}")
        check("sin caja de surtido", sdb.wms_staged_boxes.count_documents({"ticket_id": NECK}) == 0)


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
