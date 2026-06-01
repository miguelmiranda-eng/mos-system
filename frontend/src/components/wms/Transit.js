import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { toast } from "sonner";
import {
  Loader2, Package, Search, X, MapPin, ChevronRight, CheckSquare, Square, ArrowRightLeft,
} from "lucide-react";
import { fetcher, poster, logLoadError } from "./lib";

/**
 * Transit module — manages the boxes parked at "UBICACION TEMPORAL".
 *
 * Receiving operators may receive a box without a final destination (button
 * "Recibir a Temporal" in the Receiving form). Those boxes land here.
 *
 * From this screen, an admin / warehouse lead can:
 *   - Filter / search the pending pile.
 *   - Select boxes (one or many).
 *   - Type the target location (typeahead against active locations).
 *   - Move them. The backend re-balances inventory and logs a movement.
 */
export const TransitModule = () => {
  const [boxes, setBoxes] = useState([]);
  const [transitName, setTransitName] = useState("UBICACION TEMPORAL");
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState("");
  const [customerFilter, setCustomerFilter] = useState("");
  // Selection state — keyed by box_id so it survives reorder/refresh.
  const [selected, setSelected] = useState(() => new Set());
  // Move-to flow
  const [destination, setDestination] = useState("");
  const [moving, setMoving] = useState(false);
  const [locOptions, setLocOptions] = useState([]); // [{name, zone}]
  const [showLocDrop, setShowLocDrop] = useState(false);
  const destRef = useRef(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (customerFilter.trim()) params.set("customer", customerFilter.trim());
      if (search.trim()) params.set("search", search.trim());
      const data = await fetcher(`/transit/boxes?${params.toString()}`);
      setTransitName(data.transit_location || transitName);
      setBoxes(Array.isArray(data.boxes) ? data.boxes : []);
    } catch (err) {
      logLoadError("transit boxes")(err);
      toast.error("No se pudieron cargar las cajas en tránsito");
    } finally { setLoading(false); }
  }, [customerFilter, search, transitName]);

  useEffect(() => { load(); }, [load]);

  // Active locations for the typeahead — `summary=false` skips the expensive
  // inventory aggregation so the dropdown is snappy.
  useEffect(() => {
    let cancelled = false;
    fetcher("/locations?summary=false&limit=5000")
      .then(rows => {
        if (cancelled) return;
        const filtered = (Array.isArray(rows) ? rows : [])
          .filter(l => l.active !== false && (l.name || "").toUpperCase() !== transitName);
        setLocOptions(filtered);
      })
      .catch(logLoadError("locations for transit destination"));
    return () => { cancelled = true; };
  }, [transitName]);

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
            <span className="text-amber-500 text-base leading-none">⏸</span>
          </div>
          <div>
            <h2 className="font-black uppercase tracking-widest text-foreground">En Tránsito</h2>
            <p className="text-[11px] text-muted-foreground">
              Cajas en <span className="font-mono font-bold text-amber-500">{transitName}</span> — pendientes de asignar ubicación física
            </p>
          </div>
        </div>
        <div className="text-[11px] font-mono font-bold text-muted-foreground">
          {boxes.length} cajas · {boxes.reduce((s, b) => s + (Number(b.units) || Number(b.qty) || 0), 0).toLocaleString()} unidades
        </div>
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
                <th className="p-3 text-left text-[10px] font-black uppercase tracking-widest text-muted-foreground">Cliente</th>
                <th className="p-3 text-left text-[10px] font-black uppercase tracking-widest text-muted-foreground">Estilo / SKU</th>
                <th className="p-3 text-left text-[10px] font-black uppercase tracking-widest text-muted-foreground">Color · Talla</th>
                <th className="p-3 text-right text-[10px] font-black uppercase tracking-widest text-muted-foreground">Unidades</th>
                <th className="p-3 text-left text-[10px] font-black uppercase tracking-widest text-muted-foreground">Recibida</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan={7} className="py-16 text-center text-muted-foreground">
                    <Loader2 className="w-6 h-6 animate-spin mx-auto" />
                  </td>
                </tr>
              ) : boxes.length === 0 ? (
                <tr>
                  <td colSpan={7} className="py-20 text-center">
                    <Package className="w-12 h-12 mx-auto opacity-20 mb-2 text-amber-500" />
                    <p className="text-sm font-bold uppercase tracking-widest text-muted-foreground">Sin cajas en tránsito</p>
                    <p className="text-xs text-muted-foreground/70 mt-2 max-w-md mx-auto">
                      Cuando recibas mercancía con el botón "Recibir a Temporal" en Receiving, las cajas aparecerán aquí esperando una ubicación física.
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
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};
