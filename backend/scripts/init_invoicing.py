import asyncio
import os
import sys
from pathlib import Path

# Add backend to sys.path
backend_path = str(Path(__file__).parent.parent)
sys.path.append(backend_path)

from deps import db

async def init_db():
    print("Initializing invoicing collections...")
    
    # Invoices collection
    await db.invoices.create_index("invoice_id", unique=True)
    await db.invoices.create_index("order_number")
    await db.invoices.create_index("status")
    await db.invoices.create_index("client")
    print("Created indexes for 'invoices'")
    
    # Work Orders collection
    await db.work_orders.create_index("work_order_id", unique=True)
    await db.work_orders.create_index("source_invoice_id")
    await db.work_orders.create_index("production_status")
    print("Created indexes for 'work_orders'")
    
    # Optional: Seed some default data or config if needed
    print("Database initialization complete.")

if __name__ == "__main__":
    asyncio.run(init_db())
