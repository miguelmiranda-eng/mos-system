import asyncio
from motor.motor_asyncio import AsyncIOMotorClient
import os
from dotenv import load_dotenv
from pathlib import Path

async def debug_db():
    backend_dir = Path("backend")
    load_dotenv(backend_dir / ".env")
    
    mongo_url = os.environ.get("MONGODB_URL")
    db_name = os.environ.get("DB_NAME", "mos-system")
    
    if not mongo_url:
        print("MONGODB_URL not found")
        return

    client = AsyncIOMotorClient(mongo_url)
    db = client[db_name]
    
    # 1. Check count of orders
    count = await db.orders.count_documents({})
    print(f"Total orders: {count}")
    
    # 2. Check for "Quote" orders
    quote_orders = await db.orders.find({"order_number": {"$regex": "Quote", "$options": "i"}}).to_list(100)
    print(f"Orders with 'Quote': {len(quote_orders)}")
    for o in quote_orders:
        print(f" - {o.get('order_number')} (ID: {o.get('order_id')})")
        
    # 3. Check for RECENT orders (last 5)
    recent = await db.orders.find().sort("created_at", -1).limit(5).to_list(5)
    print("\nRecent orders:")
    for o in recent:
        print(f" - {o.get('order_number')} (Created: {o.get('created_at')})")

    # 4. Check webhook logs
    logs = await db.webhook_logs.find().sort("timestamp", -1).limit(10).to_list(10)
    print(f"\nWebhook logs: {len(logs)}")
    for l in logs:
        print(f" - {l.get('timestamp')} status={l.get('status')} error={l.get('error')}")

if __name__ == "__main__":
    asyncio.run(debug_db())
