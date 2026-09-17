"""Smoke — tarea #29: quién puede crear / renombrar / eliminar ubicaciones.

Contrato:
  · RENOMBRAR (require_location_manager, nivel 3): supersu, admin nivel 3+,
    usuario con inventory_level 3 (control de inventario, rol inventory o general).
  · CREAR / ELIMINAR (require_location_admin, nivel 5, decisión 2026-09-17):
    solo supersu y admin nivel 5.
  · BLOQUEADO (403) en todo: general/operator/picker sin nivel, admin nivel 1-2,
    inventory con inventory_level 2.
  · Leer ubicaciones sigue abierto a cualquier usuario autenticado.
  · Un AsyncClient POR usuario: la cookie manda sobre el header.

Base DESECHABLE.
"""
import asyncio
import os
import sys

BE = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
SMOKE_DB = os.environ.get("SMOKE_DB_NAME", "mos-smoke-test")
PROD_DB = os.environ.get("PROD_DB_NAME", "mos-system")
MONGO = os.environ.get("MONGODB_URL") or os.environ.get("MONGO_URL")
if not MONGO:
    sys.exit("Falta MONGODB_URL")
if SMOKE_DB == PROD_DB:
    sys.exit(f"NEGADO: SMOKE_DB_NAME es la base de producción ('{PROD_DB}').")
os.environ["MONGODB_URL"] = MONGO
os.environ["DB_NAME"] = SMOKE_DB
os.environ.setdefault("JWT_SECRET", "smoke_secret")
os.environ.setdefault("MASTER_API_KEY", "smoke_master_key")
os.environ.setdefault("INTERNAL_SYNC_TOKEN", "smoke_sync_token")
os.environ.setdefault("ENV", "local")
os.environ.setdefault("DISABLE_SCHEDULERS", "1")
sys.path.insert(0, BE)
os.chdir(BE)

import pymongo  # noqa: E402
from passlib.hash import bcrypt  # noqa: E402

raw = pymongo.MongoClient(MONGO)
sdb = raw[SMOKE_DB]
ok = fail = 0


def check(nombre, cond, detalle=""):
    global ok, fail
    if cond:
        ok += 1
        print(f"   PASS  {nombre}")
    else:
        fail += 1
        print(f"   FAIL  {nombre}  {detalle}")


USERS = {
    # nombre: (role, admin_level, inventory_level, puede_renombrar, puede_crear_eliminar)
    "supersu": ("supersu", None, None, True, True),
    "admin5": ("admin", 5, None, True, True),
    "admin4": ("admin", 4, None, True, False),
    "admin3": ("admin", 3, None, True, False),
    "inventarios3": ("inventory", None, 3, True, False),
    "general_inv3": ("general", None, 3, True, False),
    "admin1": ("admin", None, None, False, False),
    "admin2": ("admin", 2, None, False, False),
    "inventory2": ("inventory", None, 2, False, False),
    "general": ("general", None, None, False, False),
    "operator": ("operator", None, None, False, False),
    "picker2": ("picker", None, 2, False, False),
}


def sembrar():
    raw.drop_database(SMOKE_DB)
    for name, (role, al, il, _, _cd) in USERS.items():
        doc = {"user_id": f"u_{name}", "email": f"{name}@test.local", "name": name, "role": role,
               "password_hash": bcrypt.hash("smoke123"), "active": True}
        if al is not None:
            doc["admin_level"] = al
        if il is not None:
            doc["inventory_level"] = il
        sdb.users.insert_one(doc)
    sdb.wms_locations.insert_one({"location_id": "loc_seed", "name": "SEED-01", "zone": "SEED", "type": "rack", "active": True})


async def main():
    sembrar()
    from httpx import ASGITransport, AsyncClient
    from server import app
    transport = ASGITransport(app=app)
    last_403_create = ""
    for name, (role, al, il, can_rename, can_cd) in USERS.items():
        async with AsyncClient(transport=transport, base_url="http://smoke") as c:
            r = await c.post("/api/auth/login", json={"email": f"{name}@test.local", "password": "smoke123"})
            if r.status_code != 200:
                check(f"{name}: login", False, r.text[:100])
                continue
            tag = f"{name} ({role}, admin {al}, inv {il})"
            r = await c.get("/api/wms/locations")
            check(f"{tag}: leer ubicaciones → 200", r.status_code == 200, r.status_code)
            r = await c.post("/api/wms/locations", json={"name": f"T-{name}", "zone": "T", "type": "rack"})
            exp_cd = 200 if can_cd else 403
            check(f"{tag}: crear → {exp_cd}", r.status_code == exp_cd, f"{r.status_code} {r.text[:100]}")
            if r.status_code == 403:
                last_403_create = r.text
            r = await c.put("/api/wms/locations/loc_seed", json={"name": "SEED-01", "zone": "SEED-Z"})
            exp_rn = 200 if can_rename else 403
            check(f"{tag}: renombrar → {exp_rn}", r.status_code == exp_rn, f"{r.status_code} {r.text[:100]}")
            if can_cd:
                loc = sdb.wms_locations.find_one({"name": f"T-{name}".upper()})
                r = await c.delete(f"/api/wms/locations/{loc['location_id']}")
                check(f"{tag}: eliminar la suya → 200", r.status_code == 200, f"{r.status_code} {r.text[:100]}")
            else:
                r = await c.delete("/api/wms/locations/loc_seed")
                check(f"{tag}: eliminar → 403 y la ubicación sigue", r.status_code == 403 and sdb.wms_locations.count_documents({"location_id": "loc_seed"}) == 1, r.status_code)
    check("403 de crear/eliminar explica que es nivel 5", "nivel 5" in last_403_create, last_403_create[:120])

    print(f"\n===== {ok} PASS / {fail} FAIL =====")
    raw.drop_database(SMOKE_DB)
    print(f"base {SMOKE_DB} eliminada")
    sys.exit(1 if fail else 0)


if __name__ == "__main__":
    asyncio.run(main())
