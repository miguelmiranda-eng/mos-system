/* Sistema → Configuración → Surtido.
   Orden en que el surtido OFRECE las ubicaciones (config_options.wms_pick_priority).
   Antes el orden era fijo: unidades desc, así que la reserva RP (pallets llenos)
   salía siempre primero. Ahora es una lista de GRUPOS por prefijo, reordenable:
   el primer grupo se surte primero y, dentro de cada grupo, la ubicación más
   llena primero. El comodín "*" (grupo "Otras") atrapa lo que ningún prefijo
   casó y no se puede quitar — sin él una ubicación quedaría fuera del surtido. */
import { useCallback, useEffect, useState } from "react";
import { ClipboardCheck, Plus, Trash2, Loader2, ArrowUp, ArrowDown, RotateCcw, Save } from "lucide-react";
import { toast } from "sonner";
import { useLang } from "../../contexts/LanguageContext";
import { fetcher, putter, logLoadError, useWms } from "./lib";
import { Btn } from "./ui";

const isStar = (g) => (g.prefixes || []).includes("*");

export const PickPriorityPanel = () => {
  const { t } = useLang();
  const { can } = useWms();
  const canEdit = can('picking.priority_config');
  const [groups, setGroups] = useState(null);
  const [dflt, setDflt] = useState([]);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);

  const load = useCallback(() => {
    fetcher('/pick-priority').then(r => {
      setGroups(r?.groups || []);
      setDflt(r?.default || []);
      setDirty(false);
    }).catch(logLoadError('pick priority'));
  }, []);
  useEffect(() => { load(); }, [load]);

  const mutate = (fn) => { setGroups(g => fn([...g])); setDirty(true); };
  const move = (i, dir) => mutate(g => {
    const j = i + dir;
    if (j < 0 || j >= g.length) return g;
    [g[i], g[j]] = [g[j], g[i]];
    return g;
  });
  const setPrefixes = (i, raw) => mutate(g => {
    g[i] = { ...g[i], prefixes: raw.split(',').map(s => s.trim().toUpperCase()).filter(Boolean) };
    return g;
  });
  const setLabel = (i, val) => mutate(g => { g[i] = { ...g[i], label: val }; return g; });
  const remove = (i) => mutate(g => g.filter((_, k) => k !== i));
  const addGroup = () => mutate(g => {
    const star = g.findIndex(isStar);
    const row = { key: `grupo${g.length + 1}`, label: '', prefixes: [] };
    if (star === -1) return [...g, row];
    return [...g.slice(0, star), row, ...g.slice(star)]; // nuevos antes del comodín
  });
  const resetDefault = () => { setGroups(dflt.map(g => ({ ...g, prefixes: [...g.prefixes] }))); setDirty(true); };

  const save = async () => {
    setSaving(true);
    try {
      const res = await putter('/pick-priority', { groups });
      const r = await res.json().catch(() => ({}));
      if (!res.ok) { toast.error(r.detail || t('wms_pick_priority_err')); return; }
      setGroups(r.groups || []);
      setDirty(false);
      toast.success(t('wms_pick_priority_saved'));
    } catch { toast.error(t('wms_conn_error')); }
    finally { setSaving(false); }
  };

  if (groups === null) return <div className="flex items-center justify-center py-16"><Loader2 className="w-6 h-6 animate-spin text-primary" /></div>;

  return (
    <div className="bg-card border border-border rounded-lg overflow-hidden" data-testid="pick-priority-panel">
      <div className="flex items-start justify-between gap-3 px-5 py-4 border-b border-border">
        <div>
          <h2 className="text-sm font-semibold text-foreground flex items-center gap-2"><ClipboardCheck className="w-4 h-4 text-primary" /> {t('wms_pick_priority_title')}</h2>
          <p className="text-xs text-muted-foreground mt-1 leading-relaxed">{t('wms_pick_priority_help')}</p>
        </div>
        {canEdit && (
          <div className="flex gap-2 shrink-0">
            <Btn onClick={resetDefault} disabled={saving} data-testid="pick-priority-reset"><RotateCcw className="w-4 h-4" /> {t('wms_pick_priority_reset')}</Btn>
            <Btn variant="primary" onClick={save} disabled={saving || !dirty} data-testid="pick-priority-save">
              {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />} {t('save')}
            </Btn>
          </div>
        )}
      </div>

      <div className="p-4 space-y-2">
        {groups.map((g, i) => (
          <div key={i} data-testid={`pick-priority-row-${i}`}
            className="flex items-center gap-3 rounded-lg border border-border bg-background/60 px-3 py-2.5">
            <span className="w-6 h-6 shrink-0 rounded-full bg-primary/10 text-primary text-xs font-bold flex items-center justify-center tabular-nums">{i + 1}</span>
            <div className="flex flex-col gap-1 min-w-0 flex-1">
              <input
                value={g.label || ''}
                onChange={e => setLabel(i, e.target.value)}
                disabled={!canEdit}
                placeholder={t('wms_pick_priority_label_ph')}
                className="bg-transparent text-sm font-medium text-foreground outline-none border-b border-transparent focus:border-primary/40 disabled:opacity-70"
              />
              {isStar(g) ? (
                <span className="text-xs text-muted-foreground">{t('wms_pick_priority_wildcard')}</span>
              ) : (
                <input
                  value={(g.prefixes || []).join(', ')}
                  onChange={e => setPrefixes(i, e.target.value)}
                  disabled={!canEdit}
                  placeholder={t('wms_pick_priority_prefix_ph')}
                  className="bg-transparent text-xs font-mono text-muted-foreground outline-none border-b border-transparent focus:border-primary/40 disabled:opacity-70"
                />
              )}
            </div>
            {canEdit && (
              <div className="flex items-center gap-1 shrink-0">
                <button onClick={() => move(i, -1)} disabled={i === 0} title={t('wms_pick_priority_up')}
                  className="p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted disabled:opacity-30" data-testid={`pick-priority-up-${i}`}>
                  <ArrowUp className="w-4 h-4" />
                </button>
                <button onClick={() => move(i, 1)} disabled={i === groups.length - 1} title={t('wms_pick_priority_down')}
                  className="p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted disabled:opacity-30" data-testid={`pick-priority-down-${i}`}>
                  <ArrowDown className="w-4 h-4" />
                </button>
                <button onClick={() => remove(i)} disabled={isStar(g)} title={isStar(g) ? t('wms_pick_priority_wildcard_locked') : t('delete')}
                  className="p-1.5 rounded-md text-muted-foreground hover:text-red-600 dark:hover:text-red-400 hover:bg-red-500/10 disabled:opacity-30" data-testid={`pick-priority-remove-${i}`}>
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
            )}
          </div>
        ))}
        {canEdit && (
          <button onClick={addGroup} data-testid="pick-priority-add"
            className="w-full flex items-center justify-center gap-2 rounded-lg border border-dashed border-border py-2.5 text-sm text-muted-foreground hover:text-foreground hover:border-primary/40">
            <Plus className="w-4 h-4" /> {t('wms_pick_priority_add')}
          </button>
        )}
      </div>
    </div>
  );
};

export default PickPriorityPanel;
