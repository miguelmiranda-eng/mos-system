import asyncio
from motor.motor_asyncio import AsyncIOMotorClient
import os
from dotenv import load_dotenv
from pathlib import Path
import json

async def check_order():
    ROOT_DIR = Path(__file__).parent
    load_dotenv(ROOT_DIR / '.env')
    
    # El archivo .env usa MONGODB_URL
    mongo_uri = os.environ.get("MONGODB_URL", "mongodb://localhost:27017")
    client = AsyncIOMotorClient(mongo_uri)
    
    # El nombre de la DB suele estar en la URL, pero si no, intentamos 'mos_system'
    db = client.get_default_database()
    if db is None:
        db = client['mos-system']
    
    order_id = "M-09"
    invoice = await db.invoices.find_one({"invoice_id": order_id})
    
    if invoice:
        # Limpiar para mostrar
        invoice["_id"] = str(invoice["_id"])
        print(f"--- DATOS DE LA FACTURA {order_id} ---")
        print(json.dumps(invoice, indent=2))
    else:
        print(f"ERROR: No se encontró la factura {order_id} en la base de datos {db.name}")

if __name__ == "__main__":
    asyncio.run(check_order())
