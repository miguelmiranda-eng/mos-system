"""Shared dependencies: DB, auth helpers, models, constants."""
from fastapi import HTTPException, Request
from motor.motor_asyncio import AsyncIOMotorClient
from pydantic import BaseModel, Field, EmailStr, field_validator
from typing import List, Optional, Dict, Any
from datetime import datetime, timezone
from pathlib import Path
from dotenv import load_dotenv
import os, uuid, logging

ROOT_DIR = Path(__file__).parent
load_dotenv(ROOT_DIR / '.env')

# Environment detection
ENV = os.environ.get('ENV', 'local').lower()
IS_PROD = ENV == 'production'
mongo_url = os.environ.get('MONGO_URL') or os.environ.get('MONGODB_URI') or os.environ.get('MONGODB_URL')
if not mongo_url:
    raise KeyError("Neither MONGO_URL, MONGODB_URI, nor MONGODB_URL found in environment variables")

client = AsyncIOMotorClient(mongo_url)

# Get DB_NAME from env or extract from URI
db_name = os.environ.get('DB_NAME')
if not db_name:
    import re
    # Extract database name from connection string: mongodb://.../database_name?options
    match = re.search(r'/([^/?]+)(\?|$)', mongo_url)
    if match:
        db_name = match.group(1)
    else:
        # Default as per project structure or fallback
        db_name = "mos-system"

db = client[db_name]

# Config
ADMIN_EMAILS = [
    "miguel.miranda@prosper-mfg.com",
    "200492miguel.miranda@gmail.com"
]
UPLOADS_DIR = ROOT_DIR / 'uploads'
try:
    UPLOADS_DIR.mkdir(exist_ok=True)
except OSError:
    pass  # Read-only filesystem in production is OK - images are in MongoDB

logger = logging.getLogger(__name__)

# ==================== DEFAULT OPTIONS ====================
DEFAULT_OPTIONS = {
    "priorities": ["RUSH", "OVERSOLD", "PRIORITY 1", "PRIORITY 2", "EVENT", "SPECIAL RUSH"],
    "clients": [
        "LOVE IN FAITH", "GOODIE TWO SLEEVES", "SCREENWORKS", "TARGET",
        "Tractor Supply", "ROSS", "Hot Topic", "EDI", "Fashion Nova", "Pacsun",
        "Forever 21", "Urban Outfitters", "Meijer", "Buckle", "Tillys", "Aeropostale",
        "Altard's State", "Fred Meyers", "American Wholesale", "Mardel", "Nordstrom",
        "FOCO", "TREVCO", "WALLMART", "JAKO ENTERPRISES", "MIDSTATE", "Ross"
    ],
    "brandings": [
        "Spencers Spirit", "Spencers", "LIF Regular", "LIF Broker", "Buc-ees", "LIF Wholesale",
        "Tractor Supply", "ROSS", "Target", "Hot Topic", "EDI", "Fashion Nova", "Pacsun",
        "Forever 21", "Urban Outfitters", "Meijer", "Buckle", "Tillys", "Aeropostale",
        "Altard's State", "Fred Meyers", "American Wholesale", "Mardel", "Nordstrom", "FOCO",
        "TREVCO", "WALLMART", "JAKO ENTERPRISES", "MIDSTATE", "Ross"
    ],
    "blank_sources": ["GLO STOCK", "CLIENT", "GTS STOCK", "LKWID STOCK", "LIF STOCK", "STOCK+BPO", "BLANK SOURCE", "PURCH", "BPO"],
    "blank_statuses": [
        "FROM USA", "CONTADO/PICKED", "PICK TICKET READY", "PULL IN PROCESS", "APROVED RUN SHORT",
        "PARTIAL", "PARTIAL - REPORTED", "SENT TO DYE HOUSE", "HOLD", "CANCELLED", "CONTAINERS",
        "READY FOR DYE HOUSE", "PENDIENTE", "PARTIAL - Reported"
    ],
    "production_statuses": [
        "NECESITA LABEL", "PROCESO DE NECK LABEL", "LABEL LISTO", "EN ESPERA", "EN PRODUCCION",
        "NECESITA EMPACAR", "EN PROCESO DE EMPAQUE", "NECESITA QC", "LISTO PARA FULFILLMENT",
        "LISTO PARA ENVIO", "CANCELLED", "EJEMPLO APROBADO", "PROCESO DE LABEL",
        "LISTO PARA INVENTARIO", "ESPERA DE APROBAC"
    ],
    "trim_statuses": ["TRIM-PARCIAL", "EN PROCESO", "EN ESPERA DE TRIM", "COMPLETE TRIM", "BOX LABEL IMPRESO", "NEEDS TRIM"],
    "trim_boxes": ["Listo", "En curso"],
    "samples": ["EJEMPLO PRIMERO", "EJEMPLO APROBADO", "LICENCIA", "APR. POR FOTO", "APR. PARA EJEMPLO"],
    "artwork_statuses": [
        "NEW", "REORDER", "SEPS DONE", "REORDER W/CHANGE", "NEED SAMPLE", "WAITING ON INFO",
        "NEEDS ART FILE", "RHINESTONE", "REVIEW", "HOLD", "N/A", "EMB ORDER", "BSA", "JG", "CANCELLED"
    ],
    "betty_columns": ["HOLD", "REORDER", "LICENCIA-EJEMPLO PRIMERO", "PRODUCCION-EJEMPLO PRIMERO", "APROBADO"],
    "shippings": ["CUSTOMER", "CUSTOMER WILL PROVIDE LABELS", "SHIPPING"],
    "boards": [
        "MASTER", "SCHEDULING", "READY TO SCHEDULED", "BLANKS", "SCREENS", "NECK", "EJEMPLOS", "COMPLETOS", "EDI",
        "PAPELERA DE RECICLAJE", "MAQUINA1", "MAQUINA2", "MAQUINA3", "MAQUINA4",
        "MAQUINA5", "MAQUINA6", "MAQUINA7", "MAQUINA8", "MAQUINA9", "MAQUINA10",
        "MAQUINA11", "MAQUINA12", "MAQUINA13", "MAQUINA14", "FINAL BILL"
    ],
    "trigger_types": ["create", "move", "update", "status_change"],
    "action_types": ["send_email", "move_board", "assign_field", "notify_slack"],
    "condition_fields": ["priority", "client", "branding", "blank_status", "production_status", "trim_status", "sample", "artwork_status", "board", "betty_column", "shipping"]
}

BOARDS = DEFAULT_OPTIONS["boards"]
MACHINES = [f"MAQUINA{i}" for i in range(1, 15)]

async def get_dynamic_boards():
    """Get boards from DB, falling back to defaults."""
    config = await db.board_config.find_one({"config_id": "boards"}, {"_id": 0})
    if config and config.get("boards"):
        return config["boards"]
    return BOARDS

async def save_boards(boards_list):
    """Persist boards to DB."""
    await db.board_config.update_one(
        {"config_id": "boards"},
        {"$set": {"config_id": "boards", "boards": boards_list}},
        upsert=True
    )

# ==================== MODELS ====================

class User(BaseModel):
    user_id: str
    email: str
    name: str
    picture: Optional[str] = None
    role: str = "user"
    created_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))

class OrderCreate(BaseModel):
    order_number: Optional[str] = None
    po_number: Optional[str] = None
    customer_po: Optional[str] = None
    store_po: Optional[str] = None
    cancel_date: Optional[str] = None
    client: Optional[str] = None
    branding: Optional[str] = None
    priority: Optional[str] = None
    blank_source: Optional[str] = None
    blank_status: Optional[str] = None
    production_status: Optional[str] = None
    trim_status: Optional[str] = None
    trim_box: Optional[str] = None
    sample: Optional[str] = None
    artwork_status: Optional[str] = None
    betty_column: Optional[str] = None
    job_title_a: Optional[Any] = None
    job_title_b: Optional[Any] = None
    shipping: Optional[str] = None
    quantity: Optional[int] = 0
    due_date: Optional[str] = None
    notes: Optional[str] = None
    color: Optional[str] = None
    design_num: Optional[str] = Field(None, alias="design_#")
    final_bill: Optional[str] = None
    screens: Optional[bool] = None
    board: Optional[str] = "SCHEDULING"
    
    model_config = {
        "extra": "allow",
        "populate_by_name": True
    }
    
    @field_validator("board", mode="before")
    @classmethod
    def validate_board(cls, v):
        if v is None or (isinstance(v, str) and not v.strip()):
            return "SCHEDULING"
        return v

    links: Optional[List[Dict[str, str]]] = []
    custom_fields: Optional[Dict[str, Any]] = {}

class OrderUpdate(BaseModel):
    client: Optional[str] = None
    branding: Optional[str] = None
    priority: Optional[str] = None
    blank_source: Optional[str] = None
    blank_status: Optional[str] = None
    production_status: Optional[str] = None
    trim_status: Optional[str] = None
    trim_box: Optional[str] = None
    sample: Optional[str] = None
    artwork_status: Optional[str] = None
    betty_column: Optional[str] = None
    shipping: Optional[str] = None
    quantity: Optional[int] = None
    due_date: Optional[str] = None
    notes: Optional[str] = None
    color: Optional[str] = None
    design_num: Optional[str] = Field(None, alias="design_#")
    final_bill: Optional[str] = None
    board: Optional[str] = None
    custom_fields: Optional[Dict[str, Any]] = None
    model_config = {
        "extra": "allow",
        "populate_by_name": True
    }

class CommentCreate(BaseModel):
    content: str
    parent_id: Optional[str] = None

class AutomationCreate(BaseModel):
    name: str
    trigger_type: str
    trigger_conditions: Dict[str, Any]
    action_type: str
    action_params: Dict[str, Any]
    is_active: bool = True
    boards: Optional[List[str]] = []

class OptionUpdate(BaseModel):
    option_key: str
    values: List[str]

class EmailRequest(BaseModel):
    recipient_email: EmailStr
    subject: str
    html_content: str

class ProductionLogCreate(BaseModel):
    order_id: str
    quantity_produced: int
    machine: str
    setup: Optional[int] = 0
    operator: Optional[str] = ""
    shift: Optional[str] = ""
    design_type: Optional[str] = ""
    stop_cause: Optional[str] = ""
    supervisor: Optional[str] = ""

# ==================== AUTH HELPERS ====================

async def get_current_user(request: Request) -> Optional[Dict]:
    session_token = request.cookies.get("session_token")
    if not session_token:
        auth_header = request.headers.get("Authorization")
        if auth_header and auth_header.startswith("Bearer "):
            session_token = auth_header.split(" ")[1]
    if not session_token:
        return None
    
    # Support for internal sync token
    internal_token = os.environ.get("INTERNAL_SYNC_TOKEN")
    if internal_token and session_token == internal_token:
        # Return a mock admin user for sync
        return {"user_id": "system_sync", "email": "miguel.miranda@prosper-mfg.com", "name": "System Sync", "role": "admin"}
        
    session = await db.user_sessions.find_one({"session_token": session_token}, {"_id": 0})
    if not session:
        return None
    expires_at = session.get("expires_at")
    if isinstance(expires_at, str):
        expires_at = datetime.fromisoformat(expires_at)
    if expires_at.tzinfo is None:
        expires_at = expires_at.replace(tzinfo=timezone.utc)
    if expires_at < datetime.now(timezone.utc):
        return None
    user = await db.users.find_one({"user_id": session["user_id"]}, {"_id": 0})
    return user

async def require_auth(request: Request) -> Dict:
    user = await get_current_user(request)
    if not user:
        raise HTTPException(status_code=401, detail="Not authenticated")
    return user

async def require_admin(request: Request) -> Dict:
    user = await require_auth(request)
    if user.get("role") != "admin":
        raise HTTPException(status_code=403, detail="Admin access required")
    return user

async def log_activity(user: Dict, action: str, details: Dict = None, previous_data: Dict = None):
    activity_doc = {
        "activity_id": f"act_{uuid.uuid4().hex[:12]}",
        "user_id": user.get("user_id"),
        "user_name": user.get("name"),
        "user_email": user.get("email"),
        "action": action,
        "details": details or {},
        "previous_data": previous_data,
        "undoable": previous_data is not None,
        "undone": False,
        "timestamp": datetime.now(timezone.utc).isoformat()
    }
    await db.activity_logs.insert_one(activity_doc)
