from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel
from deps import db, require_admin, logger
import os
from datetime import datetime, timezone, timedelta
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
    import traceback

    await require_admin(request)

    # ── Step 1: Check config exists ─────────────────────────────────────────
    config = await db.insights_config.find_one({"config_id": "main"}, {"_id": 0})
    if not config or not config.get("encrypted_gemini_key"):
        raise HTTPException(
            status_code=400,
            detail="[CONFIG] El módulo Insights no está configurado. Abre la configuración y guarda tu Gemini API key."
        )

    # ── Step 2: Encryption suite ────────────────────────────────────────────
    cipher = get_cipher_suite()
    if not cipher:
        raise HTTPException(
            status_code=500,
            detail="[ENCRYPTION] Falta MOS_ENCRYPTION_KEY en el .env del backend o es inválida (debe ser una Fernet key)."
        )

    # ── Step 3: Decrypt Gemini API key ──────────────────────────────────────
    try:
        api_key = cipher.decrypt(config["encrypted_gemini_key"].encode()).decode()
    except Exception as e:
        logger.error(f"[Insights] Decrypt failed: {e}\n{traceback.format_exc()}")
        raise HTTPException(
            status_code=500,
            detail=f"[DECRYPT] No se pudo desencriptar la clave API. La MOS_ENCRYPTION_KEY actual no coincide con la usada al guardar la clave. Reconfigura la API key. Detalle: {e}"
        )

    # ── Step 4: Gather data from MongoDB ────────────────────────────────────
    # Maps low-level action names to high-level modules for the report.
    ACTION_TO_MODULE = {
        "login": "Auth", "logout": "Auth",
        "create_order": "Orders", "update_order": "Orders",
        "bulk_move_orders": "Orders", "permanent_delete_order": "Orders",
        "create_order_excel": "Orders", "restore_order": "Orders",
        "add_comment": "Comments",
        "upload_attachment": "Files / Attachments",
        "register_production": "Production",
        "auto_create_qc": "QC", "create_qc_record": "QC",
        "create_invoice": "Invoices", "update_invoice": "Invoices",
        "automation_triggered": "Automations",
        "update_user_role": "Users / Roles", "invite_user": "Users / Roles",
    }

    def module_for(action: str) -> str:
        return ACTION_TO_MODULE.get(action, "Other / Misc")

    try:
        now = datetime.now(timezone.utc)
        now_iso = now.isoformat()
        cutoff_7d = (now - timedelta(days=7)).isoformat()
        cutoff_30d = (now - timedelta(days=30)).isoformat()

        # ── Users baseline ─────────────────────────────────────────────────
        total_users = await db.users.count_documents({})
        active_sessions = len(await db.user_sessions.distinct("user_id", {"expires_at": {"$gt": now_iso}}))
        users_by_role = await db.users.aggregate(
            [{"$group": {"_id": "$role", "count": {"$sum": 1}}}, {"$sort": {"count": -1}}]
        ).to_list(50)

        # ── Orders board distribution (operational context) ────────────────
        board_stats = await db.orders.aggregate(
            [{"$group": {"_id": "$board", "count": {"$sum": 1}}}, {"$sort": {"count": -1}}]
        ).to_list(100)
        boards_summary = {item["_id"] or "(sin board)": item["count"] for item in board_stats}

        # ── Activity volume ────────────────────────────────────────────────
        activity_total = await db.activity_logs.count_documents({})
        activity_7d = await db.activity_logs.count_documents({"timestamp": {"$gte": cutoff_7d}})
        activity_30d = await db.activity_logs.count_documents({"timestamp": {"$gte": cutoff_30d}})

        # ── Top actions in last 30d (usability signal) ─────────────────────
        top_actions_30d = await db.activity_logs.aggregate(
            [{"$match": {"timestamp": {"$gte": cutoff_30d}}},
             {"$group": {"_id": "$action", "count": {"$sum": 1}}},
             {"$sort": {"count": -1}}, {"$limit": 20}]
        ).to_list(20)

        # ── Per-user usage in last 30d ─────────────────────────────────────
        per_user_30d = await db.activity_logs.aggregate(
            [{"$match": {"timestamp": {"$gte": cutoff_30d}}},
             {"$group": {
                 "_id": {"user_id": "$user_id", "name": "$user_name", "email": "$user_email"},
                 "actions": {"$sum": 1},
                 "distinct_actions": {"$addToSet": "$action"},
             }},
             {"$sort": {"actions": -1}}, {"$limit": 25}]
        ).to_list(25)

        # ── Idle users: registered but no activity in 30d ──────────────────
        active_user_ids_30d = await db.activity_logs.distinct("user_id", {"timestamp": {"$gte": cutoff_30d}})
        all_users = await db.users.find({}, {"user_id": 1, "name": 1, "email": 1, "role": 1, "_id": 0}).to_list(500)
        idle_users = [u for u in all_users if u.get("user_id") not in set(active_user_ids_30d)]

        # ── Aggregate to modules ───────────────────────────────────────────
        module_counts_30d: dict[str, int] = {}
        for row in top_actions_30d:
            module_counts_30d[module_for(row["_id"])] = module_counts_30d.get(module_for(row["_id"]), 0) + row["count"]
        # Sort modules by usage desc
        module_counts_30d = dict(sorted(module_counts_30d.items(), key=lambda x: x[1], reverse=True))

        # ── Hour-of-day distribution (UTC) — peak usage windows ────────────
        hourly = await db.activity_logs.aggregate(
            [{"$match": {"timestamp": {"$gte": cutoff_30d}}},
             {"$addFields": {"hour": {"$toInt": {"$substr": ["$timestamp", 11, 2]}}}},
             {"$group": {"_id": "$hour", "n": {"$sum": 1}}},
             {"$sort": {"_id": 1}}]
        ).to_list(24)
        hourly_map = {row["_id"]: row["n"] for row in hourly}

        # ── Mistake signal: undos per user (30d) ───────────────────────────
        undos_per_user = await db.activity_logs.aggregate(
            [{"$match": {"undone": True, "timestamp": {"$gte": cutoff_30d}}},
             {"$group": {"_id": {"name": "$user_name", "email": "$user_email"}, "n": {"$sum": 1}}},
             {"$sort": {"n": -1}}, {"$limit": 10}]
        ).to_list(10)
        total_undos_30d = await db.activity_logs.count_documents({"undone": True, "timestamp": {"$gte": cutoff_30d}})

        # ── Deletes per user (data-loss / cleanup signal) ──────────────────
        deletes_per_user = await db.activity_logs.aggregate(
            [{"$match": {"action": {"$in": ["delete_order", "permanent_delete_order"]},
                         "timestamp": {"$gte": cutoff_30d}}},
             {"$group": {"_id": {"name": "$user_name", "email": "$user_email"}, "n": {"$sum": 1}}},
             {"$sort": {"n": -1}}, {"$limit": 10}]
        ).to_list(10)
    except Exception as e:
        logger.error(f"[Insights] Mongo gather failed: {e}\n{traceback.format_exc()}")
        raise HTTPException(
            status_code=500,
            detail=f"[MONGO] No se pudieron leer las métricas de la base de datos. Detalle: {e}"
        )

    # ── Build a rich snapshot string ────────────────────────────────────────
    lines: list[str] = []
    lines.append("# MOS-SYSTEM USAGE & USABILITY SNAPSHOT")
    lines.append(f"Generated: {now_iso}")
    lines.append("")
    lines.append("## 1. USER BASE")
    lines.append(f"- Total registered users: {total_users}")
    lines.append(f"- Active sessions right now: {active_sessions}")
    lines.append(f"- Users active in last 30 days: {len(active_user_ids_30d)}")
    lines.append(f"- Idle users (registered, no activity in 30d): {len(idle_users)}")
    lines.append("")
    lines.append("### Users by role")
    for r in users_by_role:
        lines.append(f"- {r['_id'] or '(no role)'}: {r['count']}")
    lines.append("")
    lines.append("## 2. ACTIVITY VOLUME")
    lines.append(f"- Total activity logs (all time): {activity_total}")
    lines.append(f"- Activity in last 7 days: {activity_7d}")
    lines.append(f"- Activity in last 30 days: {activity_30d}")
    lines.append("")
    lines.append("## 3. MODULE USAGE (last 30 days, action counts)")
    for mod, n in module_counts_30d.items():
        lines.append(f"- {mod}: {n}")
    lines.append("")
    lines.append("## 4. TOP 20 ACTIONS (last 30 days)")
    for row in top_actions_30d:
        lines.append(f"- {row['_id']}: {row['count']}")
    lines.append("")
    lines.append("## 5. TOP 25 USERS BY ACTIVITY (last 30 days)")
    for row in per_user_30d:
        ident = row["_id"]
        name = ident.get("name") or ident.get("email") or ident.get("user_id") or "(unknown)"
        email = ident.get("email") or ""
        n_actions = row["actions"]
        n_distinct = len(row.get("distinct_actions") or [])
        lines.append(f"- {name} <{email}> — {n_actions} acciones, {n_distinct} tipos distintos")
    lines.append("")
    lines.append("## 6. IDLE USERS (no activity in 30 days)")
    if not idle_users:
        lines.append("- (none — all users have been active)")
    else:
        for u in idle_users[:30]:
            lines.append(f"- {u.get('name') or '(no name)'} <{u.get('email','')}> — role: {u.get('role','?')}")
        if len(idle_users) > 30:
            lines.append(f"- (+ {len(idle_users) - 30} more)")
    lines.append("")
    lines.append("## 7. PEAK USAGE HOURS (UTC, last 30 days)")
    if hourly_map:
        peak_h = max(hourly_map, key=hourly_map.get)
        quiet_h = min(hourly_map, key=hourly_map.get)
        lines.append(f"- Peak hour: {peak_h:02d}:00 UTC ({hourly_map[peak_h]} actions)")
        lines.append(f"- Quietest hour: {quiet_h:02d}:00 UTC ({hourly_map[quiet_h]} actions)")
        lines.append("- Full distribution:")
        for h in range(24):
            n = hourly_map.get(h, 0)
            bar = "█" * max(1, int(n / max(hourly_map.values()) * 20)) if n else ""
            lines.append(f"  {h:02d}h: {n:>5}  {bar}")
    lines.append("")
    lines.append("## 8. MISTAKE SIGNAL — UNDOS (last 30 days)")
    lines.append(f"- Total undone actions: {total_undos_30d}")
    if undos_per_user:
        lines.append("- Top users with undos:")
        for u in undos_per_user:
            ident = u["_id"]
            name = ident.get("name") or ident.get("email") or "(unknown)"
            lines.append(f"  - {name}: {u['n']} undos")
    else:
        lines.append("- (no undos recorded — usability looks clean OR feature is not adopted)")
    lines.append("")
    lines.append("## 9. DELETIONS — DATA-LOSS / CLEANUP SIGNAL (last 30 days)")
    if deletes_per_user:
        for u in deletes_per_user:
            ident = u["_id"]
            name = ident.get("name") or ident.get("email") or "(unknown)"
            lines.append(f"- {name}: {u['n']} deletes")
    else:
        lines.append("- (no deletions in the period)")
    lines.append("")
    lines.append("## 10. ORDER PIPELINE DISTRIBUTION (operational context)")
    for board, count in list(boards_summary.items())[:20]:
        lines.append(f"- {board}: {count} orders")

    data_snapshot = "\n".join(lines)

    system_prompt = (
        "You are a Senior Product Analyst and Usability Consultant for MOS-SYSTEM, a manufacturing operations platform. "
        "Your job is to analyze a snapshot of REAL user activity and tell the CEO which modules and actions are actually used, "
        "by whom, and where the usability or adoption problems are. "
        "STRICTLY respond in Spanish using clean Markdown. Use the following exact structure:\n\n"
        "## 📊 Resumen Ejecutivo\n"
        "2–3 frases. Estado general de uso de la plataforma (volumen, adopción, salud).\n\n"
        "## 🧩 Uso por Módulo\n"
        "Tabla en Markdown con columnas: Módulo · Acciones (30d) · Veredicto. "
        "Identifica los módulos más usados, los infrautilizados, y los que parecen abandonados.\n\n"
        "## 🔥 Acciones Más Frecuentes\n"
        "Bullets con la acción y un comentario breve sobre qué revela (ej. exceso de uploads = posibles problemas de proceso).\n\n"
        "## 👤 Usuarios Power y Subutilizados\n"
        "Lista los **3–5 power users** (más activos y con mayor variedad de acciones) y los **usuarios inactivos** que llevan 30d sin entrar. "
        "Para cada uno, una frase con interpretación (ej. \"riesgo de pérdida de licencia\", \"posible cuello operativo si se va\").\n\n"
        "## 🕐 Patrones de Uso Horario\n"
        "Interpreta las horas pico y valles. ¿La plataforma se usa solo en jornada o también fuera? "
        "¿Hay horas muertas que indiquen que algunos turnos no la usan?\n\n"
        "## ⚠️ Señales de Usabilidad y Errores\n"
        "3–5 bullets concretos. Considera: undos (sugieren fricción/errores), deletes (riesgo de pérdida de datos), "
        "módulos sin tracción, acciones repetitivas (updates múltiples a la misma orden), "
        "roles que no están usando lo que deberían.\n\n"
        "## 💡 Acciones Recomendadas\n"
        "3–4 pasos accionables YA. Sé específico (qué módulo entrenar, qué usuario contactar, qué feature deprecar, qué proceso revisar).\n\n"
        "Reglas: usa **negritas** para números exactos y nombres de personas/módulos. Frases cortas. Nada de saludos. "
        "Si los datos están vacíos en alguna sección, dilo explícitamente — no inventes."
    )

    # ── Step 5: Call Gemini ─────────────────────────────────────────────────
    try:
        genai.configure(api_key=api_key)
        model = genai.GenerativeModel(
            model_name='gemini-2.5-flash',
            system_instruction=system_prompt
        )
        response = model.generate_content(data_snapshot)
    except Exception as e:
        logger.error(f"[Insights] Gemini API call failed: {e}\n{traceback.format_exc()}")
        # Surface the exact Gemini error (invalid key, deprecated model, quota, etc.)
        err_class = type(e).__name__
        raise HTTPException(
            status_code=502,
            detail=f"[GEMINI:{err_class}] Falló la llamada a Gemini. Causas comunes: API key inválida/expirada, modelo no disponible, cuota agotada. Detalle: {e}"
        )

    # ── Step 6: Validate response ───────────────────────────────────────────
    try:
        text = response.text
    except Exception as e:
        logger.error(f"[Insights] Gemini returned no text: {e}\n{traceback.format_exc()}")
        raise HTTPException(
            status_code=502,
            detail=f"[GEMINI:NO_TEXT] Gemini respondió pero sin texto utilizable (posible bloqueo por safety filters). Detalle: {e}"
        )

    return {"insights": text}
