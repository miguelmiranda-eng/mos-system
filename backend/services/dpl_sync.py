"""La estación de empaque ALIMENTA el DPL (Digital Packing List de Google).

MOS es la fuente; la hoja de Google es el espejo. Cuando una orden tiene cajas
capturadas en la estación (routers/pack_station.py), su bloque de cajas en el
DPL lo manda MOS: lo que se edite a mano en ESE bloque se sobrescribe en la
siguiente sincronización (decisión del usuario 2026-10-21).

Qué se escribe en la pestaña PACKING LIST (se localiza por ETIQUETAS, no por
celdas fijas, así aguanta que el formato mueva filas o columnas):
  · bloque de cajas (entre el renglón de títulos con "Box Qty" y "TOTAL
    SHIPPED"): UN renglón por grupo de cajas iguales (mismo pallet, mismo
    contenido, misma caja y peso) → piezas por talla (total del renglón),
    Box Qty, Pcs per box, Box Dimension, Box Weight, Pallet #, Pallet Dimension.
    NO se tocan Store PO / Garment Type / Garment Color (los llena la gente)
    ni la columna TOTAL (fórmula).
  · Date Packed y Packer Name del encabezado.
Sólo valores: el formato de Google queda intacto.

Con qué cuenta: la "cuenta dueña" conectada en MOS (GSHEETS_OWNER_EMAIL,
default jesus.mercado@), con su token de Sheets (routers/gsheets.py).
Orden sin DPL: se crea desde el template (GSHEETS_PACKING_TEMPLATE_URL) como
archivo de la cuenta dueña y el link queda en orders.links (PACKING LIST).

Interruptor: PACK_DPL_SYNC=1 lo prende (APAGADO por default: una base local
copiada de prod trae el token real de la cuenta dueña). PACK_DPL_SYNC_TARGET=
<id de hoja> manda TODAS las escrituras a esa hoja (pruebas sobre una copia).

No se llama a Google en cada toque: schedule() junta los cambios y escribe
DEBOUNCE_S después del último. El resultado queda en pack_orders.dpl_sync.
"""
import asyncio
import logging
import os
import re
import uuid
from datetime import datetime, timezone

from starlette.concurrency import run_in_threadpool

from deps import db
from services import export_packing as pk

OWNER_EMAIL = os.environ.get("GSHEETS_OWNER_EMAIL", "jesus.mercado@prosper-mfg.com").strip()
TEMPLATE_URL = os.environ.get("GSHEETS_PACKING_TEMPLATE_URL", "").strip()
DEBOUNCE_S = 20
TAB = "PACKING LIST"
ID_RE = re.compile(r"/spreadsheets/d/([A-Za-z0-9_-]+)")
_pending: dict = {}       # order_id → asyncio.Task


def enabled() -> bool:
    return os.environ.get("PACK_DPL_SYNC", "").strip().lower() in ("1", "true", "on", "yes")


def _target_override() -> str:
    return os.environ.get("PACK_DPL_SYNC_TARGET", "").strip()


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _col(n: int) -> str:
    """0 → A, 25 → Z, 26 → AA."""
    s = ""
    n += 1
    while n:
        n, r = divmod(n - 1, 26)
        s = chr(65 + r) + s
    return s


def _num(v):
    f = float(v)
    return int(f) if f.is_integer() else f


# ── Qué se escribe ──────────────────────────────────────────────────────────

async def build_payload(order_id: str) -> dict:
    """Renglones del DPL a partir de las cajas de la estación (sin Google)."""
    boxes = [b async for b in db.pack_boxes.find({"order_id": order_id, "voided": {"$ne": True}}, {"_id": 0})
             .sort("created_at", 1)]
    doc = await db.pack_orders.find_one({"order_id": order_id}, {"_id": 0}) or {}
    pallet_dims = {p["no"]: p.get("dims") for p in doc.get("pallets") or []}
    groups: dict = {}
    for b in boxes:
        dims = b.get("dims") or {}
        key = (b.get("pallet_no"), tuple(sorted((b.get("sizes") or {}).items())),
               tuple(dims.get(k) for k in ("l", "w", "h")), b.get("weight"))
        g = groups.setdefault(key, {"count": 0, "box": b})
        g["count"] += 1
    rows = []
    for (pallet, sizes, _d, weight), g in groups.items():
        per_box = sum(q for _, q in sizes)
        b, pd = g["box"], pallet_dims.get(pallet)
        rows.append({
            "sizes": {s: q * g["count"] for s, q in sizes},
            "box_qty": g["count"], "pcs_per_box": per_box,
            "box_dims": "x".join(str(_num(b["dims"][k])) for k in ("l", "w", "h")) if b.get("dims") else "",
            "box_weight": _num(weight) if weight not in (None, "") else "",
            "pallet": pallet,
            "pallet_dims": "x".join(str(_num(pd[k])) for k in ("l", "w", "h")) if pd else "",
        })
    rows.sort(key=lambda r: (r["pallet"] or 0, -r["box_qty"]))
    last = boxes[-1]["created_at"][:10] if boxes else None
    packers = []
    for b in boxes:
        if b.get("packer") and b["packer"] not in packers:
            packers.append(b["packer"])
    return {"rows": rows, "date_packed": last, "packers": ", ".join(packers), "boxes": len(boxes),
            "pcs": sum(int(b.get("total") or 0) for b in boxes)}


# ── Google ──────────────────────────────────────────────────────────────────

async def _service():
    from routers.gsheets import _get_sheets_service   # lazy (evita ciclo)
    owner = await db.users.find_one({"email": {"$regex": f"^{re.escape(OWNER_EMAIL)}$", "$options": "i"}},
                                    {"_id": 0, "user_id": 1})
    svc = await _get_sheets_service(owner["user_id"]) if owner else None
    if not svc:
        raise RuntimeError(f"La cuenta {OWNER_EMAIL} no tiene Google conectado en MOS (con permiso de Sheets).")
    return svc


def _right_of(merges: list, r: int, c: int) -> int:
    """Columna donde va el dato de una etiqueta: la siguiente a su celda combinada."""
    for m in merges:
        if m.get("startRowIndex", 0) <= r < m.get("endRowIndex", 0) and m.get("startColumnIndex", 0) <= c < m.get("endColumnIndex", 0):
            return m.get("endColumnIndex", c + 1)
    return c + 1


async def _fill_header(svc, sid: str, tab: str, order: dict) -> None:
    """DPL recién creado: VENDOR PO, CLIENT PO, STORE NAME, Design Code y Client
    a la derecha de su etiqueta (como hacía el "Nuevo packing" de agosto)."""
    data_by_label = {"VENDOR PO": order.get("order_number"), "CLIENT PO": order.get("customer_po"),
                     "STORE NAME": order.get("branding"), "DESIGN CODE": order.get("design_#"),
                     "CLIENT": order.get("client")}
    meta = await run_in_threadpool(lambda: svc.spreadsheets().get(
        spreadsheetId=sid, ranges=[f"'{tab}'"], fields="sheets.merges").execute())
    merges = (meta.get("sheets") or [{}])[0].get("merges", [])
    vals = (await run_in_threadpool(lambda: svc.spreadsheets().values().get(
        spreadsheetId=sid, range=f"'{tab}'!A1:AH8").execute())).get("values", [])
    data, done = [], set()
    for r, row in enumerate(vals):
        for c, v in enumerate(row):
            label = str(v or "").strip().rstrip(":").upper()
            val = data_by_label.get(label)
            if val not in (None, "") and label not in done:
                done.add(label)
                data.append({"range": f"'{tab}'!{_col(_right_of(merges, r, c))}{r + 1}", "values": [[str(val)]]})
    if data:
        await run_in_threadpool(lambda: svc.spreadsheets().values().batchUpdate(
            spreadsheetId=sid, body={"valueInputOption": "USER_ENTERED", "data": data}).execute())


async def _create_from_template(svc, order: dict) -> str:
    """Copia el template como DPL nuevo de la cuenta dueña y lo liga a la orden."""
    m = ID_RE.search(TEMPLATE_URL)
    if not m:
        raise RuntimeError("La orden no tiene DPL y falta configurar GSHEETS_PACKING_TEMPLATE_URL.")
    tid = m.group(1)
    title = f"#{order.get('order_number')} - {(order.get('client') or '').strip()} PACKING LIST"
    meta = await run_in_threadpool(lambda: svc.spreadsheets().get(
        spreadsheetId=tid, fields="sheets.properties(sheetId,title,index)").execute())
    tabs = sorted([s["properties"] for s in meta.get("sheets", [])], key=lambda p: p.get("index", 0))
    new = await run_in_threadpool(lambda: svc.spreadsheets().create(
        body={"properties": {"title": title}}, fields="spreadsheetId,sheets.properties.sheetId").execute())
    new_id, blank = new["spreadsheetId"], new["sheets"][0]["properties"]["sheetId"]
    reqs = []
    for p in tabs:
        cp = await run_in_threadpool(lambda p=p: svc.spreadsheets().sheets().copyTo(
            spreadsheetId=tid, sheetId=p["sheetId"], body={"destinationSpreadsheetId": new_id}).execute())
        reqs.append({"updateSheetProperties": {"properties": {"sheetId": cp["sheetId"], "title": p["title"],
                                                              "index": p.get("index", 0)}, "fields": "title,index"}})
    reqs.append({"deleteSheet": {"sheetId": blank}})
    await run_in_threadpool(lambda: svc.spreadsheets().batchUpdate(spreadsheetId=new_id, body={"requests": reqs}).execute())
    await _fill_header(svc, new_id, tabs[0]["title"], order)
    url = f"https://docs.google.com/spreadsheets/d/{new_id}/edit"
    await db.orders.update_one({"order_id": order["order_id"]}, {"$push": {"links": {
        "url": url, "description": "PACKING LIST (MOS)", "created_at": _now(), "source": "pack_station"}}})
    await db.comments.insert_one({
        "comment_id": f"comment_{uuid.uuid4().hex[:12]}", "order_id": order["order_id"],
        "content": f"Packing list creado por la estación de empaque: {url}", "parent_id": None,
        "user_id": "system_pack_station", "user_name": "Estación de empaque", "mentions": [], "created_at": _now()})
    return new_id


def _layout(values: list, merges: list) -> dict:
    """Ubica por etiquetas: renglón de títulos, columnas, fin del bloque y encabezado."""
    def txt(v):
        return re.sub(r"\s+", " ", str(v or "")).strip().upper()
    head = next((r for r, row in enumerate(values) if any(txt(v) == "BOX QTY" for v in row)), None)
    if head is None:
        raise RuntimeError("No encontré el renglón de títulos (Box Qty) en la pestaña PACKING LIST.")
    cols = {}
    for c, v in enumerate(values[head]):
        t = txt(v)
        sz = pk.norm_size(t)
        if sz:
            cols.setdefault(f"size:{sz}", c)
        for key, label in (("box_qty", "BOX QTY"), ("pcs_per_box", "PCS PER BOX"), ("box_dims", "BOX DIMENSION"),
                           ("box_weight", "BOX WEIGHT"), ("pallet", "PALLET #"), ("pallet_dims", "PALLET DIMENSION")):
            if t.startswith(label):
                cols.setdefault(key, c)
    end = next((r for r in range(head + 1, len(values)) if any("TOTAL SHIPPED" in txt(v) for v in values[r])), None)
    if end is None:
        raise RuntimeError("No encontré TOTAL SHIPPED en la pestaña PACKING LIST.")

    def right_of(r, c):
        for m in merges:
            if m.get("startRowIndex", 0) <= r < m.get("endRowIndex", 0) and m.get("startColumnIndex", 0) <= c < m.get("endColumnIndex", 0):
                return m.get("endColumnIndex", c + 1)
        return c + 1
    header = {}
    for r in range(0, head):
        for c, v in enumerate(values[r] if r < len(values) else []):
            t = txt(v)
            if t.startswith("DATE PACKED"):
                header["date_packed"] = (r, right_of(r, c))
            elif t.startswith("PACKER NAME"):
                header["packers"] = (r, right_of(r, c))
    return {"head": head, "first": head + 1, "end": end, "cols": cols, "header": header}


async def sync(order_id: str, reason: str = "") -> dict:
    """Escribe el DPL de la orden. Devuelve y guarda el estado."""
    status = {"at": _now(), "ok": False, "reason": reason}
    try:
        if not enabled():
            raise RuntimeError("Sincronización con el DPL apagada (PACK_DPL_SYNC).")
        order = await db.orders.find_one({"order_id": order_id}, {"_id": 0, "order_id": 1, "order_number": 1,
                                                                  "client": 1, "links": 1, "customer_po": 1,
                                                                  "branding": 1, "design_#": 1})
        if not order:
            raise RuntimeError("Orden no encontrada")
        payload = await build_payload(order_id)
        svc = await _service()
        sheet_id = _target_override()
        if not sheet_id:
            m = ID_RE.search(pk.dpl_url(order) or "")
            sheet_id = m.group(1) if m else await _create_from_template(svc, order)
        meta = await run_in_threadpool(lambda: svc.spreadsheets().get(
            spreadsheetId=sheet_id, fields="sheets(properties(title),merges)").execute())
        tabs = {s["properties"]["title"]: s for s in meta.get("sheets", [])}
        tab = TAB if TAB in tabs else next(iter(tabs))
        values = (await run_in_threadpool(lambda: svc.spreadsheets().values().get(
            spreadsheetId=sheet_id, range=f"'{tab}'!A1:AH60").execute())).get("values", [])
        lay = _layout(values, tabs[tab].get("merges") or [])
        cap = lay["end"] - lay["first"]
        rows = payload["rows"]
        if len(rows) > cap:
            raise RuntimeError(f"El DPL sólo tiene {cap} renglones de cajas y hacen falta {len(rows)}.")
        # Rango por columna (de arriba a abajo del bloque): no toca A–C ni TOTAL.
        data = []
        for key, c in lay["cols"].items():
            col_vals = []
            for i in range(cap):
                r = rows[i] if i < len(rows) else None
                if r is None:
                    v = ""
                elif key.startswith("size:"):
                    sz = key[5:]
                    v = r["sizes"].get(sz, r["sizes"].get("UNI", "") if sz == "XS" else "")
                else:
                    v = r.get(key, "")
                col_vals.append([v if v is not None else ""])
            data.append({"range": f"'{tab}'!{_col(c)}{lay['first'] + 1}:{_col(c)}{lay['end']}", "values": col_vals})
        for key, (r, c) in lay["header"].items():
            if payload.get(key):
                data.append({"range": f"'{tab}'!{_col(c)}{r + 1}", "values": [[payload[key]]]})
        await run_in_threadpool(lambda: svc.spreadsheets().values().batchUpdate(
            spreadsheetId=sheet_id, body={"valueInputOption": "USER_ENTERED", "data": data}).execute())
        status.update(ok=True, sheet_id=sheet_id, rows=len(rows), boxes=payload["boxes"], pcs=payload["pcs"],
                      url=f"https://docs.google.com/spreadsheets/d/{sheet_id}/edit",
                      test_target=bool(_target_override()))
    except Exception as e:  # noqa: BLE001 — el estado lleva el motivo; la captura nunca se cae por Google
        msg = str(e)
        if "PERMISSION" in msg.upper() or " 403" in msg:
            msg = f"La cuenta {OWNER_EMAIL} no puede editar este DPL (compártelo con ella)."
        status["error"] = msg[:300]
        logging.warning(f"DPL sync {order_id}: {status['error']}")
    await db.pack_orders.update_one({"order_id": order_id}, {"$set": {"dpl_sync": status}}, upsert=True)
    return status


def schedule(order_id: str, reason: str = "") -> None:
    """Junta los cambios: escribe DEBOUNCE_S después del último."""
    if not enabled():
        return
    old = _pending.pop(order_id, None)
    if old and not old.done():
        old.cancel()

    async def run():
        try:
            await asyncio.sleep(DEBOUNCE_S)
            await sync(order_id, reason)
        except asyncio.CancelledError:
            pass
        finally:
            if _pending.get(order_id) is task:
                _pending.pop(order_id, None)
    task = asyncio.get_running_loop().create_task(run())
    _pending[order_id] = task


def pending(order_id: str) -> bool:
    t = _pending.get(order_id)
    return bool(t and not t.done())
