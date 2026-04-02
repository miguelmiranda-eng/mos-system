import React, { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { useLang } from "../contexts/LanguageContext";
import { API, getStatusColor } from "../lib/constants";
import { 
  ArrowLeft, Settings, Plus, Loader2, Pencil, Check, X, 
  Tags, Layers, Box, Truck, Palette, LayoutDashboard 
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
  const [editingColor, setEditingColor] = useState(null);
  const [editingLabel, setEditingLabel] = useState(null);
  const [nameDraft, setNameDraft] = useState("");
  const [descDraft, setDescDraft] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

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
      const [optRes, colRes, descRes] = await Promise.all([
        fetch(`${API}/config/options`, { credentials: "include" }),
        fetch(`${API}/config/colors`, { credentials: "include" }),
        fetch(`${API}/config/descriptions`, { credentials: "include" })
      ]);
      if (optRes.ok) setOptions(await optRes.json());
      if (colRes.ok) setCustomColors(await colRes.json());
      if (descRes.ok) setDescriptions(await descRes.json());
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
      // Rename: update values, migrate color and description
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
    } else {
      setDescriptions(prev => {
        const next = { ...prev };
        if (newDesc) next[oldVal] = newDesc;
        else delete next[oldVal];
        return next;
      });
    }
    setEditingLabel(null);
    setNameDraft("");
    setDescDraft("");
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
                  <h3 className="text-sm font-bold uppercase tracking-widest text-muted-foreground mb-4 border-b border-border pb-2">
                    ETIQUETAS ACTUALES ({values.length})
                  </h3>

                  {values.length === 0 ? (
                    <div className="text-center py-10 border border-dashed border-border rounded-xl bg-secondary/10">
                      <p className="text-muted-foreground font-mono">No hay etiquetas creadas en este catálogo todavía.</p>
                    </div>
                  ) : (
                    <div className="space-y-2">
                      {values.map((val, idx) => {
                        const color = getColor(val);
                        const desc = descriptions[val] || "";
                        const isEditingLabel = editingLabel === val;
                        const isEditingColor = editingColor === val;

                        return (
                          <div 
                            key={idx} 
                            className={`flex items-start gap-4 p-3 rounded-xl border transition-all group relative overflow-hidden ${
                              isEditingLabel || isEditingColor ? "bg-secondary/50 border-primary/30" : "bg-card/40 border-border hover:border-muted-foreground/30 hover:shadow-md"
                            }`}
                          >
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

                            {/* Center Info OR Editing Form */}
                            <div className="flex-1 min-w-0 pt-0.5">
                              {isEditingLabel ? (
                                // Editor Mode
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
                                  <div>
                                    <label className="text-[10px] text-muted-foreground uppercase font-black tracking-widest mb-1 block">Descripción Extendida (Hover Info)</label>
                                    <input 
                                      type="text" value={descDraft} onChange={(e) => setDescDraft(e.target.value)}
                                      placeholder="Añade contexto extra..."
                                      className="w-full bg-background border border-border rounded-lg px-3 py-2 text-sm text-foreground focus:ring-1 focus:ring-primary outline-none" 
                                      onKeyDown={(e) => { if (e.key === "Enter") saveLabel(val); if (e.key === "Escape") setEditingLabel(null); }}
                                    />
                                  </div>
                                  <div className="flex items-center gap-2 pt-1 border-t border-border mt-3">
                                    <button 
                                      onClick={() => saveLabel(val)} 
                                      disabled={!nameDraft.trim() || (nameDraft.trim() !== val && values.includes(nameDraft.trim()))}
                                      className="px-4 py-1.5 bg-primary/20 hover:bg-primary text-primary hover:text-white rounded-md text-xs font-black tracking-widest uppercase transition-colors"
                                    >
                                      Guardar
                                    </button>
                                    <button onClick={() => setEditingLabel(null)} className="px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground hover:bg-secondary rounded-md transition-colors">Cancelar</button>
                                  </div>
                                </div>
                              ) : isEditingColor ? (
                                // Color Picker Mode
                                <div className="space-y-3 animate-in fade-in duration-200">
                                  <div className="flex items-center gap-2 mb-2">
                                    <span className="text-[10px] font-black uppercase text-muted-foreground tracking-widest">Colores Predefinidos:</span>
                                  </div>
                                  <div className="grid grid-cols-10 gap-1.5">
                                    {PRESET_COLORS.map(c => (
                                      <button 
                                        key={c} onClick={() => handleSetColor(val, c)}
                                        className={`w-6 h-6 rounded shadow-sm border transition-transform hover:scale-125 hover:z-10 ${color.bg === c ? "border-primary ring-2 ring-primary/40 scale-110 z-10" : "border-white/10"}`}
                                        style={{ backgroundColor: c }} 
                                      />
                                    ))}
                                  </div>
                                  <div className="flex items-center gap-3 pt-3 border-t border-border">
                                    <span className="text-xs text-muted-foreground font-mono">EXACTO (HEX):</span>
                                    <div className="relative overflow-hidden w-8 h-8 rounded border border-border cursor-pointer hover:border-white transition-colors">
                                      <input 
                                        type="color" value={color.bg} 
                                        onChange={(e) => handleSetColor(val, e.target.value)} 
                                        className="absolute inset-[-10px] cursor-pointer w-12 h-12" 
                                      />
                                    </div>
                                    <button onClick={() => setEditingColor(null)} className="ml-auto text-xs px-3 py-1 bg-secondary rounded hover:bg-white/10 text-foreground transition-colors">Cerrar</button>
                                  </div>
                                </div>
                              ) : (
                                // Display Mode
                                <div>
                                  <span className="px-2.5 py-1 rounded inline-block text-sm font-black uppercase tracking-wider shadow-sm" style={{ backgroundColor: color.bg, color: color.text }}>
                                    {val}
                                  </span>
                                  {desc && (
                                    <p className="text-sm text-muted-foreground italic mt-1.5 border-l-2 border-border pl-2 line-clamp-2">
                                      {desc}
                                    </p>
                                  )}
                                </div>
                              )}
                            </div>

                            {/* Right Actions */}
                            {!isEditingLabel && !isEditingColor && (
                              <div className="flex items-center flex-col sm:flex-row opacity-0 group-hover:opacity-100 transition-opacity gap-1.5 ml-auto">
                                <button 
                                  onClick={() => { setEditingLabel(val); setEditingColor(null); setNameDraft(val); setDescDraft(descriptions[val] || ""); }}
                                  className="w-8 h-8 flex items-center justify-center rounded-md bg-secondary text-primary hover:bg-primary/20 transition-colors"
                                  title="Editar nombre/descripción"
                                >
                                  <Pencil className="w-4 h-4" />
                                </button>
                                <button 
                                  onClick={() => { setValues(values.filter(v => v !== val)); }}
                                  className="w-8 h-8 flex items-center justify-center rounded-md bg-secondary text-destructive hover:bg-destructive/20 transition-colors"
                                  title="Eliminar opción"
                                >
                                  <X className="w-4 h-4" />
                                </button>
                              </div>
                            )}
                          </div>
                        );
                      })}
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
                              const val = newValue.trim(); setValues([...values, val]); handleSetColor(val, newColor); setNewValue(""); 
                            }
                          }} 
                          placeholder="Escribe el estado / cliente y presiona Enter..." 
                          className="w-full h-12 bg-background border border-border rounded-lg px-4 text-sm font-bold text-foreground focus:ring-1 focus:ring-primary outline-none tracking-wide" 
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
            </>
          ) : (
             <div className="flex-1 flex flex-col items-center justify-center p-10"><Loader2 className="w-10 h-10 animate-spin text-primary" /></div>
          )}
        </div>
      </div>
    </div>
  );
}
