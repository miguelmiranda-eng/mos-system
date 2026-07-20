"""Limpieza de carros GTS — auditoria fisica confirmo que el material no existe.

Fuente: "Limpia de carros GTS (1).xlsx" (201 filas, cantidades negativas = ajuste).

Que hace:
  1. Respalda los registros de inventario y las cajas afectadas.
  2. Pone units_on_hand = 0 en los registros de inventario listados (conserva el registro).
  3. Marca como 'depleted' las cajas activas de esos SKU/ubicacion.
  4. Deja registro completo en wms_movements y en un manifiesto.

Que NO toca:
  - Inventario de esos carros que no viene en el Excel (~19,325 u.).
  - Cajas de otros SKU en esas ubicaciones.
  - Pick tickets (solo se reportan los que apuntan a estos carros).

Uso:
    python clean_gts_carros.py            # simulacion, no escribe nada
    python clean_gts_carros.py --apply    # ejecuta
"""
import os
import sys
import json
import uuid
import collections
from datetime import datetime, timezone
from pathlib import Path

import openpyxl
from bson import ObjectId
from dotenv import load_dotenv
from pymongo import MongoClient

BACKEND = Path(__file__).parent
EXCEL = BACKEND / "Limpia de carros GTS (1).xlsx"
APPLY = "--apply" in sys.argv

load_dotenv(BACKEND / ".env")
MONGO_URL = os.environ.get("MONGO_URL") or os.environ.get("MONGODB_URL")
if not MONGO_URL:
    raise SystemExit("Falta MONGO_URL / MONGODB_URL en .env")

db = MongoClient(MONGO_URL, serverSelectionTimeoutMS=20000)["mos-system"]
inv, boxes, tickets = db["wms_inventory"], db["wms_boxes"], db["wms_pick_tickets"]

BATCH = f"gtsclean_{uuid.uuid4().hex[:8]}"
STAMP = datetime.now(timezone.utc).isoformat()
ACTOR = {"user_id": "system_gts_cleanup", "name": "Limpieza carros GTS (auditoria)"}

def norm(v):
    return "" if v is None else str(v).upper().strip()

def log(msg=""):
    print(msg, flush=True)

log("=" * 70)
log(f"LIMPIEZA DE CARROS GTS   batch={BATCH}")
log(f"MODO: {'APLICAR (escribe en la base)' if APPLY else 'SIMULACION (no escribe nada)'}")
log("=" * 70)

# ---------------------------------------------------------------- 1. Excel
wb = openpyxl.load_workbook(EXCEL, data_only=True)
rows = [r for r in list(wb["Sheet1"].iter_rows(values_only=True))[1:] if any(c is not None for c in r)]

excel = collections.defaultdict(lambda: {"qty": 0, "rows": []})
for i, r in enumerate(rows, start=2):
    customer, style, color, size, loc, onhand, coo, fabric = r
    if onhand is None or int(onhand) >= 0:
        raise SystemExit(f"Fila {i}: se esperaba cantidad negativa, llego {onhand!r}. Abortado.")
    k = (norm(customer), norm(style), norm(color), norm(size), norm(loc))
    excel[k]["qty"] += abs(int(onhand))
    excel[k]["rows"].append(i)

log(f"\nExcel: {len(rows)} filas -> {len(excel)} claves unicas, "
    f"{sum(v['qty'] for v in excel.values())} unidades")

# ------------------------------------------------- 2. Resolver y validar
def resolve(k, expected):
    """Devuelve (docs, motivo_de_omision). Solo se limpia si cuadra EXACTO.

    Ese requisito de igualdad exacta es la proteccion: si alguien ya limpio la
    clave a mano, si entro material nuevo, o si un picker descargo unidades, el
    total deja de coincidir con el Excel y la clave se omite sola.
    """
    customer, style, color, size, loc = k
    q = {"customer": customer, "style": style, "color": color, "location": loc}
    if size:
        q["size"] = size
    docs = list(inv.find(q))
    total = sum(int(d.get("units_on_hand") or 0) for d in docs)
    alloc = sum(int(d.get("units_allocated") or 0) for d in docs)
    if not docs:
        return [], ("SIN_MATCH", expected, 0)
    if total == 0:
        return [], ("YA_LIMPIO", expected, 0)
    if total != expected:
        return [], ("CAMBIO", expected, total)
    if alloc > 0:
        return [], ("CON_ALLOCADO", expected, alloc)
    return docs, None

targets, skipped = [], []
for k, info in excel.items():
    docs, why = resolve(k, info["qty"])
    if why:
        skipped.append((k, *why))
    else:
        targets.append({"key": k, "qty": info["qty"], "docs": docs})

log(f"\nClaves que cuadran y se limpian: {len(targets)}")
if skipped:
    log(f"Claves OMITIDAS (no cuadran, se respetan): {len(skipped)}")
    for k, why, a, b in skipped:
        log(f"  [{why}] {k}  excel={a}  bd={b}")

# Guardia de cordura: si casi nada cuadra, algo sistemico esta mal.
if len(targets) < len(excel) * 0.5:
    log("\n*** SE ABORTA: menos de la mitad de las claves cuadran. "
        "Revisar antes de continuar. ***")
    raise SystemExit(1)
if not targets:
    log("\nNada que limpiar.")
    raise SystemExit(0)

target_docs = [d for t in targets for d in t["docs"]]
target_oids = [d["_id"] for d in target_docs]
inv_units = sum(int(d.get("units_on_hand") or 0) for d in target_docs)
locs = sorted({str(d.get("location") or "") for d in target_docs})
log(f"Validacion OK: {len(target_docs)} registros de inventario, {inv_units} unidades, "
    f"{len(locs)} ubicaciones")

# ------------------------------------------------------------- 3. Cajas
keys = {(norm(d.get("customer")), norm(d.get("style")), norm(d.get("color")),
         norm(d.get("size")), norm(d.get("location"))) for d in target_docs}

def bkey(b):
    return (norm(b.get("customer")), norm(b.get("style")), norm(b.get("color")),
            norm(b.get("size")), norm(b.get("location")))

all_in_locs = list(boxes.find({"location": {"$in": locs}}))
to_deplete = [b for b in all_in_locs
              if bkey(b) in keys and str(b.get("status")) != "depleted"]
untouched = [b for b in all_in_locs if bkey(b) not in keys]
box_units = sum(int(b.get("units") or 0) for b in to_deplete)

log(f"Cajas a agotar: {len(to_deplete)} ({box_units} u.)   "
    f"Cajas intactas de otros SKU: {len(untouched)}")

# Inventario de esas ubicaciones que NO se toca
keep = list(inv.find({"location": {"$in": locs}, "_id": {"$nin": target_oids},
                      "units_on_hand": {"$gt": 0}}))
log(f"Inventario que se respeta en esos carros: {len(keep)} registros, "
    f"{sum(int(d.get('units_on_hand') or 0) for d in keep)} unidades")

# Tickets que apuntan a estos carros (solo informativo)
def ticket_locs(t):
    out = set()
    for sz, v in (t.get("size_locations") or {}).items():
        for entry in (v.get("locations") or []) if isinstance(v, dict) else []:
            if isinstance(entry, dict) and entry.get("location"):
                out.add(norm(entry["location"]))
    return out

styles = {norm(d.get("style")) for d in target_docs}
locset = set(locs)
affected_tickets = [
    {"ticket_id": t.get("ticket_id"), "order_number": t.get("order_number"),
     "status": t.get("status"), "picking_status": t.get("picking_status"),
     "customer": t.get("customer"), "style": t.get("style"), "color": t.get("color"),
     "locations": sorted(ticket_locs(t) & locset)}
    for t in tickets.find({"status": {"$nin": ["completed", "cancelled", "billed", "closed"]}})
    if (ticket_locs(t) & locset) and str(t.get("picking_status")) != "completed"
    and norm(t.get("style")) in styles
]
log(f"Pick tickets pendientes que apuntan a estos carros: {len(affected_tickets)} (NO se modifican)")

if not APPLY:
    log("\n" + "=" * 70)
    log("SIMULACION — no se escribio nada. Ejecuta con --apply para aplicar.")
    log("=" * 70)
    raise SystemExit(0)

# --------------------------------------------- 4. REVALIDACION EN CALIENTE
# El almacen opera mientras corre esto. Volvemos a leer cada clave justo antes
# de escribir; lo que cambio en el intervalo se descarta.
log("\n[0/4] Revalidando contra la base (el almacen esta operando)...")
revalidated, late_skips = [], []
for t in targets:
    docs, why = resolve(t["key"], t["qty"])
    if why:
        late_skips.append((t["key"], *why))
    else:
        revalidated.append({**t, "docs": docs})

if late_skips:
    log(f"  cambiaron durante el analisis, se omiten: {len(late_skips)}")
    for k, why, a, b in late_skips:
        log(f"    [{why}] {k}  excel={a}  bd={b}")
skipped.extend(late_skips)
targets = revalidated

if not targets:
    log("\nNada que limpiar tras revalidar.")
    raise SystemExit(0)

target_docs = [d for t in targets for d in t["docs"]]
target_oids = [d["_id"] for d in target_docs]
inv_units = sum(int(d.get("units_on_hand") or 0) for d in target_docs)
locs = sorted({str(d.get("location") or "") for d in target_docs})
all_in_locs = list(boxes.find({"location": {"$in": locs}}))
keys = {(norm(d.get("customer")), norm(d.get("style")), norm(d.get("color")),
         norm(d.get("size")), norm(d.get("location"))) for d in target_docs}
to_deplete = [b for b in all_in_locs
              if bkey(b) in keys and str(b.get("status")) != "depleted"]
box_units = sum(int(b.get("units") or 0) for b in to_deplete)
keep = list(inv.find({"location": {"$in": locs}, "_id": {"$nin": target_oids},
                      "units_on_hand": {"$gt": 0}}))
log(f"  confirmado: {len(target_docs)} registros, {inv_units} u., "
    f"{len(to_deplete)} cajas")

# ------------------------------------------------------------ 5. Respaldo
log("\n[1/4] Respaldando...")
bak_inv, bak_box = f"wms_inventory_bak_{BATCH}", f"wms_boxes_bak_{BATCH}"
if target_docs:
    db[bak_inv].insert_many([dict(d, _bak_batch=BATCH, _bak_at=STAMP) for d in target_docs])
if to_deplete:
    db[bak_box].insert_many([dict(b, _bak_batch=BATCH, _bak_at=STAMP) for b in to_deplete])
log(f"  {bak_inv}: {len(target_docs)} docs")
log(f"  {bak_box}: {len(to_deplete)} docs")

# -------------------------------------------------- 5. Inventario a cero
log("\n[2/4] Poniendo inventario en cero...")
res_inv = inv.update_many(
    {"_id": {"$in": target_oids}},
    {"$set": {"units_on_hand": 0, "units_allocated": 0, "total_boxes": 0,
              "updated_at": STAMP, "gts_cleanup_batch": BATCH,
              "gts_cleanup_reason": "Auditoria fisica: material inexistente en carro"}},
)
log(f"  registros actualizados: {res_inv.modified_count}/{len(target_oids)}")

# ------------------------------------------------------ 6. Agotar cajas
log("\n[3/4] Agotando cajas...")
res_box = boxes.update_many(
    {"box_id": {"$in": [b.get("box_id") for b in to_deplete]}},
    {"$set": {"units": 0, "qty": 0, "status": "depleted", "updated_at": STAMP,
              "updated_by": ACTOR["user_id"], "gts_cleanup_batch": BATCH},
     "$unset": {"recon_pending": ""}},
)
log(f"  cajas agotadas: {res_box.modified_count}/{len(to_deplete)}")

# ---------------------------------------------------------- 7. Registro
log("\n[4/4] Escribiendo bitacora...")
db["wms_movements"].insert_many([{
    "movement_id": f"mov_{uuid.uuid4().hex[:12]}",
    "type": "gts_cart_cleanup",
    "details": {
        "sku": d.get("sku") or d.get("style"), "style": d.get("style"),
        "color": d.get("color"), "size": d.get("size"),
        "location": d.get("location"), "customer": d.get("customer"),
        "old_units": int(d.get("units_on_hand") or 0), "new_units": 0,
        "delta_units": -int(d.get("units_on_hand") or 0),
        "via": "gts_cart_cleanup", "batch": BATCH,
        "reason": "Auditoria fisica: material inexistente en carro",
    },
    "user_id": ACTOR["user_id"], "user_name": ACTOR["name"], "created_at": STAMP,
} for d in target_docs])
log(f"  wms_movements: {len(target_docs)} movimientos")

db["wms_recon_adjustments"].insert_one({
    "type": "gts_cart_cleanup", "batch": BATCH,
    "created_at": STAMP, "created_by": ACTOR["name"],
    "count": len(locs), "units": inv_units,
    "reason": ("Limpieza de carros GTS. Auditoria fisica confirmo que el material "
               "no existe. Origen: 'Limpia de carros GTS (1).xlsx' (201 filas)."),
    "locations": [{"location": loc,
                   "unidades": sum(int(d.get("units_on_hand") or 0)
                                   for d in target_docs if d.get("location") == loc),
                   "registros": sum(1 for d in target_docs if d.get("location") == loc)}
                  for loc in locs],
    "boxes": [b.get("box_id") for b in to_deplete],
})

db["wms_gtsclean_manifest"].insert_one({
    "batch": BATCH, "created_at": STAMP, "created_by": ACTOR["name"],
    "source_file": EXCEL.name,
    "excel_rows": len(rows), "excel_keys": len(excel),
    "inventory_docs": len(target_docs), "inventory_units": inv_units,
    "boxes_depleted": len(to_deplete), "box_units": box_units,
    "locations": locs,
    "backup_inventory": bak_inv, "backup_boxes": bak_box,
    "inventory_ids": [d.get("inventory_id") for d in target_docs],
    "box_ids": [b.get("box_id") for b in to_deplete],
    "untouched_inventory_in_locations": len(keep),
    "untouched_units_in_locations": sum(int(d.get("units_on_hand") or 0) for d in keep),
    "pending_tickets_pointing_here": affected_tickets,
    "skipped_keys": [{"customer": k[0], "style": k[1], "color": k[2], "size": k[3],
                      "location": k[4], "motivo": why, "excel": a, "bd": b}
                     for k, why, a, b in skipped],
})
log(f"  wms_recon_adjustments + wms_gtsclean_manifest: ok")

# ------------------------------------------------------- 8. Verificacion
log("\n" + "=" * 70)
log("VERIFICACION")
left = inv.count_documents({"_id": {"$in": target_oids}, "units_on_hand": {"$ne": 0}})
box_left = boxes.count_documents({"box_id": {"$in": [b.get("box_id") for b in to_deplete]},
                                  "status": {"$ne": "depleted"}})
keep_now = sum(int(d.get("units_on_hand") or 0)
               for d in inv.find({"location": {"$in": locs}, "_id": {"$nin": target_oids}}))
log(f"  registros objetivo con saldo != 0 : {left}      (esperado 0)")
log(f"  cajas objetivo sin agotar         : {box_left}      (esperado 0)")
log(f"  unidades intactas en esos carros  : {keep_now}  (antes: "
    f"{sum(int(d.get('units_on_hand') or 0) for d in keep)})")
log(f"  batch: {BATCH}")
log(f"  reversible desde: {bak_inv} / {bak_box}")
log("=" * 70)
log("OK" if left == 0 and box_left == 0 else "*** REVISAR: quedaron pendientes ***")
