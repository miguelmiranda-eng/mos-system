import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { toast } from "sonner";
import {
  Loader2, Package, Search, X, MapPin, ChevronRight, CheckSquare, Square, ArrowRightLeft, Truck, Edit3, Save,
} from "lucide-react";
import { fetcher, poster, putter, logLoadError } from "./lib";

const TRANSIT_LEGACY = "UBICACION TEMPORAL";

/**
 * Putaway 2.0 — manages the boxes parked at the 5 transit carts + the legacy
 * UBICACION TEMPORAL.
 *
 * Receiving operators land boxes here via the "Recibir a Carro" dropdown.
 * From this screen, an admin / warehouse lead can:
 *   - Filter by cart (tab).
 *   - Filter / search the pending pile.
 *   - Select boxes (one or many).
 *   - Type the target location (typeahead against active locations).
 *   - Move them. The backend re-balances inventory and logs a movement.
 */
export const TransitModule = () => {
  const [boxes, setBoxes] = useState([]);
  const [transitName, setTransitName] = useState(TRANSIT_LEGACY);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState("");
  const [customerFilter, setCustomerFilter] = useState("");
  // Cart tab — "" = all carts + legacy. Otherwise the exact cart name.
  const [activeCart, setActiveCart] = useState("");
  // [{name, location_id, boxes}] — loaded from /transit/info, used for tab counts.
  const [cartInfo, setCartInfo] = useState([]);
  const [legacyCount, setLegacyCount] = useState(0);
  // Selection state — keyed by box_id so it survives reorder/refresh.
  const [selected, setSelected] = useState(() => new Set());
  // Move-to flow
  const [destination, setDestination] = useState("");
  const [moving, setMoving] = useState(false);
  const [locOptions, setLocOptions] = useState([]); // [{name, zone}]
  const [showLocDrop, setShowLocDrop] = useState(false);
  const destRef = useRef(null);
  const destInputRef = useRef(null);
  // When the operator selects the first box (0 -> >0), jump the cursor straight
  // to the destination-location field so they can type/scan it immediately.
  const prevSelSizeRef = useRef(0);
  useEffect(() => {
    if (prevSelSizeRef.current === 0 && selected.size > 0) {
      requestAnimationFrame(() => destInputRef.current?.focus());
    }
    prevSelSizeRef.current = selected.size;
  }, [selected]);
  // Edit-box modal state.
  const [editBox, setEditBox] = useState(null); // box doc being edited, or null
  const [editDraft, setEditDraft] = useState({});
  const [editSaving, setEditSaving] = useState(false);

  const loadInfo = useCallback(() => {
    fetcher("/transit/info")
      .then(data => {
        setCartInfo(Array.isArray(data?.carts) ? data.carts : []);
        setLegacyCount(Number(data?.legacy_boxes) || 0);
        if (data?.name) setTransitName(data.name);
      })
      .catch(logLoadError("transit info"));
  }, []);

  useEffect(() => { loadInfo(); }, [loadInfo]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (customerFilter.trim()) params.set("customer", customerFilter.trim());
      if (search.trim()) params.set("search", search.trim());
      if (activeCart) params.set("cart", activeCart);
      const data = await fetcher(`/transit/boxes?${params.toString()}`);
      setTransitName(data.transit_location || transitName);
      setBoxes(Array.isArray(data.boxes) ? data.boxes : []);
    } catch (err) {
      logLoadError("transit boxes")(err);
      toast.error("No se pudieron cargar las cajas de Putaway 2.0");
    } finally { setLoading(false); }
  }, [customerFilter, search, activeCart, transitName]);

  useEffect(() => { load(); }, [load]);

  // Active locations for the typeahead — `summary=false` skips the expensive
  // inventory aggregation so the dropdown is snappy. We exclude every system
  // transit slot (the 5 carts + legacy temporal) because you can't relocate
  // FROM a cart TO another cart.
  useEffect(() => {
    let cancelled = false;
    const excluded = new Set(
      [TRANSIT_LEGACY, ...(cartInfo.map(c => c.name) || [])].map(n => (n || "").toUpperCase())
    );
    fetcher("/locations?summary=false&limit=20000")
      .then(rows => {
        if (cancelled) return;
        const filtered = (Array.isArray(rows) ? rows : [])
          .filter(l => l.active !== false && !excluded.has((l.name || "").toUpperCase()));
        setLocOptions(filtered);
      })
      .catch(logLoadError("locations for transit destination"));
    return () => { cancelled = true; };
  }, [cartInfo]);

  // Close destination dropdown on outside click.
  useEffect(() => {
    if (!showLocDrop) return;
    const onDoc = (e) => {
      if (!destRef.current?.contains(e.target)) setShowLocDrop(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [showLocDrop]);

  const filteredLocations = useMemo(() => {
    const q = (destination || "").trim().toUpperCase();
    if (!q) return locOptions.slice(0, 50);
    return locOptions.filter(l => (l.name || "").toUpperCase().includes(q)).slice(0, 50);
  }, [destination, locOptions]);

  const toggleOne = useCallback((boxId) => {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(boxId)) next.delete(boxId); else next.add(boxId);
      return next;
    });
  }, []);

  const toggleAll = useCallback(() => {
    setSelected(prev => {
      if (prev.size === boxes.length && boxes.length > 0) return new Set();
      return new Set(boxes.map(b => b.box_id));
    });
  }, [boxes]);

  const totalSelectedUnits = useMemo(() => {
    return boxes.reduce((s, b) => selected.has(b.box_id) ? s + (Number(b.units) || Number(b.qty) || 0) : s, 0);
  }, [boxes, selected]);

  const openEdit = (box) => {
    setEditBox(box);
    setEditDraft({
      customer: box.customer || '',
      manufacturer: box.manufacturer || '',
      description: box.description || '',
      country_of_origin: box.country_of_origin || '',
      fabric_content: box.fabric_content || '',
      lot_number: box.lot_number || '',
      units: String(box.units ?? box.qty ?? 0),
    });
  };
  const closeEdit = () => { setEditBox(null); setEditDraft({}); };
  const setDraft = (k, v) => setEditDraft(p => ({ ...p, [k]: v }));

  const handleSaveEdit = async () => {
    if (!editBox) return;
    const units = parseInt(editDraft.units);
    if (Number.isNaN(units) || units < 0) {
      toast.error('Unidades debe ser un entero >= 0');
      return;
    }
    setEditSaving(true);
    try {
      const res = await putter(`/boxes/${encodeURIComponent(editBox.box_id)}`, {
        customer: editDraft.customer,
        manufacturer: editDraft.manufacturer,
        description: editDraft.description,
        country_of_origin: editDraft.country_of_origin,
        fabric_content: editDraft.fabric_content,
        lot_number: editDraft.lot_number,
        units,
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        toast.error(err.detail || 'No se pudo guardar');
        return;
      }
      toast.success(`Caja ${editBox.box_id} actualizada`);
      closeEdit();
      load();
      loadInfo();
    } catch {
      toast.error('Error de conexión');
    } finally { setEditSaving(false); }
  };

  const handleRelocate = async () => {
    const dst = (destination || "").trim().toUpperCase();
    if (!dst) { toast.error("Escribe la ubicación destino"); return; }
    if (selected.size === 0) { toast.error("Selecciona al menos una caja"); return; }
    // Validate destination exists in active list (avoid a backend 404 surprise).
    const exists = locOptions.some(l => (l.name || "").toUpperCase() === dst);
    if (!exists) { toast.error(`'${dst}' no existe en las ubicaciones activas`); return; }
    setMoving(true);
    try {
      const res = await poster("/transit/relocate", { box_ids: Array.from(selected), to: dst });
      if (res.ok) {
        const data = await res.json();
        toast.success(data.message || "Cajas reubicadas");
        setSelected(new Set());
        setDestination("");
        load();
        loadInfo();
      } else {
        const err = await res.json().catch(() => ({}));
        toast.error(err.detail || "Error al reubicar");
      }
    } catch (err) {
      logLoadError("transit relocate")(err);
      toast.error("Error de conexión");
    } finally { setMoving(false); }
  };

  const allSelected = selected.size > 0 && selected.size === boxes.length;
  const someSelected = selected.size > 0 && !allSelected;

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-2xl bg-amber-500/15 border border-amber-500/30 flex items-center justify-center">
            <Truck className="w-5 h-5 text-amber-500" />
          </div>
          <div>
            <h2 className="font-black uppercase tracking-widest text-foreground">Putaway 2.0</h2>
            <p className="text-[11px] text-muted-foreground">
              Carros de tránsito — selecciona un carro para asignar ubicación física a sus cajas
            </p>
          </div>
        </div>
        <div className="text-[11px] font-mono font-bold text-muted-foreground">
          {boxes.length} cajas · {boxes.reduce((s, b) => s + (Number(b.units) || Number(b.qty) || 0), 0).toLocaleString()} unidades
        </div>
      </div>

      {/* Cart tabs */}
      <div className="flex flex-wrap items-center gap-2">
        <button
          onClick={() => setActiveCart("")}
          className={`px-3 py-1.5 rounded-lg text-[11px] font-black uppercase tracking-widest border transition-all flex items-center gap-1.5 ${
            activeCart === ""
              ? "bg-amber-500 text-white border-amber-500"
              : "bg-card/40 text-muted-foreground border-border/40 hover:border-amber-500/40 hover:text-foreground"
          }`}
        >
          Todos
          <span className="text-[10px] opacity-80 font-mono">
            {(cartInfo.reduce((s, c) => s + (c.boxes || 0), 0) + legacyCount).toLocaleString()}
          </span>
        </button>
        {cartInfo.map(c => (
          <button
            key={c.name}
            onClick={() => setActiveCart(c.name)}
            className={`px-3 py-1.5 rounded-lg text-[11px] font-black uppercase tracking-widest border transition-all flex items-center gap-1.5 ${
              activeCart === c.name
                ? "bg-amber-500 text-white border-amber-500"
                : "bg-card/40 text-muted-foreground border-border/40 hover:border-amber-500/40 hover:text-foreground"
            }`}
            data-testid={`putaway2-tab-${c.name.replace(/\s+/g, '-').toLowerCase()}`}
          >
            <Truck className="w-3.5 h-3.5" />
            {c.name}
            <span className="text-[10px] opacity-80 font-mono">{(c.boxes || 0).toLocaleString()}</span>
          </button>
        ))}
        {legacyCount > 0 && (
          <button
            onClick={() => setActiveCart(TRANSIT_LEGACY)}
            className={`px-3 py-1.5 rounded-lg text-[11px] font-black uppercase tracking-widest border transition-all flex items-center gap-1.5 ${
              activeCart === TRANSIT_LEGACY
                ? "bg-amber-500 text-white border-amber-500"
                : "bg-card/40 text-muted-foreground border-amber-500/30 hover:border-amber-500/60 hover:text-foreground"
            }`}
            title="Cajas recibidas antes de los carros — siguen aquí hasta que las reubiques."
          >
            ⏸ Temporal (legacy)
            <span className="text-[10px] opacity-80 font-mono">{legacyCount.toLocaleString()}</span>
          </button>
        )}
      </div>

      {/* Filters */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <div className="relative">
          <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <input
            type="text"
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Buscar LPN / estilo / color / SKU / descripción…"
            className="w-full pl-9 pr-9 py-2 bg-background border border-border rounded-lg text-sm focus:outline-none focus:border-primary/40"
          />
          {search && (
            <button onClick={() => setSearch("")} className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground">
              <X className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
        <input
          type="text"
          value={customerFilter}
          onChange={e => setCustomerFilter(e.target.value)}
          placeholder="Filtrar por cliente…"
          className="w-full px-3 py-2 bg-background border border-border rounded-lg text-sm focus:outline-none focus:border-primary/40"
        />
      </div>

      {/* Action bar — only when something is selected */}
      {selected.size > 0 && (
        <div className="flex flex-wrap items-center gap-3 p-3 rounded-2xl bg-amber-500/10 border border-amber-500/30">
          <div className="text-[11px] font-bold text-amber-500 uppercase tracking-widest">
            {selected.size} seleccionadas · {totalSelectedUnits.toLocaleString()} unidades
          </div>
          <div className="flex-1 min-w-[240px] relative" ref={destRef}>
            <MapPin className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <input
              ref={destInputRef}
              type="text"
              value={destination}
              onChange={e => { setDestination(e.target.value.toUpperCase()); setShowLocDrop(true); }}
              onFocus={() => setShowLocDrop(true)}
              placeholder="Ubicación destino (ej. RP10-A26)"
              className="w-full pl-9 pr-3 py-2 bg-background border border-border rounded-lg text-sm font-mono focus:outline-none focus:border-amber-500/50"
            />
            {showLocDrop && filteredLocations.length > 0 && (
              <div className="absolute z-30 mt-1 w-full max-h-60 overflow-y-auto bg-popover border border-border rounded-lg shadow-xl">
                {filteredLocations.map(l => (
                  <button
                    key={l.location_id || l.name}
                    onClick={() => { setDestination(l.name); setShowLocDrop(false); }}
                    className="w-full text-left px-3 py-2 text-sm hover:bg-secondary flex items-center justify-between"
                  >
                    <span className="font-mono font-bold">{l.name}</span>
                    {l.zone && <span className="text-[10px] uppercase tracking-widest text-muted-foreground">{l.zone}</span>}
                  </button>
                ))}
              </div>
            )}
          </div>
          <button
            onClick={handleRelocate}
            disabled={moving || !destination.trim()}
            className="px-4 py-2 bg-amber-500 hover:bg-amber-400 text-white rounded-lg text-xs font-black uppercase tracking-widest flex items-center gap-2 disabled:opacity-50"
          >
            {moving ? <Loader2 className="w-4 h-4 animate-spin" /> : <ArrowRightLeft className="w-4 h-4" />}
            Mover seleccionadas
          </button>
          <button
            onClick={() => setSelected(new Set())}
            disabled={moving}
            className="px-3 py-2 text-xs font-bold uppercase tracking-widest text-muted-foreground hover:text-foreground"
          >
            Limpiar
          </button>
        </div>
      )}

      {/* Table */}
      <div className="border border-border/40 rounded-2xl bg-card/40 overflow-hidden">
        <div className="overflow-x-auto max-h-[600px]">
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-secondary/80 backdrop-blur-md border-b border-border/40">
              <tr>
                <th className="w-10 p-3">
                  <button onClick={toggleAll} className="text-muted-foreground hover:text-foreground" title="Seleccionar todo">
                    {allSelected ? <CheckSquare className="w-4 h-4 text-amber-500" /> : someSelected ? <CheckSquare className="w-4 h-4 text-amber-500/50" /> : <Square className="w-4 h-4" />}
                  </button>
                </th>
                <th className="p-3 text-left text-[10px] font-black uppercase tracking-widest text-muted-foreground">LPN</th>
                {!activeCart && (
                  <th className="p-3 text-left text-[10px] font-black uppercase tracking-widest text-muted-foreground">Carro</th>
                )}
                <th className="p-3 text-left text-[10px] font-black uppercase tracking-widest text-muted-foreground">Cliente</th>
                <th className="p-3 text-left text-[10px] font-black uppercase tracking-widest text-muted-foreground">Estilo / SKU</th>
                <th className="p-3 text-left text-[10px] font-black uppercase tracking-widest text-muted-foreground">Color · Talla</th>
                <th className="p-3 text-right text-[10px] font-black uppercase tracking-widest text-muted-foreground">Unidades</th>
                <th className="p-3 text-left text-[10px] font-black uppercase tracking-widest text-muted-foreground">Recibida</th>
                <th className="p-3 w-10"></th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan={activeCart ? 8 : 9} className="py-16 text-center text-muted-foreground">
                    <Loader2 className="w-6 h-6 animate-spin mx-auto" />
                  </td>
                </tr>
              ) : boxes.length === 0 ? (
                <tr>
                  <td colSpan={activeCart ? 8 : 9} className="py-20 text-center">
                    <Truck className="w-12 h-12 mx-auto opacity-20 mb-2 text-amber-500" />
                    <p className="text-sm font-bold uppercase tracking-widest text-muted-foreground">
                      {activeCart ? `${activeCart} vacío` : "Sin cajas en Putaway 2.0"}
                    </p>
                    <p className="text-xs text-muted-foreground/70 mt-2 max-w-md mx-auto">
                      Cuando recibas mercancía con el botón "Recibir a Carro" en Receiving, las cajas aparecerán aquí esperando una ubicación física.
                    </p>
                  </td>
                </tr>
              ) : (
                boxes.map(b => {
                  const isSel = selected.has(b.box_id);
                  return (
                    <tr
                      key={b.box_id}
                      onClick={() => toggleOne(b.box_id)}
                      className={`border-b border-border/10 cursor-pointer transition-colors ${isSel ? 'bg-amber-500/10 hover:bg-amber-500/20' : 'hover:bg-primary/5'}`}
                    >
                      <td className="p-3" onClick={e => { e.stopPropagation(); toggleOne(b.box_id); }}>
                        {isSel ? <CheckSquare className="w-4 h-4 text-amber-500" /> : <Square className="w-4 h-4 text-muted-foreground" />}
                      </td>
                      <td className="p-3 font-mono font-bold text-primary text-[11px]">{b.box_id}</td>
                      {!activeCart && (
                        <td className="p-3">
                          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-black uppercase tracking-widest text-amber-500 bg-amber-500/10 border border-amber-500/30 font-mono">
                            {b.location === TRANSIT_LEGACY ? "⏸" : <Truck className="w-3 h-3" />}
                            {b.location || '—'}
                          </span>
                        </td>
                      )}
                      <td className="p-3 text-[11px] font-bold truncate max-w-[160px]" title={b.customer}>{b.customer || '—'}</td>
                      <td className="p-3 font-mono text-[11px] font-bold">
                        <div className="text-primary">{b.style || '—'}</div>
                        <div className="text-muted-foreground text-[10px] truncate max-w-[160px]" title={b.description}>{b.description || ''}</div>
                      </td>
                      <td className="p-3 font-mono text-[11px] font-bold">
                        <span className="text-foreground">{b.color || '—'}</span>
                        <ChevronRight className="w-3 h-3 inline mx-1 opacity-30" />
                        <span className="text-primary">{b.size || '—'}</span>
                      </td>
                      <td className="p-3 text-right font-mono font-black text-emerald-500">{(b.units || b.qty || 0).toLocaleString()}</td>
                      <td className="p-3 font-mono text-[10px] text-muted-foreground">{(b.created_at || '').slice(0, 19).replace('T', ' ')}</td>
                      <td className="p-3" onClick={e => e.stopPropagation()}>
                        <button
                          onClick={() => openEdit(b)}
                          className="p-1.5 rounded text-muted-foreground hover:text-amber-500 hover:bg-amber-500/10 transition-all"
                          title="Editar caja"
                          data-testid={`transit-edit-${b.box_id}`}
                        >
                          <Edit3 className="w-3.5 h-3.5" />
                        </button>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Edit-box modal */}
      {editBox && (
        <div className="fixed inset-0 z-[80] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm animate-in fade-in duration-150">
          <div className="bg-card border border-border/50 rounded-3xl w-full max-w-2xl max-h-[85vh] flex flex-col shadow-2xl animate-in zoom-in-95 duration-150">
            <div className="flex items-center justify-between p-5 border-b border-border/20">
              <div className="flex items-center gap-3 min-w-0">
                <div className="w-10 h-10 rounded-2xl bg-amber-500/10 flex items-center justify-center">
                  <Edit3 className="w-5 h-5 text-amber-500" />
                </div>
                <div className="min-w-0">
                  <h3 className="font-black uppercase tracking-tighter text-sm">Editar caja</h3>
                  <p className="text-[11px] text-muted-foreground font-bold font-mono truncate">
                    {editBox.box_id} · {editBox.style} · {editBox.color} / {editBox.size}
                  </p>
                </div>
              </div>
              <button onClick={closeEdit} disabled={editSaving} className="p-2 hover:bg-secondary rounded-lg transition-all disabled:opacity-50">
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="flex-1 overflow-auto custom-scrollbar p-5 space-y-3">
              <p className="text-[10px] text-muted-foreground italic">
                Los campos <span className="font-mono font-bold">style / sku / color / size / ubicación</span> no se editan aquí: usa el botón "Mover" para relocate, o elimina y vuelve a recibir si cambia el producto.
              </p>

              <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
                <div>
                  <label className="text-[10px] font-black uppercase tracking-widest text-muted-foreground block mb-1">Cliente</label>
                  <input value={editDraft.customer} onChange={e => setDraft('customer', e.target.value)} className="w-full px-3 py-2 bg-background border border-border rounded text-sm" />
                </div>
                <div>
                  <label className="text-[10px] font-black uppercase tracking-widest text-muted-foreground block mb-1">Fabricante</label>
                  <input value={editDraft.manufacturer} onChange={e => setDraft('manufacturer', e.target.value)} className="w-full px-3 py-2 bg-background border border-border rounded text-sm" />
                </div>
                <div>
                  <label className="text-[10px] font-black uppercase tracking-widest text-muted-foreground block mb-1">Lote</label>
                  <input value={editDraft.lot_number} onChange={e => setDraft('lot_number', e.target.value)} className="w-full px-3 py-2 bg-background border border-border rounded text-sm font-mono" />
                </div>
              </div>

              <div>
                <label className="text-[10px] font-black uppercase tracking-widest text-muted-foreground block mb-1">Descripción</label>
                <input value={editDraft.description} onChange={e => setDraft('description', e.target.value)} className="w-full px-3 py-2 bg-background border border-border rounded text-sm" />
              </div>

              <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
                <div>
                  <label className="text-[10px] font-black uppercase tracking-widest text-muted-foreground block mb-1">País de origen</label>
                  <input value={editDraft.country_of_origin} onChange={e => setDraft('country_of_origin', e.target.value.toUpperCase())} className="w-full px-3 py-2 bg-background border border-border rounded text-sm font-mono" />
                </div>
                <div>
                  <label className="text-[10px] font-black uppercase tracking-widest text-muted-foreground block mb-1">Fabric / Contenido</label>
                  <input value={editDraft.fabric_content} onChange={e => setDraft('fabric_content', e.target.value)} className="w-full px-3 py-2 bg-background border border-border rounded text-sm" />
                </div>
                <div>
                  <label className="text-[10px] font-black uppercase tracking-widest text-amber-500 block mb-1">
                    Unidades <span title="Si cambias las unidades, el inventario se rebalancea automáticamente.">⚠</span>
                  </label>
                  <input
                    type="number"
                    min="0"
                    value={editDraft.units}
                    onChange={e => setDraft('units', e.target.value)}
                    className="w-full px-3 py-2 bg-background border border-amber-500/40 rounded text-sm font-mono font-black text-right"
                  />
                  <p className="text-[9px] text-muted-foreground mt-1">
                    Actual: {editBox.units ?? editBox.qty ?? 0}
                    {Number(editDraft.units) !== (editBox.units ?? editBox.qty ?? 0) && (
                      <span className="text-amber-500 font-bold ml-1">
                        → {editDraft.units} ({Number(editDraft.units) - (editBox.units ?? editBox.qty ?? 0) >= 0 ? '+' : ''}{Number(editDraft.units) - (editBox.units ?? editBox.qty ?? 0)})
                      </span>
                    )}
                  </p>
                </div>
              </div>
            </div>

            <div className="flex gap-2 p-5 border-t border-border/20">
              <button
                onClick={handleSaveEdit}
                disabled={editSaving}
                className="flex-1 px-4 py-2.5 bg-amber-500 hover:bg-amber-400 text-white rounded-xl text-sm font-black uppercase tracking-wider disabled:opacity-50 flex items-center justify-center gap-2"
                data-testid="transit-edit-save"
              >
                {editSaving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
                Guardar
              </button>
              <button
                onClick={closeEdit}
                disabled={editSaving}
                className="px-4 py-2.5 bg-secondary text-foreground rounded-xl text-sm font-bold uppercase disabled:opacity-50"
              >
                Cancelar
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
