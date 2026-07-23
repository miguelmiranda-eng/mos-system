"""TRIPWIRE — un solo escritor para wms_inventory (el marcador).

LA RAÍZ DE TODOS LOS DESCUADRES (CK001, fantasmas, PS06-A04) fue siempre la
misma: muchas manos escribiéndole aritmética al marcador. La cura es el
principio de UN SOLO ESCRITOR: nadie toca wms_inventory salvo el reescritor
(_reproject_material_rows, que copia de las cajas) y los flujos explícitamente
permitidos abajo (deuda conocida en migración por olas, o escrituras legítimas
que no derivan de cajas, como units_allocated).

Esta prueba parsea el código y TRUENA si:
  · aparece una función nueva que escribe wms_inventory (escritor pirata), o
  · una función permitida gana sitios de escritura (creció la deuda), o
  · una función permitida pierde sitios (¡bien! — pero actualiza la lista para
    que el avance quede consolidado y no pueda regresar en silencio).

Ratchet: la lista SOLO debe encogerse. Cuando migres una ola, borra sus
funciones de ALLOWLIST y deja el número nuevo grabado aquí.

CÓMO SE CORRE
─────────────
    python backend/tests/test_wms_inventory_single_writer.py   # sin dependencias
    pytest backend/tests/test_wms_inventory_single_writer.py   # si hay pytest
"""
import os
import re
import sys
from collections import defaultdict

WMS = os.path.join(os.path.dirname(__file__), "..", "routers", "wms.py")

# Estado congelado tras la OLA 1 (2026-07-23): migrado el conteo cíclico
# completo (resolución, unidades contadas, modo por líneas, alta manual del
# supervisor) — 62 sitios/25 funciones -> 55/20.
ALLOWLIST = {
    # ── El escritor legítimo y las piezas del modelo nuevo ──
    "_reproject_material_rows": 6,        # EL reescritor (la caja manda)
    "_reconcile_missing_inventory_row": 1,  # crea fila desde cajas (modelo nuevo)
    "_selftest_cleanup": 1,               # limpieza del autotest de Auditoría
    # ── DEUDA (olas pendientes): migrar a cajas-primero + reescritor ──
    "_adjust_inventory_boxes": 2,
    "_move_box_inventory": 5,
    "_update_inventory_enhanced": 9,
    "add_inventory_manual": 3,
    "adjust_box_count": 3,
    "bulk_adjust_inventory": 2,
    "correct_upc": 5,
    "delete_box": 2,
    "delete_inventory_row": 1,
    "delete_location": 1,
    "delete_receiving": 2,
    "import_inventory": 2,
    "recon_commit": 2,
    "reconcile_lpn": 4,
    "update_box": 2,
    "update_location": 1,
    "update_upc": 1,
}

PAT = re.compile(
    r"wms_inventory\.(update_one|update_many|insert_one|insert_many|"
    r"delete_one|delete_many|find_one_and_update|replace_one|bulk_write)")


def censo():
    src = open(WMS, encoding="utf-8").read().splitlines()
    funcs = []
    for i, l in enumerate(src, 1):
        m = re.match(r"(?:async )?def (\w+)", l)
        if m:
            funcs.append((i, m.group(1)))

    def fn_de(n):
        c = [f for i, f in funcs if i <= n]
        return c[-1] if c else "?"

    por = defaultdict(int)
    for i, l in enumerate(src, 1):
        if PAT.search(l):
            por[fn_de(i)] += 1
    return dict(por)


def test_un_solo_escritor():
    actual = censo()
    piratas = sorted(set(actual) - set(ALLOWLIST))
    assert not piratas, (
        f"ESCRITOR(ES) PIRATA(S) de wms_inventory: {piratas}. El marcador solo "
        "se escribe vía _reproject_material_rows (la caja manda). Si tu flujo "
        "muta stock: muta las CAJAS y reescribe con el reescritor. Si de verdad "
        "necesitas una excepción (p. ej. units_allocated), justifícala aquí.")
    crecidas = {f: (ALLOWLIST[f], n) for f, n in actual.items()
                if f in ALLOWLIST and n > ALLOWLIST[f]}
    assert not crecidas, (
        f"La deuda CRECIÓ (función: permitido->actual): {crecidas}. "
        "No se agregan escrituras nuevas a los flujos legados.")
    encogidas = {f: (ALLOWLIST[f], actual.get(f, 0)) for f in ALLOWLIST
                 if actual.get(f, 0) < ALLOWLIST[f]}
    assert not encogidas, (
        f"¡Avance! Estas funciones bajaron o desaparecieron: {encogidas}. "
        "Consolídalo: actualiza ALLOWLIST con los números nuevos para que la "
        "mejora no pueda revertirse en silencio.")


if __name__ == "__main__":
    try:
        test_un_solo_escritor()
        actual = censo()
        print(f"  PASS  un solo escritor — {sum(actual.values())} sitios en "
              f"{len(actual)} funciones permitidas")
        sys.exit(0)
    except AssertionError as e:
        print(f"  FAIL  {e}")
        sys.exit(1)
