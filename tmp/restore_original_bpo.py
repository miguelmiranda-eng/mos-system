import asyncio
from motor.motor_asyncio import AsyncIOMotorClient

async def fix_bpo():
    url = "mongodb://miranda:Mirandam2@187.124.232.150:27017/mos-system?authSource=admin"
    client = AsyncIOMotorClient(url)
    db = client["mos-system"]
    
    col_config = await db.column_config.find_one({"config_id": "columns"})
    if not col_config:
        print("Error: No column config found.")
        return
        
    custom = col_config.get("custom_columns", [])
    # Remove existing BPO entries
    new_custom = [c for c in custom if c.get("key") != "BPO" and c.get("key") != "bpo_(blank_po#)"]
    
    # Add the correct one
    new_custom.append({
        "key": "bpo_(blank_po#)",
        "label": "BPO (Blank PO #)",
        "type": "text",
        "width": 160,
        "custom": True
    })
    
    await db.column_config.update_one(
        {"config_id": "columns"},
        {"$set": {"custom_columns": new_custom}}
    )
    print("Database updated with original BPO column mapping.")
    client.close()

if __name__ == "__main__":
    asyncio.run(fix_bpo())
