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

LA IDENTIDAD REAL INCLUYE EL LOTE
─────────────────────────────────
`sku` es un alias heredado, no una llave. Pero `(style, color, size, location)`
TAMPOCO alcanza: recepción e importación separan deliberadamente los lotes por
país de origen y composición —*"Wider key so two batches of the same SKU with
different fabric/COO stay as separate inventory rows"*— y los movimientos lo
ignoraban, fusionando lotes que debían quedar separados.

Eso no es cosmético: en confección importada a EUA el país de origen es
requisito legal de etiquetado. Verificado el 2026-07-22: de 41 ubicaciones con
varias filas del mismo style/color/size, **32 son lotes legítimos** (ej.
`18000/SAND/2X @ CARRO 262` = HONDURAS 1,188u/33 cajas + NICARAGUA 1,908u/53
cajas, cuadrando exacto contra las cajas físicas) y sólo 9 son duplicados.

    Identidad = (style|sku, color, size, location) + lote (COO, composición)

La composición se compara CANONICALIZADA: los datos traen 83 escrituras
distintas ('58%C 42%P', '58% COTTON 42% POLYESTER', '100% RING-SPUN COMBED
COTTON'…) para 47 composiciones reales. Comparar el texto crudo fragmentaría
lotes idénticos.

El filtro contra Mongo se mantiene ANCHO (indexado) y la desambiguación por lote
ocurre en memoria sobre un puñado de documentos: así no hace falta ni migrar
datos ni añadir campos derivados.

NOTA DE RENDIMIENTO: los campos de identidad están normalizados a MAYÚSCULAS
system-wide desde 2026-07-01, así que se usa match exacto (no regex 'i') para
apoyarse en los índices `sku_1_color_1_size_1_location_1` y
`style_1_color_1_size_1_location_1`. Un regex case-insensitive forzaría un
collection scan (ver `_ci_eq` en routers/wms.py).
"""


import re

# ── Canonicalización de la composición ───────────────────────────────────────
# 83 escrituras distintas en los datos para 47 composiciones reales. Comparar el
# texto crudo separaría lotes idénticos; comparar el canónico los une SIN perder
# el texto original, que es el que va en la etiqueta del cliente.
_FIBRAS = ["COTTON", "POLYESTER", "RAYON", "SPANDEX", "ELASTANE", "LYCRA", "MODAL",
           "LINEN", "NYLON", "ACRYLIC", "WOOL", "VISCOSE", "POLY", "ALGODON", "POLIESTER"]
_SINONIMOS = {"POLY": "POLYESTER", "POLIESTER": "POLYESTER", "ALGODON": "COTTON",
              "ELASTANE": "SPANDEX", "LYCRA": "SPANDEX", "VISCOSE": "RAYON",
              "C": "COTTON", "P": "POLYESTER", "S": "SPANDEX", "R": "RAYON"}


def canon_fabric(texto):
    """Composición canónica: pares (porcentaje, fibra) ordenados, sin calificativos.

    '58%C 42%P', '58% COTTON 42% POLYESTER'        -> '58%COTTON 42%POLYESTER'
    '100% RING-SPUN COMBED COTTON', '100% COTTON'  -> '100%COTTON'

    Los calificativos (COMBED, RING-SPUN, PRE-SHRUNK…) se descartan: describen el
    hilado, no la composición, y no distinguen un lote de otro.
    """
    if not texto or not texto.strip():
        return ""
    t = re.sub(r"[.\-_/,]", " ", texto.upper())
    t = re.sub(r"\s+", " ", t).strip()
    marcas = [(m.end(), m.start(), int(m.group(1))) for m in re.finditer(r"(\d{1,3})\s*%", t)]
    if not marcas:
        return t
    pares = []
    for i, (fin, _ini, pct) in enumerate(marcas):
        seg = t[fin:marcas[i + 1][1]] if i + 1 < len(marcas) else t[fin:]
        fibra = next((_SINONIMOS.get(f, f) for f in _FIBRAS if f in seg), None)
        if fibra is None:
            tok = seg.strip().split(" ")[0] if seg.strip() else ""
            fibra = _SINONIMOS.get(tok, tok)
        pares.append((pct, fibra))
    return " ".join(f"{p}%{f}" for p, f in sorted(pares, reverse=True))


def canon_coo(texto):
    """País de origen normalizado para comparación."""
    return re.sub(r"\s+", " ", (texto or "").strip().upper())


def batch_signature(coo, fabric):
    """Firma del lote dentro de una ubicación. `('', '')` = lote sin metadatos."""
    return (canon_coo(coo), canon_fabric(fabric))


def row_signature(row):
    return batch_signature(row.get("country_of_origin") or row.get("coo"),
                           row.get("fabric_content"))


# Campos del LOTE que TODA consulta de cajas destinada a firmarse debe traer.
# Bug del 2026-07-23 (/move-location): una proyección hecha a mano omitió estos
# campos, la firma salió ('','') y nunca casó con la del renglón — el renglón
# del origen sobrevivió con sus unidades: material duplicado en papel en cada
# "mover todo el contenido". Si necesitas recortar una proyección de cajas,
# parte de box_projection() y este bug no puede volver.
LOTE_FIELDS = ("country_of_origin", "coo", "fabric_content")


def box_projection(*extra):
    """Proyección mínima para cajas que van a compararse por lote (firma)."""
    proj = {"_id": 0, "box_id": 1, "style": 1, "sku": 1, "color": 1, "size": 1,
            "units": 1, "qty": 1, "location": 1}
    for f in (*LOTE_FIELDS, *extra):
        proj[f] = 1
    return proj


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


async def resolve_row(db, style, sku, color, size, location, *, required,
                      coo=None, fabric=None):
    """Devuelve LA fila de inventario del material+lote en la ubicación.

    El filtro contra Mongo es ancho (usa los índices); la desambiguación por lote
    ocurre aquí, en memoria, sobre las pocas candidatas de esa ubicación.

    Con `coo`/`fabric` (el llamador conoce el lote — normalmente los trae la caja):
      - 1 candidata con esa firma  -> la fila
      - varias con la MISMA firma  -> AmbiguousInventoryRow (duplicado real)
      - ninguna con esa firma      -> es un lote nuevo aquí: None, o
                                      InventoryRowNotFound si `required`
      - firma vacía y 1 sola candidata -> esa (fallback flexible, para llamadores
                                      que no traen metadatos de lote)

    Sin `coo`/`fabric` (el llamador no sabe el lote):
      - 1 candidata  -> esa
      - varias       -> AmbiguousInventoryRow: adivinar el lote sería peor que fallar

    El llamador DEBE invocar esto para todos los buckets ANTES de escribir nada,
    para que un fallo deje la operación en cero cambios.
    """
    rows = await db.wms_inventory.find(row_query(style, sku, color, size, location)).to_list(20)
    material = describe(style, sku, color, size)

    if not rows:
        if required:
            raise InventoryRowNotFound(material, location)
        return None

    conoce_lote = coo is not None or fabric is not None
    if conoce_lote:
        firma = batch_signature(coo, fabric)
        exactas = [r for r in rows if row_signature(r) == firma]
        if len(exactas) > 1:
            raise AmbiguousInventoryRow(_con_lote(material, firma), location, exactas)
        if len(exactas) == 1:
            return exactas[0]
        # Sin coincidencia de lote. Si no traemos metadatos y hay una sola
        # candidata, es la de siempre (mismo fallback flexible que usa el ajuste
        # manual para no obligar al operador a recapturar COO/composición).
        if firma == ("", "") and len(rows) == 1:
            return rows[0]
        if required:
            raise InventoryRowNotFound(_con_lote(material, firma), location)
        return None

    if len(rows) > 1:
        raise AmbiguousInventoryRow(material, location, rows)
    return rows[0]


def _con_lote(material, firma):
    lote = " · ".join(p for p in firma if p)
    return f"{material} ({lote})" if lote else material


async def physical_stock_at(db, style, sku, color, size, location, *, coo=None, fabric=None):
    """Stock FÍSICO de un material en una ubicación, contado desde las cajas.

    Es la fuente de verdad para reconstruir una fila de inventario faltante:
    ~3.3% de las cajas quedaron huérfanas (existen físicamente pero ninguna fila
    las respalda), herencia de importaciones y scripts de reparación previos.
    Mover una caja huérfana creaba stock de la nada, porque no había fila origen
    que descontar.

    Cuenta TODAS las cajas del material en la ubicación, no sólo las que se van
    a mover: la fila debe reflejar la ubicación completa o el remanente quedaría
    sin respaldo. Si se indica el lote (`coo`/`fabric`), cuenta SÓLO las cajas de
    ese lote — mezclar orígenes en una fila destruiría la trazabilidad.
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
    if coo is not None or fabric is not None:
        firma = batch_signature(coo, fabric)
        del_lote = [b for b in boxes if row_signature(b) == firma]
        # Si la firma viene vacía (caja sin metadatos) no filtramos: no hay lote
        # que distinguir y filtrar dejaría fuera todas las cajas etiquetadas.
        if del_lote or firma != ("", ""):
            boxes = del_lote
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
