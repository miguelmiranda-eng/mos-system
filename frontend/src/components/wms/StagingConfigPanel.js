/* Sistema → Configuración → Surtido → OM (acción staging.config). Dónde caen
   las cajas de surtido recién surtidas (tránsito), a qué ubicaciones se pueden
   guardar (destinos: rango, prefijo o nombre) y qué tableros las cierran solas.
   Guarda en config_options.wms_staging_locations (services/staging.py). */
import { useCallback, useEffect, useState } from "react";
import { PackageCheck, Plus, Trash2, Loader2, Save } from "lucide-react";
import { toast } from "sonner";
import { useLang } from "../../contexts/LanguageContext";
import { fetcher, putter, logLoadError } from "./lib";
import { Btn } from "./ui";

const norm = (s) => (s || "").trim().toUpperCase();

const ListEditor = ({ title, note, items, onChange, placeholder, tid, disabled }) => {
  const { t } = useLang();
  const [input, setInput] = useState("");
  const add = () => {
    const v = norm(input);
    if (v && !items.includes(v)) onChange([...items, v]);
    setInput("");
  };
  return (
    <div>
      <h3 className="text-xs font-bold uppercase tracking-wider text-muted-foreground mb-2">{title}</h3>
      <div className="flex gap-2 mb-3">
        <input value={input} onChange={e => setInput(e.target.value)} placeholder={placeholder} data-testid={`${tid}-input`}
          onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); add(); } }}
          className="flex-1 bg-background border border-border rounded-md px-3 py-1.5 text-sm font-mono outline-none focus:border-primary/50" />
        <Btn onClick={add} disabled={disabled} data-testid={`${tid}-add`}><Plus className="w-4 h-4" /></Btn>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {items.length === 0 ? <span className="text-xs text-muted-foreground">{t('wms_hidden_empty')}</span>
          : items.map(v => (
            <span key={v} className="inline-flex items-center gap-1.5 rounded-md bg-muted px-2 py-1 text-xs font-mono text-foreground">
              {v}
              <button onClick={() => onChange(items.filter(x => x !== v))} disabled={disabled}
                className="text-muted-foreground hover:text-red-600 dark:hover:text-red-400 disabled:opacity-40"><Trash2 className="w-3 h-3" /></button>
            </span>))}
      </div>
      {note && <p className="text-[11px] text-muted-foreground mt-2">{note}</p>}
    </div>
  );
};

export const StagingConfigPanel = () => {
  const { t } = useLang();
  const [cfg, setCfg] = useState(null);
  const [matches, setMatches] = useState(0);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);

  const apply = (r) => {
    setCfg({ transit: r.transit || [], destinations: r.destinations || [], auto_issue_boards: r.auto_issue_boards || [] });
    setMatches((r.destination_locations || []).length);
    setDirty(false);
  };
  const load = useCallback(() => {
    fetcher('/staging/config').then(apply).catch(logLoadError('staging config'));
  }, []);
  useEffect(() => { load(); }, [load]);

  const set = (k) => (v) => { setCfg(c => ({ ...c, [k]: v })); setDirty(true); };
  const save = async () => {
    setSaving(true);
    try {
      const res = await putter('/staging/config', cfg);
      const r = await res.json().catch(() => ({}));
      if (!res.ok) { toast.error(r.detail || 'Error'); return; }
      apply(r);
      toast.success(t('wms_stg_cfg_saved'));
    } catch { toast.error(t('wms_conn_error')); }
    finally { setSaving(false); }
  };

  if (!cfg) return <div className="flex items-center justify-center py-16"><Loader2 className="w-6 h-6 animate-spin text-primary" /></div>;
  return (
    <div className="bg-card border border-border rounded-lg overflow-hidden" data-testid="staging-config-panel">
      <div className="flex items-start justify-between gap-3 px-5 py-4 border-b border-border">
        <div>
          <h2 className="text-sm font-semibold text-foreground flex items-center gap-2"><PackageCheck className="w-4 h-4 text-primary" /> {t('wms_stg_cfg_title')}</h2>
          <p className="text-xs text-muted-foreground mt-1 leading-relaxed">{t('wms_stg_cfg_help')}</p>
          {!dirty && <p className="text-xs text-muted-foreground mt-1">{t('wms_stg_cfg_matches', { n: matches })}</p>}
        </div>
        <Btn variant="primary" onClick={save} disabled={saving || !dirty} data-testid="staging-cfg-save">
          {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />} {t('save')}
        </Btn>
      </div>
      <div className="p-5 grid gap-6 md:grid-cols-3">
        <ListEditor title={t('wms_stg_cfg_transit')} note={t('wms_stg_cfg_transit_note')} items={cfg.transit}
          onChange={set('transit')} placeholder="TRANSITO SURTIDO" tid="staging-transit" disabled={saving} />
        <ListEditor title={t('wms_stg_cfg_dest')} note={t('wms_stg_cfg_dest_note')} items={cfg.destinations}
          onChange={set('destinations')} placeholder="OM-A07..OM-A38" tid="staging-dest" disabled={saving} />
        <ListEditor title={t('wms_stg_cfg_boards')} note={t('wms_stg_cfg_boards_note')} items={cfg.auto_issue_boards}
          onChange={set('auto_issue_boards')} placeholder="FINAL BILL" tid="staging-boards" disabled={saving} />
      </div>
    </div>
  );
};

export default StagingConfigPanel;
