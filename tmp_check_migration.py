import asyncio
import os
from motor.motor_asyncio import AsyncIOMotorClient
from dotenv import load_dotenv
from pathlib import Path

async def check_orders():
    # Load backend .env
    env_path = Path("backend") / ".env"
    load_dotenv(env_path)
    
    mongo_url = os.environ.get('MONGODB_URL')
    if not mongo_url:
        print("MONGODB_URL not found in backend/.env")
        return
        
    client = AsyncIOMotorClient(mongo_url)
    # Extract DB name from URL if possible, otherwise default to 'mos-system'
    # The URL usually looks like mongodb://.../dbname?options
    db_name = mongo_url.split('/')[-1].split('?')[0] or "mos-system"
    db = client[db_name]
    
    print(f"Connecting to DB: {db_name}")
    
    # Check total order count
    total_orders = await db.orders.count_documents({})
    print(f"Total orders in DB: {total_orders}")
    
    # Check for specific fields in a few orders
    sample_orders = await db.orders.find({}, {"_id": 0, "order_number": 1, "color": 1, "design_#": 1, "final_bill": 1}).limit(5).to_list(5)
    print("\nSample orders with migration fields:")
    for o in sample_orders:
        print(f"  Order {o.get('order_number')}:")
        print(f"    Color: {o.get('color')}")
        print(f"    Design #: {o.get('design_#')}")
        print(f"    Final Bill: {o.get('final_bill')}")
        
    # Check for order 989 specifically (from the backup we saw)
    order_989 = await db.orders.find_one({"order_number": "989"}, {"_id": 0})
    if order_989:
        print(f"\nOrder 989 found:")
        print(f"  Color: {order_989.get('color')}")
        print(f"    Design #: {order_989.get('design_#')}")
        print(f"    Final Bill: {order_989.get('final_bill')}")
    else:
        print("\nOrder 989 NOT found in DB.")

if __name__ == "__main__":
    asyncio.run(check_orders())
