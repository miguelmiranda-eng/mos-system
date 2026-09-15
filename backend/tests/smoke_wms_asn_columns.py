"""Smoke — columnas personalizadas de las líneas de entrada (ASN/BPO).

Contrato:
  · GET/PUT /asn-columns: definición GLOBAL en column_config (config_id
    'wms_asn'); PUT valida clave, tipo, fórmula y opciones; solo admin+.
  · POST /asn y PUT /asn/{id}: items[].extra conserva SOLO claves definidas,
    casteadas por tipo; las de fórmula no se guardan; lo demás se descarta.
  · Quitar una columna no borra los valores viejos de items[].extra.

Corre contra una base DESECHABLE (igual que smoke_wms_movements.py):
    set MONGODB_URL=mongodb://usuario:clave@host:27017/?authSource=admin
    python backend/tests/smoke_wms_asn_columns.py
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


def sembrar():
    raw.drop_database(SMOKE_DB)
    for role, uid, lvl in (("supersu", "u_admin", 5), ("operator", "u_oper", 0)):
        sdb.users.insert_one({
            "user_id": uid, "email": f"{uid}@test.local", "name": uid,
            "password_hash": bcrypt.hash("smoke123"),
            "role": role, "admin_level": lvl, "inventory_level": lvl, "active": True,
        })


async def login(c, uid):
    r = await c.post("/api/auth/login", json={"email": f"{uid}@test.local", "password": "smoke123"})
    tok = r.json().get("session_token") if r.status_code == 200 else None
    return {"Authorization": f"Bearer {tok}"} if tok else {}


async def main():
    sembrar()
    from httpx import ASGITransport, AsyncClient
    from server import app

    # El login también deja cookie de sesión en el cliente y la cookie manda
    # sobre el header: con un solo cliente, el segundo login pisa al primero.
    # Un cliente por usuario.
    tr = ASGITransport(app=app)
    async with AsyncClient(transport=tr, base_url="http://smoke") as ca,                AsyncClient(transport=tr, base_url="http://smoke") as co:
        HA = await login(ca, "u_admin")
        HO = await login(co, "u_oper")
        check("login admin / operador", bool(HA) and bool(HO))
        # De aquí en adelante: `ca` = admin, `co` = operador (la cookie autentica).

        print("\n== 1. Definición de columnas ==")
        r = await co.get("/api/wms/asn-columns")
        check("GET vacío al inicio", r.status_code == 200 and r.json() == {"columns": []}, r.text[:120])

        cols = [
            {"key": "lote", "label": "Lote", "type": "text"},
            {"key": "peso", "label": "Peso kg", "type": "number"},
            {"key": "revisado", "label": "Revisado", "type": "checkbox"},
            {"key": "estado_qc", "label": "Estado QC", "type": "select",
             "statusOptions": [{"value": "OK", "color": "#38761d"}, {"value": "HOLD", "color": "#cf0000"}]},
            {"key": "doble", "label": "Doble", "type": "formula", "formula": "[Cantidad] * 2"},
        ]
        r = await co.put("/api/wms/asn-columns", json={"columns": cols})
        check("operador NO puede definir columnas (403)", r.status_code == 403, r.text[:120])
        r = await ca.put("/api/wms/asn-columns", json={"columns": cols})
        check("admin define 5 columnas", r.status_code == 200 and len(r.json()["columns"]) == 5, r.text[:200])
        doc = sdb.column_config.find_one({"config_id": "wms_asn"})
        check("persistidas en column_config/wms_asn", doc is not None and len(doc["columns"]) == 5)

        for bad, why in (
            ({"key": "qty_expected", "label": "X", "type": "text"}, "clave reservada"),
            ({"key": "Con Espacios", "label": "X", "type": "text"}, "clave inválida"),
            ({"key": "z", "label": "X", "type": "geo"}, "tipo no soportado"),
            ({"key": "f", "label": "F", "type": "formula"}, "fórmula vacía"),
            ({"key": "s", "label": "S", "type": "select", "statusOptions": []}, "select sin opciones"),
        ):
            r = await ca.put("/api/wms/asn-columns", json={"columns": cols + [bad]})
            check(f"rechaza {why} (400)", r.status_code == 400, f"{r.status_code} {r.text[:100]}")
        r = await co.get("/api/wms/asn-columns")
        check("los rechazos no tocaron la definición", len(r.json()["columns"]) == 5)

        print("\n== 2. POST /asn conserva extra según definición ==")
        line = {"part_number": "5000", "color": "AZALEA", "size": "L", "qty_expected": 22,
                "extra": {"lote": " L-77 ", "peso": "12.5", "revisado": 1, "estado_qc": "OK",
                          "doble": 999, "no_definida": "basura"}}
        r = await co.post("/api/wms/asn", json={"asn_id": "SMK-1", "items": [line]})
        check("crea entrada", r.status_code == 200, r.text[:160])
        ex = (r.json()["items"][0]).get("extra")
        check("texto limpio", ex.get("lote") == "L-77", ex)
        check("número casteado", ex.get("peso") == 12.5, ex)
        check("checkbox -> bool", ex.get("revisado") is True, ex)
        check("select se guarda", ex.get("estado_qc") == "OK", ex)
        check("fórmula NO se guarda", "doble" not in ex, ex)
        check("clave no definida se descarta", "no_definida" not in ex, ex)
        check("campos fijos intactos", r.json()["items"][0]["qty_expected"] == 22)

        print("\n== 3. PUT /asn/{id} respeta extra y qty_received ==")
        sdb.wms_asn.update_one({"asn_id": "SMK-1"}, {"$set": {"items.0.qty_received": 5}})
        r = await ca.put("/api/wms/asn/SMK-1", json={"items": [
            {"line_no": 1, "part_number": "5000", "color": "AZALEA", "size": "L", "qty_expected": 22,
             "extra": {"lote": "L-78", "peso": 7}},
        ]})
        check("edita entrada", r.status_code == 200, r.text[:160])
        it = sdb.wms_asn.find_one({"asn_id": "SMK-1"})["items"][0]
        check("extra actualizado", it["extra"] == {"lote": "L-78", "peso": 7}, it["extra"])
        check("qty_received se conservó", it["qty_received"] == 5, it["qty_received"])

        print("\n== 4. Quitar columna: la definición cambia, los valores viejos quedan ==")
        r = await ca.put("/api/wms/asn-columns", json={"columns": [c_ for c_ in cols if c_["key"] != "lote"]})
        check("quita 'lote'", r.status_code == 200 and len(r.json()["columns"]) == 4)
        it = sdb.wms_asn.find_one({"asn_id": "SMK-1"})["items"][0]
        check("valor viejo sigue en extra", it["extra"].get("lote") == "L-78", it["extra"])
        r = await co.post("/api/wms/asn", json={"asn_id": "SMK-2", "items": [
            {"part_number": "5000", "qty_expected": 1, "extra": {"lote": "ya no", "peso": 1}}]})
        check("entrada nueva ya no acepta 'lote'", r.status_code == 200 and "lote" not in r.json()["items"][0]["extra"], r.text[:120])

    print(f"\n===== {ok} PASS / {fail} FAIL =====")
    raw.drop_database(SMOKE_DB)
    print(f"base {SMOKE_DB} eliminada")
    sys.exit(1 if fail else 0)


if __name__ == "__main__":
    asyncio.run(main())
