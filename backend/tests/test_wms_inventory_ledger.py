"""Test de regresión — inventario duplicado por llave de SKU inconsistente.

INCIDENTE QUE BLINDA (2026-07-21, CK001/PFD/M en PS07-A25)
──────────────────────────────────────────────────────────
29 cajas (1,392 pzs) se movieron de PS07-A25 a NA08-C37..C40 y esa misma noche
regresaron. Al terminar, PS07-A25 tenía DOS filas de inventario activas para el
mismo material físico —una keyed 'CK001-PFD-M' y otra keyed 'CK001'—, ambas con
1,392 unidades: 1,392 unidades fantasma.

La causa: los endpoints de movimiento buscaban la fila origen con UN SOLO
formato de `sku`. Cuando no coincidía, `find_one` devolvía None, el descuento
del origen se omitía EN SILENCIO y el destino se creaba igual.

Ese defecto ya se había "corregido" DOS VECES cambiando el formato de la llave
(compuesto -> corto). Eso no lo arregló, lo movió de sitio: antes fallaban las
filas keyed corto, después las keyed compuesto. Por eso este test verifica los
DOS formatos en las dos direcciones — para que la tercera "corrección" que
vuelva a elegir un solo formato falle aquí y no en el almacén.

QUÉ CUBRE Y QUÉ NO
──────────────────
Cubre las invariantes de services/inventory_ledger.py, que es donde vive la
decisión que causó el incidente: qué fila representa un material y si el
movimiento conservó las unidades. Corre sin servidor, sin Mongo y sin red.

NO cubre el cableado HTTP de los tres endpoints (/boxes/relocate,
/move-location, /transit/relocate). Ese test de integración sigue pendiente y
va en el suite tests/test_wms_*.py, que hoy requiere backend levantado.

CÓMO SE CORRE
─────────────
    python backend/tests/test_wms_inventory_ledger.py     # sin dependencias
    pytest backend/tests/test_wms_inventory_ledger.py     # si hay pytest
"""
import asyncio
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from services.inventory_ledger import (  # noqa: E402
    AmbiguousInventoryRow,
    ConservationViolation,
    InventoryRowNotFound,
    assert_conserved,
    material_keys,
    physical_stock_at,
    resolve_row,
    row_query,
    total_units,
)


# ── Doble de prueba: Mongo en memoria, sólo los operadores que usa el ledger ──

def _matches(doc, query):
    for field, cond in query.items():
        if field == "$or":
            if not any(_matches(doc, sub) for sub in cond):
                return False
        elif isinstance(cond, dict) and "$in" in cond:
            if doc.get(field) not in cond["$in"]:
                return False
        elif doc.get(field, "") != cond:
            return False
    return True


class _Cursor:
    def __init__(self, docs):
        self._docs = docs

    async def to_list(self, n):
        return self._docs[:n]


class _Collection:
    def __init__(self, docs):
        self.docs = docs

    def find(self, query, projection=None):
        return _Cursor([d for d in self.docs if _matches(d, query)])


class FakeDB:
    def __init__(self, rows, boxes=None):
        self.wms_inventory = _Collection(rows)
        self.wms_boxes = _Collection(boxes or [])


def _row(sku, style, location, units, boxes=1, color="PFD", size="M"):
    return {"inventory_id": f"inv_{sku}_{location}", "sku": sku, "style": style,
            "color": color, "size": size, "location": location,
            "units_on_hand": units, "total_boxes": boxes}


# Datos reales del incidente: la caja BOX-004012 y la fila que la respaldaba.
BOX = {"style": "CK001", "sku": "CK001-PFD-M", "color": "PFD", "size": "M"}
ROW_COMPOSITE = _row("CK001-PFD-M", "CK001", "PS07-A25", 1392, 29)
ROW_SHORT = _row("CK001", "CK001", "PS07-A25", 1392, 29)


def _run(coro):
    return asyncio.run(coro)


# ── Llaves ────────────────────────────────────────────────────────────────────

def test_material_keys_incluye_ambos_formatos():
    assert material_keys("CK001", "CK001-PFD-M") == ["CK001", "CK001-PFD-M"]


def test_material_keys_deduplica_y_limpia():
    assert material_keys("CK001", "CK001") == ["CK001"]
    assert material_keys("  CK001 ", "") == ["CK001"]
    assert material_keys("", None) == []


def test_row_query_exige_identificar_el_material():
    try:
        row_query("", "", "PFD", "M", "PS07-A25")
    except ValueError:
        return
    raise AssertionError("row_query debe rechazar un material sin style ni sku")


def test_row_query_no_usa_regex_case_insensitive():
    """Un regex 'i' no usa índices y dispara un collection scan de wms_inventory
    (~24k docs) en cada movimiento. Los campos de identidad están normalizados a
    MAYÚSCULAS system-wide, así que el match exacto es equivalente y sí indexa."""
    q = row_query("CK001", "CK001-PFD-M", "PFD", "M", "PS07-A25")
    assert q["location"] == "PS07-A25"
    assert "$options" not in str(q), "el query no debe usar regex case-insensitive"


# ── EL DEFECTO: resolución de la fila origen ─────────────────────────────────

def test_caja_con_style_corto_encuentra_fila_keyed_compuesta():
    """Reproduce el incidente exacto. Antes: find_one({'sku': 'CK001'}) -> None
    -> origen sin descontar -> destino creado -> 1,392 unidades fantasma."""
    db = FakeDB([ROW_COMPOSITE])
    row = _run(resolve_row(db, BOX["style"], BOX["sku"], "PFD", "M", "PS07-A25", required=True))
    assert row is not None, "no encontró la fila origen: el bug de CK001 volvió"
    assert row["sku"] == "CK001-PFD-M"
    assert row["units_on_hand"] == 1392


def test_caja_con_sku_compuesto_encuentra_fila_keyed_corta():
    """La dirección inversa — la que rompió la 'corrección' anterior cuando se
    cambió la llave de compuesto a corto (caso 5000-AZALEA-XL en carros)."""
    db = FakeDB([_row("5000", "5000", "CARRO 6", 480, 10, color="AZALEA", size="XL")])
    row = _run(resolve_row(db, "5000", "5000-AZALEA-XL", "AZALEA", "XL", "CARRO 6", required=True))
    assert row is not None, "no encontró la fila keyed corta: regresión del fix de carros"
    assert row["units_on_hand"] == 480


def test_origen_inexistente_falla_ruidosamente():
    """La corrección de fondo: sin fila origen se ABORTA. Antes se continuaba en
    silencio y el destino se creaba igual, inventando inventario."""
    db = FakeDB([ROW_COMPOSITE])
    try:
        _run(resolve_row(db, "CK001", "CK001-PFD-M", "PFD", "M", "NA08-C37", required=True))
    except InventoryRowNotFound as e:
        assert e.location == "NA08-C37"
        return
    raise AssertionError("un origen sin fila de inventario debe abortar, no continuar")


def test_destino_inexistente_devuelve_none_sin_error():
    """En el destino la ausencia es normal: significa 'crear la fila'."""
    db = FakeDB([ROW_COMPOSITE])
    assert _run(resolve_row(db, "CK001", "CK001-PFD-M", "PFD", "M", "NA08-C37", required=False)) is None


def test_material_duplicado_bloquea_el_movimiento():
    """Estado real de PS07-A25 tras el incidente: dos filas del mismo material.
    Mover desde ahí propagaría el duplicado al destino, así que se bloquea."""
    db = FakeDB([ROW_COMPOSITE, ROW_SHORT])
    try:
        _run(resolve_row(db, "CK001", "CK001-PFD-M", "PFD", "M", "PS07-A25", required=True))
    except AmbiguousInventoryRow as e:
        assert len(e.rows) == 2
        return
    raise AssertionError("mover desde una ubicación duplicada debe bloquearse")


def test_query_consulta_el_campo_sku_no_solo_el_campo_style():
    """Fija que la rama `sku` del $or es load-bearing: fila cuyo campo `style`
    NO coincide con ninguna llave buscada, sólo su `sku`. Sin esa rama, esta
    fila sería invisible y el movimiento duplicaría el stock."""
    db = FakeDB([_row("CK001-PFD-M", "CK001-LEGACY", "PS07-A25", 1392, 29)])
    row = _run(resolve_row(db, "CK001", "CK001-PFD-M", "PFD", "M", "PS07-A25", required=True))
    assert row is not None, "se perdió la rama `sku` del query"


def test_query_consulta_el_campo_style_no_solo_el_campo_sku():
    """La rama espejo. Aplica a las ~598 cajas de wms_boxes que no traen `style`
    y a cualquier fila keyed con un `sku` que no coincide con el de la caja."""
    db = FakeDB([_row("SKU-LEGACY-9", "CK001", "PS07-A25", 1392, 29)])
    row = _run(resolve_row(db, "CK001", "CK001-PFD-M", "PFD", "M", "PS07-A25", required=True))
    assert row is not None, "se perdió la rama `style` del query"


def test_caja_sin_style_se_resuelve_por_sku():
    """598 cajas reales no tienen `style` (ej. BOX-021504, sku 'GT14406J1358')."""
    db = FakeDB([_row("GT14406J1358", "GT14406J1358", "PS01-A02", 240, 5, color="", size="")])
    row = _run(resolve_row(db, "", "GT14406J1358", "", "", "PS01-A02", required=True))
    assert row is not None and row["units_on_hand"] == 240


def test_no_confunde_materiales_distintos_en_la_misma_ubicacion():
    """La tolerancia de llave no debe volverse promiscua: otro color/talla en la
    misma ubicación es OTRO material y no debe resolverse ni sumarse."""
    db = FakeDB([
        ROW_COMPOSITE,
        _row("CK001-BLACK-M", "CK001", "PS07-A25", 500, 10, color="BLACK"),
        _row("CK001-PFD-L", "CK001", "PS07-A25", 300, 6, size="L"),
    ])
    row = _run(resolve_row(db, "CK001", "CK001-PFD-M", "PFD", "M", "PS07-A25", required=True))
    assert row["units_on_hand"] == 1392, "resolvió un material que no era"


# ── Ley de conservación ──────────────────────────────────────────────────────

def test_total_units_suma_ambos_formatos_en_la_ubicacion():
    """1392 + 1392 = 2784: exactamente lo que el sistema reportaba en PS07-A25
    contra 1,392 unidades físicas."""
    db = FakeDB([ROW_COMPOSITE, ROW_SHORT])
    total = _run(total_units(db, [("CK001", "CK001-PFD-M", "PFD", "M", "PS07-A25")]))
    assert total == 2784


def test_total_units_no_cuenta_dos_veces_el_mismo_scope():
    db = FakeDB([ROW_COMPOSITE])
    scopes = [("CK001", "CK001-PFD-M", "PFD", "M", "PS07-A25")] * 3
    assert _run(total_units(db, scopes)) == 1392


def test_movimiento_conservado_pasa():
    assert_conserved(1392, 1392, {"op": "ida y vuelta"})


def test_movimiento_que_inventa_inventario_falla():
    """El delta exacto del incidente: +1392 unidades creadas de la nada."""
    try:
        assert_conserved(1392, 2784, {"op": "boxes_relocate", "to": "NA08-C37"})
    except ConservationViolation as e:
        assert e.delta == 1392
        return
    raise AssertionError("crear 1,392 unidades debe violar la conservación")


def test_movimiento_que_destruye_inventario_falla():
    """La conservación protege en las dos direcciones: perder stock en un
    movimiento es igual de grave que inventarlo."""
    try:
        assert_conserved(1392, 1008, {"op": "move_location"})
    except ConservationViolation as e:
        assert e.delta == -384
        return
    raise AssertionError("destruir unidades debe violar la conservación")


# ── Reconciliación de cajas huérfanas (~3.3% del universo de cajas) ──────────

def _box(box_id, location, units=48, style="CK001", sku="CK001-PFD-M", color="PFD", size="M"):
    return {"box_id": box_id, "style": style, "sku": sku, "color": color,
            "size": size, "location": location, "units": units}


def test_stock_fisico_cuenta_las_cajas_del_material():
    """Fuente de verdad para reconstruir una fila faltante: las cajas reales."""
    db = FakeDB([], [_box(f"BOX-{i}", "PS07-A25") for i in range(29)])
    stock = _run(physical_stock_at(db, "CK001", "CK001-PFD-M", "PFD", "M", "PS07-A25"))
    assert stock["boxes"] == 29
    assert stock["units"] == 1392


def test_stock_fisico_cuenta_la_ubicacion_COMPLETA_no_solo_lo_que_se_mueve():
    """Si la fila se reconstruyera sólo con las cajas que se van a mover, el
    remanente de la ubicación quedaría otra vez sin respaldo."""
    db = FakeDB([], [_box(f"BOX-{i}", "PS07-A25") for i in range(10)])
    stock = _run(physical_stock_at(db, "CK001", "CK001-PFD-M", "PFD", "M", "PS07-A25"))
    assert stock["boxes"] == 10, "debe contar todas las cajas de la ubicación"


def test_stock_fisico_tolera_ambos_formatos_de_sku():
    db = FakeDB([], [_box("BOX-1", "CARRO 6", 48, style="", sku="GT14406J1358",
                          color="", size="")])
    stock = _run(physical_stock_at(db, "", "GT14406J1358", "", "", "CARRO 6"))
    assert stock["boxes"] == 1 and stock["units"] == 48


def test_stock_fisico_ignora_otras_ubicaciones_y_otros_materiales():
    db = FakeDB([], [
        _box("BOX-1", "PS07-A25"),
        _box("BOX-2", "NA08-C37"),                 # otra ubicación
        _box("BOX-3", "PS07-A25", color="BLACK"),  # otro color
    ])
    stock = _run(physical_stock_at(db, "CK001", "CK001-PFD-M", "PFD", "M", "PS07-A25"))
    assert stock["boxes"] == 1 and stock["units"] == 48


def test_sin_cajas_fisicas_no_hay_nada_que_reconciliar():
    """Límite de la auto-reconciliación: si tampoco hay cajas, el endpoint debe
    abortar con 409 en vez de inventar una fila."""
    db = FakeDB([], [])
    stock = _run(physical_stock_at(db, "CK001", "CK001-PFD-M", "PFD", "M", "PS07-A25"))
    assert stock["boxes"] == 0 and stock["sample"] is None


def test_reconciliacion_no_infla_el_inventario():
    """La fila reconstruida debe igualar exactamente el stock físico: reconciliar
    es registrar lo que ya está, no dar de alta material nuevo."""
    cajas = [_box(f"BOX-{i}", "PS07-A25") for i in range(29)]
    db = FakeDB([], cajas)
    stock = _run(physical_stock_at(db, "CK001", "CK001-PFD-M", "PFD", "M", "PS07-A25"))
    fila = _row("CK001-PFD-M", "CK001", "PS07-A25", stock["units"], stock["boxes"])
    db.wms_inventory.docs.append(fila)
    total = _run(total_units(db, [("CK001", "CK001-PFD-M", "PFD", "M", "PS07-A25")]))
    assert total == sum(b["units"] for b in cajas) == 1392


# ── Escenario completo: ida y vuelta con formatos mezclados ──────────────────

def test_ida_y_vuelta_completa_conserva_el_total():
    """Simula la secuencia real del incidente sobre el estado del inventario:
    PS07-A25 -> NA08-C37..C40 -> PS07-A25, con la fila origen keyed compuesta y
    las cajas trayendo el style corto. Con la resolución tolerante, el origen SÍ
    se encuentra en cada tramo y el total nunca cambia."""
    lotes = [("NA08-C37", 8, 384), ("NA08-C38", 8, 384), ("NA08-C39", 4, 192), ("NA08-C40", 9, 432)]
    rows = [dict(ROW_COMPOSITE)]
    db = FakeDB(rows)
    scopes = [("CK001", "CK001-PFD-M", "PFD", "M", loc)
              for loc in ["PS07-A25"] + [l for l, _, _ in lotes]]

    inicial = _run(total_units(db, scopes))
    assert inicial == 1392

    # Ida: cada lote sale de PS07-A25 hacia su bin de NA08.
    for destino, cajas, unidades in lotes:
        origen = _run(resolve_row(db, "CK001", "CK001-PFD-M", "PFD", "M", "PS07-A25", required=True))
        assert origen is not None, f"origen no encontrado al mover a {destino}"
        origen["units_on_hand"] -= unidades
        origen["total_boxes"] -= cajas
        if origen["units_on_hand"] == 0:
            rows.remove(origen)
        destino_row = _run(resolve_row(db, "CK001", "CK001-PFD-M", "PFD", "M", destino, required=False))
        assert destino_row is None
        rows.append(_row(origen["sku"], "CK001", destino, unidades, cajas))
        assert _run(total_units(db, scopes)) == inicial, f"descuadre al mover a {destino}"

    # Vuelta: todo regresa a PS07-A25 y debe FUSIONARSE, no crear otra fila.
    for destino, cajas, unidades in lotes:
        origen = _run(resolve_row(db, "CK001", "CK001-PFD-M", "PFD", "M", destino, required=True))
        rows.remove(origen)
        vuelta = _run(resolve_row(db, "CK001", "CK001-PFD-M", "PFD", "M", "PS07-A25", required=False))
        if vuelta:
            vuelta["units_on_hand"] += unidades
            vuelta["total_boxes"] += cajas
        else:
            rows.append(_row(origen["sku"], "CK001", "PS07-A25", unidades, cajas))
        assert _run(total_units(db, scopes)) == inicial, f"descuadre al regresar de {destino}"

    final = [r for r in rows if r["location"] == "PS07-A25"]
    assert len(final) == 1, f"quedaron {len(final)} filas en PS07-A25: el duplicado volvió"
    assert final[0]["units_on_hand"] == 1392
    assert final[0]["total_boxes"] == 29
    assert _run(total_units(db, scopes)) == 1392


if __name__ == "__main__":
    fallos = []
    pruebas = [(n, f) for n, f in sorted(globals().items())
               if n.startswith("test_") and callable(f)]
    for nombre, fn in pruebas:
        try:
            fn()
            print(f"  PASS  {nombre}")
        except Exception as exc:  # noqa: BLE001
            fallos.append((nombre, exc))
            print(f"  FAIL  {nombre}: {exc}")
    print(f"\n{len(pruebas) - len(fallos)}/{len(pruebas)} pruebas OK")
    sys.exit(1 if fallos else 0)
