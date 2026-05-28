"""One-off: backfill wms_inventory rows that have empty metadata fields
(manufacturer / description / country_of_origin / fabric_content) by copying
the values from the matching wms_receiving document.

A receiving "matches" an inventory row when style + color + size + customer
line up; location is used as a tiebreaker when there are multiple candidates."""
import asyncio
import os
from pathlib import Path

from dotenv import load_dotenv

ROOT = Path(__file__).parent
load_dotenv(ROOT / ".env")

from deps import db  # noqa: E402

META_FIELDS = ("manufacturer", "description", "country_of_origin", "fabric_content")


def needs_backfill(inv: dict) -> bool:
    return any(not (inv.get(f) or "").strip() for f in META_FIELDS)


async def main():
    apply = os.environ.get("APPLY") == "1"

    missing = await db.wms_inventory.find(
        {
            "$or": [{f: {"$in": ["", None]}} for f in META_FIELDS],
        },
        {
            "_id": 1, "sku": 1, "style": 1, "color": 1, "size": 1,
            "location": 1, "customer": 1,
            **{f: 1 for f in META_FIELDS},
        },
    ).to_list(100000)
    print(f"Inventory rows with at least one empty meta field: {len(missing)}")

    fixed = 0
    no_match = 0
    no_new_data = 0
    plan = []
    for inv in missing:
        style = (inv.get("style") or inv.get("sku") or "").strip()
        color = (inv.get("color") or "").strip()
        size = (inv.get("size") or "").strip()
        customer = (inv.get("customer") or "").strip()
        loc = (inv.get("location") or "").strip()
        if not style:
            no_match += 1
            continue

        # Match candidates from wms_receiving.
        query = {
            "$or": [{"style": style}, {"sku": style}],
            "color": color,
            "size": size,
        }
        if customer:
            query["customer"] = customer
        candidates = await db.wms_receiving.find(query, {"_id": 0}).to_list(20)
        if not candidates:
            # Loosen: drop size (some receivings use blank size).
            query.pop("size", None)
            candidates = await db.wms_receiving.find(query, {"_id": 0}).to_list(20)
        if not candidates:
            no_match += 1
            continue

        # Prefer one with matching location, else the most recent.
        match = next((c for c in candidates if (c.get("inv_location") or "").strip() == loc), None)
        if not match:
            match = sorted(candidates, key=lambda c: c.get("created_at", ""), reverse=True)[0]

        update = {}
        for field in META_FIELDS:
            if not (inv.get(field) or "").strip() and (match.get(field) or "").strip():
                update[field] = match[field]

        if not update:
            no_new_data += 1
            continue

        plan.append((inv["_id"], update, style, color, size))

    print(f"  fixable: {len(plan)}")
    print(f"  no matching receiving: {no_match}")
    print(f"  match found but nothing new to copy: {no_new_data}")

    if not apply:
        print("\n--- Sample (top 10) ---")
        for _id, update, style, color, size in plan[:10]:
            print(f"  {style}/{color}/{size}: + {update}")
        print(f"\nDRY RUN. Re-run with APPLY=1 to write.")
        return

    print("\n=== APPLYING ===")
    for _id, update, _, _, _ in plan:
        await db.wms_inventory.update_one({"_id": _id}, {"$set": update})
        fixed += 1
    print(f"Updated {fixed} rows.")


if __name__ == "__main__":
    asyncio.run(main())
