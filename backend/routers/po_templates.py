"""API de las plantillas de PDF: dar de alta un cliente nuevo señalando datos con el mouse.

COMO FUNCIONA LA PANTALLA
─────────────────────────
1. Se sube el work order del cliente -> POST /borrador. El servidor guarda el PDF
   como borrador y devuelve, pagina por pagina, TODAS las palabras con sus
   coordenadas. La pantalla las pinta posicionadas: no es una imagen del PDF, son
   las palabras mismas, asi que el usuario hace clic EXACTAMENTE sobre lo que el
   motor va a leer. Sin rasterizador y sin mandar imagenes.
2. Cada vez que el usuario señala algo -> POST /borrador/{id}/probar con la
   plantilla a medio armar. Devuelve lo que el motor saca HOY con esas reglas, que
   es la vista previa en vivo.
3. Antes de activarla -> POST /{id}/validar con un SEGUNDO PDF del mismo cliente.
   Una plantilla que sale bien en el PDF con el que se armo no prueba nada; la que
   sale bien en otro distinto si.

POR QUE EL BORRADOR VIVE EN LA BASE
───────────────────────────────────
La vista previa se pide en cada clic. Volver a subir el PDF cada vez seria lento,
y guardarlo en memoria del proceso se pierde al reiniciar y no sirve si algun dia
hay mas de un worker. Un documento con los bytes (~200 KB) resuelve las tres.
Los borradores se limpian solos a los 7 dias.

QUIEN PUEDE
───────────
Leer y armar: cualquier admin. ACTIVAR una plantilla: nivel 5. Una plantilla mal
armada crea quotes malas en Printavo de forma automatica, asi que publicarla no
es lo mismo que experimentar con ella.
"""
import io
from datetime import datetime, timedelta, timezone

import pdfplumber
from fastapi import APIRouter, File, HTTPException, Request, UploadFile

from deps import db, log_activity, logger, require_admin, require_admin_level
from routers.import_router import SIZES_MAP
from printavo_export import QUOTE_POR_OMISION, build_quote_input
from services.po_templates import leer_pdf

router = APIRouter(prefix="/api/po-templates")

# Los borradores son material de trabajo, no historia: se tiran solos.
DIAS_BORRADOR = 7
# Tope de palabras que se mandan al navegador por pagina. Un work order ronda las
# 400; el tope es para que un PDF raro no tumbe la pantalla.
MAX_PALABRAS = 4000


def _ahora():
    return datetime.now(timezone.utc).isoformat()


def _palabras_de(page):
    """Las palabras que la pantalla pinta y sobre las que se hace clic. Se
    redondea a un decimal: mas precision no cambia nada visualmente y el
    documento pesa la mitad."""
    out = []
    for w in page.extract_words()[:MAX_PALABRAS]:
        out.append({
            "t": w["text"],
            "x": round(w["x0"], 1),
            "x1": round(w["x1"], 1),
            "y": round(w["top"], 1),
            "y1": round(w["bottom"], 1),
        })
    return out


async def _borrador(draft_id: str) -> dict:
    doc = await db.po_template_drafts.find_one({"draft_id": draft_id})
    if not doc:
        raise HTTPException(404, "El borrador ya no existe; vuelve a subir el PDF")
    return doc


# ── Borrador: subir el PDF y obtener sus palabras ────────────────────────────
@router.post("/borrador")
async def crear_borrador(request: Request, file: UploadFile = File(...)):
    user = await require_admin(request)
    if not (file.filename or "").lower().endswith(".pdf"):
        raise HTTPException(400, "El archivo debe ser un PDF")
    data = await file.read()
    try:
        with pdfplumber.open(io.BytesIO(data)) as pdf:
            paginas = [{
                "ancho": round(p.width, 1),
                "alto": round(p.height, 1),
                "palabras": _palabras_de(p),
            } for p in pdf.pages]
    except Exception as e:                            # noqa: BLE001
        logger.error(f"[po-templates] no se pudo leer el PDF: {e}")
        raise HTTPException(400, f"No se pudo leer el PDF: {str(e)[:150]}")

    if not paginas:
        raise HTTPException(422, "El PDF no tiene páginas")
    if not any(p["palabras"] for p in paginas):
        raise HTTPException(422, "El PDF no tiene capa de texto (parece escaneado): "
                                 "no se puede mapear señalando palabras")

    import uuid
    draft_id = uuid.uuid4().hex[:16]
    await db.po_template_drafts.insert_one({
        "draft_id": draft_id,
        "filename": file.filename,
        "pdf": data,
        "created_at": _ahora(),
        "created_by": user.get("email"),
    })
    # Limpieza perezosa: cada alta tira los borradores viejos. No hace falta un job.
    corte = (datetime.now(timezone.utc) - timedelta(days=DIAS_BORRADOR)).isoformat()
    await db.po_template_drafts.delete_many({"created_at": {"$lt": corte}})

    return {"draft_id": draft_id, "filename": file.filename, "paginas": paginas}


@router.post("/borrador/{draft_id}/probar")
async def probar_borrador(request: Request, draft_id: str):
    """Vista previa en vivo: corre la plantilla a medio armar sobre el PDF del
    borrador y devuelve lo que saldria."""
    await require_admin(request)
    doc = await _borrador(draft_id)
    plantilla = await request.json()
    return _correr(plantilla, doc["pdf"])


def _correr(plantilla: dict, data: bytes) -> dict:
    try:
        with pdfplumber.open(io.BytesIO(data)) as pdf:
            total = len(pdf.pages)
            recs = leer_pdf(pdf, plantilla or {}, SIZES_MAP)
    except Exception as e:                            # noqa: BLE001
        logger.error(f"[po-templates] fallo al correr la plantilla: {e}")
        raise HTTPException(400, f"La plantilla falló: {str(e)[:200]}")
    # Vista previa de la QUOTE con el primer estilo: es lo que vuelve editable la
    # estructura de salida — se ve el efecto de cada cambio sin crear nada en
    # Printavo. Si la plantilla de salida esta mal escrita se reporta el motivo
    # en vez de tumbar la vista previa de la lectura, que es independiente.
    quote = None
    if recs:
        try:
            q = build_quote_input({**recs[0], "_quote_tpl": (plantilla or {}).get("quote")},
                                  "vista-previa")
            quote = {"nickname": q.get("nickname"),
                     "grupos": [[li.get("description") for li in g.get("lineItems", [])]
                                for g in q.get("lineItemGroups", [])]}
        except Exception as e:                        # noqa: BLE001
            quote = {"error": str(e)[:200]}
    return {
        "paginas": total,
        "estilos": len(recs),
        "records": recs,
        "quote": quote,
        # Lo que le falta para poder crear sin revisión, con el mismo criterio
        # que usa el intake. Se calcula aquí para que la pantalla no lo duplique.
        "pendientes": sorted({f for r in recs for f in (r.get("flags") or [])}),
    }


# ── CRUD de plantillas ───────────────────────────────────────────────────────
@router.get("")
async def listar(request: Request):
    await require_admin(request)
    cur = db.po_templates.find({}, {"_id": 0}).sort("nombre", 1)
    return {"plantillas": await cur.to_list(length=200)}


@router.post("")
async def crear(request: Request):
    user = await require_admin(request)
    body = await request.json()
    nombre = (body.get("nombre") or "").strip()
    if not nombre:
        raise HTTPException(400, "Ponle nombre a la plantilla")
    import uuid
    tid = uuid.uuid4().hex[:12]
    doc = {
        "template_id": tid,
        "id": tid,                       # el motor lo copia al registro como `plantilla`
        "nombre": nombre,
        "activa": False,                 # nace apagada SIEMPRE
        "huella": body.get("huella") or {},
        "campos": body.get("campos") or {},
        "tallas": body.get("tallas") or {"tipo": "rejilla", "rotulo_tallas": "SIZE",
                                         "rotulo_cantidades": "QTY"},
        # Nace con la estructura de salida de siempre, escrita como dato: asi un
        # cliente nuevo ya produce una quote valida y ademas se puede ver y
        # cambiar desde la pantalla.
        "quote": body.get("quote") or QUOTE_POR_OMISION,
        "validada_con": None,            # nombre del 2o PDF con el que se probó
        "created_at": _ahora(),
        "created_by": user.get("email"),
        "updated_at": _ahora(),
    }
    await db.po_templates.insert_one(dict(doc))
    await log_activity(user, "po_template_create", {"template_id": tid, "nombre": nombre})
    doc.pop("_id", None)
    return doc


@router.put("/{tid}")
async def actualizar(request: Request, tid: str):
    user = await require_admin(request)
    body = await request.json()
    cambios = {k: body[k] for k in ("nombre", "huella", "campos", "tallas", "quote") if k in body}
    if not cambios:
        raise HTTPException(400, "Nada que actualizar")
    # Tocar las reglas invalida la validación: lo que se probó ya no es esto.
    # Tocar la LECTURA invalida la validacion (lo que se probo ya no es esto).
    # Tocar la SALIDA no: la validacion comprueba que el PDF se lea, y como se
    # vea la quote no cambia eso.
    if {"huella", "campos", "tallas"} & set(cambios):
        cambios["validada_con"] = None
        cambios["activa"] = False
    cambios["updated_at"] = _ahora()
    res = await db.po_templates.update_one({"template_id": tid}, {"$set": cambios})
    if not res.matched_count:
        raise HTTPException(404, "No existe")
    await log_activity(user, "po_template_update", {"template_id": tid, "campos": list(cambios)})
    return await db.po_templates.find_one({"template_id": tid}, {"_id": 0})


@router.delete("/{tid}")
async def borrar(request: Request, tid: str):
    user = await require_admin_level(request, 5)
    res = await db.po_templates.delete_one({"template_id": tid})
    if not res.deleted_count:
        raise HTTPException(404, "No existe")
    await log_activity(user, "po_template_delete", {"template_id": tid})
    return {"status": "borrada"}


@router.post("/{tid}/validar")
async def validar(request: Request, tid: str, file: UploadFile = File(...)):
    """Prueba la plantilla contra un SEGUNDO PDF del mismo cliente.

    Es el requisito para poder activarla: salir bien en el PDF con el que se armó
    no prueba nada — las reglas pudieron quedar pegadas a ese archivo."""
    user = await require_admin(request)
    plantilla = await db.po_templates.find_one({"template_id": tid}, {"_id": 0})
    if not plantilla:
        raise HTTPException(404, "No existe")
    if not (file.filename or "").lower().endswith(".pdf"):
        raise HTTPException(400, "El archivo debe ser un PDF")
    res = _correr(plantilla, await file.read())
    ok = res["estilos"] > 0
    await db.po_templates.update_one(
        {"template_id": tid},
        {"$set": {"validada_con": file.filename if ok else None, "updated_at": _ahora()}})
    await log_activity(user, "po_template_validate",
                       {"template_id": tid, "archivo": file.filename, "estilos": res["estilos"]})
    return {**res, "valida": ok}


@router.post("/{tid}/activar")
async def activar(request: Request, tid: str):
    """Encender o apagar una plantilla. Encenderla es nivel 5: a partir de ese
    momento lee POs de verdad y puede terminar creando quotes en Printavo."""
    user = await require_admin_level(request, 5)
    body = await request.json()
    activa = bool(body.get("activa"))
    plantilla = await db.po_templates.find_one({"template_id": tid}, {"_id": 0})
    if not plantilla:
        raise HTTPException(404, "No existe")
    if activa and not plantilla.get("validada_con"):
        raise HTTPException(400, "Pruébala contra un segundo PDF antes de activarla")
    if activa and not (plantilla.get("campos") or {}).get("design_num"):
        raise HTTPException(400, "Falta señalar el número de diseño: sin eso no hay estilo")
    await db.po_templates.update_one({"template_id": tid},
                                     {"$set": {"activa": activa, "updated_at": _ahora()}})
    await log_activity(user, "po_template_activate", {"template_id": tid, "activa": activa})
    return {"template_id": tid, "activa": activa}
