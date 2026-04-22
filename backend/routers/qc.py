"""QC (Quality Control) inspection records."""
from fastapi import APIRouter, HTTPException, Request
from deps import db, require_auth, log_activity
from datetime import datetime, timezone
import uuid

router = APIRouter(prefix="/api/qc")


def now_iso():
    return datetime.now(timezone.utc).isoformat()


def gen_id():
    return f"qc_{uuid.uuid4().hex[:12]}"


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
    records = await db.qc_records.find(query, {"_id": 0}).sort("created_at", -1).to_list(500)
    return records


@router.get("/stats")
async def get_qc_stats(request: Request):
    await require_auth(request)
    total = await db.qc_records.count_documents({})
    passed = await db.qc_records.count_documents({"result": "PASS"})
    failed = await db.qc_records.count_documents({"result": "FAIL"})
    critical = await db.qc_records.count_documents({"severity": "CRITICAL"})
    pass_rate = round(passed / total * 100, 1) if total > 0 else 0
    return {
        "total": total,
        "passed": passed,
        "failed": failed,
        "critical_findings": critical,
        "pass_rate": pass_rate,
    }


@router.post("")
async def create_qc_record(request: Request):
    user = await require_auth(request)
    body = await request.json()

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

    doc = {
        "qc_id": gen_id(),
        "order_number": body.get("order_number", "").strip(),
        "order_id": order_id,
        "client": client,
        "inspector": user.get("name", user.get("email", "")),
        "inspector_id": user.get("user_id", ""),
        "inspection_date": body.get("inspection_date") or datetime.now(timezone.utc).date().isoformat(),
        "finding_type": body.get("finding_type", "OTHER"),
        "severity": body.get("severity", "MINOR"),
        "result": body.get("result", "PASS"),
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

    # Lock order if FAIL, unlock if PASS or CONDITIONAL
    if order_id:
        locked = doc["result"] == "FAIL"
        await db.orders.update_one(
            {"order_id": order_id},
            {"$set": {"locked_by_qc": locked, "updated_at": now_iso()}}
        )

    await log_activity(user, "create_qc_record", {
        "qc_id": doc["qc_id"],
        "order_number": doc["order_number"],
        "result": doc["result"],
    })
    return doc


@router.put("/{qc_id}")
async def update_qc_record(qc_id: str, request: Request):
    user = await require_auth(request)
    body = await request.json()
    existing = await db.qc_records.find_one({"qc_id": qc_id}, {"_id": 0})
    if not existing:
        raise HTTPException(404, "QC record not found")
    allowed = [
        "finding_type", "severity", "result", "quantity_inspected",
        "quantity_rejected", "findings", "corrective_action", "client", "inspection_date",
        "quantity", "job_title_a",
    ]
    update = {k: body[k] for k in allowed if k in body}
    update["updated_at"] = now_iso()
    await db.qc_records.update_one({"qc_id": qc_id}, {"$set": update})
    updated = await db.qc_records.find_one({"qc_id": qc_id}, {"_id": 0})

    # Sync lock status when result changes
    if "result" in update and existing.get("order_id"):
        locked = update["result"] == "FAIL"
        await db.orders.update_one(
            {"order_id": existing["order_id"]},
            {"$set": {"locked_by_qc": locked, "updated_at": now_iso()}}
        )

    await log_activity(user, "update_qc_record", {"qc_id": qc_id})
    return updated


@router.delete("/{qc_id}")
async def delete_qc_record(qc_id: str, request: Request):
    user = await require_auth(request)
    result = await db.qc_records.delete_one({"qc_id": qc_id})
    if result.deleted_count == 0:
        raise HTTPException(404, "QC record not found")
    await log_activity(user, "delete_qc_record", {"qc_id": qc_id})
    return {"ok": True}
