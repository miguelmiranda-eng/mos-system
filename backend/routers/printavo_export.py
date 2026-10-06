"""Reverse engine endpoints: customer PO PDF -> Printavo quote.

- POST /api/printavo-export/parse    upload a PDF, get parsed styles + validation
- GET  /api/printavo-export/contacts  search Printavo contacts (customer picker)
- POST /api/printavo-export/create    create one quote per confirmed style

The parse/contacts endpoints only read. Only /create writes to Printavo, and it
is driven by the reviewed+confirmed data the UI sends back (never automatic).
"""
import asyncio
from fastapi import APIRouter, HTTPException, Request, UploadFile, File

from deps import require_auth, require_admin, log_activity, logger
import printavo_client
from printavo_export import parse_pdf, build_quote_input

router = APIRouter(prefix="/api/printavo-export")


def parse_po_bytes(data: bytes, plantillas: list = None) -> tuple:
    """Run the deterministic parsers over a PDF. Returns (records, engine).

    Shared by the upload endpoint and the Gmail intake so both channels
    classify a PDF with exactly the same rules. El orden es deliberado:

      1. Goodie (lector escrito a mano, el 95% de lo que entra)
      2. Culture Kings/Spektrum (lector escrito a mano)
      3. plantillas de cliente (services/po_templates), SOLO las activas

    Los dos primeros no se tocan: llevan meses corriendo y estan cubiertos por
    tests/smoke_po_golden.py. Las plantillas van al final para que no puedan
    cambiar como se lee un PDF que hoy ya se lee bien — a lo mas atrapan uno que
    antes nadie reconocia.

    `plantillas` se recibe como argumento en vez de consultarse aqui porque esta
    funcion corre en un hilo aparte (run_in_threadpool) y no puede usar la base.
    Quien llama la pasa; sin ella el comportamiento es el de siempre.
    """
    records = parse_pdf(data)                         # Goodie text-based (Spencers/Tractor)
    if records:
        return records, "text"
    # Culture Kings/Spektrum con capa de texto -> parser DETERMINISTA (sin IA).
    from printavo_export import parse_culturekings_pdf
    records = parse_culturekings_pdf(data)
    if records:
        return records, "text-ck"

    for plantilla in (plantillas or []):
        if not plantilla.get("activa"):
            continue
        from services.po_templates import huella_definida
        if not huella_definida(plantilla):
            # Sin huella acepta cualquier PDF; vale mas no leer que inventar.
            logger.warning(f"[printavo-export] plantilla {plantilla.get('id')} activa SIN huella: se salta")
            continue
        try:
            import io as _io
            import pdfplumber as _pdfplumber
            from routers.import_router import SIZES_MAP as _SIZES
            from services.po_templates import leer_pdf as _leer
            with _pdfplumber.open(_io.BytesIO(data)) as pdf:
                records = _leer(pdf, plantilla, _SIZES)
        except Exception as e:                        # noqa: BLE001
            # Una plantilla rota no puede tumbar la lectura de los demas PDFs ni
            # del resto de las plantillas: se anota y se sigue con la siguiente.
            logger.error(f"[printavo-export] plantilla {plantilla.get('id')} falló: {e}")
            continue
        if records:
            return records, f"plantilla:{plantilla.get('id')}"

    return [], "none"


async def plantillas_activas() -> list:
    """Las plantillas de cliente encendidas, para pasarselas a parse_po_bytes."""
    from deps import db
    try:
        return await db.po_templates.find({"activa": True}, {"_id": 0}).to_list(length=100)
    except Exception as e:                            # noqa: BLE001
        logger.error(f"[printavo-export] no se pudieron leer las plantillas: {e}")
        return []


@router.post("/parse")
async def parse_po(request: Request, file: UploadFile = File(...)):
    await require_auth(request)
    if not (file.filename or "").lower().endswith(".pdf"):
        raise HTTPException(400, "El archivo debe ser un PDF")
    data = await file.read()
    try:
        records, engine = parse_po_bytes(data, await plantillas_activas())
    except Exception as e:
        logger.error(f"[printavo-export] parse error: {e}")
        raise HTTPException(500, f"No se pudo leer el PDF: {e}")
    if not records:
        raise HTTPException(422, "No se detectaron estilos en el PDF (formato no reconocido)")
    return {"count": len(records), "styles": records, "engine": engine}


@router.get("/contacts")
async def search_contacts(request: Request, q: str = ""):
    await require_auth(request)
    if not printavo_client.is_configured():
        raise HTTPException(400, "Credenciales de Printavo no configuradas")
    if not q or len(q.strip()) < 2:
        return {"contacts": []}
    return {"contacts": await printavo_client.search_contacts(q.strip())}


async def create_quotes_for(user: dict, contact_id: str, styles: list) -> dict:
    """Create one Printavo quote per style. Used by POST /create and by the
    Gmail intake confirm; the caller is responsible for auth + validation."""

    # Fetch the chosen contact once for its customer billing/shipping addresses.
    try:
        contact = await printavo_client.get_contact(contact_id)
    except Exception as e:
        logger.error(f"[printavo-export] get_contact failed: {e}")
        contact = None

    # Attribute the quotes to the MOS user who created them (matched to their
    # Printavo user by email). Falls back to the token's default owner if unmatched.
    owner_id = None
    owner_email = (user or {}).get("email")
    try:
        owner_id = await printavo_client.find_user_id_by_email(owner_email)
        if not owner_id:
            logger.warning(f"[printavo-export] no Printavo user for {owner_email}; quote uses default owner")
    except Exception as e:
        logger.error(f"[printavo-export] owner lookup failed: {e}")

    # Resolve the "Screen Printing" category id once (line-item category va SIEMPRE
    # en las lineas de impresion). Si no se resuelve, las quotes se crean igual sin
    # categoria en vez de romper la mutation.
    category_id = None
    try:
        category_id = await printavo_client.find_category_id_by_name("Screen Printing")
        if not category_id:
            logger.warning("[printavo-export] categoria 'Screen Printing' no encontrada; line items sin categoria")
    except Exception as e:
        logger.error(f"[printavo-export] category lookup failed: {e}")

    results = []
    for i, r in enumerate(styles):
        if i > 0:
            await asyncio.sleep(0.8)
        design = r.get("design_num")
        try:
            quote_input = build_quote_input(r, contact_id, contact=contact, owner_id=owner_id,
                                            category_id=category_id)
            created = await printavo_client.create_quote(quote_input)
            results.append({"design_num": design, "ok": True,
                            "quote_id": created.get("id"), "visual_id": created.get("visualId")})
            logger.info(f"[printavo-export] created quote {created.get('visualId')} for {design}")
        except Exception as e:
            logger.error(f"[printavo-export] create failed for {design}: {e}")
            results.append({"design_num": design, "ok": False, "error": str(e)[:300]})

    await log_activity(user, "printavo_export_create",
                       {"contact_id": contact_id, "created": [x for x in results if x["ok"]]})
    return {"results": results,
            "created": sum(1 for x in results if x["ok"]),
            "failed": sum(1 for x in results if not x["ok"]),
            "owner_email": owner_email,
            "owner_matched": bool(owner_id)}


@router.post("/create")
async def create_quotes(request: Request):
    user = await require_admin(request)
    if not printavo_client.is_configured():
        raise HTTPException(400, "Credenciales de Printavo no configuradas")
    body = await request.json()
    contact_id = (body.get("contact_id") or "").strip()
    styles = body.get("styles") or []
    if not contact_id:
        raise HTTPException(400, "Falta el contacto/cliente de Printavo")
    if not styles:
        raise HTTPException(400, "No hay estilos para crear")
    return await create_quotes_for(user, contact_id, styles)
