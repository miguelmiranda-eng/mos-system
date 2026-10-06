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
from datetime import date

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
