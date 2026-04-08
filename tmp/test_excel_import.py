import requests
import json
import pandas as pd
import io
import os

API_BASE = "http://localhost:8000/api"

def run_test():
    session = requests.Session()
    # Use internal sync token to bypass login
    session.headers.update({"Authorization": "Bearer secret_test_token123"})
    print("Using Internal Sync Token for authentication.")

    # 2. Add Custom Column "BPO"
    print("Setting custom column 'BPO'...")
    config_res = session.put(f"{API_BASE}/config/columns", json={
        "custom_columns": [
            {"key": "BPO", "label": "BPO Number"}
        ]
    })
    if config_res.status_code != 200:
        print(f"Config setup failed: {config_res.text}")
        return
    print("Custom column 'BPO' added.")

    # 3. Create Test Excel
    print("Creating test Excel...")
    df = pd.DataFrame([
        {"Order #": "EXCEL-DATE-01", "PO Cliente": "PO-DATE", "BPO Original": "BPO-DATE", "Cant": 100, "Fecha": "2024-12-31 00:00:00"},
    ])
    excel_file = io.BytesIO()
    df.to_excel(excel_file, index=False)
    excel_file.seek(0)
    print("Excel created in memory.")

    # 4. Perform Import with Mapping
    mapping = {
        "order_number": "Order #",
        "customer_po": "PO Cliente",
        "quantity": "Cant",
        "BPO": "BPO Original",
        "due_date": "Fecha"
    }
    
    print("Importing Excel...")
    files = {'file': ('test_date.xlsx', excel_file, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')}
    data = {'column_mapping': json.dumps(mapping), 'update_existing': 'false'}
    
    import_res = session.post(f"{API_BASE}/orders/import-excel", files=files, data=data)
    
    if import_res.status_code != 200:
        print(f"Import failed: {import_res.text}")
        return
    
    stats = import_res.json()
    print(f"Import results: {stats}")

    # 5. Verify order in DB
    print("Verifying order EXCEL-DATE-01...")
    order_res = session.get(f"{API_BASE}/orders/EXCEL-DATE-01")
    order = order_res.json()
    print(f"Order data: {json.dumps(order, indent=2)}")
    
    due_date = order.get("due_date")
    if due_date == "2024-12-31":
        print("SUCCESS: Date formatted correctly as YYYY-MM-DD!")
    else:
        print(f"FAILURE: Date was {due_date}, expected 2024-12-31")

if __name__ == "__main__":
    run_test()
