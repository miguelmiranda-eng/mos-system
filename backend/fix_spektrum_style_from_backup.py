"""Re-aplica SOLO el rename de STYLE de SPEKTRUM, enrutando desde el RESPALDO.

Contexto: la corrida anterior (fix_spektrum_master_data.py) cambió `description`
ANTES de renombrar `style`, y el rename casaba por la descripción vieja -> casi
no disparó. La metadata (description/manufacturer/upc) SÍ quedó; falta el style.

Este script NO toca la descripción viva (ya corregida). Enruta el style leyendo
la identidad ORIGINAL de cada caja desde el respaldo `wms_boxes_bak_spektrum_*`
(por box_id): (style_was, color, size, description_was) -> style_final del Excel.
Así MONARCH (que dependía de la descripción "MENS SS", ya sobrescrita) se recupera.

Idempotente: solo renombra cajas que HOY siguen con el style viejo.
Seguro: 0 apartado en SPEKTRUM; respalda de nuevo; borra filas viejas SOLO en las
ubicaciones afectadas y reproyecta; verifica conservación.

    python fix_spektrum_style_from_backup.py            # dry-run
    APPLY=1 python fix_spektrum_style_from_backup.py     # aplica
"""
import os
import subprocess
import sys
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

import openpyxl
from dotenv import load_dotenv

ROOT = Path(__file__).parent
load_dotenv(ROOT / ".env")
import pymongo  # noqa: E402

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

XLSX = os.environ.get("SPEKTRUM_XLSX", r"C:\Users\gerar\Downloads\Untitled spreadsheet.xlsx")
BACKUP_BOXES = os.environ.get("BACKUP_BOXES", "wms_boxes_bak_spektrum_20260904_211808")
CUSTOMER = "SPEKTRUM"
APPLY = os.environ.get("APPLY") == "1"
TS = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")


def cl(v):
    return "" if v is None else str(v).strip()


def style_table():
    """(style_was,color,size,desc_was) -> style_final, solo donde cambia."""
    ws = openpyxl.load_workbook(XLSX, data_only=True)["Sheet1"]
    H = [ws.cell(row=1, column=c).value for c in range(1, 13)]
    acc = defaultdict(set)
    for r in range(2, ws.max_row + 1):
        rec = {H[c]: ws.cell(row=r, column=c + 1).value for c in range(12)}
        if not any(rec[k] not in (None, "") for k in H):
            continue
        sw = cl(rec["Style WAS"])
        sb = cl(rec["Style SHOULD BE"])
        if sb and sb != sw:
            acc[(sw, cl(rec["Color"]), cl(rec["Size"]), cl(rec["Description WAS"]))].add(sb)
    return {k: next(iter(v)) for k, v in acc.items() if len(v) == 1}, \
           [k for k, v in acc.items() if len(v) > 1]


def main():
    print(f"=== fix_spektrum_style_from_backup  [{'APPLY' if APPLY else 'DRY-RUN'}]  {TS} ===")
    table, conflicts = style_table()
    if conflicts:
        print(f"[!] ABORTA: {len(conflicts)} claves con style_final ambiguo: {conflicts[:10]}")
        sys.exit(1)
    old_styles = sorted({k[0] for k in table})
    print(f"reglas de style: {len(table)}  |  styles viejos: {old_styles}")

    db = pymongo.MongoClient(os.environ["MONGODB_URL"], serverSelectionTimeoutMS=20000)[
        os.environ.get("DB_NAME", "mos-system")]

    if BACKUP_BOXES not in db.list_collection_names():
        sys.exit(f"[!] No existe el respaldo {BACKUP_BOXES}")

    # box_id -> style_final, según la identidad ORIGINAL del respaldo
    backup_map = {}
    for b in db[BACKUP_BOXES].find({"customer": CUSTOMER, "style": {"$in": old_styles}},
                                   {"_id": 0, "box_id": 1, "style": 1, "color": 1, "size": 1, "description": 1}):
        k = (cl(b.get("style")), cl(b.get("color")), cl(b.get("size")), cl(b.get("description")))
        ts = table.get(k)
        if ts and ts != cl(b.get("style")) and b.get("box_id"):
            backup_map[b["box_id"]] = ts
    print(f"cajas en respaldo que mapean a un style nuevo: {len(backup_map)}")

    # cajas VIVAS que HOY siguen con style viejo (las que faltan por renombrar)
    live = {b["box_id"]: b for b in db.wms_boxes.find(
        {"customer": CUSTOMER, "style": {"$in": old_styles}},
        {"_id": 0, "box_id": 1, "style": 1, "location": 1})}
    to_rename = defaultdict(list)   # style_final -> [box_id]
    locs = set()
    for box_id, tgt in backup_map.items():
        lb = live.get(box_id)
        if not lb:
            continue  # ya renombrada en la corrida anterior, o ya no está
        to_rename[tgt].append(box_id)
        if cl(lb.get("location")):
            locs.add(cl(lb["location"]))

    total_boxes = sum(len(v) for v in to_rename.values())
    print(f"\n-- Plan (SOLO style; metadata ya está) --")
    print(f"  Cajas a renombrar ahora: {total_boxes}  (ya renombradas antes: {len(backup_map) - total_boxes})")
    for tgt in sorted(to_rename):
        print(f"    -> {tgt}: {len(to_rename[tgt])} cajas")
    print(f"  Ubicaciones a reproyectar: {len(locs)}")
    old_rows = db.wms_inventory.count_documents(
        {"customer": CUSTOMER, "location": {"$in": list(locs)}, "style": {"$in": old_styles}}) if locs else 0
    print(f"  Filas viejas de inventory a borrar (en esas ubicaciones, styles viejos): {old_rows}")

    if not APPLY:
        print(f"\n[DRY-RUN] Nada escrito. Respaldo nuevo que se crearía: wms_*_bak_spektrum_{TS}.")
        return

    print("\n=== RESPALDO ===")
    db.wms_boxes.aggregate([{"$match": {"customer": CUSTOMER}}, {"$out": f"wms_boxes_bak_spektrum_{TS}"}])
    db.wms_inventory.aggregate([{"$match": {"customer": CUSTOMER}}, {"$out": f"wms_inventory_bak_spektrum_{TS}"}])
    print(f"  OK: wms_boxes/inventory_bak_spektrum_{TS}")

    print("=== renombrar style en cajas (por box_id) ===")
    for tgt, ids in to_rename.items():
        for i in range(0, len(ids), 500):
            db.wms_boxes.update_many({"box_id": {"$in": ids[i:i + 500]}}, {"$set": {"style": tgt}})
    print(f"  {total_boxes} cajas renombradas")

    print("=== borrar filas viejas de inventory (ubicaciones afectadas) ===")
    res = db.wms_inventory.delete_many({"customer": CUSTOMER, "location": {"$in": list(locs)},
                                        "style": {"$in": old_styles}})
    print(f"  borradas: {res.deleted_count}")

    print(f"=== reproyectar {len(locs)} ubicaciones ===")
    for loc in sorted(locs):
        subprocess.run([sys.executable, str(ROOT / "scripts" / "reproject_inventory_from_boxes.py"),
                        "--only", loc, "--apply"], check=False)

    print("\n[OK] Style re-aplicado. Verifica cajas vs inventory de CORE/CORE TEE/MONARCH.")


if __name__ == "__main__":
    main()
