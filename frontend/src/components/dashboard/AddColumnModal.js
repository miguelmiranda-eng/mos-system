import { useState } from "react";
import { useLang } from "../../contexts/LanguageContext";
import { X, Plus } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "../ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";
import { toast } from "sonner";

export const AddColumnModal = ({ isOpen, onClose, onAdd, existingColumns }) => {
  const { t } = useLang();
  const [columnName, setColumnName] = useState('');
  const [columnType, setColumnType] = useState('text');
  const [formula, setFormula] = useState('');
  const [statusOptions, setStatusOptions] = useState([]);
  const [newStatusVal, setNewStatusVal] = useState('');
  const [newStatusColor, setNewStatusColor] = useState('#3d85c6');

  const handleAdd = () => {
    if (!columnName.trim()) return;
    const key = columnName.toLowerCase().replace(/\s+/g, '_');
    if (existingColumns.some(c => c.key === key)) { toast.error(t('col_exists')); return; }
    const colDef = { key, label: columnName, type: columnType, width: 150, custom: true };
    if (columnType === 'formula') colDef.formula = formula;
    if (columnType === 'estado') { colDef.type = 'select'; colDef.statusOptions = statusOptions; colDef.optionKey = `custom_${key}`; }
    onAdd(colDef);
    setColumnName(''); setColumnType('text'); setFormula(''); setStatusOptions([]);
    onClose();
    toast.success(t('col_added'));
  };

  const PRESET_COLORS = ['#3d85c6','#cf0000','#38761d','#f1c232','#674ea7','#e066cc','#e69138','#b44253','#20124d','#999999'];

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="max-w-lg bg-card border-border" data-testid="add-column-modal">
        <DialogHeader>
          <DialogTitle className="font-barlow text-xl uppercase tracking-wide">{t('add_new_column')}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 mt-4">
          <div className="space-y-2">
            <label className="text-xs uppercase tracking-wide text-muted-foreground font-bold">{t('name')}</label>
            <input type="text" value={columnName} onChange={(e) => setColumnName(e.target.value)} placeholder={t('column_name_placeholder')} className="w-full bg-secondary border border-border rounded px-3 py-2 text-sm text-foreground" data-testid="column-name-input" />
          </div>
          <div className="space-y-2">
            <label className="text-xs uppercase tracking-wide text-muted-foreground font-bold">{t('column_type')}</label>
            <Select value={columnType} onValueChange={setColumnType}>
              <SelectTrigger className="bg-secondary border-border" data-testid="column-type-select"><SelectValue /></SelectTrigger>
              <SelectContent className="bg-popover border-border z-[300]">
                <SelectItem value="text">{t('text')}</SelectItem>
                <SelectItem value="number">{t('number')}</SelectItem>
                <SelectItem value="date">{t('date')}</SelectItem>
                <SelectItem value="link">{t('link')}</SelectItem>
                <SelectItem value="checkbox">{t('checkbox')}</SelectItem>
                <SelectItem value="estado">{t('status_with_colors')}</SelectItem>
                <SelectItem value="formula">{t('formula_condition')}</SelectItem>
              </SelectContent>
            </Select>
          </div>
          {columnType === 'formula' && (
            <div className="space-y-2 p-3 bg-secondary/30 rounded border border-border">
              <label className="text-xs uppercase tracking-wide text-muted-foreground font-bold">{t('formula')}</label>
              <input type="text" value={formula} onChange={(e) => setFormula(e.target.value)} placeholder={t('formula_placeholder')} className="w-full bg-secondary border border-border rounded px-3 py-2 text-sm text-foreground font-mono" data-testid="formula-input" />
              <p className="text-xs text-muted-foreground">{t('formula_help')}</p>
            </div>
          )}
          {columnType === 'estado' && (
            <div className="space-y-2 p-3 bg-secondary/30 rounded border border-border">
              <label className="text-xs uppercase tracking-wide text-muted-foreground font-bold">{t('status_options_label')}</label>
              <div className="space-y-1 max-h-32 overflow-y-auto">
                {statusOptions.map((opt, i) => (
                  <div key={i} className="flex items-center gap-2">
                    <span className="w-5 h-5 rounded" style={{ backgroundColor: opt.color }}></span>
                    <span className="text-sm px-2 py-0.5 rounded flex-1" style={{ backgroundColor: opt.color, color: '#fff' }}>{opt.value}</span>
                    <button onClick={() => setStatusOptions(statusOptions.filter((_, j) => j !== i))} className="hover:text-destructive"><X className="w-3 h-3" /></button>
                  </div>
                ))}
              </div>
              <div className="flex gap-2">
                <button onClick={() => { const ci = document.getElementById('new-status-color'); if (ci) ci.click(); }} className="w-8 h-8 rounded border border-border flex-shrink-0" style={{ backgroundColor: newStatusColor }} />
                <input id="new-status-color" type="color" value={newStatusColor} onChange={(e) => setNewStatusColor(e.target.value)} className="hidden" />
                <input type="text" value={newStatusVal} onChange={(e) => setNewStatusVal(e.target.value)} onKeyDown={(e) => {
                  if (e.key === 'Enter' && newStatusVal.trim()) { setStatusOptions([...statusOptions, { value: newStatusVal.trim(), color: newStatusColor }]); setNewStatusVal(''); }
                }} placeholder={t('new_status_placeholder')} className="flex-1 bg-secondary border border-border rounded px-3 py-1.5 text-sm text-foreground" data-testid="status-option-input" />
                <button onClick={() => { if (newStatusVal.trim()) { setStatusOptions([...statusOptions, { value: newStatusVal.trim(), color: newStatusColor }]); setNewStatusVal(''); }}} className="px-3 bg-secondary border border-border rounded hover:bg-secondary/80"><Plus className="w-4 h-4" /></button>
              </div>
            </div>
          )}
        </div>
        <div className="flex justify-end gap-3 mt-6">
          <button onClick={onClose} className="px-4 py-2 text-muted-foreground hover:text-foreground">{t('cancel')}</button>
          <button onClick={handleAdd} disabled={!columnName.trim() || (columnType === 'formula' && !formula.trim()) || (columnType === 'estado' && statusOptions.length === 0)} className="px-6 py-2 bg-primary text-primary-foreground rounded hover:bg-primary/90 disabled:opacity-50" data-testid="add-column-submit">{t('add')}</button>
        </div>
      </DialogContent>
    </Dialog>
  );
};
