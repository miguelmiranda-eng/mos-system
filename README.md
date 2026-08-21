# MOS System

Manufacturing Operating System (MOS) para la gestión eficiente de procesos de producción.

## Características Principales
- Gestión de órdenes y tableros de producción.
- Centro de automatización para reglas lógicas.
- Seguimiento de estados (Production, Blank, Artwork, etc.).
- Gestión de usuarios y roles.

## Estructura del Proyecto
- `backend/`: API construida con FastAPI y MongoDB.
- `frontend/`: Aplicación React (CRA + craco) para la interfaz de usuario.
- `scripts/`: Utilidades y scripts de migración.
- `docs/manual/`: Manuales de usuario (CRM y WMS).

## Requisitos

| Herramienta | Versión |
|---|---|
| Python | 3.11+ |
| Node.js | 18+ |
| MongoDB | local en `27017`, o una URI de Atlas |

## Configuración Local

### 1. Variables de entorno

No hay `.env` en el repo y **no debe haberlo**: aquí vivían credenciales de
producción en un repositorio público. Las llaves de administrador no tienen
valor por defecto a propósito — si faltan, el servidor no arranca, y eso se
nota en el primer intento. Un default silencioso no se nota hasta que alguien
lo lee en GitHub.

Crea `backend/.env` con lo mínimo:

```env
ENV=local
MONGO_URL=mongodb://localhost:27017/mos-system
DB_NAME=mos-system
MASTER_API_KEY=<genera uno>
INTERNAL_SYNC_TOKEN=<genera uno>
DISABLE_SCHEDULERS=1
```

Genera cada llave con:

```bash
python -c "import secrets; print(secrets.token_urlsafe(32))"
```

Y `frontend/.env`:

```env
REACT_APP_BACKEND_URL=http://localhost:8000
```

Variables opcionales, solo si vas a usar esa parte del sistema:
`PRINTAVO_API_URL` / `PRINTAVO_API_EMAIL` / `PRINTAVO_API_TOKEN`,
`ANTHROPIC_API_KEY`, `RESEND_API_KEY` / `SENDER_EMAIL`,
`GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` / `GOOGLE_REDIRECT_URI`,
`SLACK_WEBHOOK_URL`, `TESSERACT_CMD`, `MOS_ENCRYPTION_KEY` (llave Fernet).

### 2. Instalación (solo la primera vez)

```bash
python -m venv backend/venv
backend/venv/Scripts/pip install -r backend/requirements.txt
npm --prefix frontend install
```

### 3. Arranque

En Windows, las dos piezas de una sola vez:

```bash
./start-local.bat
```

O por separado:

```bash
cd backend && venv/Scripts/python -m uvicorn server:app --port 8000 --reload
cd frontend && npm start
```

- Backend: http://localhost:8000
- Frontend: http://localhost:3000

`DISABLE_SCHEDULERS=1` (lo que hace `start-local.bat`) evita que el backend
sincronice Printavo y corra barridos contra la base. Déjalo activo en local
salvo que estés probando la sincronización a propósito.

### Docker

`docker-compose.yml` levanta backend y frontend, pero **no incluye MongoDB**:
necesitas una base aparte y pasar `MONGODB_URL` y `JWT_SECRET` por el entorno.
