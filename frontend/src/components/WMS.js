import { useState, useEffect, useCallback, Fragment } from "react";
import { useNavigate } from "react-router-dom";
import { Toaster, toast } from "sonner";
import {
  Package, MapPin, ClipboardList, BarChart3, Link2, ClipboardCheck,
  Factory, CheckCircle, History, ArrowLeft, Warehouse, Download, Plus,
  Search, Loader2, Trash2, Printer, Tag, ScanLine, Box, X, ChevronDown, ChevronRight, Edit3,
  Sun, Moon, Home, AlertTriangle, LayoutDashboard, ExternalLink, LogOut
} from "lucide-react";

import SearchableSelect from "./SearchableSelect";
import InventoryDashboard from "./InventoryDashboard";
import OrderHistoryModal from "./OrderHistoryModal";
import { useLang } from "../contexts/LanguageContext";

const API = `${process.env.REACT_APP_BACKEND_URL}/api/wms`;
const AUTH_API = `${process.env.REACT_APP_BACKEND_URL}/api/auth`;
const fetcher = (url) => fetch(`${API}${url}`, { credentials: 'include' }).then(r => r.ok ? r.json() : Promise.reject(r));
const poster = (url, body) => fetch(`${API}${url}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include', body: JSON.stringify(body) });
const putter = (url, body) => fetch(`${API}${url}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, credentials: 'include', body: JSON.stringify(body) });
const deleter = (url) => fetch(`${API}${url}`, { method: 'DELETE', credentials: 'include' }).then(r => r.ok ? r.json() : Promise.reject(r));



// ==================== RECEIVING MODULE ====================
const SIZES_ORDER = ['XS', 'S', 'M', 'L', 'XL', '2X', '3X', '4X', '5X'];

const ReceivingModule = () => {
  const { t } = useLang();
  const [records, setRecords] = useState([]);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({
    customer: '', manufacturer: '', style: '', color: '', size: '',
    description: '', country_of_origin: '', fabric_content: '',
    dozens: '', pieces: '', units: '', lot_number: '', sku: '', inv_location: '',
    is_bpo: false,
  });
  const [loading, setLoading] = useState(false);
  const [options, setOptions] = useState({ customers: [], manufacturers: [], styles: [], colors: [] });
  const [fieldOptions, setFieldOptions] = useState({ descriptions: [], countries: [], fabrics: [] });

  const load = useCallback(() => { fetcher('/receiving').then(setRecords).catch(() => {}); }, []);
  useEffect(() => { load(); }, [load]);

  // Load customers + field options on mount
  useEffect(() => {
    fetcher('/inventory/options?').then(data => {
      setOptions(prev => ({ ...prev, customers: data.customers || [] }));
    }).catch(() => {});
    fetcher('/inventory/field-options').then(data => {
      setFieldOptions({ descriptions: data.descriptions || [], countries: data.countries || [], fabrics: data.fabrics || [] });
    }).catch(() => {});
  }, []);

  const loadOptions = useCallback(async (customer, manufacturer, style) => {
    const params = new URLSearchParams();
    if (customer) params.set('customer', customer);
    if (manufacturer) params.set('manufacturer', manufacturer);
    if (style) params.set('style', style);
    try {
      const data = await fetcher(`/inventory/options?${params.toString()}`);
      setOptions(prev => ({ ...prev, ...data }));
    } catch {}
  }, []);

  const handleCustomerChange = (val) => {
    setForm(p => ({ ...p, customer: val, manufacturer: '', style: '', color: '' }));
    loadOptions(val, '', '');
  };
  const handleManufacturerChange = (val) => {
    setForm(p => ({ ...p, manufacturer: val, style: '', color: '' }));
    loadOptions(form.customer, val, '');
  };
  const handleStyleChange = (val) => {
    setForm(p => ({ ...p, style: val, color: '' }));
    loadOptions(form.customer, form.manufacturer, val);
  };
  const handleColorChange = (val) => {
    setForm(p => ({ ...p, color: val }));
  };

  // Auto-generate SKU when style/color/size change
  useEffect(() => {
    if (form.style) {
      const parts = [form.style.toUpperCase().replace(/\s+/g, '-')];
      if (form.color) parts.push(form.color.toUpperCase().replace(/\s+/g, '-').substring(0, 10));
      if (form.size) parts.push(form.size.toUpperCase());
      setForm(p => ({ ...p, sku: parts.join('-') }));
    }
  }, [form.style, form.color, form.size]); // eslint-disable-line react-hooks/exhaustive-deps

  const totalUnits = parseInt(form.units) || ((parseInt(form.dozens) || 0) * 12 + (parseInt(form.pieces) || 0));

  const handleSubmit = async () => {
    if (!form.style) { toast.error(t('wms_style_req')); return; }
    setLoading(true);
    try {
      const payload = {
        ...form,
        units: totalUnits,
        dozens: parseInt(form.dozens) || 0,
        pieces: parseInt(form.pieces) || 0,
      };
      const res = await poster('/receiving', payload);
      if (res.ok) {
        const data = await res.json();
        toast.success(`${t('wms_rcv_created')}: ${data.total_units || totalUnits} ${t('wms_units')}`);
        if (payload.is_bpo) {
          handlePrintLabel(data);
        }
        setShowForm(false);
        setForm({ customer: '', manufacturer: '', style: '', color: '', size: '', description: '', country_of_origin: '', fabric_content: '', dozens: '', pieces: '', units: '', lot_number: '', sku: '', inv_location: '', is_bpo: false });
        load();
      } else { const err = await res.json().catch(() => ({})); toast.error(err.detail || 'Error'); }
    } catch { toast.error(t('error_connection')); }
    finally { setLoading(false); }
  };

  const handlePrintLabel = (r) => {
    const pw = window.open('', '_blank');
    if (!pw) { toast.error(t('wms_popup_err')); return; }
    const dozens = r.dozens || 0;
    const pieces = r.pieces || 0;
    const units = r.total_units || r.units || (dozens * 12 + pieces);
    pw.document.write(`<html><head><title>${t('wms_mod_receiving')} - ${r.receiving_id}</title>
      <style>
        @page { size: 4in 6in; margin: 5mm; }
        body { font-family: Arial, sans-serif; margin: 0; padding: 10px; width: 3.6in; font-size: 11px; }
        @media print { body { padding: 0; } }
        .row { display: flex; border-bottom: 1px solid #000; }
        .cell { padding: 4px 6px; border-right: 1px solid #000; }
        .cell:last-child { border-right: none; }
        .label { font-size: 8px; text-transform: uppercase; color: #666; display: block; }
        .value { font-size: 12px; font-weight: bold; }
        .table { border: 1px solid #000; border-collapse: collapse; width: 100%; margin-top: 6px; }
      </style></head><body>
      <div style="text-align:center;margin-bottom:6px">
        <svg id="barcode"></svg>
      </div>
      <table class="table">
        <tr class="row">
          <td class="cell" style="width:60%"><span class="label">${t('wms_label_customer')}</span><span class="value">${r.customer || ''}</span></td>
          <td class="cell" style="width:40%"><span class="label">${t('wms_label_po')}</span><span class="value">${r.po || ''}</span></td>
        </tr>
        <tr class="row">
          <td class="cell" style="width:60%"><span class="label">${t('wms_label_lot')}</span><span class="value">${r.lot_number || ''}</span></td>
          <td class="cell" style="width:40%"><span class="label">${t('wms_label_location')}</span><span class="value">${r.inv_location || ''}</span></td>
        </tr>
        <tr class="row">
          <td class="cell" colspan="2"><span class="label">${t('wms_label_manufacturer')}</span><span class="value">${r.manufacturer || ''}</span></td>
        </tr>
        <tr class="row">
          <td class="cell" style="width:50%"><span class="label">${t('wms_label_style')}</span><span class="value" style="font-size:16px">${r.style || ''}</span></td>
          <td class="cell" style="width:50%"><span class="label">${t('wms_label_sku')}</span><span class="value" style="font-family:monospace">${r.sku || r.style || ''}</span></td>
        </tr>
        <tr class="row">
          <td class="cell" style="width:50%"><span class="label">${t('wms_label_color')}</span><span class="value">${r.color || ''}</span></td>
          <td class="cell" style="width:50%"><span class="label">${t('wms_label_size')}</span><span class="value" style="font-size:16px">${r.size || ''}</span></td>
        </tr>
        <tr class="row">
          <td class="cell" colspan="2"><span class="label">${t('wms_label_desc')}</span><span class="value">${r.description || ''}</span></td>
        </tr>
        <tr class="row">
          <td class="cell" style="width:50%"><span class="label">${t('wms_label_coo')}</span><span class="value">${r.country_of_origin || ''}</span></td>
          <td class="cell" style="width:50%"><span class="label">${t('wms_label_fabric')}</span><span class="value">${r.fabric_content || ''}</span></td>
        </tr>
        <tr class="row">
          <td class="cell" style="width:33%"><span class="label">${t('wms_label_dozens')}</span><span class="value" style="font-size:16px">${dozens}</span></td>
          <td class="cell" style="width:33%"><span class="label">${t('wms_label_pieces')}</span><span class="value" style="font-size:16px">${pieces}</span></td>
          <td class="cell" style="width:34%"><span class="label">${t('wms_label_units')}</span><span class="value" style="font-size:18px;color:#000">${units}</span></td>
        </tr>
      </table>
      <div style="margin-top:10px;display:flex;justify-content:space-between;font-size:9px;color:#666">
        <span>${r.receiving_id}</span>
        <span>${new Date(r.created_at).toLocaleDateString()}</span>
        <span>${r.received_by_name || ''}</span>
      </div>
      <script src="https://cdn.jsdelivr.net/npm/jsbarcode@3.11.5/dist/JsBarcode.all.min.js"><\/script>
      <script>try{JsBarcode("#barcode","${r.receiving_id}",{width:1.5,height:40,displayValue:true,fontSize:10,margin:0})}catch(e){}setTimeout(function(){window.print()},500);<\/script>
    </body></html>`);
    pw.document.close();
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="text-xs font-black uppercase tracking-widest text-muted-foreground bg-secondary/50 px-3 py-1 rounded-full border border-border/40">
          {t('wms_recent_entries')}: {records.length}
        </div>
        <button 
          onClick={() => setShowForm(!showForm)} 
          className="px-4 py-2 bg-primary text-black rounded-xl font-bold uppercase tracking-wider text-xs transition-all hover:scale-105 shadow-[0_0_15px_rgba(255,193,7,0.3)] flex items-center gap-2"
          data-testid="new-receiving-btn"
        >
          <Plus className="w-4 h-4" /> {t('wms_new_record')}
        </button>
      </div>
      {showForm && (
        <div className="border border-border rounded-lg p-4 bg-secondary/30 space-y-3" data-testid="receiving-form">
          <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
            <div>
              <label className="text-xs uppercase tracking-wider text-muted-foreground font-bold block mb-1">{t('customer')}</label>
              <SearchableSelect options={options.customers || []} value={form.customer} onChange={handleCustomerChange} placeholder={t('wms_search_customer')} testId="rcv-customer" />
            </div>
            <div>
              <label className="text-xs uppercase tracking-wider text-muted-foreground font-bold block mb-1">{t('manufacturer')}</label>
              <SearchableSelect options={options.manufacturers || []} value={form.manufacturer} onChange={handleManufacturerChange} placeholder={t('wms_search_manufacturer')} testId="rcv-manufacturer" />
            </div>
            <div>
              <label className="text-xs uppercase tracking-wider text-muted-foreground font-bold block mb-1">{t('wms_lot')}</label>
              <input placeholder={t('wms_lot')} value={form.lot_number} onChange={e => setForm(p => ({ ...p, lot_number: e.target.value }))} className="w-full px-3 py-2 bg-background border border-border rounded text-sm text-foreground" data-testid="rcv-lot" />
            </div>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
            <div>
              <label className="text-xs uppercase tracking-wider text-muted-foreground font-bold block mb-1">{t('style')}</label>
              <SearchableSelect options={options.styles || []} value={form.style} onChange={handleStyleChange} placeholder={t('wms_search_style')} testId="rcv-style" />
            </div>
            <div>
              <label className="text-xs uppercase tracking-wider text-muted-foreground font-bold block mb-1">{t('color')}</label>
              <SearchableSelect options={options.colors || []} value={form.color} onChange={handleColorChange} placeholder={t('wms_search_color')} testId="rcv-color" />
            </div>
            <div>
              <label className="text-xs uppercase tracking-wider text-muted-foreground font-bold block mb-1">{t('size')}</label>
              <select value={form.size} onChange={e => setForm(p => ({ ...p, size: e.target.value }))} className="w-full px-3 py-2 bg-background border border-border rounded text-sm text-foreground" data-testid="rcv-size">
                <option value="">{t('select_placeholder')}</option>
                {SIZES_ORDER.map(s => <option key={s} value={s}>{s}</option>)}
              </select>
            </div>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
            <div>
              <label className="text-xs uppercase tracking-wider text-muted-foreground font-bold block mb-1">{t('description')}</label>
              <SearchableSelect options={fieldOptions.descriptions} value={form.description} onChange={val => setForm(p => ({ ...p, description: val }))} placeholder={t('wms_search_desc')} testId="rcv-description" />
            </div>
            <div>
              <label className="text-xs uppercase tracking-wider text-muted-foreground font-bold block mb-1">{t('country_of_origin')}</label>
              <SearchableSelect options={fieldOptions.countries} value={form.country_of_origin} onChange={val => setForm(p => ({ ...p, country_of_origin: val }))} placeholder={t('wms_search_country')} testId="rcv-country" />
            </div>
            <div>
              <label className="text-xs uppercase tracking-wider text-muted-foreground font-bold block mb-1">{t('fabric_content')}</label>
              <SearchableSelect options={fieldOptions.fabrics} value={form.fabric_content} onChange={val => setForm(p => ({ ...p, fabric_content: val }))} placeholder={t('wms_search_fabric')} testId="rcv-fabric" />
            </div>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <div>
              <label className="text-xs text-muted-foreground mb-1 block">{t('dozens')}</label>
              <input type="number" placeholder="0" value={form.dozens} onChange={e => setForm(p => ({ ...p, dozens: e.target.value, units: '' }))} className="w-full px-3 py-2 bg-background border border-border rounded text-sm text-foreground" data-testid="rcv-dozens" />
            </div>
            <div>
              <label className="text-xs text-muted-foreground mb-1 block">{t('pieces_label')}</label>
              <input type="number" placeholder="0" value={form.pieces} onChange={e => setForm(p => ({ ...p, pieces: e.target.value, units: '' }))} className="w-full px-3 py-2 bg-background border border-border rounded text-sm text-foreground" data-testid="rcv-pieces" />
            </div>
            <div>
              <label className="text-xs text-muted-foreground mb-1 block">{t('wms_qty_auto')}</label>
              <input type="number" value={totalUnits} readOnly className="w-full px-3 py-2 bg-background border border-border rounded text-sm text-foreground font-bold" data-testid="rcv-units" />
            </div>
            <div>
              <label className="text-xs text-muted-foreground mb-1 block">{t('sku')} (auto)</label>
              <input value={form.sku} readOnly className="w-full px-3 py-2 bg-secondary/50 border border-border rounded text-sm text-foreground font-mono cursor-not-allowed" data-testid="rcv-sku" />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <input placeholder={t('wms_location_placeholder')} value={form.inv_location} onChange={e => setForm(p => ({ ...p, inv_location: e.target.value }))} className="px-3 py-2 bg-background border border-border rounded text-sm text-foreground font-mono" data-testid="rcv-location" />
            <label className="flex items-center gap-2 cursor-pointer p-2 bg-background/50 border border-border rounded-lg group hover:border-primary/50 transition-all">
              <input 
                type="checkbox" 
                checked={form.is_bpo} 
                onChange={e => setForm(p => ({ ...p, is_bpo: e.target.checked }))}
                className="w-4 h-4 rounded border-border text-primary focus:ring-primary/20 cursor-pointer" 
                data-testid="rcv-is-bpo" 
              />
              <div className="flex flex-col">
                <span className="text-xs font-black uppercase tracking-widest text-foreground group-hover:text-primary transition-colors">BACK ORDER (B.O.)</span>
                <span className="text-[9px] font-bold text-muted-foreground uppercase">{t('wms_bpo_hint') || 'Activar impresión automática'}</span>
              </div>
            </label>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-sm font-bold text-foreground">{t('total')}: {totalUnits} {t('wms_units')}</span>
          </div>
          <div className="flex gap-2">
            <button onClick={handleSubmit} disabled={loading} className="px-4 py-2 bg-primary text-primary-foreground rounded text-sm flex items-center gap-1.5 disabled:opacity-50" data-testid="rcv-submit">
              {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Package className="w-4 h-4" />} {t('wms_receive_btn')}
            </button>
            <button onClick={() => setShowForm(false)} className="px-4 py-2 bg-secondary text-foreground rounded text-sm">{t('cancel')}</button>
          </div>
        </div>
      )}
      <div className="grid grid-cols-1 gap-3 overflow-y-auto max-h-[600px] pr-2 custom-scrollbar">
        {records.map(r => (
          <div key={r.receiving_id} className="group border border-border/40 rounded-2xl p-4 bg-card/60 backdrop-blur-sm hover:border-primary/40 hover:bg-card transition-all relative overflow-hidden shadow-lg hover:shadow-primary/5 shadow-black/20" data-testid={`rcv-${r.receiving_id}`}>
            <div className="flex items-center justify-between gap-4">
              <div className="flex items-center gap-4 min-w-0">
                <div className="w-12 h-12 rounded-xl bg-blue-500/10 border border-blue-500/20 flex items-center justify-center flex-shrink-0 group-hover:scale-110 transition-transform">
                  <Package className="w-6 h-6 text-blue-400" />
                </div>
                <div className="min-w-0">
                  <div className="flex items-center gap-2 mb-0.5">
                    <span className="font-mono font-black text-primary text-sm uppercase tracking-tighter">
                      {r.style || t('wms_no_style')}
                    </span>
                    <span className="text-[10px] font-black uppercase bg-secondary/80 px-2 py-0.5 rounded text-muted-foreground tracking-widest">
                      {r.receiving_id}
                    </span>
                  </div>
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                    <span className="text-xs font-bold text-foreground truncate max-w-[150px]">{r.customer || t('wms_no_client')}</span>
                    <span className="text-xs text-muted-foreground font-medium">{r.color} / {r.size || 'N/A'}</span>
                    {r.inv_location && (
                      <span className="text-[10px] font-black uppercase text-emerald-400 bg-emerald-500/10 px-2 py-0.5 rounded flex items-center gap-1">
                        <MapPin className="w-2.5 h-2.5" /> {r.inv_location}
                      </span>
                    )}
                    {r.is_bpo && (
                      <span className="text-[10px] font-black uppercase text-amber-400 bg-amber-500/10 px-2 py-0.5 rounded flex items-center gap-1 border border-amber-500/20">
                        B.O.
                      </span>
                    )}
                  </div>
                </div>
              </div>

              <div className="flex items-center gap-4 flex-shrink-0">
                <div className="text-right">
                  <div className="text-lg font-black tabular-nums leading-none">
                    {(r.total_units || r.units || 0).toLocaleString()}
                    <span className="text-[10px] uppercase text-muted-foreground ml-1 font-bold">Units</span>
                  </div>
                  <div className="text-[10px] text-muted-foreground font-bold uppercase tracking-widest mt-1">
                    {new Date(r.created_at).toLocaleDateString(undefined, { day: '2-digit', month: 'short' })}
                  </div>
                </div>
                
                <div className="flex items-center gap-2 h-10 border-l border-border/40 pl-4">
                  <button 
                    onClick={() => handlePrintLabel(r)} 
                    className="p-2.5 text-muted-foreground hover:text-primary rounded-xl hover:bg-primary/10 transition-all shadow-none hover:shadow-lg shadow-primary/20" 
                    title="Imprimir etiqueta"
                    data-testid={`rcv-print-${r.receiving_id}`}
                  >
                    <Printer className="w-5 h-5" />
                  </button>
                </div>
              </div>
            </div>
            
            {/* Detalles expandibles sutiles */}
            <div className="mt-3 pt-3 border-t border-border/20 flex gap-4 text-[10px] font-black uppercase tracking-widest text-muted-foreground/60">
              <span className="flex items-center gap-1"><Factory className="w-3 h-3" /> {r.manufacturer || '-'}</span>
              <span className="flex items-center gap-1">LOT: {r.lot_number || '-'}</span>
              <span className="ml-auto opacity-40">By: {r.received_by_name || 'System'}</span>
            </div>
          </div>
        ))}
        {records.length === 0 && (
          <div className="flex flex-col items-center justify-center py-20 text-muted-foreground opacity-50 bg-secondary/10 rounded-3xl border border-dashed border-border/40">
            <Package className="w-16 h-16 mb-4 stroke-[1px]" />
            <p className="font-bold uppercase tracking-widest text-sm italic">{t('wms_no_rcv')}</p>
            <p className="text-xs mt-1">{t('wms_new_rcv_hint')}</p>
          </div>
        )}
      </div>
    </div>
  );
};

// ==================== LABELING MODULE ====================
const LabelingModule = () => {
  const { t } = useLang();
  const [boxes, setBoxes] = useState([]);
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState(new Set());

  const load = useCallback(() => { fetcher(`/boxes?po=${search}`).then(setBoxes).catch(() => {}); }, [search]);
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
                <td className="p-2"><span className={`text-xs px-2 py-0.5 rounded-full ${b.status === 'stored' ? 'bg-green-500/15 text-green-400' : b.status === 'received' ? 'bg-blue-500/15 text-blue-400' : 'bg-gray-500/15 text-gray-400'}`}>{b.status}</span></td>
              </tr>
            ))}
          </tbody>
        </table>
        {boxes.length === 0 && <div className="text-center text-muted-foreground text-sm py-8">{t('wms_no_boxes')}</div>}
      </div>
    </div>
  );
};

// ==================== PUTAWAY MODULE ====================
const PutawayModule = () => {
  const { t } = useLang();
  const [boxId, setBoxId] = useState('');
  const [location, setLocation] = useState('');
  const [locations, setLocations] = useState([]);
  const [pendingBoxes, setPendingBoxes] = useState([]);
  const [boxDetails, setBoxDetails] = useState(null);
  const [loading, setLoading] = useState(false);
  const [searching, setSearching] = useState(false);
  const [newLoc, setNewLoc] = useState({ name: '', zone: '', type: 'rack' });
  const [showNewLoc, setShowNewLoc] = useState(false);

  const loadLocations = useCallback(() => { fetcher('/locations').then(setLocations).catch(() => {}); }, []);
  const loadPending = useCallback(() => { fetcher('/boxes?status=received').then(setPendingBoxes).catch(() => {}); }, []);
  useEffect(() => { loadLocations(); loadPending(); }, [loadLocations, loadPending]);

  const fetchBoxDetails = useCallback(async (id) => {
    if (!id || id.length < 3) { setBoxDetails(null); return; }
    setSearching(true);
    try {
      const res = await fetcher(`/boxes/${id}`);
      if (res && res.box_id) setBoxDetails(res);
      else setBoxDetails(null);
    } catch { setBoxDetails(null); }
    finally { setSearching(false); }
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => {
      if (boxId) fetchBoxDetails(boxId);
    }, 500);
    return () => clearTimeout(timer);
  }, [boxId, fetchBoxDetails]);

  const handlePutaway = async () => {
    if (!boxId || !location) { toast.error(t('wms_box_loc_req')); return; }
    setLoading(true);
    try {
      const payload = { box_id: boxId, location };
      if (boxDetails && boxDetails.po) {
        payload.po = boxDetails.po; // Enviar PO posiblemente editado
      }
      const res = await poster('/putaway', payload);
      if (res.ok) { 
        toast.success(t('wms_box_located', { boxId, location })); 
        setBoxId(''); 
        setBoxDetails(null);
        loadPending(); 
      }
      else { const err = await res.json().catch(() => ({})); toast.error(err.detail || 'Error'); }
    } catch { toast.error(t('conn_error')); }
    finally { setLoading(false); }
  };

  const handleCreateLoc = async () => {
    if (!newLoc.name) { toast.error(t('wms_name_req')); return; }
    const res = await poster('/locations', newLoc);
    if (res.ok) { toast.success(t('wms_loc_created')); setNewLoc({ name: '', zone: '', type: 'rack' }); setShowNewLoc(false); loadLocations(); }
    else { const err = await res.json().catch(() => ({})); toast.error(err.detail || 'Error'); }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="text-xs font-black uppercase tracking-widest text-muted-foreground bg-secondary/50 px-3 py-1 rounded-full border border-border/40 flex items-center gap-2">
          <div className="w-1.5 h-1.5 rounded-full bg-purple-500 animate-pulse" />
          {t('wms_mod_putaway')}
        </div>
        <button 
          onClick={() => setShowNewLoc(!showNewLoc)} 
          className="px-4 py-2 bg-secondary text-foreground border border-border/40 rounded-xl font-bold uppercase tracking-wider text-xs flex items-center gap-2 transition-all hover:bg-secondary/80 shadow-lg"
        >
          <MapPin className="w-4 h-4 text-primary" /> {showNewLoc ? t('close') : `+ ${t('wms_new_loc_btn') || t('add')}`}
        </button>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="border border-border rounded-lg p-4 bg-card space-y-3">
          <div className="text-sm font-bold text-foreground flex items-center gap-2"><ScanLine className="w-4 h-4 text-primary" /> {t('wms_scan_input')}</div>
          <div className="relative">
            <input placeholder={t('wms_box_id_placeholder')} value={boxId} onChange={e => setBoxId(e.target.value.toUpperCase())} className="w-full px-3 py-2 bg-background border border-border rounded text-sm text-foreground font-mono" data-testid="putaway-box-input" />
            {searching && <Loader2 className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-primary animate-spin" />}
          </div>
          <select value={location} onChange={e => setLocation(e.target.value)} className="w-full px-3 py-2 bg-background border border-border rounded text-sm text-foreground" data-testid="putaway-loc-select">
            <option value="">{t('wms_select_location')}</option>
            {locations.map(l => <option key={l.location_id} value={l.name}>{l.name} {l.zone ? `(${l.zone})` : ''}</option>)}
          </select>
          <button 
            onClick={handlePutaway} 
            disabled={loading || !boxId || !location}
            className="w-full px-4 py-2 bg-primary text-primary-foreground rounded text-sm font-medium flex items-center justify-center gap-2 disabled:opacity-50" 
            data-testid="putaway-submit"
          >
            {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <ClipboardCheck className="w-4 h-4" />}
            {t('wms_locate_btn')}
          </button>
        </div>

        {/* Box Info View */}
        <div className="border border-border rounded-lg p-4 bg-card flex flex-col justify-center min-h-[150px]">
          {boxDetails ? (
            <div className="space-y-3 animate-in fade-in duration-300">
               <div className="flex justify-between items-start">
                 <div>
                   <div className="text-[10px] font-black uppercase text-muted-foreground">{t('wms_label_sku')}</div>
                   <div className="text-sm font-black text-primary">{boxDetails.sku}</div>
                 </div>
                 <div className="text-right">
                   <div className="text-[10px] font-black uppercase text-muted-foreground">{t('units')}</div>
                   <div className="text-sm font-black">{boxDetails.units}</div>
                 </div>
               </div>
               <div className="p-3 bg-secondary/50 rounded-xl border border-border/20">
                 <label className="text-[9px] font-black uppercase text-blue-400 block mb-1">PO / ORDER (Editable)</label>
                 <input 
                   value={boxDetails.po || ''} 
                   onChange={e => setBoxDetails(p => ({ ...p, po: e.target.value }))}
                   className="w-full bg-transparent border-none p-0 text-sm font-bold focus:ring-0"
                 />
               </div>
            </div>
          ) : (
            <div className="text-center opacity-30 italic text-xs">
              <Box className="w-8 h-8 mx-auto mb-2 opacity-20" />
              {t('wms_scan_hint') || 'Escanea una caja para ver detalles'}
            </div>
          )}
        </div>
      </div>
        <div className="border border-border rounded-lg p-4 bg-card space-y-3">
          <div className="flex items-center justify-between">
            <div className="text-sm font-bold text-foreground flex items-center gap-2"><MapPin className="w-4 h-4 text-primary" /> {t('wms_locations')} ({locations.length})</div>
            <button onClick={() => setShowNewLoc(!showNewLoc)} className="text-xs text-primary hover:underline flex items-center gap-1"><Plus className="w-3 h-3" /> {t('add')}</button>
          </div>
          {showNewLoc && (
            <div className="flex gap-2">
              <input placeholder={t('wms_loc_name_placeholder')} value={newLoc.name} onChange={e => setNewLoc(p => ({ ...p, name: e.target.value }))} className="flex-1 px-2 py-1.5 bg-background border border-border rounded text-sm text-foreground" />
              <input placeholder={t('wms_zone')} value={newLoc.zone} onChange={e => setNewLoc(p => ({ ...p, zone: e.target.value }))} className="w-20 px-2 py-1.5 bg-background border border-border rounded text-sm text-foreground" />
              <button onClick={handleCreateLoc} className="px-3 py-1.5 bg-primary text-primary-foreground rounded text-sm">{t('wms_create_btn')}</button>
            </div>
          )}
          <div className="max-h-40 overflow-auto space-y-1">
            {locations.map(l => (
              <div key={l.location_id} className="flex items-center justify-between px-2 py-1 text-xs bg-secondary/50 rounded">
                <span className="font-mono font-medium">{l.name}</span>
                <span className="text-muted-foreground">{l.zone}</span>
              </div>
            ))}
          </div>
        </div>

        <div className="border border-border/20 rounded-3xl p-6 bg-card/40 backdrop-blur-sm shadow-xl space-y-4">
          <div className="text-[10px] font-black uppercase tracking-widest text-muted-foreground opacity-60 flex items-center gap-2">
          <Package className="w-4 h-4" /> {t('wms_unlocated_mat')}
        </div>
        <div className="space-y-2 max-h-[400px] overflow-auto custom-scrollbar pr-2 font-mono">
          {pendingBoxes.map(b => (
            <button 
              key={b.box_id} 
              onClick={() => setBoxId(b.box_id)}
              className={`w-full flex items-center justify-between p-3 rounded-xl border transition-all 
                ${boxId === b.box_id ? 'bg-primary/20 border-primary text-primary shadow-lg shadow-primary/10' : 'bg-secondary/40 border-border/10 text-muted-foreground hover:bg-secondary hover:text-foreground'}`}
            >
              <div className="flex flex-col items-start">
                <span className="text-xs font-black">{b.box_id}</span>
                <span className="text-[10px] opacity-60">{b.sku} / {b.units} UN</span>
              </div>
              <ChevronRight className="w-4 h-4 opacity-40" />
            </button>
          ))}
          {pendingBoxes.length === 0 && <div className="text-center text-muted-foreground text-xs py-4">{t('wms_all_located')}</div>}
        </div>
      </div>
    </div>
  );
};

// ==================== INVENTORY MODULE ====================
const InventoryModule = () => {
  const { t } = useLang();
  const [inventory, setInventory] = useState([]);
  const [summary, setSummary] = useState({});
  const [filters, setFilters] = useState({ customers: [], categories: [], manufacturers: [], styles: [] });
  const [search, setSearch] = useState('');
  const [customerFilter, setCustomerFilter] = useState('');
  const [categoryFilter, setCategoryFilter] = useState('');
  const [importing, setImporting] = useState(false);
  const [showFilters, setShowFilters] = useState(false);
  const [groupByCustomer, setGroupByCustomer] = useState(false);

  const loadFilters = useCallback(() => { fetcher('/inventory/filters').then(setFilters).catch(() => {}); }, []);
  const load = useCallback(() => {
    const params = new URLSearchParams();
    if (search) params.set('style', search);
    if (customerFilter) params.set('customer', customerFilter);
    if (categoryFilter) params.set('category', categoryFilter);
    fetcher(`/inventory?${params.toString()}`).then(setInventory).catch(() => {});
    fetcher('/inventory/summary').then(setSummary).catch(() => {});
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
                      <td colSpan="9" className="p-3">
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


// ==================== ALLOCATION MODULE ====================
const AllocationModule = () => {
  const { t } = useLang();
  const [allocations, setAllocations] = useState([]);
  const [showForm, setShowForm] = useState(false);
  const [orders, setOrders] = useState([]);
  const [inventory, setInventory] = useState([]);
  const [selectedOrder, setSelectedOrder] = useState('');
  const [items, setItems] = useState([{ sku: '', color: '', size: '', qty: '', maxQty: 0 }]);
  const [loading, setLoading] = useState(false);

  const loadAllocations = useCallback(() => { fetcher('/allocations').then(setAllocations).catch(() => {}); }, []);
  const loadOrders = useCallback(() => { fetcher('/orders').then(setOrders).catch(() => {}); }, []);
  const loadInventory = useCallback(() => { fetcher('/inventory').then(setInventory).catch(() => {}); }, []);
  useEffect(() => { loadAllocations(); loadOrders(); loadInventory(); }, [loadAllocations, loadOrders, loadInventory]);

  const availableInv = inventory.filter(inv => (inv.available || 0) > 0);
  const addItem = () => setItems(p => [...p, { sku: '', color: '', size: '', qty: '', maxQty: 0 }]);
  const removeItem = (i) => setItems(p => p.filter((_, idx) => idx !== i));
  const updateItem = (i, field, val) => setItems(p => p.map((it, idx) => idx === i ? { ...it, [field]: val } : it));

  const selectInventoryItem = (i, invKey) => {
    if (!invKey) { updateItem(i, 'sku', ''); updateItem(i, 'color', ''); updateItem(i, 'size', ''); return; }
    const [sku, color, size] = invKey.split('||');
    const inv = inventory.find(x => (x.style || x.sku) === sku && (x.color || '') === color && (x.size || '') === size);
    setItems(p => p.map((it, idx) => idx === i ? { ...it, sku, color, size, qty: '', maxQty: inv?.available || 0 } : it));
  };

  const handleSubmit = async () => {
    if (!selectedOrder) { toast.error(t('wms_select_order_err')); return; }
    const validItems = items.filter(it => it.sku && parseInt(it.qty) > 0);
    if (validItems.length === 0) { toast.error(t('wms_min_item_err')); return; }
    setLoading(true);
    try {
      const res = await poster('/allocations', {
        order_id: selectedOrder,
        items: validItems.map(it => ({ sku: it.sku, color: it.color, size: it.size, qty: parseInt(it.qty) }))
      });
      if (res.ok) {
        toast.success(t('wms_alloc_success'));
        setShowForm(false); setSelectedOrder(''); setItems([{ sku: '', color: '', size: '', qty: '', maxQty: 0 }]);
        loadAllocations(); loadInventory();
      } else { const err = await res.json().catch(() => ({})); toast.error(err.detail || t('wms_alloc_create_err')); }
    } catch { toast.error(t('error_connection')); }
    finally { setLoading(false); }
  };

  const handleDelete = async (id) => {
    if (!window.confirm(t('wms_alloc_del_conf'))) return;
    try { 
      const res = await deleter(`/allocations/${id}`); 
      if (res.ok) {
        toast.success(t('wms_alloc_deleted') || 'Allocation eliminada'); 
        loadAllocations(); loadInventory(); 
      } else {
        toast.error(t('wms_alloc_del_err'));
      }
    }
    catch { toast.error(t('error_connection')); }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-bold text-foreground">{t('allocation')}</h2>
        <button onClick={() => setShowForm(!showForm)} className="px-3 py-1.5 bg-primary text-primary-foreground rounded text-sm flex items-center gap-1.5" data-testid="new-allocation-btn">
          <Plus className="w-4 h-4" /> {t('wms_new_loc')}
        </button>
      </div>
      {showForm && (
        <div className="border border-border rounded-lg p-4 bg-secondary/30 space-y-3" data-testid="allocation-form">
          <div>
            <label className="text-xs uppercase tracking-wider text-muted-foreground font-bold block mb-1">{t('order')}</label>
            <select value={selectedOrder} onChange={e => setSelectedOrder(e.target.value)} className="w-full px-3 py-2 bg-background border border-border rounded text-sm text-foreground" data-testid="alloc-order-select">
              <option value="">{t('select_order_placeholder')}</option>
              {orders.map(o => (
                <option key={o.order_id} value={o.order_id}>
                  {o.order_number} - {o.client || o.customer || t('no_client')} ({o.wms_status || 'pending'})
                </option>
              ))}
            </select>
          </div>
          <div className="text-xs uppercase tracking-wider text-muted-foreground font-bold">{t('items_to_allocate')}</div>
          {items.map((item, i) => (
            <div key={i} className="grid grid-cols-6 gap-2 items-end">
              <div className="col-span-3">
                <select value={item.sku ? `${item.sku}||${item.color}||${item.size}` : ''} onChange={e => selectInventoryItem(i, e.target.value)}
                  className="w-full px-2 py-1.5 bg-background border border-border rounded text-sm text-foreground" data-testid={`alloc-inv-${i}`}>
                  <option value="">{t('select_inventory')}</option>
                  {availableInv.map(inv => (
                    <option key={`${inv.style || inv.sku}-${inv.color}-${inv.size}-${inv.inv_location || ''}`} value={`${inv.style || inv.sku}||${inv.color || ''}||${inv.size || ''}`}>
                      {inv.customer ? `[${inv.customer}] ` : ''}{inv.style || inv.sku} {inv.color} {inv.size} ({t('avail')}: {inv.available})
                    </option>
                  ))}
                </select>
              </div>
              <div className="text-xs text-muted-foreground truncate">
                {item.maxQty > 0 && <span>{t('max')}: {item.maxQty}</span>}
              </div>
              <input type="number" placeholder={t('qty')} value={item.qty} onChange={e => updateItem(i, 'qty', e.target.value)} min="1" max={item.maxQty || 99999}
                className="px-2 py-1.5 bg-background border border-border rounded text-sm text-foreground" data-testid={`alloc-qty-${i}`} />
              <button onClick={() => removeItem(i)} className="p-1.5 text-muted-foreground hover:text-destructive"><Trash2 className="w-4 h-4" /></button>
            </div>
          ))}
          <button onClick={addItem} className="text-xs text-primary hover:underline flex items-center gap-1"><Plus className="w-3 h-3" /> {t('add_item')}</button>
          <div className="flex gap-2">
            <button onClick={handleSubmit} disabled={loading} className="px-4 py-2 bg-primary text-primary-foreground rounded text-sm flex items-center gap-1.5 disabled:opacity-50" data-testid="alloc-submit">
              {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Link2 className="w-4 h-4" />} {t('allocate_inventory')}
            </button>
            <button onClick={() => setShowForm(false)} className="px-4 py-2 bg-secondary text-foreground rounded text-sm">{t('cancel')}</button>
          </div>
        </div>
      )}
      <div className="space-y-2">
        {allocations.map(a => (
          <div key={a.allocation_id} className="border border-border rounded-lg p-3 bg-card" data-testid={`alloc-${a.allocation_id}`}>
            <div className="flex items-center justify-between">
              <div>
                <span className="font-mono font-bold text-primary text-sm">{a.order_number}</span>
                <span className={`ml-2 text-xs px-2 py-0.5 rounded-full ${a.status === 'allocated' ? 'bg-orange-500/15 text-orange-400' : 'bg-green-500/15 text-green-400'}`}>{a.status}</span>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-xs text-muted-foreground">{new Date(a.created_at).toLocaleDateString()}</span>
                <button onClick={() => handleDelete(a.allocation_id)} className="p-1 text-muted-foreground hover:text-destructive" title={t('delete')} data-testid={`alloc-delete-${a.allocation_id}`}>
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>
            <div className="mt-2 flex flex-wrap gap-2">
              {(a.items || []).map((it, i) => <span key={i} className="text-xs bg-secondary px-2 py-1 rounded">{it.sku} {it.color} {it.size}: {it.qty}</span>)}
            </div>
          </div>
        ))}
        {allocations.length === 0 && <div className="text-center text-muted-foreground text-sm py-8">{t('no_allocations')}</div>}
      </div>
    </div>
  );
};

// ==================== PICKING MODULE ====================
const PickingModule = () => {
  const { t } = useLang();
  const [tickets, setTickets] = useState([]);
  const [orders, setOrders] = useState([]);
  const [operators, setOperators] = useState([]);
  const [showForm, setShowForm] = useState(false);
  const [incidentTicket, setIncidentTicket] = useState(null);
  const [editingTicket, setEditingTicket] = useState(null);
  const [loading, setLoading] = useState(false);
  const [sizeLocations, setSizeLocations] = useState({});
  const [options, setOptions] = useState({ customers: [], manufacturers: [], styles: [], colors: [] });

  // Load all customers on mount
  useEffect(() => {
    fetcher('/inventory/options?').then(data => {
      setOptions(prev => ({ ...prev, customers: data.customers || [] }));
    }).catch(() => {});
  }, []);
  const [activeTab, setActiveTab] = useState('pending'); // pending | completed | dashboard
  const [activeBoardFilter, setActiveBoardFilter] = useState('ALL'); // ALL | SCHEDULING | BLANKS

  const [stats, setStats] = useState(null);
  const [filterOp, setFilterOp] = useState('');
  const emptyForm = { order_number: '', customer: '', manufacturer: '', style: '', color: '', quantity: 0, assigned_to: '', assigned_to_name: '', sizes: { XS: '', S: '', M: '', L: '', XL: '', '2X': '', '3X': '', '4X': '', '5X': '' } };
  const [form, setForm] = useState(emptyForm);

  const loadTickets = useCallback(() => { fetcher('/pick-tickets').then(setTickets).catch(() => {}); }, []);
  const loadOrders = useCallback(() => { fetcher('/orders').then(setOrders).catch(() => {}); }, []);
  const loadOperators = useCallback(() => { fetcher('/operators').then(setOperators).catch(() => {}); }, []);
  const loadStats = useCallback(() => { fetcher('/pick-tickets/stats').then(setStats).catch(() => {}); }, []);
  useEffect(() => { loadTickets(); loadOrders(); loadOperators(); loadStats(); }, [loadTickets, loadOrders, loadOperators, loadStats]);

  const loadOptions = useCallback(async (customer, manufacturer, style) => {
    if (!customer) { setOptions(prev => ({ ...prev, manufacturers: [], styles: [], colors: [] })); return; }
    const params = new URLSearchParams({ customer });
    if (manufacturer) params.set('manufacturer', manufacturer);
    if (style) params.set('style', style);
    try { const data = await fetcher(`/inventory/options?${params.toString()}`); setOptions(prev => ({ ...prev, ...data })); }
    catch { setOptions(prev => ({ ...prev, manufacturers: [], styles: [], colors: [] })); }
  }, []);

  const handleOrderLookup = async (orderNum) => {
    setForm(p => ({ ...p, order_number: orderNum, manufacturer: '', style: '', color: '' }));
    setSizeLocations({});
    if (!orderNum) { setOptions({ manufacturers: [], styles: [], colors: [] }); return; }
    const order = orders.find(o => o.order_number === orderNum);
    if (order) {
      const customer = order.client || order.branding || '';
      setForm(p => ({ ...p, customer, quantity: order.quantity || 0 }));
      loadOptions(customer, '', '');
    }
  };
  const handleCustomerChange = (val) => { setForm(p => ({ ...p, customer: val, manufacturer: '', style: '', color: '' })); setSizeLocations({}); loadOptions(val, '', ''); };
  const handleManufacturerChange = (val) => { setForm(p => ({ ...p, manufacturer: val, style: '', color: '' })); setSizeLocations({}); loadOptions(form.customer, val, ''); };
  const handleStyleChange = (val) => { setForm(p => ({ ...p, style: val, color: '' })); setSizeLocations({}); loadOptions(form.customer, form.manufacturer, val); };
  const handleColorChange = (val) => { setForm(p => ({ ...p, color: val })); if (form.style && val) lookupLocations(form.style, val); else setSizeLocations({}); };

  const lookupLocations = useCallback(async (style, color) => {
    if (!style) { setSizeLocations({}); return; }
    try {
      const params = new URLSearchParams({ style });
      if (color) params.set('color', color);
      const data = await fetcher(`/inventory/locations-lookup?${params.toString()}`);
      setSizeLocations(data.sizes || {});
    } catch { setSizeLocations({}); }
  }, []);

  const updateSize = (size, val) => setForm(p => ({ ...p, sizes: { ...p.sizes, [size]: val } }));
  const getTotalAvail = (sz) => (sizeLocations[sz]?.locations || []).reduce((sum, loc) => sum + (loc.available || 0), 0);
  const totalPick = Object.values(form.sizes).reduce((s, v) => s + (parseInt(v) || 0), 0);

  const openEdit = (t) => {
    setEditingTicket(t);
    const sizesObj = {};
    SIZES_ORDER.forEach(sz => { sizesObj[sz] = t.sizes?.[sz] || ''; });
    setForm({
      order_number: t.order_number || '', customer: t.customer || '', manufacturer: t.manufacturer || '',
      style: t.style || '', color: t.color || '', quantity: t.quantity || 0,
      assigned_to: t.assigned_to || '', assigned_to_name: t.assigned_to_name || '', sizes: sizesObj
    });
    setSizeLocations(t.size_locations || {});
    if (t.customer) loadOptions(t.customer, t.manufacturer || '', t.style || '');
    setShowForm(true);
  };

  const resetForm = () => {
    setEditingTicket(null);
    setForm(emptyForm);
    setSizeLocations({}); setOptions({ manufacturers: [], styles: [], colors: [] });
    setShowForm(false);
  };

  const handleSubmit = async () => {
    if (!form.order_number || !form.style) { toast.error(t('order_style_req')); return; }
    if (totalPick === 0) { toast.error(t('enter_qty_size')); return; }
    setLoading(true);
    try {
      const payload = { ...form, client: form.customer, sizes: Object.fromEntries(Object.entries(form.sizes).map(([k, v]) => [k, parseInt(v) || 0])) };
      let res;
      if (editingTicket) {
        res = await putter(`/pick-tickets/${editingTicket.ticket_id}/edit`, payload);
      } else {
        res = await poster('/pick-tickets', payload);
      }
      if (res.ok) {
        toast.success(editingTicket ? t('ticket_updated') : t('ticket_created'));
        resetForm();
        loadTickets(); loadStats();
      } else { const err = await res.json().catch(() => ({})); toast.error(err.detail || t('error')); }
    } catch { toast.error(t('conn_error')); }
    finally { setLoading(false); }
  };

  const handleConfirm = async (ticket) => {
    if (!window.confirm(t('confirm_ticket'))) return;
    try {
      const res = await putter(`/pick-tickets/${ticket.ticket_id}/confirm`, { lines: ticket.lines || [] });
      if (res.ok) { toast.success(t('pick_confirmed')); loadTickets(); loadStats(); }
      else { const err = await res.json().catch(() => ({})); toast.error(err.detail || t('error')); }
    } catch { toast.error(t('conn_error')); }
  };

  const handleQuickStatus = async (ticket_id, new_status) => {
    try {
      const res = await putter(`/pick-tickets/${ticket_id}/status`, { blank_status: new_status });
      if (res.ok) { toast.success(t('status_updated')); loadTickets(); }
      else { const err = await res.json().catch(() => ({})); toast.error(err.detail || t('error')); }
    } catch { toast.error(t('conn_error')); }
  };

  const handleQuickAssign = async (ticket_id, user_val) => {
    try {
      const op = operators.find(o => o.user_id === user_val || o.email === user_val) || {};
      const payload = { 
        operator_id: user_val || "", 
        operator_name: op.name || op.email || "",
        assigned_to: user_val || "",
        assigned_to_name: op.name || op.email || ""
      };
      const res = await putter(`/pick-tickets/${ticket_id}/assign`, payload);
      if (res.ok) { toast.success(t('assigned_correctly')); loadTickets(); loadStats(); }
      else { const err = await res.json().catch(() => ({})); toast.error(err.detail || t('error')); }
    } catch { toast.error(t('conn_error')); }
  };

  const handlePrint = (ticket) => {
    const pw = window.open('', '_blank');
    if (!pw) { toast.error(t('allow_popups')); return; }
    const sizes = ticket.sizes || {};
    const sizeLocs = ticket.size_locations || {};
    const totalQty = SIZES_ORDER.reduce((s, sz) => s + (parseInt(sizes[sz]) || 0), 0);
    const gridRows = SIZES_ORDER.filter(sz => parseInt(sizes[sz]) > 0).map(sz => {
      const locs = (sizeLocs[sz]?.locations || sizeLocs[sz] || []).slice(0, 3);
      const locStr = locs.map(l => `${l.location} (${l.available})`).join(', ') || '-';
      return `<tr><td style="border:1px solid #000;padding:4px 8px;font-weight:bold;text-align:center;font-size:16px">${sz}</td><td style="border:1px solid #000;padding:4px 8px;text-align:center;font-size:20px;font-weight:bold">${sizes[sz]}</td><td style="border:1px solid #000;padding:4px 8px;font-size:11px;font-family:monospace">${locStr}</td></tr>`;
    }).join('');
    pw.document.write(`<html><head><title>Pick Ticket - ${ticket.ticket_id}</title><style>@page{size:4in 6in;margin:6mm}body{font-family:Arial,sans-serif;margin:0;padding:10px;width:3.6in}@media print{body{padding:0}}</style></head><body><div style="text-align:center;font-size:16px;font-weight:bold;margin-bottom:4px">${ticket.customer || ''}</div><div style="text-align:center;margin:6px 0"><svg id="barcode"></svg></div><div style="display:flex;justify-content:space-between;margin-bottom:4px"><div><div style="font-size:13px;font-weight:bold">${ticket.customer || ''}</div><div style="font-size:12px;font-weight:bold">${ticket.manufacturer || ''}</div><div style="font-size:12px;font-weight:bold">${ticket.color || ''}</div></div><div style="text-align:right"><div style="font-size:9px;color:#666">${t('pick_ticket')}:</div><div style="font-size:11px;font-weight:bold">${ticket.ticket_id}</div><div style="font-size:18px;font-weight:bold">${ticket.style || ''}</div><div style="font-size:14px;font-weight:bold">${ticket.quantity || ''}</div></div></div><table style="width:100%;border-collapse:collapse;margin:6px 0"><thead><tr style="background:#eee"><th style="border:1px solid #000;padding:3px;font-size:10px">${t('size')}</th><th style="border:1px solid #000;padding:3px;font-size:10px">${t('qty')}</th><th style="border:1px solid #000;padding:3px;font-size:10px">${t('location')}</th></tr></thead><tbody>${gridRows}</tbody><tfoot><tr style="font-weight:bold;background:#eee"><td style="border:1px solid #000;padding:4px;text-align:center">${t('total')}</td><td style="border:1px solid #000;padding:4px;text-align:center;font-size:18px">${totalQty}</td><td style="border:1px solid #000;padding:4px"></td></tr></tfoot></table><div style="margin-top:12px;display:flex;gap:20px;font-size:11px"><div>${t('picker')}: ___________________</div><div>${t('date')}: ___________________</div></div><script src="https://cdn.jsdelivr.net/npm/jsbarcode@3.11.5/dist/JsBarcode.all.min.js"><\/script><script>try{JsBarcode("#barcode","${ticket.ticket_id}",{width:1.5,height:35,displayValue:false,margin:0})}catch(e){}setTimeout(function(){window.print()},500);<\/script></body></html>`);
    pw.document.close();
  };

  const pendingTicketsRaw = tickets.filter(t => t.status !== 'confirmed');
  const pendingTickets = activeBoardFilter === 'ALL' 
    ? pendingTicketsRaw 
    : pendingTicketsRaw.filter(t => (t.board_category || 'UNSET') === activeBoardFilter);
  const completedTickets = tickets.filter(t => t.status === 'confirmed' || t.picking_status === 'completed');
  const filteredCompleted = filterOp ? completedTickets.filter(t => t.assigned_to_name === filterOp) : completedTickets;

  // New ticket card renderer (Premium Kanban style)
  const renderTicket = (ticket, showEdit = true) => {
    const sizes = ticket.sizes || {};
    const sizeLocs = ticket.size_locations || {};
    const hasSizes = Object.values(sizes).some(v => v > 0);
    const pickedSizes = ticket.picked_sizes || {};
    const totalReq = Object.values(sizes).reduce((s, v) => s + (parseInt(v) || 0), 0);
    const totalPkd = Object.values(pickedSizes).reduce((s, v) => s + (parseInt(v) || 0), 0);
    const pct = totalReq > 0 ? Math.round((totalPkd / totalReq) * 100) : 0;
    
    const statusColors = {
      'pending': 'bg-blue-500/10 text-blue-400 border-blue-500/20',
      'in_progress': 'bg-yellow-500/10 text-yellow-400 border-yellow-500/20',
      'completed': 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20',
      'confirmed': 'bg-purple-500/10 text-purple-400 border-purple-500/20'
    };

    const currentStatus = ticket.picking_status === 'completed' ? 'completed' : ticket.picking_status || 'pending';

    return (
      <div key={ticket.ticket_id} className={`group border border-border/40 rounded-xl transition-all relative shadow-sm flex flex-col md:flex-row md:items-center justify-between p-3 gap-4 ${ticket.is_virtual ? 'bg-secondary/20 border-dashed hover:bg-secondary/30' : 'bg-card/40 hover:bg-card'}`} data-testid={`pick-${ticket.ticket_id}`}>
        {/* Left Status Bar */}
        <div className={`absolute left-0 top-0 bottom-0 w-1 ${ticket.is_virtual ? 'bg-slate-400 opacity-30' : (currentStatus === 'completed' ? 'bg-emerald-500' : currentStatus === 'in_progress' ? 'bg-yellow-500' : 'bg-blue-500')}`} />
        
        {/* Main Info */}
        <div className="flex-1 min-w-0 pl-2">
          <div className="flex items-center gap-2 mb-1">
            <span className="font-mono font-black text-primary text-sm uppercase tracking-tighter truncate max-w-[120px]" title={ticket.ticket_id}>
              {ticket.ticket_id.split('_')[1] || ticket.ticket_id}
            </span>
            <span className="text-[10px] font-black uppercase bg-secondary/80 px-2 py-0.5 rounded text-muted-foreground tracking-widest min-w-[50px] text-center">
              #{ticket.order_number}
            </span>
            {ticket.is_virtual && (
              <span className="text-[9px] font-black uppercase bg-primary text-black px-1.5 py-0.5 rounded shadow-sm flex items-center gap-1">
                <Plus className="w-2 h-2" /> {t('wms_new_pick') || 'NEW'}
              </span>
            )}
            {!hasSizes && !ticket.is_virtual && (
              <span className="text-[10px] font-black uppercase bg-amber-500/20 px-2 py-0.5 rounded text-amber-400 tracking-widest border border-amber-500/20 animate-pulse">
                {t('draft')}
              </span>
            )}
            <select
              value={ticket.blank_status || ''}
              onChange={(e) => handleQuickStatus(ticket.ticket_id, e.target.value)}
              className={`bg-primary/10 text-primary px-1.5 py-0.5 rounded text-[9px] font-black uppercase tracking-widest leading-none border-none focus:ring-0 cursor-pointer text-center text-ellipsis max-w-[120px] shadow-sm hover:shadow active:scale-95 transition-all ${!ticket.blank_status ? 'opacity-50' : ''}`}
              onClick={e => e.stopPropagation()}
            >
              <option value="">- {t('status')} -</option>
              {Array.from(new Set(['PENDIENTE', 'PARTIAL', 'ACTIVO', 'PICK TICKET READY', 'CONTADO/PICKED', 'COMPLETO', 'ORDENADO', ticket.blank_status])).filter(Boolean).map(st => (
                <option key={st} value={st}>{st}</option>
              ))}
            </select>
          </div>
          <div className="text-xs font-bold text-foreground flex items-center gap-2 truncate">
            {ticket.customer || t('no_client')}
            <span className="w-1 h-1 rounded-full bg-muted-foreground/30 flex-shrink-0" />
            <span className="text-muted-foreground uppercase text-[10px] tracking-widest truncate">{ticket.style}</span>
            <span className="w-1 h-1 rounded-full bg-muted-foreground/30 flex-shrink-0" />
            <span className="text-[10px] text-muted-foreground whitespace-nowrap">{new Date(ticket.created_at).toLocaleDateString()}</span>
          </div>
          {(() => {
            const renderJobLink = (jt, label) => {
              if (!jt) return null;
              const isObj = typeof jt === 'object';
              const text = isObj ? (jt.desc || jt.url || "") : jt;
              const url = isObj ? jt.url : null;

              if (url) {
                return (
                  <a 
                    href={url} 
                    target="_blank" 
                    rel="noopener noreferrer"
                    className="flex items-center gap-1 text-[9px] bg-primary/5 text-primary px-1.5 py-0.5 rounded border border-primary/20 hover:bg-primary/10 transition-colors group/link truncate max-w-[120px]"
                    title={text}
                    onClick={e => e.stopPropagation()}
                  >
                    <span className="font-bold opacity-60">{label}:</span>
                    <span className="truncate">{text}</span>
                    <ExternalLink className="w-2.5 h-2.5 opacity-0 group-hover/link:opacity-100 transition-opacity" />
                  </a>
                );
              }
              return (
                <span className="text-[9px] bg-slate-500/10 text-slate-400 px-1.5 py-0.5 rounded border border-slate-500/20 truncate max-w-[100px]" title={text}>
                  {label}: {text}
                </span>
              );
            };

            return (ticket.job_title_a || ticket.job_title_b) && (
              <div className="flex gap-2 mt-1">
                {renderJobLink(ticket.job_title_a, 'A')}
                {renderJobLink(ticket.job_title_b, 'B')}
              </div>
            );
          })()}
        </div>

        {/* Progress */}
        <div className="hidden md:block w-32 shrink-0">
          <div className="flex items-center justify-between text-[9px] font-black uppercase tracking-widest text-muted-foreground mb-1">
            <span>{currentStatus.replace('_', ' ')}</span>
            <span>{pct}%</span>
          </div>
          <div className="h-1.5 bg-black/20 rounded-full overflow-hidden shadow-inner">
            <div className={`h-full rounded-full transition-all duration-1000 ${pct === 100 ? 'bg-emerald-500' : 'bg-primary'}`} style={{ width: `${pct}%` }} />
          </div>
          <div className="text-[10px] font-bold text-center mt-1">
            {totalPkd} / {totalReq} {t('units')}
          </div>
        </div>

        {/* Assignee */}
        <div className="hidden md:flex w-32 shrink-0 text-[10px] font-black bg-secondary/50 rounded-lg justify-center items-center overflow-hidden border border-transparent hover:border-border/30 transition-all group/assign shadow-inner hover:shadow-md">
          <Package className="w-3 h-3 text-indigo-400 ml-2 flex-shrink-0" />
          <select 
            value={ticket.assigned_to || ''} 
            onChange={(e) => handleQuickAssign(ticket.ticket_id, e.target.value)}
            className="w-full bg-transparent border-none text-[10px] font-black uppercase text-indigo-400 focus:ring-0 p-1.5 cursor-pointer truncate"
            onClick={e => e.stopPropagation()}
          >
            <option value="" className="text-muted-foreground">{t('unassigned')}</option>
            {operators.map(op => (
              <option key={op.email} value={op.user_id || op.email}>
                {op.name ? op.name.split(' ')[0] : op.email.split('@')[0]}
              </option>
            ))}
          </select>
        </div>

        {/* Actions */}
        <div className="flex items-center justify-end gap-1 shrink-0 md:border-l md:border-border/20 md:pl-3">
          {!ticket.is_virtual && (
            <>
              <button 
                onClick={() => setIncidentTicket(ticket)} 
                className="p-1.5 text-red-400 hover:bg-red-500/10 rounded-xl transition-all" 
                title={t('wms_report_incident') || 'Reportar Problema'}
              >
                <AlertTriangle className="w-4 h-4" />
              </button>
              <button onClick={() => handlePrint(ticket)} className="p-1.5 text-muted-foreground hover:text-primary hover:bg-primary/10 rounded-lg transition-all" title={t('print')}><Printer className="w-4 h-4" /></button>
            </>
          )}
          {showEdit && currentStatus !== 'completed' && (
            <button 
              onClick={() => openEdit(ticket)} 
              className={`p-1.5 rounded-lg transition-all flex items-center gap-1 ${ticket.is_virtual ? 'bg-primary text-black px-3 font-black text-[10px] uppercase hover:scale-105' : 'text-muted-foreground hover:text-primary hover:bg-primary/10'}`} 
              title={ticket.is_virtual ? "Crear Ticket" : "Editar / Ver Tallas"}
            >
              {ticket.is_virtual ? (
                <>{t('wms_new_pick') || 'Iniciar'}</>
              ) : (
                <Edit3 className="w-4 h-4" />
              )}
            </button>
          )}
          {ticket.status === 'pending' && !ticket.is_virtual && (
            <button onClick={() => handleConfirm(ticket)} className="px-2 py-1 bg-emerald-500 text-black text-[9px] font-black uppercase rounded hover:bg-emerald-400 transition-all shadow-sm ml-1">OK</button>
          )}
        </div>
      </div>
    );
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 bg-secondary/30 p-1 rounded-2xl border border-border/20">
          {[
            { id: 'pending', label: t('wms_picking_pending'), icon: ClipboardList, count: pendingTickets.length },
            { id: 'completed', label: t('wms_picking_completed'), icon: CheckCircle, count: completedTickets.length },
            { id: 'dashboard', label: t('wms_picking_kpis'), icon: BarChart3 },
          ].map(tab => {
            const Icon = tab.icon;
            const active = activeTab === tab.id;
            return (
              <button 
                key={tab.id} 
                onClick={() => setActiveTab(tab.id)}
                className={`flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-black uppercase tracking-wider transition-all
                  ${active ? 'bg-primary text-black shadow-lg shadow-primary/20' : 'text-muted-foreground hover:bg-secondary/60 hover:text-foreground'}`}
              >
                <Icon className="w-4 h-4" />
                {tab.label}
                {tab.count !== undefined && (
                  <span className={`px-1.5 py-0.5 rounded-md text-[9px] ${active ? 'bg-black/10' : 'bg-secondary'}`}>
                    {tab.count}
                  </span>
                )}
              </button>
            );
          })}
        </div>
        <div className="flex items-center gap-2">
          {activeTab === 'pending' && (
            <div className="flex items-center bg-secondary/30 rounded-xl p-1 border border-border/20 mr-2">
              {[t('all'), 'SCHEDULING', 'BLANKS'].map(board => {
                const val = (board === 'TODOS' || board === 'ALL' || board === t('all')) ? 'ALL' : board;
                const isActive = activeBoardFilter === val;
                return (
                  <button 
                    key={board}
                    onClick={() => setActiveBoardFilter(val)}
                    className={`px-3 py-1.5 text-[10px] font-black uppercase tracking-wider rounded-lg transition-all ${isActive ? 'bg-primary text-black shadow' : 'text-muted-foreground hover:bg-secondary/60 hover:text-foreground'}`}
                  >
                    {board}
                  </button>
                );
              })}
            </div>
          )}
          <button 
            onClick={() => { resetForm(); setShowForm(true); }} 
            className="px-5 py-2.5 bg-primary text-black rounded-xl font-bold uppercase tracking-wider text-xs transition-all hover:scale-105 shadow-[0_0_20px_rgba(255,193,7,0.3)] flex items-center gap-2"
            data-testid="new-pick-btn"
          >
            <Plus className="w-5 h-5" /> {t('wms_new_pick')}
          </button>
        </div>
      </div>
      {/* Form (create/edit) */}
      {showForm && (
        <div className="border border-border rounded-lg p-4 bg-secondary/30 space-y-3" data-testid="pick-form">
          <div className="flex items-center justify-between mb-1">
            <span className="text-sm font-bold text-foreground">{editingTicket ? `${t('wms_editing')} ${editingTicket.ticket_id}` : t('wms_new_pick')}</span>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
            <div>
              <label className="text-xs uppercase tracking-wider text-muted-foreground font-bold block mb-1">PO / {t('order')}</label>
              {editingTicket ? (
                <input value={form.order_number} readOnly className="w-full px-3 py-2 bg-secondary/50 border border-border rounded text-sm text-foreground font-mono cursor-not-allowed" data-testid="pick-order-select" />
              ) : (
                <SearchableSelect
                  options={orders.map(o => `${o.order_number}${o.client ? ` - ${o.client}` : ''}`)}
                  value={form.order_number}
                  onChange={(val) => { const num = val.split(' - ')[0].trim(); handleOrderLookup(num); }}
                  placeholder={t('wms_search_order')}
                  allowCreate={true}
                  testId="pick-order-select"
                />
              )}
            </div>
            <div>
              <label className="text-xs uppercase tracking-wider text-muted-foreground font-bold block mb-1">Customer</label>
              <SearchableSelect options={options.customers || []} value={form.customer} onChange={handleCustomerChange} placeholder={t('wms_search_customer')} testId="pick-customer" />
            </div>
            <div>
              <label className="text-xs uppercase tracking-wider text-muted-foreground font-bold block mb-1">{t('wms_assign_op')}</label>
              <select value={form.assigned_to} onChange={e => {
                const op = operators.find(o => o.user_id === e.target.value || o.email === e.target.value);
                setForm(p => ({ ...p, assigned_to: e.target.value, assigned_to_name: op ? (op.name || op.email) : '' }));
              }} className="w-full px-3 py-2 bg-background border border-border rounded text-sm text-foreground" data-testid="pick-operator-select">
                <option value="">{t('unassigned')}</option>
                {operators.map(op => <option key={op.user_id || op.email} value={op.user_id || op.email}>{op.name || op.email}</option>)}
              </select>
            </div>
          </div>
          <div className="grid grid-cols-3 gap-3">
            <div>
              <label className="text-xs uppercase tracking-wider text-muted-foreground font-bold block mb-1">{t('wms_qty_auto')}</label>
              <input type="number" value={form.quantity} onChange={e => setForm(p => ({ ...p, quantity: parseInt(e.target.value) || 0 }))} className="w-full px-3 py-2 bg-background border border-border rounded text-sm text-foreground" data-testid="pick-qty" />
            </div>
          </div>
          <div className="grid grid-cols-3 gap-3">
            <div>
              <label className="text-xs uppercase tracking-wider text-muted-foreground font-bold block mb-1">Manufacturer</label>
              <SearchableSelect options={options.manufacturers || []} value={form.manufacturer} onChange={handleManufacturerChange} placeholder={t('wms_search_manufacturer')} testId="pick-manufacturer" />
              {!form.customer && <div className="text-xs text-muted-foreground mt-0.5">{t('select_order_first')}</div>}
            </div>
            <div>
              <label className="text-xs uppercase tracking-wider text-muted-foreground font-bold block mb-1">Style</label>
              <SearchableSelect options={options.styles || []} value={form.style} onChange={handleStyleChange} placeholder={t('wms_search_style')} testId="pick-style" />
            </div>
            <div>
              <label className="text-xs uppercase tracking-wider text-muted-foreground font-bold block mb-1">Color</label>
              <SearchableSelect options={options.colors || []} value={form.color} onChange={handleColorChange} placeholder={t('wms_search_color')} testId="pick-color" />
              {form.style && !form.color && <div className="text-xs text-muted-foreground mt-0.5">{t('select_color_to_see_locs')}</div>}
            </div>
          </div>
          <div className="text-xs uppercase tracking-wider text-muted-foreground font-bold">{t('wms_size_locs')}</div>
          <div className="overflow-auto">
            <table className="w-full text-sm">
              <thead><tr className="text-xs uppercase text-muted-foreground"><th className="p-1 text-center w-16">{t('size')}</th><th className="p-1 text-center w-20">{t('qty')}</th><th className="p-1 text-left">{t('wms_loc_qty')}</th><th className="p-1 text-right w-20">{t('available')}</th></tr></thead>
              <tbody>
                {SIZES_ORDER.map(sz => (
                  <tr key={sz} className="border-b border-border/50">
                    <td className="p-1 text-center font-bold">{sz}</td>
                    <td className="p-1"><input type="number" min="0" value={form.sizes[sz]} onChange={e => updateSize(sz, e.target.value)} placeholder="0" className="w-full px-2 py-1.5 bg-background border border-border rounded text-center text-sm font-mono text-foreground" data-testid={`pick-size-${sz}`} /></td>
                    <td className="p-1">
                      {(sizeLocations[sz]?.locations || []).length > 0 ? (
                        <div className="flex flex-wrap gap-1">{(sizeLocations[sz]?.locations || []).slice(0, 4).map((l, i) => <span key={i} className="text-xs font-mono bg-primary/15 text-primary px-1.5 py-0.5 rounded" title={`${l.available} units`}>{l.location} ({l.available})</span>)}{(sizeLocations[sz]?.locations || []).length > 4 && <span className="text-xs text-muted-foreground">+{(sizeLocations[sz]?.locations || []).length - 4}</span>}</div>
                      ) : (<span className="text-xs text-muted-foreground">{form.style ? t('wms_no_loc') : '-'}</span>)}
                    </td>
                    <td className="p-1 text-right font-mono text-xs text-green-400">{getTotalAvail(sz) > 0 ? getTotalAvail(sz).toLocaleString() : '-'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="text-right font-bold text-sm">{t('wms_total_pick', { count: totalPick })}</div>
          <div className="flex gap-2">
            <button onClick={handleSubmit} disabled={loading} className="px-4 py-2 bg-primary text-primary-foreground rounded text-sm flex items-center gap-1.5 disabled:opacity-50" data-testid="pick-submit">
              {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <ClipboardCheck className="w-4 h-4" />} {editingTicket ? t('save_view') : t('wms_new_pick')}
            </button>
            <button onClick={resetForm} className="px-4 py-2 bg-secondary text-foreground rounded text-sm">{t('cancel')}</button>
          </div>
        </div>
      )}
      {/* Tab Content */}
      {activeTab === 'pending' && (
        <div className="space-y-8" data-testid="pick-pending-list">
          {Object.entries(
            pendingTickets.reduce((acc, ticket) => {
              const cat = ticket.board_category || 'UNSET';
              if (!acc[cat]) acc[cat] = [];
              acc[cat].push(ticket);
              return acc;
            }, {})
          ).map(([category, tickets]) => (
            <div key={category} className="space-y-4">
              <div className="flex items-center gap-3">
                <div className="h-[1px] flex-1 bg-border/40" />
                <span className="text-[10px] font-black uppercase tracking-[0.2em] text-muted-foreground bg-secondary/50 px-3 py-1 rounded-full border border-border/20 shadow-sm">
                  {category}
                </span>
                <div className="h-[1px] flex-1 bg-border/40" />
              </div>
              <div className="flex flex-col gap-2">
                {tickets.map(ticket => renderTicket(ticket))}
              </div>
            </div>
          ))}
          {pendingTickets.length === 0 && (
            <div className="flex flex-col items-center justify-center py-20 bg-secondary/10 rounded-3xl border border-dashed border-border/40 text-muted-foreground opacity-50">
              <ClipboardList className="w-16 h-16 mb-4 stroke-[1px]" />
              <p className="font-bold uppercase tracking-widest text-sm italic">{t('wms_no_pending_picks')}</p>
              <p className="text-xs mt-1">{t('wms_all_picked_hint')}</p>
            </div>
          )}
        </div>
      )}
      {activeTab === 'completed' && (
        <div className="space-y-6">
          <div className="flex items-center gap-3 bg-card p-4 rounded-2xl border border-border/20 shadow-lg">
            <div className="p-2 bg-indigo-500/10 rounded-xl">
              <Plus className="w-5 h-5 text-indigo-400" />
            </div>
            <div className="flex-1 min-w-0">
              <label className="text-[10px] font-black uppercase tracking-widest text-muted-foreground mb-1 block">{t('wms_filter_op')}</label>
              <select value={filterOp} onChange={e => setFilterOp(e.target.value)} className="w-full bg-transparent border-none text-sm font-bold text-foreground focus:ring-0 p-0" data-testid="pick-filter-operator">
                <option value="">{t('wms_all_ops')}</option>
                {operators.map(op => <option key={op.email} value={op.name || op.email}>{op.name || op.email}</option>)}
              </select>
            </div>
            <div className="px-4 py-2 bg-secondary/50 rounded-xl text-xs font-black text-muted-foreground uppercase tracking-widest">
              {filteredCompleted.length} {t('completed')}
            </div>
          </div>
          <div className="flex flex-col gap-2" data-testid="pick-completed-list">
            {filteredCompleted.map(ticket => renderTicket(ticket, false))}
          </div>
          {filteredCompleted.length === 0 && (
            <div className="flex flex-col items-center justify-center py-20 bg-secondary/10 rounded-3xl border border-dashed border-border/40 text-muted-foreground opacity-50">
              <CheckCircle className="w-16 h-16 mb-4 stroke-[1px]" />
              <p className="font-bold uppercase tracking-widest text-sm italic">{t('wms_no_completed_tickets')}</p>
            </div>
          )}
        </div>
      )}
      {activeTab === 'dashboard' && stats && (
        <div className="space-y-8" data-testid="pick-dashboard">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            {[
              { key: 'wms_kpi_total_tickets', val: stats.total_tickets, color: 'text-indigo-400', bg: 'bg-indigo-500/10', icon: ClipboardList },
              { key: 'wms_kpi_completed', val: stats.completed, color: 'text-emerald-400', bg: 'bg-emerald-500/10', icon: CheckCircle },
              { key: 'wms_kpi_in_progress', val: stats.in_progress, color: 'text-yellow-400', bg: 'bg-yellow-500/10', icon: Loader2 },
              { key: 'wms_kpi_pending', val: stats.pending, color: 'text-blue-400', bg: 'bg-blue-500/10', icon: History },
            ].map(s => {
              const Icon = s.icon;
              return (
                <div key={s.label} className="bg-card/60 backdrop-blur-sm border border-border/40 rounded-3xl p-6 shadow-xl relative overflow-hidden group">
                  <div className={`absolute top-0 right-0 p-4 opacity-5 group-hover:opacity-10 transition-opacity`}>
                    <Icon className="w-16 h-16" />
                  </div>
                  <div className={`w-10 h-10 rounded-2xl ${s.bg} flex items-center justify-center mb-4`}>
                    <Icon className={`w-5 h-5 ${s.color} ${s.key.includes('progress') ? 'animate-spin-slow' : ''}`} />
                  </div>
                  <div className={`text-3xl font-black tabular-nums tracking-tighter ${s.color}`}>{s.val}</div>
                  <div className="text-[10px] font-black uppercase tracking-widest text-muted-foreground/60 mt-1">{t(s.key)}</div>
                </div>
              );
            })}
          </div>
          <h3 className="text-sm font-bold text-foreground uppercase">{t('wms_prod_per_op')}</h3>
          {stats.operators.length > 0 ? (
            <div className="overflow-auto">
              <table className="w-full text-sm">
                <thead className="bg-secondary">
                  <tr>
                    <th className="p-2 text-left text-xs uppercase text-muted-foreground">{t('name')}</th>
                    <th className="p-2 text-center text-xs uppercase text-muted-foreground">{t('wms_op_completed')}</th>
                    <th className="p-2 text-center text-xs uppercase text-muted-foreground">{t('wms_op_progress')}</th>
                    <th className="p-2 text-center text-xs uppercase text-muted-foreground">{t('wms_op_assigned')}</th>
                    <th className="p-2 text-center text-xs uppercase text-muted-foreground">{t('wms_op_total_pcs')}</th>
                    <th className="p-2 text-center text-xs uppercase text-muted-foreground">{t('wms_op_picked_pcs')}</th>
                    <th className="p-2 text-center text-xs uppercase text-muted-foreground">{t('wms_op_efficiency')}</th>
                  </tr>
                </thead>
                <tbody>
                  {stats.operators.map(op => {
                    const eff = op.total_pieces > 0 ? Math.round((op.picked_pieces / op.total_pieces) * 100) : 0;
                    return (
                      <tr key={op.name} className="border-b border-border hover:bg-secondary/50">
                        <td className="p-2 font-bold">{op.name}</td>
                        <td className="p-2 text-center text-green-400 font-bold">{op.completed}</td>
                        <td className="p-2 text-center text-yellow-400">{op.in_progress}</td>
                        <td className="p-2 text-center text-blue-400">{op.assigned}</td>
                        <td className="p-2 text-center font-mono">{op.total_pieces.toLocaleString()}</td>
                        <td className="p-2 text-center font-mono text-green-400">{op.picked_pieces.toLocaleString()}</td>
                        <td className="p-2 text-center">
                          <div className="flex items-center justify-center gap-2">
                            <div className="w-16 h-2 bg-secondary rounded-full overflow-hidden"><div className={`h-full rounded-full ${eff === 100 ? 'bg-green-500' : eff > 50 ? 'bg-yellow-500' : 'bg-red-500'}`} style={{ width: `${eff}%` }} /></div>
                            <span className="text-xs font-bold">{eff}%</span>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="text-center text-muted-foreground text-sm py-8">{t('no_operator_data')}</div>
          )}
        </div>
      )}

      {incidentTicket && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm animate-in fade-in duration-200">
          <div className="bg-card border border-border/50 rounded-2xl w-full max-w-md shadow-2xl p-6 space-y-4 animate-in zoom-in-95 duration-200">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2 text-red-500">
                <AlertTriangle className="w-5 h-5" />
                <h3 className="font-black uppercase tracking-widest text-sm">{t('wms_report_incident') || 'Reportar Problema'}</h3>
              </div>
              <button onClick={() => setIncidentTicket(null)} className="p-1 hover:bg-secondary rounded-lg transition-all"><X className="w-5 h-5" /></button>
            </div>
            
            <p className="text-xs text-muted-foreground font-bold uppercase tracking-wider">
              {t('wms_incident_ticket') || 'Ticket'}: <span className="text-foreground">{incidentTicket.ticket_id}</span>
            </p>

            <div className="space-y-4">
              <div>
                <label className="text-[10px] font-black uppercase text-muted-foreground block mb-1">SKU / ITEM</label>
                <select 
                  id="incident-sku"
                  className="w-full bg-background border border-border rounded-xl p-2.5 text-sm font-bold focus:ring-2 focus:ring-red-500/20 transition-all"
                >
                  <option value={incidentTicket.style}>{incidentTicket.style}</option>
                  {Object.keys(incidentTicket.sizes || {}).filter(sz => incidentTicket.sizes[sz] > 0).map(sz => (
                    <option key={sz} value={`${incidentTicket.style}-${sz}`}>{incidentTicket.style} ({sz})</option>
                  ))}
                </select>
              </div>
              
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="text-[10px] font-black uppercase text-muted-foreground block mb-1">{t('qty') || 'Cantidad'}</label>
                  <input id="incident-qty" type="number" defaultValue="1" min="1" className="w-full bg-background border border-border rounded-xl p-2.5 text-sm font-bold" />
                </div>
                <div>
                  <label className="text-[10px] font-black uppercase text-muted-foreground block mb-1">{t('reason') || 'Razón'}</label>
                  <select id="incident-reason" className="w-full bg-background border border-border rounded-xl p-2.5 text-sm font-bold">
                    <option value="Dañado">Dañado</option>
                    <option value="Manchado">Manchado</option>
                    <option value="Incompleto">Incompleto</option>
                    <option value="Otro">Otro</option>
                  </select>
                </div>
              </div>
            </div>

            <div className="flex gap-2 pt-2">
              <button 
                onClick={async () => {
                  const sku = document.getElementById('incident-sku').value;
                  const qty = document.getElementById('incident-qty').value;
                  const reason = document.getElementById('incident-reason').value;
                  try {
                    const res = await poster(`/pick-tickets/${incidentTicket.ticket_id}/incidents`, { sku, qty, reason });
                    if (res.ok) {
                      toast.success(t('incident_reported_success') || 'Incidencia reportada correctamente');
                      setIncidentTicket(null);
                    } else {
                      toast.error('Error al reportar');
                    }
                  } catch { toast.error('Error de conexión'); }
                }}
                className="flex-1 bg-red-500 hover:bg-red-600 text-white font-black uppercase tracking-widest text-xs py-3 rounded-xl transition-all shadow-lg shadow-red-500/20"
              >
                {t('confirm') || 'Confirmar'}
              </button>
              <button onClick={() => setIncidentTicket(null)} className="flex-1 bg-secondary hover:bg-secondary/80 text-foreground font-black uppercase tracking-widest text-xs py-3 rounded-xl transition-all">
                {t('cancel') || 'Cancelar'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};


// ==================== FINISHED GOODS MODULE ====================
const FinishedGoodsModule = () => {
  const { t } = useLang();
  const [boxes, setBoxes] = useState([]);
  const [bpoFilter, setBpoFilter] = useState('ALL'); // ALL | BPO | REGULAR
  const [editingBox, setEditingBox] = useState(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(() => { 
    const isBpo = bpoFilter === 'BPO' ? true : bpoFilter === 'REGULAR' ? false : undefined;
    const params = isBpo !== undefined ? `?is_bpo=${isBpo}` : '';
    fetcher(`/finished-goods${params}`).then(setBoxes).catch(() => {}); 
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


// ==================== MOVEMENTS MODULE ====================
const MovementsModule = () => {
  const { t } = useLang();
  const [movements, setMovements] = useState([]);
  const [typeFilter, setTypeFilter] = useState('');
  const load = useCallback(() => { fetcher(`/movements?movement_type=${typeFilter}`).then(setMovements).catch(() => {}); }, [typeFilter]);
  useEffect(() => { load(); }, [load]);
  const types = ['', 'receiving', 'putaway', 'allocation', 'deallocate', 'pick_ticket_created', 'pick_confirmed', 'production_move', 'shipment'];
  const typeLabels = {
    'receiving': t('wms_mv_receiving'),
    'putaway': t('wms_mv_putaway'),
    'allocation': t('wms_mv_allocation'),
    'deallocate': t('wms_mv_deallocate'),
    'pick_ticket_created': t('wms_mv_pick_ticket_created'),
    'pick_confirmed': t('wms_mv_pick_confirmed'),
    'production_move': t('wms_mv_production_move'),
    'shipment': t('wms_mv_shipment')
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="text-xs font-black uppercase tracking-widest text-muted-foreground bg-secondary/50 px-3 py-1 rounded-full border border-border/40 flex items-center gap-2">
          <div className="w-1.5 h-1.5 rounded-full bg-slate-400" />
          {t('wms_audit_log')}
        </div>
        <div className="flex gap-1.5 flex-wrap p-1 bg-secondary/30 rounded-xl border border-border/10">
          {types.map(type => (
            <button 
              key={type} 
              onClick={() => setTypeFilter(type)} 
              className={`px-3 py-1.5 rounded-lg text-[10px] font-black uppercase tracking-wider transition-all 
                ${typeFilter === type ? 'bg-primary text-black shadow-lg shadow-primary/20' : 'text-muted-foreground hover:bg-secondary/60 hover:text-foreground'}`}
            >
              {type ? (typeLabels[type] || type) : t('all')}
            </button>
          ))}
        </div>
      </div>
      
      <div className="space-y-3 bg-card/60 backdrop-blur-sm border border-border/20 rounded-3xl p-6 shadow-2xl max-h-[600px] overflow-auto custom-scrollbar">
        {movements.map((m, i) => {
          const typeColors = {
            'receiving': 'text-blue-400 bg-blue-500/10 border-blue-500/20',
            'putaway': 'text-purple-400 bg-purple-500/10 border-purple-500/20',
            'allocation': 'text-orange-400 bg-orange-500/10 border-orange-500/20',
            'pick_confirmed': 'text-emerald-400 bg-emerald-500/10 border-emerald-500/20',
            'shipment': 'text-rose-400 bg-rose-500/10 border-rose-500/20'
          };
          
          return (
            <div key={m.movement_id || i} className="flex items-center justify-between py-3 border-b border-border/10 last:border-0 group hover:translate-x-1 transition-transform">
              <div className="flex items-center gap-4 min-w-0">
                <div className={`w-10 h-10 rounded-xl border flex items-center justify-center flex-shrink-0 transition-colors ${typeColors[m.type] || 'bg-secondary/50 text-muted-foreground border-border/10'}`}>
                  <History className="w-5 h-5" />
                </div>
                <div className="min-w-0">
                  <div className="text-sm font-black text-foreground mb-0.5 flex items-center gap-2">
                    <span className="text-primary font-mono">{m.box_id}</span>
                    <span className="uppercase tracking-tighter text-[10px] opacity-40">{t('wms_moved_to_label')}</span>
                    <span className="text-emerald-400 font-mono italic">{m.to_loc || '-'}</span>
                  </div>
                  <div className="text-[10px] font-bold text-muted-foreground uppercase tracking-widest flex items-center gap-2">
                    {typeLabels[m.type] || m.type?.replace('_', ' ')}
                    <span className="w-1 h-1 rounded-full bg-border" />
                    {t('by_label')}: {m.user_name || m.user || t('wms_mv_system')}
                  </div>
                </div>
              </div>
              <div className="text-right flex-shrink-0">
                <div className="text-xs font-black text-foreground tabular-nums opacity-60">
                  {new Date(m.created_at).toLocaleDateString()}
                </div>
                <div className="text-[10px] font-bold text-muted-foreground opacity-40 uppercase">
                  {new Date(m.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })}
                </div>
              </div>
            </div>
          );
        })}
        {movements.length === 0 && (
          <div className="flex flex-col items-center justify-center py-20 text-muted-foreground opacity-50">
            <History className="w-16 h-16 mb-4 stroke-[1px]" />
            <p className="font-bold uppercase tracking-widest text-sm italic">{t('wms_no_movements')}</p>
          </div>
        )}
      </div>
    </div>
  );
};


// ==================== CYCLE COUNT MODULE ====================
const CycleCountModule = () => {
  const { t } = useLang();
  const [counts, setCounts] = useState([]);
  const [showForm, setShowForm] = useState(false);
  const [selectedCount, setSelectedCount] = useState(null);
  const [operators, setOperators] = useState([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [options, setOptions] = useState({ customers: [], styles: [] });
  const [form, setForm] = useState({ name: '', location_filter: '', customer_filter: '', style_filter: '', assigned_to: '', assigned_to_name: '' });

  const load = useCallback(() => { fetcher('/cycle-counts').then(setCounts).catch(() => {}); }, []);
  useEffect(() => {
    load();
    fetcher('/operators').then(setOperators).catch(() => {});
    fetcher('/inventory/options?').then(d => setOptions({ customers: d.customers || [], styles: d.styles || [] })).catch(() => {});
  }, [load]);

  const toggleNewForm = () => setShowForm(!showForm);

  const handleCreate = async () => {
    if (!form.name) { toast.error(t('wms_name_req')); return; }
    setLoading(true);
    try {
      const res = await poster('/cycle-counts', form);
      if (res.ok) {
        const data = await res.json();
        toast.success(t('wms_cc_created', { count: data.total_lines }));
        setShowForm(false);
        setForm({ name: '', location_filter: '', customer_filter: '', style_filter: '', assigned_to: '', assigned_to_name: '' });
        load();
      } else { const err = await res.json().catch(() => ({})); toast.error(err.detail || 'Error'); }
    } catch { toast.error('Error de conexion'); }
    finally { setLoading(false); }
  };

  const openCount = async (c) => {
    try {
      const data = await fetcher(`/cycle-counts/${c.count_id}`);
      setSelectedCount(data);
    } catch { toast.error(t('wms_cc_load_err')); }
  };

  const saveProgress = async (countedItems) => {
    if (!selectedCount) return;
    setSaving(true);
    try {
      const res = await putter(`/cycle-counts/${selectedCount.count_id}/count`, { counted_items: countedItems });
      if (res.ok) {
        toast.success(t('wms_cc_saved'));
        const updated = await fetcher(`/cycle-counts/${selectedCount.count_id}`);
        setSelectedCount(updated);
        load();
      } else { const err = await res.json().catch(() => ({})); toast.error(err.detail || 'Error'); }
    } catch { toast.error('Error'); }
    finally { setSaving(false); }
  };

  const approveCount = async () => {
    if (!selectedCount || !window.confirm(t('wms_cc_approve_conf'))) return;
    setSaving(true);
    try {
      const res = await putter(`/cycle-counts/${selectedCount.count_id}/approve`, {});
      if (res.ok) {
        const data = await res.json();
        toast.success(data.message || t('success'));
        setSelectedCount(null);
        load();
      } else { const err = await res.json().catch(() => ({})); toast.error(err.detail || t('error')); }
    } catch { toast.error(t('error')); }
    finally { setSaving(false); }
  };

  // Counting interface
  if (selectedCount) {
    const lines = selectedCount.lines || [];
    const grouped = {};
    lines.forEach(l => {
      const key = l.inv_location || t('wms_no_loc').toUpperCase();
      if (!grouped[key]) grouped[key] = [];
      grouped[key].push(l);
    });
    const locations = Object.keys(grouped).sort();
    const totalLines = lines.length;
    const countedLines = lines.filter(l => l.counted).length;
    const discrepancies = lines.filter(l => l.counted && l.discrepancy !== 0).length;
    const pct = totalLines > 0 ? Math.round((countedLines / totalLines) * 100) : 0;

    const handleInputChange = (lineId, val) => {
      setSelectedCount(prev => ({
        ...prev,
        lines: prev.lines.map(l => l.line_id === lineId ? { ...l, counted_qty: val === '' ? null : parseInt(val) || 0 } : l)
      }));
    };

    const handleSaveAll = () => {
      const counted = {};
      lines.forEach(l => {
        if (l.counted_qty !== null && l.counted_qty !== undefined) {
          counted[l.line_id] = l.counted_qty;
        }
      });
      saveProgress(counted);
    };

    return (
      <div className="space-y-4" data-testid="cycle-count-detail">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <button onClick={() => setSelectedCount(null)} className="p-1.5 text-muted-foreground hover:text-foreground rounded hover:bg-secondary"><ArrowLeft className="w-4 h-4" /></button>
            <div>
              <h2 className="text-lg font-bold text-foreground">{selectedCount.name}</h2>
              <span className="text-xs text-muted-foreground">{selectedCount.count_id}</span>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <span className={`text-xs px-2 py-1 rounded-full font-bold ${selectedCount.status === 'approved' ? 'bg-green-500/15 text-green-400' : selectedCount.status === 'completed' ? 'bg-blue-500/15 text-blue-400' : 'bg-yellow-500/15 text-yellow-400'}`}>
              {selectedCount.status === 'approved' ? t('wms_status_approved') : selectedCount.status === 'completed' ? t('wms_status_completed') : t('wms_status_in_progress')}
            </span>
            {selectedCount.assigned_to_name && <span className="text-xs bg-purple-500/15 text-purple-400 px-2 py-1 rounded-full">{selectedCount.assigned_to_name}</span>}
          </div>
        </div>
        {/* Progress */}
        <div className="bg-card border border-border rounded-lg p-4">
          <div className="flex items-center justify-between mb-2">
            <span className="text-sm font-bold">{t('wms_cc_progress_label')} {countedLines}/{totalLines} {t('wms_cc_items')}</span>
            <div className="flex items-center gap-3">
              {discrepancies > 0 && <span className="text-xs bg-red-500/15 text-red-400 px-2 py-1 rounded-full font-bold">{discrepancies} {t('wms_cc_discrepancies')}</span>}
              <span className="text-sm font-bold">{pct}%</span>
            </div>
          </div>
          <div className="w-full h-2.5 bg-secondary rounded-full overflow-hidden">
            <div className={`h-full rounded-full transition-all ${pct === 100 ? 'bg-green-500' : pct > 0 ? 'bg-yellow-500' : 'bg-gray-500'}`} style={{ width: `${pct}%` }} />
          </div>
        </div>
        {/* Lines by location */}
        <div className="space-y-3 max-h-[500px] overflow-y-auto">
          {locations.map(loc => (
            <div key={loc} className="border border-border rounded-lg overflow-hidden">
              <div className="bg-secondary px-3 py-2 text-sm font-bold flex items-center gap-2">
                <MapPin className="w-4 h-4 text-primary" /> {loc}
                <span className="text-xs text-muted-foreground ml-auto">{grouped[loc].filter(l => l.counted).length}/{grouped[loc].length}</span>
              </div>
              <div className="divide-y divide-border">
                {grouped[loc].map(line => (
                  <div key={line.line_id} className={`flex items-center gap-3 px-3 py-2 ${line.counted && line.discrepancy !== 0 ? 'bg-red-500/5' : line.counted ? 'bg-green-500/5' : ''}`}>
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-mono font-bold">{line.style}</div>
                      <div className="text-xs text-muted-foreground">{line.color} / {line.size}</div>
                    </div>
                    <div className="text-center w-20">
                      <div className="text-xs text-muted-foreground">{t('wms_cc_system')}</div>
                      <div className="text-sm font-bold">{line.system_qty}</div>
                    </div>
                    <div className="w-24">
                      <div className="text-xs text-muted-foreground">{t('wms_cc_count')}</div>
                      <input type="number" min="0" value={line.counted_qty ?? ''} onChange={e => handleInputChange(line.line_id, e.target.value)}
                        className="w-full px-2 py-1.5 bg-background border border-border rounded text-center text-sm font-mono font-bold"
                        disabled={selectedCount.status === 'approved'}
                        data-testid={`cc-input-${line.line_id}`} />
                    </div>
                    <div className="w-16 text-center">
                      {line.counted && (
                        <span className={`text-sm font-bold ${line.discrepancy === 0 ? 'text-green-400' : line.discrepancy > 0 ? 'text-blue-400' : 'text-red-400'}`}>
                          {line.discrepancy > 0 ? '+' : ''}{line.discrepancy}
                        </span>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
        {/* Actions */}
        {selectedCount.status !== 'approved' && (
          <div className="flex gap-3 sticky bottom-0 bg-background pt-3 border-t border-border">
            <button onClick={handleSaveAll} disabled={saving} className="flex-1 px-4 py-2.5 bg-primary text-primary-foreground rounded-lg text-sm font-bold flex items-center justify-center gap-2 disabled:opacity-50" data-testid="cc-save">
              {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />} {t('wms_cc_save')}
            </button>
            {selectedCount.status === 'completed' && (
              <button onClick={approveCount} disabled={saving} className="flex-1 px-4 py-2.5 bg-green-600 text-white rounded-lg text-sm font-bold flex items-center justify-center gap-2 disabled:opacity-50" data-testid="cc-approve">
                {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle className="w-4 h-4" />} {t('wms_cc_approve')}
              </button>
            )}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="text-xs font-black uppercase tracking-widest text-muted-foreground bg-secondary/50 px-3 py-1 rounded-full border border-border/40 flex items-center gap-2">
          <div className="w-1.5 h-1.5 rounded-full bg-purple-500 animate-pulse" />
          {t('wms_cycle_count')}
        </div>
        <button 
          onClick={() => setShowForm(!showForm)} 
          className="px-5 py-2.5 bg-primary text-black rounded-xl font-bold uppercase tracking-wider text-xs transition-all hover:scale-105 shadow-[0_0_20px_rgba(255,193,7,0.3)] flex items-center gap-2"
          data-testid="new-cc-btn"
        >
          <Plus className="w-5 h-5" /> {t('wms_new_cc')}
        </button>
      </div>
      {showForm && (
        <div className="border border-border rounded-lg p-4 bg-secondary/30 space-y-3" data-testid="cc-form">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs uppercase tracking-wider text-muted-foreground font-bold block mb-1">{t('wms_cc_name')}</label>
              <input placeholder={t('wms_cc_name_placeholder')} value={form.name} onChange={e => setForm(p => ({ ...p, name: e.target.value }))} className="w-full px-3 py-2 bg-background border border-border rounded text-sm text-foreground" data-testid="cc-name" />
            </div>
            <div>
              <label className="text-xs uppercase tracking-wider text-muted-foreground font-bold block mb-1">{t('wms_assign_op')}</label>
              <select value={form.assigned_to} onChange={e => { const op = operators.find(o => (o.user_id || o.email) === e.target.value); setForm(p => ({ ...p, assigned_to: e.target.value, assigned_to_name: op ? (op.name || op.email) : '' })); }} className="w-full px-3 py-2 bg-background border border-border rounded text-sm text-foreground" data-testid="cc-assign">
                <option value="">{t('unassigned')}</option>
                {operators.map(op => <option key={op.user_id || op.email} value={op.user_id || op.email}>{op.name || op.email}</option>)}
              </select>
            </div>
          </div>
          <div className="text-xs uppercase tracking-wider text-muted-foreground font-bold">{t('wms_cc_filters')}</div>
          <div className="grid grid-cols-3 gap-3">
            <div>
              <label className="text-xs text-muted-foreground mb-1 block">{t('wms_cc_loc_filter')}</label>
              <input placeholder="Ej: RP10" value={form.location_filter} onChange={e => setForm(p => ({ ...p, location_filter: e.target.value }))} className="w-full px-3 py-2 bg-background border border-border rounded text-sm text-foreground font-mono" data-testid="cc-loc" />
            </div>
            <div>
              <label className="text-xs text-muted-foreground mb-1 block">{t('client')}</label>
              <SearchableSelect options={options.customers} value={form.customer_filter} onChange={val => setForm(p => ({ ...p, customer_filter: val }))} placeholder={t('all')} testId="cc-customer" />
            </div>
            <div>
              <label className="text-xs text-muted-foreground mb-1 block">{t('style')}</label>
              <SearchableSelect options={options.styles} value={form.style_filter} onChange={val => setForm(p => ({ ...p, style_filter: val }))} placeholder={t('all')} testId="cc-style" />
            </div>
          </div>
          <div className="flex gap-2">
            <button onClick={handleCreate} disabled={loading} className="px-4 py-2 bg-primary text-primary-foreground rounded text-sm flex items-center gap-1.5 disabled:opacity-50" data-testid="cc-create">
              {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <ClipboardList className="w-4 h-4" />} {t('wms_create_cc')}
            </button>
            <button onClick={() => setShowForm(false)} className="px-4 py-2 bg-secondary text-foreground rounded text-sm">{t('cancel')}</button>
          </div>
        </div>
      )}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {counts.map(c => {
          const pct = c.total_lines > 0 ? Math.round((c.counted_lines / c.total_lines) * 100) : 0;
          const statusColors = {
            'approved': 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20',
            'completed': 'bg-blue-500/10 text-blue-400 border-blue-500/20',
            'in_progress': 'bg-yellow-500/10 text-yellow-400 border-yellow-500/20'
          };
          
          return (
            <button 
              key={c.count_id} 
              onClick={() => openCount(c)} 
              className="group text-left border border-border/40 rounded-3xl bg-card/60 backdrop-blur-sm hover:border-primary/40 hover:bg-card transition-all relative overflow-hidden shadow-xl" 
              data-testid={`cc-${c.count_id}`}
            >
              <div className={`h-1.5 w-full ${c.status === 'approved' ? 'bg-emerald-500' : c.status === 'completed' ? 'bg-blue-500' : 'bg-yellow-500'}`} />
              
              <div className="p-5">
                <div className="flex items-start justify-between mb-4">
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 rounded-xl bg-purple-500/10 border border-purple-500/20 flex items-center justify-center text-purple-400">
                      <ClipboardList className="w-5 h-5" />
                    </div>
                    <div>
                      <div className="text-[10px] font-black uppercase bg-secondary/80 px-2 py-0.5 rounded text-muted-foreground tracking-widest inline-block mb-1">
                        #{c.count_id.slice(-6)}
                      </div>
                      <h4 className="text-xs font-black uppercase tracking-tight text-foreground truncate max-w-[120px]">{c.name}</h4>
                    </div>
                  </div>
                  <div className={`px-2 py-1 rounded-lg text-[10px] font-black uppercase tracking-widest border ${statusColors[c.status] || 'bg-secondary text-muted-foreground border-border/20'}`}>
                    {c.status === 'approved' ? t('wms_status_approved') : c.status === 'completed' ? t('wms_status_completed') : t('wms_status_in_progress')}
                  </div>
                </div>

                <div className="bg-secondary/20 rounded-2xl p-4 mb-4 border border-border/10 shadow-inner">
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-[10px] font-black uppercase tracking-widest text-muted-foreground">{t('wms_cc_progress_title')}</span>
                    <span className="text-sm font-black tabular-nums">{pct}%</span>
                  </div>
                  <div className="h-2 bg-black/20 rounded-full overflow-hidden shadow-inner">
                    <div className={`h-full rounded-full transition-all duration-700 ${pct === 100 ? 'bg-emerald-500' : 'bg-primary shadow-[0_0_10px_rgba(255,193,7,0.5)]'}`} style={{ width: `${pct}%` }} />
                  </div>
                  <div className="mt-2 text-[10px] font-bold text-muted-foreground flex items-center justify-between">
                    <span>{c.counted_lines} {t('of')} {c.total_lines} {t('wms_cc_items')}</span>
                    {c.assigned_to_name && <span className="text-indigo-400 italic">@{c.assigned_to_name}</span>}
                  </div>
                </div>

                <div className="flex items-center justify-between text-[10px] font-black uppercase tracking-widest text-muted-foreground/40 border-t border-border/10 pt-3">
                  <span className="flex items-center gap-1"><History className="w-3 h-3" /> {new Date(c.created_at).toLocaleDateString()}</span>
                  {c.location_filter && <span className="flex items-center gap-1 opacity-80"><MapPin className="w-3 h-3" /> {c.location_filter}</span>}
                </div>
              </div>
            </button>
          );
        })}
      </div>
      {counts.length === 0 && (
        <div className="flex flex-col items-center justify-center py-20 bg-secondary/10 rounded-3xl border border-dashed border-border/40 text-muted-foreground opacity-50">
          <Search className="w-16 h-16 mb-4 stroke-[1px]" />
          <p className="font-bold uppercase tracking-widest text-sm italic">{t('wms_no_cc')}</p>
          <p className="text-xs mt-1">{t('wms_cc_hint')}</p>
        </div>
      )}
    </div>
  );
};

// ==================== MAIN WMS COMPONENT ====================

// Wrapper so MODULE_COMPONENTS can receive props via the ActiveComponent pattern
let _wmsInventoryDashboardProps = {};
const InventoryDashboardWrapper = () => <InventoryDashboard {..._wmsInventoryDashboardProps} />;

const MODULE_COMPONENTS = {
  dashboard: InventoryDashboardWrapper,
  receiving: ReceivingModule,
  putaway: PutawayModule,
  inventory: InventoryModule,
  picking: PickingModule,
  finished: FinishedGoodsModule,
  movements: MovementsModule,
  cycle_count: CycleCountModule,
};

export default function WMS() {
  const navigate = useNavigate();
  const { t } = useLang();
  const [activeModule, setActiveModule] = useState('receiving');
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [isDark, setIsDark] = useState(() => !document.documentElement.classList.contains('light-theme'));
  const [badges, setBadges] = useState({ putaway: 0, picking: 0, cycle_count: 0 });
  const [currentUser, setCurrentUser] = useState(null);
  const [historyOrder, setHistoryOrder] = useState(null);
  const [globalSearch, setGlobalSearch] = useState('');
  const [isSearching, setIsSearching] = useState(false);

  // Fetch current user to detect associated_customer for auto-filtering
  useEffect(() => {
    fetch(`${AUTH_API}/me`, { credentials: 'include' })
      .then(r => r.ok ? r.json() : null)
      .then(u => { if (u) setCurrentUser(u); })
      .catch(() => {});
  }, []);

  // Keep module wrapper props in sync with current user
  const associatedCustomer = currentUser?.associated_customer || '';
  _wmsInventoryDashboardProps = { customer: associatedCustomer, apiBase: API };

  const MODULES = [
    { id: 'dashboard', label: 'Dashboard', icon: LayoutDashboard, color: 'text-primary', desc: 'Visión general del inventario en tiempo real' },
    { id: 'receiving', label: t('wms_mod_receiving'), icon: Package, color: 'text-blue-400', desc: t('wms_mod_receiving_desc') },
    { id: 'putaway', label: t('wms_mod_putaway'), icon: MapPin, color: 'text-purple-400', desc: t('wms_mod_putaway_desc') },
    { id: 'inventory', label: t('wms_mod_inventory'), icon: BarChart3, color: 'text-emerald-400', desc: t('wms_mod_inventory_desc') },
    { id: 'picking', label: t('wms_mod_picking'), icon: ClipboardCheck, color: 'text-indigo-400', desc: t('wms_mod_picking_desc') },
    { id: 'finished', label: t('wms_mod_finished'), icon: CheckCircle, color: 'text-cyan-400', desc: t('wms_mod_finished_desc') },
    { id: 'movements', label: t('wms_mod_movements'), icon: History, color: 'text-slate-400', desc: t('wms_mod_movements_desc') },
    { id: 'cycle_count', label: t('wms_mod_cycle_count'), icon: ClipboardList, color: 'text-lime-400', desc: t('wms_mod_cycle_count_desc') },
  ];

  const ActiveComponent = MODULE_COMPONENTS[activeModule] || ReceivingModule;

  const loadBadges = useCallback(async () => {
    try {
      const [pendingBoxes, pendingTickets, activeCounts] = await Promise.all([
        fetcher('/boxes?status=received'),
        fetcher('/pick-tickets?status=pending'),
        fetcher('/cycle-counts?status=in_progress')
      ]);
      setBadges({
        putaway: pendingBoxes.length || 0,
        picking: pendingTickets.length || 0,
        cycle_count: activeCounts.length || 0
      });
    } catch {}
  }, []);

  useEffect(() => {
    loadBadges();
    const interval = setInterval(loadBadges, 30000); // Actualizar cada 30s
    return () => clearInterval(interval);
  }, [loadBadges]);

  // Forzar Dashboard para el rol customer y asegurar cliente filtrado
  useEffect(() => {
    if (currentUser?.role === 'customer') {
      setActiveModule('dashboard');
    }
  }, [currentUser]);

  // Handle URL parameters from Home Dashboard
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const tab = params.get('tab');
    if (tab) {
      if (tab === 'tintas') setActiveModule('inventory');
      if (tab === 'logs') setActiveModule('movements');
      window.history.replaceState({}, document.title, window.location.pathname);
    }
  }, []);

  const toggleTheme = () => {
    setIsDark(prev => {
      const next = !prev;
      localStorage.setItem('theme', next ? 'dark' : 'light');
      if (next) { document.documentElement.classList.remove('light-theme'); document.documentElement.classList.add('dark'); }
      else { document.documentElement.classList.remove('dark'); document.documentElement.classList.add('light-theme'); }
      return next;
    });
  };

  const handleLogout = async () => {
    try {
      await fetch(`${AUTH_API}/logout`, { method: 'POST', credentials: 'include' });
    } catch {}
    localStorage.removeItem("mos_user");
    window.location.href = '/';
  };

  const handleGlobalOrderSearch = async (e) => {
    e.preventDefault();
    if (!globalSearch.trim()) return;
    setIsSearching(true);
    try {
      // Usar el endpoint de reportes para buscar la orden por PO
      const res = await fetch(`${process.env.REACT_APP_BACKEND_URL}/api/reports/order-history/${globalSearch}`, { credentials: 'include' });
      if (res.ok) {
        const data = await res.json();
        setHistoryOrder(data.order);
        setGlobalSearch('');
      } else {
        toast.error('Orden / PO no encontrado');
      }
    } catch {
      toast.error('Error al buscar orden');
    } finally {
      setIsSearching(false);
    }
  };

  return (
    <div className="min-h-screen bg-background flex flex-col text-foreground">
      <div className="bg-red-600 text-white text-center py-2 font-bold text-xl animate-pulse z-50 relative">
        ⚠️ ESTAS EN LA RAMA MASTER (CAMBIOS ACTIVOS) ⚠️
      </div>
      <div className="flex-1 flex overflow-hidden">
        <Toaster position="bottom-right" theme={isDark ? 'dark' : 'light'} />
      {/* Sidebar */}
      <aside 
        className={`${sidebarCollapsed ? 'w-16' : 'w-64'} bg-card/40 backdrop-blur-xl border-r border-border/50 flex flex-col transition-all duration-300 relative z-20 shadow-2xl`}
      >
        <div className="p-4 border-b border-border/40 flex flex-col gap-4">
          <div className="flex items-center gap-3">
            <button 
              onClick={() => navigate('/dashboard')} 
              className="p-1.5 rounded-lg bg-secondary/50 hover:bg-primary/20 text-muted-foreground hover:text-primary transition-all group"
              title={t('wms_back_main')}          >
              <ArrowLeft className="w-5 h-5 group-hover:-translate-x-0.5 transition-transform" />
            </button>
            {!sidebarCollapsed && (
              <div className="flex flex-col">
                <span className="font-barlow font-black text-lg tracking-tighter flex items-center gap-1.5 italic">
                  <Warehouse className="w-5 h-5 text-primary" />
                  MOS <span className="text-primary not-italic tracking-normal ml-0.5">WMS</span>
                </span>
              </div>
            )}
            <button 
              onClick={() => setSidebarCollapsed(!sidebarCollapsed)} 
              className="ml-auto p-1.5 rounded-lg hover:bg-secondary/80 text-muted-foreground transition-all"
            >
              {sidebarCollapsed ? <ChevronRight className="w-4 h-4" /> : <X className="w-4 h-4" />}
            </button>
          </div>

          <div className={`flex ${sidebarCollapsed ? 'flex-col' : 'flex-row'} gap-2`}>
            <button 
              onClick={toggleTheme} 
              className="flex-1 flex items-center justify-center gap-2 p-2 rounded-xl bg-secondary/10 hover:bg-secondary/40 text-muted-foreground hover:text-foreground transition-all border border-border/20"
              title={isDark ? t('light_mode') : t('dark_mode')}
              data-testid="wms-theme-toggle"
            >
              {isDark ? <Sun className="w-4 h-4 text-primary animate-spin-slow" /> : <Moon className="w-4 h-4 text-indigo-400" />}
              {!sidebarCollapsed && <span className="text-[10px] font-bold uppercase tracking-wider">{isDark ? t('light_mode') : t('dark_mode')}</span>}
            </button>
            
            <button 
              onClick={handleLogout} 
              className="flex-1 flex items-center justify-center gap-2 p-2 rounded-xl bg-destructive/10 hover:bg-destructive/20 text-destructive/80 hover:text-destructive transition-all border border-destructive/20"
              title="Cerrar Sesión"
            >
              <LogOut className="w-4 h-4" />
              {!sidebarCollapsed && <span className="text-[10px] font-bold uppercase tracking-wider">Salir</span>}
            </button>
          </div>
        </div>

        <nav className="flex-1 py-4 space-y-1 overflow-y-auto px-2 custom-scrollbar">
          {MODULES.filter(m => currentUser?.role !== 'customer' || m.id === 'dashboard').map(m => {
            const Icon = m.icon;
            const isActive = activeModule === m.id;
            const badgeCount = badges[m.id] || 0;
            
            return (
              <button 
                key={m.id} 
                onClick={() => setActiveModule(m.id)}
                className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-xl transition-all relative group
                  ${isActive 
                    ? 'bg-primary/10 text-primary shadow-[0_0_15px_rgba(255,193,7,0.1)]' 
                    : 'text-muted-foreground hover:text-foreground hover:bg-secondary/40'}`}
                data-testid={`wms-nav-${m.id}`} 
                title={m.label}
              >
                <div className={`p-1.5 rounded-lg transition-all ${isActive ? 'bg-primary/20 shadow-inner' : 'group-hover:bg-secondary'}`}>
                  <Icon className={`w-5 h-5 ${isActive ? 'text-primary' : 'text-muted-foreground'}`} />
                </div>
                
                {!sidebarCollapsed && (
                  <div className="flex flex-col items-start min-w-0 flex-1">
                    <span className={`text-[13px] font-bold uppercase tracking-wide leading-none ${isActive ? 'text-primary' : ''}`}>
                      {m.label}
                    </span>
                    {isActive && (
                      <span className="text-[10px] text-muted-foreground truncate w-full mt-0.5 font-medium italic opacity-70">
                        {t('wms_viewing_now')}
                      </span>
                    )}
                  </div>
                )}

                {!sidebarCollapsed && badgeCount > 0 && (
                  <span className="bg-primary text-black text-[10px] font-black px-1.5 py-0.5 rounded-full min-w-[20px] shadow-[0_0_10px_rgba(255,193,7,0.5)]">
                    {badgeCount}
                  </span>
                )}

                {sidebarCollapsed && badgeCount > 0 && (
                  <div className="absolute top-1 right-1 w-2.5 h-2.5 bg-primary rounded-full shadow-[0_0_5px_rgba(255,193,7,0.8)] border-2 border-card" />
                )}

                {isActive && (
                  <div className="absolute left-0 top-1/2 -translate-y-1/2 w-1 h-2/3 bg-primary rounded-r-full shadow-[2px_0_10px_rgba(255,193,7,0.5)]" />
                )}
              </button>
            );
          })}
        </nav>

        <div className="p-3 border-t border-border/40 space-y-2">
          {!sidebarCollapsed && (
            <div className="bg-secondary/30 rounded-xl p-3 border border-border/20 backdrop-blur-sm">
              <div className="flex items-center gap-2 mb-2">
                <div className="w-2 h-2 rounded-full bg-green-500 animate-pulse shadow-[0_0_5px_rgba(34,197,94,0.5)]" />
                <span className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">{t('wms_status')}</span>
              </div>
              <div className="text-[11px] font-medium text-foreground opacity-80">{t('wms_terminal')}</div>
              <div className="text-[11px] font-medium text-foreground opacity-80 uppercase">{new Date().toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}</div>
            </div>
          )}
        </div>
      </aside>

      {/* Main Content */}
      <main className="flex-1 overflow-auto custom-scrollbar relative">
        {/* Module Header Overlay */}
        <div className="sticky top-0 z-10 p-6 pb-2 bg-gradient-to-b from-background via-background/95 to-transparent backdrop-blur-sm">
          {(() => {
            const m = MODULES.find(mod => mod.id === activeModule);
            const Icon = m?.icon || Package;
            return (
              <div className="flex items-start justify-between">
                <div className="flex items-center gap-4">
                  <div className={`p-3 rounded-2xl bg-card border border-border/40 shadow-xl ${m?.color || 'text-primary'}`}>
                    <Icon className="w-8 h-8" />
                  </div>
                  <div>
                    <h1 className="text-3xl font-black italic uppercase tracking-tighter leading-none mb-1">
                      {m?.label}
                    </h1>
                    <p className="text-sm text-muted-foreground font-medium flex items-center gap-2">
                      <span className="w-1.5 h-1.5 rounded-full bg-primary" />
                      {m?.desc}
                    </p>
                  </div>
                </div>
                {/* Global Search Order - Admin Only */}
                <div className="flex items-center gap-4">
                  {currentUser?.role === 'admin' && (
                    <form onSubmit={handleGlobalOrderSearch} className="relative group">
                      <Search className={`absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 transition-colors ${isSearching ? 'text-primary animate-pulse' : 'text-muted-foreground group-focus-within:text-primary'}`} />
                      <input 
                        type="text"
                        placeholder="Buscar PO / Orden..."
                        value={globalSearch}
                        onChange={(e) => setGlobalSearch(e.target.value)}
                        className="h-10 pl-10 pr-4 bg-secondary/40 border border-border/50 rounded-xl text-xs font-bold focus:outline-none focus:ring-2 focus:ring-primary/40 focus:bg-secondary/60 transition-all w-48 lg:w-64 placeholder:text-muted-foreground/50"
                      />
                      {isSearching && <Loader2 className="absolute right-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 animate-spin text-primary" />}
                    </form>
                  )}

                  <div className="hidden lg:flex flex-col items-end">
                    <div className="text-xs font-bold uppercase tracking-widest text-muted-foreground opacity-50 mb-1">{t('wms_mgmt')}</div>
                    <div className="text-lg font-mono font-black text-foreground/80 tabular-nums">
                      {new Date().toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false })}
                    </div>
                  </div>
                </div>
              </div>
            );
          })()}
        </div>

        {/* Component Content */}
        <div className="p-6 pt-2">
          <ActiveComponent />
        </div>
        <OrderHistoryModal order={historyOrder} isOpen={!!historyOrder} onClose={() => setHistoryOrder(null)} />
      </main>
      </div>
    </div>
  );
}
