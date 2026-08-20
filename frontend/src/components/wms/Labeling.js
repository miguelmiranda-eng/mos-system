import { useState, useEffect, useCallback } from "react";
import { toast } from "sonner";
import { Printer, Search } from "lucide-react";
import { useLang } from "../../contexts/LanguageContext";
import { API, fetcher, logLoadError } from "./lib";
import { BoxStatus } from "./constants";
import { Btn, Chip, cls, ModuleToolbar } from "./ui";

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
    <div className="space-y-6">
      <ModuleToolbar
        right={
          <Btn variant="primary" onClick={printLabels} disabled={selected.size === 0} data-testid="print-labels-btn">
            <Printer className="w-4 h-4"
      /> {t('wms_print_labels')} ({selected.size})
          </Btn>
        }
      />
      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground/60" />
        <input placeholder={t('wms_search_po')} value={search} onChange={e => setSearch(e.target.value)} className={`${cls.input} pl-9`} data-testid="label-search" />
      </div>
      <div className="border border-border rounded-lg bg-card overflow-auto max-h-[500px]">
        <table className="w-full text-sm">
          <thead className="bg-muted/50 sticky top-0 border-b border-border">
            <tr>
              <th className="px-3 py-2.5 text-left"><input type="checkbox" checked={boxes.length > 0 && selected.size === boxes.length} onChange={selectAll} className="rounded" /></th>
              <th className="px-3 py-2.5 text-left text-xs font-semibold text-muted-foreground">Box ID</th>
              <th className="px-3 py-2.5 text-left text-xs font-semibold text-muted-foreground">{t('wms_label_sku')}</th>
              <th className="px-3 py-2.5 text-left text-xs font-semibold text-muted-foreground">{t('wms_label_color')}</th>
              <th className="px-3 py-2.5 text-left text-xs font-semibold text-muted-foreground">{t('wms_label_size')}</th>
               <th className="px-3 py-2.5 text-left text-xs font-semibold text-muted-foreground">{t('wms_units')}</th>
              <th className="px-3 py-2.5 text-left text-xs font-semibold text-muted-foreground">{t('wms_label_po')}</th>
              <th className="px-3 py-2.5 text-left text-xs font-semibold text-muted-foreground">{t('status')}</th>
            </tr>
          </thead>
          <tbody>
            {boxes.map(b => (
              <tr key={b.box_id} className={`border-b border-border/60 hover:bg-muted/40 transition-colors ${selected.has(b.box_id) ? 'bg-primary/10' : ''}`}>
                <td className="px-3 py-2.5"><input type="checkbox" checked={selected.has(b.box_id)} onChange={() => toggleSelect(b.box_id)} className="rounded" /></td>
                <td className="px-3 py-2.5 font-mono font-medium">{b.box_id}</td>
                <td className="px-3 py-2.5">{b.sku}</td>
                <td className="px-3 py-2.5">{b.color}</td>
                <td className="px-3 py-2.5">{b.size}</td>
                <td className="px-3 py-2.5 tabular-nums font-medium">{b.units}</td>
                <td className="px-3 py-2.5 text-muted-foreground">{b.po}</td>
                <td className="px-3 py-2.5"><Chip tone={b.status === BoxStatus.STORED ? 'success' : b.status === BoxStatus.RECEIVED ? 'info' : 'neutral'}>{b.status}</Chip></td>
              </tr>
            ))}
          </tbody>
        </table>
        {boxes.length === 0 && <div className="text-center text-muted-foreground text-sm py-8">{t('wms_no_boxes')}</div>}
      </div>
    </div>
  );
};
