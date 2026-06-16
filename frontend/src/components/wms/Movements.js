import { useState, useEffect, useCallback, useMemo } from "react";
import { History, Tag, Search, X, Loader2, User, Pencil, Trash2, CheckCircle2, ArrowDownUp, Download, ArrowDownCircle, ArrowUpCircle } from "lucide-react";
import * as XLSX from "xlsx";
import { toast } from "sonner";
import { useLang } from "../../contexts/LanguageContext";
import { fetcher, putter, deleter, logLoadError, SIZES_ORDER } from "./lib";

const TABS = [
  { id: 'movements', label: 'Movimientos',       icon: History },
  { id: 'inout',     label: 'Entradas / Salidas', icon: ArrowDownUp },
  { id: 'upcs',      label: 'UPCs',              icon: Tag },
];

// Audit log can hold tens of thousands of rows; only the most recent matter on
// screen and rendering them all crushes warehouse-device RAM. Cap the fetch.
const MOVEMENTS_LIMIT = 500;

const MovementsTab = () => {
  const { t } = useLang();
  const [movements, setMovements] = useState([]);
  const [typeFilter, setTypeFilter] = useState('');
  const load = useCallback(() => { fetcher(`/movements?movement_type=${typeFilter}&limit=${MOVEMENTS_LIMIT}`).then(setMovements).catch(logLoadError('data')); }, [typeFilter]);
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
        {movements.length >= MOVEMENTS_LIMIT && (
          <div className="pt-3 text-center text-[10px] font-black uppercase tracking-[0.15em] text-amber-500">
            Mostrando los {MOVEMENTS_LIMIT.toLocaleString()} movimientos más recientes — usa los filtros para acotar
          </div>
        )}
      </div>
    </div>
  );
};

// ── Entradas / Salidas (ajustes manuales de inventario) ───────────────────────
const InOutTab = () => {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(false);
  const [dir, setDir] = useState('all'); // 'all' | 'in' | 'out'
  const [search, setSearch] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [adds, removes] = await Promise.all([
        fetcher('/movements?movement_type=manual_inventory_add&limit=1000'),
        fetcher('/movements?movement_type=manual_inventory_remove&limit=1000'),
      ]);
      const norm = (m) => {
        const d = m.details || {};
        const isIn = m.type === 'manual_inventory_add';
        return {
          created_at: m.created_at,
          direction: isIn ? 'ENTRADA' : 'SALIDA',
          isIn,
          reason: d.reason || (isIn ? (d.mode === 'accumulated' ? 'ACUMULADO' : 'NUEVO') : ''),
          style: d.style || '',
          color: d.color || '',
          size: d.size || '',
          location: d.location || '',
          units: isIn ? (d.added_units ?? 0) : (d.removed_units ?? 0),
          boxes: isIn ? (d.added_boxes ?? 0) : (d.removed_boxes ?? 0),
          user: m.user_name || m.user_id || 'Sistema',
        };
      };
      const merged = [...(adds || []), ...(removes || [])]
        .map(norm)
        .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
      setRows(merged);
    } catch (err) {
      logLoadError('entradas/salidas')(err);
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  const filtered = useMemo(() => {
    let r = rows;
    if (dir !== 'all') r = r.filter(x => (dir === 'in' ? x.isIn : !x.isIn));
    const q = search.trim().toUpperCase();
    if (q) r = r.filter(x =>
      `${x.style} ${x.color} ${x.size} ${x.location} ${x.reason} ${x.user}`.toUpperCase().includes(q)
    );
    return r;
  }, [rows, dir, search]);

  const totals = useMemo(() => ({
    in: filtered.filter(x => x.isIn).reduce((s, x) => s + (Number(x.units) || 0), 0),
    out: filtered.filter(x => !x.isIn).reduce((s, x) => s + (Number(x.units) || 0), 0),
  }), [filtered]);

  const exportExcel = () => {
    if (filtered.length === 0) { toast.error('No hay registros para exportar'); return; }
    const data = filtered.map(x => ({
      'Fecha': x.created_at ? new Date(x.created_at).toLocaleString() : '',
      'Tipo': x.direction,
      'Motivo': x.reason,
      'Style / SKU': x.style,
      'Color': x.color,
      'Talla': x.size,
      'Ubicación': x.location,
      'Unidades': Number(x.units) || 0,
      'Cajas': Number(x.boxes) || 0,
      'Usuario': x.user,
    }));
    const ws = XLSX.utils.json_to_sheet(data);
    ws['!cols'] = [{ wch: 20 }, { wch: 10 }, { wch: 22 }, { wch: 18 }, { wch: 12 }, { wch: 8 }, { wch: 14 }, { wch: 10 }, { wch: 8 }, { wch: 22 }];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Entradas_Salidas');
    XLSX.writeFile(wb, `entradas_salidas_${new Date().toISOString().split('T')[0]}.xlsx`);
  };

  const dirTabs = [
    { id: 'all', label: 'Todas' },
    { id: 'in',  label: 'Entradas' },
    { id: 'out', label: 'Salidas' },
  ];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex gap-1.5 p-1 bg-secondary/30 rounded-xl border border-border/10">
          {dirTabs.map(d => (
            <button
              key={d.id}
              onClick={() => setDir(d.id)}
              className={`px-3 py-1.5 rounded-lg text-[10px] font-black uppercase tracking-wider transition-all ${dir === d.id ? 'bg-primary text-black shadow-lg shadow-primary/20' : 'text-muted-foreground hover:bg-secondary/60 hover:text-foreground'}`}
            >
              {d.label}
            </button>
          ))}
        </div>
        <div className="relative flex-1 min-w-[240px]">
          <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Buscar style / color / ubicación / motivo / usuario…"
            className="w-full pl-9 pr-9 py-2 bg-background border border-border rounded-lg text-sm focus:outline-none focus:border-primary/40"
          />
          {search && (
            <button onClick={() => setSearch('')} className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground">
              <X className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
        <div className="flex items-center gap-3 text-[11px] font-mono font-bold">
          <span className="text-emerald-500">+{totals.in.toLocaleString()}</span>
          <span className="text-rose-500">-{totals.out.toLocaleString()}</span>
          <span className="text-muted-foreground">{filtered.length.toLocaleString()} reg.</span>
        </div>
        <button
          onClick={exportExcel}
          data-testid="inout-export-btn"
          className="flex items-center gap-2 px-4 py-2 bg-emerald-500 hover:bg-emerald-600 text-white rounded-lg text-xs font-black uppercase tracking-wider transition-all"
        >
          <Download className="w-4 h-4" /> Exportar Excel
        </button>
      </div>

      <div className="border border-border/40 rounded-2xl bg-card/40 overflow-hidden">
        <div className="overflow-auto max-h-[600px] custom-scrollbar">
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-secondary/80 backdrop-blur-md border-b border-border/40">
              <tr>
                {['Fecha', 'Tipo', 'Motivo', 'Style / SKU', 'Color · Talla', 'Ubicación', 'Unidades', 'Cajas', 'Usuario'].map(h => (
                  <th key={h} className="p-3 text-left text-[10px] font-black uppercase tracking-widest text-muted-foreground whitespace-nowrap">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td colSpan={9} className="py-16 text-center text-muted-foreground"><Loader2 className="w-6 h-6 animate-spin mx-auto" /></td></tr>
              ) : filtered.length === 0 ? (
                <tr>
                  <td colSpan={9} className="py-20 text-center">
                    <ArrowDownUp className="w-12 h-12 mx-auto opacity-20 mb-2 text-primary" />
                    <p className="text-sm font-bold uppercase tracking-widest text-muted-foreground">Sin entradas ni salidas manuales</p>
                  </td>
                </tr>
              ) : (
                filtered.map((x, i) => (
                  <tr key={i} className="border-b border-border/10 hover:bg-primary/5">
                    <td className="p-3 font-mono text-[10px] text-muted-foreground whitespace-nowrap">{x.created_at ? new Date(x.created_at).toLocaleString() : '—'}</td>
                    <td className="p-3">
                      <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-black uppercase ${x.isIn ? 'bg-emerald-500/10 text-emerald-500' : 'bg-rose-500/10 text-rose-500'}`}>
                        {x.isIn ? <ArrowDownCircle className="w-3 h-3" /> : <ArrowUpCircle className="w-3 h-3" />}
                        {x.direction}
                      </span>
                    </td>
                    <td className="p-3 text-[11px] font-bold">{x.reason || '—'}</td>
                    <td className="p-3 font-mono text-[11px] font-bold text-primary truncate max-w-[200px]" title={x.style}>{x.style || '—'}</td>
                    <td className="p-3 font-mono text-[11px]">
                      <span className="text-foreground">{x.color || '—'}</span>
                      <span className="mx-1 opacity-20">·</span>
                      <span className="text-primary">{x.size || '—'}</span>
                    </td>
                    <td className="p-3 font-mono text-[11px]">{x.location || '—'}</td>
                    <td className={`p-3 text-right font-mono font-black ${x.isIn ? 'text-emerald-500' : 'text-rose-500'}`}>{x.isIn ? '+' : '-'}{(Number(x.units) || 0).toLocaleString()}</td>
                    <td className="p-3 text-right font-mono">{(Number(x.boxes) || 0).toLocaleString()}</td>
                    <td className="p-3 text-[11px] flex items-center gap-1.5"><User className="w-3 h-3 text-muted-foreground" />{x.user}</td>
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

const UpcsTab = () => {
  const [upcs, setUpcs] = useState([]);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');
  const [userFilter, setUserFilter] = useState('');
  // Edit/Delete of catalog UPCs is admin-only (backend require_admin).
  const [canManage, setCanManage] = useState(false);
  useEffect(() => {
    fetch(`${process.env.REACT_APP_BACKEND_URL}/api/auth/me`, { credentials: 'include' })
      .then(r => r.ok ? r.json() : null)
      .then(u => setCanManage(['admin', 'supersu', 'ceo'].includes(u?.role)))
      .catch(() => {});
  }, []);
  const [editing, setEditing] = useState(null); // upc doc being edited
  const [draft, setDraft] = useState(null);
  const [saving, setSaving] = useState(false);

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

  const openEdit = (u) => { setEditing(u); setDraft({ ...u }); };
  const closeEdit = () => { setEditing(null); setDraft(null); };

  const saveEdit = async () => {
    if (!draft?.style?.trim()) { toast.error('Style es obligatorio'); return; }
    setSaving(true);
    try {
      const res = await putter(`/upc/${encodeURIComponent(editing.upc)}`, draft);
      if (!res.ok) {
        const e = await res.json().catch(() => ({}));
        toast.error(e.detail || 'No se pudo actualizar el UPC');
        return;
      }
      const doc = await res.json();
      setUpcs(prev => prev.map(x => x.upc === doc.upc ? { ...x, ...doc } : x));
      toast.success(`UPC ${doc.upc} actualizado`);
      closeEdit();
    } catch {
      toast.error('Error de conexión');
    } finally { setSaving(false); }
  };

  const removeUpc = async (u) => {
    if (!window.confirm(`¿Eliminar el UPC ${u.upc} del catálogo? Los recibos ya hechos NO se afectan.`)) return;
    try {
      await deleter(`/upc/${encodeURIComponent(u.upc)}`);
      setUpcs(prev => prev.filter(x => x.upc !== u.upc));
      toast.success(`UPC ${u.upc} eliminado del catálogo`);
    } catch {
      toast.error('No se pudo eliminar (¿permisos de admin?)');
    }
  };

  const field = (k) => draft?.[k] ?? '';
  const setField = (k, v) => setDraft(p => ({ ...p, [k]: v }));

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
                {canManage && <th className="p-3 text-right text-[10px] font-black uppercase tracking-widest text-muted-foreground">Acciones</th>}
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan={canManage ? 8 : 7} className="py-16 text-center text-muted-foreground">
                    <Loader2 className="w-6 h-6 animate-spin mx-auto" />
                  </td>
                </tr>
              ) : filtered.length === 0 ? (
                <tr>
                  <td colSpan={canManage ? 8 : 7} className="py-20 text-center">
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
                    {canManage && (
                      <td className="p-3 text-right whitespace-nowrap">
                        <div className="flex items-center justify-end gap-1.5">
                          <button onClick={() => openEdit(u)} className="p-1.5 rounded-lg bg-amber-500/15 hover:bg-amber-500/25 text-amber-500" title="Editar UPC"><Pencil className="w-3.5 h-3.5" /></button>
                          <button onClick={() => removeUpc(u)} className="p-1.5 rounded-lg bg-red-500/15 hover:bg-red-500/25 text-red-500" title="Eliminar UPC"><Trash2 className="w-3.5 h-3.5" /></button>
                        </div>
                      </td>
                    )}
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {editing && (
        <div className="fixed inset-0 z-[80] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm animate-in fade-in duration-150">
          <div className="bg-card border border-border/50 rounded-3xl w-full max-w-2xl max-h-[85vh] flex flex-col shadow-2xl animate-in zoom-in-95 duration-150">
            <div className="flex items-center justify-between p-5 border-b border-border/20">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-2xl bg-amber-500/10 flex items-center justify-center"><Pencil className="w-5 h-5 text-amber-500" /></div>
                <div>
                  <h3 className="font-black uppercase tracking-tighter text-sm">Editar UPC del catálogo</h3>
                  <p className="text-[11px] text-muted-foreground font-bold">Los recibos pasados NO cambian; solo los futuros heredan estos datos.</p>
                </div>
              </div>
              <button onClick={closeEdit} disabled={saving} className="p-2 hover:bg-secondary rounded-lg transition-all disabled:opacity-50"><X className="w-5 h-5" /></button>
            </div>

            <div className="flex-1 overflow-auto custom-scrollbar p-5 space-y-3">
              <div>
                <label className="text-[10px] font-black uppercase tracking-widest text-muted-foreground block mb-1">UPC</label>
                <input value={field('upc')} disabled title="El código del UPC no se puede cambiar; elimina y crea uno nuevo si necesitas otro código." className="w-full px-3 py-2 bg-background border border-border rounded text-sm font-mono font-bold opacity-60 cursor-not-allowed" />
              </div>
              <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
                <div>
                  <label className="text-[10px] font-black uppercase tracking-widest text-muted-foreground block mb-1">Cliente</label>
                  <input value={field('customer')} onChange={e => setField('customer', e.target.value.toUpperCase())} className="w-full px-3 py-2 bg-background border border-border rounded text-sm" />
                </div>
                <div>
                  <label className="text-[10px] font-black uppercase tracking-widest text-muted-foreground block mb-1">Fabricante</label>
                  <input value={field('manufacturer')} onChange={e => setField('manufacturer', e.target.value.toUpperCase())} className="w-full px-3 py-2 bg-background border border-border rounded text-sm" />
                </div>
                <div>
                  <label className="text-[10px] font-black uppercase tracking-widest text-muted-foreground block mb-1">Marca</label>
                  <input value={field('brand')} onChange={e => setField('brand', e.target.value.toUpperCase())} className="w-full px-3 py-2 bg-background border border-border rounded text-sm" />
                </div>
              </div>
              <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
                <div>
                  <label className="text-[10px] font-black uppercase tracking-widest text-muted-foreground block mb-1">Style <span className="text-red-400">*</span></label>
                  <input value={field('style')} onChange={e => setField('style', e.target.value.toUpperCase())} className="w-full px-3 py-2 bg-background border border-border rounded text-sm font-mono font-bold" />
                </div>
                <div>
                  <label className="text-[10px] font-black uppercase tracking-widest text-muted-foreground block mb-1">Color</label>
                  <input value={field('color')} onChange={e => setField('color', e.target.value.toUpperCase())} className="w-full px-3 py-2 bg-background border border-border rounded text-sm font-mono" />
                </div>
                <div>
                  <label className="text-[10px] font-black uppercase tracking-widest text-muted-foreground block mb-1">Talla</label>
                  <select value={field('size')} onChange={e => setField('size', e.target.value)} className="w-full px-3 py-2 bg-background border border-border rounded text-sm font-mono">
                    <option value="">—</option>
                    {SIZES_ORDER.map(s => <option key={s} value={s}>{s}</option>)}
                  </select>
                </div>
              </div>
              <div>
                <label className="text-[10px] font-black uppercase tracking-widest text-muted-foreground block mb-1">Descripción</label>
                <input value={field('description')} onChange={e => setField('description', e.target.value)} className="w-full px-3 py-2 bg-background border border-border rounded text-sm" />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-[10px] font-black uppercase tracking-widest text-muted-foreground block mb-1">País de origen</label>
                  <input value={field('country_of_origin')} onChange={e => setField('country_of_origin', e.target.value.toUpperCase())} className="w-full px-3 py-2 bg-background border border-border rounded text-sm" />
                </div>
                <div>
                  <label className="text-[10px] font-black uppercase tracking-widest text-muted-foreground block mb-1">Fabric / Contenido</label>
                  <input value={field('fabric_content')} onChange={e => setField('fabric_content', e.target.value)} className="w-full px-3 py-2 bg-background border border-border rounded text-sm" />
                </div>
              </div>
            </div>

            <div className="flex gap-2 p-5 border-t border-border/20">
              <button onClick={saveEdit} disabled={saving || !field('style').trim()} className="flex-1 px-4 py-2.5 bg-amber-500 hover:bg-amber-400 text-white rounded-xl text-sm font-black uppercase tracking-wider disabled:opacity-50 flex items-center justify-center gap-2">
                {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle2 className="w-4 h-4" />} Actualizar UPC
              </button>
              <button onClick={closeEdit} disabled={saving} className="px-4 py-2.5 bg-secondary text-foreground rounded-xl text-sm font-bold uppercase disabled:opacity-50">Cancelar</button>
            </div>
          </div>
        </div>
      )}
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
      {tab === 'movements' ? <MovementsTab /> : tab === 'inout' ? <InOutTab /> : <UpcsTab />}
    </div>
  );
};
