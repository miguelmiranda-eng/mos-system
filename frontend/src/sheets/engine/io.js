import * as XLSX from 'xlsx';
import { makeSheet, makeCell, getCell, getDisplayValue, MAX_ROWS, MAX_COLS } from './model';
import { cellKey } from './address';

/**
 * Importacion y exportacion XLSX / CSV.
 *
 * Se apoya en SheetJS (`xlsx`), que ya estaba en el proyecto. No se reinventa un
 * parser de Excel: el formato tiene decadas de casos raros y hacerlo a mano
 * garantiza perder datos, justo lo que el punto 4 prohibe.
 *
 * Al importar se INFORMAN los limites en vez de romper en silencio: si un libro
 * trae mas filas o columnas de las que soporta el modelo, se recorta y se avisa
 * cuanto se dejo fuera.
 */

/**
 * Lee un File del equipo y devuelve { sheets, errors }.
 * Cada sheet es una hoja del modelo interno; errors es una lista de avisos
 * legibles (no excepciones): el usuario decide si le importan.
 */
export async function importarArchivo(file) {
  const errors = [];
  const nombre = file.name || 'importado';
  const esCSV = /\.csv$/i.test(nombre);

  let libro;
  try {
    const buf = await file.arrayBuffer();
    // cellFormula/cellNF: conservar formulas y formato cuando se pueda.
    libro = XLSX.read(buf, { type: 'array', cellFormula: true, cellNF: true, cellDates: true });
  } catch (e) {
    return { sheets: [], errors: [`No se pudo leer "${nombre}": ${e.message}`] };
  }

  const sheets = [];
  for (const nombreHoja of libro.SheetNames) {
    const ws = libro.Sheets[nombreHoja];
    if (!ws || !ws['!ref']) {
      sheets.push(makeSheet(nombreHoja));
      continue;
    }
    const rango = XLSX.utils.decode_range(ws['!ref']);
    let filas = rango.e.r - rango.s.r + 1;
    let cols = rango.e.c - rango.s.c + 1;

    if (filas > MAX_ROWS) {
      errors.push(`"${nombreHoja}": ${filas} filas, se importaron las primeras ${MAX_ROWS}.`);
      filas = MAX_ROWS;
    }
    if (cols > MAX_COLS) {
      errors.push(`"${nombreHoja}": ${cols} columnas, se importaron las primeras ${MAX_COLS}.`);
      cols = MAX_COLS;
    }

    const hoja = makeSheet(nombreHoja.slice(0, 60), {
      rows: Math.max(200, filas),
      cols: Math.max(26, cols),
    });

    for (let r = 0; r < filas; r++) {
      for (let c = 0; c < cols; c++) {
        const dir = XLSX.utils.encode_cell({ r: rango.s.r + r, c: rango.s.c + c });
        const celda = ws[dir];
        if (!celda) continue;
        const patch = celdaXLSXaModelo(celda);
        if (patch) hoja.cells.set(cellKey(r, c), makeCell(patch));
      }
    }

    // Anchos de columna, si el archivo los trae.
    if (Array.isArray(ws['!cols'])) {
      ws['!cols'].forEach((info, i) => {
        if (info && info.wpx) hoja.colWidths.set(i, Math.round(info.wpx));
        else if (info && info.wch) hoja.colWidths.set(i, Math.round(info.wch * 7));
      });
    }
    // Celdas combinadas.
    if (Array.isArray(ws['!merges'])) {
      hoja.merges = ws['!merges'].map(m => ({
        r1: m.s.r - rango.s.r, c1: m.s.c - rango.s.c,
        r2: m.e.r - rango.s.r, c2: m.e.c - rango.s.c,
      })).filter(m => m.r1 >= 0 && m.c1 >= 0 && m.r2 < filas && m.c2 < cols);
    }

    sheets.push(hoja);
  }

  if (esCSV && sheets.length) sheets[0].name = nombre.replace(/\.csv$/i, '').slice(0, 60);
  return { sheets, errors };
}

/** Traduce una celda de SheetJS al patch del modelo, conservando la formula. */
function celdaXLSXaModelo(celda) {
  // Formula (SheetJS la deja en .f sin el "=").
  if (celda.f) {
    return { formula: celda.f, value: celda.v ?? null };
  }
  if (celda.v == null) return null;
  // Fechas: SheetJS con cellDates da un Date; se guarda su ISO corto.
  if (celda.t === 'd' && celda.v instanceof Date) {
    return { value: celda.v.toISOString().slice(0, 10) };
  }
  if (celda.t === 'b') return { value: celda.v ? 'TRUE' : 'FALSE' };
  return { value: celda.v };
}

// ── Exportacion ──────────────────────────────────────────────────────────────

/** Modelo interno -> hoja de SheetJS (AOA con celdas tipadas). */
function hojaModeloaXLSX(sheet) {
  // Se recorre solo lo escrito: encontrar la esquina inferior-derecha real
  // evita exportar miles de filas vacias.
  let maxR = 0; let maxC = 0;
  for (const k of sheet.cells.keys()) {
    const i = k.indexOf(':');
    maxR = Math.max(maxR, +k.slice(0, i));
    maxC = Math.max(maxC, +k.slice(i + 1));
  }
  const ws = {};
  for (const [k, cell] of sheet.cells) {
    const i = k.indexOf(':');
    const r = +k.slice(0, i);
    const c = +k.slice(i + 1);
    const dir = XLSX.utils.encode_cell({ r, c });
    ws[dir] = celdaModeloaXLSX(cell);
  }
  ws['!ref'] = XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: maxR, c: maxC } });

  const cols = [];
  for (const [c, w] of sheet.colWidths) cols[c] = { wpx: w };
  if (cols.length) ws['!cols'] = cols;

  if (sheet.merges && sheet.merges.length) {
    ws['!merges'] = sheet.merges.map(m => ({
      s: { r: m.r1, c: m.c1 }, e: { r: m.r2, c: m.c2 },
    }));
  }
  return ws;
}

function celdaModeloaXLSX(cell) {
  if (cell.formula != null) {
    // Se escribe la formula; el valor calculado lo pondra Excel al abrir.
    return { t: 'n', f: cell.formula };
  }
  const v = cell.value;
  const n = Number(v);
  if (v !== '' && v != null && Number.isFinite(n) && String(v).trim() !== '' && !/^0\d/.test(String(v))) {
    return { t: 'n', v: n };   // numero, salvo codigos con cero a la izquierda
  }
  return { t: 's', v: v == null ? '' : String(v) };
}

export function exportarXLSX(workbook) {
  const wb = XLSX.utils.book_new();
  for (const hoja of workbook.sheets) {
    const ws = hojaModeloaXLSX(hoja);
    // Excel corta los nombres de hoja a 31 y prohibe algunos caracteres.
    const nombre = (hoja.name || 'Hoja').replace(/[\\/?*[\]:]/g, ' ').slice(0, 31) || 'Hoja';
    XLSX.utils.book_append_sheet(wb, ws, nombre);
  }
  XLSX.writeFile(wb, `${nombreArchivo(workbook.name)}.xlsx`);
}

export function exportarCSV(sheet) {
  const ws = hojaModeloaXLSX(sheet);
  const csv = XLSX.utils.sheet_to_csv(ws);
  const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' });
  descargar(blob, `${nombreArchivo(sheet.name)}.csv`);
}

function nombreArchivo(nombre) {
  return (nombre || 'hoja').replace(/[^\w\-. ]/g, '_').trim() || 'hoja';
}

function descargar(blob, nombre) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = nombre;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// getCell/getDisplayValue se re-exportan para pruebas del exportador.
export { getCell, getDisplayValue };
