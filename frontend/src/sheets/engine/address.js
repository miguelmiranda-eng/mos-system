/**
 * Direcciones de celda estilo A1 <-> {row, col}.
 *
 * Fila y columna son SIEMPRE indices base 0 dentro del motor. La notacion A1
 * (base 1, columna en letras) solo existe en los bordes: lo que ve el usuario y
 * lo que se escribe en las formulas. Mezclar las dos convenciones adentro es la
 * fuente clasica de errores por uno en las hojas de calculo, asi que la
 * conversion vive aqui y en ningun otro sitio.
 */

const A = 'A'.charCodeAt(0);

/** 0 -> "A", 25 -> "Z", 26 -> "AA" (biyectivo base 26, no posicional). */
export function colToLetters(col) {
  if (!Number.isInteger(col) || col < 0) return '';
  let n = col + 1;
  let out = '';
  while (n > 0) {
    const resto = (n - 1) % 26;
    out = String.fromCharCode(A + resto) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

/** "A" -> 0, "AA" -> 26. Devuelve -1 si no es una referencia de columna. */
export function lettersToCol(letters) {
  if (!letters) return -1;
  const s = String(letters).toUpperCase();
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < A || c > A + 25) return -1;
    n = n * 26 + (c - A + 1);
  }
  return n - 1;
}

/** {row:0, col:0} -> "A1" */
export function toA1(row, col) {
  return `${colToLetters(col)}${row + 1}`;
}

const A1_RE = /^\$?([A-Za-z]+)\$?(\d+)$/;

/** "A1" / "$A$1" -> {row, col}. null si no parsea. */
export function fromA1(ref) {
  const m = A1_RE.exec(String(ref || '').trim());
  if (!m) return null;
  const col = lettersToCol(m[1]);
  const row = parseInt(m[2], 10) - 1;
  if (col < 0 || !Number.isInteger(row) || row < 0) return null;
  return { row, col };
}

/**
 * Rango normalizado a partir de dos esquinas cualesquiera.
 * El usuario puede arrastrar de abajo-derecha hacia arriba-izquierda; todo el
 * resto del motor asume r1<=r2 y c1<=c2, asi que se ordena aqui.
 */
export function normalizeRange(a, b) {
  return {
    r1: Math.min(a.row, b.row),
    c1: Math.min(a.col, b.col),
    r2: Math.max(a.row, b.row),
    c2: Math.max(a.col, b.col),
  };
}

export function rangeContains(range, row, col) {
  return row >= range.r1 && row <= range.r2 && col >= range.c1 && col <= range.c2;
}

export function rangeSize(range) {
  return {
    rows: range.r2 - range.r1 + 1,
    cols: range.c2 - range.c1 + 1,
  };
}

/** "A1:B10" legible, para la caja de nombre y los mensajes. */
export function rangeToA1(range) {
  if (range.r1 === range.r2 && range.c1 === range.c2) return toA1(range.r1, range.c1);
  return `${toA1(range.r1, range.c1)}:${toA1(range.r2, range.c2)}`;
}

/** Recorre un rango sin materializar un array: hojas grandes, memoria estable. */
export function forEachCell(range, fn) {
  for (let r = range.r1; r <= range.r2; r++) {
    for (let c = range.c1; c <= range.c2; c++) fn(r, c);
  }
}

/** Clave de celda para los mapas dispersos del modelo. */
export const cellKey = (row, col) => `${row}:${col}`;

export function parseCellKey(key) {
  const i = key.indexOf(':');
  return { row: +key.slice(0, i), col: +key.slice(i + 1) };
}
