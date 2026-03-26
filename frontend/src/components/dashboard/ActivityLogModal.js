import { useState, useEffect } from "react";
import { History, Filter, X, Loader2, Undo2 } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "../ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";
import { toast } from "sonner";
import { API, ACTION_COLORS, getActionLabels, formatDetails } from "../../lib/constants";

export const ActivityLogModal = ({ isOpen, onClose, onUndoSuccess, t }) => {
  const actionLabels = getActionLabels(t);
  const [logs, setLogs] = useState([]);
  const [loading, setLoading] = useState(false);
  const [total, setTotal] = useState(0);
  const [actionFilter, setActionFilter] = useState('all');
  const [undoingId, setUndoingId] = useState(null);

  useEffect(() => { if (isOpen) fetchLogs(); }, [isOpen, actionFilter]);

  const fetchLogs = async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ limit: '200' });
      if (actionFilter !== 'all') params.append('action_filter', actionFilter);
      const res = await fetch(`${API}/activity?${params}`, { credentials: 'include' });
      if (res.ok) { const data = await res.json(); setLogs(data.logs); setTotal(data.total); }
    } catch { toast.error(t('error')); } finally { setLoading(false); }
  };

  const handleUndo = async (activityId) => {
    setUndoingId(activityId);
    try {
      const res = await fetch(`${API}/undo/${activityId}`, { method: 'POST', credentials: 'include' });
      if (res.ok) { toast.success(t('undo_success')); fetchLogs(); if (onUndoSuccess) onUndoSuccess(); }
      else { const err = await res.json(); toast.error(err.detail || t('undo_error')); }
    } catch { toast.error(t('undo_error')); } finally { setUndoingId(null); }
  };

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="max-w-[95vw] md:max-w-5xl max-h-[85vh] bg-card border-border overflow-hidden flex flex-col" data-testid="activity-log-modal">
        <DialogHeader>
          <DialogTitle className="font-barlow text-xl uppercase tracking-wide flex items-center gap-2">
            <History className="w-5 h-5" /> {t('activity_title')} ({total} {t('activity_records')})
          </DialogTitle>
        </DialogHeader>
        <div className="flex items-center gap-2 pb-2 border-b border-border">
          <Filter className="w-4 h-4 text-muted-foreground" />
          <Select value={actionFilter} onValueChange={setActionFilter}>
            <SelectTrigger className="w-48 h-8 text-xs bg-secondary border-border" data-testid="activity-filter"><SelectValue placeholder={t('filter_action_placeholder')} /></SelectTrigger>
            <SelectContent className="bg-popover border-border z-[300]">
              <SelectItem value="all">{t('all_actions')}</SelectItem>
              <SelectItem value="create_order">{t('action_create_order')}</SelectItem>
              <SelectItem value="update_order">{t('action_update_order')}</SelectItem>
              <SelectItem value="move_order">{t('action_move_order')}</SelectItem>
              <SelectItem value="delete_order">{t('action_delete_order')}</SelectItem>
              <SelectItem value="bulk_move_orders">{t('action_bulk_move')}</SelectItem>
              <SelectItem value="undo_action">{t('action_undo')}</SelectItem>
            </SelectContent>
          </Select>
          {actionFilter !== 'all' && <button onClick={() => setActionFilter('all')} className="text-xs text-primary hover:underline flex items-center gap-1"><X className="w-3 h-3" /> {t('clear')}</button>}
        </div>
        <div className="flex-1 overflow-y-auto py-2">
          {loading ? <div className="flex justify-center py-8"><Loader2 className="w-6 h-6 animate-spin" /></div> :
           logs.length === 0 ? <p className="text-center text-muted-foreground py-8">No hay registros</p> : (
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-card z-10"><tr className="border-b border-border">
                <th className="text-left py-2 px-3 font-barlow uppercase text-xs text-muted-foreground w-40">{t('date_time')}</th>
                <th className="text-left py-2 px-3 font-barlow uppercase text-xs text-muted-foreground w-32">{t('user')}</th>
                <th className="text-left py-2 px-3 font-barlow uppercase text-xs text-muted-foreground w-36">{t('action_label')}</th>
                <th className="text-left py-2 px-3 font-barlow uppercase text-xs text-muted-foreground">{t('details')}</th>
                <th className="text-right py-2 px-3 font-barlow uppercase text-xs text-muted-foreground w-24">{t('undo')}</th>
              </tr></thead>
              <tbody>{logs.map(log => (
                <tr key={log.activity_id} className={`border-b border-border/50 hover:bg-secondary/30 ${log.undone ? 'opacity-40' : ''}`} data-testid={`activity-row-${log.activity_id}`}>
                  <td className="py-2 px-3 text-muted-foreground text-xs">{new Date(log.timestamp).toLocaleString()}</td>
                  <td className="py-2 px-3 text-foreground text-xs">{log.user_name || log.user_email}</td>
                  <td className="py-2 px-3"><span className={`px-2 py-0.5 rounded text-xs font-medium ${ACTION_COLORS[log.action] || 'bg-secondary text-muted-foreground'}`}>{actionLabels[log.action] || log.action}</span></td>
                  <td className="py-2 px-3 text-muted-foreground text-xs max-w-sm truncate">{log.undone ? <span className="text-purple-400 italic mr-1">[{t('undone')}]</span> : null}{formatDetails(log.action, log.details, actionLabels)}</td>
                  <td className="py-2 px-3 text-right">{log.undoable && !log.undone && log.action !== 'undo_action' && (
                    <button onClick={() => handleUndo(log.activity_id)} disabled={undoingId === log.activity_id} className="p-1 rounded hover:bg-primary/20 text-primary transition-colors disabled:opacity-50" title={t('undo_this')} data-testid={`undo-btn-${log.activity_id}`}>
                      {undoingId === log.activity_id ? <Loader2 className="w-4 h-4 animate-spin" /> : <Undo2 className="w-4 h-4" />}
                    </button>
                  )}</td>
                </tr>
              ))}</tbody>
            </table>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
};
