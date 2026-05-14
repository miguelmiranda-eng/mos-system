import asyncio
import os
import sys

# Add current directory to path
sys.path.append(os.getcwd())

from backend.deps import db

async def check():
    email = "admin@test.com"
    user = await db.users.find_one({'email': email})
    if user:
        print(f"USER FOUND: {user['email']}, ROLE: {user.get('role')}")
    else:
        print(f"USER NOT FOUND: {email}")

if __name__ == "__main__":
    asyncio.run(check())
