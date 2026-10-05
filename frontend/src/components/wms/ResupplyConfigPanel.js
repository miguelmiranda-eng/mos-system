/* Sistema → Configuración → Resurtidos (acción picking.resupply_config,
   default admin nivel 5). Motivos que se ofrecen al resurtir y el umbral (%
   acumulado sobre lo pedido) arriba del cual solo admin 5 puede autorizar.
   Guarda en config_options.wms_resupply (services/resupply.py). */
import { useCallback, useEffect, useState } from "react";
import { RotateCcw, Plus, Trash2, Loader2, Save } from "lucide-react";
import { toast } from "sonner";
import { useLang } from "../../contexts/LanguageContext";
import { fetcher, putter, logLoadError } from "./lib";
import { Btn, cls } from "./ui";

export const ResupplyConfigPanel = () => {
  const { t } = useLang();
  const [reasons, setReasons] = useState(null);
  const [pct, setPct] = useState(10);
  const [input, setInput] = useState("");
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);

  const load = useCallback(() => {
    fetcher('/resupply/config').then(r => { setReasons(r.reasons || []); setPct(r.threshold_pct ?? 10); setDirty(false); })
      .catch(logLoadError('resupply config'));
  }, []);
  useEffect(() => { load(); }, [load]);

  const add = () => {
    const v = input.trim().replace(/\s+/g, ' ');
    if (v && !reasons.some(r => r.toUpperCase() === v.toUpperCase())) { setReasons(r => [...r, v]); setDirty(true); }
    setInput("");
  };
  const save = async () => {
    setSaving(true);
    try {
      const res = await putter('/resupply/config', { reasons, threshold_pct: Number(pct) });
      const r = await res.json().catch(() => ({}));
      if (!res.ok) { toast.error(r.detail || 'Error'); return; }
      setReasons(r.reasons); setPct(r.threshold_pct); setDirty(false);
      toast.success(t('wms_rs_cfg_saved'));
    } catch { toast.error(t('wms_conn_error')); }
    finally { setSaving(false); }
  };

  if (reasons === null) return <div className="flex items-center justify-center py-16"><Loader2 className="w-6 h-6 animate-spin text-primary" /></div>;
  return (
    <div className="bg-card border border-border rounded-lg overflow-hidden" data-testid="resupply-config-panel">
      <div className="flex items-start justify-between gap-3 px-5 py-4 border-b border-border">
        <div>
          <h2 className="text-sm font-semibold text-foreground flex items-center gap-2"><RotateCcw className="w-4 h-4 text-primary" /> {t('wms_rs_cfg_title')}</h2>
          <p className="text-xs text-muted-foreground mt-1 leading-relaxed">{t('wms_rs_cfg_help')}</p>
        </div>
        <Btn variant="primary" onClick={save} disabled={saving || !dirty} data-testid="resupply-cfg-save">
          {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />} {t('save')}
        </Btn>
      </div>
      <div className="p-5 grid gap-6 md:grid-cols-2">
        <div>
          <h3 className="text-xs font-bold uppercase tracking-wider text-muted-foreground mb-2">{t('wms_rs_cfg_reasons')}</h3>
          <div className="flex gap-2 mb-3">
            <input value={input} onChange={e => setInput(e.target.value)} placeholder={t('wms_rs_cfg_reason_ph')}
              onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); add(); } }} className={cls.input} />
            <Btn onClick={add} disabled={saving}><Plus className="w-4 h-4" /></Btn>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {reasons.map(r => (
              <span key={r} className="inline-flex items-center gap-1.5 rounded-md bg-muted px-2 py-1 text-xs text-foreground">
                {r}
                <button onClick={() => { setReasons(x => x.filter(y => y !== r)); setDirty(true); }} disabled={saving}
                  className="text-muted-foreground hover:text-red-600 dark:hover:text-red-400"><Trash2 className="w-3 h-3" /></button>
              </span>))}
          </div>
        </div>
        <div>
          <h3 className="text-xs font-bold uppercase tracking-wider text-muted-foreground mb-2">{t('wms_rs_cfg_threshold')}</h3>
          <div className="flex items-center gap-2">
            <input type="number" min="0" max="100" step="0.5" value={pct}
              onChange={e => { setPct(e.target.value); setDirty(true); }} className={`${cls.input} w-28 tabular-nums`} />
            <span className="text-sm text-muted-foreground">%</span>
          </div>
          <p className="text-[11px] text-muted-foreground mt-2">{t('wms_rs_cfg_threshold_note')}</p>
        </div>
      </div>
    </div>
  );
};

export default ResupplyConfigPanel;
