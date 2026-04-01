import asyncio
import os
from motor.motor_asyncio import AsyncIOMotorClient
from dotenv import load_dotenv
from pathlib import Path

async def get_boards():
    load_dotenv(Path(__file__).parent / '.env')
    mongo_url = os.environ.get('MONGO_URL') or os.environ.get('MONGODB_URI') or os.environ.get('MONGODB_URL')
    if not mongo_url: return
    client = AsyncIOMotorClient(mongo_url)
    db_name = os.environ.get('DB_NAME', 'mos-system')
    db = client[db_name]
    boards = await db.orders.distinct("board")
    print(boards)

if __name__ == "__main__":
    asyncio.run(get_boards())
