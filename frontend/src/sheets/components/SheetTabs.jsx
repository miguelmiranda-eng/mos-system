import React, { useState, useMemo } from 'react';
import { Plus, Copy, Trash2, Pencil } from 'lucide-react';
import { toast } from 'sonner';
import { useWorkbook } from '../store/useWorkbook';
import { getActiveSheet, getCell, getDisplayValue, isNumeric } from '../engine/model';
import { computeSheet, textoCalculado } from '../engine/compute';
import { forEachCell, cellKey } from '../engine/address';
import { cn } from '../../lib/utils';

const fmt = new Intl.NumberFormat('es-MX', { maximumFractionDigits: 4 });

/**
 * Resumen de la selección (como la barra de estado de Excel): cuenta, suma y
 * promedio de los números seleccionados. Solo aparece cuando hay algo que
 * resumir. Reutiliza el cálculo de fórmulas para respetar sus resultados.
 */
function ResumenSeleccion() {
  const range = useWorkbook(s => s.range);
  const workbook = useWorkbook(s => s.workbook);
  const sheet = getActiveSheet(workbook);
  const computed = useMemo(() => computeSheet(sheet), [sheet]);

  const agg = useMemo(() => {
    let suma = 0; let numeros = 0; let noVacias = 0;
    forEachCell(range, (r, c) => {
      const cell = getCell(sheet, r, c);
      if (!cell) return;
      const texto = textoCalculado(cell, computed, cellKey(r, c), getDisplayValue);
      if (texto !== '') noVacias++;
      let v = null;
      if (cell.formula != null) { const cv = computed.get(cellKey(r, c)); v = typeof cv === 'number' ? cv : null; }
      else if (isNumeric(cell.value)) v = Number(cell.value);
      if (v != null && Number.isFinite(v)) { suma += v; numeros++; }
    });
    return { suma, numeros, noVacias, promedio: numeros ? suma / numeros : 0 };
  }, [sheet, computed, range]);

  if (agg.noVacias === 0) return null;

  return (
    <div className="flex items-center gap-3 px-2 text-[11.5px] text-muted-foreground tabular-nums whitespace-nowrap">
      {agg.numeros > 0 && <span>Suma: <strong className="text-foreground">{fmt.format(agg.suma)}</strong></span>}
      {agg.numeros > 0 && <span>Prom.: <strong className="text-foreground">{fmt.format(agg.promedio)}</strong></span>}
      <span>Cuenta: <strong className="text-foreground">{agg.noVacias}</strong></span>
    </div>
  );
}

/** Pestañas de hoja: agregar, renombrar (doble clic), duplicar y eliminar. */
export function SheetTabs() {
  const workbook = useWorkbook(s => s.workbook);
  const activarHoja = useWorkbook(s => s.activarHoja);
  const agregarHoja = useWorkbook(s => s.agregarHoja);
  const renombrarHoja = useWorkbook(s => s.renombrarHoja);
  const duplicarHoja = useWorkbook(s => s.duplicarHoja);
  const eliminarHoja = useWorkbook(s => s.eliminarHoja);

  const [renombrando, setRenombrando] = useState(null);

  const alEliminar = (id, nombre) => {
    // Se pregunta porque la hoja se lleva sus datos. El undo la devuelve, pero
    // eso no lo sabe quien acaba de darle clic.
    if (!window.confirm(`Eliminar la hoja "${nombre}"? Puedes deshacerlo con Ctrl+Z.`)) return;
    if (!eliminarHoja(id)) toast.error('No se puede eliminar la unica hoja del libro');
  };

  return (
    <div className="h-9 flex items-center gap-1 px-2 border-t border-border bg-card flex-shrink-0 overflow-x-auto">
      <button
        onClick={() => agregarHoja()}
        className="h-6 w-6 flex-shrink-0 rounded flex items-center justify-center text-muted-foreground hover:bg-black/5 dark:hover:bg-white/5 hover:text-foreground"
        title="Agregar hoja"
      >
        <Plus size={14} />
      </button>

      {workbook.sheets.map((hoja) => {
        const activa = hoja.id === workbook.activeSheetId;
        return (
          <div
            key={hoja.id}
            onClick={() => activarHoja(hoja.id)}
            onDoubleClick={() => setRenombrando(hoja.id)}
            className={cn(
              'group h-7 flex-shrink-0 flex items-center gap-1.5 px-2.5 rounded-t text-[12.5px] cursor-pointer border-t border-x',
              activa
                ? 'bg-background border-border font-semibold text-foreground'
                : 'bg-transparent border-transparent text-muted-foreground hover:text-foreground',
            )}
          >
            {renombrando === hoja.id ? (
              <input
                autoFocus
                defaultValue={hoja.name}
                onKeyDown={(e) => {
                  e.stopPropagation();
                  if (e.key === 'Enter') { renombrarHoja(hoja.id, e.currentTarget.value); setRenombrando(null); }
                  if (e.key === 'Escape') setRenombrando(null);
                }}
                onBlur={(e) => { renombrarHoja(hoja.id, e.currentTarget.value); setRenombrando(null); }}
                onClick={(e) => e.stopPropagation()}
                className="w-24 bg-transparent outline-none border-b border-royal text-[12.5px]"
              />
            ) : (
              <>
                <span className="truncate max-w-[140px]">{hoja.name}</span>
                {activa && (
                  <span className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                    <IconBtn onClick={(e) => { e.stopPropagation(); setRenombrando(hoja.id); }} title="Renombrar">
                      <Pencil size={11} />
                    </IconBtn>
                    <IconBtn onClick={(e) => { e.stopPropagation(); duplicarHoja(hoja.id); }} title="Duplicar">
                      <Copy size={11} />
                    </IconBtn>
                    <IconBtn onClick={(e) => { e.stopPropagation(); alEliminar(hoja.id, hoja.name); }} title="Eliminar">
                      <Trash2 size={11} />
                    </IconBtn>
                  </span>
                )}
              </>
            )}
          </div>
        );
      })}

      {/* Resumen de la selección, a la derecha (como la barra de estado de Excel). */}
      <div className="flex-1" />
      <ResumenSeleccion />
    </div>
  );
}

const IconBtn = ({ onClick, title, children }) => (
  <button
    onClick={onClick}
    title={title}
    className="p-0.5 rounded text-muted-foreground hover:text-foreground hover:bg-black/10 dark:hover:bg-white/10"
  >
    {children}
  </button>
);
