/* Sistema → Configuración → Permisos.
   Dos tablas:
   · Por ACCIÓN (nuevo): cada acción del WMS (crear ubicaciones, aprobar conteos,
     resolver tareas…) con dos escaleras — admin mínimo e inventarios mínimo —;
     el usuario pasa si cumple cualquiera. Pisos (no se puede bajar de X) y
     candado vienen del backend (wms_actions.py). Antes de guardar se ve quién
     gana y quién pierde cada acción (POST /permissions/preview).
   · Por MÓDULO (ya existía en Configuración WMS): nivel de admin que abre cada
     módulo en el menú. Se movió aquí sin cambios de contrato. */
import { useCallback, useEffect, useMemo, useState } from "react";
import { Lock, ShieldCheck, RotateCcw, Eye, Save, Loader2, UserPlus, UserMinus } from "lucide-react";
import { toast } from "sonner";
import { fetcher, putter, poster, logLoadError } from "./lib";
import { useLang } from "../../contexts/LanguageContext";
import { useWms } from "./lib";
import { Btn } from "./ui";

const sameLv = (a, b) => (a?.admin ?? null) === (b?.admin ?? null) && (a?.inventory ?? null) === (b?.inventory ?? null);

export const PermissionsPanel = () => {
  const { t } = useLang();
  const { refreshPermissions } = useWms();
  const [cat, setCat] = useState(null);          // GET /permissions
  const [draft, setDraft] = useState({});        // {id: {admin, inventory}} editado
  const [preview, setPreview] = useState(null);  // impact por acción
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const d = await fetcher('/permissions');
      setCat(d); setDraft(d.levels || {}); setPreview(null);
    } catch (e) { logLoadError('permissions')(e); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const changed = useMemo(() => {
    if (!cat) return {};
    const out = {};
    for (const a of cat.actions) if (!sameLv(draft[a.id], cat.levels[a.id])) out[a.id] = draft[a.id];
    return out;
  }, [cat, draft]);
  const nChanged = Object.keys(changed).length;

  const setLv = (id, ladder, raw) => {
    const v = raw === '' ? null : Number(raw);
    setDraft(d => ({ ...d, [id]: { ...(d[id] || {}), [ladder]: v } }));
    setPreview(null);
  };

  const doPreview = async () => {
    setBusy(true);
    try {
      const res = await poster('/permissions/preview', { levels: changed });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) { toast.error(d.detail || t('wms_perm_err')); return; }
      setPreview(d.impact || {});
    } catch { toast.error(t('wms_conn_err')); }
    finally { setBusy(false); }
  };

  const save = async () => {
    setBusy(true);
    try {
      const res = await putter('/permissions', { levels: changed });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) { toast.error(d.detail || t('wms_perm_err')); return; }
      toast.success(t('wms_perm_saved', { n: Object.keys(d.changed || {}).length }));
      setCat(c => ({ ...c, levels: d.levels })); setDraft(d.levels); setPreview(null);
      refreshPermissions?.();
    } catch { toast.error(t('wms_conn_err')); }
    finally { setBusy(false); }
  };

  const adminOptions = (a) => {
    const opts = [];
    const floor = a.floor_admin ?? 0;
    if (floor <= 0) opts.push({ v: 0, label: t('wms_perm_everyone') });
    for (let n = Math.max(1, floor); n <= (cat?.max_admin || 5); n++) opts.push({ v: n, label: t('users_admin_level_plus', { n }) });
    opts.push({ v: cat?.supersu_level ?? 6, label: t('users_supersu_only') });
    return opts;
  };
  const invOptions = (a) => {
    if (a.floor_inventory === 'off') return null;
    const opts = [];
    const floor = a.floor_inventory ?? 0;
    if (floor <= 0) opts.push({ v: 0, label: t('wms_perm_everyone') });
    for (let n = Math.max(1, floor); n <= (cat?.max_inventory || 3); n++) opts.push({ v: n, label: t('wms_perm_inv_level_plus', { n }) });
    return opts;
  };

  if (!cat) return <div className="flex items-center justify-center py-16"><Loader2 className="w-6 h-6 animate-spin text-primary" /></div>;

  return (
    <div className="space-y-6" data-testid="wms-permissions">
      <div className="bg-card border border-border rounded-lg p-5 space-y-1">
        <h2 className="text-sm font-semibold text-foreground flex items-center gap-2"><ShieldCheck className="w-4 h-4 text-primary" /> {t('wms_perm_title')}</h2>
        <p className="text-xs text-muted-foreground leading-relaxed">{t('wms_perm_help')}</p>
      </div>

      {/* Barra de acciones: sticky para que con 25 filas no haya que subir a guardar */}
      <div className="sticky top-0 z-10 flex flex-wrap items-center gap-2 bg-background/95 backdrop-blur-sm border border-border rounded-lg px-4 py-2.5">
        <span className={`text-xs font-medium ${nChanged ? 'text-amber-600 dark:text-amber-400' : 'text-muted-foreground'}`} data-testid="perm-changed-count">
          {nChanged ? t('wms_perm_n_changed', { n: nChanged }) : t('wms_perm_no_changes')}
        </span>
        <div className="ml-auto flex items-center gap-2">
          <Btn onClick={() => { setDraft(cat.levels); setPreview(null); }} disabled={!nChanged || busy}><RotateCcw className="w-4 h-4" /> {t('wms_perm_discard')}</Btn>
          <Btn variant="secondary" onClick={doPreview} disabled={!nChanged || busy} data-testid="perm-preview"><Eye className="w-4 h-4" /> {t('wms_perm_preview')}</Btn>
          <Btn variant="primary" onClick={save} disabled={!nChanged || busy} data-testid="perm-save"><Save className="w-4 h-4" /> {t('wms_perm_save')}</Btn>
        </div>
      </div>

      {preview && (
        <div className="bg-card border border-amber-500/30 rounded-lg p-4 space-y-2" data-testid="perm-impact">
          <div className="text-xs font-semibold text-amber-600 dark:text-amber-400">{t('wms_perm_impact_title')}</div>
          {Object.keys(preview).length === 0 && <div className="text-xs text-muted-foreground">{t('wms_perm_impact_none')}</div>}
          {Object.entries(preview).map(([id, im]) => {
            const a = cat.actions.find(x => x.id === id);
            return (
              <div key={id} className="text-xs border-t border-border/60 pt-2">
                <div className="font-medium text-foreground">{a?.label || id} <span className="text-muted-foreground">· {t('wms_perm_total_users', { n: im.total })}</span></div>
                {im.gain.length > 0 && <div className="text-emerald-600 dark:text-emerald-400 flex items-start gap-1"><UserPlus className="w-3.5 h-3.5 mt-0.5 shrink-0" /><span>{t('wms_perm_gain')}: {im.gain.join(', ')}</span></div>}
                {im.lose.length > 0 && <div className="text-red-600 dark:text-red-400 flex items-start gap-1"><UserMinus className="w-3.5 h-3.5 mt-0.5 shrink-0" /><span>{t('wms_perm_lose')}: {im.lose.join(', ')}</span></div>}
                {im.gain.length === 0 && im.lose.length === 0 && <div className="text-muted-foreground">{t('wms_perm_no_user_change')}</div>}
              </div>
            );
          })}
        </div>
      )}

      <div className="bg-card border border-border rounded-lg overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-muted/50">
              <tr>
                <th className="px-4 py-2.5 text-left text-xs font-semibold text-muted-foreground">{t('wms_perm_col_action')}</th>
                <th className="px-4 py-2.5 text-left text-xs font-semibold text-muted-foreground w-52">{t('wms_perm_col_admin')}</th>
                <th className="px-4 py-2.5 text-left text-xs font-semibold text-muted-foreground w-52">{t('wms_perm_col_inventory')}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border/60">
              {cat.groups.map(g => {
                const rows = cat.actions.filter(a => a.group === g.id);
                if (!rows.length) return null;
                return [
                  <tr key={`g-${g.id}`} className="bg-muted/30">
                    <td colSpan={3} className="px-4 py-1.5 text-[11px] font-bold uppercase tracking-widest text-primary">{g.label}</td>
                  </tr>,
                  ...rows.map(a => {
                    const lv = draft[a.id] || {};
                    const dirty = !!changed[a.id];
                    const invOpts = invOptions(a);
                    const isDefault = sameLv(lv, a.default);
                    return (
                      <tr key={a.id} className={dirty ? 'bg-amber-500/5' : ''} data-testid={`perm-row-${a.id}`}>
                        <td className="px-4 py-2.5">
                          <div className="font-medium text-foreground flex items-center gap-2">
                            {a.label}
                            {a.locked && <Lock className="w-3.5 h-3.5 text-muted-foreground" title={t('wms_perm_locked')} />}
                            {!isDefault && !a.locked && <span className="text-[9px] font-black uppercase tracking-widest text-amber-600 dark:text-amber-400 bg-amber-500/10 border border-amber-500/30 rounded px-1.5 py-0.5" title={t('wms_perm_default_is', { a: a.default.admin ?? '—', i: a.default.inventory ?? '—' })}>{t('wms_perm_custom')}</span>}
                          </div>
                          {a.desc && <div className="text-xs text-muted-foreground">{a.desc}</div>}
                        </td>
                        <td className="px-4 py-2.5">
                          <select value={lv.admin ?? ''} disabled={a.locked || busy} onChange={e => setLv(a.id, 'admin', e.target.value)}
                            className="w-full px-2 py-1.5 bg-background border border-input rounded-md text-xs focus:outline-none focus:border-primary disabled:opacity-60"
                            data-testid={`perm-admin-${a.id}`}>
                            <option value="">{t('wms_perm_ladder_off')}</option>
                            {adminOptions(a).map(o => <option key={o.v} value={o.v}>{o.label}</option>)}
                          </select>
                        </td>
                        <td className="px-4 py-2.5">
                          {invOpts ? (
                            <select value={lv.inventory ?? ''} disabled={a.locked || busy} onChange={e => setLv(a.id, 'inventory', e.target.value)}
                              className="w-full px-2 py-1.5 bg-background border border-input rounded-md text-xs focus:outline-none focus:border-primary disabled:opacity-60"
                              data-testid={`perm-inv-${a.id}`}>
                              <option value="">{t('wms_perm_ladder_off')}</option>
                              {invOpts.map(o => <option key={o.v} value={o.v}>{o.label}</option>)}
                            </select>
                          ) : <span className="text-xs text-muted-foreground italic">{t('wms_perm_inv_na')}</span>}
                        </td>
                      </tr>
                    );
                  }),
                ];
              })}
            </tbody>
          </table>
        </div>
      </div>

      <ModuleAccessPanel />
    </div>
  );
};

/* Acceso por módulo — movido tal cual desde Configuración WMS (Home.js). */
const ModuleAccessPanel = () => {
  const { t } = useLang();
  const [moduleAccess, setModuleAccess] = useState(null);
  const [savingAccess, setSavingAccess] = useState(false);
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
  if (!moduleAccess || !Object.keys(moduleAccess.defaults || {}).length) return null;
  return (
    <div className="bg-card border border-border rounded-lg overflow-hidden" data-testid="wms-module-access">
      <div className="px-5 py-4 border-b border-border">
        <span className="flex items-center gap-2 text-sm font-semibold text-foreground"><Lock className="w-4 h-4 text-primary" /> {t('users_wms_module_access')}</span>
        <p className="text-xs text-muted-foreground mt-1">
          {t('users_wms_module_access_help_1')} <span className="text-primary font-semibold">backend</span>{' '}
          {t('users_wms_module_access_help_2')}
        </p>
      </div>
      <div className="px-5 py-4 grid grid-cols-1 md:grid-cols-2 gap-2">
        {(moduleAccess.order || Object.keys(moduleAccess.defaults || {})).map(id => {
          const soloLevel = moduleAccess.supersu_only_level || 6;
          const lvl = (moduleAccess.levels || {})[id] ?? moduleAccess.defaults[id];
          const enforced = (moduleAccess.enforced || []).includes(id);
          return (
            <div key={id} className="flex items-center justify-between gap-3 bg-muted/30 border border-border rounded-md px-4 py-2.5">
              <span className="text-sm font-medium text-foreground flex items-center gap-2">
                {(moduleAccess.labels || {})[id] || id}
                {enforced && <span className="text-[9px] font-black uppercase tracking-widest text-primary bg-primary/10 border border-primary/30 rounded px-1.5 py-0.5">backend</span>}
              </span>
              <select value={String(lvl)} onChange={e => saveModuleAccess(id, e.target.value)} disabled={savingAccess}
                className="w-44 px-2 py-1.5 bg-card border border-input rounded-md text-xs text-foreground focus:outline-none focus:ring-2 focus:ring-ring/25 disabled:opacity-50">
                <option value="0">{t('all_boards')}</option>
                {[1, 2, 3, 4, 5].map(n => <option key={n} value={String(n)}>{t('users_admin_level_plus', { n })}</option>)}
                <option value={String(soloLevel)}>{t('users_supersu_only')}</option>
              </select>
            </div>
          );
        })}
      </div>
    </div>
  );
};

export default PermissionsPanel;
