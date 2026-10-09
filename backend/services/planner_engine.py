"""Motor de planeación: funciones PURAS (sin base de datos) para que el smoke
las pruebe con datos sembrados y el router sólo junte lo que hay en Mongo.

LAS REGLAS (acordadas con el responsable de planeación, 2026-09-23)
────────────────────────────────────────────────────────────────────
- Capacidad en HITS: 1 hit = 1 impresión. Una prenda con frente y espalda son
  2 hits. Cada cuadrilla imprime `hits_per_shift` (4,500) por turno.
- Turnos DIA y NOCHE de 7 a 7, de lunes a jueves. Viernes, sábado y domingo
  son sólo tiempo extra (se dan de alta en el calendario).
- Lo que limita es la GENTE, no las máquinas: 14 máquinas pero cuadrillas
  para 9 de día y 4 de noche. Todo editable (config + calendario).
- La noche CONTINÚA la orden de la máquina: no hay corte de turno. Como de
  noche corren menos máquinas, siguen las que traen el trabajo más urgente.
- Unidad programable = orden × posición (FRENTE / ESPALDA / MANGA). Las
  posiciones de una orden pueden ir en paralelo en máquinas distintas.
- Entra al programa sólo si: blank CONTADO (o SURTIDO), cuadros (screens),
  LABEL LISTO y, si es orden NUEVA, ejemplo aprobado (reorden no lo necesita;
  sale de `aprobaciones` + módulo de Ejemplos). El filtro es de ENTRADA: lo que ya arrancó (tiene producción o
  está en tablero de máquina) no se saca porque su status avanzó.
- Fecha objetivo = cancel date (sin colchón; `buffer_business_days` = 0. Se
  puede volver a poner N días hábiles antes en Reglas).
- Volumen: Bajo < 1,500, Medio 1,500–2,499, Alto ≥ 2,500 (por pieza del job).
  Mezcla: una máquina no recibe un segundo Alto en el turno mientras otra
  máquina que corre no tiene ninguno.
- Cabezas: una máquina sólo toma trabajos con colores ≤ sus cabezas (8–20).
- Cliente de máquina = preferencia, sólo desempata.
- El motor NUNCA cambia el cancel date: sugiere uno nuevo.
"""
from __future__ import annotations

import math
import unicodedata
from datetime import date, datetime, timedelta, time, timezone
from typing import Dict, List, Optional

# ── Configuración por defecto ──────────────────────────────────────────────
DEFAULT_CONFIG = {
    "hits_per_shift": 4500,          # por cuadrilla por turno
    "rate_pph": 407,                 # hits por hora de impresión (Sheet)
    "setup_min_per_color": 15,
    "default_colors": 6,             # si la orden no trae # de colores
    "buffer_business_days": 0,      # días hábiles antes del cancel (0 = el cancel mismo)
    "volume_low_max": 1500,          # < esto = Bajo
    "volume_high_min": 2500,         # >= esto = Alto
    "ready_blank_statuses": ["CONTADO", "CONTADO/PICKED", "SURTIDO"],
    "ready_require_screens": True,
    "ready_production_statuses": ["LABEL LISTO"],
    # Tableros cuya demanda cuenta (además de las MAQUINA<n>).
    "demand_boards": ["SCHEDULING", "READY TO SCHEDULED", "BLANKS", "SCREENS", "NECK"],
    # Orden en que se programan las posiciones de una orden (frente antes que
    # espalda). Es el último desempate del acomodo; vaciar la lista lo apaga.
    "position_order": ["FRENTE", "ESPALDA", "MANGA"],
    # Prioridad por tipo de empaque (columna MOS packing_type). Dentro de la
    # misma urgencia, estos se programan primero en este orden; lo que no esté
    # en la lista va al final. Vaciar la lista lo apaga.
    "packing_priority": ["BulkPack", "Prepack", "PickPack"],
    # Trabajo EXTRA (no impresión) que marca una orden: sale del bloque de
    # operaciones del work order (líneas con FRONT/BACK PRINT). Una operación
    # sin "PRINT" es trabajo extra, SALVO estas estándar que trae casi todo.
    "extra_work_ignore": ["FINISHING", "NECK LABEL", "PICK & PACK",
                          "PICK AND PACK", "PICK&PACK", "(PENDING CAD)"],
    # Test Orders (programa SPENCERS TEST): se identifican por el branding.
    # Se separan en el dashboard de producción. Patrón (contiene), editable.
    "test_branding_patterns": ["TEST"],
    # Umbrales de la auditoría de producción (excepciones).
    "audit_printed_pct": 90,        # impresa ≥ esto pero status sin avanzar = atrasada
    "audit_no_movement_days": 3,    # orden en máquina sin registro en estos días
    "audit_no_capture_hours": 24,   # máquina activa sin registro en estas horas
    "audit_overprint_pct": 115,     # producido > esto % de lo requerido = sobreimpresión
    # production_status que significan "ya se imprimió" (sale de la demanda).
    "printed_statuses": [
        "NECESITA EMPACAR", "EN PROCESO DE EMPAQUE", "NECESITA QC", "CORRECIÓN DE QC",
        "LISTO PARA FULFILLMENT", "LISTO PARA ENVIO", "LISTO PARA INVENTARIO",
        "CANCELLED", "ENVIADO TIJANA-SAN DIEGO",
    ],
    "shifts": [
        {"key": "DIA", "start": "07:00", "hours": 12, "crews": 9},
        {"key": "NOCHE", "start": "19:00", "hours": 12, "crews": 4},
    ],
    "base_weekdays": [0, 1, 2, 3],   # lunes..jueves (0 = lunes)
    "people_per_crew": 7,
    # manual 100% = la regla de 4,500 tal cual. "auto" usa la eficiencia medida
    # en production_logs (mediana por máquina-turno); se muestra siempre como
    # dato, pero sólo manda si el responsable la elige.
    "efficiency_mode": "manual",
    "efficiency_manual_pct": 100,
    "horizon_weeks": 8,
    # off = apagado (no calcula nada) | shadow = calcula y muestra, NO mueve
    # órdenes. El modo que mueve tableros no existe todavía: se habilita en
    # otra fase, con autorización explícita del responsable.
    "engine_mode": "off",
    # Recálculo automático (modo sombra): la pantalla recalcula sola cuando
    # cambia una orden o una captura de producción, y cuando la última corrida
    # tiene más de `auto_recalc_minutes`. Sigue sin mover nada.
    "auto_recalc": True,
    "auto_recalc_minutes": 15,
    # Alerta "impresa sin cambiar de estatus": ya se imprimió según
    # production_logs (≥ este % de sus hits) y pasaron estos días desde la
    # última captura sin que su production_status avanzara.
    "printed_complete_pct": 98,
    "printed_alert_days": 2,
    # Reorden vs. nueva (Approval Type del CRM, `aprobaciones`). Las nuevas
    # sólo entran al programa con su ejemplo aprobado (módulo de Ejemplos).
    "ready_require_sample": True,
    "sample_reorder_values": ["Reorder", "Reorder Spirit"],
    "sample_required_values": ["Ejemplo primero", "Pendiente aprobación", "Licencia"],
    "sample_approved_values": ["Aprobado para producción"],
    "sample_at_machine_values": ["Aprobación en máquina"],
    "sample_hold_values": ["Hold"],
    # Columna Sample del CRM (`sample`) que cuenta como ejemplo aprobado.
    "sample_ok_values": ["EJEMPLO APROBADO", "APR. POR FOTO"],
    # Columna Sample = "NO SAMPLE": la orden NO requiere ejemplo (no aplica),
    # entra aunque sea nueva. Columna Sample = "LICENCIA": necesita ejemplo con
    # licencia (Warner, etc.); esos tardan más y quedan PENDIENTE hasta aprobarse.
    "sample_none_values": ["NO SAMPLE"],
    "sample_license_values": ["LICENCIA"],
}

MACHINE_DEFAULTS = {"active": True, "heads": 16, "preferred_client": "",
                    "dedicated": False, "pallet_size": "", "has_folder": False}
HEADS_MIN, HEADS_MAX = 8, 20

PRIORITY_RANK = {"SPECIAL RUSH": 0, "RUSH": 1, "OVERSOLD": 2, "PRIORITY 1": 3,
                 "EVENT": 4, "PRIORITY 2": 5}


def merge_config(saved: Optional[dict]) -> dict:
    cfg = dict(DEFAULT_CONFIG)
    for k, v in (saved or {}).items():
        if k in DEFAULT_CONFIG and v is not None:
            cfg[k] = v
    return cfg


# ── Calendario ─────────────────────────────────────────────────────────────
def _nth_weekday(year: int, month: int, weekday: int, n: int) -> date:
    d = date(year, month, 1)
    d += timedelta(days=(weekday - d.weekday()) % 7)
    return d + timedelta(weeks=n - 1)


def mx_holidays(year: int) -> Dict[str, str]:
    """Descansos obligatorios de la LFT (art. 74). Las jornadas electorales
    no se incluyen: se dan de alta a mano cuando toquen."""
    h = {
        date(year, 1, 1): "Año Nuevo",
        _nth_weekday(year, 2, 0, 1): "Día de la Constitución",
        _nth_weekday(year, 3, 0, 3): "Natalicio de Benito Juárez",
        date(year, 5, 1): "Día del Trabajo",
        date(year, 9, 16): "Día de la Independencia",
        _nth_weekday(year, 11, 0, 3): "Día de la Revolución",
        date(year, 12, 25): "Navidad",
    }
    if (year - 2024) % 6 == 0:
        h[date(year, 10, 1)] = "Transmisión del Poder Ejecutivo"
    return {d.isoformat(): name for d, name in h.items()}


class Calendar:
    """Cuántas cuadrillas corren en (fecha, turno).

    entries: excepciones del calendario, cada una con date_from/date_to y
      kind = holiday  → ese día no se trabaja (ambos turnos o el indicado)
             workday  → anula un festivo oficial
             crews    → cambia las cuadrillas de un día base (más o menos gente)
             overtime → tiempo extra: cuadrillas en un día que no es base
    """

    def __init__(self, cfg: dict, entries: List[dict], max_machines: int):
        self.cfg = cfg
        self.max_machines = max_machines
        self.base_crews = {s["key"]: int(s.get("crews") or 0) for s in cfg["shifts"]}
        self.base_weekdays = set(cfg["base_weekdays"])
        self.entries = entries or []
        self._hol_cache: Dict[int, Dict[str, str]] = {}

    def _official(self, d: date) -> Optional[str]:
        if d.year not in self._hol_cache:
            self._hol_cache[d.year] = mx_holidays(d.year)
        return self._hol_cache[d.year].get(d.isoformat())

    def _matching(self, d: date, shift: str):
        ds = d.isoformat()
        for e in self.entries:
            if (e.get("date_from") or "") <= ds <= (e.get("date_to") or e.get("date_from") or ""):
                sh = e.get("shift") or "AMBOS"
                if sh in ("AMBOS", shift):
                    yield e

    def holiday_name(self, d: date) -> Optional[str]:
        """Nombre del festivo que aplica ese día (None si es día normal)."""
        ents = list(self._matching(d, "AMBOS"))
        if any(e["kind"] == "workday" for e in ents):
            return None
        for e in ents:
            if e["kind"] == "holiday":
                return e.get("note") or "Festivo"
        return self._official(d)

    def is_business_day(self, d: date) -> bool:
        return d.weekday() in self.base_weekdays and self.holiday_name(d) is None

    def crews(self, d: date, shift: str) -> int:
        ents = list(self._matching(d, shift))
        if any(e["kind"] == "holiday" for e in ents):
            return 0
        official = self._official(d) and not any(e["kind"] == "workday" for e in ents)
        n = 0
        if d.weekday() in self.base_weekdays and not official:
            n = self.base_crews.get(shift, 0)
        for e in ents:
            if e["kind"] == "crews" and d.weekday() in self.base_weekdays and not official:
                n = int(e.get("crews") or 0)
        for e in ents:
            if e["kind"] == "overtime":
                n = max(n, int(e.get("crews") or 0))
        return max(0, min(n, self.max_machines))

    def window(self, d: date, shift: str, default_start: str, default_hours: float):
        """(hora de inicio, horas) del turno ese día. El tiempo extra puede
        traer sus propias horas (p. ej. sábado 07:00 por 6 h): la ventana y la
        capacidad del turno se ajustan a eso. Sin horas = turno completo."""
        for e in self._matching(d, shift):
            if e["kind"] == "overtime" and e.get("hours"):
                return (e.get("start") or default_start), float(e["hours"])
        return default_start, float(default_hours)

    def minus_business_days(self, d: date, n: int) -> date:
        while n > 0:
            d -= timedelta(days=1)
            if self.is_business_day(d):
                n -= 1
        return d

    def plus_business_days(self, d: date, n: int) -> date:
        while n > 0:
            d += timedelta(days=1)
            if self.is_business_day(d):
                n -= 1
        return d


# ── Órdenes → jobs ─────────────────────────────────────────────────────────
def parse_date(v) -> Optional[date]:
    if not v:
        return None
    if isinstance(v, datetime):
        return v.date()
    if isinstance(v, date):
        return v
    try:
        return date.fromisoformat(str(v)[:10])
    except ValueError:
        return None


def _int(v) -> Optional[int]:
    try:
        n = int(float(str(v).strip()))
        return n
    except (TypeError, ValueError):
        return None


def volume_class(qty: int, cfg: dict) -> str:
    if qty >= cfg["volume_high_min"]:
        return "ALTO"
    if qty < cfg["volume_low_max"]:
        return "BAJO"
    return "MEDIO"


def _norm(s) -> str:
    """Mayúsculas y sin acentos: "Aprobación en máquina" = "APROBACION EN MAQUINA"."""
    return "".join(c for c in unicodedata.normalize("NFD", str(s or ""))
                   if unicodedata.category(c) != "Mn").strip().upper()


def sample_info(order: dict, cfg: dict, sample_approved: Optional[set] = None) -> Dict[str, str]:
    """Reorden vs. nueva y en qué va su ejemplo. Sale de lo que MOS ya tiene:
    `aprobaciones` (Approval Type del CRM) y la aprobación del módulo de
    Ejemplos (sample_tasks.approval = APROBADO, que espeja en
    orders.sample = "EJEMPLO APROBADO").

    kind:  REORDEN | NUEVA | SIN_DATO
    state: NO_APLICA (reorden / no requiere ejemplo) | APROBADO | EN_MAQUINA
           | PENDIENTE | HOLD | SIN_DATO
    """
    ap = _norm(order.get("aprobaciones"))
    art = _norm(order.get("artwork_status"))
    scol = _norm(order.get("sample"))
    approved = (scol in {_norm(x) for x in cfg["sample_ok_values"]}
                or (sample_approved is not None and order.get("order_id") in sample_approved))
    none_required = scol in {_norm(x) for x in cfg["sample_none_values"]}
    needs_license = scol in {_norm(x) for x in cfg["sample_license_values"]}
    # Reorden nunca necesita ejemplo (el original ya se aprobó en su día).
    if ap in {_norm(x) for x in cfg["sample_reorder_values"]}:
        return {"kind": "REORDEN", "state": "NO_APLICA"}
    # Hold en el Approval Type manda: no se produce, tenga o no ejemplo.
    if ap in {_norm(x) for x in cfg["sample_hold_values"]}:
        return {"kind": "NUEVA", "state": "HOLD"}
    # La columna Sample del CRM es la señal directa del estado del ejemplo:
    #   NO SAMPLE → no requiere ejemplo (entra aunque sea nueva).
    #   aprobado  → ejemplo aprobado (columna o módulo de Ejemplos).
    #   LICENCIA  → necesita ejemplo con licencia (Warner…): PENDIENTE, tarda más.
    if none_required:
        return {"kind": "NUEVA", "state": "NO_APLICA"}
    if approved:
        return {"kind": "NUEVA", "state": "APROBADO"}
    if needs_license:
        return {"kind": "NUEVA", "state": "PENDIENTE"}
    if ap in {_norm(x) for x in cfg["sample_approved_values"]}:
        return {"kind": "NUEVA", "state": "APROBADO"}
    if ap in {_norm(x) for x in cfg["sample_at_machine_values"]}:
        return {"kind": "NUEVA", "state": "EN_MAQUINA"}
    if ap in {_norm(x) for x in cfg["sample_required_values"]}:
        return {"kind": "NUEVA", "state": "PENDIENTE"}
    # Sin Approval Type: el artwork_status desempata (REORDER = reorden).
    if not ap and art == "REORDER":
        return {"kind": "REORDEN", "state": "NO_APLICA"}
    return {"kind": "SIN_DATO", "state": "SIN_DATO"}


SAMPLE_OK_STATES = {"NO_APLICA", "APROBADO", "EN_MAQUINA"}


def readiness(order: dict, cfg: dict, sample_approved: Optional[set] = None) -> Dict[str, bool]:
    blank = str(order.get("blank_status") or "").strip().upper()
    prod = str(order.get("production_status") or "").strip().upper()
    info = sample_info(order, cfg, sample_approved)
    return {
        "contado": blank in {s.upper() for s in cfg["ready_blank_statuses"]},
        "cuadros": (order.get("screens") is True) if cfg["ready_require_screens"] else True,
        "label": prod in {s.upper() for s in cfg["ready_production_statuses"]},
        # Nueva = necesita ejemplo aprobado; reorden no. Sin Approval Type no
        # se sabe: se bloquea para que alguien lo capture.
        "ejemplo": (info["state"] in SAMPLE_OK_STATES) if cfg["ready_require_sample"] else True,
    }


def positions_of(order: dict) -> Dict[str, int]:
    """{posición: hits por pieza}. Si los hits no cuadran con las posiciones:
    más hits que posiciones → el extra va a MANGA (dos mangas) o a la última
    posición; sin posiciones → "HIT n"."""
    positions = [p for p in (order.get("print_positions") or []) if p]
    hits = _int(order.get("hits_impresiones"))
    if positions:
        per_pos = {p: 1 for p in positions}
        extra = (hits or len(positions)) - len(positions)
        if extra > 0:
            per_pos["MANGA" if "MANGA" in per_pos else positions[-1]] += extra
        return per_pos
    return {f"HIT {i + 1}": 1 for i in range(hits or 1)}


def print_progress(order: dict, produced_for_order: Dict[str, int]) -> dict:
    """Cuánto se ha impreso por posición según production_logs. La producción
    capturada sin posición llena las posiciones en orden."""
    qty = _int(order.get("quantity")) or 0
    done = dict(produced_for_order or {})
    loose = done.pop("", 0)
    out, req_total, made_total = {}, 0, 0
    for pos, mult in positions_of(order).items():
        required = qty * mult
        made = done.get(pos, 0)
        if loose and made < required:
            take = min(loose, required - made)
            made += take
            loose -= take
        out[pos] = {"required": required, "made": made}
        req_total += required
        made_total += min(made, required)
    pct = (100.0 * made_total / req_total) if req_total else 0.0
    return {"positions": out, "required": req_total, "made": made_total, "complete_pct": pct}


def stale_printed(orders: List[dict], produced: Dict[str, Dict[str, int]],
                  last_log: Dict[str, str], cfg: dict, now: datetime) -> List[dict]:
    """Alerta: la orden ya se imprimió (≥ printed_complete_pct según
    production_logs), su última captura tiene `printed_alert_days` días o más,
    y su production_status sigue sin avanzar (no está en printed_statuses)."""
    printed = {s.upper() for s in cfg["printed_statuses"]}
    limit = float(cfg["printed_alert_days"])
    out = []
    for o in orders:
        status = str(o.get("production_status") or "").strip().upper()
        if status in printed or not last_log.get(o.get("order_id")):
            continue
        prog = print_progress(o, produced.get(o.get("order_id"), {}))
        if not prog["required"] or prog["complete_pct"] < float(cfg["printed_complete_pct"]):
            continue
        try:
            last = datetime.fromisoformat(str(last_log[o["order_id"]]))
        except ValueError:
            continue
        if last.tzinfo is None:                 # capturas viejas sin zona = UTC
            last = last.replace(tzinfo=timezone.utc)
        days = (now - last).total_seconds() / 86400.0
        if days < limit:
            continue
        out.append({"order_id": o.get("order_id"), "order_number": str(o.get("order_number") or ""),
                    "client": o.get("client") or "", "branding": o.get("branding") or "",
                    "board": o.get("board") or "", "production_status": o.get("production_status") or "",
                    "cancel_date": o.get("cancel_date"), "quantity": _int(o.get("quantity")) or 0,
                    "required": prog["required"], "made": prog["made"],
                    "complete_pct": round(prog["complete_pct"], 1),
                    "last_print": last.isoformat(), "days": round(days, 1)})
    return sorted(out, key=lambda r: -r["days"])


def is_test_branding(branding: str, cfg: dict) -> bool:
    """Test Orders (programa SPENCERS TEST) por su branding. Patrón configurable."""
    up = str(branding or "").upper()
    return any(str(p).upper() in up for p in cfg.get("test_branding_patterns", []) if str(p).strip())


def extra_work_of(order: dict, cfg: dict) -> List[str]:
    """Operaciones que NO son impresión y que marcan la orden como "trabajo
    extra" (rhinestones, glitter, puff, foil, bordado, manga…). Salen del
    bloque de operaciones del work order (la línea con FRONT/BACK PRINT); una
    sub-línea sin "PRINT" es extra, salvo las estándar de `extra_work_ignore`
    (finishing, neck label, pick&pack, pending cad) que trae casi todo."""
    ignore = {str(x).strip().upper() for x in cfg.get("extra_work_ignore", [])}
    out, seen = [], set()
    for line in ((order.get("work_order") or {}).get("lines") or []):
        up = str(line).upper()
        if "FRONT PRINT" not in up and "BACK PRINT" not in up:
            continue
        for sub in str(line).replace("\r", "").split("\n"):
            sub = sub.strip()
            key = sub.upper()
            if not sub or "PRINT" in key or key in ignore or key in seen:
                continue
            seen.add(key)
            out.append(sub)
    return out


def build_jobs(orders: List[dict], produced: Dict[str, Dict[str, int]], cfg: dict,
               cal: Calendar, machines: List[str], today: date,
               sample_approved: Optional[set] = None):
    """Convierte órdenes abiertas en jobs (orden × posición) con su hits
    restante, preparación, fecha objetivo y banderas de calidad de datos.

    produced: {order_id: {"FRENTE": n, "ESPALDA": n, "MANGA": n, "": n}}
    """
    machine_set = set(machines)
    printed = {s.upper() for s in cfg["printed_statuses"]}
    pos_order = cfg.get("position_order") or []
    pos_rank = {p.upper(): i for i, p in enumerate(pos_order)}
    pack_order = cfg.get("packing_priority") or []
    pack_rank = {p.upper(): i for i, p in enumerate(pack_order)}
    jobs, issues = [], []
    for o in orders:
        prod_status = str(o.get("production_status") or "").strip().upper()
        if prod_status in printed:
            continue
        qty = _int(o.get("quantity")) or 0
        positions = [p for p in (o.get("print_positions") or []) if p]
        hits = _int(o.get("hits_impresiones"))
        colors = _int(o.get("colors"))
        cancel = parse_date(o.get("cancel_date"))
        flags = []
        if qty <= 0:
            flags.append("sin_cantidad")
        if not hits:
            flags.append("sin_hits")
        if not positions:
            flags.append("sin_posiciones")
        if not colors:
            flags.append("sin_colores")
        if cancel is None:
            flags.append("sin_cancel_date")
        if sample_info(o, cfg, sample_approved)["kind"] == "SIN_DATO":
            flags.append("sin_tipo_aprobacion")
        # MANGA son dos mangas: FRENTE+ESPALDA+MANGA con 4 hits está bien (el
        # hit extra ya se le asigna a MANGA en positions_of). Sólo se marca lo
        # que de verdad no cuadra, p. ej. sólo FRENTE con 2 hits.
        two_sleeves = "MANGA" in positions and hits == len(positions) + 1
        if hits and positions and hits != len(positions) and not two_sleeves:
            flags.append("hits_distinto_posiciones")
        base = {"order_id": o.get("order_id"), "order_number": str(o.get("order_number") or ""),
                "client": o.get("client") or "", "branding": o.get("branding") or "",
                "board": o.get("board") or "", "cancel_date": cancel.isoformat() if cancel else None}
        if flags:
            issues.append({**base, "flags": flags, "quantity": qty, "hits": hits,
                           "positions": positions, "colors": colors})
        if qty <= 0:
            continue

        prog = print_progress(o, produced.get(o.get("order_id"), {}))
        # Impresa completa (≥ printed_complete_pct): no se programan los
        # sobrantes de unas cuantas piezas; si su estatus no avanzó, lo cacha
        # la alerta de "impresa sin cambiar de estatus".
        if prog["complete_pct"] >= float(cfg["printed_complete_pct"]):
            continue
        ready = readiness(o, cfg, sample_approved)
        sinfo = sample_info(o, cfg, sample_approved)
        extra_work = extra_work_of(o, cfg)
        started = (o.get("board") in machine_set or prod_status == "EN PRODUCCION" or prog["made"] > 0)
        target = cal.minus_business_days(cancel, cfg["buffer_business_days"]) if cancel else None
        for pos, p in prog["positions"].items():
            job_hits, made = p["required"], p["made"]
            remaining = max(0, job_hits - made)
            if remaining <= 0:
                continue
            jobs.append({
                **base,
                "job_id": f"{o.get('order_id')}:{pos}",
                "position": pos,
                "quantity": qty,
                "hits": job_hits,
                "produced": made,
                "remaining": remaining,
                "colors": colors or cfg["default_colors"],
                "colors_known": bool(colors),
                "color": o.get("color") or "",
                "design": str(o.get("design_#") or "").strip(),
                "customer_po": str(o.get("customer_po") or "").strip(),
                "extra_work": extra_work,
                "has_extra_work": bool(extra_work),
                "priority": str(o.get("priority") or "").strip().upper(),
                "volume": volume_class(qty, cfg),
                "ready": ready,
                "kind": sinfo["kind"],
                "sample_state": sinfo["state"],
                "is_ready": all(ready.values()),
                "started": started,
                "target_date": target.isoformat() if target else None,
                "_pos_rank": pos_rank.get(str(pos).upper(), len(pos_order)),
                "_pack_rank": pack_rank.get(str(o.get("packing_type") or "").strip().upper(), len(pack_order)),
            })
    return jobs, issues


# ── Motor de programación ──────────────────────────────────────────────────
def _shift_windows(cfg: dict, cal: Calendar, start: datetime, weeks: int):
    """Genera (fecha, turno, inicio, fin, cuadrillas) desde `start`."""
    d = start.date() - timedelta(days=1)   # la noche de ayer puede seguir viva
    end = start + timedelta(weeks=weeks)
    while True:
        for s in cfg["shifts"]:
            full_h = float(s.get("hours") or 12)
            st, hrs = cal.window(d, s["key"], s["start"], full_h)
            hh, mm = (int(x) for x in st.split(":"))
            w0 = datetime.combine(d, time(hh, mm), tzinfo=start.tzinfo)
            w1 = w0 + timedelta(hours=hrs)
            if w1 <= start:
                continue
            if w0 >= end:
                return
            # `full` = el turno completo: un tiempo extra de 6 h en un turno de
            # 12 h rinde la mitad de la capacidad del turno.
            yield d, s["key"], max(w0, start), w1, timedelta(hours=full_h), cal.crews(d, s["key"])
        d += timedelta(days=1)


MANUAL_RANK = {"TOP": 0, "UP": 1, "DOWN": 3}   # sin ajuste = 2


def _sort_key(j):
    return (j.get("_manual_rank", 2),
            0 if j["started"] else 1,
            PRIORITY_RANK.get(j["priority"], 9),
            j["target_date"] or "9999-12-31",
            j.get("_pack_rank", 0),  # prioridad por tipo de empaque (tras la urgencia)
            j.get("_pos_rank", 0),   # frente antes que espalda (último desempate)
            -j["remaining"])


def _held(ov: dict, today: date) -> bool:
    if "hold" not in ov:
        return False
    h = ov["hold"] or {}
    until = parse_date(h.get("until"))
    return until is None or until >= today


def schedule(jobs: List[dict], machines: List[dict], cfg: dict, cal: Calendar,
             start: datetime, efficiency: float, board_of: Dict[str, str],
             overrides: Optional[Dict[str, dict]] = None, run_rates: Optional[dict] = None):
    """Simulación turno por turno.

    machines: [{"machine": "MAQUINA1", "active": bool, "heads": int, "preferred_client": str}]
    board_of: {order_id: board actual} — lo que ya está en una MAQUINA arranca ahí.
    overrides: ajustes manuales del planeador por job_id, ya resueltos:
      {"assign": {"machine", "queue_pos", "not_before"},   reprogramar / fijar
       "priority": {"level": TOP|UP|DOWN},
       "force": {...},                                      entra aunque no esté lista
       "hold": {"until"}}                                    no se programa
    El motor RESPETA los ajustes: no los mueve ni los discute; sólo avisa si
    algo no cuadra (máquina inactiva, colores > cabezas).
    """
    overrides = overrides or {}
    today = start.date()
    active = [m for m in machines if m.get("active")]
    cap_shift = cfg["hits_per_shift"] * efficiency
    setup_hits_per_color = cfg["setup_min_per_color"] * cfg["rate_pph"] * efficiency / 60.0
    # Velocidad por tamaño de corrida. El turno se mide en "hits de referencia"
    # (a rate_pph); imprimir a otra velocidad cuesta rate_pph/velocidad de la
    # corrida: un Alto (más rápido) cabe más en el turno, un Bajo menos. Sin
    # histórico, _rate_of cae a rate_pph y el programa queda IGUAL que antes.
    rate_pph = float(cfg["rate_pph"])
    _rates = (run_rates or {}).get("rates") or {}
    _glob = (run_rates or {}).get("global_rate")

    def _rate_of(j):
        return float(_rates.get(j["volume"]) or _glob or rate_pph)

    pool = []
    for j in jobs:
        ov = overrides.get(j["job_id"], {})
        if _held(ov, today):
            continue
        if not (j["is_ready"] or j["started"] or "force" in ov):
            continue
        jj = dict(j)
        jj["_manual"] = sorted(k for k in ov if k != "hold" or _held(ov, today))
        jj["_warnings"] = []
        lvl = (ov.get("priority") or {}).get("level")
        if lvl in MANUAL_RANK:
            jj["_manual_rank"] = MANUAL_RANK[lvl]
        nb = parse_date((ov.get("assign") or {}).get("not_before"))
        if nb:
            jj["_not_before"] = nb
        pool.append(jj)
    pool.sort(key=_sort_key)
    meta = {j["job_id"]: j for j in pool}      # _manual / _warnings llegan a la salida
    state = {m["machine"]: {"cfg": m, "current": None, "last_color": None, "last_design": None,
                            "last_po": None, "queue": []} for m in active}
    machine_order = {m["machine"]: i for i, m in enumerate(active)}

    # 1) Reprogramados a mano: van a la cola de SU máquina, en su lugar.
    assigned = []
    for j in list(pool):
        a = (overrides.get(j["job_id"]) or {}).get("assign") or {}
        mname = a.get("machine")
        if not mname:
            continue
        if mname not in state:
            j["_warnings"].append("maquina_inactiva")
            continue
        if j["colors"] > int(state[mname]["cfg"].get("heads") or HEADS_MAX):
            j["_warnings"].append("colores_mayor_cabezas")
        assigned.append((mname, int(a.get("queue_pos") or 0), j))
        pool.remove(j)

    # 2) Lo que ya está en un tablero MAQUINA<n> es la cola de esa máquina (la
    # asignó una persona): se respeta en su orden de urgencia. Sólo la primera
    # posición pendiente de la orden queda fija; las demás pueden ir en
    # paralelo a otra máquina. La primera de la cola se toma como montada
    # (sin setup).
    fixed = set()
    for j in list(pool):
        mname = board_of.get(j["order_id"])
        if mname in state and j["order_id"] not in fixed:
            fixed.add(j["order_id"])
            j["_mounted"] = True
            state[mname]["queue"].append(j)
            pool.remove(j)
    for st in state.values():
        st["queue"].sort(key=_sort_key)
    for mname, pos, j in sorted(assigned, key=lambda x: (x[1] or 10**6)):
        q = state[mname]["queue"]
        q.insert(max(0, pos - 1) if pos else len(q), j)
    for j in pool:
        j["setup_left"] = j["colors"] * setup_hits_per_color
    for st in state.values():
        for i, j in enumerate(st["queue"]):
            j["setup_left"] = 0 if (i == 0 and j.get("_mounted")) else j["colors"] * setup_hits_per_color
    scheduled: Dict[str, dict] = {}

    def fits(m, j):
        return j["colors"] <= int(m["cfg"].get("heads") or HEADS_MAX)

    def eligible(j, d):
        return j.get("_not_before") is None or j["_not_before"] <= d

    def pick(mname, alto_in_shift, running, d):
        m = state[mname]
        for i, j in enumerate(m["queue"]):
            if eligible(j, d):
                return m["queue"].pop(i)
        cands = [j for j in pool if fits(m, j) and eligible(j, d)]
        if not cands:
            return None
        # Dedicación: si la máquina está dedicada a un cliente y ese cliente
        # tiene trabajo elegible, prioriza FUERTE (toma lo suyo aunque otro
        # cliente traiga algo más urgente); si no hay, toma los demás para no
        # quedar parada.
        if m["cfg"].get("dedicated"):
            pc = (m["cfg"].get("preferred_client") or "").strip().upper()
            mine = [j for j in cands if pc and pc in j["client"].upper()]
            if mine:
                cands = mine
        head = cands[0]
        # Empates (misma urgencia + mismo tipo de empaque): prefiere cliente de
        # la máquina, luego seguir con el MISMO customer PO (imprimir el PO
        # completo de corrido), luego el mismo design (mismo estilo = menos
        # cambios de arte), luego el mismo color; nunca brinca a alguien más
        # urgente ni de mayor prioridad de empaque.
        same = [j for j in cands if _sort_key(j)[:5] == _sort_key(head)[:5]]
        pref = (m["cfg"].get("preferred_client") or "").strip().upper()
        same.sort(key=lambda j: (0 if pref and pref in j["client"].upper() else 1,
                                 0 if j.get("customer_po") and j["customer_po"] == m.get("last_po") else 1,
                                 0 if j.get("design") and j["design"] == m.get("last_design") else 1,
                                 0 if j["color"] and j["color"] == m["last_color"] else 1))
        choice = same[0]
        # Mezcla de volumen: no un segundo Alto aquí si otra máquina que
        # corre no tiene ninguno — toma el siguiente no-Alto si existe.
        if choice["volume"] == "ALTO" and alto_in_shift.get(mname, 0) >= 1 and                 any(alto_in_shift.get(r, 0) == 0 for r in running if r != mname):
            alt = next((j for j in cands if j["volume"] != "ALTO"), None)
            if alt:
                choice = alt
        pool.remove(choice)
        return choice

    for d, shift, w0, w1, full, crews in _shift_windows(cfg, cal, start, cfg["horizon_weeks"]):
        if not pool and all(s["current"] is None and not s["queue"] for s in state.values()):
            break
        if crews <= 0:
            continue
        frac = (w1 - w0) / full                      # turno ya empezado = menos capacidad
        # Quién corre: primero las máquinas con trabajo, las más urgentes;
        # luego máquinas libres si queda gente y hay pool.
        busy = sorted([n for n, s in state.items() if s["current"] or s["queue"]],
                      key=lambda n: _sort_key(state[n]["current"] or state[n]["queue"][0]))
        idle = [n for n, s in state.items() if not s["current"] and not s["queue"]] if pool else []
        running = (busy + idle)[:crews]
        alto_in_shift: Dict[str, int] = {}
        cap = cap_shift * frac
        used = {n: 0.0 for n in running}
        open_m = set(running)
        # Tiempo real dentro del turno: siempre avanza la máquina que va más
        # atrás (la que se libera primero). Así los trabajos se reparten en
        # paralelo en vez de llenar una máquina y luego la siguiente.
        while open_m:
            mname = min(open_m, key=lambda n: (used[n], machine_order[n]))
            m = state[mname]
            if cap - used[mname] <= 1e-6:
                open_m.discard(mname)
                continue
            j = m["current"]
            if j is None:
                j = pick(mname, alto_in_shift, running, d)
                if j is None:
                    open_m.discard(mname)
                    continue
                m["current"] = j
            if j["volume"] == "ALTO" and not j.get("_counted_alto"):
                alto_in_shift[mname] = alto_in_shift.get(mname, 0) + 1
                j["_counted_alto"] = True
            f = rate_pph / _rate_of(j)          # costo en hits de referencia por hit real
            need = j["setup_left"] + j["remaining"] * f
            take = min(need, cap - used[mname])
            seg_start = w0 + (w1 - w0) * (used[mname] / cap)
            used[mname] += take
            seg_end = w0 + (w1 - w0) * (used[mname] / cap)
            setup_take = min(j["setup_left"], take)
            j["setup_left"] -= setup_take
            printed = (take - setup_take) / f   # hits reales impresos en ese tiempo
            j["remaining"] -= printed
            rec = scheduled.setdefault(j["job_id"], {"segments": [], "machines": []})
            rec["segments"].append({"machine": mname, "date": d.isoformat(), "shift": shift,
                                    "hits": round(printed), "setup_hits": round(setup_take),
                                    "start": seg_start.isoformat(), "end": seg_end.isoformat()})
            if mname not in rec["machines"]:
                rec["machines"].append(mname)
            if j["remaining"] <= 1e-6:
                rec["end"] = seg_end.isoformat()
                rec["end_date"] = seg_end.date().isoformat()
                m["current"] = None
                m["last_color"] = j["color"]
                m["last_design"] = j.get("design")
                m["last_po"] = j.get("customer_po")
                j.pop("_counted_alto", None)

    # Lo que quedó en máquina o en el pool sin terminar dentro del horizonte.
    leftovers = ([s["current"] for s in state.values() if s["current"]] + pool
                 + [j for s in state.values() for j in s["queue"]])
    for j in leftovers:
        rec = scheduled.setdefault(j["job_id"], {"segments": [], "machines": []})
        rec["remaining_after_horizon"] = round(j["remaining"])

    orig = {j["job_id"]: j for j in jobs}
    out = []
    for jid, plan in scheduled.items():
        rec = {**orig[jid], **plan}
        rec["manual"] = meta[jid].get("_manual", []) if jid in meta else []
        rec["warnings"] = meta[jid].get("_warnings", []) if jid in meta else []
        rec["start"] = rec["segments"][0]["start"] if rec["segments"] else None
        end_date = rec.get("end_date")
        tgt, cxl = rec.get("target_date"), rec.get("cancel_date")
        if rec.get("remaining_after_horizon"):
            rec["status"] = "FUERA_DE_HORIZONTE"
        elif not tgt:
            rec["status"] = "SIN_FECHA"
        elif tgt and end_date and end_date > tgt:
            rec["status"] = "EN_RIESGO"
        else:
            rec["status"] = "A_TIEMPO"
        if tgt and tgt < start.date().isoformat():
            rec["status"] = "VENCIDA"
        rec["meets_cancel"] = bool(end_date and cxl and end_date <= cxl)
        if rec["status"] in ("EN_RIESGO", "VENCIDA", "FUERA_DE_HORIZONTE"):
            base = parse_date(end_date) if end_date else None
            if base:
                rec["suggested_cancel_date"] = cal.plus_business_days(
                    base, cfg["buffer_business_days"]).isoformat()
        out.append(rec)
    return out


def board_for_order(order_jobs: List[dict]) -> Optional[str]:
    """Regla 2: el board de la orden = la máquina con el job más grande."""
    best = None
    for j in order_jobs:
        if not j.get("machines"):
            continue
        per = {}
        for s in j["segments"]:
            per[s["machine"]] = per.get(s["machine"], 0) + s["hits"]
        m = max(per, key=per.get)
        if best is None or j["hits"] > best[0]:
            best = (j["hits"], m)
    return best[1] if best else None


# ── Capacidad histórica ────────────────────────────────────────────────────
def measure_history(records: List[dict], cfg: dict, today: date, since: date) -> dict:
    """Lo que la planta de verdad imprime, según production_logs.

    Se mide por TURNO COMPLETO DE PLANTA (todas las máquinas del turno), no
    por máquina: en la realidad una cuadrilla reparte su trabajo en más de una
    máquina (≈13 máquinas con producción en un turno de día con 9 cuadrillas),
    así que "hits por máquina × cuadrillas" subestimaba a la mitad.

      por_cuadrilla[turno] = mediana(total del turno en días base) ÷ cuadrillas
                             configuradas para ese turno
    Sólo días base (lun–jue), sin el día de hoy (su turno va a medias).
    `weekly_avg`: producción real promedio de las semanas completas, con todo
    (tiempo extra incluido), como referencia.

    records: [{"date": date, "shift": "DIA"|"NOCHE", "machine": str, "qty": int}]
    """
    import statistics
    base_crews = {s["key"]: int(s.get("crews") or 0) for s in cfg["shifts"]}
    base_days = set(cfg["base_weekdays"])
    totals, machines, week_tot = {}, {}, {}
    for r in records:
        d = r["date"]
        if d >= today or d < since:
            continue
        ws = week_start(d)
        week_tot[ws] = week_tot.get(ws, 0) + r["qty"]
        if d.weekday() not in base_days or r["shift"] not in base_crews:
            continue
        k = (d, r["shift"])
        totals[k] = totals.get(k, 0) + r["qty"]
        machines.setdefault(k, set()).add(r.get("machine"))
    per_shift, per_crew = {}, {}
    for key, crews in base_crews.items():
        vals = [v for (d, s), v in totals.items() if s == key]
        if not vals or not crews:
            continue
        med = statistics.median(vals)
        per_crew[key] = round(med / crews)
        per_shift[key] = {"median_total": round(med), "shifts": len(vals), "crews": crews,
                          "per_crew": per_crew[key],
                          "machines_median": statistics.median(
                              [len(m) for (d, s), m in machines.items() if s == key])}
    full_weeks = [v for ws, v in week_tot.items() if ws + timedelta(days=6) < today]
    weekly = round(sum(full_weeks) / len(full_weeks)) if full_weeks else None
    if not per_crew:
        return {"value": None, "samples": 0, "median_hits": None, "per_crew": {}, "per_shift": {},
                "weekly_avg": weekly, "weeks": len(full_weeks)}
    crews_used = sum(base_crews[k] for k in per_crew)
    hits_real = sum(per_crew[k] * base_crews[k] for k in per_crew)
    return {"value": round(hits_real / (cfg["hits_per_shift"] * crews_used), 3),
            "samples": sum(p["shifts"] for p in per_shift.values()),
            "median_hits": round(hits_real / crews_used),
            "per_crew": per_crew, "per_shift": per_shift,
            "weekly_avg": weekly, "weeks": len(full_weeks)}


def measure_run_rates(records: List[dict], cfg: dict) -> dict:
    """Velocidad REAL por tamaño de corrida (hits por hora-máquina), incluido
    el tiempo que se pierde en setups y cambios.

    La regla fija (4,500 por turno) es un promedio de corridas medianas; una
    corrida larga rinde más (menos cambios) y una corta menos. Se mide así:
    production_logs se captura ~cada hora por máquina, así que cada registro
    cae en la hora-máquina más cercana. En cada hora-máquina, el tiempo se
    reparte entre las órdenes en proporción a sus hits; la velocidad de un
    tamaño = hits ÷ horas-máquina que ocupó. Las horas de arranque o cambio
    (con poca producción) quedan cargadas a la corrida: por eso las cortas
    salen más lentas, que es justo lo que pasa en piso.

    records: [{"machine", "dt" (datetime local), "order_id", "qty", "order_qty"}]
    """
    buckets = {}
    for r in records:
        b = (r["dt"] + timedelta(minutes=30)).replace(minute=0, second=0, microsecond=0)
        k = (r["machine"], b)
        c = buckets.setdefault(k, {})
        c[r["order_id"]] = c.get(r["order_id"], 0) + r["qty"]
    size = {r["order_id"]: volume_class(int(r.get("order_qty") or 0), cfg) for r in records}
    hits = {"BAJO": 0.0, "MEDIO": 0.0, "ALTO": 0.0}
    hours = {"BAJO": 0.0, "MEDIO": 0.0, "ALTO": 0.0}
    for c in buckets.values():
        tot = sum(c.values())
        if tot <= 0:
            continue
        for oid, h in c.items():
            v = size[oid]
            hits[v] += h
            hours[v] += h / tot
    rates = {v: round(hits[v] / hours[v]) for v in hits if hours[v] >= 20}   # ≥ 20 h para opinar
    all_h = sum(hours.values())
    return {"rates": rates, "global_rate": round(sum(hits.values()) / all_h) if all_h else None,
            "hours": {v: round(h) for v, h in hours.items()},
            "hits": {v: round(h) for v, h in hits.items()}}


def mix_rate(by_volume: Dict[str, float], rates: Dict[str, float], fallback: Optional[float]) -> Optional[float]:
    """Velocidad de una MEZCLA de corridas: horas = Σ hits_i / vel_i, así que
    vel = Σ hits ÷ Σ (hits_i / vel_i) (media armónica ponderada por hits)."""
    num = den = 0.0
    for v, h in (by_volume or {}).items():
        if h and rates.get(v):
            num += h
            den += h / rates[v]
    return (num / den) if den else fallback


# ── Proyección de capacidad ────────────────────────────────────────────────
def week_start(d: date) -> date:
    return d - timedelta(days=d.weekday())


def projection(jobs: List[dict], cfg: dict, cal: Calendar, today: date, efficiency: float,
               n_machines: int, run_rates: Optional[dict] = None):
    """run_rates: salida de measure_run_rates. Si viene, cada semana trae la
    capacidad HISTÓRICA: los mismos turnos-cuadrilla (cuadrillas, días,
    festivos, tiempo extra) × horas productivas por turno (hits_per_shift ÷
    rate_pph) × la velocidad real de la MEZCLA de corridas de esa semana
    (bajas, medias, altas). Semana con órdenes grandes = más capacidad."""
    weeks = int(cfg["horizon_weeks"])
    cap_crew_shift = cfg["hits_per_shift"] * efficiency
    shifts = [s["key"] for s in cfg["shifts"]]
    shift_hours = {s["key"]: float(s.get("hours") or 12) for s in cfg["shifts"]}
    w0 = week_start(today)
    rows = []
    for i in range(weeks):
        ws = w0 + timedelta(weeks=i)
        days = [ws + timedelta(days=k) for k in range(7)]
        capacity = 0.0
        base_shifts = {s: 0 for s in shifts}        # turnos-día base de la semana
        detail = []
        for d in days:
            if d < today:
                continue
            for s in shifts:
                c = cal.crews(d, s)
                full_h = shift_hours.get(s, 12.0)
                _, hrs = cal.window(d, s, "00:00", full_h)
                capacity += c * cap_crew_shift * (hrs / full_h)
                if cal.is_business_day(d):
                    base_shifts[s] += 1
                if c:
                    detail.append({"date": d.isoformat(), "shift": s, "crews": c})
        # Semana regular = todos sus días base son hábiles; corta = un festivo
        # (oficial o propio) se come uno o más. Se mide sobre la semana
        # completa, aunque ya hayan pasado días; days_left sí cuenta desde hoy.
        base_days = [d for d in days if d.weekday() in cal.base_weekdays]
        business = [d for d in base_days if cal.is_business_day(d)]
        rows.append({"week_start": ws.isoformat(), "iso_week": ws.isocalendar()[1],
                     "week_type": "REGULAR" if len(business) >= len(base_days) else "CORTA",
                     "business_days": len(business), "base_days": len(base_days),
                     "days_left": len([d for d in business if d >= today]),
                     "capacity": round(capacity), "base_shift_days": base_shifts,
                     "holidays": [{"date": d.isoformat(), "name": cal.holiday_name(d)}
                                  for d in days if cal.holiday_name(d)],
                     "shifts_detail": detail,
                     "demand": 0, "demand_ready": 0, "demand_not_ready": 0,
                     "by_client": {}, "by_volume": {"ALTO": 0, "MEDIO": 0, "BAJO": 0}, "jobs": []})
    overdue = {"demand": 0, "jobs": 0}
    no_date = {"demand": 0, "jobs": 0}
    horizon_end = w0 + timedelta(weeks=weeks)
    beyond = {"demand": 0, "jobs": 0}
    for j in jobs:
        t = parse_date(j.get("target_date"))
        if t is None:
            no_date["demand"] += j["remaining"]; no_date["jobs"] += 1
            continue
        late = t < today
        if late:
            overdue["demand"] += j["remaining"]; overdue["jobs"] += 1
            t = today                                     # lo atrasado pesa ya
        if t >= horizon_end:
            beyond["demand"] += j["remaining"]; beyond["jobs"] += 1
            continue
        r = rows[(week_start(t) - w0).days // 7]
        r["demand"] += j["remaining"]
        r["demand_ready" if (j["is_ready"] or j["started"]) else "demand_not_ready"] += j["remaining"]
        r["by_client"][j["client"] or "—"] = r["by_client"].get(j["client"] or "—", 0) + j["remaining"]
        r["by_volume"][j["volume"]] += j["remaining"]
        # Detalle para desplegar la semana en pantalla (una línea por job).
        r["jobs"].append({k: j.get(k) for k in (
            "job_id", "order_id", "order_number", "position", "client", "branding", "board", "kind",
            "sample_state", "volume", "quantity", "remaining", "cancel_date", "target_date", "ready",
            "is_ready", "started")} | {"overdue": late})

    cumulative = 0.0
    cumulative_real = 0.0
    day_crews = next((int(s["crews"]) for s in cfg["shifts"] if s["key"] == "DIA"), 0)
    for r in rows:
        r["delta"] = round(r["capacity"] - r["demand"])
        cumulative += r["capacity"] - r["demand"]
        r["cumulative_delta"] = round(cumulative)
        rates = (run_rates or {}).get("rates") or {}
        if rates:
            # Horas disponibles = turnos-cuadrilla × horas productivas por turno.
            # La demanda conocida gasta horas a la velocidad de SU mezcla; las
            # horas que sobran rinden al promedio histórico (se llenarán con
            # órdenes que aún no llegan, con la mezcla de siempre).
            crew_shifts = r["capacity"] / cap_crew_shift if cap_crew_shift else 0
            avail_h = crew_shifts * cfg["hits_per_shift"] / float(cfg["rate_pph"])
            glob = run_rates.get("global_rate") or 0
            need_h = sum(h / (rates.get(v) or glob) for v, h in r["by_volume"].items() if h and (rates.get(v) or glob))
            if need_h >= avail_h:
                cap_hist = avail_h * (mix_rate(r["by_volume"], rates, glob) or 0)
            else:
                cap_hist = r["demand"] + (avail_h - need_h) * glob
            r["capacity_real"] = round(cap_hist)
            r["hist_rate"] = round(cap_hist / avail_h) if avail_h else None
            r["delta_real"] = r["capacity_real"] - r["demand"]
            cumulative_real += r["delta_real"]
            r["cumulative_delta_real"] = round(cumulative_real)
        deficit = max(0.0, -cumulative)
        r["deficit"] = round(deficit)
        # Opción A: turnos extra con las cuadrillas de día actuales (vie/sáb/dom).
        per_ot_shift = max(1, day_crews) * cap_crew_shift
        r["overtime_shifts_needed"] = math.ceil(deficit / per_ot_shift) if deficit else 0
        r["overtime_max_shifts"] = 3 * len(shifts)          # vie, sáb, dom × turnos
        # Opción B: cuadrillas nuevas, por turno, limitadas por máquinas libres.
        hires = {}
        for s in cfg["shifts"]:
            shifts_in_week = r["base_shift_days"].get(s["key"], 0)
            free = max(0, n_machines - int(s["crews"] or 0))
            if shifts_in_week and deficit:
                need = math.ceil(deficit / (shifts_in_week * cap_crew_shift))
            else:
                need = 0
            hires[s["key"]] = {"crews_needed": need, "crews_possible": min(need, free),
                               "free_machines": free,
                               "people": min(need, free) * int(cfg["people_per_crew"])}
        r["hires"] = hires
    return {"weeks": rows, "overdue": overdue, "no_target": no_date, "beyond_horizon": beyond,
            "capacity_per_crew_shift": round(cap_crew_shift),
            "run_rates": run_rates if (run_rates or {}).get("rates") else None,
            "productive_hours": round(cfg["hits_per_shift"] / float(cfg["rate_pph"]), 2)}
