import { useState, useEffect, useMemo, useRef, useCallback } from "react";
import { toast } from "sonner";
import {
  ScanLine, MapPin, Boxes, Package, Layers, ArrowRight, Loader2,
  CheckCircle2, RotateCcw, Search, X, Move, Tag, Scale, Printer,
} from "lucide-react";
import { fetcher, poster, cleanScan, logLoadError, API, useWmsSizes, useWmsCatalogs, mergeUnique } from "./lib";
import SearchableSelect from "../SearchableSelect";
import BulkInventoryAdjust from "./BulkInventoryAdjust";
import { ModuleHeader, SoftAlert, Btn, Chip } from "./ui";

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
          <ScanLine className="w-5 h-5 text-muted-foreground absolute left-3 top-1/2 -translate-y-1/2" />
          <input
            autoFocus={autoFocus}
            value={value}
            onChange={(e) => { onChange(e.target.value.toUpperCase()); setOpen(true); }}
            onFocus={() => setOpen(true)}
            placeholder={placeholder}
            data-testid={testid}
            className="w-full h-14 pl-11 pr-10 bg-card border border-input rounded-lg text-lg font-mono placeholder:text-muted-foreground/60 focus:outline-none focus:ring-2 focus:ring-ring/25 focus:border-ring transition-colors"
          />
          {value && (
            <button type="button" onClick={() => { onChange(""); setOpen(false); }}
              className="absolute right-3 top-1/2 -translate-y-1/2 p-1 rounded-lg text-muted-foreground hover:text-foreground">
              <X className="w-4 h-4" />
            </button>
          )}
        </div>
        <button type="submit"
          className="h-14 px-5 rounded-md bg-primary text-primary-foreground text-sm font-medium hover:opacity-90 transition-colors">
          OK
        </button>
      </form>
      {open && matches.length > 0 && (
        <div className="absolute z-20 mt-1 w-full bg-card border border-border rounded-lg shadow-xl overflow-hidden">
          {matches.map(n => (
            <button key={n} type="button"
              onClick={() => { onChange(n); setOpen(false); onPick ? onPick(n) : onSubmit?.(n); }}
              className="w-full flex items-center gap-2 px-4 py-3 text-left hover:bg-muted border-b border-border/60 last:border-0 transition-colors">
              <MapPin className="w-4 h-4 text-muted-foreground flex-shrink-0" />
              <span className="font-mono font-medium">{n}</span>
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
      className="w-full flex items-center gap-4 p-5 rounded-lg border border-border bg-card hover:bg-muted/40 transition-colors text-left">
      <Icon className="w-6 h-6 text-muted-foreground flex-shrink-0" />
      <div className="flex-1 min-w-0">
        <div className="text-base font-semibold">{title}</div>
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
  // Manual inventory adjustments (box-level "Ajustar caja" and the bulk Excel
  // adjust) are gated to WMS inventory level 2+. Admins/supersu count as max.
  const invLevel = ['admin', 'supersu'].includes(currentUser?.role)
    ? 3
    : (parseInt(currentUser?.inventory_level, 10) || 0);
  const canAdjust = invLevel >= 2;
  const canBulk = invLevel >= 2;
  const _visibleTopTabs = 2 + (canAdjust ? 1 : 0) + (canBulk ? 1 : 0);
  const topTabsGridClass = _visibleTopTabs >= 4 ? 'grid-cols-4' : (_visibleTopTabs === 3 ? 'grid-cols-3' : 'grid-cols-2');

  // Flow: origin → mode → (per-mode selection) → destination → submit.
  const [origin, setOrigin] = useState("");
  const [originInput, setOriginInput] = useState("");
  const [mode, setMode] = useState(null); // 'all' | 'box' | 'units' | 'reconcile'
  // Generar caja (material de producción sin LPN)
  // country_of_origin y fabric_content son el LOTE: junto con style/color/talla
  // forman la identidad del material (services/inventory_ledger.py). Sin ellos
  // la caja nace con firma vacía, no casa con ningún renglón y el reescritor la
  // trata como lote aparte — y el país es requisito de etiquetado para
  // exportación. El backend ya los aceptaba y los valida contra el catálogo
  // curado; este formulario simplemente no los mandaba.
  const [genForm, setGenForm] = useState({ style: '', color: '', size: '', units: '', customer: '', location: '', country_of_origin: '', fabric_content: '' });
  const [genSubmitting, setGenSubmitting] = useState(false);
  const [genLastBox, setGenLastBox] = useState('');
  // Style/color options for the generate-box form — solo-catálogo (los valores
  // nuevos se agregan únicamente desde el módulo de configuración).
  const [genOptions, setGenOptions] = useState({ styles: [], colors: [], customers: [] });
  useEffect(() => {
    fetcher('/inventory/options?')
      .then(d => setGenOptions({ styles: d.styles || [], colors: d.colors || [], customers: d.customers || [] }))
      .catch(() => {});
  }, []);
  // Tallas y clientes curados para "Generar caja" — select-only, igual que Receiving.
  const { all: genSizeOptions } = useWmsSizes();
  const genCat = useWmsCatalogs();
  const genCustomerOptions = mergeUnique(genCat.customers, genOptions.customers);
  const genCountryOptions = mergeUnique(genCat.countries);
  const genFabricOptions = mergeUnique(genCat.fabrics);
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
  const [selectedUnitBox, setSelectedUnitBox] = useState(null); // units mode: la caja ESPECÍFICA a partir/mover (sin FIFO)
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
    setSelectedUnitBox(null);
    setQty("");
    setPhysicalLpn("");
    setDest("");
    loadContents(clean);
  };

  const resetAll = () => {
    setOrigin(""); setOriginInput(""); setMode(null);
    setContents({ boxes: [], lines: [] });
    setSelectedBoxes([]); setForeignBoxes([]); setPendingForeign(null); setSelectedLine(null); setSelectedUnitBox(null); setQty(""); setPhysicalLpn(""); setDest("");
  };

  const totalUnits = useMemo(
    () => contents.lines.reduce((s, r) => s + (r.units_on_hand || 0), 0),
    [contents.lines]
  );

  // ── Generar caja para material de producción sin LPN ───────────────────────
  const printBox = (boxId) => window.open(`${API}/labels/box/${encodeURIComponent(boxId)}`, '_blank');
  const handleGenerateBox = async () => {
    if (!genForm.style.trim() || !genForm.location.trim() || !(Number(genForm.units) > 0)) {
      toast.error('Estilo, unidades (>0) y ubicación son requeridos'); return;
    }
    // El lote no bloquea —en piso puede tocar material sin etiqueta legible—
    // pero se avisa qué se pierde: una caja sin país ni composición no casa con
    // su renglón de inventario, y el país es requisito de etiquetado al exportar.
    if (!genForm.country_of_origin.trim() || !genForm.fabric_content.trim()) {
      const seguir = window.confirm(
        'La caja se creará SIN país de origen o sin contenido de tela.\n\n' +
        'Esos campos son la identidad del lote: sin ellos la caja no se puede casar ' +
        'con su renglón de inventario, y el país es requisito de etiquetado para ' +
        'exportación.\n\n¿Continuar de todas formas?');
      if (!seguir) return;
    }
    setGenSubmitting(true);
    try {
      const res = await poster('/boxes/generate', { ...genForm, units: Number(genForm.units) });
      if (res.ok) {
        const data = await res.json();
        toast.success(`Caja ${data.box_id} generada — imprimiendo etiqueta`);
        setGenLastBox(data.box_id);
        printBox(data.box_id);
        // Keep location/customer for batch tagging; clear the per-box fields.
        setGenForm(f => ({ ...f, style: '', color: '', size: '', units: '' }));
      } else {
        const err = await res.json().catch(() => ({}));
        toast.error(err.detail || 'No se pudo generar la caja');
      }
    } catch { toast.error('Error de conexión'); }
    finally { setGenSubmitting(false); }
  };

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
        setMode(null); setSelectedBoxes([]); setForeignBoxes([]); setPendingForeign(null); setSelectedLine(null); setSelectedUnitBox(null); setQty(""); setPhysicalLpn(""); setDest("");
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
    // SIN FIFO: la caja ESPECÍFICA seleccionada/escaneada de la que se parte/mueve.
    box_id: selectedUnitBox?.box_id,
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
        <ModuleHeader
          title={topMode === "bulk" ? "Ajuste Masivo" : topMode === "adjust" ? "Ajustar Caja" : topMode === "generate" ? "Generar Caja" : "Mover Material"}
          subtitle={topMode === "bulk"
            ? "Sube el Excel para ajustar inventario en bloque"
            : topMode === "adjust"
              ? "Escanea una caja y captura su conteo real"
              : topMode === "generate"
                ? "Crea un número de caja para material de producción e imprímelo"
                : "Escanea una ubicación y elige qué mover"}
        />

        {/* Top-level toggle: move vs adjust-by-box (Case# 002) vs bulk (admin L3+) */}
        <div className={`grid ${topTabsGridClass} gap-2 p-1 rounded-lg bg-muted/50 border border-border`}>
          <button
            onClick={() => { if (topMode !== "move") { resetAdjust(); setTopMode("move"); } }}
            data-testid="mover-top-move"
            className={`flex items-center justify-center gap-2 py-2 rounded-md text-sm font-medium transition-colors ${topMode === "move" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"}`}>
            <Move className="w-4 h-4" /> Mover
          </button>
          {canAdjust && (
          <button
            onClick={() => { if (topMode !== "adjust") { resetAll(); setTopMode("adjust"); } }}
            data-testid="mover-top-adjust"
            className={`flex items-center justify-center gap-2 py-2 rounded-md text-sm font-medium transition-colors ${topMode === "adjust" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"}`}>
            <Scale className="w-4 h-4" /> Ajustar caja
          </button>
          )}
          <button
            onClick={() => { if (topMode !== "generate") { resetAll(); resetAdjust(); setTopMode("generate"); } }}
            data-testid="mover-top-generate"
            className={`flex items-center justify-center gap-2 py-2 rounded-md text-sm font-medium transition-colors ${topMode === "generate" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"}`}>
            <Tag className="w-4 h-4" /> Generar caja
          </button>
          {canBulk && (
            <button
              onClick={() => { if (topMode !== "bulk") { resetAll(); resetAdjust(); setTopMode("bulk"); } }}
              data-testid="mover-top-bulk"
              className={`flex items-center justify-center gap-2 py-2 rounded-md text-sm font-medium transition-colors ${topMode === "bulk" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"}`}>
              <Boxes className="w-4 h-4" /> Ajuste masivo
            </button>
          )}
        </div>

        {/* ── BULK INVENTORY ADJUST (Excel · admin L3+) ─────────────────────── */}
        {topMode === "bulk" ? (
          <BulkInventoryAdjust />
        ) : topMode === "generate" ? (
          <div className="bg-card border border-border rounded-lg p-5 space-y-4">
            <div className="text-sm font-semibold text-foreground flex items-center gap-2">
              <Tag className="w-5 h-5 text-muted-foreground" /> Generar caja para material de producción
            </div>
            <p className="text-xs text-muted-foreground">
              Material que llega de producción sin etiqueta: crea su número de caja (LPN), imprímelo y pégalo en la caja física. Después podrás moverla o ajustarla normalmente.
            </p>
            <div className="grid grid-cols-2 gap-3">
              <SearchableSelect options={genOptions.styles} value={genForm.style}
                onChange={v => setGenForm(f => ({ ...f, style: v }))}
                placeholder="Estilo * (solo catálogo)" testId="gen-style" allowCreate={false} />
              <SearchableSelect options={genOptions.colors} value={genForm.color}
                onChange={v => setGenForm(f => ({ ...f, color: v }))}
                placeholder="Color (solo catálogo)" testId="gen-color" allowCreate={false} />
              <SearchableSelect options={genSizeOptions} value={genForm.size}
                onChange={v => setGenForm(f => ({ ...f, size: v }))}
                placeholder="Talla (solo catálogo)" testId="gen-size" allowCreate={false} />
              <input type="number" min="1" value={genForm.units} onChange={e => setGenForm(f => ({ ...f, units: e.target.value }))}
                placeholder="Unidades *" data-testid="gen-units"
                className="h-12 px-3 bg-card border border-input rounded-md text-lg font-medium tabular-nums focus:outline-none focus:ring-2 focus:ring-ring/25 focus:border-ring transition-colors" />
              <SearchableSelect options={genCustomerOptions} value={genForm.customer}
                onChange={v => setGenForm(f => ({ ...f, customer: v }))}
                placeholder="Cliente (solo catálogo)" testId="gen-customer" allowCreate={false} />
              <SearchableSelect options={locNames} value={genForm.location}
                onChange={v => setGenForm(f => ({ ...f, location: v }))}
                placeholder="Ubicación * (existente)" testId="gen-location" allowCreate={false} />
              {/* El LOTE. Sólo catálogo, como el resto: con texto libre vuelven a
                  entrar valores como 'WASH COLD' en el campo país, que hubo que
                  limpiar de 748 cajas. Se conservan al generar la siguiente caja
                  (igual que ubicación y cliente) porque un lote se etiqueta en tanda. */}
              <SearchableSelect options={genCountryOptions} value={genForm.country_of_origin}
                onChange={v => setGenForm(f => ({ ...f, country_of_origin: v }))}
                placeholder="País de origen * (solo catálogo)" testId="gen-coo" allowCreate={false} />
              <SearchableSelect options={genFabricOptions} value={genForm.fabric_content}
                onChange={v => setGenForm(f => ({ ...f, fabric_content: v }))}
                placeholder="Contenido de tela * (solo catálogo)" testId="gen-fabric" allowCreate={false} />
            </div>
            <button onClick={handleGenerateBox} disabled={genSubmitting} data-testid="gen-submit"
              className="w-full h-14 rounded-md bg-primary text-primary-foreground text-sm font-medium hover:opacity-90 flex items-center justify-center gap-2 disabled:opacity-50 transition-colors">
              {genSubmitting ? <Loader2 className="w-5 h-5 animate-spin" /> : <Printer className="w-5 h-5" />}
              Generar e imprimir etiqueta
            </button>
            {genLastBox && (
              <SoftAlert
                tone="success"
                action={
                  <button onClick={() => printBox(genLastBox)} className="flex items-center gap-1 text-xs font-medium text-primary hover:underline">
                    <Printer className="w-3.5 h-3.5" /> Reimprimir
                  </button>
                }
              >
                Última caja: <span className="font-mono font-medium text-foreground">{genLastBox}</span>
              </SoftAlert>
            )}
          </div>
        ) : topMode === "adjust" ? (
          !adjBox ? (
            <div className="bg-card border border-border rounded-lg p-5 space-y-3">
              <div className="text-sm font-semibold text-foreground flex items-center gap-2">
                <ScanLine className="w-5 h-5 text-muted-foreground" /> Escanea el número de caja
              </div>
              <form onSubmit={(e) => { e.preventDefault(); lookupAdjBox(adjScan); }} className="flex items-center gap-2">
                <input
                  ref={adjScanRef} autoFocus value={adjScan}
                  onChange={(e) => setAdjScan(e.target.value.toUpperCase())}
                  placeholder="Ej. BOX-000143 · LPN…"
                  data-testid="mover-adjust-scan"
                  className="flex-1 h-14 px-4 bg-card border border-input rounded-lg text-lg font-mono placeholder:text-muted-foreground/60 focus:outline-none focus:ring-2 focus:ring-ring/25 focus:border-ring transition-colors" />
                <button type="submit" disabled={adjLookup || !adjScan.trim()}
                  className="h-14 px-5 rounded-md bg-primary text-primary-foreground text-sm font-medium hover:opacity-90 disabled:opacity-50 transition-colors">
                  {adjLookup ? <Loader2 className="w-5 h-5 animate-spin" /> : "Buscar"}
                </button>
              </form>
              <p className="text-xs text-muted-foreground">
                El ajuste queda enlazado al número de caja y se registra en su historial de movimientos.
              </p>
            </div>
          ) : (
            <div className="space-y-4">
              {/* Box summary */}
              <div className="bg-card border border-border rounded-lg p-4 space-y-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-xs font-medium text-muted-foreground">Caja</div>
                    <div className="text-lg font-mono font-semibold truncate">{adjBox.box_id}</div>
                    <div className="text-xs text-muted-foreground mt-0.5 truncate">
                      {(adjBox.style || adjBox.sku)} · {adjBox.color} · {adjBox.size}
                    </div>
                    <div className="text-xs text-muted-foreground flex items-center gap-1 mt-1">
                      <MapPin className="w-3.5 h-3.5 text-muted-foreground" />
                      {adjBox.location || "sin ubicación"}
                    </div>
                  </div>
                  <div className="text-right flex-shrink-0">
                    <div className="text-2xl font-semibold tabular-nums leading-none">{adjBox.units ?? adjBox.qty ?? 0}</div>
                    <div className="text-xs text-muted-foreground">u actuales</div>
                  </div>
                </div>
                <button onClick={resetAdjust} className="text-xs font-medium text-primary flex items-center gap-1">
                  <RotateCcw className="w-3.5 h-3.5" /> Cambiar caja
                </button>
              </div>

              {/* Counted units + reason */}
              <div className="bg-card border border-border rounded-lg p-5 space-y-4">
                <div>
                  <label className="text-xs font-medium text-muted-foreground">
                    Unidades reales contadas
                  </label>
                  <input type="number" min="0" value={adjCount}
                    onChange={(e) => setAdjCount(e.target.value)}
                    data-testid="mover-adjust-count"
                    className="mt-1 w-full h-16 px-4 bg-card border border-input rounded-lg text-3xl font-semibold tabular-nums text-center focus:outline-none focus:ring-2 focus:ring-ring/25 focus:border-ring transition-colors" />
                  {adjCount !== "" && !Number.isNaN(parseInt(adjCount, 10)) && (() => {
                    const d = parseInt(adjCount, 10) - (adjBox.units ?? adjBox.qty ?? 0);
                    if (d === 0) return <p className="text-xs text-muted-foreground mt-1 text-center">Sin cambio</p>;
                    return (
                      <p className={`text-xs font-medium mt-1 text-center ${d > 0 ? "text-emerald-600 dark:text-emerald-400" : "text-red-600 dark:text-red-400"}`}>
                        {d > 0 ? "+" : ""}{d} unidades{parseInt(adjCount, 10) === 0 ? " · la caja se eliminará" : ""}
                      </p>
                    );
                  })()}
                </div>
                <div>
                  <label className="text-xs font-medium text-muted-foreground">
                    Motivo del ajuste <span className="text-red-600 dark:text-red-400">*</span>
                  </label>
                  <textarea value={adjReason} onChange={(e) => setAdjReason(e.target.value)}
                    rows={2} placeholder="Ej. Conteo físico, caja dañada, error de captura…"
                    data-testid="mover-adjust-reason"
                    className="mt-1 w-full px-4 py-3 bg-card border border-input rounded-lg text-sm placeholder:text-muted-foreground/60 focus:outline-none focus:ring-2 focus:ring-ring/25 focus:border-ring transition-colors resize-none" />
                </div>
                <button onClick={submitAdjust}
                  disabled={adjSubmitting || adjCount === "" || !adjReason.trim()
                    || parseInt(adjCount, 10) === (adjBox.units ?? adjBox.qty ?? 0)}
                  data-testid="mover-adjust-confirm"
                  className="w-full h-14 rounded-md bg-primary text-primary-foreground hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed text-sm font-medium flex items-center justify-center gap-2 transition-colors">
                  {adjSubmitting ? <Loader2 className="w-5 h-5 animate-spin" /> : <Scale className="w-5 h-5" />}
                  Confirmar ajuste
                </button>
              </div>
            </div>
          )
        ) : /* STEP 1 — origin */
        !origin ? (
          <div className="bg-card border border-border rounded-lg p-5 space-y-3">
            <div className="text-sm font-semibold text-foreground flex items-center gap-2">
              <span className="w-6 h-6 rounded-full bg-primary text-primary-foreground text-xs flex items-center justify-center font-semibold">1</span>
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
            <div className="bg-card border border-border rounded-lg p-4 flex items-center justify-between">
              <div className="flex items-center gap-3 min-w-0">
                <MapPin className="w-6 h-6 text-muted-foreground flex-shrink-0" />
                <div className="min-w-0">
                  <div className="text-xs font-medium text-muted-foreground">Origen</div>
                  <div className="text-lg font-mono font-semibold truncate">{origin}</div>
                </div>
              </div>
              <div className="flex items-center gap-4">
                <div className="text-right">
                  <div className="text-lg font-semibold tabular-nums leading-none">{loading ? "…" : totalUnits}</div>
                  <div className="text-xs text-muted-foreground">unidades</div>
                </div>
                <button onClick={resetAll}
                  className="p-2.5 rounded-md hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
                  title="Cambiar ubicación" data-testid="mover-reset">
                  <RotateCcw className="w-5 h-5" />
                </button>
              </div>
            </div>

            {loading ? (
              <div className="flex items-center justify-center py-16"><Loader2 className="w-8 h-8 animate-spin text-primary" /></div>
            ) : contents.boxes.length === 0 && contents.lines.length === 0 ? (
              <div className="py-16 text-center">
                <p className="text-sm font-semibold text-foreground/80">Esta ubicación está vacía</p>
                <p className="text-sm text-muted-foreground mt-1">No hay cajas ni inventario en {origin}.</p>
              </div>
            ) : !mode ? (
              /* STEP 2 — choose mode */
              <div className="space-y-3">
                <div className="text-sm font-semibold text-foreground flex items-center gap-2">
                  <span className="w-6 h-6 rounded-full bg-primary text-primary-foreground text-xs flex items-center justify-center font-semibold">2</span>
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
                <button onClick={() => { setMode(null); setSelectedBoxes([]); setSelectedLine(null); setSelectedUnitBox(null); setQty(""); setPhysicalLpn(""); setDest(""); }}
                  className="text-xs font-medium text-primary flex items-center gap-1">
                  <X className="w-3.5 h-3.5" /> Cambiar tipo de movimiento
                </button>

                {/* MODE: ALL */}
                {mode === "all" && (
                  <div className="bg-card border border-border rounded-lg p-5 space-y-4">
                    <p className="text-sm">
                      Vas a mover <strong>todo</strong> el contenido de <span className="font-mono font-medium">{origin}</span>
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
                    <div className="bg-card border border-border rounded-lg p-4 space-y-3">
                      <div className="text-xs font-medium text-muted-foreground flex items-center gap-2">
                        <ScanLine className="w-4 h-4 text-muted-foreground" /> Escanea una caja para seleccionarla
                      </div>
                      <input ref={boxScanRef} autoFocus placeholder="Escanea BOX-…"
                        onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); onBoxScan(e.currentTarget.value); } }}
                        data-testid="mover-box-scan"
                        className="w-full h-12 px-4 bg-card border border-input rounded-md font-mono placeholder:text-muted-foreground/60 focus:outline-none focus:ring-2 focus:ring-ring/25 focus:border-ring transition-colors" />
                      {scanLookup && (
                        <div className="text-xs text-muted-foreground flex items-center gap-2">
                          <Loader2 className="w-3.5 h-3.5 animate-spin" /> Buscando caja…
                        </div>
                      )}
                    </div>

                    {/* Foreign box: scanned from a DIFFERENT location — confirm before moving */}
                    {pendingForeign && (
                      <div className="border border-l-4 rounded-lg px-4 py-3 space-y-3 bg-amber-50 border-amber-200/70 border-l-amber-500 dark:bg-amber-500/10 dark:border-amber-500/25 dark:border-l-amber-500" data-testid="mover-foreign-confirm">
                        <div className="flex items-start gap-3">
                          <ScanLine className="w-5 h-5 text-amber-600 dark:text-amber-400 flex-shrink-0 mt-0.5" />
                          <div className="min-w-0 text-sm">
                            La caja <span className="font-mono font-semibold">{pendingForeign.box_id}</span> no está en{" "}
                            <span className="font-mono font-medium">{origin}</span>.
                            <div className="mt-1">
                              Pertenece a <span className="font-mono font-semibold text-amber-700 dark:text-amber-300">{pendingForeign.location || "ubicación desconocida"}</span>
                              {" · "}{pendingForeign.style || pendingForeign.sku} · {pendingForeign.color} · {pendingForeign.size}
                              {" · "}{pendingForeign.units ?? pendingForeign.qty ?? 0} u
                            </div>
                          </div>
                        </div>
                        <div className="flex gap-2">
                          <Btn
                            variant="primary"
                            onClick={() => addForeignBox(pendingForeign)}
                            data-testid="mover-foreign-yes"
                            className="flex-1"
                          >
                            Sí, moverla
                          </Btn>
                          <Btn onClick={() => setPendingForeign(null)}>
                            Cancelar
                          </Btn>
                        </div>
                      </div>
                    )}

                    <div className="space-y-2 max-h-72 overflow-y-auto">
                      {[...foreignBoxes, ...contents.boxes].map(b => {
                        const on = selectedBoxes.includes(b.box_id);
                        return (
                          <button key={b.box_id} onClick={() => toggleBox(b.box_id)}
                            className={`w-full flex items-center gap-3 p-3 rounded-lg border text-left transition-colors ${on ? "border-primary bg-primary/5" : "border-border bg-card hover:bg-muted/40"}`}>
                            <div className={`w-6 h-6 rounded-md flex items-center justify-center flex-shrink-0 ${on ? "bg-primary text-primary-foreground" : "bg-muted"}`}>
                              {on && <CheckCircle2 className="w-4 h-4" />}
                            </div>
                            <div className="flex-1 min-w-0">
                              <div className="font-mono font-medium text-sm flex items-center gap-2">
                                {b.box_id}
                                {b._foreign && (
                                  <Chip tone="warning">
                                    de {b.location}
                                  </Chip>
                                )}
                              </div>
                              <div className="text-xs text-muted-foreground truncate">
                                {b.style || b.sku} · {b.color} · {b.size}
                              </div>
                            </div>
                            <div className="text-right flex-shrink-0">
                              <div className="font-semibold tabular-nums">{b.units ?? b.qty ?? 0}</div>
                              <div className="text-[10px] text-muted-foreground">u</div>
                            </div>
                          </button>
                        );
                      })}
                    </div>
                    {selectedBoxes.length > 0 && (
                      <div className="bg-card border border-border rounded-lg p-4">
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
                        <div className="text-xs font-medium text-muted-foreground flex items-center gap-2">
                          <Search className="w-4 h-4" /> Elige el SKU a mover
                        </div>
                        {contents.lines.map((r, i) => (
                          <button key={i} onClick={() => { setSelectedLine(r); setQty(String(r.units_on_hand || "")); }}
                            data-testid={`mover-units-line-${i}`}
                            className="w-full flex items-center justify-between p-3 rounded-lg border border-border bg-card hover:bg-muted/40 transition-colors text-left">
                            <div className="min-w-0">
                              <div className="font-mono font-medium text-sm truncate">{r.style || r.sku}</div>
                              <div className="text-xs text-muted-foreground truncate">{r.color} · {r.size}</div>
                            </div>
                            <div className="text-right flex-shrink-0">
                              <div className="font-semibold tabular-nums">{r.units_on_hand}</div>
                              <div className="text-[10px] text-muted-foreground">disp.</div>
                            </div>
                          </button>
                        ))}
                      </div>
                    ) : (
                      <div className="bg-card border border-border rounded-lg p-5 space-y-4">
                        <div className="flex items-center justify-between">
                          <div className="min-w-0">
                            <div className="font-mono font-semibold">{selectedLine.style || selectedLine.sku}</div>
                            <div className="text-xs text-muted-foreground">{selectedLine.color} · {selectedLine.size}</div>
                          </div>
                          <button onClick={() => { setSelectedLine(null); setSelectedUnitBox(null); setQty(""); }}
                            className="text-xs font-medium text-primary">Cambiar</button>
                        </div>

                        {!selectedUnitBox ? (
                          // SIN FIFO: paso obligatorio — elegir/escanear la caja específica.
                          (() => {
                            const key = (v) => String(v ?? "").trim().toUpperCase();
                            const boxes = (contents.boxes || []).filter(b =>
                              (b.units ?? b.qty ?? 0) > 0 &&
                              key(b.color) === key(selectedLine.color) &&
                              key(b.size) === key(selectedLine.size) &&
                              (key(b.style) === key(selectedLine.style) || key(b.sku) === key(selectedLine.sku) ||
                               key(b.style) === key(selectedLine.sku) || key(b.sku) === key(selectedLine.style)));
                            return (
                              <div className="space-y-2">
                                <div className="text-xs font-medium text-muted-foreground flex items-center gap-2">
                                  <ScanLine className="w-4 h-4" /> Elige o escanea la caja a mover
                                </div>
                                {boxes.length === 0 ? (
                                  <div className="text-sm text-muted-foreground p-3 rounded-lg border border-dashed border-border text-center">
                                    Sin cajas con stock para este material en {origin}.
                                  </div>
                                ) : boxes.map(b => (
                                  <button key={b.box_id}
                                    onClick={() => { setSelectedUnitBox(b); setQty(String(b.units ?? b.qty ?? "")); }}
                                    data-testid={`mover-units-box-${b.box_id}`}
                                    className="w-full flex items-center justify-between p-3 rounded-lg border border-border bg-card hover:bg-muted/40 transition-colors text-left">
                                    <div className="min-w-0">
                                      <div className="font-mono font-medium text-sm truncate">{b.box_id}</div>
                                      <div className="text-xs text-muted-foreground truncate">{b.country_of_origin || b.coo || ""}{b.lot_number ? ` · ${b.lot_number}` : ""}</div>
                                    </div>
                                    <div className="text-right flex-shrink-0">
                                      <div className="font-semibold tabular-nums">{b.units ?? b.qty ?? 0}</div>
                                      <div className="text-[10px] text-muted-foreground">u</div>
                                    </div>
                                  </button>
                                ))}
                              </div>
                            );
                          })()
                        ) : (
                          <>
                            <div className="flex items-center justify-between rounded-lg border border-primary/40 bg-primary/5 p-3">
                              <div className="min-w-0">
                                <div className="font-mono font-semibold text-sm truncate">{selectedUnitBox.box_id}</div>
                                <div className="text-xs text-muted-foreground">{selectedUnitBox.units ?? selectedUnitBox.qty ?? 0} u disponibles</div>
                              </div>
                              <button onClick={() => { setSelectedUnitBox(null); setQty(""); }}
                                className="text-xs font-medium text-primary">Cambiar caja</button>
                            </div>
                            <div>
                              <label className="text-xs font-medium text-muted-foreground">
                                Cantidad a mover (máx {selectedUnitBox.units ?? selectedUnitBox.qty ?? 0})
                              </label>
                              <div className="flex items-center gap-2 mt-1">
                                <input type="number" min="1" max={selectedUnitBox.units ?? selectedUnitBox.qty ?? 0}
                                  value={qty} onChange={(e) => setQty(e.target.value)}
                                  data-testid="mover-units-qty"
                                  className="flex-1 h-14 px-4 bg-card border border-input rounded-lg text-xl font-semibold tabular-nums text-center focus:outline-none focus:ring-2 focus:ring-ring/25 focus:border-ring transition-colors" />
                                <button onClick={() => setQty(String(selectedUnitBox.units ?? selectedUnitBox.qty ?? 0))}
                                  className="h-14 px-4 rounded-md bg-primary/10 text-primary text-sm font-medium hover:bg-primary/15 transition-colors">Todo</button>
                              </div>
                            </div>
                            <DestAndGo
                              dest={dest} setDest={setDest} locations={locNames}
                              disabled={submitting || !(parseInt(qty) > 0) || parseInt(qty) > (selectedUnitBox.units ?? selectedUnitBox.qty ?? 0)}
                              onGo={moveUnits}
                              label={`Mover ${parseInt(qty) || 0} u a`} />
                          </>
                        )}
                      </div>
                    )}
                  </div>
                )}

                {/* MODE: RECONCILE LPN — match a migrated generic LPN to the box's real label */}
                {mode === "reconcile" && (
                  <div className="space-y-3">
                    {!selectedLine ? (
                      <div className="space-y-2">
                        <div className="text-xs font-medium text-muted-foreground flex items-center gap-2">
                          <Search className="w-4 h-4" /> Elige el producto a reconciliar
                        </div>
                        {contents.lines.map((r, i) => (
                          <button key={i} onClick={() => { setSelectedLine(r); setQty("72"); setPhysicalLpn(""); }}
                            data-testid={`mover-reconcile-line-${i}`}
                            className="w-full flex items-center justify-between p-3 rounded-lg border border-border bg-card hover:bg-muted/40 transition-colors text-left">
                            <div className="min-w-0">
                              <div className="font-mono font-medium text-sm truncate">{r.style || r.sku}</div>
                              <div className="text-xs text-muted-foreground truncate">
                                {r.color} · {r.size}{r.description ? ` · ${r.description}` : ""}
                              </div>
                            </div>
                            <div className="text-right flex-shrink-0">
                              <div className="font-semibold tabular-nums">{r.units_on_hand}</div>
                              <div className="text-[10px] text-muted-foreground">disp.</div>
                            </div>
                          </button>
                        ))}
                      </div>
                    ) : (
                      <div className="bg-card border border-border rounded-lg p-5 space-y-4">
                        {/* Product validation header */}
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <div className="font-mono font-semibold">{selectedLine.style || selectedLine.sku}</div>
                            <div className="text-xs text-muted-foreground">{selectedLine.color} · {selectedLine.size}</div>
                            {selectedLine.description && (
                              <div className="text-xs text-muted-foreground mt-0.5">{selectedLine.description}</div>
                            )}
                            {(selectedLine.customer || selectedLine.manufacturer) && (
                              <div className="text-xs text-muted-foreground">
                                {selectedLine.customer}{selectedLine.manufacturer ? ` · ${selectedLine.manufacturer}` : ""}
                              </div>
                            )}
                          </div>
                          <button onClick={() => { setSelectedLine(null); setQty(""); setPhysicalLpn(""); }}
                            className="text-xs font-medium text-primary flex-shrink-0">Cambiar</button>
                        </div>

                        {/* Physical LPN scan */}
                        <div>
                          <label className="text-xs font-medium text-muted-foreground flex items-center gap-2">
                            <ScanLine className="w-4 h-4 text-muted-foreground" /> Escanea el LPN físico de la caja
                          </label>
                          <input autoFocus value={physicalLpn}
                            onChange={(e) => setPhysicalLpn(e.target.value.toUpperCase())}
                            placeholder="Ej. A2600510001"
                            data-testid="mover-reconcile-lpn"
                            className="mt-1 w-full h-14 px-4 bg-card border border-input rounded-lg text-lg font-mono placeholder:text-muted-foreground/60 focus:outline-none focus:ring-2 focus:ring-ring/25 focus:border-ring transition-colors" />
                        </div>

                        {/* Quantity (default 72, editable) */}
                        <div>
                          <label className="text-xs font-medium text-muted-foreground">
                            Cantidad en la caja (default 72)
                          </label>
                          <input type="number" min="1" value={qty} onChange={(e) => setQty(e.target.value)}
                            data-testid="mover-reconcile-qty"
                            className="mt-1 w-full h-14 px-4 bg-card border border-input rounded-lg text-xl font-semibold tabular-nums text-center focus:outline-none focus:ring-2 focus:ring-ring/25 focus:border-ring transition-colors" />
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
      <div className="text-xs font-medium text-muted-foreground flex items-center gap-2">
        <span className="w-5 h-5 rounded-full bg-primary text-primary-foreground text-[10px] flex items-center justify-center font-semibold">3</span>
        Escanea la ubicación DESTINO
      </div>
      <LocationInput
        value={dest} onChange={setDest} onSubmit={(v) => setDest(v)} onPick={(v) => setDest(v)}
        locations={locations} placeholder="Ubicación destino" testid="mover-dest-input"
      />
      <button onClick={onGo} disabled={disabled || !dest.trim()}
        data-testid="mover-confirm"
        className="w-full h-14 rounded-md bg-primary text-primary-foreground hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed text-sm font-medium flex items-center justify-center gap-2 transition-colors">
        <Move className="w-5 h-5" /> {label} {dest ? <span className="font-mono">{dest}</span> : ""}
      </button>
    </div>
  );
}
