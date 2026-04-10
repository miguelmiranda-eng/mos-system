import os
from pymongo import MongoClient
from dotenv import load_dotenv

load_dotenv("backend/.env")

client = MongoClient(os.environ.get("MONGODB_URL"))
db = client.get_database("mos-system")

def check_blanks_tickets():
    blanks_orders = list(db.orders.find({"board": "BLANKS"}))
    num_blanks = len(blanks_orders)
    
    order_numbers = [o.get("order_number") for o in blanks_orders]
    tickets = list(db.wms_pick_tickets.find({"order_number": {"$in": order_numbers}}))
    num_tickets = len(tickets)
    
    ticket_order_nums = set(t.get("order_number") for t in tickets)
    missing = [o.get("order_number") for o in blanks_orders if o.get("order_number") not in ticket_order_nums]
    
    print(f"Total BLANKS orders: {num_blanks}")
    print(f"Total Pick Tickets for these orders: {num_tickets}")
    print(f"Missing tickets for: {len(missing)} orders")
    if missing:
        print(f"First 5 missing: {missing[:5]}")

if __name__ == "__main__":
    check_blanks_tickets()
