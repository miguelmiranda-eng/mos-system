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
    allow_origins=os.environ.get('CORS_ORIGINS', '*').split(','),
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

app.include_router(auth_router)
app.include_router(orders_router)
app.include_router(config_router)
app.include_router(automations_router)
app.include_router(users_router)
app.include_router(activity_router)
app.include_router(production_router)
app.include_router(wms_router)

# Auto-restore database on startup
@app.on_event("startup")
async def startup_restore():
    from deps import db
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
    uvicorn.run(app, host="0.0.0.0", port=8000)
