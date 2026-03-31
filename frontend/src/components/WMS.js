import { useState, useEffect, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { Toaster, toast } from "sonner";
import {
  Package, MapPin, ClipboardList, BarChart3, ShoppingCart, Link2, ClipboardCheck,
  Factory, CheckCircle, Truck, History, ArrowLeft, Warehouse, Download, Plus,
  Search, Loader2, Trash2, Printer, Tag, ScanLine, Box, X, ChevronDown, ChevronRight, Edit3,
  Sun, Moon, Home
} from "lucide-react";

import SearchableSelect from "./SearchableSelect";

const API = `${process.env.REACT_APP_BACKEND_URL}/api/wms`;
const fetcher = (url) => fetch(`${API}${url}`, { credentials: 'include' }).then(r => r.ok ? r.json() : Promise.reject(r));
const poster = (url, body) => fetch(`${API}${url}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include', body: JSON.stringify(body) });
const putter = (url, body) => fetch(`${API}${url}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, credentials: 'include', body: JSON.stringify(body) });
const deleter = (url) => fetch(`${API}${url}`, { method: 'DELETE', credentials: 'include' }).then(r => r.ok ? r.json() : Promise.reject(r));

const MODULES = [
  { id: 'receiving', label: 'Receiving', icon: Package },
  { id: 'putaway', label: 'Putaway', icon: MapPin },
  { id: 'inventory', label: 'Inventory', icon: BarChart3 },
  { id: 'orders', label: 'Orders', icon: ShoppingCart },
  { id: 'picking', label: 'Picking', icon: ClipboardCheck },
  { id: 'production', label: 'Production', icon: Factory },
  { id: 'finished', label: 'Finished Goods', icon: CheckCircle },
  { id: 'shipping', label: 'Shipping', icon: Truck },
  { id: 'movements', label: 'Movements', icon: History },
  { id: 'cycle_count', label: 'Conteo Ciclico', icon: ClipboardList },
];

// ==================== RECEIVING MODULE ====================
const SIZES_ORDER = ['XS', 'S', 'M', 'L', 'XL', '2X', '3X', '4X', '5X'];

const ReceivingModule = () => {
  const [records, setRecords] = useState([]);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({
    customer: '', manufacturer: '', style: '', color: '', size: '',
    description: '', country_of_origin: '', fabric_content: '',
    dozens: '', pieces: '', units: '', lot_number: '', sku: '', inv_location: '',
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
    if (!form.style) { toast.error('Style requerido'); return; }
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
        toast.success(`Receiving creado: ${data.total_units || totalUnits} unidades`);
        setShowForm(false);
        setForm({ customer: '', manufacturer: '', style: '', color: '', size: '', description: '', country_of_origin: '', fabric_content: '', dozens: '', pieces: '', units: '', lot_number: '', sku: '', inv_location: '' });
        load();
      } else { const err = await res.json().catch(() => ({})); toast.error(err.detail || 'Error'); }
    } catch { toast.error('Error de conexion'); }
    finally { setLoading(false); }
  };

  const handlePrintLabel = (r) => {
    const pw = window.open('', '_blank');
    if (!pw) { toast.error('Permite popups para imprimir'); return; }
    const dozens = r.dozens || 0;
    const pieces = r.pieces || 0;
    const units = r.total_units || r.units || (dozens * 12 + pieces);
    pw.document.write(`<html><head><title>Receiving Label - ${r.receiving_id}</title>
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
          <td class="cell" style="width:60%"><span class="label">Customer</span><span class="value">${r.customer || ''}</span></td>
          <td class="cell" style="width:40%"><span class="label">Purchase Order</span><span class="value">${r.po || ''}</span></td>
        </tr>
        <tr class="row">
          <td class="cell" style="width:60%"><span class="label">Lot Number</span><span class="value">${r.lot_number || ''}</span></td>
          <td class="cell" style="width:40%"><span class="label">Location</span><span class="value">${r.inv_location || ''}</span></td>
        </tr>
        <tr class="row">
          <td class="cell" colspan="2"><span class="label">Manufacturer</span><span class="value">${r.manufacturer || ''}</span></td>
        </tr>
        <tr class="row">
          <td class="cell" style="width:50%"><span class="label">Style</span><span class="value" style="font-size:16px">${r.style || ''}</span></td>
          <td class="cell" style="width:50%"><span class="label">SKU #</span><span class="value" style="font-family:monospace">${r.sku || r.style || ''}</span></td>
        </tr>
        <tr class="row">
          <td class="cell" style="width:50%"><span class="label">Color</span><span class="value">${r.color || ''}</span></td>
          <td class="cell" style="width:50%"><span class="label">Size</span><span class="value" style="font-size:16px">${r.size || ''}</span></td>
        </tr>
        <tr class="row">
          <td class="cell" colspan="2"><span class="label">Description</span><span class="value">${r.description || ''}</span></td>
        </tr>
        <tr class="row">
          <td class="cell" style="width:50%"><span class="label">Country of Origin</span><span class="value">${r.country_of_origin || ''}</span></td>
          <td class="cell" style="width:50%"><span class="label">Fabric Content</span><span class="value">${r.fabric_content || ''}</span></td>
        </tr>
        <tr class="row">
          <td class="cell" style="width:33%"><span class="label">Dozens</span><span class="value" style="font-size:16px">${dozens}</span></td>
          <td class="cell" style="width:33%"><span class="label">Pieces</span><span class="value" style="font-size:16px">${pieces}</span></td>
          <td class="cell" style="width:34%"><span class="label">Units</span><span class="value" style="font-size:18px;color:#000">${units}</span></td>
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
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-bold text-foreground">Receiving</h2>
        <button onClick={() => setShowForm(!showForm)} className="px-3 py-1.5 bg-primary text-primary-foreground rounded text-sm flex items-center gap-1.5" data-testid="new-receiving-btn">
          <Plus className="w-4 h-4" /> Nuevo Receiving
        </button>
      </div>
      {showForm && (
        <div className="border border-border rounded-lg p-4 bg-secondary/30 space-y-3" data-testid="receiving-form">
          <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
            <div>
              <label className="text-xs uppercase tracking-wider text-muted-foreground font-bold block mb-1">Customer</label>
              <SearchableSelect options={options.customers || []} value={form.customer} onChange={handleCustomerChange} placeholder="Buscar customer..." testId="rcv-customer" />
            </div>
            <div>
              <label className="text-xs uppercase tracking-wider text-muted-foreground font-bold block mb-1">Manufacturer</label>
              <SearchableSelect options={options.manufacturers || []} value={form.manufacturer} onChange={handleManufacturerChange} placeholder="Buscar manufacturer..." testId="rcv-manufacturer" />
            </div>
            <div>
              <label className="text-xs uppercase tracking-wider text-muted-foreground font-bold block mb-1">Lot Number</label>
              <input placeholder="Lot Number" value={form.lot_number} onChange={e => setForm(p => ({ ...p, lot_number: e.target.value }))} className="w-full px-3 py-2 bg-background border border-border rounded text-sm text-foreground" data-testid="rcv-lot" />
            </div>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
            <div>
              <label className="text-xs uppercase tracking-wider text-muted-foreground font-bold block mb-1">Style</label>
              <SearchableSelect options={options.styles || []} value={form.style} onChange={handleStyleChange} placeholder="Buscar style..." testId="rcv-style" />
            </div>
            <div>
              <label className="text-xs uppercase tracking-wider text-muted-foreground font-bold block mb-1">Color</label>
              <SearchableSelect options={options.colors || []} value={form.color} onChange={handleColorChange} placeholder="Buscar color..." testId="rcv-color" />
            </div>
            <div>
              <label className="text-xs uppercase tracking-wider text-muted-foreground font-bold block mb-1">Size</label>
              <select value={form.size} onChange={e => setForm(p => ({ ...p, size: e.target.value }))} className="w-full px-3 py-2 bg-background border border-border rounded text-sm text-foreground" data-testid="rcv-size">
                <option value="">Size...</option>
                {SIZES_ORDER.map(s => <option key={s} value={s}>{s}</option>)}
              </select>
            </div>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
            <div>
              <label className="text-xs uppercase tracking-wider text-muted-foreground font-bold block mb-1">Description</label>
              <SearchableSelect options={fieldOptions.descriptions} value={form.description} onChange={val => setForm(p => ({ ...p, description: val }))} placeholder="Buscar descripcion..." testId="rcv-description" />
            </div>
            <div>
              <label className="text-xs uppercase tracking-wider text-muted-foreground font-bold block mb-1">Country of Origin</label>
              <SearchableSelect options={fieldOptions.countries} value={form.country_of_origin} onChange={val => setForm(p => ({ ...p, country_of_origin: val }))} placeholder="Buscar pais..." testId="rcv-country" />
            </div>
            <div>
              <label className="text-xs uppercase tracking-wider text-muted-foreground font-bold block mb-1">Fabric Content</label>
              <SearchableSelect options={fieldOptions.fabrics} value={form.fabric_content} onChange={val => setForm(p => ({ ...p, fabric_content: val }))} placeholder="Buscar tela..." testId="rcv-fabric" />
            </div>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <div>
              <label className="text-xs text-muted-foreground mb-1 block">Dozens</label>
              <input type="number" placeholder="0" value={form.dozens} onChange={e => setForm(p => ({ ...p, dozens: e.target.value, units: '' }))} className="w-full px-3 py-2 bg-background border border-border rounded text-sm text-foreground" data-testid="rcv-dozens" />
            </div>
            <div>
              <label className="text-xs text-muted-foreground mb-1 block">Pieces</label>
              <input type="number" placeholder="0" value={form.pieces} onChange={e => setForm(p => ({ ...p, pieces: e.target.value, units: '' }))} className="w-full px-3 py-2 bg-background border border-border rounded text-sm text-foreground" data-testid="rcv-pieces" />
            </div>
            <div>
              <label className="text-xs text-muted-foreground mb-1 block">Units (auto)</label>
              <input type="number" value={totalUnits} readOnly className="w-full px-3 py-2 bg-background border border-border rounded text-sm text-foreground font-bold" data-testid="rcv-units" />
            </div>
            <div>
              <label className="text-xs text-muted-foreground mb-1 block">SKU # (auto)</label>
              <input value={form.sku} readOnly className="w-full px-3 py-2 bg-secondary/50 border border-border rounded text-sm text-foreground font-mono cursor-not-allowed" data-testid="rcv-sku" />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <input placeholder="Location (ej: RP10-A26)" value={form.inv_location} onChange={e => setForm(p => ({ ...p, inv_location: e.target.value }))} className="px-3 py-2 bg-background border border-border rounded text-sm text-foreground font-mono" data-testid="rcv-location" />
          </div>
          <div className="flex items-center justify-between">
            <span className="text-sm font-bold text-foreground">Total: {totalUnits} units</span>
          </div>
          <div className="flex gap-2">
            <button onClick={handleSubmit} disabled={loading} className="px-4 py-2 bg-primary text-primary-foreground rounded text-sm flex items-center gap-1.5 disabled:opacity-50" data-testid="rcv-submit">
              {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Package className="w-4 h-4" />} Recibir
            </button>
            <button onClick={() => setShowForm(false)} className="px-4 py-2 bg-secondary text-foreground rounded text-sm">Cancelar</button>
          </div>
        </div>
      )}
      <div className="space-y-2">
        {records.map(r => (
          <div key={r.receiving_id} className="border border-border rounded-lg p-3 bg-card" data-testid={`rcv-${r.receiving_id}`}>
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <span className="font-mono font-bold text-primary text-sm">{r.style || r.receiving_id}</span>
                <span className="text-xs text-muted-foreground">{r.customer}</span>
                <span className="text-xs">{r.manufacturer} / {r.color} / {r.size || ''}</span>
              </div>
              <div className="flex items-center gap-3">
                <span className="text-xs text-muted-foreground">
                  {r.total_units || r.units || 0} units
                  <span className="ml-2">{new Date(r.created_at).toLocaleDateString()}</span>
                </span>
                <button onClick={() => handlePrintLabel(r)} className="p-1.5 text-muted-foreground hover:text-primary rounded hover:bg-secondary" title="Imprimir etiqueta" data-testid={`rcv-print-${r.receiving_id}`}>
                  <Printer className="w-4 h-4" />
                </button>
              </div>
            </div>
          </div>
        ))}
        {records.length === 0 && <div className="text-center text-muted-foreground text-sm py-8">No hay recepciones registradas</div>}
      </div>
    </div>
  );
};

// ==================== LABELING MODULE ====================
const LabelingModule = () => {
  const [boxes, setBoxes] = useState([]);
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState(new Set());

  const load = useCallback(() => { fetcher(`/boxes?po=${search}`).then(setBoxes).catch(() => {}); }, [search]);
  useEffect(() => { load(); }, [load]);

  const toggleSelect = (id) => setSelected(p => { const n = new Set(p); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const selectAll = () => setSelected(boxes.length === selected.size ? new Set() : new Set(boxes.map(b => b.box_id)));

  const printLabels = () => {
    const ids = [...selected].join(',');
    if (!ids) { toast.error('Selecciona al menos una caja'); return; }
    window.open(`${API}/labels/boxes?box_ids=${ids}`, '_blank');
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-bold text-foreground">Labeling</h2>
        <button onClick={printLabels} disabled={selected.size === 0} className="px-3 py-1.5 bg-primary text-primary-foreground rounded text-sm flex items-center gap-1.5 disabled:opacity-50" data-testid="print-labels-btn">
          <Printer className="w-4 h-4" /> Imprimir Labels ({selected.size})
        </button>
      </div>
      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
        <input placeholder="Buscar por PO..." value={search} onChange={e => setSearch(e.target.value)} className="w-full pl-9 pr-3 py-2 bg-background border border-border rounded text-sm text-foreground" data-testid="label-search" />
      </div>
      <div className="overflow-auto max-h-[500px]">
        <table className="w-full text-sm">
          <thead className="bg-secondary sticky top-0">
            <tr>
              <th className="p-2 text-left"><input type="checkbox" checked={boxes.length > 0 && selected.size === boxes.length} onChange={selectAll} className="rounded" /></th>
              <th className="p-2 text-left text-xs uppercase text-muted-foreground">Box ID</th>
              <th className="p-2 text-left text-xs uppercase text-muted-foreground">SKU</th>
              <th className="p-2 text-left text-xs uppercase text-muted-foreground">Color</th>
              <th className="p-2 text-left text-xs uppercase text-muted-foreground">Size</th>
              <th className="p-2 text-left text-xs uppercase text-muted-foreground">Units</th>
              <th className="p-2 text-left text-xs uppercase text-muted-foreground">PO</th>
              <th className="p-2 text-left text-xs uppercase text-muted-foreground">Status</th>
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
        {boxes.length === 0 && <div className="text-center text-muted-foreground text-sm py-8">No hay cajas</div>}
      </div>
    </div>
  );
};

// ==================== PUTAWAY MODULE ====================
const PutawayModule = () => {
  const [boxId, setBoxId] = useState('');
  const [location, setLocation] = useState('');
  const [locations, setLocations] = useState([]);
  const [pendingBoxes, setPendingBoxes] = useState([]);
  const [newLoc, setNewLoc] = useState({ name: '', zone: '', type: 'rack' });
  const [showNewLoc, setShowNewLoc] = useState(false);

  const loadLocations = useCallback(() => { fetcher('/locations').then(setLocations).catch(() => {}); }, []);
  const loadPending = useCallback(() => { fetcher('/boxes?status=received').then(setPendingBoxes).catch(() => {}); }, []);
  useEffect(() => { loadLocations(); loadPending(); }, [loadLocations, loadPending]);

  const handlePutaway = async () => {
    if (!boxId || !location) { toast.error('Box ID y ubicacion requeridos'); return; }
    const res = await poster('/putaway', { box_id: boxId, location });
    if (res.ok) { toast.success(`Caja ${boxId} ubicada en ${location}`); setBoxId(''); loadPending(); }
    else { const err = await res.json().catch(() => ({})); toast.error(err.detail || 'Error'); }
  };

  const handleCreateLoc = async () => {
    if (!newLoc.name) { toast.error('Nombre requerido'); return; }
    const res = await poster('/locations', newLoc);
    if (res.ok) { toast.success('Ubicacion creada'); setNewLoc({ name: '', zone: '', type: 'rack' }); setShowNewLoc(false); loadLocations(); }
    else { const err = await res.json().catch(() => ({})); toast.error(err.detail || 'Error'); }
  };

  return (
    <div className="space-y-4">
      <h2 className="text-lg font-bold text-foreground">Putaway</h2>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="border border-border rounded-lg p-4 bg-card space-y-3">
          <div className="text-sm font-bold text-foreground flex items-center gap-2"><ScanLine className="w-4 h-4 text-primary" /> Escanear / Ingresar</div>
          <input placeholder="Box ID (ej: BOX-000001)" value={boxId} onChange={e => setBoxId(e.target.value.toUpperCase())} className="w-full px-3 py-2 bg-background border border-border rounded text-sm text-foreground font-mono" data-testid="putaway-box-input" />
          <select value={location} onChange={e => setLocation(e.target.value)} className="w-full px-3 py-2 bg-background border border-border rounded text-sm text-foreground" data-testid="putaway-loc-select">
            <option value="">Seleccionar ubicacion...</option>
            {locations.map(l => <option key={l.location_id} value={l.name}>{l.name} {l.zone ? `(${l.zone})` : ''}</option>)}
          </select>
          <button onClick={handlePutaway} className="w-full px-4 py-2 bg-primary text-primary-foreground rounded text-sm font-medium" data-testid="putaway-submit">Ubicar Caja</button>
        </div>
        <div className="border border-border rounded-lg p-4 bg-card space-y-3">
          <div className="flex items-center justify-between">
            <div className="text-sm font-bold text-foreground flex items-center gap-2"><MapPin className="w-4 h-4 text-primary" /> Ubicaciones ({locations.length})</div>
            <button onClick={() => setShowNewLoc(!showNewLoc)} className="text-xs text-primary hover:underline flex items-center gap-1"><Plus className="w-3 h-3" /> Nueva</button>
          </div>
          {showNewLoc && (
            <div className="flex gap-2">
              <input placeholder="Nombre (ej: A-01-01)" value={newLoc.name} onChange={e => setNewLoc(p => ({ ...p, name: e.target.value }))} className="flex-1 px-2 py-1.5 bg-background border border-border rounded text-sm text-foreground" />
              <input placeholder="Zona" value={newLoc.zone} onChange={e => setNewLoc(p => ({ ...p, zone: e.target.value }))} className="w-20 px-2 py-1.5 bg-background border border-border rounded text-sm text-foreground" />
              <button onClick={handleCreateLoc} className="px-3 py-1.5 bg-primary text-primary-foreground rounded text-sm">Crear</button>
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
      </div>
      <div>
        <div className="text-sm font-bold text-foreground mb-2">Cajas Pendientes de Ubicar ({pendingBoxes.length})</div>
        <div className="space-y-1 max-h-[300px] overflow-auto">
          {pendingBoxes.map(b => (
            <div key={b.box_id} className="flex items-center justify-between p-2 border border-border rounded bg-card text-sm cursor-pointer hover:bg-secondary/50" onClick={() => setBoxId(b.box_id)}>
              <span className="font-mono font-bold text-primary">{b.box_id}</span>
              <span>{b.sku} / {b.color} / {b.size}</span>
              <span className="text-muted-foreground">{b.units} units</span>
            </div>
          ))}
          {pendingBoxes.length === 0 && <div className="text-center text-muted-foreground text-xs py-4">Todas las cajas estan ubicadas</div>}
        </div>
      </div>
    </div>
  );
};

// ==================== INVENTORY MODULE ====================
const InventoryModule = () => {
  const [inventory, setInventory] = useState([]);
  const [summary, setSummary] = useState({});
  const [filters, setFilters] = useState({ customers: [], categories: [], manufacturers: [], styles: [] });
  const [search, setSearch] = useState('');
  const [customerFilter, setCustomerFilter] = useState('');
  const [categoryFilter, setCategoryFilter] = useState('');
  const [importing, setImporting] = useState(false);
  const [showFilters, setShowFilters] = useState(false);

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
        toast.success(`Importados ${data.imported.toLocaleString()} registros. ${data.locations_created} ubicaciones nuevas.`);
        load(); loadFilters();
      } else { const err = await res.json().catch(() => ({})); toast.error(err.detail || 'Error al importar'); }
    } catch { toast.error('Error de conexion'); }
    finally { setImporting(false); e.target.value = ''; }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <h2 className="text-lg font-bold text-foreground">Inventory</h2>
        <div className="flex items-center gap-2">
          <label className={`px-3 py-1.5 bg-primary text-primary-foreground rounded text-sm flex items-center gap-1.5 cursor-pointer ${importing ? 'opacity-50' : ''}`} data-testid="import-inv-btn">
            {importing ? <Loader2 className="w-4 h-4 animate-spin" /> : <Package className="w-4 h-4" />}
            {importing ? 'Importando...' : 'Importar Excel'}
            <input type="file" accept=".xlsx,.xls" onChange={handleImport} className="hidden" disabled={importing} />
          </label>
          <button onClick={exportExcel} className="px-3 py-1.5 bg-secondary text-foreground border border-border rounded text-sm flex items-center gap-1.5" data-testid="export-inv-btn">
            <Download className="w-4 h-4" /> Exportar
          </button>
        </div>
      </div>
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        {[
          { label: 'Registros', value: summary.total_skus || 0, color: 'text-purple-400' },
          { label: 'On Hand', value: summary.total_on_hand || 0, color: 'text-blue-400' },
          { label: 'Allocated', value: summary.total_allocated || 0, color: 'text-orange-400' },
          { label: 'Available', value: summary.total_available || 0, color: 'text-green-400' },
          { label: 'Ubicaciones', value: summary.total_locations || 0, color: 'text-cyan-400' },
        ].map(s => (
          <div key={s.label} className="border border-border rounded-lg p-3 bg-card text-center">
            <div className={`text-2xl font-bold ${s.color}`}>{(s.value || 0).toLocaleString()}</div>
            <div className="text-xs text-muted-foreground uppercase">{s.label}</div>
          </div>
        ))}
      </div>
      <div className="flex gap-2 flex-wrap items-center">
        <div className="relative flex-1 min-w-[200px]">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <input placeholder="Buscar por Style..." value={search} onChange={e => setSearch(e.target.value)} className="w-full pl-9 pr-3 py-2 bg-background border border-border rounded text-sm text-foreground" data-testid="inv-search" />
        </div>
        <button onClick={() => setShowFilters(!showFilters)} className={`px-3 py-2 border border-border rounded text-sm flex items-center gap-1 ${showFilters || customerFilter || categoryFilter ? 'bg-primary text-primary-foreground' : 'bg-secondary text-foreground'}`} data-testid="inv-toggle-filters">
          <ScanLine className="w-4 h-4" /> Filtros {(customerFilter || categoryFilter) && <span className="bg-white/20 px-1.5 rounded-full text-xs">{[customerFilter, categoryFilter].filter(Boolean).length}</span>}
        </button>
      </div>
      {showFilters && (
        <div className="grid grid-cols-2 md:grid-cols-3 gap-3 p-3 border border-border rounded-lg bg-secondary/30" data-testid="inv-filters-panel">
          <div>
            <label className="text-xs uppercase tracking-wider text-muted-foreground font-bold block mb-1">Customer</label>
            <select value={customerFilter} onChange={e => setCustomerFilter(e.target.value)} className="w-full px-2 py-1.5 bg-background border border-border rounded text-sm text-foreground" data-testid="inv-filter-customer">
              <option value="">Todos</option>
              {filters.customers.map(c => <option key={c} value={c}>{c}</option>)}
            </select>
          </div>
          <div>
            <label className="text-xs uppercase tracking-wider text-muted-foreground font-bold block mb-1">Category</label>
            <select value={categoryFilter} onChange={e => setCategoryFilter(e.target.value)} className="w-full px-2 py-1.5 bg-background border border-border rounded text-sm text-foreground" data-testid="inv-filter-category">
              <option value="">Todas</option>
              {filters.categories.map(c => <option key={c} value={c}>{c}</option>)}
            </select>
          </div>
          <div className="flex items-end">
            <button onClick={() => { setCustomerFilter(''); setCategoryFilter(''); setSearch(''); }} className="px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground border border-border rounded">Limpiar filtros</button>
          </div>
        </div>
      )}
      <div className="text-xs text-muted-foreground">{inventory.length.toLocaleString()} registros</div>
      <div className="overflow-auto max-h-[400px]">
        <table className="w-full text-sm">
          <thead className="bg-secondary sticky top-0 z-10">
            <tr>
              <th className="p-2 text-left text-xs uppercase text-muted-foreground">Customer</th>
              <th className="p-2 text-left text-xs uppercase text-muted-foreground">Style</th>
              <th className="p-2 text-left text-xs uppercase text-muted-foreground">Color</th>
              <th className="p-2 text-left text-xs uppercase text-muted-foreground">Size</th>
              <th className="p-2 text-left text-xs uppercase text-muted-foreground">Description</th>
              <th className="p-2 text-left text-xs uppercase text-muted-foreground">Category</th>
              <th className="p-2 text-left text-xs uppercase text-muted-foreground">Location</th>
              <th className="p-2 text-right text-xs uppercase text-muted-foreground">Boxes</th>
              <th className="p-2 text-right text-xs uppercase text-muted-foreground">On Hand</th>
              <th className="p-2 text-right text-xs uppercase text-muted-foreground">Allocated</th>
              <th className="p-2 text-right text-xs uppercase text-muted-foreground">Available</th>
            </tr>
          </thead>
          <tbody>
            {inventory.map((inv, i) => (
              <tr key={inv.inventory_id || i} className="border-b border-border hover:bg-secondary/50">
                <td className="p-2 text-xs">{inv.customer}</td>
                <td className="p-2 font-mono font-bold">{inv.style || inv.sku}</td>
                <td className="p-2">{inv.color}</td>
                <td className="p-2">{inv.size}</td>
                <td className="p-2 text-xs truncate max-w-[150px]" title={inv.description}>{inv.description}</td>
                <td className="p-2 text-xs">{inv.category}</td>
                <td className="p-2 font-mono text-xs text-muted-foreground">{inv.inv_location}</td>
                <td className="p-2 text-right font-mono">{(inv.total_boxes || 0).toLocaleString()}</td>
                <td className="p-2 text-right font-mono text-blue-400">{(inv.on_hand || 0).toLocaleString()}</td>
                <td className="p-2 text-right font-mono text-orange-400">{(inv.allocated || 0).toLocaleString()}</td>
                <td className="p-2 text-right font-mono text-green-400">{(inv.available || 0).toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {inventory.length === 0 && <div className="text-center text-muted-foreground text-sm py-8">No hay inventario. Importa un archivo Excel para comenzar.</div>}
      </div>
    </div>
  );
};

// ==================== ORDERS MODULE ====================
const OrdersModule = () => {
  const [orders, setOrders] = useState([]);
  const [ticketMap, setTicketMap] = useState({});
  const load = useCallback(() => {
    fetcher('/orders').then(setOrders).catch(() => {});
    fetcher('/orders-with-tickets').then(setTicketMap).catch(() => {});
  }, []);
  useEffect(() => { load(); }, [load]);

  const getProgress = (orderNum) => {
    const tix = ticketMap[orderNum] || [];
    if (tix.length === 0) return null;
    let totalReq = 0, totalPicked = 0;
    tix.forEach(t => {
      totalReq += t.total_pick_qty || Object.values(t.sizes || {}).reduce((s, v) => s + (parseInt(v) || 0), 0);
      totalPicked += Object.values(t.picked_sizes || {}).reduce((s, v) => s + (parseInt(v) || 0), 0);
    });
    const pct = totalReq > 0 ? Math.round((totalPicked / totalReq) * 100) : 0;
    const completed = tix.filter(t => t.picking_status === 'completed').length;
    return { tickets: tix, totalReq, totalPicked, pct, completed, total: tix.length };
  };

  return (
    <div className="space-y-4">
      <h2 className="text-lg font-bold text-foreground">Orders (CRM)</h2>
      <div className="text-xs text-muted-foreground">Ordenes del tablero BLANKS y ordenes con status PARTIAL/PARCIAL</div>
      <div className="overflow-auto max-h-[600px]">
        <table className="w-full text-sm">
          <thead className="bg-secondary sticky top-0">
            <tr>
              <th className="p-2 text-left text-xs uppercase text-muted-foreground">Order #</th>
              <th className="p-2 text-left text-xs uppercase text-muted-foreground">Client</th>
              <th className="p-2 text-left text-xs uppercase text-muted-foreground">Qty</th>
              <th className="p-2 text-left text-xs uppercase text-muted-foreground">Board</th>
              <th className="p-2 text-left text-xs uppercase text-muted-foreground">Blank Status</th>
              <th className="p-2 text-left text-xs uppercase text-muted-foreground">WMS Status</th>
              <th className="p-2 text-left text-xs uppercase text-muted-foreground">Operador / Picking</th>
            </tr>
          </thead>
          <tbody>
            {orders.map(o => {
              const prog = getProgress(o.order_number);
              return (
                <tr key={o.order_id} className="border-b border-border hover:bg-secondary/50">
                  <td className="p-2 font-mono font-bold text-primary">{o.order_number}</td>
                  <td className="p-2">{o.client}</td>
                  <td className="p-2">{o.quantity}</td>
                  <td className="p-2 text-muted-foreground">{o.board}</td>
                  <td className="p-2"><span className={`text-xs px-2 py-0.5 rounded-full ${(o.blank_status || '').toLowerCase().includes('partial') || (o.blank_status || '').toLowerCase().includes('parcial') ? 'bg-yellow-500/15 text-yellow-400' : 'bg-gray-500/15 text-gray-400'}`}>{o.blank_status || '-'}</span></td>
                  <td className="p-2"><span className={`text-xs px-2 py-0.5 rounded-full ${o.wms_status === 'shipped' ? 'bg-green-500/15 text-green-400' : o.wms_status === 'picked' ? 'bg-blue-500/15 text-blue-400' : o.wms_status === 'allocated' ? 'bg-orange-500/15 text-orange-400' : 'bg-gray-500/15 text-gray-400'}`}>{o.wms_status || 'pending'}</span></td>
                  <td className="p-2">
                    {prog ? (
                      <div className="space-y-1">
                        {prog.tickets.map(t => (
                          <div key={t.ticket_id} className="flex items-center gap-1.5">
                            <span className="text-xs bg-purple-500/15 text-purple-400 px-1.5 py-0.5 rounded-full truncate max-w-[80px]" title={t.assigned_to_name}>{t.assigned_to_name || 'Sin asignar'}</span>
                            <span className={`text-xs px-1.5 py-0.5 rounded-full ${t.picking_status === 'completed' ? 'bg-green-500/15 text-green-400' : t.picking_status === 'in_progress' ? 'bg-yellow-500/15 text-yellow-400' : 'bg-blue-500/15 text-blue-400'}`}>{t.picking_status}</span>
                          </div>
                        ))}
                        <div className="flex items-center gap-1.5 mt-0.5">
                          <div className="w-16 h-1.5 bg-secondary rounded-full overflow-hidden">
                            <div className={`h-full rounded-full ${prog.pct === 100 ? 'bg-green-500' : prog.pct > 0 ? 'bg-yellow-500' : 'bg-gray-500'}`} style={{ width: `${prog.pct}%` }} />
                          </div>
                          <span className="text-xs text-muted-foreground">{prog.pct}%</span>
                        </div>
                      </div>
                    ) : (
                      <span className="text-xs text-muted-foreground">-</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {orders.length === 0 && <div className="text-center text-muted-foreground text-sm py-8">No hay ordenes en BLANKS o con status PARTIAL</div>}
      </div>
    </div>
  );
};

// ==================== ALLOCATION MODULE ====================
const AllocationModule = () => {
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
    if (!selectedOrder) { toast.error('Selecciona una orden'); return; }
    const validItems = items.filter(it => it.sku && parseInt(it.qty) > 0);
    if (validItems.length === 0) { toast.error('Agrega al menos un item con cantidad'); return; }
    setLoading(true);
    try {
      const res = await poster('/allocations', {
        order_id: selectedOrder,
        items: validItems.map(it => ({ sku: it.sku, color: it.color, size: it.size, qty: parseInt(it.qty) }))
      });
      if (res.ok) {
        toast.success('Allocation creada exitosamente');
        setShowForm(false); setSelectedOrder(''); setItems([{ sku: '', color: '', size: '', qty: '', maxQty: 0 }]);
        loadAllocations(); loadInventory();
      } else { const err = await res.json().catch(() => ({})); toast.error(err.detail || 'Error al crear allocation'); }
    } catch { toast.error('Error de conexion'); }
    finally { setLoading(false); }
  };

  const handleDelete = async (id) => {
    if (!window.confirm('Eliminar esta allocation? El inventario se liberara.')) return;
    try { await deleter(`/allocations/${id}`); toast.success('Allocation eliminada'); loadAllocations(); loadInventory(); }
    catch { toast.error('Error al eliminar'); }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-bold text-foreground">Allocation</h2>
        <button onClick={() => setShowForm(!showForm)} className="px-3 py-1.5 bg-primary text-primary-foreground rounded text-sm flex items-center gap-1.5" data-testid="new-allocation-btn">
          <Plus className="w-4 h-4" /> Nueva Allocation
        </button>
      </div>
      {showForm && (
        <div className="border border-border rounded-lg p-4 bg-secondary/30 space-y-3" data-testid="allocation-form">
          <div>
            <label className="text-xs uppercase tracking-wider text-muted-foreground font-bold block mb-1">Orden</label>
            <select value={selectedOrder} onChange={e => setSelectedOrder(e.target.value)} className="w-full px-3 py-2 bg-background border border-border rounded text-sm text-foreground" data-testid="alloc-order-select">
              <option value="">Seleccionar orden...</option>
              {orders.map(o => (
                <option key={o.order_id} value={o.order_id}>
                  {o.order_number} - {o.client || o.customer || 'Sin cliente'} ({o.wms_status || 'pending'})
                </option>
              ))}
            </select>
          </div>
          <div className="text-xs uppercase tracking-wider text-muted-foreground font-bold">Items a Asignar</div>
          {items.map((item, i) => (
            <div key={i} className="grid grid-cols-6 gap-2 items-end">
              <div className="col-span-3">
                <select value={item.sku ? `${item.sku}||${item.color}||${item.size}` : ''} onChange={e => selectInventoryItem(i, e.target.value)}
                  className="w-full px-2 py-1.5 bg-background border border-border rounded text-sm text-foreground" data-testid={`alloc-inv-${i}`}>
                  <option value="">Seleccionar inventario...</option>
                  {availableInv.map(inv => (
                    <option key={`${inv.style || inv.sku}-${inv.color}-${inv.size}-${inv.inv_location || ''}`} value={`${inv.style || inv.sku}||${inv.color || ''}||${inv.size || ''}`}>
                      {inv.customer ? `[${inv.customer}] ` : ''}{inv.style || inv.sku} {inv.color} {inv.size} (Disp: {inv.available})
                    </option>
                  ))}
                </select>
              </div>
              <div className="text-xs text-muted-foreground truncate">
                {item.maxQty > 0 && <span>Max: {item.maxQty}</span>}
              </div>
              <input type="number" placeholder="Qty" value={item.qty} onChange={e => updateItem(i, 'qty', e.target.value)} min="1" max={item.maxQty || 99999}
                className="px-2 py-1.5 bg-background border border-border rounded text-sm text-foreground" data-testid={`alloc-qty-${i}`} />
              <button onClick={() => removeItem(i)} className="p-1.5 text-muted-foreground hover:text-destructive"><Trash2 className="w-4 h-4" /></button>
            </div>
          ))}
          <button onClick={addItem} className="text-xs text-primary hover:underline flex items-center gap-1"><Plus className="w-3 h-3" /> Agregar item</button>
          <div className="flex gap-2">
            <button onClick={handleSubmit} disabled={loading} className="px-4 py-2 bg-primary text-primary-foreground rounded text-sm flex items-center gap-1.5 disabled:opacity-50" data-testid="alloc-submit">
              {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Link2 className="w-4 h-4" />} Asignar Inventario
            </button>
            <button onClick={() => setShowForm(false)} className="px-4 py-2 bg-secondary text-foreground rounded text-sm">Cancelar</button>
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
                <button onClick={() => handleDelete(a.allocation_id)} className="p-1 text-muted-foreground hover:text-destructive" title="Eliminar" data-testid={`alloc-delete-${a.allocation_id}`}>
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>
            <div className="mt-2 flex flex-wrap gap-2">
              {(a.items || []).map((it, i) => <span key={i} className="text-xs bg-secondary px-2 py-1 rounded">{it.sku} {it.color} {it.size}: {it.qty}</span>)}
            </div>
          </div>
        ))}
        {allocations.length === 0 && <div className="text-center text-muted-foreground text-sm py-8">No hay allocations</div>}
      </div>
    </div>
  );
};

// ==================== PICKING MODULE ====================
const PickingModule = () => {
  const [tickets, setTickets] = useState([]);
  const [orders, setOrders] = useState([]);
  const [operators, setOperators] = useState([]);
  const [showForm, setShowForm] = useState(false);
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
    if (!form.order_number || !form.style) { toast.error('Numero de orden y style requeridos'); return; }
    if (totalPick === 0) { toast.error('Ingresa al menos una cantidad por size'); return; }
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
        toast.success(editingTicket ? 'Pick ticket actualizado' : 'Pick ticket creado');
        resetForm();
        loadTickets(); loadStats();
      } else { const err = await res.json().catch(() => ({})); toast.error(err.detail || 'Error'); }
    } catch { toast.error('Error de conexion'); }
    finally { setLoading(false); }
  };

  const handleConfirm = async (ticket) => {
    if (!window.confirm('Confirmar este pick ticket?')) return;
    try {
      const res = await putter(`/pick-tickets/${ticket.ticket_id}/confirm`, { lines: ticket.lines || [] });
      if (res.ok) { toast.success('Pick confirmado'); loadTickets(); loadStats(); }
      else { const err = await res.json().catch(() => ({})); toast.error(err.detail || 'Error'); }
    } catch { toast.error('Error de conexion'); }
  };

  const handlePrint = (t) => {
    const pw = window.open('', '_blank');
    if (!pw) { toast.error('Permite popups para imprimir'); return; }
    const sizes = t.sizes || {};
    const sizeLocs = t.size_locations || {};
    const totalQty = SIZES_ORDER.reduce((s, sz) => s + (parseInt(sizes[sz]) || 0), 0);
    const gridRows = SIZES_ORDER.filter(sz => parseInt(sizes[sz]) > 0).map(sz => {
      const locs = (sizeLocs[sz]?.locations || sizeLocs[sz] || []).slice(0, 3);
      const locStr = locs.map(l => `${l.location} (${l.available})`).join(', ') || '-';
      return `<tr><td style="border:1px solid #000;padding:4px 8px;font-weight:bold;text-align:center;font-size:16px">${sz}</td><td style="border:1px solid #000;padding:4px 8px;text-align:center;font-size:20px;font-weight:bold">${sizes[sz]}</td><td style="border:1px solid #000;padding:4px 8px;font-size:11px;font-family:monospace">${locStr}</td></tr>`;
    }).join('');
    pw.document.write(`<html><head><title>Pick Ticket - ${t.ticket_id}</title><style>@page{size:4in 6in;margin:6mm}body{font-family:Arial,sans-serif;margin:0;padding:10px;width:3.6in}@media print{body{padding:0}}</style></head><body><div style="text-align:center;font-size:16px;font-weight:bold;margin-bottom:4px">${t.customer || ''}</div><div style="text-align:center;margin:6px 0"><svg id="barcode"></svg></div><div style="display:flex;justify-content:space-between;margin-bottom:4px"><div><div style="font-size:13px;font-weight:bold">${t.customer || ''}</div><div style="font-size:12px;font-weight:bold">${t.manufacturer || ''}</div><div style="font-size:12px;font-weight:bold">${t.color || ''}</div></div><div style="text-align:right"><div style="font-size:9px;color:#666">Pick Ticket:</div><div style="font-size:11px;font-weight:bold">${t.ticket_id}</div><div style="font-size:18px;font-weight:bold">${t.style || ''}</div><div style="font-size:14px;font-weight:bold">${t.quantity || ''}</div></div></div><table style="width:100%;border-collapse:collapse;margin:6px 0"><thead><tr style="background:#eee"><th style="border:1px solid #000;padding:3px;font-size:10px">SIZE</th><th style="border:1px solid #000;padding:3px;font-size:10px">QTY</th><th style="border:1px solid #000;padding:3px;font-size:10px">LOCATION</th></tr></thead><tbody>${gridRows}</tbody><tfoot><tr style="font-weight:bold;background:#eee"><td style="border:1px solid #000;padding:4px;text-align:center">TOTAL</td><td style="border:1px solid #000;padding:4px;text-align:center;font-size:18px">${totalQty}</td><td style="border:1px solid #000;padding:4px"></td></tr></tfoot></table><div style="margin-top:12px;display:flex;gap:20px;font-size:11px"><div>Surtidor: ___________________</div><div>Fecha: ___________________</div></div><script src="https://cdn.jsdelivr.net/npm/jsbarcode@3.11.5/dist/JsBarcode.all.min.js"><\/script><script>try{JsBarcode("#barcode","${t.ticket_id}",{width:1.5,height:35,displayValue:false,margin:0})}catch(e){}setTimeout(function(){window.print()},500);<\/script></body></html>`);
    pw.document.close();
  };

  const getTotalAvail = (sz) => sizeLocations[sz]?.total_available || 0;

  const pendingTickets = tickets.filter(t => t.status !== 'confirmed' && t.picking_status !== 'completed');
  const completedTickets = tickets.filter(t => t.status === 'confirmed' || t.picking_status === 'completed');
  const filteredCompleted = filterOp ? completedTickets.filter(t => t.assigned_to_name === filterOp) : completedTickets;

  // Ticket card renderer
  const renderTicket = (t, showEdit = true) => {
    const sizes = t.sizes || {};
    const sizeLocs = t.size_locations || {};
    const hasSizes = Object.values(sizes).some(v => v > 0);
    const pickedSizes = t.picked_sizes || {};
    const totalReq = Object.values(sizes).reduce((s, v) => s + (parseInt(v) || 0), 0);
    const totalPkd = Object.values(pickedSizes).reduce((s, v) => s + (parseInt(v) || 0), 0);
    const pct = totalReq > 0 ? Math.round((totalPkd / totalReq) * 100) : 0;
    return (
      <div key={t.ticket_id} className="border border-border rounded-lg p-3 bg-card" data-testid={`pick-${t.ticket_id}`}>
        <div className="flex items-center justify-between">
          <div>
            <span className="font-mono font-bold text-sm">{t.ticket_id}</span>
            <span className="ml-2 text-primary font-mono text-sm">{t.order_number}</span>
            {t.customer && <span className="ml-2 text-xs text-muted-foreground">{t.customer}</span>}
          </div>
          <div className="flex items-center gap-2">
            <span className={`text-xs px-2 py-0.5 rounded-full ${t.status === 'confirmed' ? 'bg-green-500/15 text-green-400' : 'bg-yellow-500/15 text-yellow-400'}`}>{t.status}</span>
            {t.assigned_to_name && <span className="text-xs bg-purple-500/15 text-purple-400 px-2 py-0.5 rounded-full">{t.assigned_to_name}</span>}
            {t.picking_status && t.picking_status !== 'unassigned' && <span className={`text-xs px-2 py-0.5 rounded-full ${t.picking_status === 'completed' ? 'bg-green-500/15 text-green-400' : t.picking_status === 'in_progress' ? 'bg-yellow-500/15 text-yellow-400' : 'bg-blue-500/15 text-blue-400'}`}>{t.picking_status}</span>}
            <button onClick={() => handlePrint(t)} className="p-1 text-muted-foreground hover:text-foreground" title="Imprimir" data-testid={`pick-print-${t.ticket_id}`}><Printer className="w-3.5 h-3.5" /></button>
            {showEdit && t.status !== 'confirmed' && t.picking_status !== 'completed' && (
              <button onClick={() => openEdit(t)} className="p-1 text-muted-foreground hover:text-primary" title="Editar" data-testid={`pick-edit-${t.ticket_id}`}><Edit3 className="w-3.5 h-3.5" /></button>
            )}
            {t.status === 'pending' && t.picking_status !== 'completed' && (
              <button onClick={() => handleConfirm(t)} className="px-2 py-0.5 bg-green-600 text-white rounded text-xs flex items-center gap-1" data-testid={`pick-confirm-${t.ticket_id}`}><CheckCircle className="w-3 h-3" /> Confirmar</button>
            )}
          </div>
        </div>
        {/* Progress bar */}
        {totalReq > 0 && (
          <div className="flex items-center gap-2 mt-1.5">
            <div className="flex-1 h-1.5 bg-secondary rounded-full overflow-hidden">
              <div className={`h-full rounded-full ${pct === 100 ? 'bg-green-500' : pct > 0 ? 'bg-yellow-500' : 'bg-gray-500'}`} style={{ width: `${pct}%` }} />
            </div>
            <span className="text-xs text-muted-foreground">{totalPkd}/{totalReq} ({pct}%)</span>
          </div>
        )}
        {hasSizes && (
          <div className="mt-2">
            <div className="flex flex-wrap gap-1 mb-1">
              {t.manufacturer && <span className="text-xs bg-secondary px-2 py-0.5 rounded">{t.manufacturer}</span>}
              {t.style && <span className="text-xs bg-secondary px-2 py-0.5 rounded font-mono">{t.style}</span>}
              {t.color && <span className="text-xs bg-secondary px-2 py-0.5 rounded">{t.color}</span>}
              <span className="text-xs font-bold px-2 py-0.5">Total: {t.total_pick_qty || 0}</span>
            </div>
            <div className="space-y-0.5">
              {SIZES_ORDER.filter(sz => sizes[sz] > 0).map(sz => {
                const locs = (sizeLocs[sz]?.locations || sizeLocs[sz] || []).slice(0, 3);
                return (
                  <div key={sz} className="flex items-center gap-2 text-xs bg-secondary/50 px-2 py-1 rounded">
                    <span className="font-bold w-8">{sz}</span>
                    <span className="font-mono text-primary w-12">{sizes[sz]}</span>
                    {pickedSizes[sz] > 0 && <span className="text-green-400 font-mono w-16">picked: {pickedSizes[sz]}</span>}
                    <div className="flex flex-wrap gap-1 flex-1">
                      {locs.map((l, i) => <span key={i} className="font-mono text-xs bg-primary/10 text-primary px-1 py-0.5 rounded">{l.location} ({l.available})</span>)}
                      {locs.length === 0 && <span className="text-muted-foreground">Sin ubicacion</span>}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-bold text-foreground">Picking</h2>
        <div className="flex items-center gap-2">
          <button onClick={() => { resetForm(); setShowForm(true); }} className="px-3 py-1.5 bg-primary text-primary-foreground rounded text-sm flex items-center gap-1.5" data-testid="new-pick-btn">
            <Plus className="w-4 h-4" /> Nuevo Pick Ticket
          </button>
        </div>
      </div>
      {/* Tabs */}
      <div className="flex gap-1 border-b border-border">
        {[
          { id: 'pending', label: `Pendientes (${pendingTickets.length})` },
          { id: 'completed', label: `Completadas (${completedTickets.length})` },
          { id: 'dashboard', label: 'Dashboard' }
        ].map(tab => (
          <button key={tab.id} onClick={() => setActiveTab(tab.id)}
            className={`px-4 py-2 text-sm font-bold border-b-2 transition-colors ${activeTab === tab.id ? 'border-primary text-primary' : 'border-transparent text-muted-foreground hover:text-foreground'}`}
            data-testid={`pick-tab-${tab.id}`}>{tab.label}</button>
        ))}
      </div>
      {/* Form (create/edit) */}
      {showForm && (
        <div className="border border-border rounded-lg p-4 bg-secondary/30 space-y-3" data-testid="pick-form">
          <div className="flex items-center justify-between mb-1">
            <span className="text-sm font-bold text-foreground">{editingTicket ? `Editando: ${editingTicket.ticket_id}` : 'Nuevo Pick Ticket'}</span>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
            <div>
              <label className="text-xs uppercase tracking-wider text-muted-foreground font-bold block mb-1">PO / Orden</label>
              {editingTicket ? (
                <input value={form.order_number} readOnly className="w-full px-3 py-2 bg-secondary/50 border border-border rounded text-sm text-foreground font-mono cursor-not-allowed" data-testid="pick-order-select" />
              ) : (
                <SearchableSelect
                  options={orders.map(o => `${o.order_number}${o.client ? ` - ${o.client}` : ''}`)}
                  value={form.order_number}
                  onChange={(val) => { const num = val.split(' - ')[0].trim(); handleOrderLookup(num); }}
                  placeholder="Buscar o escribir orden..."
                  allowCreate={true}
                  testId="pick-order-select"
                />
              )}
            </div>
            <div>
              <label className="text-xs uppercase tracking-wider text-muted-foreground font-bold block mb-1">Customer</label>
              <SearchableSelect options={options.customers || []} value={form.customer} onChange={handleCustomerChange} placeholder="Buscar customer..." testId="pick-customer" />
            </div>
            <div>
              <label className="text-xs uppercase tracking-wider text-muted-foreground font-bold block mb-1">Asignar Operador</label>
              <select value={form.assigned_to} onChange={e => {
                const op = operators.find(o => o.user_id === e.target.value || o.email === e.target.value);
                setForm(p => ({ ...p, assigned_to: e.target.value, assigned_to_name: op ? (op.name || op.email) : '' }));
              }} className="w-full px-3 py-2 bg-background border border-border rounded text-sm text-foreground" data-testid="pick-operator-select">
                <option value="">Sin asignar</option>
                {operators.map(op => <option key={op.user_id || op.email} value={op.user_id || op.email}>{op.name || op.email}</option>)}
              </select>
            </div>
          </div>
          <div className="grid grid-cols-3 gap-3">
            <div>
              <label className="text-xs uppercase tracking-wider text-muted-foreground font-bold block mb-1">Quantity (auto)</label>
              <input type="number" value={form.quantity} onChange={e => setForm(p => ({ ...p, quantity: parseInt(e.target.value) || 0 }))} className="w-full px-3 py-2 bg-background border border-border rounded text-sm text-foreground" data-testid="pick-qty" />
            </div>
          </div>
          <div className="grid grid-cols-3 gap-3">
            <div>
              <label className="text-xs uppercase tracking-wider text-muted-foreground font-bold block mb-1">Manufacturer</label>
              <SearchableSelect options={options.manufacturers || []} value={form.manufacturer} onChange={handleManufacturerChange} placeholder="Buscar manufacturer..." testId="pick-manufacturer" />
              {!form.customer && <div className="text-xs text-muted-foreground mt-0.5">Selecciona orden primero</div>}
            </div>
            <div>
              <label className="text-xs uppercase tracking-wider text-muted-foreground font-bold block mb-1">Style</label>
              <SearchableSelect options={options.styles || []} value={form.style} onChange={handleStyleChange} placeholder="Buscar style..." testId="pick-style" />
            </div>
            <div>
              <label className="text-xs uppercase tracking-wider text-muted-foreground font-bold block mb-1">Color</label>
              <SearchableSelect options={options.colors || []} value={form.color} onChange={handleColorChange} placeholder="Buscar color..." testId="pick-color" />
              {form.style && !form.color && <div className="text-xs text-muted-foreground mt-0.5">Selecciona para ver ubicaciones</div>}
            </div>
          </div>
          <div className="text-xs uppercase tracking-wider text-muted-foreground font-bold">Cantidades por Size + Ubicaciones</div>
          <div className="overflow-auto">
            <table className="w-full text-sm">
              <thead><tr className="text-xs uppercase text-muted-foreground"><th className="p-1 text-center w-16">Size</th><th className="p-1 text-center w-20">Qty</th><th className="p-1 text-left">Ubicacion(es)</th><th className="p-1 text-right w-20">Disponible</th></tr></thead>
              <tbody>
                {SIZES_ORDER.map(sz => (
                  <tr key={sz} className="border-b border-border/50">
                    <td className="p-1 text-center font-bold">{sz}</td>
                    <td className="p-1"><input type="number" min="0" value={form.sizes[sz]} onChange={e => updateSize(sz, e.target.value)} placeholder="0" className="w-full px-2 py-1.5 bg-background border border-border rounded text-center text-sm font-mono text-foreground" data-testid={`pick-size-${sz}`} /></td>
                    <td className="p-1">
                      {(sizeLocations[sz]?.locations || []).length > 0 ? (
                        <div className="flex flex-wrap gap-1">{(sizeLocations[sz]?.locations || []).slice(0, 4).map((l, i) => <span key={i} className="text-xs font-mono bg-primary/15 text-primary px-1.5 py-0.5 rounded" title={`${l.available} units`}>{l.location} ({l.available})</span>)}{(sizeLocations[sz]?.locations || []).length > 4 && <span className="text-xs text-muted-foreground">+{(sizeLocations[sz]?.locations || []).length - 4}</span>}</div>
                      ) : (<span className="text-xs text-muted-foreground">{form.style ? 'Sin ubicacion' : '-'}</span>)}
                    </td>
                    <td className="p-1 text-right font-mono text-xs text-green-400">{getTotalAvail(sz) > 0 ? getTotalAvail(sz).toLocaleString() : '-'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="text-right font-bold text-sm">Total Pick: {totalPick} units</div>
          <div className="flex gap-2">
            <button onClick={handleSubmit} disabled={loading} className="px-4 py-2 bg-primary text-primary-foreground rounded text-sm flex items-center gap-1.5 disabled:opacity-50" data-testid="pick-submit">
              {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <ClipboardCheck className="w-4 h-4" />} {editingTicket ? 'Guardar Cambios' : 'Crear Pick Ticket'}
            </button>
            <button onClick={resetForm} className="px-4 py-2 bg-secondary text-foreground rounded text-sm">Cancelar</button>
          </div>
        </div>
      )}
      {/* Tab Content */}
      {activeTab === 'pending' && (
        <div className="space-y-2" data-testid="pick-pending-list">
          {pendingTickets.map(t => renderTicket(t))}
          {pendingTickets.length === 0 && <div className="text-center text-muted-foreground text-sm py-8">No hay pick tickets pendientes</div>}
        </div>
      )}
      {activeTab === 'completed' && (
        <div className="space-y-3" data-testid="pick-completed-list">
          <div className="flex items-center gap-3">
            <select value={filterOp} onChange={e => setFilterOp(e.target.value)} className="px-3 py-1.5 bg-background border border-border rounded text-sm text-foreground" data-testid="pick-filter-operator">
              <option value="">Todos los operadores</option>
              {operators.map(op => <option key={op.email} value={op.name || op.email}>{op.name || op.email}</option>)}
            </select>
            <span className="text-xs text-muted-foreground">{filteredCompleted.length} completadas</span>
          </div>
          <div className="space-y-2">
            {filteredCompleted.map(t => renderTicket(t, false))}
            {filteredCompleted.length === 0 && <div className="text-center text-muted-foreground text-sm py-8">No hay tickets completados</div>}
          </div>
        </div>
      )}
      {activeTab === 'dashboard' && stats && (
        <div className="space-y-4" data-testid="pick-dashboard">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <div className="bg-card border border-border rounded-lg p-4 text-center">
              <div className="text-2xl font-bold text-foreground">{stats.total_tickets}</div>
              <div className="text-xs text-muted-foreground uppercase">Total Tickets</div>
            </div>
            <div className="bg-card border border-border rounded-lg p-4 text-center">
              <div className="text-2xl font-bold text-green-400">{stats.completed}</div>
              <div className="text-xs text-muted-foreground uppercase">Completados</div>
            </div>
            <div className="bg-card border border-border rounded-lg p-4 text-center">
              <div className="text-2xl font-bold text-yellow-400">{stats.in_progress}</div>
              <div className="text-xs text-muted-foreground uppercase">En Progreso</div>
            </div>
            <div className="bg-card border border-border rounded-lg p-4 text-center">
              <div className="text-2xl font-bold text-blue-400">{stats.pending}</div>
              <div className="text-xs text-muted-foreground uppercase">Pendientes</div>
            </div>
          </div>
          <h3 className="text-sm font-bold text-foreground uppercase">Productividad por Operador</h3>
          {stats.operators.length > 0 ? (
            <div className="overflow-auto">
              <table className="w-full text-sm">
                <thead className="bg-secondary">
                  <tr>
                    <th className="p-2 text-left text-xs uppercase text-muted-foreground">Operador</th>
                    <th className="p-2 text-center text-xs uppercase text-muted-foreground">Completados</th>
                    <th className="p-2 text-center text-xs uppercase text-muted-foreground">En Progreso</th>
                    <th className="p-2 text-center text-xs uppercase text-muted-foreground">Asignados</th>
                    <th className="p-2 text-center text-xs uppercase text-muted-foreground">Piezas Totales</th>
                    <th className="p-2 text-center text-xs uppercase text-muted-foreground">Piezas Surtidas</th>
                    <th className="p-2 text-center text-xs uppercase text-muted-foreground">% Eficiencia</th>
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
            <div className="text-center text-muted-foreground text-sm py-8">No hay datos de operadores</div>
          )}
        </div>
      )}
    </div>
  );
};

// ==================== PRODUCTION MODULE ====================
const ProductionModule = () => {
  const [boxes, setBoxes] = useState([]);
  const [stateFilter, setStateFilter] = useState('');
  const [selected, setSelected] = useState(new Set());
  const [loading, setLoading] = useState(false);

  const load = useCallback(() => {
    const params = stateFilter ? `?state=${stateFilter}` : '';
    fetcher(`/boxes${params ? params : '?status=stored'}`).then(data => {
      if (stateFilter) setBoxes(data.filter(b => b.state === stateFilter));
      else setBoxes(data.filter(b => ['raw', 'wip', 'finished'].includes(b.state)));
    }).catch(() => {});
  }, [stateFilter]);
  useEffect(() => { load(); }, [load]);

  const toggleSelect = (id) => setSelected(p => { const n = new Set(p); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const selectAll = () => setSelected(boxes.length === selected.size ? new Set() : new Set(boxes.map(b => b.box_id)));

  const handleMove = async (targetState) => {
    if (selected.size === 0) { toast.error('Selecciona al menos una caja'); return; }
    setLoading(true);
    try {
      const res = await poster('/production/move', { box_ids: [...selected], target_state: targetState });
      if (res.ok) { const data = await res.json(); toast.success(`${data.moved?.length || 0} cajas movidas a ${targetState.toUpperCase()}`); setSelected(new Set()); load(); }
      else { const err = await res.json().catch(() => ({})); toast.error(err.detail || 'Error'); }
    } catch { toast.error('Error de conexion'); }
    finally { setLoading(false); }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-bold text-foreground">Production</h2>
        <div className="flex gap-2">
          {['', 'raw', 'wip', 'finished'].map(s => (
            <button key={s} onClick={() => { setStateFilter(s); setSelected(new Set()); }} className={`px-3 py-1 rounded text-xs ${stateFilter === s ? 'bg-primary text-primary-foreground' : 'bg-secondary text-foreground'}`}>
              {s === '' ? 'All' : s.toUpperCase()}
            </button>
          ))}
        </div>
      </div>
      {selected.size > 0 && (
        <div className="flex items-center gap-2 p-2 bg-primary/10 border border-primary/20 rounded-lg" data-testid="production-actions">
          <span className="text-sm font-medium">{selected.size} seleccionadas</span>
          <button onClick={() => handleMove('wip')} disabled={loading} className="px-3 py-1 bg-yellow-600 text-white rounded text-xs flex items-center gap-1 disabled:opacity-50" data-testid="move-wip-btn">
            {loading ? <Loader2 className="w-3 h-3 animate-spin" /> : <Factory className="w-3 h-3" />} Mover a WIP
          </button>
          <button onClick={() => handleMove('finished')} disabled={loading} className="px-3 py-1 bg-green-600 text-white rounded text-xs flex items-center gap-1 disabled:opacity-50" data-testid="move-finished-btn">
            {loading ? <Loader2 className="w-3 h-3 animate-spin" /> : <CheckCircle className="w-3 h-3" />} Mover a FINISHED
          </button>
        </div>
      )}
      <div className="overflow-auto max-h-[500px]">
        <table className="w-full text-sm">
          <thead className="bg-secondary sticky top-0">
            <tr>
              <th className="p-2 text-left"><input type="checkbox" checked={boxes.length > 0 && selected.size === boxes.length} onChange={selectAll} className="rounded" /></th>
              <th className="p-2 text-left text-xs uppercase text-muted-foreground">Box ID</th>
              <th className="p-2 text-left text-xs uppercase text-muted-foreground">SKU</th>
              <th className="p-2 text-left text-xs uppercase text-muted-foreground">Color</th>
              <th className="p-2 text-left text-xs uppercase text-muted-foreground">Size</th>
              <th className="p-2 text-left text-xs uppercase text-muted-foreground">Units</th>
              <th className="p-2 text-left text-xs uppercase text-muted-foreground">State</th>
              <th className="p-2 text-left text-xs uppercase text-muted-foreground">Location</th>
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
                <td className="p-2"><span className={`text-xs px-2 py-0.5 rounded-full ${b.state === 'finished' ? 'bg-green-500/15 text-green-400' : b.state === 'wip' ? 'bg-yellow-500/15 text-yellow-400' : 'bg-blue-500/15 text-blue-400'}`}>{b.state}</span></td>
                <td className="p-2 text-muted-foreground">{b.location || '-'}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {boxes.length === 0 && <div className="text-center text-muted-foreground text-sm py-8">No hay cajas en produccion</div>}
      </div>
    </div>
  );
};

// ==================== FINISHED GOODS MODULE ====================
const FinishedGoodsModule = () => {
  const [boxes, setBoxes] = useState([]);
  const load = useCallback(() => { fetcher('/finished-goods').then(setBoxes).catch(() => {}); }, []);
  useEffect(() => { load(); }, [load]);
  return (
    <div className="space-y-4">
      <h2 className="text-lg font-bold text-foreground">Finished Goods</h2>
      <div className="text-sm text-muted-foreground mb-2">{boxes.length} cajas terminadas / {boxes.reduce((s, b) => s + (b.units || 0), 0)} units total</div>
      <div className="overflow-auto max-h-[500px]">
        <table className="w-full text-sm">
          <thead className="bg-secondary sticky top-0">
            <tr>
              <th className="p-2 text-left text-xs uppercase text-muted-foreground">Box ID</th>
              <th className="p-2 text-left text-xs uppercase text-muted-foreground">SKU</th>
              <th className="p-2 text-left text-xs uppercase text-muted-foreground">Color</th>
              <th className="p-2 text-left text-xs uppercase text-muted-foreground">Size</th>
              <th className="p-2 text-left text-xs uppercase text-muted-foreground">Units</th>
              <th className="p-2 text-left text-xs uppercase text-muted-foreground">Location</th>
            </tr>
          </thead>
          <tbody>
            {boxes.map(b => (
              <tr key={b.box_id} className="border-b border-border hover:bg-secondary/50">
                <td className="p-2 font-mono font-bold text-primary">{b.box_id}</td>
                <td className="p-2">{b.sku}</td>
                <td className="p-2">{b.color}</td>
                <td className="p-2">{b.size}</td>
                <td className="p-2">{b.units}</td>
                <td className="p-2 text-muted-foreground">{b.location || '-'}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {boxes.length === 0 && <div className="text-center text-muted-foreground text-sm py-8">No hay finished goods</div>}
      </div>
    </div>
  );
};

// ==================== SHIPPING MODULE ====================
const ShippingModule = () => {
  const [shipments, setShipments] = useState([]);
  const [showForm, setShowForm] = useState(false);
  const [finishedBoxes, setFinishedBoxes] = useState([]);
  const [selectedBoxes, setSelectedBoxes] = useState(new Set());
  const [form, setForm] = useState({ order_id: '', carrier: '', tracking: '', pallet: '' });
  const [orders, setOrders] = useState([]);
  const [loading, setLoading] = useState(false);

  const loadShipments = useCallback(() => { fetcher('/shipments').then(setShipments).catch(() => {}); }, []);
  const loadFinished = useCallback(() => { fetcher('/finished-goods').then(setFinishedBoxes).catch(() => {}); }, []);
  const loadOrders = useCallback(() => { fetcher('/orders').then(setOrders).catch(() => {}); }, []);
  useEffect(() => { loadShipments(); loadFinished(); loadOrders(); }, [loadShipments, loadFinished, loadOrders]);

  const toggleBox = (id) => setSelectedBoxes(p => { const n = new Set(p); n.has(id) ? n.delete(id) : n.add(id); return n; });

  const handleSubmit = async () => {
    if (selectedBoxes.size === 0) { toast.error('Selecciona al menos una caja'); return; }
    setLoading(true);
    try {
      const res = await poster('/shipments', { ...form, box_ids: [...selectedBoxes] });
      if (res.ok) {
        toast.success('Envio creado'); setShowForm(false); setSelectedBoxes(new Set());
        setForm({ order_id: '', carrier: '', tracking: '', pallet: '' });
        loadShipments(); loadFinished();
      } else { const err = await res.json().catch(() => ({})); toast.error(err.detail || 'Error'); }
    } catch { toast.error('Error de conexion'); }
    finally { setLoading(false); }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-bold text-foreground">Shipping</h2>
        <button onClick={() => setShowForm(!showForm)} className="px-3 py-1.5 bg-primary text-primary-foreground rounded text-sm flex items-center gap-1.5" data-testid="new-shipment-btn">
          <Plus className="w-4 h-4" /> Nuevo Envio
        </button>
      </div>
      {showForm && (
        <div className="border border-border rounded-lg p-4 bg-secondary/30 space-y-3" data-testid="shipment-form">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs uppercase tracking-wider text-muted-foreground font-bold block mb-1">Orden (opcional)</label>
              <select value={form.order_id} onChange={e => setForm(p => ({ ...p, order_id: e.target.value }))} className="w-full px-3 py-2 bg-background border border-border rounded text-sm text-foreground" data-testid="ship-order">
                <option value="">Sin orden</option>
                {orders.map(o => <option key={o.order_id} value={o.order_id}>{o.order_number} - {o.client || ''}</option>)}
              </select>
            </div>
            <input placeholder="Pallet #" value={form.pallet} onChange={e => setForm(p => ({ ...p, pallet: e.target.value }))} className="px-3 py-2 bg-background border border-border rounded text-sm text-foreground mt-auto" data-testid="ship-pallet" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <input placeholder="Carrier (ej: FedEx)" value={form.carrier} onChange={e => setForm(p => ({ ...p, carrier: e.target.value }))} className="px-3 py-2 bg-background border border-border rounded text-sm text-foreground" data-testid="ship-carrier" />
            <input placeholder="Tracking #" value={form.tracking} onChange={e => setForm(p => ({ ...p, tracking: e.target.value }))} className="px-3 py-2 bg-background border border-border rounded text-sm text-foreground" data-testid="ship-tracking" />
          </div>
          <div className="text-xs uppercase tracking-wider text-muted-foreground font-bold">Cajas Terminadas Disponibles</div>
          <div className="max-h-[200px] overflow-auto space-y-1">
            {finishedBoxes.map(b => (
              <div key={b.box_id} className={`flex items-center gap-2 p-2 rounded text-sm cursor-pointer border ${selectedBoxes.has(b.box_id) ? 'border-primary bg-primary/10' : 'border-border bg-card'}`} onClick={() => toggleBox(b.box_id)}>
                <input type="checkbox" checked={selectedBoxes.has(b.box_id)} readOnly className="rounded" />
                <span className="font-mono font-bold text-primary">{b.box_id}</span>
                <span>{b.sku} {b.color} {b.size}</span>
                <span className="text-muted-foreground ml-auto">{b.units} units</span>
              </div>
            ))}
            {finishedBoxes.length === 0 && <div className="text-xs text-muted-foreground text-center py-4">No hay cajas terminadas disponibles</div>}
          </div>
          <div className="flex gap-2">
            <button onClick={handleSubmit} disabled={loading || selectedBoxes.size === 0} className="px-4 py-2 bg-primary text-primary-foreground rounded text-sm flex items-center gap-1.5 disabled:opacity-50" data-testid="ship-submit">
              {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Truck className="w-4 h-4" />} Crear Envio ({selectedBoxes.size} cajas)
            </button>
            <button onClick={() => setShowForm(false)} className="px-4 py-2 bg-secondary text-foreground rounded text-sm">Cancelar</button>
          </div>
        </div>
      )}
      <div className="space-y-2">
        {shipments.map(s => (
          <div key={s.shipment_id} className="border border-border rounded-lg p-3 bg-card" data-testid={`ship-${s.shipment_id}`}>
            <div className="flex items-center justify-between">
              <span className="font-mono font-bold text-sm">{s.shipment_id}</span>
              <span className="text-xs text-muted-foreground">{s.total_boxes} cajas / {s.total_units} units</span>
            </div>
            {(s.carrier || s.tracking) && <div className="text-xs mt-1 text-muted-foreground">
              {s.carrier && <span>Carrier: {s.carrier}</span>}
              {s.tracking && <span className="ml-2">Tracking: {s.tracking}</span>}
            </div>}
            <div className="text-xs text-muted-foreground mt-1">{new Date(s.created_at).toLocaleString()}</div>
          </div>
        ))}
        {shipments.length === 0 && <div className="text-center text-muted-foreground text-sm py-8">No hay envios</div>}
      </div>
    </div>
  );
};

// ==================== MOVEMENTS MODULE ====================
const MovementsModule = () => {
  const [movements, setMovements] = useState([]);
  const [typeFilter, setTypeFilter] = useState('');
  const load = useCallback(() => { fetcher(`/movements?movement_type=${typeFilter}`).then(setMovements).catch(() => {}); }, [typeFilter]);
  useEffect(() => { load(); }, [load]);
  const types = ['', 'receiving', 'putaway', 'allocation', 'deallocate', 'pick_ticket_created', 'pick_confirmed', 'production_move', 'shipment'];
  return (
    <div className="space-y-4">
      <h2 className="text-lg font-bold text-foreground">Movements (Audit Log)</h2>
      <div className="flex gap-1 flex-wrap">
        {types.map(t => (
          <button key={t} onClick={() => setTypeFilter(t)} className={`px-2 py-1 rounded text-xs ${typeFilter === t ? 'bg-primary text-primary-foreground' : 'bg-secondary text-foreground'}`}>
            {t || 'All'}
          </button>
        ))}
      </div>
      <div className="space-y-1 max-h-[500px] overflow-auto">
        {movements.map(m => (
          <div key={m.movement_id} className="flex items-center gap-3 p-2 border-b border-border text-sm">
            <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${{receiving:'bg-blue-500/15 text-blue-400', putaway:'bg-green-500/15 text-green-400', allocation:'bg-orange-500/15 text-orange-400', pick_confirmed:'bg-purple-500/15 text-purple-400', shipment:'bg-emerald-500/15 text-emerald-400'}[m.type] || 'bg-gray-500/15 text-gray-400'}`}>{m.type}</span>
            <span className="flex-1 text-xs text-muted-foreground truncate">{JSON.stringify(m.details || {}).substring(0, 120)}</span>
            <span className="text-xs text-muted-foreground whitespace-nowrap">{m.user_name}</span>
            <span className="text-xs text-muted-foreground whitespace-nowrap">{new Date(m.created_at).toLocaleString()}</span>
          </div>
        ))}
        {movements.length === 0 && <div className="text-center text-muted-foreground text-sm py-8">No hay movimientos</div>}
      </div>
    </div>
  );
};


// ==================== CYCLE COUNT MODULE ====================
const CycleCountModule = () => {
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

  const handleCreate = async () => {
    if (!form.name) { toast.error('Nombre requerido'); return; }
    setLoading(true);
    try {
      const res = await poster('/cycle-counts', form);
      if (res.ok) {
        const data = await res.json();
        toast.success(`Conteo creado: ${data.total_lines} items`);
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
    } catch { toast.error('Error al cargar conteo'); }
  };

  const saveProgress = async (countedItems) => {
    if (!selectedCount) return;
    setSaving(true);
    try {
      const res = await putter(`/cycle-counts/${selectedCount.count_id}/count`, { counted_items: countedItems });
      if (res.ok) {
        toast.success('Progreso guardado');
        const updated = await fetcher(`/cycle-counts/${selectedCount.count_id}`);
        setSelectedCount(updated);
        load();
      } else { const err = await res.json().catch(() => ({})); toast.error(err.detail || 'Error'); }
    } catch { toast.error('Error'); }
    finally { setSaving(false); }
  };

  const approveCount = async () => {
    if (!selectedCount || !window.confirm('Aprobar conteo y ajustar inventario?')) return;
    setSaving(true);
    try {
      const res = await putter(`/cycle-counts/${selectedCount.count_id}/approve`, {});
      if (res.ok) {
        const data = await res.json();
        toast.success(data.message);
        setSelectedCount(null);
        load();
      } else { const err = await res.json().catch(() => ({})); toast.error(err.detail || 'Error'); }
    } catch { toast.error('Error'); }
    finally { setSaving(false); }
  };

  // Counting interface
  if (selectedCount) {
    const lines = selectedCount.lines || [];
    const grouped = {};
    lines.forEach(l => {
      const key = l.inv_location || 'SIN UBICACION';
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
            <span className={`text-xs px-2 py-1 rounded-full font-bold ${selectedCount.status === 'approved' ? 'bg-green-500/15 text-green-400' : selectedCount.status === 'completed' ? 'bg-blue-500/15 text-blue-400' : 'bg-yellow-500/15 text-yellow-400'}`}>{selectedCount.status}</span>
            {selectedCount.assigned_to_name && <span className="text-xs bg-purple-500/15 text-purple-400 px-2 py-1 rounded-full">{selectedCount.assigned_to_name}</span>}
          </div>
        </div>
        {/* Progress */}
        <div className="bg-card border border-border rounded-lg p-4">
          <div className="flex items-center justify-between mb-2">
            <span className="text-sm font-bold">Progreso: {countedLines}/{totalLines} items</span>
            <div className="flex items-center gap-3">
              {discrepancies > 0 && <span className="text-xs bg-red-500/15 text-red-400 px-2 py-1 rounded-full font-bold">{discrepancies} discrepancias</span>}
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
                      <div className="text-xs text-muted-foreground">Sistema</div>
                      <div className="text-sm font-bold">{line.system_qty}</div>
                    </div>
                    <div className="w-24">
                      <div className="text-xs text-muted-foreground">Conteo</div>
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
              {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />} Guardar Conteo
            </button>
            {selectedCount.status === 'completed' && (
              <button onClick={approveCount} disabled={saving} className="flex-1 px-4 py-2.5 bg-green-600 text-white rounded-lg text-sm font-bold flex items-center justify-center gap-2 disabled:opacity-50" data-testid="cc-approve">
                {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle className="w-4 h-4" />} Aprobar y Ajustar Inventario
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
        <h2 className="text-lg font-bold text-foreground">Inventario Ciclico</h2>
        <button onClick={() => setShowForm(!showForm)} className="px-3 py-1.5 bg-primary text-primary-foreground rounded text-sm flex items-center gap-1.5" data-testid="new-cc-btn">
          <Plus className="w-4 h-4" /> Nuevo Conteo
        </button>
      </div>
      {showForm && (
        <div className="border border-border rounded-lg p-4 bg-secondary/30 space-y-3" data-testid="cc-form">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs uppercase tracking-wider text-muted-foreground font-bold block mb-1">Nombre del Conteo</label>
              <input placeholder="Ej: Conteo zona RP10" value={form.name} onChange={e => setForm(p => ({ ...p, name: e.target.value }))} className="w-full px-3 py-2 bg-background border border-border rounded text-sm text-foreground" data-testid="cc-name" />
            </div>
            <div>
              <label className="text-xs uppercase tracking-wider text-muted-foreground font-bold block mb-1">Asignar a</label>
              <select value={form.assigned_to} onChange={e => { const op = operators.find(o => (o.user_id || o.email) === e.target.value); setForm(p => ({ ...p, assigned_to: e.target.value, assigned_to_name: op ? (op.name || op.email) : '' })); }} className="w-full px-3 py-2 bg-background border border-border rounded text-sm text-foreground" data-testid="cc-assign">
                <option value="">Sin asignar</option>
                {operators.map(op => <option key={op.user_id || op.email} value={op.user_id || op.email}>{op.name || op.email}</option>)}
              </select>
            </div>
          </div>
          <div className="text-xs uppercase tracking-wider text-muted-foreground font-bold">Filtros (dejar vacio para todo)</div>
          <div className="grid grid-cols-3 gap-3">
            <div>
              <label className="text-xs text-muted-foreground mb-1 block">Ubicacion (contiene)</label>
              <input placeholder="Ej: RP10" value={form.location_filter} onChange={e => setForm(p => ({ ...p, location_filter: e.target.value }))} className="w-full px-3 py-2 bg-background border border-border rounded text-sm text-foreground font-mono" data-testid="cc-loc" />
            </div>
            <div>
              <label className="text-xs text-muted-foreground mb-1 block">Customer</label>
              <SearchableSelect options={options.customers} value={form.customer_filter} onChange={val => setForm(p => ({ ...p, customer_filter: val }))} placeholder="Todos..." testId="cc-customer" />
            </div>
            <div>
              <label className="text-xs text-muted-foreground mb-1 block">Style</label>
              <SearchableSelect options={options.styles} value={form.style_filter} onChange={val => setForm(p => ({ ...p, style_filter: val }))} placeholder="Todos..." testId="cc-style" />
            </div>
          </div>
          <div className="flex gap-2">
            <button onClick={handleCreate} disabled={loading} className="px-4 py-2 bg-primary text-primary-foreground rounded text-sm flex items-center gap-1.5 disabled:opacity-50" data-testid="cc-create">
              {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <ClipboardList className="w-4 h-4" />} Crear Conteo
            </button>
            <button onClick={() => setShowForm(false)} className="px-4 py-2 bg-secondary text-foreground rounded text-sm">Cancelar</button>
          </div>
        </div>
      )}
      <div className="space-y-2">
        {counts.map(c => {
          const pct = c.total_lines > 0 ? Math.round((c.counted_lines / c.total_lines) * 100) : 0;
          return (
            <button key={c.count_id} onClick={() => openCount(c)} className="w-full text-left border border-border rounded-lg p-3 bg-card hover:border-primary/50 transition-all" data-testid={`cc-${c.count_id}`}>
              <div className="flex items-center justify-between mb-1">
                <div className="flex items-center gap-2">
                  <span className="font-bold text-sm">{c.name}</span>
                  <span className={`text-xs px-2 py-0.5 rounded-full ${c.status === 'approved' ? 'bg-green-500/15 text-green-400' : c.status === 'completed' ? 'bg-blue-500/15 text-blue-400' : c.status === 'in_progress' ? 'bg-yellow-500/15 text-yellow-400' : 'bg-gray-500/15 text-gray-400'}`}>{c.status}</span>
                  {c.assigned_to_name && <span className="text-xs bg-purple-500/15 text-purple-400 px-2 py-0.5 rounded-full">{c.assigned_to_name}</span>}
                </div>
                <span className="text-xs text-muted-foreground">{new Date(c.created_at).toLocaleDateString()}</span>
              </div>
              <div className="flex items-center gap-2">
                <div className="flex-1 h-1.5 bg-secondary rounded-full overflow-hidden">
                  <div className={`h-full rounded-full ${pct === 100 ? 'bg-green-500' : pct > 0 ? 'bg-yellow-500' : 'bg-gray-500'}`} style={{ width: `${pct}%` }} />
                </div>
                <span className="text-xs text-muted-foreground">{c.counted_lines}/{c.total_lines} ({pct}%)</span>
              </div>
              {c.location_filter && <span className="text-xs text-muted-foreground mt-1 block">Ubicacion: {c.location_filter}</span>}
            </button>
          );
        })}
        {counts.length === 0 && <div className="text-center text-muted-foreground text-sm py-8">No hay conteos ciclicos</div>}
      </div>
    </div>
  );
};

// ==================== MAIN WMS COMPONENT ====================
const MODULE_COMPONENTS = {
  receiving: ReceivingModule,
  putaway: PutawayModule,
  inventory: InventoryModule,
  orders: OrdersModule,
  picking: PickingModule,
  production: ProductionModule,
  finished: FinishedGoodsModule,
  shipping: ShippingModule,
  movements: MovementsModule,
  cycle_count: CycleCountModule,
};

export default function WMS() {
  const navigate = useNavigate();
  const [activeModule, setActiveModule] = useState('receiving');
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [isDark, setIsDark] = useState(() => !document.documentElement.classList.contains('light-theme'));
  const ActiveComponent = MODULE_COMPONENTS[activeModule] || ReceivingModule;

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

  return (
    <div className="min-h-screen bg-background flex">
      <Toaster position="bottom-right" theme={isDark ? 'dark' : 'light'} />
      {/* Sidebar */}
      <aside className={`${sidebarCollapsed ? 'w-14' : 'w-52'} bg-card border-r border-border flex flex-col transition-all duration-200`}>
        <div className="p-3 border-b border-border flex items-center gap-2">
          <button onClick={() => navigate('/dashboard')} className="p-1 rounded hover:bg-secondary" data-testid="wms-back-btn">
            <ArrowLeft className="w-4 h-4 text-muted-foreground" />
          </button>
          {!sidebarCollapsed && <span className="font-barlow font-bold text-sm text-foreground"><Warehouse className="w-4 h-4 inline mr-1 text-primary" />WMS</span>}
          <button onClick={() => setSidebarCollapsed(!sidebarCollapsed)} className="ml-auto p-1 rounded hover:bg-secondary">
            {sidebarCollapsed ? <ChevronRight className="w-3 h-3" /> : <X className="w-3 h-3" />}
          </button>
        </div>
        <nav className="flex-1 py-2 space-y-0.5 overflow-y-auto">
          {MODULES.map(m => {
            const Icon = m.icon;
            const isActive = activeModule === m.id;
            return (
              <button key={m.id} onClick={() => setActiveModule(m.id)}
                className={`w-full flex items-center gap-2.5 px-3 py-2 text-xs font-medium transition-all ${isActive ? 'bg-primary/15 text-primary border-r-2 border-primary' : 'text-muted-foreground hover:text-foreground hover:bg-secondary/50'}`}
                data-testid={`wms-nav-${m.id}`} title={m.label}>
                <Icon className="w-4 h-4 flex-shrink-0" />
                {!sidebarCollapsed && <span>{m.label}</span>}
              </button>
            );
          })}
        </nav>
        <div className="p-2 border-t border-border">
          <button onClick={toggleTheme} className="w-full flex items-center gap-2.5 px-3 py-2 text-xs font-medium text-muted-foreground hover:text-foreground hover:bg-secondary/50 rounded transition-all" data-testid="wms-theme-toggle" title={isDark ? 'Modo claro' : 'Modo oscuro'}>
            {isDark ? <Sun className="w-4 h-4 flex-shrink-0" /> : <Moon className="w-4 h-4 flex-shrink-0" />}
            {!sidebarCollapsed && <span>{isDark ? 'Modo Claro' : 'Modo Oscuro'}</span>}
          </button>
        </div>
      </aside>
      {/* Main Content */}
      <main className="flex-1 p-6 overflow-auto">
        <ActiveComponent />
      </main>
    </div>
  );
}
