import { useState, useEffect, useCallback, useMemo } from "react";
import { useLang } from "../../contexts/LanguageContext";
import { Dialog, DialogPortal, DialogOverlay } from "../ui/dialog";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { toast } from "sonner";
import { API, DEFAULT_COLUMNS } from "../../lib/constants";
import { NewOrderForm } from "./NewOrderForm";

import { LoadingOverlay } from "./LoadingOverlay";

export const NewOrderModal = ({ isOpen, onClose, onCreate, options, groupConfig, columns = [] }) => {
  const { t } = useLang();
  const [loading, setLoading] = useState(false);
  const [duplicateWarning, setDuplicateWarning] = useState(null);
  const [checkingDuplicate, setCheckingDuplicate] = useState(false);
  const [formConfig, setFormConfig] = useState({ fields: null, hidden: null });

  // The field universe is the GLOBAL column set (Columnas Globales): `columns`
  // already excludes removed defaults and includes customs. Fall back to the
  // built-in defaults only if it hasn't loaded yet.
  const allColumns = columns.length ? columns : DEFAULT_COLUMNS;

  // Which fields actually render, in order. New global columns default to
  // VISIBLE; only explicitly-hidden fields are dropped. MEMOIZED so the array
  // reference stays stable across re-renders — otherwise NewOrderForm's
  // key-sync effect would reset the form (wiping typed fields) every time the
  // modal re-renders (e.g. the order-number duplicate check).
  const formFieldKeys = useMemo(() => {
    const cols = columns.length ? columns : DEFAULT_COLUMNS;
    const valid = new Set(cols.map(c => c.key));
    if (!formConfig.fields?.length) {
      return ['order_number', 'customer_po', 'style', 'client', 'branding',
        'priority', 'quantity', 'due_date', 'notes'].filter(k => valid.has(k));
    }
    const order = formConfig.fields.filter(k => valid.has(k));
    cols.forEach(c => { if (!order.includes(c.key)) order.push(c.key); });
    const hidden = Array.isArray(formConfig.hidden)
      ? new Set(formConfig.hidden)
      : new Set(cols.filter(c => !formConfig.fields.includes(c.key) && !c.custom).map(c => c.key));
    return order.filter(k => !hidden.has(k));
  }, [columns, formConfig]);

  useEffect(() => {
    if (isOpen) {
      fetch(`${API}/config/form-fields`, { credentials: 'include' })
        .then(r => r.ok ? r.json() : {})
        .then(data => setFormConfig({
          fields: data.fields || null,
          hidden: Array.isArray(data.hidden_fields) ? data.hidden_fields : null,
        }))
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

  const handleSubmit = async (formData, sizes, extras = {}) => {
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
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        toast.error(err.detail || t('order_create_err'));
        return;
      }
      const order = await res.json();

      // Twin pairing — runs after the order exists so we have its order_id.
      // Failure here doesn't roll back the order; we surface a warning and
      // let the operator retry/link manually.
      if (extras.twinOrderNumber) {
        try {
          const tres = await fetch(`${API}/orders/${order.order_id}/twin`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify({ twin_order_number: extras.twinOrderNumber }),
          });
          if (tres.ok) {
            const tdata = await tres.json();
            order.twin_order_number = tdata.twin_order_number;
            toast.success(`Orden creada · vinculada como gemela de ${tdata.twin_order_number}`);
          } else {
            const terr = await tres.json().catch(() => ({}));
            toast.warning(`Orden creada pero no se pudo vincular: ${terr.detail || 'error'}`);
          }
        } catch {
          toast.warning('Orden creada pero el vinculo de gemela fallo (revisar conexion)');
        }
      } else {
        toast.success(t('order_created'));
      }

      onCreate(order);
      onClose();
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
        <LoadingOverlay isLoading={loading} message={t('processing')} />
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


