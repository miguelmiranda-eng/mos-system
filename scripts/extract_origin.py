import requests, json, sys, time

token = 'session_1f68abab29ec4e9aa8e95562aff30bee'
base_url = 'https://kanban-mfg-system.emergent.host'
headers = {'Authorization': f'Bearer {token}', 'Content-Type': 'application/json'}
OUTPUT_FILE = 'backup_kanban_emergent.json'

print(f"Conectando a {base_url}...")
r = requests.get(f'{base_url}/api/orders', headers=headers, timeout=30)
if r.status_code != 200:
    print('Error fetching orders list:', r.status_code, r.text[:200])
    sys.exit(1)

orders_list = r.json()
# Crear un dict con los datos básicos, keyed por order_id
orders_basic = {o['order_id']: o for o in orders_list if o.get('order_id')}
order_ids = list(orders_basic.keys())
print(f'Total ordenes en API: {len(order_ids)}')

print(f"Extrayendo detalles, comentarios e imágenes...")
all_orders = []
ok_count = 0
fallback_count = 0

for i, oid in enumerate(order_ids):
    print(f"  [{i+1}/{len(order_ids)}] {oid}...", end='', flush=True)
    try:
        r2 = requests.post(
            f'{base_url}/api/orders/export-complete',
            headers=headers,
            json={'order_ids': [oid], 'include_comments': True, 'include_images': True},
            timeout=30
        )
        if r2.status_code == 200:
            batch = r2.json().get('orders', [])
            if batch:
                all_orders.extend(batch)
                ok_count += 1
                print(' OK')
            else:
                # export-complete devolvió lista vacía — usar datos básicos
                basic = orders_basic[oid].copy()
                basic.setdefault('_comments', [])
                basic.setdefault('_image_files', [])
                all_orders.append(basic)
                fallback_count += 1
                print(' FALLBACK (lista vacía)')
        else:
            # export-complete falló — usar datos básicos del listado
            basic = orders_basic[oid].copy()
            basic.setdefault('_comments', [])
            basic.setdefault('_image_files', [])
            all_orders.append(basic)
            fallback_count += 1
            print(f' FALLBACK ({r2.status_code})')

    except Exception as e:
        basic = orders_basic[oid].copy()
        basic.setdefault('_comments', [])
        basic.setdefault('_image_files', [])
        all_orders.append(basic)
        fallback_count += 1
        print(f' FALLBACK (excepción: {e})')
        time.sleep(1)

    # Guardar progreso cada 20 órdenes
    if (i + 1) % 20 == 0:
        data = {'orders': all_orders, 'total': len(all_orders)}
        with open(OUTPUT_FILE, 'w', encoding='utf-8') as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
        print(f"  >>> [{i+1}/{len(order_ids)}] Progreso guardado")

# Guardar resultado final
data = {'orders': all_orders, 'total': len(all_orders)}
with open(OUTPUT_FILE, 'w', encoding='utf-8') as f:
    json.dump(data, f, ensure_ascii=False, indent=2)

print()
print("=" * 50)
print(f"  EXTRACCIÓN COMPLETADA")
print(f"  Total exportadas:  {len(all_orders)}")
print(f"  Con comentarios:   {ok_count}")
print(f"  Solo datos base:   {fallback_count}")
print(f"  Archivo:           {OUTPUT_FILE}")
print("=" * 50)
