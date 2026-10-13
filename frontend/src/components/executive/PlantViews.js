// Programación y Producción: leen /executive/kpis, que es la MISMA cuenta que
// el Reporte Ejecutivo por correo (services/production_kpis.build_executive).
// Unidades: hits = impresiones (frente + espalda = 2); units = piezas.
// Plan vs real (meta por día y turno contra lo producido) vive SÓLO en
// Programación (/executive/plan); Producción muestra producción, sin metas.
import React, { useCallback, useEffect, useState } from 'react';
import { ResponsiveContainer, ComposedChart, Bar, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend } from 'recharts';
import { Gauge, CalendarRange, Truck, AlertTriangle, Factory, Clock, Package, Target, Pencil, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { useLang } from '../../contexts/LanguageContext';
import { API } from '../../lib/constants';
import { apiFetch } from '../../lib/http';
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

const CapacityBar = ({ capacity, demand, capLabel, demandLabel }) => {
  const { t, lang } = useLang();
  const max = Math.max(1, capacity || 0, demand || 0);
  const over = (demand || 0) > (capacity || 0);
  return (
    <div className="space-y-3">
      {[[capLabel || t('exe_capacity'), capacity, false], [demandLabel || t('exe_demand'), demand, over]].map(([label, v, bad]) => (
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

// ── Plan vs real de la semana ───────────────────────────────────────────────
// Meta por día y turno (la ponen las personas, de mañana en adelante) contra lo
// producido. Sólo se califica lo cerrado; turno cerrado bajo el 80% = riesgo.
const SHIFT_LABEL = { 'TURNO 1': 'exe_plan_day_shift', 'TURNO 2': 'exe_plan_night_shift' };

const PctBadge = ({ p, risk, riskPct }) => {
  if (p == null) return null;
  const cls = risk ? 'bg-destructive/15 text-destructive' : p >= 100 ? 'bg-emerald-500/15 text-emerald-600' : p >= riskPct ? 'bg-amber-500/15 text-amber-600' : 'bg-destructive/15 text-destructive';
  return <span className={`ml-1.5 px-1.5 py-0.5 rounded text-[11px] font-semibold tabular-nums ${cls}`}>{p}%</span>;
};

const thisMonday = () => {
  const d = new Date();
  const back = (d.getDay() + 6) % 7;
  d.setDate(d.getDate() - back);
  return d.toISOString().slice(0, 10);
};
const plusDays = (iso, n) => {
  const [y, m, dd] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, dd + n)).toISOString().slice(0, 10);
};

const PlanWeek = () => {
  const { t, lang } = useLang();
  const c = useChartTheme();
  const [week, setWeek] = useState(thisMonday());
  const [data, setData] = useState(null);
  const [edit, setEdit] = useState(null);         // {date: {'TURNO 1': '', 'TURNO 2': ''}}
  const [busy, setBusy] = useState(false);

  const load = useCallback(async (w) => {
    try {
      const r = await apiFetch(`${API}/executive/plan?week=${w}`);
      if (!r.ok) throw new Error();
      setData(await r.json());
    } catch { setData(null); }
  }, []);
  useEffect(() => { setEdit(null); load(week); }, [week, load]);

  const startEdit = () => setEdit(Object.fromEntries((data?.days || []).filter(d => d.editable).map(d => [d.date,
    Object.fromEntries((data.shifts || []).map(k => [k, d.shifts[k].goal ? String(d.shifts[k].goal) : '']))])));
  const fillCapacity = () => setEdit(Object.fromEntries((data?.days || []).filter(d => d.editable).map(d => [d.date,
    Object.fromEntries((data.shifts || []).map(k => [k, d.capacity?.[k] ? String(d.capacity[k]) : '']))])));
  const save = async () => {
    setBusy(true);
    try {
      const days = Object.entries(edit).map(([date, v]) => ({ date, shifts: Object.fromEntries(Object.entries(v).map(([k, x]) => [k, Math.max(0, Math.round(Number(x) || 0))])) }));
      const r = await apiFetch(`${API}/executive/plan`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ week_start: week, days }) });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail || 'Error');
      toast.success(t('exe_plan_saved'));
      setEdit(null);
      await load(week);
    } catch (e) { toast.error(e.message); } finally { setBusy(false); }
  };

  if (!data) return <Panel title={t('exe_plan_title')}><div className="py-10 flex justify-center"><Loader2 className="w-5 h-5 animate-spin text-muted-foreground" /></div></Panel>;
  const tot = data.totals || {};
  const keys = data.shifts || [];
  const riskPct = data.risk_pct || 80;
  const anyGoal = data.days.some(d => d.goal);
  const anyEditable = data.days.some(d => d.editable);
  const chart = data.days.map(d => ({ label: fmtDay(d.date, lang, { weekday: 'short', day: 'numeric' }),
    hits: d.state === 'future' ? null : d.actual, goal: d.goal || null }));
  const curWeek = thisMonday();
  const weekBtn = (w, label) => (
    <button key={w} onClick={() => setWeek(w)}
      className={`h-8 px-3 rounded-md text-xs font-semibold border ${week === w ? 'bg-primary text-primary-foreground border-primary' : 'border-border text-muted-foreground hover:text-foreground'}`}>{label}</button>
  );

  return (
    <Panel title={t('exe_plan_title')} subtitle={t('exe_plan_sub', { w: data.iso_week, d: fmtDay(data.week_start, lang), r: riskPct })}
      right={<div className="flex items-center gap-1.5">
        {/* Semanas pasadas: ‹ retrocede una semana (ya cerradas, sólo lectura). */}
        <button onClick={() => setWeek(plusDays(week, -7))} title={t('exe_plan_prev_week')}
          className="h-8 w-8 rounded-md text-sm font-bold border border-border text-muted-foreground hover:text-foreground">‹</button>
        {week < curWeek && (
          <span className="px-2 text-xs font-semibold tabular-nums">{t('exe_plan_week_n', { w: data.iso_week })}</span>
        )}
        {weekBtn(curWeek, t('exe_this_week'))}
        {weekBtn(plusDays(curWeek, 7), t('exe_next_week'))}
        {!edit && anyEditable && (
          <button onClick={startEdit} className="h-8 px-3 rounded-md text-xs font-semibold border border-border inline-flex items-center gap-1.5 hover:bg-muted">
            <Pencil className="w-3.5 h-3.5" />{t('exe_plan_edit')}
          </button>
        )}
      </div>}>
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <KpiTile icon={Target} label={t('exe_plan_week_goal')} value={anyGoal ? fmt(tot.plan_week, lang) : '—'}
          hint={t('exe_plan_capacity_hint', { n: fmt(tot.capacity_week, lang) })} />
        <KpiTile icon={Factory} label={t('exe_plan_actual_to_date')} value={fmt(tot.actual_to_date, lang)} />
        <KpiTile icon={Gauge} tone={tot.score != null && tot.score < riskPct ? 'alert' : undefined} label={t('exe_plan_score')}
          value={tot.score == null ? '—' : `${tot.score}%`}
          hint={tot.plan_closed ? t('exe_plan_score_hint', { a: fmt(tot.actual_closed, lang), g: fmt(tot.plan_closed, lang) }) : t('exe_plan_no_closed')} />
        <KpiTile icon={AlertTriangle} tone={tot.risk ? 'alert' : undefined} label={t('exe_plan_risk')} value={fmt(tot.risk, lang)}
          hint={t('exe_plan_risk_hint', { r: riskPct })} />
      </div>

      {!anyGoal && !edit && <p className="mt-3 text-xs text-amber-600">{t('exe_plan_no_goals')}</p>}

      <div className="grid grid-cols-1 xl:grid-cols-5 gap-4 mt-4">
        <div className="xl:col-span-2 h-60">
          <ResponsiveContainer width="100%" height="100%" minWidth={0}>
            <ComposedChart data={chart} margin={{ top: 8, right: 8, left: 4, bottom: 0 }}>
              <CartesianGrid vertical={false} stroke={c.grid} strokeDasharray="3 3" />
              <XAxis dataKey="label" tick={{ fill: c.muted, fontSize: 11 }} axisLine={false} tickLine={false} />
              <YAxis tick={{ fill: c.muted, fontSize: 11 }} axisLine={false} tickLine={false} width={56} tickFormatter={v => fmt(v, lang)} />
              <Tooltip cursor={{ fill: c.grid, opacity: 0.4 }} content={<ChartTooltip />} />
              <Legend iconType="plainline" wrapperStyle={{ fontSize: 12, color: c.muted }} />
              <Bar dataKey="hits" name={t('exe_hits_label')} fill={c.primary} radius={[4, 4, 0, 0]} maxBarSize={40} isAnimationActive={false} />
              <Line dataKey="goal" name={t('exe_goal')} stroke={c.fg} strokeWidth={2} strokeDasharray="4 4" dot={{ r: 3 }} connectNulls isAnimationActive={false} />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
        <div className="xl:col-span-3 overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead><tr className="text-left text-[11px] uppercase tracking-wider text-muted-foreground">
              <th className="py-1.5 pr-3">{t('exe_plan_day')}</th>
              {keys.map(k => <th key={k} className="pr-3">{t(SHIFT_LABEL[k] || k)} <span className="normal-case font-normal">({t('exe_plan_goal_actual')})</span></th>)}
              <th className="text-right">{t('exe_plan_total')}</th>
            </tr></thead>
            <tbody className="divide-y divide-border">
              {data.days.map(d => (
                <tr key={d.date} className={d.state === 'future' ? 'text-muted-foreground' : d.state === 'today' ? 'bg-primary/5' : ''}>
                  <td className="py-1.5 pr-3 whitespace-nowrap">
                    <span className="font-medium">{fmtDay(d.date, lang)}</span>
                    {d.state === 'today' && <span className="ml-1.5 px-1.5 py-0.5 rounded text-[10px] font-semibold bg-primary/15 text-primary">{t('exe_plan_in_progress')}</span>}
                    {d.goal_source === 'default' && <span className="ml-1.5 text-[10px] text-muted-foreground">{t('exe_plan_default_goal')}</span>}
                    {d.no_shift ? <div className="text-[10px] text-amber-600">{t('exe_plan_no_shift', { n: fmt(d.no_shift, lang) })}</div> : null}
                  </td>
                  {keys.map(k => {
                    const sc = d.shifts[k];
                    if (edit && d.editable) {
                      return (
                        <td key={k} className="pr-3">
                          <input type="number" min="0" inputMode="numeric" value={edit[d.date]?.[k] ?? ''} placeholder={d.capacity?.[k] ? fmt(d.capacity[k], lang) : '0'}
                            onChange={e => setEdit({ ...edit, [d.date]: { ...edit[d.date], [k]: e.target.value } })}
                            className="h-8 w-28 px-2 rounded-md bg-secondary border border-border text-sm text-right tabular-nums outline-none focus:border-primary" />
                        </td>
                      );
                    }
                    return (
                      <td key={k} className={`pr-3 tabular-nums whitespace-nowrap ${sc.risk ? 'text-destructive' : ''}`}>
                        {sc.goal ? <span className="text-muted-foreground">{fmt(sc.goal, lang)} / </span> : null}
                        {!sc.goal && !sc.actual ? <span className="text-muted-foreground">—</span>
                          : d.state === 'future' ? '—' : <b>{fmt(sc.actual, lang)}</b>}
                        {!sc.goal && sc.actual ? <span className="ml-1.5 text-[10px] text-amber-600">{t('exe_plan_no_goal')}</span> : null}
                        {d.state === 'closed' && <PctBadge p={sc.pct} risk={sc.risk} riskPct={riskPct} />}
                      </td>
                    );
                  })}
                  <td className="text-right tabular-nums whitespace-nowrap">
                    {d.goal ? <span className="text-muted-foreground">{fmt(d.goal, lang)} / </span> : null}
                    <b>{d.state === 'future' ? '—' : fmt(d.actual, lang)}</b>
                    {d.state === 'closed' && <PctBadge p={d.pct} riskPct={riskPct} />}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {edit && (
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <button onClick={fillCapacity} className="h-8 px-3 rounded-md text-xs font-semibold border border-border hover:bg-muted">{t('exe_plan_fill_capacity')}</button>
              <span className="text-[11px] text-muted-foreground">{t('exe_plan_edit_hint')}</span>
              <span className="ml-auto flex gap-2">
                <button onClick={() => setEdit(null)} className="h-8 px-3 rounded-md text-xs font-semibold border border-border">{t('exe_plan_cancel')}</button>
                <button onClick={save} disabled={busy} className="h-8 px-4 rounded-md text-xs font-bold bg-primary text-primary-foreground disabled:opacity-60">
                  {busy ? t('exe_plan_saving') : t('exe_plan_save')}
                </button>
              </span>
            </div>
          )}
        </div>
      </div>
    </Panel>
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
      <PlanWeek />
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
            {/* Dos datos: la capacidad de la semana completa (desde el lunes) y
                la que queda desde hoy, que es la que se compara con lo que falta. */}
            {w.capacity_week != null && (
              <div className="flex items-baseline justify-between mb-3 pb-3 border-b border-border">
                <span className="text-xs text-muted-foreground">{t('exe_capacity_week')}</span>
                <span className="tabular-nums font-semibold">{fmt(w.capacity_week, lang)} {t('exe_hits')}</span>
              </div>
            )}
            <CapacityBar capacity={w.capacity} demand={w.pending_hits}
              capLabel={t('exe_capacity_left')} demandLabel={t('exe_demand_left')} />
            <p className="text-xs text-muted-foreground mt-3">
              {w.capacity_week != null
                ? t('exe_capacity_split_week', { reg: fmt(w.capacity_week_regular, lang), ot: fmt(w.capacity_week_overtime, lang),
                  left: fmt(w.capacity, lang) })
                : t('exe_capacity_split', { reg: fmt(w.capacity_regular, lang), ot: fmt(w.capacity_overtime, lang) })}
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
  const td = kpis?.today, yd = kpis?.yesterday;

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground max-w-3xl">{t('exe_desc_production')}</p>
      <Unavailable kpis={kpis} section="production" />
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <KpiTile icon={Factory} label={t('exe_today_hits', { h: td?.as_of || '' })} value={fmt(td?.hits, lang)} />
        <KpiTile icon={Package} label={t('exe_today_units')} value={fmt(td?.units, lang)} hint={t('exe_pieces')} />
        <KpiTile icon={Clock} label={t('exe_yesterday_hits')} value={fmt(yd?.hits, lang)} />
        <KpiTile icon={Gauge} label={t('exe_week_produced')} value={fmt(kpis?.week?.produced_hits, lang)}
          hint={t('exe_units_n', { n: fmt(kpis?.week?.produced_units, lang) })} />
      </div>
      <p className="text-xs text-muted-foreground">{t('exe_prod_goals_moved')}</p>
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
