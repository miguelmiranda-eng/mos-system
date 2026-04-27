"""Users management routes."""
from fastapi import APIRouter, HTTPException, Request
from deps import db, require_admin, require_auth, log_activity, ADMIN_EMAILS
from datetime import datetime, timezone

router = APIRouter(prefix="/api")

@router.get("/users/list")
async def list_users_for_mention(request: Request):
    await require_auth(request)
    users = await db.users.find({}, {"_id": 0, "email": 1, "name": 1, "picture": 1, "user_id": 1, "associated_customer": 1}).to_list(200)
    return users

@router.get("/users")
async def get_users(request: Request):
    await require_admin(request)
    users = await db.users.find({}, {"_id": 0, "password_hash": 0}).to_list(200)
    
    # Pre-aggregate activity data
    pipeline = [
        {"$group": {
            "_id": "$user_email",
            "last_activity": {"$max": "$timestamp"},
            "total_tasks": {"$sum": 1},
            "projects_touched": {"$addToSet": "$details.order_id"}
        }}
    ]
    activity_stats = await db.activity_logs.aggregate(pipeline).to_list(100)
    activity_map = {item["_id"]: item for item in activity_stats}
    
    # Pre-aggregate session data
    session_pipeline = [
        {"$group": {
            "_id": "$user_id",
            "login_count": {"$sum": 1}
        }}
    ]
    session_stats = await db.user_sessions.aggregate(session_pipeline).to_list(100)
    session_map = {item["_id"]: item for item in session_stats}

    for u in users:
        email = u.get("email", "")
        uid = u.get("user_id", email)
        u["user_id"] = uid
        
        # User Metrics
        stats = activity_map.get(email, {})
        u["last_activity"] = stats.get("last_activity", None)
        u["total_tasks"] = stats.get("total_tasks", 0)
        u["projects_count"] = len(stats.get("projects_touched", []))
        
        # Status / Verification
        u["status"] = "active" # Placeholder for future logic
        u["email_verified"] = True # We consider them verified if they are in the tenant
        
        # Sessions
        sess = session_map.get(uid, {})
        u["login_count"] = sess.get("login_count", 1) # Fallback to 1 if we lost session data
        
    return users

@router.post("/users/invite")
async def invite_user(request: Request):
    user = await require_admin(request)
    body = await request.json()
    email = body.get("email", "").strip().lower()
    role = body.get("role", "user")
    associated_customer = body.get("associated_customer", "")
    if not email or "@" not in email:
        raise HTTPException(status_code=400, detail="Email inválido")
    existing = await db.users.find_one({"email": email})
    if existing:
        raise HTTPException(status_code=400, detail="El usuario ya existe")
    new_user = {
        "email": email, "name": email.split("@")[0], "picture": "", "role": role, 
        "associated_customer": associated_customer,
        "invited_by": user, "created_at": datetime.now(timezone.utc).isoformat()
    }
    await db.users.update_one({"email": email}, {"$set": new_user}, upsert=True)
    await log_activity(user, "invite_user", {"email": email, "role": role, "associated_customer": associated_customer})
    return {"message": f"Usuario {email} invitado como {role}"}

@router.put("/users/{user_id}/role")
async def update_user_role(user_id: str, request: Request):
    user = await require_admin(request)
    body = await request.json()
    new_role = body.get("role", "user")
    associated_customer = body.get("associated_customer", "")
    update_data = {"role": new_role}
    if associated_customer is not None:
        update_data["associated_customer"] = associated_customer
        
    result = await db.users.update_one(
        {"$or": [{"user_id": user_id}, {"email": user_id}]}, 
        {"$set": update_data}
    )
    if result.matched_count == 0:
        raise HTTPException(status_code=404, detail="Usuario no encontrado")
    await log_activity(user, "update_user_role", {"email": user_id, "new_role": new_role, "associated_customer": associated_customer})
    return {"message": f"Rol de {user_id} actualizado a {new_role}"}

@router.delete("/users/{user_id}")
async def delete_user(user_id: str, request: Request):
    user = await require_admin(request)
    if user_id in ADMIN_EMAILS:
        raise HTTPException(status_code=400, detail="No se puede eliminar al administrador principal")
    result = await db.users.delete_one({"$or": [{"user_id": user_id}, {"email": user_id}]})
    if result.deleted_count == 0:
        raise HTTPException(status_code=404, detail="Usuario no encontrado")
    await log_activity(user, "delete_user", {"email": user_id})
    return {"message": f"Usuario {user_id} eliminado"}

@router.put("/users/{user_email}/profile")
async def update_user_profile(user_email: str, request: Request):
    """Admin updates name/email of an email-type user."""
    admin = await require_admin(request)
    body = await request.json()
    name = body.get("name", "").strip()
    new_email = body.get("email", "").strip().lower()
    update = {}
    if name:
        update["name"] = name
    if new_email and new_email != user_email:
        existing = await db.users.find_one({"email": new_email})
        if existing:
            raise HTTPException(status_code=400, detail="Ese email ya esta en uso")
        update["email"] = new_email
    if not update:
        raise HTTPException(status_code=400, detail="Nada que actualizar")
    result = await db.users.update_one({"email": user_email}, {"$set": update})
    if result.matched_count == 0:
        raise HTTPException(status_code=404, detail="Usuario no encontrado")
    await log_activity(admin, "update_user_profile", {"email": user_email, "changes": update})
    return {"message": "Usuario actualizado"}

@router.put("/users/{user_email}/password")
async def admin_reset_user_password(user_email: str, request: Request):
    """Admin resets password of an email-type user."""
    from passlib.hash import bcrypt
    admin = await require_admin(request)
    body = await request.json()
    new_password = body.get("password", "")
    if not new_password or len(new_password) < 6:
        raise HTTPException(status_code=400, detail="La contrasena debe tener al menos 6 caracteres")
    target = await db.users.find_one({"email": user_email}, {"_id": 0})
    if not target:
        raise HTTPException(status_code=404, detail="Usuario no encontrado")
    if not target.get("password_hash"):
        raise HTTPException(status_code=400, detail="Este usuario usa Google, no tiene contrasena")
    hashed = bcrypt.hash(new_password)
    await db.users.update_one({"email": user_email}, {"$set": {"password_hash": hashed}})
    await log_activity(admin, "admin_reset_password", {"email": user_email})
    return {"message": f"Contrasena de {user_email} actualizada"}

# ==================== BOARD PERMISSIONS ====================

@router.get("/users/{user_email}/board-permissions")
async def get_user_board_permissions(user_email: str, request: Request):
    await require_admin(request)
    doc = await db.board_permissions.find_one({"email": user_email}, {"_id": 0})
    return doc.get("permissions", {}) if doc else {}

@router.put("/users/{user_email}/board-permissions")
async def update_user_board_permissions(user_email: str, request: Request):
    user = await require_admin(request)
    body = await request.json()
    # body = { "SCHEDULING": "edit", "BLANKS": "view", "SCREENS": "none" }
    await db.board_permissions.update_one(
        {"email": user_email},
        {"$set": {"email": user_email, "permissions": body}},
        upsert=True
    )
    await log_activity(user, "update_board_permissions", {"email": user_email, "permissions": body})
    return {"message": "Permisos actualizados"}

@router.get("/board-permissions/me")
async def get_my_board_permissions(request: Request):
    user = await require_auth(request)
    email = user if isinstance(user, str) else user.get("email", user)
    doc = await db.board_permissions.find_one({"email": email}, {"_id": 0})
    return doc.get("permissions", {}) if doc else {}
