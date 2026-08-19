"""Retorno de material sobrante de producción al almacén.

EL HUECO QUE LLENA
Hasta ahora el WMS sólo sabía recibir material EXTERNO. Lo que sobraba de
producción volvía por la puerta de atrás: `/boxes/generate` en el módulo Mover,
pensado para otra cosa. Entre julio y agosto de 2026 regresaron así 64.121
unidades en 1.626 capturas — y el 78% de esas cajas entró SIN país de origen
(contra 1% en la recepción normal), porque el formulario pedía origen y
composición como texto libre y nadie los llenaba.

Eso no es un descuido cosmético: en este sistema la identidad del lote incluye
país de origen y composición, y para confección importada a EUA el país es
requisito legal de etiquetado. Material que salió como HONDURAS volvía como
nada, fusionando o partiendo lotes que debían quedar separados.

LA REGLA DE ESTE MÓDULO
Todos los campos de identidad salen del catálogo curado de Configuración WMS —
ninguno se teclea libre— y país de origen y composición son OBLIGATORIOS. Si no
se puede decir de dónde vino el material, no entra.

EL FLUJO
  1. Captura: cliente, estilo, color, talla, cantidad, país y composición. Si
     vuelven varias cajas idénticas se captura el número de cajas y la cantidad
     se entiende POR CAJA.
  2. Se mintean N cajas nuevas (etiqueta nueva cada una) marcadas como retorno y
     se acopian en la ubicación de retorno.
  3. Las cajas se acumulan en una lista; se seleccionan una o varias y se mandan
     a su ubicación definitiva con `/api/wms/putaway/bulk`, que ya reproyecta el
     inventario correctamente.

Por qué caja nueva y no "revivir" la original: la caja que salió se agotó al
surtirse. Lo que vuelve es un remanente físico distinto —otra cantidad, otro
cartón— y merece su propio LPN. Lo que sí se conserva es la identidad completa.

Por qué NO escribe en `wms_receiving`: los reportes de recibos miden entrada de
proveedor. Meter aquí los retornos inflaría esos KPIs y volvería a mezclar dos
cosas distintas. El rastro queda en `wms_returns` y en `wms_movements`.
"""
from fastapi import APIRouter, HTTPException, Request

from deps import db, require_auth
from routers.wms import (
    _assert_curated_identity,
    _assert_not_on_hold,
    _canonical_customer,
    _reserve_box_seqs,
    _update_inventory_enhanced,
    gen_id,
    log_movement,
    notify_badge_change,
    now_iso,
)

router = APIRouter(prefix="/api/wms/returns")

# Ubicación de acopio: el material retornado espera aquí a que alguien lo mande
# a su lugar definitivo. Separada de UBICACION TEMPORAL (que es el acopio de
# recepción externa) a propósito: lo que vuelve de producción puede venir
# mermado o sucio y no debe confundirse con material que nunca salió.
RETURN_STAGING = "RETORNO PRODUCCION"

# Tope por captura. No es una regla de negocio: es un freno a la mano pesada en
# el teclado — un "500" tecleado por error minteaba 500 folios irreversibles.
MAX_BOXES_POR_CAPTURA = 100

# La identidad completa. Ninguno es opcional — ver el encabezado del módulo.
_REQUERIDOS = ("customer", "style", "color", "size", "country_of_origin", "fabric_content")
_ETIQUETAS = {
    "customer": "Cliente", "style": "Estilo", "color": "Color", "size": "Talla",
    "country_of_origin": "País de origen", "fabric_content": "Composición",
}


def _norm(v) -> str:
    return " ".join(str(v or "").split()).strip().upper()


async def _ensure_staging() -> str:
    """Devuelve el nombre canónico de la ubicación de acopio, creándola la
    primera vez. Se crea aquí y no a mano para que el módulo no dependa de que
    alguien haya adivinado el nombre exacto en Configuración."""
    loc = await db.wms_locations.find_one({"name": RETURN_STAGING})
    if loc:
        return loc.get("name", RETURN_STAGING)
    await db.wms_locations.insert_one({
        "location_id": gen_id("loc"), "name": RETURN_STAGING,
        "zone": "RETORNOS", "type": "transit", "active": True,
        "created_at": now_iso(),
    })
    return RETURN_STAGING


@router.post("/receive")
async def receive_return(request: Request):
    """Recibe material de retorno y mintea la caja (etiqueta nueva)."""
    user = await require_auth(request)
    body = await request.json()

    customer = await _canonical_customer(body.get("customer", ""))
    datos = {
        "customer": customer,
        "style": _norm(body.get("style")),
        "color": _norm(body.get("color")),
        "size": _norm(body.get("size")),
        "country_of_origin": _norm(body.get("country_of_origin")),
        "fabric_content": _norm(body.get("fabric_content")),
    }
    faltan = [_ETIQUETAS[k] for k in _REQUERIDOS if not datos.get(k)]
    if faltan:
        raise HTTPException(400, f"Faltan datos obligatorios: {', '.join(faltan)}")

    try:
        units = int(body.get("units") or 0)
    except (TypeError, ValueError):
        units = 0
    if units <= 0:
        raise HTTPException(400, "La cantidad debe ser mayor a 0")

    # Cuántas cajas IDÉNTICAS se están recibiendo en este movimiento. Lo normal
    # cuando vuelve una tarima es que sean varias cajas del mismo estilo/color/
    # talla con la misma cantidad: capturarlas de una en una era el mismo
    # formulario N veces y N impresiones sueltas. `units` es POR CAJA, no el
    # total — así la etiqueta de cada caja dice lo que realmente trae adentro.
    crudo = body.get("box_count")
    try:
        # `or 1` NO sirve aquí: un 0 explícito es falsy y se colaría como 1,
        # que es justo el teclazo que hay que rechazar.
        box_count = 1 if crudo in (None, "") else int(crudo)
    except (TypeError, ValueError):
        box_count = 0
    if box_count < 1:
        raise HTTPException(400, "El número de cajas debe ser mayor a 0")
    if box_count > MAX_BOXES_POR_CAPTURA:
        raise HTTPException(
            400, f"Máximo {MAX_BOXES_POR_CAPTURA} cajas por captura")

    # Puerta de catálogo: los seis campos tienen que venir de Configuración WMS.
    # `styles` y `colors` se scopean por cliente; el resto son globales.
    await _assert_curated_identity(customer, {
        "styles": datos["style"],
        "colors": datos["color"],
        "sizes": datos["size"],
        "countries": datos["country_of_origin"],
        "fabrics": datos["fabric_content"],
    })

    location = await _ensure_staging()
    await _assert_not_on_hold(user, location)

    # Los sequences se reservan de un tirón: el contador es atómico, así que N
    # cajas capturadas juntas salen con folios consecutivos y sin carreras
    # contra otra recepción simultánea.
    primer_seq = await _reserve_box_seqs(box_count)
    sku = _norm(body.get("sku")) or datos["style"]
    total_units = units * box_count

    # UN solo escritor de inventario para toda la captura: se suma el total y se
    # declaran las N cajas de golpe. Llamarlo en bucle reproyectaría el renglón
    # N veces por el mismo motivo.
    inv_id = await _update_inventory_enhanced(
        datos["style"], datos["color"], datos["size"], total_units, "add",
        customer, location,
        country_of_origin=datos["country_of_origin"],
        fabric_content=datos["fabric_content"],
        box_count=box_count,
    )

    ts = now_iso()
    box_docs, return_docs = [], []
    for i in range(box_count):
        seq = primer_seq + i
        box_id = f"BOX-{seq:06d}"
        box_docs.append({
            "box_id": box_id, "barcode": box_id, "lpn_id": box_id,
            "inventory_id": inv_id, "customer": customer,
            "style": datos["style"], "sku": sku,
            "color": datos["color"], "size": datos["size"],
            "units": units, "qty": units, "seq_num": seq,
            "location": location,
            # putaway_pending = tiene ubicación de acopio pero no definitiva. Es el
            # estado que ya usa el resto del WMS para "falta guardarlo".
            "status": "putaway_pending",
            # raw, NO "finished": es material crudo sobrante. `/boxes/generate` lo
            # marcaba como producto terminado y ensuciaba los conteos.
            "state": "raw",
            "country_of_origin": datos["country_of_origin"],
            "coo": datos["country_of_origin"],
            "fabric_content": datos["fabric_content"],
            "source": "production_return",
            "is_return": True,
            "returned_at": ts,
            "returned_by": user.get("user_id"),
            "returned_by_name": user.get("name", user.get("email", "")),
            "created_at": ts,
        })
        return_docs.append({
            "return_id": gen_id("ret"), "box_id": box_id, **datos, "units": units,
            "location": location, "sku": sku,
            "received_by": user.get("user_id"),
            "received_by_name": user.get("name", user.get("email", "")),
            "created_at": ts,
        })

    await db.wms_boxes.insert_many(box_docs)
    for d in box_docs:
        d.pop("_id", None)
    await db.wms_returns.insert_many(return_docs)

    # Un movimiento POR CAJA: el rastro del WMS se navega por LPN (Movements,
    # BoxSearch), y un solo registro agregado dejaría N-1 cajas sin historia.
    for d in box_docs:
        await log_movement(user, "material_return", {
            "box_id": d["box_id"], "units": units, "location": location, **datos,
        })
    await notify_badge_change("putaway")

    # Se responde con la PRIMERA caja en la raíz (lo que ya consumía el front y
    # el smoke para imprimir una etiqueta) más la lista completa.
    return {
        **box_docs[0],
        "boxes": box_docs,
        "box_ids": [d["box_id"] for d in box_docs],
        "box_count": box_count,
        "units_per_box": units,
        "total_units": total_units,
    }


@router.get("/pending")
async def list_pending_returns(request: Request, limit: int = 500):
    """Cajas de retorno que siguen en acopio, esperando ubicación definitiva.

    En cuanto se mandan a su lugar con putaway/bulk pasan a `status="stored"` y
    salen de esta lista sin borrarse: siguen siendo trazables por
    `source="production_return"`."""
    await require_auth(request)
    limit = max(1, min(limit, 1000))
    cajas = await db.wms_boxes.find(
        {"source": "production_return", "status": "putaway_pending"},
        {"_id": 0, "box_id": 1, "customer": 1, "style": 1, "color": 1, "size": 1,
         "units": 1, "location": 1, "country_of_origin": 1, "fabric_content": 1,
         "returned_at": 1, "returned_by_name": 1},
    ).sort("returned_at", -1).to_list(limit)
    return {
        "items": cajas,
        "total": len(cajas),
        "total_units": sum(int(c.get("units") or 0) for c in cajas),
        "staging": RETURN_STAGING,
    }
