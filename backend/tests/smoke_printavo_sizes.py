"""Smoke OFFLINE del mapeo de tallas de Printavo (no necesita Mongo ni API).

Cubre el bug de la orden 2395: la grilla del invoice sólo tiene columnas
XS/S/M/L/XL/2XL + `size_other`, así que las 15 piezas de 3X llegaron en
`size_other` y `_map_sizes` las tiraba en silencio (orden creada con 285u y sin
renglón 3X, cuando el invoice traía 300).

USO
───
    backend/venv/Scripts/python.exe backend/tests/smoke_printavo_sizes.py
"""
import json
import os
import sys

BE = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
os.environ.setdefault("MONGODB_URL", "mongodb://localhost:27017")
os.environ.setdefault("DB_NAME", "mos-offline-test")
os.environ.setdefault("JWT_SECRET", "offline_secret")
os.environ.setdefault("MASTER_API_KEY", "smoke_master_key")
os.environ.setdefault("INTERNAL_SYNC_TOKEN", "smoke_sync_token")
os.environ.setdefault("ENV", "local")
sys.path.insert(0, BE)

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

from printavo_sync import (  # noqa: E402
    _blank_style, _map_sizes, _norm_size, _real_line_items, _sizes_from_description,
    invoice_to_orders,
)

ok = fail = 0


def check(name, cond, detail=""):
    global ok, fail
    if cond:
        ok += 1
        print(f"   PASS  {name}")
    else:
        fail += 1
        print(f"   FAIL  {name}  {detail}")


# La línea real de la 2395 tal como la devuelve la API: la grilla no tiene
# columna 3XL, los 15 de 3X viajan en `size_other`.
LINE_2395 = {
    "itemNumber": "CK002",
    "color": "BROWN",
    "items": 300,
    "description": (
        "ASSEMBLY TEE\r\nCK-2174137\r\nNEW\r\nCK002 - PFD\r\nMEN SS\r\n\r\n"
        "XS - 6\r\nS - 30\r\nM - 61\r\nL - 85\r\nXL - 70\r\n2X - 33\r\n3X - 15\r\n"
    ),
    "sizes": [
        {"count": 6, "size": "size_xs"},
        {"count": 30, "size": "size_s"},
        {"count": 61, "size": "size_m"},
        {"count": 85, "size": "size_l"},
        {"count": 70, "size": "size_xl"},
        {"count": 33, "size": "size_2xl"},
        {"count": 15, "size": "size_other"},
    ],
}

print("\n1) _norm_size: variantes de talla")
for raw, exp in [
    ("size_3xl", "3X"), ("3XL", "3X"), ("3X", "3X"), ("3 XL", "3X"), ("XXXL", "3X"),
    ("XXL", "2X"), ("XXXXL", "4X"), ("5XL", "5X"), ("SM", "S"), ("MD", "M"),
    ("LG", "L"), ("YXS", "YXS"), ("2T", "2T"), ("size_other", ""), ("OSFA", ""),
]:
    got = _norm_size(raw)
    check(f"{raw!r} -> {exp!r}", got == exp, f"got {got!r}")

print("\n2) _sizes_from_description: renglones en los formatos que teclea el equipo")
desc = "SM - 61\r\nMD- 62\r\nLG-61\r\nXL-61\r\n3X : 15\r\n2XL 20\r\nGI5000\r\nROLLOUT\r\n"
got = _sizes_from_description(desc)
check("desglose completo",
      got == {"S": 61, "M": 62, "L": 61, "XL": 61, "2X": 20, "3X": 15}, f"got {got}")
check("ignora las líneas que no son renglón de talla (GI5000 / ROLLOUT)",
      len(got) == 6, f"got {got}")

print("\n3) 2395: el 3X ya no se pierde")
sizes, qty = _map_sizes(LINE_2395)
check("cantidad = 300 (no 285)", qty == 300, f"got {qty}")
check("renglón 3X = 15", sizes.get("3X") == 15, f"got {sizes}")
check("suma de tallas = cantidad", sum(sizes.values()) == qty, f"got {sizes} vs {qty}")
check("no duplica tallas que ya trajo la grilla",
      sizes == {"XS": 6, "S": 30, "M": 61, "L": 85, "XL": 70, "2X": 33, "3X": 15}, f"got {sizes}")

print("\n4) size_other sin descripción utilizable: las piezas igual cuentan")
blind = dict(LINE_2395, description="ASSEMBLY TEE\r\nCK-2174137\r\nNEW\r\nCK002 - PFD\r\n")
sizes, qty = _map_sizes(blind)
check("cantidad sigue siendo 300", qty == 300, f"got {qty}")
check("sin renglón inventado", "3X" not in sizes, f"got {sizes}")
check("suma de tallas subcuenta a propósito (queda el WARNING)",
      sum(sizes.values()) == 285, f"got {sizes}")

print("\n5) descripción que no cuadra con el remanente -> no se aplica")
mismatch = dict(LINE_2395, description="ASSEMBLY TEE\r\nCK-2174137\r\nNEW\r\nCK002 - PFD\r\n3X - 9\r\n")
sizes, qty = _map_sizes(mismatch)
check("no mete un 3X que no cuadra", "3X" not in sizes, f"got {sizes}")
check("cantidad sigue completa", qty == 300, f"got {qty}")

print("\n6) invoice real sin size_other: comportamiento intacto")
with open(os.path.join(BE, "master_invoice_23686706.json"), encoding="utf-8") as fh:
    master = json.load(fh)
reals = _real_line_items(master)
check("una sola línea de prenda", len(reals) == 1, f"got {len(reals)}")
if reals:
    _, s, q = reals[0]
    check("245u", q == 245, f"got {q}")
    check("tallas SM/MD/LG/XL", s == {"S": 61, "M": 62, "L": 61, "XL": 61}, f"got {s}")

print("\n7) _blank_style no confunde un renglón de talla con el estilo")
for cand in ["M - 15", "MD- 62", "LG-61", "2XL: 8"]:
    d = f"TEE\r\nDESIGN\r\nNEW\r\n{cand}\r\n"
    check(f"{cand!r} no es estilo", _blank_style(d) == "", f"got {_blank_style(d)!r}")
check("un estilo real sí pasa", _blank_style("TEE\r\nDESIGN\r\nNEW\r\nGI5000\r\n") == "GI5000")

print("\n8) invoice_to_orders end-to-end con la línea de la 2395")
inv = {
    "id": "23676550",
    "visualId": "2395",
    "nickname": "CULTURE KINGS - PO#2174137 -ASSEMBLY TEE - NEW",
    "customerDueAt": "2026-08-14",
    "contact": {"fullName": "X", "customer": {"companyName": "Spektrum"}},
    "lineItemGroups": {"nodes": [{"lineItems": {"nodes": [LINE_2395]}}]},
}
orders = invoice_to_orders(inv)
check("una orden", len(orders) == 1, f"got {len(orders)}")
if orders:
    o = orders[0]
    check("quantity 300", o.get("quantity") == 300, f"got {o.get('quantity')}")
    check("sizes con 3X", (o.get("sizes") or {}).get("3X") == 15, f"got {o.get('sizes')}")

print(f"\n{'='*60}\n   {ok} PASS / {fail} FAIL\n{'='*60}")
sys.exit(1 if fail else 0)
