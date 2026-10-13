// Programación y Producción: leen /executive/kpis, que es la MISMA cuenta que
// el Reporte Ejecutivo por correo (services/production_kpis.build_executive).
// Unidades: hits = impresiones (frente + espalda = 2); units = piezas.
import React from 'react';
import { ResponsiveContainer, ComposedChart, Bar, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend } from 'recharts';
import { Gauge, CalendarRange, Truck, AlertTriangle, Factory, Clock, Package } from 'lucide-react';
import { useLang } from '../../contexts/LanguageContext';
import { Panel, KpiTile, BarList, ChartTooltip, fmt, fmtDay, useChartTheme } from './parts';

const Unavailable = ({ kpis, section }) => {
  const { t } = useLang();
  if (!kpis?.unavailable?.includes(section)) return null;
  return (
    <div className="flex items-center gap-2 text-sm rounded-lg border border-destructive/40 px-3 py-2 text-destructive">
      <AlertTriangle className="w-4 h-4" />{t('exe_section_unavailable')}
    </div>
  );
};

const CapacityBar = ({ capacity, demand }) => {
  const { t, lang } = useLang();
  const max = Math.max(1, capacity || 0, demand || 0);
  const over = (demand || 0) > (capacity || 0);
  return (
    <div className="space-y-3">
      {[[t('exe_capacity'), capacity, false], [t('exe_demand'), demand, over]].map(([label, v, bad]) => (
        <div key={label}>
          <div className="flex justify-between text-xs mb-1">
            <span className="text-muted-foreground">{label}</span>
            <span className={`tabular-nums font-semibold ${bad ? 'text-destructive' : ''}`}>{fmt(v, lang)} {t('exe_hits')}</span>
          </div>
          <div className="h-3 rounded bg-muted overflow-hidden">
            <div className={`h-full rounded ${bad ? 'bg-destructive/80' : 'bg-primary'}`} style={{ width: `${(v || 0) / max * 100}%` }} />
          </div>
        </div>
      ))}
    </div>
  );
};

export const PlanningView = ({ kpis }) => {
  const { t, lang } = useLang();
  const w = kpis?.week, nw = kpis?.next_week, ex = kpis?.exceptions, to = kpis?.test_orders;
  const ships = (kpis?.shipments || []).map(s => ({ ...s, label: fmtDay(s.date, lang) }));
  const deltaLabel = (d) => d == null ? '—' : d >= 0 ? t('exe_slack', { n: fmt(d, lang) }) : t('exe_short', { n: fmt(-d, lang) });

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground max-w-3xl">{t('exe_desc_planning')}</p>
      <Unavailable kpis={kpis} section="planning" />
      {w && (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          <KpiTile icon={Gauge} label={t('exe_week_pending')} value={fmt(w.pending_hits, lang)} hint={t('exe_units_n', { n: fmt(w.pending_units, lang) })} />
          <KpiTile tone="alert" label={t('exe_overdue')} value={fmt(w.overdue?.orders, lang)}
            hint={t('exe_hits_n', { n: fmt(w.overdue?.hits, lang) })} />
          <KpiTile icon={CalendarRange} label={t('exe_due_week')} value={fmt(w.due?.orders, lang)} hint={t('exe_hits_n', { n: fmt(w.due?.hits, lang) })} />
          <KpiTile icon={Factory} label={t('exe_week_balance')} value={w.delta == null ? '—' : `${w.delta >= 0 ? '+' : '−'}${fmt(Math.abs(w.delta), lang)}`}
            hint={t('exe_capacity_vs_demand')} />
        </div>
      )}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {w && (
          <Panel title={t('exe_this_week')} subtitle={t('exe_week_from', { d: fmtDay(kpis.week_start, lang) })}>
            <CapacityBar capacity={w.capacity} demand={w.pending_hits} />
            <p className="text-xs text-muted-foreground mt-3">
              {t('exe_capacity_split', { reg: fmt(w.capacity_regular, lang), ot: fmt(w.capacity_overtime, lang) })}
            </p>
          </Panel>
        )}
        {nw && (
          <Panel title={t('exe_next_week')} subtitle={deltaLabel(nw.delta)}>
            <CapacityBar capacity={nw.capacity} demand={nw.demand_hits} />
            <p className="text-xs text-muted-foreground mt-3">
              {t('exe_capacity_split', { reg: fmt(nw.capacity_regular, lang), ot: fmt(nw.capacity_overtime, lang) })}
            </p>
          </Panel>
        )}
      </div>
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Panel title={t('exe_ships_7d')} subtitle={t('exe_ships_7d_sub')} right={<Truck className="w-4 h-4 text-muted-foreground" />}>
          <BarList rows={ships} labelKey="date" valueKey="units" countKey={null} formatLabel={r => r.label} empty={t('exe_no_ships')} />
        </Panel>
        <Panel title={t('exe_exceptions')} subtitle={t('exe_exceptions_sub')}>
          {ex ? (
            <ul className="divide-y divide-border text-sm">
              {[['exe_exc_status_behind', ex.status_behind], ['exe_exc_no_movement', ex.no_movement],
                ['exe_exc_machine_no_capture', ex.machine_no_capture], ['exe_exc_overprint', ex.overprint]].map(([k, n]) => (
                <li key={k} className="flex items-center justify-between py-2.5">
                  <span className="flex items-center gap-2">{n > 0 && <AlertTriangle className="w-3.5 h-3.5 text-destructive" />}{t(k)}</span>
                  <span className={`tabular-nums font-semibold ${n > 0 ? 'text-destructive' : 'text-muted-foreground'}`}>{fmt(n, lang)}</span>
                </li>
              ))}
              {to && (
                <li className="flex items-center justify-between py-2.5">
                  <span>{t('exe_test_orders_open')}</span>
                  <span className="tabular-nums font-semibold">{fmt(to.open, lang)}{to.open_overdue ? <span className="text-destructive"> · {t('exe_n_late', { n: to.open_overdue })}</span> : null}</span>
                </li>
              )}
            </ul>
          ) : <Unavailable kpis={kpis} section="audit" />}
        </Panel>
      </div>
    </div>
  );
};

export const ProductionView = ({ kpis }) => {
  const { t, lang } = useLang();
  const c = useChartTheme();
  const td = kpis?.today, yd = kpis?.yesterday;
  const days = (kpis?.week_days || []).map(d => ({ ...d, label: fmtDay(d.date, lang, { weekday: 'short', day: 'numeric' }) }));
  const pct = (b) => (b?.goal ? t('exe_pct_goal', { pct: b.pct ?? 0, goal: fmt(b.goal, lang) }) : t('exe_no_goal'));

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground max-w-3xl">{t('exe_desc_production')}</p>
      <Unavailable kpis={kpis} section="production" />
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <KpiTile icon={Factory} label={t('exe_today_hits', { h: td?.as_of || '' })} value={fmt(td?.hits, lang)} hint={pct(td)} />
        <KpiTile icon={Package} label={t('exe_today_units')} value={fmt(td?.units, lang)} hint={t('exe_pieces')} />
        <KpiTile icon={Clock} label={t('exe_yesterday_hits')} value={fmt(yd?.hits, lang)} hint={pct(yd)} />
        <KpiTile icon={Gauge} label={t('exe_week_produced')} value={fmt(kpis?.week?.produced_hits, lang)}
          hint={t('exe_units_n', { n: fmt(kpis?.week?.produced_units, lang) })} />
      </div>
      <div className="grid grid-cols-1 xl:grid-cols-5 gap-4">
        <Panel className="xl:col-span-3" title={t('exe_week_by_day')} subtitle={t('exe_week_by_day_sub')}>
          <div className="h-64">
            <ResponsiveContainer width="100%" height="100%" minWidth={0}>
              <ComposedChart data={days} margin={{ top: 8, right: 8, left: 4, bottom: 0 }}>
                <CartesianGrid vertical={false} stroke={c.grid} strokeDasharray="3 3" />
                <XAxis dataKey="label" tick={{ fill: c.muted, fontSize: 11 }} axisLine={false} tickLine={false} />
                <YAxis tick={{ fill: c.muted, fontSize: 11 }} axisLine={false} tickLine={false} width={60} tickFormatter={v => fmt(v, lang)} />
                <Tooltip cursor={{ fill: c.grid, opacity: 0.4 }} content={<ChartTooltip />} />
                <Legend iconType="plainline" wrapperStyle={{ fontSize: 12, color: c.muted }} />
                <Bar dataKey="hits" name={t('exe_hits_label')} fill={c.primary} radius={[4, 4, 0, 0]} maxBarSize={44} isAnimationActive={false} />
                <Line dataKey="goal" name={t('exe_goal')} stroke={c.fg} strokeWidth={2} strokeDasharray="4 4" dot={{ r: 3 }} connectNulls isAnimationActive={false} />
              </ComposedChart>
            </ResponsiveContainer>
          </div>
        </Panel>
        <Panel className="xl:col-span-2" title={t('exe_shifts_today')} subtitle={t('exe_hits_label')}>
          {td?.shifts?.length ? (
            <ul className="space-y-3">
              {td.shifts.map(s => (
                <li key={s.shift}>
                  <div className="flex justify-between text-xs mb-1">
                    <span className="font-medium">{s.shift}</span>
                    <span className="tabular-nums"><b>{fmt(s.hits, lang)}</b>{s.goal ? <span className="text-muted-foreground"> / {fmt(s.goal, lang)} · {s.pct}%</span> : null}</span>
                  </div>
                  <div className="h-2 rounded bg-muted overflow-hidden">
                    <div className="h-full rounded bg-primary" style={{ width: `${Math.min(100, s.goal ? s.hits / s.goal * 100 : 100)}%` }} />
                  </div>
                </li>
              ))}
            </ul>
          ) : <p className="text-sm text-muted-foreground py-6 text-center">{t('exe_no_captures')}</p>}
        </Panel>
      </div>
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Panel title={t('exe_machines_today')} subtitle={t('exe_hits_label')}>
          <BarList rows={td?.machines || []} labelKey="machine" valueKey="hits" countKey={null} empty={t('exe_no_captures')} />
        </Panel>
        <Panel title={t('exe_clients_week')} subtitle={t('exe_hits_label')}>
          <BarList rows={kpis?.week_clients || []} labelKey="client" valueKey="hits" countKey={null} />
        </Panel>
      </div>
    </div>
  );
};
