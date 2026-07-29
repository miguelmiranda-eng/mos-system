FROM python:3.11-slim

WORKDIR /app

# "Inventario por foto" lee la etiqueta del cartón en el propio servidor:
#   libzbar0     -> los dos barcodes (pyzbar es sólo el binding de Python)
#   tesseract-ocr -> el resto de los campos, recortados por región
# Sin estos paquetes el endpoint /wms/recon/label-read responde igual, pero con
# los campos vacíos para que el operador los capture a mano.
RUN apt-get update \
    && apt-get install -y --no-install-recommends libzbar0 tesseract-ocr \
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
