"""Config routes: options, colors, columns, boards, saved views."""
from fastapi import APIRouter, HTTPException, Request
from deps import db, require_auth, require_admin, log_activity, OptionUpdate, DEFAULT_OPTIONS, BOARDS, get_dynamic_boards, save_boards
from datetime import datetime, timezone
import uuid

router = APIRouter(prefix="/api/config")

@router.get("/options")
async def get_options(request: Request):
    boards = await get_dynamic_boards()
    stored_options = await db.config_options.find_one({"config_id": "main"}, {"_id": 0})
    
    options = {**DEFAULT_OPTIONS, "boards": boards}
    
    if stored_options:
        for key, value in stored_options.items():
            if key != "config_id" and isinstance(value, list):
                options[key] = value
                
    return options

@router.put("/options")
async def update_options(option_update: OptionUpdate, request: Request):
    user = await require_admin(request)
    await db.config_options.update_one({"config_id": "main"}, {"$set": {option_update.option_key: option_update.values}}, upsert=True)
    await log_activity(user, "update_options", {"option_key": option_update.option_key, "values_count": len(option_update.values)})
    return {"message": "Options updated", "key": option_update.option_key}

@router.get("/boards")
async def get_boards(request: Request):
    boards = await get_dynamic_boards()
    return {"boards": boards}

@router.post("/boards")
async def create_board(request: Request):
    await require_admin(request)
    body = await request.json()
    name = (body.get("name") or "").strip().upper()
    if not name:
        raise HTTPException(status_code=400, detail="Board name required")
    boards = await get_dynamic_boards()
    if name in boards:
        raise HTTPException(status_code=400, detail="Board already exists")
    boards.append(name)
    await save_boards(boards)
    return {"boards": boards, "created": name}

@router.delete("/boards/{board_name}")
async def delete_board(request: Request, board_name: str):
    await require_admin(request)
    if board_name in ("MASTER", "COMPLETOS", "PAPELERA DE RECICLAJE"):
        raise HTTPException(status_code=400, detail="Cannot delete system board")
    boards = await get_dynamic_boards()
    if board_name not in boards:
        raise HTTPException(status_code=404, detail="Board not found")
    # Move orders from deleted board to MASTER
    await db.orders.update_many({"board": board_name}, {"$set": {"board": "MASTER"}})
    boards.remove(board_name)
    await save_boards(boards)
    return {"boards": boards, "deleted": board_name}

@router.get("/columns")
async def get_column_config(request: Request):
    await require_auth(request)
    stored = await db.column_config.find_one({"config_id": "columns"}, {"_id": 0, "config_id": 0})
    return stored or {"custom_columns": []}

@router.put("/columns")
async def update_column_config(request: Request):
    await require_admin(request)
    body = await request.json()
    update_data = {"config_id": "columns", "custom_columns": body.get("custom_columns", [])}
    if "removed_default_columns" in body:
        update_data["removed_default_columns"] = body["removed_default_columns"]
    await db.column_config.update_one({"config_id": "columns"}, {"$set": update_data}, upsert=True)
    return {"message": "Columns updated"}

@router.get("/colors")
async def get_colors(request: Request):
    await require_auth(request)
    stored = await db.config_colors.find_one({"config_id": "colors"}, {"_id": 0, "config_id": 0})
    return stored or {}

@router.put("/colors")
async def update_colors(request: Request):
    user = await require_admin(request)
    body = await request.json()
    await db.config_colors.update_one({"config_id": "colors"}, {"$set": {**body, "config_id": "colors"}}, upsert=True)
    await log_activity(user, "update_colors", {"count": len(body)})
    return {"message": "Colors updated"}

@router.get("/descriptions")
async def get_descriptions(request: Request):
    await require_auth(request)
    stored = await db.config_descriptions.find_one({"config_id": "descriptions"}, {"_id": 0, "config_id": 0})
    return stored or {}

@router.put("/descriptions")
async def update_descriptions(request: Request):
    user = await require_admin(request)
    body = await request.json()
    await db.config_descriptions.update_one({"config_id": "descriptions"}, {"$set": {**body, "config_id": "descriptions"}}, upsert=True)
    return {"message": "Descriptions updated"}

@router.get("/groups")
async def get_groups(request: Request):
    await require_auth(request)
    stored = await db.config_groups.find_one({"config_id": "groups"}, {"_id": 0, "config_id": 0})
    return stored or {}

@router.put("/groups")
async def update_groups(request: Request):
    user = await require_admin(request)
    body = await request.json()
    await db.config_groups.update_one({"config_id": "groups"}, {"$set": {**body, "config_id": "groups"}}, upsert=True)
    return {"message": "Groups updated"}

# ==================== SAVED VIEWS ====================

@router.get("/user-view-config/{board}")
async def get_user_view_config(board: str, request: Request):
    user = await require_auth(request)
    user_id = user.get("user_id", user.get("email"))
    config = await db.user_view_config.find_one({"user_id": user_id, "board": board}, {"_id": 0})
    return config or {}

@router.put("/user-view-config/{board}")
async def save_user_view_config(board: str, request: Request):
    user = await require_auth(request)
    user_id = user.get("user_id", user.get("email"))
    body = await request.json()
    await db.user_view_config.update_one(
        {"user_id": user_id, "board": board},
        {"$set": {
            "user_id": user_id, "board": board,
            "filters": body.get("filters", {}),
            "hidden_columns": body.get("hidden_columns", []),
            "column_order": body.get("column_order", []),
            "group_by_date": body.get("group_by_date", None),
            "updated_at": datetime.now(timezone.utc).isoformat()
        }},
        upsert=True
    )
    return {"message": "View config saved"}

@router.get("/hidden-boards")
async def get_hidden_boards(request: Request):
    await require_auth(request)
    config = await db.board_config.find_one({"config_id": "hidden_boards"}, {"_id": 0})
    return config.get("boards", []) if config else []

@router.put("/hidden-boards")
async def save_hidden_boards(request: Request):
    await require_admin(request)
    body = await request.json()
    await db.board_config.update_one(
        {"config_id": "hidden_boards"},
        {"$set": {"config_id": "hidden_boards", "boards": body.get("boards", [])}},
        upsert=True
    )
    return {"message": "Hidden boards saved"}

@router.get("/form-fields")
async def get_form_fields(request: Request):
    await require_auth(request)
    config = await db.form_fields_config.find_one({"config_id": "main"}, {"_id": 0})
    return config or {}

@router.put("/form-fields")
async def save_form_fields(request: Request):
    await require_admin(request)
    body = await request.json()
    await db.form_fields_config.update_one(
        {"config_id": "main"},
        {"$set": {"config_id": "main", "fields": body.get("fields", []), "updated_at": datetime.now(timezone.utc).isoformat()}},
        upsert=True
    )
    return {"message": "Form fields saved"}

@router.get("/home-layout")
async def get_home_layout(request: Request):
    await require_auth(request)
    config = await db.config_home_layout.find_one({"config_id": "global"}, {"_id": 0})
    return config or {}

@router.put("/home-layout")
async def save_home_layout(request: Request):
    await require_admin(request)
    body = await request.json()
    await db.config_home_layout.update_one(
        {"config_id": "global"},
        {"$set": {"config_id": "global", "layout": body.get("layout", []), "updated_at": datetime.now(timezone.utc).isoformat()}},
        upsert=True
    )
    return {"message": "Home layout saved"}

@router.get("/board-layout/{board_name}")
async def get_board_layout(board_name: str, request: Request):
    user = await require_auth(request)
    user_id = user.get("user_id", user.get("email"))
    # Try user-specific layout first, fallback to global
    layout = await db.user_board_layouts.find_one({"user_id": user_id, "board": board_name}, {"_id": 0})
    if not layout:
        layout = await db.board_layouts.find_one({"board": board_name}, {"_id": 0})
    return layout or {}

@router.put("/board-layout/{board_name}")
async def save_board_layout(board_name: str, request: Request):
    user = await require_auth(request)
    user_id = user.get("user_id", user.get("email"))
    body = await request.json()
    await db.user_board_layouts.update_one(
        {"user_id": user_id, "board": board_name},
        {"$set": {
            "user_id": user_id,
            "board": board_name,
            "column_order": body.get("column_order", []),
            "hidden_columns": body.get("hidden_columns", []),
            "updated_at": datetime.now(timezone.utc).isoformat()
        }},
        upsert=True
    )
    return {"message": "Board layout saved"}

@router.get("/saved-views")
async def get_saved_views(request: Request):
    user = await require_auth(request)
    user_id = user.get("user_id", user.get("email"))
    views = await db.saved_views.find({"user_id": user_id}, {"_id": 0}).to_list(100)
    return views

@router.post("/saved-views")
async def create_saved_view(request: Request):
    user = await require_auth(request)
    user_id = user.get("user_id", user.get("email"))
    body = await request.json()
    view_doc = {
        "view_id": f"view_{uuid.uuid4().hex[:12]}", "user_id": user_id,
        "name": body.get("name", "Sin nombre"), "board": body.get("board", "MASTER"),
        "filters": body.get("filters", {}), "pinned": body.get("pinned", False),
        "hidden_columns": body.get("hidden_columns", []),
        "column_order": body.get("column_order", []),
        "group_by_date": body.get("group_by_date", None),
        "created_at": datetime.now(timezone.utc).isoformat()
    }
    await db.saved_views.insert_one(view_doc)
    return {k: v for k, v in view_doc.items() if k != "_id"}

@router.put("/saved-views/{view_id}")
async def update_saved_view(view_id: str, request: Request):
    user = await require_auth(request)
    user_id = user.get("user_id", user.get("email"))
    body = await request.json()
    update_data = {}
    if "pinned" in body:
        update_data["pinned"] = body["pinned"]
    if "name" in body:
        update_data["name"] = body["name"]
    if "filters" in body:
        update_data["filters"] = body["filters"]
    if "hidden_columns" in body:
        update_data["hidden_columns"] = body["hidden_columns"]
    if "column_order" in body:
        update_data["column_order"] = body["column_order"]
    if "group_by_date" in body:
        update_data["group_by_date"] = body["group_by_date"]
    await db.saved_views.update_one({"view_id": view_id, "user_id": user_id}, {"$set": update_data})
    return {"message": "View updated"}

@router.delete("/saved-views/{view_id}")
async def delete_saved_view(view_id: str, request: Request):
    user = await require_auth(request)
    user_id = user.get("user_id", user.get("email"))
    await db.saved_views.delete_one({"view_id": view_id, "user_id": user_id})
    return {"message": "View deleted"}
    
# ==================== IMPORT MAPPING PERSISTENCE ====================

@router.get("/import-mapping")
async def get_import_mapping(request: Request):
    """Retrieve the last used import mapping for the current user."""
    user = await require_auth(request)
    user_id = user.get("user_id", user.get("email"))
    mapping = await db.user_import_mappings.find_one({"user_id": user_id}, {"_id": 0})
    return mapping.get("mapping", {}) if mapping else {}

@router.put("/import-mapping")
async def save_import_mapping(request: Request):
    """Save the current import mapping for the user."""
    user = await require_auth(request)
    user_id = user.get("user_id", user.get("email"))
    body = await request.json()
    mapping = body.get("mapping", {})
    await db.user_import_mappings.update_one(
        {"user_id": user_id},
        {"$set": {
            "user_id": user_id,
            "mapping": mapping,
            "updated_at": datetime.now(timezone.utc).isoformat()
        }},
        upsert=True
    )
    return {"message": "Import mapping saved"}

# ==================== IMAGE EXPORT/IMPORT ====================


@router.get("/admin/images-stats")
async def images_stats(request: Request):
    user = await require_auth(request)
    if user.get("role") != "admin":
        raise HTTPException(status_code=403, detail="Admin only")
    total = await db.file_uploads.count_documents({})
    batch_size = 10
    total_batches = (total + batch_size - 1) // batch_size if total > 0 else 0
    return {"total_images": total, "batch_size": batch_size, "total_batches": total_batches}

@router.get("/admin/export-images/{batch_num}")
async def export_images_batch(batch_num: int, request: Request):
    user = await require_auth(request)
    if user.get("role") != "admin":
        raise HTTPException(status_code=403, detail="Admin only")
    batch_size = 10
    skip = batch_num * batch_size
    docs = await db.file_uploads.find({}, {"_id": 0}).skip(skip).limit(batch_size).to_list(batch_size)
    return {"batch": batch_num, "count": len(docs), "images": docs}

@router.post("/admin/import-images")
async def import_images(request: Request):
    user = await require_auth(request)
    if user.get("role") != "admin":
        raise HTTPException(status_code=403, detail="Admin only")
    body = await request.json()
    images = body.get("images", [])
    imported = 0
    skipped = 0
    for img in images:
        key = img.get("storage_key")
        if not key or not img.get("data"):
            skipped += 1
            continue
        existing = await db.file_uploads.find_one({"storage_key": key})
        if existing:
            skipped += 1
            continue
        await db.file_uploads.insert_one({
            "storage_key": key,
            "data": img["data"],
            "content_type": img.get("content_type", "image/png"),
            "order_id": img.get("order_id", ""),
            "filename": img.get("filename", key),
            "uploaded_at": img.get("uploaded_at", ""),
            "migrated_from_disk": img.get("migrated_from_disk", False)
        })
        imported += 1
    return {"imported": imported, "skipped": skipped, "total_received": len(images)}
