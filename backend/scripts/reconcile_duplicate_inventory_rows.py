"""Reconcilia las filas de inventario REALMENTE duplicadas de wms_inventory.

CONTEXTO
────────
Los endpoints de movimiento identificaban la fila de inventario con una llave
demasiado estrecha y creaban filas nuevas donde debían actualizar una existente
(corregido en services/inventory_ledger.py). Este script limpia las que ya
quedaron en la base.

QUÉ ES Y QUÉ NO ES UN DUPLICADO
───────────────────────────────
Varias filas del mismo (style,color,size,location) NO son necesariamente un
duplicado. Recepción e importación separan deliberadamente los lotes por país de
origen y composición, y eso hay que respetarlo: en confección importada a EUA el
país de origen es requisito legal de etiquetado.

Ejemplo REAL que no se debe tocar:

    18000/SAND/2X @ CARRO 262
       HONDURAS    1,188 u / 33 cajas     <- correcto
       NICARAGUA   1,908 u / 53 cajas     <- correcto

Sólo es duplicado cuando dos filas comparten (style, color, size, location) Y
la misma firma de lote (país + composición canonicalizada). La composición se
compara canonicalizada porque los datos traen 83 escrituras distintas
('58%C 42%P' vs '58% COTTON 42% POLYESTER') para 47 composiciones reales.

Medición del 2026-07-22: de 41 ubicaciones con varias filas, **32 son lotes
legítimos** y sólo **9 son duplicados**.

TRES CASOS, TRES RIESGOS (dentro de los duplicados reales)
──────────────────────────────────────────────────────────
  A · ESTRUCTURAL  — la suma ya coincide con el físico del lote. Fusionar no
                     cambia cantidades. Riesgo BAJO.
  B · AJUSTE       — no coincide; se ajusta a lo que hay en piso. Riesgo MEDIO.
  C · SIN RESPALDO — filas sin una sola caja física. NUNCA automático: requiere
                     conteo cíclico. Riesgo ALTO.

USO
───
    python backend/scripts/reconcile_duplicate_inventory_rows.py              # dry-run
    python backend/scripts/reconcile_duplicate_inventory_rows.py --apply      # ejecuta A+B

Con --apply respalda las filas afectadas en `wms_inventory_bak_dedupe_<lote>`
antes de tocarlas, y audita cada fusión en `wms_movements` + `wms_incidents`.
"""
import argparse
import os
import sys
import uuid
from collections import Counter, defaultdict
from datetime import datetime, timezone

import pymongo

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from services.inventory_ledger import batch_signature, material_keys, row_signature  # noqa: E402

MONGODB_URL = os.environ.get("MONGODB_URL")
DB_NAME = os.environ.get("DB_NAME", "mos-system")

# La consola de Windows usa cp1252 por defecto y revienta con acentos/flechas.
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")


def now_iso():
    return datetime.now(timezone.utc).isoformat()


def gen_id(prefix):
    return f"{prefix}_{uuid.uuid4().hex[:12]}"


def cargar_duplicados(db):
    """Grupos con MÁS DE UNA FILA PARA EL MISMO LOTE.

    Mongo agrupa por (style,color,size,location) —lo que sabe indexar— y aquí se
    subdivide por firma de lote canonicalizada, que es la comparación que Mongo
    no puede hacer.
    """
    candidatos = [g["_id"] for g in db.wms_inventory.aggregate([
        {"$group": {"_id": {"style": "$style", "color": "$color",
                            "size": "$size", "location": "$location"},
                    "n": {"$sum": 1}}},
        {"$match": {"n": {"$gt": 1}}},
    ])]
    duplicados, legitimos = [], 0
    for k in candidatos:
        rows = list(db.wms_inventory.find(k))
        por_lote = defaultdict(list)
        for r in rows:
            por_lote[row_signature(r)].append(r)
        for firma, filas in por_lote.items():
            if len(filas) > 1:
                duplicados.append((k, firma, filas))
            else:
                legitimos += 1
    return duplicados, legitimos


def analizar(db, k, firma, rows):
    """Clasifica un duplicado y elige la fila sobreviviente."""
    keys = material_keys(k["style"], "")
    todas = list(db.wms_boxes.find({
        "$or": [{"sku": {"$in": keys}}, {"style": {"$in": keys}}],
        "color": k["color"] or "", "size": k["size"] or "",
        "location": k["location"],
    }, {"_id": 0, "box_id": 1, "units": 1, "qty": 1, "inventory_id": 1, "sku": 1,
        "country_of_origin": 1, "coo": 1, "fabric_content": 1}))
    # Sólo las cajas de ESTE lote respaldan estas filas.
    boxes = [b for b in todas if row_signature(b) == firma]

    fisico_u = sum(int(b.get("units") or b.get("qty") or 0) for b in boxes)
    fisico_c = len(boxes)
    sistema_u = sum(int(r.get("units_on_hand") or 0) for r in rows)
    allocated = sum(int(r.get("units_allocated") or 0) for r in rows)

    tier = "C" if fisico_c == 0 else ("A" if sistema_u == fisico_u else "B")

    # Sobreviviente. El criterio manda en este orden:
    #  1. Que su `sku` coincida con el que llevan las cajas físicas. Es la señal
    #     más fuerte de "esta fila representa estas cajas", y conserva la fila
    #     ORIGINAL en vez de la que creó el bug (que además suele venir sin la
    #     metadata de recepción/conteo: recon_batch, asn_reference…).
    #  2. Que las cajas ya la referencien por inventory_id.
    #  3. sku compuesto (formato mayoritario, 82% de la colección).
    #  4. La más antigua.
    # Las cajas se re-vinculan a la sobreviviente en cualquier caso, así que (1)
    # no cuesta integridad de enlaces.
    ids_cajas = {b.get("inventory_id") for b in boxes if b.get("inventory_id")}
    skus_cajas = Counter((b.get("sku") or "") for b in boxes if b.get("sku"))
    sku_fisico = skus_cajas.most_common(1)[0][0] if skus_cajas else None

    def prioridad(r):
        return (
            0 if sku_fisico and (r.get("sku") or "") == sku_fisico else 1,
            0 if r.get("inventory_id") in ids_cajas else 1,
            0 if (r.get("sku") or "") != (r.get("style") or "") else 1,
            r.get("updated_at") or "",
        )

    return {
        "key": k, "firma": firma, "rows": rows, "boxes": boxes, "tier": tier,
        "fisico_u": fisico_u, "fisico_c": fisico_c,
        "sistema_u": sistema_u, "allocated": allocated,
        "survivor": sorted(rows, key=prioridad)[0],
    }


def etiqueta(k, firma=None):
    base = f"{k['style']}/{k['color']}/{k['size']} @ {k['location']}"
    lote = " · ".join(p for p in (firma or ()) if p)
    return f"{base}  [{lote}]" if lote else base


def aplicar(db, a, lote, dry):
    """Fusiona el grupo en la fila sobreviviente.

    DEDUPLICAR NO ES DECIDIR LA CANTIDAD. Son dos preguntas distintas:
      - "¿sobran filas?"      -> siempre se puede responder: sí, fusionar.
      - "¿cuánto material hay?" -> sólo se responde contra las cajas físicas.

    En A y B las cajas contestan la segunda, así que se ajusta al físico. En C no
    hay cajas: se fusionan las filas CONSERVANDO las unidades (no se da nada de
    baja) y se marca la ubicación para conteo cíclico. Así se elimina el
    duplicado —que es lo que bloquea el índice único— sin que un script decida
    dar de baja material que quizá sí existe y perdió su vínculo.
    """
    if dry:
        return
    k, survivor, rows = a["key"], a["survivor"], a["rows"]
    perdedoras = [r for r in rows if r["_id"] != survivor["_id"]]
    solo_fusion = a["tier"] == "C"

    db[f"wms_inventory_bak_dedupe_{lote}"].insert_many(
        [dict(r, _bak_group=etiqueta(k, a["firma"])) for r in rows]
    )
    nuevos = {
        "units_on_hand": a["sistema_u"] if solo_fusion else a["fisico_u"],
        "total_boxes": (sum(int(r.get("total_boxes") or 0) for r in rows)
                        if solo_fusion else a["fisico_c"]),
        "units_allocated": a["allocated"],
        "updated_at": now_iso(),
        "reconciled_dedupe_batch": lote,
    }
    if solo_fusion:
        nuevos["pending_cycle_count"] = True
        nuevos["pending_cycle_count_reason"] = (
            "filas fusionadas sin cajas físicas que las respalden; "
            "la cantidad no fue ajustada y requiere conteo")
    db.wms_inventory.update_one({"_id": survivor["_id"]}, {"$set": nuevos})
    if perdedoras:
        db.wms_inventory.delete_many({"_id": {"$in": [r["_id"] for r in perdedoras]}})

    box_ids = [b["box_id"] for b in a["boxes"]]
    if box_ids:
        db.wms_boxes.update_many(
            {"box_id": {"$in": box_ids}},
            {"$set": {"inventory_id": survivor.get("inventory_id")}},
        )

    detalle = {
        "location": k["location"], "material": etiqueta(k, a["firma"]),
        "tier": a["tier"], "batch": lote,
        "country_of_origin": a["firma"][0], "fabric_canonico": a["firma"][1],
        "filas_antes": len(rows), "filas_despues": 1,
        "units_antes": a["sistema_u"], "units_despues": a["fisico_u"],
        "delta": a["fisico_u"] - a["sistema_u"], "boxes": a["fisico_c"],
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
    ap.add_argument("--merge-c", action="store_true",
                    help="fusiona tambien el caso C SIN ajustar cantidades: elimina el "
                         "duplicado (desbloquea el indice unico) y marca la ubicacion "
                         "para conteo ciclico")
    ap.add_argument("--only", default=None, metavar="UBICACION",
                    help="procesa SOLO esta ubicación (piloto de bajo riesgo)")
    ap.add_argument("--mongo", default=MONGODB_URL, help="URL de MongoDB")
    args = ap.parse_args()

    if not args.mongo:
        sys.exit("Falta MONGODB_URL (variable de entorno o --mongo)")
    tiers = {t.strip().upper() for t in args.tiers.split(",") if t.strip()}
    if "C" in tiers and not args.merge_c:
        sys.exit("El caso C no se procesa con --tiers: usa --merge-c, que SÓLO "
                 "fusiona las filas conservando las unidades (no da nada de baja) "
                 "y marca la ubicación para conteo cíclico.")
    if args.merge_c:
        tiers.add("C")

    db = pymongo.MongoClient(args.mongo)[DB_NAME]
    dry = not args.apply
    lote = uuid.uuid4().hex[:8]

    duplicados, legitimos = cargar_duplicados(db)
    if args.only:
        objetivo = args.only.strip().upper()
        duplicados = [d for d in duplicados if (d[0]["location"] or "").upper() == objetivo]
        if not duplicados:
            sys.exit(f"No hay duplicados reales en '{objetivo}'.")
        print(f"FILTRO --only: sólo {objetivo}\n")
    grupos = [analizar(db, k, f, rows) for k, f, rows in duplicados]
    grupos.sort(key=lambda a: (a["tier"], -abs(a["fisico_u"] - a["sistema_u"])))

    print(f"{'SIMULACIÓN (dry-run)' if dry else f'APLICANDO · lote {lote}'}\n")
    ambito = " (global)" if args.only else ""
    print(f"  lotes LEGÍTIMOS{ambito} (país/composición distintos, NO se tocan): {legitimos}")
    print(f"  duplicados REALES (mismo lote, más de una fila)         : {len(grupos)}\n")

    procesados = omitidos = 0
    delta_total = 0
    for a in grupos:
        k, marca = a["key"], a["tier"]
        cambio = a["fisico_u"] - a["sistema_u"]
        print(f"[{marca}] {etiqueta(k, a['firma'])}")
        print(f"     filas={len(a['rows'])} skus={[r.get('sku') for r in a['rows']]}")
        print(f"     sistema={a['sistema_u']}  físico={a['fisico_u']} ({a['fisico_c']} cajas)  "
              f"ajuste={cambio:+d}")
        if a["allocated"]:
            print(f"     !! units_allocated={a['allocated']} - se conserva en la sobreviviente")
        if marca == "C" and not args.merge_c:
            print("     -> OMITIDO: sin cajas físicas de este lote. Requiere conteo cíclico.")
            omitidos += 1
            continue
        if marca == "C":
            print(f"     -> SOLO FUSION: conserva {a['sistema_u']} u (NO se da de baja "
                  f"nada) y se marca para conteo cíclico")
        if marca not in tiers:
            print(f"     -> OMITIDO: caso {marca} fuera de --tiers")
            omitidos += 1
            continue
        print(f"     -> fusionar en {a['survivor'].get('inventory_id')} "
              f"(sku '{a['survivor'].get('sku')}'), borrar {len(a['rows']) - 1}, "
              f"re-vincular {a['fisico_c']} cajas")
        aplicar(db, a, lote, dry)
        procesados += 1
        delta_total += 0 if marca == "C" else cambio

    print(f"\n--- {'SIMULACIÓN' if dry else 'RESULTADO'} ---")
    print(f"  grupos procesados : {procesados}")
    print(f"  grupos omitidos   : {omitidos}")
    print(f"  ajuste neto       : {delta_total:+d} unidades")

    if not dry:
        restantes, _ = cargar_duplicados(db)
        if args.only:
            restantes = [d for d in restantes
                         if (d[0]["location"] or "").upper() == args.only.strip().upper()]
        pendientes = [analizar(db, k, f, r) for k, f, r in restantes]
        pendientes = [a for a in pendientes if a["tier"] in tiers]
        print(f"  duplicados restantes en los casos procesados: {len(pendientes)}")
        if pendientes:
            print(f"  !! VERIFICACIÓN FALLIDA - revisar wms_inventory_bak_dedupe_{lote}")
            sys.exit(1)
        print(f"  respaldo: wms_inventory_bak_dedupe_{lote}")
    else:
        print("\n  Nada fue modificado. Ejecuta con --apply para aplicar.")


if __name__ == "__main__":
    main()
