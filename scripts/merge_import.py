#!/usr/bin/env python3
"""
========================================================
  MOS SYSTEM - Merge Import: Emergent.sh -> MongoDB
========================================================
Lee backup_kanban_emergent.json y hace UPSERT en MongoDB
(187.124.232.150) sin borrar datos existentes.

Uso:
    python scripts/merge_import.py
    python scripts/merge_import.py --dry-run
"""

import json
import sys
import argparse
from datetime import datetime
from pymongo import MongoClient, UpdateOne

# ============================================================
#  CONFIG
# ============================================================
MONGO_URL   = "mongodb://miranda:Mirandam2@187.124.232.150:27017/mos-system?authSource=admin"
DB_NAME     = "mos-system"
BACKUP_FILE = "backup_kanban_emergent.json"

# ============================================================
#  HELPERS
# ============================================================
def log(msg, label="INFO"):
    print(f"  [{label}] {msg}")

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--dry-run', action='store_true', help='Solo muestra estadisticas sin escribir nada')
    args = parser.parse_args()

    dry_run = args.dry_run

    print()
    print("=" * 56)
    print("  MOS SYSTEM - Merge Import Emergent -> EasyPanel MongoDB")
    print("=" * 56)
    if dry_run:
        print("  *** MODO DRY-RUN (no se escribira nada) ***")
    print()

    # 1. Leer backup
    log(f"Leyendo {BACKUP_FILE}...", "FILE")
    try:
        with open(BACKUP_FILE, 'r', encoding='utf-8') as f:
            data = json.load(f)
    except FileNotFoundError:
        print(f"\n  [ERROR] No se encontro '{BACKUP_FILE}'. Ejecuta primero extract_origin.py")
        sys.exit(1)

    orders = data.get('orders', [])
    log(f"Ordenes en backup: {len(orders)}", "DATA")

    if not orders:
        log("El backup esta vacio. Nada que importar.", "WARN")
        sys.exit(0)

    # 2. Conectar a MongoDB
    log(f"Conectando a MongoDB...", "CONN")
    try:
        client = MongoClient(MONGO_URL, serverSelectionTimeoutMS=10000)
        client.server_info()  # Verifica conexion
        db = client[DB_NAME]
        log("Conexion exitosa.", "OK")
    except Exception as e:
        print(f"\n  [ERROR] No se pudo conectar a MongoDB: {e}")
        sys.exit(1)

    col_orders   = db['orders']
    col_comments = db['comments']
    col_images   = db['order_images']

    # 3. Estadisticas previas
    before_orders   = col_orders.count_documents({})
    before_comments = col_comments.count_documents({})
    before_images   = col_images.count_documents({})
    log(f"Estado actual - Ordenes: {before_orders} | Comentarios: {before_comments} | Imagenes: {before_images}", "STATS")

    # 4. Preparar operaciones UPSERT
    order_ops    = []
    comment_ops  = []
    image_ops    = []

    for order in orders:
        oid = order.get('order_id')
        if not oid:
            continue

        # Separar comentarios e imagenes embebidos
        comments    = order.pop('_comments', []) or []
        image_files = order.pop('_image_files', []) or []

        # Anadir timestamp de ultima migracion
        order['_migrated_at'] = datetime.utcnow().isoformat()

        # UPSERT orden
        order_ops.append(UpdateOne(
            {'order_id': oid},
            {'$set': order},
            upsert=True
        ))

        # UPSERT comentarios
        for c in comments:
            cid = c.get('comment_id') or c.get('id')
            if cid:
                comment_ops.append(UpdateOne(
                    {'comment_id': cid},
                    {'$set': {**c, 'order_id': oid}},
                    upsert=True
                ))
            else:
                comment_ops.append(UpdateOne(
                    {'order_id': oid, 'content': c.get('content'), 'created_at': c.get('created_at')},
                    {'$setOnInsert': {**c, 'order_id': oid}},
                    upsert=True
                ))

        # UPSERT imagenes
        for img in image_files:
            img_id = img.get('image_id') or img.get('id')
            if img_id:
                image_ops.append(UpdateOne(
                    {'image_id': img_id},
                    {'$set': {**img, 'order_id': oid}},
                    upsert=True
                ))

    log(f"Ordenes a procesar: {len(order_ops)} | Comentarios: {len(comment_ops)} | Imagenes: {len(image_ops)}", "PLAN")

    if dry_run:
        print()
        print("  *** DRY-RUN completado. No se escribio nada. ***")
        print(f"  Se insertarian/actualizarian {len(order_ops)} ordenes")
        print(f"  Se insertarian/actualizarian {len(comment_ops)} comentarios")
        print(f"  Se insertarian/actualizarian {len(image_ops)} imagenes")
        print()
        return

    # 5. Ejecutar
    print()
    if order_ops:
        log("Importando ordenes...", "EXEC")
        result = col_orders.bulk_write(order_ops, ordered=False)
        log(f"Ordenes nuevas: {result.upserted_count} | Actualizadas: {result.modified_count}", "OK")

    if comment_ops:
        log("Importando comentarios...", "EXEC")
        result = col_comments.bulk_write(comment_ops, ordered=False)
        log(f"Comentarios nuevos: {result.upserted_count} | Actualizados: {result.modified_count}", "OK")

    if image_ops:
        log("Importando imagenes...", "EXEC")
        result = col_images.bulk_write(image_ops, ordered=False)
        log(f"Imagenes nuevas: {result.upserted_count} | Actualizadas: {result.modified_count}", "OK")

    # 6. Estadisticas finales
    after_orders   = col_orders.count_documents({})
    after_comments = col_comments.count_documents({})
    after_images   = col_images.count_documents({})

    print()
    print("=" * 56)
    print("  MIGRACION COMPLETADA")
    print("=" * 56)
    print(f"  Ordenes:     {before_orders} -> {after_orders} (+{after_orders - before_orders})")
    print(f"  Comentarios: {before_comments} -> {after_comments} (+{after_comments - before_comments})")
    print(f"  Imagenes:    {before_images} -> {after_images} (+{after_images - before_images})")
    print("=" * 56)
    print()

if __name__ == "__main__":
    main()
