FROM python:3.11-slim

WORKDIR /app

# libzbar: lector de barcodes de "Inventario por foto" (Conciliación). pyzbar es
# sólo el binding de Python; sin esta librería del sistema el endpoint
# /wms/recon/label-scan responde 503 en producción.
RUN apt-get update \
    && apt-get install -y --no-install-recommends libzbar0 \
    && rm -rf /var/lib/apt/lists/*

# Instalar dependencias primero para aprovechar la cache de Docker
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copiar el resto del backend
COPY . .

# Exponer el puerto de FastAPI
EXPOSE 8000

# Comando para iniciar servidor de producción
CMD ["uvicorn", "server:app", "--host", "0.0.0.0", "--port", "8000"]
