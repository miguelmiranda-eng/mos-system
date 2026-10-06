"""Smoke de punta a punta del intake con PDFs REALES de Spektrum.

Recorre el mismo `_process_message` que corre en produccion: correo -> PDF ->
lector -> candados -> auto-crear -> etiquetas. Lo unico simulado es lo de
afuera: Gmail (un mensaje en memoria), la base (colecciones en memoria) y
Printavo (anota lo que se habria creado, no crea nada).

Los PDFs son de un cliente y NO van al repo: viven en tests/fixtures/po_spk/
(en .gitignore). Sin ellos el smoke se salta con exit 0.

Que se comprueba:
  1. hoja de 27 POs en un PDF: 27 estilos, un item, `po_numbers` con los 27
  2. limpio + auto-crear: crea una quote por PO y cierra el item
  3. algunos POs ya en MOS: SOLO esos se saltan, el resto se crea
  4. todos los POs ya en MOS: "ya_existe", nada que hacer
  5. una quote truena a la mitad: las que si salieron quedan marcadas
  6. PDF nuevo que NO cubre al pendiente: no lo tira de la bandeja
  7. PDF nuevo que SI lo cubre: lo reemplaza
  8. formato tabla (NITEHARTS): se lee; la pagina con totales malos espera,
     la otra se crea
  9. reenviado desde @prosper-mfg.com con lista estricta: se ignora
 10. la Priority List (no es orden): se ignora
 11. formato 2025 (WK11, 9 POs, 'XS:3 ,'): 7 se crean y los 2 que no cuadran
     en el propio PDF (250 vs 251) esperan en la bandeja
"""
import asyncio
import copy
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
os.environ.setdefault("MONGODB_URL", "mongodb://localhost:27017")
os.environ.setdefault("DB_NAME", "mos-offline-test")
os.environ.setdefault("JWT_SECRET", "offline_secret")
os.environ.setdefault("MASTER_API_KEY", "smoke_master_key")
os.environ.setdefault("INTERNAL_SYNC_TOKEN", "smoke_sync_token")

import routers.gmail_intake as g  # noqa: E402
from routers.printavo_export import parse_po_bytes as parse_real  # noqa: E402

DIR = os.path.join(os.path.dirname(__file__), "fixtures", "po_spk")
SHEETS = os.path.join(DIR, "po_sheets_09_24_26.pdf")
NITE = os.path.join(DIR, "ck_niteharts_pos.pdf")
PRIORITY = os.path.join(DIR, "priority_list_09_24_26.pdf")
WK11 = os.path.join(DIR, "wk11_y25_po_sheets.pdf")
DESCUADRADO = "2174838"     # en la hoja real trae 1,200 contra 1,201 tallas

ok = fail = 0


def check(nombre, cond, detalle=""):
    global ok, fail
    if cond:
        ok += 1
        print(f"   PASS  {nombre}")
    else:
        fail += 1
        print(f"   FAIL  {nombre}  {detalle}")


# ── Base en memoria (lo que usa el intake de Mongo, nada mas) ────────────────
def _vale(doc, k, cond):
    v = doc.get(k)
    if isinstance(cond, dict):
        for op, x in cond.items():
            if op == "$in":
                vs = v if isinstance(v, list) else [v]
                if not any(e in x for e in vs):
                    return False
            elif op == "$ne":
                if v == x:
                    return False
            else:
                raise NotImplementedError(op)
        return True
    return (cond in v) if isinstance(v, list) else v == cond


def _casa(doc, q):
    for k, cond in q.items():
        if k == "$or":
            if not any(_casa(doc, sub) for sub in cond):
                return False
        elif not _vale(doc, k, cond):
            return False
    return True


class Cursor:
    def __init__(self, docs):
        self.docs = docs

    def __aiter__(self):
        self._it = iter(self.docs)
        return self

    async def __anext__(self):
        try:
            return copy.deepcopy(next(self._it))
        except StopIteration:
            raise StopAsyncIteration


class Col:
    def __init__(self):
        self.docs = []

    async def find_one(self, q, proj=None):
        return next((copy.deepcopy(d) for d in self.docs if _casa(d, q)), None)

    def find(self, q, proj=None):
        return Cursor([d for d in self.docs if _casa(d, q)])

    async def insert_one(self, doc):
        self.docs.append(copy.deepcopy(doc))

    async def update_one(self, q, upd, upsert=False):
        for d in self.docs:
            if _casa(d, q):
                d.update(copy.deepcopy(upd.get("$set", {})))
                return
        if upsert:
            self.docs.append({**q, **copy.deepcopy(upd.get("$set", {}))})


class DB:
    def __init__(self, ordenes=()):
        self.printavo_intake = Col()
        self.gmail_intake_messages = Col()
        self.gmail_intake_buzones = Col()
        self.gmail_intake = Col()            # config: contadores y ultimo error
        self.orders = Col()
        self.orders.docs = [{"customer_po": p, "order_number": f"#{p[-3:]}"} for p in ordenes]


# ── Gmail y Printavo simulados ────────────────────────────────────────────────
CORREOS = {}
ETIQUETADO = {}
CREADAS = []


def correo(mid, remitente, pdf_path, asunto="CK PO SHEETS", etiquetas=("SPK",)):
    """`etiquetas` = las que trae ESE mensaje en Gmail. Una respuesta que llega
    despues de etiquetar el hilo no trae ninguna. `pdf_path=None` = sin PDF."""
    CORREOS[mid] = {"remitente": remitente, "asunto": asunto, "etiquetas": list(etiquetas),
                    "pdf": open(pdf_path, "rb").read() if pdf_path else None,
                    "fn": os.path.basename(pdf_path) if pdf_path else None}


def preparar(ordenes=(), falla_en=None, solo=None):
    """`solo` filtra los records del lector REAL (p.ej. una hoja sin el PO que
    no cuadra): sin pypdf no se pueden recortar paginas, se recortan estilos."""
    g.db = DB(ordenes)
    CORREOS.clear()
    ETIQUETADO.clear()
    CREADAS.clear()
    g._get_message = lambda svc, mid: {"id": mid, "threadId": f"t-{mid}", "internalDate": "1791300000000",
                                       "labelIds": CORREOS[mid]["etiquetas"],
                                       "payload": {"headers": [
                                           {"name": "From", "value": CORREOS[mid]["remitente"]},
                                           {"name": "Subject", "value": CORREOS[mid]["asunto"]},
                                           {"name": "Date", "value": "Tue, 6 Oct 2026 19:00:00 +0000"}]}}
    g._pdf_parts = lambda msg: ([(CORREOS[msg["id"]]["fn"], "att", len(CORREOS[msg["id"]]["pdf"]))]
                                if CORREOS[msg["id"]]["pdf"] else [])
    g._get_attachment = lambda svc, mid, att: CORREOS[mid]["pdf"]
    g._body_text = lambda msg, limit=4000: ""
    g._modify_labels = lambda svc, mid, add, remove: ETIQUETADO.__setitem__(mid, list(add))

    def parse(data, plantillas):
        recs, eng = parse_real(data, plantillas)
        return ([r for r in recs if solo(r)] if solo else recs), eng
    g.parse_po_bytes = parse

    async def crear(user, contact_id, styles):
        res = []
        for i, r in enumerate(styles):
            if falla_en is not None and i >= falla_en:
                res.append({"design_num": r.get("design_num"), "ok": False, "error": "429 Too Many Requests"})
            else:
                CREADAS.append(r.get("po_number"))
                res.append({"design_num": r.get("design_num"), "ok": True,
                            "quote_id": f"q{len(CREADAS)}", "visual_id": str(9000 + len(CREADAS))})
        return {"results": res, "created": sum(x["ok"] for x in res),
                "failed": sum(not x["ok"] for x in res)}
    g.create_quotes_for = crear
    g.printavo_client.is_configured = lambda: True


async def _bound_user(cfg):
    return {"user_id": "u", "email": "intake@prosper-mfg.com", "name": "intake"}
g._bound_user = _bound_user

LABELS = {**{n: n for n in g.MOS_LABELS}, "SPK": "SPK"}
CFG = {"user_id": "u", "auto_created_count": 0}


def fuente(auto=True, dominios=("spektrumca.com",)):
    return {"id": "spk", "nombre": "SPEKTRUM", "label_name": "SPK", "allowed_domains": list(dominios),
            "auto_create": auto, "auto_contact_id": "10639685", "activa": True}


def items():
    return g.db.printavo_intake.docs


async def procesar(mid, f=None):
    return await g._process_message("SVC", dict(CFG), f or fuente(), LABELS, mid, forced=False)


async def main():
    if not all(os.path.exists(p) for p in (SHEETS, NITE, PRIORITY)):
        print("=" * 60)
        print("   SALTADO: faltan los PDFs reales en tests/fixtures/po_spk/")
        print("=" * 60)
        return 0
    JOSE = "Joseline Alfaro <joseline@spektrumca.com>"
    HOJA = open(SHEETS, "rb").read()
    todos = [r["po_number"] for r in parse_real(HOJA, [])[0]]

    print("\n1) hoja de 27 POs, auto-crear APAGADO")
    preparar()
    correo("m1", JOSE, SHEETS)
    await procesar("m1", fuente(auto=False))
    it = items()[0] if items() else {}
    check("un solo item", len(items()) == 1, f"{len(items())}")
    check("27 estilos", it.get("style_count") == 27, f"{it.get('style_count')}")
    check("po_numbers trae los 27", len(it.get("po_numbers") or []) == 27, f"{it.get('po_numbers')}")
    check("queda pendiente para una persona", it.get("status") == "pendiente", it.get("status"))
    check("bloqueo por tallas (el 2174838 trae 1,200 vs 1,201)",
          g._auto_block_reason(it) == "tallas ≠ cantidad", g._auto_block_reason(it))
    check("etiqueta MOS/Orden", "MOS/Orden" in ETIQUETADO.get("m1", []), f"{ETIQUETADO}")

    print("\n2) hoja limpia + auto-crear: una quote por PO")
    preparar(solo=lambda r: r["po_number"] != DESCUADRADO)
    correo("m2", JOSE, SHEETS)
    await procesar("m2")
    it = items()[0]
    check("26 quotes creadas, una por PO", sorted(CREADAS) == sorted(p for p in todos if p != DESCUADRADO),
          f"{len(CREADAS)}")
    check("item cerrado como creado", it.get("status") == "creado", it.get("status"))
    check("todos los estilos marcados ya_creado", all(r.get("ya_creado") for r in it["styles"]))
    check("etiqueta MOS/Quote creada", "MOS/Quote creada" in ETIQUETADO.get("m2", []), f"{ETIQUETADO}")

    print("\n3) 3 de los 27 ya estan en MOS")
    ya = todos[5:8]
    preparar(ordenes=ya, solo=lambda r: r["po_number"] != DESCUADRADO)
    correo("m3", JOSE, SHEETS)
    await procesar("m3")
    it = items()[0]
    marcados = sorted(r["po_number"] for r in it["styles"] if r.get("ya_en_mos"))
    check("SOLO esos 3 estilos marcados", marcados == sorted(ya), f"{marcados}")
    check("se crean los 23 nuevos y NINGUNO de los 3 existentes (antes duplicaba)",
          len(CREADAS) == 23 and not set(CREADAS) & set(ya), f"{len(CREADAS)} {set(CREADAS) & set(ya)}")
    check("item cerrado: todo quedo creado o ya existia", it.get("status") == "creado", it.get("status"))

    print("\n4) los 27 ya estan en MOS")
    preparar(ordenes=todos)
    correo("m4", JOSE, SHEETS)
    await procesar("m4")
    check("ya_existe, nada que hacer", items()[0].get("status") == "ya_existe", items()[0].get("status"))
    check("no se creo nada", CREADAS == [])

    print("\n5) Printavo truena en la quote 16")
    preparar(falla_en=15, solo=lambda r: r["po_number"] != DESCUADRADO)
    correo("m5", JOSE, SHEETS)
    await procesar("m5")
    it = items()[0]
    hechos = [r for r in it["styles"] if r.get("ya_creado")]
    check("15 quotes salieron", len(CREADAS) == 15, f"{len(CREADAS)}")
    check("el item queda pendiente con el error", it.get("status") == "pendiente" and it.get("auto_error"),
          f"{it.get('status')} {it.get('auto_error')}")
    check("esas 15 quedan marcadas (al terminarlo a mano no se duplican)",
          len(hechos) == 15 and all(r.get("quote_visual_id") for r in hechos), f"{len(hechos)}")
    check("las 11 restantes sin marcar", sum(1 for r in it["styles"] if not r.get("ya_creado")) == 11)

    print("\n6) llega un PDF con SOLO 2 de los POs del pendiente")
    preparar()
    correo("a", JOSE, SHEETS)
    await procesar("a", fuente(auto=False))
    g.parse_po_bytes = lambda data, pl: ([r for r in parse_real(HOJA, pl)[0] if r["po_number"] in todos[:2]], "text-ck")
    correo("b", JOSE, NITE)          # otros bytes = otro sha; el lector devuelve 2 POs de la hoja
    await procesar("b", fuente(auto=False))
    a = next(i for i in items() if i["gmail_message_id"] == "a")
    check("el de 27 NO se tira de la bandeja (perderia 25 POs)", a.get("status") == "pendiente", a.get("status"))
    check("los dos quedan pendientes", sum(1 for i in items() if i["status"] == "pendiente") == 2)

    print("\n7) llega un PDF que SI cubre al pendiente")
    preparar()
    g.parse_po_bytes = lambda data, pl: ([r for r in parse_real(HOJA, pl)[0] if r["po_number"] in todos[:2]], "text-ck")
    correo("c", JOSE, NITE)
    await procesar("c", fuente(auto=False))
    g.parse_po_bytes = lambda data, pl: parse_real(HOJA, pl)
    correo("d", JOSE, PRIORITY)       # otro sha; el lector devuelve la hoja completa
    await procesar("d", fuente(auto=False))
    c = next(i for i in items() if i["gmail_message_id"] == "c")
    check("el de 2 queda reemplazado por el de 27", c.get("status") == "reemplazado", c.get("status"))

    print("\n8) formato tabla (NITEHARTS)")
    preparar()
    correo("n", JOSE, NITE)
    await procesar("n")
    it = items()[0] if items() else {}
    check("4 POs leidos", sorted(it.get("po_numbers") or []) == ["4005620", "4005621", "4005622", "4005623"],
          f"{it.get('po_numbers')}")
    check("marca de totales en el item", "totales_no_cuadran" in (it.get("flags") or []), f"{it.get('flags')}")
    check("se crean SOLO los 2 de la pagina que cuadra", sorted(CREADAS) == ["4005622", "4005623"], f"{CREADAS}")
    check("el item espera por los otros 2", it.get("status") == "pendiente", it.get("status"))
    check("el aviso dice cuales esperan y por que",
          all(f"PO {p}" in (it.get("auto_skipped") or "") for p in ("4005620", "4005621"))
          and "totales" in (it.get("auto_skipped") or ""), it.get("auto_skipped"))

    print("\n9) reenviado desde @prosper-mfg.com con lista estricta")
    preparar()
    correo("f", "Elvia Tejeda <elvia@prosper-mfg.com>", SHEETS, "Fwd: CK PRODUCTION")
    await procesar("f")
    vistos = g.db.gmail_intake_messages.docs
    check("se ignora por remitente", items() == [] and vistos and vistos[0]["reason"] == g.REASON_DOMAIN,
          f"{vistos}")

    print("\n10) la Priority List no es orden")
    preparar()
    correo("p", JOSE, PRIORITY)
    await procesar("p")
    check("no crea item", items() == [])
    check("etiqueta MOS/Ignorado", "MOS/Ignorado" in ETIQUETADO.get("p", []), f"{ETIQUETADO}")

    print("\n11) formato 2025 (WK11): 9 POs, 2 descuadrados en el propio PDF")
    if os.path.exists(WK11):
        preparar()
        correo("w", JOSE, WK11)
        await procesar("w")
        it = items()[0] if items() else {}
        check("9 POs leidos con sus tallas", it.get("style_count") == 9
              and all(r.get("qty_from_sizes") for r in it.get("styles", [])), f"{it.get('style_count')}")
        check("7 se crean", len(CREADAS) == 7 and not {"2151359", "2151360"} & set(CREADAS), f"{CREADAS}")
        check("los 2 descuadrados esperan, con el motivo",
              "PO 2151359: tallas" in (it.get("auto_skipped") or "")
              and "PO 2151360: tallas" in (it.get("auto_skipped") or ""), it.get("auto_skipped"))
        check("pendiente con 7 marcados ya_creado (al revisarlo solo quedan los 2)",
              it.get("status") == "pendiente" and sum(bool(r.get("ya_creado")) for r in it["styles"]) == 7)
        check("fecha de entrega leida (3/17/2025)", it["styles"][0].get("cancel_date") == "2025-03-17",
              it["styles"][0].get("cancel_date"))
    else:
        print("   (sin wk11_y25_po_sheets.pdf: caso saltado)")

    print("\n12) respuestas del hilo que NO traen la etiqueta (Gmail etiqueta por mensaje)")
    preparar()
    correo("r_pdf", "Ana Flores <ana@spektrumca.com>", WK11 if os.path.exists(WK11) else SHEETS,
           "Re: Test order", etiquetas=())
    correo("r_chat", "Lily Acosta <lily.acosta@prosper-mfg.com>", None, "Re: Test order", etiquetas=())
    await procesar("r_pdf")
    await procesar("r_chat")
    check("la respuesta con el PO se procesa aunque no traiga la etiqueta",
          any(i["gmail_message_id"] == "r_pdf" for i in items()) and CREADAS, f"{CREADAS}")
    check("y queda etiquetada en Gmail (MOS/Orden)", "MOS/Orden" in ETIQUETADO.get("r_pdf", []), f"{ETIQUETADO}")
    check("la platica sin PDF NO recibe etiquetas MOS", "r_chat" not in ETIQUETADO, f"{ETIQUETADO}")
    check("pero queda vista (no se vuelve a pedir cada pasada)",
          any(m["message_id"] == "r_chat" for m in g.db.gmail_intake_messages.docs))

    print(f"\n{'=' * 60}\n   {ok} PASS / {fail} FAIL\n{'=' * 60}")
    return 1 if fail else 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
