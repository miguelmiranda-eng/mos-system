"""Smoke de la API del módulo de Planeación (/api/planner).

Fija: permisos (leer = cualquier sesión, editar = admin), validaciones
(cabezas 8–16, turnos, calendario), que el calendario cambia la capacidad de
la proyección, que la simulación NO guarda nada, y que el motor en MODO
SOMBRA no toca ninguna orden (board, fechas, status).

SEGURIDAD: base DESECHABLE, se niega contra producción, se borra al terminar.

USO
───
    set MONGODB_URL=mongodb://usuario:clave@host:27017/?authSource=admin
    python backend/tests/smoke_planner_api.py
"""
import asyncio
import os
import sys
from datetime import date, datetime, timedelta, timezone

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


def lunes_siguiente():
    d = date.today() + timedelta(days=1)
    while d.weekday() != 0:
        d += timedelta(days=1)
    return d


CANCEL = (date.today() + timedelta(days=30)).isoformat()


def sembrar():
    print(f"== Sembrando {SMOKE_DB} ==")
    for c in ["orders", "users", "user_sessions", "board_config", "production_logs",
              "planner_config", "planner_machines", "planner_calendar", "planner_runs", "planner_overrides", "activity_logs", "sample_tasks",
              "planner_applied", "automations", "notifications"]:
        sdb[c].delete_many({})
    sdb.board_config.insert_one({"config_id": "boards", "boards": [
        "SCHEDULING", "BLANKS", "SCREENS", "NECK", "MAQUINA1", "MAQUINA2", "MAQUINA3", "COMPLETOS"]})
    base = {"client": "GOODIE TWO SLEEVES", "branding": "SPENCERS", "cancel_date": CANCEL,
            "blank_status": "CONTADO", "screens": True, "production_status": "LABEL LISTO",
            "hits_impresiones": 2, "print_positions": ["FRENTE", "ESPALDA"], "colors": 6, "color": "BLACK",
            "aprobaciones": "Reorder"}
    sdb.orders.insert_many([
        {**base, "order_id": "ord_a", "order_number": "9001", "board": "BLANKS", "quantity": 3000},
        {**base, "order_id": "ord_b", "order_number": "9002", "board": "SCREENS", "quantity": 800,
         "blank_status": "SURTIDO"},
        {**base, "order_id": "ord_c", "order_number": "9003", "board": "BLANKS", "quantity": 500,
         "screens": None},                                   # no lista: sin cuadros
        {**base, "order_id": "ord_d", "order_number": "9004", "board": "MAQUINA2", "quantity": 1000,
         "production_status": "EN PRODUCCION"},              # ya en máquina
        {**base, "order_id": "ord_e", "order_number": "9005", "board": "COMPLETOS", "quantity": 999},
        {**base, "order_id": "ord_f", "order_number": "9006", "board": "BLANKS", "quantity": 400,
         "colors": None, "hits_impresiones": None, "print_positions": None},
        {**base, "order_id": "ord_g", "order_number": "9007", "board": "MAQUINA1", "quantity": 500,
         "print_positions": ["FRENTE"], "hits_impresiones": 1, "production_status": "EN PRODUCCION"},
    ])
    # ord_h: NUEVA con ejemplo aprobado en el módulo de Ejemplos; ord_i: NUEVA sin aprobar.
    sdb.orders.insert_many([
        {**base, "order_id": "ord_h", "order_number": "9008", "board": "BLANKS", "quantity": 300,
         "aprobaciones": "Ejemplo primero"},
        {**base, "order_id": "ord_i", "order_number": "9009", "board": "BLANKS", "quantity": 300,
         "aprobaciones": "Ejemplo primero"},
    ])
    sdb.sample_tasks.delete_many({})
    sdb.sample_tasks.insert_one({"sample_task_id": "st_h", "order_id": "ord_h", "approval": "APROBADO"})
    # ord_g: impresa completa hace 3 días y su estatus no avanzó -> alerta.
    hace3 = (datetime.now(timezone.utc) - timedelta(days=3)).isoformat()
    sdb.production_logs.insert_one({"log_id": "pl_g", "order_id": "ord_g", "order_number": "9007",
                                    "quantity_produced": 500, "machine": "MAQUINA1", "shift": "TURNO 1",
                                    "design_type": "FRENTE", "created_at": hace3})
    sdb.users.insert_many([
        {"user_id": "u_sup", "email": "sup@test.local", "name": "Planeador",
         "password_hash": bcrypt.hash("sup123"), "role": "supersu", "admin_level": 5, "active": True},
        {"user_id": "u_op", "email": "op@test.local", "name": "Operador",
         "password_hash": bcrypt.hash("op123"), "role": "operator", "active": True},
        # admin (no supersu): el candado de QC SÍ le aplica.
        {"user_id": "u_adm", "email": "adm@test.local", "name": "Admin Planeación",
         "password_hash": bcrypt.hash("adm123"), "role": "admin", "admin_level": 5, "active": True},
    ])


async def main():
    sembrar()
    from httpx import ASGITransport, AsyncClient
    from server import app

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://smoke") as sup, \
               AsyncClient(transport=ASGITransport(app=app), base_url="http://smoke") as op:
        r = await sup.post("/api/auth/login", json={"email": "sup@test.local", "password": "sup123"})
        check("login planeador", r.status_code == 200, r.status_code)
        r = await op.post("/api/auth/login", json={"email": "op@test.local", "password": "op123"})
        check("login operador", r.status_code == 200, r.status_code)

        print("\n== Configuración ==")
        r = await op.get("/api/planner/config")
        check("operador puede leer", r.status_code == 200, r.status_code)
        d = r.json()
        check("máquinas salen de los tableros MAQUINA<n>", [m["machine"] for m in d["machines"]] ==
              ["MAQUINA1", "MAQUINA2", "MAQUINA3"], d["machines"])
        check("defaults: 9 de día, 4 de noche, 7 por cuadrilla",
              [s["crews"] for s in d["config"]["shifts"]] == [9, 4] and d["config"]["people_per_crew"] == 7)
        check("eficiencia por defecto = 100% (regla de 4,500)", d["efficiency"]["applied"] == 1.0, d["efficiency"])
        r = await op.put("/api/planner/config", json={"people_per_crew": 8})
        check("operador NO puede editar", r.status_code == 403, r.status_code)
        r = await sup.put("/api/planner/config", json={"regla_rara": 1})
        check("regla desconocida -> 400", r.status_code == 400, r.status_code)
        r = await sup.put("/api/planner/config", json={"volume_low_max": 3000})
        check("Bajo > Alto -> 400", r.status_code == 400, r.status_code)
        check("el motor arranca APAGADO", d["config"]["engine_mode"] == "off", d["config"]["engine_mode"])
        r = await sup.post("/api/planner/shadow-run")
        check("apagado: no corre (409)", r.status_code == 409, r.status_code)
        r = await op.put("/api/planner/config", json={"engine_mode": "shadow"})
        check("operador NO puede encender el motor", r.status_code == 403, r.status_code)
        r = await sup.put("/api/planner/config", json={"engine_mode": "auto"})
        check("modo automático todavía bloqueado -> 400", r.status_code == 400, r.status_code)
        r = await sup.put("/api/planner/config", json={"shifts": [
            {"key": "DIA", "start": "07:00", "hours": 12, "crews": 2},
            {"key": "NOCHE", "start": "19:00", "hours": 12, "crews": 1}]})
        check("cambiar cuadrillas", r.status_code == 200 and r.json()["config"]["shifts"][0]["crews"] == 2,
              r.text[:200])

        print("\n== Máquinas ==")
        r = await sup.put("/api/planner/machines/MAQUINA1", json={"heads": 20})
        check("cabezas fuera de 8–16 -> 400", r.status_code == 400, r.status_code)
        r = await sup.put("/api/planner/machines/MAQUINA9", json={"heads": 10})
        check("máquina que no es tablero -> 404", r.status_code == 404, r.status_code)
        r = await sup.put("/api/planner/machines/MAQUINA3", json={"active": False, "heads": 8,
                                                                  "preferred_client": "SPEKTRUM"})
        m3 = next(m for m in r.json()["machines"] if m["machine"] == "MAQUINA3")
        check("editar máquina", m3["active"] is False and m3["heads"] == 8 and m3["preferred_client"] == "SPEKTRUM", m3)

        print("\n== Calendario y proyección ==")
        r = await sup.get("/api/planner/projection")
        check("proyección 200", r.status_code == 200, r.text[:200])
        p0 = r.json()
        check("capacidad semana 2 = 4 días × (2+1) × 4,500 (festivos aparte)",
              p0["weeks"][1]["capacity"] == 4 * 3 * 4500 or p0["weeks"][1]["holidays"], p0["weeks"][1]["capacity"])
        wj = [j for w in p0["weeks"] for j in w.get("jobs", [])]
        check("cada semana trae el detalle de sus órdenes", any(j["order_id"] == "ord_a" for j in wj)
              and all({"order_number", "client", "kind", "ready", "remaining", "target_date"} <= set(j) for j in wj))
        check("detalle = demanda de la semana", all(sum(j["remaining"] for j in w["jobs"]) == w["demand"] for w in p0["weeks"]))
        check("demanda: la lista y la no lista se separan",
              sum(w["demand_ready"] for w in p0["weeks"]) > 0 and sum(w["demand_not_ready"] for w in p0["weeks"]) > 0)
        viernes = (lunes_siguiente() + timedelta(days=4)).isoformat()
        r = await sup.post("/api/planner/projection/simulate",
                           json={"entries": [{"kind": "overtime", "date_from": viernes, "shift": "DIA", "crews": 2}]})
        wk = next(w for w in r.json()["weeks"] if w["week_start"] == lunes_siguiente().isoformat())
        base_wk = next(w for w in p0["weeks"] if w["week_start"] == lunes_siguiente().isoformat())
        check("simulación: +1 turno extra de 2 cuadrillas = +9,000", wk["capacity"] - base_wk["capacity"] == 9000,
              (wk["capacity"], base_wk["capacity"]))
        check("la simulación no guarda nada", sdb.planner_calendar.count_documents({}) == 0)
        r = await op.post("/api/planner/calendar", json={"kind": "holiday", "date_from": viernes})
        check("operador NO da de alta calendario", r.status_code == 403, r.status_code)
        r = await sup.post("/api/planner/calendar", json={"kind": "crews", "date_from": viernes})
        check("cuadrillas sin número -> 400", r.status_code == 400, r.status_code)
        r = await sup.post("/api/planner/calendar", json={"kind": "overtime", "date_from": viernes,
                                                          "shift": "DIA", "crews": 2, "note": "Sábado extra"})
        check("alta de tiempo extra", r.status_code == 200 and len(r.json()["calendar"]) == 1, r.text[:200])
        cal_id = r.json()["calendar"][0]["cal_id"]
        r = await sup.get("/api/planner/projection")
        wk2 = next(w for w in r.json()["weeks"] if w["week_start"] == lunes_siguiente().isoformat())
        check("el calendario guardado sube la capacidad", wk2["capacity"] - base_wk["capacity"] == 9000)
        r = await sup.post("/api/planner/calendar", json={"kind": "overtime", "date_from": viernes, "shift": "DIA",
                                                          "crews": 2, "hours": 30})
        check("horas fuera de rango -> 400", r.status_code == 400, r.status_code)
        r = await sup.put(f"/api/planner/calendar/{cal_id}", json={"kind": "overtime", "date_from": viernes,
                                                                   "shift": "DIA", "crews": 2, "start": "07:00", "hours": 6})
        check("editar tiempo extra: 6 horas", r.status_code == 200 and r.json()["calendar"][0]["hours"] == 6, r.text[:200])
        r = await sup.get("/api/planner/projection")
        wk3 = next(w for w in r.json()["weeks"] if w["week_start"] == lunes_siguiente().isoformat())
        check("6 h de 12 = la mitad: +4,500", wk3["capacity"] - base_wk["capacity"] == 4500, wk3["capacity"] - base_wk["capacity"])
        r = await op.put(f"/api/planner/calendar/{cal_id}", json={"kind": "overtime", "date_from": viernes, "crews": 1})
        check("operador NO edita calendario", r.status_code == 403, r.status_code)
        r = await sup.delete(f"/api/planner/calendar/{cal_id}")
        check("borrar excepción", r.status_code == 200 and r.json()["calendar"] == [])
        r = await sup.get("/api/planner/holidays", params={"year": 2026})
        check("festivos oficiales 2026 incluyen 16-sep",
              any(h["date"] == "2026-09-16" for h in r.json()["official"]))

        print("\n== Motor en modo sombra ==")
        r = await sup.put("/api/planner/config", json={"engine_mode": "shadow"})
        check("encender en modo sombra", r.status_code == 200 and r.json()["config"]["engine_mode"] == "shadow")
        antes = {o["order_id"]: o for o in sdb.orders.find({}, {"_id": 0})}
        r = await sup.post("/api/planner/shadow-run")
        check("corrida 200", r.status_code == 200, r.text[:300])
        run = r.json()
        despues = {o["order_id"]: o for o in sdb.orders.find({}, {"_id": 0})}
        check("MODO SOMBRA: ninguna orden cambió", antes == despues)
        jobs = {j["job_id"]: j for j in run["jobs"]}
        check("la no lista (sin cuadros) no se programa", not any(j.startswith("ord_c") for j in jobs))
        check("la no lista aparece como bloqueada", any(b["order_id"] == "ord_c" for b in run["blocked"]))
        check("SURTIDO sí se programa", "ord_b:FRENTE" in jobs)
        check("completada no entra", not any(j.startswith("ord_e") for j in jobs))
        check("máquina inactiva no recibe trabajo",
              all("MAQUINA3" not in j["machines"] for j in run["jobs"]))
        check("la que ya está en MAQUINA2 sigue ahí",
              any("MAQUINA2" in jobs[k]["machines"] for k in jobs if k.startswith("ord_d")))
        check("movimientos propuestos no incluyen la que ya está montada",
              all(m["order_id"] != "ord_d" for m in run["moves"]))
        r = await sup.post("/api/planner/shadow-run", params={"trigger": "auto_change", "max_age": 600})
        check("recálculo automático reusa la corrida reciente", r.json().get("reused") is True
              and r.json()["run_id"] == run["run_id"])
        r = await sup.post("/api/planner/shadow-run", params={"trigger": "auto_timer"})
        check("sin max_age recalcula y etiqueta el disparador",
              r.json()["run_id"] != run["run_id"] and r.json()["trigger"] == "auto_timer")
        timer_run_id = r.json()["run_id"]
        check("defaults: recálculo automático cada 15 min", d["config"]["auto_recalc"] is True
              and d["config"]["auto_recalc_minutes"] == 15)
        wins = run.get("windows", [])
        check("semana completa: 7 días × 2 turnos × horizonte", len(wins) == 7 * 2 * 8, len(wins))
        check("la semana arranca en lunes", date.fromisoformat(wins[0]["date"]).weekday() == 0)
        vie = [w for w in wins if date.fromisoformat(w["date"]).weekday() == 4]
        check("viernes sin tiempo extra = 0 cuadrillas", all(w["crews"] == 0 for w in vie))
        jr = {j["job_id"]: j for j in run["jobs"]}
        check("nueva con ejemplo aprobado entra al programa", "ord_h:FRENTE" in jr and jr["ord_h:FRENTE"]["kind"] == "NUEVA")
        bi = next((b for b in run["blocked"] if b["job_id"] == "ord_i:FRENTE"), None)
        check("nueva sin ejemplo queda bloqueada por ejemplo", bi is not None and bi["ready"]["ejemplo"] is False
              and bi["kind"] == "NUEVA", bi)
        r = await sup.get("/api/planner/shadow-run/latest")
        check("última corrida guardada", r.json().get("run_id") == timer_run_id)

        print("\n== Ajustes manuales ==")
        r = await op.post("/api/planner/overrides", json={"order_id": "ord_b", "position": "FRENTE",
                                                          "kind": "assign", "params": {"machine": "MAQUINA1"}})
        check("operador NO puede reprogramar", r.status_code == 403, r.status_code)
        r = await sup.post("/api/planner/overrides", json={"order_id": "ord_b", "position": "FRENTE",
                                                           "kind": "assign", "params": {}})
        check("reprogramar sin máquina ni fecha -> 400", r.status_code == 400, r.status_code)
        r = await sup.post("/api/planner/overrides", json={"order_id": "nope", "kind": "force"})
        check("orden inexistente -> 404", r.status_code == 404, r.status_code)
        r = await sup.post("/api/planner/overrides", json={"order_id": "ord_b", "position": "FRENTE",
                                                           "kind": "assign", "reason": "prueba",
                                                           "params": {"machine": "MAQUINA1", "queue_pos": 1}})
        check("reprogramar 200", r.status_code == 200, r.text[:200])
        ov_assign = r.json()["override"]["override_id"]
        r = await sup.post("/api/planner/overrides", json={"order_id": "ord_c", "position": "*", "kind": "force",
                                                           "reason": "label sale hoy"})
        check("forzar entrada de toda la orden", r.status_code == 200)
        r = await sup.post("/api/planner/overrides", json={"order_id": "ord_a", "position": "*", "kind": "hold"})
        check("retener", r.status_code == 200)
        antes = {o["order_id"]: o for o in sdb.orders.find({}, {"_id": 0})}
        run2 = (await sup.post("/api/planner/shadow-run")).json()
        despues = {o["order_id"]: o for o in sdb.orders.find({}, {"_id": 0})}
        check("con ajustes: ninguna orden del CRM cambió", antes == despues)
        j2 = {j["job_id"]: j for j in run2["jobs"]}
        check("reprogramada en la máquina elegida", j2.get("ord_b:FRENTE", {}).get("machines") == ["MAQUINA1"],
              j2.get("ord_b:FRENTE"))
        check("forzada entra con sus 2 posiciones", "ord_c:FRENTE" in j2 and "ord_c:ESPALDA" in j2)
        check("retenida sale y aparece como retenida",
              "ord_a:FRENTE" not in j2 and any(b["job_id"] == "ord_a:FRENTE" and b["held"] for b in run2["blocked"]))
        check("impacto contra la corrida anterior", any(i["job_id"] == "ord_a:FRENTE" for i in run2["impact"]),
              run2["impact"])
        r = await sup.post("/api/planner/overrides", json={"order_id": "ord_b", "position": "FRENTE",
                                                           "kind": "assign", "params": {"machine": "MAQUINA2"}})
        check("un nuevo ajuste del mismo tipo reemplaza al anterior", r.json().get("replaced") == 1)
        r = await sup.get("/api/planner/overrides")
        d = r.json()
        check("3 ajustes activos + 1 en historial", len(d["active"]) == 3 and len(d["history"]) == 1,
              (len(d["active"]), len(d["history"])))
        r = await sup.delete(f"/api/planner/overrides/{ov_assign}")
        check("deshacer uno ya reemplazado -> 404", r.status_code == 404, r.status_code)
        hold_id = next(o["override_id"] for o in d["active"] if o["kind"] == "hold")
        r = await sup.delete(f"/api/planner/overrides/{hold_id}")
        check("deshacer retención", r.status_code == 200)
        run3 = (await sup.post("/api/planner/shadow-run")).json()
        check("al deshacer, el motor la vuelve a programar", any(j["job_id"] == "ord_a:FRENTE" for j in run3["jobs"]))
        check("historial conserva lo deshecho",
              sdb.planner_overrides.count_documents({"active": False}) == 2)

        print("\n== Alertas ==")
        r = await op.get("/api/planner/alerts")
        al = r.json()
        check("alertas: cualquier sesión puede verlas", r.status_code == 200, r.status_code)
        g = next((x for x in al["printed_stale"] if x["order_id"] == "ord_g"), None)
        check("impresa hace 3 días sin avanzar de estatus -> alerta", g is not None and g["days"] >= 2.9, al)
        check("la impresa completa no queda en el programa", not any(j["order_id"] == "ord_g" for j in run3["jobs"]))

        print("\n== Autorizar movimientos ==")
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://smoke") as adm:
            r = await adm.post("/api/auth/login", json={"email": "adm@test.local", "password": "adm123"})
            check("login admin", r.status_code == 200, r.status_code)
            # Tiempo extra hoy y mañana para que haya trabajo arrancando YA,
            # sin importar el día de la semana en que corra la prueba.
            hoy = date.today()
            await sup.post("/api/planner/calendar", json={"kind": "overtime", "date_from": (hoy - timedelta(days=1)).isoformat(),
                                                          "date_to": (hoy + timedelta(days=1)).isoformat(),
                                                          "shift": "AMBOS", "crews": 3})
            run4 = (await sup.post("/api/planner/shadow-run")).json()
            mv = run4.get("moves") or []
            check("hay movimientos propuestos", len(mv) >= 2, len(mv))
            m1, m2 = mv[0], mv[1]
            r = await op.post("/api/planner/moves/apply", json={"run_id": run4["run_id"], "order_ids": [m1["order_id"]]})
            check("operador NO autoriza movimientos", r.status_code == 403, r.status_code)
            r = await sup.post("/api/planner/moves/apply", json={"run_id": "prun_viejo", "order_ids": [m1["order_id"]]})
            check("corrida vieja -> 409 (recalcula primero)", r.status_code == 409, r.status_code)
            antes_otras = {o["order_id"]: o["board"] for o in sdb.orders.find({"order_id": {"$ne": m1["order_id"]}}, {"_id": 0})}
            r = await sup.post("/api/planner/moves/apply", json={"run_id": run4["run_id"], "order_ids": [m1["order_id"]]})
            res = r.json()
            check("aplicar 1 movimiento", r.status_code == 200 and res.get("applied") == 1, r.text[:300])
            o1 = sdb.orders.find_one({"order_id": m1["order_id"]}, {"_id": 0})
            check("la orden quedó en su máquina, en cola y con día", o1["board"] == m1["to_board"]
                  and o1.get("queue_status") == "queued" and o1.get("scheduled_day"), o1.get("board"))
            despues_otras = {o["order_id"]: o["board"] for o in sdb.orders.find({"order_id": {"$ne": m1["order_id"]}}, {"_id": 0})}
            check("sólo se movió la autorizada", antes_otras == despues_otras)
            check("bitácora del CRM (move_order)", sdb.activity_logs.count_documents(
                {"action": "move_order", "details.order_id": m1["order_id"]}) == 1)
            r = await sup.post("/api/planner/moves/apply", json={"run_id": run4["run_id"], "order_ids": [m1["order_id"]]})
            check("aplicar dos veces no la vuelve a mover (ya no está en origen)",
                  r.json()["results"][0]["result"] == "skipped", r.json())
            # Candado de QC: el admin (no supersu) no puede mover una orden bloqueada.
            sdb.orders.update_one({"order_id": m2["order_id"]}, {"$set": {"locked_by_qc": True}})
            r = await adm.post("/api/planner/moves/apply", json={"run_id": run4["run_id"], "order_ids": [m2["order_id"]]})
            check("candado de QC bloquea el movimiento", r.json()["results"][0]["result"] == "blocked"
                  and sdb.orders.find_one({"order_id": m2["order_id"]})["board"] == m2["from_board"], r.json())
            sdb.orders.update_one({"order_id": m2["order_id"]}, {"$unset": {"locked_by_qc": ""}})
            # Revertir
            ap = (await sup.get("/api/planner/moves/applied")).json()["rows"]
            check("movimiento aplicado en la bitácora del módulo", len(ap) == 1 and ap[0]["status"] == "applied")
            r = await op.post(f"/api/planner/moves/applied/{ap[0]['apply_id']}/revert")
            check("operador NO revierte", r.status_code == 403, r.status_code)
            r = await sup.post(f"/api/planner/moves/applied/{ap[0]['apply_id']}/revert")
            o1b = sdb.orders.find_one({"order_id": m1["order_id"]}, {"_id": 0})
            check("revertir regresa al tablero de origen", r.status_code == 200 and o1b["board"] == m1["from_board"], r.text[:200])
            r = await sup.post(f"/api/planner/moves/applied/{ap[0]['apply_id']}/revert")
            check("revertir dos veces -> 409", r.status_code == 409, r.status_code)
            # No se revierte si alguien ya la movió a otro lado.
            run5 = (await sup.post("/api/planner/shadow-run")).json()
            m3 = next((m for m in run5["moves"] if m["order_id"] == m1["order_id"]), run5["moves"][0])
            await sup.post("/api/planner/moves/apply", json={"run_id": run5["run_id"], "order_ids": [m3["order_id"]]})
            sdb.orders.update_one({"order_id": m3["order_id"]}, {"$set": {"board": "NECK"}})
            ap2 = (await sup.get("/api/planner/moves/applied")).json()["rows"][0]
            r = await sup.post(f"/api/planner/moves/applied/{ap2['apply_id']}/revert")
            check("si la movieron después, no se pisa (409)", r.status_code == 409, r.status_code)

        print("\n== Calidad de datos ==")
        r = await sup.get("/api/planner/data-quality")
        dq = r.json()
        f = next((x for x in dq["rows"] if x["order_id"] == "ord_f"), None)
        check("orden sin hits/posiciones/colores reportada",
              f and {"sin_hits", "sin_posiciones", "sin_colores"} <= set(f["flags"]), f)
        check("bitácora registra los cambios",
              sdb.activity_logs.count_documents({"action": {"$regex": "^planner_"}}) >= 4)


try:
    asyncio.run(main())
finally:
    raw.drop_database(SMOKE_DB)
    print(f"\n== Base {SMOKE_DB} eliminada ==")
    print(f"{ok} PASS · {fail} FAIL")
    sys.exit(1 if fail else 0)
