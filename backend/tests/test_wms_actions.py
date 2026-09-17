"""Pruebas del catálogo de permisos por acción (wms_actions.py). Puro, sin base.

Contrato clave: los DEFAULTS reproducen los umbrales que había en código
(require_admin_level / require_inventory_level / require_location_* / supersu),
así que desplegar el catálogo no cambia ningún permiso.
"""
import os
import sys

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from wms_actions import (  # noqa: E402
    ACTIONS, GROUPS, SUPERSU_LEVEL, INV_OFF, user_ladders, allows, defaults, merge, normalize, allowed_for, catalog,
)

ok = fail = 0


def check(nombre, cond, detalle=""):
    global ok, fail
    if cond:
        ok += 1
        print(f"   PASS  {nombre}")
    else:
        fail += 1
        print(f"   FAIL  {nombre}  {detalle}")


U = {
    "supersu": {"role": "supersu"},
    "admin5": {"role": "admin", "admin_level": 5},
    "admin3": {"role": "admin", "admin_level": 3},
    "admin2": {"role": "admin", "admin_level": 2},
    "admin1": {"role": "admin"},
    "inv3": {"role": "inventory", "inventory_level": 3},
    "inv2": {"role": "inventory", "inventory_level": 2},
    "inv1": {"role": "inventory", "inventory_level": 1},
    "general_inv3": {"role": "general", "inventory_level": 3},
    "picker": {"role": "picker"},
    "picker_inv2": {"role": "picker", "inventory_level": 2},
    "ceo": {"role": "ceo"},
}


def run():
    print("== 1. Escaleras puras")
    check("supersu = (6, 0)", user_ladders(U["supersu"]) == (SUPERSU_LEVEL, 0))
    check("admin sin nivel = 1", user_ladders(U["admin1"]) == (1, 0))
    check("admin 5", user_ladders(U["admin5"]) == (5, 0))
    check("inventory 3 NO se funde a admin 3", user_ladders(U["inv3"]) == (0, 3))
    check("admin NO recibe inventarios 3 automático", user_ladders(U["admin1"])[1] == 0)
    check("basura → (0, 0)", user_ladders({"role": "admin", "admin_level": "x", "inventory_level": "y"}) == (1, 0))
    check("nivel fuera de rango se acota", user_ladders({"role": "admin", "admin_level": 99, "inventory_level": 9}) == (5, 3))

    print("\n== 2. Defaults = umbrales que había en código")
    D = defaults()
    exp = {  # acción: (quién SÍ, quién NO) con la regla vieja
        "locations.create": (["supersu", "admin5"], ["admin3", "inv3", "general_inv3", "picker"]),          # require_location_admin (≥5)
        "locations.rename": (["supersu", "admin5", "admin3", "inv3", "general_inv3"], ["admin2", "inv2", "picker"]),  # get_admin_level ≥ 3
        "locations.delete": (["supersu", "admin5"], ["admin3", "inv3"]),
        "locations.hold": (["supersu", "admin2", "admin5", "inv3"], ["admin1", "inv2", "picker"]),           # require_admin_level(2)
        "inventory.add_manual": (["admin1", "inv2", "inv3", "picker_inv2"], ["inv1", "picker", "ceo"]),       # require_inventory_level(2)
        "inventory.delete_box": (["admin2", "inv3"], ["admin1", "inv2"]),                                   # require_admin_level(2)
        "cycle_count.operate": (["admin1", "inv1", "picker_inv2"], ["picker", "ceo"]),                       # require_inventory_level(1)
        "cycle_count.supervise": (["admin1", "inv3"], ["inv2"]),                                             # require_inventory_level(3)
        "location_check.resolve": (["admin1", "inv1"], ["picker"]),
        "recon.manage": (["supersu"], ["admin5", "inv3"]),                                                   # require_supersu
        "asn.edit": (["supersu", "admin3", "inv3"], ["admin2", "inv2"]),                                     # require_admin (≥3)
        "notifications.push": (["admin2", "inv3"], ["admin1", "inv2"]),
        "config.permissions": (["supersu"], ["admin5"]),
    }
    for act, (yes, no) in exp.items():
        bad = [n for n in yes if not allows(D[act], U[n])] + [f"!{n}" for n in no if allows(D[act], U[n])]
        check(f"{act}: {', '.join(yes)} sí / {', '.join(no)} no", not bad, bad)
    check("supersu pasa TODO", all(allows(D[a], U["supersu"]) for a in ACTIONS))
    check("todas las acciones tienen grupo conocido", {v["group"] for v in ACTIONS.values()} <= {g for g, _ in GROUPS})

    print("\n== 3. normalize: rangos, pisos, candado")
    check("subir crear ubicaciones a inventarios 3 (doble escalera) → ok", normalize("locations.create", {"admin": 5, "inventory": 3}) == {"admin": 5, "inventory": 3})
    check("eliminar ubicaciones por debajo del piso admin 3 → error", _raises(lambda: normalize("locations.delete", {"admin": 2, "inventory": None}), "no puede bajar de 3"))
    check("conciliación por inventarios → error (escalera apagada)", _raises(lambda: normalize("recon.manage", {"admin": 6, "inventory": 3}), "no puede conceder"))
    check("permisos: candado", _raises(lambda: normalize("config.permissions", {"admin": 5, "inventory": None}), "no se puede cambiar"))
    check("admin 7 → fuera de rango", _raises(lambda: normalize("locations.rename", {"admin": 7, "inventory": 3}), "entre 0 y 6"))
    check("inventarios 4 → fuera de rango", _raises(lambda: normalize("locations.rename", {"admin": 3, "inventory": 4}), "entre 0 y 3"))
    check("acción desconocida → error", _raises(lambda: normalize("nada.nada", {"admin": 1}), "desconocida"))
    check("None/None → solo supersu (admin 6)", normalize("locations.rename", {"admin": None, "inventory": None}) == {"admin": 6, "inventory": None})
    check("strings '3' y '' se aceptan", normalize("locations.rename", {"admin": "3", "inventory": ""}) == {"admin": 3, "inventory": None})
    check("0 = todos, respetando piso 0", normalize("location_check.resolve", {"admin": 0, "inventory": 0}) == {"admin": 0, "inventory": 0})

    print("\n== 4. merge y allowed_for")
    m = merge({"locations.create": {"admin": 5, "inventory": 3}, "locations.delete": {"admin": 1, "inventory": None}, "basura": {"admin": 0}})
    check("lo guardado válido manda", m["locations.create"] == {"admin": 5, "inventory": 3})
    check("lo guardado por debajo del piso se descarta → default", m["locations.delete"] == D["locations.delete"])
    check("llaves desconocidas se ignoran", "basura" not in m)
    check("con inventarios 3 habilitado, Paola (inv 3) ya crea ubicaciones", allows(m["locations.create"], U["inv3"]) and not allows(D["locations.create"], U["inv3"]))
    al = allowed_for(D, U["inv2"])
    check("allowed_for inv2: opera conteos, ajusta, NO aprueba con supervisión ni borra ubicaciones",
          "cycle_count.operate" in al and "inventory.adjust_box" in al and "cycle_count.approve" in al and "cycle_count.supervise" not in al and "locations.delete" not in al, al)
    check("allowed_for picker: solo lo de nivel 0 (nada por default)", allowed_for(D, U["picker"]) == [], allowed_for(D, U["picker"]))
    check("catalog(): una entrada por acción con default y pisos", len(catalog()) == len(ACTIONS) and all("default" in c and "floor_admin" in c for c in catalog()))
    check("INV_OFF solo en acciones supersu", all(ACTIONS[k]["admin"] == SUPERSU_LEVEL for k, v in ACTIONS.items() if v["floor_inventory"] == INV_OFF))

    print(f"\n===== {ok} PASS / {fail} FAIL =====")
    return fail


def _raises(fn, needle):
    try:
        fn()
    except ValueError as e:
        return needle in str(e)
    return False


def test_wms_actions():
    assert run() == 0


if __name__ == "__main__":
    sys.exit(1 if run() else 0)
