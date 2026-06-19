import { useState, useEffect, useMemo, useRef, useCallback } from "react";
import { toast } from "sonner";
import {
  ScanLine, MapPin, Boxes, Package, Layers, ArrowRight, Loader2,
  CheckCircle2, RotateCcw, Search, X, Move, Tag,
} from "lucide-react";
import { fetcher, poster, cleanScan, logLoadError } from "./lib";

// ─── Location input: scan (keyboard-wedge) OR type-to-search a known slot ─────
// Handheld scanners type the code + Enter into the focused box. We also show up
// to 8 matching known locations as tappable chips so an operator without a label
// can pick one by hand ("o seleccionarla").
function LocationInput({ value, onChange, onPick, onSubmit, locations, placeholder, autoFocus, testid }) {
  const [open, setOpen] = useState(false);
  const matches = useMemo(() => {
    const v = (value || "").trim().toUpperCase();
    if (!v) return [];
    return locations.filter(n => n.includes(v) && n !== v).slice(0, 8);
  }, [value, locations]);

  return (
    <div className="relative">
      <form
        onSubmit={(e) => { e.preventDefault(); setOpen(false); onSubmit?.(cleanScan(value)); }}
        className="flex items-center gap-2"
      >
        <div className="relative flex-1">
          <ScanLine className="w-5 h-5 text-primary absolute left-3 top-1/2 -translate-y-1/2" />
          <input
            autoFocus={autoFocus}
            value={value}
            onChange={(e) => { onChange(e.target.value.toUpperCase()); setOpen(true); }}
            onFocus={() => setOpen(true)}
            placeholder={placeholder}
            data-testid={testid}
            className="w-full h-14 pl-11 pr-10 bg-secondary/30 border-2 border-border rounded-2xl text-lg font-mono font-bold tracking-wide focus:outline-none focus:border-primary"
          />
          {value && (
            <button type="button" onClick={() => { onChange(""); setOpen(false); }}
              className="absolute right-3 top-1/2 -translate-y-1/2 p-1 rounded-lg text-muted-foreground hover:text-foreground">
              <X className="w-4 h-4" />
            </button>
          )}
        </div>
        <button type="submit"
          className="h-14 px-5 rounded-2xl bg-primary text-primary-foreground font-black uppercase text-sm tracking-wide active:scale-95 transition-transform">
          OK
        </button>
      </form>
      {open && matches.length > 0 && (
        <div className="absolute z-20 mt-1 w-full bg-card border border-border rounded-xl shadow-xl overflow-hidden">
          {matches.map(n => (
            <button key={n} type="button"
              onClick={() => { onChange(n); setOpen(false); onPick ? onPick(n) : onSubmit?.(n); }}
              className="w-full flex items-center gap-2 px-4 py-3 text-left hover:bg-primary/10 border-b border-border/40 last:border-0">
              <MapPin className="w-4 h-4 text-cyan-400 flex-shrink-0" />
              <span className="font-mono font-bold">{n}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// Big choice button used on the mode picker.
function ModeButton({ icon: Icon, title, subtitle, color, onClick, testid }) {
  return (
    <button onClick={onClick} data-testid={testid}
      className="w-full flex items-center gap-4 p-5 rounded-2xl border border-border bg-card/60 hover:bg-card hover:border-primary/50 active:scale-[0.98] transition-all text-left">
      <div className={`p-3 rounded-2xl bg-primary/10 ${color}`}><Icon className="w-8 h-8" /></div>
      <div className="flex-1 min-w-0">
        <div className="text-lg font-black uppercase tracking-wide">{title}</div>
        <div className="text-xs text-muted-foreground">{subtitle}</div>
      </div>
      <ArrowRight className="w-5 h-5 text-muted-foreground" />
    </button>
  );
}

export function MoverModule() {
  // Flow: origin → mode → (per-mode selection) → destination → submit.
  const [origin, setOrigin] = useState("");
  const [originInput, setOriginInput] = useState("");
  const [mode, setMode] = useState(null); // 'all' | 'box' | 'units' | 'reconcile'
  const [contents, setContents] = useState({ boxes: [], lines: [] });
  const [loading, setLoading] = useState(false);
  const [dest, setDest] = useState("");
  const [submitting, setSubmitting] = useState(false);

  // Per-mode selection
  const [selectedBoxes, setSelectedBoxes] = useState([]);   // box mode: array of box_id
  const [selectedLine, setSelectedLine] = useState(null);   // units/reconcile mode: an inventory line
  const [qty, setQty] = useState("");
  const [physicalLpn, setPhysicalLpn] = useState("");       // reconcile mode: scanned real LPN

  // Known location names for the type-to-search chips (fetched once).
  const [locNames, setLocNames] = useState([]);
  useEffect(() => {
    fetcher("/locations?summary=false&limit=20000")
      .then(rows => setLocNames((rows || []).map(r => r.name).filter(Boolean)))
      .catch(logLoadError("locations"));
  }, []);

  const loadContents = useCallback(async (loc) => {
    setLoading(true);
    try {
      const [boxes, inv] = await Promise.all([
        fetcher(`/boxes?location=${encodeURIComponent(loc)}`),
        fetcher(`/inventory?location=${encodeURIComponent(loc)}`),
      ]);
      const up = loc.toUpperCase();
      const liveBoxes = (boxes || []).filter(b => (b.units ?? b.qty ?? 0) > 0);
      // GET /inventory matches location as a substring ("CARRO 1" → "CARRO 10"),
      // so pin the lines to the exact origin slot before listing them.
      const lines = (inv || []).filter(
        r => (r.units_on_hand ?? 0) > 0 && (r.location || "").toUpperCase() === up
      );
      setContents({ boxes: liveBoxes, lines });
    } catch (e) {
      logLoadError("contenido de ubicación")(e);
      setContents({ boxes: [], lines: [] });
    } finally {
      setLoading(false);
    }
  }, []);

  const setOriginAndLoad = (loc) => {
    const clean = cleanScan(loc);
    if (!clean) return;
    setOrigin(clean);
    setMode(null);
    setSelectedBoxes([]);
    setSelectedLine(null);
    setQty("");
    setPhysicalLpn("");
    setDest("");
    loadContents(clean);
  };

  const resetAll = () => {
    setOrigin(""); setOriginInput(""); setMode(null);
    setContents({ boxes: [], lines: [] });
    setSelectedBoxes([]); setSelectedLine(null); setQty(""); setPhysicalLpn(""); setDest("");
  };

  const totalUnits = useMemo(
    () => contents.lines.reduce((s, r) => s + (r.units_on_hand || 0), 0),
    [contents.lines]
  );

  // ── Submit handlers per mode ────────────────────────────────────────────────
  const doMove = async (label, promise) => {
    setSubmitting(true);
    try {
      const res = await promise;
      if (res.ok) {
        const data = await res.json().catch(() => ({}));
        toast.success(data.message || `${label} completado`);
        // Stay on the same origin and refresh so the operator can keep working
        // in the same bin; clear the per-move selection.
        setMode(null); setSelectedBoxes([]); setSelectedLine(null); setQty(""); setPhysicalLpn(""); setDest("");
        await loadContents(origin);
      } else {
        const err = await res.json().catch(() => ({}));
        toast.error(err.detail || `No se pudo completar: ${label}`);
      }
    } catch {
      toast.error("Error de conexión");
    } finally {
      setSubmitting(false);
    }
  };

  const moveAll = () => doMove("Mover toda la ubicación",
    poster("/move-location", { from: origin, to: cleanScan(dest) }));

  const moveBoxes = () => doMove("Mover cajas",
    poster("/boxes/relocate", { box_ids: selectedBoxes, to: cleanScan(dest) }));

  const moveUnits = () => doMove("Mover unidades", poster("/move-units", {
    // Send the SAME identifier the row shows (style first): Excel-imported rows
    // can carry sku="None" with the real value in `style`. The backend matches
    // on sku OR style, so style is the safe, consistent key.
    from: origin, to: cleanScan(dest),
    sku: selectedLine.style || selectedLine.sku, color: selectedLine.color || "",
    size: selectedLine.size || "", units: parseInt(qty) || 0,
  }));

  // Reconcile a migrated generic LPN with the box's real physical license plate,
  // correcting its quantity and moving it to the destination in one shot.
  const moveReconcile = () => doMove("Reconciliar LPN", poster("/boxes/reconcile-lpn", {
    location: origin, destination: cleanScan(dest),
    sku: selectedLine.style || selectedLine.sku, color: selectedLine.color || "",
    size: selectedLine.size || "",
    physical_lpn: cleanScan(physicalLpn), units: parseInt(qty) || 0,
  }));

  const toggleBox = (id) =>
    setSelectedBoxes(p => p.includes(id) ? p.filter(x => x !== id) : [...p, id]);

  // Scanning a box barcode in box mode toggles it in the selection.
  const boxScanRef = useRef(null);
  const onBoxScan = (raw) => {
    const code = cleanScan(raw);
    const hit = contents.boxes.find(b => (b.box_id || "").toUpperCase() === code);
    if (!hit) { toast.error(`Caja ${code} no está en ${origin}`); return; }
    toggleBox(hit.box_id);
    if (boxScanRef.current) boxScanRef.current.value = "";
  };

  // ── Render ──────────────────────────────────────────────────────────────────
  return (
    <div className="h-full overflow-y-auto bg-background text-foreground">
      <div className="max-w-2xl mx-auto p-4 sm:p-6 space-y-5">
        {/* Title */}
        <div className="flex items-center gap-3">
          <div className="p-2.5 rounded-2xl bg-primary/10"><Move className="w-7 h-7 text-primary" /></div>
          <div>
            <h1 className="text-xl font-black uppercase tracking-tight">Mover Material</h1>
            <p className="text-xs text-muted-foreground">Escanea una ubicación y elige qué mover</p>
          </div>
        </div>

        {/* STEP 1 — origin */}
        {!origin ? (
          <div className="bg-card border border-border rounded-2xl p-5 space-y-3">
            <div className="text-sm font-black uppercase tracking-wide text-muted-foreground flex items-center gap-2">
              <span className="w-6 h-6 rounded-full bg-primary text-primary-foreground text-xs flex items-center justify-center font-black">1</span>
              Escanea la ubicación de origen
            </div>
            <LocationInput
              value={originInput} onChange={setOriginInput}
              onSubmit={setOriginAndLoad} onPick={setOriginAndLoad}
              locations={locNames} autoFocus placeholder="Ej. RP10-A26 · CARRO 1"
              testid="mover-origin-input"
            />
          </div>
        ) : (
          <>
            {/* Origin summary header */}
            <div className="bg-card border border-primary/30 rounded-2xl p-4 flex items-center justify-between">
              <div className="flex items-center gap-3 min-w-0">
                <MapPin className="w-6 h-6 text-cyan-400 flex-shrink-0" />
                <div className="min-w-0">
                  <div className="text-[10px] uppercase tracking-widest text-muted-foreground font-black">Origen</div>
                  <div className="text-lg font-mono font-black truncate">{origin}</div>
                </div>
              </div>
              <div className="flex items-center gap-4">
                <div className="text-right">
                  <div className="text-lg font-black leading-none">{loading ? "…" : totalUnits}</div>
                  <div className="text-[10px] uppercase tracking-widest text-muted-foreground">unidades</div>
                </div>
                <button onClick={resetAll}
                  className="p-2.5 rounded-xl bg-secondary/40 hover:bg-secondary text-muted-foreground hover:text-foreground"
                  title="Cambiar ubicación" data-testid="mover-reset">
                  <RotateCcw className="w-5 h-5" />
                </button>
              </div>
            </div>

            {loading ? (
              <div className="flex items-center justify-center py-16"><Loader2 className="w-8 h-8 animate-spin text-primary" /></div>
            ) : contents.boxes.length === 0 && contents.lines.length === 0 ? (
              <div className="text-center py-12 text-muted-foreground">
                <Package className="w-12 h-12 mx-auto mb-3 opacity-30" />
                <p className="font-bold">Esta ubicación está vacía</p>
                <p className="text-xs mt-1">No hay cajas ni inventario en {origin}.</p>
              </div>
            ) : !mode ? (
              /* STEP 2 — choose mode */
              <div className="space-y-3">
                <div className="text-sm font-black uppercase tracking-wide text-muted-foreground flex items-center gap-2">
                  <span className="w-6 h-6 rounded-full bg-primary text-primary-foreground text-xs flex items-center justify-center font-black">2</span>
                  ¿Qué quieres mover?
                </div>
                <ModeButton icon={Layers} color="text-amber-400" testid="mover-mode-all"
                  title="Toda la ubicación"
                  subtitle={`${contents.boxes.length} caja(s) · ${totalUnits} unidades → otra ubicación`}
                  onClick={() => setMode("all")} />
                <ModeButton icon={Boxes} color="text-blue-400" testid="mover-mode-box"
                  title="Una o varias cajas"
                  subtitle="Escanea o elige cajas específicas"
                  onClick={() => setMode("box")} />
                <ModeButton icon={Package} color="text-emerald-400" testid="mover-mode-units"
                  title="Unidades (consolidar)"
                  subtitle="Mueve una cantidad de un SKU"
                  onClick={() => setMode("units")} />
                <ModeButton icon={Tag} color="text-fuchsia-400" testid="mover-mode-reconcile"
                  title="Reconciliar LPN / Etiqueta"
                  subtitle="Casa el LPN físico de una caja migrada"
                  onClick={() => setMode("reconcile")} />
              </div>
            ) : (
              /* STEP 3 — per-mode selection + destination */
              <div className="space-y-4">
                <button onClick={() => { setMode(null); setSelectedBoxes([]); setSelectedLine(null); setQty(""); setPhysicalLpn(""); setDest(""); }}
                  className="text-xs font-bold text-primary flex items-center gap-1">
                  <X className="w-3.5 h-3.5" /> Cambiar tipo de movimiento
                </button>

                {/* MODE: ALL */}
                {mode === "all" && (
                  <div className="bg-card border border-border rounded-2xl p-5 space-y-4">
                    <p className="text-sm">
                      Vas a mover <strong>todo</strong> el contenido de <span className="font-mono font-bold text-primary">{origin}</span>
                      {" "}({contents.boxes.length} cajas, {totalUnits} unidades) a otra ubicación.
                    </p>
                    <DestAndGo
                      dest={dest} setDest={setDest} locations={locNames}
                      disabled={submitting} onGo={moveAll}
                      label={`Mover TODO a`} />
                  </div>
                )}

                {/* MODE: BOX */}
                {mode === "box" && (
                  <div className="space-y-3">
                    <div className="bg-card border border-border rounded-2xl p-4 space-y-3">
                      <div className="text-xs uppercase tracking-wide text-muted-foreground font-black flex items-center gap-2">
                        <ScanLine className="w-4 h-4 text-primary" /> Escanea una caja para seleccionarla
                      </div>
                      <input ref={boxScanRef} autoFocus placeholder="Escanea BOX-…"
                        onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); onBoxScan(e.currentTarget.value); } }}
                        data-testid="mover-box-scan"
                        className="w-full h-12 px-4 bg-secondary/30 border-2 border-border rounded-xl font-mono font-bold focus:outline-none focus:border-primary" />
                    </div>
                    <div className="space-y-2 max-h-72 overflow-y-auto">
                      {contents.boxes.map(b => {
                        const on = selectedBoxes.includes(b.box_id);
                        return (
                          <button key={b.box_id} onClick={() => toggleBox(b.box_id)}
                            className={`w-full flex items-center gap-3 p-3 rounded-xl border text-left transition-all ${on ? "border-primary bg-primary/10 ring-1 ring-primary" : "border-border bg-card hover:border-primary/40"}`}>
                            <div className={`w-6 h-6 rounded-md flex items-center justify-center flex-shrink-0 ${on ? "bg-primary text-primary-foreground" : "bg-secondary"}`}>
                              {on && <CheckCircle2 className="w-4 h-4" />}
                            </div>
                            <div className="flex-1 min-w-0">
                              <div className="font-mono font-bold text-sm">{b.box_id}</div>
                              <div className="text-[11px] text-muted-foreground truncate">
                                {b.style || b.sku} · {b.color} · {b.size}
                              </div>
                            </div>
                            <div className="text-right flex-shrink-0">
                              <div className="font-black">{b.units ?? b.qty ?? 0}</div>
                              <div className="text-[10px] text-muted-foreground">u</div>
                            </div>
                          </button>
                        );
                      })}
                    </div>
                    {selectedBoxes.length > 0 && (
                      <div className="bg-card border border-border rounded-2xl p-4">
                        <DestAndGo
                          dest={dest} setDest={setDest} locations={locNames}
                          disabled={submitting} onGo={moveBoxes}
                          label={`Mover ${selectedBoxes.length} caja(s) a`} />
                      </div>
                    )}
                  </div>
                )}

                {/* MODE: UNITS */}
                {mode === "units" && (
                  <div className="space-y-3">
                    {!selectedLine ? (
                      <div className="space-y-2">
                        <div className="text-xs uppercase tracking-wide text-muted-foreground font-black flex items-center gap-2">
                          <Search className="w-4 h-4" /> Elige el SKU a mover
                        </div>
                        {contents.lines.map((r, i) => (
                          <button key={i} onClick={() => { setSelectedLine(r); setQty(String(r.units_on_hand || "")); }}
                            data-testid={`mover-units-line-${i}`}
                            className="w-full flex items-center justify-between p-3 rounded-xl border border-border bg-card hover:border-primary/40 text-left">
                            <div className="min-w-0">
                              <div className="font-mono font-bold text-sm truncate">{r.style || r.sku}</div>
                              <div className="text-[11px] text-muted-foreground truncate">{r.color} · {r.size}</div>
                            </div>
                            <div className="text-right flex-shrink-0">
                              <div className="font-black text-emerald-400">{r.units_on_hand}</div>
                              <div className="text-[10px] text-muted-foreground">disp.</div>
                            </div>
                          </button>
                        ))}
                      </div>
                    ) : (
                      <div className="bg-card border border-border rounded-2xl p-5 space-y-4">
                        <div className="flex items-center justify-between">
                          <div className="min-w-0">
                            <div className="font-mono font-black">{selectedLine.style || selectedLine.sku}</div>
                            <div className="text-xs text-muted-foreground">{selectedLine.color} · {selectedLine.size}</div>
                          </div>
                          <button onClick={() => { setSelectedLine(null); setQty(""); }}
                            className="text-xs font-bold text-primary">Cambiar</button>
                        </div>
                        <div>
                          <label className="text-xs uppercase tracking-wide text-muted-foreground font-black">
                            Cantidad a mover (máx {selectedLine.units_on_hand})
                          </label>
                          <div className="flex items-center gap-2 mt-1">
                            <input type="number" min="1" max={selectedLine.units_on_hand}
                              value={qty} onChange={(e) => setQty(e.target.value)}
                              data-testid="mover-units-qty"
                              className="flex-1 h-14 px-4 bg-secondary/30 border-2 border-border rounded-2xl text-xl font-black text-center focus:outline-none focus:border-primary" />
                            <button onClick={() => setQty(String(selectedLine.units_on_hand))}
                              className="h-14 px-4 rounded-2xl bg-primary/15 text-primary font-black text-sm uppercase">Todo</button>
                          </div>
                        </div>
                        <DestAndGo
                          dest={dest} setDest={setDest} locations={locNames}
                          disabled={submitting || !(parseInt(qty) > 0) || parseInt(qty) > selectedLine.units_on_hand}
                          onGo={moveUnits}
                          label={`Mover ${parseInt(qty) || 0} u a`} />
                      </div>
                    )}
                  </div>
                )}

                {/* MODE: RECONCILE LPN — match a migrated generic LPN to the box's real label */}
                {mode === "reconcile" && (
                  <div className="space-y-3">
                    {!selectedLine ? (
                      <div className="space-y-2">
                        <div className="text-xs uppercase tracking-wide text-muted-foreground font-black flex items-center gap-2">
                          <Search className="w-4 h-4" /> Elige el producto a reconciliar
                        </div>
                        {contents.lines.map((r, i) => (
                          <button key={i} onClick={() => { setSelectedLine(r); setQty("72"); setPhysicalLpn(""); }}
                            data-testid={`mover-reconcile-line-${i}`}
                            className="w-full flex items-center justify-between p-3 rounded-xl border border-border bg-card hover:border-primary/40 text-left">
                            <div className="min-w-0">
                              <div className="font-mono font-bold text-sm truncate">{r.style || r.sku}</div>
                              <div className="text-[11px] text-muted-foreground truncate">
                                {r.color} · {r.size}{r.description ? ` · ${r.description}` : ""}
                              </div>
                            </div>
                            <div className="text-right flex-shrink-0">
                              <div className="font-black text-emerald-400">{r.units_on_hand}</div>
                              <div className="text-[10px] text-muted-foreground">disp.</div>
                            </div>
                          </button>
                        ))}
                      </div>
                    ) : (
                      <div className="bg-card border border-border rounded-2xl p-5 space-y-4">
                        {/* Product validation header */}
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <div className="font-mono font-black">{selectedLine.style || selectedLine.sku}</div>
                            <div className="text-xs text-muted-foreground">{selectedLine.color} · {selectedLine.size}</div>
                            {selectedLine.description && (
                              <div className="text-xs text-muted-foreground mt-0.5">{selectedLine.description}</div>
                            )}
                            {(selectedLine.customer || selectedLine.manufacturer) && (
                              <div className="text-[11px] text-muted-foreground">
                                {selectedLine.customer}{selectedLine.manufacturer ? ` · ${selectedLine.manufacturer}` : ""}
                              </div>
                            )}
                          </div>
                          <button onClick={() => { setSelectedLine(null); setQty(""); setPhysicalLpn(""); }}
                            className="text-xs font-bold text-primary flex-shrink-0">Cambiar</button>
                        </div>

                        {/* Physical LPN scan */}
                        <div>
                          <label className="text-xs uppercase tracking-wide text-muted-foreground font-black flex items-center gap-2">
                            <ScanLine className="w-4 h-4 text-primary" /> Escanea el LPN físico de la caja
                          </label>
                          <input autoFocus value={physicalLpn}
                            onChange={(e) => setPhysicalLpn(e.target.value.toUpperCase())}
                            placeholder="Ej. A2600510001"
                            data-testid="mover-reconcile-lpn"
                            className="mt-1 w-full h-14 px-4 bg-secondary/30 border-2 border-border rounded-2xl text-lg font-mono font-bold tracking-wide focus:outline-none focus:border-primary" />
                        </div>

                        {/* Quantity (default 72, editable) */}
                        <div>
                          <label className="text-xs uppercase tracking-wide text-muted-foreground font-black">
                            Cantidad en la caja (default 72)
                          </label>
                          <input type="number" min="1" value={qty} onChange={(e) => setQty(e.target.value)}
                            data-testid="mover-reconcile-qty"
                            className="mt-1 w-full h-14 px-4 bg-secondary/30 border-2 border-border rounded-2xl text-xl font-black text-center focus:outline-none focus:border-primary" />
                        </div>

                        <DestAndGo
                          dest={dest} setDest={setDest} locations={locNames}
                          disabled={submitting || !physicalLpn.trim() || !(parseInt(qty) > 0)}
                          onGo={moveReconcile}
                          label={`Casar LPN y mover a`} />
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

// Shared destination input + confirm button used by every mode.
function DestAndGo({ dest, setDest, locations, disabled, onGo, label }) {
  return (
    <div className="space-y-3">
      <div className="text-xs uppercase tracking-wide text-muted-foreground font-black flex items-center gap-2">
        <span className="w-5 h-5 rounded-full bg-primary text-primary-foreground text-[10px] flex items-center justify-center font-black">3</span>
        Escanea la ubicación DESTINO
      </div>
      <LocationInput
        value={dest} onChange={setDest} onSubmit={(v) => setDest(v)} onPick={(v) => setDest(v)}
        locations={locations} placeholder="Ubicación destino" testid="mover-dest-input"
      />
      <button onClick={onGo} disabled={disabled || !dest.trim()}
        data-testid="mover-confirm"
        className="w-full h-14 rounded-2xl bg-green-600 hover:bg-green-700 disabled:opacity-40 disabled:cursor-not-allowed text-white font-black uppercase tracking-wide flex items-center justify-center gap-2 active:scale-[0.98] transition-transform">
        <Move className="w-5 h-5" /> {label} {dest ? <span className="font-mono">{dest}</span> : ""}
      </button>
    </div>
  );
}
