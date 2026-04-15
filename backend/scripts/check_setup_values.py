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
        {"$group": {"_id": "$setup", "count": {"$sum": 1}}},
        {"$sort": {"_id": 1}}
    ]
    results = await db.production_logs.aggregate(pipeline).to_list(100)
    print("Setup Field Distribution:")
    for r in results:
        val = r['_id']
        print(f"Value: {val} | Type: {type(val)} | Count: {r['count']}")
    
    positives = await db.production_logs.find({"setup": {"$gt": 0}}).to_list(20)
    print(f"\nExample positive setups (Total: {len(positives)}):")
    for l in positives[:10]:
        print(f"LogID: {l.get('log_id')} | Setup: {l.get('setup')} | Raw: {l}")

if __name__ == '__main__':
    asyncio.run(check())
