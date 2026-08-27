import React, { useRef, useState, useEffect } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  ArrowLeft, History, Upload, Download, ChevronDown, Loader2,
  Save, Printer, FolderOpen, Check, Sun, Moon, ExternalLink, FileSpreadsheet,
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
import { conectarGoogle } from './engine/gsheets';
import { cn } from '../lib/utils';

/**
 * Aviso al abrir un Google Sheet. El conteo de estilos confirma que llego el
 * formato; si el backend no pudo leerlo, se muestra el motivo en vez de fallar
 * en silencio (la hoja abre igual, solo con su contenido).
 */
function avisoAperturaGoogle(res) {
  const info = res.info || {};
  if (info.formatoError) {
    toast.warning(`Se abrió sin estilos. Motivo: ${String(info.formatoError).slice(0, 180)}`, { duration: 12000 });
  } else {
    toast.success(`Google Sheet abierto · ${info.estilos ?? 0} estilos aplicados`);
  }
}

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
  // ¿Este libro vino de Google Sheets? Si es asi, el guardado principal (boton
  // "Guardar" y Ctrl+S) escribe de vuelta a Google, no al almacen local.
  const esGoogle = !!workbook.googleUrl;
  const [pedirConexion, setPedirConexion] = useState(null);
  const dirty = useWorkbook(s => s.dirty);
  const guardando = useWorkbook(s => s.guardando);
  const guardar = useWorkbook(s => s.guardar);
  const renombrarLibro = useWorkbook(s => s.renombrarLibro);
  const abrirGoogleSheet = useWorkbook(s => s.abrirGoogleSheet);
  const guardarEnGoogleAction = useWorkbook(s => s.guardarEnGoogle);
  const guardandoGoogle = useWorkbook(s => s.guardandoGoogle);
  const gsInfo = useWorkbook(s => s.gsInfo);

  const alGuardarGoogle = async () => {
    const res = await guardarEnGoogleAction();
    if (res.ok) {
      if (res.sinCambios) toast.info('No hay cambios que guardar.');
      else toast.success(res.skipped?.length
        ? `Guardado en Google. Pestañas nuevas no escritas: ${res.skipped.join(', ')}`
        : 'Guardado en Google Sheets');
    } else if (res.necesitaConectar) {
      if (workbook.googleUrl) sessionStorage.setItem('mos_gsheet_pendiente', workbook.googleUrl);
      setPedirConexion({ url: workbook.googleUrl });
    } else {
      toast.error(res.error);
    }
  };

  // Abrir automaticamente un Google Sheet si se llego con ?gsheet=<url>
  // (desde el boton "Abrir en MOS Sheet" de los comentarios).
  const [searchParams, setSearchParams] = useSearchParams();
  const [cargandoGoogle, setCargandoGoogle] = useState(false);
  useEffect(() => {
    const url = searchParams.get('gsheet');
    if (!url) return;
    setCargandoGoogle(true);
    (async () => {
      const res = await abrirGoogleSheet(url);
      setCargandoGoogle(false);
      if (res.ok) {
        avisoAperturaGoogle(res);
      } else if (res.necesitaConectar) {
        // Falta el permiso de Sheets: se muestra un cartel para conectar, y se
        // guarda la URL para reabrir la hoja al volver del consentimiento.
        sessionStorage.setItem('mos_gsheet_pendiente', url);
        setPedirConexion({ url });
      } else {
        toast.error(res.error);
      }
      searchParams.delete('gsheet');
      setSearchParams(searchParams, { replace: true });
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Al volver del consentimiento de Google (?google_connected=true), reabrir la
  // hoja que quedo pendiente.
  useEffect(() => {
    if (searchParams.get('google_connected') !== 'true') return;
    const pendiente = sessionStorage.getItem('mos_gsheet_pendiente');
    searchParams.delete('google_connected');
    setSearchParams(searchParams, { replace: true });
    if (!pendiente) { toast.success('Google conectado'); return; }
    sessionStorage.removeItem('mos_gsheet_pendiente');
    setCargandoGoogle(true);
    (async () => {
      const res = await abrirGoogleSheet(pendiente);
      setCargandoGoogle(false);
      if (res.ok) avisoAperturaGoogle(res);
      else toast.error(res.error);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const alGuardar = async () => {
    const res = await guardar();
    if (res.ok) toast.success('Guardado');
    else toast.error(res.error || 'No se pudo guardar');
  };

  // Guardado principal: para una hoja de Google, Ctrl+S y el boton "Guardar"
  // escriben de vuelta a Google; para el resto, al almacen local. El ref se
  // mantiene apuntando a la funcion actual para que el listener de teclado (que
  // se registra una sola vez) no llame a una version vieja tras cargar la hoja.
  const guardadoPrincipalRef = useRef(null);
  guardadoPrincipalRef.current = esGoogle ? alGuardarGoogle : alGuardar;

  // Ctrl+S guarda. Se escucha en captura para ganarle al guardado del navegador.
  useEffect(() => {
    const onKey = (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        guardadoPrincipalRef.current?.();
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

        {esGoogle ? (
          <button
            onClick={alGuardarGoogle}
            disabled={guardandoGoogle}
            className="h-7 px-2.5 rounded flex items-center gap-1.5 text-[12px] font-semibold bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-50"
            title="Guardar de vuelta en Google Sheets (Ctrl+S)"
          >
            {guardandoGoogle ? <Loader2 size={13} className="animate-spin" /> : <Save size={14} />}
            Guardar en Google
          </button>
        ) : (
          <button
            onClick={alGuardar}
            disabled={guardando}
            className="h-7 px-2 rounded flex items-center gap-1.5 text-[12px] text-muted-foreground hover:bg-black/5 dark:hover:bg-white/5 hover:text-foreground disabled:opacity-50"
            title="Guardar (Ctrl+S)"
          >
            {guardando ? <Loader2 size={13} className="animate-spin" /> : <Save size={14} />}
            Guardar
          </button>
        )}

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

      {/* Banner cuando el libro se abrio desde un Google Sheet (packing list).
          Es EDITABLE: se escribe de vuelta con "Guardar en Google". */}
      {workbook.googleUrl && (
        <div className="h-8 flex items-center gap-3 px-3 border-b border-border bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 flex-shrink-0 text-[12px]">
          <span className="flex items-center gap-1.5">
            {/* v6: marcador visible de la version del frontend que CORRE el
                navegador (el servidor puede tener otra si la cache sirvio un
                index.html viejo). Subirlo en cada cambio del modulo. */}
            <FileSpreadsheet size={13} /> Conectado a Google Sheets <span className="opacity-50">v8</span>
            {/* Diagnostico persistente: se lee en cualquier momento (no como los
                toasts, que desaparecen). estilos = formato traido de Google. */}
            {gsInfo && !gsInfo.formatoError && <span> · {gsInfo.estilos} estilos</span>}
            {gsInfo?.guardado && (
              <span className="font-semibold">
                {' '}· Guardado {gsInfo.guardado.hora}
                {gsInfo.guardado.celdas != null && ` (${gsInfo.guardado.celdas} celdas)`}
                {gsInfo.guardado.titulo && ` en "${gsInfo.guardado.titulo}"`}
              </span>
            )}
          </span>
          <div className="ml-auto flex items-center gap-3">
            <button
              onClick={alGuardarGoogle}
              disabled={guardandoGoogle}
              className="flex items-center gap-1.5 px-2 py-0.5 rounded bg-emerald-600 text-white font-semibold hover:bg-emerald-700 disabled:opacity-50"
            >
              {guardandoGoogle ? <Loader2 size={12} className="animate-spin" /> : <Save size={12} />}
              Guardar en Google
            </button>
            <a href={workbook.googleUrl} target="_blank" rel="noopener noreferrer" className="flex items-center gap-1 hover:underline" title="Abrir en Google">
              <ExternalLink size={13} />
            </a>
          </div>
        </div>
      )}

      {/* Errores de Google, FIJOS (no toast): quedan a la vista hasta resolverse. */}
      {workbook.googleUrl && gsInfo?.formatoError && (
        <div className="flex items-center gap-2 px-3 py-1 border-b border-border bg-amber-500/10 text-amber-700 dark:text-amber-400 flex-shrink-0 text-[12px]">
          La hoja abrió sin estilos. Motivo de Google: {String(gsInfo.formatoError).slice(0, 300)}
        </div>
      )}
      {workbook.googleUrl && gsInfo?.guardadoError && (
        <div className="flex items-center gap-2 px-3 py-1 border-b border-border bg-red-500/10 text-red-700 dark:text-red-400 flex-shrink-0 text-[12px]">
          No se pudo guardar en Google: {String(gsInfo.guardadoError).slice(0, 300)}
        </div>
      )}

      {cargandoGoogle && (
        <div className="h-8 flex items-center gap-2 px-3 border-b border-border bg-card flex-shrink-0 text-[12px] text-muted-foreground">
          <Loader2 size={13} className="animate-spin" /> Cargando el Google Sheet…
        </div>
      )}

      <SavedSheetsModal isOpen={verGuardadas} onClose={() => setVerGuardadas(false)} />

      <div className="flex-1 min-h-0 flex">
        <Grid />
        {verHistorial && <PanelHistorial onClose={() => setVerHistorial(false)} />}
      </div>

      <SheetTabs />

      {/* Cartel para conectar Google cuando falta el permiso de Sheets. */}
      {pedirConexion && (
        <div className="fixed inset-0 z-[300] flex items-center justify-center bg-black/40" onClick={() => setPedirConexion(null)}>
          <div className="w-[380px] max-w-[90vw] rounded-lg border border-border bg-card shadow-xl p-5 text-center" onClick={(e) => e.stopPropagation()}>
            <FileSpreadsheet size={32} className="mx-auto text-emerald-600 mb-2" />
            <h3 className="text-[15px] font-semibold text-foreground">Conecta tu cuenta de Google</h3>
            <p className="text-[13px] text-muted-foreground mt-1.5">
              Para abrir y editar hojas de Google Sheets desde MOS, hay que darle permiso una sola vez.
              Se abrirá la pantalla de Google y volverás aquí solo.
            </p>
            <div className="flex gap-2 mt-4">
              <button
                onClick={() => setPedirConexion(null)}
                className="flex-1 h-9 rounded-md border border-border text-[13px] text-muted-foreground hover:text-foreground"
              >
                Ahora no
              </button>
              <button
                onClick={() => conectarGoogle().catch(() => toast.error('No se pudo iniciar la conexión con Google'))}
                className="flex-1 h-9 rounded-md bg-emerald-600 text-white text-[13px] font-semibold hover:bg-emerald-700"
              >
                Conectar Google
              </button>
            </div>
          </div>
        </div>
      )}
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
