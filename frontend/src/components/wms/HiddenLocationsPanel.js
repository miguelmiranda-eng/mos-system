/* Sistema → Configuración → Ubicaciones ocultas (acción inventory.hide_locations,
   default nivel 5). Lista curada de ubicaciones que NO aparecen en el WMS
   (inventario, locaciones, surtido, dropdowns): buckets virtuales, retornos,
   material perdido, zonas que ensucian la foto real. Se ocultan por NOMBRE
   exacto o por PREFIJO. El nivel 5 puede revelarlas con el toggle "mostrar
   ocultas" de cada listado. Guarda en config_options.wms_hidden_locations. */
import { useCallback, useEffect, useState } from "react";
import { EyeOff, Plus, Trash2, Loader2, Save } from "lucide-react";
import { toast } from "sonner";
import { useLang } from "../../contexts/LanguageContext";
import { fetcher, putter, logLoadError } from "./lib";
import { Btn } from "./ui";

const norm = (s) => (s || "").trim().toUpperCase();

export const HiddenLocationsPanel = () => {
  const { t } = useLang();
  const [names, setNames] = useState(null);
  const [prefixes, setPrefixes] = useState([]);
  const [nameInput, setNameInput] = useState("");
  const [prefixInput, setPrefixInput] = useState("");
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);

  const load = useCallback(() => {
    fetcher('/hidden-locations').then(r => {
      setNames(r?.names || []);
      setPrefixes(r?.prefixes || []);
      setDirty(false);
    }).catch(logLoadError('hidden locations'));
  }, []);
  useEffect(() => { load(); }, [load]);

  const addName = () => {
    const v = norm(nameInput);
    if (!v) return;
    if (!(names || []).includes(v)) { setNames(n => [...n, v].sort()); setDirty(true); }
    setNameInput("");
  };
  const addPrefix = () => {
    const v = norm(prefixInput);
    if (!v) return;
    if (!prefixes.includes(v)) { setPrefixes(p => [...p, v].sort()); setDirty(true); }
    setPrefixInput("");
  };
  const removeName = (v) => { setNames(n => n.filter(x => x !== v)); setDirty(true); };
  const removePrefix = (v) => { setPrefixes(p => p.filter(x => x !== v)); setDirty(true); };

  const save = async () => {
    setSaving(true);
    try {
      const res = await putter('/hidden-locations', { names, prefixes });
      const r = await res.json().catch(() => ({}));
      if (!res.ok) { toast.error(r.detail || t('wms_hidden_err')); return; }
      setNames(r.names || []);
      setPrefixes(r.prefixes || []);
      setDirty(false);
      toast.success(t('wms_hidden_saved'));
    } catch { toast.error(t('wms_conn_error')); }
    finally { setSaving(false); }
  };

  if (names === null) return <div className="flex items-center justify-center py-16"><Loader2 className="w-6 h-6 animate-spin text-primary" /></div>;

  const chip = (v, onRemove, tid) => (
    <span key={v} data-testid={tid} className="inline-flex items-center gap-1.5 rounded-md bg-muted px-2 py-1 text-xs font-mono text-foreground">
      {v}
      <button onClick={() => onRemove(v)} disabled={saving} className="text-muted-foreground hover:text-red-600 dark:hover:text-red-400 disabled:opacity-40">
        <Trash2 className="w-3 h-3" />
      </button>
    </span>
  );

  return (
    <div className="bg-card border border-border rounded-lg overflow-hidden" data-testid="hidden-locations-panel">
      <div className="flex items-start justify-between gap-3 px-5 py-4 border-b border-border">
        <div>
          <h2 className="text-sm font-semibold text-foreground flex items-center gap-2"><EyeOff className="w-4 h-4 text-primary" /> {t('wms_hidden_title')}</h2>
          <p className="text-xs text-muted-foreground mt-1 leading-relaxed">{t('wms_hidden_help')}</p>
        </div>
        <Btn variant="primary" onClick={save} disabled={saving || !dirty} data-testid="hidden-save">
          {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />} {t('save')}
        </Btn>
      </div>

      <div className="p-5 grid gap-6 md:grid-cols-2">
        {/* Nombres exactos */}
        <div>
          <h3 className="text-xs font-bold uppercase tracking-wider text-muted-foreground mb-2">{t('wms_hidden_names')}</h3>
          <div className="flex gap-2 mb-3">
            <input
              value={nameInput}
              onChange={e => setNameInput(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addName(); } }}
              placeholder={t('wms_hidden_name_ph')}
              data-testid="hidden-name-input"
              className="flex-1 bg-background border border-border rounded-md px-3 py-1.5 text-sm font-mono outline-none focus:border-primary/50"
            />
            <Btn onClick={addName} disabled={saving} data-testid="hidden-name-add"><Plus className="w-4 h-4" /></Btn>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {names.length === 0 ? <span className="text-xs text-muted-foreground">{t('wms_hidden_empty')}</span>
              : names.map(v => chip(v, removeName, `hidden-name-${v}`))}
          </div>
        </div>

        {/* Prefijos */}
        <div>
          <h3 className="text-xs font-bold uppercase tracking-wider text-muted-foreground mb-2">{t('wms_hidden_prefixes')}</h3>
          <div className="flex gap-2 mb-3">
            <input
              value={prefixInput}
              onChange={e => setPrefixInput(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addPrefix(); } }}
              placeholder={t('wms_hidden_prefix_ph')}
              data-testid="hidden-prefix-input"
              className="flex-1 bg-background border border-border rounded-md px-3 py-1.5 text-sm font-mono outline-none focus:border-primary/50"
            />
            <Btn onClick={addPrefix} disabled={saving} data-testid="hidden-prefix-add"><Plus className="w-4 h-4" /></Btn>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {prefixes.length === 0 ? <span className="text-xs text-muted-foreground">{t('wms_hidden_empty')}</span>
              : prefixes.map(v => chip(v, removePrefix, `hidden-prefix-${v}`))}
          </div>
          <p className="text-[11px] text-muted-foreground mt-2">{t('wms_hidden_prefix_note')}</p>
        </div>
      </div>
    </div>
  );
};

export default HiddenLocationsPanel;
