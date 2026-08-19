from pymongo import MongoClient
import re

import os

# La cadena de conexión NO va en el código: se lee del entorno. Estuvo escrita
# aquí, en un repo público, desde marzo de 2026 — con un usuario `root`. Si
# falta, el script se detiene: un valor por defecto es cómo se filtró la
# primera vez.
MONGO_URL = os.environ.get("MONGODB_URL") or os.environ.get("MONGO_URL")
if not MONGO_URL:
    raise SystemExit(
        "Falta MONGODB_URL en el entorno.\n"
        "  PowerShell:  $env:MONGODB_URL = \"mongodb://usuario:clave@host:27017/mos-system?authSource=admin\"\n"
        "  bash:        export MONGODB_URL=\"...\""
    )

client = MongoClient(MONGO_URL)
db = client['mos-system']

def fix_tickets():
    query = {"picking_status": {"$ne": "completed"}}
    tickets = list(db.wms_pick_tickets.find(query))
    print(f"Revisando {len(tickets)} tickets...")

    for ticket in tickets:
        ticket_id = ticket.get("ticket_id")
        # QUITAR ESPACIOS AQUI
        style = str(ticket.get("style", "")).strip()
        color = str(ticket.get("color", "")).strip()
        sizes = ticket.get("sizes", {})
        size_locations = {}
        
        if not style: continue

        for sz, qty in sizes.items():
            try:
                sz_clean = str(sz).strip()
                if int(qty or 0) > 0:
                    inv_query = {
                        "style": {"$regex": f"^{re.escape(style)}$", "$options": "i"},
                        "size": {"$regex": f"^{re.escape(sz_clean)}$", "$options": "i"},
                        "available": {"$gt": 0}
                    }
                    if color:
                        inv_query["color"] = {"$regex": f"^{re.escape(color)}$", "$options": "i"}
                        
                    inv_records = list(db.wms_inventory.find(inv_query).sort("available", -1).limit(5))
                    locs = [{"location": r.get("inv_location", ""), "available": r.get("available", 0)} for r in inv_records if r.get("inv_location")]
                    if locs:
                        size_locations[sz] = locs
            except: continue
            
        if size_locations:
            db.wms_pick_tickets.update_one({"ticket_id": ticket_id}, {"$set": {"size_locations": size_locations}})
            print(f"Ticket {ticket_id} ({ticket.get('order_number')}) actualizado con {len(size_locations)} tallas.")

if __name__ == "__main__":
    fix_tickets()
