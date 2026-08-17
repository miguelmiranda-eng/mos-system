import { useState, useEffect, useCallback, useRef } from "react";
import { Dialog, DialogPortal, DialogOverlay, DialogHeader, DialogTitle } from "./ui/dialog";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";
import { Loader2, Trash2, ClipboardList, Scissors, Search, CheckCircle2 } from "lucide-react";
import { useLang } from "../contexts/LanguageContext";
import { toast } from "sonner";
import { API } from "../lib/constants";

const SHIFTS = ['TURNO 1', 'TURNO 2'];

const getSuggestedShift = () => {
  const now = new Date();
  const hour = now.getHours();
  const day = now.getDay();
  if (hour >= 7 && hour < 19) return 'TURNO 1';
  if (hour >= 19 && day >= 1 && day <= 4) return 'TURNO 2';
  if (hour < 7 && day >= 2 && day <= 5) return 'TURNO 2';
  return '';
};

// Captura Neck — versión minimalista de ProductionModal: solo cantidad +
// operador + turno. Estación fija "CORTE NECK" (no se muestra en el form,
// el backend la rellena). Logs van a la colección neck_logs.
const NeckCaptureModal = ({ isOpen, onClose, orders, onNeckUpdate, isAdmin }) => {
  const { t } = useLang();
  const [orderSearch, setOrderSearch] = useState('');
  const [matchedOrder, setMatchedOrder] = useState(null);
  const [quantity, setQuantity] = useState('');
  const [operator, setOperator] = useState('');
  const [shift, setShift] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [logs, setLogs] = useState([]);
  const [totalNeckCut, setTotalNeckCut] = useState(0);
  const [logsLoading, setLogsLoading] = useState(false);
  const [operatorsList, setOperatorsList] = useState([]);
  const searchRef = useRef(null);

  useEffect(() => {
    if (isOpen) {
      // Solo la lista de NECK. Sin el filtro salían los 30 operadores del
      // catálogo — máquinas, ejemplos y pinturas incluidos. Si la lista queda
      // vacía, el campo de abajo cae solo al input de texto libre, así que la
      // captura nunca se traba.
      fetch(`${API}/operators?role=neck`, { credentials: 'include' })
        .then(r => r.ok ? r.json() : [])
        .then(data => setOperatorsList(data.filter(op => op.active)))
        .catch(() => {});

      const suggested = getSuggestedShift();
      if (suggested) setShift(suggested);
    }
  }, [isOpen]);

  const remaining = matchedOrder ? Math.max(0, (matchedOrder.quantity || 0) - totalNeckCut) : 0;
  const progress = matchedOrder && matchedOrder.quantity > 0
    ? Math.min(100, (totalNeckCut / matchedOrder.quantity) * 100)
    : 0;

  useEffect(() => {
    if (!orderSearch.trim()) { setMatchedOrder(null); setLogs([]); setTotalNeckCut(0); return; }
    if (!orders || !Array.isArray(orders)) return;
    const found = orders.find(o =>
      o.order_number &&
      String(o.order_number).trim().toLowerCase() === orderSearch.trim().toLowerCase() &&
      o.board !== 'PAPELERA DE RECICLAJE'
    );
    setMatchedOrder(found || null);
  }, [orderSearch, orders]);

  const fetchLogs = useCallback(async (orderId) => {
    if (!orderId) { setLogs([]); setTotalNeckCut(0); return; }
    setLogsLoading(true);
    try {
      const res = await fetch(`${API}/neck-logs/${orderId}`, { credentials: 'include' });
      if (res.ok) {
        const data = await res.json();
        setLogs(data.logs);
        setTotalNeckCut(data.total_neck_cut);
      }
    } catch { /* */ } finally { setLogsLoading(false); }
  }, []);

  useEffect(() => {
    if (matchedOrder) fetchLogs(matchedOrder.order_id);
    else { setLogs([]); setTotalNeckCut(0); }
  }, [matchedOrder, fetchLogs]);

  useEffect(() => {
    if (!isOpen) {
      setOrderSearch(''); setMatchedOrder(null); setQuantity('');
      setLogs([]); setTotalNeckCut(0); setOperator(''); setShift('');
    } else {
      setTimeout(() => searchRef.current?.focus(), 100);
    }
  }, [isOpen]);

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!matchedOrder || !quantity) { toast.error(t('complete_fields')); return; }

    setSubmitting(true);
    try {
      const res = await fetch(`${API}/neck-logs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          order_id: matchedOrder.order_id,
          quantity_neck_cut: parseInt(quantity),
          operator,
          shift,
        }),
      });
      if (res.ok) {
        toast.success(`Neck registrado: ${quantity} pz`);
        setQuantity('');
        fetchLogs(matchedOrder.order_id);
        if (onNeckUpdate) onNeckUpdate();
      } else {
        const err = await res.json();
        toast.error(err.detail || 'Error al registrar neck');
      }
    } catch {
      toast.error('Error al registrar neck');
    } finally { setSubmitting(false); }
  };

  const handleDeleteLog = async (logId) => {
    try {
      const res = await fetch(`${API}/neck-logs/${logId}`, {
        method: 'DELETE', credentials: 'include',
      });
      if (res.ok) {
        toast.success(t('record_deleted'));
        fetchLogs(matchedOrder?.order_id);
        if (onNeckUpdate) onNeckUpdate();
      } else { toast.error(t('error')); }
    } catch { toast.error(t('error')); }
  };

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogPortal>
        <DialogOverlay className="backdrop-blur-sm bg-black/20" />
        <DialogPrimitive.Content
          className="fixed left-[50%] top-[50%] z-[901] w-full max-w-3xl max-h-[90vh] translate-x-[-50%] translate-y-[-50%] transform-gpu bg-card border border-border overflow-hidden flex flex-col shadow-2xl sm:rounded-2xl data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95"
          data-testid="neck-capture-modal"
        >
          <DialogHeader>
            <DialogTitle className="font-barlow text-xl uppercase tracking-wide flex items-center gap-2">
              <Scissors className="w-5 h-5 text-pink-500" /> Captura Neck
            </DialogTitle>
          </DialogHeader>

          <form onSubmit={handleSubmit} className="space-y-3 pb-4 border-b border-border">
            {/* Order search */}
            <div>
              <label className="text-xs uppercase tracking-wider font-bold text-muted-foreground mb-1 block">
                {t('order_po')}
              </label>
              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                <input
                  ref={searchRef}
                  type="text"
                  value={orderSearch}
                  onChange={(e) => setOrderSearch(e.target.value)}
                  placeholder={t('order_search_placeholder')}
                  className={`w-full h-9 pl-9 pr-3 text-sm bg-secondary border rounded text-foreground ${matchedOrder ? 'border-green-500' : orderSearch.trim() ? 'border-red-500/50' : 'border-border'}`}
                  data-testid="neck-order-input"
                />
                {matchedOrder && <CheckCircle2 className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-green-500" />}
              </div>
              {orderSearch.trim() && !matchedOrder && (
                <p className="text-xs text-red-400 mt-1">{t('order_not_found')}</p>
              )}
            </div>

            {matchedOrder && (
              <div className="grid grid-cols-3 gap-3">
                <div>
                  <label className="text-[10px] uppercase tracking-wider font-bold text-muted-foreground">{t('client')}</label>
                  <div className="h-8 px-3 flex items-center text-sm bg-secondary/60 border border-border rounded text-foreground">{matchedOrder.client || '-'}</div>
                </div>
                <div>
                  <label className="text-[10px] uppercase tracking-wider font-bold text-muted-foreground">{t('total_quantity')}</label>
                  <div className="h-8 px-3 flex items-center text-sm bg-secondary/60 border border-border rounded font-mono font-bold">{matchedOrder.quantity || 0} pz</div>
                </div>
                <div>
                  <label className="text-[10px] uppercase tracking-wider font-bold text-muted-foreground">Restante (neck)</label>
                  <div className="h-8 px-3 flex items-center text-sm bg-secondary/60 border border-border rounded font-mono font-bold">
                    {remaining} pz
                    <span className={`ml-2 text-xs ${progress >= 100 ? 'text-green-400' : 'text-muted-foreground'}`}>
                      ({progress.toFixed(0)}%)
                    </span>
                  </div>
                </div>
              </div>
            )}

            {matchedOrder && (
              <div className="w-full h-2 bg-secondary rounded-full overflow-hidden">
                <div
                  className={`h-full rounded-full transition-all ${progress >= 100 ? 'bg-green-500' : progress >= 50 ? 'bg-yellow-500' : 'bg-pink-500'}`}
                  style={{ width: `${Math.min(progress, 100)}%` }}
                />
              </div>
            )}

            {/* Cantidad / operador / turno */}
            <div className="grid grid-cols-3 gap-3">
              <div>
                <label className="text-[10px] uppercase tracking-wider font-bold text-muted-foreground">Cantidad (pz)</label>
                <input
                  type="number"
                  value={quantity}
                  onChange={(e) => setQuantity(e.target.value)}
                  min="1"
                  className="w-full h-8 px-3 text-sm bg-secondary border border-border rounded text-foreground"
                  data-testid="neck-quantity-input"
                />
              </div>
              <div>
                <label className="text-[10px] uppercase tracking-wider font-bold text-muted-foreground">Operador</label>
                {operatorsList.length > 0 ? (
                  <Select value={operator} onValueChange={setOperator}>
                    <SelectTrigger className="h-8 text-sm bg-secondary border-border" data-testid="neck-operator-select">
                      <SelectValue placeholder="Seleccionar operador" />
                    </SelectTrigger>
                    <SelectContent className="bg-popover border-border z-[1001]">
                      {operatorsList.map(op => (
                        <SelectItem key={op.operator_id} value={op.name}>{op.name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                ) : (
                  <input
                    type="text"
                    value={operator}
                    onChange={(e) => setOperator(e.target.value)}
                    placeholder="Nombre operador"
                    className="w-full h-8 px-3 text-sm bg-secondary border border-border rounded text-foreground"
                  />
                )}
              </div>
              <div>
                <label className="text-[10px] uppercase tracking-wider font-bold text-muted-foreground">Turno</label>
                <Select value={shift} onValueChange={setShift}>
                  <SelectTrigger className="h-8 text-sm bg-secondary border-border" data-testid="neck-shift-select">
                    <SelectValue placeholder="Turno" />
                  </SelectTrigger>
                  <SelectContent className="bg-popover border-border z-[1001]">
                    {SHIFTS.map(s => <SelectItem key={s} value={s}>{s}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="flex justify-end pt-2">
              <button
                type="submit"
                disabled={submitting || !matchedOrder || !quantity}
                className="flex items-center gap-2 px-4 py-2 bg-pink-500 hover:bg-pink-400 text-white font-bold text-xs uppercase tracking-widest rounded-lg disabled:opacity-50 transition-all"
                data-testid="neck-submit"
              >
                {submitting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Scissors className="w-4 h-4" />}
                Registrar neck
              </button>
            </div>
          </form>

          {/* History */}
          <div className="flex-1 overflow-y-auto pt-3">
            <h3 className="text-xs uppercase tracking-wider font-bold text-muted-foreground mb-2 flex items-center gap-1">
              <ClipboardList className="w-3.5 h-3.5" /> Historial Neck {matchedOrder ? `— ${matchedOrder.order_number}` : ''}
            </h3>
            {logsLoading ? (
              <div className="flex justify-center py-4"><Loader2 className="w-5 h-5 animate-spin" /></div>
            ) : logs.length > 0 ? (
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border">
                    <th className="text-left py-1 px-2 text-[10px] text-muted-foreground font-bold">{t('date_time')}</th>
                    <th className="text-left py-1 px-2 text-[10px] text-muted-foreground font-bold">Operador</th>
                    <th className="text-right py-1 px-2 text-[10px] text-muted-foreground font-bold">Cant.</th>
                    <th className="text-left py-1 px-2 text-[10px] text-muted-foreground font-bold">Turno</th>
                    {isAdmin && <th className="w-6"></th>}
                  </tr>
                </thead>
                <tbody>
                  {logs.map(log => (
                    <tr key={log.log_id} className="border-b border-border/50 hover:bg-secondary/30" data-testid={`neck-log-${log.log_id}`}>
                      <td className="py-1 px-2 text-[11px] text-muted-foreground">{new Date(log.created_at).toLocaleString()}</td>
                      <td className="py-1 px-2 text-[11px] text-foreground">{log.operator || log.user_name}</td>
                      <td className="py-1 px-2 text-[11px] text-right font-mono font-bold">{log.quantity_neck_cut}</td>
                      <td className="py-1 px-2 text-[11px] text-muted-foreground">{log.shift || '-'}</td>
                      {isAdmin && (
                        <td className="py-1 px-1">
                          <button onClick={() => handleDeleteLog(log.log_id)} className="p-0.5 rounded hover:bg-destructive/20">
                            <Trash2 className="w-3 h-3 text-destructive" />
                          </button>
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : matchedOrder ? (
              <p className="text-center text-muted-foreground text-sm py-4">Sin capturas de neck para esta orden</p>
            ) : (
              <p className="text-center text-muted-foreground text-sm py-4">{t('select_order_history')}</p>
            )}
          </div>
        </DialogPrimitive.Content>
      </DialogPortal>
    </Dialog>
  );
};

export default NeckCaptureModal;
