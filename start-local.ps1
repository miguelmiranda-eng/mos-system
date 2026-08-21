# ============================================================
#  MOS local en un solo comando (PowerShell)
#    .\start-local.ps1
#
#  Es idempotente: la primera vez crea el venv e instala todo,
#  las siguientes solo arranca. Cierra las dos ventanas que
#  abre para detener el sistema.
# ============================================================
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

# --- PATH fresco -------------------------------------------------
# Si instalaste Node o Python con esta consola ya abierta, el PATH
# de la sesion es el viejo y no los encuentra. Lo releemos del registro.
$env:Path = [Environment]::GetEnvironmentVariable('Path','Machine') + ';' +
            [Environment]::GetEnvironmentVariable('Path','User')

foreach ($c in 'python','npm') {
    if (-not (Get-Command $c -ErrorAction SilentlyContinue)) {
        Write-Host "ERROR: no encuentro '$c' en el PATH. Instalalo y reabre PowerShell." -ForegroundColor Red
        exit 1
    }
}

# --- .env --------------------------------------------------------
foreach ($f in 'backend\.env','frontend\.env') {
    if (-not (Test-Path $f)) {
        Write-Host "ERROR: falta $f. Sin las llaves obligatorias el backend no arranca." -ForegroundColor Red
        exit 1
    }
}

# --- 1/3  venv del backend ---------------------------------------
if (-not (Test-Path backend\venv\Scripts\python.exe)) {
    Write-Host "[1/3] Creando venv e instalando dependencias de Python..." -ForegroundColor Cyan
    python -m venv backend\venv
    backend\venv\Scripts\python.exe -m pip install --upgrade pip
    backend\venv\Scripts\python.exe -m pip install -r backend\requirements.txt
} else {
    Write-Host "[1/3] venv ya existe, lo reutilizo." -ForegroundColor DarkGray
}

# --- 2/3  dependencias del frontend ------------------------------
if (-not (Test-Path frontend\node_modules)) {
    Write-Host "[2/3] Instalando dependencias de npm (tarda varios minutos)..." -ForegroundColor Cyan
    npm --prefix frontend install
} else {
    Write-Host "[2/3] node_modules ya existe, lo reutilizo." -ForegroundColor DarkGray
}

# --- Mongo -------------------------------------------------------
$mongo = Test-NetConnection -ComputerName localhost -Port 27017 -WarningAction SilentlyContinue
if (-not $mongo.TcpTestSucceeded) {
    Write-Host ""
    Write-Host "AVISO: no hay nada escuchando en localhost:27017." -ForegroundColor Yellow
    Write-Host "       El backend va a arrancar igual, pero cualquier pantalla que" -ForegroundColor Yellow
    Write-Host "       pida datos va a fallar. Instala MongoDB o apunta MONGO_URL" -ForegroundColor Yellow
    Write-Host "       en backend\.env a una base de Atlas." -ForegroundColor Yellow
    Write-Host ""
}

# --- 3/3  arranque -----------------------------------------------
# DISABLE_SCHEDULERS=1: no sincroniza Printavo ni corre barridos contra la base.
Write-Host "[3/3] Arrancando backend (8000) y frontend (3000)..." -ForegroundColor Cyan

Start-Process powershell -ArgumentList '-NoExit','-Command',
    "cd '$PSScriptRoot\backend'; `$env:DISABLE_SCHEDULERS='1'; .\venv\Scripts\python.exe -m uvicorn server:app --port 8000 --reload"

Start-Process powershell -ArgumentList '-NoExit','-Command',
    "cd '$PSScriptRoot\frontend'; npm start"

Write-Host ""
Write-Host "  Backend:  http://localhost:8000" -ForegroundColor Green
Write-Host "  Frontend: http://localhost:3000" -ForegroundColor Green
Write-Host ""
