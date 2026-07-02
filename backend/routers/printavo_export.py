"""Reverse engine endpoints: customer PO PDF -> Printavo quote.

- POST /api/printavo-export/parse    upload a PDF, get parsed styles + validation
- GET  /api/printavo-export/contacts  search Printavo contacts (customer picker)
- POST /api/printavo-export/create    create one quote per confirmed style

The parse/contacts endpoints only read. Only /create writes to Printavo, and it
is driven by the reviewed+confirmed data the UI sends back (never automatic).
"""
from fastapi import APIRouter, HTTPException, Request, UploadFile, File

from deps import require_auth, require_admin, log_activity, logger
import printavo_client
from printavo_export import parse_pdf, build_quote_input

router = APIRouter(prefix="/api/printavo-export")


@router.post("/parse")
async def parse_po(request: Request, file: UploadFile = File(...)):
    await require_auth(request)
    if not (file.filename or "").lower().endswith(".pdf"):
        raise HTTPException(400, "El archivo debe ser un PDF")
    data = await file.read()
    engine = "text"
    try:
        records = parse_pdf(data)                         # Goodie text-based (Spencers/Tractor)
        if not records:
            # Image-based PO (Culture Kings/Spektrum) -> Gemini vision.
            from printavo_export import extract_spektrum
            records = await extract_spektrum(data)
            engine = "gemini"
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

    results = []
    for r in styles:
        design = r.get("design_num")
        try:
            quote_input = build_quote_input(r, contact_id, contact=contact, owner_id=owner_id)
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
