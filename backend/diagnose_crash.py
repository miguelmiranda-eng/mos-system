
import asyncio
import os
from motor.motor_asyncio import AsyncIOMotorClient
from dotenv import load_dotenv

load_dotenv("backend/.env")

async def check():
    mongo_url = os.getenv("MONGO_URL")
    client = AsyncIOMotorClient(mongo_url)
    db = client["mos-system"]
    
    # Check orders in scheduling/blanks
    orders = await db.orders.find({"board": {"$regex": "^scheduling$|^blanks$", "$options": "i"}}).to_list(100)
    print(f"Checking {len(orders)} orders for object fields...")
    
    found = False
    for o in orders:
        for k in ["style", "color", "job_title_a", "job_title_b", "blank_status", "client", "customer", "branding"]:
            v = o.get(k)
            if isinstance(v, dict):
                print(f"Order {o.get('order_number')}: Key '{k}' is OBJECT: {v}")
                found = True
    
    if not found:
        print("No objects found in analyzed keys.")

if __name__ == "__main__":
    asyncio.run(check())
