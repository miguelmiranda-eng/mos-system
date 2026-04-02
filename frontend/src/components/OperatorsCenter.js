import React, { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { useLang } from "../contexts/LanguageContext";
import { API } from "../lib/constants";
import { 
  ArrowLeft, Users, Plus, Loader2, Pencil, Check, X, 
  Trash2, UserCheck, UserMinus, ShieldAlert
} from "lucide-react";
import { toast } from "sonner";

export default function OperatorsCenter() {
  const { t } = useLang();
  const navigate = useNavigate();

  const [operators, setOperators] = useState([]);
  const [loading, setLoading] = useState(true);
  
  // Create state
  const [newName, setNewName] = useState("");
  const [adding, setAdding] = useState(false);

  // Edit state
  const [editingId, setEditingId] = useState(null);
  const [editName, setEditName] = useState("");

  useEffect(() => {
    fetchOperators();
  }, []);

  const fetchOperators = async () => {
    setLoading(true);
    try {
      const res = await fetch(`${API}/operators`, { credentials: "include" });
      if (res.ok) setOperators(await res.json());
    } catch {
      toast.error("Error al cargar operadores");
    } finally {
      setLoading(false);
    }
  };

  const handleAdd = async () => {
    if (!newName.trim()) return;
    setAdding(true);
    try {
      const res = await fetch(`${API}/operators`, {
        method: "POST", headers: { "Content-Type": "application/json" }, credentials: "include",
        body: JSON.stringify({ name: newName.trim() })
      });
      if (res.ok) { 
        toast.success(`Operador "${newName.trim()}" agregado al sistema`); 
        setNewName(""); 
        fetchOperators(); 
      } else { 
        const err = await res.json(); 
        toast.error(err.detail || "Error al crear"); 
      }
    } catch { 
      toast.error("Error al agregar operador"); 
    } finally { 
      setAdding(false); 
    }
  };

  const handleUpdate = async (id) => {
    if (!editName.trim()) return;
    try {
      const res = await fetch(`${API}/operators/${id}`, {
        method: "PUT", headers: { "Content-Type": "application/json" }, credentials: "include",
        body: JSON.stringify({ name: editName.trim() })
      });
      if (res.ok) { 
        toast.success("Nombre del operador actualizado"); 
        setEditingId(null); 
        fetchOperators(); 
      } else { 
        const err = await res.json(); 
        toast.error(err.detail || "Error"); 
      }
    } catch { 
      toast.error("Error al actualizar"); 
    }
  };

  const handleToggleActive = async (op) => {
    try {
      const res = await fetch(`${API}/operators/${op.operator_id}`, {
        method: "PUT", headers: { "Content-Type": "application/json" }, credentials: "include",
        body: JSON.stringify({ active: !op.active })
      });
      if (res.ok) {
        toast.success(`Operador ${!op.active ? 'activado' : 'desactivado'}`);
        fetchOperators();
      }
    } catch { 
      toast.error("Error al cambiar estado"); 
    }
  };

  const handleDelete = async (op) => {
    if (!window.confirm(`¿Estás seguro de eliminar PERMANENTEMENTE al operador "${op.name}"? Los datos históricos de producción que usen este nombre podrían perder su referencia.`)) return;
    try {
      const res = await fetch(`${API}/operators/${op.operator_id}`, { method: "DELETE", credentials: "include" });
      if (res.ok) { 
        toast.success(`Operador "${op.name}" eliminado`); 
        fetchOperators(); 
      } else {
        toast.error("Error al eliminar");
      }
    } catch { 
      toast.error("Error al eliminar"); 
    }
  };

  const activeOperators = operators.filter(o => o.active).length;
  const inactiveOperators = operators.length - activeOperators;

  return (
    <div className="min-h-screen bg-background text-foreground font-barlow flex flex-col relative overflow-hidden">
      {/* Background Decor */}
      <div className="absolute top-0 right-0 w-1/2 h-1/2 bg-blue-500/5 blur-[120px] rounded-full -translate-y-1/2 translate-x-1/2 pointer-events-none" />
      <div className="absolute bottom-0 left-0 w-1/3 h-1/3 bg-cyan-500/5 blur-[100px] rounded-full translate-y-1/2 -translate-x-1/3 pointer-events-none" />

      {/* Top Header */}
      <header className="sticky top-0 z-40 bg-background/80 backdrop-blur-xl border-b border-border h-16 flex items-center justify-between px-6 shadow-sm flex-shrink-0">
        <div className="flex items-center gap-4">
          <button
            onClick={() => navigate("/home")}
            className="w-10 h-10 flex flex-shrink-0 items-center justify-center rounded-xl bg-secondary/50 hover:bg-secondary border border-white/5 transition-all text-muted-foreground hover:text-foreground hover:shadow-lg hover:-translate-x-0.5"
            title="Volver a MOS Home"
          >
            <ArrowLeft className="w-5 h-5" />
          </button>
          <div>
            <h1 className="text-xl font-black uppercase tracking-widest text-foreground flex items-center gap-2">
              <Users className="w-5 h-5 text-blue-500" />
              CENTRO DE OPERADORES
            </h1>
            <p className="text-xs text-muted-foreground font-mono leading-none mt-1">
              Catálogo General de Recursos Humanos para Máquinas
            </p>
          </div>
        </div>

        <div className="flex items-center gap-3">
           <div className="hidden sm:flex items-center gap-2 px-3 py-1 bg-secondary rounded-lg border border-border mr-2">
             <div className="flex items-center gap-1.5"><div className="w-2 h-2 rounded-full bg-green-500 shadow-[0_0_8px_rgba(34,197,94,0.6)]"></div> <span className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">{activeOperators} Activos</span></div>
             <div className="w-px h-3 bg-border mx-1"></div>
             <div className="flex items-center gap-1.5"><div className="w-2 h-2 rounded-full bg-red-500/50"></div> <span className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">{inactiveOperators} Inactivos</span></div>
           </div>
        </div>
      </header>

      {/* Main Layout Area */}
      <div className="flex-1 flex overflow-hidden max-w-[1200px] w-full mx-auto p-4 md:p-8 gap-8 flex-col lg:flex-row">
        
        {/* Left Column: List */}
        <div className="flex-1 flex flex-col bg-card/20 border border-white/5 rounded-2xl backdrop-blur-md overflow-hidden relative shadow-sm">
          <div className="absolute top-0 right-0 w-32 h-32 bg-blue-500/10 blur-3xl rounded-full pointer-events-none" />
          
          <div className="p-5 border-b border-white/5 bg-secondary/30 relative z-10 flex items-center justify-between">
            <h3 className="text-sm font-black uppercase tracking-widest text-foreground">Directorio de Operadores</h3>
            <span className="text-xs font-mono text-muted-foreground bg-background px-2 py-0.5 rounded border border-border">Total: {operators.length}</span>
          </div>

          <div className="flex-1 overflow-y-auto p-5 relative z-10 space-y-3">
            {loading ? (
              <div className="flex justify-center p-10"><Loader2 className="w-8 h-8 animate-spin text-blue-500" /></div>
            ) : operators.length === 0 ? (
              <div className="text-center py-16 border border-dashed border-border rounded-xl bg-secondary/10">
                <p className="text-muted-foreground font-mono">No hay operadores registrados</p>
                <p className="text-xs text-muted-foreground/60 mt-2">Crea el primer operador usando el panel de la derecha.</p>
              </div>
            ) : (
              operators.map(op => {
                const isEditing = editingId === op.operator_id;
                return (
                  <div 
                    key={op.operator_id}
                    className={`flex items-center gap-4 p-3 rounded-xl border transition-all ${
                      isEditing 
                         ? "bg-secondary/80 border-blue-500/40 shadow-inner" 
                         : op.active 
                           ? "bg-card/60 border-border hover:border-muted-foreground/30 hover:shadow-md" 
                           : "bg-background/40 border-border/40 opacity-70 hover:opacity-100"
                    }`}
                  >
                    {/* Icon Status */}
                    <div className={`w-10 h-10 rounded-lg flex items-center justify-center flex-shrink-0 ${op.active ? 'bg-gradient-to-br from-green-500/20 to-blue-500/20 text-green-500 border border-green-500/20' : 'bg-secondary text-muted-foreground border border-border'}`}>
                      {op.active ? <UserCheck className="w-5 h-5" /> : <UserMinus className="w-5 h-5 opacity-50" />}
                    </div>

                    {/* Editor vs View */}
                    <div className="flex-1 min-w-0">
                      {isEditing ? (
                        <div className="flex items-center gap-2">
                          <input 
                            type="text" value={editName} onChange={(e) => setEditName(e.target.value)}
                            onKeyDown={(e) => { if (e.key === "Enter") handleUpdate(op.operator_id); if (e.key === "Escape") setEditingId(null); }}
                            className="flex-1 bg-background border border-border rounded px-3 py-1.5 text-sm font-bold text-foreground focus:ring-1 focus:ring-blue-500 outline-none" 
                            autoFocus 
                          />
                          <button onClick={() => handleUpdate(op.operator_id)} className="p-1.5 hover:bg-green-500/20 rounded-md transition-colors" title="Guardar">
                            <Check className="w-4 h-4 text-green-500" />
                          </button>
                          <button onClick={() => setEditingId(null)} className="p-1.5 hover:bg-secondary rounded-md" title="Cancelar">
                            <X className="w-4 h-4 text-muted-foreground" />
                          </button>
                        </div>
                      ) : (
                        <div className="flex items-center gap-3">
                           <span className={`text-base font-black uppercase tracking-wide truncate ${!op.active && 'line-through decoration-muted-foreground/40'}`}>{op.name}</span>
                        </div>
                      )}
                    </div>

                    {/* Actions */}
                    {!isEditing && (
                      <div className="flex items-center gap-1 flex-shrink-0">
                         <button 
                          onClick={() => handleToggleActive(op)}
                          className={`px-3 py-1 text-[10px] uppercase font-black tracking-widest rounded-md border transition-all ${
                            op.active 
                              ? 'bg-green-500/10 text-green-600 border-green-500/30 hover:bg-green-500/20' 
                              : 'bg-red-500/10 text-red-500 border-red-500/20 hover:bg-red-500/20'
                          }`}
                        >
                          {op.active ? "Activo" : "Inactivo"}
                        </button>

                        <div className="w-px h-5 bg-border mx-1"></div>

                        <button 
                          onClick={() => { setEditingId(op.operator_id); setEditName(op.name); }}
                          className="w-8 h-8 flex items-center justify-center rounded-md hover:bg-blue-500/10 hover:text-blue-500 transition-colors text-muted-foreground"
                          title="Editar nombre"
                        >
                          <Pencil className="w-4 h-4" />
                        </button>
                        <button 
                          onClick={() => handleDelete(op)}
                          className="w-8 h-8 flex items-center justify-center rounded-md hover:bg-red-500/10 hover:text-red-500 transition-colors text-muted-foreground"
                          title="Eliminar de la base de datos"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                    )}
                  </div>
                );
              })
            )}
          </div>
        </div>

        {/* Right Column: Add Form & Context Info */}
        <div className="w-full lg:w-[350px] flex flex-col gap-6 overflow-y-auto pb-6 pr-2">
          {/* Add Form */}
          <div className="bg-card/40 flex-shrink-0 backdrop-blur-md rounded-2xl p-6 border border-blue-500/20 shadow-[0_4px_30px_rgba(0,0,0,0.1)] relative overflow-hidden group">
            <h4 className="text-xs font-black tracking-widest text-blue-500 uppercase mb-5 flex items-center gap-2">
              <Plus className="w-4 h-4" /> Registrar Nuevo
            </h4>
            
            <div className="space-y-4 relative z-10">
              <div>
                <label className="text-[10px] text-muted-foreground uppercase font-black block mb-2 tracking-widest">Nombre del Operador</label>
                <input 
                  type="text" 
                  value={newName} 
                  onChange={(e) => setNewName(e.target.value)} 
                  onKeyDown={(e) => { if (e.key === "Enter") handleAdd(); }} 
                  placeholder="Ej. Juan Pérez" 
                  className="w-full bg-background border border-border rounded-lg px-4 py-3 text-sm font-bold text-foreground focus:ring-1 focus:ring-blue-500 outline-none tracking-wide shadow-inner" 
                />
              </div>
              
              <button 
                onClick={handleAdd} 
                disabled={adding || !newName.trim()}
                className="w-full py-3 bg-gradient-to-r from-blue-600 to-cyan-600 text-white rounded-lg font-black tracking-widest text-xs uppercase transition-all hover:-translate-y-0.5 hover:shadow-[0_0_15px_rgba(59,130,246,0.5)] disabled:opacity-50 disabled:hover:translate-y-0 disabled:hover:shadow-none flex items-center justify-center gap-2"
              >
                {adding ? <Loader2 className="w-4 h-4 animate-spin" /> : "Registrar en el sistema"}
              </button>
            </div>
          </div>

          {/* Context Info */}
          <div className="bg-secondary/40 flex-shrink-0 rounded-2xl p-6 border border-white/5 space-y-4">
            <h3 className="text-xs font-black text-muted-foreground tracking-widest uppercase flex items-center gap-2">
               <ShieldAlert className="w-4 h-4 text-orange-500" /> Información Importante
            </h3>
            <div className="text-xs text-muted-foreground leading-relaxed space-y-4">
              <p>➤ <strong>Disponibilidad:</strong> Los operadores marcados como <span className="text-green-500 font-bold uppercase">Activos</span> son los únicos que aparecerán en la lista desplegable de las tarjetas de las Máquinas cuando los colaboradores intenten registrar progreso.</p>
              <p>➤ <strong>Rotación / Bajas:</strong> Si un operador se enferma o deja la empresa temporalmente, <span className="text-red-500 font-bold uppercase">desactívalo</span> en lugar de borrarlo. Así sus registros históricos de producción se mantienen perfectos.</p>
              <p>➤ <strong>Eliminación Definitiva:</strong> Solo uses el bote de basura 🗑️ si el operador fue creado por error y aún no tiene registros de impresión; de lo contrario, la base de datos podría marcar inconsistencias en el historial de las órdenes.</p>
            </div>
          </div>

        </div>

      </div>
    </div>
  );
}
