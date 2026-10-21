import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, Shirt, RefreshCw, Loader2, CalendarClock, CalendarCheck, ListTodo, Sparkles, Search, CheckCircle2, AlertTriangle, PackageCheck, PieChart, Loader } from 'lucide-react';
import { toast } from 'sonner';
import { useLang } from '../contexts/LanguageContext';
import { Toaster } from './ui/sonner';
import {
  REFRESH_MS, call, fmtDay, fmtTime, isOverdue, readWindow, saveWindow, WindowSelect,
  useOrderChangeReload, Components, PrintavoLink,
} from './modules/shared';

// Módulo de Blanks. Reemplazará al tablero BLANKS. Cambiar el estatus (y
// "Confirmar CONTADO" en las sugeridas) es del rol `blanks` + admin/supersu;
// escribe por el mismo camino que el CRM (bitácora y automatizaciones).
// La cola sale de la simulación de Planeación con el blank contado como listo
// (backend routers/blanks.py): Programadas = arrancarían en los próximos N
// días; Pendientes = lo demás; Sugeridas = el WMS ya surtió el 100 % y el
// estatus no dice CONTADO; Sin estatus = blank_status vacío.
// Cada tarjeta muestra el avance real del almacén por talla (pedido en sus
// pick tickets, surtido de la bitácora del WMS y stock disponible).


function ProgressBar({ pct }) {
  if (pct == null) return null;
  const color = pct >= 100 ? 'bg-emerald-500' : pct > 0 ? 'bg-amber-500' : 'bg-muted-foreground/30';
  return (
    <div className="h-1.5 w-full rounded-full bg-secondary overflow-hidden">
      <div className={`h-full ${color}`} style={{ width: `${Math.min(100, pct)}%` }} />
    </div>
  );
}

function SizesTable({ rows, t }) {
  if (!rows?.length) return null;
  return (
    <div className="mt-2 overflow-x-auto">
      <table className="text-[11px] tabular-nums">
        <thead>
          <tr className="text-muted-foreground">
            <td className="pr-3 font-bold">{t('blk_size')}</td>
            {rows.map((r) => <td key={r.size} className="px-2 text-center font-black">{r.size}</td>)}
          </tr>
        </thead>
        <tbody>
          <tr>
            <td className="pr-3 text-muted-foreground">{t('blk_ordered')}</td>
            {rows.map((r) => <td key={r.size} className="px-2 text-center">{r.ordered || '—'}</td>)}
          </tr>
          <tr>
            <td className="pr-3 text-muted-foreground">{t('blk_picked')}</td>
            {rows.map((r) => (
              <td key={r.size} className={`px-2 text-center font-bold ${r.ordered && r.picked >= r.ordered
                ? 'text-emerald-600 dark:text-emerald-400' : r.picked ? 'text-amber-600 dark:text-amber-400' : ''}`}>
                {r.picked || '—'}
              </td>
            ))}
          </tr>
          <tr>
            <td className="pr-3 text-muted-foreground">{t('blk_stock')}</td>
            {rows.map((r) => (
              <td key={r.size} className={`px-2 text-center ${r.ordered > r.picked && r.stock < r.ordered - r.picked
                ? 'text-red-500 font-bold' : 'text-muted-foreground'}`}>
                {r.stock || '0'}
              </td>
            ))}
          </tr>
        </tbody>
      </table>
    </div>
  );
}

function OrderCard({ c, t, canEdit, statuses, confirmStatus, busy, onStatus }) {
  return (
    <div className="rounded-xl border border-border bg-card p-4 flex flex-col gap-3 lg:flex-row">
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-base font-black">#{c.order_number}</span>
          <PrintavoLink url={c.printavo_url} t={t} />
          {c.priority && <span className="text-[10px] font-black px-1.5 py-0.5 rounded bg-red-500/15 text-red-500">{c.priority}</span>}
          <span className="text-sm text-muted-foreground truncate">{c.client}{c.branding ? ` · ${c.branding}` : ''}</span>
        </div>
        <div className="text-xs text-muted-foreground mt-1 flex flex-wrap gap-x-4 gap-y-1">
          {c.design && <span>{t('scr_design')}: <b className="text-foreground">{c.design}</b></span>}
          <span>{t('scr_qty')}: <b className="text-foreground">{Number(c.quantity || 0).toLocaleString('es-MX')}</b></span>
          {(c.style || c.color) && <span>{t('blk_style')}: <b className="text-foreground">{[c.style, c.color].filter(Boolean).join(' · ')}</b></span>}
          {c.blank_source && <span>{t('blk_source')}: <b className="text-foreground">{c.blank_source}</b></span>}
          {c.bpo && <span>BPO: <b className="text-foreground">{c.bpo}</b></span>}
          <span className={isOverdue(c.cancel_date) ? 'text-red-500 font-bold' : ''}>Cancel: {fmtDay(c.cancel_date)}</span>
          {c.stale && <span className="text-[10px] font-black px-1.5 py-0.5 rounded bg-red-500/15 text-red-500">{t('mod_stale')}</span>}
          <span>{t('scr_board')}: {c.board}</span>
        </div>
        <Components items={c.components} t={t} />
        <SizesTable rows={c.sizes} t={t} />
      </div>

      <div className="text-xs lg:w-72 shrink-0 space-y-2 lg:border-l lg:border-border lg:pl-4">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-muted-foreground">{t('blk_status')}:</span>
          {canEdit ? (
            <select value={c.blank_status} disabled={busy}
              onChange={(e) => e.target.value && onStatus(c, e.target.value)}
              className="flex-1 min-w-0 rounded-md border border-border bg-card px-2 py-1 text-xs font-bold text-foreground disabled:opacity-50">
              {!c.blank_status && <option value="">{t('blk_no_status')}</option>}
              {c.blank_status && !statuses.includes(c.blank_status) && <option value={c.blank_status}>{c.blank_status}</option>}
              {statuses.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          ) : (
            <span className={`px-2 py-0.5 rounded font-black ${c.blank_status
              ? 'bg-amber-500/15 text-amber-600 dark:text-amber-400' : 'bg-secondary text-muted-foreground'}`}>
              {c.blank_status || t('blk_no_status')}
            </span>
          )}
          {busy && <Loader2 size={13} className="animate-spin" />}
        </div>
        {c.suggest_contado && (
          <div className="rounded-md border border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 px-2 py-1 font-bold space-y-1">
            <div>{t('blk_suggest')}</div>
            {canEdit && (
              <button type="button" disabled={busy} onClick={() => onStatus(c, confirmStatus)}
                className="w-full inline-flex items-center justify-center gap-1.5 px-2 py-1 rounded bg-emerald-600 text-white disabled:opacity-50">
                <CheckCircle2 size={13} /> {t('blk_confirm', { s: confirmStatus })}
              </button>
            )}
          </div>
        )}
        <div>
          <div className="flex justify-between text-muted-foreground mb-1">
            <span>{t('blk_wms_progress')}</span>
            <span className="font-bold text-foreground">
              {c.ordered ? `${c.picked.toLocaleString('es-MX')} / ${c.ordered.toLocaleString('es-MX')} (${c.pct}%)` : t('blk_no_ticket')}
            </span>
          </div>
          <ProgressBar pct={c.pct} />
        </div>
        {c.tickets?.length > 0 && (
          <div className="text-muted-foreground">
            {c.tickets.map((tk) => (
              <div key={tk.ticket_id} className="truncate" title={tk.ticket_id}>
                {t('blk_ticket')}: {tk.picking_status || tk.status}{tk.assigned_to ? ` · ${tk.assigned_to}` : ''}
              </div>
            ))}
          </div>
        )}
        <div className="pt-1 border-t border-border">
          {c.alert ? (
            <div className="rounded-md border border-red-500/40 bg-red-500/10 text-red-600 dark:text-red-400 px-2 py-1 font-bold">
              {t('mod_in_production')} · {c.printing_on === 'EN PRODUCCION' ? (c.machine || c.board) : c.printing_on}
            </div>
          ) : c.start ? (
            <>
              <div className="text-muted-foreground">{t('scr_would_start')}</div>
              <div className="font-bold">{fmtDay(c.start)} {fmtTime(c.start)} · {c.machine || '—'}</div>
            </>
          ) : (
            <div className="font-bold">{t('scr_target')}: {fmtDay(c.target_date)}</div>
          )}
          {c.missing?.length > 0 && (
            <div className="text-amber-600 dark:text-amber-400">{t('scr_also_missing')}: {c.missing.join(', ')}</div>
          )}
        </div>
      </div>
    </div>
  );
}

export default function BlanksModule() {
  const { t } = useLang();
  const navigate = useNavigate();
  const [data, setData] = useState(null);
  const [err, setErr] = useState('');
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState('sched');
  const [days, setDays] = useState(() => readWindow('mos_blanks_days'));
  const changeDays = (d) => { setDays(d); saveWindow('mos_blanks_days', d); };
  const [q, setQ] = useState('');
  const [busyId, setBusyId] = useState('');
  const loadRef = useRef(null);

  const load = useCallback(async () => {
    try {
      setData(await call(`/blanks/queue?days=${days}`));
      setErr('');
    } catch (e) {
      setErr(e.message);
    } finally {
      setLoading(false);
    }
  }, [days]);
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
      await call(`/blanks/${c.order_id}/status`, { method: 'POST', body: JSON.stringify({ status }) });
      toast.success(t('blk_status_toast', { n: c.order_number, s: status }));
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
    sched: data?.programados || [],
    prog: data?.pendientes || [],
    adv: data?.adelantar || [],
    surtido: data?.surtido || [],
    parciales: data?.parciales || [],
    proceso: data?.proceso || [],
    sug: data?.sugeridas || [],
    alert: data?.alertas || [],
  };
  // Buscador: todas las palabras deben aparecer en la orden.
  const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const all = lists[tab];
  const shown = words.length === 0 ? all : all.filter((c) => {
    const hay = [c.order_number, c.client, c.branding, c.design, c.customer_po, c.style, c.color, c.board,
      c.blank_status, c.bpo].join(' ').toLowerCase();
    return words.every((w) => hay.includes(w));
  });
  const simAge = data?.sim_at ? Math.round((Date.now() - new Date(data.sim_at).getTime()) / 60000) : null;

  const tabBtn = (key, label, Icon) => (
    <button type="button" onClick={() => setTab(key)}
      className={`inline-flex items-center gap-2 px-4 py-2 rounded-lg text-xs font-black uppercase tracking-wider transition-colors
        ${tab === key ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-secondary'}`}>
      <Icon size={14} /> {label} <span className="opacity-70">{lists[key].length}</span>
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
          <Shirt size={22} className="text-sky-500" />
          <div className="flex-1 min-w-0">
            <h1 className="text-xl font-black tracking-tight">{t('blk_title')}</h1>
            <p className="text-xs text-muted-foreground">
              <span className="hidden sm:inline">{t('blk_subtitle')}</span>
              {simAge != null && <><span className="hidden sm:inline"> · </span>{t('scr_plan_age', { m: simAge })}</>}
            </p>
          </div>
          <div className="text-right text-xs">
            <div className="text-2xl font-black text-emerald-600 dark:text-emerald-400">{data?.done_today ?? '—'}</div>
            <div className="text-muted-foreground">{t('blk_done_today')}</div>
          </div>
          <button type="button" onClick={() => { setLoading(true); load(); }} className="p-2 rounded-lg hover:bg-secondary" title={t('scr_refresh')}>
            <RefreshCw size={18} className={loading ? 'animate-spin' : ''} />
          </button>
        </div>
        <div className="flex gap-2 mt-4 flex-wrap">
          {tabBtn('sched', t('mod_tab_scheduled'), CalendarCheck)}
          {tabBtn('prog', t('mod_tab_pending'), CalendarClock)}
          {tabBtn('adv', t('scr_tab_advance'), ListTodo)}
          {tabBtn('surtido', t('blk_tab_surtido'), PackageCheck)}
          {tabBtn('parciales', t('blk_tab_partial'), PieChart)}
          {tabBtn('proceso', t('blk_tab_process'), Loader)}
          {tabBtn('sug', t('blk_tab_suggested'), Sparkles)}
          {tabBtn('alert', t('mod_tab_alerts'), AlertTriangle)}
          <WindowSelect days={days} onChange={changeDays} t={t} />
        </div>
      </header>

      <main className="px-4 md:px-8 py-6 space-y-3 max-w-7xl">
        {data && !canEdit && (
          <div className="rounded-lg border border-border bg-card text-xs p-3 text-muted-foreground">{t('blk_readonly')}</div>
        )}
        {err && <div className="rounded-lg border border-red-500/40 bg-red-500/10 text-red-500 text-sm p-3">{err}</div>}
        {tab === 'sug' && <div className="rounded-lg border border-emerald-500/40 bg-emerald-500/10 text-xs p-3">{t('blk_suggested_hint')}</div>}
        {tab === 'sched' && <div className="rounded-lg border border-border bg-card text-xs p-3 text-muted-foreground">{t('mod_scheduled_hint', { n: days })}</div>}
        {tab === 'prog' && <div className="rounded-lg border border-border bg-card text-xs p-3 text-muted-foreground">{t('blk_pending_hint')}</div>}
        {tab === 'alert' && <div className="rounded-lg border border-red-500/40 bg-red-500/10 text-xs p-3">{t('blk_alerts_hint')}</div>}
        {['surtido', 'parciales', 'proceso'].includes(tab) && <div className="rounded-lg border border-border bg-card text-xs p-3 text-muted-foreground">{t('blk_status_tab_hint')}</div>}
        {tab === 'adv' && <div className="rounded-lg border border-border bg-card text-xs p-3 text-muted-foreground">{t('blk_advance_hint')}</div>}
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
            <OrderCard key={c.order_id} c={c} t={t} canEdit={canEdit} statuses={statuses}
              confirmStatus={data?.confirm_status || 'CONTADO'} busy={busyId === c.order_id} onStatus={onStatus} />
          ))
        )}
      </main>
    </div>
  );
}
