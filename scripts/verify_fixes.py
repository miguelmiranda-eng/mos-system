import requests
import json
import os

API_URL = "http://localhost:8000/api"
SYNC_TOKEN = "secret_test_token123"
HEADERS = {"Authorization": f"Bearer {SYNC_TOKEN}", "Content-Type": "application/json"}

def verify_flattening():
    print("--- 1. Testing Order Creation with Custom Fields ---")
    order_number = "TEST-FLAT-001"
    payload = {
        "order_number": order_number,
        "client": "TEST CLIENT",
        "my_custom_field": "Flat Value",
        "another_field": 123
    }
    
    resp = requests.post(f"{API_URL}/orders", headers=HEADERS, json=payload)
    if resp.status_code != 200:
        print(f"FAILED to create order: {resp.text}")
        return
    
    order = resp.json()
    order_id = order['order_id']
    print(f"Created order {order_id}")
    
    # Verify custom fields are at root
    if order.get("my_custom_field") == "Flat Value":
        print("SUCCESS: my_custom_field is at root")
    else:
        print(f"FAILED: my_custom_field is missing or nested. Keys: {list(order.keys())}")

    print("\n--- 2. Testing Null Persistence (Clearing Fields) ---")
    update_payload = {
        "client": None,  # Clearing standard field
        "my_custom_field": None # Clearing custom field
    }
    
    resp = requests.put(f"{API_URL}/orders/{order_id}", headers=HEADERS, json=update_payload)
    if resp.status_code != 200:
        print(f"FAILED to update order: {resp.text}")
        return
        
    updated = resp.json()
    # Check if they are None/Null
    if updated.get("client") is None:
        print("SUCCESS: client field cleared to null")
    else:
        print(f"FAILED: client field still has value: {updated.get('client')}")
        
    if updated.get("my_custom_field") is None:
        print("SUCCESS: my_custom_field cleared to null")
    else:
        print(f"FAILED: my_custom_field still has value: {updated.get('my_custom_field')}")

    print("\n--- 3. Verifying standard keys in PDF (Manual check of logic) ---")
    # We can't easily check the PDF content here, but we can see if the order object returned by GET has custom_fields
    resp = requests.get(f"{API_URL}/orders/{order_id}", headers=HEADERS)
    final_order = resp.json()
    if "custom_fields" in final_order:
         print("WARNING: custom_fields key still exists in document (might be empty)")
    else:
         print("SUCCESS: No custom_fields key in document")

    print("\n--- Cleanup ---")
    requests.delete(f"{API_URL}/orders/{order_id}/permanent", headers=HEADERS)
    print(f"Deleted test order {order_id}")

if __name__ == "__main__":
    verify_flattening()
