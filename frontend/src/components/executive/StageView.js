// Un dashboard por etapa del proceso. Las reglas de qué orden cae en qué
// etapa viven en el backend (routers/executive.py); aquí sólo se pinta.
import React, { useMemo } from 'react';
import { ResponsiveContainer, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip } from 'recharts';
import { Package, Layers, CalendarClock, Truck } from 'lucide-react';
import { useLang } from '../../contexts/LanguageContext';
import { Panel, KpiTile, BarList, AgingBars, OrdersTable, ChartTooltip, fmt, fmtDay, useChartTheme } from './parts';

const ListoDaily = ({ daily }) => {
  const { t, lang } = useLang();
  const c = useChartTheme();
  const days = daily?.days || [];
  const today = days[days.length - 1] || { count: 0, pieces: 0 };
  // Promedio de los días ANTERIORES con llegadas: comparar contra días en
  // cero (fines de semana) haría ver cualquier día como récord.
  const prev = days.slice(0, -1).filter(d => d.count > 0);
  const avg = prev.length ? Math.round(prev.reduce((s, d) => s + d.pieces, 0) / prev.length) : null;
  const total14 = days.reduce((s, d) => s + d.pieces, 0);
  const orders14 = days.reduce((s, d) => s + d.count, 0);
  const data = days.map(d => ({ ...d, label: fmtDay(d.date, lang, { day: 'numeric', month: 'short' }) }));

  return (
    <>
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <KpiTile icon={Truck} label={t('exe_listo_today_orders')} value={fmt(today.count, lang)} hint={t('exe_listo_today_hint')} />
        <KpiTile icon={Package} label={t('exe_listo_today_pieces')} value={fmt(today.pieces, lang)}
          hint={avg != null ? t('exe_vs_avg', { n: fmt(avg, lang) }) : ''} />
        <KpiTile icon={Layers} label={t('exe_listo_14d')} value={fmt(total14, lang)} hint={t('exe_pieces')} />
        <KpiTile icon={CalendarClock} label={t('exe_listo_14d_orders')} value={fmt(orders14, lang)} hint={t('exe_orders')} />
      </div>
      <div className="grid grid-cols-1 xl:grid-cols-5 gap-4">
        <Panel className="xl:col-span-3" title={t('exe_listo_daily_title')} subtitle={t('exe_listo_daily_sub')}>
          <div className="h-64">
            <ResponsiveContainer width="100%" height="100%" minWidth={0}>
              <BarChart data={data} margin={{ top: 8, right: 4, left: -8, bottom: 0 }}>
                <CartesianGrid vertical={false} stroke={c.grid} strokeDasharray="3 3" />
                <XAxis dataKey="label" tick={{ fill: c.muted, fontSize: 11 }} axisLine={false} tickLine={false} interval="preserveStartEnd" />
                <YAxis tick={{ fill: c.muted, fontSize: 11 }} axisLine={false} tickLine={false} width={48}
                  tickFormatter={v => fmt(v, lang)} />
                <Tooltip cursor={{ fill: c.grid, opacity: 0.4 }}
                  content={({ active, payload, label }) => {
                    const d = payload?.[0]?.payload;
                    return <ChartTooltip active={active} payload={payload} label={label}
                      rows={d ? [{ name: t('exe_pieces'), value: d.pieces, color: c.primary }, { name: t('exe_orders'), value: d.count },
                        ...Object.entries(d.by_status || {}).map(([k, v]) => ({ name: k, value: v }))] : []} />;
                  }} />
                <Bar dataKey="pieces" name={t('exe_pieces')} fill={c.primary} radius={[4, 4, 0, 0]} maxBarSize={36} isAnimationActive={false} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </Panel>
        <Panel className="xl:col-span-2" title={t('exe_listo_today_list')} subtitle={t('exe_listo_today_list_sub', { n: daily?.today?.length || 0 })}>
          {daily?.today?.length ? (
            <ul className="divide-y divide-border max-h-64 overflow-auto -mx-1">
              {daily.today.map(o => (
                <li key={o.order_id} className="px-1 py-2 flex items-center gap-3 text-sm">
                  <span className="w-12 shrink-0 text-xs tabular-nums text-muted-foreground">{o.arrived_at}</span>
                  <span className="font-semibold">{o.order_number}</span>
                  <span className="truncate text-muted-foreground">{o.client}</span>
                  <span className="ml-auto shrink-0 text-xs text-muted-foreground hidden sm:inline">{(o.production_status || '').replace('LISTO PARA ', '')}</span>
                  <span className="shrink-0 tabular-nums font-semibold w-16 text-right">{fmt(o.quantity, lang)}</span>
                </li>
              ))}
            </ul>
          ) : <p className="text-sm text-muted-foreground py-10 text-center">{t('exe_listo_none_today')}</p>}
        </Panel>
      </div>
    </>
  );
};

const StageView = ({ stage, meta, daily }) => {
  const { t, lang } = useLang();
  const clients = useMemo(() => stage?.by_client || [], [stage]);
  if (!stage) return null;
  const statusField = stage.key === 'blanks' ? 'blank_status' : 'production_status';

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground max-w-3xl">{t(meta.descKey)}</p>
      {stage.key === 'listo' && <ListoDaily daily={daily} />}
      {stage.key === 'listo' && <h3 className="text-sm font-semibold pt-2">{t('exe_listo_backlog')}</h3>}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <KpiTile icon={Layers} label={t('exe_orders')} value={fmt(stage.count, lang)} />
        <KpiTile icon={Package} label={t('exe_pieces')} value={fmt(stage.pieces, lang)} />
        <KpiTile tone="alert" label={t('exe_late')} value={fmt(stage.late, lang)}
          hint={stage.late ? t('exe_late_pieces', { n: fmt(stage.late_pieces, lang) }) : t('exe_late_none')} />
        <KpiTile icon={CalendarClock} label={t('exe_due7')} value={fmt(stage.due_7d, lang)} hint={t('exe_due7_hint')} />
      </div>
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <Panel title={stage.key === 'blanks' ? t('exe_by_blank_status') : t('exe_by_status')} subtitle={t('exe_by_pieces')}>
          <BarList rows={stage.by_status} labelKey="status" />
        </Panel>
        <Panel title={t('exe_aging')} subtitle={t(stage.key === 'blanks' ? 'exe_aging_sub_blanks' : 'exe_aging_sub')}>
          <AgingBars aging={stage.aging} />
        </Panel>
        <Panel title={t('exe_top_clients')} subtitle={t('exe_by_pieces')}>
          <BarList rows={clients} labelKey="client" />
        </Panel>
      </div>
      <Panel title={t('exe_orders_in_stage')} subtitle={t('exe_orders_in_stage_sub')}>
        <OrdersTable rows={stage.orders} statusField={statusField} truncated={stage.truncated}
          daysLabel={t(stage.key === 'blanks' ? 'exe_col_days_open' : 'exe_col_days')} />
      </Panel>
    </div>
  );
};

export default StageView;
