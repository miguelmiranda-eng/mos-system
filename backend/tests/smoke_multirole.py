"""Smoke — multi-rol (Fase 1, core backend).

Contrato:
  · user_roles soporta el formato nuevo (lista `roles`) y el viejo (`role`).
  · get_admin_level / get_inventory_level evalúan por UNIÓN (gana el más alto).
  · primary_role respeta la precedencia.
  · _normalize_roles valida EXCLUSIVIDAD (customer/shipping_guest/operator/
    external_api van solos) y deduplica.

Lógica pura: no toca la base.
"""
import os
import sys

BE = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
os.environ.setdefault("MONGODB_URL", "mongodb://localhost:27017/mos-smoke-noop")
os.environ.setdefault("DB_NAME", "mos-smoke-noop")
os.environ.setdefault("JWT_SECRET", "x")
os.environ.setdefault("MASTER_API_KEY", "x")
os.environ.setdefault("INTERNAL_SYNC_TOKEN", "x")
os.environ.setdefault("ENV", "local")
os.environ.setdefault("DISABLE_SCHEDULERS", "1")
sys.path.insert(0, BE)
os.chdir(BE)

ok = fail = 0


def check(n, cond, d=""):
    global ok, fail
    print(("   PASS  " if cond else "   FAIL  ") + n + ("" if cond else f"  {d}"))
    ok += bool(cond); fail += (not cond)


def run():
    from deps import user_roles, primary_role, get_admin_level, get_inventory_level
    from fastapi import HTTPException
    from routers.users import _normalize_roles

    # user_roles
    check("user_roles viejo (role)", user_roles({"role": "admin"}) == {"admin"})
    check("user_roles nuevo (roles)", user_roles({"roles": ["admin", "picker"]}) == {"admin", "picker"})
    check("user_roles fusiona role+roles", user_roles({"role": "inventory", "roles": ["picker"]}) == {"inventory", "picker"})
    check("user_roles vacío -> general", user_roles({}) == {"general"})

    # get_admin_level por unión
    check("admin via roles (nivel 4)", get_admin_level({"roles": ["picker", "admin"], "admin_level": 4}) == 4)
    check("supersu en roles -> 5", get_admin_level({"roles": ["supersu", "general"]}) == 5)
    check("picker solo -> 0", get_admin_level({"roles": ["picker"]}) == 0)
    check("inventory_level 3 confiere admin 3", get_admin_level({"roles": ["inventory"], "inventory_level": 3}) == 3)
    check("admin_level default 1 si no se da", get_admin_level({"roles": ["admin", "picker"]}) == 1)

    # get_inventory_level por unión
    check("inv: admin en roles -> max 3", get_inventory_level({"roles": ["picker", "admin"]}) == 3)
    check("inv: inventory_level propio", get_inventory_level({"roles": ["inventory"], "inventory_level": 2}) == 2)
    check("inv: picker solo sin nivel -> 0", get_inventory_level({"roles": ["picker"]}) == 0)

    # primary_role (precedencia)
    check("primary admin sobre picker", primary_role(["picker", "admin"]) == "admin")
    check("primary inventory sobre picker", primary_role(["inventory", "picker"]) == "inventory")
    check("primary de exclusivo", primary_role(["customer"]) == "customer")

    # _normalize_roles
    check("normalize lista", _normalize_roles({"roles": ["admin", "picker"]}) == (["admin", "picker"], "admin"))
    check("normalize role único (back-compat)", _normalize_roles({"role": "inventory"}) == (["inventory"], "inventory"))
    check("normalize vacío -> general", _normalize_roles({"roles": []}) == (["general"], "general"))
    check("normalize dedup", _normalize_roles({"roles": ["admin", "admin", "picker"]}) == (["admin", "picker"], "admin"))
    check("exclusivo solo OK", _normalize_roles({"roles": ["shipping_guest"]}) == (["shipping_guest"], "shipping_guest"))
    try:
        _normalize_roles({"roles": ["customer", "admin"]})
        check("exclusivo + otro -> 400", False)
    except HTTPException as e:
        check("exclusivo + otro -> 400", e.status_code == 400)
    try:
        _normalize_roles({"roles": ["admin", "shipping_guest"]})
        check("admin + shipping_guest -> 400", False)
    except HTTPException as e:
        check("admin + shipping_guest -> 400", e.status_code == 400)


if __name__ == "__main__":
    run()
    print(f"\n   {ok} PASS / {fail} FAIL")
    sys.exit(1 if fail else 0)
