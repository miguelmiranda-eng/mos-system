from motor.motor_asyncio import AsyncIOMotorClient
import asyncio
import os
import re
from pathlib import Path
from dotenv import load_dotenv

async def consolidate_fields():
    env_path = Path('backend/.env')
    load_dotenv(env_path)
    
    mongo_url = os.environ.get('MONGO_URL') or os.environ.get('MONGODB_URI') or os.environ.get('MONGODB_URL')
    db_name = "mos-system"
    if not mongo_url:
        print("Error: No MongoDB URL found in .env")
        return
        
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
        
        # 1. Move ALL content from custom_fields to root
        if isinstance(custom_fields, dict) and custom_fields:
            for key, val in custom_fields.items():
                # Handle special mapping for design_num / design_# if encountered
                target_key = 'design_#' if key == 'design_num' else key
                
                # Only move if the root field is missing or the value in root is empty
                # and the value in custom_fields is NOT null/empty
                root_val = order.get(target_key)
                if (root_val is None or root_val == "") and (val is not None and val != ""):
                    updates[target_key] = val
            
            # ALWAYS remove the custom_fields object after processing
            unsets["custom_fields"] = ""

        # 2. Safety check for design_num at root
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
