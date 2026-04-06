import asyncio
from motor.motor_asyncio import AsyncIOMotorClient
from dotenv import load_dotenv
import os, re

load_dotenv('backend/.env')
mongo_url = os.environ.get('MONGO_URL') or os.environ.get('MONGODB_URI') or os.environ.get('MONGODB_URL')

# Keys already defined in DEFAULT_COLUMNS (constants.js) - these are NOT custom
DEFAULT_KEYS = {
    'order_number','customer_po','store_po','design_#','color','cancel_date','final_bill',
    'client','branding','priority','quantity','due_date','blank_source','blank_status',
    'production_status','trim_status','trim_box','sample','artwork_status','betty_column',
    'job_title_a','job_title_b','shipping','notes', 'screens', 'links', 'po_number',
    'store_po', 'desing_#'  # include typo to remove it too
}

def dedupe_column_order(col_order):
    """Remove duplicate keys from column_order, keeping first occurrence."""
    seen = set()
    result = []
    for key in col_order:
        if key not in seen:
            seen.add(key)
            result.append(key)
    return result

async def main():
    client = AsyncIOMotorClient(mongo_url)
    match = re.search(r'/([^/?]+)(\?|$)', mongo_url)
    db_name = match.group(1) if match else 'mos-system'
    db = client[db_name]

    # --- 1. Check user_view_config ---
    print("=== user_view_config ===")
    configs = await db.user_view_config.find({}, {'_id': 0}).to_list(1000)
    for cfg in configs:
        col_order = cfg.get('column_order', [])
        if col_order:
            deduped = dedupe_column_order(col_order)
            if len(deduped) != len(col_order):
                print(f"  User {cfg.get('user_id')} board={cfg.get('board')}: {len(col_order)} -> {len(deduped)} cols (had dupes)")
                await db.user_view_config.update_one(
                    {'user_id': cfg['user_id'], 'board': cfg['board']},
                    {'$set': {'column_order': deduped}}
                )
            else:
                print(f"  User {cfg.get('user_id')} board={cfg.get('board')}: OK ({len(col_order)} cols)")

    # --- 2. Check user_board_layouts ---
    print("\n=== user_board_layouts ===")
    layouts = await db.user_board_layouts.find({}, {'_id': 0}).to_list(1000)
    for layout in layouts:
        col_order = layout.get('column_order', [])
        if col_order:
            deduped = dedupe_column_order(col_order)
            if len(deduped) != len(col_order):
                print(f"  User {layout.get('user_id')} board={layout.get('board')}: {len(col_order)} -> {len(deduped)} cols (had dupes)")
                await db.user_board_layouts.update_one(
                    {'user_id': layout['user_id'], 'board': layout['board']},
                    {'$set': {'column_order': deduped}}
                )
            else:
                print(f"  User {layout.get('user_id')} board={layout.get('board')}: OK ({len(col_order)} cols)")

    # --- 3. Check global board_layouts ---
    print("\n=== board_layouts (global) ===")
    global_layouts = await db.board_layouts.find({}, {'_id': 0}).to_list(1000)
    for layout in global_layouts:
        col_order = layout.get('column_order', [])
        if col_order:
            deduped = dedupe_column_order(col_order)
            if len(deduped) != len(col_order):
                print(f"  Board {layout.get('board')}: {len(col_order)} -> {len(deduped)} cols (had dupes)")
                await db.board_layouts.update_one(
                    {'board': layout['board']},
                    {'$set': {'column_order': deduped}}
                )
            else:
                print(f"  Board {layout.get('board')}: OK ({len(col_order)} cols)")

    print("\nDone!")

asyncio.run(main())
