"""One-off cleanup for duplicate Printavo-synced orders.

A race in the invoice auto-sync (two overlapping passes reprocessing the same
watermark) could create several active orders that share the same order_number
(e.g. invoice 2103 created 3x). This script finds those groups among
source="printavo_auto" active orders (board != trash), KEEPS the earliest one
(by created_at, then _id) and removes the redundant copies.

Safe by default: DRY-RUN unless you pass --apply. It only ever touches
source="printavo_auto" orders that are exact order_number duplicates, so manual
orders and the trash+recreate flow are never affected.

Run it from the backend/ directory (uses the same MONGO_URL as the app):

    python dedupe_printavo_orders.py            # dry-run, shows what it would delete
    python dedupe_printavo_orders.py --apply    # actually delete the redundant copies

After --apply, redeploy so ensure_core_indexes() can build the
uniq_printavo_order_number index that prevents this from recurring.
"""
import asyncio
import os
import sys
from pathlib import Path

from dotenv import load_dotenv
from motor.motor_asyncio import AsyncIOMotorClient

TRASH_BOARD = "PAPELERA DE RECICLAJE"


async def main(apply: bool):
    load_dotenv(Path(__file__).parent / ".env")
    mongo_url = (
        os.environ.get("MONGO_URL")
        or os.environ.get("MONGODB_URI")
        or os.environ.get("MONGODB_URL")
    )
    if not mongo_url:
        print("No Mongo URL found (set MONGO_URL / MONGODB_URL).")
        return

    client = AsyncIOMotorClient(mongo_url)
    db_name = os.environ.get("DB_NAME", "mos-system")
    db = client[db_name]

    # Group active Printavo orders by order_number; only groups with >1 are dups.
    pipeline = [
        {"$match": {"source": "printavo_auto", "board": {"$ne": TRASH_BOARD}}},
        {"$group": {
            "_id": "$order_number",
            "count": {"$sum": 1},
            "docs": {"$push": {
                "oid": "$_id",
                "order_id": "$order_id",
                "created_at": "$created_at",
                "board": "$board",
                "client": "$client",
            }},
        }},
        {"$match": {"count": {"$gt": 1}}},
        {"$sort": {"_id": 1}},
    ]

    groups = await db.orders.aggregate(pipeline).to_list(None)
    if not groups:
        print("No duplicate Printavo orders found. Nothing to do.")
        return

    to_delete = []
    print(f"Found {len(groups)} order_number(s) with duplicates:\n")
    for g in groups:
        # Keep the earliest by (created_at, _id); delete the rest.
        docs = sorted(g["docs"], key=lambda d: (d.get("created_at") or "", str(d.get("oid"))))
        keep, extras = docs[0], docs[1:]
        print(f"  order_number {g['_id']}  ({g['count']} copies) — client={keep.get('client')!r}")
        print(f"    KEEP   order_id={keep.get('order_id')}  created_at={keep.get('created_at')}  board={keep.get('board')}")
        for d in extras:
            print(f"    DELETE order_id={d.get('order_id')}  created_at={d.get('created_at')}  board={d.get('board')}")
            to_delete.append(d["oid"])
        print()

    print(f"Total redundant copies to remove: {len(to_delete)}")
    if not apply:
        print("\nDRY-RUN: nothing changed. Re-run with --apply to delete the copies above.")
        return

    result = await db.orders.delete_many({"_id": {"$in": to_delete}})
    print(f"\nDeleted {result.deleted_count} duplicate order(s).")
    print("Now redeploy the backend so the uniq_printavo_order_number index can build.")


if __name__ == "__main__":
    apply = "--apply" in sys.argv[1:]
    asyncio.run(main(apply))
