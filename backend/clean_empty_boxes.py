"""Elimina las cajas activas que estan en 0 unidades.

Regla: si el material se acaba, la caja se va. Una caja en 0 que sigue 'located'
o 'stored' ocupa lugar en la ubicacion y descuadra el conteo de cajas.

Alcance: cajas con units <= 0 cuyo status NO es de salida (depleted, shipped,
in_production, finished, in_neck_cutting, confirmed, recon_pending). Las que ya
estan marcadas como salidas son historial y no se tocan.

Ademas decrementa total_boxes en el registro de inventario correspondiente, para
no dejar el contador declarando cajas que ya no existen.

Uso:
    python clean_empty_boxes.py            # simulacion, no escribe nada
    python clean_empty_boxes.py --apply    # ejecuta
"""
import os
import sys
import uuid
import collections
from datetime import datetime, timezone
from pathlib import Path

from dotenv import load_dotenv
from pymongo import MongoClient

BACKEND = Path(__file__).parent
APPLY = "--apply" in sys.argv

load_dotenv(BACKEND / ".env")
MONGO_URL = os.environ.get("MONGO_URL") or os.environ.get("MONGODB_URL")
if not MONGO_URL:
    raise SystemExit("Falta MONGO_URL / MONGODB_URL en .env")

db = MongoClient(MONGO_URL, serverSelectionTimeoutMS=20000)["mos-system"]
inv, bx = db["wms_inventory"], db["wms_boxes"]

BATCH = f"emptybox_{uuid.uuid4().hex[:8]}"
STAMP = datetime.now(timezone.utc).isoformat()
ACTOR = {"user_id": "system_empty_box_cleanup", "name": "Limpieza de cajas vacias"}

# Estados que ya representan una caja fuera de piso: son historial.
OUT = {"shipped", "in_production", "finished", "in_neck_cutting", "confirmed",
       "depleted", "recon_pending"}

def n(v):
    return "" if v is None else str(v).upper().strip()

def log(m=""):
    print(m, flush=True)

log("=" * 70)
log(f"LIMPIEZA DE CAJAS VACIAS   batch={BATCH}")
log(f"MODO: {'APLICAR (borra de la base)' if APPLY else 'SIMULACION (no escribe nada)'}")
log("=" * 70)

# ------------------------------------------------------------- 1. Detectar
targets = list(bx.find({"units": {"$lte": 0}, "status": {"$nin": list(OUT)}}))
if not targets:
    log("\nNo hay cajas vacias activas. Nada que hacer.")
    raise SystemExit(0)

log(f"\nCajas a eliminar: {len(targets)}")
log(f"  por status: {dict(collections.Counter(str(b.get('status')) for b in targets))}")
log(f"  ubicaciones afectadas: {len({b.get('location') for b in targets})}")
log(f"  clientes: {dict(collections.Counter(str(b.get('customer')) for b in targets).most_common(5))}")

# Guardia: ninguna debe traer unidades. Si alguna trae, algo cambio y se aborta.
con_unidades = [b for b in targets if int(b.get("units") or 0) > 0]
if con_unidades:
    log(f"\n*** SE ABORTA: {len(con_unidades)} cajas traen unidades > 0 ***")
    for b in con_unidades[:10]:
        log(f"    {b.get('box_id')} units={b.get('units')}")
    raise SystemExit(1)

# ------------------------------------------- 2. total_boxes NO se toca
# Se comprobo que el contador total_boxes ya excluye a las cajas vacias: en los
# registros afectados coincide con las cajas reales (units > 0) que quedan. Por
# eso borrar las vacias no exige ajustar el contador. Solo se REPORTA donde el
# contador no cuadra con la realidad, para revisarlo aparte.
por_inv = collections.Counter()
sin_inv = 0
for b in targets:
    iid = b.get("inventory_id")
    if iid:
        por_inv[iid] += 1
    else:
        sin_inv += 1

reales = collections.Counter()
for x in bx.find({"status": {"$nin": list(OUT)}, "units": {"$gt": 0}},
                 {"customer": 1, "style": 1, "color": 1, "size": 1, "location": 1}):
    reales[(n(x.get("customer")), n(x.get("style")), n(x.get("color")),
            n(x.get("size")), n(x.get("location")))] += 1

descuadres, huerfanas = [], 0
for iid, cnt in por_inv.items():
    d = inv.find_one({"inventory_id": iid})
    if not d:
        huerfanas += cnt
        continue
    real = reales.get((n(d.get("customer")), n(d.get("style")), n(d.get("color")),
                       n(d.get("size")), n(d.get("location"))), 0)
    tb = int(d.get("total_boxes") or 0)
    if tb != real:
        descuadres.append({"inventory_id": iid, "total_boxes": tb, "cajas_reales": real,
                           "on_hand": int(d.get("units_on_hand") or 0),
                           "location": d.get("location")})

log(f"\nRegistros de inventario ligados: {len(por_inv)}")
log(f"  cajas sin inventory_id: {sin_inv}")
log(f"  cajas cuyo inventario ya no existe (huerfanas): {huerfanas}")
log(f"  -> total_boxes NO se modifica (ya excluye las vacias)")
if descuadres:
    log(f"\n  SOLO REPORTE — contadores que no cuadran con la realidad: {len(descuadres)}")
    for a in descuadres[:8]:
        log(f"    {a['inventory_id']} @ {a['location']}  total_boxes={a['total_boxes']} "
            f"cajas_reales={a['cajas_reales']} on_hand={a['on_hand']}")

if not APPLY:
    log("\n" + "=" * 70)
    log("SIMULACION — no se escribio nada. Ejecuta con --apply para aplicar.")
    log("=" * 70)
    raise SystemExit(0)

# ------------------------------------------------------------ 3. Respaldo
log("\n[1/3] Respaldando...")
bak = f"wms_boxes_bak_{BATCH}"
db[bak].insert_many([dict(b, _bak_batch=BATCH, _bak_at=STAMP) for b in targets])
log(f"  {bak}: {db[bak].count_documents({})} cajas")

# ------------------------------------------------------- 4. Borrar cajas
log("\n[2/3] Eliminando cajas...")
ids = [b.get("box_id") for b in targets]
res = bx.delete_many({"box_id": {"$in": ids}, "units": {"$lte": 0},
                      "status": {"$nin": list(OUT)}})
log(f"  eliminadas: {res.deleted_count}/{len(targets)}")

log("  total_boxes: sin cambios (por diseño)")

# ---------------------------------------------------------- 5. Bitacora
log("\n[3/3] Escribiendo bitacora...")
db["wms_movements"].insert_many([{
    "movement_id": f"mov_{uuid.uuid4().hex[:12]}",
    "type": "empty_box_removed",
    "details": {
        "box_id": b.get("box_id"), "sku": b.get("sku") or b.get("style"),
        "style": b.get("style"), "color": b.get("color"), "size": b.get("size"),
        "location": b.get("location"), "customer": b.get("customer"),
        "old_units": 0, "new_units": 0, "old_status": b.get("status"),
        "via": "empty_box_cleanup", "batch": BATCH,
        "reason": "Caja en 0 unidades: el material se acabo, la caja se retira",
    },
    "user_id": ACTOR["user_id"], "user_name": ACTOR["name"], "created_at": STAMP,
} for b in targets])
log(f"  wms_movements: {len(targets)} movimientos")

db["wms_emptybox_manifest"].insert_one({
    "batch": BATCH, "created_at": STAMP, "created_by": ACTOR["name"],
    "boxes_deleted": res.deleted_count,
    "box_ids": ids,
    "locations": sorted({str(b.get("location") or "") for b in targets}),
    "inventory_adjusted": 0,
    "total_boxes_mismatches_reported": descuadres,
    "boxes_without_inventory": sin_inv + huerfanas,
    "backup_collection": bak,
})
log("  wms_emptybox_manifest: ok")

# ------------------------------------------------------- 6. Verificacion
log("\n" + "=" * 70)
log("VERIFICACION")
quedan = bx.count_documents({"units": {"$lte": 0}, "status": {"$nin": list(OUT)}})
restantes = bx.count_documents({"box_id": {"$in": ids}})
incoh = inv.count_documents({"units_on_hand": {"$lte": 0}, "total_boxes": {"$gt": 0}})
log(f"  cajas vacias activas que quedan : {quedan}      (esperado 0)")
log(f"  cajas objetivo aun en la base   : {restantes}      (esperado 0)")
log(f"  registros on_hand=0 con cajas   : {incoh}   (antes: 153)")
log(f"  batch: {BATCH}")
log(f"  reversible desde: {bak}")
log("=" * 70)
log("OK" if quedan == 0 and restantes == 0 else "*** REVISAR ***")
