import os
import asyncio
import base64
from pathlib import Path
from dotenv import load_dotenv

ROOT_DIR = Path(__file__).parent
load_dotenv(ROOT_DIR / '.env')

from deps import db

UPLOADS_DIR = ROOT_DIR / "uploads" / "invoices"
UPLOADS_DIR.mkdir(parents=True, exist_ok=True)

async def clean_mongo_base64():
    print("\n--- Buscando imágenes Base64 en MongoDB ---")
    
    # Encontrar todos los documentos que tengan el campo 'data' (el texto en base64)
    cursor = db.file_uploads.find({"data": {"$exists": True, "$ne": ""}})
    docs = await cursor.to_list(length=None)
    
    print(f"Se encontraron {len(docs)} archivos pesados en la base de datos.")
    if len(docs) == 0:
        print("Tu base de datos ya está limpia.")
        return 0
        
    success_count = 0
    
    for doc in docs:
        storage_key = doc.get("storage_key")
        raw_b64 = doc.get("data")
        _id = doc.get("_id")
        
        if not storage_key or not raw_b64:
            continue
            
        try:
            # 1. Decodificar la imagen
            file_bytes = base64.b64decode(raw_b64)
            
            # 2. Guardarla en el disco duro (que ahora estará en el volumen de Easypanel)
            # storage_key a veces trae "orders/..." así que nos aseguramos de crear subcarpetas si existen
            file_path = UPLOADS_DIR / storage_key
            file_path.parent.mkdir(parents=True, exist_ok=True)
            
            with open(file_path, "wb") as f:
                f.write(file_bytes)
                
            # 3. Borrar el texto pesado de MongoDB (pero dejar el resto de la metadata intacta)
            await db.file_uploads.update_one(
                {"_id": _id},
                {"$unset": {"data": ""}}
            )
            
            print(f"[OK] Extraído: {storage_key}")
            success_count += 1
            
        except Exception as e:
            print(f"[ERROR] Falló al extraer {storage_key}: {e}")
            
    return success_count

async def main():
    print("INICIANDO LIMPIEZA DE MONGODB")
    print("=" * 50)
    
    migrated = await clean_mongo_base64()
    
    print("=" * 50)
    print(f"Limpieza terminada. Se extrajeron {migrated} archivos de MongoDB hacia el disco duro.")
    print("Tu base de datos ahora debería ser mucho más rápida y ligera.")

if __name__ == "__main__":
    asyncio.run(main())
