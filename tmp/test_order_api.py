import asyncio
import os
import sys
import uuid
import httpx
from datetime import datetime, timezone

sys.path.append(os.path.join(os.getcwd(), 'backend'))
from deps import db

async def test_api():
    email = "test_load@example.com"
    # Create valid session
    session_token = f"sess_{uuid.uuid4().hex}"
    await db.user_sessions.update_one(
        {"user_id": "test_user"}, 
        {"$set": {
            "session_token": session_token, 
            "user_id": "test_user", 
            "expires_at": datetime(2030, 1, 1, tzinfo=timezone.utc)
        }}, 
        upsert=True
    )
    await db.users.update_one(
        {"user_id": "test_user"},
        {"$set": {"email": email, "name": "Test User", "role": "admin", "user_id": "test_user"}},
        upsert=True
    )
    
    # Hit API
    async with httpx.AsyncClient() as client:
        payload = {
            "order_number": "TEST-123",
            "client": "LOVE IN FAITH",
            "quantity": 100,
            "priority": "RUSH",
            "board": "SCHEDULING"
        }
        res = await client.post(
            "http://localhost:8000/api/orders",
            json=payload,
            headers={"Authorization": f"Bearer {session_token}"}
        )
        print("Status:", res.status_code)
        print("Body:", res.text)
        
        # Test production log
        if res.status_code == 200:
            order_id = res.json().get("order_id")
            prod_payload = {
                "order_id": order_id,
                "quantity_produced": 50,
                "machine": "MAQUINA1",
                "operator": "Test Operator"
            }
            res2 = await client.post(
                "http://localhost:8000/api/production-logs",
                json=prod_payload,
                headers={"Authorization": f"Bearer {session_token}"}
            )
            print("Prod Status:", res2.status_code)
            print("Prod Body:", res2.text)

if __name__ == "__main__":
    asyncio.run(test_api())
