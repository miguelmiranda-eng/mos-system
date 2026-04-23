"""
Migración: renombra 'available' → 'units_on_hand' y agrega 'units_allocated'
en todos los documentos de wms_inventory que no tengan units_on_hand.
Ejecutar UNA sola vez.
"""
from pymongo import MongoClient

MONGO_URL = "mongodb://miranda:Mirandam2@187.124.232.150:27017/mos-system?authSource=admin"
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
