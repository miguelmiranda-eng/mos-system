"""Smoke OFFLINE: el reverse export LEE la muestra del PO y rellena TOPS NEEDED.

Congela la captura del sample desde el customer PO (Goodie/Spencers):
  · encabezado 'SAMPLE Y/N'  -> booleano autoritativo (siempre presente),
  · bloque 'TOPS NEEDED\\n<detalle>' ('1 SM') -> el detalle cuando existe,
y el relleno de la línea 'TOPS NEEDED:' del quote (Opción A: SAMPLE Y = lleva
muestra aunque no traiga el bloque). Cierra el ciclo probando que el forward
sync (_sample_signal) lee ese quote como "SI".

USO
───
    backend/venv/Scripts/python.exe backend/tests/smoke_printavo_export_tops.py
"""
import os
import sys

BE = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
for k in ("MONGODB_URL", "DB_NAME", "JWT_SECRET", "MASTER_API_KEY", "INTERNAL_SYNC_TOKEN", "ENV"):
    os.environ.setdefault(k, "smoke")
sys.path.insert(0, BE)

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

from printavo_export import (  # noqa: E402
    _SAMPLE_HDR_RE, _TOPS_NEEDED_RE, _tops_needed_desc, build_quote_input,
)
from printavo_sync import _sample_signal  # noqa: E402  (el lector del forward sync)

ok = fail = 0


def check(name, cond, detail=""):
    global ok, fail
    if cond:
        ok += 1
        print(f"   PASS  {name}")
    else:
        fail += 1
        print(f"   FAIL  {name}  {detail}")


# Texto tal como pdfplumber saca la página del PO (verbatim de POs reales).
PO_CON_BLOQUE = ("CLEARWATER FL 33755 USA PRE-TICKET Y SAMPLE Y CANCEL 24-SEP-26\n"
                 "BRAVADO PO 325959\nPACK\nSM-1000\nMD-1000\nLG-1000\nXL-1000\n"
                 "TOPS NEEDED\n1 SM\nNote : Req. - Requested , Rec. - Received")
PO_SOLO_SAMPLE = ("CLEARWATER FL 33755 USA PRE-TICKET Y SAMPLE Y CANCEL 24-SEP-26\n"
                  "SPENCERS PO 325915\nPACK\nSM-300\nNote : Req. - Requested , Rec. - Received")
PO_SIN_SAMPLE = PO_SOLO_SAMPLE.replace("SAMPLE Y", "SAMPLE N")

print("\n1) regex de las dos señales del PO")
check("SAMPLE Y detectado", (_SAMPLE_HDR_RE.search(PO_CON_BLOQUE) or [None]) and
      _SAMPLE_HDR_RE.search(PO_CON_BLOQUE).group(1) == "Y")
check("SAMPLE N detectado", _SAMPLE_HDR_RE.search(PO_SIN_SAMPLE).group(1) == "N")
check("bloque TOPS NEEDED = '1 SM'", _TOPS_NEEDED_RE.search(PO_CON_BLOQUE).group(1).strip() == "1 SM",
      f"{_TOPS_NEEDED_RE.search(PO_CON_BLOQUE)!r}")
check("sin bloque -> no matchea", _TOPS_NEEDED_RE.search(PO_SOLO_SAMPLE) is None)
check("no confunde 'samples' del boilerplate legal",
      _SAMPLE_HDR_RE.search("PP and TOP samples must be submitted") is None)

print("\n2) _tops_needed_desc: los tres casos (Opción A)")
check("con detalle -> el detalle", _tops_needed_desc({"tops_needed": "1 SM"}) == "TOPS NEEDED:\n1 SM")
check("SAMPLE Y sin detalle -> marca igual",
      _tops_needed_desc({"sample_required": True, "tops_needed": ""}) == "TOPS NEEDED:\nSAMPLE Y")
check("sin muestra -> header vacío", _tops_needed_desc({"sample_required": False}) == "TOPS NEEDED:")


def spencers_rec(**over):
    r = {
        "brand": "SPENCERS", "brand_prefix": "SPENCER", "po_number": "22735",
        "store_po": "325959", "store_po_notes": None, "design_num": "TPA0015M1000",
        "blank": "GI5000", "color": "AZALEA", "description": "TUPAC TEE",
        "division": "MEN SS", "status": "ORIGINAL", "front_print": "",
        "sample_required": False, "tops_needed": "",
        "qty": 4007, "unit_price": 1.35, "sizes": {"S": 4007}, "pack_lines": ["SM - 4007"],
        "pack_raw": "SM-4007", "qty_from_sizes": 4007, "sizes_match": True, "po_discrepancy": False,
        "cancel_date": "24-SEP-26", "ship_date": "22-SEP-26",
    }
    r.update(over)
    return r


def tops_line(rec):
    q = build_quote_input(rec, contact_id="CID", category_id="CAT")
    for g in q["lineItemGroups"]:
        for li in g["lineItems"]:
            if li["description"].startswith("TOPS NEEDED"):
                return li["description"]
    return None


def as_invoice(desc):
    """Invoice-shaped mínimo con esa línea TOPS NEEDED, para el forward sync."""
    return {"lineItemGroups": {"nodes": [{"lineItems": {"nodes": [{"description": desc}]}}]}}


print("\n3) build_quote_input (Spencers) rellena la línea correcta")
d1 = tops_line(spencers_rec(tops_needed="1 SM", sample_required=True))
d2 = tops_line(spencers_rec(tops_needed="", sample_required=True))
d3 = tops_line(spencers_rec(tops_needed="", sample_required=False))
check("con bloque -> TOPS NEEDED:\\n1 SM", d1 == "TOPS NEEDED:\n1 SM", f"{d1!r}")
check("SAMPLE Y sin bloque -> TOPS NEEDED:\\nSAMPLE Y", d2 == "TOPS NEEDED:\nSAMPLE Y", f"{d2!r}")
check("sin muestra -> TOPS NEEDED: (vacío)", d3 == "TOPS NEEDED:", f"{d3!r}")

print("\n4) ciclo completo: el forward sync lee esos quotes como SI/NO")
check("con detalle -> _sample_signal = SI", _sample_signal(as_invoice(d1))[0] == "SI")
check("SAMPLE Y -> _sample_signal = SI", _sample_signal(as_invoice(d2))[0] == "SI")
check("sin muestra -> _sample_signal = NO", _sample_signal(as_invoice(d3))[0] == "NO")

print(f"\n{'='*60}\n   {ok} PASS / {fail} FAIL\n{'='*60}")
sys.exit(1 if fail else 0)
