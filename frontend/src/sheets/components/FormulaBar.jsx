import React, { useRef, useState } from 'react';
import { useWorkbook } from '../store/useWorkbook';
import { getCell, getEditValue } from '../engine/model';
import { rangeToA1 } from '../engine/address';
import { useFormulaAssist } from './useFormulaAssist';

/**
 * Barra de formulas: caja de nombre a la izquierda, contenido de la celda a la
 * derecha. Edita la celda ACTIVA, no el rango.
 *
 * El input se sincroniza con la celda activa mediante una clave de React
 * (`key`), en vez de un efecto que copie el valor: asi, al moverse de celda, el
 * input se recrea con el valor correcto y no hay ventana en la que muestre lo
 * de la celda anterior.
 */
export function FormulaBar() {
  const workbook = useWorkbook(s => s.workbook);
  const active = useWorkbook(s => s.active);
  const range = useWorkbook(s => s.range);
  const escribirCelda = useWorkbook(s => s.escribirCelda);

  const hoja = workbook.sheets.find(s => s.id === workbook.activeSheetId) || workbook.sheets[0];
  const cell = getCell(hoja, active.row, active.col);
  const valor = getEditValue(cell);

  return (
    <div className="h-8 flex items-stretch border-b border-border bg-card flex-shrink-0">
      <div className="w-28 flex items-center justify-center border-r border-border text-[12px] font-medium tabular-nums text-muted-foreground">
        {rangeToA1(range)}
      </div>
      <div className="w-8 flex items-center justify-center border-r border-border text-[13px] text-muted-foreground/60 select-none">
        fx
      </div>
      <Input
        key={`${hoja.id}:${active.row}:${active.col}:${valor}`}
        inicial={valor}
        onCommit={(texto) => escribirCelda(active.row, active.col, texto)}
      />
    </div>
  );
}

function Input({ inicial, onCommit }) {
  const ref = useRef(null);
  const [sucio, setSucio] = useState(false);
  const asist = useFormulaAssist(ref);

  // Enter confirma; Escape descarta y devuelve el foco a la hoja.
  return (
    <>
      <input
        ref={ref}
        defaultValue={inicial}
        onChange={() => { setSucio(true); asist.onInput(); }}
        onKeyUp={asist.onInput}
        onClick={asist.onInput}
        onKeyDown={(e) => {
          e.stopPropagation();
          // El asistente se queda con flechas/Enter/Tab/Escape si su lista está abierta.
          if (asist.onKeyDown(e)) return;
          if (e.key === 'Enter') {
            e.preventDefault();
            onCommit(ref.current.value);
            setSucio(false);
            asist.cerrar();
            ref.current.blur();
          } else if (e.key === 'Escape') {
            e.preventDefault();
            ref.current.value = inicial;
            setSucio(false);
            asist.cerrar();
            ref.current.blur();
          }
        }}
        onBlur={() => { if (sucio) { onCommit(ref.current.value); setSucio(false); } asist.cerrar(); }}
        className="flex-1 px-3 bg-background outline-none text-[13px] font-mono"
        placeholder="Escribe un valor o una formula (=SUM(...))"
      />
      {asist.overlay}
    </>
  );
}
