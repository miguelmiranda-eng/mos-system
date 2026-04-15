"""Reports routes: Extended history consolidator and PDF generation."""
from fastapi import APIRouter, HTTPException, Request, Response
from deps import db, require_auth, require_admin, log_activity, logger
from datetime import datetime, timezone
import io, base64, uuid
from reportlab.lib.pagesizes import letter
from reportlab.lib import colors
from reportlab.platypus import SimpleDocTemplate, Table, TableStyle, Paragraph, Spacer, PageBreak, HRFlowable
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.units import inch

router = APIRouter(prefix="/api/reports")

@router.get("/order-history/{order_id}")
async def get_order_history_consolidated(order_id: str, request: Request):
    """Consolidate all history records for a specific order."""
    await require_auth(request)
    
    # 1. Get Order Info
    order = await db.orders.find_one({"order_id": order_id}, {"_id": 0})
    if not order:
        # Try search by order_number
        order = await db.orders.find_one({"order_number": order_id}, {"_id": 0})
    
    if not order:
        raise HTTPException(status_code=404, detail="Order not found")
    
    oid = order.get("order_id")
    onum = order.get("order_number")
    
    events = []
    
    # 2. Activity Logs
    activity_query = {
        "$or": [
            {"details.order_id": oid},
            {"details.order_number": onum},
            {"details.order": oid},
            {"details.order": onum}
        ]
    }
    activities = await db.activity_logs.find(activity_query, {"_id": 0}).to_list(1000)
    for a in activities:
        events.append({
            "timestamp": a.get("timestamp"),
            "type": "activity",
            "action": a.get("action"),
            "user": a.get("user_name") or a.get("user_email") or "System",
            "description": a.get("action").replace("_", " ").title(),
            "details": a.get("details", {})
        })
        
    # 3. Production Logs
    production = await db.production_logs.find({"order_id": oid}, {"_id": 0}).to_list(1000)
    for p in production:
        events.append({
            "timestamp": p.get("created_at"),
            "type": "production",
            "action": "register_production",
            "user": p.get("operator") or p.get("user_name") or "System",
            "description": f"Producción registrada: {p.get('quantity_produced')} pcs en {p.get('machine')}",
            "details": p
        })
        
    # 4. WMS Movements
    wms_query = {
        "$or": [
            {"details.order_id": oid},
            {"details.order_number": onum}
        ]
    }
    movements = await db.wms_movements.find(wms_query, {"_id": 0}).to_list(1000)
    for m in movements:
        events.append({
            "timestamp": m.get("created_at"),
            "type": "wms",
            "action": m.get("type"),
            "user": m.get("user_name") or "System",
            "description": f"WMS: {m.get('type').replace('_', ' ').title()}",
            "details": m.get("details", {})
        })
        
    # 5. Comments
    comments = await db.comments.find({"order_id": oid}, {"_id": 0}).to_list(1000)
    for c in comments:
        events.append({
            "timestamp": c.get("created_at"),
            "type": "comment",
            "action": "add_comment",
            "user": c.get("user_name"),
            "description": "Comentario añadido",
            "details": {"content": c.get("content")}
        })
        
    # Sort events by timestamp descending
    events.sort(key=lambda x: x.get("timestamp", ""), reverse=True)
    
    return {
        "order": order,
        "history": events
    }

@router.post("/order-history/{order_id}/pdf")
async def generate_order_history_pdf(order_id: str, request: Request):
    """Generate a specialized PDF report for an order's history."""
    user = await require_auth(request)
    data = await get_order_history_consolidated(order_id, request)
    order = data.get("order")
    history = data.get("history")
    
    output = io.BytesIO()
    doc = SimpleDocTemplate(output, pagesize=letter, leftMargin=40, rightMargin=40, topMargin=40, bottomMargin=40)
    styles = getSampleStyleSheet()
    
    # Custom styles
    title_style = ParagraphStyle('ReportTitle', parent=styles['Title'], fontSize=18, spaceAfter=20)
    header_style = ParagraphStyle('SectionHeader', parent=styles['Heading2'], fontSize=12, color=colors.HexColor('#1a1a2e'), spaceBefore=10, spaceAfter=5)
    normal_style = styles['Normal']
    timestamp_style = ParagraphStyle('Timestamp', parent=styles['Normal'], fontSize=8, textColor=colors.grey)
    event_style = ParagraphStyle('Event', parent=styles['Normal'], fontSize=9, spaceBefore=2)
    
    elements = []
    
    # 1. Header
    elements.append(Paragraph(f"REPORTE HISTÓRICO DE ORDEN - {order.get('order_number')}", title_style))
    elements.append(Paragraph(f"Generado por: {user.get('name')} el {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}", timestamp_style))
    elements.append(Spacer(1, 0.2 * inch))
    
    # 2. Executive Summary
    elements.append(Paragraph("Resumen de Orden", header_style))
    summary_data = [
        ["Cliente:", order.get("client", "N/A"), "PO Cliente:", order.get("customer_po", "N/A")],
        ["Estilo:", order.get("style", "N/A"), "Color:", order.get("color", "N/A")],
        ["Cantidad Total:", str(order.get("quantity", 0)), "Fecha Entrega:", order.get("due_date", "N/A")],
        ["Estado Actual:", order.get("board", "N/A"), "Estado Prod.:", order.get("production_status", "N/A")]
    ]
    t_summary = Table(summary_data, colWidths=[1.2*inch, 1.8*inch, 1.2*inch, 1.8*inch])
    t_summary.setStyle(TableStyle([
        ('FONTNAME', (0,0), (0,-1), 'Helvetica-Bold'),
        ('FONTNAME', (2,0), (2,-1), 'Helvetica-Bold'),
        ('FONTSIZE', (0,0), (-1,-1), 9),
        ('GRID', (0,0), (-1,-1), 0.5, colors.grey),
        ('VALIGN', (0,0), (-1,-1), 'MIDDLE'),
        ('BACKGROUND', (0,0), (0,-1), colors.HexColor('#f5f5f5')),
        ('BACKGROUND', (2,0), (2,-1), colors.HexColor('#f5f5f5'))
    ]))
    elements.append(t_summary)
    elements.append(Spacer(1, 0.3 * inch))
    
    # 3. Timeline
    elements.append(Paragraph("Historial Cronológico (Timeline)", header_style))
    elements.append(HRFlowable(width="100%", thickness=1, color=colors.HexColor('#1a1a2e'), spaceAfter=10))
    
    for event in history:
        ts = event.get("timestamp", "")
        if ts:
            ts_formatted = datetime.fromisoformat(ts.replace("Z", "+00:00")).strftime("%Y-%m-%d %H:%M:%S")
        else:
            ts_formatted = "N/A"
            
        u = event.get("user", "System")
        desc = event.get("description", "")
        e_type = event.get("type", "").upper()
        
        # Color coding by type
        type_color = colors.grey
        if e_type == "PRODUCTION": type_color = colors.HexColor('#10b981') # Emerald
        elif e_type == "WMS": type_color = colors.HexColor('#3b82f6')      # Blue
        elif e_type == "COMMENT": type_color = colors.HexColor('#f59e0b')  # Amber
        elif e_type == "ACTIVITY": type_color = colors.HexColor('#6366f1') # Indigo
        
        # Event Header Row
        p_header = Paragraph(f"<b>[{e_type}]</b> - {ts_formatted} - <b>{u}</b>", timestamp_style)
        elements.append(p_header)
        
        # Event Description
        elements.append(Paragraph(desc, event_style))
        
        # Extra details if available
        details = event.get("details", {})
        details_txt = ""
        if e_type == "COMMENT":
            details_txt = f"<i>\"{details.get('content', '')}\"</i>"
        elif e_type == "ACTIVITY" and event.get("action") == "update_order":
            fields = details.get("changed_fields", [])
            if fields:
                details_txt = f"Campos modificados: {', '.join(fields)}"
        
        if details_txt:
            elements.append(Paragraph(details_txt, ParagraphStyle('Details', parent=normal_style, fontSize=8, leftIndent=10, textColor=colors.darkgrey)))
            
        elements.append(Spacer(1, 0.1 * inch))
        elements.append(HRFlowable(width="100%", thickness=0.5, color=colors.HexColor('#eeeeee')))
        elements.append(Spacer(1, 0.1 * inch))

    doc.build(elements)
    output.seek(0)
    data_b64 = base64.b64encode(output.read()).decode()
    
    return {
        "filename": f"historial_{order.get('order_number')}.pdf",
        "data": data_b64,
        "content_type": "application/pdf"
    }
