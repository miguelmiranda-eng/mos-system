"""Da de baja el backlog de pick tickets creados y nunca asignados.

QUÉ SE DA DE BAJA (y qué NO)
Sólo los tickets VÍRGENES: `status=pending`, `picking_status=unassigned`, sin
`deducted_map` y sin nada en `picked_sizes`, creados antes del corte.

Quedan FUERA a propósito:
  · Los que ya tienen stock descontado (`deducted_map`). Al desasignar un ticket
    el avance se conserva a propósito (ver assign_pick_ticket), así que un
    "unassigned" puede traer unidades ya rebajadas del inventario. Cancelarlo sin
    devolver el saldo deja ese stock descontado contra un ticket muerto — es
    justo como se fabrica inventario fantasma.
  · Los posteriores al corte, que son el flujo normal: se crean sin asignar y se
    reparten después.

La baja usa status="cancelled", que TICKET_OPEN_QUERY ya excluye: el ticket sale
del tablero y deja de bloquear la creación, y la orden vuelve a aparecer como
pre-ticket virtual para recrearla. Es reversible — el respaldo queda en una
colección aparte y el documento conserva todos sus campos.

USO
    backend/venv/Scripts/python.exe backend/scripts/baja_pick_tickets_sin_asignar.py
    backend/venv/Scripts/python.exe backend/scripts/baja_pick_tickets_sin_asignar.py --apply
"""
import asyncio
import os
import sys

BE = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
sys.path.insert(0, BE)

from dotenv import load_dotenv  # noqa: E402
load_dotenv(os.path.join(BE, ".env"))
from motor.motor_asyncio import AsyncIOMotorClient  # noqa: E402

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

CORTE = os.environ.get("CORTE", "2026-08-01")   # created_at < CORTE
DB_NAME = os.environ.get("DB_NAME", "mos-system")
APPLY = "--apply" in sys.argv
BACKUP = f"wms_pick_tickets_baja_{CORTE.replace('-', '')}"
MOTIVO = "backlog sin asignar dado de baja"


def _picked(t):
    return sum(int((v.get("total") if isinstance(v, dict) else v) or 0)
               for v in (t.get("picked_sizes") or {}).values())


def _flat(m):
    total = 0
    for v in (m or {}).values():
        if isinstance(v, dict):
            total += sum(int(x or 0) for x in v.values() if not isinstance(x, dict))
        else:
            total += int(v or 0)
    return total


async def main():
    db = AsyncIOMotorClient(os.environ["MONGODB_URL"])[DB_NAME]
    T = db.wms_pick_tickets

    candidatos = await T.find(
        {"status": "pending", "picking_status": "unassigned"},
        {"_id": 0, "ticket_id": 1, "order_number": 1, "created_at": 1, "customer": 1,
         "style": 1, "color": 1, "total_pick_qty": 1, "picked_sizes": 1, "deducted_map": 1},
    ).to_list(5000)

    virgenes, tocados = [], []
    for d in candidatos:
        (tocados if (d.get("deducted_map") or _picked(d) > 0) else virgenes).append(d)

    objetivo = [d for d in virgenes if (d.get("created_at") or "") < CORTE]
    conservados = [d for d in virgenes if (d.get("created_at") or "") >= CORTE]

    print(f"base           : {DB_NAME}")
    print(f"corte          : created_at < {CORTE}")
    print(f"pending/unassigned total : {len(candidatos)}")
    print(f"  vírgenes                : {len(virgenes)}")
    print(f"  con stock descontado    : {len(tocados)}  "
          f"({_flat_total(tocados)} unidades)  -> NO SE TOCAN")
    print(f"  vírgenes posteriores al corte : {len(conservados)}  -> NO SE TOCAN")
    print()
    print(f"A DAR DE BAJA  : {len(objetivo)}")

    if not objetivo:
        print("Nada que hacer.")
        return

    unidades = sum(int(d.get("total_pick_qty") or 0) for d in objetivo)
    print(f"unidades solicitadas en esos tickets (nunca surtidas): {unidades}")
    print("\nmuestra:")
    for d in sorted(objetivo, key=lambda x: x.get("created_at") or "")[:10]:
        print("   %s ord=%-9s %-18s %s/%s qty=%-6s %s" % (
            d["ticket_id"], d.get("order_number"), (d.get("customer") or "")[:18],
            (d.get("style") or "-")[:9], (d.get("color") or "-")[:10],
            d.get("total_pick_qty"), (d.get("created_at") or "")[:10]))

    ids = [d["ticket_id"] for d in objetivo]

    if not APPLY:
        print(f"\n[DRY-RUN] No se escribió nada. Corre con --apply para ejecutar.")
        return

    # Respaldo server-side ($out: no viaja el resultado por la red).
    print(f"\nRespaldando {len(ids)} documentos completos en '{BACKUP}'…")
    await T.aggregate([{"$match": {"ticket_id": {"$in": ids}}},
                       {"$out": BACKUP}]).to_list(1)
    n_bak = await db[BACKUP].count_documents({})
    if n_bak != len(ids):
        sys.exit(f"ABORTADO: el respaldo tiene {n_bak} docs y esperaba {len(ids)}.")
    print(f"  respaldo verificado: {n_bak} documentos")

    ahora = __import__("datetime").datetime.now(
        __import__("datetime").timezone.utc).isoformat()
    res = await T.update_many(
        {"ticket_id": {"$in": ids}},
        {"$set": {"status": "cancelled", "cancelled_at": ahora,
                  "cancelled_by_name": "baja masiva (script)",
                  "cancelled_reason": MOTIVO, "cancelled_backup": BACKUP}},
    )
    print(f"  tickets dados de baja: {res.modified_count}")

    await db.wms_movements.insert_one({
        "movement_id": f"mov_baja_{CORTE.replace('-', '')}",
        "type": "pick_tickets_baja_masiva",
        "details": {"motivo": MOTIVO, "corte": CORTE, "tickets": len(ids),
                    "unidades": unidades, "backup": BACKUP},
        "user_id": None, "user_name": "baja masiva (script)", "created_at": ahora,
    })

    quedan = await T.count_documents({"status": "pending", "picking_status": "unassigned"})
    print(f"\npending/unassigned restantes: {quedan} "
          f"({len(tocados)} con stock descontado + {len(conservados)} recientes)")
    print(f"Para revertir: restaurar desde la colección '{BACKUP}'.")


def _flat_total(docs):
    return sum(_flat(d.get("deducted_map")) for d in docs)


asyncio.run(main())
