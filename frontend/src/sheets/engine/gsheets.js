import { makeSheet, makeCell, getCell, getEditValue } from './model';
import { cellKey, colToLetters, fromA1 } from './address';
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

/**
 * Resuelve el origen de un desplegable ONE_OF_RANGE ("=Listas!$A$2:$A$20") a
 * sus valores no vacios, usando las pestañas ya cargadas del mismo libro.
 */
function resolverListaRango(ref, hojaNombre, valoresPorHoja) {
  let s = String(ref || '').trim();
  if (s.startsWith('=')) s = s.slice(1);
  let nombre = hojaNombre;
  let rango = s;
  const sep = s.lastIndexOf('!');
  if (sep >= 0) {
    nombre = s.slice(0, sep).replace(/^'(.*)'$/, '$1');
    rango = s.slice(sep + 1);
  }
  const [ini, fin = ini] = rango.split(':');
  const a = fromA1(ini);
  const b = fromA1(fin);
  const vals = valoresPorHoja[nombre];
  if (!a || !b || !vals) return null;
  const out = [];
  for (let r = Math.min(a.row, b.row); r <= Math.max(a.row, b.row) && out.length < 100; r++) {
    for (let c = Math.min(a.col, b.col); c <= Math.max(a.col, b.col) && out.length < 100; c++) {
      const v = vals[r]?.[c];
      if (v !== '' && v != null) out.push(String(v));
    }
  }
  return out.length ? out : null;
}

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
  // Copia de los valores tal como llegaron de Google, por pestaña. El guardado
  // compara contra esto y escribe SOLO lo que cambio: asi las celdas protegidas
  // de la plantilla (encabezados, formulas) no se tocan y Google no rechaza.
  const origenGoogle = {};
  // Valores tal cual (sin las formulas sobrepuestas): para resolver los rangos
  // de los desplegables (p.ej. una pestaña "Listas" con las opciones).
  const valoresPorHoja = {};
  for (const s of data.sheets || []) {
    const nombre = String(s.name || 'Hoja').slice(0, 60);
    origenGoogle[nombre] = (s.values || []).map(f => f.slice());
    valoresPorHoja[nombre] = s.values || [];
  }
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

    // Formato + formulas + desplegables: se fusionan sobre la celda existente
    // (o crean una vacia con estilo, p.ej. una cabecera de color sin texto).
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

      // Desplegable: lista fija de Google, o rango resuelto con las pestañas
      // cargadas. Vive en style.lista para sobrevivir copias/ediciones igual
      // que el resto del estilo.
      const lista = (f.lista && f.lista.length)
        ? f.lista.map(String)
        : (f.listaRango ? resolverListaRango(f.listaRango, hoja.name, valoresPorHoja) : null);
      if (lista) estilo.lista = lista;
      if (f.checkbox) estilo.checkbox = true;   // checkbox de Google

      // Formula real de Google (llega con "="); el motor de MOS la calcula al
      // editar los datos, y el guardado por diff no la toca si no cambio.
      const conFormula = typeof f.formula === 'string' && f.formula.startsWith('=');

      if (Object.keys(estilo).length === 0 && !conFormula) continue;
      totalEstilos++;
      const k = cellKey(f.r, f.c);
      const prev = hoja.cells.get(k);
      hoja.cells.set(k, makeCell({
        value: prev?.value ?? null,
        formula: conFormula ? f.formula.slice(1) : (prev?.formula ?? null),
        format: prev?.format,
        style: Object.keys(estilo).length ? estilo : (prev?.style ?? null),
      }));
      if (conFormula) {
        // El origen del diff debe decir lo MISMO que getEditValue de esta celda
        // ("=formula"): asi una formula sin tocar no viaja al guardar (y no
        // choca con las celdas protegidas de la plantilla).
        const base = origenGoogle[hoja.name];
        if (base) {
          while (base.length <= f.r) base.push([]);
          while (base[f.r].length <= f.c) base[f.r].push('');
          base[f.r][f.c] = f.formula;
        }
      }
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
    origenGoogle,
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
/**
 * Diferencias entre la hoja actual y la matriz con la que llego de Google:
 * corridas contiguas por fila, como [{ a1: 'C5:F5', values: [[...]] }].
 * Guardar SOLO lo cambiado evita tocar las celdas protegidas de la plantilla
 * (encabezados, formulas): tocarlas hace que Google rechace TODA la escritura.
 */
export function diferencias(matriz, base) {
  const updates = [];
  const nFilas = Math.max(matriz.length, base.length);
  for (let r = 0; r < nFilas; r++) {
    const fCur = matriz[r] || [];
    const fBase = base[r] || [];
    const nCols = Math.max(fCur.length, fBase.length);
    let inicio = -1; let valores = [];
    const cerrar = () => {
      if (inicio < 0) return;
      updates.push({
        a1: `${colToLetters(inicio)}${r + 1}:${colToLetters(inicio + valores.length - 1)}${r + 1}`,
        values: [valores],
      });
      inicio = -1; valores = [];
    };
    for (let c = 0; c < nCols; c++) {
      const cur = fCur[c] ?? '';
      const orig = fBase[c] ?? '';
      if (String(cur) !== String(orig)) {
        if (inicio < 0) inicio = c;
        valores.push(cur);
      } else {
        cerrar();
      }
    }
    cerrar();
  }
  return updates;
}

export async function guardarEnGoogle(workbook) {
  if (!workbook.googleId) return { ok: false, error: 'Este libro no vino de Google.' };

  // Guardado por DIFERENCIAS: cada peticion lleva solo las celdas cambiadas de
  // una pestaña (troceadas si fueran muchas — el proxy corta cuerpos grandes).
  const MAX_BYTES = 300 * 1024;
  const peticiones = [];
  const hojasConCambios = [];
  const origen = workbook.origenGoogle || {};
  for (const s of workbook.sheets) {
    const updates = diferencias(hojaAMatriz(s), origen[s.name] || []);
    if (!updates.length) continue;
    hojasConCambios.push(s.name);
    let grupo = []; let bytes = 0;
    for (const u of updates) {
      const b = JSON.stringify(u).length + 1;
      if (grupo.length && bytes + b > MAX_BYTES) {
        peticiones.push({ name: s.name, updates: grupo });
        grupo = []; bytes = 0;
      }
      grupo.push(u); bytes += b;
    }
    if (grupo.length) peticiones.push({ name: s.name, updates: grupo });
  }

  if (!peticiones.length) {
    return { ok: true, sinCambios: true, skipped: [], updatedCells: 0, spreadsheetTitle: '' };
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

  // Si TODAS las pestañas con cambios fueron omitidas, nada se escribio: es un
  // error (los nombres no coinciden con los de Google), no un guardado exitoso.
  if (hojasConCambios.length && hojasConCambios.every(n => skipped.has(n))) {
    return { ok: false, error: `Ninguna pestaña coincide con las de Google: ${[...skipped].join(', ')}` };
  }

  // El guardado quedo aplicado: lo actual pasa a ser el nuevo punto de
  // comparacion para el siguiente diff.
  const nuevoOrigen = {};
  for (const s of workbook.sheets) nuevoOrigen[s.name] = hojaAMatriz(s);

  return {
    ok: true,
    skipped: [...skipped],
    // Confirmacion de Google: celdas realmente escritas y titulo del archivo
    // destino. Sirve para distinguir "Google rechazo" de "escribio pero el
    // usuario mira otro archivo".
    updatedCells,
    spreadsheetTitle,
    nuevoOrigen,
  };
}
