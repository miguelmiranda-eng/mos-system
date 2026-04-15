import asyncio, os
from motor.motor_asyncio import AsyncIOMotorClient
from dotenv import load_dotenv

async def check():
    load_dotenv('.env')
    mongo_url = os.environ.get('MONGODB_URL')
    client = AsyncIOMotorClient(mongo_url)
    db = client['mos-system']
    
    logs = await db.production_logs.find({}, {"setup": 1}).to_list(1000)
    setup_values = [l.get("setup", 0) for l in logs if l.get("setup") is not None]
    
    total_logs = len(setup_values)
    positive_setups = [s for s in setup_values if s > 0]
    
    if not setup_values:
        print("No setup data found.")
        return

    current_avg = sum(setup_values) / total_logs
    real_setup_avg = sum(positive_setups) / len(positive_setups) if positive_setups else 0
    
    print(f"Total Logs: {total_logs}")
    print(f"Logs with setup > 0: {len(positive_setups)}")
    print(f"Current Dashboard Avg (all logs): {current_avg:.2f} min")
    print(f"Suggested 'Real' Avg (only positive): {real_setup_avg:.2f} min")
    print(f"Negative or zero values: {total_logs - len(positive_setups)}")

if __name__ == '__main__':
    asyncio.run(check())
