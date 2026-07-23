"""Restaura las cajas del writeoff 339273a1 que un cicloconteo había CONFIRMADO
físicamente — borradas por error el 2026-07-22.

EL ERROR (reportado por el usuario 2026-07-23)
──────────────────────────────────────────────
Una caja quedaba `recon_pending` cuando una conciliación PDA no la encontró.
Si DESPUÉS un cicloconteo la escaneaba (pestaña "Cuadradas"), el cierre 'ok'
NO actualizaba el status de la caja ("cierra limpio, sin tocar inventario"):
la caja seguía `recon_pending` en papel aunque el almacén ya la había tenido
en la mano. El writeoff del 2026-07-22 (lote 339273a1) dio de baja TODO lo
`recon_pending` — incluidas esas.

QUÉ HACE
────────
1. RE-DERIVA la evidencia (no hay lista hardcodeada): cajas del respaldo
   `wms_boxes_bak_writeoff_339273a1` que aparecen escaneadas en un
   cicloconteo (`wms_cycle_counts.scan_locations[].history[].scanned` o
   `scanned_boxes`) o ligadas (`cycle_count_bind_box`) en fecha POSTERIOR a
   su `recon_flagged_at`.
2. Respalda el estado actual de las ubicaciones afectadas
   (`wms_inventory_bak_restoreccok_<lote>` / `wms_boxes_bak_restoreccok_<lote>`).
3. Reinserta las cajas desde el respaldo del writeoff: status 'located'
   (las de 0u como 'depleted'), sin recon_pending, con
   `restored_from_writeoff` = lote + rastro de por qué.
4. Recalcula los renglones de los materiales tocados DESDE LAS CAJAS (la caja
   manda) — las unidades que el writeoff descontó regresan solas.
5. Deja rastro: movimiento + incidencia + registro en Ajustes de Conciliación.

USO
───
    python backend/scripts/restore_ccok_writeoff_boxes.py           # dry-run
    python backend/scripts/restore_ccok_writeoff_boxes.py --apply
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
WRITEOFF_BAK = "wms_boxes_bak_writeoff_339273a1"

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")


def now_iso():
    return datetime.now(timezone.utc).isoformat()


def gen_id(p):
    return f"{p}_{uuid.uuid4().hex[:12]}"


def units_of(b):
    try:
        return int(b.get("units") or b.get("qty") or 0)
    except (TypeError, ValueError):
        return 0


def evidencia_fisica(db, por_id):
    """box_id -> lista de (fecha, ubicación) POSTERIORES a recon_flagged_at."""
    vistos = defaultdict(list)
    for cc in db.wms_cycle_counts.find({"mode": "box_scan"},
                                       {"_id": 0, "count_id": 1, "scan_locations": 1}):
        for L in cc.get("scan_locations") or []:
            for h in L.get("history") or []:
                for bid in h.get("scanned") or []:
                    if bid in por_id:
                        vistos[bid].append((str(h.get("at") or "")[:19], L.get("location")))
            for bid in L.get("scanned_boxes") or []:
                if bid in por_id:
                    vistos[bid].append((str(L.get("counted_at") or "")[:19], L.get("location")))
    for m in db.wms_movements.find({"type": "cycle_count_bind_box"},
                                   {"_id": 0, "created_at": 1, "details": 1}):
        bid = (m.get("details") or {}).get("box_id")
        if bid in por_id:
            vistos[bid].append((str(m.get("created_at"))[:19],
                                (m.get("details") or {}).get("location")))

    confirmadas = {}
    for bid, evs in vistos.items():
        flagged = str(por_id[bid].get("recon_flagged_at") or "")[:19]
        post = sorted(e for e in evs if flagged and e[0] and e[0] > flagged)
        if post:
            confirmadas[bid] = post[-1]  # última vez vista físicamente
    return confirmadas


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

    bak = list(db[WRITEOFF_BAK].find({}, {"_id": 0}))
    if not bak:
        sys.exit(f"No existe o está vacío el respaldo {WRITEOFF_BAK}")
    por_id = {b["box_id"]: b for b in bak}
    confirmadas = evidencia_fisica(db, por_id)
    if not confirmadas:
        print("Ninguna caja del writeoff tiene evidencia física posterior. Nada que restaurar.")
        return

    ya_existen = {b["box_id"] for b in db.wms_boxes.find(
        {"box_id": {"$in": list(confirmadas)}}, {"_id": 0, "box_id": 1})}

    restaurar = [por_id[bid] for bid in confirmadas if bid not in ya_existen]
    total_u = sum(units_of(b) for b in restaurar)
    locs = sorted({b.get("recon_missing_from") or b.get("location") for b in restaurar})

    print(f"{'DRY-RUN' if dry else f'APLICANDO · lote {lote}'} · "
          f"{len(restaurar)} cajas confirmadas por cicloconteo a restaurar "
          f"({total_u:,}u en {len(locs)} ubicaciones)"
          + (f" · {len(ya_existen)} ya existen, se omiten" if ya_existen else ""))
    for b in sorted(restaurar, key=lambda x: (x.get("recon_missing_from") or "", x["box_id"])):
        visto = confirmadas[b["box_id"]]
        print(f"   {b['box_id']:<18} {b.get('recon_missing_from') or b.get('location'):<12} "
              f"{(b.get('style') or '?'):<10} {units_of(b):>4}u  "
              f"flag={str(b.get('recon_flagged_at',''))[:16]}  visto={visto[0][:16]}")

    # Renglones esperados tras el recálculo, por (ubicación, material, lote).
    def llave(doc, loc):
        return (loc, doc.get("style") or "", doc.get("color") or "", doc.get("size") or "",
                canon_coo(doc.get("country_of_origin") or doc.get("coo")),
                canon_fabric(doc.get("fabric_content")))

    tocadas = set()
    for b in restaurar:
        loc = b.get("recon_missing_from") or b.get("location")
        if units_of(b) > 0:
            tocadas.add(llave(b, loc))

    print("\nRenglones que se recalcularán desde las cajas:")
    plan = []
    for k in sorted(tocadas):
        loc, style, color, size, coo, fab = k
        fis_u = fis_c = 0
        for bx in db.wms_boxes.find({"location": loc, "style": style,
                                     "color": color, "size": size}, {"_id": 0}):
            if units_of(bx) > 0 and llave(bx, loc) == k:
                fis_u += units_of(bx)
                fis_c += 1
        extra_u = sum(units_of(b) for b in restaurar
                      if (b.get("recon_missing_from") or b.get("location")) == loc
                      and llave(b, loc) == k)
        extra_c = sum(1 for b in restaurar
                      if (b.get("recon_missing_from") or b.get("location")) == loc
                      and llave(b, loc) == k and units_of(b) > 0)
        plan.append((k, fis_u + extra_u, fis_c + extra_c))
        print(f"   {loc:<12} {style}/{color}/{size} [{coo}] -> {fis_u + extra_u}u / {fis_c + extra_c}c")

    if dry:
        print("\nNada fue modificado. Añade --apply.")
        return

    # ── respaldo del estado ACTUAL de las ubicaciones afectadas ──
    locs_l = list(locs)
    inv_now = list(db.wms_inventory.find({"location": {"$in": locs_l}}))
    box_now = list(db.wms_boxes.find({"location": {"$in": locs_l}}))
    if inv_now:
        db[f"wms_inventory_bak_restoreccok_{lote}"].insert_many(inv_now)
    if box_now:
        db[f"wms_boxes_bak_restoreccok_{lote}"].insert_many(box_now)

    ahora = now_iso()
    # ── reinsertar cajas ──
    for b in restaurar:
        doc = dict(b)
        loc = doc.get("recon_missing_from") or doc.get("location")
        doc["location"] = loc
        doc["status"] = "located" if units_of(doc) > 0 else "depleted"
        doc["recon_pending"] = False
        doc["recon_missing_from"] = None
        doc["restored_from_writeoff"] = "339273a1"
        doc["restored_reason"] = ("confirmada físicamente por cicloconteo el "
                                  f"{confirmadas[doc['box_id']][0][:16]}; el cierre 'ok' "
                                  "no limpiaba recon_pending y el writeoff la borró por error")
        doc["restored_batch"] = lote
        doc["restored_at"] = ahora
        doc["updated_at"] = ahora
        db.wms_boxes.insert_one(doc)

    # ── recalcular renglones desde las cajas (solo llaves tocadas) ──
    corregidos = creados = 0
    for (loc, style, color, size, coo, fab), u_esp, c_esp in plan:
        candidatos = [r for r in db.wms_inventory.find(
            {"location": loc, "style": style, "color": color, "size": size})
            if (canon_coo(r.get("country_of_origin") or r.get("coo")),
                canon_fabric(r.get("fabric_content"))) == (coo, fab)]
        if len(candidatos) > 1:
            print(f"   OJO: {loc} {style}/{color}/{size} tiene {len(candidatos)} renglones del "
                  "mismo lote (duplicado) — NO se toca, usa reconcile_duplicate_inventory_rows.py")
            continue
        if candidatos:
            r = candidatos[0]
            db.wms_inventory.update_one({"_id": r["_id"]}, {"$set": {
                "units_on_hand": u_esp, "total_boxes": c_esp,
                "updated_at": ahora, "restored_batch": lote}})
            corregidos += 1
        else:
            muestra = next(b for b in restaurar
                           if (b.get("recon_missing_from") or b.get("location")) == loc)
            db.wms_inventory.insert_one({
                "inventory_id": gen_id("inv"),
                "sku": muestra.get("sku") or style, "style": style,
                "color": color, "size": size,
                "customer": muestra.get("customer", ""),
                "manufacturer": muestra.get("manufacturer", ""),
                "country_of_origin": muestra.get("country_of_origin", "") or muestra.get("coo", ""),
                "fabric_content": muestra.get("fabric_content", ""),
                "location": loc, "units_on_hand": u_esp, "total_boxes": c_esp,
                "units_allocated": 0, "updated_at": ahora, "restored_batch": lote,
            })
            creados += 1

    # ── rastro ──
    por_loc = defaultdict(lambda: {"cajas": 0, "unidades": 0})
    for b in restaurar:
        loc = b.get("recon_missing_from") or b.get("location")
        por_loc[loc]["cajas"] += 1
        por_loc[loc]["unidades"] += units_of(b)
    db.wms_movements.insert_one({
        "movement_id": gen_id("mov"), "type": "recon_writeoff_restored",
        "details": {"batch": lote, "writeoff_batch": "339273a1",
                    "boxes": [b["box_id"] for b in restaurar],
                    "locations": dict(por_loc), "units": total_u},
        "user_id": None, "user_name": "Sistema (restore_ccok_writeoff_boxes.py)",
        "created_at": ahora,
    })
    db.wms_incidents.insert_one({
        "incident_id": gen_id("inc"), "kind": "recon_writeoff_restored",
        "mensaje": (f"Restauradas {len(restaurar)} cajas ({total_u:,}u en {len(locs)} ubicaciones) "
                    "del writeoff 339273a1: un cicloconteo las había confirmado físicamente pero el "
                    "cierre 'ok' no limpiaba recon_pending. Renglones recalculados desde las cajas."),
        "user_id": None, "user_name": "Sistema (restore_ccok_writeoff_boxes.py)",
        "created_at": ahora, "batch": lote,
    })
    db.wms_recon_adjustments.insert_one({
        "type": "recon_writeoff_restored",
        "created_at": ahora, "created_by": "Sistema (restore_ccok_writeoff_boxes.py)",
        "count": len(restaurar), "units": total_u,
        "reason": (f"Lote {lote}: reversa parcial del writeoff 339273a1 — cajas que la pestaña "
                   "Cuadradas de cicloconteo había confirmado físicamente. Respaldos "
                   f"wms_*_bak_restoreccok_{lote}."),
        "locations": [{"location": k, **v} for k, v in sorted(por_loc.items())],
        "boxes": [{"box_id": b["box_id"], "location": b.get("recon_missing_from") or b.get("location"),
                   "style": b.get("style"), "color": b.get("color"), "size": b.get("size"),
                   "units": units_of(b)} for b in restaurar],
    })

    print(f"\nListo: {len(restaurar)} cajas restauradas · {corregidos} renglones corregidos · "
          f"{creados} creados · respaldos wms_*_bak_restoreccok_{lote}")


if __name__ == "__main__":
    main()
