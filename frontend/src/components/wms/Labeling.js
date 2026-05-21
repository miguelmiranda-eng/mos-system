import { useState, useEffect, useCallback } from "react";
import { toast } from "sonner";
import { Printer, Search } from "lucide-react";
import { useLang } from "../../contexts/LanguageContext";
import { API, fetcher, logLoadError } from "./lib";
import { BoxStatus } from "./constants";

export const LabelingModule = () => {
  const { t } = useLang();
  const [boxes, setBoxes] = useState([]);
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState(new Set());

  const load = useCallback(() => { fetcher(`/boxes?po=${search}`).then(setBoxes).catch(logLoadError('data')); }, [search]);
  useEffect(() => { load(); }, [load]);

  const toggleSelect = (id) => setSelected(p => { const n = new Set(p); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const selectAll = () => setSelected(boxes.length === selected.size ? new Set() : new Set(boxes.map(b => b.box_id)));

  const printLabels = () => {
    const ids = [...selected].join(',');
    if (!ids) { toast.error(t('wms_select_box_err')); return; }
    window.open(`${API}/labels/boxes?box_ids=${ids}`, '_blank');
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-bold text-foreground">{t('wms_labeling')}</h2>
        <button onClick={printLabels} disabled={selected.size === 0} className="px-3 py-1.5 bg-primary text-primary-foreground rounded text-sm flex items-center gap-1.5 disabled:opacity-50" data-testid="print-labels-btn">
          <Printer className="w-4 h-4" /> {t('wms_print_labels')} ({selected.size})
        </button>
      </div>
      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
        <input placeholder={t('wms_search_po')} value={search} onChange={e => setSearch(e.target.value)} className="w-full pl-9 pr-3 py-2 bg-background border border-border rounded text-sm text-foreground" data-testid="label-search" />
      </div>
      <div className="overflow-auto max-h-[500px]">
        <table className="w-full text-sm">
          <thead className="bg-secondary sticky top-0">
            <tr>
              <th className="p-2 text-left"><input type="checkbox" checked={boxes.length > 0 && selected.size === boxes.length} onChange={selectAll} className="rounded" /></th>
              <th className="p-2 text-left text-xs uppercase text-muted-foreground">Box ID</th>
              <th className="p-2 text-left text-xs uppercase text-muted-foreground">{t('wms_label_sku')}</th>
              <th className="p-2 text-left text-xs uppercase text-muted-foreground">{t('wms_label_color')}</th>
              <th className="p-2 text-left text-xs uppercase text-muted-foreground">{t('wms_label_size')}</th>
               <th className="p-2 text-left text-xs uppercase text-muted-foreground">{t('wms_units')}</th>
              <th className="p-2 text-left text-xs uppercase text-muted-foreground">{t('wms_label_po')}</th>
              <th className="p-2 text-left text-xs uppercase text-muted-foreground">{t('status')}</th>
            </tr>
          </thead>
          <tbody>
            {boxes.map(b => (
              <tr key={b.box_id} className={`border-b border-border hover:bg-secondary/50 ${selected.has(b.box_id) ? 'bg-primary/10' : ''}`}>
                <td className="p-2"><input type="checkbox" checked={selected.has(b.box_id)} onChange={() => toggleSelect(b.box_id)} className="rounded" /></td>
                <td className="p-2 font-mono font-bold text-primary">{b.box_id}</td>
                <td className="p-2">{b.sku}</td>
                <td className="p-2">{b.color}</td>
                <td className="p-2">{b.size}</td>
                <td className="p-2">{b.units}</td>
                <td className="p-2 text-muted-foreground">{b.po}</td>
                <td className="p-2"><span className={`text-xs px-2 py-0.5 rounded-full ${b.status === BoxStatus.STORED ? 'bg-green-500/15 text-green-400' : b.status === BoxStatus.RECEIVED ? 'bg-blue-500/15 text-blue-400' : 'bg-gray-500/15 text-gray-400'}`}>{b.status}</span></td>
              </tr>
            ))}
          </tbody>
        </table>
        {boxes.length === 0 && <div className="text-center text-muted-foreground text-sm py-8">{t('wms_no_boxes')}</div>}
      </div>
    </div>
  );
};
