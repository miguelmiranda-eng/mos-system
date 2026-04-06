import json

with open('backup_emergent_fast_20260406_095027.json', 'r', encoding='utf-8') as f:
    data = json.load(f)

for order in data.get('orders', []):
    if order.get('order_number') == '989':
        print(json.dumps(order, indent=2))
        break
