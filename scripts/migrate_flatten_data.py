import asyncio
import os
import re
from motor.motor_asyncio import AsyncIOMotorClient
from dotenv import load_dotenv

# Find the .env file relative to the project root
# Assuming the script is in scripts/ and project root is the parent
script_dir = os.path.dirname(os.path.abspath(__file__))
project_root = os.path.dirname(script_dir)
dotenv_path = os.path.join(project_root, 'backend', '.env')
load_dotenv(dotenv_path)

async def migrate_data():
    mongo_url = os.environ.get('MONGO_URL') or os.environ.get('MONGODB_URL') or os.environ.get('MONGODB_URI')
    if not mongo_url:
        print("ERROR: No MongoDB URL found in environment (MONGO_URL / MONGODB_URL / MONGODB_URI)")
        return
        
    db_name = os.environ.get('DB_NAME')
    if not db_name:
        match = re.search(r'/([^/?]+)(\?|$)', mongo_url)
        db_name = match.group(1) if match else "mos-system"
        
    client = AsyncIOMotorClient(mongo_url)
    db = client[db_name]
    
    # We want to identify orders that have `custom_fields` present
    cursor = db.orders.find({"custom_fields": {"$exists": True, "$ne": {}}})
    count = 0
    
    async for order in cursor:
        custom_fields = order.get("custom_fields", {})
        if not custom_fields or not isinstance(custom_fields, dict):
            continue
            
        update_doc = {}
        for k, v in custom_fields.items():
            # If the user previously used 'design_#', we can move it to root.
            # If there's a conflict between root and custom_field, custom_field overrides
            if k not in ["_id", "order_id"]: # Prevent dangerous overwrites
                update_doc[k] = v
                
        if update_doc:
            # We add values to root and delete custom_fields
            await db.orders.update_one(
                {"_id": order["_id"]},
                {"$set": update_doc, "$unset": {"custom_fields": ""}}
            )
            count += 1
            print(f"Migrated order {order.get('order_number', order.get('order_id'))}: flattened {len(update_doc)} custom fields.")
            
    # Remove custom_fields entirely from orders that just have empty ones too
    empty_cursor = db.orders.find({"custom_fields": {"$exists": True}})
    async for order in empty_cursor:
        await db.orders.update_one({"_id": order["_id"]}, {"$unset": {"custom_fields": ""}})
        
    print(f"Flattening migration finished! {count} orders had their custom fields moved to root.")
    client.close()

if __name__ == "__main__":
    asyncio.run(migrate_data())
