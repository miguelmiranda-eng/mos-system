import { useState, useEffect, useCallback } from "react";
import { toast } from "sonner";
import { ArrowLeft, ChevronUp, ChevronDown, MapPin, Loader2, Download, CheckCircle, Plus, ClipboardList, Trash2, History, Search } from "lucide-react";
import SearchableSelect from "../SearchableSelect";
import { useLang } from "../../contexts/LanguageContext";
import { useAuth } from "../../App";
import { fetcher, poster, putter, deleter, logLoadError } from "./lib";
import { PrefixLocationInput } from "./PrefixLocationInput";

export const CycleCountModule = () => {
  const { t } = useLang();
  const { user } = useAuth();
  const isAdmin = ['admin', 'supersu', 'inspector_qc', 'qc'].includes(user?.role);
  const [counts, setCounts] = useState([]);
  const [showForm, setShowForm] = useState(false);
  const [selectedCount, setSelectedCount] = useState(null);
  const [operators, setOperators] = useState([]);
  const [editingId, setEditingId] = useState(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [options, setOptions] = useState({ customers: [], styles: [], locations: [] });
  const [form, setForm] = useState({ name: '', is_general: false, location_filter: '', customer_filter: '', style_filter: '', assigned_to: '', assigned_to_name: '' });
  const [expandedLocations, setExpandedLocations] = useState({});

  const load = useCallback(() => { fetcher('/cycle-counts').then(setCounts).catch(logLoadError('data')); }, []);
  useEffect(() => {
    load();
    fetcher('/operators').then(setOperators).catch(logLoadError('data'));
    fetcher('/inventory/options?').then(d => setOptions({
      customers: d.customers || [],
      styles: d.styles || [],
      locations: d.locations || []
    })).catch(logLoadError('data'));
  }, [load]);

  const toggleNewForm = () => setShowForm(!showForm);

  const handleCreate = async () => {
    if (!form.name) { toast.error(t('wms_name_req')); return; }
    setLoading(true);
    try {
      const res = await poster('/cycle-counts', form);
      if (res.ok) {
        const data = await res.json();
        toast.success(t('wms_cc_created', { count: data.total_lines }));
        setShowForm(false);
        setForm({ name: '', is_general: false, location_filter: '', customer_filter: '', style_filter: '', assigned_to: '', assigned_to_name: '' });
        load();
      } else { const err = await res.json().catch(() => ({})); toast.error(err.detail || 'Error'); }
    } catch { toast.error('Error de conexion'); }
    finally { setLoading(false); }
  };

  const openCount = async (c) => {
    try {
      const data = await fetcher(`/cycle-counts/${c.count_id}`);
      setSelectedCount(data);
    } catch { toast.error(t('wms_cc_load_err')); }
  };

  const handleDelete = async (countId, e) => {
    e.stopPropagation();
    if (!window.confirm(t('wms_cc_delete_conf') || '¿Está seguro de que desea eliminar este conteo cíclico?')) return;
    try {
      const res = await deleter(`/cycle-counts/${countId}`);
      toast.success(res.message || 'Conteo cíclico eliminado correctamente');
      load();
    } catch {
      toast.error('Error al eliminar conteo cíclico');
    }
  };

  const saveProgress = async (countedItems) => {
    if (!selectedCount) return;
    setSaving(true);
    try {
      const res = await putter(`/cycle-counts/${selectedCount.count_id}/count`, { counted_items: countedItems });
      if (res.ok) {
        toast.success(t('wms_cc_saved'));
        const updated = await fetcher(`/cycle-counts/${selectedCount.count_id}`);
        setSelectedCount(updated);
        load();
      } else { const err = await res.json().catch(() => ({})); toast.error(err.detail || 'Error'); }
    } catch { toast.error('Error'); }
    finally { setSaving(false); }
  };

  const approveCount = async () => {
    if (!selectedCount || !window.confirm(t('wms_cc_approve_conf'))) return;
    setSaving(true);
    try {
      const res = await putter(`/cycle-counts/${selectedCount.count_id}/approve`, {});
      if (res.ok) {
        const data = await res.json();
        toast.success(data.message || t('success'));
        setSelectedCount(null);
        load();
      } else { const err = await res.json().catch(() => ({})); toast.error(err.detail || t('error')); }
    } catch { toast.error(t('error')); }
    finally { setSaving(false); }
  };

  // Counting interface
  if (selectedCount) {
    const lines = selectedCount.lines || [];
    const grouped = {};
    lines.forEach(l => {
      const key = l.inv_location || t('wms_no_loc').toUpperCase();
      if (!grouped[key]) grouped[key] = [];
      grouped[key].push(l);
    });
    const locations = Object.keys(grouped).sort();
    const totalLines = lines.length;
    const countedLines = lines.filter(l => l.counted).length;
    const discrepancies = lines.filter(l => l.counted && l.discrepancy !== 0).length;
    const pct = totalLines > 0 ? Math.round((countedLines / totalLines) * 100) : 0;

    const handleInputChange = (lineId, val) => {
      setSelectedCount(prev => ({
        ...prev,
        lines: prev.lines.map(l => l.line_id === lineId ? { ...l, counted_qty: val === '' ? null : parseInt(val) || 0 } : l)
      }));
    };

    const handleSaveAll = () => {
      const counted = {};
      lines.forEach(l => {
        if (l.counted_qty !== null && l.counted_qty !== undefined) {
          counted[l.line_id] = l.counted_qty;
        }
      });
      saveProgress(counted);
    };

    return (
      <div className="space-y-4" data-testid="cycle-count-detail">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <button onClick={() => setSelectedCount(null)} className="p-1.5 text-muted-foreground hover:text-foreground rounded hover:bg-secondary"><ArrowLeft className="w-4 h-4" /></button>
            <div>
              <h2 className="text-lg font-bold text-foreground">{selectedCount.name}</h2>
              <span className="text-xs text-muted-foreground">{selectedCount.count_id}</span>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <span className={`text-xs px-2 py-1 rounded-full font-bold ${selectedCount.status === 'approved' ? 'bg-green-500/15 text-green-400' : selectedCount.status === 'completed' ? 'bg-blue-500/15 text-blue-400' : 'bg-yellow-500/15 text-yellow-400'}`}>
              {selectedCount.status === 'approved' ? t('wms_status_approved') : selectedCount.status === 'completed' ? t('wms_status_completed') : t('wms_status_in_progress')}
            </span>
            {selectedCount.assigned_to_name && <span className="text-xs bg-purple-500/15 text-purple-400 px-2 py-1 rounded-full">{selectedCount.assigned_to_name}</span>}
          </div>
        </div>
        {/* Progress */}
        <div className="bg-card border border-border rounded-lg p-4">
          <div className="flex items-center justify-between mb-2">
            <span className="text-sm font-bold">{t('wms_cc_progress_label')} {countedLines}/{totalLines} {t('wms_cc_items')}</span>
            <div className="flex items-center gap-3">
              {discrepancies > 0 && <span className="text-xs bg-red-500/15 text-red-400 px-2 py-1 rounded-full font-bold">{discrepancies} {t('wms_cc_discrepancies')}</span>}
              <span className="text-sm font-bold">{pct}%</span>
            </div>
          </div>
          <div className="w-full h-2.5 bg-secondary rounded-full overflow-hidden">
            <div className={`h-full rounded-full transition-all ${pct === 100 ? 'bg-green-500' : pct > 0 ? 'bg-yellow-500' : 'bg-gray-500'}`} style={{ width: `${pct}%` }} />
          </div>
        </div>
        {/* Lines by location */}
        <div className="space-y-3 max-h-[500px] overflow-y-auto">
          {locations.map(loc => {
            const isExpanded = expandedLocations[loc];
            return (
              <div key={loc} className="border border-border rounded-lg overflow-hidden">
                <div
                  className="bg-secondary px-3 py-2 text-sm font-bold flex items-center gap-2 cursor-pointer hover:bg-secondary/80 transition-colors"
                  onClick={() => setExpandedLocations(prev => ({ ...prev, [loc]: !prev[loc] }))}
                >
                  <MapPin className="w-4 h-4 text-primary" /> {loc}
                  <span className="text-xs text-muted-foreground ml-auto">
                    {grouped[loc].filter(l => l.counted).length}/{grouped[loc].length}
                  </span>
                  {isExpanded ? <ChevronUp className="w-4 h-4 text-muted-foreground ml-2" /> : <ChevronDown className="w-4 h-4 text-muted-foreground ml-2" />}
                </div>
                {isExpanded && (
                  <div className="divide-y divide-border">
                    {grouped[loc].map(line => (
                      <div key={line.line_id} className={`flex items-center gap-3 px-3 py-2 ${line.counted && line.discrepancy !== 0 ? 'bg-red-500/5' : line.counted ? 'bg-green-500/5' : ''}`}>
                        <div className="flex-1 min-w-0">
                          <div className="text-sm font-mono font-bold">{line.style}</div>
                          <div className="text-xs text-muted-foreground">{line.color} / {line.size}</div>
                        </div>
                        {isAdmin && (
                          <div className="text-center w-20">
                            <div className="text-xs text-muted-foreground">{t('wms_cc_system')}</div>
                            <div className="text-sm font-bold">{line.system_qty}</div>
                          </div>
                        )}
                        <div className="w-24">
                          <div className="text-xs text-muted-foreground">{t('wms_cc_count')}</div>
                          <input type="number" min="0" value={line.counted_qty ?? ''} onChange={e => handleInputChange(line.line_id, e.target.value)}
                            className="w-full px-2 py-1.5 bg-background border border-border rounded text-center text-sm font-mono font-bold"
                            disabled={selectedCount.status === 'approved'}
                            data-testid={`cc-input-${line.line_id}`} />
                        </div>
                        {isAdmin && (
                          <div className="w-16 text-center">
                            {line.counted && (
                              <span className={`text-sm font-bold ${line.discrepancy === 0 ? 'text-green-400' : line.discrepancy > 0 ? 'text-blue-400' : 'text-red-400'}`}>
                                {line.discrepancy > 0 ? '+' : ''}{line.discrepancy}
                              </span>
                            )}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
        {/* Actions */}
        {selectedCount.status !== 'approved' && (
          <div className="flex gap-3 sticky bottom-0 bg-background pt-3 border-t border-border">
            <button onClick={handleSaveAll} disabled={saving} className="flex-1 px-4 py-2.5 bg-primary text-primary-foreground rounded-lg text-sm font-bold flex items-center justify-center gap-2 disabled:opacity-50" data-testid="cc-save">
              {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />} {t('wms_cc_save')}
            </button>
            {selectedCount.status === 'completed' && (
              <button onClick={approveCount} disabled={saving} className="flex-1 px-4 py-2.5 bg-green-600 text-white rounded-lg text-sm font-bold flex items-center justify-center gap-2 disabled:opacity-50" data-testid="cc-approve">
                {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle className="w-4 h-4" />} {t('wms_cc_approve')}
              </button>
            )}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="text-xs font-black uppercase tracking-widest text-muted-foreground bg-secondary/50 px-3 py-1 rounded-full border border-border/40 flex items-center gap-2">
          <div className="w-1.5 h-1.5 rounded-full bg-purple-500 animate-pulse" />
          {t('wms_cycle_count')}
        </div>
        <button
          onClick={() => setShowForm(!showForm)}
          className="px-5 py-2.5 bg-primary text-black rounded-xl font-bold uppercase tracking-wider text-xs transition-all hover:scale-105 shadow-[0_0_20px_rgba(255,193,7,0.3)] flex items-center gap-2"
          data-testid="new-cc-btn"
        >
          <Plus className="w-5 h-5" /> {t('wms_new_cc')}
        </button>
      </div>
      {showForm && (
        <div className="border border-border rounded-lg p-4 bg-secondary/30 space-y-4 animate-in fade-in slide-in-from-top-4 duration-300" data-testid="cc-form">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs uppercase tracking-wider text-muted-foreground font-bold block mb-1">{t('wms_cc_name')}</label>
              <input placeholder={t('wms_cc_name_placeholder')} value={form.name} onChange={e => setForm(p => ({ ...p, name: e.target.value }))} className="w-full px-3 py-2 bg-background border border-border rounded text-sm text-foreground" data-testid="cc-name" />
            </div>
            <div>
              <label className="text-xs uppercase tracking-wider text-muted-foreground font-bold block mb-1">{t('wms_assign_op')}</label>
              <select value={form.assigned_to} onChange={e => { const op = operators.find(o => (o.user_id || o.email) === e.target.value); setForm(p => ({ ...p, assigned_to: e.target.value, assigned_to_name: op ? (op.name || op.email) : '' })); }} className="w-full px-3 py-2 bg-background border border-border rounded text-sm text-foreground" data-testid="cc-assign">
                <option value="">{t('unassigned')}</option>
                {operators.map(op => <option key={op.user_id || op.email} value={op.user_id || op.email}>{op.name || op.email}</option>)}
              </select>
            </div>
          </div>

          <div className="flex items-center gap-3 p-3 bg-card border border-border rounded-2xl">
            <input
              type="checkbox"
              id="cc_is_general"
              checked={form.is_general}
              onChange={e => setForm(p => ({ ...p, is_general: e.target.checked, location_filter: '', customer_filter: '', style_filter: '' }))}
              className="w-4 h-4 rounded border-border text-primary focus:ring-primary/20 bg-background"
              data-testid="cc-is-general"
            />
            <label htmlFor="cc_is_general" className="text-xs font-black uppercase tracking-widest text-primary cursor-pointer select-none">
              Conteo General (Contar Todo el Inventario)
            </label>
          </div>

          <div className={`space-y-2 transition-all duration-300 ${form.is_general ? 'opacity-40 pointer-events-none scale-[0.98]' : ''}`}>
            <div className="text-xs uppercase tracking-wider text-muted-foreground font-bold">{t('wms_cc_filters')}</div>
            <div className="grid grid-cols-3 gap-3">
              <div>
                <label className="text-xs text-muted-foreground mb-1 block">
                  {t('wms_cc_loc_filter')}
                  <span className="ml-1 text-primary font-black">(prefijo)</span>
                </label>
                <PrefixLocationInput
                  locations={options.locations}
                  value={form.location_filter}
                  onChange={val => setForm(p => ({ ...p, location_filter: val }))}
                />
              </div>
              <div>
                <label className="text-xs text-muted-foreground mb-1 block">{t('client')}</label>
                <SearchableSelect options={options.customers} value={form.customer_filter} onChange={val => setForm(p => ({ ...p, customer_filter: val }))} placeholder={t('all')} testId="cc-customer" />
              </div>
              <div>
                <label className="text-xs text-muted-foreground mb-1 block">{t('style')}</label>
                <SearchableSelect options={options.styles} value={form.style_filter} onChange={val => setForm(p => ({ ...p, style_filter: val }))} placeholder={t('all')} testId="cc-style" />
              </div>
            </div>
          </div>

          <div className="flex gap-2 pt-2">
            <button onClick={handleCreate} disabled={loading} className="px-4 py-2.5 bg-primary text-black rounded-xl text-xs font-black uppercase tracking-widest flex items-center gap-1.5 disabled:opacity-50 hover:scale-[1.02] active:scale-95 transition-all shadow-lg shadow-primary/20" data-testid="cc-create">
              {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <ClipboardList className="w-4 h-4" />} {t('wms_create_cc')}
            </button>
            <button onClick={() => setShowForm(false)} className="px-5 py-2.5 bg-secondary text-foreground rounded-xl text-xs font-black uppercase tracking-widest hover:bg-secondary/80 transition-all">{t('cancel')}</button>
          </div>
        </div>
      )}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {counts.map(c => {
          const pct = c.total_lines > 0 ? Math.round((c.counted_lines / c.total_lines) * 100) : 0;
          const statusColors = {
            'approved': 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20',
            'completed': 'bg-blue-500/10 text-blue-400 border-blue-500/20',
            'in_progress': 'bg-yellow-500/10 text-yellow-400 border-yellow-500/20'
          };

          return (
            <div
              key={c.count_id}
              onClick={() => openCount(c)}
              className="cursor-pointer group text-left border border-border/40 rounded-3xl bg-card/60 backdrop-blur-sm hover:border-primary/40 hover:bg-card transition-all relative overflow-hidden shadow-xl"
              data-testid={`cc-${c.count_id}`}
            >
              <div className={`h-1.5 w-full ${c.status === 'approved' ? 'bg-emerald-500' : c.status === 'completed' ? 'bg-blue-500' : 'bg-yellow-500'}`} />

              <div className="p-5">
                <div className="flex items-start justify-between mb-4">
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 rounded-xl bg-purple-500/10 border border-purple-500/20 flex items-center justify-center text-purple-400">
                      <ClipboardList className="w-5 h-5" />
                    </div>
                    <div>
                      <div className="text-[10px] font-black uppercase bg-secondary/80 px-2 py-0.5 rounded text-muted-foreground tracking-widest inline-block mb-1">
                        #{c.count_id.slice(-6)}
                      </div>
                      <h4 className="text-xs font-black uppercase tracking-tight text-foreground truncate max-w-[120px]">{c.name}</h4>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <div className={`px-2 py-1 rounded-lg text-[10px] font-black uppercase tracking-widest border ${statusColors[c.status] || 'bg-secondary text-muted-foreground border-border/20'}`}>
                      {c.status === 'approved' ? t('wms_status_approved') : c.status === 'completed' ? t('wms_status_completed') : t('wms_status_in_progress')}
                    </div>
                    {isAdmin && (
                      <button
                        onClick={(e) => handleDelete(c.count_id, e)}
                        className="p-1.5 rounded-xl bg-destructive/10 hover:bg-destructive/20 text-destructive/80 hover:text-destructive transition-all border border-destructive/20"
                        title={t('delete') || 'Eliminar'}
                        data-testid={`delete-cc-${c.count_id}`}
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    )}
                  </div>
                </div>

                <div className="bg-secondary/20 rounded-2xl p-4 mb-4 border border-border/10 shadow-inner">
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-[10px] font-black uppercase tracking-widest text-muted-foreground">{t('wms_cc_progress_title')}</span>
                    <span className="text-sm font-black tabular-nums">{pct}%</span>
                  </div>
                  <div className="h-2 bg-black/20 rounded-full overflow-hidden shadow-inner">
                    <div className={`h-full rounded-full transition-all duration-700 ${pct === 100 ? 'bg-emerald-500' : 'bg-primary shadow-[0_0_10px_rgba(255,193,7,0.5)]'}`} style={{ width: `${pct}%` }} />
                  </div>
                  <div className="mt-2 text-[10px] font-bold text-muted-foreground flex items-center justify-between">
                    <span>{c.counted_lines} {t('of')} {c.total_lines} {t('wms_cc_items')}</span>
                    {c.assigned_to_name && <span className="text-indigo-400 italic">@{c.assigned_to_name}</span>}
                  </div>
                </div>

                <div className="flex items-center justify-between text-[10px] font-black uppercase tracking-widest text-muted-foreground/40 border-t border-border/10 pt-3">
                  <span className="flex items-center gap-1"><History className="w-3 h-3" /> {new Date(c.created_at).toLocaleDateString()}</span>
                  {c.is_general ? (
                    <span className="text-emerald-400 font-black bg-emerald-500/10 border border-emerald-500/20 px-2 py-0.5 rounded-lg flex items-center gap-1">Conteo General</span>
                  ) : c.location_filter ? (
                    <span className="flex items-center gap-1 opacity-80"><MapPin className="w-3 h-3" /> {c.location_filter}</span>
                  ) : null}
                </div>
              </div>
            </div>
          );
        })}
      </div>
      {counts.length === 0 && (
        <div className="flex flex-col items-center justify-center py-20 bg-secondary/10 rounded-3xl border border-dashed border-border/40 text-muted-foreground opacity-50">
          <Search className="w-16 h-16 mb-4 stroke-[1px]" />
          <p className="font-bold uppercase tracking-widest text-sm italic">{t('wms_no_cc')}</p>
          <p className="text-xs mt-1">{t('wms_cc_hint')}</p>
        </div>
      )}
    </div>
  );
};
