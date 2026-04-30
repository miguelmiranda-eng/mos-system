import { useState, useEffect, useCallback, useRef } from "react";
import { Dialog, DialogPortal, DialogOverlay, DialogHeader, DialogTitle } from "./ui/dialog";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";
import { Loader2, Plus, Trash2, ClipboardList, Factory, Search, CheckCircle2 } from "lucide-react";
import { useLang } from "../contexts/LanguageContext";
import { toast } from "sonner";

import { API } from "../lib/constants";

const MACHINES = Array.from({ length: 14 }, (_, i) => `MAQUINA${i + 1}`);
const SHIFTS = ['TURNO 1', 'TURNO 2', 'TURNO 3'];
const DESIGN_TYPES = ['FRENTE', 'ESPALDA', 'MANGA'];
const SETUP_KEY = 'production_setup_value';

const ProductionModal = ({ isOpen, onClose, orders, onProductionUpdate, isAdmin }) => {
  const { t } = useLang();
  const [orderSearch, setOrderSearch] = useState('');
  const [matchedOrder, setMatchedOrder] = useState(null);
  const [quantity, setQuantity] = useState('');
  const [machine, setMachine] = useState('');
  const [setup, setSetup] = useState(() => localStorage.getItem(SETUP_KEY) || '');
  const [operator, setOperator] = useState('');
  const [shift, setShift] = useState('');
  const [designType, setDesignType] = useState('');
  const [stopCause, setStopCause] = useState('');
  const [supervisor, setSupervisor] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [logs, setLogs] = useState([]);
  const [totalProduced, setTotalProduced] = useState(0);
  const [logsLoading, setLogsLoading] = useState(false);
  const [operatorsList, setOperatorsList] = useState([]);
  const searchRef = useRef(null);

  useEffect(() => {
    if (isOpen) {
      fetch(`${API}/operators`, { credentials: 'include' })
        .then(r => r.ok ? r.json() : [])
        .then(data => setOperatorsList(data.filter(op => op.active)))
        .catch(() => {});
    }
  }, [isOpen]);

  const remaining = matchedOrder ? Math.max(0, (matchedOrder.quantity || 0) - totalProduced) : 0;
  const progress = matchedOrder && matchedOrder.quantity > 0 ? Math.min(100, (totalProduced / matchedOrder.quantity) * 100) : 0;

  useEffect(() => {
    if (!orderSearch.trim()) { setMatchedOrder(null); setLogs([]); setTotalProduced(0); return; }
    if (!orders || !Array.isArray(orders)) return;
    const found = orders.find(o => o.order_number && String(o.order_number).trim().toLowerCase() === orderSearch.trim().toLowerCase() && o.board !== 'PAPELERA DE RECICLAJE');
    setMatchedOrder(found || null);
  }, [orderSearch, orders]);

  const fetchLogs = useCallback(async (orderId) => {
    if (!orderId) { setLogs([]); setTotalProduced(0); return; }
    setLogsLoading(true);
    try {
      const res = await fetch(`${API}/production-logs/${orderId}`, { credentials: 'include' });
      if (res.ok) { const data = await res.json(); setLogs(data.logs); setTotalProduced(data.total_produced); }
    } catch { /* */ } finally { setLogsLoading(false); }
  }, []);

  useEffect(() => { if (matchedOrder) fetchLogs(matchedOrder.order_id); else { setLogs([]); setTotalProduced(0); } }, [matchedOrder, fetchLogs]);
  useEffect(() => { if (!isOpen) { setOrderSearch(''); setMatchedOrder(null); setQuantity(''); setMachine(''); setLogs([]); setTotalProduced(0); setOperator(''); setShift(''); setDesignType(''); setStopCause(''); setSupervisor(''); } else { setTimeout(() => searchRef.current?.focus(), 100); } }, [isOpen]);
  useEffect(() => { if (setup !== '') localStorage.setItem(SETUP_KEY, setup); }, [setup]);

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!matchedOrder || !quantity || !machine) { toast.error(t('complete_fields')); return; }
    setSubmitting(true);
    try {
      const res = await fetch(`${API}/production-logs`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
        body: JSON.stringify({ order_id: matchedOrder.order_id, quantity_produced: parseInt(quantity), machine, setup: parseInt(setup) || 0, operator, shift, design_type: designType, stop_cause: stopCause, supervisor })
      });
      if (res.ok) {
        toast.success(`${t('production_registered')}: ${quantity} ${t('pieces')} ${machine}`);
        setQuantity('');
        fetchLogs(matchedOrder.order_id);
        if (onProductionUpdate) onProductionUpdate();
      } else { const err = await res.json(); toast.error(err.detail || t('production_error')); }
    } catch { toast.error(t('production_error')); } finally { setSubmitting(false); }
  };

  const handleDeleteLog = async (logId) => {
    try {
      const res = await fetch(`${API}/production-logs/${logId}`, { method: 'DELETE', credentials: 'include' });
      if (res.ok) { toast.success(t('record_deleted')); fetchLogs(matchedOrder?.order_id); if (onProductionUpdate) onProductionUpdate(); }
      else toast.error(t('error'));
    } catch { toast.error(t('error')); }
  };

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogPortal>
      <DialogOverlay className="backdrop-blur-sm bg-black/20" />
      <DialogPrimitive.Content className="fixed left-[50%] top-[50%] z-[901] w-full max-w-3xl max-h-[90vh] translate-x-[-50%] translate-y-[-50%] transform-gpu bg-card border border-border overflow-hidden flex flex-col shadow-2xl sm:rounded-2xl data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95" data-testid="production-modal">
        <DialogHeader>
          <DialogTitle className="font-barlow text-xl uppercase tracking-wide flex items-center gap-2">
            <Factory className="w-5 h-5 text-primary" /> {t('production_title')}
          </DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-3 pb-4 border-b border-border">
          {/* Order search */}
          <div>
            <label className="text-xs uppercase tracking-wider font-bold text-muted-foreground mb-1 block">{t('order_po')}</label>
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
              <input ref={searchRef} type="text" value={orderSearch} onChange={(e) => setOrderSearch(e.target.value)} placeholder={t('order_search_placeholder')}
                className={`w-full h-9 pl-9 pr-3 text-sm bg-secondary border rounded text-foreground ${matchedOrder ? 'border-green-500' : orderSearch.trim() ? 'border-red-500/50' : 'border-border'}`} data-testid="production-order-input" />
              {matchedOrder && <CheckCircle2 className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-green-500" />}
            </div>
            {orderSearch.trim() && !matchedOrder && <p className="text-xs text-red-400 mt-1">{t('order_not_found')}</p>}
          </div>
          {matchedOrder && (
            <div className="grid grid-cols-3 gap-3">
              <div><label className="text-[10px] uppercase tracking-wider font-bold text-muted-foreground">{t('client')}</label><div className="h-8 px-3 flex items-center text-sm bg-secondary/60 border border-border rounded text-foreground">{matchedOrder.client || '-'}</div></div>
              <div><label className="text-[10px] uppercase tracking-wider font-bold text-muted-foreground">{t('total_quantity')}</label><div className="h-8 px-3 flex items-center text-sm bg-secondary/60 border border-border rounded font-mono font-bold">{matchedOrder.quantity || 0} pz</div></div>
              <div><label className="text-[10px] uppercase tracking-wider font-bold text-muted-foreground">{t('remaining')}</label><div className="h-8 px-3 flex items-center text-sm bg-secondary/60 border border-border rounded font-mono font-bold">{remaining} pz <span className={`ml-2 text-xs ${progress >= 100 ? 'text-green-400' : 'text-muted-foreground'}`}>({progress.toFixed(0)}%)</span></div></div>
            </div>
          )}
          {matchedOrder && <div className="w-full h-2 bg-secondary rounded-full overflow-hidden"><div className={`h-full rounded-full transition-all ${progress >= 100 ? 'bg-green-500' : progress >= 50 ? 'bg-yellow-500' : 'bg-red-500'}`} style={{ width: `${Math.min(progress, 100)}%` }} /></div>}
          {/* Row 1: quantity, machine, setup */}
          <div className="grid grid-cols-3 gap-3">
            <div><label className="text-[10px] uppercase tracking-wider font-bold text-muted-foreground">{t('quantity_produced')}</label><input type="number" value={quantity} onChange={(e) => setQuantity(e.target.value)} min="1" className="w-full h-8 px-3 text-sm bg-secondary border border-border rounded text-foreground" data-testid="production-quantity-input" /></div>
            <div><label className="text-[10px] uppercase tracking-wider font-bold text-muted-foreground">{t('machine')}</label>
              <Select value={machine} onValueChange={setMachine}><SelectTrigger className="h-8 text-sm bg-secondary border-border" data-testid="production-machine-select"><SelectValue placeholder="Maquina" /></SelectTrigger><SelectContent className="bg-popover border-border z-[1001]">{MACHINES.map(m => <SelectItem key={m} value={m}>{m}</SelectItem>)}</SelectContent></Select>
            </div>
            <div><label className="text-[10px] uppercase tracking-wider font-bold text-muted-foreground">Setup</label><input type="number" value={setup} onChange={(e) => setSetup(e.target.value)} min="0" className="w-full h-8 px-3 text-sm bg-secondary border border-border rounded text-foreground" data-testid="production-setup-input" /></div>
          </div>
          {/* Row 2: operator, shift, design_type */}
          <div className="grid grid-cols-3 gap-3">
            <div><label className="text-[10px] uppercase tracking-wider font-bold text-muted-foreground">Operador</label>
              {operatorsList.length > 0 ? (
                <Select value={operator} onValueChange={setOperator}><SelectTrigger className="h-8 text-sm bg-secondary border-border" data-testid="production-operator-select"><SelectValue placeholder="Seleccionar operador" /></SelectTrigger><SelectContent className="bg-popover border-border z-[1001]">{operatorsList.map(op => <SelectItem key={op.operator_id} value={op.name}>{op.name}</SelectItem>)}</SelectContent></Select>
              ) : (
                <input type="text" value={operator} onChange={(e) => setOperator(e.target.value)} placeholder="Nombre operador" className="w-full h-8 px-3 text-sm bg-secondary border border-border rounded text-foreground" data-testid="production-operator-input" />
              )}
            </div>
            <div><label className="text-[10px] uppercase tracking-wider font-bold text-muted-foreground">Turno</label>
              <Select value={shift} onValueChange={setShift}><SelectTrigger className="h-8 text-sm bg-secondary border-border" data-testid="production-shift-select"><SelectValue placeholder="Turno" /></SelectTrigger><SelectContent className="bg-popover border-border z-[1001]">{SHIFTS.map(s => <SelectItem key={s} value={s}>{s}</SelectItem>)}</SelectContent></Select>
            </div>
            <div><label className="text-[10px] uppercase tracking-wider font-bold text-muted-foreground">Tipo Diseno</label>
              <Select value={designType} onValueChange={setDesignType}><SelectTrigger className="h-8 text-sm bg-secondary border-border" data-testid="production-design-select"><SelectValue placeholder="Tipo" /></SelectTrigger><SelectContent className="bg-popover border-border z-[1001]">{DESIGN_TYPES.map(d => <SelectItem key={d} value={d}>{d}</SelectItem>)}</SelectContent></Select>
            </div>
          </div>
          {/* Row 3: supervisor, stop_cause */}
          <div className="grid grid-cols-2 gap-3">
            <div><label className="text-[10px] uppercase tracking-wider font-bold text-muted-foreground">Supervisor</label><input type="text" value={supervisor} onChange={(e) => setSupervisor(e.target.value)} placeholder="Nombre supervisor" className="w-full h-8 px-3 text-sm bg-secondary border border-border rounded text-foreground" data-testid="production-supervisor-input" /></div>
            <div><label className="text-[10px] uppercase tracking-wider font-bold text-muted-foreground">Causa de Parada</label><input type="text" value={stopCause} onChange={(e) => setStopCause(e.target.value)} placeholder="Opcional" className="w-full h-8 px-3 text-sm bg-secondary border border-border rounded text-foreground" data-testid="production-stop-input" /></div>
          </div>
          <button type="submit" disabled={submitting || !matchedOrder || !quantity || !machine} className="w-full py-2 bg-primary text-primary-foreground rounded text-sm font-bold hover:bg-primary/90 disabled:opacity-50 flex items-center justify-center gap-2" data-testid="production-submit-btn">
            {submitting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />} {t('register_production')}
          </button>
        </form>
        {/* History */}
        <div className="flex-1 overflow-y-auto pt-3">
          <h3 className="text-xs uppercase tracking-wider font-bold text-muted-foreground mb-2 flex items-center gap-1"><ClipboardList className="w-3.5 h-3.5" /> {t('production_history')} {matchedOrder ? `— ${matchedOrder.order_number}` : ''}</h3>
          {logsLoading ? <div className="flex justify-center py-4"><Loader2 className="w-5 h-5 animate-spin" /></div> : logs.length > 0 ? (
            <table className="w-full text-sm">
              <thead><tr className="border-b border-border">
                <th className="text-left py-1 px-2 text-[10px] text-muted-foreground font-bold">{t('date_time')}</th>
                <th className="text-left py-1 px-2 text-[10px] text-muted-foreground font-bold">Operador</th>
                <th className="text-right py-1 px-2 text-[10px] text-muted-foreground font-bold">Cant.</th>
                <th className="text-left py-1 px-2 text-[10px] text-muted-foreground font-bold">{t('machine')}</th>
                <th className="text-left py-1 px-2 text-[10px] text-muted-foreground font-bold">Turno</th>
                <th className="text-left py-1 px-2 text-[10px] text-muted-foreground font-bold">Diseno</th>
                <th className="text-right py-1 px-2 text-[10px] text-muted-foreground font-bold">Setup</th>
                {isAdmin && <th className="w-6"></th>}
              </tr></thead>
              <tbody>{logs.map(log => (
                <tr key={log.log_id} className="border-b border-border/50 hover:bg-secondary/30" data-testid={`production-log-${log.log_id}`}>
                  <td className="py-1 px-2 text-[11px] text-muted-foreground">{new Date(log.created_at).toLocaleString()}</td>
                  <td className="py-1 px-2 text-[11px] text-foreground">{log.operator || log.user_name}</td>
                  <td className="py-1 px-2 text-[11px] text-right font-mono font-bold">{log.quantity_produced}</td>
                  <td className="py-1 px-2 text-[11px]"><span className="px-1 py-0.5 bg-primary/20 text-primary rounded text-[9px] font-bold">{log.machine}</span></td>
                  <td className="py-1 px-2 text-[11px] text-muted-foreground">{log.shift || '-'}</td>
                  <td className="py-1 px-2 text-[11px] text-muted-foreground">{log.design_type || '-'}</td>
                  <td className="py-1 px-2 text-[11px] text-right text-muted-foreground">{log.setup || 0}</td>
                  {isAdmin && <td className="py-1 px-1"><button onClick={() => handleDeleteLog(log.log_id)} className="p-0.5 rounded hover:bg-destructive/20"><Trash2 className="w-3 h-3 text-destructive" /></button></td>}
                </tr>
              ))}</tbody>
            </table>
          ) : matchedOrder ? <p className="text-center text-muted-foreground text-sm py-4">{t('no_production')}</p> : <p className="text-center text-muted-foreground text-sm py-4">{t('select_order_history')}</p>}
        </div>
      </DialogPrimitive.Content>
      </DialogPortal>
    </Dialog>
  );
};
export default ProductionModal;
