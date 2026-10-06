"""Smoke — Módulo Auditorías (Fase 1).

Contrato:
  · kpis_rollup: IRA = 1−Σ|Δ|/Σsistema, ILA = perfectas/cerradas, por día.
  · El histórico migrado (wms_audit_kpi_history) solo rellena fechas que el WMS
    NO calculó; en conflicto, el dato vivo del WMS manda.
  · movement_feed lee pick/putaway de wms_movements (no recaptura).
  · Catálogo de motivos: dedup + validación.
  · Las acciones auditorias.view/manage y el módulo 'auditorias' están registrados.

Base DESECHABLE.
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
os.environ.setdefault("MASTER_API_KEY", "smoke_master_key")
os.environ.setdefault("INTERNAL_SYNC_TOKEN", "smoke_sync_token")
os.environ.setdefault("ENV", "local")
os.environ.setdefault("DISABLE_SCHEDULERS", "1")
sys.path.insert(0, BE)
os.chdir(BE)

import pymongo  # noqa: E402

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


def sembrar():
    raw.drop_database(SMOKE_DB)
    # Conteo por LÍNEAS del 10-sep: sistema 180, |Δ| = 0+5+2 = 7 -> IRA 96.1
    sdb.wms_cycle_counts.insert_one({
        "count_id": "cc_lines_1", "mode": "lines", "status": "approved",
        "created_at": "2026-09-10T09:00:00+00:00", "approved_at": "2026-09-10T10:00:00+00:00",
        "lines": [
            {"counted": True, "system_qty": 100, "discrepancy": 0},
            {"counted": True, "system_qty": 50, "discrepancy": -5},
            {"counted": True, "system_qty": 30, "discrepancy": 2},
        ],
    })
    # Conteo por ESCANEO del 11-sep: 3 cerradas, 2 perfectas -> ILA 66.7
    sdb.wms_cycle_counts.insert_one({
        "count_id": "cc_box_1", "mode": "box_scan", "status": "approved",
        "created_at": "2026-09-11T09:00:00+00:00", "approved_at": "2026-09-11T10:00:00+00:00",
        "lines": [],
        "scan_locations": [
            {"location": "A1", "status": "ok", "missing": [], "extra": [], "unknown_boxes": []},
            {"location": "A2", "status": "ok", "missing": [], "extra": [], "unknown_boxes": []},
            {"location": "A3", "status": "supervisor", "missing": ["BOX-9"], "extra": [], "unknown_boxes": []},
            {"location": "A4", "status": "pending", "missing": [], "extra": [], "unknown_boxes": []},
        ],
    })
    # Histórico migrado: 9-sep (sin conteo WMS) y un conflicto el 10-sep (debe
    # IGNORARSE porque ese día el WMS sí calculó).
    sdb.wms_audit_kpi_history.insert_many([
        {"date": "2026-09-09", "units_processed": 200, "units_without_issues": 198,
         "locations_processed": 10, "locations_without_issues": 10},
        {"date": "2026-09-10", "units_processed": 999, "units_without_issues": 0,
         "locations_processed": 99, "locations_without_issues": 0},
    ])
    # Movimientos para las vistas derivadas.
    sdb.wms_movements.insert_many([
        {"movement_id": "mv_p1", "type": "pick_deduction", "user_name": "Elvis",
         "created_at": "2026-09-10T11:00:00+00:00",
         "details": {"ticket_id": "pick_1", "order_number": "2701", "style": "6901",
                     "color": "NATURAL", "size": "S", "location": "CARRO 265", "qty": 70,
                     "box_ids": ["BOX-1"], "scanned": True}},
        {"movement_id": "mv_t1", "type": "transit_relocation", "user_name": "Cesar",
         "created_at": "2026-09-10T12:00:00+00:00",
         "details": {"trigger": "transit", "origins": ["NA07-C20"], "destination": "CESAR-1",
                     "box_ids": ["BOX-7"], "units_batch": 48, "boxes_moved": 1}},
    ])
    # Cajas para las sesiones de auditoría (Fase 2).
    sdb.wms_boxes.insert_many([
        {"box_id": "BOX-A", "units": 50, "location": "PS02-A03", "style": "5000",
         "color": "BLACK", "size": "L", "sku": "5000-BLACK-L", "customer": "GTS"},
        {"box_id": "BOX-B", "units": 30, "location": "PS02-A04", "style": "5000",
         "color": "WHITE", "size": "M", "sku": "5000-WHITE-M", "customer": "GTS"},
    ])


async def run():
    from services import auditorias
    import wms_actions as wa
    from routers import wms as wmsmod

    # ── KPIs ──
    k = await auditorias.kpis_rollup("2026-09-08", "2026-09-12", "day")
    by = {r["key"]: r for r in k["series"]}
    check("serie tiene 09-09 / 09-10 / 09-11",
          {"2026-09-09", "2026-09-10", "2026-09-11"} <= set(by), detalle=str(sorted(by)))
    check("10-sep IRA = 96.1 (línea, Σsistema 180, |Δ| 7)",
          by.get("2026-09-10", {}).get("ira_pct") == 96.1, detalle=str(by.get("2026-09-10")))
    check("10-sep sin issues = 173",
          by.get("2026-09-10", {}).get("units_without_issues") == 173)
    check("10-sep source = wms (no lo pisó el histórico 999/0)",
          by.get("2026-09-10", {}).get("source") == "wms" and by.get("2026-09-10", {}).get("units_processed") == 180,
          detalle=str(by.get("2026-09-10")))
    check("09-sep viene del histórico, IRA 99.0, ILA 100",
          by.get("2026-09-09", {}).get("source") == "historico"
          and by.get("2026-09-09", {}).get("ira_pct") == 99.0
          and by.get("2026-09-09", {}).get("ila_pct") == 100.0,
          detalle=str(by.get("2026-09-09")))
    check("11-sep ILA = 66.7 (2 de 3 cerradas perfectas)",
          by.get("2026-09-11", {}).get("ila_pct") == 66.7, detalle=str(by.get("2026-09-11")))
    check("meta = 99", k.get("goal") == 99.0)
    check("totals trae ira_pct", isinstance(k.get("totals", {}).get("ira_pct"), float))

    # ── Vistas derivadas ──
    pf = await auditorias.movement_feed("pick", "2026-09-01", "2026-09-30")
    check("feed pick trae 1 fila con la orden 2701",
          pf["total"] == 1 and any(r.get("order_number") == "2701" for r in pf["rows"]),
          detalle=str(pf))
    tf = await auditorias.movement_feed("putaway", "2026-09-01", "2026-09-30")
    check("feed putaway trae el transit_relocation", tf["total"] == 1, detalle=str(tf))
    bad = await auditorias.movement_feed("inexistente")
    check("feed con kind inválido -> vacío", bad["total"] == 0 and bad["rows"] == [])

    # ── Catálogo de motivos ──
    cfg0 = await auditorias.get_cfg()
    check("config por defecto trae motivos", len(cfg0["reason_codes"]) >= 3)
    saved = await auditorias.save_cfg({"reason_codes": ["Motivo A", "motivo a", "  Motivo B  "]}, {"user_id": "u", "name": "t"})
    check("save dedup case-insensitive + trim -> 2 motivos",
          saved["reason_codes"] == ["Motivo A", "Motivo B"], detalle=str(saved["reason_codes"]))
    check("validate_reason case-insensitive", auditorias.validate_reason("MOTIVO a", saved) is True)
    check("validate_reason rechaza lo no curado", auditorias.validate_reason("xyz", saved) is False)
    try:
        await auditorias.save_cfg({"reason_codes": []}, {"user_id": "u"})
        check("save sin motivos lanza ValueError", False)
    except ValueError:
        check("save sin motivos lanza ValueError", True)

    # ── Sesiones de auditoría por caja (Fase 2) ──
    from datetime import date as _date
    U = {"user_id": "u", "name": "Auditor"}
    s0 = await auditorias.create_session(U, "smoke")
    sid = s0["session_id"]
    check("sesión creada abierta", s0["status"] == "open")
    await auditorias.add_box(sid, "box-a")  # minúsculas -> se normaliza a BOX-A
    s1 = await auditorias.set_box_count(sid, "BOX-A", U, 48, content_ok=True, located_ok=True)
    check("BOX-A snapshot sistema=50",
          any(b["box_id"] == "BOX-A" and b["system_units"] == 50 for b in s1["boxes"]))
    await auditorias.add_box(sid, "BOX-B")
    s2 = await auditorias.set_box_count(sid, "BOX-B", U, 30, content_ok=False, located_ok=False)
    m = s2["metrics"]
    check("muestreadas = 2", m["boxes_sampled"] == 2)
    check("sistema 80 / físico 78 / |Δ| 2 / neta -2",
          m["system_pieces"] == 80 and m["physical_pieces"] == 78
          and m["abs_discrepancy_pieces"] == 2 and m["net_discrepancy"] == -2, detalle=str(m))
    check("IRA sesión = 97.5", m["ira_pct"] == 97.5, detalle=str(m["ira_pct"]))
    check("contenido incorrecto 1 (50%)", m["boxes_content_bad"] == 1 and m["content_bad_pct"] == 50.0)
    check("ILA sesión = 50.0 (1 de 2 en su sitio)", m["ila_pct"] == 50.0, detalle=str(m["ila_pct"]))
    check("correctas 0 / discrepancia 2", m["boxes_correct"] == 0 and m["boxes_discrepancy"] == 2)
    try:
        await auditorias.add_box(sid, "BOX-A")
        check("caja duplicada -> error", False)
    except auditorias.AuditError as e:
        check("caja duplicada -> 409", e.status == 409)
    try:
        await auditorias.add_box(sid, "BOX-ZZZ")
        check("caja inexistente -> error", False)
    except auditorias.AuditError as e:
        check("caja inexistente -> 404", e.status == 404)
    await auditorias.close_session(sid)
    sc = await auditorias.get_session(sid)
    check("sesión cerrada", sc["status"] == "closed")
    try:
        await auditorias.set_box_count(sid, "BOX-A", U, 10)
        check("contar en cerrada -> error", False)
    except auditorias.AuditError as e:
        check("contar en sesión cerrada -> 400", e.status == 400)
    today = _date.today().isoformat()
    kk = await auditorias.kpis_rollup(today, today, "day")
    tday = {r["key"]: r for r in kk["series"]}.get(today, {})
    check("KPI de hoy incluye la sesión (IRA 97.5 / ILA 50.0)",
          tday.get("ira_pct") == 97.5 and tday.get("ila_pct") == 50.0, detalle=str(tday))

    # ── Registro de acciones y módulo ──
    cat_ids = {a["id"] for a in wa.catalog()}
    check("acción auditorias.view registrada", "auditorias.view" in cat_ids)
    check("acción auditorias.manage registrada", "auditorias.manage" in cat_ids)
    check("módulo 'auditorias' en defaults de acceso",
          "auditorias" in wmsmod.WMS_MODULE_ACCESS_DEFAULTS
          and wmsmod.WMS_MODULE_ACCESS_LABELS.get("auditorias") == "Auditorías")


if __name__ == "__main__":
    sembrar()
    asyncio.run(run())
    print(f"\n   {ok} PASS / {fail} FAIL")
    raw.drop_database(SMOKE_DB)
    sys.exit(1 if fail else 0)
