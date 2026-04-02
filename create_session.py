import asyncio
import uuid
from datetime import datetime, timezone, timedelta
from motor.motor_asyncio import AsyncIOMotorClient
import os
from pathlib import Path
from dotenv import load_dotenv

async def create_test_session():
    # Load backend .env
    env_path = Path("backend") / ".env"
    load_dotenv(env_path)
    
    mongo_url = os.environ.get('MONGODB_URL')
    if not mongo_url:
        print("MONGODB_URL not found")
        return
    
    client = AsyncIOMotorClient(mongo_url)
    db_name = "mos-system" # Default or extract from URL
    db = client[db_name]
    
    # Check for a user or create one
    user = await db.users.find_one({"role": "admin"})
    if not user:
        print("No admin user found")
        return
    
    user_id = user["user_id"]
    session_token = f"session_{uuid.uuid4().hex}"
    expires_at = datetime.now(timezone.utc) + timedelta(days=1)
    
    await db.user_sessions.insert_one({
        "user_id": user_id,
        "session_token": session_token,
        "expires_at": expires_at.isoformat(),
        "created_at": datetime.now(timezone.utc).isoformat()
    })
    
    print(f"Created session for {user['email']}")
    print(f"Session Token: {session_token}")
    return session_token

if __name__ == "__main__":
    asyncio.run(create_test_session())
