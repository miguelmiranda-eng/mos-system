import { useState, useEffect, useCallback } from "react";
import { History } from "lucide-react";
import { useLang } from "../../contexts/LanguageContext";
import { fetcher, logLoadError } from "./lib";

export const MovementsModule = () => {
  const { t } = useLang();
  const [movements, setMovements] = useState([]);
  const [typeFilter, setTypeFilter] = useState('');
  const load = useCallback(() => { fetcher(`/movements?movement_type=${typeFilter}`).then(setMovements).catch(logLoadError('data')); }, [typeFilter]);
  useEffect(() => { load(); }, [load]);
  const types = ['', 'receiving', 'putaway', 'allocation', 'deallocate', 'pick_ticket_created', 'pick_confirmed', 'production_move', 'shipment'];
  const typeLabels = {
    'receiving': t('wms_mv_receiving'),
    'putaway': t('wms_mv_putaway'),
    'allocation': t('wms_mv_allocation'),
    'deallocate': t('wms_mv_deallocate'),
    'pick_ticket_created': t('wms_mv_pick_ticket_created'),
    'pick_confirmed': t('wms_mv_pick_confirmed'),
    'production_move': t('wms_mv_production_move'),
    'shipment': t('wms_mv_shipment')
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="text-xs font-black uppercase tracking-widest text-muted-foreground bg-secondary/50 px-3 py-1 rounded-full border border-border/40 flex items-center gap-2">
          <div className="w-1.5 h-1.5 rounded-full bg-slate-400" />
          {t('wms_audit_log')}
        </div>
        <div className="flex gap-1.5 flex-wrap p-1 bg-secondary/30 rounded-xl border border-border/10">
          {types.map(type => (
            <button
              key={type}
              onClick={() => setTypeFilter(type)}
              className={`px-3 py-1.5 rounded-lg text-[10px] font-black uppercase tracking-wider transition-all
                ${typeFilter === type ? 'bg-primary text-black shadow-lg shadow-primary/20' : 'text-muted-foreground hover:bg-secondary/60 hover:text-foreground'}`}
            >
              {type ? (typeLabels[type] || type) : t('all')}
            </button>
          ))}
        </div>
      </div>

      <div className="space-y-3 bg-card/60 backdrop-blur-sm border border-border/20 rounded-3xl p-6 shadow-2xl max-h-[600px] overflow-auto custom-scrollbar">
        {movements.map((m, i) => {
          const typeColors = {
            'receiving': 'text-blue-400 bg-blue-500/10 border-blue-500/20',
            'putaway': 'text-purple-400 bg-purple-500/10 border-purple-500/20',
            'allocation': 'text-orange-400 bg-orange-500/10 border-orange-500/20',
            'pick_confirmed': 'text-emerald-400 bg-emerald-500/10 border-emerald-500/20',
            'shipment': 'text-rose-400 bg-rose-500/10 border-rose-500/20'
          };

          return (
            <div key={m.movement_id || i} className="flex items-center justify-between py-3 border-b border-border/10 last:border-0 group hover:translate-x-1 transition-transform">
              <div className="flex items-center gap-4 min-w-0">
                <div className={`w-10 h-10 rounded-xl border flex items-center justify-center flex-shrink-0 transition-colors ${typeColors[m.type] || 'bg-secondary/50 text-muted-foreground border-border/10'}`}>
                  <History className="w-5 h-5" />
                </div>
                <div className="min-w-0">
                  <div className="text-sm font-black text-foreground mb-0.5 flex items-center gap-2">
                    <span className="text-primary font-mono">{m.box_id}</span>
                    <span className="uppercase tracking-tighter text-[10px] opacity-40">{t('wms_moved_to_label')}</span>
                    <span className="text-emerald-400 font-mono italic">{m.to_loc || '-'}</span>
                  </div>
                  <div className="text-[10px] font-bold text-muted-foreground uppercase tracking-widest flex items-center gap-2">
                    {typeLabels[m.type] || m.type?.replace('_', ' ')}
                    <span className="w-1 h-1 rounded-full bg-border" />
                    {t('by_label')}: {m.user_name || m.user || t('wms_mv_system')}
                  </div>
                </div>
              </div>
              <div className="text-right flex-shrink-0">
                <div className="text-xs font-black text-foreground tabular-nums opacity-60">
                  {new Date(m.created_at).toLocaleDateString()}
                </div>
                <div className="text-[10px] font-bold text-muted-foreground opacity-40 uppercase">
                  {new Date(m.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })}
                </div>
              </div>
            </div>
          );
        })}
        {movements.length === 0 && (
          <div className="flex flex-col items-center justify-center py-20 text-muted-foreground opacity-50">
            <History className="w-16 h-16 mb-4 stroke-[1px]" />
            <p className="font-bold uppercase tracking-widest text-sm italic">{t('wms_no_movements')}</p>
          </div>
        )}
      </div>
    </div>
  );
};
