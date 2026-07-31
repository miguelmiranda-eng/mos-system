"""Remediación de renglones fantasma DUPLICADOS en wms_inventory (INFLADO).

Sólo ataca el caso SEGURO que confirmamos en el diagnóstico:
  - Una celda (material, color, talla, ubicación) donde:
      * hay cajas físicas reales (total_físico > 0), y
      * existe >=1 renglón RESPALDADO (su firma de lote sí tiene cajas), y
      * existe >=1 renglón FANTASMA (saldo>0 con CERO cajas de su firma).
  - El fantasma es papel duplicado: las cajas ya están contadas por el renglón
    respaldado. Ejemplo semilla: GT12577J1358-CHARCOAL-XL @ PS01-A07, renglón
    NICARAGUA 788u/14c sin una sola caja de Nicaragua.

Qué hace por cada celda segura:
  1. ALINEA cada renglón respaldado a la verdad de las cajas (units_on_hand y
     total_boxes = lo que suman las cajas de esa firma). Corrige la deriva.
  2. BORRA los renglones fantasma (firma sin cajas).  -> LA CAJA MANDA.
  Resultado: papel de la celda == físico de la celda (conservación vs físico).

Salvaguardas:
  - DRY-RUN por defecto. Escribe SÓLO con APPLY=1.
  - NO toca HUERFANO (cero cajas de nada), REVISAR_MATERIAL (cajas con otro
    nombre) ni DERIVA_ETIQUETA (papel==físico): esos exigen conteo / reetiqueta.
  - SALTA cualquier renglón fantasma con units_allocated>0 (picking comprometido)
    y lo reporta como PENDIENTE_HUMANO, sin tocar la celda.
  - Auditoría por celda en wms_incidents + wms_movements (writeoff con registro).
  - Filtro opcional por ubicación:  python fix_phantom_dup_rows.py PS01-A07

Uso:
    python fix_phantom_dup_rows.py                 # DRY-RUN, todas las celdas
    python fix_phantom_dup_rows.py PS01-A07        # DRY-RUN, sólo esa ubicación
    APPLY=1 python fix_phantom_dup_rows.py PS01-A07 # APLICA sólo esa ubicación
    APPLY=1 python fix_phantom_dup_rows.py          # APLICA todas las seguras
"""
import asyncio
import os
import sys
import uuid
from collections import defaultdict
from datetime import datetime, timezone

from deps import db
from services.inventory_ledger import row_signature

APPLY = os.environ.get("APPLY") == "1"
LOC_FILTER = (sys.argv[1].strip().upper() if len(sys.argv) > 1 else "")
BATCH = 500
SYS_USER = {"user_id": "system_fix", "name": "fix_phantom_dup_rows"}


def now_iso():
    return datetime.now(timezone.utc).isoformat()


def gen_id(prefix="wms"):
    return f"{prefix}_{uuid.uuid4().hex[:12]}"


def _repr_material(d):
    return ((d.get("sku") or d.get("style") or "")).strip().upper()


def _cell(d):
    return (_repr_material(d),
            (d.get("color") or "").strip().upper(),
            (d.get("size") or "").strip().upper(),
            (d.get("location") or "").strip().upper())


def _int(v):
    try:
        return int(v or 0)
    except (TypeError, ValueError):
        return 0


def _box_units(b):
    return _int(b.get("units") or b.get("qty"))


async def main():
    print(f"Modo: {'APPLY (ESCRIBE)' if APPLY else 'DRY-RUN (no escribe)'}"
          f"{'  filtro loc=' + LOC_FILTER if LOC_FILTER else ''}")
    print(f"DB: {db.name}\n")

    # ── Físico: cajas por (celda, firma) y por ubicación (ignorando material) ──
    box_sig = defaultdict(lambda: defaultdict(lambda: {"units": 0, "boxes": 0}))
    box_loc = defaultdict(int)
    cur = db.wms_boxes.find(
        {"$or": [{"units": {"$gt": 0}}, {"qty": {"$gt": 0}}]},
        {"_id": 0, "style": 1, "sku": 1, "color": 1, "size": 1, "location": 1,
         "units": 1, "qty": 1, "country_of_origin": 1, "coo": 1, "fabric_content": 1},
    ).batch_size(BATCH)
    async for b in cur:
        u = _box_units(b)
        if u <= 0:
            continue
        cell = _cell(b)
        acc = box_sig[cell][row_signature(b)]
        acc["units"] += u
        acc["boxes"] += 1
        box_loc[cell[1:]] += u

    # ── Papel: renglones por celda ──
    inv_by_cell = defaultdict(list)
    cur = db.wms_inventory.find(
        {"$or": [{"units_on_hand": {"$gt": 0}}, {"total_boxes": {"$gt": 0}},
                 {"units_allocated": {"$gt": 0}}]},
        {"_id": 1, "inventory_id": 1, "customer": 1, "style": 1, "sku": 1,
         "color": 1, "size": 1, "location": 1, "units_on_hand": 1,
         "total_boxes": 1, "units_allocated": 1, "country_of_origin": 1,
         "coo": 1, "fabric_content": 1},
    ).batch_size(BATCH)
    async for r in cur:
        inv_by_cell[_cell(r)].append(r)

    planned = []              # celdas seguras a remediar
    skipped_alloc = []        # celdas saltadas por allocation en una fila a borrar
    skipped_orphan_box = []   # celdas con cajas SIN renglón -> reproyección/conteo

    for cell, rows in inv_by_cell.items():
        if LOC_FILTER and cell[3] != LOC_FILTER:
            continue
        sig_units = box_sig.get(cell, {})
        total_fisico = sum(v["units"] for v in sig_units.values())
        total_papel = sum(_int(r.get("units_on_hand")) for r in rows)
        if total_fisico <= 0 or total_papel <= total_fisico:
            continue  # no INFLADO / sin cajas -> fuera de alcance

        # Firmas con cajas (verdad física) y renglones agrupados por firma.
        box_sigs = {s: v for s, v in sig_units.items() if v["units"] > 0}
        rows_by_sig = defaultdict(list)
        for r in rows:
            rows_by_sig[row_signature(r)].append(r)

        # GATE CRÍTICO: cada firma con cajas DEBE tener su renglón. Si hay cajas
        # de una firma sin renglón en papel, alinear+borrar dejaría el papel por
        # DEBAJO del físico (perdería stock). Esa celda va a reproyección, no aquí.
        if not set(box_sigs).issubset(set(rows_by_sig)):
            skipped_orphan_box.append(cell)
            continue

        deletes, updates = [], []
        unsafe_alloc = False
        for sig, rs in rows_by_sig.items():
            if sig in box_sigs:
                truth = box_sigs[sig]
                keep = rs[0]
                # No dejar on_hand por debajo de lo ya comprometido (sobreventa).
                if truth["units"] < _int(keep.get("units_allocated")):
                    unsafe_alloc = True
                    break
                if (_int(keep.get("units_on_hand")) != truth["units"]
                        or _int(keep.get("total_boxes")) != truth["boxes"]):
                    updates.append((keep, truth["units"], truth["boxes"]))
                deletes.extend(rs[1:])           # duplicados del MISMO lote
            else:
                deletes.extend(r for r in rs if _int(r.get("units_on_hand")) > 0)

        # Salvaguarda: nunca borrar/encoger un renglón con picking comprometido.
        if unsafe_alloc or any(_int(r.get("units_allocated")) > 0 for r in deletes):
            skipped_alloc.append((cell, deletes))
            continue
        if not deletes:
            continue

        # Verificación de conservación: tras el plan, papel == físico.
        post = sum(v["units"] for v in box_sigs.values())
        assert post == total_fisico, (cell, post, total_fisico)

        planned.append({
            "cell": cell, "papel": total_papel, "fisico": total_fisico,
            "updates": updates, "deletes": deletes,
        })

    # ── Reporte ──
    total_borrado = sum(sum(_int(r.get("units_on_hand")) for r in p["deletes"]) for p in planned)
    total_ajuste = sum(sum(abs(_int(r.get("units_on_hand")) - u) for r, u, _ in p["updates"]) for p in planned)
    print(f"Celdas seguras a remediar: {len(planned)}")
    print(f"  Renglones fantasma a BORRAR: {sum(len(p['deletes']) for p in planned)}  "
          f"(unidades de papel a dar de baja: {total_borrado:,})")
    print(f"  Renglones respaldados a AJUSTAR a las cajas: {sum(len(p['updates']) for p in planned)}  "
          f"(|deriva| corregida: {total_ajuste:,})")
    if skipped_alloc:
        print(f"  SALTADAS por allocation en fila a borrar (revisión humana): {len(skipped_alloc)}")
    if skipped_orphan_box:
        print(f"  SALTADAS por cajas SIN renglón (van a reproyección/conteo): {len(skipped_orphan_box)}")
    print()

    for p in sorted(planned, key=lambda x: -sum(_int(r.get('units_on_hand')) for r in x['deletes']))[:40]:
        c = p["cell"]
        print(f"• {c[0]} {c[1]}-{c[2]} @ {c[3]}   papel={p['papel']} físico={p['fisico']}")
        for r in p["deletes"]:
            print(f"    BORRAR   {r.get('inventory_id')}  [{(r.get('country_of_origin') or r.get('coo') or 'sin país')}"
                  f"/{r.get('fabric_content') or 'sin tela'}]  {_int(r.get('units_on_hand'))}u/{_int(r.get('total_boxes'))}c")
        for r, u, bc in p["updates"]:
            print(f"    AJUSTAR  {r.get('inventory_id')}  [{(r.get('country_of_origin') or r.get('coo') or 'sin país')}]"
                  f"  {_int(r.get('units_on_hand'))}u -> {u}u   {_int(r.get('total_boxes'))}c -> {bc}c")

    for cell, dels in skipped_alloc[:20]:
        print(f"! SALTADA (allocation) {cell[0]} {cell[1]}-{cell[2]} @ {cell[3]}: "
              f"{', '.join(r.get('inventory_id') for r in dels)}")
    if skipped_orphan_box:
        print(f"\n  Celdas con cajas sin renglón (NO tocadas — necesitan reproyección/conteo): "
              f"{len(skipped_orphan_box)}")
        for cell in skipped_orphan_box[:15]:
            print(f"    ~ {cell[0]} {cell[1]}-{cell[2]} @ {cell[3]}")

    if not APPLY:
        print("\n[DRY-RUN] No se escribió nada. Corre con APPLY=1 para aplicar.")
        return

    # ── Aplicar (con auditoría por celda) ──
    print("\nAplicando...")
    n_del = n_upd = 0
    for p in planned:
        c = p["cell"]
        material = f"{c[0]}/{c[1]}/{c[2]}"
        borrados = []
        for r in p["deletes"]:
            await db.wms_inventory.delete_one({"_id": r["_id"]})
            n_del += 1
            borrados.append({
                "inventory_id": r.get("inventory_id"),
                "country_of_origin": r.get("country_of_origin") or r.get("coo") or "",
                "fabric_content": r.get("fabric_content") or "",
                "units_on_hand": _int(r.get("units_on_hand")),
                "total_boxes": _int(r.get("total_boxes")),
            })
        ajustados = []
        for r, u, bc in p["updates"]:
            await db.wms_inventory.update_one(
                {"_id": r["_id"]},
                {"$set": {"units_on_hand": u, "total_boxes": bc, "updated_at": now_iso()},
                 "$unset": {"pending_cycle_count": "", "pending_cycle_count_reason": ""}},
            )
            n_upd += 1
            ajustados.append({
                "inventory_id": r.get("inventory_id"),
                "country_of_origin": r.get("country_of_origin") or r.get("coo") or "",
                "de_units": _int(r.get("units_on_hand")), "a_units": u,
                "de_boxes": _int(r.get("total_boxes")), "a_boxes": bc,
            })

        detalle = (f"Dedupe fantasma en {c[3]}: papel {p['papel']}->{p['fisico']} (=físico). "
                   f"Borrados {len(borrados)} renglón(es) sin cajas; "
                   f"ajustados {len(ajustados)} a la verdad física.")
        await db.wms_incidents.insert_one({
            "incident_id": gen_id("inc"), "kind": "phantom_dedupe_writeoff",
            "mensaje": detalle, "material": material, "location": c[3],
            "borrados": borrados, "ajustados": ajustados,
            "papel_antes": p["papel"], "fisico": p["fisico"],
            "user_id": SYS_USER["user_id"], "user_name": SYS_USER["name"],
            "created_at": now_iso(),
        })
        await db.wms_movements.insert_one({
            "movement_id": gen_id("mov"), "type": "inventory_dedupe_writeoff",
            "user_id": SYS_USER["user_id"], "user_name": SYS_USER["name"],
            "created_at": now_iso(),
            "details": {"material": material, "location": c[3], "color": c[1], "size": c[2],
                        "papel_antes": p["papel"], "papel_despues": p["fisico"],
                        "borrados": borrados, "ajustados": ajustados},
        })

    print(f"  Renglones borrados: {n_del}   ajustados: {n_upd}")
    print(f"  Unidades de papel dadas de baja: {total_borrado:,}")
    print("  Auditoría: wms_incidents(kind=phantom_dedupe_writeoff) + wms_movements(type=inventory_dedupe_writeoff)")


if __name__ == "__main__":
    asyncio.run(main())
