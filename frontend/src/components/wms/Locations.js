import { useState, useEffect, useCallback, useRef } from "react";
import { toast } from "sonner";
import { Printer, Plus, X, MapPin, Loader2, Edit3, Trash2, Search, ArrowRightLeft, Package, Tag, Globe, Layers, Box, User, FileText, Hash } from "lucide-react";
import { useLang } from "../../contexts/LanguageContext";
import { API, fetcher, poster, logLoadError } from "./lib";

export const LocationsModule = () => {
  const { t } = useLang();
  const [locations, setLocations] = useState([]);
  const [editingId, setEditingId] = useState(null);
  const [loading, setLoading] = useState(false);
  const [showNewLoc, setShowNewLoc] = useState(false);
  const [search, setSearch] = useState('');
  const [newLoc, setNewLoc] = useState({ name: '', zone: '', type: 'rack' });
  const [activeTab, setActiveTab] = useState('custom'); // 'custom' or 'system'
  // Bulk-move state: { from: locObj, to: '' } when modal is open
  const [moveBulk, setMoveBulk] = useState(null);
  const [movingBulk, setMovingBulk] = useState(false);
  // Progressive rendering: with thousands of system locations, painting every
  // card up front lags the browser. Show this many zones at a time and let the
  // user request more. Reset when the search/tab changes.
  const ZONES_PER_PAGE = 8;
  const [visibleZones, setVisibleZones] = useState(ZONES_PER_PAGE);
  useEffect(() => { setVisibleZones(ZONES_PER_PAGE); }, [search, activeTab]);

  // Click-to-inspect: shows every SKU + box info inside the selected location.
  const [detailLoc, setDetailLoc] = useState(null);
  const [detailItems, setDetailItems] = useState([]);
  const [detailLoading, setDetailLoading] = useState(false);
  // Per-item LPN expansion inside the detail modal. Keys are inventory_id;
  // values are { loading: bool, boxes: [] }. Lazy-fetched on toggle.
  const [boxesByInv, setBoxesByInv] = useState({});

  // Inline per-LPN relocate inside the detail modal. While a box is being
  // relocated we replace its row with a small destination input + confirm.
  const [relocatingBoxId, setRelocatingBoxId] = useState(null);
  const [relocateDst, setRelocateDst] = useState('');
  const [relocateSaving, setRelocateSaving] = useState(false);
  // Active locations cached for the relocate typeahead (lazy-loaded when the
  // modal opens — `summary=false` skips the expensive inventory aggregation).
  const [activeLocations, setActiveLocations] = useState([]);
  const [activeLocLoaded, setActiveLocLoaded] = useState(false);
  const [showLocDrop, setShowLocDrop] = useState(false);

  // LPN finder — direct lookup by box_id from the top of the module. Resolves
  // to the box's current location, opens its detail modal, auto-expands the
  // inventory item that owns the box and highlights the row.
  const [lpnSearch, setLpnSearch] = useState('');
  const [lpnSearching, setLpnSearching] = useState(false);
  const [foundBox, setFoundBox] = useState(null); // full box doc from the lookup
  const [highlightBoxId, setHighlightBoxId] = useState(null);

  // Top-level list loader — declared up here because confirmRelocate (below)
  // references it in a useCallback dep array and `const` has TDZ semantics:
  // accessing it before initialization throws at first render.
  const load = useCallback(() => {
    setLoading(true);
    fetcher('/locations')
      .then(setLocations)
      .finally(() => setLoading(false));
  }, []);

  const openDetail = useCallback(async (loc) => {
    setDetailLoc(loc);
    setDetailItems([]);
    setBoxesByInv({});
    setRelocatingBoxId(null);
    setRelocateDst('');
    setDetailLoading(true);
    // Kick off the active-locations fetch in parallel — needed by the
    // relocate typeahead. Won't block the detail load.
    if (!activeLocLoaded) {
      fetcher('/locations?summary=false&limit=5000')
        .then(rows => {
          const filtered = (Array.isArray(rows) ? rows : []).filter(l => l.active !== false);
          setActiveLocations(filtered);
          setActiveLocLoaded(true);
        })
        .catch(logLoadError('active locations for relocate'));
    }
    try {
      // Fetch inventory rows AND every box in this location in parallel so the
      // LPNs are immediately visible — no extra clicks required to see "which
      // boxes are these". For locations with hundreds of boxes the response
      // is still cheap (single mongo find).
      const [invData, boxData] = await Promise.all([
        fetcher(`/inventory?location=${encodeURIComponent(loc.name)}&limit=500`),
        fetcher(`/boxes?location=${encodeURIComponent(loc.name)}`).catch(err => {
          logLoadError('location boxes preload')(err);
          return [];
        }),
      ]);
      const items = Array.isArray(invData) ? invData : (invData.items || []);
      setDetailItems(items);

      // Bucket boxes by composite SKU key (sku + color + size). Many receiving
      // flows write boxes without an inventory_id link, so we can't rely on
      // that field alone — the SKU triple is the only thing that's reliably
      // populated on both sides.
      const skuKey = (o) => `${(o.sku || o.style || '').toUpperCase()}|${(o.color || '').toUpperCase()}|${(o.size || '').toUpperCase()}`;
      const grouped = {};
      (Array.isArray(boxData) ? boxData : []).forEach(b => {
        const key = skuKey(b);
        if (!grouped[key]) grouped[key] = [];
        grouped[key].push(b);
      });
      // Seed boxesByInv keyed by each inventory item's inventory_id so the
      // existing per-card drawer renderer keeps working unchanged.
      const seeded = {};
      items.forEach(it => {
        if (!it.inventory_id) return;
        const matching = grouped[skuKey(it)];
        if (matching && matching.length) {
          seeded[it.inventory_id] = { loading: false, boxes: matching };
        }
      });
      setBoxesByInv(seeded);
    } catch (err) {
      logLoadError('location detail')(err);
      toast.error('No se pudo cargar el detalle de la ubicación');
    } finally { setDetailLoading(false); }
  }, [activeLocLoaded]);

  const findBox = useCallback(async () => {
    const lpn = (lpnSearch || '').trim().toUpperCase();
    if (!lpn) { toast.error('Escribe un LPN para buscar'); return; }
    setLpnSearching(true);
    setFoundBox(null);
    setHighlightBoxId(null);
    try {
      // Direct lookup. The backend already 404s if the box doesn't exist.
      const res = await fetch(`${API}/boxes/${encodeURIComponent(lpn)}`, { credentials: 'include' });
      if (res.status === 404) { toast.error(`Caja '${lpn}' no encontrada`); return; }
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        toast.error(err.detail || `Error ${res.status}`);
        return;
      }
      const box = await res.json();
      if (!box || !box.box_id) { toast.error(`Caja '${lpn}' no encontrada`); return; }

      const boxLoc = (box.location || '').toUpperCase();
      if (!boxLoc) {
        toast.error(`La caja ${box.box_id} no tiene ubicación asignada`);
        return;
      }
      // Find the location object in our local list so openDetail can render
      // the header + load its items. If absent (e.g. paginated out), build a
      // stub — openDetail only reads loc.name.
      const loc = locations.find(l => (l.name || '').toUpperCase() === boxLoc) || { name: box.location };
      setFoundBox(box);
      setHighlightBoxId(box.box_id);
      await openDetail(loc);
      toast.success(`Caja ${box.box_id} en ${box.location}`);
    } catch (err) {
      logLoadError('lookup box')(err);
      toast.error('Error al buscar la caja');
    } finally { setLpnSearching(false); }
  }, [lpnSearch, locations, openDetail]);

  const startRelocate = useCallback((boxId) => {
    setRelocatingBoxId(boxId);
    setRelocateDst('');
    setShowLocDrop(false);
  }, []);

  const cancelRelocate = useCallback(() => {
    setRelocatingBoxId(null);
    setRelocateDst('');
    setShowLocDrop(false);
  }, []);

  const confirmRelocate = useCallback(async (box, inventoryId) => {
    const dst = (relocateDst || '').trim().toUpperCase();
    if (!dst) { toast.error('Escribe la ubicación destino'); return; }
    if (!detailLoc) return;
    if (dst === (detailLoc.name || '').toUpperCase()) { toast.error('Destino igual al origen'); return; }
    const exists = activeLocations.some(l => (l.name || '').toUpperCase() === dst);
    if (!exists) { toast.error(`'${dst}' no existe en las ubicaciones activas`); return; }
    setRelocateSaving(true);
    try {
      const res = await poster('/boxes/relocate', { box_ids: [box.box_id], to: dst });
      if (res.ok) {
        const data = await res.json();
        toast.success(data.message || 'Caja movida');
        // Drop the moved LPN from the open drawer so the UI matches reality.
        setBoxesByInv(prev => {
          const node = prev[inventoryId];
          if (!node) return prev;
          return {
            ...prev,
            [inventoryId]: {
              ...node,
              boxes: node.boxes.filter(b => b.box_id !== box.box_id),
            },
          };
        });
        setRelocatingBoxId(null);
        setRelocateDst('');
        // Refresh the location list in the background so totals update.
        load();
      } else {
        const err = await res.json().catch(() => ({}));
        toast.error(err.detail || 'Error al mover la caja');
      }
    } catch (err) {
      logLoadError('relocate box')(err);
      toast.error('Error de conexión');
    } finally { setRelocateSaving(false); }
  }, [relocateDst, detailLoc, activeLocations, load]);

  const toggleBoxes = useCallback(async (it) => {
    const id = it.inventory_id;
    if (!id) {
      toast.error('Este renglón no tiene inventory_id — no se pueden listar cajas');
      return;
    }
    const existing = boxesByInv[id];
    if (existing) {
      // Toggle: if already shown, hide.
      setBoxesByInv(prev => {
        const next = { ...prev };
        delete next[id];
        return next;
      });
      return;
    }
    setBoxesByInv(prev => ({ ...prev, [id]: { loading: true, boxes: [] } }));
    try {
      // Two-step lookup so we work for boxes that DO have inventory_id linked
      // (e.g. restored from snapshot) AND for boxes that don't (Receiving flow):
      // 1. Try the explicit inventory_id link first — fast and exact.
      // 2. If empty, fall back to filtering by location + SKU triple, which is
      //    what every box reliably carries.
      let data = await fetcher(`/boxes?inventory_id=${encodeURIComponent(id)}`);
      if (!Array.isArray(data) || data.length === 0) {
        const loc = detailLoc?.name || it.inv_location || it.location || '';
        const params = new URLSearchParams({ location: loc });
        if (it.sku || it.style) params.set('sku', it.sku || it.style);
        if (it.color) params.set('color', it.color);
        if (it.size) params.set('size', it.size);
        data = await fetcher(`/boxes?${params.toString()}`);
      }
      setBoxesByInv(prev => ({ ...prev, [id]: { loading: false, boxes: Array.isArray(data) ? data : [] } }));
    } catch (err) {
      logLoadError('boxes by inventory')(err);
      toast.error('Error al cargar las cajas');
      setBoxesByInv(prev => {
        const next = { ...prev };
        delete next[id];
        return next;
      });
    }
  }, [boxesByInv, detailLoc]);

  useEffect(() => { load(); }, [load]);

  // After a LPN lookup, once the location's detail items have loaded, expand
  // the boxes drawer of the item that owns the found box. Ref-guarded so we
  // never trigger the expand twice for the same lookup.
  const expandedForBoxRef = useRef(null);
  useEffect(() => {
    if (!foundBox || !detailLoc || detailItems.length === 0) return;
    if (expandedForBoxRef.current === foundBox.box_id) return;
    const target = detailItems.find(it => it.inventory_id === foundBox.inventory_id);
    if (!target) {
      // Inventory record might not be loaded (different aggregation key); just
      // clear the guard so a subsequent lookup can try again.
      return;
    }
    if (!boxesByInv[target.inventory_id]) {
      expandedForBoxRef.current = foundBox.box_id;
      toggleBoxes(target);
    }
  }, [foundBox, detailLoc, detailItems, boxesByInv, toggleBoxes]);

  const handleCreateLoc = async () => {
    const name = newLoc.name.trim().toUpperCase();
    if (!name) { toast.error(t('wms_name_req') || 'Nombre requerido'); return; }

    // Client-side check for immediate feedback
    if (locations.some(l => l.name.toUpperCase() === name)) {
      toast.error(`La ubicación '${name}' ya existe`);
      return;
    }

    setLoading(true);
    try {
      const res = await poster('/locations', { ...newLoc, name });
      if (res.ok) {
        toast.success(t('wms_loc_created') || 'Ubicación creada');
        setNewLoc({ name: '', zone: '', type: 'rack' });
        setShowNewLoc(false);
        load();
      } else {
        const err = await res.json().catch(() => ({}));
        toast.error(err.detail || 'Error al crear ubicación');
      }
    } catch {
      toast.error(t('error_connection'));
    } finally {
      setLoading(false);
    }
  };

  const handleDelete = async (id, name) => {
    if (!window.confirm(`¿Estás seguro de eliminar la ubicación '${name}'?`)) return;
    setLoading(true);
    try {
      const res = await fetch(`${API}/locations/${id}`, { method: 'DELETE', credentials: 'include' });
      if (res.ok) {
        toast.success('Ubicación eliminada');
        load();
      } else {
        const err = await res.json().catch(() => ({}));
        toast.error(err.detail || 'Error al eliminar');
      }
    } catch {
      toast.error(t('error_connection'));
    } finally {
      setLoading(false);
    }
  };

  const [editingLoc, setEditingLoc] = useState(null);

  const handleUpdateLoc = async () => {
    const name = editingLoc.name.trim().toUpperCase();
    if (!name) { toast.error(t('wms_name_req') || 'Nombre requerido'); return; }

    if (locations.some(l => l.name.toUpperCase() === name && l.location_id !== editingLoc.location_id)) {
      toast.error(`La ubicación '${name}' ya existe`);
      return;
    }

    setLoading(true);
    try {
      const res = await fetch(`${API}/locations/${editingLoc.location_id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, zone: editingLoc.zone.toUpperCase() }),
        credentials: 'include'
      });
      if (res.ok) {
        toast.success('Ubicación actualizada');
        setEditingLoc(null);
        load();
      } else {
        const err = await res.json().catch(() => ({}));
        toast.error(err.detail || 'Error al actualizar');
      }
    } catch {
      toast.error(t('error_connection'));
    } finally {
      setLoading(false);
    }
  };

  const handleBulkMove = async () => {
    if (!moveBulk || !moveBulk.to?.trim()) { toast.error('Selecciona ubicación destino'); return; }
    const dst = moveBulk.to.trim().toUpperCase();
    const src = moveBulk.from.name;
    if (dst === src.toUpperCase()) { toast.error('La ubicación destino debe ser distinta'); return; }
    setMovingBulk(true);
    try {
      const res = await poster('/move-location', { from: src, to: dst });
      if (res.ok) {
        const data = await res.json();
        toast.success(data.message || 'Stock movido');
        setMoveBulk(null);
        load();
      } else {
        const err = await res.json().catch(() => ({}));
        toast.error(err.detail || 'Error al mover');
      }
    } catch (err) {
      logLoadError('bulk move')(err);
      toast.error('Error de conexión');
    } finally { setMovingBulk(false); }
  };

  const filtered = locations.filter(l => {
    const summary = l.inventory_summary || { total_units: 0, skus_count: 0, items: [] };
    const matchesSearch = l.name.toLowerCase().includes(search.toLowerCase()) ||
                         (l.zone || '').toLowerCase().includes(search.toLowerCase()) ||
                         summary.items.some(item => item.style.toLowerCase().includes(search.toLowerCase()));
    const matchesTab = activeTab === 'custom' ? l.is_custom === true : l.is_custom !== true;
    return matchesSearch && matchesTab;
  });

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-black uppercase tracking-tighter">Gestión de Ubicaciones</h2>
          <p className="text-xs text-muted-foreground font-bold uppercase tracking-widest opacity-60">Mapa lógico del almacén</p>
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => window.open(`${API}/locations/print?ids=all`, '_blank')}
            className="flex items-center gap-2 px-6 py-3 bg-emerald-500 text-white rounded-2xl font-black uppercase tracking-widest text-xs hover:scale-105 transition-all shadow-lg shadow-emerald-500/20"
          >
            <Printer className="w-4 h-4" />
            Imprimir Etiquetas
          </button>
          <button
            onClick={() => setShowNewLoc(!showNewLoc)}
            className="flex items-center gap-2 px-6 py-3 bg-primary text-black rounded-2xl font-black uppercase tracking-widest text-xs hover:scale-105 transition-all shadow-lg"
          >
            {showNewLoc ? <X className="w-4 h-4" /> : <Plus className="w-4 h-4" />}
            {showNewLoc ? t('cancel') : 'Nueva Ubicación'}
          </button>
        </div>
      </div>

      {/* Tabs de Separación */}
      <div className="flex gap-2 p-1 bg-secondary/20 rounded-2xl w-fit border border-border/40">
        <button
          onClick={() => setActiveTab('custom')}
          className={`px-6 py-2 rounded-xl text-xs font-black uppercase tracking-widest transition-all ${activeTab === 'custom' ? 'bg-primary text-black shadow-lg shadow-primary/20' : 'text-muted-foreground hover:text-foreground hover:bg-secondary/40'}`}
        >
          Mis Locaciones
          <span className="ml-2 px-1.5 py-0.5 bg-black/10 rounded-md text-[9px]">{locations.filter(l => l.is_custom).length}</span>
        </button>
        <button
          onClick={() => setActiveTab('system')}
          className={`px-6 py-2 rounded-xl text-xs font-black uppercase tracking-widest transition-all ${activeTab === 'system' ? 'bg-indigo-500 text-white shadow-lg shadow-indigo-500/20' : 'text-muted-foreground hover:text-foreground hover:bg-secondary/40'}`}
        >
          Sistema / Inventario
          <span className="ml-2 px-1.5 py-0.5 bg-white/10 rounded-md text-[9px]">{locations.filter(l => !l.is_custom).length}</span>
        </button>
      </div>

      {showNewLoc && (
        <div className="p-6 bg-card/60 backdrop-blur-xl border border-primary/30 rounded-[2.5rem] shadow-2xl animate-in fade-in zoom-in duration-300">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
            <div className="space-y-2">
              <label className="text-[10px] font-black uppercase tracking-widest text-muted-foreground ml-2">Nombre de Locación</label>
              <div className="relative">
                <MapPin className="absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5 text-primary" />
                <input
                  placeholder="Ej: A-01-01"
                  value={newLoc.name}
                  onChange={e => setNewLoc(p => ({ ...p, name: e.target.value.toUpperCase() }))}
                  className="w-full pl-12 pr-4 py-4 bg-background border border-border rounded-2xl text-lg font-black font-mono focus:ring-4 focus:ring-primary/10 transition-all"
                />
              </div>
              {locations.some(l => l.name.toUpperCase() === newLoc.name.trim().toUpperCase()) && (
                <p className="text-[10px] font-bold text-red-400 mt-1 ml-2 uppercase animate-pulse">Esta ubicación ya existe</p>
              )}
            </div>
            <div className="space-y-2">
              <label className="text-[10px] font-black uppercase tracking-widest text-muted-foreground ml-2">Zona / Pasillo</label>
              <input
                placeholder="Ej: ZONA A"
                value={newLoc.zone}
                onChange={e => setNewLoc(p => ({ ...p, zone: e.target.value.toUpperCase() }))}
                className="w-full px-4 py-4 bg-background border border-border rounded-2xl text-lg font-black focus:ring-4 focus:ring-primary/10 transition-all"
              />
            </div>
            <div className="flex items-end pb-1">
              <button
                onClick={handleCreateLoc}
                disabled={loading || !newLoc.name || locations.some(l => l.name.toUpperCase() === newLoc.name.trim().toUpperCase())}
                className="w-full py-4 bg-primary text-black rounded-2xl font-black uppercase tracking-widest text-sm shadow-xl shadow-primary/20 hover:scale-[1.02] active:scale-95 transition-all disabled:opacity-30"
              >
                {loading ? <Loader2 className="w-5 h-5 animate-spin mx-auto" /> : 'Confirmar Creación'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* LPN finder — quick lookup that jumps directly to the box's location */}
      <div className="relative group">
        <Box className="absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5 text-amber-500 group-focus-within:text-amber-400 transition-colors" />
        <input
          placeholder="Buscar por número de caja (LPN)…"
          value={lpnSearch}
          onChange={e => setLpnSearch(e.target.value.toUpperCase())}
          onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); findBox(); } }}
          disabled={lpnSearching}
          className="w-full pl-12 pr-32 py-3 bg-amber-500/5 border border-amber-500/20 rounded-2xl text-sm font-mono font-bold uppercase focus:ring-4 focus:ring-amber-500/10 focus:border-amber-500/40 transition-all"
          data-testid="lpn-search"
        />
        <button
          onClick={findBox}
          disabled={lpnSearching || !lpnSearch.trim()}
          className="absolute right-2 top-1/2 -translate-y-1/2 px-3 py-1.5 bg-amber-500 hover:bg-amber-400 text-white rounded-xl text-[10px] font-black uppercase tracking-widest disabled:opacity-30 flex items-center gap-1.5"
        >
          {lpnSearching ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Search className="w-3.5 h-3.5" />}
          Buscar
        </button>
      </div>

      <div className="relative group">
        <Search className="absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5 text-muted-foreground group-focus-within:text-primary transition-colors" />
        <input
          placeholder={`Buscar en ${activeTab === 'custom' ? 'mis locaciones' : 'locaciones de sistema'}...`}
          value={search}
          onChange={e => setSearch(e.target.value)}
          className="w-full pl-12 pr-4 py-4 bg-card/40 border border-border/40 rounded-2xl text-sm font-bold focus:ring-4 focus:ring-primary/10 transition-all"
        />
      </div>

      <div className="space-y-10 pb-10">
        {(() => {
          const grouped = filtered.reduce((acc, l) => {
            const zone = l.zone || 'SIN ZONA';
            if (!acc[zone]) acc[zone] = [];
            acc[zone].push(l);
            return acc;
          }, {});

          const sortedZones = Object.keys(grouped).sort();
          // When searching, the filter already narrows the set down, so render
          // all matches. Otherwise paint progressively.
          const isSearching = search.trim().length > 0;
          const zonesToRender = isSearching ? sortedZones : sortedZones.slice(0, visibleZones);
          const hiddenZoneCount = sortedZones.length - zonesToRender.length;

          if (filtered.length === 0) return (
            <div className="py-20 text-center bg-secondary/10 rounded-[3rem] border-2 border-dashed border-border/20">
              <MapPin className="w-12 h-12 text-muted-foreground/30 mx-auto mb-4" />
              <p className="text-sm font-black text-muted-foreground uppercase tracking-widest">No se encontraron ubicaciones</p>
            </div>
          );

          return (<>
          {zonesToRender.map(zone => (
            <div key={zone} className="space-y-4">
              <div className="flex items-center gap-3">
                <div className="h-6 w-1 bg-primary rounded-full shadow-[0_0_10px_rgba(255,193,7,0.5)]" />
                <h3 className="text-lg font-black uppercase tracking-tighter flex items-center gap-2">
                  {zone}
                  <span className="text-[10px] font-bold bg-secondary/50 px-2.5 py-1 rounded-full text-muted-foreground">
                    {grouped[zone].length} {t('wms_locations') || 'UBICACIONES'}
                  </span>
                </h3>
                <button
                  onClick={() => {
                    if (window.confirm(`¿Imprimir todas las ${grouped[zone].length} ubicaciones de zona "${zone}"?`)) {
                      window.open(`${API}/locations/print?zone=${encodeURIComponent(zone)}`, '_blank');
                    }
                  }}
                  className="ml-auto flex items-center gap-1.5 px-3 py-1.5 bg-emerald-500/10 hover:bg-emerald-500 hover:text-white text-emerald-500 border border-emerald-500/20 rounded-lg text-[10px] font-black uppercase tracking-widest transition-all"
                  title={`Imprimir todas las etiquetas de zona ${zone}`}
                >
                  <Printer className="w-3 h-3" />
                  Imprimir Zona
                </button>
              </div>

              <div className="rounded-2xl border border-border/30 overflow-hidden bg-card/20">
                <div className="grid grid-cols-[minmax(140px,1.2fr)_110px_70px_minmax(180px,2.4fr)_140px] gap-3 px-4 py-2 text-[9px] font-black uppercase tracking-widest text-muted-foreground/50 bg-secondary/20 border-b border-border/30">
                  <span>Ubicación</span>
                  <span className="text-right">Inventario</span>
                  <span className="text-right">SKUs</span>
                  <span>Items (top 5)</span>
                  <span className="text-right">Acciones</span>
                </div>
                {grouped[zone].map(l => {
                  const summary = l.inventory_summary || { total_units: 0, skus_count: 0, items: [] };
                  const isEmpty = summary.total_units === 0;
                  return (
                    <div
                      key={l.location_id}
                      onClick={() => !isEmpty && openDetail(l)}
                      className={`grid grid-cols-[minmax(140px,1.2fr)_110px_70px_minmax(180px,2.4fr)_140px] gap-3 px-4 py-2 items-center border-b border-border/10 hover:bg-secondary/30 transition-colors border-l-2 ${isEmpty ? 'border-l-transparent opacity-60' : `cursor-pointer ${activeTab === 'system' ? 'border-l-indigo-500/40' : 'border-l-primary/40'}`}`}
                    >
                      <div className="flex items-center gap-2 min-w-0">
                        <MapPin className={`w-3.5 h-3.5 flex-shrink-0 ${isEmpty ? 'text-muted-foreground/40' : 'text-primary'}`} />
                        <span className="font-mono font-black text-sm tracking-tighter truncate" title={l.name}>{l.name}</span>
                      </div>
                      <span className={`text-right font-mono font-black text-sm tabular-nums ${isEmpty ? 'text-muted-foreground/40' : 'text-emerald-500'}`}>
                        {(summary.total_units || 0).toLocaleString()}
                      </span>
                      <span className="text-right text-xs font-bold tabular-nums text-muted-foreground">
                        {summary.skus_count || 0}
                      </span>
                      <div className="text-[10px] font-mono truncate" title={summary.items.map(it => `${it.style}: ${it.units}`).join(' · ')}>
                        {isEmpty ? (
                          <span className="text-muted-foreground/40 italic uppercase tracking-widest">Vacío</span>
                        ) : (
                          <>
                            {summary.items.map((item, idx) => (
                              <span key={idx}>
                                <span className="text-foreground/90 font-bold">{item.style}</span>
                                <span className="text-muted-foreground/70"> ({item.units})</span>
                                {idx < summary.items.length - 1 ? <span className="text-muted-foreground/30"> · </span> : null}
                              </span>
                            ))}
                            {summary.skus_count > 5 && (
                              <span className="text-primary/60 font-black ml-1">+{summary.skus_count - 5}</span>
                            )}
                          </>
                        )}
                      </div>
                      <div className="flex items-center justify-end gap-0.5" onClick={e => e.stopPropagation()}>
                        <button
                          onClick={() => window.open(`${API}/locations/print?ids=${l.location_id}`, '_blank')}
                          className="p-1.5 text-muted-foreground hover:text-primary hover:bg-primary/10 rounded-md transition-all"
                          title="Imprimir etiqueta"
                        >
                          <Printer className="w-3.5 h-3.5" />
                        </button>
                        {!isEmpty && (
                          <button
                            onClick={() => setMoveBulk({ from: l, to: '' })}
                            className="p-1.5 text-muted-foreground hover:text-blue-400 hover:bg-blue-500/10 rounded-md transition-all"
                            title={`Mover todo el contenido de ${l.name} a otra ubicación`}
                          >
                            <ArrowRightLeft className="w-3.5 h-3.5" />
                          </button>
                        )}
                        {l.name !== 'UBICACION TEMPORAL' && (
                          <>
                            <button
                              onClick={() => setEditingLoc({ location_id: l.location_id, name: l.name, zone: l.zone || '' })}
                              className="p-1.5 text-muted-foreground hover:text-yellow-500 hover:bg-yellow-500/10 rounded-md transition-all"
                              title="Editar ubicación"
                            >
                              <Edit3 className="w-3.5 h-3.5" />
                            </button>
                            <button
                              onClick={() => handleDelete(l.location_id, l.name)}
                              className="p-1.5 text-muted-foreground hover:text-red-500 hover:bg-red-500/10 rounded-md transition-all"
                              title="Eliminar ubicación"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          </>
                        )}
                        {l.name === 'UBICACION TEMPORAL' && (
                          <span
                            className="px-2 py-0.5 text-[9px] font-black uppercase tracking-widest text-amber-500 bg-amber-500/10 border border-amber-500/30 rounded"
                            title="Ubicación del sistema (módulo En Tránsito) — no editable ni eliminable"
                          >
                            sistema
                          </span>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
          {hiddenZoneCount > 0 && (
            <div className="flex justify-center pt-2">
              <button
                onClick={() => setVisibleZones(v => v + ZONES_PER_PAGE)}
                className="px-6 py-3 bg-primary/10 hover:bg-primary hover:text-black text-primary border border-primary/30 rounded-2xl text-xs font-black uppercase tracking-widest transition-all"
              >
                Mostrar más zonas ({hiddenZoneCount} restantes)
              </button>
            </div>
          )}
          </>);
        })()}
      </div>
      {moveBulk && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-md animate-in fade-in duration-150">
          <div className="w-full max-w-md p-6 bg-card border border-blue-500/40 rounded-[2.5rem] shadow-2xl space-y-5 mx-4">
            <div className="flex items-start justify-between">
              <div className="flex items-center gap-3 min-w-0">
                <div className="w-10 h-10 rounded-2xl bg-blue-500/10 flex items-center justify-center flex-shrink-0">
                  <ArrowRightLeft className="w-5 h-5 text-blue-400" />
                </div>
                <div className="min-w-0">
                  <h3 className="text-sm font-black uppercase tracking-tighter">Mover todo el stock</h3>
                  <p className="text-[10px] text-muted-foreground font-bold uppercase tracking-widest opacity-60">Bulk relocation</p>
                </div>
              </div>
              <button onClick={() => setMoveBulk(null)} className="p-1 hover:bg-secondary rounded-lg transition-all" disabled={movingBulk}>
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="bg-secondary/40 rounded-2xl p-4 border border-border/20">
              <div className="text-[10px] font-black uppercase text-muted-foreground/60 tracking-widest mb-1">Origen</div>
              <div className="font-mono font-black text-red-400 text-lg">{moveBulk.from.name}</div>
              <div className="text-[11px] text-muted-foreground font-bold mt-1">
                {moveBulk.from.inventory_summary?.skus_count || 0} SKUs · {(moveBulk.from.inventory_summary?.total_units || 0).toLocaleString()} unidades
              </div>
            </div>

            <div>
              <label className="text-[10px] font-black uppercase tracking-widest text-muted-foreground ml-2 mb-1 block">Ubicación destino</label>
              <input
                value={moveBulk.to}
                onChange={e => setMoveBulk(m => ({ ...m, to: e.target.value.toUpperCase() }))}
                placeholder="Ej: A-02-01"
                className="w-full px-4 py-3 bg-background border border-border rounded-2xl text-lg font-black font-mono focus:ring-4 focus:ring-blue-500/20"
                data-testid="bulk-move-dst"
                autoFocus
              />
              <p className="text-[10px] text-muted-foreground/60 mt-2 px-2">
                La ubicación destino debe existir. Si ya tiene el mismo SKU, las unidades se sumarán.
              </p>
            </div>

            <div className="flex gap-3">
              <button
                onClick={handleBulkMove}
                disabled={movingBulk || !moveBulk.to?.trim()}
                className="flex-1 py-3 bg-blue-500 text-white rounded-2xl font-black uppercase tracking-widest text-xs shadow-xl shadow-blue-500/20 hover:scale-[1.02] active:scale-95 transition-all disabled:opacity-50 flex items-center justify-center gap-2"
                data-testid="bulk-move-confirm"
              >
                {movingBulk ? <Loader2 className="w-4 h-4 animate-spin" /> : <ArrowRightLeft className="w-4 h-4" />}
                Mover
              </button>
              <button
                onClick={() => setMoveBulk(null)}
                disabled={movingBulk}
                className="flex-1 py-3 bg-secondary text-foreground rounded-2xl font-black uppercase tracking-widest text-xs hover:bg-secondary/80 transition-all disabled:opacity-50"
              >
                Cancelar
              </button>
            </div>
          </div>
        </div>
      )}

      {editingLoc && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-md animate-in fade-in duration-200">
          <div className="w-full max-w-md p-6 bg-card border border-border rounded-[2.5rem] shadow-2xl space-y-6 mx-4">
            <div>
              <h3 className="text-xl font-black uppercase tracking-tighter">Editar Ubicación</h3>
              <p className="text-xs text-muted-foreground font-bold uppercase tracking-widest opacity-60">Modificar parámetros de la ubicación</p>
            </div>

            <div className="space-y-4">
              <div className="space-y-2">
                <label className="text-[10px] font-black uppercase tracking-widest text-muted-foreground ml-2">Nombre de Locación</label>
                <input
                  value={editingLoc.name}
                  onChange={e => setEditingLoc(p => ({ ...p, name: e.target.value.toUpperCase() }))}
                  className="w-full px-4 py-3.5 bg-background border border-border rounded-2xl text-lg font-black font-mono focus:ring-4 focus:ring-primary/10 transition-all"
                />
              </div>

              <div className="space-y-2">
                <label className="text-[10px] font-black uppercase tracking-widest text-muted-foreground ml-2">Zona / Pasillo</label>
                <input
                  value={editingLoc.zone}
                  onChange={e => setEditingLoc(p => ({ ...p, zone: e.target.value.toUpperCase() }))}
                  className="w-full px-4 py-3.5 bg-background border border-border rounded-2xl text-lg font-black focus:ring-4 focus:ring-primary/10 transition-all"
                />
              </div>
            </div>

            <div className="flex gap-3">
              <button
                onClick={handleUpdateLoc}
                disabled={loading || !editingLoc.name}
                className="flex-1 py-4 bg-primary text-black rounded-2xl font-black uppercase tracking-widest text-xs shadow-xl shadow-primary/20 hover:scale-[1.02] active:scale-95 transition-all"
              >
                {loading ? <Loader2 className="w-4 h-4 animate-spin mx-auto" /> : 'Guardar Cambios'}
              </button>
              <button
                onClick={() => setEditingLoc(null)}
                className="flex-1 py-4 bg-secondary text-foreground rounded-2xl font-black uppercase tracking-widest text-xs hover:bg-secondary/80 transition-all"
              >
                Cancelar
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Location detail modal — opens when user clicks a non-empty row. */}
      {detailLoc && (
        <div
          className="fixed inset-0 z-[70] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm animate-in fade-in duration-150"
          onClick={() => setDetailLoc(null)}
        >
          <div
            onClick={e => e.stopPropagation()}
            className="bg-card border border-emerald-500/40 rounded-3xl w-full max-w-5xl max-h-[90vh] flex flex-col shadow-2xl animate-in zoom-in-95 duration-150"
          >
            <div className="flex items-center justify-between p-5 border-b border-border/20">
              <div className="flex items-center gap-3 min-w-0">
                <div className="w-12 h-12 rounded-2xl bg-emerald-500/10 flex items-center justify-center flex-shrink-0">
                  <MapPin className="w-6 h-6 text-emerald-400" />
                </div>
                <div className="min-w-0">
                  <h3 className="font-mono font-black text-xl tracking-tighter">{detailLoc.name}</h3>
                  <p className="text-[11px] text-muted-foreground font-bold uppercase tracking-widest">
                    Zona {detailLoc.zone || 'SIN ZONA'}
                    {detailLoc.inventory_summary && (
                      <> · {detailLoc.inventory_summary.skus_count || 0} SKUs · {(detailLoc.inventory_summary.total_units || 0).toLocaleString()} pzs</>
                    )}
                  </p>
                </div>
              </div>
              <button
                onClick={() => setDetailLoc(null)}
                className="p-2 hover:bg-secondary rounded-lg transition-all flex-shrink-0"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="flex-1 overflow-auto custom-scrollbar p-5">
              {detailLoading ? (
                <div className="flex flex-col items-center justify-center py-20">
                  <Loader2 className="w-8 h-8 animate-spin text-emerald-400" />
                  <span className="text-[10px] font-black uppercase tracking-widest text-muted-foreground/60 mt-3">Cargando contenido…</span>
                </div>
              ) : detailItems.length === 0 ? (
                <div className="text-center py-16 text-xs font-bold uppercase tracking-widest text-muted-foreground/40 italic">
                  Sin contenido en esta ubicación
                </div>
              ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  {detailItems.map((it, i) => (
                    <div
                      key={it.inventory_id || `${it.sku}-${it.color}-${it.size}-${i}`}
                      className="border border-border/40 rounded-2xl bg-secondary/20 overflow-hidden"
                    >
                      {/* Header: customer + style/sku */}
                      <div className="px-4 py-3 bg-secondary/40 border-b border-border/20 flex items-center justify-between gap-3">
                        <div className="min-w-0">
                          <div className="text-[9px] font-black uppercase tracking-widest text-muted-foreground/60">Cliente</div>
                          <div className="font-mono font-black text-sm truncate" title={it.customer}>{it.customer || '—'}</div>
                        </div>
                        <div className="min-w-0 text-right">
                          <div className="text-[9px] font-black uppercase tracking-widest text-muted-foreground/60">SKU</div>
                          <div className="font-mono font-black text-sm text-primary truncate" title={`${it.style}-${it.color}-${it.size}`}>
                            {it.style}{it.color ? `-${it.color}` : ''}{it.size ? `-${it.size}` : ''}
                          </div>
                        </div>
                      </div>

                      {/* Body: details grid */}
                      <div className="grid grid-cols-2 gap-px bg-border/20 text-[11px]">
                        <div className="bg-card/60 px-4 py-2">
                          <div className="text-[9px] font-black uppercase tracking-widest text-muted-foreground/60 flex items-center gap-1"><Package className="w-2.5 h-2.5" /> Fabricante</div>
                          <div className="font-mono font-bold truncate">{it.manufacturer || '—'}</div>
                        </div>
                        <div className="bg-card/60 px-4 py-2">
                          <div className="text-[9px] font-black uppercase tracking-widest text-muted-foreground/60 flex items-center gap-1"><Hash className="w-2.5 h-2.5" /> Estilo</div>
                          <div className="font-mono font-bold truncate">{it.style || '—'}</div>
                        </div>
                        <div className="bg-card/60 px-4 py-2">
                          <div className="text-[9px] font-black uppercase tracking-widest text-muted-foreground/60 flex items-center gap-1"><Tag className="w-2.5 h-2.5" /> Color</div>
                          <div className="font-mono font-bold truncate">{it.color || '—'}</div>
                        </div>
                        <div className="bg-card/60 px-4 py-2">
                          <div className="text-[9px] font-black uppercase tracking-widest text-muted-foreground/60">Talla</div>
                          <div className="font-mono font-bold truncate">{it.size || '—'}</div>
                        </div>
                        <div className="bg-card/60 px-4 py-2 col-span-2">
                          <div className="text-[9px] font-black uppercase tracking-widest text-muted-foreground/60 flex items-center gap-1"><FileText className="w-2.5 h-2.5" /> Descripción</div>
                          <div className="font-mono font-bold truncate" title={it.description}>{it.description || '—'}</div>
                        </div>
                        <div className="bg-card/60 px-4 py-2">
                          <div className="text-[9px] font-black uppercase tracking-widest text-muted-foreground/60 flex items-center gap-1"><Globe className="w-2.5 h-2.5" /> País de origen</div>
                          <div className="font-mono font-bold truncate">{it.country_of_origin || '—'}</div>
                        </div>
                        <div className="bg-card/60 px-4 py-2">
                          <div className="text-[9px] font-black uppercase tracking-widest text-muted-foreground/60 flex items-center gap-1"><Layers className="w-2.5 h-2.5" /> Contenido tela</div>
                          <div className="font-mono font-bold truncate" title={it.fabric_content}>{it.fabric_content || '—'}</div>
                        </div>
                        {(it.po || it.bpo) && (
                          <div className="bg-card/60 px-4 py-2 col-span-2">
                            <div className="text-[9px] font-black uppercase tracking-widest text-muted-foreground/60 flex items-center gap-1"><User className="w-2.5 h-2.5" /> PO / BPO</div>
                            <div className="font-mono font-bold truncate">{[it.po, it.bpo].filter(Boolean).join(' · ') || '—'}</div>
                          </div>
                        )}
                      </div>

                      {/* Footer: stock summary */}
                      <div className="px-4 py-3 grid grid-cols-3 gap-3 bg-secondary/40 border-t border-border/20 text-center">
                        <button
                          type="button"
                          onClick={() => toggleBoxes(it)}
                          disabled={!it.inventory_id || (it.total_boxes || 0) === 0}
                          className={`rounded-lg transition-all ${it.inventory_id && (it.total_boxes || 0) > 0 ? 'cursor-pointer hover:bg-primary/10' : 'cursor-default opacity-80'}`}
                          title={it.inventory_id && (it.total_boxes || 0) > 0 ? 'Ver LPNs en esta ubicación' : ''}
                        >
                          <div className="text-[9px] font-black uppercase tracking-widest text-muted-foreground/60 flex items-center justify-center gap-1"><Box className="w-2.5 h-2.5" /> Cajas</div>
                          <div className={`font-mono font-black text-base tabular-nums ${boxesByInv[it.inventory_id] ? 'text-primary' : ''}`}>{(it.total_boxes || 0).toLocaleString()}</div>
                        </button>
                        <div>
                          <div className="text-[9px] font-black uppercase tracking-widest text-muted-foreground/60">On hand</div>
                          <div className="font-mono font-black text-base text-emerald-500 tabular-nums">{(it.on_hand ?? it.units_on_hand ?? 0).toLocaleString()}</div>
                        </div>
                        <div>
                          <div className="text-[9px] font-black uppercase tracking-widest text-muted-foreground/60">Disponible</div>
                          <div className="font-mono font-black text-base text-blue-400 tabular-nums">{(it.available ?? ((it.on_hand ?? it.units_on_hand ?? 0) - (it.allocated ?? it.units_allocated ?? 0))).toLocaleString()}</div>
                        </div>
                      </div>

                      {/* Boxes (LPN) drawer — appears only when the user clicks the Cajas tile */}
                      {boxesByInv[it.inventory_id] && (
                        <div className="border-t border-border/20 bg-card/40 p-3 max-h-60 overflow-y-auto custom-scrollbar">
                          {boxesByInv[it.inventory_id].loading ? (
                            <div className="flex items-center justify-center py-4 gap-2 text-muted-foreground">
                              <Loader2 className="w-4 h-4 animate-spin" />
                              <span className="text-[10px] font-bold uppercase tracking-widest">Cargando LPNs…</span>
                            </div>
                          ) : boxesByInv[it.inventory_id].boxes.length === 0 ? (
                            <div className="text-center text-[10px] text-muted-foreground font-bold uppercase py-3">Sin LPNs registrados</div>
                          ) : (
                            <table className="w-full text-[11px]">
                              <thead>
                                <tr className="border-b border-border/20">
                                  <th className="text-left py-1 px-2 text-[9px] font-black uppercase tracking-widest text-muted-foreground/70">LPN</th>
                                  <th className="text-right py-1 px-2 text-[9px] font-black uppercase tracking-widest text-muted-foreground/70">Unidades</th>
                                  <th className="text-left py-1 px-2 text-[9px] font-black uppercase tracking-widest text-muted-foreground/70">Estado</th>
                                  <th className="text-right py-1 px-2 text-[9px] font-black uppercase tracking-widest text-muted-foreground/70">Acción</th>
                                </tr>
                              </thead>
                              <tbody>
                                {boxesByInv[it.inventory_id].boxes.map((b, bi) => {
                                  const isRelocating = relocatingBoxId === b.box_id;
                                  if (isRelocating) {
                                    const q = (relocateDst || '').trim().toUpperCase();
                                    const matches = (q
                                      ? activeLocations.filter(l => (l.name || '').toUpperCase().includes(q))
                                      : activeLocations
                                    ).slice(0, 30);
                                    return (
                                      <tr key={b.box_id || bi} className="bg-amber-500/10 border-b border-amber-500/20">
                                        <td colSpan={4} className="py-2 px-2">
                                          <div className="flex items-center gap-2 flex-wrap">
                                            <span className="font-mono font-black text-amber-500 text-[11px] whitespace-nowrap">
                                              {b.box_id} →
                                            </span>
                                            <div className="relative flex-1 min-w-[160px]">
                                              <input
                                                autoFocus
                                                type="text"
                                                value={relocateDst}
                                                onChange={e => { setRelocateDst(e.target.value.toUpperCase()); setShowLocDrop(true); }}
                                                onFocus={() => setShowLocDrop(true)}
                                                onBlur={() => setTimeout(() => setShowLocDrop(false), 150)}
                                                onKeyDown={e => {
                                                  if (e.key === 'Enter') { e.preventDefault(); confirmRelocate(b, it.inventory_id); }
                                                  if (e.key === 'Escape') { e.preventDefault(); cancelRelocate(); }
                                                }}
                                                placeholder="Ubicación destino"
                                                className="w-full px-2 py-1 bg-background border border-amber-500/40 rounded text-[11px] font-mono uppercase focus:outline-none focus:border-amber-500"
                                              />
                                              {showLocDrop && matches.length > 0 && (
                                                <div className="absolute z-40 mt-0.5 w-full max-h-48 overflow-y-auto bg-popover border border-border rounded-lg shadow-xl">
                                                  {matches.map(l => (
                                                    <button
                                                      key={l.location_id || l.name}
                                                      type="button"
                                                      onMouseDown={(e) => {
                                                        e.preventDefault();
                                                        setRelocateDst(l.name);
                                                        setShowLocDrop(false);
                                                      }}
                                                      className="w-full text-left px-2 py-1 text-[11px] font-mono hover:bg-secondary flex items-center justify-between"
                                                    >
                                                      <span className="font-bold">{l.name}</span>
                                                      {l.zone && <span className="text-[9px] uppercase tracking-widest text-muted-foreground">{l.zone}</span>}
                                                    </button>
                                                  ))}
                                                </div>
                                              )}
                                            </div>
                                            <button
                                              type="button"
                                              onClick={() => confirmRelocate(b, it.inventory_id)}
                                              disabled={relocateSaving || !relocateDst.trim()}
                                              className="px-2.5 py-1 bg-amber-500 hover:bg-amber-400 text-white rounded text-[10px] font-black uppercase tracking-widest disabled:opacity-50 flex items-center gap-1"
                                            >
                                              {relocateSaving ? <Loader2 className="w-3 h-3 animate-spin" /> : 'OK'}
                                            </button>
                                            <button
                                              type="button"
                                              onClick={cancelRelocate}
                                              disabled={relocateSaving}
                                              className="px-2 py-1 text-[10px] font-bold uppercase tracking-widest text-muted-foreground hover:text-foreground"
                                            >
                                              ✕
                                            </button>
                                          </div>
                                        </td>
                                      </tr>
                                    );
                                  }
                                  const isHighlighted = highlightBoxId && b.box_id === highlightBoxId;
                                  return (
                                    <tr key={b.box_id || bi} className={`border-b border-border/5 group/lpn transition-colors ${isHighlighted ? 'bg-amber-400/30 ring-2 ring-amber-500/40' : 'hover:bg-primary/5'}`}>
                                      <td className="py-1 px-2 font-mono font-bold text-primary">
                                        {isHighlighted && <Box className="w-3 h-3 text-amber-500 inline mr-1" />}
                                        {b.box_id || '—'}
                                      </td>
                                      <td className="py-1 px-2 text-right font-mono font-black text-emerald-500">{(b.units || b.qty || 0).toLocaleString()}</td>
                                      <td className="py-1 px-2 text-[9px] font-bold uppercase tracking-wide text-muted-foreground">{b.state || b.status || '—'}</td>
                                      <td className="py-1 px-2 text-right">
                                        <button
                                          type="button"
                                          onClick={() => startRelocate(b.box_id)}
                                          className="opacity-0 group-hover/lpn:opacity-100 transition-opacity inline-flex items-center gap-1 px-1.5 py-0.5 text-[9px] font-black uppercase tracking-widest text-amber-500 hover:bg-amber-500/10 rounded border border-amber-500/30"
                                          title={`Mover ${b.box_id || 'esta caja'} a otra ubicación`}
                                        >
                                          <ArrowRightLeft className="w-2.5 h-2.5" /> Mover
                                        </button>
                                      </td>
                                    </tr>
                                  );
                                })}
                              </tbody>
                            </table>
                          )}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="flex items-center justify-between gap-3 p-5 border-t border-border/20">
              <span className="text-[10px] font-black uppercase tracking-widest text-muted-foreground/60">
                {detailItems.length} línea{detailItems.length === 1 ? '' : 's'} en esta ubicación
              </span>
              <button
                onClick={() => setDetailLoc(null)}
                className="px-5 py-2 bg-secondary/60 hover:bg-secondary text-foreground rounded-xl text-xs font-bold uppercase tracking-widest transition-all"
              >
                Cerrar
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
