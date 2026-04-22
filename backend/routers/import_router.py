from fastapi import APIRouter, HTTPException, Request, UploadFile, File
import httpx
import re
import io
import pdfplumber
from bs4 import BeautifulSoup
from typing import Optional, List, Dict, Any
from datetime import datetime
from deps import require_auth, db, logger

router = APIRouter(prefix="/api/import")

SIZES_MAP = {
    'XS': 'XS', 'S': 'S', 'M': 'M', 'L': 'L', 'XL': 'XL',
    'SM': 'S', 'MD': 'M', 'LG': 'L',
    '2X': '2X', 'XXL': '2X', '2XL': '2X', '2 XL': '2X',
    '3X': '3X', 'XXXL': '3X', '3XL': '3X', '3 XL': '3X',
    '4X': '4X', '4XL': '4X', '4 XL': '4X',
    '5X': '5X', '5XL': '5X', '5 XL': '5X',
    'YXS': 'YXS', 'YS': 'YS', 'YM': 'YM', 'YL': 'YL', 'YXL': 'YXL',
    '2T': '2T', '3T': '3T', '4T': '4T', '5T': '5T'
}

SIZE_PATTERN = r"\b(XXXL|XXL|YXL|YXS|XL|SM|MD|LG|XS|YS|YM|YL|[2-7]\s?XL?|S|M|L|[2-5]T)\b[\s:-]+(\d+)"

@router.post("/printavo")
async def import_printavo(request: Request):
    await require_auth(request)
    body = await request.json()
    url = body.get("url")
    
    if not url:
        raise HTTPException(status_code=400, detail="URL is required")

    try:
        async with httpx.AsyncClient(follow_redirects=True) as client:
            resp = await client.get(url, timeout=15.0)
            if resp.status_code != 200:
                raise HTTPException(status_code=400, detail=f"Failed to fetch Printavo page (Status {resp.status_code})")
            
            content_type = resp.headers.get("content-type", "").lower()
            
            if "pdf" in content_type or url.lower().endswith(".pdf"):
                return await parse_printavo_pdf(resp.content)
            else:
                return await parse_printavo_html(resp.text)
                
    except Exception as e:
        logger.error(f"Printavo import error: {str(e)}")
        raise HTTPException(status_code=500, detail=f"Error processing Printavo link: {str(e)}")

async def parse_printavo_html(html_content: str):
    soup = BeautifulSoup(html_content, 'lxml')
    text = soup.get_text()
    
    # 1. Extract Order Number (Invoice #)
    order_num_match = re.search(r"(?:Order|Invoice)\s*#?\s*(\d+)", text, re.I)
    order_number = order_num_match.group(1) if order_num_match else ""
    
    # 2. Extract Customer (Client)
    customer = ""
    p_tag = soup.find('p', class_=re.compile("order-addresses-wrapper"))
    if p_tag:
        lines = [lin.strip() for lin in p_tag.get_text().splitlines() if lin.strip()]
        if len(lines) > 1:
            customer = lines[1]
    
    if not customer:
        cust_match = re.search(r"Customer:\s*(.+)", text, re.I)
        if cust_match: customer = cust_match.group(1).strip()

    # 3. Extract PO and Dates from Summary Table
    po_number = ""
    due_date = ""
    ross_po = ""
    design_num = ""
    job_title_desc = ""
    
    # Try to find the full line containing the PO pattern for the description
    for s in soup.stripped_strings:
        if re.search(r"PO#\s*[\w-]+\s*-\s*[\w-]+\s*-\s*[\w-]+", s, re.I):
            job_title_desc = s
            break
    
    # Analyze the standard header pattern like: "SPENCERS PO# 19291 - 311381 - GFM0118M1000 - REORDER"
    # Group 1: Branding, Group 2: Customer PO, Group 3: Store PO, Group 4: Design #
    header_po_match = re.search(r"(?:([\w\-]+)\s+)?PO#\s*([\w-]+)\s*-\s*([\w-]+)\s*-\s*([\w-]+)", text, re.I)
    branding = ""
    if header_po_match:
        branding = header_po_match.group(1) or ""
        po_number = header_po_match.group(2)
        ross_po = header_po_match.group(3)
        design_num = header_po_match.group(4)

    labels = soup.find_all('div', class_='control-label')
    for label in labels:
        lbl_text = label.get_text().strip()
        val_div = label.find_next_sibling('div', class_=re.compile(r"form-control"))
        if not val_div: continue
        val_text = val_div.get_text().strip()
        
        # Only override po_number if we didn't find it in the header
        if re.search(r"PO\s*#", lbl_text, re.I) and not po_number:
            po_number = val_text
        elif re.search(r"Customer\s+Due\s+Date", lbl_text, re.I):
            try:
                dt = datetime.strptime(val_text, "%B %d, %Y")
                due_date = dt.strftime("%Y-%m-%d")
            except:
                due_date = val_text
    
    # Fallback for Design # if not in Ross line
    if not design_num:
        design_match = re.search(r"([A-Z\d]{8,})", text)
        if design_match: design_num = design_match.group(1)

    # 4. Extract Items (Styles)
    items = []
    
    rows = soup.find_all("tr")
    header_cols = {}
    
    for row in rows:
        cells = row.find_all(["td", "th"])
        if not cells: continue
        
        # Try to identify column indices from header
        if any(h in row.get_text().lower() for h in ["description", "qty", "color", "size"]):
            for i, cell in enumerate(cells):
                cell_text = cell.get_text().lower()
                if "description" in cell_text: header_cols["desc"] = i
                elif "color" in cell_text: header_cols["color"] = i
                elif "qty" in cell_text: header_cols["qty"] = i
            continue

        if len(cells) < 2: continue
        
        row_text = row.get_text(separator=" ")
        size_patterns = re.findall(SIZE_PATTERN, row_text, re.I)
        
        if size_patterns:
            style_name = ""
            color_name = ""
            
            # Robust extraction by looking at cell contents
            for cell in cells:
                c_text = cell.get_text().strip()
                if not c_text: continue
                lines = [l.strip() for l in c_text.splitlines() if l.strip()]
                # Product descriptions typically have multiple lines and the style is the first line
                # It might also contain the design # inside
                if len(lines) >= 2 and len(lines[0]) > 2:
                    if not style_name:
                        style_name = lines[0]
                elif len(lines) == 1 and not re.search(r"\d", c_text) and len(c_text) > 2:
                    if not color_name:
                        color_name = c_text
            
            # If still nothing, try the header maps
            if not style_name and "desc" in header_cols and header_cols["desc"] < len(cells):
                style_name = cells[header_cols["desc"]].get_text().strip().split("\n")[0]
            if not color_name and "color" in header_cols and header_cols["color"] < len(cells):
                color_name = cells[header_cols["color"]].get_text().strip()

            sizes_found = {}
            total_qty = 0
            for sz_label, qty_str in size_patterns:
                mos_size = SIZES_MAP.get(sz_label.upper())
                if mos_size:
                    qty = int(qty_str)
                    sizes_found[mos_size] = sizes_found.get(mos_size, 0) + qty
                    total_qty += qty
            
            if total_qty > 0:
                items.append({
                    "order_number": order_number,
                    "customer_po": po_number,
                    "store_po": ross_po,
                    "design_#": design_num,
                    "job_title_desc": job_title_desc,
                    "client": customer,
                    "branding": branding,
                    "style": style_name or "Estilo Desconocido",
                    "color": color_name,
                    "due_date": due_date,
                    "cancel_date": due_date, # User wants Customer Due Date as Cancel Date
                    "quantity": total_qty,
                    "sizes": sizes_found,
                    "notes": f"Importado de Printavo: {style_name[:50]}"
                })

    if items:
        seen = set()
        unique_items = []
        for it in items:
            key = (it["style"], it["quantity"], it.get("color", ""))
            if key not in seen:
                unique_items.append(it)
                seen.add(key)
        return {"items": unique_items}

    # Fallback to the original logic if table extraction found nothing
    if sizes_found := re.findall(SIZE_PATTERN, text, re.I):
        mos_sizes = {}
        total = 0
        for sz, q in sizes_found:
            m_sz = SIZES_MAP.get(sz.upper())
            if m_sz:
                qty = int(q)
                mos_sizes[m_sz] = mos_sizes.get(m_sz, 0) + qty
                total += qty
        
        items.append({
            "order_number": order_number,
            "customer_po": po_number,
            "store_po": ross_po,
            "design_#": design_num,
            "job_title_desc": job_title_desc,
            "client": customer,
            "branding": branding,
            "style": "Extraído de texto",
            "quantity": total,
            "sizes": mos_sizes,
            "notes": "Importación automática (fallback)"
        })

    return {"items": items}

async def parse_printavo_pdf(pdf_bytes: bytes):
    with pdfplumber.open(io.BytesIO(pdf_bytes)) as pdf:
        text = ""
        for page in pdf.pages:
            text += page.extract_text() or ""
            
        # Regex extraction similar to HTML but tailored for PDF text layout
        order_num = re.search(r"Invoice\s*#(\d+)|Order\s*#(\d+)", text, re.I)
        order_number = order_num.group(1) or order_num.group(2) if order_num else ""
        
        cust_match = re.search(r"CUSTOMER:\s*(.+)", text, re.I)
        customer = cust_match.group(1).strip() if cust_match else ""
        
        # Item extraction in PDF is trickier, we look for table headers
        items = []
        # Basic regex search for sizes/qty patterns
        size_patterns = re.findall(SIZE_PATTERN, text, re.I)
        
        if size_patterns:
            mos_sizes = {}
            total = 0
            for sz, q in size_patterns:
                m_sz = SIZES_MAP.get(sz.upper())
                if m_sz:
                    qty = int(q)
                    mos_sizes[m_sz] = mos_sizes.get(m_sz, 0) + qty
                    total += qty
            
            items.append({
                "order_number": order_number,
                "client": customer,
                "quantity": total,
                "sizes": mos_sizes,
                "notes": "Importado de Printavo PDF"
            })
            
        return {"items": items}

def url_short(text: str):
    return (text[:100] + '...') if len(text) > 100 else text
