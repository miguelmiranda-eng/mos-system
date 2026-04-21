import asyncio
import csv
import random
import string
from datetime import datetime
from deps import db

def normalize(val):
    if not val: return ""
    return str(val).strip().upper()

def generate_lpn():
    return ''.join(random.choices(string.digits, k=10))

async def run_migration():
    print("Starting WMS 2.0 Full Migration...")
    
    # 1. Clear existing WMS collections (Requirement: Fresh Start)
    print("Clearing old database state...")
    await db.wms_inventory.delete_many({})
    await db.wms_boxes.delete_many({})
    
    csv_path = 'backend/inventory_full.csv'
    
    inventory_items = []
    box_records = []
    processed_rows = 0
    total_boxes_created = 0
    
    with open(csv_path, 'r', encoding='utf-8') as f:
        # Skip preamble (Lines 1-4)
        for _ in range(4):
            next(f)
            
        reader = csv.DictReader(f)
        
        for row in reader:
            processed_rows += 1
            if processed_rows % 1000 == 0:
                print(f"Processed {processed_rows} rows...")
            
            # Extract and normalize fields
            customer = normalize(row.get('CustomerID'))
            manufacturer = normalize(row.get('Manufacturer'))
            style = normalize(row.get('Style'))
            color = normalize(row.get('Color'))
            size = normalize(row.get('Size'))
            origin = normalize(row.get('CountryofOrigin'))
            location = normalize(row.get('InvLocation'))
            description = normalize(row.get('Description'))
            category = normalize(row.get('Category'))
            fabric = normalize(row.get('FabricContent'))
            
            try:
                boxes_count = int(row.get('Total Boxes', 0) or 0)
                units_total = int(row.get('TotalUnits', 0) or 0)
            except:
                boxes_count = 0
                units_total = 0
            
            if not style or units_total <= 0:
                continue

            # Create inventory record
            inv_item = {
                "sku": f"{style}-{color}-{size}",
                "style": style,
                "color": color,
                "size": size,
                "description": description,
                "customer": customer,
                "manufacturer": manufacturer,
                "country_of_origin": origin,
                "category": category,
                "fabric_content": fabric,
                "location": location,
                "units_on_hand": units_total,
                "units_allocated": 0,
                "total_boxes": boxes_count,
                "last_updated": datetime.utcnow()
            }
            inventory_items.append(inv_item)
            
            # Generate LPNs for boxes
            if boxes_count > 0:
                # Divide units among boxes (rough split)
                base_qty = units_total // boxes_count
                remainder = units_total % boxes_count
                
                for i in range(boxes_count):
                    qty = base_qty + (1 if i < remainder else 0)
                    lpn = generate_lpn()
                    box_records.append({
                        "box_id": f"LPN{lpn}",
                        "sku": inv_item["sku"],
                        "style": style,
                        "color": color,
                        "size": size,
                        "origin": origin,
                        "manufacturer": manufacturer,
                        "description": description,
                        "qty": qty,
                        "location": location,
                        "status": "located",
                        "created_at": datetime.utcnow()
                    })
                    total_boxes_created += 1

            # Batch flush to avoid memory issues
            if len(inventory_items) >= 500:
                await db.wms_inventory.insert_many(inventory_items)
                inventory_items = []
                
            if len(box_records) >= 1000:
                await db.wms_boxes.insert_many(box_records)
                box_records = []

    # Final flush
    if inventory_items:
        await db.wms_inventory.insert_many(inventory_items)
    if box_records:
        await db.wms_boxes.insert_many(box_records)

    print(f"Migration Complete!")
    print(f"Rows Processed: {processed_rows}")
    print(f"LPNs Generated: {total_boxes_created}")

if __name__ == "__main__":
    asyncio.run(run_migration())
