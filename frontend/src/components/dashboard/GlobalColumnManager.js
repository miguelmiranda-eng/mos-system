import React, { useState, useEffect, useRef } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "../ui/dialog";
import { Table2, GripVertical, Eye, EyeOff, Save, Loader2, Undo2, Check, Layout, Columns } from "lucide-react";
import { toast } from "sonner";
import { API, DEFAULT_COLUMNS } from "../../lib/constants";

export const GlobalColumnManager = ({ isOpen, onClose }) => {
  const [columns, setColumns] = useState([]);
  const [hiddenColumns, setHiddenColumns] = useState([]);
  const [columnOrder, setColumnOrder] = useState([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  
  // Drag state
  const dragIdx = useRef(null);
  const [dragOverIdx, setDragOverIdx] = useState(null);

  useEffect(() => {
    if (!isOpen) return;
    setLoading(true);
    
    // Fetch MASTER layout as global default
    fetch(`${API}/config/board-layout/MASTER`, { credentials: 'include' })
      .then(r => r.ok ? r.json() : {})
      .then(data => {
        const order = data.column_order || DEFAULT_COLUMNS.map(c => c.key);
        const hidden = data.hidden_columns || [];
        setColumnOrder(order);
        setHiddenColumns(hidden);
        
        // Merge with all available columns to ensure we have everything
        const allKeys = new Set([...order, ...DEFAULT_COLUMNS.map(c => c.key)]);
        const mergedOrder = Array.from(allKeys);
        setColumnOrder(mergedOrder);
      })
      .catch(() => {
        setColumnOrder(DEFAULT_COLUMNS.map(c => c.key));
      })
      .finally(() => setLoading(false));
  }, [isOpen]);

  const handleSave = async () => {
    setSaving(true);
    try {
      const res = await fetch(`${API}/config/board-layout/MASTER`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          column_order: columnOrder,
          hidden_columns: hiddenColumns
        })
      });
      if (res.ok) {
        toast.success("Configuración de columnas guardada");
        onClose();
      } else {
        toast.error("Error al guardar configuración");
      }
    } catch {
      toast.error("Error de red al guardar");
    } finally {
      setSaving(false);
    }
  };

  const toggleVisibility = (key) => {
    setHiddenColumns(prev => 
      prev.includes(key) ? prev.filter(k => k !== key) : [...prev, key]
    );
  };

  // Drag & Drop
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

    const newOrder = [...columnOrder];
    const [moved] = newOrder.splice(dragIdx.current, 1);
    newOrder.splice(index, 0, moved);

    setColumnOrder(newOrder);
    setDragOverIdx(null);
    dragIdx.current = null;
  };

  const orderedColumns = columnOrder.map(key => {
    const col = DEFAULT_COLUMNS.find(c => c.key === key);
    return col || { key, label: key, type: 'unknown' };
  });

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="max-w-4xl bg-card border-border h-[85vh] flex flex-col p-0 overflow-hidden shadow-2xl">
        <DialogHeader className="p-6 border-b border-border bg-secondary/20">
          <div className="flex items-center justify-between">
            <DialogTitle className="font-barlow text-2xl font-black italic uppercase tracking-tighter flex items-center gap-3">
              <Columns className="w-6 h-6 text-primary" />
              Gestor de Columnas <span className="text-primary font-medium tracking-normal text-sm ml-2">- Vista Previa</span>
            </DialogTitle>
          </div>
          <p className="text-xs text-muted-foreground mt-1 uppercase tracking-widest font-bold opacity-60">
            Arrastra para reordenar y usa el ojo para ocultar/mostrar en el tablero principal.
          </p>
        </DialogHeader>

        <div className="flex-1 flex flex-col overflow-hidden bg-background/50">
          {/* Preview Section */}
          <div className="p-8 border-b border-border bg-gradient-to-b from-secondary/30 to-transparent overflow-x-auto">
            <h3 className="text-[10px] font-black uppercase tracking-[0.2em] text-muted-foreground mb-4">Vista Previa del Tablero</h3>
            <div className="flex gap-1 min-h-[40px] items-center bg-card/50 p-1 rounded-xl border border-border/50 shadow-inner">
              {orderedColumns.map((col, idx) => {
                const isHidden = hiddenColumns.includes(col.key);
                if (isHidden) return null;
                return (
                  <div key={col.key} className="h-8 px-4 bg-secondary flex items-center justify-center rounded-lg border border-border/50 text-[10px] font-black uppercase tracking-tighter whitespace-nowrap animate-in fade-in zoom-in-95 duration-200">
                    {col.label}
                  </div>
                );
              })}
              <div className="h-8 px-4 border border-dashed border-border/50 rounded-lg flex items-center justify-center text-[10px] text-muted-foreground/40 italic">...</div>
            </div>
          </div>

          {/* List Section */}
          <div className="flex-1 overflow-y-auto p-6 space-y-2 custom-scrollbar">
            {loading ? (
              <div className="flex flex-col items-center justify-center h-48 gap-4">
                <Loader2 className="w-8 h-8 animate-spin text-primary" />
                <span className="text-xs font-bold uppercase tracking-widest text-muted-foreground">Cargando definición...</span>
              </div>
            ) : (
              orderedColumns.map((col, idx) => {
                const isHidden = hiddenColumns.includes(col.key);
                const isDragTarget = dragOverIdx === idx;
                
                return (
                  <div
                    key={col.key}
                    draggable
                    onDragStart={(e) => handleDragStart(e, idx)}
                    onDragOver={(e) => handleDragOver(e, idx)}
                    onDrop={(e) => handleDrop(e, idx)}
                    onDragEnd={() => { setDragOverIdx(null); dragIdx.current = null; }}
                    className={`group flex items-center gap-4 p-3 rounded-xl border transition-all duration-200 ${
                      isHidden 
                        ? 'bg-secondary/20 border-border/30 opacity-60 grayscale' 
                        : 'bg-card border-border hover:border-primary/50 hover:shadow-lg'
                    } ${isDragTarget ? 'scale-[1.02] border-primary ring-1 ring-primary/20 bg-primary/5' : ''}`}
                  >
                    <div className="cursor-grab active:cursor-grabbing p-1 hover:bg-secondary rounded transition-colors">
                      <GripVertical className="w-4 h-4 text-muted-foreground/40 group-hover:text-primary" />
                    </div>
                    
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-black uppercase tracking-tight text-foreground">{col.label}</span>
                        <span className="text-[10px] font-mono text-muted-foreground/50 opacity-0 group-hover:opacity-100 transition-opacity">#{col.key}</span>
                      </div>
                      <div className="text-[9px] font-bold text-muted-foreground/60 uppercase tracking-widest">Tipo: {col.type}</div>
                    </div>

                    <button
                      onClick={() => toggleVisibility(col.key)}
                      className={`p-2 rounded-lg transition-all ${
                        isHidden 
                          ? 'text-muted-foreground hover:text-foreground bg-secondary' 
                          : 'text-primary hover:bg-primary/10'
                      }`}
                      title={isHidden ? "Mostrar" : "Ocultar"}
                    >
                      {isHidden ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                    </button>
                  </div>
                );
              })
            )}
          </div>
        </div>

        <div className="p-6 border-t border-border bg-card/95 backdrop-blur-sm flex justify-between items-center">
          <div className="text-[10px] font-bold text-muted-foreground uppercase tracking-widest">
            {hiddenColumns.length} columnas ocultas • {columnOrder.length} total
          </div>
          <div className="flex gap-3">
            <button
              onClick={onClose}
              className="px-6 py-2 rounded-xl text-xs font-black uppercase tracking-widest text-muted-foreground hover:bg-secondary transition-all"
            >
              Cancelar
            </button>
            <button
              onClick={handleSave}
              disabled={saving}
              className="px-8 py-3 bg-primary text-black rounded-xl text-xs font-black uppercase tracking-widest shadow-lg shadow-primary/20 hover:shadow-primary/40 hover:-translate-y-0.5 transition-all flex items-center gap-2"
            >
              {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
              Guardar Layout
            </button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
};
