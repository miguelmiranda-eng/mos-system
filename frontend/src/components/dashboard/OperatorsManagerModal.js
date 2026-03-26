import { useState, useEffect } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "../ui/dialog";
import { Users, Plus, Trash2, Pencil, Check, X, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { API } from "../../lib/constants";

export const OperatorsManagerModal = ({ isOpen, onClose }) => {
  const [operators, setOperators] = useState([]);
  const [newName, setNewName] = useState("");
  const [editingId, setEditingId] = useState(null);
  const [editName, setEditName] = useState("");
  const [loading, setLoading] = useState(false);
  const [adding, setAdding] = useState(false);

  const fetchOperators = async () => {
    setLoading(true);
    try {
      const res = await fetch(`${API}/operators`, { credentials: "include" });
      if (res.ok) setOperators(await res.json());
    } catch { /* silent */ } finally { setLoading(false); }
  };

  useEffect(() => { if (isOpen) fetchOperators(); }, [isOpen]);

  const handleAdd = async () => {
    if (!newName.trim()) return;
    setAdding(true);
    try {
      const res = await fetch(`${API}/operators`, {
        method: "POST", headers: { "Content-Type": "application/json" }, credentials: "include",
        body: JSON.stringify({ name: newName.trim() })
      });
      if (res.ok) { toast.success(`Operador "${newName.trim()}" agregado`); setNewName(""); fetchOperators(); }
      else { const err = await res.json(); toast.error(err.detail || "Error"); }
    } catch { toast.error("Error al agregar operador"); } finally { setAdding(false); }
  };

  const handleUpdate = async (id) => {
    if (!editName.trim()) return;
    try {
      const res = await fetch(`${API}/operators/${id}`, {
        method: "PUT", headers: { "Content-Type": "application/json" }, credentials: "include",
        body: JSON.stringify({ name: editName.trim() })
      });
      if (res.ok) { toast.success("Operador actualizado"); setEditingId(null); fetchOperators(); }
      else { const err = await res.json(); toast.error(err.detail || "Error"); }
    } catch { toast.error("Error al actualizar"); }
  };

  const handleToggleActive = async (op) => {
    try {
      const res = await fetch(`${API}/operators/${op.operator_id}`, {
        method: "PUT", headers: { "Content-Type": "application/json" }, credentials: "include",
        body: JSON.stringify({ active: !op.active })
      });
      if (res.ok) fetchOperators();
    } catch { toast.error("Error"); }
  };

  const handleDelete = async (op) => {
    if (!window.confirm(`Eliminar operador "${op.name}"?`)) return;
    try {
      const res = await fetch(`${API}/operators/${op.operator_id}`, { method: "DELETE", credentials: "include" });
      if (res.ok) { toast.success(`Operador "${op.name}" eliminado`); fetchOperators(); }
      else toast.error("Error al eliminar");
    } catch { toast.error("Error al eliminar"); }
  };

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="max-w-lg max-h-[80vh] bg-card border-border overflow-hidden flex flex-col" data-testid="operators-manager-modal">
        <DialogHeader>
          <DialogTitle className="font-barlow text-xl uppercase tracking-wide flex items-center gap-2">
            <Users className="w-5 h-5 text-primary" /> Gestionar Operadores
          </DialogTitle>
        </DialogHeader>
        {/* Add new operator */}
        <div className="flex items-center gap-2 pt-2">
          <input
            type="text" value={newName} onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleAdd()}
            placeholder="Nombre del operador..."
            className="flex-1 h-9 px-3 text-sm bg-secondary border border-border rounded text-foreground"
            data-testid="operator-new-name-input"
          />
          <button onClick={handleAdd} disabled={adding || !newName.trim()}
            className="h-9 px-4 bg-primary text-primary-foreground rounded text-sm font-bold hover:bg-primary/90 disabled:opacity-50 flex items-center gap-1"
            data-testid="operator-add-btn">
            {adding ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />} Agregar
          </button>
        </div>
        {/* Operators list */}
        <div className="flex-1 overflow-y-auto mt-3 space-y-1">
          {loading ? (
            <div className="flex justify-center py-8"><Loader2 className="w-6 h-6 animate-spin" /></div>
          ) : operators.length === 0 ? (
            <p className="text-center text-muted-foreground text-sm py-8">No hay operadores registrados</p>
          ) : operators.map(op => (
            <div key={op.operator_id}
              className={`flex items-center gap-2 px-3 py-2 rounded border transition-all ${op.active ? 'border-border bg-secondary/30' : 'border-border/50 bg-secondary/10 opacity-60'}`}
              data-testid={`operator-item-${op.operator_id}`}>
              {editingId === op.operator_id ? (
                <>
                  <input type="text" value={editName} onChange={(e) => setEditName(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter") handleUpdate(op.operator_id); if (e.key === "Escape") setEditingId(null); }}
                    className="flex-1 h-7 px-2 text-sm bg-secondary border border-primary rounded text-foreground" autoFocus
                    data-testid={`operator-edit-input-${op.operator_id}`} />
                  <button onClick={() => handleUpdate(op.operator_id)} className="p-1 hover:bg-green-500/20 rounded" data-testid={`operator-save-${op.operator_id}`}>
                    <Check className="w-4 h-4 text-green-500" />
                  </button>
                  <button onClick={() => setEditingId(null)} className="p-1 hover:bg-secondary rounded">
                    <X className="w-4 h-4 text-muted-foreground" />
                  </button>
                </>
              ) : (
                <>
                  <span className="flex-1 text-sm text-foreground font-medium">{op.name}</span>
                  <button onClick={() => handleToggleActive(op)}
                    className={`px-2 py-0.5 text-[10px] uppercase font-bold rounded ${op.active ? 'bg-green-500/20 text-green-500' : 'bg-red-500/20 text-red-500'}`}
                    data-testid={`operator-toggle-${op.operator_id}`}>
                    {op.active ? "Activo" : "Inactivo"}
                  </button>
                  <button onClick={() => { setEditingId(op.operator_id); setEditName(op.name); }}
                    className="p-1 hover:bg-primary/20 rounded" data-testid={`operator-edit-${op.operator_id}`}>
                    <Pencil className="w-3.5 h-3.5 text-primary" />
                  </button>
                  <button onClick={() => handleDelete(op)}
                    className="p-1 hover:bg-destructive/20 rounded" data-testid={`operator-delete-${op.operator_id}`}>
                    <Trash2 className="w-3.5 h-3.5 text-destructive" />
                  </button>
                </>
              )}
            </div>
          ))}
        </div>
        <p className="text-[10px] text-muted-foreground pt-2 border-t border-border mt-2">
          Los operadores activos apareceran en el desplegable del formulario "Register Production".
        </p>
      </DialogContent>
    </Dialog>
  );
};
