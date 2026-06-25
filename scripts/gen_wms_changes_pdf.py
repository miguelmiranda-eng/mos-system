"""Generate a friendly, user-facing PDF summarizing the 7 WMS improvements."""
from reportlab.lib.pagesizes import LETTER
from reportlab.lib.units import cm
from reportlab.lib import colors
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.enums import TA_LEFT, TA_CENTER
from reportlab.platypus import (
    BaseDocTemplate, PageTemplate, Frame, Paragraph, Spacer, Table, TableStyle,
    KeepTogether, FrameBreak, NextPageTemplate, PageBreak,
)

OUT = r"C:\Users\LENOVO MIRANDA\Desktop\Mejoras_WMS_7_Cambios.pdf"

AMBER = colors.HexColor("#FFB300")
AMBER_SOFT = colors.HexColor("#FFF6E0")
INK = colors.HexColor("#1F2430")
SLATE = colors.HexColor("#5B6472")
GREEN = colors.HexColor("#2E9E5B")
GREEN_SOFT = colors.HexColor("#E7F6EC")
LINE = colors.HexColor("#E3E6EC")

styles = getSampleStyleSheet()

def S(name, **kw):
    return ParagraphStyle(name, parent=styles["Normal"], **kw)

st_title    = S("t",  fontName="Helvetica-Bold", fontSize=30, textColor=colors.white, leading=34)
st_sub      = S("s",  fontName="Helvetica",      fontSize=13, textColor=colors.white, leading=18)
st_meta     = S("m",  fontName="Helvetica-Bold", fontSize=10, textColor=AMBER, leading=14)
st_intro    = S("i",  fontName="Helvetica",      fontSize=11, textColor=INK,   leading=17)
st_case_t   = S("ct", fontName="Helvetica-Bold", fontSize=14, textColor=INK,   leading=18)
st_label    = S("lb", fontName="Helvetica-Bold", fontSize=8,  textColor=SLATE, leading=11)
st_body     = S("bd", fontName="Helvetica",      fontSize=10, textColor=INK,   leading=14)
st_where    = S("wh", fontName="Helvetica-Oblique", fontSize=9, textColor=SLATE, leading=13)
st_num      = S("nm", fontName="Helvetica-Bold", fontSize=20, textColor=colors.white, alignment=TA_CENTER, leading=22)
st_foot     = S("ft", fontName="Helvetica",      fontSize=8,  textColor=SLATE, alignment=TA_CENTER)
st_sec      = S("se", fontName="Helvetica-Bold", fontSize=12, textColor=AMBER, leading=16)

CASES = [
    ("01", "Capturas de recibo con menús (sin escribir a mano)", "done",
     "El mismo producto se registraba con muchos nombres distintos porque cada persona escribía la descripción, el cliente y la talla a su manera.",
     "En Recepción ahora se elige de menús desplegables. Ya no se teclea libre, así que el mismo producto siempre se registra igual.",
     "WMS → Recepción"),
    ("02", "Ajustar inventario por número de caja", "new",
     "Los ajustes se hacían por estilo y ubicación, sin saber con certeza qué caja física se estaba modificando.",
     "En MOVER, el modo “Ajustar caja” permite escanear una caja y capturar su conteo real. El sistema ajusta esa caja exacta, pide un motivo y avisa si el cambio afecta material ya comprometido.",
     "WMS → MOVER → pestaña “Ajustar caja”"),
    ("03", "Historial completo de una caja", "new",
     "No existía forma de saber qué le había pasado a una caja para investigar diferencias de inventario.",
     "Buscando el número de caja se ve su línea de tiempo completa: recepción, ubicación, ajustes y reubicaciones. Cada evento se puede expandir para ver todo el detalle (producto, unidades, motivo, fecha y responsable).",
     "WMS → Movimientos → pestaña “Por caja / LPN”"),
    ("04", "Localizar una caja desde el PDA", "new",
     "El operador en piso no tenía manera rápida de saber en qué ubicación estaba una caja.",
     "Desde el PDA, con el botón de búsqueda (lupa), se escanea la caja y al instante se muestra su ubicación, el cliente y el contenido.",
     "PDA del picker → botón de búsqueda (lupa)"),
    ("05", "Los surtidos parciales ya no se cierran solos", "new",
     "Un surtido parcial se movía a “completados” como si estuviera terminado, y se perdía de vista.",
     "Si falta material, el ticket queda ACTIVO con la marca “Parcial · espera material” para reasignarlo cuando llegue más stock. Solo se cierra cuando el surtido está completo. Los tickets activos se separan en “En avance” y “Sin iniciar”.",
     "WMS → Picking → pestaña Activos"),
    ("06", "Ajustes positivos con número de caja real", "new",
     "Al ingresar material por ajuste, el sistema creaba cajas “fantasma” sin un número real, imposibles de rastrear.",
     "Ahora se captura o escanea el número de caja real (el sistema valida que no exista ya). Queda una caja escaneable y enlazada, visible en su historial desde que se crea.",
     "WMS → Inventario → “Agregar Manual” → campo “Número de caja (LPN)”"),
    ("07", "Ver y exportar el número de caja por ubicación", "new",
     "El inventario no mostraba qué cajas había en cada ubicación, y los reportes tampoco lo incluían.",
     "En la tabla de Inventario se despliegan los números de caja de cada línea con un clic. Además, el Excel de exportación trae una hoja extra “Cajas - LPNs” con el detalle por caja.",
     "WMS → Inventario (flecha en la columna “Cajas”) y botón Exportar"),
]

def case_card(num, title, kind, antes, ahora, donde):
    badge_color = GREEN if kind == "done" else AMBER
    tag = "YA ACTIVO" if kind == "done" else "NUEVO"
    tag_bg = GREEN_SOFT if kind == "done" else AMBER_SOFT
    tag_fg = GREEN if kind == "done" else colors.HexColor("#A06A00")

    head = Table(
        [[Paragraph(title, st_case_t),
          Paragraph(f'<font color="#{tag_fg.hexval()[2:]}"><b>{tag}</b></font>', S("tg", fontSize=8, alignment=TA_CENTER))]],
        colWidths=[12.3*cm, 2.2*cm],
    )
    head.setStyle(TableStyle([
        ("VALIGN", (0,0), (-1,-1), "MIDDLE"),
        ("BACKGROUND", (1,0), (1,0), tag_bg),
        ("BOX", (1,0), (1,0), 0.5, tag_fg),
        ("TOPPADDING", (1,0),(1,0), 3), ("BOTTOMPADDING",(1,0),(1,0),3),
        ("LEFTPADDING",(0,0),(0,0),0),
    ]))

    body = Table([
        [head],
        [Paragraph("ANTES", st_label)],
        [Paragraph(antes, st_body)],
        [Spacer(1, 4)],
        [Paragraph("AHORA", st_label)],
        [Paragraph(ahora, st_body)],
        [Spacer(1, 4)],
        [Paragraph("DÓNDE", st_label)],
        [Paragraph(donde, st_where)],
    ], colWidths=[14.6*cm])
    body.setStyle(TableStyle([
        ("LEFTPADDING",(0,0),(-1,-1), 10), ("RIGHTPADDING",(0,0),(-1,-1), 8),
        ("TOPPADDING",(0,0),(0,0), 4), ("BOTTOMPADDING",(0,-1),(0,-1), 8),
    ]))

    badge = Paragraph(num, st_num)
    card = Table([[badge, body]], colWidths=[1.5*cm, 14.6*cm])
    card.setStyle(TableStyle([
        ("VALIGN",(0,0),(0,0),"TOP"), ("VALIGN",(1,0),(1,0),"TOP"),
        ("BACKGROUND",(0,0),(0,0), badge_color),
        ("TOPPADDING",(0,0),(0,0), 12), ("BOTTOMPADDING",(0,0),(0,0), 12),
        ("BACKGROUND",(1,0),(1,0), colors.white),
        ("BOX",(0,0),(-1,-1), 0.75, LINE),
        ("LINEAFTER",(0,0),(0,0), 0, colors.white),
    ]))
    return KeepTogether([card, Spacer(1, 10)])

# ── Page templates ────────────────────────────────────────────────────────────
def cover_bg(canvas, doc):
    canvas.saveState()
    canvas.setFillColor(INK)
    canvas.rect(0, 0, LETTER[0], LETTER[1], fill=1, stroke=0)
    canvas.setFillColor(AMBER)
    canvas.rect(0, LETTER[1]-0.5*cm, LETTER[0], 0.5*cm, fill=1, stroke=0)
    canvas.rect(0, 0, LETTER[0], 0.5*cm, fill=1, stroke=0)
    canvas.restoreState()

def content_bg(canvas, doc):
    canvas.saveState()
    canvas.setFillColor(AMBER)
    canvas.rect(0, LETTER[1]-0.35*cm, LETTER[0], 0.35*cm, fill=1, stroke=0)
    canvas.setFillColor(SLATE)
    canvas.setFont("Helvetica", 8)
    canvas.drawCentredString(LETTER[0]/2, 1.0*cm, f"MOS · Mejoras al WMS · Página {doc.page-1}")
    canvas.restoreState()

doc = BaseDocTemplate(OUT, pagesize=LETTER,
                      leftMargin=2.2*cm, rightMargin=2.2*cm, topMargin=2.4*cm, bottomMargin=2.0*cm)

cover_frame = Frame(0, 0, LETTER[0], LETTER[1], leftPadding=2.5*cm, rightPadding=2.5*cm,
                    topPadding=6*cm, bottomPadding=3*cm, id="cover")
content_frame = Frame(doc.leftMargin, doc.bottomMargin, doc.width, doc.height, id="content")

doc.addPageTemplates([
    PageTemplate(id="Cover", frames=[cover_frame], onPage=cover_bg),
    PageTemplate(id="Content", frames=[content_frame], onPage=content_bg),
])

story = []
# Cover
story += [
    Paragraph("MOS · WAREHOUSE MANAGEMENT", st_meta),
    Spacer(1, 14),
    Paragraph("Mejoras al WMS", st_title),
    Spacer(1, 8),
    Paragraph("7 cambios para tener control total del inventario, caja por caja.", st_sub),
    Spacer(1, 26),
    Paragraph("Junio 2026", st_meta),
    NextPageTemplate("Content"),
    PageBreak(),
]

# Intro
story += [
    Paragraph("¿Qué mejoró y por qué te conviene?", st_sec),
    Spacer(1, 6),
    Paragraph(
        "Reunimos las molestias más comunes del día a día en el almacén y las resolvimos. "
        "El hilo conductor de estos cambios es simple: <b>cada movimiento de inventario queda ligado a un número de caja</b>, "
        "para que siempre sepas qué hay, dónde está y qué le pasó. Aquí está el resumen, en lenguaje claro.",
        st_intro),
    Spacer(1, 16),
]

for c in CASES:
    story.append(case_card(*c))

story += [
    Spacer(1, 6),
    Table([[Paragraph(
        "<b>En resumen:</b> ahora puedes ajustar, rastrear, localizar y reportar el inventario "
        "a nivel de caja física — con menos errores y total visibilidad.", st_body)]],
        colWidths=[16.1*cm],
        style=TableStyle([
            ("BACKGROUND",(0,0),(-1,-1), AMBER_SOFT),
            ("BOX",(0,0),(-1,-1), 0.75, AMBER),
            ("LEFTPADDING",(0,0),(-1,-1),12),("RIGHTPADDING",(0,0),(-1,-1),12),
            ("TOPPADDING",(0,0),(-1,-1),10),("BOTTOMPADDING",(0,0),(-1,-1),10),
        ])),
]

doc.build(story)
print("PDF generado:", OUT)
