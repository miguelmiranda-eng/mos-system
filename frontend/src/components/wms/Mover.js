import { useState, useEffect, useMemo, useRef, useCallback } from "react";
import { toast } from "sonner";
import {
  ScanLine, MapPin, Boxes, Package, Layers, ArrowRight, Loader2,
  CheckCircle2, RotateCcw, Search, X, Move, Tag, Scale,
} from "lucide-react";
import { fetcher, poster, cleanScan, logLoadError } from "./lib";
import BulkInventoryAdjust from "./BulkInventoryAdjust";

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

export function MoverModule({ currentUser }) {
  // Top-level mode: the classic origin→destination move, a box-first inventory
  // adjustment (Case# 002), or the bulk Excel inventory adjustment (admin L3+).
  const [topMode, setTopMode] = useState("move"); // 'move' | 'adjust' | 'bulk'
  // Bulk inventory adjustment is gated to admin level 3+ (supersu = max level).
  const adminLevel = currentUser?.role === 'supersu'
    ? 5
    : (currentUser?.role === 'admin' ? (parseInt(currentUser?.admin_level, 10) || 1) : 0);
  const canBulk = adminLevel >= 3;

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
  const [foreignBoxes, setForeignBoxes] = useState([]);     // box mode: boxes scanned from OTHER locations
  const [pendingForeign, setPendingForeign] = useState(null); // a foreign box awaiting "move it anyway?" confirm
  const [scanLookup, setScanLookup] = useState(false);      // looking up a scanned code
  const [selectedLine, setSelectedLine] = useState(null);   // units/reconcile mode: an inventory line
  const [qty, setQty] = useState("");
  const [physicalLpn, setPhysicalLpn] = useState("");       // reconcile mode: scanned real LPN

  // ── Adjust-by-box mode (Case# 002) ──────────────────────────────────────────
  const [adjScan, setAdjScan] = useState("");        // code typed/scanned
  const [adjBox, setAdjBox] = useState(null);        // resolved box doc
  const [adjLookup, setAdjLookup] = useState(false); // resolving a scan
  const [adjCount, setAdjCount] = useState("");      // real counted units
  const [adjReason, setAdjReason] = useState("");    // mandatory free-text reason
  const [adjSubmitting, setAdjSubmitting] = useState(false);
  const adjScanRef = useRef(null);

  const resetAdjust = useCallback(() => {
    setAdjScan(""); setAdjBox(null); setAdjLookup(false);
    setAdjCount(""); setAdjReason(""); setAdjSubmitting(false);
  }, []);

  // Resolve the scanned code into a box and prefill its current count.
  const lookupAdjBox = async (raw) => {
    const code = cleanScan(raw);
    if (!code) return;
    setAdjLookup(true);
    try {
      const box = await fetcher(`/boxes/${encodeURIComponent(code)}`);
      if (!box || !box.box_id) { toast.error(`Caja ${code} no existe`); return; }
      setAdjBox(box);
      setAdjCount(String(box.units ?? box.qty ?? 0));
      setAdjReason("");
    } catch {
      toast.error(`Caja ${code} no encontrada`);
    } finally { setAdjLookup(false); }
  };

  const submitAdjust = async () => {
    const counted = parseInt(adjCount, 10);
    if (!(counted >= 0)) { toast.error("Captura las unidades contadas"); return; }
    if (!adjReason.trim()) { toast.error("El motivo es obligatorio"); return; }
    setAdjSubmitting(true);
    try {
      const res = await poster(`/boxes/${encodeURIComponent(adjBox.box_id)}/adjust`, {
        counted_units: counted, reason: adjReason.trim(),
      });
      if (res.ok) {
        const data = await res.json().catch(() => ({}));
        const d = data.delta_units ?? 0;
        toast.success(
          `Caja ${data.box_id}: ${data.old_units} → ${data.new_units} u (${d > 0 ? "+" : ""}${d})`
            + (data.box_deleted ? " · caja vaciada y eliminada" : "")
        );
        resetAdjust();
        adjScanRef.current?.focus();
      } else {
        const err = await res.json().catch(() => ({}));
        toast.error(err.detail || "No se pudo ajustar la caja");
      }
    } catch {
      toast.error("Error de conexión");
    } finally { setAdjSubmitting(false); }
  };

  // Known location names for the type-to-search chips (fetched once).
  const [locNames, setLocNames] = useState([]);
  useEffect(() => {
    fetcher("/locations/names")
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
    setForeignBoxes([]);
    setPendingForeign(null);
    setSelectedLine(null);
    setQty("");
    setPhysicalLpn("");
    setDest("");
    loadContents(clean);
  };

  const resetAll = () => {
    setOrigin(""); setOriginInput(""); setMode(null);
    setContents({ boxes: [], lines: [] });
    setSelectedBoxes([]); setForeignBoxes([]); setPendingForeign(null); setSelectedLine(null); setQty(""); setPhysicalLpn(""); setDest("");
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
        setMode(null); setSelectedBoxes([]); setForeignBoxes([]); setPendingForeign(null); setSelectedLine(null); setQty(""); setPhysicalLpn(""); setDest("");
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

  // Scanning a box barcode in box mode. If the box belongs to the scanned origin
  // we toggle it. If it lives elsewhere, we look it up and ask "move it anyway?"
  // (relocate works from any source, rebalancing the box's real location).
  const boxScanRef = useRef(null);
  const clearBoxInput = () => { if (boxScanRef.current) boxScanRef.current.value = ""; };
  const onBoxScan = async (raw) => {
    const code = cleanScan(raw);
    if (!code) return;
    const here = contents.boxes.find(b => (b.box_id || "").toUpperCase() === code || (b.barcode || "").toUpperCase() === code);
    const already = foreignBoxes.find(b => (b.box_id || "").toUpperCase() === code || (b.barcode || "").toUpperCase() === code);
    if (here) { toggleBox(here.box_id); clearBoxInput(); return; }
    if (already) { toggleBox(already.box_id); clearBoxInput(); return; }
    // Not in this location — find where it actually is.
    setScanLookup(true);
    try {
      const box = await fetcher(`/boxes/${encodeURIComponent(code)}`);
      clearBoxInput();
      if (!box || !box.box_id) { toast.error(`Caja ${code} no existe`); return; }
      if ((box.location || "").toUpperCase() === origin.toUpperCase()) {
        addForeignBox(box); // belongs here but wasn't in the loaded list
      } else {
        setPendingForeign(box); // ask before pulling it from another slot
      }
    } catch {
      clearBoxInput();
      toast.error(`Caja ${code} no encontrada`);
    } finally { setScanLookup(false); }
  };

  // Bring a box from another location into the selection + the visible list.
  const addForeignBox = (box) => {
    setForeignBoxes(p => p.some(b => b.box_id === box.box_id) ? p : [{ ...box, _foreign: true }, ...p]);
    setSelectedBoxes(p => p.includes(box.box_id) ? p : [...p, box.box_id]);
    setPendingForeign(null);
  };

  // ── Render ──────────────────────────────────────────────────────────────────
  return (
    <div className="h-full overflow-y-auto bg-background text-foreground">
      <div className="max-w-2xl mx-auto p-4 sm:p-6 space-y-5">
        {/* Title */}
        <div className="flex items-center gap-3">
          <div className="p-2.5 rounded-2xl bg-primary/10"><Move className="w-7 h-7 text-primary" /></div>
          <div>
            <h1 className="text-xl font-black uppercase tracking-tight">
              {topMode === "bulk" ? "Ajuste Masivo" : topMode === "adjust" ? "Ajustar Caja" : "Mover Material"}
            </h1>
            <p className="text-xs text-muted-foreground">
              {topMode === "bulk"
                ? "Sube el Excel para ajustar inventario en bloque"
                : topMode === "adjust"
                  ? "Escanea una caja y captura su conteo real"
                  : "Escanea una ubicación y elige qué mover"}
            </p>
          </div>
        </div>

        {/* Top-level toggle: move vs adjust-by-box (Case# 002) vs bulk (admin L3+) */}
        <div className={`grid ${canBulk ? "grid-cols-3" : "grid-cols-2"} gap-2 p-1 rounded-2xl bg-secondary/30 border border-border`}>
          <button
            onClick={() => { if (topMode !== "move") { resetAdjust(); setTopMode("move"); } }}
            data-testid="mover-top-move"
            className={`flex items-center justify-center gap-2 py-2.5 rounded-xl text-xs font-black uppercase tracking-widest transition-all ${topMode === "move" ? "bg-primary text-primary-foreground shadow-md" : "text-muted-foreground hover:text-foreground"}`}>
            <Move className="w-4 h-4" /> Mover
          </button>
          <button
            onClick={() => { if (topMode !== "adjust") { resetAll(); setTopMode("adjust"); } }}
            data-testid="mover-top-adjust"
            className={`flex items-center justify-center gap-2 py-2.5 rounded-xl text-xs font-black uppercase tracking-widest transition-all ${topMode === "adjust" ? "bg-primary text-primary-foreground shadow-md" : "text-muted-foreground hover:text-foreground"}`}>
            <Scale className="w-4 h-4" /> Ajustar caja
          </button>
          {canBulk && (
            <button
              onClick={() => { if (topMode !== "bulk") { resetAll(); resetAdjust(); setTopMode("bulk"); } }}
              data-testid="mover-top-bulk"
              className={`flex items-center justify-center gap-2 py-2.5 rounded-xl text-xs font-black uppercase tracking-widest transition-all ${topMode === "bulk" ? "bg-primary text-primary-foreground shadow-md" : "text-muted-foreground hover:text-foreground"}`}>
              <Boxes className="w-4 h-4" /> Ajuste masivo
            </button>
          )}
        </div>

        {/* ── BULK INVENTORY ADJUST (Excel · admin L3+) ─────────────────────── */}
        {topMode === "bulk" ? (
          <BulkInventoryAdjust />
        ) : topMode === "adjust" ? (
          !adjBox ? (
            <div className="bg-card border border-border rounded-2xl p-5 space-y-3">
              <div className="text-sm font-black uppercase tracking-wide text-muted-foreground flex items-center gap-2">
                <ScanLine className="w-5 h-5 text-primary" /> Escanea el número de caja
              </div>
              <form onSubmit={(e) => { e.preventDefault(); lookupAdjBox(adjScan); }} className="flex items-center gap-2">
                <input
                  ref={adjScanRef} autoFocus value={adjScan}
                  onChange={(e) => setAdjScan(e.target.value.toUpperCase())}
                  placeholder="Ej. BOX-000143 · LPN…"
                  data-testid="mover-adjust-scan"
                  className="flex-1 h-14 px-4 bg-secondary/30 border-2 border-border rounded-2xl text-lg font-mono font-bold tracking-wide focus:outline-none focus:border-primary" />
                <button type="submit" disabled={adjLookup || !adjScan.trim()}
                  className="h-14 px-5 rounded-2xl bg-primary text-primary-foreground font-black uppercase text-sm disabled:opacity-40 active:scale-95 transition-transform">
                  {adjLookup ? <Loader2 className="w-5 h-5 animate-spin" /> : "Buscar"}
                </button>
              </form>
              <p className="text-[11px] text-muted-foreground">
                El ajuste queda enlazado al número de caja y se registra en su historial de movimientos.
              </p>
            </div>
          ) : (
            <div className="space-y-4">
              {/* Box summary */}
              <div className="bg-card border border-primary/30 rounded-2xl p-4 space-y-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-[10px] uppercase tracking-widest text-muted-foreground font-black">Caja</div>
                    <div className="text-lg font-mono font-black truncate">{adjBox.box_id}</div>
                    <div className="text-xs text-muted-foreground mt-0.5 truncate">
                      {(adjBox.style || adjBox.sku)} · {adjBox.color} · {adjBox.size}
                    </div>
                    <div className="text-[11px] text-muted-foreground flex items-center gap-1 mt-1">
                      <MapPin className="w-3.5 h-3.5 text-cyan-400" />
                      {adjBox.location || "sin ubicación"}
                    </div>
                  </div>
                  <div className="text-right flex-shrink-0">
                    <div className="text-2xl font-black leading-none">{adjBox.units ?? adjBox.qty ?? 0}</div>
                    <div className="text-[10px] uppercase tracking-widest text-muted-foreground">u actuales</div>
                  </div>
                </div>
                <button onClick={resetAdjust} className="text-xs font-bold text-primary flex items-center gap-1">
                  <RotateCcw className="w-3.5 h-3.5" /> Cambiar caja
                </button>
              </div>

              {/* Counted units + reason */}
              <div className="bg-card border border-border rounded-2xl p-5 space-y-4">
                <div>
                  <label className="text-xs uppercase tracking-wide text-muted-foreground font-black">
                    Unidades reales contadas
                  </label>
                  <input type="number" min="0" value={adjCount}
                    onChange={(e) => setAdjCount(e.target.value)}
                    data-testid="mover-adjust-count"
                    className="mt-1 w-full h-16 px-4 bg-secondary/30 border-2 border-border rounded-2xl text-3xl font-black text-center focus:outline-none focus:border-primary" />
                  {adjCount !== "" && !Number.isNaN(parseInt(adjCount, 10)) && (() => {
                    const d = parseInt(adjCount, 10) - (adjBox.units ?? adjBox.qty ?? 0);
                    if (d === 0) return <p className="text-[11px] text-muted-foreground mt-1 text-center">Sin cambio</p>;
                    return (
                      <p className={`text-xs font-black mt-1 text-center ${d > 0 ? "text-emerald-400" : "text-red-400"}`}>
                        {d > 0 ? "+" : ""}{d} unidades{parseInt(adjCount, 10) === 0 ? " · la caja se eliminará" : ""}
                      </p>
                    );
                  })()}
                </div>
                <div>
                  <label className="text-xs uppercase tracking-wide text-muted-foreground font-black">
                    Motivo del ajuste <span className="text-red-400">*</span>
                  </label>
                  <textarea value={adjReason} onChange={(e) => setAdjReason(e.target.value)}
                    rows={2} placeholder="Ej. Conteo físico, caja dañada, error de captura…"
                    data-testid="mover-adjust-reason"
                    className="mt-1 w-full px-4 py-3 bg-secondary/30 border-2 border-border rounded-2xl text-sm focus:outline-none focus:border-primary resize-none" />
                </div>
                <button onClick={submitAdjust}
                  disabled={adjSubmitting || adjCount === "" || !adjReason.trim()
                    || parseInt(adjCount, 10) === (adjBox.units ?? adjBox.qty ?? 0)}
                  data-testid="mover-adjust-confirm"
                  className="w-full h-14 rounded-2xl bg-green-600 hover:bg-green-700 disabled:opacity-40 disabled:cursor-not-allowed text-white font-black uppercase tracking-wide flex items-center justify-center gap-2 active:scale-[0.98] transition-transform">
                  {adjSubmitting ? <Loader2 className="w-5 h-5 animate-spin" /> : <Scale className="w-5 h-5" />}
                  Confirmar ajuste
                </button>
              </div>
            </div>
          )
        ) : /* STEP 1 — origin */
        !origin ? (
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
                      {scanLookup && (
                        <div className="text-[11px] text-muted-foreground flex items-center gap-2">
                          <Loader2 className="w-3.5 h-3.5 animate-spin" /> Buscando caja…
                        </div>
                      )}
                    </div>

                    {/* Foreign box: scanned from a DIFFERENT location — confirm before moving */}
                    {pendingForeign && (
                      <div className="bg-amber-500/10 border-2 border-amber-500/40 rounded-2xl p-4 space-y-3" data-testid="mover-foreign-confirm">
                        <div className="flex items-start gap-3">
                          <ScanLine className="w-5 h-5 text-amber-400 flex-shrink-0 mt-0.5" />
                          <div className="min-w-0 text-sm">
                            La caja <span className="font-mono font-black">{pendingForeign.box_id}</span> no está en{" "}
                            <span className="font-mono font-bold">{origin}</span>.
                            <div className="mt-1">
                              Pertenece a <span className="font-mono font-black text-amber-300">{pendingForeign.location || "ubicación desconocida"}</span>
                              {" · "}{pendingForeign.style || pendingForeign.sku} · {pendingForeign.color} · {pendingForeign.size}
                              {" · "}{pendingForeign.units ?? pendingForeign.qty ?? 0} u
                            </div>
                          </div>
                        </div>
                        <div className="flex gap-2">
                          <button onClick={() => addForeignBox(pendingForeign)}
                            data-testid="mover-foreign-yes"
                            className="flex-1 h-12 rounded-xl bg-amber-500 text-black font-black uppercase tracking-wide text-sm active:scale-[0.98] transition-transform">
                            Sí, moverla
                          </button>
                          <button onClick={() => setPendingForeign(null)}
                            className="px-5 h-12 rounded-xl bg-secondary/60 text-muted-foreground font-bold uppercase text-sm">
                            Cancelar
                          </button>
                        </div>
                      </div>
                    )}

                    <div className="space-y-2 max-h-72 overflow-y-auto">
                      {[...foreignBoxes, ...contents.boxes].map(b => {
                        const on = selectedBoxes.includes(b.box_id);
                        return (
                          <button key={b.box_id} onClick={() => toggleBox(b.box_id)}
                            className={`w-full flex items-center gap-3 p-3 rounded-xl border text-left transition-all ${on ? "border-primary bg-primary/10 ring-1 ring-primary" : "border-border bg-card hover:border-primary/40"}`}>
                            <div className={`w-6 h-6 rounded-md flex items-center justify-center flex-shrink-0 ${on ? "bg-primary text-primary-foreground" : "bg-secondary"}`}>
                              {on && <CheckCircle2 className="w-4 h-4" />}
                            </div>
                            <div className="flex-1 min-w-0">
                              <div className="font-mono font-bold text-sm flex items-center gap-2">
                                {b.box_id}
                                {b._foreign && (
                                  <span className="text-[9px] font-black uppercase tracking-widest text-amber-300 bg-amber-500/15 px-1.5 py-0.5 rounded">
                                    de {b.location}
                                  </span>
                                )}
                              </div>
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
