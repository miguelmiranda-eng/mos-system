import asyncio, os
from motor.motor_asyncio import AsyncIOMotorClient
from dotenv import load_dotenv
from datetime import datetime, timezone, timedelta

async def check():
    load_dotenv('.env')
    mongo_url = os.environ.get('MONGODB_URL')
    db_name = os.environ.get('DB_NAME', 'mos-system')
    client = AsyncIOMotorClient(mongo_url)
    db = client[db_name]
    
    # Check all logs in the last 24h
    now = datetime.now(timezone.utc)
    start = now - timedelta(days=1)
    logs = await db.production_logs.find({"created_at": {"$gte": start.isoformat()}}).to_list(100)
    
    print(f"Total logs in last 24h: {len(logs)}")
    for l in logs[:10]:
        print(f"ID: {l.get('log_id')} | Date: {l.get('created_at')} | Client: {l.get('client')} | Produced: {l.get('quantity_produced')}")
    
    # Check shift start calculation
    local_now = now - timedelta(hours=7)
    local_start = local_now.replace(hour=7, minute=0, second=0, microsecond=0)
    if local_now < local_start:
        local_start = local_start - timedelta(days=1)
    utc_start = local_start + timedelta(hours=7)
    
    print(f"Current UTC: {now.isoformat()}")
    print(f"Shift Start (Local): {local_start.isoformat()}")
    print(f"Shift Start (UTC): {utc_start.isoformat()}")
    
    # Count for this specific shift
    count = await db.production_logs.count_documents({"created_at": {"$gte": utc_start.isoformat()}})
    print(f"Logs for current shift: {count}")

if __name__ == '__main__':
    asyncio.run(check())
