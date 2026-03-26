import { useState, useEffect, useMemo } from "react";
import { useLang } from "../../contexts/LanguageContext";
import { Zap, Plus, Edit2, Trash2, X, Loader2 } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "../ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";
import { toast } from "sonner";
import { API, BOARDS } from "../../lib/constants";

export const AutomationsModal = ({ isOpen, onClose, options, columns = [], dynamicBoards = [] }) => {
  const { t } = useLang();
  const [automations, setAutomations] = useState([]);
  const [editingRule, setEditingRule] = useState(null);
  const [loading, setLoading] = useState(false);

  const activeBoards = dynamicBoards.length > 0 ? dynamicBoards : BOARDS;

  useEffect(() => { if (isOpen) fetchAutomations(); }, [isOpen]); // eslint-disable-line react-hooks/exhaustive-deps

  const fetchAutomations = async () => {
    try { const res = await fetch(`${API}/automations`, { credentials: 'include' }); if (res.ok) setAutomations(await res.json()); } catch (error) { console.error("Error:", error); }
  };

  // Build dynamic field lists from columns
  const { WATCH_FIELDS, CONDITION_FIELDS, ACTION_FIELDS } = useMemo(() => {
    const statusTypes = ['select', 'checkbox'];
    const selectFields = columns
      .filter(col => statusTypes.includes(col.type) && col.key !== 'board')
      .map(col => ({
        key: col.key,
        label: col.label,
        type: col.type,
        options: col.optionKey ? (options[col.optionKey] || col.statusOptions?.map(s => s.value) || []) : (col.statusOptions?.map(s => s.value) || (col.type === 'checkbox' ? ['true', 'false'] : []))
      }));

    const dateFields = columns
      .filter(col => col.type === 'date')
      .map(col => ({ key: col.key, label: col.label, type: 'date', options: ['date_updated'] }));

    const textFields = columns
      .filter(col => col.type === 'text' && col.key !== 'order_number' && col.key !== 'board')
      .map(col => ({ key: col.key, label: col.label, type: 'text', options: ['is_empty', 'not_empty'] }));

    const allWatchFields = [...selectFields, ...dateFields, ...textFields].filter(f => f.options.length > 0);

    const conditionFields = [
      { key: 'board', label: 'Tablero', options: activeBoards },
      ...selectFields.filter(f => f.options.length > 0)
    ];
    const actionFields = selectFields.filter(f => f.options.length > 0);

    return { WATCH_FIELDS: allWatchFields, CONDITION_FIELDS: conditionFields, ACTION_FIELDS: actionFields };
  }, [columns, options, activeBoards]);

  const handleSave = async () => {
    if (!editingRule) return;
    setLoading(true);
    try {
      const method = editingRule.automation_id ? 'PUT' : 'POST';
      const url = editingRule.automation_id ? `${API}/automations/${editingRule.automation_id}` : `${API}/automations`;
      const conditions = { ...editingRule.trigger_conditions };
      if (editingRule._watch_field && editingRule._watch_value) {
        conditions.watch_field = editingRule._watch_field;
        conditions.watch_value = editingRule._watch_value;
      } else {
        delete conditions.watch_field;
        delete conditions.watch_value;
      }
      const payload = { ...editingRule, trigger_type: 'status_change', trigger_conditions: conditions, boards: editingRule.boards || [] };
      delete payload._watch_field;
      delete payload._watch_value;
      const res = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, credentials: 'include', body: JSON.stringify(payload) });
      if (res.ok) { fetchAutomations(); setEditingRule(null); toast.success(editingRule.automation_id ? t('rule_updated') : t('rule_created')); }
    } catch { toast.error(t('rule_save_err')); } finally { setLoading(false); }
  };

  const handleDelete = async (id) => {
    if (!window.confirm(t('del_rule_confirm'))) return;
    try { await fetch(`${API}/automations/${id}`, { method: 'DELETE', credentials: 'include' }); fetchAutomations(); toast.success(t('rule_del_ok')); } catch { toast.error(t('rule_del_err')); }
  };

  const newRule = () => ({ name: t('new_rule'), is_active: true, trigger_type: 'status_change', trigger_conditions: {}, action_type: 'move_board', action_params: {}, _watch_field: '', _watch_value: '', boards: [] });

  const startEditing = (rule) => {
    const conds = { ...(rule.trigger_conditions || {}) };
    const wf = conds.watch_field || '';
    const wv = conds.watch_value || '';
    delete conds.watch_field;
    delete conds.watch_value;
    setEditingRule({ ...rule, trigger_conditions: conds, _watch_field: wf, _watch_value: wv, boards: rule.boards || [] });
  };

  const conditions = editingRule?.trigger_conditions || {};
  const updateCondition = (field, value) => {
    const newConds = { ...conditions };
    if (!value || value === 'any') { delete newConds[field]; } else { newConds[field] = value; }
    setEditingRule({ ...editingRule, trigger_conditions: newConds });
  };
  const conditionEntries = Object.entries(conditions).filter(([_, v]) => v);
  const watchFieldDef = WATCH_FIELDS.find(f => f.key === editingRule?._watch_field);

  const buildSummary = () => {
    if (!editingRule) return '';
    let parts = [];
    const ruleBoards = editingRule.boards || [];
    if (ruleBoards.length > 0) {
      parts.push(`en tablero(s) [${ruleBoards.join(', ')}]`);
    }
    if (editingRule._watch_field && editingRule._watch_value) {
      const label = WATCH_FIELDS.find(f => f.key === editingRule._watch_field)?.label || editingRule._watch_field;
      const valLabel = editingRule._watch_value === 'date_updated' ? 'se actualice la fecha' : editingRule._watch_value === 'is_empty' ? 'este vacia' : editingRule._watch_value === 'not_empty' ? 'NO este vacia' : `"${editingRule._watch_value}"`;
      parts.push(`"${label}" ${valLabel}`);
    } else {
      parts.push('cualquier estado cambie');
    }
    if (conditionEntries.length > 0) {
      parts.push(conditionEntries.map(([f, v]) => `${CONDITION_FIELDS.find(c => c.key === f)?.label || f} sea "${v}"`).join(' y '));
    }
    let action = '';
    if (editingRule.action_type === 'move_board') action = `mover a ${editingRule.action_params?.target_board || '...'}`;
    else if (editingRule.action_type === 'assign_field') action = `asignar ${editingRule.action_params?.field || '...'} = ${editingRule.action_params?.value || '...'}`;
    else if (editingRule.action_type === 'send_email') action = `enviar email a ${editingRule.action_params?.to_email || '...'}`;
    else action = 'notificar Slack';
    return `Cuando ${parts.join(' y ')}, entonces ${action}.`;
  };

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="max-w-[95vw] md:max-w-4xl max-h-[85vh] bg-card border-border overflow-hidden flex flex-col" data-testid="automations-modal">
        <DialogHeader>
          <DialogTitle className="font-barlow text-xl uppercase tracking-wide flex items-center gap-2"><Zap className="w-5 h-5" /> {t('automations')}</DialogTitle>
        </DialogHeader>
        {editingRule ? (
          <div className="flex-1 overflow-y-auto py-4 space-y-5">
            {/* Board scope */}
            <div className="space-y-2 bg-orange-500/5 border border-orange-500/20 rounded-lg p-4">
              <label className="text-xs uppercase tracking-wide text-orange-400 font-bold">Tableros donde aplica esta regla</label>
              <div className="flex flex-wrap gap-2">
                {activeBoards.map(board => {
                  const selected = (editingRule.boards || []).includes(board);
                  return (
                    <button key={board} type="button"
                      onClick={() => {
                        const current = editingRule.boards || [];
                        const next = selected ? current.filter(b => b !== board) : [...current, board];
                        setEditingRule({ ...editingRule, boards: next });
                      }}
                      className={`px-2.5 py-1 rounded text-xs font-medium transition-all ${selected ? 'bg-primary text-primary-foreground' : 'bg-secondary border border-border text-muted-foreground hover:text-foreground hover:border-primary/50'}`}
                      data-testid={`board-scope-${board}`}>
                      {board}
                    </button>
                  );
                })}
              </div>
              <p className="text-[10px] text-muted-foreground">
                {(editingRule.boards || []).length === 0
                  ? 'Sin seleccion = aplica en TODOS los tableros.'
                  : `Activa en ${editingRule.boards.length} tablero(s). Solo se ejecutara para ordenes en estos tableros.`}
              </p>
            </div>

            {/* Name + Active */}
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <label className="text-xs uppercase tracking-wide text-muted-foreground font-bold">{t('rule_name')}</label>
                <input type="text" value={editingRule.name} onChange={(e) => setEditingRule({ ...editingRule, name: e.target.value })} className="w-full bg-secondary border border-border rounded px-3 py-2 text-sm text-foreground" data-testid="rule-name-input" />
              </div>
              <div className="space-y-2">
                <label className="text-xs uppercase tracking-wide text-muted-foreground font-bold">{t('active')}</label>
                <Select value={editingRule.is_active ? 'true' : 'false'} onValueChange={(v) => setEditingRule({ ...editingRule, is_active: v === 'true' })}>
                  <SelectTrigger className="bg-secondary border-border"><SelectValue /></SelectTrigger>
                  <SelectContent className="bg-popover border-border z-[300]"><SelectItem value="true">{t('yes')}</SelectItem><SelectItem value="false">{t('no')}</SelectItem></SelectContent>
                </Select>
              </div>
            </div>

            {/* Step 1: Watch Field */}
            <div className="space-y-2 bg-primary/5 border border-primary/20 rounded-lg p-4">
              <label className="text-xs uppercase tracking-wide text-primary font-bold">1. Cuando esta columna cambie a este valor... <span className="text-muted-foreground font-normal">(opcional)</span></label>
              <div className="grid grid-cols-2 gap-3">
                <Select value={editingRule._watch_field || 'any'} onValueChange={(v) => setEditingRule({ ...editingRule, _watch_field: v === 'any' ? '' : v, _watch_value: '' })}>
                  <SelectTrigger className="bg-secondary border-border" data-testid="watch-field-select"><SelectValue placeholder="Cualquier columna" /></SelectTrigger>
                  <SelectContent className="bg-popover border-border z-[300] max-h-[250px]">
                    <SelectItem value="any">Cualquier columna</SelectItem>
                    {WATCH_FIELDS.map(f => <SelectItem key={f.key} value={f.key}>{f.label}</SelectItem>)}
                  </SelectContent>
                </Select>
                {editingRule._watch_field ? (
                  <Select value={editingRule._watch_value || 'any'} onValueChange={(v) => setEditingRule({ ...editingRule, _watch_value: v === 'any' ? '' : v })}>
                    <SelectTrigger className="bg-secondary border-border" data-testid="watch-value-select"><SelectValue placeholder="Cualquier valor" /></SelectTrigger>
                    <SelectContent className="bg-popover border-border z-[300] max-h-[250px]">
                      <SelectItem value="any">Cualquier valor</SelectItem>
                      {(watchFieldDef?.options || []).map(opt => <SelectItem key={opt} value={opt}>{opt === 'date_updated' ? 'Cuando se actualice la fecha' : opt === 'is_empty' ? 'Celda vacia' : opt === 'not_empty' ? 'Celda NO vacia' : opt}</SelectItem>)}
                    </SelectContent>
                  </Select>
                ) : (
                  <div className="h-10 bg-secondary/50 border border-border rounded flex items-center px-3 text-sm text-muted-foreground">Selecciona columna primero</div>
                )}
              </div>
              <p className="text-[10px] text-muted-foreground">Si no seleccionas columna/valor, la regla se activara con cualquier cambio de estado.</p>
            </div>

            {/* Step 2: Additional Conditions */}
            <div className="space-y-2">
              <label className="text-xs uppercase tracking-wide text-muted-foreground font-bold">2. Condiciones adicionales <span className="text-muted-foreground font-normal">(opcional)</span></label>
              <div className="bg-secondary/30 border border-dashed border-border rounded-lg p-3 space-y-2">
                {conditionEntries.length === 0 && (
                  <p className="text-xs text-muted-foreground text-center py-1">Sin condiciones adicionales — la regla aplica a todas las ordenes</p>
                )}
                {conditionEntries.map(([field, value]) => {
                  const fieldDef = CONDITION_FIELDS.find(f => f.key === field);
                  return (
                    <div key={field} className="flex items-center gap-2 bg-secondary/50 rounded p-2" data-testid={`condition-${field}`}>
                      <span className="text-xs font-bold text-primary uppercase w-40">{fieldDef?.label || field}</span>
                      <span className="text-xs text-muted-foreground">=</span>
                      <Select value={value} onValueChange={(v) => updateCondition(field, v)}>
                        <SelectTrigger className="flex-1 bg-secondary border-border h-8 text-sm"><SelectValue /></SelectTrigger>
                        <SelectContent className="bg-popover border-border z-[300] max-h-[250px]">{(fieldDef?.options || []).map(opt => <SelectItem key={opt} value={opt}>{opt}</SelectItem>)}</SelectContent>
                      </Select>
                      <button onClick={() => updateCondition(field, null)} className="p-1 hover:bg-destructive/20 rounded"><X className="w-3 h-3 text-destructive" /></button>
                    </div>
                  );
                })}
                <Select value="" onValueChange={(field) => { if (field) updateCondition(field, CONDITION_FIELDS.find(f => f.key === field)?.options?.[0] || ''); }}>
                  <SelectTrigger className="w-full border-dashed border-border bg-transparent text-muted-foreground h-8 text-sm" data-testid="add-condition-btn"><SelectValue placeholder="+ Agregar condicion (opcional)" /></SelectTrigger>
                  <SelectContent className="bg-popover border-border z-[300]">{CONDITION_FIELDS.filter(f => !conditions[f.key]).map(f => <SelectItem key={f.key} value={f.key}>{f.label}</SelectItem>)}</SelectContent>
                </Select>
              </div>
            </div>

            {/* Step 3: Action */}
            <div className="space-y-3">
              <label className="text-xs uppercase tracking-wide text-muted-foreground font-bold">3. {t('then_do')}</label>
              <Select value={editingRule.action_type} onValueChange={(v) => setEditingRule({ ...editingRule, action_type: v, action_params: {} })}>
                <SelectTrigger className="bg-secondary border-border" data-testid="action-type-select"><SelectValue /></SelectTrigger>
                <SelectContent className="bg-popover border-border z-[300]">
                  <SelectItem value="move_board">{t('move_to_board_action')}</SelectItem>
                  <SelectItem value="assign_field">{t('assign_field')}</SelectItem>
                  <SelectItem value="send_email">{t('send_email')}</SelectItem>
                  <SelectItem value="notify_slack">{t('notify_slack')}</SelectItem>
                </SelectContent>
              </Select>
              {editingRule.action_type === 'move_board' && (
                <Select value={editingRule.action_params?.target_board || 'none'} onValueChange={(v) => setEditingRule({ ...editingRule, action_params: { target_board: v === 'none' ? '' : v } })}>
                  <SelectTrigger className="bg-secondary border-border" data-testid="action-target-board"><SelectValue placeholder={t('select_board')} /></SelectTrigger>
                  <SelectContent className="bg-popover border-border z-[300]"><SelectItem value="none">{t('select_dash')}</SelectItem>{activeBoards.map(b => <SelectItem key={b} value={b}>{b}</SelectItem>)}</SelectContent>
                </Select>
              )}
              {editingRule.action_type === 'assign_field' && (
                <div className="grid grid-cols-2 gap-2">
                  <Select value={editingRule.action_params?.field || 'none'} onValueChange={(v) => setEditingRule({ ...editingRule, action_params: { ...editingRule.action_params, field: v === 'none' ? '' : v, value: '' } })}>
                    <SelectTrigger className="bg-secondary border-border"><SelectValue placeholder={t('col_placeholder')} /></SelectTrigger>
                    <SelectContent className="bg-popover border-border z-[300]"><SelectItem value="none">{t('column_dash')}</SelectItem>{ACTION_FIELDS.map(f => <SelectItem key={f.key} value={f.key}>{f.label}</SelectItem>)}</SelectContent>
                  </Select>
                  {editingRule.action_params?.field && (
                    <Select value={editingRule.action_params?.value || 'none'} onValueChange={(v) => setEditingRule({ ...editingRule, action_params: { ...editingRule.action_params, value: v === 'none' ? '' : v } })}>
                      <SelectTrigger className="bg-secondary border-border"><SelectValue placeholder={t('val_placeholder')} /></SelectTrigger>
                      <SelectContent className="bg-popover border-border z-[300]"><SelectItem value="none">{t('value_dash')}</SelectItem>{(ACTION_FIELDS.find(f => f.key === editingRule.action_params.field)?.options || []).map(opt => <SelectItem key={opt} value={opt}>{opt}</SelectItem>)}</SelectContent>
                    </Select>
                  )}
                </div>
              )}
              {editingRule.action_type === 'send_email' && (
                <input type="email" value={editingRule.action_params?.to_email || ''} onChange={(e) => setEditingRule({ ...editingRule, action_params: { ...editingRule.action_params, to_email: e.target.value } })} placeholder={t('email_placeholder')} className="w-full bg-secondary border border-border rounded px-3 py-2 text-sm text-foreground" />
              )}
            </div>

            {/* Summary */}
            <div className="bg-primary/10 border border-primary/30 rounded-lg p-3 text-sm">
              <span className="font-bold text-primary">Resumen:</span> {buildSummary()}
            </div>

            {/* Actions */}
            <div className="flex justify-end gap-3 pt-4">
              <button onClick={() => setEditingRule(null)} className="px-4 py-2 text-muted-foreground hover:text-foreground">Cancelar</button>
              <button onClick={handleSave} disabled={loading} className="px-6 py-2 bg-primary text-primary-foreground rounded hover:bg-primary/90 disabled:opacity-50 flex items-center gap-2" data-testid="save-rule-btn">{loading && <Loader2 className="w-4 h-4 animate-spin" />} Guardar</button>
            </div>
          </div>
        ) : (
          <div className="flex-1 overflow-y-auto py-4">
            <table className="w-full text-sm">
              <thead><tr className="border-b border-border">
                <th className="text-left py-2 px-3 font-barlow uppercase text-xs text-muted-foreground">Nombre</th>
                <th className="text-left py-2 px-3 font-barlow uppercase text-xs text-muted-foreground">Tableros</th>
                <th className="text-left py-2 px-3 font-barlow uppercase text-xs text-muted-foreground">Activa</th>
                <th className="text-left py-2 px-3 font-barlow uppercase text-xs text-muted-foreground">Columna/Valor</th>
                <th className="text-left py-2 px-3 font-barlow uppercase text-xs text-muted-foreground">Condiciones</th>
                <th className="text-left py-2 px-3 font-barlow uppercase text-xs text-muted-foreground">Entonces</th>
                <th className="text-right py-2 px-3"></th>
              </tr></thead>
              <tbody>{automations.map(auto => {
                const conds = auto.trigger_conditions || {};
                const wf = conds.watch_field;
                const wv = conds.watch_value;
                const otherConds = Object.entries(conds).filter(([k, v]) => v && k !== 'watch_field' && k !== 'watch_value');
                return (
                  <tr key={auto.automation_id} className="border-b border-border/50 hover:bg-secondary/30" data-testid={`automation-row-${auto.automation_id}`}>
                    <td className="py-2 px-3 text-foreground font-medium">{auto.name}</td>
                    <td className="py-2 px-3 text-xs">{(auto.boards || []).length > 0 ? auto.boards.map(b => <span key={b} className="inline-block mr-1 mb-0.5 px-1.5 py-0.5 bg-orange-500/15 text-orange-400 rounded text-[10px] font-medium">{b}</span>) : <span className="text-muted-foreground">Todos</span>}</td>
                    <td className="py-2 px-3"><span className={`px-2 py-0.5 rounded text-xs ${auto.is_active ? 'bg-green-500/20 text-green-400' : 'bg-zinc-500/20 text-zinc-400'}`}>{auto.is_active ? 'Si' : 'No'}</span></td>
                    <td className="py-2 px-3 text-xs">{wf && wv ? <span className="px-1.5 py-0.5 bg-primary/15 text-primary rounded text-[10px]">{wf}={wv}</span> : <span className="text-muted-foreground">Cualquiera</span>}</td>
                    <td className="py-2 px-3 text-xs">{otherConds.length > 0 ? otherConds.map(([k, v]) => <span key={k} className="inline-block mr-1 px-1.5 py-0.5 bg-secondary text-muted-foreground rounded text-[10px]">{k}={v}</span>) : <span className="text-muted-foreground">—</span>}</td>
                    <td className="py-2 px-3 text-muted-foreground text-xs">{auto.action_type === 'move_board' ? `→ ${auto.action_params?.target_board || ''}` : auto.action_type === 'assign_field' ? `${auto.action_params?.field}=${auto.action_params?.value}` : auto.action_type}</td>
                    <td className="py-2 px-3 text-right">
                      <button onClick={() => startEditing(auto)} className="p-1 hover:bg-secondary rounded mr-1"><Edit2 className="w-4 h-4 text-muted-foreground hover:text-foreground" /></button>
                      <button onClick={() => handleDelete(auto.automation_id)} className="p-1 hover:bg-secondary rounded"><Trash2 className="w-4 h-4 text-muted-foreground hover:text-destructive" /></button>
                    </td>
                  </tr>
                );
              })}</tbody>
            </table>
            {automations.length === 0 && <p className="text-center text-muted-foreground py-8">Sin automatizaciones</p>}
            <button onClick={() => setEditingRule(newRule())} className="mt-4 w-full py-3 border border-dashed border-border rounded text-muted-foreground hover:text-foreground hover:border-primary/50 transition-colors flex items-center justify-center gap-2" data-testid="new-rule-btn"><Plus className="w-4 h-4" /> Nueva Regla</button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
};
