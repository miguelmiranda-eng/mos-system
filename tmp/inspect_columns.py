import asyncio
from motor.motor_asyncio import AsyncIOMotorClient
import os

async def inspect():
    url = "mongodb://miranda:Mirandam2@187.124.232.150:27017/mos-system?authSource=admin"
    client = AsyncIOMotorClient(url)
    db = client["mos-system"]
    
    col_config = await db.column_config.find_one({"config_id": "columns"})
    print("Column Config in DB:")
    if col_config:
        print(f"Removed default columns: {col_config.get('removed_default_columns', [])}")
        print("Custom columns:")
        for col in col_config.get("custom_columns", []):
            print(f"  - {col}")
    else:
        print("No Column Config found in DB.")

    # Also check form fields config
    form_config = await db.form_fields_config.find_one({"config_id": "main"})
    print("\nForm Fields Config in DB:")
    if form_config:
        print(f"Fields: {form_config.get('fields', [])}")
    else:
        print("No Form Fields Config found in DB.")

    client.close()

if __name__ == "__main__":
    asyncio.run(inspect())
