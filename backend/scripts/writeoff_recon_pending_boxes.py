"""Baja auditada de las cajas marcadas `recon_pending` (faltantes en conteo).

QUÉ SON
───────
Cuando un operador concilia una ubicación, el sistema marca `recon_pending` a
las cajas que ESPERABA encontrar y no aparecieron:

    missing_ids = expected_ids - scanned_set
    -> status="recon_pending", recon_missing_from=<ubicación>

No son basura: son la cola de faltantes que alimenta el segundo conteo
(`/recon/second-count/start`). Sólo deben darse de baja cuando ese segundo
conteo YA confirmó que el material no está.

POR QUÉ NO BASTA CON BORRARLAS
──────────────────────────────
Sus unidades SIGUEN contadas en `wms_inventory`: en PS12-A11, de 1,701 u de
inventario, 1,241 son cajas faltantes y sólo 460 están presentes. Borrar la caja
no toca la fila -> el inventario quedaría inflado exactamente en lo que se
borró. Este script baja las dos cosas a la vez y deja rastro:

  1. Respalda TODAS las cajas afectadas en `wms_boxes_bak_writeoff_<lote>`.
  2. Descuenta de la fila de inventario correspondiente (material + lote),
     resolviendo la fila con la llave tolerante de services/inventory_ledger.py.
  3. Borra las cajas.
  4. Audita por ubicación en `wms_movements` + `wms_incidents`, conservando
     `recon_missing_from` para no perder la evidencia de qué faltó y dónde.
  5. Verifica al final que no queden cajas recon_pending.

`total_boxes` sólo se descuenta por las cajas CON material: en wms_inventory ese
campo cuenta cajas con contenido, no registros.

USO
───
    python backend/scripts/writeoff_recon_pending_boxes.py                # simula
    python backend/scripts/writeoff_recon_pending_boxes.py --only-empty   # sólo vacías
    python backend/scripts/writeoff_recon_pending_boxes.py --apply
"""
import argparse
import os
import sys
import uuid
from collections import defaultdict
from datetime import datetime, timezone

import pymongo

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from services.inventory_ledger import canon_coo, canon_fabric, material_keys  # noqa: E402

MONGODB_URL = os.environ.get("MONGODB_URL")
DB_NAME = os.environ.get("DB_NAME", "mos-system")

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")


def now_iso():
    return datetime.now(timezone.utc).isoformat()


def gen_id(p):
    return f"{p}_{uuid.uuid4().hex[:12]}"


def firma(doc):
    return (canon_coo(doc.get("country_of_origin") or doc.get("coo")),
            canon_fabric(doc.get("fabric_content")))


def fila_de(db, b):
    """Fila de inventario del material+lote de la caja, con llave tolerante."""
    keys = material_keys(b.get("style"), b.get("sku"))
    if not keys:
        return None
    cands = list(db.wms_inventory.find({
        "$or": [{"sku": {"$in": keys}}, {"style": {"$in": keys}}],
        "color": b.get("color") or "", "size": b.get("size") or "",
        "location": b.get("location") or "",
    }))
    if not cands:
        return None
    f = firma(b)
    exactas = [r for r in cands if firma(r) == f]
    if len(exactas) == 1:
        return exactas[0]
    if len(cands) == 1 and not exactas:
        return cands[0]      # fila única del material: es la suya aunque el lote difiera
    return exactas[0] if exactas else None


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--apply", action="store_true", help="ejecuta la baja")
    ap.add_argument("--only-empty", action="store_true",
                    help="sólo las cajas sin material (no afecta el inventario)")
    ap.add_argument("--mongo", default=MONGODB_URL)
    args = ap.parse_args()
    if not args.mongo:
        sys.exit("Falta MONGODB_URL")

    db = pymongo.MongoClient(args.mongo)[DB_NAME]
    dry = not args.apply
    lote = uuid.uuid4().hex[:8]

    q = {"recon_pending": True}
    if args.only_empty:
        q["$or"] = [{"units": {"$lte": 0}}, {"units": None}, {"units": {"$exists": False}}]
    cajas = list(db.wms_boxes.find(q))
    if not cajas:
        print("No hay cajas recon_pending que dar de baja.")
        return

    con_material = [b for b in cajas if int(b.get("units") or 0) > 0]
    unidades = sum(int(b.get("units") or 0) for b in con_material)
    print(f"{'SIMULACIÓN' if dry else f'APLICANDO · lote {lote}'}\n")
    print(f"  cajas recon_pending : {len(cajas):,}")
    print(f"     con material     : {len(con_material):,}  ({unidades:,} unidades)")
    print(f"     vacías           : {len(cajas) - len(con_material):,}\n")

    # Agrupar por fila de inventario afectada.
    #
    # NO se RESTA lo dado de baja: se DEJA LA FILA EN LO QUE QUEDA. Restar
    # parecía natural pero es incorrecto — hay filas cuyo saldo ya no incluía a
    # las faltantes (la conciliación reconstruye el inventario de la ubicación
    # al cerrar el conteo). Restar ahí, con clamp a 0, habría borrado material
    # PRESENTE: en PS06-A22 la fila tenía 64 u que son de la única caja que sí
    # está, y en PS06-A07 216 u de 3 cajas presentes. Fijar el valor al
    # remanente físico es correcto en los dos casos.
    ajustes = defaultdict(lambda: {"units": 0, "boxes": 0, "loc": "", "mat": "", "row": None})
    sin_fila = []
    for b in con_material:
        r = fila_de(db, b)
        if r is None:
            sin_fila.append(b)
            continue
        a = ajustes[str(r["_id"])]
        a["row"] = r
        a["units"] += int(b.get("units") or 0)
        a["boxes"] += 1
        a["loc"] = b.get("location")
        a["mat"] = f"{b.get('style')}/{b.get('color')}/{b.get('size')}"

    # Remanente real de cada fila: cajas CON material que NO se dan de baja.
    #
    # Filtrar por la firma de lote de LA FILA sería un error donde la fila está
    # mal etiquetada: en PS05-A09 la fila dice NICARAGUA y sus cajas son HAITI,
    # así que ninguna caja "coincidiría" y la fila se pondría en 0, borrando
    # ~853 u presentes. Por eso: si la fila es la ÚNICA de ese material en la
    # ubicación, el remanente son TODAS sus cajas sin importar el lote (la fila
    # es suya aunque el país esté mal); sólo cuando hay varias filas del mismo
    # material se discrimina por lote.
    bajas = {b.get("box_id") for b in cajas}
    for a in ajustes.values():
        r = a["row"]
        keys = material_keys(r.get("style"), r.get("sku"))
        filtro_mat = {
            "$or": [{"sku": {"$in": keys}}, {"style": {"$in": keys}}],
            "color": r.get("color") or "", "size": r.get("size") or "",
            "location": r.get("location") or "",
        }
        hermanas = db.wms_inventory.count_documents({
            "$or": [{"sku": {"$in": keys}}, {"style": {"$in": keys}}],
            "color": r.get("color") or "", "size": r.get("size") or "",
            "location": r.get("location") or "",
        })
        rem_u = rem_c = 0
        for b in db.wms_boxes.find(filtro_mat, {"_id": 0}):
            if b.get("box_id") in bajas or int(b.get("units") or 0) <= 0:
                continue
            if hermanas > 1 and firma(b) != firma(r):
                continue
            rem_u += int(b.get("units") or 0)
            rem_c += 1
        a["rem_u"], a["rem_c"] = rem_u, rem_c

    por_ubic = defaultdict(lambda: {"cajas": 0, "unidades": 0})
    for b in cajas:
        k = b.get("recon_missing_from") or b.get("location") or "(sin ubicación)"
        por_ubic[k]["cajas"] += 1
        por_ubic[k]["unidades"] += int(b.get("units") or 0)

    print("  AJUSTES DE INVENTARIO (top 12 por unidades dadas de baja):")
    for a in sorted(ajustes.values(), key=lambda x: -x["units"])[:12]:
        r = a["row"]
        aviso = "" if int(r.get("units_on_hand") or 0) >= a["units"] else "   (la fila ya excluia las faltantes)"
        print(f"     {a['loc']:14s} {a['mat']:26s} "
              f"{r.get('units_on_hand')}u/{r.get('total_boxes')}c -> "
              f"{a['rem_u']}u/{a['rem_c']}c   (baja {a['units']}u){aviso}")
    if len(ajustes) > 12:
        print(f"     ... y {len(ajustes) - 12} filas más")
    if sin_fila:
        print(f"\n  !! {len(sin_fila)} cajas con material SIN fila de inventario localizable "
              f"({sum(int(b.get('units') or 0) for b in sin_fila):,} u): se borran, "
              f"pero no hay nada que descontar.")

    print(f"\n  ubicaciones afectadas: {len(por_ubic)}")
    print(f"  filas de inventario a ajustar: {len(ajustes)}")

    if dry:
        print("\n  Nada fue modificado. Ejecuta con --apply.")
        return

    # 1. Respaldo COMPLETO antes de tocar nada.
    db[f"wms_boxes_bak_writeoff_{lote}"].insert_many([dict(b) for b in cajas])

    # 2. Descontar del inventario.
    for a in ajustes.values():
        r = a["row"]
        db.wms_inventory.update_one({"_id": r["_id"]}, {"$set": {
            "units_on_hand": a["rem_u"],
            "total_boxes": a["rem_c"],
            "updated_at": now_iso(),
            "writeoff_batch": lote,
        }})

    # 3. Borrar las cajas.
    ids = [b["box_id"] for b in cajas if b.get("box_id")]
    res = db.wms_boxes.delete_many({"box_id": {"$in": ids}})

    # 4. Auditoría por ubicación (conserva la evidencia de qué faltó y dónde).
    for loc, v in por_ubic.items():
        detalle = {"location": loc, "batch": lote,
                   "cajas_dadas_de_baja": v["cajas"], "unidades": v["unidades"],
                   "motivo": "faltantes confirmados en segundo conteo (recon_pending)"}
        db.wms_movements.insert_one({
            "movement_id": gen_id("mov"), "type": "inventory_row_reconciled",
            "details": detalle, "user_id": None,
            "user_name": "script/writeoff_recon_pending_boxes", "created_at": now_iso()})
        db.wms_incidents.insert_one({
            "incident_id": gen_id("inc"), "kind": "recon_pending_written_off",
            **detalle, "created_at": now_iso()})

    print(f"\n--- RESULTADO ---")
    print(f"  cajas borradas    : {res.deleted_count:,}")
    print(f"  filas ajustadas   : {len(ajustes):,}")
    print(f"  unidades de baja  : {unidades:,}")
    print(f"  respaldo          : wms_boxes_bak_writeoff_{lote}")

    restantes = db.wms_boxes.count_documents({"recon_pending": True})
    print(f"  cajas recon_pending restantes: {restantes}")
    if restantes and not args.only_empty:
        print("  !! VERIFICACIÓN FALLIDA: quedaron cajas pendientes")
        sys.exit(1)


if __name__ == "__main__":
    main()
