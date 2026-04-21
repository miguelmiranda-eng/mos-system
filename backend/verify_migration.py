import asyncio
from deps import db

async def verify():
    count_inv = await db.wms_inventory.count_documents({})
    count_boxes = await db.wms_boxes.count_documents({})
    sample_box = await db.wms_boxes.find_one({})
    
    print(f"Inventory Count: {count_inv}")
    print(f"Boxes Count: {count_boxes}")
    if sample_box:
        print(f"Sample LPN: {sample_box.get('box_id')} for SKU {sample_box.get('sku')}")

asyncio.run(verify())
