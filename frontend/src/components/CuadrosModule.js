import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, Layers, RefreshCw, Loader2, CheckCircle2, Circle, FastForward, FileClock, Search, AlertTriangle, CalendarCheck } from 'lucide-react';
import { toast } from 'sonner';
import { useLang } from '../contexts/LanguageContext';
import { Toaster } from './ui/sonner';
import {
  REFRESH_MS, call, fmtDay, fmtTime, isOverdue, readWindow, saveWindow, WindowSelect,
  useOrderChangeReload, Components, PrintavoLink, CommentsButton, useComments,
} from './modules/shared';

// Módulo de Cuadros: reemplaza al tablero SCREENS. La cola sale de una
// simulación del motor de Planeación con los cuadros contados como listos
// (backend routers/screens.py): Programadas = arrancarían en los próximos N
// días, Adelantar = lo que sigue después, Preórdenes = las que Arte mandó.
// El tablero SCREENS ya no existe: palomear cuadros no mueve la orden.
// Los cuadros se palomean por posición; al quedar todas, la orden queda con
// `screens` = true como siempre (automatización "move to neck").

function PositionChip({ p, disabled, busy, onToggle }) {
  return (
    <button
      type="button"
      disabled={disabled || busy}
      onClick={onToggle}
      className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold uppercase tracking-wide border transition-colors
        ${p.ready
          ? 'bg-emerald-500/15 border-emerald-500/40 text-emerald-600 dark:text-emerald-400'
          : 'bg-secondary border-border text-muted-foreground hover:border-emerald-500/50'}
        ${disabled ? 'cursor-default' : 'cursor-pointer'}`}
    >
      {busy ? <Loader2 size={13} className="animate-spin" /> : p.ready ? <CheckCircle2 size={13} /> : <Circle size={13} />}
      {p.position}
    </button>
  );
}

function OrderCard({ c, t, onComments, canEdit, busyKey, onToggle, onAll, mode }) {
  const pending = c.positions.filter((p) => !p.ready).length;
  const screensEst = c.colors ? c.colors * pending : null;
  return (
    <div className="rounded-xl border border-border bg-card p-4 flex flex-col gap-3 md:flex-row md:items-center">
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-base font-black">#{c.order_number}</span>
          <PrintavoLink url={c.printavo_url} t={t} />
          <CommentsButton count={c.comments} onClick={() => onComments(c)} t={t} />
          {c.priority && <span className="text-[10px] font-black px-1.5 py-0.5 rounded bg-red-500/15 text-red-500">{c.priority}</span>}
          <span className="text-sm text-muted-foreground truncate">{c.client}{c.branding ? ` · ${c.branding}` : ''}</span>
        </div>
        <div className="text-xs text-muted-foreground mt-1 flex flex-wrap gap-x-4 gap-y-1">
          {c.design && <span>{t('scr_design')}: <b className="text-foreground">{c.design}</b></span>}
          <span>{t('scr_qty')}: <b className="text-foreground">{Number(c.quantity || 0).toLocaleString('es-MX')}</b></span>
          <span>{t('scr_colors')}: <b className="text-foreground">{c.colors || t('scr_no_colors')}</b></span>
          {screensEst != null && pending > 0 && <span>{t('scr_screens_est')}: <b className="text-foreground">~{screensEst}</b></span>}
          <span className={isOverdue(c.cancel_date) ? 'text-red-500 font-bold' : ''}>Cancel: {fmtDay(c.cancel_date)}</span>
          {c.stale && <span className="text-[10px] font-black px-1.5 py-0.5 rounded bg-red-500/15 text-red-500">{t('mod_stale')}</span>}
          <span>{t('scr_board')}: {c.board}</span>
        </div>
        <Components items={c.components} t={t} />
      </div>

      <div className="text-xs md:w-48 shrink-0">
        {mode === 'pre' && <div className="font-bold">{t('scr_preorder')}</div>}
        {mode !== 'pre' && (
          <>
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
          </>
        )}
      </div>

      <div className="flex items-center gap-2 flex-wrap md:justify-end md:w-72 shrink-0">
        {c.positions.map((p) => (
          <PositionChip key={p.position} p={p} disabled={!canEdit}
            busy={busyKey === `${c.order_id}:${p.position}`} onToggle={() => onToggle(c, p)} />
        ))}
        {canEdit && pending > 1 && (
          <button type="button" onClick={() => onAll(c)} disabled={busyKey === `${c.order_id}:*`}
            className="px-3 py-1.5 rounded-lg text-xs font-bold bg-emerald-600 text-white disabled:opacity-50">
            {t('scr_all_ready')}
          </button>
        )}
      </div>
    </div>
  );
}

export default function CuadrosModule() {
  const { t } = useLang();
  const navigate = useNavigate();
  const [data, setData] = useState(null);
  const [err, setErr] = useState('');
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState('sched');
  const [days, setDays] = useState(() => readWindow('mos_cuadros_days'));
  const changeDays = (d) => { setDays(d); saveWindow('mos_cuadros_days', d); };
  const [busyKey, setBusyKey] = useState('');
  const [advQ, setAdvQ] = useState('');
  const loadRef = useRef(null);
  // Comentarios de la orden (los mismos del maestro); al cerrar, recarga el conteo.
  const [openComments, commentsModal] = useComments(() => loadRef.current?.());

  // El backend simula el plan (con caché corta); aquí sólo se pide la cola.
  const load = useCallback(async () => {
    try {
      setData(await call(`/screens/queue?days=${days}`));
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

  const run = async (key, fn, okMsg) => {
    setBusyKey(key);
    try {
      await fn();
      if (okMsg) toast.success(okMsg);
      await load();
    } catch (e) {
      toast.error(e.message);
    } finally {
      setBusyKey('');
    }
  };

  const onToggle = (c, p) => run(`${c.order_id}:${p.position}`, () => call(`/screens/${c.order_id}/position`, {
    method: 'POST', body: JSON.stringify({ position: p.position, ready: !p.ready }),
  }));
  const onAll = (c) => run(`${c.order_id}:*`, () => call(`/screens/${c.order_id}/all`, {
    method: 'POST', body: JSON.stringify({ ready: true }),
  }), t('scr_done_toast', { n: c.order_number }));

  const sched = data?.programados || [];
  const prog = data?.pendientes || [];
  const adv = data?.adelantar || [];
  const alerts = data?.alertas || [];
  const pre = data?.preordenes || [];
  const progPending = prog.filter((c) => c.positions.some((p) => !p.ready));
  // Buscador de Adelantar: todas las palabras deben aparecer en la orden
  // (número, cliente, branding, diseño, PO, estilo, color, tablero).
  const advWords = advQ.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const advShown = advWords.length === 0 ? adv : adv.filter((c) => {
    const hay = [c.order_number, c.client, c.branding, c.design, c.customer_po, c.style, c.color, c.board]
      .join(' ').toLowerCase();
    return advWords.every((w) => hay.includes(w));
  });
  const list = tab === 'sched' ? sched : tab === 'prog' ? prog : tab === 'adv' ? advShown : tab === 'alert' ? alerts : pre;
  const canEdit = !!data?.can_edit;
  const runAge = data?.sim_at ? Math.round((Date.now() - new Date(data.sim_at).getTime()) / 60000) : null;

  const tabBtn = (key, label, n, Icon) => (
    <button type="button" onClick={() => setTab(key)}
      className={`inline-flex items-center gap-2 px-4 py-2 rounded-lg text-xs font-black uppercase tracking-wider transition-colors
        ${tab === key ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-secondary'}`}>
      <Icon size={14} /> {label} <span className="opacity-70">{n}</span>
    </button>
  );

  return (
    <div className="min-h-screen bg-background text-foreground">
      <Toaster />
      {commentsModal}
      <header className="sticky top-0 z-10 bg-background/95 border-b border-border px-4 md:px-8 py-4">
        <div className="flex items-center gap-3 flex-wrap">
          <button type="button" onClick={() => navigate('/')} className="p-2 rounded-lg hover:bg-secondary" title={t('back')}>
            <ArrowLeft size={18} />
          </button>
          <Layers size={22} style={{ color: '#52b788' }} />
          <div className="flex-1 min-w-0">
            <h1 className="text-xl font-black tracking-tight">{t('scr_title')}</h1>
            <p className="text-xs text-muted-foreground">
              <span className="hidden sm:inline">{t('scr_subtitle')}</span>
              {runAge != null && <><span className="hidden sm:inline"> · </span>{t('scr_plan_age', { m: runAge })}</>}
            </p>
          </div>
          <div className="text-right text-xs">
            <div className="text-2xl font-black text-emerald-600 dark:text-emerald-400">{data?.done_today ?? '—'}</div>
            <div className="text-muted-foreground">{t('scr_done_today')}</div>
          </div>
          <button type="button" onClick={() => { setLoading(true); load(); }} className="p-2 rounded-lg hover:bg-secondary" title={t('scr_refresh')}>
            <RefreshCw size={18} className={loading ? 'animate-spin' : ''} />
          </button>
        </div>
        <div className="flex gap-2 mt-4 flex-wrap">
          {tabBtn('sched', t('mod_tab_scheduled'), sched.length, CalendarCheck)}
          {tabBtn('prog', t('mod_tab_pending'), progPending.length, Layers)}
          {tabBtn('adv', t('scr_tab_advance'), adv.length, FastForward)}
          {tabBtn('pre', t('scr_tab_preorders'), pre.length, FileClock)}
          {tabBtn('alert', t('mod_tab_alerts'), alerts.length, AlertTriangle)}
          <WindowSelect days={days} onChange={changeDays} t={t} />
        </div>
      </header>

      <main className="px-4 md:px-8 py-6 space-y-3">
        {data && !canEdit && (
          <div className="rounded-lg border border-border bg-card text-xs p-3 text-muted-foreground">{t('scr_readonly')}</div>
        )}
        {err && <div className="rounded-lg border border-red-500/40 bg-red-500/10 text-red-500 text-sm p-3">{err}</div>}
        {tab === 'sched' && (
          <div className="rounded-lg border border-border bg-card text-xs p-3 text-muted-foreground">{t('mod_scheduled_hint', { n: days })}</div>
        )}
        {tab === 'prog' && data && progPending.length === 0 && adv.length > 0 && (
          <div className="rounded-xl border border-emerald-500/40 bg-emerald-500/10 p-4 flex items-center gap-3">
            <CheckCircle2 className="text-emerald-500" />
            <div className="flex-1 text-sm font-bold">{t('scr_all_done_advance')}</div>
            <button type="button" onClick={() => setTab('adv')} className="px-3 py-1.5 rounded-lg text-xs font-bold bg-emerald-600 text-white">
              {t('scr_go_advance')}
            </button>
          </div>
        )}
        {tab === 'adv' && progPending.length > 0 && (
          <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 text-xs p-3">
            {t('scr_advance_warning', { n: progPending.length })}
          </div>
        )}
        {tab === 'adv' && (
          <div className="relative">
            <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <input
              type="search"
              value={advQ}
              onChange={(e) => setAdvQ(e.target.value)}
              placeholder={t('scr_search_ph')}
              className="w-full pl-9 pr-24 py-2.5 rounded-lg border border-border bg-card text-sm outline-none focus:border-primary"
            />
            {advWords.length > 0 && (
              <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">
                {t('scr_search_count', { n: advShown.length, total: adv.length })}
              </span>
            )}
          </div>
        )}
        {tab === 'alert' && (
          <div className="rounded-lg border border-red-500/40 bg-red-500/10 text-xs p-3">{t('scr_alerts_hint')}</div>
        )}
        {tab === 'pre' && (
          <div className="rounded-lg border border-border bg-card text-xs p-3 text-muted-foreground">{t('scr_preorders_hint')}</div>
        )}

        {loading && !data ? (
          <div className="flex justify-center py-20"><Loader2 className="animate-spin" /></div>
        ) : list.length === 0 ? (
          <div className="text-center text-sm text-muted-foreground py-16">{t('scr_empty')}</div>
        ) : (
          (tab === 'prog' ? [...progPending, ...prog.filter((c) => !progPending.includes(c))] : list).map((c) => (
            <OrderCard onComments={openComments} key={c.order_id} c={c} t={t} canEdit={canEdit} busyKey={busyKey}
              onToggle={onToggle} onAll={onAll} mode={tab} />
          ))
        )}
      </main>
    </div>
  );
}
