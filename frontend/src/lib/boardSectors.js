import { CalendarDays, Factory, CheckCircle, Archive } from 'lucide-react';

/**
 * Sectores del menú lateral: única fuente de verdad.
 *
 * El menú (Sidebar) y el editor de sectores leen de aquí. Cuando estaban
 * definidos en cada sitio, mover un tablero obligaba a tocar los dos y era
 * cuestión de tiempo que dijeran cosas distintas.
 *
 * Lo que se guarda en la base es solo la pertenencia (qué tablero va en qué
 * sector). El nombre y el icono viven aquí: son cosa de la interfaz, no datos.
 */
// `labelKey` es la clave del diccionario i18n (se traduce al render con t());
// `label` queda como respaldo en español para quien no tenga el traductor a mano.
export const SECTOR_META = [
  { id: 'programacion', label: 'Programación', labelKey: 'sector_programacion', icon: CalendarDays },
  { id: 'produccion',   label: 'Producción',   labelKey: 'sector_produccion',   icon: Factory },
  { id: 'completados',  label: 'Completados',  labelKey: 'sector_completados',  icon: CheckCircle },
  { id: 'old',          label: 'Old',          labelKey: 'sector_old',          icon: Archive },
];

// Tableros de CIERRE que viven como pestañas del maestro (SCHEDULING), no en
// el menú: Completas / EDI / Final Bill / Inventario. Sólo con el modelo nuevo
// (sin MASTER ni COMPLETOS); antes de la migración se ven como siempre.
export const MASTER_TAB_BOARDS = ['EDI', 'FINAL BILL', 'INVENTARIO'];
export const usesMasterTabs = (boards) => !(boards || []).includes('MASTER') && !(boards || []).includes('COMPLETOS');

// Reparto inicial. Se usa mientras no haya nada guardado, y es lo que restaura
// el botón "Restaurar" del editor.
export const DEFAULT_SECTORS = {
  programacion: ['DATA ENTRY', 'SCHEDULING', 'READY TO SCHEDULED'],   // DATA ENTRY = entrada; SCHEDULING = maestro
  produccion:   ['NECK', 'EMPAQUE'],   // BLANKS y SCREENS → módulos Blanks y Cuadros (Sidebar SECTOR_MODULES)
  completados:  ['EDI', 'INVENTARIO', 'FINAL BILL'],   // COMPLETOS → pestaña Completas del maestro (SCHEDULING)
  old:          ['RESPALDO MONDAY', 'CANCELLED'],
};

// Los nombres de tablero vienen de la base y no siempre traen el mismo
// espaciado ("FINAL BILL" / "FINALBILL"). Se comparan sin espacios ni acentos
// para que un cambio de captura no saque un tablero de su sector.
export const boardKey = (board) => (board || '')
  .toUpperCase()
  .normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/[^A-Z0-9]/g, '');

/**
 * Cruza la configuración guardada con los tableros que existen de verdad.
 * Devuelve los sectores ya listos para pintar y los tableros que quedan sueltos.
 *
 * Un tablero que no esté en ningún sector NO desaparece: sale suelto arriba.
 * Así, si mañana se crea un tablero nuevo, aparece en el menú aunque nadie lo
 * haya asignado todavía.
 *
 * keepIds: sectores que se pintan aunque ya no tengan tableros, porque viven
 * MÓDULOS en ellos (Producción: Blanks, Cuadros, Neck, Empaque reemplazaron a
 * sus tableros; al retirarlos el sector quedaba vacío y desaparecía).
 */
export const resolveSectors = (sectors, availableBoards, keepIds = []) => {
  const asignados = new Set();

  const resueltos = SECTOR_META
    .map(meta => {
      const nombres = sectors?.[meta.id] || [];
      const items = nombres
        .map(nombre => availableBoards.find(b => boardKey(b) === boardKey(nombre)))
        .filter(Boolean);
      items.forEach(b => asignados.add(b));
      return { ...meta, items };
    })
    .filter(sector => sector.items.length > 0 || keepIds.includes(sector.id));

  const sueltos = availableBoards.filter(b => !asignados.has(b));

  return { sectors: resueltos, ungrouped: sueltos };
};
