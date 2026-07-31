"""Diagnóstico READ-ONLY de renglones fantasma / duplicados en wms_inventory.

Contexto (reporte 2026-07-30): la pestaña "Inventory" del export mostró un
material con renglones duplicados por PAÍS DE ORIGEN — uno de ellos SIN cajas
físicas que lo respalden (fantasma). Caso semilla:
    GT12577J1358-CHARCOAL-XL @ PS01-A07
      NICARAGUA           14c / 788u   <- FANTASMA (0 cajas de Nicaragua)
      REPUBLICA DOMINICANA 14c / 788u  <- real
      (sin país)          34c / 1251u  <- real
    Papel: 62c/2827u   Físico (Cajas-LPNs): 48c/2039u   -> +788u inflados.

Causa: wms_inventory se llavea por (sku,color,talla,ubicación,país,composición).
Una corrección de país sobre las CAJAS crea el renglón nuevo pero no descuenta
el viejo -> renglón huérfano con saldo>0 y cero cajas. La reproyección actual
NO borra un saldo>0 sin cajas (sólo lo marca), así que el daño heredado persiste.

Este script NO ESCRIBE NADA. Sólo:
  - Reconstruye el físico desde wms_boxes usando la MISMA firma de lote del
    ledger (país+composición canónicos).
  - Marca cada renglón de wms_inventory como OK / FANTASMA / REVISAR.
  - Clasifica cada celda (material,color,talla,ubicación) en:
      DUPLICADO  = tiene un renglón fantasma Y otro renglón respaldado (el
                   patrón exacto del reporte: mismas cajas contadas 2 veces).
      HUERFANO   = renglón(es) con saldo pero la celda no tiene NINGUNA caja.
  - Exporta un Excel a Descargas para validación humana.

Uso:
    python diagnose_phantom_dup_rows.py
"""
import asyncio
import os
from collections import defaultdict
from datetime import datetime

from deps import db
from services.inventory_ledger import canon_coo, canon_fabric, row_signature

# Salida junto a los demás reportes.
OUT_DIR = os.path.join(os.path.expanduser("~"), "Downloads")
OUT_XLSX = os.path.join(OUT_DIR, f"cajas_fantasma_duplicadas_{datetime.now():%Y-%m-%d}.xlsx")

# Lotes chicos + proyección: evita el reset de respuestas grandes del Mongo prod.
BATCH = 500


def _repr_material(doc):
    """Llave de material para unir cajas e inventario: el sku COMPUESTO manda;
    si falta, el style. Mayúsculas para casar sin importar captura."""
    return ((doc.get("sku") or doc.get("style") or "")).strip().upper()


def _cell(doc):
    return (
        _repr_material(doc),
        (doc.get("color") or "").strip().upper(),
        (doc.get("size") or "").strip().upper(),
        (doc.get("location") or "").strip().upper(),
    )


def _box_units(b):
    try:
        return int(b.get("units") or b.get("qty") or 0)
    except (TypeError, ValueError):
        return 0


def _int(v):
    try:
        return int(v or 0)
    except (TypeError, ValueError):
        return 0


async def main():
    print(f"DB: {db.name}   (READ-ONLY, no se escribe nada)\n")

    # ── Físico: wms_boxes con unidades, agregado por (celda, firma de lote) ──
    #   box_sig[cell][firma] -> {"units":, "boxes":}
    box_sig = defaultdict(lambda: defaultdict(lambda: {"units": 0, "boxes": 0}))
    box_loc = defaultdict(int)   # (color,size,location) -> units, IGNORANDO material
    n_boxes = 0
    cur = db.wms_boxes.find(
        {"$or": [{"units": {"$gt": 0}}, {"qty": {"$gt": 0}}]},
        {"_id": 0, "style": 1, "sku": 1, "color": 1, "size": 1, "location": 1,
         "units": 1, "qty": 1, "country_of_origin": 1, "coo": 1, "fabric_content": 1},
    ).batch_size(BATCH)
    async for b in cur:
        u = _box_units(b)
        if u <= 0:
            continue
        n_boxes += 1
        cell = _cell(b)
        acc = box_sig[cell][row_signature(b)]
        acc["units"] += u
        acc["boxes"] += 1
        box_loc[cell[1:]] += u

    # ── Papel: wms_inventory con saldo, agrupado por celda ──
    inv_by_cell = defaultdict(list)
    n_inv = 0
    cur = db.wms_inventory.find(
        {"$or": [{"units_on_hand": {"$gt": 0}}, {"total_boxes": {"$gt": 0}},
                 {"units_allocated": {"$gt": 0}}]},
        {"_id": 0, "inventory_id": 1, "customer": 1, "style": 1, "sku": 1,
         "color": 1, "size": 1, "location": 1, "units_on_hand": 1,
         "total_boxes": 1, "units_allocated": 1, "country_of_origin": 1,
         "coo": 1, "fabric_content": 1, "pending_cycle_count": 1},
    ).batch_size(BATCH)
    async for r in cur:
        n_inv += 1
        inv_by_cell[_cell(r)].append(r)

    print(f"wms_boxes con unidades:     {n_boxes:,}")
    print(f"wms_inventory con saldo:    {n_inv:,}")
    print(f"celdas de inventario:       {len(inv_by_cell):,}\n")

    # ── Clasificación por CELDA basada en inflación real (papel − físico) ──
    #   INFLADO   = papel > físico. Hay stock de papel de más. Los renglones sin
    #               cajas de su firma son los candidatos a borrar/reproyectar.
    #   HUERFANO  = la celda no tiene NINGUNA caja pero sí saldo en papel.
    #   DERIVA    = papel == físico pero algún renglón trae una firma (país/tela)
    #               que ninguna caja respalda: la mercancía existe, sólo está
    #               MAL ETIQUETADA. Borrar aquí PERDERÍA stock real -> reetiquetar.
    celdas = []            # una entrada por celda problemática
    infl_cells = infl_units = 0
    orf_cells = orf_units = 0
    drift_cells = drift_rows = 0
    mat_cells = mat_units = 0

    for cell, rows in inv_by_cell.items():
        sig_units = box_sig.get(cell, {})
        total_fisico = sum(v["units"] for v in sig_units.values())
        total_papel = sum(_int(r.get("units_on_hand")) for r in rows)
        excess = total_papel - total_fisico
        # Cajas en la MISMA ubicación+color+talla bajo CUALQUIER material.
        fisico_loc = box_loc.get(cell[1:], 0)

        # Renglones cuya firma de lote no tiene NI UNA caja que la respalde.
        sin_respaldo = []
        for r in rows:
            sig = row_signature(r)
            if _int(r.get("units_on_hand")) > 0 and sig_units.get(sig, {}).get("units", 0) == 0:
                sin_respaldo.append((r, sig))
        if not sin_respaldo:
            continue

        if total_fisico == 0:
            # No hay cajas de ESTE material. ¿Hay cajas de OTRO material aquí?
            if fisico_loc > 0:
                # Muy probable desajuste de NOMBRE (style/sku), no fantasma real.
                clase = "REVISAR_MATERIAL"
                mat_cells += 1
                mat_units += total_papel
            else:
                clase = "HUERFANO"
                orf_cells += 1
                orf_units += total_papel
        elif excess > 0:
            clase = "INFLADO"
            infl_cells += 1
            infl_units += excess
        else:
            clase = "DERIVA_ETIQUETA"
            drift_cells += 1
            drift_rows += len(sin_respaldo)

        mat = rows[0].get("sku") or rows[0].get("style") or cell[0]
        celdas.append({
            "clase": clase,
            "customer": rows[0].get("customer", ""),
            "material": mat,
            "color": cell[1], "size": cell[2], "location": cell[3],
            "papel": total_papel, "fisico": total_fisico, "inflacion": max(0, excess),
            "n_renglones": len(rows),
            "n_fantasma": len(sin_respaldo),
            "firmas_fantasma": " | ".join(
                f"[{(s[0] or 'sin país')}/{(s[1] or 'sin tela')}]={_int(r.get('units_on_hand'))}u"
                for r, s in sin_respaldo),
            "firmas_fisicas": " | ".join(
                f"[{(k[0] or 'sin país')}/{(k[1] or 'sin tela')}]={v['units']}u"
                for k, v in sig_units.items()) or "(ninguna)",
            "inventory_ids_fantasma": ",".join(r.get("inventory_id", "") for r, _ in sin_respaldo),
        })

    # ── Resumen a consola ──
    print("=" * 78)
    print(f"INFLADO          (papel>físico: papel de más REAL)      celdas={infl_cells:4}"
          f"   uds infladas={infl_units:,}")
    print(f"HUERFANO         (cero cajas de CUALQUIER material)     celdas={orf_cells:4}"
          f"   uds en papel={orf_units:,}")
    print(f"REVISAR_MATERIAL (hay cajas pero con OTRO nombre)       celdas={mat_cells:4}"
          f"   uds={mat_units:,}")
    print(f"DERIVA_ETIQUETA  (papel=físico, sólo país/tela mal)     celdas={drift_cells:4}"
          f"   renglones={drift_rows}")
    print("=" * 78)

    infl = [c for c in celdas if c["clase"] == "INFLADO"]
    infl.sort(key=lambda c: -c["inflacion"])
    print("\n=== INFLADO — celdas con stock de papel REAL de más — top 35 ===")
    print(f"{'infla':>6} {'papel':>6} {'físic':>6} {'rgl':>3} | material @ ubicación")
    for c in infl[:35]:
        print(f"{c['inflacion']:6} {c['papel']:6} {c['fisico']:6} {c['n_renglones']:3} | "
              f"{c['material']} {c['color']}-{c['size']} @ {c['location']}")
        print(f"       fantasma: {c['firmas_fantasma']}   ||  cajas: {c['firmas_fisicas']}")

    # ── Excel para validación ──
    try:
        import xlsxwriter
    except ImportError:
        print("\n(xlsxwriter no disponible: se omite el Excel)")
        return

    wb = xlsxwriter.Workbook(OUT_XLSX)
    bold = wb.add_format({"bold": True})
    cols = ["Clase", "Customer", "Material", "Color", "Size", "Location",
            "Papel", "Físico", "Inflación", "# Renglones", "# Fantasma",
            "Firmas fantasma (papel sin cajas)", "Firmas físicas (cajas)",
            "inventory_ids fantasma"]
    key_order = ["clase", "customer", "material", "color", "size", "location",
                 "papel", "fisico", "inflacion", "n_renglones", "n_fantasma",
                 "firmas_fantasma", "firmas_fisicas", "inventory_ids_fantasma"]
    for clase in ("INFLADO", "HUERFANO", "REVISAR_MATERIAL", "DERIVA_ETIQUETA"):
        ws = wb.add_worksheet(clase)
        for i, h in enumerate(cols):
            ws.write(0, i, h, bold)
        rowi = 1
        for c in sorted((x for x in celdas if x["clase"] == clase),
                        key=lambda x: -(x["inflacion"] or x["papel"])):
            for ci, k in enumerate(key_order):
                ws.write(rowi, ci, c[k])
            rowi += 1
    wb.close()
    print(f"\nExcel escrito: {OUT_XLSX}")
    print("  INFLADO          = papel de más real -> reproyectar / borrar renglón fantasma")
    print("  HUERFANO         = sin cajas de ningún material -> CONTAR antes de tocar")
    print("  REVISAR_MATERIAL = hay cajas con otro nombre style/sku -> unificar identidad, NO borrar")
    print("  DERIVA_ETIQUETA  = papel=físico -> sólo reetiquetar país/tela del renglón")
    print("\nNingún dato fue modificado.")


if __name__ == "__main__":
    asyncio.run(main())
