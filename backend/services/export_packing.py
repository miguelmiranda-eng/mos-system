"""Motor del PACKING LIST de exportación (PL GTS MM-YY-####).

Arma el PL que Envíos llenaba a mano (formato de "PL GTS 09-26-0085 SHIPPING
09-29-2026.xlsx") con lo que ya vive en MOS y WMS. Por cada orden del export:

  INV# / PO# / CUST PO / STYLE # / COLOR  → la orden (order_number,
                                            customer_po, store_po, design_#, color)
  CONTENT / ORIGEN / tallas / DESCRIPTION → 1) DIGITAL PACKING LIST de la orden
                                               (Google Sheet de empaque, enlace en
                                               orders.links): resumen % × país × talla
                                            2) si el DPL está vacío: surtido del WMS
                                               (conteo de cuellos o pick_deduction)
  TOTAL BOXES / TOTAL PALLET              → DPL (suma de Box Qty / Pallet # distintos)
  CUSTOMER / SHIP TO                      → branding / DELIVER TO del renglón

y valida DPL contra WMS y contra las PCS del renglón: lo que no cuadra sale
como aviso (no bloquea). Los DPL se leen por su enlace público (export xlsx de
Google), sin credenciales.

Probado contra el PL 0085: órdenes 3319 y 3266 cuadran celda por celda.
"""
import asyncio
import io
import os
import re
import time
import zipfile
from datetime import date

import httpx
import openpyxl
from openpyxl.drawing.image import Image as XLImage
from openpyxl.styles import Alignment, Border, Font, PatternFill, Side

from deps import db

PAPELERA = "PAPELERA DE RECICLAJE"
LOGO = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "static", "images", "prosper_pl_logo.png")
SHIP_TO_DEFAULT = ["TSC BROKER", "8140 ST ANDREWS AVE", "SAN DIEGO CA 92154"]
CLIENT_CODES = {"GTS": "GTS", "GOODIE TWO SLEEVES": "GTS", "GOODIE TWO SLEEVES LLC": "GTS", "SPEKTRUM": "SKT"}

# Tallas del PL (columnas I..Q) y sus nombres en MOS / DPL.
SIZES = ["XS", "S", "M", "L", "XL", "2X", "3X", "4X", "5X"]
SIZE_HEAD = ["XS", "SM", "MD", "LG", "XL", "2XL", "3XL", "4XL", "5XL"]
_SIZE_ALIASES = {
    "XS": "XS", "XS OR OSFA": "XS", "OSFA": "XS", "XSMALL": "XS",
    "S": "S", "SM": "S", "SMALL": "S",
    "M": "M", "MD": "M", "MED": "M", "MEDIUM": "M",
    "L": "L", "LG": "L", "LARGE": "L",
    "XL": "XL", "XLG": "XL",
    "2X": "2X", "2XL": "2X", "XXL": "2X",
    "3X": "3X", "3XL": "3X", "XXXL": "3X",
    "4X": "4X", "4XL": "4X",
    "5X": "5X", "5XL": "5X",
}


def norm_size(v):
    s = re.sub(r"\s+", " ", str(v or "")).strip().upper()
    s = re.sub(r"^SIZE\s+", "", s)
    return _SIZE_ALIASES.get(s)


def norm_country(v):
    s = re.sub(r"\s+", " ", str(v or "")).strip().upper().replace(".", "")
    if not s:
        return ""
    if s.startswith("REP") and "DOMIN" in s:
        return "REP DOMINICANA"
    return s


def norm_fabric(v):
    return re.sub(r"\s+", " ", str(v or "")).strip().upper()


def norm_description(v):
    s = re.sub(r"\s+", " ", str(v or "")).strip().upper()
    if not s:
        return ""
    if re.search(r"\bS/?S\b|SHORT", s):
        return "SHORT SLEEVE"
    if re.search(r"\bL/?S\b|LONG", s):
        return "LONG SLEEVE"
    if "TANK" in s:
        return "TANK TOP"
    if "HOOD" in s:
        return "HOODIE"
    if "CREW" in s:
        return "CREWNECK"
    return s


def client_code(client):
    c = re.sub(r"\s+", " ", str(client or "")).strip().upper()
    return CLIENT_CODES.get(c) or (re.sub(r"[^A-Z0-9]", "", c)[:3] or "XXX")


def _num(v):
    if v in (None, ""):
        return None
    if isinstance(v, (int, float)):
        return float(v)
    try:
        return float(str(v).replace(",", "").strip())
    except ValueError:
        return None


def cust_po(order):
    """CUST PO del PL = PO de la tienda. En licencias (WARNER) store_po# trae
    dos: 'P028209 - 325985' (licenciatario - tienda) → 325985."""
    raw = str(order.get("store_po#") or order.get("store_po") or "")
    nums = re.findall(r"\b\d{5,}\b", raw)
    return _digits_or_text(nums[-1] if nums else (order.get("store_po") or raw))


def _digits_or_text(v):
    """'22726' → 22726 (como en el PL original); el resto, texto."""
    s = str(v or "").strip()
    return int(s) if s.isdigit() else (s or None)


# ── Lectura del DIGITAL PACKING LIST (Google Sheet de empaque) ───────────────

DPL_RE = re.compile(r"docs\.google\.com/spreadsheets/d/([A-Za-z0-9_-]+)")
_DPL_CACHE = {}          # url → (ts, parsed)
_DPL_TTL = 120


def dpl_url(order):
    """Enlace al DPL de la orden (orders.links, sembrado por el sync de Printavo)."""
    for ln in order.get("links") or []:
        url = (ln or {}).get("url") or ""
        if DPL_RE.search(url) and "PACKING" in str((ln or {}).get("description") or "").upper():
            return url
    return None


def parse_dpl(content: bytes) -> dict:
    """Lee el formato de la hoja de empaque. Devuelve:
    {garment_type, boxes, pallets, total, by_size{S:..}, rows:[{fabric,country,sizes}],
     date_packed, packer, source_rows: 'summary'|'size_tables'|None}"""
    wb = openpyxl.load_workbook(io.BytesIO(content), data_only=True, read_only=False)
    ws = wb["PACKING LIST"] if "PACKING LIST" in wb.sheetnames else wb.worksheets[0]
    grid = {}
    for row in ws.iter_rows(min_row=1, max_row=min(ws.max_row, 200), max_col=min(ws.max_column, 40)):
        for c in row:
            if c.value not in (None, ""):
                grid[(c.row, c.column)] = c.value

    def txt(r, c):
        return re.sub(r"\s+", " ", str(grid.get((r, c), ""))).strip()

    out = {"garment_type": None, "boxes": None, "pallets": None, "total": 0, "by_size": {},
           "rows": [], "rows_summary": [], "rows_tables": [],
           "date_packed": None, "packer": None, "source_rows": None}
    # Encabezado del detalle por caja: renglón con 'XS or OSFA' y 'Box Qty'.
    head_r = next((r for (r, c), v in sorted(grid.items()) if str(v).strip().upper() == "BOX QTY"), None)
    if head_r is None:
        return out
    cols = {}
    for (r, c), v in grid.items():
        if r == head_r:
            cols[re.sub(r"\s+", " ", str(v)).strip().upper()] = c
    size_cols = {norm_size(k): c for k, c in cols.items() if norm_size(k)}
    end_r = next((r for (r, c), v in sorted(grid.items()) if r > head_r and "TOTAL SHIPPED" in str(v).upper()), head_r + 26)
    boxes, pallets = 0.0, set()
    for r in range(head_r + 1, end_r):
        gt = txt(r, cols.get("GARMENT TYPE", 2))
        if gt and not out["garment_type"]:
            out["garment_type"] = gt
        bq = _num(grid.get((r, cols.get("BOX QTY", 15))))
        if bq:
            boxes += bq
        pal = txt(r, cols.get("PALLET #", 19))
        if pal:
            pallets.add(pal)
        for sz, c in size_cols.items():
            q = _num(grid.get((r, c)))
            if q:
                out["by_size"][sz] = out["by_size"].get(sz, 0) + int(round(q))
    out["boxes"] = int(round(boxes)) if boxes else None
    out["pallets"] = len(pallets) or None
    out["total"] = sum(out["by_size"].values())
    for (r, c), v in grid.items():
        lab = str(v).strip().upper()
        if lab.startswith("DATE PACKED"):
            out["date_packed"] = grid.get((r, c + 2)) or grid.get((r, c + 1))
        if lab.startswith("PACKER NAME"):
            out["packer"] = grid.get((r, c + 2)) or grid.get((r, c + 1))

    # 1) Resumen final: Percentage | Country of Origin | XS or OSFA | SM ... | TOTAL
    sum_r = next((r for (r, c), v in sorted(grid.items())
                  if r > end_r and str(v).strip().upper() == "PERCENTAGE"
                  and any(norm_size(grid.get((r, cc))) for cc in range(c + 1, c + 12))), None)
    rows = {}
    if sum_r:
        scols = {}
        fab_c = cty_c = None
        for (r, c), v in grid.items():
            if r != sum_r:
                continue
            lab = str(v).strip().upper()
            if lab == "PERCENTAGE":
                fab_c = c
            elif lab.startswith("COUNTRY"):
                cty_c = c
            elif norm_size(lab) and c < 16:
                scols[norm_size(lab)] = c
        r = sum_r + 1
        while r < sum_r + 40 and txt(r, fab_c or 1).upper() != "TOTAL":
            cty = norm_country(grid.get((r, cty_c))) if cty_c else ""
            sizes = {sz: int(round(_num(grid.get((r, c))) or 0)) for sz, c in scols.items()}
            sizes = {k: v for k, v in sizes.items() if v}
            if cty and sizes:
                key = (norm_fabric(grid.get((r, fab_c))), cty)
                acc = rows.setdefault(key, {})
                for k, v in sizes.items():
                    acc[k] = acc.get(k, 0) + v
            r += 1
    out["rows_summary"] = [{"fabric": f, "country": cty, "sizes": s} for (f, cty), s in rows.items()]
    # 2) Tablas por talla ("SIZE MD": Percentage | Country of Origin | Qty).
    #    Se leen siempre: en la práctica el resumen a veces está mal capturado
    #    y las tablas no (o al revés); se elige la que cuadra con TOTAL SHIPPED.
    rows = {}
    for (r, c), v in sorted(grid.items()):
        if not str(v).strip().upper().startswith("SIZE ") or r <= end_r:
            continue
        sz = norm_size(v)
        if not sz:
            continue
        hdr = {str(grid.get((r + 1, cc), "")).strip().upper(): cc for cc in range(c, c + 9)}
        fab_c = hdr.get("PERCENTAGE", c)
        cty_c = next((cc for k, cc in hdr.items() if k.startswith("COUNTRY")), None)
        qty_c = hdr.get("QTY")
        if not cty_c or not qty_c:
            continue
        for rr in range(r + 2, r + 9):
            if str(grid.get((rr, c), "")).strip().upper().startswith("TOTAL"):
                break
            cty = norm_country(grid.get((rr, cty_c)))
            q = int(round(_num(grid.get((rr, qty_c))) or 0))
            if cty and q:
                acc = rows.setdefault((norm_fabric(grid.get((rr, fab_c))), cty), {})
                acc[sz] = acc.get(sz, 0) + q
    out["rows_tables"] = [{"fabric": f, "country": cty, "sizes": s} for (f, cty), s in rows.items()]
    for name, cand in (("summary", out["rows_summary"]), ("size_tables", out["rows_tables"])):
        if cand and size_totals(cand) == out["by_size"]:
            out["rows"], out["source_rows"] = cand, name
            break
    else:
        cand = out["rows_summary"] or out["rows_tables"]
        out["rows"] = cand
        out["source_rows"] = ("summary" if out["rows_summary"] else "size_tables") if cand else None
    return out


def size_totals(rows) -> dict:
    out = {}
    for r in rows:
        for sz, q in r["sizes"].items():
            if q:
                out[sz] = out.get(sz, 0) + q
    return out


async def fetch_dpl(client: httpx.AsyncClient, url: str):
    m = DPL_RE.search(url or "")
    if not m:
        return None, "enlace del DPL no es de Google Sheets"
    hit = _DPL_CACHE.get(url)
    if hit and time.time() - hit[0] < _DPL_TTL:
        return hit[1], None
    try:
        r = await client.get(f"https://docs.google.com/spreadsheets/d/{m.group(1)}/export?format=xlsx",
                             follow_redirects=True, timeout=25)
    except httpx.HTTPError as e:
        return None, f"no se pudo descargar el DPL ({type(e).__name__})"
    if r.status_code != 200 or b"PK" not in r.content[:4]:
        return None, f"el DPL no es público o no existe (HTTP {r.status_code})"
    try:
        parsed = await asyncio.to_thread(parse_dpl, r.content)
    except Exception as e:  # noqa: BLE001 — formato inesperado = aviso, no caída
        return None, f"no se pudo leer el DPL ({type(e).__name__})"
    _DPL_CACHE[url] = (time.time(), parsed)
    return parsed, None


# ── Surtido del WMS (talla × país, con composición y descripción) ────────────

async def wms_breakdown(order_number: str) -> dict:
    """{rows:[{fabric,country,sizes}], fabric, description, source} desde el
    conteo de cuellos (si existe) o los pick_deduction del surtido."""
    movs = await db.wms_movements.find(
        {"type": "pick_deduction", "details.order_number": order_number},
        {"_id": 0, "details.size": 1, "details.boxes": 1}).to_list(5000)
    box_ids = [b.get("box_id") for m in movs for b in (m.get("details", {}).get("boxes") or []) if b.get("box_id")]
    boxes = {}
    if box_ids:
        for b in await db.wms_boxes.find({"box_id": {"$in": box_ids}},
                                         {"_id": 0, "box_id": 1, "country_of_origin": 1, "fabric_content": 1,
                                          "description": 1}).to_list(10000):
            boxes[b["box_id"]] = b
    fabrics, descs = {}, {}
    picked = {}
    for m in movs:
        d = m.get("details") or {}
        sz = norm_size(d.get("size"))
        for b in d.get("boxes") or []:
            bx = boxes.get(b.get("box_id"), {})
            cty = norm_country(bx.get("country_of_origin"))
            fab = norm_fabric(bx.get("fabric_content"))
            q = int(b.get("taken") or 0)
            if not sz or not q:
                continue
            fabrics[fab] = fabrics.get(fab, 0) + q
            if bx.get("description"):
                descs[bx["description"]] = descs.get(bx["description"], 0) + q
            acc = picked.setdefault((fab, cty), {})
            acc[sz] = acc.get(sz, 0) + q
    fabric = max(fabrics, key=fabrics.get) if fabrics else ""
    description = norm_description(max(descs, key=descs.get)) if descs else ""
    neck = await db.wms_neck_counts.find({"order_number": order_number}, {"_id": 0, "counts": 1}).to_list(50)
    counted = {}
    for nc in neck:
        for k, q in (nc.get("counts") or {}).items():
            sz, _, cty = str(k).partition("|")
            sz, cty = norm_size(sz), norm_country(cty)
            if sz and q:
                acc = counted.setdefault((fabric, cty), {})
                acc[sz] = acc.get(sz, 0) + int(q)
    src, data = ("neck_count", counted) if counted else ("pick", picked)
    return {"rows": [{"fabric": f, "country": c, "sizes": s} for (f, c), s in data.items()],
            "fabric": fabric, "description": description, "source": src if data else None}


WMS_LABEL = {"neck_count": "WMS · conteo de cuellos", "pick": "WMS · surtido"}


def _by_size_country(rows):
    out = {}
    for r in rows:
        for sz, q in r["sizes"].items():
            out[(sz, r["country"])] = out.get((sz, r["country"]), 0) + q
    return out


def _sort_rows(rows):
    def key(r):
        first = min((SIZES.index(s) for s in r["sizes"] if s in SIZES), default=99)
        return (first, -sum(r["sizes"].values()))
    return sorted(rows, key=key)


# ── Ensamblado por export / orden ────────────────────────────────────────────

def pl_number_for(export, code):
    """PL del cliente en el export: lo capturado en pl_numbers ('PLGTS 09-26-0085 &
    PLSKT 09-26-0085') o, si no está, PL<code> MM-YY-<export#>."""
    for m in re.finditer(r"PL\s*-?\s*([A-Z]{2,4})\s*-?\s*(\d{2}-\d{2}-\d{3,5})", str(export.get("pl_numbers") or "").upper()):
        if m.group(1) == code:
            return f"PL{code} {m.group(2)}"
    if export.get("export_no") and export.get("date"):
        d = export["date"]
        return f"PL{code} {d[5:7]}-{d[2:4]}-{int(export['export_no']):04d}"
    return None


async def build_context(export_id: str, shipment_id: str | None = None) -> dict:
    exp = await db.shipping_exports.find_one({"export_id": export_id}, {"_id": 0})
    if not exp:
        raise LookupError("export")
    q = {"export_id": export_id}
    if shipment_id:
        q["shipment_id"] = shipment_id
    lines = await db.scheduled_shipments.find(q, {"_id": 0}).sort([("position", 1), ("created_at", 1)]).to_list(1000)
    if shipment_id and not lines:
        raise LookupError("line")
    nums = list(dict.fromkeys(ln["order_number"] for ln in lines))
    orders = {o["order_number"]: o for o in await db.orders.find(
        {"order_number": {"$in": nums}, "board": {"$ne": PAPELERA}}, {"_id": 0}).to_list(1000)}
    sem = asyncio.Semaphore(6)
    dpls = {}

    async with httpx.AsyncClient(headers={"User-Agent": "MOS-packing/1.0"}) as client:
        async def one(num):
            o = orders.get(num)
            url = dpl_url(o) if o else None
            if not url:
                dpls[num] = (None, None, "sin enlace al DIGITAL PACKING LIST")
                return
            async with sem:
                parsed, err = await fetch_dpl(client, url)
            dpls[num] = (url, parsed, err)
        await asyncio.gather(*(one(n) for n in nums))
    wms = dict(zip(nums, await asyncio.gather(*(wms_breakdown(n) for n in nums))))

    groups, warnings = [], []
    for ln in lines:
        num = ln["order_number"]
        o = orders.get(num) or {}
        mf = ln.get("manual_fields") or {}
        url, dpl, dpl_err = dpls.get(num, (None, None, None))
        w = wms.get(num) or {"rows": [], "fabric": "", "description": "", "source": None}
        tag = f"#{num}"
        # ¿De dónde sale talla × país? Validado contra el PL 0085 hecho a mano
        # (15 órdenes): el WMS (conteo de cuellos / surtido) acierta 12/15 y el
        # resumen del DPL 10/15 (errores de captura). Regla: WMS si sus totales
        # por talla cuadran con el TOTAL SHIPPED del DPL (lo realmente empacado);
        # si no, el DPL si cuadra; si nada cuadra, WMS con aviso. → 13/15, y las
        # diferencias DPL vs WMS siempre salen como aviso.
        ts = (dpl or {}).get("by_size") or {}
        has_dpl = bool(dpl and (dpl.get("rows") or dpl.get("boxes") or ts))
        dpl_rows = (dpl or {}).get("rows") or []
        wms_ok = bool(w["rows"]) and (not ts or size_totals(w["rows"]) == ts)
        dpl_ok = bool(dpl_rows) and size_totals(dpl_rows) == ts
        if wms_ok:
            rows, origin = w["rows"], WMS_LABEL.get(w["source"], "WMS")
        elif dpl_ok:
            rows, origin = dpl_rows, "DPL"
        elif w["rows"]:
            rows, origin = w["rows"], WMS_LABEL.get(w["source"], "WMS")
            if ts:
                warnings.append(f"{tag}: el surtido del WMS no cuadra por talla con lo empacado (DPL TOTAL SHIPPED); revisa tallas")
        else:
            rows, origin = dpl_rows, "DPL"
        use_dpl = has_dpl
        if not use_dpl:
            if dpl_err:
                warnings.append(f"{tag}: {dpl_err}; se usó el surtido del WMS y faltan cajas/tarimas")
            elif dpl is not None:
                warnings.append(f"{tag}: el DIGITAL PACKING LIST está vacío (no se ha empacado); se usó el surtido del WMS y faltan cajas/tarimas")
            if not rows:
                warnings.append(f"{tag}: sin desglose talla × país ni en DPL ni en WMS; sale con las tallas de la orden y sin ORIGEN")
                origin = "orden"
                rows = [{"fabric": w["fabric"], "country": "",
                         "sizes": {norm_size(k): int(v) for k, v in (o.get("sizes") or {}).items()
                                   if norm_size(k) and v}}]
        # Copias (el DPL viene de caché) y composición faltante → la del WMS.
        rows = [{"fabric": r["fabric"] or w["fabric"], "country": r["country"], "sizes": dict(r["sizes"])}
                for r in rows]
        total = sum(sum(r["sizes"].values()) for r in rows)
        if ln.get("pcs") and total and int(ln["pcs"]) != total:
            warnings.append(f"{tag}: el packing suma {total:,} pzs y el renglón del programador dice {int(ln['pcs']):,}"
                            + (" (¿envío parcial?)" if int(ln["pcs"]) < total else ""))
        if ts and dpl_rows and size_totals(dpl_rows) != ts:
            warnings.append(f"{tag}: en el DPL el resumen por país ({sum(size_totals(dpl_rows).values()):,}) "
                            f"no cuadra con su TOTAL SHIPPED ({sum(ts.values()):,})")
        if ts and total and size_totals(rows) != ts:
            warnings.append(f"{tag}: el packing ({total:,}) no cuadra por talla con lo empacado según el DPL ({sum(ts.values()):,})")
        if dpl_rows and w["rows"]:
            a, b = _by_size_country(dpl_rows), _by_size_country(w["rows"])
            diff = [f"{SIZE_HEAD[SIZES.index(sz)] if sz in SIZES else sz} {cty or '¿?'}: DPL {a.get((sz, cty), 0)} / WMS {b.get((sz, cty), 0)}"
                    for (sz, cty) in sorted(set(a) | set(b), key=lambda k: (SIZES.index(k[0]) if k[0] in SIZES else 99, k[1]))
                    if a.get((sz, cty), 0) != b.get((sz, cty), 0)]
            if diff:
                warnings.append(f"{tag}: país de origen distinto entre DPL y WMS (se usó {origin}) — " + "; ".join(diff[:6])
                                + (f" (+{len(diff) - 6})" if len(diff) > 6 else ""))
        if use_dpl and not dpl.get("boxes"):
            warnings.append(f"{tag}: el DPL no trae cajas (Box Qty)")
        extra = sorted({s for r in rows for s in r["sizes"] if s not in SIZES})
        if extra:
            warnings.append(f"{tag}: tallas fuera del formato del PL ({', '.join(extra)}) no se imprimen")
        groups.append({
            "shipment_id": ln["shipment_id"],
            "order_number": num,
            "code": client_code(o.get("client") or mf.get("client")) if (o.get("client") or mf.get("client")) else None,
            "inv": _digits_or_text(num),
            "po": _digits_or_text(o.get("customer_po") or mf.get("customer_po")),
            "cust_po": cust_po(o) if o else _digits_or_text(mf.get("customer_po")),
            "style": (o.get("design_#") or o.get("design_num") or mf.get("design_num") or "").strip(),
            "color": str(o.get("color") or "").strip().upper(),
            "description": norm_description(dpl.get("garment_type")) if use_dpl and dpl.get("garment_type") else w["description"],
            "rows": _sort_rows(rows),
            "boxes": dpl.get("boxes") if use_dpl else None,
            "pallets": dpl.get("pallets") if use_dpl else None,
            "customer": str(o.get("branding") or mf.get("branding") or "").strip().upper(),
            "ship_to": ln.get("delivery_to") or "",
            "source": origin,
            "dpl_url": url,
            "packed": {"date": str(dpl.get("date_packed") or "") if dpl else "", "by": str(dpl.get("packer") or "") if dpl else ""},
        })
    # Orden sin cliente en MOS (dato faltante): va al PL del cliente que domina
    # el export, con aviso para corregir el dato.
    codes = [g["code"] for g in groups if g["code"]]
    main_code = max(set(codes), key=codes.count) if codes else "GTS"
    for g in groups:
        if not g["code"]:
            g["code"] = main_code
            warnings.append(f"#{g['order_number']}: la orden no tiene cliente en MOS; se incluyó en el PL {main_code} (corrige el cliente)")
    return {"export": exp, "groups": groups, "warnings": warnings}


# ── Excel con el formato del PL original ─────────────────────────────────────

_THIN = Side(style="thin")
_BOX = Border(left=_THIN, right=_THIN, top=_THIN, bottom=_THIN)
_B = Font(name="Calibri", size=11, bold=True)
_TEAL = PatternFill("solid", fgColor="4BACC6")
_CREAM = PatternFill("solid", fgColor="EAF1DD")
_C = Alignment(horizontal="center", vertical="center", wrap_text=True)
HEAD = ["INV#", "PO#", "CUST PO", "STYLE #", "COLOR", "CONTENT", "DESCRIPTION", "ORIGEN", *SIZE_HEAD,
        "TOTAL UNITS", "TOTAL BOXES", "TOTAL PALLET", "CUSTOMER", "SHIP TO:"]
_WIDTHS = {"A": 10.3, "B": 9.7, "C": 11.5, "D": 18.9, "E": 14, "F": 22, "G": 18, "H": 20,
           "R": 9.9, "S": 9.7, "T": 10.3, "U": 15.4, "V": 10.7, "W": 11.4}


def _cell(ws, ref, value=None, fill=None, fmt=None, border=True, align=_C):
    c = ws[ref]
    if value is not None:
        c.value = value
    c.font = _B
    c.alignment = align
    if border:
        c.border = _BOX
    if fill:
        c.fill = fill
    if fmt:
        c.number_format = fmt
    return c


def _truck_parts(truck):
    """'TEC.184 / 53145' → ('TEC.184', '53145') (camión / No.Eco)."""
    s = str(truck or "").strip()
    if "/" in s:
        a, b = s.split("/", 1)
        return a.strip(), b.strip()
    return s, ""


def render_pl(pl_number: str, export: dict, groups: list) -> bytes:
    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = "PACKING"
    for col, w in _WIDTHS.items():
        ws.column_dimensions[col].width = w
    for col in "IJKLMNOPQ":
        ws.column_dimensions[col].width = 6.9
    # Encabezado
    if os.path.exists(LOGO):
        img = XLImage(LOGO)
        img.width, img.height = 311, 115
        ws.add_image(img, "A1")
    ws.merge_cells("A1:H7")
    ship_date = export.get("date")
    for r, (lab, val, fill) in enumerate((
            ("# PACKING LIST:", pl_number, _CREAM),
            ("SHIPPING DATE:", date.fromisoformat(ship_date) if ship_date else None, _TEAL),
            (None, "EXPORT", None)), start=1):
        if lab:
            _cell(ws, f"U{r}", lab, fill)
        ws.merge_cells(f"V{r}:W{r}")
        _cell(ws, f"V{r}", val, _CREAM if r == 1 else None, fmt="mm-dd-yy" if r == 2 else None)
        _cell(ws, f"W{r}")
    _cell(ws, "U6", "SHIP TO:", _TEAL)
    for i, line in enumerate(SHIP_TO_DEFAULT):
        r = 6 + i
        ws.merge_cells(f"V{r}:W{r}")
        _cell(ws, f"V{r}", line)
        _cell(ws, f"W{r}")
    # Tabla
    ws.row_dimensions[10].height = 39.75
    for i, h in enumerate(HEAD, start=1):
        _cell(ws, f"{openpyxl.utils.get_column_letter(i)}10", h, _TEAL)
    ws.merge_cells("V10:W10")
    _cell(ws, "W10", None, _TEAL)
    r = 11
    first = r
    spans = []                     # (col, r0, r1, value) para combinar CUSTOMER / SHIP TO
    for g in groups:
        g0 = r
        for row in g["rows"]:
            vals = [g["inv"], g["po"], g["cust_po"], g["style"], g["color"], row["fabric"], g["description"], row["country"]]
            for i, v in enumerate(vals, start=1):
                _cell(ws, f"{openpyxl.utils.get_column_letter(i)}{r}", v if v not in ("", None) else None)
            for i, sz in enumerate(SIZES):
                col = openpyxl.utils.get_column_letter(9 + i)
                _cell(ws, f"{col}{r}", row["sizes"].get(sz) or None)
            _cell(ws, f"R{r}", f"=SUM(I{r}:Q{r})")
            for col in "STUVW":
                _cell(ws, f"{col}{r}")
            ws.row_dimensions[r].height = 16.9
            r += 1
        _cell(ws, f"S{g0}", g["boxes"])
        _cell(ws, f"T{g0}", g["pallets"])
        if r - 1 > g0:
            ws.merge_cells(f"S{g0}:S{r - 1}")
            ws.merge_cells(f"T{g0}:T{r - 1}")
        spans.append((g0, r - 1, g["customer"], g["ship_to"]))
    last = r - 1
    # CUSTOMER / SHIP TO combinados por tramos iguales (como el PL original).
    i = 0
    while i < len(spans):
        j = i
        while j + 1 < len(spans) and spans[j + 1][2:] == spans[i][2:]:
            j += 1
        r0, r1 = spans[i][0], spans[j][1]
        _cell(ws, f"U{r0}", spans[i][2] or None)
        _cell(ws, f"V{r0}", spans[i][3] or None)
        if r1 > r0:
            ws.merge_cells(f"U{r0}:U{r1}")
        ws.merge_cells(f"V{r0}:W{r1}")
        i = j + 1
    # Totales y pie
    tot = last + 2
    _cell(ws, f"S{tot}", f"=SUM(S{first}:S{last})", border=False)
    _cell(ws, f"T{tot}", f"=SUM(T{first}:T{last})", border=False)
    truck, eco = _truck_parts(export.get("truck"))
    foot = [("Transport Company:", export.get("transport_company")), ("Drivers Name", export.get("driver_name")),
            ("License Plate:", export.get("license_plate")), ("Truck:", truck), ("Signature", None),
            ("Security Seal#", export.get("seal_numbers")), ("No.Eco:", _digits_or_text(eco))]
    for k, (lab, val) in enumerate(foot):
        rr = tot + 1 + k
        _cell(ws, f"D{rr}", lab, _TEAL)
        ws.merge_cells(f"E{rr}:F{rr}")
        _cell(ws, f"E{rr}", val)
        _cell(ws, f"F{rr}")
    for k, (lab, val) in enumerate((("Total Units:", f"=SUM(R{first}:R{last})"), ("Total Boxes", f"=S{tot}"),
                                    ("Pallets Count", f"=T{tot}"), ("Released By:", None))):
        rr = tot + 3 + k
        ws.merge_cells(f"K{rr}:M{rr}")
        ws.merge_cells(f"N{rr}:R{rr}")
        _cell(ws, f"K{rr}", lab, _TEAL)
        _cell(ws, f"N{rr}", val, fmt="#,##0" if val else None)
        for col in "LMOPQR":
            _cell(ws, f"{col}{rr}")
    ws.freeze_panes = "A11"
    ws.page_setup.orientation = "landscape"
    ws.sheet_properties.pageSetUpPr.fitToPage = True
    ws.page_setup.fitToWidth = 1
    ws.page_setup.fitToHeight = 0
    bio = io.BytesIO()
    wb.save(bio)
    return bio.getvalue()


def file_name(pl_number: str, export: dict, suffix: str = "") -> str:
    d = export.get("date") or ""
    ship = f"{d[5:7]}-{d[8:10]}-{d[0:4]}" if d else ""
    base = re.sub(r"^PL([A-Z]+)\s*", r"PL \1 ", pl_number or "PL")
    return f"{base}{' - ' + suffix if suffix else ''} SHIPPING {ship}.xlsx".replace("  ", " ")


async def generate(export_id: str, shipment_id: str | None = None):
    """Devuelve (nombre_archivo, bytes, media_type, warnings, resumen)."""
    ctx = await build_context(export_id, shipment_id)
    exp, groups, warnings = ctx["export"], ctx["groups"], list(ctx["warnings"])
    by_code = {}
    for g in groups:
        by_code.setdefault(g["code"], []).append(g)
    files = []
    for code, gs in by_code.items():
        pl = pl_number_for(exp, code)
        if not pl:
            warnings.append(f"El export no tiene EXPORT# ni PL para {code}: el PL sale sin número")
            pl = f"PL{code} (SIN NUMERO)"
        suffix = f"#{gs[0]['order_number']}" if shipment_id else ""
        files.append((file_name(pl, exp, suffix), render_pl(pl, exp, gs)))
    summary = [{"order_number": g["order_number"], "source": g["source"], "boxes": g["boxes"], "pallets": g["pallets"],
                "units": sum(sum(r["sizes"].values()) for r in g["rows"])} for g in groups]
    if len(files) == 1:
        name, data = files[0]
        return name, data, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", warnings, summary
    bio = io.BytesIO()
    with zipfile.ZipFile(bio, "w", zipfile.ZIP_DEFLATED) as z:
        for name, data in files:
            z.writestr(name, data)
    d = exp.get("date") or ""
    return (f"PACKINGS EXPORT {exp.get('export_no') or ''} {d}.zip".replace("  ", " "), bio.getvalue(),
            "application/zip", warnings, summary)
