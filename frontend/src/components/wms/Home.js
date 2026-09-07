import { useState, useEffect, useCallback, useMemo } from "react";
import { toast } from "sonner";
import { Loader2, Plus, Trash2, Tag, MapPin, Layers, ChevronDown, ChevronUp, Search, Edit2, ArrowUpToLine, X, Users, Palette, Shirt, Ruler, Lock, Wand2, AlertTriangle, ArrowRight, Factory } from "lucide-react";
import { useLang } from "../../contexts/LanguageContext";
import { fetcher, poster, putter, deleter, logLoadError, refreshWmsSizes, refreshWmsColors, refreshWmsCatalogs, API } from "./lib";
import { UpcCatalog } from "./UpcCatalog";
import { Btn, cls } from "./ui";

const SECTIONS = [
  // Receiving identity catalogs — locked dropdowns; only lead/supervisor may edit.
  // Rediseño 2026-07: paleta neutra — el color ya no distingue catálogos.
  // labelKey/descKey se traducen en el render con t() (constante fuera del componente).
  { type: 'customers', labelKey: 'wms_cat_customers', descKey: 'wms_cat_customers_desc', icon: Users, color: 'text-muted-foreground', bg: 'bg-muted', border: 'border-border' },
  { type: 'manufacturers', labelKey: 'wms_cat_manufacturers', descKey: 'wms_cat_manufacturers_desc', icon: Factory, color: 'text-muted-foreground', bg: 'bg-muted', border: 'border-border' },
  { type: 'styles', labelKey: 'wms_cat_styles', descKey: 'wms_cat_styles_desc', icon: Shirt, color: 'text-muted-foreground', bg: 'bg-muted', border: 'border-border' },
  { type: 'colors', labelKey: 'wms_cat_colors', descKey: 'wms_cat_colors_desc', icon: Palette, color: 'text-muted-foreground', bg: 'bg-muted', border: 'border-border' },
  { type: 'sizes', labelKey: 'wms_cat_sizes', descKey: 'wms_cat_sizes_desc', icon: Ruler, color: 'text-muted-foreground', bg: 'bg-muted', border: 'border-border' },
  { type: 'descriptions', labelKey: 'wms_cat_descriptions', descKey: 'wms_cat_descriptions_desc', icon: Tag, color: 'text-muted-foreground', bg: 'bg-muted', border: 'border-border' },
  { type: 'countries', labelKey: 'wms_cat_countries', descKey: 'wms_cat_countries_desc', icon: MapPin, color: 'text-muted-foreground', bg: 'bg-muted', border: 'border-border' },
  { type: 'fabrics', labelKey: 'wms_cat_fabrics', descKey: 'wms_cat_fabrics_desc', icon: Layers, color: 'text-muted-foreground', bg: 'bg-muted', border: 'border-border' },
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
  const [isSupersu, setIsSupersu] = useState(false);
  useEffect(() => {
    fetch(`${process.env.REACT_APP_BACKEND_URL}/api/auth/me`, { credentials: 'include' })
      .then(r => r.ok ? r.json() : null)
      .then(u => {
        const level = u?.role === 'supersu' ? 5 : (u?.role === 'admin' ? Math.max(1, parseInt(u?.admin_level || 1)) : 0);
        setIsManager(level >= 3);
        setIsSupersu(u?.role === 'supersu');
      })
      .catch(() => {});
  }, []);

  // Acceso por módulo del WMS (delegable) — solo supersu. Mismo panel que vive en
  // User Management, aquí a la mano dentro del WMS. Define qué nivel abre cada
  // módulo sensible; se aplica en el menú y lo valida el backend.
  const [moduleAccess, setModuleAccess] = useState(null);
  const [savingAccess, setSavingAccess] = useState(false);
  const [showAccess, setShowAccess] = useState(false);
  const loadModuleAccess = useCallback(() => {
    fetcher('/module-access').then(setModuleAccess).catch(logLoadError('module access'));
  }, []);
  useEffect(() => { loadModuleAccess(); }, [loadModuleAccess]);
  const saveModuleAccess = async (moduleId, level) => {
    const nextLevels = { ...(moduleAccess?.levels || {}), [moduleId]: Number(level) };
    setModuleAccess(a => ({ ...a, levels: nextLevels }));
    setSavingAccess(true);
    try {
      const res = await putter('/module-access', { levels: nextLevels });
      if (res.ok) { const d = await res.json(); setModuleAccess(a => ({ ...a, levels: d.levels || nextLevels })); toast.success(t('wms_access_updated')); }
      else { const e = await res.json().catch(() => ({})); toast.error(e.detail || t('wms_access_save_err')); loadModuleAccess(); }
    } catch { toast.error(t('wms_conn_err')); loadModuleAccess(); }
    finally { setSavingAccess(false); }
  };

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
      toast.error(t('wms_cat_sources_err', { type }));
    } finally { setSourcesLoading(p => ({ ...p, [type]: false })); }
  }, [styleCustomer, t]);

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
    SCOPED_TYPES.forEach(ty => {
      loadSources(ty);
      if (showSimilar[ty]) loadSimilar(ty);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [styleCustomer]);

  const handleAdd = async (type) => {
    const value = drafts[type]?.trim();
    if (!value) { toast.error(t('wms_cat_enter_value')); return; }
    if (type === 'styles' && !styleCustomer) { toast.error(t('wms_cat_select_customer_first')); return; }
    setSaving(type);
    try {
      // Tipos por-cliente adjuntan el cliente seleccionado; si está vacío (permitido
      // en colores/fabricantes) el valor se guarda como global compartido.
      const body = SCOPED_TYPES.includes(type) ? { type, value, customer: styleCustomer } : { type, value };
      const res = await poster('/catalogs', body);
      if (res.ok) {
        toast.success(t('wms_cat_added_to', { name: t(SECTIONS.find(s => s.type === type)?.labelKey) }));
        setDrafts(prev => ({ ...prev, [type]: '' }));
        if (type === 'sizes') refreshWmsSizes();    // live-refresh size selectors
        if (type === 'colors') refreshWmsColors();  // live-refresh color selectors
        refreshWmsCatalogs();                       // refresca listas fusionadas (customer/desc/país/fabric/style) en otros módulos
        load();
        if (sources[type]) loadSources(type); // refresh in_catalog flags
      } else {
        const err = await res.json().catch(() => ({}));
        toast.error(err.detail || t('wms_cat_add_err'));
      }
    } catch (err) {
      logLoadError('add catalog')(err);
      toast.error(t('wms_conn_err'));
    } finally { setSaving(null); }
  };

  const handleDelete = async (catalog_id, value, type) => {
    if (!window.confirm(t('wms_cat_remove_confirm', { value }))) return;
    setDeleting(catalog_id);
    try {
      await deleter(`/catalogs/${catalog_id}`);
      toast.success(t('wms_cat_removed'));
      refreshWmsSizes();  // in case a size was removed
      load();
      if (type && sources[type]) loadSources(type);
    } catch (err) {
      logLoadError('delete catalog')(err);
      toast.error(t('wms_cat_remove_err'));
    } finally { setDeleting(null); }
  };

  // Promote a raw inventory value to the curated catalog.
  const promoteToCatalog = async (type, value) => {
    setActioning(`promote:${type}:${value}`);
    try {
      const res = await poster('/catalogs', { type, value });
      if (res.ok) {
        toast.success(t('wms_cat_promoted', { value }));
        await Promise.all([load(), loadSources(type)]);
      } else {
        const err = await res.json().catch(() => ({}));
        toast.error(err.detail || t('error'));
      }
    } catch (err) {
      logLoadError('promote')(err);
      toast.error(t('wms_conn_err'));
    } finally { setActioning(null); }
  };

  // Sweep a value across inventory + receiving (e.g. fix a typo for every row).
  const submitRename = async () => {
    if (!renameModal) return;
    const { type, oldValue, newValue } = renameModal;
    const newClean = (newValue || '').trim();
    if (!newClean) { toast.error(t('wms_cat_enter_new_value')); return; }
    if (newClean.toUpperCase() === oldValue.toUpperCase()) {
      toast.error(t('wms_cat_must_differ')); return;
    }
    setActioning(`rename:${type}:${oldValue}`);
    try {
      const res = await poster(`/catalogs/${type}/rename`, { old: oldValue, new: newClean });
      if (res.ok) {
        const data = await res.json();
        const bits = [t('wms_cat_renamed_rows', { n: data.modified, old: oldValue, new: data.new })];
        if (data.catalog_removed) bits.push(t('wms_cat_n_removed', { n: data.catalog_removed }));
        if (data.catalog_added) bits.push(t('wms_cat_n_added', { n: data.catalog_added }));
        toast.success(bits.join(' · '));
        setRenameModal(null);
        load();
        loadSources(type);
      } else {
        const err = await res.json().catch(() => ({}));
        toast.error(err.detail || t('wms_cat_rename_err'));
      }
    } catch (err) {
      logLoadError('rename catalog value')(err);
      toast.error(t('wms_conn_err'));
    } finally { setActioning(null); }
  };

  // Wipe a value across inventory + receiving (sets to empty string).
  const bulkClearValue = async (type, value) => {
    if (!window.confirm(t('wms_cat_clear_confirm', { value, type }))) return;
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
        toast.success(t('wms_cat_rows_cleared', { n: data.modified }));
        loadSources(type);
      } else {
        const err = await res.json().catch(() => ({}));
        toast.error(err.detail || t('error'));
      }
    } catch (err) {
      logLoadError('clear catalog value')(err);
      toast.error(t('wms_conn_err'));
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
      toast.error(t('wms_cat_typos_err'));
    } finally { setSimilarLoading(p => ({ ...p, [type]: false })); }
  }, [styleCustomer, t]);

  const toggleSimilar = (type) => {
    const open = !!showSimilar[type];
    setShowSimilar(p => ({ ...p, [type]: !open }));
    if (!open && !similar[type]) loadSimilar(type);
  };

  // Fusiona `drop` → `keep` en una sola llamada al rename endpoint.
  const mergePair = async (type, drop, keep) => {
    if (!window.confirm(t('wms_cat_merge_confirm', { drop, keep }))) return;
    setActioning(`merge:${type}:${drop}`);
    try {
      const res = await poster(`/catalogs/${type}/rename`, { old: drop, new: keep });
      if (res.ok) {
        const data = await res.json();
        // El backend ahora tambien sincroniza el catalogo curado: quita `drop`
        // y agrega `keep` si no estaba. Reflejamos eso en el toast + recargamos
        // load() para que la lista curada de la UI (arriba) se actualice.
        const bits = [t('wms_cat_merged_rows', { n: data.modified, drop, keep: data.new })];
        if (data.catalog_removed) bits.push(t('wms_cat_n_removed', { n: data.catalog_removed }));
        if (data.catalog_added) bits.push(t('wms_cat_n_added', { n: data.catalog_added }));
        toast.success(bits.join(' · '));
        load();
        loadSimilar(type);
        if (sources[type]) loadSources(type);
      } else {
        const err = await res.json().catch(() => ({}));
        toast.error(err.detail || t('wms_cat_merge_err'));
      }
    } catch (err) {
      logLoadError('merge')(err);
      toast.error(t('wms_conn_err'));
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
      {/* Acceso por módulo del WMS — solo supersu decide qué nivel abre cada
          módulo sensible (Auditoría, Incidencias). Se aplica en el menú del WMS
          y lo valida el backend. El mismo panel existe en User Management. */}
      {isSupersu && moduleAccess && Object.keys(moduleAccess.defaults || {}).length > 0 && (
        <div className="bg-card border border-border rounded-lg overflow-hidden">
          <button onClick={() => setShowAccess(s => !s)}
            className="w-full flex items-center justify-between px-5 py-4 hover:bg-muted/40 transition-colors">
            <span className="flex items-center gap-2 text-sm font-semibold text-foreground">
              <Lock className="w-4 h-4 text-primary" /> {t('users_wms_module_access')}
            </span>
            {showAccess ? <ChevronUp className="w-4 h-4 text-muted-foreground" /> : <ChevronDown className="w-4 h-4 text-muted-foreground" />}
          </button>
          {showAccess && (
            <div className="px-5 pb-5 space-y-3">
              <p className="text-xs text-muted-foreground -mt-1">
                {t('users_wms_module_access_help_1')} <span className="text-primary font-semibold">backend</span>{' '}
                {t('users_wms_module_access_help_2')}
              </p>
              {(moduleAccess.order || Object.keys(moduleAccess.defaults || {})).map(id => {
                const soloLevel = moduleAccess.supersu_only_level || 6;
                const lvl = (moduleAccess.levels || {})[id] ?? moduleAccess.defaults[id];
                const enforced = (moduleAccess.enforced || []).includes(id);
                return (
                  <div key={id} className="flex items-center justify-between gap-3 bg-muted/30 border border-border rounded-md px-4 py-3">
                    <span className="text-sm font-medium text-foreground flex items-center gap-2">
                      {(moduleAccess.labels || {})[id] || id}
                      {enforced && <span className="text-[9px] font-black uppercase tracking-widest text-primary bg-primary/10 border border-primary/30 rounded px-1.5 py-0.5">backend</span>}
                    </span>
                    <select
                      value={String(lvl)}
                      onChange={e => saveModuleAccess(id, e.target.value)}
                      disabled={savingAccess}
                      className="w-48 px-3 py-2 bg-card border border-input rounded-md text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring/25 disabled:opacity-50"
                    >
                      <option value="0">{t('all_boards')}</option>
                      {[1, 2, 3, 4, 5].map(n => <option key={n} value={String(n)}>{t('users_admin_level_plus', { n })}</option>)}
                      <option value={String(soloLevel)}>{t('users_supersu_only')}</option>
                    </select>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* Catálogo de UPC — el menú del supervisor para dar de alta los códigos
          que el operador escanea en Receiving (Receiving ya no los crea). */}
      <UpcCatalog isManager={isManager} />

      <div className="bg-card border border-border rounded-lg p-5">
        <h2 className="text-sm font-semibold text-foreground mb-1">{t('wms_cat_master_title')}</h2>
        <p className="text-xs text-muted-foreground">
          {t('wms_cat_master_help_1')}
          <b> {t('wms_cat_in_cat')}</b> {t('wms_cat_master_help_2')}
          {' '}{t('wms_cat_help_from_here')} <b>{t('wms_cat_help_promote')}</b>, <b>{t('wms_cat_help_remove')}</b>, <b>{t('wms_cat_help_rename')}</b> {t('wms_cat_help_rename_tail')} <b>{t('wms_cat_help_clear')}</b> {t('wms_cat_help_clear_tail')}
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
            <div key={section.type} className={`border ${section.border} rounded-lg bg-card flex flex-col`}>
              {/* Header */}
              <div className="p-5 border-b border-border flex items-center gap-3">
                <div className={`w-10 h-10 rounded-lg ${section.bg} flex items-center justify-center`}>
                  <Icon className={`w-5 h-5 ${section.color}`} />
                </div>
                <div className="flex-1 min-w-0">
                  <h3 className="text-sm font-semibold">{t(section.labelKey)}</h3>
                  <p className="text-xs text-muted-foreground leading-tight">{t(section.descKey)}</p>
                </div>
                <span className="text-xs font-medium tabular-nums bg-muted px-2 py-1 rounded-md text-muted-foreground">
                  {srcLoading ? '…' : totalCount}
                </span>
              </div>

              {/* Tipos por-cliente: elige el cliente al que pertenece esta lista.
                  Estilos EXIGE cliente; colores/fabricantes lo permiten vacío
                  (= valor global compartido para todos los clientes). */}
              {isScoped && (
                <div className="p-3 border-b border-border/60">
                  <label className="text-xs font-medium text-muted-foreground block mb-1">
                    {t('wms_label_customer')}{isStyles ? '' : ` ${t('wms_cat_optional_global')}`}
                  </label>
                  <select
                    value={styleCustomer}
                    onChange={e => setStyleCustomer(e.target.value)}
                    className="w-full px-3 py-2 bg-card border border-input rounded-md text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring/25"
                    data-testid="style-customer-select"
                  >
                    <option value="">{isStyles ? t('wms_cat_select_customer_opt') : t('wms_cat_global_opt')}</option>
                    {customers.map(c => <option key={c} value={c}>{c}</option>)}
                  </select>
                </div>
              )}

              {/* Add new — lead/supervisor only */}
              {isManager ? (
                <div className="p-4 border-b border-border/60 flex gap-2">
                  <input
                    type="text"
                    value={drafts[section.type]}
                    onChange={e => setDrafts(p => ({ ...p, [section.type]: e.target.value }))}
                    onKeyDown={e => { if (e.key === 'Enter') handleAdd(section.type); }}
                    placeholder={isStyles && !styleCustomer ? t('samples_select_client') : t('wms_cat_new_value_ph')}
                    disabled={isStyles && !styleCustomer}
                    className={`flex-1 ${cls.input} disabled:opacity-50`}
                    data-testid={`cat-input-${section.type}`}
                  />
                  <Btn
                    onClick={() => handleAdd(section.type)}
                    disabled={saving === section.type || !drafts[section.type]?.trim() || (isStyles && !styleCustomer)}
                    data-testid={`cat-add-${section.type}`}
                  >
                    {saving === section.type ? <Loader2 className="w-3 h-3 animate-spin" /> : <Plus className="w-3 h-3" />}
                    {t('add')}
                  </Btn>
                </div>
              ) : (
                <div className="p-3 border-b border-border/60 flex items-center gap-2 text-xs font-medium text-muted-foreground">
                  <Lock className="w-3 h-3" /> {t('wms_cat_manager_only')}
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
                      className={`w-full px-4 py-2.5 border-t border-border/60 flex items-center justify-between text-xs font-medium transition-colors ${
                        nPairs > 0 ? 'text-amber-600 dark:text-amber-400 hover:bg-amber-500/10' : 'text-muted-foreground hover:bg-muted/40'
                      }`}
                      data-testid={`similar-toggle-${section.type}`}
                    >
                      <span className="flex items-center gap-2">
                        <Wand2 className="w-3.5 h-3.5" />
                        {t('wms_cat_detect_typos')}
                        {simData && (
                          <span className={`px-1.5 py-0.5 rounded text-xs tabular-nums ${
                            nPairs > 0 ? 'bg-amber-500/15 text-amber-700 dark:text-amber-300' : 'bg-muted text-muted-foreground'
                          }`}>{nPairs}</span>
                        )}
                      </span>
                      {isOpen ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
                    </button>

                    {isOpen && (
                      <div className="border-t border-border/60 bg-amber-500/[0.03] max-h-[360px] overflow-auto custom-scrollbar">
                        {simLoading ? (
                          <div className="flex items-center justify-center py-8">
                            <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
                          </div>
                        ) : !simData ? (
                          <div className="text-center py-6 text-xs text-muted-foreground">
                            {t('loading')}
                          </div>
                        ) : nPairs === 0 ? (
                          <div className="text-center py-6 text-xs font-medium text-emerald-600 dark:text-emerald-400">
                            {t('wms_cat_no_typos')}
                          </div>
                        ) : (
                          <>
                            <div className="px-3 py-2 text-xs font-medium text-amber-700 dark:text-amber-300 bg-amber-50 dark:bg-amber-500/10 border-b border-amber-200/70 dark:border-amber-500/20 flex items-center gap-1.5">
                              <AlertTriangle className="w-3 h-3" />
                              {t('wms_cat_typos_hint')}
                            </div>
                            <ul className="divide-y divide-border/60">
                              {simData.pairs.map((p, i) => {
                                const drop = p.recommend_drop;
                                const keep = p.recommend_keep;
                                const isBusy = actioning === `merge:${section.type}:${drop}`;
                                const isDrop = (v) => v === drop;
                                return (
                                  <li key={`${p.a}-${p.b}-${i}`} className="px-3 py-2 hover:bg-muted/40 transition-colors">
                                    <div className="flex items-center gap-2 text-xs">
                                      <span className={`font-mono font-medium ${isDrop(p.a) ? 'text-red-600 dark:text-red-400 line-through decoration-red-500/40' : 'text-emerald-600 dark:text-emerald-400'}`}>
                                        {p.a}
                                      </span>
                                      <span className="text-[10px] text-muted-foreground bg-muted px-1 rounded tabular-nums">{p.count_a.toLocaleString()}</span>
                                      <ArrowRight className="w-3 h-3 text-muted-foreground/60" />
                                      <span className={`font-mono font-medium ${isDrop(p.b) ? 'text-red-600 dark:text-red-400 line-through decoration-red-500/40' : 'text-emerald-600 dark:text-emerald-400'}`}>
                                        {p.b}
                                      </span>
                                      <span className="text-[10px] text-muted-foreground bg-muted px-1 rounded tabular-nums">{p.count_b.toLocaleString()}</span>
                                      <span className="ml-auto text-[10px] bg-amber-500/15 text-amber-700 dark:text-amber-300 px-1 rounded">d={p.distance}</span>
                                    </div>
                                    <div className="mt-1.5 flex items-center gap-1.5">
                                      <button
                                        onClick={() => mergePair(section.type, drop, keep)}
                                        disabled={!!actioning}
                                        className="text-xs font-medium border bg-emerald-50 text-emerald-700 border-emerald-200 hover:bg-emerald-100 dark:bg-emerald-500/10 dark:text-emerald-300 dark:border-emerald-500/25 dark:hover:bg-emerald-500/20 px-2 py-1 rounded-md flex items-center gap-1 transition-colors disabled:opacity-40"
                                      >
                                        {isBusy ? <Loader2 className="w-3 h-3 animate-spin" /> : <Wand2 className="w-3 h-3" />}
                                        {t('wms_cat_merge_btn', { drop, keep })}
                                      </button>
                                      <button
                                        onClick={() => mergePair(section.type, keep, drop)}
                                        disabled={!!actioning}
                                        className="text-xs font-medium text-muted-foreground hover:text-foreground px-2 py-1 rounded"
                                        title={t('wms_cat_merge_invert')}
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
                                        className="ml-auto text-xs font-medium text-muted-foreground/60 hover:text-muted-foreground"
                                        title={t('wms_cat_ignore_pair_title')}
                                      >
                                        {t('wms_cat_ignore')}
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
              <div className="border-t border-border/60 bg-muted/20 flex-1 flex flex-col">
                <div className="p-3 border-b border-border/60">
                  <div className="relative">
                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground/60" />
                    <input
                      type="text"
                      value={sourceSearch[section.type]}
                      onChange={e => setSourceSearch(p => ({ ...p, [section.type]: e.target.value }))}
                      placeholder={t('wms_cat_filter_values_ph')}
                      className="w-full pl-9 pr-3 py-1.5 bg-card border border-input rounded-md text-xs placeholder:text-muted-foreground/60 focus:outline-none focus:ring-2 focus:ring-ring/25 transition-colors"
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
                    <div className="text-center py-8 text-sm text-muted-foreground">
                      {t('wms_cat_select_customer')}
                    </div>
                  ) : filteredSources.length === 0 ? (
                    <div className="text-center py-6 text-sm text-muted-foreground">
                      {t('wms_cat_no_values')}
                    </div>
                  ) : (
                    <ul className="divide-y divide-border/60">
                      {filteredSources.map((it, i) => {
                        const isPromoting = actioning === `promote:${section.type}:${it.value}`;
                        const isClearing = actioning === `clear:${section.type}:${it.value}`;
                        const isRemovingCat = deleting === it.catalog_id;
                        return (
                          <li key={`${it.value}-${i}`} className="flex items-center gap-2 px-3 py-1.5 hover:bg-muted/40 transition-colors group">
                            <span className="text-xs font-mono font-medium text-foreground truncate flex-1" title={it.value}>
                              {it.value}
                            </span>
                            <span
                              className={`text-xs font-medium tabular-nums px-1.5 py-0.5 rounded ${
                                it.count > 0 ? 'text-muted-foreground bg-muted/60' : 'text-muted-foreground/50 bg-transparent'
                              }`}
                              title={it.count > 0 ? t('wms_cat_appears_in_rows', { n: it.count }) : t('wms_cat_curated_unused')}
                            >
                              {it.count > 0 ? it.count.toLocaleString() : '—'}
                            </span>
                            {it.in_catalog && (
                              <span className={`text-xs font-medium ${section.color} ${section.bg} border border-border px-1.5 py-0.5 rounded-md whitespace-nowrap`}>
                                {t('wms_cat_in_cat')}
                              </span>
                            )}
                            {isManager && !it.in_catalog && (
                              <button
                                onClick={() => promoteToCatalog(section.type, it.value)}
                                disabled={!!actioning}
                                className="p-1 text-muted-foreground hover:text-primary hover:bg-primary/10 rounded opacity-50 group-hover:opacity-100 transition-all disabled:opacity-30"
                                title={t('wms_cat_promote_title')}
                              >
                                {isPromoting ? <Loader2 className="w-3 h-3 animate-spin" /> : <ArrowUpToLine className="w-3 h-3" />}
                              </button>
                            )}
                            {isManager && it.in_catalog && it.catalog_id && (
                              <button
                                onClick={() => handleDelete(it.catalog_id, it.value, section.type)}
                                disabled={!!actioning || isRemovingCat}
                                className="p-1 text-muted-foreground hover:text-amber-600 dark:hover:text-amber-400 hover:bg-amber-500/10 rounded opacity-50 group-hover:opacity-100 transition-all disabled:opacity-30"
                                title={t('wms_cat_remove_title')}
                              >
                                {isRemovingCat ? <Loader2 className="w-3 h-3 animate-spin" /> : <X className="w-3 h-3" />}
                              </button>
                            )}
                            {isManager && (
                              <button
                                onClick={() => setRenameModal({ type: section.type, oldValue: it.value, newValue: it.value })}
                                disabled={!!actioning}
                                className="p-1 text-muted-foreground hover:text-amber-600 dark:hover:text-amber-400 hover:bg-amber-500/10 rounded opacity-50 group-hover:opacity-100 transition-all disabled:opacity-30"
                                title={t('wms_cat_rename_title')}
                              >
                                <Edit2 className="w-3 h-3" />
                              </button>
                            )}
                            {isManager && it.count > 0 && (
                              <button
                                onClick={() => bulkClearValue(section.type, it.value)}
                                disabled={!!actioning}
                                className="p-1 text-muted-foreground hover:text-red-600 dark:hover:text-red-400 hover:bg-red-500/10 rounded opacity-50 group-hover:opacity-100 transition-all disabled:opacity-30"
                                title={t('wms_cat_clear_title')}
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
            <div className="bg-card border border-border rounded-lg w-full max-w-md shadow-xl animate-in zoom-in-95 duration-150">
              <div className="flex items-center justify-between p-5 border-b border-border/20">
                <div className="flex items-center gap-3 min-w-0">
                  <div className="w-10 h-10 rounded-lg bg-muted flex items-center justify-center flex-shrink-0">
                    <Edit2 className="w-5 h-5 text-muted-foreground" />
                  </div>
                  <div className="min-w-0">
                    <h3 className="font-semibold text-sm truncate">{t('wms_cat_rename_in', { name: t(section?.labelKey) })}</h3>
                    <p className="text-xs text-muted-foreground truncate">{t('wms_cat_rename_affects')}</p>
                  </div>
                </div>
                <button onClick={() => setRenameModal(null)} className="p-2 hover:bg-secondary rounded-lg" disabled={actioning?.startsWith('rename:')}>
                  <X className="w-5 h-5" />
                </button>
              </div>

              <div className="p-5 space-y-4">
                <div>
                  <label className="text-xs font-medium text-muted-foreground block mb-1">{t('wms_cat_current_value')}</label>
                  <div className="px-3 py-2 border rounded-md text-sm font-mono font-medium bg-red-50 border-red-200 text-red-700 dark:bg-red-500/10 dark:border-red-500/25 dark:text-red-300">
                    {renameModal.oldValue}
                  </div>
                </div>
                <div>
                  <label className="text-xs font-medium text-muted-foreground block mb-1">{t('wms_cat_change_to')}</label>
                  <input
                    type="text"
                    value={renameModal.newValue}
                    onChange={e => setRenameModal(p => ({ ...p, newValue: e.target.value.toUpperCase() }))}
                    onKeyDown={e => { if (e.key === 'Enter') submitRename(); }}
                    placeholder={t('wms_cat_rename_ph')}
                    className={`${cls.input} font-mono`}
                    autoFocus
                    data-testid="rename-input"
                  />
                  {suggestions.length > 0 && (
                    <div className="mt-2 flex flex-wrap gap-1">
                      <span className="text-xs font-medium text-muted-foreground/70 self-center mr-1">{t('wms_cat_suggestions')}</span>
                      {suggestions.map(s => (
                        <button
                          key={s}
                          onClick={() => setRenameModal(p => ({ ...p, newValue: s }))}
                          className="px-2 py-0.5 text-xs font-mono font-medium bg-muted hover:bg-primary/10 hover:text-primary rounded-md transition-colors"
                        >
                          {s}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              </div>

              <div className="flex items-center justify-end gap-2 p-5 border-t border-border/20">
                <Btn variant="ghost" onClick={() => setRenameModal(null)} disabled={actioning?.startsWith('rename:')}>
                  {t('cancel')}
                </Btn>
                <Btn
                  variant="primary"
                  onClick={submitRename}
                  disabled={actioning?.startsWith('rename:') || !renameModal.newValue?.trim()}
                  data-testid="rename-submit"
                >
                  {actioning?.startsWith('rename:') ? <Loader2 className="w-4 h-4 animate-spin" /> : <Edit2 className="w-4 h-4" />}
                  {t('dash_apply')}
                </Btn>
              </div>
            </div>
          </div>
        );
      })()}
    </div>
  );
};
