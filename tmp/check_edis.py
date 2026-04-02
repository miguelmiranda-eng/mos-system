import asyncio
import os
import sys

# Ensure backend is in path
sys.path.append(r"c:\CRM\mos-system-main\backend")

from deps import db

async def check_edis_detail():
    # 1. Count EDI
    edi_count = await db.orders.count_documents({"board": "EDI"})
    print(f"Orders with board='EDI': {edi_count}")
    
    # 2. Count EDIS
    edis_count = await db.orders.count_documents({"board": "EDIS"})
    print(f"Orders with board='EDIS': {edis_count}")
    
    # 3. List all distinct board names again
    unique_boards = await db.orders.distinct("board")
    print(f"Unique boards in orders: {unique_boards}")

if __name__ == "__main__":
    asyncio.run(check_edis_detail())
