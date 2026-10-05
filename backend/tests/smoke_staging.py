"""Smoke de SURTIDOS POR LOCACIONAR (services/staging.py + routers/wms_staging.py).

Modelo: UN pick ticket = UN surtido (desglose por talla adentro), en UNA
ubicación de tránsito fija. Fija que:
  - surtir crea el surtido del ticket en SURTIDO POR LOCACIONAR (que se da de
    alta sola, una vez) y cualquier talla/pasada posterior se SUMA al mismo,
    incluso por pick-boxes,
  - corregir a la baja descuenta de la talla del surtido,
  - los surtidos NO cuentan en wms_boxes / wms_inventory (no surtibles),
  - se encuentra por la etiqueta del pick ticket (el escáner la manda en
    mayúsculas) o tecleando la orden; una orden con 2 tickets da opciones,
  - guardar en OM valida destino configurado; surtir más con el surtido ya en
    OM lo suma ahí mismo (sigue siendo uno),
  - entregar a piso lo saca de la lista viva,
  - la config se valida; un tránsito nuevo se da de alta solo,
  - una orden en FINAL BILL cierra sus surtidos sola (auto),
  - neck cutting NO genera surtido,
  - la migración junta las cajas por talla de la primera versión en un solo
    surtido y retira la ubicación vieja TRANSITO SURTIDO vacía.

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
T1, T2, NECK = "pick_stg1", "pick_stg2", "pick_stgneck"
ORDER = "9001"
TRANSIT = "SURTIDO POR LOCACIONAR"


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
    for bid, size, units in [("BOX-000001", "M", 50), ("BOX-000002", "L", 40),
                             ("BOX-000003", "S", 30), ("BOX-000004", "XL", 30)]:
        sdb.wms_boxes.insert_one({
            "box_id": bid, "barcode": bid, "lpn_id": bid, "style": STYLE, "sku": STYLE,
            "color": COLOR, "size": size, "location": LOC, "units": units, "qty": units,
            "status": "stored", "state": "raw", "customer": "CLIENTE X",
        })
    # La ubicación de tránsito NO se siembra: el sistema la da de alta solo.
    for name in ["OM-A01", "OM-A07", "OM-A38", "OM-D07"]:
        sdb.wms_locations.insert_one({"name": name, "zone": name.split("-")[0], "type": "rack", "active": True})
    base = {"order_number": ORDER, "order_id": "ord_9001", "style": STYLE, "color": COLOR,
            "customer": "CLIENTE X", "destination": "warehouse", "status": "in_progress",
            "assigned_to": "", "deducted_map": {}, "picked_sizes": {}}
    sdb.wms_pick_tickets.insert_one({**base, "ticket_id": T1, "sizes": {"M": 20, "L": 10}})
    sdb.wms_pick_tickets.insert_one({**base, "ticket_id": T2, "sizes": {"XL": 10}})
    sdb.wms_pick_tickets.insert_one({**base, "ticket_id": NECK, "order_number": "9002",
                                     "sizes": {"S": 5}, "destination": "neck_cutting"})
    sdb.orders.insert_one({"order_number": ORDER, "order_id": "ord_9001", "client": "CLIENTE X",
                           "board": "BLANKS", "blank_status": "SURTIDO"})


async def main():
    sembrar()
    from httpx import ASGITransport, AsyncClient
    from server import app
    from services import staging

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://smoke") as c:
        r = await c.post("/api/auth/login", json={"email": "sup@test.local", "password": "sup123"})
        check("login", r.status_code == 200, f"{r.status_code} {r.text[:120]}")
        size_url = f"/api/wms/pick-tickets/{T1}/pick-size"

        print("\n== Surtir M (5) crea el surtido del ticket en tránsito ==")
        r = await c.put(size_url, json={"size": "M", "details": {LOC: {"qty": 5, "box_id": "BOX-000001"}}})
        check("pick-size 200", r.status_code == 200, f"{r.status_code} {r.text[:200]}")
        s = live(ticket_id=T1)
        check("un surtido para el ticket", len(s) == 1, str(s))
        check(f"en {TRANSIT} con M:5 y la orden",
              s and s[0]["location"] == TRANSIT and s[0]["sizes"] == {"M": 5} and s[0]["order_number"] == ORDER,
              str(s and {k: s[0].get(k) for k in ("location", "sizes", "order_number")}))
        loc_t = sdb.wms_locations.find_one({"name": TRANSIT})
        check("la ubicación de tránsito se dio de alta sola (tipo transit)",
              bool(loc_t) and loc_t.get("type") == "transit", str(loc_t))

        print("\n== Más M y otra talla (pick-boxes) se suman al MISMO surtido ==")
        r = await c.put(size_url, json={"size": "M", "details": {LOC: {"qty": 8, "box_id": "BOX-000001"}}})
        check("pick-size 200", r.status_code == 200, f"{r.status_code} {r.text[:200]}")
        r = await c.put(f"/api/wms/pick-tickets/{T1}/pick-boxes",
                        json={"location": LOC, "boxes": [{"box_id": "BOX-000002", "size": "L", "qty": 4}]})
        check("pick-boxes 200", r.status_code == 200, f"{r.status_code} {r.text[:200]}")
        s = live(ticket_id=T1)
        check("sigue siendo uno: M:8 L:4 = 12", len(s) == 1 and s[0]["sizes"] == {"M": 8, "L": 4} and s[0]["units"] == 12,
              str([(x["staged_id"], x.get("sizes"), x["units"]) for x in s]))
        check("una sola ubicación de tránsito", sdb.wms_locations.count_documents({"name": TRANSIT}) == 1)

        print("\n== Corrección a la baja M 8 -> 6 ==")
        r = await c.put(size_url, json={"size": "M", "details": {LOC: {"qty": 6}}})
        check("pick-size 200", r.status_code == 200, f"{r.status_code} {r.text[:200]}")
        s = live(ticket_id=T1)
        check("M baja a 6, total 10", len(s) == 1 and s[0]["sizes"]["M"] == 6 and s[0]["units"] == 10,
              str([(x.get("sizes"), x["units"]) for x in s]))

        print("\n== Los surtidos NO son inventario disponible ==")
        check("wms_boxes no tiene SRT-", sdb.wms_boxes.count_documents({"box_id": {"$regex": "^SRT-"}}) == 0)
        check("wms_inventory sin la ubicación de tránsito", sdb.wms_inventory.count_documents({"location": TRANSIT}) == 0)

        print("\n== Buscar por etiqueta del pick ticket o por orden ==")
        r = await c.get("/api/wms/staging/lookup", params={"code": T1.upper()})
        check("etiqueta en mayúsculas -> el surtido", r.status_code == 200 and r.json().get("kind") == "box"
              and r.json()["box"]["ticket_id"] == T1, r.text[:200])
        r = await c.get("/api/wms/staging/lookup", params={"code": ORDER})
        check("orden con un solo surtido -> directo", r.status_code == 200 and r.json().get("kind") == "box", r.text[:160])
        r = await c.put(f"/api/wms/pick-tickets/{T2}/pick-size",
                        json={"size": "XL", "details": {LOC: {"qty": 3, "box_id": "BOX-000004"}}})
        check("surtir segundo ticket de la orden", r.status_code == 200, r.text[:160])
        r = await c.get("/api/wms/staging/lookup", params={"code": ORDER})
        check("orden con 2 tickets -> opciones", r.status_code == 200 and r.json().get("kind") == "choices"
              and len(r.json()["boxes"]) == 2, r.text[:200])

        print("\n== Guardar en OM con la etiqueta del ticket ==")
        r = await c.post("/api/wms/staging/store", json={"staged_ids": [T1.upper()], "location": "OM-A01"})
        check("OM-A01 (fuera de rango) -> 400", r.status_code == 400, r.text[:160])
        r = await c.post("/api/wms/staging/store", json={"staged_ids": [T1.upper()], "location": "OM-D07"})
        check("OM-D07 (fila D no configurada) -> 400", r.status_code == 400, r.text[:160])
        r = await c.post("/api/wms/staging/store", json={"staged_ids": [T1.upper()], "location": "om-a07"})
        check("OM-A07 -> 200", r.status_code == 200 and r.json()["moved"], r.text[:160])
        s = live(ticket_id=T1)
        check("guardado en OM-A07", s and s[0]["status"] == "stored" and s[0]["location"] == "OM-A07", str(s and s[0].get("location")))

        print("\n== Surtir más con el surtido ya en OM: sigue siendo uno ==")
        r = await c.put(size_url, json={"size": "M", "details": {LOC: {"qty": 8, "box_id": "BOX-000001"}}})
        check("pick-size 200", r.status_code == 200, r.text[:160])
        s = live(ticket_id=T1)
        check("uno solo, M:8, en OM-A07", len(s) == 1 and s[0]["sizes"]["M"] == 8 and s[0]["location"] == "OM-A07",
              str([(x.get("sizes"), x["location"]) for x in s]))

        print("\n== Lista por orden ==")
        r = await c.get("/api/wms/staging", params={"q": ORDER})
        o = (r.json().get("orders") or [{}])[0]
        check("orden con 15 u (12 + 3) y 2 surtidos", o.get("units") == 15 and o.get("boxes") == 2, str(o))

        print("\n== Entregar a piso ==")
        r = await c.post("/api/wms/staging/issue", json={"staged_ids": [T1]})
        check("issue 200", r.status_code == 200 and r.json()["issued"], r.text[:160])
        check("ya no está vivo", not live(ticket_id=T1))
        r = await c.post("/api/wms/staging/issue", json={"staged_ids": [T1]})
        check("re-entregar -> error informado", r.status_code == 200 and r.json()["errors"], r.text[:160])

        print("\n== Configuración ==")
        r = await c.put("/api/wms/staging/config", json={"transit": ["OM-A10"], "destinations": ["OM-A07..OM-A38"]})
        check("tránsito dentro de destino -> 400", r.status_code == 400, r.text[:160])
        r = await c.put("/api/wms/staging/config", json={"transit": [TRANSIT, "MESA SURTIDO"],
                                                         "destinations": ["OM-A07..OM-A38", "OM-D*"],
                                                         "auto_issue_boards": ["FINAL BILL"]})
        check("config válida -> 200", r.status_code == 200 and "OM-D07" in r.json().get("destination_locations", []), r.text[:200])
        check("MESA SURTIDO se dio de alta", sdb.wms_locations.count_documents({"name": "MESA SURTIDO"}) == 1)
        r = await c.post("/api/wms/staging/store", json={"staged_ids": [T2], "location": "OM-D07"})
        check("OM-D07 -> 200 tras configurar", r.status_code == 200 and r.json()["moved"], r.text[:160])

        print("\n== Orden en FINAL BILL cierra sola ==")
        sdb.orders.update_one({"order_number": ORDER}, {"$set": {"board": "FINAL BILL"}})
        r = await c.get("/api/wms/staging")
        check("lista vacía", r.status_code == 200 and r.json()["totals"]["boxes"] == 0, r.text[:200])
        check("cerrado con motivo auto",
              sdb.wms_staged_boxes.count_documents({"ticket_id": T2, "issue_reason": "auto"}) == 1)

        print("\n== Neck cutting NO genera surtido ==")
        r = await c.put(f"/api/wms/pick-tickets/{NECK}/pick-size",
                        json={"size": "S", "details": {LOC: {"qty": 5, "box_id": "BOX-000003"}}})
        check("pick-size neck 200", r.status_code == 200, f"{r.status_code} {r.text[:200]}")
        check("sin surtido", sdb.wms_staged_boxes.count_documents({"ticket_id": NECK}) == 0)

        print("\n== Migración de la primera versión (caja por talla) ==")
        sdb.wms_locations.insert_one({"name": "TRANSITO SURTIDO", "type": "transit", "active": True,
                                      "created_by": "system:staging"})
        for i, (sz, u) in enumerate([("M", 10), ("L", 6)], 1):
            sdb.wms_staged_boxes.insert_one({
                "staged_id": f"SRT-90000{i}", "status": "transit", "location": "TRANSITO SURTIDO",
                "ticket_id": "pick_old1", "order_number": "8000", "style": STYLE, "color": COLOR,
                "size": sz, "units": u, "origins": [], "created_at": "2026-10-05T22:40:00+00:00"})
        res = await staging.migrate_per_size_boxes()
        check("migración junta 1 ticket", res.get("merged") == 1 and res.get("old_docs") == 2, str(res))
        m = live(ticket_id="pick_old1")
        check("un surtido M:10 L:6 en el tránsito vigente",
              len(m) == 1 and m[0]["sizes"] == {"M": 10, "L": 6} and m[0]["location"] == TRANSIT, str(m))
        check("las cajas viejas quedan como merged",
              sdb.wms_staged_boxes.count_documents({"ticket_id": "pick_old1", "status": "merged"}) == 2)
        res2 = await staging.migrate_per_size_boxes()
        check("migración idempotente", res2.get("merged") == 0, str(res2))
        check("TRANSITO SURTIDO vacía se retira", await staging.retire_old_transit() is True
              and sdb.wms_locations.count_documents({"name": "TRANSITO SURTIDO"}) == 0)


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
