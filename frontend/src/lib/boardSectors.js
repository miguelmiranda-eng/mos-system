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
export const SECTOR_META = [
  { id: 'programacion', label: 'Programación', icon: CalendarDays },
  { id: 'produccion',   label: 'Producción',   icon: Factory },
  { id: 'completados',  label: 'Completados',  icon: CheckCircle },
  { id: 'old',          label: 'Old',          icon: Archive },
];

// Reparto inicial. Se usa mientras no haya nada guardado, y es lo que restaura
// el botón "Restaurar" del editor.
export const DEFAULT_SECTORS = {
  programacion: ['SCHEDULING', 'READY TO SCHEDULED'],
  produccion:   ['BLANKS', 'SCREENS', 'NECK', 'EMPAQUE'],
  completados:  ['EDI', 'INVENTARIO', 'FINAL BILL', 'COMPLETOS'],
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
 */
export const resolveSectors = (sectors, availableBoards) => {
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
    .filter(sector => sector.items.length > 0);

  const sueltos = availableBoards.filter(b => !asignados.has(b));

  return { sectors: resueltos, ungrouped: sueltos };
};
