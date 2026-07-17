import { useState, useEffect, useCallback, useMemo } from "react";
import { toast } from "sonner";
import { Loader2, Plus, Trash2, Tag, MapPin, Layers, ChevronDown, ChevronUp, Search, Edit2, ArrowUpToLine, X, Users, Palette, Shirt, Ruler, Lock, Wand2, AlertTriangle, ArrowRight, Factory } from "lucide-react";
import { useLang } from "../../contexts/LanguageContext";
import { fetcher, poster, deleter, logLoadError, refreshWmsSizes, refreshWmsColors, refreshWmsCatalogs, API } from "./lib";
import { UpcCatalog } from "./UpcCatalog";

const SECTIONS = [
  // Receiving identity catalogs — locked dropdowns; only lead/supervisor may edit.
  { type: 'customers', label: 'Clientes', desc: 'Valores para "customer" en Receiving', icon: Users, color: 'text-cyan-400', bg: 'bg-cyan-500/10', border: 'border-cyan-500/20' },
  { type: 'manufacturers', label: 'Fabricantes', desc: 'Valores para "manufacturer" en Receiving', icon: Factory, color: 'text-teal-400', bg: 'bg-teal-500/10', border: 'border-teal-500/20' },
  { type: 'styles', label: 'Estilos', desc: 'Valores para "style" en Receiving', icon: Shirt, color: 'text-amber-400', bg: 'bg-amber-500/10', border: 'border-amber-500/20' },
  { type: 'colors', label: 'Colores', desc: 'Valores para "color" en Receiving', icon: Palette, color: 'text-pink-400', bg: 'bg-pink-500/10', border: 'border-pink-500/20' },
  { type: 'sizes', label: 'Tallas', desc: 'Tallas adicionales para el desplegable de "size" en Receiving', icon: Ruler, color: 'text-orange-400', bg: 'bg-orange-500/10', border: 'border-orange-500/20' },
  { type: 'descriptions', label: 'Descripciones', desc: 'Valores para el campo "description" en Receiving', icon: Tag, color: 'text-blue-400', bg: 'bg-blue-500/10', border: 'border-blue-500/20' },
  { type: 'countries', label: 'Países de origen', desc: 'Valores para "country_of_origin" en Receiving', icon: MapPin, color: 'text-emerald-400', bg: 'bg-emerald-500/10', border: 'border-emerald-500/20' },
  { type: 'fabrics', label: 'Contenido / Fabric', desc: 'Valores para "fabric_content" en Receiving', icon: Layers, color: 'text-purple-400', bg: 'bg-purple-500/10', border: 'border-purple-500/20' },
];

// Tipos por-cliente: el selector de cliente aparece en su tarjeta y los valores
// se scopean (cliente + globales). Estilos EXIGE cliente; colores/fabricantes lo
// permiten opcional (sin cliente = valor global compartido).
const SCOPED_TYPES = ['styles', 'colors', 'manufacturers'];

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
  // (list + add) to one customer. La lista de clientes se alimenta del catálogo
  // CURADO de "Clientes" (pestaña Clientes de este mismo módulo, cargado en
  // catalogs.customers via /catalogs) — NO de los valores crudos del inventario.
  // Así, lo que exista en la pestaña Clientes es exactamente lo que aparece aquí.
  const [styleCustomer, setStyleCustomer] = useState('');
  const customers = useMemo(
    () => Array.from(
      new Set((catalogs.customers || []).map(c => c.value).filter(Boolean))
    ).sort((a, b) => a.localeCompare(b)),
    [catalogs.customers]
  );

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
  const [sourceSearch, setSourceSearch] = useState(byType(''));
  const [actioning, setActioning] = useState(null); // identifier for in-flight action
  const [renameModal, setRenameModal] = useState(null); // { type, oldValue, newValue }

  // Detector de typos por similitud (Levenshtein) — panel expandible por type.
  const [similar, setSimilar] = useState({});           // { [type]: { pairs, max_dist } }
  const [similarLoading, setSimilarLoading] = useState({});
  const [showSimilar, setShowSimilar] = useState({});

  const load = useCallback(async () => {
    try {
      const data = await fetcher('/catalogs');
      setCatalogs(SECTIONS.reduce((acc, s) => ({ ...acc, [s.type]: data[s.type] || [] }), {}));
    } catch (err) { logLoadError('catalogs')(err); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  // For styles the "Fuentes desde inventario" panel MUST scope by the selected
  // client — otherwise the list mixes every customer's raw values and looks like
  // "two lists". Same fix applied to the typo detector below.
  const loadSources = useCallback(async (type) => {
    setSourcesLoading(p => ({ ...p, [type]: true }));
    try {
      const params = new URLSearchParams({ limit: '2000' });
      if (SCOPED_TYPES.includes(type) && styleCustomer) params.set('customer', styleCustomer);
      const data = await fetcher(`/catalogs/${type}/sources?${params.toString()}`);
      setSources(p => ({ ...p, [type]: data }));
    } catch (err) {
      logLoadError(`sources ${type}`)(err);
      toast.error(`No se pudieron cargar fuentes de ${type}`);
    } finally { setSourcesLoading(p => ({ ...p, [type]: false })); }
  }, [styleCustomer]);

  // Autoload one-shot. Styles necesita cliente antes; colores/fabricantes cargan
  // su vista global de una vez (y se re-scopean al elegir cliente).
  useEffect(() => {
    SECTIONS.forEach(s => {
      if (s.type === 'styles') return;
      loadSources(s.type);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Al cambiar el cliente, recarga Fuentes + Typos de TODOS los tipos por-cliente
  // (estilos, colores, fabricantes) para que se scopeen a ese cliente + globales.
  useEffect(() => {
    if (!styleCustomer) return;
    SCOPED_TYPES.forEach(t => {
      loadSources(t);
      if (showSimilar[t]) loadSimilar(t);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [styleCustomer]);

  const handleAdd = async (type) => {
    const value = drafts[type]?.trim();
    if (!value) { toast.error('Escribe un valor'); return; }
    if (type === 'styles' && !styleCustomer) { toast.error('Selecciona un cliente primero'); return; }
    setSaving(type);
    try {
      // Tipos por-cliente adjuntan el cliente seleccionado; si está vacío (permitido
      // en colores/fabricantes) el valor se guarda como global compartido.
      const body = SCOPED_TYPES.includes(type) ? { type, value, customer: styleCustomer } : { type, value };
      const res = await poster('/catalogs', body);
      if (res.ok) {
        toast.success(`Agregado a ${SECTIONS.find(s => s.type === type)?.label}`);
        setDrafts(prev => ({ ...prev, [type]: '' }));
        if (type === 'sizes') refreshWmsSizes();    // live-refresh size selectors
        if (type === 'colors') refreshWmsColors();  // live-refresh color selectors
        refreshWmsCatalogs();                       // refresca listas fusionadas (customer/desc/país/fabric/style) en otros módulos
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

  const handleDelete = async (catalog_id, value, type) => {
    if (!window.confirm(`¿Quitar "${value}" del catálogo?\n(No afecta registros existentes en inventario)`)) return;
    setDeleting(catalog_id);
    try {
      await deleter(`/catalogs/${catalog_id}`);
      toast.success('Quitado del catálogo');
      refreshWmsSizes();  // in case a size was removed
      load();
      if (type && sources[type]) loadSources(type);
    } catch (err) {
      logLoadError('delete catalog')(err);
      toast.error('Error al quitar');
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
        const bits = [`${data.modified} fila(s) renombradas de "${oldValue}" a "${data.new}"`];
        if (data.catalog_removed) bits.push(`${data.catalog_removed} quitado(s) del catálogo`);
        if (data.catalog_added) bits.push(`${data.catalog_added} agregado(s) al catálogo`);
        toast.success(bits.join(' · '));
        setRenameModal(null);
        load();
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

  // Cazar typos: distancia de edición ≤ 2 entre pares del catálogo.
  const loadSimilar = useCallback(async (type) => {
    setSimilarLoading(p => ({ ...p, [type]: true }));
    try {
      const params = new URLSearchParams({ max_dist: '2', min_count: '1' });
      if (SCOPED_TYPES.includes(type) && styleCustomer) params.set('customer', styleCustomer);
      const data = await fetcher(`/catalogs/${type}/similar?${params.toString()}`);
      setSimilar(p => ({ ...p, [type]: data }));
    } catch (err) {
      logLoadError(`similar ${type}`)(err);
      toast.error('No se pudieron detectar typos');
    } finally { setSimilarLoading(p => ({ ...p, [type]: false })); }
  }, [styleCustomer]);

  const toggleSimilar = (type) => {
    const open = !!showSimilar[type];
    setShowSimilar(p => ({ ...p, [type]: !open }));
    if (!open && !similar[type]) loadSimilar(type);
  };

  // Fusiona `drop` → `keep` en una sola llamada al rename endpoint.
  const mergePair = async (type, drop, keep) => {
    if (!window.confirm(
      `¿Fusionar "${drop}" → "${keep}"?\n\n` +
      `1) Renombra en TODAS las filas: inventario, cajas, tickets, UPCs, receiving.\n` +
      `2) Quita "${drop}" del catálogo curado (si estaba).\n` +
      `3) Agrega "${keep}" al catálogo curado (si no estaba).\n\n` +
      `El sistema queda 100% alineado — nada quedará huérfano.`
    )) return;
    setActioning(`merge:${type}:${drop}`);
    try {
      const res = await poster(`/catalogs/${type}/rename`, { old: drop, new: keep });
      if (res.ok) {
        const data = await res.json();
        // El backend ahora tambien sincroniza el catalogo curado: quita `drop`
        // y agrega `keep` si no estaba. Reflejamos eso en el toast + recargamos
        // load() para que la lista curada de la UI (arriba) se actualice.
        const bits = [`${data.modified} fila(s) fusionadas: "${drop}" → "${data.new}"`];
        if (data.catalog_removed) bits.push(`${data.catalog_removed} quitado(s) del catálogo`);
        if (data.catalog_added) bits.push(`${data.catalog_added} agregado(s) al catálogo`);
        toast.success(bits.join(' · '));
        load();
        loadSimilar(type);
        if (sources[type]) loadSources(type);
      } else {
        const err = await res.json().catch(() => ({}));
        toast.error(err.detail || 'Error al fusionar');
      }
    } catch (err) {
      logLoadError('merge')(err);
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
      {/* Catálogo de UPC — el menú del supervisor para dar de alta los códigos
          que el operador escanea en Receiving (Receiving ya no los crea). */}
      <UpcCatalog isManager={isManager} />

      <div className="bg-card/40 border border-border/20 rounded-2xl p-5">
        <h2 className="text-sm font-black uppercase tracking-widest text-foreground mb-1">Catálogos maestros</h2>
        <p className="text-xs text-muted-foreground">
          Una sola lista por catálogo: cada valor muestra su uso real en inventario y un badge
          <b> En cat.</b> si ya está curado (los curados son los únicos que aparecen en Receiving / Agregar Manual).
          Desde aquí puedes <b>promover</b>, <b>quitar del catálogo</b>, <b>renombrar</b> en todas las filas o <b>vaciar</b> basura.
        </p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {SECTIONS.map(section => {
          const Icon = section.icon;
          const isStyles = section.type === 'styles';
          const isScoped = SCOPED_TYPES.includes(section.type);
          const srcData = sources[section.type];
          const srcLoading = !!sourcesLoading[section.type];
          const filteredSources = getFilteredSources(section.type);
          // Contador del header = tamaño de la lista unificada (curados + inventario).
          // Antes eran dos: la lista de arriba mostraba "curados" y el acordeon "inventario".
          const totalCount = srcData?.total_distinct ?? 0;
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
                  {srcLoading ? '…' : totalCount}
                </span>
              </div>

              {/* Tipos por-cliente: elige el cliente al que pertenece esta lista.
                  Estilos EXIGE cliente; colores/fabricantes lo permiten vacío
                  (= valor global compartido para todos los clientes). */}
              {isScoped && (
                <div className="p-3 border-b border-border/10">
                  <label className="text-[9px] font-black uppercase tracking-widest text-muted-foreground/70 block mb-1">
                    Cliente{isStyles ? '' : ' (opcional — vacío = global)'}
                  </label>
                  <select
                    value={styleCustomer}
                    onChange={e => setStyleCustomer(e.target.value)}
                    className="w-full px-3 py-2 bg-background border border-border rounded-lg text-sm font-bold text-foreground focus:ring-2 focus:ring-primary/30"
                    data-testid="style-customer-select"
                  >
                    <option value="">{isStyles ? '— Selecciona cliente —' : '— Global (todos los clientes) —'}</option>
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

              {/* Detector de typos (solo manager) */}
              {isManager && (() => {
                const isOpen = !!showSimilar[section.type];
                const simData = similar[section.type];
                const simLoading = !!similarLoading[section.type];
                const nPairs = simData?.pairs?.length || 0;
                return (
                  <>
                    <button
                      onClick={() => toggleSimilar(section.type)}
                      className={`w-full px-4 py-2.5 border-t border-border/10 flex items-center justify-between text-[11px] font-black uppercase tracking-widest transition-colors ${
                        nPairs > 0 ? 'text-amber-400 hover:bg-amber-500/10' : 'text-muted-foreground hover:bg-secondary/30'
                      }`}
                      data-testid={`similar-toggle-${section.type}`}
                    >
                      <span className="flex items-center gap-2">
                        <Wand2 className="w-3.5 h-3.5" />
                        Detectar typos
                        {simData && (
                          <span className={`px-1.5 py-0.5 rounded text-[9px] tabular-nums ${
                            nPairs > 0 ? 'bg-amber-500/20 text-amber-300' : 'bg-secondary/50 text-muted-foreground'
                          }`}>{nPairs}</span>
                        )}
                      </span>
                      {isOpen ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
                    </button>

                    {isOpen && (
                      <div className="border-t border-border/10 bg-amber-500/[0.03] max-h-[360px] overflow-auto custom-scrollbar">
                        {simLoading ? (
                          <div className="flex items-center justify-center py-8">
                            <Loader2 className="w-5 h-5 animate-spin text-amber-400" />
                          </div>
                        ) : !simData ? (
                          <div className="text-center py-6 text-[10px] text-muted-foreground/60 italic">
                            Cargando…
                          </div>
                        ) : nPairs === 0 ? (
                          <div className="text-center py-6 text-[10px] text-emerald-500 font-bold uppercase tracking-widest">
                            Sin typos detectados
                          </div>
                        ) : (
                          <>
                            <div className="px-3 py-2 text-[9px] font-black uppercase tracking-widest text-amber-400/80 bg-amber-500/10 border-b border-amber-500/20 flex items-center gap-1.5">
                              <AlertTriangle className="w-3 h-3" />
                              Distancia ≤ 2. Revisa: algunos pueden ser colores distintos.
                            </div>
                            <ul className="divide-y divide-border/5">
                              {simData.pairs.map((p, i) => {
                                const drop = p.recommend_drop;
                                const keep = p.recommend_keep;
                                const isBusy = actioning === `merge:${section.type}:${drop}`;
                                const isDrop = (v) => v === drop;
                                return (
                                  <li key={`${p.a}-${p.b}-${i}`} className="px-3 py-2 hover:bg-secondary/20 transition-colors">
                                    <div className="flex items-center gap-2 text-[11px]">
                                      <span className={`font-mono font-bold ${isDrop(p.a) ? 'text-red-400 line-through decoration-red-500/40' : 'text-emerald-400'}`}>
                                        {p.a}
                                      </span>
                                      <span className="text-[8px] text-muted-foreground bg-secondary/60 px-1 rounded tabular-nums">{p.count_a.toLocaleString()}</span>
                                      <ArrowRight className="w-3 h-3 text-muted-foreground/60" />
                                      <span className={`font-mono font-bold ${isDrop(p.b) ? 'text-red-400 line-through decoration-red-500/40' : 'text-emerald-400'}`}>
                                        {p.b}
                                      </span>
                                      <span className="text-[8px] text-muted-foreground bg-secondary/60 px-1 rounded tabular-nums">{p.count_b.toLocaleString()}</span>
                                      <span className="ml-auto text-[8px] bg-amber-500/15 text-amber-400 px-1 rounded">d={p.distance}</span>
                                    </div>
                                    <div className="mt-1.5 flex items-center gap-1.5">
                                      <button
                                        onClick={() => mergePair(section.type, drop, keep)}
                                        disabled={!!actioning}
                                        className="text-[10px] font-black uppercase tracking-widest bg-emerald-500/15 text-emerald-400 hover:bg-emerald-500/25 px-2 py-1 rounded flex items-center gap-1 disabled:opacity-40"
                                      >
                                        {isBusy ? <Loader2 className="w-3 h-3 animate-spin" /> : <Wand2 className="w-3 h-3" />}
                                        Fusionar "{drop}" → "{keep}"
                                      </button>
                                      <button
                                        onClick={() => mergePair(section.type, keep, drop)}
                                        disabled={!!actioning}
                                        className="text-[9px] font-black uppercase tracking-widest text-muted-foreground/60 hover:text-foreground px-2 py-1 rounded"
                                        title="Invertir dirección de la fusión"
                                      >
                                        ⇄
                                      </button>
                                      <button
                                        onClick={() => {
                                          setSimilar(prev => ({
                                            ...prev,
                                            [section.type]: {
                                              ...prev[section.type],
                                              pairs: prev[section.type].pairs.filter((_, idx) => idx !== i),
                                            },
                                          }));
                                        }}
                                        className="ml-auto text-[9px] font-black uppercase tracking-widest text-muted-foreground/40 hover:text-muted-foreground"
                                        title="Ignorar este par (solo en esta sesión)"
                                      >
                                        Ignorar
                                      </button>
                                    </div>
                                  </li>
                                );
                              })}
                            </ul>
                          </>
                        )}
                      </div>
                    )}
                  </>
                );
              })()}

              {/* Lista unificada: curados + valores reales de inventario, con match y contadores. */}
              <div className="border-t border-border/10 bg-secondary/10 flex-1 flex flex-col">
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

                <div className="overflow-auto max-h-[420px] custom-scrollbar">
                  {srcLoading ? (
                    <div className="flex items-center justify-center py-10">
                      <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
                    </div>
                  ) : isStyles && !styleCustomer ? (
                    <div className="text-center py-8 text-[10px] text-muted-foreground/40 font-bold uppercase tracking-widest italic">
                      Selecciona un cliente
                    </div>
                  ) : filteredSources.length === 0 ? (
                    <div className="text-center py-6 text-[10px] text-muted-foreground/40 font-bold uppercase tracking-widest italic">
                      Sin valores
                    </div>
                  ) : (
                    <ul className="divide-y divide-border/5">
                      {filteredSources.map((it, i) => {
                        const isPromoting = actioning === `promote:${section.type}:${it.value}`;
                        const isClearing = actioning === `clear:${section.type}:${it.value}`;
                        const isRemovingCat = deleting === it.catalog_id;
                        return (
                          <li key={`${it.value}-${i}`} className="flex items-center gap-2 px-3 py-1.5 hover:bg-secondary/30 transition-colors group">
                            <span className="text-[12px] font-mono font-bold text-foreground truncate flex-1" title={it.value}>
                              {it.value}
                            </span>
                            <span
                              className={`text-[9px] font-black tabular-nums px-1.5 py-0.5 rounded ${
                                it.count > 0 ? 'text-muted-foreground/70 bg-secondary/40' : 'text-muted-foreground/40 bg-transparent'
                              }`}
                              title={it.count > 0 ? `Aparece en ${it.count} fila(s)` : 'Curado sin uso en inventario'}
                            >
                              {it.count > 0 ? it.count.toLocaleString() : '—'}
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
                            {isManager && it.in_catalog && it.catalog_id && (
                              <button
                                onClick={() => handleDelete(it.catalog_id, it.value, section.type)}
                                disabled={!!actioning || isRemovingCat}
                                className="p-1 text-muted-foreground hover:text-orange-500 hover:bg-orange-500/10 rounded opacity-50 group-hover:opacity-100 transition-all disabled:opacity-30"
                                title="Quitar del catálogo (no afecta inventario)"
                              >
                                {isRemovingCat ? <Loader2 className="w-3 h-3 animate-spin" /> : <X className="w-3 h-3" />}
                              </button>
                            )}
                            {isManager && (
                              <button
                                onClick={() => setRenameModal({ type: section.type, oldValue: it.value, newValue: it.value })}
                                disabled={!!actioning}
                                className="p-1 text-muted-foreground hover:text-yellow-500 hover:bg-yellow-500/10 rounded opacity-50 group-hover:opacity-100 transition-all disabled:opacity-30"
                                title="Renombrar en todas las filas"
                              >
                                <Edit2 className="w-3 h-3" />
                              </button>
                            )}
                            {isManager && it.count > 0 && (
                              <button
                                onClick={() => bulkClearValue(section.type, it.value)}
                                disabled={!!actioning}
                                className="p-1 text-muted-foreground hover:text-red-500 hover:bg-red-500/10 rounded opacity-50 group-hover:opacity-100 transition-all disabled:opacity-30"
                                title="Vaciar valor (afecta inventario)"
                              >
                                {isClearing ? <Loader2 className="w-3 h-3 animate-spin" /> : <Trash2 className="w-3 h-3" />}
                              </button>
                            )}
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </div>
              </div>
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
