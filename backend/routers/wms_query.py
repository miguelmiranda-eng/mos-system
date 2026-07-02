"""WMS traceability queries with Gemini (admin level 5+ / supersu only).

Natural-language question -> Gemini routes it to a curated WMS query tool with
params -> Mongo runs the real query (precise, uses indexes, respects the app's
data quirks) -> Gemini summarizes the rows into text. Returns text + the raw rows
(verifiable table). Gemini never generates raw Mongo/queries — only picks a tool.
"""
import json
import re
import asyncio

from fastapi import APIRouter, HTTPException, Request

from deps import db, require_admin_level, log_activity, logger
import google.generativeai as genai
from printavo_export import _gemini_key, _json_from_text
from routers.import_router import SIZES_MAP

router = APIRouter(prefix="/api/wms")

_ROUTER_PROMPT = """Eres un enrutador de consultas de rastreabilidad de un almacen (WMS).
Traduce la pregunta del usuario a JSON con EXACTAMENTE estas llaves:
{"tool": <string>, "style": <string|null>, "color": <string|null>,
 "sizes": [<string>]|null, "location": <string|null>, "customer": <string|null>,
 "lot": <string|null>, "term": <string|null>}
tool es uno de:
- "find_boxes": ubicacion de cajas por style / SKU / LPN / color / talla, o "que hay en una locacion".
- "inventory": unidades en mano / totales.
- "movements": historial de movimientos de una caja / SKU / locacion.
- "receiving": ASN / recibos por SKU / style / lot.
Extrae CADA atributo por separado:
- style: el estilo / blank / SKU / LPN (ej "5000B", "GI5000B", "BOX-000001").
- color: el color (ej "white", "black").
- sizes: lista de tallas mencionadas (ej ["YL","L","XL"]). Mayusculas.
- location: locacion (ej "NA04-A13"). customer: cliente. lot: lot number.
- term: solo texto libre que no encaje en los campos anteriores.
Ej: "5000B white yl, l y xl" -> {"tool":"find_boxes","style":"5000B","color":"white","sizes":["YL","L","XL"],"location":null,"customer":null,"lot":null,"term":null}
Devuelve SOLO el JSON."""


def _esc(t):
    return re.escape(t or "")


def _norm_sizes(f):
    sizes = f.get("sizes") or ([f["size"]] if f.get("size") else [])
    out = []
    for s in sizes:
        s = str(s).strip().upper()
        out.append(SIZES_MAP.get(s, s))
    return out


def _box_filters(f):
    """AND list of Mongo conditions from the extracted attributes."""
    ands = []
    key = f.get("style") or f.get("sku") or f.get("term")
    if key:
        ands.append({"$or": [{"style": {"$regex": _esc(key), "$options": "i"}},
                             {"sku": {"$regex": _esc(key), "$options": "i"}},
                             {"box_id": {"$regex": _esc(key), "$options": "i"}}]})
    if f.get("color"):
        ands.append({"color": {"$regex": _esc(f["color"]), "$options": "i"}})
    sizes = _norm_sizes(f)
    if sizes:
        ands.append({"size": {"$in": sizes}})
    if f.get("location"):
        ands.append({"location": {"$regex": "^" + _esc(f["location"]), "$options": "i"}})
    if f.get("customer"):
        ands.append({"customer": {"$regex": _esc(f["customer"]), "$options": "i"}})
    return ands

_SUMMARY_PROMPT = """Eres un asistente de almacen. Responde en espanol, breve y preciso, la pregunta
del usuario usando UNICAMENTE los datos proporcionados (son resultados reales del WMS). No inventes
ubicaciones ni cantidades. Si no hay datos, dilo claramente. Si hay varias filas, resume lo clave
(donde esta, cuantas unidades, en que locaciones, fechas) — la tabla completa se muestra aparte."""

async def _tool_find_boxes(f):
    ands = _box_filters(f)
    q = {"$and": ands} if ands else {}
    proj = {"_id": 0, "box_id": 1, "sku": 1, "style": 1, "color": 1, "size": 1,
            "units": 1, "location": 1, "state": 1, "customer": 1}
    return await db.wms_boxes.find(q, proj).limit(200).to_list(200)


async def _tool_inventory(f):
    ands = _box_filters(f)   # same fields exist on wms_inventory
    q = {"$and": ands} if ands else {}
    proj = {"_id": 0, "sku": 1, "style": 1, "color": 1, "size": 1, "location": 1,
            "units_on_hand": 1, "units_allocated": 1, "total_boxes": 1, "po": 1, "customer": 1}
    return await db.wms_inventory.find(q, proj).limit(200).to_list(200)


async def _tool_receiving(f):
    ands = []
    key = f.get("style") or f.get("sku") or f.get("lot") or f.get("term")
    if key:
        ands.append({"$or": [{"sku": {"$regex": _esc(key), "$options": "i"}},
                             {"style": {"$regex": _esc(key), "$options": "i"}},
                             {"lot_number": {"$regex": _esc(key), "$options": "i"}}]})
    if f.get("color"):
        ands.append({"color": {"$regex": _esc(f["color"]), "$options": "i"}})
    sizes = _norm_sizes(f)
    if sizes:
        ands.append({"size": {"$in": sizes}})
    if f.get("customer"):
        ands.append({"customer": {"$regex": _esc(f["customer"]), "$options": "i"}})
    q = {"$and": ands} if ands else {}
    proj = {"_id": 0, "sku": 1, "style": 1, "color": 1, "size": 1, "lot_number": 1,
            "inv_location": 1, "total_units": 1, "received_by_name": 1, "created_at": 1, "customer": 1}
    return await db.wms_receiving.find(q, proj).sort("created_at", -1).limit(200).to_list(200)


async def _tool_movements(f):
    # Movements' `details` is semi-structured (varies by type); scan recent ones and
    # keep those whose details mention the key terms.
    keys = [str(v).lower() for v in [f.get("style"), f.get("sku"), f.get("term"),
            f.get("location"), f.get("lot")] if v]
    docs = await db.wms_movements.find(
        {}, {"_id": 0, "type": 1, "details": 1, "user_name": 1, "created_at": 1}
    ).sort("created_at", -1).limit(5000).to_list(5000)
    out = []
    for d in docs:
        blob = json.dumps(d.get("details"), default=str).lower()
        if not keys or all(k in blob for k in keys):
            out.append(d)
        if len(out) >= 100:
            break
    return out


_TOOLS = {"find_boxes": _tool_find_boxes, "inventory": _tool_inventory,
          "receiving": _tool_receiving, "movements": _tool_movements}


@router.post("/query")
async def wms_query(request: Request):
    user = await require_admin_level(request, 5)
    body = await request.json()
    question = (body.get("question") or "").strip()
    if not question:
        raise HTTPException(400, "Falta la pregunta")

    try:
        api_key = await _gemini_key()
    except Exception as e:
        raise HTTPException(400, f"[CONFIG] {e}")
    genai.configure(api_key=api_key)

    # 1. Route the question to a tool + params.
    try:
        router_model = genai.GenerativeModel("gemini-2.5-flash", system_instruction=_ROUTER_PROMPT)
        rr = await asyncio.to_thread(router_model.generate_content, question)
        route = _json_from_text(rr.text) or {}
    except Exception as e:
        logger.error(f"[wms-query] routing failed: {e}")
        raise HTTPException(500, f"[GEMINI] Falló el ruteo de la consulta: {e}")

    tool = route.get("tool")
    fn = _TOOLS.get(tool)
    if not fn:
        raise HTTPException(422, "No entendí qué consultar. Reformula (ubicación, historial, ASN o inventario).")
    rows = await fn(route)

    # 2. Summarize the real rows into a text answer.
    try:
        sm = genai.GenerativeModel("gemini-2.5-flash", system_instruction=_SUMMARY_PROMPT)
        payload = f"Pregunta: {question}\nDatos WMS ({len(rows)} filas):\n{json.dumps(rows, default=str, ensure_ascii=False)[:14000]}"
        sr = await asyncio.to_thread(sm.generate_content, payload)
        answer = (sr.text or "").strip()
    except Exception as e:
        logger.error(f"[wms-query] summary failed: {e}")
        answer = f"Se encontraron {len(rows)} resultados (ver tabla)."

    await log_activity(user, "wms_query", {"question": question, "tool": tool, "count": len(rows)})
    params = {k: route.get(k) for k in ("style", "color", "sizes", "location", "customer", "lot", "term") if route.get(k)}
    return {"answer": answer, "tool": tool, "params": params, "count": len(rows), "rows": rows}
