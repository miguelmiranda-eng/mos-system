"""Restore wms_inventory + wms_boxes from the May 27 inventory snapshot.

Background: on 2026-05-29 ~01:11 UTC a re-import (migrate_full_inventory.py)
wiped wms_inventory and wms_boxes, but the re-import landed all rows with
location='' and units=0. The XLSX "All_InventoryByCustomerStyleColorSize_2026
_05_27_16_10.xlsx" — taken the day BEFORE the wipe — still has the real
InvLocation, Total Boxes and TotalUnits per customer/style/color/size combo,
so we can rebuild the collections.

Schema used here matches what Locations.js + the move-location endpoint read:
  wms_inventory:
    location: str
    units_on_hand: int      (drives Locations summary)
    total_boxes: int
    units_allocated: int
    plus style/color/size/sku/customer/manufacturer/description/category/
         country_of_origin/fabric_content
  wms_boxes:
    box_id: 'LPN' + 12 hex chars (unique)
    location: str
    units: int              (split across N boxes from TotalUnits)
    qty:   int              (mirror of units)
    state: 'located'
    status: 'located'
    plus inventory_id link and the same metadata as inventory

Run as:
    python restore_wms_from_xlsx.py        # dry-run, no DB writes
    APPLY=1 python restore_wms_from_xlsx.py  # actually apply
"""
import asyncio
import os
import secrets
from datetime import datetime, timezone
from pathlib import Path

import pandas as pd
from dotenv import load_dotenv

ROOT = Path(__file__).parent
load_dotenv(ROOT / ".env")

from deps import db  # noqa: E402

XLSX_PATH = ROOT / "All_InventoryByCustomerStyleColorSize_2026_05_27_16_10.xlsx"
BATCH_INV = 500
BATCH_BOX = 1000


def norm(v) -> str:
    if v is None or (isinstance(v, float) and pd.isna(v)):
        return ""
    return str(v).strip().upper()


def gen_lpn() -> str:
    return "LPN" + secrets.token_hex(6).upper()


def split_units(total: int, n_boxes: int) -> list:
    """Distribute `total` units across `n_boxes` as evenly as possible."""
    if n_boxes <= 0:
        return []
    base = total // n_boxes
    rem = total - base * n_boxes
    return [base + (1 if i < rem else 0) for i in range(n_boxes)]


async def main():
    apply = os.environ.get("APPLY") == "1"
    mode = "APPLY" if apply else "DRY-RUN"
    print(f"=== restore_wms_from_xlsx ({mode}) ===")

    if not XLSX_PATH.exists():
        print(f"ERROR: snapshot not found at {XLSX_PATH}")
        return

    df = pd.read_excel(XLSX_PATH, sheet_name=0)
    print(f"Loaded {len(df)} rows from {XLSX_PATH.name}")

    # Pre-flight stats over the wms collections so we know what we're replacing.
    pre_inv = await db.wms_inventory.count_documents({})
    pre_box = await db.wms_boxes.count_documents({})
    print(f"Current DB state — wms_inventory: {pre_inv}, wms_boxes: {pre_box}")

    inv_buf: list[dict] = []
    box_buf: list[dict] = []
    inv_count = 0
    box_count = 0
    total_units = 0
    now_iso = datetime.now(timezone.utc).isoformat()

    if apply:
        # The current collections are 100% corrupt (location='', units=0), so we
        # can safely wipe them before reseeding from the snapshot.
        print("Wiping current wms_inventory and wms_boxes …")
        r1 = await db.wms_inventory.delete_many({})
        r2 = await db.wms_boxes.delete_many({})
        print(f"  Deleted: {r1.deleted_count} inventory, {r2.deleted_count} boxes")

    for _, row in df.iterrows():
        customer = norm(row.get("CustomerID"))
        manufacturer = norm(row.get("Manufacturer"))
        style = norm(row.get("Style"))
        color = norm(row.get("Color"))
        size = norm(row.get("Size"))
        size_header = norm(row.get("SizeHeader"))
        origin = norm(row.get("CountryofOrigin"))
        location = norm(row.get("InvLocation"))
        description = norm(row.get("Description"))
        category = norm(row.get("Category"))
        fabric = norm(row.get("FabricContent"))
        po = norm(row.get("PO"))
        bpo = norm(row.get("BPO"))
        import_number = norm(row.get("ImportNumber"))

        try:
            boxes_n = int(row.get("Total Boxes") or 0)
            units_n = int(row.get("TotalUnits") or 0)
        except (TypeError, ValueError):
            boxes_n = 0
            units_n = 0

        if not style or units_n <= 0:
            continue

        inv_id = "inv_" + secrets.token_hex(6)
        sku = f"{style}-{color}-{size}" if (color and size) else style

        inv_doc = {
            "inventory_id": inv_id,
            "customer": customer,
            "style": style,
            "sku": sku,
            "color": color,
            "size": size,
            "size_header": size_header,
            "manufacturer": manufacturer,
            "description": description,
            "category": category,
            "country_of_origin": origin,
            "fabric_content": fabric,
            "import_number": import_number,
            "po": po,
            "bpo": bpo,
            "location": location,
            "total_boxes": boxes_n,
            "units_on_hand": units_n,
            "units_allocated": 0,
            "updated_at": now_iso,
        }
        inv_buf.append(inv_doc)
        inv_count += 1
        total_units += units_n

        # Distribute units across N boxes evenly. If Total Boxes == 0 but units
        # exist (some legacy rows), fall back to a single box holding everything.
        n_boxes = boxes_n if boxes_n > 0 else 1
        for box_units in split_units(units_n, n_boxes):
            box_buf.append({
                "box_id": gen_lpn(),
                "inventory_id": inv_id,
                "sku": sku,
                "style": style,
                "color": color,
                "size": size,
                "units": box_units,
                "qty": box_units,
                "location": location,
                "state": "located",
                "status": "located",
                "customer": customer,
                "manufacturer": manufacturer,
                "description": description,
                "coo": origin,
                "country_of_origin": origin,
                "fabric_content": fabric,
                "created_at": now_iso,
            })
            box_count += 1

        if apply and len(inv_buf) >= BATCH_INV:
            await db.wms_inventory.insert_many(inv_buf)
            inv_buf = []
        if apply and len(box_buf) >= BATCH_BOX:
            await db.wms_boxes.insert_many(box_buf)
            box_buf = []

    if apply:
        if inv_buf:
            await db.wms_inventory.insert_many(inv_buf)
        if box_buf:
            await db.wms_boxes.insert_many(box_buf)

    print()
    print(f"--- Summary ({mode}) ---")
    print(f"Inventory rows : {inv_count:,}")
    print(f"Boxes (LPNs)   : {box_count:,}")
    print(f"Total units    : {total_units:,}")

    if apply:
        # Quick sanity check post-import
        final_inv = await db.wms_inventory.count_documents({})
        final_box = await db.wms_boxes.count_documents({})
        located = await db.wms_inventory.count_documents({"location": {"$nin": [None, ""]}})
        with_units = await db.wms_inventory.count_documents({"units_on_hand": {"$gt": 0}})
        print()
        print(f"Verification: wms_inventory={final_inv}, wms_boxes={final_box}")
        print(f"  with non-empty location: {located}")
        print(f"  with units_on_hand > 0:  {with_units}")
    else:
        print("\nDry-run only. Re-run with APPLY=1 to commit.")


if __name__ == "__main__":
    asyncio.run(main())
