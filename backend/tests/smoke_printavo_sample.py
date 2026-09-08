"""Smoke OFFLINE de la señal "lleva sample" leída del work order de Printavo.

Congela la lectura de la sección de muestra física que el forward sync estampa
en cada orden que crea (`sample_printavo`). Fixtures calcados a invoices reales:
  · Spencers  -> línea "TOPS NEEDED" con detalle  => SI
  · Culture Kings / Tractor -> línea "SAMPLES / N/A"  => NO
  · invoice sin la sección (visto en varios PO de CK) => desconocido (None)

Trampa cubierta: "APPROVAL METHOD:\nPlease follow APPROVED SAMPLE..." dice
SAMPLE pero NO es la sección — no debe marcar SI (falso positivo del 2406).

USO
───
    backend/venv/Scripts/python.exe backend/tests/smoke_printavo_sample.py
"""
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

from printavo_sync import _sample_signal, invoice_to_orders  # noqa: E402

ok = fail = 0


def check(name, cond, detail=""):
    global ok, fail
    if cond:
        ok += 1
        print(f"   PASS  {name}")
    else:
        fail += 1
        print(f"   FAIL  {name}  {detail}")


def _inv(line_items, **kw):
    base = {
        "id": kw.get("id", "gid://x"),
        "visualId": kw.get("visualId", "9001"),
        "nickname": kw.get("nickname", "SPENCERS PO#1 - 2 - 3"),
        "customerDueAt": "2026-09-30",
        "contact": {"fullName": "X", "customer": {"companyName": "GOODIE TWO SLEEVES"}},
        "lineItemGroups": {"nodes": [{"lineItems": {"nodes": line_items}}]},
    }
    return base


# Línea de prenda real (con color+tallas) para que invoice_to_orders cree orden.
GARMENT = {"color": "WHITE", "items": 245, "description": "TEE\r\nDESIGN\r\nROLLOUT\r\nGI5000\r\nMEN SS",
           "sizes": [{"count": 245, "size": "size_m"}]}

# Secciones tal como salen del work order (verbatim de invoices reales).
TOPS_NEEDED = {"color": "", "items": 0,
               "description": "TOPS NEEDED\r\n1 MD\r\n1 LG\r\n1 XL\r\n1 XXL\r\nECOM SAMPLE\r\nM - 1"}
TOPS_NEEDED_EMPTY = {"color": "", "items": 0, "description": "TOPS NEEDED"}
SAMPLES_NA = {"color": "", "items": 0, "description": "SAMPLES\r\nN/A"}
SAMPLES_DETALLE = {"color": "", "items": 0, "description": "SAMPLES\r\n2 MD\r\n1 LG"}
APPROVAL = {"color": "", "items": 0,
            "description": "APPROVAL METHOD:\r\nPlease follow APPROVED SAMPLE and send picture for REFERENCE."}

print("\n1) _sample_signal: clasificación por header")
f, raw = _sample_signal(_inv([GARMENT, TOPS_NEEDED, APPROVAL]))
check("Spencers TOPS NEEDED con detalle -> SI", f == "SI", f"got {f!r}")
check("raw conserva la línea", raw and raw.startswith("TOPS NEEDED"), f"got {raw!r}")

f, _ = _sample_signal(_inv([GARMENT, SAMPLES_NA]))
check("CK SAMPLES/N/A -> NO", f == "NO", f"got {f!r}")

f, _ = _sample_signal(_inv([GARMENT, SAMPLES_DETALLE]))
check("SAMPLES con detalle -> SI", f == "SI", f"got {f!r}")

f, _ = _sample_signal(_inv([GARMENT, TOPS_NEEDED_EMPTY]))
check("TOPS NEEDED sin cuerpo -> NO", f == "NO", f"got {f!r}")

f, raw = _sample_signal(_inv([GARMENT, APPROVAL]))
check("solo APPROVAL METHOD (dice SAMPLE) -> desconocido, no SI", f is None, f"got {f!r}")

f, _ = _sample_signal(_inv([GARMENT]))
check("invoice sin sección -> desconocido (None)", f is None, f"got {f!r}")

print("\n2) invoice_to_orders: estampa sample_printavo en la orden")
o = invoice_to_orders(_inv([GARMENT, TOPS_NEEDED]))[0]
check("orden lleva sample_printavo=SI", o.get("sample_printavo") == "SI", f"got {o.get('sample_printavo')!r}")
check("guarda el raw", (o.get("sample_printavo_raw") or "").startswith("TOPS NEEDED"), f"got {o.get('sample_printavo_raw')!r}")

o = invoice_to_orders(_inv([GARMENT, SAMPLES_NA]))[0]
check("orden con SAMPLES/N/A -> sample_printavo=NO", o.get("sample_printavo") == "NO", f"got {o.get('sample_printavo')!r}")

o = invoice_to_orders(_inv([GARMENT]))[0]
check("desconocido -> el campo NO se guarda (ausente)", "sample_printavo" not in o, f"got {o.get('sample_printavo')!r}")
check("y tampoco el raw", "sample_printavo_raw" not in o)

print("\n3) invoice-level: se estampa en TODAS las hermanas por color")
two_colors = [
    {"color": "WHITE", "items": 100, "description": "TEE\r\nD\r\nR\r\nGI5000", "sizes": [{"count": 100, "size": "size_m"}]},
    {"color": "BLACK", "items": 50, "description": "TEE\r\nD\r\nR\r\nGI5000", "sizes": [{"count": 50, "size": "size_l"}]},
    TOPS_NEEDED,
]
orders = invoice_to_orders(_inv(two_colors))
check("dos órdenes hermanas (por color)", len(orders) == 2, f"got {len(orders)}")
check("las dos llevan sample_printavo=SI",
      all(o.get("sample_printavo") == "SI" for o in orders), f"got {[o.get('sample_printavo') for o in orders]}")

print(f"\n{'='*60}\n   {ok} PASS / {fail} FAIL\n{'='*60}")
sys.exit(1 if fail else 0)
