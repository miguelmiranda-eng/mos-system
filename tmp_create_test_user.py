import asyncio
import os
import sys
import uuid
from datetime import datetime, timezone
from passlib.hash import bcrypt

# Add current directory to path
sys.path.append(os.getcwd())

from backend.deps import db

async def create_test_user():
    email = "test_load@example.com"
    password = "password123"
    hashed = bcrypt.hash(password)
    
    user_id = f"user_{uuid.uuid4().hex[:12]}"
    new_user = {
        "user_id": user_id,
        "email": email,
        "name": "Test Load User",
        "picture": "",
        "role": "admin", # Need admin for some endpoints
        "auth_type": "email",
        "password_hash": hashed,
        "created_at": datetime.now(timezone.utc).isoformat()
    }
    
    await db.users.update_one({"email": email}, {"$set": new_user}, upsert=True)
    print(f"CREATED_USER_EMAIL={email}")
    print(f"CREATED_USER_PASS={password}")

if __name__ == "__main__":
    asyncio.run(create_test_user())
