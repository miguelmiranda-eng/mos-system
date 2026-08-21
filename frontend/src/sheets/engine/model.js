import { cellKey } from './address';

/**
 * Modelo de datos del libro.
 *
 * DECISION: las celdas viven en un MAPA DISPERSO (`"fila:columna" -> celda`), no
 * en una matriz. Una hoja de 50,000 filas x 40 columnas serian 2 millones de
 * huecos vacios ocupando memoria y tiempo de recorrido; en la practica el
 * usuario llena unos miles. El mapa cuesta lo que hay escrito, no lo que se ve.
 *
 * Una celda vacia NO se guarda. `getCell` devuelve null y quien lo lea decide
 * que hacer: asi no hay que distinguir entre "vacia" y "no existe".
 *
 * Todas las funciones de este archivo son PURAS: reciben estado y devuelven
 * estado nuevo, sin mutar el que entra. El historial (undo/redo) depende de que
 * los estados anteriores sigan siendo validos, y eso se cae en cuanto algo muta
 * en el sitio.
 */

export const MAX_ROWS = 50000;
export const MAX_COLS = 256;

export const DEFAULT_COL_WIDTH = 104;
export const DEFAULT_ROW_HEIGHT = 26;

/** Formatos de celda soportados en la fase 1. */
export const FORMATS = {
  GENERAL: 'general',
  TEXT: 'text',
  NUMBER: 'number',
  CURRENCY: 'currency',
  PERCENT: 'percent',
  DATE: 'date',
};

let contador = 0;
const nuevoId = (prefijo) => `${prefijo}_${Date.now().toString(36)}_${(contador++).toString(36)}`;

/**
 * Celda: { value, formula, format, style }
 *   value   valor crudo tal como se capturo (string | number | boolean | null)
 *   formula texto de la formula SIN el "=", o null. La fase 3 la evalua.
 *   format  clave de FORMATS
 *   style   objeto libre con: bold, italic, underline, align,
 *           color (texto), fill (fondo), fontFamily, fontSize
 */
export function makeCell(patch = {}) {
  return {
    value: patch.value ?? null,
    formula: patch.formula ?? null,
    format: patch.format ?? FORMATS.GENERAL,
    style: patch.style ?? null,
  };
}

export function makeSheet(name, { rows = 200, cols = 26 } = {}) {
  return {
    id: nuevoId('sh'),
    name,
    rows,
    cols,
    cells: new Map(),
    colWidths: new Map(),   // col -> px, solo las ajustadas
    rowHeights: new Map(),  // row -> px, solo las ajustadas
    hiddenCols: new Set(),
    merges: [],             // rangos combinados {r1,c1,r2,c2}
    filter: null,           // AutoFilter: { r1,c1,r2,c2, criterios: {col: criterio} }
    frozenRows: 0,
    frozenCols: 0,
  };
}

export const DEFAULT_FONT = 'Inter, system-ui, sans-serif';
export const DEFAULT_FONT_SIZE = 13;

// Fuentes ofrecidas en la barra. Se limitan a las que existen en cualquier
// equipo (o son la de la app): una fuente que no esta instalada se ve como otra
// cualquiera y confunde.
export const FONT_FAMILIES = [
  { label: 'Predeterminada', value: DEFAULT_FONT },
  { label: 'Arial', value: 'Arial, sans-serif' },
  { label: 'Calibri', value: 'Calibri, sans-serif' },
  { label: 'Times New Roman', value: '"Times New Roman", serif' },
  { label: 'Georgia', value: 'Georgia, serif' },
  { label: 'Courier New', value: '"Courier New", monospace' },
  { label: 'Verdana', value: 'Verdana, sans-serif' },
];

export const FONT_SIZES = [9, 10, 11, 12, 13, 14, 16, 18, 20, 24, 28, 36];

export function makeWorkbook(nombre = 'Libro sin titulo') {
  const hoja = makeSheet('Hoja 1');
  return {
    id: nuevoId('wb'),
    name: nombre,
    sheets: [hoja],
    activeSheetId: hoja.id,
  };
}

// ── Lectura ──────────────────────────────────────────────────────────────────

export const getSheet = (wb, id) => wb.sheets.find(s => s.id === id) || null;
export const getActiveSheet = (wb) => getSheet(wb, wb.activeSheetId) || wb.sheets[0];

export const getCell = (sheet, row, col) => sheet.cells.get(cellKey(row, col)) || null;

export const getColWidth = (sheet, col) => sheet.colWidths.get(col) ?? DEFAULT_COL_WIDTH;
export const getRowHeight = (sheet, row) => sheet.rowHeights.get(row) ?? DEFAULT_ROW_HEIGHT;

/**
 * Texto que se muestra cuando la celda NO se esta editando.
 * La fase 3 sustituira la rama de formula por el valor calculado; hasta
 * entonces se muestra la formula tal cual, que es honesto: no hay resultado.
 */
export function getDisplayValue(cell) {
  if (!cell) return '';
  if (cell.formula != null) return `=${cell.formula}`;
  return formatValue(cell.value, cell.format);
}

/** Texto que se muestra AL EDITAR: siempre lo capturado, nunca lo formateado. */
export function getEditValue(cell) {
  if (!cell) return '';
  if (cell.formula != null) return `=${cell.formula}`;
  return cell.value == null ? '' : String(cell.value);
}

const NUM_RE = /^-?\d*\.?\d+(?:[eE][+-]?\d+)?$/;

/** ¿El texto capturado es un numero? Se usa para alinear y para formatear. */
export function isNumeric(value) {
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value !== 'string') return false;
  const s = value.trim();
  return s !== '' && NUM_RE.test(s);
}

// Seriales de Excel, iguales a los de lib/formula.js, para que la fase 3 pueda
// mezclar las dos piezas sin traducir fechas en el camino.
const EPOCH = Date.UTC(1899, 11, 30);
const DAY_MS = 86400000;
const fromSerial = (n) => new Date(EPOCH + Math.round(n) * DAY_MS);

const fmtNumero = new Intl.NumberFormat('es-MX', { minimumFractionDigits: 0, maximumFractionDigits: 10 });
const fmtMoneda = new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'USD' });
const fmtPorcentaje = new Intl.NumberFormat('es-MX', { style: 'percent', maximumFractionDigits: 2 });
const fmtFecha = new Intl.DateTimeFormat('es-MX', { year: 'numeric', month: '2-digit', day: '2-digit' });

export function formatValue(value, format) {
  if (value == null || value === '') return '';
  if (format === FORMATS.TEXT) return String(value);

  const esNumero = isNumeric(value);
  const n = esNumero ? Number(value) : NaN;

  switch (format) {
    case FORMATS.NUMBER:
      return esNumero ? fmtNumero.format(n) : String(value);
    case FORMATS.CURRENCY:
      return esNumero ? fmtMoneda.format(n) : String(value);
    case FORMATS.PERCENT:
      return esNumero ? fmtPorcentaje.format(n) : String(value);
    case FORMATS.DATE: {
      const d = esNumero ? fromSerial(n) : new Date(value);
      return Number.isNaN(d.getTime()) ? String(value) : fmtFecha.format(d);
    }
    default:
      return String(value);
  }
}

// ── Escritura (pura: siempre devuelve un estado nuevo) ───────────────────────

/** Copia superficial de la hoja con un Map de celdas nuevo. */
function cloneSheet(sheet, overrides = {}) {
  return {
    ...sheet,
    cells: overrides.cells ?? new Map(sheet.cells),
    colWidths: overrides.colWidths ?? sheet.colWidths,
    rowHeights: overrides.rowHeights ?? sheet.rowHeights,
    hiddenCols: overrides.hiddenCols ?? sheet.hiddenCols,
    merges: overrides.merges ?? sheet.merges,
    filter: overrides.filter ?? sheet.filter,
    ...overrides,
  };
}

export function replaceSheet(wb, sheetId, fn) {
  const i = wb.sheets.findIndex(s => s.id === sheetId);
  if (i < 0) return wb;
  const sheets = wb.sheets.slice();
  sheets[i] = fn(sheets[i]);
  return { ...wb, sheets };
}

/**
 * Escribe una celda. `patch === null` la borra.
 * Borrar en vez de guardar una celda vacia mantiene el mapa del tamano de lo
 * que realmente hay escrito.
 */
export function setCell(sheet, row, col, patch) {
  const cells = new Map(sheet.cells);
  const k = cellKey(row, col);
  if (patch == null) {
    cells.delete(k);
  } else {
    const esVacia = patch.value == null && patch.formula == null
      && (patch.format ?? FORMATS.GENERAL) === FORMATS.GENERAL && !patch.style;
    if (esVacia) cells.delete(k);
    else cells.set(k, makeCell(patch));
  }
  return cloneSheet(sheet, { cells });
}

/** Varias celdas de una sola pasada: pegar y borrar rangos no clonan N veces. */
export function setCells(sheet, entradas) {
  const cells = new Map(sheet.cells);
  for (const { row, col, cell } of entradas) {
    const k = cellKey(row, col);
    if (cell == null) cells.delete(k);
    else cells.set(k, makeCell(cell));
  }
  return cloneSheet(sheet, { cells });
}

export function setColWidth(sheet, col, width) {
  const colWidths = new Map(sheet.colWidths);
  // undefined/null = volver al ancho por defecto: se borra la entrada en vez de
  // guardar NaN. Lo usa el undo de un ajuste que no tenia ancho previo.
  if (width == null) colWidths.delete(col);
  else colWidths.set(col, Math.max(32, Math.round(width)));
  return cloneSheet(sheet, { colWidths });
}

export function setRowHeight(sheet, row, height) {
  const rowHeights = new Map(sheet.rowHeights);
  if (height == null) rowHeights.delete(row);
  else rowHeights.set(row, Math.max(18, Math.round(height)));
  return cloneSheet(sheet, { rowHeights });
}

export function toggleColHidden(sheet, col, hidden) {
  const hiddenCols = new Set(sheet.hiddenCols);
  if (hidden) hiddenCols.add(col); else hiddenCols.delete(col);
  return cloneSheet(sheet, { hiddenCols });
}

export function showAllCols(sheet) {
  if (sheet.hiddenCols.size === 0) return sheet;
  return cloneSheet(sheet, { hiddenCols: new Set() });
}

/**
 * Región de datos contigua que contiene a (row, col), estilo "CurrentRegion" de
 * Excel: el rectángulo se expande mientras la fila/columna vecina tenga algún
 * dato, y se detiene en el borde vacío. Sirve para que filtrar una sola celda
 * agarre toda la tabla, sin que el usuario tenga que seleccionarla a mano.
 */
export function regionActual(sheet, row, col) {
  const tiene = (r, c) => {
    const cell = sheet.cells.get(cellKey(r, c));
    return !!cell && (cell.value != null || cell.formula != null);
  };
  const filaConDato = (r, c1, c2) => { for (let c = c1; c <= c2; c++) if (tiene(r, c)) return true; return false; };
  const colConDato = (c, r1, r2) => { for (let r = r1; r <= r2; r++) if (tiene(r, c)) return true; return false; };

  let r1 = row; let r2 = row; let c1 = col; let c2 = col;
  let cambio = true;
  while (cambio) {
    cambio = false;
    if (r1 > 0 && filaConDato(r1 - 1, c1, c2)) { r1--; cambio = true; }
    if (r2 < sheet.rows - 1 && filaConDato(r2 + 1, c1, c2)) { r2++; cambio = true; }
    if (c1 > 0 && colConDato(c1 - 1, r1, r2)) { c1--; cambio = true; }
    if (c2 < sheet.cols - 1 && colConDato(c2 + 1, r1, r2)) { c2++; cambio = true; }
  }
  return { r1, c1, r2, c2 };
}

// ── Celdas combinadas ────────────────────────────────────────────────────────

/** El rango combinado que contiene a la celda, o null. */
export function findMerge(sheet, row, col) {
  for (const m of sheet.merges) {
    if (row >= m.r1 && row <= m.r2 && col >= m.c1 && col <= m.c2) return m;
  }
  return null;
}

/** true si la celda esta combinada pero NO es la esquina superior-izquierda. */
export function isMergedCovered(sheet, row, col) {
  const m = findMerge(sheet, row, col);
  return !!m && !(m.r1 === row && m.c1 === col);
}

export function addMerge(sheet, range) {
  // Quita cualquier combinacion que se cruce con la nueva: dos combinaciones
  // solapadas dejarian el modelo ambiguo.
  const merges = sheet.merges.filter(m => !rangesOverlap(m, range));
  merges.push({ r1: range.r1, c1: range.c1, r2: range.r2, c2: range.c2 });
  return cloneSheet(sheet, { merges });
}

export function removeMergesIn(sheet, range) {
  const merges = sheet.merges.filter(m => !rangesOverlap(m, range));
  if (merges.length === sheet.merges.length) return sheet;
  return cloneSheet(sheet, { merges });
}

function rangesOverlap(a, b) {
  return a.r1 <= b.r2 && a.r2 >= b.r1 && a.c1 <= b.c2 && a.c2 >= b.c1;
}

/**
 * Inserta filas desplazando hacia abajo todo lo que estaba en `at` o despues.
 * Se recorre el mapa entero una vez: es O(celdas escritas), no O(filas).
 */
export function insertRows(sheet, at, cantidad = 1) {
  const cells = new Map();
  for (const [k, v] of sheet.cells) {
    const i = k.indexOf(':');
    const r = +k.slice(0, i);
    const c = k.slice(i + 1);
    cells.set(r >= at ? `${r + cantidad}:${c}` : k, v);
  }
  return cloneSheet(sheet, { cells, rows: Math.min(MAX_ROWS, sheet.rows + cantidad) });
}

export function deleteRows(sheet, at, cantidad = 1) {
  const cells = new Map();
  for (const [k, v] of sheet.cells) {
    const i = k.indexOf(':');
    const r = +k.slice(0, i);
    const c = k.slice(i + 1);
    if (r >= at && r < at + cantidad) continue; // se va con la fila
    cells.set(r >= at + cantidad ? `${r - cantidad}:${c}` : k, v);
  }
  return cloneSheet(sheet, { cells, rows: Math.max(1, sheet.rows - cantidad) });
}

export function insertCols(sheet, at, cantidad = 1) {
  const cells = new Map();
  for (const [k, v] of sheet.cells) {
    const i = k.indexOf(':');
    const r = k.slice(0, i);
    const c = +k.slice(i + 1);
    cells.set(c >= at ? `${r}:${c + cantidad}` : k, v);
  }
  const colWidths = new Map();
  for (const [c, w] of sheet.colWidths) colWidths.set(c >= at ? c + cantidad : c, w);
  return cloneSheet(sheet, { cells, colWidths, cols: Math.min(MAX_COLS, sheet.cols + cantidad) });
}

export function deleteCols(sheet, at, cantidad = 1) {
  const cells = new Map();
  for (const [k, v] of sheet.cells) {
    const i = k.indexOf(':');
    const r = k.slice(0, i);
    const c = +k.slice(i + 1);
    if (c >= at && c < at + cantidad) continue;
    cells.set(c >= at + cantidad ? `${r}:${c - cantidad}` : k, v);
  }
  const colWidths = new Map();
  for (const [c, w] of sheet.colWidths) {
    if (c >= at && c < at + cantidad) continue;
    colWidths.set(c >= at + cantidad ? c - cantidad : c, w);
  }
  return cloneSheet(sheet, { cells, colWidths, cols: Math.max(1, sheet.cols - cantidad) });
}

/**
 * Interpreta lo que el usuario escribio.
 * Empieza con "=" -> formula. Si no, se guarda el texto crudo y el formato
 * decide como se ve. NO se convierte "01234" a numero: eso destruye codigos de
 * producto y numeros de parte, que en esta empresa son constantes.
 */
export function parseInput(texto) {
  const s = String(texto ?? '');
  if (s.startsWith('=')) return { value: null, formula: s.slice(1) };
  if (s === '') return null;
  return { value: s, formula: null };
}
