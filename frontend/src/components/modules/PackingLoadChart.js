import React, { useMemo, useState } from 'react';
import { BarChart, Bar, XAxis, YAxis, Tooltip, Legend, ResponsiveContainer, CartesianGrid } from 'recharts';
import { ChevronDown, ChevronUp, TrendingUp } from 'lucide-react';

// Carga que viene a Empaque: por día (fecha de envío programado o cancel) lo
// que falta empacar + lo que se está imprimiendo, apilado por tipo de empaque
// y PESADO por esfuerzo: PickPack y Prepack cuestan más que BulkPack.
// Sale de la misma cola del módulo (/api/empaque/queue), sin otra consulta.

export const LOAD_FACTORS = { PickPack: 3, Prepack: 2, BulkPack: 1, '—': 1 };
const TYPES = ['PickPack', 'Prepack', 'BulkPack', '—'];
const COLORS = { PickPack: '#dc2626', Prepack: '#f59e0b', BulkPack: '#0ea5e9', '—': '#94a3b8' };
const DAYS = 7;

const typeOf = (c) => {
  const k = String(c.packing_type || '').toLowerCase().replace(/[^a-z]/g, '');
  return k === 'pickpack' ? 'PickPack' : k === 'prepack' ? 'Prepack' : k === 'bulkpack' ? 'BulkPack' : '—';
};
const isoDay = (d) => d.toISOString().slice(0, 10);
const n = (v) => Number(v || 0).toLocaleString('es-MX');

// ── Pestaña Resumen: KPIs + la gráfica ─────────────────────────────────────

const left = (c) => Math.max(0, (c.quantity || 0) - (c.packed || 0));

function Kpi({ label, value, sub, tone = 'default', onClick }) {
  const tones = {
    default: 'border-border',
    warn: 'border-amber-500/50 bg-amber-500/5',
    bad: 'border-red-500/50 bg-red-500/5',
    good: 'border-emerald-500/50 bg-emerald-500/5',
  };
  const Tag = onClick ? 'button' : 'div';
  return (
    <Tag type={onClick ? 'button' : undefined} onClick={onClick}
      className={`rounded-xl border bg-card p-4 text-left ${tones[tone]} ${onClick ? 'hover:bg-secondary/60 transition-colors' : ''}`}>
      <div className="text-[11px] font-black uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className="text-3xl font-black mt-1 tabular-nums">{value}</div>
      {sub && <div className="text-xs text-muted-foreground mt-1">{sub}</div>}
    </Tag>
  );
}

export function EmpaqueSummary({ data, kpis, t, onGo }) {
  const pend = data.pendientes || [];
  const proc = data.proceso || [];
  const coming = data.llegando || [];
  const working = [...pend, ...proc];
  const pcsLeft = working.reduce((s, c) => s + left(c), 0);
  const loadOf = (c, pcs) => pcs * LOAD_FACTORS[typeOf(c)];
  const load = working.reduce((s, c) => s + loadOf(c, left(c)), 0);
  const heavy = working.reduce((s, c) => s + (['PickPack', 'Prepack'].includes(typeOf(c)) ? loadOf(c, left(c)) : 0), 0);
  const overdue = working.filter((c) => c.overdue).length;
  const stuck = proc.filter((c) => c.stuck).length;
  const pk = kpis?.packed_today;
  const qc = kpis?.to_qc;
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Kpi label={t('emp_kpi_to_pack')} value={n(pend.length)} sub={t('emp_kpi_pcs_left', { p: n(pend.reduce((s, c) => s + left(c), 0)) })} onClick={() => onGo('pend')} />
        <Kpi label={t('emp_kpi_in_process')} value={n(proc.length)} sub={t('emp_kpi_pcs_left', { p: n(proc.reduce((s, c) => s + left(c), 0)) })} onClick={() => onGo('proc')} />
        <Kpi label={t('emp_kpi_load')} value={n(load)}
          sub={t('emp_kpi_heavy', { pct: load ? Math.round((100 * heavy) / load) : 0, p: n(pcsLeft) })} tone={heavy > load / 2 ? 'warn' : 'default'} />
        <Kpi label={t('emp_kpi_overdue')} value={n(overdue)} sub={stuck ? t('emp_kpi_stuck', { n: stuck }) : t('emp_kpi_no_stuck')}
          tone={overdue || stuck ? 'bad' : 'good'} onClick={() => onGo('alert')} />
        <Kpi label={t('emp_kpi_packed_today')} value={pk ? n(pk.pcs) : '—'}
          sub={pk ? t('emp_kpi_packed_sub', { b: n(pk.boxes), w: pk.packers }) : ''} tone={pk?.pcs ? 'good' : 'default'} />
        <Kpi label={t('emp_kpi_to_qc')} value={qc ? n(qc.today) : '—'} sub={qc ? t('emp_kpi_to_qc_week', { n: n(qc.week) }) : ''} />
        <Kpi label={t('emp_kpi_suggested')} value={n((data.sugeridas || []).length)} sub={t('emp_kpi_suggested_sub')}
          tone={(data.sugeridas || []).length ? 'good' : 'default'} onClick={() => onGo('sug')} />
        <Kpi label={t('emp_kpi_coming')} value={n(coming.length)} sub={t('emp_kpi_pcs', { p: n(coming.reduce((s, c) => s + (c.quantity || 0), 0)) })} onClick={() => onGo('coming')} />
      </div>
      <PackingLoadChart data={data} t={t} />
    </div>
  );
}

export default function PackingLoadChart({ data, t }) {
  const [open, setOpen] = useState(true);
  const [mode, setMode] = useState('load');   // load = carga pesada | pcs = piezas

  const rows = useMemo(() => {
    if (!data) return [];
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const buckets = [{ key: 'late', label: t('emp_load_late') }];
    for (let i = 0; i < DAYS; i += 1) {
      const d = new Date(today); d.setDate(d.getDate() + i);
      buckets.push({ key: isoDay(d), label: d.toLocaleDateString('es-MX', { weekday: 'short', day: '2-digit' }) });
    }
    buckets.push({ key: 'later', label: t('emp_load_later') });
    const byKey = Object.fromEntries(buckets.map((b) => [b.key, { ...b, pcs: {}, load: {}, orders: 0 }]));
    const todayIso = isoDay(today);
    const lastIso = buckets[DAYS].key;
    const add = (c, pcs) => {
      if (pcs <= 0) return;
      const due = c.due || '';
      const k = !due ? 'later' : due < todayIso ? 'late' : due > lastIso ? 'later' : due;
      const b = byKey[k];
      const ty = typeOf(c);
      b.pcs[ty] = (b.pcs[ty] || 0) + pcs;
      b.load[ty] = (b.load[ty] || 0) + pcs * LOAD_FACTORS[ty];
      b.orders += 1;
    };
    // Por empacar y en proceso: lo que FALTA (cantidad − empacado); por llegar: todo.
    [...(data.pendientes || []), ...(data.proceso || [])].forEach((c) => add(c, Math.max(0, (c.quantity || 0) - (c.packed || 0))));
    (data.llegando || []).forEach((c) => add(c, c.quantity || 0));
    return buckets.map((b) => {
      const r = byKey[b.key];
      const row = { label: r.label, orders: r.orders };
      TYPES.forEach((ty) => { row[ty] = (mode === 'load' ? r.load[ty] : r.pcs[ty]) || 0; row[`${ty}_pcs`] = r.pcs[ty] || 0; });
      return row;
    });
  }, [data, mode, t]);

  const total = rows.reduce((s, r) => s + TYPES.reduce((a, ty) => a + r[ty], 0), 0);
  const peak = rows.reduce((m, r) => Math.max(m, TYPES.reduce((a, ty) => a + r[ty], 0)), 0);

  const TipBox = ({ active, payload, label }) => {
    if (!active || !payload?.length) return null;
    const r = payload[0].payload;
    return (
      <div className="rounded-lg border border-border bg-card p-2 text-xs shadow">
        <div className="font-black mb-1">{label} · {t('emp_load_orders', { n: r.orders })}</div>
        {TYPES.filter((ty) => r[`${ty}_pcs`]).map((ty) => (
          <div key={ty} className="flex justify-between gap-4">
            <span style={{ color: COLORS[ty] }} className="font-bold">{ty} ×{LOAD_FACTORS[ty]}</span>
            <span>{n(r[`${ty}_pcs`])} {t('emp_load_pcs')} → {n(r[`${ty}_pcs`] * LOAD_FACTORS[ty])}</span>
          </div>
        ))}
      </div>
    );
  };

  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <div className="flex items-center gap-2 flex-wrap">
        <TrendingUp size={18} className="text-amber-500" />
        <span className="font-black">{t('emp_load_title')}</span>
        <span className="text-xs text-muted-foreground">{t('emp_load_hint')}</span>
        <div className="ml-auto flex items-center gap-1 text-xs">
          {['load', 'pcs'].map((m) => (
            <button key={m} type="button" onClick={() => setMode(m)}
              className={`px-2 py-1 rounded-md font-bold ${mode === m ? 'bg-primary text-primary-foreground' : 'hover:bg-secondary'}`}>
              {t(m === 'load' ? 'emp_load_mode_load' : 'emp_load_mode_pcs')}
            </button>
          ))}
          <button type="button" onClick={() => setOpen((o) => !o)} className="p-1 rounded-md hover:bg-secondary">
            {open ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
          </button>
        </div>
      </div>
      {open && (
        total === 0 ? (
          <div className="text-sm text-muted-foreground py-6 text-center">{t('emp_load_empty')}</div>
        ) : (
          <>
            <div className="text-xs text-muted-foreground mt-1">
              {t('emp_load_summary', { total: n(total), peak: n(peak) })} · PickPack ×{LOAD_FACTORS.PickPack} · Prepack ×{LOAD_FACTORS.Prepack} · BulkPack ×{LOAD_FACTORS.BulkPack}
            </div>
            <div className="h-56 mt-2">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={rows} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" opacity={0.2} />
                  <XAxis dataKey="label" tick={{ fontSize: 11 }} interval={0} />
                  <YAxis tick={{ fontSize: 11 }} tickFormatter={(v) => (v >= 1000 ? `${Math.round(v / 1000)}k` : v)} width={40} />
                  <Tooltip content={<TipBox />} />
                  <Legend wrapperStyle={{ fontSize: 11 }} />
                  {TYPES.map((ty) => <Bar key={ty} dataKey={ty} stackId="a" fill={COLORS[ty]} name={ty === '—' ? t('emp_load_no_type') : ty} />)}
                </BarChart>
              </ResponsiveContainer>
            </div>
          </>
        )
      )}
    </div>
  );
}
