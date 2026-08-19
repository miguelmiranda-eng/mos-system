import asyncio
import pprint
from motor.motor_asyncio import AsyncIOMotorClient

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


async def main():
    client = AsyncIOMotorClient(MONGO_URL)
    db = client['mos-system']
    doc = await db.invoices.find_one({'invoice_id': 'M-20'}, {'items': 1, 'print_location': 1})
    pprint.pprint(doc)

if __name__ == '__main__':
    asyncio.run(main())
