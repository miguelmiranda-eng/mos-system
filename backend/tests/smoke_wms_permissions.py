"""Smoke — permisos por acción configurables (Sistema → Configuración → Permisos).

Contrato:
  · GET /permissions: catálogo (acciones, grupos, pisos, candado) + niveles
    vigentes (defaults si nada guardado). Cualquier autenticado.
  · GET /permissions/me: acciones permitidas al usuario + sus dos escaleras.
  · PUT /permissions: solo supersu (config.permissions, candado); valida rangos,
    pisos y candado con mensaje legible; guarda el mapa completo; log con
    antes/después. Un admin 5 recibe 403.
  · POST /permissions/preview: quién gana / pierde por cada acción cambiada.
  · El cambio se HACE CUMPLIR: habilitar locations.create por inventarios 3
    deja que Paola (inv 3) cree una ubicación; devolver el default se lo quita.
  · module-access PUT usa la misma acción (supersu).

Base DESECHABLE. Un AsyncClient por usuario.
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
    "supersu": {"role": "supersu"},
    "admin5": {"role": "admin", "admin_level": 5},
    "admin3": {"role": "admin", "admin_level": 3},
    "paola": {"role": "inventory", "inventory_level": 3},
    "picker": {"role": "picker"},
}


def sembrar():
    raw.drop_database(SMOKE_DB)
    for name, extra in USERS.items():
        sdb.users.insert_one({"user_id": f"u_{name}", "email": f"{name}@test.local", "name": name.capitalize(),
                              "password_hash": bcrypt.hash("smoke123"), "active": True, **extra})


async def login(transport, name):
    from httpx import AsyncClient
    c = AsyncClient(transport=transport, base_url="http://smoke")
    r = await c.post("/api/auth/login", json={"email": f"{name}@test.local", "password": "smoke123"})
    check(f"login {name}", r.status_code == 200, r.text[:100])
    return c


async def main():
    sembrar()
    from httpx import ASGITransport
    from server import app
    transport = ASGITransport(app=app)
    su = await login(transport, "supersu")
    a5 = await login(transport, "admin5")
    a3 = await login(transport, "admin3")
    pa = await login(transport, "paola")
    pk = await login(transport, "picker")

    print("\n== 1. Catálogo y /me ==")
    r = await pk.get("/api/wms/permissions")
    d = r.json()
    check("cualquier autenticado lee el catálogo", r.status_code == 200 and len(d["actions"]) >= 20 and d["groups"][0]["id"] == "locations", r.status_code)
    ids = {a["id"] for a in d["actions"]}
    check("acciones clave presentes", {"locations.create", "locations.delete", "location_check.resolve", "recon.manage", "config.permissions"} <= ids)
    lc = next(a for a in d["actions"] if a["id"] == "locations.create")
    check("sin nada guardado, niveles = defaults", d["levels"]["locations.create"] == lc["default"] == {"admin": 5, "inventory": None})
    check("pisos y candado viajan", lc["floor_admin"] == 3 and next(a for a in d["actions"] if a["id"] == "config.permissions")["locked"] is True)
    r = await pa.get("/api/wms/permissions/me")
    me = r.json()
    check("Paola (inv 3): escaleras puras (0, 3)", me["admin_level"] == 0 and me["inventory_level"] == 3, me)
    check("Paola: renombra, supervisa conteos, NO crea ni elimina ubicaciones",
          "locations.rename" in me["allowed"] and "cycle_count.supervise" in me["allowed"]
          and "locations.create" not in me["allowed"] and "locations.delete" not in me["allowed"], me["allowed"])
    r = await pk.get("/api/wms/permissions/me")
    check("picker sin nivel: nada permitido", r.json()["allowed"] == [], r.json())
    r = await su.get("/api/wms/permissions/me")
    check("supersu: todo", set(r.json()["allowed"]) == ids)

    print("\n== 2. PUT: quién y validación ==")
    r = await a5.put("/api/wms/permissions", json={"levels": {"locations.create": {"admin": 5, "inventory": 3}}})
    check("admin 5 NO reparte permisos → 403 y nombra la acción", r.status_code == 403 and "Repartir permisos" in r.text, r.text[:120])
    r = await su.put("/api/wms/permissions", json={"levels": {"locations.delete": {"admin": 2, "inventory": None}}})
    check("por debajo del piso → 400 legible", r.status_code == 400 and "no puede bajar de 3" in r.text, r.text[:120])
    r = await su.put("/api/wms/permissions", json={"levels": {"recon.manage": {"admin": 6, "inventory": 3}}})
    check("conciliación por inventarios → 400 (escalera apagada)", r.status_code == 400 and "no puede conceder" in r.text, r.text[:120])
    r = await su.put("/api/wms/permissions", json={"levels": {"config.permissions": {"admin": 5, "inventory": None}}})
    check("candado → 400", r.status_code == 400 and "no se puede cambiar" in r.text, r.text[:120])
    check("nada de eso se guardó", sdb.config_options.find_one({"config_id": "wms_actions"}) is None)

    print("\n== 3. Preview de impacto ==")
    r = await su.post("/api/wms/permissions/preview", json={"levels": {"locations.create": {"admin": 5, "inventory": 3}, "locations.rename": {"admin": 3, "inventory": 3}}})
    imp = r.json()["impact"]
    check("solo aparece lo que cambia (rename queda igual)", r.status_code == 200 and set(imp) == {"locations.create"}, imp)
    check("crear ubicaciones por inventarios 3: gana Paola, nadie pierde, total 3 (supersu, admin5, Paola)",
          imp["locations.create"]["gain"] == ["Paola"] and imp["locations.create"]["lose"] == [] and imp["locations.create"]["total"] == 3, imp)
    r = await su.post("/api/wms/permissions/preview", json={"levels": {"locations.rename": {"admin": 5, "inventory": None}}})
    imp = r.json()["impact"]
    check("renombrar solo admin 5: pierden Admin3 y Paola", imp["locations.rename"]["lose"] == ["Admin3", "Paola"], imp)

    print("\n== 4. Guardar y hacer cumplir ==")
    sdb.wms_locations.insert_one({"location_id": "loc_seed", "name": "SEED-01", "zone": "S", "type": "rack", "active": True})
    r = await pa.post("/api/wms/locations", json={"name": "P-01", "zone": "P", "type": "rack"})
    check("antes: Paola no crea (403)", r.status_code == 403, r.status_code)
    r = await su.put("/api/wms/permissions", json={"levels": {"locations.create": {"admin": 5, "inventory": 3}}})
    d = r.json()
    check("PUT ok, devuelve mapa completo y lo cambiado", r.status_code == 200 and d["levels"]["locations.create"] == {"admin": 5, "inventory": 3} and set(d["changed"]) == {"locations.create"} and "locations.rename" in d["levels"], d.get("changed"))
    check("log de actividad con antes/después", sdb.activity_logs.count_documents({"action": "wms_actions_update", "details.changed": {"$elemMatch": {"action": "locations.create", "from.inventory": None, "to.inventory": 3}}}) == 1)
    check("en Mongo las llaves van sin punto (consultables)", sdb.config_options.find_one({"config_id": "wms_actions", "levels.locations__create.inventory": 3}) is not None)
    r = await pa.post("/api/wms/locations", json={"name": "P-01", "zone": "P", "type": "rack"})
    check("después: Paola crea (200) — el cambio se aplica sin reiniciar", r.status_code == 200, r.text[:120])
    r = await pa.get("/api/wms/permissions/me")
    check("/me de Paola ya incluye locations.create", "locations.create" in r.json()["allowed"])
    r = await a3.post("/api/wms/locations", json={"name": "A3-01", "zone": "P", "type": "rack"})
    check("admin 3 sigue sin crear (escalera admin sigue en 5)", r.status_code == 403)
    r = await pa.delete("/api/wms/locations/loc_seed")
    check("Paola sigue sin eliminar (acción aparte)", r.status_code == 403)
    r = await su.put("/api/wms/permissions", json={"levels": {"locations.create": {"admin": 5, "inventory": None}}})
    r = await pa.post("/api/wms/locations", json={"name": "P-02", "zone": "P", "type": "rack"})
    check("de vuelta al default: Paola 403 otra vez", r.status_code == 403, r.status_code)
    r = await su.put("/api/wms/permissions", json={"levels": {"location_check.resolve": {"admin": 0, "inventory": 0}}})
    r = await pk.get("/api/wms/permissions/me")
    check("nivel 0 = todos: el picker ya puede resolver Location Check", "location_check.resolve" in r.json()["allowed"], r.json())
    r = await su.put("/api/wms/permissions", json={"levels": {"basura.x": {"admin": 1}}})
    check("acción desconocida → 400", r.status_code == 400 and "desconocida" in r.text)

    print("\n== 5. module-access usa la misma acción ==")
    r = await a5.put("/api/wms/module-access", json={"levels": {"audit": 3}})
    check("admin 5 no reparte accesos por módulo → 403", r.status_code == 403)
    r = await su.put("/api/wms/module-access", json={"levels": {"audit": 3}})
    check("supersu sí", r.status_code == 200 and r.json()["levels"]["audit"] == 3)
    r = await pa.get("/api/wms/module-access")
    d = r.json()
    check("GET trae inventory_levels con la lista blanca histórica como default",
          d["inventory_levels"]["locations"] == 1 and d["inventory_levels"]["movements"] == 1 and d["inventory_levels"]["asn"] is None and d["inventory_defaults"]["audit"] is None, d.get("inventory_levels"))
    r = await su.put("/api/wms/module-access", json={"levels": {"audit": 5}})
    r = await pa.get("/api/wms/audit/health")
    check("Paola (inv 3) NO entra a Auditoría (admin 5, inventarios —)", r.status_code == 403, r.status_code)
    r = await su.put("/api/wms/module-access", json={"inventory_levels": {"audit": 3, "asn": 2}})
    d = r.json()
    check("PUT inventory_levels guarda sin pisar levels", r.status_code == 200 and d["inventory_levels"]["audit"] == 3 and d["inventory_levels"]["asn"] == 2 and d["levels"]["audit"] == 5, d)
    r = await pa.get("/api/wms/audit/health")
    check("ahora Paola entra a Auditoría por la escalera de inventarios", r.status_code == 200, r.status_code)
    r = await su.put("/api/wms/module-access", json={"levels": {"audit": 6}})
    d = r.json()
    check("PUT solo levels (Centro de usuarios) conserva inventory_levels", d["inventory_levels"]["audit"] == 3 and d["levels"]["audit"] == 6, d)
    r = await su.put("/api/wms/module-access", json={"inventory_levels": {"audit": None}})
    r = await pa.get("/api/wms/audit/health")
    check("apagar la escalera (None) → Paola 403 otra vez", r.status_code == 403)

    print("\n== 6. Verdes del Mover: la acción manda también en el backend ==")
    body = {"style": "5000", "color": "BLACK", "size": "M", "units": 5, "location": "SEED-01", "customer": "GOODIE TWO SLEEVES"}
    r = await a3.post("/api/wms/boxes/generate", json=body)
    check("admin 3 NO genera caja (403, antes require_auth)", r.status_code == 403 and "Generar caja" in r.text, r.text[:120])
    r = await pa.post("/api/wms/boxes/generate", json=body)
    check("Paola (rol inventarios) sí puede llamar generate (no 403)", r.status_code != 403, r.status_code)
    r = await a3.post("/api/wms/boxes/NOPE/adjust", json={"units": 1, "reason": "x"})
    check("admin 3 NO ajusta caja (403)", r.status_code == 403, r.status_code)

    for c in (su, a5, a3, pa, pk):
        await c.aclose()
    print(f"\n===== {ok} PASS / {fail} FAIL =====")
    raw.drop_database(SMOKE_DB)
    print(f"base {SMOKE_DB} eliminada")
    sys.exit(1 if fail else 0)


if __name__ == "__main__":
    asyncio.run(main())
