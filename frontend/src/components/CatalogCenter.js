import React, { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { useLang } from "../contexts/LanguageContext";
import { API, getStatusColor } from "../lib/constants";
import { 
  ArrowLeft, Settings, Plus, Loader2, Pencil, Check, X, 
  Tags, Layers, Box, Truck, Palette, LayoutDashboard,
  FolderPlus, Grab, MousePointer2, Trash2, FolderEdit
} from "lucide-react";
import { toast } from "sonner";

export default function CatalogCenter() {
  const { t } = useLang();
  const navigate = useNavigate();

  const [options, setOptions] = useState({});
  const [selectedCatalog, setSelectedCatalog] = useState("clients");
  const [values, setValues] = useState([]);
  const [newValue, setNewValue] = useState("");
  const [newColor, setNewColor] = useState("#3d85c6");
  const [customColors, setCustomColors] = useState({});
  const [descriptions, setDescriptions] = useState({});
  const [groups, setGroups] = useState({}); // { label: groupName }
  const [groupColors, setGroupColors] = useState({}); // { groupName: color }
  const [groupDraft, setGroupDraft] = useState("");
  const [groupColorDraft, setGroupColorDraft] = useState("#666666");
  const [editingColor, setEditingColor] = useState(null);
  const [editingLabel, setEditingLabel] = useState(null);
  const [nameDraft, setNameDraft] = useState("");
  const [descDraft, setDescDraft] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  // New States for Folder/Group Management
  const [selectedLabels, setSelectedLabels] = useState([]);
  const [isDragging, setIsDragging] = useState(null); // labelName
  const [dragOverGroup, setDragOverGroup] = useState(null); // groupName
  const [showFolderCreator, setShowFolderCreator] = useState(false);
  const [newFolderName, setNewFolderName] = useState("");
  const [newFolderColor, setNewFolderColor] = useState("#666666");

  // Grouped catalogs for the sidebar
  const CATALOG_GROUPS = [
    {
      title: "Ventas y Clientes",
      icon: <Tags className="w-4 h-4" />,
      items: [
        { id: "clients", label: "Clientes", desc: "Base de la cartera de clientes" },
        { id: "brandings", label: "Brandings", desc: "Marcas / Submarcas de clientes" },
        { id: "priorities", label: "Prioridades (Flags)", desc: "Indicadores visuales de urgencia" }
      ]
    },
    {
      title: "Inventario y Material",
      icon: <Box className="w-4 h-4" />,
      items: [
        { id: "blank_sources", label: "Fuentes de Blanks", desc: "Proveedores de ropa (Gildan, etc)" },
        { id: "blank_statuses", label: "Estados de Blanks", desc: "Control del almacén temporal" },
        { id: "trim_boxes", label: "Cajas de Trims", desc: "Ubicaciones para accesorios" },
        { id: "trim_statuses", label: "Estados de Trims", desc: "Control de estatus de accesorios" }
      ]
    },
    {
      title: "Producción y Arte",
      icon: <Layers className="w-4 h-4" />,
      items: [
        { id: "production_statuses", label: "Estados de Producción", desc: "Estatus de cada prenda (Impreso, etc)" },
        { id: "artwork_statuses", label: "Estados de Arte", desc: "Aprobaciones y pre-prensa" },
        { id: "samples", label: "Muestras de Arte", desc: "Aprobaciones de clientes" },
        { id: "betty_columns", label: "Betty Columns", desc: "Soporte para integraciones externas" }
      ]
    },
    {
      title: "Logística",
      icon: <Truck className="w-4 h-4" />,
      items: [
        { id: "shippings", label: "Métodos de Envío", desc: "UPS, Local Pickup, FedEx, etc" }
      ]
    }
  ];

  const PRESET_COLORS = [
    "#990000","#cf0000","#ff0000","#cc0000","#b44253","#e69138",
    "#f1c232","#38761d","#20124d","#674ea7","#3d85c6","#6fa8dc",
    "#b4a7d6","#e066cc","#999999","#16c79a","#25a18e","#004e64",
    "#1a1a2e","#000000"
  ];

  useEffect(() => {
    fetchData();
  }, []);

  useEffect(() => {
    if (options[selectedCatalog]) {
      setValues([...options[selectedCatalog]]);
      setEditingColor(null);
      setEditingLabel(null);
    } else {
      setValues([]);
    }
  }, [selectedCatalog, options]);

  const fetchData = async () => {
    setLoading(true);
    try {
      const [optRes, colRes, descRes, groupRes] = await Promise.all([
        fetch(`${API}/config/options`, { credentials: "include" }),
        fetch(`${API}/config/colors`, { credentials: "include" }),
        fetch(`${API}/config/descriptions`, { credentials: "include" }),
        fetch(`${API}/config/groups`, { credentials: "include" })
      ]);
      if (optRes.ok) setOptions(await optRes.json());
      if (colRes.ok) setCustomColors(await colRes.json());
      if (descRes.ok) setDescriptions(await descRes.json());
      if (groupRes.ok) {
        const gData = await groupRes.json();
        setGroups(gData.label_to_group || {});
        setGroupColors(gData.group_colors || {});
      }
    } catch {
      toast.error("Error cargando base de datos");
    } finally {
      setLoading(false);
    }
  };

  const isLightColor = (hex) => {
    const r = parseInt(hex.slice(1, 3), 16),
          g = parseInt(hex.slice(3, 5), 16),
          b = parseInt(hex.slice(5, 7), 16);
    return (r * 299 + g * 587 + b * 114) / 1000 > 128;
  };

  const getColor = (val) => customColors[val] || getStatusColor(val) || { bg: "#666", text: "#fff" };

  const handleSetColor = (val, color) => {
    setCustomColors(prev => ({
      ...prev,
      [val]: { bg: color, text: isLightColor(color) ? "#000000" : "#FFFFFF" }
    }));
  };

  const saveLabel = (oldVal) => {
    const newName = nameDraft.trim();
    const newDesc = descDraft.trim();
    if (!newName) return;
    
    if (newName !== oldVal) {
      if (values.includes(newName)) return toast.error("La etiqueta ya existe");
      // Rename: update values, migrate color, description, and group
      setValues(prev => prev.map(v => v === oldVal ? newName : v));
      setCustomColors(prev => {
        const next = { ...prev };
        if (next[oldVal]) { next[newName] = next[oldVal]; delete next[oldVal]; }
        return next;
      });
      setDescriptions(prev => {
        const next = { ...prev };
        delete next[oldVal];
        if (newDesc) next[newName] = newDesc; 
        return next;
      });
      setGroups(prev => {
        const next = { ...prev };
        const g = next[oldVal];
        delete next[oldVal];
        if (g || groupDraft.trim()) next[newName] = groupDraft.trim() || g;
        return next;
      });
    } else {
      setDescriptions(prev => {
        const next = { ...prev };
        if (newDesc) next[oldVal] = newDesc;
        else delete next[oldVal];
        return next;
      });
      setGroups(prev => {
        const next = { ...prev };
        if (groupDraft.trim()) next[oldVal] = groupDraft.trim();
        else delete next[oldVal];
        return next;
      });
    }

    if (groupDraft.trim() && groupColorDraft) {
      setGroupColors(prev => ({ ...prev, [groupDraft.trim()]: groupColorDraft }));
    }

    setEditingLabel(null);
    setNameDraft("");
    setDescDraft("");
    setGroupDraft("");
  };
  
  const moveLabelsToGroup = (labelNames, targetGroup) => {
    if (!labelNames.length) return;
    const isRemove = targetGroup === "SIN GRUPO" || !targetGroup;
    
    setGroups(prev => {
      const next = { ...prev };
      labelNames.forEach(name => {
        if (isRemove) delete next[name];
        else next[name] = targetGroup;
      });
      return next;
    });
    
    toast.success(`${labelNames.length > 1 ? "Etiquetas movidas" : "Etiqueta movida"} a ${targetGroup || "SIN GRUPO"}`);
    setSelectedLabels([]);
  };

  const createEmptyFolder = () => {
    const name = newFolderName.trim().toUpperCase();
    if (!name) return;
    if (groupColors[name]) return toast.error("La carpeta ya existe");
    
    setGroupColors(prev => ({ ...prev, [name]: newFolderColor }));
    setNewFolderName("");
    setShowFolderCreator(false);
    toast.success(`Carpeta "${name}" creada`);
  };

  const handleSaveToDatabase = async () => {
    setSaving(true);
    try {
      const res = await fetch(`${API}/config/options`, {
        method: "PUT", headers: { "Content-Type": "application/json" },
        credentials: "include", body: JSON.stringify({ option_key: selectedCatalog, values })
      });
      await fetch(`${API}/config/colors`, {
        method: "PUT", headers: { "Content-Type": "application/json" },
        credentials: "include", body: JSON.stringify(customColors)
      });
      await fetch(`${API}/config/descriptions`, {
        method: "PUT", headers: { "Content-Type": "application/json" },
        credentials: "include", body: JSON.stringify(descriptions)
      });
      await fetch(`${API}/config/groups`, {
        method: "PUT", headers: { "Content-Type": "application/json" },
        credentials: "include", body: JSON.stringify({ label_to_group: groups, group_colors: groupColors })
      });

      if (res.ok) {
        toast.success("Catálogo guardado exitosamente");
        // Actualizamos nuestro state base de options con el valor modificado
        setOptions(prev => ({ ...prev, [selectedCatalog]: values }));
      } else {
        throw new Error();
      }
    } catch {
      toast.error("Error al guardar en la base de datos");
    } finally {
      setSaving(false);
    }
  };

  const currentCatalogObj = CATALOG_GROUPS.flatMap(g => g.items).find(i => i.id === selectedCatalog);

  return (
    <div className="min-h-screen bg-background text-foreground font-barlow flex flex-col relative overflow-hidden">
      {/* Background Decor */}
      <div className="absolute top-0 right-0 w-1/2 h-1/2 bg-primary/5 blur-[120px] rounded-full -translate-y-1/2 translate-x-1/2 pointer-events-none" />
      <div className="absolute bottom-0 left-0 w-1/3 h-1/3 bg-orange-500/5 blur-[100px] rounded-full translate-y-1/2 -translate-x-1/3 pointer-events-none" />

      {/* Top Header */}
      <header className="sticky top-0 z-40 bg-background/80 backdrop-blur-xl border-b border-border h-16 flex items-center justify-between px-6 shadow-sm">
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
              <Layers className="w-5 h-5 text-primary" />
              CENTRO DE CATÁLOGOS
            </h1>
            <p className="text-xs text-muted-foreground font-mono leading-none mt-1">
              Gestión Maestra de Campos Desplegables y Opciones de Estado
            </p>
          </div>
        </div>

        <button
          onClick={handleSaveToDatabase}
          disabled={saving || loading}
          className="px-6 py-2 bg-gradient-to-r from-primary to-orange-500 hover:from-primary/90 hover:to-orange-500/90 text-white rounded-lg font-black tracking-widest text-sm transition-all shadow-[0_4px_20px_rgba(255,193,7,0.3)] hover:shadow-[0_4px_25px_rgba(255,193,7,0.5)] flex items-center gap-2 disabled:opacity-50"
        >
          {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Settings className="w-4 h-4" />}
          GUARDAR CATÁLOGO
        </button>
      </header>

      {/* Main Layout Area */}
      <div className="flex-1 flex overflow-hidden max-w-[1600px] w-full mx-auto">
        {/* Sidebar (List of Catalogs) */}
        <div className="w-72 bg-card/30 border-r border-border backdrop-blur-sm overflow-y-auto hidden md:block">
          {loading ? (
            <div className="flex justify-center p-10"><Loader2 className="w-6 h-6 animate-spin text-primary" /></div>
          ) : (
            <div className="p-4 space-y-6">
              {CATALOG_GROUPS.map((group, idx) => (
                <div key={idx} className="space-y-2">
                  <div className="flex items-center gap-2 px-2 text-xs font-bold uppercase tracking-wider text-muted-foreground/80 mb-3">
                    {group.icon}
                    {group.title}
                  </div>
                  {group.items.map((item) => (
                    <button
                      key={item.id}
                      onClick={() => setSelectedCatalog(item.id)}
                      className={`w-full flex flex-col text-left px-3 py-2.5 rounded-lg border transition-all duration-200 group ${
                        selectedCatalog === item.id 
                          ? "bg-primary/10 border-primary/40 text-primary shadow-sm" 
                          : "bg-transparent border-transparent text-foreground hover:bg-secondary hover:border-border/50"
                      }`}
                    >
                      <span className="font-bold text-sm tracking-wide uppercase">{item.label}</span>
                      <span className={`text-[10px] leading-tight mt-1 line-clamp-1 font-mono ${selectedCatalog === item.id ? "text-primary/70" : "text-muted-foreground"}`}>
                        {item.desc}
                      </span>
                    </button>
                  ))}
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Right Editor Pane */}
        <div className="flex-1 flex flex-col h-full bg-background/50 relative">
          {!loading && currentCatalogObj ? (
            <>
              {/* Header Context for selected catalog */}
              <div className="p-6 md:p-10 border-b border-white/5 bg-gradient-to-b from-card/30 to-transparent flex-shrink-0">
                <div className="inline-flex items-center gap-2 px-3 py-1 bg-primary/10 border border-primary/20 rounded-full text-xs font-black uppercase tracking-widest text-primary mb-4">
                  <LayoutDashboard className="w-3.5 h-3.5" /> Estructura del Dropdown
                </div>
                <h2 className="text-3xl font-black uppercase tracking-tighter text-foreground mb-2">
                  {currentCatalogObj.label}
                </h2>
                <p className="text-muted-foreground font-medium max-w-2xl">
                  {currentCatalogObj.desc}. Aquí defines las opciones que aparecerán en los menús desplegables 
                  correspondientes dentro de las tarjetas de las órdenes en todo el sistema.
                </p>
              </div>

              {/* Editing Area */}
              <div className="flex-1 overflow-y-auto p-6 md:p-10 flex gap-10">
                {/* List of current options */}
                <div className="flex-1 max-w-2xl space-y-3">
                  <div className="flex items-center justify-between mb-4 border-b border-border pb-2">
                    <h3 className="text-sm font-bold uppercase tracking-widest text-muted-foreground">
                      ETIQUETAS ACTUALES ({values.length})
                    </h3>
                    <div className="flex items-center gap-2">
                      {selectedLabels.length > 0 && (
                        <div className="px-3 py-1 bg-primary/20 text-primary text-[10px] font-black rounded-full animate-pulse">
                          {selectedLabels.length} SELECCIONADAS
                        </div>
                      )}
                      <button 
                        onClick={() => setShowFolderCreator(!showFolderCreator)}
                        className={`flex items-center gap-2 px-3 py-1 rounded-md text-[10px] font-black uppercase tracking-widest transition-all ${
                          showFolderCreator ? "bg-destructive/10 text-destructive hover:bg-destructive/20" : "bg-primary/10 text-primary hover:bg-primary/20"
                        }`}
                      >
                        {showFolderCreator ? <X className="w-3.5 h-3.5" /> : <FolderPlus className="w-3.5 h-3.5" />}
                        {showFolderCreator ? "Cerrar" : "Nueva Carpeta"}
                      </button>
                    </div>
                  </div>

                  {/* Folder Creator Bar */}
                  {showFolderCreator && (
                    <div className="mb-6 p-4 bg-secondary/30 rounded-xl border border-primary/20 flex flex-wrap gap-4 items-end animate-in slide-in-from-top-2 duration-300">
                      <div className="flex-1 min-w-[200px]">
                        <label className="text-[10px] text-muted-foreground uppercase font-black block mb-1">Nombre Carpeta Deseada</label>
                        <input 
                          type="text" value={newFolderName} onChange={(e) => setNewFolderName(e.target.value)}
                          placeholder="NOMBRE DE LA CARPETA..."
                          className="w-full bg-background border border-border rounded-lg px-3 py-2 text-sm text-foreground focus:ring-1 focus:ring-primary outline-none uppercase"
                          autoFocus
                          onKeyDown={(e) => { if (e.key === "Enter") createEmptyFolder(); }}
                        />
                      </div>
                      <div>
                        <label className="text-[10px] text-muted-foreground uppercase font-black block mb-1">Color</label>
                        <div className="flex items-center gap-2">
                          <div className="w-9 h-9 rounded border border-border overflow-hidden relative">
                            <input 
                              type="color" value={newFolderColor} onChange={(e) => setNewFolderColor(e.target.value)}
                              className="absolute inset-[-10px] w-16 h-16 cursor-pointer"
                            />
                          </div>
                          <button 
                            onClick={createEmptyFolder}
                            disabled={!newFolderName.trim()}
                            className="px-4 py-2 bg-primary text-primary-foreground rounded-lg text-xs font-black uppercase tracking-widest disabled:opacity-50"
                          >
                            Crear
                          </button>
                        </div>
                      </div>
                    </div>
                  )}

                  {values.length === 0 ? (
                    <div className="text-center py-10 border border-dashed border-border rounded-xl bg-secondary/10">
                      <p className="text-muted-foreground font-mono">No hay etiquetas creadas en este catálogo todavía.</p>
                    </div>
                  ) : (
                    <div className="space-y-8 pb-32">
                      {(() => {
                        const grouped = {};
                        // Ensure all groups from groupColors are present, even if empty
                        Object.keys(groupColors).forEach(gn => { grouped[gn] = []; });
                        
                        values.forEach(v => {
                          const g = groups[v] || "SIN GRUPO";
                          if (!grouped[g]) grouped[g] = [];
                          grouped[g].push(v);
                        });

                        const groupNames = Object.keys(grouped).sort((a, b) => {
                          if (a === "SIN GRUPO") return 1;
                          if (b === "SIN GRUPO") return -1;
                          return a.localeCompare(b);
                        });
                        
                        return groupNames.map(gn => (
                          <div 
                            key={gn} 
                            className={`space-y-4 rounded-2xl p-2 transition-all duration-300 ${
                              dragOverGroup === gn ? "bg-primary/5 ring-2 ring-primary/20 scale-[1.02]" : ""
                            }`}
                            onDragOver={(e) => { e.preventDefault(); setDragOverGroup(gn); }}
                            onDragLeave={() => setDragOverGroup(null)}
                            onDrop={(e) => {
                              e.preventDefault();
                              const label = e.dataTransfer.getData("label");
                              if (label) moveLabelsToGroup([label], gn === "SIN GRUPO" ? null : gn);
                              setDragOverGroup(null);
                            }}
                          >
                            <div className="flex items-center gap-3 px-1 group/folder">
                              <div className="w-1.5 h-4 rounded-full" style={{ backgroundColor: groupColors[gn] || "#666" }} />
                              <span className="text-xs font-black uppercase tracking-[0.2em] text-foreground/70">{gn}</span>
                              <span className="text-[10px] text-muted-foreground font-mono bg-secondary px-2 py-0.5 rounded-full">{grouped[gn].length}</span>
                              <div className="flex-1 h-px bg-border/30" />
                              <button 
                                onClick={() => {
                                  if (gn === "SIN GRUPO") return;
                                  if (window.confirm(`¿Eliminar carpeta "${gn}"? Las etiquetas volverán a SIN GRUPO.`)) {
                                    const labelsInGroup = grouped[gn];
                                    moveLabelsToGroup(labelsInGroup, null);
                                    setGroupColors(prev => { const n = {...prev}; delete n[gn]; return n; });
                                  }
                                }}
                                className={`opacity-0 group-hover/folder:opacity-100 p-1 text-muted-foreground hover:text-destructive transition-all ${gn === "SIN GRUPO" ? "hidden" : ""}`}
                              >
                                <Trash2 className="w-3.5 h-3.5" />
                              </button>
                            </div>
                            
                            <div className="space-y-2 min-h-[40px] border-2 border-transparent border-dashed rounded-xl flex flex-col">
                              {grouped[gn].length === 0 && (
                                <div className="flex items-center justify-center py-4 text-[10px] text-muted-foreground/50 border border-dashed border-border/50 rounded-xl uppercase tracking-widest font-black">
                                  Carpeta Vacía - Arrastra aquí para organizar
                                </div>
                              )}
                              {grouped[gn].map((val) => {
                                const color = getColor(val);
                                const desc = descriptions[val] || "";
                                const isEditingLabel = editingLabel === val;
                                const isEditingColor = editingColor === val;
                                const isSelected = selectedLabels.includes(val);

                                return (
                                  <div 
                                    key={val} 
                                    draggable={!isEditingLabel && !isEditingColor}
                                    onDragStart={(e) => {
                                      e.dataTransfer.setData("label", val);
                                      setIsDragging(val);
                                    }}
                                    onDragEnd={() => setIsDragging(null)}
                                    className={`flex items-start gap-4 p-3 rounded-xl border transition-all group relative overflow-hidden ${
                                      isEditingLabel || isEditingColor 
                                        ? "bg-secondary/50 border-primary/30" 
                                        : isDragging === val 
                                          ? "opacity-40 scale-95 border-primary/50"
                                          : isSelected
                                            ? "bg-primary/5 border-primary/40 ring-1 ring-primary/20"
                                            : "bg-card/40 border-border hover:border-muted-foreground/30 hover:shadow-md"
                                    }`}
                                  >
                                    {/* Selection Checkbox */}
                                    <div className="pt-3.5">
                                      <div 
                                        onClick={() => setSelectedLabels(prev => prev.includes(val) ? prev.filter(v => v !== val) : [...prev, val])}
                                        className={`w-5 h-5 rounded border-2 flex items-center justify-center cursor-pointer transition-all ${
                                          isSelected ? "bg-primary border-primary" : "border-border hover:border-primary/50"
                                        }`}
                                      >
                                        {isSelected && <Check className="w-3 h-3 text-primary-foreground stroke-[4px]" />}
                                      </div>
                                    </div>

                                    {/* Color Block Swatch Trigger */}
                                    <button 
                                      onClick={() => { setEditingColor(isEditingColor ? null : val); setEditingLabel(null); }}
                                      className={`w-12 h-12 rounded-lg flex-shrink-0 flex items-center justify-center border-2 shadow-inner transition-transform hover:scale-105 cursor-pointer ${
                                        isEditingColor ? "border-primary" : "border-white/10"
                                      }`}
                                      style={{ backgroundColor: color.bg }}
                                      title="Cambiar Color"
                                    >
                                      <Palette className="w-5 h-5 opacity-40 mix-blend-difference" style={{ color: "#fff" }} />
                                    </button>
                                    
                                    {/* Handle Icon for DnD Hint */}
                                    <div className="absolute top-1/2 -translate-y-1/2 left-1 opacity-0 group-hover:opacity-20 cursor-grab active:cursor-grabbing p-1">
                                      <Grab className="w-4 h-4" />
                                    </div>

                                    {/* Center Info OR Editing Form */}
                                    <div className="flex-1 min-w-0 pt-0.5">
                                      {isEditingLabel ? (
                                        <div className="space-y-3 animate-in fade-in duration-200">
                                          <div>
                                            <label className="text-[10px] text-muted-foreground uppercase font-black tracking-widest mb-1 block">Nombre de Etiqueta</label>
                                            <input 
                                              type="text" value={nameDraft} onChange={(e) => setNameDraft(e.target.value)}
                                              className="w-full bg-background border border-border rounded-lg px-3 py-2 text-sm font-medium text-foreground focus:ring-1 focus:ring-primary outline-none" 
                                              autoFocus
                                              onKeyDown={(e) => { if (e.key === "Enter") saveLabel(val); if (e.key === "Escape") setEditingLabel(null); }}
                                            />
                                          </div>
                                          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                            <div>
                                              <label className="text-[10px] text-muted-foreground uppercase font-black tracking-widest mb-1 block">Carpeta / Grupo</label>
                                              <input 
                                                type="text" value={groupDraft} onChange={(e) => setGroupDraft(e.target.value)}
                                                placeholder="Ej: NECK LABELS..."
                                                className="w-full bg-background border border-border rounded-lg px-3 py-2 text-sm text-foreground focus:ring-1 focus:ring-primary outline-none uppercase" 
                                                onKeyDown={(e) => { if (e.key === "Enter") saveLabel(val); if (e.key === "Escape") setEditingLabel(null); }}
                                              />
                                            </div>
                                            <div>
                                              <label className="text-[10px] text-muted-foreground uppercase font-black tracking-widest mb-1 block">Color Carpeta</label>
                                              <div className="flex items-center gap-2">
                                                <div className="w-9 h-9 rounded border border-border overflow-hidden relative">
                                                  <input 
                                                    type="color" value={groupColorDraft} onChange={(e) => setGroupColorDraft(e.target.value)}
                                                    className="absolute inset-[-10px] w-16 h-16 cursor-pointer"
                                                  />
                                                </div>
                                                <input 
                                                  type="text" value={groupColorDraft} onChange={(e) => setGroupColorDraft(e.target.value)}
                                                  className="flex-1 bg-background border border-border rounded-lg px-3 h-9 text-xs font-mono outline-none"
                                                />
                                              </div>
                                            </div>
                                          </div>
                                          <div>
                                            <label className="text-[10px] text-muted-foreground uppercase font-black tracking-widest mb-1 block">Descripción Extendida</label>
                                            <input 
                                              type="text" value={descDraft} onChange={(e) => setDescDraft(e.target.value)}
                                              placeholder="Contexto extra..."
                                              className="w-full bg-background border border-border rounded-lg px-3 py-2 text-sm text-foreground focus:ring-1 focus:ring-primary outline-none" 
                                              onKeyDown={(e) => { if (e.key === "Enter") saveLabel(val); if (e.key === "Escape") setEditingLabel(null); }}
                                            />
                                          </div>
                                          <div className="flex items-center gap-2 pt-1 border-t border-border mt-3">
                                            <button 
                                              onClick={() => saveLabel(val)} 
                                              disabled={!nameDraft.trim()}
                                              className="px-4 py-1.5 bg-primary/20 hover:bg-primary text-primary hover:text-white rounded-md text-xs font-black tracking-widest uppercase transition-colors"
                                            >
                                              Guardar
                                            </button>
                                            <button onClick={() => setEditingLabel(null)} className="px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground hover:bg-secondary rounded-md transition-colors">Cancelar</button>
                                          </div>
                                        </div>
                                      ) : isEditingColor ? (
                                        <div className="space-y-3 animate-in fade-in duration-200">
                                          <div className="grid grid-cols-10 gap-1.5">
                                            {PRESET_COLORS.map(c => (
                                              <button 
                                                key={c} onClick={() => handleSetColor(val, c)}
                                                className={`w-6 h-6 rounded shadow-sm border transition-transform hover:scale-125 ${color.bg === c ? "border-primary ring-2 ring-primary/40 scale-110" : "border-white/10"}`}
                                                style={{ backgroundColor: c }} 
                                              />
                                            ))}
                                          </div>
                                          <div className="flex items-center gap-3 pt-3 border-t border-border">
                                            <span className="text-xs text-muted-foreground font-mono">HEX:</span>
                                            <input type="color" value={color.bg} onChange={(e) => handleSetColor(val, e.target.value)} />
                                            <button onClick={() => setEditingColor(null)} className="ml-auto text-xs px-3 py-1 bg-secondary rounded hover:bg-white/10">Cerrar</button>
                                          </div>
                                        </div>
                                      ) : (
                                        <div>
                                          <span className="px-2.5 py-1 rounded inline-block text-sm font-black uppercase tracking-wider shadow-sm" style={{ backgroundColor: color.bg, color: color.text }}>
                                            {val}
                                          </span>
                                          {desc && <p className="text-sm text-muted-foreground italic mt-1.5 border-l-2 border-border pl-2 line-clamp-1">{desc}</p>}
                                        </div>
                                      )}
                                    </div>

                                    {/* Right Actions */}
                                    {!isEditingLabel && !isEditingColor && (
                                      <div className="flex items-center gap-1.5 opacity-0 group-hover:opacity-100 transition-opacity">
                                        <button 
                                          onClick={() => { setEditingLabel(val); setEditingColor(null); setNameDraft(val); setDescDraft(descriptions[val] || ""); setGroupDraft(groups[val] || ""); setGroupColorDraft(groupColors[groups[val]] || "#666666"); }}
                                          className="w-8 h-8 flex items-center justify-center rounded-md bg-secondary text-primary hover:bg-primary/20"
                                        >
                                          <Pencil className="w-4 h-4" />
                                        </button>
                                        <button onClick={() => setValues(values.filter(v => v !== val))} className="w-8 h-8 flex items-center justify-center rounded-md bg-secondary text-destructive hover:bg-destructive/20">
                                          <X className="w-4 h-4" />
                                        </button>
                                      </div>
                                    )}
                                  </div>
                                );
                              })}
                            </div>
                          </div>
                        ));
                      })()}
                    </div>
                  )}

                  {/* Add New Panel */}
                  <div className="mt-8 bg-card/40 backdrop-blur-md rounded-xl p-6 border border-primary/20 shadow-[0_4px_30px_rgba(0,0,0,0.1)] relative overflow-hidden group">
                    <div className="absolute top-0 right-0 w-32 h-32 bg-primary/5 blur-3xl pointer-events-none" />
                    <h4 className="text-xs font-black tracking-widest text-primary uppercase mb-4 flex items-center gap-2">
                      <Plus className="w-4 h-4" /> Crear Nueva Opción
                    </h4>
                    
                    <div className="flex flex-col sm:flex-row gap-4 items-start">
                      {/* Color Picker for New */}
                      <div className="flex-shrink-0">
                        <label className="text-[10px] text-muted-foreground uppercase font-black block mb-1">Color</label>
                        <div className="w-12 h-12 rounded-lg border border-border shadow-inner relative overflow-hidden cursor-pointer hover:border-white transition-colors" style={{ backgroundColor: newColor }}>
                          <input 
                            type="color" 
                            value={newColor} 
                            onChange={(e) => setNewColor(e.target.value)} 
                            className="absolute inset-[-10px] w-16 h-16 cursor-pointer" 
                          />
                        </div>
                      </div>
                      
                      {/* Input for New */}
                      <div className="flex-1 w-full">
                        <label className="text-[10px] text-muted-foreground uppercase font-black block mb-1">Etiqueta Principal</label>
                        <input 
                           type="text" 
                          value={newValue} 
                          onChange={(e) => setNewValue(e.target.value)} 
                          onKeyDown={(e) => {
                            if (e.key === "Enter" && newValue.trim() && !values.includes(newValue.trim())) { 
                              const val = newValue.trim(); setValues([...values, val]); handleSetColor(val, newColor);
                              if (groupDraft.trim()) {
                                setGroups(prev => ({ ...prev, [val]: groupDraft.trim() }));
                                setGroupColors(prev => ({ ...prev, [groupDraft.trim()]: groupColorDraft }));
                              }
                              setNewValue(""); setGroupDraft("");
                            }
                          }} 
                          placeholder="Escribe el nombre y presiona Enter..." 
                          className="w-full h-12 bg-background border border-border rounded-lg px-4 text-sm font-bold text-foreground focus:ring-1 focus:ring-primary outline-none tracking-wide" 
                        />
                      </div>

                      {/* Group Assignment for New */}
                      <div className="w-full sm:w-48">
                        <label className="text-[10px] text-muted-foreground uppercase font-black block mb-1">Carpeta (Opcional)</label>
                        <input 
                          type="text" 
                          value={groupDraft} 
                          onChange={(e) => setGroupDraft(e.target.value)} 
                          placeholder="Carpeta..." 
                          className="w-full h-12 bg-background border border-border rounded-lg px-4 text-sm text-foreground focus:ring-1 focus:ring-primary outline-none uppercase" 
                        />
                      </div>
                      
                      {/* Submit Button */}
                      <div className="self-end pb-0 sm:pb-0 h-12 flex">
                        <button 
                          onClick={() => { 
                            if (newValue.trim() && !values.includes(newValue.trim())) { 
                              const val = newValue.trim(); setValues([...values, val]); handleSetColor(val, newColor); setNewValue(""); 
                            } 
                          }} 
                          disabled={!newValue.trim()}
                          className="h-full px-6 bg-primary text-primary-foreground rounded-lg font-black tracking-wider text-xs uppercase transition-all hover:bg-primary/80 disabled:opacity-50 flex items-center gap-2"
                        >
                          Añadir
                        </button>
                      </div>
                    </div>
                  </div>
                </div>

                {/* Optional Right Info Column (if we want to expand docs context) */}
                <div className="hidden xl:block w-80 self-start sticky top-10">
                  <div className="bg-secondary/40 rounded-xl p-5 border border-white/5 space-y-4">
                    <h3 className="text-xs font-black text-muted-foreground tracking-widest uppercase flex items-center gap-2">
                       <Tags className="w-4 h-4" /> Buenas Prácticas
                    </h3>
                    <div className="text-xs text-muted-foreground leading-relaxed space-y-3">
                      <p>➤ Mantén la consistencia visual usando la paleta predefinida para opciones similares.</p>
                      <p>➤ Evita etiquetas demasiado largas. Usa el campo "Descripción" extra para notas complejas.</p>
                      <p>➤ Toca <strong>Guardar Catálogo</strong> en el encabezado cuando hayas finalizado tus cambios.</p>
                      <p className="text-primary font-bold"><br/>Aviso: Cambiar el nombre de una etiqueta aquí afectará los reportes futuros sobre este campo.</p>
                    </div>
                  </div>
                </div>
              </div>

              {/* Floating Action Bar for Bulk Moves */}
              {selectedLabels.length > 0 && (
                <div className="fixed bottom-8 left-1/2 -translate-x-1/2 z-50 animate-in slide-in-from-bottom-10 duration-500">
                  <div className="bg-foreground text-background px-6 py-4 rounded-2xl shadow-2xl flex items-center gap-6 border border-white/10 backdrop-blur-md">
                    <div className="flex items-center gap-3 pr-6 border-r border-background/20">
                      <div className="w-8 h-8 rounded-full bg-primary flex items-center justify-center font-black text-white text-sm">
                        {selectedLabels.length}
                      </div>
                      <span className="text-xs font-black uppercase tracking-widest">Seleccionadas</span>
                    </div>
                    
                    <div className="flex items-center gap-3">
                      <span className="text-[10px] font-black uppercase text-muted-foreground">Mover a:</span>
                      <div className="flex flex-wrap gap-2 max-w-[400px]">
                        {["SIN GRUPO", ...Object.keys(groupColors)].map(gn => (
                          <button
                            key={gn}
                            onClick={() => moveLabelsToGroup(selectedLabels, gn === "SIN GRUPO" ? null : gn)}
                            className="px-3 py-1.5 bg-background/10 hover:bg-primary hover:text-white rounded-lg text-[10px] font-bold uppercase tracking-tight transition-all border border-white/5"
                          >
                            {gn}
                          </button>
                        ))}
                      </div>
                    </div>

                    <button 
                      onClick={() => setSelectedLabels([])}
                      className="p-2 hover:bg-white/10 rounded-full transition-colors text-muted-foreground hover:text-white"
                    >
                      <X className="w-5 h-5" />
                    </button>
                  </div>
                </div>
              )}
            </>
          ) : (
             <div className="flex-1 flex flex-col items-center justify-center p-10"><Loader2 className="w-10 h-10 animate-spin text-primary" /></div>
          )}
        </div>
      </div>
    </div>
  );
}
