"""Da de baja el saldo de inventario cuyo material YA SALIÓ, con evidencia.

EL PROBLEMA
───────────
Hay renglones que muestran piezas que no existen. El caso que lo detonó:
PS01-A10, GT13315J1500 / LIGHT PINK / S — el sistema dice 180 piezas en 3 cajas,
y las cuatro cajas de esa celda están en CERO desde el 17 de julio.

No es un misterio: el movimiento lo cuenta completo.
    2026-07-15  pick_deduction  60u   Elvis Pineda
    2026-07-17  cycle_count_shrink x3 Raymundo Rodriguez

El material salió. Las cajas quedaron en 0, correctamente. El renglón se quedó
atrás porque el conteo cíclico de julio todavía hacía aritmética sobre el
renglón en vez de recalcularlo desde las cajas — camino que ya no existe (ola 1
de un-solo-escritor, af368ff). Pero el saldo viejo sigue en pantalla, y el
operador tiene que adivinar cuál de los dos números es el bueno.

QUÉ DA DE BAJA — Y QUÉ NO
─────────────────────────
SOLO los renglones que cumplen LAS TRES condiciones:
  1. tienen saldo (units_on_hand > 0)
  2. NINGUNA caja viva de ese material en esa ubicación
  3. hay movimientos que PRUEBAN la salida sobre esas cajas
     (pick_deduction, cycle_count_shrink, cycle_count_units_fix,
      inventory_adjust_box)

La condición 3 es la que separa esto de un borrado a ciegas. Sin ella no se
toca: un renglón sin cajas y sin rastro puede ser material real que nunca tuvo
cartón, y ése va a conteo físico, no a un script. Medido el 2026-08-03: 17
renglones con evidencia (8,212 u) contra 147 sin ella (11,693 u).

Tampoco toca nada con `units_allocated` > 0: si hay material comprometido a una
orden, la decisión es humana.

REVERSIBLE
──────────
Respaldo JSON con el documento íntegro de cada renglón antes de borrar, más un
movimiento y una incidencia por renglón. `--revertir <archivo>` los restaura.

USO
───
    python backend/scripts/writeoff_papel_muerto.py            # dry-run
    python backend/scripts/writeoff_papel_muerto.py --apply
    python backend/scripts/writeoff_papel_muerto.py --revertir backup_xxx.json
"""
import argparse
import json
import os
import sys
import uuid
from datetime import datetime, timezone

import pymongo

MONGODB_URL = os.environ.get("MONGODB_URL")
DB_NAME = os.environ.get("DB_NAME", "mos-system")

# Movimientos que PRUEBAN que el material salió de esa caja.
EVIDENCIA = ["pick_deduction", "cycle_count_shrink", "cycle_count_units_fix",
             "inventory_adjust_box", "cycle_count_manual_discard"]

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")


def ahora():
    return datetime.now(timezone.utc).isoformat()


def planear(db):
    """Renglones con saldo, sin cajas vivas y con evidencia documental de salida.

    RENDIMIENTO: la versión ingenua consultaba las cajas por cada uno de los
    ~23,600 renglones — unas 70,000 consultas contra un Mongo remoto, que no
    terminaban. Aquí las celdas se resuelven en DOS agregaciones que corren en el
    servidor, y sólo los pocos candidatos que quedan pagan la consulta de
    evidencia.
    """
    def celda(loc, k, color, size):
        return ((loc or "").strip(), (k or "").strip(),
                (color or "").strip(), (size or "").strip())

    # 1. Celdas que TODAVÍA tienen cajas con stock -> se descartan de entrada.
    vivas = set()
    for g in db.wms_boxes.aggregate([
            {"$match": {"units": {"$gt": 0}}},
            {"$group": {"_id": {"l": "$location", "c": "$color", "z": "$size",
                                "s": "$style", "k": "$sku"}}}], allowDiskUse=True):
        d = g["_id"]
        for k in (d.get("s"), d.get("k")):
            if k:
                vivas.add(celda(d.get("l"), k, d.get("c"), d.get("z")))

    # 2. Celdas que tuvieron cajas alguna vez, con sus box_id (para la evidencia).
    historicas = {}
    for g in db.wms_boxes.aggregate([
            {"$group": {"_id": {"l": "$location", "c": "$color", "z": "$size",
                                "s": "$style", "k": "$sku"},
                        "ids": {"$addToSet": "$box_id"}}}], allowDiskUse=True):
        d = g["_id"]
        for k in (d.get("s"), d.get("k")):
            if k:
                historicas.setdefault(celda(d.get("l"), k, d.get("c"), d.get("z")),
                                      set()).update(g["ids"])

    plan, sin_evidencia = [], []
    for r in db.wms_inventory.find({"units_on_hand": {"$gt": 0}}, {"_id": 0}):
        if int(r.get("units_allocated") or 0) > 0:
            continue                      # comprometido: decisión humana
        keys = [k for k in {(r.get("style") or "").strip(),
                            (r.get("sku") or "").strip()} if k]
        if not keys:
            continue
        cs = [celda(r.get("location"), k, r.get("color"), r.get("size")) for k in keys]
        if any(c in vivas for c in cs):
            continue                      # todavía hay cajas: no es papel muerto
        ids = set()
        for c in cs:
            ids |= historicas.get(c, set())
        if not ids:
            sin_evidencia.append((r, "nunca hubo caja"))
            continue
        movs = list(db.wms_movements.find(
            {"type": {"$in": EVIDENCIA}, "details.box_id": {"$in": sorted(ids)}},
            {"_id": 0, "type": 1, "created_at": 1, "user_name": 1}
        ).sort("created_at", -1).limit(6))
        if not movs:
            sin_evidencia.append((r, "cajas en 0 pero sin movimiento que lo pruebe"))
            continue
        plan.append({"row": r, "cajas": len(ids), "movs": movs})
    return plan, sin_evidencia


def revertir(db, ruta):
    with open(ruta, encoding="utf-8") as fh:
        bak = json.load(fh)
    n = 0
    for doc in bak["renglones"]:
        d = dict(doc["doc"])
        if not db.wms_inventory.find_one({"inventory_id": d.get("inventory_id")}):
            db.wms_inventory.insert_one(d)
            n += 1
    print(f"Restaurados {n} renglones desde {ruta}")


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--apply", action="store_true", help="aplica (por defecto sólo simula)")
    ap.add_argument("--sin-cajas", action="store_true",
                    help="da de baja los renglones que NUNCA tuvieron caja (requiere "
                         "verificación humana en piso: no hay evidencia en la base)")
    ap.add_argument("--sin-rastro", action="store_true",
                    help="da de baja los renglones cuyas cajas SÍ existieron y hoy están "
                         "en 0, pero sin ningún movimiento que explique cómo se vaciaron")
    ap.add_argument("--revertir", metavar="ARCHIVO")
    ap.add_argument("--mongo", default=MONGODB_URL)
    args = ap.parse_args()
    if not args.mongo:
        sys.exit("Falta MONGODB_URL")
    db = pymongo.MongoClient(args.mongo)[DB_NAME]

    if args.revertir:
        return revertir(db, args.revertir)

    plan, sin_ev = planear(db)

    # MODO --sin-cajas: los renglones que NUNCA tuvieron caja fisica. Aqui no hay
    # evidencia documental posible —no hay caja de la que salir— asi que la baja
    # descansa en una verificacion HUMANA en piso. Se registra como tal en el
    # movimiento y en la incidencia, para que dentro de seis meses se sepa que
    # esta baja la autorizo una persona y no un rastro en la base.
    if args.sin_cajas:
        plan = [{"row": r, "cajas": 0, "movs": [],
                 "motivo": motivo, "sin_evidencia": True}
                for r, motivo in sin_ev if motivo == "nunca hubo caja"]
        sin_ev = [(r, m) for r, m in sin_ev if m != "nunca hubo caja"]

    # MODO --sin-rastro: las cajas SI existieron y hoy estan en 0, pero ningun
    # movimiento explica como se vaciaron. Es el grupo con MAS probabilidad de
    # contener material real —encaja con el perfil de los writeoffs de julio que
    # dejaron 292 cajas en 0 estando llenas en el rack (ver
    # restore_ccok_writeoff_boxes.py)—, asi que la baja se registra como decision
    # explicita del usuario, SIN verificacion fisica previa.
    # Las CAJAS no se tocan: si el material aparece, siguen ahi para reactivarlas.
    if args.sin_rastro:
        plan = [{"row": r, "cajas": 0, "movs": [],
                 "motivo": motivo, "sin_evidencia": True, "sin_rastro": True}
                for r, motivo in sin_ev if motivo != "nunca hubo caja"]
        sin_ev = [(r, m) for r, m in sin_ev if m == "nunca hubo caja"]

    u = sum(int(p["row"].get("units_on_hand") or 0) for p in plan)
    u_sin = sum(int(r.get("units_on_hand") or 0) for r, _ in sin_ev)

    print("=" * 96)
    if args.sin_cajas:
        print("SALDO SIN NINGUNA CAJA FÍSICA — baja por verificación humana en piso")
    else:
        print("PAPEL MUERTO — saldo cuyo material ya salió, probado por movimientos")
    print("=" * 96)
    print(f"  A dar de baja       : {len(plan):>4} renglones {u:>9,} u")
    print(f"  No se tocan         : {len(sin_ev):>4} renglones {u_sin:>9,} u\n")
    if plan:
        print(f"  {'ubicacion':<13}{'style':<15}{'color':<13}{'sz':<4}{'piezas':>8}{'cajas':>7}  "
              f"{'marcado' if args.sin_cajas else 'evidencia'}")
        for p in sorted(plan, key=lambda x: -int(x["row"].get("units_on_hand") or 0)):
            r = p["row"]
            if p.get("sin_evidencia"):
                nota = str(r.get("pending_cycle_count_reason") or "sin caja")[:52]
            else:
                m = p["movs"][0]
                nota = f"{m.get('type')} {str(m.get('created_at'))[:10]} {str(m.get('user_name') or '')[:18]}"
            print(f"  {str(r.get('location'))[:12]:<13}{str(r.get('style'))[:14]:<15}"
                  f"{str(r.get('color'))[:12]:<13}{str(r.get('size'))[:3]:<4}"
                  f"{int(r.get('units_on_hand') or 0):>8,}{p['cajas']:>7}  {nota}")

    if not args.apply:
        print("\n  DRY-RUN. Nada escrito. Repite con --apply.")
        return
    if not plan:
        print("\n  Nada que dar de baja.")
        return

    lote = "wo_" + uuid.uuid4().hex[:12]
    ruta = os.path.join(os.path.dirname(os.path.abspath(__file__)), f"backup_{lote}.json")
    with open(ruta, "w", encoding="utf-8") as fh:
        json.dump({"lote": lote, "creado": ahora(),
                   "renglones": [{"doc": {k: v for k, v in p["row"].items() if k != "_id"},
                                  "cajas": p["cajas"],
                                  "evidencia": [{kk: str(vv) for kk, vv in m.items()} for m in p["movs"]]}
                                 for p in plan]},
                  fh, ensure_ascii=False, indent=1, default=str)
    print(f"\n  Respaldo: {ruta}")

    n = 0
    for p in plan:
        r = p["row"]
        res = db.wms_inventory.delete_one({"inventory_id": r.get("inventory_id")})
        if not res.deleted_count:
            continue
        n += 1
        det = {"inventory_id": r.get("inventory_id"),
               "location": r.get("location"), "style": r.get("style"),
               "color": r.get("color"), "size": r.get("size"),
               "units_dados_de_baja": int(r.get("units_on_hand") or 0),
               "batch": lote}
        if p.get("sin_rastro"):
            det.update({
                "cajas_agotadas": 0,
                "evidencia_tipo": "ninguna",
                "marcado_por_el_sistema": r.get("pending_cycle_count_reason"),
                "reason": "Las cajas de este renglon EXISTIERON y hoy estan en 0, pero "
                          "NINGUN movimiento explica como se vaciaron — perfil de los "
                          "writeoffs de julio que dejaron cajas en 0 estando llenas. "
                          "Baja ordenada por el usuario SIN verificacion fisica previa, "
                          "con la reserva ya planteada. Las CAJAS siguen existiendo: si "
                          "el material aparece en el rack, se reactivan y se restaura "
                          "el renglon desde el respaldo de este lote."})
        elif p.get("sin_evidencia"):
            det.update({
                "cajas_agotadas": 0,
                "evidencia_tipo": "verificacion_humana",
                "marcado_por_el_sistema": r.get("pending_cycle_count_reason"),
                "reason": "El renglon NUNCA tuvo caja fisica: no hay evidencia posible "
                          "en la base. Baja AUTORIZADA POR EL USUARIO tras verificar en "
                          "piso que el material no esta en esa ubicacion."})
        else:
            m = p["movs"][0]
            det.update({
                "cajas_agotadas": p["cajas"],
                "evidencia_tipo": m.get("type"),
                "evidencia_fecha": str(m.get("created_at")),
                "evidencia_usuario": m.get("user_name"),
                "reason": "El material salio; el renglon se quedo atras. "
                          "Baja con evidencia documental, sin conteo fisico."})
        db.wms_movements.insert_one({
            "movement_id": "mov_" + uuid.uuid4().hex[:12],
            "type": "writeoff_papel_muerto", "details": det,
            "user_id": None, "user_name": "Sistema (writeoff_papel_muerto)",
            "created_at": ahora()})
    if args.sin_rastro:
        msg = (f"Se dieron de baja {n} renglones ({u:,} u) cuyas cajas existieron y hoy "
               f"estan en 0 SIN ningun movimiento que lo explique. Es el grupo con mas "
               f"probabilidad de contener material real; la baja la ordeno el usuario sin "
               f"verificacion fisica previa. Las cajas NO se tocaron. Lote {lote}.")
    elif args.sin_cajas:
        msg = (f"Se dieron de baja {n} renglones ({u:,} u) que NUNCA tuvieron caja "
               f"fisica. NO hay evidencia documental: la baja la AUTORIZO EL USUARIO "
               f"tras verificar en piso. Lote {lote}.")
    else:
        msg = (f"Se dieron de baja {n} renglones ({u:,} u) cuyo material ya habia "
               f"salido, probado por movimientos de picking o conteo. Lote {lote}. "
               f"Quedan {len(sin_ev)} renglones ({u_sin:,} u) sin evidencia.")
    db.wms_incidents.insert_one({
        "incident_id": "inc_" + uuid.uuid4().hex[:12],
        "kind": "writeoff_papel_muerto", "mensaje": msg,
        "autorizado_por_usuario": bool(args.sin_cajas),
        "batch": lote, "renglones": n, "unidades": u,
        "user_id": None, "user_name": "Sistema (writeoff_papel_muerto)",
        "created_at": ahora()})
    print(f"  {n} renglones dados de baja ({u:,} u).")
    print(f"  Para deshacer: --revertir {ruta}")


if __name__ == "__main__":
    main()
