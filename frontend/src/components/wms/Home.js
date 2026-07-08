import { useState, useEffect, useCallback } from "react";
import { toast } from "sonner";
import { Loader2, Plus, Trash2, Tag, MapPin, Layers, ChevronDown, ChevronUp, Search, Edit2, ArrowUpToLine, X, Users, Palette, Shirt, Ruler, Lock } from "lucide-react";
import { useLang } from "../../contexts/LanguageContext";
import { fetcher, poster, deleter, logLoadError, refreshWmsSizes, API } from "./lib";

const SECTIONS = [
  // Receiving identity catalogs — locked dropdowns; only lead/supervisor may edit.
  { type: 'customers', label: 'Clientes', desc: 'Valores para "customer" en Receiving', icon: Users, color: 'text-cyan-400', bg: 'bg-cyan-500/10', border: 'border-cyan-500/20' },
  { type: 'styles', label: 'Estilos', desc: 'Valores para "style" en Receiving', icon: Shirt, color: 'text-amber-400', bg: 'bg-amber-500/10', border: 'border-amber-500/20' },
  { type: 'colors', label: 'Colores', desc: 'Valores para "color" en Receiving', icon: Palette, color: 'text-pink-400', bg: 'bg-pink-500/10', border: 'border-pink-500/20' },
  { type: 'sizes', label: 'Tallas', desc: 'Tallas adicionales para el desplegable de "size" en Receiving', icon: Ruler, color: 'text-orange-400', bg: 'bg-orange-500/10', border: 'border-orange-500/20' },
  { type: 'descriptions', label: 'Descripciones', desc: 'Valores para el campo "description" en Receiving', icon: Tag, color: 'text-blue-400', bg: 'bg-blue-500/10', border: 'border-blue-500/20' },
  { type: 'countries', label: 'Países de origen', desc: 'Valores para "country_of_origin" en Receiving', icon: MapPin, color: 'text-emerald-400', bg: 'bg-emerald-500/10', border: 'border-emerald-500/20' },
  { type: 'fabrics', label: 'Contenido / Fabric', desc: 'Valores para "fabric_content" en Receiving', icon: Layers, color: 'text-purple-400', bg: 'bg-purple-500/10', border: 'border-purple-500/20' },
];

// Initial per-type state derived from SECTIONS, so adding a catalog above is enough.
const byType = (val) => SECTIONS.reduce((acc, s) => ({ ...acc, [s.type]: val }), {});

export const HomeModule = () => {
  const { t } = useLang();
  const [catalogs, setCatalogs] = useState(byType([]));
  const [loading, setLoading] = useState(true);
  const [drafts, setDrafts] = useState(byType(''));
  const [saving, setSaving] = useState(null);
  const [deleting, setDeleting] = useState(null);

  // Styles are managed PER CLIENT. This dropdown scopes the Estilos panel
  // (list + add) to one customer; the list of customers is fetched once.
  const [styleCustomer, setStyleCustomer] = useState('');
  const [customers, setCustomers] = useState([]);
  useEffect(() => {
    fetcher('/inventory/options')
      .then(d => setCustomers((d?.customers || []).filter(Boolean)))
      .catch(() => {});
  }, []);

  // Solo admin nivel 3+ (supersu = max) puede agregar/renombrar/limpiar los
  // catálogos de identidad. Refleja el guard del backend; aquí solo oculta los
  // controles para todos los demás.
  const [isManager, setIsManager] = useState(false);
  useEffect(() => {
    fetch(`${process.env.REACT_APP_BACKEND_URL}/api/auth/me`, { credentials: 'include' })
      .then(r => r.ok ? r.json() : null)
      .then(u => {
        const level = u?.role === 'supersu' ? 5 : (u?.role === 'admin' ? Math.max(1, parseInt(u?.admin_level || 1)) : 0);
        setIsManager(level >= 3);
      })
      .catch(() => {});
  }, []);

  // Sources panel state — distinct values from wms_inventory + wms_receiving.
  const [sources, setSources] = useState({}); // { [type]: { items: [{value,count,in_catalog}], total_distinct } }
  const [sourcesLoading, setSourcesLoading] = useState({}); // { [type]: bool }
  const [expanded, setExpanded] = useState({}); // { [type]: bool }
  const [sourceSearch, setSourceSearch] = useState(byType(''));
  const [actioning, setActioning] = useState(null); // identifier for in-flight action
  const [renameModal, setRenameModal] = useState(null); // { type, oldValue, newValue }

  const load = useCallback(async () => {
    try {
      const data = await fetcher('/catalogs');
      setCatalogs(SECTIONS.reduce((acc, s) => ({ ...acc, [s.type]: data[s.type] || [] }), {}));
    } catch (err) { logLoadError('catalogs')(err); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  const loadSources = useCallback(async (type) => {
    setSourcesLoading(p => ({ ...p, [type]: true }));
    try {
      const data = await fetcher(`/catalogs/${type}/sources?limit=2000`);
      setSources(p => ({ ...p, [type]: data }));
    } catch (err) {
      logLoadError(`sources ${type}`)(err);
      toast.error(`No se pudieron cargar fuentes de ${type}`);
    } finally { setSourcesLoading(p => ({ ...p, [type]: false })); }
  }, []);

  const toggleExpanded = (type) => {
    const isOpen = !!expanded[type];
    setExpanded(p => ({ ...p, [type]: !isOpen }));
    if (!isOpen && !sources[type]) loadSources(type);
  };

  const handleAdd = async (type) => {
    const value = drafts[type]?.trim();
    if (!value) { toast.error('Escribe un valor'); return; }
    if (type === 'styles' && !styleCustomer) { toast.error('Selecciona un cliente primero'); return; }
    setSaving(type);
    try {
      const body = type === 'styles' ? { type, value, customer: styleCustomer } : { type, value };
      const res = await poster('/catalogs', body);
      if (res.ok) {
        toast.success(`Agregado a ${SECTIONS.find(s => s.type === type)?.label}`);
        setDrafts(prev => ({ ...prev, [type]: '' }));
        if (type === 'sizes') refreshWmsSizes();  // live-refresh size selectors
        load();
        if (sources[type]) loadSources(type); // refresh in_catalog flags
      } else {
        const err = await res.json().catch(() => ({}));
        toast.error(err.detail || 'Error al agregar');
      }
    } catch (err) {
      logLoadError('add catalog')(err);
      toast.error('Error de conexión');
    } finally { setSaving(null); }
  };

  const handleDelete = async (catalog_id, value) => {
    if (!window.confirm(`¿Eliminar "${value}" del catálogo?\n(No afecta registros existentes)`)) return;
    setDeleting(catalog_id);
    try {
      await deleter(`/catalogs/${catalog_id}`);
      toast.success('Eliminado');
      refreshWmsSizes();  // in case a size was removed
      load();
    } catch (err) {
      logLoadError('delete catalog')(err);
      toast.error('Error al eliminar');
    } finally { setDeleting(null); }
  };

  // Promote a raw inventory value to the curated catalog.
  const promoteToCatalog = async (type, value) => {
    setActioning(`promote:${type}:${value}`);
    try {
      const res = await poster('/catalogs', { type, value });
      if (res.ok) {
        toast.success(`"${value}" agregado al catálogo`);
        await Promise.all([load(), loadSources(type)]);
      } else {
        const err = await res.json().catch(() => ({}));
        toast.error(err.detail || 'Error');
      }
    } catch (err) {
      logLoadError('promote')(err);
      toast.error('Error de conexión');
    } finally { setActioning(null); }
  };

  // Sweep a value across inventory + receiving (e.g. fix a typo for every row).
  const submitRename = async () => {
    if (!renameModal) return;
    const { type, oldValue, newValue } = renameModal;
    const newClean = (newValue || '').trim();
    if (!newClean) { toast.error('Escribe el valor nuevo'); return; }
    if (newClean.toUpperCase() === oldValue.toUpperCase()) {
      toast.error('Debe ser distinto al original'); return;
    }
    setActioning(`rename:${type}:${oldValue}`);
    try {
      const res = await poster(`/catalogs/${type}/rename`, { old: oldValue, new: newClean });
      if (res.ok) {
        const data = await res.json();
        toast.success(`${data.modified} fila(s) renombradas de "${oldValue}" a "${data.new}"`);
        setRenameModal(null);
        loadSources(type);
      } else {
        const err = await res.json().catch(() => ({}));
        toast.error(err.detail || 'Error al renombrar');
      }
    } catch (err) {
      logLoadError('rename catalog value')(err);
      toast.error('Error de conexión');
    } finally { setActioning(null); }
  };

  // Wipe a value across inventory + receiving (sets to empty string).
  const bulkClearValue = async (type, value) => {
    if (!window.confirm(`¿Vaciar el valor "${value}" en todas las filas de ${type}?\nLas filas quedarán con el campo vacío.`)) return;
    setActioning(`clear:${type}:${value}`);
    try {
      const res = await fetch(`${API}/catalogs/${type}/sources`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ value }),
      });
      if (res.ok) {
        const data = await res.json();
        toast.success(`${data.modified} fila(s) limpiadas`);
        loadSources(type);
      } else {
        const err = await res.json().catch(() => ({}));
        toast.error(err.detail || 'Error');
      }
    } catch (err) {
      logLoadError('clear catalog value')(err);
      toast.error('Error de conexión');
    } finally { setActioning(null); }
  };

  const getFilteredSources = (type) => {
    const data = sources[type];
    if (!data) return [];
    const q = (sourceSearch[type] || '').trim().toUpperCase();
    if (!q) return data.items;
    return data.items.filter(it => it.value.toUpperCase().includes(q));
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="w-8 h-8 animate-spin text-primary" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="bg-card/40 border border-border/20 rounded-2xl p-5">
        <h2 className="text-sm font-black uppercase tracking-widest text-foreground mb-1">Catálogos maestros</h2>
        <p className="text-xs text-muted-foreground">
          Los <b>valores curados</b> son la fuente autoritativa del dropdown. Si hay al menos uno,
          solo esos aparecen en Receiving / Agregar Manual. Abre <b>Fuentes desde inventario</b> para
          ver lo que está en la base ahora y limpiar typos, promover valores buenos o vaciar basura.
        </p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {SECTIONS.map(section => {
          const Icon = section.icon;
          const isStyles = section.type === 'styles';
          // Styles are per-customer: show only the selected client's curated styles.
          const items = isStyles
            ? (catalogs.styles || []).filter(i => (i.customer || '').toUpperCase() === styleCustomer.toUpperCase())
            : (catalogs[section.type] || []);
          const isExpanded = !!expanded[section.type];
          const srcData = sources[section.type];
          const srcLoading = !!sourcesLoading[section.type];
          const filteredSources = getFilteredSources(section.type);
          return (
            <div key={section.type} className={`border ${section.border} rounded-3xl bg-card/60 backdrop-blur-sm shadow-xl flex flex-col`}>
              {/* Header */}
              <div className="p-5 border-b border-border/10 flex items-center gap-3">
                <div className={`w-10 h-10 rounded-2xl ${section.bg} flex items-center justify-center`}>
                  <Icon className={`w-5 h-5 ${section.color}`} />
                </div>
                <div className="flex-1 min-w-0">
                  <h3 className="font-black uppercase tracking-tighter text-sm">{section.label}</h3>
                  <p className="text-[10px] text-muted-foreground font-bold opacity-60 leading-tight">{section.desc}</p>
                </div>
                <span className="text-[10px] font-black tabular-nums bg-secondary/60 px-2 py-1 rounded-lg text-muted-foreground">
                  {items.length}
                </span>
              </div>

              {/* Styles are per-customer: pick the client this list belongs to. */}
              {isStyles && (
                <div className="p-3 border-b border-border/10">
                  <label className="text-[9px] font-black uppercase tracking-widest text-muted-foreground/70 block mb-1">Cliente</label>
                  <select
                    value={styleCustomer}
                    onChange={e => setStyleCustomer(e.target.value)}
                    className="w-full px-3 py-2 bg-background border border-border rounded-lg text-sm font-bold text-foreground focus:ring-2 focus:ring-primary/30"
                    data-testid="style-customer-select"
                  >
                    <option value="">— Selecciona cliente —</option>
                    {customers.map(c => <option key={c} value={c}>{c}</option>)}
                  </select>
                </div>
              )}

              {/* Add new — lead/supervisor only */}
              {isManager ? (
                <div className="p-4 border-b border-border/10 flex gap-2">
                  <input
                    type="text"
                    value={drafts[section.type]}
                    onChange={e => setDrafts(p => ({ ...p, [section.type]: e.target.value }))}
                    onKeyDown={e => { if (e.key === 'Enter') handleAdd(section.type); }}
                    placeholder={isStyles && !styleCustomer ? 'Selecciona un cliente…' : 'Nuevo valor…'}
                    disabled={isStyles && !styleCustomer}
                    className="flex-1 px-3 py-2 bg-background border border-border rounded-lg text-sm text-foreground focus:ring-2 focus:ring-primary/30 disabled:opacity-50"
                    data-testid={`cat-input-${section.type}`}
                  />
                  <button
                    onClick={() => handleAdd(section.type)}
                    disabled={saving === section.type || !drafts[section.type]?.trim() || (isStyles && !styleCustomer)}
                    className={`px-3 py-2 rounded-lg text-xs font-black uppercase tracking-widest flex items-center gap-1 transition-all disabled:opacity-40 ${section.bg} ${section.color}`}
                    data-testid={`cat-add-${section.type}`}
                  >
                    {saving === section.type ? <Loader2 className="w-3 h-3 animate-spin" /> : <Plus className="w-3 h-3" />}
                    Agregar
                  </button>
                </div>
              ) : (
                <div className="p-3 border-b border-border/10 flex items-center gap-2 text-[10px] font-bold uppercase tracking-widest text-muted-foreground/60">
                  <Lock className="w-3 h-3" /> Solo líder/supervisor puede editar
                </div>
              )}

              {/* Curated list */}
              <div className="overflow-auto max-h-[200px] custom-scrollbar">
                {items.length === 0 ? (
                  <div className="text-center py-6 text-xs text-muted-foreground/40 font-bold uppercase tracking-widest italic">
                    {isStyles && !styleCustomer ? 'Selecciona un cliente' : 'Sin valores curados'}
                  </div>
                ) : (
                  <ul className="divide-y divide-border/10">
                    {items.map(item => (
                      <li key={item.catalog_id} className="flex items-center justify-between px-4 py-2 hover:bg-secondary/30 transition-colors group">
                        <span className="text-sm font-bold text-foreground truncate">{item.value}</span>
                        {isManager && (
                          <button
                            onClick={() => handleDelete(item.catalog_id, item.value)}
                            disabled={deleting === item.catalog_id}
                            className="p-1.5 opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-red-500 hover:bg-red-500/10 rounded transition-all"
                            data-testid={`cat-delete-${item.catalog_id}`}
                          >
                            {deleting === item.catalog_id ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Trash2 className="w-3.5 h-3.5" />}
                          </button>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              {/* Sources accordion */}
              <button
                onClick={() => toggleExpanded(section.type)}
                className="w-full px-4 py-2.5 border-t border-border/10 flex items-center justify-between text-[11px] font-black uppercase tracking-widest text-muted-foreground hover:bg-secondary/30 transition-colors"
                data-testid={`sources-toggle-${section.type}`}
              >
                <span className="flex items-center gap-2">
                  <Search className="w-3.5 h-3.5" />
                  Fuentes desde inventario
                  {srcData && (
                    <span className="bg-secondary/50 px-1.5 py-0.5 rounded text-[9px] tabular-nums">{srcData.total_distinct}</span>
                  )}
                </span>
                {isExpanded ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
              </button>

              {isExpanded && (
                <div className="border-t border-border/10 bg-secondary/10">
                  <div className="p-3 border-b border-border/10">
                    <div className="relative">
                      <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground/50" />
                      <input
                        type="text"
                        value={sourceSearch[section.type]}
                        onChange={e => setSourceSearch(p => ({ ...p, [section.type]: e.target.value }))}
                        placeholder="Filtrar valores…"
                        className="w-full pl-9 pr-3 py-1.5 bg-background border border-border rounded-lg text-xs focus:ring-2 focus:ring-primary/30"
                        data-testid={`sources-search-${section.type}`}
                      />
                    </div>
                  </div>

                  <div className="overflow-auto max-h-[320px] custom-scrollbar">
                    {srcLoading ? (
                      <div className="flex items-center justify-center py-10">
                        <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
                      </div>
                    ) : filteredSources.length === 0 ? (
                      <div className="text-center py-6 text-[10px] text-muted-foreground/40 font-bold uppercase tracking-widest italic">
                        Sin coincidencias
                      </div>
                    ) : (
                      <ul className="divide-y divide-border/5">
                        {filteredSources.map((it, i) => {
                          const isPromoting = actioning === `promote:${section.type}:${it.value}`;
                          const isClearing = actioning === `clear:${section.type}:${it.value}`;
                          return (
                            <li key={`${it.value}-${i}`} className="flex items-center gap-2 px-3 py-1.5 hover:bg-secondary/30 transition-colors group">
                              <span className="text-[12px] font-mono font-bold text-foreground truncate flex-1" title={it.value}>
                                {it.value}
                              </span>
                              <span className="text-[9px] font-black tabular-nums text-muted-foreground/70 bg-secondary/40 px-1.5 py-0.5 rounded" title={`Aparece en ${it.count} fila(s)`}>
                                {it.count.toLocaleString()}
                              </span>
                              {it.in_catalog && (
                                <span className={`text-[8px] font-black uppercase tracking-widest ${section.color} ${section.bg} px-1.5 py-0.5 rounded`}>
                                  En cat.
                                </span>
                              )}
                              {isManager && !it.in_catalog && (
                                <button
                                  onClick={() => promoteToCatalog(section.type, it.value)}
                                  disabled={!!actioning}
                                  className={`p-1 ${section.color} hover:${section.bg} rounded opacity-50 group-hover:opacity-100 transition-all disabled:opacity-30`}
                                  title="Promover al catálogo"
                                >
                                  {isPromoting ? <Loader2 className="w-3 h-3 animate-spin" /> : <ArrowUpToLine className="w-3 h-3" />}
                                </button>
                              )}
                              {isManager && (
                                <>
                                  <button
                                    onClick={() => setRenameModal({ type: section.type, oldValue: it.value, newValue: it.value })}
                                    disabled={!!actioning}
                                    className="p-1 text-muted-foreground hover:text-yellow-500 hover:bg-yellow-500/10 rounded opacity-50 group-hover:opacity-100 transition-all disabled:opacity-30"
                                    title="Renombrar en todas las filas"
                                  >
                                    <Edit2 className="w-3 h-3" />
                                  </button>
                                  <button
                                    onClick={() => bulkClearValue(section.type, it.value)}
                                    disabled={!!actioning}
                                    className="p-1 text-muted-foreground hover:text-red-500 hover:bg-red-500/10 rounded opacity-50 group-hover:opacity-100 transition-all disabled:opacity-30"
                                    title="Vaciar valor (afecta inventario)"
                                  >
                                    {isClearing ? <Loader2 className="w-3 h-3 animate-spin" /> : <Trash2 className="w-3 h-3" />}
                                  </button>
                                </>
                              )}
                            </li>
                          );
                        })}
                      </ul>
                    )}
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Rename modal */}
      {renameModal && (() => {
        const section = SECTIONS.find(s => s.type === renameModal.type);
        const suggestions = (sources[renameModal.type]?.items || [])
          .filter(it => it.in_catalog || it.count > 10)
          .map(it => it.value)
          .filter(v => v.toUpperCase() !== renameModal.oldValue.toUpperCase())
          .slice(0, 8);
        return (
          <div className="fixed inset-0 z-[80] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm animate-in fade-in duration-150">
            <div className="bg-card border border-yellow-500/40 rounded-3xl w-full max-w-md shadow-2xl animate-in zoom-in-95 duration-150">
              <div className="flex items-center justify-between p-5 border-b border-border/20">
                <div className="flex items-center gap-3 min-w-0">
                  <div className="w-10 h-10 rounded-2xl bg-yellow-500/10 flex items-center justify-center flex-shrink-0">
                    <Edit2 className="w-5 h-5 text-yellow-400" />
                  </div>
                  <div className="min-w-0">
                    <h3 className="font-black uppercase tracking-tighter text-sm truncate">Renombrar en {section?.label}</h3>
                    <p className="text-[11px] text-muted-foreground font-bold truncate">Afecta TODAS las filas con este valor</p>
                  </div>
                </div>
                <button onClick={() => setRenameModal(null)} className="p-2 hover:bg-secondary rounded-lg" disabled={actioning?.startsWith('rename:')}>
                  <X className="w-5 h-5" />
                </button>
              </div>

              <div className="p-5 space-y-4">
                <div>
                  <label className="text-[10px] font-black uppercase tracking-widest text-muted-foreground block mb-1">Valor actual</label>
                  <div className="px-3 py-2 bg-red-500/10 border border-red-500/30 rounded-lg text-sm font-mono font-bold text-red-300">
                    {renameModal.oldValue}
                  </div>
                </div>
                <div>
                  <label className="text-[10px] font-black uppercase tracking-widest text-muted-foreground block mb-1">Cambiar a</label>
                  <input
                    type="text"
                    value={renameModal.newValue}
                    onChange={e => setRenameModal(p => ({ ...p, newValue: e.target.value.toUpperCase() }))}
                    onKeyDown={e => { if (e.key === 'Enter') submitRename(); }}
                    placeholder="ej: BANGLADESH"
                    className="w-full px-3 py-2 bg-background border border-emerald-500/40 rounded-lg text-sm font-mono font-bold focus:ring-2 focus:ring-emerald-500/30"
                    autoFocus
                    data-testid="rename-input"
                  />
                  {suggestions.length > 0 && (
                    <div className="mt-2 flex flex-wrap gap-1">
                      <span className="text-[9px] font-black uppercase tracking-widest text-muted-foreground/60 self-center mr-1">Sugerencias:</span>
                      {suggestions.map(s => (
                        <button
                          key={s}
                          onClick={() => setRenameModal(p => ({ ...p, newValue: s }))}
                          className="px-2 py-0.5 text-[10px] font-mono font-bold bg-secondary/60 hover:bg-emerald-500/20 hover:text-emerald-400 rounded transition-colors"
                        >
                          {s}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              </div>

              <div className="flex items-center justify-end gap-2 p-5 border-t border-border/20">
                <button onClick={() => setRenameModal(null)} disabled={actioning?.startsWith('rename:')} className="px-4 py-2 text-xs font-bold uppercase tracking-widest text-muted-foreground hover:text-foreground">
                  Cancelar
                </button>
                <button
                  onClick={submitRename}
                  disabled={actioning?.startsWith('rename:') || !renameModal.newValue?.trim()}
                  className="px-5 py-2 bg-yellow-500 text-black rounded-xl font-bold uppercase tracking-wider text-xs flex items-center gap-2 hover:bg-yellow-600 disabled:opacity-50"
                  data-testid="rename-submit"
                >
                  {actioning?.startsWith('rename:') ? <Loader2 className="w-4 h-4 animate-spin" /> : <Edit2 className="w-4 h-4" />}
                  Aplicar
                </button>
              </div>
            </div>
          </div>
        );
      })()}
    </div>
  );
};
