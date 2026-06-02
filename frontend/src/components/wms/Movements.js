import { useState, useEffect, useCallback, useMemo } from "react";
import { History, Tag, Search, X, Loader2, User } from "lucide-react";
import { useLang } from "../../contexts/LanguageContext";
import { fetcher, logLoadError } from "./lib";

const TABS = [
  { id: 'movements', label: 'Movimientos', icon: History },
  { id: 'upcs',      label: 'UPCs',        icon: Tag },
];

const MovementsTab = () => {
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
    <div className="space-y-4">
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

const UpcsTab = () => {
  const [upcs, setUpcs] = useState([]);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');
  const [userFilter, setUserFilter] = useState('');

  useEffect(() => {
    const id = setTimeout(() => setDebounced(search.trim()), 300);
    return () => clearTimeout(id);
  }, [search]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ limit: '1000' });
      if (debounced) params.set('search', debounced);
      const data = await fetcher(`/upc?${params.toString()}`);
      setUpcs(Array.isArray(data) ? data : []);
    } catch (err) {
      logLoadError('upcs')(err);
    } finally { setLoading(false); }
  }, [debounced]);

  useEffect(() => { load(); }, [load]);

  // Distinct creators for the user filter dropdown (only meaningful when the
  // current list has multiple authors — single-author imports get just one).
  const creators = useMemo(() => {
    const set = new Set();
    upcs.forEach(u => { if (u.created_by_name) set.add(u.created_by_name); });
    return Array.from(set).sort();
  }, [upcs]);

  const filtered = useMemo(() => {
    if (!userFilter) return upcs;
    return upcs.filter(u => (u.created_by_name || '') === userFilter);
  }, [upcs, userFilter]);

  return (
    <div className="space-y-4">
      {/* Filters */}
      <div className="flex flex-wrap gap-3 items-center">
        <div className="relative flex-1 min-w-[260px]">
          <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Buscar UPC / style / color / customer / brand…"
            className="w-full pl-9 pr-9 py-2 bg-background border border-border rounded-lg text-sm focus:outline-none focus:border-primary/40"
          />
          {search && (
            <button onClick={() => setSearch('')} className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground">
              <X className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
        {creators.length > 1 && (
          <select
            value={userFilter}
            onChange={e => setUserFilter(e.target.value)}
            className="px-3 py-2 bg-background border border-border rounded-lg text-sm font-mono"
          >
            <option value="">Todos los usuarios</option>
            {creators.map(c => <option key={c} value={c}>{c}</option>)}
          </select>
        )}
        <div className="text-[11px] font-mono font-bold text-muted-foreground ml-auto">
          {filtered.length.toLocaleString()} UPCs
          {userFilter && ` · ${userFilter}`}
        </div>
      </div>

      {/* Table */}
      <div className="border border-border/40 rounded-2xl bg-card/40 overflow-hidden">
        <div className="overflow-auto max-h-[600px] custom-scrollbar">
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-secondary/80 backdrop-blur-md border-b border-border/40">
              <tr>
                <th className="p-3 text-left text-[10px] font-black uppercase tracking-widest text-muted-foreground">UPC</th>
                <th className="p-3 text-left text-[10px] font-black uppercase tracking-widest text-muted-foreground">Cliente / Brand</th>
                <th className="p-3 text-left text-[10px] font-black uppercase tracking-widest text-muted-foreground">Style</th>
                <th className="p-3 text-left text-[10px] font-black uppercase tracking-widest text-muted-foreground">Color · Talla</th>
                <th className="p-3 text-left text-[10px] font-black uppercase tracking-widest text-muted-foreground">Descripción</th>
                <th className="p-3 text-left text-[10px] font-black uppercase tracking-widest text-muted-foreground">Creado por</th>
                <th className="p-3 text-left text-[10px] font-black uppercase tracking-widest text-muted-foreground">Fecha</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan={7} className="py-16 text-center text-muted-foreground">
                    <Loader2 className="w-6 h-6 animate-spin mx-auto" />
                  </td>
                </tr>
              ) : filtered.length === 0 ? (
                <tr>
                  <td colSpan={7} className="py-20 text-center">
                    <Tag className="w-12 h-12 mx-auto opacity-20 mb-2 text-indigo-400" />
                    <p className="text-sm font-bold uppercase tracking-widest text-muted-foreground">
                      {upcs.length === 0 ? 'No hay UPCs en el catálogo' : 'Sin coincidencias'}
                    </p>
                  </td>
                </tr>
              ) : (
                filtered.map(u => (
                  <tr key={u.catalog_id || u.upc} className="border-b border-border/10 hover:bg-primary/5">
                    <td className="p-3 font-mono font-black text-indigo-400 text-[12px]">{u.upc}</td>
                    <td className="p-3 text-[11px] font-bold">
                      <div>{u.customer || '—'}</div>
                      {u.brand && <div className="text-[10px] text-muted-foreground font-normal">{u.brand}</div>}
                    </td>
                    <td className="p-3 font-mono text-[11px] font-bold text-primary truncate max-w-[220px]" title={u.style}>{u.style || '—'}</td>
                    <td className="p-3 font-mono text-[11px]">
                      <span className="text-foreground">{u.color || '—'}</span>
                      <span className="mx-1 opacity-20">·</span>
                      <span className="text-primary">{u.size || '—'}</span>
                    </td>
                    <td className="p-3 text-[11px] text-muted-foreground truncate max-w-[200px]" title={u.description}>{u.description || '—'}</td>
                    <td className="p-3 text-[11px] flex items-center gap-1.5">
                      <User className="w-3 h-3 text-muted-foreground" />
                      <span className={u.created_by_name?.startsWith('import_') ? 'text-muted-foreground italic' : 'font-bold'}>
                        {u.created_by_name || '—'}
                      </span>
                    </td>
                    <td className="p-3 font-mono text-[10px] text-muted-foreground whitespace-nowrap">
                      {u.created_at ? new Date(u.created_at).toLocaleString() : '—'}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};

export const MovementsModule = () => {
  const [tab, setTab] = useState('movements');
  return (
    <div className="space-y-4">
      <div className="flex gap-2 p-1 bg-secondary/20 rounded-2xl w-fit border border-border/40">
        {TABS.map(t => {
          const Icon = t.icon;
          const active = tab === t.id;
          return (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`px-5 py-2 rounded-xl text-xs font-black uppercase tracking-widest transition-all flex items-center gap-2 ${active ? 'bg-primary text-black shadow-lg shadow-primary/20' : 'text-muted-foreground hover:text-foreground hover:bg-secondary/40'}`}
              data-testid={`movements-tab-${t.id}`}
            >
              <Icon className="w-3.5 h-3.5" />
              {t.label}
            </button>
          );
        })}
      </div>
      {tab === 'movements' ? <MovementsTab /> : <UpcsTab />}
    </div>
  );
};
