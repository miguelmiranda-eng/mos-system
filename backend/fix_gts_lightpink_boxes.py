"""Reactiva 3 cajas GTS TRACTOR FRD0002J1358 LIGHT PINK @ NA01-A30 que quedaron
'depleted' con unidades (mismo bug de adjust_box_count, ya corregido en el
endpoint). El picker excluye las depleted, asi que no las puede surtir.

A diferencia de BOX-016944/016939, estas SI tienen inventario de respaldo: se
verifico que units_on_hand YA incluye las unidades de estas cajas, asi que
reactivar el status NO agrega stock (no doble-cuenta). Solo:
  1. status depleted -> located (pickeable).
  2. religar la caja a un inventory_id VALIDO de su SKU (el que tienen apunta a
     una fila borrada en el caso XL).
NO se toca units_on_hand.

Uso:
    python fix_gts_lightpink_boxes.py            # simulacion
    python fix_gts_lightpink_boxes.py --apply    # ejecuta
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

BATCH = f"lpfix_{uuid.uuid4().hex[:8]}"
STAMP = datetime.now(timezone.utc).isoformat()
ACTOR = {"user_id": "system_lpfix", "name": "Reactivacion cajas LIGHT PINK depleted"}
BOX_IDS = ["BOX-025748", "BOX-025756", "BOX-025760"]
OUT = {"shipped", "in_production", "finished", "in_neck_cutting", "confirmed",
       "depleted", "recon_pending"}

def n(v): return "" if v is None else str(v).upper().strip()
def log(m=""): print(m, flush=True)

log("=" * 70)
log(f"REACTIVACION cajas LIGHT PINK   batch={BATCH}")
log(f"MODO: {'APLICAR' if APPLY else 'SIMULACION (no escribe nada)'}")
log("=" * 70)

docs = list(boxes.find({"box_id": {"$in": BOX_IDS}}))
if len(docs) != len(BOX_IDS):
    raise SystemExit(f"Se esperaban {len(BOX_IDS)} cajas, hay {len(docs)}. Abortado.")

plan, problems = [], []
for b in docs:
    u = int(b.get("units") or 0)
    if u <= 0 or b.get("status") != "depleted":
        problems.append(f"{b['box_id']}: cambio (units={u}, status={b.get('status')})")
        continue
    q = {"style": b.get("style"), "color": b.get("color"),
         "size": b.get("size"), "location": b.get("location")}
    # cajas activas del mismo SKU/loc (para el chequeo de doble-conteo)
    active_u = sum(int(x.get("units") or 0) for x in boxes.find(q)
                   if str(x.get("status")) not in OUT and int(x.get("units") or 0) > 0)
    # inventarios validos del SKU/loc, mayor primero
    invs = sorted(inv.find(q), key=lambda d: -int(d.get("units_on_hand") or 0))
    invs = [d for d in invs if int(d.get("units_on_hand") or 0) > 0]
    if not invs:
        problems.append(f"{b['box_id']}: sin inventario de respaldo — usar el otro flujo (crear inv)")
        continue
    target = invs[0]
    oh = int(target.get("units_on_hand") or 0)
    # Chequeo de doble-conteo: el inventario debe YA incluir esta caja.
    includes = oh >= active_u + u
    plan.append({"box": b, "inv_id": target.get("inventory_id"), "oh": oh,
                 "active_u": active_u, "u": u, "includes": includes,
                 "dup_invs": [d.get("inventory_id") for d in invs[1:]]})

if problems:
    log("\n*** Filas con problema (se omiten) ***")
    for p in problems:
        log(f"  - {p}")
if not plan:
    log("\nNada que reactivar.")
    raise SystemExit(1 if problems else 0)

log(f"\nCajas a reactivar: {len(plan)}")
for p in plan:
    b = p["box"]
    flag = "" if p["includes"] else "  <<< OJO: inventario NO incluye esta caja (no se reactiva)"
    log(f"  {b['box_id']} {n(b.get('size'))}: {p['u']}u -> inv {p['inv_id']} "
        f"(on_hand={p['oh']}, activas={p['active_u']}) {'ya incluida' if p['includes'] else 'NO incluida'}{flag}")
    if p["dup_invs"]:
        log(f"      duplicado de inventario detectado (no se toca): {p['dup_invs']}")

# Seguridad: solo reactivar las que el inventario YA incluye (sin doble-conteo).
plan = [p for p in plan if p["includes"]]
if not plan:
    log("\nNinguna caja cumple el chequeo de doble-conteo. Abortado.")
    raise SystemExit(1)

if not APPLY:
    log("\n" + "=" * 70)
    log("SIMULACION — no se escribio nada. Ejecuta con --apply.")
    log("=" * 70)
    raise SystemExit(0)

# ---- Respaldo ----
log("\n[1/3] Respaldando...")
bak = f"wms_boxes_bak_{BATCH}"
db[bak].insert_many([dict(p["box"], _bak_batch=BATCH, _bak_at=STAMP) for p in plan])
log(f"  {bak}: {len(plan)} cajas")

# ---- Reactivar + religar ----
log("\n[2/3] Reactivando (depleted -> located) + religando inventario...")
done = 0
for p in plan:
    r = boxes.update_one(
        {"box_id": p["box"]["box_id"], "status": "depleted", "units": {"$gt": 0}},
        {"$set": {"status": "located", "inventory_id": p["inv_id"],
                  "updated_at": STAMP, "updated_by": ACTOR["user_id"],
                  "lpfix_batch": BATCH}},
    )
    done += r.modified_count
log(f"  reactivadas: {done}/{len(plan)}")

# ---- Bitacora ----
log("\n[3/3] Bitacora...")
db["wms_movements"].insert_many([{
    "movement_id": f"mov_{uuid.uuid4().hex[:12]}",
    "type": "box_reactivated",
    "details": {
        "box_id": p["box"]["box_id"], "sku": p["box"].get("sku"),
        "size": p["box"].get("size"), "location": p["box"].get("location"),
        "units": p["u"], "from_status": "depleted", "to_status": "located",
        "relinked_inventory": p["inv_id"], "batch": BATCH,
        "reason": "Caja con unidades quedo depleted; inventario ya la contaba. "
                  "Reactivada para que el picker la vea (sin tocar on_hand).",
    },
    "user_id": ACTOR["user_id"], "user_name": ACTOR["name"], "created_at": STAMP,
} for p in plan])
log(f"  wms_movements: {len(plan)} eventos")

# ---- Verificacion ----
log("\n" + "=" * 70)
log("VERIFICACION")
still = boxes.count_documents({"box_id": {"$in": [p["box"]["box_id"] for p in plan]},
                              "status": "depleted"})
active = boxes.count_documents({"box_id": {"$in": [p["box"]["box_id"] for p in plan]},
                               "status": "located", "units": {"$gt": 0}})
log(f"  aun depleted: {still}  (esperado 0)")
log(f"  located con unidades: {active}  (esperado {len(plan)})")
log(f"  batch: {BATCH}   respaldo: {bak}")
dups = [d for p in plan for d in p["dup_invs"]]
if dups:
    log(f"  NOTA: inventario duplicado sin tocar (revisar aparte): {dups}")
log("=" * 70)
log("OK" if still == 0 and active == len(plan) else "*** REVISAR ***")
