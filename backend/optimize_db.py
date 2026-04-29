import asyncio
import os
from motor.motor_asyncio import AsyncIOMotorClient
from dotenv import load_dotenv
from pathlib import Path

async def optimize():
    load_dotenv(Path(__file__).parent / '.env')
    mongo_url = os.environ.get('MONGO_URL') or os.environ.get('MONGODB_URI') or os.environ.get('MONGODB_URL')
    if not mongo_url:
        print("No Mongo URL found")
        return
    
    client = AsyncIOMotorClient(mongo_url)
    db_name = os.environ.get('DB_NAME', 'mos-system')
    db = client[db_name]
    
    print(f"Checking indexes for {db_name}.orders...")
    
    # Create index on board for faster dashboard aggregation
    try:
        await db.orders.create_index("board")
        print("Created index on 'board'")
    except Exception as e:
        print(f"Error creating index: {e}")
        
    # Create index on order_number if not exists
    try:
        await db.orders.create_index("order_number")
        print("Created index on 'order_number'")
    except Exception as e:
        print(f"Error creating index: {e}")

    # Create index on status
    try:
        await db.orders.create_index("status")
        print("Created index on 'status'")
    except Exception as e:
        print(f"Error creating index: {e}")

    try:
        await db.orders.create_index("order_id")
        print("Created index on 'orders.order_id'")
    except Exception as e:
        print(f"Error creating index: {e}")

    try:
        await db.orders.create_index([("created_at", -1)])
        print("Created index on 'orders.created_at'")
    except Exception as e:
        print(f"Error creating index: {e}")

    try:
        await db.notifications.create_index([("user_id", 1), ("created_at", -1)])
        print("Created index on 'notifications.user_id_created_at'")
    except Exception as e:
        print(f"Error creating index: {e}")

    try:
        await db.activity_logs.create_index([("timestamp", -1)])
        print("Created index on 'activity_logs.timestamp'")
    except Exception as e:
        print(f"Error creating index: {e}")

    try:
        await db.production_logs.create_index("created_at")
        print("Created index on 'production_logs.created_at'")
    except Exception as e:
        print(f"Error creating index: {e}")
        
    try:
        await db.production_logs.create_index("order_id")
        print("Created index on 'production_logs.order_id'")
    except Exception as e:
        print(f"Error creating index: {e}")

    try:
        from datetime import datetime, timedelta, timezone
        cutoff = (datetime.now(timezone.utc) - timedelta(days=15)).isoformat()
        result = await db.notifications.delete_many({"created_at": {"$lt": cutoff}})
        if result.deleted_count > 0:
            print(f"Cleaned up {result.deleted_count} old notifications")
    except Exception as e:
        print(f"Error during cleanup: {e}")

    print("Optimization finished.")

if __name__ == "__main__":
    asyncio.run(optimize())
