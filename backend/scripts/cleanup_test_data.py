import asyncio, os
from motor.motor_asyncio import AsyncIOMotorClient
from dotenv import load_dotenv

async def cleanup():
    load_dotenv('.env')
    mongo_url = os.environ.get('MONGODB_URL')
    db_name = os.environ.get('DB_NAME', 'mos-system')
    client = AsyncIOMotorClient(mongo_url)
    db = client[db_name]
    
    test_clients = ["FINAL CLIENT", "FINAL VERIFICATION", "TEST CLIENT"]
    test_shifts = ["TURNO 2", "TURNO 3"]
    
    # Process Production Logs
    # 1. Delete logs of test clients
    res1 = await db.production_logs.delete_many({"client": {"$in": test_clients}})
    print(f"Eliminados {res1.deleted_count} registros de producción de clientes de prueba.")
    
    # 2. Delete logs of test shifts (Turno 2 and 3)
    res2 = await db.production_logs.delete_many({"shift": {"$in": test_shifts}})
    print(f"Eliminados {res2.deleted_count} registros de producción de Turnos 2 y 3.")
    
    # Process Orders
    # Delete orders of test clients
    res3 = await db.orders.delete_many({"client": {"$in": test_clients}})
    print(f"Eliminadas {res3.deleted_count} órdenes de clientes de prueba.")

if __name__ == '__main__':
    asyncio.run(cleanup())
