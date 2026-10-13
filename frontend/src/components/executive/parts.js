// Piezas compartidas de la vista ejecutiva: todas las pantallas se arman con
// estas, para que los dashboards se lean igual. Sólo tokens del tema
// (bg-card, border-border, text-muted-foreground, primary): nada de colores
// fijos, así funcionan en todos los temas de MOS.
import React, { useMemo, useState, useEffect } from 'react';
import { AlertTriangle, Search, ArrowUpDown } from 'lucide-react';
import { useLang } from '../../contexts/LanguageContext';
import { useTheme } from '../../contexts/ThemeContext';

export const fmt = (n, lang) =>
  n == null || Number.isNaN(Number(n)) ? '—' : Number(n).toLocaleString(lang === 'en' ? 'en-US' : 'es-MX');

export const fmtDay = (iso, lang, opts = { weekday: 'short', day: 'numeric', month: 'short' }) => {
  if (!iso) return '—';
  const d = new Date(`${String(iso).slice(0, 10)}T12:00:00`);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString(lang === 'en' ? 'en-US' : 'es-MX', opts);
};

// recharts escribe el color como atributo SVG, donde var() no se resuelve:
// se lee el token ya calculado y se vuelve a leer al cambiar de tema.
export const useTokenColor = (token, alpha = 1) => {
  const { theme } = useTheme();
  const [color, setColor] = useState('#3b82f6');
  useEffect(() => {
    const id = requestAnimationFrame(() => {
      const v = getComputedStyle(document.documentElement).getPropertyValue(token).trim();
      if (v) setColor(alpha === 1 ? `hsl(${v})` : `hsl(${v} / ${alpha})`);
    });
    return () => cancelAnimationFrame(id);
  }, [theme, token, alpha]);
  return color;
};

export const useChartTheme = () => ({
  primary: useTokenColor('--primary'),
  muted: useTokenColor('--muted-foreground'),
  grid: useTokenColor('--border'),
  card: useTokenColor('--card'),
  fg: useTokenColor('--foreground'),
});

export const Panel = ({ title, subtitle, right, children, className = '' }) => (
  <section className={`bg-card border border-border rounded-xl p-4 md:p-5 min-w-0 ${className}`}>
    {(title || right) && (
      <header className="flex items-start justify-between gap-3 mb-4">
        <div className="min-w-0">
          {title && <h3 className="text-sm font-semibold text-foreground">{title}</h3>}
          {subtitle && <p className="text-xs text-muted-foreground mt-0.5">{subtitle}</p>}
        </div>
        {right}
      </header>
    )}
    {children}
  </section>
);

// Tile de KPI. tone="alert" sólo cuando el número ES un problema (atrasadas):
// lleva ícono y texto, nunca sólo color.
export const KpiTile = ({ label, value, hint, tone, icon: Icon, onClick, active }) => {
  const alert = tone === 'alert' && Number(String(value).replace(/[^\d.-]/g, '')) > 0;
  return (
    <button type="button" onClick={onClick} disabled={!onClick}
      className={`text-left bg-card border rounded-xl p-4 min-w-0 transition-colors ${onClick ? 'hover:border-primary/50 cursor-pointer' : 'cursor-default'} ${alert ? 'border-destructive/40' : active ? 'border-primary ring-1 ring-primary/40' : 'border-border'}`}>
      <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
        {alert ? <AlertTriangle className="w-3.5 h-3.5 text-destructive" /> : Icon && <Icon className="w-3.5 h-3.5" />}
        <span className="truncate">{label}</span>
      </div>
      <div className={`mt-2 text-2xl md:text-3xl font-bold tabular-nums tracking-tight ${alert ? 'text-destructive' : 'text-foreground'}`}>{value}</div>
      {hint && <div className="mt-1 text-xs text-muted-foreground truncate">{hint}</div>}
    </button>
  );
};

// Lista de barras horizontales (una sola magnitud → un solo tono).
export const BarList = ({ rows, valueKey = 'pieces', labelKey, countKey = 'count', max: maxProp, empty, onRowClick, formatLabel }) => {
  const { t, lang } = useLang();
  const max = maxProp || Math.max(1, ...rows.map(r => r[valueKey] || 0));
  if (!rows.length) return <p className="text-sm text-muted-foreground py-6 text-center">{empty || t('exe_empty')}</p>;
  return (
    <ul className="space-y-2.5">
      {rows.map((r) => (
        <li key={r[labelKey]} className={onRowClick ? 'cursor-pointer group' : ''} onClick={onRowClick ? () => onRowClick(r) : undefined}>
          <div className="flex items-baseline justify-between gap-3 text-xs">
            <span className="truncate text-foreground group-hover:text-primary">{formatLabel ? formatLabel(r) : r[labelKey]}</span>
            <span className="shrink-0 tabular-nums text-muted-foreground">
              <span className="text-foreground font-semibold">{fmt(r[valueKey], lang)}</span>
              {countKey && r[countKey] != null && <> · {fmt(r[countKey], lang)} {t('exe_orders_short')}</>}
            </span>
          </div>
          <div className="mt-1 h-1.5 rounded-full bg-muted overflow-hidden">
            <div className="h-full rounded-full bg-primary" style={{ width: `${Math.max(2, (r[valueKey] || 0) / max * 100)}%` }} />
          </div>
        </li>
      ))}
    </ul>
  );
};

// Antigüedad en la etapa: 4 cubetas fijas. La última (15+ días) es la que
// pide atención, por eso es la única que se marca.
export const AgingBars = ({ aging }) => {
  const { t, lang } = useLang();
  const entries = Object.entries(aging || {});
  const max = Math.max(1, ...entries.map(([, n]) => n));
  return (
    <div className="grid grid-cols-4 gap-2 items-end h-36">
      {entries.map(([k, n], i) => {
        const old = i === entries.length - 1 && n > 0;
        return (
          <div key={k} className="flex flex-col items-center justify-end h-full gap-1 min-w-0" title={`${k} ${t('exe_days')}: ${n}`}>
            <span className={`text-xs font-semibold tabular-nums ${old ? 'text-destructive' : 'text-foreground'}`}>{fmt(n, lang)}</span>
            <div className={`w-full max-w-[56px] rounded-t ${old ? 'bg-destructive/80' : 'bg-primary'}`} style={{ height: `${Math.max(3, n / max * 100)}%` }} />
            <span className="text-[11px] text-muted-foreground">{k} {t('exe_days_short')}</span>
          </div>
        );
      })}
    </div>
  );
};

export const LateBadge = ({ row }) => {
  const { t } = useLang();
  if (row.late) {
    return (
      <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-destructive">
        <AlertTriangle className="w-3 h-3" />{t('exe_late_by', { n: Math.abs(row.days_to_cancel) })}
      </span>
    );
  }
  if (row.days_to_cancel != null && row.days_to_cancel <= 7) {
    return <span className="text-[11px] font-medium text-foreground">{row.days_to_cancel === 0 ? t('exe_due_today') : t('exe_due_in', { n: row.days_to_cancel })}</span>;
  }
  return null;
};

// Tabla de órdenes de solo lectura con búsqueda y orden por columna.
export const OrdersTable = ({ rows, statusField = 'production_status', daysLabel, truncated, extraCol }) => {
  const { t, lang } = useLang();
  const [q, setQ] = useState('');
  const [sort, setSort] = useState(null);
  const view = useMemo(() => {
    const needle = q.trim().toLowerCase();
    let out = !needle ? rows : rows.filter(r =>
      [r.order_number, r.client, r.customer_po, r.branding, r[statusField], r.board]
        .some(v => String(v || '').toLowerCase().includes(needle)));
    if (sort) {
      const { key, dir } = sort;
      out = [...out].sort((a, b) => {
        const va = a[key] ?? '', vb = b[key] ?? '';
        const c = typeof va === 'number' && typeof vb === 'number' ? va - vb : String(va).localeCompare(String(vb), undefined, { numeric: true });
        return dir * c;
      });
    }
    return out;
  }, [rows, q, sort, statusField]);

  const cols = [
    { key: 'order_number', label: t('exe_col_order') },
    { key: 'client', label: t('exe_col_client') },
    { key: 'customer_po', label: 'PO', hide: 'hidden lg:table-cell' },
    { key: 'quantity', label: t('exe_col_pieces'), num: true },
    { key: statusField, label: t('exe_col_status'), hide: 'hidden md:table-cell' },
    { key: 'board', label: t('exe_col_board'), hide: 'hidden xl:table-cell' },
    { key: 'cancel_date', label: t('exe_col_cancel') },
    ...(extraCol ? [extraCol] : [{ key: 'days', label: daysLabel || t('exe_col_days'), num: true }]),
  ];
  const toggle = (key) => setSort(s => (s?.key === key ? (s.dir === 1 ? { key, dir: -1 } : null) : { key, dir: 1 }));

  return (
    <div>
      <div className="flex items-center gap-2 mb-3">
        <div className="relative flex-1 max-w-xs">
          <Search className="w-4 h-4 absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <input value={q} onChange={e => setQ(e.target.value)} placeholder={t('exe_search')}
            className="w-full pl-8 pr-3 py-1.5 text-sm rounded-lg bg-background border border-border outline-none focus:border-primary" />
        </div>
        <span className="text-xs text-muted-foreground tabular-nums">{fmt(view.length, lang)} {t('exe_orders_short')}{truncated ? ` · ${t('exe_truncated')}` : ''}</span>
      </div>
      <div className="overflow-auto max-h-[480px] rounded-lg border border-border">
        <table className="w-full text-sm">
          <thead className="sticky top-0 bg-muted/90 backdrop-blur text-xs text-muted-foreground">
            <tr>
              {cols.map(c => (
                <th key={c.key} className={`px-3 py-2 font-medium whitespace-nowrap ${c.num ? 'text-right' : 'text-left'} ${c.hide || ''}`}>
                  <button type="button" onClick={() => toggle(c.key)} className="inline-flex items-center gap-1 hover:text-foreground">
                    {c.label}<ArrowUpDown className={`w-3 h-3 ${sort?.key === c.key ? 'text-primary' : 'opacity-40'}`} />
                  </button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {view.map(r => (
              <tr key={r.order_id || r.order_number} className="border-t border-border hover:bg-muted/40">
                <td className="px-3 py-2 font-semibold whitespace-nowrap">{r.order_number}</td>
                <td className="px-3 py-2 max-w-[180px] truncate" title={r.branding || ''}>{r.client}</td>
                <td className="px-3 py-2 hidden lg:table-cell text-muted-foreground whitespace-nowrap">{r.customer_po || '—'}</td>
                <td className="px-3 py-2 text-right tabular-nums">{fmt(r.quantity, lang)}</td>
                <td className="px-3 py-2 hidden md:table-cell text-xs whitespace-nowrap">{r[statusField] || '—'}</td>
                <td className="px-3 py-2 hidden xl:table-cell text-xs text-muted-foreground whitespace-nowrap">{r.board}</td>
                <td className="px-3 py-2 whitespace-nowrap">
                  <div className="text-xs">{r.cancel_date ? fmtDay(r.cancel_date, lang, { day: 'numeric', month: 'short' }) : '—'}</div>
                  <LateBadge row={r} />
                </td>
                {extraCol
                  ? <td className="px-3 py-2 text-right tabular-nums">{extraCol.render(r)}</td>
                  : <td className="px-3 py-2 text-right tabular-nums">{r.days ?? '—'}</td>}
              </tr>
            ))}
            {!view.length && (
              <tr><td colSpan={cols.length} className="px-3 py-8 text-center text-muted-foreground">{t('exe_empty')}</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
};

export const ChartTooltip = ({ active, payload, label, formatLabel, rows }) => {
  const { lang } = useLang();
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-lg border border-border bg-card px-3 py-2 text-xs shadow-lg">
      <div className="font-semibold text-foreground mb-1">{formatLabel ? formatLabel(label) : label}</div>
      {(rows || payload.map(p => ({ name: p.name, value: p.value, color: p.color }))).map(r => (
        <div key={r.name} className="flex items-center gap-2 text-muted-foreground">
          {r.color && <span className="w-2 h-2 rounded-sm" style={{ background: r.color }} />}
          <span>{r.name}</span><span className="ml-auto pl-3 font-semibold text-foreground tabular-nums">{fmt(r.value, lang)}</span>
        </div>
      ))}
    </div>
  );
};

// Fecha local YYYY-MM-DD (la que entienden <input type="date"> y el backend).
export const isoDay = (d) => {
  const x = new Date(d);
  return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
};

// Selector de periodo: chips + rango. `periods` = [{id, labelKey}]; con id
// 'custom' aparecen los dos <input type="date">.
export const PeriodPicker = ({ periods, value, onChange, from, to, onRange }) => {
  const { t } = useLang();
  const today = isoDay(new Date());
  return (
    <div className="flex items-center gap-2 flex-wrap">
      <div className="flex items-center gap-1 p-1 rounded-lg bg-muted/60 border border-border">
        {periods.map(p => (
          <button key={p.id} type="button" onClick={() => onChange(p.id)}
            className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${value === p.id ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground'}`}>
            {t(p.labelKey)}
          </button>
        ))}
      </div>
      {value === 'custom' && (
        <div className="flex items-center gap-1.5 px-2 py-1 rounded-lg bg-muted/60 border border-border">
          <input type="date" value={from} max={today} onChange={e => onRange(e.target.value, to)}
            className="bg-transparent text-xs font-medium outline-none [color-scheme:light] dark:[color-scheme:dark]" />
          <span className="text-xs text-muted-foreground">{t('exe_range_to')}</span>
          <input type="date" value={to} max={today} onChange={e => onRange(from, e.target.value)}
            className="bg-transparent text-xs font-medium outline-none [color-scheme:light] dark:[color-scheme:dark]" />
        </div>
      )}
    </div>
  );
};
