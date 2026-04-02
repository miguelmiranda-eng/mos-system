
import asyncio, os, re
from motor.motor_asyncio import AsyncIOMotorClient
from dotenv import load_dotenv
from pathlib import Path
from datetime import datetime, timezone

async def cleanup_ghost_orders():
    # Try to find .env in current dir or backend/
    env_path = Path('backend/.env')
    if not env_path.exists():
        env_path = Path('.env')
        
    load_dotenv(env_path)
    
    mongo_url = os.environ.get('MONGO_URL') or os.environ.get('MONGODB_URI') or os.environ.get('MONGODB_URL')
    if not mongo_url:
        print('No MONGO_URL found in environment variables')
        return
    
    client = AsyncIOMotorClient(mongo_url)
    db_name = os.environ.get('DB_NAME')
    if not db_name:
        match = re.search(r'/([^/?]+)(\?|$)', mongo_url)
        db_name = match.group(1) if match else "mos-system"
    
    print(f"Connecting to database: {db_name}")
    db = client[db_name]
    
    # Find orders with board: null or missing board field
    query = {"$or": [{"board": None}, {"board": {"$exists": False}}]}
    target_trash_board = "PAPELERA DE RECICLAJE"
    
    cursor = db.orders.find(query)
    ghost_orders = await cursor.to_list(1000)
    
    if not ghost_orders:
        print("No ghost orders found with board=null.")
        return

    print(f"Moving {len(ghost_orders)} ghost orders to trash ({target_trash_board})...")
    
    order_ids = [o["order_id"] for o in ghost_orders if "order_id" in o]
    
    if order_ids:
        result = await db.orders.update_many(
            {"order_id": {"$in": order_ids}},
            {"$set": {
                "board": target_trash_board,
                "updated_at": datetime.now(timezone.utc).isoformat(),
                "cleanup_reason": "ghost_order_null_board"
            }}
        )
        print(f"Successfully updated {result.modified_count} orders.")
        
        # Log activity for this cleanup
        activity_doc = {
            "activity_id": f"act_cleanup_{datetime.now(timezone.utc).strftime('%Y%m%d%H%M%S')}",
            "user_name": "Antigravity (System)",
            "action": "cleanup_ghost_orders",
            "details": {"count": result.modified_count, "order_ids": order_ids},
            "timestamp": datetime.now(timezone.utc).isoformat()
        }
        await db.activity_logs.insert_one(activity_doc)
    else:
        print("No order_ids found for the ghost orders. Nothing to update.")

if __name__ == "__main__":
    asyncio.run(cleanup_ghost_orders())
