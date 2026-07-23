"""Detección de "stock fantasma": la comparación cajas-vs-renglones que alimenta
la pestaña Stock Fantasma del módulo de Conciliación.

QUÉ ES UN FANTASMA
──────────────────
Papel que no cuadra con el piso, en cualquiera de las dos direcciones:

  · saldo_sin_cajas : el renglón dice más unidades de las que suman sus cajas
                      (incluye renglones SIN ninguna caja). El clásico de los
                      imports de Excel y del picking viejo: unidades de papel
                      que quizá no existen físicamente.
  · cajas_de_papel  : las cajas suman más que el renglón (incluye cajas cuyo
                      renglón está en 0 o ni existe). El FIFO viejo vaciaba
                      renglones con aritmética y dejaba cajas "llenas" que el
                      surtidor ya se llevó — NA03-C20 / NA04-B21 / RP01-C37
                      (2026-07-23) son el caso canónico.
  · sin_identidad   : cajas con material pero sin style (vacío o el placeholder
                      "(SIN IDENTIFICAR)" que crea la conciliación PDA). No se
                      pueden proyectar a ningún renglón: alguien tiene que abrir
                      la caja y decir qué es.

NINGÚN fantasma se corrige solo: cada item es una tarea de piso (conteo físico)
con su campo `registro` para anotar lo que se encontró. La corrección de datos
(baja/alta/reproyección) viene DESPUÉS del conteo, nunca antes.

TRÁNSITO: en CARRO <n> / UBICACION TEMPORAL las cajas sin renglón son estado
normal (material recibido al carro que aún no hace putaway), así que ahí NO se
reportan cajas_de_papel; los saldos sin cajas SÍ (los CARROS 413-438 son los
principales sospechosos del fantasma clásico).

La llave de comparación es IDÉNTICA a reproject_inventory_from_boxes.py:
(location, style, color, size) + lote canónico (país + composición vía
canon_coo/canon_fabric). style exacto, sin fallback a sku.
"""

import hashlib
import re
from collections import defaultdict

from services.inventory_ledger import canon_coo, canon_fabric

# Placeholder con el que la conciliación PDA crea cajas desconocidas (y por el
# que una caja se considera sin identidad aunque el campo no esté vacío).
SIN_IDENTIFICAR = "(SIN IDENTIFICAR)"

TRANSIT_NAME_REGEX = re.compile(r"^(UBICACION TEMPORAL|CARRO \d+)$")

TIPOS = ("saldo_sin_cajas", "cajas_de_papel", "sin_identidad")


def _norm(s):
    return re.sub(r"\s+", " ", str(s or "")).strip().upper()


def es_transito(location):
    return bool(TRANSIT_NAME_REGEX.match(_norm(location)))


def _units(doc):
    try:
        return int(doc.get("units") or doc.get("qty") or 0)
    except (TypeError, ValueError):
        return 0


def _sin_identidad(style):
    s = _norm(style)
    return not s or s == SIN_IDENTIFICAR


def phantom_id(location, tipo, style, color, size, coo, fabric):
    """Id DETERMINISTA por llave: el mismo fantasma conserva su id (y por lo
    tanto su `registro`) a través de escaneos sucesivos."""
    llave = "|".join((_norm(location), tipo, _norm(style), _norm(color),
                      _norm(size), coo or "", fabric or ""))
    return "ph_" + hashlib.md5(llave.encode("utf-8")).hexdigest()[:12]


def compute_phantom_items(boxes, rows):
    """Compara cajas contra renglones y devuelve la lista de fantasmas.

    boxes: dicts de wms_boxes (usa location, style, color, size, units/qty,
           country_of_origin/coo, fabric_content, box_id).
    rows:  dicts de wms_inventory (usa location, style, color, size,
           units_on_hand, country_of_origin/coo, fabric_content).

    Función PURA: no toca la base. Devuelve items listos para upsert, cada uno
    con phantom_id determinista.
    """
    def lote(doc):
        return (canon_coo(doc.get("country_of_origin") or doc.get("coo")),
                canon_fabric(doc.get("fabric_content")))

    cajas = defaultdict(lambda: {"units": 0, "boxes": 0, "ids": []})
    sin_ident = defaultdict(lambda: {"units": 0, "boxes": 0, "ids": []})
    for b in boxes:
        u = _units(b)
        if u <= 0:
            continue
        loc = _norm(b.get("location"))
        if not loc:
            continue
        if _sin_identidad(b.get("style")):
            g = sin_ident[loc]
        else:
            k = (loc, _norm(b.get("style")), _norm(b.get("color")),
                 _norm(b.get("size"))) + lote(b)
            g = cajas[k]
        g["units"] += u
        g["boxes"] += 1
        if len(g["ids"]) < 10:
            g["ids"].append(b.get("box_id"))

    renglones = defaultdict(int)
    for r in rows:
        loc = _norm(r.get("location"))
        if not loc or _sin_identidad(r.get("style")):
            continue
        k = (loc, _norm(r.get("style")), _norm(r.get("color")),
             _norm(r.get("size"))) + lote(r)
        try:
            renglones[k] += int(r.get("units_on_hand") or 0)
        except (TypeError, ValueError):
            pass

    items = []

    def item(loc, tipo, k_mat, u_renglon, u_cajas, n_cajas, ids):
        style, color, size, coo, fabric = k_mat
        items.append({
            "phantom_id": phantom_id(loc, tipo, style, color, size, coo, fabric),
            "location": loc, "tipo": tipo, "transito": es_transito(loc),
            "style": style, "color": color, "size": size,
            "lote_coo": coo, "lote_fabric": fabric,
            "units_renglon": u_renglon, "units_cajas": u_cajas,
            "delta": abs(u_renglon - u_cajas), "cajas": n_cajas,
            "box_ids": ids,
        })

    llaves = set(cajas) | set(renglones)
    for k in llaves:
        loc, k_mat = k[0], k[1:]
        g = cajas.get(k)
        u_cajas = g["units"] if g else 0
        u_renglon = renglones.get(k, 0)
        if u_renglon > u_cajas:
            item(loc, "saldo_sin_cajas", k_mat, u_renglon, u_cajas,
                 g["boxes"] if g else 0, g["ids"] if g else [])
        elif u_cajas > u_renglon and not es_transito(loc):
            item(loc, "cajas_de_papel", k_mat, u_renglon, u_cajas,
                 g["boxes"], g["ids"])

    for loc, g in sin_ident.items():
        item(loc, "sin_identidad", ("", "", "", "", ""),
             0, g["units"], g["boxes"], g["ids"])

    items.sort(key=lambda x: -x["delta"])
    return items
