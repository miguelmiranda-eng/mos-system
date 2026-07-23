import { useState, useEffect, useMemo, useCallback, useRef } from "react";
import { toast } from "sonner";
import {
  Truck, ScanLine, MapPin, ChevronRight, ChevronDown, ChevronLeft, Loader2,
  Package, Eye, EyeOff, CheckCircle2, X, Boxes, ArrowRight,
} from "lucide-react";
import { fetcher, poster, cleanScan, logLoadError } from "./lib";
import { ModuleHeader } from "./ui";

const TRANSIT_LEGACY = "UBICACION TEMPORAL";
const boxUnits = (b) => Number(b?.units ?? b?.qty ?? 0) || 0;

// Cart-first Putaway 2.0 flow, tuned for PDA / tablet (big touch targets, one
// step at a time, scanner-friendly). Desktop keeps the power-user table.
//   1. Pick the ORIGIN cart (scan or tap — only carts with stock; the rest live
//      behind "ver todos", grouped in ranges so they don't flood the screen).
//   2. Confirm the cart, optionally reveal its inventory, choose a DESTINATION.
//   3. A dedicated full-screen modal scans the boxes with a BIG counter
//      (scan one-by-one, or "todo el carro").
export function PutawayWizard() {
  const [carts, setCarts] = useState([]);       // [{name, boxes}]
  const [legacyCount, setLegacyCount] = useState(0);
  const [loadingCarts, setLoadingCarts] = useState(true);
  const [showAllCarts, setShowAllCarts] = useState(false);
  const [cartScan, setCartScan] = useState("");

  const [origin, setOrigin] = useState("");     // chosen cart name
  const [cartBoxes, setCartBoxes] = useState([]);
  const [loadingBoxes, setLoadingBoxes] = useState(false);
  const [showInventory, setShowInventory] = useState(false);

  const [locOptions, setLocOptions] = useState([]);
  const [destText, setDestText] = useState("");
  const [showDestDrop, setShowDestDrop] = useState(false);
  const [lockedDest, setLockedDest] = useState("");

  const [scanOpen, setScanOpen] = useState(false);
  const [selected, setSelected] = useState(() => new Set());
  const [boxScan, setBoxScan] = useState("");
  const [moving, setMoving] = useState(false);
  const scanInputRef = useRef(null);

  // ── Load carts + destination locations ──────────────────────────────────────
  const loadCarts = useCallback(() => {
    setLoadingCarts(true);
    fetcher("/transit/info")
      .then(d => {
        setCarts(Array.isArray(d?.carts) ? d.carts : []);
        setLegacyCount(Number(d?.legacy_boxes) || 0);
      })
      .catch(logLoadError("transit info"))
      .finally(() => setLoadingCarts(false));
  }, []);
  useEffect(() => { loadCarts(); }, [loadCarts]);

  useEffect(() => {
    const excluded = new Set([TRANSIT_LEGACY, ...carts.map(c => c.name)].map(n => (n || "").toUpperCase()));
    fetcher("/locations/names")
      .then(rows => setLocOptions((rows || []).filter(l => !excluded.has((l.name || "").toUpperCase()))))
      .catch(logLoadError("destination locations"));
  }, [carts]);

  // ── Cart lists ──────────────────────────────────────────────────────────────
  const cartsWithStock = useMemo(
    () => carts.filter(c => (c.boxes || 0) > 0).sort((a, b) => (b.boxes || 0) - (a.boxes || 0)),
    [carts]
  );
  // All carts grouped into ranges of 20 (1-20, 21-40, …) for the "ver todos" panel.
  const cartRanges = useMemo(() => {
    const numbered = carts
      .map(c => ({ ...c, n: parseInt((/CARRO\s+(\d+)/i.exec(c.name || "") || [])[1] || "0", 10) }))
      .filter(c => c.n > 0)
      .sort((a, b) => a.n - b.n);
    const groups = {};
    for (const c of numbered) {
      const lo = Math.floor((c.n - 1) / 20) * 20 + 1;
      const key = `${lo}-${lo + 19}`;
      (groups[key] ||= []).push(c);
    }
    return Object.entries(groups);
  }, [carts]);

  const pickCart = useCallback((name) => {
    setOrigin(name);
    setShowInventory(false);
    setLockedDest("");
    setDestText("");
    setSelected(new Set());
    setLoadingBoxes(true);
    fetcher(`/transit/boxes?cart=${encodeURIComponent(name)}`)
      .then(d => setCartBoxes(Array.isArray(d?.boxes) ? d.boxes : []))
      .catch(e => { logLoadError("cart boxes")(e); setCartBoxes([]); })
      .finally(() => setLoadingBoxes(false));
  }, []);

  const onCartScan = (e) => {
    e.preventDefault();
    const code = cleanScan(cartScan);
    if (!code) return;
    const hit = carts.find(c => (c.name || "").toUpperCase() === code);
    if (!hit) { toast.error(`Carro ${code} no existe`); return; }
    setCartScan("");
    pickCart(hit.name);
  };

  // Per-style summary for the optional "mostrar inventario" view.
  const inventorySummary = useMemo(() => {
    const map = {};
    for (const b of cartBoxes) {
      const k = `${b.style || b.sku || "?"} · ${b.color || ""} · ${b.size || ""}`;
      (map[k] ||= { key: k, boxes: 0, units: 0 });
      map[k].boxes += 1;
      map[k].units += boxUnits(b);
    }
    return Object.values(map).sort((a, b) => b.units - a.units);
  }, [cartBoxes]);

  const cartTotalUnits = useMemo(() => cartBoxes.reduce((s, b) => s + boxUnits(b), 0), [cartBoxes]);

  // ── Destination typeahead ───────────────────────────────────────────────────
  const destMatches = useMemo(() => {
    const q = (destText || "").trim().toUpperCase();
    if (!q) return locOptions.slice(0, 8);
    return locOptions.filter(l => (l.name || "").toUpperCase().includes(q)).slice(0, 8);
  }, [destText, locOptions]);

  const confirmDest = (raw) => {
    const dst = cleanScan(raw ?? destText);
    if (!dst) { toast.error("Escanea o escribe la ubicación destino"); return; }
    const match = locOptions.find(l => (l.name || "").toUpperCase() === dst);
    if (!match) { toast.error(`'${dst}' no existe en las ubicaciones activas`); return; }
    setLockedDest(match.name);
    setDestText(match.name);
    setShowDestDrop(false);
    // Open the dedicated scan modal.
    setSelected(new Set());
    setScanOpen(true);
    requestAnimationFrame(() => scanInputRef.current?.focus());
  };

  // ── Scan modal ──────────────────────────────────────────────────────────────
  const onBoxScan = (e) => {
    e.preventDefault();
    const id = cleanScan(boxScan);
    if (!id) return;
    const box = cartBoxes.find(b => (b.box_id || "").toUpperCase() === id);
    if (!box) { toast.error(`Caja ${id} no está en ${origin}`); setBoxScan(""); return; }
    setSelected(prev => {
      if (prev.has(box.box_id)) { toast.info(`${box.box_id} ya está en el lote`); return prev; }
      return new Set(prev).add(box.box_id);
    });
    setBoxScan("");
  };

  const selectAll = () => setSelected(new Set(cartBoxes.map(b => b.box_id)));
  const removeOne = (id) => setSelected(prev => { const n = new Set(prev); n.delete(id); return n; });

  const selectedUnits = useMemo(
    () => cartBoxes.reduce((s, b) => selected.has(b.box_id) ? s + boxUnits(b) : s, 0),
    [cartBoxes, selected]
  );

  const finish = async () => {
    if (selected.size === 0) { toast.error("Escanea al menos una caja"); return; }
    setMoving(true);
    try {
      const res = await poster("/transit/relocate", { box_ids: Array.from(selected), to: lockedDest });
      if (res.ok) {
        const data = await res.json().catch(() => ({}));
        toast.success(data.message || `${selected.size} cajas → ${lockedDest}`);
        setScanOpen(false);
        setSelected(new Set());
        setLockedDest("");
        setDestText("");
        // Reload the cart's remaining boxes + cart counts.
        pickCart(origin);
        loadCarts();
      } else {
        const err = await res.json().catch(() => ({}));
        toast.error(err.detail || "Error al reubicar");
      }
    } catch (e) {
      logLoadError("relocate")(e);
      toast.error("Error de conexión");
    } finally { setMoving(false); }
  };

  const resetToCarts = () => {
    setOrigin(""); setCartBoxes([]); setShowInventory(false);
    setLockedDest(""); setDestText(""); setSelected(new Set());
  };

  // ── Render ──────────────────────────────────────────────────────────────────
  return (
    <div className="min-h-full">
      {/* STEP 1 — choose origin cart */}
      {!origin ? (
        <div className="space-y-4">
          <ModuleHeader title="Putaway 2.0" subtitle="Escanea el carro del que vas a tomar material" />

          <form onSubmit={onCartScan} className="flex items-center gap-2">
            <div className="relative flex-1">
              <ScanLine className="w-5 h-5 text-muted-foreground absolute left-3 top-1/2 -translate-y-1/2" />
              <input
                autoFocus value={cartScan} onChange={e => setCartScan(e.target.value.toUpperCase())}
                placeholder="Escanea o escribe el carro (CARRO 3)"
                data-testid="putaway-cart-scan"
                className="w-full h-14 pl-11 pr-4 bg-card border border-input rounded-lg text-lg font-mono font-medium focus:outline-none focus:ring-2 focus:ring-ring/25 focus:border-ring"
              />
            </div>
            <button type="submit" className="h-14 px-5 rounded-lg bg-primary text-primary-foreground font-semibold text-sm active:scale-95 transition-transform">OK</button>
          </form>

          {loadingCarts ? (
            <div className="flex justify-center py-16"><Loader2 className="w-8 h-8 animate-spin text-muted-foreground" /></div>
          ) : (
            <>
              <div className="text-xs font-medium text-muted-foreground">
                Carros con material ({cartsWithStock.length})
              </div>
              <div className="grid grid-cols-2 gap-3">
                {cartsWithStock.map(c => (
                  <button key={c.name} onClick={() => pickCart(c.name)}
                    data-testid={`putaway-cart-${c.name.replace(/\s+/g, '-').toLowerCase()}`}
                    className="flex items-center justify-between gap-2 p-4 rounded-lg border border-border bg-card hover:bg-muted active:scale-[0.98] transition-all">
                    <div className="flex items-center gap-2 min-w-0">
                      <Truck className="w-5 h-5 text-muted-foreground flex-shrink-0" />
                      <span className="font-semibold truncate">{c.name}</span>
                    </div>
                    <span className="text-sm font-mono tabular-nums font-medium flex-shrink-0">{(c.boxes || 0).toLocaleString()}</span>
                  </button>
                ))}
                {cartsWithStock.length === 0 && (
                  <div className="col-span-2 text-center py-10 text-muted-foreground text-sm">No hay carros con material.</div>
                )}
              </div>

              {legacyCount > 0 && (
                <button onClick={() => pickCart(TRANSIT_LEGACY)}
                  className="w-full flex items-center justify-between gap-2 p-4 rounded-lg border border-border bg-card hover:bg-muted transition-colors">
                  <span className="font-semibold text-sm">⏸ Temporal (legacy)</span>
                  <span className="text-sm font-mono tabular-nums font-medium">{legacyCount.toLocaleString()}</span>
                </button>
              )}

              {/* All carts (incl. empty) in ranges — collapsed by default */}
              <button onClick={() => setShowAllCarts(v => !v)}
                className="w-full flex items-center justify-center gap-2 py-3 rounded-md border border-dashed border-border text-muted-foreground text-xs font-medium hover:text-foreground transition-colors">
                {showAllCarts ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
                {showAllCarts ? "Ocultar" : "Ver todos los carros"}
              </button>
              {showAllCarts && (
                <div className="space-y-3">
                  {cartRanges.map(([range, items]) => (
                    <RangeGroup key={range} range={range} items={items} onPick={pickCart} />
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      ) : (
        /* STEP 2 — cart chosen: summary, optional inventory, choose destination */
        <div className="space-y-4">
          <button onClick={resetToCarts} className="flex items-center gap-1.5 text-sm font-medium text-muted-foreground hover:text-foreground transition-colors">
            <ChevronLeft className="w-4 h-4" /> Cambiar carro
          </button>

          <div className="bg-card border border-border rounded-lg p-4 flex items-center justify-between">
            <div className="flex items-center gap-3 min-w-0">
              <Truck className="w-7 h-7 text-muted-foreground flex-shrink-0" />
              <div className="min-w-0">
                <div className="text-xs font-medium text-muted-foreground">Carro origen</div>
                <div className="text-lg font-semibold truncate">{origin}</div>
              </div>
            </div>
            <div className="text-right flex-shrink-0">
              <div className="text-lg font-semibold tabular-nums leading-none">{loadingBoxes ? "…" : cartBoxes.length}</div>
              <div className="text-xs text-muted-foreground">cajas · {cartTotalUnits.toLocaleString()} u</div>
            </div>
          </div>

          {/* Optional inventory — hidden until requested */}
          <button onClick={() => setShowInventory(v => !v)}
            className="w-full flex items-center justify-center gap-2 py-3 rounded-md border border-border text-muted-foreground text-xs font-medium hover:text-foreground transition-colors"
            data-testid="putaway-toggle-inventory">
            {showInventory ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
            {showInventory ? "Ocultar inventario" : "Mostrar inventario"}
          </button>
          {showInventory && (
            <div className="space-y-2 max-h-72 overflow-y-auto">
              {inventorySummary.map(r => (
                <div key={r.key} className="flex items-center justify-between p-3 rounded-lg border border-border/60 bg-card">
                  <div className="flex items-center gap-2 min-w-0">
                    <Package className="w-4 h-4 text-muted-foreground flex-shrink-0" />
                    <span className="font-mono text-sm font-medium truncate">{r.key}</span>
                  </div>
                  <span className="text-xs font-mono text-muted-foreground flex-shrink-0">{r.boxes} cajas · {r.units} u</span>
                </div>
              ))}
              {inventorySummary.length === 0 && <div className="text-center py-6 text-muted-foreground text-sm">Carro vacío.</div>}
            </div>
          )}

          {/* Destination */}
          <div className="bg-card border border-border rounded-lg p-4 space-y-3 relative">
            <div className="text-xs font-medium text-muted-foreground flex items-center gap-2">
              <MapPin className="w-4 h-4 text-muted-foreground" /> Ubicación destino
            </div>
            <form onSubmit={(e) => { e.preventDefault(); confirmDest(); }} className="flex items-center gap-2">
              <div className="relative flex-1">
                <ScanLine className="w-5 h-5 text-muted-foreground absolute left-3 top-1/2 -translate-y-1/2" />
                <input
                  value={destText}
                  onChange={e => { setDestText(e.target.value.toUpperCase()); setShowDestDrop(true); }}
                  onFocus={() => setShowDestDrop(true)}
                  placeholder="Escanea o escribe la ubicación"
                  data-testid="putaway-dest-input"
                  className="w-full h-14 pl-11 pr-4 bg-card border border-input rounded-lg text-lg font-mono font-medium focus:outline-none focus:ring-2 focus:ring-ring/25 focus:border-ring"
                />
              </div>
              <button type="submit" disabled={cartBoxes.length === 0}
                className="h-14 px-5 rounded-lg bg-primary text-primary-foreground font-semibold text-sm disabled:opacity-40 active:scale-95 transition-transform">
                Ir
              </button>
            </form>
            {showDestDrop && destMatches.length > 0 && (
              <div className="absolute z-20 left-4 right-4 mt-1 bg-popover border border-border rounded-lg shadow-xl overflow-hidden max-h-64 overflow-y-auto">
                {destMatches.map(l => (
                  <button key={l.name} type="button" onClick={() => confirmDest(l.name)}
                    className="w-full flex items-center gap-2 px-4 py-3 text-left hover:bg-muted border-b border-border/40 last:border-0">
                    <MapPin className="w-4 h-4 text-muted-foreground flex-shrink-0" />
                    <span className="font-mono font-medium">{l.name}</span>
                    {l.zone && <span className="text-xs text-muted-foreground ml-auto">{l.zone}</span>}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {/* STEP 3 — full-screen scan modal with a BIG counter */}
      {scanOpen && (
        <div className="fixed inset-0 z-[130] bg-background flex flex-col">
          {/* Modal header */}
          <div className="flex items-center justify-between px-4 py-3 border-b border-border">
            <button onClick={() => setScanOpen(false)} className="flex items-center gap-1.5 text-sm font-medium text-muted-foreground hover:text-foreground transition-colors">
              <ChevronLeft className="w-5 h-5" /> Volver
            </button>
            <div className="text-xs font-mono text-muted-foreground">
              {origin} <ArrowRight className="w-3 h-3 inline" /> <span className="font-semibold text-foreground">{lockedDest}</span>
            </div>
          </div>

          {/* BIG counter */}
          <div className="px-4 py-6 text-center bg-card border-b border-border">
            <div className="text-6xl font-semibold tracking-tight tabular-nums leading-none">{selected.size}</div>
            <div className="text-sm font-medium text-muted-foreground mt-1">
              cajas · {selectedUnits.toLocaleString()} unidades
            </div>
          </div>

          {/* Scan input + "todo el carro" */}
          <div className="p-4 space-y-3">
            <form onSubmit={onBoxScan} className="flex items-center gap-2">
              <div className="relative flex-1">
                <ScanLine className="w-6 h-6 text-muted-foreground absolute left-3 top-1/2 -translate-y-1/2" />
                <input
                  ref={scanInputRef} autoFocus value={boxScan}
                  onChange={e => setBoxScan(e.target.value.toUpperCase())}
                  placeholder="Escanea la caja (BOX-…)"
                  data-testid="putaway-box-scan"
                  className="w-full h-16 pl-12 pr-4 bg-card border border-input rounded-lg text-xl font-mono font-medium focus:outline-none focus:ring-2 focus:ring-ring/25 focus:border-ring"
                />
              </div>
            </form>
            <button onClick={selectAll}
              className="w-full h-12 rounded-lg bg-card border border-border text-sm font-medium hover:bg-muted transition-colors flex items-center justify-center gap-2"
              data-testid="putaway-select-all">
              <Boxes className="w-5 h-5" /> Todo el carro ({cartBoxes.length})
            </button>
          </div>

          {/* Selected list */}
          <div className="flex-1 overflow-y-auto px-4 pb-4 space-y-2">
            {cartBoxes.filter(b => selected.has(b.box_id)).map(b => (
              <div key={b.box_id} className="flex items-center justify-between p-3 rounded-lg border border-emerald-200 bg-emerald-50 dark:border-emerald-500/25 dark:bg-emerald-500/10">
                <div className="min-w-0">
                  <div className="font-mono font-medium text-sm">{b.box_id}</div>
                  <div className="text-xs text-muted-foreground truncate">{b.style || b.sku} · {b.color} · {b.size}</div>
                </div>
                <div className="flex items-center gap-3 flex-shrink-0">
                  <span className="font-semibold tabular-nums">{boxUnits(b)} u</span>
                  <button onClick={() => removeOne(b.box_id)} className="p-1.5 rounded-md text-muted-foreground hover:text-red-600 dark:hover:text-red-400"><X className="w-4 h-4" /></button>
                </div>
              </div>
            ))}
            {selected.size === 0 && (
              <div className="text-center py-12">
                <p className="text-sm text-muted-foreground">Escanea cajas o usa "Todo el carro"</p>
              </div>
            )}
          </div>

          {/* Finish */}
          <div className="p-4 border-t border-border">
            <button onClick={finish} disabled={moving || selected.size === 0}
              className="w-full h-16 rounded-lg bg-primary text-primary-foreground hover:opacity-90 disabled:opacity-40 font-semibold text-lg flex items-center justify-center gap-2 active:scale-[0.98] transition-transform"
              data-testid="putaway-finish">
              {moving ? <Loader2 className="w-6 h-6 animate-spin" /> : <CheckCircle2 className="w-6 h-6" />}
              Terminar · {selected.size} → {lockedDest}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// A collapsible range group (CARRO 1-20, …) used in the "ver todos" panel.
function RangeGroup({ range, items, onPick }) {
  const [open, setOpen] = useState(false);
  const withStock = items.filter(c => (c.boxes || 0) > 0).length;
  return (
    <div className="border border-border rounded-lg overflow-hidden">
      <button onClick={() => setOpen(v => !v)} className="w-full flex items-center justify-between px-4 py-3 bg-card">
        <span className="text-xs font-semibold">CARRO {range}</span>
        <span className="flex items-center gap-2 text-xs text-muted-foreground">
          {withStock}/{items.length} con stock
          {open ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
        </span>
      </button>
      {open && (
        <div className="grid grid-cols-3 gap-2 p-3">
          {items.map(c => (
            <button key={c.name} onClick={() => onPick(c.name)}
              className={`flex flex-col items-center justify-center gap-0.5 p-2.5 rounded-md border text-center ${
                (c.boxes || 0) > 0 ? "border-border bg-card" : "border-border bg-card opacity-60"
              }`}>
              <span className="text-xs font-semibold truncate w-full">{c.name}</span>
              <span className="text-xs font-mono tabular-nums text-muted-foreground">{(c.boxes || 0).toLocaleString()}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
