import { makeSheet, makeCell, getCell, getEditValue } from './model';
import { cellKey } from './address';
import { API } from '../../lib/constants';

/**
 * Lectura de Google Sheets a traves del backend (OAuth por usuario).
 *
 * FASE 2 — solo lectura. El backend (routers/gsheets.py) usa el permiso de
 * Google del propio usuario (mismo patron que el calendario), asi que puede leer
 * cualquier hoja que esa persona pueda ver, incluidas las restringidas al
 * dominio. Sirve para abrir dentro de MOS los packing lists compartidos como
 * link en los comentarios, sin salir a Google.
 *
 * Viaja el CONTENIDO (valores). Formato, formulas y graficas de Google no
 * viajan; para eso queda el boton "Abrir en Google".
 */

/** ¿La URL es de Google Sheets? */
export function esUrlGoogleSheets(url) {
  return /docs\.google\.com\/spreadsheets\/d\//.test(String(url || ''));
}

/** Extrae el ID del spreadsheet de una URL de Google Sheets. */
export function idDeUrl(url) {
  const m = /\/spreadsheets\/d\/([a-zA-Z0-9\-_]+)/.exec(String(url || ''));
  return m ? m[1] : null;
}

/** Pide la URL de consentimiento y manda al usuario a conectar Google. */
export async function conectarGoogle() {
  const res = await fetch(`${API}/gsheets/auth-url`, { credentials: 'include' });
  if (!res.ok) throw new Error('No se pudo iniciar la conexión con Google.');
  const { url } = await res.json();
  window.location.href = url;   // vuelve a /sheets?google_connected=true
}

/**
 * Lee un Google Sheet via backend y lo arma como libro del modelo de MOS.
 * Lanza un Error; si hace falta conectar Google, el error lleva
 * `necesitaConectar = true` para que la interfaz ofrezca el boton.
 */
export async function importarGoogleSheet(url) {
  let res;
  try {
    res = await fetch(`${API}/gsheets/read?url=${encodeURIComponent(url)}`, { credentials: 'include' });
  } catch {
    throw new Error('No se pudo contactar el servidor.');
  }

  if (!res.ok) {
    let detalle = `Error ${res.status}`;
    try { const j = await res.json(); detalle = j.detail || detalle; } catch { /* noop */ }
    if (res.status === 401 && detalle === 'need_connect') {
      const err = new Error('Conecta tu cuenta de Google para abrir hojas de Google Sheets.');
      err.necesitaConectar = true;
      throw err;
    }
    if (res.status === 403 && detalle === 'no_access') {
      throw new Error('Tu cuenta de Google no tiene acceso a esa hoja. Pide que te la compartan o ábrela en Google.');
    }
    throw new Error(detalle);
  }

  const data = await res.json();
  const sheets = (data.sheets || []).map((s) => {
    const filas = s.values || [];
    const nFilas = filas.length;
    const nCols = filas.reduce((m, f) => Math.max(m, f.length), 0);
    const hoja = makeSheet(String(s.name || 'Hoja').slice(0, 60), {
      rows: Math.max(200, nFilas + 20),
      cols: Math.max(26, nCols + 4),
    });
    for (let r = 0; r < nFilas; r++) {
      const fila = filas[r];
      for (let c = 0; c < fila.length; c++) {
        const v = fila[c];
        if (v === '' || v == null) continue;
        hoja.cells.set(cellKey(r, c), makeCell({ value: String(v) }));
      }
    }
    return hoja;
  });

  if (sheets.length === 0) throw new Error('La hoja no tiene contenido legible.');

  return {
    id: `gs_${data.googleId}`,
    name: data.name || 'Google Sheet',
    sheets,
    activeSheetId: sheets[0].id,
    googleUrl: data.googleUrl || url,
    googleId: data.googleId,
  };
}

/** Convierte una hoja del modelo en una matriz de valores (hasta la ultima celda escrita). */
function hojaAMatriz(sheet) {
  let maxR = -1; let maxC = -1;
  for (const k of sheet.cells.keys()) {
    const i = k.indexOf(':');
    maxR = Math.max(maxR, +k.slice(0, i));
    maxC = Math.max(maxC, +k.slice(i + 1));
  }
  const filas = [];
  for (let r = 0; r <= maxR; r++) {
    const fila = [];
    for (let c = 0; c <= maxC; c++) {
      // getEditValue: valor crudo o "=formula" (Google la interpreta con USER_ENTERED).
      fila.push(getEditValue(getCell(sheet, r, c)));
    }
    filas.push(fila);
  }
  return filas;
}

/**
 * Escribe el libro de vuelta al Google Sheet de origen. Devuelve {ok} o
 * {ok:false, error, necesitaConectar}. Solo se escriben las pestañas que existen
 * en Google (por nombre).
 */
export async function guardarEnGoogle(workbook) {
  if (!workbook.googleId) return { ok: false, error: 'Este libro no vino de Google.' };
  const payload = {
    googleId: workbook.googleId,
    sheets: workbook.sheets.map(s => ({ name: s.name, values: hojaAMatriz(s) })),
  };
  let res;
  try {
    res = await fetch(`${API}/gsheets/write`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify(payload),
    });
  } catch {
    return { ok: false, error: 'No se pudo contactar el servidor.' };
  }
  if (!res.ok) {
    let detalle = `Error ${res.status}`;
    try { const j = await res.json(); detalle = j.detail || detalle; } catch { /* noop */ }
    if (res.status === 401 && detalle === 'need_connect') {
      return { ok: false, error: 'Conecta tu cuenta de Google.', necesitaConectar: true };
    }
    if (res.status === 403 && detalle === 'no_edit') {
      return { ok: false, error: 'No tienes permiso de edición en esa hoja de Google.' };
    }
    return { ok: false, error: detalle };
  }
  const data = await res.json();
  return { ok: true, skipped: data.skipped || [] };
}
