import asyncio
import os
from motor.motor_asyncio import AsyncIOMotorClient
from dotenv import load_dotenv
from pathlib import Path

async def check():
    load_dotenv(Path('.env'))
    mongo_url = os.environ.get('MONGODB_URL')
    client = AsyncIOMotorClient(mongo_url)
    db = client.get_database()
    col = db.activity_logs
    
    search_term = "TEST123"
    query = {"$or": [
        {"details.order_number": {"$regex": search_term, "$options": "i"}},
        {"details.order_id": {"$regex": search_term, "$options": "i"}}
    ]}
    count = await col.count_documents(query)
    print(f"Logs for {search_term}: {count}")
    if count > 0:
        logs = await col.find(query).limit(3).to_list(3)
        for l in logs:
            print(f"  - Action: {l['action']}, Details: {l['details']}")
    
    # Check for order 927 as the user requested
    search_term = "927"
    count = await col.count_documents({"details.order_number": {"$regex": search_term, "$options": "i"}})
    print(f"Logs for {search_term}: {count}")

if __name__ == "__main__":
    asyncio.run(check())
