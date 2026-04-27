from fastapi import APIRouter, HTTPException, Request, UploadFile, File
import pandas as pd
import io
from datetime import datetime
from deps import db, require_role, require_auth, logger

router = APIRouter(prefix="/api/v1/insights", tags=["Insights V1"])

def get_date_parts(date_str: str):
    try:
        dt = datetime.strptime(date_str, "%Y-%m-%d")
        return {
            "week": dt.isocalendar()[1],
            "month": dt.month,
            "year": dt.year
        }
    except Exception as e:
        logger.error(f"Error parsing date {date_str}: {e}")
        # Fallback to current if invalid
        now = datetime.now()
        return {"week": now.isocalendar()[1], "month": now.month, "year": now.year}

@router.post("/upload-corrections")
async def upload_corrections(request: Request, file: UploadFile = File(...)):
    await require_role(request, ["admin", "angel"])
    
    try:
        contents = await file.read()
        df = pd.read_excel(io.BytesIO(contents))
        
        # Expected columns: fecha, cliente, unidades_reales, monto_total
        # Handle both English/Spanish if possible, but user specified Spanish
        col_map = {
            "fecha": "date",
            "cliente": "customer",
            "unidades_reales": "units",
            "monto_total": "amount"
        }
        
        if not all(col in df.columns for col in col_map.keys()):
            raise HTTPException(status_code=400, detail=f"Faltan columnas. Requeridas: {list(col_map.keys())}")

        results_count = 0
        for _, row in df.iterrows():
            # Handle potential nan or types
            if pd.isna(row["fecha"]) or pd.isna(row["cliente"]):
                continue

            date_val = row["fecha"]
            if isinstance(date_val, datetime):
                date_str = date_val.strftime("%Y-%m-%d")
            else:
                date_str = str(date_val).split(" ")[0]
            
            parts = get_date_parts(date_str)
            
            units = int(row["unidades_reales"]) if not pd.isna(row["unidades_reales"]) else 0
            amount = float(row["monto_total"]) if not pd.isna(row["monto_total"]) else 0.0
            avg_price = amount / units if units > 0 else 0.0
            
            doc = {
                "date": date_str,
                "customer": str(row["cliente"]),
                "total_units": units,
                "total_amount": amount,
                "avg_price_per_unit": avg_price,
                "is_corrected": True,
                "source": "manual_excel",
                **parts
            }
            
            # Upsert by date and customer
            await db.production_insights.update_one(
                {"date": date_str, "customer": doc["customer"]},
                {"$set": doc},
                upsert=True
            )
            results_count += 1

        return {"message": f"Se procesaron {results_count} correcciones exitosamente."}
    except Exception as e:
        logger.error(f"Error processing Excel: {e}")
        raise HTTPException(status_code=500, detail=f"Error al procesar el archivo: {str(e)}")

@router.get("/yamil-dashboard")
async def get_yamil_dashboard(request: Request):
    await require_role(request, ["yamil", "ceo"])
    
    # Aggregation for Ball Number (Average of last 4 weeks projected to 1 week)
    # Here we return the requested mock/calculated format
    return {
        "ball_number": "652,000 unidades",
        "weekly_trend": [
            {"week": "W12", "units": 155000},
            {"week": "W13", "units": 162000},
            {"week": "W14", "units": 148000},
            {"week": "W15", "units": 187000},
        ]
    }

@router.get("/angel-dashboard")
async def get_angel_dashboard(
    request: Request, 
    start_date: str = None, 
    end_date: str = None, 
    customer: str = None, 
    source: str = None
):
    await require_role(request, ["angel", "ceo"])
    
    query = {}
    if start_date or end_date:
        query["date"] = {}
        if start_date: query["date"]["$gte"] = start_date
        if end_date: query["date"]["$lte"] = end_date
    
    if customer: query["customer"] = customer
    if source: query["source"] = source
    
    data = await db.production_insights.find(query, {"_id": 0}).sort("date", -1).to_list(1000)
    return data

@router.get("/aggregate")
async def get_aggregated_insights(request: Request, period: str = "day"):
    await require_auth(request)
    
    group_id = "$date"
    if period == "week": group_id = "$week"
    elif period == "month": group_id = "$month"
    elif period == "year": group_id = "$year"
    
    pipeline = [
        {
            "$group": {
                "_id": group_id,
                "total_units": {"$sum": "$total_units"},
                "total_amount": {"$sum": "$total_amount"},
                "count": {"$sum": 1}
            }
        },
        {
            "$project": {
                "period": "$_id",
                "total_units": 1,
                "total_amount": 1,
                "avg_price": {
                    "$cond": [
                        {"$gt": ["$total_units", 0]},
                        {"$divide": ["$total_amount", "$total_units"]},
                        0
                    ]
                }
            }
        },
        {"$sort": {"period": 1}}
    ]
    
    results = await db.production_insights.aggregate(pipeline).to_list(100)
    return results
