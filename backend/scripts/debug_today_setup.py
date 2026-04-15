import asyncio, os
from motor.motor_asyncio import AsyncIOMotorClient
from dotenv import load_dotenv
from datetime import datetime, timezone, timedelta

async def check():
    load_dotenv('.env')
    mongo_url = os.environ.get('MONGODB_URL')
    client = AsyncIOMotorClient(mongo_url)
    db = client['mos-system']
    
    now = datetime.now(timezone.utc)
    local_now = now - timedelta(hours=7)
    local_start = local_now.replace(hour=7, minute=0, second=0, microsecond=0)
    if local_now < local_start:
        local_start = local_start - timedelta(days=1)
    utc_start = local_start + timedelta(hours=7)
    
    query = {"created_at": {"$gte": utc_start.isoformat()}}
    logs = await db.production_logs.find(query).to_list(100)
    
    print(f"Logs today: {len(logs)}")
    setups = [l.get("setup") for l in logs]
    print(f"Raw Setup values: {setups}")
    
    setup_logs = [s for s in setups if s is not None and s > 0]
    print(f"Positive Setups: {setup_logs}")
    
    if setup_logs:
        avg = sum(setup_logs) / len(setup_logs)
        print(f"Calculated Avg: {avg}")
    else:
        print("No positive setup logs found today.")

if __name__ == '__main__':
    asyncio.run(check())
