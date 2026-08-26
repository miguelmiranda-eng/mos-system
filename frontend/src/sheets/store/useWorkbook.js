import { create } from 'zustand';
import {
  makeWorkbook, getActiveSheet, getSheet, getCell, parseInput, makeCell,
  regionActual, MAX_ROWS, MAX_COLS, FORMATS,
} from '../engine/model';
import {
  applyCommand, revertCommand,
  setCellsCommand, clearRangeCommand, formatRangeCommand, styleRangeCommand,
  resizeColCommand, resizeRowCommand, resizeColsCommand, resizeRowsCommand,
  hideColCommand, showAllColsCommand,
  mergeCommand, unmergeCommand, sortRangeCommand,
  insertRowsCommand, deleteRowsCommand, insertColsCommand, deleteColsCommand,
  addSheetCommand, renameSheetCommand, duplicateSheetCommand, deleteSheetCommand,
  freezeCommand,
} from '../engine/commands';
import { importarArchivo, exportarXLSX, exportarCSV } from '../engine/io';
import { guardarLibro, cargarLibro } from '../engine/storage';
import { importarGoogleSheet, guardarEnGoogle } from '../engine/gsheets';
import { normalizeRange, rangeToA1, forEachCell } from '../engine/address';
import {
  rangeToTSV, parseTSV, buildPasteEntries, pastedRange, snapshotForCut,
} from '../engine/clipboard';

/**
 * Estado del libro + historial centralizado.
 *
 * Zustand y no Context: con Context, editar una celda re-renderiza todo lo que
 * cuelga del proveedor. Aqui cada componente se suscribe a la rebanada que
 * necesita, asi que escribir en A1 no repinta la hoja entera. En una rejilla
 * virtualizada esa diferencia se ve a simple vista.
 *
 * TODA mutacion pasa por `ejecutar()`. No hay setters sueltos: si algo cambia el
 * libro sin pasar por un comando, el undo deja de ser confiable y el usuario
 * pierde trabajo. Es la invariante que sostiene el resto.
 */

const LIMITE_HISTORIAL = 200;

const seleccionInicial = { row: 0, col: 0 };

export const useWorkbook = create((set, get) => ({
  workbook: makeWorkbook(),

  // Seleccion
  active: seleccionInicial,                    // celda activa (la del cursor)
  range: { r1: 0, c1: 0, r2: 0, c2: 0 },       // seleccion, siempre normalizada
  anchor: seleccionInicial,                    // esquina fija al arrastrar
  editing: null,                               // { row, col } mientras se escribe

  // Formato copiado con la "brocha" (copiar/pegar formato). null = nada copiado.
  formatoCopiado: null,

  // Insertor de referencias del "modo apuntar": lo registra el input de formula
  // enfocado; la rejilla lo usa para meter A1/A1:B5 al hacer clic o arrastrar.
  refInsertor: null,
  // Rango que se está referenciando en modo apuntar, para sombrearlo. null = nada.
  refHighlight: null,

  // Historial
  past: [],
  future: [],
  dirty: false,                                // lo consumira el autosave (fase 2)

  // ── Nucleo ─────────────────────────────────────────────────────────────────

  /**
   * Ejecuta un comando y lo empuja al historial.
   * `create()` devuelve null cuando la operacion no cambia nada (formatear con
   * el formato que ya tenia, borrar un rango vacio): en ese caso no se toca el
   * historial, para que Ctrl+Z no gaste pasos en no-operaciones.
   */
  ejecutar(cmd) {
    if (!cmd) return false;
    set((s) => {
      const past = [...s.past, cmd];
      return {
        workbook: applyCommand(s.workbook, cmd),
        past: past.length > LIMITE_HISTORIAL ? past.slice(past.length - LIMITE_HISTORIAL) : past,
        future: [],   // una accion nueva invalida lo rehacible
        dirty: true,
      };
    });
    return true;
  },

  undo() {
    const { past } = get();
    if (!past.length) return;
    const cmd = past[past.length - 1];
    set((s) => ({
      workbook: revertCommand(s.workbook, cmd),
      past: s.past.slice(0, -1),
      future: [cmd, ...s.future],
      dirty: true,
    }));
  },

  redo() {
    const { future } = get();
    if (!future.length) return;
    const cmd = future[0];
    set((s) => ({
      workbook: applyCommand(s.workbook, cmd),
      past: [...s.past, cmd],
      future: s.future.slice(1),
      dirty: true,
    }));
  },

  marcarGuardado: () => set({ dirty: false }),

  // ── Seleccion ──────────────────────────────────────────────────────────────

  seleccionar(row, col, extender = false) {
    set((s) => {
      const anchor = extender ? s.anchor : { row, col };
      return {
        active: { row, col },
        anchor,
        range: normalizeRange(anchor, { row, col }),
        editing: null,
      };
    });
  },

  seleccionarRango(range) {
    set({
      range,
      active: { row: range.r1, col: range.c1 },
      anchor: { row: range.r1, col: range.c1 },
      editing: null,
    });
  },

  /** Mover el cursor con las flechas. `extender` = Shift. */
  mover(dRow, dCol, extender = false) {
    const { active, workbook } = get();
    const sheet = getActiveSheet(workbook);
    const row = Math.max(0, Math.min(sheet.rows - 1, active.row + dRow));
    const col = Math.max(0, Math.min(sheet.cols - 1, active.col + dCol));
    get().seleccionar(row, col, extender);
  },

  seleccionarTodo() {
    const sheet = getActiveSheet(get().workbook);
    get().seleccionarRango({ r1: 0, c1: 0, r2: sheet.rows - 1, c2: sheet.cols - 1 });
  },

  seleccionarColumna(col, extender = false) {
    const sheet = getActiveSheet(get().workbook);
    const { anchor } = get();
    const c1 = extender ? Math.min(anchor.col, col) : col;
    const c2 = extender ? Math.max(anchor.col, col) : col;
    set({
      range: { r1: 0, c1, r2: sheet.rows - 1, c2 },
      active: { row: 0, col },
      anchor: extender ? get().anchor : { row: 0, col },
      editing: null,
    });
  },

  seleccionarFila(row, extender = false) {
    const sheet = getActiveSheet(get().workbook);
    const { anchor } = get();
    const r1 = extender ? Math.min(anchor.row, row) : row;
    const r2 = extender ? Math.max(anchor.row, row) : row;
    set({
      range: { r1, c1: 0, r2, c2: sheet.cols - 1 },
      active: { row, col: 0 },
      anchor: extender ? get().anchor : { row, col: 0 },
      editing: null,
    });
  },

  empezarEdicion: (row, col) => set({ editing: { row, col } }),
  cancelarEdicion: () => set({ editing: null }),

  // ── Operaciones sobre celdas ───────────────────────────────────────────────

  /** Confirma lo escrito en una celda. */
  escribirCelda(row, col, texto) {
    const { workbook } = get();
    const sheetId = workbook.activeSheetId;
    const patch = parseInput(texto);
    const cmd = setCellsCommand.create(
      workbook, sheetId,
      [{ row, col, cell: patch ? makeCell(patch) : null }],
      'Editar celda',
    );
    get().ejecutar(cmd);
    set({ editing: null });
  },

  borrarSeleccion() {
    const { workbook, range } = get();
    get().ejecutar(clearRangeCommand.create(workbook, workbook.activeSheetId, range));
  },

  aplicarFormato(format) {
    const { workbook, range } = get();
    get().ejecutar(formatRangeCommand.create(workbook, workbook.activeSheetId, range, format));
  },

  /**
   * Alterna un estilo sobre el rango. La decision se toma mirando la celda
   * ACTIVA, como Excel: si esta en negrita, la accion quita negrita a todo el
   * rango. Mirar celda por celda daria un resultado en damero.
   */
  alternarEstilo(clave) {
    const { workbook, range, active } = get();
    const sheet = getActiveSheet(workbook);
    const actual = getCell(sheet, active.row, active.col);
    const nuevo = !(actual?.style?.[clave]);
    get().ejecutar(styleRangeCommand.create(
      workbook, workbook.activeSheetId, range, { [clave]: nuevo }, 'Aplicar estilo',
    ));
  },

  alinear(align) {
    const { workbook, range } = get();
    get().ejecutar(styleRangeCommand.create(
      workbook, workbook.activeSheetId, range, { align }, 'Alinear',
    ));
  },

  /** Aplica un parche de estilo arbitrario al rango (color, fuente, tamano...). */
  aplicarEstilo(patch, etiqueta = 'Aplicar estilo') {
    const { workbook, range } = get();
    get().ejecutar(styleRangeCommand.create(workbook, workbook.activeSheetId, range, patch, etiqueta));
  },

  colorTexto: (color) => get().aplicarEstilo({ color: color || null }, 'Color de texto'),
  colorRelleno: (fill) => get().aplicarEstilo({ fill: fill || null }, 'Color de relleno'),
  fuenteFamilia: (fontFamily) => get().aplicarEstilo({ fontFamily: fontFamily || null }, 'Fuente'),
  fuenteTamano: (fontSize) => get().aplicarEstilo({ fontSize: fontSize || null }, 'Tamano de fuente'),

  alternarAjusteTexto() {
    const { workbook, range, active } = get();
    const sheet = getActiveSheet(workbook);
    const actual = getCell(sheet, active.row, active.col);
    const nuevo = !(actual?.style?.wrap);
    get().ejecutar(styleRangeCommand.create(
      workbook, workbook.activeSheetId, range, { wrap: nuevo }, 'Ajuste de texto',
    ));
  },

  // ── Copiar / pegar formato (brocha) ──────────────────────────────────────
  copiarFormato() {
    const { workbook, active } = get();
    const cell = getCell(getActiveSheet(workbook), active.row, active.col);
    // Se guarda una copia del formato y el estilo de la celda activa.
    set({ formatoCopiado: { format: cell?.format || null, style: cell?.style ? { ...cell.style } : null } });
  },
  pegarFormato() {
    const { workbook, range, formatoCopiado } = get();
    if (!formatoCopiado) return;
    // Aplica formato y estilo al rango SIN tocar los valores. Se arma como un
    // comando setCells (foto de antes + despues) para deshacerlo de una.
    const sheet = getActiveSheet(workbook);
    const entradas = [];
    forEachCell(range, (row, col) => {
      const actual = getCell(sheet, row, col);
      const base = actual || makeCell({});
      entradas.push({ row, col, cell: makeCell({
        value: base.value, formula: base.formula,
        format: formatoCopiado.format || FORMATS.GENERAL,
        style: formatoCopiado.style ? { ...formatoCopiado.style } : null,
      }) });
    });
    get().ejecutar(setCellsCommand.create(workbook, workbook.activeSheetId, entradas, 'Pegar formato'));
  },

  // ── Nombre del libro / gridlines ─────────────────────────────────────────
  renombrarLibro(nombre) {
    const limpio = String(nombre || '').trim().slice(0, 120) || 'Libro sin titulo';
    set((s) => ({ workbook: { ...s.workbook, name: limpio }, dirty: true }));
  },

  alternarGridlines() {
    set((s) => {
      const wb = s.workbook;
      const sheets = wb.sheets.map(sh =>
        sh.id === wb.activeSheetId ? { ...sh, hideGridlines: !sh.hideGridlines } : sh);
      return { workbook: { ...wb, sheets }, dirty: true };
    });
  },

  // ── Combinar ─────────────────────────────────────────────────────────────
  combinar() {
    const { workbook, range } = get();
    get().ejecutar(mergeCommand.create(workbook, workbook.activeSheetId, range));
  },
  separar() {
    const { workbook, range } = get();
    get().ejecutar(unmergeCommand.create(workbook, workbook.activeSheetId, range));
  },

  // ── Ordenar ──────────────────────────────────────────────────────────────
  ordenar(ascendente) {
    const { workbook, range } = get();
    get().ejecutar(sortRangeCommand.create(workbook, workbook.activeSheetId, range, ascendente));
  },

  // ── Filtros (AutoFilter) ───────────────────────────────────────────────────
  /**
   * Activa o quita el AutoFilter sobre la seleccion. La 1a fila del rango es la
   * de encabezados. Si ya hay filtro, lo quita (alterna, como Excel).
   * El estado del filtro es VISTA, no dato: no va al historial (Ctrl+Z), se
   * marca dirty para el guardado.
   */
  alternarFiltro() {
    const { workbook, range } = get();
    set((s) => {
      const wb = s.workbook;
      const sheets = wb.sheets.map(sh => {
        if (sh.id !== wb.activeSheetId) return sh;
        if (sh.filter) return { ...sh, filter: null };
        // Con una sola celda seleccionada se detecta TODA la tabla contigua
        // (como Excel), asi cada columna recibe su embudo. Con un rango elegido
        // a mano, se respeta ese rango.
        let { r1, c1, r2, c2 } = range;
        if (r1 === r2 && c1 === c2) {
          ({ r1, c1, r2, c2 } = regionActual(sh, r1, c1));
        }
        return { ...sh, filter: { r1, c1, r2, c2, criterios: {} } };
      });
      return { workbook: { ...wb, sheets }, dirty: true };
    });
  },

  /** Fija (o quita, con criterio null) el criterio de una columna. */
  fijarCriterioFiltro(col, criterio) {
    set((s) => {
      const wb = s.workbook;
      const sheets = wb.sheets.map(sh => {
        if (sh.id !== wb.activeSheetId || !sh.filter) return sh;
        const criterios = { ...sh.filter.criterios };
        if (criterio) criterios[col] = criterio; else delete criterios[col];
        return { ...sh, filter: { ...sh.filter, criterios } };
      });
      return { workbook: { ...wb, sheets }, dirty: true };
    });
  },

  /** Ordena el rango de datos del filtro por una columna (desde el menu de la columna). */
  ordenarPorColumna(col, ascendente) {
    const { workbook } = get();
    const sheet = getActiveSheet(workbook);
    if (!sheet.filter) return;
    const { r1, r2, c1, c2 } = sheet.filter;
    // Solo los datos (sin el encabezado r1), ordenados por la columna `col`.
    get().ejecutar(sortRangeCommand.create(
      workbook, workbook.activeSheetId, { r1: r1 + 1, c1, r2, c2 }, ascendente, col));
  },

  // ── Filas, columnas ────────────────────────────────────────────────────────

  ajustarAnchoColumna(col, width) {
    const { workbook, range } = get();
    // Si la columna ajustada esta dentro de una seleccion de VARIAS columnas,
    // el nuevo ancho se aplica a todas ellas (como Excel).
    if (range.c1 !== range.c2 && col >= range.c1 && col <= range.c2) {
      const cols = [];
      for (let c = range.c1; c <= range.c2; c++) cols.push(c);
      get().ejecutar(resizeColsCommand.create(workbook, workbook.activeSheetId, cols, width));
    } else {
      get().ejecutar(resizeColCommand.create(workbook, workbook.activeSheetId, col, width));
    }
  },

  ajustarAltoFila(row, height) {
    const { workbook, range } = get();
    if (range.r1 !== range.r2 && row >= range.r1 && row <= range.r2) {
      const rows = [];
      for (let r = range.r1; r <= range.r2; r++) rows.push(r);
      get().ejecutar(resizeRowsCommand.create(workbook, workbook.activeSheetId, rows, height));
    } else {
      get().ejecutar(resizeRowCommand.create(workbook, workbook.activeSheetId, row, height));
    }
  },

  ocultarColumna(col, hidden) {
    const { workbook } = get();
    get().ejecutar(hideColCommand.create(workbook, workbook.activeSheetId, col, hidden));
  },

  mostrarColumnas() {
    const { workbook } = get();
    get().ejecutar(showAllColsCommand.create(workbook, workbook.activeSheetId));
  },

  insertarFilas(at, cantidad = 1) {
    const { workbook } = get();
    const sheet = getActiveSheet(workbook);
    if (sheet.rows + cantidad > MAX_ROWS) return;
    get().ejecutar(insertRowsCommand.create(workbook, workbook.activeSheetId, at, cantidad));
  },

  eliminarFilas(at, cantidad = 1) {
    const { workbook } = get();
    const sheet = getActiveSheet(workbook);
    if (sheet.rows - cantidad < 1) return;
    get().ejecutar(deleteRowsCommand.create(workbook, workbook.activeSheetId, at, cantidad));
  },

  insertarColumnas(at, cantidad = 1) {
    const { workbook } = get();
    const sheet = getActiveSheet(workbook);
    if (sheet.cols + cantidad > MAX_COLS) return;
    get().ejecutar(insertColsCommand.create(workbook, workbook.activeSheetId, at, cantidad));
  },

  eliminarColumnas(at, cantidad = 1) {
    const { workbook } = get();
    const sheet = getActiveSheet(workbook);
    if (sheet.cols - cantidad < 1) return;
    get().ejecutar(deleteColsCommand.create(workbook, workbook.activeSheetId, at, cantidad));
  },

  congelar(frozenRows, frozenCols) {
    const { workbook } = get();
    get().ejecutar(freezeCommand.create(workbook, workbook.activeSheetId, frozenRows, frozenCols));
  },

  /**
   * Alterna el congelamiento en la celda activa, como "Inmovilizar paneles" de
   * Excel: congela las filas ARRIBA y las columnas a la IZQUIERDA del cursor.
   * Si ya hay algo congelado, lo libera.
   */
  alternarCongelar() {
    const { workbook, active } = get();
    const sheet = getActiveSheet(workbook);
    const congelado = sheet.frozenRows > 0 || sheet.frozenCols > 0;
    if (congelado) {
      get().ejecutar(freezeCommand.create(workbook, workbook.activeSheetId, 0, 0));
    } else {
      // Si el cursor esta en A1 no hay nada arriba/izquierda: se congela la 1a
      // fila y 1a columna como atajo util por defecto.
      const fr = active.row > 0 ? active.row : 1;
      const fc = active.col > 0 ? active.col : 1;
      get().ejecutar(freezeCommand.create(workbook, workbook.activeSheetId, fr, fc));
    }
  },

  // ── Hojas ──────────────────────────────────────────────────────────────────

  activarHoja: (sheetId) => set((s) => ({
    workbook: { ...s.workbook, activeSheetId: sheetId },
    active: seleccionInicial,
    anchor: seleccionInicial,
    range: { r1: 0, c1: 0, r2: 0, c2: 0 },
    editing: null,
  })),

  agregarHoja(nombre) { get().ejecutar(addSheetCommand.create(get().workbook, nombre)); },

  renombrarHoja(sheetId, nombre) {
    const limpio = String(nombre || '').trim().slice(0, 60);
    if (!limpio) return;
    get().ejecutar(renameSheetCommand.create(get().workbook, sheetId, limpio));
  },

  duplicarHoja(sheetId) { get().ejecutar(duplicateSheetCommand.create(get().workbook, sheetId)); },

  eliminarHoja(sheetId) {
    const cmd = deleteSheetCommand.create(get().workbook, sheetId);
    if (!cmd) return false;        // era la ultima hoja
    get().ejecutar(cmd);
    return true;
  },

  // ── Portapapeles ───────────────────────────────────────────────────────────

  /** Devuelve el TSV del rango; quien llama lo pone en el portapapeles real. */
  copiarTexto() {
    const { workbook, range } = get();
    return rangeToTSV(getActiveSheet(workbook), range);
  },

  cortar() {
    const { workbook, range } = get();
    const sheet = getActiveSheet(workbook);
    const texto = rangeToTSV(sheet, range);
    const entradas = snapshotForCut(sheet, range);
    if (entradas.length) {
      get().ejecutar(setCellsCommand.create(workbook, workbook.activeSheetId, entradas, 'Cortar'));
    }
    return texto;
  },

  pegarTexto(texto) {
    const matriz = parseTSV(texto);
    if (!matriz.length) return;
    const { workbook, range } = get();
    const sheet = getActiveSheet(workbook);
    const limites = { rows: sheet.rows, cols: sheet.cols };
    const entradas = buildPasteEntries(matriz, range, limites);
    if (!entradas.length) return;
    get().ejecutar(setCellsCommand.create(workbook, workbook.activeSheetId, entradas, 'Pegar'));
    get().seleccionarRango(pastedRange(matriz, range, limites));
  },

  // ── Importar / Exportar ────────────────────────────────────────────────────

  /**
   * Abre un XLSX/CSV del equipo. REEMPLAZA el libro actual: importar no es
   * mezclar. El historial se limpia porque los comandos anteriores hablaban de
   * un libro que ya no existe; deshacer sobre ellos corromperia el nuevo.
   */
  async importar(file) {
    const { sheets, errors } = await importarArchivo(file);
    if (!sheets.length) return { ok: false, errors };
    set({
      workbook: {
        id: `wb_${sheets[0].id}`,
        name: file.name.replace(/\.(xlsx|xls|csv)$/i, ''),
        sheets,
        activeSheetId: sheets[0].id,
      },
      past: [], future: [],
      active: seleccionInicial, anchor: seleccionInicial,
      range: { r1: 0, c1: 0, r2: 0, c2: 0 },
      editing: null,
      dirty: true,
    });
    return { ok: true, errors };
  },

  exportarXLSX() { exportarXLSX(get().workbook); },
  exportarCSV() { exportarCSV(getActiveSheet(get().workbook)); },

  /**
   * Abre un Google Sheet (por su URL) dentro de MOS. FASE 1: solo lectura de
   * contenido; se carga como un libro nuevo y se recuerda su origen (googleUrl)
   * para el banner y el boton "Abrir en Google".
   */
  // Diagnostico persistente de la conexion con Google (visible en el banner):
  // { estilos, formatoError, guardado: {hora, celdas, titulo, skipped}, guardadoError }
  gsInfo: null,

  async abrirGoogleSheet(url) {
    try {
      const { _info, ...wb } = await importarGoogleSheet(url);
      set({
        workbook: wb,
        past: [], future: [],
        active: seleccionInicial, anchor: seleccionInicial,
        range: { r1: 0, c1: 0, r2: 0, c2: 0 },
        editing: null,
        dirty: false,
        ultimoGuardado: null,
        gsInfo: { estilos: _info?.estilos ?? 0, formatoError: _info?.formatoError || null },
      });
      return { ok: true, info: _info };
    } catch (e) {
      return { ok: false, error: e?.message || 'No se pudo abrir el Google Sheet', necesitaConectar: !!e?.necesitaConectar };
    }
  },

  /** Escribe los cambios de vuelta al Google Sheet de origen. */
  guardandoGoogle: false,
  async guardarEnGoogle() {
    const { workbook } = get();
    set({ guardandoGoogle: true });
    let res;
    try {
      res = await guardarEnGoogle(workbook);
    } catch (e) {
      // Nunca dejar el spinner colgado ni fallar sin aviso.
      res = { ok: false, error: e?.message || 'Fallo inesperado al guardar en Google.' };
    }
    const previa = get().gsInfo || {};
    if (res.ok) {
      set({
        dirty: false,
        gsInfo: {
          ...previa,
          guardadoError: null,
          guardado: {
            hora: new Date().toLocaleTimeString(),
            celdas: res.updatedCells,
            titulo: res.spreadsheetTitle,
            skipped: res.skipped || [],
          },
        },
      });
    } else {
      set({ gsInfo: { ...previa, guardadoError: res.error || 'Error desconocido' } });
    }
    set({ guardandoGoogle: false });
    return res;
  },

  // ── Guardar / cargar (persistencia local en el navegador) ──────────────────
  guardando: false,
  ultimoGuardado: null,   // ISO string del ultimo guardado exitoso

  async guardar() {
    const { workbook } = get();
    set({ guardando: true });
    try {
      // El timestamp se pasa desde afuera porque new Date() no esta disponible
      // en algunos entornos del runtime; aqui en el navegador si.
      const cuando = new Date().toISOString();
      await guardarLibro(workbook, cuando);
      set({ guardando: false, dirty: false, ultimoGuardado: cuando });
      return { ok: true };
    } catch (e) {
      set({ guardando: false });
      return { ok: false, error: e?.message || 'No se pudo guardar' };
    }
  },

  async abrirGuardado(id) {
    const wb = await cargarLibro(id);
    if (!wb) return { ok: false, error: 'No se encontro el libro' };
    set({
      workbook: wb,
      past: [], future: [],
      active: seleccionInicial, anchor: seleccionInicial,
      range: { r1: 0, c1: 0, r2: 0, c2: 0 },
      editing: null,
      dirty: false,
      ultimoGuardado: null,
    });
    return { ok: true };
  },

  /** Empieza un libro nuevo, en blanco. */
  nuevoLibro() {
    const wb = makeWorkbook();
    set({
      workbook: wb,
      past: [], future: [],
      active: seleccionInicial, anchor: seleccionInicial,
      range: { r1: 0, c1: 0, r2: 0, c2: 0 },
      editing: null,
      dirty: false,
      ultimoGuardado: null,
    });
  },

  // ── Derivados ──────────────────────────────────────────────────────────────

  hojaActiva: () => getActiveSheet(get().workbook),
  celdaActiva: () => {
    const { workbook, active } = get();
    return getCell(getActiveSheet(workbook), active.row, active.col);
  },
  etiquetaRango: () => rangeToA1(get().range),
  puedeDeshacer: () => get().past.length > 0,
  puedeRehacer: () => get().future.length > 0,
  /** Ultimas operaciones, para el panel de historial (punto 9: "revisar cambios"). */
  historialReciente: (n = 20) => get().past.slice(-n).reverse().map((c, i) => ({
    id: `${get().past.length - i}`,
    etiqueta: c.etiqueta || c.tipo,
  })),
}));

export { FORMATS, getSheet };
