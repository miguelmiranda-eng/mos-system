"""RETIRA los tableros MASTER y COMPLETOS: SCHEDULING es el maestro nuevo.

Modelo de módulos: las órdenes ya no viajan por tableros de preparación.
SCHEDULING hereda todo lo de MASTER (vista de TODAS las órdenes vivas, estén
en el tablero que estén; ver orders._is_master_view) y una pestaña separa las
órdenes ABIERTAS de las COMPLETAS (por estatus: LISTO PARA ENVIO / LISTO PARA
FULFILLMENT). Por eso COMPLETOS sobra.

Qué hace:
  1. Órdenes en COMPLETOS → SCHEDULING (bitácora). MASTER no tiene órdenes
     (es una vista), sólo se quita de la lista.
  2. Automatizaciones: destino COMPLETOS → SCHEDULING (al quedar LISTO PARA
     ENVIO la orden regresa al maestro, sale de su máquina/empaque); en sus
     tableros, COMPLETOS → SCHEDULING y se quita MASTER (no es un tablero real).
  3. board_config: quita MASTER y COMPLETOS (lista, ocultos y sectores).

Dry-run por defecto (NO escribe). Para aplicar:  --apply
Corre contra la base de backend/.env salvo que MONGO_URL/DB_NAME vengan en el
ambiente (así se prueba en una copia local primero).

USO
    backend/venv/Scripts/python.exe backend/scripts/retire_master_completos.py [--apply]
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
MASTER, DONE_BOARD, PREP = "MASTER", "COMPLETOS", "SCHEDULING"
RETIRED = {MASTER, DONE_BOARD}
ACTOR = {"user_id": "system_retire_master", "name": "Retiro MASTER / COMPLETOS", "email": None}

from deps import db  # noqa: E402


async def main():
    now = datetime.now(timezone.utc).isoformat()
    print(f"Base: {db.name}   modo: {'APLICAR' if APPLY else 'DRY-RUN'}\n")

    # 1) Órdenes
    orders = [o async for o in db.orders.find({"board": DONE_BOARD},
                                              {"_id": 0, "order_id": 1, "order_number": 1, "production_status": 1})]
    print(f"1) Órdenes {DONE_BOARD} → {PREP}: {len(orders)}")
    stray = await db.orders.count_documents({"board": MASTER})
    if stray:
        print(f"   (!) {stray} órdenes con board=MASTER → también a {PREP}")
        orders += [o async for o in db.orders.find({"board": MASTER}, {"_id": 0, "order_id": 1, "order_number": 1})]
    if APPLY:
        for o in orders:
            src = (await db.orders.find_one({"order_id": o["order_id"]}, {"_id": 0, "board": 1}) or {}).get("board")
            await db.orders.update_one({"order_id": o["order_id"]}, {"$set": {"board": PREP, "updated_at": now}})
            await db.activity_logs.insert_one({
                "activity_id": f"act_{uuid.uuid4().hex[:12]}",
                "user_id": ACTOR["user_id"], "user_name": ACTOR["name"], "user_email": ACTOR["email"],
                "action": "move_order",
                "details": {"order_id": o["order_id"], "order_number": o.get("order_number"),
                            "from_board": src, "to_board": PREP,
                            "reason": "Retiro de COMPLETOS: SCHEDULING es el maestro (pestaña Completas)"},
                "previous_data": {"order_id": o["order_id"], "fields": {"board": src}},
                "undoable": True, "undone": False, "timestamp": now})

    # 2) Automatizaciones
    print("\n2) Automatizaciones")
    async for a in db.automations.find({}, {"_id": 0}):
        orig = list(a.get("boards") or [])
        nb = []
        for b in orig:
            x = PREP if b == DONE_BOARD else None if b == MASTER else b
            if x and x not in nb:
                nb.append(x)
        target = (a.get("action_params") or {}).get("target_board")
        sets = {}
        if nb != orig:
            sets["boards"] = nb
            print(f"   '{a.get('name')}': tableros −{sorted(set(orig) & RETIRED)}"
                  f"{' +SCHEDULING' if DONE_BOARD in orig and PREP not in orig else ''}")
        if target in RETIRED:
            sets["action_params.target_board"] = PREP
            print(f"   '{a.get('name')}': destino {target} → {PREP}")
        if sets and APPLY:
            sets["updated_at"] = now
            await db.automations.update_one({"automation_id": a["automation_id"]}, {"$set": sets})

    # 3) Tableros
    print("\n3) board_config")
    doc = await db.board_config.find_one({"config_id": "boards"}, {"_id": 0}) or {}
    boards = list(doc.get("boards") or [])
    print(f"   se quitan: {[b for b in boards if b in RETIRED] or 'nada (ya no estaban)'}")
    sec = await db.board_config.find_one({"config_id": "board_sectors"}, {"_id": 0})
    if APPLY:
        await db.board_config.update_one({"config_id": "boards"}, {"$set": {"boards": [b for b in boards if b not in RETIRED]}})
        await db.board_config.update_one({"config_id": "hidden_boards"}, {"$pull": {"boards": {"$in": list(RETIRED)}}})
        if sec:
            for s in sec.get("sectors") or []:
                s["boards"] = [b for b in (s.get("boards") or []) if b not in RETIRED]
            await db.board_config.update_one({"config_id": "board_sectors"}, {"$set": {"sectors": sec["sectors"]}})

    left = await db.orders.count_documents({"board": {"$in": list(RETIRED)}})
    print(f"\nÓrdenes que quedan en MASTER/COMPLETOS: {left}")
    if not APPLY:
        print("DRY-RUN: no se escribió nada. Corre con --apply para aplicar.")


asyncio.run(main())
