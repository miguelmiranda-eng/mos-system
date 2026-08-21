import React from 'react';
import { createPortal } from 'react-dom';
import {
  ArrowLeftToLine, ArrowRightToLine, ArrowUpToLine, ArrowDownToLine,
  Trash2, EyeOff, Eye,
} from 'lucide-react';
import { useWorkbook } from '../store/useWorkbook';
import { getActiveSheet } from '../engine/model';

/**
 * Menu contextual (clic derecho) de los encabezados de fila/columna.
 * Insertar a los cuatro lados, eliminar, y ocultar/mostrar columnas.
 * `pos` = posicion del cursor; `tipo` = 'col' | 'row'.
 */
export function HeaderContextMenu({ tipo, pos, onClose }) {
  const range = useWorkbook(s => s.range);
  const workbook = useWorkbook(s => s.workbook);
  const insertarColumnas = useWorkbook(s => s.insertarColumnas);
  const eliminarColumnas = useWorkbook(s => s.eliminarColumnas);
  const ocultarColumna = useWorkbook(s => s.ocultarColumna);
  const mostrarColumnas = useWorkbook(s => s.mostrarColumnas);
  const insertarFilas = useWorkbook(s => s.insertarFilas);
  const eliminarFilas = useWorkbook(s => s.eliminarFilas);

  const hoja = getActiveSheet(workbook);
  const hayOcultas = hoja.hiddenCols.size > 0;

  const nCols = range.c2 - range.c1 + 1;
  const nRows = range.r2 - range.r1 + 1;

  const hacer = (fn) => { fn(); onClose(); };

  const Item = ({ onClick, icon: Icon, children, peligro }) => (
    <button
      onClick={onClick}
      className={`w-full flex items-center gap-2.5 px-3 py-1.5 text-[13px] text-left hover:bg-black/5 dark:hover:bg-white/5 ${peligro ? 'text-red-600 dark:text-red-400' : 'text-foreground'}`}
    >
      <Icon size={14} className={peligro ? '' : 'text-muted-foreground'} />
      {children}
    </button>
  );
  const Sep = () => <div className="h-px bg-border my-1" />;

  return createPortal(
    <>
      <div className="fixed inset-0 z-[210]" onClick={onClose} onContextMenu={(e) => { e.preventDefault(); onClose(); }} />
      <div
        className="fixed z-[211] w-60 rounded-md border border-border bg-card shadow-xl py-1"
        style={{ left: pos.x, top: pos.y }}
      >
        {tipo === 'col' ? (
          <>
            <Item onClick={() => hacer(() => insertarColumnas(range.c1, nCols))} icon={ArrowLeftToLine}>
              Insertar {nCols > 1 ? `${nCols} columnas` : 'columna'} a la izquierda
            </Item>
            <Item onClick={() => hacer(() => insertarColumnas(range.c2 + 1, nCols))} icon={ArrowRightToLine}>
              Insertar {nCols > 1 ? `${nCols} columnas` : 'columna'} a la derecha
            </Item>
            <Sep />
            <Item onClick={() => hacer(() => eliminarColumnas(range.c1, nCols))} icon={Trash2} peligro>
              Eliminar {nCols > 1 ? `${nCols} columnas` : 'columna'}
            </Item>
            <Sep />
            <Item onClick={() => hacer(() => { for (let c = range.c2; c >= range.c1; c--) ocultarColumna(c, true); })} icon={EyeOff}>
              Ocultar {nCols > 1 ? 'columnas' : 'columna'}
            </Item>
            {hayOcultas && (
              <Item onClick={() => hacer(mostrarColumnas)} icon={Eye}>Mostrar todas las columnas</Item>
            )}
          </>
        ) : (
          <>
            <Item onClick={() => hacer(() => insertarFilas(range.r1, nRows))} icon={ArrowUpToLine}>
              Insertar {nRows > 1 ? `${nRows} filas` : 'fila'} arriba
            </Item>
            <Item onClick={() => hacer(() => insertarFilas(range.r2 + 1, nRows))} icon={ArrowDownToLine}>
              Insertar {nRows > 1 ? `${nRows} filas` : 'fila'} abajo
            </Item>
            <Sep />
            <Item onClick={() => hacer(() => eliminarFilas(range.r1, nRows))} icon={Trash2} peligro>
              Eliminar {nRows > 1 ? `${nRows} filas` : 'fila'}
            </Item>
          </>
        )}
      </div>
    </>,
    document.body,
  );
}
