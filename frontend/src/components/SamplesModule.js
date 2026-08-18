import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { Calendar, dateFnsLocalizer, Views } from 'react-big-calendar';
import withDragAndDrop from 'react-big-calendar/lib/addons/dragAndDrop';
import {
  format, parse, startOfWeek, getDay, addDays, subDays, addWeeks, subWeeks,
  addMonths, subMonths, startOfMonth, endOfMonth,
} from 'date-fns';
import { es } from 'date-fns/locale';
import 'react-big-calendar/lib/css/react-big-calendar.css';
import 'react-big-calendar/lib/addons/dragAndDrop/styles.css';

const DnDCalendar = withDragAndDrop(Calendar);

import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import {
  Beaker, ArrowLeft, ChevronLeft, ChevronRight, Loader2, Plus, X, Flame,
  RefreshCw, CalendarDays, Package, ExternalLink, AlertTriangle, CheckCircle2, Search, Link2,
  UserPlus, Shirt, Palette, Layers, Droplet, Scissors, Sparkles, Wand2, Zap,
  Download, ChevronDown,
} from 'lucide-react';
import { API } from '../lib/constants';
import { useTheme } from '../contexts/ThemeContext';
import { Toaster } from './ui/sonner';

// Espejo de routers/samples.py. La ETAPA la calcula el backend (`task.stage`);
// aquí sólo se pintan. Duplicar la regla de precedencia en el cliente sería
// pedir que las dos copias se mantuvieran iguales para siempre.
const STAGE_TABS = [
  { key: 'ejemplos',     label: 'Ejemplos',     hint: 'Se crean y se programan aquí' },
  { key: 'aprobados',    label: 'Aprobados',    hint: 'Aprobados por el cliente (tengan o no número de orden)' },
  { key: 'ready_to_mos', label: 'Ready to MOS', hint: 'Ya tienen número de orden (PO)' },
];

const SAMPLE_FLAGS = [
  { key: 'arte',    label: 'Arte',    Icon: Palette },
  { key: 'neck',    label: 'Neck',    Icon: Scissors },
  { key: 'trim',    label: 'Trim',    Icon: Package },
  { key: 'screens', label: 'Screens', Icon: Layers },
];

// ─── localizer ──────────────────────────────────────────────────────────────
const locales = { es };
const localizer = dateFnsLocalizer({
  format: (d, f, c) => format(d, f, { locale: locales[c] || locales.es }),
  parse: (v, f, r) => parse(v, f, r, { locale: locales.es }),
  startOfWeek: (d) => startOfWeek(d, { locale: locales.es }),
  getDay,
  locales,
});

// ─── theme-aware rbc css (light + dark) ─────────────────────────────────────
function injectRBCStyles(isDark) {
  const id = 'rbc-samples-styles';
  const existing = document.getElementById(id);
  if (existing) existing.remove();
  const bg = isDark ? '#0f172a' : '#ffffff';
  const border = isDark ? 'rgba(255,255,255,0.07)' : 'rgba(0,0,0,0.08)';
  const txt = isDark ? '#e2e8f0' : '#1e293b';
  const muted = isDark ? '#64748b' : '#94a3b8';
  const off = isDark ? '#0b1120' : '#f1f5f9';
  const today = isDark ? 'rgba(99,102,241,0.08)' : 'rgba(99,102,241,0.06)';
  const css = `
    .rbc-calendar{background:${bg};color:${txt};font-family:inherit;border-radius:12px}
    .rbc-header{background:transparent;color:${txt};border-color:${border};padding:8px;font-weight:800;text-transform:uppercase;letter-spacing:.05em;font-size:11px}
    .rbc-time-view,.rbc-month-view{border-color:${border};border-radius:12px}
    .rbc-time-header-content,.rbc-time-content,.rbc-day-bg,.rbc-day-slot,.rbc-timeslot-group,.rbc-time-slot{border-color:${border}}
    .rbc-off-range-bg{background:${off}}
    .rbc-today{background:${today}}
    .rbc-label,.rbc-time-gutter{color:${muted};font-size:11px}
    .rbc-event{border:none!important;padding:0!important;background:transparent!important;color:${txt}!important}
    .rbc-event.rbc-selected{outline:2px solid rgba(99,102,241,.4)!important;outline-offset:1px}
    .rbc-current-time-indicator{background:#ef4444;height:2px}
  `;
  const style = document.createElement('style');
  style.id = id;
  style.textContent = css;
  document.head.appendChild(style);
}

// ─── helpers ────────────────────────────────────────────────────────────────
const isoDate = (d) => format(d, 'yyyy-MM-dd');
const parseIso = (s) => (s ? new Date(`${s}T00:00:00`) : null);
const fmtDate = (iso) => (iso ? format(parseIso(iso), 'dd MMM', { locale: es }) : '');
const jobUrl = (v) => {
  if (!v) return '';
  const u = typeof v === 'object' ? (v.url || '') : String(v);
  return /^https?:\/\//i.test(u) ? u : '';
};

// Recurso disponible / no disponible / no aplica
const ResChip = ({ ok, icon: Icon, label, extra }) => {
  const state = ok === true ? 'ok' : ok === false ? 'no' : 'na';
  const styles = {
    ok: 'bg-emerald-500/15 text-emerald-500 border-emerald-500/30',
    no: 'bg-red-500/15 text-red-400 border-red-500/30',
    na: 'bg-secondary/60 text-muted-foreground border-border',
  }[state];
  return (
    <span className={`inline-flex items-center gap-1 text-[10px] font-black uppercase tracking-wide border rounded-full px-1.5 py-0.5 ${styles}`}
      title={extra ? `${label}: ${extra}` : label}>
      <Icon size={10} /> {label}
    </span>
  );
};

export default function SamplesModule() {
  const navigate = useNavigate();
  const { theme } = useTheme();
  const isDark = theme === 'dark';
  useEffect(() => { injectRBCStyles(isDark); }, [isDark]);

  const [view, setView] = useState(Views.WEEK);
  const [anchor, setAnchor] = useState(new Date());
  const [tasks, setTasks] = useState([]);
  const [backlog, setBacklog] = useState([]);
  const [operators, setOperators] = useState([]);
  const [statusesCatalog, setStatusesCatalog] = useState([]);
  const [clientsCatalog, setClientsCatalog] = useState([]);
  const [prioritiesCatalog, setPrioritiesCatalog] = useState(['RUSH','OVERSOLD','PRIORITY 1','PRIORITY 2','EVENT','SPECIAL RUSH']);
  const [loading, setLoading] = useState(true);

  const [addOrder, setAddOrder] = useState('');
  const [results, setResults] = useState([]);
  const [showProv, setShowProv] = useState(false);
  const [detail, setDetail] = useState(null);   // task seleccionado
  const [busy, setBusy] = useState(false);
  const [draggedTaskId, setDraggedTaskId] = useState(null);
  const [dragFromCalendar, setDragFromCalendar] = useState(false);
  const [backlogTab, setBacklogTab] = useState('with_style');   // with_style | no_style
  const [stage, setStage] = useState('ejemplos');               // ejemplos | aprobados | ready_to_mos
  const [stageData, setStageData] = useState({ items: [], counts: {} });
  const [stageLoading, setStageLoading] = useState(false);
  // Dentro de Ejemplos hay dos vistas. Arranca en LISTA porque el contador de
  // la pestaña cuenta TODOS los ejemplos de la etapa, mientras que el
  // calendario sólo enseña los de la semana visible: con 79 ejemplos repartidos
  // en tres meses, el calendario mostraba 2 y parecía que la lista no existía.
  // La elección se recuerda por usuario.
  const [ejemplosView, setEjemplosView] = useState(
    () => localStorage.getItem('samples_ejemplos_view') || 'lista');
  const setEjemplosViewSaved = useCallback((v) => {
    setEjemplosView(v);
    localStorage.setItem('samples_ejemplos_view', v);
  }, []);
  const [showAuto, setShowAuto] = useState(false);
  const [showExportMenu, setShowExportMenu] = useState(false);
  const [exporting, setExporting] = useState(false);

  // ─── API helper ────────────────────────────────────────────────────────────
  const api = async (method, path, body) => {
    const res = await fetch(`${API}${path}`, {
      method, credentials: 'include',
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) { const e = await res.json().catch(() => ({})); throw new Error(e.detail || 'Error'); }
    return res.json().catch(() => ({}));
  };

  // ─── Rango visible según view/anchor ──────────────────────────────────────
  const [rangeStart, rangeEnd] = useMemo(() => {
    if (view === Views.DAY) {
      return [isoDate(anchor), isoDate(anchor)];
    }
    if (view === Views.MONTH) {
      // El mes en rbc muestra la primera semana del mes anterior y la última
      // del siguiente si no cubren celdas. Amplia el rango a 6 semanas.
      const first = startOfWeek(startOfMonth(anchor), { locale: es });
      const last  = addDays(first, 41);
      return [isoDate(first), isoDate(last)];
    }
    if (view === Views.AGENDA) {
      // La agenda default de rbc muestra 30 días desde la fecha.
      return [isoDate(anchor), isoDate(addDays(anchor, 30))];
    }
    const s = startOfWeek(anchor, { locale: es });
    const e = addDays(s, 6);
    return [isoDate(s), isoDate(e)];
  }, [view, anchor]);

  const shiftAnchor = (dir) => {
    if (view === Views.DAY)   return setAnchor(dir > 0 ? addDays(anchor, 1)  : subDays(anchor, 1));
    if (view === Views.MONTH) return setAnchor(dir > 0 ? addMonths(anchor, 1): subMonths(anchor, 1));
    return setAnchor(dir > 0 ? addWeeks(anchor, 1) : subWeeks(anchor, 1));
  };

  // Las tablas de Aprobados / Ready to MOS vienen del backend ya clasificadas;
  // los conteos llegan SIEMPRE los tres, para que los números de las pestañas
  // que no estás viendo no queden rancios.
  const loadStage = useCallback(async (which) => {
    setStageLoading(true);
    try {
      const d = await api('GET', `/samples/by-stage?stage=${which}`);
      setStageData({ items: d?.items || [], counts: d?.counts || {} });
    } catch { toast.error('No se pudieron cargar los ejemplos de esta pestaña'); }
    finally { setStageLoading(false); }
  }, []);

  const toggleFlag = useCallback(async (task, key, value) => {
    try {
      const upd = await api('PUT', `/samples/tasks/${task.sample_task_id}/flags`,
                            { flags: { [key]: value } });
      setDetail(d => (d && d.sample_task_id === task.sample_task_id ? upd : d));
      setStageData(sd => ({ ...sd, items: sd.items.map(t => t.sample_task_id === upd.sample_task_id ? upd : t) }));
      setTasks(ts => ts.map(t => t.sample_task_id === upd.sample_task_id ? upd : t));
      setBacklog(bs => bs.map(t => t.sample_task_id === upd.sample_task_id ? upd : t));
    } catch { toast.error('No se pudo guardar el palomeo'); }
  }, []);

  const changeApproval = useCallback(async (task, value) => {
    try {
      const upd = await api('PUT', `/samples/tasks/${task.sample_task_id}/approval`,
                            { approval: value });
      toast.success(value === 'APROBADO'
        ? `${task.order_number} aprobado`
        : `${task.order_number} regresó a recibido`);
      setDetail(d => (d && d.sample_task_id === task.sample_task_id ? upd : d));
      // Cambiar la aprobación puede MOVER el ejemplo de pestaña, así que se
      // recarga la lista en vez de parchear el renglón en su lugar.
      return upd;
    } catch { toast.error('No se pudo cambiar la aprobación'); return null; }
  }, []);

  // Los conteos de las tres pestañas se piden siempre, aunque estés en el
  // calendario: son los números que se ven en los botones.
  useEffect(() => { loadStage(stage); }, [stage, loadStage]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [cal, bl, ops, cfg] = await Promise.all([
        api('GET', `/samples/calendar?start=${rangeStart}&end=${rangeEnd}`),
        api('GET', '/samples/backlog'),
        api('GET', '/operators?role=sample'),
        fetch(`${API}/config/options`, { credentials: 'include' }).then(r => r.json()).catch(() => ({})),
      ]);
      const flat = (cal?.days || []).flatMap(d => d.tasks || []);
      setTasks(flat);
      setBacklog(bl?.backlog || []);
      setOperators(ops || []);
      // Estatus permitidos = production_statuses + samples
      const prod = cfg?.production_statuses || [];
      const samp = cfg?.samples || [];
      setStatusesCatalog([...new Set([...samp, ...prod])]);
      // Catálogos del CRM para el modal PROV-
      if (Array.isArray(cfg?.clients)) setClientsCatalog(cfg.clients);
      if (Array.isArray(cfg?.priorities) && cfg.priorities.length) setPrioritiesCatalog(cfg.priorities);
    } catch (e) {
      console.error(e);
      toast.error('Error al cargar el calendario');
    } finally { setLoading(false); }
  }, [rangeStart, rangeEnd]);
  useEffect(() => { load(); }, [load]);

  // ─── Búsqueda de órdenes ──────────────────────────────────────────────────
  useEffect(() => {
    const q = addOrder.trim();
    if (!q) { setResults([]); return; }
    const id = setTimeout(async () => {
      try { const r = await api('GET', `/samples/search?q=${encodeURIComponent(q)}`); setResults(r.results || []); }
      catch { setResults([]); }
    }, 250);
    return () => clearTimeout(id);
  }, [addOrder]);

  // ─── Eventos para react-big-calendar ──────────────────────────────────────
  // All-day = pills grandes en la barra del día (mucho más legibles que
  // ranuras de 30 min donde no se ve el texto).
  const events = useMemo(() => tasks.map(t => {
    const day = parseIso(t.scheduled_date) || new Date();
    const start = new Date(day); start.setHours(0, 0, 0, 0);
    const end = new Date(day); end.setHours(23, 59, 59, 0);
    return { id: t.sample_task_id, title: t.order_number, start, end, allDay: true, task: t };
  }), [tasks]);

  const eventStyleGetter = () => ({ style: { background: 'transparent' } });

  const EventCard = ({ event }) => {
    const t = event.task;
    // Placeholder fantasma durante drag-from-outside: no tiene task
    if (!t) return <div className="w-full h-full bg-indigo-500/40 rounded" />;
    const o = t.order || {};
    const bg = t.color_tag || (t.is_hot ? '#ef4444' : t.overdue ? '#f97316' : '#4f46e5');
    return (
      <div
        onClick={(e) => { e.stopPropagation(); setDetail(t); }}
        title={`${t.order_number} · ${o.client || ''} · ${o.style || ''} ${o.color || ''}`}
        style={{ background: bg }}
        className="flex items-center gap-1 h-full w-full px-2 py-0.5 rounded text-white text-[11px] font-mono font-black cursor-pointer hover:opacity-90 overflow-hidden">
        {t.is_hot && <Flame size={11} />}
        {t.overdue && <AlertTriangle size={11} />}
        <span className="truncate">{t.order_number}</span>
        {t.is_provisional && <span className="text-[8px] font-black uppercase bg-white/25 px-1 rounded">P</span>}
        {o.style && <span className="text-[9px] font-normal opacity-80 truncate">{o.style}</span>}
      </div>
    );
  };

  // ─── Acciones ─────────────────────────────────────────────────────────────
  const addByOrder = async (orderId) => {
    try { setBusy(true); await api('POST', '/samples/tasks', { order_id: orderId }); setAddOrder(''); await load(); toast.success('Ejemplo agregado'); }
    catch (e) { toast.error(e.message); } finally { setBusy(false); }
  };

  const createProvisional = async (payload) => {
    try {
      setBusy(true);
      await api('POST', '/samples/tasks', { provisional: true, ...payload });
      setShowProv(false); await load();
      toast.success('Ejemplo PROV- creado');
    } catch (e) { toast.error(e.message); } finally { setBusy(false); }
  };

  const updateTask = async (id, patch) => {
    try { await api('PUT', `/samples/tasks/${id}`, patch); await load(); }
    catch (e) { toast.error(e.message); }
  };

  const assignOperator = async (id, operator_id) => {
    try {
      const r = await api('PUT', `/samples/tasks/${id}/assign`, { operator_id });
      await load();
      if (detail?.sample_task_id === id) setDetail({ ...detail, ...r });
      toast.success(operator_id ? 'Operador asignado' : 'Sin operador');
    } catch (e) { toast.error(e.message); }
  };

  const changeStatus = async (id, status) => {
    try {
      const r = await api('PUT', `/samples/tasks/${id}/status`, { status });
      await load();
      if (detail?.sample_task_id === id) setDetail({ ...detail, ...r });
      toast.success(`Estatus: ${status}`);
    } catch (e) { toast.error(e.message); }
  };

  const removeTask = async (t) => {
    if (!window.confirm(`¿Quitar el ejemplo ${t.order_number}?`)) return;
    try { await api('DELETE', `/samples/tasks/${t.sample_task_id}`); setDetail(null); await load(); toast.success('Ejemplo eliminado'); }
    catch (e) { toast.error(e.message); }
  };

  const promoteProv = async (task, orderNumber) => {
    try { await api('POST', `/samples/tasks/${task.sample_task_id}/promote`, { order_number: orderNumber }); await load(); setDetail(null); toast.success(`Fusionado a ${orderNumber}`); }
    catch (e) { toast.error(e.message); }
  };

  // Reprogramar (backlog o calendario) a una fecha
  const scheduleAt = async (taskId, date) => {
    try {
      await api('PUT', `/samples/tasks/${taskId}`, { scheduled_date: date });
      await load();
      toast.success(date ? `Programado el ${fmtDate(date)}` : 'Movido al backlog');
    } catch (e) { toast.error(e.message || 'No se pudo reprogramar'); }
  };
  const todayIso = () => isoDate(new Date());
  const tomorrowIso = () => isoDate(addDays(new Date(), 1));

  // ─── Export a Excel ──────────────────────────────────────────────────────
  const exportXlsx = async (scope = 'all', filter = 'all') => {
    setShowExportMenu(false);
    setExporting(true);
    try {
      const params = new URLSearchParams({ scope, filter });
      const res = await fetch(`${API}/samples/export.xlsx?${params}`, { credentials: 'include' });
      if (!res.ok) { const e = await res.json().catch(() => ({})); throw new Error(e.detail || 'Error al exportar'); }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      // Nombre del archivo: usa el Content-Disposition o cae al default
      const cd = res.headers.get('Content-Disposition') || '';
      const m = /filename="?([^"]+)"?/.exec(cd);
      a.download = m ? m[1] : `ejemplos_${isoDate(new Date())}.xlsx`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      toast.success('Reporte descargado');
    } catch (e) { toast.error(e.message); }
    finally { setExporting(false); }
  };

  // ─── Segmentación del backlog por tab ────────────────────────────────────
  const backlogWithStyle = useMemo(() => backlog.filter(t => !t.no_style && (t.order?.style)), [backlog]);
  const backlogNoStyle   = useMemo(() => backlog.filter(t => t.no_style || !t.order?.style), [backlog]);
  const currentBacklog   = backlogTab === 'no_style' ? backlogNoStyle : backlogWithStyle;

  // ─── Métricas ─────────────────────────────────────────────────────────────
  const metrics = useMemo(() => ({
    total: tasks.length,
    hot: tasks.filter(t => t.is_hot).length,
    overdue: tasks.filter(t => t.overdue).length,
    backlog: backlog.length,
  }), [tasks, backlog]);

  // ─── Render ───────────────────────────────────────────────────────────────
  return (
    <div className="min-h-screen bg-background text-foreground">
      <div className="w-full px-4 py-4">
        {/* Header */}
        <div className="flex items-center gap-3 mb-4 flex-wrap">
          <button onClick={() => navigate('/home')} className="p-2 rounded-lg hover:bg-secondary/40"><ArrowLeft size={18} /></button>
          <div className="w-9 h-9 rounded-xl bg-indigo-500/15 flex items-center justify-center text-indigo-400"><Beaker size={19} /></div>
          <div>
            <h1 className="text-lg font-black uppercase tracking-widest">Calendario de Ejemplos</h1>
            <p className="text-xs text-muted-foreground">Programa muestras por día — recursos, operadores y alertas de vencimiento en vivo</p>
          </div>
          <div className="ml-auto flex items-center gap-1.5">
            {/* Exportar Excel — dropdown */}
            <div className="relative">
              <button onClick={() => setShowExportMenu(v => !v)} disabled={exporting}
                className="px-3 py-2 rounded-lg text-xs font-black uppercase tracking-widest border border-emerald-500/40 bg-emerald-500/10 text-emerald-500 hover:bg-emerald-500/20 flex items-center gap-1.5 disabled:opacity-40">
                {exporting ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} />}
                Excel <ChevronDown size={12} />
              </button>
              {showExportMenu && (
                <>
                  <div className="fixed inset-0 z-10" onClick={() => setShowExportMenu(false)} />
                  <div className="absolute right-0 top-full mt-1 w-64 bg-card border border-border rounded-xl shadow-xl z-20 p-1">
                    <div className="text-[9px] font-black uppercase tracking-widest text-muted-foreground px-2 py-1.5">Alcance</div>
                    <button onClick={() => exportXlsx('all', 'all')} className="w-full text-left px-3 py-2 text-xs hover:bg-secondary/50 rounded-lg flex items-center gap-2">
                      <Download size={13} className="text-emerald-500" />
                      <div>
                        <div className="font-black">Todos los ejemplos</div>
                        <div className="text-[10px] text-muted-foreground">Backlog + programados</div>
                      </div>
                    </button>
                    <button onClick={() => exportXlsx('scheduled', 'all')} className="w-full text-left px-3 py-2 text-xs hover:bg-secondary/50 rounded-lg flex items-center gap-2">
                      <CalendarDays size={13} className="text-indigo-400" />
                      <div>
                        <div className="font-black">Solo programados</div>
                        <div className="text-[10px] text-muted-foreground">Los que tienen fecha asignada</div>
                      </div>
                    </button>
                    <button onClick={() => exportXlsx('backlog', 'all')} className="w-full text-left px-3 py-2 text-xs hover:bg-secondary/50 rounded-lg flex items-center gap-2">
                      <Package size={13} className="text-amber-500" />
                      <div>
                        <div className="font-black">Solo backlog</div>
                        <div className="text-[10px] text-muted-foreground">Sin programar</div>
                      </div>
                    </button>
                    <div className="border-t border-border/60 my-1" />
                    <div className="text-[9px] font-black uppercase tracking-widest text-muted-foreground px-2 py-1.5">Por estilo</div>
                    <button onClick={() => exportXlsx('all', 'with_style')} className="w-full text-left px-3 py-2 text-xs hover:bg-secondary/50 rounded-lg">
                      <div className="font-black">Solo con estilo</div>
                    </button>
                    <button onClick={() => exportXlsx('all', 'no_style')} className="w-full text-left px-3 py-2 text-xs hover:bg-secondary/50 rounded-lg">
                      <div className="font-black">Solo sin estilo</div>
                    </button>
                  </div>
                </>
              )}
            </div>

            <button onClick={() => setShowAuto(true)}
              className="px-3 py-2 rounded-lg text-xs font-black uppercase tracking-widest bg-gradient-to-r from-indigo-500 to-violet-500 text-white shadow-sm hover:opacity-90 flex items-center gap-1.5">
              <Wand2 size={14} /> Auto-programar
            </button>
            <div className="flex items-center gap-0.5 bg-secondary/30 border border-border rounded-lg p-0.5">
              {[
                [Views.DAY, 'Día'],
                [Views.WEEK, 'Semana'],
                [Views.MONTH, 'Mes'],
                [Views.AGENDA, 'Lista'],
              ].map(([v, label]) => (
                <button key={v} onClick={() => setView(v)}
                  className={`px-2.5 py-1.5 rounded-md text-[11px] font-black uppercase tracking-widest transition-colors ${
                    view === v ? 'bg-indigo-500 text-white' : 'text-muted-foreground hover:text-foreground'
                  }`}>{label}</button>
              ))}
            </div>
            <div className="w-px h-6 bg-border mx-1" />
            <button onClick={() => shiftAnchor(-1)}
              className="p-2 rounded-lg border border-border hover:bg-secondary/40"><ChevronLeft size={16} /></button>
            <div className="px-3 py-2 rounded-lg border border-border text-xs font-bold min-w-[110px] text-center">
              {view === Views.MONTH
                ? format(anchor, 'MMMM yyyy', { locale: es })
                : view === Views.DAY
                  ? format(anchor, "d 'de' MMM", { locale: es })
                  : `${format(startOfWeek(anchor, { locale: es }), 'd MMM', { locale: es })} – ${format(addDays(startOfWeek(anchor, { locale: es }), 6), 'd MMM', { locale: es })}`}
            </div>
            <button onClick={() => setAnchor(new Date())} className="px-3 py-2 rounded-lg border border-border hover:bg-secondary/40 text-sm font-bold">Hoy</button>
            <button onClick={() => shiftAnchor(1)}
              className="p-2 rounded-lg border border-border hover:bg-secondary/40"><ChevronRight size={16} /></button>
            <button onClick={load} className="p-2 rounded-lg border border-border hover:bg-secondary/40"><RefreshCw size={16} /></button>
          </div>
        </div>

        {/* ── PESTAÑAS ────────────────────────────────────────────────────
            El ciclo de vida del ejemplo. La etapa la decide el backend y es
            EXCLUYENTE: la aprobación gana, así que un ejemplo aprobado vive en
            Aprobados aunque ya tenga número de orden. Uno recién creado CON
            número (todavía sin aprobar) entra directo a Ready to MOS. */}
        <div className="flex items-center gap-2 mb-4 flex-wrap">
          {STAGE_TABS.map(t => (
            <button
              key={t.key}
              onClick={() => setStage(t.key)}
              title={t.hint}
              className={`px-3 py-2 rounded-lg text-[11px] font-black uppercase tracking-widest border transition-colors flex items-center gap-2 ${
                stage === t.key
                  ? 'bg-indigo-500 text-white border-indigo-500'
                  : 'border-border text-muted-foreground hover:text-foreground hover:border-indigo-400/50'
              }`}
              data-testid={`sample-tab-${t.key}`}
            >
              {t.label}
              <span className={`px-1.5 py-0.5 rounded text-[10px] ${stage === t.key ? 'bg-white/20' : 'bg-secondary/60'}`}>
                {stageData.counts?.[t.key] ?? '—'}
              </span>
            </button>
          ))}
          {stageLoading && <Loader2 size={14} className="animate-spin text-indigo-400" />}
        </div>

        {stage === 'ejemplos' && (
          <div className="flex items-center gap-1.5 mb-3">
            {[['lista', 'Lista'], ['calendario', 'Calendario']].map(([v, label]) => (
              <button
                key={v}
                onClick={() => setEjemplosViewSaved(v)}
                className={`px-2.5 py-1.5 rounded-md text-[11px] font-black uppercase tracking-widest transition-colors ${
                  ejemplosView === v ? 'bg-indigo-500 text-white' : 'border border-border text-muted-foreground hover:text-foreground'
                }`}
                data-testid={`ejemplos-view-${v}`}
              >{label}</button>
            ))}
            <span className="text-[11px] text-muted-foreground ml-1">
              {ejemplosView === 'calendario'
                ? 'El calendario sólo muestra los del rango visible'
                : `Los ${stageData.counts?.ejemplos ?? 0} ejemplos de la etapa, sin importar su fecha`}
            </span>
          </div>
        )}

        {stage === 'ejemplos' && ejemplosView === 'lista' ? (
          <StageTable
            items={stageData.items}
            loading={stageLoading}
            stage={stage}
            onOpen={setDetail}
            onToggleFlag={toggleFlag}
            onApproval={async (task, v) => { await changeApproval(task, v); loadStage(stage); }}
          />
        ) : stage === 'ejemplos' ? (
          <>
        {/* Metrics */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
          <div className="bg-card/60 rounded-xl p-3"><div className="text-xs text-muted-foreground">Ejemplos en rango</div><div className="text-2xl font-black">{metrics.total}</div></div>
          <div className="bg-card/60 rounded-xl p-3"><div className="text-xs text-muted-foreground">Urgentes</div><div className="text-2xl font-black text-red-400">{metrics.hot}</div></div>
          <div className="bg-card/60 rounded-xl p-3"><div className="text-xs text-muted-foreground">Vencidos</div><div className="text-2xl font-black text-orange-500">{metrics.overdue}</div></div>
          <div className="bg-card/60 rounded-xl p-3"><div className="text-xs text-muted-foreground">Sin programar</div><div className="text-2xl font-black">{metrics.backlog}</div></div>
        </div>

        {/* Layout: calendar + backlog */}
        <div className="grid grid-cols-1 lg:grid-cols-[1fr_420px] gap-4">
          {/* Calendar */}
          <div className={`bg-card/40 rounded-2xl p-3 border relative h-[calc(100vh-260px)] min-h-[560px] transition-colors ${draggedTaskId ? 'border-indigo-400/60 ring-2 ring-indigo-400/30' : 'border-border/60'}`}
            onDragOver={(e) => e.preventDefault()}>
            {loading && <div className="absolute inset-0 z-10 flex items-center justify-center bg-background/60 rounded-2xl"><Loader2 className="w-8 h-8 animate-spin text-indigo-400" /></div>}
            <DnDCalendar
              localizer={localizer}
              events={events}
              defaultView={Views.WEEK}
              view={view}
              onView={setView}
              date={anchor}
              onNavigate={setAnchor}
              views={[Views.DAY, Views.WEEK, Views.MONTH, Views.AGENDA]}
              messages={{ day: 'Día', week: 'Semana', month: 'Mes', agenda: 'Lista', today: 'Hoy', previous: '<', next: '>', date: 'Fecha', time: 'Hora', event: 'Ejemplo', noEventsInRange: 'Sin ejemplos en el rango.' }}
              length={30}
              step={30}
              timeslots={2}
              min={new Date(2000, 0, 1, 8, 0)}
              max={new Date(2000, 0, 1, 20, 0)}
              toolbar={false}
              culture="es"
              components={{ event: EventCard }}
              eventPropGetter={eventStyleGetter}
              onSelectEvent={(evt) => setDetail(evt.task)}
              onSelectSlot={(slot) => {
                // Sin drag activo: crear PROV en ese día
                if (!draggedTaskId) setShowProv({ scheduled_date: isoDate(slot.start) });
              }}
              selectable
              draggableAccessor={() => true}
              resizable={false}
              onEventDrop={({ event, start }) => scheduleAt(event.id, isoDate(start))}
              onDropFromOutside={({ start }) => {
                if (draggedTaskId) {
                  scheduleAt(draggedTaskId, isoDate(start));
                  setDraggedTaskId(null);
                }
              }}
              dragFromOutsideItem={() => draggedTaskId ? { title: 'Ejemplo', start: new Date(), end: new Date() } : null}
              style={{ height: '100%' }}
            />
          </div>

          {/* Backlog / add panel */}
          <div className="bg-card/40 rounded-2xl p-3 border border-border/60 flex flex-col gap-3 h-[calc(100vh-260px)] min-h-[560px]">
            <div className="flex items-center justify-between px-1 flex-wrap gap-2">
              <div className="flex items-center gap-1 bg-secondary/40 rounded-lg p-0.5">
                <button onClick={() => setBacklogTab('with_style')}
                  className={`text-[10px] font-black uppercase tracking-widest px-2 py-1 rounded transition-colors ${
                    backlogTab === 'with_style' ? 'bg-indigo-500 text-white' : 'text-muted-foreground hover:text-foreground'
                  }`}>
                  Con estilo <span className="ml-1 opacity-70">{backlogWithStyle.length}</span>
                </button>
                <button onClick={() => setBacklogTab('no_style')}
                  className={`text-[10px] font-black uppercase tracking-widest px-2 py-1 rounded transition-colors ${
                    backlogTab === 'no_style' ? 'bg-amber-500 text-white' : 'text-muted-foreground hover:text-foreground'
                  }`}>
                  Sin estilo <span className="ml-1 opacity-70">{backlogNoStyle.length}</span>
                </button>
              </div>
              <button onClick={() => setShowProv({})} className="text-[10px] font-black uppercase tracking-wide px-2 py-1 rounded bg-amber-500/15 text-amber-400 hover:bg-amber-500/25 flex items-center gap-1"><Plus size={11} />PROV-</button>
            </div>

            {/* Búsqueda de orden real */}
            <div>
              <input value={addOrder} onChange={e => setAddOrder(e.target.value)}
                placeholder="Buscar orden (# / cliente / style)…"
                className="w-full bg-background border border-border rounded-lg px-2 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-indigo-400" />
              {addOrder.trim() && (
                <div className="flex flex-col gap-1 max-h-52 overflow-auto mt-2">
                  {results.length === 0 ? (
                    <div className="text-[11px] text-muted-foreground px-1 py-2">Sin resultados</div>
                  ) : results.map(o => (
                    <div key={o.order_id} className="flex items-center gap-2 px-2 py-1.5 rounded-lg border border-border/40">
                      <span className="font-mono font-bold text-xs">{o.order_number}</span>
                      <span className="text-[11px] text-muted-foreground truncate flex-1 min-w-0">{o.client}</span>
                      {o.in_samples
                        ? <span className="text-[10px] text-muted-foreground/70">En cola</span>
                        : <button disabled={busy} onClick={() => addByOrder(o.order_id)} className="p-1 rounded bg-indigo-500 text-white disabled:opacity-40"><Plus size={13} /></button>}
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Lista de backlog */}
            <div className="flex flex-col gap-1.5 overflow-y-auto flex-1 pr-1">
              <div className="text-[10px] text-muted-foreground/70 px-1 pb-1">
                {backlogTab === 'no_style'
                  ? 'Ejemplos sin estilo definido — programa igual o completa datos primero'
                  : 'Arrastra al calendario ➜ o usa los botones'}
              </div>
              {currentBacklog.length === 0 ? (
                <div className="text-[11px] text-muted-foreground px-1 py-6 text-center border border-dashed border-border/50 rounded-lg">
                  {backlogTab === 'no_style' ? 'No hay ejemplos sin estilo' : 'No hay ejemplos con estilo por programar'}
                </div>
              ) : currentBacklog.map(t => {
                const o = t.order || {};
                const bg = t.color_tag || (t.is_hot ? '#ef4444' : t.overdue ? '#f97316' : '#4f46e5');
                return (
                  <div key={t.sample_task_id} className="flex flex-col gap-1">
                    {/* Pill igual que en el calendario */}
                    <div
                      draggable
                      onDragStart={(e) => { setDraggedTaskId(t.sample_task_id); e.dataTransfer.effectAllowed = 'move'; try { e.dataTransfer.setData('text/plain', t.sample_task_id); } catch (_) {} }}
                      onDragEnd={() => setDraggedTaskId(null)}
                      onClick={() => setDetail(t)}
                      title={`${t.order_number} · ${o.client || ''} · ${o.style || ''} ${o.color || ''}`}
                      style={{ background: bg }}
                      className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded text-white text-xs font-mono font-black cursor-grab active:cursor-grabbing hover:opacity-90 overflow-hidden ${draggedTaskId === t.sample_task_id ? 'opacity-50' : ''}`}>
                      {t.is_hot && <Flame size={12} />}
                      {t.overdue && <AlertTriangle size={12} />}
                      <span className="truncate">{t.order_number}</span>
                      {t.is_provisional && <span className="text-[8px] font-black uppercase bg-white/25 px-1 rounded">P</span>}
                      {o.style && <span className="text-[10px] font-normal opacity-80 truncate">{o.style}</span>}
                      {o.color && <span className="text-[10px] font-normal opacity-70 truncate">· {o.color}</span>}
                      {o.cancel_date && <span className="ml-auto text-[9px] opacity-80">{fmtDate(o.cancel_date)}</span>}
                    </div>
                    {/* Acciones inline: Hoy · Mañana · Date-picker */}
                    <div className="flex items-center gap-1 px-1">
                      <button onClick={(e) => { e.stopPropagation(); scheduleAt(t.sample_task_id, todayIso()); }}
                        className="text-[9px] font-black uppercase tracking-wider px-1.5 py-0.5 rounded bg-indigo-500/15 text-indigo-400 hover:bg-indigo-500/25">Hoy</button>
                      <button onClick={(e) => { e.stopPropagation(); scheduleAt(t.sample_task_id, tomorrowIso()); }}
                        className="text-[9px] font-black uppercase tracking-wider px-1.5 py-0.5 rounded bg-secondary text-muted-foreground hover:bg-secondary/80">Mañana</button>
                      <input type="date" onClick={(e) => e.stopPropagation()}
                        onChange={(e) => { if (e.target.value) scheduleAt(t.sample_task_id, e.target.value); }}
                        className="text-[10px] bg-background border border-border rounded px-1 py-0.5 flex-1 min-w-0" />
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>

        {/* Legend */}
        <div className="flex items-center gap-3 mt-3 flex-wrap text-[11px] text-muted-foreground">
          <span className="flex items-center gap-1"><Shirt size={11} /> Playera</span>
          <span className="flex items-center gap-1"><Palette size={11} /> Arte</span>
          <span className="flex items-center gap-1"><Scissors size={11} /> Neck</span>
          <span className="flex items-center gap-1"><Layers size={11} /> Screens</span>
          <span className="flex items-center gap-1"><Droplet size={11} /> Tinta</span>
          <span className="ml-auto">Verde = listo · Rojo = falta · Gris = no aplica</span>
        </div>

          </>
        ) : (
          <StageTable
            items={stageData.items}
            loading={stageLoading}
            stage={stage}
            onOpen={setDetail}
            onToggleFlag={toggleFlag}
            onApproval={async (task, v) => { await changeApproval(task, v); loadStage(stage); }}
          />
        )}

        {/* Modal detalle */}
        {detail && (
          <DetailModal
            task={detail} operators={operators} statuses={statusesCatalog}
            onClose={() => setDetail(null)}
            onUpdate={(patch) => updateTask(detail.sample_task_id, patch)}
            onAssign={(opId) => assignOperator(detail.sample_task_id, opId)}
            onStatus={(s) => changeStatus(detail.sample_task_id, s)}
            onDelete={() => removeTask(detail)}
            onPromote={(num) => promoteProv(detail, num)}
            onToggleFlag={toggleFlag}
            onApproval={async (t, v) => { await changeApproval(t, v); loadStage(stage); }}
          />
        )}

        {/* Modal Auto-programar */}
        {showAuto && (
          <AutoScheduleModal
            api={api}
            onClose={() => setShowAuto(false)}
            onApplied={async () => { setShowAuto(false); await load(); }}
          />
        )}

        {/* Modal PROV- */}
        {showProv && (
          <ProvModal
            defaults={typeof showProv === 'object' ? showProv : {}}
            clients={clientsCatalog}
            priorities={prioritiesCatalog}
            onClose={() => setShowProv(false)}
            onCreate={createProvisional}
            busy={busy}
          />
        )}

        <Toaster position="bottom-right" theme={isDark ? 'dark' : 'light'} richColors />
      </div>
    </div>
  );
}

// ═════════════ DetailModal ══════════════════════════════════════════════════
// Tabla de las pestañas que NO son el calendario. Los palomeos se editan aquí
// mismo: en el piso se palomea de corrido sobre la lista, y obligar a abrir el
// detalle de cada ejemplo para marcar una casilla vuelve inservible la pantalla.
function StageTable({ items, loading, stage, onOpen, onToggleFlag, onApproval }) {
  if (loading && !items.length) {
    return <div className="py-16 flex justify-center"><Loader2 className="w-7 h-7 animate-spin text-indigo-400" /></div>;
  }
  if (!items.length) {
    return (
      <div className="py-16 text-center text-sm text-muted-foreground">
        {stage === 'aprobados'
          ? 'Ningún ejemplo aprobado sin número de orden.'
          : 'Ningún ejemplo con número de orden todavía.'}
      </div>
    );
  }
  return (
    <div className="border border-border rounded-2xl overflow-hidden bg-card/40">
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-secondary/40 border-b border-border">
              <th className="px-3 py-2.5 text-left text-[10px] font-black uppercase tracking-widest text-muted-foreground">Orden</th>
              <th className="px-3 py-2.5 text-left text-[10px] font-black uppercase tracking-widest text-muted-foreground">Cliente</th>
              <th className="px-3 py-2.5 text-left text-[10px] font-black uppercase tracking-widest text-muted-foreground">Style</th>
              <th className="px-3 py-2.5 text-left text-[10px] font-black uppercase tracking-widest text-muted-foreground">Color</th>
              {SAMPLE_FLAGS.map(f => (
                <th key={f.key} className="px-2 py-2.5 text-center text-[10px] font-black uppercase tracking-widest text-muted-foreground">{f.label}</th>
              ))}
              <th className="px-3 py-2.5 text-left text-[10px] font-black uppercase tracking-widest text-muted-foreground">Aprobado</th>
              <th className="px-3 py-2.5 text-right text-[10px] font-black uppercase tracking-widest text-muted-foreground">Detalle</th>
            </tr>
          </thead>
          <tbody>
            {items.map(t => {
              const o = t.order || {};
              return (
                <tr key={t.sample_task_id} className="border-b border-border/60 last:border-0 hover:bg-secondary/20">
                  <td className="px-3 py-2.5 font-mono font-black">
                    {t.order_number}
                    {t.is_provisional && <span className="ml-1.5 text-[9px] font-black uppercase bg-amber-500/20 text-amber-500 px-1 py-0.5 rounded">PROV</span>}
                  </td>
                  <td className="px-3 py-2.5 text-muted-foreground">{o.client || '—'}</td>
                  <td className="px-3 py-2.5">{o.style || '—'}</td>
                  <td className="px-3 py-2.5 text-muted-foreground">{o.color || '—'}</td>
                  {SAMPLE_FLAGS.map(f => (
                    <td key={f.key} className="px-2 py-2.5 text-center">
                      <input
                        type="checkbox"
                        checked={!!t.flags?.[f.key]}
                        onChange={(e) => onToggleFlag(t, f.key, e.target.checked)}
                        title={t.flags_meta?.[f.key]?.by_name
                          ? `${t.flags_meta[f.key].by_name} · ${new Date(t.flags_meta[f.key].at).toLocaleString()}`
                          : f.label}
                        className="w-4 h-4 rounded border-border accent-indigo-500"
                        data-testid={`flag-${f.key}-${t.order_number}`}
                      />
                    </td>
                  ))}
                  <td className="px-3 py-2.5">
                    <select
                      value={t.approval || 'RECIBIDO'}
                      onChange={(e) => onApproval(t, e.target.value)}
                      className="px-2 py-1 rounded-lg bg-background border border-border text-xs font-bold"
                      data-testid={`approval-${t.order_number}`}
                    >
                      <option value="RECIBIDO">Recibido</option>
                      <option value="APROBADO">Aprobado</option>
                    </select>
                  </td>
                  <td className="px-3 py-2.5 text-right">
                    <button onClick={() => onOpen(t)} className="px-2 py-1 rounded-lg border border-border text-xs font-bold hover:bg-secondary/40">
                      Abrir
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function DetailModal({ task, operators, statuses, onClose, onUpdate, onAssign, onStatus, onDelete, onPromote, onToggleFlag, onApproval }) {
  const o = task.order || {};
  const r = task.resources || {};
  const [promoteNum, setPromoteNum] = useState('');
  // Órdenes reales que podrían ser este ejemplo. Se piden al abrir el detalle
  // de un PROV: teclear el número a mano es justo el paso donde se equivocan y
  // se fusiona el ejemplo con la orden de otro cliente.
  const [matches, setMatches] = useState(null);
  const [matchesLoading, setMatchesLoading] = useState(false);
  useEffect(() => {
    if (!task.is_provisional) { setMatches(null); return; }
    let vivo = true;
    setMatchesLoading(true);
    fetch(`${API}/samples/tasks/${task.sample_task_id}/order-matches`, { credentials: 'include' })
      .then(r => (r.ok ? r.json() : null))
      .then(d => { if (vivo) setMatches(d); })
      .catch(() => {})
      .finally(() => { if (vivo) setMatchesLoading(false); });
    return () => { vivo = false; };
  }, [task.sample_task_id, task.is_provisional]);

  const jUrl = jobUrl(o.job_title_a);
  return (
    <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-card border border-border rounded-2xl w-full max-w-lg max-h-[90vh] overflow-y-auto p-5" onClick={e => e.stopPropagation()}>
        <div className="flex items-start justify-between mb-3">
          <div>
            <div className="flex items-center gap-2 flex-wrap">
              <h3 className="text-lg font-black uppercase tracking-widest font-mono">{task.order_number}</h3>
              {task.is_provisional && <span className="text-[10px] font-black uppercase bg-amber-500/20 text-amber-500 px-1.5 py-0.5 rounded">PROV</span>}
              {task.is_hot && <span className="text-[10px] font-black uppercase bg-red-500/20 text-red-400 px-1.5 py-0.5 rounded flex items-center gap-1"><Flame size={10} />HOT</span>}
              {task.overdue && <span className="text-[10px] font-black uppercase bg-orange-500/20 text-orange-500 px-1.5 py-0.5 rounded flex items-center gap-1"><AlertTriangle size={10} />Vencido</span>}
              {jUrl && <a href={jUrl} target="_blank" rel="noreferrer" className="text-indigo-400 hover:opacity-70"><ExternalLink size={14} /></a>}
            </div>
            <div className="text-xs text-muted-foreground mt-1">{o.client || '—'}{o.branding ? ` · ${o.branding}` : ''}{o.style ? ` · ${o.style}` : ''}</div>
          </div>
          <button onClick={onClose} className="p-1.5 rounded hover:bg-secondary/40"><X size={18} /></button>
        </div>

        {/* Avance del ejemplo — propio del ejemplo, NO son los campos de arte
            de la orden de producción (ver samples.py::SAMPLE_FLAGS). */}
        <div className="bg-secondary/30 rounded-xl p-3 mb-3">
          <div className="text-[10px] font-black uppercase tracking-widest text-muted-foreground mb-2">Avance del ejemplo</div>
          <div className="grid grid-cols-4 gap-2 mb-3">
            {SAMPLE_FLAGS.map(({ key, label, Icon }) => {
              const on = !!task.flags?.[key];
              const meta = task.flags_meta?.[key];
              return (
                <button
                  key={key}
                  onClick={() => onToggleFlag && onToggleFlag(task, key, !on)}
                  title={meta?.by_name ? `${meta.by_name} · ${new Date(meta.at).toLocaleString()}` : `Marcar ${label}`}
                  className={`p-2 rounded-lg border text-center transition-colors ${
                    on ? 'bg-emerald-500/15 border-emerald-500/40 text-emerald-500'
                       : 'bg-background border-border text-muted-foreground hover:border-indigo-400/50'
                  }`}
                  data-testid={`detail-flag-${key}`}
                >
                  <Icon size={15} className="mx-auto" />
                  <div className="text-[10px] font-black uppercase tracking-wider mt-1">{label}</div>
                  {on && <CheckCircle2 size={11} className="mx-auto mt-0.5" />}
                </button>
              );
            })}
          </div>
          <div className="flex items-center gap-2">
            <span className="text-[10px] font-black uppercase tracking-widest text-muted-foreground">Aprobado</span>
            <select
              value={task.approval || 'RECIBIDO'}
              onChange={(e) => onApproval && onApproval(task, e.target.value)}
              className="px-2 py-1 rounded-lg bg-background border border-border text-xs font-bold"
              data-testid="detail-approval"
            >
              <option value="RECIBIDO">Recibido</option>
              <option value="APROBADO">Aprobado</option>
            </select>
            {task.approved_by_name && (
              <span className="text-[11px] text-muted-foreground">
                por {task.approved_by_name}{task.approved_at ? ` · ${new Date(task.approved_at).toLocaleDateString()}` : ''}
              </span>
            )}
          </div>
        </div>

        {/* Recursos */}
        <div className="bg-secondary/30 rounded-xl p-3 mb-3">
          <div className="text-[10px] font-black uppercase tracking-widest text-muted-foreground mb-2">Recursos</div>
          <div className="grid grid-cols-5 gap-2 text-center">
            {[
              { key: 'blank_ok', label: 'Playera', icon: Shirt, extra: `${r.blank_on_hand||0}/${r.blank_needed||0}` },
              { key: 'art_ok', label: 'Arte', icon: Palette },
              { key: 'neck_ok', label: 'Neck', icon: Scissors },
              { key: 'screens_ok', label: 'Screens', icon: Layers },
              { key: 'paint_ok', label: 'Tinta', icon: Droplet, extra: r.paint_status },
            ].map(({ key, label, icon: Icon, extra }) => {
              const ok = r[key];
              const cls = ok === true ? 'text-emerald-500 bg-emerald-500/10 border-emerald-500/30'
                        : ok === false ? 'text-red-400 bg-red-500/10 border-red-500/30'
                        : 'text-muted-foreground bg-secondary/40 border-border';
              return (
                <div key={key} className={`border rounded-lg p-2 ${cls}`}>
                  <Icon size={16} className="mx-auto mb-1" />
                  <div className="text-[9px] font-black uppercase">{label}</div>
                  {extra && <div className="text-[9px] mt-0.5 opacity-80">{extra}</div>}
                </div>
              );
            })}
          </div>
          {o.cancel_date && (
            <div className="mt-3 flex items-center gap-2 text-[11px]">
              <CalendarDays size={12} className="text-muted-foreground" />
              <span className="text-muted-foreground">Cancel date:</span>
              <span className={`font-bold ${task.overdue ? 'text-orange-500' : 'text-foreground'}`}>{fmtDate(o.cancel_date)}</span>
            </div>
          )}
        </div>

        {/* Estatus */}
        <label className="text-[10px] font-black uppercase tracking-widest text-muted-foreground block mb-1">Estatus</label>
        <select value={task.status || ''} onChange={e => onStatus(e.target.value)}
          className="w-full bg-background border border-border rounded-lg px-2 py-2 text-sm mb-3">
          {statuses.map(s => <option key={s} value={s}>{s}</option>)}
        </select>

        {/* Operador */}
        <label className="text-[10px] font-black uppercase tracking-widest text-muted-foreground block mb-1">Operador de ejemplos</label>
        <select value={task.operator_id || ''} onChange={e => onAssign(e.target.value || null)}
          className="w-full bg-background border border-border rounded-lg px-2 py-2 text-sm mb-3">
          <option value="">Sin asignar</option>
          {operators.filter(op => op.active).map(op => <option key={op.operator_id} value={op.operator_id}>{op.name}</option>)}
        </select>
        {operators.length === 0 && (
          <div className="text-[10px] text-amber-500 -mt-2 mb-3">No hay operadores con rol "sample". Agrégales el rol en /operators-center.</div>
        )}

        {/* Día programado + color + notas */}
        <div className="grid grid-cols-2 gap-3 mb-3">
          <div>
            <label className="text-[10px] font-black uppercase tracking-widest text-muted-foreground block mb-1">Día</label>
            <input type="date" value={task.scheduled_date || ''}
              onChange={e => onUpdate({ scheduled_date: e.target.value || null })}
              className="w-full bg-background border border-border rounded-lg px-2 py-2 text-sm" />
          </div>
          <div>
            <label className="text-[10px] font-black uppercase tracking-widest text-muted-foreground block mb-1">Color</label>
            <input type="color" value={task.color_tag || '#6366f1'}
              onChange={e => onUpdate({ color_tag: e.target.value })}
              className="w-full h-9 bg-background border border-border rounded-lg cursor-pointer" />
          </div>
        </div>

        <label className="text-[10px] font-black uppercase tracking-widest text-muted-foreground block mb-1">Notas</label>
        <textarea value={task.notes || ''} rows={2} onBlur={e => onUpdate({ notes: e.target.value })}
          defaultValue={task.notes || ''}
          className="w-full bg-background border border-border rounded-lg px-2 py-2 text-sm mb-3" />

        {/* Promote PROV → orden real */}
        {task.is_provisional && (
          <div className="bg-amber-500/10 border border-amber-500/30 rounded-xl p-3 mb-3">
            <div className="text-[11px] font-black uppercase text-amber-400 mb-1 flex items-center gap-1"><Sparkles size={12} />Fusionar con orden real</div>
            <div className="text-[10px] text-muted-foreground mb-2">Cuando Printavo traiga el número real, escríbelo aquí y ambas se fusionarán en una sola orden. Lo trabajado en el ejemplo se conserva y llena los huecos del CRM.</div>

            {/* Candidatas cazadas por número de diseño. Al fusionar, el ejemplo
                pasa a apuntar a la orden real y su info del CRM (cliente,
                cantidad, fechas, prioridad) se une en vivo. */}
            {matchesLoading && (
              <div className="flex items-center gap-2 text-[11px] text-muted-foreground mb-2">
                <Loader2 size={12} className="animate-spin" /> Buscando órdenes con el mismo diseño…
              </div>
            )}
            {matches && !matchesLoading && (
              matches.matches?.length ? (
                <div className="mb-2 space-y-1.5">
                  <div className="text-[10px] font-black uppercase tracking-widest text-muted-foreground flex items-center gap-1">
                    <Search size={11} /> Diseño {matches.design} — {matches.matches.length} candidata(s)
                  </div>
                  {matches.matches.slice(0, 5).map(m => (
                    <div key={m.order_id} className="flex items-center gap-2 bg-background/60 border border-border rounded-lg px-2 py-1.5">
                      <div className="min-w-0 flex-1">
                        <div className="font-mono font-black text-xs">{m.order_number}</div>
                        <div className="text-[10px] text-muted-foreground truncate">
                          {m.client || '—'}{m.color ? ` · ${m.color}` : ''} · {(m.match_reasons || []).join(' · ')}
                        </div>
                      </div>
                      <button
                        onClick={() => onPromote(m.order_number)}
                        className="px-2 py-1 rounded-lg bg-amber-500 text-black font-black text-[10px] uppercase flex items-center gap-1 shrink-0"
                        data-testid={`match-${m.order_number}`}
                      ><Link2 size={11} /> Fusionar</button>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="text-[10px] text-muted-foreground mb-2">
                  {matches.hint || `Sin órdenes con el diseño ${matches.design || '—'}. Escribe el número a mano.`}
                </div>
              )
            )}

            <div className="flex gap-2">
              <input value={promoteNum} onChange={e => setPromoteNum(e.target.value)} placeholder="# de orden real"
                className="flex-1 bg-background border border-border rounded-lg px-2 py-1.5 text-sm" />
              <button disabled={!promoteNum.trim()} onClick={() => onPromote(promoteNum.trim())}
                className="px-3 py-1.5 rounded-lg bg-amber-500 text-black font-black text-xs uppercase disabled:opacity-40">Fusionar</button>
            </div>
          </div>
        )}

        <div className="flex justify-between items-center pt-2 border-t border-border">
          <button onClick={onDelete} className="text-xs font-black uppercase text-red-400 hover:text-red-300 flex items-center gap-1"><X size={13} /> Eliminar</button>
          <button onClick={onClose} className="px-4 py-2 rounded-lg bg-indigo-500 text-white font-black text-xs uppercase">Cerrar</button>
        </div>
      </div>
    </div>
  );
}

// ═════════════ ProvModal ════════════════════════════════════════════════════
function ProvModal({ defaults, clients = [], priorities = [], onClose, onCreate, busy }) {
  const [f, setF] = useState({
    order_number: '',       // opcional: si lo pones, NO se crea PROV-, se usa ese número real
    client: '', style: '', color: '', quantity: 0,
    priority: 'PRIORITY 2', cancel_date: '', scheduled_date: defaults.scheduled_date || '',
    notes: '',
  });
  const upd = (k, v) => setF({ ...f, [k]: v });
  const hasNumber = f.order_number.trim().length > 0;

  const submit = () => {
    if (!f.style.trim() || !f.client.trim()) {
      toast.error('Cliente y style son requeridos');
      return;
    }
    // El backend acepta order_number opcional: con → orden real, sin → PROV-nnnn
    const payload = { ...f };
    if (!payload.order_number.trim()) delete payload.order_number;
    onCreate(payload);
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-card border border-border rounded-2xl w-full max-w-md max-h-[90vh] overflow-y-auto p-5" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-black uppercase tracking-widest">
            {hasNumber ? 'Nuevo ejemplo' : 'Ejemplo provisional (PROV-)'}
          </h3>
          <button onClick={onClose} className="p-1.5 rounded hover:bg-secondary/40"><X size={18} /></button>
        </div>
        <div className="text-[11px] text-muted-foreground mb-4">
          {hasNumber
            ? <>Se creará una orden <b>{f.order_number.trim()}</b> con estos datos.</>
            : <>Sin número: se creará <b>PROV-nnnn</b> temporal que podrás fusionar con el número real después.</>}
        </div>

        {/* Número de orden (opcional) */}
        <div className="mb-3">
          <label className="text-[10px] font-black uppercase tracking-widest text-muted-foreground block mb-1">
            Número de orden <span className="text-muted-foreground/60 normal-case tracking-normal">(opcional)</span>
          </label>
          <input value={f.order_number} onChange={e => upd('order_number', e.target.value)}
            placeholder="Ej. 2145 · déjalo vacío para PROV-"
            className="w-full bg-background border border-border rounded-lg px-2 py-2 text-sm font-mono" />
        </div>

        {/* Cliente — dropdown del CRM */}
        <div className="mb-2.5">
          <label className="text-[10px] font-black uppercase tracking-widest text-muted-foreground block mb-1">Cliente *</label>
          <select value={f.client} onChange={e => upd('client', e.target.value)}
            className="w-full bg-background border border-border rounded-lg px-2 py-2 text-sm">
            <option value="">Selecciona un cliente…</option>
            {clients.map(c => <option key={c} value={c}>{c}</option>)}
          </select>
        </div>

        {[
          ['style', 'Style *', 'text'],
          ['color', 'Color', 'text'],
          ['quantity', 'Cantidad', 'number'],
          ['cancel_date', 'Cancel date', 'date'],
          ['scheduled_date', 'Día en calendario', 'date'],
        ].map(([k, label, type]) => (
          <div key={k} className="mb-2.5">
            <label className="text-[10px] font-black uppercase tracking-widest text-muted-foreground block mb-1">{label}</label>
            <input type={type} value={f[k]} onChange={e => upd(k, type === 'number' ? Number(e.target.value) : e.target.value)}
              className="w-full bg-background border border-border rounded-lg px-2 py-2 text-sm" />
          </div>
        ))}
        <div className="mb-2.5">
          <label className="text-[10px] font-black uppercase tracking-widest text-muted-foreground block mb-1">Prioridad</label>
          <select value={f.priority} onChange={e => upd('priority', e.target.value)}
            className="w-full bg-background border border-border rounded-lg px-2 py-2 text-sm">
            {(priorities.length ? priorities : ['RUSH','OVERSOLD','PRIORITY 1','PRIORITY 2','EVENT','SPECIAL RUSH']).map(p => <option key={p} value={p}>{p}</option>)}
          </select>
        </div>

        <div className="flex justify-end gap-2 mt-4">
          <button onClick={onClose} className="px-3 py-2 rounded-lg border border-border text-xs font-bold">Cancelar</button>
          <button disabled={busy} onClick={submit}
            className={`px-4 py-2 rounded-lg font-black text-xs uppercase disabled:opacity-40 flex items-center gap-2 ${
              hasNumber ? 'bg-indigo-500 text-white' : 'bg-amber-500 text-black'
            }`}>
            {busy && <Loader2 size={13} className="animate-spin" />}
            {hasNumber ? 'Crear ejemplo' : 'Crear PROV-'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ═════════════ AutoScheduleModal ════════════════════════════════════════════
function AutoScheduleModal({ api, onClose, onApplied }) {
  const [daysBefore, setDaysBefore] = useState(14);
  const [targetPerDay, setTargetPerDay] = useState(7);
  const [maxPerDay, setMaxPerDay] = useState(15);
  const [skipWeekends, setSkipWeekends] = useState(true);
  const [filter, setFilter] = useState('all');   // all | with_style | no_style
  const [includeScheduled, setIncludeScheduled] = useState(false);
  const [preview, setPreview] = useState(null);
  const [loading, setLoading] = useState(false);
  const [applying, setApplying] = useState(false);

  const payload = () => ({
    days_before: daysBefore, target_per_day: targetPerDay, max_per_day: maxPerDay,
    skip_weekends: skipWeekends, filter, include_scheduled: includeScheduled,
  });

  const runPreview = async () => {
    setLoading(true);
    try {
      const r = await api('POST', '/samples/auto-schedule', { ...payload(), apply: false });
      setPreview(r);
    } catch (e) { toast.error(e.message); }
    finally { setLoading(false); }
  };

  useEffect(() => { runPreview(); /* on mount */ }, []); // eslint-disable-line

  const apply = async () => {
    if (!preview || preview.scheduled_count === 0) return;
    setApplying(true);
    try {
      const r = await api('POST', '/samples/auto-schedule', { ...payload(), apply: true });
      toast.success(`${r.scheduled_count} ejemplos programados${r.over_cap_count ? ` (${r.over_cap_count} sobre capacidad)` : ''}`);
      onApplied();
    } catch (e) { toast.error(e.message); }
    finally { setApplying(false); }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-card border border-border rounded-2xl w-full max-w-3xl max-h-[90vh] overflow-hidden flex flex-col" onClick={e => e.stopPropagation()}>
        {/* Header */}
        <div className="p-5 border-b border-border flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="w-9 h-9 rounded-xl bg-indigo-500/15 flex items-center justify-center text-indigo-400">
              <Wand2 size={19} />
            </div>
            <div>
              <h3 className="text-sm font-black uppercase tracking-widest">Auto-programar ejemplos</h3>
              <p className="text-[11px] text-muted-foreground">Basado en su cancel date · N días de antelación</p>
            </div>
          </div>
          <button onClick={onClose} className="p-1.5 rounded hover:bg-secondary/40"><X size={18} /></button>
        </div>

        {/* Controles */}
        <div className="p-5 border-b border-border grid grid-cols-2 sm:grid-cols-3 gap-4">
          <div className="sm:col-span-3">
            <label className="text-[10px] font-black uppercase tracking-widest text-muted-foreground block mb-1">Días antes del cancel date</label>
            <div className="flex items-center gap-2">
              <input type="range" min="1" max="60" value={daysBefore} onChange={e => setDaysBefore(Number(e.target.value))} className="flex-1" />
              <input type="number" min="0" max="90" value={daysBefore} onChange={e => setDaysBefore(Number(e.target.value)||0)} className="w-14 bg-background border border-border rounded px-1.5 py-1 text-sm text-center font-mono font-black" />
            </div>
          </div>
          <div>
            <label className="text-[10px] font-black uppercase tracking-widest text-muted-foreground block mb-1">Target por día</label>
            <input type="number" min="1" max={maxPerDay} value={targetPerDay}
              onChange={e => setTargetPerDay(Math.min(maxPerDay, Math.max(1, Number(e.target.value)||1)))}
              className="w-full bg-background border border-border rounded-lg px-2 py-2 text-sm text-center font-mono font-black text-emerald-500" />
            <div className="text-[9px] text-muted-foreground mt-0.5 text-center">promedio ideal</div>
          </div>
          <div>
            <label className="text-[10px] font-black uppercase tracking-widest text-muted-foreground block mb-1">Máx por día</label>
            <input type="number" min={targetPerDay} max="100" value={maxPerDay}
              onChange={e => setMaxPerDay(Math.max(targetPerDay, Number(e.target.value)||1))}
              className="w-full bg-background border border-border rounded-lg px-2 py-2 text-sm text-center font-mono font-black text-red-400" />
            <div className="text-[9px] text-muted-foreground mt-0.5 text-center">cap duro (4 op.)</div>
          </div>
          <div>
            <label className="text-[10px] font-black uppercase tracking-widest text-muted-foreground block mb-1">Filtrar</label>
            <select value={filter} onChange={e => setFilter(e.target.value)}
              className="w-full bg-background border border-border rounded-lg px-2 py-2 text-sm">
              <option value="all">Todos</option>
              <option value="with_style">Solo con estilo</option>
              <option value="no_style">Solo sin estilo</option>
            </select>
          </div>
          <div>
            <label className="text-[10px] font-black uppercase tracking-widest text-muted-foreground block mb-1">Fines de semana</label>
            <label className="flex items-center gap-2 text-sm bg-background border border-border rounded-lg px-2 py-2 cursor-pointer">
              <input type="checkbox" checked={skipWeekends} onChange={e => setSkipWeekends(e.target.checked)} />
              <span>Mover a viernes</span>
            </label>
          </div>
          <div className="sm:col-span-2">
            <label className="text-[10px] font-black uppercase tracking-widest text-muted-foreground block mb-1">Alcance</label>
            <label className={`flex items-center gap-2 text-sm border rounded-lg px-2 py-2 cursor-pointer transition-colors ${includeScheduled ? 'bg-indigo-500/10 border-indigo-500/40 text-indigo-400' : 'bg-background border-border'}`}>
              <input type="checkbox" checked={includeScheduled} onChange={e => setIncludeScheduled(e.target.checked)} />
              <span><b>Incluir ya programados</b> — rebalancea todo el calendario, no solo el backlog</span>
            </label>
          </div>
          <div className="sm:col-span-3">
            <button onClick={runPreview} disabled={loading}
              className="w-full py-2 rounded-lg border border-border bg-secondary/40 text-xs font-black uppercase tracking-widest hover:bg-secondary/60 flex items-center justify-center gap-2">
              {loading ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />}
              Recalcular preview
            </button>
          </div>
        </div>

        {/* Preview */}
        <div className="flex-1 overflow-y-auto p-5">
          {!preview ? (
            <div className="text-center text-muted-foreground py-12"><Loader2 className="w-6 h-6 animate-spin mx-auto" /></div>
          ) : (
            <>
              <div className="grid grid-cols-2 sm:grid-cols-5 gap-2 mb-4">
                <div className="bg-secondary/30 rounded-xl p-3">
                  <div className="text-[10px] font-black uppercase text-muted-foreground">Backlog</div>
                  <div className="text-xl font-black font-mono">{preview.total_backlog}</div>
                </div>
                <div className="bg-emerald-500/10 rounded-xl p-3 border border-emerald-500/20">
                  <div className="text-[10px] font-black uppercase text-emerald-500">A programar</div>
                  <div className="text-xl font-black font-mono text-emerald-400">{preview.scheduled_count}</div>
                </div>
                <div className="bg-indigo-500/10 rounded-xl p-3 border border-indigo-500/20">
                  <div className="text-[10px] font-black uppercase text-indigo-400">Desplazados</div>
                  <div className="text-xl font-black font-mono text-indigo-400">{preview.shifted_count}</div>
                  <div className="text-[9px] text-muted-foreground">del ideal</div>
                </div>
                <div className={`rounded-xl p-3 border ${preview.over_cap_count ? 'bg-red-500/10 border-red-500/20' : 'bg-secondary/30 border-border'}`}>
                  <div className={`text-[10px] font-black uppercase ${preview.over_cap_count ? 'text-red-400' : 'text-muted-foreground'}`}>Sobre cap</div>
                  <div className={`text-xl font-black font-mono ${preview.over_cap_count ? 'text-red-400' : ''}`}>{preview.over_cap_count}</div>
                </div>
                <div className="bg-amber-500/10 rounded-xl p-3 border border-amber-500/20">
                  <div className="text-[10px] font-black uppercase text-amber-500">Omitidos</div>
                  <div className="text-xl font-black font-mono text-amber-400">{preview.skipped_count}</div>
                  <div className="text-[9px] text-muted-foreground">sin cancel</div>
                </div>
              </div>

              {/* Distribución por día — heatmap por carga */}
              {preview.by_day.length > 0 && (
                <div className="mb-4">
                  <div className="flex items-center gap-3 mb-2">
                    <div className="text-[10px] font-black uppercase tracking-widest text-muted-foreground">Carga por día</div>
                    <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
                      <span className="flex items-center gap-1"><span className="w-2 h-2 rounded bg-emerald-500/60" />≤ {preview.target_per_day}</span>
                      <span className="flex items-center gap-1"><span className="w-2 h-2 rounded bg-amber-500/60" />≤ {preview.max_per_day}</span>
                      <span className="flex items-center gap-1"><span className="w-2 h-2 rounded bg-red-500/60" />&gt; {preview.max_per_day}</span>
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-1">
                    {preview.by_day.map(d => {
                      const t = d.total;
                      const level = t <= preview.target_per_day
                        ? 'bg-emerald-500/15 text-emerald-500 border-emerald-500/30'
                        : t <= preview.max_per_day
                        ? 'bg-amber-500/15 text-amber-500 border-amber-500/30'
                        : 'bg-red-500/20 text-red-400 border-red-500/40';
                      return (
                        <span key={d.date} className={`text-[10px] font-mono border rounded px-1.5 py-1 ${level}`}
                          title={`Existentes: ${d.existing} · Nuevos: ${d.added} · Total: ${t}`}>
                          {d.date.slice(5)} <b className="ml-1">{t}</b>
                          {d.added > 0 && <span className="opacity-70 ml-0.5">(+{d.added})</span>}
                        </span>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* Lista detallada */}
              <div className="text-[10px] font-black uppercase tracking-widest text-muted-foreground mb-2">Detalle</div>
              <div className="border border-border rounded-lg overflow-hidden">
                <table className="w-full text-xs">
                  <thead className="bg-secondary/40 text-[10px] uppercase tracking-widest">
                    <tr>
                      <th className="text-left px-2 py-1.5">Orden</th>
                      <th className="text-left px-2 py-1.5">Cliente / Style</th>
                      <th className="text-left px-2 py-1.5">Cancel</th>
                      {includeScheduled && <th className="text-left px-2 py-1.5">Anterior</th>}
                      <th className="text-left px-2 py-1.5">Ideal</th>
                      <th className="text-left px-2 py-1.5">→ Nueva</th>
                      <th className="text-right px-2 py-1.5">Shift</th>
                      <th className="text-right px-2 py-1.5">Holgura</th>
                      {includeScheduled && <th className="text-center px-2 py-1.5">Estado</th>}
                    </tr>
                  </thead>
                  <tbody>
                    {preview.scheduled.slice(0, 200).map(r => (
                      <tr key={r.sample_task_id} className={`border-t border-border/60 ${r.over_cap ? 'bg-red-500/5' : r.moved ? 'bg-indigo-500/5' : ''}`}>
                        <td className="px-2 py-1 font-mono font-bold">
                          {r.order_number}
                          {r.is_hot && <Flame size={10} className="inline ml-1 text-red-400" />}
                          {r.over_cap && <AlertTriangle size={10} className="inline ml-1 text-red-400" />}
                        </td>
                        <td className="px-2 py-1 truncate max-w-[180px]">
                          <div className="truncate">{r.client}</div>
                          <div className="text-[10px] text-muted-foreground truncate">{r.style || '—'}</div>
                        </td>
                        <td className="px-2 py-1 font-mono text-muted-foreground">{r.cancel_date}</td>
                        {includeScheduled && (
                          <td className="px-2 py-1 font-mono text-muted-foreground/70">{r.previous_date || '—'}</td>
                        )}
                        <td className="px-2 py-1 font-mono text-muted-foreground/70">{r.ideal_date}</td>
                        <td className={`px-2 py-1 font-mono font-bold ${r.over_cap ? 'text-red-400' : 'text-indigo-400'}`}>{r.scheduled_date}</td>
                        <td className={`px-2 py-1 text-right font-mono text-[10px] ${r.shift_days === 0 ? 'text-muted-foreground/40' : r.shift_days < 0 ? 'text-indigo-400' : 'text-amber-400'}`}>
                          {r.shift_days === 0 ? '·' : `${r.shift_days > 0 ? '+' : ''}${r.shift_days}d`}
                        </td>
                        <td className={`px-2 py-1 text-right font-mono ${r.holgura_dias < 3 ? 'text-red-400' : r.holgura_dias < 7 ? 'text-amber-400' : 'text-emerald-500'}`}>
                          {r.holgura_dias}d
                        </td>
                        {includeScheduled && (
                          <td className="px-2 py-1 text-center">
                            {r.moved
                              ? <span className="text-[9px] font-black uppercase bg-indigo-500/20 text-indigo-400 px-1.5 py-0.5 rounded">movido</span>
                              : r.kept
                                ? <span className="text-[9px] font-black uppercase bg-emerald-500/15 text-emerald-500 px-1.5 py-0.5 rounded">se mantiene</span>
                                : <span className="text-[9px] font-black uppercase bg-amber-500/15 text-amber-500 px-1.5 py-0.5 rounded">nuevo</span>}
                          </td>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
                {preview.scheduled.length > 200 && (
                  <div className="text-[10px] text-muted-foreground text-center py-2 border-t border-border/60">
                    ... y {preview.scheduled.length - 200} más
                  </div>
                )}
              </div>

              {preview.skipped_count > 0 && (
                <div className="mt-3 text-[11px] text-amber-400">
                  <b>{preview.skipped_count}</b> tasks omitidos porque su orden no tiene cancel_date.
                </div>
              )}
            </>
          )}
        </div>

        {/* Footer */}
        <div className="p-4 border-t border-border flex items-center justify-between gap-3 bg-secondary/20">
          <div className="text-[10px] text-muted-foreground">
            {!preview ? 'Cargando preview…' : (
              includeScheduled
                ? `${preview.moved_count} se moverán · ${preview.kept_count} se mantienen. HOT si holgura < 3 días.`
                : `Se programarán ${preview.scheduled_count} ejemplos. HOT si holgura < 3 días.`
            )}
          </div>
          <div className="flex gap-2">
            <button onClick={onClose} className="px-3 py-2 rounded-lg border border-border text-xs font-bold">Cancelar</button>
            <button
              onClick={apply}
              disabled={applying || !preview || preview.scheduled_count === 0}
              className="px-4 py-2 rounded-lg bg-indigo-500 text-white font-black text-xs uppercase disabled:opacity-40 flex items-center gap-2">
              {applying && <Loader2 size={13} className="animate-spin" />}
              <Zap size={13} /> Aplicar programación
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
