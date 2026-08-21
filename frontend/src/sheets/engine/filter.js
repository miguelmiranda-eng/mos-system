import { getCell, getDisplayValue, isNumeric } from './model';
import { textoCalculado } from './compute';
import { cellKey } from './address';

/**
 * AutoFilter estilo Excel.
 *
 * Un filtro vive en la hoja como `sheet.filter`:
 *   { r1, c1, r2, c2, criterios: { [colAbsoluta]: criterio } }
 * donde r1 es la FILA DE ENCABEZADOS y r1+1..r2 son los datos. Cada columna
 * puede tener un criterio; una fila de datos se OCULTA si falla el criterio de
 * cualquier columna. Ocultar (no borrar) es lo correcto: el filtro es una vista,
 * no cambia los datos.
 *
 * Dos tipos de criterio, como en Excel:
 *   { tipo: 'valores', permitidos: string[] }   -> casillas de valores
 *   { tipo: 'condicion', op, a, b }              -> condicion (contiene, >, entre...)
 */

// Operadores de texto y de numero ofrecidos en el menu.
export const OPS_TEXTO = [
  { op: 'contiene', label: 'Contiene' },
  { op: 'no_contiene', label: 'No contiene' },
  { op: 'igual', label: 'Es igual a' },
  { op: 'empieza', label: 'Empieza con' },
  { op: 'termina', label: 'Termina con' },
  { op: 'vacio', label: 'Está vacío', sinValor: true },
  { op: 'no_vacio', label: 'No está vacío', sinValor: true },
];
export const OPS_NUMERO = [
  { op: 'igual', label: 'Es igual a' },
  { op: 'distinto', label: 'Es distinto de' },
  { op: 'mayor', label: 'Mayor que' },
  { op: 'menor', label: 'Menor que' },
  { op: 'mayor_igual', label: 'Mayor o igual que' },
  { op: 'menor_igual', label: 'Menor o igual que' },
  { op: 'entre', label: 'Entre', dosValores: true },
  { op: 'vacio', label: 'Está vacío', sinValor: true },
  { op: 'no_vacio', label: 'No está vacío', sinValor: true },
];

/** Texto mostrado de una celda (formula resuelta incluida). */
function textoDe(sheet, computed, row, col) {
  const cell = getCell(sheet, row, col);
  return textoCalculado(cell, computed, cellKey(row, col), getDisplayValue);
}

/** Valores distintos de una columna, en el rango de datos del filtro, ordenados. */
export function valoresDistintos(sheet, computed, col, r1, r2) {
  const set = new Set();
  for (let r = r1 + 1; r <= r2; r++) set.add(textoDe(sheet, computed, r, col));
  const arr = [...set];
  // Numeros primero (ordenados), luego texto; los vacios al final.
  arr.sort((a, b) => {
    if (a === '') return 1;
    if (b === '') return -1;
    const na = Number(a); const nb = Number(b);
    const an = isNumeric(a); const bn = isNumeric(b);
    if (an && bn) return na - nb;
    if (an) return -1;
    if (bn) return 1;
    return a.localeCompare(b, 'es');
  });
  return arr;
}

/** ¿El texto cumple el criterio? */
export function cumple(texto, criterio) {
  if (!criterio) return true;
  if (criterio.tipo === 'valores') {
    return criterio.permitidos.includes(texto);
  }
  // condicion
  const { op, a, b } = criterio;
  const t = String(texto ?? '');
  const tl = t.toLowerCase();
  const al = String(a ?? '').toLowerCase();

  switch (op) {
    case 'vacio': return t.trim() === '';
    case 'no_vacio': return t.trim() !== '';
    case 'contiene': return tl.includes(al);
    case 'no_contiene': return !tl.includes(al);
    case 'empieza': return tl.startsWith(al);
    case 'termina': return tl.endsWith(al);
    case 'igual': {
      if (isNumeric(t) && isNumeric(a)) return Number(t) === Number(a);
      return tl === al;
    }
    case 'distinto': {
      if (isNumeric(t) && isNumeric(a)) return Number(t) !== Number(a);
      return tl !== al;
    }
    case 'mayor': return Number(t) > Number(a);
    case 'menor': return Number(t) < Number(a);
    case 'mayor_igual': return Number(t) >= Number(a);
    case 'menor_igual': return Number(t) <= Number(a);
    case 'entre': {
      const n = Number(t); return n >= Number(a) && n <= Number(b);
    }
    default: return true;
  }
}

/** Filas (índices absolutos) que el filtro oculta. Set vacío si no hay filtro. */
export function filasOcultasPorFiltro(sheet, computed) {
  const f = sheet.filter;
  const ocultas = new Set();
  if (!f || !f.criterios) return ocultas;
  const cols = Object.keys(f.criterios).map(Number).filter(c => f.criterios[c]);
  if (cols.length === 0) return ocultas;

  for (let r = f.r1 + 1; r <= f.r2; r++) {
    for (const c of cols) {
      if (!cumple(textoDe(sheet, computed, r, c), f.criterios[c])) { ocultas.add(r); break; }
    }
  }
  return ocultas;
}

/** ¿La columna tiene un criterio activo? (para pintar el embudo lleno) */
export function columnaFiltrada(sheet, col) {
  return !!(sheet.filter && sheet.filter.criterios && sheet.filter.criterios[col]);
}
