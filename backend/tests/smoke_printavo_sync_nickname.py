"""Smoke: el sync Printavo -> MOS lee el nombre de las quotes de SPEKTRUM.

Antes solo entendía el formato de Goodie ("SPENCERS PO#23258 - 327049 -
DISEÑO"): con "CULTURE KINGS - PO#4005609 - WOLVERINE VINTAGE TEE - REORDER" no
sacaba nada y la orden llegaba sin PO ni diseño, con marca "CULTURE" y cliente
"SPEKTRUM CALIFORNIA"; se corregía a mano una por una (207 órdenes). Medido
contra producción el 2026-10-14: 212/225 coinciden con lo corregido a mano (las
13 restantes son errores de captura o el parser trae MÁS dato), y 1105/1119
nombres de otros clientes quedan idénticos (los 14 que cambian, SCREENWORKS y
ROCK REBEL, usan el mismo formato y ganan PO y diseño).

Los nombres de abajo son REALES (job_title_a de órdenes en producción).
Corre: backend/venv/Scripts/python.exe backend/tests/smoke_printavo_sync_nickname.py
"""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
os.environ.setdefault("MONGODB_URL", "mongodb://localhost:27017")
os.environ.setdefault("DB_NAME", "mos-offline-test")
os.environ.setdefault("JWT_SECRET", "offline_secret")
os.environ.setdefault("MASTER_API_KEY", "smoke_master_key")
os.environ.setdefault("INTERNAL_SYNC_TOKEN", "smoke_sync_token")
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

import printavo_sync as ps  # noqa: E402
import printavo_export as px  # noqa: E402

ok = fail = 0


def check(nombre, cond, detalle=""):
    global ok, fail
    if cond:
        ok += 1
        print(f"   PASS  {nombre}")
    else:
        fail += 1
        print(f"   FAIL  {nombre}  {detalle}")


def campos(nick):
    """(branding, customer_po, store_po, design_#) como los deja invoice_to_orders."""
    inv = {"id": "1", "visualId": "9001", "nickname": nick, "customerDueAt": "2026-10-30",
           "contact": {"fullName": "X", "customer": {"companyName": "Spektrum California LLC"}},
           "lineItemGroups": {"nodes": [{"lineItems": {"nodes": [
               {"description": "TEE", "color": "BLACK", "itemNumber": "GI5000", "items": 10,
                "sizes": [{"size": "size_m", "count": 10}]}]}}]}}
    o = (ps.invoice_to_orders(inv) or [{}])[0]
    return o.get("branding"), o.get("customer_po"), o.get("store_po"), o.get("design_#"), o.get("client")


print("\n1) Spektrum: Culture Kings y Threadbeast")
b, cp, sp, ds, cl = campos("CULTURE KINGS - PO#4005609 - WOLVERINE VINTAGE TEE - REORDER")
check("marca = tienda completa (no 'CULTURE')", b == "CULTURE KINGS", b)
check("customer_po", cp == "4005609", cp)
check("diseño completo, sin el '- REORDER'", ds == "WOLVERINE VINTAGE TEE", ds)
check("sin PO de tienda (Culture Kings no lo trae)", not sp, sp)
check("cliente SPEKTRUM (no 'SPEKTRUM CALIFORNIA')", cl == "SPEKTRUM", cl)

b, cp, sp, ds, _ = campos("THREADBEAST - PO#992759 - SPTB082626-P5 - SLANTED LOGO TEE - NEW")
check("Threadbeast: marca", b == "THREADBEAST", b)
check("Threadbeast: customer_po", cp == "992759", cp)
check("Threadbeast: PO de tienda", sp == "SPTB082626-P5", sp)
check("Threadbeast: diseño completo (a mano quedaba 'SLANTED')", ds == "SLANTED LOGO TEE", ds)

print("\n2) ida y vuelta: el nombre que arma la quote regresa con los mismos datos")
px._hoy = lambda: "2026-10-14"
r = px._spektrum_record({"retailer": "THREADBEAST", "po_number": "5448", "store_po": "SPTB092926-L4",
                         "name": "PROPER GOODS LABEL TEE", "color": "WHITE", "blank": "MONARCH TEE",
                         "units": 10, "due_date": "2026-10-23", "sizes": {"M": 10}})
nick = px.build_quote_input(r, "c")["nickname"]
check("la quote lleva el PO de tienda", nick == "THREADBEAST - PO#5448 - SPTB092926-L4 - PROPER GOODS LABEL TEE", nick)
b, cp, sp, ds, _ = campos(nick + " - NEW")
check("y el sync lo recupera completo", (b, cp, sp, ds) ==
      ("THREADBEAST", "5448", "SPTB092926-L4", "PROPER GOODS LABEL TEE"), f"{(b, cp, sp, ds)}")
rck = px._spektrum_record({"retailer": "CULTURE KINGS", "po_number": "4005609", "name": "WOLVERINE VINTAGE TEE",
                           "color": "WHITE", "blank": "X", "units": 10, "sizes": {"M": 10}})
check("Culture Kings (sin PO de tienda) conserva su nombre de siempre",
      px.build_quote_input(rck, "c")["nickname"] == "CULTURE KINGS - PO#4005609 - WOLVERINE VINTAGE TEE")

print("\n3) Goodie y demás: igual que antes")
b, cp, sp, ds, cl = campos("SPENCERS PO#23258 - 327049 - CHC0004J3351")
check("Spencers intacto", (b, cp, sp, ds) == ("SPENCERS", "23258", "327049", "CHC0004J3351"), f"{(b, cp, sp, ds)}")
b, cp, sp, ds, _ = campos("TRACTOR SUPPLY PO#21649 - AER0154J1358 - N/A")
# Igual a lo que daba el parser de Goodie (que ya leía 'N/A' como 'N'): no se toca.
viejo = ps._parse_nickname("TRACTOR SUPPLY PO#21649 - AER0154J1358 - N/A")[1:]
check("Tractor idéntico al parser de siempre", (cp, sp, ds) == tuple(viejo), f"{(cp, sp, ds)} vs {viejo}")
b, cp, sp, ds, _ = campos("SPEKTRUM - JULY SAMPLES - NEW")
check("nombre sin 'PO#' no inventa nada", (cp, sp, ds) == (None, None, None), f"{(cp, sp, ds)}")
b, cp, sp, ds, _ = campos("ROCK REBEL - PO#08202026 - FRANKBOLTS GLOW - REORDER")
check("mismo formato en otro cliente (ROCK REBEL): marca completa, PO y diseño",
      (b, cp, ds) == ("ROCK REBEL", "08202026", "FRANKBOLTS GLOW"), f"{(b, cp, ds)}")

print(f"\n{'=' * 60}\n   {ok} PASS / {fail} FAIL\n{'=' * 60}")
sys.exit(1 if fail else 0)
