"""Smoke OFFLINE del motor de export para Culture Kings / Spektrum (sin Mongo, sin IA).

Congela la lectura DETERMINISTA del PO de Culture Kings (capa de texto) que
reemplaza a la visión: parseo por etiquetas -> mismo record que _spektrum_record
-> build_quote_input. Cubre además el bug de la fecha ISO que dejaba la quote sin
due date, y que el camino de Goodie (parse_pdf / _STYLE_RE) sigue intacto.

Basado en el PO real 'CK PO 4004681' (301u declaradas; el desglose suma 305 ->
la discrepancia del propio PO debe quedar marcada, no corregida en silencio).

USO
───
    backend/venv/Scripts/python.exe backend/tests/smoke_printavo_export_ck.py
"""
import os
import re
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

from printavo_export import (  # noqa: E402
    _iso, _parse_culturekings_text, _spektrum_record, build_quote_input, _STYLE_RE,
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


# Capa de texto tal cual la extrae pdfplumber del PO real (ojo: 'PO #:' cae en la
# línea SIGUIENTE al número, y 'REPBULIC' es un typo del propio PO).
CK_TEXT = """Due Date 2026-09-30
CULTURE KINGS
RANGE NAME: 73STUDIO - FALLOUT DAY
PACKAGING INSTRUCTIONS
1)Doblar y colocar cada unidad en una bolsa de
polietileno. 2)Colocar la etiqueta UPC con el precio en el
exterior de la bolsa. 3)Aplicar la etiqueta UPC con el
precio en la etiqueta colgante. 4)Fijar la etiqueta
colgante en la costura de la axila izquierda con el cierre
negro.
AGREGAR WOVEN LABEL NECK PRINT
No
Name: NEW CALIFORNIA REPBULIC TEE
Color: White
Blank: UNIVERSAL - CK - STANDARD TEE DROP SHOULDER
Units: 301
4004681
PO #:
XS: 5, S: 35, M: 55, L: 80, XL: 70, 2XL: 45, 3XL: 15 Total: 301
RECIBIDO:
PINTADO:
DANADO:
EMPACADO:
"""

print("\n1) _parse_culturekings_text: lee los campos etiquetados")
d = _parse_culturekings_text(CK_TEXT)
check("detecta el PO (no None)", d is not None)
check("retailer CULTURE KINGS", d["retailer"] == "CULTURE KINGS", f"{d['retailer']!r}")
check("po_number 4004681 (número antes de la etiqueta)", d["po_number"] == "4004681", f"{d['po_number']!r}")
check("name", d["name"] == "NEW CALIFORNIA REPBULIC TEE", f"{d['name']!r}")
check("color", d["color"] == "White", f"{d['color']!r}")
check("blank", d["blank"] == "UNIVERSAL - CK - STANDARD TEE DROP SHOULDER", f"{d['blank']!r}")
check("range_name", d["range_name"] == "73STUDIO - FALLOUT DAY", f"{d['range_name']!r}")
check("units 301", d["units"] == 301, f"{d['units']!r}")
check("due_date ISO", d["due_date"] == "2026-09-30", f"{d['due_date']!r}")
check("tallas crudas (excluye Total)",
      d["sizes"] == {"XS": 5, "S": 35, "M": 55, "L": 80, "XL": 70, "2XL": 45, "3XL": 15}, f"{d['sizes']}")
check("packing_instructions = 4 pasos", len(d["packing_instructions"]) == 4, f"{d['packing_instructions']}")
check("primer paso empieza en '1)'", d["packing_instructions"][0].startswith("1)"), f"{d['packing_instructions'][0]!r}")

print("\n2) _spektrum_record: mapea tallas y marca la discrepancia del PO")
r = _spektrum_record(d)
check("sizes MOS (2XL->2X, 3XL->3X)",
      r["sizes"] == {"XS": 5, "S": 35, "M": 55, "L": 80, "XL": 70, "2X": 45, "3X": 15}, f"{r['sizes']}")
check("qty = units declaradas (301)", r["qty"] == 301, f"{r['qty']}")
check("qty_from_sizes = suma real (305)", r["qty_from_sizes"] == 305, f"{r['qty_from_sizes']}")
check("sizes_match False (301 != 305, discrepancia del PO)", r["sizes_match"] is False)
check("cancel_date ISO", r["cancel_date"] == "2026-09-30", f"{r['cancel_date']}")
check("brand para elegir plantilla Spektrum", "CULTURE KING" in r["brand"].upper(), f"{r['brand']!r}")

print("\n3) build_quote_input: nickname y due date (fix _iso ISO)")
q = build_quote_input(r, contact_id="CID", contact=None, owner_id=None, category_id="CATID")
check("customerDueAt = 2026-09-30", q["customerDueAt"] == "2026-09-30", f"{q['customerDueAt']!r}")
check("dueAt con timestamp", q["dueAt"] == "2026-09-30T00:00:00Z", f"{q['dueAt']!r}")
check("nickname calcado al #3182 (guiones alrededor del PO#, usa el nombre)",
      q["nickname"] == "CULTURE KINGS - PO#4004681 - NEW CALIFORNIA REPBULIC TEE", f"{q['nickname']!r}")
check("visualPoNumber", q["visualPoNumber"] == "4004681", f"{q['visualPoNumber']!r}")

print("\n3b) plantilla calcada al quote maestro #3182")
groups = q["lineItemGroups"]
check("2 grupos", len(groups) == 2, f"{len(groups)}")
g1items = groups[0]["lineItems"]
g1 = [it["description"] for it in g1items]
g2 = [it["description"] for it in groups[1]["lineItems"]]
garment = g1items[1]
check("garment con color White", garment.get("color") == "White", f"{garment.get('color')}")
check("garment con tallas Printavo (3XL=15)",
      any(s["size"] == "size_3xl" and s["count"] == 15 for s in garment.get("sizes") or []))
check("garment SIN categoría (como el #3182)", "category" not in garment, f"{garment.get('category')}")
check("garment = nombre + blank + tallas ':' (sin color en el texto)",
      garment["description"] == ("NEW CALIFORNIA REPBULIC TEE\nUNIVERSAL - CK - STANDARD TEE DROP SHOULDER\n"
                                 "XS: 5\nS: 35\nM: 55\nL: 80\nXL: 70\n2XL: 45\n3XL: 15"),
      f"{garment['description']!r}")
check("G1[0] PRODUCTION DEPARTMENT", g1[0].startswith("PRODUCTION DEPARTMENT"))
check("G1 tiene SAMPLES N/A", "SAMPLES\nN/A" in g1)
check("G1 tiene FRONT PRINT con Screen Printing",
      any(desc.startswith("FRONT PRINT") and it.get("category") for desc, it in zip(g1, g1items)))
check("G1 tiene PRINTED NECK LABEL con Screen Printing (línea estándar, siempre)",
      any(desc == "PRINTED NECK LABEL" and it.get("category") for desc, it in zip(g1, g1items)), f"{g1}")
check("G1 tiene APPROVAL METHOD PHOTO FOR APPROVAL", "APPROVAL METHOD:\nPHOTO FOR APPROVAL" in g1)
check("G1 tiene ALLOWED SHORTAGE 0%", any(x.startswith("ALLOWED SHORTAGE") for x in g1))
check("G1 tiene SETUP FEE (301 < 1500)", any(x.startswith("SETUP FEE") for x in g1))
check("G2[0] PACKING DEPARTMENT", g2[0].startswith("PACKING DEPARTMENT"))
check("G2 trae los 4 pasos de empaque del PO",
      sum(1 for x in g2 if re.match(r"^\d+\)", x)) == 4, f"{g2}")
check("G2 tiene BULK PACK", any(x.startswith("BULK PACK") for x in g2))
check("G2 tiene Transportation Charges", any(x.startswith("Transportation Charges") for x in g2))
check("G2 termina en SPECIAL NOTES (cajas recicladas)",
      g2[-1].startswith("SPECIAL NOTES:") and "recicladas" in g2[-1], f"{g2[-1]!r}")
check("todos los precios en 0.0 (los pone Viviana en la revisión)",
      all(it["price"] == 0.0 for grp in groups for it in grp["lineItems"]))

print("\n3c) condicional del setup fee por cantidad")
big = {"retailer": "CULTURE KINGS", "po_number": "9", "name": "BIG TEE", "color": "Black",
       "blank": "CK BLANK", "units": 1500, "due_date": "2026-10-01",
       "sizes": {"M": 1500}, "packing_instructions": ["1)Doblar"]}
r_big = _spektrum_record(big)
g1_big = [it["description"] for it in build_quote_input(r_big, "CID", category_id="CAT")["lineItemGroups"][0]["lineItems"]]
check("units>=1500 -> sin SETUP FEE", not any(x.startswith("SETUP FEE") for x in g1_big), f"{g1_big}")
check("PRINTED NECK LABEL igual presente con qty grande", "PRINTED NECK LABEL" in g1_big, f"{g1_big}")

print("\n4) _iso: ISO passthrough sin romper los formatos de Goodie")
check("2026-09-30 -> 2026-09-30", _iso("2026-09-30") == "2026-09-30", f"{_iso('2026-09-30')!r}")
check("18-JUN-26 -> 2026-06-18 (Goodie intacto)", _iso("18-JUN-26") == "2026-06-18", f"{_iso('18-JUN-26')!r}")
check("5/8/2026 -> 2026-05-08 (Goodie intacto)", _iso("5/8/2026") == "2026-05-08", f"{_iso('5/8/2026')!r}")
check("basura -> None", _iso("N/A") is None, f"{_iso('N/A')!r}")

print("\n5) enrutamiento: texto que NO es CK devuelve None; Goodie sigue matcheando")
check("texto sin tallas -> None", _parse_culturekings_text("hola mundo\nName: X\n") is None)
check("texto vacío -> None", _parse_culturekings_text("") is None)
goodie_line = "GFM0118M1000 BLACK 4 WH 311381 GI5000 SHORT SLEEVE TEE 245 3.50 857.50"
check("_STYLE_RE de Goodie sigue matcheando su línea", bool(_STYLE_RE.match(goodie_line)))

print(f"\n{'='*60}\n   {ok} PASS / {fail} FAIL\n{'='*60}")
sys.exit(1 if fail else 0)
