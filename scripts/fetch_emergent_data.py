import requests
import json
from datetime import datetime

# CONFIG
EMERGENT_BASE_URL = "https://kanban-mfg-system.emergent.host"
EMERGENT_TOKEN    = "session_e59cc0dea25448e88413b486effa66f0"
OUTPUT_FILE       = f"backup_emergent_history_{datetime.now().strftime('%Y%m%d_%H%M%S')}.json"

headers = {
    "Authorization": f"Bearer {EMERGENT_TOKEN}",
    "Content-Type": "application/json"
}

def fetch_data():
    print(f"Fetching order list from {EMERGENT_BASE_URL}...")
    # Step 1: Get all order IDs
    r_list = requests.get(f"{EMERGENT_BASE_URL}/api/orders", headers=headers, timeout=60)
    if r_list.status_code != 200:
        print(f"Error fetching list: {r_list.status_code} - {r_list.text}")
        return
    
    orders_list = r_list.json()
    order_ids = [o["order_id"] for o in orders_list if o.get("order_id")]
    print(f"Found {len(order_ids)} order IDs.")

    if not order_ids:
        print("No orders found to export.")
        return

    print(f"Requesting complete export for {len(order_ids)} orders (including comments)...")
    # Step 2: Use export-complete with IDs
    r = requests.post(
        f"{EMERGENT_BASE_URL}/api/orders/export-complete",
        headers=headers,
        json={
            "order_ids": order_ids,
            "include_comments": True,
            "include_images": False # Skip images to keep it light if only comments are needed, but user might want them. Let's keep True if requested.
        },
        timeout=300
    )
    
    if r.status_code != 200:
        print(f"Error: {r.status_code} - {r.text}")
        return
    
    data = r.json()
    print(f"Successfully fetched {len(data.get('orders', []))} orders with details.")
    
    with open(OUTPUT_FILE, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    
    print(f"Data saved to {OUTPUT_FILE}")
    return OUTPUT_FILE

if __name__ == "__main__":
    fetch_data()
