import { useState, useEffect, useCallback } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../../components/ui/dialog';
import { FileSpreadsheet, Trash2, Plus, Loader2, FolderOpen } from 'lucide-react';
import { toast } from 'sonner';
import { listarLibros, borrarLibro } from '../engine/storage';
import { useWorkbook } from '../store/useWorkbook';

/**
 * Gestor de hojas guardadas. Lista los libros persistidos en el navegador y
 * permite abrir, borrar o crear uno nuevo. Guardar es cosa del boton de la barra
 * superior; aqui solo se administran los que ya existen.
 */
export function SavedSheetsModal({ isOpen, onClose }) {
  const [libros, setLibros] = useState([]);
  const [cargando, setCargando] = useState(false);
  const abrirGuardado = useWorkbook(s => s.abrirGuardado);
  const nuevoLibro = useWorkbook(s => s.nuevoLibro);
  const idActual = useWorkbook(s => s.workbook.id);
  const dirty = useWorkbook(s => s.dirty);

  const recargar = useCallback(async () => {
    setCargando(true);
    try { setLibros(await listarLibros()); }
    catch { toast.error('No se pudieron leer las hojas guardadas'); }
    setCargando(false);
  }, []);

  useEffect(() => { if (isOpen) recargar(); }, [isOpen, recargar]);

  const confirmarCambio = () => (
    !dirty || window.confirm('Tienes cambios sin guardar. Se perderan si abres otro libro. Continuar?')
  );

  const abrir = async (id) => {
    if (!confirmarCambio()) return;
    const res = await abrirGuardado(id);
    if (res.ok) { toast.success('Libro abierto'); onClose(); }
    else toast.error(res.error);
  };

  const nuevo = () => {
    if (!confirmarCambio()) return;
    nuevoLibro();
    onClose();
  };

  const borrar = async (id, nombre, e) => {
    e.stopPropagation();
    if (!window.confirm(`Eliminar "${nombre}" permanentemente? No se puede deshacer.`)) return;
    try { await borrarLibro(id); toast.success('Eliminado'); recargar(); }
    catch { toast.error('No se pudo eliminar'); }
  };

  const fecha = (iso) => {
    if (!iso) return '';
    try { return new Date(iso).toLocaleString('es-MX', { dateStyle: 'medium', timeStyle: 'short' }); }
    catch { return iso; }
  };

  return (
    <Dialog open={isOpen} onOpenChange={(a) => { if (!a) onClose(); }}>
      <DialogContent className="max-w-lg max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Mis hojas de cálculo</DialogTitle>
        </DialogHeader>

        <button
          onClick={nuevo}
          className="w-full flex items-center gap-2 px-3 py-2 rounded-md border border-dashed border-border text-[13px] text-muted-foreground hover:text-foreground hover:border-royal"
        >
          <Plus size={15} /> Nueva hoja en blanco
        </button>

        <div className="mt-2 space-y-1">
          {cargando && (
            <div className="flex items-center justify-center py-6 text-muted-foreground">
              <Loader2 size={18} className="animate-spin" />
            </div>
          )}
          {!cargando && libros.length === 0 && (
            <p className="py-6 text-center text-[13px] text-muted-foreground">
              Todavia no has guardado ninguna hoja. Usa «Guardar» en la barra de arriba.
            </p>
          )}
          {!cargando && libros.map((l) => (
            <div
              key={l.id}
              onClick={() => abrir(l.id)}
              className="group flex items-center gap-3 px-3 py-2 rounded-md hover:bg-black/5 dark:hover:bg-white/5 cursor-pointer"
            >
              <FileSpreadsheet size={18} className="flex-shrink-0 text-royal" />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="truncate text-[13.5px] font-medium text-foreground">{l.name}</span>
                  {l.id === idActual && (
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-royal/15 text-royal">abierto</span>
                  )}
                </div>
                <div className="text-[11.5px] text-muted-foreground">
                  {l.hojas} hoja{l.hojas !== 1 ? 's' : ''} · {l.celdas} celdas · {fecha(l.updatedAt)}
                </div>
              </div>
              <button
                onClick={(e) => borrar(l.id, l.name, e)}
                className="opacity-0 group-hover:opacity-100 p-1 rounded text-muted-foreground hover:text-red-500"
                title="Eliminar"
              >
                <Trash2 size={15} />
              </button>
              <FolderOpen size={15} className="opacity-0 group-hover:opacity-100 text-muted-foreground" />
            </div>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}

export default SavedSheetsModal;
