import { useState, useEffect, useCallback } from "react";
import { toast } from "sonner";
import { Edit3, X, Loader2, ClipboardCheck } from "lucide-react";
import { useLang } from "../../contexts/LanguageContext";
import { fetcher, putter, logLoadError } from "./lib";
import { Btn, Chip, cls } from "./ui";

export const FinishedGoodsModule = () => {
  const { t } = useLang();
  const [boxes, setBoxes] = useState([]);
  const [bpoFilter, setBpoFilter] = useState('ALL'); // ALL | BPO | REGULAR
  const [editingBox, setEditingBox] = useState(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(() => {
    const isBpo = bpoFilter === 'BPO' ? true : bpoFilter === 'REGULAR' ? false : undefined;
    const params = isBpo !== undefined ? `?is_bpo=${isBpo}` : '';
    fetcher(`/finished-goods${params}`).then(setBoxes).catch(logLoadError('data'));
  }, [bpoFilter]);

  useEffect(() => { load(); }, [load, bpoFilter]);
  const handleSaveBox = async () => {
    if (!editingBox) return;
    setSaving(true);
    try {
      const res = await putter(`/finished-goods/${editingBox.box_id}`, editingBox);
      if (res.ok) {
        toast.success(t('box_updated_success') || 'Caja actualizada correctamente');
        setEditingBox(null);
        load();
      } else {
        const err = await res.json();
        toast.error(err.detail || 'Error al actualizar');
      }
    } catch { toast.error('Error de conexión'); }
    finally { setSaving(false); }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-4 mb-4">
        <div className="flex items-center bg-muted p-1 rounded-lg">
          {[
            { id: 'ALL', label: t('all') || 'Todos' },
            { id: 'REGULAR', label: 'Regular' },
            { id: 'BPO', label: 'Back Order (B.O.)' },
          ].map(tab => (
            <button
              key={tab.id}
              onClick={() => setBpoFilter(tab.id)}
              className={`px-3 py-1.5 text-sm font-medium rounded-md border transition-colors ${bpoFilter === tab.id ? 'bg-card text-foreground border-border' : 'border-transparent text-muted-foreground hover:text-foreground'}`}
            >
              {tab.label}
            </button>
          ))}
        </div>
        <div className="text-xs text-muted-foreground">{boxes.length} {t('wms_boxes')} {t('wms_prod_finished').toLowerCase()} / {boxes.reduce((s, b) => s + (b.units || 0), 0)} {t('wms_units')}</div>
      </div>

      <div className="overflow-auto max-h-[500px] border border-border rounded-lg bg-card">
        <table className="w-full text-sm">
          <thead className="bg-muted/50 sticky top-0 border-b border-border">
            <tr>
              <th className="px-3 py-2.5 text-left text-xs font-semibold text-muted-foreground">Box ID</th>
              <th className="px-3 py-2.5 text-left text-xs font-semibold text-muted-foreground">{t('wms_label_sku')}</th>
              <th className="px-3 py-2.5 text-left text-xs font-semibold text-muted-foreground">{t('wms_label_color')}</th>
              <th className="px-3 py-2.5 text-left text-xs font-semibold text-muted-foreground">{t('wms_label_size')}</th>
              <th className="px-3 py-2.5 text-left text-xs font-semibold text-muted-foreground">{t('wms_units')}</th>
              <th className="px-3 py-2.5 text-left text-xs font-semibold text-muted-foreground">{t('location')}</th>
              <th className="px-3 py-2.5 text-right text-xs font-semibold text-muted-foreground">{t('actions')}</th>
            </tr>
          </thead>
          <tbody>
            {boxes.map(b => (
              <tr key={b.box_id} className="border-b border-border/60 hover:bg-muted/40 transition-colors">
                <td className="px-3 py-2.5 font-mono font-medium">{b.box_id}</td>
                <td className="px-3 py-2.5 font-medium">{b.sku}</td>
                <td className="px-3 py-2.5 text-xs text-muted-foreground">{b.color}</td>
                <td className="px-3 py-2.5 font-medium">{b.size}</td>
                <td className="px-3 py-2.5 tabular-nums font-medium">{b.units}</td>
                <td className="px-3 py-2.5 text-xs text-muted-foreground font-mono">
                  {b.location || '-'}
                  {b.is_bpo && <Chip tone="warning" className="ml-2">B.O.</Chip>}
                </td>
                <td className="px-3 py-2.5 text-right">
                  <button onClick={() => setEditingBox(b)} className="p-1.5 text-muted-foreground hover:text-primary hover:bg-primary/10 rounded-lg transition-all">
                    <Edit3 className="w-4 h-4" />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {boxes.length === 0 && <div className="text-center text-muted-foreground text-sm py-8">{t('no_finished_goods')}</div>}
      </div>

      {editingBox && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm animate-in fade-in duration-200">
          <div className="bg-card border border-border rounded-lg w-full max-w-lg shadow-xl p-6 space-y-4 animate-in zoom-in-95 duration-200">
            <div className="flex items-center justify-between">
              <h3 className="font-semibold text-sm flex items-center gap-2">
                <Edit3 className="w-4 h-4" />
                {t('wms_edit_box') || 'Editar Caja'} {editingBox.box_id}
              </h3>
              <button onClick={() => setEditingBox(null)} className="p-1 hover:bg-secondary rounded-lg transition-all"><X className="w-5 h-5" /></button>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="text-xs font-medium text-muted-foreground block mb-1">SKU</label>
                <input value={editingBox.sku} onChange={e => setEditingBox(p => ({ ...p, sku: e.target.value }))} className={cls.input} />
              </div>
              <div>
                <label className="text-xs font-medium text-muted-foreground block mb-1">{t('color')}</label>
                <input value={editingBox.color} onChange={e => setEditingBox(p => ({ ...p, color: e.target.value }))} className={cls.input} />
              </div>
              <div>
                <label className="text-xs font-medium text-muted-foreground block mb-1">{t('size')}</label>
                <input value={editingBox.size} onChange={e => setEditingBox(p => ({ ...p, size: e.target.value }))} className={cls.input} />
              </div>
              <div>
                <label className="text-xs font-medium text-muted-foreground block mb-1">{t('units')}</label>
                <input type="number" value={editingBox.units} onChange={e => setEditingBox(p => ({ ...p, units: parseInt(e.target.value) || 0 }))} className={`${cls.input} tabular-nums`} />
              </div>
              <div className="col-span-2">
                <label className="text-xs font-medium text-muted-foreground block mb-1">{t('location')}</label>
                <input value={editingBox.location || ''} onChange={e => setEditingBox(p => ({ ...p, location: e.target.value }))} className={`${cls.input} font-mono`} />
              </div>
              <div className="col-span-2">
                <label className="flex items-center gap-2 cursor-pointer p-2 bg-muted rounded-md">
                  <input type="checkbox" checked={editingBox.is_bpo} onChange={e => setEditingBox(p => ({ ...p, is_bpo: e.target.checked }))} className="w-4 h-4 rounded border-border text-primary" />
                  <span className="text-xs font-medium">BACK ORDER (B.O.)</span>
                </label>
              </div>
            </div>

            <div className="flex gap-2 pt-2">
              <Btn
                variant="primary"
                onClick={handleSaveBox}
                className="flex-1"
                disabled={saving}
              >
                {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <ClipboardCheck className="w-4 h-4" />}
                {t('save') || 'Guardar'}
              </Btn>
              <Btn onClick={() => setEditingBox(null)} className="flex-1">
                {t('cancel') || 'Cancelar'}
              </Btn>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
