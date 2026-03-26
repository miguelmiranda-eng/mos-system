FROM python:3.11-slim

WORKDIR /app

# Instalar dependencias primero para aprovechar la cache de Docker
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copiar el resto del backend
COPY . .

# Exponer el puerto de FastAPI
EXPOSE 8000

# Comando para iniciar servidor de producción
CMD ["uvicorn", "server:app", "--host", "0.0.0.0", "--port", "8000"]
