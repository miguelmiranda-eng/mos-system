"""E2E de la superficie externa MOS↔Command (fila "Pruebas" del plan).

Simula a Command contra un backend REAL (por default producción). Dos baterías:

  A) SIN llave (siempre corre): compuertas de autenticación (401) y el
     default-deny de la Tarea 2.3 — el middleware dispara con la sola
     PRESENCIA del header X-API-Key, así que una llave falsa basta para
     probar que las rutas fuera de la superficie documentada responden 403
     antes de llegar al endpoint, y que las permitidas piden autenticación.

  B) CON llave (solo si hay MOS_API_KEY y MOS_API_CUSTOMER en el entorno):
     la superficie documentada completa con datos reales — aislamiento por
     cliente, sobres de paginación, el par qty_ordered/qty_shipped, catálogo
     de delay_code y las validaciones de escritura.

REGLA DE ORO: este script NO persiste nada. Todas las pruebas de escritura
usan payloads que el backend DEBE rechazar (llave de API ⇒ strict forzado;
delay_code inválido se valida antes de tocar la base). El POST feliz queda
para la integración real de Command.

Uso:
    python backend/tests/e2e_command_api.py
    MOS_BASE_URL=https://... MOS_API_KEY=... MOS_API_CUSTOMER=SPEKTRUM \
        python backend/tests/e2e_command_api.py
"""
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request

BASE = os.environ.get("MOS_BASE_URL", "https://mosdatabase-backend.k9pirj.easypanel.host").rstrip("/")
LLAVE = os.environ.get("MOS_API_KEY", "").strip()
CLIENTE = os.environ.get("MOS_API_CUSTOMER", "").strip()

resultados = []


def pide(metodo, ruta, llave=None, body=None, form=None):
    """Devuelve (status, json|texto). Nunca lanza: los errores HTTP son el dato."""
    url = BASE + ruta
    headers = {}
    if llave:
        headers["X-API-Key"] = llave
    data = None
    if form is not None:
        data = urllib.parse.urlencode(form).encode()
        headers["Content-Type"] = "application/x-www-form-urlencoded"
    elif body is not None:
        data = json.dumps(body).encode()
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=data, headers=headers, method=metodo)
    try:
        with urllib.request.urlopen(req, timeout=45) as r:
            crudo = r.read().decode("utf-8", "replace")
            status = r.status
    except urllib.error.HTTPError as e:
        crudo = e.read().decode("utf-8", "replace")
        status = e.code
    except Exception as e:
        return -1, f"(sin respuesta: {e})"
    try:
        return status, json.loads(crudo)
    except ValueError:
        return status, crudo


def check(nombre, condicion, detalle=""):
    resultados.append((bool(condicion), nombre, detalle))
    print(("  OK   " if condicion else "  FALLO") + f" {nombre}" + (f"  [{detalle}]" if detalle and not condicion else ""))


def bateria_a():
    """Compuertas sin llave real."""
    print("— Batería A: compuertas y default-deny (sin llave real) —")
    for metodo, ruta in [("GET", "/api/orders"), ("GET", "/api/shipping"),
                         ("GET", "/api/shipping/delay-codes"),
                         ("GET", "/api/packing-list?order=1"),
                         ("GET", "/api/scheduled-shipments")]:
        s, _ = pide(metodo, ruta)
        check(f"sin llave: {metodo} {ruta} -> 401", s == 401, f"status={s}")

    FALSA = "e2e-llave-falsa"
    # Fuera de la superficie documentada: el middleware responde 403 ANTES de
    # autenticar (por eso una llave falsa sirve para probarlo).
    for metodo, ruta in [("GET", "/api/wms/boxes"), ("GET", "/api/wms/movements"),
                         ("POST", "/api/wms/movements"), ("GET", "/api/wms/inventory"),
                         ("GET", "/api/production-analytics"), ("GET", "/api/production-summary"),
                         ("POST", "/api/packing/export"), ("GET", "/api/orders/123/comments"),
                         ("POST", "/api/scheduled-shipments/week-config"),
                         ("PUT", "/api/wms/pick-tickets/t1/pick-size"),
                         ("GET", "/api/orders/check-number"), ("POST", "/api/orders"),
                         ("DELETE", "/api/orders/123"), ("GET", "/api/wms/audit/health")]:
        s, cuerpo = pide(metodo, ruta, llave=FALSA, body={} if metodo in ("POST", "PUT") else None)
        es_403_superficie = s == 403 and "superficie" in str(cuerpo)
        check(f"default-deny: {metodo} {ruta} con llave -> 403 superficie",
              es_403_superficie, f"status={s} cuerpo={str(cuerpo)[:90]}")

    # Dentro de la superficie: el middleware deja pasar y la llave falsa
    # muere en la autenticación (401) — nunca 403 de superficie.
    for metodo, ruta in [("GET", "/api/orders"), ("GET", "/api/shipping"),
                         ("GET", "/api/shipping/delay-codes"),
                         ("GET", "/api/wms/pick-tickets"),
                         ("GET", "/api/wms/inventory/history"),
                         ("GET", "/api/wms/allocations"), ("GET", "/api/wms/shipments"),
                         ("GET", "/api/orders/available-to-ship")]:
        s, _ = pide(metodo, ruta, llave=FALSA)
        check(f"superficie permitida: {metodo} {ruta} con llave falsa -> 401", s == 401, f"status={s}")

    s, _ = pide("GET", "/docs")
    check("informativo: GET /docs es público (hallazgo 7.1, decisión pendiente)", s == 200, f"status={s}")


def bateria_b():
    """Superficie completa con llave real. Solo lecturas + escrituras rechazadas."""
    print(f"— Batería B: superficie documentada con llave real (customer={CLIENTE}) —")
    q = f"customer={urllib.parse.quote(CLIENTE)}"

    s, _ = pide("GET", "/api/orders", llave=LLAVE)
    check("GET /api/orders sin customer -> 403", s == 403, f"status={s}")
    s, _ = pide("GET", "/api/orders?customer=CLIENTE-QUE-NO-EXISTE-E2E", llave=LLAVE)
    check("GET /api/orders con customer fuera de alcance -> 403", s == 403, f"status={s}")

    s, cuerpo = pide("GET", f"/api/orders?{q}&skip=0&limit=5", llave=LLAVE)
    sobre = isinstance(cuerpo, dict) and all(k in cuerpo for k in ("total", "skip", "limit", "items"))
    check("GET /api/orders con skip -> sobre {total,skip,limit,items}", s == 200 and sobre, f"status={s}")
    orden_muestra = ""
    if sobre and cuerpo["items"]:
        orden_muestra = str(cuerpo["items"][0].get("order_number") or "")
        propios = all(str(i.get("client") or "").strip().upper() == CLIENTE.upper() for i in cuerpo["items"])
        check("GET /api/orders: todos los items son del cliente", propios)

    for ruta in (f"/api/orders/available-to-ship?{q}&skip=0&limit=5",
                 f"/api/orders/shipped?{q}&skip=0&limit=5"):
        s, cuerpo = pide("GET", ruta, llave=LLAVE)
        sobre = isinstance(cuerpo, dict) and "items" in cuerpo and "total" in cuerpo
        par = (not sobre or not cuerpo["items"]
               or all("qty_shipped" in i and "qty_ordered" in i for i in cuerpo["items"]))
        check(f"GET {ruta.split('?')[0]} -> sobre + par qty_ordered/qty_shipped", s == 200 and sobre and par, f"status={s}")

    if orden_muestra:
        s, cuerpo = pide("GET", f"/api/packing-list?order={urllib.parse.quote(orden_muestra)}&{q}", llave=LLAVE)
        forma = isinstance(cuerpo, dict) and "qty_ordered" in cuerpo and "qty_shipped" in cuerpo and "packing_list" in cuerpo
        check("GET /api/packing-list de una orden del cliente -> contrato PackingListInfo", s == 200 and forma, f"status={s}")
        s, _ = pide("GET", f"/api/orders/{urllib.parse.quote(orden_muestra)}?{q}", llave=LLAVE)
        check("GET /api/orders/{orden} del cliente -> 200", s == 200, f"status={s}")
    s, _ = pide("GET", f"/api/orders/ORDEN-INEXISTENTE-E2E?{q}", llave=LLAVE)
    check("GET /api/orders/{inexistente} -> 404", s == 404, f"status={s}")

    s, cuerpo = pide("GET", f"/api/shipping?{q}&skip=0&limit=5", llave=LLAVE)
    sobre = isinstance(cuerpo, dict) and "items" in cuerpo
    detalle = not sobre or all("orders_detail" in r for r in cuerpo["items"])
    check("GET /api/shipping -> sobre + orders_detail en cada registro", s == 200 and sobre and detalle, f"status={s}")

    s, cuerpo = pide("GET", "/api/shipping/delay-codes", llave=LLAVE)
    codigos = {c.get("code") for c in (cuerpo or {}).get("delay_codes", [])} if isinstance(cuerpo, dict) else set()
    check("GET /api/shipping/delay-codes -> catálogo de 7 causas", s == 200 and len(codigos) == 7, f"status={s} codigos={sorted(codigos)}")

    s, cuerpo = pide("GET", f"/api/scheduled-shipments?{q}", llave=LLAVE)
    solo_cliente = (isinstance(cuerpo, dict) and "items" in cuerpo
                    and all(str(i.get("client") or "").strip().upper() == CLIENTE.upper() for i in cuerpo["items"]))
    check("GET /api/scheduled-shipments -> solo programaciones del cliente", s == 200 and solo_cliente, f"status={s}")

    for ruta in (f"/api/wms/pick-tickets?{q}", f"/api/wms/allocations?{q}", f"/api/wms/shipments?{q}"):
        s, cuerpo = pide("GET", ruta, llave=LLAVE)
        check(f"GET {ruta.split('?')[0]} con customer -> 200", s == 200 and isinstance(cuerpo, list), f"status={s}")
    s, _ = pide("GET", f"/api/wms/pick-tickets", llave=LLAVE)
    check("GET /api/wms/pick-tickets sin customer -> 403", s == 403, f"status={s}")
    s, cuerpo = pide("GET", f"/api/wms/inventory/history?style=ESTILO-INEXISTENTE-E2E&{q}", llave=LLAVE)
    check("GET /api/wms/inventory/history de estilo inexistente -> 200 vacío (sin revelar)", s == 200, f"status={s}")

    # Escrituras: SOLO caminos de rechazo — nada persiste.
    s, _ = pide("POST", "/api/shipping", llave=LLAVE, form={"order_numbers": "1"})
    check("POST /api/shipping sin customer -> 403 (nada persiste)", s == 403, f"status={s}")
    s, _ = pide("POST", f"/api/shipping?{q}", llave=LLAVE, form={"order_numbers": "ORDEN-INEXISTENTE-E2E"})
    check("POST /api/shipping con orden inexistente -> 400 strict forzado (nada persiste)", s == 400, f"status={s}")
    s, _ = pide("POST", f"/api/shipping?{q}", llave=LLAVE,
                form={"order_numbers": orden_muestra or "1", "delay_code": "codigo-inventado-e2e"})
    check("POST /api/shipping con delay_code fuera de catálogo -> 400 (nada persiste)", s == 400, f"status={s}")
    s, _ = pide("PUT", f"/api/shipping/registro-inexistente-e2e?{q}", llave=LLAVE, body={"delay_code": None})
    check("PUT /api/shipping/{inexistente} -> 404 (nada persiste)", s == 404, f"status={s}")
    s, _ = pide("POST", f"/api/scheduled-shipments?{q}", llave=LLAVE,
                body={"order_number": "ORDEN-INEXISTENTE-E2E", "scheduled_month": 1, "scheduled_week": 1})
    check("POST /api/scheduled-shipments con orden inexistente -> 404 (nada persiste)", s == 404, f"status={s}")


def main():
    print(f"E2E Command API contra {BASE}\n")
    bateria_a()
    if LLAVE and CLIENTE:
        print()
        bateria_b()
    else:
        print("\n(Batería B omitida: exporta MOS_API_KEY y MOS_API_CUSTOMER para correrla.)")
    fallos = [r for r in resultados if not r[0]]
    print(f"\nResultado: {len(resultados) - len(fallos)}/{len(resultados)} OK")
    if fallos:
        print("Fallos:")
        for _, nombre, detalle in fallos:
            print(f"  - {nombre}  {detalle}")
        sys.exit(1)


if __name__ == "__main__":
    main()
