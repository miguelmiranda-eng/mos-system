import asyncio
from motor.motor_asyncio import AsyncIOMotorClient

async def fix():
    url = "mongodb://miranda:Mirandam2@187.124.232.150:27017/mos-system?authSource=admin"
    client = AsyncIOMotorClient(url)
    db = client["mos-system"]
    
    col_config = await db.column_config.find_one({"config_id": "columns"})
    if not col_config:
        print("Creating new column config...")
        col_config = {"config_id": "columns", "removed_default_columns": [], "custom_columns": []}
    
    # 1. Remove 'color' from removed_default_columns
    removed = col_config.get("removed_default_columns", [])
    if "color" in removed:
        removed.remove("color")
        print(f"Removed 'color' from removed_default_columns. New list: {removed}")
    
    # 2. Add 'Blanck po #' to custom_columns if not present
    custom = col_config.get("custom_columns", [])
    bpo_col = next((c for c in custom if c.get("key") == "BPO"), None)
    
    if bpo_col:
        print(f"Updating existing BPO column label from '{bpo_col.get('label')}' to 'Blanck po #'.")
        bpo_col["label"] = "Blanck po #"
    else:
        print("Adding 'Blanck po #' as a new custom column.")
        custom.append({"key": "BPO", "label": "Blanck po #", "type": "text", "width": 150, "custom": True})
    
    # Update the DB
    await db.column_config.update_one(
        {"config_id": "columns"},
        {"$set": {
            "removed_default_columns": removed,
            "custom_columns": custom
        }},
        upsert=True
    )
    print("Database updated successfully.")
    client.close()

if __name__ == "__main__":
    asyncio.run(fix())
