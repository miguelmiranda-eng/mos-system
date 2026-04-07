import asyncio
import os
import sys

# Ensure current directory is in path
sys.path.append('.')

from deps import db

async def check():
    order = await db.orders.find_one({}, {"order_number": 1, "board": 1})
    if order:
        print(f"FOUND: {order.get('order_number')} in {order.get('board')}")
    else:
        print("NOT FOUND")

if __name__ == "__main__":
    asyncio.run(check())
