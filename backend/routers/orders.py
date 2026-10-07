"""Orders routes: CRUD, comments, images, bulk-move, export."""
from fastapi import APIRouter, HTTPException, Request, File, UploadFile, Form, Response
from typing import Optional
import json
from deps import db, require_auth, require_admin, log_activity, OrderCreate, OrderUpdate, CommentCreate, BOARDS, DESIGN_POSITIONS, get_dynamic_boards, logger, json_response_bytes, require_api_customer
from services.qty_embarcada import qty_embarcada_por_orden, entero_o_none
from ws_manager import ws_manager
from datetime import datetime, timezone
import uuid, base64, os, io, re
import pandas as pd
from reportlab.lib.pagesizes import letter
from reportlab.lib import colors
from reportlab.platypus import SimpleDocTemplate, Table, TableStyle, Paragraph, Spacer, Image, PageBreak
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.units import inch
import time
import asyncio
from pathlib import Path

router = APIRouter(prefix="/api/orders")

UPLOADS_DIR = Path("uploads") / "invoices"
try:
    UPLOADS_DIR.mkdir(parents=True, exist_ok=True)
except OSError:
    pass

# Tableros TERMINALES: órdenes cerradas que solo se acumulan. Quedan FUERA de
# MASTER (la vista de "todo lo vivo") — cada uno se consulta en su tablero.
MASTER_EXCLUDED_BOARDS = {"FINAL BILL", "COMPLETOS", "EDI", "CANCELLED"}

# ==================== CACHE SYSTEM FOR ORDERS ====================
# Guarda la RESPUESTA ya serializada (bytes JSON), no los documentos: con el
# caché de objetos, cada hit seguía pagando jsonable_encoder + json.dumps
# sobre cientos de documentos. La respuesta no depende del usuario
# (require_auth es solo compuerta), así que los mismos bytes sirven para
# todos los clientes.
#
# Llaves: tuplas ("orders", board, limit, include_images) y ("board_counts",).
# Tienen que ser tuplas: los tableros son nombres libres con espacios
# ("READY TO SCHEDULED"), así que un string interpolado no se puede parsear
# de vuelta con confianza para invalidar por tablero.
_orders_cache = {}
_orders_cache_locks = {}
# TTL de seguridad: la invalidación explícita de abajo solo escucha
# order_change; si algún flujo mutara órdenes emitiendo otro evento (o
# ninguno), el caché se auto-sana en 60s en vez de quedar rancio para siempre.
_ORDERS_CACHE_TTL = 60

def get_orders_cached(key):
    entry = _orders_cache.get(key)
    if not entry:
        return None
    if time.time() - entry["ts"] > _ORDERS_CACHE_TTL:
        del _orders_cache[key]
        return None
    return entry["data"]

def _cache_and_respond(key, payload) -> Response:
    body = json_response_bytes(payload)
    _orders_cache[key] = {"data": body, "ts": time.time()}
    return Response(content=body, media_type="application/json")

def _invalidate_orders_cache(data):
    # order_change con `boards` confiables borra solo: esos tableros, MASTER
    # (agrega casi todos los tableros, cualquier cambio puede alterarlo), las
    # llaves sin tablero (listado completo) y board_counts. Con boards ausente
    # o dudoso (None adentro, lista vacía, tipos raros) se vacía TODO — el
    # comportamiento histórico, siempre correcto. El premio son los tableros
    # TERMINALES (FINAL BILL es ~70% de las filas y solo crece): dejan de
    # recomputarse por cambios que no los tocan.
    boards = None
    if isinstance(data, dict):
        raw = data.get("boards")
        if isinstance(raw, (list, tuple)) and raw and all(
                isinstance(b, str) and b.strip() for b in raw):
            boards = set(raw)
    # Corpus de búsqueda: si el cambio es de UNA orden identificada (acción en
    # la lista blanca + order_id), solo esa se re-lee en la próxima búsqueda;
    # cualquier otro cambio (crear, lote, import, gemelas…) lo tira completo.
    _search_corpus_mark(data)
    if boards is None:
        _orders_cache.clear()
        return
    for key in list(_orders_cache):
        if key[0] != "orders" or key[1] in (None, "MASTER") or key[1] in boards:
            del _orders_cache[key]


# ==================== CORPUS DE BÚSQUEDA ====================
# La búsqueda global compara el texto contra CUALQUIER campo de la orden
# (incluidas columnas custom con nombres raros), en Python. Hacerlo por request
# costaba ~0.44 s de CPU (traer ~3k órdenes + aplanar cada campo) y, como el
# backend es un solo event loop, congelaba a TODOS los usuarios mientras tanto;
# el autocompletado de Arte lo disparaba por tecla. Medido 2026-10-01.
#
# Ahora cada orden se aplana UNA vez por cambio de órdenes y se guarda aquí;
# una búsqueda es solo un `in` sobre ~3k cadenas (milisegundos). Misma
# semántica que antes: coincidencia por campo, exactas primero, y dentro de
# cada grupo el orden por created_at desc.
#
# Mantenimiento (2026-10-02): tirar el corpus en CADA order_change lo dejaba
# frío casi siempre en hora pico (un cambio cada ~20 s) y la búsqueda con Enter
# pagaba la reconstrucción completa (~2.4 s medido). Ahora:
#   - cambio de UNA orden (acciones de _SEARCH_PATCH_ACTIONS con order_id):
#     se marca "sucia" y la próxima búsqueda re-lee solo esa(s) orden(es);
#   - cualquier otro order_change: reconstrucción completa ANTES de responder
#     (nunca se sirve un corpus viejo tras crear/mover en lote/importar);
#   - TTL de seguridad vencido (mutaciones que no avisan): se sigue sirviendo
#     y se reconstruye en segundo plano.
_SEARCH_SKIP_KEY = re.compile(r"(_id$|_at$|^id$|created|updated|timestamp|^images$|^attachments$|^files$)", re.I)
_SEARCH_SEP = "\x00"   # separa campos: una coincidencia nunca cruza de un campo a otro
# Acciones que modifican SOLO la orden de su order_id (verificado en cada
# broadcast). Las que tocan varias (gemelas, lote) o crean órdenes NO van aquí.
_SEARCH_PATCH_ACTIONS = {
    "update", "move", "delete", "add_comment", "update_comment", "delete_comment",
    "pin_comment", "comment_reaction", "add_link", "delete_link", "art_status",
}
# entries: lista de (orden, texto, exactas) o None en huecos borrados.
# pos: order_id -> índice en entries.  dirty: order_ids por re-leer.
_search_corpus = {"entries": None, "pos": {}, "ts": 0.0, "dirty": set(),
                  "refreshing": False, "gen": 0}
_search_corpus_lock = asyncio.Lock()


def _search_corpus_mark(data):
    oid = data.get("order_id") if isinstance(data, dict) else None
    action = data.get("action") if isinstance(data, dict) else None
    if (_search_corpus["entries"] is not None and isinstance(oid, str) and oid
            and action in _SEARCH_PATCH_ACTIONS):
        _search_corpus["dirty"].add(oid)
    else:
        # gen: una reconstrucción que ya estaba leyendo ANTES de este cambio no
        # debe guardar su resultado (podría no incluirlo).
        _search_corpus["gen"] += 1
        _search_corpus["entries"] = None
        _search_corpus["dirty"] = set()


def _search_flat(v):
    if v is None:
        return ""
    if isinstance(v, dict):
        return " ".join(_search_flat(x) for x in v.values())
    if isinstance(v, list):
        return " ".join(_search_flat(x) for x in v)
    return str(v).lower()


def _search_entry(order):
    parts, exact = [], set()
    for k, v in order.items():
        if _SEARCH_SKIP_KEY.search(k):
            continue
        parts.append(_search_flat(v))
        if isinstance(v, (str, int, float)):
            exact.add(str(v).strip().lower())
    return order, _SEARCH_SEP.join(parts), exact


async def _build_search_corpus(projection):
    # Lo que se marque sucio DURANTE la lectura completa ya viene incluido en
    # ella o se vuelve a marcar después: se limpia ANTES de leer, no después.
    _search_corpus["dirty"] = set()
    gen = _search_corpus["gen"]
    raw = await db.orders.find({}, projection).sort("created_at", -1).to_list(None)
    # El aplanado es CPU puro: en un hilo para no detener el event loop.
    entries = await asyncio.to_thread(lambda: [_search_entry(o) for o in raw])
    if gen != _search_corpus["gen"]:
        return entries        # hubo un cambio completo mientras leíamos: no guardar
    _search_corpus["entries"] = entries
    _search_corpus["pos"] = {e[0].get("order_id"): i for i, e in enumerate(entries)
                             if e[0].get("order_id")}
    _search_corpus["ts"] = time.time()
    return entries


async def _patch_search_corpus(projection):
    """Re-lee solo las órdenes sucias. Devuelve False si hace falta reconstruir
    (una orden nueva que no estaba en el corpus: su lugar en el orden por
    created_at no se puede deducir sin comparar tipos mixtos)."""
    ids = list(_search_corpus["dirty"])
    _search_corpus["dirty"] = set()
    if not ids:
        return True
    docs = {d.get("order_id"): d async for d in
            db.orders.find({"order_id": {"$in": ids}}, projection)}
    entries, pos = _search_corpus["entries"], _search_corpus["pos"]
    for oid in ids:
        i = pos.get(oid)
        doc = docs.get(oid)
        if i is None:
            if doc is not None:
                return False      # orden que el corpus no conocía
            continue              # ya no existe y nunca estuvo: nada que hacer
        if doc is None:
            entries[i] = None     # borrada definitivamente: hueco
            pos.pop(oid, None)
        else:
            entries[i] = _search_entry(doc)
    return True


async def _refresh_search_corpus_bg(projection):
    try:
        async with _search_corpus_lock:
            await _build_search_corpus(projection)
    except Exception as e:
        logger.warning(f"[search] reconstrucción en segundo plano falló: {e}")
    finally:
        _search_corpus["refreshing"] = False


async def _get_search_corpus(projection):
    if _search_corpus["entries"] is not None and not _search_corpus["dirty"]:
        entries = _search_corpus["entries"]
    else:
        async with _search_corpus_lock:
            if _search_corpus["entries"] is None:
                entries = await _build_search_corpus(projection)
            elif not await _patch_search_corpus(projection):
                entries = await _build_search_corpus(projection)
            else:
                entries = _search_corpus["entries"]
    # TTL de seguridad: servir lo que hay y rehacer en segundo plano.
    if (time.time() - _search_corpus["ts"] > _ORDERS_CACHE_TTL
            and not _search_corpus["refreshing"]):
        _search_corpus["refreshing"] = True
        asyncio.create_task(_refresh_search_corpus_bg(projection))
    return entries

# Intercepta ws_manager.broadcast para invalidar el caché de listados, pero
# SOLO en eventos que cambian órdenes. production_update / neck_update se
# emiten POR CADA captura y no tocan la colección: limpiar en todo broadcast
# dejaba el caché permanentemente frío en horas de captura y cada request de
# MASTER recomputaba ~1,900 docs de a gratis.
original_broadcast = ws_manager.broadcast
async def patched_broadcast(*args, **kwargs):
    event_type = args[0] if args else kwargs.get("event_type")
    if event_type == "order_change":
        data = args[1] if len(args) > 1 else kwargs.get("data")
        _invalidate_orders_cache(data)
    return await original_broadcast(*args, **kwargs)
ws_manager.broadcast = patched_broadcast
# =================================================================


def _merge_custom_fields(order: dict):
    if not order:
        return order
    custom = order.get("custom_fields")
    if isinstance(custom, dict):
        return {**custom, **order}
    return order

# Helper to create notifications for all users except the actor
async def _notify_all(actor, notif_type, message, order_id=None, order_number=None):
    # System disabled general notifications as per user request
    # Only mentions are allowed now (handled in specific routes)
    return

# Lazy import to avoid circular - automations engine is in its own file
async def _run_automations(trigger_type, order, user, context=None):
    from routers.automations import run_automations
    return await run_automations(trigger_type, order, user, context)

async def _fetch_orders(board, search, limit, include_images, filtro_cliente=None,
                        skip=None, hide_trash=False):
    """skip=None → comportamiento clásico: lista de hasta `limit` órdenes.
    skip=int (Tarea 5.1): página skip/limit y devuelve (items, total)."""
    total = None
    query = {}
    if board == "MASTER":
        # Exclude trash AND ghost orders (null/missing board) using an indexable query
        # We use $in with dynamic boards because $nin causes a full collection scan
        active_boards = await get_dynamic_boards()
        # MASTER = solo la operación viva. Los tableros TERMINALES solo
        # acumulan (FINAL BILL ya es ~70% de las filas de MASTER y crece
        # para siempre): incluirlos hacía que cada request pesara ~3.4 MB
        # y que cada cliente montara ~1,900 filas. Cada terminal se
        # consulta en su propio tablero.
        active_boards = [b for b in active_boards
                         if str(b).strip().upper() not in MASTER_EXCLUDED_BOARDS]
        query["board"] = {"$in": active_boards}
    elif board:
        query["board"] = board
    # Aislamiento multi-tenant (Tarea 2.1): las llaves de API solo ven SU cliente.
    if filtro_cliente:
        query.update(filtro_cliente)
    # Exclude 'comments' and 'activity_logs' from dashboard list to keep payload small.
    # These are fetched individually when opening the order details.
    # 'images' (metadatos de adjuntos) era el 79% del payload del tablero
    # (~3.5 MB) y NINGUNA vista lo lee del listado — los modales piden
    # /orders/{id}/images bajo demanda. include_images=true lo restaura
    # para integraciones externas que lo necesiten.
    projection = {"_id": 0, "comments": 0, "activity_logs": 0, "history": 0, "sample_evidence": 0}
    if not include_images:
        projection["images"] = 0
    if search and not include_images and not filtro_cliente:
        # Camino normal de la UI: corpus precalculado (ver _get_search_corpus).
        sq = search.strip().lower()
        if board == "MASTER":
            allowed = set(query["board"]["$in"])
            in_board = lambda o: o.get("board") in allowed
        elif board:
            in_board = lambda o: o.get("board") == board
        else:
            in_board = lambda o: True
        if hide_trash:
            _in = in_board
            in_board = lambda o: o.get("board") != "PAPELERA DE RECICLAJE" and _in(o)
        exact_hits, partial_hits = [], []
        for entry in await _get_search_corpus(projection):
            if entry is None:
                continue
            o, blob, exact = entry
            if sq in blob and in_board(o):
                (exact_hits if sq in exact else partial_hits).append(o)
        ranked = exact_hits + partial_hits
        if skip is None:
            orders_raw = [dict(o) for o in ranked[:limit]]
        else:
            total = len(ranked)
            orders_raw = [dict(o) for o in ranked[skip:skip + limit]]
    elif search:
        # Global, dynamic-column-safe search: match the query against ANY field
        # value in Python — covers custom columns with odd names like
        # 'bpo_(blank_po#)' and 'store_po#' that a fixed $or list keeps missing.
        # Skips id/date/asset keys so digits don't match a timestamp or image
        # hash. Solo para include_images / llaves de API; la UI usa el corpus.
        sq = search.strip().lower()
        _skip_key = re.compile(r"(_id$|_at$|^id$|created|updated|timestamp|^images$|^attachments$|^files$)", re.I)
        def _flat(v):
            if v is None:
                return ""
            if isinstance(v, dict):
                return " ".join(_flat(x) for x in v.values())
            if isinstance(v, list):
                return " ".join(_flat(x) for x in v)
            return str(v).lower()
        raw = await db.orders.find(query, projection).sort("created_at", -1).to_list(5000)
        ranked = []  # (0=exact field match, 1=substring) so exact hits rank first
        for o in raw:
            hit = exact = False
            for k, v in o.items():
                if _skip_key.search(k):
                    continue
                if sq in _flat(v):
                    hit = True
                    if isinstance(v, (str, int, float)) and str(v).strip().lower() == sq:
                        exact = True
                        break
            if hit:
                ranked.append((0 if exact else 1, o))
        ranked.sort(key=lambda r: r[0])  # stable → keeps created_at desc within each tier
        if skip is None:
            orders_raw = [o for _, o in ranked[:limit]]
        else:
            # El total de una búsqueda es lo que sobrevivió al filtro en Python,
            # no un count de Mongo.
            total = len(ranked)
            orders_raw = [o for _, o in ranked[skip:skip + limit]]
    elif skip is None:
        orders_raw = await db.orders.find(query, projection).sort("created_at", -1).to_list(limit)
    else:
        total = await db.orders.count_documents(query)
        orders_raw = await (db.orders.find(query, projection)
                            .sort("created_at", -1).skip(skip).limit(limit).to_list(limit))

    # Safety loop to avoid serialization/merging crashes
    cleaned_orders = []
    for order in orders_raw:
        try:
            merged = _merge_custom_fields(order)
            cleaned_orders.append(merged)
        except Exception as e:
            logger.error(f"Error merging fields for order {order.get('order_id')}: {e}")
            cleaned_orders.append(order)
    return cleaned_orders if skip is None else (cleaned_orders, total)

@router.get("")
async def get_orders(request: Request, board: str = None, search: str = None, limit: int = 1000,
                     include_images: bool = False, skip: int = None, hide_trash: bool = False):
    # deps.get_current_user tambien autentica la llave (header o query legado),
    # asi que el viejo bypass explicito por api_key sobraba. Tarea 2.1: para
    # llaves de API, `customer` es OBLIGATORIO (403 si falta o esta fuera del
    # alcance de la llave) y el filtro se aplica server-side.
    user = await require_auth(request)
    filtro_cliente = require_api_customer(user, request)

    # Tarea 5.1: paginación bajo demanda. Mandar `skip` (aunque sea 0) activa
    # el sobre {total, skip, limit, items}; sin `skip`, TODO el comportamiento
    # histórico (lista plana, caché global, limit libre) queda intacto. El modo
    # sobre no toca la caché global: cada página es consulta directa (misma
    # política que las búsquedas, que tampoco se cachean).
    if skip is not None:
        skip_v = max(0, skip)
        limit_v = max(1, min(limit, 5000))
        # hide_trash: la búsqueda global del tablero no muestra la papelera; si
        # se filtrara en el cliente, el `total` contaría órdenes que no se ven.
        items, total = await _fetch_orders(board, search, limit_v, include_images,
                                           filtro_cliente, skip=skip_v,
                                           hide_trash=hide_trash)
        return {"total": total, "skip": skip_v, "limit": limit_v, "items": items}

    if filtro_cliente:
        # Consumidor externo: SIN cache (la cache global mezclaria clientes).
        return await _fetch_orders(board, search, limit, include_images, filtro_cliente)

    if search:
        # Las búsquedas NO se cachean: cada string tecleado distinto (el
        # autocomplete de arte pega una request POR TECLA) crearía una entrada
        # con el listado serializado y un Lock que jamás se limpia, con
        # hit-rate ~cero. Sin caché cuesta lo mismo que un miss.
        return await _fetch_orders(board, search, limit, include_images)

    # Cache stampede protection
    cache_key = ("orders", board, limit, include_images)
    cached = get_orders_cached(cache_key)
    if cached is not None:
        return Response(content=cached, media_type="application/json")

    if cache_key not in _orders_cache_locks:
        _orders_cache_locks[cache_key] = asyncio.Lock()

    async with _orders_cache_locks[cache_key]:
        cached = get_orders_cached(cache_key)
        if cached is not None:
            return Response(content=cached, media_type="application/json")
        cleaned_orders = await _fetch_orders(board, search, limit, include_images)
        return _cache_and_respond(cache_key, cleaned_orders)

@router.get("/board-counts")
async def get_board_counts(request: Request):
    user = await require_auth(request)
    filtro_cliente = require_api_customer(user, request)
    if filtro_cliente:
        # Consumidor externo: conteos SOLO de su cliente, sin cache global.
        pipeline = [{"$match": filtro_cliente},
                    {"$group": {"_id": "$board", "count": {"$sum": 1}}}]
        results = await db.orders.aggregate(pipeline).to_list(1000)
        return {r["_id"]: r["count"] for r in results if r["_id"]}

    # Mismo patrón que get_orders: caché invalidado en cada broadcast + lock
    # contra estampida.
    #
    # Este $group no lleva $match, así que recorre la colección `orders`
    # COMPLETA. El Dashboard lo pide en cada cambio del arreglo de órdenes y
    # cada pestaña abierta tiene su propia caché de navegador, así que en
    # producción se midieron 8 llamadas en 460 ms — ocho barridos completos.
    # El lock es la mitad que importa: sin él, las 8 concurrentes lanzan el
    # barrido a la vez; con él, una consulta y las demás leen el resultado.
    cache_key = ("board_counts",)
    cached = get_orders_cached(cache_key)
    if cached is not None:
        return Response(content=cached, media_type="application/json")

    if cache_key not in _orders_cache_locks:
        _orders_cache_locks[cache_key] = asyncio.Lock()

    async with _orders_cache_locks[cache_key]:
        cached = get_orders_cached(cache_key)
        if cached is not None:
            return Response(content=cached, media_type="application/json")

        pipeline = [{"$group": {"_id": "$board", "count": {"$sum": 1}}}]
        results = await db.orders.aggregate(pipeline).to_list(1000)
        # Convert to simple key-value: {BOARD_NAME: COUNT}
        counts = {r["_id"]: r["count"] for r in results if r["_id"]}
        return _cache_and_respond(cache_key, counts)

@router.get("/check-number")
async def check_order_number(request: Request, order_number: str = None):
    await require_auth(request)
    if not order_number or not order_number.strip():
        return {"exists": False}
    
    order_num = order_number.strip()
    # Try to find an ACTIVE duplicate first
    exists = await db.orders.find_one({"order_number": order_num, "board": {"$ne": "PAPELERA DE RECICLAJE"}})
    
    # If no active duplicate, check if one exists in the trash
    if not exists:
        exists = await db.orders.find_one({"order_number": order_num, "board": "PAPELERA DE RECICLAJE"})
        
    if not exists:
        return {"exists": False, "order": None, "in_trash": False}
        
    order_data = {k: v for k, v in exists.items() if k != "_id"}
    in_trash = order_data.get("board") == "PAPELERA DE RECICLAJE"
    return {
        "exists": True,
        "order": order_data,
        "in_trash": in_trash
    }

async def _con_par_embarque(items):
    """Tarea 4.1: agrega a cada item el par qty_ordered vs qty_shipped.
    `quantity` (el valor crudo histórico) no se toca — consumidores actuales;
    qty_ordered es su lectura numérica y qty_shipped se DERIVA de la bitácora
    del WMS (ver services/qty_embarcada.py — no hay contador paralelo).
    order_id se proyecta solo para el cálculo y no sale en la respuesta."""
    embarcado = await qty_embarcada_por_orden(db, items)
    for it in items:
        it["qty_ordered"] = entero_o_none(it.get("quantity"))
        it["qty_shipped"] = embarcado.get(str(it.get("order_number") or "").strip(), 0)
        it.pop("order_id", None)
    return items


@router.get("/shipped")
async def list_shipped_orders(request: Request, skip: int = 0, limit: int = 50):
    """Órdenes con packing cargado (el camioncito): las que ya tienen packing_link.
    Paginado — 50 por defecto. Para exportar, el front pide páginas más grandes.
    NOTA: debe declararse ANTES de /{order_id} o el catch-all se la traga."""
    user = await require_auth(request)
    filtro_cliente = require_api_customer(user, request)
    skip = max(0, skip)
    limit = max(1, min(limit, 5000))
    q = {"packing_link": {"$nin": [None, ""]}, "board": {"$ne": "PAPELERA DE RECICLAJE"}}
    if filtro_cliente:
        q.update(filtro_cliente)
    total = await db.orders.count_documents(q)
    proj = {
        "_id": 0, "order_id": 1, "order_number": 1, "client": 1, "style": 1, "color": 1,
        "quantity": 1, "customer_po": 1, "board": 1, "due_date": 1,
        "packing_link": 1, "packing_link_label": 1, "packing_link_at": 1,
    }
    items = await (db.orders.find(q, proj)
                   .sort("packing_link_at", -1).skip(skip).limit(limit).to_list(limit))
    return {"total": total, "skip": skip, "limit": limit,
            "items": await _con_par_embarque(items)}


@router.get("/available-to-ship")
async def list_available_to_ship(request: Request, skip: int = 0, limit: int = 50, search: str = ""):
    """Órdenes DISPONIBLES para programar envío: todas las vivas (fuera de PAPELERA)
    que NO estén ya programadas (excluye las de scheduled_shipments). Tengan o no
    packing (camioncito). NOTA: debe declararse ANTES de /{order_id}."""
    user = await require_auth(request)
    filtro_cliente = require_api_customer(user, request)
    skip = max(0, skip)
    limit = max(1, min(limit, 5000))
    scheduled_nums = await db.scheduled_shipments.distinct("order_number")
    q = {
        "board": {"$ne": "PAPELERA DE RECICLAJE"},
        "order_number": {"$nin": scheduled_nums},
    }
    if filtro_cliente:
        q.update(filtro_cliente)
    if search:
        rx = {"$regex": re.escape(search), "$options": "i"}
        q["$or"] = [{"order_number": rx}, {"client": rx}, {"customer_po": rx}]
    proj = {
        "_id": 0, "order_id": 1, "order_number": 1, "client": 1, "customer_po": 1, "branding": 1,
        "quantity": 1, "cancel_date": 1, "ship_by": 1, "production_status": 1, "board": 1,
    }
    total = await db.orders.count_documents(q)
    items = await (db.orders.find(q, proj)
                   .sort("cancel_date", 1).skip(skip).limit(limit).to_list(limit))
    return {"total": total, "skip": skip, "limit": limit,
            "items": await _con_par_embarque(items)}


@router.get("/{order_id}")
async def get_order(order_id: str, request: Request):
    user = await require_auth(request)
    # Tarea 2.3: para llaves de API, customer obligatorio y la orden debe
    # pertenecerle (la 2.1 cubrió los listados; esto cierra la orden puntual).
    filtro_cliente = require_api_customer(user, request)
    order = await db.orders.find_one({"order_id": order_id}, {"_id": 0})
    if not order:
        # Prioritize active orders if searching by order number
        order = await db.orders.find_one({"order_number": order_id, "board": {"$ne": "PAPELERA DE RECICLAJE"}}, {"_id": 0})
        if not order:
            # Fallback to trash if no active order found
            order = await db.orders.find_one({"order_number": order_id}, {"_id": 0})
    if not order:
        raise HTTPException(status_code=404, detail="Order not found")
    if filtro_cliente:
        rx = filtro_cliente["client"]["$regex"]
        if not re.match(rx, str(order.get("client") or ""), re.IGNORECASE):
            raise HTTPException(status_code=403, detail="La orden no pertenece al cliente consultado.")
    return _merge_custom_fields(order)

def validar_posiciones(valor):
    """Normaliza las posiciones de impresión al orden canónico, o falla.

    Conjunto CERRADO (ver DESIGN_POSITIONS): de esto dependen el avance por talla
    y el Producido/Restante, así que un valor inventado no rompería una etiqueta,
    rompería una cifra que producción usa para decidir. Se rechaza en vez de
    guardarse.

    Se usa al CREAR y al EDITAR. Vivía solo en el update, y eso dejaba que una
    orden naciera con posiciones basura que el tablero luego pintaba como si
    fueran válidas.
    """
    if valor is None:
        return []
    if not isinstance(valor, list):
        raise HTTPException(status_code=422, detail="print_positions debe ser una lista")
    vistas = set()
    for p in valor:
        v = str(p or "").strip().upper()
        if not v:
            continue
        if v not in DESIGN_POSITIONS:
            raise HTTPException(
                status_code=422,
                detail=f"Posición inválida: {p!r}. Válidas: {', '.join(DESIGN_POSITIONS)}")
        vistas.add(v)
    return [p for p in DESIGN_POSITIONS if p in vistas]


async def internal_create_order(order: OrderCreate, user: dict) -> dict:
    """Core logic for order creation, reusable by API and internal processes."""
    # Security: block duplicates only if existing order is NOT in the trash
    if order.order_number and order.order_number.strip():
        active_existing = await db.orders.find_one({
            "order_number": order.order_number.strip(),
            "board": {"$ne": "PAPELERA DE RECICLAJE"}
        })
        if active_existing:
            existing_board = active_existing.get("board", "")
            raise HTTPException(
                status_code=400,
                detail=f"La orden {order.order_number} ya existe en el tablero '{existing_board}'."
            )

    order_id = f"ord_{uuid.uuid4().hex[:12]}"
    order_data = order.model_dump(by_alias=True)
    # Merge extra fields to ensure they are at the root level in the DB
    extra = order.model_extra or {}
    order_data.update(extra)
    
    # CRITICAL: Prevent nested custom_fields from persisting
    if "custom_fields" in order_data:
        nested = order_data.pop("custom_fields")
        if isinstance(nested, dict):
            for k, v in nested.items():
                if k not in order_data:
                    order_data[k] = v
    
    # Posiciones de impresión: se validan igual que al editar. Las que captura
    # data entry en el formulario NO quedan marcadas como deducidas — son un dato
    # capturado, no una suposición del sistema.
    if order_data.get("print_positions") is not None:
        order_data["print_positions"] = validar_posiciones(order_data["print_positions"])
        order_data["print_positions_inferred"] = False

    # Safety: ensure board is NEVER null — default to SCHEDULING
    if not order_data.get("board"):
        logger.warning(f"Order created without a board, defaulting to SCHEDULING (order: {order_data.get('order_number')})")
        order_data["board"] = "SCHEDULING"
        
    # Pre-Order Linkage Logic
    linked_preorder_id = order_data.pop("linked_preorder_id", None)
    if linked_preorder_id:
        preorder = await db.orders.find_one({"order_id": linked_preorder_id, "is_preorder": True})
        if preorder:
            logger.info(f"Linking new order {order_id} to preorder {linked_preorder_id}")
            # Transfer art and screen statuses
            order_data["art_sep_status"] = preorder.get("art_sep_status", False)
            order_data["art_neck_status"] = preorder.get("art_neck_status", False)
            order_data["screens"] = preorder.get("screens", False)
            
            # Mark preorder as converted
            await db.orders.update_one(
                {"order_id": linked_preorder_id},
                {"$set": {"artwork_status": "CONVERTED", "updated_at": datetime.now(timezone.utc).isoformat()}}
            )

    order_doc = {**order_data, "order_id": order_id, "created_at": datetime.now(timezone.utc).isoformat(), "updated_at": datetime.now(timezone.utc).isoformat()}
    await db.orders.insert_one(order_doc)
    await log_activity(user, "create_order", {"order_id": order_id, "order_number": order.order_number})
    
    # Use in-memory doc for automations to avoid potential consistency delays or None issues
    created = {k: v for k, v in order_doc.items() if k != "_id"}
    try:
        await _run_automations("create", created, user)
    except Exception as e:
        logger.error(f"Error running automations after order creation: {e}")
        
    await _notify_all(user, "create", f"{user.get('name', 'Sistema')} creo orden {order.order_number}", order_id, order.order_number)
    # + el tablero real tras las automatizaciones de "create" (pudieron moverla).
    created_boards = [order_data.get("board") or order.board]
    now_doc = await db.orders.find_one({"order_id": order_id}, {"_id": 0, "board": 1})
    if now_doc and now_doc.get("board") and now_doc["board"] not in created_boards:
        created_boards.append(now_doc["board"])
    await ws_manager.broadcast("order_change", {"action": "create", "boards": created_boards})
    return created

@router.post("")
async def create_order(order: OrderCreate, request: Request):
    user = await require_auth(request)
    return await internal_create_order(order, user)

# Job Title A/B guardan el enlace capturado del trabajo (link + descripción).
# Regla de negocio: capturado una vez, solo supersu lo modifica o elimina.
_JOB_TITLE_PROTECTED = ("job_title_a", "job_title_b")


def _link_canon(v):
    """Forma canónica de una celda link_desc para comparar: (url, desc).
    El valor puede venir como dict {url, desc}, string plano o vacío."""
    if isinstance(v, dict):
        return ((v.get("url") or "").strip(), (v.get("desc") or "").strip())
    return ((str(v).strip() if v else ""), "")


@router.put("/{order_id}")
async def update_order(order_id: str, order: OrderUpdate, request: Request):
    user = await require_auth(request)
    existing = await db.orders.find_one({"order_id": order_id}, {"_id": 0})
    if not existing:
        raise HTTPException(status_code=404, detail="Order not found")
    update_data = order.model_dump(exclude_unset=True, by_alias=True)
    # Merge extra fields provided in the update payload
    extra = order.model_extra or {}
    update_data.update(extra)

    # CRITICAL: Prevent nested custom_fields from persisting
    if "custom_fields" in update_data:
        nested = update_data.pop("custom_fields")
        if isinstance(nested, dict):
            for k, v in nested.items():
                # On updates, we always merge to ensure root-level visibility
                update_data[k] = v

    # QC Lock: block status/board changes on locked orders for non-supersu/inspector_qc users
    _LOCK_PROTECTED = {"production_status", "board"}
    if existing.get("locked_by_qc") and user.get("role") not in ("supersu", "inspector_qc", "qc"):
        if any(f in update_data for f in _LOCK_PROTECTED):
            raise HTTPException(status_code=403, detail="locked_by_qc")

    # Job Title A/B: una vez capturado el enlace, SOLO supersu puede modificarlo
    # o vaciarlo. Cualquiera puede llenarlo cuando está vacío. Se protege aquí
    # (el backend es la autoridad) porque ocultar el lápiz en la UI no detiene a
    # un request directo ni a otra pantalla que edite el mismo campo.
    if user.get("role") != "supersu":
        for _f in _JOB_TITLE_PROTECTED:
            if _f in update_data:
                antes = _link_canon(existing.get(_f))
                despues = _link_canon(update_data.get(_f))
                if any(antes) and despues != antes:
                    raise HTTPException(
                        status_code=403,
                        detail=f"Job Title {'A' if _f.endswith('_a') else 'B'} ya tiene un "
                               f"enlace capturado; solo el Super Usuario puede modificarlo o eliminarlo.")

    # Set lock when production_status transitions to "NECESITA QC"
    if (update_data.get("production_status") == "NECESITA QC"
            and existing.get("production_status") != "NECESITA QC"):
        update_data["locked_by_qc"] = True

    # Al pasar a un estatus de RESOLUCIÓN de QC se libera el candado
    # automáticamente — reemplaza al botón "Liberar" del módulo de calidad.
    _QC_EXIT_STATUSES = {"LISTO PARA ENVIO", "LISTO PARA INVENTARIO", "RECHAZADO POR QC"}
    if str(update_data.get("production_status") or "").strip().upper() in _QC_EXIT_STATUSES:
        update_data["locked_by_qc"] = False

    # Remove board=null check to allow clearing or moving via direct update if needed,
    # but ensure it exists if requested.
    if "board" in update_data and update_data["board"] is None:
        # If explicitly clearing board, we might want to default to SCHEDULING or allow it?
        # Following the "flattening" philosophy, let's allow it but warn.
        logger.warning(f"Board being cleared for order {order_id}")
    # Posiciones de impresión. Conjunto cerrado (ver DESIGN_POSITIONS): un valor
    # fuera de la lista se rechaza en vez de guardarse, porque de esto dependen
    # los cálculos de avance por talla y el Producido/Restante.
    #
    # Editarlas a mano BORRA la marca de "deducido": el backfill dedujo las
    # posiciones de los registros de producción que ya existían, y ese valor es
    # un piso, no la verdad — una orden que lleva frente y espalda pero solo
    # tiene frente registrado se dedujo como "solo frente". Cuando una persona
    # lo confirma o corrige, deja de ser una suposición y la UI ya no lo marca.
    if "print_positions" in update_data:
        update_data["print_positions"] = validar_posiciones(update_data.get("print_positions"))
        update_data["print_positions_inferred"] = False

    # Tallas → cantidad. Editar tallas desde el tablero recalcula `quantity` con
    # su suma, igual que ya hace la captura de una orden nueva (NewOrderForm deja
    # Qty en solo-lectura cuando hay tallas). El cálculo vive AQUÍ y no en el
    # cliente porque el tablero, el modal de nueva orden, el import de Excel y
    # Printavo escriben todos por este endpoint: en el cliente habría que
    # repetirlo cuatro veces y las cuatro podrían discrepar.
    #
    # Sólo aplica cuando la petición trae `sizes` y NO trae `quantity`: un
    # llamador que manda ambos está declarando una cantidad a propósito
    # (recepciones parciales, correcciones) y no se le sobrescribe.
    #
    # No hay barrido masivo: una orden cuyas tallas nadie toque conserva su
    # cantidad tal cual, descuadre incluido. El tablero marca ese descuadre en
    # rojo para que alguien lo revise, pero no lo corrige a sus espaldas.
    if "sizes" in update_data and "quantity" not in update_data:
        _tallas = update_data.get("sizes")
        if isinstance(_tallas, dict):
            update_data["quantity"] = sum(
                int(v) for v in _tallas.values()
                if isinstance(v, (int, float)) and not isinstance(v, bool)
            )

    update_data["updated_at"] = datetime.now(timezone.utc).isoformat()

    # Sello de CUÁNDO entró la orden a su estado actual de producción. El módulo
    # de Final Bill necesita saber desde cuándo lleva parada una orden en LISTO
    # PARA ENVIO / LISTO PARA INVENTARIO, y `updated_at` no sirve: cualquier
    # edición posterior (una nota, una talla) lo pisa y borra el dato.
    # Solo se escribe cuando el estado CAMBIA de verdad; reguardar el mismo
    # estado no reinicia el reloj.
    if "production_status" in update_data:
        if (update_data.get("production_status") or "") != (existing.get("production_status") or ""):
            update_data["production_status_at"] = update_data["updated_at"]

    # Board QC Lock: block moving OUT of CONTROL DE CALIDAD
    old_board = existing.get("board")
    new_board = update_data.get("board")
    if old_board == "CONTROL DE CALIDAD" and new_board and new_board != old_board:
        if user.get("role") not in ("supersu", "inspector_qc", "qc"):
            raise HTTPException(status_code=403, detail="Board CONTROL DE CALIDAD is locked for your role")

    # Guardas / validaciones (automatizaciones tipo "guard"): pueden BLOQUEAR el
    # cambio de status o de tablero hasta que se cumpla un requisito (foto de
    # evidencia, campo lleno, otro badge). Se evalúan ANTES de escribir.
    _status_changing = ("production_status" in update_data
                        and (update_data.get("production_status") or "") != (existing.get("production_status") or ""))
    _board_changing = bool(new_board and old_board != new_board)
    if _status_changing or _board_changing:
        from routers.automations import check_guards  # lazy import (evita ciclo)
        _block = await check_guards(existing, update_data, user,
                                    status_changing=_status_changing, board_changing=_board_changing,
                                    new_board=new_board)
        if _block:
            raise HTTPException(status_code=422, detail=_block)

    await db.orders.update_one({"order_id": order_id}, {"$set": update_data})
    updated = await db.orders.find_one({"order_id": order_id}, {"_id": 0})
    changed_data = {k: v for k, v in update_data.items() if k != "updated_at"}
    prev_values = {k: existing.get(k) for k in changed_data}
    # Record per-field from→to so the order history can show "X changed from A to B".
    changes = {k: {"from": existing.get(k), "to": v} for k, v in changed_data.items()}
    await log_activity(user, "update_order", {
        "order_id": order_id, "order_number": existing.get("order_number"),
        "changed_fields": list(changed_data.keys()), "changes": changes,
    }, previous_data={"order_id": order_id, "fields": prev_values})
    # Auto-create QC record when production_status changes to "NECESITA QC"
    old_status = existing.get("production_status", "")
    new_status = update_data.get("production_status", "")
    if new_status == "NECESITA QC" and old_status != "NECESITA QC":
        already_exists = await db.qc_records.find_one({"order_id": order_id, "auto_generated": True, "request_date": datetime.now(timezone.utc).date().isoformat()})
        if not already_exists:
            today = datetime.now(timezone.utc).date().isoformat()
            qc_doc = {
                "qc_id": f"qc_{__import__('uuid').uuid4().hex[:12]}",
                "order_id": order_id,
                "order_number": existing.get("order_number", ""),
                "client": existing.get("client", ""),
                "inspector": user.get("name", user.get("email", "")),
                "inspector_id": user.get("user_id", ""),
                "request_date": today,
                "inspection_date": today,
                "finding_type": "OTHER",
                "severity": "MINOR",
                "result": "PASS",
                "quantity_inspected": 0,
                "quantity_rejected": 0,
                "findings": "",
                "corrective_action": "",
                "quantity": existing.get("quantity", ""),
                "job_title_a": existing.get("job_title_a", ""),
                "auto_generated": True,
                "created_at": datetime.now(timezone.utc).isoformat(),
                "updated_at": datetime.now(timezone.utc).isoformat(),
            }
            await db.qc_records.insert_one(qc_doc)
            await log_activity(user, "auto_create_qc", {"order_id": order_id, "order_number": existing.get("order_number"), "reason": "NECESITA QC"})

    executed_automations = []
    if new_board and old_board != new_board:
        executed_automations += await _run_automations("move", updated, user, {"from_board": old_board, "to_board": new_board})
    else:
        executed_automations += await _run_automations("update", updated, user, {"changed_fields": list(update_data.keys())})
    changed_status_fields = [f for f in update_data if f not in ["updated_at", "board"] and existing.get(f) != update_data[f]]
    if changed_status_fields:
        executed_automations += await _run_automations("status_change", updated, user, {
            "changed_fields": changed_status_fields, "old_values": {f: existing.get(f) for f in changed_status_fields}
        })
    final_order = await db.orders.find_one({"order_id": order_id}, {"_id": 0})
    boards_affected = [old_board]
    if new_board and old_board != new_board:
        boards_affected.append(new_board)
    # Una automatización puede haber movido la orden a un TERCER tablero en esta
    # misma petición: ese también cambió (caché del server y clientes que lo ven).
    final_board = (final_order or {}).get("board")
    if final_board and final_board not in boards_affected:
        boards_affected.append(final_board)
    await ws_manager.broadcast("order_change", {"action": "update", "order_id": order_id, "boards": boards_affected})
    return {**(_merge_custom_fields(final_order or updated)), "_automations_executed": executed_automations}

@router.post("/{order_id}/move")
async def move_order(order_id: str, request: Request):
    user = await require_auth(request)
    body = await request.json()
    return await move_order_core(user, order_id, body.get("board"))


async def move_order_core(user: dict, order_id: str, target_board: str, extra_set: dict = None):
    """Mueve UNA orden de tablero con todas las reglas de MOS (candado QC,
    tablero de CONTROL DE CALIDAD, guardas, bitácora, automatizaciones de
    "move", notificación y broadcast). La usan el endpoint de arriba y el botón
    "Aplicar" del módulo de Planeación: un solo camino para mover órdenes.
    extra_set: campos adicionales en el mismo $set (p. ej. scheduled_day)."""
    boards = await get_dynamic_boards()
    if target_board not in boards and target_board != "PAPELERA DE RECICLAJE":
        raise HTTPException(status_code=400, detail=f"Invalid board")
    existing = await db.orders.find_one({"order_id": order_id}, {"_id": 0})
    if not existing:
        raise HTTPException(status_code=404, detail="Order not found")
    if existing.get("locked_by_qc") and user.get("role") not in ("supersu", "inspector_qc", "qc"):
        raise HTTPException(status_code=403, detail="locked_by_qc")
    old_board = existing.get("board")
    if old_board == "CONTROL DE CALIDAD" and target_board != old_board:
        if user.get("role") not in ("supersu", "inspector_qc", "qc"):
            raise HTTPException(status_code=403, detail="Board CONTROL DE CALIDAD is locked for your role")
    # Guardas: un movimiento de tablero también puede requerir foto/campo/flag.
    if old_board != target_board and target_board != "PAPELERA DE RECICLAJE":
        from routers.automations import check_guards  # lazy import (evita ciclo)
        _block = await check_guards(existing, {"board": target_board}, user,
                                    board_changing=True, new_board=target_board)
        if _block:
            raise HTTPException(status_code=422, detail=_block)
    await db.orders.update_one({"order_id": order_id}, {"$set": {"board": target_board, "updated_at": datetime.now(timezone.utc).isoformat(), **(extra_set or {})}})
    updated = await db.orders.find_one({"order_id": order_id}, {"_id": 0})
    await log_activity(user, "move_order", {"order_id": order_id, "order_number": existing.get("order_number"), "from_board": old_board, "to_board": target_board}, previous_data={"order_id": order_id, "fields": {"board": old_board}})
    executed_automations = await _run_automations("move", updated, user, {"from_board": old_board, "to_board": target_board})
    final_order = await db.orders.find_one({"order_id": order_id}, {"_id": 0})
    await _notify_all(user, "move", f"{user['name']} movio orden {existing.get('order_number', order_id)} de {old_board} a {target_board}", order_id, existing.get("order_number"))
    # + el tablero final real: una automatización "move" pudo llevarla a otro.
    moved_boards = [old_board, target_board]
    final_board = (final_order or {}).get("board")
    if final_board and final_board not in moved_boards:
        moved_boards.append(final_board)
    await ws_manager.broadcast("order_change", {"action": "move", "order_id": order_id, "boards": moved_boards})
    return {**(_merge_custom_fields(final_order or updated)), "_automations_executed": executed_automations}

@router.delete("/{order_id}")
async def delete_order(order_id: str, request: Request):
    user = await require_auth(request)
    existing = await db.orders.find_one({"order_id": order_id}, {"_id": 0})
    if not existing:
        raise HTTPException(status_code=404, detail="Order not found")
    
    now = datetime.now(timezone.utc).isoformat()
    await db.orders.update_one(
        {"order_id": order_id}, 
        {"$set": {
            "board": "PAPELERA DE RECICLAJE", 
            "deleted_at": now,
            "updated_at": now
        }}
    )
    
    await log_activity(user, "delete_order", {"order_id": order_id, "order_number": existing.get("order_number")}, previous_data={"order_id": order_id, "fields": {"board": existing.get("board")}})
    await ws_manager.broadcast("order_change", {"action": "delete", "order_id": order_id, "boards": [existing.get("board"), "PAPELERA DE RECICLAJE"]})
    return {"message": "Order moved to trash", "deleted_at": now}

@router.delete("/{order_id}/permanent")
async def permanent_delete_order(order_id: str, request: Request):
    # Permanent purge (with invoice/work-order cascade) is admin-only. The soft
    # delete to trash (DELETE /{order_id}) stays open to any authenticated user.
    user = await require_admin(request)

    # Debug log to see what ID we are receiving
    logger.info(f"Attempting permanent delete for order: {order_id}")
    
    # Robust lookup: check both order_id and _id if necessary
    existing = await db.orders.find_one({
        "$or": [
            {"order_id": order_id},
            {"id": order_id},
            {"order_number": order_id}
        ]
    }, {"_id": 0})
    
    if not existing:
        logger.error(f"Permanent delete failed: Order {order_id} not found in DB")
        raise HTTPException(status_code=404, detail="Order not found")
        
    # Get invoice reference before deleting
    invoice_ref = existing.get("invoice_ref")
    
    # 1. Delete the order
    await db.orders.delete_one({"order_id": order_id})
    
    # 2. CASCADE DELETE: Remove the linked invoice if it exists
    if invoice_ref:
        inv_result = await db.invoices.delete_one({"invoice_id": invoice_ref})
        if inv_result.deleted_count > 0:
            logger.info(f"Cascade delete: Invoice {invoice_ref} removed because order {order_id} was permanently deleted")
            await ws_manager.broadcast("invoice_change", {"action": "delete", "invoice_id": invoice_ref})

    # 3. CASCADE DELETE: Remove linked Work Orders
    wo_result = await db.work_orders.delete_many({"source_invoice_id": invoice_ref} if invoice_ref else {"order_id": order_id})
    if wo_result.deleted_count > 0:
        await ws_manager.broadcast("work_order_change", {"action": "delete", "order_id": order_id})

    await log_activity(user, "permanent_delete_order", {"order_id": order_id, "order_number": existing.get("order_number")})
    return {"message": "Order and linked invoice deleted permanently"}

# Boards (besides MAQUINA*) that participate in the day-of-week scheduling.
DAY_SUPPORTED_BOARDS = {"READY TO SCHEDULED", "BLANKS", "SCREENS", "NECK"}
# Boards (besides MAQUINA*) that carry an Active / Queued sub-state.
# Machines were the first, but BLANKS and NECK ship + queue work that mirrors
# the machine workflow closely enough that the same Activa / En Cola split is
# useful there too.
QUEUE_SUPPORTED_BOARDS = {"BLANKS", "NECK"}
VALID_DAYS = {"monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"}
WEEKDAY_NAMES = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"]


def _is_queue_supported(board: str) -> bool:
    """A board carries queue_status if it's a machine or in the fixed list."""
    return bool(board) and (board.startswith("MAQUINA") or board in QUEUE_SUPPORTED_BOARDS)


def _today_weekday() -> str:
    """Return today's weekday name in lowercase (server local time = UTC)."""
    return WEEKDAY_NAMES[datetime.now(timezone.utc).weekday()]


@router.post("/bulk-move")
async def bulk_move_orders(request: Request):
    user = await require_auth(request)
    body = await request.json()
    order_ids = body.get("order_ids", [])
    target_board = body.get("board")
    # Optional sub-state inside a machine board. Accepted values:
    #   "active"  → running on the machine right now
    #   "queued"  → waiting in line for that machine ("A Cola")
    # For non-machine boards this is forced to None.
    queue_status_provided = "queue_status" in body
    queue_status = body.get("queue_status")
    # Optional day-of-week bucket. Accepted values: monday..sunday or None.
    # Only meaningful on day-supported boards (machines + R.T.S./BLANKS/SCREENS/NECK).
    scheduled_day_provided = "scheduled_day" in body
    scheduled_day = body.get("scheduled_day")

    if not order_ids or not target_board:
        raise HTTPException(status_code=400, detail="order_ids and board required")
    boards = await get_dynamic_boards()
    if target_board not in boards and target_board != "PAPELERA DE RECICLAJE":
        raise HTTPException(status_code=400, detail="Invalid board")
    if queue_status_provided and queue_status not in (None, "active", "queued"):
        raise HTTPException(status_code=400, detail="queue_status must be 'active', 'queued' or null")
    if scheduled_day_provided and scheduled_day not in (None, *VALID_DAYS):
        raise HTTPException(status_code=400, detail="scheduled_day must be a weekday name or null")
    original_orders = await db.orders.find({"order_id": {"$in": order_ids}}, {"_id": 0, "order_id": 1, "board": 1, "order_number": 1, "locked_by_qc": 1}).to_list(len(order_ids))
    original_boards = {o["order_id"]: o["board"] for o in original_orders}

    # Block non-supersu/inspector_qc if any order is locked by QC
    if user.get("role") not in ("supersu", "inspector_qc", "qc"):
        locked = [o.get("order_number", o["order_id"]) for o in original_orders if o.get("locked_by_qc")]
        if locked:
            raise HTTPException(status_code=403, detail=f"locked_by_qc:{','.join(locked)}")

    if user.get("role") not in ("supersu", "inspector_qc", "qc"):
        qc_board = [o.get("order_number", o["order_id"]) for o in original_orders if o.get("board") == "CONTROL DE CALIDAD"]
        if qc_board:
            raise HTTPException(status_code=403, detail=f"CONTROL DE CALIDAD locked:{','.join(qc_board)}")

    # Guardas (Fase 3, Track 4): en un movimiento masivo, filtra las órdenes que
    # una guarda bloquea y mueve el resto (bulk es conveniencia, no todo-o-nada);
    # las bloqueadas se reportan con su motivo. Solo se evalúa si existe alguna
    # guarda activa (evita N consultas cuando no hay ninguna).
    guard_blocked = []
    if target_board != "PAPELERA DE RECICLAJE" and await db.automations.count_documents(
            {"trigger_type": "guard", "is_active": True}) > 0:
        from routers.automations import check_guards
        full_docs = await db.orders.find({"order_id": {"$in": order_ids}}, {"_id": 0}).to_list(len(order_ids))
        allowed_ids = []
        for od in full_docs:
            if od.get("board") == target_board:
                allowed_ids.append(od["order_id"]); continue
            blk = await check_guards(od, {"board": target_board}, user, board_changing=True, new_board=target_board)
            if blk:
                guard_blocked.append({"order_number": od.get("order_number") or od["order_id"], "reason": blk})
            else:
                allowed_ids.append(od["order_id"])
        if guard_blocked:
            allowed_set = set(allowed_ids)
            order_ids = allowed_ids
            original_orders = [o for o in original_orders if o["order_id"] in allowed_set]
            original_boards = {k: v for k, v in original_boards.items() if k in allowed_set}
            if not order_ids:
                return {"modified_count": 0, "guard_blocked": guard_blocked, "_automations_executed": []}

    is_machine_board = target_board.startswith("MAQUINA")
    is_queue_supported = _is_queue_supported(target_board)
    is_day_supported = is_machine_board or target_board in DAY_SUPPORTED_BOARDS

    # Build the base $set payload. queue_status / scheduled_day get added based
    # on whether the caller explicitly set them and whether the target board
    # supports the field.
    base_update = {
        "board": target_board,
        "updated_at": datetime.now(timezone.utc).isoformat(),
    }

    # scheduled_day handling
    if scheduled_day_provided:
        base_update["scheduled_day"] = scheduled_day
    elif not is_day_supported:
        # Always clear on incompatible boards so the value doesn't linger.
        base_update["scheduled_day"] = None
    # else: target is day-supported and no explicit value.
    # Default any order whose scheduled_day is currently null/missing to TODAY
    # so the board never accumulates a "Sin día" pile. Orders that already
    # have a day on a day-supported source board keep their day.
    elif is_day_supported and any(
        not o.get("scheduled_day") for o in original_orders
    ):
        today = _today_weekday()
        orders_to_default = [
            o["order_id"] for o in original_orders if not o.get("scheduled_day")
        ]
        await db.orders.update_many(
            {"order_id": {"$in": orders_to_default}},
            {"$set": {"scheduled_day": today}},
        )

    # queue_status handling — the special case is "no explicit value and target
    # supports queue": orders coming from a board that does NOT support queue
    # must default to "active" while orders coming from another queue-supported
    # board keep their current queue_status (so e.g. day-chips don't
    # accidentally flip queued orders to active).
    log_queue_status = queue_status if queue_status_provided else ("active" if is_queue_supported else None)

    if queue_status_provided:
        base_update["queue_status"] = queue_status
        result = await db.orders.update_many({"order_id": {"$in": order_ids}}, {"$set": base_update})
        modified_count = result.modified_count
    elif not is_queue_supported:
        base_update["queue_status"] = None
        result = await db.orders.update_many({"order_id": {"$in": order_ids}}, {"$set": base_update})
        modified_count = result.modified_count
    else:
        # Target is queue-supported (machine/BLANKS/NECK), queue_status implicit:
        # split into two updates so previously-queued orders preserve their
        # state and newcomers get a sane default.
        from_non_queue_ids = [
            o["order_id"]
            for o in original_orders
            if not _is_queue_supported(o.get("board") or "")
        ]
        preserve_ids = [oid for oid in order_ids if oid not in from_non_queue_ids]
        modified_count = 0
        if from_non_queue_ids:
            r1 = await db.orders.update_many(
                {"order_id": {"$in": from_non_queue_ids}},
                {"$set": {**base_update, "queue_status": "active"}},
            )
            modified_count += r1.modified_count
        if preserve_ids:
            r2 = await db.orders.update_many(
                {"order_id": {"$in": preserve_ids}},
                {"$set": base_update},
            )
            modified_count += r2.modified_count

    class _R:
        pass
    result = _R()
    result.modified_count = modified_count

    # El renglón del lote se guarda ya legible: qué orden, de dónde, a dónde.
    # Antes solo quedaba "38 órdenes → BLANKS", con los IDs escondidos en
    # `previous_data`, así que ningún movimiento de tablero aparecía en el
    # historial de su orden ni se podía buscar por número. Se ESCRIBE en
    # `details` (lectura); `previous_data` no se toca porque de ahí vive el
    # undo y cambiarlo rompería el deshacer de todo lo ya registrado.
    numeros = {o["order_id"]: o.get("order_number") for o in original_orders}
    movimientos = [
        {
            "order_id": oid,
            "order_number": numeros.get(oid) or oid,
            "from_board": original_boards.get(oid),
            "to_board": target_board,
        }
        for oid in order_ids
    ]

    await log_activity(
        user,
        "bulk_move_orders",
        {
            "order_count": len(order_ids),
            "target_board": target_board,
            "queue_status": log_queue_status,
            "scheduled_day": scheduled_day if scheduled_day_provided else None,
            "order_numbers": [m["order_number"] for m in movimientos],
            "moves": movimientos,
        },
        previous_data={"order_ids": order_ids, "original_boards": original_boards},
    )
    
    executed_automations = []
    updated_orders = await db.orders.find({"order_id": {"$in": order_ids}}, {"_id": 0}).to_list(len(order_ids))
    for order in updated_orders:
        old_board = original_boards.get(order["order_id"])
        autos = await _run_automations("move", order, user, {"from_board": old_board, "to_board": target_board})
        executed_automations.extend(autos)

    affected_boards = list(set(original_boards.values())) + [target_board]
    # + tableros finales reales: las automatizaciones "move" pudieron llevar
    # alguna orden a otro tablero distinto del destino pedido.
    if executed_automations:
        async for d in db.orders.find({"order_id": {"$in": order_ids}}, {"_id": 0, "board": 1}):
            if d.get("board") and d["board"] not in affected_boards:
                affected_boards.append(d["board"])
    await _notify_all(user, "move", f"{user['name']} movio {len(order_ids)} ordenes a {target_board}", None, None)
    await ws_manager.broadcast("order_change", {"action": "bulk_move", "boards": affected_boards})
    return {"modified_count": result.modified_count, "guard_blocked": guard_blocked,
            "_automations_executed": executed_automations}

@router.post("/export")
async def export_orders(request: Request):
    user = await require_auth(request)
    body = await request.json()
    order_ids = body.get("order_ids", [])
    if not order_ids:
        raise HTTPException(status_code=400, detail="order_ids required")
    orders = await db.orders.find({"order_id": {"$in": order_ids}}, {"_id": 0}).to_list(len(order_ids))
    await log_activity(user, "export_orders", {"order_count": len(orders)})
    return {"orders": [_merge_custom_fields(order) for order in orders]}

# ==================== LINKS ====================

@router.get("/{order_id}/links")
async def get_order_links(order_id: str, request: Request):
    await require_auth(request)
    order = await db.orders.find_one({"order_id": order_id}, {"_id": 0})
    if not order:
        raise HTTPException(status_code=404, detail="Order not found")
    return order.get("links", [])

@router.post("/{order_id}/links")
async def add_order_link(order_id: str, request: Request):
    user = await require_auth(request)
    body = await request.json()
    url = body.get("url", "").strip()
    description = body.get("description", "").strip()
    if not url:
        raise HTTPException(status_code=400, detail="URL required")
    order = await db.orders.find_one({"order_id": order_id}, {"_id": 0, "order_number": 1})
    if not order:
        raise HTTPException(status_code=404, detail="Order not found")
    link = {"url": url, "description": description, "created_at": datetime.now(timezone.utc).isoformat(), "added_by": user["name"]}
    await db.orders.update_one({"order_id": order_id}, {"$push": {"links": link}})
    await log_activity(user, "add_order_link", {
        "order_id": order_id, "order_number": order.get("order_number"),
        "url": url, "description": description,
    })
    await ws_manager.broadcast("order_change", {"action": "add_link", "order_id": order_id})
    return link

@router.post("/{order_id}/twin")
async def pair_order_twin(order_id: str, request: Request):
    """Pair this order with another order as 'twins' (same parameters,
    different order numbers). Writes twin_order_number on BOTH sides so
    either order shows the link. If either side already had a twin, that
    previous link is broken so we don't end up with stale references."""
    user = await require_auth(request)
    body = await request.json()
    twin_number = (body.get("twin_order_number") or "").strip()
    if not twin_number:
        raise HTTPException(status_code=400, detail="twin_order_number requerido")

    me = await db.orders.find_one({"order_id": order_id}, {"_id": 0})
    if not me:
        raise HTTPException(status_code=404, detail="Orden no encontrada")
    if (me.get("order_number") or "").strip() == twin_number:
        raise HTTPException(status_code=400, detail="Una orden no puede ser gemela de si misma")

    twin = await db.orders.find_one(
        {"order_number": twin_number, "board": {"$ne": "PAPELERA DE RECICLAJE"}},
        {"_id": 0}
    )
    if not twin:
        raise HTTPException(status_code=404, detail=f"No se encontro una orden activa con numero {twin_number}")

    now_iso = datetime.now(timezone.utc).isoformat()

    # If either side already pointed at a different order, clear that stale back-reference
    prev_my_twin = (me.get("twin_order_number") or "").strip()
    if prev_my_twin and prev_my_twin != twin_number:
        await db.orders.update_one(
            {"order_number": prev_my_twin, "twin_order_number": me.get("order_number")},
            {"$set": {"twin_order_number": None, "updated_at": now_iso}},
        )
    prev_their_twin = (twin.get("twin_order_number") or "").strip()
    if prev_their_twin and prev_their_twin != (me.get("order_number") or ""):
        await db.orders.update_one(
            {"order_number": prev_their_twin, "twin_order_number": twin.get("order_number")},
            {"$set": {"twin_order_number": None, "updated_at": now_iso}},
        )

    await db.orders.update_one(
        {"order_id": order_id},
        {"$set": {"twin_order_number": twin_number, "updated_at": now_iso}},
    )
    await db.orders.update_one(
        {"order_id": twin["order_id"]},
        {"$set": {"twin_order_number": me.get("order_number") or "", "updated_at": now_iso}},
    )

    await log_activity(user, "pair_twin", {
        "order_id": order_id,
        "order_number": me.get("order_number"),
        "twin_order_number": twin_number,
    })
    await ws_manager.broadcast("order_change", {
        "action": "twin_paired",
        "boards": list({me.get("board"), twin.get("board")} - {None}),
    })
    return {"status": "paired", "twin_order_number": twin_number, "twin_board": twin.get("board")}

@router.delete("/{order_id}/twin")
async def unpair_order_twin(order_id: str, request: Request):
    """Break the twin link on both sides."""
    user = await require_auth(request)
    me = await db.orders.find_one({"order_id": order_id}, {"_id": 0})
    if not me:
        raise HTTPException(status_code=404, detail="Orden no encontrada")
    twin_number = (me.get("twin_order_number") or "").strip()
    if not twin_number:
        return {"status": "noop"}

    now_iso = datetime.now(timezone.utc).isoformat()
    await db.orders.update_one(
        {"order_id": order_id},
        {"$set": {"twin_order_number": None, "updated_at": now_iso}},
    )
    # Clear the back-reference only when it actually points at this order, to
    # avoid accidentally breaking a re-paired twin's link.
    await db.orders.update_one(
        {"order_number": twin_number, "twin_order_number": me.get("order_number")},
        {"$set": {"twin_order_number": None, "updated_at": now_iso}},
    )
    await log_activity(user, "unpair_twin", {
        "order_id": order_id,
        "order_number": me.get("order_number"),
        "former_twin": twin_number,
    })
    await ws_manager.broadcast("order_change", {"action": "twin_unpaired"})
    return {"status": "unpaired"}

@router.delete("/{order_id}/links/{link_index}")
async def delete_order_link(order_id: str, link_index: int, request: Request):
    user = await require_auth(request)
    order = await db.orders.find_one({"order_id": order_id}, {"_id": 0})
    if not order:
        raise HTTPException(status_code=404, detail="Order not found")
    links = order.get("links", [])
    if link_index < 0 or link_index >= len(links):
        raise HTTPException(status_code=400, detail="Invalid link index")
    removed = links.pop(link_index)
    await db.orders.update_one({"order_id": order_id}, {"$set": {"links": links}})
    await log_activity(user, "delete_order_link", {
        "order_id": order_id, "order_number": order.get("order_number"),
        "url": removed.get("url"), "description": removed.get("description"),
        "added_by": removed.get("added_by"),
    })
    await ws_manager.broadcast("order_change", {"action": "delete_link", "order_id": order_id})
    return {"message": "Link deleted"}

# ==================== COMMENTS ====================

@router.post("/{order_id}/comments/{comment_id}/pin")
async def pin_comment(order_id: str, comment_id: str, request: Request):
    """Toggle the pinned state of a comment. Only admins can pin."""
    user = await require_auth(request)
    if user.get("role") not in ("admin", "supersu", "inspector_qc", "qc"):
        raise HTTPException(status_code=403, detail="Solo los administradores pueden anclar comentarios")
    comment = await db.comments.find_one({"comment_id": comment_id, "order_id": order_id})
    if not comment:
        raise HTTPException(status_code=404, detail="Comment not found")
    currently_pinned = comment.get("pinned", False)
    new_pinned = not currently_pinned
    update = {"pinned": new_pinned}
    if new_pinned:
        update["pinned_at"] = datetime.now(timezone.utc).isoformat()
        update["pinned_by"] = user["name"]
    else:
        update["pinned_at"] = None
        update["pinned_by"] = None
    await db.comments.update_one({"comment_id": comment_id}, {"$set": update})
    await ws_manager.broadcast("order_change", {"action": "pin_comment", "order_id": order_id})
    return {"pinned": new_pinned, "action": "pinned" if new_pinned else "unpinned"}

@router.post("/{order_id}/comments/{comment_id}/react")
async def react_to_comment(order_id: str, comment_id: str, request: Request):
    user = await require_auth(request)
    body = await request.json()
    emoji = body.get("emoji")
    if not emoji:
        raise HTTPException(status_code=400, detail="Emoji required")
    
    user_id = user["user_id"]
    logger.info(f"Reaction toggle: user {user_id}, comment {comment_id}, emoji {emoji}")
    
    comment = await db.comments.find_one({"comment_id": comment_id, "order_id": order_id})
    if not comment:
        logger.warning(f"Comment {comment_id} not found for order {order_id}")
        raise HTTPException(status_code=404, detail="Comment not found")
    
    # Ensure reactions exists
    reactions = comment.get("reactions")
    if not isinstance(reactions, dict):
        reactions = {}
    
    user_id_str = str(user_id)
    
    # Toggle reaction
    current_emoji_users = reactions.get(emoji, [])
    if not isinstance(current_emoji_users, list):
        current_emoji_users = []
        
    if user_id_str in current_emoji_users:
        current_emoji_users.remove(user_id_str)
        action = "removed"
    else:
        current_emoji_users.append(user_id_str)
        action = "added"
    
    if not current_emoji_users:
        reactions.pop(emoji, None)
    else:
        reactions[emoji] = current_emoji_users
    
    await db.comments.update_one({"comment_id": comment_id}, {"$set": {"reactions": reactions}})
    await ws_manager.broadcast("order_change", {"action": "comment_reaction", "order_id": order_id})
    logger.info(f"Reaction {action} for {comment_id}. Current reactions: {list(reactions.keys())}")
    return {"reactions": reactions, "action": action}

@router.get("/{order_id}/comments")
async def get_comments(order_id: str, request: Request):
    await require_auth(request)
    # Accept either order_id or order_number (pick tickets only carry the number).
    order = await db.orders.find_one({"$or": [{"order_id": order_id}, {"order_number": order_id}]}, {"_id": 0, "order_id": 1})
    oid = order["order_id"] if order else order_id
    comments = await db.comments.find({"order_id": oid}, {"_id": 0}).sort("created_at", 1).to_list(500)
    return comments

@router.post("/{order_id}/comments")
async def create_comment(order_id: str, comment: CommentCreate, request: Request):
    user = await require_auth(request)
    # Accept either order_id or order_number so the picker can comment by number.
    order = await db.orders.find_one({"$or": [{"order_id": order_id}, {"order_number": order_id}]}, {"_id": 0})
    if not order:
        raise HTTPException(status_code=404, detail="Order not found")
    order_id = order["order_id"]
    comment_id = f"comment_{uuid.uuid4().hex[:12]}"
    # Detect @mentions by matching against real user names/emails. The directory
    # read only happens when the comment actually contains an "@" — every mention
    # check below requires one, so a comment without "@" can't match anyone and we
    # skip loading the users collection entirely (the common case).
    content_lower = comment.content.lower()
    mentioned_users = []
    mentions = []
    if "@" in content_lower:
        all_users = await db.users.find({}, {"_id": 0, "email": 1, "user_id": 1, "name": 1}).to_list(200)
        for u in all_users:
            uname = (u.get("name") or "").strip()
            uemail = (u.get("email") or "").strip()
            if uname and f"@{uname.lower()}" in content_lower:
                mentioned_users.append(u)
                mentions.append(uname)
            elif uemail and f"@{uemail.lower()}" in content_lower:
                mentioned_users.append(u)
                mentions.append(uemail)
            elif uemail and f"@{uemail.split('@')[0].lower()}" in content_lower:
                mentioned_users.append(u)
                mentions.append(uemail.split('@')[0])
    comment_doc = {
        "comment_id": comment_id, "order_id": order_id, "content": comment.content,
        "parent_id": comment.parent_id, "user_id": user["user_id"],
        "user_name": user["name"], "user_picture": user.get("picture"),
        "mentions": mentions,
        "created_at": datetime.now(timezone.utc).isoformat()
    }
    await db.comments.insert_one(comment_doc)
    await log_activity(user, "add_comment", {"order_id": order_id, "order_number": order.get("order_number"), "comment_id": comment_id})
    notif_docs = []
    if mentioned_users:
        for u in mentioned_users:
            uid = u.get("user_id", u.get("email"))
            notif_docs.append({
                "notification_id": f"notif_{uuid.uuid4().hex[:12]}", "user_id": uid, "type": "mention",
                "message": f"{user['name']} te menciono en orden {order.get('order_number', order_id)}",
                "order_id": order_id, "order_number": order.get("order_number"),
                "comment_id": comment_id,
                "sender_name": user.get("name"),
                "sender_picture": user.get("picture"),
                "read": False, "created_at": datetime.now(timezone.utc).isoformat()
            })
    if notif_docs:
        await db.notifications.insert_many(notif_docs)
    
    await ws_manager.broadcast("order_change", {"action": "add_comment", "order_id": order_id})
    return {**{k: v for k, v in comment_doc.items() if k not in ["_id", "reactions"]}, "reactions": {}}

@router.post("/seed-packing-link")
async def seed_packing_link(request: Request):
    """Siembra un enlace (etiqueta + URL) como comentario en varias ordenes a la
    vez, identificadas por su order_number (p.ej. la columna A de un packing list).
    - Deduplica los numeros de orden.
    - Omite las ordenes que ya tienen exactamente el mismo enlace sembrado
      (idempotente: correrlo dos veces no duplica el comentario).
    - Opcional `email_to`: manda el packing (Excel adjunto, descargado del enlace)
      a esos correos A NOMBRE de quien siembra (services/mailer.py). Se valida
      antes de sembrar; si el envío falla, la siembra no se pierde.
    body: { order_numbers: [str], label: str, url: str, email_to?: "a@x.com, b@y.com" }
    """
    from services.mailer import parse_recipients
    user = await require_auth(request)
    body = await request.json()
    raw_numbers = body.get("order_numbers") or []
    label = str(body.get("label") or "").strip()
    url = str(body.get("url") or "").strip()
    if not url:
        raise HTTPException(status_code=400, detail="El enlace (url) es obligatorio")
    if not isinstance(raw_numbers, list) or not raw_numbers:
        raise HTTPException(status_code=400, detail="Se requieren numeros de orden")
    email_to, bad_emails = parse_recipients(body.get("email_to"))
    if bad_emails:
        raise HTTPException(status_code=400, detail=f"Correo no válido: {', '.join(bad_emails)}")
    if len(email_to) > 50:
        raise HTTPException(status_code=400, detail="Máximo 50 destinatarios")

    # Normaliza + deduplica preservando el orden.
    seen, numbers = set(), []
    for n in raw_numbers:
        s = str(n).strip()
        if s and s not in seen:
            seen.add(s)
            numbers.append(s)

    # El enlace se guarda como [file]etiqueta|url[/file]: el modal de comentarios
    # ya lo renderiza como link clickeable (con icono de Excel si termina en .xlsx).
    display = label or url
    content = f"[file]{display}|{url}[/file]"
    now = datetime.now(timezone.utc).isoformat()

    seeded, not_found, skipped, duplicated = [], [], [], []
    # Órdenes cuyo camioncito se ENCIENDE ahora (pasan de sin packing_link a tenerlo),
    # para la notificación push resumen al final.
    newly_loaded = []
    for num in numbers:
        # TODAS las órdenes que respondan a ese número — hay order_number
        # duplicados en el CRM (censo 2026-07-23: 22 números, y en TODOS la
        # gemela extra vive en PAPELERA DE RECICLAJE: se duplicó la orden y la
        # copia vieja fue a la basura conservando su número). find_one sembraba
        # en la gemela de la papelera y la orden viva quedaba sin packing (caso
        # 2264). La papelera NO se siembra; el resto de matches, todas.
        matches = await db.orders.find(
            {"$or": [{"order_id": num}, {"order_number": num}]},
            {"_id": 0, "order_id": 1, "order_number": 1, "board": 1, "packing_link": 1},
        ).to_list(20)
        vivas = [o for o in matches if (o.get("board") or "").strip().upper() != "PAPELERA DE RECICLAJE"]
        if matches and not vivas:
            # Solo existe en la papelera: decirlo tal cual, no "no encontrada".
            not_found.append(f"{num} (en papelera)")
            continue
        matches = vivas
        if not matches:
            not_found.append(num)
            continue
        if len(matches) > 1:
            duplicated.append({"number": num, "orders": len(matches)})
        alguna_nueva = False
        for order in matches:
            oid = order["order_id"]
            # ¿El camioncito se enciende AHORA? (no tenía packing_link antes)
            if not order.get("packing_link"):
                newly_loaded.append(order.get("order_number") or num)
            # Marca la orden como "packing importado" para el indicador (camion)
            # en el CRM. Para toda orden encontrada, aunque el comentario exista.
            await db.orders.update_one({"order_id": oid}, {"$set": {
                "packing_link": url, "packing_link_label": label or None, "packing_link_at": now,
            }})
            if await db.comments.find_one({"order_id": oid, "content": content}, {"_id": 1}):
                continue
            cid = f"comment_{uuid.uuid4().hex[:12]}"
            await db.comments.insert_one({
                "comment_id": cid, "order_id": oid, "content": content, "parent_id": None,
                "user_id": user["user_id"], "user_name": user["name"],
                "user_picture": user.get("picture"), "mentions": [],
                "created_at": now, "source": "packing_link_seed",
            })
            await log_activity(user, "seed_packing_link", {
                "order_id": oid, "order_number": order.get("order_number"), "url": url, "label": label,
            })
            await ws_manager.broadcast("order_change", {"action": "add_comment", "order_id": oid})
            alguna_nueva = True
        (seeded if alguna_nueva else skipped).append(num)

    # Notificación push a los usuarios opt-in: se cargó el packing (camioncito) de
    # una o más órdenes. Un solo resumen por operación para no spamear (el packing
    # se siembra en lote). Fire-and-forget: nunca bloquea ni tumba la respuesta.
    if newly_loaded:
        try:
            recipients = await db.users.find(
                {"notify_packing_loaded": True}, {"_id": 0, "user_id": 1}
            ).to_list(200)
            recipient_ids = [r["user_id"] for r in recipients if r.get("user_id")]
            if recipient_ids:
                from services.push_notify import send_push_to_users
                n = len(newly_loaded)
                muestra = ", ".join(newly_loaded[:10]) + (f" +{n - 10} más" if n > 10 else "")
                if n == 1:
                    title = "📦 Packing cargado"
                    body = f"La orden {newly_loaded[0]} cargó su packing"
                else:
                    title = f"📦 Packing cargado ({n} órdenes)"
                    body = f"{n} órdenes cargaron su packing: {muestra}"
                asyncio.create_task(send_push_to_users(
                    db, recipient_ids, title, body, url="/", tag="packing-loaded"))
        except Exception:
            logger.exception("[packing] notificación push falló")

    email = await _email_seeded_packing(user, email_to, label, url, seeded + skipped) if email_to else None
    return {
        "total": len(numbers),
        "seeded": seeded, "seeded_count": len(seeded),
        "not_found": not_found, "not_found_count": len(not_found),
        "skipped_duplicate": skipped, "skipped_count": len(skipped),
        "duplicated_numbers": duplicated, "duplicated_count": len(duplicated),
        "email": email,
    }


async def _packing_email_context(label, orders):
    """Cliente (GTS/SKT), destino y fecha de embarque para el cuerpo del correo:
    de la etiqueta ('PL GTS 10-26-0090 SHIPPING 10-02-2026') y, si falta, de las
    órdenes y su renglón en el programador de envíos."""
    from collections import Counter
    from services.export_packing import client_code
    lab = (label or "").upper()
    m = re.search(r"\bPL\s*-?\s*([A-Z]{2,4})\b", lab)
    code = m.group(1) if m else None
    m = re.search(r"SHIPPING\s+(\d{1,2}-\d{1,2}-\d{4})", lab)
    shipped = m.group(1) if m else None
    docs = await db.orders.find({"order_number": {"$in": orders}, "board": {"$ne": "PAPELERA DE RECICLAJE"}},
                                {"_id": 0, "client": 1}).to_list(500)
    if not code:
        codes = Counter(client_code(d["client"]) for d in docs if d.get("client"))
        code = codes.most_common(1)[0][0] if codes else "GTS"
    lines = await db.scheduled_shipments.find(
        {"order_number": {"$in": orders}, "export_id": {"$exists": True}},
        {"_id": 0, "delivery_to": 1, "ship_date": 1}).sort("ship_date", -1).to_list(500)
    dest = Counter(str(x.get("delivery_to") or "").strip().upper() for x in lines if x.get("delivery_to"))
    dest = dest.most_common(1)[0][0] if dest else "ST ANDREWS"
    if not shipped:
        d = next((x["ship_date"] for x in lines if x.get("ship_date")), None) \
            or datetime.now(timezone.utc).date().isoformat()
        shipped = f"{d[5:7]}-{d[8:10]}-{d[0:4]}"
    return code, dest, shipped


async def _email_seeded_packing(user, to, label, url, orders):
    """Manda el packing sembrado (Excel adjunto si el enlace es descargable) a
    nombre de quien siembra, con el texto que usa Envíos ('Please find attached
    the Packing List for GTS- SAN DIEGO - ST ANDREWS, it shipped on 10-02-2026.').
    Devuelve el resultado para el modal; nunca lanza."""
    import html as _html
    from services.export_packing import download_xlsx
    from services.mailer import send_as_user
    name = re.sub(r'[\\/:*?"<>|]+', " ", label or "Packing list").strip() or "Packing list"
    data, err = await download_xlsx(url)
    code, dest, shipped = await _packing_email_context(label, orders)
    route = _html.escape(f"{code}- SAN DIEGO - {dest}")
    body = (
        "<p>Hi All,</p>"
        f"<p style=\"font-size:15px\">Please find attached the Packing List for <b><u>{route}</u></b>, "
        f"it shipped on <b>{_html.escape(shipped)}</b>.</p>"
        + ("" if data else
           f"<p>Packing List: <a href=\"{_html.escape(url, quote=True)}\">{_html.escape(label or url)}</a></p>"))
    res = await send_as_user(user, to, label or name, body,
                             attachments=[(f"{name}.xlsx", data)] if data else None)
    res.update({"to": to, "attached": bool(data), "attach_error": err})
    await log_activity(user, "send_packing_email", {
        "to": to, "label": label, "url": url, "orders": orders,
        "sent": res.get("sent"), "attached": bool(data), "error": res.get("error") or err})
    return res

@router.put("/{order_id}/comments/{comment_id}")
async def update_comment(order_id: str, comment_id: str, request: Request):
    user = await require_auth(request)
    body = await request.json()
    content = body.get("content", "").strip()
    if not content:
        raise HTTPException(status_code=400, detail="Content required")
    comment = await db.comments.find_one({"comment_id": comment_id, "order_id": order_id}, {"_id": 0})
    if not comment:
        raise HTTPException(status_code=404, detail="Comment not found")
    if comment.get("user_id") != user["user_id"] and user.get("role") not in ("admin", "supersu", "inspector_qc", "qc"):
        raise HTTPException(status_code=403, detail="Not allowed to edit this comment")
    await db.comments.update_one(
        {"comment_id": comment_id},
        {"$set": {"content": content, "edited_at": datetime.now(timezone.utc).isoformat()}}
    )
    await ws_manager.broadcast("order_change", {"action": "update_comment", "order_id": order_id})
    updated = await db.comments.find_one({"comment_id": comment_id}, {"_id": 0})
    return updated

@router.delete("/{order_id}/comments/{comment_id}")
async def delete_comment(order_id: str, comment_id: str, request: Request):
    user = await require_auth(request)
    comment = await db.comments.find_one({"comment_id": comment_id, "order_id": order_id}, {"_id": 0})
    if not comment:
        raise HTTPException(status_code=404, detail="Comment not found")
    if comment.get("user_id") != user["user_id"] and user.get("role") not in ("admin", "supersu", "inspector_qc", "qc"):
        raise HTTPException(status_code=403, detail="Not allowed to delete this comment")
    await db.comments.delete_one({"comment_id": comment_id})
    await ws_manager.broadcast("order_change", {"action": "delete_comment", "order_id": order_id})
    return {"message": "Comment deleted"}


# ==================== FILE UPLOAD (stored in MongoDB) ====================

@router.post("/{order_id}/images")
async def upload_attachment(order_id: str, request: Request):
    """Upload an attachment (image, pdf, excel, etc.) for an order."""
    user = await require_auth(request)
    body = await request.json()
    file_data = body.get("image_data") or body.get("file_data")
    filename = body.get("filename", f"file_{uuid.uuid4().hex[:8]}")
    if not file_data:
        raise HTTPException(status_code=400, detail="file_data required")
    order = await db.orders.find_one({"order_id": order_id}, {"_id": 0})
    if not order:
        raise HTTPException(status_code=404, detail="Order not found")
    try:
        # Extract pure base64 (remove data:...;base64, prefix)
        raw_b64 = file_data
        content_type = "application/octet-stream"
        if "," in raw_b64:
            header = raw_b64.split(",")[0]
            if ":" in header and ";" in header:
                content_type = header.split(":")[1].split(";")[0]
            raw_b64 = raw_b64.split(",")[1]
        # Validate it decodes
        file_bytes = base64.b64decode(raw_b64)
        
        # Save to disk instead of MongoDB data field
        unique_suffix = uuid.uuid4().hex[:8]
        storage_key = f"{order_id}_{unique_suffix}_{filename}"
        
        file_path = UPLOADS_DIR / storage_key
        with open(file_path, "wb") as f:
            f.write(file_bytes)

        # Store metadata only in MongoDB
        await db.file_uploads.insert_one({
            "storage_key": storage_key, "content_type": content_type,
            "order_id": order_id, "filename": filename, "uploaded_at": datetime.now(timezone.utc).isoformat()
        })
        
        backend_url = os.environ.get("BACKEND_PUBLIC_URL", "")
        file_url = f"{backend_url}/api/uploads/{storage_key}"
        # Update order's generic attachments/images list
        await db.orders.update_one({"order_id": order_id}, {"$push": {"images": {"filename": filename, "url": file_url, "uploaded_at": datetime.now(timezone.utc).isoformat()}}})
        await log_activity(user, "upload_attachment", {"order_id": order_id, "filename": filename, "type": content_type})
        return {"url": file_url, "filename": filename, "storage_key": storage_key, "content_type": content_type}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Upload failed: {str(e)}")


@router.post("/{order_id}/images/printavo")
async def traer_mocks_printavo(order_id: str, request: Request):
    """Trae los mockups del invoice de Printavo a las imagenes de la orden.

    En Printavo el mock vive en la impresion (imprint) de cada grupo de lineas:
    es la imagen que se ve en el invoice debajo de esas lineas. Se descarga y se
    guarda IGUAL que una imagen subida a mano (disco + order.images), asi la URL
    no depende de que Printavo la siga sirviendo. Idempotente: un mockup ya
    traido (printavo_mockup_id) no se repite. Solo imagenes: un PDF adjunto (p.ej.
    el PO escaneado que a veces se pega como mockup) no es el arte."""
    import httpx
    import printavo_client
    user = await require_auth(request)
    order = await db.orders.find_one({"order_id": order_id}, {"_id": 0, "printavo_invoice_id": 1, "images": 1})
    if not order:
        raise HTTPException(status_code=404, detail="Order not found")
    inv = order.get("printavo_invoice_id")
    if not inv:
        raise HTTPException(status_code=400, detail="Esta orden no viene de Printavo: no hay invoice del cual traer el mock")
    if not printavo_client.is_configured():
        raise HTTPException(status_code=400, detail="Credenciales de Printavo no configuradas")
    try:
        mockups = await printavo_client.fetch_invoice_mockups(inv)
    except Exception as e:
        logger.error(f"[mocks] Printavo {inv}: {e}")
        raise HTTPException(status_code=502, detail=f"Printavo no respondió: {str(e)[:200]}")

    ya = {img.get("printavo_mockup_id") for img in (order.get("images") or []) if img.get("printavo_mockup_id")}
    nuevas, omitidas = [], []
    backend_url = os.environ.get("BACKEND_PUBLIC_URL", "")
    async with httpx.AsyncClient(timeout=30.0, follow_redirects=True) as client:
        for n, m in enumerate(mockups, 1):
            if m["id"] in ya:
                continue
            if m["mime"] and not m["mime"].startswith("image/"):
                omitidas.append(f"{m['id']} ({m['mime']})")
                continue
            try:
                r = await client.get(m["url"])
                r.raise_for_status()
            except Exception as e:
                logger.warning(f"[mocks] no se pudo bajar el mockup {m['id']} de {inv}: {e}")
                omitidas.append(f"{m['id']} (no se pudo descargar)")
                continue
            ctype = (r.headers.get("content-type") or m["mime"] or "").split(";")[0].strip()
            if not ctype.startswith("image/"):
                omitidas.append(f"{m['id']} ({ctype or 'sin tipo'})")
                continue
            ext = {"image/jpeg": "jpg", "image/png": "png", "image/gif": "gif", "image/webp": "webp"}.get(ctype, "img")
            filename = f"printavo_mock_{n}.{ext}"
            storage_key = f"{order_id}_{uuid.uuid4().hex[:8]}_{filename}"
            with open(UPLOADS_DIR / storage_key, "wb") as f:
                f.write(r.content)
            await db.file_uploads.insert_one({
                "storage_key": storage_key, "content_type": ctype, "order_id": order_id,
                "filename": filename, "uploaded_at": datetime.now(timezone.utc).isoformat(),
                "source": "printavo", "printavo_mockup_id": m["id"]})
            nuevas.append({"filename": filename, "url": f"{backend_url}/api/uploads/{storage_key}",
                           "uploaded_at": datetime.now(timezone.utc).isoformat(),
                           "source": "printavo", "printavo_mockup_id": m["id"]})
    upd = {"$set": {"printavo_mocks_at": datetime.now(timezone.utc).isoformat()}}
    if nuevas:
        upd["$push"] = {"images": {"$each": nuevas}}
    await db.orders.update_one({"order_id": order_id}, upd)
    # `en_printavo` distingue "el invoice no tiene mocks" (0) de "ya estaban aqui".
    await log_activity(user, "printavo_mocks", {"order_id": order_id, "invoice": inv,
                                                 "en_printavo": len(mockups),
                                                 "traidas": len(nuevas), "omitidas": omitidas})
    final = await db.orders.find_one({"order_id": order_id}, {"_id": 0, "images": 1})
    return {"traidas": len(nuevas), "en_printavo": len(mockups), "omitidas": omitidas,
            "images": (final or {}).get("images") or []}


# ==================== EVIDENCIA DE SAMPLE (playerita) ====================
# Contenedor propio de la orden (`sample_evidence`), separado del `images`
# genérico, para que el modal de la playerita muestre SOLO la evidencia del
# sample (imagen + comentario). La guarda "Evidencia de sample" lo revisa.

@router.post("/{order_id}/sample-evidence")
async def add_sample_evidence(order_id: str, request: Request):
    """Agrega una evidencia de sample: imagen (base64) y/o comentario."""
    user = await require_auth(request)
    body = await request.json()
    file_data = body.get("image_data") or body.get("file_data")
    comment = (body.get("comment") or "").strip()
    filename = body.get("filename", f"sample_{uuid.uuid4().hex[:8]}")
    order = await db.orders.find_one({"order_id": order_id}, {"_id": 0, "order_number": 1})
    if not order:
        raise HTTPException(status_code=404, detail="Order not found")
    entry = {"comment": comment, "by": user.get("user_id"),
             "by_name": user.get("name") or user.get("email") or "",
             "at": datetime.now(timezone.utc).isoformat()}
    if file_data:
        try:
            raw_b64, content_type = file_data, "application/octet-stream"
            if "," in raw_b64:
                header = raw_b64.split(",")[0]
                if ":" in header and ";" in header:
                    content_type = header.split(":")[1].split(";")[0]
                raw_b64 = raw_b64.split(",")[1]
            file_bytes = base64.b64decode(raw_b64)
            storage_key = f"{order_id}_sev_{uuid.uuid4().hex[:8]}_{filename}"
            with open(UPLOADS_DIR / storage_key, "wb") as f:
                f.write(file_bytes)
            await db.file_uploads.insert_one({
                "storage_key": storage_key, "content_type": content_type, "order_id": order_id,
                "filename": filename, "kind": "sample_evidence", "uploaded_at": entry["at"]})
            backend_url = os.environ.get("BACKEND_PUBLIC_URL", "")
            entry["url"] = f"{backend_url}/api/uploads/{storage_key}"
            entry["storage_key"] = storage_key
            entry["content_type"] = content_type
        except Exception as e:
            raise HTTPException(status_code=500, detail=f"Upload failed: {str(e)}")
    if not (entry.get("url") or comment):
        raise HTTPException(status_code=400, detail="Se requiere una imagen o un comentario")
    await db.orders.update_one({"order_id": order_id}, {"$push": {"sample_evidence": entry}})
    await log_activity(user, "add_sample_evidence",
                       {"order_id": order_id, "order_number": order.get("order_number"),
                        "has_image": bool(entry.get("url"))})
    await ws_manager.broadcast("order_change", {"action": "update", "order_id": order_id})
    return {"ok": True, "entry": entry}


@router.get("/{order_id}/sample-evidence")
async def get_sample_evidence(order_id: str, request: Request):
    """Lista la evidencia de sample de la orden (para el modal de la playerita)."""
    await require_auth(request)
    order = await db.orders.find_one(
        {"order_id": order_id},
        {"_id": 0, "order_number": 1, "sample_printavo": 1, "sample_evidence": 1})
    if not order:
        raise HTTPException(status_code=404, detail="Order not found")
    return {"order_number": order.get("order_number"),
            "sample_printavo": order.get("sample_printavo"),
            "evidence": order.get("sample_evidence") or []}


# ==================== EXPORT ORDERS WITH COMMENTS & IMAGES ====================

@router.post("/export-pdf")
async def export_orders_pdf(request: Request):
    """Export selected orders with their comments and images to a professional PDF."""
    user = await require_auth(request)
    body = await request.json()
    order_ids = body.get("order_ids", [])
    if not order_ids:
        raise HTTPException(status_code=400, detail="No order_ids provided")

    output = io.BytesIO()
    doc = SimpleDocTemplate(output, pagesize=letter, leftMargin=50, rightMargin=50, topMargin=50, bottomMargin=50)
    styles = getSampleStyleSheet()
    
    # Custom styles
    title_style = styles['Title']
    h1_style = styles['Heading1']
    h2_style = styles['Heading2']
    normal_style = styles['Normal']
    
    comment_style = ParagraphStyle(
        'Comment',
        parent=styles['Normal'],
        fontSize=9,
        leading=11,
        leftIndent=20,
        spaceBefore=5,
        spaceAfter=5,
        textColor=colors.HexColor('#444444')
    )

    caption_style = ParagraphStyle(
        'Caption',
        parent=styles['Italic'],
        fontSize=7,
        leading=8,
        alignment=1, # Center
        textColor=colors.grey
    )

    elements = []
    
    # Add Logo/Header if exists? For now just text
    elements.append(Paragraph("MOS SYSTEM - REPORTE DE ÓRDENES", title_style))
    elements.append(Paragraph(f"Generado el: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}", normal_style))
    elements.append(Paragraph(f"Por: {user.get('name')}", normal_style))
    elements.append(Spacer(1, 0.5 * inch))

    def format_links(text):
        if not text or not isinstance(text, str): return text
        # Escape XML special chars first to prevent ReportLab crashes
        text = text.replace('&', '&amp;').replace('<', '&lt;').replace('>', '&gt;')
        url_pattern = r'(https?://[^\s<>"]+|www\.[^\s<>"]+)'
        def replace_url(match):
            url = match.group(0)
            href = url if url.startswith('http') else f'http://{url}'
            return f'<font color="blue"><u><a href="{href}">{url}</a></u></font>'
        return re.sub(url_pattern, replace_url, text)

    for idx, oid in enumerate(order_ids):
        order = await db.orders.find_one({"order_id": oid}, {"_id": 0})
        if not order:
            continue
            
        if idx > 0:
            elements.append(PageBreak())

        elements.append(Paragraph(f"Orden: {order.get('order_number', 'N/A')}", h1_style))
        
        # Summary Table - Values wrapped in Paragraph for link support
        order_data = [
            ["ID Interno", Paragraph(order.get("order_id", ""), normal_style)],
            ["PO Cliente", Paragraph(order.get("customer_po", ""), normal_style)],
            ["Store PO", Paragraph(order.get("store_po", ""), normal_style)],
            ["Cliente", Paragraph(order.get("client", ""), normal_style)],
            ["Branding", Paragraph(order.get("branding", ""), normal_style)],
            ["Prioridad", Paragraph(order.get("priority", ""), normal_style)],
            ["Cantidad", Paragraph(str(order.get("quantity", 0)), normal_style)],
            ["Fecha Entrega", Paragraph(order.get("due_date", ""), normal_style)],
            ["Estado Prod.", Paragraph(order.get("production_status", ""), normal_style)],
            ["Tablero Actual", Paragraph(order.get("board", ""), normal_style)]
        ]
        
        # Add non-standard fields to the table
        standard_keys = {
            "order_id", "order_number", "customer_po", "store_po", "client", "branding", 
            "priority", "quantity", "due_date", "production_status", "board", "created_at", 
            "updated_at", "images", "links", "comments", "cancel_date", "_id", "sizes", "style",
            "custom_fields"
        }
        for k, v in order.items():
            if k not in standard_keys and v is not None:
                val_str = str(v)
                order_data.append([f"Custom: {k}", Paragraph(format_links(val_str), normal_style)])

        t = Table(order_data, colWidths=[1.5 * inch, 4 * inch])
        t.setStyle(TableStyle([
            ('BACKGROUND', (0, 0), (0, -1), colors.HexColor('#f0f0f0')),
            ('GRID', (0, 0), (-1, -1), 0.5, colors.grey),
            ('FONTNAME', (0, 0), (0, -1), 'Helvetica-Bold'),
            ('VALIGN', (0, 0), (-1, -1), 'MIDDLE'),
            ('PADDING', (0, 0), (-1, -1), 6),
        ]))
        elements.append(t)
        elements.append(Spacer(1, 0.3 * inch))
        # Comments
        comments = await db.comments.find({"order_id": oid}, {"_id": 0}).sort("created_at", 1).to_list(100)
        if comments:
            elements.append(Paragraph("Comentarios", h2_style))
            for c in comments:
                ts = c.get("created_at", "")[:16].replace("T", " ")
                author = c.get("user_name", "Usuario")
                text = c.get("content", "")
                # Compact: Author and text in one paragraph
                elements.append(Paragraph(f"<b>{author}</b> <font color='grey' size='8'>({ts})</font>: {text}", comment_style))
            elements.append(Spacer(1, 0.2 * inch))

        # Images - Optimized to 2 per row
        image_docs = await db.file_uploads.find({"order_id": oid}, {"_id": 0}).to_list(100)
        if image_docs:
            elements.append(Paragraph("Imágenes Adjuntas", h2_style))
            img_grid = []
            current_row = []
            
            for img_doc in image_docs:
                try:
                    img_data = img_doc.get("data")
                    if not img_data: continue
                    
                    img_bytes = base64.b64decode(img_data)
                    img_io = io.BytesIO(img_bytes)
                    img = Image(img_io)
                    
                    # Resize for 2nd column grid
                    max_w = 2.6 * inch
                    iW, iH = img.imageWidth, img.imageHeight
                    aspect = iH / float(iW)
                    img.drawWidth = max_w
                    img.drawHeight = max_w * aspect
                    
                    # Wrap image and caption in a list for the table cell
                    cell_content = [img, Paragraph(img_doc.get("filename", "imagen")[:30], caption_style)]
                    current_row.append(cell_content)
                    
                    if len(current_row) == 2:
                        img_grid.append(current_row)
                        current_row = []
                except: continue
                
            if current_row:
                current_row.append("") # padding
                img_grid.append(current_row)
                
            if img_grid:
                img_table = Table(img_grid, colWidths=[2.8 * inch, 2.8 * inch])
                img_table.setStyle(TableStyle([
                    ('VALIGN', (0,0), (-1,-1), 'TOP'),
                    ('ALIGN', (0,0), (-1,-1), 'CENTER'),
                    ('BOTTOMPADDING', (0,0), (-1,-1), 12),
                ]))
                elements.append(img_table)

    doc.build(elements)
    output.seek(0)
    data_b64 = base64.b64encode(output.read()).decode()
    
    await log_activity(user, "export_orders_pdf", {"order_count": len(order_ids)})
    
    return {
        "filename": f"reporte_ordenes_{datetime.now().strftime('%Y%m%d_%H%M%S')}.pdf",
        "data": data_b64,
        "content_type": "application/pdf"
    }

@router.post("/export-complete")
async def export_orders_complete(request: Request):
    """Export selected orders with their comments and images (base64)."""
    user = await require_auth(request)
    body = await request.json()
    order_ids = body.get("order_ids", [])
    include_comments = body.get("include_comments", True)
    include_images = body.get("include_images", True)
    if not order_ids:
        raise HTTPException(status_code=400, detail="order_ids required")

    result = []
    for oid in order_ids:
        order = await db.orders.find_one({"order_id": oid}, {"_id": 0})
        if not order:
            continue
        entry = {**order}
        if include_comments:
            comments = await db.comments.find({"order_id": oid}, {"_id": 0}).sort("created_at", 1).to_list(500)
            entry["_comments"] = comments
        if include_images:
            # Get image files from file_uploads collection
            image_docs = []
            async for doc in db.file_uploads.find({"order_id": oid}, {"_id": 0}):
                image_docs.append(doc)
            entry["_image_files"] = image_docs
        result.append(entry)

    return {"total": len(result), "orders": result}

@router.post("/import-complete")
async def import_orders_complete(request: Request):
    """Import orders with their comments and images."""
    user = await require_auth(request)
    if user.get("role") not in ("admin", "supersu", "inspector_qc", "qc"):
        raise HTTPException(status_code=403, detail="Admin only")
    body = await request.json()
    orders_data = body.get("orders", [])
    update_existing = body.get("update_existing", False)
    stats = {"orders": 0, "comments": 0, "images": 0, "skipped_orders": 0, "updated_orders": 0}

    for entry in orders_data:
        oid = entry.get("order_id")
        if not oid:
            continue
        comments = entry.pop("_comments", [])
        image_files = entry.pop("_image_files", [])

        # Cleanup entry before sync/insert
        clean_entry = {k: v for k, v in entry.items() if k != "_id"}

        # Upsert order logic
        existing = await db.orders.find_one({"order_id": oid})
        if existing:
            if update_existing:
                # Sync all fields except protected ones to ensure flat custom fields are included
                exclude_fields = {"_id", "order_id", "created_at", "updated_at", "_comments", "_image_files"}
                update_doc = {k: v for k, v in clean_entry.items() if k not in exclude_fields}

                update_doc["updated_at"] = datetime.now(timezone.utc).isoformat()
                
                await db.orders.update_one({"order_id": oid}, {"$set": update_doc})
                stats["updated_orders"] += 1
            else:
                stats["skipped_orders"] += 1
        else:
            await db.orders.insert_one(clean_entry)
            stats["orders"] += 1

        # Import comments
        for c in comments:
            cid = c.get("comment_id")
            if cid:
                exists = await db.comments.find_one({"comment_id": cid})
                if not exists:
                    await db.comments.insert_one({k: v for k, v in c.items() if k != "_id"})
                    stats["comments"] += 1

        # Import images
        for img in image_files:
            key = img.get("storage_key")
            if key:
                exists = await db.file_uploads.find_one({"storage_key": key})
                if not exists:
                    await db.file_uploads.insert_one({k: v for k, v in img.items() if k != "_id"})
                    stats["images"] += 1

    return stats

@router.post("/import-excel")
async def import_orders_excel(
    request: Request,
    file: UploadFile = File(...),
    update_existing: bool = False,
    column_mapping: Optional[str] = Form(None)
):
    """Import orders from an Excel file (.xlsx, .xls) with optional column mapping."""
    user = await require_auth(request)
    if user.get("role") not in ("admin", "supersu", "inspector_qc", "qc"):
        raise HTTPException(status_code=403, detail="Solo los administradores pueden importar Excel")

    try:
        content = await file.read()
        df = pd.read_excel(io.BytesIO(content))
        
        # Definir campos conocidos (base) para separar de los personalizados
        KNOWN_FIELDS = {
            "order_number", "customer_po", "store_po", "client", "branding", 
            "priority", "quantity", "due_date", "cancel_date", "notes", "color",
            "design_#", "board", "blank_status", "production_status",
            "trim_status", "trim_box", "sample", "artwork_status", "betty_column",
            "job_title_a", "job_title_b", "shipping", "final_bill"
        }

        # User defined mapping (if provided)
        user_mapping = {}
        if column_mapping:
            try:
                user_mapping = json.loads(column_mapping)
                # No pasamos a minúsculas las llaves (internal_col) para preservar la integridad de campos personalizados
            except Exception as e:
                logger.error(f"Error parsing column_mapping: {e}")

        # Default mapping from common names to internal field names
        default_mapping = {
            "order #": "order_number",
            "order_number": "order_number",
            "order number": "order_number",
            "po #": "customer_po",
            "po": "customer_po",
            "customer po": "customer_po",
            "store po": "store_po",
            "store #": "store_po",
            "client": "client",
            "branding": "branding",
            "priority": "priority",
            "qty": "quantity",
            "quantity": "quantity",
            "notes": "notes",
            "color": "color",
            "due date": "due_date",
            "cancel date": "cancel_date",
            "design #": "design_#",
            "design_#": "design_#",
            "board": "board"
        }

        # Normalize Excel columns for matching (lowercase)
        excel_cols_lower = {str(c).strip().lower(): str(c) for c in df.columns}
        
        # Build actual mapping: Excel Column Name (original) -> Internal Field Key
        actual_mapping = {}
        
        # 1. Process user defined mapping
        for internal_key, excel_col_name in user_mapping.items():
            if not excel_col_name:
                continue
            # Buscamos el nombre original de la columna en el Excel (ignorando mayúsculas en el match)
            match_name = excel_cols_lower.get(str(excel_col_name).strip().lower())
            if match_name:
                actual_mapping[match_name] = internal_key

        # 2. Fill missing with defaults if they exist in Excel
        for lower_name, internal_key in default_mapping.items():
            if internal_key not in actual_mapping.values():
                match_name = excel_cols_lower.get(lower_name)
                if match_name:
                    actual_mapping[match_name] = internal_key

        logger.info(f"Excel Import Mapping: {actual_mapping}")

        # Final check: at least order_number must be mapped
        if not any(v == "order_number" for v in actual_mapping.values()):
            raise HTTPException(status_code=400, detail="El archivo Excel debe contener una columna para el número de orden (ej: 'Order #') o debe haber sido mapeada.")

        stats = {"total_rows": len(df), "created": 0, "updated": 0, "skipped": 0, "errors": 0}
        
        for index, row in df.iterrows():
            try:
                # Build order data from row
                order_data = {}
                
                for excel_col, internal_key in actual_mapping.items():
                    val = row[excel_col]
                    
                    # Handle nulls
                    if pd.isna(val) or str(val).strip().lower() == "nan":
                        val = None
                    
                    # Handle date conversion to YYYY-MM-DD
                    if internal_key in ["due_date", "cancel_date", "final_bill"] and val:
                        if hasattr(val, "strftime"):
                            val = val.strftime("%Y-%m-%d")
                        elif isinstance(val, str):
                            # Try to clean up string dates
                            val = val.split(' ')[0]

                    # Map to correct structure (FLATTENED)
                    if internal_key == "quantity":
                        try:
                            order_data["quantity"] = int(float(val)) if val is not None else 0
                        except:
                            order_data["quantity"] = 0
                    elif internal_key == "order_number":
                        # CRITICAL: Handle float order numbers (e.g., 101.0 -> "101")
                        if val is not None:
                            try:
                                f_val = float(val)
                                if f_val == int(f_val):
                                    order_data["order_number"] = str(int(f_val))
                                else:
                                    order_data["order_number"] = str(val).strip()
                            except:
                                order_data["order_number"] = str(val).strip()
                        else:
                            order_data["order_number"] = None
                    else:
                        order_data[internal_key] = str(val).strip() if val is not None else None

                # 3. Add ALL other columns as custom fields at root (Dynamic detection)
                excluded_cols = set(actual_mapping.keys())
                for col in df.columns:
                    if col not in excluded_cols:
                        val = row[col]
                        if not pd.isna(val) and str(val).strip().lower() != "nan":
                            clean_key = str(col).strip().replace(" ", "_").lower()
                            if clean_key not in order_data:
                                order_data[clean_key] = str(val).strip()

                order_num = order_data.get("order_number")
                if not order_num or not str(order_num).strip():
                    stats["skipped"] += 1
                    continue

                order_num = str(order_num).strip()

                # Check if it exists
                existing = await db.orders.find_one({"order_number": order_num})
                
                if existing:
                    if update_existing:
                        # Update order
                        oid = existing["order_id"]
                        # Job Title A/B: el import masivo no puede pisar un enlace
                        # ya capturado (misma regla que la edición de celda) —
                        # salvo que quien importa sea supersu.
                        if user.get("role") != "supersu":
                            for _f in _JOB_TITLE_PROTECTED:
                                if _f in order_data and any(_link_canon(existing.get(_f))):
                                    order_data.pop(_f)
                        order_data["updated_at"] = datetime.now(timezone.utc).isoformat()
                        await db.orders.update_one({"order_id": oid}, {"$set": order_data})
                        stats["updated"] += 1
                    else:
                        stats["skipped"] += 1
                else:
                    # Create new order
                    order_id = f"ord_{uuid.uuid4().hex[:12]}"
                    if not order_data.get("board"):
                        order_data["board"] = "SCHEDULING"
                    
                    full_doc = {
                        **order_data,
                        "order_id": order_id,
                        "created_at": datetime.now(timezone.utc).isoformat(),
                        "updated_at": datetime.now(timezone.utc).isoformat()
                    }
                    await db.orders.insert_one(full_doc)
                    stats["created"] += 1
                    await log_activity(user, "create_order_excel", {"order_id": order_id, "order_number": order_num})

            except Exception as e:
                logger.error(f"Error importing row {index} in excel: {e}")
                stats["errors"] += 1

        # Broadcast sync
        if stats["created"] > 0 or stats["updated"] > 0:
            await ws_manager.broadcast("order_change", {"action": "excel_import"})
            await _notify_all(user, "import", f"{user['name']} importó {stats['created']} órdenes nuevas y actualizó {stats['updated']}")

        return stats

    except Exception as e:
        logger.error(f"Excel import error: {e}")
        if isinstance(e, HTTPException):
            raise e
        raise HTTPException(status_code=500, detail=f"Error al procesar el archivo Excel: {str(e)}")
