
import asyncio, os, re
from motor.motor_asyncio import AsyncIOMotorClient
from dotenv import load_dotenv
from pathlib import Path

async def check_orders():
    # Try to find .env in current dir or backend/
    env_path = Path('backend/.env')
    if not env_path.exists():
        env_path = Path('.env')
        
    load_dotenv(env_path)
    
    mongo_url = os.environ.get('MONGO_URL') or os.environ.get('MONGODB_URI') or os.environ.get('MONGODB_URL')
    if not mongo_url:
        print('No MONGO_URL found in environment variables')
        return
    
    client = AsyncIOMotorClient(mongo_url)
    db_name = os.environ.get('DB_NAME')
    if not db_name:
        # Extract database name from connection string: mongodb://.../database_name?options
        match = re.search(r'/([^/?]+)(\?|$)', mongo_url)
        if match:
            db_name = match.group(1)
        else:
            db_name = "mos-system"
    
    print(f"Connecting to database: {db_name}")
    db = client[db_name]
    
    # Get current boards config
    config = await db.board_config.find_one({"config_id": "boards"})
    if config and config.get("boards"):
        valid_boards = config["boards"]
    else:
        # Fallback to defaults from deps.py
        valid_boards = [
            "MASTER", "SCHEDULING", "READY TO SCHEDULED", "BLANKS", "SCREENS", "NECK", "EJEMPLOS", "COMPLETOS", "EDI",
            "PAPELERA DE RECICLAJE", "MAQUINA1", "MAQUINA2", "MAQUINA3", "MAQUINA4",
            "MAQUINA5", "MAQUINA6", "MAQUINA7", "MAQUINA8", "MAQUINA9", "MAQUINA10",
            "MAQUINA11", "MAQUINA12", "MAQUINA13", "MAQUINA14", "FINAL BILL"
        ]
    
    print(f"Valid boards in UI: {valid_boards}")
    
    # All orders NOT in trash
    cursor = db.orders.find({"board": {"$ne": "PAPELERA DE RECICLAJE"}})
    all_active_orders = await cursor.to_list(10000)
    print(f"Total active orders (excluding trash): {len(all_active_orders)}")
    
    # Orders that are in MASTER view but NOT in any valid board
    ghost_orders = [o for o in all_active_orders if o.get("board") not in valid_boards]
    
    if not ghost_orders:
        print("No 'ghost' orders found. All active orders belong to a valid board.")
    else:
        print(f"Found {len(ghost_orders)} 'ghost' orders (orders in MASTER but not in any other board):")
        board_counts = {}
        for o in ghost_orders:
            b = o.get("board", "None")
            board_counts[b] = board_counts.get(b, 0) + 1
        
        for board, count in board_counts.items():
            print(f"  - Board Name: '{board}' | Count: {count}")
            
        print("\nDetail of first 10 ghost orders:")
        for o in ghost_orders[:10]:
            print(f"  - Order: {o.get('order_number')} | Current Board: {o.get('board')} | Client: {o.get('client')}")

if __name__ == "__main__":
    asyncio.run(check_orders())
