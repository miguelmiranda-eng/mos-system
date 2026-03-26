import { useState, useEffect, useCallback } from "react";
import { useLang } from "../../contexts/LanguageContext";
import { Loader2, AlertTriangle, X } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "../ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";
import { toast } from "sonner";
import { API, DEFAULT_COLUMNS } from "../../lib/constants";

const HARDCODED_DEFAULTS = [
  'order_number', 'customer_po', 'store_po', 'cancel_date',
  'client', 'branding', 'priority', 'blank_source', 'blank_status',
  'job_title_a', 'sample', 'artwork_status', 'notes'
];

export const NewOrderModal = ({ isOpen, onClose, onCreate, options, columns = [] }) => {
  const { t } = useLang();
  const [formData, setFormData] = useState({});
  const [loading, setLoading] = useState(false);
  const [duplicateWarning, setDuplicateWarning] = useState(null);
  const [checkingDuplicate, setCheckingDuplicate] = useState(false);
  const [formFieldKeys, setFormFieldKeys] = useState(HARDCODED_DEFAULTS);

  useEffect(() => {
    if (isOpen) {
      fetch(`${API}/config/form-fields`, { credentials: 'include' })
        .then(r => r.ok ? r.json() : {})
        .then(data => { if (data.fields?.length) setFormFieldKeys(data.fields); })
        .catch(() => {});
    }
  }, [isOpen]);

  useEffect(() => {
    if (isOpen) {
      const init = {};
      formFieldKeys.forEach(k => { init[k] = ''; });
      setFormData(init);
      setDuplicateWarning(null);
    }
  }, [isOpen, formFieldKeys]);

  const allColumns = [...DEFAULT_COLUMNS, ...columns.filter(c => c.custom)];
  const set = (key, val) => setFormData(prev => ({ ...prev, [key]: val }));

  const checkDuplicate = useCallback(async (orderNumber) => {
    if (!orderNumber || !orderNumber.trim()) { setDuplicateWarning(null); return; }
    setCheckingDuplicate(true);
    try {
      const res = await fetch(`${API}/orders/check-number?order_number=${encodeURIComponent(orderNumber.trim())}`, { credentials: 'include' });
      if (res.ok) {
        const data = await res.json();
        setDuplicateWarning(data.exists ? data.order : null);
      }
    } catch { /* silent */ } finally { setCheckingDuplicate(false); }
  }, []);

  const handleSubmit = async () => {
    setLoading(true);
    try {
      // Separate known model fields from custom fields
      const KNOWN_FIELDS = new Set([
        'order_number','po_number','customer_po','store_po','cancel_date','client','branding',
        'priority','blank_source','blank_status','production_status','trim_status','trim_box',
        'sample','artwork_status','betty_column','job_title_a','job_title_b','shipping',
        'quantity','due_date','notes','links','screens'
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
              <SelectItem value="none">- Seleccionar -</SelectItem>
              {opts.map(opt => <SelectItem key={opt} value={opt}>{opt}</SelectItem>)}
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

    return (
      <div key={key} className="space-y-1.5">
        <label className="text-[10px] uppercase tracking-wider text-muted-foreground font-bold">{col.label}</label>
        <div className="relative">
          <input type="text" value={value} onChange={(e) => { set(key, e.target.value); if (key === 'order_number') setDuplicateWarning(null); }}
            onBlur={() => { if (key === 'order_number') checkDuplicate(value); }}
            placeholder={col.type === 'link' ? 'https://...' : ''}
            className={`w-full bg-secondary border rounded px-3 py-2 text-sm text-foreground ${key === 'order_number' && duplicateWarning ? 'border-yellow-500' : 'border-border'}`}
            data-testid={`field-${key}`} />
          {key === 'order_number' && checkingDuplicate && <Loader2 className="w-4 h-4 animate-spin absolute right-3 top-2.5 text-muted-foreground" />}
        </div>
        {key === 'order_number' && duplicateWarning && (
          <div className="flex items-center gap-2 px-3 py-2 bg-yellow-500/10 border border-yellow-500/30 rounded text-xs text-yellow-600 dark:text-yellow-400" data-testid="duplicate-warning">
            <AlertTriangle className="w-4 h-4 flex-shrink-0" />
            <span>Esta orden ya existe en <strong>{duplicateWarning.board}</strong> ({duplicateWarning.order_number})</span>
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
      <DialogContent className="max-w-[95vw] md:max-w-2xl bg-card border-border max-h-[85vh] overflow-y-auto [&>button:last-child]:hidden" data-testid="new-order-modal" onInteractOutside={(e) => e.preventDefault()} onEscapeKeyDown={(e) => e.preventDefault()}>
        <DialogHeader>
          <DialogTitle className="font-barlow text-xl uppercase tracking-wide">{t('new_order_title')}</DialogTitle>
          <button onClick={onClose} className="absolute right-4 top-4 rounded-sm opacity-70 hover:opacity-100" data-testid="close-new-order-x"><X className="h-4 w-4" /></button>
        </DialogHeader>
        <div className="space-y-4 mt-4">
          {rows.map((row, i) => (
            <div key={i} className={`grid gap-3 ${row.length === 2 ? 'grid-cols-2' : 'grid-cols-1'}`}>
              {row.map(key => renderField(key))}
            </div>
          ))}
          {hasNotes && renderField('notes')}
        </div>
        <div className="flex justify-end gap-3 mt-6">
          <button onClick={onClose} className="px-4 py-2 text-muted-foreground hover:text-foreground" data-testid="cancel-new-order">{t('cancel')}</button>
          <button onClick={handleSubmit} disabled={loading} className="px-6 py-2 bg-primary text-primary-foreground rounded hover:bg-primary/90 disabled:opacity-50 flex items-center gap-2" data-testid="submit-new-order">
            {loading && <Loader2 className="w-4 h-4 animate-spin" />} {t('create_order')}
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
};
