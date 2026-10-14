"""Separa `requested_by` de `inspector` en los registros automáticos de QC.

Hasta ahora, al pasar una orden a NECESITA QC se creaba un registro de calidad
con `inspector` = quien movió la orden y `result` = PASS con 0 piezas. Eso metía
a gente de producción en la columna Inspector e inflaba la tasa de aprobación.

Para cada registro `auto_generated`:
  - Nunca editado por QC (sin entradas en qc_history):
        requested_by ← inspector, inspector ← "", result ← PENDING.
        Si la orden ya tiene un registro manual posterior, se anota
        `superseded_by` con ese qc_id (la inspección real quedó aparte).
  - Editado por QC: requested_by ← inspector original; inspector ← primera
        persona que lo editó (quien capturó la inspección). Resultado intacto.

Uso:
    python migrate_qc_requested_by.py            # simulación (no escribe)
    python migrate_qc_requested_by.py --apply    # aplica (respalda antes con $out)
"""
import os
import re
import sys
from collections import Counter
from datetime import datetime, timezone

import pymongo

sys.stdout.reconfigure(encoding="utf-8")


def _load_env():
    path = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".env")
    if not os.path.exists(path):
        return
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
    db = pymongo.MongoClient(url, serverSelectionTimeoutMS=20000)[db_name]

    autos = list(db.qc_records.find(
        {"auto_generated": True, "requested_by": {"$exists": False}},
        {"_id": 0, "qc_id": 1, "order_id": 1, "order_number": 1, "created_at": 1,
         "inspector": 1, "inspector_id": 1, "result": 1},
    ))
    first_editor = {}
    for h in db.qc_history.find(
        {"qc_id": {"$in": [a["qc_id"] for a in autos]}},
        {"_id": 0, "qc_id": 1, "changed_by": 1, "changed_by_id": 1, "changed_at": 1},
    ).sort("changed_at", 1):
        first_editor.setdefault(h["qc_id"], h)
    manual = {}
    for r in db.qc_records.find(
        {"auto_generated": {"$ne": True}}, {"_id": 0, "qc_id": 1, "order_id": 1, "created_at": 1}
    ).sort("created_at", 1):
        if r.get("order_id"):
            manual.setdefault(r["order_id"], []).append(r)

    ops, pending_by, edited, superseded = [], Counter(), 0, 0
    for a in autos:
        base = {"requested_by": a.get("inspector", ""), "requested_by_id": a.get("inspector_id", "")}
        ed = first_editor.get(a["qc_id"])
        if ed:
            edited += 1
            s = {**base, "inspector": ed.get("changed_by", ""), "inspector_id": ed.get("changed_by_id", "")}
        else:
            pending_by[a.get("inspector") or "(vacío)"] += 1
            s = {**base, "inspector": "", "inspector_id": "", "result": "PENDING"}
            later = next((r for r in manual.get(a.get("order_id"), []) if r["created_at"] >= a["created_at"]), None)
            if later:
                superseded += 1
                s["superseded_by"] = later["qc_id"]
        ops.append(pymongo.UpdateOne({"qc_id": a["qc_id"]}, {"$set": s}))

    total = db.qc_records.count_documents({})
    print(f"DB: {db_name}  ·  qc_records: {total}  ·  automáticos por migrar: {len(autos)}")
    print(f"  → PENDING (nunca capturados): {sum(pending_by.values())}"
          f"  (de ésos, con inspección manual posterior: {superseded})")
    print(f"  → editados por QC (inspector = quien capturó): {edited}")
    print("  Solicitantes que salen de la columna Inspector:")
    for name, n in pending_by.most_common():
        print(f"     {n:5d}  {name}")
    passed_now = db.qc_records.count_documents({"result": "PASS"})
    real_total = total - sum(pending_by.values())
    real_pass = passed_now - sum(pending_by.values())
    print(f"  Tasa de aprobación: hoy {passed_now / total * 100:.1f}% ({passed_now}/{total})"
          f"  →  después {real_pass / real_total * 100:.1f}% ({real_pass}/{real_total})"
          if total and real_total else "")

    if not apply:
        print("\nSIMULACIÓN: no se escribió nada. Corre con --apply para aplicar.")
        return
    stamp = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")
    backup = f"qc_records_backup_{stamp}"
    db.qc_records.aggregate([{"$match": {}}, {"$out": backup}])
    print(f"\nRespaldo: {backup} ({db[backup].count_documents({})} docs)")
    done = 0
    for i in range(0, len(ops), 200):
        done += db.qc_records.bulk_write(ops[i:i + 200], ordered=False).modified_count
    print(f"APLICADO: {done} registros actualizados.")


if __name__ == "__main__":
    main()
