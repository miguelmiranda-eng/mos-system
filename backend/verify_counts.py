import asyncio
import os
from pathlib import Path
from dotenv import load_dotenv

ROOT_DIR = Path(__file__).parent
load_dotenv(ROOT_DIR / '.env')

async def check_counts():
    from deps import db
    total = await db.orders.count_documents({})
    print(f"Total Database Orders: {total}")
    
    pipeline = [{"$group": {"_id": "$board", "count": {"$sum": 1}}}]
    results = await db.orders.aggregate(pipeline).to_list(1000)
    counts = {r["_id"]: r["count"] for r in results if r["_id"]}
    print(f"Counts per Board: {counts}")

if __name__ == "__main__":
    asyncio.run(check_counts())
