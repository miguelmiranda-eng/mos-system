#!/usr/bin/env python3
"""
Fast Extract + Direct MongoDB Import
Extrae todas las ordenes de Emergent en una sola llamada
y las importa directamente a MongoDB (sin pasar por la API de EasyPanel).
"""
import requests
import json
from datetime import datetime
from pymongo import MongoClient, UpdateOne

# ============================================================
#  CONFIG
# ============================================================
EMERGENT_BASE_URL = "https://kanban-mfg-system.emergent.host"
EMERGENT_TOKEN    = "session_62e5d047966f4bb6a111059c12ba3bbe"

MONGO_URL = "mongodb://miranda:Mirandam2@187.124.232.150:27017/mos-system?authSource=admin"
DB_NAME   = "mos-system"

BACKUP_FILE = f"backup_emergent_fast_{datetime.now().strftime('%Y%m%d_%H%M%S')}.json"

# ============================================================
#  PASO 1 - Extraer todas las ordenes de Emergent
# ============================================================
print("=" * 56)
print("  EXTRACCION RAPIDA: Emergent -> MongoDB")
print("=" * 56)
print()

headers = {
    "Authorization": f"Bearer {EMERGENT_TOKEN}",
    "Content-Type": "application/json"
}

print("[FETCH] Obteniendo todas las ordenes de Emergent...")
r = requests.get(f"{EMERGENT_BASE_URL}/api/orders", headers=headers, timeout=60)
if r.status_code != 200:
    print(f"[ERROR] {r.status_code}: {r.text[:300]}")
    exit(1)

orders = r.json()
print(f"[OK] {len(orders)} ordenes obtenidas")
print(f"[INFO] Campos disponibles: {list(orders[0].keys()) if orders else 'ninguno'}")

# Guardar backup
data = {"orders": orders, "total": len(orders), "extracted_at": datetime.utcnow().isoformat()}
with open(BACKUP_FILE, "w", encoding="utf-8") as f:
    json.dump(data, f, ensure_ascii=False, indent=2)
size_mb = len(json.dumps(data)) / (1024 * 1024)
print(f"[SAVE] Backup guardado: {BACKUP_FILE} ({size_mb:.2f} MB)")

# ============================================================
#  PASO 2 - Importar directo a MongoDB
# ============================================================
print()
print("[CONN] Conectando a MongoDB...")
client = MongoClient(MONGO_URL, serverSelectionTimeoutMS=10000)
client.server_info()
db = client[DB_NAME]
print("[OK] Conectado")

col_orders = db["orders"]
before = col_orders.count_documents({})
print(f"[STATS] Ordenes actuales en MongoDB: {before}")

# Preparar UPSERT batch
ops = []
for o in orders:
    oid = o.get("order_id")
    if not oid:
        continue
    
    # Extraer comentarios e imagenes si vienen embebidos
    comments    = o.pop("_comments", []) or []
    image_files = o.pop("_image_files", []) or []
    
    o["_migrated_at"] = datetime.utcnow().isoformat()
    
    ops.append(UpdateOne(
        {"order_id": oid},
        {"$set": o},
        upsert=True
    ))

print(f"[PLAN] Ordenes a procesar (upsert): {len(ops)}")

if ops:
    print("[EXEC] Importando...")
    result = col_orders.bulk_write(ops, ordered=False)
    print(f"[OK] Nuevas: {result.upserted_count} | Actualizadas: {result.modified_count}")

after = col_orders.count_documents({})

print()
print("=" * 56)
print("  MIGRACION COMPLETADA")
print("=" * 56)
print(f"  Ordenes antes: {before}")
print(f"  Ordenes ahora: {after}")
print(f"  Diferencia:    +{after - before}")
print(f"  Backup:        {BACKUP_FILE}")
print("=" * 56)
