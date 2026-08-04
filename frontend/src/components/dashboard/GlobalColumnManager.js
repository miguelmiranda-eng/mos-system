import React, { useState, useEffect, useRef, useMemo } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "../ui/dialog";
import {
  GripVertical, Eye, EyeOff, Save, Loader2, Columns, Plus, Trash2,
  Search, Pencil, Check, X, Lock, SlidersHorizontal, ChevronLeft, FunctionSquare,
} from "lucide-react";
import { toast } from "sonner";
import { API, DEFAULT_COLUMNS } from "../../lib/constants";
import { FormulaEditor } from "./FormulaEditor";
import { validateFormula } from "../../lib/formula";

// Type catalog shared by the add form and the per-row type editor. `estado`
// is the UI label for a colored select; it persists as type 'select'.
const TYPE_OPTIONS = [
  { value: "text", label: "Texto" },
  { value: "number", label: "Número" },
  { value: "date", label: "Fecha" },
  { value: "link", label: "Enlace" },
  { value: "checkbox", label: "Check" },
  { value: "estado", label: "Estado" },
  { value: "formula", label: "Fórmula" },
];
const TYPE_LABEL = {
  text: "Texto", number: "Número", date: "Fecha", link: "Enlace",
  checkbox: "Check", select: "Estado", estado: "Estado", formula: "Fórmula",
};
// Types the inline editor can switch a column to without extra config.
const SIMPLE_TYPES = new Set(["text", "number", "date", "link", "checkbox"]);
const PRESET_COLORS = ['#3d85c6','#cf0000','#38761d','#f1c232','#674ea7','#e066cc','#e69138','#b44253','#20124d','#999999'];
const DEFAULT_BG = "#3d85c6";

const slugify = (name) =>
  name.trim().toLowerCase().replace(/\s+/g, "_").replace(/[^a-z0-9_]/g, "");

export const GlobalColumnManager = ({ isOpen, onClose }) => {
  // cols: full defs in display order, each tagged { custom: true|false }.
  const [cols, setCols] = useState([]);
  const [hidden, setHidden] = useState([]);
  const [removedDefaults, setRemovedDefaults] = useState([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [search, setSearch] = useState("");

  // Status option/color content (shared by every select column).
  const [optionsMap, setOptionsMap] = useState({});   // optionKey -> [values]
  const [colorsMap, setColorsMap] = useState({});     // value -> { bg, text }
  const [dirtyOptionKeys, setDirtyOptionKeys] = useState([]);
  const [colorsDirty, setColorsDirty] = useState(false);

  // Formula sub-editor (per column). Hasta ahora la fórmula solo se podía
  // definir al CREAR la columna: si salía mal, la única salida era borrarla y
  // rehacerla, perdiendo su posición y visibilidad.
  const [fxEditorKey, setFxEditorKey] = useState(null);
  const [fxDraft, setFxDraft] = useState("");
  // Una orden real para la vista previa del editor de fórmulas.
  const [sampleRow, setSampleRow] = useState(null);

  // Status-content sub-editor (per column)
  const [optEditorKey, setOptEditorKey] = useState(null); // column key being edited
  const [editorRows, setEditorRows] = useState([]);       // [{ value, color }]
  const [addVal, setAddVal] = useState("");
  const [addColor, setAddColor] = useState(DEFAULT_BG);

  // Inline rename of the column name
  const [editingKey, setEditingKey] = useState(null);
  const [editingLabel, setEditingLabel] = useState("");

  // Add-column form
  const [showAdd, setShowAdd] = useState(false);
  const [newName, setNewName] = useState("");
  const [newType, setNewType] = useState("text");
  const [newFormula, setNewFormula] = useState("");
  const [statusOptions, setStatusOptions] = useState([]);
  const [newStatusVal, setNewStatusVal] = useState("");
  const [newStatusColor, setNewStatusColor] = useState(DEFAULT_BG);

  // Drag state
  const dragKey = useRef(null);
  const [dragOverKey, setDragOverKey] = useState(null);

  useEffect(() => {
    if (!isOpen) return;
    setLoading(true);
    setSearch(""); setShowAdd(false); setEditingKey(null); setOptEditorKey(null);
    setFxEditorKey(null); setDirtyOptionKeys([]); setColorsDirty(false);

    // Una orden real para que el editor de fórmulas muestre el resultado de
    // verdad y no solo "sintaxis correcta". Es opcional: si falla, el editor
    // sigue validando, nada más sin vista previa.
    fetch(`${API}/orders?limit=1`, { credentials: "include" })
      .then(r => r.ok ? r.json() : null)
      .then(d => setSampleRow(Array.isArray(d) ? d[0] || null : (d?.orders?.[0] || null)))
      .catch(() => setSampleRow(null));

    Promise.all([
      fetch(`${API}/config/columns`, { credentials: "include" }).then(r => r.ok ? r.json() : {}),
      fetch(`${API}/config/board-layout/MASTER`, { credentials: "include" }).then(r => r.ok ? r.json() : {}),
      fetch(`${API}/config/options`, { credentials: "include" }).then(r => r.ok ? r.json() : {}),
      fetch(`${API}/config/colors`, { credentials: "include" }).then(r => r.ok ? r.json() : {}),
    ])
      .then(([colData, layout, optsData, colorsData]) => {
        const removed = colData.removed_default_columns || [];
        const custom = colData.custom_columns || [];
        const defaultKeys = new Set(DEFAULT_COLUMNS.map(c => c.key));

        const activeDefaults = DEFAULT_COLUMNS
          .filter(c => !removed.includes(c.key))
          .map(c => ({ ...c, custom: false }));
        const uniqueCustom = custom
          .filter(c => !defaultKeys.has(c.key))
          .map(c => ({ ...c, custom: true }));
        const all = [...activeDefaults, ...uniqueCustom];

        const order = layout.column_order || [];
        const byKey = new Map(all.map(c => [c.key, c]));
        const ordered = [];
        order.forEach(k => { if (byKey.has(k)) { ordered.push(byKey.get(k)); byKey.delete(k); } });
        byKey.forEach(c => ordered.push(c));

        // Seed the shared option/color maps. Custom estado columns keep their
        // values inside statusOptions, so fold those in when config_options
        // doesn't already carry the list.
        const optsMap = { ...optsData };
        const colMap = { ...colorsData };
        ordered.forEach(c => {
          if (c.type === "select" && c.custom && Array.isArray(c.statusOptions)) {
            if (!optsMap[c.optionKey]) optsMap[c.optionKey] = c.statusOptions.map(s => s.value);
            c.statusOptions.forEach(s => { if (!colMap[s.value]) colMap[s.value] = { bg: s.color, text: "#FFFFFF" }; });
          }
        });

        setCols(ordered);
        setHidden(layout.hidden_columns || []);
        setRemovedDefaults(removed);
        setOptionsMap(optsMap);
        setColorsMap(colMap);
      })
      .catch(() => {
        setCols(DEFAULT_COLUMNS.map(c => ({ ...c, custom: false })));
        setHidden([]); setRemovedDefaults([]); setOptionsMap({}); setColorsMap({});
      })
      .finally(() => setLoading(false));
  }, [isOpen]);

  const visibleCount = cols.length - hidden.length;

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return cols;
    return cols.filter(c =>
      (c.label || "").toLowerCase().includes(q) || (c.key || "").toLowerCase().includes(q)
    );
  }, [cols, search]);
  const canDrag = search.trim().length === 0;

  // ---- column mutations (local; persisted on Save) ----
  const toggleVisibility = (key) =>
    setHidden(prev => prev.includes(key) ? prev.filter(k => k !== key) : [...prev, key]);

  const startEdit = (col) => { setEditingKey(col.key); setEditingLabel(col.label || col.key); };
  const commitEdit = () => {
    const label = editingLabel.trim();
    if (label) setCols(prev => prev.map(c => c.key === editingKey ? { ...c, label } : c));
    setEditingKey(null);
  };

  const changeType = (key, type) =>
    setCols(prev => prev.map(c => c.key === key ? { ...c, type } : c));

  const removeColumn = (col) => {
    if (!window.confirm(`¿Quitar la columna "${col.label}"? Podés volver a agregarla luego.`)) return;
    setCols(prev => prev.filter(c => c.key !== col.key));
    setHidden(prev => prev.filter(k => k !== col.key));
    if (!col.custom) setRemovedDefaults(prev => prev.includes(col.key) ? prev : [...prev, col.key]);
  };

  // ---- status content editor ----
  const openOptEditor = (col) => {
    const vals = optionsMap[col.optionKey] || [];
    setEditorRows(vals.map(v => ({ value: v, color: colorsMap[v]?.bg || DEFAULT_BG })));
    setAddVal(""); setAddColor(DEFAULT_BG);
    setOptEditorKey(col.key);
  };
  const editorCol = cols.find(c => c.key === optEditorKey);
  const fxCol = cols.find(c => c.key === fxEditorKey);
  const fxCheck = fxEditorKey ? validateFormula(fxDraft, cols) : null;

  const openFxEditor = (col) => { setFxEditorKey(col.key); setFxDraft(col.formula || ""); };
  const applyFxEditor = () => {
    if (!fxCheck?.ok) { toast.error(fxCheck?.message || "La fórmula no es válida"); return; }
    setCols(prev => prev.map(c => c.key === fxEditorKey ? { ...c, formula: fxDraft.trim() } : c));
    toast.success(`Fórmula de "${fxCol?.label || fxEditorKey}" actualizada`);
    setFxEditorKey(null);
  };
  const setRowValue = (i, value) => setEditorRows(prev => prev.map((r, j) => j === i ? { ...r, value } : r));
  const setRowColor = (i, color) => setEditorRows(prev => prev.map((r, j) => j === i ? { ...r, color } : r));
  const removeRow = (i) => setEditorRows(prev => prev.filter((_, j) => j !== i));
  const addRow = () => {
    const v = addVal.trim();
    if (!v) return;
    if (editorRows.some(r => r.value.trim().toLowerCase() === v.toLowerCase())) { toast.error("Ese estado ya existe"); return; }
    setEditorRows(prev => [...prev, { value: v, color: addColor }]);
    setAddVal("");
  };
  const applyOptEditor = () => {
    const col = editorCol;
    if (!col) { setOptEditorKey(null); return; }
    // Clean + dedup, preserving order.
    const seen = new Set();
    const rows = [];
    editorRows.forEach(r => {
      const v = r.value.trim();
      if (!v) return;
      const lk = v.toLowerCase();
      if (seen.has(lk)) return;
      seen.add(lk);
      rows.push({ value: v, color: r.color || DEFAULT_BG });
    });
    const values = rows.map(r => r.value);

    setOptionsMap(prev => ({ ...prev, [col.optionKey]: values }));
    setColorsMap(prev => {
      const next = { ...prev };
      rows.forEach(r => { next[r.value] = { bg: r.color, text: "#FFFFFF" }; });
      return next;
    });
    setDirtyOptionKeys(prev => prev.includes(col.optionKey) ? prev : [...prev, col.optionKey]);
    setColorsDirty(true);

    // Keep custom columns' embedded statusOptions in sync.
    if (col.custom) {
      setCols(prev => prev.map(c => c.key === col.key
        ? { ...c, statusOptions: rows.map(r => ({ value: r.value, color: r.color })) }
        : c));
    }
    toast.success(`Opciones de "${col.label}" actualizadas`);
    setOptEditorKey(null);
  };

  // ---- add column ----
  const resetAddForm = () => {
    setNewName(""); setNewType("text"); setNewFormula("");
    setStatusOptions([]); setNewStatusVal("");
  };
  const addColumn = () => {
    const name = newName.trim();
    if (!name) return;
    const key = slugify(name);
    if (!key) { toast.error("Nombre inválido"); return; }
    if (cols.some(c => c.key === key) || removedDefaults.includes(key)) {
      toast.error("Ya existe una columna con ese nombre"); return;
    }
    if (newType === "formula") {
      const check = validateFormula(newFormula, cols);
      if (!check.ok) { toast.error(check.message); return; }
    }
    const def = { key, label: name, type: newType, width: 150, custom: true };
    if (newType === "formula") def.formula = newFormula.trim();
    if (newType === "estado") {
      def.type = "select";
      def.optionKey = `custom_${key}`;
      def.statusOptions = statusOptions;
      // Seed the shared maps so the editor & CRM see the new options.
      setOptionsMap(prev => ({ ...prev, [def.optionKey]: statusOptions.map(s => s.value) }));
      setColorsMap(prev => {
        const next = { ...prev };
        statusOptions.forEach(s => { next[s.value] = { bg: s.color, text: "#FFFFFF" }; });
        return next;
      });
      setDirtyOptionKeys(prev => [...prev, def.optionKey]);
      setColorsDirty(true);
    }
    setCols(prev => [...prev, def]);
    resetAddForm(); setShowAdd(false);
    toast.success(`Columna "${name}" agregada`);
  };
  const addStatusOption = () => {
    const v = newStatusVal.trim();
    if (!v) return;
    setStatusOptions(prev => [...prev, { value: v, color: newStatusColor }]);
    setNewStatusVal("");
  };

  // ---- drag & drop (by key) ----
  const handleDragStart = (key) => { dragKey.current = key; };
  const handleDragOver = (e, key) => {
    e.preventDefault();
    if (dragKey.current && dragKey.current !== key) setDragOverKey(key);
  };
  const handleDrop = (e, key) => {
    e.preventDefault();
    const from = dragKey.current;
    setDragOverKey(null); dragKey.current = null;
    if (!from || from === key) return;
    setCols(prev => {
      const next = [...prev];
      const fi = next.findIndex(c => c.key === from);
      const ti = next.findIndex(c => c.key === key);
      if (fi === -1 || ti === -1) return prev;
      const [moved] = next.splice(fi, 1);
      next.splice(ti, 0, moved);
      return next;
    });
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      // Keep the `custom: true` flag so other consumers (form-fields manager,
      // new-order form) can still identify custom columns.
      const custom_columns = cols.filter(c => c.custom).map(c => ({ ...c, custom: true }));
      const reqs = [
        fetch(`${API}/config/columns`, {
          method: "PUT", headers: { "Content-Type": "application/json" }, credentials: "include",
          body: JSON.stringify({ custom_columns, removed_default_columns: removedDefaults }),
        }),
        fetch(`${API}/config/board-layout/MASTER`, {
          method: "PUT", headers: { "Content-Type": "application/json" }, credentials: "include",
          body: JSON.stringify({ column_order: cols.map(c => c.key), hidden_columns: hidden }),
        }),
      ];
      // One PUT /config/options per edited status column.
      dirtyOptionKeys.forEach(key => {
        reqs.push(fetch(`${API}/config/options`, {
          method: "PUT", headers: { "Content-Type": "application/json" }, credentials: "include",
          body: JSON.stringify({ option_key: key, values: optionsMap[key] || [] }),
        }));
      });
      if (colorsDirty) {
        reqs.push(fetch(`${API}/config/colors`, {
          method: "PUT", headers: { "Content-Type": "application/json" }, credentials: "include",
          body: JSON.stringify(colorsMap),
        }));
      }
      const results = await Promise.all(reqs);
      if (results.every(r => r.ok)) { toast.success("Columnas guardadas"); onClose(); }
      else toast.error("Error al guardar algunos cambios");
    } catch {
      toast.error("Error de red al guardar");
    } finally { setSaving(false); }
  };

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="max-w-3xl bg-card border-border h-[85vh] flex flex-col p-0 overflow-hidden shadow-2xl">
        {/* Header */}
        <DialogHeader className="px-6 py-4 border-b border-border">
          <DialogTitle className="font-barlow text-lg font-black uppercase tracking-tight flex items-center gap-2.5">
            <Columns className="w-5 h-5 text-primary" />
            Gestor de Columnas
          </DialogTitle>
          <p className="text-[11px] text-muted-foreground mt-0.5">
            Arrastra para reordenar · ojo para ocultar · lápiz para renombrar · controles para editar estados · ƒ para editar la fórmula · aplica a todos los tableros.
          </p>
        </DialogHeader>

        {optEditorKey && editorCol ? (
          /* ===== Status content editor ===== */
          <>
            <div className="px-6 py-3 border-b border-border flex items-center gap-3">
              <button onClick={() => setOptEditorKey(null)} className="p-1.5 rounded-lg hover:bg-secondary text-muted-foreground hover:text-foreground" title="Volver">
                <ChevronLeft className="w-4 h-4" />
              </button>
              <div className="flex-1 min-w-0">
                <div className="text-sm font-black uppercase tracking-tight truncate">{editorCol.label}</div>
                <div className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground/60">Opciones del estado</div>
              </div>
            </div>

            <div className="flex-1 overflow-y-auto px-6 py-4 space-y-2 custom-scrollbar">
              {editorRows.length === 0 && (
                <div className="text-[12px] text-muted-foreground italic py-6 text-center">Sin opciones todavía. Agrega la primera abajo.</div>
              )}
              {editorRows.map((row, i) => (
                <div key={i} className="flex items-center gap-2">
                  <label className="relative w-9 h-9 rounded-lg border border-border cursor-pointer flex-shrink-0" style={{ backgroundColor: row.color }} title="Color">
                    <input type="color" value={row.color} onChange={(e) => setRowColor(i, e.target.value)} className="absolute inset-0 opacity-0 cursor-pointer" />
                  </label>
                  <input
                    value={row.value}
                    onChange={(e) => setRowValue(i, e.target.value)}
                    className="flex-1 h-9 px-3 bg-secondary/60 border border-border rounded-lg text-sm focus:outline-none focus:border-primary"
                  />
                  <span className="px-2.5 py-1 rounded text-[11px] font-bold text-white whitespace-nowrap hidden sm:inline" style={{ backgroundColor: row.color }}>
                    {row.value || "—"}
                  </span>
                  <button onClick={() => removeRow(i)} className="p-2 rounded-lg text-muted-foreground hover:text-destructive hover:bg-destructive/10" title="Quitar opción">
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              ))}

              <div className="flex items-center gap-2 pt-3 mt-2 border-t border-border/50">
                <label className="relative w-9 h-9 rounded-lg border border-border cursor-pointer flex-shrink-0" style={{ backgroundColor: addColor }} title="Color">
                  <input type="color" value={addColor} onChange={(e) => setAddColor(e.target.value)} className="absolute inset-0 opacity-0 cursor-pointer" />
                </label>
                <input
                  value={addVal}
                  onChange={(e) => setAddVal(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") addRow(); }}
                  placeholder="Nueva opción de estado"
                  className="flex-1 h-9 px-3 bg-card border border-border rounded-lg text-sm focus:outline-none focus:border-primary"
                />
                <button onClick={addRow} className="h-9 px-3 bg-secondary border border-border rounded-lg hover:bg-secondary/80 flex items-center"><Plus className="w-4 h-4" /></button>
              </div>
              <div className="flex gap-1 pl-11">
                {PRESET_COLORS.map(c => (
                  <button key={c} onClick={() => setAddColor(c)} className="w-5 h-5 rounded-full border border-border/50" style={{ backgroundColor: c }} />
                ))}
              </div>
            </div>

            <div className="px-6 py-4 border-t border-border flex justify-between items-center">
              <span className="text-[10px] font-bold text-muted-foreground uppercase tracking-widest">{editorRows.length} opciones</span>
              <div className="flex gap-2">
                <button onClick={() => setOptEditorKey(null)} className="px-5 py-2 rounded-lg text-[11px] font-black uppercase tracking-widest text-muted-foreground hover:bg-secondary">Cancelar</button>
                <button onClick={applyOptEditor} className="px-6 py-2 bg-primary text-black rounded-lg text-[11px] font-black uppercase tracking-widest flex items-center gap-2">
                  <Check className="w-4 h-4" /> Aplicar
                </button>
              </div>
            </div>
          </>
        ) : fxEditorKey && fxCol ? (
          /* ===== Formula editor ===== */
          <>
            <div className="px-6 py-3 border-b border-border flex items-center gap-3">
              <button onClick={() => setFxEditorKey(null)} className="p-1.5 rounded-lg hover:bg-secondary text-muted-foreground hover:text-foreground" title="Volver">
                <ChevronLeft className="w-4 h-4" />
              </button>
              <div className="flex-1 min-w-0">
                <div className="text-sm font-black uppercase tracking-tight truncate">{fxCol.label}</div>
                <div className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground/60">Fórmula de la columna</div>
              </div>
            </div>

            <div className="flex-1 overflow-y-auto px-6 py-4 custom-scrollbar">
              <FormulaEditor value={fxDraft} onChange={setFxDraft} columns={cols} sampleRow={sampleRow} />
            </div>

            <div className="px-6 py-4 border-t border-border flex justify-end gap-2">
              <button onClick={() => setFxEditorKey(null)} className="px-5 py-2 rounded-lg text-[11px] font-black uppercase tracking-widest text-muted-foreground hover:bg-secondary">Cancelar</button>
              <button
                onClick={applyFxEditor}
                disabled={!fxCheck?.ok}
                className="px-6 py-2 bg-primary text-black rounded-lg text-[11px] font-black uppercase tracking-widest flex items-center gap-2 disabled:opacity-50"
              >
                <Check className="w-4 h-4" /> Aplicar
              </button>
            </div>
          </>
        ) : (
          /* ===== Column list ===== */
          <>
            {/* Toolbar */}
            <div className="px-6 py-3 border-b border-border flex items-center gap-3">
              <div className="relative flex-1">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
                <input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Buscar columna…"
                  className="w-full h-9 pl-9 pr-3 bg-secondary/60 border border-border rounded-lg text-sm focus:outline-none focus:border-primary"
                />
              </div>
              <button
                onClick={() => setShowAdd(v => !v)}
                className="h-9 px-4 bg-primary text-black rounded-lg text-[11px] font-black uppercase tracking-widest flex items-center gap-1.5 hover:opacity-90 transition-all"
              >
                <Plus className="w-4 h-4" /> Agregar
              </button>
            </div>

            {/* Add form */}
            {showAdd && (
              <div className="px-6 py-4 border-b border-border bg-secondary/20 space-y-3">
                <div className="flex gap-2">
                  <input
                    autoFocus
                    value={newName}
                    onChange={(e) => setNewName(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter" && newType !== "estado" && newType !== "formula") addColumn(); }}
                    placeholder="Nombre de la columna"
                    className="flex-1 h-9 px-3 bg-card border border-border rounded-lg text-sm focus:outline-none focus:border-primary"
                  />
                  <select
                    value={newType}
                    onChange={(e) => setNewType(e.target.value)}
                    className="h-9 px-3 bg-card border border-border rounded-lg text-sm focus:outline-none focus:border-primary"
                  >
                    {TYPE_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                  </select>
                </div>

                {newType === "formula" && (
                  <div className="p-3 bg-card rounded-lg border border-border">
                    <FormulaEditor value={newFormula} onChange={setNewFormula} columns={cols} sampleRow={sampleRow} />
                  </div>
                )}

                {newType === "estado" && (
                  <div className="space-y-2 p-3 bg-card rounded-lg border border-border">
                    <div className="flex flex-wrap gap-1.5">
                      {statusOptions.map((opt, i) => (
                        <span key={i} className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-[11px] font-bold text-white" style={{ backgroundColor: opt.color }}>
                          {opt.value}
                          <button onClick={() => setStatusOptions(statusOptions.filter((_, j) => j !== i))} className="hover:opacity-70"><X className="w-3 h-3" /></button>
                        </span>
                      ))}
                      {statusOptions.length === 0 && <span className="text-[11px] text-muted-foreground italic">Agrega al menos un estado…</span>}
                    </div>
                    <div className="flex gap-2">
                      <input type="color" value={newStatusColor} onChange={(e) => setNewStatusColor(e.target.value)} className="w-9 h-8 rounded border border-border bg-card cursor-pointer" />
                      <input
                        value={newStatusVal}
                        onChange={(e) => setNewStatusVal(e.target.value)}
                        onKeyDown={(e) => { if (e.key === "Enter") addStatusOption(); }}
                        placeholder="Nuevo estado"
                        className="flex-1 h-8 px-3 bg-secondary/60 border border-border rounded-lg text-sm focus:outline-none focus:border-primary"
                      />
                      <button onClick={addStatusOption} className="px-3 bg-secondary border border-border rounded-lg hover:bg-secondary/80"><Plus className="w-4 h-4" /></button>
                    </div>
                    <div className="flex gap-1">
                      {PRESET_COLORS.map(c => (
                        <button key={c} onClick={() => setNewStatusColor(c)} className="w-5 h-5 rounded-full border border-border/50" style={{ backgroundColor: c }} />
                      ))}
                    </div>
                  </div>
                )}

                <div className="flex justify-end gap-2">
                  <button onClick={() => { setShowAdd(false); resetAddForm(); }} className="px-4 py-1.5 text-[11px] font-bold uppercase tracking-widest text-muted-foreground hover:text-foreground">Cancelar</button>
                  <button
                    onClick={addColumn}
                    disabled={!newName.trim() || (newType === "formula" && !newFormula.trim()) || (newType === "estado" && statusOptions.length === 0)}
                    className="px-5 py-1.5 bg-primary text-black rounded-lg text-[11px] font-black uppercase tracking-widest disabled:opacity-50"
                  >
                    Agregar columna
                  </button>
                </div>
              </div>
            )}

            {/* List */}
            <div className="flex-1 overflow-y-auto px-4 py-3 custom-scrollbar">
              {loading ? (
                <div className="flex flex-col items-center justify-center h-48 gap-3">
                  <Loader2 className="w-7 h-7 animate-spin text-primary" />
                  <span className="text-[11px] font-bold uppercase tracking-widest text-muted-foreground">Cargando columnas…</span>
                </div>
              ) : filtered.length === 0 ? (
                <div className="flex items-center justify-center h-48 text-[12px] font-bold uppercase tracking-widest text-muted-foreground/60">
                  Sin columnas que coincidan
                </div>
              ) : (
                <div className="space-y-1">
                  {filtered.map((col) => {
                    const isHidden = hidden.includes(col.key);
                    const isOver = dragOverKey === col.key;
                    const isEditing = editingKey === col.key;
                    const typeLabel = TYPE_LABEL[col.type] || "—";
                    const isStatus = col.type === "select" && !!col.optionKey;
                    return (
                      <div
                        key={col.key}
                        draggable={canDrag && !isEditing}
                        onDragStart={() => handleDragStart(col.key)}
                        onDragOver={(e) => handleDragOver(e, col.key)}
                        onDrop={(e) => handleDrop(e, col.key)}
                        onDragEnd={() => { setDragOverKey(null); dragKey.current = null; }}
                        className={`group flex items-center gap-3 h-11 px-2 rounded-lg border transition-all ${
                          isHidden ? "bg-secondary/20 border-border/30 opacity-55" : "bg-card border-border hover:border-primary/40"
                        } ${isOver ? "border-primary ring-1 ring-primary/30 bg-primary/5" : ""}`}
                      >
                        <div className={`${canDrag ? "cursor-grab active:cursor-grabbing" : "opacity-20"} text-muted-foreground/50`}>
                          <GripVertical className="w-4 h-4" />
                        </div>

                        {/* Name */}
                        <div className="flex-1 min-w-0">
                          {isEditing ? (
                            <div className="flex items-center gap-1">
                              <input
                                autoFocus
                                value={editingLabel}
                                onChange={(e) => setEditingLabel(e.target.value)}
                                onKeyDown={(e) => { if (e.key === "Enter") commitEdit(); if (e.key === "Escape") setEditingKey(null); }}
                                className="flex-1 h-7 px-2 bg-secondary/60 border border-primary/50 rounded text-sm focus:outline-none"
                              />
                              <button onClick={commitEdit} className="p-1.5 text-primary hover:bg-primary/10 rounded"><Check className="w-3.5 h-3.5" /></button>
                              <button onClick={() => setEditingKey(null)} className="p-1.5 text-muted-foreground hover:bg-secondary rounded"><X className="w-3.5 h-3.5" /></button>
                            </div>
                          ) : (
                            <div className="flex items-center gap-2 min-w-0">
                              <span className="text-sm font-bold text-foreground truncate">{col.label || col.key}</span>
                              <span className="text-[10px] font-mono text-muted-foreground/40 truncate hidden md:inline">#{col.key}</span>
                            </div>
                          )}
                        </div>

                        {/* Type */}
                        {!isEditing && (
                          col.custom && SIMPLE_TYPES.has(col.type) ? (
                            <select
                              value={col.type}
                              onChange={(e) => changeType(col.key, e.target.value)}
                              className="h-7 px-2 bg-secondary/60 border border-border rounded text-[11px] font-bold focus:outline-none focus:border-primary"
                              title="Cambiar tipo"
                            >
                              {[...SIMPLE_TYPES].map(tp => <option key={tp} value={tp}>{TYPE_LABEL[tp]}</option>)}
                            </select>
                          ) : (
                            <span className="px-2 py-0.5 rounded-full text-[10px] font-black uppercase tracking-wider bg-secondary text-muted-foreground border border-border/50 whitespace-nowrap">
                              {typeLabel}
                            </span>
                          )
                        )}

                        {/* Origin */}
                        {!isEditing && (
                          <span className={`px-2 py-0.5 rounded-full text-[9px] font-black uppercase tracking-widest whitespace-nowrap border ${
                            col.custom ? "bg-primary/10 text-primary border-primary/20" : "bg-muted/40 text-muted-foreground border-border/50"
                          }`}>
                            {col.custom ? "Custom" : "Sistema"}
                          </span>
                        )}

                        {/* Actions */}
                        {!isEditing && (
                          <div className="flex items-center gap-0.5">
                            {isStatus && (
                              <button onClick={() => openOptEditor(col)} className="p-1.5 rounded-lg text-muted-foreground hover:text-primary hover:bg-primary/10 transition-all" title="Editar opciones del estado">
                                <SlidersHorizontal className="w-3.5 h-3.5" />
                              </button>
                            )}
                            {col.type === "formula" && (
                              <button onClick={() => openFxEditor(col)} className="p-1.5 rounded-lg text-muted-foreground hover:text-primary hover:bg-primary/10 transition-all" title={`Editar fórmula: ${col.formula || "(vacía)"}`}>
                                <FunctionSquare className="w-3.5 h-3.5" />
                              </button>
                            )}
                            {col.custom ? (
                              <button onClick={() => startEdit(col)} className="p-1.5 rounded-lg text-muted-foreground hover:text-foreground hover:bg-secondary transition-all" title="Renombrar">
                                <Pencil className="w-3.5 h-3.5" />
                              </button>
                            ) : (
                              <span className="p-1.5 text-muted-foreground/30" title="Columna del sistema (nombre y tipo fijos)"><Lock className="w-3.5 h-3.5" /></span>
                            )}
                            <button
                              onClick={() => toggleVisibility(col.key)}
                              className={`p-1.5 rounded-lg transition-all ${isHidden ? "text-muted-foreground hover:text-foreground hover:bg-secondary" : "text-primary hover:bg-primary/10"}`}
                              title={isHidden ? "Mostrar" : "Ocultar"}
                            >
                              {isHidden ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                            </button>
                            <button onClick={() => removeColumn(col)} className="p-1.5 rounded-lg text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-all" title="Quitar">
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            {/* Footer */}
            <div className="px-6 py-4 border-t border-border flex justify-between items-center">
              <div className="text-[10px] font-bold text-muted-foreground uppercase tracking-widest">
                {cols.length} columnas · {visibleCount} visibles · {hidden.length} ocultas
              </div>
              <div className="flex gap-2">
                <button onClick={onClose} className="px-5 py-2 rounded-lg text-[11px] font-black uppercase tracking-widest text-muted-foreground hover:bg-secondary transition-all">Cancelar</button>
                <button
                  onClick={handleSave}
                  disabled={saving || loading}
                  className="px-6 py-2 bg-primary text-black rounded-lg text-[11px] font-black uppercase tracking-widest shadow-lg shadow-primary/20 hover:opacity-90 transition-all flex items-center gap-2 disabled:opacity-50"
                >
                  {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
                  Guardar
                </button>
              </div>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
};
