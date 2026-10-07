"""Smoke del programador de envíos por EXPORT (/api/scheduled-shipments).

Fija el contrato del programador con estructura de hoja de embarques:
semana con fechas reales → exports (bloques) → líneas. Cubre: crear export,
agregar órdenes (varias de golpe, duplicado en el mismo export, no encontradas,
manuales), herencia de shipping#/destino del renglón anterior, PCS parciales y
duplicado de línea, LATE, mover línea (a export y a otra fecha), mover el
export completo de fecha, EXPORT# consecutivo, borrado con/sin cascada, y que
el formato anterior (POST "" por mes/semana) no pisa las líneas nuevas.

SEGURIDAD: base DESECHABLE, se niega contra producción, se borra al terminar.

USO
───
    set MONGODB_URL=mongodb://localhost:27017
    python backend/tests/smoke_scheduled_exports.py
"""
import asyncio
import os
import sys
from datetime import date, timedelta

BE = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
SMOKE_DB = os.environ.get("SMOKE_DB_NAME", "mos-smoke-sched-exports")
PROD_DB = os.environ.get("PROD_DB_NAME", "mos-system")
MONGO = os.environ.get("MONGODB_URL") or os.environ.get("MONGO_URL")

if not MONGO:
    sys.exit("Falta MONGODB_URL")
if SMOKE_DB == PROD_DB:
    sys.exit(f"NEGADO: SMOKE_DB_NAME es la base de producción ('{PROD_DB}').")

os.environ["MONGODB_URL"] = MONGO
os.environ["MONGO_URL"] = MONGO
os.environ["DB_NAME"] = SMOKE_DB
os.environ.setdefault("JWT_SECRET", "smoke_secret")
os.environ.setdefault("MASTER_API_KEY", "smoke_master_key")
os.environ.setdefault("INTERNAL_SYNC_TOKEN", "smoke_sync_token")
os.environ.setdefault("DISABLE_SCHEDULERS", "1")
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


def check(nombre, cond, detalle=""):
    global ok, fail
    if cond:
        ok += 1
        print(f"   PASS  {nombre}")
    else:
        fail += 1
        print(f"   FAIL  {nombre}  {detalle}")


HOY = date.today()
LUNES = HOY - timedelta(days=HOY.weekday())
MARTES = (LUNES + timedelta(days=1)).isoformat()
MIERCOLES = (LUNES + timedelta(days=2)).isoformat()
JUEVES = (LUNES + timedelta(days=3)).isoformat()
LUNES_SIG = (LUNES + timedelta(days=7)).isoformat()


def sembrar():
    print(f"== Sembrando {SMOKE_DB} ==")
    for c in ["orders", "users", "user_sessions", "scheduled_shipments", "shipping_exports",
              "scheduled_week_envios", "activity_logs", "comments", "production_logs", "shipping_movements"]:
        sdb[c].delete_many({})
    base = {"client": "GTS", "branding": "SPENCER GIFTS", "board": "COMPLETOS", "quantity": 280}
    sdb.orders.insert_many([
        {**base, "order_id": "o1", "order_number": "3352", "customer_po": "22818", "design_#": "TS03153M1000",
         "cancel_date": (LUNES + timedelta(days=30)).isoformat(), "production_status": "LISTO PARA ENVIO"},
        {**base, "order_id": "o2", "order_number": "3353", "customer_po": "22817", "design_#": "TS03487M1000",
         # límite ANTES del martes → LATE
         "ship_by": (LUNES - timedelta(days=3)).isoformat(), "production_status": "EN PRODUCCION"},
        {**base, "order_id": "o3", "order_number": "3446", "client": "GTS", "branding": "BUCEES",
         "customer_po": "BUC92326SA", "quantity": "10,436", "production_status": "EN PRODUCCION"},
        {**base, "order_id": "o4", "order_number": "2491", "client": "SPEKTRUM", "branding": "CULTURE KINGS",
         "blank_status": "CONTADO/PICKED"},
        {**base, "order_id": "o6", "order_number": "2980", "production_status": "LABEL LISTO"},
        {**base, "order_id": "o7", "order_number": "2981", "production_status": "EN PROCESO DE EMPAQUE",
         "blank_status": "CONTADO"},
        # gemela en papelera: el join no debe traerla
        {**base, "order_id": "o5", "order_number": "3380", "board": "PAPELERA DE RECICLAJE"},
    ])
    # Piezas impresas: ya NO cambian el STATUS (antes separaban IN SETUP/PRINTING).
    sdb.production_logs.insert_one({"log_id": "pl1", "order_id": "o3", "order_number": "3446",
                                    "quantity_produced": 500, "machine": "MAQUINA1"})
    sdb.users.insert_one({"user_id": "u_sup", "email": "sup@test.local", "name": "Programador",
                          "password_hash": bcrypt.hash("sup123"), "role": "supersu", "admin_level": 5, "active": True})


async def main():
    sembrar()
    from httpx import ASGITransport, AsyncClient
    from server import app

    global jr_fecha
    from services.shipping_journal import fecha as jr_fecha

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://smoke") as c:
        r = await c.post("/api/auth/login", json={"email": "sup@test.local", "password": "sup123"})
        check("login", r.status_code == 200, r.status_code)
        API = "/api/scheduled-shipments"

        print("\n== Semana vacía ==")
        r = await c.get(f"{API}/week", params={"start": JUEVES})
        d = r.json()
        check("semana se normaliza a lunes", d.get("week_start") == LUNES.isoformat(), d.get("week_start"))
        check("sin exports ni líneas", d["exports"] == [] and d["lines"] == [])
        check("siguiente EXPORT# = 1 en base vacía", d["next_export_no"] == 1, d["next_export_no"])
        check("catálogo de status = production status de MOS (no el de la hoja)",
              "LISTO PARA ENVIO" in d["statuses"] and "READY TO SHIP" not in d["statuses"], d["statuses"])
        check("sugerencias de destino incluyen defaults", "ST ANDREWS" in d["suggest"]["delivery_to"])

        print("\n== Exports ==")
        r = await c.post(f"{API}/exports", json={"date": MARTES})
        e1 = r.json()
        check("crea export con horarios default", r.status_code == 200 and e1["cutoff_time"] == "15:00"
              and e1["export_time"] == "17:00", r.text[:200])
        r = await c.post(f"{API}/exports", json={"date": MARTES, "cutoff_time": "11:30", "export_time": "16:00"})
        e2 = r.json()
        check("segundo export del día, posición 1", e2["position"] == 1, e2)
        r = await c.post(f"{API}/exports", json={"date": "no-fecha"})
        check("fecha inválida → 400", r.status_code == 400, r.status_code)
        r = await c.put(f"{API}/exports/{e1['export_id']}", json={"cutoff_time": "25:00"})
        check("hora inválida → 400", r.status_code == 400, r.status_code)
        r = await c.put(f"{API}/exports/{e1['export_id']}", json={"customs_light": "azul"})
        check("semáforo fuera de catálogo → 400", r.status_code == 400, r.status_code)
        r = await c.put(f"{API}/exports/{e1['export_id']}",
                        json={"export_no": 81, "truck": "TEC.184 / 53147", "customs_light": "verde",
                              "pl_numbers": "PLGTS 09-26-0081"})
        e1 = r.json()
        check("encabezado editable (semáforo normalizado a mayúsculas)",
              e1["export_no"] == 81 and e1["customs_light"] == "VERDE" and e1["truck"] == "TEC.184 / 53147", e1)
        r = await c.post(f"{API}/exports/{e2['export_id']}/assign-number")
        check("assign-number = mayor + 1", r.json().get("export_no") == 82, r.json())

        print("\n== Líneas ==")
        r = await c.post(f"{API}/lines", json={"export_id": e1["export_id"], "order_numbers": "3352, #3353 9999 3380"})
        d = r.json()
        check("agrega varias de golpe", [x["order_number"] for x in d["added"]] == ["3352", "3353"], d)
        check("no encontradas (incluye la de papelera)", sorted(d["not_found"]) == ["3380", "9999"], d["not_found"])
        l1, l2 = d["added"]
        check("join vivo: cliente/PO/design de la orden",
              l1["client"] == "GTS" and l1["customer_po"] == "22818" and l1["design_num"] == "TS03153M1000", l1)
        check("PCS default = qty de la orden", l1["pcs"] == 280, l1["pcs"])
        check("LATE cuando sale después de ship_by", l2["late"] is True and l1["late"] is False, (l1["late"], l2["late"]))
        check("dashboard: scheduled_export_date = fecha del export", l1["scheduled_export_date"] == MARTES)
        r = await c.post(f"{API}/lines", json={"export_id": e1["export_id"], "order_numbers": "3352"})
        check("misma orden en el mismo export → duplicates", r.json()["duplicates"] == ["3352"], r.json())

        print("\n== STATUS = espejo del production status de MOS (sólo lectura) ==")
        check("LISTO PARA ENVIO se muestra tal cual", l1["status_effective"] == "LISTO PARA ENVIO"
              and l1["status_auto"] == "LISTO PARA ENVIO", l1["status_effective"])
        check("EN PRODUCCION tal cual (sin IN SETUP/PRINTING)", l2["status_effective"] == "EN PRODUCCION", l2["status_effective"])
        e3 = (await c.post(f"{API}/exports", json={"date": JUEVES})).json()
        r = await c.post(f"{API}/lines", json={"export_id": e3["export_id"], "order_numbers": "3446 2491 2980 2981"})
        st = {x["order_number"]: x["status_effective"] for x in r.json()["added"]}
        check("piezas impresas ya no lo cambian: EN PRODUCCION", st.get("3446") == "EN PRODUCCION", st)
        check("sin production status → vacío (el blank CONTADO ya no cuenta)", st.get("2491") is None, st)
        check("LABEL LISTO y EN PROCESO DE EMPAQUE tal cual",
              st.get("2980") == "LABEL LISTO" and st.get("2981") == "EN PROCESO DE EMPAQUE", st)
        r = await c.put(f"{API}/{l1['shipment_id']}", json={"status": "READY TO SHIP"})
        check("cambiar STATUS desde el programador → 400 (se cambia en la orden)",
              r.status_code == 400 and "production status" in r.text, r.text[:200])
        sdb.scheduled_shipments.update_one({"shipment_id": l1["shipment_id"]}, {"$set": {"status": "READY TO SHIP"}})
        sdb.orders.update_one({"order_id": "o1"}, {"$set": {"production_status": "NECESITA QC"}})
        r = await c.get(f"{API}/week", params={"start": MARTES})
        x = next(y for y in r.json()["lines"] if y["shipment_id"] == l1["shipment_id"])
        check("status manual viejo se ignora y sigue en vivo a MOS", x["status_effective"] == "NECESITA QC", x["status_effective"])
        sdb.orders.update_one({"order_id": "o1"}, {"$set": {"production_status": "LISTO PARA ENVIO"}})
        sdb.scheduled_shipments.update_one({"shipment_id": l1["shipment_id"]}, {"$unset": {"status": ""}})
        sdb.config_options.update_one({"config_id": "main"}, {"$set": {"production_statuses": ["EN ESPERA", "EDI"]}}, upsert=True)
        r = await c.get(f"{API}/week", params={"start": MARTES})
        check("el catálogo sigue la configuración de MOS", r.json()["statuses"] == ["EN ESPERA", "EDI"], r.json()["statuses"])
        sdb.config_options.delete_many({"config_id": "main"})
        r = await c.put(f"{API}/{l1['shipment_id']}", json={"pcs": 280})
        check("sin cambio de cancel date → sin SE MUEVE FECHA", r.json()["cancel_moved"] is False)
        sdb.orders.update_one({"order_id": "o1"}, {"$set": {"cancel_date": (LUNES + timedelta(days=45)).isoformat()}})
        r = await c.get(f"{API}/week", params={"start": MARTES})
        mv = next(x for x in r.json()["lines"] if x["shipment_id"] == l1["shipment_id"])
        check("cancel date cambió después de programar → cancel_moved", mv["cancel_moved"] is True, mv)
        await c.delete(f"{API}/exports/{e3['export_id']}", params={"cascade": "true"})

        r = await c.put(f"{API}/{l1['shipment_id']}", json={
            "shipping_no": "306", "delivery_to": "ST ANDREWS", "carrier": "UPS GROUND", "ship_from": "ST ANDREWS",
            "priority": 2, "ship_notes": "Se va hoy", "pcs": "1,152"})
        x = r.json()
        check("edita campos de la línea (pcs con coma)",
              r.status_code == 200 and x["pcs"] == 1152 and x["priority"] == 2
              and x["ship_notes"] == "Se va hoy", r.text[:300])
        r = await c.put(f"{API}/{l1['shipment_id']}", json={"priority": 9})
        check("prioridad fuera de 1..4 → 400", r.status_code == 400, r.status_code)
        r = await c.put(f"{API}/{l1['shipment_id']}", json={"manual_fields": {"client": "X"}})
        check("línea de orden real no acepta manual_fields", r.status_code == 400, r.status_code)

        r = await c.post(f"{API}/lines", json={"export_id": e1["export_id"], "order_numbers": "3446"})
        l3 = r.json()["added"][0]
        check("hereda shipping#/destino/carrier del renglón anterior",
              l3["shipping_no"] == "306" and l3["delivery_to"] == "ST ANDREWS" and l3["carrier"] == "UPS GROUND", l3)
        check("qty con coma → PCS numérico", l3["pcs"] == 10436, l3["pcs"])

        r = await c.post(f"{API}/lines/{l3['shipment_id']}/duplicate")
        dup = r.json()
        check("duplicar línea (envío partido) sin PCS", r.status_code == 200 and dup["order_number"] == "3446"
              and dup["pcs"] is None, r.text[:200])
        r = await c.get(f"{API}/week", params={"start": MARTES})
        orden = [x["order_number"] for x in r.json()["lines"] if x["export_id"] == e1["export_id"]]
        check("el duplicado queda justo debajo del original", orden == ["3352", "3353", "3446", "3446"], orden)

        r = await c.post(f"{API}/lines", json={"export_id": e1["export_id"], "order_numbers": "0", "manual": True})
        man = r.json()["added"][0]
        check("línea manual para orden fuera del CRM", man["manual"] is True and man["order_exists"] is False, man)
        r = await c.put(f"{API}/{man['shipment_id']}", json={"manual_fields": {"client": "GTS", "branding": "ROSS",
                                                                               "customer_po": "52012557"}})
        check("línea manual edita cliente/branding/PO", r.json().get("branding") == "ROSS"
              and r.json().get("customer_po") == "52012557", r.text[:200])

        r = await c.post(f"{API}/lines", json={"export_id": e2["export_id"], "order_numbers": "3446"})
        check("misma orden en OTRO export → aviso also_in (parcial)", "3446" in r.json()["also_in"], r.json())

        print("\n== Resumen anual (navegador Año → Mes → Semana) ==")
        r = await c.get(f"{API}/summary", params={"year": LUNES.year})
        sw = {w["week_start"]: w for w in r.json()["weeks"]}
        wk = sw.get(LUNES.isoformat()) or {}
        n_lines = sdb.scheduled_shipments.count_documents({"export_id": {"$exists": True}})
        check("resumen: la semana trae exports y líneas", wk.get("exports") == 2 and wk.get("lines") == n_lines, wk)
        check("resumen: año sin datos → vacío", (await c.get(f"{API}/summary", params={"year": 2099})).json()["weeks"] == [])

        print("\n== Buscador ==")
        r = await c.get(f"{API}/search", params={"q": "#3352"})
        hits = r.json()["items"]
        check("busca por número de orden (con #)", any(h["order_number"] == "3352" and h["ship_date"] == MARTES
                                                       and h["export_no"] == 81 for h in hits), hits)
        r = await c.get(f"{API}/search", params={"q": "buc92"})
        check("busca por PO (sin distinguir mayúsculas)", {h["order_number"] for h in r.json()["items"]} == {"3446"},
              r.json()["items"])
        r = await c.get(f"{API}/search", params={"q": "52012557"})
        check("busca en líneas manuales", any(h["order_number"] == "0" for h in r.json()["items"]), r.json())
        r = await c.get(f"{API}/search", params={"q": "3"})
        check("término de 1 carácter → vacío", r.json()["items"] == [])

        print("\n== Mover ==")
        r = await c.put(f"{API}/{l2['shipment_id']}", json={"export_id": e2["export_id"]})
        check("mover línea a otro export", r.json()["export_id"] == e2["export_id"], r.text[:200])
        r = await c.put(f"{API}/{l2['shipment_id']}", json={"move_to_date": JUEVES})
        x = r.json()
        check("mover línea a otra fecha crea export ese día",
              x["ship_date"] == JUEVES and sdb.shipping_exports.count_documents({"date": JUEVES}) == 1, x)
        r = await c.put(f"{API}/exports/{e2['export_id']}", json={"date": MIERCOLES})
        check("mover export de fecha", r.json()["date"] == MIERCOLES, r.text[:200])
        arr = list(sdb.scheduled_shipments.find({"export_id": e2["export_id"]}))
        check("…arrastra sus líneas", arr and all(s["ship_date"] == MIERCOLES and s["scheduled_export_date"] == MIERCOLES
                                                   for s in arr), [s.get("ship_date") for s in arr])

        print("\n== Formato anterior (API de clientes) ==")
        r = await c.post(API, json={"order_number": "3352", "scheduled_month": 9, "scheduled_week": 1})
        check("POST histórico sigue funcionando", r.status_code == 200 and r.json().get("export_id") is None, r.text[:200])
        viva = sdb.scheduled_shipments.find_one({"shipment_id": l1["shipment_id"]})
        check("…y NO pisa la línea del export", viva["export_id"] == e1["export_id"] and viva["pcs"] == 1152, viva)
        r = await c.get(API)
        check("GET \"\" lista ambos formatos", len(r.json()["items"]) == sdb.scheduled_shipments.count_documents({}))
        r = await c.get(f"{API}/week", params={"start": MARTES})
        check("la semana NO muestra registros del formato anterior",
              all(x.get("export_id") for x in r.json()["lines"]))

        print("\n== Borrar ==")
        r = await c.delete(f"{API}/exports/{e1['export_id']}")
        check("borrar export con líneas sin cascada → 409", r.status_code == 409, r.status_code)
        r = await c.delete(f"{API}/{l3['shipment_id']}")
        check("quitar una línea", r.status_code == 200)
        pos = sorted(s["position"] for s in sdb.scheduled_shipments.find({"export_id": e1["export_id"]}))
        check("posiciones se renumeran sin huecos", pos == list(range(len(pos))), pos)
        r = await c.delete(f"{API}/exports/{e1['export_id']}", params={"cascade": "true"})
        check("borrar export con cascada", r.status_code == 200 and r.json()["lines_deleted"] == 3, r.text[:200])
        check("…sin líneas huérfanas", sdb.scheduled_shipments.count_documents({"export_id": e1["export_id"]}) == 0)
        r = await c.get(f"{API}/week", params={"start": LUNES_SIG})
        check("otra semana vacía", r.json()["exports"] == [])

        print("\n== Selección múltiple y arrastre ==")
        eA = (await c.post(f"{API}/exports", json={"date": MARTES})).json()
        eB = (await c.post(f"{API}/exports", json={"date": MIERCOLES})).json()
        add = (await c.post(f"{API}/lines", json={"export_id": eA["export_id"], "order_numbers": "3352 3353 2980 2981"})).json()["added"]
        sid = {x["order_number"]: x["shipment_id"] for x in add}

        def orden(eid):
            return [s["order_number"] for s in sdb.scheduled_shipments.find({"export_id": eid}).sort("position", 1)]
        r = await c.post(f"{API}/lines/move", json={"shipment_ids": [sid["3353"], sid["2981"]], "export_id": eB["export_id"]})
        check("mover varias a otro export", r.status_code == 200 and orden(eB["export_id"]) == ["3353", "2981"]
              and orden(eA["export_id"]) == ["3352", "2980"], (orden(eA["export_id"]), orden(eB["export_id"])))
        movida = sdb.scheduled_shipments.find_one({"shipment_id": sid["3353"]})
        check("…con la fecha del destino", movida["ship_date"] == MIERCOLES and movida["scheduled_export_date"] == MIERCOLES)
        await c.post(f"{API}/lines/move", json={"shipment_ids": [sid["2980"]], "export_id": eA["export_id"], "index": 0})
        check("arrastrar dentro del bloque reacomoda", orden(eA["export_id"]) == ["2980", "3352"], orden(eA["export_id"]))
        await c.post(f"{API}/lines/move", json={"shipment_ids": [sid["3352"]], "export_id": eB["export_id"], "index": 1})
        check("soltar en medio de otro bloque respeta la posición", orden(eB["export_id"]) == ["3353", "3352", "2981"],
              orden(eB["export_id"]))
        pos = sorted(s["position"] for s in sdb.scheduled_shipments.find({"export_id": eA["export_id"]}))
        check("el origen se renumera sin huecos", pos == list(range(len(pos))), pos)
        viernes = (LUNES + timedelta(days=4)).isoformat()
        r = await c.post(f"{API}/lines/move", json={"shipment_ids": [sid["2980"], sid["2981"]], "move_to_date": viernes})
        check("mover varias a otra fecha (crea el export)", r.json().get("date") == viernes
              and sorted(orden(r.json()["export_id"])) == ["2980", "2981"], r.text[:200])
        r = await c.post(f"{API}/lines/move", json={"shipment_ids": ["no-existe"], "export_id": eA["export_id"]})
        check("línea inexistente → 404 (no mueve nada)", r.status_code == 404, r.status_code)
        r = await c.post(f"{API}/lines/delete", json={"shipment_ids": [sid["3352"], sid["3353"]]})
        check("quitar varias", r.json().get("deleted") == 2 and orden(eB["export_id"]) == [], orden(eB["export_id"]))

        print("\n== Movimientos y reversión ==")
        sdb.shipping_movements.delete_many({})

        async def movs(**params):
            return (await c.get(f"{API}/movements", params=params)).json()["items"]

        async def revertir(mid):
            return await c.post(f"{API}/movements/{mid}/revert")
        eM = (await c.post(f"{API}/exports", json={"date": MARTES})).json()
        eid = eM["export_id"]
        add = (await c.post(f"{API}/lines", json={"export_id": eid, "order_numbers": "3352 3353"})).json()["added"]
        s52, s53 = add[0]["shipment_id"], add[1]["shipment_id"]
        await c.put(f"{API}/{s52}", json={"priority": 1, "pcs": 250})
        viernes = (LUNES + timedelta(days=4)).isoformat()
        sdb.shipping_exports.delete_many({"date": viernes})
        await c.put(f"{API}/{s53}", json={"move_to_date": viernes})
        await c.delete(f"{API}/{s52}")
        m = await movs()
        check("bitácora registra cada acción (más reciente primero)",
              [x["action"] for x in m] == ["lines_delete", "lines_move", "lines_update", "lines_add", "export_create"],
              [x["action"] for x in m])
        check("resumen legible del cambio", "PRIORIDAD — → 1ª" in m[2]["summary"] and "PCS 280 → 250" in m[2]["summary"],
              m[2]["summary"])
        check("filtro por orden", {x["action"] for x in await movs(q="3353")} == {"lines_add", "lines_move"},
              [x["action"] for x in await movs(q="3353")])
        check("lo más reciente es revertible; lo que otro cambio pisó, no (con motivo)",
              m[0]["can_revert"] and not m[2]["can_revert"] and "#3352 ya no existe" in m[2]["blockers"]
              and any("#3353 cambió después (export)" in b for b in m[3]["blockers"]), [x["blockers"] for x in m])

        r = await revertir(m[0]["movement_id"])
        back = sdb.scheduled_shipments.find_one({"shipment_id": s52})
        check("revertir borrado regresa la orden con sus datos", r.status_code == 200 and back
              and back["priority"] == 1 and back["pcs"] == 250 and back["export_id"] == eid, r.text[:200])
        r = await revertir(m[0]["movement_id"])
        check("no se revierte dos veces", r.status_code == 409 and "Ya se revirtió" in str(r.json()), r.text[:200])
        m2 = await movs()
        check("la reversión queda registrada y no es revertible",
              m2[0]["action"] == "revert" and not m2[0]["can_revert"] and m2[1]["reverted_at"], m2[0])
        r = await revertir(m2[0]["movement_id"])
        check("revertir una reversión → 409", r.status_code == 409, r.status_code)

        r = await revertir(m[2]["movement_id"])
        x = sdb.scheduled_shipments.find_one({"shipment_id": s52})
        check("revertir edición regresa PRIORIDAD y PCS", r.status_code == 200 and x.get("priority") is None and x["pcs"] == 280, x)

        nuevo = sdb.shipping_exports.find_one({"date": viernes})
        r = await revertir(m[1]["movement_id"])
        y = sdb.scheduled_shipments.find_one({"shipment_id": s53})
        check("revertir movimiento regresa la orden a su export", r.status_code == 200 and y["export_id"] == eid
              and y["ship_date"] == MARTES, y)
        check("…y borra el export que ese movimiento creó",
              nuevo and sdb.shipping_exports.count_documents({"export_id": nuevo["export_id"]}) == 0)

        # Conflicto: lo que cambió después bloquea la reversión.
        a80 = (await c.post(f"{API}/lines", json={"export_id": eid, "order_numbers": "2980"})).json()["added"][0]
        await c.put(f"{API}/{a80['shipment_id']}", json={"pcs": 999})
        m3 = await movs()
        alta = next(x for x in m3 if x["action"] == "lines_add" and x["orders"] == ["2980"])
        check("cambio posterior bloquea y explica", not alta["can_revert"]
              and any("#2980 cambió después (PCS)" in b for b in alta["blockers"]), alta["blockers"])
        r = await revertir(alta["movement_id"])
        check("revertir bloqueado → 409 con motivos", r.status_code == 409 and r.json()["detail"]["reasons"], r.text[:200])
        check("…y no deja el candado puesto", not sdb.shipping_movements.find_one({"movement_id": alta["movement_id"]})["reverted_at"])
        await revertir(m3[0]["movement_id"])          # deshace el PCS 999
        r = await revertir(alta["movement_id"])
        check("deshaciendo en orden inverso sí se puede", r.status_code == 200
              and not sdb.scheduled_shipments.find_one({"shipment_id": a80["shipment_id"]}), r.text[:200])

        # Borrar un export con órdenes y revertirlo.
        n_antes = sdb.scheduled_shipments.count_documents({"export_id": eid})
        await c.delete(f"{API}/exports/{eid}", params={"cascade": "true"})
        borrado = (await movs(action="export_delete"))[0]
        r = await revertir(borrado["movement_id"])
        check("revertir borrado de export restaura export y órdenes", r.status_code == 200
              and sdb.shipping_exports.count_documents({"export_id": eid}) == 1
              and sdb.scheduled_shipments.count_documents({"export_id": eid}) == n_antes, (n_antes, r.text[:200]))
        # Un export creado no se puede "des-crear" si ya tiene órdenes ajenas.
        crea = next(x for x in await movs(action="export_create") if x["summary"].endswith(jr_fecha(MARTES)))
        check("export con órdenes agregadas después no se des-crea", not crea["can_revert"]
              and any("tiene órdenes agregadas después" in b for b in crea["blockers"]), crea["blockers"])


try:
    asyncio.run(main())
finally:
    raw.drop_database(SMOKE_DB)
    print(f"\n{ok} PASS · {fail} FAIL")
    sys.exit(1 if fail else 0)
