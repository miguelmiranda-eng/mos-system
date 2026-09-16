"""IMMEX ID (número de parte aduanal) para el inventario EXISTENTE — paso 1: reporte previo.

Las cajas vivas recibidas antes de fase 2 no tienen `part_number`. Con lo que
la caja ya trae (cliente, descripción, contenido de tela, país de origen) y
los MISMOS catálogos del módulo de Entradas (services/part_number.py +
wms_part_number_config) se puede componer el código para la mayoría. Este
script NO escribe nada: genera un Excel para decidir catálogos y alcance
antes de aplicar.

HOJAS
─────
  Resumen     por cliente: cajas, piezas, componibles y %, causas de falla.
  Causas      cada valor problemático (descripción sin prenda, cliente sin
              prefijo, país/tela vacíos) con cuántas cajas afecta — es la lista
              de qué agregar a los catálogos.
  Estilos     estilo → descripciones vistas, cajas, prenda propuesta: base para
              un mapa estilo→prenda cuando la descripción no dice nada.
  Detalle     una fila por caja con el código propuesto o el error.

PERFILES (decisión del usuario 2026-09-16)
──────────────────────────────────────────
  current  la gramática de hoy: GTS, CW/MOCK, China = CN (lo que compone Entradas).
  legacy   lo que dice el PAPEL de importación del material existente: prenda
           CW/MOCK → HO, Goodie → prefijo AP y (solo en AP) China → CH. Es el perfil para
           el backfill del inventario ya importado; los códigos nuevos siguen
           saliendo con `current` desde Entradas.

USO
───
    set MONGODB_URL=...
    python backend/scripts/immex_backfill_preview.py                       # reporte, ambos perfiles
    python backend/scripts/immex_backfill_preview.py --apply --profile legacy   # escribe part_number
    python backend/scripts/immex_backfill_preview.py --revert <batch_id>        # deshace un lote

--apply escribe SOLO `part_number` (+ part_number_source="inferred",
part_number_batch, part_number_inferred_at) en cajas vivas que no lo tienen.
No toca unidades, ubicaciones ni wms_inventory (un solo escritor intacto).
Deja un movimiento `part_number_backfilled` por cliente con el lote.
"""
import argparse
import collections
import datetime as dt
import os
import sys

BE = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
sys.path.insert(0, BE)

import pymongo  # noqa: E402
from services import part_number as pn  # noqa: E402

LIVE_OUT = {"shipped", "in_production", "finished", "in_neck_cutting", "confirmed", "depleted", "recon_pending"}

LEGACY_GARMENT = {"CW": "HO", "MOCK": "HO"}
LEGACY_PREFIX = {"GOODIE TWO SLEEVES": "AP"}
# China = CH SOLO en los códigos AP (histórico de Goodie: 24 líneas con CH);
# Spektrum (SKT) y las entradas GTS recientes siempre declararon CN.
LEGACY_COUNTRY_BY_PREFIX = {"AP": {"CN": "CH"}}


def to_profile(code: str, customer: str, profile: str) -> str:
    """Convierte un código compuesto con la gramática actual al perfil pedido."""
    if profile != "legacy":
        return code
    p = pn.parse_part_number(code)
    if not p:
        return code
    prefix = LEGACY_PREFIX.get(pn.norm(customer), p["prefix"])
    garment = LEGACY_GARMENT.get(p["garment"], p["garment"])
    country = LEGACY_COUNTRY_BY_PREFIX.get(prefix, {}).get(p["country_code"], p["country_code"])
    return f"{prefix}-{p['gender']}{garment}{pn.composition_code(p['fibers'])}{country}{pn.SAMPLE_SUFFIX if p.get('sample') else ''}"


def now_iso():
    return dt.datetime.now(dt.timezone.utc).isoformat()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--customer", default="", help="Solo este cliente (exacto, sin distinguir mayúsculas)")
    ap.add_argument("--out", default="", help="Ruta del .xlsx (default: raíz del repo, con fecha)")
    ap.add_argument("--db", default=os.environ.get("DB_NAME", "mos-system"))
    ap.add_argument("--profile", default="legacy", choices=["legacy", "current"], help="Perfil que se ESCRIBE con --apply")
    ap.add_argument("--apply", action="store_true", help="Escribe part_number en las cajas componibles (perfil --profile)")
    ap.add_argument("--revert", default="", help="Deshace un lote: quita part_number de las cajas con ese part_number_batch")
    args = ap.parse_args()

    mongo = os.environ.get("MONGODB_URL") or os.environ.get("MONGO_URL")
    if not mongo:
        sys.exit("Falta MONGODB_URL")
    db = pymongo.MongoClient(mongo)[args.db]
    cfg = pn.merge_config(db.wms_part_number_config.find_one({"config_id": "main"}, {"_id": 0, "config_id": 0}))

    if args.revert:
        res = db.wms_boxes.update_many(
            {"part_number_batch": args.revert, "part_number_source": "inferred"},
            {"$unset": {"part_number": "", "part_number_source": "", "part_number_batch": "", "part_number_inferred_at": ""}})
        db.wms_movements.insert_one({"movement_id": f"mv_{os.urandom(6).hex()}", "type": "part_number_backfill_reverted",
                                     "user_id": "script", "user_name": "immex_backfill (script)", "created_at": now_iso(),
                                     "details": {"batch": args.revert, "boxes": res.modified_count}})
        print(f"lote {args.revert}: part_number retirado de {res.modified_count:,} cajas")
        return

    q = {"units": {"$gt": 0}, "status": {"$nin": list(LIVE_OUT)}}
    if args.customer:
        q["customer"] = {"$regex": f"^{args.customer.strip()}$", "$options": "i"}
    fields = {"_id": 0, "box_id": 1, "customer": 1, "style": 1, "color": 1, "size": 1, "description": 1,
              "fabric_content": 1, "country_of_origin": 1, "coo": 1, "location": 1, "units": 1, "part_number": 1, "asn_reference": 1}
    boxes = list(db.wms_boxes.find(q, fields))

    rows = []
    by_cust = collections.defaultdict(lambda: {"cajas": 0, "pz": 0, "con_pn": 0, "ok": 0, "ok_pz": 0, "fallas": collections.Counter()})
    causas = collections.Counter()      # (causa, cliente, valor) -> cajas
    estilos = collections.defaultdict(lambda: {"cajas": 0, "descs": collections.Counter(), "prendas": collections.Counter(), "clientes": set()})
    for b in boxes:
        cust = (b.get("customer") or "").strip()
        style = (b.get("style") or "").strip()
        desc = (b.get("description") or "").strip()
        fab = (b.get("fabric_content") or "").strip()
        country = (b.get("country_of_origin") or b.get("coo") or "").strip()
        units = int(b.get("units") or 0)
        c = by_cust[cust or "(sin cliente)"]
        c["cajas"] += 1
        c["pz"] += units
        est = estilos[(cust, style)]
        est["cajas"] += 1
        est["descs"][desc or "(vacía)"] += 1
        est["clientes"].add(cust)
        if b.get("part_number"):
            c["con_pn"] += 1
            rows.append([b.get("box_id"), cust, style, b.get("color", ""), b.get("size", ""), desc, fab, country, b.get("location", ""), units, b["part_number"], b["part_number"], "ya lo tiene (entrada)", b.get("asn_reference", "")])
            continue
        p = pn.parse_description(desc, cfg)
        est["prendas"][(p["gender"] or "") + (p["garment"] or "?")] += 1
        r = pn.compose(cust, p["garment"], p["gender"], fab, country, cfg=cfg)
        if r["ok"]:
            c["ok"] += 1
            c["ok_pz"] += units
            rows.append([b.get("box_id"), cust, style, b.get("color", ""), b.get("size", ""), desc, fab, country, b.get("location", ""), units,
                         to_profile(r["part_number"], cust, "legacy"), r["part_number"], "", ""])
        else:
            errs = []
            for e in r["errors"]:
                key = e.split(":")[0].strip()
                c["fallas"][key] += 1
                errs.append(e)
                if key.startswith("prenda"):
                    causas[("descripción sin prenda", cust, desc or "(vacía)")] += 1
                elif key.startswith("cliente"):
                    causas[("cliente sin prefijo", cust, cust or "(vacío)")] += 1
                elif key.startswith("país"):
                    causas[("país sin código", cust, country or "(vacío)")] += 1
                elif key.startswith("composición") or key.startswith("fibra"):
                    causas[("composición no válida", cust, fab or "(vacía)")] += 1
                else:
                    causas[(key, cust, "")] += 1
            rows.append([b.get("box_id"), cust, style, b.get("color", ""), b.get("size", ""), desc, fab, country, b.get("location", ""), units, "", "", "; ".join(errs), ""])

    import xlsxwriter
    out = args.out or os.path.join(BE, "..", f"Reporte_IMMEX_ID_preview_{dt.date.today().isoformat()}.xlsx")
    wb = xlsxwriter.Workbook(out)
    bold = wb.add_format({"bold": True})
    pct = wb.add_format({"num_format": "0%"})

    ws = wb.add_worksheet("Resumen")
    hdr = ["Cliente", "Prefijo", "Cajas vivas", "Piezas", "Ya con IMMEX ID", "Componibles", "% componible", "Piezas componibles",
           "Sin prenda", "Sin prefijo", "Sin país", "Sin composición"]
    for i, h in enumerate(hdr):
        ws.write(0, i, h, bold)
    tot = {"cajas": 0, "pz": 0, "con_pn": 0, "ok": 0, "ok_pz": 0}
    for r_i, (cust, c) in enumerate(sorted(by_cust.items(), key=lambda kv: -kv[1]["cajas"]), 1):
        pend = c["cajas"] - c["con_pn"]
        ws.write_row(r_i, 0, [cust, cfg["customers"].get(pn.norm(cust), ""), c["cajas"], c["pz"], c["con_pn"], c["ok"]])
        ws.write(r_i, 6, (c["ok"] / pend) if pend else 1, pct)
        ws.write_row(r_i, 7, [c["ok_pz"], c["fallas"].get("prenda no reconocida", 0), c["fallas"].get("cliente sin prefijo", 0),
                              c["fallas"].get("país sin código de 2 letras", 0), c["fallas"].get("composición vacía", 0)])
        for k in tot:
            tot[k] += c[k]
    r_i = len(by_cust) + 2
    ws.write(r_i, 0, "TOTAL", bold)
    ws.write_row(r_i, 2, [tot["cajas"], tot["pz"], tot["con_pn"], tot["ok"]])
    pend = tot["cajas"] - tot["con_pn"]
    ws.write(r_i, 6, (tot["ok"] / pend) if pend else 1, pct)
    ws.write(r_i, 7, tot["ok_pz"])
    ws.set_column(0, 0, 26); ws.set_column(1, 11, 14)

    ws2 = wb.add_worksheet("Causas")
    for i, h in enumerate(["Causa", "Cliente", "Valor en la caja", "Cajas afectadas", "Qué hacer"], 0):
        ws2.write(0, i, h, bold)
    accion = {"descripción sin prenda": "Agregar palabra clave en Configuración → Prendas (o mapa estilo→prenda)",
              "cliente sin prefijo": "Dar de alta el prefijo en Configuración → Clientes",
              "país sin código": "Capturar país en la caja o agregarlo en Configuración → Países",
              "composición no válida": "Capturar/corregir contenido de tela en la caja"}
    for r_i, ((causa, cust, val), n) in enumerate(sorted(causas.items(), key=lambda kv: -kv[1]), 1):
        ws2.write_row(r_i, 0, [causa, cust, val, n, accion.get(causa, "")])
    ws2.set_column(0, 0, 24); ws2.set_column(1, 1, 24); ws2.set_column(2, 2, 44); ws2.set_column(4, 4, 60)

    ws3 = wb.add_worksheet("Estilos")
    for i, h in enumerate(["Cliente", "Estilo", "Cajas", "Descripciones vistas", "Prenda propuesta (desde descripción)", "Prenda a asignar (llenar)"], 0):
        ws3.write(0, i, h, bold)
    for r_i, ((cust, style), e) in enumerate(sorted(estilos.items(), key=lambda kv: -kv[1]["cajas"]), 1):
        descs = "; ".join(f"{d} ({n})" for d, n in e["descs"].most_common(4))
        prendas = "; ".join(f"{g} ({n})" for g, n in e["prendas"].most_common(3))
        ws3.write_row(r_i, 0, [cust, style, e["cajas"], descs, prendas, ""])
    ws3.set_column(0, 0, 24); ws3.set_column(1, 1, 14); ws3.set_column(3, 3, 60); ws3.set_column(4, 4, 30); ws3.set_column(5, 5, 22)

    ws4 = wb.add_worksheet("Detalle")
    for i, h in enumerate(["Caja", "Cliente", "Estilo", "Color", "Talla", "Descripción", "Contenido", "País", "Ubicación", "Piezas",
                           "IMMEX ID (perfil legado: HO/AP/CH)", "IMMEX ID (gramática actual)", "Error", "Entrada"], 0):
        ws4.write(0, i, h, bold)
    for r_i, row in enumerate(rows, 1):
        ws4.write_row(r_i, 0, row)
    ws4.set_column(0, 0, 14); ws4.set_column(5, 7, 30); ws4.set_column(10, 12, 30)
    wb.close()

    if args.apply:
        col = 10 if args.profile == "legacy" else 11
        batch = f"immex_{dt.datetime.now().strftime('%Y%m%d_%H%M%S')}_{args.profile}"
        per_cust = collections.Counter(); per_cust_pz = collections.Counter(); sample = collections.defaultdict(collections.Counter)
        n_written = 0
        for row in rows:
            code = row[col]
            if not code or row[12]:  # sin código o ya lo tenía / error
                continue
            res = db.wms_boxes.update_one(
                {"box_id": row[0], "$or": [{"part_number": {"$exists": False}}, {"part_number": ""}, {"part_number": None}]},
                {"$set": {"part_number": code, "part_number_source": "inferred", "part_number_batch": batch, "part_number_inferred_at": now_iso()}})
            if res.modified_count:
                n_written += 1; per_cust[row[1]] += 1; per_cust_pz[row[1]] += int(row[9] or 0); sample[row[1]][code] += 1
        for cust, n in per_cust.items():
            db.wms_movements.insert_one({"movement_id": f"mv_{os.urandom(6).hex()}", "type": "part_number_backfilled",
                                         "user_id": "script", "user_name": "immex_backfill (script)", "created_at": now_iso(),
                                         "details": {"batch": batch, "profile": args.profile, "customer": cust, "boxes": n, "units": per_cust_pz[cust],
                                                     "codes": dict(sample[cust].most_common(15)),
                                                     "reason": "IMMEX ID inferido de cliente/descripción/tela/país de la caja (material previo a Entradas fase 2)"}})
        print(f"APLICADO lote {batch} (perfil {args.profile}): {n_written:,} cajas con part_number; por cliente: {dict(per_cust)}")
        print(f"revertir: python backend/scripts/immex_backfill_preview.py --revert {batch}")

    print(f"cajas vivas: {tot['cajas']:,} · piezas: {tot['pz']:,} · ya con IMMEX ID: {tot['con_pn']:,}")
    print(f"componibles hoy: {tot['ok']:,} ({tot['ok_pz']:,} pz) = {tot['ok'] * 100 // max(1, pend)}% de las pendientes")
    print(f"reporte: {os.path.abspath(out)}")


if __name__ == "__main__":
    main()
