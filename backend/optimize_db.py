import asyncio
import os
from motor.motor_asyncio import AsyncIOMotorClient
from dotenv import load_dotenv
from pathlib import Path

# WMS-009: the wms_* collections had ZERO indexes, so picking/putaway/inventory
# queries (by sku/color/size/location/status) were full collection scans. Each
# entry is (collection, keys, options). Keys is a single field name or a list of
# (field, direction) tuples for compound indexes. Every create is wrapped in
# try/except so a pre-existing duplicate (e.g. drifted box_id) can't block boot.
WMS_INDEXES = [
    ("wms_inventory", [("sku", 1), ("color", 1), ("size", 1), ("location", 1)], {}),
    ("wms_inventory", [("style", 1), ("color", 1), ("size", 1), ("location", 1)], {}),
    ("wms_inventory", "inventory_id", {"unique": True}),
    ("wms_inventory", "location", {}),
    ("wms_boxes", [("sku", 1), ("color", 1), ("size", 1), ("location", 1), ("units", 1)], {}),
    ("wms_boxes", [("style", 1), ("color", 1), ("size", 1), ("location", 1)], {}),
    ("wms_boxes", "box_id", {"unique": True}),
    ("wms_boxes", "receiving_id", {}),
    ("wms_boxes", [("status", 1), ("state", 1)], {}),
    ("wms_boxes", "seq_num", {}),
    ("wms_pick_tickets", "ticket_id", {"unique": True}),
    ("wms_pick_tickets", [("assigned_to", 1), ("status", 1)], {}),
    ("wms_pick_tickets", "order_id", {}),
    ("wms_pick_tickets", "status", {}),
    ("wms_movements", [("created_at", -1)], {}),
    ("wms_tasks", [("task_type", 1), ("status", 1)], {}),
    ("wms_locations", "name", {}),
    ("wms_asn", "asn_id", {}),
    # Core (non-WMS) uniqueness guards against duplicate generated IDs.
    ("invoices", "invoice_id", {"unique": True}),
]


async def ensure_wms_indexes(db):
    """Create the WMS indexes if missing. Idempotent and boot-safe: a unique
    index that can't be built (existing duplicates) is logged and skipped rather
    than crashing startup, so the lookup indexes still get created. Also seeds the
    atomic box-sequence counter from the current max so concurrent receivings stop
    minting duplicate BOX-ids (read-max-then-+1 race)."""
    created, skipped = 0, 0
    for coll, keys, opts in WMS_INDEXES:
        try:
            await db[coll].create_index(keys, **opts)
            created += 1
        except Exception as e:
            skipped += 1
            print(f"WMS index skipped on {coll} {keys}: {e}")
    print(f"WMS indexes ensured ({created} ok, {skipped} skipped).")

    # Seed the box-sequence counter once, from the current highest seq_num, so the
    # atomic generator (_reserve_box_seqs) never collides with existing BOX-ids.
    try:
        if not await db.counters.find_one({"_id": "wms_box_seq"}):
            last = await db.wms_boxes.find_one(sort=[("seq_num", -1)], projection={"seq_num": 1})
            max_seq = int((last or {}).get("seq_num", 0) or 0)
            await db.counters.update_one(
                {"_id": "wms_box_seq"}, {"$setOnInsert": {"seq": max_seq}}, upsert=True
            )
            print(f"Seeded wms_box_seq counter at {max_seq}.")
    except Exception as e:
        print(f"Could not seed wms_box_seq counter: {e}")


async def main():
    load_dotenv(Path(__file__).parent / '.env')
    mongo_url = os.environ.get('MONGO_URL') or os.environ.get('MONGODB_URI') or os.environ.get('MONGODB_URL')
    if not mongo_url:
        print("No Mongo URL found")
        return
    
    client = AsyncIOMotorClient(mongo_url)
    db_name = os.environ.get('DB_NAME', 'mos-system')
    db = client[db_name]
    
    print(f"Checking indexes for {db_name}.orders...")
    
    # Create index on board for faster dashboard aggregation
    try:
        await db.orders.create_index("board")
        print("Created index on 'board'")
    except Exception as e:
        print(f"Error creating index: {e}")
        
    # Create index on order_number if not exists
    try:
        await db.orders.create_index("order_number")
        print("Created index on 'order_number'")
    except Exception as e:
        print(f"Error creating index: {e}")

    # Create index on status
    try:
        await db.orders.create_index("status")
        print("Created index on 'status'")
    except Exception as e:
        print(f"Error creating index: {e}")

    try:
        await db.orders.create_index("order_id")
        print("Created index on 'orders.order_id'")
    except Exception as e:
        print(f"Error creating index: {e}")

    try:
        await db.orders.create_index([("created_at", -1)])
        print("Created index on 'orders.created_at'")
    except Exception as e:
        print(f"Error creating index: {e}")

    try:
        await db.notifications.create_index([("user_id", 1), ("created_at", -1)])
        print("Created index on 'notifications.user_id_created_at'")
    except Exception as e:
        print(f"Error creating index: {e}")

    try:
        await db.activity_logs.create_index([("timestamp", -1)])
        print("Created index on 'activity_logs.timestamp'")
    except Exception as e:
        print(f"Error creating index: {e}")

    try:
        await db.production_logs.create_index("created_at")
        print("Created index on 'production_logs.created_at'")
    except Exception as e:
        print(f"Error creating index: {e}")
        
    try:
        await db.production_logs.create_index("order_id")
        print("Created index on 'production_logs.order_id'")
    except Exception as e:
        print(f"Error creating index: {e}")

    try:
        from datetime import datetime, timedelta, timezone
        cutoff = (datetime.now(timezone.utc) - timedelta(days=1)).isoformat()
        result = await db.notifications.delete_many({"created_at": {"$lt": cutoff}})
        if result.deleted_count > 0:
            print(f"Cleaned up {result.deleted_count} old notifications")

        # Cleanup old activity logs (keep 30 days)
        log_cutoff = (datetime.now(timezone.utc) - timedelta(days=30)).isoformat()
        log_result = await db.activity_logs.delete_many({"timestamp": {"$lt": log_cutoff}})
        if log_result.deleted_count > 0:
            print(f"Cleaned up {log_result.deleted_count} old activity logs")

        # Cleanup expired sessions (keep 30 days)
        session_cutoff = (datetime.now(timezone.utc) - timedelta(days=30)).isoformat()
        session_result = await db.user_sessions.delete_many({"expires_at": {"$lt": session_cutoff}})
        if session_result.deleted_count > 0:
            print(f"Cleaned up {session_result.deleted_count} expired sessions")

        # Cleanup password resets (keep 7 days)
        reset_cutoff = (datetime.now(timezone.utc) - timedelta(days=7)).isoformat()
        reset_result = await db.password_resets.delete_many({"expires_at": {"$lt": reset_cutoff}})
        if reset_result.deleted_count > 0:
            print(f"Cleaned up {reset_result.deleted_count} old password resets")
    except Exception as e:
        print(f"Error during cleanup: {e}")

    # WMS-009: ensure WMS collection indexes when run as a standalone script too.
    try:
        await ensure_wms_indexes(db)
    except Exception as e:
        print(f"Error ensuring WMS indexes: {e}")

    print("Optimization finished.")

if __name__ == "__main__":
    asyncio.run(main())
