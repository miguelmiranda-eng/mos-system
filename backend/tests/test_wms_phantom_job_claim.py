"""El turno del job nocturno de stock fantasma: ni se duplica ni se pierde.

DOS MODOS DE FALLO, LOS DOS VISTOS EN VIVO
──────────────────────────────────────────
1. NO CORRER NUNCA. El job usaba un `sleep` hasta las 08:00 calculado EN
   MEMORIA en cada arranque, asi que un contenedor que se reinicia una vez al
   dia reiniciaba la cuenta antes de llegar a la hora y el escaneo no disparaba
   JAMAS. Verificado el 2026-08-03: la ultima corrida era del 2026-07-29 —
   cinco dias de descuadres invisibles con la pestana Stock Fantasma mostrando
   datos rancios sin avisar que lo eran.

2. QUEMAR EL DIA CON UN FALLO. La primera correccion movio el estado a la base,
   pero pisaba `last_run_at` ANTES de ejecutar. Si el escaneo reventaba a
   medias, la ventana de 20-30 h bloqueaba el reintento HASTA EL DIA SIGUIENTE.
   Observado el 2026-08-03 23:19: el job reclamo su turno y cinco minutos
   despues no habia terminado ni dejado rastro.

La solucion son DOS marcas: `last_run_at` (ultima corrida EXITOSA, se escribe al
terminar) y `running_since` (turno tomado, se libera pase lo que pase, y caduca
solo si el proceso murio). Esta prueba congela ambas.

    python backend/tests/test_wms_phantom_job_claim.py
"""
import asyncio
import os
import sys
from datetime import datetime, timedelta, timezone

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

JOB = "phantom_scan_job"
LOCK_H = 3          # espejo de _PHANTOM_LOCK_H
EPOCH = "1970-01-01T00:00:00+00:00"


class _DuplicateKeyError(Exception):
    pass


class FakeCounters:
    """wms_counters minimo: honra el indice unico de `_id`, $exists y $unset."""

    def __init__(self, docs=None):
        self.docs = {k: dict(v) for k, v in (docs or {}).items()}
        self.inserts = 0

    def _casa(self, doc, filtro):
        for campo, cond in filtro.items():
            if campo == "_id":
                continue
            if campo == "$or":
                if not any(self._casa(doc, c) for c in cond):
                    return False
                continue
            val = doc.get(campo)
            if isinstance(cond, dict):
                if "$lt" in cond and not (val is not None and val < cond["$lt"]):
                    return False
                if "$exists" in cond and (campo in doc) != cond["$exists"]:
                    return False
            elif val != cond:
                return False
        return True

    async def find_one_and_update(self, filtro, update, return_document=None):
        doc = self.docs.get(filtro["_id"])
        if doc is None or not self._casa(doc, filtro):
            return None
        doc.update(update.get("$set", {}))
        for k in update.get("$unset", {}):
            doc.pop(k, None)
        return doc

    async def update_one(self, filtro, update):
        doc = self.docs.get(filtro["_id"])
        if doc is None:
            return
        doc.update(update.get("$set", {}))
        for k in update.get("$unset", {}):
            doc.pop(k, None)

    async def insert_one(self, doc):
        if doc["_id"] in self.docs:
            raise _DuplicateKeyError(doc["_id"])
        self.docs[doc["_id"]] = dict(doc)
        self.inserts += 1


def _iso(dt):
    return dt.isoformat()


def _hace(horas):
    return _iso(datetime.now(timezone.utc) - timedelta(hours=horas))


async def claim(counters, max_horas):
    """Copia fiel de _claim_phantom_scan (routers/wms.py) sobre el doble."""
    ahora = datetime.now(timezone.utc)
    corte_exito = _iso(ahora - timedelta(hours=max_horas))
    corte_lock = _iso(ahora - timedelta(hours=LOCK_H))
    doc = await counters.find_one_and_update(
        {"_id": JOB, "last_run_at": {"$lt": corte_exito},
         "$or": [{"running_since": {"$exists": False}},
                 {"running_since": None},
                 {"running_since": {"$lt": corte_lock}}]},
        {"$set": {"running_since": _iso(ahora)}}, return_document=True)
    if doc is not None:
        return True
    try:
        await counters.insert_one({"_id": JOB, "last_run_at": EPOCH,
                                   "running_since": _iso(ahora)})
        return True
    except _DuplicateKeyError:
        return False


async def release(counters, exito):
    """Copia fiel de _release_phantom_scan."""
    upd = {"$unset": {"running_since": ""}}
    if exito:
        upd["$set"] = {"last_run_at": _iso(datetime.now(timezone.utc))}
    await counters.update_one({"_id": JOB}, upd)


async def _pruebas():
    ok = []

    # 1. Primera vez en la vida: corre y deja la marca.
    c = FakeCounters()
    assert await claim(c, 20) is True
    assert c.inserts == 1
    await release(c, True)
    ok.append("primera_corrida_toma_el_turno")

    # 2. Reinicio inmediato tras un exito: NO repite.
    assert await claim(c, 20) is False
    ok.append("reinicio_tras_exito_no_repite")

    # 3. EL MODO DE FALLO 1: cinco dias sin correr -> catch-up.
    c = FakeCounters({JOB: {"_id": JOB, "last_run_at": _hace(24 * 5)}})
    assert await claim(c, 30) is True
    ok.append("cinco_dias_sin_correr_dispara_catch_up")

    # 4. EL MODO DE FALLO 2: si el escaneo revienta, el turno se libera y
    #    `last_run_at` NO avanza -> el siguiente tick REINTENTA.
    c = FakeCounters({JOB: {"_id": JOB, "last_run_at": _hace(48)}})
    assert await claim(c, 30) is True
    await release(c, False)                      # el escaneo fallo
    assert c.docs[JOB]["last_run_at"] < _hace(24)  # sigue viejo
    assert "running_since" not in c.docs[JOB]      # turno liberado
    assert await claim(c, 30) is True             # reintenta ENSEGUIDA
    ok.append("un_fallo_NO_quema_el_dia_reintenta")

    # 5. Tras un exito real, `last_run_at` si avanza y ya no reintenta.
    await release(c, True)
    assert c.docs[JOB]["last_run_at"] > _hace(1)
    assert await claim(c, 30) is False
    ok.append("exito_avanza_last_run_at_y_cierra_la_ventana")

    # 6. Turno tomado hace un rato: nadie mas entra (no hay doble escaneo).
    c = FakeCounters({JOB: {"_id": JOB, "last_run_at": _hace(48),
                            "running_since": _hace(1)}})
    assert await claim(c, 30) is False
    ok.append("turno_en_curso_bloquea_a_los_demas")

    # 7. Turno colgado (proceso muerto sin liberar): caduca a las LOCK_H.
    c = FakeCounters({JOB: {"_id": JOB, "last_run_at": _hace(48),
                            "running_since": _hace(LOCK_H + 1)}})
    assert await claim(c, 30) is True
    ok.append("turno_colgado_caduca_y_no_bloquea_para_siempre")

    # 8. Corrio hace 10 h: ni por horario (20 h) ni por atraso (30 h).
    c = FakeCounters({JOB: {"_id": JOB, "last_run_at": _hace(10)}})
    assert await claim(c, 20) is False
    assert await claim(c, 30) is False
    ok.append("corrida_reciente_no_se_repite")

    # 9. Hace 22 h y es la hora del job: entra por la ventana de 20 h.
    c = FakeCounters({JOB: {"_id": JOB, "last_run_at": _hace(22)}})
    assert await claim(c, 30) is False
    assert await claim(c, 20) is True
    ok.append("ventana_horaria_de_20h_permite_la_corrida_diaria")

    # 10. Cuatro workers sobre una base virgen: solo UNO gana.
    c = FakeCounters()
    r = await asyncio.gather(*(claim(c, 20) for _ in range(4)))
    assert sum(1 for x in r if x) == 1, r
    assert c.inserts == 1
    ok.append("cuatro_workers_simultaneos_solo_uno_escanea")

    # 11. Cuatro workers con la marca vencida: solo UNO gana.
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
        print("\n11/11 pruebas OK")
        sys.exit(0)
    except AssertionError as e:
        print(f"  FAIL  {e}")
        sys.exit(1)
