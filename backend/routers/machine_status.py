"""Estado de máquinas en vivo — reemplaza el "Recap de impresión" que se manda
a mano por WhatsApp.

Cada máquina (tablero MAQUINA<n>) tiene UN estado a la vez: corriendo, setup,
aprobación, esperando cuadre, mantenimiento, libre… (catálogo editable). Cada
cambio es un evento con hora y quién; de los eventos sale cuánto tiempo pasó
cada máquina en cada estado. Los cambios se avisan por WebSocket
(`machine_status`): las pantallas no consultan por tiempo.

Cambia el estado: admin nivel 3+. Ver: cualquiera con sesión.
"""
import re
import uuid
import zoneinfo
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, HTTPException, Request

from deps import db, require_auth, require_admin_level, get_admin_level, get_machines, machine_number
from ws_manager import ws_manager

router = APIRouter(prefix="/api/machine-status")

TZ = zoneinfo.ZoneInfo("America/Tijuana")
EDIT_LEVEL = 3
CONFIG_ID = "machine_states"
NOTE_MAX = 200

# Los 6 del recap de Karina. `builtin` no se borra (sí se puede desactivar).
DEFAULT_STATES = [
    {"key": "corriendo",     "label": "Corriendo",           "color": "#16a34a", "active": True, "builtin": True},
    {"key": "setup",         "label": "Setup",               "color": "#2563eb", "active": True, "builtin": True},
    {"key": "aprobacion",    "label": "Aprobación",          "color": "#9333ea", "active": True, "builtin": True},
    {"key": "cuadre",        "label": "Esperando cuadre",    "color": "#ea580c", "active": True, "builtin": True},
    {"key": "mantenimiento", "label": "Detenida: mantenimiento", "color": "#dc2626", "active": True, "builtin": True},
    {"key": "libre",         "label": "Libre / sin orden",   "color": "#6b7280", "active": True, "builtin": True},
]
HEX_RE = re.compile(r"^#[0-9a-fA-F]{6}$")
DONE_STATUSES = {"LISTO PARA ENVIO", "LISTO PARA INVENTARIO", "LISTO PARA FULFILLMENT"}


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _iso(d: datetime) -> str:
    return d.astimezone(timezone.utc).isoformat()


def _parse(s: str) -> datetime:
    return datetime.fromisoformat(str(s).replace("Z", "+00:00"))


async def _states() -> list:
    doc = await db.machine_status_config.find_one({"config_id": CONFIG_ID}, {"_id": 0, "states": 1})
    states = (doc or {}).get("states") or []
    if not states:
        return [dict(s) for s in DEFAULT_STATES]
    # Un builtin que falte (config vieja) se agrega al final, activo.
    keys = {s.get("key") for s in states}
    return states + [dict(s) for s in DEFAULT_STATES if s["key"] not in keys]


def _slug(label: str) -> str:
    s = re.sub(r"[^a-z0-9]+", "_", str(label).lower()).strip("_")
    return s[:30] or f"estado_{uuid.uuid4().hex[:4]}"


async def _board_orders(machines: list) -> dict:
    """Órdenes que hoy viven en cada tablero de máquina, para elegir cuál corre.
    Las ya listas van al final."""
    out = {m: [] for m in machines}
    async for o in db.orders.find(
            {"board": {"$in": machines}},
            {"_id": 0, "order_number": 1, "client": 1, "board": 1, "production_status": 1, "priority": 1}):
        out.setdefault(o["board"], []).append({
            "order_number": o.get("order_number"), "client": o.get("client") or "",
            "production_status": o.get("production_status") or "",
        })
    for m in out:
        out[m].sort(key=lambda x: (x["production_status"] in DONE_STATUSES, str(x["order_number"])))
    return out


@router.get("")
async def list_status(request: Request):
    user = await require_auth(request)
    machines = await get_machines()
    states = await _states()
    current = {d["machine"]: d async for d in db.machine_states.find({}, {"_id": 0})}
    orders = await _board_orders(machines)
    rows = []
    recap = {}
    for m in machines:
        cur = current.get(m) or {}
        key = cur.get("state")
        recap[key or "_none"] = recap.get(key or "_none", 0) + 1
        rows.append({
            "machine": m,
            "number": machine_number(m),
            "state": key,
            "since": cur.get("since"),
            "order_number": cur.get("order_number") or "",
            "client": cur.get("client") or "",
            "note": cur.get("note") or "",
            "by_name": cur.get("by_name") or "",
            "board_orders": orders.get(m, []),
        })
    return {
        "states": states,
        "machines": rows,
        "recap": recap,
        "can_edit": get_admin_level(user) >= EDIT_LEVEL,
        "now": _iso(_now()),
    }


@router.put("/states")
async def save_states(request: Request):
    """Catálogo de estados. Los builtin no se borran; los demás sí. Una llave
    en uso por una máquina tampoco se puede borrar (se desactiva)."""
    user = await require_admin_level(request, EDIT_LEVEL)
    body = await request.json()
    incoming = body.get("states")
    if not isinstance(incoming, list) or not incoming:
        raise HTTPException(400, "states debe ser una lista")
    builtin = {s["key"]: s for s in DEFAULT_STATES}
    in_use = set(await db.machine_states.distinct("state"))
    seen, out = set(), []
    for s in incoming[:40]:
        label = str((s or {}).get("label") or "").strip()[:40]
        if not label:
            raise HTTPException(400, "Cada estado necesita nombre")
        key = str(s.get("key") or "").strip() or _slug(label)
        if key in seen:
            raise HTTPException(400, f"Estado repetido: {label}")
        seen.add(key)
        color = str(s.get("color") or "").strip()
        if not HEX_RE.match(color):
            color = (builtin.get(key) or {}).get("color", "#6b7280")
        out.append({"key": key, "label": label, "color": color,
                    "active": bool(s.get("active", True)), "builtin": key in builtin})
    missing = [k for k in builtin if k not in seen]
    if missing:
        raise HTTPException(400, f"No se pueden borrar los estados base: {', '.join(missing)} (desactívalos)")
    removed_in_use = sorted(k for k in in_use if k and k not in seen)
    if removed_in_use:
        raise HTTPException(400, f"Hay máquinas en ese estado ahora: {', '.join(removed_in_use)}. Cámbialas o desactívalo.")
    await db.machine_status_config.update_one(
        {"config_id": CONFIG_ID},
        {"$set": {"config_id": CONFIG_ID, "states": out, "updated_at": _iso(_now()),
                  "updated_by": user.get("name") or user.get("email")}},
        upsert=True)
    await ws_manager.broadcast("machine_status", {"states": True})
    return {"states": out}


@router.put("/{machine}")
async def set_status(machine: str, request: Request):
    user = await require_admin_level(request, EDIT_LEVEL)
    body = await request.json()
    machine = machine.strip().upper()
    if machine not in await get_machines():
        raise HTTPException(404, f"No existe la máquina {machine}")
    key = str(body.get("state") or "").strip()
    st = next((s for s in await _states() if s["key"] == key), None)
    if not st or not st.get("active", True):
        raise HTTPException(400, "Estado no válido")
    order_number = str(body.get("order_number") or "").strip()
    note = str(body.get("note") or "").strip()[:NOTE_MAX]
    client = ""
    if order_number:
        o = await db.orders.find_one({"order_number": order_number, "board": {"$ne": "PAPELERA DE RECICLAJE"}},
                                     {"_id": 0, "client": 1})
        if not o:
            raise HTTPException(404, f"No existe la orden {order_number}")
        client = o.get("client") or ""

    now = _now()
    prev = await db.machine_states.find_one({"machine": machine}, {"_id": 0})
    if prev and prev.get("state") == key and (prev.get("order_number") or "") == order_number \
            and (prev.get("note") or "") == note:
        return {"ok": True, "unchanged": True, "machine": machine}

    by_name = user.get("name") or user.get("email") or ""
    # Cierra el evento abierto: su duración cuenta hasta este cambio.
    if prev and prev.get("event_id"):
        mins = max(0.0, (now - _parse(prev["since"])).total_seconds() / 60)
        await db.machine_state_events.update_one(
            {"event_id": prev["event_id"]},
            {"$set": {"ended_at": _iso(now), "minutes": round(mins, 1)}})
    event_id = f"mse_{uuid.uuid4().hex[:12]}"
    await db.machine_state_events.insert_one({
        "event_id": event_id, "machine": machine, "state": key, "state_label": st["label"],
        "from_state": (prev or {}).get("state"), "order_number": order_number, "client": client,
        "note": note, "started_at": _iso(now), "ended_at": None, "minutes": None,
        "by": user.get("user_id"), "by_name": by_name,
    })
    cur = {"machine": machine, "state": key, "since": _iso(now), "order_number": order_number,
           "client": client, "note": note, "by_name": by_name, "event_id": event_id}
    await db.machine_states.update_one({"machine": machine}, {"$set": cur}, upsert=True)
    await ws_manager.broadcast("machine_status", {"machine": machine, "state": key})
    return {"ok": True, **cur}


@router.get("/history")
async def history(request: Request, date: str = ""):
    """Minutos por estado y por máquina en un día de planta (Tijuana). El
    evento abierto cuenta hasta ahora; los que cruzan la medianoche se recortan."""
    await require_auth(request)
    try:
        day = datetime.strptime(date, "%Y-%m-%d").date() if date else _now().astimezone(TZ).date()
    except ValueError:
        raise HTTPException(400, "date debe ser YYYY-MM-DD")
    start = datetime(day.year, day.month, day.day, tzinfo=TZ).astimezone(timezone.utc)
    end = start + timedelta(days=1)
    now = _now()
    stop = min(end, now)
    q = {"started_at": {"$lt": _iso(end)}, "$or": [{"ended_at": None}, {"ended_at": {"$gt": _iso(start)}}]}
    totals: dict = {}
    changes: dict = {}
    async for e in db.machine_state_events.find(q, {"_id": 0}):
        a = max(_parse(e["started_at"]), start)
        b = min(_parse(e["ended_at"]) if e.get("ended_at") else now, stop)
        if b <= a:
            continue
        m = totals.setdefault(e["machine"], {})
        m[e["state"]] = round(m.get(e["state"], 0) + (b - a).total_seconds() / 60, 1)
        if _parse(e["started_at"]) >= start:
            changes[e["machine"]] = changes.get(e["machine"], 0) + 1
    machines = await get_machines()
    return {
        "date": day.isoformat(),
        "states": await _states(),
        "machines": [{"machine": m, "number": machine_number(m), "minutes": totals.get(m, {}),
                      "changes": changes.get(m, 0)} for m in machines],
    }
