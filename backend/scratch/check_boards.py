import motor.motor_asyncio
import asyncio
import os
from dotenv import load_dotenv

async def check():
    load_dotenv(r'.env')
    uri = os.getenv('MONGODB_URI') or os.getenv('MONGO_URL')
    client = motor.motor_asyncio.AsyncIOMotorClient(uri)
    
    # Extract db name from URI or use default
    import re
    db_name = os.environ.get('DB_NAME')
    if not db_name:
        match = re.search(r'/([^/?]+)(\?|$)', uri)
        db_name = match.group(1) if match else "mos-system"
    
    db = client[db_name]
    boards = await db.orders.distinct('board')
    print("Boards in system:", boards)
    
    # Check for orders in other boards that might need picking
    # (e.g. anything with blank_status='PENDIENTE')
    wms_ops = await db.orders.find({
        "board": {"$nin": ["scheduling", "blanks"]},
        "blank_status": {"$exists": True}
    }, {"board": 1, "blank_status": 1, "order_number": 1}).to_list(100)
    
    non_standard = {}
    for o in wms_ops:
        b = o.get('board', 'no_board')
        non_standard[b] = non_standard.get(b, 0) + 1
    
    print("Orders with blank_status in non-picking boards:", non_standard)

if __name__ == "__main__":
    asyncio.run(check())
