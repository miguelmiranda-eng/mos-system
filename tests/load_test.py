# -*- coding: utf-8 -*-
"""
MOS System - Load Test (30 usuarios simultaneos)
================================================
Simula el patron real del frontend:
  - GET /api/orders           (polling cada ~5s)
  - GET /api/config/options   (al cargar)
  - GET /api/notifications    (polling)
  - PATCH /api/orders/:id     (edicion de celda, menos frecuente)

Uso:
  $env:MOS_SESSION_TOKEN = "pega_tu_token_aqui"
  python tests/load_test.py
"""

import asyncio
import httpx
import time
import statistics
import sys
import os
from datetime import datetime

# ── Config ─────────────────────────────────────────────────────────────────────
BASE_URL       = "http://localhost:8000"
TOTAL_USERS    = 30
RAMP_UP_SECS   = 5      # segundos para escalar de 0 a 30
DURATION_SECS  = 30     # duracion del test despues del ramp-up
TIMEOUT_SECS   = 10

SESSION_TOKEN  = os.environ.get("MOS_SESSION_TOKEN", "")

# ── Buckets de resultados ──────────────────────────────────────────────────────
endpoint_times: dict[str, list[float]] = {
    "GET /api/orders":          [],
    "GET /api/config/options":  [],
    "GET /api/notifications":   [],
    "PATCH /api/orders/:id":    [],
}
error_count: list[int]  = [0]         # mutable list workaround for asyncio
error_log:   list[str]  = []
sample_oid:  list[str]  = [""]        # order_id para writes

# ── Helpers ────────────────────────────────────────────────────────────────────
def get_headers() -> dict[str, str]:
    h: dict[str, str] = {"Content-Type": "application/json"}
    if SESSION_TOKEN:
        h["Authorization"] = f"Bearer {SESSION_TOKEN}"
    return h

def get_cookies() -> dict[str, str]:
    if SESSION_TOKEN:
        return {"session_token": SESSION_TOKEN}
    return {}

async def timed_get(client: httpx.AsyncClient, url: str, label: str) -> None:
    t0 = time.perf_counter()
    try:
        r = await client.get(
            url, headers=get_headers(), cookies=get_cookies(),
            timeout=TIMEOUT_SECS, follow_redirects=True
        )
        ms = (time.perf_counter() - t0) * 1000
        if r.status_code in (200, 304):
            endpoint_times[label].append(ms)
        else:
            error_count[0] += 1
            error_log.append(f"{label} -> HTTP {r.status_code}")
    except Exception as exc:
        error_count[0] += 1
        error_log.append(f"{label} -> {type(exc).__name__}")

async def timed_patch(client: httpx.AsyncClient, order_id: str, label: str) -> None:
    if not order_id:
        return
    t0 = time.perf_counter()
    try:
        r = await client.put(                          # backend uses PUT not PATCH
            f"{BASE_URL}/api/orders/{order_id}",
            json={"notes": f"load_test_{int(time.time())}"},
            headers=get_headers(), cookies=get_cookies(),
            timeout=TIMEOUT_SECS,
        )
        ms = (time.perf_counter() - t0) * 1000
        if r.status_code in (200, 204):
            endpoint_times[label].append(ms)
        else:
            error_count[0] += 1
            error_log.append(f"{label} -> HTTP {r.status_code}")
    except Exception as exc:
        error_count[0] += 1
        error_log.append(f"{label} -> {type(exc).__name__}")

async def fetch_sample_order() -> None:
    """Obtiene un order_id real para usar en los tests de escritura."""
    async with httpx.AsyncClient() as c:
        try:
            r = await c.get(
                f"{BASE_URL}/api/orders",
                headers=get_headers(), cookies=get_cookies(), timeout=10
            )
            if r.status_code == 200:
                data = r.json()
                orders = data if isinstance(data, list) else data.get("orders", [])
                if orders and isinstance(orders, list):
                    oid = orders[0].get("order_id") or str(orders[0].get("_id", ""))
                    if oid:
                        sample_oid[0] = oid
        except Exception:
            pass

# ── Simula una sesion de usuario ───────────────────────────────────────────────
async def simulate_user(user_id: int, end_at: float) -> None:
    async with httpx.AsyncClient() as client:
        cycle = 0
        while time.time() < end_at:
            cycle += 1
            await timed_get(client, f"{BASE_URL}/api/orders",           "GET /api/orders")
            await timed_get(client, f"{BASE_URL}/api/config/options",   "GET /api/config/options")
            await timed_get(client, f"{BASE_URL}/api/notifications",    "GET /api/notifications")

            if cycle % 3 == 0 and sample_oid[0]:
                await timed_patch(client, sample_oid[0],                "PATCH /api/orders/:id")

            await asyncio.sleep(2.5)

# ── Reporte ────────────────────────────────────────────────────────────────────
def pct(times: list[float], p: float) -> float:
    if not times:
        return 0.0
    idx = min(int(len(times) * p), len(times) - 1)
    return sorted(times)[idx]

def threshold_label(ms: float) -> str:
    if ms < 300:
        return "RAPIDO"
    if ms < 800:
        return "ACEPTABLE"
    return "LENTO"

def print_report(elapsed: float) -> None:
    SEP = "=" * 70
    print(f"\n{SEP}")
    print(f"  MOS SYSTEM -- LOAD TEST REPORT")
    print(f"  {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
    print(f"  Usuarios: {TOTAL_USERS}  |  Duracion: {DURATION_SECS}s  |  Ramp-up: {RAMP_UP_SECS}s")
    print(SEP)

    total_ok  = sum(len(v) for v in endpoint_times.values())
    total_req = total_ok + error_count[0]
    rps       = total_req / elapsed if elapsed > 0 else 0

    print(f"\n  Total requests : {total_req}")
    print(f"  Exitosos       : {total_ok}")
    print(f"  Errores        : {error_count[0]}")
    print(f"  Throughput     : {rps:.1f} req/s")
    print(f"  Duracion real  : {elapsed:.1f}s\n")

    header = f"  {'ENDPOINT':<32} {'N':>5}  {'p50':>9}  {'p95':>9}  {'MAX':>9}  ESTADO"
    print(header)
    print("  " + "-" * 68)

    all_good = True
    for label, times in endpoint_times.items():
        if not times:
            print(f"  {label:<32} {'0':>5}  (sin respuestas exitosas)")
            continue
        s     = sorted(times)
        n     = len(s)
        p50   = statistics.median(s)
        p95v  = pct(s, 0.95)
        maxv  = s[-1]
        state = threshold_label(p95v)
        if state == "LENTO":
            all_good = False
        print(
            f"  {label:<32} {n:>5}  "
            f"{p50:>8.0f}ms  {p95v:>8.0f}ms  {maxv:>8.0f}ms  {state}"
        )

    if error_log:
        print(f"\n  Errores (primeros 10):")
        for e in error_log[:10]:
            print(f"    - {e}")

    verdict_ok  = all_good and error_count[0] == 0
    verdict_msg = (
        "[OK] LISTO PARA DEPLOY CON 30 USUARIOS"
        if verdict_ok else
        "[!]  REVISAR ITEMS LENTOS ANTES DEL DEPLOY"
    )

    print(f"\n{SEP}")
    print(f"  VEREDICTO: {verdict_msg}")
    print(f"{SEP}\n")

# ── Main ───────────────────────────────────────────────────────────────────────
async def main() -> None:
    print("\n[MOS LOAD TEST]")
    print(f"  Target  : {BASE_URL}")
    print(f"  Usuarios: {TOTAL_USERS} | Duracion: {DURATION_SECS}s | Ramp-up: {RAMP_UP_SECS}s")

    if not SESSION_TOKEN:
        print("\n  [!] Sin SESSION_TOKEN -- endpoints protegidos devolveron 401.")
        print("      Solo se testean endpoints publicos.")
        print("      Para test completo:")
        print("      $env:MOS_SESSION_TOKEN = 'pega_tu_token_aqui'\n")

    # Health check
    print("[1/3] Verificando backend...")
    try:
        async with httpx.AsyncClient() as c:
            r = await c.get(f"{BASE_URL}/api/config/options", timeout=5)
            status = "OK" if r.status_code < 500 else f"ERROR {r.status_code}"
            print(f"      -> Backend: {status} (HTTP {r.status_code})")
            if r.status_code >= 500:
                sys.exit(1)
    except Exception as e:
        print(f"      -> No responde: {e}")
        sys.exit(1)

    # Obtener order_id de muestra
    print("[2/3] Obteniendo order_id de muestra para writes...")
    await fetch_sample_order()
    if sample_oid[0]:
        print(f"      -> order_id: {sample_oid[0]}")
    else:
        print("      -> Sin auth o sin ordenes - writes desactivados")

    # Ejecutar test
    end_at            = time.time() + RAMP_UP_SECS + DURATION_SECS
    delay_per_user    = RAMP_UP_SECS / TOTAL_USERS

    print(f"[3/3] Iniciando {TOTAL_USERS} usuarios virtuales (ramp-up {RAMP_UP_SECS}s)...")
    t0    = time.perf_counter()
    tasks = []

    for i in range(TOTAL_USERS):
        await asyncio.sleep(delay_per_user)
        tasks.append(asyncio.create_task(simulate_user(i, end_at)))
        if (i + 1) % 10 == 0:
            print(f"      + {i+1}/{TOTAL_USERS} usuarios activos")

    print(f"      >> Corriendo durante {DURATION_SECS}s...")
    await asyncio.gather(*tasks)

    elapsed = time.perf_counter() - t0
    print_report(elapsed)


if __name__ == "__main__":
    # Forzar encoding UTF-8 en Windows para evitar errores de consola
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    asyncio.run(main())
