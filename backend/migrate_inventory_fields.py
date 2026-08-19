"""
Migración: renombra 'available' → 'units_on_hand' y agrega 'units_allocated'
en todos los documentos de wms_inventory que no tengan units_on_hand.
Ejecutar UNA sola vez.
"""
from pymongo import MongoClient

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

client = MongoClient(MONGO_URL)
db = client['mos-system']
col = db['wms_inventory']

# Documentos con 'available' pero sin 'units_on_hand' (los del script de limpieza)
result = col.update_many(
    {"available": {"$exists": True}, "units_on_hand": {"$exists": False}},
    [
        {"$set": {
            "units_on_hand": "$available",
            "units_allocated": 0
        }},
        {"$unset": "available"}
    ]
)

print(f"Documentos actualizados: {result.modified_count}")

# También asegurar que todos los docs tengan 'units_allocated'
result2 = col.update_many(
    {"units_allocated": {"$exists": False}},
    {"$set": {"units_allocated": 0}}
)
print(f"units_allocated agregado a: {result2.modified_count} docs")

# También renombrar 'inv_location' → 'location' si aplica
result3 = col.update_many(
    {"inv_location": {"$exists": True}, "location": {"$exists": False}},
    [{"$set": {"location": "$inv_location"}}, {"$unset": "inv_location"}]
)
print(f"inv_location → location: {result3.modified_count} docs")

client.close()
print("Migración completa.")
