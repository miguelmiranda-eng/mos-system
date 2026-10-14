"""Agrega el PO de TIENDA al nombre de quotes de Spektrum ya creadas en Printavo.

Caso: las 17 quotes de THREADBEAST del PO 5448 (#3791-#3807, creadas el
2026-10-14) salieron como "THREADBEAST - PO#5448 - PROPER GOODS LABEL TEE", antes
de que printavo_export pusiera el PO de tienda. El formato correcto (y el que
printavo_sync lee de vuelta para el store_po de la orden) es:
    THREADBEAST - PO#5448 - SPTB092926-L4 - PROPER GOODS LABEL TEE

Corre EN EL SERVIDOR (ahí está el token de Printavo), p.ej. desde la consola del
servicio backend en Easypanel:

    python agregar_po_tienda_quotes.py --po 5448 --po-tienda SPTB092926-L4            # solo muestra
    python agregar_po_tienda_quotes.py --po 5448 --po-tienda SPTB092926-L4 --aplicar  # cambia

Seguro:
- Las quotes salen de la bitácora de MOS (printavo_export_create con ese PO), no
  de una búsqueda abierta en Printavo.
- Antes de tocar una, la lee de Printavo y exige que su nombre empiece con
  "<TIENDA> - PO#<po> - " y que NO traiga ya el PO de tienda; si no, la salta.
- Solo cambia `nickname` (quoteUpdate con nada más). Una ya convertida en
  invoice no es quote: Printavo no la encuentra y se reporta, no se toca.
- Pausa entre llamadas (WAF de Printavo: el token es el del sync de producción).
"""
import argparse
import asyncio
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

QUOTE_QUERY = """
query Quote($id: ID!) { quote(id: $id) { id visualId nickname } }
"""
QUOTE_UPDATE = """
mutation Renombrar($id: ID!, $input: QuoteInput!) {
  quoteUpdate(id: $id, input: $input) { id visualId nickname }
}
"""
PAUSA = 1.5   # segundos entre llamadas a Printavo


def nuevo_nombre(nombre: str, po: str, po_tienda: str):
    """El nombre con el PO de tienda insertado, o (None, motivo) si no aplica."""
    marca = f" - PO#{po} - "
    if marca not in nombre:
        return None, f"el nombre no trae '{marca.strip()}'"
    if po_tienda in nombre:
        return None, "ya trae el PO de tienda"
    return nombre.replace(marca, f"{marca}{po_tienda} - ", 1), None


async def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--po", required=True)
    ap.add_argument("--po-tienda", required=True)
    ap.add_argument("--aplicar", action="store_true")
    a = ap.parse_args()

    from deps import db
    import printavo_client as pc

    ids = []
    async for log in db.activity_logs.find({"action": "printavo_export_create",
                                            "details.created.design_num": a.po},
                                           {"_id": 0, "details": 1, "timestamp": 1}):
        for q in (log.get("details") or {}).get("created") or []:
            if str(q.get("design_num")) == a.po and q.get("ok") and q.get("quote_id"):
                ids.append((str(q["quote_id"]), q.get("visual_id")))
    ids = list(dict.fromkeys(ids))
    print(f"{len(ids)} quote(s) creadas desde MOS con PO {a.po}: {[v for _, v in ids]}")
    if not ids:
        return 1

    cambiadas = saltadas = 0
    for qid, visual in ids:
        try:
            q = (await pc._graphql(QUOTE_QUERY, {"id": qid})).get("quote")
        except Exception as e:                       # noqa: BLE001
            print(f"  #{visual}: no se pudo leer ({str(e)[:120]}) -> SALTADA")
            saltadas += 1
            await asyncio.sleep(PAUSA)
            continue
        if not q:
            print(f"  #{visual}: Printavo no la encuentra como quote (¿ya es invoice?) -> SALTADA")
            saltadas += 1
            await asyncio.sleep(PAUSA)
            continue
        actual = q.get("nickname") or ""
        nuevo, motivo = nuevo_nombre(actual, a.po, a.po_tienda)
        if not nuevo:
            print(f"  #{visual}: {motivo} -> SALTADA  ({actual!r})")
            saltadas += 1
            await asyncio.sleep(PAUSA)
            continue
        print(f"  #{visual}: {actual!r}\n        -> {nuevo!r}")
        if a.aplicar:
            await asyncio.sleep(PAUSA)
            try:
                r = (await pc._graphql(QUOTE_UPDATE, {"id": qid, "input": {"nickname": nuevo}})).get("quoteUpdate") or {}
                ok = r.get("nickname") == nuevo
                print(f"        {'OK' if ok else 'RESPUESTA INESPERADA: ' + repr(r)}")
                cambiadas += 1 if ok else 0
            except Exception as e:                   # noqa: BLE001
                print(f"        ERROR: {str(e)[:200]}")
        await asyncio.sleep(PAUSA)

    print(f"\n{'CAMBIADAS' if a.aplicar else 'Se cambiarían'}: "
          f"{cambiadas if a.aplicar else len(ids) - saltadas} · saltadas: {saltadas}")
    if not a.aplicar:
        print("Nada se cambió. Para aplicar: agrega --aplicar")
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
