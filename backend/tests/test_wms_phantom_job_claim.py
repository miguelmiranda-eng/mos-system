"""El claim del job nocturno de stock fantasma no puede dispararse dos veces.

POR QUE EXISTE ESTA PRUEBA
──────────────────────────
El job corria con un `sleep` hasta las 08:00 calculado EN MEMORIA en cada
arranque. Un contenedor que se reinicia una vez al dia reiniciaba la cuenta
antes de llegar a la hora, y el escaneo no disparaba NUNCA: verificado el
2026-08-03, la ultima corrida era del 2026-07-29 — cinco dias de descuadres
invisibles con la pestana Stock Fantasma mostrando datos rancios.

Al mover el estado a la base aparece el riesgo opuesto: que DOS workers de
uvicorn (o dos reinicios seguidos) corran el escaneo completo a la vez sobre
la misma coleccion. El claim lo impide comparando y pisando `last_run_at` en
UNA sola operacion. Esta prueba congela las tres ramas de esa decision.

    python backend/tests/test_wms_phantom_job_claim.py
"""
import asyncio
import os
import sys
from datetime import datetime, timedelta, timezone

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))


class _DuplicateKeyError(Exception):
    pass


class FakeCounters:
    """wms_counters minimo: honra el indice unico de `_id` y el filtro del claim."""

    def __init__(self, docs=None):
        self.docs = dict(docs or {})
        self.inserts = 0

    async def find_one_and_update(self, filtro, update, return_document=None):
        _id = filtro["_id"]
        doc = self.docs.get(_id)
        if doc is None:
            return None
        corte = filtro.get("last_run_at", {}).get("$lt")
        if corte is not None and not (doc.get("last_run_at", "") < corte):
            return None
        doc.update(update["$set"])
        return doc

    async def insert_one(self, doc):
        if doc["_id"] in self.docs:
            raise _DuplicateKeyError(doc["_id"])
        self.docs[doc["_id"]] = dict(doc)
        self.inserts += 1


JOB = "phantom_scan_job"


async def claim(counters, max_horas):
    """Copia fiel de _claim_phantom_scan (routers/wms.py) sobre el doble."""
    corte = (datetime.now(timezone.utc) - timedelta(hours=max_horas)).isoformat()
    doc = await counters.find_one_and_update(
        {"_id": JOB, "last_run_at": {"$lt": corte}},
        {"$set": {"last_run_at": datetime.now(timezone.utc).isoformat()}},
        return_document=True,
    )
    if doc is not None:
        return True
    try:
        await counters.insert_one({"_id": JOB,
                                   "last_run_at": datetime.now(timezone.utc).isoformat()})
        return True
    except _DuplicateKeyError:
        return False


def _hace(horas):
    return (datetime.now(timezone.utc) - timedelta(hours=horas)).isoformat()


async def _pruebas():
    ok = []

    # 1. Primera vez en la vida: corre y deja la marca.
    c = FakeCounters()
    assert await claim(c, 20) is True
    assert c.inserts == 1
    ok.append("primera_corrida_gana_el_claim")

    # 2. Reinicio inmediato: NO vuelve a correr (el bug opuesto al original).
    assert await claim(c, 20) is False
    assert c.inserts == 1
    ok.append("reinicio_inmediato_no_repite_el_escaneo")

    # 3. El caso que rompio en produccion: 5 dias sin correr -> catch-up.
    c = FakeCounters({JOB: {"_id": JOB, "last_run_at": _hace(24 * 5)}})
    assert await claim(c, 30) is True
    ok.append("cinco_dias_sin_correr_dispara_catch_up")

    # 4. Corrio hace 10 h: ni en horario (20 h) ni por atraso (30 h).
    c = FakeCounters({JOB: {"_id": JOB, "last_run_at": _hace(10)}})
    assert await claim(c, 20) is False
    assert await claim(c, 30) is False
    ok.append("corrida_reciente_no_se_repite")

    # 5. Corrio hace 22 h y es la hora del job: entra por la ventana de 20 h,
    #    pero no habria entrado por la de atraso (30 h).
    c = FakeCounters({JOB: {"_id": JOB, "last_run_at": _hace(22)}})
    assert await claim(c, 30) is False
    assert await claim(c, 20) is True
    ok.append("ventana_horaria_de_20h_permite_la_corrida_diaria")

    # 6. Dos workers a la vez sobre una base virgen: solo UNO gana.
    c = FakeCounters()
    r = await asyncio.gather(*(claim(c, 20) for _ in range(4)))
    assert sum(1 for x in r if x) == 1, r
    assert c.inserts == 1
    ok.append("cuatro_workers_simultaneos_solo_uno_escanea")

    # 7. Dos workers a la vez con la marca vencida: solo UNO gana.
    c = FakeCounters({JOB: {"_id": JOB, "last_run_at": _hace(48)}})
    r = await asyncio.gather(*(claim(c, 30) for _ in range(4)))
    assert sum(1 for x in r if x) == 1, r
    ok.append("marca_vencida_con_varios_workers_solo_uno_escanea")

    return ok


def test_claim_del_job_nocturno():
    for n in asyncio.run(_pruebas()):
        print(f"  PASS  {n}")


if __name__ == "__main__":
    try:
        test_claim_del_job_nocturno()
        print("\n7/7 pruebas OK")
        sys.exit(0)
    except AssertionError as e:
        print(f"  FAIL  {e}")
        sys.exit(1)
