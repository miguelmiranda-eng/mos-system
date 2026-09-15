"""Smoke — fase 3: detalle de la entrada por número de parte y búsqueda inversa.

Contrato:
  · GET /asn/{id} devuelve summary.by_part: por número de parte, lo esperado
    (suma de sus líneas), lo recibido, lo que queda en inventario y el
    desglose de estilo/color/talla + box_ids de las cajas que llegaron.
  · Cajas nuevas (con asn_line_no) se atribuyen EXACTO; cajas viejas sin
    línea siguen con el best-effort por upc/sku/style (part_number == style);
    cajas que no casan con nada van a un grupo `unmatched`.
  · by_line usa la línea exacta cuando la caja la trae; cada caja sale con
    part_number_resolved / asn_line_no_resolved / asn_match.
  · GET /boxes/{id}/history devuelve asn_link (entrada + línea + número de
    parte), también para cajas viejas (best-effort) y con entrada borrada.

Base DESECHABLE.
"""
import asyncio
import os
import sys

BE = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
SMOKE_DB = os.environ.get("SMOKE_DB_NAME", "mos-smoke-test")
PROD_DB = os.environ.get("PROD_DB_NAME", "mos-system")
MONGO = os.environ.get("MONGODB_URL") or os.environ.get("MONGO_URL")
if not MONGO:
    sys.exit("Falta MONGODB_URL")
if SMOKE_DB == PROD_DB:
    sys.exit(f"NEGADO: SMOKE_DB_NAME es la base de producción ('{PROD_DB}').")
os.environ["MONGODB_URL"] = MONGO
os.environ["DB_NAME"] = SMOKE_DB
os.environ.setdefault("JWT_SECRET", "smoke_secret")
os.environ.setdefault("MASTER_API_KEY", "smoke_master_key")
os.environ.setdefault("INTERNAL_SYNC_TOKEN", "smoke_sync_token")
os.environ.setdefault("ENV", "local")
os.environ.setdefault("DISABLE_SCHEDULERS", "1")
sys.path.insert(0, BE)
os.chdir(BE)

import pymongo  # noqa: E402
from passlib.hash import bcrypt  # noqa: E402

raw = pymongo.MongoClient(MONGO)
sdb = raw[SMOKE_DB]
ok = fail = 0


def check(nombre, cond, detalle=""):
    global ok, fail
    if cond:
        ok += 1
        print(f"   PASS  {nombre}")
    else:
        fail += 1
        print(f"   FAIL  {nombre}  {detalle}")


def sembrar():
    raw.drop_database(SMOKE_DB)
    sdb.users.insert_one({"user_id": "u_admin", "email": "u_admin@test.local", "name": "admin",
                          "password_hash": bcrypt.hash("smoke123"), "role": "supersu", "admin_level": 5, "active": True})
    sdb.wms_locations.insert_one({"name": "UBICACION TEMPORAL", "location_id": "loc_tmp", "type": "transit", "active": True})


def recibo(style, color, size, units, country, fabric, asn, line_no=None, boxes=1):
    b = {"customer": "GOODIE TWO SLEEVES", "manufacturer": "GILDAN", "style": style, "color": color, "size": size,
         "description": "MENS SS", "country_of_origin": country, "fabric_content": fabric,
         "items": [{"size": size, "boxes": boxes, "units_per_box": units}], "units": units * boxes, "asn_reference": asn}
    if line_no is not None:
        b["asn_line_no"] = line_no
    return b


def part(summary, pn):
    return next((p for p in summary["by_part"] if p["part_number"] == pn), None)


async def main():
    sembrar()
    from httpx import ASGITransport, AsyncClient
    from server import app
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://smoke") as c:
        r = await c.post("/api/auth/login", json={"email": "u_admin@test.local", "password": "smoke123"})
        check("login", r.status_code == 200)

        ASN = "156053-GOD01-B"
        r = await c.post("/api/wms/asn", json={"asn_id": ASN, "customer": "GOODIE TWO SLEEVES", "po_number": "PO-77", "items": [
            {"description": "CAMISETA HOMBRE MANGA CORTA 100% ALGODON", "garment": "SS", "fabric": "100% ALGODON", "country": "CHN", "qty_expected": 100},
            {"description": "CAMISETA HOMBRE MANGA CORTA 100% ALGODON", "garment": "SS", "fabric": "100% ALGODON", "country": "CHN", "qty_expected": 50},
            {"description": "CAMISETA HOMBRE MANGA CORTA 50% ALGODON 50% POLIESTER", "garment": "SS", "fabric": "50% ALGODON 50% POLIESTER", "country": "CHN", "qty_expected": 40},
            {"description": "CAMISETA HOMBRE MANGA CORTA 100% ALGODON", "garment": "SS", "fabric": "100% ALGODON", "country": "CHN", "qty_expected": 2, "sample": True},
        ]})
        check("entrada creada", r.status_code == 200, r.text[:200])
        pns = [it["part_number"] for it in r.json()["items"]]
        check("números de parte", pns == ["GTS-SS100CCN", "GTS-SS100CCN", "GTS-SS50C50PCN", "GTS-SS100CCNMS"], pns)

        print("\n== 1. Sin cajas: by_part agrupa las líneas ==")
        r = await c.get(f"/api/wms/asn/{ASN}")
        s = r.json()["summary"]
        check("3 números de parte (las dos líneas iguales se suman)", [p["part_number"] for p in s["by_part"]] == ["GTS-SS100CCN", "GTS-SS50C50PCN", "GTS-SS100CCNMS"], [p["part_number"] for p in s["by_part"]])
        p1 = part(s, "GTS-SS100CCN")
        check("GTS-SS100CCN espera 150 en líneas 1 y 2", p1["qty_expected"] == 150 and p1["line_nos"] == [1, 2], (p1["qty_expected"], p1["line_nos"]))
        check("muestra marcada", part(s, "GTS-SS100CCNMS")["sample"] is True)
        check("sin cajas: 0 recibido / 0 en stock / sin skus", p1["qty_received"] == 0 and p1["units_in_stock"] == 0 and p1["skus"] == [])

        print("\n== 2. Cajas nuevas: atribución exacta por línea ==")
        r = await c.post("/api/wms/receiving", json=recibo("M1163", "BRACKEN", "L", 30, "CHINA", "100% ALGODON", ASN, boxes=2))
        check("recibe 2 cajas × 30 (línea 1)", r.status_code == 200, r.text[:150])
        r = await c.post("/api/wms/receiving", json=recibo("M1163", "BRACKEN", "M", 40, "CHINA", "100% ALGODON", ASN))
        check("recibe 40 M (línea 1 → 100/100)", r.status_code == 200, r.text[:150])
        r = await c.post("/api/wms/receiving", json=recibo("M1163", "WHITE", "S", 20, "CHINA", "100% ALGODON", ASN))
        check("recibe 20 WHITE S (cae en línea 2)", r.status_code == 200, r.text[:150])
        r = await c.post("/api/wms/receiving", json=recibo("M1163", "BRACKEN", "L", 10, "CHINA", "50% ALGODON 50% POLIESTER", ASN))
        check("recibe 10 de la otra composición (línea 3)", r.status_code == 200, r.text[:150])

        r = await c.get(f"/api/wms/asn/{ASN}")
        d = r.json()
        s = d["summary"]
        p1 = part(s, "GTS-SS100CCN")
        check("GTS-SS100CCN: recibido 120 (100 + 20), 4 cajas, todas exactas",
              p1["qty_received"] == 120 and p1["boxes"] == 4 and p1["boxes_exact"] == 4 and p1["boxes_best_effort"] == 0,
              {k: p1[k] for k in ("qty_received", "boxes", "boxes_exact", "boxes_best_effort")})
        check("GTS-SS100CCN: llegó 120 en cajas y 120 en stock", p1["units_arrived"] == 120 and p1["units_in_stock"] == 120, (p1["units_arrived"], p1["units_in_stock"]))
        skus = [(x["style"], x["color"], x["size"], x["units_arrived"], x["boxes"]) for x in p1["skus"]]
        check("desglose estilo/color/talla", skus == [("M1163", "BRACKEN", "L", 60, 2), ("M1163", "BRACKEN", "M", 40, 1), ("M1163", "WHITE", "S", 20, 1)], skus)
        check("box_ids = 4 cajas de esa parte", len(p1["box_ids"]) == 4 and all(b in {x["box_id"] for x in d["boxes"]} for b in p1["box_ids"]))
        p3 = part(s, "GTS-SS50C50PCN")
        check("GTS-SS50C50PCN: 10 recibido / 1 caja", p3["qty_received"] == 10 and p3["boxes"] == 1 and p3["units_in_stock"] == 10)
        check("muestra: sin cajas", part(s, "GTS-SS100CCNMS")["boxes"] == 0)
        check("sin grupo unmatched", not any(p.get("unmatched") for p in s["by_part"]))
        bl = {l["line_no"]: l for l in s["by_line"]}
        check("by_line exacto: línea 1 = 100 en stock / 3 cajas; línea 2 = 20 / 1 caja",
              bl[1]["qty_in_stock"] == 100 and bl[1]["boxes"] == 3 and bl[2]["qty_in_stock"] == 20 and bl[2]["boxes"] == 1,
              {k: (v["qty_in_stock"], v["boxes"]) for k, v in bl.items()})
        bx = next(b for b in d["boxes"] if b["color"] == "WHITE")
        check("caja enriquecida: part_number_resolved / línea / exact",
              bx["part_number_resolved"] == "GTS-SS100CCN" and bx["asn_line_no_resolved"] == 2 and bx["asn_match"] == "exact",
              {k: bx.get(k) for k in ("part_number_resolved", "asn_line_no_resolved", "asn_match")})

        print("\n== 3. Lo que sale del inventario deja de contar en stock ==")
        sdb.wms_boxes.update_one({"box_id": bx["box_id"]}, {"$set": {"status": "shipped"}})
        r = await c.get(f"/api/wms/asn/{ASN}")
        p1 = part(r.json()["summary"], "GTS-SS100CCN")
        check("embarcada: llegó 120, en stock 100, cajas 4 / en stock 3",
              p1["units_arrived"] == 120 and p1["units_in_stock"] == 100 and p1["boxes"] == 4 and p1["boxes_in_stock"] == 3,
              {k: p1[k] for k in ("units_arrived", "units_in_stock", "boxes", "boxes_in_stock")})
        w = next(x for x in p1["skus"] if x["color"] == "WHITE")
        check("sku WHITE S: llegó 20 / stock 0", w["units_arrived"] == 20 and w["units_in_stock"] == 0 and w["boxes_in_stock"] == 0)

        print("\n== 4. Búsqueda inversa: caja → entrada + línea + parte ==")
        r = await c.get(f"/api/wms/boxes/{bx['box_id']}/history")
        al = r.json().get("asn_link")
        check("asn_link exacto", al and al["asn_id"] == ASN and al["line_no"] == 2 and al["part_number"] == "GTS-SS100CCN" and al["match"] == "exact" and al["exists"], al)
        check("asn_link trae la línea y la cabecera", al and al["line"]["qty_expected"] == 50 and al["po_number"] == "PO-77" and al["customer"] == "GOODIE TWO SLEEVES", al and (al.get("line"), al.get("po_number")))
        ev = next((m for m in r.json()["box_events"] if m.get("type") == "receiving"), None)
        check("evento de recibo trae línea y número de parte", ev and ev["details"].get("asn_line_no") == 2 and ev["details"].get("part_number") == "GTS-SS100CCN", ev and ev.get("details"))

        print("\n== 5. Cajas viejas (sin asn_line_no): best-effort intacto ==")
        sdb.wms_asn.insert_one({"asn_id": "VIEJA-2", "vendor": "GILDAN", "status": "pending", "po_number": "PO-OLD", "items": [
            {"line_no": 1, "part_number": "5000", "qty_expected": 100, "qty_received": 12, "country": "NIC"},
            {"line_no": 2, "part_number": "64000", "qty_expected": 50, "qty_received": 0, "country": "NIC"}]})
        sdb.wms_boxes.insert_many([
            {"box_id": "OLD-1", "asn_reference": "VIEJA-2", "style": "5000", "sku": "5000", "color": "BLACK", "size": "L", "units": 12, "status": "received", "location": "A-01", "created_at": "2026-01-01T00:00:00Z"},
            {"box_id": "OLD-2", "asn_reference": "VIEJA-2", "style": "2000", "sku": "2000", "color": "RED", "size": "M", "units": 7, "status": "received", "location": "A-02", "created_at": "2026-01-01T00:00:00Z"},
        ])
        r = await c.get("/api/wms/asn/VIEJA-2")
        d = r.json()
        s = d["summary"]
        p = part(s, "5000")
        check("caja vieja casa por style == part_number (best_effort)", p and p["boxes"] == 1 and p["boxes_best_effort"] == 1 and p["units_in_stock"] == 12, p and {k: p[k] for k in ("boxes", "boxes_best_effort", "units_in_stock")})
        un = next((x for x in s["by_part"] if x.get("unmatched")), None)
        check("caja que no casa con nada → grupo unmatched al final", un and un["box_ids"] == ["OLD-2"] and s["by_part"][-1] is un, un)
        check("by_line legado sigue igual (línea 1 = 12 en stock)", next(l for l in s["by_line"] if l["line_no"] == 1)["qty_in_stock"] == 12)
        check("caja vieja: asn_match best_effort", next(b for b in d["boxes"] if b["box_id"] == "OLD-1")["asn_match"] == "best_effort")
        r = await c.get("/api/wms/boxes/OLD-1/history")
        al = r.json().get("asn_link")
        check("asn_link best-effort para caja vieja", al and al["asn_id"] == "VIEJA-2" and al["line_no"] == 1 and al["part_number"] == "5000" and al["match"] == "best_effort", al)
        r = await c.get("/api/wms/boxes/OLD-2/history")
        al = r.json().get("asn_link")
        check("caja sin línea: asn_link con la entrada pero sin parte", al and al["asn_id"] == "VIEJA-2" and al["line_no"] is None and al["part_number"] == "" and al["match"] is None, al)

        print("\n== 6. Entrada borrada: la caja conserva lo heredado ==")
        sdb.wms_asn.delete_one({"asn_id": ASN})
        r = await c.get(f"/api/wms/boxes/{bx['box_id']}/history")
        al = r.json().get("asn_link")
        check("exists=False, número de parte heredado sigue", al and al["exists"] is False and al["asn_id"] == ASN and al["part_number"] == "GTS-SS100CCN" and al["line"] is None, al)
        r = await c.get("/api/wms/boxes/NOEXISTE/history")
        check("caja inexistente: asn_link None y found False", r.status_code == 200 and r.json()["asn_link"] is None and r.json()["found"] is False)

    print(f"\n===== {ok} PASS / {fail} FAIL =====")
    raw.drop_database(SMOKE_DB)
    print(f"base {SMOKE_DB} eliminada")
    sys.exit(1 if fail else 0)


if __name__ == "__main__":
    asyncio.run(main())
