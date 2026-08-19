"""Smoke: los movimientos de tablero EN LOTE son visibles y buscables.

EL PROBLEMA QUE ARREGLA
La orden 2653 aparecio en EMPAQUE sin un solo movimiento de tablero en su
bitacora. Si se habia movido — dos veces, a mano — pero el registro era
invisible por como se guarda y como se lee:

  · `bulk_move_orders` deja los IDs en `previous_data.order_ids` y en `details`
    solo el conteo ("38 ordenes -> BLANKS").
  · El historial de la orden buscaba en `details.order_id` / `.order_number`.
  · La busqueda del Activity Log buscaba en los mismos campos.

Las tres piezas no se cruzaban. Y no era un caso aislado: `move_order` — el
endpoint individual que SI registra visible — tiene 0 eventos en toda la
historia, porque el tablero manda todo por bulk-move. O sea que NINGUN cambio
de tablero del sistema aparecia en la bitacora de su orden.

LO QUE SE FIJA AQUI
  1. El historial de la orden incluye el movimiento en lote y dice de que
     tablero salio y a cual llego (no "movio ordenes en lote").
  2. Buscar el NUMERO de orden en el Activity Log encuentra el lote, aunque el
     lote nunca guardo numeros: se traduce numero -> id.
  3. La respuesta trae `moves` con origen y destino por orden, y `focus` con
     la orden que se busco.
  4. Los lotes NUEVOS ya nacen legibles: `details.moves` y
     `details.order_numbers` se escriben al mover.
  5. `previous_data` NO cambia — de ahi vive el undo, y el undo sigue sirviendo.

SEGURIDAD: base DESECHABLE, se niega contra prod, se borra al terminar.
USO: set MONGODB_URL=... ; backend/venv/Scripts/python.exe backend/tests/smoke_bitacora_movimientos_lote.py
"""
import asyncio
import os
import sys

BE = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
SMOKE_DB = os.environ.get("SMOKE_DB_NAME", "mos-smoke-bitacora")
PROD_DB = os.environ.get("PROD_DB_NAME", "mos-system")
MONGO = os.environ.get("MONGODB_URL") or os.environ.get("MONGO_URL")
if not MONGO:
    sys.exit("Falta MONGODB_URL")
if SMOKE_DB == PROD_DB:
    sys.exit(f"NEGADO: SMOKE_DB_NAME es la base de producción ('{PROD_DB}').")

os.environ["MONGODB_URL"] = MONGO
os.environ["DB_NAME"] = SMOKE_DB
os.environ.setdefault("JWT_SECRET", "smoke_secret")
os.environ.setdefault("ENV", "local")
sys.path.insert(0, BE)
os.chdir(BE)

import pymongo  # noqa: E402
from passlib.hash import bcrypt  # noqa: E402

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

raw = pymongo.MongoClient(MONGO)
sdb = raw[SMOKE_DB]
ok = fail = 0


def check(n, cond, det=""):
    global ok, fail
    if cond:
        ok += 1
        print(f"   PASS  {n}")
    else:
        fail += 1
        print(f"   FAIL  {n}  {det}")


def sembrar():
    print(f"== Sembrando {SMOKE_DB} ==")
    for c in ["users", "user_sessions", "orders", "activity_logs",
              "board_config", "production_logs", "wms_movements"]:
        sdb[c].delete_many({})
    sdb.users.insert_one({
        "user_id": "u_a", "email": "a@test.local", "name": "Admin",
        "password_hash": bcrypt.hash("ad123"), "role": "admin", "active": True,
    })
    # deps.get_dynamic_boards lee board_config/{config_id: "boards"}.
    sdb.board_config.insert_one({
        "config_id": "boards",
        "boards": ["MASTER", "SCHEDULING", "BLANKS", "EMPAQUE", "COMPLETOS"],
    })
    sdb.orders.insert_many([
        {"order_id": "o_2653", "order_number": "2653", "board": "SCHEDULING",
         "client": "GOODIE TWO SLEEVES", "quantity": 222},
        {"order_id": "o_2650", "order_number": "2650", "board": "SCHEDULING",
         "client": "GOODIE TWO SLEEVES", "quantity": 207},
        # Una tercera que NO se mueve: sirve para probar que la busqueda por
        # numero no arrastra lotes ajenos.
        {"order_id": "o_9999", "order_number": "9999", "board": "SCHEDULING",
         "client": "OTRO", "quantity": 10},
    ])


async def main():
    sembrar()
    from httpx import ASGITransport, AsyncClient
    from server import app

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://smoke") as c:
        r = await c.post("/api/auth/login", json={"email": "a@test.local", "password": "ad123"})
        check("login admin", r.status_code == 200, f"{r.status_code}")

        print("\n== Se reproduce el caso 2653: dos movimientos en lote ==")
        r = await c.post("/api/orders/bulk-move",
                         json={"order_ids": ["o_2653", "o_2650"], "board": "BLANKS"})
        check("lote 1 (SCHEDULING -> BLANKS)", r.status_code == 200, f"{r.status_code} {r.text[:120]}")
        r = await c.post("/api/orders/bulk-move",
                         json={"order_ids": ["o_2653", "o_2650"], "board": "EMPAQUE"})
        check("lote 2 (BLANKS -> EMPAQUE)", r.status_code == 200, f"{r.status_code} {r.text[:120]}")
        check("la orden quedo en EMPAQUE",
              (sdb.orders.find_one({"order_id": "o_2653"}) or {}).get("board") == "EMPAQUE")

        print("\n== 1. El historial de la orden ya muestra los movimientos ==")
        r = await c.get("/api/reports/order-history/2653")
        check("el historial responde 200", r.status_code == 200, f"{r.status_code}")
        ev = r.json().get("history") or []
        lotes = [e for e in ev if e.get("action") == "bulk_move_orders"]
        check("aparecen los DOS movimientos de tablero", len(lotes) == 2, f"{len(lotes)}")
        pares = sorted((e["details"].get("from_board"), e["details"].get("to_board")) for e in lotes)
        check("dicen de donde a donde",
              pares == [("BLANKS", "EMPAQUE"), ("SCHEDULING", "BLANKS")], f"{pares}")
        check("la descripcion es legible, no 'en lote'",
              all(e["description"].startswith("Cambio de tablero:") for e in lotes),
              f"{[e['description'] for e in lotes]}")

        print("\n== 2. El Activity Log encuentra el lote buscando por NUMERO ==")
        r = await c.get("/api/activity?search=2653")
        check("la busqueda responde 200", r.status_code == 200, f"{r.status_code}")
        logs = r.json().get("logs") or []
        lot = [l for l in logs if l["action"] == "bulk_move_orders"]
        check("encuentra los dos lotes de esa orden", len(lot) == 2, f"{len(lot)}")

        print("\n== 3. Trae el detalle por orden, y marca la que se busco ==")
        uno = next((l for l in lot if l["details"]["target_board"] == "EMPAQUE"), None)
        check("hay un lote con destino EMPAQUE", uno is not None)
        movs = (uno or {}).get("details", {}).get("moves") or []
        check("moves trae las 2 ordenes del lote", len(movs) == 2, f"{movs}")
        check("moves usa NUMEROS de orden, no ids",
              sorted(m["order_number"] for m in movs) == ["2650", "2653"], f"{movs}")
        check("moves trae el origen de cada una",
              all(m["from_board"] == "BLANKS" for m in movs), f"{movs}")
        foco = (uno or {}).get("details", {}).get("focus") or []
        check("focus aisla la orden buscada",
              len(foco) == 1 and foco[0]["order_number"] == "2653", f"{foco}")

        print("\n== 4. Los lotes nuevos nacen legibles (sin resolver nada) ==")
        crudo = sdb.activity_logs.find_one({"action": "bulk_move_orders",
                                            "details.target_board": "EMPAQUE"})
        check("details.moves quedo GUARDADO", bool((crudo or {}).get("details", {}).get("moves")),
              f"{(crudo or {}).get('details')}")
        check("details.order_numbers quedo GUARDADO",
              sorted((crudo or {}).get("details", {}).get("order_numbers") or []) == ["2650", "2653"],
              f"{(crudo or {}).get('details', {}).get('order_numbers')}")

        print("\n== 5. previous_data intacto: el undo sigue funcionando ==")
        prev = (crudo or {}).get("previous_data") or {}
        check("previous_data conserva order_ids y original_boards",
              sorted(prev.get("order_ids") or []) == ["o_2650", "o_2653"]
              and (prev.get("original_boards") or {}).get("o_2653") == "BLANKS", f"{prev}")
        r = await c.post(f"/api/undo/{crudo['activity_id']}")
        check("el undo responde 200", r.status_code == 200, f"{r.status_code} {r.text[:120]}")
        check("la orden regreso a BLANKS",
              (sdb.orders.find_one({"order_id": "o_2653"}) or {}).get("board") == "BLANKS",
              f"{(sdb.orders.find_one({'order_id': 'o_2653'}) or {}).get('board')}")

        print("\n== 6. La busqueda no arrastra lotes ajenos ==")
        r = await c.get("/api/activity?search=9999")
        ajenos = [l for l in (r.json().get("logs") or []) if l["action"] == "bulk_move_orders"]
        check("la orden que no se movio no trae lotes", len(ajenos) == 0, f"{len(ajenos)}")

        print("\n== 7. Un movimiento individual sigue igual que siempre ==")
        r = await c.put("/api/orders/o_9999", json={"board": "COMPLETOS"})
        check("PUT con board responde 200", r.status_code == 200, f"{r.status_code}")
        r = await c.get("/api/reports/order-history/9999")
        acts = [e for e in (r.json().get("history") or []) if e["action"] == "update_order"]
        check("sale como update_order con el campo board",
              any("board" in (e["details"].get("changed_fields") or []) for e in acts),
              f"{[e['details'].get('changed_fields') for e in acts]}")


_err = None
try:
    asyncio.run(main())
except Exception:
    import traceback
    _err = traceback.format_exc()
finally:
    try:
        raw.drop_database(SMOKE_DB)
    except Exception:
        pass
    print(f"\n== Base {SMOKE_DB} eliminada ==")
    if _err:
        print("EXCEPCIÓN:\n" + _err)
    print(f"{ok} PASS · {fail} FAIL")
    sys.exit(1 if (fail or _err) else 0)
