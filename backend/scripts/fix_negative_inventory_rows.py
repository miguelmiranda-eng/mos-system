"""Repara los renglones NEGATIVOS de wms_inventory reproyectando desde las cajas.

LAS CAJAS SON LA VERDAD. Un renglón con units_on_hand negativo es papel sin
pregunta física que responder (no se puede contar "-494 unidades"): viene de
bajas de papel aplicadas a celdas ya vaciadas o bajo otra identidad de lote.

QUÉ HACE
────────
1. Censa todos los renglones con units_on_hand < 0.
2. Por cada celda afectada (material + ubicación) llama al proyector oficial
   de la app (_reproject_material_rows, routers/wms.py) — la MISMA doctrina
   que usa cualquier operación del piso:
     · renglón respaldado por cajas -> se ajusta a lo que suman
     · residuo <= 0 sin allocation  -> se elimina (rama del 2026-08-11)
     · positivo huérfano            -> pending_cycle_count (no se borra)
3. Re-censa: no debe quedar ningún negativo.

Sin --apply es DRY-RUN: solo imprime el estado y la acción prevista.

USO
───
    set MONGODB_URL=...
    python backend/scripts/fix_negative_inventory_rows.py           # dry-run
    python backend/scripts/fix_negative_inventory_rows.py --apply   # repara
"""
import argparse
import asyncio
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

if not (os.environ.get("MONGODB_URL") or os.environ.get("MONGO_URL")):
    sys.exit("Falta MONGODB_URL")


async def main(apply: bool):
    from deps import db
    from services import inventory_ledger as ledger

    negs = await db.wms_inventory.find(
        {"units_on_hand": {"$lt": 0}}, {"_id": 0}).to_list(500)
    if not negs:
        print("Sin renglones negativos. Nada que hacer.")
        return

    # Celdas únicas afectadas
    celdas = {}
    for n in negs:
        k = (n.get("style") or "", n.get("sku") or "", n.get("color") or "",
             n.get("size") or "", n.get("location") or "")
        celdas.setdefault(k, []).append(n)

    print(f"{'=' * 72}\n{len(negs)} renglones negativos en {len(celdas)} celdas"
          f" — modo {'APPLY' if apply else 'DRY-RUN'}\n{'=' * 72}")

    for (style, sku, color, size, loc), rows_neg in sorted(celdas.items(), key=lambda x: x[0][4]):
        print(f"\n--- {style} {color} {size} @ {loc}")
        # Verdad de cajas por lote
        lotes = {}
        boxes = await db.wms_boxes.find({
            "$or": [{"sku": {"$in": ledger.material_keys(style, sku)}},
                    {"style": {"$in": ledger.material_keys(style, sku)}}],
            "color": color, "size": size, "location": loc,
        }, ledger.box_projection()).to_list(5000)
        for b in boxes:
            u = int(b.get("units") or b.get("qty") or 0)
            if u <= 0:
                continue
            f = ledger.row_signature(b)
            acc = lotes.setdefault(f, [0, 0])
            acc[0] += u
            acc[1] += 1
        # Renglones actuales de la celda
        rows = await db.wms_inventory.find(
            ledger.row_query(style, sku, color, size, loc), {"_id": 0}).to_list(50)
        for r in rows:
            f = ledger.row_signature(r)
            u = int(r.get("units_on_hand") or 0)
            al = int(r.get("units_allocated") or 0)
            if f in lotes:
                tu, tb = lotes[f]
                accion = "ok (cuadra con cajas)" if u == tu else f"AJUSTAR a {tu}u/{tb}c"
            elif u <= 0 and al <= 0:
                accion = "ELIMINAR (residuo <= 0 sin cajas ni allocation)"
            elif u <= 0:
                accion = f"CONSERVAR (allocation {al} comprometida)"
            else:
                accion = "conservar -> conteo cíclico / consolidación según cobertura"
            print(f"    renglón [{f[0] or 'sin país'} · {f[1] or 'sin comp.'}] "
                  f"{u:>6}u alloc={al}  ->  {accion}")
        for f, (tu, tb) in lotes.items():
            if not any(ledger.row_signature(r) == f for r in rows):
                print(f"    lote físico sin renglón [{f[0]} · {f[1]}] {tu}u/{tb}c -> CREAR")

        if apply:
            from routers.wms import _reproject_material_rows
            await _reproject_material_rows(style, sku, color, size, loc)
            print("    ✔ reproyectada")

    if apply:
        rest = await db.wms_inventory.count_documents({"units_on_hand": {"$lt": 0}})
        print(f"\n{'=' * 72}\nNegativos restantes tras reparar: {rest}")
    else:
        print(f"\n{'=' * 72}\nDRY-RUN: no se modificó nada. Corre con --apply para reparar.")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true", help="aplica la reparación (default: dry-run)")
    args = ap.parse_args()
    asyncio.run(main(args.apply))
