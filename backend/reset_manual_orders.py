import asyncio
from deps import db

async def reset_manual_orders():
    print("Starting cleanup of manual orders (M-)...")
    
    # 1. Delete invoices starting with M-
    invoice_result = await db.invoices.delete_many({"invoice_id": {"$regex": "^M-"}})
    print(f"Deleted {invoice_result.deleted_count} manual invoices.")
    
    # 2. Delete work orders related to manual invoices
    # In work_orders, the field is source_invoice_id
    wo_result = await db.work_orders.delete_many({"source_invoice_id": {"$regex": "^M-"}})
    print(f"Deleted {wo_result.deleted_count} related work orders.")
    
    # 3. Reset the counter
    # The counter is used to generate the M-XX number. Setting it to 0 makes the next one M-01
    counter_result = await db.counters.update_one(
        {"_id": "invoice_number"},
        {"$set": {"sequence_value": 0}},
        upsert=True
    )
    print("Counter 'invoice_number' reset to 0.")
    
    print("\nCleanup complete! The next order will be M-01.")

if __name__ == "__main__":
    asyncio.run(reset_manual_orders())
