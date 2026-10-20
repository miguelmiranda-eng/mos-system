"""RETIRA el tablero SCREENS: Cuadros pasa a ser un MÓDULO (/cuadros) y un
componente en paralelo de la orden, no una etapa del flujo.

Antes:  BLANKS --(contado)--> SCREENS --(screens=true)--> NECK
Ahora:  BLANKS --(contado)--> NECK          y Cuadros trabaja en /cuadros lo
                                             que Planeación va a arrancar.

Qué hace:
  1. Órdenes en SCREENS:
       · preórdenes   → regresan a PRE-ORDENES con `art_ready_for_screens` (la
                        pestaña Preórdenes del módulo las muestra).
       · las demás    → NECK, también marcadas `art_ready_for_screens` (ya
                        habían salido de Arte: así siguen fuera de su
                        pendiente, como cuando estaban en SCREENS).
     Se mueven ANTES de quitar el tablero: borrarlo desde el CRM las mandaría
     a MASTER. Cada movimiento queda en la bitácora (activity_logs).
  2. Automatizaciones:
       · la que mueve BLANKS → SCREENS cambia su destino a NECK.
       · la que mueve SCREENS → NECK (screens=true) se APAGA (no se borra).
  3. Quita SCREENS de board_config (tableros, ocultos y sectores del menú).

Dry-run por defecto (NO escribe). Para aplicar:  --apply
Corre contra la base de backend/.env salvo que MONGO_URL/DB_NAME vengan en el
ambiente (así se prueba en una copia local primero).

USO
    backend/venv/Scripts/python.exe backend/scripts/retire_screens_board.py [--apply]
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
BOARD = "SCREENS"
TO_BOARD = "NECK"
PREORDER_BOARD = "PRE-ORDENES"
ACTOR = {"user_id": "system_retire_screens", "name": "Retiro tablero SCREENS", "email": None}

from deps import db  # noqa: E402


async def main():
    now = datetime.now(timezone.utc).isoformat()
    print(f"Base: {db.name}   modo: {'APLICAR' if APPLY else 'DRY-RUN'}\n")

    # 1) Órdenes en SCREENS
    orders = [o async for o in db.orders.find(
        {"board": BOARD}, {"_id": 0, "order_id": 1, "order_number": 1, "is_preorder": 1, "screens": 1})]
    print(f"1) Órdenes en {BOARD}: {len(orders)}")
    for o in orders:
        dest = PREORDER_BOARD if o.get("is_preorder") else TO_BOARD
        print(f"   #{o.get('order_number')}  screens={o.get('screens')}  → {dest}")
        if not APPLY:
            continue
        await db.orders.update_one({"order_id": o["order_id"]}, {"$set": {
            "board": dest, "art_ready_for_screens": True,
            "art_ready_for_screens_at": now, "updated_at": now}})
        await db.activity_logs.insert_one({
            "activity_id": f"act_{uuid.uuid4().hex[:12]}",
            "user_id": ACTOR["user_id"], "user_name": ACTOR["name"], "user_email": ACTOR["email"],
            "action": "move_order",
            "details": {"order_id": o["order_id"], "order_number": o.get("order_number"),
                        "from_board": BOARD, "to_board": dest,
                        "reason": "Retiro del tablero SCREENS (Cuadros es módulo)"},
            "previous_data": {"order_id": o["order_id"], "fields": {"board": BOARD}},
            "undoable": True, "undone": False, "timestamp": now})

    # 2) Automatizaciones
    print("\n2) Automatizaciones")
    async for a in db.automations.find({"action_type": "move_board"}, {"_id": 0}):
        target = (a.get("action_params") or {}).get("target_board")
        boards = a.get("boards") or []
        if target == BOARD:
            print(f"   '{a.get('name')}': destino {BOARD} → {TO_BOARD}")
            if APPLY:
                await db.automations.update_one({"automation_id": a["automation_id"]}, {"$set": {
                    "action_params.target_board": TO_BOARD, "updated_at": now}})
        elif boards == [BOARD] and a.get("is_active"):
            print(f"   '{a.get('name')}': sólo vivía en {BOARD} → se APAGA")
            if APPLY:
                await db.automations.update_one({"automation_id": a["automation_id"]}, {"$set": {
                    "is_active": False, "updated_at": now,
                    "disabled_reason": "Tablero SCREENS retirado (Cuadros es módulo)"}})
        elif BOARD in boards:
            print(f"   '{a.get('name')}': se quita {BOARD} de sus tableros")
            if APPLY:
                await db.automations.update_one({"automation_id": a["automation_id"]}, {
                    "$pull": {"boards": BOARD}, "$set": {"updated_at": now}})

    # 3) Tableros, ocultos y sectores
    print("\n3) board_config")
    for cid in ("boards", "hidden_boards"):
        doc = await db.board_config.find_one({"config_id": cid}, {"_id": 0})
        if doc and BOARD in (doc.get("boards") or []):
            print(f"   {cid}: se quita {BOARD}")
            if APPLY:
                await db.board_config.update_one({"config_id": cid}, {"$pull": {"boards": BOARD}})
    sec = await db.board_config.find_one({"config_id": "board_sectors"}, {"_id": 0})
    if sec:
        changed = False
        for s in sec.get("sectors") or []:
            if BOARD in (s.get("boards") or []):
                s["boards"] = [b for b in s["boards"] if b != BOARD]
                changed = True
                print(f"   sector '{s.get('name') or s.get('key')}': se quita {BOARD}")
        if changed and APPLY:
            await db.board_config.update_one({"config_id": "board_sectors"}, {"$set": {"sectors": sec["sectors"]}})

    left = await db.orders.count_documents({"board": BOARD})
    print(f"\nÓrdenes que quedan en {BOARD}: {left}")
    if not APPLY:
        print("DRY-RUN: no se escribió nada. Corre con --apply para aplicar.")


asyncio.run(main())
