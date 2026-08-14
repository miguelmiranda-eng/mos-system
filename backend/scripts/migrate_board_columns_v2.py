"""Migración de columnas del CRM a la estructura 2026-08 (MOS COLUMNS STRUCTURE.xlsx)
y retiro de los layouts por usuario.

QUÉ CAMBIA Y POR QUÉ
────────────────────
1. El layout de columnas pasa a ser UNO para todo el sistema. El endpoint viejo
   de board-layout guardaba en `user_board_layouts` (por usuario): cada quien
   veía un orden distinto y el "global" llevaba congelado desde marzo. El
   backend ya solo lee/escribe `board_layouts` (global, supersu); esta
   migración respalda y elimina los 1,000+ documentos por usuario.

2. Se eliminan tres columnas del set: `blank_source`, `job_title_b` y `notes`
   (marcadas en rojo en el Excel). Los DATOS de las órdenes no se tocan —
   siguen en Mongo y otros módulos (QC, Art, Picking) siguen leyendo esos
   campos; solo dejan de existir como columnas del CRM.

3. Se renombran las columnas custom a su etiqueta nueva (verde del Excel):
   la fórmula de `hits_total` se reescribe con KEYS (`[hits_impresiones] *
   [quantity]`) porque el motor resuelve por key o por label, y la fórmula
   vieja referenciaba los labels que aquí mismo estamos cambiando.

4. `board_layouts.MASTER` queda con el orden verde del Excel (Priority
   incluida tras Branding, por instrucción del 2026-08-14). Las vistas
   guardadas pierden sus `hidden_columns`/`column_order` (el frontend ya los
   ignora); `form_fields_config` suelta las llaves eliminadas.

RESPALDOS
─────────
Antes de tocar nada copia `user_board_layouts` y `saved_views` a colecciones
`*_backup_20260814` vía $out — solo si el respaldo no existe ya, para que
correr el script dos veces no pise el respaldo bueno con el estado migrado.

CÓMO SE CORRE
─────────────
    python backend/scripts/migrate_board_columns_v2.py            # simulación
    python backend/scripts/migrate_board_columns_v2.py --aplicar  # escribe
"""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from dotenv import load_dotenv
load_dotenv(os.path.join(os.path.dirname(__file__), "..", ".env"))

from pymongo import MongoClient

APLICAR = "--aplicar" in sys.argv

BACKUP_SUFFIX = "backup_20260814"

# Columnas que dejan de existir en el CRM (rojo del Excel).
DELETED = ["blank_source", "job_title_b", "notes"]

# Etiquetas nuevas de las columnas custom (verde del Excel). Los defaults se
# renombran en frontend/src/lib/constants.js, no aquí.
CUSTOM_RENAMES = {
    "store_po#": "Store PO",
    "hits_impresiones": "Hits per Unit",
    "hits_total": "Hits Total",
    "packing_type": "Packing Type",
    "bpo_(blank_po#)": "BPO #",
    "screens": "Screens",
    "aprobaciones": "Approval Type",
    "preprod": "Pre-Prod",
    "colors": "# Ink Colors",
    "total_quantity": "Final Units Qty",
    "invoice": "Total Amount",
}

# Fórmula reescrita con keys: inmune a renombres de etiqueta presentes y futuros.
HITS_TOTAL_FORMULA = "[hits_impresiones] * [quantity]"

# Orden verde del Excel mapeado a keys. Priority va tras Branding (no estaba en
# el Excel; instrucción explícita: "déjala como está").
NEW_MASTER_ORDER = [
    "order_number", "customer_po", "store_po#", "cancel_date", "design_#",
    "client", "branding", "priority", "quantity", "hits_impresiones",
    "hits_total", "print_positions", "packing_type", "job_title_a",
    "production_status", "bpo_(blank_po#)", "color", "style", "sizes",
    "blank_status", "trim_status", "trim_box", "screens", "artwork_status",
    "aprobaciones", "preprod", "colors", "final_bill", "total_quantity",
    "invoice",
]


def main():
    client = MongoClient(os.environ["MONGODB_URL"], serverSelectionTimeoutMS=10000)
    db = client["mos-system"]
    tag = "[APLICAR]" if APLICAR else "[SIMULACIÓN]"
    print(f"{tag} conectado a {db.name}")

    # ── 1. Respaldos (solo si no existen ya) ─────────────────────────────────
    existing = set(db.list_collection_names())
    for coll in ("user_board_layouts", "saved_views"):
        backup = f"{coll}_{BACKUP_SUFFIX}"
        if backup in existing:
            print(f"  respaldo {backup} ya existe — no se pisa")
            continue
        n = db[coll].count_documents({})
        print(f"  respaldo {backup} <- {coll} ({n} docs)")
        if APLICAR:
            db[coll].aggregate([{"$match": {}}, {"$out": backup}])

    # ── 2. column_config: renombres + fórmula ────────────────────────────────
    cfg = db.column_config.find_one({"config_id": "columns"}) or {}
    customs = cfg.get("custom_columns", [])
    changed = []
    for col in customs:
        key = col.get("key")
        if key in CUSTOM_RENAMES and col.get("label") != CUSTOM_RENAMES[key]:
            changed.append(f"{col.get('label')!r} -> {CUSTOM_RENAMES[key]!r}")
            col["label"] = CUSTOM_RENAMES[key]
        if key == "hits_total" and col.get("formula") != HITS_TOTAL_FORMULA:
            changed.append(f"fórmula hits_total -> {HITS_TOTAL_FORMULA!r}")
            col["formula"] = HITS_TOTAL_FORMULA
    removed_defaults = [k for k in cfg.get("removed_default_columns", []) if k not in DELETED]
    print(f"  column_config: {len(changed)} renombres: {changed}")
    if APLICAR:
        db.column_config.update_one(
            {"config_id": "columns"},
            {"$set": {"custom_columns": customs, "removed_default_columns": removed_defaults}},
        )

    # ── 3. board_layouts (global): MASTER = orden verde; resto sin keys muertas ─
    for lay in db.board_layouts.find({}):
        board = lay.get("board")
        if board == "MASTER":
            print(f"  board_layouts.MASTER: {len(lay.get('column_order', []))} -> {len(NEW_MASTER_ORDER)} columnas, hidden -> []")
            if APLICAR:
                db.board_layouts.update_one(
                    {"_id": lay["_id"]},
                    {"$set": {"column_order": NEW_MASTER_ORDER, "hidden_columns": []}},
                )
        else:
            order = [k for k in lay.get("column_order", []) if k not in DELETED]
            hidden = [k for k in lay.get("hidden_columns", []) if k not in DELETED]
            if order != lay.get("column_order") or hidden != lay.get("hidden_columns"):
                print(f"  board_layouts.{board}: se quitan keys eliminadas")
                if APLICAR:
                    db.board_layouts.update_one(
                        {"_id": lay["_id"]},
                        {"$set": {"column_order": order, "hidden_columns": hidden}},
                    )

    # ── 4. user_board_layouts: retirada (ya respaldada) ──────────────────────
    n = db.user_board_layouts.count_documents({})
    print(f"  user_board_layouts: se eliminan {n} docs (respaldo en user_board_layouts_{BACKUP_SUFFIX})")
    if APLICAR:
        db.user_board_layouts.drop()

    # ── 5. saved_views: fuera hidden_columns/column_order ────────────────────
    q = {"$or": [{"hidden_columns": {"$exists": True}}, {"column_order": {"$exists": True}}]}
    n = db.saved_views.count_documents(q)
    print(f"  saved_views: unset hidden_columns/column_order en {n} docs")
    if APLICAR:
        db.saved_views.update_many({}, {"$unset": {"hidden_columns": "", "column_order": ""}})

    # ── 6. form_fields_config: soltar keys eliminadas ────────────────────────
    ff = db.form_fields_config.find_one({"config_id": "main"}) or {}
    fields = [k for k in ff.get("fields", []) if k not in DELETED]
    hidden_fields = [k for k in ff.get("hidden_fields", []) if k not in DELETED]
    if fields != ff.get("fields") or hidden_fields != ff.get("hidden_fields"):
        print(f"  form_fields_config: fields {len(ff.get('fields', []))}->{len(fields)}, hidden {len(ff.get('hidden_fields', []))}->{len(hidden_fields)}")
        if APLICAR:
            db.form_fields_config.update_one(
                {"config_id": "main"},
                {"$set": {"fields": fields, "hidden_fields": hidden_fields}},
            )

    print(f"{tag} listo")


if __name__ == "__main__":
    main()
