"""Smoke de regresión — /move-location debe ELIMINAR el renglón del origen
cuando sus cajas acaban de salir en esa misma operación.

INCIDENTE QUE BLINDA (2026-07-23, PS06-A04 → PS06-A06, 5000/BLACK/L)
────────────────────────────────────────────────────────────────────
La proyección de cajas del endpoint omitía country_of_origin/fabric_content,
así que ledger.row_signature(caja) daba ('','') y NUNCA coincidía con la firma
del renglón (NICARAGUA · 100%COTTON). El recálculo del origen trataba el
renglón como "saldo legado sin cajas" (pending_cycle_count, incidencia azul)
en vez de "residuo del movimiento" (eliminar): 194 unidades duplicadas en
papel en cada uso del flujo "mover todo el contenido".

SEGURIDAD: base DESECHABLE, se niega contra producción, se borra al terminar.

USO
───
    set MONGODB_URL=mongodb://usuario:clave@host:27017/?authSource=admin
    python backend/tests/smoke_wms_move_location_lote.py
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
os.environ.setdefault("ENV", "local")
sys.path.insert(0, BE)
os.chdir(BE)

import pymongo  # noqa: E402
from passlib.hash import bcrypt  # noqa: E402

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

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
    print(f"== Sembrando {SMOKE_DB} ==")
    for c in ["wms_inventory", "wms_boxes", "wms_locations", "wms_movements",
              "wms_incidents", "users", "user_sessions"]:
        sdb[c].delete_many({})
    for name in ["PS06-A04", "PS06-A06"]:
        sdb.wms_locations.insert_one({"name": name, "location_id": f"loc_{name}"})
    # El escenario real: renglón CON lote en el origen, 2 cajas del MISMO lote
    # (una llena, una en 0 — la vacía también viaja como documento) y además
    # material de OTRO lote en el destino para verificar que no se mezclan.
    sdb.wms_inventory.insert_one({
        "inventory_id": "inv_smoke_a04", "sku": "5000-BLACK-L", "style": "5000",
        "color": "BLACK", "size": "L", "location": "PS06-A04",
        "country_of_origin": "NICARAGUA", "fabric_content": "100% COTTON",
        "units_on_hand": 194, "total_boxes": 2, "units_allocated": 0,
    })
    sdb.wms_boxes.insert_many([
        {"box_id": "SMK-L1", "style": "5000", "sku": "5000-BLACK-L", "color": "BLACK",
         "size": "L", "location": "PS06-A04", "units": 122, "status": "located",
         "country_of_origin": "NICARAGUA", "fabric_content": "100% COTTON"},
        {"box_id": "SMK-L2", "style": "5000", "sku": "5000-BLACK-L", "color": "BLACK",
         "size": "L", "location": "PS06-A04", "units": 72, "status": "located",
         "country_of_origin": "NICARAGUA", "fabric_content": "100% COTTON"},
        {"box_id": "SMK-L0", "style": "5000", "sku": "5000-BLACK-L", "color": "BLACK",
         "size": "L", "location": "PS06-A04", "units": 0, "status": "depleted",
         "country_of_origin": "NICARAGUA", "fabric_content": "100% COTTON"},
    ])
    sdb.users.insert_one({
        "user_id": "u_smoke", "email": "smoke@test.local", "name": "Smoke Tester",
        "password_hash": bcrypt.hash("smoke123"),
        "role": "supersu", "admin_level": 5, "inventory_level": 5, "active": True,
    })


async def main():
    sembrar()
    from httpx import ASGITransport, AsyncClient
    from server import app

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://smoke") as c:
        r = await c.post("/api/auth/login",
                         json={"email": "smoke@test.local", "password": "smoke123"})
        check("login", r.status_code == 200, f"{r.status_code}")

        print("\n== Mover TODO el contenido A04 -> A06 ==")
        r = await c.post("/api/wms/move-location",
                         json={"from": "PS06-A04", "to": "PS06-A06"})
        check("move-location 200", r.status_code == 200, f"{r.status_code} {r.text[:200]}")

        origen = sdb.wms_inventory.find_one({"location": "PS06-A04", "style": "5000"})
        check("el renglón del ORIGEN se eliminó (sus cajas salieron en esta operación)",
              origen is None,
              f"sobrevivió: on_hand={origen.get('units_on_hand') if origen else '?'} "
              f"pending={origen.get('pending_cycle_count') if origen else '?'}")

        destino = sdb.wms_inventory.find_one({"location": "PS06-A06", "style": "5000"})
        check("el renglón del DESTINO existe con las unidades completas",
              destino is not None and destino.get("units_on_hand") == 194,
              f"{destino and destino.get('units_on_hand')}")
        check("total_boxes del destino = cajas CON material (2, la vacía no cuenta)",
              destino is not None and destino.get("total_boxes") == 2,
              f"{destino and destino.get('total_boxes')}")

        total = sum(r0.get("units_on_hand", 0) for r0 in sdb.wms_inventory.find({"style": "5000"}))
        check("conservación global: 194u en todo el sistema (sin duplicar)",
              total == 194, f"{total}")
        check("sin alarma roja en el caso sano",
              sdb.wms_incidents.count_documents({"kind": "saldo_sin_cajas_tras_movimiento"}) == 0)

        print("\n== Lote en CONFLICTO real (renglón HONDURAS, cajas NICARAGUA) ==")
        # Aquí el renglón NO debe borrarse (aduanas: pueden ser lotes distintos
        # de verdad) pero SÍ debe sonar la alarma ROJA para mandar conteo.
        sdb.wms_locations.insert_one({"name": "PS06-A08", "location_id": "loc_PS06-A08"})
        sdb.wms_inventory.insert_one({
            "inventory_id": "inv_smoke_hond", "sku": "3001-NAVY-M", "style": "3001",
            "color": "NAVY", "size": "M", "location": "PS06-A08",
            "country_of_origin": "HONDURAS", "fabric_content": "100% COTTON",
            "units_on_hand": 50, "total_boxes": 1, "units_allocated": 0,
        })
        sdb.wms_boxes.insert_one({
            "box_id": "SMK-N1", "style": "3001", "sku": "3001-NAVY-M", "color": "NAVY",
            "size": "M", "location": "PS06-A08", "units": 50, "status": "located",
            "country_of_origin": "NICARAGUA", "fabric_content": "100% COTTON",
        })
        r = await c.post("/api/wms/move-location",
                         json={"from": "PS06-A08", "to": "PS06-A06"})
        check("move-location 200", r.status_code == 200, f"{r.status_code}")
        hond = sdb.wms_inventory.find_one({"location": "PS06-A08", "style": "3001"})
        check("el renglón de OTRO lote sobrevive marcado a conteo (no se borra a ciegas)",
              hond is not None and hond.get("pending_cycle_count") is True,
              f"{hond and hond.get('pending_cycle_count')}")
        rojo = sdb.wms_incidents.find_one({"kind": "saldo_sin_cajas_tras_movimiento"})
        check("ALARMA ROJA registrada (saldo_sin_cajas_tras_movimiento)",
              rojo is not None and rojo.get("location") == "PS06-A08",
              f"{rojo and rojo.get('location')}")

        print("\n== Fantasma CUBIERTO por otro lote: se CONSOLIDA (no sólo marca) ==")
        # Renglón NICARAGUA sin cajas, pero el físico (REP. DOMINICANA) YA está
        # cubierto por su propio renglón respaldado -> el Nicaragua es papel
        # duplicado y debe consolidarse al reproyectar (caso del reporte
        # 2026-07-30 PS01-A07). Disparamos la reproyección con una edición de caja.
        sdb.wms_locations.insert_one({"name": "PS06-A11", "location_id": "loc_PS06-A11"})
        sdb.wms_inventory.insert_many([
            {"inventory_id": "inv_dup_rd", "sku": "5000-BLUE-M", "style": "5000",
             "color": "BLUE", "size": "M", "location": "PS06-A11",
             "country_of_origin": "REPUBLICA DOMINICANA", "fabric_content": "100% COTTON",
             "units_on_hand": 60, "total_boxes": 1, "units_allocated": 0},
            {"inventory_id": "inv_dup_nic", "sku": "5000-BLUE-M", "style": "5000",
             "color": "BLUE", "size": "M", "location": "PS06-A11",
             "country_of_origin": "NICARAGUA", "fabric_content": "100% COTTON",
             "units_on_hand": 60, "total_boxes": 1, "units_allocated": 0},  # FANTASMA
        ])
        sdb.wms_boxes.insert_one({
            "box_id": "SMK-RD1", "style": "5000", "sku": "5000-BLUE-M", "color": "BLUE",
            "size": "M", "location": "PS06-A11", "units": 60, "qty": 60,
            "status": "located", "country_of_origin": "REPUBLICA DOMINICANA",
            "fabric_content": "100% COTTON",
        })
        r = await c.put("/api/wms/boxes/SMK-RD1", json={"country_of_origin": "REPUBLICA DOMINICANA"})
        check("edit box 200", r.status_code == 200, f"{r.status_code} {r.text[:150]}")
        filas_dup = list(sdb.wms_inventory.find({"location": "PS06-A11", "style": "5000"}))
        check("el renglón fantasma NICARAGUA se CONSOLIDÓ (sólo queda el respaldado)",
              len(filas_dup) == 1 and filas_dup[0].get("country_of_origin") == "REPUBLICA DOMINICANA",
              f"{[(f.get('country_of_origin'), f.get('units_on_hand')) for f in filas_dup]}")
        check("conservación: papel de la celda = físico (60u)",
              sum(f.get("units_on_hand", 0) for f in filas_dup) == 60,
              f"{sum(f.get('units_on_hand', 0) for f in filas_dup)}")

        print("\n== Fantasma con ALLOCATION: NO se consolida (se respeta el picking) ==")
        sdb.wms_locations.insert_one({"name": "PS06-A12", "location_id": "loc_PS06-A12"})
        sdb.wms_inventory.insert_many([
            {"inventory_id": "inv_al_rd", "sku": "5000-GOLD-M", "style": "5000",
             "color": "GOLD", "size": "M", "location": "PS06-A12",
             "country_of_origin": "REPUBLICA DOMINICANA", "fabric_content": "100% COTTON",
             "units_on_hand": 60, "total_boxes": 1, "units_allocated": 0},
            {"inventory_id": "inv_al_nic", "sku": "5000-GOLD-M", "style": "5000",
             "color": "GOLD", "size": "M", "location": "PS06-A12",
             "country_of_origin": "NICARAGUA", "fabric_content": "100% COTTON",
             "units_on_hand": 60, "total_boxes": 1, "units_allocated": 20},  # comprometido
        ])
        sdb.wms_boxes.insert_one({
            "box_id": "SMK-GD1", "style": "5000", "sku": "5000-GOLD-M", "color": "GOLD",
            "size": "M", "location": "PS06-A12", "units": 60, "qty": 60,
            "status": "located", "country_of_origin": "REPUBLICA DOMINICANA",
            "fabric_content": "100% COTTON",
        })
        r = await c.put("/api/wms/boxes/SMK-GD1", json={"country_of_origin": "REPUBLICA DOMINICANA"})
        check("edit box 200", r.status_code == 200, f"{r.status_code}")
        nic = sdb.wms_inventory.find_one({"location": "PS06-A12", "country_of_origin": "NICARAGUA"})
        check("el fantasma con allocation NO se borró (va a conteo)",
              nic is not None and nic.get("pending_cycle_count") is True,
              f"{nic and nic.get('pending_cycle_count')}")

        print("\n== OLA 2: ajustar caja, borrar caja y putaway reescriben el marcador ==")
        sdb.wms_locations.insert_one({"name": "PS06-A09", "location_id": "loc_PS06-A09"})
        sdb.wms_inventory.insert_one({
            "inventory_id": "inv_smoke_w2", "sku": "5000-RED-S", "style": "5000",
            "color": "RED", "size": "S", "location": "PS06-A09",
            "country_of_origin": "HAITI", "fabric_content": "100% COTTON",
            "units_on_hand": 100, "total_boxes": 2, "units_allocated": 0,
        })
        for bid, u in [("SMK-W1", 60), ("SMK-W2", 40)]:
            sdb.wms_boxes.insert_one({
                "box_id": bid, "style": "5000", "sku": "5000-RED-S", "color": "RED",
                "size": "S", "location": "PS06-A09", "units": u, "qty": u,
                "status": "located", "country_of_origin": "HAITI",
                "fabric_content": "100% COTTON",
            })
        # 1) Ajuste por caja: conteo real 45 en SMK-W1 -> marcador 85 desde cajas.
        r = await c.post("/api/wms/boxes/SMK-W1/adjust",
                         json={"counted_units": 45, "reason": "smoke ola 2"})
        check("adjust 200", r.status_code == 200, f"{r.status_code} {r.text[:150]}")
        fila = sdb.wms_inventory.find_one({"location": "PS06-A09", "style": "5000"})
        check("marcador reescrito tras ajuste (85u/2c)",
              fila and fila.get("units_on_hand") == 85 and fila.get("total_boxes") == 2,
              f"{fila and (fila.get('units_on_hand'), fila.get('total_boxes'))}")
        # 2) Borrar caja: SMK-W2 fuera -> marcador 45/1c.
        r = await c.delete("/api/wms/boxes/SMK-W2")
        check("delete 200", r.status_code == 200, f"{r.status_code} {r.text[:150]}")
        fila = sdb.wms_inventory.find_one({"location": "PS06-A09", "style": "5000"})
        check("marcador reescrito tras borrar (45u/1c)",
              fila and fila.get("units_on_hand") == 45 and fila.get("total_boxes") == 1,
              f"{fila and (fila.get('units_on_hand'), fila.get('total_boxes'))}")
        # 3) Putaway bulk: SMK-W1 a PS06-A06 -> origen se elimina, destino nace.
        r = await c.post("/api/wms/putaway/bulk",
                         json={"assignments": [{"box_id": "SMK-W1", "location": "PS06-A06"}]})
        check("putaway 200", r.status_code == 200, f"{r.status_code} {r.text[:150]}")
        check("origen eliminado (sus cajas se fueron)",
              sdb.wms_inventory.find_one({"location": "PS06-A09", "style": "5000"}) is None)
        dst = sdb.wms_inventory.find_one({"location": "PS06-A06", "style": "5000",
                                          "color": "RED"})
        check("destino nace desde la caja (45u/1c, lote HAITI)",
              dst and dst.get("units_on_hand") == 45 and dst.get("total_boxes") == 1
              and dst.get("country_of_origin") == "HAITI",
              f"{dst and (dst.get('units_on_hand'), dst.get('total_boxes'), dst.get('country_of_origin'))}")


try:
    asyncio.run(main())
finally:
    raw.drop_database(SMOKE_DB)
    print(f"\n== Base {SMOKE_DB} eliminada ==")
    print(f"{ok} PASS · {fail} FAIL")
    sys.exit(1 if fail else 0)
