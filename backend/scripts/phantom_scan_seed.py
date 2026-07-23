"""Escaneo de stock fantasma desde consola: siembra/refresca wms_recon_phantom.

Es el MISMO escaneo que el botón "Escanear ahora" del módulo de Conciliación
(POST /recon/phantom/scan) — comparte la lógica pura de
services/phantom_scan.py — para poder correrlo sin esperar un deploy o desde
un cron. Mismas garantías:

  · upsert por phantom_id determinista: un fantasma que persiste CONSERVA su
    campo `registro` a través de escaneos;
  · lo pendiente que ya no aparece se cierra solo como 'resuelta';
  · deja constancia en wms_recon_adjustments y una incidencia informativa.

USO
───
    python backend/scripts/phantom_scan_seed.py           # dry-run: solo reporta
    python backend/scripts/phantom_scan_seed.py --apply
"""

import argparse
import os
import sys
import uuid
from collections import defaultdict
from datetime import datetime, timezone

import pymongo

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from services.phantom_scan import compute_phantom_items  # noqa: E402

MONGODB_URL = os.environ.get("MONGODB_URL")
DB_NAME = os.environ.get("DB_NAME", "mos-system")

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")


def now_iso():
    return datetime.now(timezone.utc).isoformat()


def gen_id(p):
    return f"{p}_{uuid.uuid4().hex[:12]}"


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--apply", action="store_true", help="escribe los cambios")
    ap.add_argument("--mongo", default=MONGODB_URL)
    args = ap.parse_args()
    if not args.mongo:
        sys.exit("Falta MONGODB_URL")

    db = pymongo.MongoClient(args.mongo)[DB_NAME]
    dry = not args.apply
    batch = gen_id("phs")

    boxes = list(db.wms_boxes.find({}, {
        "_id": 0, "box_id": 1, "location": 1, "style": 1, "color": 1, "size": 1,
        "units": 1, "qty": 1, "country_of_origin": 1, "coo": 1, "fabric_content": 1}))
    rows = list(db.wms_inventory.find({}, {
        "_id": 0, "location": 1, "style": 1, "color": 1, "size": 1,
        "units_on_hand": 1, "country_of_origin": 1, "coo": 1, "fabric_content": 1}))
    items = compute_phantom_items(boxes, rows)

    por_tipo = defaultdict(lambda: {"n": 0, "unidades": 0})
    for it in items:
        por_tipo[it["tipo"]]["n"] += 1
        por_tipo[it["tipo"]]["unidades"] += it["delta"]

    print(f"{'DRY-RUN' if dry else f'APLICANDO · lote {batch}'} · "
          f"{len(boxes)} cajas vs {len(rows)} renglones -> {len(items)} fantasmas "
          f"en {len({it['location'] for it in items})} ubicaciones")
    for k, v in sorted(por_tipo.items()):
        print(f"   {k:<18} {v['n']:>5} items · {v['unidades']:>8,}u en duda")
    print("\nTop 15 por unidades en duda:")
    for it in items[:15]:
        mat = ("(sin identificar)" if it["tipo"] == "sin_identidad"
               else f"{it['style']}/{it['color']}/{it['size']}")
        print(f"   {it['location']:<14} {it['tipo']:<16} {mat:<34} "
              f"renglon={it['units_renglon']:>6} cajas={it['units_cajas']:>6} duda={it['delta']:>6}")

    if dry:
        print("\nNada fue modificado. Añade --apply.")
        return

    ahora = now_iso()
    vigentes = set()
    nuevos = reabiertos = 0
    for it in items:
        vigentes.add(it["phantom_id"])
        prev = db.wms_recon_phantom.find_one_and_update(
            {"phantom_id": it["phantom_id"]},
            {"$set": {**it, "status": "pendiente", "scan_batch": batch,
                      "scanned_at": ahora, "updated_at": ahora},
             "$setOnInsert": {"registro": "", "created_at": ahora}},
            upsert=True)
        if prev is None:
            nuevos += 1
        elif prev.get("status") != "pendiente":
            reabiertos += 1
    cerrados = db.wms_recon_phantom.update_many(
        {"status": "pendiente", "phantom_id": {"$nin": list(vigentes)}},
        {"$set": {"status": "resuelta", "resolved_at": ahora,
                  "resolved_by": f"escaneo {batch}", "updated_at": ahora}})

    db.wms_recon_adjustments.insert_one({
        "type": "phantom_scan",
        "created_at": ahora, "created_by": "Sistema (phantom_scan_seed.py)",
        "count": len(items),
        "units": sum(it["delta"] for it in items),
        "reason": (f"Escaneo de stock fantasma {batch}: {len(items)} pendientes "
                   f"({nuevos} nuevos, {reabiertos} reabiertos, {cerrados.modified_count} resueltos solos). "
                   + " · ".join(f"{k}: {v['n']} ({v['unidades']:,}u)" for k, v in sorted(por_tipo.items()))),
        "locations": [], "boxes": [],
    })
    db.wms_incidents.insert_one({
        "incident_id": gen_id("inc"),
        "kind": "phantom_scan",
        "mensaje": (f"Escaneo de stock fantasma: {len(items)} pendientes en "
                    f"{len({it['location'] for it in items})} ubicaciones "
                    f"({sum(it['delta'] for it in items):,} unidades en duda)."),
        "user_id": None, "user_name": "Sistema (phantom_scan_seed.py)",
        "created_at": ahora, "batch": batch, "por_tipo": dict(por_tipo),
    })
    print(f"\nListo: {nuevos} nuevos, {reabiertos} reabiertos, "
          f"{cerrados.modified_count} resueltos solos · lote {batch}")


if __name__ == "__main__":
    main()
