/**
 * Persistencia de libros en el navegador (IndexedDB).
 *
 * Se usa IndexedDB y no localStorage porque un libro puede pasar los 5 MB que
 * localStorage tolera. Es persistencia REAL —sobrevive recargas y cierres del
 * navegador— aunque local al equipo. Cuando exista el backend con Mongo, este
 * modulo se reemplaza por llamadas a la API sin tocar la interfaz: el store solo
 * conoce guardar/listar/cargar/borrar.
 *
 * El libro se serializa a JSON. Los Map y Set del modelo no son JSON, asi que se
 * convierten a arrays al guardar y se reconstruyen al cargar.
 */

const DB = 'mos_sheets';
const STORE = 'libros';
const VERSION = 1;

function abrir() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const os = db.createObjectStore(STORE, { keyPath: 'id' });
        os.createIndex('updatedAt', 'updatedAt');
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx(db, modo) {
  return db.transaction(STORE, modo).objectStore(STORE);
}

// ── Serializacion (Map/Set <-> JSON) ─────────────────────────────────────────
function serializarHoja(sheet) {
  return {
    id: sheet.id,
    name: sheet.name,
    rows: sheet.rows,
    cols: sheet.cols,
    cells: [...sheet.cells.entries()],          // [[key, cell], ...]
    colWidths: [...sheet.colWidths.entries()],
    rowHeights: [...sheet.rowHeights.entries()],
    hiddenCols: [...sheet.hiddenCols],
    merges: sheet.merges || [],
    filter: sheet.filter ? serializarFiltro(sheet.filter) : null,
    frozenRows: sheet.frozenRows || 0,
    frozenCols: sheet.frozenCols || 0,
    hideGridlines: !!sheet.hideGridlines,
  };
}
// Los criterios de tipo 'valores' guardan un array (no Set), asi que el filtro
// es JSON puro y se serializa tal cual; esta funcion queda por claridad.
function serializarFiltro(f) { return f; }
function deserializarHoja(s) {
  return {
    id: s.id,
    name: s.name,
    rows: s.rows,
    cols: s.cols,
    cells: new Map(s.cells || []),
    colWidths: new Map(s.colWidths || []),
    rowHeights: new Map(s.rowHeights || []),
    hiddenCols: new Set(s.hiddenCols || []),
    merges: s.merges || [],
    filter: s.filter || null,
    frozenRows: s.frozenRows || 0,
    frozenCols: s.frozenCols || 0,
    hideGridlines: !!s.hideGridlines,
  };
}

function serializar(workbook) {
  return {
    id: workbook.id,
    name: workbook.name,
    activeSheetId: workbook.activeSheetId,
    sheets: workbook.sheets.map(serializarHoja),
  };
}
export function deserializar(doc) {
  return {
    id: doc.id,
    name: doc.name,
    activeSheetId: doc.activeSheetId,
    sheets: doc.sheets.map(deserializarHoja),
  };
}

// ── API ──────────────────────────────────────────────────────────────────────

/** Guarda (o actualiza) un libro. Devuelve el timestamp guardado. */
export async function guardarLibro(workbook, updatedAtISO) {
  const db = await abrir();
  const doc = { ...serializar(workbook), updatedAt: updatedAtISO };
  return new Promise((resolve, reject) => {
    const req = tx(db, 'readwrite').put(doc);
    req.onsuccess = () => resolve(updatedAtISO);
    req.onerror = () => reject(req.error);
  }).finally(() => db.close());
}

/** Lista los libros guardados (metadatos, sin las celdas), del mas reciente al mas viejo. */
export async function listarLibros() {
  const db = await abrir();
  return new Promise((resolve, reject) => {
    const req = tx(db, 'readonly').getAll();
    req.onsuccess = () => {
      const filas = (req.result || []).map(d => ({
        id: d.id,
        name: d.name,
        updatedAt: d.updatedAt,
        hojas: d.sheets?.length || 0,
        celdas: (d.sheets || []).reduce((n, s) => n + (s.cells?.length || 0), 0),
      }));
      filas.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
      resolve(filas);
    };
    req.onerror = () => reject(req.error);
  }).finally(() => db.close());
}

/** Carga un libro completo por id, ya deserializado. null si no existe. */
export async function cargarLibro(id) {
  const db = await abrir();
  return new Promise((resolve, reject) => {
    const req = tx(db, 'readonly').get(id);
    req.onsuccess = () => resolve(req.result ? deserializar(req.result) : null);
    req.onerror = () => reject(req.error);
  }).finally(() => db.close());
}

export async function borrarLibro(id) {
  const db = await abrir();
  return new Promise((resolve, reject) => {
    const req = tx(db, 'readwrite').delete(id);
    req.onsuccess = () => resolve(true);
    req.onerror = () => reject(req.error);
  }).finally(() => db.close());
}
