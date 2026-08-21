import React, { useRef, useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ArrowLeft, History, Upload, Download, ChevronDown, Loader2,
  Save, Printer, FolderOpen, Check, Sun, Moon,
} from 'lucide-react';
import { toast } from 'sonner';
import { Toolbar } from './components/Toolbar';
import { FormulaBar } from './components/FormulaBar';
import { Grid } from './components/Grid';
import { SheetTabs } from './components/SheetTabs';
import { SavedSheetsModal } from './components/SavedSheetsModal';
import { useKeyboard } from './hooks/useKeyboard';
import { useWorkbook } from './store/useWorkbook';
import { imprimirHoja } from './engine/print';
import { getActiveSheet } from './engine/model';
import { cn } from '../lib/utils';

/**
 * Modulo de hojas de calculo.
 *
 * La hoja ocupa toda la pantalla menos las barras: sin sidebar, sin tarjetas,
 * sin adornos. Cada pixel de cromo es una fila menos a la vista.
 */
export default function SheetsPage() {
  const navigate = useNavigate();
  useKeyboard(true);

  const [verHistorial, setVerHistorial] = useState(false);
  const [verGuardadas, setVerGuardadas] = useState(false);
  // Tema claro-suave de la hoja (por defecto activo). Se recuerda entre sesiones.
  const [temaClaro, setTemaClaro] = useState(() => localStorage.getItem('mos_sheets_tema') !== 'oscuro');

  // La clase va en <body> para que los menus en portal tambien la hereden.
  useEffect(() => {
    const clase = 'hoja-tema-claro';
    if (temaClaro) document.body.classList.add(clase);
    else document.body.classList.remove(clase);
    localStorage.setItem('mos_sheets_tema', temaClaro ? 'claro' : 'oscuro');
    return () => document.body.classList.remove(clase);
  }, [temaClaro]);
  const workbook = useWorkbook(s => s.workbook);
  const dirty = useWorkbook(s => s.dirty);
  const guardando = useWorkbook(s => s.guardando);
  const guardar = useWorkbook(s => s.guardar);
  const renombrarLibro = useWorkbook(s => s.renombrarLibro);

  const alGuardar = async () => {
    const res = await guardar();
    if (res.ok) toast.success('Guardado');
    else toast.error(res.error || 'No se pudo guardar');
  };

  // Ctrl+S guarda. Se escucha en captura para ganarle al guardado del navegador.
  useEffect(() => {
    const onKey = (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        alGuardar();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const imprimir = () => {
    const ok = imprimirHoja(getActiveSheet(workbook), workbook.name);
    if (!ok) toast.error('El navegador bloqueo la ventana de impresion. Permitela y reintenta.');
  };

  return (
    <div className="fixed inset-0 flex flex-col bg-background">
      {/* Encabezado */}
      <div className="h-11 flex items-center gap-2 px-3 border-b border-border bg-card flex-shrink-0">
        <button
          onClick={() => navigate('/home')}
          className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-black/5 dark:hover:bg-white/5"
          title="Volver"
        >
          <ArrowLeft size={16} />
        </button>

        {/* Nombre del libro, editable al hacer clic. */}
        <NombreLibro nombre={workbook.name} onRename={renombrarLibro} />

        <MenuArchivo />

        <button
          onClick={alGuardar}
          disabled={guardando}
          className="h-7 px-2 rounded flex items-center gap-1.5 text-[12px] text-muted-foreground hover:bg-black/5 dark:hover:bg-white/5 hover:text-foreground disabled:opacity-50"
          title="Guardar (Ctrl+S)"
        >
          {guardando ? <Loader2 size={13} className="animate-spin" /> : <Save size={14} />}
          Guardar
        </button>

        <button
          onClick={() => setVerGuardadas(true)}
          className="h-7 px-2 rounded flex items-center gap-1.5 text-[12px] text-muted-foreground hover:bg-black/5 dark:hover:bg-white/5 hover:text-foreground"
          title="Mis hojas guardadas"
        >
          <FolderOpen size={14} />
          Mis hojas
        </button>

        <button
          onClick={imprimir}
          className="h-7 px-2 rounded flex items-center gap-1.5 text-[12px] text-muted-foreground hover:bg-black/5 dark:hover:bg-white/5 hover:text-foreground"
          title="Imprimir la hoja activa"
        >
          <Printer size={14} />
          Imprimir
        </button>

        {/* Indicador de guardado. */}
        <span className={cn(
          'text-[11.5px] px-1.5 py-0.5 rounded flex items-center gap-1',
          dirty ? 'text-amber-600 dark:text-amber-500' : 'text-emerald-600 dark:text-emerald-500',
        )}>
          {dirty ? 'Sin guardar' : (<><Check size={12} /> Guardado</>)}
        </span>

        <div className="flex-1" />

        <button
          onClick={() => setTemaClaro(v => !v)}
          className="h-7 w-7 rounded flex items-center justify-center text-muted-foreground hover:bg-black/5 dark:hover:bg-white/5 hover:text-foreground"
          title={temaClaro ? 'Cambiar a tema oscuro' : 'Cambiar a tema claro'}
        >
          {temaClaro ? <Moon size={14} /> : <Sun size={14} />}
        </button>

        <button
          onClick={() => setVerHistorial(v => !v)}
          className={cn(
            'h-7 px-2 rounded flex items-center gap-1.5 text-[12px]',
            verHistorial
              ? 'bg-royal/15 text-royal'
              : 'text-muted-foreground hover:bg-black/5 dark:hover:bg-white/5 hover:text-foreground',
          )}
          title="Cambios recientes"
        >
          <History size={14} />
          Historial
        </button>
      </div>

      <Toolbar />
      <FormulaBar />

      <SavedSheetsModal isOpen={verGuardadas} onClose={() => setVerGuardadas(false)} />

      <div className="flex-1 min-h-0 flex">
        <Grid />
        {verHistorial && <PanelHistorial onClose={() => setVerHistorial(false)} />}
      </div>

      <SheetTabs />
    </div>
  );
}

/** Nombre del libro, editable al hacer clic (renombrar el archivo). */
function NombreLibro({ nombre, onRename }) {
  const [editando, setEditando] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    if (editando && ref.current) { ref.current.focus(); ref.current.select(); }
  }, [editando]);

  if (editando) {
    return (
      <input
        ref={ref}
        defaultValue={nombre}
        onKeyDown={(e) => {
          if (e.key === 'Enter') { onRename(e.currentTarget.value); setEditando(false); }
          if (e.key === 'Escape') setEditando(false);
        }}
        onBlur={(e) => { onRename(e.currentTarget.value); setEditando(false); }}
        className="h-7 w-56 rounded border border-royal bg-background px-2 text-[14px] font-semibold outline-none"
      />
    );
  }
  return (
    <button
      onClick={() => setEditando(true)}
      className="h-7 px-1.5 rounded text-[14px] font-semibold text-foreground hover:bg-black/5 dark:hover:bg-white/5"
      title="Clic para renombrar"
    >
      {nombre}
    </button>
  );
}

/** Menu Archivo: importar XLSX/CSV y exportar. */
function MenuArchivo() {
  const [abierto, setAbierto] = useState(false);
  const [cargando, setCargando] = useState(false);
  const inputRef = useRef(null);
  const importar = useWorkbook(s => s.importar);
  const exportarXLSX = useWorkbook(s => s.exportarXLSX);
  const exportarCSV = useWorkbook(s => s.exportarCSV);

  const alElegirArchivo = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';   // permitir reabrir el mismo archivo
    if (!file) return;
    setCargando(true);
    const res = await importar(file);
    setCargando(false);
    setAbierto(false);
    if (!res.ok) {
      toast.error(res.errors?.[0] || 'No se pudo abrir el archivo');
      return;
    }
    if (res.errors?.length) {
      // No se rompe nada en silencio: se avisa lo que se recorto (punto 4).
      toast.warning(`Importado con avisos: ${res.errors.join(' ')}`);
    } else {
      toast.success('Archivo importado');
    }
  };

  const Item = ({ onClick, icon: Icon, children }) => (
    <button
      onClick={onClick}
      className="w-full flex items-center gap-2 px-3 py-1.5 text-[13px] text-foreground hover:bg-black/5 dark:hover:bg-white/5 text-left"
    >
      <Icon size={14} className="text-muted-foreground" />
      {children}
    </button>
  );

  return (
    <div className="relative">
      <button
        onClick={() => setAbierto(v => !v)}
        className="h-7 px-2 rounded flex items-center gap-1 text-[13px] text-muted-foreground hover:bg-black/5 dark:hover:bg-white/5 hover:text-foreground"
      >
        {cargando ? <Loader2 size={13} className="animate-spin" /> : null}
        Archivo <ChevronDown size={12} />
      </button>
      {abierto && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setAbierto(false)} />
          <div className="absolute left-0 top-8 z-50 w-52 rounded-md border border-border bg-card shadow-lg py-1">
            <Item onClick={() => inputRef.current?.click()} icon={Upload}>Abrir XLSX / CSV…</Item>
            <div className="h-px bg-border my-1" />
            <Item onClick={() => { exportarXLSX(); setAbierto(false); }} icon={Download}>Exportar como XLSX</Item>
            <Item onClick={() => { exportarCSV(); setAbierto(false); }} icon={Download}>Exportar hoja como CSV</Item>
          </div>
        </>
      )}
      <input
        ref={inputRef} type="file" accept=".xlsx,.xls,.csv"
        onChange={alElegirArchivo} className="hidden"
      />
    </div>
  );
}

/** Panel de cambios recientes (punto 9: "revisar cambios"). */
function PanelHistorial() {
  const past = useWorkbook(s => s.past);
  const future = useWorkbook(s => s.future);
  const undo = useWorkbook(s => s.undo);
  const redo = useWorkbook(s => s.redo);

  const recientes = past.slice(-40).reverse();

  return (
    <aside className="w-60 flex-shrink-0 border-l border-border bg-card flex flex-col">
      <div className="h-8 flex items-center px-3 border-b border-border text-[11px] font-bold uppercase tracking-[0.12em] text-muted-foreground/70">
        Cambios recientes
      </div>

      <div className="flex-1 overflow-y-auto">
        {recientes.length === 0 && (
          <p className="p-3 text-[12px] text-muted-foreground">Todavia no hay cambios.</p>
        )}
        {recientes.map((cmd, i) => (
          <div
            key={past.length - i}
            className={cn(
              'px-3 py-1.5 text-[12px] border-b border-border/50',
              i === 0 ? 'text-foreground font-medium' : 'text-muted-foreground',
            )}
          >
            {cmd.etiqueta || cmd.tipo}
          </div>
        ))}
      </div>

      <div className="flex gap-1 p-2 border-t border-border">
        <button
          onClick={undo}
          disabled={!past.length}
          className="flex-1 h-7 rounded text-[12px] border border-border text-muted-foreground hover:text-foreground disabled:opacity-40"
        >
          Deshacer
        </button>
        <button
          onClick={redo}
          disabled={!future.length}
          className="flex-1 h-7 rounded text-[12px] border border-border text-muted-foreground hover:text-foreground disabled:opacity-40"
        >
          Rehacer
        </button>
      </div>
    </aside>
  );
}
