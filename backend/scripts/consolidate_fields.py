from motor.motor_asyncio import AsyncIOMotorClient
import asyncio
import os
import re
from pathlib import Path
from dotenv import load_dotenv

async def consolidate_fields():
    env_path = Path('backend/.env')
    load_dotenv(env_path)
    
    mongo_url = os.environ.get('MONGODB_URL')
    db_name = "mos-system"
    if mongo_url:
        match = re.search(r'/([^/?]+)(\?|$)', mongo_url)
        if match:
            db_name = match.group(1)
            
    client = AsyncIOMotorClient(mongo_url)
    db = client[db_name]
    
    print(f"Consolidating fields in database: {db_name}")
    
    # List of standard fields that should be at root
    standard_fields = [
        'order_number', 'client', 'branding', 'priority', 'blank_source', 
        'blank_status', 'production_status', 'trim_status', 'trim_box', 
        'sample', 'artwork_status', 'betty_column', 'shipping', 'quantity', 
        'due_date', 'notes', 'color', 'design_#', 'final_bill', 'screens', 
        'board', 'links', 'design_num'
    ]
    
    all_orders = await db.orders.find().to_list(None)
    updated_count = 0
    
    for order in all_orders:
        order_id = order.get("order_id")
        custom_fields = order.get("custom_fields", {})
        updates = {}
        unsets = {}
        
        # 1. Check for standard fields inside custom_fields
        if isinstance(custom_fields, dict):
            for field in standard_fields:
                if field in custom_fields:
                    val = custom_fields[field]
                    # Only move if root field is missing or empty
                    if not order.get(field):
                        # Use proper name for design_num -> design_#
                        target_field = 'design_#' if field == 'design_num' else field
                        updates[target_field] = val
                    
                    # Mark for deletion from custom_fields
                    unsets[f"custom_fields.{field}"] = ""

        # 2. Check for design_num at root (from previous migration logic)
        if "design_num" in order:
            if not order.get("design_#"):
                updates["design_#"] = order["design_num"]
            unsets["design_num"] = ""

        if updates or unsets:
            mongo_update = {}
            if updates: mongo_update["$set"] = updates
            if unsets: mongo_update["$unset"] = unsets
            
            await db.orders.update_one({"order_id": order_id}, mongo_update)
            updated_count += 1

    print(f"Consolidation completed. Documents updated: {updated_count}")
    
    # Final check for design_# in custom_fields
    remaining_cf = await db.orders.count_documents({"custom_fields.design_#": {"$exists": True}})
    remaining_num = await db.orders.count_documents({"design_num": {"$exists": True}})
    total_with_hash = await db.orders.count_documents({"design_#": {"$exists": True}})
    
    print(f"Remaining 'design_#' in custom_fields: {remaining_cf}")
    print(f"Remaining 'design_num' in root: {remaining_num}")
    print(f"Total documents with 'design_#' at root: {total_with_hash}")
    
    client.close()

if __name__ == "__main__":
    asyncio.run(consolidate_fields())
