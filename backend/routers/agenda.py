"""Smart Visual Agenda — CRUD con visibilidad mixta (privado / equipo)."""
from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel
from typing import Optional
from deps import db, require_auth, log_activity
from datetime import datetime, timezone
import uuid

router = APIRouter(prefix="/api/agenda")

CATEGORY_COLORS = {
    "meeting":    "#3b82f6",
    "production": "#f59e0b",
    "personal":   "#8b5cf6",
    "urgent":     "#ef4444",
    "reminder":   "#10b981",
    "deadline":   "#f97316",
}


def _is_admin(user: dict) -> bool:
    return user.get("role") in ("admin", "ceo")


def _can_edit(user: dict, event: dict) -> bool:
    """El dueño del evento o cualquier admin puede editar/eliminar."""
    return event.get("created_by") == user["user_id"] or _is_admin(user)


class AgendaEventCreate(BaseModel):
    title: str
    description: Optional[str] = ""
    start_dt: str          # ISO-8601: "2026-05-12T09:00"
    end_dt: str            # ISO-8601: "2026-05-12T10:00"
    all_day: bool = False
    category: str = "meeting"   # meeting | production | personal | urgent | reminder | deadline
    priority: str = "normal"    # low | normal | high | urgent
    color: Optional[str] = None
    status: str = "pending"     # pending | in_progress | completed | cancelled
    location: Optional[str] = ""
    notes: Optional[str] = ""
    assigned_to: Optional[str] = None
    recurrence: Optional[str] = "none"    # none | daily | weekly | monthly
    visibility: str = "team"              # team | private


class AgendaEventUpdate(BaseModel):
    title: Optional[str] = None
    description: Optional[str] = None
    start_dt: Optional[str] = None
    end_dt: Optional[str] = None
    all_day: Optional[bool] = None
    category: Optional[str] = None
    priority: Optional[str] = None
    color: Optional[str] = None
    status: Optional[str] = None
    location: Optional[str] = None
    notes: Optional[str] = None
    assigned_to: Optional[str] = None
    recurrence: Optional[str] = None
    visibility: Optional[str] = None     # team | private


@router.get("/events")
async def get_events(
    request: Request,
    start: Optional[str] = None,
    end: Optional[str] = None,
    category: Optional[str] = None,
):
    user = await require_auth(request)

    # Visibility filter:
    #   admin/ceo  → ve TODO
    #   cualquier otro → ve eventos de equipo + sus propios eventos privados
    if _is_admin(user):
        vis_filter = {}
    else:
        vis_filter = {
            "$or": [
                {"visibility": "team"},
                {"visibility": {"$exists": False}},   # legacy sin campo
                {"created_by": user["user_id"]},
            ]
        }

    query = {**vis_filter}

    if start and end:
        date_filter = {
            "$or": [
                {"start_dt": {"$gte": start, "$lte": end}},
                {"end_dt":   {"$gte": start, "$lte": end}},
                {"start_dt": {"$lte": start}, "end_dt": {"$gte": end}},
            ]
        }
        # Combinar ambos filtros con $and
        if vis_filter:
            query = {"$and": [vis_filter, date_filter]}
        else:
            query = date_filter

    if category and category != "all":
        query["category"] = category

    cursor = db.agenda_events.find(query, {"_id": 0}).sort("start_dt", 1)
    events = await cursor.to_list(length=2000)
    return events


@router.post("/events")
async def create_event(request: Request, data: AgendaEventCreate):
    user = await require_auth(request)
    color = data.color or CATEGORY_COLORS.get(data.category, "#3b82f6")

    event = {
        "event_id":        f"evt_{uuid.uuid4().hex[:12]}",
        "title":           data.title,
        "description":     data.description or "",
        "start_dt":        data.start_dt,
        "end_dt":          data.end_dt,
        "all_day":         data.all_day,
        "category":        data.category,
        "priority":        data.priority,
        "color":           color,
        "status":          data.status,
        "location":        data.location or "",
        "notes":           data.notes or "",
        "assigned_to":     data.assigned_to,
        "recurrence":      data.recurrence or "none",
        "visibility":      data.visibility,        # "team" | "private"
        "created_by":      user["user_id"],
        "created_by_name": user.get("name", ""),
        "created_at":      datetime.now(timezone.utc).isoformat(),
        "updated_at":      datetime.now(timezone.utc).isoformat(),
    }

    await db.agenda_events.insert_one(event)
    await log_activity(user, "agenda_event_created", {
        "event_id":   event["event_id"],
        "title":      data.title,
        "category":   data.category,
        "visibility": data.visibility,
    })
    return event


@router.put("/events/{event_id}")
async def update_event(request: Request, event_id: str, data: AgendaEventUpdate):
    user = await require_auth(request)
    existing = await db.agenda_events.find_one({"event_id": event_id}, {"_id": 0})
    if not existing:
        raise HTTPException(status_code=404, detail="Evento no encontrado")

    if not _can_edit(user, existing):
        raise HTTPException(status_code=403, detail="No tienes permiso para editar este evento")

    updates = {k: v for k, v in data.dict().items() if v is not None}
    if not updates:
        return existing

    if "category" in updates and "color" not in updates:
        updates["color"] = CATEGORY_COLORS.get(updates["category"], existing.get("color", "#3b82f6"))

    updates["updated_at"] = datetime.now(timezone.utc).isoformat()
    await db.agenda_events.update_one({"event_id": event_id}, {"$set": updates})

    updated = await db.agenda_events.find_one({"event_id": event_id}, {"_id": 0})
    await log_activity(user, "agenda_event_updated", {
        "event_id":      event_id,
        "changed_fields": list(updates.keys()),
    })
    return updated


@router.delete("/events/{event_id}")
async def delete_event(request: Request, event_id: str):
    user = await require_auth(request)
    existing = await db.agenda_events.find_one({"event_id": event_id}, {"_id": 0})
    if not existing:
        raise HTTPException(status_code=404, detail="Evento no encontrado")

    if not _can_edit(user, existing):
        raise HTTPException(status_code=403, detail="No tienes permiso para eliminar este evento")

    await db.agenda_events.delete_one({"event_id": event_id})
    await log_activity(user, "agenda_event_deleted", {
        "event_id": event_id,
        "title":    existing.get("title"),
    })
    return {"status": "deleted", "event_id": event_id}


@router.get("/events/today")
async def get_today_events(request: Request):
    """Widget de hoy — aplica las mismas reglas de visibilidad."""
    user = await require_auth(request)
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    start = f"{today}T00:00"
    end   = f"{today}T23:59"

    date_q = {
        "$or": [
            {"start_dt": {"$gte": start, "$lte": end}},
            {"end_dt":   {"$gte": start, "$lte": end}},
            {"start_dt": {"$lte": start}, "end_dt": {"$gte": end}},
        ]
    }

    if _is_admin(user):
        query = date_q
    else:
        query = {
            "$and": [
                date_q,
                {"$or": [
                    {"visibility": "team"},
                    {"visibility": {"$exists": False}},
                    {"created_by": user["user_id"]},
                ]},
            ]
        }

    cursor = db.agenda_events.find(query, {"_id": 0}).sort("start_dt", 1)
    events = await cursor.to_list(length=100)
    return events
