"""Limpieza de ubicaciones LIF08-LIF11 (packing lists PL#17-PL#20).

Auditoria fisica confirmo que el material no existe. Fuentes:
  PL#17 - LIF08.xlsx, PL#18 - LIF09.xlsx, PL#19 - LIF10.xlsx, PL#20 - LIF11.xlsx
Cada fila trae On Hand negativo = ajuste a eliminar.

Mismo criterio que la limpieza GTS (clean_gts_carros.py):
  - Respaldo antes de tocar nada, bitacora en wms_movements + manifiesto.
  - Revalidacion en caliente: se relee justo antes de escribir; lo que cambio
    en el intervalo se salta.
  - Simulacion por defecto; exige --apply para escribir.

Diferencia con GTS: el nombre del color difiere entre Excel y sistema
(truncado, abreviado 'HTR', orden invertido, ortografia). Se resuelve por
(customer, style, size, location) exigiendo:
  - cantidad del grupo EXACTA a la del Excel, y
  - color >= 0.6 de similitud (normalizando HTR->HEATHER y orden de palabras).
Las cajas se localizan por el color REAL del sistema, no el del Excel.

Descuadres (cantidad no cuadra): se vacia a 0 SOLO si el sistema tiene <= que
el Excel (no queda negativo); si tiene mas, se salta y se reporta.

Uso:
    python clean_lif_carros.py            # simulacion
    python clean_lif_carros.py --apply    # ejecuta
"""
import os
import sys
import uuid
import difflib
import collections
from datetime import datetime, timezone
from pathlib import Path

import openpyxl
from dotenv import load_dotenv
from pymongo import MongoClient

BACKEND = Path(__file__).parent
FILES = ["PL#17 - LIF08.xlsx", "PL#18 - LIF09.xlsx",
         "PL#19 - LIF10.xlsx", "PL#20 - LIF11.xlsx"]
APPLY = "--apply" in sys.argv

load_dotenv(BACKEND / ".env")
MONGO_URL = os.environ.get("MONGO_URL") or os.environ.get("MONGODB_URL")
if not MONGO_URL:
    raise SystemExit("Falta MONGO_URL / MONGODB_URL en .env")

db = MongoClient(MONGO_URL, serverSelectionTimeoutMS=20000)["mos-system"]
inv, boxes = db["wms_inventory"], db["wms_boxes"]

BATCH = f"lifclean_{uuid.uuid4().hex[:8]}"
STAMP = datetime.now(timezone.utc).isoformat()
ACTOR = {"user_id": "system_lif_cleanup", "name": "Limpieza carros LIF (auditoria)"}
OUT = {"shipped", "in_production", "finished", "in_neck_cutting", "confirmed",
       "depleted", "recon_pending"}
FUZZY_MIN = 0.6

def n(v):
    return "" if v is None else str(v).upper().strip()

def num(v):
    try:
        return int(float(str(v).strip()))
    except (ValueError, TypeError):
        return None

def cnorm(s):
    """Normaliza color: HTR->HEATHER, ordena palabras, colapsa espacios."""
    s = str(s or "").upper().replace("HTR", "HEATHER").replace("/", " ")
    return " ".join(sorted(t for t in s.split() if t))

def log(m=""):
    print(m, flush=True)

log("=" * 72)
log(f"LIMPIEZA DE CARROS LIF   batch={BATCH}")
log(f"MODO: {'APLICAR (escribe en la base)' if APPLY else 'SIMULACION (no escribe nada)'}")
log("=" * 72)

# ------------------------------------------------------------ 1. Excel
excel = collections.defaultdict(lambda: {"qty": 0, "colors": collections.Counter(), "rows": []})
per_file = collections.Counter()
for f in FILES:
    wb = openpyxl.load_workbook(BACKEND / f, data_only=True)
    ws = wb.active
    for i, r in enumerate(list(ws.iter_rows(values_only=True))[1:], start=2):
        if not any(c is not None for c in r):
            continue
        q = num(r[5])
        if q is None or q >= 0:
            continue
        k = (n(r[0]), n(r[1]), cnorm(r[2]), n(r[3]), n(r[4]))
        excel[k]["qty"] += abs(q)
        excel[k]["colors"][n(r[2])] += 1
        excel[k]["rows"].append((f, i))
        per_file[f] += 1

log(f"\nArchivos: {len(FILES)}   filas negativas: {sum(per_file.values())}")
for f in FILES:
    log(f"  {f}: {per_file[f]} filas")
log(f"Claves unicas (color normalizado): {len(excel)}   "
    f"unidades: {sum(v['qty'] for v in excel.values())}")

# ------------------------------------------------------- 2. Resolucion
def resolve(k, qty):
    """Devuelve (ids_a_vaciar, status, color_bd, bd_units)."""
    c, s, cn, sz, loc = k
    q = {"customer": c, "style": s, "location": loc}
    if sz:
        q["size"] = sz
    cands = list(inv.find(q))
    if not cands:
        return [], "SIN_RESOLVER", None, 0
    # agrupa candidatos por color normalizado
    grupos = collections.defaultdict(list)
    for d in cands:
        grupos[cnorm(d.get("color"))].append(d)
    def gsum(docs):
        return sum(int(d.get("units_on_hand") or 0) for d in docs)
    def galloc(docs):
        return sum(int(d.get("units_allocated") or 0) for d in docs)

    # 1) color normalizado exacto
    if cn in grupos:
        docs = grupos[cn]
        u = gsum(docs)
        if galloc(docs) > 0:
            return [], "CON_ALLOC", docs[0].get("color"), u
        if u == qty:
            return [d["_id"] for d in docs], "MATCH", docs[0].get("color"), u
        if u < qty:
            return [d["_id"] for d in docs], "DESCUADRE_SEGURO", docs[0].get("color"), u
        return [], "DESCUADRE_RIESGO", docs[0].get("color"), u
    # 2) fuzzy: mejor grupo por similitud, exigiendo cantidad exacta
    best, br = None, 0.0
    for kk, docs in grupos.items():
        r = difflib.SequenceMatcher(None, cn, kk).ratio()
        if r > br:
            br, best = r, (kk, docs)
    if best and br >= FUZZY_MIN:
        docs = best[1]
        u = gsum(docs)
        if u == qty and galloc(docs) == 0:
            return [d["_id"] for d in docs], "MATCH_FUZZY", docs[0].get("color"), u
    return [], "SIN_RESOLVER", None, 0

CLEAN_STATUS = {"MATCH", "MATCH_FUZZY", "DESCUADRE_SEGURO"}
plan, skipped = [], []
for k, info in excel.items():
    ids, st, color_bd, u = resolve(k, info["qty"])
    rec = {"key": k, "qty": info["qty"], "ids": ids, "status": st,
           "color_bd": color_bd, "bd_units": u,
           "colors_excel": list(info["colors"])}
    if st in CLEAN_STATUS:
        plan.append(rec)
    else:
        skipped.append(rec)

st_count = collections.Counter(p["status"] for p in plan)
sk_count = collections.Counter(s["status"] for s in skipped)
log("\n=== RESOLUCION ===")
log(f"  a limpiar: {len(plan)} claves")
for s, c in st_count.most_common():
    log(f"      {s}: {c}")
log(f"  omitidas: {len(skipped)} claves")
for s, c in sk_count.most_common():
    log(f"      {s}: {c}")

if skipped:
    log("\n  --- OMITIDAS (se respetan, se reportan) ---")
    for s in skipped:
        c, sty, cn, sz, loc = s["key"]
        log(f"    [{s['status']}] {sty}/{'/'.join(s['colors_excel'])}/{sz}@{loc} "
            f"excel={s['qty']} bd={s['bd_units']}")

# Guardia de cordura
if len(plan) < len(excel) * 0.5:
    log("\n*** SE ABORTA: menos de la mitad de las claves cuadran. Revisar. ***")
    raise SystemExit(1)
if not plan:
    log("\nNada que limpiar.")
    raise SystemExit(0)

if not APPLY:
    # muestra impacto sin escribir
    target_ids = [i for p in plan for i in p["ids"]]
    docs = list(inv.find({"_id": {"$in": target_ids}}))
    units = sum(int(d.get("units_on_hand") or 0) for d in docs)
    locs = sorted({str(d.get("location") or "") for d in docs})
    log(f"\nImpacto: {len(docs)} registros, {units} unidades, {len(locs)} ubicaciones")
    log("  muestra de resueltos por color:")
    fuzzy = [p for p in plan if p["status"] == "MATCH_FUZZY"][:8]
    for p in fuzzy:
        log(f"    {p['colors_excel']} -> {p['color_bd']!r}  ({p['qty']}u)")
    log("\n" + "=" * 72)
    log("SIMULACION — no se escribio nada. Ejecuta con --apply para aplicar.")
    log("=" * 72)
    raise SystemExit(0)

# --------------------------------------------- 3. REVALIDACION EN CALIENTE
log("\n[0/4] Revalidando contra la base (el almacen opera)...")
reval, late = [], []
for p in plan:
    ids, st, color_bd, u = resolve(p["key"], p["qty"])
    if st in CLEAN_STATUS and ids == p["ids"] and st == p["status"]:
        reval.append(p)
    else:
        late.append((p["key"], p["status"], st))
if late:
    log(f"  cambiaron durante el analisis, se omiten: {len(late)}")
    for k, was, now in late[:12]:
        log(f"    {k[1]}/{k[3]}@{k[4]}  era {was} ahora {now}")
    skipped.extend({"key": k, "status": f"CAMBIO_{now}", "qty": 0,
                    "bd_units": 0, "colors_excel": []} for k, was, now in late)
plan = reval
if not plan:
    log("\nNada que limpiar tras revalidar.")
    raise SystemExit(0)

target_ids = [i for p in plan for i in p["ids"]]
target_docs = list(inv.find({"_id": {"$in": target_ids}}))
inv_units = sum(int(d.get("units_on_hand") or 0) for d in target_docs)
locs = sorted({str(d.get("location") or "") for d in target_docs})

# cajas por color REAL de la BD
keys = {(n(d.get("customer")), n(d.get("style")), n(d.get("color")),
         n(d.get("size")), n(d.get("location"))) for d in target_docs}
def bkey(b):
    return (n(b.get("customer")), n(b.get("style")), n(b.get("color")),
            n(b.get("size")), n(b.get("location")))
all_in_locs = list(boxes.find({"location": {"$in": locs}}))
to_deplete = [b for b in all_in_locs if bkey(b) in keys and str(b.get("status")) not in OUT]
box_units = sum(int(b.get("units") or 0) for b in to_deplete)
keep = list(inv.find({"location": {"$in": locs}, "_id": {"$nin": target_ids},
                      "units_on_hand": {"$gt": 0}}))
log(f"  confirmado: {len(target_docs)} registros, {inv_units} u., {len(to_deplete)} cajas")
log(f"  inventario respetado en esas ubicaciones: {len(keep)} reg, "
    f"{sum(int(d.get('units_on_hand') or 0) for d in keep)} u.")

# ------------------------------------------------------------ 4. Respaldo
log("\n[1/4] Respaldando...")
bak_i, bak_b = f"wms_inventory_bak_{BATCH}", f"wms_boxes_bak_{BATCH}"
if target_docs:
    db[bak_i].insert_many([dict(d, _bak_batch=BATCH, _bak_at=STAMP) for d in target_docs])
if to_deplete:
    db[bak_b].insert_many([dict(b, _bak_batch=BATCH, _bak_at=STAMP) for b in to_deplete])
log(f"  {bak_i}: {len(target_docs)}   {bak_b}: {len(to_deplete)}")

# -------------------------------------------------- 5. Inventario a cero
log("\n[2/4] Poniendo inventario en cero...")
res_inv = inv.update_many(
    {"_id": {"$in": target_ids}},
    {"$set": {"units_on_hand": 0, "units_allocated": 0, "total_boxes": 0,
              "updated_at": STAMP, "lif_cleanup_batch": BATCH,
              "lif_cleanup_reason": "Auditoria fisica: material inexistente en carro"}},
)
log(f"  registros actualizados: {res_inv.modified_count}/{len(target_ids)}")

# ------------------------------------------------------ 6. Agotar cajas
log("\n[3/4] Agotando cajas...")
res_box = boxes.update_many(
    {"box_id": {"$in": [b.get("box_id") for b in to_deplete]}},
    {"$set": {"units": 0, "qty": 0, "status": "depleted", "updated_at": STAMP,
              "updated_by": ACTOR["user_id"], "lif_cleanup_batch": BATCH},
     "$unset": {"recon_pending": ""}},
)
log(f"  cajas agotadas: {res_box.modified_count}/{len(to_deplete)}")

# ---------------------------------------------------------- 7. Bitacora
log("\n[4/4] Escribiendo bitacora...")
id2plan = {}
for p in plan:
    for i in p["ids"]:
        id2plan[i] = p
db["wms_movements"].insert_many([{
    "movement_id": f"mov_{uuid.uuid4().hex[:12]}",
    "type": "lif_cart_cleanup",
    "details": {
        "sku": d.get("sku") or d.get("style"), "style": d.get("style"),
        "color": d.get("color"), "size": d.get("size"),
        "location": d.get("location"), "customer": d.get("customer"),
        "old_units": int(d.get("units_on_hand") or 0), "new_units": 0,
        "delta_units": -int(d.get("units_on_hand") or 0),
        "match": (id2plan.get(d["_id"]) or {}).get("status"),
        "via": "lif_cart_cleanup", "batch": BATCH,
        "reason": "Auditoria fisica: material inexistente en carro",
    },
    "user_id": ACTOR["user_id"], "user_name": ACTOR["name"], "created_at": STAMP,
} for d in target_docs])
log(f"  wms_movements: {len(target_docs)} movimientos")

db["wms_recon_adjustments"].insert_one({
    "type": "lif_cart_cleanup", "batch": BATCH,
    "created_at": STAMP, "created_by": ACTOR["name"],
    "count": len(locs), "units": inv_units,
    "reason": ("Limpieza de carros LIF08-LIF11. Auditoria fisica confirmo material "
               "inexistente. Fuentes: PL#17-PL#20."),
    "locations": [{"location": loc,
                   "unidades": sum(int(d.get("units_on_hand") or 0)
                                   for d in target_docs if d.get("location") == loc),
                   "registros": sum(1 for d in target_docs if d.get("location") == loc)}
                  for loc in locs],
    "boxes": [b.get("box_id") for b in to_deplete],
})

db["wms_lifclean_manifest"].insert_one({
    "batch": BATCH, "created_at": STAMP, "created_by": ACTOR["name"],
    "source_files": FILES,
    "excel_rows": sum(per_file.values()), "excel_keys": len(excel),
    "cleaned_keys": len(plan),
    "by_status": dict(collections.Counter(p["status"] for p in plan)),
    "inventory_docs": len(target_docs), "inventory_units": inv_units,
    "boxes_depleted": len(to_deplete), "box_units": box_units,
    "locations": locs,
    "backup_inventory": bak_i, "backup_boxes": bak_b,
    "color_resolved": [{"excel": p["colors_excel"], "bd": p["color_bd"],
                        "qty": p["qty"], "loc": p["key"][4]}
                       for p in plan if p["status"] == "MATCH_FUZZY"],
    "descuadre_cleared": [{"key": list(p["key"]), "excel": p["qty"],
                           "bd": p["bd_units"]}
                          for p in plan if p["status"] == "DESCUADRE_SEGURO"],
    "skipped": [{"key": list(s["key"]), "status": s["status"],
                 "excel": s.get("qty"), "bd": s.get("bd_units")}
                for s in skipped],
})
log("  wms_recon_adjustments + wms_lifclean_manifest: ok")

# ------------------------------------------------------- 8. Verificacion
log("\n" + "=" * 72)
log("VERIFICACION")
left = inv.count_documents({"_id": {"$in": target_ids}, "units_on_hand": {"$ne": 0}})
box_left = boxes.count_documents({"box_id": {"$in": [b.get("box_id") for b in to_deplete]},
                                  "status": {"$ne": "depleted"}})
keep_now = sum(int(d.get("units_on_hand") or 0)
               for d in inv.find({"location": {"$in": locs}, "_id": {"$nin": target_ids}}))
log(f"  registros objetivo con saldo != 0 : {left}      (esperado 0)")
log(f"  cajas objetivo sin agotar         : {box_left}      (esperado 0)")
log(f"  unidades intactas en esos carros  : {keep_now}  (antes: "
    f"{sum(int(d.get('units_on_hand') or 0) for d in keep)})")
log(f"  claves omitidas (reportadas)      : {len(skipped)}")
log(f"  batch: {BATCH}")
log(f"  reversible desde: {bak_i} / {bak_b}")
log("=" * 72)
log("OK" if left == 0 and box_left == 0 else "*** REVISAR ***")
