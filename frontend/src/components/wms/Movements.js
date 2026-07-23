import { useState, useEffect, useCallback, useMemo } from "react";
import { History, Tag, Search, X, Loader2, User, Trash2, CheckCircle2, ArrowDownUp, Download, ArrowDownCircle, ArrowUpCircle, Ruler, AlertTriangle, PackageSearch, MapPin, ScanLine } from "lucide-react";
import * as XLSX from "xlsx";
import { toast } from "sonner";
import { useLang } from "../../contexts/LanguageContext";
import { fetcher, poster, deleter, logLoadError, useWmsSizes } from "./lib";
import { Btn, Chip, cls, tableCls } from "./ui";

const TABS = [
  { id: 'movements', label: 'Movimientos',       icon: History },
  { id: 'box',       label: 'Por caja / LPN',    icon: PackageSearch },
  { id: 'inout',     label: 'Entradas / Salidas', icon: ArrowDownUp },
  { id: 'upcs',      label: 'UPCs',              icon: Tag },
];

// Human labels for the movement types a box's timeline can surface.
const MV_TYPE_LABELS = {
  receiving: 'Recepción',
  receiving_update: 'Recepción editada',
  putaway: 'Ubicado (putaway)',
  putaway_bulk: 'Ubicado en lote',
  box_edited: 'Caja editada',
  box_deleted: 'Caja eliminada',
  inventory_adjust_box: 'Ajuste por caja',
  lpn_reconciled: 'LPN reconciliado',
  bulk_relocation: 'Reubicación masiva',
  transit_relocation: 'Reubicación de tránsito',
  edit_finished_good: 'Producto terminado editado',
  production_move: 'Movido a producción',
  shipment: 'Embarque',
  allocation: 'Asignación',
  deallocate: 'Desasignación',
  pick_ticket_created: 'Pick ticket creado',
  pick_confirmed: 'Surtido confirmado',
  pick_progress: 'Avance de surtido',
  neck_cut_delivery: 'Surtido a producción (neck)',
  manual_inventory_add: 'Entrada manual',
  manual_inventory_remove: 'Salida manual',
};

// Spanish labels for the raw detail keys shown in the expanded event view.
const DETAIL_LABELS = {
  from: 'Origen', from_sources: 'Orígenes', sources: 'Orígenes',
  to: 'Destino', to_loc: 'Destino', location: 'Ubicación',
  sku: 'SKU', style: 'Estilo', color: 'Color', size: 'Talla',
  units: 'Unidades', units_moved: 'Unidades movidas (total)',
  old_units: 'Unidades antes', new_units: 'Unidades después', delta_units: 'Cambio',
  added_units: 'Unidades +', removed_units: 'Unidades −',
  added_boxes: 'Cajas +', removed_boxes: 'Cajas −',
  box_units_received: 'Unidades de esta caja',
  total_units: 'Total recibido (recibo completo)',
  boxes_moved: 'Cajas movidas (total)', skus_moved: 'SKUs movidos',
  count: 'Cajas', boxes_relocated: 'Cajas reubicadas', boxes_split: 'Cajas divididas',
  reason: 'Motivo', order_number: 'Orden', receiving_id: 'Recibo',
  is_bpo: 'BPO', updated_fields: 'Campos editados', mode: 'Modo',
  box_deleted: 'Caja eliminada', changes: 'Cambios', box_id: 'Caja',
  box_ids: 'Cajas', inventory_id: 'Inventario', ticket_id: 'Ticket',
  asn_id: 'ASN', po_number: 'OC', customer: 'Cliente', manufacturer: 'Fabricante',
  physical_lpn: 'LPN físico',
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

const fmtDetailVal = (k, v) => {
  if (v == null || v === '') return '—';
  if (Array.isArray(v)) {
    if (v.length === 0) return '—';
    if ((k === 'box_ids') && v.length > 6) return `${v.slice(0, 6).join(', ')} … (+${v.length - 6})`;
    return v.join(', ');
  }
  if (typeof v === 'boolean') return v ? 'Sí' : 'No';
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
const summarizeMovement = (m) => {
  const d = m.details || {};
  const origin = d.from || (Array.isArray(d.from_sources) && d.from_sources.join(', '))
    || (Array.isArray(d.sources) && d.sources.join(', ')) || '';
  const dest = d.to || d.to_loc || '';
  const parts = [];
  if (origin || dest) parts.push(`${origin || '—'} → ${dest || '—'}`);
  else if (d.location) parts.push(d.location);
  if (d.old_units != null && d.new_units != null) parts.push(`${d.old_units} → ${d.new_units} u`);
  else if (d.box_units_received != null) parts.push(`${d.box_units_received} u (esta caja)`);
  else if (d.units != null) parts.push(`${d.units} u`);
  else if (d.units_moved != null) parts.push(`${d.units_moved} u (total)`);
  else if (d.added_units != null) parts.push(`+${d.added_units} u`);
  else if (d.removed_units != null) parts.push(`−${d.removed_units} u`);
  else if (d.total_units != null) parts.push(`${d.total_units} u (recibo)`);
  if (Array.isArray(d.updated_fields) && d.updated_fields.length) parts.push(`campos: ${d.updated_fields.join(', ')}`);
  if (d.order_number) parts.push(`OC ${d.order_number}`);
  if (d.reason) parts.push(`“${d.reason}”`);
  return parts.join(' · ');
};

// One expandable event row in a box's timeline. Collapsed shows a summary;
// expanded reveals every detail field of the movement.
const MovementRow = ({ m, dim }) => {
  const [open, setOpen] = useState(false);
  const entries = detailEntries(m.details);
  return (
    <div className={`border-b border-border/60 last:border-0 ${dim ? 'opacity-70' : ''}`}>
      <button onClick={() => setOpen(o => !o)} className="w-full flex items-start gap-3 py-3 text-left">
        <div className="min-w-0 flex-1">
          <div className="text-sm flex items-center gap-2 flex-wrap">
            <Chip>{MV_TYPE_LABELS[m.type] || m.type?.replace(/_/g, ' ')}</Chip>
            {summarizeMovement(m) && (
              <span className="text-xs text-muted-foreground font-mono">
                {summarizeMovement(m)}
              </span>
            )}
          </div>
          <div className="text-xs text-muted-foreground mt-0.5">
            {new Date(m.created_at).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}
            {' · '}{m.user_name || m.user_id || 'Sistema'}
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
                {DETAIL_LABELS[k] || k}
              </div>
              <div className="text-xs font-mono text-foreground break-all py-0.5">{fmtDetailVal(k, v)}</div>
            </div>
          ))}
          <div className="text-xs font-medium text-muted-foreground py-0.5">ID mov.</div>
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
  { k: 'color', label: 'Color', upper: true },
  { k: 'size', label: 'Talla', size: true },
  { k: 'customer', label: 'Cliente', upper: true },
  { k: 'manufacturer', label: 'Fabricante', upper: true },
  { k: 'brand', label: 'Marca', upper: true },
  { k: 'description', label: 'Descripción' },
  { k: 'country_of_origin', label: 'País de origen', upper: true },
  { k: 'fabric_content', label: 'Fabric / Contenido' },
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
          <div className="flex flex-col items-center justify-center py-20">
            <p className="text-sm font-semibold text-foreground/80">{t('wms_no_movements')}</p>
          </div>
        )}
        {movements.length >= MOVEMENTS_LIMIT && (
          <div className="pt-3 text-center text-xs text-amber-600 dark:text-amber-400">
            Mostrando los {MOVEMENTS_LIMIT.toLocaleString()} movimientos más recientes — usa los filtros para acotar
          </div>
        )}
      </div>
    </div>
  );
};

// ── Entradas / Salidas (ajustes manuales de inventario) ───────────────────────
const InOutTab = () => {
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
        let isIn, units, boxes = 0, tag = '';
        if (type === 'manual_inventory_add') {
          isIn = true; units = d.added_units ?? 0; boxes = d.added_boxes ?? 0;
          tag = d.mode === 'accumulated' ? 'ACUMULADO' : 'NUEVO';
        } else if (type === 'manual_inventory_remove') {
          isIn = false; units = d.removed_units ?? 0; boxes = d.removed_boxes ?? 0;
        } else if (type === 'inventory_adjust_box') {
          const dl = Number(d.delta_units ?? 0);
          isIn = dl >= 0; units = Math.abs(dl); tag = 'AJUSTE (MOVER)';
        } else { // inventory_adjustment / inventory_adjustment_create (ajuste masivo)
          const dl = Number(d.delta ?? 0);
          isIn = dl >= 0; units = Math.abs(dl);
          tag = type === 'inventory_adjustment_create' ? 'AJUSTE NUEVO (MASIVO)' : 'AJUSTE MASIVO';
        }
        return {
          created_at: m.created_at,
          direction: isIn ? 'ENTRADA' : 'SALIDA',
          isIn,
          reason: d.reason || tag || (isIn ? 'NUEVO' : ''),
          style: d.style || d.sku || '',
          color: d.color || '',
          size: d.size || '',
          location: d.location || '',
          units,
          boxes,
          user: m.user_name || m.user_id || 'Sistema',
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

  const filtered = useMemo(() => {
    let r = rows;
    if (dir !== 'all') r = r.filter(x => (dir === 'in' ? x.isIn : !x.isIn));
    const q = search.trim().toUpperCase();
    if (q) r = r.filter(x =>
      `${x.style} ${x.color} ${x.size} ${x.location} ${x.reason} ${x.user}`.toUpperCase().includes(q)
    );
    return r;
  }, [rows, dir, search]);

  const totals = useMemo(() => ({
    in: filtered.filter(x => x.isIn).reduce((s, x) => s + (Number(x.units) || 0), 0),
    out: filtered.filter(x => !x.isIn).reduce((s, x) => s + (Number(x.units) || 0), 0),
  }), [filtered]);

  const exportExcel = () => {
    if (filtered.length === 0) { toast.error('No hay registros para exportar'); return; }
    const data = filtered.map(x => ({
      'Fecha': x.created_at ? new Date(x.created_at).toLocaleString() : '',
      'Tipo': x.direction,
      'Motivo': x.reason,
      'Style / SKU': x.style,
      'Color': x.color,
      'Talla': x.size,
      'Ubicación': x.location,
      'Unidades': Number(x.units) || 0,
      'Cajas': Number(x.boxes) || 0,
      'Usuario': x.user,
    }));
    const ws = XLSX.utils.json_to_sheet(data);
    ws['!cols'] = [{ wch: 20 }, { wch: 10 }, { wch: 22 }, { wch: 18 }, { wch: 12 }, { wch: 8 }, { wch: 14 }, { wch: 10 }, { wch: 8 }, { wch: 22 }];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Entradas_Salidas');
    XLSX.writeFile(wb, `entradas_salidas_${new Date().toISOString().split('T')[0]}.xlsx`);
  };

  const dirTabs = [
    { id: 'all', label: 'Todas' },
    { id: 'in',  label: 'Entradas' },
    { id: 'out', label: 'Salidas' },
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
            placeholder="Buscar style / color / ubicación / motivo / usuario…"
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
          <span className="text-muted-foreground">{filtered.length.toLocaleString()} reg.</span>
        </div>
        <Btn onClick={exportExcel} data-testid="inout-export-btn">
          <Download className="w-4 h-4" /> Exportar Excel
        </Btn>
      </div>

      <div className="border border-border rounded-lg bg-card overflow-hidden">
        <div className="overflow-auto max-h-[600px] custom-scrollbar">
          <table className="w-full text-sm">
            <thead className={tableCls.thead}>
              <tr>
                {['Fecha', 'Tipo', 'Motivo', 'Style / SKU', 'Color · Talla', 'Ubicación', 'Unidades', 'Cajas', 'Usuario'].map(h => (
                  <th key={h} className={cls.th}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td colSpan={9} className="py-16 text-center text-muted-foreground"><Loader2 className="w-6 h-6 animate-spin mx-auto" /></td></tr>
              ) : filtered.length === 0 ? (
                <tr>
                  <td colSpan={9} className="py-20 text-center">
                    <p className="text-sm font-semibold text-foreground/80">Sin entradas ni salidas manuales</p>
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
    if (Object.keys(changes).length === 0) { toast.error('No hay cambios que aplicar'); return; }
    setFixBusy(true);
    try {
      const res = await poster(`/upc/${encodeURIComponent(fixing.upc)}/correct`, { changes, apply });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { toast.error(data.detail || 'No se pudo corregir el UPC'); return; }
      if (apply) {
        const mv = data.result?.moved_boxes ? ` · ${data.result.moved_boxes} cajas movidas` : '';
        toast.success(`UPC ${fixing.upc} corregido${mv}`);
        setUpcs(prev => prev.map(x => x.upc === fixing.upc ? { ...x, ...changes } : x));
        closeFix();
      } else {
        setFixPreview(data.preview);
      }
    } catch {
      toast.error('Error de conexión');
    } finally { setFixBusy(false); }
  };
  const scanToFix = async (raw) => {
    const code = (raw || '').trim().toUpperCase();
    if (!code) return;
    try {
      const doc = await fetcher(`/upc/${encodeURIComponent(code)}`);
      if (doc && doc.upc) { openFix(doc); setScanCode(''); }
      else { toast.error(`UPC ${code} no está en el catálogo`); }
    } catch {
      toast.error(`UPC ${code} no está en el catálogo`);
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
    if (!window.confirm(`¿Eliminar el UPC ${u.upc} del catálogo? Los recibos ya hechos NO se afectan.`)) return;
    try {
      await deleter(`/upc/${encodeURIComponent(u.upc)}`);
      setUpcs(prev => prev.filter(x => x.upc !== u.upc));
      toast.success(`UPC ${u.upc} eliminado del catálogo`);
    } catch {
      toast.error('No se pudo eliminar (¿permisos de admin?)');
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
              placeholder="Escanear UPC para corregir…"
              title="Escanea o teclea el UPC y presiona Enter para abrir la corrección"
              className={`${cls.input} pl-9`}
            />
          </div>
        )}
        <div className="relative flex-1 min-w-[260px]">
          <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Buscar UPC / style / color / customer / brand…"
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
            <option value="">Todos los usuarios</option>
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
                <th className={cls.th}>Cliente / Brand</th>
                <th className={cls.th}>Style</th>
                <th className={cls.th}>Color · Talla</th>
                <th className={cls.th}>Descripción</th>
                <th className={cls.th}>Creado por</th>
                <th className={cls.th}>Fecha</th>
                {canManage && <th className={`${cls.th} text-right`}>Acciones</th>}
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
                      {upcs.length === 0 ? 'No hay UPCs en el catálogo' : 'Sin coincidencias'}
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
                          <button onClick={() => openFix(u)} className="p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted transition-colors" title="Corregir UPC (y el stock ya recibido)"><Ruler className="w-3.5 h-3.5" /></button>
                          <button onClick={() => removeUpc(u)} className="p-1.5 rounded-md text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-500/10 transition-colors" title="Eliminar UPC"><Trash2 className="w-3.5 h-3.5" /></button>
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
                <h3 className="font-semibold text-sm">Corregir UPC</h3>
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
                        {f.label}{changed && <span className="ml-1 text-blue-600 dark:text-blue-400">●</span>}
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
                  <div className="text-xs font-medium text-muted-foreground mb-1">Impacto de la corrección</div>
                  <div className="flex justify-between gap-3"><span>Campos a cambiar</span><span className="font-mono font-medium text-right">{Object.keys(fixPreview.changes || {}).join(', ') || '—'}</span></div>
                  <div className="flex justify-between"><span>Recibos afectados</span><span className="font-mono font-medium">{fixPreview.receivings}</span></div>
                  <div className="flex justify-between"><span>Cajas con este UPC</span><span className="font-mono font-medium">{fixPreview.boxes_total}</span></div>
                  <div className="flex justify-between"><span>Cajas que se mueven</span><span className="font-mono font-medium">{fixPreview.moved_boxes}</span></div>
                  <div className="flex justify-between"><span>Unidades que se mueven</span><span className="font-mono font-medium">{(fixPreview.moved_units ?? 0).toLocaleString()}</span></div>
                  {fixPreview.blocked?.length > 0 && (
                    <div className="mt-2 flex items-start gap-2 text-amber-700 dark:text-amber-300 bg-amber-50 dark:bg-amber-500/10 border border-amber-200 dark:border-amber-500/25 rounded-md p-2">
                      <AlertTriangle className="w-4 h-4 mt-0.5 flex-shrink-0" />
                      <span className="text-xs font-medium">Hay unidades asignadas a órdenes en {fixPreview.blocked.length} ubicación(es). Desasigna esas órdenes antes de aplicar.</span>
                    </div>
                  )}
                </div>
              )}

              <p className="text-xs text-muted-foreground">Cambiar <b>Style, Color o Talla</b> mueve el stock ya recibido a la línea de inventario corregida; los demás campos se actualizan en sitio. Revisa el impacto antes de aplicar.</p>
            </div>

            <div className="flex gap-2 p-5 border-t border-border/20">
              {!fixPreview ? (
                <button onClick={() => runFix(false)} disabled={fixBusy} className="flex-1 px-4 py-2.5 bg-card border border-border text-foreground rounded-md text-sm font-medium hover:bg-muted transition-colors disabled:opacity-50 flex items-center justify-center gap-2">
                  {fixBusy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Search className="w-4 h-4" />} Ver impacto
                </button>
              ) : (
                <button onClick={() => runFix(true)} disabled={fixBusy || fixPreview.blocked?.length > 0} className="flex-1 px-4 py-2.5 bg-primary text-primary-foreground rounded-md text-sm font-medium hover:opacity-90 transition-colors disabled:opacity-50 flex items-center justify-center gap-2">
                  {fixBusy ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle2 className="w-4 h-4" />} Aplicar corrección
                </button>
              )}
              <button onClick={closeFix} disabled={fixBusy} className="px-4 py-2.5 rounded-md text-sm font-medium text-muted-foreground hover:text-foreground hover:bg-muted transition-colors disabled:opacity-50">Cancelar</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

// ── Por caja / LPN: full transaction timeline for a single box (Case# 003) ────
const BoxHistoryTab = () => {
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
      toast.error('No se pudo obtener el historial');
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
            placeholder="Escanea o teclea el número de caja / LPN"
            data-testid="box-history-input"
            className="w-full h-12 pl-11 pr-4 bg-card border border-input rounded-lg font-mono font-medium focus:outline-none focus:ring-2 focus:ring-ring/25 focus:border-ring"
          />
        </div>
        <button type="submit" disabled={loading || !code.trim()}
          className="h-12 px-5 rounded-md bg-primary text-primary-foreground text-sm font-medium disabled:opacity-40 active:scale-95 transition-transform flex items-center gap-2">
          {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Search className="w-4 h-4" />} Buscar
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
                <div className="text-xs font-medium text-muted-foreground">Caja</div>
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
                  <div className="text-xs text-muted-foreground">unidades</div>
                  {(data.box?.units_allocated ?? 0) > 0 && (
                    <div className="text-xs font-medium text-amber-600 dark:text-amber-400 mt-0.5">{data.box.units_allocated} comprom.</div>
                  )}
                </div>
              )}
            </div>

            {data.found ? (
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-4 gap-y-2 pt-1 border-t border-border/20">
                {[
                  ['Ubicación', data.box?.location, MapPin],
                  ['Estado', data.box?.status || data.box?.state],
                  ['Cliente', data.box?.customer],
                  ['Descripción', data.box?.description],
                  ['País origen', data.box?.country_of_origin || data.box?.coo],
                  ['Fabric', data.box?.fabric_content],
                  ['LPN / Barcode', data.box?.lpn_id || data.box?.barcode],
                  ['Lote', data.box?.lot_number],
                  ['Recibo', data.box?.receiving_id],
                  ['ASN', data.box?.asn_reference],
                  ['UPC', data.box?.upc],
                  ['Creada', data.box?.created_at ? new Date(data.box.created_at).toLocaleDateString() : null],
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
                <AlertTriangle className="w-3.5 h-3.5" /> La caja ya no existe (eliminada/embarcada). Mostrando su historial.
              </div>
            )}
          </div>

          {/* Box events */}
          <div className="bg-card border border-border rounded-lg p-5">
            <div className="text-xs font-medium text-muted-foreground mb-3 flex items-center gap-2">
              <PackageSearch className="w-4 h-4 text-muted-foreground" />
              Eventos de esta caja ({data.box_event_count})
            </div>
            {data.box_events?.length ? (
              <div className="max-h-[420px] overflow-auto custom-scrollbar">
                {data.box_events.map((m, i) => <MovementRow key={m.movement_id || i} m={m} />)}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground italic py-4 text-center">Sin eventos registrados para esta caja.</p>
            )}
          </div>

          {/* SKU context */}
          {data.sku_context?.length > 0 && (
            <div className="bg-card border border-border rounded-lg p-5">
              <div className="text-xs font-medium text-muted-foreground mb-1 flex items-center gap-2">
                <History className="w-4 h-4" />
                Contexto del SKU/ubicación ({data.sku_context_count})
              </div>
              <p className="text-xs text-muted-foreground mb-3">
                Movimientos del mismo SKU que no nombran una caja específica (asignaciones, surtido, conteos). Útil para diagnóstico, no exclusivo de esta caja.
              </p>
              <div className="max-h-[320px] overflow-auto custom-scrollbar">
                {data.sku_context.map((m, i) => <MovementRow key={m.movement_id || i} m={m} dim />)}
              </div>
            </div>
          )}
        </div>
      )}

      {!loading && searched && !data && (
        <div className="flex flex-col items-center justify-center py-16">
          <p className="text-sm font-semibold text-foreground/80">Sin resultados</p>
        </div>
      )}
    </div>
  );
};

export const MovementsModule = () => {
  const [tab, setTab] = useState('movements');
  return (
    <div className="space-y-4">
      <div className="flex gap-1 p-1 bg-muted rounded-lg w-fit">
        {TABS.map(t => {
          const Icon = t.icon;
          const active = tab === t.id;
          return (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`px-4 py-2 rounded-md text-sm font-medium transition-colors flex items-center gap-2 ${active ? 'bg-card text-foreground' : 'text-muted-foreground hover:text-foreground'}`}
              data-testid={`movements-tab-${t.id}`}
            >
              <Icon className="w-3.5 h-3.5" />
              {t.label}
            </button>
          );
        })}
      </div>
      {tab === 'movements' ? <MovementsTab /> : tab === 'box' ? <BoxHistoryTab /> : tab === 'inout' ? <InOutTab /> : <UpcsTab />}
    </div>
  );
};
