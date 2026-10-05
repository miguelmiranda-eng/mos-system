/* Salidas → Surtido por orden. El material surtido ya no desaparece del WMS:
   cada pick ticket es UN surtido (con su desglose por talla) que cae en la
   ubicación de tránsito «SURTIDO POR LOCACIONAR». Aquí se escanea la etiqueta
   del pick ticket —o se teclea la orden— y luego la ubicación OM, o se manda a
   piso. Destinos configurables en Configuración → Surtido → OM. Backend:
   routers/wms_staging.py + services/staging.py.

   Pestañas:
   · Escanear  — surtidos → ubicación (guardar) o «Entregar a piso»
   · Por orden — qué hay de cada orden y dónde
   · Mapa OM   — cada ubicación destino con sus órdenes */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Loader2, RefreshCw, ScanLine, X, Truck, Search, Plus } from "lucide-react";
import { toast } from "sonner";
import { useLang } from "../../contexts/LanguageContext";
import { fetcher, poster, cleanScan, scanFeedback, useWms } from "./lib";
import { Btn, Card, Chip, EmptyState, StatCard, TableShell, Th, cls, tableCls } from "./ui";

const TAB_KEY = 'mos_wms_staging_tab';
const fmt = (n) => (n || 0).toLocaleString();

const statusChip = (t, st) => {
  if (st === 'transit') return <Chip tone="warning">{t('wms_stg_st_transit')}</Chip>;
  if (st === 'stored') return <Chip tone="info">{t('wms_stg_st_stored')}</Chip>;
  return <Chip tone="success">{t('wms_stg_st_issued')}</Chip>;
};

const SIZE_ORDER = ['XXS', 'XS', 'S', 'M', 'L', 'XL', '2X', '3X', '4X', '5X', '6X'];
const sizeRank = (k) => { const i = SIZE_ORDER.indexOf(k); return i < 0 ? 99 : i; };
/* "S:240 M:480 L:480" en orden de talla. */
const sizesText = (sizes) => Object.entries(sizes || {}).filter(([, v]) => v > 0)
  .sort(([a], [b]) => sizeRank(a) - sizeRank(b) || a.localeCompare(b)).map(([k, v]) => `${k}:${v}`).join('  ');
/* pick_ab12cd-R1 -> ab12cd-R1 (como lo muestra Picking). */
const ticketShort = (id) => (id || '').split('_')[1] || id || '';

/* ── Escanear: surtidos → ubicación / piso ─────────────────────────────────── */
const ScanTab = ({ canOperate, onChanged }) => {
  const { t } = useLang();
  const [code, setCode] = useState('');
  const [cart, setCart] = useState([]);
  const [choices, setChoices] = useState(null);   // orden con varios surtidos
  const [busy, setBusy] = useState(false);
  const inputRef = useRef(null);
  useEffect(() => { inputRef.current?.focus(); }, []);

  const store = async (loc) => {
    if (!cart.length) { scanFeedback('error'); toast.error(t('wms_stg_need_boxes')); return; }
    setBusy(true);
    try {
      const res = await poster('/staging/store', { staged_ids: cart.map(b => b.staged_id), location: loc });
      const r = await res.json().catch(() => ({}));
      if (!res.ok) { scanFeedback('error'); toast.error(r.detail || 'Error'); return; }
      (r.errors || []).forEach(e => toast.error(e));
      if (r.moved?.length) {
        scanFeedback('ok');
        toast.success(t('wms_stg_stored_ok', { n: r.moved.length, loc: loc }));
        setCart([]);
        onChanged();
      }
    } finally { setBusy(false); }
  };

  const issue = async () => {
    if (!cart.length) return;
    if (!window.confirm(t('wms_stg_issue_confirm', { n: cart.length }))) return;
    setBusy(true);
    try {
      const res = await poster('/staging/issue', { staged_ids: cart.map(b => b.staged_id) });
      const r = await res.json().catch(() => ({}));
      if (!res.ok) { toast.error(r.detail || 'Error'); return; }
      (r.errors || []).forEach(e => toast.error(e));
      if (r.issued?.length) { toast.success(t('wms_stg_issued_ok', { n: r.issued.length })); setCart([]); onChanged(); }
    } finally { setBusy(false); }
  };

  const addToCart = (b) => {
    if (!['transit', 'stored'].includes(b.status)) { scanFeedback('error'); toast.error(t('wms_stg_not_live')); return; }
    if (cart.some(x => x.staged_id === b.staged_id)) { scanFeedback('dup'); toast(t('wms_stg_already_cart')); return; }
    scanFeedback('ok');
    setCart(prev => [...prev, b]);
  };

  const onScan = async (e) => {
    e.preventDefault();
    const c = cleanScan(code);
    setCode('');
    if (!c) return;
    let r;
    try { r = await fetcher(`/staging/lookup?code=${encodeURIComponent(c)}`); }
    catch { scanFeedback('error'); toast.error(t('wms_stg_unknown')); return; }
    if (r.kind === 'box') {
      addToCart(r.box);
    } else if (r.kind === 'choices') {
      scanFeedback('dup');
      setChoices({ order: r.order_number, boxes: r.boxes });
    } else if (r.kind === 'location') {
      await store(r.location);
    }
    inputRef.current?.focus();
  };

  const total = cart.reduce((s, b) => s + (b.units || 0), 0);
  return (
    <div className="space-y-4">
      <Card className="p-4 space-y-3">
        <p className="text-sm text-muted-foreground">{t('wms_stg_scan_help')}</p>
        <form onSubmit={onScan} className="flex gap-2">
          <div className="relative flex-1">
            <ScanLine className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <input ref={inputRef} value={code} onChange={e => setCode(e.target.value)} disabled={!canOperate || busy}
              placeholder={t('wms_stg_scan_ph')} data-testid="staging-scan-input"
              className={`${cls.input} pl-9 font-mono text-base`} />
          </div>
          {busy && <Loader2 className="w-5 h-5 animate-spin self-center text-primary" />}
        </form>
      </Card>
      {choices && (
        <Card className="p-4 space-y-2" data-testid="staging-choices">
          <div className="flex items-center justify-between">
            <div className="text-sm font-semibold">{t('wms_stg_choose', { order: choices.order })}</div>
            <button onClick={() => setChoices(null)} className="text-muted-foreground hover:text-foreground"><X className="w-4 h-4" /></button>
          </div>
          {choices.boxes.map(b => (
            <div key={b.staged_id} className="flex items-center gap-3 text-sm border border-border rounded-md px-3 py-2">
              <span className="font-mono font-semibold">{ticketShort(b.ticket_id)}</span>
              <span>{b.style} · {b.color}</span>
              <span className="text-muted-foreground font-mono text-xs">{sizesText(b.sizes)}</span>
              <span className="ml-auto tabular-nums">{fmt(b.units)} pz · {b.location}</span>
              <Btn onClick={() => { addToCart(b); setChoices(c => ({ ...c, boxes: c.boxes.filter(x => x.staged_id !== b.staged_id) })); }}
                disabled={cart.some(x => x.staged_id === b.staged_id)}><Plus className="w-4 h-4" /></Btn>
            </div>
          ))}
        </Card>
      )}
      <Card className="overflow-hidden">
        <div className="flex items-center justify-between px-4 py-3 border-b border-border">
          <div className="text-sm font-semibold">{t('wms_stg_cart')} · {cart.length} · {fmt(total)} pz</div>
          <div className="flex gap-2">
            <Btn variant="primary" onClick={issue} disabled={!canOperate || busy || !cart.length} data-testid="staging-issue">
              <Truck className="w-4 h-4" /> {t('wms_stg_issue')}
            </Btn>
          </div>
        </div>
        {cart.length === 0 ? <EmptyState art={false} title={t('wms_stg_cart_empty')} /> : (
          <TableShell>
            <thead className={tableCls.thead}><tr>
              <Th>{t('wms_stg_box')}</Th><Th>{t('wms_stg_order')}</Th><Th>{t('wms_stg_style')}</Th>
              <Th>{t('wms_stg_color')}</Th><Th>{t('wms_stg_size')}</Th><Th right>{t('wms_stg_units')}</Th>
              <Th>{t('wms_stg_location')}</Th><Th />
            </tr></thead>
            <tbody>{cart.map(b => (
              <tr key={b.staged_id} className={tableCls.row}>
                <td className={`${cls.td} font-mono`}>{ticketShort(b.ticket_id)}</td>
                <td className={cls.td}>{b.order_number}</td>
                <td className={cls.td}>{b.style}</td><td className={cls.td}>{b.color}</td>
                <td className={`${cls.td} font-mono text-xs`}>{sizesText(b.sizes)}</td>
                <td className={`${cls.td} text-right tabular-nums`}>{fmt(b.units)}</td>
                <td className={`${cls.td} font-mono`}>{b.location}</td>
                <td className={cls.td}>
                  <button onClick={() => setCart(c => c.filter(x => x.staged_id !== b.staged_id))}
                    className="text-muted-foreground hover:text-red-600"><X className="w-4 h-4" /></button>
                </td>
              </tr>))}
            </tbody>
          </TableShell>
        )}
      </Card>
    </div>
  );
};

/* ── Por orden ──────────────────────────────────────────────────────────── */
const OrdersTab = ({ data }) => {
  const { t } = useLang();
  const [open, setOpen] = useState(null);
  const byOrder = useMemo(() => {
    const m = {};
    (data?.boxes || []).forEach(b => { (m[b.order_number] = m[b.order_number] || []).push(b); });
    return m;
  }, [data]);
  if (!data?.orders?.length) return <EmptyState title={t('wms_stg_empty')} />;
  return (
    <Card className="overflow-hidden">
      <TableShell maxH="max-h-[70vh]">
        <thead className={tableCls.thead}><tr>
          <Th>{t('wms_stg_order')}</Th><Th>{t('wms_stg_board')}</Th><Th>{t('wms_stg_location')}</Th>
          <Th right>{t('wms_stg_total_boxes')}</Th><Th right>{t('wms_stg_in_transit')}</Th><Th right>{t('wms_stg_units')}</Th>
        </tr></thead>
        <tbody>{data.orders.map(o => {
          const cancelled = (o.board || '').toUpperCase() === 'CANCELLED';
          const isOpen = open === o.order_number;
          return [
            <tr key={o.order_number} className={`${tableCls.row} cursor-pointer`} onClick={() => setOpen(isOpen ? null : o.order_number)}>
              <td className={`${cls.td} font-semibold`}>{o.order_number || '—'}
                {o.branding && <span className="text-xs text-muted-foreground ml-2">{o.branding}</span>}</td>
              <td className={cls.td}>
                {cancelled ? <Chip tone="danger">{t('wms_stg_cancelled')}</Chip>
                  : <span className="text-xs">{o.board || '—'}{o.blank_status ? ` · ${o.blank_status}` : ''}</span>}
              </td>
              <td className={`${cls.td} font-mono text-xs`}>{o.locations.join(', ')}</td>
              <td className={`${cls.td} text-right tabular-nums`}>{fmt(o.boxes)}</td>
              <td className={`${cls.td} text-right tabular-nums`}>{o.transit_units ? fmt(o.transit_units) : '—'}</td>
              <td className={`${cls.td} text-right tabular-nums font-semibold`}>{fmt(o.units)}</td>
            </tr>,
            isOpen && (
              <tr key={`${o.order_number}-d`}><td colSpan={6} className="bg-muted/30 px-3 py-2">
                <table className="w-full text-xs">
                  <thead><tr className="text-muted-foreground">
                    <th className="text-left py-1">{t('wms_stg_box')}</th><th className="text-left">{t('wms_stg_style')}</th>
                    <th className="text-left">{t('wms_stg_color')}</th><th className="text-left">{t('wms_stg_size')}</th>
                    <th className="text-right">{t('wms_stg_units')}</th><th className="text-left pl-4">{t('wms_stg_location')}</th>
                    <th className="text-left">{t('wms_stg_status')}</th>
                  </tr></thead>
                  <tbody>{(byOrder[o.order_number] || []).map(b => (
                    <tr key={b.staged_id} className="border-t border-border/50">
                      <td className="py-1 font-mono">{ticketShort(b.ticket_id)}</td><td>{b.style}</td><td>{b.color}</td><td className="font-mono">{sizesText(b.sizes)}</td>
                      <td className="text-right tabular-nums">{fmt(b.units)}</td>
                      <td className="pl-4 font-mono">{b.location}</td><td>{statusChip(t, b.status)}</td>
                    </tr>))}
                  </tbody>
                </table>
              </td></tr>
            ),
          ];
        })}</tbody>
      </TableShell>
    </Card>
  );
};

/* ── Mapa OM: cada ubicación destino, agrupada por fila (OM-A, OM-B…) ───── */
const MapTab = ({ data, onPick }) => {
  const { t } = useLang();
  const occ = useMemo(() => Object.fromEntries((data?.locations || []).map(l => [l.location, l])), [data]);
  const rows = useMemo(() => {
    const m = {};
    (data?.destination_locations || []).forEach(n => {
      const k = n.replace(/\d+$/, '');
      (m[k] = m[k] || []).push(n);
    });
    return Object.entries(m);
  }, [data]);
  const transit = (data?.transit || []).map(n => occ[n] || { location: n, units: 0, boxes: 0, orders: [] });
  const cell = (n, l) => {
    const busy = l && l.units > 0;
    return (
      <button key={n} onClick={() => busy && onPick(n)} title={busy ? `${l.orders.join(', ')} · ${l.units} pz` : t('wms_stg_free')}
        className={`rounded-md border px-1.5 py-1 text-left min-h-[52px] transition-colors
          ${busy ? 'bg-blue-50 border-blue-300 hover:bg-blue-100 dark:bg-blue-500/10 dark:border-blue-500/40' : 'bg-card border-border text-muted-foreground'}`}>
        <div className="text-[10px] font-mono">{n.replace(/^.*-/, '')}</div>
        {busy && <div className="text-[11px] font-semibold leading-tight truncate">{l.orders.join(', ')}</div>}
        {busy && <div className="text-[10px] tabular-nums">{fmt(l.units)} pz</div>}
      </button>
    );
  };
  return (
    <div className="space-y-4">
      <Card className="p-4">
        <div className="text-xs font-bold uppercase tracking-wider text-muted-foreground mb-2">{t('wms_stg_in_transit')}</div>
        <div className="flex flex-wrap gap-2">{transit.map(l => (
          <button key={l.location} onClick={() => l.units && onPick(l.location)}
            className={`rounded-md border px-3 py-2 text-left ${l.units ? 'bg-amber-50 border-amber-300 dark:bg-amber-500/10 dark:border-amber-500/40' : 'border-border'}`}>
            <div className="text-xs font-mono">{l.location}</div>
            <div className="text-sm font-semibold tabular-nums">{fmt(l.units)} pz · {l.boxes} cajas</div>
          </button>))}
        </div>
      </Card>
      {rows.map(([prefix, names]) => (
        <Card key={prefix} className="p-4">
          <div className="text-xs font-bold uppercase tracking-wider text-muted-foreground mb-2">{prefix.replace(/-$/, '')}</div>
          <div className="grid grid-cols-4 sm:grid-cols-8 lg:grid-cols-[repeat(16,minmax(0,1fr))] gap-1.5">
            {names.map(n => cell(n, occ[n]))}
          </div>
        </Card>
      ))}
    </div>
  );
};

export function StagingModule() {
  const { t } = useLang();
  const { can } = useWms();
  const canOperate = can('staging.operate');
  const [tab, setTab] = useState(() => { try { return localStorage.getItem(TAB_KEY) || 'scan'; } catch { return 'scan'; } });
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [q, setQ] = useState('');
  const [loc, setLoc] = useState('');
  const pick = (id) => {
    if (id === 'map') setLoc('');   // el mapa siempre muestra todas las ubicaciones
    setTab(id);
    try { localStorage.setItem(TAB_KEY, id); } catch { /* sin storage */ }
  };

  const tRef = useRef(t);
  useEffect(() => { tRef.current = t; }, [t]);
  const load = useCallback(async () => {
    setLoading(true);
    try {
      const p = new URLSearchParams();
      if (q.trim()) p.set('q', q.trim());
      if (loc) p.set('location', loc);
      setData(await fetcher(`/staging?${p.toString()}`));
    } catch { toast.error(tRef.current('wms_stg_load_err')); }
    finally { setLoading(false); }
  }, [q, loc]);
  useEffect(() => { load(); }, [load]);

  const totals = data?.totals || { boxes: 0, units: 0 };
  const transitUnits = (data?.boxes || []).filter(b => b.status === 'transit').reduce((s, b) => s + (b.units || 0), 0);
  const tabs = [['scan', t('wms_stg_tab_scan')], ['orders', t('wms_stg_tab_orders')], ['map', t('wms_stg_tab_map')]];

  return (
    <div className="space-y-5" data-testid="wms-staging">
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <StatCard label={t('wms_stg_total_units')} value={fmt(totals.units)} />
        <StatCard label={t('wms_stg_total_boxes')} value={fmt(totals.boxes)} />
        <StatCard label={t('wms_stg_in_transit')} value={fmt(transitUnits)} />
        <StatCard label={t('wms_stg_orders')} value={fmt(data?.orders?.length)} />
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <div className="inline-flex gap-1 bg-muted/40 border border-border rounded-lg p-1">
          {tabs.map(([id, label]) => (
            <button key={id} onClick={() => pick(id)} data-testid={`staging-tab-${id}`}
              className={`px-4 py-1.5 rounded-md text-xs font-bold uppercase tracking-wider ${tab === id ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'}`}>
              {label}
            </button>))}
        </div>
        {tab !== 'scan' && (
          <div className="relative">
            <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <input value={q} onChange={e => setQ(e.target.value)} placeholder={t('wms_stg_search_ph')}
              className={`${cls.input} pl-9 w-64`} />
          </div>
        )}
        {loc && <Chip tone="info">{loc} <button onClick={() => setLoc('')}><X className="w-3 h-3" /></button></Chip>}
        <div className="ml-auto flex gap-2">
          <Btn onClick={load} disabled={loading}>{loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}</Btn>
        </div>
      </div>
      {tab === 'scan' && <ScanTab canOperate={canOperate} onChanged={load} />}
      {tab === 'orders' && <OrdersTab data={data} />}
      {tab === 'map' && <MapTab data={data} onPick={(n) => { setLoc(n); pick('orders'); }} />}
    </div>
  );
}

export default StagingModule;
