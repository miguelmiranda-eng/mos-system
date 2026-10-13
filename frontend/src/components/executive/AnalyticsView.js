// Analítica histórica: lo que mostraba la vista CEO vieja (/production-analytics
// + exportar Excel/PDF), con las piezas comunes de la vista ejecutiva.
import React, { useEffect, useMemo, useState } from 'react';
import { ResponsiveContainer, AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip } from 'recharts';
import { Factory, Gauge, Timer, Hourglass, Download, RefreshCw } from 'lucide-react';
import { toast } from 'sonner';
import { useLang } from '../../contexts/LanguageContext';
import { API } from '../../lib/constants';
import { apiFetch } from '../../lib/http';
import { Panel, KpiTile, BarList, ChartTooltip, PeriodPicker, fmt, fmtDay, isoDay, useChartTheme } from './parts';

const PERIODS = [
  { id: 'today', labelKey: 'exe_p_today' },
  { id: 'yesterday', labelKey: 'exe_p_yesterday' },
  { id: 'week', labelKey: 'exe_p_7d' },
  { id: 'month', labelKey: 'exe_p_30d' },
  { id: 'custom', labelKey: 'exe_p_range' },
];
const SHIFTS = ['', 'TURNO 1', 'TURNO 2', 'TURNO 3'];

const AnalyticsView = ({ refreshKey }) => {
  const { t, lang } = useLang();
  const c = useChartTheme();
  const [period, setPeriod] = useState('week');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [shift, setShift] = useState('');
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);

  const [f, tt] = from && to && from > to ? [to, from] : [from, to];
  const ready = period !== 'custom' || Boolean(f && tt);
  const query = (period === 'custom' ? `preset=custom&date_from=${f}&date_to=${tt}` : `preset=${period}`)
    + (shift ? `&shift=${encodeURIComponent(shift)}` : '');
  const singleDay = period === 'today' || period === 'yesterday' || (period === 'custom' && f === tt);

  useEffect(() => {
    if (!ready) return;
    let alive = true;
    setLoading(true);
    apiFetch(`${API}/production-analytics?${query}`)
      .then(r => (r.ok ? r.json() : Promise.reject()))
      .then(d => alive && setData(d))
      .catch(() => alive && toast.error(t('exe_load_error')))
      .finally(() => alive && setLoading(false));
    return () => { alive = false; };
  }, [query, ready, refreshKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const trend = useMemo(() => {
    if (!data) return [];
    if (singleDay) return (data.hourly_trend || []).map(h => ({ label: `${String(h.hour).slice(11, 13)}:00`, produced: h.produced }));
    return (data.by_day || []).map(d => ({ label: fmtDay(d.date, lang, { day: 'numeric', month: 'short' }), produced: d.produced }));
  }, [data, singleDay, lang]);

  const exportReport = async (format) => {
    const today = isoDay(new Date());
    const back = (n) => { const d = new Date(); d.setDate(d.getDate() - n); return isoDay(d); };
    const filters = period === 'custom' ? { date_from: f, date_to: tt }
      : period === 'today' ? { date_from: today, date_to: today }
      : period === 'yesterday' ? { date_from: back(1), date_to: back(1) }
      : period === 'week' ? { date_from: back(7), date_to: today }
      : { date_from: back(30), date_to: today };
    try {
      const res = await fetch(`${API}/production-report`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
        body: JSON.stringify({ format, filters }),
      });
      if (!res.ok) throw new Error();
      const { data: b64, filename, content_type } = await res.json();
      const a = document.createElement('a');
      a.href = `data:${content_type};base64,${b64}`;
      a.download = filename;
      a.click();
    } catch { toast.error(t('exe_export_error')); }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 flex-wrap">
        <PeriodPicker periods={PERIODS} value={period} onChange={setPeriod} from={from} to={to}
          onRange={(a, b) => { setFrom(a); setTo(b); }} />
        <div className="flex items-center gap-1 p-1 rounded-lg bg-muted/60 border border-border">
          {SHIFTS.map(s => (
            <button key={s || 'all'} type="button" onClick={() => setShift(s)}
              className={`px-3 py-1.5 rounded-md text-xs font-medium ${shift === s ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground'}`}>
              {s ? s.replace('TURNO ', 'T') : t('exe_all_shifts')}
            </button>
          ))}
        </div>
        {loading && <RefreshCw className="w-4 h-4 animate-spin text-muted-foreground" />}
        <div className="ml-auto flex items-center gap-2">
          {['excel', 'pdf'].map(fmtName => (
            <button key={fmtName} type="button" onClick={() => exportReport(fmtName)} disabled={!ready}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-border text-xs font-medium text-muted-foreground hover:text-foreground hover:bg-muted disabled:opacity-50">
              <Download className="w-3.5 h-3.5" />{fmtName.toUpperCase()}
            </button>
          ))}
        </div>
      </div>

      {!ready && <p className="text-sm text-muted-foreground py-8 text-center">{t('exe_pick_range')}</p>}
      {ready && data && (
        <>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            <KpiTile icon={Factory} label={t('exe_an_produced')} value={fmt(data.total_produced, lang)}
              hint={t('exe_an_records', { n: fmt(data.total_logs, lang) })} />
            <KpiTile icon={Gauge} label={t('exe_an_efficiency')} value={data.efficiency != null ? `${data.efficiency}%` : '—'}
              hint={data.goal ? t('exe_an_goal', { n: fmt(data.goal, lang) }) : t('exe_no_goal')} />
            <KpiTile icon={Timer} label={t('exe_an_setup')} value={`${fmt(data.avg_setup, lang)} min`} hint={t('exe_an_setup_hint')} />
            <KpiTile icon={Hourglass} label={t('exe_an_remaining')} value={fmt(data.total_remaining, lang)} hint={t('exe_an_remaining_hint')} />
          </div>
          <Panel title={t('exe_an_trend')} subtitle={singleDay ? t('exe_an_per_hour') : t('exe_an_per_day')}>
            <div className="h-72">
              <ResponsiveContainer width="100%" height="100%" minWidth={0}>
                <AreaChart data={trend} margin={{ top: 8, right: 8, left: 4, bottom: 0 }}>
                  <CartesianGrid vertical={false} stroke={c.grid} strokeDasharray="3 3" />
                  <XAxis dataKey="label" tick={{ fill: c.muted, fontSize: 11 }} axisLine={false} tickLine={false} interval="preserveStartEnd" />
                  <YAxis tick={{ fill: c.muted, fontSize: 11 }} axisLine={false} tickLine={false} width={60} tickFormatter={v => fmt(v, lang)} />
                  <Tooltip content={<ChartTooltip />} />
                  <Area dataKey="produced" name={t('exe_hits_label')} stroke={c.primary} strokeWidth={2}
                    fill={c.primary} fillOpacity={0.15} isAnimationActive={false} />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          </Panel>
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
            <Panel title={t('exe_an_by_machine')} subtitle={t('exe_hits_label')}>
              <BarList rows={data.by_machine || []} labelKey="machine" valueKey="produced" countKey={null} />
            </Panel>
            <Panel title={t('exe_an_by_client')} subtitle={t('exe_hits_label')}>
              <BarList rows={(data.by_client || []).slice(0, 10)} labelKey="client" valueKey="produced" countKey={null} />
            </Panel>
            <Panel title={t('exe_an_by_shift')} subtitle={t('exe_hits_label')}>
              <BarList rows={data.by_shift || []} labelKey="shift" valueKey="produced" countKey={null}
                formatLabel={r => (r.goal ? `${r.shift} · ${r.pct ?? 0}% ${t('exe_of_goal')}` : r.shift)} />
            </Panel>
          </div>
          <Panel title={t('exe_an_by_operator')} subtitle={t('exe_hits_label')}>
            <BarList rows={(data.by_operator || []).slice(0, 12)} labelKey="operator" valueKey="produced" countKey={null} />
          </Panel>
        </>
      )}
    </div>
  );
};

export default AnalyticsView;
