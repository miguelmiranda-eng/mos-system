/* Catálogo de módulos del WMS y su reparto en grupos (rediseño 2026-08).

   Antes esta lista vivía dentro del cuerpo de WMS.js. Se extrajo para que la
   barra superior, el sidebar (mientras siga vivo detrás de la bandera) y la
   futura paleta ⌘K consuman EXACTAMENTE la misma fuente — el bug clásico de
   este tipo de navegación es que una de las vistas se quede sin un módulo.

   REGLA: `id` es el mismo identificador que consume el switch de
   `renderActiveModule` en WMS.js. Si se agrega un módulo aquí, hay que darle
   su `case` allá; si no, cae en el default (Receiving).

   Los grupos siguen el recorrido físico de la mercancía —entra, se guarda,
   sale, y lo demás observa o configura— para que un operador nuevo pueda
   deducir dónde está algo sin que se lo enseñen. */

import {
  Package, MapPin, ClipboardList, BarChart3, ClipboardCheck,
  CheckCircle, History, FileDown, ScanLine, Settings,
  LayoutDashboard, Scissors, Clock, Truck, Move, ShieldCheck, ShieldAlert,
} from "lucide-react";

export const WMS_GROUPS = [
  { id: 'in',  label: 'Entradas',   hint: 'Del aviso al rack' },
  { id: 'inv', label: 'Inventario', hint: 'Qué hay y dónde está' },
  { id: 'out', label: 'Salidas',    hint: 'Del ticket al embarque' },
  { id: 'an',  label: 'Análisis',   hint: 'Lo que ya pasó' },
  { id: 'sys', label: 'Sistema',    hint: 'Salud y catálogos' },
];

/* Los rótulos salen de i18n, así que la lista se construye con `t` en mano.
   `badgeKey` sólo se pone cuando la llave que devuelve /badges NO coincide con
   el id del módulo: Putaway 2.0 tiene id 'transit' pero su contador sigue
   llegando como `putaway` (el lanzador del picker ya hacía ese mapeo a mano). */
/* `t()` devuelve la propia llave cuando no hay traduccion, asi que un
   `t('x') || 'Fallback'` NUNCA cae al fallback: la llave es truthy. Por eso
   "Trabajo dirigido" se veia como `wms_mod_directed` en la barra. */
const tr = (t, llave, respaldo) => {
  const v = t(llave);
  return !v || v === llave ? respaldo : v;
};

/* Nivel de admin efectivo del usuario — espejo de get_admin_level() del backend
   (deps.py): supersu = MAX (5); admin = su admin_level (default 1, tope 5);
   inventory_level ≥ 3 confiere nivel 3. Se usa para gatear módulos por
   `minAdminLevel` sin que la UI y el backend puedan discrepar. */
export const adminLevelOf = (u) => {
  if (!u) return 0;
  if (u.role === 'supersu') return 5;
  let lvl = 0;
  if (u.role === 'admin') lvl = Math.max(1, Math.min(5, parseInt(u.admin_level, 10) || 1));
  const inv = parseInt(u.inventory_level, 10) || 0;
  if (inv >= 3) lvl = Math.max(lvl, 3);
  return lvl;
};

export const buildModules = (t) => [
  // ── Entradas ────────────────────────────────────────────────────────────
  { id: 'asn', group: 'in', label: 'ASN', icon: FileDown, color: 'text-orange-400',
    desc: 'Avisos de llegada' },
  { id: 'receiving', group: 'in', label: t('wms_mod_receiving'), icon: Package, color: 'text-blue-400',
    desc: t('wms_mod_receiving_desc') },
  { id: 'transit', group: 'in', label: 'Putaway 2.0', icon: Truck, color: 'text-amber-400',
    desc: 'Carros de tránsito — cajas pendientes de ubicación física', badgeKey: 'putaway' },
  // STANDBY — Putaway 1.0 oculto de la navegación. Reemplazado por Putaway 2.0
  // (id: 'transit'). El import + el case 'putaway' del switch se quedan vivos
  // en WMS.js por si hay que reactivarlo.
  // { id: 'putaway', group: 'in', label: t('wms_mod_putaway'), icon: MapPin, color: 'text-purple-400', desc: t('wms_mod_putaway_desc') },

  // ── Inventario ──────────────────────────────────────────────────────────
  { id: 'inventory', group: 'inv', label: t('wms_mod_inventory'), icon: BarChart3, color: 'text-emerald-400',
    desc: t('wms_mod_inventory_desc') },
  { id: 'locations', group: 'inv', label: 'Locaciones', icon: MapPin, color: 'text-cyan-400',
    desc: 'Mapa lógico y gestión de ubicaciones' },
  { id: 'mover', group: 'inv', label: 'MOVER', icon: Move, color: 'text-teal-400',
    desc: 'Mover material entre ubicaciones: toda la ubicación, una caja o unidades' },
  { id: 'aging', group: 'inv', label: 'Antigüedad', icon: Clock, color: 'text-amber-400',
    desc: 'Días en almacén / almacenaje' },
  { id: 'cycle_count', group: 'inv', label: t('wms_mod_cycle_count'), icon: ClipboardList, color: 'text-lime-400',
    desc: t('wms_mod_cycle_count_desc') },
  // Conciliación física: SOLO super usuario. Reconstruye el inventario de una
  // ubicación completa desde lo escaneado, así que un error borra saldo real.
  // El backend también rechaza (403) a cualquier otro rol.
  { id: 'reconciliation', group: 'inv', label: 'Conciliación', icon: ClipboardCheck, color: 'text-emerald-400',
    desc: 'Cajas por resolver y registro de ubicaciones conciliadas', supersuOnly: true },

  // ── Salidas ─────────────────────────────────────────────────────────────
  { id: 'directed', group: 'out', label: tr(t, 'wms_mod_directed', 'Trabajo Dirigido'), icon: ScanLine, color: 'text-yellow-400',
    desc: tr(t, 'wms_mod_directed_desc', 'Instrucciones inteligentes para el piso') },
  { id: 'picking', group: 'out', label: t('wms_mod_picking'), icon: ClipboardCheck, color: 'text-indigo-400',
    desc: t('wms_mod_picking_desc') },
  { id: 'neck_cutting', group: 'out', label: 'Corte de Neck', icon: Scissors, color: 'text-pink-400',
    desc: 'Material surtido en espera de corte' },
  { id: 'finished', group: 'out', label: t('wms_mod_finished'), icon: CheckCircle, color: 'text-cyan-400',
    desc: t('wms_mod_finished_desc') },

  // ── Análisis ────────────────────────────────────────────────────────────
  { id: 'dashboard', group: 'an', label: 'Dashboard', icon: LayoutDashboard, color: 'text-primary',
    desc: 'Visión general del inventario en tiempo real' },
  // Reportes: material de supervisión (nivel 1+). El backend valida el nivel.
  { id: 'reports', group: 'an', label: 'Reportes', icon: BarChart3, color: 'text-sky-400',
    desc: 'Recibos, putaway y pick tickets: pendiente, productividad, historial y excepciones', adminOnly: true },
  { id: 'movements', group: 'an', label: t('wms_mod_movements'), icon: History, color: 'text-slate-400',
    desc: t('wms_mod_movements_desc') },

  // ── Sistema ─────────────────────────────────────────────────────────────
  // Auditoría: admin nivel 5 y supersu (el backend valida con require_admin_level(5)).
  { id: 'audit', group: 'sys', label: 'Auditoría', icon: ShieldCheck, color: 'text-red-400',
    desc: 'Salud del sistema, trazabilidad por caja/SKU y movimientos', minAdminLevel: 5 },
  // Incidencias del sistema: material no encontrado, duplicados bloqueados,
  // errores de recepción. SOLO super usuario (el backend responde 403 al resto).
  { id: 'incidents', group: 'sys', label: 'Incidencias', icon: ShieldAlert, color: 'text-orange-400',
    desc: 'Alertas del sistema: material no encontrado, duplicados bloqueados y errores de recepción', supersuOnly: true },
  { id: 'home', group: 'sys', label: 'Configuración WMS', icon: Settings, color: 'text-primary',
    desc: 'Catálogos editables para los dropdowns de Receiving / Picking' },
];

/* Filtro por rol y nivel — es LITERALMENTE el que corría dentro del sidebar.
   Se movió aquí para que la barra superior, el sidebar y la paleta no puedan
   discrepar sobre qué ve cada quien. El backend valida igual por su cuenta. */
export const filterModules = (modules, currentUser, moduleLevels = {}) => modules.filter(m => {
  // Rol `inventory` del WMS: acotado al área de inventario por nivel. Es una
  // lista blanca explícita, así que corre ANTES de las guardas adminOnly /
  // supersuOnly — por eso NO puede incluir 'reconciliation'.
  //   nivel 1 → locaciones, mover (sin ajustes), conteo cíclico,
  //             inventario (sin "agregar manual") y movimientos
  //   nivel 2 → además ajustes en Mover y "agregar manual" en Inventario,
  //             gateados dentro de cada módulo
  // (los reportes de conteo — nivel 3 — se gatean dentro de CycleCount)
  // Conciliación quedó reservada al super usuario, ningún nivel la ve.
  if (currentUser?.role === 'inventory') {
    const lvl = parseInt(currentUser?.inventory_level, 10) || 0;
    if (lvl < 1) return false;
    const allowed = ['locations', 'mover', 'cycle_count', 'inventory', 'aging', 'movements'];
    return allowed.includes(m.id);
  }
  // Acceso configurable desde la app (Centro de usuarios → Acceso por módulo).
  // Gana sobre los flags hardcodeados para los módulos que el backend delega
  // (audit, incidents). Escala: 6 = solo supersu; 1..5 = nivel de admin mínimo.
  const lvl = moduleLevels?.[m.id];
  if (lvl != null) {
    if (lvl >= 6) return currentUser?.role === 'supersu';
    return adminLevelOf(currentUser) >= lvl;
  }

  if (m.supersuOnly && currentUser?.role !== 'supersu') return false;
  // Módulos gateados por nivel de admin (p.ej. Auditoría = nivel 5). supersu
  // siempre pasa porque adminLevelOf lo trata como el nivel máximo.
  if (m.minAdminLevel && adminLevelOf(currentUser) < m.minAdminLevel) return false;
  if (m.adminOnly && !['admin', 'supersu', 'ceo'].includes(currentUser?.role)) return false;
  if (currentUser?.role === 'customer') return m.id === 'dashboard';
  if (currentUser?.role === 'picker') return ['picking', 'transit', 'mover'].includes(m.id);
  return true;
});

/* Reparte los módulos ya filtrados en sus grupos. Un grupo que se queda sin
   módulos para ese rol NO se pinta — el rol `inventory`, por ejemplo, sólo ve
   dos menús. */
export const groupModules = (modules) => WMS_GROUPS
  .map(g => ({ ...g, items: modules.filter(m => m.group === g.id) }))
  .filter(g => g.items.length > 0);

/* Contador de un módulo. Usa `badgeKey` cuando /badges no usa el mismo nombre. */
export const badgeOf = (m, badges) => (badges?.[m.badgeKey || m.id]) || 0;

/* Suma de los contadores de un grupo, para la insignia de su etiqueta. */
export const groupBadge = (group, badges) =>
  group.items.reduce((sum, m) => sum + badgeOf(m, badges), 0);
