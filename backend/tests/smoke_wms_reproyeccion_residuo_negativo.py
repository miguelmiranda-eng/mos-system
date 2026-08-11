"""Smoke de regresión — la reproyección elimina renglones NEGATIVOS residuales.

INCIDENTE QUE BLINDA (2026-08-11, 11 renglones en negativo en producción)
─────────────────────────────────────────────────────────────────────────
Bajas de papel aplicadas a celdas cuyas cajas ya se habían ido (o bajo otra
identidad de lote) dejaron renglones de wms_inventory con units_on_hand
negativo (hasta -494u). Las ramas de consolidación y de conteo de
_reproject_material_rows exigían units_on_hand > 0, así que un renglón
negativo no matcheaba NINGUNA y quedaba eterno — el inventario mostraba
material en negativo para siempre.

Lo que se fija aquí:
  A. residuo negativo puro (sin cajas, sin allocation)  -> se ELIMINA
  B. par de identidades (negativo + positivo respaldado) -> negativo fuera,
     el respaldado queda intacto en la verdad de cajas
  C. negativo CON allocation comprometida               -> NO se toca
  D. positivo huérfano sin respaldo                     -> NO se borra;
     va a pending_cycle_count (política existente, no regresionar)

SEGURIDAD: base DESECHABLE, se niega contra producción, se borra al terminar.

USO
───
    set MONGODB_URL=mongodb://usuario:clave@host:27017/?authSource=admin
    python backend/tests/smoke_wms_reproyeccion_residuo_negativo.py
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


def fila(loc, coo, fabric, units, boxes, alloc=0, inv_id=None):
    return {
        "inventory_id": inv_id or f"inv_{loc}_{coo or 'sin'}",
        "sku": "3001-X", "style": "3001", "color": "BLACK", "size": "M",
        "location": loc, "country_of_origin": coo, "fabric_content": fabric,
        "units_on_hand": units, "total_boxes": boxes, "units_allocated": alloc,
        "updated_at": "2026-08-11T00:00:00+00:00",
    }


def sembrar():
    print(f"== Sembrando {SMOKE_DB} ==")
    for c in ["wms_inventory", "wms_boxes", "wms_incidents"]:
        sdb[c].delete_many({})
    # A: residuo negativo puro — la forma de 53077-02 (-494u, sin cajas)
    sdb.wms_inventory.insert_one(fila("LOC-NEG", "BANGLADESH", "52% COTTON 48% POLYESTER", -494, -7))
    # B: par de identidades — la forma de 53077-04
    sdb.wms_inventory.insert_one(fila("LOC-PAR", "PAKISTAN", "52% COMBED COTTON 48% POLYESTER", 71, 1))
    sdb.wms_inventory.insert_one(fila("LOC-PAR", "BANGLADESH", "52% COTTON 48% POLYESTER", -71, -1))
    sdb.wms_boxes.insert_one({
        "box_id": "BX-PAR-1", "sku": "3001-X", "style": "3001", "color": "BLACK",
        "size": "M", "location": "LOC-PAR", "units": 71, "qty": 71,
        "country_of_origin": "PAKISTAN", "fabric_content": "52% COMBED COTTON 48% POLYESTER",
        "status": "stored",
    })
    # C: negativo con allocation comprometida — no debe tocarse
    sdb.wms_inventory.insert_one(fila("LOC-ALLOC", "NICARAGUA", "100% COTTON", -5, -1, alloc=3))
    # D: positivo huérfano — política existente: conteo, no borrado
    sdb.wms_inventory.insert_one(fila("LOC-ORF", "BANGLADESH", "60% COTTON 40% POLYESTER", 72, 1))


async def main():
    sembrar()
    from routers.wms import _reproject_material_rows

    print("\n== reproyectando las 4 celdas ==")
    for loc in ["LOC-NEG", "LOC-PAR", "LOC-ALLOC", "LOC-ORF"]:
        await _reproject_material_rows("3001", "3001-X", "BLACK", "M", loc)

    print("\n== A: residuo negativo puro ==")
    a = list(sdb.wms_inventory.find({"location": "LOC-NEG"}))
    check("el renglón de -494u fue eliminado", len(a) == 0, f"{len(a)} filas")

    print("\n== B: par de identidades ==")
    b = list(sdb.wms_inventory.find({"location": "LOC-PAR"}, {"_id": 0}))
    check("queda exactamente 1 renglón", len(b) == 1, f"{len(b)} filas")
    if len(b) == 1:
        check("es el lote PAKISTAN respaldado por la caja",
              b[0]["country_of_origin"] == "PAKISTAN", b[0]["country_of_origin"])
        check("con 71u / 1 caja (verdad de cajas)",
              b[0]["units_on_hand"] == 71 and b[0]["total_boxes"] == 1,
              f"{b[0]['units_on_hand']}u/{b[0]['total_boxes']}c")

    print("\n== C: negativo con allocation ==")
    c = sdb.wms_inventory.find_one({"location": "LOC-ALLOC"}, {"_id": 0})
    check("NO se tocó (allocation comprometida)",
          c is not None and c["units_on_hand"] == -5 and c["units_allocated"] == 3,
          str(c))

    print("\n== D: positivo huérfano (política de conteo intacta) ==")
    d = sdb.wms_inventory.find_one({"location": "LOC-ORF"}, {"_id": 0})
    check("NO se borró", d is not None, "fila eliminada")
    if d:
        check("quedó marcado pending_cycle_count", d.get("pending_cycle_count") is True, str(d.get("pending_cycle_count")))
        check("conserva sus 72u", d["units_on_hand"] == 72, f"{d['units_on_hand']}u")


_err = None
try:
    asyncio.run(main())
except Exception:
    import traceback
    _err = traceback.format_exc()
finally:
    try:
        raw.drop_database(SMOKE_DB)
    except Exception:
        pass
    print(f"\n== Base {SMOKE_DB} eliminada ==")
    if _err:
        print("EXCEPCIÓN:\n" + _err)
    print(f"{ok} PASS · {fail} FAIL")
    sys.exit(1 if (fail or _err) else 0)
