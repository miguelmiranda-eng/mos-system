import asyncio
from motor.motor_asyncio import AsyncIOMotorClient
from dotenv import load_dotenv
import os
import pprint

load_dotenv()

async def main():
    client = AsyncIOMotorClient(os.getenv("MONGODB_URL"))
    db = client.get_default_database()
    
    # Intentar buscar la orden 912
    order = await db.orders.find_one({"Order Number": "912"})
    if not order:
        order = await db.orders.find_one({"Order Number": 912})
    if not order:
        order = await db.orders.find_one({"id": 912})
    if not order:
        order = await db.orders.find_one({"id": "912"})
        
    if not order:
        print("No se encontro la orden 912 en la base de datos.")
        return

    print(f"=== ESTADO ACTUAL DE ORDEN 912 ===")
    print(f"Tablero (Board): {order.get('Board')}")
    print(f"Estado (Status): {order.get('Status')}")
    print(f"ID Interno: {order.get('_id')}")
    
    print("\n=== HISTORIAL / ACTIVIDAD ===")
    
    # Buscar en la coleccion de actividad (si existe)
    found_activity = False
    
    collections = await db.list_collection_names()
    
    if "activity" in collections:
        cursor = db.activity.find({"order_number": "912"}).sort("timestamp", 1)
        async for act in cursor:
            found_activity = True
            print(f"[{act.get('timestamp')}] {act.get('user')} -> {act.get('action')} | Detalles: {act.get('details')}")
            
        if not found_activity:
            cursor = db.activity.find({"order_id": str(order["_id"])}).sort("timestamp", 1)
            async for act in cursor:
                found_activity = True
                print(f"[{act.get('timestamp')}] {act.get('user')} -> {act.get('action')} | Detalles: {act.get('details')}")
                
    if "activity_logs" in collections and not found_activity:
        cursor = db.activity_logs.find({"order_number": "912"}).sort("timestamp", 1)
        async for act in cursor:
            found_activity = True
            print(f"[{act.get('timestamp')}] {act.get('user')} -> {act.get('action')} | Detalles: {act.get('details')}")

    # Si no hay coleccion separada, quiza este embebido en la orden
    if not found_activity and 'history' in order:
        for h in order['history']:
            print(h)
            found_activity = True

    if not found_activity:
        print("No se encontraron registros de historial para esta orden.")

asyncio.run(main())
