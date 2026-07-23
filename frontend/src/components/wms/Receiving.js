import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { toast } from "sonner";
import { Package, Plus, Loader2, MapPin, Printer, Trash2, Factory, CheckCircle2, FileText, X, ChevronDown, Truck, Search, Download, ScanLine, AlertTriangle, ClipboardCheck } from "lucide-react";
import SearchableSelect from "../SearchableSelect";
import { useLang } from "../../contexts/LanguageContext";
import { fetcher, poster, logLoadError, useWmsSizes, useWmsCatalogs, mergeUnique, API, cleanScan } from "./lib";
import { AsnStatus } from "./constants";
import { SoftAlert, Btn, Chip, cls } from "./ui";

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
  // The recent-entries dump is gone: this screen is now search-driven. `search`
  // matches by receiving number OR customer (also style/sku) on the backend.
  const [search, setSearch] = useState('');
  const [searching, setSearching] = useState(false);
  // Cliente seleccionado para exportar sus recibos a Excel.
  const [exportCustomer, setExportCustomer] = useState('');
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({
    customer: '', manufacturer: '', style: '', color: '', size: '',
    description: '', country_of_origin: '', fabric_content: '',
    boxes: '', pieces: '', units: '', loose: '', lot_number: '', sku: '', inv_location: '',
    is_bpo: false, asn_reference: '',
  });
  // Piezas por caja: default 72, editable directo (si la caja trae 60, lo cambias).
  const [unitsPerBox, setUnitsPerBox] = useState(STANDARD_UNITS_PER_BOX);
  const effectiveUpb = Math.max(1, parseInt(unitsPerBox) || 1);

  // Antipendejos: cantidades SIEMPRE enteras y >= 0 (nada de 1.5 cajas). El total
  // se calcula solo: (N° de cajas × piezas por caja) + piezas sueltas.
  const toIntStr = (val) => (val === '' || val === null || val === undefined)
    ? '' : String(Math.max(0, Math.floor(Number(val) || 0)));

  const [editingId, setEditingId] = useState(null);
  const [loading, setLoading] = useState(false);
  const [options, setOptions] = useState({ customers: [], manufacturers: [], styles: [], colors: [] });
  // Curated, per-customer style list (locked: operators may only SELECT a style,
  // never type one). Falls back to inventory-derived styles if a client has none.
  const [customerStyles, setCustomerStyles] = useState([]);
  const [fieldOptions, setFieldOptions] = useState({ descriptions: [], countries: [], fabrics: [] });
  // Full size list (standard + admin-configured extras), single source of truth.
  const { all: sizeOptions } = useWmsSizes();
  // Colores y fabricantes curados POR CLIENTE (cliente seleccionado + globales),
  // fusionados con lo del inventario del mismo cliente. Nunca se muestran valores
  // específicos de OTRO cliente (igual que estilos con customerStyles).
  const [customerColors, setCustomerColors] = useState([]);
  const [customerManufacturers, setCustomerManufacturers] = useState([]);
  const colorOptions = useMemo(() => mergeUnique(customerColors, options.colors), [customerColors, options.colors]);
  // Resto de listas: catálogo curado FUSIONADO con lo del sistema/inventario,
  // para que ningún valor real quede oculto por no estar catalogado. El líder
  // limpia typos con "Detectar typos" en la config. (Manufacturer no es catálogo.)
  const wmsCat = useWmsCatalogs();
  const customerOptions = useMemo(() => mergeUnique(wmsCat.customers, options.customers), [wmsCat.customers, options.customers]);
  const styleOptions    = useMemo(() => mergeUnique(customerStyles, options.styles), [customerStyles, options.styles]);
  const manufacturerOptions = useMemo(() => mergeUnique(customerManufacturers, options.manufacturers), [customerManufacturers, options.manufacturers]);
  const descOptions     = useMemo(() => mergeUnique(wmsCat.descriptions, fieldOptions.descriptions), [wmsCat.descriptions, fieldOptions.descriptions]);
  const countryOptions  = useMemo(() => mergeUnique(wmsCat.countries, fieldOptions.countries), [wmsCat.countries, fieldOptions.countries]);
  const fabricOptions   = useMemo(() => mergeUnique(wmsCat.fabrics, fieldOptions.fabrics), [wmsCat.fabrics, fieldOptions.fabrics]);
  const [openAsns, setOpenAsns] = useState([]);
  const [selectedAsnLine, setSelectedAsnLine] = useState(null); // line_no within the chosen ASN
  // UPC catalog state. `upcDoc` is the resolved entry from wms_upc_catalog;
  // when set, the product fields (style/color/size/desc/country/fabric/brand)
  // become read-only because the catalog is the source of truth.
  const [upc, setUpc] = useState('');
  const [upcDoc, setUpcDoc] = useState(null);
  const [upcLooking, setUpcLooking] = useState(false);
  // Nota: el ALTA/edición de UPC ya no vive aquí — se movió al Catálogo de UPC
  // del módulo de Configuración (menú del supervisor). Receiving solo RESUELVE
  // el UPC escaneado; si no existe, dirige al supervisor a Config.
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

  // ── Escáner global ─────────────────────────────────────────────────────────
  // Barra siempre visible arriba del módulo: el flujo sano es escanear el
  // cartón ANTES de teclear nada. El código cae en `upc` y el lookup con
  // debounce de abajo hace el resto (autofill + candado de campos). El feedback
  // sonoro/vibración vive en ese mismo lookup, así que aplica igual si el
  // operador teclea el código a mano.
  const scanRef = useRef(null);
  const [scanBuf, setScanBuf] = useState('');
  const scanFeedback = (ok) => {
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (Ctx) {
        const ctx = new Ctx();
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.connect(gain); gain.connect(ctx.destination);
        osc.frequency.value = ok ? 880 : 200;
        gain.gain.value = 0.08;
        osc.start();
        osc.stop(ctx.currentTime + (ok ? 0.12 : 0.35));
        osc.onended = () => ctx.close();
      }
    } catch { /* sin audio no pasa nada */ }
    if (navigator.vibrate) navigator.vibrate(ok ? 60 : [120, 60, 120]);
  };
  const handleGlobalScan = () => {
    const code = cleanScan(scanBuf);
    setScanBuf('');
    if (!code) return;
    if (!showForm || editingId) {
      setEditingId(null);
      setForm({ customer: '', manufacturer: '', style: '', color: '', size: '', description: '', country_of_origin: '', fabric_content: '', boxes: '', pieces: '', units: '', loose: '', lot_number: '', sku: '', inv_location: '', is_bpo: false, asn_reference: form.asn_reference || '' });
      setUnitsPerBox(STANDARD_UNITS_PER_BOX); setSelectedAsnLine(null);
      setShowForm(true);
    }
    setUpc(code);
  };

  // ── Progreso del ASN (semáforo por línea + matriz color×talla) ─────────────
  // GET /asn/{id} devuelve las cajas ya recibidas contra ese packing list; de
  // ahí sale la matriz. Se refresca tras cada recibo exitoso (asnRefresh).
  const [asnBoxes, setAsnBoxes] = useState(null);
  const [asnRefresh, setAsnRefresh] = useState(0);
  const selectedAsnId = selectedAsnDoc?.asn_id || null;
  useEffect(() => {
    if (!selectedAsnId) { setAsnBoxes(null); return; }
    let alive = true;
    fetcher(`/asn/${encodeURIComponent(selectedAsnId)}`)
      .then(d => { if (alive) setAsnBoxes(d?.boxes || []); })
      .catch(() => { if (alive) setAsnBoxes(null); });
    return () => { alive = false; };
  }, [selectedAsnId, asnRefresh]);
  const asnMatrix = useMemo(() => {
    if (!asnBoxes || asnBoxes.length === 0) return null;
    const CANON = ['XS', 'S', 'M', 'L', 'XL', '1X', '2X', '3X', '4X', '5X',
                   '2T', '3T', '4T', '5T', 'YXS', 'YS', 'YM', 'YL', 'YXL'];
    const cells = {}; const sizesSeen = new Set(); const colors = new Set();
    for (const b of asnBoxes) {
      const co = (b.color || '—').toUpperCase();
      const sz = (b.size || '—').toUpperCase();
      colors.add(co); sizesSeen.add(sz);
      const k = `${co}|${sz}`;
      cells[k] = (cells[k] || 0) + (parseInt(b.units ?? b.qty) || 0);
    }
    const sizes = [...CANON.filter(s => sizesSeen.has(s)),
                   ...[...sizesSeen].filter(s => !CANON.includes(s)).sort()];
    return { sizes, colors: [...colors].sort(), cells };
  }, [asnBoxes]);

  // ── Resumen previo a confirmar ─────────────────────────────────────────────
  // El submit ya no dispara directo: primero un resumen con lo que se va a
  // crear + advertencias (sin UPC, fuera de catálogo, posible sobrerrecepción
  // contra la línea del ASN). Editar metadata (editingId) va directo: no crea
  // inventario.
  const [pendingSubmit, setPendingSubmit] = useState(null); // { opts, warnings }

  // Autofill desde la línea del ASN. REGLA: el ASN llena Fabricante, País de
  // origen, Descripción y Contenido (tela) — son metadata del embarque y varían
  // por lote. La IDENTIDAD del SKU (cliente, estilo, color, talla) NUNCA se
  // toca: viene del UPC escaneado o de la captura del operador. Antes esta
  // función sobreescribía cliente/estilo con los valores del ASN y pisaba la
  // identidad del UPC (bug reportado). Cada campo solo se llena si el valor del
  // ASN resuelve a una entrada del dropdown curado; si no, se omite.
  const pickAsnLine = (line) => {
    setSelectedAsnLine(line.line_no);

    const updates = {};
    const matched = [];
    const skipped = [];

    const manufacturer = findInOptions(line.brand, manufacturerOptions);
    if (manufacturer) { updates.manufacturer = manufacturer; matched.push('Fabricante'); }
    else if (line.brand) skipped.push('Fabricante');

    const country = findInOptions(line.country, fieldOptions.countries, { iso3: COUNTRY_ISO3 });
    if (country) { updates.country_of_origin = country; matched.push('País'); }
    else if (line.country) skipped.push('País');

    const description = findInOptions(line.description, fieldOptions.descriptions);
    if (description) { updates.description = description; matched.push('Descripción'); }
    else if (line.description) skipped.push('Descripción');

    const fabric = findInOptions(line.fabric_content, fieldOptions.fabrics);
    if (fabric) { updates.fabric_content = fabric; matched.push('Tela'); }
    else if (line.fabric_content) skipped.push('Tela');

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

  // Search-driven load: empty term clears the list (no auto-dump). Re-runs the
  // CURRENT search so create/edit/delete refresh what the operator is viewing.
  const load = useCallback(() => {
    const q = search.trim();
    if (!q) { setRecords([]); return; }
    setSearching(true);
    fetcher(`/receiving?search=${encodeURIComponent(q)}`)
      .then(d => setRecords(Array.isArray(d) ? d : []))
      .catch(logLoadError('data'))
      .finally(() => setSearching(false));
  }, [search]);
  // Debounce so we don't fire a request on every keystroke.
  useEffect(() => {
    const h = setTimeout(load, 300);
    return () => clearTimeout(h);
  }, [load]);

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
    // Reseteo en cascada SOLO de lo que el fabricante realmente filtra. Si la
    // identidad vino de un UPC escaneado, style/color están fijados y bloqueados
    // por el catálogo: NO se deben borrar al elegir el fabricante (que ahora es
    // editable porque el UPC ya no lleva manufacturer). Sin esta guarda, elegir
    // el fabricante vaciaba el style/color del UPC y dejaba el recibo trabado.
    setForm(p => ({
      ...p,
      manufacturer: val,
      style: upcDoc?.style ? p.style : '',
      color: upcDoc?.color ? p.color : '',
    }));
    loadOptions(form.customer, val, upcDoc?.style ? form.style : '');
  };
  const handleStyleChange = (val) => {
    setForm(p => ({ ...p, style: val, color: '' }));
    loadOptions(form.customer, form.manufacturer, val);
  };
  const handleColorChange = (val) => {
    setForm(p => ({ ...p, color: val }));
  };

  // Load the customer's curated style list whenever the customer changes
  // (covers manual pick, UPC autofill and edit mode).
  useEffect(() => {
    const c = (form.customer || '').trim();
    if (!c) { setCustomerStyles([]); return; }
    fetcher(`/catalogs/styles?customer=${encodeURIComponent(c)}`)
      .then(d => setCustomerStyles(d?.styles || []))
      .catch(() => setCustomerStyles([]));
  }, [form.customer]);

  // Colores y fabricantes curados del cliente (+ globales). Sin cliente: solo
  // globales — nunca los específicos de otro cliente. Usa el endpoint genérico
  // /catalogs/{type}/for-customer que ya devuelve "cliente + globales".
  useEffect(() => {
    const c = (form.customer || '').trim();
    fetcher(`/catalogs/colors/for-customer?customer=${encodeURIComponent(c)}`)
      .then(d => setCustomerColors(d?.values || []))
      .catch(() => setCustomerColors([]));
    fetcher(`/catalogs/manufacturers/for-customer?customer=${encodeURIComponent(c)}`)
      .then(d => setCustomerManufacturers(d?.values || []))
      .catch(() => setCustomerManufacturers([]));
  }, [form.customer]);

  // Auto-generate SKU when style/color/size change
  useEffect(() => {
    if (form.style) {
      const parts = [form.style.toUpperCase().replace(/\s+/g, '-')];
      if (form.color) parts.push(form.color.toUpperCase().replace(/\s+/g, '-').substring(0, 10));
      if (form.size) parts.push(form.size.toUpperCase());
      setForm(p => ({ ...p, sku: parts.join('-') }));
    }
  }, [form.style, form.color, form.size]); // eslint-disable-line react-hooks/exhaustive-deps

  // Total = (N° de cajas × piezas por caja) + piezas sueltas de la caja incompleta.
  const totalUnits = (parseInt(form.boxes) || 0) * effectiveUpb + (parseInt(form.loose) || 0);

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
          scanFeedback(false);
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
        scanFeedback(true);
        // Autofill SOLO la identidad del SKU. El UPC es unicamente estilo+color+
        // talla (+ cliente, que define el scope). Fabricante, pais de origen,
        // descripcion y contenido/porcentajes NO son parte del UPC — los provee
        // el ASN o el operador, y varian por embarque. Preserva lo que el
        // operador ya haya capturado en esos campos.
        setForm(p => ({
          ...p,
          customer: doc.customer || p.customer,
          style: doc.style || p.style,
          color: doc.color || p.color,
          size: doc.size || p.size,
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
        qty_expected: totalUnits || '',
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
  // Validación previa + resumen. Mismo criterio que handleSubmit (que revalida
  // por si acaso): si algo obligatorio falta -> toast y no hay resumen; si todo
  // está -> modal con lo que se va a crear + advertencias no bloqueantes.
  const requestSubmit = (opts = {}) => {
    if (editingId) { handleSubmit(opts); return; }   // editar metadata: directo
    // Solo se recibe con UPC REGISTRADO. Sin un UPC resuelto contra el catalogo
    // no hay recibo: el supervisor lo da de alta en Config -> Catalogo de UPC.
    if (!upcDoc) {
      toast.error(upc.trim()
        ? `El UPC ${upc.trim().toUpperCase()} no está registrado. El supervisor debe darlo de alta en Configuración → Catálogo de UPC.`
        : 'Escanea el UPC del cartón — todo material se recibe con UPC.');
      return;
    }
    if (!form.style) { toast.error(t('wms_style_req')); return; }
    const requeridos = [
      ['customer', 'Customer'], ['manufacturer', 'Fabricante'], ['style', 'Style'],
      ['color', 'Color'], ['size', 'Talla (Size)'], ['description', 'Descripción'],
      ['country_of_origin', 'País de origen'], ['fabric_content', 'Contenido de tela'],
    ];
    const falta = requeridos.find(([k]) => !String(form[k] || '').trim());
    if (falta) { toast.error(`${falta[1]} es obligatorio`); return; }
    if (totalUnits <= 0) { toast.error('Ingresa una cantidad mayor a 0 (N° de cajas o piezas sueltas)'); return; }
    if (!form.asn_reference?.trim()) { toast.error('ASN obligatorio — captura el número de packing list o créalo primero'); return; }
    if (!selectedAsnDoc) { toast.error(`ASN ${form.asn_reference} no existe. Créalo con el botón "+ Crear ASN".`); return; }

    const warnings = [];
    if (!upc.trim()) warnings.push('Sin UPC — el recibo se guardará sin referencia de catálogo.');
    else if (!upcDoc) warnings.push(`UPC ${upc.trim().toUpperCase()} no está en catálogo — se guardará de todas formas.`);
    // Posible sobrerrecepción contra la línea del ASN (mismo criterio que el
    // candado del backend, tolerancia default 5%): aviso aquí, el backend decide.
    const line = selectedAsnLine != null
      ? (selectedAsnDoc.items || []).find(l => l.line_no === selectedAsnLine)
      : (selectedAsnDoc.items || []).find(l => (l.part_number || '').trim().toUpperCase() === form.style.trim().toUpperCase());
    if (line) {
      const exp = parseInt(line.qty_expected) || 0;
      const rec = parseInt(line.qty_received) || 0;
      if (exp > 0 && rec + totalUnits > exp * 1.05) {
        warnings.push(`Posible sobrerrecepción: la línea ${line.part_number} espera ${exp.toLocaleString()}, lleva ${rec.toLocaleString()} y este recibo trae ${totalUnits.toLocaleString()} — el sistema lo rechazará salvo autorización de un admin.`);
      }
    }
    setShowCartMenu(false);
    setPendingSubmit({ opts, warnings });
  };

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
      // Todos los campos de identidad son OBLIGATORIOS (única excepción: Lot Number).
      const requeridos = [
        ['customer', 'Customer'],
        ['manufacturer', 'Fabricante'],
        ['style', 'Style'],
        ['color', 'Color'],
        ['size', 'Talla (Size)'],
        ['description', 'Descripción'],
        ['country_of_origin', 'País de origen'],
        ['fabric_content', 'Contenido de tela'],
      ];
      const falta = requeridos.find(([k]) => !String(form[k] || '').trim());
      if (falta) { toast.error(`${falta[1]} es obligatorio`); return; }
      // Cantidad obligatoria > 0 (antes se podía recibir un registro de 0 unidades).
      if (totalUnits <= 0) {
        toast.error('Ingresa una cantidad mayor a 0 (N° de cajas o piezas sueltas)');
        return;
      }
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
        setForm({ customer: '', manufacturer: '', style: '', color: '', size: '', description: '', country_of_origin: '', fabric_content: '', boxes: '', pieces: '', units: '', loose: '', lot_number: '', sku: '', inv_location: '', is_bpo: false, asn_reference: '' });
        setUnitsPerBox(STANDARD_UNITS_PER_BOX); setSelectedAsnLine(null);
        load();
      } else {
        // Create Mode. Modelo simple: N cajas completas de `upb` piezas + (opcional)
        // 1 caja incompleta con `loose` piezas sueltas. Es exactamente lo que el
        // operador capturó — sin adivinar splits.
        const upb = effectiveUpb;
        const nBoxes = parseInt(form.boxes) || 0;
        const loose = parseInt(form.loose) || 0;
        const totalPieces = nBoxes * upb + loose;

        const items = [];
        if (nBoxes > 0) items.push({ size: form.size, boxes: nBoxes, units_per_box: upb });
        if (loose > 0) items.push({ size: form.size, boxes: 1, units_per_box: loose });

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
          // Imprime etiquetas en TODO recibo (antes solo si estaba marcado "back
          // order"). Una caja sin etiqueta es un problema de bodega; que no
          // dependa de que el operador se acuerde de marcar una casilla.
          handlePrintLabel(data);
          setShowForm(false);
          setForm({ customer: '', manufacturer: '', style: '', color: '', size: '', description: '', country_of_origin: '', fabric_content: '', boxes: '', pieces: '', units: '', loose: '', lot_number: '', sku: '', inv_location: '', is_bpo: false, asn_reference: '' });
          setUnitsPerBox(STANDARD_UNITS_PER_BOX); setSelectedAsnLine(null);
          setUpc(''); setUpcDoc(null);
          fetcher('/asn').then(d => setOpenAsns((d || []).filter(a => a.status !== AsnStatus.RECEIVED))).catch(() => {});
          load();
          // El siguiente cartón se escanea de inmediato: refresca la matriz del
          // ASN y regresa el foco a la barra de escaneo.
          setAsnRefresh(n => n + 1);
          setTimeout(() => scanRef.current?.focus(), 50);
        } else { const err = await res.json().catch(() => ({})); toast.error(err.detail || 'Error'); }
      }
    } catch { toast.error(t('error_connection')); }
    finally { setLoading(false); }
  };

  const handlePrintLabel = (r) => {
    const pw = window.open('', '_blank');
    if (!pw) { toast.error(t('wms_popup_err')); return; }

    const boxes = r.boxes || [{ box_id: r.receiving_id, units: r.total_units }];

    const fmtLabelDate = (iso) => {
      const d = new Date(iso || Date.now());
      if (isNaN(d)) return '';
      return d.toLocaleString('es-MX', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
    };

    // Carros se abrevian a "C.<num>" para que el numero quepa ENORME;
    // bins y demas ubicaciones se imprimen tal cual.
    const rawLoc = (r.inv_location || '').trim();
    const carroMatch = /^CARRO\s*(\S+)$/i.exec(rawLoc);
    const locDisplay = carroMatch ? `C.${carroMatch[1]}` : rawLoc;
    const locSize = carroMatch ? '52px' : '40px';

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
            <td class="cell" style="width:40%"><span class="label">${t('wms_label_lot')}</span><span class="value">${r.lot_number || ''}</span></td>
            <td class="cell" style="width:60%;text-align:center;position:relative"><span style="position:absolute;top:2px;left:4px;font-size:9px;color:#666;font-weight:bold">L</span><span class="value" style="font-size:${locSize};letter-spacing:1px;line-height:1;display:block">${locDisplay}</span></td>
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
        ${r.upc ? `<div style="text-align:center;margin-top:4px"><span class="label">UPC</span><svg id="upcbar-${idx}"></svg></div>` : ''}
        <div style="margin-top:12px;border-top:2px solid #000;padding-top:8px">
          <div style="display:flex;justify-content:space-between;align-items:baseline">
            <div><span class="label">Caja</span><span style="font-size:16px;font-weight:bold;font-family:monospace">${box.box_id}</span></div>
            <div style="text-align:right"><span class="label">Etiqueta</span><span style="font-size:16px;font-weight:bold">${idx + 1} de ${boxes.length}</span></div>
          </div>
          <div style="display:flex;justify-content:space-between;align-items:baseline;margin-top:6px">
            <div><span class="label">Fecha de recibo</span><span style="font-size:15px;font-weight:bold">${fmtLabelDate(box.created_at || r.created_at)}</span></div>
            <div style="text-align:right"><span class="label">Recibi&oacute;</span><span style="font-size:15px;font-weight:bold">${r.received_by_name || ''}</span></div>
          </div>
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
            ${r.upc ? `JsBarcode("#upcbar-${idx}", "${r.upc}", { width: 1.6, height: 44, displayValue: true, fontSize: 14, margin: 0 });` : ''}
          `).join('\n')}
          setTimeout(function(){window.print()}, 800);
        } catch(e) {}
      </script>
    </body></html>`;

    pw.document.write(html);
    pw.document.close();
  };

  return (
    <div className="space-y-6">
      {/* ── Barra de escaneo global: el flujo sano empieza escaneando el cartón.
          El código abre el formulario y dispara el lookup de UPC (autofill +
          candado). Beep/vibración según el resultado. ── */}
      <div className="relative">
        <ScanLine className="absolute left-4 top-1/2 -translate-y-1/2 w-6 h-6 text-muted-foreground" />
        <input
          ref={scanRef}
          value={scanBuf}
          onChange={e => setScanBuf(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); handleGlobalScan(); } }}
          placeholder="ESCANEA EL UPC DEL CARTÓN PARA RECIBIR…"
          className="w-full pl-14 pr-4 py-4 bg-card border border-input rounded-lg text-lg font-mono focus:outline-none focus:ring-2 focus:ring-ring/25 focus:border-ring transition-colors placeholder:text-sm placeholder:text-muted-foreground/60"
          data-testid="rcv-global-scan"
          autoFocus
        />
        {upcLooking && <Loader2 className="absolute right-4 top-1/2 -translate-y-1/2 w-5 h-5 text-muted-foreground animate-spin" />}
      </div>
      <div className="flex items-center justify-between gap-3">
        <div className="relative flex-1 max-w-2xl group">
          {searching
            ? <Loader2 className="absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5 text-primary animate-spin" />
            : <Search className="absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5 text-muted-foreground group-focus-within:text-primary transition-colors" />}
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Buscar por N° de recibo, cliente o carro (ubicación)…"
            className={`${cls.input} pl-12 pr-10`}
            data-testid="rcv-search"
          />
          {search && (
            <button
              onClick={() => setSearch('')}
              className="absolute right-3 top-1/2 -translate-y-1/2 p-1 text-muted-foreground hover:text-foreground rounded-md transition-colors"
              title="Limpiar búsqueda"
            >
              <X className="w-4 h-4" />
            </button>
          )}
        </div>
      </div>
      {/* Exportar Excel de recibos por cliente */}
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-xs font-medium text-muted-foreground">Exportar recibos:</span>
        <div className="w-64">
          <SearchableSelect options={customerOptions} value={exportCustomer} onChange={setExportCustomer} placeholder="Cliente (vacío = todos)…" testId="rcv-export-customer" />
        </div>
        <Btn
          onClick={() => window.open(`${API}/export/receiving${exportCustomer ? `?customer=${encodeURIComponent(exportCustomer)}` : ''}`, '_blank')}
          data-testid="rcv-export-btn"
          title={exportCustomer ? `Exportar recibos de ${exportCustomer}` : 'Exportar todos los recibos'}
        >
          <Download className="w-4 h-4" /> Exportar Excel
        </Btn>
      </div>
      {search.trim() && (
        <div className="text-xs font-medium text-muted-foreground px-1">
          {records.length} resultado(s) para "{search.trim()}"
        </div>
      )}
      {showForm && (
        <div className="border border-border rounded-lg p-4 bg-secondary/30 space-y-3" data-testid="receiving-form">
          {/* ASN (Packing List) — al principio: se recibe contra un packing list */}
          <div className="grid grid-cols-1 gap-3">
            <div>
              <label className="text-xs font-medium text-muted-foreground block mb-1">
                ASN (Packing List) <span className="text-red-600 dark:text-red-400">*</span>
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
                  <Btn
                    type="button"
                    variant="primary"
                    onClick={openCreateAsn}
                    className="whitespace-nowrap"
                    title={`Crear ASN ${form.asn_reference} si aún no existe`}
                    data-testid="rcv-asn-create"
                  >
                    <Plus className="w-3.5 h-3.5" />
                    Crear ASN
                  </Btn>
                )}
              </div>
              {!editingId && form.asn_reference && !selectedAsnDoc && (
                <p className="text-xs text-red-600 dark:text-red-400 mt-1 flex items-center gap-1">
                  El ASN <span className="font-mono font-semibold">{form.asn_reference}</span> no está cargado. Créalo antes de recibir.
                </p>
              )}
              <datalist id="rcv-asn-list">
                {openAsns.map(a => (
                  <option key={a.asn_id} value={a.asn_id}>{`${a.vendor || ''} · ${a.items?.length || 0} líneas · ${a.status}`}</option>
                ))}
              </datalist>
              {/* Line picker — opcional. Si el operador ignora esto, sigue funcionando tecleando el style manualmente. */}
              {selectedAsnDoc && !editingId && (
                <div className="mt-2 border border-border bg-card rounded-lg overflow-hidden">
                  <div className="flex items-center justify-between px-3 py-2 bg-muted/50 border-b border-border">
                    <div className="flex items-center gap-2">
                      <FileText className="w-3.5 h-3.5 text-muted-foreground" />
                      <span className="text-xs font-medium text-muted-foreground">
                        Líneas del ASN ({pendingAsnLines.length}) — opcional, click para autollenar y matchear
                      </span>
                    </div>
                    {selectedAsnLine != null && (
                      <button
                        type="button"
                        onClick={clearAsnLine}
                        className="flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground"
                      >
                        <X className="w-3 h-3" /> Limpiar
                      </button>
                    )}
                  </div>
                  {pendingAsnLines.length === 0 ? (
                    <div className="px-3 py-3 text-xs text-muted-foreground">
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
                            ? { value: `+${Math.abs(remaining).toLocaleString()}`, label: 'sobrante', cls: 'text-amber-600 dark:text-amber-400' }
                            : { value: '0', label: 'completo', cls: 'text-emerald-600 dark:text-emerald-400' };
                        return (
                          <button
                            key={line.line_no}
                            type="button"
                            onClick={() => pickAsnLine(line)}
                            className={`w-full text-left px-3 py-2 flex items-start gap-2 transition-colors ${isSel ? 'bg-primary/5' : 'hover:bg-muted/40'}`}
                          >
                            <div className={`mt-0.5 w-4 h-4 rounded-full border flex items-center justify-center flex-shrink-0 ${isSel ? 'border-primary bg-primary text-primary-foreground' : 'border-border'}`}>
                              {isSel && <CheckCircle2 className="w-3 h-3" />}
                            </div>
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center gap-2 text-xs">
                                <span className="font-mono font-medium text-foreground">{line.part_number}</span>
                                {line.country && <span className="text-xs font-medium text-muted-foreground bg-muted px-1.5 py-0.5 rounded-md">{line.country}</span>}
                                {line.brand && <span className="text-xs font-medium text-muted-foreground">{line.brand}</span>}
                              </div>
                              {line.description && (
                                <div className="text-xs text-muted-foreground truncate mt-0.5" title={line.description}>
                                  {line.description}
                                </div>
                              )}
                            </div>
                            <div className="text-right flex-shrink-0">
                              <div className={`text-xs font-semibold tabular-nums ${badge.cls}`}>{badge.value}</div>
                              <div className="text-[10px] text-muted-foreground">{badge.label}</div>
                              <div className="text-[10px] tabular-nums text-muted-foreground mt-0.5">{received.toLocaleString()} / {expected.toLocaleString()}</div>
                            </div>
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>
              )}
              {/* Matriz color × talla de lo YA recibido contra este ASN. Se
                  alimenta de las cajas reales (GET /asn/{id}) y se refresca en
                  cada recibo — el operador ve el packing list llenarse en vivo. */}
              {selectedAsnDoc && !editingId && asnMatrix && (
                <div className="mt-2 border border-border bg-card rounded-lg overflow-hidden" data-testid="rcv-asn-matrix">
                  <div className="px-3 py-2 bg-muted/50 border-b border-border flex items-center gap-2">
                    <ClipboardCheck className="w-3.5 h-3.5 text-muted-foreground" />
                    <span className="text-xs font-medium text-muted-foreground">
                      Recibido en este ASN — color × talla ({(asnBoxes || []).length} cajas)
                    </span>
                  </div>
                  <div className="overflow-x-auto custom-scrollbar">
                    <table className="w-full text-[11px] tabular-nums">
                      <thead>
                        <tr className="bg-muted/50 border-b border-border">
                          <th className="text-left px-3 py-1.5 font-semibold text-muted-foreground">Color</th>
                          {asnMatrix.sizes.map(sz => (
                            <th key={sz} className="px-2 py-1.5 font-semibold text-muted-foreground">{sz}</th>
                          ))}
                          <th className="px-3 py-1.5 font-semibold text-muted-foreground">Total</th>
                        </tr>
                      </thead>
                      <tbody>
                        {asnMatrix.colors.map(co => {
                          const rowTotal = asnMatrix.sizes.reduce((s, sz) => s + (asnMatrix.cells[`${co}|${sz}`] || 0), 0);
                          const isActiveColor = (form.color || '').toUpperCase() === co;
                          return (
                            <tr key={co} className={`border-t border-border/60 ${isActiveColor ? 'bg-primary/5' : ''}`}>
                              <td className="px-3 py-1.5 font-medium font-mono">{co}</td>
                              {asnMatrix.sizes.map(sz => {
                                const v = asnMatrix.cells[`${co}|${sz}`] || 0;
                                const isActiveCell = isActiveColor && (form.size || '').toUpperCase() === sz;
                                return (
                                  <td key={sz} className={`px-2 py-1.5 text-center ${v ? 'font-medium text-foreground' : 'text-muted-foreground/40'} ${isActiveCell ? 'ring-2 ring-primary/60 rounded' : ''}`}>
                                    {v ? v.toLocaleString() : '·'}
                                  </td>
                                );
                              })}
                              <td className="px-3 py-1.5 text-center font-semibold">{rowTotal.toLocaleString()}</td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </div>
          </div>
          {/* UPC — captura primero. Master del catálogo de producto */}
          {!editingId && (
            <div className="p-3 rounded-lg bg-card border border-border">
              <label className="text-xs font-medium text-muted-foreground mb-1 flex items-center gap-2">
                <span className="text-foreground font-semibold">UPC</span>
                <Chip tone="danger">Obligatorio</Chip>
                {upcDoc && (
                  <Chip tone="success">
                    <CheckCircle2 className="w-2.5 h-2.5" /> en catálogo
                  </Chip>
                )}
                {upc.trim() && !upcDoc && !upcLooking && (
                  <Chip tone="danger">
                    no registrado
                  </Chip>
                )}
              </label>
              <div className="flex gap-2">
                <input
                  value={upc}
                  onChange={e => setUpc(e.target.value)}
                  placeholder="Escanea el UPC del cartón"
                  className={`flex-1 px-3 py-2 bg-background border rounded text-sm font-mono ${
                    upcDoc ? 'border-emerald-500/40' : upc.trim() ? 'border-red-500/40' : 'border-border'
                  }`}
                  data-testid="rcv-upc"
                  autoFocus
                />
                {upcLooking && (
                  <span className="flex items-center px-3 text-muted-foreground">
                    <Loader2 className="w-4 h-4 animate-spin" />
                  </span>
                )}
                {upcDoc && (
                  <Btn
                    type="button"
                    onClick={() => { setUpc(''); setUpcDoc(null); }}
                    title="Limpiar UPC y desbloquear campos"
                  >
                    <X className="w-3.5 h-3.5" />
                  </Btn>
                )}
              </div>
              {upcDoc && (
                <p className="text-xs text-emerald-600 dark:text-emerald-400 mt-1.5 font-mono">
                  {upcDoc.style} · {upcDoc.color} · {upcDoc.size} — {upcDoc.description?.slice(0, 60) || '—'}
                </p>
              )}
              {upc.trim() && !upcDoc && !upcLooking && (
                <SoftAlert tone="danger" className="mt-2">
                  <span>
                    El UPC <span className="font-mono font-semibold">{upc.trim().toUpperCase()}</span> no está registrado. No se puede recibir.
                    Pídele al supervisor que lo dé de alta en <b>Configuración WMS → Catálogo de UPC</b>.
                  </span>
                </SoftAlert>
              )}
              {!upc.trim() && (
                <p className="text-xs text-muted-foreground mt-1.5">
                  Escanea el UPC del cartón. Todo material se recibe con UPC registrado.
                </p>
              )}
            </div>
          )}

          <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
            <div>
              <label className="text-xs font-medium text-muted-foreground block mb-1">
                {t('customer')} {!editingId && <span className="text-red-600 dark:text-red-400">*</span>} {!!upcDoc?.customer && <span className="text-emerald-600 dark:text-emerald-400 text-[9px]" title="Bloqueado por UPC">🔒</span>}
              </label>
              <SearchableSelect options={customerOptions} value={form.customer} onChange={handleCustomerChange} placeholder={t('wms_search_customer')} testId="rcv-customer" disabled={!!upcDoc?.customer} allowCreate={false} />
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground block mb-1">
                {t('manufacturer')} {!editingId && <span className="text-red-600 dark:text-red-400">*</span>}
              </label>
              <SearchableSelect options={manufacturerOptions} value={form.manufacturer} onChange={handleManufacturerChange} placeholder={t('wms_search_manufacturer')} testId="rcv-manufacturer" allowCreate={false} />
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground block mb-1">{t('wms_lot')}</label>
              <input placeholder={t('wms_lot')} value={form.lot_number} onChange={e => setForm(p => ({ ...p, lot_number: e.target.value }))} className="w-full px-3 py-2 bg-background border border-border rounded text-sm text-foreground" data-testid="rcv-lot" />
            </div>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
            <div>
              <label className="text-xs font-medium text-muted-foreground block mb-1">
                {t('style')} {!editingId && <span className="text-red-600 dark:text-red-400">*</span>} {!!upcDoc?.style && <span className="text-emerald-600 dark:text-emerald-400 text-[9px]" title="Bloqueado por UPC">🔒</span>}
              </label>
              <SearchableSelect options={styleOptions} value={form.style} onChange={handleStyleChange} placeholder={form.customer && styleOptions.length === 0 ? 'Cliente sin catálogo — pídele al líder' : t('wms_search_style')} testId="rcv-style" disabled={!!editingId || !!upcDoc?.style || (form.customer && styleOptions.length === 0)} allowCreate={false} />
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground block mb-1">
                {t('color')} {!editingId && <span className="text-red-600 dark:text-red-400">*</span>} {!!upcDoc?.color && <span className="text-emerald-600 dark:text-emerald-400 text-[9px]" title="Bloqueado por UPC">🔒</span>}
              </label>
              <SearchableSelect options={colorOptions} value={form.color} onChange={handleColorChange} placeholder={t('wms_search_color')} testId="rcv-color" disabled={!!editingId || !!upcDoc?.color} allowCreate={false} />
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground block mb-1">
                {t('size')} {!editingId && <span className="text-red-600 dark:text-red-400">*</span>} {!!upcDoc?.size && <span className="text-emerald-600 dark:text-emerald-400 text-[9px]" title="Bloqueado por UPC">🔒</span>}
              </label>
              <select value={form.size} onChange={e => setForm(p => ({ ...p, size: e.target.value }))} className="w-full px-3 py-2 bg-background border border-border rounded text-sm text-foreground disabled:opacity-50" data-testid="rcv-size" disabled={!!editingId || !!upcDoc?.size}>
                <option value="">{t('select_placeholder')}</option>
                {sizeOptions.map(s => <option key={s} value={s}>{s}</option>)}
              </select>
            </div>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
            <div>
              <label className="text-xs font-medium text-muted-foreground block mb-1">
                {t('description')} {!editingId && <span className="text-red-600 dark:text-red-400">*</span>}
              </label>
              <SearchableSelect options={descOptions} value={form.description} onChange={val => setForm(p => ({ ...p, description: val }))} placeholder={t('wms_search_desc')} testId="rcv-description" allowCreate={false} />
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground block mb-1">
                {t('country_of_origin')} {!editingId && <span className="text-red-600 dark:text-red-400">*</span>}
              </label>
              <div className={!editingId && !form.country_of_origin?.trim() ? 'ring-1 ring-red-500/40 rounded' : ''}>
                <SearchableSelect options={countryOptions} value={form.country_of_origin} onChange={val => setForm(p => ({ ...p, country_of_origin: val }))} placeholder={t('wms_search_country')} testId="rcv-country" allowCreate={false} />
              </div>
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground block mb-1">
                {t('fabric_content')} {!editingId && <span className="text-red-600 dark:text-red-400">*</span>}
              </label>
              <div className={!editingId && !form.fabric_content?.trim() ? 'ring-1 ring-red-500/40 rounded' : ''}>
                <SearchableSelect options={fabricOptions} value={form.fabric_content} onChange={val => setForm(p => ({ ...p, fabric_content: val }))} placeholder={t('wms_search_fabric')} testId="rcv-fabric" allowCreate={false} />
              </div>
            </div>
          </div>
          {/* Cantidad — modelo simple antipendejos: piezas por caja + N° de cajas
              + piezas sueltas (caja incompleta). El total se calcula solo. */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <div>
              <label className="text-xs text-muted-foreground mb-1 block">Piezas por caja</label>
              <input
                type="number" min="1" step="1" placeholder="72"
                value={unitsPerBox}
                onChange={e => setUnitsPerBox(toIntStr(e.target.value))}
                disabled={!!editingId}
                className="w-full px-3 py-2 bg-background border border-border rounded text-sm text-foreground font-mono disabled:opacity-50 disabled:cursor-not-allowed"
                data-testid="rcv-units-per-box"
              />
              <p className="text-xs text-muted-foreground mt-1">Default 72. Cámbialo si la caja trae otra cantidad (ej. 60).</p>
            </div>
            <div>
              <label className="text-xs text-muted-foreground mb-1 block">N° de cajas</label>
              <input
                type="number" min="0" step="1" placeholder="0"
                value={form.boxes}
                onChange={e => setForm(p => ({ ...p, boxes: toIntStr(e.target.value) }))}
                disabled={!!editingId}
                className="w-full px-3 py-2 bg-background border border-border rounded text-sm text-foreground disabled:opacity-50 disabled:cursor-not-allowed"
                data-testid="rcv-boxes"
              />
              <p className="text-xs text-muted-foreground mt-1">Cajas completas de {effectiveUpb} pzs c/u.</p>
            </div>
            <div>
              <label className="text-xs text-muted-foreground mb-1 block">Piezas sueltas <span className="normal-case text-muted-foreground/70">(opcional)</span></label>
              <input
                type="number" min="0" step="1" placeholder="0"
                value={form.loose}
                onChange={e => setForm(p => ({ ...p, loose: toIntStr(e.target.value) }))}
                disabled={!!editingId}
                className="w-full px-3 py-2 bg-background border border-border rounded text-sm text-foreground disabled:opacity-50 disabled:cursor-not-allowed"
                data-testid="rcv-loose"
              />
              <p className="text-xs text-muted-foreground mt-1">Caja incompleta (menos de {effectiveUpb}).</p>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs text-muted-foreground mb-1 block">Total a recibir (auto)</label>
              <input type="number" value={totalUnits} readOnly className="w-full px-3 py-2 bg-muted/50 border border-border rounded-md text-base text-foreground font-semibold tabular-nums" data-testid="rcv-total" />
              <p className="text-xs text-muted-foreground mt-1">
                {(parseInt(form.boxes) || 0)} caja(s) × {effectiveUpb}{(parseInt(form.loose) || 0) > 0 ? ` + ${parseInt(form.loose)} sueltas` : ''} = <span className="font-semibold text-foreground">{totalUnits} pzs</span>
              </p>
            </div>
            <div>
              <label className="text-xs text-muted-foreground mb-1 block">{t('sku')} (auto)</label>
              <input value={form.sku} readOnly className="w-full px-3 py-2 bg-secondary/50 border border-border rounded text-sm text-foreground font-mono cursor-not-allowed" />
            </div>
          </div>
          {/* Ubicación de recibo eliminada a propósito: el destino se decide con
              "Recibir a Carro" (abajo). "Recibir" normal deja el material en
              UBICACION TEMPORAL (default del backend), evitando bins fantasma por
              texto libre. */}
          {/* Casilla "BACK ORDER (B.O.)" eliminada: mezclaba un tag confuso con la
              impresión de etiquetas. Ahora TODO recibo imprime etiqueta automática
              (ver handlePrintLabel en el submit). */}
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium text-foreground">{t('total')}: <span className="font-semibold tabular-nums">{totalUnits}</span> {t('wms_units')}</span>
          </div>
          <div className="flex flex-wrap gap-2 items-center">
            {/* No hay botón "Revisar y Recibir" ni edición de recibos: NO se
                edita un recibo existente. Todo material se recibe con
                "Recibir a Carro" (que incluye la opción "Ubicación Temporal
                legacy" al fondo del menú). */}
            {!editingId && (
              <div className="relative" ref={cartMenuRef}>
                <Btn
                  variant="primary"
                  onClick={() => setShowCartMenu(s => !s)}
                  disabled={loading}
                  data-testid="rcv-submit-cart"
                  title="Recibir esta caja a un carro de Putaway 2.0 — quedará en el carro hasta que la ubiques manualmente."
                >
                  {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Truck className="w-4 h-4" />}
                  Recibir a Carro
                  <ChevronDown className="w-3.5 h-3.5 opacity-70" />
                </Btn>
                {showCartMenu && (
                  <div className="absolute z-30 right-0 mt-1 w-56 bg-popover border border-border rounded-lg shadow-xl overflow-hidden">
                    {(transitCarts.length > 0 ? transitCarts :
                      Array.from({ length: 50 }, (_, i) => ({ name: `CARRO ${i + 1}`, boxes: 0 }))
                    ).map(c => (
                      <button
                        key={c.name}
                        onClick={() => requestSubmit({ toLocation: c.name })}
                        disabled={loading}
                        className="w-full text-left px-3 py-2 text-sm hover:bg-muted flex items-center justify-between gap-2 disabled:opacity-50"
                        data-testid={`rcv-submit-cart-${c.name.replace(/\s+/g, '-').toLowerCase()}`}
                      >
                        <span className="flex items-center gap-2 font-mono font-medium text-foreground">
                          <Truck className="w-3.5 h-3.5 text-muted-foreground" /> {c.name}
                        </span>
                        <span className="text-xs text-muted-foreground tabular-nums">
                          {c.boxes || 0} cajas
                        </span>
                      </button>
                    ))}
                    <button
                      onClick={() => requestSubmit({ toLocation: TRANSIT_LOCATION })}
                      disabled={loading}
                      className="w-full text-left px-3 py-2 text-xs border-t border-border hover:bg-muted text-muted-foreground disabled:opacity-50"
                      title="Ubicación temporal legacy — solo si ninguno de los carros aplica."
                      data-testid="rcv-submit-temporal"
                    >
                      ⏸ Ubicación Temporal (legacy)
                    </button>
                  </div>
                )}
              </div>
            )}
            <Btn onClick={() => setShowForm(false)}>{t('cancel')}</Btn>
          </div>
        </div>
      )}
      {/* ── Resumen previo a confirmar: lo que se va a crear, en cristiano,
          con las advertencias no bloqueantes. Confirmar dispara el submit real
          (el backend revalida todo de todas formas). ── */}
      {pendingSubmit && (
        <div className="fixed inset-0 z-[100] bg-black/70 backdrop-blur-sm flex items-center justify-center p-4" data-testid="rcv-summary-modal">
          <div className="w-full max-w-lg bg-card border border-border rounded-lg shadow-xl overflow-hidden">
            <div className="px-5 py-4 border-b border-border/20 flex items-center gap-2">
              <ClipboardCheck className="w-5 h-5 text-muted-foreground" />
              <span className="font-semibold text-sm">Revisar y confirmar recepción</span>
            </div>
            <div className="p-5 space-y-4 max-h-[60vh] overflow-y-auto custom-scrollbar">
              <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-sm">
                <span className="text-xs font-medium text-muted-foreground">Cliente</span>
                <span className="font-medium">{form.customer}</span>
                <span className="text-xs font-medium text-muted-foreground">Producto</span>
                <span className="font-mono font-medium">{form.style} / {form.color} / {form.size}</span>
                <span className="text-xs font-medium text-muted-foreground">UPC</span>
                <span className="font-mono">{upcDoc?.upc || (upc.trim() ? `${upc.trim().toUpperCase()} (sin catálogo)` : '— sin UPC —')}</span>
                <span className="text-xs font-medium text-muted-foreground">ASN</span>
                <span className="font-mono">{form.asn_reference}{selectedAsnLine != null ? ` · línea ${selectedAsnLine}` : ''}</span>
                <span className="text-xs font-medium text-muted-foreground">Destino</span>
                <span className="font-mono font-medium">{pendingSubmit.opts.toLocation || 'UBICACION TEMPORAL'}</span>
              </div>
              <div className="rounded-lg border border-border bg-muted/30 p-3 text-center">
                <div className="text-2xl font-semibold tracking-tight tabular-nums">
                  {(parseInt(form.boxes) || 0).toLocaleString()} caja(s) × {effectiveUpb}
                  {(parseInt(form.loose) || 0) > 0 ? ` + ${parseInt(form.loose)} sueltas` : ''}
                </div>
                <div className="text-sm font-medium text-muted-foreground mt-1">
                  = {totalUnits.toLocaleString()} piezas
                </div>
              </div>
              {pendingSubmit.warnings.length > 0 && (
                <SoftAlert tone="warning">
                  <div className="space-y-1.5">
                    {pendingSubmit.warnings.map((w, i) => (
                      <div key={i} className="flex items-start gap-2 text-xs text-amber-700 dark:text-amber-300">
                        <AlertTriangle className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
                        <span>{w}</span>
                      </div>
                    ))}
                  </div>
                </SoftAlert>
              )}
            </div>
            <div className="px-5 py-3 border-t border-border/20 flex justify-end gap-2">
              <Btn
                onClick={() => setPendingSubmit(null)}
                data-testid="rcv-summary-cancel"
              >
                Volver
              </Btn>
              <Btn
                variant="primary"
                onClick={() => { const p = pendingSubmit; setPendingSubmit(null); handleSubmit(p.opts); }}
                disabled={loading}
                data-testid="rcv-summary-confirm"
              >
                {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Package className="w-4 h-4" />}
                Confirmar recepción
              </Btn>
            </div>
          </div>
        </div>
      )}
      <div className="grid grid-cols-1 gap-3 overflow-y-auto max-h-[600px] pr-2 custom-scrollbar">
        {records.map(r => (
          <div key={r.receiving_id} className="border border-border rounded-lg p-4 bg-card hover:bg-muted/40 transition-colors" data-testid={`rcv-${r.receiving_id}`}>
            <div className="flex items-center justify-between gap-4">
              <div className="flex items-center gap-4 min-w-0">
                <div className="min-w-0">
                  <div className="flex items-center gap-2 mb-0.5">
                    <span className="font-mono font-semibold text-sm">
                      {r.style || t('wms_no_style')}
                    </span>
                    <span className="text-xs font-medium bg-muted px-2 py-0.5 rounded-md text-muted-foreground">
                      {r.receiving_id}
                    </span>
                  </div>
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                    <span className="text-xs font-medium text-foreground truncate max-w-[150px]">{r.customer || t('wms_no_client')}</span>
                    <span className="text-xs text-muted-foreground">{r.color} / {r.size || 'N/A'}</span>
                    {r.inv_location && (
                      <span className="text-xs font-mono text-muted-foreground bg-muted px-2 py-0.5 rounded-md flex items-center gap-1">
                        <MapPin className="w-2.5 h-2.5" /> {r.inv_location}
                      </span>
                    )}
                    {r.is_bpo && (
                      <Chip tone="warning">
                        B.O.
                      </Chip>
                    )}
                  </div>
                </div>
              </div>

              <div className="flex items-center gap-4 flex-shrink-0">
                <div className="text-right">
                  <div className="text-lg font-semibold tabular-nums leading-none">
                    {(r.total_units || r.units || 0).toLocaleString()}
                    <span className="text-xs font-normal text-muted-foreground ml-1">Units</span>
                  </div>
                  <div className="text-xs text-muted-foreground mt-1">
                    {new Date(r.created_at).toLocaleDateString(undefined, { day: '2-digit', month: 'short' })}
                  </div>
                </div>

                <div className="flex items-center gap-2 h-10 border-l border-border/60 pl-4">
                  <button
                    onClick={() => handlePrintLabel(r)}
                    className="p-2 text-muted-foreground hover:text-foreground rounded-md hover:bg-muted transition-colors"
                    title="Imprimir etiqueta"
                    data-testid={`rcv-print-${r.receiving_id}`}
                  >
                    <Printer className="w-5 h-5" />
                  </button>
                </div>
              </div>
            </div>

            {/* Detalles expandibles sutiles */}
            <div className="mt-3 pt-3 border-t border-border/60 flex gap-4 text-xs text-muted-foreground">
              <span className="flex items-center gap-1"><Factory className="w-3 h-3" /> {r.manufacturer || '-'}</span>
              <span className="flex items-center gap-1">LOT: {r.lot_number || '-'}</span>
              <span className="ml-auto text-muted-foreground/60">By: {r.received_by_name || 'System'}</span>
            </div>
          </div>
        ))}
        {records.length === 0 && !search.trim() && (
          <div className="py-16 text-center">
            <p className="text-sm font-semibold text-foreground/80">Busca un recibo</p>
            <p className="text-sm text-muted-foreground mt-1">Escribe el N° de recibo o el nombre del cliente arriba</p>
          </div>
        )}
        {records.length === 0 && search.trim() && !searching && (
          <div className="py-16 text-center">
            <p className="text-sm font-semibold text-foreground/80">Sin resultados</p>
            <p className="text-sm text-muted-foreground mt-1">No hay recibos que coincidan con "{search.trim()}"</p>
          </div>
        )}
      </div>


      {/* Create ASN inline modal */}
      {createAsnOpen && (
        <div className="fixed inset-0 z-[80] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm animate-in fade-in duration-150">
          <div className="bg-card border border-border rounded-lg w-full max-w-2xl max-h-[85vh] flex flex-col shadow-xl animate-in zoom-in-95 duration-150">
            <div className="flex items-center justify-between p-5 border-b border-border/20">
              <div>
                <h3 className="font-semibold text-sm">Crear ASN manualmente</h3>
                <p className="text-xs text-muted-foreground">
                  Captura mínima del packing list — luego puedes recibir contra este ASN.
                </p>
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
                  <label className="text-xs font-medium text-muted-foreground block mb-1">
                    N° ASN <span className="text-red-600 dark:text-red-400">*</span>
                  </label>
                  <input
                    value={asnDraft.asn_id}
                    onChange={e => setAsnDraft(p => ({ ...p, asn_id: e.target.value.trim() }))}
                    placeholder="Ej. 12345"
                    className="w-full px-3 py-2 bg-background border border-border rounded text-sm font-mono"
                    data-testid="asn-draft-id"
                  />
                </div>
                <div>
                  <label className="text-xs font-medium text-muted-foreground block mb-1">Vendor</label>
                  <input
                    value={asnDraft.vendor}
                    onChange={e => setAsnDraft(p => ({ ...p, vendor: e.target.value }))}
                    placeholder="Proveedor"
                    className="w-full px-3 py-2 bg-background border border-border rounded text-sm"
                  />
                </div>
                <div>
                  <label className="text-xs font-medium text-muted-foreground block mb-1">PO</label>
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
                  <span className="text-xs font-medium text-muted-foreground">
                    Líneas del packing list ({asnDraft.items.length})
                  </span>
                  <button
                    type="button"
                    onClick={addAsnDraftItem}
                    className="flex items-center gap-1 text-xs font-medium text-primary hover:underline"
                  >
                    <Plus className="w-3 h-3" /> Agregar línea
                  </button>
                </div>
                <div className="space-y-2">
                  {asnDraft.items.map((it, idx) => (
                    <div key={idx} className="grid grid-cols-12 gap-2 p-3 bg-muted/30 border border-border/60 rounded-lg">
                      <div className="col-span-3">
                        <label className="text-xs font-medium text-muted-foreground block mb-1">Part #*</label>
                        <input
                          value={it.part_number}
                          onChange={e => updateAsnDraftItem(idx, 'part_number', e.target.value)}
                          placeholder="Style"
                          className="w-full px-2 py-1.5 bg-background border border-border rounded text-xs font-mono"
                          data-testid={`asn-draft-pn-${idx}`}
                        />
                      </div>
                      <div className="col-span-4">
                        <label className="text-xs font-medium text-muted-foreground block mb-1">Descripción</label>
                        <input
                          value={it.description}
                          onChange={e => updateAsnDraftItem(idx, 'description', e.target.value)}
                          className="w-full px-2 py-1.5 bg-background border border-border rounded text-xs"
                        />
                      </div>
                      <div className="col-span-2">
                        <label className="text-xs font-medium text-muted-foreground block mb-1">Cant.*</label>
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
                        <label className="text-xs font-medium text-muted-foreground block mb-1">País</label>
                        <input
                          value={it.country}
                          onChange={e => updateAsnDraftItem(idx, 'country', e.target.value.toUpperCase())}
                          maxLength={3}
                          className="w-full px-2 py-1.5 bg-background border border-border rounded text-xs font-mono"
                        />
                      </div>
                      <div className="col-span-1">
                        <label className="text-xs font-medium text-muted-foreground block mb-1">Marca</label>
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
              <Btn
                variant="primary"
                onClick={handleCreateAsn}
                disabled={creatingAsn || !asnDraft.asn_id.trim()}
                className="flex-1"
                data-testid="asn-draft-submit"
              >
                {creatingAsn ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle2 className="w-4 h-4" />}
                Crear ASN
              </Btn>
              <Btn
                onClick={() => setCreateAsnOpen(false)}
                disabled={creatingAsn}
              >
                Cancelar
              </Btn>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
