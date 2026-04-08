import asyncio
from motor.motor_asyncio import AsyncIOMotorClient

async def find_data():
    url = "mongodb://miranda:Mirandam2@187.124.232.150:27017/mos-system?authSource=admin"
    client = AsyncIOMotorClient(url)
    db = client["mos-system"]
    
    # Find orders where bpo_(blank_po#) is not null and not empty
    cursor = db.orders.find({
        "$and": [
            {"bpo_(blank_po#)": {"$exists": True}},
            {"bpo_(blank_po#)": {"$ne": None}},
            {"bpo_(blank_po#)": {"$ne": ""}}
        ]
    }).limit(10)
    
    found = False
    async for order in cursor:
        found = True
        print(f"Order {order.get('order_number')}: bpo_(blank_po#) = {order.get('bpo_(blank_po#)')}")
        
    if not found:
        print("No orders found with non-empty bpo_(blank_po#)")
        # Check all possible PO keys
        print("\nChecking common fields in orders again...")
        order = await db.orders.find_one({"order_number": "409"})
        print(f"Order 409 keys: {list(order.keys())}")
        
    client.close()

if __name__ == "__main__":
    asyncio.run(find_data())
