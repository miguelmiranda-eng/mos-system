"""Production logs, gantt data, capacity plan, email routes."""
from fastapi import APIRouter, HTTPException, Request
from deps import db, require_auth, require_admin, log_activity, ProductionLogCreate, EmailRequest, MACHINES, logger
from ws_manager import ws_manager
from datetime import datetime, timezone
import uuid, os, asyncio
import resend

router = APIRouter()

resend.api_key = os.environ.get('RESEND_API_KEY', '')
SENDER_EMAIL = os.environ.get('SENDER_EMAIL', 'onboarding@resend.dev')

# ==================== OPERATORS CRUD ====================

@router.get("/api/operators")
async def list_operators(request: Request):
    await require_auth(request)
    operators = await db.operators.find({}, {"_id": 0}).sort("name", 1).to_list(500)
    return operators

@router.post("/api/operators")
async def create_operator(request: Request):
    user = await require_admin(request)
    body = await request.json()
    name = (body.get("name") or "").strip()
    if not name:
        raise HTTPException(status_code=400, detail="Operator name is required")
    existing = await db.operators.find_one({"name": {"$regex": f"^{name}$", "$options": "i"}}, {"_id": 0})
    if existing:
        raise HTTPException(status_code=400, detail="Operator already exists")
    doc = {
        "operator_id": f"op_{uuid.uuid4().hex[:12]}",
        "name": name,
        "active": True,
        "created_at": datetime.now(timezone.utc).isoformat()
    }
    await db.operators.insert_one(doc)
    await log_activity(user, "create_operator", {"name": name})
    return {k: v for k, v in doc.items() if k != "_id"}

@router.put("/api/operators/{operator_id}")
async def update_operator(operator_id: str, request: Request):
    user = await require_admin(request)
    body = await request.json()
    existing = await db.operators.find_one({"operator_id": operator_id}, {"_id": 0})
    if not existing:
        raise HTTPException(status_code=404, detail="Operator not found")
    update_data = {}
    if "name" in body:
        name = (body["name"] or "").strip()
        if not name:
            raise HTTPException(status_code=400, detail="Name cannot be empty")
        dup = await db.operators.find_one({"name": {"$regex": f"^{name}$", "$options": "i"}, "operator_id": {"$ne": operator_id}}, {"_id": 0})
        if dup:
            raise HTTPException(status_code=400, detail="Operator name already exists")
        update_data["name"] = name
    if "active" in body:
        update_data["active"] = bool(body["active"])
    if update_data:
        await db.operators.update_one({"operator_id": operator_id}, {"$set": update_data})
        await log_activity(user, "update_operator", {"operator_id": operator_id, **update_data})
    updated = await db.operators.find_one({"operator_id": operator_id}, {"_id": 0})
    return updated

@router.delete("/api/operators/{operator_id}")
async def delete_operator(operator_id: str, request: Request):
    user = await require_admin(request)
    existing = await db.operators.find_one({"operator_id": operator_id}, {"_id": 0})
    if not existing:
        raise HTTPException(status_code=404, detail="Operator not found")
    await db.operators.delete_one({"operator_id": operator_id})
    await log_activity(user, "delete_operator", {"operator_id": operator_id, "name": existing.get("name")})
    return {"message": "Operator deleted"}

@router.post("/api/production-logs")
async def create_production_log(log: ProductionLogCreate, request: Request):
    user = await require_auth(request)
    order = await db.orders.find_one({"order_id": log.order_id}, {"_id": 0})
    if not order:
        raise HTTPException(status_code=404, detail="Order not found")
    if log.machine not in MACHINES:
        raise HTTPException(status_code=400, detail=f"Invalid machine")
    log_doc = {
        "log_id": f"plog_{uuid.uuid4().hex[:12]}", "order_id": log.order_id,
        "order_number": order.get("order_number", ""), "quantity_produced": log.quantity_produced,
        "machine": log.machine, "setup": log.setup or 0,
        "operator": log.operator or user.get("name", ""),
        "shift": log.shift or "",
        "design_type": log.design_type or "",
        "stop_cause": log.stop_cause or "",
        "supervisor": log.supervisor or "",
        "client": order.get("client", ""),
        "user_id": user.get("user_id"), "user_name": user.get("name"), "user_email": user.get("email"),
        "created_at": datetime.now(timezone.utc).isoformat()
    }
    await db.production_logs.insert_one(log_doc)
    
    try:
        await log_activity(user, "register_production", {
            "order_id": log.order_id, 
            "order_number": order.get("order_number"), 
            "quantity_produced": log.quantity_produced, 
            "machine": log.machine
        })
    except Exception as e:
        logger.error(f"Error logging production activity: {e}")

    await ws_manager.broadcast("production_update", {"order_id": log.order_id})
    return {k: v for k, v in log_doc.items() if k != "_id"}

@router.get("/api/production-logs/{order_id}")
async def get_production_logs(order_id: str, request: Request):
    await require_auth(request)
    logs = await db.production_logs.find({"order_id": order_id}, {"_id": 0}).sort("created_at", -1).to_list(500)
    total_produced = sum(entry.get("quantity_produced", 0) for entry in logs)
    return {"logs": logs, "total_produced": total_produced}

@router.get("/api/production-summary")
async def get_production_summary(request: Request):
    await require_auth(request)
    pipeline = [{"$group": {"_id": "$order_id", "total_produced": {"$sum": "$quantity_produced"}, "log_count": {"$sum": 1}}}]
    results = await db.production_logs.aggregate(pipeline).to_list(10000)
    summary = {r["_id"]: {"total_produced": r["total_produced"], "log_count": r["log_count"]} for r in results}
    return summary

@router.delete("/api/production-logs/{log_id}")
async def delete_production_log(log_id: str, request: Request):
    user = await require_admin(request)
    existing = await db.production_logs.find_one({"log_id": log_id}, {"_id": 0})
    if not existing:
        raise HTTPException(status_code=404, detail="Production log not found")
    await db.production_logs.delete_one({"log_id": log_id})
    await log_activity(user, "delete_production_log", {"log_id": log_id, "order_id": existing.get("order_id"), "quantity_produced": existing.get("quantity_produced")})
    return {"message": "Production log deleted"}

# ==================== GANTT & CAPACITY PLAN ====================

@router.get("/api/gantt-data")
async def get_gantt_data(request: Request, start_date: str = None, end_date: str = None):
    await require_auth(request)
    query = {}
    if start_date:
        query["created_at"] = {"$gte": start_date}
    if end_date:
        query.setdefault("created_at", {})["$lte"] = end_date
    logs = await db.production_logs.find(query, {"_id": 0}).sort("created_at", 1).to_list(10000)
    all_orders = await db.orders.find({"board": {"$ne": "PAPELERA DE RECICLAJE"}}, {"_id": 0, "order_id": 1, "order_number": 1, "client": 1, "quantity": 1, "board": 1, "priority": 1}).to_list(10000)
    orders_map = {o["order_id"]: o for o in all_orders}
    prod_summary = {}
    for log in logs:
        key = (log["machine"], log["order_id"])
        if key not in prod_summary:
            prod_summary[key] = {"machine": log["machine"], "order_id": log["order_id"], "order_number": log.get("order_number", ""), "total_produced": 0, "first_date": log["created_at"], "last_date": log["created_at"], "log_count": 0}
        prod_summary[key]["total_produced"] += log.get("quantity_produced", 0)
        prod_summary[key]["last_date"] = log["created_at"]
        prod_summary[key]["log_count"] += 1
    completed_bars = []
    for (machine, order_id), data in prod_summary.items():
        order_info = orders_map.get(order_id, {})
        completed_bars.append({
            "machine": machine, "order_id": order_id, "order_number": data["order_number"],
            "client": order_info.get("client", ""), "quantity_total": order_info.get("quantity", 0),
            "quantity_produced": data["total_produced"], "start_date": data["first_date"],
            "end_date": data["last_date"], "log_count": data["log_count"],
            "status": "completed" if data["total_produced"] >= order_info.get("quantity", 0) else "in_progress",
            "priority": order_info.get("priority", ""), "board": order_info.get("board", "")
        })
    total_by_order = {}
    for log in await db.production_logs.find({}, {"_id": 0, "order_id": 1, "quantity_produced": 1}).to_list(10000):
        total_by_order[log["order_id"]] = total_by_order.get(log["order_id"], 0) + log.get("quantity_produced", 0)
    pending_orders = []
    for o in all_orders:
        produced = total_by_order.get(o["order_id"], 0)
        qty = o.get("quantity", 0)
        if qty > 0 and produced < qty:
            pending_orders.append({"order_id": o["order_id"], "order_number": o.get("order_number", ""), "client": o.get("client", ""), "quantity_total": qty, "quantity_produced": produced, "remaining": qty - produced, "priority": o.get("priority", ""), "board": o.get("board", "")})
    total_pieces_system = sum(o.get("quantity", 0) for o in all_orders)
    return {"bars": completed_bars, "pending": pending_orders, "total_pieces_system": total_pieces_system}

@router.get("/api/capacity-plan")
async def get_capacity_plan(request: Request):
    await require_auth(request)
    # Get all active orders with their boards
    all_orders = await db.orders.find({"board": {"$ne": "PAPELERA DE RECICLAJE"}}, {"_id": 0, "order_id": 1, "quantity": 1, "board": 1, "order_number": 1, "client": 1, "priority": 1}).to_list(10000)
    orders_map = {o["order_id"]: o for o in all_orders}
    # Orders physically in each machine board
    machine_boards = {f"MAQUINA{i}" for i in range(1, 15)}
    orders_by_machine = {}
    for o in all_orders:
        if o.get("board") in machine_boards:
            orders_by_machine.setdefault(o["board"], []).append(o)
    # Completed orders
    completed_orders = [o for o in all_orders if o.get("board") == "COMPLETOS"]
    total_completed = sum(o.get("quantity", 0) for o in completed_orders)
    in_production_total = sum(o.get("quantity", 0) for o in all_orders if o.get("board") in machine_boards)
    # Production logs only for orders physically in machine boards right now
    machine_order_ids = [o["order_id"] for o in all_orders if o.get("board") in machine_boards]
    # Get production stats only for current machine orders (for avg_daily, active_days)
    pipeline_daily = []
    if machine_order_ids:
        pipeline_daily = [
            {"$match": {"order_id": {"$in": machine_order_ids}}},
            {"$group": {"_id": {"machine": "$machine", "date": {"$substr": ["$created_at", 0, 10]}}, "daily_produced": {"$sum": "$quantity_produced"}}},
            {"$group": {"_id": "$_id.machine", "active_days": {"$sum": 1}, "avg_daily_production": {"$avg": "$daily_produced"}, "max_daily_production": {"$max": "$daily_produced"}}}
        ]
    stats_map = {}
    if pipeline_daily:
        machine_stats = await db.production_logs.aggregate(pipeline_daily).to_list(100)
        stats_map = {s["_id"]: s for s in machine_stats}
    # Build machine plan based on PHYSICAL orders in each machine board
    # Get total produced per order from production logs
    all_machine_order_ids = [o["order_id"] for o in all_orders if o.get("board") in machine_boards]
    produced_by_order = {}
    if all_machine_order_ids:
        prod_pipeline = [
            {"$match": {"order_id": {"$in": all_machine_order_ids}}},
            {"$group": {"_id": "$order_id", "total_produced": {"$sum": "$quantity_produced"}}}
        ]
        prod_results = await db.production_logs.aggregate(prod_pipeline).to_list(10000)
        produced_by_order = {r["_id"]: r["total_produced"] for r in prod_results}

    machines_plan = []
    for i in range(1, 15):
        machine_name = f"MAQUINA{i}"
        physical_orders = orders_by_machine.get(machine_name, [])
        stats = stats_map.get(machine_name, {})
        avg_daily = stats.get("avg_daily_production", 0)
        # Calculate remaining per order: quantity - produced
        orders_detail = []
        total_remaining = 0
        for o in physical_orders:
            qty = o.get("quantity", 0)
            produced = produced_by_order.get(o["order_id"], 0)
            rem = max(0, qty - produced)
            total_remaining += rem
            orders_detail.append({
                "order_id": o["order_id"], "order_number": o.get("order_number", ""),
                "remaining": rem, "total": qty, "produced": produced,
                "client": o.get("client", ""), "priority": o.get("priority", "")
            })
        est_days = total_remaining / avg_daily if avg_daily > 0 and total_remaining > 0 else 0
        load_status = "idle" if len(physical_orders) == 0 else "green" if est_days <= 3 else "yellow" if est_days <= 7 else "red"
        machines_plan.append({
            "machine": machine_name, "total_produced": 0,
            "active_days": stats.get("active_days", 0), "avg_daily_production": round(avg_daily, 1),
            "max_daily_production": stats.get("max_daily_production", 0), "remaining_pieces": total_remaining,
            "estimated_days": round(est_days, 1), "load_status": load_status,
            "orders_in_progress": orders_detail, "order_count": len(physical_orders)
        })
    return {
        "machines": machines_plan,
        "total_pieces_system": sum(o.get("quantity", 0) for o in all_orders),
        "total_completed": total_completed,
        "in_production": in_production_total
    }

# ==================== PRODUCTION ANALYTICS ====================

@router.get("/api/production-analytics")
async def get_production_analytics(request: Request, date_from: str = None, date_to: str = None, preset: str = None, machine: str = None, operator: str = None, client: str = None, order_number: str = None):
    await require_auth(request)
    from datetime import timedelta
    now = datetime.now(timezone.utc)
    query = {}
    # Date filtering
    if preset:
        if preset == 'today':
            start = now.replace(hour=0, minute=0, second=0, microsecond=0)
            query["created_at"] = {"$gte": start.isoformat()}
        elif preset == 'yesterday':
            start = (now - timedelta(days=1)).replace(hour=0, minute=0, second=0, microsecond=0)
            end = now.replace(hour=0, minute=0, second=0, microsecond=0)
            query["created_at"] = {"$gte": start.isoformat(), "$lt": end.isoformat()}
        elif preset == 'week':
            start = (now - timedelta(days=7)).replace(hour=0, minute=0, second=0, microsecond=0)
            query["created_at"] = {"$gte": start.isoformat()}
        elif preset == 'month':
            start = (now - timedelta(days=30)).replace(hour=0, minute=0, second=0, microsecond=0)
            query["created_at"] = {"$gte": start.isoformat()}
    elif date_from or date_to:
        date_q = {}
        if date_from: date_q["$gte"] = date_from + "T00:00:00"
        if date_to: date_q["$lte"] = date_to + "T23:59:59"
        if date_q: query["created_at"] = date_q
    if machine: query["machine"] = machine
    if operator: query["operator"] = {"$regex": operator, "$options": "i"}
    if client: query["client"] = {"$regex": client, "$options": "i"}
    if order_number: query["order_number"] = {"$regex": order_number, "$options": "i"}
    logs = await db.production_logs.find(query, {"_id": 0}).sort("created_at", -1).to_list(50000)
    # Get target qty for orders
    order_ids = list(set(l.get("order_id") for l in logs if l.get("order_id")))
    orders = await db.orders.find({"order_id": {"$in": order_ids}}, {"_id": 0, "order_id": 1, "quantity": 1}).to_list(10000)
    order_qty_map = {o["order_id"]: o.get("quantity", 0) for o in orders}
    # Metrics
    total_produced = sum(l.get("quantity_produced", 0) for l in logs)
    total_target = sum(order_qty_map.get(l.get("order_id"), 0) for l in logs)
    avg_setup = sum(l.get("setup", 0) for l in logs) / max(len(logs), 1)
    # By machine
    by_machine = {}
    for l in logs:
        m = l.get("machine", "?")
        if m not in by_machine: by_machine[m] = {"produced": 0, "setup_total": 0, "count": 0}
        by_machine[m]["produced"] += l.get("quantity_produced", 0)
        by_machine[m]["setup_total"] += l.get("setup", 0)
        by_machine[m]["count"] += 1
    machines_data = [{"machine": k, "produced": v["produced"], "avg_setup": round(v["setup_total"] / max(v["count"], 1), 1), "count": v["count"]} for k, v in sorted(by_machine.items())]
    # By operator
    by_operator = {}
    for l in logs:
        op = l.get("operator") or l.get("user_name", "?")
        if op not in by_operator: by_operator[op] = {"produced": 0, "count": 0}
        by_operator[op]["produced"] += l.get("quantity_produced", 0)
        by_operator[op]["count"] += 1
    operators_data = [{"operator": k, "produced": v["produced"], "count": v["count"]} for k, v in sorted(by_operator.items(), key=lambda x: x[1]["produced"], reverse=True)]
    # By shift
    by_shift = {}
    for l in logs:
        sh = l.get("shift") or "Sin turno"
        if sh not in by_shift: by_shift[sh] = {"produced": 0, "count": 0}
        by_shift[sh]["produced"] += l.get("quantity_produced", 0)
        by_shift[sh]["count"] += 1
    shifts_data = [{"shift": k, "produced": v["produced"], "count": v["count"]} for k, v in by_shift.items()]
    # By client
    by_client = {}
    for l in logs:
        cl = l.get("client") or "Sin cliente"
        if cl not in by_client: by_client[cl] = {"produced": 0, "count": 0}
        by_client[cl]["produced"] += l.get("quantity_produced", 0)
        by_client[cl]["count"] += 1
    clients_data = [{"client": k, "produced": v["produced"], "count": v["count"]} for k, v in sorted(by_client.items(), key=lambda x: x[1]["produced"], reverse=True)]
    # By PO (order_number)
    by_po = {}
    for l in logs:
        po = l.get("order_number") or "?"
        if po not in by_po: by_po[po] = {"produced": 0, "target": order_qty_map.get(l.get("order_id"), 0), "count": 0}
        by_po[po]["produced"] += l.get("quantity_produced", 0)
        by_po[po]["count"] += 1
    po_data = [{"order_number": k, "produced": v["produced"], "target": v["target"], "count": v["count"]} for k, v in sorted(by_po.items(), key=lambda x: x[1]["produced"], reverse=True)]
    # Hourly trend
    by_hour = {}
    for l in logs:
        try:
            h = l.get("created_at", "")[:13]
            if h not in by_hour: by_hour[h] = 0
            by_hour[h] += l.get("quantity_produced", 0)
        except: pass
    hourly_data = [{"hour": k, "produced": v} for k, v in sorted(by_hour.items())]
    # Distinct values for filter dropdowns
    distinct_machines = sorted(set(l.get("machine", "") for l in logs if l.get("machine")))
    distinct_operators = sorted(set((l.get("operator") or l.get("user_name", "")) for l in logs))
    distinct_clients = sorted(set(l.get("client", "") for l in logs if l.get("client")))

    # Remaining pieces: total_target - total_produced
    total_remaining = max(total_target - total_produced, 0)

    # By production_status: group ALL active orders by production_status, sum quantity
    all_active_orders = await db.orders.find(
        {"board": {"$nin": ["PAPELERA DE RECICLAJE", "COMPLETOS"]}},
        {"_id": 0, "production_status": 1, "quantity": 1}
    ).to_list(50000)
    by_prod_status = {}
    for o in all_active_orders:
        ps = o.get("production_status") or "Sin estado"
        qty = o.get("quantity", 0) or 0
        if ps not in by_prod_status:
            by_prod_status[ps] = {"count": 0, "quantity": 0}
        by_prod_status[ps]["count"] += 1
        by_prod_status[ps]["quantity"] += qty
    prod_status_data = [{"status": k, "count": v["count"], "quantity": v["quantity"]} for k, v in sorted(by_prod_status.items(), key=lambda x: x[1]["quantity"], reverse=True)]

    return {
        "total_produced": total_produced, "total_target": total_target,
        "total_remaining": total_remaining,
        "efficiency": round(total_produced / max(total_target, 1) * 100, 1),
        "avg_setup": round(avg_setup, 1), "total_logs": len(logs),
        "by_machine": machines_data, "by_operator": operators_data,
        "by_shift": shifts_data, "by_client": clients_data,
        "by_po": po_data, "hourly_trend": hourly_data,
        "by_production_status": prod_status_data,
        "filters": {"machines": distinct_machines, "operators": distinct_operators, "clients": distinct_clients},
        "logs": logs[:200]
    }

@router.post("/api/production-report")
async def generate_production_report(request: Request):
    user = await require_auth(request)
    body = await request.json()
    fmt = body.get("format", "excel")
    filters = body.get("filters", {})
    # Build query from filters
    query = {}
    if filters.get("date_from") or filters.get("date_to"):
        dq = {}
        if filters.get("date_from"): dq["$gte"] = filters["date_from"] + "T00:00:00"
        if filters.get("date_to"): dq["$lte"] = filters["date_to"] + "T23:59:59"
        query["created_at"] = dq
    if filters.get("shift"): query["shift"] = filters["shift"]
    if filters.get("supervisor"): query["supervisor"] = {"$regex": filters["supervisor"], "$options": "i"}
    if filters.get("machine"): query["machine"] = filters["machine"]
    logs = await db.production_logs.find(query, {"_id": 0}).sort("created_at", 1).to_list(50000)
    if fmt == "pdf":
        return await _generate_pdf_report(logs, filters)
    else:
        return await _generate_excel_report(logs, filters)

async def _generate_excel_report(logs, filters):
    import xlsxwriter, io, base64
    output = io.BytesIO()
    wb = xlsxwriter.Workbook(output, {'in_memory': True})
    ws = wb.add_worksheet("Produccion")
    bold = wb.add_format({'bold': True, 'bg_color': '#1a1a2e', 'font_color': 'white', 'border': 1})
    cell = wb.add_format({'border': 1, 'text_wrap': True, 'valign': 'vcenter'})
    headers = ['Fecha/Hora', 'Orden', 'Cliente', 'Maquina', 'Operador', 'Turno', 'Tipo Diseno', 'Cantidad', 'Setup', 'Supervisor', 'Causa Parada']
    for i, h in enumerate(headers):
        ws.write(0, i, h, bold)
        ws.set_column(i, i, 15)
    for row, l in enumerate(logs, 1):
        ws.write(row, 0, l.get("created_at", "")[:19].replace("T", " "), cell)
        ws.write(row, 1, l.get("order_number", ""), cell)
        ws.write(row, 2, l.get("client", ""), cell)
        ws.write(row, 3, l.get("machine", ""), cell)
        ws.write(row, 4, l.get("operator", l.get("user_name", "")), cell)
        ws.write(row, 5, l.get("shift", ""), cell)
        ws.write(row, 6, l.get("design_type", ""), cell)
        ws.write(row, 7, l.get("quantity_produced", 0), cell)
        ws.write(row, 8, l.get("setup", 0), cell)
        ws.write(row, 9, l.get("supervisor", ""), cell)
        ws.write(row, 10, l.get("stop_cause", ""), cell)
    wb.close()
    output.seek(0)
    data_b64 = base64.b64encode(output.read()).decode()
    return {"filename": "reporte_produccion.xlsx", "data": data_b64, "content_type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"}

async def _generate_pdf_report(logs, filters):
    from reportlab.lib.pagesizes import landscape, letter
    from reportlab.lib import colors
    from reportlab.platypus import SimpleDocTemplate, Table, TableStyle, Paragraph, Spacer
    from reportlab.lib.styles import getSampleStyleSheet
    import io, base64
    output = io.BytesIO()
    doc = SimpleDocTemplate(output, pagesize=landscape(letter), leftMargin=20, rightMargin=20, topMargin=30, bottomMargin=30)
    styles = getSampleStyleSheet()
    elements = []
    elements.append(Paragraph("REPORTE DE PRODUCCION", styles['Title']))
    filter_text = []
    if filters.get("date_from"): filter_text.append(f"Desde: {filters['date_from']}")
    if filters.get("date_to"): filter_text.append(f"Hasta: {filters['date_to']}")
    if filters.get("shift"): filter_text.append(f"Turno: {filters['shift']}")
    if filters.get("supervisor"): filter_text.append(f"Supervisor: {filters['supervisor']}")
    if filter_text:
        elements.append(Paragraph(" | ".join(filter_text), styles['Normal']))
    elements.append(Spacer(1, 12))
    headers = ['Fecha', 'Orden', 'Cliente', 'Maquina', 'Operador', 'Turno', 'Diseno', 'Cant.', 'Setup', 'Supervisor', 'Parada']
    data = [headers]
    for l in logs:
        data.append([
            l.get("created_at", "")[:16].replace("T", " "),
            l.get("order_number", ""), l.get("client", "")[:15],
            l.get("machine", "").replace("MAQUINA", "M"), l.get("operator", l.get("user_name", ""))[:15],
            l.get("shift", ""), l.get("design_type", ""),
            str(l.get("quantity_produced", 0)), str(l.get("setup", 0)),
            l.get("supervisor", "")[:15], l.get("stop_cause", "")[:20]
        ])
    t = Table(data, repeatRows=1)
    t.setStyle(TableStyle([
        ('BACKGROUND', (0, 0), (-1, 0), colors.HexColor('#1a1a2e')),
        ('TEXTCOLOR', (0, 0), (-1, 0), colors.white),
        ('FONTSIZE', (0, 0), (-1, -1), 7),
        ('FONTSIZE', (0, 0), (-1, 0), 8),
        ('FONTNAME', (0, 0), (-1, 0), 'Helvetica-Bold'),
        ('GRID', (0, 0), (-1, -1), 0.5, colors.grey),
        ('ROWBACKGROUNDS', (0, 1), (-1, -1), [colors.white, colors.HexColor('#f5f5f5')]),
        ('VALIGN', (0, 0), (-1, -1), 'MIDDLE'),
    ]))
    elements.append(t)
    # Summary
    total = sum(l.get("quantity_produced", 0) for l in logs)
    elements.append(Spacer(1, 12))
    elements.append(Paragraph(f"Total registros: {len(logs)} | Total producido: {total:,} piezas", styles['Normal']))
    doc.build(elements)
    output.seek(0)
    data_b64 = base64.b64encode(output.read()).decode()
    return {"filename": "reporte_produccion.pdf", "data": data_b64, "content_type": "application/pdf"}

# ==================== EMAIL ROUTE ====================

@router.post("/api/send-email")
async def send_email(email_request: EmailRequest, request: Request):
    user = await require_auth(request)
    if not resend.api_key:
        raise HTTPException(status_code=500, detail="Email service not configured")
    params = {"from": SENDER_EMAIL, "to": [email_request.recipient_email], "subject": email_request.subject, "html": email_request.html_content}
    try:
        email = await asyncio.to_thread(resend.Emails.send, params)
        await log_activity(user, "send_email", {"recipient": email_request.recipient_email})
        return {"status": "success", "email_id": email.get("id")}
    except Exception as e:
        logger.error(f"Email send error: {e}")
        raise HTTPException(status_code=500, detail=f"Failed to send email: {str(e)}")
