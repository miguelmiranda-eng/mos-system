import asyncio
import os, sys
# Ensure the backend package is on the import path
sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))

from deps import db, logger
SCREENS_COLUMN = {
    "key": "screens",
    "label": "SCREENS",
    "type": "checkbox",
    "width": 150,
    "custom": True,
}

async def ensure_screens_column():
    config = await db.column_config.find_one({"config_id": "columns"}, {"_id": 0, "custom_columns": 1})
    if not config:
        await db.column_config.insert_one({"config_id": "columns", "custom_columns": [SCREENS_COLUMN]})
        logger.info("Column config created with the 'screens' column.")
        return
    custom_columns = config.get("custom_columns", [])
    if any(col.get("key") == "screens" for col in custom_columns):
        logger.info("'screens' column already exists – nothing to do.")
        return
    custom_columns.append(SCREENS_COLUMN)
    await db.column_config.update_one({"config_id": "columns"}, {"$set": {"custom_columns": custom_columns}})
    logger.info("'screens' column restored successfully.")

if __name__ == "__main__":
    asyncio.run(ensure_screens_column())
