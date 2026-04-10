import os
import uuid
from datetime import datetime, timezone
from pymongo import MongoClient
from dotenv import load_dotenv

load_dotenv("backend/.env")

client = MongoClient(os.environ.get("MONGODB_URL"))
db = client.get_database("mos-system")

orders_col = db.orders
tickets_col = db.wms_pick_tickets

def main():
    # Find all orders where board is BLANKS
    orders = orders_col.find({"board": "BLANKS"})
    count = 0
    created = 0
    
    for order in orders:
        count += 1
        order_num = order.get("order_number")
        
        # Check if pick ticket already exists
        exists = tickets_col.find_one({"order_number": order_num})
        if exists:
            continue
            
        # Create it
        ticket_id = f"pick_{uuid.uuid4().hex[:12]}"
        wms_style = order.get("style") or order.get("design_num") or order.get("design_#") or ""
        total_qty = order.get("quantity") or 0
        
        ticket_doc = {
            "ticket_id": ticket_id,
            "order_number": order_num,
            "customer": order.get("client") or "Unknown",
            "client": order.get("client") or "",
            "color": order.get("color") or "",
            "quantity": total_qty,
            "style": wms_style,
            "sizes": order.get("sizes") or {},
            "size_locations": {},
            "total_pick_qty": total_qty,
            "status": "pending",
            "board_category": "BLANKS",
            "blank_status": order.get("blank_status", ""),
            "picking_status": "unassigned",
            "assigned_to": None,
            "assigned_to_name": None,
            "assigned_at": None,
            "picked_sizes": {},
            "created_by": "system",
            "created_by_name": "Sistema (Migracion)",
            "created_at": datetime.now(timezone.utc).isoformat()
        }
        
        tickets_col.insert_one(ticket_doc)
        created += 1
        print(f"Created Pick Ticket for {order_num}")

    print(f"Checked {count} BLANKS orders. Created {created} tickets.")

if __name__ == "__main__":
    main()
