from fastapi import FastAPI, WebSocket, WebSocketDisconnect, Request, Response
from starlette.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from dotenv import load_dotenv
from pathlib import Path
import os
import logging
from ws_manager import ws_manager

ROOT_DIR = Path(__file__).parent
load_dotenv(ROOT_DIR / '.env')

# Configure logging
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(name)s - %(levelname)s - %(message)s')

app = FastAPI()

# CORS
app.add_middleware(
    CORSMiddleware,
    allow_credentials=True,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# Servir archivos estáticos de facturas
UPLOAD_DIR = "uploads/invoices"
os.makedirs(UPLOAD_DIR, exist_ok=True)
app.mount("/api/invoices/static", StaticFiles(directory=UPLOAD_DIR), name="invoices_static")

@app.middleware("http")
async def log_requests(request: Request, call_next):
    logging.info(f"PROXY_CHECK: Incoming {request.method} {request.url}")
    try:
        response = await call_next(request)
        logging.info(f"PROXY_CHECK: Outgoing {request.method} {request.url} status={response.status_code}")
        return response
    except Exception as e:
        logging.error(f"PROXY_CHECK: CRASH during {request.method} {request.url}: {str(e)}")
        raise e

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

# Global exception handler — ensures CORS headers are present even on 500s
from fastapi import Request as _Request
from fastapi.responses import JSONResponse
import traceback

@app.exception_handler(Exception)
async def global_exception_handler(request: _Request, exc: Exception):
    error_detail = traceback.format_exc()
    logging.error(f"UNHANDLED 500 on {request.method} {request.url}:\n{error_detail}")
    return JSONResponse(
        status_code=500,
        content={"detail": str(exc), "type": type(exc).__name__},
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
from routers.import_router import router as import_router
from routers.qc import router as qc_router
from routers.insights import router as insights_router
from routers.v1_insights import router as v1_insights_router
from routers.invoices import router as invoices_router
from routers.work_orders import router as work_orders_router

app.include_router(auth_router)
app.include_router(orders_router)
app.include_router(config_router)
app.include_router(automations_router)
app.include_router(users_router)
app.include_router(activity_router)
app.include_router(production_router)
app.include_router(wms_router)
app.include_router(reports_router)
app.include_router(import_router)
app.include_router(qc_router)
app.include_router(insights_router)
app.include_router(v1_insights_router)
app.include_router(invoices_router)
app.include_router(work_orders_router)

@app.on_event("startup")
async def startup_event():
    logging.info("MOS SYSTEM BACKEND STARTING...")
    logging.info(f"Registered routes: {[route.path for route in app.routes]}")
    try:
        await db.command("ping")
        logging.info("MongoDB connection: OK")
    except Exception as e:
        logging.error(f"MongoDB connection: FAILED - {e}")

@app.get("/ping")
async def ping():
    return {"status": "ok", "timestamp": datetime.now(timezone.utc).isoformat()}
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

    from db_backup import restore_database
    stats = await restore_database(db)
    if stats:
        logging.getLogger(__name__).info(f"Database restored from seed: {stats}")

    # Run database optimization and cleanup
    try:
        from optimize_db import main as run_optimization
        await run_optimization()
        logging.info("Database optimization and cleanup completed on startup.")
    except Exception as e:
        logging.error(f"Optimization error: {e}")
