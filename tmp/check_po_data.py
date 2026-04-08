import asyncio
from motor.motor_asyncio import AsyncIOMotorClient

async def check_po_number():
    url = "mongodb://miranda:Mirandam2@187.124.232.150:27017/mos-system?authSource=admin"
    client = AsyncIOMotorClient(url)
    db = client["mos-system"]
    
    count = await db.orders.count_documents({"po_number": {"$ne": None, "$ne": ""}})
    print(f"Orders with po_number: {count}")
    
    if count > 0:
        order = await db.orders.find_one({"po_number": {"$ne": None, "$ne": ""}})
        print(f"Example po_number: {order['po_number']}")
        
    client.close()

if __name__ == "__main__":
    asyncio.run(check_po_number())
