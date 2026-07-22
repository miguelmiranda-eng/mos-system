from fastapi import FastAPI, WebSocket, WebSocketDisconnect, Request, Response
from starlette.middleware.cors import CORSMiddleware
from starlette.middleware.gzip import GZipMiddleware
from fastapi.staticfiles import StaticFiles
from dotenv import load_dotenv
from pathlib import Path
import os
import logging
from datetime import datetime, timezone
from ws_manager import ws_manager
from deps import db

ROOT_DIR = Path(__file__).parent
load_dotenv(ROOT_DIR / '.env')

# Configure logging
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(name)s - %(levelname)s - %(message)s')

app = FastAPI()

# CORS - Specific origins are required when allow_credentials is True
ALLOWED_ORIGINS = [
    "https://mosdatabase-frontend.k9pirj.easypanel.host",
    "http://localhost:3000",
    "http://localhost:3001",
    "http://127.0.0.1:3000",
    "http://127.0.0.1:3001",
    "http://localhost:5173",
    "http://127.0.0.1:5173"
]

app.add_middleware(
    CORSMiddleware,
    allow_credentials=True,
    allow_origins=ALLOWED_ORIGINS,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Comprime respuestas grandes (los tableros pesan ~4.4 MB de JSON y cada
# cambio de orden hace que TODOS los clientes conectados los re-descarguen;
# gzip los deja en ~10%). minimum_size evita comprimir respuestas chicas.
app.add_middleware(GZipMiddleware, minimum_size=1024)

# Servir archivos estáticos de facturas
UPLOAD_DIR = "uploads/invoices"
os.makedirs(UPLOAD_DIR, exist_ok=True)
app.mount("/api/invoices/static", StaticFiles(directory=UPLOAD_DIR), name="invoices_static")

# Shipping Uploads
SHIPPING_DIR = "uploads/shipping"
os.makedirs(SHIPPING_DIR, exist_ok=True)
app.mount("/api/shipping/static", StaticFiles(directory=SHIPPING_DIR), name="shipping_static")

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

from pymongo.errors import DuplicateKeyError as _DuplicateKeyError


@app.exception_handler(_DuplicateKeyError)
async def duplicate_key_handler(request: _Request, exc: _DuplicateKeyError):
    """El índice único de wms_inventory rechazó un duplicado de inventario.

    BLINDAJE TRANSVERSAL. Los 4 endpoints de movimiento ya resuelven la fila
    correctamente vía services/inventory_ledger.py, pero quedan ~47 puntos en
    wms.py (conteos cíclicos, ajustes, generar caja, allocation…) que todavía
    identifican la fila con la llave vieja y podrían intentar crear un duplicado.

    El índice único los detiene a TODOS a nivel de base de datos. Este handler
    traduce ese rechazo —que si no sería un 500 con jerga de Mongo— en un 409
    accionable para el operador, y lo deja registrado como incidencia para que
    sistemas sepa QUÉ punto falta migrar.
    """
    mensaje = str(exc)
    es_inventario = "wms_inventory" in mensaje or "uniq_inventory_material_lote" in mensaje
    logging.error(f"DUPLICATE KEY on {request.method} {request.url}: {mensaje}")

    if es_inventario:
        try:
            from deps import db as _db, get_current_user as _gcu
            import uuid as _uuid
            from datetime import datetime as _dt, timezone as _tz
            usuario = {}
            try:
                usuario = await _gcu(request) or {}
            except Exception:
                pass
            await _db.wms_incidents.insert_one({
                "incident_id": f"inc_{_uuid.uuid4().hex[:12]}",
                "kind": "duplicate_blocked_by_index",
                "endpoint": f"{request.method} {request.url.path}",
                "mongo_error": mensaje[:500],
                "user_id": usuario.get("user_id"),
                "user_name": usuario.get("name", usuario.get("email", "")),
                "created_at": _dt.now(_tz.utc).isoformat(),
            })
        except Exception:
            logging.exception("no se pudo registrar la incidencia de duplicado")

        detalle = ("Operación cancelada: crearía un inventario duplicado para ese "
                   "material y lote en la ubicación. La base de datos lo impidió. "
                   "Avisa a sistemas — quedó registrado en Incidencias.")
    else:
        detalle = "Registro duplicado: ya existe un elemento con esa clave."

    origin = request.headers.get("origin")
    allowed_origin = origin if origin in ALLOWED_ORIGINS else ALLOWED_ORIGINS[0]
    return JSONResponse(
        status_code=409,
        content={"detail": detalle, "type": "DuplicateKeyError"},
        headers={"Access-Control-Allow-Origin": allowed_origin,
                 "Access-Control-Allow-Credentials": "true"},
    )


@app.exception_handler(Exception)
async def global_exception_handler(request: _Request, exc: Exception):
    error_detail = traceback.format_exc()
    logging.error(f"UNHANDLED 500 on {request.method} {request.url}:\n{error_detail}")
    
    # Use the request origin if it's in our allowed list, otherwise default to the main frontend
    origin = request.headers.get("origin")
    allowed_origin = origin if origin in ALLOWED_ORIGINS else ALLOWED_ORIGINS[0]
    
    return JSONResponse(
        status_code=500,
        content={"detail": str(exc), "type": type(exc).__name__},
        headers={
            "Access-Control-Allow-Origin": allowed_origin,
            "Access-Control-Allow-Credentials": "true"
        }
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
from routers.art import router as art_router
from routers.agenda import router as agenda_router
from routers.google_calendar import router as google_calendar_router
from routers.shipping import router as shipping_router
from routers.packing import router as packing_router
from routers.report_scheduler import router as report_scheduler_router, start_report_scheduler
from routers.printavo_scheduler import router as printavo_scheduler_router, start_printavo_scheduler
from routers.printavo_export import router as printavo_export_router
from routers.paint import router as paint_router
from routers.samples import router as samples_router

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
app.include_router(art_router)
app.include_router(agenda_router)
app.include_router(google_calendar_router)
app.include_router(shipping_router)
app.include_router(packing_router)
app.include_router(report_scheduler_router)
app.include_router(printavo_scheduler_router)
app.include_router(printavo_export_router)
app.include_router(paint_router)
app.include_router(samples_router)

@app.on_event("startup")
async def startup_event():
    logging.info("MOS SYSTEM BACKEND STARTING...")
    logging.info(f"Registered routes: {[route.path for route in app.routes]}")
    try:
        await db.command("ping")
        logging.info("MongoDB connection: OK")
    except Exception as e:
        logging.error(f"MongoDB connection: FAILED - {e}")
    # WMS-009: ensure WMS indexes exist on every boot (idempotent, boot-safe).
    # NOTE: startup_restore() below — which used to run optimize_db — is dead code
    # (never decorated as a startup event), so indexes are ensured explicitly here.
    try:
        from optimize_db import ensure_wms_indexes, ensure_core_indexes
        await ensure_core_indexes(db)
        await ensure_wms_indexes(db)
        logging.info("Core + WMS indexes ensured on startup.")
    except Exception as e:
        logging.error(f"Index creation failed: {e}")
    # Daily production report scheduler (no-op if disabled / apscheduler missing).
    start_report_scheduler()
    # Printavo invoice auto-sync poller (no-op if disabled / unconfigured).
    start_printavo_scheduler()

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
