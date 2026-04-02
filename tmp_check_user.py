import asyncio
import os
import sys

# Add current directory to path
sys.path.append(os.getcwd())

from backend.deps import db

async def check():
    user = await db.users.find_one({'role': 'admin'})
    if user:
        print(f"ADMIN_EMAIL={user['email']}")
    else:
        print("No admin found")

if __name__ == "__main__":
    asyncio.run(check())
