import httpx
import json

BASE_URL = "http://localhost:8000/api"
TOKEN = "secret_test_token123"

def test_duplicate():
    headers = {
        "Authorization": f"Bearer {TOKEN}",
        "Content-Type": "application/json"
    }
    
    # Existing order number from previous check
    order_number = "409"
    
    payload = {
        "order_number": order_number,
        "client": "TEST CLIENT",
        "board": "SCHEDULING"
    }
    
    print(f"Attempting to create order with existing number: {order_number}")
    with httpx.Client() as client:
        response = client.post(f"{BASE_URL}/orders", headers=headers, json=payload)
    
    print(f"Response Status Code: {response.status_code}")
    print(f"Response Body: {response.text}")
    
    if response.status_code == 400:
        print("SUCCESS: Backend correctly rejected duplicate order.")
    else:
        print("FAILURE: Backend did not reject duplicate order as expected.")

if __name__ == "__main__":
    test_duplicate()
