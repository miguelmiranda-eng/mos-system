"""Smoke: reportes del WMS (/api/wms/reports/*).
Fija lo que un reporte no puede equivocarse:
  - los rangos de fecha incluyen el último día completo (el error clásico de
    filtrar por texto ISO y perder todo lo del día final),
  - la antigüedad del putaway pendiente cae en el tramo correcto,
  - un ticket vencido sin completar y uno completado tarde son ambos "fuera de
    SLA", pero se distinguen,
  - la productividad suma putaway masivo por cajas, no por eventos,
  - un operador que sólo hizo una de las tres actividades igual aparece,
  - el piso NO ve reportes (son de supervisión); no se escribe nada.

SEGURIDAD: base DESECHABLE, se niega contra prod, se borra al terminar.
USO: set MONGODB_URL=... ; backend/venv/Scripts/python.exe backend/tests/smoke_wms_reports.py
"""
import asyncio
import os
import sys
from datetime import datetime, timedelta, timezone

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

AHORA = datetime.now(timezone.utc)
HOY = AHORA.strftime("%Y-%m-%d")


def hace(dias, horas=0):
    return (AHORA - timedelta(days=dias, hours=horas)).isoformat()


def dia(dias):
    return (AHORA - timedelta(days=dias)).strftime("%Y-%m-%d")


def check(n, cond, det=""):
    global ok, fail
    if cond:
        ok += 1; print(f"   PASS  {n}")
    else:
        fail += 1; print(f"   FAIL  {n}  {det}")


def sembrar():
    print(f"== Sembrando {SMOKE_DB} ==")
    for c in ["users", "user_sessions", "wms_receiving", "wms_boxes",
              "wms_pick_tickets", "wms_movements"]:
        sdb[c].delete_many({})
    sdb.users.insert_many([
        {"user_id": "u_pick", "email": "p@test.local", "name": "Picker",
         "password_hash": bcrypt.hash("pk123"), "role": "picker", "active": True},
        {"user_id": "u_su", "email": "su@test.local", "name": "Super",
         "password_hash": bcrypt.hash("su123"), "role": "supersu", "active": True},
        # El menú del WMS muestra los módulos adminOnly al rol ceo, pero
        # get_admin_level le asigna 0: si el backend no lo contempla, vería la
        # entrada y recibiría 403 al abrirla.
        {"user_id": "u_ceo", "email": "ceo@test.local", "name": "Direccion",
         "password_hash": bcrypt.hash("ceo123"), "role": "ceo", "active": True},
    ])

    # RECIBOS: 2 de ANA hoy, 1 de LUIS hace 5 días, 1 forzado, 1 sin UPC.
    sdb.wms_receiving.insert_many([
        {"receiving_id": "r1", "created_at": hace(0, 2), "customer": "GLO", "style": "5000",
         "color": "NAVY", "size": "L", "total_units": 100, "received_by_name": "ANA",
         "asn_reference": "ASN-1"},
        {"receiving_id": "r2", "created_at": hace(0, 3), "customer": "GLO", "style": "5000",
         "color": "RED", "size": "M", "total_units": 50, "received_by_name": "ANA",
         "asn_reference": "ASN-1"},
        {"receiving_id": "r3", "created_at": hace(5), "customer": "LIF", "style": "2000",
         "color": "WHITE", "size": "S", "total_units": 200, "received_by_name": "LUIS",
         "asn_reference": "ASN-2"},
        {"receiving_id": "r4", "created_at": hace(2), "customer": "LIF", "style": "2000",
         "total_units": 10, "received_by_name": "LUIS", "duplicate_forced": True},
        {"receiving_id": "r5", "created_at": hace(1), "customer": "GLO", "style": "5000",
         "total_units": 20, "received_by_name": "ANA", "upc_required_bypass": True},
    ])

    # PUTAWAY PENDIENTE: uno de hoy, uno de 2 días, uno de 10 días.
    sdb.wms_boxes.insert_many([
        {"box_id": "B1", "status": "putaway_pending", "units": 10, "created_at": hace(0, 1),
         "style": "5000", "customer": "GLO"},
        {"box_id": "B2", "status": "putaway_pending", "units": 20, "created_at": hace(2),
         "style": "5000", "customer": "GLO"},
        {"box_id": "B3", "status": "putaway_pending", "units": 30, "created_at": hace(10),
         "style": "2000", "customer": "LIF"},
        {"box_id": "B4", "status": "stored", "units": 40, "created_at": hace(3)},   # no cuenta
        {"box_id": "B5", "status": "putaway_pending", "units": 0, "created_at": hace(9)},  # vacía
    ])

    # MOVIMIENTOS de putaway: ANA guardó 1 caja; LUIS un bulk de 7.
    sdb.wms_movements.insert_many([
        {"type": "putaway", "user_name": "ANA", "created_at": hace(0, 1), "details": {}},
        {"type": "putaway_bulk", "user_name": "LUIS", "created_at": hace(1), "details": {"count": 7}},
        {"type": "pick", "user_name": "ANA", "created_at": hace(0, 1), "details": {}},  # otro tipo
    ])

    # TICKETS: completado a tiempo, completado TARDE, abierto VENCIDO, sin asignar.
    sdb.wms_pick_tickets.insert_many([
        {"ticket_id": "T1", "order_number": "OC-100", "customer": "GLO", "style": "5000",
         "total_pick_qty": 60, "status": "completed", "assigned_to_name": "ANA",
         "created_at": hace(1), "completed_at": hace(0, 20), "sla_deadline": hace(0, 1)},
        {"ticket_id": "T2", "order_number": "OC-200", "customer": "LIF", "style": "2000",
         "total_pick_qty": 30, "status": "completed", "assigned_to_name": "LUIS",
         "created_at": hace(3), "completed_at": hace(1), "sla_deadline": hace(2)},
        {"ticket_id": "T3", "order_number": "OC-300", "customer": "GLO", "style": "5000",
         "total_pick_qty": 15, "status": "pending", "assigned_to_name": "ANA",
         "created_at": hace(4), "sla_deadline": hace(3)},
        {"ticket_id": "T4", "order_number": "OC-400", "customer": "LIF", "style": "2000",
         "total_pick_qty": 25, "status": "pending", "assigned_to_name": "",
         "created_at": hace(0, 2),
         "sla_deadline": (AHORA + timedelta(hours=20)).isoformat()},
    ])


async def main():
    sembrar()
    from httpx import ASGITransport, AsyncClient
    from server import app
    tr = ASGITransport(app=app)
    R = "/api/wms/reports"

    async with AsyncClient(transport=tr, base_url="http://smoke") as pk, \
               AsyncClient(transport=tr, base_url="http://smoke") as su:
        r = await pk.post("/api/auth/login", json={"email": "p@test.local", "password": "pk123"})
        check("login picker", r.status_code == 200, f"{r.status_code}")
        r = await su.post("/api/auth/login", json={"email": "su@test.local", "password": "su123"})
        check("login supersu", r.status_code == 200, f"{r.status_code}")

        print("\n== los reportes son de supervisión ==")
        for ruta in ("pendientes", "productividad", "historial", "excepciones"):
            r = await pk.get(f"{R}/{ruta}")
            check(f"picker NO ve {ruta}", r.status_code == 403, f"{r.status_code}")
        async with AsyncClient(transport=tr, base_url="http://smoke") as ceo:
            r = await ceo.post("/api/auth/login", json={"email": "ceo@test.local", "password": "ceo123"})
            check("login ceo", r.status_code == 200, f"{r.status_code}")
            r = await ceo.get(f"{R}/pendientes")
            check("el rol ceo SÍ ve reportes (el menú se los ofrece)",
                  r.status_code == 200, f"{r.status_code} {r.text[:120]}")

        print("\n== pendientes ==")
        r = await su.get(f"{R}/pendientes")
        d = r.json() if r.status_code == 200 else {}
        check("responde 200", r.status_code == 200, f"{r.status_code} {r.text[:200]}")
        pa = d.get("putaway", {})
        check("3 cajas por guardar / 60 unidades (ignora las guardadas y las de 0)",
              pa.get("cajas") == 3 and pa.get("unidades") == 60, f"{pa.get('cajas')}/{pa.get('unidades')}")
        tramos = {t["tramo"]: t["cajas"] for t in pa.get("por_antiguedad", [])}
        check("la caja de hoy cae en 'hoy'", tramos.get("hoy") == 1, f"{tramos}")
        check("la de 2 días cae en '1 a 2 días'", tramos.get("1 a 2 días") == 1, f"{tramos}")
        check("la de 10 días cae en 'más de 7 días'", tramos.get("más de 7 días") == 1, f"{tramos}")
        check("los tramos suman el total", sum(tramos.values()) == pa.get("cajas"), f"{tramos}")
        check("la más vieja se lista primero",
              (pa.get("mas_viejas") or [{}])[0].get("box_id") == "B3",
              f"{[b.get('box_id') for b in pa.get('mas_viejas', [])]}")
        pk_ = d.get("picking", {})
        check("2 tickets abiertos", pk_.get("abiertos") == 2, f"{pk_}")
        check("1 vencido (T3)", pk_.get("vencidos") == 1, f"{pk_}")
        check("1 sin asignar (T4)", pk_.get("sin_asignar") == 1, f"{pk_}")
        check("recibos de hoy: 2 / 150 unidades",
              d.get("recibos_hoy", {}).get("recibos") == 2
              and d.get("recibos_hoy", {}).get("unidades") == 150, f"{d.get('recibos_hoy')}")

        print("\n== productividad ==")
        r = await su.get(f"{R}/productividad", params={"desde": dia(30), "hasta": HOY})
        d = r.json() if r.status_code == 200 else {}
        ops = {o["operador"]: o for o in d.get("operadores", [])}
        check("responde 200", r.status_code == 200, f"{r.status_code} {r.text[:200]}")
        check("ANA: 3 recibos / 170 unidades",
              ops.get("ANA", {}).get("recibos") == 3
              and ops["ANA"]["unidades_recibidas"] == 170, f"{ops.get('ANA')}")
        check("el putaway masivo cuenta 7 cajas en 1 evento",
              ops.get("LUIS", {}).get("putaway_cajas") == 7
              and ops["LUIS"]["putaway_eventos"] == 1, f"{ops.get('LUIS')}")
        check("sólo cuenta movimientos de putaway (ignora el pick)",
              ops.get("ANA", {}).get("putaway_eventos") == 1, f"{ops.get('ANA')}")
        check("ANA surtió 1 ticket / 60 unidades",
              ops.get("ANA", {}).get("tickets") == 1
              and ops["ANA"]["unidades_surtidas"] == 60, f"{ops.get('ANA')}")
        check("hay serie por día", len(d.get("por_dia", [])) >= 2, f"{d.get('por_dia')}")

        # El error clásico: filtrar hasta HOY y perder lo de hoy.
        r = await su.get(f"{R}/productividad", params={"desde": HOY, "hasta": HOY})
        ops = {o["operador"]: o for o in (r.json().get("operadores") or [])}
        check("un rango de un solo día SÍ incluye ese día",
              ops.get("ANA", {}).get("recibos") == 2, f"{ops.get('ANA')}")

        print("\n== historial ==")
        r = await su.get(f"{R}/historial", params={"desde": dia(30), "hasta": HOY, "customer": "GLO"})
        d = r.json() if r.status_code == 200 else {}
        check("filtra recibos por cliente",
              all(x["customer"] == "GLO" for x in d.get("recibos", [])) and d["totales"]["recibos"] == 3,
              f"{d.get('totales')}")
        check("filtra tickets por cliente",
              all(x["customer"] == "GLO" for x in d.get("tickets", [])), f"{len(d.get('tickets', []))}")
        check("las unidades surtidas sólo cuentan lo completado",
              d["totales"]["unidades_surtidas"] == 60, f"{d.get('totales')}")
        r = await su.get(f"{R}/historial", params={"orden": "OC-200"})
        check("filtra por número de orden",
              [t["ticket_id"] for t in r.json().get("tickets", [])] == ["T2"],
              f"{[t.get('ticket_id') for t in r.json().get('tickets', [])]}")

        print("\n== excepciones ==")
        r = await su.get(f"{R}/excepciones", params={"desde": dia(30), "hasta": HOY})
        d = r.json() if r.status_code == 200 else {}
        ids = {x["receiving_id"] for x in d.get("recibos_forzados", [])}
        check("detecta el recibo duplicado forzado y el que va sin UPC",
              ids == {"r4", "r5"}, f"{ids}")
        check("etiqueta el tipo de excepción",
              all(x.get("excepcion") for x in d.get("recibos_forzados", [])),
              f"{[x.get('excepcion') for x in d.get('recibos_forzados', [])]}")
        sla = {t["ticket_id"]: t["situacion"] for t in d.get("tickets_fuera_sla", [])}
        check("T2 se completó tarde", sla.get("T2") == "completado tarde", f"{sla}")
        check("T3 está vencido sin completar", sla.get("T3") == "vencido sin completar", f"{sla}")
        check("T1 (a tiempo) y T4 (con plazo vigente) NO aparecen",
              "T1" not in sla and "T4" not in sla, f"{sla}")
        per = {p["persona"]: p for p in d.get("por_persona", [])}
        check("agrupa por persona", per.get("LUIS", {}).get("recibos_forzados") == 1, f"{per}")

        print("\n== los reportes no escriben ==")
        check("recibos intactos", sdb.wms_receiving.count_documents({}) == 5)
        check("cajas intactas", sdb.wms_boxes.count_documents({}) == 5)
        check("tickets intactos", sdb.wms_pick_tickets.count_documents({}) == 4)


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
