"""Permisos por ACCIÓN del WMS — doble escalera, configurables desde Sistema →
Configuración → Permisos.

Antes cada endpoint tenía su umbral fijo en código (`require_admin_level(2)`,
`require_inventory_level(3)`, `require_location_admin`…) y cambiar quién puede
eliminar una ubicación era un deploy. Ahora cada acción del catálogo declara
qué nivel exige en CADA escalera del usuario, y el supersu lo edita en Mongo
(`config_options.wms_actions`):

  · escalera ADMIN:      supersu = 6 · admin = su admin_level (1..5) · resto = 0
  · escalera INVENTARIO: el inventory_level numérico del usuario (0..3), sin
                         fusión con admin (la fusión vieja de deps.get_admin_level /
                         get_inventory_level queda ENCODADA en los defaults).

Un usuario pasa si cumple CUALQUIERA de las dos escaleras habilitadas
("inventarios ≥ 2 O admin ≥ 1"). None = esa escalera no concede la acción;
0 = cualquier usuario autenticado; 6 en admin = solo supersu. El supersu
siempre pasa.

Los DEFAULTS reproducen exactamente los umbrales que había en código, para que
desplegar esto no cambie ningún permiso. Cada acción trae además un PISO por
escalera (lo mínimo que se puede configurar: eliminar ubicaciones nunca bajará
de admin 3) y `locked` para las que no se editan (repartir permisos).

Puro: sin base, sin FastAPI. `routers/wms.py` pone el `require_action`.
"""
from __future__ import annotations

SUPERSU_LEVEL = 6      # solo supersu (escalera admin)
ALL_LEVEL = 0          # cualquier usuario autenticado
MAX_ADMIN = 5
MAX_INVENTORY = 3
INV_OFF = "off"        # piso: la escalera de inventarios NO puede conceder esta acción

GROUPS = [
    ("locations", "Ubicaciones"),
    ("inventory", "Inventario"),
    ("cycle_count", "Conteo cíclico y tareas"),
    ("quarantine", "Cuarentena"),
    ("recon", "Conciliación"),
    ("asn", "Entradas"),
    ("picking", "Surtido y terminados"),
    ("catalog", "Catálogo UPC"),
    ("notifications", "Notificaciones"),
    ("config", "Configuración"),
]


def _a(label, group, admin, inventory, *, floor_admin=0, floor_inventory=0, locked=False, desc=""):
    return {"label": label, "group": group, "admin": admin, "inventory": inventory,
            "floor_admin": floor_admin, "floor_inventory": floor_inventory, "locked": locked, "desc": desc}


# id → definición. El ORDEN es el de la pantalla. `admin`/`inventory` son los
# defaults (= umbral que había en código, ver el comentario de cada una).
ACTIONS: dict = {
    # ── Ubicaciones ─────────────────────────────────────────────────────────
    "locations.create": _a("Crear ubicaciones", "locations", 5, None, floor_admin=3, floor_inventory=3,
                           desc="Alta de racks, slots y carros (Ubicaciones y Tránsito → Crear carros)."),
    "locations.rename": _a("Renombrar ubicaciones", "locations", 3, 3, floor_admin=1, floor_inventory=1,
                           desc="Cambiar nombre o zona de una ubicación existente."),
    "locations.delete": _a("Eliminar ubicaciones", "locations", 5, None, floor_admin=3, floor_inventory=3,
                           desc="Borrar una ubicación (con force deja cajas huérfanas)."),
    "locations.hold": _a("Bloquear / liberar ubicaciones (HOLD)", "locations", 2, 3, floor_admin=1, floor_inventory=1,
                         desc="Poner o quitar retención SAT sobre una ubicación."),
    # ── Inventario ──────────────────────────────────────────────────────────
    "inventory.add_manual": _a("Alta manual de inventario", "inventory", 1, 2, floor_admin=1, floor_inventory=1,
                               desc="Agregar una línea de inventario a mano."),
    "inventory.adjust_box": _a("Ajustar unidades de una caja", "inventory", 1, 2, floor_admin=1, floor_inventory=1,
                               desc="Cambiar la cantidad de una caja (ajuste con motivo)."),
    "inventory.delete_box": _a("Eliminar cajas", "inventory", 2, 3, floor_admin=2, floor_inventory=2,
                               desc="Borrar una caja del sistema."),
    "inventory.delete_row": _a("Eliminar renglones de inventario", "inventory", 2, 3, floor_admin=2, floor_inventory=2,
                               desc="Borrar un renglón de inventario (identidad + ubicación)."),
    "inventory.import": _a("Importar inventario desde Excel", "inventory", 3, 3, floor_admin=3, floor_inventory=3,
                           desc="Carga masiva de inventario."),
    # ── Conteo cíclico / tareas ─────────────────────────────────────────────
    "cycle_count.operate": _a("Crear y capturar conteos", "cycle_count", 1, 1, floor_admin=0, floor_inventory=0,
                              desc="Crear conteos, escanear y cerrar ubicaciones, guardar conteo."),
    "cycle_count.approve": _a("Aprobar y eliminar conteos", "cycle_count", 1, 2, floor_admin=1, floor_inventory=1,
                              desc="Aprobar un conteo (aplica ajustes) o borrarlo."),
    "cycle_count.supervise": _a("Supervisar: 3er conteo y reportes", "cycle_count", 1, 3, floor_admin=1, floor_inventory=2,
                                desc="Resolver como supervisor, reportes, KPIs y eficiencia."),
    "location_check.resolve": _a("Resolver tareas Location Check", "cycle_count", 1, 1, floor_admin=0, floor_inventory=0,
                                 desc="Cerrar la tarea (encontrada / no estaba aquí → mueve la caja)."),
    # ── Cuarentena ──────────────────────────────────────────────────────────
    "quarantine.resolve": _a("Resolver cuarentena", "quarantine", 1, 2, floor_admin=1, floor_inventory=1,
                             desc="Liberar o dar de baja material en cuarentena."),
    # ── Conciliación ────────────────────────────────────────────────────────
    "recon.manage": _a("Conciliación (ver y resolver)", "recon", SUPERSU_LEVEL, None, floor_admin=5, floor_inventory=INV_OFF,
                       desc="Segundo conteo, resolver, reabrir, stock fantasma."),
    # ── Entradas ────────────────────────────────────────────────────────────
    "asn.edit": _a("Editar / reabrir entradas", "asn", 3, 3, floor_admin=1, floor_inventory=1,
                   desc="Modificar líneas de una entrada o reabrirla."),
    "asn.columns": _a("Columnas personalizadas de entradas", "asn", 3, 3, floor_admin=3, floor_inventory=3,
                      desc="Definir las columnas extra de la hoja de entradas."),
    "asn.part_number_config": _a("Configurar número de parte / IMMEX", "asn", 3, 3, floor_admin=3, floor_inventory=3,
                                 desc="Prefijos, prendas, fibras, composiciones, descripciones, países."),
    # ── Surtido y terminados ────────────────────────────────────────────────
    "picking.manage": _a("Asignar / priorizar tickets y ligar cajas", "picking", 3, 3, floor_admin=1, floor_inventory=1,
                         desc="Asignar picker, prioridad y ligar caja a un pick ticket."),
    "finished.edit": _a("Editar producto terminado", "picking", 3, 3, floor_admin=1, floor_inventory=1,
                        desc="Modificar una caja de terminados."),
    # ── Catálogo UPC ────────────────────────────────────────────────────────
    "upc.correct": _a("Corregir / eliminar UPC", "catalog", 3, 3, floor_admin=2, floor_inventory=2,
                      desc="Corregir la identidad de un UPC o borrarlo del catálogo."),
    "audit.apply_sku_catalog": _a("Aplicar correcciones de SKU desde Auditoría", "catalog", SUPERSU_LEVEL, None, floor_admin=5, floor_inventory=INV_OFF,
                                  desc="Reescribe identidades de inventario desde el catálogo."),
    # ── Notificaciones ──────────────────────────────────────────────────────
    "notifications.push": _a("Recibir alertas push en el dispositivo", "notifications", 2, 3, floor_admin=1, floor_inventory=1,
                             desc="Suscribir este dispositivo a alertas de descuadre."),
    # ── Configuración ───────────────────────────────────────────────────────
    "config.permissions": _a("Repartir permisos y accesos por módulo", "config", SUPERSU_LEVEL, None, floor_admin=SUPERSU_LEVEL, floor_inventory=INV_OFF, locked=True,
                             desc="Solo supersu. No se puede delegar."),
}


# ── escaleras del usuario ────────────────────────────────────────────────────
def user_ladders(user: dict | None) -> tuple[int, int]:
    """(admin, inventario) PUROS: sin la fusión inv3→admin3 ni admin→inv3."""
    u = user or {}
    role = u.get("role")
    if role == "supersu":
        admin = SUPERSU_LEVEL
    elif role == "admin":
        try:
            admin = int(u.get("admin_level") or 1)
        except (TypeError, ValueError):
            admin = 1
        admin = max(1, min(MAX_ADMIN, admin))
    else:
        admin = 0
    try:
        inv = int(u.get("inventory_level") or 0)
    except (TypeError, ValueError):
        inv = 0
    return admin, max(0, min(MAX_INVENTORY, inv))


def allows(levels: dict, user: dict | None) -> bool:
    """¿`user` cumple `levels` = {'admin': x|None, 'inventory': y|None}?"""
    admin, inv = user_ladders(user)
    if admin >= SUPERSU_LEVEL:
        return True
    a, i = levels.get("admin"), levels.get("inventory")
    if a is not None and admin >= int(a):
        return True
    if i is not None and inv >= int(i):
        return True
    return False


# ── configuración efectiva ───────────────────────────────────────────────────
def defaults() -> dict:
    return {k: {"admin": v["admin"], "inventory": v["inventory"]} for k, v in ACTIONS.items()}


def merge(stored: dict | None) -> dict:
    """Defaults con lo guardado encima; lo guardado se re-valida (si un piso
    subió en código, el valor viejo por debajo se descarta)."""
    out = defaults()
    for k, v in (stored or {}).items():
        if k not in ACTIONS or not isinstance(v, dict):
            continue
        try:
            out[k] = normalize(k, v)
        except ValueError:
            pass
    return out


def _int_or_none(v, name):
    if v is None or v == "" or v == "none":
        return None
    try:
        return int(v)
    except (TypeError, ValueError):
        raise ValueError(f"{name}: valor inválido '{v}'")


def normalize(action_id: str, levels: dict) -> dict:
    """Valida un par de niveles contra rangos, pisos y candado. Devuelve el
    par limpio o levanta ValueError con un mensaje legible."""
    d = ACTIONS.get(action_id)
    if not d:
        raise ValueError(f"acción desconocida '{action_id}'")
    a = _int_or_none(levels.get("admin"), "admin")
    i = _int_or_none(levels.get("inventory"), "inventory")
    if d["locked"] and (a != d["admin"] or i != d["inventory"]):
        raise ValueError(f"'{d['label']}' no se puede cambiar")
    if a is not None and not (ALL_LEVEL <= a <= SUPERSU_LEVEL):
        raise ValueError(f"'{d['label']}': admin debe estar entre {ALL_LEVEL} y {SUPERSU_LEVEL}")
    if i is not None and not (ALL_LEVEL <= i <= MAX_INVENTORY):
        raise ValueError(f"'{d['label']}': inventarios debe estar entre {ALL_LEVEL} y {MAX_INVENTORY}")
    if a is not None and a < d["floor_admin"]:
        raise ValueError(f"'{d['label']}': admin no puede bajar de {d['floor_admin']}")
    if i is not None:
        if d["floor_inventory"] == INV_OFF:
            raise ValueError(f"'{d['label']}': la escalera de inventarios no puede conceder esta acción")
        if i < d["floor_inventory"]:
            raise ValueError(f"'{d['label']}': inventarios no puede bajar de {d['floor_inventory']}")
    if a is None and i is None:
        a = SUPERSU_LEVEL   # nadie salvo supersu: forma canónica
    return {"admin": a, "inventory": i}


def allowed_for(levels_by_action: dict, user: dict | None) -> list:
    return [k for k in ACTIONS if allows(levels_by_action.get(k) or defaults()[k], user)]


def catalog() -> list:
    """Para la pantalla: definiciones sin los defaults numéricos mezclados."""
    return [{"id": k, **{f: v[f] for f in ("label", "group", "desc", "floor_admin", "floor_inventory", "locked")},
             "default": {"admin": v["admin"], "inventory": v["inventory"]}} for k, v in ACTIONS.items()]
