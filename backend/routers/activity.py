"""Activity log, notifications, undo routes."""
from fastapi import APIRouter, HTTPException, Request
from deps import db, require_auth, require_admin, log_activity, logger
from datetime import datetime, timezone

router = APIRouter(prefix="/api")
from fastapi.responses import Response, FileResponse
from deps import db, require_auth, require_admin, log_activity, logger
from pathlib import Path
import base64

UPLOADS_DIR = Path("uploads") / "invoices"
UPLOADS_DIR.mkdir(parents=True, exist_ok=True)

@router.get("/notifications")
async def get_notifications(request: Request, limit: int = 50):
    user = await require_auth(request)
    user_id = user.get("user_id", user.get("email"))
    notifs = await db.notifications.find({"user_id": user_id}, {"_id": 0}).sort("created_at", -1).limit(limit).to_list(limit)
    unread_count = await db.notifications.count_documents({"user_id": user_id, "read": False})
    return {"notifications": notifs, "unread_count": unread_count}

@router.put("/notifications/read")
async def mark_notifications_read(request: Request):
    user = await require_auth(request)
    user_id = user.get("user_id", user.get("email"))
    await db.notifications.update_many({"user_id": user_id, "read": False}, {"$set": {"read": True}})
    return {"message": "All notifications marked as read"}

@router.put("/notifications/{notification_id}/read")
async def mark_notification_read(notification_id: str, request: Request):
    user = await require_auth(request)
    user_id = user.get("user_id", user.get("email"))
    result = await db.notifications.update_one(
        {"notification_id": notification_id, "user_id": user_id}, 
        {"$set": {"read": True}}
    )
    if result.modified_count == 0:
        raise HTTPException(status_code=404, detail="Notification not found")
    return {"message": "Notification marked as read"}

async def _ids_de_la_busqueda(search: str) -> list:
    """order_id de las órdenes que casan con el término buscado.

    Hace falta porque los movimientos EN LOTE no guardan el número de orden en
    ningún lado: `bulk_move_orders` deja los IDs en `previous_data.order_ids` y
    en `details` solo el conteo. Buscar "2653" no encontraba nada aunque la
    orden se hubiera movido tres veces. Se traduce número → id para poder
    buscar dentro del lote.
    """
    rx = {"$regex": search, "$options": "i"}
    docs = await db.orders.find(
        {"$or": [{"order_number": rx}, {"order_id": search}]}, {"_id": 0, "order_id": 1}
    ).limit(50).to_list(50)
    return [d["order_id"] for d in docs if d.get("order_id")]


async def _detallar_lotes(logs: list, resaltar: list = None) -> None:
    """Rellena los movimientos en lote con datos legibles, EN SITIO.

    Un `bulk_move_orders` guardado solo dice "38 órdenes → BLANKS": ni qué
    órdenes, ni de dónde salieron. Los dos datos que faltan sí están en el
    registro (`previous_data.original_boards` es {order_id: tablero_origen}),
    pero en IDs que nadie reconoce.

    Aquí se resuelven a números de orden y se arma `details.moves` con el
    origen y el destino de CADA orden. No se toca lo guardado: `previous_data`
    es de lo que vive el undo, y reescribir el histórico para una mejora de
    lectura sería cambiar la evidencia. Se calcula al leer.

    Una sola consulta para toda la página, no una por evento: son hasta 200
    registros y varios miles de órdenes entre todos.
    """
    lotes = [l for l in logs if l.get("action") == "bulk_move_orders"]
    if not lotes:
        return

    ids = {oid for l in lotes
           for oid in ((l.get("previous_data") or {}).get("order_ids") or [])}
    if not ids:
        return

    numeros = {}
    for d in await db.orders.find({"order_id": {"$in": list(ids)}},
                                  {"_id": 0, "order_id": 1, "order_number": 1}).to_list(len(ids)):
        numeros[d["order_id"]] = d.get("order_number") or d["order_id"]

    foco = set(resaltar or [])
    for l in lotes:
        prev = l.get("previous_data") or {}
        origenes = prev.get("original_boards") or {}
        destino = (l.get("details") or {}).get("target_board")
        movs = []
        for oid in (prev.get("order_ids") or []):
            movs.append({
                "order_id": oid,
                # Una orden borrada de verdad ya no tiene número: se deja el id
                # para no perder el renglón del historial.
                "order_number": numeros.get(oid, oid),
                "from_board": origenes.get(oid),
                "to_board": destino,
            })
        l.setdefault("details", {})["moves"] = movs
        # Cuando se buscó una orden concreta, se marca cuál es: sin esto el
        # renglón de un lote de 38 no dice qué le pasó a la que se preguntó.
        if foco:
            l["details"]["focus"] = [m for m in movs if m["order_id"] in foco]


@router.get("/activity")
async def get_activity_logs(request: Request, limit: int = 200, offset: int = 0, action_filter: str = None, search: str = None):
    await require_admin(request)
    query = {}
    if action_filter:
        query["action"] = action_filter

    ids_buscados = []
    if search:
        search_regex = {"$regex": search, "$options": "i"}
        # Some details might be stored as order_id or just deep within details
        clauses = [
            {"details.order_id": search_regex},
            {"details.order_number": search_regex},
            {"details.order": search_regex},
            {"details.customer": search_regex},
            {"user_email": search_regex},
            {"user_name": search_regex},
            {"action": search_regex}
        ]
        # Movimientos en lote: el ID va dentro de un arreglo, y el número de
        # orden no está en el registro. Se traduce antes de consultar.
        ids_buscados = await _ids_de_la_busqueda(search)
        if ids_buscados:
            clauses.append({"previous_data.order_ids": {"$in": ids_buscados}})
        # Los lotes NUEVOS guardan los números directo; así una orden que ya se
        # borró de `orders` — y que por eso no resuelve arriba — se sigue
        # encontrando en los movimientos donde estuvo.
        clauses.append({"details.order_numbers": search_regex})
        query["$or"] = clauses

    total = await db.activity_logs.count_documents(query)
    logs = await db.activity_logs.find(query, {"_id": 0}).sort("timestamp", -1).skip(offset).limit(limit).to_list(limit)
    await _detallar_lotes(logs, ids_buscados)
    return {"total": total, "logs": logs, "limit": limit, "offset": offset}

@router.post("/undo/{activity_id}")
async def undo_action(activity_id: str, request: Request):
    user = await require_admin(request)
    log_entry = await db.activity_logs.find_one({"activity_id": activity_id}, {"_id": 0})
    if not log_entry:
        raise HTTPException(status_code=404, detail="Activity not found")
    if not log_entry.get("undoable"):
        raise HTTPException(status_code=400, detail="This action cannot be undone")
    if log_entry.get("undone"):
        raise HTTPException(status_code=400, detail="This action has already been undone")
    prev = log_entry.get("previous_data", {})
    action = log_entry.get("action")
    try:
        if action == "update_order":
            order_id = prev.get("order_id")
            fields = prev.get("fields", {})
            if order_id and fields:
                fields["updated_at"] = datetime.now(timezone.utc).isoformat()
                await db.orders.update_one({"order_id": order_id}, {"$set": fields})
        elif action == "move_order":
            order_id = prev.get("order_id")
            fields = prev.get("fields", {})
            if order_id and "board" in fields:
                await db.orders.update_one({"order_id": order_id}, {"$set": {"board": fields["board"], "updated_at": datetime.now(timezone.utc).isoformat()}})
        elif action == "delete_order":
            order_id = prev.get("order_id")
            fields = prev.get("fields", {})
            original_board = fields.get("board", "SCHEDULING")
            if order_id:
                await db.orders.update_one({"order_id": order_id}, {"$set": {"board": original_board, "updated_at": datetime.now(timezone.utc).isoformat()}})
        elif action == "create_order":
            order_id = prev.get("order_id")
            if order_id:
                await db.orders.update_one({"order_id": order_id}, {"$set": {"board": "PAPELERA DE RECICLAJE", "updated_at": datetime.now(timezone.utc).isoformat()}})
        elif action == "bulk_move_orders":
            original_boards = prev.get("original_boards", {})
            for oid, board in original_boards.items():
                await db.orders.update_one({"order_id": oid}, {"$set": {"board": board, "updated_at": datetime.now(timezone.utc).isoformat()}})
        else:
            raise HTTPException(status_code=400, detail=f"Undo not supported for action: {action}")
        await db.activity_logs.update_one({"activity_id": activity_id}, {"$set": {"undone": True}})
        await log_activity(user, "undo_action", {"undone_activity_id": activity_id, "undone_action": action, "details": log_entry.get("details", {})})
        return {"message": "Action undone successfully", "undone_action": action}
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Undo error: {e}")
        raise HTTPException(status_code=500, detail=f"Failed to undo: {str(e)}")

@router.get("/uploads/{filename:path}")
async def get_uploaded_file(filename: str):
    """Retrieve an uploaded file from MongoDB (legacy base64) or disk by filename."""
    # Try MongoDB first
    doc = await db.file_uploads.find_one({"storage_key": filename}, {"_id": 0})
    
    if doc and "data" in doc and doc["data"]:
        # Legacy Base64 image still in DB
        image_bytes = base64.b64decode(doc["data"])
        return Response(content=image_bytes, media_type=doc.get("content_type", "image/png"))
    
    # Fallback to disk (for migrated DB files or standard local uploads)
    file_path = UPLOADS_DIR / filename
    if file_path.exists():
        return FileResponse(file_path)
    
    raise HTTPException(status_code=404, detail="File not found")
