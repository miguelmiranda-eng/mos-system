"""Automations routes: CRUD + automation engine."""
from fastapi import APIRouter, HTTPException, Request
from deps import db, require_auth, log_activity, AutomationCreate, logger
from datetime import datetime, timezone
import uuid, os, httpx, asyncio
import resend

router = APIRouter(prefix="/api/automations")

resend.api_key = os.environ.get('RESEND_API_KEY', '')
SENDER_EMAIL = os.environ.get('SENDER_EMAIL', 'onboarding@resend.dev')

@router.get("")
async def get_automations(request: Request):
    await require_auth(request)
    automations = await db.automations.find({}, {"_id": 0}).to_list(100)
    return automations

@router.post("")
async def create_automation(automation: AutomationCreate, request: Request):
    user = await require_auth(request)
    automation_id = f"auto_{uuid.uuid4().hex[:12]}"
    automation_doc = {
        "automation_id": automation_id, "name": automation.name,
        "trigger_type": automation.trigger_type, "trigger_conditions": automation.trigger_conditions,
        "action_type": automation.action_type, "action_params": automation.action_params,
        "is_active": automation.is_active, "boards": automation.boards or [],
        "created_at": datetime.now(timezone.utc).isoformat()
    }
    await db.automations.insert_one(automation_doc)
    await log_activity(user, "create_automation", {"automation_id": automation_id, "name": automation.name})
    return {k: v for k, v in automation_doc.items() if k != "_id"}

@router.put("/{automation_id}")
async def update_automation(automation_id: str, automation: AutomationCreate, request: Request):
    user = await require_auth(request)
    update_data = automation.model_dump()
    update_data["updated_at"] = datetime.now(timezone.utc).isoformat()
    result = await db.automations.update_one({"automation_id": automation_id}, {"$set": update_data})
    if result.matched_count == 0:
        raise HTTPException(status_code=404, detail="Automation not found")
    await log_activity(user, "update_automation", {"automation_id": automation_id})
    updated = await db.automations.find_one({"automation_id": automation_id}, {"_id": 0})
    return updated

@router.delete("/{automation_id}")
async def delete_automation(automation_id: str, request: Request):
    user = await require_auth(request)
    result = await db.automations.delete_one({"automation_id": automation_id})
    if result.deleted_count == 0:
        raise HTTPException(status_code=404, detail="Automation not found")
    await log_activity(user, "delete_automation", {"automation_id": automation_id})
    return {"message": "Automation deleted"}

# ==================== AUTOMATION ENGINE ====================

async def run_automations(trigger_type, target_obj, user, context=None, obj_type="order"):
    context = context or {}
    executed = []
    automations = await db.automations.find({"trigger_type": trigger_type, "is_active": True}, {"_id": 0}).to_list(100)
    
    if not target_obj:
        logger.warning(f"run_automations called with None object for trigger {trigger_type}")
        return executed

    for automation in automations:
        try:
            # Filter by boards if specified (only for orders)
            if obj_type == "order":
                auto_boards = automation.get("boards") or []
                order_board = target_obj.get("board", "")
                if auto_boards and order_board not in auto_boards:
                    continue
            
            if check_conditions(automation["trigger_conditions"], target_obj, context):
                await execute_action(automation["action_type"], automation["action_params"], target_obj, user)
                executed.append({
                    "name": automation["name"], 
                    "action": automation["action_type"], 
                    "params": automation["action_params"]
                })
                
                # Log trigger
                obj_id = target_obj.get("order_id") or target_obj.get("invoice_id")
                await log_activity(user, "automation_triggered", {
                    "automation_id": automation["automation_id"], 
                    "automation_name": automation["name"], 
                    "target_id": obj_id,
                    "target_type": obj_type
                })
        except Exception as e:
            logger.error(f"Automation error in {automation.get('name')}: {e}")
            
    return executed

def check_conditions(conditions, order, context):
    watch_field = conditions.get("watch_field")
    watch_value = conditions.get("watch_value")
    if watch_field and watch_value:
        changed_fields = context.get("changed_fields", [])
        if watch_field not in changed_fields:
            return False
        # Special condition: date_updated — just needs to be changed (any value)
        if watch_value == "date_updated":
            pass  # field was changed, that's enough
        # Special condition: is_empty — field must be empty/null after change
        elif watch_value == "is_empty":
            val = order.get(watch_field)
            if val is not None and str(val).strip() != "":
                return False
        # Special condition: not_empty — field must have a value after change
        elif watch_value == "not_empty":
            val = order.get(watch_field)
            if val is None or str(val).strip() == "":
                return False
        else:
            if not _values_match(order.get(watch_field), watch_value):
                return False
    for field, expected in conditions.items():
        if not expected or field in ("watch_field", "watch_value", "advanced"):
            continue
        if field == "from_board" and context.get("from_board") != expected:
            return False
        if field == "to_board" and context.get("to_board") != expected:
            return False
        if field in order and not _values_match(order.get(field), expected):
            return False
    # Condiciones avanzadas con operadores (Fase 3, Track 2).
    if not _advanced_match(conditions, order):
        return False
    return True

def _values_match(actual, expected):
    """Compare values flexibly: handles bool vs string ('true'/'false'), case-insensitive strings."""
    if actual is None and expected is None:
        return True
    if actual is None or expected is None:
        return False
    # Bool to string comparison
    if isinstance(actual, bool):
        return str(actual).lower() == str(expected).lower()
    if isinstance(expected, bool):
        return str(actual).lower() == str(expected).lower()
    # String comparison (case-insensitive)
    return str(actual).strip().lower() == str(expected).strip().lower()


# ── Operadores de comparación (Fase 3, Track 2) ──────────────────────────────
# Las condiciones "avanzadas" (lista trigger_conditions.advanced = [{field, op,
# value}]) permiten más que igualdad: >, <, ≥, ≤, contiene, en-lista, seteado.
# A diferencia del filtro plano {campo: valor} (que deja pasar un campo AUSENTE,
# ver check_conditions L126), aquí el operador manda: eq sobre un campo ausente
# NO casa. Compatibilidad: reglas viejas no traen `advanced` y no cambian.
def _num(v):
    """Valor numérico best-effort ('1,500' -> 1500.0), o None si no es número."""
    try:
        return float(str(v).replace(",", "").strip())
    except (TypeError, ValueError):
        return None


def _compare(actual, op, expected) -> bool:
    op = (op or "eq").strip().lower()
    if op in ("is_set", "not_empty"):
        return actual is not None and str(actual).strip() != ""
    if op in ("not_set", "is_empty"):
        return actual is None or str(actual).strip() == ""
    if op == "eq":
        return _values_match(actual, expected)
    if op == "ne":
        return not _values_match(actual, expected)
    if op == "contains":
        return expected not in (None, "") and str(expected).strip().lower() in str(actual or "").lower()
    if op == "in":
        vals = [x.strip().lower() for x in str(expected or "").split(",") if x.strip()]
        return str(actual or "").strip().lower() in vals
    if op in ("gt", "lt", "gte", "lte"):
        na, ne = _num(actual), _num(expected)
        if na is None or ne is None:
            return False
        return {"gt": na > ne, "lt": na < ne, "gte": na >= ne, "lte": na <= ne}[op]
    return False


def _advanced_match(conditions_or_cond: dict, order: dict) -> bool:
    """Evalúa la lista `advanced` (AND). Vacía/ausente -> True (no filtra)."""
    for c in (conditions_or_cond.get("advanced") or []):
        fld = c.get("field")
        if not fld:
            continue
        if not _compare(order.get(fld), c.get("op"), c.get("value")):
            return False
    return True


# ── GUARDAS / VALIDACIONES (Fase 2) ──────────────────────────────────────────
# Reglas que BLOQUEAN un cambio de status o de tablero hasta que se cumple un
# requisito (foto de evidencia, campo lleno, otro badge en estado X). A
# diferencia del motor normal (run_automations, que dispara efectos DESPUÉS del
# cambio), las guardas se evalúan ANTES y pueden rechazar la operación.
#
# Se guardan en la MISMA colección db.automations con trigger_type "guard":
#   trigger_conditions: {
#     on: "status_change" | "move",     # qué intento vigila
#     to_status: "X" (opcional),        # solo cuando el status destino es X
#     to_board:  "Y" (opcional),        # solo cuando se mueve al tablero Y
#     <flag>: <valor>, ...              # condiciones AND (ESTRICTAS) sobre la orden
#   }
#   action_params: {
#     requirement: "photo" | "field" | "flag",
#     field: "<campo>" (field/flag), value: "<valor>" (flag),
#     message: "texto que ve el usuario al ser bloqueado"
#   }
GUARD_TRIGGER = "guard"
_GUARD_RESERVED = {"on", "to_status", "to_board", "advanced"}


def _guard_conditions_match(cond: dict, order: dict) -> bool:
    """TODAS las condiciones (flags + avanzadas) deben casar ESTRICTO contra la
    orden. Un flag ausente NO casa (a diferencia del motor normal, que lo dejaba
    pasar): si no sabemos que la orden es 'need sample', la guarda no aplica."""
    for field, expected in cond.items():
        if field in _GUARD_RESERVED or expected in (None, ""):
            continue
        if not _values_match(order.get(field), expected):
            return False
    return _advanced_match(cond, order)


def _requirement_met_one(rq: dict, order: dict, user: dict) -> bool:
    """¿Se cumple UN requisito? photo=foto adjunta, field=campo lleno, flag=otro
    badge en estado X, role=el usuario tiene un rol permitido. Se evalúa sobre la
    vista fusionada (existing+update_data). Requisito desconocido -> True (fail-open)."""
    req = (rq.get("requirement") or "").strip().lower()
    if req == "photo":
        return len(order.get("images") or []) >= 1
    if req == "field":
        v = order.get(rq.get("field"))
        return v is not None and str(v).strip() != ""
    if req == "flag":
        return bool(_values_match(order.get(rq.get("field")), rq.get("value")))
    if req == "role":
        roles = rq.get("roles") or ([rq.get("value")] if rq.get("value") else [])
        roles = [str(r).strip().lower() for r in roles if str(r).strip()]
        return (not roles) or str((user or {}).get("role") or "").strip().lower() in roles
    return True


def _requirements_met(params: dict, order: dict, user: dict):
    """Evalúa TODOS los requisitos (AND). Compatibilidad: si no hay lista
    `requirements`, usa el requisito único (`requirement`/`field`/`value`).
    Devuelve (ok, mensaje_del_que_falló)."""
    reqs = params.get("requirements")
    if reqs:
        for rq in reqs:
            if not _requirement_met_one(rq, order, user):
                return False, rq.get("message") or params.get("message")
        return True, None
    return _requirement_met_one(params, order, user), params.get("message")


async def check_guards(existing: dict, update_data: dict, user: dict,
                       status_changing: bool = False, board_changing: bool = False,
                       new_board=None):
    """Evalúa las guardas activas contra el cambio que se intenta. Devuelve el
    mensaje de la PRIMERA guarda que bloquea, o None si todo pasa.

    `existing` = orden actual; `update_data` = cambios intentados. El requisito y
    las condiciones se evalúan sobre la fusión {**existing, **update_data}."""
    if not (status_changing or board_changing):
        return None
    try:
        guards = await db.automations.find(
            {"trigger_type": GUARD_TRIGGER, "is_active": True}
        ).to_list(200)
    except Exception as e:
        logger.error(f"[guards] no se pudieron leer las guardas: {e}")
        return None  # fail-open: un fallo de lectura no debe trabar la operación
    if not guards:
        return None

    merged = {**existing, **update_data}
    board = existing.get("board")
    new_status = update_data.get("production_status")
    for g in guards:
        cond = g.get("trigger_conditions") or {}
        on = cond.get("on")
        if on == "status_change" and not status_changing:
            continue
        if on == "move" and not board_changing:
            continue
        if on not in ("status_change", "move"):
            continue
        # Scope: el tablero ACTUAL de la orden (donde se intenta la acción).
        boards = g.get("boards") or []
        if boards and board not in boards:
            continue
        # Destino específico (opcional).
        to_status = cond.get("to_status")
        if on == "status_change" and to_status and not _values_match(new_status, to_status):
            continue
        to_board = cond.get("to_board")
        if on == "move" and to_board and not _values_match(new_board, to_board):
            continue
        # Condiciones (flags) estrictas.
        if not _guard_conditions_match(cond, merged):
            continue
        # Requisitos (uno o varios, AND).
        ok_req, why = _requirements_met(g.get("action_params") or {}, merged, user)
        if not ok_req:
            msg = why or f"Acción bloqueada por la regla '{g.get('name', '')}'."
            logger.info(f"[guards] bloqueada orden {existing.get('order_number')} por '{g.get('name')}'")
            return msg
    return None

def _fmt(tpl, order):
    """Rellena una plantilla con los campos de la orden ('{order_number}'),
    tolerante a campos faltantes o None (a diferencia de un .format(**order) crudo,
    que revienta con KeyError)."""
    try:
        return (tpl or "").format(**{k: ("" if v is None else v) for k, v in (order or {}).items()})
    except Exception:
        return tpl or ""


async def execute_action(action_type, params, target_obj, user=None):
    # Multi-acción (Fase 3, Track 3): una regla ejecuta VARIAS acciones en orden.
    # No se anida (un paso "multi" se ignora) para evitar recursión.
    if action_type == "multi":
        for step in (params.get("actions") or []):
            st = step.get("action_type")
            if not st or st == "multi":
                continue
            try:
                await execute_action(st, step.get("action_params") or {}, target_obj, user)
            except Exception as e:
                logger.error(f"[automation] sub-acción {st} falló: {e}")
        return
    if action_type == "send_email":
        await send_automation_email(params, target_obj)
    elif action_type == "move_board":
        target_board = params.get("target_board")
        if target_board and "order_id" in target_obj:
            oid = target_obj["order_id"]
            # Registrar el salto de tablero en la vida de la orden. Antes la
            # automatizacion movia con un update silencioso: el historial solo
            # mostraba "Automatizacion ejecutada" sin de-donde-a-donde, y el
            # equipo reportaba que "no se registra cuando se mueve de tablero".
            prev = await db.orders.find_one(
                {"order_id": oid}, {"_id": 0, "board": 1, "order_number": 1})
            old_board = (prev or {}).get("board")
            if old_board != target_board:
                await db.orders.update_one(
                    {"order_id": oid},
                    {"$set": {"board": target_board,
                              "updated_at": datetime.now(timezone.utc).isoformat()}})
                actor = user or {"user_id": "automation", "name": "Automatización",
                                 "email": "system@prosper-mfg.com"}
                await log_activity(
                    actor, "move_order",
                    {"order_id": oid,
                     "order_number": (prev or {}).get("order_number") or target_obj.get("order_number"),
                     "from_board": old_board, "to_board": target_board, "via": "automation"},
                    previous_data={"order_id": oid, "fields": {"board": old_board}})
    elif action_type == "assign_field" or action_type == "change_status":
        field = params.get("field")
        value = params.get("value")
        if field and value:
            # Determine collection
            collection = db.orders if "order_id" in target_obj else db.invoices
            id_key = "order_id" if "order_id" in target_obj else "invoice_id"
            # Igual que el salto de tablero: registrar el cambio en la vida de la
            # orden (antes/despues) en vez de escribir en silencio. Si el valor ya
            # coincide, no se reescribe ni se ensucia el historial.
            prev = await collection.find_one(
                {id_key: target_obj[id_key]}, {"_id": 0, field: 1, "order_number": 1})
            old_value = (prev or {}).get(field)
            if old_value != value:
                now = datetime.now(timezone.utc).isoformat()
                set_doc = {field: value, "updated_at": now}
                # Sella cuando entro al estatus de produccion (igual que el update
                # manual): Final Bill lee production_status_at y no debe quedar sin
                # el solo porque el cambio lo hizo una regla.
                if id_key == "order_id" and field == "production_status":
                    set_doc["production_status_at"] = now
                await collection.update_one({id_key: target_obj[id_key]}, {"$set": set_doc})
                actor = user or {"user_id": "automation", "name": "Automatización",
                                 "email": "system@prosper-mfg.com"}
                await log_activity(
                    actor, "update_order",
                    {"order_id": target_obj.get("order_id"),
                     "order_number": (prev or {}).get("order_number") or target_obj.get("order_number"),
                     "changed_fields": [field],
                     "changes": {field: {"from": old_value, "to": value}},
                     "via": "automation"},
                    previous_data={"order_id": target_obj.get("order_id"),
                                   "fields": {field: old_value}})
    elif action_type == "add_comment":
        # Deja un comentario/nota en la orden (mismo formato que db.comments).
        if "order_id" in target_obj:
            actor = user or {"user_id": "automation", "name": "Automatización"}
            now = datetime.now(timezone.utc).isoformat()
            await db.comments.insert_one({
                "comment_id": f"c_{uuid.uuid4().hex[:12]}",
                "order_id": target_obj["order_id"],
                "content": _fmt(params.get("content"), target_obj) or "(automatización)",
                "parent_id": None,
                "user_id": actor.get("user_id", "automation"),
                "user_name": actor.get("name", "Automatización"),
                "mentions": [],
                "created_at": now,
                "via": "automation",
            })
    elif action_type == "set_date":
        # Fija un campo de fecha: hoy, o hoy+N días (mode="offset"). Reusa la
        # escritura de assign_field (historial + dedup).
        field = params.get("field")
        if field and "order_id" in target_obj:
            from datetime import date, timedelta
            try:
                days = int(params.get("days") or 0)
            except (TypeError, ValueError):
                days = 0
            d = date.today() + (timedelta(days=days) if (params.get("mode") == "offset") else timedelta(0))
            await execute_action("assign_field", {"field": field, "value": d.isoformat()}, target_obj, user)
    elif action_type == "notify_push":
        # Notificación web-push (canal real, el mismo que usa el WMS).
        try:
            from services.push_notify import send_push_to_all
            title = _fmt(params.get("title") or "MOS", target_obj)
            body = _fmt(params.get("message") or "", target_obj)
            await send_push_to_all(db, title, body, url=params.get("url") or "/dashboard", tag="automation")
        except Exception as e:
            logger.error(f"[automation] notify_push falló: {e}")
    elif action_type == "notify_slack":
        await send_slack_notification(params, target_obj)

async def send_automation_email(params, order):
    if not resend.api_key:
        logger.warning("Resend API key not configured")
        return
    try:
        email_params = {"from": SENDER_EMAIL, "to": [params.get("to_email", "")], "subject": params.get("subject", "CRM Notification").format(**order), "html": params.get("html_content", f"<p>Order {order.get('order_number')} updated</p>")}
        await asyncio.to_thread(resend.Emails.send, email_params)
    except Exception as e:
        logger.error(f"Email send error: {e}")

async def send_slack_notification(params, order):
    webhook_url = params.get("webhook_url") or os.environ.get("SLACK_WEBHOOK_URL")
    if not webhook_url:
        logger.warning("Slack webhook URL not configured")
        return
    try:
        message = params.get("message", f"Order {order.get('order_number')} updated")
        async with httpx.AsyncClient() as client_http:
            await client_http.post(webhook_url, json={"text": message.format(**order)})
    except Exception as e:
        logger.error(f"Slack notification error: {e}")
