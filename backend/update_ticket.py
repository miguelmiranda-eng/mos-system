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
db['wms_pick_tickets'].update_one({'ticket_id': 'pick_a5694a939b12'}, {'$set': {'style': '2000'}})
print('Estilo del ticket pick_a5694a939b12 actualizado a 2000')
