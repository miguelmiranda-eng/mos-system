/* Sistema → Configuración → Columnas de entradas.
   Las columnas personalizadas de la hoja de Entradas son GLOBALES
   (column_config/wms_asn); aquí se ven, se agregan (mismo AddColumnModal del
   CRM) y se quitan. Entradas conserva su atajo "Agregar columna": ambos
   escriben el mismo PUT /asn-columns. */
import { useCallback, useEffect, useState } from "react";
import { Columns3, Plus, Trash2, Loader2, Sigma } from "lucide-react";
import { toast } from "sonner";
import { useLang } from "../../contexts/LanguageContext";
import { fetcher, putter, logLoadError, useWms } from "./lib";
import { AddColumnModal } from "../dashboard/AddColumnModal";
import { ASN_FIXED_LINE_COLS, slugKey } from "./Asn";
import { Btn } from "./ui";

export const AsnColumnsPanel = () => {
  const { t } = useLang();
  const { can } = useWms();
  const canEdit = can('asn.columns');
  const [cols, setCols] = useState(null);
  const [showAdd, setShowAdd] = useState(false);
  const [saving, setSaving] = useState(false);

  const load = useCallback(() => {
    fetcher('/asn-columns').then(r => setCols(r?.columns || [])).catch(logLoadError('asn columns'));
  }, []);
  useEffect(() => { load(); }, [load]);

  const save = async (next) => {
    setSaving(true);
    try {
      const res = await putter('/asn-columns', { columns: next });
      const r = await res.json().catch(() => ({}));
      if (!res.ok) { toast.error(r.detail || t('wms_asn_columns_err')); return; }
      setCols(r.columns || []);
      toast.success(t('wms_asn_columns_saved'));
    } catch { toast.error(t('wms_conn_error')); }
    finally { setSaving(false); }
  };
  const add = (colDef) => {
    const key = slugKey(colDef.label || colDef.key);
    if ([...ASN_FIXED_LINE_COLS, ...(cols || [])].some(c => c.key === key)) { toast.error(t('col_exists')); return; }
    const col = { key, label: colDef.label, type: colDef.type, width: colDef.width || 150 };
    if (colDef.type === 'formula') col.formula = colDef.formula;
    if (colDef.type === 'select') col.statusOptions = colDef.statusOptions || [];
    save([...(cols || []), col]);
  };
  const remove = (col) => {
    if (!window.confirm(t('wms_remove_column_confirm', { name: col.label }))) return;
    save((cols || []).filter(c => c.key !== col.key));
  };

  if (cols === null) return <div className="flex items-center justify-center py-16"><Loader2 className="w-6 h-6 animate-spin text-primary" /></div>;

  return (
    <div className="bg-card border border-border rounded-lg overflow-hidden" data-testid="asn-columns-panel">
      <div className="flex items-start justify-between gap-3 px-5 py-4 border-b border-border">
        <div>
          <h2 className="text-sm font-semibold text-foreground flex items-center gap-2"><Columns3 className="w-4 h-4 text-primary" /> {t('wms_asn_columns_title')}</h2>
          <p className="text-xs text-muted-foreground mt-1">{t('wms_asn_columns_help')}</p>
        </div>
        {canEdit && <Btn variant="primary" onClick={() => setShowAdd(true)} disabled={saving} data-testid="asn-columns-add"><Plus className="w-4 h-4" /> {t('wms_add_column')}</Btn>}
      </div>
      {cols.length === 0 ? (
        <div className="px-5 py-8 text-center text-sm text-muted-foreground">{t('wms_asn_columns_empty')}</div>
      ) : (
        <table className="w-full text-sm">
          <thead className="bg-muted/50">
            <tr>
              <th className="px-4 py-2 text-left text-xs font-semibold text-muted-foreground">{t('wms_asn_columns_col_label')}</th>
              <th className="px-4 py-2 text-left text-xs font-semibold text-muted-foreground">{t('wms_asn_columns_col_key')}</th>
              <th className="px-4 py-2 text-left text-xs font-semibold text-muted-foreground">{t('wms_asn_columns_col_type')}</th>
              <th className="px-4 py-2 text-left text-xs font-semibold text-muted-foreground">{t('wms_asn_columns_col_detail')}</th>
              {canEdit && <th className="px-4 py-2 w-12" />}
            </tr>
          </thead>
          <tbody className="divide-y divide-border/60">
            {cols.map(c => (
              <tr key={c.key} data-testid={`asn-column-${c.key}`}>
                <td className="px-4 py-2.5 font-medium text-foreground">{c.label}</td>
                <td className="px-4 py-2.5 font-mono text-xs text-muted-foreground">{c.key}</td>
                <td className="px-4 py-2.5 text-xs">{c.type}</td>
                <td className="px-4 py-2.5 text-xs text-muted-foreground font-mono">
                  {c.type === 'formula' && c.formula && <span className="inline-flex items-center gap-1"><Sigma className="w-3 h-3" /> {c.formula}</span>}
                  {c.type === 'select' && (c.statusOptions || []).map(o => (typeof o === 'string' ? o : o?.label || o?.value)).filter(Boolean).join(' · ')}
                </td>
                {canEdit && (
                  <td className="px-4 py-2.5 text-right">
                    <button onClick={() => remove(c)} disabled={saving} title={t('wms_remove_column')} data-testid={`asn-column-remove-${c.key}`}
                      className="p-1.5 rounded-md text-muted-foreground hover:text-red-600 dark:hover:text-red-400 hover:bg-red-500/10 disabled:opacity-50">
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <AddColumnModal isOpen={showAdd} onClose={() => setShowAdd(false)} onAdd={add} existingColumns={[...ASN_FIXED_LINE_COLS, ...cols]} />
    </div>
  );
};

export default AsnColumnsPanel;
