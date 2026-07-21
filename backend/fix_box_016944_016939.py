"""Repara BOX-016944 y BOX-016939: el contador les dio unidades pero quedaron
'depleted' y sin fila de inventario, asi que el picker marca "sin stock".

Causa raiz: adjust_box_count no recreaba el inventario borrado ni reactivaba el
status. Eso ya se corrigio en el endpoint; este script repara el caso que ya
quedo roto en produccion.

Que hace (solo estas 2 cajas):
  1. Reactiva las cajas: status depleted -> located (pickeable).
  2. Recrea la fila wms_inventory 5000/WHITE/L @ PS04-A05 con las unidades
     reales (70 + 72 = 142), ligada por inventory_id.
  3. Respaldo + bitacora + verificacion.

Uso:
    python fix_box_016944_016939.py            # simulacion
    python fix_box_016944_016939.py --apply    # ejecuta
"""
import os
import sys
import uuid
from datetime import datetime, timezone
from pathlib import Path

from dotenv import load_dotenv
from pymongo import MongoClient

BACKEND = Path(__file__).parent
APPLY = "--apply" in sys.argv
load_dotenv(BACKEND / ".env")
db = MongoClient(os.environ["MONGODB_URL"], serverSelectionTimeoutMS=20000)["mos-system"]
inv, boxes = db["wms_inventory"], db["wms_boxes"]

BATCH = f"boxfix_{uuid.uuid4().hex[:8]}"
STAMP = datetime.now(timezone.utc).isoformat()
ACTOR = {"user_id": "system_boxfix", "name": "Reparacion cajas depleted con unidades"}

BOX_IDS = ["BOX-016944", "BOX-016939"]
INV_ID = "inv_9d180741c471"   # el inventory_id que las cajas ya tienen (borrado)

def log(m=""):
    print(m, flush=True)

log("=" * 68)
log(f"REPARACION {', '.join(BOX_IDS)}   batch={BATCH}")
log(f"MODO: {'APLICAR' if APPLY else 'SIMULACION (no escribe nada)'}")
log("=" * 68)

# ---- Revalidacion: el estado debe ser el diagnosticado ----
docs = list(boxes.find({"box_id": {"$in": BOX_IDS}}))
if len(docs) != 2:
    raise SystemExit(f"Se esperaban 2 cajas, se encontraron {len(docs)}. Abortado.")

problems = []
for b in docs:
    u = int(b.get("units") or 0)
    if u <= 0:
        problems.append(f"{b['box_id']} ya no tiene unidades (units={u})")
    if b.get("status") != "depleted":
        problems.append(f"{b['box_id']} ya no esta 'depleted' (status={b.get('status')})")
    key = (b.get("customer"), b.get("style"), b.get("color"), b.get("size"), b.get("location"))
    if key != ("GOODIE TWO SLEEVES", "5000", "WHITE", "L", "PS04-A05"):
        problems.append(f"{b['box_id']} no coincide con el SKU/ubicacion esperado: {key}")

existing_inv = inv.find_one({"customer": "GOODIE TWO SLEEVES", "style": "5000",
                             "color": "WHITE", "size": "L", "location": "PS04-A05"})
if existing_inv:
    problems.append(f"Ya existe inventario para el SKU (units_on_hand="
                    f"{existing_inv.get('units_on_hand')}). Revisar a mano.")

if problems:
    log("\n*** SE ABORTA: el estado cambio desde el diagnostico ***")
    for p in problems:
        log(f"  - {p}")
    raise SystemExit(1)

total_units = sum(int(b.get("units") or 0) for b in docs)
log(f"\nCajas: {[f'''{b['box_id']}={b.get('units')}u''' for b in docs]}")
log(f"Unidades totales a restaurar en inventario: {total_units}")
log(f"Inventario 5000/WHITE/L @ PS04-A05: NO existe -> se creara con {total_units} u.")
log("Status de las cajas: depleted -> located")

if not APPLY:
    log("\n" + "=" * 68)
    log("SIMULACION — no se escribio nada. Ejecuta con --apply.")
    log("=" * 68)
    raise SystemExit(0)

# ---- Respaldo ----
log("\n[1/4] Respaldando cajas...")
bak = f"wms_boxes_bak_{BATCH}"
db[bak].insert_many([dict(b, _bak_batch=BATCH, _bak_at=STAMP) for b in docs])
log(f"  {bak}: {len(docs)} cajas")

# ---- Recrear inventario ----
log("\n[2/4] Creando fila de inventario...")
sample = docs[0]
inv.insert_one({
    "inventory_id": INV_ID,
    "sku": sample.get("sku") or "5000-WHITE-L",
    "style": sample.get("style") or "5000",
    "color": "WHITE", "size": "L", "location": "PS04-A05",
    "customer": "GOODIE TWO SLEEVES",
    "manufacturer": sample.get("manufacturer", ""),
    "description": sample.get("description", ""),
    "country_of_origin": sample.get("country_of_origin", ""),
    "fabric_content": sample.get("fabric_content", ""),
    "is_bpo": sample.get("is_bpo", False),
    "units_on_hand": total_units, "units_allocated": 0, "total_boxes": len(docs),
    "updated_at": STAMP,
    "restored_by_batch": BATCH,
})
log(f"  inventario {INV_ID}: units_on_hand={total_units}, total_boxes={len(docs)}")

# ---- Reactivar cajas ----
log("\n[3/4] Reactivando cajas (depleted -> located)...")
res = boxes.update_many(
    {"box_id": {"$in": BOX_IDS}, "status": "depleted", "units": {"$gt": 0}},
    {"$set": {"status": "located", "inventory_id": INV_ID,
              "updated_at": STAMP, "updated_by": ACTOR["user_id"],
              "boxfix_batch": BATCH}},
)
log(f"  cajas reactivadas: {res.modified_count}/{len(BOX_IDS)}")

# ---- Bitacora ----
log("\n[4/4] Bitacora...")
db["wms_movements"].insert_many([{
    "movement_id": f"mov_{uuid.uuid4().hex[:12]}",
    "type": "box_reactivated",
    "details": {
        "box_id": b["box_id"], "sku": b.get("sku"), "color": b.get("color"),
        "size": b.get("size"), "location": b.get("location"),
        "units": int(b.get("units") or 0),
        "from_status": "depleted", "to_status": "located",
        "inventory_restored": INV_ID, "batch": BATCH,
        "reason": "Caja con unidades quedo depleted + inventario borrado; "
                  "el picker marcaba sin stock. Reactivada y stock recreado.",
    },
    "user_id": ACTOR["user_id"], "user_name": ACTOR["name"], "created_at": STAMP,
} for b in docs])
log(f"  wms_movements: {len(docs)} eventos")

# ---- Verificacion ----
log("\n" + "=" * 68)
log("VERIFICACION")
d = inv.find_one({"inventory_id": INV_ID})
log(f"  inventario units_on_hand: {d.get('units_on_hand') if d else 'NO EXISTE'}  (esperado {total_units})")
still_dep = boxes.count_documents({"box_id": {"$in": BOX_IDS}, "status": "depleted"})
active = boxes.count_documents({"box_id": {"$in": BOX_IDS}, "status": "located", "units": {"$gt": 0}})
log(f"  cajas aun depleted: {still_dep}  (esperado 0)")
log(f"  cajas located con unidades: {active}  (esperado {len(BOX_IDS)})")
log(f"  batch: {BATCH}   respaldo: {bak}")
log("=" * 68)
ok = d and d.get("units_on_hand") == total_units and still_dep == 0 and active == len(BOX_IDS)
log("OK — el picker ya puede surtir estas cajas" if ok else "*** REVISAR ***")
