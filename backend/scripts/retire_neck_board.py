"""RETIRA el tablero NECK: lo reemplaza el módulo /neck (routers/neck.py).

El módulo toma las órdenes por su estatus de label (NECESITA LABEL / PROCESO DE
NECK LABEL / PROCESO DE LABEL), estén en el tablero que estén; la orden ya no
viaja a NECK.

Qué hace:
  1. Órdenes en NECK → SCHEDULING (bitácora, deshacible).
  2. Automatizaciones: destino NECK → SCHEDULING ("mover a cuadros": CONTADO
     deja la orden en el maestro); en sus tableros, NECK → SCHEDULING.
  3. board_config: quita NECK (lista, ocultos y sectores) y de
     planner_config.demand_boards.
  Con --apply guarda ANTES un respaldo JSON en backend/scripts/ (sin commit).

Dry-run por defecto (NO escribe). Para aplicar:  --apply
Corre contra la base de backend/.env salvo que MONGO_URL/DB_NAME vengan en el
ambiente (así se prueba en una copia local primero).

USO
    backend/venv/Scripts/python.exe backend/scripts/retire_neck_board.py [--apply]
"""
import asyncio
import json
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
OLD, PREP = "NECK", "SCHEDULING"
ACTOR = {"user_id": "system_retire_neck", "name": "Retiro NECK", "email": None}

from deps import db  # noqa: E402


async def main():
    now = datetime.now(timezone.utc).isoformat()
    print(f"Base: {db.name}   modo: {'APLICAR' if APPLY else 'DRY-RUN'}\n")

    orders = [o async for o in db.orders.find({"board": OLD},
                                              {"_id": 0, "order_id": 1, "order_number": 1, "production_status": 1})]
    autos = [a async for a in db.automations.find(
        {"$or": [{"boards": OLD}, {"action_params.target_board": OLD}]}, {"_id": 0})]
    bc = await db.board_config.find_one({"config_id": "boards"}, {"_id": 0}) or {}
    hidden = await db.board_config.find_one({"config_id": "hidden_boards"}, {"_id": 0})
    sec = await db.board_config.find_one({"config_id": "board_sectors"}, {"_id": 0})
    pcfg = await db.planner_config.find_one({}, {"_id": 0, "demand_boards": 1}) or {}

    if APPLY:
        path = os.path.join(BE, "scripts", f"backup_retiro_neck_{db.name}_{now[:10]}.json")
        with open(path, "w", encoding="utf-8") as f:
            json.dump({"orders": orders, "automations": autos, "board_config": bc, "hidden_boards": hidden,
                       "board_sectors": sec, "planner_demand_boards": pcfg.get("demand_boards")},
                      f, ensure_ascii=False, default=str, indent=1)
        print(f"Respaldo: {path}\n")

    # 1) Órdenes
    print(f"1) Órdenes {OLD} → {PREP}: {len(orders)}")
    for o in orders:
        print(f"   #{o.get('order_number')}  {o.get('production_status') or '-'}")
        if APPLY:
            await db.orders.update_one({"order_id": o["order_id"]}, {"$set": {"board": PREP, "updated_at": now}})
            await db.activity_logs.insert_one({
                "activity_id": f"act_{uuid.uuid4().hex[:12]}",
                "user_id": ACTOR["user_id"], "user_name": ACTOR["name"], "user_email": ACTOR["email"],
                "action": "move_order",
                "details": {"order_id": o["order_id"], "order_number": o.get("order_number"),
                            "from_board": OLD, "to_board": PREP,
                            "reason": "Retiro de NECK: lo reemplaza el módulo /neck"},
                "previous_data": {"order_id": o["order_id"], "fields": {"board": OLD}},
                "undoable": True, "undone": False, "timestamp": now})

    # 2) Automatizaciones
    print("\n2) Automatizaciones")
    if not autos:
        print("   ninguna toca NECK")
    for a in autos:
        orig = list(a.get("boards") or [])
        nb = []
        for b in orig:
            x = PREP if b == OLD else b
            if x not in nb:
                nb.append(x)
        sets = {}
        if nb != orig:
            sets["boards"] = nb
        if (a.get("action_params") or {}).get("target_board") == OLD:
            sets["action_params.target_board"] = PREP
        print(f"   '{a.get('name')}' ({'activa' if a.get('is_active', a.get('enabled', True)) else 'inactiva'}): "
              f"{a.get('trigger_type') or ''} {json.dumps(a.get('trigger_conditions') or a.get('conditions') or {}, ensure_ascii=False)[:120]}")
        if "boards" in sets:
            print(f"      tableros {orig} → {nb}")
        if "action_params.target_board" in sets:
            print(f"      destino {OLD} → {PREP}")
        if sets and APPLY:
            sets["updated_at"] = now
            await db.automations.update_one({"automation_id": a["automation_id"]}, {"$set": sets})

    # 3) Tableros
    print("\n3) board_config / planner")
    print(f"   lista: {'se quita' if OLD in (bc.get('boards') or []) else 'ya no estaba'}")
    print(f"   planner demand_boards: {'se quita' if OLD in (pcfg.get('demand_boards') or []) else 'no lo tiene'}")
    if APPLY:
        await db.board_config.update_one({"config_id": "boards"}, {"$pull": {"boards": OLD}})
        await db.board_config.update_one({"config_id": "hidden_boards"}, {"$pull": {"boards": OLD}})
        if sec:
            for s in sec.get("sectors") or []:
                s["boards"] = [b for b in (s.get("boards") or []) if b != OLD]
            await db.board_config.update_one({"config_id": "board_sectors"}, {"$set": {"sectors": sec["sectors"]}})
        if OLD in (pcfg.get("demand_boards") or []):
            await db.planner_config.update_many({}, {"$pull": {"demand_boards": OLD}})

    left = await db.orders.count_documents({"board": OLD})
    print(f"\nÓrdenes que quedan en {OLD}: {left}")
    if not APPLY:
        print("DRY-RUN: no se escribió nada. Corre con --apply para aplicar.")


asyncio.run(main())
