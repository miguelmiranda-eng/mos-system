import asyncio
import os
import sys
from datetime import datetime, timezone

# Setup paths
sys.path.append(os.path.join(os.getcwd(), 'backend'))

async def test():
    print("Testing internal_create_order...")
    try:
        from backend.routers.orders import internal_create_order
        from backend.deps import OrderCreate
        
        user = {"user_id": "test_agent", "name": "Agent"}
        order = OrderCreate(
            order_number="DEBUG_123",
            client="Debug Customer",
            style="Debug Style",
            board="SCHEDULING"
        )
        
        print("Calling internal_create_order...")
        result = await internal_create_order(order, user)
        print(f"SUCCESS: {result}")
    except Exception as e:
        print(f"FAILED: {e}")
        import traceback
        traceback.print_exc()

if __name__ == "__main__":
    asyncio.run(test())
