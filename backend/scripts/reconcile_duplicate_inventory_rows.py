"""Reconcilia las filas de inventario duplicadas de wms_inventory.

CONTEXTO
────────
`wms_inventory` no tiene identidad canónica: el mismo material en la misma
ubicación puede tener varias filas, keyed con formatos distintos de `sku`
(compuesto 'CK001-PFD-M' vs corto 'CK001'). Los endpoints de movimiento las
generaban al no encontrar la fila origen y crear una nueva en el destino
(corregido en services/inventory_ledger.py). Este script limpia las que ya
quedaron en la base.

La verdad física son las CAJAS (`wms_boxes`), no las filas. Todo se decide
contra ellas.

TRES CASOS, TRES NIVELES DE RIESGO
──────────────────────────────────
  A · ESTRUCTURAL  — la suma de las filas YA coincide con el físico. El stock
                     es correcto, sólo está partido en varias filas. Fusionar
                     no cambia ninguna cantidad. Riesgo BAJO.

  B · AJUSTE       — la suma NO coincide con el físico. Se fusiona y la
                     cantidad se ajusta a lo que hay en piso. Riesgo MEDIO:
                     cambia el inventario, aunque en la dirección correcta.

  C · SIN RESPALDO — hay filas pero NO hay una sola caja física. Borrarlas
                     sería dar de baja stock que quizá sí existe y perdió su
                     vínculo. NUNCA se toca automáticamente: se reporta para
                     conteo cíclico. Riesgo ALTO.

Por defecto procesa A y B. El caso C sólo se reporta.

USO
───
    python backend/scripts/reconcile_duplicate_inventory_rows.py              # dry-run
    python backend/scripts/reconcile_duplicate_inventory_rows.py --apply      # ejecuta A+B
    python backend/scripts/reconcile_duplicate_inventory_rows.py --apply --tiers A

Con --apply respalda las filas afectadas en `wms_inventory_bak_dedupe_<id>`
antes de tocarlas, y audita cada fusión en `wms_movements` + `wms_incidents`.
"""
import argparse
import os
import sys
import uuid
from datetime import datetime, timezone

import pymongo

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from services.inventory_ledger import material_keys  # noqa: E402

MONGODB_URL = os.environ.get("MONGODB_URL")
DB_NAME = os.environ.get("DB_NAME", "mos-system")


# La consola de Windows usa cp1252 por defecto y revienta con acentos/flechas.
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")


def now_iso():
    return datetime.now(timezone.utc).isoformat()


def gen_id(prefix):
    return f"{prefix}_{uuid.uuid4().hex[:12]}"


def cargar_grupos(db):
    """Todos los grupos (style,color,size,location) con más de una fila."""
    grupos = db.wms_inventory.aggregate([
        {"$group": {"_id": {"style": "$style", "color": "$color",
                            "size": "$size", "location": "$location"},
                    "n": {"$sum": 1}}},
        {"$match": {"n": {"$gt": 1}}},
    ])
    return [g["_id"] for g in grupos]


def analizar(db, k):
    """Clasifica un grupo y elige la fila sobreviviente."""
    rows = list(db.wms_inventory.find({
        "style": k["style"], "color": k["color"],
        "size": k["size"], "location": k["location"],
    }))
    keys = material_keys(k["style"], "")
    boxes = list(db.wms_boxes.find({
        "$or": [{"sku": {"$in": keys}}, {"style": {"$in": keys}}],
        "color": k["color"] or "", "size": k["size"] or "",
        "location": k["location"],
    }, {"_id": 0, "box_id": 1, "units": 1, "qty": 1, "inventory_id": 1}))

    fisico_u = sum(int(b.get("units") or b.get("qty") or 0) for b in boxes)
    fisico_c = len(boxes)
    sistema_u = sum(int(r.get("units_on_hand") or 0) for r in rows)
    allocated = sum(int(r.get("units_allocated") or 0) for r in rows)

    if fisico_c == 0:
        tier = "C"
    elif sistema_u == fisico_u:
        tier = "A"
    else:
        tier = "B"

    # Sobreviviente: la fila que las cajas ya referencian (menos re-stamping y
    # menos riesgo de romper vínculos), luego la de sku compuesto (formato
    # mayoritario, 82% de la colección), luego la más antigua.
    ids_cajas = {b.get("inventory_id") for b in boxes if b.get("inventory_id")}
    referenciadas = [r for r in rows if r.get("inventory_id") in ids_cajas]

    def prioridad(r):
        return (
            0 if r.get("inventory_id") in ids_cajas else 1,
            0 if (r.get("sku") or "") != (r.get("style") or "") else 1,
            r.get("updated_at") or "",
        )

    survivor = sorted(rows, key=prioridad)[0] if rows else None
    return {
        "key": k, "rows": rows, "boxes": boxes, "tier": tier,
        "fisico_u": fisico_u, "fisico_c": fisico_c,
        "sistema_u": sistema_u, "allocated": allocated,
        "survivor": survivor,
        "referenciadas": len(referenciadas),
    }


def etiqueta(k):
    return f"{k['style']}/{k['color']}/{k['size']} @ {k['location']}"


def aplicar(db, a, lote, dry):
    """Fusiona el grupo en la fila sobreviviente y ajusta al físico."""
    k, survivor, rows = a["key"], a["survivor"], a["rows"]
    perdedoras = [r for r in rows if r["_id"] != survivor["_id"]]

    if not dry:
        # Respaldo ANTES de tocar nada.
        db[f"wms_inventory_bak_dedupe_{lote}"].insert_many(
            [dict(r, _bak_group=etiqueta(k)) for r in rows]
        )

        db.wms_inventory.update_one({"_id": survivor["_id"]}, {"$set": {
            "units_on_hand": a["fisico_u"],
            "total_boxes": a["fisico_c"],
            "units_allocated": a["allocated"],
            "updated_at": now_iso(),
            "reconciled_dedupe_batch": lote,
        }})
        if perdedoras:
            db.wms_inventory.delete_many({"_id": {"$in": [r["_id"] for r in perdedoras]}})

        # Todas las cajas del material apuntan a la fila sobreviviente.
        box_ids = [b["box_id"] for b in a["boxes"]]
        if box_ids:
            db.wms_boxes.update_many(
                {"box_id": {"$in": box_ids}},
                {"$set": {"inventory_id": survivor.get("inventory_id")}},
            )

        detalle = {
            "location": k["location"], "material": etiqueta(k),
            "tier": a["tier"], "batch": lote,
            "filas_antes": len(rows), "filas_despues": 1,
            "units_antes": a["sistema_u"], "units_despues": a["fisico_u"],
            "delta": a["fisico_u"] - a["sistema_u"],
            "boxes": a["fisico_c"],
            "survivor_inventory_id": survivor.get("inventory_id"),
            "skus_fusionados": [r.get("sku") for r in rows],
        }
        db.wms_movements.insert_one({
            "movement_id": gen_id("mov"), "type": "inventory_row_reconciled",
            "details": detalle, "user_id": None,
            "user_name": "script/reconcile_duplicate_inventory_rows",
            "created_at": now_iso(),
        })
        db.wms_incidents.insert_one({
            "incident_id": gen_id("inc"), "kind": "duplicate_rows_merged",
            **detalle, "created_at": now_iso(),
        })


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--apply", action="store_true",
                    help="ejecuta los cambios (por defecto sólo simula)")
    ap.add_argument("--tiers", default="A,B",
                    help="casos a procesar (por defecto A,B; C nunca es automático)")
    ap.add_argument("--mongo", default=MONGODB_URL, help="URL de MongoDB")
    args = ap.parse_args()

    if not args.mongo:
        sys.exit("Falta MONGODB_URL (variable de entorno o --mongo)")
    tiers = {t.strip().upper() for t in args.tiers.split(",") if t.strip()}
    if "C" in tiers:
        sys.exit("El caso C nunca se procesa automáticamente: filas sin una sola "
                 "caja física requieren conteo cíclico y decisión humana.")

    db = pymongo.MongoClient(args.mongo)[DB_NAME]
    dry = not args.apply
    lote = uuid.uuid4().hex[:8]

    grupos = [analizar(db, k) for k in cargar_grupos(db)]
    grupos.sort(key=lambda a: (a["tier"], -abs(a["fisico_u"] - a["sistema_u"])))

    print(f"{'SIMULACIÓN (dry-run)' if dry else f'APLICANDO · lote {lote}'}")
    print(f"Grupos duplicados encontrados: {len(grupos)}\n")

    procesados = omitidos = 0
    delta_total = 0
    for a in grupos:
        k, marca = a["key"], a["tier"]
        cambio = a["fisico_u"] - a["sistema_u"]
        print(f"[{marca}] {etiqueta(k)}")
        print(f"     filas={len(a['rows'])} skus={[r.get('sku') for r in a['rows']]}")
        print(f"     sistema={a['sistema_u']}  físico={a['fisico_u']} ({a['fisico_c']} cajas)  "
              f"ajuste={cambio:+d}")
        if a["allocated"]:
            print(f"     !! units_allocated={a['allocated']} — se conserva en la fila sobreviviente")
        if marca == "C":
            print("     -> OMITIDO: sin cajas físicas. Requiere conteo cíclico.")
            omitidos += 1
            continue
        if marca not in tiers:
            print(f"     -> OMITIDO: caso {marca} fuera de --tiers")
            omitidos += 1
            continue
        print(f"     -> fusionar en {a['survivor'].get('inventory_id')} "
              f"(sku '{a['survivor'].get('sku')}'), borrar {len(a['rows'])-1}, "
              f"re-vincular {a['fisico_c']} cajas")
        aplicar(db, a, lote, dry)
        procesados += 1
        delta_total += cambio

    print(f"\n--- {'SIMULACIÓN' if dry else 'RESULTADO'} ---")
    print(f"  grupos procesados : {procesados}")
    print(f"  grupos omitidos   : {omitidos}")
    print(f"  ajuste neto       : {delta_total:+d} unidades")

    if not dry:
        restantes = [a for a in (analizar(db, k) for k in cargar_grupos(db))
                     if a["tier"] in tiers]
        print(f"  duplicados restantes en los casos procesados: {len(restantes)}")
        if restantes:
            print("  !! VERIFICACIÓN FALLIDA — revisar el respaldo "
                  f"wms_inventory_bak_dedupe_{lote}")
            sys.exit(1)
        print(f"  respaldo: wms_inventory_bak_dedupe_{lote}")
    else:
        print("\n  Nada fue modificado. Ejecuta con --apply para aplicar.")


if __name__ == "__main__":
    main()
