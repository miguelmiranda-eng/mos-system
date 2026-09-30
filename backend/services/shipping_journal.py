"""Bitácora de movimientos del programador de envíos, con reversión.

Cada acción del programador (routers/scheduled_shipments.py) guarda en
`db.shipping_movements` una foto ANTES / DESPUÉS de cada documento que tocó:

    lines:   [{"id": shipment_id, "before": doc|None, "after": doc|None}]
    exports: [{"id": export_id,   "before": doc|None, "after": doc|None}]

before=None → el documento se creó; after=None → se borró.

REVERTIR = dejar cada documento como su foto ANTES. Sólo se permite si el
estado actual sigue siendo la foto DESPUÉS (nadie lo tocó luego). Se ignoran
`position` (el renumerado de un bloque mueve a los vecinos) y `updated_at`.
Una reversión también se registra (action="revert") y no se puede revertir a
su vez; el movimiento original queda marcado como revertido.

Límite: sólo hay historial desde que existe esta bitácora (2026-09-30); lo
anterior (importación de la hoja incluida) no tiene foto ANTES.
"""
import uuid
from datetime import datetime, timezone

from deps import db

IGNORE = {"_id", "position", "updated_at"}
MESES = ["ENE", "FEB", "MAR", "ABR", "MAY", "JUN", "JUL", "AGO", "SEP", "OCT", "NOV", "DIC"]
LINE_FIELDS = {
    "status": "STATUS", "pcs": "PCS", "shipping_no": "SHIPPING#", "delivery_to": "DELIVER TO",
    "ship_from": "SHIPPING FROM", "carrier": "CARRIER", "priority": "PRIORIDAD",
    "ship_notes": "NOTES", "manual_fields": "datos manuales", "export_id": "export",
}
EXPORT_FIELDS = {
    "export_no": "EXPORT#", "pl_numbers": "PL", "truck": "Transporte", "customs_light": "Semáforo",
    "cutoff_time": "Corte", "export_time": "Export HR", "notes": "Notas", "date": "Fecha",
}


def _now():
    return datetime.now(timezone.utc).isoformat()


def clean(doc):
    return {k: v for k, v in doc.items() if k != "_id"} if doc else None


def same(a, b) -> bool:
    if a is None or b is None:
        return a is None and b is None
    ka = {k: v for k, v in a.items() if k not in IGNORE}
    kb = {k: v for k, v in b.items() if k not in IGNORE}
    return ka == kb


def changed_fields(a, b, labels) -> list:
    keys = (set(a or {}) | set(b or {})) - IGNORE
    return [labels.get(k, k) for k in sorted(keys) if (a or {}).get(k) != (b or {}).get(k) and k in labels]


def fecha(iso) -> str:
    try:
        return f"{int(iso[8:10]):02d} {MESES[int(iso[5:7]) - 1]}"
    except (TypeError, ValueError, IndexError):
        return str(iso or "")


def exp_label(exp) -> str:
    if not exp:
        return "export"
    base = f"EXP#{exp['export_no']}" if exp.get("export_no") else "export sin #"
    return f"{base} · {fecha(exp.get('date'))}"


def val(v):
    if v in (None, "", {}):
        return "—"
    return str(v)


# ── Fotos ────────────────────────────────────────────────────────────────────

async def snap_lines(ids) -> dict:
    ids = [i for i in ids if i]
    if not ids:
        return {}
    docs = await db.scheduled_shipments.find({"shipment_id": {"$in": list(ids)}}, {"_id": 0}).to_list(5000)
    return {d["shipment_id"]: d for d in docs}


async def snap_exports(ids) -> dict:
    ids = [i for i in ids if i]
    if not ids:
        return {}
    docs = await db.shipping_exports.find({"export_id": {"$in": list(ids)}}, {"_id": 0}).to_list(500)
    return {d["export_id"]: d for d in docs}


async def record(user, action, summary, lines=(), exports=(), revert_of=None):
    """Registra un movimiento. `lines`/`exports` = [(id, before, after)].
    Nunca rompe la operación que lo llama: si falla, sólo se pierde el renglón."""
    try:
        line_entries = [{"id": i, "before": clean(b), "after": clean(a)} for i, b, a in lines
                        if not (b is None and a is None)]
        exp_entries = [{"id": i, "before": clean(b), "after": clean(a)} for i, b, a in exports
                       if not (b is None and a is None)]
        if not line_entries and not exp_entries:
            return None
        orders = sorted({(e["after"] or e["before"]).get("order_number") for e in line_entries} - {None},
                        key=lambda x: (len(x), x))
        doc = {
            "movement_id": str(uuid.uuid4()),
            "at": _now(),
            "user_id": user.get("user_id"),
            "user_name": user.get("name", user.get("email")),
            "action": action,
            "summary": summary,
            "orders": orders,
            "lines": line_entries,
            "exports": exp_entries,
            "revert_of": revert_of,
            "reverted_at": None,
            "reverted_by_name": None,
            "reverted_movement_id": None,
        }
        await db.shipping_movements.insert_one(dict(doc))
        return doc
    except Exception as e:  # noqa: BLE001 — la bitácora no debe tumbar la operación
        print(f"[shipping_journal] no se pudo registrar {action}: {e}")
        return None


async def renumber(export_id):
    lines = await db.scheduled_shipments.find(
        {"export_id": export_id}, {"_id": 0, "shipment_id": 1, "position": 1, "created_at": 1},
    ).to_list(5000)
    lines.sort(key=lambda s: (s.get("position") or 0, s.get("created_at") or ""))
    for i, s in enumerate(lines):
        if s.get("position") != i:
            await db.scheduled_shipments.update_one({"shipment_id": s["shipment_id"]}, {"$set": {"position": i}})


# ── ¿Se puede revertir? ──────────────────────────────────────────────────────

async def _current(movements):
    """Estado actual de todo lo que tocan `movements` (en 3 consultas)."""
    lids = {e["id"] for m in movements for e in m.get("lines", [])}
    eids = {e["id"] for m in movements for e in m.get("exports", [])}
    # También los exports a donde regresarían las órdenes (¿siguen vivos?).
    eids |= {e["before"].get("export_id") for m in movements for e in m.get("lines", []) if e["before"]} - {None}
    cur_l = await snap_lines(lids)
    cur_e = await snap_exports(eids)
    created = {e["id"] for m in movements for e in m.get("exports", []) if e["before"] is None}
    occupants = {}
    if created:
        for d in await db.scheduled_shipments.find(
                {"export_id": {"$in": list(created)}}, {"_id": 0, "shipment_id": 1, "export_id": 1}).to_list(10000):
            occupants.setdefault(d["export_id"], set()).add(d["shipment_id"])
    return cur_l, cur_e, occupants


def blockers(m, cur_l, cur_e, occupants) -> list:
    """Motivos por los que NO se puede revertir `m` (vacío = se puede)."""
    if m.get("revert_of") or m.get("action") == "revert":
        return ["Es una reversión"]
    if m.get("reverted_at"):
        return ["Ya se revirtió"]
    out = []
    for e in m.get("lines", []):
        ref = e["after"] or e["before"] or {}
        tag = f"#{ref.get('order_number', '?')}"
        cur = cur_l.get(e["id"])
        if e["after"] is None:
            if cur is not None:
                out.append(f"{tag} volvió a existir")
        elif cur is None:
            out.append(f"{tag} ya no existe")
        elif not same(cur, e["after"]):
            campos = changed_fields(e["after"], cur, LINE_FIELDS) or ["otros datos"]
            out.append(f"{tag} cambió después ({', '.join(campos)})")
    for e in m.get("exports", []):
        ref = e["after"] or e["before"]
        cur = cur_e.get(e["id"])
        if e["after"] is None:
            if cur is not None:
                out.append(f"{exp_label(ref)} volvió a existir")
        elif cur is None:
            out.append(f"{exp_label(ref)} ya no existe")
        elif not same(cur, e["after"]):
            campos = changed_fields(e["after"], cur, EXPORT_FIELDS) or ["otros datos"]
            out.append(f"{exp_label(ref)} cambió después ({', '.join(campos)})")
    # Un export que este movimiento CREÓ se borra al revertir: no debe tener
    # órdenes ajenas a este movimiento.
    own = {e["id"] for e in m.get("lines", [])}
    for e in m.get("exports", []):
        if e["before"] is None:
            extra = occupants.get(e["id"], set()) - own
            if extra:
                out.append(f"{exp_label(e['after'])} tiene órdenes agregadas después")
    # Las órdenes que regresan necesitan su export (vivo o restaurado aquí).
    restored = {e["id"] for e in m.get("exports", []) if e["before"] is not None}
    for e in m.get("lines", []):
        b = e["before"]
        if b and b.get("export_id") and b["export_id"] not in restored and b["export_id"] not in cur_e:
            out.append(f"#{b.get('order_number', '?')}: su export original ya no existe")
    return list(dict.fromkeys(out))


async def list_movements(skip=0, limit=50, q="", action=""):
    query = {}
    if action:
        query["action"] = action
    if q:
        import re
        rx = {"$regex": re.escape(q.strip().lstrip("#")), "$options": "i"}
        query["$or"] = [{"orders": rx}, {"summary": rx}, {"user_name": rx}]
    total = await db.shipping_movements.count_documents(query)
    items = await db.shipping_movements.find(query, {"_id": 0}).sort("at", -1).skip(skip).limit(limit).to_list(limit)
    # Sólo se evalúa la reversión de lo que se muestra; los ids que tocan
    # varios movimientos se consultan una vez.
    cur_l, cur_e, occ = await _current(items)
    out = []
    for m in items:
        b = blockers(m, cur_l, cur_e, occ)
        out.append({
            "movement_id": m["movement_id"], "at": m["at"], "user_name": m.get("user_name"),
            "action": m["action"], "summary": m.get("summary"), "orders": m.get("orders", []),
            "n_lines": len(m.get("lines", [])), "n_exports": len(m.get("exports", [])),
            "revert_of": m.get("revert_of"), "reverted_at": m.get("reverted_at"),
            "reverted_by_name": m.get("reverted_by_name"),
            "can_revert": not b, "blockers": b,
        })
    return {"total": total, "skip": skip, "limit": limit, "items": out}


class RevertBlocked(Exception):
    def __init__(self, reasons):
        super().__init__("; ".join(reasons))
        self.reasons = reasons


async def revert(movement_id, user):
    """Revierte un movimiento. Lanza LookupError si no existe y RevertBlocked
    si ya no es posible. Devuelve el movimiento de reversión."""
    m = await db.shipping_movements.find_one({"movement_id": movement_id}, {"_id": 0})
    if not m:
        raise LookupError(movement_id)
    # Candado: marcar ANTES de tocar nada, para que dos reversiones simultáneas
    # del mismo movimiento no se apliquen dos veces.
    claim = await db.shipping_movements.update_one(
        {"movement_id": movement_id, "reverted_at": None, "revert_of": None},
        {"$set": {"reverted_at": _now(), "reverted_by_name": user.get("name", user.get("email"))}})
    if claim.modified_count == 0:
        raise RevertBlocked(blockers(m, {}, {}, {}) or ["Ya se revirtió"])
    try:
        cur_l, cur_e, occ = await _current([m])
        b = blockers({**m, "reverted_at": None}, cur_l, cur_e, occ)
        if b:
            raise RevertBlocked(b)
        now = _now()
        touched = set()
        # 1) Exports que existían antes (se restauran primero: las órdenes que
        #    regresan pueden apuntar a ellos).
        for e in m.get("exports", []):
            if e["before"] is not None:
                await db.shipping_exports.replace_one(
                    {"export_id": e["id"]}, {**e["before"], "updated_at": now}, upsert=True)
        # 2) Órdenes: las creadas se borran, las demás vuelven a su foto ANTES.
        for e in m.get("lines", []):
            if e["after"] and e["after"].get("export_id"):
                touched.add(e["after"]["export_id"])
            if e["before"] is None:
                await db.scheduled_shipments.delete_one({"shipment_id": e["id"]})
            else:
                touched.add(e["before"].get("export_id"))
                await db.scheduled_shipments.replace_one(
                    {"shipment_id": e["id"]}, {**e["before"], "updated_at": now}, upsert=True)
        # 3) Exports que este movimiento creó (ya vacíos): se borran.
        for e in m.get("exports", []):
            if e["before"] is None:
                await db.shipping_exports.delete_one({"export_id": e["id"]})
                touched.discard(e["id"])
        for eid in touched - {None}:
            await renumber(eid)
        rev = await record(
            user, "revert", f"Revirtió: {m.get('summary') or m['action']}",
            lines=[(e["id"], cur_l.get(e["id"]), e["before"]) for e in m.get("lines", [])],
            exports=[(e["id"], cur_e.get(e["id"]), e["before"]) for e in m.get("exports", [])],
            revert_of=movement_id)
        await db.shipping_movements.update_one(
            {"movement_id": movement_id},
            {"$set": {"reverted_movement_id": (rev or {}).get("movement_id")}})
        return rev
    except Exception:
        # Si no se aplicó, se libera el candado para poder reintentar.
        await db.shipping_movements.update_one(
            {"movement_id": movement_id, "reverted_movement_id": None},
            {"$set": {"reverted_at": None, "reverted_by_name": None}})
        raise
