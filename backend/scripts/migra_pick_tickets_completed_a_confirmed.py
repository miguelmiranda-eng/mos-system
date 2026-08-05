"""Unifica el vocabulario de cierre de pick tickets: status "completed" -> "confirmed".

POR QUÉ
Hasta el 19-jun-2026 un pick ticket se cerraba con `status="completed"`; desde
entonces se cierra con `"confirmed"`. Nadie migró los viejos, así que quedaron
342 documentos con la convención muerta. Eso partió el módulo en tres:
  · el guard de duplicados los tomaba por ABIERTOS y bloqueaba la orden,
  · el tablero los ocultaba (`picking_status == completed`),
  · la pestaña "Completadas" pide `status=confirmed`, así que tampoco los mostraba.
Resultado: 319 órdenes imposibles de surtir, invisibles y bloqueadas a la vez.

El bug ya está cerrado por código (TICKET_OPEN_QUERY es el único predicado, y los
reportes cuentan las dos convenciones). Esta migración es la limpieza final: deja
un solo vocabulario y devuelve esos tickets a la pestaña "Completadas", que es
donde el equipo espera encontrarlos.

SEGURO DE CORRER DESPUÉS DEL FIX, NO ANTES: si se corre con los reportes viejos
—que filtraban por `status == "completed"`— la productividad y el SLA se van a
cero.

Sólo toca `status`. `picking_status` ya es "completed" en los 342 y así se queda.

USO
    backend/venv/Scripts/python.exe backend/scripts/migra_pick_tickets_completed_a_confirmed.py
    backend/venv/Scripts/python.exe backend/scripts/migra_pick_tickets_completed_a_confirmed.py --apply
"""
import asyncio
import os
import sys
from datetime import datetime, timezone

BE = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
sys.path.insert(0, BE)

from dotenv import load_dotenv  # noqa: E402
load_dotenv(os.path.join(BE, ".env"))
from motor.motor_asyncio import AsyncIOMotorClient  # noqa: E402

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

DB_NAME = os.environ.get("DB_NAME", "mos-system")
APPLY = "--apply" in sys.argv
BACKUP = "wms_pick_tickets_legacy_completed"
Q = {"status": "completed"}


async def main():
    db = AsyncIOMotorClient(os.environ["MONGODB_URL"])[DB_NAME]
    T = db.wms_pick_tickets

    docs = await T.find(Q, {
        "_id": 0, "ticket_id": 1, "order_number": 1, "picking_status": 1,
        "created_at": 1, "completed_at": 1, "assigned_to_name": 1, "total_pick_qty": 1,
    }).to_list(5000)

    print(f"base : {DB_NAME}")
    print(f"tickets con status='completed' (convención vieja): {len(docs)}")
    if not docs:
        print("Nada que migrar.")
        return

    otro_picking = [d for d in docs if d.get("picking_status") != "completed"]
    sin_completed_at = [d for d in docs if not d.get("completed_at")]
    fechas = sorted((d.get("created_at") or "")[:10] for d in docs if d.get("created_at"))

    print(f"  rango de creación        : {fechas[0]} → {fechas[-1]}")
    print(f"  picking_status != completed : {len(otro_picking)}  (se espera 0)")
    print(f"  sin completed_at            : {len(sin_completed_at)}  "
          f"(no saldrán en productividad, que filtra por esa fecha)")

    if otro_picking:
        print("\n  OJO, éstos no encajan en el patrón esperado:")
        for d in otro_picking[:10]:
            print("     %s picking_status=%r" % (d["ticket_id"], d.get("picking_status")))

    ids = [d["ticket_id"] for d in docs]

    if not APPLY:
        print("\n[DRY-RUN] No se escribió nada. Corre con --apply para ejecutar.")
        return

    print(f"\nRespaldando {len(ids)} documentos completos en '{BACKUP}'…")
    await T.aggregate([{"$match": {"ticket_id": {"$in": ids}}}, {"$out": BACKUP}]).to_list(1)
    n_bak = await db[BACKUP].count_documents({})
    if n_bak != len(ids):
        sys.exit(f"ABORTADO: el respaldo tiene {n_bak} docs y esperaba {len(ids)}.")
    print(f"  respaldo verificado: {n_bak} documentos")

    ahora = datetime.now(timezone.utc).isoformat()
    res = await T.update_many(
        {"ticket_id": {"$in": ids}},
        {"$set": {"status": "confirmed",
                  "legacy_status": "completed",     # rastro de dónde venía
                  "legacy_status_migrated_at": ahora}},
    )
    print(f"  migrados a status='confirmed': {res.modified_count}")

    await db.wms_movements.insert_one({
        "movement_id": "mov_migra_legacy_completed",
        "type": "pick_tickets_status_migrado",
        "details": {"de": "completed", "a": "confirmed", "tickets": len(ids),
                    "backup": BACKUP},
        "user_id": None, "user_name": "migración (script)", "created_at": ahora,
    })

    quedan = await T.count_documents(Q)
    print(f"\nquedan con status='completed': {quedan}  (se espera 0)")
    print(f"Para revertir: restaurar desde '{BACKUP}'.")


asyncio.run(main())
