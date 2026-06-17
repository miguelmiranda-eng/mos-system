"""WMS-011: enforce non-negative inventory at the DATABASE level.

Until now nothing stopped wms_inventory.units_on_hand / units_allocated from
going negative — only application-level clamps, which a buggy or concurrent
writer could bypass. This one-shot migration:

  1. Heals any existing negative rows by clamping them to 0 (so the validator
     can be installed without rejecting later updates to those rows).
  2. Installs a $jsonSchema validator that forbids negative units going forward.

validationLevel is "moderate": Mongo validates inserts and updates to documents
that already satisfy the schema, but won't block updates to any legacy document
that still violates it — a safe rollout for a live warehouse.

Run once:  python -m scripts.wms_inventory_validator   (from backend/)
       or:  python backend/scripts/wms_inventory_validator.py
"""
import asyncio
import os
from motor.motor_asyncio import AsyncIOMotorClient
from dotenv import load_dotenv
from pathlib import Path

VALIDATOR = {
    "$jsonSchema": {
        "bsonType": "object",
        "properties": {
            "units_on_hand": {
                "bsonType": ["int", "long", "double"],
                "minimum": 0,
                "description": "must be >= 0",
            },
            "units_allocated": {
                "bsonType": ["int", "long", "double"],
                "minimum": 0,
                "description": "must be >= 0",
            },
            "total_boxes": {
                "bsonType": ["int", "long", "double"],
                "minimum": 0,
                "description": "must be >= 0",
            },
        },
    }
}


async def main():
    load_dotenv(Path(__file__).resolve().parent.parent / ".env")
    mongo_url = (
        os.environ.get("MONGO_URL")
        or os.environ.get("MONGODB_URI")
        or os.environ.get("MONGODB_URL")
    )
    if not mongo_url:
        print("No Mongo URL found in environment")
        return
    db = AsyncIOMotorClient(mongo_url)[os.environ.get("DB_NAME", "mos-system")]

    # 1. Heal existing negatives so the validator install is non-disruptive.
    for field in ("units_on_hand", "units_allocated", "total_boxes"):
        res = await db.wms_inventory.update_many(
            {field: {"$lt": 0}}, [{"$set": {field: {"$max": [0, f"${field}"]}}}]
        )
        if res.modified_count:
            print(f"Healed {res.modified_count} rows with negative {field}")

    # 2. Install (or update) the schema validator.
    await db.command(
        {
            "collMod": "wms_inventory",
            "validator": VALIDATOR,
            "validationLevel": "moderate",
            "validationAction": "error",
        }
    )
    print("wms_inventory validator installed (non-negative units enforced).")


if __name__ == "__main__":
    asyncio.run(main())
