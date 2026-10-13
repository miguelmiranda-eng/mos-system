// Listas para envío: NO es un acumulado (COMPLETOS / FINAL BILL guardan órdenes
// que se fueron hace meses), es cuántas LLEGARON a listo en un periodo. Los
// tres tiles de arriba (hoy, ayer, esta semana) vienen del pipeline; el detalle
// del periodo elegido, de /executive/listo.
import React, { useEffect, useState } from 'react';
import { ResponsiveContainer, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip } from 'recharts';
import { Truck, CalendarDays, CalendarRange, RefreshCw } from 'lucide-react';
import { useLang } from '../../contexts/LanguageContext';
import { API } from '../../lib/constants';
import { apiFetch } from '../../lib/http';
import { Panel, KpiTile, BarList, OrdersTable, ChartTooltip, PeriodPicker, fmt, fmtDay, isoDay, useChartTheme } from './parts';

const PERIODS = [
  { id: 'today', labelKey: 'exe_p_today' },
  { id: 'yesterday', labelKey: 'exe_p_yesterday' },
  { id: 'week', labelKey: 'exe_p_week' },
  { id: 'custom', labelKey: 'exe_p_range' },
];

const rangeOf = (period, weekStart, from, to) => {
  const today = new Date();
  const y = new Date(); y.setDate(y.getDate() - 1);
  if (period === 'today') return [isoDay(today), isoDay(today)];
  if (period === 'yesterday') return [isoDay(y), isoDay(y)];
  if (period === 'week') return [weekStart || isoDay(today), isoDay(today)];
  return from && to ? (from > to ? [to, from] : [from, to]) : null;
};

const ListoView = ({ summary, refreshKey }) => {
  const { t, lang } = useLang();
  const c = useChartTheme();
  const [period, setPeriod] = useState('today');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const range = rangeOf(period, summary?.week_start, from, to);
  const key = range ? range.join('|') : '';

  useEffect(() => {
    if (!range) return;
    let alive = true;
    setLoading(true);
    setError('');
    apiFetch(`${API}/executive/listo?date_from=${range[0]}&date_to=${range[1]}`)
      .then(async r => {
        const body = await r.json().catch(() => null);
        if (!alive) return;
        if (r.ok) setData(body);
        else setError(body?.detail || t('exe_load_error'));
      })
      .catch(() => alive && setError(t('exe_load_error')))
      .finally(() => alive && setLoading(false));
    return () => { alive = false; };
  }, [key, refreshKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const multiDay = data && data.days.length > 1;
  const chart = (data?.days || []).map(d => ({ ...d, label: fmtDay(d.date, lang, { weekday: 'short', day: 'numeric', month: 'short' }) }));
  const tile = (id, icon, labelKey, s) => (
    <KpiTile icon={icon} label={t(labelKey)} value={fmt(s?.pieces, lang)} active={period === id}
      hint={t('exe_wip_hint', { n: fmt(s?.count, lang) })} onClick={() => setPeriod(id)} />
  );

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground max-w-3xl">{t('exe_desc_listo')}</p>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        {tile('today', Truck, 'exe_listo_k_today', summary?.today)}
        {tile('yesterday', CalendarDays, 'exe_listo_k_yesterday', summary?.yesterday)}
        {tile('week', CalendarRange, 'exe_listo_k_week', summary?.week)}
      </div>

      <div className="flex items-center gap-3 flex-wrap pt-2">
        <PeriodPicker periods={PERIODS} value={period} onChange={setPeriod} from={from} to={to}
          onRange={(f, tt) => { setFrom(f); setTo(tt); }} />
        {range && (
          <span className="text-xs text-muted-foreground">
            {range[0] === range[1] ? fmtDay(range[0], lang) : `${fmtDay(range[0], lang)} – ${fmtDay(range[1], lang)}`}
          </span>
        )}
        {loading && <RefreshCw className="w-4 h-4 animate-spin text-muted-foreground" />}
      </div>

      {!range && <p className="text-sm text-muted-foreground py-8 text-center">{t('exe_pick_range')}</p>}
      {error && <p className="text-sm text-destructive">{error}</p>}

      {range && data && (
        <>
          {period === 'custom' && <div className="grid grid-cols-2 gap-3 max-w-xl">
            <KpiTile icon={Truck} label={t('exe_pieces')} value={fmt(data.pieces, lang)} hint={t('exe_period_selected')} />
            <KpiTile icon={Truck} label={t('exe_orders')} value={fmt(data.count, lang)} hint={t('exe_period_selected')} />
          </div>}
          <div className={`grid grid-cols-1 gap-4 ${multiDay ? 'xl:grid-cols-5' : 'lg:grid-cols-2'}`}>
            {multiDay && (
              <Panel className="xl:col-span-3" title={t('exe_listo_daily_title')} subtitle={t('exe_listo_daily_sub')}>
                <div className="h-64">
                  <ResponsiveContainer width="100%" height="100%" minWidth={0}>
                    <BarChart data={chart} margin={{ top: 8, right: 8, left: 4, bottom: 0 }}>
                      <CartesianGrid vertical={false} stroke={c.grid} strokeDasharray="3 3" />
                      <XAxis dataKey="label" tick={{ fill: c.muted, fontSize: 11 }} axisLine={false} tickLine={false} interval="preserveStartEnd" />
                      <YAxis tick={{ fill: c.muted, fontSize: 11 }} axisLine={false} tickLine={false} width={60} tickFormatter={v => fmt(v, lang)} />
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
            )}
            <div className={`grid grid-cols-1 gap-4 ${multiDay ? 'xl:col-span-2' : 'lg:col-span-2 lg:grid-cols-2'}`}>
              <Panel title={t('exe_by_status')} subtitle={t('exe_by_pieces')}>
                <BarList rows={data.by_status} labelKey="status" empty={t('exe_listo_none')} />
              </Panel>
              <Panel title={t('exe_top_clients')} subtitle={t('exe_by_pieces')}>
                <BarList rows={data.by_client} labelKey="client" empty={t('exe_listo_none')} />
              </Panel>
            </div>
          </div>
          <Panel title={t('exe_listo_orders')} subtitle={t('exe_listo_orders_sub')}>
            <OrdersTable rows={data.orders} truncated={data.truncated}
              extraCol={{ key: 'arrived_on', label: t('exe_col_arrived'),
                render: r => <span className="whitespace-nowrap text-xs">{multiDay ? `${fmtDay(r.arrived_on, lang, { day: 'numeric', month: 'short' })} · ` : ''}{r.arrived_at}</span> }} />
          </Panel>
        </>
      )}
    </div>
  );
};

export default ListoView;
