import asyncio
import os
import sys

# Add backend to path to import deps
sys.path.append(os.path.join(os.getcwd(), 'backend'))

from deps import db

async def cleanup():
    print("Checking database board configuration...")
    config = await db.board_config.find_one({"config_id": "boards"})
    if config and "boards" in config:
        boards = config["boards"]
        if "PAPELERA DE RECICLAJE" in boards:
            print("Found 'PAPELERA DE RECICLAJE' in database. Removing...")
            boards.remove("PAPELERA DE RECICLAJE")
            await db.board_config.update_one(
                {"config_id": "boards"},
                {"$set": {"boards": boards}}
            )
            print("Successfully removed from database.")
        else:
            print("'PAPELERA DE RECICLAJE' not found in database board list.")
    else:
        print("No dynamic board configuration found in database.")

if __name__ == "__main__":
    asyncio.run(cleanup())
