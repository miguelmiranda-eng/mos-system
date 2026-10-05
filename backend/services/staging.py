"""Cajas de SURTIDO: el material surtido sigue en el mapa hasta que entra a piso.

EL HUECO QUE LLENA
El pick descuenta piezas de la caja de origen (`_deduct_pick_boxes`) y ahí se
acababa el rastro: el material ya surtido —que todavía no entra a producción y
se guarda físicamente en los racks OM— desaparecía del WMS. Nadie podía decir
para qué orden estaba ni en qué ubicación.

EL MODELO
Cada descuento de pick de una orden genera (o engorda) una CAJA DE SURTIDO
por ticket × talla, en una ubicación de TRÁNSITO. De ahí:
  · se escanea hacia una ubicación DESTINO (OM-A07…, configurable), o
  · se escanea "a piso" (entregada a producción) y sale del mapa con rastro.

POR QUÉ UNA COLECCIÓN APARTE (`wms_staged_boxes`) Y NO `wms_boxes`
`wms_boxes` es la verdad del inventario DISPONIBLE: de ahí sale el surtido, la
reproyección de `wms_inventory`, conteos, conciliación, fantasmas, exportes.
Una caja de surtido ya tiene dueño (la orden): si viviera en `wms_boxes`, cada
uno de esos flujos tendría que aprender a ignorarla, y el primero que se
olvide la vuelve a ofrecer para surtir o la reporta como stock fantasma. Aparte
es imposible que se cuele en el disponible.

LO QUE NO CAMBIA
El movimiento `pick_deduction` sigue igual: qty_embarcada y el packing de
exportación dependen de él. Lo de aquí se suma, no reemplaza.

Las ubicaciones de tránsito y destino viven en
config_options.wms_staging_locations y se editan desde Configuración.
"""
from __future__ import annotations

import re
import time

from pymongo import ReturnDocument

from deps import db

COLL = "wms_staged_boxes"
CONFIG_ID = "wms_staging_locations"

# Estados de una caja de surtido.
TRANSIT = "transit"     # recién surtida, en la ubicación de tránsito
STORED = "stored"       # guardada en una ubicación destino (OM…)
ISSUED = "issued"       # entregada a piso: ya no está en el mapa
LIVE = (TRANSIT, STORED)

DEFAULT_CFG = {
    "transit": ["TRANSITO SURTIDO"],
    "destinations": ["OM-A07..OM-A38", "OM-B07..OM-B38", "OM-C07..OM-C38"],
    # Órdenes en estos tableros ya no tienen material en el almacén: sus cajas
    # vivas se cierran solas como entregadas (respaldo del escaneo).
    "auto_issue_boards": ["FINAL BILL", "COMPLETOS"],
}

_CACHE = {"cfg": None, "at": 0.0}
_TTL = 60.0


def _now():
    from datetime import datetime, timezone
    return datetime.now(timezone.utc).isoformat()


def _up(v) -> str:
    return (v or "").strip().upper()


# ── Reglas de ubicación destino ──────────────────────────────────────────────
# Cada regla es una de:
#   "OM-A07..OM-A38"  rango: mismo prefijo, sufijo numérico, extremos incluidos
#   "OM-B*"           prefijo
#   "OM-D01"          nombre exacto
_RANGE = re.compile(r"^(.*?)(\d+)\s*\.\.\s*(.*?)(\d+)$")


def parse_rule(rule: str):
    r = _up(rule)
    if not r:
        return None
    m = _RANGE.match(r)
    if m:
        p1, a, p2, b = m.groups()
        if p1 != p2:
            raise ValueError(f"Rango '{rule}': los dos extremos deben tener el mismo prefijo")
        lo, hi = sorted((int(a), int(b)))
        return {"kind": "range", "prefix": p1, "lo": lo, "hi": hi, "width": len(a), "raw": r}
    if r.endswith("*"):
        return {"kind": "prefix", "prefix": r[:-1], "raw": r}
    if "*" in r or ".." in r:
        raise ValueError(f"Regla inválida '{rule}': usa A..B, PREFIJO* o un nombre exacto")
    return {"kind": "exact", "name": r, "raw": r}


def rule_matches(rule: dict, name: str) -> bool:
    n = _up(name)
    if rule["kind"] == "exact":
        return n == rule["name"]
    if rule["kind"] == "prefix":
        return bool(rule["prefix"]) and n.startswith(rule["prefix"])
    if not n.startswith(rule["prefix"]):
        return False
    tail = n[len(rule["prefix"]):]
    return tail.isdigit() and rule["lo"] <= int(tail) <= rule["hi"]


def normalize_cfg(raw: dict) -> dict:
    """Valida y normaliza una config. Lanza ValueError con el motivo."""
    transit = []
    for t in raw.get("transit") or []:
        t = _up(t)
        if t and t not in transit:
            transit.append(t)
    if not transit:
        raise ValueError("Debe haber al menos una ubicación de tránsito")
    dest = []
    for d in raw.get("destinations") or []:
        rule = parse_rule(d)
        if rule and rule["raw"] not in dest:
            dest.append(rule["raw"])
    if not dest:
        raise ValueError("Debe haber al menos una ubicación destino")
    for t in transit:
        if any(rule_matches(parse_rule(d), t) for d in dest):
            raise ValueError(f"'{t}' no puede ser tránsito y destino a la vez")
    boards = []
    for b in raw.get("auto_issue_boards") or []:
        b = _up(b)
        if b and b not in boards:
            boards.append(b)
    return {"transit": transit, "destinations": dest, "auto_issue_boards": boards}


async def get_cfg(force: bool = False) -> dict:
    c = _CACHE
    if not force and c["cfg"] is not None and time.monotonic() - c["at"] < _TTL:
        return c["cfg"]
    doc = await db.config_options.find_one({"config_id": CONFIG_ID}, {"_id": 0}) or {}
    try:
        cfg = normalize_cfg({**DEFAULT_CFG, **{k: doc[k] for k in DEFAULT_CFG if k in doc}})
    except ValueError:
        cfg = normalize_cfg(DEFAULT_CFG)
    c.update({"cfg": cfg, "at": time.monotonic()})
    return cfg


async def save_cfg(raw: dict, user: dict) -> dict:
    cfg = normalize_cfg(raw)
    await db.config_options.update_one(
        {"config_id": CONFIG_ID},
        {"$set": {**cfg, "updated_at": _now(), "updated_by": user.get("email")}},
        upsert=True)
    _CACHE["cfg"] = None
    cfg = await get_cfg(force=True)
    await ensure_transit_locations(cfg)
    return cfg


# Nombres de tránsito ya confirmados en wms_locations en este proceso: evita
# una consulta por cada pick.
_TRANSIT_OK: set = set()


async def ensure_transit_locations(cfg: dict | None = None) -> list[str]:
    """Da de alta las ubicaciones de tránsito que falten, igual que el módulo
    de retornos hace con RETORNO PRODUCCION (tipo 'transit'). Así existen para
    el listado de Ubicaciones, para imprimir su etiqueta y para escanearlas,
    aunque alguien cambie el nombre en Configuración. Devuelve las creadas."""
    cfg = cfg or await get_cfg()
    created = []
    for name in cfg["transit"]:
        if name in _TRANSIT_OK:
            continue
        exists = await db.wms_locations.find_one(
            {"name": {"$regex": f"^{re.escape(name)}$", "$options": "i"}}, {"_id": 1})
        if not exists:
            from routers.wms import gen_id
            await db.wms_locations.insert_one({
                "location_id": gen_id("loc"), "name": name, "zone": "SURTIDO",
                "type": "transit", "active": True, "created_at": _now(),
                "created_by": "system:staging",
            })
            created.append(name)
        _TRANSIT_OK.add(name)
    return created


def is_destination(cfg: dict, name: str) -> bool:
    return any(rule_matches(parse_rule(d), name) for d in cfg["destinations"])


def is_transit(cfg: dict, name: str) -> bool:
    return _up(name) in cfg["transit"]


async def destination_locations(cfg: dict) -> list[str]:
    """Ubicaciones dadas de alta en wms_locations que caen en las reglas destino."""
    names = await db.wms_locations.distinct("name", {"active": {"$ne": False}})
    out = sorted({_up(n) for n in names if n and is_destination(cfg, n)})
    return out


# ── Identificador ────────────────────────────────────────────────────────────
async def _next_staged_id() -> str:
    doc = await db.counters.find_one_and_update(
        {"_id": "wms_staged_seq"}, {"$inc": {"seq": 1}},
        upsert=True, return_document=ReturnDocument.AFTER)
    return f"SRT-{int(doc['seq']):06d}"


async def _log(user, movement_type, details):
    # Import tardío: routers.wms importa este módulo.
    from routers.wms import log_movement
    await log_movement(user or {"user_id": "system", "name": "system"}, movement_type, details)


# ── Altas y bajas desde el pick ──────────────────────────────────────────────
async def stage_pick(*, user, ticket_id, order_number, order_id, customer,
                     style, color, size, qty, origin_box_ids=None, origin_location=""):
    """Suma `qty` piezas surtidas a la caja de surtido de (ticket, talla) que
    sigue en tránsito; si no hay (o ya se guardó en OM), abre una nueva.

    Una sola caja por talla mientras esté en tránsito: el picker puede surtir
    la talla M de tres cajas de origen y físicamente es UN bulto para la orden.
    Si ese bulto ya se guardó en OM y luego se surte más M, eso es otro bulto
    físico y merece su propia etiqueta."""
    qty = int(qty or 0)
    if qty <= 0 or not ticket_id:
        return None
    cfg = await get_cfg()
    transit = cfg["transit"][0]
    if transit not in _TRANSIT_OK:
        await ensure_transit_locations(cfg)
    size = _up(size)
    origin_box_ids = [b for b in (origin_box_ids or []) if b]
    origin = {"location": _up(origin_location), "box_ids": origin_box_ids, "qty": qty, "at": _now()}
    doc = await db[COLL].find_one_and_update(
        {"ticket_id": ticket_id, "size": size, "status": TRANSIT},
        {"$inc": {"units": qty, "picked_units": qty},
         "$push": {"origins": {"$each": [origin], "$slice": -200}},
         "$set": {"updated_at": _now()}},
        sort=[("created_at", -1)], return_document=ReturnDocument.AFTER)
    created = False
    if not doc:
        staged_id = await _next_staged_id()
        doc = {
            "staged_id": staged_id, "status": TRANSIT, "location": transit,
            "ticket_id": ticket_id, "order_number": str(order_number or ""),
            "order_id": order_id, "customer": customer or "",
            "style": _up(style), "color": _up(color), "size": size,
            "units": qty, "picked_units": qty, "origins": [origin],
            "created_at": _now(), "updated_at": _now(),
            "created_by": (user or {}).get("user_id"),
            "created_by_name": (user or {}).get("name", ""),
            "history": [{"at": _now(), "action": "picked", "location": transit,
                         "by": (user or {}).get("name", ""), "qty": qty}],
        }
        await db[COLL].insert_one(dict(doc))
        created = True
    await _log(user, "staged_pick", {
        "staged_id": doc["staged_id"], "ticket_id": ticket_id, "order_number": str(order_number or ""),
        "style": _up(style), "color": _up(color), "size": size, "qty": qty,
        "location": doc.get("location"), "origin_location": _up(origin_location),
        "origin_box_ids": origin_box_ids, "created": created,
    })
    return doc["staged_id"]


async def unstage_pick(*, user, ticket_id, size, qty, reason="pick_correction"):
    """El picker corrigió a la baja: esas piezas vuelven al rack, así que salen
    de las cajas de surtido de ese ticket/talla. Primero de lo que sigue en
    tránsito (lo más reciente), luego de lo guardado. Lo que no alcance se
    registra — significa que ya se había entregado a piso."""
    remaining = int(qty or 0)
    if remaining <= 0 or not ticket_id:
        return 0
    size = _up(size)
    boxes = await db[COLL].find(
        {"ticket_id": ticket_id, "size": size, "status": {"$in": list(LIVE)}, "units": {"$gt": 0}}
    ).sort([("status", -1), ("created_at", -1)]).to_list(100)   # 'transit' > 'stored'
    touched = []
    for b in boxes:
        if remaining <= 0:
            break
        take = min(int(b["units"]), remaining)
        new_units = int(b["units"]) - take
        upd = {"units": new_units, "updated_at": _now()}
        if new_units == 0:
            upd["status"] = "voided"
        await db[COLL].update_one({"_id": b["_id"], "units": b["units"]}, {
            "$set": upd,
            "$push": {"history": {"at": _now(), "action": "unpicked", "qty": take,
                                  "by": (user or {}).get("name", ""), "reason": reason}}})
        touched.append({"staged_id": b["staged_id"], "qty": take})
        remaining -= take
    await _log(user, "staged_unpick", {
        "ticket_id": ticket_id, "size": size, "qty": int(qty), "boxes": touched,
        "not_found_units": remaining, "reason": reason,
    })
    return int(qty) - remaining


# ── Operación: guardar en OM / entregar a piso ───────────────────────────────
class StagingError(Exception):
    def __init__(self, status: int, detail: str):
        super().__init__(detail)
        self.status = status
        self.detail = detail


async def find_live(code: str):
    code = _up(code)
    return await db[COLL].find_one({"staged_id": code, "status": {"$in": list(LIVE)}}, {"_id": 0})


async def store(*, user, staged_ids: list[str], location: str) -> dict:
    """Escanear caja(s) de surtido → escanear ubicación destino."""
    cfg = await get_cfg()
    loc = _up(location)
    if not loc:
        raise StagingError(400, "Escanea la ubicación destino")
    if not (is_destination(cfg, loc) or is_transit(cfg, loc)):
        raise StagingError(400, f"{loc} no es una ubicación de surtido. Destinos válidos: "
                                + ", ".join(cfg["destinations"]))
    if not await db.wms_locations.find_one({"name": {"$regex": f"^{re.escape(loc)}$", "$options": "i"}}):
        raise StagingError(404, f"La ubicación {loc} no existe en el WMS")
    ids = [_up(s) for s in staged_ids if _up(s)]
    if not ids:
        raise StagingError(400, "Escanea al menos una caja de surtido")
    moved, errors = [], []
    for sid in ids:
        b = await find_live(sid)
        if not b:
            errors.append(f"{sid}: no existe o ya se entregó a piso")
            continue
        new_status = TRANSIT if is_transit(cfg, loc) else STORED
        await db[COLL].update_one({"staged_id": sid}, {
            "$set": {"location": loc, "status": new_status, "updated_at": _now(),
                     "stored_at": _now(), "stored_by_name": (user or {}).get("name", "")},
            "$push": {"history": {"at": _now(), "action": "stored", "from": b["location"],
                                  "location": loc, "by": (user or {}).get("name", "")}}})
        moved.append({"staged_id": sid, "from": b["location"], "to": loc,
                      "order_number": b.get("order_number"), "units": b.get("units")})
    if moved:
        await _log(user, "staged_store", {"location": loc, "boxes": moved,
                                          "qty": sum(int(m["units"] or 0) for m in moved)})
    return {"moved": moved, "errors": errors}


async def issue(*, user, staged_ids: list[str], reason: str = "scan") -> dict:
    """Entregar a piso: la caja sale del mapa (status issued) con rastro."""
    ids = [_up(s) for s in staged_ids if _up(s)]
    if not ids:
        raise StagingError(400, "Escanea al menos una caja de surtido")
    issued, errors = [], []
    for sid in ids:
        b = await find_live(sid)
        if not b:
            errors.append(f"{sid}: no existe o ya se entregó a piso")
            continue
        await db[COLL].update_one({"staged_id": sid}, {
            "$set": {"status": ISSUED, "issued_at": _now(), "issued_from": b["location"],
                     "issued_by_name": (user or {}).get("name", ""), "issue_reason": reason,
                     "updated_at": _now()},
            "$push": {"history": {"at": _now(), "action": "issued", "from": b["location"],
                                  "by": (user or {}).get("name", ""), "reason": reason}}})
        issued.append({"staged_id": sid, "from": b["location"],
                       "order_number": b.get("order_number"), "units": b.get("units")})
    if issued:
        await _log(user, "staged_issue", {"boxes": issued, "reason": reason,
                                          "qty": sum(int(i["units"] or 0) for i in issued)})
    return {"issued": issued, "errors": errors}


async def auto_issue_closed_orders(user=None) -> int:
    """Respaldo del escaneo: si la orden ya llegó a un tablero de cierre
    (FINAL BILL, COMPLETOS…) y su caja seguía en el mapa, el material ya no
    está — se cierra como entregada con motivo 'auto'. Órdenes canceladas NO:
    ese material sigue físicamente aquí y alguien tiene que regresarlo."""
    cfg = await get_cfg()
    boards = cfg.get("auto_issue_boards") or []
    if not boards:
        return 0
    orders = await db[COLL].distinct("order_number", {"status": {"$in": list(LIVE)}})
    orders = [o for o in orders if o]
    if not orders:
        return 0
    closed = await db.orders.distinct("order_number", {
        "order_number": {"$in": orders},
        "board": {"$in": boards}})
    if not closed:
        return 0
    ids = await db[COLL].distinct("staged_id", {"order_number": {"$in": closed},
                                                "status": {"$in": list(LIVE)}})
    if ids:
        await issue(user=user or {"user_id": "system", "name": "system"}, staged_ids=ids, reason="auto")
    return len(ids)


async def ensure_indexes():
    c = db[COLL]
    await c.create_index("staged_id", unique=True)
    await c.create_index([("ticket_id", 1), ("size", 1), ("status", 1)])
    await c.create_index([("order_number", 1), ("status", 1)])
    await c.create_index([("location", 1), ("status", 1)])
    # Al arrancar el servidor la ubicación de tránsito ya queda dada de alta.
    await ensure_transit_locations()
