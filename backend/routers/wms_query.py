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

router = APIRouter(prefix="/api/wms")

_ROUTER_PROMPT = """Eres un enrutador de consultas de rastreabilidad de un almacen (WMS).
Traduce la pregunta del usuario a JSON con EXACTAMENTE estas llaves:
{"tool": <string>, "term": <string|null>, "location": <string|null>}
donde tool es uno de:
- "find_boxes": ubicacion de cajas por SKU / style / LPN (box_id), o "que hay en una locacion".
- "inventory": unidades en mano / totales por SKU / style / locacion.
- "movements": historial de movimientos de una caja / SKU / locacion.
- "receiving": ASN / recibos de un SKU / style / lot number.
"term" = el SKU, style, LPN o lot mencionado (sin etiquetas). "location" = la locacion si aplica.
Devuelve SOLO el JSON, sin texto extra."""

_SUMMARY_PROMPT = """Eres un asistente de almacen. Responde en espanol, breve y preciso, la pregunta
del usuario usando UNICAMENTE los datos proporcionados (son resultados reales del WMS). No inventes
ubicaciones ni cantidades. Si no hay datos, dilo claramente. Si hay varias filas, resume lo clave
(donde esta, cuantas unidades, en que locaciones, fechas) — la tabla completa se muestra aparte."""

_ESC = lambda t: re.escape(t or "")


async def _tool_find_boxes(term, location):
    q = {}
    if term:
        q["$or"] = [{"sku": {"$regex": _ESC(term), "$options": "i"}},
                    {"style": {"$regex": _ESC(term), "$options": "i"}},
                    {"box_id": {"$regex": _ESC(term), "$options": "i"}}]
    if location:
        q["location"] = {"$regex": "^" + _ESC(location), "$options": "i"}
    proj = {"_id": 0, "box_id": 1, "sku": 1, "style": 1, "color": 1, "size": 1,
            "units": 1, "location": 1, "state": 1, "customer": 1}
    return await db.wms_boxes.find(q, proj).limit(150).to_list(150)


async def _tool_inventory(term, location):
    q = {}
    if term:
        q["$or"] = [{"sku": {"$regex": _ESC(term), "$options": "i"}},
                    {"style": {"$regex": _ESC(term), "$options": "i"}}]
    if location:
        q["location"] = {"$regex": "^" + _ESC(location), "$options": "i"}
    proj = {"_id": 0, "sku": 1, "style": 1, "color": 1, "size": 1, "location": 1,
            "units_on_hand": 1, "units_allocated": 1, "total_boxes": 1, "po": 1, "customer": 1}
    return await db.wms_inventory.find(q, proj).limit(150).to_list(150)


async def _tool_receiving(term, location):
    q = {}
    if term:
        q["$or"] = [{"sku": {"$regex": _ESC(term), "$options": "i"}},
                    {"style": {"$regex": _ESC(term), "$options": "i"}},
                    {"lot_number": {"$regex": _ESC(term), "$options": "i"}}]
    proj = {"_id": 0, "sku": 1, "style": 1, "color": 1, "size": 1, "lot_number": 1,
            "inv_location": 1, "total_units": 1, "received_by_name": 1, "created_at": 1, "customer": 1}
    return await db.wms_receiving.find(q, proj).sort("created_at", -1).limit(150).to_list(150)


async def _tool_movements(term, location):
    # Movements' `details` is semi-structured (varies by type); scan recent ones and
    # keep those whose details mention the term/location.
    key = (term or location or "").lower()
    docs = await db.wms_movements.find(
        {}, {"_id": 0, "type": 1, "details": 1, "user_name": 1, "created_at": 1}
    ).sort("created_at", -1).limit(4000).to_list(4000)
    out = []
    for d in docs:
        if not key or key in json.dumps(d.get("details"), default=str).lower():
            out.append(d)
        if len(out) >= 80:
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
    rows = await fn(route.get("term"), route.get("location"))

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
    return {"answer": answer, "tool": tool,
            "params": {"term": route.get("term"), "location": route.get("location")},
            "count": len(rows), "rows": rows}
