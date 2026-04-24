"""
Migración: actualiza size_locations en tickets existentes para incluir
country_of_origin y percentage por ubicación.
"""
from pymongo import MongoClient
import re

MONGO_URL = "mongodb://miranda:Mirandam2@187.124.232.150:27017/mos-system?authSource=admin"
client = MongoClient(MONGO_URL)
db = client['mos-system']

def migrate():
    tickets = list(db.wms_pick_tickets.find({"status": {"$ne": "confirmed"}}, {"_id": 0}))
    print(f"Procesando {len(tickets)} tickets pendientes...")

    updated = 0
    skipped = 0

    for ticket in tickets:
        ticket_id = ticket.get("ticket_id")
        style = str(ticket.get("style", "")).strip()
        color = str(ticket.get("color", "")).strip()
        sizes = ticket.get("sizes", {})

        if not style:
            skipped += 1
            continue

        size_locations = {}
        for sz, qty in sizes.items():
            try:
                sz_clean = str(sz).strip()
                if int(qty or 0) <= 0:
                    continue
                inv_query = {
                    "$or": [
                        {"style": {"$regex": f"^{re.escape(style)}$", "$options": "i"}},
                        {"sku": {"$regex": f"^{re.escape(style)}$", "$options": "i"}}
                    ],
                    "size": {"$regex": f"^{re.escape(sz_clean)}$", "$options": "i"},
                    "units_on_hand": {"$gt": 0}
                }
                if color:
                    inv_query["color"] = {"$regex": f"^{re.escape(color)}$", "$options": "i"}

                inv_records = list(db.wms_inventory.find(
                    inv_query,
                    {"_id": 0, "location": 1, "units_on_hand": 1, "units_allocated": 1,
                     "total_boxes": 1, "customer": 1, "country_of_origin": 1}
                ).sort("units_on_hand", -1).limit(50))

                locs = [
                    {
                        "location": r.get("location", ""),
                        "available": r.get("units_on_hand", 0) - r.get("units_allocated", 0),
                        "boxes": r.get("total_boxes", 0),
                        "customer": r.get("customer", ""),
                        "country_of_origin": r.get("country_of_origin", "")
                    }
                    for r in inv_records if r.get("location")
                ]
                locs = [l for l in locs if l["available"] > 0]

                total_avail = sum(l["available"] for l in locs)
                for l in locs:
                    l["percentage"] = round((l["available"] / total_avail) * 100) if total_avail > 0 else 0

                if locs:
                    size_locations[sz_clean] = locs
            except Exception as e:
                print(f"  Error en talla {sz} de ticket {ticket_id}: {e}")
                continue

        if size_locations:
            db.wms_pick_tickets.update_one(
                {"ticket_id": ticket_id},
                {"$set": {"size_locations": size_locations}}
            )
            print(f"  {ticket_id} ({ticket.get('order_number', '')}) — {len(size_locations)} tallas actualizadas")
            updated += 1
        else:
            skipped += 1

    print(f"\nListo: {updated} tickets actualizados, {skipped} sin cambios.")

if __name__ == "__main__":
    migrate()
