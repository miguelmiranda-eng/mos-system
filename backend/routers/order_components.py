"""Componentes de orden: qué piezas necesita una orden y cuál la está frenando.

POR QUÉ UNA COLECCIÓN PROPIA
────────────────────────────
La orden ya trae siete campos de estatus (blank_status, trim_status, trim_box,
artwork_status, screens, sample, shipping), pero son UN valor para toda la
orden: no responden "faltan 200 de 500 blancos y llegan el jueves". Esto vive
en `db.order_components` y se une con la orden al leer — el mismo patrón que
`scheduled_shipments`, que no ensucia el modelo de orden.

Este módulo NO lee ni escribe esos siete campos. Si algún día el tablero se
alimenta de aquí, se agrega sin rediseñar nada; al revés sí habría sido
rediseño.

EL ENLACE ES `order_id`, NUNCA `order_number`
─────────────────────────────────────────────
Hay números de orden gemelos: el 666 existe tres veces en la colección, y
`scheduled_shipments` ya tuvo que excluir la papelera al unir por número para
no traer los datos de la gemela equivocada. `order_number` se guarda
desnormalizado sólo para mostrar y buscar.

Endpoints (prefijo /api/order-components):
  GET    /order/{order_id}      → componentes de una orden + su resumen
  POST   ""                     → crea un componente
  PUT    /{component_id}        → edita
  DELETE /{component_id}        → borra (admin)
  POST   /order/{order_id}/seed → siembra la plantilla en una orden
  GET    /tracking              → resumen por orden, para el tablero
  GET    /template              → plantilla de tipos por defecto
  PUT    /template              → edita la plantilla (admin)
"""
import uuid
from datetime import datetime, timezone

from fastapi import APIRouter, HTTPException, Request

from deps import db, require_auth, require_admin, log_activity

router = APIRouter(prefix="/api/order-components")

# ── Vocabulario ────────────────────────────────────────────────────────────
# Catálogo FIJO a propósito: si cada orden inventa sus componentes no se puede
# comparar entre órdenes ni sacar el tablero de "qué está frenando qué".
# OTHER + `name` cubre lo raro sin romper la comparabilidad.
TYPES = ["BLANKS", "SCREENS", "ART", "INK", "TRIMS", "NECK_LABEL", "PACKAGING", "OTHER"]

# Escalera ORDENADA. Con esto "el componente que frena" es el de menor avance
# entre los que bloquean — una comparación, sin reglas especiales.
LADDER = ["PENDING", "REQUESTED", "IN_TRANSIT", "RECEIVED", "READY"]
BLOCKED = "BLOCKED"      # atorado: cuenta como lo peor
NOT_APPLICABLE = "N_A"   # no aplica a esta orden: sale de todos los cálculos
STATES = LADDER + [BLOCKED, NOT_APPLICABLE]

# BLOCKED va por debajo de todo para que gane al elegir "quién frena".
RANK = {BLOCKED: -1, **{s: i for i, s in enumerate(LADDER)}}
DONE = "READY"
RECEIVED_RANK = LADDER.index("RECEIVED")

# Plantilla por defecto si nadie ha configurado una. Lo que se siembra en una
# orden nueva para que nazca con su checklist en vez de en blanco.
DEFAULT_TEMPLATE = [
    {"type": "BLANKS", "blocks": True},
    {"type": "SCREENS", "blocks": True},
    {"type": "ART", "blocks": True},
    {"type": "INK", "blocks": True},
    {"type": "TRIMS", "blocks": False},
    {"type": "NECK_LABEL", "blocks": False},
    {"type": "PACKAGING", "blocks": False},
]
_TEMPLATE_ID = "order_component_template"


def _now():
    return datetime.now(timezone.utc).isoformat()


def _hoy():
    return datetime.now(timezone.utc).date().isoformat()


def _int_o_none(v):
    """Cantidad como entero, o None. `null` es un dato real aquí: significa
    "esto no se cuenta" (arte, mallas), distinto de cero."""
    if v is None or v == "":
        return None
    try:
        return max(0, int(v))
    except (TypeError, ValueError):
        return None


def _limpio(doc: dict) -> dict:
    doc.pop("_id", None)
    return doc


async def _plantilla() -> list:
    cfg = await db.config_options.find_one({"config_id": _TEMPLATE_ID}, {"_id": 0})
    filas = (cfg or {}).get("items")
    return filas if isinstance(filas, list) and filas else DEFAULT_TEMPLATE


# ══ Etapas del proceso ═════════════════════════════════════════════════════
# La etapa NO se captura: MOS ya la sabe. El TABLERO dice dónde está parada la
# orden (BLANKS, SCREENS, NECK, MAQUINA5, CONTROL DE CALIDAD…) y el
# `production_status` dice en qué va (EN PRODUCCION, EN PROCESO DE EMPAQUE,
# NECESITA QC). Este módulo sólo las ordena y las cuenta.
#
# REGLA: manda el TABLERO cuando corresponde a una etapa; el status sólo decide
# cuando el tablero no es operativo (SCHEDULING, MASTER…). Medido en la base:
# 20 de 57 órdenes abiertas NO tienen production_status, así que sin esta
# precedencia un tercio del tablero se quedaría sin etapa.
STAGES = [
    ("SCHEDULING",  "Programación"),
    ("BLANKS",      "Blancos"),
    ("SCREENS",     "Mallas"),
    ("LABEL",       "Neck"),
    ("PRODUCTION",  "Producción"),
    ("PACKING",     "Empaque"),
    ("SHIPPED",     "Enviada"),
]
STAGE_RANK = {k: i for i, (k, _) in enumerate(STAGES)}
STAGE_LABEL = dict(STAGES)

# Tableros OPERATIVOS: la orden está físicamente ahí, así que el tablero manda
# aunque el status diga otra cosa.
BOARD_STAGE = {
    "BLANKS": "BLANKS",
    "SCREENS": "SCREENS",
    "NECK": "LABEL",
    # QC va fundido en Empaque: es la revisión previa al envío y la secuencia
    # pedida no lo lleva como paso propio. Si hace falta separarlo, es agregarlo
    # a STAGES entre PRODUCTION y PACKING y remapear estas dos entradas.
    "CONTROL DE CALIDAD": "PACKING",
    "COMPLETOS": "PACKING",
    "FINAL BILL": "PACKING",
}

# Tableros de PLANEACIÓN: todavía no son una etapa de piso, así que si el status
# dice algo concreto (EN PRODUCCION, LABEL LISTO…) gana el status. Sirven de
# respaldo para que una orden recién capturada, sin status, no salga "sin
# etapa": estar en el tablero de programación ya es estar en programación.
FALLBACK_BOARD_STAGE = {
    "SCHEDULING": "SCHEDULING",
    "READY TO SCHEDULED": "SCHEDULING",
    "MASTER": "SCHEDULING",
    "EDI": "SCHEDULING",
}

STATUS_STAGE = {
    "NECESITA LABEL": "LABEL", "PROCESO DE NECK LABEL": "LABEL",
    "PROCESO DE LABEL": "LABEL", "LABEL LISTO": "LABEL",
    "EN PRODUCCION": "PRODUCTION",
    "NECESITA EMPACAR": "PACKING", "EN PROCESO DE EMPAQUE": "PACKING",
    "NECESITA QC": "PACKING", "CORRECIÓN DE QC": "PACKING",
    "LISTO PARA FULFILLMENT": "PACKING",
    "EJEMPLO APROBADO": "SCHEDULING", "ESPERA DE APROBAC": "SCHEDULING",
    "EN ESPERA": "SCHEDULING",
}

# Una orden con estos status está detenida por decisión, no por falta de algo.
STALLED = {"EN ESPERA", "ESPERA DE APROBAC"}

# Fuera del seguimiento: ya salió de producción o se canceló.
CLOSED_STATUSES = {"LISTO PARA ENVIO", "LISTO PARA INVENTARIO", "CANCELLED"}


def stage_of(order: dict) -> dict:
    """Etapa de una orden a partir de lo que MOS ya sabe.

    Devuelve también de dónde salió y si las dos señales discrepan: que el
    tablero diga BLANKS y el status diga EN PRODUCCION es información, no ruido
    — alguien avanzó una sin mover la otra."""
    board = (order.get("board") or "").strip().upper()
    status = (order.get("production_status") or "").strip().upper()

    por_tablero = BOARD_STAGE.get(board)
    if board.startswith("MAQUINA"):
        por_tablero = "PRODUCTION"
    por_status = STATUS_STAGE.get(status)

    respaldo = FALLBACK_BOARD_STAGE.get(board)
    key = por_tablero or por_status or respaldo
    origen = "board" if por_tablero else ("status" if por_status else ("board" if respaldo else None))

    # El status va más adelante que el tablero: la orden avanzó y nadie la movió.
    adelantado = bool(
        por_tablero and por_status
        and STAGE_RANK[por_status] > STAGE_RANK[por_tablero]
    )
    return {
        "key": key,
        "label": STAGE_LABEL.get(key, "Sin etapa"),
        "rank": STAGE_RANK.get(key, -1),
        "from": origen,
        "board": board or "",
        "status": order.get("production_status") or "",
        "ahead": adelantado,
        "ahead_key": por_status if adelantado else None,
        "ahead_stage": STAGE_LABEL.get(por_status) if adelantado else None,
        "stalled": status in STALLED,
    }

def resumen(componentes: list) -> dict:
    """Las cuatro cifras que hacen útil el módulo. Se derivan al leer, no se
    guardan: un rollup guardado se desincroniza en cuanto alguien edita un
    componente por otra vía."""
    aplican = [c for c in componentes if c.get("state") != NOT_APPLICABLE]
    if not aplican:
        return {"total": 0, "ready": 0, "pct": 0, "blocking": None,
                "worst_due": None, "late": 0, "state": "N_A"}

    listos = [c for c in aplican if c.get("state") == DONE]
    frenan = [c for c in aplican if c.get("blocks") and c.get("state") != DONE]

    # Quién frena: el de menor avance. A igualdad, el de fecha más próxima —
    # entre dos igual de atrasados importa el que vence antes.
    culpable = None
    if frenan:
        culpable = min(frenan, key=lambda c: (RANK.get(c.get("state"), 0),
                                              c.get("due_date") or "9999-12-31"))

    hoy = _hoy()
    atrasados = [c for c in aplican
                 if c.get("due_date") and c["due_date"] < hoy
                 and RANK.get(c.get("state"), 0) < RECEIVED_RANK]

    # Fecha realista de la orden: la más lejana de lo que todavía la frena.
    fechas = [c["due_date"] for c in frenan if c.get("due_date")]

    return {
        "total": len(aplican),
        "ready": len(listos),
        "pct": round(len(listos) * 100 / len(aplican)),
        "blocking": {
            "component_id": culpable.get("component_id"),
            "type": culpable.get("type"),
            "name": culpable.get("name") or "",
            "state": culpable.get("state"),
            "due_date": culpable.get("due_date"),
        } if culpable else None,
        "worst_due": max(fechas) if fechas else None,
        "late": len(atrasados),
        "state": DONE if not frenan else (culpable or {}).get("state"),
    }


# ══ Lectura ═══════════════════════════════════════════════════════════════
@router.get("/template")
async def get_template(request: Request):
    await require_auth(request)
    return {"items": await _plantilla(), "types": TYPES, "states": STATES}


@router.get("/tracking")
async def tracking(request: Request, stage: str = "", client: str = "",
                   only_late: bool = False, only_stalled: bool = False,
                   limit: int = 2000):
    """TODAS las órdenes abiertas con la etapa en la que están.

    "Abierta" = todavía no sale de producción: su `production_status` no es
    LISTO PARA ENVIO, LISTO PARA INVENTARIO ni CANCELLED. No hace falta que
    alguien las dé de alta aquí — si la orden existe y sigue viva, se sigue.

    Los componentes son una capa OPCIONAL encima: si alguien capturó el detalle
    de qué le falta, se muestra su resumen; si no, la etapa sola ya dice dónde
    está. Por eso el módulo sirve desde el primer día, sin capturar nada."""
    await require_auth(request)

    q = {
        # La papelera nunca entra: ahí viven las gemelas de los números repetidos.
        "board": {"$ne": "PAPELERA DE RECICLAJE"},
        "production_status": {"$nin": list(CLOSED_STATUSES)},
    }
    if client:
        q["client"] = client

    ordenes = await db.orders.find(q, {
        "_id": 0, "order_id": 1, "order_number": 1, "client": 1, "branding": 1,
        "quantity": 1, "cancel_date": 1, "due_date": 1, "board": 1,
        "production_status": 1, "priority": 1,
    }).to_list(limit)
    if not ordenes:
        return {"rows": [], "total": 0, "stages": [], "counts": {}}

    # Los componentes son opcionales: una sola consulta para las que sí tienen.
    porc = {}
    async for c in db.order_components.find(
            {"order_id": {"$in": [o["order_id"] for o in ordenes]}}, {"_id": 0}):
        porc.setdefault(c["order_id"], []).append(c)

    filas = []
    for o in ordenes:
        comps = porc.get(o["order_id"], [])
        filas.append({
            **o,
            "stage": stage_of(o),
            "summary": resumen(comps) if comps else None,
            "components": len(comps),
        })

    cuenta = {}
    for f in filas:
        k = f["stage"]["key"] or "NONE"
        cuenta[k] = cuenta.get(k, 0) + 1

    if stage:
        filas = [f for f in filas if (f["stage"]["key"] or "NONE") == stage.upper()]
    if only_late:
        filas = [f for f in filas if (f["summary"] or {}).get("late")]
    if only_stalled:
        filas = [f for f in filas if f["stage"]["stalled"]]

    # Primero lo que va más atrás en el proceso y vence antes: es el orden en
    # que hay que empujarlas. Las que no tienen etapa van al final.
    filas.sort(key=lambda f: (
        f["stage"]["rank"] if f["stage"]["rank"] >= 0 else 99,
        f.get("cancel_date") or "9999-12-31",
    ))
    return {
        "rows": filas,
        "total": len(filas),
        "stages": [{"key": k, "label": lbl, "count": cuenta.get(k, 0)} for k, lbl in STAGES],
        "counts": cuenta,
    }


@router.get("/order/{order_id}")
async def list_for_order(order_id: str, request: Request):
    await require_auth(request)
    comps = await db.order_components.find({"order_id": order_id}, {"_id": 0}) \
        .sort("created_at", 1).to_list(200)
    # Orden estable por catálogo para que la lista no baile entre recargas.
    comps.sort(key=lambda c: (TYPES.index(c["type"]) if c.get("type") in TYPES else 99,
                              c.get("name") or ""))
    return {"components": comps, "summary": resumen(comps)}


# ══ Escritura ═════════════════════════════════════════════════════════════
async def _orden_o_404(order_id: str) -> dict:
    o = await db.orders.find_one({"order_id": order_id}, {"_id": 0, "order_id": 1, "order_number": 1})
    if not o:
        raise HTTPException(404, "La orden no existe")
    return o


def _valida(tipo: str, estado: str):
    if tipo not in TYPES:
        raise HTTPException(400, f"Tipo inválido. Usa uno de: {', '.join(TYPES)}")
    if estado not in STATES:
        raise HTTPException(400, f"Estado inválido. Usa uno de: {', '.join(STATES)}")


@router.post("")
async def create_component(request: Request):
    user = await require_auth(request)
    body = await request.json()
    order_id = (body.get("order_id") or "").strip()
    if not order_id:
        raise HTTPException(400, "Falta order_id")
    orden = await _orden_o_404(order_id)

    tipo = (body.get("type") or "").strip().upper()
    estado = (body.get("state") or "PENDING").strip().upper()
    _valida(tipo, estado)
    nombre = (body.get("name") or "").strip()

    # El índice único lo impide igual; aquí sale un mensaje entendible.
    if await db.order_components.find_one({"order_id": order_id, "type": tipo, "name": nombre}):
        raise HTTPException(409, "Esa orden ya tiene ese componente")

    doc = {
        "component_id": f"ocmp_{uuid.uuid4().hex[:12]}",
        "order_id": order_id,
        "order_number": orden.get("order_number") or "",
        "type": tipo,
        "name": nombre,
        "blocks": bool(body.get("blocks", True)),
        "state": estado,
        "qty_required": _int_o_none(body.get("qty_required")),
        "qty_received": _int_o_none(body.get("qty_received")),
        "due_date": (body.get("due_date") or "") or None,
        "received_at": _now() if estado in ("RECEIVED", DONE) else None,
        "supplier": (body.get("supplier") or "").strip(),
        "reference": (body.get("reference") or "").strip(),
        "owner_id": body.get("owner_id") or "",
        "owner_name": (body.get("owner_name") or "").strip(),
        "note": (body.get("note") or "").strip(),
        "created_at": _now(),
        "created_by": user.get("user_id"),
        "updated_at": _now(),
    }
    await db.order_components.insert_one(doc)
    await log_activity(user, "order_component_create", {
        "order_id": order_id, "order_number": doc["order_number"],
        "type": tipo, "state": estado,
    })
    return _limpio(doc)


# Sólo estos campos se dejan editar: order_id y component_id no se mueven.
_EDITABLES = {"type", "name", "blocks", "state", "qty_required", "qty_received",
              "due_date", "supplier", "reference", "owner_id", "owner_name", "note"}


@router.put("/{component_id}")
async def update_component(component_id: str, request: Request):
    user = await require_auth(request)
    actual = await db.order_components.find_one({"component_id": component_id}, {"_id": 0})
    if not actual:
        raise HTTPException(404, "El componente no existe")
    body = await request.json()

    cambios = {}
    for k in _EDITABLES:
        if k not in body:
            continue
        v = body[k]
        if k in ("qty_required", "qty_received"):
            v = _int_o_none(v)
        elif k == "blocks":
            v = bool(v)
        elif k == "due_date":
            v = (v or "") or None
        elif k in ("type", "state"):
            v = (v or "").strip().upper()
        elif isinstance(v, str):
            v = v.strip()
        cambios[k] = v

    _valida(cambios.get("type", actual["type"]), cambios.get("state", actual["state"]))

    # `received_at` se sella solo al cruzar a RECIBIDO, y se limpia si alguien
    # regresa el componente: si no, quedaría una fecha de recepción mintiendo
    # sobre un componente que ya no está recibido.
    if "state" in cambios and cambios["state"] != actual.get("state"):
        entra = cambios["state"] in ("RECEIVED", DONE)
        estaba = actual.get("state") in ("RECEIVED", DONE)
        if entra and not estaba:
            cambios["received_at"] = _now()
        elif estaba and not entra:
            cambios["received_at"] = None

    if not cambios:
        return _limpio(actual)
    cambios["updated_at"] = _now()

    if "type" in cambios or "name" in cambios:
        choque = await db.order_components.find_one({
            "order_id": actual["order_id"],
            "type": cambios.get("type", actual["type"]),
            "name": cambios.get("name", actual.get("name") or ""),
            "component_id": {"$ne": component_id},
        })
        if choque:
            raise HTTPException(409, "Esa orden ya tiene ese componente")

    await db.order_components.update_one({"component_id": component_id}, {"$set": cambios})
    await log_activity(user, "order_component_update", {
        "order_id": actual["order_id"], "order_number": actual.get("order_number"),
        "component_id": component_id, "changes": list(cambios.keys()),
        "state": cambios.get("state", actual.get("state")),
    })
    return _limpio({**actual, **cambios})


@router.delete("/{component_id}")
async def delete_component(component_id: str, request: Request):
    # Borrar pierde el rastro de lo que se estaba esperando; para "ya no
    # aplica" está el estado N_A, que sí conserva el registro.
    user = await require_admin(request)
    doc = await db.order_components.find_one({"component_id": component_id}, {"_id": 0})
    if not doc:
        raise HTTPException(404, "El componente no existe")
    await db.order_components.delete_one({"component_id": component_id})
    await log_activity(user, "order_component_delete", {
        "order_id": doc["order_id"], "order_number": doc.get("order_number"),
        "type": doc.get("type"),
    })
    return {"ok": True}


@router.post("/order/{order_id}/seed")
async def seed_order(order_id: str, request: Request):
    """Siembra la plantilla. Idempotente: sólo agrega lo que falta, así que
    correrlo dos veces no duplica ni pisa lo que alguien ya capturó."""
    user = await require_auth(request)
    orden = await _orden_o_404(order_id)
    ya = {(c["type"], c.get("name") or "")
          async for c in db.order_components.find({"order_id": order_id}, {"_id": 0, "type": 1, "name": 1})}

    nuevos = []
    for fila in await _plantilla():
        tipo = (fila.get("type") or "").strip().upper()
        if tipo not in TYPES or (tipo, "") in ya:
            continue
        nuevos.append({
            "component_id": f"ocmp_{uuid.uuid4().hex[:12]}",
            "order_id": order_id,
            "order_number": orden.get("order_number") or "",
            "type": tipo, "name": "",
            "blocks": bool(fila.get("blocks", True)),
            "state": "PENDING",
            "qty_required": None, "qty_received": None,
            "due_date": None, "received_at": None,
            "supplier": "", "reference": "", "owner_id": "", "owner_name": "", "note": "",
            "created_at": _now(), "created_by": user.get("user_id"), "updated_at": _now(),
        })
    if nuevos:
        await db.order_components.insert_many(nuevos)
        await log_activity(user, "order_component_seed", {
            "order_id": order_id, "order_number": orden.get("order_number"), "count": len(nuevos),
        })
    return {"created": len(nuevos), "skipped": len(ya)}


@router.put("/template")
async def set_template(request: Request):
    user = await require_admin(request)
    body = await request.json()
    filas = body.get("items")
    if not isinstance(filas, list) or not filas:
        raise HTTPException(400, "La plantilla necesita al menos un tipo")
    limpias = []
    for f in filas:
        tipo = (f.get("type") or "").strip().upper()
        if tipo not in TYPES:
            raise HTTPException(400, f"Tipo inválido en la plantilla: {tipo}")
        limpias.append({"type": tipo, "blocks": bool(f.get("blocks", True))})
    await db.config_options.update_one(
        {"config_id": _TEMPLATE_ID},
        {"$set": {"config_id": _TEMPLATE_ID, "items": limpias, "updated_at": _now()}},
        upsert=True,
    )
    await log_activity(user, "order_component_template", {"count": len(limpias)})
    return {"items": limpias}
