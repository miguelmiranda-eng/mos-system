import { useState, useEffect } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "../ui/dialog";
import { ClipboardList, Check, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { API, DEFAULT_COLUMNS } from "../../lib/constants";

const HARDCODED_DEFAULTS = [
  'order_number', 'customer_po', 'store_po', 'cancel_date',
  'client', 'branding', 'priority', 'blank_source', 'blank_status',
  'job_title_a', 'sample', 'artwork_status', 'notes'
];

export const FormFieldsManagerModal = ({ isOpen, onClose, columns = [] }) => {
  const [selectedFields, setSelectedFields] = useState(HARDCODED_DEFAULTS);
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(false);

  const allColumns = [...DEFAULT_COLUMNS, ...columns.filter(c => c.custom)];

  useEffect(() => {
    if (!isOpen) return;
    setLoading(true);
    fetch(`${API}/config/form-fields`, { credentials: 'include' })
      .then(r => r.ok ? r.json() : {})
      .then(data => { if (data.fields?.length) setSelectedFields(data.fields); })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [isOpen]);

  const toggle = (key) => {
    setSelectedFields(prev =>
      prev.includes(key) ? prev.filter(k => k !== key) : [...prev, key]
    );
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      const res = await fetch(`${API}/config/form-fields`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
        body: JSON.stringify({ fields: selectedFields })
      });
      if (res.ok) { toast.success("Campos del formulario actualizados"); onClose(); }
      else toast.error("Error al guardar");
    } catch { toast.error("Error al guardar"); } finally { setSaving(false); }
  };

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="max-w-md max-h-[80vh] bg-card border-border overflow-hidden flex flex-col" data-testid="form-fields-manager-modal">
        <DialogHeader>
          <DialogTitle className="font-barlow text-xl uppercase tracking-wide flex items-center gap-2">
            <ClipboardList className="w-5 h-5 text-primary" /> Campos del Formulario
          </DialogTitle>
        </DialogHeader>
        <p className="text-xs text-muted-foreground">Selecciona los campos que apareceran en el formulario de "Crear Orden".</p>
        {loading ? (
          <div className="flex justify-center py-8"><Loader2 className="w-6 h-6 animate-spin" /></div>
        ) : (
          <div className="flex-1 overflow-y-auto mt-2 space-y-1">
            {allColumns.map(col => {
              const active = selectedFields.includes(col.key);
              return (
                <button key={col.key} onClick={() => toggle(col.key)}
                  className={`w-full flex items-center gap-3 px-3 py-2 rounded text-left transition-all ${active ? 'bg-primary/10 border border-primary/30' : 'bg-secondary/30 border border-border hover:border-primary/20'}`}
                  data-testid={`form-field-toggle-${col.key}`}>
                  <div className={`w-5 h-5 rounded flex items-center justify-center flex-shrink-0 ${active ? 'bg-primary text-primary-foreground' : 'bg-secondary border border-border'}`}>
                    {active && <Check className="w-3 h-3" />}
                  </div>
                  <div className="flex-1 min-w-0">
                    <span className="text-sm font-medium text-foreground">{col.label}</span>
                    <span className="text-[10px] text-muted-foreground ml-2">{col.type}{col.custom ? ' (personalizada)' : ''}</span>
                  </div>
                </button>
              );
            })}
          </div>
        )}
        <div className="flex justify-between items-center pt-3 border-t border-border mt-2">
          <span className="text-[10px] text-muted-foreground">{selectedFields.length} campo(s) seleccionado(s)</span>
          <button onClick={handleSave} disabled={saving || selectedFields.length === 0}
            className="px-4 py-2 bg-primary text-primary-foreground rounded text-sm font-bold hover:bg-primary/90 disabled:opacity-50 flex items-center gap-2"
            data-testid="save-form-fields-btn">
            {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />} Guardar
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
};
