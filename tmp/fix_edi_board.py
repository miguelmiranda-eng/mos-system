import asyncio
import sys
from pathlib import Path

# Fix path to import deps
backend_path = Path(r"c:\CRM\mos-system-main\backend")
sys.path.append(str(backend_path))

from deps import db, BOARDS

async def fix_edi_board():
    print("Updating board configuration in MongoDB...")
    
    # 1. Update board_config
    config = await db.board_config.find_one({"config_id": "boards"})
    if config:
        current_boards = config.get("boards", [])
        if "EDI" not in current_boards:
            # Place EDI after COMPLETOS if possible
            if "COMPLETOS" in current_boards:
                idx = current_boards.index("COMPLETOS")
                current_boards.insert(idx + 1, "EDI")
            else:
                current_boards.append("EDI")
            
            await db.board_config.update_one(
                {"config_id": "boards"},
                {"$set": {"boards": current_boards}}
            )
            print(f"Updated board_config. New board list: {current_boards}")
        else:
            print("'EDI' already exists in board_config.")
    else:
        # Fallback if no config exists (shouldn't happen based on previous checks)
        await db.board_config.insert_one({
            "config_id": "boards",
            "boards": BOARDS
        })
        print("Created new board_config with defaults (including EDI).")

    # 2. Check orders
    edi_count = await db.orders.count_documents({"board": "EDI"})
    print(f"Found {edi_count} orders currently assigned to 'EDI'.")
    
    print("Fix complete.")

if __name__ == "__main__":
    asyncio.run(fix_edi_board())
