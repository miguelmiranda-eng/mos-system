import {
  replaceSheet, getSheet, getCell, setCells, setColWidth, setRowHeight, toggleColHidden,
  showAllCols, addMerge, removeMergesIn, findMerge,
  insertRows, deleteRows, insertCols, deleteCols, makeSheet, makeCell, FORMATS,
} from './model';
import { forEachCell } from './address';

/**
 * Capa de comandos: TODA modificacion del libro pasa por aqui.
 *
 * Cada comando sabe hacerse y deshacerse. El historial no guarda copias del
 * libro entero —con 50,000 filas eso serian decenas de MB por paso— sino lo
 * minimo para revertir: las celdas que se tocaron, tal como estaban.
 *
 * Regla que sostiene el undo: un comando calcula su `undo` LEYENDO EL ESTADO
 * ANTES de aplicarse. Por eso `create()` recibe el libro y devuelve el comando
 * ya "cargado"; aplicarlo despues sobre otro estado seria incorrecto y por eso
 * el historial nunca reordena comandos.
 */

// ── Utilidades ───────────────────────────────────────────────────────────────

/** Fotografia de un rango: lo que hay que restaurar para deshacer. */
function snapshotRange(sheet, range) {
  const previas = [];
  forEachCell(range, (row, col) => {
    previas.push({ row, col, cell: getCell(sheet, row, col) });
  });
  return previas;
}

function aplicarCeldas(wb, sheetId, entradas) {
  return replaceSheet(wb, sheetId, (s) => setCells(s, entradas));
}

// ── Comandos ─────────────────────────────────────────────────────────────────

/**
 * Escribe celdas en un rango. Cubre editar una celda, pegar y borrar:
 * las tres son "poner estas celdas aqui, y para deshacer, poner las de antes".
 */
export const setCellsCommand = {
  create(wb, sheetId, entradas, etiqueta = 'Editar celdas') {
    const sheet = getSheet(wb, sheetId);
    if (!sheet) return null;
    const previas = entradas.map(({ row, col }) => ({
      row, col, cell: getCell(sheet, row, col),
    }));
    return { tipo: 'setCells', sheetId, etiqueta, entradas, previas };
  },
  apply: (wb, cmd) => aplicarCeldas(wb, cmd.sheetId, cmd.entradas),
  revert: (wb, cmd) => aplicarCeldas(wb, cmd.sheetId, cmd.previas),
};

/** Borra el contenido de un rango, conservando ancho de columna y demas. */
export const clearRangeCommand = {
  create(wb, sheetId, range, etiqueta = 'Borrar contenido') {
    const sheet = getSheet(wb, sheetId);
    if (!sheet) return null;
    const previas = snapshotRange(sheet, range);
    // Solo se tocan las celdas que existian: borrar vacias no cambia nada y
    // engordaria el historial sin motivo.
    const entradas = previas.filter(p => p.cell).map(p => ({ row: p.row, col: p.col, cell: null }));
    if (entradas.length === 0) return null;
    return {
      tipo: 'setCells', sheetId, etiqueta, entradas,
      previas: previas.filter(p => p.cell),
    };
  },
  apply: setCellsCommand.apply,
  revert: setCellsCommand.revert,
};

/** Aplica formato a un rango sin tocar los valores. */
export const formatRangeCommand = {
  create(wb, sheetId, range, format, etiqueta = 'Aplicar formato') {
    const sheet = getSheet(wb, sheetId);
    if (!sheet) return null;
    const previas = [];
    const entradas = [];
    forEachCell(range, (row, col) => {
      const actual = getCell(sheet, row, col);
      // Formatear una celda vacia si sirve: deja el formato listo para cuando
      // se escriba encima, igual que Excel.
      const base = actual || makeCell({});
      if (base.format === format) return;
      previas.push({ row, col, cell: actual });
      entradas.push({ row, col, cell: { ...base, format } });
    });
    if (entradas.length === 0) return null;
    return { tipo: 'setCells', sheetId, etiqueta, entradas, previas };
  },
  apply: setCellsCommand.apply,
  revert: setCellsCommand.revert,
};

/** Alterna negrita/cursiva/alineacion en un rango. */
export const styleRangeCommand = {
  create(wb, sheetId, range, patchStyle, etiqueta = 'Aplicar estilo') {
    const sheet = getSheet(wb, sheetId);
    if (!sheet) return null;
    const previas = [];
    const entradas = [];
    forEachCell(range, (row, col) => {
      const actual = getCell(sheet, row, col);
      const base = actual || makeCell({});
      const style = { ...(base.style || {}), ...patchStyle };
      // Un estilo con todo apagado vuelve a ser null: el modelo trata la celda
      // como vacia y la saca del mapa si tampoco tiene valor.
      const limpio = Object.fromEntries(Object.entries(style).filter(([, v]) => v));
      previas.push({ row, col, cell: actual });
      entradas.push({
        row, col,
        cell: { ...base, style: Object.keys(limpio).length ? limpio : null },
      });
    });
    if (entradas.length === 0) return null;
    return { tipo: 'setCells', sheetId, etiqueta, entradas, previas };
  },
  apply: setCellsCommand.apply,
  revert: setCellsCommand.revert,
};

export const resizeColCommand = {
  create(wb, sheetId, col, width) {
    const sheet = getSheet(wb, sheetId);
    if (!sheet) return null;
    return {
      tipo: 'resizeCol', sheetId, etiqueta: 'Ajustar ancho', col,
      width, previo: sheet.colWidths.get(col) ?? null,
    };
  },
  apply: (wb, c) => replaceSheet(wb, c.sheetId, (s) => setColWidth(s, c.col, c.width)),
  revert: (wb, c) => replaceSheet(wb, c.sheetId, (s) => (
    c.previo == null ? setColWidth(s, c.col, undefined) : setColWidth(s, c.col, c.previo)
  )),
};

export const resizeRowCommand = {
  create(wb, sheetId, row, height) {
    const sheet = getSheet(wb, sheetId);
    if (!sheet) return null;
    return {
      tipo: 'resizeRow', sheetId, etiqueta: 'Ajustar alto', row,
      height, previo: sheet.rowHeights.get(row) ?? null,
    };
  },
  apply: (wb, c) => replaceSheet(wb, c.sheetId, (s) => setRowHeight(s, c.row, c.height)),
  revert: (wb, c) => replaceSheet(wb, c.sheetId, (s) => (
    c.previo == null ? setRowHeight(s, c.row, undefined) : setRowHeight(s, c.row, c.previo)
  )),
};

/** Ajusta VARIAS columnas al mismo ancho de una sola vez (una accion de undo). */
export const resizeColsCommand = {
  create(wb, sheetId, cols, width) {
    const sheet = getSheet(wb, sheetId);
    if (!sheet || !cols.length) return null;
    const previos = cols.map(col => ({ col, previo: sheet.colWidths.get(col) ?? null }));
    return { tipo: 'resizeCols', sheetId, etiqueta: 'Ajustar ancho', width, previos };
  },
  apply: (wb, c) => replaceSheet(wb, c.sheetId, (s) => {
    let out = s;
    for (const { col } of c.previos) out = setColWidth(out, col, c.width);
    return out;
  }),
  revert: (wb, c) => replaceSheet(wb, c.sheetId, (s) => {
    let out = s;
    for (const { col, previo } of c.previos) out = setColWidth(out, col, previo == null ? undefined : previo);
    return out;
  }),
};

export const resizeRowsCommand = {
  create(wb, sheetId, rows, height) {
    const sheet = getSheet(wb, sheetId);
    if (!sheet || !rows.length) return null;
    const previos = rows.map(row => ({ row, previo: sheet.rowHeights.get(row) ?? null }));
    return { tipo: 'resizeRows', sheetId, etiqueta: 'Ajustar alto', height, previos };
  },
  apply: (wb, c) => replaceSheet(wb, c.sheetId, (s) => {
    let out = s;
    for (const { row } of c.previos) out = setRowHeight(out, row, c.height);
    return out;
  }),
  revert: (wb, c) => replaceSheet(wb, c.sheetId, (s) => {
    let out = s;
    for (const { row, previo } of c.previos) out = setRowHeight(out, row, previo == null ? undefined : previo);
    return out;
  }),
};

export const hideColCommand = {
  create(wb, sheetId, col, hidden) {
    return { tipo: 'hideCol', sheetId, etiqueta: hidden ? 'Ocultar columna' : 'Mostrar columna', col, hidden };
  },
  apply: (wb, c) => replaceSheet(wb, c.sheetId, (s) => toggleColHidden(s, c.col, c.hidden)),
  revert: (wb, c) => replaceSheet(wb, c.sheetId, (s) => toggleColHidden(s, c.col, !c.hidden)),
};

export const showAllColsCommand = {
  create(wb, sheetId) {
    const sheet = getSheet(wb, sheetId);
    if (!sheet || sheet.hiddenCols.size === 0) return null;
    return { tipo: 'showAllCols', sheetId, etiqueta: 'Mostrar columnas', ocultas: [...sheet.hiddenCols] };
  },
  apply: (wb, c) => replaceSheet(wb, c.sheetId, (s) => showAllCols(s)),
  revert: (wb, c) => replaceSheet(wb, c.sheetId, (s) => {
    let out = s;
    for (const col of c.ocultas) out = toggleColHidden(out, col, true);
    return out;
  }),
};

/** Combina un rango: conserva el valor de la esquina y borra el resto. */
export const mergeCommand = {
  create(wb, sheetId, range, etiqueta = 'Combinar celdas') {
    const sheet = getSheet(wb, sheetId);
    if (!sheet) return null;
    if (range.r1 === range.r2 && range.c1 === range.c2) return null; // una sola celda
    const previas = snapshotRange(sheet, range);
    // Excel conserva solo la esquina superior-izquierda al combinar.
    const entradas = [];
    forEachCell(range, (row, col) => {
      if (row === range.r1 && col === range.c1) return;
      if (getCell(sheet, row, col)) entradas.push({ row, col, cell: null });
    });
    return {
      tipo: 'merge', sheetId, etiqueta, range,
      entradas, previas: previas.filter(p => p.cell),
      mergesPrevias: sheet.merges,
    };
  },
  apply: (wb, c) => replaceSheet(wb, c.sheetId, (s) => addMerge(setCells(s, c.entradas), c.range)),
  revert: (wb, c) => replaceSheet(wb, c.sheetId, (s) => {
    const conCeldas = setCells(s, c.previas);
    return { ...conCeldas, merges: c.mergesPrevias };
  }),
};

export const unmergeCommand = {
  create(wb, sheetId, range) {
    const sheet = getSheet(wb, sheetId);
    if (!sheet) return null;
    const afectadas = sheet.merges.filter(m =>
      m.r1 <= range.r2 && m.r2 >= range.r1 && m.c1 <= range.c2 && m.c2 >= range.c1);
    if (afectadas.length === 0) return null;
    return { tipo: 'unmerge', sheetId, etiqueta: 'Separar celdas', range, mergesPrevias: sheet.merges };
  },
  apply: (wb, c) => replaceSheet(wb, c.sheetId, (s) => removeMergesIn(s, c.range)),
  revert: (wb, c) => replaceSheet(wb, c.sheetId, (s) => ({ ...s, merges: c.mergesPrevias })),
};

/**
 * Ordena las filas de un rango por su primera columna. Reescribe solo las
 * celdas del rango, asi que se deshace como cualquier edicion de celdas.
 */
export const sortRangeCommand = {
  // colClave: columna ABSOLUTA por la que ordenar. Por defecto, la 1a del rango.
  create(wb, sheetId, range, ascendente = true, colClave = null) {
    const sheet = getSheet(wb, sheetId);
    if (!sheet) return null;
    if (range.r1 === range.r2) return null;

    const filas = [];
    for (let r = range.r1; r <= range.r2; r++) {
      const fila = [];
      for (let c = range.c1; c <= range.c2; c++) fila.push(getCell(sheet, r, c));
      filas.push(fila);
    }

    const idxClave = colClave == null ? 0 : Math.max(0, Math.min(range.c2 - range.c1, colClave - range.c1));
    const clave = (fila) => {
      const cell = fila[idxClave];
      // Vacia = sin celda, sin valor, o solo espacios. Todas van al final.
      if (!cell || cell.value == null || String(cell.value).trim() === '') return { vacio: true };
      const n = Number(cell.value);
      return Number.isFinite(n) ? { num: n } : { txt: String(cell.value).toLowerCase() };
    };

    const indices = filas.map((_, i) => i).sort((a, b) => {
      const ka = clave(filas[a]); const kb = clave(filas[b]);
      // Las vacias siempre al final, ordene como ordene.
      if (ka.vacio && kb.vacio) return 0;
      if (ka.vacio) return 1;
      if (kb.vacio) return -1;
      let cmp;
      if ('num' in ka && 'num' in kb) cmp = ka.num - kb.num;
      else cmp = String(ka.num ?? ka.txt).localeCompare(String(kb.num ?? kb.txt), 'es');
      return ascendente ? cmp : -cmp;
    });

    const previas = [];
    const entradas = [];
    for (let i = 0; i < filas.length; i++) {
      const destino = range.r1 + i;
      const origen = filas[indices[i]];
      for (let c = 0; c < origen.length; c++) {
        const col = range.c1 + c;
        previas.push({ row: destino, col, cell: getCell(sheet, destino, col) });
        entradas.push({ row: destino, col, cell: origen[c] });
      }
    }
    return {
      tipo: 'setCells', sheetId,
      etiqueta: ascendente ? 'Ordenar ascendente' : 'Ordenar descendente',
      entradas, previas,
    };
  },
  apply: setCellsCommand.apply,
  revert: setCellsCommand.revert,
};

export const insertRowsCommand = {
  create: (wb, sheetId, at, cantidad = 1) => ({
    tipo: 'insertRows', sheetId, etiqueta: 'Insertar filas', at, cantidad,
  }),
  apply: (wb, c) => replaceSheet(wb, c.sheetId, (s) => insertRows(s, c.at, c.cantidad)),
  revert: (wb, c) => replaceSheet(wb, c.sheetId, (s) => deleteRows(s, c.at, c.cantidad)),
};

/**
 * Borrar filas SI necesita fotografia: lo que se va no se puede reconstruir
 * desplazando de vuelta. Se guardan solo las celdas escritas de esas filas.
 */
export const deleteRowsCommand = {
  create(wb, sheetId, at, cantidad = 1) {
    const sheet = getSheet(wb, sheetId);
    if (!sheet) return null;
    const borradas = [];
    for (let r = at; r < at + cantidad; r++) {
      for (let c = 0; c < sheet.cols; c++) {
        const cell = getCell(sheet, r, c);
        if (cell) borradas.push({ row: r, col: c, cell });
      }
    }
    return { tipo: 'deleteRows', sheetId, etiqueta: 'Eliminar filas', at, cantidad, borradas };
  },
  apply: (wb, c) => replaceSheet(wb, c.sheetId, (s) => deleteRows(s, c.at, c.cantidad)),
  revert: (wb, c) => replaceSheet(wb, c.sheetId, (s) => (
    setCells(insertRows(s, c.at, c.cantidad), c.borradas)
  )),
};

export const insertColsCommand = {
  create: (wb, sheetId, at, cantidad = 1) => ({
    tipo: 'insertCols', sheetId, etiqueta: 'Insertar columnas', at, cantidad,
  }),
  apply: (wb, c) => replaceSheet(wb, c.sheetId, (s) => insertCols(s, c.at, c.cantidad)),
  revert: (wb, c) => replaceSheet(wb, c.sheetId, (s) => deleteCols(s, c.at, c.cantidad)),
};

export const deleteColsCommand = {
  create(wb, sheetId, at, cantidad = 1) {
    const sheet = getSheet(wb, sheetId);
    if (!sheet) return null;
    const borradas = [];
    for (let c = at; c < at + cantidad; c++) {
      for (let r = 0; r < sheet.rows; r++) {
        const cell = getCell(sheet, r, c);
        if (cell) borradas.push({ row: r, col: c, cell });
      }
    }
    return { tipo: 'deleteCols', sheetId, etiqueta: 'Eliminar columnas', at, cantidad, borradas };
  },
  apply: (wb, c) => replaceSheet(wb, c.sheetId, (s) => deleteCols(s, c.at, c.cantidad)),
  revert: (wb, c) => replaceSheet(wb, c.sheetId, (s) => (
    setCells(insertCols(s, c.at, c.cantidad), c.borradas)
  )),
};

// ── Hojas ────────────────────────────────────────────────────────────────────

export const addSheetCommand = {
  create(wb, nombre) {
    const hoja = makeSheet(nombre || `Hoja ${wb.sheets.length + 1}`);
    return { tipo: 'addSheet', etiqueta: 'Agregar hoja', hoja, previoActivo: wb.activeSheetId };
  },
  apply: (wb, c) => ({ ...wb, sheets: [...wb.sheets, c.hoja], activeSheetId: c.hoja.id }),
  revert: (wb, c) => ({
    ...wb,
    sheets: wb.sheets.filter(s => s.id !== c.hoja.id),
    activeSheetId: c.previoActivo,
  }),
};

export const renameSheetCommand = {
  create(wb, sheetId, nombre) {
    const s = getSheet(wb, sheetId);
    if (!s || s.name === nombre) return null;
    return { tipo: 'renameSheet', etiqueta: 'Renombrar hoja', sheetId, nombre, previo: s.name };
  },
  apply: (wb, c) => replaceSheet(wb, c.sheetId, (s) => ({ ...s, name: c.nombre })),
  revert: (wb, c) => replaceSheet(wb, c.sheetId, (s) => ({ ...s, name: c.previo })),
};

export const duplicateSheetCommand = {
  create(wb, sheetId) {
    const s = getSheet(wb, sheetId);
    if (!s) return null;
    const copia = {
      ...makeSheet(`${s.name} (copia)`),
      rows: s.rows, cols: s.cols,
      cells: new Map(s.cells),
      colWidths: new Map(s.colWidths),
      rowHeights: new Map(s.rowHeights),
      hiddenCols: new Set(s.hiddenCols),
      frozenRows: s.frozenRows, frozenCols: s.frozenCols,
    };
    const at = wb.sheets.findIndex(x => x.id === sheetId) + 1;
    return { tipo: 'duplicateSheet', etiqueta: 'Duplicar hoja', copia, at, previoActivo: wb.activeSheetId };
  },
  apply: (wb, c) => {
    const sheets = wb.sheets.slice();
    sheets.splice(c.at, 0, c.copia);
    return { ...wb, sheets, activeSheetId: c.copia.id };
  },
  revert: (wb, c) => ({
    ...wb,
    sheets: wb.sheets.filter(s => s.id !== c.copia.id),
    activeSheetId: c.previoActivo,
  }),
};

export const deleteSheetCommand = {
  create(wb, sheetId) {
    // Un libro sin hojas no es un estado valido: no hay donde escribir ni que
    // dibujar. Se bloquea aqui, no en la interfaz, para que ninguna otra via
    // pueda dejarlo asi.
    if (wb.sheets.length <= 1) return null;
    const at = wb.sheets.findIndex(s => s.id === sheetId);
    if (at < 0) return null;
    const hoja = wb.sheets[at];
    const siguiente = wb.sheets[at + 1] || wb.sheets[at - 1];
    return {
      tipo: 'deleteSheet', etiqueta: 'Eliminar hoja', hoja, at,
      previoActivo: wb.activeSheetId, nuevoActivo: siguiente.id,
    };
  },
  apply: (wb, c) => ({
    ...wb,
    sheets: wb.sheets.filter(s => s.id !== c.hoja.id),
    activeSheetId: wb.activeSheetId === c.hoja.id ? c.nuevoActivo : wb.activeSheetId,
  }),
  revert: (wb, c) => {
    const sheets = wb.sheets.slice();
    sheets.splice(c.at, 0, c.hoja);
    return { ...wb, sheets, activeSheetId: c.previoActivo };
  },
};

export const freezeCommand = {
  create(wb, sheetId, frozenRows, frozenCols) {
    const s = getSheet(wb, sheetId);
    if (!s) return null;
    if (s.frozenRows === frozenRows && s.frozenCols === frozenCols) return null;
    return {
      tipo: 'freeze', etiqueta: 'Congelar paneles', sheetId, frozenRows, frozenCols,
      previo: { frozenRows: s.frozenRows, frozenCols: s.frozenCols },
    };
  },
  apply: (wb, c) => replaceSheet(wb, c.sheetId, (s) => ({
    ...s, frozenRows: c.frozenRows, frozenCols: c.frozenCols,
  })),
  revert: (wb, c) => replaceSheet(wb, c.sheetId, (s) => ({ ...s, ...c.previo })),
};

// ── Registro ─────────────────────────────────────────────────────────────────

/**
 * Un comando guardado en el historial es datos puros; el registro dice como
 * ejecutarlo. Asi el historial se puede serializar mas adelante (fase 2) sin
 * arrastrar funciones.
 */
const REGISTRO = {
  setCells: setCellsCommand,
  resizeCol: resizeColCommand,
  resizeRow: resizeRowCommand,
  resizeCols: resizeColsCommand,
  resizeRows: resizeRowsCommand,
  hideCol: hideColCommand,
  showAllCols: showAllColsCommand,
  merge: mergeCommand,
  unmerge: unmergeCommand,
  insertRows: insertRowsCommand,
  deleteRows: deleteRowsCommand,
  insertCols: insertColsCommand,
  deleteCols: deleteColsCommand,
  addSheet: addSheetCommand,
  renameSheet: renameSheetCommand,
  duplicateSheet: duplicateSheetCommand,
  deleteSheet: deleteSheetCommand,
  freeze: freezeCommand,
};

export function applyCommand(wb, cmd) {
  const h = REGISTRO[cmd.tipo];
  if (!h) throw new Error(`Comando desconocido: ${cmd.tipo}`);
  return h.apply(wb, cmd);
}

export function revertCommand(wb, cmd) {
  const h = REGISTRO[cmd.tipo];
  if (!h) throw new Error(`Comando desconocido: ${cmd.tipo}`);
  return h.revert(wb, cmd);
}

export { FORMATS };
