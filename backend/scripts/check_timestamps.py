import asyncio, os
from motor.motor_asyncio import AsyncIOMotorClient
from dotenv import load_dotenv
from datetime import datetime, timezone

async def check():
    load_dotenv('.env')
    mongo_url = os.environ.get('MONGODB_URL')
    db_name = os.environ.get('DB_NAME', 'mos-system')
    client = AsyncIOMotorClient(mongo_url)
    db = client[db_name]
    
    logs = await db.production_logs.find({}, {'created_at': 1}).sort('created_at', -1).to_list(5)
    print('Current UTC time:', datetime.now(timezone.utc).isoformat())
    print('Recent log timestamps:', [l['created_at'] for l in logs])

if __name__ == '__main__':
    asyncio.run(check())
