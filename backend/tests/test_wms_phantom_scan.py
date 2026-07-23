"""Tests de services/phantom_scan.py — la comparación cajas-vs-renglones que
alimenta la pestaña Stock Fantasma del módulo de Conciliación.

INCIDENTE QUE BLINDA (2026-07-23, NA03-C20 / NA04-B21 / RP01-C37)
─────────────────────────────────────────────────────────────────
El piso reportó "el sistema dice que hay 2 cajas pero la ubicación está vacía".
Eran cajas de papel: el FIFO viejo vació el renglón con aritmética pero nunca
eligió esas cajas, que quedaron "llenas" en wms_boxes semanas después de que el
material salió. La dirección inversa (renglones con unidades sin caja que las
respalde) es el fantasma clásico de los imports de Excel. Este módulo detecta
LAS DOS direcciones más las cajas sin identidad, y estos tests fijan esa
clasificación.

Función pura: corre sin servidor, sin Mongo y sin red.

CÓMO SE CORRE
─────────────
    python backend/tests/test_wms_phantom_scan.py     # sin dependencias
    pytest backend/tests/test_wms_phantom_scan.py     # si hay pytest
"""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from services.phantom_scan import (  # noqa: E402
    SIN_IDENTIFICAR,
    compute_phantom_items,
    es_transito,
    phantom_id,
)


def _box(loc, style, units, color="NAVY", size="L", coo="HONDURAS",
         fabric="100% COTTON", box_id="LPN-X"):
    return {"location": loc, "style": style, "color": color, "size": size,
            "units": units, "country_of_origin": coo, "fabric_content": fabric,
            "box_id": box_id}


def _row(loc, style, units, color="NAVY", size="L", coo="HONDURAS",
         fabric="100% COTTON"):
    return {"location": loc, "style": style, "color": color, "size": size,
            "units_on_hand": units, "country_of_origin": coo,
            "fabric_content": fabric}


def test_cuadrado_no_reporta_nada():
    items = compute_phantom_items(
        [_box("NA01-A01", "5000", 72), _box("NA01-A01", "5000", 72)],
        [_row("NA01-A01", "5000", 144)])
    assert items == [], f"base cuadrada generó fantasmas: {items}"


def test_cajas_de_papel_el_caso_na03_c20():
    # El caso canónico: renglón en 0, dos cajas de papel con 60u + 71u.
    items = compute_phantom_items(
        [_box("NA03-C20", "5000", 60, box_id="LPN7079CDEA1DDD"),
         _box("NA03-C20", "5000", 71, box_id="LPN756ED59E653C")],
        [_row("NA03-C20", "5000", 0)])
    assert len(items) == 1
    it = items[0]
    assert it["tipo"] == "cajas_de_papel"
    assert it["units_renglon"] == 0 and it["units_cajas"] == 131
    assert it["delta"] == 131 and it["cajas"] == 2
    assert set(it["box_ids"]) == {"LPN7079CDEA1DDD", "LPN756ED59E653C"}


def test_cajas_sin_renglon_tambien_son_de_papel():
    # Ni siquiera hay renglón: mismo tipo, todo en duda.
    items = compute_phantom_items([_box("RP01-C37", "5000", 72)], [])
    assert len(items) == 1
    assert items[0]["tipo"] == "cajas_de_papel"
    assert items[0]["delta"] == 72


def test_saldo_sin_cajas_el_fantasma_clasico():
    # Renglón con unidades y ninguna caja: el clásico del import de Excel.
    items = compute_phantom_items([], [_row("CARRO 417", "CLASSIC TEE", 2250)])
    assert len(items) == 1
    it = items[0]
    assert it["tipo"] == "saldo_sin_cajas"
    assert it["delta"] == 2250 and it["units_cajas"] == 0
    assert it["transito"] is True


def test_descuadre_parcial_cae_del_lado_que_sobra():
    # 3 cajas (216u) vs renglón de 300: faltan 84 de papel -> saldo_sin_cajas.
    items = compute_phantom_items(
        [_box("PS02-A27", "5000", 72, box_id=f"B{i}") for i in range(3)],
        [_row("PS02-A27", "5000", 300)])
    assert len(items) == 1
    assert items[0]["tipo"] == "saldo_sin_cajas"
    assert items[0]["delta"] == 84


def test_transito_no_reporta_cajas_sin_renglon():
    # Cajas en un CARRO sin renglón = estado normal (recibido al carro, aún sin
    # putaway). NO es fantasma. Pero en un rack sí lo sería (caso anterior).
    items = compute_phantom_items([_box("CARRO 73", "5000", 72)], [])
    assert items == [], f"cajas en tránsito reportadas como fantasma: {items}"
    assert es_transito("CARRO 73") and es_transito("UBICACION TEMPORAL")
    assert not es_transito("NA03-C20")


def test_lotes_distintos_no_se_mezclan():
    # Dos países en la misma ubicación = 2 renglones LEGÍTIMOS (aduanas EUA).
    # Si las cajas son de HAITI y el renglón de HONDURAS, son DOS fantasmas
    # (uno por dirección), no un match.
    items = compute_phantom_items(
        [_box("NA05-B10", "5000", 144, coo="HAITI")],
        [_row("NA05-B10", "5000", 144, coo="HONDURAS")])
    tipos = sorted(i["tipo"] for i in items)
    assert tipos == ["cajas_de_papel", "saldo_sin_cajas"], f"lotes mezclados: {items}"


def test_composicion_canonicaliza():
    # '100%C' y '100% COTTON' son el MISMO lote (canon_fabric) -> cuadra, cero items.
    items = compute_phantom_items(
        [_box("NA05-B11", "5000", 100, fabric="100%C")],
        [_row("NA05-B11", "5000", 100, fabric="100% COTTON")])
    assert items == [], f"canonicalización de composición falló: {items}"


def test_sin_identidad_placeholder_y_vacio():
    # Las cajas del PDA nacen con "(SIN IDENTIFICAR)"; las de import viejo con
    # style vacío. Ambas van al mismo bucket por ubicación.
    items = compute_phantom_items(
        [_box("PS04-A13", SIN_IDENTIFICAR, 72, box_id="BOX-005698"),
         _box("PS04-A13", "", 72, box_id="BOX-002670"),
         _box("PS04-A13", SIN_IDENTIFICAR, 0, box_id="BOX-005912")],  # en 0: fuera
        [])
    assert len(items) == 1
    it = items[0]
    assert it["tipo"] == "sin_identidad"
    assert it["cajas"] == 2 and it["delta"] == 144
    assert "BOX-005912" not in it["box_ids"]


def test_phantom_id_estable_para_conservar_registro():
    # El id es determinista por llave: el mismo fantasma conserva su `registro`
    # a través de escaneos sucesivos (upsert), y normaliza mayúsculas/espacios.
    a = phantom_id("NA03-C20", "cajas_de_papel", "5000", "NAVY", "L", "HONDURAS", "100% COTTON")
    b = phantom_id("na03-c20 ", "cajas_de_papel", " 5000", "navy", "l", "HONDURAS", "100% COTTON")
    c = phantom_id("NA03-C20", "saldo_sin_cajas", "5000", "NAVY", "L", "HONDURAS", "100% COTTON")
    assert a == b and a != c


def test_orden_por_unidades_en_duda():
    items = compute_phantom_items(
        [_box("L1", "5000", 10, box_id="B1"), _box("L2", "3001", 500, box_id="B2")],
        [])
    assert [i["delta"] for i in items] == [500, 10]


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
