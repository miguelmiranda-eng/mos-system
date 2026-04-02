import requests
import base64
import json

# Setup
API_BASE = "http://localhost:8000/api"

# Login
login_payload = {"email": "test_load@example.com", "password": "password123"}
session = requests.Session()
res = session.post(f"{API_BASE}/auth/login", json=login_payload)
if res.status_code != 200:
    print(f"Login failed: {res.status_code} {res.text}")
    sys.exit(1)

# Get an order_id
res = session.get(f"{API_BASE}/orders")
orders = res.json()
if not orders or not isinstance(orders, list):
    print(f"Orders retrieval failed or empty: {orders}")
    import sys
    sys.exit(1)
order_id = orders[0]["order_id"]

# Try to upload a "PDF"
dummy_pdf_base64 = "data:application/pdf;base64,JVBERi0xLjQKJfbifz0KMSAwIG9iago8PAovVHlwZSAvQ2F0YWxvZwovUGFnZXMgMiAwIFIKPj4KZW5kb2JqCjIgMCBvYmoKPDAKL1R5cGUgL1BhZ2VzCi9LaWRzIFszIDAgUl0KL0NvdW50IDEKPj4KZW5kb2JqCjMgMCBvYmoKPDAKL1R5cGUgL1BhZ2UKL1BhcmVudCAyIDAgUgovTWVkaWFCb3ggWzAgMCA2MTIgNzkyXQovQ29udGVudHMgNCAwIFIKPj4KZW5kb2JqCjQgMCBvYmoKPDwKL0xlbmd0aCA0NAo+PgpzdHJlYW0KQlQKIC9GMSAyNCBUZgogIDEwMCA3MDAgVGQKICAoSGVsbG8gV29ybGQpIFRqCkVUCmVuZHN0cmVhbQplbmRvYmoKeHJlZgowIDUKMDAwMDAwMDAwMCA2NTUzNSBmIAowMDAwMDAwMDE4IDAwMDAwIG4gCjAwMDAwMDAwNzcgMDAwMDAgbiAKMDAwMDAwMDEzNyAwMDAwMCBuIAowMDAwMDAwMjQ1IDAwMDAwIG4gCnRyYWlsZXIKPDwKL1NpemUgNQovUm9vdCAxIDAgUgo+PgpzdGFydHhyZWYKMzM4CiUlRU9G"
payload = {
    "file_data": dummy_pdf_base64,
    "filename": "test_report.pdf"
}

print(f"Uploading to {API_BASE}/orders/{order_id}/images ...")
res = session.post(f"{API_BASE}/orders/{order_id}/images", json=payload)
print(f"Status: {res.status_code}")
print(f"Response: {res.text}")
