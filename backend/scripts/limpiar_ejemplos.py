"""Deja el módulo de Ejemplos en cero para empezar a cargar a mano.

QUÉ BORRA
  · TODOS los `sample_tasks` (la colección propia del módulo).
  · Las órdenes PROV- que creó el propio módulo — las que son
    `is_provisional=True` Y están en el tablero EJEMPLOS. Las dos condiciones
    juntas, no una sola: una orden provisional que alguien haya movido a otro
    tablero ya está en un flujo del CRM y no le toca a esta limpieza.

QUÉ NO TOCA
  · Las órdenes REALES del CRM que hoy tienen tarjeta de ejemplo (FINAL BILL,
    BLANKS, MAQUINA3, COMPLETOS). Sólo pierden su tarjeta en el calendario; la
    orden queda intacta.
  · El campo `sample` de ninguna orden. Lo leen el tablero y otros módulos:
    vaciarlo cambiaría lo que ve el CRM, que es justo lo que se pidió no
    afectar.

RESPALDO
Antes de borrar, copia lo que va a desaparecer a dos colecciones con sello de
fecha, usando `$out` (en esta base las respuestas grandes se cortan; `$out`
copia del lado del servidor y no viaja por la red). Revertir es un
`aggregate + $out` de regreso.

Uso:
    python backend/scripts/limpiar_ejemplos.py            # simulacro
    python backend/scripts/limpiar_ejemplos.py --apply    # borra de verdad
"""
import asyncio
import os
import sys
from datetime import datetime, timezone

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from deps import db  # noqa: E402

PROV_QUERY = {"is_provisional": True, "board": "EJEMPLOS"}


async def main(apply: bool):
    sello = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M")
    bk_tasks = f"bk_sample_tasks_{sello}"
    bk_orders = f"bk_orders_prov_ejemplos_{sello}"

    n_tasks = await db.sample_tasks.count_documents({})
    n_prov = await db.orders.count_documents(PROV_QUERY)

    # Control: lo que NO se toca. Si estos números cambian, algo salió mal.
    tasks = await db.sample_tasks.find({}, {"_id": 0, "order_id": 1}).to_list(5000)
    ids = [t["order_id"] for t in tasks if t.get("order_id")]
    n_reales = await db.orders.count_documents(
        {"order_id": {"$in": ids}, "is_provisional": {"$ne": True}})
    n_sample_field = await db.orders.count_documents(
        {"is_provisional": {"$ne": True}, "sample": {"$nin": [None, ""]}})

    print("SE BORRA")
    print(f"  sample_tasks                     : {n_tasks}")
    print(f"  ordenes PROV- en tablero EJEMPLOS: {n_prov}")
    print("\nNO SE TOCA")
    print(f"  ordenes REALES con tarjeta       : {n_reales}")
    print(f"  ordenes con campo `sample`       : {n_sample_field}")

    if not apply:
        print(f"\nRespaldaria en: {bk_tasks} / {bk_orders}")
        print("SIMULACRO — no se escribio nada. Corre con --apply para aplicar.")
        return

    # 1) Respaldo primero. Si esto falla, no se borra nada.
    await db.sample_tasks.aggregate([{"$match": {}}, {"$out": bk_tasks}]).to_list(1)
    await db.orders.aggregate([{"$match": PROV_QUERY}, {"$out": bk_orders}]).to_list(1)
    r1 = await db[bk_tasks].count_documents({})
    r2 = await db[bk_orders].count_documents({})
    print(f"\nRespaldo: {bk_tasks}={r1} · {bk_orders}={r2}")
    if r1 != n_tasks or r2 != n_prov:
        print("ABORTADO: el respaldo no cuadra con lo que iba a borrarse.")
        return

    # 2) Borrado
    d1 = await db.sample_tasks.delete_many({})
    d2 = await db.orders.delete_many(PROV_QUERY)
    print(f"Borrados: sample_tasks={d1.deleted_count} · ordenes PROV-={d2.deleted_count}")

    # 3) Verificación de que lo intocable sigue igual
    post_reales = await db.orders.count_documents(
        {"order_id": {"$in": ids}, "is_provisional": {"$ne": True}})
    post_sample = await db.orders.count_documents(
        {"is_provisional": {"$ne": True}, "sample": {"$nin": [None, ""]}})
    print("\nVERIFICACION")
    print(f"  ordenes REALES que tenian tarjeta: {post_reales} (antes {n_reales})"
          f" {'OK' if post_reales == n_reales else '<-- CAMBIO!'}")
    print(f"  ordenes con campo `sample`       : {post_sample} (antes {n_sample_field})"
          f" {'OK' if post_sample == n_sample_field else '<-- CAMBIO!'}")
    print(f"  sample_tasks restantes           : {await db.sample_tasks.count_documents({})}")
    print(f"  PROV- en EJEMPLOS restantes      : {await db.orders.count_documents(PROV_QUERY)}")


if __name__ == "__main__":
    asyncio.run(main("--apply" in sys.argv))
