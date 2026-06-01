import { useState, useEffect, useCallback, useRef, useMemo, memo, Fragment } from "react";
import { toast } from "sonner";
import { Package, Loader2, Download, Tag, Link2, CheckCircle, MapPin, Search, ScanLine, BarChart3, History, X, Plus } from "lucide-react";
import { useLang } from "../../contexts/LanguageContext";
import { API, fetcher, logLoadError } from "./lib";

// Stable empty array — used as fallback for Typeahead `options` so memo() can
// short-circuit re-renders when there's no source data yet.
const EMPTY = [];

/**
 * Tiny typeahead select: input + filtered dropdown limited to top 50 matches.
 * memo() + stable props (useCallback in caller) keeps it from re-rendering on
 * every parent tick — important because the inventory table paginates in the
 * background and would otherwise re-mount each option list ~every 1.5s.
 */
const Typeahead = memo(function Typeahead({ value, onChange, options, placeholder, disabled, testid }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState(value || '');
  useEffect(() => { setQuery(value || ''); }, [value]);
  const filtered = useMemo(() => {
    const q = (query || '').trim().toUpperCase();
    const list = options || [];
    const matches = q ? list.filter(o => String(o).toUpperCase().includes(q)) : list;
    return matches.slice(0, 50);
  }, [options, query]);
  const select = useCallback((val) => { onChange(val); setQuery(val); setOpen(false); }, [onChange]);
  return (
    <div className="relative">
      <input
        value={query}
        onChange={e => { setQuery(e.target.value.toUpperCase()); setOpen(true); }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        placeholder={placeholder}
        disabled={disabled}
        className="w-full px-3 py-2 bg-background border border-border rounded-lg text-sm font-mono disabled:opacity-50"
        data-testid={testid}
      />
      {open && !disabled && filtered.length > 0 && (
        <div className="absolute top-full left-0 right-0 mt-1 max-h-56 overflow-auto bg-card border border-border/60 rounded-lg shadow-2xl z-[80]">
          {filtered.map(o => (
            <button
              key={o}
              type="button"
              onMouseDown={e => { e.preventDefault(); select(o); }}
              className={`w-full text-left px-3 py-1.5 text-sm font-mono hover:bg-primary/10 ${o === value ? 'bg-primary/15 text-primary' : ''}`}
            >
              {o}
            </button>
          ))}
        </div>
      )}
    </div>
  );
});

export const InventoryModule = ({ initialCustomer = '' }) => {
  const { t } = useLang();
  const [inventory, setInventory] = useState([]);
  const [summary, setSummary] = useState({});
  const [filters, setFilters] = useState({ customers: [], categories: [], manufacturers: [], styles: [], countries: [] });
  const [search, setSearch] = useState('');
  const [customerFilter, setCustomerFilter] = useState(initialCustomer);
  const [categoryFilter, setCategoryFilter] = useState('');
  const [importing, setImporting] = useState(false);
  const [showFilters, setShowFilters] = useState(false);
  const [groupByCustomer, setGroupByCustomer] = useState(false);
  const [historyFor, setHistoryFor] = useState(null); // { style, color, size }
  const [historyData, setHistoryData] = useState(null);
  const [historyLoading, setHistoryLoading] = useState(false);

  // "Cajas" cell expansion: click on the count opens a modal listing the LPNs
  // for that inventory row. Lazy-loaded — we only hit /wms/boxes?inventory_id=…
  // when the user actually wants to look.
  const [boxesFor, setBoxesFor] = useState(null); // { inventory_id, label, location }
  const [boxesList, setBoxesList] = useState([]);
  const [boxesLoading, setBoxesLoading] = useState(false);
  // Manual inventory entry modal — cascading dropdowns only (no free text).
  const [showAddManual, setShowAddManual] = useState(false);
  const [savingManual, setSavingManual] = useState(false);
  const [locationsByZone, setLocationsByZone] = useState({}); // { zone: [locName,...] }
  const [styleInfo, setStyleInfo] = useState(null); // colors, sizes, template
  const [loadingStyleInfo, setLoadingStyleInfo] = useState(false);
  const emptyManualForm = {
    style: '', color: '', size: '',
    zone: '', location: '',
    customer: '', description: '', country_of_origin: '', category: '',
    total_boxes: 0, total_units: 0,
  };
  const [manualForm, setManualForm] = useState(emptyManualForm);
  const zoneOptions = useMemo(() => Object.keys(locationsByZone).sort(), [locationsByZone]);
  const locationsInZone = useMemo(
    () => (manualForm.zone ? (locationsByZone[manualForm.zone] || []) : []),
    [locationsByZone, manualForm.zone],
  );
  // Progressive loading state
  const [totalRows, setTotalRows] = useState(0);
  const [loadingMore, setLoadingMore] = useState(false);
  const PAGE_SIZE = 100;
  const CHUNK_DELAY_MS = 1500; // breathe between chunks so the UI doesn't freeze

  const loadFilters = useCallback(() => { fetcher('/inventory/filters').then(setFilters).catch(logLoadError('data')); }, []);

  // Debounced search value so we don't trigger a fetch on every keystroke.
  const [debouncedSearch, setDebouncedSearch] = useState(search);
  useEffect(() => {
    const id = setTimeout(() => setDebouncedSearch(search), 300);
    return () => clearTimeout(id);
  }, [search]);

  // Build the query params common to every chunk (uses the debounced search).
  const buildBaseParams = useCallback(() => {
    const params = new URLSearchParams({ paginated: 'true', limit: String(PAGE_SIZE) });
    if (debouncedSearch) params.set('style', debouncedSearch);
    if (customerFilter) params.set('customer', customerFilter);
    if (categoryFilter) params.set('category', categoryFilter);
    return params;
  }, [debouncedSearch, customerFilter, categoryFilter]);

  // Cancellation token: increments whenever filters change so old chunks bail
  const loadGenRef = useRef(0);
  // While the manual-entry modal is open we pause chunk paging so the parent
  // re-render storm doesn't bleed into the modal's Typeahead components.
  const modalOpenRef = useRef(false);
  useEffect(() => { modalOpenRef.current = showAddManual; }, [showAddManual]);

  const load = useCallback(() => {
    const myGen = ++loadGenRef.current;
    setInventory([]);
    setTotalRows(0);
    setLoadingMore(true);

    const fetchChunk = async (skip) => {
      const params = buildBaseParams();
      params.set('skip', String(skip));
      try {
        const data = await fetcher(`/inventory?${params.toString()}`);
        if (myGen !== loadGenRef.current) return; // stale, filters changed
        const items = data.items || [];
        setInventory(prev => [...prev, ...items]);
        setTotalRows(data.total || 0);
        if (data.has_more) {
          // Poll-and-resume: if the modal is open we hold off until it closes
          // so the modal's Typeaheads aren't disturbed by chunk re-renders.
          const tick = () => {
            if (myGen !== loadGenRef.current) return;
            if (modalOpenRef.current) { setTimeout(tick, 500); return; }
            fetchChunk(skip + PAGE_SIZE);
          };
          setTimeout(tick, CHUNK_DELAY_MS);
        } else {
          setLoadingMore(false);
        }
      } catch (err) {
        if (myGen === loadGenRef.current) setLoadingMore(false);
        logLoadError('inventory chunk')(err);
      }
    };

    fetchChunk(0);

    const summaryParams = new URLSearchParams();
    if (customerFilter) summaryParams.set('customer', customerFilter);
    fetcher(`/inventory/summary?${summaryParams.toString()}`).then(setSummary).catch(logLoadError('data'));
  }, [buildBaseParams, customerFilter]);

  // Filters (dropdown sources) load once on mount; the inventory itself only
  // loads on-demand when the user actually types a search or applies a filter.
  // Auto-loading 19k+ rows just for opening the screen was killing the app.
  useEffect(() => { loadFilters(); }, [loadFilters]);

  useEffect(() => {
    const hasQuery = (debouncedSearch || '').trim() || customerFilter || categoryFilter;
    if (!hasQuery) {
      // Nothing to look up — cancel any in-flight chunks and clear the table.
      loadGenRef.current += 1;
      setInventory([]);
      setTotalRows(0);
      setLoadingMore(false);
      return;
    }
    load();
  }, [load, debouncedSearch, customerFilter, categoryFilter]);

  const exportExcel = () => window.open(`${API}/export/inventory`, '_blank');

  const handleImport = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setImporting(true);
    try {
      const formData = new FormData();
      formData.append('file', file);
      const res = await fetch(`${API}/import/inventory`, { method: 'POST', credentials: 'include', body: formData });
      if (res.ok) {
        const data = await res.json();
        toast.success(`${t('excel_summary')}: ${data.imported.toLocaleString()} ${t('activity_records')}. ${data.locations_created} ${t('wms_locations')}.`);
        load(); loadFilters();
      } else { const err = await res.json().catch(() => ({})); toast.error(err.detail || t('error')); }
    } catch { toast.error(t('error_connection')); }
    finally { setImporting(false); e.target.value = ''; }
  };

  const openAddManual = async () => {
    setManualForm(emptyManualForm);
    setStyleInfo(null);
    setShowAddManual(true);
    // Lazy-load zone → locations map (only on first open).
    if (Object.keys(locationsByZone).length === 0) {
      try {
        const data = await fetcher('/locations?summary=false&limit=5000');
        const grouped = {};
        for (const l of data) {
          if (!l?.name) continue;
          const z = l.zone || 'SIN ZONA';
          if (!grouped[z]) grouped[z] = [];
          grouped[z].push(l.name);
        }
        for (const z of Object.keys(grouped)) grouped[z].sort();
        setLocationsByZone(grouped);
      } catch (err) { logLoadError('locations lookup')(err); }
    }
  };

  // When the user picks a style, fetch its cascade and pre-fill the editable
  // template fields (customer / description / COO / category) from inventory.
  const onStyleChange = useCallback(async (newStyle) => {
    setManualForm(f => ({ ...f, style: newStyle, color: '', size: '' }));
    setStyleInfo(null);
    if (!newStyle) return;
    setLoadingStyleInfo(true);
    try {
      const info = await fetcher(`/inventory/style-info?style=${encodeURIComponent(newStyle)}`);
      setStyleInfo(info);
      setManualForm(f => ({
        ...f,
        customer: info.customer || f.customer,
        description: info.description || f.description,
        country_of_origin: info.country_of_origin || f.country_of_origin,
        category: info.category || f.category,
      }));
    } catch (err) {
      logLoadError('style info')(err);
      toast.error('No se pudo cargar info del style');
    } finally { setLoadingStyleInfo(false); }
  }, []);

  // Stable handlers for each Typeahead — memo() above relies on prop identity
  // staying the same across the parent's frequent re-renders (chunked paging).
  const onColorChange = useCallback(c => setManualForm(f => ({ ...f, color: c, size: '' })), []);
  const onSizeChange = useCallback(sz => setManualForm(f => ({ ...f, size: sz })), []);
  const onZoneChange = useCallback(z => setManualForm(f => ({ ...f, zone: z, location: '' })), []);
  const onLocationChange = useCallback(loc => setManualForm(f => ({ ...f, location: loc })), []);
  const onCustomerChange = useCallback(c => setManualForm(f => ({ ...f, customer: c })), []);
  const onCooChange = useCallback(co => setManualForm(f => ({ ...f, country_of_origin: co })), []);
  const onCategoryChange = useCallback(cat => setManualForm(f => ({ ...f, category: cat })), []);

  const submitManualAdd = async () => {
    const { style, color, size, location } = manualForm;
    const units = Number(manualForm.total_units) || 0;
    const boxes = Number(manualForm.total_boxes) || 0;
    if (!style) { toast.error('Style es requerido'); return; }
    if (!color) { toast.error('Color es requerido'); return; }
    if (!size) { toast.error('Talla es requerida'); return; }
    if (!location) { toast.error('Ubicación es requerida'); return; }
    if (units <= 0) { toast.error('Unidades debe ser mayor a 0'); return; }
    if (boxes < 0) { toast.error('Cajas no puede ser negativo'); return; }
    setSavingManual(true);
    try {
      // Editable form fields override the style template; everything else is
      // inherited so the new row stays consistent with that SKU's inventory.
      const payload = {
        style, color, size, location,
        total_units: units, total_boxes: boxes,
        customer: (manualForm.customer || styleInfo?.customer || '').toUpperCase(),
        description: (manualForm.description || styleInfo?.description || '').toUpperCase(),
        country_of_origin: (manualForm.country_of_origin || styleInfo?.country_of_origin || '').toUpperCase(),
        category: (manualForm.category || styleInfo?.category || '').toUpperCase(),
        manufacturer: styleInfo?.manufacturer || '',
        size_header: styleInfo?.size_header || '',
        fabric_content: styleInfo?.fabric_content || '',
      };
      const res = await fetch(`${API}/inventory`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(payload),
      });
      if (res.ok) {
        const data = await res.json();
        const msg = data.mode === 'accumulated'
          ? `Inventario acumulado (+${data.added_units} pzs)`
          : `Inventario creado (${data.added_units} pzs)`;
        toast.success(msg);
        setShowAddManual(false);
        // Show what we just added by setting the search to the style — the
        // debounced effect will fetch only matching rows (cheap), instead of
        // pulling all 19k rows back into memory.
        setSearch(style);
        loadFilters();
      } else {
        const err = await res.json().catch(() => ({}));
        toast.error(err.detail || 'Error al guardar');
      }
    } catch (err) {
      logLoadError('manual inventory add')(err);
      toast.error(t('error_connection'));
    } finally { setSavingManual(false); }
  };

  const openHistory = async (inv) => {
    const key = { style: inv.style || inv.sku, color: inv.color || '', size: inv.size || '' };
    setHistoryFor(key);
    setHistoryData(null);
    setHistoryLoading(true);
    try {
      const params = new URLSearchParams({ style: key.style });
      if (key.color) params.set('color', key.color);
      if (key.size) params.set('size', key.size);
      const data = await fetcher(`/inventory/history?${params.toString()}`);
      setHistoryData(data);
    } catch (err) {
      logLoadError('inventory history')(err);
      toast.error('Error al cargar historial');
    } finally {
      setHistoryLoading(false);
    }
  };

  const openBoxes = async (inv) => {
    if (!inv.inventory_id) {
      toast.error('Esta fila no tiene inventory_id — no se pueden listar cajas');
      return;
    }
    const label = [inv.style || inv.sku, inv.color, inv.size].filter(Boolean).join(' · ');
    setBoxesFor({ inventory_id: inv.inventory_id, label, location: inv.inv_location || inv.location || '' });
    setBoxesList([]);
    setBoxesLoading(true);
    try {
      const data = await fetcher(`/boxes?inventory_id=${encodeURIComponent(inv.inventory_id)}`);
      setBoxesList(Array.isArray(data) ? data : []);
    } catch (err) {
      logLoadError('boxes by inventory')(err);
      toast.error('Error al cargar las cajas');
    } finally {
      setBoxesLoading(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-4">
        <div className="text-xs font-black uppercase tracking-widest text-muted-foreground bg-secondary/50 px-3 py-1 rounded-full border border-border/40 flex items-center gap-2">
          <div className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
          {t('wms_stock_monitor')}
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={openAddManual}
            className="px-4 py-2 bg-emerald-500 text-white rounded-xl font-bold uppercase tracking-wider text-xs flex items-center gap-2 transition-all hover:scale-105 shadow-[0_0_15px_rgba(16,185,129,0.3)]"
            data-testid="add-manual-inv-btn"
          >
            <Plus className="w-4 h-4" />
            Agregar Manual
          </button>
          <label className={`px-4 py-2 bg-primary text-black rounded-xl font-bold uppercase tracking-wider text-xs flex items-center gap-2 cursor-pointer transition-all hover:scale-105 shadow-[0_0_15px_rgba(255,193,7,0.3)] ${importing ? 'opacity-50' : ''}`} data-testid="import-inv-btn">
            {importing ? <Loader2 className="w-4 h-4 animate-spin" /> : <Package className="w-4 h-4" />}
            {importing ? t('wms_importing') : t('wms_import_excel')}
            <input type="file" accept=".xlsx,.xls" onChange={handleImport} className="hidden" disabled={importing} />
          </label>
          <button onClick={exportExcel} className="p-2 bg-secondary/80 text-foreground border border-border/40 rounded-xl hover:bg-secondary flex items-center gap-1.5 transition-all" data-testid="export-inv-btn">
            <Download className="w-4 h-4 text-primary" />
          </button>
        </div>
      </div>

      {/* Low Stock Alert */}
      {summary.low_stock_items > 0 && (
        <div className="bg-red-500/10 border border-red-500/20 rounded-2xl p-4 flex items-center gap-4 animate-in fade-in slide-in-from-top-2 duration-500 shadow-lg shadow-red-500/5">
          <div className="w-10 h-10 rounded-full bg-red-500/20 flex items-center justify-center flex-shrink-0">
            <Tag className="w-5 h-5 text-red-400" />
          </div>
          <div className="flex-1">
            <div className="text-sm font-black uppercase tracking-wider text-red-300 leading-tight">{t('wms_critical_alert')}</div>
            <div className="text-xs text-red-400/80 font-medium">{t('wms_critical_msg', { count: summary.low_stock_items })}</div>
          </div>
          <button onClick={() => { setSearch(''); setShowFilters(true); setCategoryFilter('LOW_STOCK'); }} className="px-3 py-1 bg-red-500 text-white text-[10px] font-black uppercase rounded-lg hover:bg-red-600 transition-colors">
            {t('wms_view_now')}
          </button>
        </div>
      )}

      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        {[
          { key: 'wms_total_skus', value: summary.total_skus || 0, color: 'text-purple-400', bg: 'bg-purple-500/10', icon: Tag },
          { key: 'wms_on_hand', value: summary.total_on_hand || 0, color: 'text-blue-400', bg: 'bg-blue-500/10', icon: Package },
          { key: 'wms_allocated', value: summary.total_allocated || 0, color: 'text-orange-400', bg: 'bg-orange-500/10', icon: Link2 },
          { key: 'wms_available', value: summary.total_available || 0, color: 'text-emerald-400', bg: 'bg-emerald-500/10', icon: CheckCircle },
          { key: 'wms_locations', value: summary.total_locations || 0, color: 'text-cyan-400', bg: 'bg-cyan-500/10', icon: MapPin },
        ].map(s => {
          const Icon = s.icon;
          return (
            <div key={s.key} className="border border-border/40 rounded-3xl p-4 bg-card/60 backdrop-blur-sm shadow-xl flex flex-col items-center group hover:scale-[1.02] transition-all">
              <div className={`w-10 h-10 rounded-2xl ${s.bg} flex items-center justify-center mb-3 group-hover:rotate-12 transition-transform`}>
                <Icon className={`w-5 h-5 ${s.color}`} />
              </div>
              <div className={`text-2xl font-black tabular-nums tracking-tighter ${s.color}`}>{(s.value || 0).toLocaleString()}</div>
              <div className="text-[10px] text-muted-foreground font-black uppercase tracking-widest mt-1 opacity-60">{t(s.key)}</div>
            </div>
          );
        })}
      </div>

      <div className="flex gap-2 flex-wrap items-center bg-card/40 p-2 rounded-2xl border border-border/20 backdrop-blur-md">
        <div className="relative flex-1 min-w-[200px]">
          <Search className="absolute left-4 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground opacity-50" />
          <input
            placeholder={t('wms_search_inv')}
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="w-full pl-11 pr-4 py-2.5 bg-background/50 border border-border/40 rounded-xl text-sm text-foreground focus:ring-2 focus:ring-primary/20 transition-all font-medium"
            data-testid="inv-search"
          />
        </div>
        <button
          onClick={() => setShowFilters(!showFilters)}
          className={`px-4 py-2.5 border border-border/40 rounded-xl text-xs font-bold uppercase tracking-widest flex items-center gap-2 transition-all ${showFilters || customerFilter || categoryFilter ? 'bg-primary text-black shadow-[0_0_10px_rgba(255,193,7,0.4)]' : 'bg-secondary/60 text-muted-foreground hover:bg-secondary hover:text-foreground'}`}
          data-testid="inv-toggle-filters"
        >
          <ScanLine className="w-4 h-4" />
          {t('filters')}
          {(customerFilter || categoryFilter) && (
            <span className="bg-black/10 px-2 py-0.5 rounded-lg text-[10px]">
              {[customerFilter, categoryFilter].filter(Boolean).length}
            </span>
          )}
        </button>
        <button
          onClick={() => setGroupByCustomer(!groupByCustomer)}
          className={`px-4 py-2.5 border border-border/40 rounded-xl text-xs font-bold uppercase tracking-widest flex items-center gap-2 transition-all ${groupByCustomer ? 'bg-blue-500 text-white shadow-[0_0_10px_rgba(59,130,246,0.4)]' : 'bg-secondary/60 text-muted-foreground hover:bg-secondary hover:text-foreground'}`}
          data-testid="inv-toggle-group"
        >
          <Package className="w-4 h-4" />
          {groupByCustomer ? t('wms_ungroup') || 'Desagrupar' : t('wms_group_cust') || 'Agrupar Cliente'}
        </button>
      </div>
      {showFilters && (
        <div className="grid grid-cols-2 md:grid-cols-3 gap-3 p-3 border border-border rounded-lg bg-secondary/30" data-testid="inv-filters-panel">
          <div>
            <label className="text-xs uppercase tracking-wider text-muted-foreground font-bold block mb-1">{t('client')}</label>
            <select value={customerFilter} onChange={e => setCustomerFilter(e.target.value)} className="w-full px-2 py-1.5 bg-background border border-border rounded text-sm text-foreground" data-testid="inv-filter-customer">
              <option value="">{t('all')}</option>
              {filters.customers.map(c => <option key={c} value={c}>{c}</option>)}
            </select>
          </div>
          <div>
            <label className="text-xs uppercase tracking-wider text-muted-foreground font-bold block mb-1">{t('category')}</label>
            <select value={categoryFilter} onChange={e => setCategoryFilter(e.target.value)} className="w-full px-2 py-1.5 bg-background border border-border rounded text-sm text-foreground" data-testid="inv-filter-category">
              <option value="">{t('all')}</option>
              {filters.categories.map(c => <option key={c} value={c}>{c}</option>)}
            </select>
          </div>
          <div className="flex items-end">
            <button onClick={() => { setCustomerFilter(''); setCategoryFilter(''); setSearch(''); }} className="px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground border border-border rounded">{t('wms_clear_filters')}</button>
          </div>
        </div>
      )}
      <div className="border border-border/20 rounded-2xl bg-card/40 backdrop-blur-sm overflow-hidden shadow-2xl">
        <div className="overflow-auto max-h-[600px] custom-scrollbar">
          <table className="w-full text-sm">
            <thead className="bg-secondary/80 backdrop-blur-md sticky top-0 z-10 border-b border-border/40">
              <tr>
                <th className="p-4 text-left text-[10px] font-black uppercase tracking-widest text-muted-foreground">{t('customer')}</th>
                <th className="p-4 text-left text-[10px] font-black uppercase tracking-widest text-muted-foreground">{t('wms_style_sku')}</th>
                <th className="p-4 text-left text-[10px] font-black uppercase tracking-widest text-muted-foreground">{t('wms_col_sz')}</th>
                <th className="p-4 text-left text-[10px] font-black uppercase tracking-widest text-muted-foreground">{t('description')}</th>
                <th className="p-4 text-left text-[10px] font-black uppercase tracking-widest text-muted-foreground">{t('location')}</th>
                <th className="p-4 text-left text-[10px] font-black uppercase tracking-widest text-muted-foreground">{t('country_of_origin')}</th>
                <th className="p-4 text-right text-[10px] font-black uppercase tracking-widest text-muted-foreground">{t('wms_boxes')}</th>
                <th className="p-4 text-right text-[10px] font-black uppercase tracking-widest text-muted-foreground">{t('wms_on_hand')}</th>
                <th className="p-4 text-right text-[10px] font-black uppercase tracking-widest text-muted-foreground">{t('wms_allocated')}</th>
                <th className="p-4 text-right text-[10px] font-black uppercase tracking-widest text-muted-foreground">{t('wms_available')}</th>
                <th className="p-4 text-center text-[10px] font-black uppercase tracking-widest text-muted-foreground">Historial</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border/10">
              {groupByCustomer ? (
                Object.entries(
                  inventory.reduce((acc, inv) => {
                    const cust = inv.customer || t('no_client');
                    if (!acc[cust]) acc[cust] = [];
                    acc[cust].push(inv);
                    return acc;
                  }, {})
                ).map(([customer, items]) => (
                  <Fragment key={customer}>
                    <tr className="bg-secondary/30">
                      <td colSpan="11" className="p-3">
                        <div className="flex items-center gap-2">
                          <div className="w-2 h-2 rounded-full bg-primary shadow-[0_0_8px_rgba(255,193,7,0.5)]" />
                          <span className="text-xs font-black uppercase tracking-widest text-foreground">{customer}</span>
                          <span className="text-[10px] font-bold text-muted-foreground ml-2">({items.length} SKUs)</span>
                        </div>
                      </td>
                    </tr>
                    {items.map((inv, i) => (
                      <tr key={inv.inventory_id || i} className="group border-b border-border/5 hover:bg-primary/5 transition-colors">
                        <td className="p-4 text-[11px] font-bold text-muted-foreground/80 opacity-40">{inv.customer}</td>
                        <td className="p-4 font-mono font-black text-primary text-xs uppercase group-hover:scale-105 transition-transform origin-left">{inv.style || inv.sku}</td>
                        <td className="p-4 text-[11px] font-bold">
                          <span className="text-foreground">{inv.color}</span>
                          <span className="mx-1 opacity-20">|</span>
                          <span className="text-primary">{inv.size}</span>
                        </td>
                        <td className="p-4 text-[11px] font-medium text-muted-foreground truncate max-w-[150px]" title={inv.description}>{inv.description}</td>
                        <td className="p-4 font-mono text-[11px] font-black text-emerald-400 flex items-center gap-1.5">
                          <div className="w-1.5 h-1.5 rounded-full bg-emerald-500/40" />
                          {inv.inv_location || '-'}
                        </td>
                        <td className="p-4 text-[11px] font-mono text-muted-foreground/80 uppercase">{inv.country_of_origin || '-'}</td>
                        <td className="p-4 text-right font-mono font-bold">
                          {inv.total_boxes > 0 && inv.inventory_id ? (
                            <button
                              onClick={() => openBoxes(inv)}
                              className="px-2 py-0.5 rounded bg-primary/10 text-primary hover:bg-primary/20 hover:text-primary border border-primary/20 transition-all font-mono font-bold cursor-pointer"
                              title="Ver LPNs (cajas) de esta línea"
                            >
                              {inv.total_boxes.toLocaleString()}
                            </button>
                          ) : (
                            (inv.total_boxes || 0).toLocaleString()
                          )}
                        </td>
                        <td className="p-4 text-right font-mono font-black text-blue-400">{(inv.on_hand || 0).toLocaleString()}</td>
                        <td className="p-4 text-right font-mono font-black text-orange-400">{(inv.allocated || 0).toLocaleString()}</td>
                        <td className="p-4 text-right font-mono font-black text-emerald-400 bg-emerald-500/5">
                          {(inv.available || 0).toLocaleString()}
                        </td>
                        <td className="p-4 text-center">
                          <button onClick={() => openHistory(inv)} className="p-1.5 rounded-lg text-muted-foreground hover:text-primary hover:bg-primary/10 transition-all" title="Ver historial">
                            <History className="w-3.5 h-3.5" />
                          </button>
                        </td>
                      </tr>
                    ))}
                  </Fragment>
                ))
              ) : (
                inventory.map((inv, i) => (
                  <tr key={inv.inventory_id || i} className="group border-b border-border/5 hover:bg-primary/5 transition-colors">
                    <td className="p-4 text-[11px] font-bold text-muted-foreground/80">{inv.customer}</td>
                    <td className="p-4 font-mono font-black text-primary text-xs uppercase group-hover:scale-105 transition-transform origin-left">{inv.style || inv.sku}</td>
                    <td className="p-4 text-[11px] font-bold">
                      <span className="text-foreground">{inv.color}</span>
                      <span className="mx-1 opacity-20">|</span>
                      <span className="text-primary">{inv.size}</span>
                    </td>
                    <td className="p-4 text-[11px] font-medium text-muted-foreground truncate max-w-[150px]" title={inv.description}>{inv.description}</td>
                    <td className="p-4 font-mono text-[11px] font-black text-emerald-400 flex items-center gap-1.5">
                      <div className="w-1.5 h-1.5 rounded-full bg-emerald-500/40" />
                      {inv.inv_location || '-'}
                    </td>
                    <td className="p-4 text-[11px] font-mono text-muted-foreground/80 uppercase">{inv.country_of_origin || '-'}</td>
                    <td className="p-4 text-right font-mono font-bold">{(inv.total_boxes || 0).toLocaleString()}</td>
                    <td className="p-4 text-right font-mono font-black text-blue-400">{(inv.on_hand || 0).toLocaleString()}</td>
                    <td className="p-4 text-right font-mono font-black text-orange-400">{(inv.allocated || 0).toLocaleString()}</td>
                    <td className="p-4 text-right font-mono font-black text-emerald-400 bg-emerald-500/5">
                      {(inv.available || 0).toLocaleString()}
                    </td>
                    <td className="p-4 text-center">
                      <button onClick={() => openHistory(inv)} className="p-1.5 rounded-lg text-muted-foreground hover:text-primary hover:bg-primary/10 transition-all" title="Ver historial">
                        <History className="w-3.5 h-3.5" />
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
          {inventory.length === 0 && !loadingMore && (() => {
            const hasQuery = (debouncedSearch || '').trim() || customerFilter || categoryFilter;
            if (!hasQuery) {
              return (
                <div className="flex flex-col items-center justify-center py-20 text-muted-foreground">
                  <Search className="w-16 h-16 mb-4 stroke-[1px] opacity-40" />
                  <p className="font-bold uppercase tracking-widest text-sm">Busca un producto para empezar</p>
                  <p className="text-xs mt-2 opacity-60 max-w-md text-center">
                    Para no cargar miles de registros de un golpe, escribe un Style/SKU arriba o aplica un filtro de Cliente/Categoría.
                  </p>
                </div>
              );
            }
            return (
              <div className="flex flex-col items-center justify-center py-20 text-muted-foreground opacity-50">
                <BarChart3 className="w-16 h-16 mb-4 stroke-[1px]" />
                <p className="font-bold uppercase tracking-widest text-sm italic">{t('wms_no_inv')}</p>
                <p className="text-xs mt-1">{t('wms_import_hint')}</p>
              </div>
            );
          })()}
        </div>
      </div>
      <div className="flex items-center justify-end gap-3 mt-2">
        {loadingMore && totalRows > 0 && (
          <div className="flex items-center gap-2 text-[10px] font-black uppercase tracking-widest text-emerald-500">
            <Loader2 className="w-3 h-3 animate-spin" />
            Cargando {inventory.length.toLocaleString()} / {totalRows.toLocaleString()}
            <div className="w-24 h-1 bg-secondary/60 rounded-full overflow-hidden">
              <div className="h-full bg-emerald-500 transition-all" style={{ width: `${totalRows > 0 ? (inventory.length / totalRows) * 100 : 0}%` }} />
            </div>
          </div>
        )}
        <div className="text-[10px] font-black uppercase tracking-[0.2em] text-muted-foreground/40">
          {t('wms_showing_records', { count: inventory.length.toLocaleString() })}
        </div>
      </div>

      {/* Boxes (LPN) modal — opened from the "Cajas" cell in the inventory table */}
      {boxesFor && (
        <div className="fixed inset-0 z-[70] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm animate-in fade-in duration-150">
          <div className="bg-card border border-border/50 rounded-3xl w-full max-w-2xl max-h-[85vh] flex flex-col shadow-2xl animate-in zoom-in-95 duration-150">
            <div className="flex items-center justify-between p-5 border-b border-border/20">
              <div className="flex items-center gap-3 min-w-0">
                <div className="w-10 h-10 rounded-2xl bg-primary/10 flex items-center justify-center flex-shrink-0">
                  <Package className="w-5 h-5 text-primary" />
                </div>
                <div className="min-w-0">
                  <div className="text-xs font-black uppercase tracking-widest text-muted-foreground">Cajas / LPNs</div>
                  <div className="font-bold text-foreground truncate">{boxesFor.label}</div>
                  {boxesFor.location && (
                    <div className="text-[11px] font-mono text-emerald-400 flex items-center gap-1 mt-0.5">
                      <MapPin className="w-3 h-3" /> {boxesFor.location}
                    </div>
                  )}
                </div>
              </div>
              <button onClick={() => setBoxesFor(null)} className="p-2 hover:bg-secondary rounded-lg transition-all flex-shrink-0">
                <X className="w-5 h-5 text-muted-foreground" />
              </button>
            </div>
            <div className="flex-1 overflow-auto p-5">
              {boxesLoading ? (
                <div className="flex flex-col items-center justify-center py-16 gap-3">
                  <Loader2 className="w-8 h-8 animate-spin text-primary" />
                  <p className="text-xs uppercase tracking-widest font-bold text-muted-foreground">Cargando cajas…</p>
                </div>
              ) : boxesList.length === 0 ? (
                <div className="text-center py-12 text-muted-foreground">
                  <Package className="w-12 h-12 mx-auto opacity-30 mb-2" />
                  <p className="text-sm font-bold uppercase tracking-widest">Sin cajas registradas</p>
                </div>
              ) : (
                <>
                  <div className="text-[10px] font-black uppercase tracking-widest text-muted-foreground mb-2">
                    {boxesList.length} {boxesList.length === 1 ? 'caja' : 'cajas'} · {boxesList.reduce((s, b) => s + (Number(b.units) || 0), 0).toLocaleString()} unidades
                  </div>
                  <table className="w-full text-sm">
                    <thead className="bg-secondary/40 sticky top-0">
                      <tr>
                        <th className="p-2 text-left text-[10px] font-black uppercase tracking-widest text-muted-foreground">LPN</th>
                        <th className="p-2 text-right text-[10px] font-black uppercase tracking-widest text-muted-foreground">Unidades</th>
                        <th className="p-2 text-left text-[10px] font-black uppercase tracking-widest text-muted-foreground">Ubicación</th>
                        <th className="p-2 text-left text-[10px] font-black uppercase tracking-widest text-muted-foreground">Estado</th>
                      </tr>
                    </thead>
                    <tbody>
                      {boxesList.map((b, i) => (
                        <tr key={b.box_id || i} className="border-b border-border/10 hover:bg-primary/5">
                          <td className="p-2 font-mono text-[11px] font-bold text-primary">{b.box_id || '—'}</td>
                          <td className="p-2 text-right font-mono font-black text-emerald-400">{(b.units || b.qty || 0).toLocaleString()}</td>
                          <td className="p-2 font-mono text-[11px] text-emerald-400">{b.location || '—'}</td>
                          <td className="p-2 text-[10px] font-bold uppercase tracking-wide text-muted-foreground">{b.state || b.status || '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </>
              )}
            </div>
          </div>
        </div>
      )}

      {/* History Modal */}
      {historyFor && (
        <div className="fixed inset-0 z-[70] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm animate-in fade-in duration-150">
          <div className="bg-card border border-border/50 rounded-3xl w-full max-w-4xl max-h-[85vh] flex flex-col shadow-2xl animate-in zoom-in-95 duration-150">
            <div className="flex items-center justify-between p-5 border-b border-border/20">
              <div className="flex items-center gap-3 min-w-0">
                <div className="w-10 h-10 rounded-2xl bg-indigo-500/10 flex items-center justify-center flex-shrink-0">
                  <History className="w-5 h-5 text-indigo-400" />
                </div>
                <div className="min-w-0">
                  <h3 className="font-black uppercase tracking-tighter text-sm truncate">Historial de movimientos</h3>
                  <p className="text-[11px] text-muted-foreground font-bold truncate">
                    <span className="text-primary font-mono">{historyFor.style}</span>
                    {historyFor.color && <> · {historyFor.color}</>}
                    {historyFor.size && <> · {historyFor.size}</>}
                    {historyData && <> · {historyData.count} movimientos</>}
                  </p>
                </div>
              </div>
              <button onClick={() => setHistoryFor(null)} className="p-2 hover:bg-secondary rounded-lg transition-all flex-shrink-0">
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="flex-1 overflow-auto custom-scrollbar">
              {historyLoading ? (
                <div className="flex items-center justify-center py-20">
                  <Loader2 className="w-8 h-8 animate-spin text-indigo-400" />
                </div>
              ) : !historyData?.movements?.length ? (
                <div className="text-center py-20 text-xs text-muted-foreground/40 font-bold uppercase tracking-widest italic">
                  Sin movimientos registrados para este SKU
                </div>
              ) : (
                <table className="w-full text-sm">
                  <thead className="bg-secondary/40 sticky top-0">
                    <tr>
                      <th className="p-3 text-left text-[10px] font-black uppercase tracking-widest text-muted-foreground">Fecha</th>
                      <th className="p-3 text-left text-[10px] font-black uppercase tracking-widest text-muted-foreground">Tipo</th>
                      <th className="p-3 text-left text-[10px] font-black uppercase tracking-widest text-muted-foreground">Detalles</th>
                      <th className="p-3 text-left text-[10px] font-black uppercase tracking-widest text-muted-foreground">Ubicación</th>
                      <th className="p-3 text-right text-[10px] font-black uppercase tracking-widest text-muted-foreground">Cantidad</th>
                      <th className="p-3 text-left text-[10px] font-black uppercase tracking-widest text-muted-foreground">Usuario</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border/10">
                    {historyData.movements.map((m, i) => {
                      const d = m.details || {};
                      // Heuristic sign: receiving / putaway = +, pick / shipment / deduct = -
                      const negativeTypes = new Set(['pick_confirmed', 'shipment', 'neck_cut_delivery', 'deallocate']);
                      const positiveTypes = new Set(['receiving', 'putaway', 'putaway_bulk', 'cycle_count_approved']);
                      const sign = negativeTypes.has(m.type) ? '-' : positiveTypes.has(m.type) ? '+' : '';
                      const qty = d.units ?? d.qty ?? d.total_units ?? d.items_confirmed ?? '';
                      return (
                        <tr key={m.movement_id || i} className="hover:bg-secondary/20 transition-colors">
                          <td className="p-3 text-[11px] font-mono text-muted-foreground/80 whitespace-nowrap">
                            {new Date(m.created_at).toLocaleString([], { month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit' })}
                          </td>
                          <td className="p-3">
                            <span className="text-[10px] font-black uppercase bg-secondary/60 px-2 py-1 rounded text-foreground tracking-widest whitespace-nowrap">
                              {m.type?.replace(/_/g, ' ')}
                            </span>
                          </td>
                          <td className="p-3 text-[11px] text-foreground/80 font-mono truncate max-w-[200px]">
                            {d.box_id || d.ticket_id || d.receiving_id || d.count_id || d.order_number || '—'}
                          </td>
                          <td className="p-3 text-[11px] font-mono text-emerald-400">
                            {d.to || d.location || d.inv_location || '—'}
                          </td>
                          <td className={`p-3 text-right font-mono font-black tabular-nums ${sign === '-' ? 'text-red-400' : sign === '+' ? 'text-emerald-400' : 'text-foreground'}`}>
                            {qty !== '' ? `${sign}${qty}` : '—'}
                          </td>
                          <td className="p-3 text-[11px] text-muted-foreground truncate max-w-[120px]">{m.user_name || '—'}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Manual inventory entry modal */}
      {showAddManual && (
        <div className="fixed inset-0 z-[70] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm animate-in fade-in duration-150">
          <div className="bg-card border border-emerald-500/40 rounded-3xl w-full max-w-2xl max-h-[90vh] flex flex-col shadow-2xl animate-in zoom-in-95 duration-150">
            <div className="flex items-center justify-between p-5 border-b border-border/20">
              <div className="flex items-center gap-3 min-w-0">
                <div className="w-10 h-10 rounded-2xl bg-emerald-500/10 flex items-center justify-center flex-shrink-0">
                  <Plus className="w-5 h-5 text-emerald-400" />
                </div>
                <div className="min-w-0">
                  <h3 className="font-black uppercase tracking-tighter text-sm truncate">Agregar inventario manual</h3>
                  <p className="text-[11px] text-muted-foreground font-bold truncate">
                    Si la combinación SKU+color+talla+ubicación ya existe, se acumula.
                  </p>
                </div>
              </div>
              <button onClick={() => !savingManual && setShowAddManual(false)} className="p-2 hover:bg-secondary rounded-lg transition-all flex-shrink-0" disabled={savingManual}>
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="flex-1 overflow-auto custom-scrollbar p-5 space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <div className="col-span-2">
                  <label className="text-[10px] font-black uppercase tracking-widest text-muted-foreground block mb-1">Style / SKU *</label>
                  <Typeahead
                    value={manualForm.style}
                    onChange={onStyleChange}
                    options={filters.styles || EMPTY}
                    placeholder="Escribe para buscar… ej: 1001"
                    testid="manual-style"
                  />
                </div>
                <div>
                  <label className="text-[10px] font-black uppercase tracking-widest text-muted-foreground block mb-1">Color *</label>
                  <Typeahead
                    value={manualForm.color}
                    onChange={onColorChange}
                    options={styleInfo?.colors || EMPTY}
                    placeholder={loadingStyleInfo ? 'Cargando…' : (styleInfo ? 'Escribe… ej: BLA → BLACK' : 'Elige style primero')}
                    disabled={!styleInfo || loadingStyleInfo}
                    testid="manual-color"
                  />
                </div>
                <div>
                  <label className="text-[10px] font-black uppercase tracking-widest text-muted-foreground block mb-1">Talla *</label>
                  <Typeahead
                    value={manualForm.size}
                    onChange={onSizeChange}
                    options={styleInfo?.sizes || EMPTY}
                    placeholder={manualForm.color ? 'Escribe… ej: M' : 'Elige color primero'}
                    disabled={!manualForm.color}
                    testid="manual-size"
                  />
                </div>
                <div>
                  <label className="text-[10px] font-black uppercase tracking-widest text-muted-foreground block mb-1">Zona *</label>
                  <Typeahead
                    value={manualForm.zone}
                    onChange={onZoneChange}
                    options={zoneOptions}
                    placeholder="Escribe… ej: RP06"
                    testid="manual-zone"
                  />
                </div>
                <div>
                  <label className="text-[10px] font-black uppercase tracking-widest text-muted-foreground block mb-1">Ubicación *</label>
                  <Typeahead
                    value={manualForm.location}
                    onChange={onLocationChange}
                    options={locationsInZone}
                    placeholder={manualForm.zone ? 'Escribe… ej: B15' : 'Elige zona primero'}
                    disabled={!manualForm.zone}
                    testid="manual-location"
                  />
                </div>
                <div>
                  <label className="text-[10px] font-black uppercase tracking-widest text-muted-foreground block mb-1">Cliente</label>
                  <Typeahead
                    value={manualForm.customer}
                    onChange={onCustomerChange}
                    options={filters.customers || EMPTY}
                    placeholder="Escribe… ej: GIL"
                    testid="manual-customer"
                  />
                </div>
                <div>
                  <label className="text-[10px] font-black uppercase tracking-widest text-muted-foreground block mb-1">País de origen</label>
                  <Typeahead
                    value={manualForm.country_of_origin}
                    onChange={onCooChange}
                    options={filters.countries || EMPTY}
                    placeholder="Escribe… ej: HON"
                    testid="manual-coo"
                  />
                </div>
                <div>
                  <label className="text-[10px] font-black uppercase tracking-widest text-muted-foreground block mb-1">Categoría</label>
                  <Typeahead
                    value={manualForm.category}
                    onChange={onCategoryChange}
                    options={filters.categories || EMPTY}
                    placeholder="Escribe…"
                    testid="manual-category"
                  />
                </div>
                <div className="col-span-2">
                  <label className="text-[10px] font-black uppercase tracking-widest text-muted-foreground block mb-1">Descripción</label>
                  <input
                    value={manualForm.description}
                    onChange={e => setManualForm(f => ({ ...f, description: e.target.value.toUpperCase() }))}
                    placeholder="Heredada del style; puedes editarla"
                    className="w-full px-3 py-2 bg-background border border-border rounded-lg text-sm font-mono"
                    data-testid="manual-description"
                  />
                </div>
                <div>
                  <label className="text-[10px] font-black uppercase tracking-widest text-muted-foreground block mb-1">Cajas</label>
                  <input
                    type="number"
                    min="0"
                    value={manualForm.total_boxes}
                    onChange={e => setManualForm(f => ({ ...f, total_boxes: e.target.value }))}
                    className="w-full px-3 py-2 bg-background border border-border rounded-lg text-sm font-mono tabular-nums"
                  />
                </div>
                <div>
                  <label className="text-[10px] font-black uppercase tracking-widest text-muted-foreground block mb-1">Unidades *</label>
                  <input
                    type="number"
                    min="1"
                    value={manualForm.total_units}
                    onChange={e => setManualForm(f => ({ ...f, total_units: e.target.value }))}
                    className="w-full px-3 py-2 bg-background border border-border rounded-lg text-sm font-mono tabular-nums font-bold"
                    data-testid="manual-units"
                  />
                </div>
              </div>
            </div>

            <div className="flex items-center justify-end gap-2 p-5 border-t border-border/20">
              <button
                onClick={() => setShowAddManual(false)}
                disabled={savingManual}
                className="px-4 py-2 text-xs font-bold uppercase tracking-widest text-muted-foreground hover:text-foreground transition-all"
              >
                Cancelar
              </button>
              <button
                onClick={submitManualAdd}
                disabled={savingManual}
                className="px-5 py-2 bg-emerald-500 text-white rounded-xl font-bold uppercase tracking-wider text-xs flex items-center gap-2 transition-all hover:bg-emerald-600 disabled:opacity-50"
                data-testid="manual-submit-btn"
              >
                {savingManual ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
                Guardar
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
