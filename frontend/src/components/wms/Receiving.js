import { useState, useEffect, useCallback } from "react";
import { toast } from "sonner";
import { Package, Plus, Loader2, MapPin, Printer, Trash2, Factory, CheckCircle2, FileText, X } from "lucide-react";
import SearchableSelect from "../SearchableSelect";
import { useLang } from "../../contexts/LanguageContext";
import { fetcher, poster, deleter, logLoadError, SIZES_ORDER } from "./lib";
import { AsnStatus } from "./constants";

const STANDARD_UNITS_PER_BOX = 72;

export const ReceivingModule = () => {
  const { t } = useLang();
  const [records, setRecords] = useState([]);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({
    customer: '', manufacturer: '', style: '', color: '', size: '',
    description: '', country_of_origin: '', fabric_content: '',
    boxes: '', pieces: '', units: '', lot_number: '', sku: '', inv_location: '',
    is_bpo: false, asn_reference: '',
  });
  const [printMode, setPrintMode] = useState('cajas'); // 'cajas' o 'piezas'
  // boxMode: 'standard' = 72 fijos. 'custom' = unitsPerBox configurable.
  const [boxMode, setBoxMode] = useState('standard');
  const [unitsPerBox, setUnitsPerBox] = useState(STANDARD_UNITS_PER_BOX);

  const effectiveUpb = boxMode === 'standard' ? STANDARD_UNITS_PER_BOX : Math.max(1, parseInt(unitsPerBox) || 1);

  const handlePiecesChange = (val) => {
    const p = parseFloat(val) || 0;
    const b = p / effectiveUpb;
    setForm(prev => ({
      ...prev,
      pieces: val,
      boxes: val === '' ? '' : (Number.isInteger(b) ? b.toString() : b.toFixed(2)),
      units: ''
    }));
  };

  const handleBoxesChange = (val) => {
    const b = parseFloat(val) || 0;
    const p = b * effectiveUpb;
    setForm(prev => ({
      ...prev,
      boxes: val,
      pieces: val === '' ? '' : (Number.isInteger(p) ? p.toString() : p.toFixed(2)),
      units: ''
    }));
  };

  // When units_per_box changes (custom mode), recompute pieces from current boxes
  useEffect(() => {
    if (boxMode === 'custom' && form.boxes !== '') {
      const b = parseFloat(form.boxes) || 0;
      const p = b * effectiveUpb;
      setForm(prev => ({ ...prev, pieces: Number.isInteger(p) ? p.toString() : p.toFixed(2) }));
    }
  }, [effectiveUpb, boxMode]); // eslint-disable-line react-hooks/exhaustive-deps
  const [editingId, setEditingId] = useState(null);
  const [loading, setLoading] = useState(false);
  const [options, setOptions] = useState({ customers: [], manufacturers: [], styles: [], colors: [] });
  const [fieldOptions, setFieldOptions] = useState({ descriptions: [], countries: [], fabrics: [] });
  const [openAsns, setOpenAsns] = useState([]);
  const [selectedAsnLine, setSelectedAsnLine] = useState(null); // line_no within the chosen ASN

  // The full ASN doc currently selected in the form (null if the typed value
  // doesn't match any known open ASN — we only show the line picker when we
  // can resolve the ASN against what we already loaded).
  const selectedAsnDoc = openAsns.find(a => a.asn_id === form.asn_reference) || null;
  const pendingAsnLines = (selectedAsnDoc?.items || []).filter(
    it => (it.qty_received || 0) < (it.qty_expected || 0)
  );

  const pickAsnLine = (line) => {
    setSelectedAsnLine(line.line_no);
    setForm(p => ({
      ...p,
      style: line.part_number || p.style,
      description: line.description || p.description,
      country_of_origin: line.country || p.country_of_origin,
    }));
  };

  const clearAsnLine = () => {
    setSelectedAsnLine(null);
  };

  const load = useCallback(() => { fetcher('/receiving').then(setRecords).catch(logLoadError('data')); }, []);
  useEffect(() => { load(); }, [load]);

  // Load customers + field options on mount
  useEffect(() => {
    fetcher('/inventory/options?').then(data => {
      setOptions(prev => ({ ...prev, customers: data.customers || [] }));
    }).catch(logLoadError('data'));
    fetcher('/inventory/field-options').then(data => {
      setFieldOptions({ descriptions: data.descriptions || [], countries: data.countries || [], fabrics: data.fabrics || [] });
    }).catch(logLoadError('data'));
    fetcher('/asn').then(data => {
      setOpenAsns((data || []).filter(a => a.status !== AsnStatus.RECEIVED));
    }).catch(logLoadError('ASNs'));
  }, []);

  const loadOptions = useCallback(async (customer, manufacturer, style) => {
    const params = new URLSearchParams();
    if (customer) params.set('customer', customer);
    if (manufacturer) params.set('manufacturer', manufacturer);
    if (style) params.set('style', style);
    try {
      const data = await fetcher(`/inventory/options?${params.toString()}`);
      setOptions(prev => ({ ...prev, ...data }));
    } catch (err) { logLoadError('inventory options')(err); }
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

  const totalUnits = parseInt(form.pieces) || parseInt(form.units) || 0;

  const handleSubmit = async () => {
    if (!form.style) { toast.error(t('wms_style_req')); return; }
    // Required fields enforced only on CREATE; editing legacy records is allowed
    if (!editingId) {
      if (!form.country_of_origin?.trim()) { toast.error('País de origen es obligatorio'); return; }
      if (!form.fabric_content?.trim()) { toast.error('Contenido / Fabric es obligatorio'); return; }
    }
    setLoading(true);
    try {
      if (editingId) {
        // Edit Mode (Metadata only)
        const payload = {
          customer: form.customer, manufacturer: form.manufacturer, description: form.description,
          country_of_origin: form.country_of_origin, fabric_content: form.fabric_content,
          lot_number: form.lot_number, inv_location: form.inv_location
        };
        const res = await fetcher(`/receiving/${editingId}`, { method: 'PUT', body: JSON.stringify(payload) });
        toast.success(res?.message || 'Registro actualizado exitosamente');
        setShowForm(false);
        setEditingId(null);
        setForm({ customer: '', manufacturer: '', style: '', color: '', size: '', description: '', country_of_origin: '', fabric_content: '', boxes: '', pieces: '', units: '', lot_number: '', sku: '', inv_location: '', is_bpo: false, asn_reference: '' });
        setBoxMode('standard'); setUnitsPerBox(STANDARD_UNITS_PER_BOX); setSelectedAsnLine(null);
        load();
      } else {
        // Create Mode
        const totalPieces = parseInt(form.pieces) || 0;
        const totalBoxes = Math.ceil(parseFloat(form.boxes) || 0);

        const items = [];
        if (totalBoxes > 0) {
          if (boxMode === 'custom') {
            // All boxes share the same custom units_per_box, no remainder splitting
            items.push({ size: form.size, boxes: totalBoxes, units_per_box: effectiveUpb });
          } else {
            // Standard: 72-unit boxes + 1 remainder box if needed
            const fullBoxes = Math.floor(totalPieces / STANDARD_UNITS_PER_BOX);
            const remainder = totalPieces % STANDARD_UNITS_PER_BOX;
            if (fullBoxes > 0) items.push({ size: form.size, boxes: fullBoxes, units_per_box: STANDARD_UNITS_PER_BOX });
            if (remainder > 0) items.push({ size: form.size, boxes: 1, units_per_box: remainder });
          }
        }

        const payload = {
          ...form,
          units: totalPieces,
          pieces: totalPieces,
          items: items.length > 0 ? items : undefined
        };
        const res = await poster('/receiving', payload);
        if (res.ok) {
          const data = await res.json();
          toast.success(`${t('wms_rcv_created')}: ${data.total_units || totalUnits} ${t('wms_units')}`);
          // Surface ASN reconciliation warnings (warning-permissive: never blocks).
          const warns = data.asn_warnings || [];
          if (warns.length > 0) {
            const reasons = warns.map(w => {
              if (w.reason === 'asn_not_found') return `ASN no encontrado`;
              if (w.reason === 'part_not_in_asn') return `${w.part_number} no en ASN`;
              return w.reason || 'mismatch';
            });
            toast.warning(`ASN ${form.asn_reference}: ${reasons.join(', ')}`, { duration: 6000 });
          }
          if (payload.is_bpo) {
            handlePrintLabel(data);
          }
          setShowForm(false);
          setForm({ customer: '', manufacturer: '', style: '', color: '', size: '', description: '', country_of_origin: '', fabric_content: '', boxes: '', pieces: '', units: '', lot_number: '', sku: '', inv_location: '', is_bpo: false, asn_reference: '' });
          setBoxMode('standard'); setUnitsPerBox(STANDARD_UNITS_PER_BOX); setSelectedAsnLine(null);
          fetcher('/asn').then(d => setOpenAsns((d || []).filter(a => a.status !== AsnStatus.RECEIVED))).catch(() => {});
          load();
        } else { const err = await res.json().catch(() => ({})); toast.error(err.detail || 'Error'); }
      }
    } catch { toast.error(t('error_connection')); }
    finally { setLoading(false); }
  };

  const handlePrintLabel = (r) => {
    const pw = window.open('', '_blank');
    if (!pw) { toast.error(t('wms_popup_err')); return; }

    const boxes = r.boxes || [{ box_id: r.receiving_id, units: r.total_units }];

    let html = `<html><head><title>${t('wms_mod_receiving')} - ${r.receiving_id}</title>
      <style>
        @page { size: 4in 6in; margin: 5mm; }
        body { font-family: Arial, sans-serif; margin: 0; padding: 0; width: 3.6in; background: white; }
        @media print { body { padding: 0; margin: 0; } }
        .label-page { page-break-after: always; padding: 10px; height: 5.5in; box-sizing: border-box; }
        .label-page:last-child { page-break-after: auto; }
        .row { display: flex; border-bottom: 1px solid #000; }
        .cell { padding: 4px 6px; border-right: 1px solid #000; }
        .cell:last-child { border-right: none; }
        .label { font-size: 8px; text-transform: uppercase; color: #666; display: block; }
        .value { font-size: 12px; font-weight: bold; }
        .table { border: 1px solid #000; border-collapse: collapse; width: 100%; margin-top: 6px; }
      </style></head><body>`;

    boxes.forEach((box, idx) => {
      html += `
      <div class="label-page">
        <div style="text-align:center;margin-bottom:6px">
          <svg id="barcode-${idx}"></svg>
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
            <td class="cell" colspan="2" style="text-align:center"><span class="label">UNITS IN BOX</span><span class="value" style="font-size:24px;color:#000">${box.units}</span></td>
          </tr>
        </table>
        <div style="margin-top:10px;display:flex;justify-content:space-between;font-size:9px;color:#666">
          <span>${box.box_id}</span>
          <span>${idx + 1} of ${boxes.length}</span>
          <span>${r.received_by_name || ''}</span>
        </div>
      </div>`;
    });

    html += `
      <script src="https://cdn.jsdelivr.net/npm/jsbarcode@3.11.5/dist/JsBarcode.all.min.js"></script>
      <script>
        try {
          ${boxes.map((box, idx) => `
            JsBarcode("#barcode-${idx}", "${box.box_id}", {
              width: 1.5, height: 40, displayValue: true, fontSize: 10, margin: 0
            });
          `).join('\n')}
          setTimeout(function(){window.print()}, 800);
        } catch(e) {}
      </script>
    </body></html>`;

    pw.document.write(html);
    pw.document.close();
  };
  const handleEdit = async (r) => {
    setEditingId(r.receiving_id);
    setForm({
      customer: r.customer || '', manufacturer: r.manufacturer || '', style: r.style || '', color: r.color || '', size: r.size || '',
      description: r.description || '', country_of_origin: r.country_of_origin || '', fabric_content: r.fabric_content || '',
      boxes: '', pieces: r.total_units || '', units: '', lot_number: r.lot_number || '', sku: r.sku || '', inv_location: r.inv_location || '',
      is_bpo: r.is_bpo || false,
    });
    // Infer box mode from existing boxes (custom if first box's units != standard)
    try {
      const detail = await fetcher(`/receiving/${r.receiving_id}`);
      const firstBox = detail?.boxes?.[0];
      if (firstBox && firstBox.units && firstBox.units !== STANDARD_UNITS_PER_BOX) {
        setBoxMode('custom');
        setUnitsPerBox(firstBox.units);
      } else {
        setBoxMode('standard');
        setUnitsPerBox(STANDARD_UNITS_PER_BOX);
      }
    } catch (err) { logLoadError('receiving detail')(err); }
    setShowForm(true);
    // Scroll to form smoothly
    setTimeout(() => {
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }, 100);
  };

  const handleDelete = async (receivingId) => {
    if (!window.confirm(t('wms_confirm_delete_rcv') || '¿Está seguro de eliminar este registro? Se revertirá el inventario.')) return;
    try {
      await deleter(`/receiving/${receivingId}`);
      toast.success(t('wms_rcv_deleted_success') || 'Registro de receiving eliminado exitosamente');
      load();
    } catch (e) {
      toast.error('Error al eliminar el registro');
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="text-xs font-black uppercase tracking-widest text-muted-foreground bg-secondary/50 px-3 py-1 rounded-full border border-border/40">
          {t('wms_recent_entries')}: {records.length}
        </div>
        <button
          onClick={() => { setEditingId(null); setForm({ customer: '', manufacturer: '', style: '', color: '', size: '', description: '', country_of_origin: '', fabric_content: '', boxes: '', pieces: '', units: '', lot_number: '', sku: '', inv_location: '', is_bpo: false, asn_reference: '' }); setBoxMode('standard'); setUnitsPerBox(STANDARD_UNITS_PER_BOX); setSelectedAsnLine(null); setShowForm(!showForm); }}
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
              <SearchableSelect options={options.styles || []} value={form.style} onChange={handleStyleChange} placeholder={t('wms_search_style')} testId="rcv-style" disabled={!!editingId} />
            </div>
            <div>
              <label className="text-xs uppercase tracking-wider text-muted-foreground font-bold block mb-1">{t('color')}</label>
              <SearchableSelect options={options.colors || []} value={form.color} onChange={handleColorChange} placeholder={t('wms_search_color')} testId="rcv-color" disabled={!!editingId} />
            </div>
            <div>
              <label className="text-xs uppercase tracking-wider text-muted-foreground font-bold block mb-1">{t('size')}</label>
              <select value={form.size} onChange={e => setForm(p => ({ ...p, size: e.target.value }))} className="w-full px-3 py-2 bg-background border border-border rounded text-sm text-foreground disabled:opacity-50" data-testid="rcv-size" disabled={!!editingId}>
                <option value="">{t('select_placeholder')}</option>
                {SIZES_ORDER.map(s => <option key={s} value={s}>{s}</option>)}
              </select>
            </div>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
            <div>
              <label className="text-xs uppercase tracking-wider text-muted-foreground font-bold block mb-1">{t('description')}</label>
              <SearchableSelect options={fieldOptions.descriptions} value={form.description} onChange={val => setForm(p => ({ ...p, description: val }))} placeholder={t('wms_search_desc')} testId="rcv-description" allowCreate={false} />
            </div>
            <div>
              <label className="text-xs uppercase tracking-wider text-muted-foreground font-bold block mb-1">
                {t('country_of_origin')} {!editingId && <span className="text-red-500">*</span>}
              </label>
              <div className={!editingId && !form.country_of_origin?.trim() ? 'ring-1 ring-red-500/40 rounded' : ''}>
                <SearchableSelect options={fieldOptions.countries} value={form.country_of_origin} onChange={val => setForm(p => ({ ...p, country_of_origin: val }))} placeholder={t('wms_search_country')} testId="rcv-country" allowCreate={false} />
              </div>
            </div>
            <div>
              <label className="text-xs uppercase tracking-wider text-muted-foreground font-bold block mb-1">
                {t('fabric_content')} {!editingId && <span className="text-red-500">*</span>}
              </label>
              <div className={!editingId && !form.fabric_content?.trim() ? 'ring-1 ring-red-500/40 rounded' : ''}>
                <SearchableSelect options={fieldOptions.fabrics} value={form.fabric_content} onChange={val => setForm(p => ({ ...p, fabric_content: val }))} placeholder={t('wms_search_fabric')} testId="rcv-fabric" allowCreate={false} />
              </div>
            </div>
          </div>
          {/* Box capacity mode (standard 72 vs custom) */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <div className="md:col-span-2">
              <label className="text-xs text-muted-foreground mb-1 block">Tipo de Caja</label>
              <div className="flex gap-2 bg-background border border-border rounded p-1">
                <button
                  type="button"
                  onClick={() => !editingId && setBoxMode('standard')}
                  disabled={!!editingId}
                  className={`flex-1 text-xs font-bold rounded py-1 transition-all ${boxMode === 'standard' ? 'bg-primary text-primary-foreground shadow' : 'text-muted-foreground hover:bg-secondary'} ${editingId ? 'opacity-50 cursor-not-allowed' : ''}`}
                  data-testid="rcv-box-std"
                >
                  Estándar ({STANDARD_UNITS_PER_BOX} pcs)
                </button>
                <button
                  type="button"
                  onClick={() => !editingId && setBoxMode('custom')}
                  disabled={!!editingId}
                  className={`flex-1 text-xs font-bold rounded py-1 transition-all ${boxMode === 'custom' ? 'bg-primary text-primary-foreground shadow' : 'text-muted-foreground hover:bg-secondary'} ${editingId ? 'opacity-50 cursor-not-allowed' : ''}`}
                  data-testid="rcv-box-custom"
                >
                  Personalizado
                </button>
              </div>
            </div>
            <div>
              <label className="text-xs text-muted-foreground mb-1 block">Piezas por caja</label>
              <input
                type="number"
                min="1"
                value={boxMode === 'standard' ? STANDARD_UNITS_PER_BOX : unitsPerBox}
                onChange={e => setUnitsPerBox(e.target.value)}
                disabled={!!editingId || boxMode === 'standard'}
                className="w-full px-3 py-2 bg-background border border-border rounded text-sm text-foreground font-mono disabled:opacity-50 disabled:cursor-not-allowed"
                data-testid="rcv-units-per-box"
              />
            </div>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <div>
              <label className="text-xs text-muted-foreground mb-1 block">Entrada</label>
              <div className="flex gap-2 bg-background border border-border rounded p-1">
                <button
                  type="button"
                  onClick={() => !editingId && setPrintMode('cajas')}
                  disabled={!!editingId}
                  className={`flex-1 text-xs font-bold rounded py-1 transition-all ${printMode === 'cajas' ? 'bg-primary text-primary-foreground shadow' : 'text-muted-foreground hover:bg-secondary'} ${editingId ? 'opacity-50 cursor-not-allowed' : ''}`}
                >
                  Por Cajas
                </button>
                <button
                  type="button"
                  onClick={() => !editingId && setPrintMode('piezas')}
                  disabled={!!editingId}
                  className={`flex-1 text-xs font-bold rounded py-1 transition-all ${printMode === 'piezas' ? 'bg-primary text-primary-foreground shadow' : 'text-muted-foreground hover:bg-secondary'} ${editingId ? 'opacity-50 cursor-not-allowed' : ''}`}
                >
                  Por Piezas
                </button>
              </div>
            </div>
            <div>
              <label className="text-xs text-muted-foreground mb-1 block">Cajas (1 = {effectiveUpb} Pcs)</label>
              <input type="number" placeholder="0" value={form.boxes} onChange={e => handleBoxesChange(e.target.value)} disabled={!!editingId || printMode === 'piezas'} className="w-full px-3 py-2 bg-background border border-border rounded text-sm text-foreground disabled:opacity-50 disabled:cursor-not-allowed" />
            </div>
            <div>
              <label className="text-xs text-muted-foreground mb-1 block">Total Piezas</label>
              <input type="number" placeholder="0" value={form.pieces} onChange={e => handlePiecesChange(e.target.value)} disabled={!!editingId || printMode === 'cajas'} className="w-full px-3 py-2 bg-background border border-border rounded text-sm text-foreground disabled:opacity-50 disabled:cursor-not-allowed" />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs text-muted-foreground mb-1 block">{t('wms_qty_auto')}</label>
              <input type="number" value={totalUnits} readOnly className="w-full px-3 py-2 bg-background border border-border rounded text-sm text-foreground font-bold" />
            </div>
            <div>
              <label className="text-xs text-muted-foreground mb-1 block">{t('sku')} (auto)</label>
              <input value={form.sku} readOnly className="w-full px-3 py-2 bg-secondary/50 border border-border rounded text-sm text-foreground font-mono cursor-not-allowed" />
            </div>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <div>
              <label className="text-xs uppercase tracking-wider text-muted-foreground font-bold block mb-1">{t('wms_location') || 'Ubicación'}</label>
              <input placeholder={t('wms_location_placeholder')} value={form.inv_location} onChange={e => setForm(p => ({ ...p, inv_location: e.target.value.toUpperCase() }))} className="w-full px-3 py-2 bg-background border border-border rounded text-sm text-foreground font-mono" data-testid="rcv-location" />
            </div>
            <div className="md:col-span-2">
              <label className="text-xs uppercase tracking-wider text-muted-foreground font-bold block mb-1">ASN (Packing List)</label>
              <input
                list="rcv-asn-list"
                placeholder="N° de ASN (opcional)"
                value={form.asn_reference}
                onChange={e => { setForm(p => ({ ...p, asn_reference: e.target.value.trim() })); setSelectedAsnLine(null); }}
                className="w-full px-3 py-2 bg-background border border-border rounded text-sm text-foreground font-mono"
                data-testid="rcv-asn"
                disabled={!!editingId}
              />
              <datalist id="rcv-asn-list">
                {openAsns.map(a => (
                  <option key={a.asn_id} value={a.asn_id}>{`${a.vendor || ''} · ${a.items?.length || 0} líneas · ${a.status}`}</option>
                ))}
              </datalist>
              {/* Line picker — opcional. Si el operador ignora esto, sigue funcionando tecleando el style manualmente. */}
              {selectedAsnDoc && !editingId && (
                <div className="mt-2 border border-border/40 bg-background/40 rounded-xl overflow-hidden">
                  <div className="flex items-center justify-between px-3 py-2 bg-secondary/30 border-b border-border/20">
                    <div className="flex items-center gap-2">
                      <FileText className="w-3.5 h-3.5 text-indigo-400" />
                      <span className="text-[10px] font-black uppercase tracking-widest text-muted-foreground">
                        Líneas pendientes ({pendingAsnLines.length}) — opcional, click para autollenar
                      </span>
                    </div>
                    {selectedAsnLine != null && (
                      <button
                        type="button"
                        onClick={clearAsnLine}
                        className="flex items-center gap-1 text-[10px] font-bold uppercase text-muted-foreground hover:text-foreground"
                      >
                        <X className="w-3 h-3" /> Limpiar
                      </button>
                    )}
                  </div>
                  {pendingAsnLines.length === 0 ? (
                    <div className="px-3 py-3 text-[11px] text-muted-foreground italic">
                      Este ASN ya no tiene líneas pendientes — puedes recibir manualmente sin matchear.
                    </div>
                  ) : (
                    <div className="max-h-44 overflow-y-auto custom-scrollbar divide-y divide-border/10">
                      {pendingAsnLines.map(line => {
                        const remaining = (line.qty_expected || 0) - (line.qty_received || 0);
                        const isSel = selectedAsnLine === line.line_no;
                        return (
                          <button
                            key={line.line_no}
                            type="button"
                            onClick={() => pickAsnLine(line)}
                            className={`w-full text-left px-3 py-2 flex items-start gap-2 transition-all ${isSel ? 'bg-primary/10' : 'hover:bg-secondary/30'}`}
                          >
                            <div className={`mt-0.5 w-4 h-4 rounded-full border flex items-center justify-center flex-shrink-0 ${isSel ? 'border-primary bg-primary text-primary-foreground' : 'border-border'}`}>
                              {isSel && <CheckCircle2 className="w-3 h-3" />}
                            </div>
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center gap-2 text-xs">
                                <span className="font-mono font-black text-primary">{line.part_number}</span>
                                {line.country && <span className="text-[10px] font-bold uppercase text-muted-foreground bg-secondary/50 px-1.5 py-0.5 rounded">{line.country}</span>}
                                {line.brand && <span className="text-[10px] font-bold uppercase text-muted-foreground">{line.brand}</span>}
                              </div>
                              {line.description && (
                                <div className="text-[10px] text-muted-foreground truncate mt-0.5" title={line.description}>
                                  {line.description}
                                </div>
                              )}
                            </div>
                            <div className="text-right flex-shrink-0">
                              <div className="text-xs font-black tabular-nums">{remaining.toLocaleString()}</div>
                              <div className="text-[9px] uppercase tracking-widest text-muted-foreground font-bold">pendientes</div>
                            </div>
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
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
              {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Package className="w-4 h-4" />} {editingId ? 'Actualizar Detalles' : t('wms_receive_btn')}
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
                    onClick={() => handleEdit(r)}
                    className="p-2.5 text-muted-foreground hover:text-amber-500 rounded-xl hover:bg-amber-500/10 transition-all shadow-none hover:shadow-lg shadow-amber-500/20"
                    title="Editar Detalles"
                  >
                    <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path></svg>
                  </button>
                  <button
                    onClick={() => handlePrintLabel(r)}
                    className="p-2.5 text-muted-foreground hover:text-primary rounded-xl hover:bg-primary/10 transition-all shadow-none hover:shadow-lg shadow-primary/20"
                    title="Imprimir etiqueta"
                    data-testid={`rcv-print-${r.receiving_id}`}
                  >
                    <Printer className="w-5 h-5" />
                  </button>
                  <button
                    onClick={() => handleDelete(r.receiving_id)}
                    className="p-2.5 text-muted-foreground hover:text-destructive rounded-xl hover:bg-destructive/10 transition-all"
                    title="Eliminar registro"
                    data-testid={`rcv-delete-${r.receiving_id}`}
                  >
                    <Trash2 className="w-5 h-5" />
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
