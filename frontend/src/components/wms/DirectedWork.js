import { useState, useEffect, useCallback } from "react";
import { toast } from "sonner";
import { Loader2, ScanLine, Link2, MapPin, ClipboardList, CheckCircle } from "lucide-react";
import { useLang } from "../../contexts/LanguageContext";
import { fetcher, poster, logLoadError, useWms, cleanScan } from "./lib";

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
        <div className="text-center">
          <h2 className="text-2xl font-bold tracking-tight text-foreground">{t('wms_directed_work') || 'Trabajo Dirigido'}</h2>
          <p className="text-sm text-muted-foreground mt-0.5">{t('wms_ready_hint') || 'Listo para recibir instrucciones'}</p>
        </div>
        <button
          onClick={getTask}
          disabled={loading}
          className="px-6 py-3 bg-primary text-primary-foreground rounded-md text-base font-medium hover:opacity-90 transition-colors disabled:opacity-50 disabled:pointer-events-none flex items-center gap-2"
        >
          {loading ? <Loader2 className="w-5 h-5 animate-spin" /> : <ScanLine className="w-5 h-5" />}
          {t('wms_get_task') || 'Pedir Siguiente Tarea'}
        </button>
      </div>
    );
  }

  const isPutaway = task.task_type === 'putaway';
  const isCrossDock = task.task_type === 'cross_dock';
  const isCycleCount = task.task_type === 'cycle_count';

  return (
    <div className="max-w-2xl mx-auto space-y-6 animate-in fade-in duration-300">
      <div className={`p-6 rounded-lg border relative overflow-hidden ${
        task.priority === 'HOT' ? 'border-red-300 bg-red-50 dark:border-red-500/40 dark:bg-red-500/5' : 'border-border bg-card'
      }`}>
        {task.priority === 'HOT' && (
          <div className="absolute top-4 right-4 px-2 py-0.5 rounded-md border text-xs font-medium bg-red-50 text-red-700 border-red-200 dark:bg-red-500/10 dark:text-red-300 dark:border-red-500/25 z-10">
            {t('wms_priority_hot') || 'PRIORIDAD CRITICA'}
          </div>
        )}

        <div className="flex items-center gap-4 mb-6">
          <div className="w-10 h-10 rounded-lg flex items-center justify-center bg-muted text-muted-foreground">
            {isCrossDock ? <Link2 className="w-5 h-5" /> : isPutaway ? <MapPin className="w-5 h-5" /> : <ClipboardList className="w-5 h-5" />}
          </div>
          <div>
            <h3 className="text-2xl font-bold tracking-tight text-foreground leading-none">
              {isCrossDock ? 'CROSS-DOCK' : isPutaway ? 'PUTAWAY' : isCycleCount ? 'CYCLE COUNT' : task.task_type.toUpperCase()}
            </h3>
            <p className="text-xs text-muted-foreground mt-1">ID: {task.task_id}</p>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6 text-center md:text-left">
          <div className="bg-muted/40 p-4 rounded-lg border border-border/60">
            <span className="text-xs font-medium text-muted-foreground block mb-1">Origen / LPN</span>
            <div className="text-xl font-semibold font-mono">{task.lpn_id}</div>
            <div className="text-xs text-foreground/80 mt-1 truncate">{task.lpn_details?.sku}</div>
          </div>
          <div className="bg-muted/40 p-4 rounded-lg border border-border/60">
            <span className="text-xs font-medium text-muted-foreground block mb-1">Ubicacion Destino</span>
            <div className="text-xl font-semibold font-mono">
              {isCrossDock ? 'PRODUCCION' : (task.context?.suggested_zone || 'ZONA A-Z')}
            </div>
            <div className="text-xs text-muted-foreground mt-1">{t('wms_suggested_hint') || 'Destino guiado por sistema'}</div>
          </div>
        </div>

        <div className="space-y-4">
          <div className="relative">
            <ScanLine className="absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5 text-muted-foreground" />
            <input
              autoFocus
              placeholder="ESCANEAR LPN PARA VALIDAR"
              value={scan}
              onChange={e => setScan(cleanScan(e.target.value))}
              className="w-full pl-12 pr-4 py-4 bg-card border border-input rounded-lg focus:outline-none focus:ring-2 focus:ring-ring/25 focus:border-ring text-lg font-mono transition-colors text-center placeholder:text-muted-foreground/60"
            />
          </div>

          {!isCrossDock && (
            <div className="relative">
              <MapPin className="absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5 text-muted-foreground" />
              <select
                value={dest}
                onChange={e => setDest(e.target.value)}
                className="w-full pl-12 pr-4 py-4 bg-card border border-input rounded-lg focus:outline-none focus:ring-2 focus:ring-ring/25 focus:border-ring text-lg appearance-none transition-colors text-center"
              >
                <option value="">UBICACION FINAL</option>
                {locations.map(l => <option key={l.location_id} value={l.name}>{l.name}</option>)}
              </select>
            </div>
          )}

          <button
            onClick={handleComplete}
            disabled={completing || !scan || (!isCrossDock && !dest)}
            className="w-full py-4 bg-primary text-primary-foreground rounded-lg text-base font-semibold transition-colors hover:opacity-90 disabled:opacity-50 disabled:pointer-events-none flex items-center justify-center gap-2"
          >
            {completing ? <Loader2 className="w-5 h-5 animate-spin" /> : <CheckCircle className="w-5 h-5" />}
            {t('wms_confirm_execution') || 'CONFIRMAR MOVIMIENTO'}
          </button>

          <button
            onClick={() => setTask(null)}
            className="w-full py-2 text-xs font-medium text-muted-foreground hover:text-red-600 dark:hover:text-red-400 transition-colors"
          >
            {t('wms_cancel_task') || 'LIBERAR TAREA / RECHAZAR'}
          </button>
        </div>
      </div>
    </div>
  );
};
