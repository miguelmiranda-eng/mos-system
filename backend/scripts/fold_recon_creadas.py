"""Pliega las cajas "creadas en conciliación" hacia la cola de Stock Fantasma.

QUÉ SON
───────
Cajas que un contador escaneó FÍSICAMENTE durante una conciliación PDA y que el
sistema no conocía: se crearon con style "(SIN IDENTIFICAR)" y 72 unidades por
default (RECON_DEFAULT_UNITS), marcadas `recon_created: True`, y quedaron
esperando en la pestaña "Por resolver" del módulo de Conciliación.

QUÉ HACE ESTE SCRIPT
────────────────────
NO las borra (son de lo más verificado del almacén: alguien las tuvo en la
mano) y NO las acepta a ciegas (su contenido y sus 72u son un default, no un
dato). Las saca del limbo:

  1. Respaldo completo de las cajas en wms_boxes_bak_reconfold_<lote>.
  2. Quita `recon_created` (salen de "Por resolver") y estampa
     `recon_folded_at/by/batch` para no perder el rastro.
  3. Deja constancia en wms_recon_adjustments (tipo recon_creadas_folded),
     visible en la pestaña "Ajustes de cajas".

Como conservan el style "(SIN IDENTIFICAR)", el escaneo de stock fantasma las
levanta automáticamente como tipo `sin_identidad`: tareas de piso ("abre la
caja y dime qué es") con su campo de registro. Ahí es donde se van a trabajar.

USO
───
    python backend/scripts/fold_recon_creadas.py           # dry-run
    python backend/scripts/fold_recon_creadas.py --apply
"""

import argparse
import os
import sys
import uuid
from collections import defaultdict
from datetime import datetime, timezone

import pymongo

MONGODB_URL = os.environ.get("MONGODB_URL")
DB_NAME = os.environ.get("DB_NAME", "mos-system")

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")


def now_iso():
    return datetime.now(timezone.utc).isoformat()


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
    lote = uuid.uuid4().hex[:8]

    cajas = list(db.wms_boxes.find({"recon_created": True}))
    if not cajas:
        print("No hay cajas recon_created pendientes. Nada que hacer.")
        return

    por_loc = defaultdict(lambda: {"cajas": 0, "unidades": 0})
    for b in cajas:
        g = por_loc[b.get("location") or "(sin ubicación)"]
        g["cajas"] += 1
        g["unidades"] += int(b.get("units") or 0)

    print(f"{'DRY-RUN' if dry else f'APLICANDO · lote {lote}'} · "
          f"{len(cajas)} cajas creadas en conciliación, "
          f"{sum(g['unidades'] for g in por_loc.values())}u en {len(por_loc)} ubicaciones\n")
    for loc, g in sorted(por_loc.items(), key=lambda x: -x[1]["cajas"]):
        print(f"   {loc:<14} {g['cajas']:>3}c / {g['unidades']:>5}u")

    if dry:
        print("\nNada fue modificado. Añade --apply.")
        return

    db[f"wms_boxes_bak_reconfold_{lote}"].insert_many(
        [dict(b) for b in cajas])

    ahora = now_iso()
    r = db.wms_boxes.update_many(
        {"recon_created": True},
        {"$set": {"recon_created": False, "recon_folded_at": ahora,
                  "recon_folded_by": "fold_recon_creadas.py",
                  "recon_folded_batch": lote, "updated_at": ahora}})

    db.wms_recon_adjustments.insert_one({
        "type": "recon_creadas_folded",
        "created_at": ahora, "created_by": "Sistema (fold_recon_creadas.py)",
        "count": len(cajas),
        "units": sum(g["unidades"] for g in por_loc.values()),
        "reason": (f"Lote {lote}: {len(cajas)} cajas creadas en conciliación salen de 'Por resolver' "
                   "hacia Stock Fantasma (sin_identidad) para identificarse en piso. "
                   "No se borró ni se aceptó ninguna; respaldo en "
                   f"wms_boxes_bak_reconfold_{lote}."),
        "locations": [{"location": loc, "cajas": g["cajas"], "unidades": g["unidades"]}
                      for loc, g in sorted(por_loc.items(), key=lambda x: -x[1]["cajas"])],
        "boxes": [{"box_id": b.get("box_id"), "location": b.get("location"),
                   "style": b.get("style"), "color": b.get("color"),
                   "size": b.get("size"), "units": b.get("units")} for b in cajas],
    })
    print(f"\nListo: {r.modified_count} cajas plegadas · respaldo wms_boxes_bak_reconfold_{lote}")


if __name__ == "__main__":
    main()
