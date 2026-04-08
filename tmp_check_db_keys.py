from motor.motor_asyncio import AsyncIOMotorClient
import asyncio
import os
import re
from pathlib import Path
from dotenv import load_dotenv

async def check_keys():
    # Look for .env in backend directory
    env_path = Path('backend/.env')
    print(f"Loading env from: {env_path.absolute()}")
    load_dotenv(env_path)
    
    mongo_url = os.environ.get('MONGO_URL')
    if not mongo_url:
        print("Error: MONGO_URL not found in .env")
        return
        
    print(f"MONGO_URL found: {mongo_url[:20]}...")
    
    db_name = os.environ.get('DB_NAME')
    if not db_name:
        match = re.search(r'/([^/?]+)(\?|$)', mongo_url)
        if match:
            db_name = match.group(1)
        else:
            db_name = "mos-system"
            
    print(f"DB_NAME: {db_name}")
            
    client = AsyncIOMotorClient(mongo_url)
    db = client[db_name]
    
    order = await db.orders.find_one({}, {"_id": 0})
    if order:
        print("\nKeys in one order document:")
        for key in order.keys():
            print(f"- {key}")
        
        # Check specifically for design related keys
        design_keys = [k for k in order.keys() if 'design' in k.lower()]
        print(f"\nDesign related keys: {design_keys}")
        
        # Check counts for different possible keys
        num_with_hash = await db.orders.count_documents({"design_#": {"$exists": True}})
        num_with_num = await db.orders.count_documents({"design_num": {"$exists": True}})
        print(f"\nOrders with 'design_#': {num_with_hash}")
        print(f"Orders with 'design_num': {num_with_num}")
    else:
        print("No orders found in database.")
    
    client.close()

if __name__ == "__main__":
    asyncio.run(check_keys())
