import { useState, useEffect, useCallback } from "react";
import { toast } from "sonner";
import { Warehouse, Loader2, ScanLine, Link2, MapPin, ClipboardList, CheckCircle } from "lucide-react";
import { useLang } from "../../contexts/LanguageContext";
import { fetcher, poster, logLoadError, useWms } from "./lib";

export const DirectedWorkModule = () => {
  const { t } = useLang();
  const { refreshBadges } = useWms();
  const [task, setTask] = useState(null);
  const [editingId, setEditingId] = useState(null);
  const [loading, setLoading] = useState(false);
  const [completing, setCompleting] = useState(false);
  const [scan, setScan] = useState('');
  const [dest, setDest] = useState('');
  const [locations, setLocations] = useState([]);

  const loadLocs = useCallback(() => { fetcher('/locations?summary=false').then(setLocations).catch(logLoadError('data')); }, []);
  useEffect(() => { loadLocs(); }, [loadLocs]);

  const getTask = async () => {
    setLoading(true);
    setScan('');
    setDest('');
    try {
      const res = await fetcher('/tasks/next');
      if (res && res.task) {
        setTask(res.task);
        if (res.task.task_type === 'cross_dock') setDest('Produccion');
      } else {
        setTask(null);
        toast.info(t('wms_no_tasks') || 'No hay tareas pendientes');
      }
    } catch (e) {
      toast.error('Error fetching task');
    } finally {
      setLoading(false);
    }
  };

  const handleComplete = async () => {
    if (!task) return;
    if (task.lpn_id && scan !== task.lpn_id) {
      toast.error(t('wms_scan_mismatch') || 'El LPN escaneado no coincide');
      return;
    }
    if (task.task_type === 'putaway' && !dest) {
      toast.error(t('wms_dest_req') || 'Ubicacion de destino requerida');
      return;
    }

    setCompleting(true);
    try {
      const resp = await poster(`/tasks/${task.task_id}/complete`, {
        scan,
        destination_location: dest
      });
      if (resp.ok) {
        toast.success(t('wms_task_done') || 'Tarea completada');
        setTask(null);
        // Refresh badges to show progress
        refreshBadges();
      } else {
        const err = await resp.json();
        toast.error(err.detail || 'Error completing task');
      }
    } catch (e) {
      toast.error('Connection error');
    } finally {
      setCompleting(false);
    }
  };

  if (!task) {
    return (
      <div className="flex flex-col items-center justify-center py-20 space-y-6">
        <div className="w-24 h-24 rounded-full bg-primary/10 flex items-center justify-center border-4 border-primary/20 animate-pulse">
          <Warehouse className="w-12 h-12 text-primary" />
        </div>
        <div className="text-center">
          <h2 className="text-2xl font-black uppercase tracking-tighter text-foreground">{t('wms_directed_work') || 'Trabajo Dirigido'}</h2>
          <p className="text-muted-foreground text-sm uppercase font-bold tracking-widest opacity-60">{t('wms_ready_hint') || 'Listo para recibir instrucciones'}</p>
        </div>
        <button
          onClick={getTask}
          disabled={loading}
          className="group relative px-10 py-5 bg-primary text-black rounded-3xl font-black uppercase tracking-tighter text-xl transition-all hover:scale-110 active:scale-95 shadow-[0_20px_40px_rgba(255,193,7,0.3)] hover:shadow-primary/40 flex items-center gap-3 overflow-hidden"
        >
          {loading ? <Loader2 className="w-6 h-6 animate-spin" /> : <ScanLine className="w-6 h-6 group-hover:rotate-12 transition-transform" />}
          {t('wms_get_task') || 'Pedir Siguiente Tarea'}
        </button>
      </div>
    );
  }

  const isPutaway = task.task_type === 'putaway';
  const isCrossDock = task.task_type === 'cross_dock';
  const isCycleCount = task.task_type === 'cycle_count';

  return (
    <div className="max-w-2xl mx-auto space-y-6 animate-in fade-in zoom-in duration-300">
      <div className={`p-6 rounded-[2.5rem] border-2 shadow-2xl relative overflow-hidden backdrop-blur-xl ${
        task.priority === 'HOT' ? 'border-red-500/50 bg-red-500/5 shadow-red-500/10' : 'border-primary/30 bg-card/60'
      }`}>
        {task.priority === 'HOT' && (
          <div className="absolute top-0 right-0 bg-red-600 text-white px-6 py-2 rounded-bl-3xl text-[10px] font-black uppercase tracking-tighter animate-pulse z-10">
            {t('wms_priority_hot') || 'PRIORIDAD CRITICA'}
          </div>
        )}

        <div className="flex items-center gap-4 mb-8">
          <div className={`w-16 h-16 rounded-2xl flex items-center justify-center shadow-lg ${
            isCrossDock ? 'bg-amber-500/20 text-amber-400' : isPutaway ? 'bg-purple-500/20 text-purple-400' : 'bg-blue-500/20 text-blue-400'
          }`}>
            {isCrossDock ? <Link2 className="w-8 h-8" /> : isPutaway ? <MapPin className="w-8 h-8" /> : <ClipboardList className="w-8 h-8" />}
          </div>
          <div>
            <h3 className="text-3xl font-black uppercase tracking-tighter text-foreground leading-none">
              {isCrossDock ? 'CROSS-DOCK' : isPutaway ? 'PUTAWAY' : isCycleCount ? 'CYCLE COUNT' : task.task_type.toUpperCase()}
            </h3>
            <p className="text-muted-foreground text-xs font-bold uppercase tracking-widest opacity-60 mt-1">ID: {task.task_id}</p>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-8 text-center md:text-left">
          <div className="bg-secondary/40 p-5 rounded-[2rem] border border-white/5 shadow-inner">
            <span className="text-[10px] font-black tracking-widest text-muted-foreground uppercase block mb-1">Origen / LPN</span>
            <div className="text-xl font-black text-primary font-mono">{task.lpn_id}</div>
            <div className="text-[10px] font-bold text-foreground/80 mt-1 uppercase truncate">{task.lpn_details?.sku}</div>
          </div>
          <div className="bg-primary/5 p-5 rounded-[2rem] border border-primary/10 shadow-inner">
            <span className="text-[10px] font-black tracking-widest text-muted-foreground uppercase block mb-1">Ubicacion Destino</span>
            <div className="text-xl font-black text-emerald-400 font-mono italic">
              {isCrossDock ? 'PRODUCCION' : (task.context?.suggested_zone || 'ZONA A-Z')}
            </div>
            <div className="text-[10px] font-bold text-muted-foreground mt-1 uppercase">{t('wms_suggested_hint') || 'Destino guiado por sistema'}</div>
          </div>
        </div>

        <div className="space-y-4">
          <div className="relative group">
            <ScanLine className="absolute left-6 top-1/2 -translate-y-1/2 w-6 h-6 text-primary group-focus-within:scale-110 transition-transform" />
            <input
              autoFocus
              placeholder="ESCANEAR LPN PARA VALIDAR"
              value={scan}
              onChange={e => setScan(e.target.value.toUpperCase())}
              className="w-full pl-16 pr-6 py-6 bg-background/80 border-2 border-border/20 rounded-[2.5rem] focus:border-primary focus:ring-4 focus:ring-primary/10 text-xl font-black font-mono transition-all text-center placeholder:text-muted-foreground/30"
            />
          </div>

          {!isCrossDock && (
            <div className="relative group">
              <MapPin className="absolute left-6 top-1/2 -translate-y-1/2 w-6 h-6 text-muted-foreground" />
              <select
                value={dest}
                onChange={e => setDest(e.target.value)}
                className="w-full pl-16 pr-6 py-6 bg-background/80 border-2 border-border/20 rounded-[2.5rem] focus:border-primary focus:ring-4 focus:ring-primary/10 text-xl font-black appearance-none transition-all text-center"
              >
                <option value="">UBICACION FINAL</option>
                {locations.map(l => <option key={l.location_id} value={l.name}>{l.name}</option>)}
              </select>
            </div>
          )}

          <button
            onClick={handleComplete}
            disabled={completing || !scan || (!isCrossDock && !dest)}
            className="w-full py-8 bg-emerald-500 text-white rounded-[2.5rem] font-black uppercase tracking-tighter text-2xl transition-all hover:scale-[1.02] active:scale-95 disabled:opacity-30 disabled:grayscale shadow-2xl shadow-emerald-500/20 hover:shadow-emerald-500/40 flex items-center justify-center gap-4"
          >
            {completing ? <Loader2 className="w-8 h-8 animate-spin" /> : <CheckCircle className="w-8 h-8" />}
            {t('wms_confirm_execution') || 'CONFIRMAR MOVIMIENTO'}
          </button>

          <button
            onClick={() => setTask(null)}
            className="w-full py-2 text-[10px] font-black text-muted-foreground/30 hover:text-red-400 uppercase tracking-widest transition-colors"
          >
            {t('wms_cancel_task') || 'LIBERAR TAREA / RECHAZAR'}
          </button>
        </div>
      </div>
    </div>
  );
};
