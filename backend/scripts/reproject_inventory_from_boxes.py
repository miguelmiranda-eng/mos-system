"""Reproyecta las filas de wms_inventory desde las CAJAS FÍSICAS de una ubicación.

LAS CAJAS SON LA VERDAD. `wms_inventory` es una proyección: dice cuánto hay de
cada material y lote en cada ubicación, para no tener que contar 80,000 cajas en
cada consulta. Cuando la proyección se desincroniza, la respuesta correcta no es
"repararla a mano" sino RECALCULARLA desde las cajas.

QUÉ HACE
────────
Por cada lote físico presente en la ubicación —(style, color, size, país,
composición)— garantiza que exista UNA fila con exactamente las unidades y cajas
que hay en piso:
  · falta la fila            -> la crea desde las cajas
  · la fila no cuadra        -> corrige units_on_hand / total_boxes
  · la fila tiene mal el país-> lo corrige (la caja manda)
  · varias filas del lote    -> ABORTA (eso es un duplicado; usa el otro script)

QUÉ NO HACE
───────────
NO borra filas sin cajas físicas. Esa es la pregunta "¿este material existe y
perdió su vínculo, o ya no está?", y sólo se responde con un conteo cíclico. Las
reporta y las marca `pending_cycle_count`.

`units_allocated` se conserva siempre: son compromisos de picking, no stock.

POR QUÉ EXISTE
──────────────
El 2026-07-22 mi propio script de deduplicación destruyó cobertura real en
PS14-A11: dos filas etiquetadas NICARAGUA cubrían en realidad 5 cajas de
Nicaragua Y 9 de Haití. Al tratarlas como duplicado y ajustar al físico de
Nicaragua, se perdieron 324 u / 9 cajas. Reproyectar desde las cajas repara ese
tipo de daño sin depender de qué diga la fila.

USO
───
    python backend/scripts/reproject_inventory_from_boxes.py --only PS14-A11
    python backend/scripts/reproject_inventory_from_boxes.py --only PS14-A11 --apply
    python backend/scripts/reproject_inventory_from_boxes.py --all           # auditoría global
"""
import argparse
import os
import sys
import uuid
from collections import defaultdict
from datetime import datetime, timezone

import pymongo

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from services.inventory_ledger import canon_coo, canon_fabric  # noqa: E402

MONGODB_URL = os.environ.get("MONGODB_URL")
DB_NAME = os.environ.get("DB_NAME", "mos-system")

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")


def now_iso():
    return datetime.now(timezone.utc).isoformat()


def gen_id(p):
    return f"{p}_{uuid.uuid4().hex[:12]}"


def lote_txt(k):
    """Etiqueta legible del lote. Mostrar SOLO el país hacía que dos lotes que
    difieren en composición se vieran idénticos en el reporte — imposible de
    revisar."""
    return " · ".join(p for p in (k[3], k[4]) if p) or "sin lote"


def firma(doc):
    return (canon_coo(doc.get("country_of_origin") or doc.get("coo")),
            canon_fabric(doc.get("fabric_content")))


def lotes_fisicos(db, location):
    """Agrupa las cajas de una ubicación por material + lote."""
    g = defaultdict(lambda: {"units": 0, "boxes": 0, "sample": None, "ids": []})
    for b in db.wms_boxes.find({"location": location}, {"_id": 0}):
        k = (b.get("style") or "", b.get("color") or "", b.get("size") or "") + firma(b)
        acc = g[k]
        acc["units"] += int(b.get("units") or b.get("qty") or 0)
        acc["boxes"] += 1
        acc["ids"].append(b.get("box_id"))
        if acc["sample"] is None:
            acc["sample"] = b
    return g


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--only", action="append", metavar="UBICACION",
                    help="ubicación a reproyectar (repetible)")
    ap.add_argument("--all", action="store_true", help="audita TODAS las ubicaciones (sólo reporta)")
    ap.add_argument("--apply", action="store_true", help="escribe los cambios")
    ap.add_argument("--mongo", default=MONGODB_URL)
    args = ap.parse_args()
    if not args.mongo:
        sys.exit("Falta MONGODB_URL")
    if not args.only and not args.all:
        sys.exit("Indica --only <UBICACION> o --all")

    db = pymongo.MongoClient(args.mongo)[DB_NAME]
    dry = not args.apply
    lote = uuid.uuid4().hex[:8]

    ubicaciones = args.only or sorted(
        u for u in db.wms_boxes.distinct("location") if u)
    if args.all and args.apply:
        sys.exit("--all es sólo auditoría. Reproyecta ubicación por ubicación con --only.")

    print(f"{'AUDITORÍA' if dry else f'APLICANDO · lote {lote}'} · {len(ubicaciones)} ubicación(es)\n")
    creadas = corregidas = huerfanas = rotas = 0

    for loc in ubicaciones:
        fis = lotes_fisicos(db, loc)
        filas = list(db.wms_inventory.find({"location": loc}))
        por_firma = defaultdict(list)
        for r in filas:
            por_firma[(r.get("style") or "", r.get("color") or "", r.get("size") or "") + firma(r)].append(r)

        # GUARDA: cajas sin `style`. Son ~598 en la base (dato roto de origen).
        # Crear una fila con style vacío generaría basura estructurada: una fila
        # que ningún flujo del WMS puede volver a encontrar. Se reportan aparte
        # para que se reparen en la caja, que es donde está el problema.
        sin_identidad = {k: acc for k, acc in fis.items() if not (k[0] or "").strip()}
        for k, acc in sin_identidad.items():
            fis.pop(k)

        acciones = []
        sin_pareja = []          # lotes físicos sin fila
        for k, acc in fis.items():
            existentes = por_firma.get(k, [])
            if len(existentes) > 1:
                print(f"[{loc}] {k[0]}/{k[1]}/{k[2]} [{k[3]}] -> {len(existentes)} filas del MISMO lote: "
                      f"es un duplicado, usa reconcile_duplicate_inventory_rows.py")
                continue
            if not existentes:
                sin_pareja.append((k, acc))
            else:
                r = existentes[0]
                if (int(r.get("units_on_hand") or 0) != acc["units"]
                        or int(r.get("total_boxes") or 0) != acc["boxes"]):
                    acciones.append(("CORREGIR", k, acc, r))

        filas_sueltas = [r for k, rs in por_firma.items() if k not in fis for r in rs]

        # MAL ETIQUETADA vs FALTANTE. Si para un mismo (style,color,size) queda
        # EXACTAMENTE una fila sin cajas y EXACTAMENTE un lote sin fila, no es una
        # fila faltante: es la misma fila con el país equivocado. Crear una nueva
        # DUPLICARÍA la cantidad — que es justo el error que este script repara.
        for k, acc in list(sin_pareja):
            mat = k[:3]
            cand = [r for r in filas_sueltas
                    if (r.get("style") or "", r.get("color") or "", r.get("size") or "") == mat]
            otros_lotes = [x for x, _ in sin_pareja
                           if x[:3] == mat and x != k]
            if len(cand) == 1 and not otros_lotes:
                acciones.append(("REETIQUETAR", k, acc, cand[0]))
                filas_sueltas.remove(cand[0])
                sin_pareja.remove((k, acc))

        acciones += [("CREAR", k, acc, None) for k, acc in sin_pareja]

        # Filas sin ninguna caja física que las respalde: se reportan, no se borran.
        sin_cajas = [r for r in filas_sueltas if int(r.get("units_on_hand") or 0) > 0]

        if not acciones and not sin_cajas and not sin_identidad:
            continue

        print(f"── {loc} ──")
        if not dry:
            # Respaldo COMPLETO de la ubicación antes de tocar nada. Reproyectar
            # reescribe cantidades: sin respaldo no hay vuelta atrás.
            if filas:
                db[f"wms_inventory_bak_reproj_{lote}"].insert_many(
                    [dict(x, _bak_location=loc) for x in filas])
        for tipo, k, acc, r in acciones:
            s = acc["sample"] or {}
            if tipo == "CREAR":
                print(f"   CREAR       {k[0]}/{k[1]}/{k[2]}  [{lote_txt(k)}]  {acc['units']}u / {acc['boxes']}c")
                creadas += 1
                if not dry:
                    db.wms_inventory.insert_one({
                        "inventory_id": gen_id("inv"),
                        "sku": s.get("sku") or k[0], "style": k[0],
                        "color": k[1], "size": k[2],
                        "customer": s.get("customer", ""), "manufacturer": s.get("manufacturer", ""),
                        "description": s.get("description", ""),
                        "country_of_origin": s.get("country_of_origin", "") or s.get("coo", ""),
                        "fabric_content": s.get("fabric_content", ""),
                        "location": loc,
                        "units_on_hand": acc["units"], "total_boxes": acc["boxes"],
                        "units_allocated": 0,
                        "updated_at": now_iso(), "reprojected_batch": lote,
                    })
            else:
                etq = ("REETIQUETAR" if tipo == "REETIQUETAR" else "CORREGIR")
                extra = (f"  [{canon_coo(r.get('country_of_origin'))} -> {k[3]}]"
                         if tipo == "REETIQUETAR" else "")
                print(f"   {etq:11s} {k[0]}/{k[1]}/{k[2]}  [{lote_txt(k)}]  "
                      f"{r.get('units_on_hand')}u/{r.get('total_boxes')}c -> "
                      f"{acc['units']}u/{acc['boxes']}c{extra}")
                corregidas += 1
                if not dry:
                    db.wms_inventory.update_one({"_id": r["_id"]}, {"$set": {
                        "units_on_hand": acc["units"], "total_boxes": acc["boxes"],
                        "country_of_origin": s.get("country_of_origin", "") or s.get("coo", ""),
                        "fabric_content": s.get("fabric_content", "") or r.get("fabric_content", ""),
                        "sku": s.get("sku") or r.get("sku"),
                        "updated_at": now_iso(), "reprojected_batch": lote,
                        "relabeled_from_coo": (r.get("country_of_origin") or "") if tipo == "REETIQUETAR" else None,
                    }, "$unset": {"pending_cycle_count": "", "pending_cycle_count_reason": ""}})
        for k, acc in sin_identidad.items():
            ids = ", ".join((acc["ids"] or [])[:3])
            print(f"   SIN STYLE   ?/{k[1]}/{k[2]}  [{lote_txt(k)}]  {acc['units']}u / {acc['boxes']}c  "
                  f"-> cajas sin `style`, hay que repararlas en la caja ({ids})")
            rotas += 1
        for r in sin_cajas:
            print(f"   SIN CAJAS   {r.get('style')}/{r.get('color')}/{r.get('size')}  "
                  f"[{canon_coo(r.get('country_of_origin'))} · {canon_fabric(r.get('fabric_content'))}]  "
                  f"{r.get('units_on_hand')}u/{r.get('total_boxes')}c -> requiere conteo cíclico")
            huerfanas += 1
            if not dry:
                db.wms_inventory.update_one({"_id": r["_id"]}, {"$set": {
                    "pending_cycle_count": True,
                    "pending_cycle_count_reason": "sin cajas físicas que respalden la fila",
                }})

        if not dry and (acciones or sin_cajas):
            db.wms_movements.insert_one({
                "movement_id": gen_id("mov"), "type": "inventory_row_reconciled",
                "details": {"location": loc, "batch": lote, "reproyeccion": True,
                            "creadas": sum(1 for a in acciones if a[0] == "CREAR"),
                            "corregidas": sum(1 for a in acciones if a[0] == "CORREGIR"),
                            "sin_cajas": len(sin_cajas)},
                "user_id": None, "user_name": "script/reproject_inventory_from_boxes",
                "created_at": now_iso(),
            })
            db.wms_incidents.insert_one({
                "incident_id": gen_id("inc"), "kind": "inventory_reprojected",
                "location": loc, "batch": lote,
                "creadas": sum(1 for a in acciones if a[0] == "CREAR"),
                "corregidas": sum(1 for a in acciones if a[0] == "CORREGIR"),
                "sin_cajas": len(sin_cajas), "created_at": now_iso(),
            })

    print(f"\n--- {'AUDITORÍA' if dry else 'RESULTADO'} ---")
    print(f"  filas a crear    : {creadas}")
    print(f"  filas a corregir : {corregidas}")
    print(f"  filas sin cajas  : {huerfanas}  (NO se borran: requieren conteo)")
    print(f"  lotes SIN STYLE  : {rotas}  (OMITIDOS: reparar el dato en la caja)")
    if dry:
        print("\n  Nada fue modificado. Añade --apply.")


if __name__ == "__main__":
    main()
