from motor.motor_asyncio import AsyncIOMotorClient
import asyncio
import os
import re
from pathlib import Path
from dotenv import load_dotenv

async def migrate_design_field():
    env_path = Path('backend/.env')
    load_dotenv(env_path)
    
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
    
    # Check current state 
    num_with_num = await db.orders.count_documents({"design_num": {"$exists": True}})
    print(f"Documents to migrate (with 'design_num'): {num_with_num}")
    
    if num_with_num == 0:
        print("Nothing to migrate.")
        return

    # Migration: Rename design_num to design_#
    # Note: If design_# already exists, we might want to be careful, 
    # but usually it's one or the other.
    result = await db.orders.update_many(
        {"design_num": {"$exists": True}},
        {"$rename": {"design_num": "design_#"}}
    )
    
    print(f"Migration completed. Documents updated: {result.modified_count}")
    
    # Final check
    remaining = await db.orders.count_documents({"design_num": {"$exists": True}})
    total_with_hash = await db.orders.count_documents({"design_#": {"$exists": True}})
    print(f"Documents remaining with 'design_num': {remaining}")
    print(f"Total documents with 'design_#': {total_with_hash}")
    
    client.close()

if __name__ == "__main__":
    asyncio.run(migrate_design_field())
