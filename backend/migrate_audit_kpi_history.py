"""Fase 3 — Migración del histórico de KPIs de la hoja "Warehouse Audits" al WMS.

Carga los KPIs DIARIOS (pestaña "KPIs" del Google Sheet) a la colección
`wms_audit_kpi_history`, que el dashboard de Auditorías fusiona con lo que el
WMS calcula en vivo (regla: el dato vivo del WMS GANA sobre el histórico en
fechas que ambos cubren, ver services/auditorias.py:kpis_rollup).

Alcance (acordado): SOLO el histórico que vive ÚNICAMENTE en la hoja. Las
pestañas Case Pick / Putaway / Receiving NO se migran: esos eventos ya están en
`wms_movements` para esas fechas y migrarlos duplicaría.

Idempotente: upsert por `date`. Días con todo en cero se omiten (no aportan KPI).
Reversible: borrar los docs con source="google_sheet_warehouse_audits".

Uso:
  python migrate_audit_kpi_history.py           # DRY-RUN (solo imprime)
  python migrate_audit_kpi_history.py --apply    # escribe a prod
"""
import os
import re
import sys

import pymongo

SRC = "google_sheet_warehouse_audits"

# date -> (units_processed, units_without_issues, locations_processed, locations_without_issues)
# Transcrito de la pestaña KPIs (WK36–WK39, 2026). 05-Sep = 0/0/0/0 omitido.
DATA = {
    "2026-08-31": (37926, 37401, 121, 118),
    "2026-09-01": (28001, 27640, 40, 38),
    "2026-09-02": (42907, 42417, 288, 286),
    "2026-09-03": (32108, 30954, 194, 183),
    "2026-09-04": (92102, 92034, 518, 513),
    "2026-09-07": (4032, 4032, 6, 6),
    "2026-09-08": (10368, 10192, 12, 11),
    "2026-09-09": (39312, 39215, 45, 43),
    "2026-09-10": (17568, 17378, 20, 19),
    "2026-09-11": (9504, 9422, 11, 10),
    "2026-09-12": (84168, 84116, 98, 97),
    "2026-09-14": (9216, 9216, 11, 7),
    "2026-09-15": (5760, 5760, 7, 7),
    "2026-09-16": (12888, 12888, 15, 15),
    "2026-09-17": (27648, 27576, 32, 31),
}


def _load_env():
    path = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".env")
    for line in open(path, encoding="utf-8"):
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            k, v = line.split("=", 1)
            os.environ.setdefault(k.strip(), v.strip())


def main():
    apply = "--apply" in sys.argv
    _load_env()
    url = os.environ.get("MONGO_URL") or os.environ.get("MONGODB_URL")
    if not url:
        sys.exit("Falta MONGODB_URL")
    if "directConnection" not in url:
        url += ("&" if "?" in url else "?") + "directConnection=true"
    m = re.search(r"/([^/?]+)(\?|$)", url)
    db_name = os.environ.get("DB_NAME") or (m.group(1) if m else "mos-system")
    db = pymongo.MongoClient(url)[db_name]

    existing = db.wms_audit_kpi_history.count_documents({})
    print(f"DB: {db_name}  ·  wms_audit_kpi_history existentes: {existing}")
    print(f"Modo: {'APPLY (escribe)' if apply else 'DRY-RUN (no escribe)'}\n")
    print(f"{'Fecha':12} {'Procesadas':>11} {'Sin issues':>11} {'IRA':>7}   {'Ubic':>5} {'OK':>5} {'ILA':>7}")

    ops = []
    for d in sorted(DATA):
        up, wi, lc, lp = DATA[d]
        ira = round(wi / up * 100, 1) if up else None
        ila = round(lp / lc * 100, 1) if lc else None
        print(f"{d:12} {up:>11,} {wi:>11,} {('%.1f%%' % ira) if ira is not None else '—':>7}   "
              f"{lc:>5} {lp:>5} {('%.1f%%' % ila) if ila is not None else '—':>7}")
        ops.append(pymongo.UpdateOne(
            {"date": d},
            {"$set": {
                "date": d, "units_processed": up, "units_without_issues": wi,
                "locations_processed": lc, "locations_without_issues": lp,
                "source": SRC,
            }},
            upsert=True,
        ))

    t_up = sum(v[0] for v in DATA.values())
    t_wi = sum(v[1] for v in DATA.values())
    t_lc = sum(v[2] for v in DATA.values())
    t_lp = sum(v[3] for v in DATA.values())
    print(f"\nTOTAL {len(DATA)} días: procesadas {t_up:,} · sin issues {t_wi:,} "
          f"· IRA {t_wi/t_up*100:.1f}%  |  ubic {t_lc} · OK {t_lp} · ILA {t_lp/t_lc*100:.1f}%")

    if not apply:
        print("\nDRY-RUN: no se escribió nada. Corre con --apply para migrar.")
        return
    res = db.wms_audit_kpi_history.bulk_write(ops)
    print(f"\nAPLICADO: upserts={res.upserted_count} modificados={res.modified_count} "
          f"matched={res.matched_count}  ·  total ahora: {db.wms_audit_kpi_history.count_documents({})}")
    print("Reversible: db.wms_audit_kpi_history.delete_many({source:'%s'})" % SRC)


if __name__ == "__main__":
    main()
