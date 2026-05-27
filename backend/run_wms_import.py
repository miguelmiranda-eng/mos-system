"""One-off: import WMS inventory from an Excel file using the same logic as POST /wms/import/inventory."""
import asyncio
import io
import re
import sys
import uuid
from datetime import datetime, timezone
from pathlib import Path

import openpyxl
from dotenv import load_dotenv

ROOT = Path(__file__).parent
load_dotenv(ROOT / ".env")

from deps import db  # noqa: E402


def now_iso():
    return datetime.now(timezone.utc).isoformat()


async def import_inventory(xlsx_path: Path):
    print(f"Loading workbook: {xlsx_path.name}")
    contents = xlsx_path.read_bytes()
    wb = openpyxl.load_workbook(io.BytesIO(contents), read_only=True)
    ws = wb.active
    rows = list(ws.iter_rows(values_only=True))
    if len(rows) < 2:
        raise SystemExit("El archivo esta vacio")

    headers = [str(h).strip() if h else "" for h in rows[0]]
    col_map = {h: i for i, h in enumerate(headers)}

    def get(row, name, default=""):
        idx = col_map.get(name)
        if idx is None or idx >= len(row) or row[idx] is None:
            return default
        return str(row[idx]).strip() if isinstance(default, str) else row[idx]

    now = now_iso()
    inventory_by_key = {}
    box_docs = []
    locations_set = set()
    skipped = 0

    for row in rows[1:]:
        style = get(row, "Style", "").strip().upper()
        if not style:
            skipped += 1
            continue

        color = get(row, "Color", "").strip().upper()
        size = str(get(row, "Size", "")).strip().upper()
        inv_loc = get(row, "InvLocation", "").strip().upper()
        total_boxes = int(float(get(row, "Total Boxes", 0) or 0))
        total_units = int(float(get(row, "TotalUnits", 0) or 0))
        description = get(row, "Description", "").strip().upper()
        coo = get(row, "CountryofOrigin", "").strip().upper()

        if inv_loc:
            locations_set.add(inv_loc)

        key = (style, color, size, inv_loc)
        if key not in inventory_by_key:
            inventory_id = f"inv_{uuid.uuid4().hex[:12]}"
            inventory_by_key[key] = {
                "inventory_id": inventory_id,
                "customer": get(row, "CustomerID", "").strip().upper(),
                "style": style,
                "sku": style,
                "color": color,
                "size": size,
                "size_header": get(row, "SizeHeader", "").strip().upper(),
                "manufacturer": get(row, "Manufacturer", "").strip().upper(),
                "description": description,
                "category": get(row, "Category", "").strip().upper(),
                "country_of_origin": coo,
                "fabric_content": get(row, "FabricContent", "").strip().upper(),
                "import_number": get(row, "ImportNumber", ""),
                "po": get(row, "PO", ""),
                "bpo": get(row, "BPO", ""),
                "location": inv_loc,
                "total_boxes": 0,
                "units_on_hand": 0,
                "units_allocated": 0,
                "updated_at": now,
            }

        inventory_by_key[key]["total_boxes"] += total_boxes
        inventory_by_key[key]["units_on_hand"] += total_units

        inventory_id = inventory_by_key[key]["inventory_id"]

        if total_boxes > 0:
            units_per_box = total_units // total_boxes
            remainder = total_units % total_boxes
            for i in range(total_boxes):
                box_units = units_per_box + (1 if i < remainder else 0)
                box_docs.append({
                    "box_id": f"LPN_{uuid.uuid4().hex[:8].upper()}",
                    "inventory_id": inventory_id,
                    "sku": style,
                    "color": color,
                    "size": size,
                    "units": box_units,
                    "qty": box_units,
                    "location": inv_loc,
                    "state": "putaway",
                    "customer": get(row, "CustomerID", "").strip().upper(),
                    "coo": coo,
                    "created_at": now,
                })

    inventory_docs = list(inventory_by_key.values())
    wb.close()

    print(f"Parsed: {len(inventory_docs)} inventory rows, {len(box_docs)} boxes, {len(locations_set)} locations, skipped={skipped}")

    # Fresh start
    print("Wiping wms_inventory, wms_boxes, wms_tasks, wms_allocations ...")
    del_inv = (await db.wms_inventory.delete_many({})).deleted_count
    del_box = (await db.wms_boxes.delete_many({})).deleted_count
    del_task = (await db.wms_tasks.delete_many({})).deleted_count
    del_alloc = (await db.wms_allocations.delete_many({})).deleted_count
    print(f"Deleted: inv={del_inv}, boxes={del_box}, tasks={del_task}, allocations={del_alloc}")

    if inventory_docs:
        for i in range(0, len(inventory_docs), 1000):
            await db.wms_inventory.insert_many(inventory_docs[i:i + 1000])
    if box_docs:
        for i in range(0, len(box_docs), 1000):
            await db.wms_boxes.insert_many(box_docs[i:i + 1000])
    print(f"Inserted: inv={len(inventory_docs)}, boxes={len(box_docs)}")

    locations_created = 0
    for loc_name in locations_set:
        clean_name = loc_name.strip().upper()
        if not clean_name:
            continue
        existing = await db.wms_locations.find_one({
            "name": {"$regex": f"^{re.escape(clean_name)}$", "$options": "i"}
        })
        if not existing:
            zone = clean_name.split("-")[0] if "-" in clean_name else "DEFAULT"
            await db.wms_locations.insert_one({
                "location_id": f"loc_{uuid.uuid4().hex[:12]}",
                "name": clean_name,
                "zone": zone,
                "type": "rack",
                "active": True,
                "created_at": now,
            })
            locations_created += 1
    print(f"Locations created: {locations_created} / total seen: {len(locations_set)}")

    await db.wms_movements.insert_one({
        "movement_id": f"mov_{uuid.uuid4().hex[:12]}",
        "type": "import",
        "description": f"Imported {len(inventory_docs)} inventory records from {xlsx_path.name}",
        "user": "script:run_wms_import.py",
        "timestamp": now,
    })

    return {
        "imported": len(inventory_docs),
        "skipped": skipped,
        "boxes": len(box_docs),
        "locations_created": locations_created,
        "total_locations": len(locations_set),
    }


async def main():
    xlsx = ROOT / "All_InventoryByCustomerStyleColorSize_2026_05_27_16_10.xlsx"
    if not xlsx.exists():
        raise SystemExit(f"No existe: {xlsx}")
    result = await import_inventory(xlsx)
    print("RESULT:", result)


if __name__ == "__main__":
    asyncio.run(main())
