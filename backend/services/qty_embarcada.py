"""Cantidad embarcada por orden (Tarea 4.1 del plan API MOS↔Command).

`qty_shipped` NO existe como campo ni contador propio: se DERIVA de la
bitácora del WMS en cada lectura. Lección del sistema ("la caja manda"): un
contador paralelo se desincroniza en silencio; la bitácora de movimientos es
la única fuente que cuadra con lo que físicamente salió.

Dos fuentes, sin doble conteo:

  1. `wms_movements` type=`pick_deduction` — cada descuento de pick registra
     `details.order_number` y `details.qty` (unidades que salieron del
     inventario hacia esa orden, cajas + saldo sin caja). No existe un
     movimiento inverso del pick, así que el neto es la suma directa.
  2. `wms_shipments.total_units` — el embarque directo (POST
     /api/wms/movements) descuenta ahí mismo el inventario de las cajas que
     NO pasaron por pick y guarda el total en el documento del embarque. Las
     cajas que sí se pickearon llegan al embarque ya en 0 unidades, por lo
     que no aportan doble.

`wms_shipments.order_id` guarda a veces el order_number y a veces el order_id
interno (el propio endpoint actualiza la orden con $or de ambos): aquí se
casan los dos. Los datos históricos traen tipos sucios (números como texto y
viceversa), así que las sumas convierten con $convert(onError=0) y las llaves
se buscan también en su forma numérica.
"""

_IDX_OK = False


def entero_o_none(v):
    """Lectura numérica tolerante a la mugre histórica ('480', 480.0, '', None).
    None cuando el valor no es un número — jamás se inventa un cero."""
    try:
        return int(float(str(v).strip()))
    except (TypeError, ValueError):
        return None


async def _ensure_indexes(db):
    """Índices perezosos (mismo patrón que wms.py): la derivación filtra
    wms_movements por type + details.order_number y wms_shipments por
    order_id; sin índice cada lectura sería un barrido completo de la
    bitácora. create_index es idempotente."""
    global _IDX_OK
    if _IDX_OK:
        return
    try:
        await db.wms_movements.create_index(
            [("type", 1), ("details.order_number", 1)], name="by_type_order")
        await db.wms_shipments.create_index([("order_id", 1)], name="by_order")
    except Exception:
        # Ya existe con otra definición o Mongo no cooperó: la consulta
        # funciona igual (más lenta); no es motivo para tumbar la respuesta.
        pass
    _IDX_OK = True


def _suma_entera(campo):
    return {"$sum": {"$convert": {"input": campo, "to": "int",
                                  "onError": 0, "onNull": 0}}}


def _variantes(llaves):
    """La bitácora vieja guarda números de orden como string o como int:
    se buscan ambas formas."""
    out = list(llaves)
    out.extend(int(k) for k in llaves if isinstance(k, str) and k.isdigit())
    return out


async def qty_embarcada_por_orden(db, ordenes):
    """Unidades embarcadas por orden, derivadas de la bitácora del WMS.

    `ordenes`: iterable de dicts con `order_number` (y `order_id` cuando se
    conoce, para casar los embarques directos guardados por id interno).
    Devuelve {order_number: unidades}, con 0 para las órdenes sin salidas
    registradas.
    """
    numeros = []
    numero_por_llave = {}   # order_number u order_id -> order_number
    for o in ordenes or []:
        num = str((o or {}).get("order_number") or "").strip()
        if not num:
            continue
        if num not in numero_por_llave:
            numeros.append(num)
            numero_por_llave[num] = num
        oid = str((o or {}).get("order_id") or "").strip()
        if oid:
            numero_por_llave.setdefault(oid, num)
    if not numeros:
        return {}

    await _ensure_indexes(db)
    embarcado = {n: 0 for n in numeros}

    picks = await db.wms_movements.aggregate([
        {"$match": {"type": "pick_deduction",
                    "details.order_number": {"$in": _variantes(numeros)}}},
        {"$group": {"_id": "$details.order_number",
                    "qty": _suma_entera("$details.qty")}},
    ]).to_list(None)
    for g in picks:
        num = numero_por_llave.get(str(g.get("_id")))
        if num is not None:
            embarcado[num] += int(g.get("qty") or 0)

    ships = await db.wms_shipments.aggregate([
        {"$match": {"order_id": {"$in": _variantes(list(numero_por_llave))}}},
        {"$group": {"_id": "$order_id",
                    "qty": _suma_entera("$total_units")}},
    ]).to_list(None)
    for g in ships:
        num = numero_por_llave.get(str(g.get("_id")))
        if num is not None:
            embarcado[num] += int(g.get("qty") or 0)

    return embarcado


async def qty_embarcada(db, orden):
    """Atajo para una sola orden (dict con order_number y, si se tiene,
    order_id). Devuelve el entero de unidades embarcadas (0 sin salidas)."""
    num = str((orden or {}).get("order_number") or "").strip()
    res = await qty_embarcada_por_orden(db, [orden or {}])
    return res.get(num, 0)
