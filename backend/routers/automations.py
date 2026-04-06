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

async def run_automations(trigger_type, order, user, context=None):
    context = context or {}
    executed = []
    automations = await db.automations.find({"trigger_type": trigger_type, "is_active": True}, {"_id": 0}).to_list(100)
    if not order:
        logger.warning(f"run_automations called with None order for trigger {trigger_type}")
        return executed

    order_board = order.get("board", "")
    for automation in automations:
        try:
            # Filter by boards if specified
            auto_boards = automation.get("boards") or []
            if auto_boards and order_board not in auto_boards:
                continue
            if check_conditions(automation["trigger_conditions"], order, context):
                await execute_action(automation["action_type"], automation["action_params"], order)
                executed.append({"name": automation["name"], "action": automation["action_type"], "params": automation["action_params"]})
                await log_activity(user, "automation_triggered", {"automation_id": automation["automation_id"], "automation_name": automation["name"], "order_id": order.get("order_id")})
        except Exception as e:
            logger.error(f"Automation error: {e}")
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
        if not expected or field in ("watch_field", "watch_value"):
            continue
        if field == "from_board" and context.get("from_board") != expected:
            return False
        if field == "to_board" and context.get("to_board") != expected:
            return False
        if field in order and not _values_match(order.get(field), expected):
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

async def execute_action(action_type, params, order):
    if action_type == "send_email":
        await send_automation_email(params, order)
    elif action_type == "move_board":
        target_board = params.get("target_board")
        if target_board:
            await db.orders.update_one({"order_id": order["order_id"]}, {"$set": {"board": target_board}})
    elif action_type == "assign_field":
        field = params.get("field")
        value = params.get("value")
        if field and value:
            await db.orders.update_one({"order_id": order["order_id"]}, {"$set": {field: value}})
    elif action_type == "notify_slack":
        await send_slack_notification(params, order)

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
