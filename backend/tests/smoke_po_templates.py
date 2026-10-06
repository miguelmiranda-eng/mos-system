"""Smoke del motor de plantillas (`services/po_templates.py`).

QUE PRUEBA
──────────
Que una plantilla que es PURO DATO — sin una sola linea de codigo por cliente —
saca de un PDF lo mismo que el parser escrito a mano. Se usa como banco de
pruebas el formato de Goodie porque es el unico del que tenemos corpus real y
una referencia confiable (`fixtures/po_golden.json`).

OJO: esto NO significa que Goodie vaya a leerse con plantillas. Goodie y Culture
Kings se quedan con su lector escrito a mano, que lleva meses corriendo. La
plantilla de aqui es un BANCO DE PRUEBAS: si el vocabulario alcanza para el
formato mas enredado que tenemos, alcanza para un cliente nuevo.

Si este smoke se pone rojo, el motor dejo de poder expresar un formato real y el
mapeador visual que se construya encima heredaria el problema.

USO
───
    backend/venv/Scripts/python.exe backend/tests/smoke_po_templates.py
"""
import json
import os
import sys

BE = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
os.environ.setdefault("MONGODB_URL", "mongodb://localhost:27017")
os.environ.setdefault("DB_NAME", "mos-offline-test")
os.environ.setdefault("JWT_SECRET", "offline_secret")
os.environ.setdefault("MASTER_API_KEY", "smoke_master_key")
os.environ.setdefault("INTERNAL_SYNC_TOKEN", "smoke_sync_token")
os.environ.setdefault("ENV", "local")
sys.path.insert(0, BE)

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

import pdfplumber  # noqa: E402

from routers.import_router import SIZES_MAP  # noqa: E402
from services.po_templates import leer_pdf  # noqa: E402

CORPUS = os.path.join(os.path.dirname(__file__), "fixtures", "po")
GOLDEN = os.path.join(os.path.dirname(__file__), "fixtures", "po_golden.json")

# El renglon del estilo trae 6 datos juntos; con una sola expresion y un grupo
# por campo se sacan todos. Es el escape hatch del vocabulario, el que el
# mapeador ofreceria cuando apuntar con el mouse no alcanza.
LINEA_ESTILO = (
    r"^(?P<design>\S+)\s+(?P<color>\S+)(?:\s+\S+)?\s+(?P<ln>\d+)\s+(?P<wh>[A-Z]{2})\s+"
    r"(?P<ref>\S+)\s+(?P<cloth>\S+)\s+(?P<desc>.+?)\s+(?P<qty>[\d,]+)\s+"
    r"(?P<price>[\d,.]+)\s+[\d,.]+\s*$"
)

PLANTILLA = {
    "id": "banco_pruebas_mct",
    "nombre": "Banco de pruebas — Master Cut Ticket",
    "huella": {"contiene": ["Master Cut Ticket", "GOODIE TWO SLEEVES"]},
    "campos": {
        "po_number":   {"tipo": "patron", "patron": r"^\d+\s+\d+\s+(\d+)$", "grupo": 1},
        "brand":       {"tipo": "derecha_de", "rotulo": "CUSTOMER", "hasta": "ISSUE DATE"},
        "ship_date":   {"tipo": "patron", "patron": r"\bSHIP\s+(\d{1,2}-[A-Z]{3}-\d{2})", "grupo": 1},
        "cancel_date": {"tipo": "patron", "patron": r"CANCEL\s+(\d{1,2}-[A-Z]{3}-\d{2})", "grupo": 1},
        "design_num":  {"tipo": "patron", "patron": LINEA_ESTILO, "grupo": "design"},
        # El color necesita recorte de columna: el renglon del estilo solo trae la
        # abreviacion ("LPK") y el nombre completo ("LIGHT PINK") va en el de abajo.
        "color":       {"tipo": "columna", "desde": "STYLE", "rotulo": "COLOR",
                        "limite": "Ln", "fondo": "Category", "fila": "ultima"},
        "blank":       {"tipo": "patron", "patron": LINEA_ESTILO, "grupo": "cloth"},
        "description": {"tipo": "patron", "patron": LINEA_ESTILO, "grupo": "desc"},
        "qty":         {"tipo": "patron", "patron": LINEA_ESTILO, "grupo": "qty"},
        "unit_price":  {"tipo": "patron", "patron": LINEA_ESTILO, "grupo": "price"},
    },
    "tallas": {"tipo": "rejilla", "rotulo_tallas": "SIZE", "rotulo_cantidades": "QTY"},
}

# Un PDF por tienda, para que el banco cubra formatos y no solo repeticiones.
CASOS = [
    "23036_-_Meijer.pdf",
    "23017_TRACTOR_SUPPLY_REV1.pdf",
    "23258_-_Spencers_-_327049.pdf",
    "22958_-_Aeropostale.pdf",
    "22775_KOHLS_REV1.pdf",
    "23112_-_JC_Penney.pdf",
    "23022_-_Spencers_-_P028443_-_326215.pdf",
]

# `store_po` queda fuera a proposito: el parser a mano tiene un respaldo extra
# (lo busca tambien en las notas "SPENCER PO 322586") que el vocabulario todavia
# no expresa. Es el hueco conocido del motor, no una falla del banco.
CAMPOS = ["po_number", "design_num", "color", "blank", "qty",
          "sizes", "qty_from_sizes", "sizes_match"]



def _ruteo():
    """El orden de `parse_po_bytes`: Goodie -> Spektrum -> plantillas.

    Lo que se protege aqui es que las plantillas NO puedan cambiar como se lee un
    PDF que hoy ya se lee bien. Son el ultimo recurso: a lo mas atrapan uno que
    antes nadie reconocia."""
    import routers.printavo_export as px

    ruta = os.path.join(CORPUS, "23258_-_Spencers_-_327049.pdf")
    if not os.path.exists(ruta):
        return []
    with open(ruta, "rb") as fh:
        data = fh.read()
    # Este PDF rotula al cliente como "CUST", no "CUSTOMER" — el mismo cliente usa
    # las dos variantes segun la tienda. Es justo lo que atrapa el paso de probar
    # la plantilla contra un SEGUNDO PDF antes de activarla.
    activa = {**PLANTILLA, "activa": True,
              "campos": {**PLANTILLA["campos"],
                         "brand": {"tipo": "derecha_de", "rotulo": "CUST", "hasta": "ISSUE DATE"},
                         "store_po": {"tipo": "debajo_de", "rotulo": "CUST PO", "limite": "BLANK PO"}}}
    malas = []

    def ok(cond, msg):
        if not cond:
            malas.append(f"ruteo: {msg}")

    _, eng = px.parse_po_bytes(data, [activa])
    ok(eng == "text", f"con plantilla activa el lector de Goodie debe seguir ganando (dio {eng!r})")

    _, eng = px.parse_po_bytes(data)
    ok(eng == "text", f"sin plantillas el comportamiento debe ser el de siempre (dio {eng!r})")

    _, eng = px.parse_po_bytes(data, [{**activa, "activa": False}])
    ok(eng == "text", "una plantilla apagada no debe participar")

    rota = {"id": "rota", "activa": True, "huella": {},
            "campos": {"x": {"tipo": "patron", "patron": "(("}}, "tallas": {}}
    _, eng = px.parse_po_bytes(data, [rota, activa])
    ok(eng == "text", "una plantilla rota no debe tumbar la lectura")

    # Caso positivo: se simula un cliente que los lectores a mano NO conocen.
    orig = px.parse_pdf
    px.parse_pdf = lambda d: []
    try:
        recs, eng = px.parse_po_bytes(data, [activa])
    finally:
        px.parse_pdf = orig
    ok(eng == "plantilla:banco_pruebas_mct", f"la plantilla debia atraparlo (dio {eng!r})")
    ok(len(recs) == 5, f"debia sacar 5 estilos, saco {len(recs)}")
    if recs:
        from printavo_export import build_quote_input
        try:
            q = build_quote_input(recs[0], "contacto-smoke")
            ok(bool(q.get("nickname")), "la quote salio sin nickname")
            ok(bool(q.get("lineItemGroups")), "la quote salio sin grupos")
        except Exception as e:                        # noqa: BLE001
            malas.append(f"ruteo: el registro de plantilla no arma quote: {str(e)[:90]}")
    return malas


def main():
    if not os.path.isdir(CORPUS) or not os.path.exists(GOLDEN):
        print("=" * 60)
        print("   SALTADO: falta el corpus o la foto")
        print("   Bajalos con: backend/tests/fetch_po_corpus.py")
        print("=" * 60)
        return 0

    with open(GOLDEN, encoding="utf-8") as fh:
        golden = json.load(fh)

    ok, difs = 0, []
    for f in CASOS:
        ruta = os.path.join(CORPUS, f)
        if not os.path.exists(ruta) or f not in golden:
            difs.append(f"{f}: no esta en el corpus o en la foto")
            continue
        with pdfplumber.open(ruta) as pdf:
            recs = leer_pdf(pdf, PLANTILLA, SIZES_MAP)
        esperado = golden[f]["records"]
        if len(recs) != len(esperado):
            difs.append(f"{f}: la plantilla saco {len(recs)} estilo(s), a mano son {len(esperado)}")
            continue
        for a, b in zip(esperado, recs):
            malos = [k for k in CAMPOS if a.get(k) != b.get(k)]
            if malos:
                for k in malos:
                    difs.append(f"{f} :: {a.get('design_num')} :: {k}: "
                                f"a_mano={a.get(k)!r} plantilla={b.get(k)!r}")
            else:
                ok += 1

    difs += _ruteo()

    print("=" * 60)
    if difs:
        for d in difs[:30]:
            print("   ", d)
        print(f"   {ok} OK / {len(difs)} DIFERENCIA(S)")
        print("=" * 60)
        return 1
    print(f"   {ok} ESTILOS — LA PLANTILLA (PURO DATO) LEE IGUAL QUE EL CODIGO")
    print("=" * 60)
    return 0


if __name__ == "__main__":
    sys.exit(main())
