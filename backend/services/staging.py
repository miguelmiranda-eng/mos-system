"""SURTIDOS por locacionar: el material surtido sigue en el mapa hasta que entra a piso.

EL HUECO QUE LLENA
El pick descuenta piezas de la caja de origen (`_deduct_pick_boxes`) y ahí se
acababa el rastro: el material ya surtido —que todavía no entra a producción y
se guarda físicamente en los racks OM— desaparecía del WMS. Nadie podía decir
para qué orden estaba ni en qué ubicación.

EL MODELO: UN PICK TICKET = UN SURTIDO
Todo lo que se surte de un pick ticket (cualquier talla, en una o varias
pasadas) se junta en UN surtido, con el desglose por talla adentro. Cae en UNA
ubicación fija de tránsito ("SURTIDO POR LOCACIONAR", configurable; se da de
alta una sola vez) y desde ahí se decide: escanear la etiqueta del pick ticket
(o teclear la orden) y luego la ubicación OM, o mandarlo a piso.

HISTORIA: la primera versión (2026-10-05, commit bea2307) hacía una caja de
surtido por ticket × TALLA con etiqueta propia. En el almacén no sirvió: un
ticket de 5 tallas eran 5 etiquetas y 5 escaneos para locacionar. El usuario
pidió que la unidad sea el ticket completo y que se escanee la etiqueta que ya
imprimen. Una ronda de resurtido (<padre>-R1) es otro bulto físico y es su
propio surtido.

POR QUÉ UNA COLECCIÓN APARTE (`wms_staged_boxes`) Y NO `wms_boxes`
`wms_boxes` es la verdad del inventario DISPONIBLE: de ahí sale el surtido, la
reproyección de `wms_inventory`, conteos, conciliación, fantasmas, exportes.
Un surtido ya tiene dueño (la orden): si viviera en `wms_boxes`, cada uno de
esos flujos tendría que aprender a ignorarlo, y el primero que se olvide lo
vuelve a ofrecer para surtir o lo reporta como stock fantasma.

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

# Estados de un surtido.
TRANSIT = "transit"     # en la ubicación de tránsito (por locacionar)
STORED = "stored"       # guardado en una ubicación destino (OM…)
ISSUED = "issued"       # entregado a piso: ya no está en el mapa
LIVE = (TRANSIT, STORED)

DEFAULT_CFG = {
    "transit": ["SURTIDO POR LOCACIONAR"],
    "destinations": ["OM-A07..OM-A38", "OM-B07..OM-B38", "OM-C07..OM-C38"],
    # Órdenes en estos tableros ya no tienen material en el almacén: sus
    # surtidos vivos se cierran solos como entregados (respaldo del escaneo).
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
    """Da de alta la(s) ubicación(es) de tránsito configuradas si faltan —UNA
    vez, no una por ticket— igual que el módulo de retornos con RETORNO
    PRODUCCION (tipo 'transit'). Devuelve las creadas."""
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
    return sorted({_up(n) for n in names if n and is_destination(cfg, n)})


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


def _resupply_round(ticket_id) -> int | None:
    m = re.search(r"-R(\d+)$", str(ticket_id or ""))
    return int(m.group(1)) if m else None


# ── Altas y bajas desde el pick ──────────────────────────────────────────────
async def stage_pick(*, user, ticket_id, order_number, order_id, customer,
                     style, color, size, qty, origin_box_ids=None, origin_location=""):
    """Suma `qty` piezas de `size` al surtido del ticket. Un ticket tiene UN
    surtido vivo: si ya existe (en tránsito o guardado en OM) se le suman las
    piezas; si no, nace en la ubicación de tránsito."""
    qty = int(qty or 0)
    if qty <= 0 or not ticket_id:
        return None
    cfg = await get_cfg()
    transit = cfg["transit"][0]
    if transit not in _TRANSIT_OK:
        await ensure_transit_locations(cfg)
    size = _up(size)
    origin_box_ids = [b for b in (origin_box_ids or []) if b]
    origin = {"size": size, "location": _up(origin_location), "box_ids": origin_box_ids,
              "qty": qty, "at": _now()}
    doc = await db[COLL].find_one_and_update(
        {"ticket_id": ticket_id, "status": {"$in": list(LIVE)}},
        {"$inc": {"units": qty, "picked_units": qty, f"sizes.{size}": qty},
         "$push": {"origins": {"$each": [origin], "$slice": -500}},
         "$set": {"updated_at": _now()}},
        return_document=ReturnDocument.AFTER)
    created = False
    if not doc:
        doc = {
            "staged_id": await _next_staged_id(), "status": TRANSIT, "location": transit,
            "ticket_id": ticket_id, "order_number": str(order_number or ""),
            "order_id": order_id, "customer": customer or "",
            "style": _up(style), "color": _up(color), "sizes": {size: qty},
            "units": qty, "picked_units": qty, "origins": [origin],
            "resupply_round": _resupply_round(ticket_id),
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
    del surtido del ticket. Lo que no alcance se registra (ya se había
    entregado a piso)."""
    qty = int(qty or 0)
    if qty <= 0 or not ticket_id:
        return 0
    size = _up(size)
    b = await db[COLL].find_one({"ticket_id": ticket_id, "status": {"$in": list(LIVE)}})
    take = min(qty, int(((b or {}).get("sizes") or {}).get(size, 0) or 0))
    if take > 0:
        new_units = int(b["units"]) - take
        upd = {"units": new_units, "updated_at": _now(), f"sizes.{size}": int(b["sizes"][size]) - take}
        if new_units <= 0:
            upd["status"] = "voided"
        await db[COLL].update_one({"_id": b["_id"], "units": b["units"]}, {
            "$set": upd,
            "$push": {"history": {"at": _now(), "action": "unpicked", "size": size, "qty": take,
                                  "by": (user or {}).get("name", ""), "reason": reason}}})
    await _log(user, "staged_unpick", {
        "ticket_id": ticket_id, "size": size, "qty": qty,
        "staged_id": (b or {}).get("staged_id"), "not_found_units": qty - take, "reason": reason,
    })
    return take


# ── Operación: guardar en OM / entregar a piso ───────────────────────────────
class StagingError(Exception):
    def __init__(self, status: int, detail: str):
        super().__init__(detail)
        self.status = status
        self.detail = detail


async def find_live(code: str):
    """Surtido vivo por su id interno o por el ticket (lo que trae la etiqueta
    del pick ticket; el escáner lo manda en mayúsculas)."""
    code = (code or "").strip()
    if not code:
        return None
    return await db[COLL].find_one(
        {"status": {"$in": list(LIVE)},
         "$or": [{"staged_id": code.upper()},
                 {"ticket_id": {"$regex": f"^{re.escape(code)}$", "$options": "i"}}]},
        {"_id": 0})


async def resolve(code: str) -> list:
    """Lo que el operador escaneó o tecleó: etiqueta del pick ticket, id del
    surtido o número de orden. Devuelve los surtidos vivos que coinciden (una
    orden con varios estilos/colores puede traer varios)."""
    b = await find_live(code)
    if b:
        return [b]
    code = (code or "").strip()
    if not code:
        return []
    return await db[COLL].find(
        {"status": {"$in": list(LIVE)}, "order_number": code},
        {"_id": 0, "origins": 0, "history": 0}).sort("ticket_id", 1).to_list(50)


async def store(*, user, staged_ids: list[str], location: str) -> dict:
    """Surtido(s) → ubicación destino (OM…) o de regreso a tránsito."""
    cfg = await get_cfg()
    loc = _up(location)
    if not loc:
        raise StagingError(400, "Escanea la ubicación destino")
    if not (is_destination(cfg, loc) or is_transit(cfg, loc)):
        raise StagingError(400, f"{loc} no es una ubicación de surtido. Destinos válidos: "
                                + ", ".join(cfg["destinations"]))
    if not await db.wms_locations.find_one({"name": {"$regex": f"^{re.escape(loc)}$", "$options": "i"}}):
        raise StagingError(404, f"La ubicación {loc} no existe en el WMS")
    ids = [str(s).strip() for s in staged_ids if str(s or "").strip()]
    if not ids:
        raise StagingError(400, "Escanea al menos un surtido (pick ticket u orden)")
    moved, errors = [], []
    for code in ids:
        b = await find_live(code)
        if not b:
            errors.append(f"{code}: no existe o ya se entregó a piso")
            continue
        new_status = TRANSIT if is_transit(cfg, loc) else STORED
        await db[COLL].update_one({"staged_id": b["staged_id"]}, {
            "$set": {"location": loc, "status": new_status, "updated_at": _now(),
                     "stored_at": _now(), "stored_by_name": (user or {}).get("name", "")},
            "$push": {"history": {"at": _now(), "action": "stored", "from": b["location"],
                                  "location": loc, "by": (user or {}).get("name", "")}}})
        moved.append({"staged_id": b["staged_id"], "ticket_id": b.get("ticket_id"), "from": b["location"],
                      "to": loc, "order_number": b.get("order_number"), "units": b.get("units")})
    if moved:
        await _log(user, "staged_store", {"location": loc, "boxes": moved,
                                          "qty": sum(int(m["units"] or 0) for m in moved)})
    return {"moved": moved, "errors": errors}


async def issue(*, user, staged_ids: list[str], reason: str = "scan") -> dict:
    """Entregar a piso: el surtido sale del mapa (status issued) con rastro."""
    ids = [str(s).strip() for s in staged_ids if str(s or "").strip()]
    if not ids:
        raise StagingError(400, "Escanea al menos un surtido (pick ticket u orden)")
    issued, errors = [], []
    for code in ids:
        b = await find_live(code)
        if not b:
            errors.append(f"{code}: no existe o ya se entregó a piso")
            continue
        await db[COLL].update_one({"staged_id": b["staged_id"]}, {
            "$set": {"status": ISSUED, "issued_at": _now(), "issued_from": b["location"],
                     "issued_by_name": (user or {}).get("name", ""), "issue_reason": reason,
                     "updated_at": _now()},
            "$push": {"history": {"at": _now(), "action": "issued", "from": b["location"],
                                  "by": (user or {}).get("name", ""), "reason": reason}}})
        issued.append({"staged_id": b["staged_id"], "ticket_id": b.get("ticket_id"), "from": b["location"],
                       "order_number": b.get("order_number"), "units": b.get("units")})
    if issued:
        await _log(user, "staged_issue", {"boxes": issued, "reason": reason,
                                          "qty": sum(int(i["units"] or 0) for i in issued)})
    return {"issued": issued, "errors": errors}


async def auto_issue_closed_orders(user=None) -> int:
    """Respaldo del escaneo: si la orden ya llegó a un tablero de cierre
    (FINAL BILL, COMPLETOS…) y su surtido seguía en el mapa, el material ya no
    está — se cierra como entregado con motivo 'auto'. Órdenes canceladas NO:
    ese material sigue físicamente aquí y alguien tiene que regresarlo."""
    cfg = await get_cfg()
    boards = cfg.get("auto_issue_boards") or []
    if not boards:
        return 0
    orders = [o for o in await db[COLL].distinct("order_number", {"status": {"$in": list(LIVE)}}) if o]
    if not orders:
        return 0
    closed = await db.orders.distinct("order_number", {"order_number": {"$in": orders}, "board": {"$in": boards}})
    if not closed:
        return 0
    ids = await db[COLL].distinct("staged_id", {"order_number": {"$in": closed}, "status": {"$in": list(LIVE)}})
    if ids:
        await issue(user=user or {"user_id": "system", "name": "system"}, staged_ids=ids, reason="auto")
    return len(ids)


# ── Arranque: índices, tránsito y migración de la primera versión ────────────
async def migrate_per_size_boxes() -> dict:
    """Migración única de la primera versión (una caja por ticket × talla) al
    modelo actual (un surtido por ticket con `sizes`). Junta las cajas vivas de
    cada ticket en un solo surtido: conserva la ubicación si todas estaban en
    la misma ubicación destino; si no, va al tránsito vigente. Idempotente:
    solo toca documentos sin `sizes`."""
    cfg = await get_cfg()
    viejos = await db[COLL].find({"sizes": {"$exists": False}}).to_list(10000)
    if not viejos:
        return {"merged": 0, "old_docs": 0}
    por_ticket = {}
    for d in viejos:
        por_ticket.setdefault(d.get("ticket_id"), []).append(d)
    merged = 0
    for tid, docs in por_ticket.items():
        vivos = [d for d in docs if d.get("status") in LIVE and int(d.get("units") or 0) > 0]
        if vivos:
            sizes = {}
            for d in vivos:
                sz = _up(d.get("size"))
                sizes[sz] = sizes.get(sz, 0) + int(d["units"])
            locs = {d.get("location") for d in vivos}
            loc = locs.pop() if len(locs) == 1 else ""
            dest = bool(loc) and is_destination(cfg, loc)
            base = vivos[0]
            await db[COLL].insert_one({
                "staged_id": await _next_staged_id(), "ticket_id": tid,
                "status": STORED if dest else TRANSIT, "location": loc if dest else cfg["transit"][0],
                "order_number": base.get("order_number", ""), "order_id": base.get("order_id"),
                "customer": base.get("customer", ""), "style": base.get("style", ""),
                "color": base.get("color", ""), "sizes": sizes, "units": sum(sizes.values()),
                "picked_units": sum(sizes.values()),
                "origins": [o for d in vivos for o in (d.get("origins") or [])][-500:],
                "resupply_round": _resupply_round(tid),
                "created_at": min(d.get("created_at") or _now() for d in vivos), "updated_at": _now(),
                "history": [{"at": _now(), "action": "migrated",
                             "from_ids": [d["staged_id"] for d in vivos]}],
            })
            merged += 1
        await db[COLL].update_many(
            {"_id": {"$in": [d["_id"] for d in docs]}},
            {"$set": {"status": "merged", "sizes": {}, "merged_at": _now()}})
    await _log(None, "staged_migrated", {"tickets": len(por_ticket), "merged": merged, "old_docs": len(viejos)})
    return {"merged": merged, "old_docs": len(viejos)}


async def retire_old_transit(name: str = "TRANSITO SURTIDO") -> bool:
    """La primera versión creó la ubicación TRANSITO SURTIDO. Si ya no es la de
    tránsito configurada, la creó el sistema y está vacía, se elimina."""
    cfg = await get_cfg()
    if name in cfg["transit"]:
        return False
    loc = await db.wms_locations.find_one({"name": name, "created_by": "system:staging"})
    if not loc:
        return False
    if (await db.wms_boxes.count_documents({"location": name, "units": {"$gt": 0}})
            or await db[COLL].count_documents({"location": name, "status": {"$in": list(LIVE)}})):
        return False
    await db.wms_locations.delete_one({"_id": loc["_id"]})
    await _log(None, "staged_old_transit_removed", {"location": name})
    return True


async def ensure_indexes():
    c = db[COLL]
    await c.create_index("staged_id", unique=True)
    await c.create_index([("ticket_id", 1), ("status", 1)])
    await c.create_index([("order_number", 1), ("status", 1)])
    await c.create_index([("location", 1), ("status", 1)])
    # Al arrancar: la ubicación de tránsito existe (una sola), lo de la primera
    # versión se migra y la ubicación vieja (vacía) se retira.
    await ensure_transit_locations()
    await migrate_per_size_boxes()
    await retire_old_transit()
