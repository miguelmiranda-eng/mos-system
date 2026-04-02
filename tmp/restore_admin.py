import asyncio
import sys
from pathlib import Path
from passlib.hash import bcrypt
import uuid
from datetime import datetime, timezone

# Fix path to import deps
backend_path = Path(r"c:\CRM\mos-system-main\backend")
sys.path.append(str(backend_path))

from deps import db

async def create_admin():
    email = "admin@test.com"
    password = "admin123"
    name = "Admin Local"
    role = "admin"
    
    hashed = bcrypt.hash(password)
    user_id = f"user_{uuid.uuid4().hex[:12]}"
    
    user_doc = {
        "user_id": user_id,
        "email": email,
        "name": name,
        "role": role,
        "auth_type": "email",
        "password_hash": hashed,
        "created_at": datetime.now(timezone.utc).isoformat()
    }
    
    # Upsert by email
    await db.users.update_one(
        {"email": email},
        {"$set": user_doc},
        upsert=True
    )
    print(f"User {email} created/updated as admin with password {password}")

if __name__ == "__main__":
    asyncio.run(create_admin())
