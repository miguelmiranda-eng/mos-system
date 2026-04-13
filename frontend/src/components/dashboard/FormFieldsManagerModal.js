import { useState, useEffect } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "../ui/dialog";
import { ClipboardList, Check, Loader2, GripVertical, Eye, EyeOff, X } from "lucide-react";
import { useRef } from "react";
import { toast } from "sonner";
import { API, DEFAULT_COLUMNS } from "../../lib/constants";
import { NewOrderForm } from "./NewOrderForm";

const HARDCODED_DEFAULTS = [
  'order_number', 'customer_po', 'style', 'client', 'branding', 
  'priority', 'quantity', 'due_date', 'blank_source', 'blank_status', 
  'production_status', 'notes'
];

export const FormFieldsManagerModal = ({ isOpen, onClose, columns: propsColumns = [] }) => {
  const [selectedFields, setSelectedFields] = useState([]);
  const [hiddenFields, setHiddenFields] = useState([]);
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(false);
  
  // Preview metadata
  const [options, setOptions] = useState({});
  const [groupConfig, setGroupConfig] = useState({});
  const [columns, setColumns] = useState(propsColumns);

  const allColumns = [...DEFAULT_COLUMNS, ...columns.filter(c => c.custom)];

  // Drag state
  const dragIdx = useRef(null);
  const [dragOverIdx, setDragOverIdx] = useState(null);

  useEffect(() => {
    if (!isOpen) return;
    setLoading(true);
    
    // Fetch all needed data for preview and management
    Promise.all([
      fetch(`${API}/config/form-fields`, { credentials: 'include' }).then(r => r.ok ? r.json() : {}),
      fetch(`${API}/config/options`, { credentials: 'include' }).then(r => r.ok ? r.json() : {}),
      fetch(`${API}/config/groups`, { credentials: 'include' }).then(r => r.ok ? r.json() : {}),
      fetch(`${API}/config/columns`, { credentials: 'include' }).then(r => r.ok ? r.json() : { custom_columns: [] })
    ])
    .then(([formData, optionsData, groupsData, colsData]) => {
      setOptions(optionsData);
      setGroupConfig(groupsData);
      setColumns(colsData.custom_columns || []);

      if (formData.fields?.length) {
        const ordered = [...formData.fields];
        // Ensure allColumns is defined correctly here using the newest colsData
        const currentAllCols = [...DEFAULT_COLUMNS, ...(colsData.custom_columns || []).filter(c => c.custom)];
        currentAllCols.forEach(c => {
          if (!ordered.includes(c.key)) ordered.push(c.key);
        });
        setSelectedFields(ordered);
        setHiddenFields(currentAllCols.filter(c => !formData.fields.includes(c.key)).map(c => c.key));
      } else {
        const currentAllCols = [...DEFAULT_COLUMNS, ...(colsData.custom_columns || []).filter(c => c.custom)];
        setSelectedFields(currentAllCols.map(c => c.key));
        setHiddenFields(currentAllCols.filter(c => !HARDCODED_DEFAULTS.includes(c.key)).map(c => c.key));
      }
    })
    .catch(() => {})
    .finally(() => setLoading(false));
  }, [isOpen]);



  const toggle = (key) => {
    setHiddenFields(prev =>
      prev.includes(key) ? prev.filter(k => k !== key) : [...prev, key]
    );
  };

  const handleDragStart = (e, index) => {
    dragIdx.current = index;
    e.dataTransfer.effectAllowed = 'move';
  };

  const handleDragOver = (e, index) => {
    e.preventDefault();
    if (dragIdx.current !== null && dragIdx.current !== index) {
      setDragOverIdx(index);
    }
  };

  const handleDrop = (e, index) => {
    e.preventDefault();
    if (dragIdx.current === null || dragIdx.current === index) return;

    const newOrder = [...selectedFields];
    const [moved] = newOrder.splice(dragIdx.current, 1);
    newOrder.splice(index, 0, moved);

    setSelectedFields(newOrder);
    setDragOverIdx(null);
    dragIdx.current = null;
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      // Visible fields in their current order
      const fieldsToSave = selectedFields.filter(k => !hiddenFields.includes(k));
      const res = await fetch(`${API}/config/form-fields`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
        body: JSON.stringify({ fields: fieldsToSave })
      });
      if (res.ok) { toast.success("Campos del formulario actualizados"); onClose(); }
      else toast.error("Error al guardar");
    } catch { toast.error("Error al guardar"); } finally { setSaving(false); }
  };

  const visibleFields = selectedFields.filter(k => !hiddenFields.includes(k));

  return (
    <Dialog open={isOpen} onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="max-w-[95vw] lg:max-w-7xl bg-card border-border h-[85vh] p-0 flex flex-col shadow-2xl overflow-hidden [&>button:last-child]:hidden shadow-2xl">
        <div className="flex-1 flex overflow-hidden">
          
          {/* Sidebar: Management */}
          <div className="w-full md:w-[350px] flex flex-col border-r border-border/60 bg-secondary/10 shrink-0">
            <DialogHeader className="p-6 pb-4 border-b border-border/40 shrink-0">
              <div className="flex items-center justify-between">
                <DialogTitle className="font-barlow text-xl uppercase tracking-tighter font-black italic text-foreground flex items-center gap-3">
                  <ClipboardList className="w-5 h-5 text-primary" />
                  GESTIÓN DE CAMPOS
                </DialogTitle>
                <X className="w-5 h-5 cursor-pointer text-muted-foreground hover:text-foreground md:hidden" onClick={onClose} />
              </div>
              <p className="text-[10px] text-muted-foreground mt-2 leading-relaxed uppercase tracking-widest font-medium">
                Arrastra para ordenar y usa el ojo para mostrar/ocultar en el formulario.
              </p>
            </DialogHeader>

            <div className="flex-1 overflow-y-auto p-4 space-y-1.5 custom-scrollbar bg-gradient-to-b from-transparent to-secondary/10">
              {loading ? (
                <div className="flex flex-col items-center justify-center py-12 gap-3 opacity-50">
                  <Loader2 className="w-6 h-6 animate-spin text-primary" />
                  <span className="text-[10px] font-black uppercase tracking-widest">Cargando campos...</span>
                </div>
              ) : (
                selectedFields.map((key, idx) => {
                  const col = allColumns.find(c => c.key === key) || { key, label: key, type: '?' };
                  const active = !hiddenFields.includes(key);
                  const isDragTarget = dragOverIdx === idx;
                  
                  // Format label for display if it's a raw key
                  const displayLabel = col.label === key 
                    ? key.split('_').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')
                    : col.label;
                  
                  return (
                    <div 
                      key={key}
                      draggable
                      onDragStart={(e) => handleDragStart(e, idx)}
                      onDragOver={(e) => handleDragOver(e, idx)}
                      onDrop={(e) => handleDrop(e, idx)}
                      onDragEnd={() => { dragIdx.current = null; setDragOverIdx(null); }}
                      className={`flex items-center gap-3 rounded-xl border transition-all duration-300 ${
                        active 
                          ? 'bg-card/80 border-border shadow-sm hover:border-primary/40' 
                          : 'bg-secondary/20 border-border/30 opacity-40 grayscale-[0.5]'
                      } ${isDragTarget ? 'border-primary ring-2 ring-primary/20 bg-primary/5 scale-[1.02] shadow-lg' : ''}`}>
                      
                      <div className="cursor-grab active:cursor-grabbing p-3 text-muted-foreground/30 hover:text-primary transition-colors border-r border-border/40">
                        <GripVertical className="w-4 h-4" />
                      </div>

                      <div className="flex-1 py-3 flex flex-col overflow-hidden">
                        <span className="text-xs font-black text-foreground/90 leading-tight truncate uppercase tracking-tight">{displayLabel}</span>
                        <span className="text-[9px] text-muted-foreground font-black uppercase tracking-[0.15em] mt-1 opacity-70">{col.type}</span>
                      </div>

                      <button onClick={() => toggle(key)}
                        className={`p-3 mr-1 rounded-lg transition-all ${active ? 'text-primary hover:bg-primary/10' : 'text-muted-foreground hover:text-foreground hover:bg-secondary'}`}>
                        {active ? <Eye className="w-4 h-4" /> : <EyeOff className="w-4 h-4" />}
                      </button>
                    </div>
                  );
                })
              )}
            </div>

            <div className="p-4 bg-card border-t border-border/60 shrink-0">
              <div className="flex justify-between items-center mb-4">
                <span className="text-[9px] text-muted-foreground uppercase font-black tracking-widest">{visibleFields.length} campos visibles</span>
              </div>
              <div className="flex gap-2">
                <button onClick={onClose} className="flex-1 py-2 text-[10px] font-black uppercase text-muted-foreground hover:bg-secondary rounded-lg transition-colors border border-border/40">Cancelar</button>
                <button onClick={handleSave} disabled={saving || selectedFields.length === 0}
                  className="flex-[2] py-2.5 bg-primary text-black rounded-lg text-xs font-black uppercase tracking-widest hover:bg-primary/90 disabled:opacity-50 transition-all shadow-lg shadow-primary/20 flex items-center justify-center gap-2">
                  {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
                  Guardar Cambios
                </button>
              </div>
            </div>
          </div>

          {/* Main Area: Real Preview */}
          <div className="flex-1 bg-background flex flex-col overflow-hidden relative group">
            <div className="absolute inset-0 bg-primary/5 blur-[120px] rounded-full translate-x-1/2 pointer-events-none opacity-20" />
            
            <div className="p-6 pb-2 flex items-center justify-between border-b border-border/40 bg-card/50 backdrop-blur-sm z-10 shrink-0">
              <div>
                <h3 className="text-xs font-black uppercase tracking-[0.2em] text-primary">Vista Previa en Vivo</h3>
                <p className="text-[10px] text-muted-foreground uppercase tracking-widest mt-1">Cómo lo verá el usuario al capturar una orden</p>
              </div>
              <button onClick={onClose} className="p-2 rounded-full hover:bg-secondary/80 transition-colors text-muted-foreground hover:text-foreground">
                <X className="h-5 w-5" />
              </button>
            </div>

            <div className="flex-1 overflow-hidden p-6 lg:p-10 relative z-10 flex flex-col items-center">
              <div className="w-full max-w-4xl h-full shadow-[0_30px_100px_rgba(0,0,0,0.5)] rounded-2xl overflow-hidden border border-white/5 border-t-white/10 ring-1 ring-black/50">
                <NewOrderForm
                  isPreview={true}
                  formFieldKeys={visibleFields}
                  options={options}
                  groupConfig={groupConfig}
                  allColumns={allColumns}
                  onClose={() => {}}
                />
              </div>
            </div>
          </div>

        </div>
      </DialogContent>
    </Dialog>
  );
};
