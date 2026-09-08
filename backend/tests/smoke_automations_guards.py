"""Smoke OFFLINE del motor de GUARDAS de automatizaciones (Fase 2, sin Mongo).

Congela check_guards: una guarda BLOQUEA un cambio de status/tablero hasta que se
cumple un requisito (foto de evidencia / campo lleno / otro flag), solo cuando su
scope + destino + condiciones (estrictas) casan. El requisito se evalúa sobre la
fusión {existing + update_data} (llenar el campo en el MISMO request lo satisface).

USO
───
    backend/venv/Scripts/python.exe backend/tests/smoke_automations_guards.py
"""
import asyncio
import os
import sys

BE = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
for k in ("MONGODB_URL", "DB_NAME", "JWT_SECRET", "MASTER_API_KEY", "INTERNAL_SYNC_TOKEN", "ENV", "RESEND_API_KEY"):
    os.environ.setdefault(k, "smoke")
sys.path.insert(0, BE)
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

import routers.automations as autos  # noqa: E402

ok = fail = 0


def check(name, cond, detail=""):
    global ok, fail
    if cond:
        ok += 1
        print(f"   PASS  {name}")
    else:
        fail += 1
        print(f"   FAIL  {name}  {detail}")


# ── fake db para check_guards (db.automations.find(...).to_list(n)) ──
class _FakeFind:
    def __init__(self, docs):
        self._docs = docs

    async def to_list(self, n):
        return list(self._docs)


class _FakeAutos:
    def __init__(self, docs):
        self.docs = docs

    def find(self, query):
        tt = query.get("trigger_type")
        act = query.get("is_active")
        return _FakeFind([d for d in self.docs
                          if (tt is None or d.get("trigger_type") == tt)
                          and (act is None or d.get("is_active") == act)])


class _FakeDB:
    def __init__(self, docs):
        self.automations = _FakeAutos(docs)


def set_guards(docs):
    autos.db = _FakeDB(docs)


USER = {"role": "admin", "email": "x@y.com"}


def guard(**kw):
    g = {"name": kw.get("name", "g"), "is_active": kw.get("is_active", True),
         "trigger_type": "guard", "boards": kw.get("boards", []),
         "trigger_conditions": kw.get("cond", {}), "action_params": kw.get("params", {})}
    return g


async def main():
    global ok, fail

    # G1: en MAQUINA1, si playerita=SI, al cambiar status exige FOTO.
    G1 = guard(name="foto sample", boards=["MAQUINA1"],
               cond={"on": "status_change", "sample_printavo": "SI"},
               params={"requirement": "photo", "message": "Sube foto de evidencia"})

    print("\n1) requisito FOTO + condición de flag + scope de tablero")
    set_guards([G1])
    base = {"board": "MAQUINA1", "sample_printavo": "SI", "production_status": "EN PRODUCCION", "images": []}
    upd = {"production_status": "LISTO PARA ENVIO"}
    r = await autos.check_guards(base, upd, USER, status_changing=True)
    check("sin foto + sample SI -> BLOQUEA", r == "Sube foto de evidencia", f"{r!r}")

    r = await autos.check_guards({**base, "images": [{"filename": "x.jpg"}]}, upd, USER, status_changing=True)
    check("con foto -> pasa (None)", r is None, f"{r!r}")

    r = await autos.check_guards({**base, "sample_printavo": "NO"}, upd, USER, status_changing=True)
    check("sample NO -> la guarda no aplica (None)", r is None, f"{r!r}")

    r = await autos.check_guards({**base, "sample_printavo": None}, upd, USER, status_changing=True)
    check("sample ausente -> estricto, no aplica (None)", r is None, f"{r!r}")

    r = await autos.check_guards({**base, "board": "MAQUINA2"}, upd, USER, status_changing=True)
    check("otro tablero -> fuera de scope (None)", r is None, f"{r!r}")

    r = await autos.check_guards(base, {"board": "SCREENS"}, USER, board_changing=True, new_board="SCREENS")
    check("solo movimiento (no status) -> guarda de status no aplica", r is None, f"{r!r}")

    print("\n2) requisito CAMPO + filtro to_status + fusión (llenar en el mismo request)")
    G2 = guard(name="final bill",
               cond={"on": "status_change", "to_status": "LISTO PARA ENVIO"},
               params={"requirement": "field", "field": "final_bill", "message": "Falta Final Bill"})
    set_guards([G2])
    base2 = {"board": "MAQUINA1", "production_status": "EN PRODUCCION", "final_bill": ""}
    r = await autos.check_guards(base2, {"production_status": "LISTO PARA ENVIO"}, USER, status_changing=True)
    check("campo vacío -> BLOQUEA", r == "Falta Final Bill", f"{r!r}")
    r = await autos.check_guards(base2, {"production_status": "LISTO PARA ENVIO", "final_bill": "2026-09-10"},
                                 USER, status_changing=True)
    check("campo lleno en el MISMO request -> pasa", r is None, f"{r!r}")
    r = await autos.check_guards(base2, {"production_status": "EN ESPERA"}, USER, status_changing=True)
    check("otro status destino -> no aplica (to_status)", r is None, f"{r!r}")

    print("\n3) requisito FLAG + guarda de MOVIMIENTO con to_board")
    G3 = guard(name="neck listo",
               cond={"on": "move", "to_board": "COMPLETOS"},
               params={"requirement": "flag", "field": "art_neck_status", "value": "true",
                       "message": "Neck Label no está listo"})
    set_guards([G3])
    base3 = {"board": "MAQUINA1", "art_neck_status": False}
    r = await autos.check_guards(base3, {"board": "COMPLETOS"}, USER, board_changing=True, new_board="COMPLETOS")
    check("neck apagado -> BLOQUEA el move a COMPLETOS", r == "Neck Label no está listo", f"{r!r}")
    r = await autos.check_guards({**base3, "art_neck_status": True}, {"board": "COMPLETOS"},
                                 USER, board_changing=True, new_board="COMPLETOS")
    check("neck encendido -> pasa", r is None, f"{r!r}")
    r = await autos.check_guards(base3, {"board": "SCREENS"}, USER, board_changing=True, new_board="SCREENS")
    check("otro tablero destino -> no aplica (to_board)", r is None, f"{r!r}")

    print("\n4) guardas inactivas / sin guardas")
    set_guards([{**G1, "is_active": False}])
    r = await autos.check_guards(base, upd, USER, status_changing=True)
    check("guarda inactiva -> se ignora", r is None, f"{r!r}")
    set_guards([])
    r = await autos.check_guards(base, upd, USER, status_changing=True)
    check("sin guardas -> None", r is None, f"{r!r}")

    print("\n5) sin intento de cambio -> no evalúa nada")
    set_guards([G1])
    r = await autos.check_guards(base, {"notes": "hola"}, USER, status_changing=False, board_changing=False)
    check("ni status ni board -> None", r is None, f"{r!r}")

    print("\n6) Track 4: requisito de ROL")
    GROLE = guard(name="solo supersu", cond={"on": "status_change"},
                  params={"requirement": "role", "roles": ["supersu"], "message": "Solo supersu"})
    set_guards([GROLE])
    base6 = {"board": "MAQUINA1", "production_status": "EN PRODUCCION"}
    r = await autos.check_guards(base6, {"production_status": "LISTO PARA ENVIO"}, {"role": "admin"}, status_changing=True)
    check("rol admin no permitido -> BLOQUEA", r == "Solo supersu", f"{r!r}")
    r = await autos.check_guards(base6, {"production_status": "LISTO PARA ENVIO"}, {"role": "supersu"}, status_changing=True)
    check("rol supersu -> pasa", r is None, f"{r!r}")

    print("\n7) Track 4: MÚLTIPLES requisitos (AND)")
    GMULTI = guard(name="foto y final bill", cond={"on": "status_change"},
                   params={"requirements": [
                       {"requirement": "photo", "message": "Falta foto"},
                       {"requirement": "field", "field": "final_bill", "message": "Falta final bill"},
                   ]})
    set_guards([GMULTI])
    base7 = {"board": "MAQUINA1", "production_status": "EN PRODUCCION", "images": [], "final_bill": ""}
    r = await autos.check_guards(base7, {"production_status": "LISTO PARA ENVIO"}, USER, status_changing=True)
    check("sin foto -> BLOQUEA con el 1er msg", r == "Falta foto", f"{r!r}")
    r = await autos.check_guards({**base7, "images": [{"f": "x"}]}, {"production_status": "LISTO PARA ENVIO"}, USER, status_changing=True)
    check("con foto pero sin final bill -> BLOQUEA con el 2do msg", r == "Falta final bill", f"{r!r}")
    r = await autos.check_guards({**base7, "images": [{"f": "x"}], "final_bill": "2026-09-10"},
                                 {"production_status": "LISTO PARA ENVIO"}, USER, status_changing=True)
    check("foto + final bill -> pasa", r is None, f"{r!r}")

    print(f"\n{'='*60}\n   {ok} PASS / {fail} FAIL\n{'='*60}")
    sys.exit(1 if fail else 0)


asyncio.run(main())
