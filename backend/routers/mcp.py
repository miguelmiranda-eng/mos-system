"""Conector MCP: deja que Claude, ChatGPT y Grok consulten MOS.

QUÉ ES
Un servidor MCP remoto (Model Context Protocol). Las tres plataformas hablan
el mismo protocolo, así que esto NO son tres integraciones: es una sola URL que
se da de alta como conector en cada una.

SOLO LECTURA, POR DISEÑO
No hay una sola escritura en este archivo, y no es casualidad. El texto que
llega a un modelo puede venir de un comentario de una orden o del nombre de un
cliente; si una herramienta pudiera escribir, bastaría un texto malicioso ahí
para que el modelo moviera o borrara órdenes. Aquí la única forma de agregar
escritura es agregar código nuevo, no cambiar un permiso.

SIN SDK
El SDK de MCP exige versiones de FastAPI/starlette más nuevas que las de este
backend (0.110 / 0.37), y meterlo arriesga romper todo lo demás por un
conflicto de dependencias. Para un servidor de solo lectura el protocolo cabe
en un archivo: POST único, JSON-RPC, tres métodos.

VERSIONES DEL PROTOCOLO
La revisión 2026-07-28 quitó el handshake de `initialize` y las sesiones: cada
POST lleva su propia metadata. Pero hay clientes que todavía hablan las
revisiones con `initialize`, así que se soportan las dos: un cliente moderno
entra directo, uno viejo hace su handshake y sigue igual. Sin esto, el
conector "no conecta" en la mitad de las plataformas y no se sabe por qué.
"""
import base64
import hashlib
import os
import re
from datetime import datetime, timezone

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse, Response

from deps import db, logger

router = APIRouter(prefix="/api/mcp")

_BASE = (os.environ.get("MCP_PUBLIC_URL")
         or "https://mosdatabase-backend.k9pirj.easypanel.host").rstrip("/")

# La que implementamos. Las demás se aceptan por compatibilidad hacia atrás.
VERSION_ACTUAL = "2026-07-28"
VERSIONES_LEGADO = {"2025-03-26", "2025-06-18", "2025-11-25"}
VERSIONES = {VERSION_ACTUAL} | VERSIONES_LEGADO

SERVIDOR = {"name": "mos-system", "title": "MOS System", "version": "1.0.0"}

# Techo de renglones por respuesta. No es paginación: es que volcar 1,700
# órdenes en el contexto de un modelo lo empeora y cuesta dinero. Si el
# resultado se corta, la respuesta lo dice para que el modelo afine la búsqueda
# en vez de creer que eso es todo lo que hay.
TOPE = 25


# ── errores JSON-RPC ────────────────────────────────────────────────────────
def _error(id_, code, message, data=None, http=200):
    cuerpo = {"jsonrpc": "2.0", "id": id_, "error": {"code": code, "message": message}}
    if data is not None:
        cuerpo["error"]["data"] = data
    return JSONResponse(cuerpo, status_code=http)


def _ok(id_, result):
    return JSONResponse({"jsonrpc": "2.0", "id": id_, "result": result})


def _decodifica(valor: str) -> str:
    """`=?base64?…?=` → texto. El cliente codifica así lo que no cabe en ASCII.

    Hay que decodificar ANTES de comparar cabecera contra cuerpo; si no, un
    nombre con acentos se ve como discrepancia y se rechaza una petición buena.
    """
    if isinstance(valor, str) and valor.startswith("=?base64?") and valor.endswith("?="):
        try:
            return base64.b64decode(valor[9:-2]).decode("utf-8")
        except Exception:
            return valor
    return valor


# ── autenticación ───────────────────────────────────────────────────────────
async def _token_valido(request: Request):
    """Devuelve el token del conector, o None.

    Se guarda el HASH, nunca el token: si alguien lee la base no obtiene una
    llave usable. Y va por cabecera `Authorization`, NO por la URL — un token
    en la ruta o en la query termina escrito en los logs del proxy y en el
    historial del navegador, que es exactamente como se filtró la llave de
    administrador de este sistema.
    """
    cabecera = request.headers.get("Authorization") or ""
    if not cabecera.startswith("Bearer "):
        return None
    crudo = cabecera[7:].strip()
    if not crudo:
        return None
    huella = hashlib.sha256(crudo.encode()).hexdigest()
    doc = await db.connector_tokens.find_one(
        {"token_hash": huella, "revoked": {"$ne": True}}, {"_id": 0}
    )
    if doc:
        return doc
    # Token emitido por el flujo OAuth. Es el camino normal desde Claude: los
    # tokens fijos de `connector_tokens` quedan para pruebas y scripts, porque
    # la interfaz de Claude no ofrece pegarlos.
    from routers.mcp_oauth import usuario_de_token
    persona = await usuario_de_token(crudo)
    if persona:
        return {"name": persona["email"], "token_hash": None, "oauth": True}
    return None


# ── herramientas ────────────────────────────────────────────────────────────
def _fmt_orden(o: dict) -> dict:
    """Una orden, en los campos que sirven para responder preguntas.

    Se devuelve el monto facturado (`invoice`) porque así se autorizó. Es el
    único dato financiero que sale del sistema; si eso cambia, se quita AQUÍ y
    desaparece de todas las herramientas de golpe.
    """
    return {
        "orden": o.get("order_number"),
        "cliente": o.get("client"),
        "customer_po": o.get("customer_po"),
        "design": o.get("design_#") or o.get("desing_#"),
        "estilo": o.get("style"),
        "color": o.get("color"),
        "tablero": o.get("board"),
        "estatus_produccion": o.get("production_status"),
        "estatus_desde": o.get("production_status_at"),
        "cancel_date": o.get("cancel_date"),
        "fecha_entrega": o.get("due_date"),
        "final_bill": o.get("final_bill"),
        "piezas": o.get("quantity") or o.get("total_quantity"),
        "monto_facturado": o.get("invoice") if isinstance(o.get("invoice"), (int, float)) else None,
    }


PROY_ORDEN = {
    "_id": 0, "order_number": 1, "client": 1, "customer_po": 1, "design_#": 1,
    "desing_#": 1, "style": 1, "color": 1, "board": 1, "production_status": 1,
    "production_status_at": 1, "cancel_date": 1, "due_date": 1, "final_bill": 1,
    "quantity": 1, "total_quantity": 1, "invoice": 1, "order_id": 1,
}

# La papelera se excluye SIEMPRE. Una orden borrada que aparece en una
# respuesta hace que alguien la busque en el tablero y no la encuentre.
VIVAS = {"board": {"$ne": "PAPELERA DE RECICLAJE"}}


async def _buscar_orden(args):
    texto = str(args.get("busqueda") or "").strip()
    if not texto:
        return {"error": "Falta `busqueda` (número de orden, PO, cliente o design)."}
    # Un codigo de caja/LPN/recibo del WMS no es una orden: se contesta con el
    # historial de la caja (quien la recibio, donde esta, sus movimientos).
    if re.match(r"^(BOX-|LPN|RCV_)", texto, re.IGNORECASE):
        return await _historial_caja({"caja": texto})
    rx = {"$regex": re.escape(texto), "$options": "i"}
    q = {**VIVAS, "$or": [
        {"order_number": rx}, {"customer_po": rx}, {"client": rx},
        {"design_#": rx}, {"store_po": rx}, {"style": rx},
    ]}
    total = await db.orders.count_documents(q)
    docs = await db.orders.find(q, PROY_ORDEN).limit(TOPE).to_list(TOPE)
    return {"encontradas": total, "mostradas": len(docs),
            "truncado": total > len(docs),
            "ordenes": [_fmt_orden(d) for d in docs]}


async def _estado_orden(args):
    num = str(args.get("orden") or "").strip()
    if not num:
        return {"error": "Falta `orden` (el número)."}
    o = await db.orders.find_one({**VIVAS, "order_number": num}, PROY_ORDEN)
    if not o:
        return {"error": f"No existe una orden viva con el número {num}."}
    d = _fmt_orden(o)
    # Sin estatus, ninguna automatización la puede mover: es la causa real de
    # que una orden se quede parada en un tablero. Vale la pena decirlo.
    if not d["estatus_produccion"]:
        d["aviso"] = ("Esta orden no tiene estatus de producción. Las automatizaciones "
                      "se disparan por cambio de estatus, así que no se moverá sola.")
    return d


async def _historial_orden(args):
    num = str(args.get("orden") or "").strip()
    o = await db.orders.find_one({"order_number": num}, {"_id": 0, "order_id": 1})
    if not o:
        return {"error": f"No existe la orden {num}."}
    oid = o["order_id"]
    q = {"$or": [{"details.order_id": oid}, {"details.order_number": num},
                 {"previous_data.order_ids": oid}]}
    logs = await db.activity_logs.find(q, {"_id": 0}).sort("timestamp", -1).limit(TOPE).to_list(TOPE)
    eventos = []
    for l in logs:
        det = l.get("details") or {}
        ev = {"cuando": l.get("timestamp"), "quien": l.get("user_name") or l.get("user_email"),
              "accion": l.get("action")}
        if l.get("action") == "bulk_move_orders":
            desde = ((l.get("previous_data") or {}).get("original_boards") or {}).get(oid)
            ev["detalle"] = f"cambio de tablero: {desde} → {det.get('target_board')}"
        elif det.get("changed_fields"):
            ev["detalle"] = "cambió " + ", ".join(det["changed_fields"])
        eventos.append(ev)
    return {"orden": num, "eventos": eventos}


async def _inventario(args):
    q = dict(VIVAS_INV := {"units_on_hand": {"$gt": 0}})
    for arg, campo in (("estilo", "style"), ("color", "color"), ("talla", "size"),
                       ("cliente", "customer")):
        val = str(args.get(arg) or "").strip()
        if val:
            q[campo] = {"$regex": f"^{re.escape(val)}$", "$options": "i"}
    if len(q) == 1:
        return {"error": "Da al menos un filtro: estilo, color, talla o cliente."}
    docs = await db.wms_inventory.find(
        q, {"_id": 0, "style": 1, "color": 1, "size": 1, "units_on_hand": 1,
            "units_allocated": 1, "location": 1, "customer": 1, "country_of_origin": 1},
    ).limit(TOPE).to_list(TOPE)
    total = sum(d.get("units_on_hand") or 0 for d in docs)
    return {"renglones": len(docs), "piezas_disponibles": total,
            "detalle": [{"estilo": d.get("style"), "color": d.get("color"),
                         "talla": d.get("size"), "piezas": d.get("units_on_hand"),
                         "apartadas": d.get("units_allocated"),
                         "ubicacion": d.get("location"), "cliente": d.get("customer"),
                         "pais": d.get("country_of_origin")} for d in docs]}


async def _ordenes_por_cliente(args):
    cliente = str(args.get("cliente") or "").strip()
    if not cliente:
        return {"error": "Falta `cliente`."}
    q = {**VIVAS, "client": {"$regex": re.escape(cliente), "$options": "i"}}
    estatus = str(args.get("estatus") or "").strip()
    if estatus:
        q["production_status"] = {"$regex": f"^{re.escape(estatus)}$", "$options": "i"}
    total = await db.orders.count_documents(q)
    docs = await db.orders.find(q, PROY_ORDEN).sort("cancel_date", 1).limit(TOPE).to_list(TOPE)
    piezas = sum((d.get("quantity") or 0) for d in docs)
    return {"encontradas": total, "mostradas": len(docs), "truncado": total > len(docs),
            "piezas_mostradas": piezas, "ordenes": [_fmt_orden(d) for d in docs]}


async def _final_bill(args):
    """Lo que espera facturación. Misma definición que el módulo de Final Bill."""
    estados = ["LISTO PARA ENVIO", "LISTO PARA INVENTARIO"]
    q = {"production_status": {"$in": estados}, "final_bill_review.reviewed": {"$ne": True}}
    total = await db.orders.count_documents(q)
    monto = {"a": 0, "n": 0}
    async for r in db.orders.aggregate([{"$match": q}, {"$group": {
            "_id": None,
            "a": {"$sum": {"$cond": [{"$isNumber": "$invoice"}, "$invoice", 0]}},
            "n": {"$sum": {"$cond": [{"$isNumber": "$invoice"}, 1, 0]}}}}]):
        monto = r
    docs = await db.orders.find(q, PROY_ORDEN).sort("cancel_date", 1).limit(TOPE).to_list(TOPE)
    return {"pendientes": total, "mostradas": len(docs), "truncado": total > len(docs),
            "monto_facturado_total": round(monto.get("a") or 0, 2) if monto.get("n") else None,
            "ordenes_con_factura": monto.get("n") or 0,
            "ordenes": [_fmt_orden(d) for d in docs]}


async def _pick_tickets(args):
    q = {"picking_status": {"$in": ["unassigned", "assigned", "in_progress"]}}
    total = await db.wms_pick_tickets.count_documents(q)
    docs = await db.wms_pick_tickets.find(
        q, {"_id": 0, "order_number": 1, "style": 1, "color": 1, "quantity": 1,
            "picking_status": 1, "assigned_to_name": 1, "client": 1},
    ).limit(TOPE).to_list(TOPE)
    return {"pendientes": total, "mostrados": len(docs), "truncado": total > len(docs),
            "tickets": [{"orden": d.get("order_number"), "cliente": d.get("client"),
                         "estilo": d.get("style"), "color": d.get("color"),
                         "piezas": d.get("quantity"), "estado": d.get("picking_status"),
                         "asignado_a": d.get("assigned_to_name")} for d in docs]}


async def _historial_caja(args):
    """Ciclo de vida de una caja del WMS: quien la recibio, estado, movimientos."""
    cid = str(args.get("caja") or "").strip()
    if not cid:
        return {"error": "Falta `caja` (el código, ej. BOX-037086)."}

    box = await db.wms_boxes.find_one(
        {"$or": [{"box_id": cid}, {"barcode": cid}, {"lpn_id": cid}, {"physical_lpn": cid}]},
        {"_id": 0})
    receiving = None
    if box and box.get("receiving_id"):
        receiving = await db.wms_receiving.find_one({"receiving_id": box["receiving_id"]}, {"_id": 0})
    if not box:
        # Caja ausente de wms_boxes (huerfana / embarcada): buscarla en recibos.
        receiving = await db.wms_receiving.find_one({"boxes.box_id": cid}, {"_id": 0})

    movimientos = await db.wms_movements.find({"$or": [
        {"details.box_id": cid}, {"details.box_ids": cid}, {"details.boxes.box_id": cid},
    ]}, {"_id": 0}).sort("created_at", 1).to_list(100)

    if not box and not receiving and not movimientos:
        return {"error": f"Sin rastro de la caja {cid} en cajas, recibos ni movimientos."}

    out = {"caja": cid}
    if receiving:
        out["recibida_por"] = receiving.get("received_by_name") or receiving.get("received_by")
        out["recibida_cuando"] = receiving.get("created_at")
        out["recibo"] = receiving.get("receiving_id")
        out["cliente"] = receiving.get("customer")
        if receiving.get("asn_reference"):
            out["asn"] = receiving["asn_reference"]
    if box:
        out.setdefault("recibida_por", box.get("received_by_name"))
        out["estado"] = box.get("status")
        out["ubicacion"] = box.get("location")
        out["piezas"] = box.get("units")
        out["sku"] = " / ".join(str(box.get(k) or "") for k in ("style", "color", "size")).strip(" /")
        if box.get("last_pick_ticket"):
            out["ultimo_pick_ticket"] = box["last_pick_ticket"]
    out["movimientos"] = [{
        "cuando": m.get("created_at"),
        "quien": m.get("user_name"),
        "tipo": m.get("type"),
    } for m in movimientos[-25:]]
    return out


async def _resumen_tableros(args):
    salida = {}
    async for r in db.orders.aggregate([
        {"$match": VIVAS},
        {"$group": {"_id": "$board", "n": {"$sum": 1}, "piezas": {"$sum": {"$ifNull": ["$quantity", 0]}}}},
        {"$sort": {"n": -1}},
    ]):
        salida[r["_id"] or "(sin tablero)"] = {"ordenes": r["n"], "piezas": r["piezas"]}
    return {"tableros": salida}


# name → (función, descripción, esquema de entrada)
HERRAMIENTAS = {
    "buscar_orden": (
        _buscar_orden,
        "Busca órdenes por número, Customer PO, cliente, design o estilo. Devuelve "
        "en qué tablero están, su estatus de producción, fechas, piezas y monto facturado.",
        {"type": "object",
         "properties": {"busqueda": {"type": "string", "description": "Número de orden, PO, cliente, design o estilo"}},
         "required": ["busqueda"]},
    ),
    "estado_orden": (
        _estado_orden,
        "Ficha completa de UNA orden por su número: tablero, estatus de producción y "
        "desde cuándo lo tiene, fechas, piezas y monto facturado.",
        {"type": "object",
         "properties": {"orden": {"type": "string", "description": "Número de orden, ej. 2653"}},
         "required": ["orden"]},
    ),
    "historial_orden": (
        _historial_orden,
        "Quién tocó una orden y cuándo: cambios de tablero (incluidos los movimientos "
        "en lote), ediciones de campos, comentarios.",
        {"type": "object",
         "properties": {"orden": {"type": "string", "description": "Número de orden"}},
         "required": ["orden"]},
    ),
    "inventario": (
        _inventario,
        "Existencias del almacén (WMS) con ubicación. Filtra por estilo, color, talla "
        "o cliente. Solo muestra lo que tiene piezas disponibles.",
        {"type": "object",
         "properties": {"estilo": {"type": "string"}, "color": {"type": "string"},
                        "talla": {"type": "string"}, "cliente": {"type": "string"}}},
    ),
    "ordenes_por_cliente": (
        _ordenes_por_cliente,
        "Órdenes vivas de un cliente, de la más urgente a la menos. Se puede acotar "
        "por estatus de producción.",
        {"type": "object",
         "properties": {"cliente": {"type": "string"},
                        "estatus": {"type": "string", "description": "Ej. LISTO PARA ENVIO"}},
         "required": ["cliente"]},
    ),
    "final_bill_pendientes": (
        _final_bill,
        "Órdenes terminadas que esperan revisión de Final Bill, con el total facturado.",
        {"type": "object", "properties": {}},
    ),
    "pick_tickets_pendientes": (
        _pick_tickets,
        "Pick tickets del almacén sin completar, con quién los tiene asignados.",
        {"type": "object", "properties": {}},
    ),
    "resumen_tableros": (
        _resumen_tableros,
        "Cuántas órdenes y piezas hay en cada tablero. Sirve para una foto general.",
        {"type": "object", "properties": {}},
    ),
    "historial_caja": (
        _historial_caja,
        "Ciclo de vida de una caja del almacén (WMS) por su código (BOX-…, LPN o "
        "recibo): quién la recibió y cuándo, estado y ubicación actuales, piezas, "
        "y sus movimientos con quién los hizo.",
        {"type": "object",
         "properties": {"caja": {"type": "string", "description": "Código de la caja, ej. BOX-037086"}},
         "required": ["caja"]},
    ),
}


def _catalogo():
    return [{"name": n, "description": d, "inputSchema": e}
            for n, (_f, d, e) in HERRAMIENTAS.items()]


# ── el endpoint ─────────────────────────────────────────────────────────────
@router.api_route("", methods=["GET", "DELETE", "PUT", "PATCH"])
async def _no_permitido():
    """La revisión 2026-07-28 quitó el stream por GET y el DELETE de sesión.

    El spec pide responder 405 a ese tráfico viejo en vez de 404, para que el
    cliente sepa que el endpoint existe y solo cambió de forma.
    """
    return Response(status_code=405, headers={"Allow": "POST"})


@router.post("")
async def mcp(request: Request):
    # Origin: defensa contra DNS rebinding. Un navegador que no debería estar
    # hablando con esto manda Origin; un cliente MCP legítimo no.
    origen = request.headers.get("Origin")
    if origen and not origen.startswith("https://"):
        return _error(None, -32600, "Origin no permitido", http=403)

    try:
        cuerpo = await request.json()
    except Exception:
        return _error(None, -32700, "JSON inválido", http=400)
    if not isinstance(cuerpo, dict):
        return _error(None, -32600, "Se espera un único mensaje JSON-RPC", http=400)

    id_ = cuerpo.get("id")
    metodo = cuerpo.get("method")
    params = cuerpo.get("params") or {}
    meta = params.get("_meta") or {}
    es_notificacion = id_ is None

    # Versión del protocolo. La cabecera manda, pero el cuerpo es la verdad:
    # si no coinciden se rechaza, porque un proxy podría enrutar por una y el
    # servidor ejecutar por la otra.
    ver_cabecera = request.headers.get("MCP-Protocol-Version")
    ver_cuerpo = meta.get("io.modelcontextprotocol/protocolVersion")
    version = ver_cabecera or ver_cuerpo or "2025-03-26"
    if ver_cabecera and ver_cuerpo and ver_cabecera != ver_cuerpo:
        return _error(id_, -32020,
                      f"La cabecera MCP-Protocol-Version ({ver_cabecera}) no coincide "
                      f"con el cuerpo ({ver_cuerpo})", http=400)
    if version not in VERSIONES:
        return _error(id_, -32600, f"Versión de protocolo no soportada: {version}",
                      data={"supported": sorted(VERSIONES)}, http=400)

    # Cabeceras espejo. Solo se exigen a los clientes modernos: las revisiones
    # viejas no las mandan y rechazarlas los dejaría fuera sin motivo.
    if version == VERSION_ACTUAL and not es_notificacion:
        m_metodo = request.headers.get("Mcp-Method")
        if m_metodo and m_metodo != metodo:
            return _error(id_, -32020,
                          f"Mcp-Method ({m_metodo}) no coincide con el cuerpo ({metodo})", http=400)
        if metodo == "tools/call":
            m_nombre = _decodifica(request.headers.get("Mcp-Name") or "")
            if m_nombre and m_nombre != params.get("name"):
                return _error(id_, -32020,
                              f"Mcp-Name ({m_nombre}) no coincide con el cuerpo "
                              f"({params.get('name')})", http=400)

    # Autenticación. Va después de validar el protocolo para que un cliente mal
    # configurado reciba el error real y no un 401 que despista.
    token = await _token_valido(request)
    if not token:
        return JSONResponse(
            {"jsonrpc": "2.0", "id": id_,
             "error": {"code": -32001, "message": "Token de conector inválido o revocado"}},
            status_code=401,
            # `resource_metadata` no es decorativo: es como Claude descubre el
            # servidor de autorizacion. Sin este puntero sondea /.well-known en
            # el origen, y si tampoco lo halla falla con "Couldn't register with
            # ... sign-in service" — el error exacto que salia antes.
            headers={"WWW-Authenticate":
                     f'Bearer resource_metadata="{_BASE}/.well-known/oauth-protected-resource"'},
        )

    # ── métodos ──
    if metodo == "initialize":
        # Handshake de las revisiones viejas. Se contesta con la versión que
        # pidió el cliente si la soportamos, para no forzarlo a negociar.
        pedida = params.get("protocolVersion")
        return _ok(id_, {
            "protocolVersion": pedida if pedida in VERSIONES else VERSION_ACTUAL,
            "capabilities": {"tools": {}},
            "serverInfo": SERVIDOR,
        })

    if metodo in ("notifications/initialized", "initialized"):
        return Response(status_code=202)

    if metodo == "ping":
        return _ok(id_, {})

    if metodo == "tools/list":
        return _ok(id_, {"tools": _catalogo()})

    if metodo == "tools/call":
        nombre = params.get("name")
        entrada = HERRAMIENTAS.get(nombre)
        if not entrada:
            return _error(id_, -32602, f"Herramienta desconocida: {nombre}")
        funcion = entrada[0]
        args = params.get("arguments") or {}
        try:
            datos = await funcion(args)
        except Exception as e:
            logger.exception("[mcp] falló la herramienta %s", nombre)
            # isError, no una excepción HTTP: el modelo puede leer el motivo y
            # corregir la llamada en vez de quedarse sin respuesta.
            return _ok(id_, {"isError": True, "content": [
                {"type": "text", "text": f"Error ejecutando {nombre}: {e}"}]})

        await _registrar(token, nombre, args)
        import json as _json
        return _ok(id_, {
            "content": [{"type": "text", "text": _json.dumps(datos, ensure_ascii=False, default=str)}],
            "structuredContent": datos,
            "isError": bool(isinstance(datos, dict) and datos.get("error")),
        })

    if es_notificacion:
        return Response(status_code=202)
    # 404 con -32601: así el cliente distingue "método que no implemento" de un
    # 404 de un servidor que ni siquiera tiene endpoint MCP.
    return _error(id_, -32601, f"Método no soportado: {metodo}", http=404)


async def _registrar(token: dict, herramienta: str, args: dict) -> None:
    """Deja rastro de cada consulta del conector.

    Sin esto no hay forma de saber qué preguntó el chatbot ni con qué token, y
    la única respuesta a "¿quién sacó estos datos?" sería un encogimiento de
    hombros. Es best-effort: si falla el registro, la consulta ya se respondió
    y no tiene caso tumbarla.
    """
    try:
        ahora = datetime.now(timezone.utc).isoformat()
        await db.connector_calls.insert_one({
            "token_name": token.get("name"),
            "tool": herramienta,
            "arguments": args,
            "at": ahora,
        })
        if token.get("token_hash"):
            await db.connector_tokens.update_one(
                {"token_hash": token["token_hash"]},
                {"$set": {"last_used_at": ahora}, "$inc": {"calls": 1}},
            )
    except Exception:
        logger.warning("[mcp] no se pudo registrar la llamada a %s", herramienta)
