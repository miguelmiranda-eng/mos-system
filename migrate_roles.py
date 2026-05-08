import asyncio
import os
from motor.motor_asyncio import AsyncIOMotorClient
from dotenv import load_dotenv
from pathlib import Path

async def migrate_roles():
    load_dotenv(Path('backend/.env'))
    mongo_url = os.environ.get('MONGO_URL') or os.environ.get('MONGODB_URI') or os.environ.get('MONGODB_URL')
    if not mongo_url:
        mongo_url = "mongodb://localhost:27017/mos"
    
    print(f"Connecting to {mongo_url}...")
    client = AsyncIOMotorClient(mongo_url)
    db = client.get_database()
    
    # 1. Migrate CEO to ADMIN
    res_ceo = await db.users.update_many({"role": "ceo"}, {"$set": {"role": "admin"}})
    print(f"Migrated {res_ceo.modified_count} CEOs to Admin.")
    
    # 2. Migrate others (picker, operator, user, etc.) to GENERAL
    res_gen = await db.users.update_many(
        {"role": {"$nin": ["admin", "general"]}}, 
        {"$set": {"role": "general"}}
    )
    print(f"Migrated {res_gen.modified_count} legacy users to General.")
    
    print("Migration complete.")

if __name__ == "__main__":
    asyncio.run(migrate_roles())
