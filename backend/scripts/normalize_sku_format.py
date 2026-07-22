"""Casa los dos formatos de `sku` de wms_inventory en UNO: el compuesto.

EL PROBLEMA QUE CIERRA
──────────────────────
Desde hace meses conviven dos formatos para el mismo material:

    corto     'CK001'          (4,483 filas hoy)
    compuesto 'CK001-PFD-M'    (el resto, y el 100% de las cajas)

Esa dualidad fue la causa raíz de los inventarios duplicados (CK001, PS06-A01…).
El ledger tolerante la CONTIENE — ya no corrompe — pero los cortos siguen
propagándose porque los movimientos heredan el formato del origen. Este script
los reescribe al compuesto de una vez; después de esto, la herencia propaga
compuesto y el formato corto se extingue.

CÓMO ELIGE EL COMPUESTO
───────────────────────
1. Si el material tiene CAJAS, hereda el sku MAYORITARIO de sus cajas — las
   cajas son la verdad física y su sku es el que está impreso/escaneado. Esto
   preserva convenciones legadas ('CK003-WASHED-CHA-XL', truncado) en vez de
   inventar una versión "bonita" que no coincidiría con ninguna etiqueta.
2. Sin cajas: compone STYLE-COLOR-SIZE (omitiendo partes vacías).
3. Sin color NI talla: se queda corto (no hay con qué componer). Se reporta.

QUÉ NO TOCA
───────────
- Cantidades: units_on_hand / total_boxes / units_allocated quedan intactos y
  se verifica al final que la suma global no cambió ni en una unidad.
- El índice único (va sobre style+color+size+location+coo+fabric, no sobre sku):
  cero riesgo de colisión.
- `style`, que es la llave de negocio real.

RIESGO OPERATIVO CONOCIDO
─────────────────────────
Los puntos aún no migrados (conteos cíclicos, ajustes) que busquen por el sku
corto dejarán de encontrar la fila. Ya no pueden corromper: el índice bloquea el
duplicado y cae como incidencia con el endpoint culpable. Pero un conteo cíclico
ABIERTO capturado con sku corto podría fallar al aplicarse — conviene correr esto
sin conteos en vuelo.

USO
───
    python backend/scripts/normalize_sku_format.py            # dry-run
    python backend/scripts/normalize_sku_format.py --apply
"""
import argparse
import os
import sys
import uuid
from collections import Counter, defaultdict
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
    ap.add_argument("--apply", action="store_true")
    ap.add_argument("--mongo", default=MONGODB_URL)
    args = ap.parse_args()
    if not args.mongo:
        sys.exit("Falta MONGODB_URL")
    db = pymongo.MongoClient(args.mongo)[DB_NAME]
    dry = not args.apply
    lote = uuid.uuid4().hex[:8]

    # Suma de control ANTES: la normalización no puede mover ni una unidad.
    ctl = list(db.wms_inventory.aggregate([{"$group": {"_id": None,
        "u": {"$sum": "$units_on_hand"}, "c": {"$sum": "$total_boxes"}, "n": {"$sum": 1}}}]))[0]

    # Mapa (style,color,size) -> sku mayoritario de las CAJAS, en una sola
    # agregación (consultar caja por caja serían ~9k roundtrips al servidor).
    print("Construyendo el mapa de skus físicos desde las cajas…")
    caja_sku = {}
    for g in db.wms_boxes.aggregate([
        {"$match": {"sku": {"$nin": [None, ""]}, "$expr": {"$ne": ["$sku", "$style"]}}},
        {"$group": {"_id": {"st": {"$ifNull": ["$style", ""]}, "c": {"$ifNull": ["$color", ""]},
                            "z": {"$ifNull": ["$size", ""]}, "sku": "$sku"},
                    "n": {"$sum": 1}}},
    ], allowDiskUse=True):
        k = (g["_id"]["st"], g["_id"]["c"], g["_id"]["z"])
        cand = caja_sku.setdefault(k, Counter())
        cand[g["_id"]["sku"]] += g["n"]

    objetivo = {"$or": [{"$expr": {"$eq": ["$sku", "$style"]}}, {"sku": {"$in": [None, ""]}}]}
    filas = list(db.wms_inventory.find(objetivo))
    heredadas = compuestas = sin_remedio = 0
    plan = []
    for r in filas:
        st = (r.get("style") or "").strip()
        c = (r.get("color") or "").strip()
        z = (r.get("size") or "").strip()
        if not st:
            sin_remedio += 1
            continue
        cand = caja_sku.get((st, c, z))
        if cand:
            nuevo = cand.most_common(1)[0][0]
            heredadas += 1
        elif c or z:
            nuevo = "-".join(p for p in (st, c, z) if p)
            compuestas += 1
        else:
            sin_remedio += 1     # ni cajas ni color/talla: no hay con qué componer
            continue
        if nuevo != (r.get("sku") or ""):
            plan.append((r["_id"], r.get("sku") or "", nuevo,
                         f"{st}/{c}/{z} @ {r.get('location')}"))

    print(f"\n{'SIMULACIÓN' if dry else f'APLICANDO · lote {lote}'}")
    print(f"  filas con sku corto/vacío : {len(filas):,}")
    print(f"     heredan el sku de sus cajas : {heredadas:,}")
    print(f"     se componen (sin cajas)     : {compuestas:,}")
    print(f"     sin remedio (sin color/talla): {sin_remedio:,}  <- quedan como están")
    print(f"  actualizaciones a ejecutar : {len(plan):,}\n")
    print("  muestra:")
    for _id, viejo, nuevo, ctx in plan[:10]:
        print(f"     {viejo or '(vacío)':16s} -> {nuevo:26s} {ctx}")

    if dry:
        print("\n  Nada fue modificado. Ejecuta con --apply.")
        return

    # Respaldo de TODAS las filas a tocar, luego la reescritura.
    ids = [p[0] for p in plan]
    db[f"wms_inventory_bak_skunorm_{lote}"].insert_many(
        list(db.wms_inventory.find({"_id": {"$in": ids}})))
    ops = [pymongo.UpdateOne({"_id": _id, "sku": viejo if viejo else {"$in": [None, ""]}},
                             {"$set": {"sku": nuevo, "sku_normalized_batch": lote,
                                       "updated_at": now_iso()}})
           for _id, viejo, nuevo, _ in plan]
    res = db.wms_inventory.bulk_write(ops, ordered=False)
    print(f"  filas reescritas: {res.modified_count:,}")

    # Verificación: ni una unidad se movió, y los cortos bajaron a lo esperado.
    ctl2 = list(db.wms_inventory.aggregate([{"$group": {"_id": None,
        "u": {"$sum": "$units_on_hand"}, "c": {"$sum": "$total_boxes"}, "n": {"$sum": 1}}}]))[0]
    cortos = db.wms_inventory.count_documents({"$expr": {"$eq": ["$sku", "$style"]}})
    print(f"  unidades  antes/después : {ctl['u']:,} / {ctl2['u']:,}  "
          f"{'OK' if ctl['u'] == ctl2['u'] else '!! CAMBIÓ'}")
    print(f"  cajas     antes/después : {ctl['c']:,} / {ctl2['c']:,}  "
          f"{'OK' if ctl['c'] == ctl2['c'] else '!! CAMBIÓ'}")
    print(f"  filas     antes/después : {ctl['n']:,} / {ctl2['n']:,}  "
          f"{'OK' if ctl['n'] == ctl2['n'] else '!! CAMBIÓ'}")
    print(f"  skus cortos restantes   : {cortos:,} (esperados ~{sin_remedio:,})")
    print(f"  respaldo: wms_inventory_bak_skunorm_{lote}")

    db.wms_incidents.insert_one({
        "incident_id": f"inc_{uuid.uuid4().hex[:12]}", "kind": "inventory_reprojected",
        "location": "(global)", "batch": lote,
        "mensaje": f"Normalización de sku: {res.modified_count:,} filas reescritas al formato "
                   f"compuesto ({heredadas:,} heredado de cajas, {compuestas:,} compuesto). "
                   f"Cantidades intactas.",
        "created_at": now_iso()})


if __name__ == "__main__":
    main()
