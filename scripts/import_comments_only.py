import json
import sys
from datetime import datetime
from pymongo import MongoClient, UpdateOne

import os

# La cadena de conexión NO va en el código: se lee del entorno. Estuvo escrita
# aquí, en un repo público, desde marzo de 2026 — con un usuario `root`. Si
# falta, el script se detiene: un valor por defecto es cómo se filtró la
# primera vez.
MONGO_URL = os.environ.get("MONGODB_URL") or os.environ.get("MONGO_URL")
if not MONGO_URL:
    raise SystemExit(
        "Falta MONGODB_URL en el entorno.\n"
        "  PowerShell:  $env:MONGODB_URL = \"mongodb://usuario:clave@host:27017/mos-system?authSource=admin\"\n"
        "  bash:        export MONGODB_URL=\"...\""
    )


# CONFIG
DB_NAME     = "mos-system"
BACKUP_FILE = "backup_emergent_history_20260406_111110.json"

def log(msg, label="INFO"):
    print(f"  [{label}] {msg}")

def main():
    print()
    print("=" * 60)
    print("  MOS SYSTEM - Comment-Only Migration Tool")
    print("=" * 60)
    print()

    # 1. Load backup
    log(f"Reading backup file '{BACKUP_FILE}'...", "FILE")
    try:
        with open(BACKUP_FILE, 'r', encoding='utf-8') as f:
            data = json.load(f)
    except FileNotFoundError:
        print(f"[ERROR] '{BACKUP_FILE}' not found.")
        sys.exit(1)

    orders_backup = data.get('orders', [])
    log(f"Total orders in backup: {len(orders_backup)}", "DATA")

    # 2. Connect to MongoDB
    log("Connecting to MOS MongoDB...", "CONN")
    client = MongoClient(MONGO_URL, serverSelectionTimeoutMS=10000)
    db = client[DB_NAME]
    col_orders   = db['orders']
    col_comments = db['comments']
    log("Connected successfully.", "OK")

    # 3. Process orders
    comment_ops = []
    skipped_orders = 0
    total_comments_found = 0

    for order_data in orders_backup:
        oid = order_data.get('order_id')
        if not oid: continue

        # Verify if order exists in MOS
        exists = col_orders.find_one({"order_id": oid})
        if not exists:
            skipped_orders += 1
            continue

        comments = order_data.get('_comments', [])
        total_comments_found += len(comments)

        for c in comments:
            cid = c.get('comment_id') or c.get('id')
            if not cid: continue

            # Ensure order_id is present
            c['order_id'] = oid
            
            # Remove _id if it's there from source
            if '_id' in c: del c['_id']

            # UPSERT comment
            comment_ops.append(UpdateOne(
                {'comment_id': cid},
                {'$set': c},
                upsert=True
            ))

    log(f"Plan formed: {len(comment_ops)} comments for existing orders in MOS.", "PLAN")
    log(f"Orders skipped (not in MOS): {skipped_orders}", "INFO")

    if not comment_ops:
        log("No comments found to import for existing orders.", "WARN")
        return

    # 4. Execute
    print()
    log(f"Executing {len(comment_ops)} upserts into 'comments' collection...", "EXEC")
    result = col_comments.bulk_write(comment_ops, ordered=False)
    
    log(f"Comments created: {result.upserted_count}", "OK")
    log(f"Comments updated: {result.modified_count}", "OK")

    print()
    print("=" * 60)
    print("  ✅ COMMENT MIGRATION COMPLETED")
    print("=" * 60)
    print()

if __name__ == "__main__":
    main()
