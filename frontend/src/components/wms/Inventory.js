import { useState, useEffect, useCallback, Fragment } from "react";
import { toast } from "sonner";
import { Package, Loader2, Download, Tag, Link2, CheckCircle, MapPin, Search, ScanLine, BarChart3 } from "lucide-react";
import { useLang } from "../../contexts/LanguageContext";
import { API, fetcher, logLoadError } from "./lib";

export const InventoryModule = ({ initialCustomer = '' }) => {
  const { t } = useLang();
  const [inventory, setInventory] = useState([]);
  const [summary, setSummary] = useState({});
  const [filters, setFilters] = useState({ customers: [], categories: [], manufacturers: [], styles: [] });
  const [search, setSearch] = useState('');
  const [customerFilter, setCustomerFilter] = useState(initialCustomer);
  const [categoryFilter, setCategoryFilter] = useState('');
  const [importing, setImporting] = useState(false);
  const [showFilters, setShowFilters] = useState(false);
  const [groupByCustomer, setGroupByCustomer] = useState(false);

  const loadFilters = useCallback(() => { fetcher('/inventory/filters').then(setFilters).catch(logLoadError('data')); }, []);
  const load = useCallback(() => {
    const params = new URLSearchParams();
    if (search) params.set('style', search);
    if (customerFilter) params.set('customer', customerFilter);
    if (categoryFilter) params.set('category', categoryFilter);
    fetcher(`/inventory?${params.toString()}`).then(setInventory).catch(logLoadError('data'));
    const summaryParams = new URLSearchParams();
    if (customerFilter) summaryParams.set('customer', customerFilter);
    fetcher(`/inventory/summary?${summaryParams.toString()}`).then(setSummary).catch(logLoadError('data'));
  }, [search, customerFilter, categoryFilter]);
  useEffect(() => { load(); loadFilters(); }, [load, loadFilters]);

  const exportExcel = () => window.open(`${API}/export/inventory`, '_blank');

  const handleImport = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setImporting(true);
    try {
      const formData = new FormData();
      formData.append('file', file);
      const res = await fetch(`${API}/import/inventory`, { method: 'POST', credentials: 'include', body: formData });
      if (res.ok) {
        const data = await res.json();
        toast.success(`${t('excel_summary')}: ${data.imported.toLocaleString()} ${t('activity_records')}. ${data.locations_created} ${t('wms_locations')}.`);
        load(); loadFilters();
      } else { const err = await res.json().catch(() => ({})); toast.error(err.detail || t('error')); }
    } catch { toast.error(t('error_connection')); }
    finally { setImporting(false); e.target.value = ''; }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-4">
        <div className="text-xs font-black uppercase tracking-widest text-muted-foreground bg-secondary/50 px-3 py-1 rounded-full border border-border/40 flex items-center gap-2">
          <div className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
          {t('wms_stock_monitor')}
        </div>
        <div className="flex items-center gap-2">
          <label className={`px-4 py-2 bg-primary text-black rounded-xl font-bold uppercase tracking-wider text-xs flex items-center gap-2 cursor-pointer transition-all hover:scale-105 shadow-[0_0_15px_rgba(255,193,7,0.3)] ${importing ? 'opacity-50' : ''}`} data-testid="import-inv-btn">
            {importing ? <Loader2 className="w-4 h-4 animate-spin" /> : <Package className="w-4 h-4" />}
            {importing ? t('wms_importing') : t('wms_import_excel')}
            <input type="file" accept=".xlsx,.xls" onChange={handleImport} className="hidden" disabled={importing} />
          </label>
          <button onClick={exportExcel} className="p-2 bg-secondary/80 text-foreground border border-border/40 rounded-xl hover:bg-secondary flex items-center gap-1.5 transition-all" data-testid="export-inv-btn">
            <Download className="w-4 h-4 text-primary" />
          </button>
        </div>
      </div>

      {/* Low Stock Alert */}
      {summary.low_stock_items > 0 && (
        <div className="bg-red-500/10 border border-red-500/20 rounded-2xl p-4 flex items-center gap-4 animate-in fade-in slide-in-from-top-2 duration-500 shadow-lg shadow-red-500/5">
          <div className="w-10 h-10 rounded-full bg-red-500/20 flex items-center justify-center flex-shrink-0">
            <Tag className="w-5 h-5 text-red-400" />
          </div>
          <div className="flex-1">
            <div className="text-sm font-black uppercase tracking-wider text-red-300 leading-tight">{t('wms_critical_alert')}</div>
            <div className="text-xs text-red-400/80 font-medium">{t('wms_critical_msg', { count: summary.low_stock_items })}</div>
          </div>
          <button onClick={() => { setSearch(''); setShowFilters(true); setCategoryFilter('LOW_STOCK'); }} className="px-3 py-1 bg-red-500 text-white text-[10px] font-black uppercase rounded-lg hover:bg-red-600 transition-colors">
            {t('wms_view_now')}
          </button>
        </div>
      )}

      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        {[
          { key: 'wms_total_skus', value: summary.total_skus || 0, color: 'text-purple-400', bg: 'bg-purple-500/10', icon: Tag },
          { key: 'wms_on_hand', value: summary.total_on_hand || 0, color: 'text-blue-400', bg: 'bg-blue-500/10', icon: Package },
          { key: 'wms_allocated', value: summary.total_allocated || 0, color: 'text-orange-400', bg: 'bg-orange-500/10', icon: Link2 },
          { key: 'wms_available', value: summary.total_available || 0, color: 'text-emerald-400', bg: 'bg-emerald-500/10', icon: CheckCircle },
          { key: 'wms_locations', value: summary.total_locations || 0, color: 'text-cyan-400', bg: 'bg-cyan-500/10', icon: MapPin },
        ].map(s => {
          const Icon = s.icon;
          return (
            <div key={s.key} className="border border-border/40 rounded-3xl p-4 bg-card/60 backdrop-blur-sm shadow-xl flex flex-col items-center group hover:scale-[1.02] transition-all">
              <div className={`w-10 h-10 rounded-2xl ${s.bg} flex items-center justify-center mb-3 group-hover:rotate-12 transition-transform`}>
                <Icon className={`w-5 h-5 ${s.color}`} />
              </div>
              <div className={`text-2xl font-black tabular-nums tracking-tighter ${s.color}`}>{(s.value || 0).toLocaleString()}</div>
              <div className="text-[10px] text-muted-foreground font-black uppercase tracking-widest mt-1 opacity-60">{t(s.key)}</div>
            </div>
          );
        })}
      </div>

      <div className="flex gap-2 flex-wrap items-center bg-card/40 p-2 rounded-2xl border border-border/20 backdrop-blur-md">
        <div className="relative flex-1 min-w-[200px]">
          <Search className="absolute left-4 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground opacity-50" />
          <input
            placeholder={t('wms_search_inv')}
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="w-full pl-11 pr-4 py-2.5 bg-background/50 border border-border/40 rounded-xl text-sm text-foreground focus:ring-2 focus:ring-primary/20 transition-all font-medium"
            data-testid="inv-search"
          />
        </div>
        <button
          onClick={() => setShowFilters(!showFilters)}
          className={`px-4 py-2.5 border border-border/40 rounded-xl text-xs font-bold uppercase tracking-widest flex items-center gap-2 transition-all ${showFilters || customerFilter || categoryFilter ? 'bg-primary text-black shadow-[0_0_10px_rgba(255,193,7,0.4)]' : 'bg-secondary/60 text-muted-foreground hover:bg-secondary hover:text-foreground'}`}
          data-testid="inv-toggle-filters"
        >
          <ScanLine className="w-4 h-4" />
          {t('filters')}
          {(customerFilter || categoryFilter) && (
            <span className="bg-black/10 px-2 py-0.5 rounded-lg text-[10px]">
              {[customerFilter, categoryFilter].filter(Boolean).length}
            </span>
          )}
        </button>
        <button
          onClick={() => setGroupByCustomer(!groupByCustomer)}
          className={`px-4 py-2.5 border border-border/40 rounded-xl text-xs font-bold uppercase tracking-widest flex items-center gap-2 transition-all ${groupByCustomer ? 'bg-blue-500 text-white shadow-[0_0_10px_rgba(59,130,246,0.4)]' : 'bg-secondary/60 text-muted-foreground hover:bg-secondary hover:text-foreground'}`}
          data-testid="inv-toggle-group"
        >
          <Package className="w-4 h-4" />
          {groupByCustomer ? t('wms_ungroup') || 'Desagrupar' : t('wms_group_cust') || 'Agrupar Cliente'}
        </button>
      </div>
      {showFilters && (
        <div className="grid grid-cols-2 md:grid-cols-3 gap-3 p-3 border border-border rounded-lg bg-secondary/30" data-testid="inv-filters-panel">
          <div>
            <label className="text-xs uppercase tracking-wider text-muted-foreground font-bold block mb-1">{t('client')}</label>
            <select value={customerFilter} onChange={e => setCustomerFilter(e.target.value)} className="w-full px-2 py-1.5 bg-background border border-border rounded text-sm text-foreground" data-testid="inv-filter-customer">
              <option value="">{t('all')}</option>
              {filters.customers.map(c => <option key={c} value={c}>{c}</option>)}
            </select>
          </div>
          <div>
            <label className="text-xs uppercase tracking-wider text-muted-foreground font-bold block mb-1">{t('category')}</label>
            <select value={categoryFilter} onChange={e => setCategoryFilter(e.target.value)} className="w-full px-2 py-1.5 bg-background border border-border rounded text-sm text-foreground" data-testid="inv-filter-category">
              <option value="">{t('all')}</option>
              {filters.categories.map(c => <option key={c} value={c}>{c}</option>)}
            </select>
          </div>
          <div className="flex items-end">
            <button onClick={() => { setCustomerFilter(''); setCategoryFilter(''); setSearch(''); }} className="px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground border border-border rounded">{t('wms_clear_filters')}</button>
          </div>
        </div>
      )}
      <div className="border border-border/20 rounded-2xl bg-card/40 backdrop-blur-sm overflow-hidden shadow-2xl">
        <div className="overflow-auto max-h-[600px] custom-scrollbar">
          <table className="w-full text-sm">
            <thead className="bg-secondary/80 backdrop-blur-md sticky top-0 z-10 border-b border-border/40">
              <tr>
                <th className="p-4 text-left text-[10px] font-black uppercase tracking-widest text-muted-foreground">{t('customer')}</th>
                <th className="p-4 text-left text-[10px] font-black uppercase tracking-widest text-muted-foreground">{t('wms_style_sku')}</th>
                <th className="p-4 text-left text-[10px] font-black uppercase tracking-widest text-muted-foreground">{t('wms_col_sz')}</th>
                <th className="p-4 text-left text-[10px] font-black uppercase tracking-widest text-muted-foreground">{t('description')}</th>
                <th className="p-4 text-left text-[10px] font-black uppercase tracking-widest text-muted-foreground">{t('location')}</th>
                <th className="p-4 text-left text-[10px] font-black uppercase tracking-widest text-muted-foreground">{t('country_of_origin')}</th>
                <th className="p-4 text-right text-[10px] font-black uppercase tracking-widest text-muted-foreground">{t('wms_boxes')}</th>
                <th className="p-4 text-right text-[10px] font-black uppercase tracking-widest text-muted-foreground">{t('wms_on_hand')}</th>
                <th className="p-4 text-right text-[10px] font-black uppercase tracking-widest text-muted-foreground">{t('wms_allocated')}</th>
                <th className="p-4 text-right text-[10px] font-black uppercase tracking-widest text-muted-foreground">{t('wms_available')}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border/10">
              {groupByCustomer ? (
                Object.entries(
                  inventory.reduce((acc, inv) => {
                    const cust = inv.customer || t('no_client');
                    if (!acc[cust]) acc[cust] = [];
                    acc[cust].push(inv);
                    return acc;
                  }, {})
                ).map(([customer, items]) => (
                  <Fragment key={customer}>
                    <tr className="bg-secondary/30">
                      <td colSpan="10" className="p-3">
                        <div className="flex items-center gap-2">
                          <div className="w-2 h-2 rounded-full bg-primary shadow-[0_0_8px_rgba(255,193,7,0.5)]" />
                          <span className="text-xs font-black uppercase tracking-widest text-foreground">{customer}</span>
                          <span className="text-[10px] font-bold text-muted-foreground ml-2">({items.length} SKUs)</span>
                        </div>
                      </td>
                    </tr>
                    {items.map((inv, i) => (
                      <tr key={inv.inventory_id || i} className="group border-b border-border/5 hover:bg-primary/5 transition-colors">
                        <td className="p-4 text-[11px] font-bold text-muted-foreground/80 opacity-40">{inv.customer}</td>
                        <td className="p-4 font-mono font-black text-primary text-xs uppercase group-hover:scale-105 transition-transform origin-left">{inv.style || inv.sku}</td>
                        <td className="p-4 text-[11px] font-bold">
                          <span className="text-foreground">{inv.color}</span>
                          <span className="mx-1 opacity-20">|</span>
                          <span className="text-primary">{inv.size}</span>
                        </td>
                        <td className="p-4 text-[11px] font-medium text-muted-foreground truncate max-w-[150px]" title={inv.description}>{inv.description}</td>
                        <td className="p-4 font-mono text-[11px] font-black text-emerald-400 flex items-center gap-1.5">
                          <div className="w-1.5 h-1.5 rounded-full bg-emerald-500/40" />
                          {inv.inv_location || '-'}
                        </td>
                        <td className="p-4 text-[11px] font-mono text-muted-foreground/80 uppercase">{inv.country_of_origin || '-'}</td>
                        <td className="p-4 text-right font-mono font-bold">{(inv.total_boxes || 0).toLocaleString()}</td>
                        <td className="p-4 text-right font-mono font-black text-blue-400">{(inv.on_hand || 0).toLocaleString()}</td>
                        <td className="p-4 text-right font-mono font-black text-orange-400">{(inv.allocated || 0).toLocaleString()}</td>
                        <td className="p-4 text-right font-mono font-black text-emerald-400 bg-emerald-500/5">
                          {(inv.available || 0).toLocaleString()}
                        </td>
                      </tr>
                    ))}
                  </Fragment>
                ))
              ) : (
                inventory.map((inv, i) => (
                  <tr key={inv.inventory_id || i} className="group border-b border-border/5 hover:bg-primary/5 transition-colors">
                    <td className="p-4 text-[11px] font-bold text-muted-foreground/80">{inv.customer}</td>
                    <td className="p-4 font-mono font-black text-primary text-xs uppercase group-hover:scale-105 transition-transform origin-left">{inv.style || inv.sku}</td>
                    <td className="p-4 text-[11px] font-bold">
                      <span className="text-foreground">{inv.color}</span>
                      <span className="mx-1 opacity-20">|</span>
                      <span className="text-primary">{inv.size}</span>
                    </td>
                    <td className="p-4 text-[11px] font-medium text-muted-foreground truncate max-w-[150px]" title={inv.description}>{inv.description}</td>
                    <td className="p-4 font-mono text-[11px] font-black text-emerald-400 flex items-center gap-1.5">
                      <div className="w-1.5 h-1.5 rounded-full bg-emerald-500/40" />
                      {inv.inv_location || '-'}
                    </td>
                    <td className="p-4 text-[11px] font-mono text-muted-foreground/80 uppercase">{inv.country_of_origin || '-'}</td>
                    <td className="p-4 text-right font-mono font-bold">{(inv.total_boxes || 0).toLocaleString()}</td>
                    <td className="p-4 text-right font-mono font-black text-blue-400">{(inv.on_hand || 0).toLocaleString()}</td>
                    <td className="p-4 text-right font-mono font-black text-orange-400">{(inv.allocated || 0).toLocaleString()}</td>
                    <td className="p-4 text-right font-mono font-black text-emerald-400 bg-emerald-500/5">
                      {(inv.available || 0).toLocaleString()}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
          {inventory.length === 0 && (
            <div className="flex flex-col items-center justify-center py-20 text-muted-foreground opacity-50">
              <BarChart3 className="w-16 h-16 mb-4 stroke-[1px]" />
              <p className="font-bold uppercase tracking-widest text-sm italic">{t('wms_no_inv')}</p>
              <p className="text-xs mt-1">{t('wms_import_hint')}</p>
            </div>
          )}
        </div>
      </div>
      <div className="text-[10px] font-black uppercase tracking-[0.2em] text-muted-foreground/40 text-right mt-2">
        {t('wms_showing_records', { count: inventory.length.toLocaleString() })}
      </div>
    </div>
  );
};
