import React, { useState, useEffect, useCallback, useRef, useTransition } from "react";
import { toast } from "sonner";
import { Printer, Plus, X, MapPin, Loader2, Edit3, Trash2, Search, ArrowRightLeft, Package, Tag, Globe, Layers, Box, User, FileText, Hash, ChevronRight, Lock, Unlock } from "lucide-react";
import { useLang } from "../../contexts/LanguageContext";
import { API, fetcher, poster, deleter, logLoadError } from "./lib";
import { Btn, cls, EmptyState, ModuleToolbar } from "./ui";
import { adminLevelOf } from "./modules";

// System-protected slots managed by Putaway 2.0 — mirrors backend
// SYSTEM_TRANSIT_LOCATIONS. Can't be edited / deleted from the UI.
const SYSTEM_TRANSIT_NAMES = new Set([
  'UBICACION TEMPORAL',
  ...Array.from({ length: 50 }, (_, i) => `CARRO ${i + 1}`),
]);

export const LocationsModule = ({ currentUser }) => {
  const { t } = useLang();
  // Managing a location's contents — empty it, delete a line/box, HOLD/SAT —
  // requires admin level 2+. Se usa el MISMO cálculo canónico que el menú
  // (adminLevelOf: supersu=5, admin=su nivel, ceo=3, inventory≥3=3), así que el
  // botón se muestra a cualquier usuario que el backend ya autoriza con
  // require_admin_level(2) — no solo a supersu/admin.
  const adminLevel = adminLevelOf(currentUser);
  const canManageLocations = adminLevel >= 2;
  const [clearingLoc, setClearingLoc] = useState(false);
  const [locations, setLocations] = useState([]);
  const [editingId, setEditingId] = useState(null);
  const [loading, setLoading] = useState(false);
  const [showNewLoc, setShowNewLoc] = useState(false);
  const [search, setSearch] = useState('');
  const [newLoc, setNewLoc] = useState({ name: '', zone: '', type: 'rack' });
  const [activeTab, setActiveTab] = useState('custom'); // 'custom' | 'system' | 'narro' | 'pallet'
  // useTransition (React 19) marks the tab change as non-urgent. The CURRENT
  // view stays interactive while React renders the new tab in the background,
  // and isPending stays true the whole time the heavy render is in flight —
  // including for NARRO (6,688 docs) where the manual RAF approach hid the
  // spinner because the work blocked the main thread before paint.
  const [tabSwitching, startTabTransition] = useTransition();
  // For heavy tabs (NARRO ≈ 6,688 docs, PALLET ≈ 836) we collapse all zones by
  // default. Each zone header is light; the locations inside only mount when
  // the user expands one. Without this, the initial render is JS-bound for
  // several seconds and even the spinner can't paint.
  const HEAVY_TABS = new Set(['narro', 'pallet', 'system']);
  const [expandedZones, setExpandedZones] = useState(() => new Set());
  const switchTab = (next) => {
    if (next === activeTab) return;
    // Reset expansion when we move to a heavy tab so nothing big mounts up
    // front. Light tabs (custom, system without narro/pallet) auto-expand.
    setExpandedZones(new Set());
    startTabTransition(() => { setActiveTab(next); });
  };
  const toggleZone = (zone) => {
    const wasOpen = expandedZones.has(zone);
    setExpandedZones(prev => {
      const next = new Set(prev);
      if (next.has(zone)) next.delete(zone); else next.add(zone);
      return next;
    });
    // When opening, snap the zone header to the top of the viewport so the
    // freshly mounted content unfolds downward. Defer to next paint so the
    // DOM has the new layout before scrollIntoView measures.
    if (!wasOpen) {
      requestAnimationFrame(() => {
        const el = document.querySelector(`[data-zone-header="${zone}"]`);
        if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
    }
  };
  // Light tabs render zone contents inline by default — same UX as before.
  const isHeavyTab = HEAVY_TABS.has(activeTab);
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
  useEffect(() => { setShowZeroRows(false); }, [detailLoc?.name]);
  const [detailLoading, setDetailLoading] = useState(false);
  // Per-item LPN expansion inside the detail modal. Keys are inventory_id;
  // values are { loading: bool, boxes: [] }. Lazy-fetched on toggle.
  const [boxesByInv, setBoxesByInv] = useState({});
  // Which LPN drawers are currently expanded. We track this separately from
  // boxesByInv so the box DATA can be preloaded silently (fast click response)
  // without forcing every drawer open at once.
  const [openDrawers, setOpenDrawers] = useState(() => new Set());

  // Inline per-LPN relocate inside the detail modal. While a box is being
  // relocated we replace its row with a small destination input + confirm.
  const [relocatingBoxId, setRelocatingBoxId] = useState(null);
  // Cajas en 0 ('depleted') colapsadas por defecto: son actas de cajas ya
  // surtidas y ensucian la vista (PS05-A26 llego a listar 87 registros con 5
  // reales). PERO NO SE OCULTAN DEL TODO: ~292 fueron puestas en 0 por un
  // conteo que no las vio y siguen fisicamente llenas en el rack — esconderlas
  // taparia justo el material perdido. Un clic las muestra.
  const [showEmptyBoxes, setShowEmptyBoxes] = useState(() => new Set());
  // Renglones en 0 ocultos por defecto — SOLO en la vista. NO se borran de la
  // base: el usuario recuerda (y el código lo confirma) que el FIFO viejo
  // vaciaba cajas EN PAPEL que seguían llenas en el rack; un renglón en 0
  // puede ser la única pista visible de ese material. Un clic los muestra.
  const [showZeroRows, setShowZeroRows] = useState(false);
  const [relocateDst, setRelocateDst] = useState('');
  const [relocateSaving, setRelocateSaving] = useState(false);
  // Per-LINE move: relocate a whole inventory line (all its LPNs) to another
  // location in one action.
  const [relocatingLineId, setRelocatingLineId] = useState(null);
  const [lineDst, setLineDst] = useState('');
  const [lineSaving, setLineSaving] = useState(false);
  const [lineDrop, setLineDrop] = useState(false);
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

  // HOLD (SAT): supersu can park a location so nobody touches its stock, or
  // release it. Mirrors the backend guard in wms.py (_assert_not_on_hold).
  const toggleHold = async (l) => {
    try {
      if (l.on_hold) {
        await deleter(`/location-holds/${encodeURIComponent(l.name)}`);
        toast.success(t('wms_loc_hold_released', { name: l.name }));
      } else {
        if (!window.confirm(t('wms_loc_hold_confirm', { name: l.name }))) return;
        await poster('/location-holds', { locations: [l.name], reason: 'SAT' });
        toast.success(t('wms_loc_hold_set', { name: l.name }));
      }
      load();
    } catch {
      toast.error(t('wms_loc_hold_err'));
    }
  };

  const openDetail = useCallback(async (loc) => {
    setDetailLoc(loc);
    setDetailItems([]);
    setBoxesByInv({});
    setOpenDrawers(new Set());
    setRelocatingBoxId(null);
    setRelocateDst('');
    setDetailLoading(true);
    // Kick off the active-locations fetch in parallel — needed by the
    // relocate typeahead. Won't block the detail load.
    if (!activeLocLoaded) {
      fetcher('/locations/names')
        .then(rows => {
          // Include ALL locations (active and inactive) so any slot is a valid
          // relocate/move destination.
          setActiveLocations(Array.isArray(rows) ? rows : []);
          setActiveLocLoaded(true);
        })
        .catch(logLoadError('locations for relocate'));
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
      toast.error(t('wms_loc_detail_err'));
    } finally { setDetailLoading(false); }
  }, [activeLocLoaded, t]);

  // Delete one inventory line (and its boxes) from the open location.
  const deleteInvLine = useCallback(async (it) => {
    if (!it.inventory_id) { toast.error(t('wms_line_no_inv_id_delete')); return; }
    const label = `${it.style || ''}${it.color ? '-' + it.color : ''}${it.size ? '-' + it.size : ''}`;
    const units = (it.on_hand ?? it.units_on_hand ?? 0).toLocaleString();
    if (!window.confirm(t('wms_line_delete_confirm', { label, units, location: detailLoc?.name }))) return;
    try {
      await deleter(`/inventory/${encodeURIComponent(it.inventory_id)}`);
      setDetailItems(prev => prev.filter(x => x.inventory_id !== it.inventory_id));
      toast.success(t('wms_line_deleted'));
      load();
    } catch {
      toast.error(t('wms_delete_err_admin'));
    }
  }, [detailLoc, load, t]);

  // Clear ALL inventory content from the open location.
  const clearLocation = useCallback(async () => {
    const items = detailItems.filter(x => x.inventory_id);
    if (items.length === 0) { toast.error(t('wms_no_lines_inv_id')); return; }
    if (!window.confirm(t('wms_clear_loc_confirm', { location: detailLoc?.name, n: items.length }))) return;
    setClearingLoc(true);
    let ok = 0;
    for (const it of items) {
      try { await deleter(`/inventory/${encodeURIComponent(it.inventory_id)}`); ok++; } catch { /* keep going */ }
    }
    setClearingLoc(false);
    toast.success(t('wms_lines_deleted_count', { ok, total: items.length }));
    if (detailLoc) openDetail(detailLoc);
    load();
  }, [detailItems, detailLoc, load, openDetail, t]);

  const findBox = useCallback(async () => {
    const lpn = (lpnSearch || '').trim().toUpperCase();
    if (!lpn) { toast.error(t('wms_lpn_search_req')); return; }
    setLpnSearching(true);
    setFoundBox(null);
    setHighlightBoxId(null);
    try {
      // Direct lookup. The backend already 404s if the box doesn't exist.
      const res = await fetch(`${API}/boxes/${encodeURIComponent(lpn)}`, { credentials: 'include' });
      if (res.status === 404) { toast.error(t('wms_box_not_found', { box: lpn })); return; }
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        toast.error(err.detail || t('wms_err_status', { status: res.status }));
        return;
      }
      const box = await res.json();
      if (!box || !box.box_id) { toast.error(t('wms_box_not_found', { box: lpn })); return; }

      const boxLoc = (box.location || '').toUpperCase();
      if (!boxLoc) {
        toast.error(t('wms_box_no_location', { box: box.box_id }));
        return;
      }
      // Find the location object in our local list so openDetail can render
      // the header + load its items. If absent (e.g. paginated out), build a
      // stub — openDetail only reads loc.name.
      const loc = locations.find(l => (l.name || '').toUpperCase() === boxLoc) || { name: box.location };
      setFoundBox(box);
      setHighlightBoxId(box.box_id);
      await openDetail(loc);
      toast.success(t('wms_box_at_location', { box: box.box_id, location: box.location }));
    } catch (err) {
      logLoadError('lookup box')(err);
      toast.error(t('wms_box_search_err'));
    } finally { setLpnSearching(false); }
  }, [lpnSearch, locations, openDetail, t]);

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
    if (!dst) { toast.error(t('wms_dest_req')); return; }
    if (!detailLoc) return;
    if (dst === (detailLoc.name || '').toUpperCase()) { toast.error(t('wms_dest_same_as_origin')); return; }
    const exists = activeLocations.some(l => (l.name || '').toUpperCase() === dst);
    if (!exists) { toast.error(t('wms_dest_not_exists', { dest: dst })); return; }
    setRelocateSaving(true);
    try {
      const res = await poster('/boxes/relocate', { box_ids: [box.box_id], to: dst });
      if (res.ok) {
        const data = await res.json();
        toast.success(data.message || t('wms_box_moved'));
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
        toast.error(err.detail || t('wms_box_move_err'));
      }
    } catch (err) {
      logLoadError('relocate box')(err);
      toast.error(t('wms_err_connection'));
    } finally { setRelocateSaving(false); }
  }, [relocateDst, detailLoc, activeLocations, load, t]);

  const startLineMove = useCallback((it) => {
    setRelocatingLineId(it.inventory_id);
    setLineDst('');
    setLineDrop(false);
  }, []);

  const cancelLineMove = useCallback(() => {
    setRelocatingLineId(null);
    setLineDst('');
    setLineDrop(false);
  }, []);

  // Move a whole inventory line: gather every LPN of the line and relocate them
  // all to the destination in one /boxes/relocate call (which rebalances the
  // inventory at both ends).
  const confirmLineMove = useCallback(async (it) => {
    const dst = (lineDst || '').trim().toUpperCase();
    if (!dst) { toast.error(t('wms_dest_req')); return; }
    if (!detailLoc) return;
    if (dst === (detailLoc.name || '').toUpperCase()) { toast.error(t('wms_dest_same_as_origin')); return; }
    if (!activeLocations.some(l => (l.name || '').toUpperCase() === dst)) {
      toast.error(t('wms_dest_not_exists', { dest: dst })); return;
    }
    setLineSaving(true);
    try {
      let boxes = await fetcher(`/boxes?inventory_id=${encodeURIComponent(it.inventory_id)}`);
      if (!Array.isArray(boxes) || boxes.length === 0) {
        const loc = detailLoc?.name || it.inv_location || it.location || '';
        const params = new URLSearchParams({ location: loc });
        if (it.sku || it.style) params.set('sku', it.sku || it.style);
        if (it.color) params.set('color', it.color);
        if (it.size) params.set('size', it.size);
        boxes = await fetcher(`/boxes?${params.toString()}`);
      }
      const boxIds = (Array.isArray(boxes) ? boxes : []).map(b => b.box_id).filter(Boolean);
      if (boxIds.length === 0) { toast.error(t('wms_line_no_boxes')); return; }
      const res = await poster('/boxes/relocate', { box_ids: boxIds, to: dst });
      if (res.ok) {
        const data = await res.json();
        toast.success(data.message || t('wms_line_moved', { dest: dst, n: boxIds.length }));
        cancelLineMove();
        if (detailLoc) openDetail(detailLoc);
        load();
      } else {
        const err = await res.json().catch(() => ({}));
        toast.error(err.detail || t('wms_line_move_err'));
      }
    } catch (err) {
      logLoadError('move line')(err);
      toast.error(t('wms_err_connection'));
    } finally { setLineSaving(false); }
  }, [lineDst, detailLoc, activeLocations, openDetail, load, cancelLineMove, t]);

  const toggleBoxes = useCallback(async (it) => {
    const id = it.inventory_id;
    if (!id) {
      toast.error(t('wms_line_no_inv_id_boxes'));
      return;
    }
    // If the drawer is already open, just close it (data stays cached).
    if (openDrawers.has(id)) {
      setOpenDrawers(prev => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
      return;
    }
    // Opening it. If the boxes were preloaded (the seeded path), just flip the
    // open state — no fetch needed. Otherwise fetch on demand.
    if (boxesByInv[id]) {
      setOpenDrawers(prev => new Set(prev).add(id));
      return;
    }
    setOpenDrawers(prev => new Set(prev).add(id));
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
      toast.error(t('wms_boxes_load_err'));
      setBoxesByInv(prev => {
        const next = { ...prev };
        delete next[id];
        return next;
      });
    }
  }, [boxesByInv, detailLoc, openDrawers, t]);

  // Super-user only. Deletes an LPN and refetches the location so the line
  // counts / on-hand reflect the inventory rebalance the backend just did.
  const deleteBox = useCallback(async (box) => {
    const id = box?.box_id;
    if (!id) return;
    if (!window.confirm(t('wms_box_delete_confirm', { box: id }))) return;
    try {
      const res = await fetch(`${API}/boxes/${encodeURIComponent(id)}`, { method: 'DELETE', credentials: 'include' });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        toast.error(err.detail || t('wms_box_delete_err'));
        return;
      }
      toast.success(t('wms_box_deleted', { box: id }));
      if (detailLoc) openDetail(detailLoc);
    } catch (err) {
      logLoadError('delete box')(err);
      toast.error(t('wms_err_connection'));
    }
  }, [detailLoc, openDetail, t]);

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
    if (!openDrawers.has(target.inventory_id)) {
      expandedForBoxRef.current = foundBox.box_id;
      toggleBoxes(target);
    }
  }, [foundBox, detailLoc, detailItems, openDrawers, toggleBoxes]);

  const handleCreateLoc = async () => {
    const name = newLoc.name.trim().toUpperCase();
    if (!name) { toast.error(t('wms_name_req')); return; }

    // Client-side check for immediate feedback
    if (locations.some(l => l.name.toUpperCase() === name)) {
      toast.error(t('wms_loc_exists', { name }));
      return;
    }

    setLoading(true);
    try {
      const res = await poster('/locations', { ...newLoc, name });
      if (res.ok) {
        toast.success(t('wms_loc_created'));
        setNewLoc({ name: '', zone: '', type: 'rack' });
        setShowNewLoc(false);
        load();
      } else {
        const err = await res.json().catch(() => ({}));
        toast.error(err.detail || t('wms_loc_create_err'));
      }
    } catch {
      toast.error(t('wms_err_connection'));
    } finally {
      setLoading(false);
    }
  };

  const handleDelete = async (id, name) => {
    if (!window.confirm(t('wms_loc_delete_confirm', { name }))) return;
    setLoading(true);
    try {
      const res = await fetch(`${API}/locations/${id}`, { method: 'DELETE', credentials: 'include' });
      if (res.ok) {
        toast.success(t('wms_loc_deleted'));
        load();
      } else {
        const err = await res.json().catch(() => ({}));
        toast.error(err.detail || t('wms_delete_err'));
      }
    } catch {
      toast.error(t('wms_err_connection'));
    } finally {
      setLoading(false);
    }
  };

  const [editingLoc, setEditingLoc] = useState(null);

  const handleUpdateLoc = async () => {
    const name = editingLoc.name.trim().toUpperCase();
    if (!name) { toast.error(t('wms_name_req')); return; }

    if (locations.some(l => l.name.toUpperCase() === name && l.location_id !== editingLoc.location_id)) {
      toast.error(t('wms_loc_exists', { name }));
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
        toast.success(t('wms_loc_updated'));
        setEditingLoc(null);
        load();
      } else {
        const err = await res.json().catch(() => ({}));
        toast.error(err.detail || t('update_err'));
      }
    } catch {
      toast.error(t('wms_err_connection'));
    } finally {
      setLoading(false);
    }
  };

  const handleBulkMove = async () => {
    if (!moveBulk || !moveBulk.to?.trim()) { toast.error(t('wms_select_dest')); return; }
    const dst = moveBulk.to.trim().toUpperCase();
    const src = moveBulk.from.name;
    if (dst === src.toUpperCase()) { toast.error(t('wms_dest_must_differ')); return; }
    setMovingBulk(true);
    try {
      const res = await poster('/move-location', { from: src, to: dst });
      if (res.ok) {
        const data = await res.json();
        toast.success(data.message || t('wms_stock_moved'));
        setMoveBulk(null);
        load();
      } else {
        const err = await res.json().catch(() => ({}));
        toast.error(err.detail || t('wms_move_err'));
      }
    } catch (err) {
      logLoadError('bulk move')(err);
      toast.error(t('wms_err_connection'));
    } finally { setMovingBulk(false); }
  };

  const filtered = locations.filter(l => {
    const summary = l.inventory_summary || { total_units: 0, skus_count: 0, items: [] };
    const matchesSearch = l.name.toLowerCase().includes(search.toLowerCase()) ||
                         (l.zone || '').toLowerCase().includes(search.toLowerCase()) ||
                         summary.items.some(item => item.style.toLowerCase().includes(search.toLowerCase()));
    // NARRO and PALLET buckets are mutually exclusive: rows with those tabs
    // never appear in custom/system. Everything else falls back to the
    // is_custom split.
    const isNarro = l.tab === 'narro';
    const isPallet = l.tab === 'pallet';
    let matchesTab;
    if (activeTab === 'narro')       matchesTab = isNarro;
    else if (activeTab === 'pallet') matchesTab = isPallet;
    else if (activeTab === 'custom') matchesTab = !isNarro && !isPallet && l.is_custom === true;
    else                             matchesTab = !isNarro && !isPallet && l.is_custom !== true;
    return matchesSearch && matchesTab;
  });

  return (
    <div className="space-y-6">
      <ModuleToolbar
        right={
          <div className="flex gap-2">
            <Btn onClick={() => window.open(`${API}/locations/print?ids=all`, '_blank')}>
              <Printer className="w-4 h-4"
      />
              {t('wms_print_labels_btn')}
            </Btn>
            <Btn variant="primary" onClick={() => setShowNewLoc(!showNewLoc)}>
              {showNewLoc ? <X className="w-4 h-4" /> : <Plus className="w-4 h-4" />}
              {showNewLoc ? t('cancel') : t('wms_new_loc')}
            </Btn>
          </div>
        }
      />

      {/* Tabs de Separación */}
      <div className="flex gap-1 p-1 bg-muted/50 rounded-lg w-fit border border-border">
        <button
          onClick={() => switchTab('custom')}
          className={`px-4 py-1.5 rounded-md text-sm font-medium transition-colors ${activeTab === 'custom' ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground hover:bg-muted'}`}
        >
          {t('wms_tab_my_locations')}
          <span className={`ml-2 px-1.5 py-0.5 rounded text-xs ${activeTab === 'custom' ? 'bg-black/10' : 'bg-background text-muted-foreground'}`}>{locations.filter(l => l.tab !== 'narro' && l.tab !== 'pallet' && l.is_custom).length}</span>
        </button>
        <button
          onClick={() => switchTab('system')}
          className={`px-4 py-1.5 rounded-md text-sm font-medium transition-colors ${activeTab === 'system' ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground hover:bg-muted'}`}
        >
          {t('wms_tab_system_inventory')}
          <span className={`ml-2 px-1.5 py-0.5 rounded text-xs ${activeTab === 'system' ? 'bg-black/10' : 'bg-background text-muted-foreground'}`}>{locations.filter(l => l.tab !== 'narro' && l.tab !== 'pallet' && !l.is_custom).length}</span>
        </button>
        <button
          onClick={() => switchTab('narro')}
          className={`px-4 py-1.5 rounded-md text-sm font-medium transition-colors ${activeTab === 'narro' ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground hover:bg-muted'}`}
        >
          NARRO
          <span className={`ml-2 px-1.5 py-0.5 rounded text-xs ${activeTab === 'narro' ? 'bg-black/10' : 'bg-background text-muted-foreground'}`}>{locations.filter(l => l.tab === 'narro').length}</span>
        </button>
        <button
          onClick={() => switchTab('pallet')}
          className={`px-4 py-1.5 rounded-md text-sm font-medium transition-colors ${activeTab === 'pallet' ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground hover:bg-muted'}`}
        >
          Pallet
          <span className={`ml-2 px-1.5 py-0.5 rounded text-xs ${activeTab === 'pallet' ? 'bg-black/10' : 'bg-background text-muted-foreground'}`}>{locations.filter(l => l.tab === 'pallet').length}</span>
        </button>
      </div>

      {showNewLoc && (
        <div className="p-4 bg-card border border-border rounded-lg animate-in fade-in duration-150">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground block">{t('wms_loc_name_label')}</label>
              <div className="relative">
                <MapPin className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground/60" />
                <input
                  placeholder={t('wms_loc_name_example')}
                  value={newLoc.name}
                  onChange={e => setNewLoc(p => ({ ...p, name: e.target.value.toUpperCase() }))}
                  className={`${cls.input} pl-9 font-mono`}
                />
              </div>
              {locations.some(l => l.name.toUpperCase() === newLoc.name.trim().toUpperCase()) && (
                <p className="text-xs text-red-600 dark:text-red-400 mt-1">{t('wms_loc_exists_inline')}</p>
              )}
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground block">{t('wms_zone_aisle')}</label>
              <input
                placeholder={t('wms_zone_example')}
                value={newLoc.zone}
                onChange={e => setNewLoc(p => ({ ...p, zone: e.target.value.toUpperCase() }))}
                className={cls.input}
              />
            </div>
            <div className="flex items-end">
              <Btn
                variant="primary"
                onClick={handleCreateLoc}
                disabled={loading || !newLoc.name || locations.some(l => l.name.toUpperCase() === newLoc.name.trim().toUpperCase())}
                className="w-full"
              >
                {loading ? <Loader2 className="w-4 h-4 animate-spin mx-auto" /> : t('wms_confirm_create')}
              </Btn>
            </div>
          </div>
        </div>
      )}

      {/* LPN finder — quick lookup that jumps directly to the box's location */}
      <div className="relative">
        <Box className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground/60" />
        <input
          placeholder={t('wms_search_lpn_ph')}
          value={lpnSearch}
          onChange={e => setLpnSearch(e.target.value.toUpperCase())}
          onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); findBox(); } }}
          disabled={lpnSearching}
          className={`${cls.input} pl-9 pr-28 font-mono`}
          data-testid="lpn-search"
        />
        <button
          onClick={findBox}
          disabled={lpnSearching || !lpnSearch.trim()}
          className="absolute right-1.5 top-1/2 -translate-y-1/2 inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md border border-border bg-card hover:bg-muted text-xs font-medium disabled:opacity-50 transition-colors"
        >
          {lpnSearching ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Search className="w-3.5 h-3.5" />}
          {t('search')}
        </button>
      </div>

      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground/60" />
        <input
          placeholder={activeTab === 'custom' ? t('wms_search_in_my_locs') : t('wms_search_in_system_locs')}
          value={search}
          onChange={e => setSearch(e.target.value)}
          className={`${cls.input} pl-9`}
        />
      </div>

      <div className="relative space-y-10 pb-10">
        {/* Spinner overlay during a tab switch — fades in/out via animate-in
            so the heavy re-render of thousands of zone cards has visible
            feedback. */}
        {tabSwitching && (
          <div className="absolute inset-0 z-20 flex items-center justify-center bg-background/70 backdrop-blur-sm rounded-lg animate-in fade-in duration-150">
            <div className="flex flex-col items-center gap-2">
              <Loader2 className="w-8 h-8 text-muted-foreground animate-spin" />
              <span className="text-xs font-medium text-muted-foreground">{t('loading')}</span>
            </div>
          </div>
        )}
        <div key={activeTab} className="animate-in fade-in slide-in-from-bottom-2 duration-300">
        {(() => {
          const grouped = filtered.reduce((acc, l) => {
            const zone = l.zone || t('wms_no_zone');
            if (!acc[zone]) acc[zone] = [];
            acc[zone].push(l);
            return acc;
          }, {});

          const sortedZones = Object.keys(grouped).sort();
          // Heavy tabs (NARRO / PALLET / Sistema): zones are collapsed by
          // default so headers are cheap — render ALL of them up front. Light
          // tabs (custom) paginate as before so we don't paint thousands of
          // cards in one tick. Search bypasses pagination on either side
          // because the result set is already narrowed.
          const isSearching = search.trim().length > 0;
          const zonesToRender = (isHeavyTab || isSearching)
            ? sortedZones
            : sortedZones.slice(0, visibleZones);
          const hiddenZoneCount = sortedZones.length - zonesToRender.length;

          if (filtered.length === 0) return (
            <EmptyState art="rack" title={t('wms_no_locs_found')}
              hint={t('wms_no_locs_found_hint')} />
          );

          return (<>
          {zonesToRender.map(zone => {
            const isExpanded = !isHeavyTab || expandedZones.has(zone) || search.trim().length > 0;
            return (
            <div key={zone} className="space-y-4">
              <div
                data-zone-header={zone}
                className={`flex items-center gap-3 scroll-mt-4 ${isHeavyTab ? 'cursor-pointer hover:bg-muted/40 rounded-md px-2 py-1 -mx-2 transition-colors' : ''}`}
                onClick={isHeavyTab ? () => toggleZone(zone) : undefined}
              >
                <div className="h-5 w-1 bg-primary rounded-full" />
                {isHeavyTab && (
                  <ChevronRight className={`w-4 h-4 text-muted-foreground transition-transform ${isExpanded ? 'rotate-90' : ''}`} />
                )}
                <h3 className="text-base font-semibold flex items-center gap-2">
                  {zone}
                  <span className="text-xs font-medium bg-muted px-2 py-0.5 rounded-md text-muted-foreground">
                    {grouped[zone].length} {t('wms_locations')}
                  </span>
                </h3>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    if (window.confirm(t('wms_print_zone_confirm', { n: grouped[zone].length, zone }))) {
                      window.open(`${API}/locations/print?zone=${encodeURIComponent(zone)}`, '_blank');
                    }
                  }}
                  className="ml-auto flex items-center gap-1.5 px-2.5 py-1 bg-card hover:bg-muted text-muted-foreground hover:text-foreground border border-border rounded-md text-xs font-medium transition-colors"
                  title={t('wms_print_zone_title', { zone })}
                >
                  <Printer className="w-3 h-3" />
                  {t('wms_print_zone')}
                </button>
              </div>

              {isExpanded && (
              <div
                className="rounded-lg border border-border overflow-hidden bg-card origin-top animate-in fade-in slide-in-from-top-2 duration-200"
                style={{ overflowAnchor: 'none' }}
              >
                <div className="grid grid-cols-[minmax(140px,1.2fr)_110px_70px_minmax(180px,2.4fr)_140px] gap-3 px-4 py-2 text-xs font-semibold text-muted-foreground bg-muted/50 border-b border-border">
                  <span>{t('location')}</span>
                  <span className="text-right">{t('wms_inventory')}</span>
                  <span className="text-right">SKUs</span>
                  <span>{t('wms_items_top5')}</span>
                  <span className="text-right">{t('actions')}</span>
                </div>
                {grouped[zone].map(l => {
                  const summary = l.inventory_summary || { total_units: 0, skus_count: 0, items: [] };
                  const isEmpty = summary.total_units === 0;
                  // content-visibility:auto lets the browser skip layout/paint for
                  // off-screen rows (cheap "virtualization" without a library);
                  // contain-intrinsic-size reserves each row's height so the
                  // scrollbar stays correct. Graceful no-op on old browsers.
                  return (
                    <div
                      key={l.location_id}
                      onClick={() => !isEmpty && openDetail(l)}
                      style={{ contentVisibility: 'auto', containIntrinsicSize: 'auto 38px' }}
                      className={`grid grid-cols-[minmax(140px,1.2fr)_110px_70px_minmax(180px,2.4fr)_140px] gap-3 px-4 py-2 items-center border-b border-border/60 hover:bg-muted/40 transition-colors ${isEmpty ? 'opacity-60' : 'cursor-pointer'}`}
                    >
                      <div className="flex items-center gap-2 min-w-0">
                        <MapPin className={`w-3.5 h-3.5 flex-shrink-0 ${l.on_hold ? 'text-red-600 dark:text-red-400' : isEmpty ? 'text-muted-foreground/40' : 'text-muted-foreground'}`} />
                        <span className="font-mono font-medium text-sm truncate" title={l.name}>{l.name}</span>
                        {l.on_hold && (
                          <span className="flex items-center gap-1 text-xs font-medium bg-red-50 text-red-700 border border-red-200 dark:bg-red-500/10 dark:text-red-300 dark:border-red-500/25 rounded-md px-1.5 py-0.5 flex-shrink-0" title={t('wms_hold_badge_title', { reason: l.hold_reason || 'SAT' })}>
                            <Lock className="w-2.5 h-2.5" /> HOLD
                          </span>
                        )}
                      </div>
                      <span className={`text-right text-sm tabular-nums ${isEmpty ? 'text-muted-foreground/40' : 'font-semibold'}`}>
                        {(summary.total_units || 0).toLocaleString()}
                      </span>
                      <span className="text-right text-xs tabular-nums text-muted-foreground">
                        {summary.skus_count || 0}
                      </span>
                      <div className="text-xs font-mono truncate" title={summary.items.map(it => `${it.style}: ${it.units}`).join(' · ')}>
                        {isEmpty ? (
                          <span className="text-muted-foreground/40 italic">{t('wms_empty')}</span>
                        ) : (
                          <>
                            {summary.items.map((item, idx) => (
                              <span key={idx}>
                                <span className="text-foreground/90 font-medium">{item.style}</span>
                                <span className="text-muted-foreground/70"> ({item.units})</span>
                                {idx < summary.items.length - 1 ? <span className="text-muted-foreground/30"> · </span> : null}
                              </span>
                            ))}
                            {summary.skus_count > 5 && (
                              <span className="text-muted-foreground font-medium ml-1">+{summary.skus_count - 5}</span>
                            )}
                          </>
                        )}
                      </div>
                      <div className="flex items-center justify-end gap-0.5" onClick={e => e.stopPropagation()}>
                        <button
                          onClick={() => window.open(`${API}/locations/print?ids=${l.location_id}`, '_blank')}
                          className="p-1.5 text-muted-foreground hover:text-foreground hover:bg-muted rounded-md transition-colors"
                          title={t('wms_print_label')}
                        >
                          <Printer className="w-3.5 h-3.5" />
                        </button>
                        {canManageLocations && (
                          <button
                            onClick={() => toggleHold(l)}
                            className={`p-1.5 rounded-md transition-colors ${l.on_hold ? 'text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-500/10' : 'text-muted-foreground hover:text-red-600 dark:hover:text-red-400 hover:bg-red-50 dark:hover:bg-red-500/10'}`}
                            title={l.on_hold ? t('wms_release_hold_title', { name: l.name }) : t('wms_set_hold_title', { name: l.name })}
                          >
                            {l.on_hold ? <Unlock className="w-3.5 h-3.5" /> : <Lock className="w-3.5 h-3.5" />}
                          </button>
                        )}
                        {!isEmpty && (
                          <button
                            onClick={() => setMoveBulk({ from: l, to: '' })}
                            className="p-1.5 text-muted-foreground hover:text-foreground hover:bg-muted rounded-md transition-colors"
                            title={t('wms_move_all_title', { name: l.name })}
                          >
                            <ArrowRightLeft className="w-3.5 h-3.5" />
                          </button>
                        )}
                        {!SYSTEM_TRANSIT_NAMES.has((l.name || '').toUpperCase()) && (
                          <>
                            <button
                              onClick={() => setEditingLoc({ location_id: l.location_id, name: l.name, zone: l.zone || '' })}
                              className="p-1.5 text-muted-foreground hover:text-foreground hover:bg-muted rounded-md transition-colors"
                              title={t('wms_edit_loc')}
                            >
                              <Edit3 className="w-3.5 h-3.5" />
                            </button>
                            <button
                              onClick={() => handleDelete(l.location_id, l.name)}
                              className="p-1.5 text-muted-foreground hover:text-red-600 dark:hover:text-red-400 hover:bg-red-50 dark:hover:bg-red-500/10 rounded-md transition-colors"
                              title={t('wms_delete_loc')}
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          </>
                        )}
                        {SYSTEM_TRANSIT_NAMES.has((l.name || '').toUpperCase()) && (
                          <span
                            className="px-1.5 py-0.5 text-xs font-medium bg-amber-50 text-amber-700 border border-amber-200 dark:bg-amber-500/10 dark:text-amber-300 dark:border-amber-500/25 rounded-md"
                            title={t('wms_system_loc_title')}
                          >
                            {t('wms_system_badge')}
                          </span>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
              )}
            </div>
            );
          })}
          {hiddenZoneCount > 0 && (
            <div className="flex justify-center pt-2">
              <Btn onClick={() => setVisibleZones(v => v + ZONES_PER_PAGE)}>
                {t('wms_show_more_zones', { n: hiddenZoneCount })}
              </Btn>
            </div>
          )}
          </>);
        })()}
        </div>
      </div>
      {moveBulk && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm animate-in fade-in duration-150">
          <div className="w-full max-w-md p-6 bg-card border border-border rounded-lg shadow-xl space-y-5 mx-4">
            <div className="flex items-start justify-between">
              <div className="min-w-0">
                <h3 className="text-sm font-semibold">{t('wms_move_all_stock')}</h3>
                <p className="text-xs text-muted-foreground mt-0.5">Bulk relocation</p>
              </div>
              <button onClick={() => setMoveBulk(null)} className="p-1 hover:bg-muted rounded-md transition-colors" disabled={movingBulk}>
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="bg-muted/40 rounded-lg p-4 border border-border">
              <div className="text-xs font-medium text-muted-foreground mb-1">{t('wms_origin')}</div>
              <div className="font-mono font-semibold text-lg">{moveBulk.from.name}</div>
              <div className="text-xs text-muted-foreground mt-1">
                {moveBulk.from.inventory_summary?.skus_count || 0} SKUs · {(moveBulk.from.inventory_summary?.total_units || 0).toLocaleString()} {t('wms_units_lc')}
              </div>
            </div>

            <div>
              <label className="text-xs font-medium text-muted-foreground mb-1 block">{t('wms_dest_loc')}</label>
              <input
                value={moveBulk.to}
                onChange={e => setMoveBulk(m => ({ ...m, to: e.target.value.toUpperCase() }))}
                placeholder={t('wms_dest_example')}
                className={`${cls.input} font-mono`}
                data-testid="bulk-move-dst"
                autoFocus
              />
              <p className="text-xs text-muted-foreground mt-2">
                {t('wms_bulk_move_hint')}
              </p>
            </div>

            <div className="flex gap-3">
              <Btn
                variant="primary"
                onClick={handleBulkMove}
                disabled={movingBulk || !moveBulk.to?.trim()}
                className="flex-1"
                data-testid="bulk-move-confirm"
              >
                {movingBulk ? <Loader2 className="w-4 h-4 animate-spin" /> : <ArrowRightLeft className="w-4 h-4" />}
                {t('wms_move')}
              </Btn>
              <Btn
                onClick={() => setMoveBulk(null)}
                disabled={movingBulk}
                className="flex-1"
              >
                {t('cancel')}
              </Btn>
            </div>
          </div>
        </div>
      )}

      {editingLoc && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm animate-in fade-in duration-200">
          <div className="w-full max-w-md p-6 bg-card border border-border rounded-lg shadow-xl space-y-6 mx-4">
            <div>
              <h3 className="text-lg font-semibold">{t('wms_edit_loc')}</h3>
              <p className="text-sm text-muted-foreground mt-0.5">{t('wms_edit_loc_hint')}</p>
            </div>

            <div className="space-y-4">
              <div className="space-y-1">
                <label className="text-xs font-medium text-muted-foreground block">{t('wms_loc_name_label')}</label>
                <input
                  value={editingLoc.name}
                  onChange={e => setEditingLoc(p => ({ ...p, name: e.target.value.toUpperCase() }))}
                  className={`${cls.input} font-mono`}
                />
              </div>

              <div className="space-y-1">
                <label className="text-xs font-medium text-muted-foreground block">{t('wms_zone_aisle')}</label>
                <input
                  value={editingLoc.zone}
                  onChange={e => setEditingLoc(p => ({ ...p, zone: e.target.value.toUpperCase() }))}
                  className={cls.input}
                />
              </div>
            </div>

            <div className="flex gap-3">
              <Btn
                variant="primary"
                onClick={handleUpdateLoc}
                disabled={loading || !editingLoc.name}
                className="flex-1"
              >
                {loading ? <Loader2 className="w-4 h-4 animate-spin mx-auto" /> : t('wms_save_changes')}
              </Btn>
              <Btn
                onClick={() => setEditingLoc(null)}
                className="flex-1"
              >
                {t('cancel')}
              </Btn>
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
            className="bg-card border border-border rounded-lg w-full max-w-5xl max-h-[90vh] flex flex-col shadow-xl animate-in zoom-in-95 duration-150"
          >
            <div className="flex items-center justify-between p-5 border-b border-border/20">
              <div className="min-w-0">
                <h3 className="font-mono font-semibold text-lg">{detailLoc.name}</h3>
                <p className="text-xs text-muted-foreground">
                  {t('wms_zone')} {detailLoc.zone || t('wms_no_zone')}
                  {detailLoc.inventory_summary && (
                    <> · {detailLoc.inventory_summary.skus_count || 0} SKUs · {(detailLoc.inventory_summary.total_units || 0).toLocaleString()} {t('wms_pcs')}</>
                  )}
                </p>
              </div>
              <button
                onClick={() => setDetailLoc(null)}
                className="p-2 hover:bg-muted rounded-md transition-colors flex-shrink-0"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="flex-1 overflow-auto custom-scrollbar p-5">
              {detailLoading ? (
                <div className="flex flex-col items-center justify-center py-20">
                  <Loader2 className="w-8 h-8 animate-spin text-muted-foreground" />
                  <span className="text-sm text-muted-foreground mt-3">{t('wms_loading_content')}</span>
                </div>
              ) : detailItems.length === 0 ? (
                <div className="text-center py-16 text-sm text-muted-foreground">
                  {t('wms_loc_no_content')}
                </div>
              ) : (
                <div className="border border-border rounded-lg bg-card overflow-hidden">
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead className="bg-muted/50 sticky top-0 border-b border-border">
                        <tr>
                          <th className="px-3 py-2.5 text-left text-xs font-semibold text-muted-foreground w-8"></th>
                          <th className="px-3 py-2.5 text-left text-xs font-semibold text-muted-foreground">{t('wms_label_customer')}</th>
                          <th className="px-3 py-2.5 text-left text-xs font-semibold text-muted-foreground">Style</th>
                          <th className="px-3 py-2.5 text-left text-xs font-semibold text-muted-foreground">SKU</th>
                          <th className="px-3 py-2.5 text-left text-xs font-semibold text-muted-foreground">{t('wms_color_size_col')}</th>
                          <th className="px-3 py-2.5 text-left text-xs font-semibold text-muted-foreground">{t('description')}</th>
                          <th className="px-3 py-2.5 text-left text-xs font-semibold text-muted-foreground">{t('wms_country_col')}</th>
                          <th className="px-3 py-2.5 text-left text-xs font-semibold text-muted-foreground">Fabric</th>
                          <th className="px-3 py-2.5 text-right text-xs font-semibold text-muted-foreground">{t('wms_boxes')}</th>
                          <th className="px-3 py-2.5 text-right text-xs font-semibold text-muted-foreground">{t('wms_on_hand')}</th>
                          <th className="px-3 py-2.5 text-right text-xs font-semibold text-muted-foreground">{t('wms_available_col')}</th>
                          {canManageLocations && <th className="px-3 py-2.5 text-right text-xs font-semibold text-muted-foreground w-10">{t('wms_action_col')}</th>}
                        </tr>
                      </thead>
                      <tbody>
                        {detailItems.filter(it => showZeroRows
                            || (it.on_hand ?? it.units_on_hand ?? 0) > 0
                            || (it.allocated ?? it.units_allocated ?? 0) > 0
                            || (it.total_boxes ?? 0) > 0).map((it, i) => {
                          const isOpen = openDrawers.has(it.inventory_id);
                          const hasBoxes = isOpen; // legacy alias used below for hover/highlight
                          const canExpand = !!it.inventory_id && (it.total_boxes || 0) > 0;
                          const onHand = it.on_hand ?? it.units_on_hand ?? 0;
                          const allocated = it.allocated ?? it.units_allocated ?? 0;
                          const available = it.available ?? (onHand - allocated);
                          return (
                            <React.Fragment key={it.inventory_id || `${it.sku}-${it.color}-${it.size}-${i}`}>
                              <tr
                                onClick={() => canExpand && toggleBoxes(it)}
                                className={`border-b border-border/60 transition-colors ${canExpand ? 'cursor-pointer hover:bg-muted/40' : ''} ${hasBoxes ? 'bg-muted/40' : ''}`}
                              >
                                <td className="px-3 py-2.5 text-center text-muted-foreground">
                                  {canExpand && (
                                    <ChevronRight className={`w-3.5 h-3.5 transition-transform ${hasBoxes ? 'rotate-90 text-primary' : ''}`} />
                                  )}
                                </td>
                                <td className="px-3 py-2.5 text-xs truncate max-w-[140px]" title={it.customer}>{it.customer || '—'}</td>
                                <td className="px-3 py-2.5 font-mono text-xs font-medium text-foreground truncate max-w-[110px]" title={it.style}>
                                  {it.style || '—'}
                                </td>
                                <td className="px-3 py-2.5 font-mono text-xs text-muted-foreground truncate max-w-[170px]" title={it.sku}>
                                  {it.sku || '—'}
                                </td>
                                <td className="px-3 py-2.5 font-mono text-xs">
                                  <span className="text-foreground">{it.color || '—'}</span>
                                  <span className="mx-1 opacity-20">·</span>
                                  <span className="text-foreground">{it.size || '—'}</span>
                                </td>
                                <td className="px-3 py-2.5 text-xs text-muted-foreground truncate max-w-[200px]" title={it.description}>{it.description || '—'}</td>
                                <td className="px-3 py-2.5 font-mono text-xs text-muted-foreground truncate max-w-[110px]" title={it.country_of_origin}>{it.country_of_origin || '—'}</td>
                                <td className="px-3 py-2.5 text-xs text-muted-foreground truncate max-w-[140px]" title={it.fabric_content}>{it.fabric_content || '—'}</td>
                                <td className="px-3 py-2.5 text-right tabular-nums font-medium">
                                  <span className={hasBoxes ? 'text-primary' : ''}>{(it.total_boxes || 0).toLocaleString()}</span>
                                </td>
                                <td className="px-3 py-2.5 text-right tabular-nums font-medium">{onHand.toLocaleString()}</td>
                                <td className="px-3 py-2.5 text-right tabular-nums font-semibold">{available.toLocaleString()}</td>
                                {canManageLocations && (
                                  <td className="px-3 py-2.5 text-right whitespace-nowrap">
                                    <div className="flex items-center justify-end gap-1.5">
                                      {canExpand && (
                                        <button
                                          type="button"
                                          onClick={(e) => { e.stopPropagation(); startLineMove(it); }}
                                          className="p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
                                          title={t('wms_move_line_title')}
                                        >
                                          <ArrowRightLeft className="w-3.5 h-3.5" />
                                        </button>
                                      )}
                                      {canManageLocations && (
                                        <button
                                          type="button"
                                          onClick={(e) => { e.stopPropagation(); deleteInvLine(it); }}
                                          className="p-1.5 rounded-md text-muted-foreground hover:text-red-600 dark:hover:text-red-400 hover:bg-red-50 dark:hover:bg-red-500/10 transition-colors"
                                          title={t('wms_delete_line_title')}
                                        >
                                          <Trash2 className="w-3.5 h-3.5" />
                                        </button>
                                      )}
                                    </div>
                                  </td>
                                )}
                              </tr>

                              {relocatingLineId === it.inventory_id && (
                                <tr className="bg-amber-50 dark:bg-amber-500/10 border-b border-amber-200/70 dark:border-amber-500/25">
                                  <td colSpan={canManageLocations ? 12 : 11} className="py-2.5 px-4">
                                    <div className="flex items-center gap-2 flex-wrap">
                                      <span className="text-xs font-medium text-amber-700 dark:text-amber-300 whitespace-nowrap">
                                        {t('wms_move')} {it.style}{it.color ? `-${it.color}` : ''}{it.size ? `-${it.size}` : ''} →
                                      </span>
                                      <div className="relative">
                                        <input
                                          autoFocus
                                          value={lineDst}
                                          onChange={(e) => { setLineDst(e.target.value.toUpperCase()); setLineDrop(true); }}
                                          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); confirmLineMove(it); } if (e.key === 'Escape') cancelLineMove(); }}
                                          placeholder={t('wms_dest_loc_ph')}
                                          className="w-60 px-3 py-1.5 bg-card border border-input rounded-md text-sm font-mono focus:outline-none focus:ring-2 focus:ring-ring/25 focus:border-ring"
                                        />
                                        {lineDrop && (() => {
                                          const q = (lineDst || '').trim().toUpperCase();
                                          const matches = (q ? activeLocations.filter(l => (l.name || '').toUpperCase().includes(q)) : activeLocations).slice(0, 30);
                                          return matches.length ? (
                                            <div className="absolute z-50 mt-1 w-60 max-h-56 overflow-auto bg-card border border-border rounded-lg shadow-xl">
                                              {matches.map(l => (
                                                <button
                                                  key={l.name}
                                                  type="button"
                                                  onMouseDown={(e) => { e.preventDefault(); setLineDst((l.name || '').toUpperCase()); setLineDrop(false); }}
                                                  className="w-full text-left px-3 py-1.5 text-xs font-mono hover:bg-muted"
                                                >
                                                  {l.name}{l.zone ? <span className="text-muted-foreground"> ({l.zone})</span> : ''}
                                                </button>
                                              ))}
                                            </div>
                                          ) : null;
                                        })()}
                                      </div>
                                      <Btn
                                        type="button"
                                        variant="primary"
                                        disabled={lineSaving || !lineDst.trim()}
                                        onClick={() => confirmLineMove(it)}
                                      >
                                        {lineSaving ? <Loader2 className="w-3 h-3 animate-spin" /> : <ArrowRightLeft className="w-3 h-3" />} {t('wms_move')}
                                      </Btn>
                                      <Btn
                                        type="button"
                                        disabled={lineSaving}
                                        onClick={cancelLineMove}
                                      >
                                        {t('cancel')}
                                      </Btn>
                                    </div>
                                  </td>
                                </tr>
                              )}

                              {/* LPN drawer expands below the row when clicked */}
                              {hasBoxes && (
                                <tr>
                                  <td colSpan={canManageLocations ? 12 : 11} className="p-0 border-b border-border/20">
                                    <div className="bg-muted/30 px-4 py-3">
                                      <div className="flex items-center gap-2 mb-2">
                                        <div className="px-2 py-0.5 bg-muted text-foreground/70 border border-border rounded-md text-xs font-medium flex items-center gap-1.5">
                                          <Box className="w-3 h-3" />
                                          LPNs · {(boxesByInv[it.inventory_id]?.boxes || []).length}
                                        </div>
                                        <span className="text-xs font-mono text-muted-foreground">
                                          {it.style}{it.color ? ` · ${it.color}` : ''}{it.size ? ` · ${it.size}` : ''}
                                        </span>
                                      </div>
                                      <div className="border border-border rounded-lg bg-card overflow-hidden">
                          {boxesByInv[it.inventory_id].loading ? (
                            <div className="flex items-center justify-center py-4 gap-2 text-muted-foreground">
                              <Loader2 className="w-4 h-4 animate-spin" />
                              <span className="text-xs font-medium">{t('wms_loading_lpns')}</span>
                            </div>
                          ) : boxesByInv[it.inventory_id].boxes.length === 0 ? (
                            <div className="text-center text-sm text-muted-foreground py-6">{t('wms_no_lpns')}</div>
                          ) : (
                            <table className="w-full text-sm">
                              <thead className="bg-muted/50 border-b border-border">
                                <tr>
                                  <th className="px-3 py-2 text-left text-xs font-semibold text-muted-foreground">LPN</th>
                                  <th className="px-3 py-2 text-right text-xs font-semibold text-muted-foreground">{t('wms_label_units')}</th>
                                  <th className="px-3 py-2 text-left text-xs font-semibold text-muted-foreground">{t('status')}</th>
                                  <th className="px-3 py-2 text-right text-xs font-semibold text-muted-foreground">{t('wms_action_col')}</th>
                                </tr>
                              </thead>
                              <tbody>
                                {(showEmptyBoxes.has(it.inventory_id)
                                    ? boxesByInv[it.inventory_id].boxes
                                    : boxesByInv[it.inventory_id].boxes.filter(b => (b.units ?? b.qty ?? 0) > 0)
                                  ).map((b, bi) => {
                                  const isRelocating = relocatingBoxId === b.box_id;
                                  if (isRelocating) {
                                    const q = (relocateDst || '').trim().toUpperCase();
                                    const matches = (q
                                      ? activeLocations.filter(l => (l.name || '').toUpperCase().includes(q))
                                      : activeLocations
                                    ).slice(0, 30);
                                    return (
                                      <tr key={b.box_id || bi} className="bg-amber-50 dark:bg-amber-500/10 border-b border-amber-200/70 dark:border-amber-500/25">
                                        <td colSpan={4} className="py-2 px-2">
                                          <div className="flex items-center gap-2 flex-wrap">
                                            <span className="font-mono font-medium text-amber-700 dark:text-amber-300 text-xs whitespace-nowrap">
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
                                                placeholder={t('wms_dest_loc')}
                                                className="w-full px-2 py-1 bg-card border border-input rounded-md text-xs font-mono focus:outline-none focus:ring-2 focus:ring-ring/25 focus:border-ring"
                                              />
                                              {showLocDrop && matches.length > 0 && (
                                                <div className="absolute z-[90] mt-1 w-full max-h-72 overflow-y-auto bg-popover border border-border rounded-md shadow-xl">
                                                  {matches.map(l => (
                                                    <button
                                                      key={l.location_id || l.name}
                                                      type="button"
                                                      onMouseDown={(e) => {
                                                        e.preventDefault();
                                                        setRelocateDst(l.name);
                                                        setShowLocDrop(false);
                                                      }}
                                                      className="w-full text-left px-3 py-1.5 text-xs font-mono hover:bg-muted flex items-center justify-between border-b border-border/60 last:border-0"
                                                    >
                                                      <span className="font-medium">{l.name}</span>
                                                      {l.zone && <span className="text-xs text-muted-foreground">{l.zone}</span>}
                                                    </button>
                                                  ))}
                                                </div>
                                              )}
                                            </div>
                                            <button
                                              type="button"
                                              onClick={() => confirmRelocate(b, it.inventory_id)}
                                              disabled={relocateSaving || !relocateDst.trim()}
                                              className="px-2.5 py-1 bg-primary text-primary-foreground hover:opacity-90 rounded-md text-xs font-medium disabled:opacity-50 flex items-center gap-1 transition-colors"
                                            >
                                              {relocateSaving ? <Loader2 className="w-3 h-3 animate-spin" /> : 'OK'}
                                            </button>
                                            <button
                                              type="button"
                                              onClick={cancelRelocate}
                                              disabled={relocateSaving}
                                              className="px-2 py-1 text-xs font-medium text-muted-foreground hover:text-foreground"
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
                                    <tr key={b.box_id || bi} className={`border-b border-border/60 group/lpn transition-colors ${isHighlighted ? 'bg-amber-50 dark:bg-amber-500/15' : 'hover:bg-muted/40'}`}>
                                      <td className="px-3 py-2 font-mono font-medium text-xs">
                                        {isHighlighted && <Box className="w-3 h-3 text-amber-600 dark:text-amber-400 inline mr-1" />}
                                        {b.box_id || '—'}
                                      </td>
                                      <td className="px-3 py-2 text-right tabular-nums font-semibold">{(b.units || b.qty || 0).toLocaleString()}</td>
                                      <td className="px-3 py-2 text-xs text-muted-foreground">{b.state || b.status || '—'}</td>
                                      <td className="px-3 py-2 text-right">
                                        <div className="inline-flex items-center gap-1.5">
                                          <button
                                            type="button"
                                            onClick={() => window.open(`${API}/labels/box/${encodeURIComponent(b.box_id)}`, '_blank')}
                                            className="transition-colors inline-flex items-center gap-1 px-2 py-1 text-xs font-medium text-muted-foreground hover:text-foreground bg-card hover:bg-muted rounded-md border border-border"
                                            title={t('wms_print_box_label_title', { box: b.box_id || t('wms_this_box') })}
                                          >
                                            <Printer className="w-2.5 h-2.5" /> {t('wms_label_btn')}
                                          </button>
                                          <button
                                            type="button"
                                            onClick={() => startRelocate(b.box_id)}
                                            className="transition-colors inline-flex items-center gap-1 px-2 py-1 text-xs font-medium text-muted-foreground hover:text-foreground bg-card hover:bg-muted rounded-md border border-border"
                                            title={t('wms_move_box_title', { box: b.box_id || t('wms_this_box') })}
                                          >
                                            <ArrowRightLeft className="w-2.5 h-2.5" /> {t('wms_move')}
                                          </button>
                                          {canManageLocations && (
                                            <button
                                              type="button"
                                              onClick={() => deleteBox(b)}
                                              className="transition-colors inline-flex items-center gap-1 px-2 py-1 text-xs font-medium text-red-600 dark:text-red-400 bg-card hover:bg-red-50 dark:hover:bg-red-500/10 rounded-md border border-border"
                                              title={t('wms_delete_box_title', { box: b.box_id || t('wms_this_box') })}
                                            >
                                              <Trash2 className="w-2.5 h-2.5" /> {t('wms_delete_short')}
                                            </button>
                                          )}
                                        </div>
                                      </td>
                                    </tr>
                                  );
                                })}
                              {(() => {
                                  const vacias = boxesByInv[it.inventory_id].boxes.filter(b => (b.units ?? b.qty ?? 0) <= 0).length;
                                  if (!vacias) return null;
                                  const abierto = showEmptyBoxes.has(it.inventory_id);
                                  return (
                                    <tr>
                                      <td colSpan={4} className="p-0">
                                        <button
                                          onClick={() => setShowEmptyBoxes(prev => {
                                            const n = new Set(prev);
                                            if (n.has(it.inventory_id)) n.delete(it.inventory_id); else n.add(it.inventory_id);
                                            return n;
                                          })}
                                          className="w-full py-1.5 text-xs font-medium text-muted-foreground hover:text-foreground bg-muted/40 transition-colors"
                                          title={t('wms_empty_boxes_title')}
                                        >
                                          {abierto ? t('wms_hide_empty_boxes') : (vacias === 1 ? t('wms_show_empty_box_one') : t('wms_show_empty_boxes', { n: vacias }))}
                                        </button>
                                      </td>
                                    </tr>
                                  );
                                })()}
                              </tbody>
                            </table>
                          )}
                        </div>
                                    </div>
                                  </td>
                                </tr>
                              )}
                            </React.Fragment>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </div>

            <div className="flex items-center justify-between gap-3 p-5 border-t border-border/20">
              <span className="text-xs text-muted-foreground">
                {(() => {
                  const muertos = detailItems.filter(it => !((it.on_hand ?? it.units_on_hand ?? 0) > 0
                    || (it.allocated ?? it.units_allocated ?? 0) > 0 || (it.total_boxes ?? 0) > 0)).length;
                  const vivos = detailItems.length - muertos;
                  return (<>
                    {vivos === 1 ? t('wms_line_in_loc_one') : t('wms_lines_in_loc', { n: vivos })}
                    {muertos > 0 && (
                      <button onClick={() => setShowZeroRows(v => !v)}
                        className="ml-2 underline decoration-dotted text-muted-foreground hover:text-foreground"
                        title={t('wms_zero_rows_title')}>
                        {showZeroRows ? t('wms_hide_zero_rows', { n: muertos }) : t('wms_show_zero_rows', { n: muertos })}
                      </button>
                    )}
                  </>);
                })()}
              </span>
              <div className="flex items-center gap-2">
                {detailItems.length > 0 && (
                  <Btn
                    onClick={() => window.open(`${API}/labels/location?location=${encodeURIComponent(detailLoc.name)}`, '_blank')}
                    title={t('wms_print_loc_labels_title')}
                  >
                    <Printer className="w-3.5 h-3.5" /> {t('wms_print_labels_btn')}
                  </Btn>
                )}
                {canManageLocations && detailItems.length > 0 && (
                  <Btn
                    variant="danger"
                    onClick={clearLocation}
                    disabled={clearingLoc}
                    title={t('wms_clear_loc_title')}
                  >
                    {clearingLoc ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Trash2 className="w-3.5 h-3.5" />}
                    {t('wms_clear_loc')}
                  </Btn>
                )}
                <Btn onClick={() => setDetailLoc(null)}>
                  {t('close')}
                </Btn>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
