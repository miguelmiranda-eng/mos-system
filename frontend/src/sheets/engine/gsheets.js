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
  } catch (e) {
    throw new Error(`No se pudo contactar el servidor (${e?.message || 'error de red'}).`);
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
  let totalEstilos = 0;
  const sheets = (data.sheets || []).map((s) => {
    const filas = s.values || [];
    const formatos = s.formats || [];
    const merges = s.merges || [];
    const colWidths = s.colWidths || {};

    // La hoja debe cubrir todo lo que llega: valores, celdas con solo formato,
    // combinadas y columnas con ancho propio pueden ir mas alla de los valores.
    let maxFila = filas.length - 1;
    let maxCol = filas.reduce((m, f) => Math.max(m, f.length), 0) - 1;
    for (const f of formatos) { maxFila = Math.max(maxFila, f.r); maxCol = Math.max(maxCol, f.c); }
    for (const m of merges) { maxFila = Math.max(maxFila, m.r2); maxCol = Math.max(maxCol, m.c2); }
    for (const c of Object.keys(colWidths)) maxCol = Math.max(maxCol, Number(c));

    const hoja = makeSheet(String(s.name || 'Hoja').slice(0, 60), {
      rows: Math.max(200, maxFila + 20),
      cols: Math.max(26, maxCol + 4),
    });

    // Valores.
    for (let r = 0; r < filas.length; r++) {
      const fila = filas[r];
      for (let c = 0; c < fila.length; c++) {
        const v = fila[c];
        if (v === '' || v == null) continue;
        hoja.cells.set(cellKey(r, c), makeCell({ value: String(v) }));
      }
    }

    // Formato: se fusiona sobre la celda existente (o crea una vacia con estilo,
    // p.ej. una cabecera de color sin texto).
    for (const f of formatos) {
      const estilo = {};
      if (f.bold) estilo.bold = true;
      if (f.italic) estilo.italic = true;
      if (f.underline) estilo.underline = true;
      if (f.align) estilo.align = f.align;
      if (f.color) estilo.color = f.color;
      if (f.fill) estilo.fill = f.fill;
      if (f.fontFamily) estilo.fontFamily = f.fontFamily;
      if (f.fontSize) estilo.fontSize = f.fontSize;
      if (f.wrap) estilo.wrap = true;
      if (Object.keys(estilo).length === 0) continue;
      totalEstilos++;
      const k = cellKey(f.r, f.c);
      const prev = hoja.cells.get(k);
      hoja.cells.set(k, makeCell({
        value: prev?.value ?? null,
        formula: prev?.formula ?? null,
        format: prev?.format,
        style: estilo,
      }));
    }

    // Combinadas.
    hoja.merges = merges.filter(m => m.r1 >= 0 && m.c1 >= 0 && m.r2 >= m.r1 && m.c2 >= m.c1);

    // Anchos de columna.
    for (const [c, px] of Object.entries(colWidths)) {
      const w = Math.round(px);
      if (w > 0) hoja.colWidths.set(Number(c), w);
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
    // Diagnostico de la carga (no es parte del libro; el store lo separa y lo
    // reporta en el toast): cuantos estilos se aplicaron y, si el backend no
    // pudo leer el formato, el motivo.
    _info: {
      estilos: totalEstilos,
      formatoError: data._diag?.formato_error || null,
    },
  };
}

/** Convierte una hoja del modelo en una matriz de valores (hasta la ultima celda escrita). */
function hojaAMatriz(sheet) {
  let maxR = -1; let maxC = -1;
  for (const [k, cell] of sheet.cells) {
    // Solo cuentan las celdas con CONTENIDO: una celda que apenas trae estilo
    // (cabecera de color de Google) no debe estirar la matriz a miles de "".
    if (cell.value == null && cell.formula == null) continue;
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
    // Sin cola de vacios: cada "" de relleno engorda el POST, y el proxy corta
    // los cuerpos grandes. La pestaña se limpia antes de escribir, asi que las
    // filas cortas no dejan datos viejos.
    let fin = fila.length;
    while (fin > 0 && fila[fin - 1] === '') fin--;
    filas.push(fila.slice(0, fin));
  }
  return filas;
}

/**
 * Parte una matriz en bloques de filas cuyo JSON no pase de maxBytes. El proxy
 * de produccion corta los cuerpos de ~1MB sin responder (el navegador lo ve
 * como "Failed to fetch"), asi que ningun POST debe acercarse a ese limite.
 */
export function partirEnBloques(matriz, maxBytes = 400 * 1024) {
  const bloques = [];
  let inicio = 0; let bytes = 0; let filas = [];
  for (let i = 0; i < matriz.length; i++) {
    const b = JSON.stringify(matriz[i]).length + 1;
    if (filas.length && bytes + b > maxBytes) {
      bloques.push({ startRow: inicio, values: filas });
      inicio = i; filas = []; bytes = 0;
    }
    filas.push(matriz[i]);
    bytes += b;
  }
  if (filas.length) bloques.push({ startRow: inicio, values: filas });
  return bloques;
}

/**
 * Escribe el libro de vuelta al Google Sheet de origen. Devuelve {ok} o
 * {ok:false, error, necesitaConectar}. Solo se escriben las pestañas que existen
 * en Google (por nombre).
 */
export async function guardarEnGoogle(workbook) {
  if (!workbook.googleId) return { ok: false, error: 'Este libro no vino de Google.' };

  // Cada pestaña viaja en BLOQUES de filas en peticiones separadas: el primer
  // bloque limpia la pestaña (clear) y los demas escriben en su offset. Una
  // pestaña vacia manda un solo bloque sin valores, que solo limpia.
  const peticiones = [];
  for (const s of workbook.sheets) {
    const matriz = hojaAMatriz(s);
    const bloques = matriz.length ? partirEnBloques(matriz) : [{ startRow: 0, values: [] }];
    bloques.forEach((b, i) => {
      peticiones.push({ name: s.name, values: b.values, startRow: b.startRow, clear: i === 0 });
    });
  }

  let updatedCells = 0;
  let spreadsheetTitle = '';
  const skipped = new Set();
  for (const p of peticiones) {
    let res;
    try {
      res = await fetch(`${API}/gsheets/write`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ googleId: workbook.googleId, sheets: [p] }),
      });
    } catch (e) {
      return { ok: false, error: `No se pudo contactar el servidor (${e?.message || 'error de red'}). Reintenta en unos segundos.` };
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
    updatedCells += data.updatedCells || 0;
    spreadsheetTitle = data.spreadsheetTitle || spreadsheetTitle;
    for (const n of data.skipped || []) skipped.add(n);
  }

  // Si TODAS las pestañas de MOS fueron omitidas, nada se escribio: es un error
  // (los nombres no coinciden con los de Google), no un guardado exitoso.
  if (skipped.size >= workbook.sheets.length) {
    return { ok: false, error: `Ninguna pestaña coincide con las de Google: ${[...skipped].join(', ')}` };
  }

  return {
    ok: true,
    skipped: [...skipped],
    // Confirmacion de Google: celdas realmente escritas y titulo del archivo
    // destino. Sirve para distinguir "Google rechazo" de "escribio pero el
    // usuario mira otro archivo".
    updatedCells,
    spreadsheetTitle,
  };
}
