"""Smoke de Reportes Automáticos (programaciones) + Reporte Ejecutivo de Producción.

Fija: catálogo FIJO de reportes (uno por tipo, sin crear ni borrar); la
configuración única de antes y un ejecutivo creado con la versión anterior
(rsch_...) se adoptan como los registros fijos sin perder destinatarios/hora/
estado ni su bitácora; edición (permisos, días de la semana, destinatarios); la cuenta de
production_kpis con las definiciones de los registros de facturación 2026 (día
operativo: la noche capturada de madrugada es del día en que empezó; units = por
orden, la ubicación con más impresiones; pruebas de máquina excluidas; clientes
GTS / Spektrum / Miscellaneous; metas por turno); el HTML/asunto del ejecutivo; _due (ventana, días, ya
enviado); el tick manda una sola vez por día y, si falla, libera el claim y
registra el error; el dashboard expone piezas.

SEGURIDAD: base DESECHABLE, se niega contra producción, se borra al terminar.
No manda correos: el envío se sustituye por una captura.

USO
───
    set MONGODB_URL=mongodb://usuario:clave@host:27017/?authSource=admin
    python backend/tests/smoke_report_schedules.py
"""
import asyncio
import os
import sys
from datetime import datetime, timedelta, timezone

BE = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
SMOKE_DB = os.environ.get("SMOKE_DB_NAME", "mos-smoke-report-schedules")
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


def sembrar(kpis, TZ):
    print(f"== Sembrando {SMOKE_DB} ==")
    for c in ["orders", "users", "user_sessions", "board_config", "production_logs", "production_goals",
              "planner_config", "planner_machines", "planner_calendar", "report_schedules", "report_sends",
              "activity_logs", "sample_tasks"]:
        sdb[c].delete_many({})
    sdb.board_config.insert_one({"config_id": "boards", "boards": [
        "SCHEDULING", "BLANKS", "MAQUINA1", "MAQUINA2", "COMPLETOS"]})
    now = datetime.now(TZ)
    today = kpis.op_today(now)
    Y = today - timedelta(days=1)
    cancel = (now.date() + timedelta(days=20)).isoformat()
    base = {"client": "GOODIE TWO SLEEVES", "branding": "SPENCERS", "cancel_date": cancel,
            "blank_status": "CONTADO", "screens": True, "colors": 4, "aprobaciones": "Reorder"}
    sdb.orders.insert_many([
        {**base, "order_id": "ord_a", "order_number": "7001", "board": "MAQUINA1", "quantity": 1000,
         "print_positions": ["FRENTE", "ESPALDA"], "hits_impresiones": 2, "production_status": "EN PRODUCCION"},
        {**base, "order_id": "ord_b", "order_number": "7002", "board": "BLANKS", "quantity": 600, "client": "SPEKTRUM",
         "print_positions": ["FRENTE"], "hits_impresiones": 1, "production_status": "LABEL LISTO"},
        {**base, "order_id": "ord_t", "order_number": "7003", "board": "BLANKS", "quantity": 100,
         "branding": "SPENCERS TEST", "print_positions": ["FRENTE"], "hits_impresiones": 1,
         "production_status": "LABEL LISTO"},                                       # Test Order sin imprimir
    ])

    def at(d, h, m=0):
        return datetime(d.year, d.month, d.day, h, m, tzinfo=TZ).astimezone(timezone.utc).isoformat()

    def log(lid, oid, qty, shift, created, pos="FRENTE", machine="MAQUINA1"):
        return {"log_id": lid, "order_id": oid, "order_number": oid, "quantity_produced": qty,
                "machine": machine, "shift": shift, "design_type": pos, "created_at": created}
    sdb.production_logs.insert_many([
        log("l1", "ord_a", 400, "TURNO 1", at(Y, 10)),                                   # frente 400
        log("l2", "ord_b", 300, "TURNO 2", at(Y, 23), machine="MAQUINA2"),               # 300 = 300
        log("l3", "ord_a", 200, "TURNO 2", at(Y + timedelta(days=1), 3), pos="ESPALDA"), # madrugada → es de AYER
        log("l4", "ord_gone", 10, "TURNO 1", at(Y, 12)),                                 # orden borrada → Misc
        {**log("l7", "ord_x", 400, "TURNO 1", at(Y, 9)), "order_number": "MACHINE_TEST1"},  # prueba: fuera
        log("l5", "ord_a", 999, "TURNO 2", at(Y, 3)),                                    # madrugada de ayer → ANTEAYER
        log("l6", "ord_b", 50, "TURNO 1", at(today, 8), machine="MAQUINA2"),             # hoy
    ])
    sdb.production_goals.insert_one({"date": Y.isoformat(), "day": 1000,
                                     "shifts": {"TURNO 1": 600, "TURNO 2": 400}})
    # La configuración ÚNICA de antes del refactor (sin schedule_id).
    sdb.report_schedules.insert_one({"config_id": "daily_production", "enabled": True, "hour": 18, "minute": 30,
                                     "recipients": ["viejo@test.local"], "preset": "yesterday",
                                     "format": "excel", "subject": "Reporte Diario de Producción",
                                     "quotes_report": False, "last_sent_date": now.strftime("%Y-%m-%d")})
    # Un ejecutivo creado con la versión anterior (botón "Nuevo reporte").
    sdb.report_schedules.insert_one({"schedule_id": "rsch_viejo1", "report_type": "executive_production",
                                     "name": "Production Report (executive)", "enabled": False, "hour": 7,
                                     "minute": 15, "weekdays": [0, 1, 2, 3, 4, 5, 6], "lang": "es",
                                     "recipients": ["luke@test.local"], "subject": "Production Report",
                                     "last_sent_date": None, "created_at": "2026-10-09T18:51:42+00:00"})
    sdb.report_sends.insert_one({"send_id": "rs_old", "schedule_id": "rsch_viejo1", "ok": True, "trigger": "test",
                                 "recipients": ["luke@test.local"], "at": "2026-10-09T19:00:00+00:00"})
    sdb.users.insert_many([
        {"user_id": "u_sup", "email": "sup@test.local", "name": "Sup", "password_hash": bcrypt.hash("sup123"),
         "role": "supersu", "admin_level": 5, "active": True},
        {"user_id": "u_op", "email": "op@test.local", "name": "Op", "password_hash": bcrypt.hash("op123"),
         "role": "operator", "active": True},
    ])
    return now, today, Y


async def main():
    from services import production_kpis as kpis
    from routers import report_scheduler as rs
    TZ = kpis.TZ
    now, today, Y = sembrar(kpis, TZ)
    from httpx import ASGITransport, AsyncClient
    from server import app

    print("\n== Regla de día operativo ==")
    d = datetime(2026, 10, 9, 3, 0, tzinfo=TZ)
    check("noche capturada 03:00 = día anterior", str(kpis.op_date(d, "TURNO 2")) == "2026-10-08")
    check("día capturado 03:00 se queda en su día", str(kpis.op_date(d, "TURNO 1")) == "2026-10-09")
    check("noche 23:00 = mismo día", str(kpis.op_date(d.replace(hour=23), "TURNO 2")) == "2026-10-09")
    check("antes de 07:00 el día operativo sigue siendo ayer", str(kpis.op_today(d)) == "2026-10-08")
    m = kpis.measure([{"order": "o1", "pos": "FRENTE", "n": 5000}, {"order": "o1", "pos": "ESPALDA", "n": 5000},
                      {"order": "o2", "pos": "FRENTE", "n": 300}])
    check("frente 5,000 + espalda 5,000 = 5,000 units y 10,000 hits (+300 de otra orden)",
          m == {"hits": 10300, "units": 5300}, m)
    check("pruebas de máquina: TEST/UNDO/PROD_/MACHINE_",
          all(kpis.is_machine_test(x) for x in ("TEST-01", "undo 5", "PROD_X", "MACHINE_3"))
          and not kpis.is_machine_test("7001"))
    check("grupos de cliente", [kpis.client_group(x) for x in ("GOODIE TWO SLEEVES", "Spektrum Inc", "LOVE IN FAITH", "")]
          == ["Goodie Two Sleeves", "Spektrum", "Miscellaneous", "Miscellaneous"])

    print("\n== _due ==")
    cfg = {"enabled": True, "recipients": ["a@b.c"], "hour": 7, "minute": 15, "weekdays": [0, 1, 2, 3, 4],
           "last_sent_date": None}
    fri = datetime(2026, 10, 9, 7, 20, tzinfo=TZ)
    check("viernes 07:20 con 07:15 → toca", rs._due(cfg, fri))
    check("antes de la hora no", not rs._due(cfg, fri.replace(minute=10)))
    check("más de 1 h tarde no", not rs._due(cfg, fri.replace(hour=8, minute=30)))
    check("sábado fuera de días no", not rs._due(cfg, fri + timedelta(days=1)))
    check("ya enviado hoy no", not rs._due({**cfg, "last_sent_date": "2026-10-09"}, fri))
    check("apagado no", not rs._due({**cfg, "enabled": False}, fri))
    check("sin destinatarios no", not rs._due({**cfg, "recipients": []}, fri))

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://smoke") as sup, \
               AsyncClient(transport=ASGITransport(app=app), base_url="http://smoke") as op:
        r = await sup.post("/api/auth/login", json={"email": "sup@test.local", "password": "sup123"})
        check("login sup", r.status_code == 200, r.status_code)
        r = await op.post("/api/auth/login", json={"email": "op@test.local", "password": "op123"})
        check("login operador", r.status_code == 200, r.status_code)

        print("\n== Migración de la configuración vieja ==")
        r = await op.get("/api/report-schedule")
        old = r.json()
        check("GET viejo sigue respondiendo", r.status_code == 200, r.status_code)
        check("se migró a schedule_id daily_production / production_daily",
              old.get("schedule_id") == "daily_production" and old.get("report_type") == "production_daily", old)
        check("conserva destinatarios, hora, estado y preset",
              old["recipients"] == ["viejo@test.local"] and old["hour"] == 18 and old["minute"] == 30
              and old["enabled"] is True and old["preset"] == "yesterday", old)
        check("weekdays por defecto = todos", old["weekdays"] == [0, 1, 2, 3, 4, 5, 6], old.get("weekdays"))
        check("un documento por tipo (sin duplicar)", sdb.report_schedules.count_documents({}) == 2)
        ex0 = sdb.report_schedules.find_one({"schedule_id": "executive_production"})
        check("el ejecutivo viejo (rsch_) se adoptó como 'executive_production' con su configuración",
              ex0 and ex0["recipients"] == ["luke@test.local"] and ex0["lang"] == "es"
              and not sdb.report_schedules.find_one({"schedule_id": "rsch_viejo1"}), ex0)
        check("su bitácora se movió con él", sdb.report_sends.find_one({"send_id": "rs_old"})["schedule_id"]
              == "executive_production")
        r = await sup.put("/api/report-schedule", json={"hour": 19})
        check("PUT viejo edita la original", r.status_code == 200 and r.json()["hour"] == 19, r.text[:200])

        print("\n== Catálogo de reportes ==")
        r = await op.get("/api/report-schedules")
        lst = r.json()
        check("lista: los 2 reportes del catálogo, en orden",
              [x["schedule_id"] for x in lst["schedules"]] == ["daily_production", "executive_production"], lst)
        check("nombre fijo por tipo (no el guardado)",
              lst["schedules"][1]["name"] == "Reporte ejecutivo de producción", lst["schedules"][1]["name"])
        r = await sup.post("/api/report-schedules", json={"report_type": "executive_production"})
        check("ya no se crean reportes (405)", r.status_code == 405, r.status_code)
        r = await sup.delete("/api/report-schedules/executive_production")
        check("ya no se borran reportes (405)", r.status_code == 405, r.status_code)
        sid = "executive_production"
        r = await op.put(f"/api/report-schedules/{sid}", json={"enabled": True})
        check("operador no edita (403)", r.status_code == 403, r.status_code)
        r = await sup.put(f"/api/report-schedules/{sid}", json={"recipients": ["Luke@Test.local", "luke@test.local",
                                                                              "angel@test.local"]})
        check("destinatarios por reporte, en minúsculas y sin repetidos",
              r.json()["recipients"] == ["luke@test.local", "angel@test.local"], r.json().get("recipients"))
        d0 = sdb.report_schedules.find_one({"schedule_id": "daily_production"})
        check("los destinatarios del diario no se tocan", d0["recipients"] == ["viejo@test.local"], d0["recipients"])
        r = await sup.put(f"/api/report-schedules/{sid}", json={"weekdays": []})
        check("sin días = 400", r.status_code == 400, r.status_code)
        r = await sup.put(f"/api/report-schedules/{sid}", json={"weekdays": [4, 0, 9, 1], "lang": "es", "preset": "month"})
        e2 = r.json()
        check("días válidos ordenados, idioma es", e2["weekdays"] == [0, 1, 4] and e2["lang"] == "es", e2)
        check("campos de otro tipo se ignoran", "preset" not in sdb.report_schedules.find_one({"schedule_id": sid}))
        await sup.put(f"/api/report-schedules/{sid}", json={"recipients": ["luke@test.local"]})

        print("\n== Indicadores (vista previa del ejecutivo) ==")
        await sup.put(f"/api/report-schedules/{sid}", json={"lang": "en"})
        r = await sup.get(f"/api/report-schedules/{sid}/preview")
        pv = r.json()
        k = pv.get("kpis") or {}
        y, t = k.get("yesterday") or {}, k.get("today") or {}
        check("preview 200 sin secciones caídas", r.status_code == 200 and not k.get("unavailable"), k.get("unavailable"))
        check("ayer = 910 hits (noche de madrugada incluida, la de anteayer no)", y.get("hits") == 910, y.get("hits"))
        check("ayer = 710 unidades (orden A: max(400 frente, 200 espalda) + 300 + 10)", y.get("units") == 710, y.get("units"))
        sh = {s["shift"]: s for s in y.get("shifts", [])}
        check("turno día 410 hits / 410 pz, meta 600 (prueba de máquina fuera)",
              sh.get("TURNO 1", {}).get("hits") == 410 and sh["TURNO 1"]["units"] == 410 and sh["TURNO 1"]["goal"] == 600, sh)
        check("turno noche 500 hits / 500 pz", sh.get("TURNO 2", {}).get("hits") == 500 and sh["TURNO 2"]["units"] == 500, sh)
        check("meta del día 1000 → 91.0%", y.get("goal") == 1000 and y.get("pct") == 91.0, (y.get("goal"), y.get("pct")))
        mq = {m["machine"]: m for m in y.get("machines", [])}
        check("por máquina: MAQUINA1 610 hits / 410 pz",
              mq.get("MAQUINA1", {}).get("hits") == 610 and mq["MAQUINA1"]["units"] == 410, mq)
        cl = {c["client"]: c for c in y.get("clients", [])}
        check("por cliente: GTS 600/400, Spektrum 300/300, Misc 10/10",
              (cl["Goodie Two Sleeves"]["hits"], cl["Goodie Two Sleeves"]["units"], cl["Spektrum"]["hits"],
               cl["Spektrum"]["units"], cl["Miscellaneous"]["hits"], cl["Miscellaneous"]["units"])
              == (600, 400, 300, 300, 10, 10), cl)
        check("semana por cliente presente", len(k.get("week_clients") or []) == 3, k.get("week_clients"))
        check("hoy = 50 hits / 50 pz", t.get("hits") == 50 and t.get("units") == 50, t)
        check("1 captura de prueba de máquina excluida", k.get("excluded_test_captures") == 1, k.get("excluded_test_captures"))
        w = k.get("week") or {}
        check("semana trae hits y unidades producidas y pendientes",
              all(w.get(x) is not None for x in ("produced_hits", "produced_units", "pending_hits", "pending_units")), w)
        nw = k.get("next_week") or {}
        check("próxima semana trae demanda en hits y unidades",
              nw.get("demand_hits") is not None and nw.get("demand_units") is not None, nw)
        check("excepciones presentes", isinstance(k.get("exceptions"), dict), k.get("exceptions"))
        to = k.get("test_orders") or {}
        it = {i["order_number"]: i for i in to.get("items", [])}
        check("Test Orders: lista con la 7003 por imprimir y 100 pendientes",
              it.get("7003", {}).get("stage") == "to_print" and it["7003"]["pending"] == 100
              and to.get("open") == 1 and to.get("to_print") == 1, to)
        check("Test Orders: impreso ayer/hoy/semana en prints y unidades",
              all(set(k.get("test_printed", {}).get(x, {})) == {"hits", "units"} for x in ("yesterday", "today", "week")),
              k.get("test_printed"))
        html = pv.get("html", "")
        check("HTML con 910 y 710", "910" in html and "710" in html)
        check("HTML con tabla por cliente", "Goodie Two Sleeves" in html and "Miscellaneous" in html)
        check("HTML rotula Prints y Units", "Prints" in html and "Units" in html)
        check("asunto con prints/unidades de ayer", "910 prints / 710 units" in pv.get("subject", ""), pv.get("subject"))
        r = await sup.get("/api/report-schedules/daily_production/preview")
        check("preview del diario no genera adjuntos", r.status_code == 200 and "Reporte Diario" in r.json()["subject"],
              r.text[:200])

        print("\n== Dashboard con unidades ==")
        r = await op.get("/api/planner/dashboard")
        db_ = r.json()
        check("dashboard 200 con produced_units/pending_units/demand_units",
              r.status_code == 200 and "produced_units" in db_["this_week"] and "pending_units" in db_["this_week"]
              and "demand_units" in db_["next_week"], r.text[:300])
        check("dashboard y correo cuentan igual la semana",
              db_["this_week"]["produced"] == w.get("produced_hits"), (db_["this_week"]["produced"], w.get("produced_hits")))

        print("\n== Enviar ahora ==")
        rs.resend.api_key = ""
        r = await sup.post(f"/api/report-schedules/{sid}/run-now", json={})
        check("sin RESEND_API_KEY → 500 claro", r.status_code == 500 and "RESEND" in r.text, r.text[:200])
        r = await op.post(f"/api/report-schedules/{sid}/run-now", json={})
        check("operador no envía (403)", r.status_code == 403, r.status_code)

        print("\n== Tick: una vez por día; si falla libera y registra ==")
        sent = []

        async def fake_send(recipients, subject, html, attachments):
            sent.append((recipients, subject))
        real_send = rs._send_report_email
        rs._send_report_email = fake_send
        n = datetime.now(TZ) - timedelta(minutes=1)
        sdb.report_schedules.update_one({"schedule_id": sid}, {"$set": {
            "enabled": True, "hour": n.hour, "minute": n.minute, "weekdays": [0, 1, 2, 3, 4, 5, 6]}})
        await rs._tick()
        check("tick manda el ejecutivo", len(sent) == 1 and sent[0][0] == ["luke@test.local"], sent)
        doc = sdb.report_schedules.find_one({"schedule_id": sid})
        check("claim: last_sent_date = hoy", doc["last_sent_date"] == datetime.now(TZ).strftime("%Y-%m-%d"))
        await rs._tick()
        check("segundo tick no repite", len(sent) == 1, len(sent))
        check("bitácora: envío auto ok", sdb.report_sends.count_documents({"schedule_id": sid, "ok": True,
                                                                           "trigger": "auto"}) == 1)

        async def boom(*a, **kw):
            raise RuntimeError("resend caído")
        rs._send_report_email = boom
        sdb.report_schedules.update_one({"schedule_id": sid}, {"$set": {"last_sent_date": None}})
        await rs._tick()
        doc = sdb.report_schedules.find_one({"schedule_id": sid})
        check("falla → libera el claim para reintentar", doc["last_sent_date"] is None, doc["last_sent_date"])
        check("falla → queda en bitácora con error",
              sdb.report_sends.count_documents({"schedule_id": sid, "ok": False, "error": "resend caído"}) == 1)
        rs._send_report_email = real_send

        r = await sup.get("/api/report-schedules")
        mine = [x for x in r.json()["sends"] if x["schedule_id"] == sid]
        check("lista trae los envíos del reporte (2 del tick + 1 migrado)", len(mine) == 3, len(mine))


try:
    asyncio.run(main())
finally:
    raw.drop_database(SMOKE_DB)
    print(f"\n== Base {SMOKE_DB} eliminada ==")
    print(f"{ok} PASS · {fail} FAIL")
    sys.exit(1 if fail else 0)
