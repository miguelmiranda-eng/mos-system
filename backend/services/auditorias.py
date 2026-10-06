"""Auditorías del WMS — Fase 1 (KPIs IRA/ILA) + catálogo de motivos.

Qué hace:
  · kpis_rollup(since, until, group): serie diaria/semanal de IRA e ILA
    calculada desde los conteos cíclicos YA capturados (wms_cycle_counts),
    fusionada con el histórico migrado (wms_audit_kpi_history, Fase 3).
  · movement_feed(kind, ...): vistas Case Pick / Putaway / Receiving DERIVADAS
    de wms_movements. NO se recapturan: la bitácora ya las tiene, se leen.
  · catálogo de motivos controlado (config_options:wms_auditorias), mismo patrón
    que services/resupply.py — valida el motivo al enviarlo (lo usa la Fase 2).

Definiciones (idénticas a get_cycle_count_report → inventory_kpis en wms.py):
  · IRA = 1 − Σ|Δpiezas| ÷ Σpiezas_en_sistema   (precisión de registro)
  · ILA = ubicaciones perfectas ÷ ubicaciones cerradas  (precisión de ubicación)

Regla dura: este módulo NUNCA escribe wms_inventory. Cualquier ajuste (Fase 2)
pasa por el escritor único (_reconcile_line_boxes + _reproject_material_rows).
"""
import uuid
from datetime import date, datetime, timezone

from deps import db

CONFIG_ID = "wms_auditorias"
GOAL_PCT = 99.0

# Motivos iniciales (deduplicados del Google Sheet "Warehouse Audits"). El texto
# libre de la hoja ("AJUSTE DE PIEZAS AUDITORIA" / "ajuste de piezas por
# auditoria" / …) se colapsa aquí a una lista controlada, editable en el módulo.
DEFAULT_REASON_CODES = [
    "AJUSTE DE PIEZAS POR AUDITORÍA",
    "AJUSTE DE ESTILO",
    "CONTENIDO INCORRECTO",
    "MATERIAL NO ENCONTRADO EN LOCACIÓN",
    "BOX NO ENCONTRADA EN SU LOCACIÓN",
    "MATERIAL FALTANTE EN LOCACIÓN",
]
DEFAULT_CFG = {"config_id": CONFIG_ID, "reason_codes": DEFAULT_REASON_CODES}

# Familias de movimiento que alimentan cada vista derivada (mismas que usa
# Auditoría → Movimientos). Se LEEN del log, no se recapturan.
MOVEMENT_FAMILIES = {
    "pick": ["pick_deduction"],
    "putaway": ["transit_relocation", "putaway", "putaway_bulk"],
    "receiving": ["receiving", "asn_receipt"],
    # IRA/ILA Records = ajustes disparados por auditoría (Fase 4).
    "ira_ila": ["auditoria_adjustment"],
}


# ── Catálogo de motivos (patrón resupply) ────────────────────────────────────
def _norm_codes(codes):
    out, seen = [], set()
    for c in codes or []:
        s = str(c or "").strip()
        if s and s.upper() not in seen:
            seen.add(s.upper())
            out.append(s)
    return out


async def get_cfg() -> dict:
    doc = await db.config_options.find_one({"config_id": CONFIG_ID}, {"_id": 0})
    codes = _norm_codes((doc or {}).get("reason_codes") or DEFAULT_REASON_CODES)
    return {"config_id": CONFIG_ID, "reason_codes": codes or list(DEFAULT_REASON_CODES)}


async def save_cfg(body: dict, user: dict) -> dict:
    codes = _norm_codes((body or {}).get("reason_codes"))
    if not codes:
        raise ValueError("Se requiere al menos un motivo de auditoría.")
    await db.config_options.update_one(
        {"config_id": CONFIG_ID},
        {"$set": {"config_id": CONFIG_ID, "reason_codes": codes}},
        upsert=True,
    )
    return {"config_id": CONFIG_ID, "reason_codes": codes}


def validate_reason(reason: str, cfg: dict) -> bool:
    """True si `reason` está en la lista curada (case-insensitive). Lo usará la
    Fase 2 al registrar un ajuste de auditoría."""
    allowed = {c.strip().upper() for c in (cfg or {}).get("reason_codes", [])}
    return str(reason or "").strip().upper() in allowed


# ── KPIs IRA / ILA ────────────────────────────────────────────────────────────
def _day(iso: str) -> str:
    return (iso or "")[:10]


def _bucket_key(iso: str, group: str) -> str:
    d = _day(iso)
    if group != "week":
        return d
    try:
        y, w, _ = date.fromisoformat(d).isocalendar()
        return f"{y}-W{w:02d}"
    except ValueError:
        return d


async def _count_metrics(count: dict):
    """(system_pieces, abs_pieces, locs_closed, locs_perfect) de UN conteo.
    Mismo cálculo que inventory_kpis en wms.py. box_scan mide cajas/piezas vía
    _cc_pieces_discrepancy; el modo por líneas usa |discrepancy| de cada línea."""
    lines = count.get("lines") or []
    scan_locs = count.get("scan_locations") or []
    system_pieces = sum(int(l.get("system_qty") or 0) for l in lines)
    if scan_locs:
        from routers.wms import _cc_pieces_discrepancy  # lazy: evita ciclo de import
        try:
            pd = await _cc_pieces_discrepancy(count.get("count_id"), scan_locs)
            abs_pieces = int(pd.get("pieces_missing") or 0) + int(pd.get("pieces_extra") or 0)
        except Exception:
            abs_pieces = 0
        closed = [sl for sl in scan_locs if sl.get("status") in ("ok", "supervisor")]
        perfect = [sl for sl in closed
                   if not (sl.get("missing") or sl.get("extra") or sl.get("unknown_boxes"))]
        return system_pieces, abs_pieces, len(closed), len(perfect)
    counted = [l for l in lines if l.get("counted")]
    abs_pieces = sum(abs(int(l.get("discrepancy") or 0)) for l in counted)
    return system_pieces, abs_pieces, 0, 0


def _finalize(bucket: dict) -> dict:
    up = bucket["units_processed"]
    abs_p = bucket["abs_pieces"]
    lc = bucket["locations_processed"]
    lp = bucket["locations_without_issues"]
    ira = round(max(0.0, (1 - abs_p / up) * 100), 1) if up > 0 else None
    ila = round(lp / lc * 100, 1) if lc > 0 else None
    return {
        "key": bucket["key"],
        "units_processed": up,
        "units_without_issues": up - abs_p,
        "ira_pct": ira,
        "locations_processed": lc,
        "locations_without_issues": lp,
        "ila_pct": ila,
        "source": bucket["source"],
    }


async def kpis_rollup(since: str, until: str, group: str = "day") -> dict:
    """Serie de IRA/ILA entre `since` y `until` (ISO 'YYYY-MM-DD'), agrupada por
    día o semana. Fusiona lo calculado desde los conteos del WMS con el histórico
    migrado de la hoja (wms_audit_kpi_history)."""
    end = until + "T23:59:59"
    q = {"$or": [
        {"approved_at": {"$gte": since, "$lte": end}},
        {"created_at": {"$gte": since, "$lte": end}},
    ]}
    proj = {"_id": 0, "count_id": 1, "created_at": 1, "approved_at": 1,
            "status": 1, "mode": 1, "lines": 1, "scan_locations": 1}
    counts = await db.wms_cycle_counts.find(q, proj).to_list(5000)

    buckets: dict = {}

    def _get(key, source):
        b = buckets.get(key)
        if not b:
            b = {"key": key, "units_processed": 0, "abs_pieces": 0,
                 "locations_processed": 0, "locations_without_issues": 0, "source": source}
            buckets[key] = b
        return b

    for c in counts:
        eff = c.get("approved_at") or c.get("created_at")
        if not (since <= _day(eff) <= until):
            continue
        sp, ap, lc, lp = await _count_metrics(c)
        b = _get(_bucket_key(eff, group), "wms")
        b["units_processed"] += sp
        b["abs_pieces"] += ap
        b["locations_processed"] += lc
        b["locations_without_issues"] += lp

    # Sesiones de auditoría por caja (Fase 2): mismo bucket que los conteos. El
    # muestreo aporta a IRA (piezas) y a ILA (cajas en su ubicación correcta).
    sess = await db.wms_audit_sessions.find(
        {"status": "closed", "$or": [
            {"closed_at": {"$gte": since, "$lte": end}},
            {"created_at": {"$gte": since, "$lte": end}},
        ]}, {"_id": 0}).to_list(5000)
    for s in sess:
        eff = s.get("closed_at") or s.get("created_at")
        if not (since <= _day(eff) <= until):
            continue
        m = session_metrics(s)
        b = _get(_bucket_key(eff, group), "wms")
        b["units_processed"] += m["system_pieces"]
        b["abs_pieces"] += m["abs_discrepancy_pieces"]
        b["locations_processed"] += m["boxes_sampled"]
        b["locations_without_issues"] += m["boxes_located_ok"]

    # Histórico migrado (Fase 3): solo rellena fechas que el WMS NO calculó.
    hist = await db.wms_audit_kpi_history.find(
        {"date": {"$gte": since, "$lte": until}}, {"_id": 0}).to_list(5000)
    for h in hist:
        key = _bucket_key(h.get("date"), group)
        if key in buckets and buckets[key]["source"] == "wms":
            continue  # el dato vivo del WMS manda sobre el histórico de la hoja
        b = _get(key, "historico")
        up = int(h.get("units_processed") or 0)
        wi = int(h.get("units_without_issues") or 0)
        b["units_processed"] += up
        b["abs_pieces"] += max(0, up - wi)
        b["locations_processed"] += int(h.get("locations_processed") or 0)
        b["locations_without_issues"] += int(h.get("locations_without_issues") or 0)

    series = [_finalize(buckets[k]) for k in sorted(buckets)]

    # MTD: IRA acumulado dentro del mes de cada punto (como la hoja).
    by_month: dict = {}
    for row in series:
        month = row["key"][:7]
        acc = by_month.setdefault(month, {"up": 0, "wi": 0})
        acc["up"] += row["units_processed"]
        acc["wi"] += row["units_without_issues"]
        row["ira_mtd"] = round(acc["wi"] / acc["up"] * 100, 1) if acc["up"] > 0 else None

    tot_up = sum(r["units_processed"] for r in series)
    tot_wi = sum(r["units_without_issues"] for r in series)
    tot_lc = sum(r["locations_processed"] for r in series)
    tot_lp = sum(r["locations_without_issues"] for r in series)
    totals = {
        "units_processed": tot_up,
        "units_without_issues": tot_wi,
        "ira_pct": round(tot_wi / tot_up * 100, 1) if tot_up > 0 else None,
        "locations_processed": tot_lc,
        "locations_without_issues": tot_lp,
        "ila_pct": round(tot_lp / tot_lc * 100, 1) if tot_lc > 0 else None,
    }
    return {"group": group, "since": since, "until": until, "goal": GOAL_PCT,
            "series": series, "totals": totals}


# ── Vistas derivadas de la bitácora (Case Pick / Putaway / Receiving) ─────────
async def movement_feed(kind: str, since: str = "", until: str = "",
                        q: str = "", limit: int = 500) -> dict:
    """Filas aplanadas de wms_movements para la familia pedida. Se LEEN del log;
    no se recaptura nada."""
    types = MOVEMENT_FAMILIES.get(kind)
    if not types:
        return {"rows": [], "total": 0, "count": 0}
    query: dict = {"type": {"$in": types}}
    created: dict = {}
    if since:
        created["$gte"] = since
    if until:
        created["$lte"] = until + "T23:59:59"
    if created:
        query["created_at"] = created
    term = (q or "").strip()
    if term:
        import re as _re
        rx = {"$regex": _re.escape(term), "$options": "i"}
        query["$or"] = [{f"details.{f}": rx} for f in
                        ("box_id", "sku", "style", "color", "order_number",
                         "ticket_id", "location", "to", "destination", "receiving_id")]
    from routers.wms import _flatten_movement, _explode_movement_rows  # lazy
    limit = max(1, min(int(limit or 500), 2000))
    total = await db.wms_movements.count_documents(query)
    docs = await db.wms_movements.find(query).sort("created_at", -1).to_list(limit)
    rows = []
    for m in docs:
        try:
            exploded = _explode_movement_rows(m)
        except Exception:
            exploded = None
        if exploded:
            rows.extend(exploded)
        else:
            rows.append(_flatten_movement(m))
    return {"rows": rows, "total": total, "count": len(docs)}


# ── Sesiones de auditoría por caja (Sampling Results) ─────────────────────────
# Medición pura: Físico vs Sistema por caja. NO muta inventario (igual que la
# hoja: el conteo mide, el ajuste es aparte). Alimenta kpis_rollup y la pestaña
# Sampling del módulo.
class AuditError(Exception):
    def __init__(self, status, detail):
        super().__init__(detail)
        self.status, self.detail = status, detail


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _sid() -> str:
    return "aud_" + uuid.uuid4().hex[:12]


def session_metrics(session: dict) -> dict:
    """Métricas de UNA sesión desde sus líneas de caja YA contadas."""
    boxes = [b for b in (session.get("boxes") or []) if b.get("counted")]
    n = len(boxes)
    sys_p = sum(int(b.get("system_units") or 0) for b in boxes)
    phy_p = sum(int(b.get("counted_units") or 0) for b in boxes)
    abs_p = sum(abs(int(b.get("counted_units") or 0) - int(b.get("system_units") or 0)) for b in boxes)
    content_bad = [b for b in boxes if b.get("content_ok") is False]
    located_ok = [b for b in boxes if b.get("located_ok") is not False]   # default True
    correct = [b for b in boxes
               if int(b.get("counted_units") or 0) == int(b.get("system_units") or 0)
               and b.get("content_ok") is not False]
    return {
        "boxes_sampled": n,
        "boxes_correct": len(correct),
        "boxes_discrepancy": n - len(correct),
        "boxes_content_bad": len(content_bad),
        "content_bad_pct": round(len(content_bad) / n * 100, 2) if n else 0.0,
        "boxes_located_ok": len(located_ok),
        "system_pieces": sys_p,
        "physical_pieces": phy_p,
        "net_discrepancy": phy_p - sys_p,
        "abs_discrepancy_pieces": abs_p,
        "ira_pct": round(max(0.0, (1 - abs_p / sys_p) * 100), 1) if sys_p > 0 else 100.0,
        "ila_pct": round(len(located_ok) / n * 100, 1) if n else None,
    }


async def create_session(user: dict, note: str = "") -> dict:
    doc = {
        "session_id": _sid(), "status": "open", "created_at": _now(),
        "created_by": user.get("user_id"),
        "created_by_name": user.get("name") or user.get("email"),
        "closed_at": None, "note": (note or "").strip(), "boxes": [],
    }
    await db.wms_audit_sessions.insert_one(dict(doc))
    return {**doc, "metrics": session_metrics(doc)}


async def list_sessions(limit: int = 50) -> dict:
    docs = await db.wms_audit_sessions.find({}, {"_id": 0}).sort(
        "created_at", -1).to_list(max(1, min(int(limit or 50), 500)))
    return {"sessions": [{
        "session_id": d["session_id"], "status": d.get("status"),
        "created_at": d.get("created_at"), "closed_at": d.get("closed_at"),
        "created_by_name": d.get("created_by_name"), "note": d.get("note"),
        "metrics": session_metrics(d),
    } for d in docs]}


async def get_session(session_id: str):
    d = await db.wms_audit_sessions.find_one({"session_id": session_id}, {"_id": 0})
    if not d:
        return None
    return {**d, "metrics": session_metrics(d)}


async def _require_open(session_id: str) -> dict:
    s = await db.wms_audit_sessions.find_one({"session_id": session_id})
    if not s:
        raise AuditError(404, "Sesión de auditoría no encontrada.")
    if s.get("status") != "open":
        raise AuditError(400, "La sesión ya está cerrada.")
    return s


async def add_box(session_id: str, box_id: str) -> dict:
    """Agrega una caja resolviendo identidad + unidades de SISTEMA (snapshot)
    desde wms_boxes. Aún sin contar (counted=False)."""
    await _require_open(session_id)
    bid = (box_id or "").strip().upper()
    if not bid:
        raise AuditError(400, "Escanea un número de caja.")
    box = await db.wms_boxes.find_one({"box_id": bid}, {"_id": 0})
    if not box:
        raise AuditError(404, f"La caja {bid} no existe en el sistema.")
    dup = await db.wms_audit_sessions.find_one(
        {"session_id": session_id, "boxes.box_id": bid}, {"_id": 1})
    if dup:
        raise AuditError(409, f"La caja {bid} ya está en esta sesión.")
    line = {
        "box_id": bid, "location": box.get("location") or "",
        "style": box.get("style") or "", "color": box.get("color") or "",
        "size": box.get("size") or "", "sku": box.get("sku") or "",
        "customer": box.get("customer") or "",
        "system_units": int(box.get("units") or 0),
        "counted_units": None, "counted": False,
        "content_ok": None, "located_ok": None,
        "counted_by": None, "counted_at": None,
    }
    await db.wms_audit_sessions.update_one(
        {"session_id": session_id}, {"$push": {"boxes": line}})
    return await get_session(session_id)


async def set_box_count(session_id: str, box_id: str, user: dict, counted_units,
                        content_ok: bool = True, located_ok: bool = True) -> dict:
    await _require_open(session_id)
    bid = (box_id or "").strip().upper()
    try:
        cu = int(counted_units)
    except (TypeError, ValueError):
        raise AuditError(400, "Cantidad física inválida.")
    if cu < 0:
        raise AuditError(400, "La cantidad física no puede ser negativa.")
    res = await db.wms_audit_sessions.update_one(
        {"session_id": session_id, "boxes.box_id": bid},
        {"$set": {
            "boxes.$.counted_units": cu, "boxes.$.counted": True,
            "boxes.$.content_ok": bool(content_ok),
            "boxes.$.located_ok": bool(located_ok),
            "boxes.$.counted_by": user.get("user_id"),
            "boxes.$.counted_at": _now(),
        }})
    if not res.matched_count:
        raise AuditError(404, f"La caja {bid} no está en esta sesión.")
    return await get_session(session_id)


async def remove_box(session_id: str, box_id: str) -> dict:
    await _require_open(session_id)
    await db.wms_audit_sessions.update_one(
        {"session_id": session_id},
        {"$pull": {"boxes": {"box_id": (box_id or "").strip().upper()}}})
    return await get_session(session_id)


async def close_session(session_id: str) -> dict:
    await _require_open(session_id)
    await db.wms_audit_sessions.update_one(
        {"session_id": session_id},
        {"$set": {"status": "closed", "closed_at": _now()}})
    return await get_session(session_id)


async def delete_session(session_id: str) -> dict:
    res = await db.wms_audit_sessions.delete_one({"session_id": session_id})
    return {"deleted": res.deleted_count}


# ── Ajuste de inventario disparado por auditoría (Fase 4) ─────────────────────
async def apply_adjustment(user: dict, box_id: str, counted_units, reason: str,
                           located_ok: bool = True, session_id: str = None) -> dict:
    """Ajuste a nivel CAJA disparado por una auditoría. Valida el motivo contra el
    catálogo curado y rutea por el ESCRITOR ÚNICO del WMS (_adjust_box_to_count:
    muta la caja y reproyecta el renglón). Etiqueta el movimiento como
    'auditoria_adjustment' para el historial IRA/ILA. NO escribe inventario por su
    cuenta — ese camino es el sancionado y ya probado del Mover."""
    cfg = await get_cfg()
    reason = (reason or "").strip()
    if not validate_reason(reason, cfg):
        raise AuditError(400, "El motivo no está en el catálogo de Auditorías. Elige uno de la lista.")
    try:
        cu = int(counted_units)
    except (TypeError, ValueError):
        raise AuditError(400, "Cantidad física inválida.")
    if cu < 0:
        raise AuditError(400, "La cantidad física no puede ser negativa.")
    bid = (box_id or "").strip().upper()
    box = await db.wms_boxes.find_one({"box_id": bid}, {"_id": 0})
    if not box:
        box = await db.wms_boxes.find_one({"$or": [{"barcode": bid}, {"lpn_id": bid}]}, {"_id": 0})
    if not box:
        raise AuditError(404, f"La caja {bid} no existe en el sistema.")
    from routers.wms import _adjust_box_to_count  # lazy: evita ciclo de import
    res = await _adjust_box_to_count(
        user, box, cu, reason, mv_type="auditoria_adjustment",
        mv_extra={"via": "auditoria", "source": "auditorias",
                  "session_id": session_id, "located_ok": bool(located_ok)})
    if session_id:
        await db.wms_audit_sessions.update_one(
            {"session_id": session_id, "boxes.box_id": box["box_id"]},
            {"$set": {"boxes.$.adjusted": True, "boxes.$.adjusted_at": _now()}})
    return res
