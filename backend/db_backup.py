"""Database backup and restore utilities."""
import json, os, logging
from datetime import datetime, timezone
from pathlib import Path
from bson import ObjectId

logger = logging.getLogger(__name__)
SEED_DIR = Path(__file__).parent / "seed_data"

class JSONEncoder(json.JSONEncoder):
    def default(self, o):
        if isinstance(o, ObjectId):
            return str(o)
        if isinstance(o, datetime):
            return o.isoformat()
        return super().default(o)

COLLECTIONS_TO_BACKUP = [
    "users", "orders", "automations", "board_config", "board_layouts",
    "column_config", "comments", "config_colors", "config_descriptions",
    "config_options", "form_fields_config", "operators", "production_logs",
    "saved_views", "user_view_config", "notifications", "activity_logs"
]

async def backup_database(db):
    """Export all collections to JSON files."""
    SEED_DIR.mkdir(exist_ok=True)
    stats = {}
    for coll_name in COLLECTIONS_TO_BACKUP:
        docs = await db[coll_name].find({}).to_list(None)
        for doc in docs:
            if "_id" in doc:
                doc["_id"] = str(doc["_id"])
        filepath = SEED_DIR / f"{coll_name}.json"
        with open(filepath, "w", encoding="utf-8") as f:
            json.dump(docs, f, cls=JSONEncoder, ensure_ascii=False)
        stats[coll_name] = len(docs)
    logger.info(f"Backup complete: {stats}")
    return stats

async def restore_database(db):
    """Import from JSON seed files, replacing existing data."""
    if not SEED_DIR.exists():
        logger.info("No seed_data directory found, skipping restore")
        return {}
    seed_files = list(SEED_DIR.glob("*.json"))
    if not seed_files:
        logger.info("No seed files found, skipping restore")
        return {}
    # Check if restore is needed: compare total docs
    seed_total = 0
    for filepath in seed_files:
        try:
            with open(filepath, "r", encoding="utf-8") as f:
                docs = json.load(f)
                seed_total += len(docs)
        except Exception:
            pass
    db_total = 0
    for filepath in seed_files:
        coll_name = filepath.stem
        db_total += await db[coll_name].count_documents({})
    # If DB already has equal or more data, skip restore
    if db_total >= seed_total and db_total > 0:
        logger.info(f"DB has {db_total} docs, seed has {seed_total}. Skipping restore.")
        return {}
    logger.info(f"DB has {db_total} docs, seed has {seed_total}. Restoring from seed...")
    stats = {}
    for filepath in sorted(seed_files):
        coll_name = filepath.stem
        try:
            with open(filepath, "r", encoding="utf-8") as f:
                docs = json.load(f)
            if not docs:
                continue
            for doc in docs:
                if "_id" in doc:
                    del doc["_id"]
            # Drop and replace
            await db[coll_name].delete_many({})
            await db[coll_name].insert_many(docs)
            stats[coll_name] = len(docs)
            logger.info(f"Restored {coll_name}: {len(docs)} docs")
        except Exception as e:
            logger.error(f"Error restoring {coll_name}: {e}")
    return stats
