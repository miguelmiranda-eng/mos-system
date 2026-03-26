import { useState, useEffect } from "react";
import { useLang } from "../../contexts/LanguageContext";
import { Settings, X, Plus, Loader2, Pencil, Check } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "../ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";
import { toast } from "sonner";
import { API, getStatusColor } from "../../lib/constants";

export const OptionsManagerModal = ({ isOpen, onClose, options, onOptionsUpdate, onColorsUpdate }) => {
  const { t } = useLang();
  const [selectedOption, setSelectedOption] = useState('priorities');
  const [values, setValues] = useState([]);
  const [newValue, setNewValue] = useState('');
  const [newColor, setNewColor] = useState('#3d85c6');
  const [customColors, setCustomColors] = useState({});
  const [descriptions, setDescriptions] = useState({});
  const [editingColor, setEditingColor] = useState(null);
  const [editingLabel, setEditingLabel] = useState(null);
  const [nameDraft, setNameDraft] = useState('');
  const [descDraft, setDescDraft] = useState('');
  const [loading, setLoading] = useState(false);

  const OPTION_LABELS = {
    'priorities': t('priorities_label'), 'clients': t('clients_label'), 'brandings': 'Brandings',
    'blank_sources': 'Blank Sources', 'blank_statuses': 'Blank Statuses', 'production_statuses': 'Production Statuses',
    'trim_statuses': 'Trim Statuses', 'trim_boxes': 'Trim Boxes', 'samples': 'Samples',
    'artwork_statuses': 'Artwork Statuses', 'betty_columns': 'Betty Columns', 'shippings': 'Shippings'
  };

  const PRESET_COLORS = ['#990000','#cf0000','#ff0000','#cc0000','#b44253','#e69138','#f1c232','#38761d','#20124d','#674ea7','#3d85c6','#6fa8dc','#b4a7d6','#e066cc','#999999','#16c79a','#25a18e','#004e64','#1a1a2e','#000000'];

  useEffect(() => { if (options[selectedOption]) setValues([...options[selectedOption]]); }, [selectedOption, options]);
  useEffect(() => { if (isOpen) { fetchCustomColors(); fetchDescriptions(); } }, [isOpen]); // eslint-disable-line react-hooks/exhaustive-deps

  const fetchCustomColors = async () => {
    try { const res = await fetch(`${API}/config/colors`, { credentials: 'include' }); if (res.ok) setCustomColors(await res.json()); } catch { /* defaults */ }
  };
  const fetchDescriptions = async () => {
    try { const res = await fetch(`${API}/config/descriptions`, { credentials: 'include' }); if (res.ok) setDescriptions(await res.json()); } catch { /* defaults */ }
  };

  const getColor = (val) => customColors[val] || getStatusColor(val) || { bg: '#666', text: '#fff' };

  const handleSave = async () => {
    setLoading(true);
    try {
      const res = await fetch(`${API}/config/options`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, credentials: 'include', body: JSON.stringify({ option_key: selectedOption, values }) });
      await fetch(`${API}/config/colors`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, credentials: 'include', body: JSON.stringify(customColors) });
      await fetch(`${API}/config/descriptions`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, credentials: 'include', body: JSON.stringify(descriptions) });
      if (res.ok) { toast.success(t('options_saved')); onOptionsUpdate(); if (onColorsUpdate) onColorsUpdate(customColors); }
    } catch { toast.error(t('options_save_err')); } finally { setLoading(false); }
  };

  const handleSetColor = (val, color) => {
    setCustomColors(prev => ({ ...prev, [val]: { bg: color, text: isLightColor(color) ? '#000000' : '#FFFFFF' } }));
  };

  const isLightColor = (hex) => {
    const r = parseInt(hex.slice(1, 3), 16), g = parseInt(hex.slice(3, 5), 16), b = parseInt(hex.slice(5, 7), 16);
    return (r * 299 + g * 587 + b * 114) / 1000 > 128;
  };

  const saveLabel = (oldVal) => {
    const newName = nameDraft.trim();
    const newDesc = descDraft.trim();
    if (!newName) return;
    if (newName !== oldVal) {
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
    setNameDraft('');
    setDescDraft('');
  };

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="max-w-[95vw] md:max-w-2xl max-h-[85vh] bg-card border-border overflow-hidden flex flex-col" data-testid="options-manager-modal">
        <DialogHeader>
          <DialogTitle className="font-barlow text-xl uppercase tracking-wide flex items-center gap-2"><Settings className="w-5 h-5" /> {t('options_title')}</DialogTitle>
        </DialogHeader>
        <div className="flex-1 overflow-y-auto py-4 space-y-4">
          <Select value={selectedOption} onValueChange={(v) => { setSelectedOption(v); setEditingColor(null); setEditingDesc(null); }}>
            <SelectTrigger className="bg-secondary border-border" data-testid="option-category-select"><SelectValue /></SelectTrigger>
            <SelectContent className="bg-popover border-border z-[300]">{Object.entries(OPTION_LABELS).map(([key, label]) => <SelectItem key={key} value={key}>{label}</SelectItem>)}</SelectContent>
          </Select>

          {/* Labels list */}
          <div className="space-y-1.5 p-3 bg-secondary/30 rounded border border-border min-h-[100px] max-h-[300px] overflow-y-auto">
            {values.map((val, idx) => {
              const color = getColor(val);
              const desc = descriptions[val] || '';
              return (
                <div key={idx} className="flex items-center gap-2 group" data-testid={`option-value-${val}`}>
                  <button onClick={() => { setEditingColor(editingColor === val ? null : val); setEditingLabel(null); }}
                    className={`w-7 h-7 rounded border-2 transition-all cursor-pointer flex-shrink-0 ${editingColor === val ? 'border-primary ring-2 ring-primary/30' : 'border-white/20 hover:border-white/50'}`}
                    style={{ backgroundColor: color.bg }} title={t('change_color')} data-testid={`color-swatch-${val}`} />
                  <div className="flex-1 min-w-0">
                    <span className="px-2.5 py-1 rounded text-sm font-medium inline-block" style={{ backgroundColor: color.bg, color: color.text }}>{val}</span>
                    {desc && editingLabel !== val && <span className="text-[11px] text-muted-foreground ml-2 truncate">{desc}</span>}
                  </div>
                  <button onClick={() => { setEditingLabel(editingLabel === val ? null : val); setEditingColor(null); setNameDraft(val); setDescDraft(descriptions[val] || ''); }}
                    className={`transition-opacity p-1 rounded hover:bg-secondary ${editingLabel === val ? 'opacity-100 text-primary' : 'opacity-0 group-hover:opacity-100'}`}
                    title="Editar etiqueta" data-testid={`edit-label-${val}`}>
                    <Pencil className="w-3.5 h-3.5" />
                  </button>
                  <button onClick={() => { setValues(values.filter(v => v !== val)); setEditingColor(null); setEditingLabel(null); }}
                    className="opacity-0 group-hover:opacity-100 transition-opacity hover:text-destructive" data-testid={`delete-option-${val}`}><X className="w-4 h-4" /></button>
                </div>
              );
            })}
          </div>

          {/* Color picker - rendered OUTSIDE the scrollable list */}
          {editingColor && (
            <div className="p-3 bg-secondary/50 rounded-lg border border-primary/30" data-testid={`color-picker-${editingColor}`}>
              <div className="flex items-center gap-2 mb-2">
                <span className="text-xs uppercase tracking-wider text-muted-foreground font-medium">Color:</span>
                <span className="px-2 py-0.5 rounded text-sm font-medium" style={{ backgroundColor: getColor(editingColor).bg, color: getColor(editingColor).text }}>{editingColor}</span>
              </div>
              <div className="grid grid-cols-10 gap-1.5 mb-2">
                {PRESET_COLORS.map(c => (
                  <button key={c} onClick={() => handleSetColor(editingColor, c)}
                    className={`w-7 h-7 rounded border transition-transform hover:scale-110 ${getColor(editingColor).bg === c ? 'border-primary ring-2 ring-primary/40 scale-110' : 'border-white/10'}`}
                    style={{ backgroundColor: c }} data-testid={`preset-color-${c}`} />
                ))}
              </div>
              <div className="flex items-center gap-2">
                <input type="color" value={getColor(editingColor).bg} onChange={(e) => handleSetColor(editingColor, e.target.value)} className="w-8 h-8 rounded cursor-pointer border-0" data-testid="custom-color-input" />
                <span className="text-xs text-muted-foreground">Color personalizado</span>
                <button onClick={() => setEditingColor(null)} className="ml-auto text-xs text-primary hover:underline">Cerrar</button>
              </div>
            </div>
          )}

          {/* Label editor (name + description) - rendered OUTSIDE the scrollable list */}
          {editingLabel && (
            <div className="p-3 bg-secondary/50 rounded-lg border border-primary/30" data-testid={`label-editor-${editingLabel}`}>
              <div className="flex items-center gap-2 mb-3">
                <span className="text-xs uppercase tracking-wider text-muted-foreground font-medium">Editar etiqueta:</span>
                <span className="px-2 py-0.5 rounded text-sm font-medium" style={{ backgroundColor: getColor(editingLabel).bg, color: getColor(editingLabel).text }}>{editingLabel}</span>
              </div>
              <div className="space-y-2">
                <div>
                  <label className="text-[11px] text-muted-foreground mb-1 block">Nombre</label>
                  <input type="text" value={nameDraft} onChange={(e) => setNameDraft(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') saveLabel(editingLabel); if (e.key === 'Escape') { setEditingLabel(null); } }}
                    className="w-full bg-secondary border border-border rounded px-3 py-1.5 text-sm text-foreground font-medium" autoFocus data-testid="label-name-input" />
                </div>
                <div>
                  <label className="text-[11px] text-muted-foreground mb-1 block">Descripcion</label>
                  <input type="text" value={descDraft} onChange={(e) => setDescDraft(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') saveLabel(editingLabel); if (e.key === 'Escape') { setEditingLabel(null); } }}
                    placeholder="Descripcion opcional..."
                    className="w-full bg-secondary border border-border rounded px-3 py-1.5 text-sm text-foreground" data-testid="label-desc-input" />
                </div>
                <div className="flex justify-end gap-2 pt-1">
                  <button onClick={() => { setEditingLabel(null); }} className="px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground">Cancelar</button>
                  <button onClick={() => saveLabel(editingLabel)} disabled={!nameDraft.trim() || (nameDraft.trim() !== editingLabel && values.includes(nameDraft.trim()))}
                    className="px-4 py-1.5 bg-primary text-primary-foreground rounded text-sm hover:bg-primary/90 disabled:opacity-50 flex items-center gap-1" data-testid="save-label-btn">
                    <Check className="w-3.5 h-3.5" /> Guardar
                  </button>
                </div>
                {nameDraft.trim() !== editingLabel && values.includes(nameDraft.trim()) && (
                  <p className="text-xs text-destructive">Ya existe una etiqueta con ese nombre</p>
                )}
              </div>
            </div>
          )}

          {/* Add new value */}
          <div className="flex gap-2">
            <button onClick={() => { const input = document.getElementById('new-color-input'); if (input) input.click(); }} className="w-10 h-10 rounded border border-border flex-shrink-0 cursor-pointer" style={{ backgroundColor: newColor }} title={t('color_for_new')} />
            <input id="new-color-input" type="color" value={newColor} onChange={(e) => setNewColor(e.target.value)} className="hidden" />
            <input type="text" value={newValue} onChange={(e) => setNewValue(e.target.value)} onKeyDown={(e) => {
              if (e.key === 'Enter' && newValue.trim() && !values.includes(newValue.trim())) { const val = newValue.trim(); setValues([...values, val]); handleSetColor(val, newColor); setNewValue(''); }
            }} placeholder={t('add_new_value')} className="flex-1 bg-secondary border border-border rounded px-3 py-2 text-sm text-foreground" data-testid="add-option-value-input" />
            <button onClick={() => { if (newValue.trim() && !values.includes(newValue.trim())) { const val = newValue.trim(); setValues([...values, val]); handleSetColor(val, newColor); setNewValue(''); }}} className="px-4 py-2 bg-secondary border border-border rounded hover:bg-secondary/80" data-testid="add-option-value-btn"><Plus className="w-4 h-4" /></button>
          </div>
        </div>
        <div className="flex justify-end gap-3 pt-4 border-t border-border">
          <button onClick={onClose} className="px-4 py-2 text-muted-foreground hover:text-foreground">{t('cancel')}</button>
          <button onClick={handleSave} disabled={loading} className="px-6 py-2 bg-primary text-primary-foreground rounded hover:bg-primary/90 disabled:opacity-50 flex items-center gap-2" data-testid="save-options-btn">{loading && <Loader2 className="w-4 h-4 animate-spin" />} {t('save')}</button>
        </div>
      </DialogContent>
    </Dialog>
  );
};
