import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { toast } from "sonner";
import {
  Loader2, Search, X, MapPin, ChevronRight, CheckSquare, Square, ArrowRightLeft, Truck, Edit3, Save,
  ScanLine, AlertTriangle, ClipboardCheck, CheckCircle2, Plus,
} from "lucide-react";
import { fetcher, poster, putter, logLoadError, cleanScan } from "./lib";
import { useAuth } from "../../App";

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
  const { user } = useAuth();
  const isAdmin = ['admin', 'supersu'].includes(user?.role);
  // Bulk cart creation (admin) — make N new "CARRO <n>" locations with a progress bar.
  const [showCreateCarts, setShowCreateCarts] = useState(false);
  const [cartQty, setCartQty] = useState(10);
  const [creating, setCreating] = useState(false);
  const [createDone, setCreateDone] = useState(0);
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
  // ── Putaway flow (location-first) ───────────────────────────────────────
  // Step 1: lock a destination location. Step 2: scan/select the boxes that go
  // there. "Terminar" raises a warning, then relocates the whole batch.
  const [destination, setDestination] = useState("");   // step-1 typeahead text
  const [lockedLocation, setLockedLocation] = useState(""); // confirmed destination
  const [boxScan, setBoxScan] = useState("");           // step-2 box scanner
  const [showWarning, setShowWarning] = useState(false);
  const [moving, setMoving] = useState(false);
  const [locOptions, setLocOptions] = useState([]); // [{name, zone}]
  const [showLocDrop, setShowLocDrop] = useState(false);
  const destRef = useRef(null);
  const destInputRef = useRef(null);
  const boxScanRef = useRef(null);
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

  // Create `cartQty` new carts, numbered after the highest existing CARRO.
  // Sequential so the progress bar advances per cart; dups are skipped.
  const handleCreateCarts = async () => {
    const qty = Math.max(1, Math.min(50, parseInt(cartQty) || 0));
    const maxNum = cartInfo.reduce((mx, c) => {
      const m = /CARRO\s+(\d+)/i.exec(c.name || "");
      return m ? Math.max(mx, parseInt(m[1], 10)) : mx;
    }, 0);
    setCreating(true);
    setCreateDone(0);
    let created = 0, skipped = 0;
    for (let i = 1; i <= qty; i++) {
      const name = `CARRO ${maxNum + i}`;
      try {
        const res = await poster('/locations', { name, zone: 'CARROS', type: 'transit' });
        if (res?.ok) created++; else skipped++;
      } catch { skipped++; }
      setCreateDone(i);
    }
    setCreating(false);
    toast.success(`Carros creados: ${created}${skipped ? ` · ${skipped} omitidos (ya existían)` : ''}`);
    setShowCreateCarts(false);
    loadInfo();
  };

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
  // FROM a cart TO another cart. We do NOT filter by `active` so EVERY storage
  // location is available as a putaway destination (inactive ones included).
  useEffect(() => {
    let cancelled = false;
    const excluded = new Set(
      [TRANSIT_LEGACY, ...(cartInfo.map(c => c.name) || [])].map(n => (n || "").toUpperCase())
    );
    fetcher("/locations?summary=false&limit=20000")
      .then(rows => {
        if (cancelled) return;
        const filtered = (Array.isArray(rows) ? rows : [])
          .filter(l => !excluded.has((l.name || "").toUpperCase()));
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

  // Step 1 — lock the destination location before any box is scanned.
  const confirmLocation = () => {
    const dst = cleanScan(destination);
    if (!dst) { toast.error("Escribe o escanea la ubicación destino"); return; }
    const match = locOptions.find(l => (l.name || "").toUpperCase() === dst);
    if (!match) { toast.error(`'${dst}' no existe en las ubicaciones activas`); return; }
    setLockedLocation(match.name);
    setDestination(match.name);
    setShowLocDrop(false);
    // Jump to the box scanner so the operator can keep scanning hands-free.
    requestAnimationFrame(() => boxScanRef.current?.focus());
  };

  // Reset back to step 1 — pick a different location.
  const changeLocation = () => {
    setLockedLocation("");
    setDestination("");
    setSelected(new Set());
    setBoxScan("");
    requestAnimationFrame(() => destInputRef.current?.focus());
  };

  // Step 2 — scan a box into the current batch.
  const handleBoxScan = (e) => {
    if (e) e.preventDefault();
    const id = cleanScan(boxScan);
    if (!id) return;
    const box = boxes.find(b => (b.box_id || "").toUpperCase() === id);
    if (!box) {
      toast.error(`Caja ${id} no está en los carros de tránsito (usa la pestaña "Todos")`);
      setBoxScan("");
      return;
    }
    setSelected(prev => {
      if (prev.has(box.box_id)) { toast.info(`La caja ${box.box_id} ya está en el lote`); return prev; }
      const next = new Set(prev);
      next.add(box.box_id);
      return next;
    });
    setBoxScan("");
  };

  // "Terminar" — raise the warning before committing the move.
  const handleFinish = () => {
    if (!lockedLocation) { toast.error("Primero selecciona una ubicación destino"); return; }
    if (selected.size === 0) { toast.error("Escanea o selecciona al menos una caja"); return; }
    setShowWarning(true);
  };

  const handleRelocate = async () => {
    const dst = (lockedLocation || "").trim().toUpperCase();
    if (!dst) { toast.error("Primero selecciona una ubicación destino"); return; }
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
        setShowWarning(false);
        setSelected(new Set());
        setLockedLocation("");
        setDestination("");
        setBoxScan("");
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
        <div className="flex items-center gap-3">
          {isAdmin && (
            <button
              onClick={() => { setCartQty(10); setShowCreateCarts(true); }}
              className="px-3 py-1.5 rounded-lg text-[11px] font-black uppercase tracking-widest border border-amber-500/40 text-amber-600 hover:bg-amber-500/10 transition-all flex items-center gap-1.5"
              data-testid="putaway2-create-carts"
            >
              <Plus className="w-3.5 h-3.5" /> Crear carros
            </button>
          )}
          <div className="text-[11px] font-mono font-bold text-muted-foreground">
            {boxes.length} cajas · {boxes.reduce((s, b) => s + (Number(b.units) || Number(b.qty) || 0), 0).toLocaleString()} unidades
          </div>
        </div>
      </div>

      {/* Bulk create carts modal */}
      {showCreateCarts && (
        <div className="fixed inset-0 z-[120] flex items-center justify-center bg-black/50 backdrop-blur-sm p-4" onClick={() => !creating && setShowCreateCarts(false)}>
          <div className="bg-card border border-border rounded-2xl shadow-2xl w-full max-w-sm p-5" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-3">
              <h3 className="font-black uppercase tracking-widest text-sm flex items-center gap-2">
                <Truck className="w-4 h-4 text-amber-500" /> Crear carros
              </h3>
              {!creating && <button onClick={() => setShowCreateCarts(false)} className="p-1 hover:bg-secondary rounded-lg"><X className="w-5 h-5" /></button>}
            </div>
            <p className="text-xs text-muted-foreground mb-3">
              Se crearán carros numerados a partir del último existente (máximo 50 a la vez).
              Los que ya existan se omiten. Funcionan como ubicaciones de tránsito: reciben material,
              descuentan inventario al surtir y aparecen en las tareas de surtido.
            </p>
            <label className="text-[10px] font-black uppercase tracking-widest text-muted-foreground block mb-1">¿Cuántos carros? (máx. 50)</label>
            <input
              type="number" min="1" max="50" value={cartQty}
              onChange={e => setCartQty(e.target.value)}
              disabled={creating}
              className="w-full px-3 py-2 bg-background border border-border rounded-lg text-lg font-mono font-bold mb-3 disabled:opacity-50"
              data-testid="create-carts-qty"
            />
            {creating && (
              <div className="mb-3">
                <div className="flex justify-between text-[11px] font-bold text-muted-foreground mb-1">
                  <span>Creando…</span>
                  <span className="font-mono">{createDone} / {Math.max(1, Math.min(50, parseInt(cartQty) || 0))}</span>
                </div>
                <div className="w-full h-3 bg-secondary rounded-full overflow-hidden">
                  <div className="h-full bg-amber-500 transition-all duration-150"
                    style={{ width: `${Math.round((createDone / Math.max(1, Math.min(50, parseInt(cartQty) || 1))) * 100)}%` }} />
                </div>
              </div>
            )}
            <div className="flex justify-end gap-2">
              {!creating && <button onClick={() => setShowCreateCarts(false)} className="px-4 py-2 rounded-lg text-xs font-bold text-muted-foreground hover:bg-secondary">Cancelar</button>}
              <button
                onClick={handleCreateCarts}
                disabled={creating}
                className="px-5 py-2 rounded-lg text-xs font-black uppercase tracking-widest bg-amber-500 text-white hover:bg-amber-600 disabled:opacity-50 flex items-center gap-2"
                data-testid="create-carts-confirm"
              >
                {creating ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
                {creating ? 'Creando…' : 'Crear'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Cart selector — only carts with stock (or the active one) show as tabs;
          every cart stays reachable through the "Ir a carro" dropdown. */}
      {(() => {
        const activeCarts = cartInfo.filter(c => (c.boxes || 0) > 0 || c.name === activeCart)
        const withStock = cartInfo.filter(c => (c.boxes || 0) > 0).length
        return (
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

            {activeCarts.map(c => (
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

            {/* Jump to any cart, including the empty ones. */}
            <select
              value={activeCart && activeCart !== TRANSIT_LEGACY ? activeCart : ""}
              onChange={e => setActiveCart(e.target.value)}
              title="Ir a cualquier carro"
              className="px-3 py-1.5 rounded-lg text-[11px] font-black uppercase tracking-widest border border-dashed border-border/60 bg-card/40 text-muted-foreground hover:border-amber-500/40 hover:text-foreground transition-all cursor-pointer focus:outline-none focus:border-amber-500/50"
            >
              <option value="">Ir a carro…</option>
              {cartInfo.map(c => (
                <option key={c.name} value={c.name}>
                  {c.name}{c.boxes ? ` · ${c.boxes} cajas` : " · vacío"}
                </option>
              ))}
            </select>

            <span className="text-[10px] font-mono text-muted-foreground/60 ml-auto">
              {withStock}/{cartInfo.length} carros con stock
            </span>
          </div>
        )
      })()}

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

      {/* Putaway control panel — location first, then scan boxes, then finish */}
      <div className="rounded-2xl bg-amber-500/5 border border-amber-500/30 p-4 space-y-3">
        {!lockedLocation ? (
          /* STEP 1 — pick / scan the destination location */
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <span className="flex items-center justify-center w-6 h-6 rounded-full bg-amber-500 text-white text-xs font-black">1</span>
              <span className="text-[11px] font-black uppercase tracking-widest text-amber-500 flex items-center gap-1.5">
                <MapPin className="w-4 h-4" /> Escanea o selecciona la ubicación destino
              </span>
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <div className="flex-1 min-w-[240px] relative" ref={destRef}>
                <ScanLine className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-amber-500" />
                <input
                  ref={destInputRef}
                  type="text"
                  value={destination}
                  onChange={e => { setDestination(e.target.value.toUpperCase()); setShowLocDrop(true); }}
                  onFocus={() => setShowLocDrop(true)}
                  onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); confirmLocation(); } }}
                  placeholder="Ubicación destino (ej. RP10-A26) — Enter para confirmar"
                  className="w-full pl-9 pr-3 py-2 bg-background border border-amber-500/40 rounded-lg text-sm font-mono focus:outline-none focus:ring-2 focus:ring-amber-500/30"
                  data-testid="putaway2-loc-scan"
                />
                {showLocDrop && filteredLocations.length > 0 && (
                  <div className="absolute z-30 mt-1 w-full max-h-60 overflow-y-auto bg-popover border border-border rounded-lg shadow-xl">
                    {filteredLocations.map(l => (
                      <button
                        key={l.location_id || l.name}
                        onClick={() => { setDestination(l.name); setShowLocDrop(false); requestAnimationFrame(() => destInputRef.current?.focus()); }}
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
                onClick={confirmLocation}
                disabled={!destination.trim()}
                className="px-4 py-2 bg-amber-500 hover:bg-amber-400 text-white rounded-lg text-xs font-black uppercase tracking-widest flex items-center gap-2 disabled:opacity-50"
                data-testid="putaway2-loc-confirm"
              >
                <MapPin className="w-4 h-4" /> Confirmar ubicación
              </button>
            </div>
          </div>
        ) : (
          /* STEP 2 — scan the boxes that go to the locked location */
          <div className="space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-3">
                <CheckCircle2 className="w-5 h-5 text-emerald-500 shrink-0" />
                <div>
                  <div className="text-[10px] font-black uppercase tracking-widest text-amber-500/70">Ubicación destino</div>
                  <div className="font-mono font-black text-emerald-500 text-lg flex items-center gap-2">
                    <MapPin className="w-4 h-4" /> {lockedLocation}
                  </div>
                </div>
              </div>
              <button
                onClick={changeLocation}
                disabled={moving}
                className="text-[10px] font-black uppercase tracking-widest text-amber-500 hover:underline disabled:opacity-50"
              >
                Cambiar ubicación
              </button>
            </div>

            <div className="flex items-center gap-2">
              <span className="flex items-center justify-center w-6 h-6 rounded-full bg-amber-500 text-white text-xs font-black">2</span>
              <span className="text-[11px] font-black uppercase tracking-widest text-amber-500 flex items-center gap-1.5">
                <ScanLine className="w-4 h-4" /> Escanea las cajas para esta ubicación
              </span>
            </div>

            <div className="flex flex-wrap items-center gap-3">
              <form onSubmit={handleBoxScan} className="flex-1 min-w-[240px] relative">
                <ScanLine className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-amber-500" />
                <input
                  ref={boxScanRef}
                  type="text"
                  value={boxScan}
                  onChange={e => setBoxScan(e.target.value.toUpperCase())}
                  placeholder="Escanea LPN de la caja (Enter)"
                  autoComplete="off"
                  className="w-full pl-9 pr-3 py-2 bg-background border border-amber-500/40 rounded-lg text-sm font-mono focus:outline-none focus:ring-2 focus:ring-amber-500/30"
                  data-testid="putaway2-box-scan"
                />
              </form>
              <div className="text-[11px] font-bold text-amber-500 uppercase tracking-widest">
                {selected.size} caja(s) · {totalSelectedUnits.toLocaleString()} und
              </div>
              <button
                onClick={handleFinish}
                disabled={moving || selected.size === 0}
                className="px-5 py-2 bg-amber-500 hover:bg-amber-400 text-white rounded-lg text-xs font-black uppercase tracking-widest flex items-center gap-2 disabled:opacity-50"
                data-testid="putaway2-finish"
              >
                {moving ? <Loader2 className="w-4 h-4 animate-spin" /> : <ClipboardCheck className="w-4 h-4" />}
                Terminar ({selected.size})
              </button>
              {selected.size > 0 && (
                <button
                  onClick={() => setSelected(new Set())}
                  disabled={moving}
                  className="px-3 py-2 text-xs font-bold uppercase tracking-widest text-muted-foreground hover:text-foreground"
                >
                  Limpiar
                </button>
              )}
            </div>
            <p className="text-[10px] text-muted-foreground/70 italic">
              También puedes hacer clic en las filas de abajo para agregar o quitar cajas del lote.
            </p>
          </div>
        )}
      </div>

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

      {/* Warning shown before locating the material */}
      {showWarning && (
        <div className="fixed inset-0 z-[80] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm animate-in fade-in duration-150">
          <div className="bg-card border border-amber-500/40 rounded-3xl w-full max-w-md shadow-2xl p-6 space-y-5 animate-in zoom-in-95 duration-150">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2 text-amber-500">
                <AlertTriangle className="w-5 h-5" />
                <h3 className="font-black uppercase tracking-widest text-sm">Confirmar ubicación</h3>
              </div>
              <button onClick={() => setShowWarning(false)} className="p-1 hover:bg-secondary rounded-lg transition-all" disabled={moving}>
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="bg-amber-500/10 border border-amber-500/20 rounded-2xl p-4 text-xs text-amber-200/90 font-bold leading-relaxed flex gap-2">
              <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5 text-amber-500" />
              <span>
                Estás por ubicar <span className="font-black text-amber-400">{selected.size} caja(s)</span> ({totalSelectedUnits.toLocaleString()} unidades)
                en <span className="font-black text-amber-400">{lockedLocation}</span>. Verifica que el material físico coincide antes de continuar — esta acción mueve el inventario.
              </span>
            </div>

            <div className="bg-secondary/40 rounded-2xl p-4 space-y-2 border border-border/20">
              <div className="flex items-center justify-between">
                <div className="text-[10px] font-black uppercase text-muted-foreground/60 tracking-widest">Ubicación destino</div>
                <div className="font-mono font-black text-emerald-500">{lockedLocation}</div>
              </div>
              <div className="border-t border-border/20 pt-2 max-h-[160px] overflow-auto custom-scrollbar space-y-1.5 font-mono">
                {boxes.filter(b => selected.has(b.box_id)).map(b => (
                  <div key={b.box_id} className="flex items-center justify-between text-[11px]">
                    <span className="font-black text-foreground">{b.box_id}</span>
                    <span className="text-muted-foreground">{b.style || b.sku || '—'} · {(b.units || b.qty || 0)} UN</span>
                  </div>
                ))}
              </div>
            </div>

            <div className="flex gap-2">
              <button
                onClick={handleRelocate}
                disabled={moving}
                className="flex-1 py-3 bg-emerald-500 hover:bg-emerald-400 text-white font-black uppercase tracking-widest text-xs rounded-2xl shadow-lg shadow-emerald-500/20 transition-all flex items-center justify-center gap-2 disabled:opacity-50"
                data-testid="putaway2-confirm"
              >
                {moving ? <Loader2 className="w-4 h-4 animate-spin" /> : <ArrowRightLeft className="w-4 h-4" />}
                Confirmar y ubicar
              </button>
              <button
                onClick={() => setShowWarning(false)}
                disabled={moving}
                className="flex-1 py-3 bg-secondary text-foreground font-black uppercase tracking-widest text-xs rounded-2xl hover:bg-secondary/80 transition-all disabled:opacity-50"
              >
                Cancelar
              </button>
            </div>
          </div>
        </div>
      )}

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
