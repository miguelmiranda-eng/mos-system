import asyncio
from motor.motor_asyncio import AsyncIOMotorClient
import os

async def cleanup():
    # Database connection details (matching deps.py)
    MONGO_URI = "mongodb://localhost:27017"
    client = AsyncIOMotorClient(MONGO_URI)
    db = client.mos_database

    print("Cleaning up MANUAL orders...")
    
    # Delete work orders with MANUAL reference
    wo_result = await db.work_orders.delete_many({"source_invoice_id": "MANUAL"})
    print(f"Deleted {wo_result.deleted_count} work orders with REF: MANUAL")
    
    # Delete invoices with MANUAL reference
    inv_result = await db.invoices.delete_many({"invoice_id": "MANUAL"})
    print(f"Deleted {inv_result.deleted_count} invoices with ID: MANUAL")
    
    # Also delete any work orders created with random WO- IDs during testing if needed
    # but the user specifically said MANUAL.
    
    client.close()
    print("Cleanup complete.")

if __name__ == "__main__":
    asyncio.run(cleanup())
