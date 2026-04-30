import requests
import json

# Configuration
BASE_URL = "http://localhost:8001/api"
# You might need a valid session token here if require_auth is active
# For local testing, we can temporarily disable require_auth or use a known token

def test_analytics():
    print("Testing production-analytics...")
    try:
        # Testing 'today' preset
        resp = requests.get(f"{BASE_URL}/production-analytics?preset=today")
        print(f"Status: {resp.status_code}")
        if resp.status_code == 200:
            data = resp.json()
            print(f"Total Produced Today: {data.get('total_produced')}")
            print(f"Machines: {len(data.get('by_machine', []))}")
        else:
            print(f"Error: {resp.text}")
            
        # Testing 'week' preset
        resp = requests.get(f"{BASE_URL}/production-analytics?preset=week")
        print(f"\nStatus (week): {resp.status_code}")
        if resp.status_code == 200:
            data = resp.json()
            print(f"Total Produced Week: {data.get('total_produced')}")
            
    except Exception as e:
        print(f"Connection failed: {e}")

if __name__ == "__main__":
    test_analytics()
