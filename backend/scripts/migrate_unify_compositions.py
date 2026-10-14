"""UNA SOLA FUENTE DE LA VERDAD para la composición (Contenido/Fabric).

Hasta ahora había DOS catálogos de composición:
  · Recepción  → wms_catalog_options type=fabrics (Contenido/Fabric, inglés)
  · ASN        → wms_part_number_config.compositions (Número de parte, español)
El de número de parte tenía 19 códigos que Contenido/Fabric no tenía (nylon,
modal, rayón, 65/35…). Esta migración FUSIONA todo en Contenido/Fabric:

  1. Traduce al inglés canónico las composiciones que solo estaban en la lista
     vieja y las AGREGA a Contenido/Fabric (así no se pierde ninguna).
  2. VACÍA wms_part_number_config.compositions: desde el deploy, _pn_config()
     deriva las composiciones de Contenido/Fabric (ver routers/wms.py).
  3. NORMALIZA los ASN viejos: cada item.fabric/fabric_content se reescribe a su
     forma canónica del catálogo único (routers.wms._canonical_fabric).

Dry-run por defecto (NO escribe). Para aplicar:  --apply

USO
    backend/venv/Scripts/python.exe backend/scripts/migrate_unify_compositions.py [--apply]
"""
import asyncio
import os
import sys

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

import services.part_number as pn  # noqa: E402

# Etiqueta en inglés por código de fibra, para traducir las composiciones que
# solo estaban en español. El código (C/P/S/R/M/N) es language-agnostic.
_EN = {"C": "COTTON", "P": "POLYESTER", "S": "SPANDEX", "R": "RAYON", "M": "MODAL", "N": "NYLON"}


def _english(pairs) -> str:
    return " ".join(f"{p}% {_EN.get(c, c)}" for p, c in pairs)


async def main():
    from deps import db
    from routers.wms import _canonical_fabric, _pn_config, now_iso, gen_id
    cfg = await _pn_config()

    print(f"=== {'APLICANDO' if APPLY else 'DRY-RUN (no escribe)'} ===\n")

    # 1. Asegurar en Contenido/Fabric la forma DELETREADA en inglés de CADA
    # código (nylon, modal, rayón que solo estaban en español + los que solo
    # existían como abreviatura, p. ej. '50%C 50%P' → agrega '50% COTTON 50%
    # POLYESTER'). Así la única fuente queda pareja y legible.
    fabrics = [(c.get("value") or "").strip() for c in await db.wms_catalog_options.find(
        {"type": "fabrics"}, {"_id": 0, "value": 1}).to_list(5000) if (c.get("value") or "").strip()]
    have = {f.upper() for f in fabrics}
    ensure, seen = [], set()
    for s in cfg.get("compositions") or []:
        r = pn.normalize_composition(s, cfg)
        if r.get("ok") and r["code"] not in seen:
            seen.add(r["code"])
            ensure.append(_english(pn.parse_fibers(s, cfg)[0]))
    add = sorted({v for v in ensure if v.upper() not in have})
    print(f"1. Agregar a Contenido/Fabric: {len(add)} composiciones (forma deletreada inglesa)")
    for v in add:
        print(f"     + {v}")
    if APPLY and add:
        await db.wms_catalog_options.insert_many([
            {"catalog_id": gen_id("cat"), "type": "fabrics", "value": v, "customer": None,
             "created_at": now_iso(), "created_by": "migration:unify_compositions"} for v in add])

    # Respaldo de wms_asn antes de tocarlo (server-side, sin traer todo al cliente).
    if APPLY:
        bak = "wms_asn_bak_compunify"
        await db.wms_asn.aggregate([{"$out": bak}]).to_list(1)
        print(f"\n   (respaldo de wms_asn en {bak})")

    # 2. Normalizar ASN viejos. Recalcular cfg (ya con las 19 en el catálogo).
    cfg = await _pn_config()
    cambios, muestras = 0, []
    memo = {}  # (customer, value) -> canónico, calculado una sola vez

    async def canon_of(cust, v):
        k = (cust, v)
        if k not in memo:
            memo[k] = await _canonical_fabric(cust, v)
        return memo[k]

    cursor = db.wms_asn.find({}, {"asn_id": 1, "customer": 1, "items": 1})
    async for a in cursor:
        cust = a.get("customer", "")
        items = a.get("items") or []
        new_items, touched = [], False
        for it in items:
            it = dict(it)
            for fld in ("fabric", "fabric_content"):
                v = (it.get(fld) or "").strip()
                if not v:
                    continue
                canon = await canon_of(cust, v)
                if canon != v:
                    if len(muestras) < 25:
                        muestras.append(f"ASN {a.get('asn_id')}: {v!r} → {canon!r}")
                    it[fld] = canon
                    touched = True
            new_items.append(it)
        if touched:
            cambios += 1
            if APPLY:
                await db.wms_asn.update_one({"_id": a["_id"]}, {"$set": {"items": new_items}})
    print(f"\n3. ASN con composición normalizada: {cambios}")
    for m in muestras:
        print(f"     {m}")
    if cambios > len(muestras):
        print(f"     … y {cambios - len(muestras)} ASN más")

    print(f"\n=== {'APLICADO' if APPLY else 'DRY-RUN: nada se escribió. Corre con --apply para aplicar.'} ===")


if __name__ == "__main__":
    asyncio.run(main())
