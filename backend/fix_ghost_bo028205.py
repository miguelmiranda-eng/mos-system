"""Elimina la caja fantasma BO-028205 en CARRO 265 y limpia los registros de
inventario vacios de ese SKU/ubicacion.

Diagnostico: BO-028205 la creo un contador a mano (manual_inventory_add, 14-jul,
motivo OTRO) con el id mal tecleado ('BO-' en vez de 'BOX-'). El carro 265
estaba FISICAMENTE vacio, asi que nunca hubo caja real detras: es un duplicado
fantasma de la caja real BOX-028205 (que esta bien en NA06-A13). No tiene
inventario de respaldo (inv borrado) ni esta en ningun pick.

Que hace:
  1. Elimina la caja BO-028205.
  2. Elimina los 2 registros wms_inventory 5000/MAROON/XL @ CARRO 265 que estan
     en 0 (residuo/duplicado).
NO toca la caja real BOX-028205 (NA06-A13) ni el resto de CARRO 265.

Uso:
    python fix_ghost_bo028205.py            # simulacion
    python fix_ghost_bo028205.py --apply    # ejecuta
"""
import os
import sys
import json
import uuid
from datetime import datetime, timezone
from pathlib import Path

from dotenv import load_dotenv
from pymongo import MongoClient

BACKEND = Path(__file__).parent
APPLY = "--apply" in sys.argv
load_dotenv(BACKEND / ".env")
db = MongoClient(os.environ["MONGODB_URL"], serverSelectionTimeoutMS=20000)["mos-system"]
inv, boxes, tickets = db["wms_inventory"], db["wms_boxes"], db["wms_pick_tickets"]

BATCH = f"ghostfix_{uuid.uuid4().hex[:8]}"
STAMP = datetime.now(timezone.utc).isoformat()
ACTOR = {"user_id": "system_ghostfix", "name": "Limpieza caja fantasma BO-028205"}
GHOST = "BO-028205"

def log(m=""): print(m, flush=True)

log("=" * 66)
log(f"LIMPIEZA FANTASMA {GHOST} @ CARRO 265   batch={BATCH}")
log(f"MODO: {'APLICAR' if APPLY else 'SIMULACION (no escribe nada)'}")
log("=" * 66)

# ---- Revalidacion de seguridad ----
box = boxes.find_one({"box_id": GHOST})
if not box:
    log(f"\n{GHOST} ya no existe. Nada que hacer.")
    raise SystemExit(0)

problems = []
if box.get("location") != "CARRO 265":
    problems.append(f"{GHOST} ya no esta en CARRO 265 (loc={box.get('location')})")
if int(box.get("units_allocated") or 0) > 0:
    problems.append(f"{GHOST} tiene unidades asignadas (allocated>0)")
open_picks = [t.get("ticket_id") for t in tickets.find(
    {"status": {"$nin": ["completed", "cancelled", "billed", "closed"]}})
    if GHOST in json.dumps(t, default=str)]
if open_picks:
    problems.append(f"{GHOST} esta en pick tickets abiertos: {open_picks[:5]}")

inv_ghosts = list(inv.find({"customer": "GOODIE TWO SLEEVES", "style": "5000",
                            "color": "MAROON", "size": "XL", "location": "CARRO 265"}))
inv_nonzero = [d for d in inv_ghosts if int(d.get("units_on_hand") or 0) != 0
               or int(d.get("units_allocated") or 0) != 0]
if inv_nonzero:
    problems.append(f"Hay inventario MAROON/XL @ CARRO 265 con saldo != 0: "
                    f"{[(d.get('inventory_id'), d.get('units_on_hand')) for d in inv_nonzero]}")
# no debe haber OTRA caja MAROON/XL real en CARRO 265
otras = [b for b in boxes.find({"color": "MAROON", "size": "XL", "location": "CARRO 265"})
         if b.get("box_id") != GHOST]
if otras:
    problems.append(f"Hay otras cajas MAROON/XL en CARRO 265: {[b.get('box_id') for b in otras]}")

if problems:
    log("\n*** SE ABORTA: el estado cambio o no es seguro ***")
    for p in problems:
        log(f"  - {p}")
    raise SystemExit(1)

log(f"\nCaja fantasma a eliminar: {GHOST} ({box.get('sku')}/{box.get('color')}/"
    f"{box.get('size')}, {box.get('units')}u, sin status)")
log(f"Registros de inventario en 0 a limpiar: {len(inv_ghosts)}")
for d in inv_ghosts:
    log(f"  {d.get('inventory_id')} on_hand={d.get('units_on_hand')}")
log("NO se toca: BOX-028205 (caja real en NA06-A13) ni el resto de CARRO 265.")

if not APPLY:
    log("\n" + "=" * 66)
    log("SIMULACION — no se escribio nada. Ejecuta con --apply.")
    log("=" * 66)
    raise SystemExit(0)

# ---- Respaldo ----
log("\n[1/3] Respaldando...")
bak = f"wms_ghostfix_bak_{BATCH}"
db[bak].insert_one({"_type": "box", **{k: v for k, v in box.items() if k != "_id"},
                    "_bak_batch": BATCH, "_bak_at": STAMP})
for d in inv_ghosts:
    db[bak].insert_one({"_type": "inventory", **{k: v for k, v in d.items() if k != "_id"},
                        "_bak_batch": BATCH, "_bak_at": STAMP})
log(f"  {bak}: 1 caja + {len(inv_ghosts)} registros de inventario")

# ---- Eliminar ----
log("\n[2/3] Eliminando...")
rb = boxes.delete_one({"box_id": GHOST, "location": "CARRO 265"})
ri = inv.delete_many({"inventory_id": {"$in": [d.get("inventory_id") for d in inv_ghosts]}})
log(f"  caja eliminada: {rb.deleted_count}")
log(f"  registros de inventario eliminados: {ri.deleted_count}")

# ---- Bitacora ----
log("\n[3/3] Bitacora...")
db["wms_movements"].insert_one({
    "movement_id": f"mov_{uuid.uuid4().hex[:12]}",
    "type": "ghost_box_removed",
    "details": {
        "box_id": GHOST, "sku": box.get("sku"), "color": box.get("color"),
        "size": box.get("size"), "units": int(box.get("units") or 0),
        "location": "CARRO 265", "batch": BATCH,
        "inventory_rows_removed": [d.get("inventory_id") for d in inv_ghosts],
        "reason": "Caja fantasma por captura manual con id mal tecleado (BO- en "
                  "vez de BOX-). Carro fisicamente vacio; duplicado de BOX-028205 "
                  "(caja real en NA06-A13). Sin respaldo de inventario ni pick.",
    },
    "user_id": ACTOR["user_id"], "user_name": ACTOR["name"], "created_at": STAMP,
})
log("  wms_movements: 1 evento")

# ---- Verificacion ----
log("\n" + "=" * 66)
log("VERIFICACION")
log(f"  {GHOST} existe todavia: {boxes.count_documents({'box_id': GHOST})}  (esperado 0)")
log(f"  inventario MAROON/XL @ CARRO 265: "
    f"{inv.count_documents({'style':'5000','color':'MAROON','size':'XL','location':'CARRO 265'})}  (esperado 0)")
real = boxes.find_one({"box_id": "BOX-028205"})
log(f"  BOX-028205 (real) intacta en: {real.get('location') if real else 'NO EXISTE'}  (esperado NA06-A13)")
log(f"  batch: {BATCH}   respaldo: {bak}")
log("=" * 66)
log("OK")
