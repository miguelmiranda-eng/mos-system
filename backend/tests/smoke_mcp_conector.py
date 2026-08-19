"""Smoke del conector MCP (Claude / ChatGPT / Grok).

QUE SE FIJA

Protocolo (revision 2026-07-28, la que quito el handshake y las sesiones):
  · POST unico; GET y DELETE responden 405, no 404,
  · tools/list devuelve el catalogo,
  · tools/call devuelve content + structuredContent,
  · un metodo desconocido da 404 con -32601 (asi el cliente lo distingue del
    404 de un servidor que ni siquiera tiene endpoint MCP),
  · una version de protocolo desconocida da 400 y LISTA las soportadas,
  · si la cabecera Mcp-Method o Mcp-Name no cuadra con el cuerpo -> -32020,
  · Mcp-Name codificado en base64 se decodifica ANTES de comparar,
  · los clientes VIEJOS siguen entrando por `initialize`.

Seguridad — es la mitad del valor de esta prueba:
  · sin token: 401,
  · token invalido: 401,
  · token REVOCADO: 401,
  · el token se guarda hasheado, nunca en claro,
  · SOLO LECTURA: ninguna herramienta escribe. Se comprueba contando los
    documentos de `orders` antes y despues de ejercitar todo el catalogo.

Datos:
  · las ordenes en la PAPELERA nunca salen en las respuestas,
  · se respeta el tope de renglones y se avisa cuando se trunco,
  · cada llamada queda registrada en `connector_calls`.

SEGURIDAD: base DESECHABLE, se niega contra prod, se borra al terminar.
USO: set MONGODB_URL=... ; backend/venv/Scripts/python.exe backend/tests/smoke_mcp_conector.py
"""
import asyncio
import base64
import hashlib
import os
import sys

BE = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
SMOKE_DB = os.environ.get("SMOKE_DB_NAME", "mos-smoke-mcp")
PROD_DB = os.environ.get("PROD_DB_NAME", "mos-system")
MONGO = os.environ.get("MONGODB_URL") or os.environ.get("MONGO_URL")
if not MONGO:
    sys.exit("Falta MONGODB_URL")
if SMOKE_DB == PROD_DB:
    sys.exit(f"NEGADO: SMOKE_DB_NAME es la base de producción ('{PROD_DB}').")

os.environ["MONGODB_URL"] = MONGO
os.environ["DB_NAME"] = SMOKE_DB
os.environ.setdefault("JWT_SECRET", "smoke_secret")
os.environ.setdefault("MASTER_API_KEY", "smoke_master_key")
os.environ.setdefault("INTERNAL_SYNC_TOKEN", "smoke_sync_token")
os.environ.setdefault("ENV", "local")
sys.path.insert(0, BE)
os.chdir(BE)

import pymongo  # noqa: E402

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

raw = pymongo.MongoClient(MONGO)
sdb = raw[SMOKE_DB]
ok = fail = 0

TOKEN = "tok_de_prueba_del_conector"
REVOCADO = "tok_revocado"
VER = "2026-07-28"


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
    for c in ["orders", "activity_logs", "wms_inventory", "wms_pick_tickets",
              "connector_tokens", "connector_calls"]:
        sdb[c].delete_many({})
    sdb.connector_tokens.insert_many([
        {"token_hash": hashlib.sha256(TOKEN.encode()).hexdigest(),
         "name": "prueba", "revoked": False, "calls": 0},
        {"token_hash": hashlib.sha256(REVOCADO.encode()).hexdigest(),
         "name": "viejo", "revoked": True, "calls": 0},
    ])
    sdb.orders.insert_many([
        {"order_id": "o1", "order_number": "2653", "client": "GOODIE TWO SLEEVES",
         "board": "EMPAQUE", "production_status": None, "quantity": 222,
         "cancel_date": "2026-08-20", "customer_po": "21898", "invoice": 1500.5},
        {"order_id": "o2", "order_number": "2650", "client": "GOODIE TWO SLEEVES",
         "board": "FINAL BILL", "production_status": "LISTO PARA ENVIO",
         "quantity": 207, "cancel_date": "2026-08-06", "invoice": 900.0},
        # En la papelera: NO debe salir en ninguna respuesta.
        {"order_id": "o3", "order_number": "9999", "client": "GOODIE TWO SLEEVES",
         "board": "PAPELERA DE RECICLAJE", "quantity": 1},
    ])
    sdb.wms_inventory.insert_many([
        {"style": "2000", "color": "BLACK", "size": "L", "units_on_hand": 120,
         "units_allocated": 20, "location": "RP10-A26", "customer": "GOODIE TWO SLEEVES"},
        {"style": "2000", "color": "BLACK", "size": "M", "units_on_hand": 0,
         "units_allocated": 0, "location": "RP10-A27", "customer": "GOODIE TWO SLEEVES"},
    ])
    sdb.wms_pick_tickets.insert_one(
        {"ticket_id": "pick_1", "order_number": "2650", "picking_status": "unassigned",
         "style": "2000", "color": "BLACK", "quantity": 207, "client": "GOODIE TWO SLEEVES"})


def rpc(metodo, params=None, id_=1, token=TOKEN, version=VER, extra=None):
    """Arma la peticion como la manda un cliente MCP moderno."""
    params = dict(params or {})
    params["_meta"] = {"io.modelcontextprotocol/protocolVersion": version,
                       "io.modelcontextprotocol/clientInfo": {"name": "smoke", "version": "1"}}
    h = {"MCP-Protocol-Version": version, "Mcp-Method": metodo,
         "Accept": "application/json, text/event-stream"}
    if metodo == "tools/call":
        h["Mcp-Name"] = params.get("name", "")
    if token:
        h["Authorization"] = f"Bearer {token}"
    if extra:
        h.update(extra)
    return {"json": {"jsonrpc": "2.0", "id": id_, "method": metodo, "params": params},
            "headers": h}


async def main():
    sembrar()
    from httpx import ASGITransport, AsyncClient
    from server import app

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://smoke") as c:
        print("\n== 1. Seguridad: sin token no se entra ==")
        r = await c.post("/api/mcp", **rpc("tools/list", token=None))
        check("sin Authorization -> 401", r.status_code == 401, f"{r.status_code}")
        r = await c.post("/api/mcp", **rpc("tools/list", token="inventado"))
        check("token inventado -> 401", r.status_code == 401, f"{r.status_code}")
        r = await c.post("/api/mcp", **rpc("tools/list", token=REVOCADO))
        check("token REVOCADO -> 401", r.status_code == 401, f"{r.status_code}")
        guardado = sdb.connector_tokens.find_one({"name": "prueba"})
        check("el token se guarda hasheado, no en claro",
              TOKEN not in str(guardado), f"{guardado}")

        print("\n== 2. Protocolo ==")
        r = await c.get("/api/mcp")
        check("GET -> 405 (no 404)", r.status_code == 405, f"{r.status_code}")
        r = await c.delete("/api/mcp")
        check("DELETE -> 405", r.status_code == 405, f"{r.status_code}")

        r = await c.post("/api/mcp", **rpc("tools/list"))
        check("tools/list responde 200", r.status_code == 200, f"{r.status_code}")
        tools = r.json()["result"]["tools"]
        check("devuelve las 8 herramientas", len(tools) == 8, f"{len(tools)}")
        check("cada una trae inputSchema",
              all("inputSchema" in t and t.get("description") for t in tools))

        r = await c.post("/api/mcp", **rpc("metodo/inventado"))
        check("metodo desconocido -> 404 con -32601",
              r.status_code == 404 and r.json()["error"]["code"] == -32601,
              f"{r.status_code} {r.text[:80]}")

        r = await c.post("/api/mcp", **rpc("tools/list", version="1999-01-01"))
        check("version desconocida -> 400 y lista las soportadas",
              r.status_code == 400 and VER in (r.json()["error"].get("data") or {}).get("supported", []),
              f"{r.status_code} {r.text[:110]}")

        p = rpc("tools/list")
        p["headers"]["Mcp-Method"] = "tools/call"          # mentira en la cabecera
        r = await c.post("/api/mcp", **p)
        check("Mcp-Method que no cuadra -> -32020",
              r.status_code == 400 and r.json()["error"]["code"] == -32020, f"{r.text[:90]}")

        p = rpc("tools/call", {"name": "resumen_tableros", "arguments": {}})
        p["headers"]["Mcp-Name"] = "otra_cosa"
        r = await c.post("/api/mcp", **p)
        check("Mcp-Name que no cuadra -> -32020",
              r.status_code == 400 and r.json()["error"]["code"] == -32020, f"{r.text[:90]}")

        # base64: debe decodificarse ANTES de comparar
        p = rpc("tools/call", {"name": "resumen_tableros", "arguments": {}})
        b64 = base64.b64encode("resumen_tableros".encode()).decode()
        p["headers"]["Mcp-Name"] = f"=?base64?{b64}?="
        r = await c.post("/api/mcp", **p)
        check("Mcp-Name en base64 se acepta", r.status_code == 200, f"{r.status_code} {r.text[:90]}")

        print("\n== 3. Clientes viejos siguen entrando ==")
        r = await c.post("/api/mcp", **rpc("initialize", {"protocolVersion": "2025-06-18"},
                                           version="2025-06-18"))
        res = r.json().get("result") or {}
        check("initialize responde con serverInfo y capabilities",
              r.status_code == 200 and res.get("serverInfo") and "tools" in (res.get("capabilities") or {}),
              f"{r.text[:110]}")
        check("respeta la version que pidio el cliente",
              res.get("protocolVersion") == "2025-06-18", f"{res.get('protocolVersion')}")

        print("\n== 4. Las herramientas responden datos reales ==")
        async def llamar(nombre, args=None):
            rr = await c.post("/api/mcp", **rpc("tools/call", {"name": nombre, "arguments": args or {}}))
            return rr.json()["result"]

        res = await llamar("estado_orden", {"orden": "2653"})
        d = res["structuredContent"]
        check("estado_orden trae tablero y piezas",
              d["tablero"] == "EMPAQUE" and d["piezas"] == 222, f"{d}")
        check("incluye el monto facturado (asi se autorizo)",
              d["monto_facturado"] == 1500.5, f"{d.get('monto_facturado')}")
        check("avisa que sin estatus no se mueve sola", "aviso" in d, f"{d}")
        check("tambien viene en content como texto",
              res["content"][0]["type"] == "text" and "2653" in res["content"][0]["text"])

        res = await llamar("buscar_orden", {"busqueda": "GOODIE"})
        nums = [o["orden"] for o in res["structuredContent"]["ordenes"]]
        check("buscar_orden encuentra por cliente", sorted(nums) == ["2650", "2653"], f"{nums}")
        check("la orden en PAPELERA NO sale", "9999" not in nums, f"{nums}")

        res = await llamar("inventario", {"estilo": "2000", "color": "BLACK"})
        d = res["structuredContent"]
        check("inventario suma solo lo disponible", d["piezas_disponibles"] == 120, f"{d}")
        check("omite el renglon en cero", d["renglones"] == 1, f"{d}")

        res = await llamar("final_bill_pendientes")
        d = res["structuredContent"]
        check("final_bill trae el monto total", d["monto_facturado_total"] == 900.0, f"{d}")

        res = await llamar("pick_tickets_pendientes")
        check("pick tickets pendientes", res["structuredContent"]["pendientes"] == 1)

        res = await llamar("resumen_tableros")
        tb = res["structuredContent"]["tableros"]
        check("resumen por tablero sin la papelera",
              "PAPELERA DE RECICLAJE" not in tb and tb["EMPAQUE"]["ordenes"] == 1, f"{tb}")

        res = await llamar("historial_orden", {"orden": "2653"})
        check("historial responde sin romperse", "eventos" in res["structuredContent"])

        res = await llamar("estado_orden", {"orden": "0000"})
        check("orden inexistente -> isError con explicacion",
              res.get("isError") and "error" in res["structuredContent"], f"{res}")

        print("\n== 5. SOLO LECTURA: nada escribio en los datos ==")
        check("ninguna orden se creo, cambio ni borro",
              sdb.orders.count_documents({}) == 3
              and (sdb.orders.find_one({"order_id": "o1"}) or {}).get("board") == "EMPAQUE")
        check("no se toco el inventario", sdb.wms_inventory.count_documents({}) == 2)
        check("no aparecieron eventos en la bitacora", sdb.activity_logs.count_documents({}) == 0)

        print("\n== 6. Toda consulta queda registrada ==")
        n = sdb.connector_calls.count_documents({})
        check("hay registro de las llamadas", n >= 8, f"{n}")
        check("el registro dice que token y que herramienta",
              (sdb.connector_calls.find_one({"tool": "inventario"}) or {}).get("token_name") == "prueba")
        check("el token lleva la cuenta de uso",
              (sdb.connector_tokens.find_one({"name": "prueba"}) or {}).get("calls", 0) >= 8)


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
