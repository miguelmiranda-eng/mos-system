import { useState, useEffect, useCallback, useRef, useMemo, memo, Fragment } from "react";
import { toast } from "sonner";
import { Package, Loader2, Download, Tag, Link2, CheckCircle, MapPin, Search, ScanLine, BarChart3, History, X, Plus, Minus, ListFilter, ChevronRight } from "lucide-react";
import { Popover, PopoverTrigger, PopoverContent } from "../ui/popover";
import { useLang } from "../../contexts/LanguageContext";
import { API, fetcher, logLoadError, ALL_SIZES } from "./lib";
import { ModuleHeader, StatCard, SoftAlert, Btn, cls, tableCls } from "./ui";

// Stable empty array — used as fallback for Typeahead `options` so memo() can
// short-circuit re-renders when there's no source data yet.
const EMPTY = [];
// Standard apparel sizes — always offered as suggestions so a brand-new style
// (not yet in inventory) still shows the usual sizes to choose from. Fuente única
// en lib.js (notación canónica 2X/3X/…, incluye youth y toddler).
const STD_SIZES = ALL_SIZES;

/**
 * Header con filtro tipo Dashboard: el label + un icono ListFilter que abre un
 * Popover con buscador + lista clickeable de valores distintos. Single-select.
 * El icono se ilumina cuando el filtro tiene valor.
 */
const ColFilterHeader = memo(function ColFilterHeader({ label, value, onChange, placeholder, mono, options }) {
  const active = !!(value || '').trim();
  // The typed text IS the filter (works even when there's no options list, e.g.
  // location/description). The options below are quick-picks filtered by it.
  const filtered = useMemo(() => {
    const list = Array.isArray(options) ? options : [];
    const q = (value || '').trim().toUpperCase();
    if (!q) return list.slice(0, 200);
    return list.filter(o => String(o).toUpperCase().includes(q)).slice(0, 200);
  }, [options, value]);

  return (
    <div className="flex items-center gap-1.5">
      <span>{label}</span>
      <Popover>
        <PopoverTrigger asChild>
          <button
            type="button"
            className={`p-0.5 rounded transition-colors flex-shrink-0 ${active ? 'bg-primary/20 text-primary animate-pulse' : 'hover:bg-secondary text-muted-foreground'}`}
            title={`Filtrar por ${label}`}
            onClick={e => e.stopPropagation()}
          >
            <ListFilter className="w-3.5 h-3.5" />
          </button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-64 p-2">
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs font-medium text-muted-foreground">{label}</span>
            {active && (
              <button onClick={() => onChange('')} className="text-[10px] font-bold text-destructive hover:underline uppercase">
                Limpiar
              </button>
            )}
          </div>
          <input
            autoFocus
            value={value || ''}
            onChange={e => onChange(e.target.value)}
            placeholder={placeholder}
            className={`w-full h-8 px-2 bg-secondary/50 border border-border rounded text-xs ${mono ? 'font-mono' : ''} focus:ring-1 focus:ring-primary outline-none mb-1.5`}
          />
          <div className="max-h-56 overflow-y-auto custom-scrollbar -mx-0.5">
            {filtered.length === 0 ? (
              <p className="text-[11px] text-muted-foreground italic px-2 py-3 text-center">Sin coincidencias</p>
            ) : (
              filtered.map(opt => {
                const isSel = String(opt).toUpperCase() === String(value || '').toUpperCase();
                return (
                  <button
                    key={opt}
                    type="button"
                    onClick={() => onChange(opt)}
                    className={`w-full text-left px-2 py-1.5 rounded text-xs transition-colors ${mono ? 'font-mono' : ''} ${isSel ? 'bg-primary/15 text-primary font-bold' : 'hover:bg-secondary/60 text-foreground'}`}
                    title={opt}
                  >
                    <span className="truncate block">{opt}</span>
                  </button>
                );
              })
            )}
          </div>
        </PopoverContent>
      </Popover>
    </div>
  );
});

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
  // Free text: commit whatever was typed (not just list picks) so brand-new
  // styles/colors/sizes/locations can be entered. Commits on blur / Enter to
  // avoid firing onChange (and any fetch it triggers) on every keystroke.
  const commitFree = useCallback(() => {
    const v = (query || '').trim();
    if (v !== (value || '')) onChange(v);
  }, [query, value, onChange]);
  return (
    <div className="relative">
      <input
        value={query}
        onChange={e => { setQuery(e.target.value.toUpperCase()); setOpen(true); }}
        onFocus={() => setOpen(true)}
        onBlur={() => { commitFree(); setTimeout(() => setOpen(false), 150); }}
        onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); commitFree(); setOpen(false); } }}
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

export const InventoryModule = ({ initialCustomer = '', currentUser = null }) => {
  const { t } = useLang();
  // "Agregar Manual" es un ajuste de inventario: solo nivel 2+. El backend ya
  // exige require_inventory_level(2) en POST /inventory — esto solo evita
  // ofrecer un botón que terminaría en 403.
  const canAddManual = ['admin', 'supersu'].includes(currentUser?.role)
    ? true
    : (parseInt(currentUser?.inventory_level, 10) || 0) >= 2;
  const [inventory, setInventory] = useState([]);
  const [summary, setSummary] = useState({});
  const [filters, setFilters] = useState({ customers: [], categories: [], manufacturers: [], styles: [], countries: [], fabrics: [] });
  // Cascading per-column options: valid values for each field given the OTHER
  // active filters (customer -> styles/colors/sizes of that customer, etc.).
  const [facets, setFacets] = useState({ customers: [], styles: [], colors: [], sizes: [], locations: [], countries: [], fabrics: [] });
  const [search, setSearch] = useState('');
  const [customerFilter, setCustomerFilter] = useState(initialCustomer);
  const [categoryFilter, setCategoryFilter] = useState('');
  // Per-column filters mostrados como popover (ícono ListFilter) en el header.
  // Todas las columnas de datos. El backend soporta cada key como regex i.
  const [colFilters, setColFilters] = useState({
    customer: '', sku: '', color: '', size: '', description: '', location: '',
    country_of_origin: '', fabric_content: '',
  });
  const [debouncedColFilters, setDebouncedColFilters] = useState(colFilters);
  useEffect(() => {
    const id = setTimeout(() => setDebouncedColFilters(colFilters), 300);
    return () => clearTimeout(id);
  }, [colFilters]);
  const updateColFilter = (key, value) => setColFilters(p => ({ ...p, [key]: value }));
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
  // Case# 007 — inline expansion of the box (LPN) numbers under a row, so the
  // box visibility doesn't require opening the modal. Cached per inventory_id.
  const [expandedBoxes, setExpandedBoxes] = useState(null);   // inventory_id
  const [boxesCache, setBoxesCache] = useState({});           // inv_id -> boxes[]
  const [boxesRowLoading, setBoxesRowLoading] = useState(null); // inv_id
  // Manual inventory entry modal — cascading dropdowns only (no free text).
  const [showAddManual, setShowAddManual] = useState(false);
  const [savingManual, setSavingManual] = useState(false);
  // "Nuevo estilo con varios items": one style header + a list of color/size
  // line items, all created in one batch (entrada).
  const [multiMode, setMultiMode] = useState(false);
  const [styleItems, setStyleItems] = useState([{ color: '', size: '', zone: '', location: '', total_boxes: 0, total_units: 0 }]);
  const [multiDone, setMultiDone] = useState(0);
  // 'add' = meter (entrada) · 'remove' = sacar (salida / ajuste a la baja)
  const [manualOp, setManualOp] = useState('add');
  const [locationsByZone, setLocationsByZone] = useState({}); // { zone: [locName,...] }
  const [styleInfo, setStyleInfo] = useState(null); // colors, sizes, template
  const [loadingStyleInfo, setLoadingStyleInfo] = useState(false);
  const emptyManualForm = {
    style: '', color: '', size: '',
    zone: '', location: '',
    customer: '', description: '', country_of_origin: '', fabric_content: '', category: '',
    total_boxes: 0, total_units: 0,
    box_id: '',  // Case# 006: real box number for positive adjustments
    reason: '',
  };
  // Motivos para la bitácora de auditoría (entrada y salida).
  const ADD_REASONS = ['RECEPCIÓN', 'AJUSTE DE CONTEO', 'DEVOLUCIÓN DE CLIENTE', 'PRODUCCIÓN', 'TRASLADO', 'OTRO'];
  const REMOVE_REASONS = ['MERMA', 'AJUSTE DE CONTEO', 'DAÑO / DEFECTO', 'TRASLADO', 'DEVOLUCIÓN A PROVEEDOR', 'OTRO'];
  const [manualForm, setManualForm] = useState(emptyManualForm);
  const zoneOptions = useMemo(() => Object.keys(locationsByZone).sort(), [locationsByZone]);
  // Flat list of EVERY location (all zones, incl. CARRO/TRANSIT/RECEIVING) + a
  // name→zone map. Ubicación ALWAYS offers every location (filter by typing) so
  // nothing is hidden behind a zone selection; the zone auto-fills on pick.
  const allLocations = useMemo(() => {
    const names = [];
    for (const z of Object.keys(locationsByZone)) names.push(...(locationsByZone[z] || []));
    return [...new Set(names)].sort();
  }, [locationsByZone]);
  const locZoneMap = useMemo(() => {
    const map = {};
    for (const z of Object.keys(locationsByZone)) for (const n of (locationsByZone[z] || [])) map[n] = z;
    return map;
  }, [locationsByZone]);
  const locationsInZone = useMemo(
    () => (manualForm.zone ? (locationsByZone[manualForm.zone] || []) : []),
    [locationsByZone, manualForm.zone],
  );
  // With a zone chosen, show ONLY that zone's locations (e.g. CARROS → CARRO 1-50);
  // with no zone, show every location. Falls back to all if the typed zone has none.
  const locationOptions = useMemo(
    () => (manualForm.zone && locationsInZone.length ? locationsInZone : allLocations),
    [manualForm.zone, locationsInZone, allLocations],
  );
  // Size suggestions = this style's existing sizes + the standard set, so new
  // styles still offer the usual sizes (and any value can be typed anyway).
  const sizeOptions = useMemo(
    () => [...new Set([...(styleInfo?.sizes || []), ...STD_SIZES])],
    [styleInfo],
  );
  // Progressive loading state
  const [totalRows, setTotalRows] = useState(0);
  const [loadingMore, setLoadingMore] = useState(false);
  const [capped, setCapped] = useState(false);
  const PAGE_SIZE = 100;
  const CHUNK_DELAY_MS = 1500; // breathe between chunks so the UI doesn't freeze
  // Cap how many rows we hold in memory / paint at once. Thousands of <tr> nodes
  // crush RAM on warehouse PDAs/tablets. The grid stops at this many; the full
  // dataset is still reachable via the totals/summary and the Excel export.
  const MAX_GRID_ROWS = 1500;

  const loadFilters = useCallback(() => { fetcher('/inventory/filters').then(setFilters).catch(logLoadError('data')); }, []);

  // Cascade: refetch the valid options for every column whenever the active
  // filters change. The top Customer dropdown also feeds the cascade.
  const loadFacets = useCallback(() => {
    const eff = { ...debouncedColFilters };
    if (!eff.customer && customerFilter) eff.customer = customerFilter;
    const p = new URLSearchParams();
    Object.entries(eff).forEach(([k, v]) => { const val = (v || '').trim(); if (val) p.set(k, val); });
    fetcher(`/inventory/facets?${p.toString()}`).then(setFacets).catch(logLoadError('facets'));
  }, [debouncedColFilters, customerFilter]);
  useEffect(() => { loadFacets(); }, [loadFacets]);

  // Sizes in apparel order (XS,S,M,L,XL,2X…) instead of alphabetical.
  const facetSizes = useMemo(() => [...(facets.sizes || [])].sort((a, b) => {
    const ia = STD_SIZES.indexOf(a), ib = STD_SIZES.indexOf(b);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || String(a).localeCompare(String(b));
  }), [facets.sizes]);

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
    // Per-column filters — el backend soporta cada uno como regex case-insensitive
    Object.entries(debouncedColFilters).forEach(([k, v]) => {
      const val = (v || '').trim();
      if (val) params.set(k, val);
    });
    return params;
  }, [debouncedSearch, customerFilter, categoryFilter, debouncedColFilters]);

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
    setCapped(false);
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
        if (data.has_more && (skip + PAGE_SIZE) < MAX_GRID_ROWS) {
          // Poll-and-resume: if the modal is open we hold off until it closes
          // so the modal's Typeaheads aren't disturbed by chunk re-renders.
          const tick = () => {
            if (myGen !== loadGenRef.current) return;
            if (modalOpenRef.current) { setTimeout(tick, 500); return; }
            fetchChunk(skip + PAGE_SIZE);
          };
          setTimeout(tick, CHUNK_DELAY_MS);
        } else {
          // Stopped because we hit the row cap (more rows still exist server-side).
          if (data.has_more) setCapped(true);
          setLoadingMore(false);
        }
      } catch (err) {
        if (myGen === loadGenRef.current) setLoadingMore(false);
        logLoadError('inventory chunk')(err);
      }
    };

    fetchChunk(0);
  }, [buildBaseParams]);

  // Summary cards (TOTAL SKUS / ON HAND / ALLOCATED / AVAILABLE / UBICACIONES)
  // load on mount + when customer filter changes — independent del grid, así
  // los headlines del módulo no se ven en cero al abrir.
  const loadSummary = useCallback(() => {
    const summaryParams = new URLSearchParams();
    if (customerFilter) summaryParams.set('customer', customerFilter);
    fetcher(`/inventory/summary?${summaryParams.toString()}`).then(setSummary).catch(logLoadError('summary'));
  }, [customerFilter]);
  useEffect(() => { loadSummary(); }, [loadSummary]);

  // Group rows by customer once per data/flag change instead of re-reducing the
  // whole array on every render (search keystrokes, chunk arrivals, hovers…).
  const groupedInventory = useMemo(() => {
    if (!groupByCustomer) return null;
    const acc = {};
    for (const inv of inventory) {
      const cust = inv.customer || t('no_client');
      (acc[cust] = acc[cust] || []).push(inv);
    }
    return Object.entries(acc);
  }, [inventory, groupByCustomer, t]);

  // Filters (dropdown sources) load once on mount; the inventory itself only
  // loads on-demand when the user actually types a search or applies a filter.
  // Auto-loading 19k+ rows just for opening the screen was killing the app.
  useEffect(() => { loadFilters(); }, [loadFilters]);

  // True when ANY filter — el search global, customer/category, o cualquier
  // col-filter — tiene contenido. Solo entonces disparamos el load del grid
  // (para no traer 21k filas al abrir).
  const hasAnyFilter = (
    (debouncedSearch || '').trim() ||
    customerFilter ||
    categoryFilter ||
    Object.values(debouncedColFilters).some(v => (v || '').trim())
  );

  useEffect(() => {
    if (!hasAnyFilter) {
      // Nothing to look up — cancel any in-flight chunks and clear the table.
      loadGenRef.current += 1;
      setInventory([]);
      setTotalRows(0);
      setLoadingMore(false);
      return;
    }
    load();
  }, [load, hasAnyFilter]);

  const [excludeHold, setExcludeHold] = useState(false);
  // El export respeta el cliente activo (columna filtrada o el filtro general).
  // Sin cliente, baja todos — igual que antes. Con cliente, el Excel trae solo
  // ese cliente, para que columnas como UPC (hoy solo SPEKTRUM) no se pierdan
  // entre 23k renglones de todos.
  const exportExcel = () => {
    const params = new URLSearchParams();
    if (excludeHold) params.set('exclude_hold', 'true');
    const cust = (colFilters.customer || customerFilter || '').trim();
    if (cust) params.set('customer', cust);
    const qs = params.toString();
    window.open(`${API}/export/inventory${qs ? `?${qs}` : ''}`, '_blank');
  };

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
    setManualOp('add');
    setStyleInfo(null);
    setMultiMode(false);
    setStyleItems([{ color: '', size: '', zone: '', location: '', total_boxes: 0, total_units: 0 }]);
    setMultiDone(0);
    setShowAddManual(true);
    // Lazy-load zone → locations map (only on first open).
    if (Object.keys(locationsByZone).length === 0) {
      try {
        const data = await fetcher('/locations/names');
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
        fabric_content: info.fabric_content || f.fabric_content,
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
  const onLocationChange = useCallback(loc => setManualForm(f => ({
    ...f, location: loc,
    // Keep the zone in sync with the picked location (auto-fill / correct it).
    zone: locZoneMap[loc] || f.zone,
  })), [locZoneMap]);
  const onCustomerChange = useCallback(c => setManualForm(f => ({ ...f, customer: c })), []);
  const onCooChange = useCallback(co => setManualForm(f => ({ ...f, country_of_origin: co })), []);
  const onFabricChange = useCallback(fc => setManualForm(f => ({ ...f, fabric_content: fc })), []);
  const onCategoryChange = useCallback(cat => setManualForm(f => ({ ...f, category: cat })), []);

  const submitManualAdd = async () => {
    const { style, color, size, location } = manualForm;
    const units = Number(manualForm.total_units) || 0;
    // Positive adjustments are now ONE real box per add (Case# 006); removals
    // still take a box count.
    const isAdd = manualOp !== 'remove';
    const boxId = (manualForm.box_id || '').trim().toUpperCase();
    const boxes = isAdd ? 1 : (Number(manualForm.total_boxes) || 0);
    if (!style) { toast.error('Style es requerido'); return; }
    if (!color) { toast.error('Color es requerido'); return; }
    if (!size) { toast.error('Talla es requerida'); return; }
    if (!location) { toast.error('Ubicación es requerida'); return; }
    if (units <= 0) { toast.error('Unidades debe ser mayor a 0'); return; }
    if (isAdd && !boxId) { toast.error('Número de caja (LPN) es requerido'); return; }
    if (!isAdd && boxes < 0) { toast.error('Cajas no puede ser negativo'); return; }
    if (!manualForm.reason) { toast.error(`Selecciona el motivo de la ${manualOp === 'remove' ? 'salida' : 'entrada'}`); return; }
    setSavingManual(true);
    try {
      // Editable form fields override the style template; everything else is
      // inherited so the new row stays consistent with that SKU's inventory.
      const payload = {
        style, color, size, location,
        operation: manualOp,
        reason: manualForm.reason,
        total_units: units, total_boxes: boxes,
        ...(isAdd ? { box_id: boxId } : {}),
        customer: (manualForm.customer || styleInfo?.customer || '').toUpperCase(),
        description: (manualForm.description || styleInfo?.description || '').toUpperCase(),
        country_of_origin: (manualForm.country_of_origin || styleInfo?.country_of_origin || '').toUpperCase(),
        category: (manualForm.category || styleInfo?.category || '').toUpperCase(),
        manufacturer: styleInfo?.manufacturer || '',
        size_header: styleInfo?.size_header || '',
        fabric_content: (manualForm.fabric_content || styleInfo?.fabric_content || '').toUpperCase(),
      };
      const res = await fetch(`${API}/inventory`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(payload),
      });
      if (res.ok) {
        const data = await res.json();
        const boxNote = data.box_id ? ` · Caja ${data.box_id}` : '';
        const msg = data.mode === 'removed'
          ? `Material retirado (-${data.removed_units} pzs)`
          : data.mode === 'accumulated'
            ? `Inventario acumulado (+${data.added_units} pzs)${boxNote}`
            : `Inventario creado (${data.added_units} pzs)${boxNote}`;
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

  // ── Nuevo estilo con varios items ─────────────────────────────────────────
  const addStyleItem = () => setStyleItems(items => [...items, { color: '', size: '', zone: '', location: '', total_boxes: 0, total_units: 0 }]);
  const removeStyleItem = (i) => setStyleItems(items => (items.length > 1 ? items.filter((_, idx) => idx !== i) : items));
  const updateStyleItem = (i, patch) => setStyleItems(items => items.map((it, idx) => (idx === i ? { ...it, ...patch } : it)));

  const submitMultiAdd = async () => {
    const style = (manualForm.style || '').trim();
    if (!style) { toast.error('Style es requerido'); return; }
    if (!manualForm.reason) { toast.error('Selecciona el motivo de la entrada'); return; }
    const items = styleItems.filter(it => it.color && it.size && it.location && (Number(it.total_units) || 0) > 0);
    if (items.length === 0) { toast.error('Agrega al menos un item con color, talla, ubicación y unidades'); return; }
    const header = {
      customer: (manualForm.customer || '').toUpperCase(),
      description: (manualForm.description || '').toUpperCase(),
      country_of_origin: (manualForm.country_of_origin || '').toUpperCase(),
      category: (manualForm.category || '').toUpperCase(),
      fabric_content: (manualForm.fabric_content || '').toUpperCase(),
    };
    setSavingManual(true);
    setMultiDone(0);
    let ok = 0, fail = 0;
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      const payload = {
        style, color: it.color, size: it.size, location: it.location,
        operation: 'add', reason: manualForm.reason,
        total_units: Number(it.total_units) || 0, total_boxes: Number(it.total_boxes) || 0,
        ...header,
      };
      try {
        const res = await fetch(`${API}/inventory`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          credentials: 'include', body: JSON.stringify(payload),
        });
        if (res.ok) ok++; else fail++;
      } catch { fail++; }
      setMultiDone(i + 1);
    }
    setSavingManual(false);
    toast.success(`Estilo ${style}: ${ok} item(s) creado(s)${fail ? ` · ${fail} con error` : ''}`);
    if (ok) { setShowAddManual(false); setSearch(style); loadFilters(); }
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

  // Toggle the inline LPN list beneath a row (Case# 007). Lazy + cached.
  const toggleInlineBoxes = async (inv) => {
    if (!inv.inventory_id) { toast.error('Esta fila no tiene inventory_id'); return; }
    if (expandedBoxes === inv.inventory_id) { setExpandedBoxes(null); return; }
    setExpandedBoxes(inv.inventory_id);
    if (!boxesCache[inv.inventory_id]) {
      setBoxesRowLoading(inv.inventory_id);
      try {
        const data = await fetcher(`/boxes?inventory_id=${encodeURIComponent(inv.inventory_id)}`);
        setBoxesCache(c => ({ ...c, [inv.inventory_id]: Array.isArray(data) ? data : [] }));
      } catch (err) {
        logLoadError('boxes inline')(err);
        toast.error('Error al cargar las cajas');
      } finally {
        setBoxesRowLoading(null);
      }
    }
  };

  // The "Cajas" cell: chevron toggles the inline LPN list; the number opens the
  // modal (both kept — Case# 007).
  const renderCajasCell = (inv) => (
    inv.total_boxes > 0 && inv.inventory_id ? (
      <div className="flex items-center justify-end gap-1">
        <button onClick={() => toggleInlineBoxes(inv)} title="Ver/ocultar las cajas (LPNs) aquí"
          className="p-0.5 rounded text-muted-foreground hover:text-primary transition-all">
          <ChevronRight className={`w-3.5 h-3.5 transition-transform ${expandedBoxes === inv.inventory_id ? 'rotate-90 text-primary' : ''}`} />
        </button>
        <button onClick={() => openBoxes(inv)} title="Ver LPNs en ventana"
          className="px-2 py-0.5 rounded-md border border-border bg-card hover:bg-muted transition-colors font-mono font-medium cursor-pointer underline-offset-2 hover:underline">
          {inv.total_boxes.toLocaleString()}
        </button>
      </div>
    ) : (
      (inv.total_boxes || 0).toLocaleString()
    )
  );

  // The inline sub-row listing each box (LPN) under an expanded inventory line.
  const renderBoxesSubRow = (inv) => (
    expandedBoxes === inv.inventory_id ? (
      <tr className="bg-muted/30 border-b border-border/60">
        <td colSpan="14" className="px-6 py-2.5">
          {boxesRowLoading === inv.inventory_id ? (
            <div className="flex items-center gap-2 text-xs text-muted-foreground py-1">
              <Loader2 className="w-4 h-4 animate-spin" /> Cargando cajas…
            </div>
          ) : (boxesCache[inv.inventory_id]?.length ? (
            <div className="space-y-1.5">
              <div className="text-xs font-medium text-muted-foreground">
                {boxesCache[inv.inventory_id].length} caja(s) en {inv.inv_location || inv.location || '—'}
              </div>
              <div className="flex flex-wrap gap-1.5">
                {boxesCache[inv.inventory_id].map((b, i) => (
                  <span key={b.box_id || i} className="inline-flex items-center gap-1.5 px-2 py-1 rounded-md bg-card border border-border text-xs"
                    title={`${b.state || b.status || ''}`}>
                    <span className="font-mono">{b.box_id || '—'}</span>
                    <span className="font-mono font-semibold">{(b.units || b.qty || 0).toLocaleString()}u</span>
                  </span>
                ))}
              </div>
            </div>
          ) : (
            <div className="text-xs text-muted-foreground py-1 italic">Sin cajas registradas para esta línea.</div>
          ))}
        </td>
      </tr>
    ) : null
  );

  return (
    <div className="space-y-6">
      <ModuleHeader
        title="Inventory"
        subtitle={t('wms_stock_monitor')}
        right={
        <div className="flex items-center gap-2">
          {/* RETIRADOS 2026-07-22 (pedido del usuario): "Agregar Manual" e
              "Importar Excel". Ambos creaban renglones de inventario SIN cajas
              fisicas detras — la fuente de los "saldos sin cajas" (el import
              masivo es el principal sospechoso de los ~68k u fantasma en
              CARROS 413-438). En el modelo "la caja manda" el inventario entra
              por Recepcion, que SI genera cajas; nunca por renglon suelto.
              Handlers y modales quedan por si se rehabilitan con candado
              supersu. */}
          <label className="flex items-center gap-1.5 text-sm text-muted-foreground cursor-pointer select-none px-1" title="Excluir las locaciones en HOLD (SAT) del reporte exportado">
            <input type="checkbox" checked={excludeHold} onChange={e => setExcludeHold(e.target.checked)} className="accent-primary w-3.5 h-3.5" data-testid="exclude-hold-chk" />
            Excluir HOLD
          </label>
          <Btn onClick={exportExcel} data-testid="export-inv-btn">
            <Download className="w-4 h-4" /> Export
          </Btn>
        </div>
        }
      />

      {/* Low Stock Alert */}
      {summary.low_stock_items > 0 && (
        <SoftAlert
          tone="warning"
          title={t('wms_critical_alert')}
          action={
            <Btn onClick={() => { setSearch(''); setShowFilters(true); setCategoryFilter('LOW_STOCK'); }}>
              {t('wms_view_now')}
            </Btn>
          }
        >
          {t('wms_critical_msg', { count: summary.low_stock_items })}
        </SoftAlert>
      )}

      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        {[
          { key: 'wms_total_skus', value: summary.total_skus || 0 },
          { key: 'wms_on_hand', value: summary.total_on_hand || 0 },
          { key: 'wms_allocated', value: summary.total_allocated || 0 },
          { key: 'wms_available', value: summary.total_available || 0 },
          { key: 'wms_locations', value: summary.total_locations || 0 },
        ].map(s => (
          <StatCard key={s.key} label={t(s.key)} value={(s.value || 0).toLocaleString()} />
        ))}
      </div>

      <div className="flex gap-2 flex-wrap items-center">
        <div className="relative flex-1 min-w-[200px] max-w-md">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground/60" />
          <input
            placeholder={t('wms_search_inv')}
            value={search}
            onChange={e => setSearch(e.target.value)}
            className={`${cls.input} pl-9`}
            data-testid="inv-search"
          />
        </div>
        <div className="flex-1" />
        <Btn
          variant={showFilters || customerFilter || categoryFilter ? "primary" : "default"}
          onClick={() => setShowFilters(!showFilters)}
          data-testid="inv-toggle-filters"
        >
          {t('filters')}
          {(customerFilter || categoryFilter) && (
            <span className="bg-black/10 px-1.5 py-0.5 rounded text-xs">
              {[customerFilter, categoryFilter].filter(Boolean).length}
            </span>
          )}
        </Btn>
        <Btn
          variant={groupByCustomer ? "primary" : "default"}
          onClick={() => setGroupByCustomer(!groupByCustomer)}
          data-testid="inv-toggle-group"
        >
          {groupByCustomer ? t('wms_ungroup') || 'Desagrupar' : t('wms_group_cust') || 'Agrupar Cliente'}
        </Btn>
      </div>
      {showFilters && (
        <div className="grid grid-cols-2 md:grid-cols-3 gap-3 p-3 border border-border rounded-lg bg-secondary/30" data-testid="inv-filters-panel">
          <div>
            <label className="text-xs font-medium text-muted-foreground block mb-1">{t('client')}</label>
            <select value={customerFilter} onChange={e => setCustomerFilter(e.target.value)} className="w-full px-2 py-1.5 bg-background border border-border rounded text-sm text-foreground" data-testid="inv-filter-customer">
              <option value="">{t('all')}</option>
              {filters.customers.map(c => <option key={c} value={c}>{c}</option>)}
            </select>
          </div>
          <div>
            <label className="text-xs font-medium text-muted-foreground block mb-1">{t('category')}</label>
            <select value={categoryFilter} onChange={e => setCategoryFilter(e.target.value)} className="w-full px-2 py-1.5 bg-background border border-border rounded text-sm text-foreground" data-testid="inv-filter-category">
              <option value="">{t('all')}</option>
              {filters.categories.map(c => <option key={c} value={c}>{c}</option>)}
            </select>
          </div>
          <div className="flex items-end">
            <button onClick={() => { setCustomerFilter(''); setCategoryFilter(''); setSearch(''); setColFilters({ customer: '', country_of_origin: '', fabric_content: '' }); }} className="px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground border border-border rounded">{t('wms_clear_filters')}</button>
          </div>
        </div>
      )}
      <div className="border border-border rounded-lg bg-card overflow-hidden">
        <div className="overflow-auto max-h-[600px] custom-scrollbar">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 sticky top-0 z-10 border-b border-border">
              <tr>
                <th className="px-3 py-2.5 text-left text-xs font-semibold text-muted-foreground whitespace-nowrap">
                  <ColFilterHeader label={t('customer')} value={colFilters.customer} onChange={v => updateColFilter('customer', v)} placeholder="Buscar cliente…" options={facets.customers.length ? facets.customers : filters.customers} />
                </th>
                {/* Style y SKU son dos identidades distintas (negocio vs. etiqueta
                    física): columnas separadas. El filtro busca en ambos campos. */}
                <th className="px-3 py-2.5 text-left text-xs font-semibold text-muted-foreground whitespace-nowrap">
                  <ColFilterHeader label="Style" value={colFilters.sku} onChange={v => updateColFilter('sku', v)} placeholder="Style o SKU…" mono options={facets.styles.length ? facets.styles : filters.styles} />
                </th>
                <th className="px-3 py-2.5 text-left text-xs font-semibold text-muted-foreground whitespace-nowrap">SKU</th>
                <th className="px-3 py-2.5 text-left text-xs font-semibold text-muted-foreground whitespace-nowrap">
                  <ColFilterHeader label="Color" value={colFilters.color} onChange={v => updateColFilter('color', v)} placeholder="Color…" options={facets.colors} />
                </th>
                <th className="px-3 py-2.5 text-left text-xs font-semibold text-muted-foreground whitespace-nowrap">
                  <ColFilterHeader label="Talla" value={colFilters.size} onChange={v => updateColFilter('size', v)} placeholder="Talla…" options={facetSizes} />
                </th>
                <th className="px-3 py-2.5 text-left text-xs font-semibold text-muted-foreground whitespace-nowrap">
                  <ColFilterHeader label={t('description')} value={colFilters.description} onChange={v => updateColFilter('description', v)} placeholder="Descripción…" />
                </th>
                <th className="px-3 py-2.5 text-left text-xs font-semibold text-muted-foreground whitespace-nowrap">
                  <ColFilterHeader label={t('location')} value={colFilters.location} onChange={v => updateColFilter('location', v)} placeholder="Ubicación…" mono options={facets.locations} />
                </th>
                <th className="px-3 py-2.5 text-left text-xs font-semibold text-muted-foreground whitespace-nowrap">
                  <ColFilterHeader label={t('country_of_origin')} value={colFilters.country_of_origin} onChange={v => updateColFilter('country_of_origin', v)} placeholder="País…" mono options={facets.countries.length ? facets.countries : filters.countries} />
                </th>
                <th className="px-3 py-2.5 text-left text-xs font-semibold text-muted-foreground whitespace-nowrap">
                  <ColFilterHeader label="Fabric %" value={colFilters.fabric_content} onChange={v => updateColFilter('fabric_content', v)} placeholder="ej. 100% cotton" options={facets.fabrics.length ? facets.fabrics : filters.fabrics} />
                </th>
                <th className="px-3 py-2.5 text-right text-xs font-semibold text-muted-foreground whitespace-nowrap">{t('wms_boxes')}</th>
                <th className="px-3 py-2.5 text-right text-xs font-semibold text-muted-foreground whitespace-nowrap">{t('wms_on_hand')}</th>
                <th className="px-3 py-2.5 text-right text-xs font-semibold text-muted-foreground whitespace-nowrap">{t('wms_allocated')}</th>
                <th className="px-3 py-2.5 text-right text-xs font-semibold text-muted-foreground whitespace-nowrap">{t('wms_available')}</th>
                <th className="px-3 py-2.5 text-center text-xs font-semibold text-muted-foreground whitespace-nowrap">Historial</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border/10">
              {groupByCustomer ? (
                groupedInventory.map(([customer, items]) => (
                  <Fragment key={customer}>
                    <tr className="bg-muted/40 border-b border-border">
                      <td colSpan="14" className="px-3 py-2">
                        <span className="text-xs font-semibold">{customer}</span>
                        <span className="text-xs text-muted-foreground ml-2">({items.length} SKUs)</span>
                      </td>
                    </tr>
                    {items.map((inv, i) => (
                      <Fragment key={inv.inventory_id || i}>
                      <tr className="group border-b border-border/60 hover:bg-muted/40 transition-colors">
                        <td className="px-3 py-2.5 text-xs text-muted-foreground/60">{inv.customer}</td>
                        <td className="px-3 py-2.5 font-mono font-medium text-foreground text-xs">{inv.style || '-'}</td>
                        <td className="px-3 py-2.5 font-mono text-xs text-muted-foreground truncate max-w-[170px]" title={inv.sku}>{inv.sku || '-'}</td>
                        <td className="px-3 py-2.5 text-xs">{inv.color || '-'}</td>
                        <td className="px-3 py-2.5 text-xs">{inv.size || '-'}</td>
                        <td className="px-3 py-2.5 text-xs text-muted-foreground truncate max-w-[150px]" title={inv.description}>{inv.description}</td>
                        <td className="px-3 py-2.5 font-mono text-xs">{inv.inv_location || '-'}</td>
                        <td className="px-3 py-2.5 text-xs text-muted-foreground">{inv.country_of_origin || '-'}</td>
                        <td className="px-3 py-2.5 text-xs text-muted-foreground truncate max-w-[180px]" title={inv.fabric_content}>{inv.fabric_content || '-'}</td>
                        <td className="px-3 py-2.5 text-right font-mono">{renderCajasCell(inv)}</td>
                        <td className="px-3 py-2.5 text-right tabular-nums font-medium">{(inv.on_hand || 0).toLocaleString()}</td>
                        <td className="px-3 py-2.5 text-right tabular-nums text-muted-foreground">{(inv.allocated || 0).toLocaleString()}</td>
                        <td className="px-3 py-2.5 text-right tabular-nums font-semibold">
                          {(inv.available || 0).toLocaleString()}
                        </td>
                        <td className="px-3 py-2.5 text-center">
                          <button onClick={() => openHistory(inv)} className="p-1.5 rounded-lg text-muted-foreground hover:text-primary hover:bg-primary/10 transition-all" title="Ver historial">
                            <History className="w-3.5 h-3.5" />
                          </button>
                        </td>
                      </tr>
                      {renderBoxesSubRow(inv)}
                      </Fragment>
                    ))}
                  </Fragment>
                ))
              ) : (
                inventory.map((inv, i) => (
                  <Fragment key={inv.inventory_id || i}>
                  <tr className="group border-b border-border/60 hover:bg-muted/40 transition-colors">
                    <td className="px-3 py-2.5 text-xs text-muted-foreground">{inv.customer}</td>
                    <td className="px-3 py-2.5 font-mono font-medium text-foreground text-xs">{inv.style || '-'}</td>
                        <td className="px-3 py-2.5 font-mono text-xs text-muted-foreground truncate max-w-[170px]" title={inv.sku}>{inv.sku || '-'}</td>
                    <td className="px-3 py-2.5 text-xs">{inv.color || '-'}</td>
                    <td className="px-3 py-2.5 text-xs">{inv.size || '-'}</td>
                    <td className="px-3 py-2.5 text-xs text-muted-foreground truncate max-w-[150px]" title={inv.description}>{inv.description}</td>
                    <td className="px-3 py-2.5 font-mono text-xs">{inv.inv_location || '-'}</td>
                    <td className="px-3 py-2.5 text-xs text-muted-foreground">{inv.country_of_origin || '-'}</td>
                    <td className="px-3 py-2.5 text-xs text-muted-foreground truncate max-w-[180px]" title={inv.fabric_content}>{inv.fabric_content || '-'}</td>
                    <td className="px-3 py-2.5 text-right font-mono">{renderCajasCell(inv)}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums font-medium">{(inv.on_hand || 0).toLocaleString()}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums text-muted-foreground">{(inv.allocated || 0).toLocaleString()}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums font-semibold">
                      {(inv.available || 0).toLocaleString()}
                    </td>
                    <td className="px-3 py-2.5 text-center">
                      <button onClick={() => openHistory(inv)} className="p-1.5 rounded-lg text-muted-foreground hover:text-primary hover:bg-primary/10 transition-all" title="Ver historial">
                        <History className="w-3.5 h-3.5" />
                      </button>
                    </td>
                  </tr>
                  {renderBoxesSubRow(inv)}
                  </Fragment>
                ))
              )}
            </tbody>
          </table>
          {inventory.length === 0 && !loadingMore && (() => {
            if (!hasAnyFilter) {
              return (
                <div className="flex flex-col items-center justify-center py-20">
                  <p className="text-sm font-semibold text-foreground/80">Busca un producto para empezar</p>
                  <p className="text-sm text-muted-foreground mt-1 max-w-md text-center">
                    Escribe un Style o SKU para consultar el inventario.
                  </p>
                </div>
              );
            }
            return (
              <div className="flex flex-col items-center justify-center py-20">
                <p className="text-sm font-semibold text-foreground/80">{t('wms_no_inv')}</p>
                <p className="text-sm text-muted-foreground mt-1">{t('wms_import_hint')}</p>
              </div>
            );
          })()}
        </div>
      </div>
      <div className="flex items-center justify-end gap-3 mt-2">
        {loadingMore && totalRows > 0 && (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Loader2 className="w-3 h-3 animate-spin" />
            Cargando {inventory.length.toLocaleString()} / {totalRows.toLocaleString()}
            <div className="w-24 h-1 bg-muted rounded-full overflow-hidden">
              <div className="h-full bg-primary transition-all" style={{ width: `${totalRows > 0 ? (inventory.length / totalRows) * 100 : 0}%` }} />
            </div>
          </div>
        )}
        <div className="text-xs text-muted-foreground/70">
          {t('wms_showing_records', { count: inventory.length.toLocaleString() })}
        </div>
        {capped && (
          <div className="text-xs text-amber-600 dark:text-amber-400">
            Mostrando los primeros {MAX_GRID_ROWS.toLocaleString()} de {totalRows.toLocaleString()} — refina la búsqueda o usa Exportar para ver todo
          </div>
        )}
      </div>

      {/* Boxes (LPN) modal — opened from the "Cajas" cell in the inventory table */}
      {boxesFor && (
        <div className="fixed inset-0 z-[70] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm animate-in fade-in duration-150">
          <div className="bg-card border border-border rounded-lg w-full max-w-2xl max-h-[85vh] flex flex-col shadow-xl animate-in zoom-in-95 duration-150">
            <div className="flex items-center justify-between p-5 border-b border-border/20">
              <div className="min-w-0">
                <div className="text-xs font-medium text-muted-foreground">Cajas / LPNs</div>
                <div className="font-semibold text-foreground truncate">{boxesFor.label}</div>
                {boxesFor.location && (
                  <div className="text-xs font-mono text-muted-foreground flex items-center gap-1 mt-0.5">
                    <MapPin className="w-3 h-3" /> {boxesFor.location}
                  </div>
                )}
              </div>
              <button onClick={() => setBoxesFor(null)} className="p-2 hover:bg-secondary rounded-lg transition-all flex-shrink-0">
                <X className="w-5 h-5 text-muted-foreground" />
              </button>
            </div>
            <div className="flex-1 overflow-auto p-5">
              {boxesLoading ? (
                <div className="flex flex-col items-center justify-center py-16 gap-3">
                  <Loader2 className="w-8 h-8 animate-spin text-primary" />
                  <p className="text-sm text-muted-foreground">Cargando cajas…</p>
                </div>
              ) : boxesList.length === 0 ? (
                <div className="text-center py-12">
                  <p className="text-sm font-semibold text-foreground/80">Sin cajas registradas</p>
                </div>
              ) : (
                <>
                  <div className="text-xs font-medium text-muted-foreground mb-2">
                    {boxesList.length} {boxesList.length === 1 ? 'caja' : 'cajas'} · {boxesList.reduce((s, b) => s + (Number(b.units) || 0), 0).toLocaleString()} unidades
                  </div>
                  <table className="w-full text-sm">
                    <thead className="bg-muted/50 sticky top-0 border-b border-border">
                      <tr>
                        <th className="px-2 py-2 text-left text-xs font-semibold text-muted-foreground">LPN</th>
                        <th className="px-2 py-2 text-right text-xs font-semibold text-muted-foreground">Unidades</th>
                        <th className="px-2 py-2 text-left text-xs font-semibold text-muted-foreground">Ubicación</th>
                        <th className="px-2 py-2 text-left text-xs font-semibold text-muted-foreground">Estado</th>
                        <th className="px-2 py-2 text-left text-xs font-semibold text-muted-foreground">Transferido</th>
                        <th className="px-2 py-2 text-left text-xs font-semibold text-muted-foreground">Por</th>
                      </tr>
                    </thead>
                    <tbody>
                      {boxesList.map((b, i) => (
                        <tr key={b.box_id || i} className="border-b border-border/60 hover:bg-muted/40">
                          <td className="p-2 font-mono text-xs font-medium">{b.box_id || '—'}</td>
                          <td className="p-2 text-right tabular-nums font-semibold">{(b.units || b.qty || 0).toLocaleString()}</td>
                          <td className="p-2 font-mono text-xs">{b.location || '—'}</td>
                          <td className="p-2 text-xs text-muted-foreground">{b.state || b.status || '—'}</td>
                          <td className="p-2 text-xs text-muted-foreground whitespace-nowrap">{b.last_transferred_at ? new Date(b.last_transferred_at).toLocaleString() : '—'}</td>
                          <td className="p-2 text-xs text-muted-foreground">{b.last_transferred_by || '—'}</td>
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
          <div className="bg-card border border-border rounded-lg w-full max-w-4xl max-h-[85vh] flex flex-col shadow-xl animate-in zoom-in-95 duration-150">
            <div className="flex items-center justify-between p-5 border-b border-border/20">
              <div className="min-w-0">
                <h3 className="font-semibold text-sm truncate">Historial de movimientos</h3>
                <p className="text-xs text-muted-foreground truncate">
                  <span className="font-mono">{historyFor.style}</span>
                  {historyFor.color && <> · {historyFor.color}</>}
                  {historyFor.size && <> · {historyFor.size}</>}
                  {historyData && <> · {historyData.count} movimientos</>}
                </p>
              </div>
              <button onClick={() => setHistoryFor(null)} className="p-2 hover:bg-secondary rounded-lg transition-all flex-shrink-0">
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="flex-1 overflow-auto custom-scrollbar">
              {historyLoading ? (
                <div className="flex items-center justify-center py-20">
                  <Loader2 className="w-8 h-8 animate-spin text-muted-foreground" />
                </div>
              ) : !historyData?.movements?.length ? (
                <div className="text-center py-20 text-sm text-muted-foreground">
                  Sin movimientos registrados para este SKU
                </div>
              ) : (
                <table className="w-full text-sm">
                  <thead className="bg-muted/50 sticky top-0 border-b border-border">
                    <tr>
                      <th className="px-3 py-2.5 text-left text-xs font-semibold text-muted-foreground whitespace-nowrap">Fecha</th>
                      <th className="px-3 py-2.5 text-left text-xs font-semibold text-muted-foreground whitespace-nowrap">Tipo</th>
                      <th className="px-3 py-2.5 text-left text-xs font-semibold text-muted-foreground whitespace-nowrap">Detalles</th>
                      <th className="px-3 py-2.5 text-left text-xs font-semibold text-muted-foreground whitespace-nowrap">Ubicación</th>
                      <th className="px-3 py-2.5 text-right text-xs font-semibold text-muted-foreground whitespace-nowrap">Cantidad</th>
                      <th className="px-3 py-2.5 text-left text-xs font-semibold text-muted-foreground whitespace-nowrap">Usuario</th>
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
                            <span className="text-xs font-medium bg-muted px-2 py-0.5 rounded-md text-foreground/80 whitespace-nowrap">
                              {m.type?.replace(/_/g, ' ')}
                            </span>
                          </td>
                          <td className="p-3 text-[11px] text-foreground/80 font-mono truncate max-w-[200px]">
                            {d.box_id || d.ticket_id || d.receiving_id || d.count_id || d.order_number || '—'}
                          </td>
                          <td className="p-3 text-xs font-mono">
                            {d.to || d.location || d.inv_location || '—'}
                          </td>
                          <td className={`p-3 text-right font-semibold tabular-nums ${sign === '-' ? 'text-red-600 dark:text-red-400' : sign === '+' ? 'text-emerald-600 dark:text-emerald-400' : 'text-foreground'}`}>
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
          <div className={`bg-card border rounded-3xl w-full max-w-2xl max-h-[90vh] flex flex-col shadow-2xl animate-in zoom-in-95 duration-150 ${manualOp === 'remove' ? 'border-rose-500/40' : 'border-emerald-500/40'}`}>
            <div className="flex items-center justify-between p-5 border-b border-border/20">
              <div className="flex items-center gap-3 min-w-0">
                <div className={`w-10 h-10 rounded-2xl flex items-center justify-center flex-shrink-0 ${manualOp === 'remove' ? 'bg-rose-500/10' : 'bg-emerald-500/10'}`}>
                  {manualOp === 'remove'
                    ? <Minus className="w-5 h-5 text-rose-400" />
                    : <Plus className="w-5 h-5 text-emerald-400" />}
                </div>
                <div className="min-w-0">
                  <h3 className="font-black uppercase tracking-tighter text-sm truncate">
                    {manualOp === 'remove' ? 'Sacar inventario manual' : 'Agregar inventario manual'}
                  </h3>
                  <p className="text-[11px] text-muted-foreground font-bold truncate">
                    {manualOp === 'remove'
                      ? 'Resta de una línea existente (SKU+color+talla+ubicación).'
                      : 'Si la combinación SKU+color+talla+ubicación ya existe, se acumula.'}
                  </p>
                </div>
              </div>
              <button onClick={() => !savingManual && setShowAddManual(false)} className="p-2 hover:bg-secondary rounded-lg transition-all flex-shrink-0" disabled={savingManual}>
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="flex-1 overflow-auto custom-scrollbar p-5 space-y-3">
              {/* Tabs: Entrada · Salida · Crear estilo */}
              <div className="grid grid-cols-3 gap-2 p-1 bg-secondary/40 rounded-xl border border-border/40">
                <button
                  type="button"
                  onClick={() => { setManualOp('add'); setMultiMode(false); }}
                  disabled={savingManual}
                  data-testid="manual-op-add"
                  className={`flex items-center justify-center gap-1.5 py-2.5 rounded-lg text-[11px] font-black uppercase tracking-widest transition-all ${manualOp === 'add' && !multiMode ? 'bg-emerald-500 text-white shadow-md' : 'text-muted-foreground hover:text-foreground hover:bg-background/60'}`}
                >
                  <Plus className="w-3.5 h-3.5" /> Entrada
                </button>
                <button
                  type="button"
                  onClick={() => { setManualOp('remove'); setMultiMode(false); }}
                  disabled={savingManual}
                  data-testid="manual-op-remove"
                  className={`flex items-center justify-center gap-1.5 py-2.5 rounded-lg text-[11px] font-black uppercase tracking-widest transition-all ${manualOp === 'remove' ? 'bg-rose-500 text-white shadow-md' : 'text-muted-foreground hover:text-foreground hover:bg-background/60'}`}
                >
                  <Minus className="w-3.5 h-3.5" /> Salida
                </button>
                <button
                  type="button"
                  onClick={() => { setManualOp('add'); setMultiMode(true); }}
                  disabled={savingManual}
                  data-testid="manual-multi-toggle"
                  className={`flex items-center justify-center gap-1.5 py-2.5 rounded-lg text-[11px] font-black uppercase tracking-widest transition-all ${manualOp === 'add' && multiMode ? 'bg-emerald-500 text-white shadow-md' : 'text-muted-foreground hover:text-foreground hover:bg-background/60'}`}
                >
                  <Tag className="w-3.5 h-3.5" /> Crear estilo
                </button>
              </div>

              {multiMode && manualOp === 'add' && (
                <p className="text-[11px] text-muted-foreground bg-emerald-500/5 border border-emerald-500/20 rounded-lg px-3 py-2 leading-relaxed">
                  Captura los <b className="text-foreground">datos del estilo</b> una vez y agrega cada talla/color como un <b className="text-foreground">item</b> abajo. Al guardar se crean todos juntos.
                </p>
              )}

              <div>
                <label className="text-[10px] font-black uppercase tracking-widest text-muted-foreground block mb-1">
                  {manualOp === 'remove' ? 'Motivo de la salida *' : 'Motivo de la entrada *'}
                </label>
                <select
                  value={manualForm.reason}
                  onChange={e => setManualForm(f => ({ ...f, reason: e.target.value }))}
                  data-testid="manual-reason"
                  className="w-full px-3 py-2 bg-background border border-border rounded text-sm text-foreground"
                >
                  <option value="">Selecciona un motivo…</option>
                  {(manualOp === 'remove' ? REMOVE_REASONS : ADD_REASONS).map(r => <option key={r} value={r}>{r}</option>)}
                </select>
              </div>
              {multiMode && manualOp === 'add' && (
                <span className="text-xs font-black uppercase tracking-widest text-foreground block border-t border-border/30 pt-3">Datos del estilo</span>
              )}
              <div className="grid grid-cols-2 gap-3">
                <div className="col-span-2">
                  <label className="text-[10px] font-black uppercase tracking-widest text-muted-foreground block mb-1">
                    {multiMode ? 'Número de estilo / SKU *' : 'Style / SKU *'}
                  </label>
                  <Typeahead
                    value={manualForm.style}
                    onChange={onStyleChange}
                    options={filters.styles || EMPTY}
                    placeholder="Escribe el número de estilo… ej: 1001"
                    testid="manual-style"
                  />
                </div>
                {!multiMode && (<>
                <div>
                  <label className="text-[10px] font-black uppercase tracking-widest text-muted-foreground block mb-1">Color *</label>
                  <Typeahead
                    value={manualForm.color}
                    onChange={onColorChange}
                    options={styleInfo?.colors || EMPTY}
                    placeholder={loadingStyleInfo ? 'Cargando…' : (manualForm.style ? 'Escribe o elige… ej: BLACK' : 'Elige o escribe style')}
                    disabled={!manualForm.style || loadingStyleInfo}
                    testid="manual-color"
                  />
                </div>
                <div>
                  <label className="text-[10px] font-black uppercase tracking-widest text-muted-foreground block mb-1">Talla *</label>
                  <Typeahead
                    value={manualForm.size}
                    onChange={onSizeChange}
                    options={sizeOptions}
                    placeholder={manualForm.color ? 'Escribe o elige… ej: M' : 'Elige o escribe color'}
                    disabled={!manualForm.color}
                    testid="manual-size"
                  />
                </div>
                </>)}
                {!multiMode && (<>
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
                    options={locationOptions}
                    placeholder="Escribe o elige… ej: B15"
                    testid="manual-location"
                  />
                </div>
                </>)}
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
                  <label className="text-[10px] font-black uppercase tracking-widest text-muted-foreground block mb-1">Contenido de tela (%)</label>
                  <Typeahead
                    value={manualForm.fabric_content}
                    onChange={onFabricChange}
                    options={filters.fabrics || EMPTY}
                    placeholder="Escribe… ej: 100% COTTON"
                    testid="manual-fabric"
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
                {!multiMode && (<>
                {manualOp === 'add' ? (
                  <div>
                    <label className="text-[10px] font-black uppercase tracking-widest text-muted-foreground block mb-1">Número de caja (LPN) *</label>
                    <input
                      type="text"
                      value={manualForm.box_id}
                      onChange={e => setManualForm(f => ({ ...f, box_id: e.target.value.toUpperCase() }))}
                      placeholder="Escanea o teclea el número"
                      className="w-full px-3 py-2 bg-background border border-border rounded-lg text-sm font-mono tabular-nums uppercase"
                      data-testid="manual-box-id"
                    />
                    <p className="text-[10px] text-muted-foreground mt-1">Una caja por ajuste. Queda enlazada y rastreable por este número.</p>
                  </div>
                ) : (
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
                )}
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
                </>)}
              </div>

              {/* Items del nuevo estilo (color/talla/ubicación/cantidad por renglón) */}
              {multiMode && manualOp === 'add' && (
                <div className="space-y-2.5">
                  <div className="flex items-center justify-between border-t border-border/30 pt-3">
                    <div>
                      <span className="text-xs font-black uppercase tracking-widest text-foreground">Items del estilo</span>
                      <p className="text-[11px] text-muted-foreground">Agrega un renglón por cada talla / color.</p>
                    </div>
                    <button
                      type="button" onClick={addStyleItem} disabled={savingManual}
                      className="text-[11px] font-black uppercase tracking-widest text-emerald-600 hover:text-emerald-500 flex items-center gap-1 bg-emerald-500/10 border border-emerald-500/30 rounded-lg px-2.5 py-1.5 disabled:opacity-50"
                      data-testid="manual-add-item"
                    >
                      <Plus className="w-3.5 h-3.5" /> Agregar item
                    </button>
                  </div>

                  {styleItems.map((it, i) => {
                    const itLocOptions = it.zone && (locationsByZone[it.zone] || []).length ? locationsByZone[it.zone] : allLocations;
                    const lbl = "text-[9px] font-black uppercase tracking-widest text-muted-foreground block mb-0.5";
                    return (
                      <div key={i} className="border border-border/50 rounded-xl p-3 bg-secondary/20 space-y-2.5">
                        <div className="flex items-center justify-between">
                          <span className="text-[11px] font-black uppercase tracking-widest text-emerald-600 flex items-center gap-1.5">
                            <span className="w-5 h-5 rounded-full bg-emerald-500 text-white flex items-center justify-center text-[10px]">{i + 1}</span>
                            Item {i + 1}
                          </span>
                          {styleItems.length > 1 && (
                            <button type="button" onClick={() => removeStyleItem(i)} disabled={savingManual}
                              className="text-[10px] font-bold uppercase tracking-widest text-rose-500 hover:text-rose-400 flex items-center gap-1 disabled:opacity-50"
                              title="Quitar item">
                              <X className="w-3.5 h-3.5" /> Quitar
                            </button>
                          )}
                        </div>
                        <div className="grid grid-cols-2 gap-2.5">
                          <div>
                            <label className={lbl}>Color *</label>
                            <Typeahead value={it.color} onChange={v => updateStyleItem(i, { color: v })} options={styleInfo?.colors || EMPTY} placeholder="Escribe o elige" testid={`item-color-${i}`} />
                          </div>
                          <div>
                            <label className={lbl}>Talla *</label>
                            <Typeahead value={it.size} onChange={v => updateStyleItem(i, { size: v })} options={sizeOptions} placeholder="Escribe o elige" testid={`item-size-${i}`} />
                          </div>
                          <div>
                            <label className={lbl}>Zona</label>
                            <Typeahead value={it.zone} onChange={v => updateStyleItem(i, { zone: v, location: '' })} options={zoneOptions} placeholder="Opcional" testid={`item-zone-${i}`} />
                          </div>
                          <div>
                            <label className={lbl}>Ubicación *</label>
                            <Typeahead value={it.location} onChange={v => updateStyleItem(i, { location: v, zone: locZoneMap[v] || it.zone })} options={itLocOptions} placeholder="Escribe o elige" testid={`item-loc-${i}`} />
                          </div>
                          <div>
                            <label className={lbl}>Cajas</label>
                            <input type="number" min="0" value={it.total_boxes} onChange={e => updateStyleItem(i, { total_boxes: e.target.value })} className="w-full px-3 py-2 bg-background border border-border rounded-lg text-sm font-mono tabular-nums" />
                          </div>
                          <div>
                            <label className={lbl}>Unidades *</label>
                            <input type="number" min="1" value={it.total_units} onChange={e => updateStyleItem(i, { total_units: e.target.value })} className="w-full px-3 py-2 bg-background border border-border rounded-lg text-sm font-mono tabular-nums font-bold" />
                          </div>
                        </div>
                      </div>
                    );
                  })}

                  {savingManual && (
                    <div>
                      <div className="flex justify-between text-[11px] font-bold text-muted-foreground mb-1">
                        <span>Creando items…</span>
                        <span className="font-mono">{multiDone} / {styleItems.filter(it => it.color && it.size && it.location && (Number(it.total_units) || 0) > 0).length}</span>
                      </div>
                      <div className="w-full h-2.5 bg-secondary rounded-full overflow-hidden">
                        <div className="h-full bg-emerald-500 transition-all duration-150"
                          style={{ width: `${(() => { const n = styleItems.filter(it => it.color && it.size && it.location && (Number(it.total_units) || 0) > 0).length || 1; return Math.round((multiDone / n) * 100); })()}%` }} />
                      </div>
                    </div>
                  )}
                </div>
              )}
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
                onClick={multiMode && manualOp === 'add' ? submitMultiAdd : submitManualAdd}
                disabled={savingManual}
                className={`px-5 py-2 text-white rounded-xl font-bold uppercase tracking-wider text-xs flex items-center gap-2 transition-all disabled:opacity-50 ${manualOp === 'remove' ? 'bg-rose-500 hover:bg-rose-600' : 'bg-emerald-500 hover:bg-emerald-600'}`}
                data-testid="manual-submit-btn"
              >
                {savingManual ? <Loader2 className="w-4 h-4 animate-spin" /> : (manualOp === 'remove' ? <Minus className="w-4 h-4" /> : <Plus className="w-4 h-4" />)}
                {manualOp === 'remove' ? 'Sacar' : (multiMode ? 'Crear estilo' : 'Guardar')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
