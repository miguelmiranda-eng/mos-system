"""
Verify that PAPELERA DE RECICLAJE is properly hidden from boards API
but still works for trash orders query.
"""
import requests
import json

BASE = "http://localhost:8000"
TOKEN = "secret_test_token123"
HEADERS = {"Authorization": f"Bearer {TOKEN}"}

PASS = "[PASS]"
FAIL = "[FAIL]"

results = []

# --- TEST 1: GET /api/config/boards should NOT include PAPELERA DE RECICLAJE ---
print("\n=== TEST 1: GET /api/config/boards ===")
r = requests.get(f"{BASE}/api/config/boards", headers=HEADERS)
boards = r.json().get("boards", [])
print(f"  Boards returned: {boards}")
if "PAPELERA DE RECICLAJE" not in boards:
    print(f"  {PASS}: 'PAPELERA DE RECICLAJE' NOT in boards list")
    results.append(True)
else:
    print(f"  {FAIL}: 'PAPELERA DE RECICLAJE' IS in boards list (should be hidden!)")
    results.append(False)

# --- TEST 2: GET /api/orders?board=MASTER should NOT contain trash orders ---
print("\n=== TEST 2: GET /api/orders?board=MASTER ===")
r = requests.get(f"{BASE}/api/orders?board=MASTER", headers=HEADERS)
master_orders = r.json()
trash_in_master = [o for o in master_orders if o.get("board") == "PAPELERA DE RECICLAJE"]
print(f"  Total MASTER orders: {len(master_orders)}")
print(f"  Trash orders in MASTER: {len(trash_in_master)}")
if len(trash_in_master) == 0:
    print(f"  {PASS}: No trash orders appear in MASTER board")
    results.append(True)
else:
    print(f"  {FAIL}: Found {len(trash_in_master)} trash orders in MASTER!")
    results.append(False)

# --- TEST 3: GET /api/orders?board=PAPELERA DE RECICLAJE SHOULD return deleted orders ---
print("\n=== TEST 3: GET /api/orders?board=PAPELERA+DE+RECICLAJE ===")
r = requests.get(f"{BASE}/api/orders", headers=HEADERS, params={"board": "PAPELERA DE RECICLAJE"})
trash_orders = r.json()
print(f"  Deleted orders in trash: {len(trash_orders)}")
if isinstance(trash_orders, list):
    print(f"  {PASS}: Trash endpoint returns list ({len(trash_orders)} orders)")
    results.append(True)
else:
    print(f"  {FAIL}: Unexpected response: {trash_orders}")
    results.append(False)

# --- TEST 4: board-counts should include PAPELERA count ---
print("\n=== TEST 4: GET /api/orders/board-counts ===")
r = requests.get(f"{BASE}/api/orders/board-counts", headers=HEADERS)
counts = r.json()
trash_count = counts.get("PAPELERA DE RECICLAJE", 0)
print(f"  Trash count from board-counts: {trash_count}")
# This should match test 3
if trash_count == len(trash_orders):
    print(f"  {PASS}: board-counts matches actual trash order count ({trash_count})")
    results.append(True)
else:
    print(f"  {FAIL}: Mismatch - board-counts={trash_count}, actual={len(trash_orders)}")
    results.append(False)

# --- SUMMARY ---
print("\n" + "="*50)
passed = sum(results)
total = len(results)
print(f"Results: {passed}/{total} tests passed")
if all(results):
    print("\033[92m✓ ALL TESTS PASSED\033[0m")
else:
    print("\033[91m✗ SOME TESTS FAILED\033[0m")
