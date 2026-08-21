import React, { useState, useMemo, useRef } from 'react';
import { createPortal } from 'react-dom';
import { ArrowDownAZ, ArrowUpAZ, Filter, Search, Check, X } from 'lucide-react';
import { useWorkbook } from '../store/useWorkbook';
import { getActiveSheet } from '../engine/model';
import { computeSheet } from '../engine/compute';
import { valoresDistintos, OPS_TEXTO, OPS_NUMERO, columnaFiltrada } from '../engine/filter';
import { colToLetters } from '../engine/address';
import { cn } from '../../lib/utils';

/**
 * Boton de filtro (embudo) que se pinta sobre la celda de encabezado de cada
 * columna filtrable. Al abrirlo aparece el menu con ordenar + condicion +
 * valores. Se dibuja en un portal para que el menu no lo recorte el overflow
 * de la rejilla.
 */
export function FilterButton({ col, top, left }) {
  const [abierto, setAbierto] = useState(false);
  const [pos, setPos] = useState({ left: 0, top: 0 });
  const ref = useRef(null);
  const activa = useWorkbook(s => columnaFiltrada(getActiveSheet(s.workbook), col));

  const abrir = () => {
    const r = ref.current?.getBoundingClientRect();
    if (r) setPos({ left: Math.max(8, r.right - 260), top: r.bottom + 2 });
    setAbierto(true);
  };

  return (
    <>
      <button
        ref={ref}
        onMouseDown={(e) => e.stopPropagation()}
        onClick={abrir}
        title="Filtrar / ordenar esta columna"
        className={cn(
          'absolute z-[12] w-4 h-4 flex items-center justify-center rounded-sm border',
          activa
            ? 'bg-royal text-white border-royal'
            : 'bg-card text-muted-foreground border-border hover:text-foreground',
        )}
        style={{ top: top + 4, left }}
      >
        <Filter size={10} />
      </button>
      {abierto && createPortal(
        <MenuFiltro col={col} pos={pos} onClose={() => setAbierto(false)} />,
        document.body,
      )}
    </>
  );
}

function MenuFiltro({ col, pos, onClose }) {
  const workbook = useWorkbook(s => s.workbook);
  const ordenarPorColumna = useWorkbook(s => s.ordenarPorColumna);
  const fijarCriterioFiltro = useWorkbook(s => s.fijarCriterioFiltro);

  const sheet = getActiveSheet(workbook);
  const filtro = sheet.filter;
  const criterioActual = filtro?.criterios?.[col] || null;

  // Valores distintos de la columna (para las casillas). Se calcula al abrir.
  const { valores } = useMemo(() => {
    const computed = computeSheet(sheet);
    return { valores: valoresDistintos(sheet, computed, col, filtro.r1, filtro.r2) };
  }, [sheet, col, filtro]);

  // ¿La columna es numerica? Si la mayoria de sus valores son numeros.
  const esNumerica = useMemo(() => {
    const nums = valores.filter(v => v !== '' && !Number.isNaN(Number(v))).length;
    const total = valores.filter(v => v !== '').length || 1;
    return nums / total > 0.6;
  }, [valores]);

  const [busqueda, setBusqueda] = useState('');
  // Estado de las casillas: por defecto, lo que el criterio permita, o todo.
  const [marcados, setMarcados] = useState(() => {
    if (criterioActual?.tipo === 'valores') return new Set(criterioActual.permitidos);
    return new Set(valores);
  });

  // Estado de la condicion.
  const ops = esNumerica ? OPS_NUMERO : OPS_TEXTO;
  const [op, setOp] = useState(criterioActual?.tipo === 'condicion' ? criterioActual.op : '');
  const [valA, setValA] = useState(criterioActual?.tipo === 'condicion' ? (criterioActual.a || '') : '');
  const [valB, setValB] = useState(criterioActual?.tipo === 'condicion' ? (criterioActual.b || '') : '');
  const opInfo = ops.find(o => o.op === op);

  const visibles = valores.filter(v =>
    busqueda === '' || String(v).toLowerCase().includes(busqueda.toLowerCase()));

  const alternar = (v) => setMarcados(prev => {
    const n = new Set(prev);
    if (n.has(v)) n.delete(v); else n.add(v);
    return n;
  });
  const todos = () => setMarcados(new Set(valores));
  const ninguno = () => setMarcados(new Set());

  const aplicar = () => {
    // Si hay condicion elegida, gana la condicion; si no, las casillas.
    if (op) {
      fijarCriterioFiltro(col, { tipo: 'condicion', op, a: valA, b: valB });
    } else if (marcados.size >= valores.length) {
      fijarCriterioFiltro(col, null);   // todo marcado = sin filtro
    } else {
      fijarCriterioFiltro(col, { tipo: 'valores', permitidos: [...marcados] });
    }
    onClose();
  };
  const quitar = () => { fijarCriterioFiltro(col, null); onClose(); };
  const ordenar = (asc) => { ordenarPorColumna(col, asc); onClose(); };

  return (
    <>
      <div className="fixed inset-0 z-[200]" onClick={onClose} />
      <div
        className="fixed z-[201] w-64 rounded-md border border-border bg-card shadow-xl text-[13px]"
        style={{ left: pos.left, top: pos.top }}
      >
        <div className="px-3 py-2 border-b border-border flex items-center justify-between">
          <span className="font-semibold text-foreground">Columna {colToLetters(col)}</span>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground"><X size={14} /></button>
        </div>

        {/* Ordenar */}
        <div className="p-1.5 border-b border-border">
          <button onClick={() => ordenar(true)} className="w-full flex items-center gap-2 px-2 py-1.5 rounded hover:bg-black/5 dark:hover:bg-white/5 text-foreground">
            <ArrowDownAZ size={14} className="text-muted-foreground" /> Ordenar A → Z
          </button>
          <button onClick={() => ordenar(false)} className="w-full flex items-center gap-2 px-2 py-1.5 rounded hover:bg-black/5 dark:hover:bg-white/5 text-foreground">
            <ArrowUpAZ size={14} className="text-muted-foreground" /> Ordenar Z → A
          </button>
        </div>

        {/* Condicion */}
        <div className="p-2 border-b border-border space-y-1.5">
          <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Filtrar por condición</div>
          <select
            value={op}
            onChange={(e) => setOp(e.target.value)}
            className="w-full h-7 rounded border border-border bg-background px-1.5 text-[12.5px]"
          >
            <option value="">(ninguna — usar valores)</option>
            {ops.map(o => <option key={o.op} value={o.op}>{o.label}</option>)}
          </select>
          {opInfo && !opInfo.sinValor && (
            <div className="flex gap-1.5">
              <input
                value={valA} onChange={(e) => setValA(e.target.value)}
                placeholder="Valor"
                className="flex-1 h-7 rounded border border-border bg-background px-2 text-[12.5px]"
              />
              {opInfo.dosValores && (
                <input
                  value={valB} onChange={(e) => setValB(e.target.value)}
                  placeholder="y"
                  className="flex-1 h-7 rounded border border-border bg-background px-2 text-[12.5px]"
                />
              )}
            </div>
          )}
        </div>

        {/* Valores (deshabilitado si hay condicion elegida) */}
        <div className={cn('p-2', op && 'opacity-40 pointer-events-none')}>
          <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground mb-1.5">Filtrar por valores</div>
          <div className="relative mb-1.5">
            <Search size={12} className="absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <input
              value={busqueda} onChange={(e) => setBusqueda(e.target.value)}
              placeholder="Buscar…"
              className="w-full h-7 rounded border border-border bg-background pl-7 pr-2 text-[12.5px]"
            />
          </div>
          <div className="flex gap-2 text-[11.5px] mb-1">
            <button onClick={todos} className="text-royal hover:underline">Todos</button>
            <button onClick={ninguno} className="text-royal hover:underline">Ninguno</button>
          </div>
          <div className="max-h-40 overflow-y-auto border border-border rounded">
            {visibles.length === 0 && <p className="px-2 py-2 text-muted-foreground text-[12px]">Sin valores</p>}
            {visibles.map((v, i) => (
              <label key={i} className="flex items-center gap-2 px-2 py-1 hover:bg-black/5 dark:hover:bg-white/5 cursor-pointer">
                <span className={cn(
                  'w-3.5 h-3.5 rounded-sm border flex items-center justify-center flex-shrink-0',
                  marcados.has(v) ? 'bg-royal border-royal' : 'border-border',
                )}>
                  {marcados.has(v) && <Check size={10} className="text-white" />}
                </span>
                <input type="checkbox" className="hidden" checked={marcados.has(v)} onChange={() => alternar(v)} />
                <span className="truncate text-foreground">{v === '' ? '(vacías)' : v}</span>
              </label>
            ))}
          </div>
        </div>

        <div className="flex items-center justify-between gap-2 p-2 border-t border-border">
          <button onClick={quitar} className="text-[12px] text-muted-foreground hover:text-foreground">Quitar filtro</button>
          <div className="flex gap-1.5">
            <button onClick={onClose} className="h-7 px-2.5 rounded text-[12px] text-muted-foreground hover:text-foreground">Cancelar</button>
            <button onClick={aplicar} className="h-7 px-3 rounded text-[12px] font-semibold bg-royal text-white">Aplicar</button>
          </div>
        </div>
      </div>
    </>
  );
}

// exportar el menu por si se quiere abrir aparte
export { MenuFiltro as FilterMenu };
