import asyncio
import motor.motor_asyncio
import os
from datetime import datetime, timezone
import uuid
from dotenv import load_dotenv

load_dotenv()

async def sync_existing_invoices():
    mongo_uri = os.environ.get("MONGO_URI", "mongodb://localhost:27017/mos_database")
    client = motor.motor_asyncio.AsyncIOMotorClient(mongo_uri)
    db = client.get_default_database()
    
    print(f"Checking invoices in {db.name}...")
    
    invoices = await db.invoices.find({}).to_list(1000)
    print(f"Found {len(invoices)} invoices.")
    
    for inv in invoices:
        inv_id = inv["invoice_id"]
        # Check if already has a work order
        existing_wo = await db.work_orders.find_one({"source_invoice_id": inv_id})
        
        if not existing_wo:
            wo_id = f"WO-{uuid.uuid4().hex[:8].upper()}"
            new_wo = {
                "work_order_id": wo_id,
                "source_invoice_id": inv_id,
                "production_status": "artwork_pending",
                "art_links": inv.get("art_links", []),
                "production_notes": inv.get("production_notes", f"Auto-generated from Invoice {inv_id}"),
                "packing_details": {"bags": "individual", "labels": "hanging", "boxes": "master"},
                "created_at": datetime.now(timezone.utc).isoformat(),
                "updated_at": datetime.now(timezone.utc).isoformat()
            }
            await db.work_orders.insert_one(new_wo)
            await db.invoices.update_one(
                {"invoice_id": inv_id},
                {"$push": {"linked_work_orders": wo_id}}
            )
            print(f"Created {wo_id} for {inv_id}")
        else:
            print(f"Invoice {inv_id} already has a Work Order.")

    print("Sync complete.")

if __name__ == "__main__":
    asyncio.run(sync_existing_invoices())
