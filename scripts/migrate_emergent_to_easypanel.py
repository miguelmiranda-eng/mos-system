#!/usr/bin/env python3
"""
=======================================================
  MOS SYSTEM — Migración Emergent.sh → EasyPanel
=======================================================
Uso:
    python migrate_emergent_to_easypanel.py

Pasos automáticos:
  1. Login en Emergent.sh  → obtiene token
  2. Exporta TODAS las órdenes con comentarios e imágenes
  3. Login en EasyPanel    → obtiene token admin
  4. Limpia la DB de EasyPanel (orders, comments, images,
     notifications, activity_logs) — preserva usuarios
  5. Importa todo en EasyPanel

Edita las constantes de la sección CONFIG antes de correr.
"""

import requests
import json
import sys
from datetime import datetime

# ============================================================
#  CONFIG — cambia estos valores antes de ejecutar
# ============================================================

EMERGENT_BASE_URL  = "https://TU-APP.emergent.sh"          # URL de tu app en Emergent
EMERGENT_EMAIL     = "admin@tudominio.com"                  # Email admin en Emergent
EMERGENT_PASSWORD  = "tu_password_emergent"                 # Password en Emergent

EASYPANEL_BASE_URL = "https://mosdatabase-backend.k9pirj.easypanel.host"  # Backend en EasyPanel
EASYPANEL_EMAIL    = "admin@tudominio.com"                  # Email admin en EasyPanel
EASYPANEL_PASSWORD = "tu_password_easypanel"                # Password en EasyPanel

BACKUP_FILE        = f"backup_emergent_{datetime.now().strftime('%Y%m%d_%H%M%S')}.json"

# ============================================================
#  HELPERS
# ============================================================

def log(msg, emoji="ℹ️"):
    print(f"  {emoji}  {msg}")

def error(msg):
    print(f"\n  ❌  ERROR: {msg}")
    sys.exit(1)

def login(base_url: str, email: str, password: str, label: str) -> str:
    log(f"Autenticando en {label}...", "🔑")
    try:
        r = requests.post(
            f"{base_url}/api/auth/login",
            json={"email": email, "password": password},
            timeout=30
        )
        if r.status_code != 200:
            error(f"Login fallido en {label}: {r.status_code} {r.text[:200]}")
        data = r.json()
        # Soporta respuestas con token directo o dentro de 'user'
        token = data.get("session_token") or data.get("token") or data.get("access_token")
        if not token:
            # Intenta extraer de cookies si el server usa cookies
            token = r.cookies.get("session_token")
        if not token:
            error(f"No se encontró sesión/token en la respuesta de {label}. Respuesta: {data}")
        log(f"Login exitoso en {label}", "✅")
        return token
    except requests.exceptions.ConnectionError:
        error(f"No se pudo conectar a {base_url}. ¿Está corriendo el servidor?")

def get_headers(token: str) -> dict:
    return {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}

# ============================================================
#  PASO 1 — EXPORTAR DESDE EMERGENT
# ============================================================

def export_from_emergent(base_url: str, token: str) -> dict:
    headers = get_headers(token)

    # Obtener todas las órdenes (incluye todas los boards)
    log("Obteniendo lista de órdenes desde Emergent...", "📋")
    r = requests.get(f"{base_url}/api/orders", headers=headers, timeout=60)
    if r.status_code != 200:
        error(f"No se pudieron obtener las órdenes: {r.status_code} {r.text[:200]}")

    orders = r.json()
    total = len(orders)
    log(f"Encontradas {total} órdenes en total", "📦")

    if total == 0:
        log("No hay órdenes para exportar. Saliendo.", "⚠️")
        sys.exit(0)

    # Extraer IDs
    order_ids = [o["order_id"] for o in orders if o.get("order_id")]

    # Exportar con comentarios e imágenes
    log(f"Exportando {len(order_ids)} órdenes con comentarios e imágenes (puede tardar)...", "⏳")
    r = requests.post(
        f"{base_url}/api/orders/export-complete",
        headers=headers,
        json={
            "order_ids": order_ids,
            "include_comments": True,
            "include_images": True
        },
        timeout=300  # 5 min — las imágenes en base64 son grandes
    )
    if r.status_code != 200:
        error(f"Export fallido: {r.status_code} {r.text[:300]}")

    data = r.json()
    log(f"Exportadas {data.get('total', 0)} órdenes correctamente", "✅")
    return data

# ============================================================
#  PASO 2 — GUARDAR BACKUP LOCAL
# ============================================================

def save_backup(data: dict, filepath: str):
    log(f"Guardando backup local en '{filepath}'...", "💾")
    with open(filepath, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    size_mb = len(json.dumps(data)) / (1024 * 1024)
    log(f"Backup guardado ({size_mb:.2f} MB)", "✅")

# ============================================================
#  PASO 3 — LIMPIAR EASYPANEL
# ============================================================

def clear_easypanel(base_url: str, token: str):
    log("Limpiando base de datos de EasyPanel (órdenes, comentarios, imágenes, notificaciones)...", "🗑️")
    r = requests.delete(
        f"{base_url}/api/admin/clear-data",
        headers=get_headers(token),
        timeout=60
    )
    if r.status_code != 200:
        error(f"No se pudo limpiar EasyPanel: {r.status_code} {r.text[:300]}")

    stats = r.json().get("stats", {})
    log("Datos eliminados:", "✅")
    for col, count in stats.items():
        print(f"        • {col}: {count} documentos eliminados")

# ============================================================
#  PASO 4 — IMPORTAR EN EASYPANEL
# ============================================================

def import_to_easypanel(base_url: str, token: str, data: dict):
    orders = data.get("orders", [])
    log(f"Importando {len(orders)} órdenes en EasyPanel...", "📤")

    r = requests.post(
        f"{base_url}/api/orders/import-complete",
        headers=get_headers(token),
        json={"orders": orders, "update_existing": True},
        timeout=300
    )
    if r.status_code != 200:
        error(f"Import fallido: {r.status_code} {r.text[:300]}")

    stats = r.json()
    log("Importación/Sincronización completada:", "✅")
    print(f"        • Órdenes creadas:     {stats.get('orders', 0)}")
    print(f"        • Órdenes actualizadas:  {stats.get('updated_orders', 0)}")
    print(f"        • Órdenes omitidas:      {stats.get('skipped_orders', 0)}")
    print(f"        • Comentarios:           {stats.get('comments', 0)}")
    print(f"        • Imágenes:              {stats.get('images', 0)}")
    return stats

# ============================================================
#  MAIN
# ============================================================

def main():
    print()
    print("=" * 56)
    print("  MOS SYSTEM — Migración Emergent.sh → EasyPanel")
    print("=" * 56)
    print()

    # Validar configuración básica
    if "TU-APP" in EMERGENT_BASE_URL or "tudominio" in EMERGENT_EMAIL:
        error(
            "Debes editar las variables de CONFIG al inicio del script "
            "(EMERGENT_BASE_URL, EMERGENT_EMAIL, EMERGENT_PASSWORD, etc.) "
            "antes de ejecutarlo."
        )

    # ── 1. Login Emergent
    emergent_token = login(EMERGENT_BASE_URL, EMERGENT_EMAIL, EMERGENT_PASSWORD, "Emergent.sh")

    # ── 2. Exportar datos
    exported_data = export_from_emergent(EMERGENT_BASE_URL, emergent_token)

    # ── 3. Guardar backup local
    save_backup(exported_data, BACKUP_FILE)

    # ── 4. Login EasyPanel
    easypanel_token = login(EASYPANEL_BASE_URL, EASYPANEL_EMAIL, EASYPANEL_PASSWORD, "EasyPanel")

    # ── 5. Confirmar antes de borrar
    print()
    print("  ⚠️  ADVERTENCIA: Se borrarán TODOS los datos operativos")
    print(f"      en {EASYPANEL_BASE_URL}")
    print("      (órdenes, comentarios, imágenes, notificaciones)")
    print("      Los usuarios NO serán afectados.")
    print()
    confirm = input("  ¿Continuar? Escribe 'SI' para confirmar: ").strip()
    if confirm.upper() != "SI":
        log("Operación cancelada por el usuario.", "🚫")
        sys.exit(0)

    # ── 6. Limpiar EasyPanel (DESACTIVADO PARA SINCRONIZACIÓN)
    print()
    log("Omitiendo limpieza de base de datos para preservar datos locales...", "🛡️")
    # clear_easypanel(EASYPANEL_BASE_URL, easypanel_token)

    # ── 7. Importar
    print()
    import_to_easypanel(EASYPANEL_BASE_URL, easypanel_token, exported_data)

    print()
    print("=" * 56)
    print("  ✅  MIGRACIÓN COMPLETADA")
    print(f"  💾  Backup local guardado en: {BACKUP_FILE}")
    print("=" * 56)
    print()

if __name__ == "__main__":
    main()
