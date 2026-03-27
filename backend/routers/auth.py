"""Auth routes: session, me, logout, email/password auth."""
from fastapi import APIRouter, HTTPException, Request, Response
from deps import db, get_current_user, require_auth, require_admin, log_activity, ADMIN_EMAILS
from datetime import datetime, timezone, timedelta
from passlib.hash import bcrypt
from fastapi.responses import RedirectResponse
import uuid, httpx, os, resend, logging

router = APIRouter(prefix="/api")
logger = logging.getLogger(__name__)

resend.api_key = os.environ.get('RESEND_API_KEY', '')
SENDER_EMAIL = os.environ.get('SENDER_EMAIL', 'onboarding@resend.dev')

from deps import db, get_current_user, require_auth, require_admin, log_activity, ADMIN_EMAILS, IS_PROD

# Direct Google OAuth Config
GOOGLE_CLIENT_ID = os.environ.get('GOOGLE_CLIENT_ID', '').strip()
GOOGLE_CLIENT_SECRET = os.environ.get('GOOGLE_CLIENT_SECRET', '').strip()

if IS_PROD:
    FRONTEND_URL = "https://mosdatabase-frontend.k9pirj.easypanel.host"
    REDIRECT_URI = "https://mosdatabase-backend.k9pirj.easypanel.host/api/auth/google/callback"
else:
    FRONTEND_URL = os.environ.get('FRONTEND_URL', 'http://localhost:3000').rstrip('/')
    REDIRECT_URI = os.environ.get('REDIRECT_URI', 'http://localhost:8000/api/auth/google/callback')


async def _create_session(user_id, response):
    session_token = f"session_{uuid.uuid4().hex}"
    expires_at = datetime.now(timezone.utc) + timedelta(days=7)
    await db.user_sessions.insert_one({
        "user_id": user_id, "session_token": session_token,
        "expires_at": expires_at.isoformat(), "created_at": datetime.now(timezone.utc).isoformat()
    })
    response.set_cookie(key="session_token", value=session_token, httponly=True, secure=True, samesite="none", path="/", max_age=7*24*60*60)
    return session_token

@router.get("/auth/google")
async def google_login():
    """Initiate Google OAuth 2.0 flow."""
    if not GOOGLE_CLIENT_ID:
        raise HTTPException(status_code=500, detail="GOOGLE_CLIENT_ID not configured")
    
    params = {
        "client_id": GOOGLE_CLIENT_ID,
        "redirect_uri": REDIRECT_URI,
        "response_type": "code",
        "scope": "openid email profile",
        "access_type": "offline",
        "prompt": "select_account"
    }
    url = f"https://accounts.google.com/o/oauth2/v2/auth?{httpx.QueryParams(params)}"
    return RedirectResponse(url)

@router.get("/auth/google/callback")
async def google_callback(code: str, response: Response):
    """Handle Google OAuth 2.0 callback."""
    if not GOOGLE_CLIENT_ID or not GOOGLE_CLIENT_SECRET:
        raise HTTPException(status_code=500, detail="Google credentials not configured")

    # 1. Exchange code for token
    token_url = "https://oauth2.googleapis.com/token"
    data = {
        "code": code,
        "client_id": GOOGLE_CLIENT_ID,
        "client_secret": GOOGLE_CLIENT_SECRET,
        "redirect_uri": REDIRECT_URI,
        "grant_type": "authorization_code"
    }
    
    async with httpx.AsyncClient() as client_http:
        token_resp = await client_http.post(token_url, data=data)
        if token_resp.status_code != 200:
            logger.error(f"Google Token exchange failed: {token_resp.text}")
            raise HTTPException(status_code=401, detail="Authentication failed during token exchange")
        token_data = token_resp.json()
        
        # 2. Get user info
        user_info_resp = await client_http.get(
            "https://www.googleapis.com/oauth2/v2/userinfo",
            headers={"Authorization": f"Bearer {token_data['access_token']}"}
        )
        if user_info_resp.status_code != 200:
            raise HTTPException(status_code=401, detail="Failed to get Google user info")
        user_data = user_info_resp.json()

    # 3. Process user in DB
    email = user_data["email"]
    name = user_data.get("name", email.split("@")[0])
    picture = user_data.get("picture", "")
    
    existing_user = await db.users.find_one({"email": email})
    if existing_user:
        user_id = existing_user["user_id"]
        role = "admin" if email in ADMIN_EMAILS else existing_user.get("role", "user")
        await db.users.update_one({"email": email}, {"$set": {
            "name": name, "picture": picture, "role": role, "auth_type": "google"
        }})
    else:
        user_id = f"user_{uuid.uuid4().hex[:12]}"
        role = "admin" if email in ADMIN_EMAILS else "user"
        new_user = {
            "user_id": user_id, "email": email, "name": name,
            "picture": picture, "role": role, "auth_type": "google",
            "created_at": datetime.now(timezone.utc).isoformat()
        }
        await db.users.insert_one(new_user)
        
    # 4. Create session and set cookie on the RedirectResponse
    redirect_resp = RedirectResponse(f"{FRONTEND_URL}/dashboard")
    await _create_session(user_id, redirect_resp)
    
    return redirect_resp

@router.post("/auth/session")
async def create_session(request: Request, response: Response):
    """Legacy proxy session endpoint (kept for backward compatibility)."""
    body = await request.json()
    session_id = body.get("session_id")
    if not session_id:
        raise HTTPException(status_code=400, detail="session_id required")
    async with httpx.AsyncClient() as client_http:
        auth_response = await client_http.get(
            "https://demobackend.emergentagent.com/auth/v1/env/oauth/session-data",
            headers={"X-Session-ID": session_id}
        )
    if auth_response.status_code != 200:
        raise HTTPException(status_code=401, detail="Invalid session_id")
    user_data = auth_response.json()
    email = user_data["email"]
    # ... rest of the legacy logic kept as is ...
    user_id = f"user_{uuid.uuid4().hex[:12]}"
    role = "admin" if user_data["email"] in ADMIN_EMAILS else "user"
    existing_user = await db.users.find_one({"email": user_data["email"]}, {"_id": 0})
    if existing_user:
        user_id = existing_user["user_id"]
        await db.users.update_one({"user_id": user_id}, {"$set": {
            "name": user_data["name"], "picture": user_data.get("picture"),
            "role": "admin" if user_data["email"] in ADMIN_EMAILS else existing_user.get("role", "user"),
            "auth_type": "google"
        }})
    else:
        new_user = {
            "user_id": user_id, "email": user_data["email"], "name": user_data["name"],
            "picture": user_data.get("picture"), "role": role, "auth_type": "google",
            "created_at": datetime.now(timezone.utc).isoformat()
        }
        await db.users.update_one({"email": user_data["email"]}, {"$set": new_user}, upsert=True)
    await _create_session(user_id, response)
    user = await db.users.find_one({"user_id": user_id}, {"_id": 0})
    await log_activity(user, "login", {"method": "google_oauth"})
    return user

# ==================== EMAIL/PASSWORD AUTH ====================

@router.post("/auth/create-user")
async def admin_create_user(request: Request, response: Response):
    """Admin creates a user with email/password."""
    admin = await require_admin(request)
    body = await request.json()
    email = body.get("email", "").strip().lower()
    password = body.get("password", "")
    name = body.get("name", "").strip()
    role = body.get("role", "user")
    if not email or "@" not in email:
        raise HTTPException(status_code=400, detail="Email invalido")
    if not password or len(password) < 6:
        raise HTTPException(status_code=400, detail="La contrasena debe tener al menos 6 caracteres")
    existing = await db.users.find_one({"email": email})
    if existing:
        raise HTTPException(status_code=400, detail="El usuario ya existe")
    user_id = f"user_{uuid.uuid4().hex[:12]}"
    hashed = bcrypt.hash(password)
    new_user = {
        "user_id": user_id, "email": email, "name": name or email.split("@")[0],
        "picture": "", "role": role, "auth_type": "email",
        "password_hash": hashed,
        "created_at": datetime.now(timezone.utc).isoformat()
    }
    await db.users.update_one({"email": email}, {"$set": new_user}, upsert=True)
    await log_activity(admin, "create_user", {"email": email, "role": role, "auth_type": "email"})
    return {"message": f"Usuario {email} creado exitosamente", "user_id": user_id}

@router.post("/auth/login")
async def email_login(request: Request, response: Response):
    """Login with email and password."""
    body = await request.json()
    email = body.get("email", "").strip().lower()
    password = body.get("password", "")
    if not email or not password:
        raise HTTPException(status_code=400, detail="Email y contrasena requeridos")
    user = await db.users.find_one({"email": email}, {"_id": 0})
    if not user:
        raise HTTPException(status_code=401, detail="Credenciales invalidas")
    if not user.get("password_hash"):
        raise HTTPException(status_code=401, detail="Esta cuenta usa Google. Inicia sesion con Google.")
    if not bcrypt.verify(password, user["password_hash"]):
        raise HTTPException(status_code=401, detail="Credenciales invalidas")
    await _create_session(user["user_id"], response)
    await log_activity(user, "login", {"method": "email"})
    safe_user = {k: v for k, v in user.items() if k != "password_hash"}
    return safe_user

@router.post("/auth/forgot-password")
async def forgot_password(request: Request):
    """Send password reset email."""
    body = await request.json()
    email = body.get("email", "").strip().lower()
    if not email:
        raise HTTPException(status_code=400, detail="Email requerido")
    user = await db.users.find_one({"email": email}, {"_id": 0})
    if not user or not user.get("password_hash"):
        # Don't reveal if user exists
        return {"message": "Si el email existe, se envio un enlace de recuperacion"}
    token = uuid.uuid4().hex
    expires = datetime.now(timezone.utc) + timedelta(hours=1)
    await db.password_resets.update_one(
        {"email": email},
        {"$set": {"email": email, "token": token, "expires_at": expires.isoformat(), "used": False}},
        upsert=True
    )
    frontend_url = FRONTEND_URL or os.environ.get('REACT_APP_BACKEND_URL', request.base_url.scheme + "://" + request.headers.get("host", ""))
    reset_link = f"{frontend_url}/reset-password?token={token}"
    if resend.api_key:
        try:
            resend.Emails.send({
                "from": SENDER_EMAIL,
                "to": [email],
                "subject": "Recuperar contrasena - CRMPROD",
                "html": f"""
                <div style="font-family:Arial,sans-serif;max-width:500px;margin:0 auto;padding:20px;">
                    <h2 style="color:#333;">Recuperar Contrasena</h2>
                    <p>Hola {user.get('name', '')},</p>
                    <p>Recibimos una solicitud para restablecer tu contrasena. Haz clic en el siguiente enlace:</p>
                    <a href="{reset_link}" style="display:inline-block;padding:12px 24px;background:#2563eb;color:#fff;text-decoration:none;border-radius:6px;margin:16px 0;">Restablecer Contrasena</a>
                    <p style="color:#666;font-size:13px;">Este enlace expira en 1 hora. Si no solicitaste esto, ignora este email.</p>
                </div>"""
            })
            logger.info(f"Password reset email sent to {email}")
        except Exception as e:
            logger.error(f"Failed to send reset email: {e}")
            return {"message": "Si el email existe, se envio un enlace de recuperacion", "reset_link": reset_link}
    else:
        logger.warning("RESEND_API_KEY not configured. Reset link: " + reset_link)
        return {"message": "Si el email existe, se envio un enlace de recuperacion", "reset_link": reset_link}
    return {"message": "Si el email existe, se envio un enlace de recuperacion"}

@router.post("/auth/reset-password")
async def reset_password(request: Request):
    """Reset password with token."""
    body = await request.json()
    token = body.get("token", "")
    new_password = body.get("password", "")
    if not token or not new_password:
        raise HTTPException(status_code=400, detail="Token y contrasena requeridos")
    if len(new_password) < 6:
        raise HTTPException(status_code=400, detail="La contrasena debe tener al menos 6 caracteres")
    reset = await db.password_resets.find_one({"token": token, "used": False}, {"_id": 0})
    if not reset:
        raise HTTPException(status_code=400, detail="Token invalido o expirado")
    expires = datetime.fromisoformat(reset["expires_at"])
    if expires.tzinfo is None:
        expires = expires.replace(tzinfo=timezone.utc)
    if expires < datetime.now(timezone.utc):
        raise HTTPException(status_code=400, detail="Token expirado")
    hashed = bcrypt.hash(new_password)
    await db.users.update_one({"email": reset["email"]}, {"$set": {"password_hash": hashed}})
    await db.password_resets.update_one({"token": token}, {"$set": {"used": True}})
    return {"message": "Contrasena actualizada exitosamente"}

@router.get("/auth/me")
async def get_me(request: Request):
    user = await get_current_user(request)
    if not user:
        raise HTTPException(status_code=401, detail="Not authenticated")
    safe_user = {k: v for k, v in user.items() if k != "password_hash"}
    return safe_user

@router.post("/auth/logout")
async def logout(request: Request, response: Response):
    user = await get_current_user(request)
    session_token = request.cookies.get("session_token")
    if session_token:
        await db.user_sessions.delete_one({"session_token": session_token})
    if user:
        await log_activity(user, "logout", {})
    response.delete_cookie(key="session_token", path="/")
    return {"message": "Logged out"}
