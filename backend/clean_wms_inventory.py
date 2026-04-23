import pandas as pd
import os
import re
from pymongo import MongoClient
from difflib import get_close_matches

# Configuración de MongoDB (usando el .env que creamos)
MONGO_URL = "mongodb://miranda:Mirandam2@187.124.232.150:27017/mos-system?authSource=admin"
client = MongoClient(MONGO_URL)
db = client['mos-system']
inventory_col = db['inventory']

# 1. Definir Países Objetivo
TARGET_COUNTRIES = [
    'PAKISTAN', 'BANGLADESH', 'HONDURAS', 'NICARAGUA', 'HAITI', 
    'REPUBLICA DOMINICANA', 'EL SALVADOR', 'CHINA', 'VIETNAM', 
    'USA', 'INDIA', 'MEXICO', 'GUATEMALA'
]

def clean_country(val):
    if pd.isna(val) or str(val).strip() in ['.', '.23', 'Wash cold']:
        return "UNKNOWN"
    
    val = str(val).upper().strip()
    
    # Limpieza manual de casos muy extraños
    if 'DOMINIC' in val or 'REP' in val: return 'REPUBLICA DOMINICANA'
    if 'SALVADOR' in val: return 'EL SALVADOR'
    if 'PAK' in val or 'PAS' in val or 'PAN' in val: return 'PAKISTAN'
    if 'BANG' in val or 'BAGL' in val or 'ANGL' in val or 'BGL' in val: return 'BANGLADESH'
    if 'NIC' in val or 'NIK' in val: return 'NICARAGUA'
    if 'HOND' in val or 'HOD' in val or 'OND' in val or 'HONB' in val: return 'HONDURAS'
    if 'CHIN' in val: return 'CHINA'
    if 'VIET' in val: return 'VIETNAM'
    if 'INDI' in val: return 'INDIA'
    
    # Fuzzy matching para el resto
    matches = get_close_matches(val, TARGET_COUNTRIES, n=1, cutoff=0.6)
    if matches:
        return matches[0]
    
    # Si parece una descripción de tela, marcar como desconocido o limpiar
    if 'COTTON' in val or 'POLY' in val or '%' in val:
        return "UNKNOWN"
        
    return val

def run_import():
    print("Cargando archivo Excel...")
    df = pd.read_excel('almace data.xlsx')
    
    print("Limpiando datos...")
    # Normalizar columnas clave
    df['CountryofOrigin'] = df['CountryofOrigin'].apply(clean_country)
    df['Color'] = df['Color'].astype(str).str.upper().str.strip()
    df['Size'] = df['Size'].astype(str).str.upper().str.strip()
    df['CustomerID'] = df['CustomerID'].astype(str).str.upper().str.strip()
    df['Style'] = df['Style'].astype(str).str.upper().str.strip()
    df['InvLocation'] = df['InvLocation'].astype(str).str.upper().str.strip()
    df['TotalUnits'] = pd.to_numeric(df['TotalUnits'], errors='coerce').fillna(0)
    
    # Llenar todos los valores nulos con un texto vacío para evitar que pandas descarte filas durante el groupby
    df = df.fillna('')
    
    # Agrupar para unificar duplicados (Mismo cliente, estilo, color, talla, pais y locacion)
    print("Unificando registros duplicados...")
    grouped = df.groupby([
        'CustomerID', 'Manufacturer', 'Style', 'Color', 'Size', 
        'CountryofOrigin', 'InvLocation', 'Description', 'Category'
    ]).agg({
        'TotalUnits': 'sum',
        'Total Boxes': 'sum'
    }).reset_index()
    
    # Renombrar para que coincidan con el backend (inv_location y available)
    grouped = grouped.rename(columns={
        'InvLocation': 'inv_location',
        'TotalUnits': 'available',
        'Style': 'style',
        'Color': 'color',
        'Size': 'size',
        'CustomerID': 'customer',
        'CountryofOrigin': 'country_of_origin',
        'Description': 'description',
        'Category': 'category',
        'Manufacturer': 'manufacturer',
        'Total Boxes': 'total_boxes'
    })
    
    # Preparar para MongoDB
    records = grouped.to_dict('records')
    for r in records:
        r['last_updated'] = pd.Timestamp.now()
        r['status'] = 'available'
    
    print(f"Limpieza completada. Registros unificados: {len(records)}")
    
    # Limpiar colección actual y recargar con nombres correctos
    db['wms_inventory'].drop()
    
    print("Insertando en wms_inventory con nombres correctos...")
    if records:
        db['wms_inventory'].insert_many(records)
        print("¡Carga exitosa con nombres estandarizados!")
    else:
        print("No hay registros para cargar.")

if __name__ == "__main__":
    run_import()
