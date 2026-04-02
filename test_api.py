import requests
import json
import uuid

BACKEND_URL = "http://localhost:8000"
API_URL = f"{BACKEND_URL}/api"
SESSION_TOKEN = "session_ed3a9417650f4fc198679a78d0171532"

def test_create_order():
    url = f"{API_URL}/orders"
    payload = {
        "order_number": f"VERIFY-FINAL-{uuid.uuid4().hex[:4]}",
        "client": "FINAL VERIFICATION",
        "quantity": 777,
        "board": "SCHEDULING"
    }
    print(f"POST {url}")
    try:
        res = requests.post(url, json=payload, cookies={"session_token": SESSION_TOKEN})
        print(f"Status: {res.status_code}")
        print(f"Response: {res.text}")
        if res.status_code == 200:
            return res.json().get("order_id")
    except Exception as e:
        print(f"Error: {e}")
    return None

def test_create_production(order_id):
    url = f"{API_URL}/production-logs"
    print(f"POST {url}")
    try:
        payload = {
            "order_id": order_id,
            "quantity_produced": 77,
            "machine": "MAQUINA2",
            "setup": 5,
            "operator": "FINAL OPERATOR",
            "shift": "TURNO 1"
        }
        res = requests.post(url, json=payload, cookies={"session_token": SESSION_TOKEN})
        print(f"Status: {res.status_code}")
        print(f"Response: {res.text}")
    except Exception as e:
        print(f"Error: {e}")

if __name__ == "__main__":
    order_id = test_create_order()
    if order_id:
        test_create_production(order_id)
    else:
        print("Skipping production test because order creation failed.")
