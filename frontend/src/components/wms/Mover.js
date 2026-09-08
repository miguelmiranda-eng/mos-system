import { useState, useEffect, useMemo, useRef, useCallback } from "react";
import { toast } from "sonner";
import {
  ScanLine, MapPin, Boxes, Package, Layers, ArrowRight, Loader2,
  CheckCircle2, RotateCcw, Search, X, Move, Tag, Scale, Printer,
} from "lucide-react";
import { useLang } from "../../contexts/LanguageContext";
import { fetcher, poster, cleanScan, logLoadError, API, useWmsSizes, useWmsCatalogs, mergeUnique } from "./lib";
import SearchableSelect from "../SearchableSelect";
import BulkInventoryAdjust from "./BulkInventoryAdjust";
import { adminLevelOf } from "./modules";
import { ModuleToolbar, SoftAlert, Btn, Chip, EmptyState } from "./ui";

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
  const { t } = useLang();
  // Top-level mode: the classic origin→destination move, a box-first inventory
  // adjustment (Case# 002), or the bulk Excel inventory adjustment (admin L3+).
  const [topMode, setTopMode] = useState("move"); // 'move' | 'adjust' | 'bulk'
  // Visibilidad de las herramientas del Mover (decisión de negocio):
  //  • VERDES — "Ajustar caja" y "Generar caja": rol inventarios O admin 5+.
  //  • ROJOS  — "Ajuste masivo" (tab) y los modos "Toda la ubicación" y
  //    "Reconciliar LPN/Etiqueta": SOLO admin 5+ / supersu. Son operaciones
  //    peligrosas (barrido de ubicación entera) o de migración (reconciliar LPN).
  // adminLevelOf() es el espejo de get_admin_level() del backend (deps.py):
  // supersu=5, admin=admin_level(1-5), inventory_level>=3 confiere 3.
  const admin5 = adminLevelOf(currentUser) >= 5;
  const canGreen = currentUser?.role === 'inventory' || admin5;  // Ajustar / Generar caja
  const canRed = admin5;                                          // Ajuste masivo + modos peligrosos
  // Tabs visibles: Mover (siempre) + Ajustar + Generar (verdes) + Ajuste masivo (rojo).
  const _visibleTopTabs = 1 + (canGreen ? 2 : 0) + (canRed ? 1 : 0);
  const topTabsGridClass = _visibleTopTabs >= 4 ? 'grid-cols-4'
    : (_visibleTopTabs === 3 ? 'grid-cols-3'
      : (_visibleTopTabs === 2 ? 'grid-cols-2' : 'grid-cols-1'));

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
  // Estilo y Color: fusionar catálogo de configuración curado (/catalogs) con los
  // valores del inventario, igual que los demás campos. Sin esto, un estilo/color
  // dado de alta en configuración pero aún sin inventario no aparecía en el dropdown.
  const genStyleOptions = mergeUnique(genCat.styles, genOptions.styles);
  const genColorOptions = mergeUnique(genCat.colors, genOptions.colors);
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
      if (!box || !box.box_id) { toast.error(t('wms_box_not_exists', { box: code })); return; }
      setAdjBox(box);
      setAdjCount(String(box.units ?? box.qty ?? 0));
      setAdjReason("");
    } catch {
      toast.error(t('wms_box_not_found', { box: code }));
    } finally { setAdjLookup(false); }
  };

  const submitAdjust = async () => {
    const counted = parseInt(adjCount, 10);
    if (!(counted >= 0)) { toast.error(t("wms_adj_count_req")); return; }
    if (!adjReason.trim()) { toast.error(t("wms_adj_reason_req")); return; }
    setAdjSubmitting(true);
    try {
      const res = await poster(`/boxes/${encodeURIComponent(adjBox.box_id)}/adjust`, {
        counted_units: counted, reason: adjReason.trim(),
      });
      if (res.ok) {
        const data = await res.json().catch(() => ({}));
        const d = data.delta_units ?? 0;
        toast.success(
          t("wms_adj_done", { box: data.box_id, old: data.old_units, new: data.new_units, delta: `${d > 0 ? "+" : ""}${d}` })
            + (data.box_deleted ? t("wms_adj_box_removed_suffix") : "")
        );
        resetAdjust();
        adjScanRef.current?.focus();
      } else {
        const err = await res.json().catch(() => ({}));
        toast.error(err.detail || t("wms_adj_err"));
      }
    } catch {
      toast.error(t("wms_err_connection"));
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
      toast.error(t('wms_gen_req')); return;
    }
    // El lote no bloquea —en piso puede tocar material sin etiqueta legible—
    // pero se avisa qué se pierde: una caja sin país ni composición no casa con
    // su renglón de inventario, y el país es requisito de etiquetado al exportar.
    if (!genForm.country_of_origin.trim() || !genForm.fabric_content.trim()) {
      const seguir = window.confirm(t('wms_gen_missing_lot_confirm'));
      if (!seguir) return;
    }
    setGenSubmitting(true);
    try {
      const res = await poster('/boxes/generate', { ...genForm, units: Number(genForm.units) });
      if (res.ok) {
        const data = await res.json();
        toast.success(t('wms_gen_done', { box: data.box_id }));
        setGenLastBox(data.box_id);
        printBox(data.box_id);
        // Keep location/customer for batch tagging; clear the per-box fields.
        setGenForm(f => ({ ...f, style: '', color: '', size: '', units: '' }));
      } else {
        const err = await res.json().catch(() => ({}));
        toast.error(err.detail || t('wms_gen_err'));
      }
    } catch { toast.error(t('wms_err_connection')); }
    finally { setGenSubmitting(false); }
  };

  // ── Submit handlers per mode ────────────────────────────────────────────────
  const doMove = async (label, promise) => {
    setSubmitting(true);
    try {
      const res = await promise;
      if (res.ok) {
        const data = await res.json().catch(() => ({}));
        toast.success(data.message || t("wms_move_done", { label }));
        // Stay on the same origin and refresh so the operator can keep working
        // in the same bin; clear the per-move selection.
        setMode(null); setSelectedBoxes([]); setForeignBoxes([]); setPendingForeign(null); setSelectedLine(null); setSelectedUnitBox(null); setQty(""); setPhysicalLpn(""); setDest("");
        await loadContents(origin);
      } else {
        const err = await res.json().catch(() => ({}));
        toast.error(err.detail || t("wms_move_fail", { label }));
      }
    } catch {
      toast.error(t("wms_err_connection"));
    } finally {
      setSubmitting(false);
    }
  };

  const moveAll = () => doMove(t("wms_move_all_loc"),
    poster("/move-location", { from: origin, to: cleanScan(dest) }));

  const moveBoxes = () => doMove(t("wms_move_boxes"),
    poster("/boxes/relocate", { box_ids: selectedBoxes, to: cleanScan(dest) }));

  const moveUnits = () => doMove(t("wms_move_units"), poster("/move-units", {
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
  const moveReconcile = () => doMove(t("wms_reconcile_lpn"), poster("/boxes/reconcile-lpn", {
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
      if (!box || !box.box_id) { toast.error(t('wms_box_not_exists', { box: code })); return; }
      if ((box.location || "").toUpperCase() === origin.toUpperCase()) {
        addForeignBox(box); // belongs here but wasn't in the loaded list
      } else {
        setPendingForeign(box); // ask before pulling it from another slot
      }
    } catch {
      clearBoxInput();
      toast.error(t('wms_box_not_found', { box: code }));
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
        {/* El shell ya dice "MOVER"; esto dice en cuál de sus cuatro modos
            estás parado, que es lo único que el encabezado no puede saber. */}
        <ModuleToolbar
          context={topMode === "bulk" ? t("wms_bulk_adjust") : topMode === "adjust" ? t("wms_adjust_box") : topMode === "generate" ? t("wms_generate_box") : t("wms_move_material")}
          hint={topMode === "bulk"
            ? t("wms_bulk_adjust_hint")
            : topMode === "adjust"
              ? t("wms_adjust_box_hint")
              : topMode === "generate"
                ? t("wms_generate_box_hint")
                : t("wms_move_material_hint")}
        />

        {/* Top-level toggle: move vs adjust-by-box (Case# 002) vs bulk (admin L3+) */}
        <div className={`grid ${topTabsGridClass} gap-2 p-1 rounded-lg bg-muted/50 border border-border`}>
          <button
            onClick={() => { if (topMode !== "move") { resetAdjust(); setTopMode("move"); } }}
            data-testid="mover-top-move"
            className={`flex items-center justify-center gap-2 py-2 rounded-md text-sm font-medium transition-colors ${topMode === "move" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"}`}>
            <Move className="w-4 h-4" /> {t("wms_move")}
          </button>
          {canGreen && (
          <button
            onClick={() => { if (topMode !== "adjust") { resetAll(); setTopMode("adjust"); } }}
            data-testid="mover-top-adjust"
            className={`flex items-center justify-center gap-2 py-2 rounded-md text-sm font-medium transition-colors ${topMode === "adjust" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"}`}>
            <Scale className="w-4 h-4" /> {t("wms_adjust_box")}
          </button>
          )}
          {canGreen && (
          <button
            onClick={() => { if (topMode !== "generate") { resetAll(); resetAdjust(); setTopMode("generate"); } }}
            data-testid="mover-top-generate"
            className={`flex items-center justify-center gap-2 py-2 rounded-md text-sm font-medium transition-colors ${topMode === "generate" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"}`}>
            <Tag className="w-4 h-4" /> {t("wms_generate_box")}
          </button>
          )}
          {canRed && (
            <button
              onClick={() => { if (topMode !== "bulk") { resetAll(); resetAdjust(); setTopMode("bulk"); } }}
              data-testid="mover-top-bulk"
              className={`flex items-center justify-center gap-2 py-2 rounded-md text-sm font-medium transition-colors ${topMode === "bulk" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"}`}>
              <Boxes className="w-4 h-4" /> {t("wms_bulk_adjust")}
            </button>
          )}
        </div>

        {/* ── BULK INVENTORY ADJUST (Excel · admin L3+) ─────────────────────── */}
        {topMode === "bulk" ? (
          <BulkInventoryAdjust />
        ) : topMode === "generate" ? (
          <div className="bg-card border border-border rounded-lg p-5 space-y-4">
            <div className="text-sm font-semibold text-foreground flex items-center gap-2">
              <Tag className="w-5 h-5 text-muted-foreground" /> {t("wms_gen_title")}
            </div>
            <p className="text-xs text-muted-foreground">
              {t("wms_gen_desc")}
            </p>
            <div className="grid grid-cols-2 gap-3">
              <SearchableSelect options={genStyleOptions} value={genForm.style}
                onChange={v => setGenForm(f => ({ ...f, style: v }))}
                placeholder={t("wms_gen_style_ph")} testId="gen-style" allowCreate={false} />
              <SearchableSelect options={genColorOptions} value={genForm.color}
                onChange={v => setGenForm(f => ({ ...f, color: v }))}
                placeholder={t("wms_gen_color_ph")} testId="gen-color" allowCreate={false} />
              <SearchableSelect options={genSizeOptions} value={genForm.size}
                onChange={v => setGenForm(f => ({ ...f, size: v }))}
                placeholder={t("wms_gen_size_ph")} testId="gen-size" allowCreate={false} />
              <input type="number" min="1" value={genForm.units} onChange={e => setGenForm(f => ({ ...f, units: e.target.value }))}
                placeholder={t("wms_gen_units_ph")} data-testid="gen-units"
                className="h-12 px-3 bg-card border border-input rounded-md text-lg font-medium tabular-nums focus:outline-none focus:ring-2 focus:ring-ring/25 focus:border-ring transition-colors" />
              <SearchableSelect options={genCustomerOptions} value={genForm.customer}
                onChange={v => setGenForm(f => ({ ...f, customer: v }))}
                placeholder={t("wms_gen_customer_ph")} testId="gen-customer" allowCreate={false} />
              <SearchableSelect options={locNames} value={genForm.location}
                onChange={v => setGenForm(f => ({ ...f, location: v }))}
                placeholder={t("wms_gen_location_ph")} testId="gen-location" allowCreate={false} />
              {/* El LOTE. Sólo catálogo, como el resto: con texto libre vuelven a
                  entrar valores como 'WASH COLD' en el campo país, que hubo que
                  limpiar de 748 cajas. Se conservan al generar la siguiente caja
                  (igual que ubicación y cliente) porque un lote se etiqueta en tanda. */}
              <SearchableSelect options={genCountryOptions} value={genForm.country_of_origin}
                onChange={v => setGenForm(f => ({ ...f, country_of_origin: v }))}
                placeholder={t("wms_gen_coo_ph")} testId="gen-coo" allowCreate={false} />
              <SearchableSelect options={genFabricOptions} value={genForm.fabric_content}
                onChange={v => setGenForm(f => ({ ...f, fabric_content: v }))}
                placeholder={t("wms_gen_fabric_ph")} testId="gen-fabric" allowCreate={false} />
            </div>
            <button onClick={handleGenerateBox} disabled={genSubmitting} data-testid="gen-submit"
              className="w-full h-14 rounded-md bg-primary text-primary-foreground text-sm font-medium hover:opacity-90 flex items-center justify-center gap-2 disabled:opacity-50 transition-colors">
              {genSubmitting ? <Loader2 className="w-5 h-5 animate-spin" /> : <Printer className="w-5 h-5" />}
              {t("wms_gen_submit")}
            </button>
            {genLastBox && (
              <SoftAlert
                tone="success"
                action={
                  <button onClick={() => printBox(genLastBox)} className="flex items-center gap-1 text-xs font-medium text-primary hover:underline">
                    <Printer className="w-3.5 h-3.5" /> {t("wms_reprint")}
                  </button>
                }
              >
                {t("wms_last_box")} <span className="font-mono font-medium text-foreground">{genLastBox}</span>
              </SoftAlert>
            )}
          </div>
        ) : topMode === "adjust" ? (
          !adjBox ? (
            <div className="bg-card border border-border rounded-lg p-5 space-y-3">
              <div className="text-sm font-semibold text-foreground flex items-center gap-2">
                <ScanLine className="w-5 h-5 text-muted-foreground" /> {t("wms_scan_box_number")}
              </div>
              <form onSubmit={(e) => { e.preventDefault(); lookupAdjBox(adjScan); }} className="flex items-center gap-2">
                <input
                  ref={adjScanRef} autoFocus value={adjScan}
                  onChange={(e) => setAdjScan(e.target.value.toUpperCase())}
                  placeholder={t("wms_scan_box_ph")}
                  data-testid="mover-adjust-scan"
                  className="flex-1 h-14 px-4 bg-card border border-input rounded-lg text-lg font-mono placeholder:text-muted-foreground/60 focus:outline-none focus:ring-2 focus:ring-ring/25 focus:border-ring transition-colors" />
                <button type="submit" disabled={adjLookup || !adjScan.trim()}
                  className="h-14 px-5 rounded-md bg-primary text-primary-foreground text-sm font-medium hover:opacity-90 disabled:opacity-50 transition-colors">
                  {adjLookup ? <Loader2 className="w-5 h-5 animate-spin" /> : t("search")}
                </button>
              </form>
              <p className="text-xs text-muted-foreground">
                {t("wms_adj_note")}
              </p>
            </div>
          ) : (
            <div className="space-y-4">
              {/* Box summary */}
              <div className="bg-card border border-border rounded-lg p-4 space-y-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-xs font-medium text-muted-foreground">{t("wms_box_label")}</div>
                    <div className="text-lg font-mono font-semibold truncate">{adjBox.box_id}</div>
                    <div className="text-xs text-muted-foreground mt-0.5 truncate">
                      {(adjBox.style || adjBox.sku)} · {adjBox.color} · {adjBox.size}
                    </div>
                    <div className="text-xs text-muted-foreground flex items-center gap-1 mt-1">
                      <MapPin className="w-3.5 h-3.5 text-muted-foreground" />
                      {adjBox.location || t("wms_no_location_lc")}
                    </div>
                  </div>
                  <div className="text-right flex-shrink-0">
                    <div className="text-2xl font-semibold tabular-nums leading-none">{adjBox.units ?? adjBox.qty ?? 0}</div>
                    <div className="text-xs text-muted-foreground">{t("wms_units_current")}</div>
                  </div>
                </div>
                <button onClick={resetAdjust} className="text-xs font-medium text-primary flex items-center gap-1">
                  <RotateCcw className="w-3.5 h-3.5" /> {t("wms_change_box")}
                </button>
              </div>

              {/* Counted units + reason */}
              <div className="bg-card border border-border rounded-lg p-5 space-y-4">
                <div>
                  <label className="text-xs font-medium text-muted-foreground">
                    {t("wms_adj_counted_label")}
                  </label>
                  <input type="number" min="0" value={adjCount}
                    onChange={(e) => setAdjCount(e.target.value)}
                    data-testid="mover-adjust-count"
                    className="mt-1 w-full h-16 px-4 bg-card border border-input rounded-lg text-3xl font-semibold tabular-nums text-center focus:outline-none focus:ring-2 focus:ring-ring/25 focus:border-ring transition-colors" />
                  {adjCount !== "" && !Number.isNaN(parseInt(adjCount, 10)) && (() => {
                    const d = parseInt(adjCount, 10) - (adjBox.units ?? adjBox.qty ?? 0);
                    if (d === 0) return <p className="text-xs text-muted-foreground mt-1 text-center">{t("wms_no_change")}</p>;
                    return (
                      <p className={`text-xs font-medium mt-1 text-center ${d > 0 ? "text-emerald-600 dark:text-emerald-400" : "text-red-600 dark:text-red-400"}`}>
                        {d > 0 ? "+" : ""}{d} {t("wms_units_lc")}{parseInt(adjCount, 10) === 0 ? t("wms_box_will_delete_suffix") : ""}
                      </p>
                    );
                  })()}
                </div>
                <div>
                  <label className="text-xs font-medium text-muted-foreground">
                    {t("wms_adj_reason_label")} <span className="text-red-600 dark:text-red-400">*</span>
                  </label>
                  <textarea value={adjReason} onChange={(e) => setAdjReason(e.target.value)}
                    rows={2} placeholder={t("wms_adj_reason_ph")}
                    data-testid="mover-adjust-reason"
                    className="mt-1 w-full px-4 py-3 bg-card border border-input rounded-lg text-sm placeholder:text-muted-foreground/60 focus:outline-none focus:ring-2 focus:ring-ring/25 focus:border-ring transition-colors resize-none" />
                </div>
                <button onClick={submitAdjust}
                  disabled={adjSubmitting || adjCount === "" || !adjReason.trim()
                    || parseInt(adjCount, 10) === (adjBox.units ?? adjBox.qty ?? 0)}
                  data-testid="mover-adjust-confirm"
                  className="w-full h-14 rounded-md bg-primary text-primary-foreground hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed text-sm font-medium flex items-center justify-center gap-2 transition-colors">
                  {adjSubmitting ? <Loader2 className="w-5 h-5 animate-spin" /> : <Scale className="w-5 h-5" />}
                  {t("wms_adj_confirm")}
                </button>
              </div>
            </div>
          )
        ) : /* STEP 1 — origin */
        !origin ? (
          <div className="bg-card border border-border rounded-lg p-5 space-y-3">
            <div className="text-sm font-semibold text-foreground flex items-center gap-2">
              <span className="w-6 h-6 rounded-full bg-primary text-primary-foreground text-xs flex items-center justify-center font-semibold">1</span>
              {t("wms_scan_origin")}
            </div>
            <LocationInput
              value={originInput} onChange={setOriginInput}
              onSubmit={setOriginAndLoad} onPick={setOriginAndLoad}
              locations={locNames} autoFocus placeholder={t("wms_origin_ph")}
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
                  <div className="text-xs font-medium text-muted-foreground">{t("wms_origin")}</div>
                  <div className="text-lg font-mono font-semibold truncate">{origin}</div>
                </div>
              </div>
              <div className="flex items-center gap-4">
                <div className="text-right">
                  <div className="text-lg font-semibold tabular-nums leading-none">{loading ? "…" : totalUnits}</div>
                  <div className="text-xs text-muted-foreground">{t("wms_units_lc")}</div>
                </div>
                <button onClick={resetAll}
                  className="p-2.5 rounded-md hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
                  title={t("wms_change_location")} data-testid="mover-reset">
                  <RotateCcw className="w-5 h-5" />
                </button>
              </div>
            </div>

            {loading ? (
              <div className="flex items-center justify-center py-16"><Loader2 className="w-8 h-8 animate-spin text-primary" /></div>
            ) : contents.boxes.length === 0 && contents.lines.length === 0 ? (
              <EmptyState art="rack" title={t("wms_loc_empty_title")}
                hint={t("wms_loc_empty_hint", { location: origin })} />
            ) : !mode ? (
              /* STEP 2 — choose mode */
              <div className="space-y-3">
                <div className="text-sm font-semibold text-foreground flex items-center gap-2">
                  <span className="w-6 h-6 rounded-full bg-primary text-primary-foreground text-xs flex items-center justify-center font-semibold">2</span>
                  {t("wms_what_to_move")}
                </div>
                {canRed && (
                <ModeButton icon={Layers} color="text-amber-400" testid="mover-mode-all"
                  title={t("wms_mode_all")}
                  subtitle={t("wms_mode_all_sub", { n: contents.boxes.length, units: totalUnits })}
                  onClick={() => setMode("all")} />
                )}
                <ModeButton icon={Boxes} color="text-blue-400" testid="mover-mode-box"
                  title={t("wms_mode_box")}
                  subtitle={t("wms_mode_box_sub")}
                  onClick={() => setMode("box")} />
                <ModeButton icon={Package} color="text-emerald-400" testid="mover-mode-units"
                  title={t("wms_mode_units")}
                  subtitle={t("wms_mode_units_sub")}
                  onClick={() => setMode("units")} />
                {canRed && (
                <ModeButton icon={Tag} color="text-fuchsia-400" testid="mover-mode-reconcile"
                  title={t("wms_mode_reconcile")}
                  subtitle={t("wms_mode_reconcile_sub")}
                  onClick={() => setMode("reconcile")} />
                )}
              </div>
            ) : (
              /* STEP 3 — per-mode selection + destination */
              <div className="space-y-4">
                <button onClick={() => { setMode(null); setSelectedBoxes([]); setSelectedLine(null); setSelectedUnitBox(null); setQty(""); setPhysicalLpn(""); setDest(""); }}
                  className="text-xs font-medium text-primary flex items-center gap-1">
                  <X className="w-3.5 h-3.5" /> {t("wms_change_move_type")}
                </button>

                {/* MODE: ALL */}
                {mode === "all" && (
                  <div className="bg-card border border-border rounded-lg p-5 space-y-4">
                    <p className="text-sm">
                      {t("wms_move_all_text_1")} <strong>{t("wms_move_all_text_all")}</strong> {t("wms_move_all_text_2")} <span className="font-mono font-medium">{origin}</span>
                      {" "}{t("wms_move_all_text_3", { n: contents.boxes.length, units: totalUnits })}
                    </p>
                    <DestAndGo
                      dest={dest} setDest={setDest} locations={locNames}
                      disabled={submitting} onGo={moveAll}
                      label={t("wms_move_all_to")} />
                  </div>
                )}

                {/* MODE: BOX */}
                {mode === "box" && (
                  <div className="space-y-3">
                    <div className="bg-card border border-border rounded-lg p-4 space-y-3">
                      <div className="text-xs font-medium text-muted-foreground flex items-center gap-2">
                        <ScanLine className="w-4 h-4 text-muted-foreground" /> {t("wms_scan_box_select")}
                      </div>
                      <input ref={boxScanRef} autoFocus placeholder={t("wms_scan_box_ph2")}
                        onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); onBoxScan(e.currentTarget.value); } }}
                        data-testid="mover-box-scan"
                        className="w-full h-12 px-4 bg-card border border-input rounded-md font-mono placeholder:text-muted-foreground/60 focus:outline-none focus:ring-2 focus:ring-ring/25 focus:border-ring transition-colors" />
                      {scanLookup && (
                        <div className="text-xs text-muted-foreground flex items-center gap-2">
                          <Loader2 className="w-3.5 h-3.5 animate-spin" /> {t("wms_searching_box")}
                        </div>
                      )}
                    </div>

                    {/* Foreign box: scanned from a DIFFERENT location — confirm before moving */}
                    {pendingForeign && (
                      <div className="border border-l-4 rounded-lg px-4 py-3 space-y-3 bg-amber-50 border-amber-200/70 border-l-amber-500 dark:bg-amber-500/10 dark:border-amber-500/25 dark:border-l-amber-500" data-testid="mover-foreign-confirm">
                        <div className="flex items-start gap-3">
                          <ScanLine className="w-5 h-5 text-amber-600 dark:text-amber-400 flex-shrink-0 mt-0.5" />
                          <div className="min-w-0 text-sm">
                            {t("wms_box_not_in_1")} <span className="font-mono font-semibold">{pendingForeign.box_id}</span> {t("wms_box_not_in_2")}{" "}
                            <span className="font-mono font-medium">{origin}</span>.
                            <div className="mt-1">
                              {t("wms_belongs_to")} <span className="font-mono font-semibold text-amber-700 dark:text-amber-300">{pendingForeign.location || t("wms_unknown_location")}</span>
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
                            {t("wms_yes_move_it")}
                          </Btn>
                          <Btn onClick={() => setPendingForeign(null)}>
                            {t("cancel")}
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
                                    {t("wms_from_lc")} {b.location}
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
                          label={t("wms_move_n_boxes_to", { n: selectedBoxes.length })} />
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
                          <Search className="w-4 h-4" /> {t("wms_pick_sku")}
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
                              <div className="text-[10px] text-muted-foreground">{t("wms_avail_short")}</div>
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
                            className="text-xs font-medium text-primary">{t("wms_change")}</button>
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
                                  <ScanLine className="w-4 h-4" /> {t("wms_pick_box_to_move")}
                                </div>
                                {boxes.length === 0 ? (
                                  <div className="text-sm text-muted-foreground p-3 rounded-lg border border-dashed border-border text-center">
                                    {t("wms_no_stock_boxes", { location: origin })}
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
                                <div className="text-xs text-muted-foreground">{t("wms_u_available", { n: selectedUnitBox.units ?? selectedUnitBox.qty ?? 0 })}</div>
                              </div>
                              <button onClick={() => { setSelectedUnitBox(null); setQty(""); }}
                                className="text-xs font-medium text-primary">{t("wms_change_box")}</button>
                            </div>
                            <div>
                              <label className="text-xs font-medium text-muted-foreground">
                                {t("wms_qty_to_move", { max: selectedUnitBox.units ?? selectedUnitBox.qty ?? 0 })}
                              </label>
                              <div className="flex items-center gap-2 mt-1">
                                <input type="number" min="1" max={selectedUnitBox.units ?? selectedUnitBox.qty ?? 0}
                                  value={qty} onChange={(e) => setQty(e.target.value)}
                                  data-testid="mover-units-qty"
                                  className="flex-1 h-14 px-4 bg-card border border-input rounded-lg text-xl font-semibold tabular-nums text-center focus:outline-none focus:ring-2 focus:ring-ring/25 focus:border-ring transition-colors" />
                                <button onClick={() => setQty(String(selectedUnitBox.units ?? selectedUnitBox.qty ?? 0))}
                                  className="h-14 px-4 rounded-md bg-primary/10 text-primary text-sm font-medium hover:bg-primary/15 transition-colors">{t("wms_all_btn")}</button>
                              </div>
                            </div>
                            <DestAndGo
                              dest={dest} setDest={setDest} locations={locNames}
                              disabled={submitting || !(parseInt(qty) > 0) || parseInt(qty) > (selectedUnitBox.units ?? selectedUnitBox.qty ?? 0)}
                              onGo={moveUnits}
                              label={t("wms_move_n_units_to", { n: parseInt(qty) || 0 })} />
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
                          <Search className="w-4 h-4" /> {t("wms_pick_product_reconcile")}
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
                              <div className="text-[10px] text-muted-foreground">{t("wms_avail_short")}</div>
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
                            className="text-xs font-medium text-primary flex-shrink-0">{t("wms_change")}</button>
                        </div>

                        {/* Physical LPN scan */}
                        <div>
                          <label className="text-xs font-medium text-muted-foreground flex items-center gap-2">
                            <ScanLine className="w-4 h-4 text-muted-foreground" /> {t("wms_scan_physical_lpn")}
                          </label>
                          <input autoFocus value={physicalLpn}
                            onChange={(e) => setPhysicalLpn(e.target.value.toUpperCase())}
                            placeholder={t("wms_lpn_example")}
                            data-testid="mover-reconcile-lpn"
                            className="mt-1 w-full h-14 px-4 bg-card border border-input rounded-lg text-lg font-mono placeholder:text-muted-foreground/60 focus:outline-none focus:ring-2 focus:ring-ring/25 focus:border-ring transition-colors" />
                        </div>

                        {/* Quantity (default 72, editable) */}
                        <div>
                          <label className="text-xs font-medium text-muted-foreground">
                            {t("wms_qty_in_box_default")}
                          </label>
                          <input type="number" min="1" value={qty} onChange={(e) => setQty(e.target.value)}
                            data-testid="mover-reconcile-qty"
                            className="mt-1 w-full h-14 px-4 bg-card border border-input rounded-lg text-xl font-semibold tabular-nums text-center focus:outline-none focus:ring-2 focus:ring-ring/25 focus:border-ring transition-colors" />
                        </div>

                        <DestAndGo
                          dest={dest} setDest={setDest} locations={locNames}
                          disabled={submitting || !physicalLpn.trim() || !(parseInt(qty) > 0)}
                          onGo={moveReconcile}
                          label={t("wms_match_lpn_move_to")} />
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
  const { t } = useLang();
  return (
    <div className="space-y-3">
      <div className="text-xs font-medium text-muted-foreground flex items-center gap-2">
        <span className="w-5 h-5 rounded-full bg-primary text-primary-foreground text-[10px] flex items-center justify-center font-semibold">3</span>
        {t("wms_scan_dest")}
      </div>
      <LocationInput
        value={dest} onChange={setDest} onSubmit={(v) => setDest(v)} onPick={(v) => setDest(v)}
        locations={locations} placeholder={t("wms_dest_loc")} testid="mover-dest-input"
      />
      <button onClick={onGo} disabled={disabled || !dest.trim()}
        data-testid="mover-confirm"
        className="w-full h-14 rounded-md bg-primary text-primary-foreground hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed text-sm font-medium flex items-center justify-center gap-2 transition-colors">
        <Move className="w-5 h-5" /> {label} {dest ? <span className="font-mono">{dest}</span> : ""}
      </button>
    </div>
  );
}
