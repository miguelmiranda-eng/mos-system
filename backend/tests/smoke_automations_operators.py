"""Smoke OFFLINE de los operadores de comparación (Fase 3, Track 2).

Congela _compare y las condiciones "avanzadas" (trigger_conditions.advanced =
[{field, op, value}]) en el evaluador normal (check_conditions) y en las guardas
(_guard_conditions_match). A diferencia del filtro plano, aquí un campo AUSENTE
con eq NO casa. Reglas viejas (sin `advanced`) no cambian.

USO
───
    backend/venv/Scripts/python.exe backend/tests/smoke_automations_operators.py
"""
import os
import sys

BE = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
for k in ("MONGODB_URL", "DB_NAME", "JWT_SECRET", "MASTER_API_KEY", "INTERNAL_SYNC_TOKEN", "ENV", "RESEND_API_KEY"):
    os.environ.setdefault(k, "smoke")
sys.path.insert(0, BE)
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

from routers.automations import _compare, check_conditions, _guard_conditions_match  # noqa: E402

ok = fail = 0


def check(name, cond, detail=""):
    global ok, fail
    if cond:
        ok += 1
        print(f"   PASS  {name}")
    else:
        fail += 1
        print(f"   FAIL  {name}  {detail}")


print("\n1) _compare: operadores")
check("gt: 1600 > 1500", _compare(1600, "gt", "1500") is True)
check("gt: 1400 > 1500 -> False", _compare(1400, "gt", "1500") is False)
check("gte: 1500 >= 1500", _compare("1,500", "gte", 1500) is True)
check("lt: 100 < 50 -> False", _compare(100, "lt", 50) is False)
check("lte: 50 <= 50", _compare(50, "lte", 50) is True)
check("eq: SI == SI", _compare("SI", "eq", "SI") is True)
check("ne: NO != SI", _compare("NO", "ne", "SI") is True)
check("contains: 'TUPAC TEE' contiene 'tupac'", _compare("TUPAC TEE", "contains", "tupac") is True)
check("in: RUSH en [RUSH,EVENT]", _compare("RUSH", "in", "RUSH, EVENT") is True)
check("in: LOW en [RUSH,EVENT] -> False", _compare("LOW", "in", "RUSH, EVENT") is False)
check("is_set: valor -> True", _compare("x", "is_set", None) is True)
check("is_set: vacío -> False", _compare("", "is_set", None) is False)
check("not_set: None -> True", _compare(None, "not_set", None) is True)
check("eq sobre no-número: gt con basura -> False", _compare("abc", "gt", "5") is False)

print("\n2) check_conditions: lista advanced (AND) + campo ausente con eq NO casa")
order = {"quantity": 2000, "priority": "RUSH", "sample_printavo": "SI"}
ctx = {"changed_fields": ["production_status"]}
c = {"advanced": [{"field": "quantity", "op": "gt", "value": "1500"}]}
check("qty 2000 > 1500 -> pasa", check_conditions(c, order, ctx) is True)
c = {"advanced": [{"field": "quantity", "op": "gt", "value": "1500"},
                  {"field": "priority", "op": "in", "value": "RUSH,EVENT"}]}
check("AND: qty>1500 y priority in [...] -> pasa", check_conditions(c, order, ctx) is True)
c = {"advanced": [{"field": "quantity", "op": "lt", "value": "500"}]}
check("qty 2000 < 500 -> NO pasa", check_conditions(c, order, ctx) is False)
c = {"advanced": [{"field": "final_bill", "op": "eq", "value": "2026-09-10"}]}
check("campo AUSENTE con eq -> NO casa (estricto)", check_conditions(c, order, ctx) is False)
c = {"advanced": [{"field": "final_bill", "op": "not_set", "value": None}]}
check("campo ausente con not_set -> pasa", check_conditions(c, order, ctx) is True)

print("\n3) compatibilidad: sin advanced el filtro plano manda")
check("plano sample_printavo=SI -> pasa", check_conditions({"sample_printavo": "SI"}, order, ctx) is True)
check("plano sample_printavo=NO -> no pasa", check_conditions({"sample_printavo": "NO"}, order, ctx) is False)
check("plano campo ausente sigue pasando (comportamiento viejo)",
      check_conditions({"final_bill": "x"}, order, ctx) is True)

print("\n4) guardas: advanced estricto")
g = {"on": "status_change", "advanced": [{"field": "quantity", "op": "gte", "value": "1500"}]}
check("guarda: qty 2000 >= 1500 -> aplica (match)", _guard_conditions_match(g, order) is True)
g = {"on": "status_change", "advanced": [{"field": "quantity", "op": "gte", "value": "5000"}]}
check("guarda: qty 2000 >= 5000 -> no aplica", _guard_conditions_match(g, order) is False)
g = {"on": "status_change", "sample_printavo": "SI",
     "advanced": [{"field": "quantity", "op": "gt", "value": "1000"}]}
check("guarda: flag plano + advanced juntos", _guard_conditions_match(g, order) is True)

print(f"\n{'='*60}\n   {ok} PASS / {fail} FAIL\n{'='*60}")
sys.exit(1 if fail else 0)
