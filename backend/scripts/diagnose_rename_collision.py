"""Diagnostico de SOLO LECTURA para el E11000 que revienta el rename de catalogo.

QUE HACE
────────
El rename (`POST /catalogs/{ctype}/rename`) hace un `update_many` a ciegas que
pone `field = new` en toda fila cuyo `field` sea `old`. Sobre `wms_inventory` eso
choca con el indice unico `uniq_inventory_material_lote` cuando el rename volveria
DOS filas identicas en (style,color,size,location,country_of_origin,fabric_content):
la fila renombrada aterriza sobre una que ya existe con el valor destino. Mongo lo
rechaza (E11000) y el endpoint devuelve 500. El dato queda intacto — falta fusionar.

Este script NO modifica nada. Reporta:
  1. COLISIONES: que filas de wms_inventory chocarian al renombrar `old`→`new`,
     con la fila sobreviviente (la que ya tiene `new`) y la que se fusionaria,
     mas el respaldo fisico (cajas) de cada lote para prever la fusion.
  2. DRIFT: conteo de `old` y `new` por cada coleccion del barrido, para ver si un
     intento fallido dejo inventario a medio renombrar y los espejos sin tocar
     (wms_inventory va primero en el barrido; si truena ahi, el resto no corre).

MODOS
─────
  # Colision explicita (sabes que se renombro):
  python backend/scripts/diagnose_rename_collision.py --type colors --old pfd --new PFD

  # Descubrir (no sabes el `old`): lista, para el valor destino `new`, todo lote
  # que ya tiene una fila `new` y ademas otra fila con color distinto — esos
  # "otros colores" son los que colisionarian si se renombran a `new`.
  python backend/scripts/diagnose_rename_collision.py --type colors --new PFD

  # Acota a un material/ubicacion (util para el caso puntual del incidente):
  python backend/scripts/diagnose_rename_collision.py --type colors --new PFD --style CK001 --location NA13-C04
"""
import argparse
import os
import sys
from collections import defaultdict

import pymongo

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from services.inventory_ledger import material_keys, row_signature  # noqa: E402

MONGODB_URL = os.environ.get("MONGODB_URL")
DB_NAME = os.environ.get("DB_NAME", "mos-system")

# La consola de Windows revienta con acentos/flechas en cp1252.
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

# Espejo de wms.py:_CATALOG_FIELD_MAP (fuente de verdad alla). Solo lo que este
# diagnostico necesita para el barrido. `colors` es el caso del incidente.
CATALOG_FIELD_MAP = {
    "countries":     ("country_of_origin", ["wms_inventory", "wms_receiving", "wms_boxes", "wms_upc_catalog"]),
    "descriptions":  ("description",       ["wms_inventory", "wms_receiving", "wms_boxes", "wms_upc_catalog"]),
    "fabrics":       ("fabric_content",    ["wms_inventory", "wms_receiving", "wms_boxes", "wms_upc_catalog"]),
    "customers":     ("customer",          ["wms_inventory", "wms_receiving", "wms_boxes", "wms_pick_tickets"]),
    "manufacturers": ("manufacturer",      ["wms_inventory", "wms_receiving", "wms_boxes", "wms_upc_catalog", "wms_pick_tickets"]),
    "colors":        ("color",             ["wms_inventory", "wms_receiving", "wms_boxes", "wms_upc_catalog", "wms_pick_tickets"]),
    "styles":        ("style",             ["wms_inventory", "wms_receiving", "wms_boxes", "wms_upc_catalog", "wms_pick_tickets"]),
    "sizes":         ("size",              ["wms_inventory", "wms_receiving", "wms_boxes", "wms_upc_catalog", "wms_pick_tickets"]),
}

# Llave EXACTA del indice unico uniq_inventory_material_lote (cruda, sin canonicalizar:
# es lo que Mongo compara al validar el indice y lo que genera el E11000).
UNIQUE_KEY = ("style", "color", "size", "location", "country_of_origin", "fabric_content")


def raw_key(row, field=None, new_val=None):
    """Llave del indice unico de una fila. Si field/new_val se pasan, simula el
    valor DESPUES del rename en ese campo."""
    vals = []
    for f in UNIQUE_KEY:
        v = new_val if (field and f == field) else (row.get(f) or "")
        vals.append(v)
    return tuple(vals)


def ci(val):
    import re
    return {"$regex": f"^{re.escape(val)}$", "$options": "i"}


def fisico_del_lote(db, style, color, size, location, firma):
    """Unidades y cajas fisicas que respaldan un lote (misma firma canonicalizada)."""
    keys = material_keys(style, "")
    cajas = list(db.wms_boxes.find({
        "$or": [{"sku": {"$in": keys}}, {"style": {"$in": keys}}],
        "color": color or "", "size": size or "", "location": location,
    }, {"_id": 0, "units": 1, "qty": 1, "country_of_origin": 1, "coo": 1, "fabric_content": 1}))
    cajas = [b for b in cajas if row_signature(b) == firma]
    u = sum(int(b.get("units") or b.get("qty") or 0) for b in cajas)
    return u, len(cajas)


def diagnosticar_colisiones(db, field, old, new_upper, scope):
    inv = db.wms_inventory
    q = dict(scope)
    q[field] = ci(old)
    a_renombrar = list(inv.find(q))
    print(f"Filas de wms_inventory con {field} ~= '{old}' (a renombrar): {len(a_renombrar)}")
    if not a_renombrar:
        print("  (ninguna — revisa el valor 'old' o el --scope)")
        return

    # Agrupa por la llave DESTINO (tras el rename). Si en un grupo cae >1 fila
    # —o ya existe otra fila con esa llave y color==new— hay colision.
    destino = defaultdict(list)
    for r in a_renombrar:
        destino[raw_key(r, field, new_upper)].append(r)

    limpias = colisiones = 0
    for key, movidas in destino.items():
        # ¿ya existe una fila (que NO esta en el set a renombrar) con la llave destino?
        existentes = list(inv.find({UNIQUE_KEY[i]: key[i] for i in range(len(UNIQUE_KEY))}))
        ids_mov = {r["_id"] for r in movidas}
        preexistentes = [r for r in existentes if r["_id"] not in ids_mov]

        if len(movidas) == 1 and not preexistentes:
            limpias += 1
            continue

        colisiones += 1
        style, _color, size, location = key[0], key[1], key[2], key[3]
        coo, fabric = key[4], key[5]
        firma = row_signature({"country_of_origin": coo, "fabric_content": fabric})
        fu, fc = fisico_del_lote(db, style, new_upper, size, location, firma)
        print(f"\n  ✗ COLISION  {style}/{new_upper}/{size} @ {location}  [{coo} · {fabric}]")
        print(f"      fisico del lote (cajas): {fu} u / {fc} cajas")
        for r in preexistentes:
            print(f"      ya existe (sobreviviente natural): color='{r.get('color')}' "
                  f"units_on_hand={r.get('units_on_hand')} allocated={r.get('units_allocated') or 0} "
                  f"sku='{r.get('sku')}' inv_id={r.get('inventory_id')}")
        for r in movidas:
            print(f"      a fusionar:  color='{r.get('color')}' "
                  f"units_on_hand={r.get('units_on_hand')} allocated={r.get('units_allocated') or 0} "
                  f"sku='{r.get('sku')}' inv_id={r.get('inventory_id')}")

    print(f"\n  Resumen: {limpias} renombran limpio, {colisiones} colisionan (bloquean el rename).")
    if colisiones:
        print("  → El rename seguira reventando hasta fusionar estos lotes.")


def descubrir(db, field, new_upper, scope):
    """Sin `old`: encuentra lotes que ya tienen una fila `new` y ademas otra fila
    con `field` distinto — candidatos exactos a colisionar si se renombran a `new`."""
    inv = db.wms_inventory
    con_new = list(inv.find({**scope, field: ci(new_upper)}))
    print(f"Filas de wms_inventory con {field} ~= '{new_upper}': {len(con_new)}")
    if not con_new:
        print("  (no hay fila destino; el rename no colisionaria por este valor)")
        return
    hallados = 0
    for r in con_new:
        # Misma llave de indice pero con CUALQUIER color: hermanas del mismo lote.
        base = {f: (r.get(f) or "") for f in UNIQUE_KEY if f != field}
        hermanas = [h for h in inv.find(base)
                    if (h.get(field) or "").strip().upper() != new_upper.upper()]
        if not hermanas:
            continue
        hallados += 1
        print(f"\n  ⚠ lote {r.get('style')}/{r.get('size')} @ {r.get('location')}  "
              f"[{r.get('country_of_origin')} · {r.get('fabric_content')}]")
        print(f"      destino  {field}='{r.get('color') if field=='color' else r.get(field)}'  "
              f"units_on_hand={r.get('units_on_hand')}")
        for h in hermanas:
            print(f"      colisionaria si renombras '{h.get(field)}' → '{new_upper}'  "
                  f"units_on_hand={h.get('units_on_hand')} sku='{h.get('sku')}'")
    if not hallados:
        print("  Ningun lote comparte llave con otro color. Ningun rename a "
              f"'{new_upper}' colisionaria (con el scope dado).")
    else:
        print(f"\n  {hallados} lote(s) colisionarian. Reintenta con --old <valor> para el detalle completo.")


def drift(db, field, collections, old, new_upper, scope):
    print("\n── DRIFT por coleccion (conteo de old vs new) ──")
    print("   Si inventario ya no tiene 'old' pero los espejos si, el barrido "
          "quedo a medias (inventario va primero).")
    for coll_name in collections:
        coll = db[coll_name]
        # Solo wms_inventory lleva el scope de material; el resto se cuenta global
        # para el valor (no todas tienen style/size/location homogeneos).
        sc = scope if coll_name == "wms_inventory" else {}
        n_old = coll.count_documents({**sc, field: ci(old)}) if old else None
        n_new = coll.count_documents({**sc, field: ci(new_upper)})
        old_txt = f"old='{old}': {n_old}" if old else "old=(n/a)"
        print(f"   {coll_name:<20} {old_txt:<22} new='{new_upper}': {n_new}")


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--type", default="colors", help="tipo de catalogo (default: colors)")
    ap.add_argument("--old", default=None, help="valor viejo que se intento renombrar")
    ap.add_argument("--new", required=True, help="valor destino del rename")
    ap.add_argument("--style", default=None, help="acota a un style")
    ap.add_argument("--location", default=None, help="acota a una ubicacion")
    ap.add_argument("--size", default=None, help="acota a una talla")
    ap.add_argument("--mongo", default=MONGODB_URL)
    args = ap.parse_args()

    if not args.mongo:
        sys.exit("Falta MONGODB_URL (variable de entorno o --mongo)")
    if args.type not in CATALOG_FIELD_MAP:
        sys.exit(f"--type debe ser uno de {sorted(CATALOG_FIELD_MAP)}")

    field, collections = CATALOG_FIELD_MAP[args.type]
    new_upper = args.new.strip().upper()
    scope = {}
    if args.style:
        scope["style"] = ci(args.style.strip())
    if args.location:
        scope["location"] = ci(args.location.strip())
    if args.size:
        scope["size"] = ci(args.size.strip())

    db = pymongo.MongoClient(args.mongo)[DB_NAME]

    tiene_indice = "uniq_inventory_material_lote" in db.wms_inventory.index_information()
    print(f"DB={DB_NAME}  type={args.type}  field='{field}'  new='{new_upper}'"
          + (f"  old='{args.old}'" if args.old else "  (modo descubrir)"))
    print(f"indice unico presente: {tiene_indice}")
    if scope:
        print(f"scope: {scope}")
    print()

    if args.old:
        diagnosticar_colisiones(db, field, args.old.strip(), new_upper, scope)
    else:
        descubrir(db, field, new_upper, scope)

    drift(db, field, collections, args.old.strip() if args.old else None, new_upper, scope)
    print("\n(SOLO LECTURA — nada fue modificado.)")


if __name__ == "__main__":
    main()
