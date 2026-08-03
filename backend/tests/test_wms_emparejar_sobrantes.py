"""El reescritor no debe DUPLICAR papel al reetiquetar un lote.

QUE PROTEGE
───────────
_reproject_material_rows reconstruye el resumen de un material desde sus cajas.
Cuando un renglon se queda sin cajas Y hay un lote fisico sin renglon, casi
siempre son LA MISMA COSA: el renglon con el pais o la composicion mal puestos.
Reetiquetarlo conserva su identidad; crear uno nuevo y dejar el viejo vivo
DUPLICA el papel.

Ese emparejamiento solo existia para el caso exacto 1 sobrante <-> 1 faltante.
Con 1 sobrante y 2 faltantes se creaban las dos filas y la vieja sobrevivia.
Medido en produccion el 2026-08-03: 503 celdas / 338,006 unidades con ese
patron. Caso canonico RP10-A14: renglon REPUBLICA DOMINICANA 2,232u contra
cajas HAITI 2,232u — mismo material, misma cantidad, solo el pais distinto.

La regla nueva empareja por CANTIDAD EXACTA, pero SOLO cuando la
correspondencia es unica en ambos sentidos. Ante un empate no se adivina:
equivocar el pais es dato aduanal incorrecto, peor que mandar a conteo.

    python backend/tests/test_wms_emparejar_sobrantes.py
"""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

# Import directo del modulo sin arrastrar FastAPI/Mongo: se lee el archivo y se
# extrae solo la funcion pura, que no depende de nada del router.
import ast
import types

_RUTA = os.path.join(os.path.dirname(__file__), "..", "routers", "wms.py")
_arbol = ast.parse(open(_RUTA, encoding="utf-8").read())
_fn = next(n for n in _arbol.body
           if isinstance(n, ast.FunctionDef) and n.name == "_emparejar_sobrantes")
_mod = types.ModuleType("aislado")
exec(compile(ast.Module(body=[_fn], type_ignores=[]), "<wms>", "exec"), _mod.__dict__)
emparejar = _mod._emparejar_sobrantes


def ren(units, coo="", inv_id=None):
    return {"units_on_hand": units, "country_of_origin": coo,
            "inventory_id": inv_id or f"inv_{coo or 'x'}_{units}"}


def lote(units, boxes=1):
    return {"units": units, "boxes": boxes, "sample": {}, "ids": []}


def test_uno_a_uno_se_empareja():
    """Comportamiento historico: 1 sobrante y 1 faltante son ese par."""
    s = [ren(100, "HAITI")]
    f = {("NICARAGUA", "100%COTTON"): lote(100)}
    parejas, ls, lf = emparejar(s, f)
    assert len(parejas) == 1 and not ls and not lf


def test_uno_a_uno_empareja_aunque_la_cantidad_NO_cuadre():
    """La regla 1:1 no exige que las unidades coincidan: el recalculo desde las
    cajas es justamente lo que corrige la cantidad."""
    s = [ren(80, "HAITI")]
    f = {("NICARAGUA", "100%COTTON"): lote(100)}
    parejas, ls, lf = emparejar(s, f)
    assert len(parejas) == 1 and parejas[0][2]["units"] == 100


def test_EL_BUG_un_sobrante_y_dos_faltantes():
    """RP10-A14. Antes esto creaba 2 filas y dejaba viva la vieja -> papel
    duplicado. Ahora la cantidad exacta identifica cual es cual."""
    s = [ren(2232, "REPUBLICA DOMINICANA")]
    f = {("HAITI", "100%COTTON"): lote(2232, 31),
         ("PAKISTAN", "100%COTTON"): lote(325, 5)}
    parejas, ls, lf = emparejar(s, f)
    assert len(parejas) == 1, parejas
    assert parejas[0][1][0] == "HAITI"          # casó con el de 2,232
    assert not ls                                # el sobrante quedó consumido
    assert list(lf) == [("PAKISTAN", "100%COTTON")]   # el otro lote sí se crea


def test_empate_de_cantidades_NO_adivina():
    """Dos sobrantes de 100 y dos lotes de 100: no hay forma de saber cual es
    cual. Se deja todo libre -> conteo fisico, no un pais inventado."""
    s = [ren(100, "HAITI", "a"), ren(100, "PAKISTAN", "b")]
    f = {("NICARAGUA", "X"): lote(100), ("MEXICO", "Y"): lote(100)}
    parejas, ls, lf = emparejar(s, f)
    assert parejas == []
    assert len(ls) == 2 and len(lf) == 2


def test_empate_solo_del_lado_de_los_lotes_NO_adivina():
    s = [ren(100, "HAITI")]
    f = {("NICARAGUA", "X"): lote(100), ("MEXICO", "Y"): lote(100)}
    parejas, ls, lf = emparejar(s, f)
    assert parejas == []
    assert len(ls) == 1 and len(lf) == 2


def test_sin_cantidad_coincidente_no_empareja():
    s = [ren(100, "HAITI", "a"), ren(50, "PAKISTAN", "b")]
    f = {("NICARAGUA", "X"): lote(70), ("MEXICO", "Y"): lote(30)}
    parejas, ls, lf = emparejar(s, f)
    assert parejas == []
    assert len(ls) == 2 and len(lf) == 2


def test_varias_parejas_independientes():
    """Dos sobrantes con cantidades distintas casan cada uno con su lote."""
    s = [ren(2232, "REPUBLICA DOMINICANA", "a"), ren(325, "HONDURAS", "b")]
    f = {("HAITI", "X"): lote(2232), ("NICARAGUA", "Y"): lote(325)}
    parejas, ls, lf = emparejar(s, f)
    assert len(parejas) == 2
    assert not ls and not lf
    por_u = {p[2]["units"]: p[1][0] for p in parejas}
    assert por_u == {2232: "HAITI", 325: "NICARAGUA"}


def test_solo_sobrantes_no_inventa_parejas():
    s = [ren(100, "HAITI"), ren(200, "PAKISTAN")]
    parejas, ls, lf = emparejar(s, {})
    assert parejas == [] and len(ls) == 2 and lf == {}


def test_solo_faltantes_no_inventa_parejas():
    f = {("HAITI", "X"): lote(100), ("NICARAGUA", "Y"): lote(200)}
    parejas, ls, lf = emparejar([], f)
    assert parejas == [] and ls == [] and len(lf) == 2


def test_no_muta_las_entradas():
    """La funcion es pura: el llamador sigue usando `sobrantes`/`faltantes`."""
    s = [ren(2232, "REPUBLICA DOMINICANA")]
    f = {("HAITI", "X"): lote(2232), ("PAKISTAN", "Y"): lote(325)}
    emparejar(s, f)
    assert len(s) == 1 and len(f) == 2


def test_unidades_none_se_tratan_como_cero():
    s = [{"units_on_hand": None, "inventory_id": "a"}]
    f = {("HAITI", "X"): {"units": 0, "boxes": 0, "sample": {}}}
    parejas, ls, lf = emparejar(s, f)
    assert len(parejas) == 1     # 1:1 gana antes de mirar cantidades


if __name__ == "__main__":
    fallos = 0
    for nombre, fn in sorted(globals().items()):
        if nombre.startswith("test_") and callable(fn):
            try:
                fn()
                print(f"  PASS  {nombre}")
            except AssertionError as e:
                fallos += 1
                print(f"  FAIL  {nombre}: {e}")
    total = sum(1 for n in globals() if n.startswith("test_"))
    print(f"\n{total - fallos}/{total} pruebas OK")
    sys.exit(1 if fallos else 0)
