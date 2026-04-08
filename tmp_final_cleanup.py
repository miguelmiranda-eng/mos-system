from motor.motor_asyncio import AsyncIOMotorClient
import asyncio
import os
import re
from pathlib import Path
from dotenv import load_dotenv

async def check_remaining():
    env_path = Path('backend/.env')
    load_dotenv(env_path)
    
    mongo_url = os.environ.get('MONGODB_URL')
    client = AsyncIOMotorClient(mongo_url)
    db = client["mos-system"]
    
    order = await db.orders.find_one({"design_num": {"$exists": True}})
    if order:
        print(f"Found order with design_num: ID={order.get('order_id')}, OrderNum={order.get('order_number')}")
        # Move it manually
        val = order.get("design_num")
        await db.orders.update_one(
            {"order_id": order.get("order_id")},
            {"$set": {"design_#": val}, "$unset": {"design_num": ""}}
        )
        print("Moved design_num to design_# for this order.")
    else:
        print("No orders found with design_num.")
    
    client.close()

if __name__ == "__main__":
    asyncio.run(check_remaining())
