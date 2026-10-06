"""Smoke de REGRESION del lector de POs: el corpus real contra su foto congelada.

POR QUE EXISTE
──────────────
Los otros smokes de Printavo cubren `build_quote_input` y el lector de Culture
Kings, pero el lector de Goodie (`_parse_goodie_page`, el que corre en el 95% de
los POs que entran por correo) practicamente no tenia red: una sola llamada a
`parse_pdf`. El bug del PO 23258 (203 piezas en S donde el PDF dice 201) paso por
ahi sin que ningun smoke se pusiera rojo.

Este smoke corre el parser sobre TODOS los PDFs reales del corpus y compara campo
por campo contra `fixtures/po_golden.json`. Cualquier diferencia sale listada con
el archivo, el estilo y el campo. Es el contrato que cualquier refactorizacion del
motor tiene que respetar.

EL CORPUS NO VIVE EN EL REPO
────────────────────────────
Son ~31 MB de work orders de un cliente. Se bajan de los mismos correos que ya
proceso el intake:

    backend/venv/Scripts/python.exe backend/tests/fetch_po_corpus.py

Sin el corpus el smoke no falla: avisa y se salta (exit 0), para que no truene en
una maquina que no lo tiene.

CUANDO EL CAMBIO ES INTENCIONAL
───────────────────────────────
Si una diferencia es una CORRECCION (el parser ahora lee mejor), se re-congela la
foto a proposito y se dice en el commit que se hizo:

    backend/venv/Scripts/python.exe backend/tests/smoke_po_golden.py --recongelar

USO
───
    backend/venv/Scripts/python.exe backend/tests/smoke_po_golden.py
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

from routers.printavo_export import parse_po_bytes  # noqa: E402

CORPUS = os.path.join(os.path.dirname(__file__), "fixtures", "po")
GOLDEN = os.path.join(os.path.dirname(__file__), "fixtures", "po_golden.json")

# Campos que NO se comparan: ninguno por ahora. Si algun dia hay uno volatil
# (una fecha calculada al vuelo, por ejemplo), se anota aqui CON su razon.
IGNORAR = set()


def _parse_corpus():
    """Corre el parser sobre cada PDF del corpus. Devuelve (resultado, crashes)."""
    out, crashes = {}, []
    for f in sorted(os.listdir(CORPUS)):
        if not f.lower().endswith(".pdf"):
            continue
        try:
            with open(os.path.join(CORPUS, f), "rb") as fh:
                recs, eng = parse_po_bytes(fh.read())
        except Exception as e:                       # noqa: BLE001
            crashes.append((f, str(e)[:120]))
            continue
        out[f] = {"engine": eng, "records": recs}
    return out, crashes


def _normalizar(x):
    """Pasa por json para que la comparacion sea contra lo MISMO que se congelo
    (tuplas -> listas, claves ordenadas, Decimal/None serializados igual)."""
    return json.loads(json.dumps(x, ensure_ascii=False, sort_keys=True, default=str))


def _diferencias(viejo, nuevo):
    """Lista legible de diferencias entre la foto y lo que da el parser hoy."""
    difs = []
    for f in sorted(set(viejo) | set(nuevo)):
        if f not in nuevo:
            difs.append(f"{f}: ya no produce estilos (antes {len(viejo[f]['records'])})")
            continue
        if f not in viejo:
            difs.append(f"{f}: archivo nuevo en el corpus, no esta en la foto")
            continue
        v, n = viejo[f], nuevo[f]
        if v.get("engine") != n.get("engine"):
            difs.append(f"{f}: engine {v.get('engine')!r} -> {n.get('engine')!r}")
        rv, rn = v["records"], n["records"]
        if len(rv) != len(rn):
            difs.append(f"{f}: {len(rv)} estilo(s) -> {len(rn)}")
            continue
        for i, (a, b) in enumerate(zip(rv, rn)):
            quien = a.get("design_num") or f"estilo {i + 1}"
            for k in sorted(set(a) | set(b)):
                if k in IGNORAR:
                    continue
                if a.get(k) != b.get(k):
                    difs.append(f"{f} :: {quien} :: {k}: {a.get(k)!r} -> {b.get(k)!r}")
    return difs


def main():
    recongelar = "--recongelar" in sys.argv

    if not os.path.isdir(CORPUS) or not any(x.lower().endswith(".pdf") for x in os.listdir(CORPUS)):
        print("=" * 60)
        print("   SALTADO: no hay corpus en tests/fixtures/po")
        print("   Bajalo con: backend/tests/fetch_po_corpus.py")
        print("=" * 60)
        return 0

    nuevo, crashes = _parse_corpus()
    estilos = sum(len(v["records"]) for v in nuevo.values())
    print(f"corpus: {len(nuevo)} pdf(s), {estilos} estilo(s)")

    for f, e in crashes:
        print(f"   CRASH  {f}: {e}")
    sin = [f for f, v in nuevo.items() if not v["records"]]
    for f in sin:
        print(f"   SIN ESTILOS  {f}")

    if recongelar:
        with open(GOLDEN, "w", encoding="utf-8") as fh:
            json.dump(_normalizar(nuevo), fh, ensure_ascii=False, indent=1, sort_keys=True)
        print(f"\nfoto re-congelada: {len(nuevo)} pdf(s), {estilos} estilo(s)")
        return 0

    if not os.path.exists(GOLDEN):
        print("\nNO HAY FOTO. Creala con --recongelar")
        return 1

    with open(GOLDEN, encoding="utf-8") as fh:
        viejo = json.load(fh)

    difs = _diferencias(viejo, _normalizar(nuevo))
    print("\n" + "=" * 60)
    if crashes or sin or difs:
        for d in difs[:40]:
            print("   ", d)
        if len(difs) > 40:
            print(f"    ... y {len(difs) - 40} diferencia(s) mas")
        print(f"   {len(difs)} DIFERENCIA(S) / {len(crashes)} CRASH(ES) / {len(sin)} SIN ESTILOS")
        print("=" * 60)
        return 1
    print(f"   {len(nuevo)} PDF / {estilos} ESTILOS — IDENTICO A LA FOTO")
    print("=" * 60)
    return 0


if __name__ == "__main__":
    sys.exit(main())
