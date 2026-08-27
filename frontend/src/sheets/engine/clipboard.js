import { getCell, getEditValue, parseInput, makeCell } from './model';
import { forEachCell, rangeSize } from './address';

/**
 * Portapapeles en TSV (separado por tabuladores).
 *
 * Es el formato que usan Excel, Google Sheets y Numbers para texto plano, asi
 * que copiar de aqui y pegar alla —y al reves— funciona sin conversiones. Un
 * formato propio se veria mejor en las pruebas y seria inutil el primer dia
 * que alguien pegue algo desde Excel, que es exactamente lo que va a pasar.
 */

/** Rango -> texto TSV, con las comillas y saltos escapados como Excel. */
export function rangeToTSV(sheet, range) {
  const filas = [];
  for (let r = range.r1; r <= range.r2; r++) {
    const cols = [];
    for (let c = range.c1; c <= range.c2; c++) {
      cols.push(escaparTSV(getEditValue(getCell(sheet, r, c))));
    }
    filas.push(cols.join('\t'));
  }
  return filas.join('\n');
}

function escaparTSV(texto) {
  const s = String(texto ?? '');
  // Excel entrecomilla solo cuando hace falta; imitarlo evita comillas de mas
  // en el 99% de las celdas.
  if (/[\t\n"]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

/**
 * TSV -> matriz de textos. Respeta campos entrecomillados con tabuladores y
 * saltos de linea adentro, que es como Excel exporta una celda multilinea.
 */
export function parseTSV(texto) {
  const filas = [];
  let fila = [];
  let campo = '';
  let enComillas = false;

  const s = String(texto ?? '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (enComillas) {
      if (ch === '"') {
        if (s[i + 1] === '"') { campo += '"'; i++; }   // comilla escapada
        else enComillas = false;
      } else campo += ch;
      continue;
    }
    if (ch === '"' && campo === '') { enComillas = true; continue; }
    if (ch === '\t') { fila.push(campo); campo = ''; continue; }
    if (ch === '\n') { fila.push(campo); filas.push(fila); fila = []; campo = ''; continue; }
    campo += ch;
  }
  // Ultima celda: solo cuenta si habia algo, para no crear una fila fantasma
  // cuando el texto termina en salto de linea.
  if (campo !== '' || fila.length > 0) { fila.push(campo); filas.push(fila); }
  return filas;
}

/**
 * Entradas para pegar una matriz en `destino`.
 *
 * Si el destino es un rango mas grande y multiplo exacto de lo copiado, se
 * repite para llenarlo — como Excel. Si no, se pega una vez desde la esquina.
 */
export function buildPasteEntries(matriz, destino, limites, sheet = null) {
  if (!matriz.length) return [];

  const altoOrigen = matriz.length;
  const anchoOrigen = Math.max(...matriz.map(f => f.length));
  const { rows: altoDestino, cols: anchoDestino } = rangeSize(destino);

  const repetir = altoDestino > altoOrigen || anchoDestino > anchoOrigen;
  const repFilas = repetir && altoDestino % altoOrigen === 0 ? altoDestino / altoOrigen : 1;
  const repCols = repetir && anchoDestino % anchoOrigen === 0 ? anchoDestino / anchoOrigen : 1;

  const entradas = [];
  for (let rf = 0; rf < repFilas; rf++) {
    for (let rc = 0; rc < repCols; rc++) {
      for (let r = 0; r < altoOrigen; r++) {
        for (let c = 0; c < anchoOrigen; c++) {
          const row = destino.r1 + rf * altoOrigen + r;
          const col = destino.c1 + rc * anchoOrigen + c;
          // Fuera de la hoja se descarta en silencio, igual que Excel recorta
          // un pegado que se sale por abajo.
          if (row >= limites.rows || col >= limites.cols) continue;
          const patch = parseInput(matriz[r][c] ?? '');
          // Pegar texto plano conserva el formato/estilo del DESTINO (como
          // Excel al pegar valores): color y desplegables no se pierden.
          const previa = sheet ? getCell(sheet, row, col) : null;
          let cell = null;
          if (patch) {
            cell = makeCell({ ...patch, format: previa?.format, style: previa?.style ?? null });
          } else if (previa?.style) {
            cell = makeCell({ format: previa.format, style: previa.style });
          }
          entradas.push({ row, col, cell });
        }
      }
    }
  }
  return entradas;
}

/** Rango que ocuparia lo pegado: sirve para dejar la seleccion encima. */
export function pastedRange(matriz, destino, limites) {
  const alto = matriz.length || 1;
  const ancho = Math.max(1, ...matriz.map(f => f.length));
  return {
    r1: destino.r1,
    c1: destino.c1,
    r2: Math.min(limites.rows - 1, destino.r1 + alto - 1),
    c2: Math.min(limites.cols - 1, destino.c1 + ancho - 1),
  };
}

/** Celdas de un rango, para cortar (se copia antes de borrar). */
export function snapshotForCut(sheet, range) {
  const out = [];
  forEachCell(range, (row, col) => {
    if (getCell(sheet, row, col)) out.push({ row, col, cell: null });
  });
  return out;
}
