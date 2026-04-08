import requests
import json

BASE_URL = "http://localhost:8000/api/config"
AUTH_TOKEN = "secret_test_token123"

def test_mapping_persistence():
    headers = {"Authorization": f"Bearer {AUTH_TOKEN}", "Content-Type": "application/json"}
    test_mapping = {"order_number": "Nro Pedido", "client": "Cliente"}
    
    print("Testing PUT /import-mapping...")
    put_res = requests.put(f"{BASE_URL}/import-mapping", headers=headers, json={"mapping": test_mapping})
    print(f"Status: {put_res.status_code}, Response: {put_res.json()}")
    
    print("\nTesting GET /import-mapping...")
    get_res = requests.get(f"{BASE_URL}/import-mapping", headers=headers)
    print(f"Status: {get_res.status_code}, Response: {get_res.json()}")
    
    if get_res.json() == test_mapping:
        print("\nSUCCESS: Mapping correctly persisted and retrieved.")
    else:
        print("\nFAILURE: Mismatch in mapping data.")

if __name__ == "__main__":
    test_mapping_persistence()
