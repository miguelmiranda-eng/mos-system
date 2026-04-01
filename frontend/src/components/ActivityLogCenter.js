import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { 
  History, Filter, X, Loader2, Undo2, Search, ArrowLeft, 
  Download, Calendar, RefreshCw
} from 'lucide-react';
import { API, ACTION_COLORS, getActionLabels, formatDetails } from '../lib/constants';
import { useLang } from '../contexts/LanguageContext';
import { toast } from 'sonner';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";

const ActivityLogCenter = () => {
  const navigate = useNavigate();
  const { t } = useLang();
  const actionLabels = getActionLabels(t);
  
  const [logs, setLogs] = useState([]);
  const [loading, setLoading] = useState(false);
  const [total, setTotal] = useState(0);
  const [actionFilter, setActionFilter] = useState('all');
  const [undoingId, setUndoingId] = useState(null);
  const [searchTerm, setSearchTerm] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');

  useEffect(() => {
    const handler = setTimeout(() => {
      setDebouncedSearch(searchTerm);
    }, 500);
    return () => clearTimeout(handler);
  }, [searchTerm]);

  const fetchLogs = async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ limit: '200' });
      if (actionFilter !== 'all') params.append('action_filter', actionFilter);
      if (debouncedSearch) params.append('search', debouncedSearch);
      const res = await fetch(`${API}/activity?${params}`, { credentials: 'include' });
      if (res.ok) { 
        const data = await res.json(); 
        setLogs(data.logs); 
        setTotal(data.total); 
      }
    } catch { 
      toast.error(t('error')); 
    } finally { 
      setLoading(false); 
    }
  };

  useEffect(() => {
    fetchLogs();
  }, [actionFilter, debouncedSearch]);

  const handleUndo = async (activityId) => {
    setUndoingId(activityId);
    try {
      const res = await fetch(`${API}/undo/${activityId}`, { method: 'POST', credentials: 'include' });
      if (res.ok) { 
        toast.success(t('undo_success')); 
        fetchLogs(); 
      } else { 
        const err = await res.json(); 
        toast.error(err.detail || t('undo_error')); 
      }
    } catch { 
      toast.error(t('undo_error')); 
    } finally { 
      setUndoingId(null); 
    }
  };

  return (
    <div className="min-h-screen bg-background p-6 md:p-10 font-barlow relative overflow-y-auto">
      {/* Background patterns */}
      <div className="fixed top-0 right-0 w-1/2 h-1/2 bg-primary/5 blur-[120px] rounded-full -translate-y-1/2 translate-x-1/2 pointer-events-none z-0"></div>
      <div className="fixed bottom-0 left-0 w-1/3 h-1/3 bg-blue-500/5 blur-[100px] rounded-full translate-y-1/2 -translate-x-1/3 pointer-events-none z-0"></div>

      <header className="mb-8 relative z-10 flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <button onClick={() => navigate('/home')} className="mb-4 text-muted-foreground hover:text-foreground flex items-center text-sm transition-colors group">
            <ArrowLeft className="w-4 h-4 mr-1 group-hover:-translate-x-1 transition-transform" /> Volver al Home
          </button>
          <div className="flex items-center gap-4">
            <div className="w-12 h-12 bg-primary/20 rounded-xl flex items-center justify-center border border-primary/30 shadow-[0_0_20px_rgba(var(--primary),0.3)]">
              <History className="w-6 h-6 text-primary" />
            </div>
            <div>
              <h1 className="text-3xl font-black uppercase tracking-tighter text-foreground">
                ACTIVITY <span className="text-primary">LOG</span>
              </h1>
              <p className="text-muted-foreground font-medium text-sm">
                Historial detallado de auditoría del sistema. {total} registros encontrados.
              </p>
            </div>
          </div>
        </div>
        
        <div className="flex items-center gap-3">
            <button onClick={fetchLogs} className="p-3 bg-secondary/50 hover:bg-secondary border border-border rounded-xl transition-all">
                <RefreshCw className={`w-5 h-5 text-muted-foreground ${loading ? 'animate-spin' : ''}`} />
            </button>
        </div>
      </header>

      {/* Filters Bar */}
      <div className="relative z-10 bg-card/40 backdrop-blur-xl border border-border/50 rounded-2xl p-4 mb-8 flex flex-col md:flex-row gap-4 items-center">
        <div className="flex items-center gap-2 w-full md:w-auto">
          <Filter className="w-4 h-4 text-muted-foreground" />
          <Select value={actionFilter} onValueChange={setActionFilter}>
            <SelectTrigger className="w-full md:w-64 h-11 bg-secondary/50 border-border" data-testid="activity-filter">
              <SelectValue placeholder="Filtrar por acción" />
            </SelectTrigger>
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
          {actionFilter !== 'all' && (
            <button onClick={() => setActionFilter('all')} className="text-xs text-primary hover:underline flex items-center gap-1 whitespace-nowrap">
              <X className="w-3 h-3" /> Limpiar
            </button>
          )}
        </div>

        <div className="relative w-full md:flex-1">
          <Search className="absolute left-4 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <input 
            type="text" 
            placeholder="Buscar por orden (#943), usuario, cambios..." 
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="w-full pl-12 pr-10 h-11 bg-secondary/50 border border-border rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-primary/50 transition-all text-foreground"
          />
          {searchTerm && (
            <button onClick={() => setSearchTerm('')} className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground">
              <X className="w-4 h-4"/>
            </button>
          )}
        </div>
      </div>

      {/* Main Content: Logs Table */}
      <div className="relative z-10 bg-card/40 backdrop-blur-xl border border-border/50 rounded-2xl overflow-hidden shadow-2xl">
        <div className="overflow-x-auto">
          {loading && logs.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-24 gap-4">
              <Loader2 className="w-10 h-10 animate-spin text-primary" />
              <p className="text-muted-foreground animate-pulse font-bold uppercase tracking-widest text-xs">Sincronizando registros de auditoría...</p>
            </div>
          ) : logs.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-24 gap-4 opacity-50">
              <History className="w-16 h-16 text-muted-foreground" />
              <p className="text-muted-foreground font-bold uppercase tracking-widest text-sm">No se encontraron registros de actividad</p>
            </div>
          ) : (
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-border/50 bg-secondary/20">
                  <th className="py-4 px-6 font-black uppercase text-[10px] tracking-[0.2em] text-muted-foreground w-48 italic">
                    <div className="flex items-center gap-2"><Calendar className="w-3 h-3" /> Fecha y Hora</div>
                  </th>
                  <th className="py-4 px-6 font-black uppercase text-[10px] tracking-[0.2em] text-muted-foreground w-40 italic">Usuario</th>
                  <th className="py-4 px-6 font-black uppercase text-[10px] tracking-[0.2em] text-muted-foreground w-48 italic">Acción</th>
                  <th className="py-4 px-6 font-black uppercase text-[10px] tracking-[0.2em] text-muted-foreground italic">Detalles del Cambio</th>
                  <th className="py-4 px-6 font-black uppercase text-[10px] tracking-[0.2em] text-muted-foreground w-24 text-right italic">Undo</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/30">
                {logs.map(log => (
                  <tr key={log.activity_id} className={`group hover:bg-primary/5 transition-all duration-300 ${log.undone ? 'opacity-40 grayscale-[0.5]' : ''}`}>
                    <td className="py-4 px-6 text-muted-foreground text-[11px] font-mono whitespace-nowrap" suppressHydrationWarning>
                      {new Date(log.timestamp).toLocaleString()}
                    </td>
                    <td className="py-4 px-6">
                      <div className="flex items-center gap-2">
                        <div className="w-7 h-7 rounded-full bg-secondary flex items-center justify-center text-[10px] font-black text-muted-foreground uppercase border border-border/30">
                          {(log.user_name || log.user_email || '?')[0].toUpperCase()}
                        </div>
                        <span className="text-foreground text-xs font-bold">{log.user_name || log.user_email}</span>
                      </div>
                    </td>
                    <td className="py-4 px-6">
                      <span className={`px-3 py-1 rounded-full text-[10px] font-black uppercase tracking-wider shadow-sm border border-black/10 ${ACTION_COLORS[log.action] || 'bg-secondary text-muted-foreground'}`}>
                        {actionLabels[log.action] || log.action}
                      </span>
                    </td>
                    <td className="py-4 px-6">
                      <div className="text-foreground text-sm flex items-center font-medium">
                        {log.undone && <span className="text-primary italic font-black text-[10px] mr-2 flex items-center gap-1 uppercase tracking-tighter bg-primary/10 px-1.5 py-0.5 rounded border border-primary/20 animation-pulse"><Undo2 className="w-2.5 h-2.5" /> [DESHECHO]</span>}
                        <span className="truncate max-w-xl" title={formatDetails(log.action, log.details, actionLabels)}>
                          {formatDetails(log.action, log.details, actionLabels)}
                        </span>
                      </div>
                    </td>
                    <td className="py-4 px-6 text-right">
                      {log.undoable && !log.undone && log.action !== 'undo_action' && (
                        <button 
                          onClick={() => handleUndo(log.activity_id)} 
                          disabled={undoingId === log.activity_id} 
                          className="p-2.5 rounded-xl bg-secondary/50 hover:bg-primary/20 text-muted-foreground hover:text-primary transition-all disabled:opacity-50 border border-transparent hover:border-primary/30 active:scale-95 group-hover:shadow-[0_0_10px_rgba(220,38,38,0.2)]"
                          title="Deshacer esta acción"
                        >
                          {undoingId === log.activity_id ? <Loader2 className="w-4 h-4 animate-spin" /> : <Undo2 className="w-4 h-4" />}
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
      
      <footer className="mt-12 text-center">
        <p className="text-[10px] font-black uppercase tracking-[0.4em] text-muted-foreground opacity-30">Auditoría Industrial de Alta Fidelidad - MOS v5.4.2</p>
      </footer>
    </div>
  );
};

export default ActivityLogCenter;
