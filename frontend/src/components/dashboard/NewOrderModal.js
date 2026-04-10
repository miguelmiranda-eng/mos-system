import { useState, useEffect, useCallback } from "react";
import { useLang } from "../../contexts/LanguageContext";
import { Loader2, AlertTriangle, X } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "../ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue, SelectGroup, SelectLabel, SelectSeparator } from "../ui/select";
import { toast } from "sonner";
import { API, DEFAULT_COLUMNS } from "../../lib/constants";

const HARDCODED_DEFAULTS = [
  'order_number', 'customer_po', 'store_po', 'cancel_date',
  'client', 'branding', 'priority', 'blank_source', 'blank_status',
  'job_title_a', 'sample', 'artwork_status', 'notes', 'style'
];

const SIZES_ORDER = ['XS', 'S', 'M', 'L', 'XL', '2X', '3X', '4X', '5X'];

export const NewOrderModal = ({ isOpen, onClose, onCreate, options, groupConfig, columns = [] }) => {
  const { t } = useLang();
  const [formData, setFormData] = useState({});
  const [sizes, setSizes] = useState(SIZES_ORDER.reduce((acc, s) => ({ ...acc, [s]: '' }), {}));
  const [loading, setLoading] = useState(false);
  const [duplicateWarning, setDuplicateWarning] = useState(null);
  const [checkingDuplicate, setCheckingDuplicate] = useState(false);
  const [formFieldKeys, setFormFieldKeys] = useState(HARDCODED_DEFAULTS);

  useEffect(() => {
    if (isOpen) {
      fetch(`${API}/config/form-fields`, { credentials: 'include' })
        .then(r => r.ok ? r.json() : {})
        .then(data => { 
          if (data.fields?.length) {
            // Merge defaults with remote to ensure 'style' is always present
            const combined = Array.from(new Set([...data.fields, ...HARDCODED_DEFAULTS]));
            setFormFieldKeys(combined); 
          } 
        })
        .catch(() => {});
    }
  }, [isOpen]);

  useEffect(() => {
    if (isOpen) {
      const init = {};
      formFieldKeys.forEach(k => { init[k] = ''; });
      setFormData(init);
      setSizes(SIZES_ORDER.reduce((acc, s) => ({ ...acc, [s]: '' }), {}));
      setDuplicateWarning(null);
    }
  }, [isOpen, formFieldKeys]);

  // Auto-calculate total quantity
  useEffect(() => {
    const total = Object.values(sizes).reduce((sum, val) => sum + (parseInt(val) || 0), 0);
    if (total > 0) {
      setFormData(prev => ({ ...prev, quantity: total }));
    }
  }, [sizes]);

  const allColumns = [...DEFAULT_COLUMNS, ...columns.filter(c => c.custom)];
  const set = (key, val) => setFormData(prev => ({ ...prev, [key]: val }));

  const checkDuplicate = useCallback(async (orderNumber) => {
    if (!orderNumber || !orderNumber.trim()) { setDuplicateWarning(null); return; }
    setCheckingDuplicate(true);
    try {
      const res = await fetch(`${API}/orders/check-number?order_number=${encodeURIComponent(orderNumber.trim())}`, { credentials: 'include' });
      if (res.ok) {
        const data = await res.json();
        setDuplicateWarning(data.exists ? { ...data.order, in_trash: data.in_trash } : null);
      }
    } catch { /* silent */ } finally { setCheckingDuplicate(false); }
  }, []);

  // Debounce for duplicate checking
  useEffect(() => {
    const orderNumber = formData['order_number'];
    if (!isOpen || !orderNumber || !orderNumber.trim()) {
      setDuplicateWarning(null);
      return;
    }

    const timer = setTimeout(() => {
      checkDuplicate(orderNumber);
    }, 500);

    return () => clearTimeout(timer);
  }, [formData.order_number, isOpen, checkDuplicate]);

  const handleSubmit = async () => {
    if (duplicateWarning && !duplicateWarning.in_trash) {
      toast.error(`No se puede crear: La orden ya existe en ${duplicateWarning.board}`);
      return;
    }
    setLoading(true);
    try {
      // Separate known model fields from custom fields
      const KNOWN_FIELDS = new Set([
        'order_number','po_number','customer_po','store_po','cancel_date','client','branding',
        'priority','blank_source','blank_status','production_status','trim_status','trim_box',
        'sample','artwork_status','betty_column','job_title_a','job_title_b','shipping',
        'quantity','due_date','notes','links','screens','color','design_#','final_bill',
        'style','sizes'
      ]);
      const payload = {};
      const customFields = {};
      const INT_FIELDS = new Set(['quantity']);
      Object.entries(formData).forEach(([key, value]) => {
        if (KNOWN_FIELDS.has(key)) {
          if (INT_FIELDS.has(key)) payload[key] = value === '' || value === null ? 0 : parseInt(value, 10) || 0;
          else payload[key] = value === '' ? null : value;
        } else if (value !== '' && value !== null && value !== undefined) {
          customFields[key] = value;
        }
      });
      
      // Clean up sizes and add to payload
      const cleanSizes = {};
      Object.entries(sizes).forEach(([s, v]) => { if (v) cleanSizes[s] = parseInt(v) || 0; });
      if (Object.keys(cleanSizes).length > 0) payload.sizes = cleanSizes;

      if (Object.keys(customFields).length > 0) payload.custom_fields = customFields;
      const res = await fetch(`${API}/orders`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        credentials: 'include', body: JSON.stringify(payload)
      });
      if (res.ok) { const order = await res.json(); onCreate(order); onClose(); toast.success(t('order_created')); }
      else { const err = await res.json().catch(() => ({})); toast.error(err.detail || t('order_create_err')); }
    } catch { toast.error(t('order_create_err')); } finally { setLoading(false); }
  };

  const renderField = (key) => {
    const col = allColumns.find(c => c.key === key);
    if (!col) return null;
    const value = formData[key] || '';

    if ((col.type === 'select' || col.type === 'status') && col.optionKey) {
      const opts = options[col.optionKey] || [];
      return (
        <div key={key} className="space-y-1.5">
          <label className="text-[10px] uppercase tracking-wider text-muted-foreground font-bold">{col.label}</label>
          <Select value={value || 'none'} onValueChange={(v) => set(key, v === 'none' ? '' : v)}>
            <SelectTrigger className="bg-secondary border-border" data-testid={`field-${key}`}><SelectValue placeholder="Seleccionar" /></SelectTrigger>
            <SelectContent className="bg-popover border-border z-[300] max-h-[250px]">
              <SelectItem value="none" className="text-muted-foreground italic tracking-tight">- Seleccionar -</SelectItem>
              <SelectSeparator className="opacity-50" />
              {(() => {
                if (!groupConfig || !groupConfig.label_to_group) {
                  return opts.map(opt => <SelectItem key={opt} value={opt} className="font-bold tracking-tight">{opt}</SelectItem>);
                }

                const grouped = {};
                opts.forEach(opt => {
                  const g = groupConfig.label_to_group[opt] || "SIN GRUPO";
                  if (!grouped[g]) grouped[g] = [];
                  grouped[g].push(opt);
                });

                const groupNames = Object.keys(grouped).sort((a, b) => {
                  if (a === "SIN GRUPO") return 1;
                  if (b === "SIN GRUPO") return -1;
                  return a.localeCompare(b);
                });

                return groupNames.map(gn => (
                  <SelectGroup key={gn}>
                    <div className="flex items-center gap-2 px-2 py-1.5 pointer-events-none">
                      <div className="w-1 h-3 rounded-full" style={{ backgroundColor: groupConfig.group_colors[gn] || "#666" }} />
                      <SelectLabel className="text-[10px] font-black uppercase tracking-[0.15em] text-muted-foreground/80">{gn}</SelectLabel>
                    </div>
                    {grouped[gn].map(opt => (
                      <SelectItem key={opt} value={opt} className="font-bold tracking-tight ml-2">
                        {opt}
                      </SelectItem>
                    ))}
                    <SelectSeparator className="opacity-30 my-1" />
                  </SelectGroup>
                ));
              })()}
            </SelectContent>
          </Select>
        </div>
      );
    }

    if (col.type === 'date') {
      return (
        <div key={key} className="space-y-1.5">
          <label className="text-[10px] uppercase tracking-wider text-muted-foreground font-bold">{col.label}</label>
          <input type="date" value={value} onChange={(e) => set(key, e.target.value)}
            className="w-full bg-secondary border border-border rounded px-3 py-2 text-sm text-foreground" data-testid={`field-${key}`} />
        </div>
      );
    }

    if (col.type === 'checkbox') {
      return (
        <div key={key} className="space-y-1.5">
          <label className="text-[10px] uppercase tracking-wider text-muted-foreground font-bold">{col.label}</label>
          <label className="flex items-center gap-2 cursor-pointer">
            <input type="checkbox" checked={!!value} onChange={(e) => set(key, e.target.checked)} className="w-4 h-4" data-testid={`field-${key}`} />
            <span className="text-sm text-foreground">{value ? 'Si' : 'No'}</span>
          </label>
        </div>
      );
    }

    if (key === 'notes') {
      return (
        <div key={key} className="space-y-1.5">
          <label className="text-[10px] uppercase tracking-wider text-muted-foreground font-bold">{col.label}</label>
          <textarea value={value} onChange={(e) => set(key, e.target.value)}
            placeholder="Notas adicionales..."
            className="w-full bg-secondary border border-border rounded px-3 py-2 text-sm text-foreground resize-none h-20" data-testid={`field-${key}`} />
        </div>
      );
    }

    if (col.type === 'link_desc') {
      const parsed = typeof value === 'object' && value ? value : { url: value || '', desc: '' };
      return (
        <div key={key} className="space-y-1.5">
          <label className="text-[10px] uppercase tracking-wider text-muted-foreground font-bold">{col.label}</label>
          <input type="url" value={parsed.url} onChange={(e) => set(key, { ...parsed, url: e.target.value })}
            placeholder="https://..." className="w-full bg-secondary border border-border rounded px-3 py-2 text-sm text-foreground" data-testid={`field-${key}-url`} />
          <input type="text" value={parsed.desc} onChange={(e) => set(key, { ...parsed, desc: e.target.value })}
            placeholder="Descripcion..." className="w-full bg-secondary border border-border rounded px-3 py-1.5 text-xs text-foreground" data-testid={`field-${key}-desc`} />
        </div>
      );
    }

    const isReadOnly = key === 'quantity' && Object.values(sizes).some(v => v !== '');

    return (
      <div key={key} className="space-y-1.5">
        <label className="text-[10px] uppercase tracking-wider text-muted-foreground font-bold">{col.label}</label>
        <div className="relative">
          <input type="text" value={value} onChange={(e) => { set(key, e.target.value); if (key === 'order_number') setDuplicateWarning(null); }}
            placeholder={col.type === 'link' ? 'https://...' : ''}
            readOnly={isReadOnly}
            className={`w-full bg-secondary border rounded px-3 py-2 text-sm text-foreground ${isReadOnly ? 'opacity-70 cursor-not-allowed bg-muted/30' : ''} ${
              key === 'order_number' && duplicateWarning 
                ? (duplicateWarning.in_trash ? 'border-yellow-500 ring-1 ring-yellow-500/30' : 'border-destructive ring-1 ring-destructive/30') 
                : 'border-border'
            }`}
            data-testid={`field-${key}`} />
          {key === 'order_number' && checkingDuplicate && <Loader2 className="w-4 h-4 animate-spin absolute right-3 top-2.5 text-muted-foreground" />}
        </div>
        {key === 'order_number' && duplicateWarning && (
          <div className={`flex items-center gap-2 px-3 py-2 border rounded text-xs animate-in fade-in slide-in-from-top-1 ${
            duplicateWarning.in_trash 
              ? 'bg-yellow-500/10 border-yellow-500/30 text-yellow-600 dark:text-yellow-500' 
              : 'bg-destructive/10 border-destructive/30 text-destructive'
          }`} data-testid="duplicate-warning">
            <AlertTriangle className="w-4 h-4 flex-shrink-0" />
            <span>
              {duplicateWarning.in_trash 
                ? <><strong>ADVERTENCIA:</strong> Esta orden existe en <strong>PAPELERA DE RECICLAJE</strong>. Puedes crearla nuevamente si lo deseas.</>
                : <><strong>ERROR:</strong> Esta orden ya existe en <strong>{duplicateWarning.board}</strong>. No se permiten duplicados.</>
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
    <Dialog open={isOpen} onOpenChange={(open) => { if (!open) return; }}>
      <DialogContent className="max-w-[95vw] md:max-w-5xl bg-card border-border max-h-[90vh] overflow-hidden p-0 flex flex-col [&>button:last-child]:hidden" data-testid="new-order-modal" onInteractOutside={(e) => e.preventDefault()} onEscapeKeyDown={(e) => e.preventDefault()}>
        <div className="flex h-full flex-col md:flex-row overflow-hidden">
          {/* Sizes Side Pane */}
          <div className="w-full md:w-64 bg-secondary/30 border-b md:border-b-0 md:border-r border-border p-6 flex flex-col animate-in slide-in-from-left-4 duration-500">
            <h3 className="text-[10px] font-black uppercase tracking-[0.2em] text-muted-foreground mb-6 flex items-center gap-2">
              <div className="w-2 h-2 rounded-full bg-primary" />
              Tallas / Sizes
            </h3>
            <div className="grid grid-cols-2 md:grid-cols-1 gap-4 overflow-y-auto pr-2 custom-scrollbar">
              {SIZES_ORDER.map(sz => (
                <div key={sz} className="space-y-1.5 group">
                  <label className="text-[9px] font-black uppercase tracking-widest text-muted-foreground/60 group-focus-within:text-primary transition-colors">
                    {sz}
                  </label>
                  <input 
                    type="number"
                    min="0"
                    placeholder="0"
                    value={sizes[sz]}
                    onChange={(e) => setSizes(prev => ({ ...prev, [sz]: e.target.value }))}
                    className="w-full bg-background/50 border border-border/50 rounded-lg px-3 py-2 text-sm font-mono text-foreground focus:border-primary focus:ring-1 focus:ring-primary transition-all shadow-sm"
                    data-testid={`size-input-${sz}`}
                  />
                </div>
              ))}
            </div>
            <div className="mt-auto pt-6 border-t border-border/40">
              <div className="text-[9px] font-black uppercase text-muted-foreground tracking-widest mb-1">Total Sumado</div>
              <div className="text-2xl font-black text-primary tabular-nums">
                {Object.values(sizes).reduce((s, v) => s + (parseInt(v) || 0), 0)}
              </div>
            </div>
          </div>

          {/* Main Form Fields */}
          <div className="flex-1 overflow-y-auto p-6 flex flex-col h-full bg-card relative">
            <DialogHeader className="mb-6">
              <div className="flex items-center justify-between">
                <DialogTitle className="font-barlow text-2xl uppercase tracking-tighter font-black italic text-foreground">
                  {t('new_order_title')}
                </DialogTitle>
                <button onClick={onClose} className="p-2 rounded-full hover:bg-secondary/80 transition-colors" data-testid="close-new-order-x">
                  <X className="h-5 w-5" />
                </button>
              </div>
            </DialogHeader>

            <div className="space-y-6 flex-1">
              {rows.map((row, i) => (
                <div key={i} className={`grid gap-4 ${row.length === 2 ? 'grid-cols-2' : 'grid-cols-1'}`}>
                  {row.map(key => renderField(key))}
                </div>
              ))}
              {hasNotes && renderField('notes')}
            </div>

            <div className="flex justify-end gap-3 mt-8 pt-6 border-t border-border/40 bg-card sticky bottom-0">
              <button onClick={onClose} className="px-6 py-2.5 text-xs font-black uppercase tracking-widest text-muted-foreground hover:text-foreground hover:bg-secondary/50 rounded-xl transition-all" data-testid="cancel-new-order">
                {t('cancel')}
              </button>
              <button 
                onClick={handleSubmit} 
                disabled={loading || (duplicateWarning && !duplicateWarning.in_trash) || checkingDuplicate} 
                className={`px-8 py-2.5 rounded-xl font-black uppercase tracking-widest text-xs flex items-center gap-2 transition-all shadow-lg active:scale-95 ${
                  (duplicateWarning && !duplicateWarning.in_trash)
                    ? 'bg-muted text-muted-foreground cursor-not-allowed opacity-50 grayscale' 
                    : 'bg-primary text-black hover:bg-primary/90 shadow-primary/20 hover:shadow-primary/30'
                }`} 
                data-testid="submit-new-order"
              >
                {loading && <Loader2 className="w-4 h-4 animate-spin" />} 
                {(duplicateWarning && !duplicateWarning.in_trash) ? 'Orden Duplicada' : t('create_order')}
              </button>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
};
