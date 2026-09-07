"""Smoke OFFLINE del guardia de identidad del WMS (sin Mongo, sin red).

Congela el comportamiento de _assert_curated_identity, del que ahora dependen
NO solo la recepción sino también las ediciones PUT /boxes y PUT /receiving
(cierre de las puertas traseras B2) y la validación de `manufacturer` en
recepción (B3). Usa un `db` falso en memoria y monkeypatch de _is_strict_customer.

    backend/venv/Scripts/python.exe backend/tests/smoke_wms_identity_guard.py
"""
import asyncio
import os
import re
import sys

BE = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
for k in ("MONGODB_URL", "DB_NAME", "JWT_SECRET", "MASTER_API_KEY", "INTERNAL_SYNC_TOKEN"):
    os.environ.setdefault(k, "x")
os.environ.setdefault("ENV", "local")
sys.path.insert(0, BE)
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

from fastapi import HTTPException  # noqa: E402
import routers.wms as w  # noqa: E402

ok = fail = 0


def check(name, cond, detail=""):
    global ok, fail
    print(f"   {'PASS' if cond else 'FAIL'}  {name}" + ("" if cond else f"  {detail}"))
    if cond:
        ok += 1
    else:
        fail += 1


class Coll:
    def __init__(self, docs):
        self.docs = docs

    @staticmethod
    def _match(q, d):
        for k, v in q.items():
            if k == "$or":
                if not any(Coll._match(c, d) for c in v):
                    return False
            elif isinstance(v, dict) and "$regex" in v:
                if not re.search(v["$regex"], str(d.get(k, "")), re.I):
                    return False
            elif isinstance(v, dict) and "$in" in v:
                if d.get(k) not in v["$in"]:
                    return False
            elif isinstance(v, dict) and "$exists" in v:
                if (k in d) != v["$exists"]:
                    return False
            elif d.get(k) != v:
                return False
        return True

    def find(self, query, proj=None):
        docs = [d for d in self.docs if self._match(query, d)]

        class Cur:
            async def to_list(self_, n):
                return docs[:n]
        return Cur()

    async def find_one(self, query, proj=None):
        for d in self.docs:
            if self._match(query, d):
                return d
        return None


class FakeDB:
    def __init__(self):
        self.wms_catalog_options = Coll([
            {"type": "styles", "value": "CORE TEE SS", "customer": "SPEKTRUM"},
            {"type": "colors", "value": "BLACK", "customer": "SPEKTRUM"},
            {"type": "manufacturers", "value": "CL+CA", "customer": "SPEKTRUM"},
            {"type": "descriptions", "value": "SHORT SLEEVE - 6.5 OZ 220 GSM"},  # global
        ])
        # 'OLDJUNK' existe en inventario pero NO está curado (para probar el escape).
        self.wms_inventory = Coll([
            {"style": "OLDJUNK", "color": "BLACK", "size": "M"},
        ])


async def expect_ok(name, coro):
    try:
        await coro
        check(name, True)
    except Exception as e:
        check(name, False, f"lanzó {type(e).__name__}: {getattr(e, 'detail', e)}")


async def expect_400(name, coro):
    try:
        await coro
        check(name, False, "no lanzó (debía rechazar)")
    except HTTPException as e:
        check(name, e.status_code == 400, f"status {e.status_code}")
    except Exception as e:
        check(name, False, f"lanzó {type(e).__name__}")


async def main():
    w.db = FakeDB()

    async def strict_off(c):
        return False

    async def strict_on(c):
        return True

    A = w._assert_curated_identity

    print("\n1) valor curado pasa")
    w._is_strict_customer = strict_off
    await expect_ok("style curado", A("SPEKTRUM", {"styles": "CORE TEE SS"}))
    await expect_ok("descripción global curada", A("SPEKTRUM", {"descriptions": "SHORT SLEEVE - 6.5 OZ 220 GSM"}))

    print("\n2) basura nueva (ni curada ni en inventario) se rechaza")
    await expect_400("style inexistente", A("SPEKTRUM", {"styles": "ESTILO QUE NO EXISTE"}))

    print("\n3) escape: valor no curado pero YA en inventario pasa (no estricto)")
    await expect_ok("style OLDJUNK (en inventario)", A("SPEKTRUM", {"styles": "OLDJUNK"}))

    print("\n4) modo ESTRICTO: sin escape, OLDJUNK se rechaza")
    w._is_strict_customer = strict_on
    await expect_400("style OLDJUNK estricto", A("SPEKTRUM", {"styles": "OLDJUNK"}))
    w._is_strict_customer = strict_off

    print("\n5) bootstrap: catálogo vacío para ese tipo -> pasa cualquier cosa")
    await expect_ok("sizes sin catálogo (bootstrap)", A("SPEKTRUM", {"sizes": "7XL"}))

    print("\n6) B3: manufacturer AHORA se valida")
    await expect_ok("manufacturer curado CL+CA", A("SPEKTRUM", {"manufacturers": "CL+CA"}))
    await expect_400("manufacturer basura THREADLAB", A("SPEKTRUM", {"manufacturers": "THREADLAB"}))

    print("\n7) valores vacíos se ignoran; el mapa de edición cubre los campos correctos")
    await expect_ok("campos vacíos no rompen", A("SPEKTRUM", {"styles": "", "colors": None}))
    check("_EDIT_IDENTITY_CTYPE cubre customer/manufacturer/description/country/fabric",
          set(w._EDIT_IDENTITY_CTYPE) == {"customer", "manufacturer", "description", "country_of_origin", "fabric_content"},
          f"{w._EDIT_IDENTITY_CTYPE}")

    print(f"\n{'='*56}\n   {ok} PASS / {fail} FAIL\n{'='*56}")
    sys.exit(1 if fail else 0)


asyncio.run(main())
