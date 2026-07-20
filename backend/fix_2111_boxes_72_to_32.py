"""Corrige el empaque de las cajas 2111 de GOODIE TWO SLEEVES: 72 -> 32 unidades.

Motivo: se recibieron con un empaque equivocado. El empaque correcto de este
estilo es 32 (ya hay 1,271 cajas asi); las de 72 son el error.

Alcance ESTRICTO: solo cajas con units == 72 exactamente, style '2111',
customer 'GOODIE TWO SLEEVES'. Cualquier otra cantidad no se toca.

El inventario baja en consecuencia (40 por caja) porque units_on_hand hoy si
cuenta esas cajas a 72 — verificado. Las cajas en estado de salida
(recon_pending) se corrigen igual pero NO mueven inventario, porque ya estaban
excluidas del saldo.

Uso:
    python fix_2111_boxes_72_to_32.py            # simulacion
    python fix_2111_boxes_72_to_32.py --apply    # ejecuta
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

CUSTOMER, STYLE = "GOODIE TWO SLEEVES", "2111"
DE, A = 72, 32
DELTA = DE - A  # 40 por caja

BATCH = f"pack2111_{uuid.uuid4().hex[:8]}"
STAMP = datetime.now(timezone.utc).isoformat()
ACTOR = {"user_id": "system_pack_fix", "name": "Correccion empaque 2111 (72->32)"}
OUT = {"shipped", "in_production", "finished", "in_neck_cutting", "confirmed",
       "depleted", "recon_pending"}

def n(v):
    return "" if v is None else str(v).upper().strip()

def log(m=""):
    print(m, flush=True)

log("=" * 70)
log(f"EMPAQUE 2111: {DE} -> {A} unidades   batch={BATCH}")
log(f"MODO: {'APLICAR (escribe en la base)' if APPLY else 'SIMULACION (no escribe nada)'}")
log("=" * 70)

# --------------------------------------------------------- 1. Seleccion
targets = list(bx.find({"customer": CUSTOMER, "style": STYLE, "units": DE}))
if not targets:
    log("\nNo hay cajas en 72. Nada que hacer.")
    raise SystemExit(0)

# Guardia dura: ni una sola caja fuera del criterio exacto.
malas = [b for b in targets
         if int(b.get("units") or 0) != DE
         or n(b.get("style")) != STYLE
         or n(b.get("customer")) != CUSTOMER]
if malas:
    log(f"\n*** SE ABORTA: {len(malas)} cajas no cumplen el criterio exacto ***")
    raise SystemExit(1)

activas = [b for b in targets if str(b.get("status")) not in OUT]
fuera = [b for b in targets if str(b.get("status")) in OUT]

log(f"\nCajas en {DE}: {len(targets)}")
log(f"  activas (mueven inventario): {len(activas)}")
log(f"  en estado de salida (no mueven inventario): {len(fuera)}")
log(f"  por status: {dict(collections.Counter(str(b.get('status')) for b in targets))}")
log(f"  unidades: {len(targets)*DE} -> {len(targets)*A}")

# --------------------------------------------------- 2. Impacto inventario
impacto = collections.defaultdict(int)
for b in activas:
    impacto[(n(b.get("customer")), n(b.get("style")), n(b.get("color")),
             n(b.get("size")), n(b.get("location")))] += DELTA

log(f"\nInventario: {len(impacto)} claves, baja total {sum(impacto.values())} u.")
plan, problemas = [], []
for k, baja in sorted(impacto.items()):
    c, s, col, sz, loc = k
    q = {"customer": c, "style": s, "color": col, "size": sz, "location": loc}
    docs = list(inv.find(q))
    oh = sum(int(d.get("units_on_hand") or 0) for d in docs)
    if not docs:
        problemas.append((k, "SIN_REGISTRO", oh, baja)); continue
    if oh - baja < 0:
        problemas.append((k, "QUEDARIA_NEGATIVO", oh, baja)); continue
    if len(docs) > 1:
        problemas.append((k, "REGISTRO_DUPLICADO", oh, baja)); continue
    plan.append({"key": k, "_id": docs[0]["_id"], "antes": oh, "baja": baja,
                 "despues": oh - baja})
    log(f"  {col}/{sz} @ {loc:14} {oh:>6} - {baja:>4} = {oh-baja:>6}")

if problemas:
    log(f"\n*** SE ABORTA: {len(problemas)} claves con problema ***")
    for k, why, oh, baja in problemas:
        log(f"    [{why}] {k} on_hand={oh} baja={baja}")
    raise SystemExit(1)

if not APPLY:
    log("\n" + "=" * 70)
    log("SIMULACION — no se escribio nada. Ejecuta con --apply para aplicar.")
    log("=" * 70)
    raise SystemExit(0)

# ------------------------------------------------------------ 3. Respaldo
log("\n[1/4] Respaldando...")
bak_b, bak_i = f"wms_boxes_bak_{BATCH}", f"wms_inventory_bak_{BATCH}"
db[bak_b].insert_many([dict(b, _bak_batch=BATCH, _bak_at=STAMP) for b in targets])
ids_inv = [p["_id"] for p in plan]
db[bak_i].insert_many([dict(d, _bak_batch=BATCH, _bak_at=STAMP)
                       for d in inv.find({"_id": {"$in": ids_inv}})])
log(f"  {bak_b}: {len(targets)} cajas")
log(f"  {bak_i}: {len(plan)} registros")

# --------------------------------------------------------- 4. Cajas 72->32
log("\n[2/4] Corrigiendo cajas...")
res_b = bx.update_many(
    {"box_id": {"$in": [b.get("box_id") for b in targets]},
     "customer": CUSTOMER, "style": STYLE, "units": DE},
    {"$set": {"units": A, "qty": A, "updated_at": STAMP,
              "updated_by": ACTOR["user_id"], "pack_fix_batch": BATCH}},
)
log(f"  cajas corregidas: {res_b.modified_count}/{len(targets)}")

# ------------------------------------------------------- 5. Inventario
log("\n[3/4] Ajustando inventario...")
ajust = 0
for p in plan:
    r = inv.update_one({"_id": p["_id"], "units_on_hand": p["antes"]},
                       {"$set": {"units_on_hand": p["despues"], "updated_at": STAMP,
                                 "pack_fix_batch": BATCH}})
    ajust += r.modified_count
log(f"  registros ajustados: {ajust}/{len(plan)}")
if ajust != len(plan):
    log("  *** OJO: algun registro cambio entre la lectura y la escritura. Revisar. ***")

# ---------------------------------------------------------- 6. Bitacora
log("\n[4/4] Escribiendo bitacora...")
db["wms_movements"].insert_many([{
    "movement_id": f"mov_{uuid.uuid4().hex[:12]}",
    "type": "box_pack_correction",
    "details": {
        "box_id": b.get("box_id"), "sku": b.get("sku") or b.get("style"),
        "style": b.get("style"), "color": b.get("color"), "size": b.get("size"),
        "location": b.get("location"), "customer": b.get("customer"),
        "old_units": DE, "new_units": A, "delta_units": -DELTA,
        "affects_inventory": str(b.get("status")) not in OUT,
        "via": "pack_fix", "batch": BATCH,
        "reason": f"Empaque incorrecto en recibo: {DE} -> {A} unidades por caja",
    },
    "user_id": ACTOR["user_id"], "user_name": ACTOR["name"], "created_at": STAMP,
} for b in targets])
log(f"  wms_movements: {len(targets)} movimientos")

db["wms_packfix_manifest"].insert_one({
    "batch": BATCH, "created_at": STAMP, "created_by": ACTOR["name"],
    "customer": CUSTOMER, "style": STYLE, "from_units": DE, "to_units": A,
    "boxes_total": len(targets), "boxes_active": len(activas),
    "boxes_out_of_stock_status": len(fuera),
    "box_ids": [b.get("box_id") for b in targets],
    "inventory_keys": len(plan), "inventory_units_removed": sum(p["baja"] for p in plan),
    "adjustments": [{"key": list(p["key"]), "antes": p["antes"],
                     "baja": p["baja"], "despues": p["despues"]} for p in plan],
    "backup_boxes": bak_b, "backup_inventory": bak_i,
})
log("  wms_packfix_manifest: ok")

# ------------------------------------------------------- 7. Verificacion
log("\n" + "=" * 70)
log("VERIFICACION")
quedan = bx.count_documents({"customer": CUSTOMER, "style": STYLE, "units": DE})
en32 = bx.count_documents({"customer": CUSTOMER, "style": STYLE, "units": A})
log(f"  cajas 2111 aun en {DE} : {quedan}      (esperado 0)")
log(f"  cajas 2111 en {A}      : {en32}")
ok = True
for p in plan:
    d = inv.find_one({"_id": p["_id"]}, {"units_on_hand": 1})
    if int(d.get("units_on_hand") or 0) != p["despues"]:
        ok = False
        log(f"  *** {p['key']} esperado {p['despues']} encontrado {d.get('units_on_hand')}")
log(f"  inventario: {'todos los saldos cuadran' if ok else 'HAY DIFERENCIAS'}")
log(f"  unidades retiradas: {sum(p['baja'] for p in plan)}")
log(f"  batch: {BATCH}")
log(f"  reversible desde: {bak_b} / {bak_i}")
log("=" * 70)
log("OK" if quedan == 0 and ok else "*** REVISAR ***")
