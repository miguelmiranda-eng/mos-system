import os
import asyncio
import uuid
from datetime import datetime, timezone
from motor.motor_asyncio import AsyncIOMotorClient
from passlib.hash import bcrypt
from dotenv import load_dotenv
from pathlib import Path

# Load environment
BACKEND_DIR = Path(__file__).parent.parent
load_dotenv(BACKEND_DIR / '.env')

MONGO_URL = os.environ.get('MONGO_URL') or os.environ.get('MONGODB_URI') or os.environ.get('MONGODB_URL')
DB_NAME = os.environ.get('DB_NAME', 'mos-system')

async def create_ceo_user(email, password, name):
    if not MONGO_URL:
        print("Error: MONGO_URL not found in environment")
        return

    client = AsyncIOMotorClient(MONGO_URL)
    db = client[DB_NAME]

    # Check if user exists
    existing = await db.users.find_one({"email": email})
    if existing:
        print(f"User {email} already exists. Updating role to 'ceo'...")
        await db.users.update_one({"email": email}, {"$set": {"role": "ceo"}})
        print("Role updated.")
        return

    # Create new CEO user
    user_doc = {
        "user_id": f"user_{uuid.uuid4().hex[:12]}",
        "email": email,
        "name": name,
        "password_hash": bcrypt.hash(password),
        "role": "ceo",
        "auth_type": "email",
        "created_at": datetime.now(timezone.utc).isoformat()
    }

    await db.users.insert_one(user_doc)
    print(f"CEO user created successfully: {email}")
    print(f"Role: ceo")
    print(f"Name: {name}")

if __name__ == "__main__":
    import sys
    if len(sys.argv) < 3:
        print("Usage: python create_ceo_user.py <email> <password> [name]")
        sys.exit(1)
    
    email = sys.argv[1]
    password = sys.argv[2]
    name = sys.argv[3] if len(sys.argv) > 3 else email.split('@')[0]
    
    asyncio.run(create_ceo_user(email, password, name))
