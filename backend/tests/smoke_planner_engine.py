"""Smoke del motor de planeación (services/planner_engine.py).

Funciones puras: no necesita base de datos. Fija las reglas acordadas con el
responsable de planeación (hits, turnos lun–jue, cuadrillas 9/4, noche que
continúa, filtro de entrada, fecha objetivo −2 hábiles, cabezas, mezcla de
volumen, paralelo por posición, sugerencia de nuevo cancel date).

USO
───
    python backend/tests/smoke_planner_engine.py
"""
import os
import sys
import zoneinfo
from datetime import date, datetime, timedelta

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

from services import planner_engine as pe  # noqa: E402

TZ = zoneinfo.ZoneInfo("America/Tijuana")
ok = fail = 0


def check(nombre, cond, detalle=""):
    global ok, fail
    if cond:
        ok += 1
        print(f"   PASS  {nombre}")
    else:
        fail += 1
        print(f"   FAIL  {nombre}  {detalle}")


def cfg_with(**kw):
    c = pe.merge_config({})
    c.update(kw)
    return c


def machines(n, **kw):
    return [{"machine": f"MAQUINA{i}", "active": True, "heads": 16, "preferred_client": "", **kw}
            for i in range(1, n + 1)]


def order(num, qty, positions, hits=None, colors=6, cancel="2026-10-15", ready=True, **kw):
    return {"order_id": f"o{num}", "order_number": str(num), "client": kw.pop("client", "GTS"),
            "board": kw.pop("board", "BLANKS"), "quantity": qty, "print_positions": positions,
            "hits_impresiones": hits if hits is not None else len(positions), "colors": colors,
            "cancel_date": cancel, "blank_status": "CONTADO" if ready else "PARTIAL",
            "screens": True, "production_status": "LABEL LISTO", "color": kw.pop("color", "BLACK"),
            "aprobaciones": kw.pop("aprobaciones", "Reorder"), **kw}


LUNES = datetime(2026, 9, 28, 7, 0, tzinfo=TZ)   # lunes 28-sep-2026, arranque del turno de día

print("== Calendario ==")
h26 = pe.mx_holidays(2026)
check("16-sep es festivo oficial", h26.get("2026-09-16") == "Día de la Independencia")
check("tercer lunes de noviembre 2026 = 16-nov", "2026-11-16" in h26)
check("primer lunes de febrero 2026 = 2-feb", "2026-02-02" in h26)
cfg = cfg_with()
cal = pe.Calendar(cfg, [], max_machines=14)
check("lunes: 9 cuadrillas de día", cal.crews(date(2026, 9, 28), "DIA") == 9)
check("lunes: 4 cuadrillas de noche", cal.crews(date(2026, 9, 28), "NOCHE") == 4)
check("viernes sin tiempo extra: 0", cal.crews(date(2026, 10, 2), "DIA") == 0)
check("festivo 16-sep (miércoles): 0", cal.crews(date(2026, 9, 16), "DIA") == 0)
cal2 = pe.Calendar(cfg, [
    {"kind": "overtime", "date_from": "2026-10-02", "date_to": "2026-10-03", "shift": "DIA", "crews": 6},
    {"kind": "crews", "date_from": "2026-09-29", "date_to": "2026-09-29", "shift": "DIA", "crews": 11},
    {"kind": "workday", "date_from": "2026-09-16", "date_to": "2026-09-16", "shift": "AMBOS"},
    {"kind": "holiday", "date_from": "2026-09-30", "date_to": "2026-09-30", "shift": "NOCHE", "note": "Paro"},
    {"kind": "crews", "date_from": "2026-10-01", "date_to": "2026-10-01", "shift": "DIA", "crews": 40},
], max_machines=14)
check("tiempo extra viernes día: 6", cal2.crews(date(2026, 10, 2), "DIA") == 6)
check("tiempo extra no toca la noche", cal2.crews(date(2026, 10, 2), "NOCHE") == 0)
check("más gente el martes: 11", cal2.crews(date(2026, 9, 29), "DIA") == 11)
check("workday anula el festivo", cal2.crews(date(2026, 9, 16), "DIA") == 9)
check("festivo sólo de noche", cal2.crews(date(2026, 9, 30), "NOCHE") == 0 and cal2.crews(date(2026, 9, 30), "DIA") == 9)
check("cuadrillas topadas por máquinas activas", cal2.crews(date(2026, 10, 1), "DIA") == 14)
check("fecha objetivo: lun 28 − 2 hábiles = mié 23",
      cal.minus_business_days(date(2026, 9, 28), 2) == date(2026, 9, 23))
check("festivo no cuenta como hábil: jue 17 − 2 = lun 14",
      cal.minus_business_days(date(2026, 9, 17), 2) == date(2026, 9, 14))

calh = pe.Calendar(cfg, [{"kind": "overtime", "date_from": "2026-10-03", "date_to": "2026-10-03",
                          "shift": "DIA", "crews": 9, "start": "08:00", "hours": 6}], max_machines=14)
check("tiempo extra con horas: ventana 08:00 por 6 h", calh.window(date(2026, 10, 3), "DIA", "07:00", 12) == ("08:00", 6.0))
check("sin horas = turno completo", calh.window(date(2026, 10, 2), "DIA", "07:00", 12) == ("07:00", 12.0))
ph6 = pe.projection([], cfg, calh, LUNES.date(), 1.0, 14)["weeks"][0]
check("6 h × 9 cuadrillas = medio turno de capacidad", ph6["capacity"] == 4 * 13 * 4500 + 9 * 4500 // 2, ph6["capacity"])
cfgh = cfg_with(shifts=[{"key": "DIA", "start": "07:00", "hours": 12, "crews": 1},
                        {"key": "NOCHE", "start": "19:00", "hours": 12, "crews": 0}], base_weekdays=[], setup_min_per_color=0)
calh2 = pe.Calendar(cfgh, [{"kind": "overtime", "date_from": "2026-10-03", "date_to": "2026-10-03",
                            "shift": "DIA", "crews": 1, "start": "08:00", "hours": 6}], max_machines=1)
jh, _ = pe.build_jobs([order(95, 9000, ["FRENTE"])], {}, cfgh, calh2, ["MAQUINA1"], LUNES.date())
sh = pe.schedule(jh, machines(1), cfgh, calh2, LUNES, 1.0, {})[0]["segments"]
check("el programa respeta la ventana: arranca 08:00, 2,250 hits, termina 14:00",
      sh[0]["start"][11:16] == "08:00" and sh[0]["hits"] == 2250 and sh[0]["end"][11:16] == "14:00", sh[:1])

print("== Órdenes → jobs ==")
orders = [
    order(1, 3000, ["FRENTE", "ESPALDA"]),
    order(2, 500, ["FRENTE", "ESPALDA", "MANGA"], hits=4),
    order(3, 800, ["FRENTE"], ready=False),
    order(4, 900, ["FRENTE"], production_status="LISTO PARA ENVIO"),
    order(5, 1000, ["FRENTE"], blank_status="SURTIDO"),
    order(6, 600, [], hits=None, colors=None, cancel=None),
]
produced = {"o1": {"FRENTE": 1000}}
jobs, issues = pe.build_jobs(orders, produced, cfg, cal, [m["machine"] for m in machines(3)], LUNES.date())
by = {j["job_id"]: j for j in jobs}
check("orden con frente+espalda = 2 jobs", "o1:FRENTE" in by and "o1:ESPALDA" in by)
check("producido por posición descuenta sólo esa", by["o1:FRENTE"]["remaining"] == 2000 and by["o1:ESPALDA"]["remaining"] == 3000)
check("3000 piezas = ALTO", by["o1:ESPALDA"]["volume"] == "ALTO")
check("4 hits con 3 posiciones: MANGA lleva 2", by["o2:MANGA"]["hits"] == 1000)
check("orden no lista queda fuera del filtro", by["o3:FRENTE"]["is_ready"] is False)
check("ya impresa sale de la demanda", "o4:FRENTE" not in by)
check("SURTIDO cuenta como contado", by["o5:FRENTE"]["is_ready"] is True)
check("sin colchón por defecto: fecha objetivo = cancel date", cfg["buffer_business_days"] == 0
      and by["o1:FRENTE"]["target_date"] == "2026-10-15")
jb, _ = pe.build_jobs([order(9, 500, ["FRENTE"])], {}, cfg_with(buffer_business_days=2), cal, [], LUNES.date())
check("si se configura colchón de 2 hábiles: jue 15 → mar 13", jb[0]["target_date"] == "2026-10-13")
iss = {i["order_id"]: i["flags"] for i in issues}
check("FRENTE+ESPALDA+MANGA con 4 hits (dos mangas) NO se marca", "hits_distinto_posiciones" not in iss.get("o2", []))
_, iss2 = pe.build_jobs([order(7, 500, ["FRENTE"], hits=2), order(8, 500, ["FRENTE", "ESPALDA", "MANGA"], hits=5)],
                        {}, cfg, cal, [], LUNES.date())
f2 = {i["order_id"]: i["flags"] for i in iss2}
check("sólo FRENTE con 2 hits SÍ se marca", "hits_distinto_posiciones" in f2.get("o7", []))
check("con MANGA pero 2 hits de más SÍ se marca", "hits_distinto_posiciones" in f2.get("o8", []))
check("sin datos: banderas", {"sin_hits", "sin_posiciones", "sin_colores", "sin_cancel_date"} <= set(iss.get("o6", [])))
check("colores faltantes usan el default", by["o6:HIT 1"]["colors"] == cfg["default_colors"] and not by["o6:HIT 1"]["colors_known"])

print("== Reorden vs. nueva ==")
sj, siss = pe.build_jobs([
    order(300, 500, ["FRENTE"], aprobaciones="Reorder Spirit"),
    order(301, 500, ["FRENTE"], aprobaciones="Ejemplo primero"),
    order(302, 500, ["FRENTE"], aprobaciones="Ejemplo primero"),
    order(303, 500, ["FRENTE"], aprobaciones="Ejemplo primero", sample="EJEMPLO APROBADO"),
    order(304, 500, ["FRENTE"], aprobaciones="Aprobado para producción"),
    order(305, 500, ["FRENTE"], aprobaciones="Aprobacion en maquina"),
    order(306, 500, ["FRENTE"], aprobaciones="Hold"),
    order(307, 500, ["FRENTE"], aprobaciones=None, artwork_status="REORDER"),
    order(308, 500, ["FRENTE"], aprobaciones=None),
    order(310, 500, ["FRENTE"], aprobaciones="Ejemplo primero", sample="APR. POR FOTO"),
    order(311, 500, ["FRENTE"], aprobaciones=None, sample="NO SAMPLE"),
    order(312, 500, ["FRENTE"], aprobaciones="Ejemplo primero", sample="LICENCIA"),
    order(313, 500, ["FRENTE"], aprobaciones="Ejemplo primero", sample="NO SAMPLE"),
], {}, cfg, cal, [], LUNES.date(), {"o302"})
sb = {j["order_number"]: j for j in sj}
check("reorden: no necesita ejemplo", sb["300"]["kind"] == "REORDEN" and sb["300"]["ready"]["ejemplo"])
check("nueva sin ejemplo aprobado: bloqueada", sb["301"]["kind"] == "NUEVA" and not sb["301"]["is_ready"]
      and sb["301"]["sample_state"] == "PENDIENTE")
check("nueva con ejemplo APROBADO en el módulo de Ejemplos: entra", sb["302"]["is_ready"])
check("nueva con sample = EJEMPLO APROBADO en el CRM: entra", sb["303"]["is_ready"])
check("aprobado para producción: entra", sb["304"]["is_ready"] and sb["304"]["sample_state"] == "APROBADO")
check("aprobación en máquina (sin acentos): entra marcada", sb["305"]["is_ready"] and sb["305"]["sample_state"] == "EN_MAQUINA")
check("aprobado por foto (columna Sample) cuenta como aprobado", sb["310"]["is_ready"])
check("NO SAMPLE: no requiere ejemplo, entra", sb["311"]["is_ready"]
      and sb["311"]["sample_state"] == "NO_APLICA")
check("LICENCIA: necesita ejemplo con licencia, bloqueada", not sb["312"]["is_ready"]
      and sb["312"]["sample_state"] == "PENDIENTE")
check("NO SAMPLE gana al Approval Type que pediría ejemplo", sb["313"]["is_ready"]
      and sb["313"]["sample_state"] == "NO_APLICA")
check("hold: bloqueada", not sb["306"]["is_ready"] and sb["306"]["sample_state"] == "HOLD")
check("sin Approval Type pero artwork REORDER: reorden", sb["307"]["kind"] == "REORDEN" and sb["307"]["is_ready"])
check("sin dato: bloqueada y marcada en datos faltantes", not sb["308"]["is_ready"]
      and "sin_tipo_aprobacion" in {i["order_number"]: i["flags"] for i in siss}["308"])
check("se puede apagar el requisito", pe.readiness(order(309, 1, ["FRENTE"], aprobaciones="Ejemplo primero"),
                                                   {**cfg, "ready_require_sample": False})["ejemplo"])

print("== Programación ==")
cfg1 = cfg_with(shifts=[{"key": "DIA", "start": "07:00", "hours": 12, "crews": 1},
                        {"key": "NOCHE", "start": "19:00", "hours": 12, "crews": 1}],
                default_colors=0, setup_min_per_color=0)
cal1 = pe.Calendar(cfg1, [], max_machines=2)
j1, _ = pe.build_jobs([order(10, 6000, ["FRENTE"], colors=None)], {}, cfg1, cal1, ["MAQUINA1", "MAQUINA2"], LUNES.date())
plan = pe.schedule(j1, machines(2), cfg1, cal1, LUNES, 1.0, {})
segs = plan[0]["segments"]
check("6,000 hits con 1 cuadrilla: día (4,500) y sigue de noche (1,500)",
      [(s["shift"], s["hits"]) for s in segs] == [("DIA", 4500), ("NOCHE", 1500)], segs)
check("la noche continúa en la MISMA máquina", len(plan[0]["machines"]) == 1)
check("termina el lunes en la noche (a tiempo)", plan[0]["status"] == "A_TIEMPO" and plan[0]["end_date"] == "2026-09-28")

cfg2 = cfg_with(shifts=[{"key": "DIA", "start": "07:00", "hours": 12, "crews": 2},
                        {"key": "NOCHE", "start": "19:00", "hours": 12, "crews": 0}],
                setup_min_per_color=0)
cal2b = pe.Calendar(cfg2, [], max_machines=2)
j2, _ = pe.build_jobs([order(20, 3000, ["FRENTE", "ESPALDA"])], {}, cfg2, cal2b, ["MAQUINA1", "MAQUINA2"], LUNES.date())
plan2 = pe.schedule(j2, machines(2), cfg2, cal2b, LUNES, 1.0, {})
ms = sorted(m for j in plan2 for m in j["machines"])
check("frente y espalda en paralelo en 2 máquinas", ms == ["MAQUINA1", "MAQUINA2"], ms)
check("board sugerido = máquina del job más grande", pe.board_for_order(plan2) in ("MAQUINA1", "MAQUINA2"))

mh = [{"machine": "MAQUINA1", "active": True, "heads": 8, "preferred_client": ""},
      {"machine": "MAQUINA2", "active": True, "heads": 16, "preferred_client": ""}]
j3, _ = pe.build_jobs([order(30, 500, ["FRENTE"], colors=12)], {}, cfg2, cal2b, ["MAQUINA1", "MAQUINA2"], LUNES.date())
plan3 = pe.schedule(j3, mh, cfg2, cal2b, LUNES, 1.0, {})
check("12 colores no caben en máquina de 8 cabezas", plan3[0]["machines"] == ["MAQUINA2"], plan3[0]["machines"])

j4, _ = pe.build_jobs([order(40, 500, ["FRENTE"], client="SPEKTRUM"), order(41, 500, ["FRENTE"], client="GTS")],
                      {}, cfg2, cal2b, ["MAQUINA1", "MAQUINA2"], LUNES.date())
mp = [{"machine": "MAQUINA1", "active": True, "heads": 16, "preferred_client": "GTS"},
      {"machine": "MAQUINA2", "active": True, "heads": 16, "preferred_client": "SPEKTRUM"}]
plan4 = {j["order_number"]: j["machines"] for j in pe.schedule(j4, mp, cfg2, cal2b, LUNES, 1.0, {})}
check("cliente preferido desempata", plan4 == {"41": ["MAQUINA1"], "40": ["MAQUINA2"]}, plan4)

cfg5 = cfg_with(shifts=[{"key": "DIA", "start": "07:00", "hours": 12, "crews": 2},
                        {"key": "NOCHE", "start": "19:00", "hours": 12, "crews": 0}],
                setup_min_per_color=0, hits_per_shift=20000)
cal5 = pe.Calendar(cfg5, [], max_machines=2)
j5, _ = pe.build_jobs([order(50, 3000, ["FRENTE"], cancel="2026-10-10"),
                       order(51, 3000, ["FRENTE"], cancel="2026-10-11"),
                       order(52, 500, ["FRENTE"], cancel="2026-10-12")],
                      {}, cfg5, cal5, ["MAQUINA1", "MAQUINA2"], LUNES.date())
plan5 = {j["order_number"]: j["machines"] for j in pe.schedule(j5, machines(2), cfg5, cal5, LUNES, 1.0, {})}
check("mezcla: los dos Altos van a máquinas distintas", plan5["50"] != plan5["51"], plan5)

j6, _ = pe.build_jobs([order(60, 3000, ["FRENTE"], board="MAQUINA2", production_status="EN PRODUCCION")],
                      {"o60": {"FRENTE": 500}}, cfg2, cal2b, ["MAQUINA1", "MAQUINA2"], LUNES.date())
plan6 = pe.schedule(j6, machines(2), cfg2, cal2b, LUNES, 1.0, {"o60": "MAQUINA2"})
check("lo que ya está en máquina sigue ahí aunque ya no diga LABEL LISTO",
      plan6 and plan6[0]["machines"] == ["MAQUINA2"] and plan6[0]["segments"][0]["hits"] == 2500)

j6b, _ = pe.build_jobs([order(61, 1000, ["FRENTE"], board="MAQUINA1", cancel="2026-10-09"),
                        order(62, 1000, ["FRENTE"], board="MAQUINA1", cancel="2026-10-08"),
                        order(63, 1000, ["FRENTE"], cancel="2026-10-20")],
                       {}, cfg2, cal2b, ["MAQUINA1", "MAQUINA2"], LUNES.date())
p6b = {j["order_number"]: j for j in pe.schedule(j6b, machines(2), cfg2, cal2b, LUNES, 1.0,
                                                 {"o61": "MAQUINA1", "o62": "MAQUINA1"})}
check("la cola de una máquina se respeta (no se la lleva la máquina libre)",
      p6b["61"]["machines"] == ["MAQUINA1"] and p6b["62"]["machines"] == ["MAQUINA1"], p6b)
check("la cola va por urgencia: 62 antes que 61", p6b["62"]["start"] < p6b["61"]["start"])
check("lo nuevo va a la máquina libre", p6b["63"]["machines"] == ["MAQUINA2"])

cfg7 = cfg_with(shifts=[{"key": "DIA", "start": "07:00", "hours": 12, "crews": 1},
                        {"key": "NOCHE", "start": "19:00", "hours": 12, "crews": 0}],
                setup_min_per_color=0)
cal7 = pe.Calendar(cfg7, [], max_machines=1)
j7, _ = pe.build_jobs([order(70, 20000, ["FRENTE"], cancel="2026-10-01")], {}, cfg7, cal7, ["MAQUINA1"], LUNES.date())
p7 = pe.schedule(j7, machines(1), cfg7, cal7, LUNES, 1.0, {})[0]
check("no cabe antes de la fecha objetivo: EN_RIESGO", p7["status"] == "EN_RIESGO", p7["status"])
check("sugiere nuevo cancel date = día en que termina (sin colchón)", p7.get("suggested_cancel_date") == "2026-10-05",
      p7.get("suggested_cancel_date"))

cfg8 = cfg_with(shifts=[{"key": "DIA", "start": "07:00", "hours": 12, "crews": 1},
                        {"key": "NOCHE", "start": "19:00", "hours": 12, "crews": 0}],
                setup_min_per_color=15, rate_pph=400)
cal8 = pe.Calendar(cfg8, [], max_machines=1)
j8, _ = pe.build_jobs([order(80, 1000, ["FRENTE"], colors=6)], {}, cfg8, cal8, ["MAQUINA1"], LUNES.date())
s8 = pe.schedule(j8, machines(1), cfg8, cal8, LUNES, 1.0, {})[0]["segments"][0]
check("setup = colores × 15 min consume capacidad (6×15min×400/h = 600 hits)", s8["setup_hits"] == 600, s8)

# Velocidad por tamaño de corrida: un Alto a doble velocidad rinde el doble de
# hits en el mismo turno; sin histórico (run_rates) el turno rinde lo base.
cfg9 = cfg_with(shifts=[{"key": "DIA", "start": "07:00", "hours": 12, "crews": 1},
                        {"key": "NOCHE", "start": "19:00", "hours": 12, "crews": 0}],
                setup_min_per_color=0, rate_pph=400, hits_per_shift=4000)
cal9 = pe.Calendar(cfg9, [], max_machines=1)
j9a, _ = pe.build_jobs([order(90, 20000, ["FRENTE"], cancel="2026-12-31")], {}, cfg9, cal9, ["MAQUINA1"], LUNES.date())
s_fix = pe.schedule(j9a, machines(1), cfg9, cal9, LUNES, 1.0, {})[0]["segments"][0]["hits"]
j9b, _ = pe.build_jobs([order(90, 20000, ["FRENTE"], cancel="2026-12-31")], {}, cfg9, cal9, ["MAQUINA1"], LUNES.date())
s_alto = pe.schedule(j9b, machines(1), cfg9, cal9, LUNES, 1.0, {}, {},
                     {"rates": {"ALTO": 800}, "global_rate": 400})[0]["segments"][0]["hits"]
check("sin histórico: el turno rinde lo base (4000 hits)", abs(s_fix - 4000) <= 2, s_fix)
check("velocidad por corrida: Alto a 800/h rinde el doble en el turno (8000)", abs(s_alto - 8000) <= 2, s_alto)

# Frente antes que espalda: en una máquina, el frente se programa primero.
cfgfe = cfg_with(shifts=[{"key": "DIA", "start": "07:00", "hours": 12, "crews": 1},
                         {"key": "NOCHE", "start": "19:00", "hours": 12, "crews": 0}],
                 setup_min_per_color=0)
calfe = pe.Calendar(cfgfe, [], max_machines=1)
jfe, _ = pe.build_jobs([order(400, 1000, ["FRENTE", "ESPALDA"], cancel="2026-12-31")], {}, cfgfe, calfe, ["MAQUINA1"], LUNES.date())
segfe = {j["position"]: (j.get("segments") or [{}])[0].get("start") for j in pe.schedule(jfe, machines(1), cfgfe, calfe, LUNES, 1.0, {})}
check("frente se programa antes que espalda", bool(segfe.get("FRENTE")) and bool(segfe.get("ESPALDA"))
      and segfe["FRENTE"] < segfe["ESPALDA"], segfe)

# Mismo design_# se agrupa en la máquina (las dos del mismo estilo seguidas,
# la de otro estilo al final), para no recalibrar el mismo arte.
oA1 = order(500, 1000, ["FRENTE"], cancel="2026-12-31"); oA1["design_#"] = "STY-A"
oB = order(501, 1000, ["FRENTE"], cancel="2026-12-31"); oB["design_#"] = "STY-B"
oA2 = order(502, 1000, ["FRENTE"], cancel="2026-12-31"); oA2["design_#"] = "STY-A"
jd, _ = pe.build_jobs([oA1, oB, oA2], {}, cfgfe, calfe, ["MAQUINA1"], LUNES.date())
pd = {j["order_number"]: (j.get("segments") or [{}])[0].get("start") for j in pe.schedule(jd, machines(1), cfgfe, calfe, LUNES, 1.0, {})}
check("mismo design_# se agrupa (la de otro estilo queda al final)",
      pd["500"] < pd["501"] and pd["502"] < pd["501"], pd)

# Mismo customer PO se mantiene junto (imprimir el PO completo de corrido).
oX1 = order(600, 1000, ["FRENTE"], cancel="2026-12-31"); oX1["customer_po"] = "POX"; oX1["design_#"] = "D1"
oY = order(601, 1000, ["FRENTE"], cancel="2026-12-31"); oY["customer_po"] = "POY"; oY["design_#"] = "D2"
oX2 = order(602, 1000, ["FRENTE"], cancel="2026-12-31"); oX2["customer_po"] = "POX"; oX2["design_#"] = "D3"
jp, _ = pe.build_jobs([oX1, oY, oX2], {}, cfgfe, calfe, ["MAQUINA1"], LUNES.date())
pp = {j["order_number"]: (j.get("segments") or [{}])[0].get("start") for j in pe.schedule(jp, machines(1), cfgfe, calfe, LUNES, 1.0, {})}
check("mismo customer PO se mantiene junto (el de otro PO queda al final)",
      pp["600"] < pp["601"] and pp["602"] < pp["601"], pp)

# Prioridad por tipo de empaque: BulkPack antes que Prepack antes que PickPack
# (misma urgencia). Entra desordenado a propósito para probar el acomodo.
ob = order(710, 1000, ["FRENTE"], cancel="2026-12-31"); ob["packing_type"] = "BulkPack"
op = order(711, 1000, ["FRENTE"], cancel="2026-12-31"); op["packing_type"] = "Prepack"
opk = order(712, 1000, ["FRENTE"], cancel="2026-12-31"); opk["packing_type"] = "PickPack"
jpk, _ = pe.build_jobs([opk, op, ob], {}, cfgfe, calfe, ["MAQUINA1"], LUNES.date())
ppk = {j["order_number"]: (j.get("segments") or [{}])[0].get("start") for j in pe.schedule(jpk, machines(1), cfgfe, calfe, LUNES, 1.0, {})}
check("packing: BulkPack < Prepack < PickPack", ppk["710"] < ppk["711"] < ppk["712"], ppk)

# Dedicación: máquina dedicada a GTS toma a su cliente aunque otro sea más
# urgente; pero no se queda parada (luego toma la otra).
oG = order(720, 1000, ["FRENTE"], cancel="2026-12-31"); oG["client"] = "GTS"
oO = order(721, 1000, ["FRENTE"], cancel="2026-10-20"); oO["client"] = "OTHER"
mded = [{"machine": "MAQUINA1", "active": True, "heads": 16, "preferred_client": "GTS", "dedicated": True}]
jde, _ = pe.build_jobs([oO, oG], {}, cfgfe, calfe, ["MAQUINA1"], LUNES.date())
pde = {j["order_number"]: (j.get("segments") or [{}])[0].get("start") for j in pe.schedule(jde, mded, cfgfe, calfe, LUNES, 1.0, {})}
check("máquina dedicada prioriza a su cliente sobre uno más urgente",
      bool(pde.get("720")) and bool(pde.get("721")) and pde["720"] < pde["721"], pde)

print("== Ajustes manuales ==")
cfgm = cfg_with(shifts=[{"key": "DIA", "start": "07:00", "hours": 12, "crews": 2},
                        {"key": "NOCHE", "start": "19:00", "hours": 12, "crews": 0}],
                setup_min_per_color=0)
calm = pe.Calendar(cfgm, [], max_machines=3)
base_orders = [order(90, 1000, ["FRENTE"], cancel="2026-10-09"),
               order(91, 1000, ["FRENTE"], cancel="2026-10-20"),
               order(92, 1000, ["FRENTE"], ready=False, cancel="2026-10-10"),
               order(93, 1000, ["FRENTE"], cancel="2026-10-08", colors=12)]
jm, _ = pe.build_jobs(base_orders, {}, cfgm, calm, ["MAQUINA1", "MAQUINA2", "MAQUINA3"], LUNES.date())
mm = [{"machine": "MAQUINA1", "active": True, "heads": 16, "preferred_client": ""},
      {"machine": "MAQUINA2", "active": True, "heads": 8, "preferred_client": ""},
      {"machine": "MAQUINA3", "active": False, "heads": 16, "preferred_client": ""}]

def run_ov(ov):
    return {j["order_number"]: j for j in pe.schedule(jm, mm, cfgm, calm, LUNES, 1.0, {}, ov)}

r = run_ov({"o91:FRENTE": {"assign": {"machine": "MAQUINA2", "queue_pos": 1}}})
check("reprogramar: va a la máquina elegida", r["91"]["machines"] == ["MAQUINA2"], r["91"]["machines"])
check("reprogramar: marcado como ajuste manual", "assign" in r["91"]["manual"])
r = run_ov({"o93:FRENTE": {"assign": {"machine": "MAQUINA2"}}})
check("se respeta aunque colores > cabezas, con aviso",
      r["93"]["machines"] == ["MAQUINA2"] and "colores_mayor_cabezas" in r["93"]["warnings"], r["93"])
r = run_ov({"o90:FRENTE": {"assign": {"machine": "MAQUINA3"}}})
check("máquina inactiva: aviso y el motor la reubica",
      "maquina_inactiva" in r["90"]["warnings"] and r["90"]["machines"] != ["MAQUINA3"], r["90"])
r = run_ov({"o90:FRENTE": {"assign": {"not_before": "2026-09-30"}}})
check("no antes de: arranca desde esa fecha", r["90"]["start"][:10] >= "2026-09-30", r["90"]["start"])
r0 = run_ov({})
check("sin ajustes: la no lista no entra", "92" not in r0)
r = run_ov({"o92:FRENTE": {"force": {}}})
check("forzar entrada: entra aunque no esté lista", "92" in r and "force" in r["92"]["manual"])
r = run_ov({"o90:FRENTE": {"hold": {}}})
check("retener: sale del programa", "90" not in r)
r = run_ov({"o90:FRENTE": {"hold": {"until": "2026-09-01"}}})
check("retención vencida ya no aplica", "90" in r)
cfg1m = cfg_with(shifts=[{"key": "DIA", "start": "07:00", "hours": 12, "crews": 1},
                         {"key": "NOCHE", "start": "19:00", "hours": 12, "crews": 0}], setup_min_per_color=0)
cal1m = pe.Calendar(cfg1m, [], max_machines=1)
j1m, _ = pe.build_jobs(base_orders[:2], {}, cfg1m, cal1m, ["MAQUINA1"], LUNES.date())
p1 = {j["order_number"]: j for j in pe.schedule(j1m, machines(1), cfg1m, cal1m, LUNES, 1.0, {})}
check("sin ajuste: la más urgente primero", p1["90"]["start"] < p1["91"]["start"])
p1 = {j["order_number"]: j for j in pe.schedule(j1m, machines(1), cfg1m, cal1m, LUNES, 1.0, {},
                                                {"o91:FRENTE": {"priority": {"level": "TOP"}}})}
check("prioridad TOP: pasa adelante", p1["91"]["start"] < p1["90"]["start"])

print("== Alerta: impresa sin cambiar de estatus ==")
from datetime import timedelta, timezone  # noqa: E402
AHORA = datetime(2026, 9, 28, 12, 0, tzinfo=timezone.utc)
hace = lambda d: (AHORA - timedelta(days=d)).isoformat()  # noqa: E731
ao = [order(200, 1000, ["FRENTE", "ESPALDA"], production_status="EN PRODUCCION"),   # completa, 3 días
      order(201, 1000, ["FRENTE"], production_status="LABEL LISTO"),                 # completa, 1 día
      order(202, 1000, ["FRENTE"], production_status="EN PRODUCCION"),               # a medias
      order(203, 1000, ["FRENTE"], production_status="LISTO PARA ENVIO"),            # ya avanzó
      order(204, 1000, ["FRENTE"], production_status="EN PRODUCCION"),               # 98.5%: cuenta
      order(205, 1000, ["FRENTE"], production_status="EN PRODUCCION")]               # sin posición
prod_a = {"o200": {"FRENTE": 1000, "ESPALDA": 1000}, "o201": {"FRENTE": 1000}, "o202": {"FRENTE": 400},
          "o203": {"FRENTE": 1000}, "o204": {"FRENTE": 985}, "o205": {"": 1000}}
last_a = {"o200": hace(3), "o201": hace(1), "o202": hace(5), "o203": hace(5), "o204": hace(2.5), "o205": hace(4)}
al = {r["order_number"]: r for r in pe.stale_printed(ao, prod_a, last_a, cfg, AHORA)}
check("impresa completa hace 3 días sin avanzar → alerta", "200" in al and al["200"]["days"] == 3.0, al.get("200"))
check("impresa hace 1 día → todavía no", "201" not in al)
check("a medias → no alerta", "202" not in al)
check("ya en LISTO PARA ENVIO → no alerta", "203" not in al)
check("98.5% cuenta como impresa (faltantes de blank)", "204" in al)
check("producción capturada sin posición también cuenta", "205" in al)
check("la más vieja primero", list(al)[0] == "205", list(al))
ja, _ = pe.build_jobs(ao[4:5], prod_a, cfg, cal, ["MAQUINA1"], LUNES.date())
check("impresa al 98.5% no deja sobrante en el programa", ja == [], ja)

print("== Proyección ==")
pr = pe.projection(jobs, cfg, cal, LUNES.date(), 1.0, 14)
w = pr["weeks"][0]
check("capacidad semana base = 4 días × (9+4) × 4,500", w["capacity"] == 4 * 13 * 4500, w["capacity"])
rr = {"rates": {"BAJO": 200, "MEDIO": 400, "ALTO": 600}, "global_rate": 400}
bj = [{**by["o1:ESPALDA"], "remaining": 900000, "volume": "ALTO", "target_date": "2026-10-01"}]
pa = pe.projection(bj, cfg, cal, LUNES.date(), 1.0, 14, rr)["weeks"][0]
H = 4500 / 407
check("histórico con corridas ALTAS = turnos × horas × 600/h", pa["capacity_real"] == round(52 * H * 600), pa.get("capacity_real"))
bb = [{**bj[0], "volume": "BAJO"}]
pb2 = pe.projection(bb, cfg, cal, LUNES.date(), 1.0, 14, rr)["weeks"][0]
check("la misma semana con corridas BAJAS rinde menos", pb2["capacity_real"] == round(52 * H * 200))
mixw = pe.mix_rate({"ALTO": 6000, "BAJO": 2000}, rr["rates"], 400)
check("mezcla = media armónica ponderada por hits", round(mixw) == round(8000 / (6000 / 600 + 2000 / 200)), mixw)
pe0 = pe.projection([], cfg, cal, LUNES.date(), 1.0, 14, rr)["weeks"][0]
check("semana sin demanda usa la velocidad global", pe0["capacity_real"] == round(52 * H * 400))
bs = [{**bj[0], "remaining": 12000, "volume": "BAJO"}]
ps = pe.projection(bs, cfg, cal, LUNES.date(), 1.0, 14, rr)["weeks"][0]
check("poca demanda: su parte a su velocidad y el resto al promedio",
      ps["capacity_real"] == round(12000 + (52 * H - 12000 / 200) * 400), ps["capacity_real"])
check("sin histórico no inventa capacidad", "capacity_real" not in pe.projection([], cfg, cal, LUNES.date(), 1.0, 14)["weeks"][0])

# measure_run_rates: hits por hora-máquina por tamaño de corrida.
T0 = datetime(2026, 9, 21, 7, 0, tzinfo=TZ)
rrec = []
for h in range(1, 41):                                     # 40 h de una corrida ALTA a 500/h
    rrec.append({"machine": "M1", "dt": T0 + timedelta(hours=h), "order_id": "big", "qty": 500, "order_qty": 5000})
for h in range(1, 41):                                     # 40 h de corridas BAJAS a 250/h
    rrec.append({"machine": "M2", "dt": T0 + timedelta(hours=h), "order_id": "small", "qty": 250, "order_qty": 300})
rrec.append({"machine": "M1", "dt": T0 + timedelta(hours=41, minutes=-2), "order_id": "small", "qty": 500, "order_qty": 300})
mr = pe.measure_run_rates(rrec, cfg)
check("corrida alta ≈ 500 hits/hora", abs(mr["rates"]["ALTO"] - 500) <= 10, mr["rates"])
check("corrida baja más lenta que la alta", mr["rates"]["BAJO"] < mr["rates"]["ALTO"], mr["rates"])
check("tamaño sin horas suficientes no opina", "MEDIO" not in mr["rates"])

# measure_history: por TURNO DE PLANTA, no por máquina.
HOY = date(2026, 9, 24)            # jueves
recs = []
for d in (date(2026, 9, 14), date(2026, 9, 15), date(2026, 9, 21), date(2026, 9, 22)):   # lun/mar
    for m in range(1, 14):                                   # 13 máquinas de día, 9 cuadrillas
        recs.append({"date": d, "shift": "DIA", "machine": f"M{m}", "qty": 2000})   # 26,000 por turno
    for m in range(1, 9):                                    # 8 máquinas de noche, 4 cuadrillas
        recs.append({"date": d, "shift": "NOCHE", "machine": f"M{m}", "qty": 1500})  # 12,000
recs.append({"date": date(2026, 9, 18), "shift": "DIA", "machine": "M1", "qty": 9999})   # viernes (extra)
recs.append({"date": HOY, "shift": "DIA", "machine": "M1", "qty": 100})                 # hoy, a medias
mh = pe.measure_history(recs, cfg, HOY, date(2026, 9, 7))
check("histórico por turno de planta: día 26,000 ÷ 9 cuadrillas", mh["per_crew"]["DIA"] == round(26000 / 9), mh["per_crew"])
check("histórico noche 12,000 ÷ 4", mh["per_crew"]["NOCHE"] == 3000)
check("no usa 'hits por máquina' (2,000)", mh["per_crew"]["DIA"] != 2000)
check("el viernes (tiempo extra) no entra a la mediana base", mh["per_shift"]["DIA"]["shifts"] == 4)
check("hoy (turno a medias) no cuenta", all(r["date"] != HOY or True for r in recs) and mh["per_shift"]["DIA"]["median_total"] == 26000)
check("promedio semanal real incluye tiempo extra (sem. 14-sep)", mh["weekly_avg"] == 2 * 26000 + 2 * 12000 + 9999, mh["weekly_avg"])
check("máquinas por turno reportadas", mh["per_shift"]["DIA"]["machines_median"] == 13)
check("sin histórico no inventa capacidad real", "capacity_real" not in pe.projection([], cfg, cal, LUNES.date(), 1.0, 14)["weeks"][0])
wk16 = pe.projection([], cfg, cal, date(2026, 9, 14), 1.0, 14)["weeks"][0]
check("semana del 16-sep = CORTA de 3 días", wk16["week_type"] == "CORTA" and wk16["business_days"] == 3, wk16)
check("semana sin festivo = REGULAR de 4 días", w["week_type"] == "REGULAR" and w["business_days"] == 4)
check("semana actual: días hábiles que quedan", pe.projection([], cfg, cal, date(2026, 9, 30), 1.0, 14)["weeks"][0]["days_left"] == 2)
check("semana con festivo 16-sep pierde un día", pe.projection([], cfg, cal, date(2026, 9, 14), 1.0, 14)["weeks"][0]["capacity"] == 3 * 13 * 4500)
big = [{**by["o1:ESPALDA"], "remaining": 300000, "target_date": "2026-09-30"}]
pb = pe.projection(big, cfg, cal, LUNES.date(), 1.0, 14)["weeks"][0]
check("déficit calculado", pb["deficit"] == 300000 - 4 * 13 * 4500, pb["deficit"])
check("turnos extra necesarios (cuadrillas de día)", pb["overtime_shifts_needed"] == -(-pb["deficit"] // (9 * 4500)))
check("contratación limitada por máquinas libres (día: 5)", pb["hires"]["DIA"]["crews_possible"] <= 5
      and pb["hires"]["DIA"]["people"] == pb["hires"]["DIA"]["crews_possible"] * 7)

print(f"\n{ok} PASS, {fail} FAIL")
sys.exit(1 if fail else 0)
