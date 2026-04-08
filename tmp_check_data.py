from motor.motor_asyncio import AsyncIOMotorClient
import asyncio
import os
import re
from pathlib import Path
from dotenv import load_dotenv

async def check_data():
    env_path = Path('backend/.env')
    load_dotenv(env_path)
    
    # Check for MONGODB_URL
    mongo_url = os.environ.get('MONGODB_URL')
    if not mongo_url:
        print("Error: MONGODB_URL not found in .env")
        return
        
    db_name = os.environ.get('DB_NAME')
    if not db_name:
        match = re.search(r'/([^/?]+)(\?|$)', mongo_url)
        if match:
            db_name = match.group(1)
        else:
            db_name = "mos-system"
            
    print(f"Connecting to DB: {db_name}")
            
    client = AsyncIOMotorClient(mongo_url)
    db = client[db_name]
    
    # Count orders with design_num and design_#
    num_with_hash = await db.orders.count_documents({"design_#": {"$exists": True}})
    num_with_num = await db.orders.count_documents({"design_num": {"$exists": True}})
    
    print(f"Orders with 'design_#': {num_with_hash}")
    print(f"Orders with 'design_num': {num_with_num}")
    
    if num_with_num > 0:
        sample = await db.orders.find_one({"design_num": {"$exists": True}})
        print(f"Sample design_num value: {sample.get('design_num')}")
        
    client.close()

if __name__ == "__main__":
    asyncio.run(check_data())
