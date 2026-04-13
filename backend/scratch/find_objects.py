import os
from pymongo import MongoClient
from dotenv import load_dotenv

load_dotenv('.env')
client = MongoClient(os.getenv('MONGO_URL', 'mongodb://localhost:27017/mos'))
db = client.get_database()

print("Searching for objects in pick tickets...")
tickets = list(db.wms_pick_tickets.find({}, {"_id": 0}))
for t in tickets:
    for k, v in t.items():
        if isinstance(v, dict) and k not in ['sizes', 'picked_sizes', 'size_locations']:
            print(f"Ticket {t.get('ticket_id')} has object in field '{k}': {v}")
        if isinstance(v, list):
            for item in v:
                if isinstance(item, dict) and 'url' in item:
                    print(f"Ticket {t.get('ticket_id')} has object with 'url' in list field '{k}': {item}")

print("\nSearching for objects in orders...")
orders = list(db.orders.find({}, {"_id": 0}).limit(1000))
for o in orders:
    for k, v in o.items():
        if isinstance(v, dict):
            # Special check for fields that might be rendered
            print(f"Order {o.get('order_number')} has object in field '{k}': {v}")
        if isinstance(v, list):
            for item in v:
                if isinstance(item, dict) and 'url' in item:
                    print(f"Order {o.get('order_number')} has object with 'url' in list field '{k}': {item}")
