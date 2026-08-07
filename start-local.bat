@echo off
REM ============================================================
REM  MOS local en un solo comando:
REM    - Backend  http://localhost:8000  (sin schedulers: no
REM      sincroniza Printavo ni corre barridos contra la base)
REM    - Frontend http://localhost:3000  (craco/CRA con hot reload)
REM  Cierra las dos ventanas para detener todo.
REM ============================================================
start "MOS Backend (8000)" cmd /k "cd /d %~dp0backend && set DISABLE_SCHEDULERS=1&& venv\Scripts\python.exe -m uvicorn server:app --port 8000 --reload"
start "MOS Frontend (3000)" cmd /k "cd /d %~dp0frontend && npm start"
echo.
echo Backend:  http://localhost:8000
echo Frontend: http://localhost:3000  (se abre solo en el navegador)
echo.
