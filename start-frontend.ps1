# ============================================================
#  MOS frontend en local, contra el backend de EasyPanel.
#
#    powershell -ExecutionPolicy Bypass -File "<ruta>\start-frontend.ps1"
#
#  No levanta backend ni Mongo: el backend que responde es el de
#  produccion. La URL sale de frontend\.env (REACT_APP_BACKEND_URL).
# ============================================================
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

# PATH fresco, por si Node se instalo con la consola ya abierta.
$env:Path = [Environment]::GetEnvironmentVariable('Path','Machine') + ';' +
            [Environment]::GetEnvironmentVariable('Path','User')

if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
    Write-Host "ERROR: no encuentro npm en el PATH. Reabre PowerShell." -ForegroundColor Red
    exit 1
}
if (-not (Test-Path frontend\.env)) {
    Write-Host "ERROR: falta frontend\.env con REACT_APP_BACKEND_URL." -ForegroundColor Red
    exit 1
}

if (-not (Test-Path frontend\node_modules)) {
    Write-Host "Instalando dependencias de npm (tarda varios minutos)..." -ForegroundColor Cyan
    npm --prefix frontend install
}

$destino = (Select-String -Path frontend\.env -Pattern '^\s*REACT_APP_BACKEND_URL=(.+)$').Matches.Groups[1].Value
Write-Host ""
Write-Host "  Frontend: http://localhost:3000" -ForegroundColor Green
Write-Host "  Backend:  $destino" -ForegroundColor Yellow
if ($destino -notmatch 'localhost') {
    Write-Host "  Los datos son REALES: lo que guardes se guarda en produccion." -ForegroundColor Yellow
}
Write-Host ""

Set-Location frontend
npm start
