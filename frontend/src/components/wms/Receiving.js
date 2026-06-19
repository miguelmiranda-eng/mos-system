import { useState, useEffect, useCallback, useRef } from "react";
import { toast } from "sonner";
import { Package, Plus, Loader2, MapPin, Printer, Trash2, Factory, CheckCircle2, FileText, X, ChevronDown, Truck, Pencil } from "lucide-react";
import SearchableSelect from "../SearchableSelect";
import { useLang } from "../../contexts/LanguageContext";
import { fetcher, poster, putter, deleter, logLoadError, SIZES_ORDER, API, cleanScan } from "./lib";
import { AsnStatus } from "./constants";

const STANDARD_UNITS_PER_BOX = 72;

// ISO3 country code -> list of likely full-name variants found in dropdowns.
// Order matters: first hit in the actual dropdown wins. Add codes as needed.
const COUNTRY_ISO3 = Object.freeze({
  DOM: ['REPUBLICA DOMINICANA', 'REPÚBLICA DOMINICANA', 'DOMINICAN REPUBLIC', 'REP. DOMINICANA'],
  NIC: ['NICARAGUA'],
  HTI: ['HAITI', 'HAITÍ'],
  HAI: ['HAITI', 'HAITÍ'],
  MEX: ['MEXICO', 'MÉXICO'],
  USA: ['ESTADOS UNIDOS', 'UNITED STATES', 'EE.UU.', 'EEUU'],
  GTM: ['GUATEMALA'],
  HND: ['HONDURAS'],
  SLV: ['EL SALVADOR'],
  CRI: ['COSTA RICA'],
  PAN: ['PANAMA', 'PANAMÁ'],
  COL: ['COLOMBIA'],
  PER: ['PERU', 'PERÚ'],
  ECU: ['ECUADOR'],
  CHN: ['CHINA'],
  IND: ['INDIA'],
  BGD: ['BANGLADESH'],
  VNM: ['VIETNAM'],
  PAK: ['PAKISTAN', 'PAKISTÁN'],
  IDN: ['INDONESIA'],
  KHM: ['CAMBOYA', 'CAMBODIA'],
  TUR: ['TURQUIA', 'TURQUÍA', 'TURKEY'],
});

// Find the best match for `needle` inside `haystack` (string[]).
// Strategy: ISO3 country lookup (if opts.iso3 supplied and needle is 3 letters)
// -> exact case-insensitive -> haystack item contains needle ->
// needle contains haystack item (with min length safeguard).
// Returns the original-cased haystack item, or empty string when no match.
const findInOptions = (needle, haystack = [], opts = {}) => {
  if (!needle || !Array.isArray(haystack) || haystack.length === 0) return '';
  const n = String(needle).trim().toUpperCase();
  if (!n) return '';

  // 1. ISO3 country code: try each known full-name variant
  if (opts.iso3 && n.length === 3 && opts.iso3[n]) {
    for (const cand of opts.iso3[n]) {
      const c = cand.toUpperCase();
      const found = haystack.find(h => String(h).toUpperCase() === c);
      if (found) return found;
    }
    for (const cand of opts.iso3[n]) {
      const c = cand.toUpperCase();
      const found = haystack.find(h => {
        const hu = String(h).toUpperCase();
        return hu.includes(c) || c.includes(hu);
      });
      if (found) return found;
    }
  }

  // 2. Exact (case-insensitive)
  const exact = haystack.find(h => String(h).toUpperCase() === n);
  if (exact) return exact;

  // 3. Haystack item contains needle
  const contains = haystack.find(h => String(h).toUpperCase().includes(n));
  if (contains) return contains;

  // 4. Needle contains haystack item (when haystack item is at least 4 chars
  //    to avoid spurious matches on short abbreviations)
  const reverse = haystack.find(h => {
    const hu = String(h).toUpperCase();
    return hu.length >= 4 && n.includes(hu);
  });
  if (reverse) return reverse;

  // 5. Token overlap — last resort for free-form text like descriptions.
  //    Tokenize both, require >= 50% of needle's non-trivial tokens to be in
  //    the candidate. Pick the candidate with the most overlap.
  const STOP = new Set(['DE', 'DEL', 'LA', 'EL', 'PARA', 'CON', 'Y', 'O', 'A', 'EN', 'POR']);
  const tokenize = (s) => String(s).toUpperCase().split(/[^A-Z0-9%]+/).filter(t => t.length >= 2 && !STOP.has(t));
  const needleTokens = tokenize(n);
  if (needleTokens.length >= 3) {
    let bestItem = '', bestScore = 0;
    for (const h of haystack) {
      const hTokens = new Set(tokenize(h));
      const overlap = needleTokens.filter(t => hTokens.has(t)).length;
      if (overlap > bestScore) { bestScore = overlap; bestItem = h; }
    }
    if (bestScore >= Math.ceil(needleTokens.length * 0.5)) return bestItem;
  }

  return '';
};

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
  // UPC catalog state. `upcDoc` is the resolved entry from wms_upc_catalog;
  // when set, the product fields (style/color/size/desc/country/fabric/brand)
  // become read-only because the catalog is the source of truth.
  const [upc, setUpc] = useState('');
  const [upcDoc, setUpcDoc] = useState(null);
  const [upcLooking, setUpcLooking] = useState(false);
  const [createUpcOpen, setCreateUpcOpen] = useState(false);
  const [creatingUpc, setCreatingUpc] = useState(false);
  const [upcEditMode, setUpcEditMode] = useState(false);
  // Edit/Delete of catalog UPCs is admin-only (backend require_admin), so only
  // surface those buttons for admin/supersu/ceo.
  const [canManageUpc, setCanManageUpc] = useState(false);
  useEffect(() => {
    fetch(`${process.env.REACT_APP_BACKEND_URL}/api/auth/me`, { credentials: 'include' })
      .then(r => r.ok ? r.json() : null)
      .then(u => setCanManageUpc(['admin', 'supersu', 'ceo'].includes(u?.role)))
      .catch(() => {});
  }, []);
  const [upcDraft, setUpcDraft] = useState({
    upc: '', customer: '', manufacturer: '', style: '', color: '', size: '',
    description: '', country_of_origin: '', fabric_content: '', brand: '',
  });
  // Inline ASN creation — used when the operator wants to receive material
  // for an ASN that wasn't pre-imported via Excel.
  const [createAsnOpen, setCreateAsnOpen] = useState(false);
  const [creatingAsn, setCreatingAsn] = useState(false);
  const [asnDraft, setAsnDraft] = useState({
    asn_id: '', vendor: '', po_number: '',
    items: [{ part_number: '', description: '', qty_expected: '', country: '', brand: '' }],
  });
  // Putaway 2.0: 5 carts + legacy transit slot. Loaded from /transit/info so
  // the names stay in sync with the backend.
  const [transitCarts, setTransitCarts] = useState([]);
  const [showCartMenu, setShowCartMenu] = useState(false);
  const cartMenuRef = useRef(null);

  // The full ASN doc currently selected in the form (null if the typed value
  // doesn't match any known open ASN — we only show the line picker when we
  // can resolve the ASN against what we already loaded).
  const selectedAsnDoc = openAsns.find(a => a.asn_id === form.asn_reference) || null;
  // Show every ASN line while the ASN is still open (not closed) — even lines
  // already fully received — so the operator can keep matching against them and
  // capture discrepancies in BOTH directions (faltante y sobrante). Lines only
  // disappear once the ASN is closed.
  const pendingAsnLines = (selectedAsnDoc && !selectedAsnDoc.closed)
    ? (selectedAsnDoc.items || [])
    : [];

  // Smart autofill from ASN line. STRICT: every field — including Style —
  // only fills when the ASN value resolves to an entry that already exists
  // in the operator's dropdown. No-match leaves the field empty so it never
  // ends up in the inventory record as a foreign string.
  //
  // Customer / manufacturer / style are cascading: a manufacturer only
  // appears under its customer, and a style only under its customer +
  // manufacturer. So we refetch the cascade after each level resolves,
  // and run the next match against the freshly-loaded list.
  const pickAsnLine = async (line) => {
    setSelectedAsnLine(line.line_no);

    const updates = {};
    const matched = [];
    const skipped = [];

    const country = findInOptions(line.country, fieldOptions.countries, { iso3: COUNTRY_ISO3 });
    if (country) { updates.country_of_origin = country; matched.push('País'); }
    else if (line.country) skipped.push('País');

    const description = findInOptions(line.description, fieldOptions.descriptions);
    if (description) { updates.description = description; matched.push('Descripción'); }
    else if (line.description) skipped.push('Descripción');

    const fabric = findInOptions(line.fabric_content, fieldOptions.fabrics);
    if (fabric) { updates.fabric_content = fabric; matched.push('Tela'); }
    else if (line.fabric_content) skipped.push('Tela');

    // Customer first (top of the cascade)
    const customer = findInOptions(selectedAsnDoc?.customer, options.customers);
    if (customer) { updates.customer = customer; matched.push('Cliente'); }
    else if (selectedAsnDoc?.customer) skipped.push('Cliente');

    const effectiveCustomer = customer || form.customer;
    let manufacturerHaystack = options.manufacturers || [];
    let stylesHaystack = options.styles || [];
    if (effectiveCustomer) {
      try {
        const data = await fetcher(`/inventory/options?customer=${encodeURIComponent(effectiveCustomer)}`);
        setOptions(prev => ({ ...prev, ...data }));
        manufacturerHaystack = data.manufacturers || manufacturerHaystack;
        stylesHaystack = data.styles || stylesHaystack;
      } catch (err) { /* keep previous haystacks */ }
    }

    const manufacturer = findInOptions(line.brand, manufacturerHaystack);
    if (manufacturer) { updates.manufacturer = manufacturer; matched.push('Fabricante'); }
    else if (line.brand) skipped.push('Fabricante');

    // Refetch styles for the customer + manufacturer combo, then match Style
    const effectiveManufacturer = manufacturer || form.manufacturer;
    if (effectiveCustomer && effectiveManufacturer) {
      try {
        const data2 = await fetcher(
          `/inventory/options?customer=${encodeURIComponent(effectiveCustomer)}&manufacturer=${encodeURIComponent(effectiveManufacturer)}`
        );
        setOptions(prev => ({ ...prev, ...data2 }));
        stylesHaystack = data2.styles || stylesHaystack;
      } catch (err) { /* keep previous haystack */ }
    }
    const style = findInOptions(line.part_number, stylesHaystack);
    if (style) { updates.style = style; matched.push('Style'); }
    else if (line.part_number) skipped.push('Style');

    setForm(p => ({ ...p, ...updates }));

    if (matched.length || skipped.length) {
      const parts = [];
      if (matched.length) parts.push(`✓ ${matched.join(', ')}`);
      if (skipped.length) parts.push(`sin match en dropdown: ${skipped.join(', ')}`);
      if (skipped.length) toast.warning(parts.join(' · '), { duration: 5000 });
      else toast.success(parts.join(' · '), { duration: 3000 });
    }
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
    fetcher('/transit/info').then(data => {
      setTransitCarts(Array.isArray(data?.carts) ? data.carts : []);
    }).catch(logLoadError('transit info'));
  }, []);

  // Close the "Recibir a Carro" dropdown on outside click.
  useEffect(() => {
    if (!showCartMenu) return;
    const onDoc = (e) => {
      if (!cartMenuRef.current?.contains(e.target)) setShowCartMenu(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [showCartMenu]);

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

  // Canonical transit location name. Mirrors backend TRANSIT_LOCATION_NAME.
  const TRANSIT_LOCATION = "UBICACION TEMPORAL";

  // Debounced UPC lookup. When the operator finishes typing (300ms idle), we
  // hit /upc/{code} — on hit, autofill every product field and lock them so
  // two operators capturing the same UPC can't write conflicting metadata.
  // On miss (404), clear upcDoc so the "+ Crear UPC" button surfaces.
  // Any other non-2xx (401/403/5xx) surfaces a toast + console.log so we don't
  // silently fall back to "sin catálogo" when the real cause is auth or net.
  useEffect(() => {
    const code = cleanScan(upc);
    if (!code) { setUpcDoc(null); return; }
    setUpcLooking(true);
    const handle = setTimeout(async () => {
      const url = `${API}/upc/${encodeURIComponent(code)}`;
      console.log('[UPC lookup] →', url);
      try {
        const res = await fetch(url, { credentials: 'include' });
        console.log('[UPC lookup] ←', res.status, res.url);
        if (res.status === 401 || res.status === 403) {
          toast.error('Sesión expirada. Cierra sesión y vuelve a entrar.');
          setUpcDoc(null);
          return;
        }
        if (res.status === 404) {
          setUpcDoc(null);
          return;
        }
        if (!res.ok) {
          const txt = await res.text();
          console.error('[UPC lookup] error body:', txt);
          toast.error(`UPC lookup error ${res.status} — ver consola`);
          setUpcDoc(null);
          return;
        }
        const doc = await res.json();
        console.log('[UPC lookup] doc:', doc);
        if (!doc || !doc.upc) {
          toast.error('UPC respuesta vacía — ver consola');
          setUpcDoc(null);
          return;
        }
        setUpcDoc(doc);
        // Autofill — preserve numeric/operational fields the operator types.
        setForm(p => ({
          ...p,
          customer: doc.customer || p.customer,
          manufacturer: doc.manufacturer || p.manufacturer,
          style: doc.style || p.style,
          color: doc.color || p.color,
          size: doc.size || p.size,
          description: doc.description || p.description,
          country_of_origin: doc.country_of_origin || p.country_of_origin,
          fabric_content: doc.fabric_content || p.fabric_content,
          sku: doc.sku || p.sku,
        }));
      } catch (err) {
        console.error('[UPC lookup] exception:', err);
        toast.error(`UPC lookup falló: ${err?.message || err}`);
      } finally { setUpcLooking(false); }
    }, 300);
    return () => clearTimeout(handle);
  }, [upc]);

  // Open the "Crear UPC" mini-modal. Prefills with whatever the operator has
  // already captured in the receiving form so they don't retype it.
  const openCreateUpc = () => {
    setUpcDraft({
      upc: upc.trim().toUpperCase(),
      customer: form.customer || '',
      manufacturer: form.manufacturer || '',
      style: form.style || '',
      color: form.color || '',
      size: form.size || '',
      description: form.description || '',
      country_of_origin: form.country_of_origin || '',
      fabric_content: form.fabric_content || '',
      brand: '',
    });
    setUpcEditMode(false);
    setCreateUpcOpen(true);
  };

  // Open the modal pre-filled with the resolved UPC for editing (admin only).
  const openEditUpc = () => {
    if (!upcDoc) return;
    setUpcDraft({
      upc: upcDoc.upc || '',
      customer: upcDoc.customer || '',
      manufacturer: upcDoc.manufacturer || '',
      style: upcDoc.style || '',
      color: upcDoc.color || '',
      size: upcDoc.size || '',
      description: upcDoc.description || '',
      country_of_origin: upcDoc.country_of_origin || '',
      fabric_content: upcDoc.fabric_content || '',
      brand: upcDoc.brand || '',
    });
    setUpcEditMode(true);
    setCreateUpcOpen(true);
  };

  const handleDeleteUpc = async () => {
    if (!upcDoc) return;
    if (!window.confirm(`¿Eliminar el UPC ${upcDoc.upc} del catálogo? Los recibos ya hechos NO se afectan.`)) return;
    try {
      await deleter(`/upc/${encodeURIComponent(upcDoc.upc)}`);
      toast.success(`UPC ${upcDoc.upc} eliminado del catálogo`);
      setUpcDoc(null);
      setUpc('');
    } catch {
      toast.error('No se pudo eliminar (¿permisos de admin?)');
    }
  };

  const handleSaveUpc = async () => {
    const code = upcDraft.upc.trim().toUpperCase();
    if (!code) { toast.error('Captura el UPC'); return; }
    if (!upcDraft.style?.trim()) { toast.error('Style es obligatorio'); return; }
    setCreatingUpc(true);
    try {
      const res = upcEditMode
        ? await putter(`/upc/${encodeURIComponent(code)}`, { ...upcDraft, upc: code })
        : await poster('/upc', { ...upcDraft, upc: code });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        toast.error(err.detail || (upcEditMode ? 'No se pudo actualizar el UPC' : 'No se pudo crear el UPC'));
        return;
      }
      const doc = await res.json();
      toast.success(`UPC ${doc.upc} ${upcEditMode ? 'actualizado' : 'guardado'} en catálogo`);
      setUpcDoc(doc);
      setUpc(doc.upc);
      // Aplicar valores del catálogo al form para reflejar el lock visual.
      setForm(p => ({
        ...p,
        customer: doc.customer || p.customer,
        manufacturer: doc.manufacturer || p.manufacturer,
        style: doc.style || p.style,
        color: doc.color || p.color,
        size: doc.size || p.size,
        description: doc.description || p.description,
        country_of_origin: doc.country_of_origin || p.country_of_origin,
        fabric_content: doc.fabric_content || p.fabric_content,
      }));
      setCreateUpcOpen(false);
      setUpcEditMode(false);
    } catch {
      toast.error('Error de conexión');
    } finally { setCreatingUpc(false); }
  };

  // Open the inline ASN creator. Prefills asn_id with whatever the operator
  // already typed in the ASN field so they don't have to retype it. Vendor
  // falls back to the customer they picked.
  const openCreateAsn = () => {
    setAsnDraft({
      asn_id: form.asn_reference?.trim() || '',
      vendor: form.customer || '',
      po_number: '',
      items: [{
        part_number: form.style || '',
        description: form.description || '',
        qty_expected: form.pieces || form.units || '',
        country: form.country_of_origin || '',
        brand: form.manufacturer || '',
      }],
    });
    setCreateAsnOpen(true);
  };

  const updateAsnDraftItem = (idx, field, value) => {
    setAsnDraft(p => {
      const items = p.items.slice();
      items[idx] = { ...items[idx], [field]: value };
      return { ...p, items };
    });
  };

  const addAsnDraftItem = () => {
    setAsnDraft(p => ({
      ...p,
      items: [...p.items, { part_number: '', description: '', qty_expected: '', country: '', brand: '' }],
    }));
  };

  const removeAsnDraftItem = (idx) => {
    setAsnDraft(p => ({
      ...p,
      items: p.items.length > 1 ? p.items.filter((_, i) => i !== idx) : p.items,
    }));
  };

  const handleCreateAsn = async () => {
    const asnId = asnDraft.asn_id.trim();
    if (!asnId) { toast.error('Captura el número de ASN'); return; }
    const cleanItems = asnDraft.items
      .map(it => ({
        part_number: (it.part_number || '').trim().toUpperCase(),
        description: (it.description || '').trim(),
        qty_expected: parseInt(it.qty_expected) || 0,
        country: (it.country || '').trim().toUpperCase(),
        brand: (it.brand || '').trim().toUpperCase(),
      }))
      .filter(it => it.part_number && it.qty_expected > 0);
    if (cleanItems.length === 0) {
      toast.error('Captura al menos una línea con Part Number y Cantidad esperada');
      return;
    }
    setCreatingAsn(true);
    try {
      const res = await poster('/asn', {
        asn_id: asnId,
        vendor: asnDraft.vendor.trim().toUpperCase(),
        po_number: asnDraft.po_number.trim(),
        items: cleanItems,
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        toast.error(err.detail || 'No se pudo crear el ASN');
        return;
      }
      const newAsn = await res.json();
      toast.success(`ASN ${newAsn.asn_id} creado · ${cleanItems.length} línea(s)`);
      // Refresh openAsns + auto-seleccionar el nuevo.
      const all = await fetcher('/asn');
      setOpenAsns((all || []).filter(a => a.status !== AsnStatus.RECEIVED));
      setForm(p => ({ ...p, asn_reference: newAsn.asn_id }));
      setCreateAsnOpen(false);
    } catch (err) {
      toast.error('Error de conexión');
    } finally { setCreatingAsn(false); }
  };

  // `toLocation` (when set) overrides whatever inv_location the user typed and
  // forces the box into a specific Putaway 2.0 slot — one of the 5 carts, or
  // the legacy UBICACION TEMPORAL. Used by the "Recibir a Carro" dropdown.
  const handleSubmit = async (opts = {}) => {
    const toLocation = opts.toLocation || (opts.toTransit ? TRANSIT_LOCATION : null);
    if (!form.style) { toast.error(t('wms_style_req')); return; }
    // Required fields enforced only on CREATE; editing legacy records is allowed
    if (!editingId) {
      // UPC opcional — advertencia si falta o no está en catálogo, pero no bloquea.
      if (!upc.trim()) {
        toast.warning('Sin UPC — el recibo se guardará sin referencia de catálogo', { duration: 4000 });
      } else if (!upcDoc) {
        toast.warning(`UPC ${upc.trim().toUpperCase()} no está en catálogo — el recibo se guardará de todas formas`, { duration: 4000 });
      }
      if (!form.country_of_origin?.trim()) { toast.error('País de origen es obligatorio'); return; }
      if (!form.fabric_content?.trim()) { toast.error('Contenido / Fabric es obligatorio'); return; }
      // ASN obligatorio: no se puede recibir material sin un ASN cargado.
      if (!form.asn_reference?.trim()) {
        toast.error('ASN obligatorio — captura el número de packing list o créalo primero');
        return;
      }
      if (!selectedAsnDoc) {
        toast.error(`ASN ${form.asn_reference} no existe. Créalo con el botón "+ Crear ASN".`);
        return;
      }
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

        // Split into full boxes of `effectiveUpb` (72 standard, or the custom
        // per-box count) plus a single partial box for the remainder. Applies to
        // BOTH modes: custom used to skip the split, mislabeling the last partial
        // box with the full per-box count (e.g. 72) and inflating the box total.
        const items = [];
        const upb = effectiveUpb;
        if (totalPieces > 0 && upb > 0) {
          const fullBoxes = Math.floor(totalPieces / upb);
          const remainder = totalPieces % upb;
          if (fullBoxes > 0) items.push({ size: form.size, boxes: fullBoxes, units_per_box: upb });
          if (remainder > 0) items.push({ size: form.size, boxes: 1, units_per_box: remainder });
        }

        const payload = {
          ...form,
          units: totalPieces,
          pieces: totalPieces,
          items: items.length > 0 ? items : undefined,
          asn_line_no: selectedAsnLine,  // optional — when set, backend decrements that exact line
          upc: upcDoc?.upc || '',  // catalog reference — empty only on legacy edits
          // "Recibir a Carro" wins over whatever was typed in inv_location.
          ...(toLocation ? { inv_location: toLocation } : {}),
        };
        const res = await poster('/receiving', payload);
        if (res.ok) {
          const data = await res.json();
          const baseMsg = `${t('wms_rcv_created')}: ${data.total_units || totalUnits} ${t('wms_units')}`;
          toast.success(toLocation ? `${baseMsg} → ${toLocation}` : baseMsg);
          // Surface ASN reconciliation warnings (warning-permissive: never blocks).
          const warns = data.asn_warnings || [];
          if (warns.length > 0) {
            const reasons = warns.map(w => {
              if (w.reason === 'asn_not_found') return `ASN no encontrado`;
              if (w.reason === 'part_not_in_asn') return `${w.part_number} no en ASN`;
              if (w.reason === 'line_not_in_asn') return `Línea ${w.line_no} ya no existe en el ASN`;
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
          setUpc(''); setUpcDoc(null);
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
          ${r.upc ? `<tr class="row"><td class="cell" colspan="2" style="text-align:center"><span class="label">UPC</span><span class="value" style="font-family:monospace;font-size:15px">${r.upc}</span></td></tr>` : ''}
        </table>
        ${r.upc ? `<div style="text-align:center;margin-top:8px"><svg id="upcbar-${idx}"></svg></div>` : ''}
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
            ${r.upc ? `JsBarcode("#upcbar-${idx}", "${r.upc}", { width: 1.4, height: 34, displayValue: true, fontSize: 10, margin: 0 });` : ''}
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
          onClick={() => { setEditingId(null); setForm({ customer: '', manufacturer: '', style: '', color: '', size: '', description: '', country_of_origin: '', fabric_content: '', boxes: '', pieces: '', units: '', lot_number: '', sku: '', inv_location: '', is_bpo: false, asn_reference: '' }); setBoxMode('standard'); setUnitsPerBox(STANDARD_UNITS_PER_BOX); setSelectedAsnLine(null); setUpc(''); setUpcDoc(null); setShowForm(!showForm); }}
          className="px-4 py-2 bg-primary text-black rounded-xl font-bold uppercase tracking-wider text-xs transition-all hover:scale-105 shadow-[0_0_15px_rgba(255,193,7,0.3)] flex items-center gap-2"
          data-testid="new-receiving-btn"
        >
          <Plus className="w-4 h-4" /> {t('wms_new_record')}
        </button>
      </div>
      {showForm && (
        <div className="border border-border rounded-lg p-4 bg-secondary/30 space-y-3" data-testid="receiving-form">
          {/* UPC — captura primero. Master del catálogo de producto */}
          {!editingId && (
            <div className="p-3 rounded-lg bg-indigo-500/5 border border-indigo-500/20">
              <label className="text-xs uppercase tracking-wider font-bold block mb-1 flex items-center gap-2">
                <span className="text-indigo-400">UPC</span>
                <span className="text-[9px] font-black uppercase tracking-widest text-muted-foreground bg-secondary/60 border border-border/40 px-1.5 py-0.5 rounded">Opcional</span>
                {upcDoc && (
                  <span className="text-[9px] font-black uppercase tracking-widest text-emerald-500 bg-emerald-500/10 border border-emerald-500/30 px-1.5 py-0.5 rounded flex items-center gap-1">
                    <CheckCircle2 className="w-2.5 h-2.5" /> en catálogo
                  </span>
                )}
                {upc.trim() && !upcDoc && !upcLooking && (
                  <span className="text-[9px] font-black uppercase tracking-widest text-amber-500 bg-amber-500/10 border border-amber-500/30 px-1.5 py-0.5 rounded">
                    sin catálogo
                  </span>
                )}
              </label>
              <div className="flex gap-2">
                <input
                  value={upc}
                  onChange={e => setUpc(e.target.value)}
                  placeholder="Escanea o teclea el UPC (opcional)"
                  className={`flex-1 px-3 py-2 bg-background border rounded text-sm font-mono font-bold ${
                    upcDoc ? 'border-emerald-500/40' : upc.trim() ? 'border-amber-500/40' : 'border-border'
                  }`}
                  data-testid="rcv-upc"
                  autoFocus
                />
                {upcLooking && (
                  <span className="flex items-center px-3 text-muted-foreground">
                    <Loader2 className="w-4 h-4 animate-spin" />
                  </span>
                )}
                {upc.trim() && !upcDoc && !upcLooking && (
                  <button
                    type="button"
                    onClick={openCreateUpc}
                    className="px-3 py-2 bg-indigo-500 hover:bg-indigo-400 text-white rounded text-xs font-black uppercase tracking-widest flex items-center gap-1.5 whitespace-nowrap transition-all"
                    title={`Crear UPC ${upc.trim().toUpperCase()} en el catálogo`}
                    data-testid="rcv-upc-create"
                  >
                    <Plus className="w-3.5 h-3.5" /> Crear UPC
                  </button>
                )}
                {upcDoc && canManageUpc && (
                  <>
                    <button
                      type="button"
                      onClick={openEditUpc}
                      className="px-3 py-2 bg-amber-500/15 hover:bg-amber-500/25 text-amber-500 rounded text-xs font-bold uppercase tracking-widest flex items-center gap-1.5"
                      title="Editar UPC del catálogo"
                      data-testid="rcv-upc-edit"
                    >
                      <Pencil className="w-3.5 h-3.5" />
                    </button>
                    <button
                      type="button"
                      onClick={handleDeleteUpc}
                      className="px-3 py-2 bg-red-500/15 hover:bg-red-500/25 text-red-500 rounded text-xs font-bold uppercase tracking-widest flex items-center gap-1.5"
                      title="Eliminar UPC del catálogo"
                      data-testid="rcv-upc-delete"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </>
                )}
                {upcDoc && (
                  <button
                    type="button"
                    onClick={() => { setUpc(''); setUpcDoc(null); }}
                    className="px-3 py-2 bg-secondary hover:bg-secondary/70 text-foreground rounded text-xs font-bold uppercase tracking-widest flex items-center gap-1.5"
                    title="Limpiar UPC y desbloquear campos"
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>
              {upcDoc && (
                <p className="text-[10px] text-emerald-500 mt-1.5 font-mono">
                  {upcDoc.style} · {upcDoc.color} · {upcDoc.size} — {upcDoc.description?.slice(0, 60) || '—'}
                </p>
              )}
              {upc.trim() && !upcDoc && !upcLooking && (
                <p className="text-[10px] text-amber-500 mt-1.5">
                  ⚠ UPC <span className="font-mono font-bold">{upc.trim().toUpperCase()}</span> no está en catálogo — puedes recibirlo sin UPC o crearlo primero.
                </p>
              )}
            </div>
          )}

          <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
            <div>
              <label className="text-xs uppercase tracking-wider text-muted-foreground font-bold block mb-1">
                {t('customer')} {!!upcDoc?.customer && <span className="text-emerald-500 text-[9px]" title="Bloqueado por UPC">🔒</span>}
              </label>
              <SearchableSelect options={options.customers || []} value={form.customer} onChange={handleCustomerChange} placeholder={t('wms_search_customer')} testId="rcv-customer" disabled={!!upcDoc?.customer} allowCreate={canManageUpc} />
            </div>
            <div>
              <label className="text-xs uppercase tracking-wider text-muted-foreground font-bold block mb-1">
                {t('manufacturer')} {!!upcDoc?.manufacturer && <span className="text-emerald-500 text-[9px]" title="Bloqueado por UPC">🔒</span>}
              </label>
              <SearchableSelect options={options.manufacturers || []} value={form.manufacturer} onChange={handleManufacturerChange} placeholder={t('wms_search_manufacturer')} testId="rcv-manufacturer" disabled={!!upcDoc?.manufacturer} />
            </div>
            <div>
              <label className="text-xs uppercase tracking-wider text-muted-foreground font-bold block mb-1">{t('wms_lot')}</label>
              <input placeholder={t('wms_lot')} value={form.lot_number} onChange={e => setForm(p => ({ ...p, lot_number: e.target.value }))} className="w-full px-3 py-2 bg-background border border-border rounded text-sm text-foreground" data-testid="rcv-lot" />
            </div>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
            <div>
              <label className="text-xs uppercase tracking-wider text-muted-foreground font-bold block mb-1">
                {t('style')} {!!upcDoc?.style && <span className="text-emerald-500 text-[9px]" title="Bloqueado por UPC">🔒</span>}
              </label>
              <SearchableSelect options={options.styles || []} value={form.style} onChange={handleStyleChange} placeholder={t('wms_search_style')} testId="rcv-style" disabled={!!editingId || !!upcDoc?.style} allowCreate={canManageUpc} />
            </div>
            <div>
              <label className="text-xs uppercase tracking-wider text-muted-foreground font-bold block mb-1">
                {t('color')} {!!upcDoc?.color && <span className="text-emerald-500 text-[9px]" title="Bloqueado por UPC">🔒</span>}
              </label>
              <SearchableSelect options={options.colors || []} value={form.color} onChange={handleColorChange} placeholder={t('wms_search_color')} testId="rcv-color" disabled={!!editingId || !!upcDoc?.color} allowCreate={canManageUpc} />
            </div>
            <div>
              <label className="text-xs uppercase tracking-wider text-muted-foreground font-bold block mb-1">
                {t('size')} {!!upcDoc?.size && <span className="text-emerald-500 text-[9px]" title="Bloqueado por UPC">🔒</span>}
              </label>
              <select value={form.size} onChange={e => setForm(p => ({ ...p, size: e.target.value }))} className="w-full px-3 py-2 bg-background border border-border rounded text-sm text-foreground disabled:opacity-50" data-testid="rcv-size" disabled={!!editingId || !!upcDoc?.size}>
                <option value="">{t('select_placeholder')}</option>
                {SIZES_ORDER.map(s => <option key={s} value={s}>{s}</option>)}
              </select>
            </div>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
            <div>
              <label className="text-xs uppercase tracking-wider text-muted-foreground font-bold block mb-1">
                {t('description')} {!!upcDoc?.description && <span className="text-emerald-500 text-[9px]" title="Bloqueado por UPC">🔒</span>}
              </label>
              <SearchableSelect options={fieldOptions.descriptions} value={form.description} onChange={val => setForm(p => ({ ...p, description: val }))} placeholder={t('wms_search_desc')} testId="rcv-description" allowCreate={false} disabled={!!upcDoc?.description} />
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
                {t('fabric_content')} {!editingId && <span className="text-red-500">*</span>} {!!upcDoc?.fabric_content && <span className="text-emerald-500 text-[9px]" title="Bloqueado por UPC">🔒</span>}
              </label>
              <div className={!editingId && !form.fabric_content?.trim() ? 'ring-1 ring-red-500/40 rounded' : ''}>
                <SearchableSelect options={fieldOptions.fabrics} value={form.fabric_content} onChange={val => setForm(p => ({ ...p, fabric_content: val }))} placeholder={t('wms_search_fabric')} testId="rcv-fabric" allowCreate={false} disabled={!!upcDoc?.fabric_content} />
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
              <label className="text-xs uppercase tracking-wider text-muted-foreground font-bold block mb-1">
                ASN (Packing List) <span className="text-red-400">*</span>
              </label>
              <div className="flex gap-2">
                <input
                  list="rcv-asn-list"
                  placeholder="N° de ASN (obligatorio)"
                  value={form.asn_reference}
                  onChange={e => { setForm(p => ({ ...p, asn_reference: e.target.value.trim() })); setSelectedAsnLine(null); }}
                  className={`flex-1 px-3 py-2 bg-background border rounded text-sm text-foreground font-mono ${form.asn_reference && !selectedAsnDoc && !editingId ? 'border-red-500/60' : selectedAsnDoc ? 'border-emerald-500/40' : 'border-border'}`}
                  data-testid="rcv-asn"
                  disabled={!!editingId}
                />
                {!editingId && form.asn_reference && !selectedAsnDoc && (
                  <button
                    type="button"
                    onClick={openCreateAsn}
                    className="px-3 py-2 bg-indigo-500 hover:bg-indigo-400 text-white rounded text-xs font-black uppercase tracking-widest flex items-center gap-1.5 whitespace-nowrap transition-all"
                    title={`Crear ASN ${form.asn_reference} si aún no existe`}
                    data-testid="rcv-asn-create"
                  >
                    <Plus className="w-3.5 h-3.5" />
                    Crear ASN
                  </button>
                )}
              </div>
              {!editingId && form.asn_reference && !selectedAsnDoc && (
                <p className="text-[10px] text-red-400 mt-1 flex items-center gap-1">
                  El ASN <span className="font-mono font-bold">{form.asn_reference}</span> no está cargado. Créalo antes de recibir.
                </p>
              )}
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
                        Líneas del ASN ({pendingAsnLines.length}) — opcional, click para autollenar y matchear
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
                      Este ASN está cerrado o no tiene líneas — puedes recibir manualmente sin matchear.
                    </div>
                  ) : (
                    <div className="max-h-44 overflow-y-auto custom-scrollbar divide-y divide-border/10">
                      {pendingAsnLines.map(line => {
                        const expected = line.qty_expected || 0;
                        const received = line.qty_received || 0;
                        const remaining = expected - received;
                        const isSel = selectedAsnLine === line.line_no;
                        // remaining > 0 → faltante (pendiente); < 0 → sobrante; 0 → completo
                        const badge = remaining > 0
                          ? { value: remaining.toLocaleString(), label: 'pendientes', cls: 'text-foreground' }
                          : remaining < 0
                            ? { value: `+${Math.abs(remaining).toLocaleString()}`, label: 'sobrante', cls: 'text-amber-500' }
                            : { value: '0', label: 'completo', cls: 'text-emerald-500' };
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
                              <div className={`text-xs font-black tabular-nums ${badge.cls}`}>{badge.value}</div>
                              <div className="text-[9px] uppercase tracking-widest text-muted-foreground font-bold">{badge.label}</div>
                              <div className="text-[9px] tabular-nums text-muted-foreground mt-0.5">{received.toLocaleString()} / {expected.toLocaleString()}</div>
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
          <div className="flex flex-wrap gap-2 items-center">
            <button onClick={() => handleSubmit()} disabled={loading} className="px-4 py-2 bg-primary text-primary-foreground rounded text-sm flex items-center gap-1.5 disabled:opacity-50" data-testid="rcv-submit">
              {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Package className="w-4 h-4" />} {editingId ? 'Actualizar Detalles' : t('wms_receive_btn')}
            </button>
            {!editingId && (
              <div className="relative" ref={cartMenuRef}>
                <button
                  onClick={() => setShowCartMenu(s => !s)}
                  disabled={loading}
                  className="px-4 py-2 bg-amber-500/15 text-amber-600 dark:text-amber-400 border border-amber-500/30 hover:bg-amber-500/25 rounded text-sm flex items-center gap-1.5 disabled:opacity-50"
                  data-testid="rcv-submit-cart"
                  title="Recibir esta caja a un carro de Putaway 2.0 — quedará en el carro hasta que la ubiques manualmente."
                >
                  {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Truck className="w-4 h-4" />}
                  Recibir a Carro
                  <ChevronDown className="w-3.5 h-3.5 opacity-70" />
                </button>
                {showCartMenu && (
                  <div className="absolute z-30 right-0 mt-1 w-56 bg-popover border border-amber-500/30 rounded-lg shadow-2xl overflow-hidden">
                    {(transitCarts.length > 0 ? transitCarts :
                      Array.from({ length: 50 }, (_, i) => ({ name: `CARRO ${i + 1}`, boxes: 0 }))
                    ).map(c => (
                      <button
                        key={c.name}
                        onClick={() => { setShowCartMenu(false); handleSubmit({ toLocation: c.name }); }}
                        disabled={loading}
                        className="w-full text-left px-3 py-2 text-sm hover:bg-amber-500/15 flex items-center justify-between gap-2 disabled:opacity-50"
                        data-testid={`rcv-submit-cart-${c.name.replace(/\s+/g, '-').toLowerCase()}`}
                      >
                        <span className="flex items-center gap-2 font-mono font-bold text-amber-500">
                          <Truck className="w-3.5 h-3.5" /> {c.name}
                        </span>
                        <span className="text-[10px] uppercase tracking-widest text-muted-foreground">
                          {c.boxes || 0} cajas
                        </span>
                      </button>
                    ))}
                    <button
                      onClick={() => { setShowCartMenu(false); handleSubmit({ toLocation: TRANSIT_LOCATION }); }}
                      disabled={loading}
                      className="w-full text-left px-3 py-2 text-xs border-t border-border/40 hover:bg-secondary/60 text-muted-foreground disabled:opacity-50"
                      title="Ubicación temporal legacy — solo si ninguno de los carros aplica."
                      data-testid="rcv-submit-temporal"
                    >
                      ⏸ Ubicación Temporal (legacy)
                    </button>
                  </div>
                )}
              </div>
            )}
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

      {/* Create UPC inline modal */}
      {createUpcOpen && (
        <div className="fixed inset-0 z-[80] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm animate-in fade-in duration-150">
          <div className="bg-card border border-border/50 rounded-3xl w-full max-w-2xl max-h-[85vh] flex flex-col shadow-2xl animate-in zoom-in-95 duration-150">
            <div className="flex items-center justify-between p-5 border-b border-border/20">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-2xl bg-indigo-500/10 flex items-center justify-center">
                  <Package className="w-5 h-5 text-indigo-400" />
                </div>
                <div>
                  <h3 className="font-black uppercase tracking-tighter text-sm">{upcEditMode ? 'Editar UPC del catálogo' : 'Crear UPC en catálogo'}</h3>
                  <p className="text-[11px] text-muted-foreground font-bold">
                    {upcEditMode
                      ? 'Editas el master del catálogo. Los recibos pasados NO cambian; solo los futuros heredan estos datos.'
                      : 'Este producto se guardará como master — futuros recibos del mismo UPC heredarán estos datos.'}
                  </p>
                </div>
              </div>
              <button
                onClick={() => { setCreateUpcOpen(false); setUpcEditMode(false); }}
                disabled={creatingUpc}
                className="p-2 hover:bg-secondary rounded-lg transition-all disabled:opacity-50"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="flex-1 overflow-auto custom-scrollbar p-5 space-y-3">
              <div>
                <label className="text-[10px] font-black uppercase tracking-widest text-muted-foreground block mb-1">
                  UPC <span className="text-red-400">*</span>
                </label>
                <input
                  value={upcDraft.upc}
                  onChange={e => setUpcDraft(p => ({ ...p, upc: cleanScan(e.target.value) }))}
                  placeholder="Código del UPC"
                  className="w-full px-3 py-2 bg-background border border-border rounded text-sm font-mono font-bold disabled:opacity-60 disabled:cursor-not-allowed"
                  data-testid="upc-draft-code"
                  disabled={upcEditMode}
                  title={upcEditMode ? 'El código del UPC no se puede cambiar; elimina y crea uno nuevo si necesitas otro código.' : undefined}
                />
              </div>

              <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
                <div>
                  <label className="text-[10px] font-black uppercase tracking-widest text-muted-foreground block mb-1">Cliente</label>
                  <input value={upcDraft.customer} onChange={e => setUpcDraft(p => ({ ...p, customer: e.target.value.toUpperCase() }))} className="w-full px-3 py-2 bg-background border border-border rounded text-sm" />
                </div>
                <div>
                  <label className="text-[10px] font-black uppercase tracking-widest text-muted-foreground block mb-1">Fabricante</label>
                  <input value={upcDraft.manufacturer} onChange={e => setUpcDraft(p => ({ ...p, manufacturer: e.target.value.toUpperCase() }))} className="w-full px-3 py-2 bg-background border border-border rounded text-sm" />
                </div>
                <div>
                  <label className="text-[10px] font-black uppercase tracking-widest text-muted-foreground block mb-1">Marca</label>
                  <input value={upcDraft.brand} onChange={e => setUpcDraft(p => ({ ...p, brand: e.target.value.toUpperCase() }))} className="w-full px-3 py-2 bg-background border border-border rounded text-sm" />
                </div>
              </div>

              <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
                <div>
                  <label className="text-[10px] font-black uppercase tracking-widest text-muted-foreground block mb-1">
                    Style <span className="text-red-400">*</span>
                  </label>
                  <input value={upcDraft.style} onChange={e => setUpcDraft(p => ({ ...p, style: e.target.value.toUpperCase() }))} className="w-full px-3 py-2 bg-background border border-border rounded text-sm font-mono font-bold" data-testid="upc-draft-style" />
                </div>
                <div>
                  <label className="text-[10px] font-black uppercase tracking-widest text-muted-foreground block mb-1">Color</label>
                  <input value={upcDraft.color} onChange={e => setUpcDraft(p => ({ ...p, color: e.target.value.toUpperCase() }))} className="w-full px-3 py-2 bg-background border border-border rounded text-sm font-mono" />
                </div>
                <div>
                  <label className="text-[10px] font-black uppercase tracking-widest text-muted-foreground block mb-1">Talla</label>
                  <select value={upcDraft.size} onChange={e => setUpcDraft(p => ({ ...p, size: e.target.value }))} className="w-full px-3 py-2 bg-background border border-border rounded text-sm font-mono">
                    <option value="">{t('select_placeholder')}</option>
                    {SIZES_ORDER.map(s => <option key={s} value={s}>{s}</option>)}
                  </select>
                </div>
              </div>

              <div>
                <label className="text-[10px] font-black uppercase tracking-widest text-muted-foreground block mb-1">Descripción</label>
                <input value={upcDraft.description} onChange={e => setUpcDraft(p => ({ ...p, description: e.target.value }))} className="w-full px-3 py-2 bg-background border border-border rounded text-sm" />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-[10px] font-black uppercase tracking-widest text-muted-foreground block mb-1">País de origen</label>
                  <input value={upcDraft.country_of_origin} onChange={e => setUpcDraft(p => ({ ...p, country_of_origin: e.target.value.toUpperCase() }))} className="w-full px-3 py-2 bg-background border border-border rounded text-sm" />
                </div>
                <div>
                  <label className="text-[10px] font-black uppercase tracking-widest text-muted-foreground block mb-1">Fabric / Contenido</label>
                  <input value={upcDraft.fabric_content} onChange={e => setUpcDraft(p => ({ ...p, fabric_content: e.target.value }))} className="w-full px-3 py-2 bg-background border border-border rounded text-sm" />
                </div>
              </div>
            </div>

            <div className="flex gap-2 p-5 border-t border-border/20">
              <button
                onClick={handleSaveUpc}
                disabled={creatingUpc || !upcDraft.upc.trim() || !upcDraft.style.trim()}
                className="flex-1 px-4 py-2.5 bg-indigo-500 hover:bg-indigo-400 text-white rounded-xl text-sm font-black uppercase tracking-wider disabled:opacity-50 flex items-center justify-center gap-2"
                data-testid="upc-draft-submit"
              >
                {creatingUpc ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle2 className="w-4 h-4" />}
                {upcEditMode ? 'Actualizar UPC' : 'Guardar UPC'}
              </button>
              <button
                onClick={() => { setCreateUpcOpen(false); setUpcEditMode(false); }}
                disabled={creatingUpc}
                className="px-4 py-2.5 bg-secondary text-foreground rounded-xl text-sm font-bold uppercase disabled:opacity-50"
              >
                Cancelar
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Create ASN inline modal */}
      {createAsnOpen && (
        <div className="fixed inset-0 z-[80] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm animate-in fade-in duration-150">
          <div className="bg-card border border-border/50 rounded-3xl w-full max-w-2xl max-h-[85vh] flex flex-col shadow-2xl animate-in zoom-in-95 duration-150">
            <div className="flex items-center justify-between p-5 border-b border-border/20">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-2xl bg-indigo-500/10 flex items-center justify-center">
                  <FileText className="w-5 h-5 text-indigo-400" />
                </div>
                <div>
                  <h3 className="font-black uppercase tracking-tighter text-sm">Crear ASN manualmente</h3>
                  <p className="text-[11px] text-muted-foreground font-bold">
                    Captura mínima del packing list — luego puedes recibir contra este ASN.
                  </p>
                </div>
              </div>
              <button
                onClick={() => setCreateAsnOpen(false)}
                disabled={creatingAsn}
                className="p-2 hover:bg-secondary rounded-lg transition-all disabled:opacity-50"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="flex-1 overflow-auto custom-scrollbar p-5 space-y-4">
              {/* Header fields */}
              <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                <div>
                  <label className="text-[10px] font-black uppercase tracking-widest text-muted-foreground block mb-1">
                    N° ASN <span className="text-red-400">*</span>
                  </label>
                  <input
                    value={asnDraft.asn_id}
                    onChange={e => setAsnDraft(p => ({ ...p, asn_id: e.target.value.trim() }))}
                    placeholder="Ej. 12345"
                    className="w-full px-3 py-2 bg-background border border-border rounded text-sm font-mono font-bold"
                    data-testid="asn-draft-id"
                  />
                </div>
                <div>
                  <label className="text-[10px] font-black uppercase tracking-widest text-muted-foreground block mb-1">Vendor</label>
                  <input
                    value={asnDraft.vendor}
                    onChange={e => setAsnDraft(p => ({ ...p, vendor: e.target.value }))}
                    placeholder="Proveedor"
                    className="w-full px-3 py-2 bg-background border border-border rounded text-sm"
                  />
                </div>
                <div>
                  <label className="text-[10px] font-black uppercase tracking-widest text-muted-foreground block mb-1">PO</label>
                  <input
                    value={asnDraft.po_number}
                    onChange={e => setAsnDraft(p => ({ ...p, po_number: e.target.value }))}
                    placeholder="Purchase Order"
                    className="w-full px-3 py-2 bg-background border border-border rounded text-sm font-mono"
                  />
                </div>
              </div>

              {/* Items */}
              <div>
                <div className="flex items-center justify-between mb-2">
                  <span className="text-[10px] font-black uppercase tracking-widest text-muted-foreground">
                    Líneas del packing list ({asnDraft.items.length})
                  </span>
                  <button
                    type="button"
                    onClick={addAsnDraftItem}
                    className="flex items-center gap-1 text-[10px] font-black uppercase tracking-widest text-indigo-400 hover:text-indigo-300"
                  >
                    <Plus className="w-3 h-3" /> Agregar línea
                  </button>
                </div>
                <div className="space-y-2">
                  {asnDraft.items.map((it, idx) => (
                    <div key={idx} className="grid grid-cols-12 gap-2 p-3 bg-secondary/20 border border-border/20 rounded-xl">
                      <div className="col-span-3">
                        <label className="text-[9px] font-bold uppercase tracking-widest text-muted-foreground block mb-1">Part #*</label>
                        <input
                          value={it.part_number}
                          onChange={e => updateAsnDraftItem(idx, 'part_number', e.target.value)}
                          placeholder="Style"
                          className="w-full px-2 py-1.5 bg-background border border-border rounded text-xs font-mono font-bold"
                          data-testid={`asn-draft-pn-${idx}`}
                        />
                      </div>
                      <div className="col-span-4">
                        <label className="text-[9px] font-bold uppercase tracking-widest text-muted-foreground block mb-1">Descripción</label>
                        <input
                          value={it.description}
                          onChange={e => updateAsnDraftItem(idx, 'description', e.target.value)}
                          className="w-full px-2 py-1.5 bg-background border border-border rounded text-xs"
                        />
                      </div>
                      <div className="col-span-2">
                        <label className="text-[9px] font-bold uppercase tracking-widest text-muted-foreground block mb-1">Cant.*</label>
                        <input
                          type="number"
                          min="1"
                          value={it.qty_expected}
                          onChange={e => updateAsnDraftItem(idx, 'qty_expected', e.target.value)}
                          className="w-full px-2 py-1.5 bg-background border border-border rounded text-xs font-mono text-right"
                          data-testid={`asn-draft-qty-${idx}`}
                        />
                      </div>
                      <div className="col-span-1">
                        <label className="text-[9px] font-bold uppercase tracking-widest text-muted-foreground block mb-1">País</label>
                        <input
                          value={it.country}
                          onChange={e => updateAsnDraftItem(idx, 'country', e.target.value.toUpperCase())}
                          maxLength={3}
                          className="w-full px-2 py-1.5 bg-background border border-border rounded text-xs font-mono"
                        />
                      </div>
                      <div className="col-span-1">
                        <label className="text-[9px] font-bold uppercase tracking-widest text-muted-foreground block mb-1">Marca</label>
                        <input
                          value={it.brand}
                          onChange={e => updateAsnDraftItem(idx, 'brand', e.target.value)}
                          className="w-full px-2 py-1.5 bg-background border border-border rounded text-xs"
                        />
                      </div>
                      <div className="col-span-1 flex items-end justify-end">
                        <button
                          type="button"
                          onClick={() => removeAsnDraftItem(idx)}
                          disabled={asnDraft.items.length <= 1}
                          className="p-1.5 text-muted-foreground hover:text-destructive hover:bg-destructive/10 rounded disabled:opacity-30 disabled:cursor-not-allowed"
                          title="Quitar línea"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>

            <div className="flex gap-2 p-5 border-t border-border/20">
              <button
                onClick={handleCreateAsn}
                disabled={creatingAsn || !asnDraft.asn_id.trim()}
                className="flex-1 px-4 py-2.5 bg-indigo-500 hover:bg-indigo-400 text-white rounded-xl text-sm font-black uppercase tracking-wider disabled:opacity-50 flex items-center justify-center gap-2"
                data-testid="asn-draft-submit"
              >
                {creatingAsn ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle2 className="w-4 h-4" />}
                Crear ASN
              </button>
              <button
                onClick={() => setCreateAsnOpen(false)}
                disabled={creatingAsn}
                className="px-4 py-2.5 bg-secondary text-foreground rounded-xl text-sm font-bold uppercase disabled:opacity-50"
              >
                Cancelar
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
