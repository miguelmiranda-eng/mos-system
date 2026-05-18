"""QC (Quality Control) inspection records."""
from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import StreamingResponse
from deps import db, require_auth, require_role, log_activity
from datetime import datetime, timezone
import uuid, io, csv, re

router = APIRouter(prefix="/api/qc")

WRITE_ROLES = ["supersu", "inspector_qc"]
async def require_qc_write(request: Request):
    user = await require_auth(request)
    if user.get("role") not in WRITE_ROLES:
        raise HTTPException(status_code=403, detail="Acceso denegado: solo SuperSU o Inspector de QC")
    return user



def now_iso():
    return datetime.now(timezone.utc).isoformat()


def gen_id(prefix="qc"):
    return f"{prefix}_{uuid.uuid4().hex[:12]}"


def diff_record(old, new_data, fields):
    changes = {}
    for f in fields:
        ov = old.get(f)
        nv = new_data.get(f)
        if nv is not None and ov != nv:
            changes[f] = {"from": ov, "to": nv}
    return changes


# ─── Read endpoints (specific paths before parameterized) ────────────────────

@router.get("")
async def list_qc_records(request: Request):
    await require_auth(request)
    p = request.query_params
    query = {}
    if p.get("result"):
        query["result"] = p["result"]
    if p.get("severity"):
        query["severity"] = p["severity"]
    if p.get("inspector_id"):
        query["inspector_id"] = p["inspector_id"]
    if p.get("search"):
        s = p["search"]
        query["$or"] = [
            {"order_number": {"$regex": s, "$options": "i"}},
            {"client": {"$regex": s, "$options": "i"}},
        ]
    date_q = {}
    if p.get("date_from"):
        date_q["$gte"] = p["date_from"]
    if p.get("date_to"):
        date_q["$lte"] = p["date_to"]
    if date_q:
        query["inspection_date"] = date_q

    try:
        page = max(1, int(p.get("page", 1)))
        limit = min(200, max(1, int(p.get("limit", 50))))
    except ValueError:
        page, limit = 1, 50
    skip = (page - 1) * limit

    total = await db.qc_records.count_documents(query)
    records = await db.qc_records.find(query, {"_id": 0}).sort("created_at", -1).skip(skip).limit(limit).to_list(limit)
    pages = max(1, -(-total // limit))  # ceil division

    return {"records": records, "total": total, "page": page, "pages": pages, "limit": limit}


@router.get("/stats")
async def get_qc_stats(request: Request):
    await require_auth(request)
    total = await db.qc_records.count_documents({})
    passed = await db.qc_records.count_documents({"result": "PASS"})
    conditional = await db.qc_records.count_documents({"result": "CONDITIONAL"})
    failed = await db.qc_records.count_documents({"result": "FAIL"})
    critical = await db.qc_records.count_documents({"severity": "CRITICAL"})
    pass_rate = round(passed / total * 100, 1) if total > 0 else 0
    return {
        "total": total,
        "passed": passed,
        "conditional": conditional,
        "failed": failed,
        "critical_findings": critical,
        "pass_rate": pass_rate,
    }


@router.get("/unaudited")
async def get_unaudited_orders(request: Request):
    await require_auth(request)
    p = request.query_params
    base_filter = {"production_status": "NECESITA QC"}
    if p.get("search"):
        s = p["search"]
        query = {
            "$and": [
                base_filter,
                {"$or": [
                    {"order_number": {"$regex": s, "$options": "i"}},
                    {"client": {"$regex": s, "$options": "i"}},
                ]}
            ]
        }
    else:
        query = base_filter
    orders = await db.orders.find(
        query,
        {"_id": 0, "order_id": 1, "order_number": 1, "client": 1,
         "quantity": 1, "job_title_a": 1, "production_status": 1, "status": 1, "created_at": 1}
    ).sort("created_at", -1).to_list(500)
    return orders


@router.get("/metrics")
async def get_qc_metrics(request: Request):
    await require_auth(request)

    pipeline_type = [
        {"$group": {
            "_id": "$finding_type",
            "total": {"$sum": 1},
            "pass": {"$sum": {"$cond": [{"$eq": ["$result", "PASS"]}, 1, 0]}},
            "fail": {"$sum": {"$cond": [{"$eq": ["$result", "FAIL"]}, 1, 0]}},
            "conditional": {"$sum": {"$cond": [{"$eq": ["$result", "CONDITIONAL"]}, 1, 0]}},
        }},
        {"$sort": {"total": -1}}
    ]
    by_type_raw = await db.qc_records.aggregate(pipeline_type).to_list(20)

    pipeline_inspector = [
        {"$group": {
            "_id": "$inspector",
            "total": {"$sum": 1},
            "pass": {"$sum": {"$cond": [{"$eq": ["$result", "PASS"]}, 1, 0]}},
            "fail": {"$sum": {"$cond": [{"$eq": ["$result", "FAIL"]}, 1, 0]}},
            "conditional": {"$sum": {"$cond": [{"$eq": ["$result", "CONDITIONAL"]}, 1, 0]}},
        }},
        {"$sort": {"total": -1}},
        {"$limit": 10}
    ]
    by_inspector_raw = await db.qc_records.aggregate(pipeline_inspector).to_list(10)

    pipeline_month = [
        {"$addFields": {"month": {"$substr": ["$inspection_date", 0, 7]}}},
        {"$group": {
            "_id": "$month",
            "total": {"$sum": 1},
            "pass": {"$sum": {"$cond": [{"$eq": ["$result", "PASS"]}, 1, 0]}},
            "fail": {"$sum": {"$cond": [{"$eq": ["$result", "FAIL"]}, 1, 0]}},
            "conditional": {"$sum": {"$cond": [{"$eq": ["$result", "CONDITIONAL"]}, 1, 0]}},
        }},
        {"$sort": {"_id": -1}},
        {"$limit": 6}
    ]
    by_month_raw = await db.qc_records.aggregate(pipeline_month).to_list(6)
    by_month_raw.reverse()

    def label(items):
        for item in items:
            item["name"] = item.pop("_id") or "N/A"
        return items

    return {
        "by_type": label(by_type_raw),
        "by_inspector": label(by_inspector_raw),
        "by_month": label(by_month_raw),
    }


@router.get("/notifications")
async def get_qc_notifications(request: Request):
    await require_auth(request)
    notifs = await db.qc_notifications.find({}, {"_id": 0}).sort("created_at", -1).to_list(50)
    unread = sum(1 for n in notifs if not n.get("read"))
    return {"notifications": notifs, "unread": unread}


@router.put("/notifications/read-all")
async def mark_all_notifications_read(request: Request):
    await require_auth(request)
    await db.qc_notifications.update_many({"read": False}, {"$set": {"read": True}})
    return {"ok": True}


@router.put("/notifications/{notif_id}/read")
async def mark_notification_read(notif_id: str, request: Request):
    await require_auth(request)
    await db.qc_notifications.update_one({"notif_id": notif_id}, {"$set": {"read": True}})
    return {"ok": True}


@router.get("/export/csv")
async def export_qc_csv(request: Request):
    await require_auth(request)
    p = request.query_params
    query = {}
    if p.get("result"):
        query["result"] = p["result"]
    if p.get("severity"):
        query["severity"] = p["severity"]
    if p.get("search"):
        s = p["search"]
        query["$or"] = [
            {"order_number": {"$regex": s, "$options": "i"}},
            {"client": {"$regex": s, "$options": "i"}},
        ]
    date_q = {}
    if p.get("date_from"):
        date_q["$gte"] = p["date_from"]
    if p.get("date_to"):
        date_q["$lte"] = p["date_to"]
    if date_q:
        query["inspection_date"] = date_q

    records = await db.qc_records.find(query, {"_id": 0}).sort("created_at", -1).to_list(5000)

    output = io.StringIO()
    fields = [
        "qc_id", "order_number", "client", "inspector", "inspection_date",
        "request_date", "finding_type", "severity", "result",
        "quantity_inspected", "quantity_rejected", "quantity",
        "findings", "corrective_action", "created_at",
    ]
    writer = csv.DictWriter(output, fieldnames=fields, extrasaction="ignore", lineterminator="\n")
    writer.writeheader()
    for r in records:
        findings = r.get("findings", "")
        findings = re.sub(r'\[img\].*?\[/img\]', '[imagen]', findings, flags=re.DOTALL)
        r["findings"] = findings
        writer.writerow(r)

    output.seek(0)
    filename = f"qc_export_{datetime.now().strftime('%Y%m%d')}.csv"
    return StreamingResponse(
        iter([output.getvalue()]),
        media_type="text/csv",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


# ─── Write endpoints ──────────────────────────────────────────────────────────

@router.post("/orders/{order_id}/release")
async def release_order_lock(order_id: str, request: Request):
    user = await require_auth(request)
    if user.get("role") not in ("supersu", "inspector_qc"):
        raise HTTPException(status_code=403, detail="Solo el Super Usuario o Inspector de Calidad pueden liberar órdenes")
    order = await db.orders.find_one({"order_id": order_id}, {"_id": 0})
    if not order:
        raise HTTPException(404, "Order not found")
    if not order.get("locked_by_qc"):
        return {"ok": True, "already_unlocked": True}
    await db.orders.update_one(
        {"order_id": order_id},
        {"$set": {"locked_by_qc": False, "updated_at": now_iso()}}
    )
    await log_activity(user, "release_qc_lock", {
        "order_id": order_id,
        "order_number": order.get("order_number"),
    })
    return {"ok": True, "order_id": order_id, "order_number": order.get("order_number")}


@router.post("")
async def create_qc_record(request: Request):
    user = await require_qc_write(request)
    body = await request.json()

    order = None
    order_id = ""
    client = body.get("client", "").strip()
    if body.get("order_number"):
        order = await db.orders.find_one(
            {"order_number": body["order_number"].strip()},
            {"_id": 0, "order_id": 1, "client": 1, "quantity": 1, "job_title_a": 1},
        )
        if order:
            order_id = order.get("order_id", "")
            if not client:
                client = order.get("client", "")

    today = datetime.now(timezone.utc).date().isoformat()
    result = body.get("result", "PASS")
    doc = {
        "qc_id": gen_id("qc"),
        "order_number": body.get("order_number", "").strip(),
        "order_id": order_id,
        "client": client,
        "inspector": user.get("name", user.get("email", "")),
        "inspector_id": user.get("user_id", ""),
        "request_date": body.get("request_date") or today,
        "inspection_date": body.get("inspection_date") or today,
        "finding_type": body.get("finding_type", "OTHER"),
        "severity": body.get("severity", "MINOR"),
        "result": result,
        "quantity_inspected": int(body.get("quantity_inspected") or 0),
        "quantity_rejected": int(body.get("quantity_rejected") or 0),
        "findings": body.get("findings", "").strip(),
        "corrective_action": body.get("corrective_action", "").strip(),
        "quantity": body.get("quantity") or (order.get("quantity") if order else ""),
        "job_title_a": body.get("job_title_a") or (order.get("job_title_a") if order else ""),
        "created_at": now_iso(),
        "updated_at": now_iso(),
    }
    await db.qc_records.insert_one(doc)
    doc.pop("_id", None)

    if order_id:
        lock_update = {"locked_by_qc": False, "updated_at": now_iso()}
        if result in ["FAIL", "CONDITIONAL"]:
            lock_update["production_status"] = "CORRECIÓN DE QC"
        await db.orders.update_one({"order_id": order_id}, {"$set": lock_update})

    if result in ["FAIL", "CONDITIONAL"]:
        notif = {
            "notif_id": gen_id("notif"),
            "qc_id": doc["qc_id"],
            "order_number": doc["order_number"],
            "client": doc["client"],
            "result": result,
            "severity": doc["severity"],
            "inspector": doc["inspector"],
            "created_at": now_iso(),
            "read": False,
        }
        await db.qc_notifications.insert_one(notif)

    await log_activity(user, "create_qc_record", {
        "qc_id": doc["qc_id"],
        "order_number": doc["order_number"],
        "result": doc["result"],
    })
    return doc


@router.put("/{qc_id}")
async def update_qc_record(qc_id: str, request: Request):
    user = await require_qc_write(request)
    body = await request.json()
    existing = await db.qc_records.find_one({"qc_id": qc_id}, {"_id": 0})
    if not existing:
        raise HTTPException(404, "QC record not found")

    allowed = [
        "finding_type", "severity", "result", "quantity_inspected",
        "quantity_rejected", "findings", "corrective_action", "client",
        "request_date", "inspection_date", "quantity", "job_title_a",
    ]
    update = {k: body[k] for k in allowed if k in body}
    update["updated_at"] = now_iso()

    changes = diff_record(existing, update, allowed)
    if changes:
        history_entry = {
            "history_id": gen_id("hist"),
            "qc_id": qc_id,
            "changed_by": user.get("name", user.get("email", "")),
            "changed_by_id": user.get("user_id", ""),
            "changed_at": now_iso(),
            "changes": changes,
        }
        await db.qc_history.insert_one(history_entry)

    await db.qc_records.update_one({"qc_id": qc_id}, {"$set": update})
    updated = await db.qc_records.find_one({"qc_id": qc_id}, {"_id": 0})

    if "result" in update and existing.get("order_id"):
        lock_update = {"locked_by_qc": False, "updated_at": now_iso()}
        if update["result"] in ["FAIL", "CONDITIONAL"]:
            lock_update["production_status"] = "CORRECIÓN DE QC"
        await db.orders.update_one({"order_id": existing["order_id"]}, {"$set": lock_update})

        if update["result"] in ["FAIL", "CONDITIONAL"] and existing.get("result") != update["result"]:
            notif = {
                "notif_id": gen_id("notif"),
                "qc_id": qc_id,
                "order_number": existing.get("order_number", ""),
                "client": existing.get("client", ""),
                "result": update["result"],
                "severity": update.get("severity", existing.get("severity", "")),
                "inspector": existing.get("inspector", ""),
                "created_at": now_iso(),
                "read": False,
            }
            await db.qc_notifications.insert_one(notif)

    await log_activity(user, "update_qc_record", {"qc_id": qc_id})
    return updated


@router.get("/{qc_id}/history")
async def get_qc_history(qc_id: str, request: Request):
    await require_auth(request)
    existing = await db.qc_records.find_one(
        {"qc_id": qc_id}, {"_id": 0, "created_at": 1, "inspector": 1}
    )
    if not existing:
        raise HTTPException(404, "QC record not found")
    entries = await db.qc_history.find({"qc_id": qc_id}, {"_id": 0}).sort("changed_at", -1).to_list(100)
    return {
        "history": entries,
        "created_at": existing.get("created_at"),
        "created_by": existing.get("inspector"),
    }


@router.delete("/{qc_id}")
async def delete_qc_record(qc_id: str, request: Request):
    user = await require_qc_write(request)
    result = await db.qc_records.delete_one({"qc_id": qc_id})
    if result.deleted_count == 0:
        raise HTTPException(404, "QC record not found")
    await log_activity(user, "delete_qc_record", {"qc_id": qc_id})
    return {"ok": True}
