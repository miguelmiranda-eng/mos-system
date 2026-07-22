"""Crea el índice ÚNICO que impide, a nivel de base de datos, que vuelva a
existir más de una fila de inventario para el mismo material y lote.

    unique( style, color, size, location, country_of_origin, fabric_content )

POR QUÉ ESTA LLAVE Y NO OTRA
────────────────────────────
- Va sobre `style`, NO sobre `sku`: `sku` convive en dos formatos ('CK001' vs
  'CK001-PFD-M') y no es una llave. Indexar `sku` habría dejado pasar justo el
  duplicado de CK001, que tenía el MISMO style y distinto sku.
- Incluye país de origen y composición porque son LOTES distintos y deben
  coexistir. Un índice sobre las cuatro primeras columnas habría prohibido el
  caso legítimo (`18000/SAND/2X @ CARRO 262` con Honduras y Nicaragua) y roto la
  trazabilidad aduanera.

LÍMITE CONOCIDO
───────────────
El índice compara `fabric_content` CRUDO, así que dos escrituras distintas de la
misma composición ('58%C 42%P' vs '58% COTTON 42% POLYESTER') seguirían pasando.
Ese hueco lo cubre la comparación canonicalizada de services/inventory_ledger.py
en tiempo de escritura. El índice es la última línea de defensa para el caso
exacto, no la única.

REQUISITO
─────────
No pueden quedar duplicados reales. Ejecuta antes:
    python backend/scripts/reconcile_duplicate_inventory_rows.py --apply

USO
───
    python backend/scripts/create_inventory_unique_index.py            # dry-run
    python backend/scripts/create_inventory_unique_index.py --apply
"""
import argparse
import os
import sys

import pymongo

MONGODB_URL = os.environ.get("MONGODB_URL")
DB_NAME = os.environ.get("DB_NAME", "mos-system")
NOMBRE = "uniq_inventory_material_lote"
LLAVE = [("style", 1), ("color", 1), ("size", 1), ("location", 1),
         ("country_of_origin", 1), ("fabric_content", 1)]

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")


def conflictos(db):
    """Filas que impedirían crear el índice: misma llave exacta, más de una."""
    return list(db.wms_inventory.aggregate([
        {"$group": {"_id": {c: f"${c}" for c, _ in LLAVE},
                    "n": {"$sum": 1},
                    "ids": {"$push": "$inventory_id"},
                    "units": {"$push": "$units_on_hand"}}},
        {"$match": {"n": {"$gt": 1}}},
        {"$sort": {"n": -1}},
    ], allowDiskUse=True))


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--apply", action="store_true", help="crea el índice (por defecto sólo verifica)")
    ap.add_argument("--mongo", default=MONGODB_URL)
    args = ap.parse_args()
    if not args.mongo:
        sys.exit("Falta MONGODB_URL")

    db = pymongo.MongoClient(args.mongo)[DB_NAME]

    if NOMBRE in db.wms_inventory.index_information():
        print(f"El índice '{NOMBRE}' ya existe. Nada que hacer.")
        return

    conf = conflictos(db)
    print(f"Filas en wms_inventory: {db.wms_inventory.count_documents({})}")
    print(f"Conflictos que bloquean el índice: {len(conf)}\n")
    for c in conf[:20]:
        k = c["_id"]
        print(f"  {k.get('style')}/{k.get('color')}/{k.get('size')} @ {k.get('location')}"
              f"  [{k.get('country_of_origin')} · {k.get('fabric_content')}]"
              f"  {c['n']} filas, units={c['units']}")
    if len(conf) > 20:
        print(f"  ... y {len(conf) - 20} más")

    if conf:
        print("\n!! NO se puede crear el índice todavía.")
        print("   Ejecuta primero: reconcile_duplicate_inventory_rows.py --apply")
        sys.exit(1)

    if not args.apply:
        print("\n  Sin conflictos: el índice se puede crear. Ejecuta con --apply.")
        return

    print(f"\nCreando '{NOMBRE}' ...")
    db.wms_inventory.create_index(LLAVE, unique=True, name=NOMBRE, background=True)
    print("  creado.")
    info = db.wms_inventory.index_information().get(NOMBRE)
    print(f"  verificado: {info}")


if __name__ == "__main__":
    main()
