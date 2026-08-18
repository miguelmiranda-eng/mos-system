"""Rellena `production_status_at` con la fecha REAL del último cambio de estatus.

POR QUÉ EXISTE
──────────────
La columna "Fecha de estatus" del módulo de Final Bill nace de un campo que se
empezó a escribir el día que se desplegó el sello (routers/orders.py). Sin este
backfill la columna saldría vacía para las ~1,700 órdenes que YA estaban en
LISTO PARA ENVIO / LISTO PARA INVENTARIO, que son justamente las que el
encargado necesita ver.

El dato NO se inventa: sale de `activity_logs`, donde cada `update_order`
guarda `details.changes.production_status = {from, to}` con su timestamp. Se
toma el evento MÁS RECIENTE que dejó a la orden en el estado que hoy tiene.

Una orden sin evento en el log (cambiada antes de que se registrara, o migrada
de Monday) se queda SIN fecha a propósito: la columna dirá "—". Poner ahí
`created_at` o `updated_at` sería inventar una fecha de estatus que nadie
midió, y este módulo existe justamente para saber desde cuándo lleva parada
una orden.

Uso:
    python backend/scripts/backfill_production_status_at.py          # simulacro
    python backend/scripts/backfill_production_status_at.py --apply  # escribe
"""
import asyncio
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from deps import db  # noqa: E402

TARGET_STATUSES = ["LISTO PARA ENVIO", "LISTO PARA INVENTARIO"]


async def main(apply: bool):
    """Un solo barrido del log en vez de una consulta por orden.

    Preguntar por cada orden (1,685 consultas contra 151k logs sin índice por
    `details.order_id`) tardaba minutos. Aquí se leen de una sola vez los
    eventos que dejaron a ALGUNA orden en uno de los dos estados, ordenados por
    fecha, y el último que se ve de cada orden gana.
    """
    objetivo = {}
    async for o in db.orders.find(
        {"production_status": {"$in": TARGET_STATUSES},
         "production_status_at": {"$exists": False}},
        {"_id": 0, "order_id": 1, "production_status": 1},
    ):
        if o.get("order_id"):
            objetivo[o["order_id"]] = o.get("production_status")
    print(f"Órdenes sin sello de fecha: {len(objetivo)}")

    # Ascendente: al recorrerlo así, el último evento que toca cada orden es el
    # más reciente y sobrescribe a los anteriores.
    sellos = {}
    vistos = 0
    async for ev in db.activity_logs.find(
        {"details.changes.production_status.to": {"$in": TARGET_STATUSES}},
        {"_id": 0, "timestamp": 1, "details.order_id": 1,
         "details.changes.production_status.to": 1},
    ).sort("timestamp", 1):
        vistos += 1
        det = ev.get("details") or {}
        oid = det.get("order_id")
        if not oid or oid not in objetivo:
            continue
        destino = ((det.get("changes") or {}).get("production_status") or {}).get("to")
        # Solo cuenta el evento que lo dejó en el estado que hoy TIENE: si la
        # orden rebotó a otro estado y volvió, la fecha buena es la del regreso.
        if destino == objetivo[oid] and ev.get("timestamp"):
            sellos[oid] = ev["timestamp"]

    print(f"Eventos de cambio leídos : {vistos}")
    print(f"Con fecha en el log      : {len(sellos)}")
    print(f"Sin rastro (queda —)     : {len(objetivo) - len(sellos)}")

    if not apply:
        print("\nSIMULACRO — no se escribió nada. Corre con --apply para aplicar.")
        return

    escritos = 0
    for oid, ts in sellos.items():
        await db.orders.update_one(
            {"order_id": oid},
            {"$set": {"production_status_at": ts,
                      "production_status_at_source": "backfill_activity_logs"}},
        )
        escritos += 1
    print(f"ESCRITOS                 : {escritos}")


if __name__ == "__main__":
    asyncio.run(main("--apply" in sys.argv))
