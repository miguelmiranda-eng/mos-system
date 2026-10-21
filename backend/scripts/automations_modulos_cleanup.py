"""Limpia las automatizaciones de "mover a tablero" tras pasar a MÓDULOS.

Ya no hay tableros de preparación: el Production Status dice en qué módulo está
la orden y las automatizaciones sólo LIBERAN la máquina (la regresan al maestro)
o la cierran. Los nombres viejos ("MOVER A EMPAQUE"…) ya engañan.

Qué hace (aprobado por el usuario 2026-10-21):
  · "MOVER A EMPAQUE" → "LIBERAR MÁQUINA AL TERMINAR DE IMPRIMIR" y vigila TODAS
    las máquinas (MAQUINA<n> de board_config; antes faltaban 15 y 16).
  · "MOVER A COMPPLETOS ENVIOS" → "COMPLETA: LISTO PARA ENVIO".
  · "MOVER A COMPLETOS ENVIOS" → "COMPLETA: LISTO PARA FULFILLMENT".
  · "mover a cuadros" y "MOVER A LISTO PARA MAQUINA" se APAGAN (is_active=False):
    sólo vigilan SCHEDULING y mandan a SCHEDULING, ya no hacen nada.
Se localizan por nombre Y condición (watch_value), no sólo por nombre.

Dry-run por defecto. --apply guarda ANTES un respaldo JSON en backend/scripts/.

USO
    backend/venv/Scripts/python.exe backend/scripts/automations_modulos_cleanup.py [--apply]
"""
import asyncio
import json
import os
import re
import sys
from datetime import datetime, timezone

BE = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
sys.path.insert(0, BE)
os.chdir(BE)
os.environ.setdefault("MASTER_API_KEY", "migration")
os.environ.setdefault("INTERNAL_SYNC_TOKEN", "migration")
os.environ.setdefault("JWT_SECRET", "migration")
os.environ.setdefault("ENV", "local")
os.environ.setdefault("DISABLE_SCHEDULERS", "1")
from dotenv import load_dotenv  # noqa: E402
load_dotenv(os.path.join(BE, ".env"))

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

APPLY = "--apply" in sys.argv
from deps import db  # noqa: E402

# (nombre actual, watch_value esperado) → cambios
RENAME = [
    ("MOVER A EMPAQUE", "NECESITA EMPACAR", "LIBERAR MÁQUINA AL TERMINAR DE IMPRIMIR", True),
    ("MOVER A COMPPLETOS ENVIOS", "LISTO PARA ENVIO", "COMPLETA: LISTO PARA ENVIO", False),
    ("MOVER A COMPLETOS ENVIOS", "LISTO PARA FULFILLMENT", "COMPLETA: LISTO PARA FULFILLMENT", False),
]
TURN_OFF = [("mover a cuadros", "CONTADO"), ("MOVER A LISTO PARA MAQUINA", "LABEL LISTO")]


def _watch(a):
    return str(((a.get("trigger_conditions") or {}).get("watch_value")) or "").strip().upper()


async def main():
    now = datetime.now(timezone.utc).isoformat()
    print(f"Base: {db.name}   modo: {'APLICAR' if APPLY else 'DRY-RUN'}\n")
    bc = await db.board_config.find_one({"config_id": "boards"}, {"_id": 0, "boards": 1}) or {}
    machines = sorted([b for b in bc.get("boards") or [] if re.fullmatch(r"MAQUINA\d+", str(b))],
                      key=lambda b: int(b[7:]))
    names = [r[0] for r in RENAME] + [t[0] for t in TURN_OFF]
    autos = [a async for a in db.automations.find({"name": {"$in": names}}, {"_id": 0})]
    if APPLY:
        path = os.path.join(BE, "scripts", f"backup_automatizaciones_modulos_{db.name}_{now[:10]}.json")
        json.dump(autos, open(path, "w", encoding="utf-8"), ensure_ascii=False, default=str, indent=1)
        print(f"Respaldo: {path}\n")

    for old, watch, new, all_machines in RENAME:
        hits = [a for a in autos if a.get("name") == old and _watch(a) == watch]
        if not hits:
            print(f"  (no encontrada) '{old}' con {watch}")
            continue
        for a in hits:
            sets = {"name": new, "updated_at": now}
            line = f"  RENOMBRAR '{old}' → '{new}'"
            if all_machines:
                cur = list(a.get("boards") or [])
                faltan = [m for m in machines if m not in cur]
                if faltan:
                    sets["boards"] = cur + faltan
                    line += f"  · + tableros {faltan}"
            print(line)
            if APPLY:
                await db.automations.update_one({"automation_id": a["automation_id"]}, {"$set": sets})

    for old, watch in TURN_OFF:
        hits = [a for a in autos if a.get("name") == old and _watch(a) == watch]
        if not hits:
            print(f"  (no encontrada) '{old}' con {watch}")
            continue
        for a in hits:
            print(f"  APAGAR '{old}' (vigila {a.get('boards')} → destino "
                  f"{(a.get('action_params') or {}).get('target_board')}; estaba "
                  f"{'activa' if a.get('is_active') else 'inactiva'})")
            if APPLY:
                await db.automations.update_one({"automation_id": a["automation_id"]},
                                                {"$set": {"is_active": False, "updated_at": now}})
    if not APPLY:
        print("\nDRY-RUN: no se escribió nada. Corre con --apply para aplicar.")


asyncio.run(main())
