import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, Activity, RefreshCw, Copy, Settings2, Plus, X, Loader2, Clock } from 'lucide-react';
import { toast } from 'sonner';
import { API } from '../lib/constants';
import { useLang } from '../contexts/LanguageContext';
import { Toaster } from './ui/sonner';

// Estado de máquinas en vivo (backend routers/machine_status.py): reemplaza el
// "Recap de impresión" que se manda a mano por WhatsApp. Sin consultas por
// tiempo: recarga sólo cuando el WebSocket avisa `machine_status` (o un cambio
// de orden); el "hace X min" se recalcula en el navegador.

const WS_URL = `${process.env.REACT_APP_BACKEND_URL || 'http://localhost:8000'}`.replace(/^http/, 'ws') + '/api/ws';
const NONE = '_none';
const NONE_COLOR = '#a3a3a3';

const call = async (path, opts = {}) => {
  const res = await fetch(`${API}${path}`, {
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    ...opts,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.detail || `HTTP ${res.status}`);
  return data;
};

const ago = (iso, now) => {
  if (!iso) return '';
  const m = Math.max(0, Math.round((now - new Date(iso).getTime()) / 60000));
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return `${h} h ${m % 60} min`;
};
const hm = (mins) => {
  const m = Math.round(mins || 0);
  if (!m) return '—';
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')} h`;
};
const todayTj = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/Tijuana' });

const StateEditor = ({ row, states, onCancel, onSave, saving, t }) => {
  const [state, setState] = useState(row.state || '');
  const boardOrders = row.board_orders || [];
  const [order, setOrder] = useState(row.order_number || boardOrders[0]?.order_number || '');
  // Una orden que no está en el tablero se teclea a mano ("Otra orden…").
  const [typing, setTyping] = useState(!!row.order_number && !boardOrders.some((o) => o.order_number === row.order_number));
  const [note, setNote] = useState(row.note || '');
  const active = states.filter((s) => s.active !== false);
  const OTHER = '__other__';
  return (
    <div className="mt-3 pt-3 border-t border-border space-y-3">
      <div className="flex flex-wrap gap-2">
        {active.map((s) => (
          <button key={s.key} type="button" onClick={() => setState(s.key)}
            className={`px-3 py-1.5 rounded-lg text-xs font-bold border transition-colors ${state === s.key ? 'text-white' : 'text-foreground hover:bg-secondary'}`}
            style={state === s.key ? { background: s.color, borderColor: s.color } : { borderColor: s.color }}>
            {s.label}
          </button>
        ))}
      </div>
      <div className="flex flex-wrap gap-2 items-center">
        <label className="text-xs text-muted-foreground">{t('ms_order')}</label>
        {!typing ? (
          <select value={order} onChange={(e) => {
            if (e.target.value === OTHER) { setTyping(true); setOrder(''); } else setOrder(e.target.value);
          }} className="max-w-[340px] rounded-lg border border-border bg-background px-2 py-1.5 text-xs">
            <option value="">{t('ms_no_order')}</option>
            {boardOrders.map((o) => (
              <option key={o.order_number} value={o.order_number}>
                {o.order_number} · {o.client}{o.production_status ? ` · ${o.production_status}` : ''}
              </option>
            ))}
            <option value={OTHER}>{t('ms_other_order')}</option>
          </select>
        ) : (
          <span className="inline-flex items-center gap-1">
            <input value={order} onChange={(e) => setOrder(e.target.value.trim())} placeholder={t('ms_order_ph')} autoFocus
              className="w-28 rounded-lg border border-border bg-background px-2 py-1.5 text-xs font-mono" />
            {boardOrders.length > 0 && (
              <button type="button" onClick={() => { setTyping(false); setOrder(boardOrders[0].order_number); }}
                className="text-[11px] text-primary hover:underline">{t('ms_pick_from_board')}</button>
            )}
          </span>
        )}
        <input value={note} onChange={(e) => setNote(e.target.value)} maxLength={200} placeholder={t('ms_note_ph')}
          className="flex-1 min-w-[180px] rounded-lg border border-border bg-background px-2 py-1.5 text-xs" />
        <button type="button" onClick={onCancel} className="px-3 py-1.5 rounded-lg text-xs hover:bg-secondary">{t('cancel')}</button>
        <button type="button" disabled={!state || saving} onClick={() => onSave({ state, order_number: order, note })}
          className="px-3 py-1.5 rounded-lg text-xs font-bold bg-primary text-primary-foreground disabled:opacity-50 inline-flex items-center gap-1">
          {saving && <Loader2 size={12} className="animate-spin" />} {t('save')}
        </button>
      </div>
    </div>
  );
};

const MachineCard = ({ row, stateMap, now, canEdit, editing, onEdit, onCancel, onSave, saving, states, t }) => {
  const st = stateMap[row.state];
  const color = st?.color || NONE_COLOR;
  return (
    <div className="rounded-xl border border-border bg-card overflow-hidden flex" data-testid={`ms-card-${row.machine}`}>
      <div className="w-1.5 shrink-0" style={{ background: color }} />
      <div className="flex-1 p-4 min-w-0">
        <div className="flex items-center gap-4 flex-wrap">
          <div className="w-20 shrink-0">
            <div className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">{t('ms_machine')}</div>
            <div className="text-2xl font-black leading-none">{row.number ?? row.machine}</div>
          </div>
          <div className="w-52 shrink-0">
            <span className="inline-flex items-center px-2.5 py-1 rounded-md text-xs font-bold text-white" style={{ background: color }}>
              {st?.label || t('ms_unset')}
            </span>
            {row.since && (
              <div className="text-xs text-muted-foreground mt-1 inline-flex items-center gap-1">
                <Clock size={11} /> {t('ms_for', { t: ago(row.since, now) })}
              </div>
            )}
          </div>
          <div className="flex-1 min-w-[160px]">
            {row.order_number ? (
              <>
                <div className="text-sm font-bold font-mono">PO {row.order_number}</div>
                <div className="text-xs text-muted-foreground truncate">{row.client}</div>
              </>
            ) : (
              <div className="text-xs text-muted-foreground">
                {row.board_orders?.length ? t('ms_on_board', { n: row.board_orders.length }) : t('ms_no_orders')}
              </div>
            )}
          </div>
          <div className="flex-1 min-w-[160px] text-xs">
            {row.note && <div className="italic truncate" title={row.note}>"{row.note}"</div>}
            {row.by_name && <div className="text-muted-foreground truncate">{row.by_name}</div>}
          </div>
          {canEdit && !editing && (
            <button type="button" onClick={onEdit}
              className="px-3 py-1.5 rounded-lg text-xs font-bold border border-border hover:bg-secondary">
              {t('ms_change')}
            </button>
          )}
        </div>
        {editing && <StateEditor row={row} states={states} onCancel={onCancel} onSave={onSave} saving={saving} t={t} />}
      </div>
    </div>
  );
};

const StatesModal = ({ states, onClose, onSaved, t }) => {
  const [rows, setRows] = useState(() => states.map((s) => ({ ...s })));
  const [saving, setSaving] = useState(false);
  const upd = (i, patch) => setRows((r) => r.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  const save = async () => {
    setSaving(true);
    try {
      await call('/machine-status/states', { method: 'PUT', body: JSON.stringify({ states: rows }) });
      toast.success(t('ms_states_saved'));
      onSaved();
    } catch (e) { toast.error(e.message); } finally { setSaving(false); }
  };
  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-card border border-border rounded-2xl w-full max-w-lg p-5 space-y-3" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-black">{t('ms_states_title')}</h2>
          <button type="button" onClick={onClose} className="p-1 rounded hover:bg-secondary"><X size={18} /></button>
        </div>
        <p className="text-xs text-muted-foreground">{t('ms_states_hint')}</p>
        <div className="space-y-2 max-h-[60vh] overflow-auto">
          {rows.map((s, i) => (
            <div key={s.key || `new-${i}`} className="flex items-center gap-2">
              <input type="color" value={s.color} onChange={(e) => upd(i, { color: e.target.value })}
                className="w-9 h-8 rounded border border-border bg-transparent" />
              <input value={s.label} onChange={(e) => upd(i, { label: e.target.value })} maxLength={40}
                className="flex-1 rounded-lg border border-border bg-background px-2 py-1.5 text-sm" />
              <label className="text-xs inline-flex items-center gap-1">
                <input type="checkbox" checked={s.active !== false} onChange={(e) => upd(i, { active: e.target.checked })} />
                {t('ms_active')}
              </label>
              {!s.builtin ? (
                <button type="button" onClick={() => setRows((r) => r.filter((_, j) => j !== i))}
                  className="p-1 rounded hover:bg-destructive/10 text-muted-foreground hover:text-destructive" title={t('ms_remove')}>
                  <X size={14} />
                </button>
              ) : <span className="w-6" />}
            </div>
          ))}
        </div>
        <div className="flex justify-between pt-2">
          <button type="button" onClick={() => setRows((r) => [...r, { key: '', label: '', color: '#0ea5e9', active: true }])}
            className="px-3 py-1.5 rounded-lg text-xs font-bold border border-border hover:bg-secondary inline-flex items-center gap-1">
            <Plus size={13} /> {t('ms_add_state')}
          </button>
          <button type="button" onClick={save} disabled={saving}
            className="px-4 py-1.5 rounded-lg text-xs font-bold bg-primary text-primary-foreground disabled:opacity-50">
            {saving ? <Loader2 size={13} className="animate-spin" /> : t('save')}
          </button>
        </div>
      </div>
    </div>
  );
};

export default function MachineStatusModule() {
  const { t } = useLang();
  const navigate = useNavigate();
  const [data, setData] = useState(null);
  const [hist, setHist] = useState(null);
  const [tab, setTab] = useState('live');
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');
  const [editing, setEditing] = useState('');
  const [saving, setSaving] = useState(false);
  const [showStates, setShowStates] = useState(false);
  const [now, setNow] = useState(Date.now());
  const loadRef = useRef(null);

  const load = useCallback(async () => {
    try {
      const d = await call('/machine-status');
      setData(d); setErr('');
      if (tab === 'today') setHist(await call(`/machine-status/history?date=${todayTj()}`));
    } catch (e) { setErr(e.message); } finally { setLoading(false); }
  }, [tab]);
  loadRef.current = load;

  useEffect(() => { load(); }, [load]);
  // "hace X min" sin pedir nada al servidor.
  useEffect(() => { const id = setInterval(() => setNow(Date.now()), 30000); return () => clearInterval(id); }, []);

  useEffect(() => {
    let ws; let timer; let retry; let disposed = false;
    const connect = () => {
      try {
        ws = new WebSocket(WS_URL);
        ws.onmessage = (e) => {
          try {
            const msg = JSON.parse(e.data);
            if (msg.type !== 'machine_status' && msg.type !== 'order_change') return;
            clearTimeout(timer);
            const wait = msg.type === 'machine_status' ? 300 : 3000 + Math.random() * 4000;
            timer = setTimeout(() => loadRef.current?.(), wait);
          } catch { /* mensaje ajeno */ }
        };
        ws.onclose = () => { if (!disposed) retry = setTimeout(connect, 10000); };
      } catch { if (!disposed) retry = setTimeout(connect, 10000); }
    };
    connect();
    return () => { disposed = true; clearTimeout(timer); clearTimeout(retry); try { ws?.close(); } catch { /* */ } };
  }, []);

  const states = data?.states || [];
  const stateMap = Object.fromEntries(states.map((s) => [s.key, s]));
  const machines = data?.machines || [];
  const recap = data?.recap || {};
  const canEdit = !!data?.can_edit;

  const save = async (row, body) => {
    setSaving(true);
    try {
      await call(`/machine-status/${row.machine}`, { method: 'PUT', body: JSON.stringify(body) });
      setEditing('');
      await load();
    } catch (e) { toast.error(e.message); } finally { setSaving(false); }
  };

  const copyRecap = async () => {
    const hhmm = new Date().toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'America/Tijuana' });
    const lines = [`Recap Impresión ${hhmm}`, ''];
    states.filter((s) => recap[s.key]).forEach((s) => lines.push(`Máquinas ${s.label} → ${recap[s.key]}`));
    if (recap[NONE]) lines.push(`${t('ms_unset')} → ${recap[NONE]}`);
    lines.push('');
    machines.filter((m) => m.state).forEach((m) => {
      const parts = [`Máquina ${m.number}`];
      if (m.order_number) parts.push(`PO.${m.order_number}`);
      parts.push(stateMap[m.state]?.label || m.state);
      lines.push(parts.join(' ') + (m.note ? ` — ${m.note}` : ''));
    });
    try { await navigator.clipboard.writeText(lines.join('\n')); toast.success(t('ms_recap_copied')); }
    catch { toast.error(t('ms_recap_copy_err')); }
  };

  const tabBtn = (key, label) => (
    <button type="button" onClick={() => setTab(key)}
      className={`px-4 py-2 rounded-lg text-xs font-black uppercase tracking-wider ${tab === key ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-secondary'}`}>
      {label}
    </button>
  );

  return (
    <div className="min-h-screen bg-background text-foreground">
      <Toaster />
      <header className="sticky top-0 z-10 bg-background/95 border-b border-border px-4 md:px-8 py-4">
        <div className="flex items-center gap-3 flex-wrap">
          <button type="button" onClick={() => navigate('/')} className="p-2 rounded-lg hover:bg-secondary" title={t('back')}>
            <ArrowLeft size={18} />
          </button>
          <Activity size={22} className="text-emerald-500" />
          <div className="flex-1 min-w-0">
            <h1 className="text-xl font-black tracking-tight">{t('ms_title')}</h1>
            <p className="text-xs text-muted-foreground hidden sm:block">{t('ms_subtitle')}</p>
          </div>
          <button type="button" onClick={copyRecap} disabled={!data}
            className="px-3 py-2 rounded-lg text-xs font-bold border border-border hover:bg-secondary inline-flex items-center gap-1.5">
            <Copy size={14} /> {t('ms_copy_recap')}
          </button>
          {canEdit && (
            <button type="button" onClick={() => setShowStates(true)} className="p-2 rounded-lg hover:bg-secondary" title={t('ms_states_title')}>
              <Settings2 size={18} />
            </button>
          )}
          <button type="button" onClick={() => { setLoading(true); load(); }} className="p-2 rounded-lg hover:bg-secondary" title={t('ms_refresh')}>
            <RefreshCw size={18} className={loading ? 'animate-spin' : ''} />
          </button>
        </div>
        <div className="flex gap-2 mt-4 flex-wrap items-center">
          {states.filter((s) => s.active !== false || recap[s.key]).map((s) => (
            <div key={s.key} className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg border border-border bg-card text-xs">
              <span className="w-2.5 h-2.5 rounded-full" style={{ background: s.color }} />
              <span className="font-bold">{s.label}</span>
              <span className="text-base font-black">{recap[s.key] || 0}</span>
            </div>
          ))}
          {!!recap[NONE] && (
            <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg border border-dashed border-border text-xs text-muted-foreground">
              {t('ms_unset')} <span className="text-base font-black text-foreground">{recap[NONE]}</span>
            </div>
          )}
          <div className="ml-auto flex gap-2">{tabBtn('live', t('ms_tab_live'))}{tabBtn('today', t('ms_tab_today'))}</div>
        </div>
      </header>

      <main className="px-4 md:px-8 py-6 space-y-3 max-w-6xl mx-auto">
        {data && !canEdit && <div className="rounded-lg border border-border bg-card text-xs p-3 text-muted-foreground">{t('ms_readonly')}</div>}
        {err && <div className="rounded-lg border border-red-500/40 bg-red-500/10 text-red-500 text-sm p-3">{err}</div>}
        {!data && loading && <div className="flex justify-center py-16"><Loader2 className="animate-spin text-muted-foreground" /></div>}

        {tab === 'live' && machines.map((row) => (
          <MachineCard key={row.machine} row={row} stateMap={stateMap} now={now} canEdit={canEdit} states={states}
            editing={editing === row.machine} saving={saving && editing === row.machine}
            onEdit={() => setEditing(row.machine)} onCancel={() => setEditing('')}
            onSave={(body) => save(row, body)} t={t} />
        ))}

        {tab === 'today' && hist && (
          <div className="rounded-xl border border-border bg-card overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-muted-foreground">
                  <th className="text-left p-3">{t('ms_machine')}</th>
                  {hist.states.map((s) => (
                    <th key={s.key} className="text-right p-3 whitespace-nowrap">
                      <span className="inline-block w-2 h-2 rounded-full mr-1" style={{ background: s.color }} />{s.label}
                    </th>
                  ))}
                  <th className="text-right p-3">{t('ms_changes')}</th>
                </tr>
              </thead>
              <tbody>
                {hist.machines.map((m) => (
                  <tr key={m.machine} className="border-t border-border">
                    <td className="p-3 font-black">{m.number}</td>
                    {hist.states.map((s) => <td key={s.key} className="p-3 text-right tabular-nums">{hm(m.minutes[s.key])}</td>)}
                    <td className="p-3 text-right tabular-nums">{m.changes || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="text-[11px] text-muted-foreground p-3">{t('ms_today_hint', { d: hist.date })}</p>
          </div>
        )}
      </main>

      {showStates && <StatesModal states={states} onClose={() => setShowStates(false)}
        onSaved={() => { setShowStates(false); load(); }} t={t} />}
    </div>
  );
}
