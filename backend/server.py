from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from starlette.middleware.cors import CORSMiddleware
from dotenv import load_dotenv
from pathlib import Path
import os
import logging

ROOT_DIR = Path(__file__).parent
load_dotenv(ROOT_DIR / '.env')

# Configure logging
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(name)s - %(levelname)s - %(message)s')

app = FastAPI()

# CORS
app.add_middleware(
    CORSMiddleware,
    allow_credentials=True,
    allow_origins=[
        "https://mosdatabase-frontend.k9pirj.easypanel.host",
        "http://localhost:3000",
        "http://localhost:5173"
    ] + [o.strip() for o in os.environ.get('CORS_ORIGINS', '').split(',') if o.strip()],
    allow_methods=["*"],
    allow_headers=["*"],
)

# Import and register routers
from routers.auth import router as auth_router
from routers.orders import router as orders_router
from routers.config import router as config_router
from routers.automations import router as automations_router
from routers.users import router as users_router
from routers.activity import router as activity_router
from routers.production import router as production_router
from routers.wms import router as wms_router
from routers.reports import router as reports_router


app.include_router(auth_router)
app.include_router(orders_router)
app.include_router(config_router)
app.include_router(automations_router)
app.include_router(users_router)
app.include_router(activity_router)
app.include_router(production_router)
app.include_router(wms_router)
app.include_router(reports_router)


# Auto-restore database on startup
@app.on_event("startup")
async def startup_restore():
    from deps import db
    import asyncio
    
    # Pre-flight DB check with timeout to avoid hanging
    try:
        logging.info("Checking database connection...")
        await asyncio.wait_for(db.command("ping"), timeout=5.0)
        logging.info("Database connection verified.")
    except Exception as e:
        logging.error(f"Could not connect to database: {e}. The server may be unstable.")
        # We continue as the app might still work for some routes, but this is a critical warning

    from db_backup import restore_database
    stats = await restore_database(db)
    if stats:
        logging.getLogger(__name__).info(f"Database restored from seed: {stats}")

# Admin backup endpoint
from fastapi import Request
from deps import require_admin

@app.post("/api/admin/backup")
async def admin_backup(request: Request):
    await require_admin(request)
    from deps import db
    from db_backup import backup_database
    stats = await backup_database(db)
    return {"message": "Backup completado", "stats": stats}

@app.delete("/api/admin/clear-data")
async def admin_clear_data(request: Request):
    """Wipe all operational data (orders, comments, images, notifications,
    activity_logs) while preserving users, sessions, and config."""
    await require_admin(request)
    from deps import db
    collections_to_clear = [
        "orders", "comments", "file_uploads",
        "notifications", "activity_logs"
    ]
    stats = {}
    for col in collections_to_clear:
        result = await db[col].delete_many({})
        stats[col] = result.deleted_count
    return {"message": "Datos borrados correctamente", "stats": stats}

# WebSocket endpoint
from ws_manager import ws_manager

@app.websocket("/api/ws")
async def websocket_endpoint(websocket: WebSocket):
    await ws_manager.connect(websocket)
    try:
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        ws_manager.disconnect(websocket)
    except Exception:
        ws_manager.disconnect(websocket)

@app.on_event("shutdown")
async def shutdown_db_client():
    from deps import client
    client.close()
if __name__ == "__main__":
    import uvicorn
    # Use standard asyncio loop and websockets implementation for Windows robustness
    # Watch only root and routers to avoid unnecessary reloads from uploads or scripts
    backend_dir = str(ROOT_DIR)
    routers_dir = str(ROOT_DIR / "routers")
    
    uvicorn.run(
        "server:app", 
        host="0.0.0.0", 
        port=8000, 
        reload=True, 
        reload_dirs=[backend_dir],
        reload_includes=["*.py", "*.json"],
        reload_excludes=["uploads/*", "scripts/*", "venv/*", "**/__pycache__/*"],
        loop="asyncio", 
        ws="websockets"
    )
