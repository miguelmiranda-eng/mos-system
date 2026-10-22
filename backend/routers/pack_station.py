"""Estación de empaque (un iPad por máquina) — captura CAJA POR CAJA.

Fase 1 de la captura de empaque. El empacador registra cada caja que cierra
(tallas y piezas, dimensiones, peso) dentro del PALLET activo; el sistema
audita contra lo que PIDE LA ORDEN por talla (orders.sizes, de Printavo):
faltan / sobran en vivo. Es la misma información que hoy se llena a mano en
el Packing List de Herramientas (/packing) y en el DPL de Google; la Fase 2
genera esos documentos desde aquí.

Cómo se arma la caja depende de orders.packing_type:
  BulkPack   una talla por caja (talla + piezas).
  Prepack    N packs; la proporción por pack (p. ej. S1 M2 L3 XL3 2X1) la
             captura empaque al iniciar la orden (manual).
  PickPack / sin tipo   piezas por talla dentro de la caja.
Dimensiones: de un catálogo de cajas que se da de alta a mano (o medida
libre). Peso: manual.

Qué órdenes ve la estación de una máquina: la que corre ahora (Estado de
máquinas en vivo) y las que se imprimieron en esa máquina y siguen en empaque
(la orden ya NO se queda en el tablero de la máquina al terminar de imprimir).

Colecciones:
  pack_boxes        una caja: order_id, machine, packer, sizes{talla:n}, total,
                    dims{l,w,h}, box_size_id, weight, pallet_no, voided.
  pack_orders       por orden: prepack_ratio, pallets[{no, closed, dims,
                    weight}], active_pallet, finish{dañadas, extra, muestras}.
  pack_box_sizes    catálogo de cajas {box_size_id, name, l, w, h, active}.

La primera caja de una orden en NECESITA EMPACAR la pasa a EN PROCESO DE
EMPAQUE (por update_order: bitácora y automatizaciones). Mandar a QC sigue
siendo una decisión de una persona en el módulo Empaque.

Escriben el rol `empaque` + admin/supersu (routers/empaque.WRITE_ROLES).

Endpoints (prefijo /api/pack-station):
  GET    /machines
  GET    /station/{machine}                 órdenes de la estación
  GET    /order/{order_id}                  orden + auditoría + cajas + pallets
  PUT    /order/{order_id}/ratio            {ratio:{talla:n}} (Prepack)
  POST   /order/{order_id}/boxes            {machine, packer, sizes|packs, box_size_id|dims, weight, count}
  DELETE /boxes/{box_id}                    anula una caja (deshacer)
  POST   /order/{order_id}/pallet/close     {dims, weight} cierra el activo y abre el siguiente
  POST   /order/{order_id}/pallet/select    {no} cambia el pallet activo (a uno abierto)
  PUT    /order/{order_id}/finish           {damaged_print, damaged_garment, extra, samples}
  GET/POST /box-sizes, DELETE /box-sizes/{id}
"""
import re
import uuid
from datetime import datetime, timezone, timedelta

from fastapi import APIRouter, HTTPException, Request

from deps import db, require_auth, user_roles, get_machines, OrderUpdate, log_activity
from routers.empaque import WRITE_ROLES, NEEDS, IN_PROCESS
from services import dpl_sync as dpl
from services import order_modules as om

router = APIRouter(prefix="/api/pack-station")

SIZE_ORDER = ["XXS", "XS", "S", "M", "L", "XL", "2X", "3X", "4X", "5X", "6X"]
PACKING_STATUSES = {NEEDS, IN_PROCESS}
RECENT_DAYS = 21          # ventana de impresión para "órdenes de esta máquina"
MAX_COUNT = 200           # cajas iguales por captura
ORDER_PROJ = {"_id": 0, "order_id": 1, "order_number": 1, "client": 1, "branding": 1, "quantity": 1,
              "sizes": 1, "packing_type": 1, "production_status": 1, "customer_po": 1, "design_#": 1,
              "style": 1, "color": 1, "cancel_date": 1, "board": 1}


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _size_key(s: str):
    s = str(s).upper()
    return (SIZE_ORDER.index(s) if s in SIZE_ORDER else len(SIZE_ORDER), s)


def _ordered(o: dict) -> dict:
    """Pedido por talla, en orden de tallas. Sin desglose: una sola 'UNI'."""
    sz = {str(k).upper(): int(v or 0) for k, v in (o.get("sizes") or {}).items() if int(v or 0) > 0}
    if not sz and int(o.get("quantity") or 0):
        sz = {"UNI": int(o["quantity"])}
    return dict(sorted(sz.items(), key=lambda kv: _size_key(kv[0])))


def _pack_kind(o: dict) -> str:
    t = re.sub(r"[^a-z]", "", str(o.get("packing_type") or "").lower())
    return {"bulkpack": "bulk", "prepack": "prepack"}.get(t, "pick")


def _num(v, field, lo=0.0, hi=100000.0, required=False):
    if v in (None, ""):
        if required:
            raise HTTPException(400, f"Falta {field}")
        return None
    try:
        x = float(v)
    except (TypeError, ValueError):
        raise HTTPException(400, f"{field} no es un número")
    if not (lo <= x <= hi):
        raise HTTPException(400, f"{field} fuera de rango")
    return x


def _dims(d) -> dict | None:
    if not d:
        return None
    out = {k: _num((d or {}).get(k), f"dimensión {k.upper()}", 0.1, 500, required=True) for k in ("l", "w", "h")}
    return out


async def _can_write(request: Request) -> dict:
    user = await require_auth(request)
    if not (user_roles(user) & WRITE_ROLES):
        raise HTTPException(403, "Sólo el rol Empaque puede capturar empaque")
    return user


async def _order(order_id: str) -> dict:
    o = await db.orders.find_one({"order_id": order_id}, ORDER_PROJ)
    if not o:
        raise HTTPException(404, "Orden no encontrada")
    return o


async def _pack_doc(order_id: str) -> dict:
    doc = await db.pack_orders.find_one({"order_id": order_id}, {"_id": 0})
    if doc:
        return doc
    doc = {"order_id": order_id, "prepack_ratio": {}, "pallets": [{"no": 1, "closed": False}],
           "active_pallet": 1, "finish": None, "created_at": _now()}
    await db.pack_orders.update_one({"order_id": order_id}, {"$setOnInsert": doc}, upsert=True)
    return await db.pack_orders.find_one({"order_id": order_id}, {"_id": 0})


async def packed_totals(order_ids: list) -> dict:
    """{order_id: {packed, boxes, pallets, by_size}} — lo usa el módulo Empaque."""
    out = {}
    if not order_ids:
        return out
    pipe = [{"$match": {"order_id": {"$in": order_ids}, "voided": {"$ne": True}}},
            {"$group": {"_id": "$order_id", "packed": {"$sum": "$total"}, "boxes": {"$sum": 1},
                        "pallets": {"$addToSet": "$pallet_no"}, "last_at": {"$max": "$created_at"}}}]
    async for r in db.pack_boxes.aggregate(pipe):
        out[r["_id"]] = {"packed": int(r["packed"] or 0), "boxes": int(r["boxes"]),
                         "pallets": len([p for p in r["pallets"] if p is not None]), "last_at": r.get("last_at")}
    return out


async def _view(order_id: str) -> dict:
    o = await _order(order_id)
    doc = await _pack_doc(order_id)
    ci = await om.comment_info([order_id])
    boxes = [b async for b in db.pack_boxes.find({"order_id": order_id, "voided": {"$ne": True}}, {"_id": 0})
             .sort("created_at", 1)]
    ordered = _ordered(o)
    packed: dict = {}
    for b in boxes:
        for k, v in (b.get("sizes") or {}).items():
            packed[k] = packed.get(k, 0) + int(v or 0)
    f = doc.get("finish") or {}
    audit = []
    for k in sorted(set(ordered) | set(packed), key=_size_key):
        q, p = ordered.get(k, 0), packed.get(k, 0)
        audit.append({"size": k, "ordered": q, "packed": p, "diff": p - q})
    tot_o, tot_p = sum(ordered.values()), sum(packed.values())
    pallets = []
    for pl in doc.get("pallets") or []:
        bx = [b for b in boxes if b.get("pallet_no") == pl["no"]]
        pallets.append({**pl, "boxes": len(bx), "pcs": sum(int(b.get("total") or 0) for b in bx),
                        "box_weight": round(sum(float(b.get("weight") or 0) for b in bx), 2)})
    return {
        "order": {**o, "kind": _pack_kind(o), "ordered": ordered},
        "prepack_ratio": doc.get("prepack_ratio") or {},
        "pack_size": sum((doc.get("prepack_ratio") or {}).values()),
        "audit": audit, "total_ordered": tot_o, "total_packed": tot_p,
        "missing": sum(max(0, -a["diff"]) for a in audit), "over": sum(max(0, a["diff"]) for a in audit),
        "complete": bool(audit) and all(a["diff"] == 0 for a in audit),
        "boxes": boxes[::-1], "box_count": len(boxes),
        "pallets": pallets, "active_pallet": doc.get("active_pallet"),
        "finish": f or None,
        "in_packing": str(o.get("production_status") or "").strip().upper() in PACKING_STATUSES,
        "comments": (ci.get(order_id) or {}).get("count", 0),
        "last_comment": (ci.get(order_id) or {}).get("last"),
        # Espejo en el DPL de Google (services/dpl_sync.py).
        "dpl": {"enabled": dpl.enabled(), "pending": dpl.pending(order_id), **(doc.get("dpl_sync") or {})},
    }


# ── Estación ────────────────────────────────────────────────────────────────

@router.get("/machines")
async def machines(request: Request):
    await require_auth(request)
    return {"machines": await get_machines()}


@router.get("/station/{machine}")
async def station(machine: str, request: Request):
    user = await require_auth(request)
    machine = machine.strip().upper()
    if machine not in await get_machines():
        raise HTTPException(404, f"No existe la máquina {machine}")
    cur = await db.machine_states.find_one({"machine": machine}, {"_id": 0, "order_number": 1, "state": 1}) or {}
    since = (datetime.now(timezone.utc) - timedelta(days=RECENT_DAYS)).isoformat()
    printed = await db.production_logs.distinct("order_id", {"machine": machine, "created_at": {"$gte": since}})
    q = {"$or": [{"order_id": {"$in": printed}}, {"board": machine}]}
    if cur.get("order_number"):
        q["$or"].append({"order_number": cur["order_number"]})
    orders = [o async for o in db.orders.find(
        {**q, "board": {"$ne": "PAPELERA DE RECICLAJE"}}, ORDER_PROJ)]
    cur_num = str(cur.get("order_number") or "")
    keep = []
    for o in orders:
        st = str(o.get("production_status") or "").strip().upper()
        running = str(o.get("order_number")) == cur_num
        # Lo que corre, lo que ya está en empaque y lo que se está imprimiendo
        # aquí (se empaca conforme sale). Lo que sólo espera turno, no.
        if running or st in PACKING_STATUSES or st == "EN PRODUCCION":
            keep.append({**o, "running": running, "kind": _pack_kind(o)})
    tot = await packed_totals([o["order_id"] for o in keep])
    for o in keep:
        o.update(tot.get(o["order_id"]) or {"packed": 0, "boxes": 0, "pallets": 0})
    # La que corre primero; luego las que ya se están empacando; luego por número.
    keep.sort(key=lambda o: (not o["running"],
                             str(o.get("production_status") or "").upper() != IN_PROCESS, str(o.get("order_number"))))
    packers = await db.pack_boxes.distinct("packer", {"machine": machine})
    sizes = [s async for s in db.pack_box_sizes.find({"active": {"$ne": False}}, {"_id": 0}).sort([("rank", 1), ("name", 1)])]
    return {"machine": machine, "machine_state": cur.get("state"), "orders": keep,
            "packers": sorted(p for p in packers if p), "box_sizes": sizes,
            "can_edit": bool(user_roles(user) & WRITE_ROLES)}


@router.get("/order/{order_id}")
async def order_view(order_id: str, request: Request):
    await require_auth(request)
    return await _view(order_id)


@router.put("/order/{order_id}/ratio")
async def set_ratio(order_id: str, request: Request):
    await _can_write(request)
    o = await _order(order_id)
    body = await request.json()
    ordered = _ordered(o)
    ratio = {}
    for k, v in (body.get("ratio") or {}).items():
        k = str(k).upper()
        n = int(_num(v, f"proporción {k}", 0, 1000) or 0)
        if n and k not in ordered:
            raise HTTPException(400, f"La orden no pide talla {k}")
        if n:
            ratio[k] = n
    if not ratio:
        raise HTTPException(400, "La proporción del pack está vacía")
    await _pack_doc(order_id)
    await db.pack_orders.update_one({"order_id": order_id}, {"$set": {"prepack_ratio": ratio, "updated_at": _now()}})
    return await _view(order_id)


@router.post("/order/{order_id}/boxes")
async def add_boxes(order_id: str, request: Request):
    user = await _can_write(request)
    o = await _order(order_id)
    body = await request.json()
    doc = await _pack_doc(order_id)
    ordered = _ordered(o)
    if body.get("packs") not in (None, ""):
        ratio = doc.get("prepack_ratio") or {}
        if not ratio:
            raise HTTPException(400, "Primero captura la proporción del pack")
        packs = int(_num(body["packs"], "packs", 1, 10000, required=True))
        sizes = {k: v * packs for k, v in ratio.items()}
    else:
        sizes = {}
        for k, v in (body.get("sizes") or {}).items():
            k = str(k).upper()
            n = int(_num(v, f"piezas {k}", 0, 100000) or 0)
            if n and k not in ordered:
                raise HTTPException(400, f"La orden no pide talla {k}")
            if n:
                sizes[k] = n
    if not sizes:
        raise HTTPException(400, "La caja no tiene piezas")
    count = int(_num(body.get("count") or 1, "cajas iguales", 1, MAX_COUNT))
    size_doc = None
    if body.get("box_size_id"):
        size_doc = await db.pack_box_sizes.find_one({"box_size_id": body["box_size_id"]}, {"_id": 0})
        if not size_doc:
            raise HTTPException(400, "Caja del catálogo no encontrada")
        dims = {k: size_doc[k] for k in ("l", "w", "h")}
    else:
        dims = _dims(body.get("dims"))
    weight = _num(body.get("weight"), "peso", 0, 2000)
    packer = str(body.get("packer") or "").strip()[:60]
    if not packer:
        raise HTTPException(400, "Falta quién empaca")
    active = doc.get("active_pallet")
    if not any(p["no"] == active and not p.get("closed") for p in doc.get("pallets") or []):
        raise HTTPException(409, "No hay pallet abierto: abre uno antes de cerrar cajas")
    now, total = _now(), sum(sizes.values())
    batch = uuid.uuid4().hex[:10]
    docs = [{"box_id": f"box_{uuid.uuid4().hex[:12]}", "batch": batch, "order_id": order_id,
             "order_number": o.get("order_number"), "machine": str(body.get("machine") or "").upper()[:20],
             "packer": packer, "sizes": sizes, "total": total, "dims": dims,
             "box_size_id": (size_doc or {}).get("box_size_id"), "box_size_name": (size_doc or {}).get("name"),
             "weight": weight, "pallet_no": active, "created_at": now,
             "created_by": user.get("email") or user.get("user_id"), "voided": False} for _ in range(count)]
    await db.pack_boxes.insert_many(docs)
    if str(o.get("production_status") or "").strip().upper() == NEEDS:
        from routers.orders import update_order   # lazy (evita ciclo)
        await update_order(order_id, OrderUpdate(production_status=IN_PROCESS), request)
    await log_activity(user, "pack_boxes", {"order_id": order_id, "order_number": o.get("order_number"),
                                            "boxes": count, "pcs": total * count, "pallet": active})
    dpl.schedule(order_id, "cajas")
    return await _view(order_id)


@router.delete("/boxes/{box_id}")
async def void_box(box_id: str, request: Request):
    user = await _can_write(request)
    b = await db.pack_boxes.find_one({"box_id": box_id, "voided": {"$ne": True}}, {"_id": 0})
    if not b:
        raise HTTPException(404, "Caja no encontrada")
    await db.pack_boxes.update_one({"box_id": box_id}, {"$set": {
        "voided": True, "voided_at": _now(), "voided_by": user.get("email") or user.get("user_id")}})
    await log_activity(user, "pack_box_void", {"order_id": b["order_id"], "order_number": b.get("order_number"),
                                               "box_id": box_id, "pcs": b.get("total")})
    dpl.schedule(b["order_id"], "caja anulada")
    return await _view(b["order_id"])


@router.post("/order/{order_id}/pallet/close")
async def close_pallet(order_id: str, request: Request):
    await _can_write(request)
    body = await request.json()
    doc = await _pack_doc(order_id)
    active = doc.get("active_pallet")
    pallets = doc.get("pallets") or []
    cur = next((p for p in pallets if p["no"] == active and not p.get("closed")), None)
    if not cur:
        raise HTTPException(409, "No hay pallet abierto")
    if not await db.pack_boxes.count_documents({"order_id": order_id, "pallet_no": active, "voided": {"$ne": True}}):
        raise HTTPException(400, f"El pallet {active} no tiene cajas")
    cur.update(closed=True, dims=_dims(body.get("dims")), weight=_num(body.get("weight"), "peso del pallet", 0, 10000),
               closed_at=_now())
    nxt = max(p["no"] for p in pallets) + 1
    if body.get("open_next", True):
        pallets.append({"no": nxt, "closed": False})
        active = nxt
    else:
        active = None
    await db.pack_orders.update_one({"order_id": order_id}, {"$set": {"pallets": pallets, "active_pallet": active,
                                                                     "updated_at": _now()}})
    dpl.schedule(order_id, "pallet cerrado")
    return await _view(order_id)


@router.post("/order/{order_id}/pallet/select")
async def select_pallet(order_id: str, request: Request):
    """Cambiar el pallet activo a uno abierto, o abrir uno nuevo (no=0)."""
    await _can_write(request)
    body = await request.json()
    doc = await _pack_doc(order_id)
    pallets = doc.get("pallets") or []
    no = int(_num(body.get("no"), "pallet", 0, 999, required=True))
    if no == 0:
        no = max([p["no"] for p in pallets] or [0]) + 1
        pallets.append({"no": no, "closed": False})
    elif not any(p["no"] == no and not p.get("closed") for p in pallets):
        # Reabrir un pallet cerrado (se equivocaron al cerrarlo).
        p = next((p for p in pallets if p["no"] == no), None)
        if not p:
            raise HTTPException(404, f"No existe el pallet {no}")
        p["closed"] = False
    await db.pack_orders.update_one({"order_id": order_id}, {"$set": {"pallets": pallets, "active_pallet": no,
                                                                     "updated_at": _now()}})
    return await _view(order_id)


@router.get("/order/{order_id}/dpl-preview")
async def dpl_preview(order_id: str, request: Request):
    """Lo que se escribiría en el DPL, sin tocar Google."""
    await require_auth(request)
    await _order(order_id)
    return await dpl.build_payload(order_id)


@router.post("/order/{order_id}/dpl-sync")
async def dpl_sync_now(order_id: str, request: Request):
    """Actualizar el DPL ahora (sin esperar la pausa de la sincronización)."""
    await _can_write(request)
    await _order(order_id)
    await dpl.sync(order_id, "manual")
    return await _view(order_id)


@router.put("/order/{order_id}/finish")
async def finish(order_id: str, request: Request):
    user = await _can_write(request)
    body = await request.json()
    await _pack_doc(order_id)
    f = {k: int(_num(body.get(k), k, 0, 100000) or 0)
         for k in ("damaged_print", "damaged_garment", "extra", "samples")}
    f.update(notes=str(body.get("notes") or "").strip()[:300], at=_now(), by=user.get("email") or user.get("user_id"))
    await db.pack_orders.update_one({"order_id": order_id}, {"$set": {"finish": f, "updated_at": _now()}})
    return await _view(order_id)


# ── Catálogo de cajas (manual) ──────────────────────────────────────────────

@router.get("/box-sizes")
async def list_sizes(request: Request):
    await require_auth(request)
    return {"items": [s async for s in db.pack_box_sizes.find({"active": {"$ne": False}}, {"_id": 0}).sort([("rank", 1), ("name", 1)])]}


@router.post("/box-sizes")
async def save_size(request: Request):
    user = await _can_write(request)
    body = await request.json()
    name = str(body.get("name") or "").strip()[:40]
    if not name:
        raise HTTPException(400, "Falta el nombre de la caja")
    d = _dims(body)
    sid = body.get("box_size_id") or f"bxs_{uuid.uuid4().hex[:10]}"
    await db.pack_box_sizes.update_one({"box_size_id": sid}, {"$set": {
        "box_size_id": sid, "name": name, **d, "active": True, "updated_at": _now(),
        "updated_by": user.get("email") or user.get("user_id")},
        # Orden del catálogo: las más usadas primero (la primera es la sugerida);
        # las nuevas, al final.
        "$setOnInsert": {"rank": 999}}, upsert=True)
    return await list_sizes(request)


@router.delete("/box-sizes/{box_size_id}")
async def delete_size(box_size_id: str, request: Request):
    await _can_write(request)
    await db.pack_box_sizes.update_one({"box_size_id": box_size_id}, {"$set": {"active": False, "updated_at": _now()}})
    return await list_sizes(request)
