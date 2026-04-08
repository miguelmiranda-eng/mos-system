import asyncio
from motor.motor_asyncio import AsyncIOMotorClient

async def check_fields():
    url = "mongodb://miranda:Mirandam2@187.124.232.150:27017/mos-system?authSource=admin"
    client = AsyncIOMotorClient(url)
    db = client["mos-system"]
    
    # Get one order to see top-level fields
    order = await db.orders.find_one({})
    if order:
        print("Top-level fields in an order:")
        for key in order.keys():
            if key != '_id':
                print(f"  - {key}: {order[key]}")
        
        # Also check custom_fields
        custom = order.get("custom_fields", {})
        if custom:
            print("\nCustom fields in that order:")
            for key in custom.keys():
                print(f"  - {key}: {custom[key]}")
                
    client.close()

if __name__ == "__main__":
    asyncio.run(check_fields())
