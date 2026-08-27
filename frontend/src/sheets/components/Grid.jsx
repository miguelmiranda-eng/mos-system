import React, { useRef, useCallback, useMemo, useEffect, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useWorkbook } from '../store/useWorkbook';
import {
  getCell, getDisplayValue, getEditValue, getColWidth, getRowHeight, isNumeric,
  findMerge, isMergedCovered, DEFAULT_FONT, DEFAULT_FONT_SIZE, DEFAULT_ROW_HEIGHT,
} from '../engine/model';
import { computeSheet, textoCalculado } from '../engine/compute';
import { filasOcultasPorFiltro, columnaFiltrada } from '../engine/filter';
import { colToLetters, rangeContains, cellKey } from '../engine/address';
import { cn } from '../../lib/utils';
import { FilterButton } from './FilterMenu';
import { useFormulaAssist } from './useFormulaAssist';
import { HeaderContextMenu } from './HeaderContextMenu';

const ROW_HEADER_W = 48;
const COL_HEADER_H = 26;

/**
 * Rejilla virtualizada. Solo existen en el DOM las celdas visibles mas un
 * margen. Los encabezados se fijan con el patron envoltura-absoluta + hijo
 * sticky (una celda virtualizada ya es absoluta y no puede ser sticky a la vez).
 */
export function Grid() {
  const contenedorRef = useRef(null);
  const workbook = useWorkbook(s => s.workbook);
  const range = useWorkbook(s => s.range);
  const active = useWorkbook(s => s.active);
  const editing = useWorkbook(s => s.editing);
  const refHighlight = useWorkbook(s => s.refHighlight);

  const seleccionar = useWorkbook(s => s.seleccionar);
  const seleccionarColumna = useWorkbook(s => s.seleccionarColumna);
  const seleccionarFila = useWorkbook(s => s.seleccionarFila);
  const seleccionarTodo = useWorkbook(s => s.seleccionarTodo);
  const empezarEdicion = useWorkbook(s => s.empezarEdicion);
  const escribirCelda = useWorkbook(s => s.escribirCelda);
  const ajustarAnchoColumna = useWorkbook(s => s.ajustarAnchoColumna);
  const ajustarAltoFila = useWorkbook(s => s.ajustarAltoFila);
  const ocultarColumna = useWorkbook(s => s.ocultarColumna);
  const mostrarColumnas = useWorkbook(s => s.mostrarColumnas);

  const sheet = useMemo(
    () => workbook.sheets.find(s => s.id === workbook.activeSheetId) || workbook.sheets[0],
    [workbook],
  );

  const colsVisibles = useMemo(() => {
    const out = [];
    for (let c = 0; c < sheet.cols; c++) if (!sheet.hiddenCols.has(c)) out.push(c);
    return out;
  }, [sheet.cols, sheet.hiddenCols]);

  // Valores calculados de las formulas. Se recalcula solo cuando cambia la hoja
  // (es inmutable), no al desplazarse: por eso va en useMemo por `sheet`.
  const computed = useMemo(() => computeSheet(sheet), [sheet]);

  // Filas ocultas por el filtro, y la lista de filas VISIBLES (indices reales).
  // La virtualizacion de filas corre sobre esta lista, no sobre 0..rows, para
  // que las filas filtradas simplemente no aparezcan. `filaReal(i)` traduce el
  // indice de pantalla al indice real de fila.
  const ocultasFiltro = useMemo(() => filasOcultasPorFiltro(sheet, computed), [sheet, computed]);
  const filasVisibles = useMemo(() => {
    if (ocultasFiltro.size === 0) return null; // null = todas, sin lista intermedia
    const out = [];
    for (let r = 0; r < sheet.rows; r++) if (!ocultasFiltro.has(r)) out.push(r);
    return out;
  }, [ocultasFiltro, sheet.rows]);
  const filaReal = useCallback((i) => (filasVisibles ? filasVisibles[i] : i), [filasVisibles]);
  const totalFilas = filasVisibles ? filasVisibles.length : sheet.rows;
  const filaAPantalla = useCallback((row) => (
    filasVisibles ? filasVisibles.indexOf(row) : row
  ), [filasVisibles]);

  // Texto a mostrar de una celda (formula resuelta o valor formateado) y si el
  // resultado es numerico (para alinear a la derecha).
  const displayDe = useCallback((cell, row, col) => {
    if (!cell) return { texto: '', num: false };
    const texto = textoCalculado(cell, computed, cellKey(row, col), getDisplayValue);
    let num;
    if (cell.formula != null) {
      const v = computed.get(cellKey(row, col));
      num = typeof v === 'number';
    } else {
      num = isNumeric(cell.value);
    }
    return { texto, num };
  }, [computed]);

  // Para colocar combinaciones necesito el pixel exacto de cualquier columna
  // visible, no solo las del viewport: prefijo de anchos sobre colsVisibles.
  const prefijoCol = useMemo(() => {
    const p = new Map();
    let x = 0;
    for (const c of colsVisibles) { p.set(c, x); x += getColWidth(sheet, c); }
    return p;
  }, [colsVisibles, sheet]);

  const filaVirtual = useVirtualizer({
    count: totalFilas,
    getScrollElement: () => contenedorRef.current,
    estimateSize: useCallback((i) => getRowHeight(sheet, filaReal(i)), [sheet, filaReal]),
    overscan: 8,
  });

  const colVirtual = useVirtualizer({
    horizontal: true,
    count: colsVisibles.length,
    getScrollElement: () => contenedorRef.current,
    estimateSize: useCallback((i) => getColWidth(sheet, colsVisibles[i]), [sheet, colsVisibles]),
    overscan: 3,
  });

  useEffect(() => { colVirtual.measure(); }, [sheet.colWidths, sheet.hiddenCols, colVirtual]);
  useEffect(() => { filaVirtual.measure(); }, [sheet.rowHeights, totalFilas, filaVirtual]);

  // Modo de arrastre: 'cell' | 'col' | 'row' | null. Distingue si se esta
  // arrastrando sobre celdas, sobre encabezados de columna o de fila, para
  // extender la seleccion correcta en cada caso.
  const modo = useRef(null);
  useEffect(() => {
    const soltar = () => { modo.current = null; };
    window.addEventListener('mouseup', soltar);
    return () => window.removeEventListener('mouseup', soltar);
  }, []);

  // Menu contextual de encabezados (clic derecho). null = cerrado.
  const [menuCtx, setMenuCtx] = useState(null);
  const abrirMenuCol = useCallback((e, col) => {
    e.preventDefault();
    // Si la columna no esta en la seleccion, se selecciona sola primero.
    if (col < range.c1 || col > range.c2) seleccionarColumna(col, false);
    setMenuCtx({ tipo: 'col', x: e.clientX, y: e.clientY });
  }, [range, seleccionarColumna]);
  const abrirMenuFila = useCallback((e, row) => {
    e.preventDefault();
    if (row < range.r1 || row > range.r2) seleccionarFila(row, false);
    setMenuCtx({ tipo: 'row', x: e.clientX, y: e.clientY });
  }, [range, seleccionarFila]);

  useEffect(() => {
    // Durante un arrastre el auto-scroll ya lleva el control; no pelear con el.
    if (modo.current) return;
    const iCol = colsVisibles.indexOf(active.col);
    const iFila = filaAPantalla(active.row);
    if (iFila >= 0) filaVirtual.scrollToIndex(iFila, { align: 'auto' });
    if (iCol >= 0) colVirtual.scrollToIndex(iCol, { align: 'auto' });
  }, [active.row, active.col, colsVisibles, filaAPantalla, filaVirtual, colVirtual]);

  const filas = filaVirtual.getVirtualItems();
  const cols = colVirtual.getVirtualItems();
  const totalH = filaVirtual.getTotalSize();
  const totalW = colVirtual.getTotalSize();

  // ── Auto-scroll al arrastrar la seleccion mas alla del borde visible ───────
  // La seleccion se extiende con el onMouseEnter de las celdas, pero fuera del
  // viewport no hay celdas (virtualizacion): sin esto el arrastre se "atora" en
  // el borde. Aqui, mientras se arrastra y el puntero sale del contenedor, se
  // desplaza y se extiende la seleccion hacia la celda bajo el puntero.
  const puntero = useRef({ x: 0, y: 0 });
  const intervaloRef = useRef(0);

  const celdaEnPunto = useCallback((cx, cy) => {
    const sc = contenedorRef.current;
    if (!sc) return null;
    const rect = sc.getBoundingClientRect();
    const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
    const x = clamp(cx, rect.left + ROW_HEADER_W + 1, rect.right - 1);
    const y = clamp(cy, rect.top + COL_HEADER_H + 1, rect.bottom - 1);
    const contentX = x - rect.left + sc.scrollLeft - ROW_HEADER_W;
    const contentY = y - rect.top + sc.scrollTop - COL_HEADER_H;
    let col = colsVisibles.length ? colsVisibles[colsVisibles.length - 1] : 0;
    for (const c of colsVisibles) {
      const s = prefijoCol.get(c) ?? 0;
      if (contentX >= s && contentX < s + getColWidth(sheet, c)) { col = c; break; }
    }
    // Fila aproximada por el alto por defecto (los altos ajustados son raros y
    // un desfase de una fila durante el arrastre rapido no se nota). El indice
    // es de PANTALLA; se traduce a fila real por si hay filas filtradas.
    const idx = clamp(Math.floor(contentY / DEFAULT_ROW_HEIGHT), 0, totalFilas - 1);
    return { row: filaReal(idx), col };
  }, [colsVisibles, prefijoCol, sheet, totalFilas, filaReal]);

  useEffect(() => {
    const detener = () => { if (intervaloRef.current) { clearInterval(intervaloRef.current); intervaloRef.current = 0; } };
    // Usa setInterval (no requestAnimationFrame) para que el desplazamiento siga
    // aunque la pestana no este componiendo frames; rAF se pausa en ese caso.
    const tick = () => {
      if (modo.current !== 'cell') { detener(); return; }
      const sc = contenedorRef.current;
      if (!sc) { detener(); return; }
      const rect = sc.getBoundingClientRect();
      const { x, y } = puntero.current;
      const V = 26; // velocidad maxima px por tick
      let dx = 0; let dy = 0;
      if (y > rect.bottom) dy = Math.min(V, (y - rect.bottom) / 3 + 6);
      else if (y < rect.top + COL_HEADER_H) dy = -Math.min(V, (rect.top + COL_HEADER_H - y) / 3 + 6);
      if (x > rect.right) dx = Math.min(V, (x - rect.right) / 3 + 6);
      else if (x < rect.left + ROW_HEADER_W) dx = -Math.min(V, (rect.left + ROW_HEADER_W - x) / 3 + 6);
      if (!dx && !dy) { detener(); return; } // el puntero volvio adentro
      sc.scrollTop += dy;
      sc.scrollLeft += dx;
      const cel = celdaEnPunto(x, y);
      if (cel) seleccionar(cel.row, cel.col, true);
    };
    const onMove = (e) => {
      if (!modo.current) { detener(); return; }
      puntero.current = { x: e.clientX, y: e.clientY };
      if (!intervaloRef.current) intervaloRef.current = setInterval(tick, 16);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', detener);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', detener);
      detener();
    };
  }, [celdaEnPunto, seleccionar]);

  // Desplazamiento base de una fila real (para posicionar combinaciones).
  // `row` es indice real; se busca el item virtual cuya fila real coincide.
  const topDeFila = useCallback((row) => {
    const item = filas.find(f => filaReal(f.index) === row);
    return item ? item.start : null;
  }, [filas, filaReal]);

  // Combinaciones que caen dentro del viewport actual.
  const mergesVisibles = useMemo(() => {
    if (!filas.length) return [];
    const rMin = filaReal(filas[0].index);
    const rMax = filaReal(filas[filas.length - 1].index);
    return sheet.merges.filter(m => m.r1 <= rMax && m.r2 >= rMin && prefijoCol.has(m.c1));
  }, [sheet.merges, filas, prefijoCol, filaReal]);

  // ── Congelar paneles ───────────────────────────────────────────────────────
  // frozenRows/frozenCols = cuantas filas/columnas quedan fijas arriba/izquierda.
  // Las celdas congeladas se dibujan como capas sticky sobre el cuerpo que
  // scrollea, con el mismo patron envoltura-absoluta + hijo-sticky de los
  // encabezados. Los conteos son chicos, asi que se recorren sin virtualizar.
  const fr = Math.min(sheet.frozenRows || 0, sheet.rows);
  const fcCount = Math.min(sheet.frozenCols || 0, colsVisibles.length);
  const frozenColVals = useMemo(() => colsVisibles.slice(0, fcCount), [colsVisibles, fcCount]);
  const frozenColSet = useMemo(() => new Set(frozenColVals), [frozenColVals]);

  // Offset superior de cada fila congelada (prefijo pequeno).
  const topFilaCongelada = useCallback((r) => {
    let y = 0; for (let i = 0; i < r; i++) y += getRowHeight(sheet, i); return y;
  }, [sheet]);

  const esCongelada = (rowIdx, colIdx) => rowIdx < fr || colIdx < fcCount;

  // Props comunes de una celda (congelada o no): datos + texto calculado + manejadores.
  const propsCelda = (row, col) => {
    const cell = getCell(sheet, row, col);
    const { texto, num } = displayDe(cell, row, col);
    return {
      row, col, cell, display: texto, alineaNum: num,
      sinLineas: sheet.hideGridlines,
      enRef: refHighlight ? rangeContains(refHighlight, row, col) : false,
      enRango: rangeContains(range, row, col),
      esActiva: active.row === row && active.col === col,
      editando: editing && editing.row === row && editing.col === col,
      onMouseDown: (e) => {
        // Modo apuntar: si hay una formula en edicion esperando una referencia,
        // el clic inserta la referencia en vez de mover la seleccion. preventDefault
        // evita que el input pierda el foco.
        const ins = useWorkbook.getState().refInsertor;
        if (ins && ins.enModoPunto()) {
          e.preventDefault();
          modo.current = 'ref';
          ins.puntoInicio(row, col);
          return;
        }
        modo.current = 'cell';
        seleccionar(row, col, e.shiftKey);
      },
      onMouseEnter: () => {
        if (modo.current === 'ref') { useWorkbook.getState().refInsertor?.puntoExtiende(row, col); return; }
        if (modo.current === 'cell') seleccionar(row, col, true);
      },
      onDoubleClick: () => empezarEdicion(row, col),
      onCommit: escribirCelda,
    };
  };

  return (
    <div className="flex-1 min-h-0 min-w-0 flex flex-col">
      {/* select-none: sin esto, arrastrar para seleccionar celdas selecciona el
          TEXTO de las celdas y tapa la seleccion real. */}
      <div ref={contenedorRef} className="flex-1 overflow-auto relative bg-background select-none">
        <div style={{ width: totalW + ROW_HEADER_W, height: totalH + COL_HEADER_H, position: 'relative' }}>
          {/* Esquina */}
          <div
            onClick={seleccionarTodo}
            className="border-b border-r border-border bg-muted cursor-pointer"
            style={{ position: 'sticky', top: 0, left: 0, zIndex: 30, width: ROW_HEADER_W, height: COL_HEADER_H }}
            title="Seleccionar todo"
          />

          {/* Encabezados de columna */}
          {cols.map((vc) => {
            const col = colsVisibles[vc.index];
            const activa = col >= range.c1 && col <= range.c2;
            // Si la columna siguiente esta oculta, marcarlo para poder mostrarla.
            const hayOcultaDespues = sheet.hiddenCols.has(col + 1);
            return (
              <div
                key={`ch-${col}`}
                style={{
                  position: 'absolute', top: 0, left: vc.start + ROW_HEADER_W,
                  width: vc.size, height: totalH + COL_HEADER_H,
                  pointerEvents: 'none', zIndex: 20,
                }}
              >
                <ColHeader
                  col={col} width={vc.size} activa={activa}
                  hayOcultaDespues={hayOcultaDespues}
                  onSelect={(c, shift) => { modo.current = 'col'; seleccionarColumna(c, shift); }}
                  onEnter={(c) => { if (modo.current === 'col') seleccionarColumna(c, true); }}
                  onResize={ajustarAnchoColumna}
                  onContext={abrirMenuCol}
                  onShowAll={mostrarColumnas}
                />
              </div>
            );
          })}

          {/* Encabezados de fila (con tirador de alto) */}
          {filas.map((vr) => {
            const row = filaReal(vr.index);
            const activa = row >= range.r1 && row <= range.r2;
            return (
              <div
                key={`rh-${row}`}
                style={{
                  position: 'absolute', left: 0, top: vr.start + COL_HEADER_H,
                  width: totalW + ROW_HEADER_W, height: vr.size,
                  pointerEvents: 'none', zIndex: 20,
                }}
              >
                <RowHeader row={row} height={vr.size} activa={activa}
                  onSelect={(r, shift) => { modo.current = 'row'; seleccionarFila(r, shift); }}
                  onEnter={(r) => { if (modo.current === 'row') seleccionarFila(r, true); }}
                  onResize={ajustarAltoFila}
                  onContext={abrirMenuFila} />
              </div>
            );
          })}

          {/* Celdas */}
          {filas.map((vr) => {
            const row = filaReal(vr.index);
            return cols.map((vc) => {
              const col = colsVisibles[vc.index];
              // Las celdas congeladas se pintan en sus propias capas, mas abajo.
              if (esCongelada(vr.index, vc.index)) return null;
              // No dibujar las celdas tapadas por una combinacion: las pinta el
              // anclaje, mas abajo.
              if (isMergedCovered(sheet, row, col)) return null;
              // Si es el anclaje de una combinacion, se dibuja mas abajo con su
              // tamano completo; aqui se omite para no pintarla dos veces.
              if (findMerge(sheet, row, col)) return null;
              return (
                <Cell
                  key={`${row}:${col}`}
                  {...propsCelda(row, col)}
                  top={vr.start + COL_HEADER_H} left={vc.start + ROW_HEADER_W}
                  width={vc.size} height={vr.size}
                />
              );
            });
          })}

          {/* Anclajes de combinaciones: se dibujan aparte, abarcando su rango */}
          {mergesVisibles.map((m) => {
            const top = topDeFila(m.r1);
            if (top == null) return null;
            const left = prefijoCol.get(m.c1);
            let width = 0;
            for (let c = m.c1; c <= m.c2; c++) if (!sheet.hiddenCols.has(c)) width += getColWidth(sheet, c);
            let height = 0;
            for (let r = m.r1; r <= m.r2; r++) height += getRowHeight(sheet, r);
            return (
              <Cell
                key={`merge-${m.r1}:${m.c1}`}
                {...propsCelda(m.r1, m.c1)}
                top={top + COL_HEADER_H} left={left + ROW_HEADER_W}
                width={width} height={height} merged
              />
            );
          })}

          {/* Botones de filtro sobre la fila de encabezados del AutoFilter */}
          {sheet.filter && (() => {
            const top = topDeFila(sheet.filter.r1);
            if (top == null) return null;
            return cols.map((vc) => {
              const col = colsVisibles[vc.index];
              if (col < sheet.filter.c1 || col > sheet.filter.c2) return null;
              const w = getColWidth(sheet, col);
              return (
                <FilterButton
                  key={`flt-${col}`}
                  col={col}
                  top={top + COL_HEADER_H}
                  left={vc.start + ROW_HEADER_W + w - 19}
                />
              );
            });
          })()}

          {/* ── Panel congelado: columnas (fijas a la izquierda) ── */}
          {fcCount > 0 && filas.map((vr) => {
            if (vr.index < fr) return null; // la interseccion la pinta la esquina
            const rowReal = filaReal(vr.index);
            return frozenColVals.map((c) => (
              <div
                key={`fzc-${vr.index}-${c}`}
                style={{
                  position: 'absolute', top: vr.start + COL_HEADER_H, left: 0,
                  width: totalW + ROW_HEADER_W, height: vr.size,
                  pointerEvents: 'none', zIndex: 15,
                }}
              >
                <Cell
                  {...propsCelda(rowReal, c)}
                  width={getColWidth(sheet, c)} height={vr.size}
                  posStyle={{ position: 'sticky', left: ROW_HEADER_W + prefijoCol.get(c), pointerEvents: 'auto' }}
                />
              </div>
            ));
          })}

          {/* ── Panel congelado: filas (fijas arriba) ── */}
          {fr > 0 && cols.map((vc) => {
            if (vc.index < fcCount) return null;
            const col = colsVisibles[vc.index];
            return Array.from({ length: fr }).map((_, r) => (
              <div
                key={`fzr-${r}-${col}`}
                style={{
                  position: 'absolute', left: vc.start + ROW_HEADER_W, top: 0,
                  width: vc.size, height: totalH + COL_HEADER_H,
                  pointerEvents: 'none', zIndex: 15,
                }}
              >
                <Cell
                  {...propsCelda(r, col)}
                  width={vc.size} height={getRowHeight(sheet, r)}
                  posStyle={{ position: 'sticky', top: COL_HEADER_H + topFilaCongelada(r), pointerEvents: 'auto' }}
                />
              </div>
            ));
          })}

          {/* ── Panel congelado: esquina (fija en ambos ejes) ── */}
          {fr > 0 && fcCount > 0 && Array.from({ length: fr }).map((_, r) => (
            frozenColVals.map((c) => (
              <div
                key={`fzk-${r}-${c}`}
                style={{
                  position: 'absolute', top: 0, left: 0,
                  width: totalW + ROW_HEADER_W, height: totalH + COL_HEADER_H,
                  pointerEvents: 'none', zIndex: 18,
                }}
              >
                <Cell
                  {...propsCelda(r, c)}
                  width={getColWidth(sheet, c)} height={getRowHeight(sheet, r)}
                  posStyle={{
                    position: 'sticky',
                    top: COL_HEADER_H + topFilaCongelada(r),
                    left: ROW_HEADER_W + prefijoCol.get(c),
                    pointerEvents: 'auto',
                  }}
                />
              </div>
            ))
          ))}

        </div>
      </div>

      {menuCtx && (
        <HeaderContextMenu
          tipo={menuCtx.tipo}
          pos={{ x: menuCtx.x, y: menuCtx.y }}
          onClose={() => setMenuCtx(null)}
        />
      )}
    </div>
  );
}

function ColHeader({ col, width, activa, hayOcultaDespues, onSelect, onEnter, onResize, onContext, onShowAll }) {
  const arrastre = useRef(null);

  const onMouseDownResize = (e) => {
    e.stopPropagation(); e.preventDefault();
    arrastre.current = { x0: e.clientX, w0: width };
    const el = document.getElementById(`sheet-col-${col}`);
    const mover = (ev) => {
      const w = arrastre.current.w0 + (ev.clientX - arrastre.current.x0);
      if (el) el.style.width = `${Math.max(32, w)}px`;
    };
    const soltar = (ev) => {
      window.removeEventListener('mousemove', mover);
      window.removeEventListener('mouseup', soltar);
      onResize(col, Math.max(32, arrastre.current.w0 + (ev.clientX - arrastre.current.x0)));
      arrastre.current = null;
    };
    window.addEventListener('mousemove', mover);
    window.addEventListener('mouseup', soltar);
  };

  return (
    <div
      id={`sheet-col-${col}`}
      onMouseDown={(e) => onSelect(col, e.shiftKey)}
      onMouseEnter={() => onEnter(col)}
      className={cn(
        'relative flex items-center justify-center border-b border-r border-border text-[11px] font-semibold select-none cursor-pointer',
        activa ? 'bg-royal/25 text-royal' : 'bg-muted text-muted-foreground',
      )}
      style={{ position: 'sticky', top: 0, width, height: COL_HEADER_H, pointerEvents: 'auto' }}
      title="Clic: seleccionar · clic derecho: más opciones"
      onContextMenu={(e) => onContext(e, col)}
    >
      {colToLetters(col)}
      {/* Marca de columna oculta a la derecha; al pulsarla se muestran todas. */}
      {hayOcultaDespues && (
        <button
          onClick={(e) => { e.stopPropagation(); onShowAll(); }}
          className="absolute right-0 top-0 h-full w-2 bg-royal/60 hover:bg-royal"
          title="Hay columnas ocultas — clic para mostrarlas"
        />
      )}
      <div
        onMouseDown={onMouseDownResize}
        className="absolute right-0 top-0 h-full w-1.5 cursor-col-resize hover:bg-royal/40"
        title="Ajustar ancho"
        style={{ right: hayOcultaDespues ? 8 : 0 }}
      />
    </div>
  );
}

function RowHeader({ row, height, activa, onSelect, onEnter, onResize, onContext }) {
  const arrastre = useRef(null);

  const onMouseDownResize = (e) => {
    e.stopPropagation(); e.preventDefault();
    arrastre.current = { y0: e.clientY, h0: height };
    const el = document.getElementById(`sheet-row-${row}`);
    const mover = (ev) => {
      const h = arrastre.current.h0 + (ev.clientY - arrastre.current.y0);
      if (el) el.style.height = `${Math.max(18, h)}px`;
    };
    const soltar = (ev) => {
      window.removeEventListener('mousemove', mover);
      window.removeEventListener('mouseup', soltar);
      onResize(row, Math.max(18, arrastre.current.h0 + (ev.clientY - arrastre.current.y0)));
      arrastre.current = null;
    };
    window.addEventListener('mousemove', mover);
    window.addEventListener('mouseup', soltar);
  };

  return (
    <div
      id={`sheet-row-${row}`}
      onMouseDown={(e) => onSelect(row, e.shiftKey)}
      onMouseEnter={() => onEnter(row)}
      onContextMenu={(e) => onContext(e, row)}
      title="Clic: seleccionar · clic derecho: más opciones"
      className={cn(
        'relative flex items-center justify-center border-b border-r border-border text-[11px] tabular-nums select-none cursor-pointer',
        activa ? 'bg-royal/25 text-royal font-semibold' : 'bg-muted text-muted-foreground',
      )}
      style={{ position: 'sticky', left: 0, width: ROW_HEADER_W, height, pointerEvents: 'auto' }}
    >
      {row + 1}
      <div
        onMouseDown={onMouseDownResize}
        className="absolute bottom-0 left-0 w-full h-1.5 cursor-row-resize hover:bg-royal/40"
        title="Ajustar alto"
      />
    </div>
  );
}

const Cell = React.memo(function Cell({
  row, col, top, left, width, height, cell,
  display, alineaNum, sinLineas, enRango, enRef, esActiva, editando, merged, posStyle,
  onMouseDown, onMouseEnter, onDoubleClick, onCommit,
}) {
  const st = cell?.style || {};
  const alineaDerecha = st.align ? st.align === 'right' : alineaNum;

  const estilo = {
    // posStyle: para celdas congeladas (position sticky). Por defecto, absoluta.
    ...(posStyle || { position: 'absolute', top, left }),
    width, height,
    justifyContent: st.align === 'center' ? 'center' : (alineaDerecha ? 'flex-end' : 'flex-start'),
    color: st.color || undefined,
    backgroundColor: st.fill || undefined,
    fontFamily: st.fontFamily || DEFAULT_FONT,
    fontSize: st.fontSize ? `${st.fontSize}px` : `${DEFAULT_FONT_SIZE}px`,
    textDecoration: st.underline ? 'underline' : undefined,
  };

  return (
    <div
      onMouseDown={onMouseDown}
      onMouseEnter={onMouseEnter}
      onDoubleClick={onDoubleClick}
      className={cn(
        'px-1.5 leading-none flex items-center overflow-hidden',
        // Las lineas de la cuadricula se pueden ocultar por hoja.
        !sinLineas && 'border-b border-r border-border',
        // Ajuste de texto: si esta activo, el texto salta de linea; si no, se
        // recorta en una linea (comportamiento por defecto tipo Excel).
        st.wrap ? 'whitespace-normal break-words' : 'whitespace-nowrap',
        merged && 'justify-center text-center',
        enRango && !esActiva && 'bg-royal/20',
        // Rango referenciado en modo apuntar: contorno azul + fondo tenue.
        enRef && 'ring-2 ring-inset ring-royal/70 bg-royal/10 z-[9]',
        esActiva && 'ring-2 ring-royal ring-inset z-10',
        !st.fill && !enRango && !enRef && 'bg-background',
        st.bold && 'font-semibold',
        st.italic && 'italic',
      )}
      style={estilo}
    >
      {editando
        ? <CellEditor row={row} col={col} cell={cell} onCommit={onCommit} />
        : display}
      {/* Indicador de desplegable (validacion traida de Google). */}
      {!editando && st.lista?.length > 0 && (
        <span className="absolute right-0.5 top-1/2 -translate-y-1/2 text-[8px] text-muted-foreground/50 pointer-events-none">▾</span>
      )}
    </div>
  );
});

function CellEditor({ row, col, cell, onCommit }) {
  const ref = useRef(null);
  const cancelar = useWorkbook(s => s.cancelarEdicion);
  const mover = useWorkbook(s => s.mover);
  const inicial = useRef(getEditValue(cell)).current;
  const asist = useFormulaAssist(ref);
  // Evita guardar dos veces (varios disparadores) o guardar tras Escape.
  const listo = useRef(false);

  const confirmar = (dRow, dCol) => {
    if (listo.current) return;
    listo.current = true;
    onCommit(row, col, ref.current.value);
    if (dRow || dCol) mover(dRow, dCol);
  };
  const confirmarRef = useRef(confirmar);
  confirmarRef.current = confirmar;

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);

    // Arreglo del bug de "clic borra lo escrito": al hacer clic en otra celda,
    // ese mousedown cambia la seleccion y DESMONTA el input antes de que dispare
    // su blur, asi que lo escrito se perdia. Aqui se confirma en la fase de
    // CAPTURA del mousedown —antes que el manejador de la celda— cuando el clic
    // cae fuera del editor. No se usa el cleanup del efecto a proposito: con
    // StrictMode ese cleanup corre en el montaje/desmontaje falso y cerraria el
    // editor al instante.
    const alMousedownFuera = (ev) => {
      // No confirmar la celda si:
      //  - el clic fue en la ventana del asistente (elegir una funcion), o
      //  - estamos en modo apuntar (el clic en una celda arma la referencia).
      const enPunto = useWorkbook.getState().refInsertor?.enModoPunto?.();
      if (ev.target !== el && !ev.target.closest?.('[data-formula-assist]') && !enPunto) {
        confirmarRef.current(0, 0);
      }
    };
    document.addEventListener('mousedown', alMousedownFuera, true);
    return () => document.removeEventListener('mousedown', alMousedownFuera, true);
  }, []);

  // Desplegable (validacion de datos traida de Google): las opciones se ofrecen
  // con un <datalist> nativo — sugiere al escribir o al desplegar, pero no
  // impide teclear otro valor (v1: sugerencia, no candado).
  const opciones = cell?.style?.lista;
  const listaId = opciones?.length ? `dl_${row}_${col}` : undefined;

  return (
    <>
      <input
        ref={ref}
        defaultValue={inicial}
        list={listaId}
        onChange={asist.onInput}
        onKeyUp={asist.onInput}
        onClick={asist.onInput}
        onBlur={() => { confirmar(0, 0); asist.cerrar(); }}
        onKeyDown={(e) => {
          e.stopPropagation();
          // El asistente se queda con las teclas de navegacion si su lista esta abierta.
          if (asist.onKeyDown(e)) return;
          if (e.key === 'Enter') { e.preventDefault(); asist.cerrar(); confirmar(1, 0); }
          else if (e.key === 'Tab') { e.preventDefault(); asist.cerrar(); confirmar(0, e.shiftKey ? -1 : 1); }
          else if (e.key === 'Escape') { e.preventDefault(); listo.current = true; asist.cerrar(); cancelar(); }
        }}
        className="w-full h-full bg-background outline-none text-[13px] px-0 select-text"
      />
      {listaId && (
        <datalist id={listaId}>
          {opciones.map((o, i) => <option key={i} value={o} />)}
        </datalist>
      )}
      {asist.overlay}
    </>
  );
}
