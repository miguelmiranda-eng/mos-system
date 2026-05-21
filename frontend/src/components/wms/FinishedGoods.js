import { useState, useEffect, useCallback } from "react";
import { toast } from "sonner";
import { Edit3, X, Loader2, ClipboardCheck } from "lucide-react";
import { useLang } from "../../contexts/LanguageContext";
import { fetcher, putter, logLoadError } from "./lib";

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
        <div className="flex items-center bg-secondary/30 p-1 rounded-xl border border-border/20">
          {[
            { id: 'ALL', label: t('all') || 'Todos' },
            { id: 'REGULAR', label: 'Regular' },
            { id: 'BPO', label: 'Back Order (B.O.)' },
          ].map(tab => (
            <button
              key={tab.id}
              onClick={() => setBpoFilter(tab.id)}
              className={`px-4 py-1.5 text-[10px] font-black uppercase tracking-widest rounded-lg transition-all ${bpoFilter === tab.id ? 'bg-primary text-black shadow' : 'text-muted-foreground hover:bg-secondary/60 hover:text-foreground'}`}
            >
              {tab.label}
            </button>
          ))}
        </div>
        <div className="text-xs text-muted-foreground">{boxes.length} {t('wms_boxes')} {t('wms_prod_finished').toLowerCase()} / {boxes.reduce((s, b) => s + (b.units || 0), 0)} {t('wms_units')}</div>
      </div>

      <div className="overflow-auto max-h-[500px] border border-border/40 rounded-2xl bg-card/40 backdrop-blur-sm shadow-xl">
        <table className="w-full text-sm">
          <thead className="bg-secondary/80 sticky top-0 backdrop-blur-md">
            <tr>
              <th className="p-3 text-left text-[10px] font-black uppercase tracking-widest text-muted-foreground">Box ID</th>
              <th className="p-3 text-left text-[10px] font-black uppercase tracking-widest text-muted-foreground">{t('wms_label_sku')}</th>
              <th className="p-3 text-left text-[10px] font-black uppercase tracking-widest text-muted-foreground">{t('wms_label_color')}</th>
              <th className="p-3 text-left text-[10px] font-black uppercase tracking-widest text-muted-foreground">{t('wms_label_size')}</th>
              <th className="p-3 text-left text-[10px] font-black uppercase tracking-widest text-muted-foreground">{t('wms_units')}</th>
              <th className="p-3 text-left text-[10px] font-black uppercase tracking-widest text-muted-foreground">{t('location')}</th>
              <th className="p-3 text-right text-[10px] font-black uppercase tracking-widest text-muted-foreground">{t('actions')}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border/10">
            {boxes.map(b => (
              <tr key={b.box_id} className="border-b border-border/5 hover:bg-primary/5 transition-all group">
                <td className="p-3 font-mono font-black text-primary group-hover:scale-105 transition-transform origin-left">{b.box_id}</td>
                <td className="p-3 font-bold">{b.sku}</td>
                <td className="p-3 text-xs uppercase text-muted-foreground">{b.color}</td>
                <td className="p-3 font-bold text-primary">{b.size}</td>
                <td className="p-3 font-mono font-black tracking-tighter">{b.units}</td>
                <td className="p-3 text-xs text-muted-foreground font-mono italic">
                  {b.location || '-'}
                  {b.is_bpo && <span className="ml-2 bg-amber-500/10 text-amber-500 text-[8px] px-1 rounded border border-amber-500/20">B.O.</span>}
                </td>
                <td className="p-3 text-right">
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
          <div className="bg-card border border-border/50 rounded-2xl w-full max-w-lg shadow-2xl p-6 space-y-4 animate-in zoom-in-95 duration-200">
            <div className="flex items-center justify-between">
              <h3 className="font-black uppercase tracking-widest text-sm text-primary flex items-center gap-2">
                <Edit3 className="w-4 h-4" />
                {t('wms_edit_box') || 'Editar Caja'} {editingBox.box_id}
              </h3>
              <button onClick={() => setEditingBox(null)} className="p-1 hover:bg-secondary rounded-lg transition-all"><X className="w-5 h-5" /></button>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="text-[10px] font-black uppercase text-muted-foreground block mb-1">SKU</label>
                <input value={editingBox.sku} onChange={e => setEditingBox(p => ({ ...p, sku: e.target.value }))} className="w-full bg-background border border-border rounded-xl p-2.5 text-sm font-bold" />
              </div>
              <div>
                <label className="text-[10px] font-black uppercase text-muted-foreground block mb-1">{t('color')}</label>
                <input value={editingBox.color} onChange={e => setEditingBox(p => ({ ...p, color: e.target.value }))} className="w-full bg-background border border-border rounded-xl p-2.5 text-sm font-bold" />
              </div>
              <div>
                <label className="text-[10px] font-black uppercase text-muted-foreground block mb-1">{t('size')}</label>
                <input value={editingBox.size} onChange={e => setEditingBox(p => ({ ...p, size: e.target.value }))} className="w-full bg-background border border-border rounded-xl p-2.5 text-sm font-bold" />
              </div>
              <div>
                <label className="text-[10px] font-black uppercase text-muted-foreground block mb-1">{t('units')}</label>
                <input type="number" value={editingBox.units} onChange={e => setEditingBox(p => ({ ...p, units: parseInt(e.target.value) || 0 }))} className="w-full bg-background border border-border rounded-xl p-2.5 text-sm font-bold" />
              </div>
              <div className="col-span-2">
                <label className="text-[10px] font-black uppercase text-muted-foreground block mb-1">{t('location')}</label>
                <input value={editingBox.location || ''} onChange={e => setEditingBox(p => ({ ...p, location: e.target.value }))} className="w-full bg-background border border-border rounded-xl p-2.5 text-sm font-bold font-mono" />
              </div>
              <div className="col-span-2">
                <label className="flex items-center gap-2 cursor-pointer p-2 bg-secondary/50 rounded-xl">
                  <input type="checkbox" checked={editingBox.is_bpo} onChange={e => setEditingBox(p => ({ ...p, is_bpo: e.target.checked }))} className="w-4 h-4 rounded border-border text-primary" />
                  <span className="text-xs font-black uppercase tracking-widest">BACK ORDER (B.O.)</span>
                </label>
              </div>
            </div>

            <div className="flex gap-2 pt-2">
              <button
                onClick={handleSaveBox}
                className="flex-1 bg-primary text-black font-black uppercase tracking-widest text-xs py-3 rounded-xl transition-all shadow-lg shadow-primary/20 flex items-center justify-center gap-2 disabled:opacity-50"
                disabled={saving}
              >
                {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <ClipboardCheck className="w-4 h-4" />}
                {t('save') || 'Guardar'}
              </button>
              <button onClick={() => setEditingBox(null)} className="flex-1 bg-secondary text-foreground font-black uppercase tracking-widest text-xs py-3 rounded-xl transition-all">
                {t('cancel') || 'Cancelar'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
