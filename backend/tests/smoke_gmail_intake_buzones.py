"""Smoke: un buzon de Gmail por cliente en el intake.

Cada cliente puede conectar SU buzon con el boton "Conectar con Gmail"; el que
no lo hace se sigue leyendo del buzon general (el de siempre). Aqui se prueba,
sin red ni base, que:

  1. cada cliente se lee del buzon que le toca (propio o general);
  2. las quotes de un cliente con buzon propio salen a nombre de quien lo conecto;
  3. un buzon caido NO detiene a los demas clientes (queda como aviso);
  4. si nada se pudo leer y fue el general, la pasada falla como autenticacion;
  5. un cliente inactivo no se lee;
  6. "releer" un item abre el buzon de SU cliente, no el general.

Corre: backend/venv/Scripts/python.exe backend/tests/smoke_gmail_intake_buzones.py
"""
import asyncio
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
os.environ.setdefault("MONGODB_URL", "mongodb://localhost:27017")
os.environ.setdefault("DB_NAME", "mos-offline-test")
os.environ.setdefault("JWT_SECRET", "offline_secret")
os.environ.setdefault("MASTER_API_KEY", "smoke_master_key")
os.environ.setdefault("INTERNAL_SYNC_TOKEN", "smoke_sync_token")

import routers.gmail_intake as g  # noqa: E402

ok = fail = 0


def check(nombre, cond, detalle=""):
    global ok, fail
    if cond:
        ok += 1
        print(f"   PASS  {nombre}")
    else:
        fail += 1
        print(f"   FAIL  {nombre}  {detalle}")


class Coleccion:
    """Lo minimo de una coleccion de motor que usa el intake para buzones."""

    def __init__(self, docs=None):
        self.docs = list(docs or [])

    async def find_one(self, q, proj=None):
        for d in self.docs:
            if all(d.get(k) == v for k, v in q.items()):
                return dict(d)
        return None

    async def update_one(self, q, upd, upsert=False):
        for d in self.docs:
            if all(d.get(k) == v for k, v in q.items()):
                d.update(upd.get("$set", {}))
                return
        if upsert:
            self.docs.append({**q, **upd.get("$set", {})})

    async def count_documents(self, q):
        return len(self.docs)


class DB:
    def __init__(self, buzones):
        self.gmail_intake_buzones = Coleccion(buzones)


GOODIE = {"id": "principal", "nombre": "GOODIE", "label_name": "ordenes goodies", "activa": True}
SPK = {"id": "spk", "nombre": "SPEKTRUM", "label_name": "ordenes spektrum", "activa": True}
APAGADO = {"id": "off", "nombre": "APAGADO", "label_name": "otra", "activa": False}
ELVIA = {"user_id": "u-elvia", "email": "elvia@prosper-mfg.com", "name": "Elvia"}


def preparar(buzon_spk_ok=True, general_ok=True, hay_general=True):
    """Parcha el modulo: dos buzones falsos, cada uno con SU etiqueta."""
    g.db = DB([{"fuente_id": "spk", "email": "elvia@prosper-mfg.com", "connected_by": ELVIA,
                "credentials": {}}])

    async def general(user_id):
        return ("SVC_GENERAL", None) if general_ok else (None, "token general revocado")

    async def propio(fid):
        return ("SVC_SPK", None) if buzon_spk_ok else (None, "token revocado")

    async def plantillas():
        return []

    g._get_gmail_service = general
    g._get_buzon_service = propio
    g.plantillas_activas = plantillas
    # Cada buzon conoce SOLO su etiqueta: si un cliente se leyera del buzon
    # equivocado, su etiqueta "no existiria" y el smoke lo veria.
    etiquetas = {"SVC_GENERAL": {"ordenes goodies": "L_GTS"},
                 "SVC_SPK": {"ordenes spektrum": "L_SPK"}}
    g._label_map = lambda svc: dict(etiquetas[svc])
    g._ensure_mos_labels = lambda svc, labels: {**labels, **{n: n for n in g.MOS_LABELS}}
    g._list_message_ids = lambda svc, label, q, limit: (
        [] if isinstance(label, list) else [f"{svc}:{label}:m1"])
    procesados = []

    async def procesar(svc, cfg, fuente, labels, msg_id, forced):
        procesados.append((fuente["id"], svc, msg_id, fuente.get("_usuario")))
        return {"orders": 1, "ignored": False, "auto_created": 0}

    g._process_message = procesar
    cfg = {"user_id": "u-miguel" if hay_general else None, "fuentes": [GOODIE, SPK, APAGADO]}
    return cfg, procesados


async def main():
    print("\n1) cada cliente en su buzon; quotes a nombre de quien conecto")
    cfg, p = preparar()
    res = await g.run_once(cfg)
    por = {fid: (svc, usr) for fid, svc, _, usr in p}
    check("Goodie se lee del buzon GENERAL", por.get("principal", (None,))[0] == "SVC_GENERAL", f"{p}")
    check("Spektrum se lee de SU buzon", por.get("spk", (None,))[0] == "SVC_SPK", f"{p}")
    check("quotes de Spektrum a nombre de quien conecto su buzon",
          (por.get("spk") or (None, {}))[1] == ELVIA, f"{p}")
    check("Goodie sin usuario propio (usa el del buzon general)",
          (por.get("principal") or (None, 1))[1] is None, f"{p}")
    check("cliente inactivo no se lee", "off" not in por, f"{p}")
    check("sin avisos", res.get("avisos") == [], f"{res.get('avisos')}")
    check("la config no se ensucia con _usuario",
          all("_usuario" not in f for f in cfg["fuentes"]), f"{cfg['fuentes']}")

    print("\n2) buzon de Spektrum caido: Goodie sigue")
    cfg, p = preparar(buzon_spk_ok=False)
    res = await g.run_once(cfg)
    check("Goodie se leyo", any(fid == "principal" for fid, *_ in p), f"{p}")
    check("Spektrum no se leyo", not any(fid == "spk" for fid, *_ in p), f"{p}")
    check("queda aviso de Spektrum con su buzon",
          any("SPEKTRUM" in a and "elvia@" in a for a in res.get("avisos") or []), f"{res.get('avisos')}")
    check("no es error de autenticacion del general", not res.get("auth_error_general"))

    print("\n3) sin buzon general: el cliente con buzon propio igual se lee")
    cfg, p = preparar(hay_general=False)
    res = await g.run_once(cfg)
    check("Spektrum se leyo", any(fid == "spk" for fid, *_ in p), f"{p}")
    check("Goodie avisa que no tiene buzon",
          any("GOODIE" in a and "sin buzón" in a for a in res.get("avisos") or []), f"{res.get('avisos')}")

    print("\n4) nada se pudo leer y fue el general -> error de autenticacion")
    cfg, p = preparar(buzon_spk_ok=False, general_ok=False)
    try:
        await g.run_once(cfg)
        check("debia fallar", False)
    except PermissionError as e:
        check("PermissionError con el motivo del general", "general" in str(e), str(e))

    print("\n5) general caido pero Spektrum bien: pasa, y el general queda marcado")
    cfg, p = preparar(general_ok=False)
    res = await g.run_once(cfg)
    check("Spektrum se leyo", any(fid == "spk" for fid, *_ in p), f"{p}")
    check("auth_error_general anotado (la pantalla ofrece reconectar)",
          res.get("auth_error_general") == "token general revocado", f"{res.get('auth_error_general')}")

    print("\n6) releer abre el buzon del cliente del item")
    cfg, _ = preparar()
    svc, usr, err, clave, es_general = await g._servicio_para(cfg, SPK)
    check("Spektrum -> su buzon", svc == "SVC_SPK" and clave == "f:spk" and not es_general, f"{svc} {clave}")
    svc, usr, err, clave, es_general = await g._servicio_para(cfg, GOODIE)
    check("Goodie -> general", svc == "SVC_GENERAL" and es_general, f"{svc} {clave}")
    check("_todas_las_fuentes incluye inactivas",
          [f["id"] for f in g._todas_las_fuentes(cfg)] == ["principal", "spk", "off"])

    print(f"\n{'=' * 60}\n   {ok} PASS / {fail} FAIL\n{'=' * 60}")
    return 1 if fail else 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
