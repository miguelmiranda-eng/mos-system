from motor.motor_asyncio import AsyncIOMotorClient
import asyncio
import os
import re
from pathlib import Path
from dotenv import load_dotenv

async def diagnose_design_problem():
    env_path = Path('backend/.env')
    load_dotenv(env_path)
    
    mongo_url = os.environ.get('MONGODB_URL')
    db_name = "mos-system" # Default
    if mongo_url:
        match = re.search(r'/([^/?]+)(\?|$)', mongo_url)
        if match:
            db_name = match.group(1)
            
    client = AsyncIOMotorClient(mongo_url)
    db = client[db_name]
    
    print(f"Diagnosing database: {db_name}")
    
    # Check for orders with design_num (should still be 0 if my migration worked)
    num_with_num = await db.orders.count_documents({"design_num": {"$exists": True}})
    print(f"Orders with 'design_num': {num_with_num}")
    
    # Check for orders with design_# in custom_fields
    num_with_cf = await db.orders.count_documents({"custom_fields.design_#": {"$exists": True}})
    print(f"Orders with 'design_#' in custom_fields: {num_with_cf}")
    
    # Check for orders where design_# exists but is empty
    num_empty = await db.orders.count_documents({"design_#": ""})
    print(f"Orders with empty 'design_#': {num_empty}")
    
    # Check for orders where design_# is missing
    num_missing = await db.orders.count_documents({"design_#": {"$exists": False}})
    print(f"Orders missing 'design_#': {num_missing}")
    
    if num_with_cf > 0:
        sample = await db.orders.find_one({"custom_fields.design_#": {"$exists": True}})
        print(f"Sample order with custom_field design_#: {sample.get('order_number')} (ID: {sample.get('order_id')})")

    # Let's find some recently updated orders
    recent = await db.orders.find().sort("updated_at", -1).limit(5).to_list(None)
    print("\nRecent orders keys:")
    for r in recent:
        keys = r.keys()
        cf_keys = r.get("custom_fields", {}).keys()
        print(f"Order {r.get('order_number')}: RootKeys={list(keys)}, CFKeys={list(cf_keys)}")

    client.close()

if __name__ == "__main__":
    asyncio.run(diagnose_design_problem())
