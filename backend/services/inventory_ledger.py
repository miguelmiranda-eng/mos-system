"""Invariantes del libro mayor de inventario (WMS).

Punto ÚNICO que responde dos preguntas que hasta ahora cada endpoint de
movimiento respondía por su cuenta —y respondía distinto—:

  1. ¿QUÉ fila de `wms_inventory` representa este material en esta ubicación?
  2. ¿El movimiento conservó las unidades? (antes == después)

HISTORIA — por qué existe este módulo
─────────────────────────────────────
`wms_inventory` no tiene identidad canónica: el campo `sku` convive con dos
formatos incompatibles en la misma colección —compuesto ('CK001-PFD-M') y corto
('CK001')— y ningún índice único lo impide. Cada endpoint de movimiento elegía
un formato y buscaba la fila origen con `find_one({"sku": ...})`. Cuando el
formato elegido no coincidía con el de la fila existente, `find_one` devolvía
None, el descuento del origen se omitía EN SILENCIO (no había `else`, ni
excepción, ni log) y el destino se insertaba igual: el sistema creaba inventario
de la nada.

Ese defecto se "corrigió" dos veces cambiando el formato de la llave (compuesto
-> corto). Eso no lo arregló: lo movió de sitio. Antes fallaban las filas keyed
corto; después fallaban las keyed compuesto. Incidente confirmado 2026-07-21:
CK001/PFD/M en PS07-A25, 1,392 unidades fantasma; 36 grupos duplicados y ~6,950
unidades fantasma acumuladas system-wide antes de este módulo.

La corrección real es doble y está aquí:
  - `resolve_row` tolera AMBOS formatos, así que la fila siempre se encuentra.
  - Si aun así no se encuentra, o si hay más de una candidata, se levanta una
    excepción y el llamador ABORTA ANTES DE ESCRIBIR. Un movimiento que falla
    ruidosamente es infinitamente preferible a uno que inventa inventario en
    silencio.

La identidad lógica de una fila de inventario es `(style, color, size, location)`.
`sku` es un alias heredado, no una llave. Cuando el índice único de 2b esté en
producción, `resolve_row` no podrá devolver AmbiguousInventoryRow y este módulo
se podrá simplificar.

NOTA DE RENDIMIENTO: los campos de identidad están normalizados a MAYÚSCULAS
system-wide desde 2026-07-01, así que se usa match exacto (no regex 'i') para
apoyarse en los índices `sku_1_color_1_size_1_location_1` y
`style_1_color_1_size_1_location_1`. Un regex case-insensitive forzaría un
collection scan (ver `_ci_eq` en routers/wms.py).
"""


class LedgerError(Exception):
    """Base de los fallos de invariante del inventario."""


class InventoryRowNotFound(LedgerError):
    """No existe fila de inventario para un material en una ubicación.

    En el origen de un movimiento esto es SIEMPRE un error: si hay cajas
    físicas ahí, tiene que haber una fila que las respalde. Continuar sería
    duplicar el stock en el destino.
    """

    def __init__(self, material, location):
        self.material = material
        self.location = location
        super().__init__(f"Sin fila de inventario para {material} en {location}")


class AmbiguousInventoryRow(LedgerError):
    """Hay más de una fila para el mismo material en la misma ubicación.

    Es exactamente el daño que este módulo previene, ya materializado en datos
    viejos. Mover material desde una posición duplicada propaga el duplicado a
    la ubicación destino, así que se bloquea hasta reconciliar.
    """

    def __init__(self, material, location, rows):
        self.material = material
        self.location = location
        self.rows = rows
        super().__init__(
            f"{len(rows)} filas duplicadas para {material} en {location}"
        )


class ConservationViolation(LedgerError):
    """El movimiento no conservó las unidades: se creó o destruyó inventario.

    Detección post-escritura. Mientras no haya transacciones (requiere replica
    set), esto NO revierte el daño: lo hace visible y auditable en el instante
    en que ocurre, en lugar de descubrirlo semanas después en un conteo cíclico.
    """

    def __init__(self, before, after, context=None):
        self.before = before
        self.after = after
        self.delta = after - before
        self.context = context or {}
        super().__init__(
            f"Conservación violada: antes={before} después={after} delta={self.delta:+d}"
        )


def material_keys(style, sku):
    """Llaves candidatas para un material, sin duplicados y preservando orden.

    Un box trae 'style'='CK001' y 'sku'='CK001-PFD-M'; una fila de inventario
    puede estar keyed por cualquiera de las dos. Se buscan ambas.
    """
    keys = []
    for k in (style, sku):
        k = (k or "").strip()
        if k and k not in keys:
            keys.append(k)
    return keys


def row_query(style, sku, color, size, location):
    """Query que localiza la fila de inventario de un material en una ubicación,
    tolerando los dos formatos de `sku` que conviven en los datos."""
    keys = material_keys(style, sku)
    if not keys:
        raise ValueError("style/sku vacíos: no se puede identificar el material")
    return {
        "$or": [{"sku": {"$in": keys}}, {"style": {"$in": keys}}],
        "color": (color or "").strip(),
        "size": (size or "").strip(),
        "location": (location or "").strip(),
    }


def describe(style, sku, color, size):
    """Etiqueta legible del material, para mensajes de error al operador."""
    base = (style or sku or "?").strip()
    return "/".join([base] + [p for p in ((color or "").strip(), (size or "").strip()) if p])


async def resolve_row(db, style, sku, color, size, location, *, required):
    """Devuelve LA fila de inventario del material en la ubicación.

    - 0 filas y `required=True`  -> InventoryRowNotFound  (origen: abortar)
    - 0 filas y `required=False` -> None                  (destino: crear)
    - 1 fila                     -> la fila
    - >1 filas                   -> AmbiguousInventoryRow (abortar siempre)

    El llamador DEBE invocar esto para todos los buckets ANTES de escribir nada,
    para que un fallo deje la operación en cero cambios.
    """
    rows = await db.wms_inventory.find(row_query(style, sku, color, size, location)).to_list(10)
    material = describe(style, sku, color, size)
    if len(rows) > 1:
        raise AmbiguousInventoryRow(material, location, rows)
    if not rows:
        if required:
            raise InventoryRowNotFound(material, location)
        return None
    return rows[0]


async def physical_stock_at(db, style, sku, color, size, location):
    """Stock FÍSICO de un material en una ubicación, contado desde las cajas.

    Es la fuente de verdad para reconstruir una fila de inventario faltante:
    ~3.3% de las cajas quedaron huérfanas (existen físicamente pero ninguna fila
    las respalda), herencia de importaciones y scripts de reparación previos.
    Mover una caja huérfana creaba stock de la nada, porque no había fila origen
    que descontar.

    Cuenta TODAS las cajas del material en la ubicación, no sólo las que se van
    a mover: la fila debe reflejar la ubicación completa o el remanente quedaría
    sin respaldo.
    """
    keys = material_keys(style, sku)
    if not keys:
        return {"units": 0, "boxes": 0, "sample": None}
    query = {
        "$or": [{"sku": {"$in": keys}}, {"style": {"$in": keys}}],
        "color": (color or "").strip(),
        "size": (size or "").strip(),
        "location": (location or "").strip(),
    }
    boxes = await db.wms_boxes.find(query, {"_id": 0}).to_list(5000)
    return {
        "units": sum(int(b.get("units") or b.get("qty") or 0) for b in boxes),
        "boxes": len(boxes),
        "sample": boxes[0] if boxes else None,
    }


async def total_units(db, scopes):
    """Suma `units_on_hand` de todas las filas que cubren los scopes indicados.

    `scopes`: iterable de tuplas (style, sku, color, size, location).
    Se deduplica por (style, sku, color, size, location) para no contar dos
    veces el mismo material cuando varios buckets comparten ubicación.
    """
    seen = set()
    total = 0
    for style, sku, color, size, location in scopes:
        key = (style or "", sku or "", color or "", size or "", location or "")
        if key in seen:
            continue
        seen.add(key)
        rows = await db.wms_inventory.find(
            row_query(style, sku, color, size, location), {"units_on_hand": 1, "_id": 0}
        ).to_list(50)
        total += sum(int(r.get("units_on_hand") or 0) for r in rows)
    return total


def assert_conserved(before, after, context=None):
    """Ley de conservación: mover material no crea ni destruye unidades.

    Se verifica sobre el TOTAL de origen + destino, así que es indiferente a
    cómo se repartió entre ubicaciones. Es la red que atrapa la próxima variante
    de este defecto, la que todavía no conocemos.
    """
    if int(before) != int(after):
        raise ConservationViolation(int(before), int(after), context)
