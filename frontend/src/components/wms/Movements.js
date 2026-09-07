import { useState, useEffect, useCallback, useMemo } from "react";
import { History, Tag, Search, X, Loader2, User, Trash2, CheckCircle2, ArrowDownUp, Download, ArrowDownCircle, ArrowUpCircle, Ruler, AlertTriangle, PackageSearch, MapPin, ScanLine } from "lucide-react";
import * as XLSX from "xlsx";
import { toast } from "sonner";
import { useLang } from "../../contexts/LanguageContext";
import { fetcher, poster, deleter, logLoadError, useWmsSizes } from "./lib";
import { Btn, Chip, cls, tableCls, EmptyState } from "./ui";

const TABS = [
  { id: 'movements', labelKey: 'wms_tab_movements', icon: History },
  { id: 'box',       labelKey: 'wms_tab_by_box',    icon: PackageSearch },
  { id: 'inout',     labelKey: 'wms_in_out',        icon: ArrowDownUp },
  { id: 'upcs',      labelKey: 'wms_tab_upcs',      icon: Tag },
];

// i18n keys for the movement types a box's timeline can surface. The raw
// `type` value is data (compared/stored) — only the display goes through t().
const MV_TYPE_KEYS = {
  receiving: 'wms_mv_receiving',
  receiving_update: 'wms_mv_receiving_update',
  putaway: 'wms_mv_putaway_located',
  putaway_bulk: 'wms_mv_putaway_bulk',
  box_edited: 'wms_mv_box_edited',
  box_deleted: 'wms_mv_box_deleted',
  inventory_adjust_box: 'wms_mv_inventory_adjust_box',
  lpn_reconciled: 'wms_mv_lpn_reconciled',
  bulk_relocation: 'wms_mv_bulk_relocation',
  transit_relocation: 'wms_mv_transit_relocation',
  edit_finished_good: 'wms_mv_edit_finished_good',
  production_move: 'wms_mv_production_move',
  shipment: 'wms_mv_shipment',
  allocation: 'wms_mv_allocation',
  deallocate: 'wms_mv_deallocate',
  pick_ticket_created: 'wms_mv_pick_ticket_created',
  pick_confirmed: 'wms_mv_pick_confirmed',
  pick_progress: 'wms_mv_pick_progress',
  neck_cut_delivery: 'wms_mv_neck_cut_delivery',
  manual_inventory_add: 'wms_mv_manual_inventory_add',
  manual_inventory_remove: 'wms_mv_manual_inventory_remove',
};

// i18n keys for the raw detail keys shown in the expanded event view.
const DETAIL_LABEL_KEYS = {
  from: 'wms_origin', from_sources: 'wms_dl_origins', sources: 'wms_dl_origins',
  to: 'wms_dl_destination', to_loc: 'wms_dl_destination', location: 'location',
  sku: 'sku', style: 'wms_label_style', color: 'wms_label_color', size: 'wms_label_size',
  units: 'wms_label_units', units_moved: 'wms_dl_units_moved',
  old_units: 'wms_dl_old_units', new_units: 'wms_dl_new_units', delta_units: 'wms_dl_delta',
  added_units: 'wms_dl_added_units', removed_units: 'wms_dl_removed_units',
  added_boxes: 'wms_dl_added_boxes', removed_boxes: 'wms_dl_removed_boxes',
  box_units_received: 'wms_dl_box_units_received',
  total_units: 'wms_dl_total_units',
  boxes_moved: 'wms_dl_boxes_moved', skus_moved: 'wms_dl_skus_moved',
  count: 'wms_boxes', boxes_relocated: 'wms_dl_boxes_relocated', boxes_split: 'wms_dl_boxes_split',
  reason: 'wms_dl_reason', order_number: 'order', receiving_id: 'wms_dl_receiving',
  is_bpo: 'wms_dl_bpo', updated_fields: 'wms_dl_updated_fields', mode: 'wms_dl_mode',
  box_deleted: 'wms_mv_box_deleted', changes: 'wms_dl_changes', box_id: 'wms_box_label',
  box_ids: 'wms_boxes', inventory_id: 'wms_inventory', ticket_id: 'wms_dl_ticket',
  asn_id: 'wms_dl_asn', po_number: 'wms_dl_po', customer: 'wms_label_customer', manufacturer: 'manufacturer',
  physical_lpn: 'wms_dl_physical_lpn',
};

// Preferred display order for detail keys; anything else follows alphabetically.
const DETAIL_ORDER = [
  'from', 'from_sources', 'sources', 'to', 'to_loc', 'location',
  'sku', 'style', 'color', 'size',
  'old_units', 'new_units', 'delta_units', 'units', 'units_moved',
  'box_units_received', 'added_units', 'removed_units', 'added_boxes', 'removed_boxes', 'total_units',
  'boxes_moved', 'skus_moved', 'count', 'boxes_relocated', 'boxes_split',
  'order_number', 'ticket_id', 'receiving_id', 'asn_id', 'po_number',
  'customer', 'manufacturer', 'reason', 'mode', 'updated_fields', 'is_bpo',
  'changes', 'box_ids',
];

const fmtDetailVal = (k, v, t) => {
  if (v == null || v === '') return '—';
  if (Array.isArray(v)) {
    if (v.length === 0) return '—';
    if ((k === 'box_ids') && v.length > 6) return `${v.slice(0, 6).join(', ')} … (+${v.length - 6})`;
    return v.join(', ');
  }
  if (typeof v === 'boolean') return v ? t('yes') : t('no');
  if (typeof v === 'object') {
    return Object.entries(v).map(([kk, vv]) => `${kk}: ${vv}`).join(' · ');
  }
  return String(v);
};

// Ordered [key, value] pairs of a movement's details for the expanded view.
const detailEntries = (details = {}) => {
  const keys = Object.keys(details);
  const ordered = DETAIL_ORDER.filter(k => keys.includes(k));
  const rest = keys.filter(k => !DETAIL_ORDER.includes(k)).sort();
  return [...ordered, ...rest]
    .filter(k => details[k] != null && details[k] !== '')
    .map(k => [k, details[k]]);
};

// Compact one-line summary of a movement's details for the box timeline.
const summarizeMovement = (m, t) => {
  const d = m.details || {};
  const origin = d.from || (Array.isArray(d.from_sources) && d.from_sources.join(', '))
    || (Array.isArray(d.sources) && d.sources.join(', ')) || '';
  const dest = d.to || d.to_loc || '';
  const parts = [];
  if (origin || dest) parts.push(`${origin || '—'} → ${dest || '—'}`);
  else if (d.location) parts.push(d.location);
  if (d.old_units != null && d.new_units != null) parts.push(`${d.old_units} → ${d.new_units} u`);
  else if (d.box_units_received != null) parts.push(t('wms_sum_u_this_box', { n: d.box_units_received }));
  else if (d.units != null) parts.push(`${d.units} u`);
  else if (d.units_moved != null) parts.push(t('wms_sum_u_total', { n: d.units_moved }));
  else if (d.added_units != null) parts.push(`+${d.added_units} u`);
  else if (d.removed_units != null) parts.push(`−${d.removed_units} u`);
  else if (d.total_units != null) parts.push(t('wms_sum_u_receipt', { n: d.total_units }));
  if (Array.isArray(d.updated_fields) && d.updated_fields.length) parts.push(t('wms_sum_fields', { fields: d.updated_fields.join(', ') }));
  if (d.order_number) parts.push(t('wms_sum_po', { n: d.order_number }));
  if (d.reason) parts.push(`“${d.reason}”`);
  return parts.join(' · ');
};

// One expandable event row in a box's timeline. Collapsed shows a summary;
// expanded reveals every detail field of the movement.
const MovementRow = ({ m, dim }) => {
  const { t } = useLang();
  const [open, setOpen] = useState(false);
  const entries = detailEntries(m.details);
  const summary = summarizeMovement(m, t);
  return (
    <div className={`border-b border-border/60 last:border-0 ${dim ? 'opacity-70' : ''}`}>
      <button onClick={() => setOpen(o => !o)} className="w-full flex items-start gap-3 py-3 text-left">
        <div className="min-w-0 flex-1">
          <div className="text-sm flex items-center gap-2 flex-wrap">
            <Chip>{MV_TYPE_KEYS[m.type] ? t(MV_TYPE_KEYS[m.type]) : m.type?.replace(/_/g, ' ')}</Chip>
            {summary && (
              <span className="text-xs text-muted-foreground font-mono">
                {summary}
              </span>
            )}
          </div>
          <div className="text-xs text-muted-foreground mt-0.5">
            {new Date(m.created_at).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}
            {' · '}{m.user_name || m.user_id || t('wms_mv_system')}
          </div>
        </div>
        {entries.length > 0 && (
          <span className={`text-muted-foreground transition-transform mt-1 ${open ? 'rotate-90' : ''}`}>›</span>
        )}
      </button>
      {open && entries.length > 0 && (
        <div className="mb-3 grid grid-cols-[auto,1fr] gap-x-4 gap-y-1 bg-muted/40 border border-border rounded-lg p-3">
          {entries.map(([k, v]) => (
            <div key={k} className="contents">
              <div className="text-xs font-medium text-muted-foreground py-0.5">
                {DETAIL_LABEL_KEYS[k] ? t(DETAIL_LABEL_KEYS[k]) : k}
              </div>
              <div className="text-xs font-mono text-foreground break-all py-0.5">{fmtDetailVal(k, v, t)}</div>
            </div>
          ))}
          <div className="text-xs font-medium text-muted-foreground py-0.5">{t('wms_mv_id')}</div>
          <div className="text-xs font-mono text-muted-foreground/60 break-all py-0.5">{m.movement_id || '—'}</div>
        </div>
      )}
    </div>
  );
};

// Fields the admin can correct on a UPC. style/color/size are "identity" fields:
// changing them moves the already-received stock to the corrected inventory line.
const FIX_FIELDS = [
  { k: 'style', label: 'Style', upper: true, mono: true },
  { k: 'color', labelKey: 'wms_label_color', upper: true },
  { k: 'size', labelKey: 'wms_label_size', size: true },
  { k: 'customer', labelKey: 'wms_label_customer', upper: true },
  { k: 'manufacturer', labelKey: 'manufacturer', upper: true },
  { k: 'brand', labelKey: 'wms_brand', upper: true },
  { k: 'description', labelKey: 'description' },
  { k: 'country_of_origin', labelKey: 'wms_label_coo', upper: true },
  { k: 'fabric_content', labelKey: 'wms_fabric_content_col' },
];

// Audit log can hold tens of thousands of rows; only the most recent matter on
// screen and rendering them all crushes warehouse-device RAM. Cap the fetch.
const MOVEMENTS_LIMIT = 500;

const MovementsTab = () => {
  const { t } = useLang();
  const [movements, setMovements] = useState([]);
  const [typeFilter, setTypeFilter] = useState('');
  const load = useCallback(() => { fetcher(`/movements?movement_type=${typeFilter}&limit=${MOVEMENTS_LIMIT}`).then(setMovements).catch(logLoadError('data')); }, [typeFilter]);
  useEffect(() => { load(); }, [load]);
  const types = ['', 'receiving', 'putaway', 'allocation', 'deallocate', 'pick_ticket_created', 'pick_confirmed', 'production_move', 'shipment'];
  const typeLabels = {
    'receiving': t('wms_mv_receiving'),
    'putaway': t('wms_mv_putaway'),
    'allocation': t('wms_mv_allocation'),
    'deallocate': t('wms_mv_deallocate'),
    'pick_ticket_created': t('wms_mv_pick_ticket_created'),
    'pick_confirmed': t('wms_mv_pick_confirmed'),
    'production_move': t('wms_mv_production_move'),
    'shipment': t('wms_mv_shipment')
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="text-sm font-medium text-muted-foreground">
          {t('wms_audit_log')}
        </div>
        <div className="flex gap-1 flex-wrap p-1 bg-muted rounded-lg">
          {types.map(type => (
            <button
              key={type}
              onClick={() => setTypeFilter(type)}
              className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors
                ${typeFilter === type ? 'bg-card text-foreground' : 'text-muted-foreground hover:text-foreground'}`}
            >
              {type ? (typeLabels[type] || type) : t('all')}
            </button>
          ))}
        </div>
      </div>

      <div className="space-y-3 bg-card border border-border rounded-lg p-4 max-h-[600px] overflow-auto custom-scrollbar">
        {movements.map((m, i) => {
          return (
            <div key={m.movement_id || i} className="flex items-center justify-between py-3 border-b border-border/60 last:border-0">
              <div className="flex items-center gap-4 min-w-0">
                <div className="min-w-0">
                  <div className="text-sm mb-0.5 flex items-center gap-2">
                    <span className="font-mono font-medium text-foreground">{m.box_id}</span>
                    <span className="text-xs text-muted-foreground">{t('wms_moved_to_label')}</span>
                    <span className="font-mono text-foreground">{m.to_loc || '-'}</span>
                  </div>
                  <div className="text-xs text-muted-foreground flex items-center gap-2">
                    <Chip>{typeLabels[m.type] || m.type?.replace('_', ' ')}</Chip>
                    <span className="w-1 h-1 rounded-full bg-border" />
                    {t('by_label')}: {m.user_name || m.user || t('wms_mv_system')}
                  </div>
                </div>
              </div>
              <div className="text-right flex-shrink-0">
                <div className="text-xs text-muted-foreground tabular-nums">
                  {new Date(m.created_at).toLocaleDateString()}
                </div>
                <div className="text-xs text-muted-foreground/70 tabular-nums">
                  {new Date(m.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })}
                </div>
              </div>
            </div>
          );
        })}
        {movements.length === 0 && (
          <EmptyState art="clipboard" title={t('wms_no_movements')} />
        )}
        {movements.length >= MOVEMENTS_LIMIT && (
          <div className="pt-3 text-center text-xs text-amber-600 dark:text-amber-400">
            {t('wms_showing_recent_movements', { n: MOVEMENTS_LIMIT.toLocaleString() })}
          </div>
        )}
      </div>
    </div>
  );
};

// ── Entradas / Salidas (ajustes manuales de inventario) ───────────────────────
const InOutTab = () => {
  const { t } = useLang();
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(false);
  const [dir, setDir] = useState('all'); // 'all' | 'in' | 'out'
  const [search, setSearch] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      // Include adjustments made via "Ajuste masivo" (inventory_adjustment /
      // _create) and "Mover → ajustar caja" (inventory_adjust_box). Their
      // direction comes from the delta sign (+ entrada, − salida) so they show
      // up here just like the manual entradas/salidas.
      const [adds, removes, adj, adjCreate, adjBox] = await Promise.all([
        fetcher('/movements?movement_type=manual_inventory_add&limit=1000'),
        fetcher('/movements?movement_type=manual_inventory_remove&limit=1000'),
        fetcher('/movements?movement_type=inventory_adjustment&limit=1000'),
        fetcher('/movements?movement_type=inventory_adjustment_create&limit=1000'),
        fetcher('/movements?movement_type=inventory_adjust_box&limit=1000'),
      ]);
      const norm = (m) => {
        const d = m.details || {};
        const type = m.type;
        // Tags are stored as i18n KEYS and translated at render time so a
        // language switch doesn't force a refetch (this callback has no deps).
        let isIn, units, boxes = 0, tagKey = '';
        if (type === 'manual_inventory_add') {
          isIn = true; units = d.added_units ?? 0; boxes = d.added_boxes ?? 0;
          tagKey = d.mode === 'accumulated' ? 'wms_tag_accumulated' : 'wms_tag_new';
        } else if (type === 'manual_inventory_remove') {
          isIn = false; units = d.removed_units ?? 0; boxes = d.removed_boxes ?? 0;
        } else if (type === 'inventory_adjust_box') {
          const dl = Number(d.delta_units ?? 0);
          isIn = dl >= 0; units = Math.abs(dl); tagKey = 'wms_tag_adjust_mover';
        } else { // inventory_adjustment / inventory_adjustment_create (ajuste masivo)
          const dl = Number(d.delta ?? 0);
          isIn = dl >= 0; units = Math.abs(dl);
          tagKey = type === 'inventory_adjustment_create' ? 'wms_tag_adjust_new_bulk' : 'wms_tag_adjust_bulk';
        }
        return {
          created_at: m.created_at,
          isIn,
          rawReason: d.reason || '',
          tagKey,
          style: d.style || d.sku || '',
          color: d.color || '',
          size: d.size || '',
          location: d.location || '',
          units,
          boxes,
          rawUser: m.user_name || m.user_id || '',
        };
      };
      const merged = [...(adds || []), ...(removes || []), ...(adj || []), ...(adjCreate || []), ...(adjBox || [])]
        .map(norm)
        .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
      setRows(merged);
    } catch (err) {
      logLoadError('entradas/salidas')(err);
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  // Display strings (direction / reason tag / user) resolved in the active
  // language; the search box matches against what the user actually sees.
  const displayRows = useMemo(() => rows.map(x => ({
    ...x,
    direction: x.isIn ? t('wms_in_upper') : t('wms_out_upper'),
    reason: x.rawReason || (x.tagKey ? t(x.tagKey) : '') || (x.isIn ? t('wms_tag_new') : ''),
    user: x.rawUser || t('wms_mv_system'),
  })), [rows, t]);

  const filtered = useMemo(() => {
    let r = displayRows;
    if (dir !== 'all') r = r.filter(x => (dir === 'in' ? x.isIn : !x.isIn));
    const q = search.trim().toUpperCase();
    if (q) r = r.filter(x =>
      `${x.style} ${x.color} ${x.size} ${x.location} ${x.reason} ${x.user}`.toUpperCase().includes(q)
    );
    return r;
  }, [displayRows, dir, search]);

  const totals = useMemo(() => ({
    in: filtered.filter(x => x.isIn).reduce((s, x) => s + (Number(x.units) || 0), 0),
    out: filtered.filter(x => !x.isIn).reduce((s, x) => s + (Number(x.units) || 0), 0),
  }), [filtered]);

  const exportExcel = () => {
    if (filtered.length === 0) { toast.error(t('wms_no_records_export')); return; }
    const data = filtered.map(x => ({
      [t('date')]: x.created_at ? new Date(x.created_at).toLocaleString() : '',
      [t('wms_type_col')]: x.direction,
      [t('wms_dl_reason')]: x.reason,
      [t('wms_style_sku')]: x.style,
      [t('wms_label_color')]: x.color,
      [t('wms_label_size')]: x.size,
      [t('location')]: x.location,
      [t('wms_label_units')]: Number(x.units) || 0,
      [t('wms_boxes')]: Number(x.boxes) || 0,
      [t('user')]: x.user,
    }));
    const ws = XLSX.utils.json_to_sheet(data);
    ws['!cols'] = [{ wch: 20 }, { wch: 10 }, { wch: 22 }, { wch: 18 }, { wch: 12 }, { wch: 8 }, { wch: 14 }, { wch: 10 }, { wch: 8 }, { wch: 22 }];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Entradas_Salidas');
    XLSX.writeFile(wb, `entradas_salidas_${new Date().toISOString().split('T')[0]}.xlsx`);
  };

  const dirTabs = [
    { id: 'all', label: t('all') },
    { id: 'in',  label: t('wms_entries') },
    { id: 'out', label: t('wms_exits') },
  ];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex gap-1 p-1 bg-muted rounded-lg">
          {dirTabs.map(d => (
            <button
              key={d.id}
              onClick={() => setDir(d.id)}
              className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${dir === d.id ? 'bg-card text-foreground' : 'text-muted-foreground hover:text-foreground'}`}
            >
              {d.label}
            </button>
          ))}
        </div>
        <div className="relative flex-1 min-w-[240px]">
          <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder={t('wms_inout_search_ph')}
            className={`${cls.input} pl-9 pr-9`}
          />
          {search && (
            <button onClick={() => setSearch('')} className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground">
              <X className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
        <div className="flex items-center gap-3 text-xs font-mono tabular-nums font-medium">
          <span className="text-emerald-600 dark:text-emerald-400">+{totals.in.toLocaleString()}</span>
          <span className="text-red-600 dark:text-red-400">-{totals.out.toLocaleString()}</span>
          <span className="text-muted-foreground">{filtered.length.toLocaleString()} {t('wms_records_short')}</span>
        </div>
        <Btn onClick={exportExcel} data-testid="inout-export-btn">
          <Download className="w-4 h-4" /> {t('export_excel')}
        </Btn>
      </div>

      <div className="border border-border rounded-lg bg-card overflow-hidden">
        <div className="overflow-auto max-h-[600px] custom-scrollbar">
          <table className="w-full text-sm">
            <thead className={tableCls.thead}>
              <tr>
                {['date', 'wms_type_col', 'wms_dl_reason', 'wms_style_sku', 'wms_color_size_col', 'location', 'wms_label_units', 'wms_boxes', 'user'].map(h => (
                  <th key={h} className={cls.th}>{t(h)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td colSpan={9} className="py-16 text-center text-muted-foreground"><Loader2 className="w-6 h-6 animate-spin mx-auto" /></td></tr>
              ) : filtered.length === 0 ? (
                <tr>
                  <td colSpan={9}>
                    <EmptyState art="clipboard" title={t('wms_no_inout')} />
                  </td>
                </tr>
              ) : (
                filtered.map((x, i) => (
                  <tr key={i} className="border-b border-border/60 hover:bg-muted/40 transition-colors">
                    <td className="px-3 py-2.5 font-mono text-xs text-muted-foreground whitespace-nowrap">{x.created_at ? new Date(x.created_at).toLocaleString() : '—'}</td>
                    <td className="px-3 py-2.5">
                      <Chip tone={x.isIn ? 'success' : 'danger'}>
                        {x.isIn ? <ArrowDownCircle className="w-3 h-3" /> : <ArrowUpCircle className="w-3 h-3" />}
                        {x.direction}
                      </Chip>
                    </td>
                    <td className="px-3 py-2.5 text-xs">{x.reason || '—'}</td>
                    <td className="px-3 py-2.5 font-mono text-xs font-medium truncate max-w-[200px]" title={x.style}>{x.style || '—'}</td>
                    <td className="px-3 py-2.5 font-mono text-xs">
                      <span className="text-foreground">{x.color || '—'}</span>
                      <span className="mx-1 text-muted-foreground/40">·</span>
                      <span className="text-foreground">{x.size || '—'}</span>
                    </td>
                    <td className="px-3 py-2.5 font-mono text-xs">{x.location || '—'}</td>
                    <td className={`px-3 py-2.5 text-right font-mono tabular-nums font-medium ${x.isIn ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400'}`}>{x.isIn ? '+' : '-'}{(Number(x.units) || 0).toLocaleString()}</td>
                    <td className="px-3 py-2.5 text-right font-mono tabular-nums">{(Number(x.boxes) || 0).toLocaleString()}</td>
                    <td className="px-3 py-2.5 text-xs flex items-center gap-1.5"><User className="w-3 h-3 text-muted-foreground" />{x.user}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};

const UpcsTab = () => {
  const { t } = useLang();
  const [upcs, setUpcs] = useState([]);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');
  const [userFilter, setUserFilter] = useState('');
  // Edit/Delete of catalog UPCs is admin-only (backend require_admin).
  const [canManage, setCanManage] = useState(false);
  useEffect(() => {
    fetch(`${process.env.REACT_APP_BACKEND_URL}/api/auth/me`, { credentials: 'include' })
      .then(r => r.ok ? r.json() : null)
      .then(u => setCanManage(['admin', 'supersu', 'ceo'].includes(u?.role)))
      .catch(() => {});
  }, []);

  // UPC correction tool (admin): fix wrong attributes and cascade to received
  // stock. style/color/size move the stock between inventory lines; descriptive
  // fields update in place. Always previews the impact before applying. Can also
  // be opened by scanning the UPC straight off the label.
  const [fixing, setFixing] = useState(null);     // original UPC doc
  const [fixDraft, setFixDraft] = useState(null); // editable copy
  const { all: SIZES_ORDER } = useWmsSizes();     // full size list (standard + configured)
  const [fixPreview, setFixPreview] = useState(null);
  const [fixBusy, setFixBusy] = useState(false);
  const [scanCode, setScanCode] = useState('');
  const openFix = (u) => { setFixing(u); setFixDraft({ ...u }); setFixPreview(null); };
  const closeFix = () => { setFixing(null); setFixDraft(null); setFixPreview(null); };
  const setFixField = (k, v) => { setFixDraft(p => ({ ...p, [k]: v })); setFixPreview(null); };
  const fixChanges = () => {
    const ch = {};
    if (!fixing || !fixDraft) return ch;
    for (const f of FIX_FIELDS) {
      let v = (fixDraft[f.k] ?? '').toString().trim();
      let cur = (fixing[f.k] ?? '').toString().trim();
      if (f.upper) { v = v.toUpperCase(); cur = cur.toUpperCase(); }
      if (v !== cur) ch[f.k] = v;
    }
    return ch;
  };
  const runFix = async (apply) => {
    const changes = fixChanges();
    if (Object.keys(changes).length === 0) { toast.error(t('wms_no_changes')); return; }
    setFixBusy(true);
    try {
      const res = await poster(`/upc/${encodeURIComponent(fixing.upc)}/correct`, { changes, apply });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { toast.error(data.detail || t('wms_upc_fix_err')); return; }
      if (apply) {
        const mv = data.result?.moved_boxes ? t('wms_boxes_moved_suffix', { n: data.result.moved_boxes }) : '';
        toast.success(t('wms_upc_fixed', { upc: fixing.upc }) + mv);
        setUpcs(prev => prev.map(x => x.upc === fixing.upc ? { ...x, ...changes } : x));
        closeFix();
      } else {
        setFixPreview(data.preview);
      }
    } catch {
      toast.error(t('wms_err_connection'));
    } finally { setFixBusy(false); }
  };
  const scanToFix = async (raw) => {
    const code = (raw || '').trim().toUpperCase();
    if (!code) return;
    try {
      const doc = await fetcher(`/upc/${encodeURIComponent(code)}`);
      if (doc && doc.upc) { openFix(doc); setScanCode(''); }
      else { toast.error(t('wms_upc_not_in_catalog', { upc: code })); }
    } catch {
      toast.error(t('wms_upc_not_in_catalog', { upc: code }));
    }
  };

  useEffect(() => {
    const id = setTimeout(() => setDebounced(search.trim()), 300);
    return () => clearTimeout(id);
  }, [search]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ limit: '1000' });
      if (debounced) params.set('search', debounced);
      const data = await fetcher(`/upc?${params.toString()}`);
      setUpcs(Array.isArray(data) ? data : []);
    } catch (err) {
      logLoadError('upcs')(err);
    } finally { setLoading(false); }
  }, [debounced]);

  useEffect(() => { load(); }, [load]);

  // Distinct creators for the user filter dropdown (only meaningful when the
  // current list has multiple authors — single-author imports get just one).
  const creators = useMemo(() => {
    const set = new Set();
    upcs.forEach(u => { if (u.created_by_name) set.add(u.created_by_name); });
    return Array.from(set).sort();
  }, [upcs]);

  const filtered = useMemo(() => {
    if (!userFilter) return upcs;
    return upcs.filter(u => (u.created_by_name || '') === userFilter);
  }, [upcs, userFilter]);

  const removeUpc = async (u) => {
    if (!window.confirm(t('wms_upc_delete_confirm', { upc: u.upc }))) return;
    try {
      await deleter(`/upc/${encodeURIComponent(u.upc)}`);
      setUpcs(prev => prev.filter(x => x.upc !== u.upc));
      toast.success(t('wms_upc_deleted', { upc: u.upc }));
    } catch {
      toast.error(t('wms_delete_err_admin'));
    }
  };


  return (
    <div className="space-y-4">
      {/* Filters */}
      <div className="flex flex-wrap gap-3 items-center">
        {canManage && (
          <div className="relative min-w-[230px]">
            <Ruler className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <input
              value={scanCode}
              onChange={e => setScanCode(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); scanToFix(scanCode); } }}
              placeholder={t('wms_scan_upc_fix_ph')}
              title={t('wms_scan_upc_fix_title')}
              className={`${cls.input} pl-9`}
            />
          </div>
        )}
        <div className="relative flex-1 min-w-[260px]">
          <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder={t('wms_upc_search_ph')}
            className={`${cls.input} pl-9 pr-9`}
          />
          {search && (
            <button onClick={() => setSearch('')} className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground">
              <X className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
        {creators.length > 1 && (
          <select
            value={userFilter}
            onChange={e => setUserFilter(e.target.value)}
            className="px-3 py-2 bg-card border border-input rounded-md text-sm font-mono"
          >
            <option value="">{t('wms_all_users')}</option>
            {creators.map(c => <option key={c} value={c}>{c}</option>)}
          </select>
        )}
        <div className="text-xs font-mono tabular-nums text-muted-foreground ml-auto">
          {filtered.length.toLocaleString()} UPCs
          {userFilter && ` · ${userFilter}`}
        </div>
      </div>

      {/* Table */}
      <div className="border border-border rounded-lg bg-card overflow-hidden">
        <div className="overflow-auto max-h-[600px] custom-scrollbar">
          <table className="w-full text-sm">
            <thead className={tableCls.thead}>
              <tr>
                <th className={cls.th}>UPC</th>
                <th className={cls.th}>{t('wms_customer_brand_col')}</th>
                <th className={cls.th}>Style</th>
                <th className={cls.th}>{t('wms_color_size_col')}</th>
                <th className={cls.th}>{t('description')}</th>
                <th className={cls.th}>{t('wms_created_by')}</th>
                <th className={cls.th}>{t('date')}</th>
                {canManage && <th className={`${cls.th} text-right`}>{t('actions')}</th>}
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan={canManage ? 8 : 7} className="py-16 text-center text-muted-foreground">
                    <Loader2 className="w-6 h-6 animate-spin mx-auto" />
                  </td>
                </tr>
              ) : filtered.length === 0 ? (
                <tr>
                  <td colSpan={canManage ? 8 : 7} className="py-20 text-center">
                    <p className="text-sm font-semibold text-foreground/80">
                      {upcs.length === 0 ? t('wms_no_upcs') : t('wms_no_matches')}
                    </p>
                  </td>
                </tr>
              ) : (
                filtered.map(u => (
                  <tr key={u.catalog_id || u.upc} className="border-b border-border/60 hover:bg-muted/40 transition-colors">
                    <td className="px-3 py-2.5 font-mono font-medium text-xs">{u.upc}</td>
                    <td className="px-3 py-2.5 text-xs">
                      <div>{u.customer || '—'}</div>
                      {u.brand && <div className="text-xs text-muted-foreground">{u.brand}</div>}
                    </td>
                    <td className="px-3 py-2.5 font-mono text-xs font-medium truncate max-w-[220px]" title={u.style}>{u.style || '—'}</td>
                    <td className="px-3 py-2.5 font-mono text-xs">
                      <span className="text-foreground">{u.color || '—'}</span>
                      <span className="mx-1 text-muted-foreground/40">·</span>
                      <span className="text-foreground">{u.size || '—'}</span>
                    </td>
                    <td className="px-3 py-2.5 text-xs text-muted-foreground truncate max-w-[200px]" title={u.description}>{u.description || '—'}</td>
                    <td className="px-3 py-2.5 text-xs flex items-center gap-1.5">
                      <User className="w-3 h-3 text-muted-foreground" />
                      <span className={u.created_by_name?.startsWith('import_') ? 'text-muted-foreground italic' : 'font-medium'}>
                        {u.created_by_name || '—'}
                      </span>
                    </td>
                    <td className="px-3 py-2.5 font-mono text-xs text-muted-foreground whitespace-nowrap">
                      {u.created_at ? new Date(u.created_at).toLocaleString() : '—'}
                    </td>
                    {canManage && (
                      <td className="px-3 py-2.5 text-right whitespace-nowrap">
                        <div className="flex items-center justify-end gap-1.5">
                          <button onClick={() => openFix(u)} className="p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted transition-colors" title={t('wms_fix_upc_title')}><Ruler className="w-3.5 h-3.5" /></button>
                          <button onClick={() => removeUpc(u)} className="p-1.5 rounded-md text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-500/10 transition-colors" title={t('wms_delete_upc')}><Trash2 className="w-3.5 h-3.5" /></button>
                        </div>
                      </td>
                    )}
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {fixing && (
        <div className="fixed inset-0 z-[80] flex items-center justify-center p-4 bg-black/60 animate-in fade-in duration-150">
          <div className="bg-card border border-border rounded-lg w-full max-w-2xl max-h-[88vh] flex flex-col shadow-xl animate-in zoom-in-95 duration-150">
            <div className="flex items-center justify-between p-5 border-b border-border/20">
              <div>
                <h3 className="font-semibold text-sm">{t('wms_fix_upc')}</h3>
                <p className="text-xs text-muted-foreground">UPC <span className="font-mono">{fixing.upc}</span></p>
              </div>
              <button onClick={closeFix} disabled={fixBusy} className="p-2 hover:bg-secondary rounded-lg transition-all disabled:opacity-50"><X className="w-5 h-5" /></button>
            </div>

            <div className="flex-1 overflow-auto custom-scrollbar p-5 space-y-4">
              <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
                {FIX_FIELDS.map(f => {
                  const changed = fixDraft && (fixDraft[f.k] ?? '').toString().trim().toUpperCase() !== (fixing[f.k] ?? '').toString().trim().toUpperCase();
                  return (
                    <div key={f.k}>
                      <label className="text-xs font-medium text-muted-foreground block mb-1">
                        {f.labelKey ? t(f.labelKey) : f.label}{changed && <span className="ml-1 text-blue-600 dark:text-blue-400">●</span>}
                      </label>
                      {f.size ? (
                        <select value={fixDraft?.[f.k] ?? ''} onChange={e => setFixField(f.k, e.target.value)} className={`w-full px-3 py-2 bg-card border rounded-md text-sm font-mono ${changed ? 'border-blue-500/60' : 'border-border'}`}>
                          <option value="">—</option>
                          {SIZES_ORDER.map(s => <option key={s} value={s}>{s}</option>)}
                        </select>
                      ) : (
                        <input value={fixDraft?.[f.k] ?? ''} onChange={e => setFixField(f.k, f.upper ? e.target.value.toUpperCase() : e.target.value)} className={`w-full px-3 py-2 bg-card border rounded-md text-sm ${f.mono ? 'font-mono font-medium' : ''} ${changed ? 'border-blue-500/60' : 'border-border'}`} />
                      )}
                    </div>
                  );
                })}
              </div>

              {fixPreview && (
                <div className="rounded-lg border border-border bg-muted/40 p-3 text-xs space-y-1">
                  <div className="text-xs font-medium text-muted-foreground mb-1">{t('wms_fix_impact')}</div>
                  <div className="flex justify-between gap-3"><span>{t('wms_fix_fields_change')}</span><span className="font-mono font-medium text-right">{Object.keys(fixPreview.changes || {}).join(', ') || '—'}</span></div>
                  <div className="flex justify-between"><span>{t('wms_fix_receipts')}</span><span className="font-mono font-medium">{fixPreview.receivings}</span></div>
                  <div className="flex justify-between"><span>{t('wms_fix_boxes_total')}</span><span className="font-mono font-medium">{fixPreview.boxes_total}</span></div>
                  <div className="flex justify-between"><span>{t('wms_fix_boxes_moved')}</span><span className="font-mono font-medium">{fixPreview.moved_boxes}</span></div>
                  <div className="flex justify-between"><span>{t('wms_fix_units_moved')}</span><span className="font-mono font-medium">{(fixPreview.moved_units ?? 0).toLocaleString()}</span></div>
                  {fixPreview.blocked?.length > 0 && (
                    <div className="mt-2 flex items-start gap-2 text-amber-700 dark:text-amber-300 bg-amber-50 dark:bg-amber-500/10 border border-amber-200 dark:border-amber-500/25 rounded-md p-2">
                      <AlertTriangle className="w-4 h-4 mt-0.5 flex-shrink-0" />
                      <span className="text-xs font-medium">{t('wms_fix_blocked', { n: fixPreview.blocked.length })}</span>
                    </div>
                  )}
                </div>
              )}

              <p className="text-xs text-muted-foreground">{t('wms_fix_help_1')} <b>{t('wms_fix_help_fields')}</b> {t('wms_fix_help_2')}</p>
            </div>

            <div className="flex gap-2 p-5 border-t border-border/20">
              {!fixPreview ? (
                <button onClick={() => runFix(false)} disabled={fixBusy} className="flex-1 px-4 py-2.5 bg-card border border-border text-foreground rounded-md text-sm font-medium hover:bg-muted transition-colors disabled:opacity-50 flex items-center justify-center gap-2">
                  {fixBusy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Search className="w-4 h-4" />} {t('wms_view_impact')}
                </button>
              ) : (
                <button onClick={() => runFix(true)} disabled={fixBusy || fixPreview.blocked?.length > 0} className="flex-1 px-4 py-2.5 bg-primary text-primary-foreground rounded-md text-sm font-medium hover:opacity-90 transition-colors disabled:opacity-50 flex items-center justify-center gap-2">
                  {fixBusy ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle2 className="w-4 h-4" />} {t('wms_apply_fix')}
                </button>
              )}
              <button onClick={closeFix} disabled={fixBusy} className="px-4 py-2.5 rounded-md text-sm font-medium text-muted-foreground hover:text-foreground hover:bg-muted transition-colors disabled:opacity-50">{t('cancel')}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

// ── Por caja / LPN: full transaction timeline for a single box (Case# 003) ────
const BoxHistoryTab = () => {
  const { t } = useLang();
  const [code, setCode] = useState('');
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [searched, setSearched] = useState(false);

  const search = async (e) => {
    e?.preventDefault();
    const q = code.trim().toUpperCase();
    if (!q) return;
    setLoading(true);
    setSearched(true);
    try {
      const res = await fetcher(`/boxes/${encodeURIComponent(q)}/history`);
      setData(res);
    } catch {
      setData(null);
      toast.error(t('wms_history_err'));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="space-y-4">
      {/* Search */}
      <form onSubmit={search} className="flex items-center gap-2 max-w-xl">
        <div className="relative flex-1">
          <ScanLine className="w-5 h-5 text-muted-foreground absolute left-3 top-1/2 -translate-y-1/2" />
          <input
            autoFocus value={code}
            onChange={(e) => setCode(e.target.value.toUpperCase())}
            placeholder={t('wms_box_history_ph')}
            data-testid="box-history-input"
            className="w-full h-12 pl-11 pr-4 bg-card border border-input rounded-lg font-mono font-medium focus:outline-none focus:ring-2 focus:ring-ring/25 focus:border-ring"
          />
        </div>
        <button type="submit" disabled={loading || !code.trim()}
          className="h-12 px-5 rounded-md bg-primary text-primary-foreground text-sm font-medium disabled:opacity-40 active:scale-95 transition-transform flex items-center gap-2">
          {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Search className="w-4 h-4" />} {t('search')}
        </button>
      </form>

      {loading && (
        <div className="flex items-center justify-center py-16"><Loader2 className="w-8 h-8 animate-spin text-muted-foreground" /></div>
      )}

      {!loading && searched && data && (
        <div className="space-y-4">
          {/* Box summary */}
          <div className="bg-card border border-border rounded-lg p-4 space-y-3">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="text-xs font-medium text-muted-foreground">{t('wms_box_label')}</div>
                <div className="text-lg font-mono font-semibold truncate">{data.box_id}</div>
                {data.found && (
                  <div className="text-sm font-medium text-foreground mt-0.5 truncate">
                    {(data.box?.style || data.box?.sku)} · {data.box?.color} · {data.box?.size}
                  </div>
                )}
              </div>
              {data.found && (
                <div className="text-right flex-shrink-0">
                  <div className="text-2xl font-semibold tabular-nums leading-none">{data.box?.units ?? data.box?.qty ?? 0}</div>
                  <div className="text-xs text-muted-foreground">{t('wms_units_lc')}</div>
                  {(data.box?.units_allocated ?? 0) > 0 && (
                    <div className="text-xs font-medium text-amber-600 dark:text-amber-400 mt-0.5">{t('wms_committed_short', { n: data.box.units_allocated })}</div>
                  )}
                </div>
              )}
            </div>

            {data.found ? (
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-4 gap-y-2 pt-1 border-t border-border/20">
                {[
                  [t('location'), data.box?.location, MapPin],
                  [t('status'), data.box?.status || data.box?.state],
                  [t('wms_label_customer'), data.box?.customer],
                  [t('description'), data.box?.description],
                  [t('wms_country_origin_short'), data.box?.country_of_origin || data.box?.coo],
                  ['Fabric', data.box?.fabric_content],
                  ['LPN / Barcode', data.box?.lpn_id || data.box?.barcode],
                  [t('wms_lot_label'), data.box?.lot_number],
                  [t('wms_dl_receiving'), data.box?.receiving_id],
                  ['ASN', data.box?.asn_reference],
                  ['UPC', data.box?.upc],
                  [t('wms_created_f'), data.box?.created_at ? new Date(data.box.created_at).toLocaleDateString() : null],
                ].filter(([, v]) => v != null && v !== '').map(([label, v, Icon]) => (
                  <div key={label} className="min-w-0">
                    <div className="text-xs font-medium text-muted-foreground">{label}</div>
                    <div className="text-xs font-mono font-medium text-foreground truncate flex items-center gap-1">
                      {Icon && <Icon className="w-3 h-3 text-muted-foreground flex-shrink-0" />}{v}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="text-xs font-medium text-amber-600 dark:text-amber-400 flex items-center gap-1 pt-1 border-t border-border/60">
                <AlertTriangle className="w-3.5 h-3.5" /> {t('wms_box_gone')}
              </div>
            )}
          </div>

          {/* Box events */}
          <div className="bg-card border border-border rounded-lg p-5">
            <div className="text-xs font-medium text-muted-foreground mb-3 flex items-center gap-2">
              <PackageSearch className="w-4 h-4 text-muted-foreground" />
              {t('wms_box_events', { n: data.box_event_count })}
            </div>
            {data.box_events?.length ? (
              <div className="max-h-[420px] overflow-auto custom-scrollbar">
                {data.box_events.map((m, i) => <MovementRow key={m.movement_id || i} m={m} />)}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground italic py-4 text-center">{t('wms_no_box_events')}</p>
            )}
          </div>

          {/* SKU context */}
          {data.sku_context?.length > 0 && (
            <div className="bg-card border border-border rounded-lg p-5">
              <div className="text-xs font-medium text-muted-foreground mb-1 flex items-center gap-2">
                <History className="w-4 h-4" />
                {t('wms_sku_context', { n: data.sku_context_count })}
              </div>
              <p className="text-xs text-muted-foreground mb-3">
                {t('wms_sku_context_desc')}
              </p>
              <div className="max-h-[320px] overflow-auto custom-scrollbar">
                {data.sku_context.map((m, i) => <MovementRow key={m.movement_id || i} m={m} dim />)}
              </div>
            </div>
          )}
        </div>
      )}

      {!loading && searched && !data && (
        <EmptyState art="boxes" title={t('no_results')} />
      )}
    </div>
  );
};

export const MovementsModule = () => {
  const { t } = useLang();
  const [tab, setTab] = useState('movements');
  return (
    <div className="space-y-4">
      <div className="flex gap-1 p-1 bg-muted rounded-lg w-fit">
        {TABS.map(tb => {
          const Icon = tb.icon;
          const active = tab === tb.id;
          return (
            <button
              key={tb.id}
              onClick={() => setTab(tb.id)}
              className={`px-4 py-2 rounded-md text-sm font-medium transition-colors flex items-center gap-2 ${active ? 'bg-card text-foreground' : 'text-muted-foreground hover:text-foreground'}`}
              data-testid={`movements-tab-${tb.id}`}
            >
              <Icon className="w-3.5 h-3.5" />
              {t(tb.labelKey)}
            </button>
          );
        })}
      </div>
      {tab === 'movements' ? <MovementsTab /> : tab === 'box' ? <BoxHistoryTab /> : tab === 'inout' ? <InOutTab /> : <UpcsTab />}
    </div>
  );
};
