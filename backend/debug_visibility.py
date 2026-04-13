
import asyncio
import os
from motor.motor_asyncio import AsyncIOMotorClient
from dotenv import load_dotenv

load_dotenv()

async def check():
    mongo_url = os.getenv("MONGO_URL")
    db_name = os.getenv("DB_NAME", "mos-system")
    client = AsyncIOMotorClient(mongo_url)
    db = client[db_name]
    
    print(f"Checking Picking visibility in database: {db_name}")
    
    # 1. Real tickets
    real_tickets = await db.wms_pick_tickets.find({}, {"order_number": 1}).to_list(1000)
    real_order_nums = {t.get("order_number") for t in real_tickets if t.get("order_number")}
    print(f"Existing real Pick Tickets: {len(real_tickets)}")
    
    # 2. Virtual tickets (Scheduling/Blanks)
    virtual_query = {
        "board": {"$regex": "^scheduling$|^blanks$", "$options": "i"},
        "order_number": {"$nin": list(real_order_nums)}
    }
    virtual_orders = await db.orders.find(virtual_query).to_list(1000)
    print(f"Virtual Pick Tickets (from Scheduling/Blanks): {len(virtual_orders)}")
    
    print("\nSample Virtual Tickets:")
    for o in virtual_orders[:5]:
        print(f"Order: {o.get('order_number')}, Board: {o.get('board')}, Client: {o.get('client')}, Status: {o.get('blank_status')}")

    # 3. CRM Orders visibility
    wms_order_query = {"$or": [
        {"board": {"$regex": "^blanks$|^crm$|^ventas$|^sales$|^scheduling$|^production$|^final bill$", "$options": "i"}},
        {"blank_status": {"$regex": "partial|parcial|pending|ready|todo|picked", "$options": "i"}},
        {"wms_status": {"$exists": True}}
    ]}
    wms_orders_count = await db.orders.count_documents(wms_order_query)
    print(f"\nTotal CRM Orders visible in WMS Search: {wms_orders_count}")

if __name__ == "__main__":
    asyncio.run(check())
