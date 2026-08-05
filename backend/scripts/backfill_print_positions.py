"""Deduce las posiciones de impresión de cada orden a partir de su producción ya
registrada, y las guarda marcadas como DEDUCIDAS.

POR QUÉ SE DEDUCE Y NO SE PIDE
──────────────────────────────
El sistema nunca supo cuántas posiciones lleva una orden. Sin ese dato no se
puede saber si una talla está terminada: 216 frentes de 216 pedidas es "listo"
si la orden solo lleva frente, y "a la mitad" si lleva frente y espalda. Eso
afecta a 214 órdenes con más de una posición registrada, que hoy el modal de
producción reporta como terminadas cuando no lo están.

Los registros de producción que ya existen delatan las posiciones: si una orden
tiene registros de FRENTE y de ESPALDA, lleva al menos esas dos.

ES UN PISO, NO LA VERDAD
────────────────────────
Una orden que lleva frente y espalda pero a la que solo se le registró el frente
se deduce como "solo frente". Por eso queda `print_positions_inferred: True`: la
UI lo marca como sin confirmar, y en el momento en que alguien lo edita o lo
confirma desde el tablero, el backend borra esa marca (ver routers/orders.py).

NO PISA NADA CAPTURADO A MANO
─────────────────────────────
Solo escribe en órdenes que NO tienen todavía el campo. Es idempotente: correrlo
dos veces no cambia nada la segunda vez.

CÓMO SE CORRE
─────────────
    python backend/scripts/backfill_print_positions.py            # simulacion
    python backend/scripts/backfill_print_positions.py --aplicar  # escribe
"""
import asyncio
import collections
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from dotenv import load_dotenv
load_dotenv(os.path.join(os.path.dirname(__file__), "..", ".env"))

from motor.motor_asyncio import AsyncIOMotorClient

DESIGN_POSITIONS = ["FRENTE", "ESPALDA", "MANGA"]


async def main(aplicar: bool):
    uri = os.environ.get("MONGODB_URL") or os.environ.get("MONGO_URL")
    if not uri:
        print("Falta MONGODB_URL en backend/.env")
        return 1
    client = AsyncIOMotorClient(uri, serverSelectionTimeoutMS=10000)
    db = client[os.environ.get("DB_NAME") or "mos-system"]

    # 1. Posiciones registradas por orden
    por_orden = collections.defaultdict(set)
    async for d in db.production_logs.find({}, {"_id": 0, "order_id": 1, "design_type": 1}):
        dt = (d.get("design_type") or "").strip().upper()
        if dt in DESIGN_POSITIONS:
            por_orden[d["order_id"]].add(dt)

    # 2. Qué órdenes tocaría
    propuestas, ya_tenian = [], 0
    for order_id, posiciones in por_orden.items():
        o = await db.orders.find_one(
            {"order_id": order_id},
            {"_id": 0, "order_number": 1, "print_positions": 1, "board": 1})
        if not o:
            continue
        if o.get("print_positions"):
            ya_tenian += 1
            continue
        canonicas = [p for p in DESIGN_POSITIONS if p in posiciones]
        propuestas.append((order_id, o.get("order_number"), o.get("board"), canonicas))

    combos = collections.Counter(tuple(p[3]) for p in propuestas)
    print("=" * 66)
    print(f"{'APLICANDO' if aplicar else 'SIMULACION'} — backfill de posiciones de impresion")
    print("=" * 66)
    print(f"ordenes con produccion registrada : {len(por_orden)}")
    print(f"ya tenian el campo (no se tocan)  : {ya_tenian}")
    print(f"se les pondria el campo           : {len(propuestas)}")
    print("\ncombinaciones que quedarian:")
    for k, n in combos.most_common():
        print(f"   {' + '.join(k):<28} {n} ordenes")

    print("\nmuestra (primeras 10):")
    for _oid, num, board, pos in propuestas[:10]:
        print(f"   orden {str(num):<8} [{board}]  ->  {' + '.join(pos)}")

    if not aplicar:
        print("\n*** SIMULACION: no se escribio nada. Corre con --aplicar para guardar. ***")
        return 0

    escritas = 0
    for order_id, _num, _board, pos in propuestas:
        r = await db.orders.update_one(
            # El filtro repite la condicion: si otro proceso capturo las
            # posiciones entre la lectura y esta escritura, no se pisa.
            {"order_id": order_id,
             "$or": [{"print_positions": {"$exists": False}},
                     {"print_positions": None}, {"print_positions": []}]},
            {"$set": {"print_positions": pos, "print_positions_inferred": True}},
        )
        escritas += r.modified_count

    print(f"\nordenes actualizadas: {escritas} de {len(propuestas)} propuestas")
    con_campo = await db.orders.count_documents({"print_positions": {"$exists": True, "$ne": []}})
    deducidas = await db.orders.count_documents({"print_positions_inferred": True})
    print(f"verificacion -> con posiciones: {con_campo}   marcadas como deducidas: {deducidas}")
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main("--aplicar" in sys.argv)))
