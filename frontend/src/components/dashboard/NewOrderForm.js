import React, { useState, useEffect } from "react";
import {
  Plus, Loader2, AlertTriangle, Link2,
  FileSearch, CheckCircle2, PackageSearch,
  Zap, Info, ExternalLink, X, Tag, Users
} from "lucide-react";
import { toast } from "sonner";
import { API } from "../../lib/constants";
import { DialogHeader, DialogTitle } from "../ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue, SelectGroup, SelectLabel, SelectSeparator } from "../ui/select";
import { useLang } from "../../contexts/LanguageContext";
import SearchableSelect from "../SearchableSelect";
import { PositionsPicker, normalizarPosiciones } from "./PositionsCell";
import { useWmsSizes } from "../wms/lib";

export const NewOrderForm = ({
  formFieldKeys = [],
  options = {},
  groupConfig = {},
  allColumns = [],
  onClose,
  onSubmit,
  loading = false,
  duplicateWarning = null,
  checkingDuplicate = false,
  setDuplicateWarning,
  checkDuplicate,
  isPreview = false
}) => {
  const { t } = useLang();
  const { adult: SIZES_ORDER } = useWmsSizes();  // adult sizes + admin-configured extras
  const [formData, setFormData] = useState({});
  const [sizes, setSizes] = useState(SIZES_ORDER.reduce((acc, s) => ({ ...acc, [s]: '' }), {}));
  
  // Printavo Import State
  const [printavoUrl, setPrintavoUrl] = useState("");
  const [importLoading, setImportLoading] = useState(false);
  const [importedItems, setImportedItems] = useState([]);
  const [showImportPanel, setShowImportPanel] = useState(false);

  // Pre-Order Linkage State
  const [checkingDesign, setCheckingDesign] = useState(false);
  const [linkedPreorderId, setLinkedPreorderId] = useState(null);

  // Twin (gemela) pairing state — fires AFTER order creation in onSubmit
  const [twinEnabled, setTwinEnabled] = useState(false);
  const [twinOrderNumber, setTwinOrderNumber] = useState("");
  const [twinStatus, setTwinStatus] = useState(null); // {found: bool, board?, message?}
  const [twinChecking, setTwinChecking] = useState(false);

  const handleTwinCheck = async () => {
    const num = twinOrderNumber.trim();
    if (!num) { setTwinStatus(null); return; }
    setTwinChecking(true);
    try {
      const res = await fetch(`${API}/orders/check-number?order_number=${encodeURIComponent(num)}`, { credentials: 'include' });
      if (res.ok) {
        const data = await res.json();
        if (data.exists && !data.in_trash) {
          setTwinStatus({ found: true, board: data.order?.board });
        } else if (data.exists && data.in_trash) {
          setTwinStatus({ found: false, message: 'Esa orden esta en la papelera' });
        } else {
          setTwinStatus({ found: false, message: 'No existe una orden activa con ese numero' });
        }
      }
    } catch { setTwinStatus({ found: false, message: 'Error de conexion' }); }
    finally { setTwinChecking(false); }
  };

  const handlePrintavoAnalyze = async () => {
    if (!printavoUrl.trim()) {
      toast.error("Por favor ingresa un enlace o ubicación de PDF");
      return;
    }
    
    setImportLoading(true);
    setImportedItems([]);
    try {
      const res = await fetch(`${API}/import/printavo`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ url: printavoUrl })
      });
      
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || "Error analizando enlace");
      
      if (data.items && data.items.length > 0) {
        setImportedItems(data.items);
        toast.success(`Se encontraron ${data.items.length} artículos en Printavo`);
        if (data.items.length === 1) {
          applyImportedData(data.items[0]);
        }
      } else {
        toast.warning("No se detectaron prendas o datos de talla automáticamente");
      }
    } catch (err) {
      toast.error(err.message);
    } finally {
      setImportLoading(false);
    }
  };

  const handleDesignCheck = async () => {
    const dNum = formData.design_number || formData["design_#"];
    if (!dNum || !dNum.trim()) return;
    
    setCheckingDesign(true);
    try {
      const res = await fetch(`${API}/art/preorder/check/${encodeURIComponent(dNum.trim())}`, { credentials: 'include' });
      if (res.ok) {
        const data = await res.json();
        if (data.found) {
          toast.success("¡Pre-orden encontrada! Datos cargados.");
          setLinkedPreorderId(data.data.preorder_id);
          
          setFormData(prev => ({
            ...prev,
            client: (options.clients || []).find(c => data.data.client && data.data.client.toUpperCase() === c.toUpperCase()) || data.data.client || prev.client,
            job_title_a: data.data.job_title_a || prev.job_title_a,
            sample: data.data.sample || prev.sample,
            screens: data.data.screens || prev.screens,
            artwork_status: data.data.artwork_status || prev.artwork_status,
            betty_column: data.data.betty_column || prev.betty_column,
            linked_preorder_id: data.data.preorder_id // Para enviar al backend
          }));
        } else {
          toast.warning("No se encontró ninguna pre-orden activa con ese número");
        }
      }
    } catch (err) {
      toast.error("Error consultando pre-orden");
    } finally {
      setCheckingDesign(false);
    }
  };

  const applyImportedData = (item) => {
    // 1. Prepare candidate data from the import result
    const candidateData = {
      order_number: item.order_number,
      order_name: item.style, // Some users use order_name instead of style
      client: (options.clients || []).find(c => item.client && item.client.toUpperCase().includes(c.toUpperCase())) || item.client,
      branding: (options.brandings || []).find(b => item.branding && b.toUpperCase().includes(item.branding.toUpperCase())) || item.branding,
      style: item.style,
      color: item.color,
      customer_po: item.customer_po,
      store_po: item.store_po,
      "store_po#": item.store_po,
      "design_#": item["design_#"],
      cancel_date: item.cancel_date,
      due_date: item.due_date,
      job_title_a: { url: printavoUrl, desc: item.job_title_desc || "Printavo WO" },
      quantity: item.quantity,
      notes: item.notes,
      unit_price: item.unit_price
    };

    // 2. Filter: only apply keys that are explicitly in formFieldKeys
    const filteredUpdate = {};
    const fieldSet = new Set(formFieldKeys);

    Object.entries(candidateData).forEach(([key, value]) => {
      if (value === undefined || value === null) return;
      
      if (fieldSet.has(key)) {
        if (key === 'notes') {
          // Append notes if already exists
          filteredUpdate[key] = formData.notes ? `${formData.notes}\n${value}` : value;
        } else {
          filteredUpdate[key] = value;
        }
      }
    });

    setFormData(prev => ({
      ...prev,
      ...filteredUpdate
    }));
    
    if (item.sizes) {
      setSizes(prev => {
        const newSizes = { ...prev };
        Object.keys(item.sizes).forEach(sz => {
          if (newSizes.hasOwnProperty(sz)) {
            newSizes[sz] = item.sizes[sz].toString();
          }
        });
        return newSizes;
      });
    }
    
    setShowImportPanel(false);
    setImportedItems([]);
    toast.success("Datos aplicados al formulario");
  };

  // Sync form data structure when keys change
  useEffect(() => {
    const init = {};
    formFieldKeys.forEach(k => { init[k] = ''; });
    setFormData(init);
    setSizes(SIZES_ORDER.reduce((acc, s) => ({ ...acc, [s]: '' }), {}));
  }, [formFieldKeys]);

  // Auto-calculate total quantity
  useEffect(() => {
    const total = Object.values(sizes).reduce((sum, val) => sum + (parseInt(val) || 0), 0);
    if (total > 0 && !isPreview) {
      setFormData(prev => ({ ...prev, quantity: total }));
    }
  }, [sizes, isPreview]);

  const set = (key, val) => {
    if (isPreview) return;
    setFormData(prev => ({ ...prev, [key]: val }));
  };

  const renderField = (key) => {
    const col = allColumns.find(c => c.key === key);
    if (!col) return null;
    const value = formData[key] || '';

    // Posiciones de impresión: las marca data entry al capturar la orden. Sin
    // este caso el campo caía al input de texto de abajo y había que teclear
    // "FRENTE,ESPALDA" a mano, con el backend rechazando cualquier variante mal
    // escrita. Se usa el MISMO control que la celda del tablero para que las dos
    // pantallas no puedan divergir.
    if (col.type === 'positions') {
      const activas = normalizarPosiciones(formData[key]);
      return (
        <div key={key} className="space-y-2">
          <label className="text-[11px] uppercase tracking-[0.1em] text-muted-foreground/80 font-black">{col.label}</label>
          <div className="flex items-center gap-2 h-9">
            <PositionsPicker
              value={activas}
              readOnly={isPreview}
              tamano="lg"
              onChange={(pos) => !isPreview && set(key, pos)}
            />
            <span className="text-[10px] text-muted-foreground/70">
              {activas.length === 0
                ? 'sin marcar — el avance por talla no se podrá calcular'
                : activas.join(' + ')}
            </span>
          </div>
        </div>
      );
    }

    if ((col.type === 'select' || col.type === 'status') && col.optionKey) {
      const opts = options[col.optionKey] || [];
      return (
        <div key={key} className="space-y-2">
          <label className="text-[11px] uppercase tracking-[0.1em] text-muted-foreground/80 font-black">{col.label}</label>
          <SearchableSelect 
            options={opts}
            value={value}
            onChange={(v) => !isPreview && set(key, v)}
            placeholder={`Seleccionar ${col.label}...`}
            allowCreate={true}
          />
        </div>
      );
    }

    if (col.type === 'date') {
      return (
        <div key={key} className="space-y-2">
          <label className="text-[11px] uppercase tracking-[0.1em] text-muted-foreground/80 font-black">{col.label}</label>
          <input 
            type="date" value={value} onChange={(e) => set(key, e.target.value)}
            disabled={isPreview}
            style={{ backgroundColor: 'hsl(var(--secondary))', color: 'hsl(var(--foreground))' }}
            className="w-full border border-border rounded px-3 py-1.5 h-9 text-sm" />
        </div>
      );
    }

    if (col.type === 'checkbox') {
      return (
        <div key={key} className="space-y-2">
          <label className="text-[11px] uppercase tracking-[0.1em] text-muted-foreground/80 font-black">{col.label}</label>
          <label className="flex items-center gap-2 cursor-pointer h-9">
            <input 
              type="checkbox" checked={!!value} onChange={(e) => set(key, e.target.checked)} 
              disabled={isPreview}
              className="w-4 h-4 cursor-pointer" />
            <span className="text-sm text-foreground">{value ? 'Si' : 'No'}</span>
          </label>
        </div>
      );
    }

    if (key === 'notes' || col.type === 'textarea') {
      return (
        <div key={key} className="space-y-2">
          <label className="text-[11px] uppercase tracking-[0.1em] text-muted-foreground/80 font-black">{col.label}</label>
          <textarea 
            value={value} onChange={(e) => set(key, e.target.value)}
            disabled={isPreview}
            style={{ backgroundColor: 'hsl(var(--secondary))', color: 'hsl(var(--foreground))' }}
            placeholder={isPreview ? "Area de notas..." : "Notas adicionales..."}
            className="w-full border border-border rounded px-3 py-2 text-sm resize-none h-20" />
        </div>
      );
    }

    if (col.type === 'link_desc') {
      const parsed = typeof value === 'object' && value ? value : { url: value || '', desc: '' };
      return (
        <div key={key} className="space-y-2">
          <label className="text-[11px] uppercase tracking-[0.1em] text-muted-foreground/80 font-black">{col.label}</label>
          <input 
            type="url" value={parsed.url} onChange={(e) => set(key, { ...parsed, url: e.target.value })}
            disabled={isPreview}
            style={{ backgroundColor: 'hsl(var(--secondary))', color: 'hsl(var(--foreground))' }}
            placeholder="https://..." className="w-full border border-border rounded px-3 py-1.5 h-9 text-sm mt-1" />
          <input 
            type="text" value={parsed.desc} onChange={(e) => set(key, { ...parsed, desc: e.target.value })}
            disabled={isPreview}
            style={{ backgroundColor: 'hsl(var(--secondary))', color: 'hsl(var(--foreground))' }}
            placeholder="Descripcion..." className="w-full border border-border rounded px-3 py-1.5 h-8 text-xs mt-1" />
        </div>
      );
    }

    const isReadOnly = (key === 'quantity' && Object.values(sizes).some(v => v !== '')) || isPreview;

    return (
      <div key={key} className="space-y-2">
        <label className="text-[11px] uppercase tracking-[0.1em] text-muted-foreground/80 font-black">{col.label}</label>
        <div className="relative">
          <input 
            type="text" value={value}
            onChange={(e) => {
              set(key, e.target.value);
              if (key === 'order_number' && setDuplicateWarning) setDuplicateWarning(null);
            }}
            onBlur={(e) => {
              if (key === 'order_number' && checkDuplicate) checkDuplicate(e.target.value);
            }}
            placeholder={col.type === 'link' ? 'https://...' : ''}
            readOnly={isReadOnly}
            disabled={isPreview}
            autoComplete="off"
            style={{ backgroundColor: 'hsl(var(--secondary))', color: 'hsl(var(--foreground))' }}
            className={`w-full border rounded px-3 py-1.5 h-9 text-sm ${isReadOnly ? 'opacity-70 cursor-not-allowed bg-muted/30' : ''} ${
              key === 'order_number' && duplicateWarning 
                ? (duplicateWarning.in_trash ? 'border-yellow-500 ring-1 ring-yellow-500/30' : 'border-destructive ring-1 ring-destructive/30') 
                : 'border-border'
            }`} />
          {key === 'order_number' && checkingDuplicate && <Loader2 className="w-4 h-4 animate-spin absolute right-3 top-2.5 text-muted-foreground" />}
        </div>
        {key === 'order_number' && duplicateWarning && (
          <div className={`flex items-center gap-2 px-3 py-2 border rounded text-xs animate-in fade-in slide-in-from-top-1 ${
            duplicateWarning.in_trash 
              ? 'bg-yellow-500/10 border-yellow-500/30 text-yellow-600 dark:text-yellow-500' 
              : 'bg-destructive/10 border-destructive/30 text-destructive'
          }`}>
            <AlertTriangle className="w-4 h-4 flex-shrink-0" />
            <span className="leading-tight">
              {duplicateWarning.in_trash 
                ? <><strong>ADVERTENCIA:</strong> Esta orden existe en <strong>PAPELERA</strong>.</>
                : <><strong>ERROR:</strong> Esta orden ya existe en <strong>{duplicateWarning.board}</strong>.</>
              }
            </span>
          </div>
        )}
      </div>
    );
  };

  const pairedKeys = formFieldKeys.filter(k => k !== 'notes');
  const rows = [];
  for (let i = 0; i < pairedKeys.length; i += 2) {
    rows.push(i + 1 < pairedKeys.length ? [pairedKeys[i], pairedKeys[i + 1]] : [pairedKeys[i]]);
  }
  const hasNotes = formFieldKeys.includes('notes');

  return (
    <div className={`flex-1 flex flex-col overflow-hidden h-full ${isPreview ? 'rounded-2xl border border-primary/20 bg-card shadow-2xl scale-[0.98] ring-1 ring-black/50 overflow-hidden' : ''}`}>
      {/* Header */}
      {!isPreview && (
        <DialogHeader className="p-6 pb-4 border-b border-border/40 shrink-0">
          <div className="flex items-center justify-between">
            <DialogTitle className="font-barlow text-2xl uppercase tracking-tighter font-black italic text-foreground flex items-center gap-3">
              <div className="w-8 h-1 bg-primary rounded-full" />
              {t('new_order_title')}
            </DialogTitle>
            <button onClick={onClose} className="p-2 rounded-full hover:bg-secondary/80 transition-colors text-muted-foreground hover:text-foreground">
              <X className="h-5 w-5" />
            </button>
          </div>
        </DialogHeader>
      )}

      {/* Combined Scrollable Area */}
      <div className={`flex-1 overflow-y-auto p-0 custom-scrollbar ${isPreview ? 'bg-secondary/10' : 'bg-gradient-to-b from-transparent to-secondary/10'}`}>
        <div className="px-6 py-5">
          <div className="max-w-4xl mx-auto space-y-4">
          
          {/* Printavo Magic Import */}
          <div className="bg-primary/5 border border-primary/20 rounded-xl p-3.5 relative overflow-hidden group">
            <div className="absolute top-0 right-0 p-3 opacity-10 group-hover:scale-110 transition-transform pointer-events-none">
              <Zap className="w-10 h-10 text-primary" />
            </div>

            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2.5">
                <div className="w-8 h-8 rounded-lg bg-primary/20 flex items-center justify-center text-primary shadow-inner shrink-0">
                  <Zap className="w-4 h-4" />
                </div>
                <div>
                  <h3 className="text-xs font-black uppercase tracking-widest text-foreground">Importación Externa</h3>
                  <p className="text-[9px] uppercase font-bold text-muted-foreground/60">Extrae datos desde Printavo (Enlace o PDF)</p>
                </div>
              </div>
              <button 
                type="button"
                onClick={() => setShowImportPanel(!showImportPanel)}
                className="text-[10px] font-black uppercase tracking-widest text-primary hover:underline relative z-10"
              >
                {showImportPanel ? "Ocultar" : "Abrir Motor"}
              </button>
            </div>

            {showImportPanel && (
              <div className="space-y-3 mt-3 animate-in fade-in slide-in-from-top-2 duration-300">
                <div className="flex gap-2">
                  <div className="relative flex-1">
                    <Link2 className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                    <input 
                      type="text" 
                      value={printavoUrl}
                      onChange={(e) => setPrintavoUrl(e.target.value)}
                      placeholder="https://prosper-mfg.printavo.com/work_orders/..."
                      className="w-full bg-background border border-border/50 rounded-xl pl-10 pr-4 py-2.5 text-sm focus:ring-2 focus:ring-primary/20 transition-all outline-none"
                    />
                  </div>
                  <button 
                    onClick={handlePrintavoAnalyze}
                    disabled={importLoading}
                    className="px-6 py-2.5 bg-primary text-black rounded-xl font-black text-[10px] uppercase tracking-widest hover:bg-primary/90 transition-all shadow-lg active:scale-95 disabled:opacity-50"
                  >
                    {importLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : "Analizar"}
                  </button>
                </div>

                {importedItems.length > 1 && (
                  <div className="space-y-2 border-t border-border/20 pt-4">
                    <p className="text-[10px] font-black uppercase text-muted-foreground tracking-tighter">Múltiples estilos detectados. Selecciona uno:</p>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                      {importedItems.map((item, idx) => (
                        <button 
                          key={idx}
                          onClick={() => applyImportedData(item)}
                          className="flex items-center gap-3 p-3 bg-card border border-border rounded-xl hover:border-primary/50 transition-all text-left group"
                        >
                          <div className="w-8 h-8 rounded-lg bg-secondary flex items-center justify-center text-[10px] font-black">
                            {idx + 1}
                          </div>
                          <div className="flex-1 min-w-0">
                            <p className="text-xs font-black truncate">{item.style || "Sin Estilo"}</p>
                            <p className="text-[9px] uppercase font-bold text-muted-foreground">{Object.keys(item.sizes || {}).length} Tallas • {item.quantity} Uni.</p>
                          </div>
                          <Plus className="w-4 h-4 text-muted-foreground group-hover:text-primary transition-colors" />
                        </button>
                      ))}
                    </div>
                  </div>
                )}
                
                {importedItems.length === 0 && !importLoading && (
                  <div className="flex items-center gap-2 px-3 py-2 bg-secondary/50 rounded-lg border border-border/30">
                    <Info className="w-3.5 h-3.5 text-primary" />
                    <p className="text-[9px] font-bold text-muted-foreground uppercase leading-relaxed">
                      Carga el enlace de la Work Order o el PDF de Invoice para extraer tallas y cantidades automáticamente.
                    </p>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Pre-Order Linkage Section */}
          <div className="bg-amber-50/50 border border-amber-200 rounded-xl p-3.5 relative overflow-hidden">
            <div className="absolute top-0 right-0 p-3 opacity-10 pointer-events-none">
              <Tag className="w-10 h-10 text-amber-500" />
            </div>
            <div className="flex items-center gap-2.5 mb-3">
              <div className="w-8 h-8 rounded-lg bg-amber-500/20 flex items-center justify-center text-amber-600 shadow-inner shrink-0">
                <Link2 className="w-4 h-4" />
              </div>
              <div>
                <h3 className="text-xs font-black uppercase tracking-widest text-amber-900">Vincular Pre-Orden</h3>
                <p className="text-[9px] uppercase font-bold text-amber-700/60">Ingresa el Design # para jalar el arte</p>
              </div>
            </div>
            <div className="flex gap-2">
              <div className="relative flex-1">
                <Tag className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-amber-600/50" />
                <input
                  type="text"
                  value={formData.design_number || formData["design_#"] || ''}
                  onChange={(e) => {
                    set('design_number', e.target.value.toUpperCase());
                    set('design_#', e.target.value.toUpperCase());
                  }}
                  onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); handleDesignCheck(); } }}
                  placeholder="Ej: DES-999"
                  className="w-full bg-white border border-amber-200 rounded-lg pl-10 pr-4 py-2.5 text-sm font-black text-slate-900 focus:border-amber-500 focus:ring-2 focus:ring-amber-500/20 transition-all outline-none uppercase"
                />
              </div>
              <button
                type="button"
                onClick={handleDesignCheck}
                disabled={checkingDesign || (!formData.design_number && !formData["design_#"])}
                className="px-6 py-2.5 bg-amber-500 text-white rounded-lg font-black text-[10px] uppercase tracking-widest hover:bg-amber-600 transition-all shadow-lg active:scale-95 disabled:opacity-50"
              >
                {checkingDesign ? <Loader2 className="w-4 h-4 animate-spin" /> : "Buscar"}
              </button>
            </div>
            {linkedPreorderId && (
              <div className="mt-2.5 flex items-center gap-2 text-[10px] font-black text-emerald-600 uppercase tracking-widest bg-emerald-50 px-3 py-1.5 rounded-lg border border-emerald-200">
                <CheckCircle2 className="w-3.5 h-3.5" /> Vinculado a Pre-Orden Exitosamente
              </div>
            )}
          </div>

          {/* Twin (gemela) Linkage Section */}
          <div className="bg-fuchsia-500/5 border border-fuchsia-500/20 rounded-xl p-3.5 relative overflow-hidden">
            <div className="absolute top-0 right-0 p-3 opacity-10 pointer-events-none">
              <Users className="w-10 h-10 text-fuchsia-500" />
            </div>
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2.5">
                <div className="w-8 h-8 rounded-lg bg-fuchsia-500/20 flex items-center justify-center text-fuchsia-500 shadow-inner shrink-0">
                  <Users className="w-4 h-4" />
                </div>
                <div>
                  <h3 className="text-xs font-black uppercase tracking-widest text-foreground">Orden Gemela (Twin)</h3>
                  <p className="text-[9px] uppercase font-bold text-muted-foreground/60">Marca esta orden como gemela de otra existente</p>
                </div>
              </div>
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={twinEnabled}
                  onChange={(e) => {
                    setTwinEnabled(e.target.checked);
                    if (!e.target.checked) { setTwinOrderNumber(''); setTwinStatus(null); }
                  }}
                  disabled={isPreview}
                  className="w-4 h-4 cursor-pointer"
                />
                <span className="text-[10px] font-black uppercase tracking-widest text-fuchsia-500">
                  {twinEnabled ? 'Activado' : 'Activar'}
                </span>
              </label>
            </div>
            {twinEnabled && (
              <div className="space-y-3 mt-3 animate-in fade-in slide-in-from-top-2 duration-200">
                <div className="flex gap-2">
                  <div className="relative flex-1">
                    <Tag className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-fuchsia-500/60" />
                    <input
                      type="text"
                      value={twinOrderNumber}
                      onChange={(e) => { setTwinOrderNumber(e.target.value); setTwinStatus(null); }}
                      onBlur={handleTwinCheck}
                      onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); handleTwinCheck(); } }}
                      placeholder="Numero de la orden gemela"
                      disabled={isPreview}
                      className="w-full bg-background border border-fuchsia-500/30 rounded-xl pl-10 pr-4 py-2.5 text-sm focus:border-fuchsia-500 focus:ring-2 focus:ring-fuchsia-500/20 transition-all outline-none"
                    />
                  </div>
                  <button
                    type="button"
                    onClick={handleTwinCheck}
                    disabled={twinChecking || !twinOrderNumber.trim() || isPreview}
                    className="px-6 py-2.5 bg-fuchsia-500 text-white rounded-xl font-black text-[10px] uppercase tracking-widest hover:bg-fuchsia-600 transition-all shadow-lg active:scale-95 disabled:opacity-50"
                  >
                    {twinChecking ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Verificar'}
                  </button>
                </div>
                {twinStatus?.found && (
                  <div className="flex items-center gap-2 text-[10px] font-black text-emerald-500 uppercase tracking-widest bg-emerald-500/10 px-3 py-2 rounded-lg border border-emerald-500/30">
                    <CheckCircle2 className="w-3.5 h-3.5" />
                    Orden encontrada en <span className="text-emerald-600">{twinStatus.board}</span> — se vinculara al crear
                  </div>
                )}
                {twinStatus && !twinStatus.found && (
                  <div className="flex items-center gap-2 text-[10px] font-black text-destructive uppercase tracking-widest bg-destructive/10 px-3 py-2 rounded-lg border border-destructive/30">
                    <AlertTriangle className="w-3.5 h-3.5" />
                    {twinStatus.message}
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Section: Order Info */}
          <div className="space-y-6">
            {rows.map((row, i) => (
              <div key={i} className={`grid gap-5 ${row.length === 2 ? 'grid-cols-2' : 'grid-cols-1'}`}>
                {row.map(key => renderField(key))}
              </div>
            ))}
          </div>

          {/* Sizes Horizontal Section */}
          <div className="pt-8 border-t border-border/20 space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="text-[10px] font-black uppercase tracking-[0.2em] text-muted-foreground flex items-center gap-2">
                <div className="w-2 h-2 rounded-full bg-primary shadow-[0_0_8px_rgba(255,193,7,0.5)]" />
                Tallas / Sizes
              </h3>
              <div className="flex items-center gap-3 bg-secondary/30 px-3 py-1.5 rounded-lg border border-border/40">
                <span className="text-[9px] font-black uppercase text-muted-foreground/60 tracking-widest">Total</span>
                <span className="text-xl font-black text-primary tabular-nums">
                  {Object.values(sizes).reduce((s, v) => s + (parseInt(v) || 0), 0)}
                </span>
              </div>
            </div>
            
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-5 lg:grid-cols-9 gap-2">
              {SIZES_ORDER.map(sz => (
                <div key={sz} className="space-y-1 group">
                  <label className="text-[9px] font-black uppercase tracking-widest text-muted-foreground/60 group-focus-within:text-primary transition-colors text-center block">
                    {sz}
                  </label>
                  <input 
                    type="number"
                    min="0"
                    placeholder="0"
                    value={sizes[sz] ?? ''}
                    disabled={isPreview}
                    onChange={(e) => setSizes(prev => ({ ...prev, [sz]: e.target.value }))}
                    className="w-full bg-background/50 border border-border/50 rounded-lg px-2 py-1.5 text-sm font-mono text-foreground text-center focus:border-primary focus:ring-1 focus:ring-primary transition-all shadow-sm"
                  />
                </div>
              ))}
            </div>
          </div>

          {/* Notes Area */}
          {hasNotes && (
            <div className="pt-8 border-t border-border/20">
              {renderField('notes')}
            </div>
          )}

          </div>
        </div>
      </div>

      {/* Sticky Actions Footer */}
      {!isPreview && (
        <div className="p-6 border-t border-border/60 bg-card/95 backdrop-blur-sm shrink-0">
          <div className="flex justify-end gap-3 shadow-2xl">
            <button onClick={onClose} className="px-6 py-2.5 text-xs font-black uppercase tracking-widest text-muted-foreground hover:text-foreground hover:bg-secondary/50 rounded-xl transition-all">
              {t('cancel')}
            </button>
            <button
              onClick={() => onSubmit(formData, sizes, { twinOrderNumber: twinEnabled && twinStatus?.found ? twinOrderNumber.trim() : null })}
              disabled={loading || (duplicateWarning && !duplicateWarning.in_trash) || checkingDuplicate || (twinEnabled && (!twinOrderNumber.trim() || !twinStatus?.found))}
              className={`px-8 py-3 rounded-xl font-black uppercase tracking-widest text-xs flex items-center gap-3 transition-all shadow-lg active:scale-95 ${
                (duplicateWarning && !duplicateWarning.in_trash)
                  ? 'bg-muted text-muted-foreground cursor-not-allowed opacity-50 grayscale' 
                  : 'bg-primary text-black hover:bg-primary/90 shadow-primary/20 hover:shadow-primary/40'
              }`} 
            >
              {loading ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (duplicateWarning && !duplicateWarning.in_trash) ? (
                <AlertTriangle className="w-4 h-4" />
              ) : null} 
              {(duplicateWarning && !duplicateWarning.in_trash) ? 'Orden Duplicada' : t('create_order')}
            </button>
          </div>
        </div>
      )}
    </div>
  );
};
