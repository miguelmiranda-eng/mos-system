import asyncio
from motor.motor_asyncio import AsyncIOMotorClient

async def check_original_bpo():
    url = "mongodb://miranda:Mirandam2@187.124.232.150:27017/mos-system?authSource=admin"
    client = AsyncIOMotorClient(url)
    db = client["mos-system"]
    
    cursor = db.orders.find({"bpo_(blank_po#)": {"$ne": None, "$ne": ""}}).limit(5)
    async for order in cursor:
        print(f"Order {order.get('order_number')}: bpo_(blank_po#) = {order.get('bpo_(blank_po#)')}")
        
    client.close()

if __name__ == "__main__":
    asyncio.run(check_original_bpo())
