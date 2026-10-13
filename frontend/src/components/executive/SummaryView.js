// Resumen: el proceso completo en una pantalla. Cada etapa es una barra del
// embudo (piezas) que lleva a su dashboard; abajo, lo que ya está atrasado.
import React, { useMemo } from 'react';
import { AlertTriangle, ChevronRight, Package, Truck, Factory, Layers } from 'lucide-react';
import { useLang } from '../../contexts/LanguageContext';
import { Panel, KpiTile, OrdersTable, fmt } from './parts';

const SummaryView = ({ pipeline, kpis, stageMeta, onOpen }) => {
  const { t, lang } = useLang();
  const stages = pipeline?.stages || [];
  const byKey = Object.fromEntries(stages.map(s => [s.key, s]));
  const open = stages.filter(s => s.key !== 'listo');
  const wip = open.reduce((s, x) => s + x.pieces, 0);
  const wipOrders = open.reduce((s, x) => s + x.count, 0);
  const lateTotal = open.reduce((s, x) => s + x.late, 0);
  const todayArr = pipeline?.listo_daily?.days?.slice(-1)[0];
  const max = Math.max(1, ...stages.map(s => s.pieces));
  const prodToday = kpis?.today;

  // Atrasadas de todas las etapas abiertas, la más vencida primero.
  const late = useMemo(() => open
    .flatMap(s => s.orders.filter(o => o.late).map(o => ({ ...o, stage: s.key })))
    .sort((a, b) => (a.cancel_date || '').localeCompare(b.cancel_date || '')), [open]);

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <KpiTile icon={Layers} label={t('exe_wip')} value={fmt(wip, lang)} hint={t('exe_wip_hint', { n: fmt(wipOrders, lang) })} />
        <KpiTile tone="alert" label={t('exe_late_total')} value={fmt(lateTotal, lang)} hint={t('exe_late_total_hint')} />
        <KpiTile icon={Truck} label={t('exe_listo_today_pieces')} value={fmt(todayArr?.pieces, lang)}
          hint={t('exe_wip_hint', { n: fmt(todayArr?.count, lang) })} onClick={() => onOpen('listo')} />
        <KpiTile icon={Factory} label={t('exe_prod_today')} value={prodToday ? fmt(prodToday.hits, lang) : '—'}
          hint={prodToday?.goal ? t('exe_prod_vs_goal', { pct: prodToday.pct ?? 0, goal: fmt(prodToday.goal, lang) }) : t('exe_no_goal')}
          onClick={() => onOpen('produccion_kpi')} />
      </div>

      <Panel title={t('exe_funnel')} subtitle={t('exe_funnel_sub')}>
        <ol className="space-y-2">
          {stageMeta.map((m, i) => {
            const s = byKey[m.key];
            if (!s) return null;
            const Icon = m.icon;
            return (
              <li key={m.key}>
                <button type="button" onClick={() => onOpen(m.key)}
                  className="w-full grid grid-cols-[1.5rem_1fr_auto] sm:grid-cols-[1.5rem_12rem_1fr_auto] items-center gap-x-3 gap-y-1.5 p-2 -mx-2 rounded-lg hover:bg-muted/50 text-left group">
                  <span className="text-xs text-muted-foreground tabular-nums">{i + 1}</span>
                  <span className="flex items-center gap-2 min-w-0">
                    <Icon className="w-4 h-4 shrink-0 text-muted-foreground group-hover:text-primary" />
                    <span className="text-sm font-medium truncate">{t(m.labelKey)}</span>
                  </span>
                  <span className="h-6 rounded bg-muted overflow-hidden col-span-3 sm:col-span-1 order-last sm:order-none">
                    <span className="block h-full rounded bg-primary" style={{ width: `${Math.max(1, s.pieces / max * 100)}%` }} />
                  </span>
                  <span className="flex items-center gap-3 text-xs tabular-nums whitespace-nowrap">
                    <span><b className="text-sm text-foreground">{fmt(s.pieces, lang)}</b> <span className="text-muted-foreground hidden sm:inline">{t('exe_pcs')}</span></span>
                    <span className="text-muted-foreground w-16 text-right hidden sm:inline">{fmt(s.count, lang)} {t('exe_orders_short')}</span>
                    <span className={`w-20 text-right hidden md:inline-flex items-center justify-end gap-1 ${s.late ? 'text-destructive font-semibold' : 'text-muted-foreground'}`}>
                      {s.late > 0 && <AlertTriangle className="w-3 h-3" />}{s.late > 0 ? t('exe_n_late', { n: s.late }) : '—'}
                    </span>
                    <ChevronRight className="w-4 h-4 text-muted-foreground" />
                  </span>
                </button>
              </li>
            );
          })}
        </ol>
      </Panel>

      <Panel title={t('exe_attention')} subtitle={t('exe_attention_sub')}
        right={<Package className="w-4 h-4 text-muted-foreground" />}>
        <OrdersTable rows={late} extraCol={{ key: 'stage', label: t('exe_col_stage'),
          render: (r) => t(stageMeta.find(m => m.key === r.stage)?.labelKey || r.stage) }} />
      </Panel>
    </div>
  );
};

export default SummaryView;
