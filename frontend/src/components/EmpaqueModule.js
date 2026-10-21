import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ArrowLeft, PackageCheck, RefreshCw, Loader2, ListTodo, Sparkles, Search, Send,
  AlertTriangle, Loader, Truck, FileSpreadsheet, Tablet, LayoutDashboard,
} from 'lucide-react';
import { toast } from 'sonner';
import { useLang } from '../contexts/LanguageContext';
import { Toaster } from './ui/sonner';
import { EmpaqueSummary } from './modules/PackingLoadChart';
import {
  REFRESH_MS, call, fmtDay, useOrderChangeReload, Components, PrintavoLink,
} from './modules/shared';

// Módulo de Empaque. Reemplazará al tablero EMPAQUE. Entra lo que dice
// NECESITA EMPACAR / EN PROCESO DE EMPAQUE (en el tablero que esté) y sale al
// mandarlo a QC (NECESITA QC). La prioridad es la próxima salida en Envíos
// programados (o el cancel). El avance de piezas/cajas sale del DPL (packing
// list digital de la orden). Cambiar el estatus es del rol `empaque` +
// admin/supersu, por el mismo camino que el CRM. Backend: routers/empaque.py.

function ProgressBar({ pct }) {
  if (pct == null) return null;
  const color = pct >= 100 ? 'bg-emerald-500' : pct > 0 ? 'bg-amber-500' : 'bg-muted-foreground/30';
  return (
    <div className="h-1.5 w-full rounded-full bg-secondary overflow-hidden">
      <div className={`h-full ${color}`} style={{ width: `${Math.min(100, pct)}%` }} />
    </div>
  );
}

const n = (v) => Number(v || 0).toLocaleString('es-MX');

function OrderCard({ c, t, canEdit, readOnly, statuses, confirmStatus, busy, onStatus }) {
  const editable = canEdit && !readOnly;
  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <div className="min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-base font-black">#{c.order_number}</span>
          <PrintavoLink url={c.printavo_url} t={t} />
          {c.priority && <span className="text-[10px] font-black px-1.5 py-0.5 rounded bg-red-500/15 text-red-500">{c.priority}</span>}
          {c.packing_type && <span className="text-[10px] font-black px-1.5 py-0.5 rounded bg-secondary">{c.packing_type}</span>}
          {c.printed_on && (
            <span className={`text-[10px] font-black px-1.5 py-0.5 rounded ${c.printing_now ? 'bg-emerald-600 text-white' : 'bg-sky-500/15 text-sky-700 dark:text-sky-300'}`}
              title={c.printed_on_all?.length > 1 ? c.printed_on_all.join(', ') : undefined}>
              {t(c.printing_now ? 'emp_printing_on' : 'emp_printed_on', { m: c.printed_on.replace('MAQUINA', 'M') })}
            </span>
          )}
          <span className="text-sm text-muted-foreground truncate">{c.client}{c.branding ? ` · ${c.branding}` : ''}</span>
        </div>
        <div className="text-xs text-muted-foreground mt-1 flex flex-wrap gap-x-4 gap-y-1">
          {c.design && <span>{t('scr_design')}: <b className="text-foreground">{c.design}</b></span>}
          <span>{t('scr_qty')}: <b className="text-foreground">{n(c.quantity)}</b></span>
          {(c.style || c.color) && <span>{t('blk_style')}: <b className="text-foreground">{[c.style, c.color].filter(Boolean).join(' · ')}</b></span>}
          {c.customer_po && <span>PO: <b className="text-foreground">{c.customer_po}</b></span>}
          <span>{t('scr_board')}: {c.board}</span>
        </div>
      </div>

      {/* Pantalla ancha: componentes y franja LADO A LADO (un renglón); más
          angosta: la franja baja debajo de los componentes. */}
      <div className="2xl:flex 2xl:items-end 2xl:gap-4">
      <div className="2xl:flex-1 min-w-0"><Components items={c.components} t={t} /></div>

      {/* Franja horizontal: estatus · fecha · avance · acción (antes era una
          columna angosta a la derecha que hacía la tarjeta alta). */}
      <div className="mt-3 pt-3 border-t border-border text-xs grid gap-3 items-center
        md:grid-cols-[minmax(0,19rem)_minmax(0,14rem)_minmax(0,1fr)_auto]
        2xl:w-[58rem] 2xl:shrink-0 2xl:border-t-0 2xl:pt-0 2xl:border-l 2xl:pl-4">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-muted-foreground shrink-0">{t('emp_status')}:</span>
          {editable ? (
            <select value={statuses.includes(c.status) ? c.status : ''} disabled={busy}
              onChange={(e) => e.target.value && e.target.value !== c.status && onStatus(c, e.target.value)}
              className="flex-1 min-w-0 rounded-md border border-border bg-card px-2 py-1 text-xs font-bold text-foreground disabled:opacity-50">
              {!statuses.includes(c.status) && <option value="">{c.status || '—'}</option>}
              {statuses.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          ) : (
            <span className="px-2 py-0.5 rounded font-black bg-secondary truncate">{c.status || '—'}</span>
          )}
          {busy && <Loader2 size={13} className="animate-spin shrink-0" />}
        </div>

        <div className={`min-w-0 ${c.overdue ? 'text-red-500 font-bold' : ''}`}>
          <div className="text-muted-foreground truncate">{t(c.due_source === 'ship' ? 'emp_ship_date' : 'emp_cancel_date')}</div>
          <div className="font-bold truncate">{fmtDay(c.due)}{c.overdue ? ` · ${t('emp_overdue')}` : ''}</div>
        </div>

        <div className="min-w-0">
          <div className="flex items-center gap-x-3 gap-y-0.5 flex-wrap text-muted-foreground">
            <span className="inline-flex items-center gap-1 shrink-0">
              <FileSpreadsheet size={12} />
              {c.dpl_url
                ? <a href={c.dpl_url} target="_blank" rel="noopener noreferrer" className="font-bold text-primary hover:underline">DPL</a>
                : c.packed_source === 'station' ? <span className="font-bold">{t('emp_station')}</span> : t('emp_no_dpl')}
              {c.dpl_url && c.packed_source === 'station' && <span className="font-bold">· {t('emp_station')}</span>}
            </span>
            {c.packed != null && (
              <span className="font-bold text-foreground">{n(c.packed)} / {n(c.quantity)}{c.packed_pct != null ? ` (${c.packed_pct}%)` : ''}</span>
            )}
            {c.packed != null && (c.boxes || c.pallets) && <span>{t('emp_boxes', { b: n(c.boxes), p: n(c.pallets) })}</span>}
            {c.packer && <span className="truncate">{t('emp_packer', { who: c.packer, when: c.date_packed || '—' })}</span>}
            {c.dpl_loading && <Loader2 size={12} className="animate-spin" />}
            {c.stuck && <span className="font-bold text-red-600 dark:text-red-400">{t('emp_stuck', { d: fmtDay(c.status_at) })}</span>}
            {c.suggest_qc && <span className="font-bold text-emerald-600 dark:text-emerald-400">{t('emp_suggest')}</span>}
            {c.dpl_error && <span className="text-amber-600 dark:text-amber-400">{c.dpl_error}</span>}
          </div>
          <div className="mt-1"><ProgressBar pct={c.packed_pct} /></div>
        </div>

        {editable ? (
          <button type="button" disabled={busy} onClick={() => onStatus(c, confirmStatus)}
            className="inline-flex items-center justify-center gap-1.5 px-4 py-2 rounded-lg bg-emerald-600 text-white font-bold whitespace-nowrap disabled:opacity-50">
            <Send size={13} /> {t('emp_send_qc')}
          </button>
        ) : <span />}
      </div>
      </div>
    </div>
  );
}

export default function EmpaqueModule() {
  const { t } = useLang();
  const navigate = useNavigate();
  const [data, setData] = useState(null);
  const [err, setErr] = useState('');
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState('pend');
  const [q, setQ] = useState('');
  const [busyId, setBusyId] = useState('');
  const loadRef = useRef(null);
  const dplRetry = useRef(0);

  const [kpis, setKpis] = useState(null);
  const load = useCallback(async () => {
    try {
      const d = await call('/empaque/queue');
      setData(d);
      call('/empaque/kpis').then(setKpis).catch(() => {});
      setErr('');
      // El DPL se descarga en segundo plano: una o dos recargas lo completan.
      if (d.dpl_pending > 0 && dplRetry.current < 2) {
        dplRetry.current += 1;
        setTimeout(() => loadRef.current?.(), 8000);
      } else if (!d.dpl_pending) {
        dplRetry.current = 0;
      }
    } catch (e) {
      setErr(e.message);
    } finally {
      setLoading(false);
    }
  }, []);
  loadRef.current = load;

  useEffect(() => {
    load();
    const id = setInterval(() => loadRef.current?.(), REFRESH_MS);
    return () => clearInterval(id);
  }, [load]);
  useOrderChangeReload(loadRef);

  const onStatus = async (c, status) => {
    setBusyId(c.order_id);
    try {
      await call(`/empaque/${c.order_id}/status`, { method: 'POST', body: JSON.stringify({ status }) });
      toast.success(t('nck_status_toast', { n: c.order_number, s: status }));
      await load();
    } catch (e) {
      toast.error(e.message);
    } finally {
      setBusyId('');
    }
  };
  const canEdit = !!data?.can_edit;
  const statuses = data?.statuses || [];

  const lists = {
    dash: [],
    pend: data?.pendientes || [],
    proc: data?.proceso || [],
    sug: data?.sugeridas || [],
    alert: data?.alertas || [],
    coming: data?.llegando || [],
  };
  const readOnlyTab = tab === 'coming';
  const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const all = lists[tab];
  const shown = words.length === 0 ? all : all.filter((c) => {
    const hay = [c.order_number, c.client, c.branding, c.design, c.customer_po, c.style, c.color, c.board,
      c.status, c.packing_type].join(' ').toLowerCase();
    return words.every((w) => hay.includes(w));
  });

  const tabBtn = (key, label, Icon) => (
    <button type="button" onClick={() => setTab(key)}
      className={`inline-flex items-center gap-2 px-4 py-2 rounded-lg text-xs font-black uppercase tracking-wider transition-colors
        ${tab === key ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-secondary'}`}>
      <Icon size={14} /> {label} {key !== 'dash' && <span className="opacity-70">{lists[key].length}</span>}
    </button>
  );
  const hint = {
    pend: t('emp_pending_hint'), proc: t('emp_process_hint'),
    sug: t('emp_suggested_hint'), alert: t('emp_alerts_hint', { d: data?.stuck_days || 3 }),
    coming: t('emp_coming_hint'),
  }[tab];

  return (
    <div className="min-h-screen bg-background text-foreground">
      <Toaster />
      <header className="sticky top-0 z-10 bg-background/95 border-b border-border px-4 md:px-8 py-4">
        <div className="flex items-center gap-3 flex-wrap">
          <button type="button" onClick={() => navigate('/')} className="p-2 rounded-lg hover:bg-secondary" title={t('back')}>
            <ArrowLeft size={18} />
          </button>
          <PackageCheck size={22} className="text-amber-500" />
          <div className="flex-1 min-w-0">
            <h1 className="text-xl font-black tracking-tight">{t('emp_title')}</h1>
            <p className="text-xs text-muted-foreground hidden sm:block">{t('emp_subtitle')}</p>
          </div>
          <button type="button" onClick={() => navigate('/empaque/estacion')}
            className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-border hover:bg-secondary text-xs font-black">
            <Tablet size={16} /> {t('emp_station')}
          </button>
          <button type="button" onClick={() => { setLoading(true); load(); }} className="p-2 rounded-lg hover:bg-secondary" title={t('scr_refresh')}>
            <RefreshCw size={18} className={loading ? 'animate-spin' : ''} />
          </button>
        </div>
        <div className="flex gap-2 mt-4 flex-wrap">
          {tabBtn('dash', t('emp_tab_summary'), LayoutDashboard)}
          {tabBtn('pend', t('emp_tab_pending'), ListTodo)}
          {tabBtn('proc', t('blk_tab_process'), Loader)}
          {tabBtn('sug', t('emp_tab_suggested'), Sparkles)}
          {tabBtn('alert', t('mod_tab_alerts'), AlertTriangle)}
          {tabBtn('coming', t('emp_tab_coming'), Truck)}
        </div>
      </header>

      <main className="px-4 md:px-8 py-6 space-y-3">
        {data && !canEdit && (
          <div className="rounded-lg border border-border bg-card text-xs p-3 text-muted-foreground">{t('emp_readonly')}</div>
        )}
        {err && <div className="rounded-lg border border-red-500/40 bg-red-500/10 text-red-500 text-sm p-3">{err}</div>}
        {tab === 'dash' ? (
          data ? <EmpaqueSummary data={data} kpis={kpis} t={t} onGo={setTab} />
            : <div className="flex justify-center py-20"><Loader2 className="animate-spin" /></div>
        ) : (<>
        {hint && (
          <div className={`rounded-lg border text-xs p-3 ${tab === 'alert' ? 'border-red-500/40 bg-red-500/10'
            : tab === 'sug' ? 'border-emerald-500/40 bg-emerald-500/10' : 'border-border bg-card text-muted-foreground'}`}>{hint}</div>
        )}
        <div className="relative">
          <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('scr_search_ph')}
            className="w-full pl-9 pr-24 py-2.5 rounded-lg border border-border bg-card text-sm outline-none focus:border-primary" />
          {words.length > 0 && (
            <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">
              {t('scr_search_count', { n: shown.length, total: all.length })}
            </span>
          )}
        </div>
        {loading && !data ? (
          <div className="flex justify-center py-20"><Loader2 className="animate-spin" /></div>
        ) : shown.length === 0 ? (
          <div className="text-center text-sm text-muted-foreground py-16">{t('scr_empty')}</div>
        ) : (
          shown.map((c) => (
            <OrderCard key={`${tab}-${c.order_id}`} c={c} t={t} canEdit={canEdit} readOnly={readOnlyTab}
              statuses={statuses} confirmStatus={data?.confirm_status || 'NECESITA QC'}
              busy={busyId === c.order_id} onStatus={onStatus} />
          ))
        )}
        </>)}
      </main>
    </div>
  );
}
