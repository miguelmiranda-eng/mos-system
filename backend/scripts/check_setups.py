import asyncio, os
from motor.motor_asyncio import AsyncIOMotorClient
from dotenv import load_dotenv

async def check():
    load_dotenv('.env')
    mongo_url = os.environ.get('MONGODB_URL')
    client = AsyncIOMotorClient(mongo_url)
    db = client['mos-system']
    
    # Check setup times
    pipeline = [
        {"$group": {"_id": "$setup_time", "count": {"$sum": 1}}},
        {"$sort": {"_id": 1}}
    ]
    results = await db.production_logs.aggregate(pipeline).to_list(100)
    print("Setup Time Distribution:")
    for r in results:
        print(f"Value: {r['_id']} | Count: {r['count']}")
    
    # Check if there are logs with 0 setup time
    zero_setups = await db.production_logs.find({"setup_time": 0}).to_list(10)
    print(f"\nExample logs with 0 setup time: {len(zero_setups)}")
    for l in zero_setups[:5]:
        print(f"LogID: {l.get('log_id')} | Client: {l.get('client')} | Produced: {l.get('quantity_produced')}")

if __name__ == '__main__':
    asyncio.run(check())
