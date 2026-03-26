import { useState, useEffect, useCallback } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "./ui/dialog";
import { Loader2, TrendingUp, AlertTriangle, CheckCircle2, Minus, Clock, Package } from "lucide-react";
import { useLang } from "../contexts/LanguageContext";
import { toast } from "sonner";

const BACKEND_URL = process.env.REACT_APP_BACKEND_URL;
const API = `${BACKEND_URL}/api`;

const STATUS_CONFIG = {
  idle:   { color: 'bg-gray-500',   text: 'text-gray-400',   labelKey: 'status_idle',       icon: Minus },
  green:  { color: 'bg-green-500',  text: 'text-green-400',  labelKey: 'status_available',   icon: CheckCircle2 },
  yellow: { color: 'bg-yellow-500', text: 'text-yellow-400', labelKey: 'status_loaded',      icon: Clock },
  red:    { color: 'bg-red-500',    text: 'text-red-400',    labelKey: 'status_overloaded',  icon: AlertTriangle },
};

const CapacityPlanModal = ({ isOpen, onClose }) => {
  const { t } = useLang();
  const [machines, setMachines] = useState([]);
  const [totalPiecesSystem, setTotalPiecesSystem] = useState(0);
  const [totalCompleted, setTotalCompleted] = useState(0);
  const [inProduction, setInProduction] = useState(0);
  const [loading, setLoading] = useState(false);

  const fetchPlan = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`${API}/capacity-plan`, { credentials: 'include' });
      if (res.ok) {
        const data = await res.json();
        setMachines(data.machines);
        setTotalPiecesSystem(data.total_pieces_system || 0);
        setTotalCompleted(data.total_completed || 0);
        setInProduction(data.in_production || 0);
      }
    } catch (e) { toast.error(t('capacity_load_error')); }
    finally { setLoading(false); }
  }, [t]);

  useEffect(() => { if (isOpen) fetchPlan(); }, [isOpen, fetchPlan]);

  const activeMachines = machines.filter(m => m.order_count > 0);
  const totalRemaining = machines.reduce((s, m) => s + m.remaining_pieces, 0);
  const overloaded = machines.filter(m => m.load_status === 'red').length;

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="max-w-4xl max-h-[85vh] bg-card border-border overflow-hidden flex flex-col" data-testid="capacity-plan-modal">
        <DialogHeader>
          <DialogTitle className="font-barlow text-xl uppercase tracking-wide flex items-center gap-2">
            <TrendingUp className="w-5 h-5 text-primary" />
            {t('capacity_title')}
          </DialogTitle>
        </DialogHeader>

        {/* Summary cards */}
        <div className="grid grid-cols-6 gap-3 pb-3 border-b border-border">
          <div className="rounded-lg bg-primary/10 border border-primary/20 p-3 text-center">
            <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-bold">{t('total_pieces_system')}</p>
            <p className="text-2xl font-bold text-primary font-mono" data-testid="plan-total-pieces-system">{totalPiecesSystem.toLocaleString()}</p>
          </div>
          <div className="rounded-lg bg-green-500/10 border border-green-500/20 p-3 text-center">
            <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-bold">Completado</p>
            <p className="text-2xl font-bold text-green-400 font-mono" data-testid="plan-total-completed">{totalCompleted.toLocaleString()}</p>
          </div>
          <div className="rounded-lg bg-blue-500/10 border border-blue-500/20 p-3 text-center">
            <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-bold">En Produccion</p>
            <p className="text-2xl font-bold text-blue-400 font-mono" data-testid="plan-in-production">{inProduction.toLocaleString()}</p>
          </div>
          <div className="rounded-lg bg-secondary/50 p-3 text-center">
            <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-bold">{t('active_machines')}</p>
            <p className="text-2xl font-bold text-foreground font-mono" data-testid="plan-active-machines">{activeMachines.length}</p>
          </div>
          <div className="rounded-lg bg-secondary/50 p-3 text-center">
            <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-bold">{t('pending_pieces')}</p>
            <p className="text-2xl font-bold text-foreground font-mono" data-testid="plan-total-remaining">{totalRemaining.toLocaleString()}</p>
          </div>
          <div className="rounded-lg bg-secondary/50 p-3 text-center">
            <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-bold">{t('overloaded')}</p>
            <p className={`text-2xl font-bold font-mono ${overloaded > 0 ? 'text-red-400' : 'text-green-400'}`} data-testid="plan-overloaded">{overloaded}</p>
          </div>
        </div>

        {/* Machine cards */}
        <div className="flex-1 overflow-y-auto py-2">
          {loading ? (
            <div className="flex justify-center py-8"><Loader2 className="w-6 h-6 animate-spin" /></div>
          ) : (
            <div className="grid grid-cols-2 gap-3">
              {machines.map(m => {
                const config = STATUS_CONFIG[m.load_status] || STATUS_CONFIG.idle;
                const Icon = config.icon;
                return (
                  <div key={m.machine} className="rounded-lg border border-border bg-secondary/30 p-3" data-testid={`plan-machine-${m.machine}`}>
                    <div className="flex items-center justify-between mb-2">
                      <span className="font-barlow font-bold text-sm text-foreground">{m.machine}</span>
                      <span className={`flex items-center gap-1 text-xs font-bold ${config.text}`}>
                        <Icon className="w-3.5 h-3.5" />
                        {t(config.labelKey)}
                      </span>
                    </div>

                    {/* Capacity bar */}
                    <div className="w-full h-2 bg-secondary rounded-full overflow-hidden mb-2">
                      <div
                        className={`h-full rounded-full transition-all ${config.color}`}
                        style={{ width: `${m.load_status === 'idle' ? 0 : m.load_status === 'green' ? 33 : m.load_status === 'yellow' ? 66 : 100}%` }}
                        data-testid={`plan-bar-${m.machine}`}
                      />
                    </div>

                    <div className="grid grid-cols-3 gap-2 text-[11px]">
                      <div>
                        <span className="text-muted-foreground block">{t('avg_per_day')}</span>
                        <span className="font-mono font-bold text-foreground">{m.avg_daily_production} {t('pieces')}</span>
                      </div>
                      <div>
                        <span className="text-muted-foreground block">{t('pending')}</span>
                        <span className="font-mono font-bold text-foreground">{m.remaining_pieces.toLocaleString()} {t('pieces')}</span>
                      </div>
                      <div>
                        <span className="text-muted-foreground block">{t('est_days')}</span>
                        <span className={`font-mono font-bold ${config.text}`}>{m.estimated_days || '—'}</span>
                      </div>
                    </div>

                    {/* Orders in progress - POs */}
                    {m.orders_in_progress.length > 0 && (
                      <div className="mt-2 pt-2 border-t border-border/50">
                        <span className="text-[10px] uppercase text-muted-foreground font-bold flex items-center gap-1">
                          <Package className="w-3 h-3" /> POs en maquina ({m.orders_in_progress.length})
                        </span>
                        <div className="mt-1 space-y-1">
                          {m.orders_in_progress.map(o => (
                            <div key={o.order_id} className="flex items-center justify-between text-[10px] py-0.5">
                              <div className="flex items-center gap-1.5 min-w-0">
                                <span className="font-bold text-primary truncate" data-testid={`po-${o.order_number}`}>{o.order_number || o.order_id.slice(-8)}</span>
                                {o.client && <span className="text-muted-foreground truncate hidden sm:inline">- {o.client}</span>}
                              </div>
                              <div className="flex items-center gap-1 flex-shrink-0">
                                <span className="text-green-400 font-mono">{(o.produced || 0).toLocaleString()}</span>
                                <span className="text-muted-foreground">/</span>
                                <span className="text-foreground font-mono">{(o.total || 0).toLocaleString()}</span>
                                <span className="text-muted-foreground mx-0.5">|</span>
                                <span className={`font-mono font-bold ${o.remaining > 0 ? 'text-orange-400' : 'text-green-400'}`}>{(o.remaining || 0).toLocaleString()} pend.</span>
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
};

export default CapacityPlanModal;
