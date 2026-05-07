from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel
from deps import db, require_admin, require_auth, logger
import os
from datetime import datetime, timezone
from cryptography.fernet import Fernet
import google.generativeai as genai

router = APIRouter(prefix="/api/insights")

def get_cipher_suite():
    key = os.environ.get("MOS_ENCRYPTION_KEY")
    if not key:
        logger.error("MOS_ENCRYPTION_KEY not found in environment.")
        return None
    try:
        return Fernet(key.encode())
    except Exception as e:
        logger.error(f"Invalid MOS_ENCRYPTION_KEY: {e}")
        return None

class ConfigUpdate(BaseModel):
    gemini_api_key: str

@router.get("/config")
async def get_insights_config(request: Request):
    """Check if the Insights module is configured."""
    await require_admin(request)
    config = await db.insights_config.find_one({"config_id": "main"}, {"_id": 0})
    is_configured = False
    if config and config.get("encrypted_gemini_key"):
        is_configured = True
    return {"is_configured": is_configured}

@router.post("/config")
async def update_insights_config(body: ConfigUpdate, request: Request):
    """Securely store the Gemini API key."""
    await require_admin(request)
    cipher = get_cipher_suite()
    if not cipher:
        raise HTTPException(status_code=500, detail="El sistema no tiene configurada una clave de encriptación válida (MOS_ENCRYPTION_KEY).")
    
    if not body.gemini_api_key.strip():
        raise HTTPException(status_code=400, detail="La clave API no puede estar vacía.")

    try:
        encrypted_key = cipher.encrypt(body.gemini_api_key.strip().encode()).decode()
        
        await db.insights_config.update_one(
            {"config_id": "main"},
            {"$set": {
                "config_id": "main",
                "encrypted_gemini_key": encrypted_key,
                "updated_at": datetime.now(timezone.utc).isoformat()
            }},
            upsert=True
        )
        return {"message": "Configuración guardada exitosamente."}
    except Exception as e:
        logger.error(f"Error encrypting API key: {e}")
        raise HTTPException(status_code=500, detail=f"Error al encriptar la clave: {str(e)}")

@router.post("/analyze")
async def get_insights_analysis(request: Request):
    """Gather app data and query Gemini for insights."""
    await require_admin(request)
    
    config = await db.insights_config.find_one({"config_id": "main"}, {"_id": 0})
    if not config or not config.get("encrypted_gemini_key"):
        raise HTTPException(status_code=400, detail="El módulo Insights no está configurado. Faltan las credenciales.")
    
    cipher = get_cipher_suite()
    if not cipher:
        raise HTTPException(status_code=500, detail="Error de encriptación interno. Verifique MOS_ENCRYPTION_KEY.")

    # 1. Decrypt Key
    try:
        api_key = cipher.decrypt(config["encrypted_gemini_key"].encode()).decode()
    except Exception as e:
        logger.error(f"Error decrypting API key: {e}")
        raise HTTPException(status_code=500, detail="No se pudo desencriptar la clave API. Reconfigúrela en la configuración.")
    
    # 2. Gather Data for Context
    try:
        now_iso = datetime.now(timezone.utc).isoformat()
        
        # 1. Gather Users and Sessions (Metrics)
        total_users = await db.users.count_documents({})
        active_users_list = await db.user_sessions.distinct("user_id", {"expires_at": {"$gt": now_iso}})
        recent_logins = len(active_users_list)
        
        # Order distribution by board
        pipeline = [
            {"$group": {"_id": "$board", "count": {"$sum": 1}}}
        ]
        board_stats = await db.orders.aggregate(pipeline).to_list(100)
        boards_summary = {item["_id"]: item["count"] for item in board_stats}
        
        # Recent activity count
        activity_count = await db.activity_logs.count_documents({})
        
        data_snapshot = f"""
        Users Overview:
        - Total Users: {total_users}
        - Active Sessions: {recent_logins}
        
        Board Distribution (Bottleneck Detection):
        """
        for board, count in boards_summary.items():
            data_snapshot += f"  - {board}: {count} orders\n"
            
        data_snapshot += f"\nTotal historical recorded actions: {activity_count}"

        # 3. Call Gemini
        genai.configure(api_key=api_key)
        
        system_prompt = (
            "You are a Senior Data Scientist and Operations Efficiency Consultant for a manufacturing software. "
            "Analyze the provided data snapshot (users, metrics, bottlenecks, timeline). "
            "STRICTLY format your response in Spanish using beautiful Markdown. Structure your report precisely as follows:\n\n"
            "## 📊 Resumen Ejecutivo\n"
            "(Brief high-level overview of the current operational state)\n\n"
            "## 🔴 Cuellos de Botella Detectados\n"
            "(List of critical bottlenecks using bullet points. Use **bold** text to highlight exact numbers and stations)\n\n"
            "## 📈 Análisis de Usuarios y Participación\n"
            "(Insights on user engagement, active sessions vs total users, and work distribution)\n\n"
            "## 💡 Recomendaciones de Ejecución\n"
            "(3 to 4 specific, actionable steps to improve efficiency right now)\n\n"
            "Keep paragraphs very short. Be direct, authoritative, and data-driven. Do not add generic greetings."
        )
        
        # FIX: Using a valid model name (gemini-1.5-flash instead of non-existent 2.5)
        model = genai.GenerativeModel(
            model_name='gemini-1.5-flash',
            system_instruction=system_prompt
        )
        
        response = model.generate_content(data_snapshot)
        
        return {"insights": response.text}

    except Exception as e:
        logger.error(f"Error running Gemini analysis: {e}")
        raise HTTPException(status_code=500, detail=f"Error al analizar datos: {str(e)}")
