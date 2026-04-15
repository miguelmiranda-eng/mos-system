import asyncio, os
from motor.motor_asyncio import AsyncIOMotorClient
from dotenv import load_dotenv

async def check():
    load_dotenv('.env')
    mongo_url = os.environ.get('MONGODB_URL')
    db_name = os.environ.get('DB_NAME', 'mos-system')
    client = AsyncIOMotorClient(mongo_url)
    db = client[db_name]
    
    shifts = await db.production_logs.distinct('shift')
    clients = await db.production_logs.distinct('client')
    
    print('Unique shifts:', shifts)
    print('Unique clients:', clients)

if __name__ == '__main__':
    asyncio.run(check())
