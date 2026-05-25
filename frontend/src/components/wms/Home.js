import { useState, useEffect, useCallback } from "react";
import {
  Package, MapPin, ClipboardCheck, ClipboardList, BarChart3,
  Loader2, Plus, Printer, History, ArrowRight,
} from "lucide-react";
import { useLang } from "../../contexts/LanguageContext";
import { fetcher, logLoadError, useWms } from "./lib";

export const HomeModule = ({ onNavigate }) => {
  const { t } = useLang();
  const { badges } = useWms();
  const [summary, setSummary] = useState(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const data = await fetcher('/home/summary');
      setSummary(data);
    } catch (err) { logLoadError('home summary')(err); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  // Re-fetch when any badge changes — picks up real-time updates
  useEffect(() => { load(); }, [badges.putaway, badges.picking, badges.cycle_count, badges.neck_cutting]); // eslint-disable-line react-hooks/exhaustive-deps

  if (loading && !summary) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="w-8 h-8 animate-spin text-primary" />
      </div>
    );
  }

  const s = summary || {};
  const cards = [
    { key: 'units', label: 'Unidades en inventario', value: s.inventory_units?.toLocaleString() || 0, sub: `${s.inventory_skus || 0} SKUs`, icon: Package, color: 'text-blue-400', bg: 'bg-blue-500/10' },
    { key: 'occupancy', label: 'Ocupación ubicaciones', value: `${s.occupancy_pct || 0}%`, sub: `${s.locations_occupied || 0} / ${s.locations_total || 0}`, icon: MapPin, color: 'text-emerald-400', bg: 'bg-emerald-500/10' },
    { key: 'putaway', label: 'Pendientes putaway', value: s.pending_putaway || 0, sub: 'cajas por ubicar', icon: ClipboardCheck, color: 'text-purple-400', bg: 'bg-purple-500/10', target: 'putaway' },
    { key: 'picking', label: 'Pick tickets pending', value: s.pending_picking || 0, sub: 'por procesar', icon: ClipboardList, color: 'text-indigo-400', bg: 'bg-indigo-500/10', target: 'picking' },
    { key: 'counts', label: 'Conteos activos', value: s.active_counts || 0, sub: 'en proceso', icon: BarChart3, color: 'text-lime-400', bg: 'bg-lime-500/10', target: 'cycle_count' },
  ];

  const quickActions = [
    { label: 'Recibir caja', icon: Plus, target: 'receiving', color: 'bg-blue-500' },
    { label: 'Crear pick ticket', icon: ClipboardList, target: 'picking', color: 'bg-indigo-500' },
    { label: 'Imprimir etiquetas', icon: Printer, target: 'locations', color: 'bg-emerald-500' },
  ];

  return (
    <div className="space-y-6">
      {/* KPI Cards */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        {cards.map(c => {
          const Icon = c.icon;
          const Card = c.target ? 'button' : 'div';
          return (
            <Card
              key={c.key}
              onClick={c.target ? () => onNavigate?.(c.target) : undefined}
              className={`border border-border/40 rounded-3xl p-4 bg-card/60 backdrop-blur-sm shadow-xl flex flex-col items-start gap-2 text-left transition-all ${c.target ? 'cursor-pointer hover:scale-[1.02] hover:border-primary/40' : ''}`}
            >
              <div className={`w-10 h-10 rounded-2xl ${c.bg} flex items-center justify-center`}>
                <Icon className={`w-5 h-5 ${c.color}`} />
              </div>
              <div className={`text-2xl font-black tabular-nums tracking-tighter ${c.color}`}>{c.value}</div>
              <div className="text-[10px] text-muted-foreground font-black uppercase tracking-widest opacity-60 leading-tight">{c.label}</div>
              <div className="text-[10px] text-muted-foreground/60 font-bold">{c.sub}</div>
            </Card>
          );
        })}
      </div>

      {/* Quick actions */}
      <div className="bg-card/40 border border-border/20 rounded-2xl p-4">
        <div className="text-[10px] font-black uppercase tracking-widest text-muted-foreground/60 mb-3">Acciones rápidas</div>
        <div className="flex flex-wrap gap-3">
          {quickActions.map(a => {
            const Icon = a.icon;
            return (
              <button
                key={a.label}
                onClick={() => onNavigate?.(a.target)}
                className={`flex items-center gap-2 px-5 py-3 ${a.color} text-white rounded-2xl font-black uppercase tracking-widest text-xs hover:scale-105 active:scale-95 transition-all shadow-lg`}
              >
                <Icon className="w-4 h-4" />
                {a.label}
                <ArrowRight className="w-3 h-3 opacity-60" />
              </button>
            );
          })}
        </div>
      </div>

      {/* Recent activity */}
      <div className="bg-card/60 border border-border/20 rounded-3xl p-6 shadow-2xl">
        <div className="flex items-center gap-2 mb-4">
          <History className="w-4 h-4 text-slate-400" />
          <h3 className="text-[10px] font-black uppercase tracking-widest text-muted-foreground">Actividad reciente</h3>
          <button
            onClick={() => onNavigate?.('movements')}
            className="ml-auto text-[10px] font-bold text-primary hover:underline uppercase tracking-widest"
          >
            Ver todo →
          </button>
        </div>
        {(s.recent_movements || []).length === 0 ? (
          <div className="text-center py-8 text-xs text-muted-foreground/40 font-bold uppercase tracking-widest italic">
            Sin actividad reciente
          </div>
        ) : (
          <div className="space-y-2">
            {(s.recent_movements || []).map(m => (
              <div key={m.movement_id} className="flex items-center justify-between py-2 border-b border-border/10 last:border-0">
                <div className="flex items-center gap-3 min-w-0">
                  <span className="text-[10px] font-black uppercase bg-secondary/60 px-2 py-0.5 rounded text-muted-foreground tracking-widest">
                    {m.type?.replace(/_/g, ' ')}
                  </span>
                  <span className="text-xs font-bold text-foreground/80 truncate">
                    {m.details?.box_id || m.details?.ticket_id || m.details?.order_number || m.details?.receiving_id || '—'}
                  </span>
                  <span className="text-[10px] text-muted-foreground/60 truncate">
                    {m.user_name || 'System'}
                  </span>
                </div>
                <span className="text-[10px] text-muted-foreground/40 font-mono tabular-nums flex-shrink-0">
                  {new Date(m.created_at).toLocaleString([], { month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit' })}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};
