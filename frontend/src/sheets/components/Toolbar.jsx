import React, { useState, useRef } from 'react';
import { createPortal } from 'react-dom';
import {
  Undo2, Redo2, Bold, Italic, Underline, AlignLeft, AlignCenter, AlignRight,
  Rows3, Columns3, Trash2, Snowflake, EyeOff, Eye,
  Merge, Split, ArrowDownAZ, ArrowUpAZ, Baseline, PaintBucket, Ban, ChevronDown,
  WrapText, Paintbrush, Grid3x3, Filter,
} from 'lucide-react';
import { useWorkbook } from '../store/useWorkbook';
import { FORMATS, FONT_FAMILIES, FONT_SIZES } from '../engine/model';
import { cn } from '../../lib/utils';

// Paleta fija (la de Google Sheets). Colores explicitos, no un selector que
// genera uno nuevo cada vez: mas barato de pintar y mantiene la hoja consistente.
const PALETA = [
  '#000000', '#434343', '#666666', '#999999', '#b7b7b7', '#cccccc', '#d9d9d9', '#efefef', '#f3f3f3', '#ffffff',
  '#980000', '#ff0000', '#ff9900', '#ffff00', '#00ff00', '#00ffff', '#4a86e8', '#0000ff', '#9900ff', '#ff00ff',
  '#e6b8af', '#f4cccc', '#fce5cd', '#fff2cc', '#d9ead3', '#d0e0e3', '#c9daf8', '#cfe2f3', '#d9d2e9', '#ead1dc',
  '#dd7e6b', '#ea9999', '#f9cb9c', '#ffe599', '#b6d7a8', '#a2c4c9', '#a4c2f4', '#9fc5e8', '#b4a7d6', '#d5a6bd',
  '#cc4125', '#e06666', '#f6b26b', '#ffd966', '#93c47d', '#76a5af', '#6d9eeb', '#6fa8dc', '#8e7cc3', '#c27ba0',
];

const Btn = ({ onClick, activo, disabled, title, children }) => (
  <button
    onClick={onClick} disabled={disabled} title={title}
    className={cn(
      'h-7 min-w-7 px-1.5 rounded flex items-center justify-center transition-colors',
      disabled ? 'text-muted-foreground/40 cursor-not-allowed'
        : activo ? 'bg-royal/15 text-royal'
          : 'text-muted-foreground hover:bg-black/5 dark:hover:bg-white/5 hover:text-foreground',
    )}
  >
    {children}
  </button>
);

const Sep = () => <div className="w-px h-5 bg-border mx-1 flex-shrink-0" />;

/**
 * Selector de color: abre una paleta fija con opcion "Sin color".
 *
 * La paleta se dibuja en un PORTAL a body con posicion fija. La barra de
 * herramientas tiene overflow-x-auto (para su scroll horizontal), y eso recorta
 * cualquier menu que se salga de su alto: dentro de la barra el menu no se veia.
 */
function ColorBtn({ icon: Icon, title, onPick, onClear }) {
  const [abierto, setAbierto] = useState(false);
  const [pos, setPos] = useState({ left: 0, top: 0 });
  const btnRef = useRef(null);

  const abrir = () => {
    const r = btnRef.current?.getBoundingClientRect();
    if (r) setPos({ left: r.left, top: r.bottom + 4 });
    setAbierto(v => !v);
  };
  const elegir = (color) => { onPick(color); setAbierto(false); };
  const quitar = () => { onClear(); setAbierto(false); };

  return (
    <div className="h-7 flex items-center">
      <button
        ref={btnRef}
        onClick={abrir}
        title={title}
        className={cn(
          'h-7 px-1 rounded flex items-center gap-0.5 transition-colors',
          abierto ? 'bg-royal/15 text-royal' : 'text-muted-foreground hover:bg-black/5 dark:hover:bg-white/5 hover:text-foreground',
        )}
      >
        <Icon size={14} />
        <ChevronDown size={10} />
      </button>

      {abierto && createPortal(
        <>
          <div className="fixed inset-0 z-[200]" onClick={() => setAbierto(false)} />
          <div
            className="fixed z-[201] rounded-md border border-border bg-card shadow-lg p-2"
            style={{ left: pos.left, top: pos.top }}
          >
            <button
              onClick={quitar}
              className="w-full flex items-center gap-1.5 px-1.5 py-1 mb-1.5 rounded text-[12px] text-foreground hover:bg-black/5 dark:hover:bg-white/5"
            >
              <Ban size={13} className="text-muted-foreground" />
              Sin color
            </button>
            <div className="grid grid-cols-10 gap-1" style={{ width: 220 }}>
              {PALETA.map((c) => (
                <button
                  key={c}
                  onClick={() => elegir(c)}
                  title={c}
                  className="w-4 h-4 rounded-sm border border-black/10 dark:border-white/10 hover:ring-2 hover:ring-royal"
                  style={{ backgroundColor: c }}
                />
              ))}
            </div>
          </div>
        </>,
        document.body,
      )}
    </div>
  );
}

export function Toolbar() {
  const undo = useWorkbook(s => s.undo);
  const redo = useWorkbook(s => s.redo);
  const past = useWorkbook(s => s.past);
  const future = useWorkbook(s => s.future);

  const alternarEstilo = useWorkbook(s => s.alternarEstilo);
  const alinear = useWorkbook(s => s.alinear);
  const aplicarFormato = useWorkbook(s => s.aplicarFormato);
  const fuenteFamilia = useWorkbook(s => s.fuenteFamilia);
  const fuenteTamano = useWorkbook(s => s.fuenteTamano);
  const colorTexto = useWorkbook(s => s.colorTexto);
  const colorRelleno = useWorkbook(s => s.colorRelleno);
  const combinar = useWorkbook(s => s.combinar);
  const separar = useWorkbook(s => s.separar);
  const ordenar = useWorkbook(s => s.ordenar);
  const alternarAjusteTexto = useWorkbook(s => s.alternarAjusteTexto);
  const copiarFormato = useWorkbook(s => s.copiarFormato);
  const pegarFormato = useWorkbook(s => s.pegarFormato);
  const formatoCopiado = useWorkbook(s => s.formatoCopiado);
  const alternarGridlines = useWorkbook(s => s.alternarGridlines);
  const alternarFiltro = useWorkbook(s => s.alternarFiltro);

  const range = useWorkbook(s => s.range);
  const insertarFilas = useWorkbook(s => s.insertarFilas);
  const eliminarFilas = useWorkbook(s => s.eliminarFilas);
  const insertarColumnas = useWorkbook(s => s.insertarColumnas);
  const eliminarColumnas = useWorkbook(s => s.eliminarColumnas);
  const ocultarColumna = useWorkbook(s => s.ocultarColumna);
  const mostrarColumnas = useWorkbook(s => s.mostrarColumnas);
  const alternarCongelar = useWorkbook(s => s.alternarCongelar);
  const workbook = useWorkbook(s => s.workbook);

  const hoja = workbook.sheets.find(s => s.id === workbook.activeSheetId);
  const congelado = hoja?.frozenRows > 0 || hoja?.frozenCols > 0;
  const hayOcultas = hoja?.hiddenCols.size > 0;
  const sinGrid = !!hoja?.hideGridlines;
  const hayFiltro = !!hoja?.filter;

  return (
    <div className="h-9 flex items-center gap-0.5 px-2 border-b border-border bg-card flex-shrink-0 overflow-x-auto">
      <Btn onClick={undo} disabled={!past.length} title="Deshacer (Ctrl+Z)"><Undo2 size={14} /></Btn>
      <Btn onClick={redo} disabled={!future.length} title="Rehacer (Ctrl+Y)"><Redo2 size={14} /></Btn>

      <Sep />

      {/* Fuente y tamano */}
      <select
        onChange={(e) => fuenteFamilia(e.target.value)}
        className="h-7 rounded border border-border bg-background px-1.5 text-[12px] text-foreground max-w-[130px]"
        title="Fuente" defaultValue=""
      >
        <option value="" disabled>Fuente</option>
        {FONT_FAMILIES.map(f => <option key={f.label} value={f.value}>{f.label}</option>)}
      </select>
      <select
        onChange={(e) => fuenteTamano(Number(e.target.value))}
        className="h-7 w-14 rounded border border-border bg-background px-1 text-[12px] text-foreground"
        title="Tamano de fuente" defaultValue=""
      >
        <option value="" disabled>Tam.</option>
        {FONT_SIZES.map(s => <option key={s} value={s}>{s}</option>)}
      </select>

      <Sep />

      <Btn onClick={() => alternarEstilo('bold')} title="Negrita (Ctrl+B)"><Bold size={14} /></Btn>
      <Btn onClick={() => alternarEstilo('italic')} title="Cursiva (Ctrl+I)"><Italic size={14} /></Btn>
      <Btn onClick={() => alternarEstilo('underline')} title="Subrayado (Ctrl+U)"><Underline size={14} /></Btn>
      <ColorBtn icon={Baseline} title="Color de texto" onPick={colorTexto} onClear={() => colorTexto(null)} />
      <ColorBtn icon={PaintBucket} title="Color de relleno" onPick={colorRelleno} onClear={() => colorRelleno(null)} />

      <Sep />

      <Btn onClick={() => alinear('left')} title="Izquierda"><AlignLeft size={14} /></Btn>
      <Btn onClick={() => alinear('center')} title="Centrar"><AlignCenter size={14} /></Btn>
      <Btn onClick={() => alinear('right')} title="Derecha"><AlignRight size={14} /></Btn>
      <Btn onClick={alternarAjusteTexto} title="Ajustar texto (varias lineas)"><WrapText size={14} /></Btn>
      <Btn onClick={combinar} title="Combinar celdas"><Merge size={14} /></Btn>
      <Btn onClick={separar} title="Separar celdas"><Split size={14} /></Btn>

      <Sep />

      <Btn onClick={copiarFormato} title="Copiar formato de la celda activa"><Paintbrush size={14} /></Btn>
      <Btn onClick={pegarFormato} disabled={!formatoCopiado} title="Pegar formato en la seleccion">
        <span className="text-[11px] font-semibold">Pegar fmt.</span>
      </Btn>

      <Sep />

      <select
        onChange={(e) => { aplicarFormato(e.target.value); e.target.selectedIndex = 0; }}
        className="h-7 rounded border border-border bg-background px-2 text-[12px] text-muted-foreground"
        title="Formato de celda" defaultValue=""
      >
        <option value="" disabled>Formato</option>
        <option value={FORMATS.GENERAL}>General</option>
        <option value={FORMATS.TEXT}>Texto</option>
        <option value={FORMATS.NUMBER}>Numero</option>
        <option value={FORMATS.CURRENCY}>Moneda</option>
        <option value={FORMATS.PERCENT}>Porcentaje</option>
        <option value={FORMATS.DATE}>Fecha</option>
      </select>

      <Sep />

      <Btn onClick={() => ordenar(true)} title="Ordenar ascendente (por la 1a columna del rango)"><ArrowDownAZ size={14} /></Btn>
      <Btn onClick={() => ordenar(false)} title="Ordenar descendente"><ArrowUpAZ size={14} /></Btn>
      <Btn onClick={alternarFiltro} activo={hayFiltro} title={hayFiltro ? 'Quitar filtro' : 'Filtrar (AutoFilter sobre la selección; 1a fila = encabezados)'}>
        <Filter size={14} />
      </Btn>

      <Sep />

      <Btn onClick={() => insertarFilas(range.r1, range.r2 - range.r1 + 1)} title="Insertar filas"><Rows3 size={14} /></Btn>
      <Btn onClick={() => insertarColumnas(range.c1, range.c2 - range.c1 + 1)} title="Insertar columnas"><Columns3 size={14} /></Btn>
      <Btn onClick={() => eliminarFilas(range.r1, range.r2 - range.r1 + 1)} title="Eliminar filas"><Trash2 size={14} /></Btn>
      <Btn onClick={() => ocultarColumna(range.c1, true)} title="Ocultar columna"><EyeOff size={14} /></Btn>
      <Btn onClick={mostrarColumnas} disabled={!hayOcultas} activo={hayOcultas} title="Mostrar todas las columnas"><Eye size={14} /></Btn>

      <Sep />

      <Btn
        onClick={alternarCongelar}
        activo={congelado}
        title={congelado ? 'Descongelar paneles' : 'Inmovilizar filas arriba y columnas a la izquierda del cursor'}
      >
        <Snowflake size={14} />
      </Btn>
      <Btn onClick={alternarGridlines} activo={sinGrid} title={sinGrid ? 'Mostrar cuadricula' : 'Ocultar cuadricula'}>
        <Grid3x3 size={14} />
      </Btn>
    </div>
  );
}
