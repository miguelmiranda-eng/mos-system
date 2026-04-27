import { useState, useEffect, useCallback } from "react";
import { useLang } from "../../contexts/LanguageContext";
import { Dialog, DialogPortal, DialogOverlay } from "../ui/dialog";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { toast } from "sonner";
import { API, DEFAULT_COLUMNS } from "../../lib/constants";
import { NewOrderForm } from "./NewOrderForm";

const HARDCODED_DEFAULTS = [
  'order_number', 'customer_po', 'style', 'client', 'branding', 
  'priority', 'quantity', 'due_date', 'blank_source', 'blank_status', 
  'production_status', 'notes'
];

export const NewOrderModal = ({ isOpen, onClose, onCreate, options, groupConfig, columns = [] }) => {
  const { t } = useLang();
  const [loading, setLoading] = useState(false);
  const [duplicateWarning, setDuplicateWarning] = useState(null);
  const [checkingDuplicate, setCheckingDuplicate] = useState(false);
  const [formFieldKeys, setFormFieldKeys] = useState(HARDCODED_DEFAULTS);

  const allColumns = [...DEFAULT_COLUMNS, ...columns.filter(c => c.custom)];

  useEffect(() => {
    if (isOpen) {
      fetch(`${API}/config/form-fields`, { credentials: 'include' })
        .then(r => r.ok ? r.json() : {})
        .then(data => { 
          if (data.fields?.length) {
            // Priority 1: User defined fields from config
            setFormFieldKeys(data.fields); 
          } else {
            // Priority 2: Safe fallback if no config exists
            setFormFieldKeys([
              'order_number', 'customer_po', 'style', 'client', 'branding', 
              'priority', 'quantity', 'due_date', 'notes'
            ]);
          }
        })
        .catch(() => {});
    }
  }, [isOpen]);

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

  const handleSubmit = async (formData, sizes) => {
    if (duplicateWarning && !duplicateWarning.in_trash) {
      toast.error(`No se puede crear: La orden ya existe en ${duplicateWarning.board}`);
      return;
    }
    setLoading(true);
    try {
      const INT_FIELDS = new Set(['quantity']);
      const payload = {};
      
      Object.entries(formData).forEach(([key, value]) => {
        if (INT_FIELDS.has(key)) {
          payload[key] = value === '' || value === null ? 0 : parseInt(value, 10) || 0;
        } else {
          payload[key] = value === '' ? null : value;
        }
      });
      
      const cleanSizes = {};
      Object.entries(sizes).forEach(([s, v]) => { if (v) cleanSizes[s] = parseInt(v) || 0; });
      if (Object.keys(cleanSizes).length > 0) payload.sizes = cleanSizes;

      const res = await fetch(`${API}/orders`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        credentials: 'include', body: JSON.stringify(payload)
      });
      if (res.ok) { const order = await res.json(); onCreate(order); onClose(); toast.success(t('order_created')); }
      else { const err = await res.json().catch(() => ({})); toast.error(err.detail || t('order_create_err')); }
    } catch { toast.error(t('order_create_err')); } finally { setLoading(false); }
  };

  return (
    <Dialog open={isOpen} onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogPortal>
        <DialogOverlay className="backdrop-blur-sm bg-black/20" />
        <DialogPrimitive.Content
          className="fixed left-[50%] top-[50%] z-[901] max-w-[95vw] md:max-w-4xl w-full translate-x-[-50%] translate-y-[-50%] transform-gpu bg-card border border-border h-[90vh] p-0 flex flex-col shadow-2xl transition-all duration-300 sm:rounded-lg data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95"
          onInteractOutside={(e) => {
            if (e.target?.closest?.('[data-radix-popper-content-wrapper]')) return;
            e.preventDefault();
          }}
          onEscapeKeyDown={(e) => e.preventDefault()}
        >
        <NewOrderForm
          formFieldKeys={formFieldKeys}
          options={options}
          groupConfig={groupConfig}
          allColumns={allColumns}
          onClose={onClose}
          onSubmit={handleSubmit}
          loading={loading}
          duplicateWarning={duplicateWarning}
          checkingDuplicate={checkingDuplicate}
          setDuplicateWarning={setDuplicateWarning}
          checkDuplicate={checkDuplicate}
        />
        </DialogPrimitive.Content>
      </DialogPortal>
    </Dialog>
  );
};

