import asyncio
from motor.motor_asyncio import AsyncIOMotorClient

async def find_bpo():
    url = "mongodb://miranda:Mirandam2@187.124.232.150:27017/mos-system?authSource=admin"
    client = AsyncIOMotorClient(url)
    db = client["mos-system"]
    
    # Common keys in orders
    keys_count = {}
    cursor = db.orders.find().limit(100)
    async for order in cursor:
        for k in order.keys():
            keys_count[k] = keys_count.get(k, 0) + 1
            
    print("Column frequencies (top level):")
    for k, v in sorted(keys_count.items(), key=lambda x: x[1], reverse=True):
        print(f"  {k}: {v}")
        
    print("\nChecking specifically for keys containing 'PO':")
    for k in keys_count:
        if 'PO' in k.upper():
            print(f"  {k}")

    # Check custom_fields too
    cf_keys = {}
    cursor = db.orders.find({"custom_fields": {"$exists": True}}).limit(100)
    async for order in cursor:
        for k in order.get("custom_fields", {}).keys():
            cf_keys[k] = cf_keys.get(k, 0) + 1
            
    print("\nCustom field frequencies:")
    for k, v in sorted(cf_keys.items(), key=lambda x: x[1], reverse=True):
        print(f"  {k}: {v}")

    client.close()

if __name__ == "__main__":
    asyncio.run(find_bpo())
