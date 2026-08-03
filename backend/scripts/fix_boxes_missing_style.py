"""Devuelve el `style` a las cajas que lo perdieron, para que el WMS pueda verlas.

EL PROBLEMA
───────────
Hay cajas con material físico real cuyo campo `style` está vacío (o trae el
placeholder "(SIN IDENTIFICAR)"). Son invisibles para la operación:

  · `_reproject_material_rows` las ignora — sin style no hay material que
    proyectar, así que su renglón nunca se crea ni se corrige.
  · `_compute_size_locations` no las ofrece al picker: busca por style/sku y
    estas cajas no casan con ninguno.
  · el escaneo de fantasmas las tira al balde `sin_identidad`, que no dice QUÉ
    hay dentro, sólo que hay algo.

Medido contra producción el 2026-08-03: 358 cajas, 14,311 unidades, 79
ubicaciones. GTS TRACTOR es el más golpeado — 7,321 u, el 13.8% de TODO su
inventario, material que está en el piso y que el sistema no puede surtir.

DE DÓNDE SALE EL DATO PERDIDO
─────────────────────────────
De la propia caja: el campo `sku` conserva el style (el import de Excel llenó
`sku` pero no `style`). No se inventa nada — se copia lo que la caja ya trae.

NIVELES DE EVIDENCIA (el script NO trata todo igual)
────────────────────────────────────────────────────
  A · FUERTE   el `sku` es un style conocido del sistema Y existe un renglón de
               inventario con ESE style en la MISMA celda (ubicación+color+talla).
               El renglón fue creado para estas cajas; sólo perdieron el vínculo.
               Se repara por defecto.
  B · MEDIA    el `sku` es un style conocido, pero ninguna fila lo respalda en
               esa celda. Probable, no probado. Requiere --incluir-b.
  C · NULA     el `sku` no sirve (es el propio box_id, o el placeholder de la
               conciliación PDA). NUNCA se toca: hay que abrir la caja en piso.
               Son las cajas de 72 u que crea recon_commit al escanear un código
               que no reconoce.

QUÉ NO HACE
───────────
No toca `wms_inventory`. Reparar la caja es sólo el primer paso; el renglón se
recalcula DESPUÉS con:

    python backend/scripts/reproject_inventory_from_boxes.py --only <UBICACION> --apply

El script imprime al final la lista exacta de ubicaciones a reproyectar.

REVERSIBLE
──────────
Antes de escribir deja un respaldo JSON con el documento íntegro de cada caja
tocada, y registra un movimiento `box_style_restored` por caja.

USO
───
    python backend/scripts/fix_boxes_missing_style.py                 # dry-run (default)
    python backend/scripts/fix_boxes_missing_style.py --apply         # aplica nivel A
    python backend/scripts/fix_boxes_missing_style.py --incluir-b     # dry-run A+B
    python backend/scripts/fix_boxes_missing_style.py --incluir-b --apply
    python backend/scripts/fix_boxes_missing_style.py --revertir <archivo.json>
"""
import argparse
import json
import os
import sys
import uuid
from collections import defaultdict
from datetime import datetime, timezone

import pymongo

MONGODB_URL = os.environ.get("MONGODB_URL")
DB_NAME = os.environ.get("DB_NAME", "mos-system")

PLACEHOLDER = "(SIN IDENTIFICAR)"

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")


def norm(v):
    return str(v or "").strip().upper()


def ahora():
    return datetime.now(timezone.utc).isoformat()


def sin_style(b):
    s = norm(b.get("style"))
    return not s or s == PLACEHOLDER


def styles_conocidos(db):
    """Catálogo de styles reales, tomado de las cajas y renglones sanos."""
    out = set()
    for coll in ("wms_boxes", "wms_inventory"):
        for s in db[coll].distinct("style"):
            n = norm(s)
            if n and n != PLACEHOLDER:
                out.add(n)
    return out


def clasificar(db, conocidos):
    """Devuelve (plan, descartadas). plan = [(caja, style, nivel)]."""
    cajas = list(db.wms_boxes.find({
        "units": {"$gt": 0},
        "$or": [{"style": None}, {"style": ""}, {"style": {"$exists": False}},
                {"style": PLACEHOLDER}],
    }))
    plan, descartadas = [], []
    # Cache de renglones por celda para no golpear Mongo una vez por caja.
    cache = {}
    for b in cajas:
        sku = norm(b.get("sku"))
        bid = norm(b.get("box_id"))
        # C — el sku no aporta identidad: es el propio box_id, un LPN sintético
        # o el placeholder de la conciliación.
        if (not sku or sku == bid or sku.startswith(("LPN", "BOX-"))
                or PLACEHOLDER.replace(" ", "-") in sku or PLACEHOLDER in sku):
            descartadas.append((b, "sku no identifica el material"))
            continue
        if sku not in conocidos:
            descartadas.append((b, f"'{sku}' no es un style conocido del sistema"))
            continue
        celda = (norm(b.get("location")), norm(b.get("color")), norm(b.get("size")))
        if celda not in cache:
            cache[celda] = {norm(r.get("style")) for r in db.wms_inventory.find(
                {"location": b.get("location"), "color": b.get("color"),
                 "size": b.get("size")}, {"_id": 0, "style": 1})}
        plan.append((b, sku, "A" if sku in cache[celda] else "B"))
    return plan, descartadas


def revertir(db, ruta):
    with open(ruta, encoding="utf-8") as fh:
        respaldo = json.load(fh)
    n = 0
    for doc in respaldo["cajas"]:
        prev = doc.get("style_anterior")
        upd = {"$set": {"style": prev}} if prev is not None else {"$unset": {"style": ""}}
        r = db.wms_boxes.update_one({"box_id": doc["box_id"]}, upd)
        n += r.modified_count
    print(f"Revertidas {n} cajas desde {ruta}")


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--apply", action="store_true", help="escribe (por defecto sólo simula)")
    ap.add_argument("--incluir-b", action="store_true",
                    help="incluye el nivel B (style probable, sin renglón que lo respalde)")
    ap.add_argument("--revertir", metavar="ARCHIVO", help="deshace una corrida desde su respaldo")
    ap.add_argument("--mongo", default=MONGODB_URL)
    args = ap.parse_args()
    if not args.mongo:
        sys.exit("Falta MONGODB_URL")
    db = pymongo.MongoClient(args.mongo)[DB_NAME]

    if args.revertir:
        return revertir(db, args.revertir)

    conocidos = styles_conocidos(db)
    plan, descartadas = clasificar(db, conocidos)
    niveles = {"A": [p for p in plan if p[2] == "A"], "B": [p for p in plan if p[2] == "B"]}

    def u(items):
        return sum(int((i[0] if isinstance(i, tuple) else i).get("units") or 0) for i in items)

    print(f"Styles conocidos en el sistema: {len(conocidos)}")
    print(f"Cajas con stock y sin style    : {len(plan) + len(descartadas)}"
          f"   ({u(plan) + u(descartadas):,} unidades)\n")
    print("=" * 78)
    print("PLAN")
    print("=" * 78)
    print(f"  A · renglón en la celda respalda el style : {len(niveles['A']):>4} cajas  {u(niveles['A']):>8,} u")
    print(f"  B · style conocido, sin renglón que apoye : {len(niveles['B']):>4} cajas  {u(niveles['B']):>8,} u")
    print(f"  C · sin identidad recuperable (NO se toca): {len(descartadas):>4} cajas  {u(descartadas):>8,} u")

    aplicables = niveles["A"] + (niveles["B"] if args.incluir_b else [])
    if not aplicables:
        print("\nNada por reparar con los niveles seleccionados.")
        return

    print(f"\n  -> se repararán {len(aplicables)} cajas ({u(aplicables):,} u)"
          f"{' (niveles A+B)' if args.incluir_b else ' (sólo nivel A)'}")

    por_style = defaultdict(lambda: {"n": 0, "u": 0, "locs": set()})
    for b, st, _n in aplicables:
        g = por_style[st]
        g["n"] += 1
        g["u"] += int(b.get("units") or 0)
        g["locs"].add(b.get("location"))
    print(f"\n  {'style':<22}{'cajas':>7}{'unidades':>11}{'ubicaciones':>13}")
    for st, g in sorted(por_style.items(), key=lambda x: -x[1]["u"]):
        print(f"  {st[:21]:<22}{g['n']:>7}{g['u']:>11,}{len(g['locs']):>13}")

    ubis = sorted({b.get("location") for b, _s, _n in aplicables if b.get("location")})
    if descartadas:
        print(f"\n  Las {len(descartadas)} cajas del nivel C quedan para piso "
              f"({u(descartadas):,} u). Ejemplos:")
        for b, motivo in descartadas[:5]:
            print(f"    {str(b.get('box_id'))[:22]:<24}{str(b.get('location'))[:12]:<14}"
                  f"u={str(b.get('units')):<5}{motivo}")

    if not args.apply:
        print(f"\n  DRY-RUN. Nada escrito. Repite con --apply para aplicar.")
        print(f"  Después habrá que reproyectar {len(ubis)} ubicaciones.")
        return

    # ── Respaldo ANTES de tocar nada ────────────────────────────────────────
    lote = "sty_" + uuid.uuid4().hex[:12]
    ruta = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                        f"backup_{lote}.json")
    with open(ruta, "w", encoding="utf-8") as fh:
        json.dump({"lote": lote, "creado": ahora(),
                   "cajas": [{"box_id": b.get("box_id"),
                              "style_anterior": b.get("style"),
                              "style_nuevo": st, "nivel": n,
                              "doc": {k: v for k, v in b.items() if k != "_id"}}
                             for b, st, n in aplicables]},
                  fh, ensure_ascii=False, indent=1, default=str)
    print(f"\n  Respaldo: {ruta}")

    tocadas = 0
    for b, st, nivel in aplicables:
        r = db.wms_boxes.update_one(
            {"box_id": b.get("box_id")},
            {"$set": {"style": st, "style_restored_at": ahora(),
                      "style_restored_batch": lote}})
        if not r.modified_count:
            continue
        tocadas += 1
        db.wms_movements.insert_one({
            "movement_id": "mov_" + uuid.uuid4().hex[:12],
            "type": "box_style_restored",
            "details": {"box_id": b.get("box_id"), "location": b.get("location"),
                        "style_anterior": b.get("style"), "style": st,
                        "sku": b.get("sku"), "color": b.get("color"),
                        "size": b.get("size"), "units": b.get("units"),
                        "nivel_evidencia": nivel, "batch": lote,
                        "reason": "caja sin style: se restauró desde su propio sku"},
            "user_id": None, "user_name": "Sistema (fix_boxes_missing_style)",
            "created_at": ahora(),
        })
    db.wms_incidents.insert_one({
        "incident_id": "inc_" + uuid.uuid4().hex[:12],
        "kind": "boxes_style_restored",
        "mensaje": (f"Se restauró el style a {tocadas} cajas ({u(aplicables):,} u) "
                    f"desde su propio sku. Lote {lote}. Quedan {len(descartadas)} cajas "
                    f"sin identidad recuperable ({u(descartadas):,} u) para conteo en piso."),
        "batch": lote, "cajas": tocadas, "unidades": u(aplicables),
        "user_id": None, "user_name": "Sistema (fix_boxes_missing_style)",
        "created_at": ahora(),
    })
    print(f"  {tocadas} cajas actualizadas.\n")
    print("=" * 78)
    print("SIGUIENTE PASO — reproyectar el inventario de las ubicaciones tocadas")
    print("=" * 78)
    for loc in ubis:
        print(f"  python backend/scripts/reproject_inventory_from_boxes.py --only \"{loc}\" --apply")
    print(f"\n  Para deshacer: --revertir {ruta}")


if __name__ == "__main__":
    main()
