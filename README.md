# MOS System

Manufacturing Operating System (MOS) para la gestión eficiente de procesos de producción.

## Características Principales
- Gestión de órdenes y tableros de producción.
- Centro de automatización para reglas lógicas.
- Seguimiento de estados (Production, Blank, Artwork, etc.).
- Gestión de usuarios y roles.

## Estructura del Proyecto
- `backend/`: API construida con FastAPI y MongoDB.
- `frontend/`: Aplicación React para la interfaz de usuario.
- `scripts/`: Utilidades y scripts de migración.

## Configuración Local

### Backend
1. Instalar dependencias: `pip install -r requirements.txt`
2. Configurar variables de entorno en `backend/.env`.
3. Ejecutar servidor: `python backend/server.py`

### Frontend
1. Instalar dependencias: `npm install`
2. Ejecutar servidor de desarrollo: `npm start`
