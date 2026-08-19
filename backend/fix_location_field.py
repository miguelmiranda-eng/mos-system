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
col = client['mos-system']['wms_inventory']

exists_true = {"$exists": True}
exists_false = {"$exists": False}
r = col.update_many(
    {"inv_location": exists_true, "location": exists_false},
    [{"$set": {"location": "$inv_location"}}, {"$unset": "inv_location"}]
)
print("inv_location renamed:", r.modified_count)

sample = col.find_one({"units_on_hand": {"$gt": 0}}, {"_id": 0, "customer": 1, "style": 1, "units_on_hand": 1, "location": 1})
print("sample:", sample)
client.close()
