import React, { useState, useEffect, useCallback } from 'react';
import { Brush, ArrowLeft, ChevronLeft, ChevronRight, Loader2, Plus, X, Flame, RefreshCw, CalendarDays, Beaker, Package, ExternalLink, GripVertical } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { API } from '../lib/constants';
import PaintRecipes from './PaintRecipes';
import PaintInventory from './PaintInventory';
import { Toaster } from './ui/sonner';

const BUILD = 'v3-asa';   // marcador visible para confirmar el deploy desde la Mac

const INK = {
  pendiente: { label: 'Pendiente', bar: '#888780', pill: 'bg-secondary text-muted-foreground' },
  mezclando: { label: 'Mezclando', bar: '#BA7517', pill: 'bg-amber-500/15 text-amber-500' },
  lista:     { label: 'Lista',     bar: '#639922', pill: 'bg-emerald-500/15 text-emerald-500' },
};
const DAY_NAMES = ['Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];

const isoToLabel = (iso, i) => {
  const d = new Date(`${iso}T00:00:00`);
  return `${DAY_NAMES[i] || ''} ${d.getDate()}`;
};
const fmtDate = (iso) => (iso ? new Date(`${iso}T00:00:00`).toLocaleDateString('es-MX', { day: '2-digit', month: 'short' }) : '');
// job_title_a puede ser {url,desc} o string; devuelve la URL de Printavo si hay.
const jobUrl = (v) => {
  if (!v) return '';
  const u = typeof v === 'object' ? (v.url || '') : String(v);
  return /^https?:\/\//i.test(u) ? u : '';
};

export default function PaintModule() {
  const navigate = useNavigate();
  const [weekRef, setWeekRef] = useState(() => new Date().toISOString().slice(0, 10));
  const [board, setBoard] = useState(null);
  const [backlog, setBacklog] = useState([]);
  const [suggested, setSuggested] = useState([]);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState('board');
  const [addOrder, setAddOrder] = useState('');
  const [dragId, setDragId] = useState(null);
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState([]);
  const [pickerTask, setPickerTask] = useState(null);
  const [recipeQ, setRecipeQ] = useState('');
  const [recipeOpts, setRecipeOpts] = useState([]);

  // Recetas para el picker de la tarjeta.
  useEffect(() => {
    if (!pickerTask) return;
    const id = setTimeout(async () => {
      try {
        const r = await fetch(`${API}/paint/recipes?q=${encodeURIComponent(recipeQ)}`, { credentials: 'include' }).then(r => r.json());
        setRecipeOpts(r.recipes || []);
      } catch { setRecipeOpts([]); }
    }, 200);
    return () => clearTimeout(id);
  }, [pickerTask, recipeQ]);

  // Búsqueda en vivo de cualquier orden (muestra si ya tiene arte).
  useEffect(() => {
    const q = addOrder.trim();
    if (!q) { setResults([]); return; }
    const id = setTimeout(async () => {
      try {
        const r = await fetch(`${API}/paint/search?q=${encodeURIComponent(q)}`, { credentials: 'include' }).then(r => r.json());
        setResults(r.results || []);
      } catch { setResults([]); }
    }, 250);
    return () => clearTimeout(id);
  }, [addOrder]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [b, bl] = await Promise.all([
        fetch(`${API}/paint/board?week=${weekRef}`, { credentials: 'include' }).then(r => r.json()),
        fetch(`${API}/paint/backlog`, { credentials: 'include' }).then(r => r.json()),
      ]);
      setBoard(b); setBacklog(bl.backlog || []); setSuggested(bl.suggested || []);
    } catch { toast.error('Error al cargar el tablero'); }
    finally { setLoading(false); }
  }, [weekRef]);
  useEffect(() => { load(); }, [load]);

  const shiftWeek = (days) => {
    const d = new Date(`${weekRef}T00:00:00`); d.setDate(d.getDate() + days);
    setWeekRef(d.toISOString().slice(0, 10));
  };

  // Todas las tarjetas por día (incluye backlog como date=null) desde el estado actual.
  const listFor = (date) => {
    if (date == null) return backlog;
    return board?.days?.find(d => d.date === date)?.tasks || [];
  };
  const dayOptions = (board?.days || []).map((d, i) => ({ date: d.date, label: isoToLabel(d.date, i) }));

  const api = async (method, path, body) => {
    const res = await fetch(`${API}${path}`, {
      method, credentials: 'include',
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) { const e = await res.json().catch(() => ({})); throw new Error(e.detail || 'Error'); }
    return res.json().catch(() => ({}));
  };

  const addByNumber = async (order_number, order_id) => {
    try {
      setBusy(true);
      await api('POST', '/paint/tasks', order_id ? { order_id } : { order_number });
      setAddOrder(''); await load();
      toast.success('Orden agregada a pinturas');
    } catch (e) { toast.error(e.message); } finally { setBusy(false); }
  };

  const moveTask = async (taskId, targetDate, beforeTaskId) => {
    if (!taskId) return;
    const target = [...listFor(targetDate)].filter(t => t.paint_task_id !== taskId);
    const allTasks = (board?.days || []).reduce((a, d) => a.concat(d.tasks || []), backlog.slice());
    const dragged = allTasks.find(t => t.paint_task_id === taskId);
    if (!dragged) return;
    const idx = beforeTaskId ? target.findIndex(t => t.paint_task_id === beforeTaskId) : target.length;
    target.splice(idx < 0 ? target.length : idx, 0, dragged);
    try {
      await api('POST', '/paint/reorder', { date: targetDate, ordered_ids: target.map(t => t.paint_task_id) });
      await load();
      toast.success(targetDate ? 'Orden reprogramada' : 'Movida a sin programar');
    } catch (e) { toast.error(e.message || 'No se pudo mover'); }
  };

  const setStatus = async (t, value) => {
    if (!value || value === t.ink_status) return;
    try {
      const res = await api('PUT', `/paint/tasks/${t.paint_task_id}/status`, { ink_status: value });
      const c = res?.consumption;
      if (c && (c.deducted?.length || c.missing?.length)) {
        const d = c.deducted?.length ? `Descontado: ${c.deducted.map(x => `${x.name} (${x.qty}${x.unit || ''})`).join(', ')}` : '';
        const m = c.missing?.length ? ` · Sin match en inventario: ${c.missing.join(', ')}` : '';
        toast.success(`Tinta lista.${d ? ' ' + d : ''}${m}`);
      } else {
        toast.success(`Estatus: ${value}`);
      }
      await load();
    } catch (e) { toast.error(e.message || 'No se pudo cambiar el estatus'); }
  };
  const openPicker = (t) => { setRecipeQ(''); setRecipeOpts([]); setPickerTask(t); };
  const linkRecipe = async (rid) => {
    if (!pickerTask) return;
    try {
      await api('PUT', `/paint/tasks/${pickerTask.paint_task_id}`, { recipe_id: rid });
      setPickerTask(null); await load();
      toast.success(rid ? 'Receta ligada' : 'Receta quitada');
    } catch (e) { toast.error(e.message); }
  };
  const toggleHot = async (t) => {
    try { await api('PUT', `/paint/tasks/${t.paint_task_id}`, { is_hot: !t.is_hot }); await load(); toast.success(!t.is_hot ? 'Marcada urgente' : 'Urgente quitado'); }
    catch (e) { toast.error(e.message || 'No se pudo actualizar'); }
  };
  const remove = async (t) => {
    if (!window.confirm(`¿Quitar la orden ${t.order_number} de pinturas?`)) return;
    try { await api('DELETE', `/paint/tasks/${t.paint_task_id}`); await load(); }
    catch (e) { toast.error(e.message); }
  };

  const Card = (t) => {
    const o = t.order || {};
    const ink = INK[t.ink_status] || INK.pendiente;
    const colors = (t.colors && t.colors.length ? t.colors.map(c => c.name || c) : (o.color ? [o.color] : []));
    return (
      <div key={t.paint_task_id}
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => { e.preventDefault(); e.stopPropagation(); moveTask(dragId, t.scheduled_date ?? null, t.paint_task_id); setDragId(null); }}
        className="flex overflow-hidden rounded-xl border border-border bg-card/70 hover:border-primary/40 transition-colors">
        <div style={{ width: 4, background: t.is_hot ? '#E24B4A' : ink.bar }} />
        <div className="flex-1 min-w-0 p-2">
          <div className="flex items-center gap-1.5">
            <span draggable onDragStart={(e) => { setDragId(t.paint_task_id); e.dataTransfer.effectAllowed = 'move'; try { e.dataTransfer.setData('text/plain', t.paint_task_id); } catch (_) {} }}
              title="Arrastrar" className="cursor-grab active:cursor-grabbing text-muted-foreground/40 hover:text-muted-foreground -ml-0.5 shrink-0"><GripVertical size={13} /></span>
            <span className="font-mono font-black text-sm text-foreground">{t.order_number}</span>
            {jobUrl(o.job_title_a) && (
              <a href={jobUrl(o.job_title_a)} target="_blank" rel="noreferrer" onClick={e => e.stopPropagation()}
                title="Abrir en Printavo" className="text-primary hover:opacity-70"><ExternalLink size={12} /></a>
            )}
            {t.is_hot && <span className="ml-auto text-[9px] font-black uppercase tracking-wide bg-red-500/15 text-red-400 px-1.5 py-0.5 rounded-full">HOT</span>}
          </div>
          <div className="text-[11px] text-muted-foreground truncate mt-0.5">{o.client || '—'}{o.branding ? ` · ${o.branding}` : ''}</div>
          <div className="flex items-center gap-1.5 mt-1.5 flex-wrap">
            {colors.slice(0, 4).map((c, i) => (
              <span key={i} className="text-[9px] font-bold uppercase bg-secondary/60 text-foreground/80 px-1.5 py-0.5 rounded">{c}</span>
            ))}
            {o.quantity != null && <span className="text-[10px] text-muted-foreground">{o.quantity} pz</span>}
          </div>
          <div className="flex items-center gap-1.5 mt-1.5">
            <select value={t.ink_status} onChange={e => setStatus(t, e.target.value)} onClick={e => e.stopPropagation()} onMouseDown={e => e.stopPropagation()}
              title="Estatus de tinta"
              className={`text-[10px] font-black uppercase tracking-wide pl-2 pr-1 py-0.5 rounded-full border-0 appearance-none cursor-pointer ${ink.pill}`}>
              <option value="pendiente">Pendiente</option>
              <option value="mezclando">Mezclando</option>
              <option value="lista">Lista</option>
            </select>
            {o.due_date && <span className="text-[10px] text-muted-foreground">Entrega {fmtDate(o.due_date)}</span>}
            <div className="ml-auto flex items-center gap-1">
              <button onClick={() => toggleHot(t)} onMouseDown={e => e.stopPropagation()} title="Marcar urgente" className={`p-1 rounded ${t.is_hot ? 'text-red-400' : 'text-muted-foreground/50 hover:text-red-400'}`}><Flame size={13} /></button>
              <button onClick={() => remove(t)} onMouseDown={e => e.stopPropagation()} title="Quitar" className="p-1 rounded text-muted-foreground/50 hover:text-red-400"><X size={13} /></button>
            </div>
          </div>
          <div className="mt-1.5 flex items-center gap-2">
            {t.recipe
              ? <button onClick={() => openPicker(t)} onMouseDown={e => e.stopPropagation()} title="Cambiar receta" className="inline-flex items-center gap-1 text-[10px] font-bold bg-primary/10 text-primary px-1.5 py-0.5 rounded"><Beaker size={11} /> {t.recipe.color_name}</button>
              : <button onClick={() => openPicker(t)} onMouseDown={e => e.stopPropagation()} className="inline-flex items-center gap-1 text-[10px] text-muted-foreground hover:text-primary"><Plus size={11} /> ligar receta</button>}
            <select value={t.scheduled_date || ''} onChange={e => moveTask(t.paint_task_id, e.target.value || null, null)} onClick={e => e.stopPropagation()} onMouseDown={e => e.stopPropagation()}
              title="Programar en un día" className="ml-auto text-[10px] bg-secondary/50 border border-border rounded px-1.5 py-0.5 cursor-pointer max-w-[96px]">
              <option value="">Sin programar</option>
              {dayOptions.map(d => <option key={d.date} value={d.date}>{d.label}</option>)}
            </select>
          </div>
        </div>
      </div>
    );
  };

  const Column = ({ date, tasks, label, isBacklog }) => (
    <div key={date || 'backlog'}
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => { e.preventDefault(); moveTask(dragId, isBacklog ? null : date, null); setDragId(null); }}
      className={`flex flex-col min-w-0 ${isBacklog ? 'w-56 shrink-0 bg-secondary/20 rounded-2xl p-2' : 'flex-1'}`}>
      <div className="flex items-center justify-between px-1 mb-2">
        <span className="text-xs font-black uppercase tracking-wider text-foreground">{label}</span>
        <span className="text-[11px] text-muted-foreground">{tasks.length}</span>
      </div>
      <div className="flex flex-col gap-1.5 min-h-[80px]">
        {tasks.map(t => Card(t))}
      </div>
      {isBacklog && (
        <div className="mt-3 space-y-2">
          <input value={addOrder} onChange={e => setAddOrder(e.target.value)}
            placeholder="Buscar orden (# o cliente)…"
            className="w-full bg-background border border-border rounded-lg px-2 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-primary" />

          {addOrder.trim() ? (
            <div className="flex flex-col gap-1 max-h-72 overflow-auto">
              {results.length === 0 ? (
                <div className="text-[11px] text-muted-foreground px-1 py-2">Sin resultados</div>
              ) : results.map(o => (
                <div key={o.order_id} className="flex items-center gap-2 px-2 py-1.5 rounded-lg border border-border/40">
                  <span className="font-mono font-bold text-xs">{o.order_number}</span>
                  <span className="text-[11px] text-muted-foreground truncate flex-1 min-w-0">{o.client}</span>
                  {o.has_art
                    ? <span className="text-[9px] font-black uppercase bg-emerald-500/15 text-emerald-500 px-1.5 py-0.5 rounded shrink-0">Con arte</span>
                    : <span className="text-[9px] font-black uppercase bg-amber-500/15 text-amber-500 px-1.5 py-0.5 rounded shrink-0">Sin arte</span>}
                  {o.in_paint
                    ? <span className="text-[10px] text-muted-foreground/70 shrink-0">En cola</span>
                    : <button onClick={() => addByNumber(null, o.order_id)} disabled={busy}
                        className="p-1 rounded bg-primary text-black disabled:opacity-40 shrink-0"><Plus size={13} /></button>}
                </div>
              ))}
            </div>
          ) : suggested.length > 0 && (
            <div>
              <div className="text-[10px] uppercase font-black tracking-widest text-muted-foreground/70 mb-1 mt-2">Sugeridas (arte listo)</div>
              <div className="flex flex-col gap-1 max-h-64 overflow-auto">
                {suggested.map(o => (
                  <button key={o.order_id} onClick={() => addByNumber(null, o.order_id)}
                    className="flex items-center gap-2 text-left px-2 py-1.5 rounded-lg border border-border/40 hover:border-primary/40 hover:bg-secondary/30">
                    <Plus size={12} className="text-primary shrink-0" />
                    <span className="font-mono font-bold text-xs">{o.order_number}</span>
                    <span className="text-[11px] text-muted-foreground truncate">{o.client}</span>
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );

  return (
    <div className="min-h-screen bg-background text-foreground">
      <div className="max-w-[1400px] mx-auto px-4 py-4">
        {/* Header */}
        <div className="flex items-center gap-3 mb-4 flex-wrap">
          <button onClick={() => navigate('/dashboard')} className="p-2 rounded-lg hover:bg-secondary/40"><ArrowLeft size={18} /></button>
          <div className="w-9 h-9 rounded-xl bg-primary/15 flex items-center justify-center text-primary"><Brush size={19} /></div>
          <div>
            <h1 className="text-lg font-black uppercase tracking-widest flex items-center gap-2">Departamento de Pinturas
              <span className="text-[9px] font-bold bg-primary/15 text-primary px-1.5 py-0.5 rounded-full normal-case tracking-normal">{BUILD}</span></h1>
            <p className="text-xs text-muted-foreground">Calendarización de mezcla de tinta — arrastra las órdenes por día y prioridad</p>
          </div>
          <div className="ml-auto flex items-center gap-1.5">
            <button onClick={() => shiftWeek(-7)} className="p-2 rounded-lg border border-border hover:bg-secondary/40"><ChevronLeft size={16} /></button>
            <button onClick={() => setWeekRef(new Date().toISOString().slice(0, 10))} className="px-3 py-2 rounded-lg border border-border hover:bg-secondary/40 text-sm font-bold">Hoy</button>
            <button onClick={() => shiftWeek(7)} className="p-2 rounded-lg border border-border hover:bg-secondary/40"><ChevronRight size={16} /></button>
            <button onClick={load} className="p-2 rounded-lg border border-border hover:bg-secondary/40"><RefreshCw size={16} /></button>
          </div>
        </div>

        {/* Tabs */}
        <div className="flex items-center gap-1 mb-4 border-b border-border">
          {[['board', 'Calendario', CalendarDays], ['recipes', 'Recetas', Beaker], ['inventory', 'Inventario', Package]].map(([id, label, Icon]) => (
            <button key={id} onClick={() => setTab(id)}
              className={`flex items-center gap-1.5 px-4 py-2 text-sm font-bold border-b-2 -mb-px ${tab === id ? 'border-primary text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground'}`}>
              <Icon size={15} /> {label}
            </button>
          ))}
        </div>

        {tab === 'recipes' && <PaintRecipes />}
        {tab === 'inventory' && <PaintInventory />}

        {tab === 'board' && (<>
        {/* Metrics */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
          <div className="bg-card/60 rounded-xl p-3"><div className="text-xs text-muted-foreground">Órdenes semana</div><div className="text-2xl font-black">{board?.total ?? 0}</div></div>
          <div className="bg-card/60 rounded-xl p-3"><div className="text-xs text-muted-foreground">Urgentes (HOT)</div><div className="text-2xl font-black text-red-400">{board?.hot_count ?? 0}</div></div>
          <div className="bg-card/60 rounded-xl p-3"><div className="text-xs text-muted-foreground">Tinta lista</div><div className="text-2xl font-black text-emerald-500">{board?.ready_count ?? 0}</div></div>
          <div className="bg-card/60 rounded-xl p-3"><div className="text-xs text-muted-foreground">Sin programar</div><div className="text-2xl font-black">{backlog.length}</div></div>
        </div>

        {loading ? (
          <div className="flex items-center justify-center py-24"><Loader2 className="w-8 h-8 animate-spin text-primary" /></div>
        ) : (
          <div className="flex gap-3 items-start overflow-x-auto pb-4">
            {Column({ isBacklog: true, date: null, label: 'Sin programar', tasks: backlog })}
            {(board?.days || []).map((d, i) => Column({ date: d.date, label: isoToLabel(d.date, i), tasks: d.tasks }))}
          </div>
        )}

        {/* Legend */}
        <div className="flex items-center gap-4 mt-3 flex-wrap text-[11px] text-muted-foreground">
          <span className="flex items-center gap-1.5"><span style={{ width: 10, height: 10, borderRadius: 3, background: '#888780' }} />Pendiente</span>
          <span className="flex items-center gap-1.5"><span style={{ width: 10, height: 10, borderRadius: 3, background: '#BA7517' }} />Mezclando</span>
          <span className="flex items-center gap-1.5"><span style={{ width: 10, height: 10, borderRadius: 3, background: '#639922' }} />Tinta lista</span>
          <span className="flex items-center gap-1.5"><span style={{ width: 10, height: 10, borderRadius: 3, background: '#E24B4A' }} />HOT / urgente</span>
          <span className="ml-auto">Clic en el estatus para avanzar · arrastra para reordenar o mover de día</span>
        </div>
        </>)}

        {pickerTask && (
          <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4" onClick={() => setPickerTask(null)}>
            <div className="bg-card border border-border rounded-2xl w-full max-w-md max-h-[80vh] overflow-auto p-5" onClick={e => e.stopPropagation()}>
              <div className="flex items-center justify-between mb-3">
                <h3 className="font-black uppercase tracking-widest text-sm">Receta · orden {pickerTask.order_number}</h3>
                <button onClick={() => setPickerTask(null)} className="p-1.5 rounded hover:bg-secondary/40"><X size={18} /></button>
              </div>
              <input value={recipeQ} onChange={e => setRecipeQ(e.target.value)} placeholder="Buscar receta (color / pantone)…"
                className="w-full bg-background border border-border rounded-lg px-3 py-2 text-sm mb-3" />
              <div className="flex flex-col gap-1 max-h-72 overflow-auto">
                {recipeOpts.length === 0 ? (
                  <div className="text-[12px] text-muted-foreground px-1 py-3">Sin recetas. Créalas en la pestaña <b>Recetas</b>.</div>
                ) : recipeOpts.map(r => (
                  <button key={r.recipe_id} onClick={() => linkRecipe(r.recipe_id)}
                    className={`flex items-center gap-2 text-left px-2 py-1.5 rounded-lg border ${pickerTask.recipe_id === r.recipe_id ? 'border-primary bg-primary/10' : 'border-border/40 hover:border-primary/40'}`}>
                    <Beaker size={13} className="text-primary shrink-0" />
                    <span className="font-bold text-xs">{r.color_name}</span>
                    <span className="text-[11px] text-muted-foreground truncate">{r.pantone ? `Pantone ${r.pantone}` : r.ink_type}</span>
                    <span className="ml-auto text-[10px] text-muted-foreground">{r.total_volume || 0} {r.unit || 'g'}</span>
                  </button>
                ))}
              </div>
              {pickerTask.recipe_id && (
                <button onClick={() => linkRecipe(null)} className="mt-3 text-xs text-red-400 font-bold">Quitar receta ligada</button>
              )}
            </div>
          </div>
        )}

        <Toaster position="bottom-right" theme="dark" richColors />
      </div>
    </div>
  );
}
