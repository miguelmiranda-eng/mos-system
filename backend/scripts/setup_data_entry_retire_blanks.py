"""Crea el tablero DATA ENTRY y RETIRA el tablero BLANKS (Blanks ya es módulo).

Modelo de módulos: las órdenes ya no viajan por tableros de preparación.
  DATA ENTRY  entrada/captura (lo que antes hacía SCHEDULING): Printavo, alta
              manual e import crean aquí (deps.intake_board). Data entry
              selecciona las órdenes y las manda a SCHEDULING (a mano).
  SCHEDULING  maestro de órdenes en preparación: ahí se quedan mientras los
              módulos (Blanks, Cuadros, Neck…) llenan sus componentes.

Qué hace (en este orden):
  1. board_config: agrega DATA ENTRY antes de SCHEDULING; quita BLANKS (de la
     lista, de ocultos y de los sectores del menú si están guardados).
  2. Órdenes: SCHEDULING → DATA ENTRY (eran entrada) y luego BLANKS →
     SCHEDULING (ya están en preparación). Cada movimiento va a la bitácora.
  3. Automatizaciones: donde decía BLANKS ahora dice SCHEDULING (p. ej. "mover
     a cuadros": blank CONTADO → NECK ya sale de SCHEDULING); donde decía
     SCHEDULING también aplica a DATA ENTRY (eran reglas de entrada).
  4. Apaga el barrido automático SCHEDULING → BLANKS (blanks_sweep).
  5. planner_config.demand_boards guardado: agrega DATA ENTRY.
  6. Permisos por tablero: quien tenía permiso en SCHEDULING lo tiene igual en
     DATA ENTRY.

Dry-run por defecto (NO escribe). Para aplicar:  --apply
Corre contra la base de backend/.env salvo que MONGO_URL/DB_NAME vengan en el
ambiente (así se prueba en una copia local primero).

USO
    backend/venv/Scripts/python.exe backend/scripts/setup_data_entry_retire_blanks.py [--apply]
"""
import asyncio
import os
import sys
import uuid
from datetime import datetime, timezone

BE = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
sys.path.insert(0, BE)
os.chdir(BE)
os.environ.setdefault("MASTER_API_KEY", "migration")
os.environ.setdefault("INTERNAL_SYNC_TOKEN", "migration")
os.environ.setdefault("JWT_SECRET", "migration")
os.environ.setdefault("ENV", "local")
os.environ.setdefault("DISABLE_SCHEDULERS", "1")
from dotenv import load_dotenv  # noqa: E402
load_dotenv(os.path.join(BE, ".env"))

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

APPLY = "--apply" in sys.argv
INTAKE, PREP, RETIRED = "DATA ENTRY", "SCHEDULING", "BLANKS"
ACTOR = {"user_id": "system_setup_data_entry", "name": "Alta DATA ENTRY / retiro BLANKS", "email": None}

from deps import db  # noqa: E402


async def _move(board_from: str, board_to: str, now: str, reason: str) -> int:
    orders = [o async for o in db.orders.find({"board": board_from}, {"_id": 0, "order_id": 1, "order_number": 1})]
    print(f"   {board_from} → {board_to}: {len(orders)} órdenes")
    if not APPLY:
        return len(orders)
    for o in orders:
        await db.orders.update_one({"order_id": o["order_id"]}, {"$set": {"board": board_to, "updated_at": now}})
        await db.activity_logs.insert_one({
            "activity_id": f"act_{uuid.uuid4().hex[:12]}",
            "user_id": ACTOR["user_id"], "user_name": ACTOR["name"], "user_email": ACTOR["email"],
            "action": "move_order",
            "details": {"order_id": o["order_id"], "order_number": o.get("order_number"),
                        "from_board": board_from, "to_board": board_to, "reason": reason},
            "previous_data": {"order_id": o["order_id"], "fields": {"board": board_from}},
            "undoable": True, "undone": False, "timestamp": now})
    return len(orders)


async def main():
    now = datetime.now(timezone.utc).isoformat()
    print(f"Base: {db.name}   modo: {'APLICAR' if APPLY else 'DRY-RUN'}\n")

    # 1) Tableros
    print("1) board_config")
    doc = await db.board_config.find_one({"config_id": "boards"}, {"_id": 0}) or {}
    boards = list(doc.get("boards") or [])
    new = []
    for b in boards:
        if b == PREP and INTAKE not in boards:
            new.append(INTAKE)
        if b != RETIRED:
            new.append(b)
    if INTAKE not in new:
        new.insert(1, INTAKE)
    print(f"   tableros: {'+' + INTAKE if INTAKE not in boards else INTAKE + ' ya existe'}, "
          f"{'-' + RETIRED if RETIRED in boards else RETIRED + ' ya no estaba'}")
    hidden = await db.board_config.find_one({"config_id": "hidden_boards"}, {"_id": 0}) or {}
    sec = await db.board_config.find_one({"config_id": "board_sectors"}, {"_id": 0})
    if sec:
        for s in sec.get("sectors") or []:
            bs = [b for b in (s.get("boards") or []) if b != RETIRED]
            if PREP in bs and INTAKE not in bs:
                bs.insert(bs.index(PREP), INTAKE)
            s["boards"] = bs
        print("   sectores guardados: se ajustan (DATA ENTRY junto a SCHEDULING, sin BLANKS)")

    # 2) Órdenes (primero liberar SCHEDULING, luego llenarlo con BLANKS)
    print("\n2) Órdenes")
    await _move(PREP, INTAKE, now, "Alta de DATA ENTRY: SCHEDULING era la entrada de órdenes")
    await _move(RETIRED, PREP, now, "Retiro del tablero BLANKS (Blanks es módulo; SCHEDULING es el maestro)")

    # 3) Automatizaciones
    print("\n3) Automatizaciones")
    async for a in db.automations.find({}, {"_id": 0}):
        orig = list(a.get("boards") or [])
        nb = []
        for b in orig:
            for x in ([INTAKE, PREP] if b == PREP else [PREP] if b == RETIRED else [b]):
                if x not in nb:
                    nb.append(x)
        target = (a.get("action_params") or {}).get("target_board")
        sets = {}
        if nb != orig:
            sets["boards"] = nb
            print(f"   '{a.get('name')}': tableros {orig} → {nb}")
        if target == RETIRED:
            sets["action_params.target_board"] = PREP
            print(f"   '{a.get('name')}': destino {RETIRED} → {PREP}")
        if sets and APPLY:
            sets["updated_at"] = now
            await db.automations.update_one({"automation_id": a["automation_id"]}, {"$set": sets})

    # 4) Barrido SCHEDULING → BLANKS
    sweep = await db.automation_config.find_one({"config_id": "blanks_sweep"}, {"_id": 0, "enabled": 1})
    print(f"\n4) Barrido SCHEDULING → BLANKS: {'encendido → se APAGA' if (sweep or {}).get('enabled') else 'ya apagado'}")
    if APPLY and sweep:
        await db.automation_config.update_one({"config_id": "blanks_sweep"}, {"$set": {
            "enabled": False, "disabled_reason": "Tablero BLANKS retirado (Blanks es módulo)", "updated_at": now}})

    # 5) Planner
    pc = await db.planner_config.find_one({"config_id": "main"}, {"_id": 0, "demand_boards": 1})
    if pc and pc.get("demand_boards") and INTAKE not in pc["demand_boards"]:
        print(f"\n5) planner demand_boards: + {INTAKE}")
        if APPLY:
            await db.planner_config.update_one({"config_id": "main"}, {"$set": {
                "demand_boards": [INTAKE] + list(pc["demand_boards"])}})
    else:
        print("\n5) planner demand_boards: sin cambio")

    # 6) Permisos por tablero
    n = 0
    async for p in db.board_permissions.find({f"permissions.{PREP}": {"$exists": True}}, {"_id": 0}):
        if INTAKE not in (p.get("permissions") or {}):
            n += 1
            if APPLY:
                await db.board_permissions.update_one({"email": p["email"]}, {"$set": {
                    f"permissions.{INTAKE}": p["permissions"][PREP]}})
    print(f"\n6) permisos: {n} usuarios heredan su permiso de SCHEDULING en DATA ENTRY")

    if APPLY:
        await db.board_config.update_one({"config_id": "boards"}, {"$set": {"boards": new}}, upsert=True)
        if RETIRED in (hidden.get("boards") or []):
            await db.board_config.update_one({"config_id": "hidden_boards"}, {"$pull": {"boards": RETIRED}})
        if sec:
            await db.board_config.update_one({"config_id": "board_sectors"}, {"$set": {"sectors": sec["sectors"]}})

    left = await db.orders.count_documents({"board": RETIRED})
    print(f"\nÓrdenes que quedan en {RETIRED}: {left}")
    if not APPLY:
        print("DRY-RUN: no se escribió nada. Corre con --apply para aplicar.")


asyncio.run(main())
