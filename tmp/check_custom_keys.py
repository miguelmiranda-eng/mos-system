import asyncio
from motor.motor_asyncio import AsyncIOMotorClient

async def check_data():
    url = "mongodb://miranda:Mirandam2@187.124.232.150:27017/mos-system?authSource=admin"
    client = AsyncIOMotorClient(url)
    db = client["mos-system"]
    
    # Check if any order has 'Blanck po #' or similar in custom_fields
    cursor = db.orders.find({"custom_fields": {"$exists": True}})
    found_keys = set()
    async for order in cursor:
        for key in order.get("custom_fields", {}).keys():
            found_keys.add(key)
    
    print("Keys found in custom_fields across all orders:")
    for key in found_keys:
        print(f"  - {key}")
        
    client.close()

if __name__ == "__main__":
    asyncio.run(check_data())
