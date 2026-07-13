import { useState, useEffect, useCallback, useRef } from "react";
import { toast } from "sonner";
import JsBarcode from "jsbarcode";
import { Plus, Loader2, Search, X, AlertTriangle, Printer, Zap, Edit3, ClipboardCheck, ClipboardList, CheckCircle, BarChart3, History, ExternalLink, Package, Trash2, Users, UserMinus, Calendar } from "lucide-react";
import SearchableSelect from "../SearchableSelect";
import { useLang } from "../../contexts/LanguageContext";
import { API, fetcher, poster, putter, logLoadError, useWmsSizes } from "./lib";
import { TicketStatus, PickingStatus, PickDestination } from "./constants";

const PRETK_MONTHS = ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic'];

// Deadline urgency color for a pre-ticket's cancel_date chip.
function deadlineInfo(dateStr) {
  const none = { bucket: 'none', order: 5, label: 'Sin fecha', cls: 'bg-secondary/60 text-muted-foreground border-border/30' };
  if (!dateStr) return none;
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return none;
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const dd = new Date(d); dd.setHours(0, 0, 0, 0);
  const days = Math.round((dd - today) / 86400000);
  const fmt = dd.toLocaleDateString();
  if (days < 0) return { bucket: 'overdue', order: 0, label: `Vencida · ${fmt}`, cls: 'bg-red-500/15 text-red-400 border-red-500/40' };
  if (days === 0) return { bucket: 'today', order: 1, label: `Hoy · ${fmt}`, cls: 'bg-orange-500/15 text-orange-400 border-orange-500/40' };
  if (days <= 7) return { bucket: 'week', order: 2, label: `${days}d · ${fmt}`, cls: 'bg-yellow-500/15 text-yellow-500 border-yellow-500/40' };
  return { bucket: 'later', order: 3, label: fmt, cls: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30' };
}

export const PickingModule = ({ currentUser } = {}) => {
  const { t } = useLang();
  const handlePrioritize = async (ticketId) => {
    try {
      const res = await putter(`/pick-tickets/${ticketId}/prioritize`);
      if (res.ok) {
        toast.success("Prioridad escalada a HOT");
        loadTickets();
      } else {
        const err = await res.json();
        toast.error(err.detail || "Error");
      }
    } catch { toast.error("Connection error"); }
  };
  const [tickets, setTickets] = useState([]);
  const [search, setSearch] = useState('');
  const [orders, setOrders] = useState([]);
  const [operators, setOperators] = useState([]);
  const [showForm, setShowForm] = useState(false);
  const [incidentTicket, setIncidentTicket] = useState(null);
  const [incidentDraft, setIncidentDraft] = useState({ sku: '', qty: '1', reason: 'Dañado', replacement_sizes: {}, replacement_description: '', notes: '' });
  const [incidentSaving, setIncidentSaving] = useState(false);
  const [confirmTicket, setConfirmTicket] = useState(null);
  const [confirmSaving, setConfirmSaving] = useState(false);
  const [editingTicket, setEditingTicket] = useState(null);
  const [loading, setLoading] = useState(false);
  const [sizeLocations, setSizeLocations] = useState({});
  const [options, setOptions] = useState({ customers: [], manufacturers: [], styles: [], colors: [] });
  // Catalogo curado: fuente autoritativa para customer/color (globales) y styles
  // (per-customer). Antes usabamos options.* que hace distinct de wms_inventory
  // — traia basura historica. Ahora el select ya solo ofrece valores validos.
  const [curated, setCurated] = useState({ customers: [], colors: [] });
  const [customerStyles, setCustomerStyles] = useState([]);
  // Duplicate-ticket warning: holds the existing ticket returned by the 409 guard
  const [dupWarning, setDupWarning] = useState(null); // null | { pendingPayload, existing_ticket }

  const isAdmin = ['admin', 'supersu', 'ceo'].includes(currentUser?.role);

  // Load customers + colores curados on mount (styles se cargan por customer abajo)
  useEffect(() => {
    fetcher('/inventory/options?').then(data => {
      setOptions(prev => ({ ...prev, customers: data.customers || [] }));
    }).catch(logLoadError('data'));
    fetcher('/catalogs').then(data => {
      const pick = (arr) => (Array.isArray(arr) ? arr : [])
        .map(x => (x?.value || '').toString().trim())
        .filter(Boolean)
        .sort((a, b) => a.localeCompare(b));
      setCurated({
        customers: pick(data.customers),
        colors: pick(data.colors),
      });
    }).catch(logLoadError('curated catalogs'));
  }, []);
  // Default = 'tickets' porque al abrir el modulo el foco es surtir lo ya creado.
  // Antes era 'pretickets' y provocaba reportes de "el ticket no aparece" cuando
  // en realidad estaba creado pero en el tab equivocado (ej. ticket 2123 del 6-jul
  // que ware house si tenia hecho pero el equipo veia solo Pretickets).
  const [activeTab, setActiveTab] = useState('tickets'); // pretickets | tickets | completed | dashboard

  const [stats, setStats] = useState(null);
  const [filterOp, setFilterOp] = useState('');
  const [selectedWorkload, setSelectedWorkload] = useState([]); // ticket_ids selected in the Carga tab
  const [pretkYear, setPretkYear] = useState(() => new Date().getFullYear());
  const [pretkMonth, setPretkMonth] = useState(() => new Date().getMonth()); // 0-11, or 'none'
  // Completed tickets are NOT loaded by default (they can be many) — only when
  // the user clicks "Cargar completadas", to save bandwidth/RAM.
  const [completedTickets, setCompletedTickets] = useState([]);
  const [completedLoaded, setCompletedLoaded] = useState(false);
  const [loadingCompleted, setLoadingCompleted] = useState(false);
  // Full size system (standard + admin-configured extras), single source of truth.
  const { adult: SIZES_ORDER, youth: YOUTH_SIZES, all: ALL_SIZES } = useWmsSizes();
  const emptyForm = { order_number: '', customer: '', manufacturer: '', style: '', color: '', quantity: 0, assigned_to: '', assigned_to_name: '', destination: PickDestination.PRODUCTION, board_category: 'UNSET', strategy: 'default', sizes: ALL_SIZES.reduce((acc, s) => ({ ...acc, [s]: '' }), {}) };
  const [form, setForm] = useState(emptyForm);

  // Cargar la lista curada de styles del customer activo. Sin cliente => vacia.
  // Este catalogo es la unica fuente valida para el dropdown de style (antes
  // usabamos options.styles del inventory distinct, que traia basura vieja).
  useEffect(() => {
    const c = (form.customer || '').trim();
    if (!c) { setCustomerStyles([]); return; }
    fetcher(`/catalogs/styles?customer=${encodeURIComponent(c)}`)
      .then(d => setCustomerStyles(d?.styles || []))
      .catch(() => setCustomerStyles([]));
  }, [form.customer]);

  // Progressive ticket loading state
  const [ticketsTotal, setTicketsTotal] = useState(0);
  const [loadingMoreTickets, setLoadingMoreTickets] = useState(false);
  const [ticketsCapped, setTicketsCapped] = useState(false);
  const TICKETS_PAGE_SIZE = 50;
  // Small throttle between chunks so the UI can paint without hammering the API.
  // (Was 1500ms, which made a 500-ticket board take ~15s to fully load.)
  const TICKETS_CHUNK_DELAY_MS = 250;
  // Cap how many ticket cards we hold/paint at once so big boards don't crush
  // warehouse-device RAM. Use the search box to narrow beyond this.
  const MAX_TICKETS = 600;
  const loadGenRef = useRef(0);

  const loadTickets = useCallback(() => {
    const myGen = ++loadGenRef.current;
    setTickets([]);
    setTicketsTotal(0);
    setTicketsCapped(false);
    setLoadingMoreTickets(true);

    const fetchChunk = async (skip) => {
      const params = new URLSearchParams({ paginated: 'true', limit: String(TICKETS_PAGE_SIZE), skip: String(skip), exclude_completed: 'true' });
      try {
        const data = await fetcher(`/pick-tickets?${params.toString()}`);
        if (myGen !== loadGenRef.current) return;
        const items = data.items || [];
        setTickets(prev => [...prev, ...items]);
        setTicketsTotal(data.total || 0);
        if (data.has_more && (skip + TICKETS_PAGE_SIZE) < MAX_TICKETS) {
          setTimeout(() => fetchChunk(skip + TICKETS_PAGE_SIZE), TICKETS_CHUNK_DELAY_MS);
        } else {
          if (data.has_more) setTicketsCapped(true); // hit the cap; more exist server-side
          setLoadingMoreTickets(false);
        }
      } catch (err) {
        if (myGen === loadGenRef.current) setLoadingMoreTickets(false);
        logLoadError('pick-tickets chunk')(err);
      }
    };

    fetchChunk(0);
  }, []);
  const loadCompletedTickets = useCallback(() => {
    setLoadingCompleted(true);
    fetcher('/pick-tickets?status=confirmed&paginated=true&limit=300&skip=0')
      .then(data => { setCompletedTickets(data.items || []); setCompletedLoaded(true); })
      .catch(logLoadError('completed-tickets'))
      .finally(() => setLoadingCompleted(false));
  }, []);
  const loadOrders = useCallback(() => { fetcher('/orders').then(setOrders).catch(logLoadError('data')); }, []);
  const loadOperators = useCallback(() => { fetcher('/operators').then(setOperators).catch(logLoadError('data')); }, []);
  const loadStats = useCallback(() => { fetcher('/pick-tickets/stats').then(setStats).catch(logLoadError('data')); }, []);
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
      const dest = order.art_neck_status ? PickDestination.NECK_CUTTING : PickDestination.PRODUCTION;
      setForm(p => ({ ...p, customer, quantity: order.quantity || 0, destination: dest }));
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
      const url = `${API}/inventory/locations-lookup?${params.toString()}`;
      const resp = await fetch(url, { credentials: 'include' });
      if (!resp.ok) { setSizeLocations({}); return; }
      const data = await resp.json();
      setSizeLocations(data.sizes || {});
    } catch(e) { setSizeLocations({}); }
  }, []);

  const updateSize = (size, val) => setForm(p => ({ ...p, sizes: { ...p.sizes, [size]: val } }));
  const getSizeLocs = (sz) => sizeLocations[sz]?.locations || (Array.isArray(sizeLocations[sz]) ? sizeLocations[sz] : []);
  const getTotalAvail = (sz) => getSizeLocs(sz).reduce((sum, loc) => sum + (loc.available || 0), 0);
  const totalPick = Object.values(form.sizes).reduce((s, v) => s + (parseInt(v) || 0), 0);
  // Show youth size rows only when the selected style's inventory is youth (its
  // location lookup returns Y-prefixed sizes). Adult styles keep the adult grid
  // unchanged so operators don't get confused.
  // A style can carry BOTH adult and youth sizes (e.g. 5000B has S/M/L/XL AND
  // YXS..YXL). Show adult-only or youth-only when the inventory is purely one,
  // but the UNION (ALL_SIZES) when both are present — otherwise the youth check
  // would flip the grid to youth-only and hide the adult sizes (L/XL/etc.).
  const _sizeKeys = Object.keys(sizeLocations);
  const _hasYouth = _sizeKeys.some(s => String(s).toUpperCase().startsWith('Y'));
  const _hasAdult = _sizeKeys.some(s => s && !String(s).toUpperCase().startsWith('Y'));
  const gridSizes = (_hasYouth && _hasAdult) ? ALL_SIZES : (_hasYouth ? YOUTH_SIZES : SIZES_ORDER);

  const openEdit = (t) => {
    setEditingTicket(t);
    const sizesObj = {};
    ALL_SIZES.forEach(sz => { sizesObj[sz] = t.sizes?.[sz] || ''; });
    setForm({
      order_number: t.order_number || '', customer: t.customer || '', manufacturer: t.manufacturer || '',
      style: t.style || '', color: t.color || '', quantity: t.quantity || 0,
      assigned_to: t.assigned_to || '', assigned_to_name: t.assigned_to_name || '',
      destination: t.destination || PickDestination.PRODUCTION, board_category: t.board_category || 'UNSET', strategy: t.strategy || 'default', sizes: sizesObj
    });
    setSizeLocations(t.size_locations || {});
    if (t.customer) loadOptions(t.customer, t.manufacturer || '', t.style || '');
    if (t.style) lookupLocations(t.style, t.color);
    setShowForm(true);
  };

  const resetForm = () => {
    setEditingTicket(null);
    setForm(emptyForm);
    setSizeLocations({}); setOptions({ manufacturers: [], styles: [], colors: [] });
    setShowForm(false);
  };

  const handleSubmit = async (forceDuplicate = false) => {
    if (!form.order_number || !form.style) { toast.error(t('order_style_req')); return; }
    if (totalPick === 0) { toast.error(t('enter_qty_size')); return; }
    setLoading(true);
    
    // React passes the SyntheticEvent to onClick handlers. If forceDuplicate is an object, ignore it.
    const isForce = forceDuplicate === true;

    try {
      const payload = {
        ...form,
        client: form.customer,
        sizes: Object.fromEntries(Object.entries(form.sizes).map(([k, v]) => [k, parseInt(v) || 0])),
        ...(isForce ? { force_duplicate: true } : {}),
      };
      let res;
      if (editingTicket && !editingTicket.is_virtual) {
        res = await putter(`/pick-tickets/${editingTicket.ticket_id}/edit`, payload);
      } else {
        res = await poster('/pick-tickets', payload);
      }
      if (res.ok) {
        toast.success(editingTicket && !editingTicket.is_virtual ? t('ticket_updated') : t('ticket_created'));
        setDupWarning(null);
        resetForm();
        loadTickets(); loadStats();
      } else if (res.status === 409) {
        // Existing active ticket found — show warning modal instead of hard error
        const err = await res.json().catch(() => ({}));
        const detail = err.detail || err;
        setDupWarning({
          pendingPayload: payload,
          existing: detail.existing_ticket || {},
          message: detail.message || 'Ya existe un pick ticket activo para esta orden.',
        });
      } else {
        const err = await res.json().catch(() => ({}));
        toast.error(err.detail || t('error'));
      }
    } catch { toast.error(t('conn_error')); }
    finally { setLoading(false); }
  };

  // Called when user clicks "Create anyway" in the duplicate warning modal
  const handleForceDuplicate = async () => {
    if (!dupWarning) return;
    setDupWarning(null);
    await handleSubmit(true);
  };

  // Open the confirm modal (replaces the old blocking window.confirm).
  const handleConfirm = (ticket) => setConfirmTicket(ticket);

  const doConfirm = async () => {
    const ticket = confirmTicket;
    if (!ticket) return;
    setConfirmSaving(true);
    try {
      const res = await putter(`/pick-tickets/${ticket.ticket_id}/confirm`, { lines: ticket.lines || [] });
      if (res.ok) { toast.success(t('pick_confirmed')); setConfirmTicket(null); loadTickets(); loadStats(); }
      else { const err = await res.json().catch(() => ({})); toast.error(err.detail || t('error')); }
    } catch { toast.error(t('conn_error')); }
    finally { setConfirmSaving(false); }
  };

  const openIncident = (ticket) => {
    setIncidentTicket(ticket);
    const initSizes = Object.keys(ticket.sizes || {}).reduce((acc, sz) => ({ ...acc, [sz]: '' }), {});
    setIncidentDraft({ sku: ticket.style || '', qty: '1', reason: 'Dañado', replacement_sizes: initSizes, replacement_description: '', notes: '' });
  };

  const submitIncident = async () => {
    if (!incidentTicket) return;
    const qty = parseInt(incidentDraft.qty);
    if (Number.isNaN(qty) || qty < 1) { toast.error(t('qty') + ' ≥ 1'); return; }
    setIncidentSaving(true);
    try {
      const replacement_sizes = Object.fromEntries(
        Object.entries(incidentDraft.replacement_sizes).map(([k, v]) => [k, parseInt(v) || 0])
      );
      const replacement_qty = Object.values(replacement_sizes).reduce((s, v) => s + v, 0);
      const res = await poster(`/pick-tickets/${incidentTicket.ticket_id}/incidents`, {
        sku: incidentDraft.sku,
        qty,
        reason: incidentDraft.reason,
        replacement_sizes,
        replacement_qty,
        replacement_description: incidentDraft.replacement_description,
        notes: incidentDraft.notes,
      });
      if (res.ok) {
        const result = await res.json();
        if (result.replacement_qty > 0) {
          toast.success(result.inventory_deducted
            ? `Incidencia reportada — ${result.replacement_qty} prendas descontadas del inventario`
            : 'Incidencia reportada (revisa el inventario manualmente)'
          );
        } else {
          toast.success(t('incident_reported_success') || 'Incidencia reportada correctamente');
        }
        setIncidentTicket(null);
      } else {
        const err = await res.json().catch(() => ({}));
        toast.error(err.detail || 'Error al reportar');
      }
    } catch { toast.error('Error de conexión'); }
    finally { setIncidentSaving(false); }
  };

  const handleQuickStatus = async (ticket_id, new_status) => {
    try {
      const res = await putter(`/pick-tickets/${ticket_id}/status`, { blank_status: new_status });
      if (res.ok) { toast.success(t('status_updated')); loadTickets(); }
      else { const err = await res.json().catch(() => ({})); toast.error(err.detail || t('error')); }
    } catch { toast.error(t('conn_error')); }
  };

  const handleDismissPreticket = async (orderNumber) => {
    if (!window.confirm("¿Estás seguro de que quieres ocultar este pre-ticket?")) return;
    try {
      await fetcher(`/pick-tickets/virtual/${orderNumber}/dismiss`, { method: 'PUT' });
      toast.success('Pre-ticket ocultado correctamente');
      loadTickets();
    } catch { toast.error('Error al ocultar pre-ticket'); }
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

  // Carga tab: multi-select reassignment/removal.
  const toggleWorkloadSelect = (id) =>
    setSelectedWorkload(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]);
  const toggleWorkloadGroup = (ids, allSelected) =>
    setSelectedWorkload(prev => allSelected ? prev.filter(x => !ids.includes(x)) : [...new Set([...prev, ...ids])]);
  const handleBulkAssign = async (user_val) => {
    const ids = [...selectedWorkload];
    if (ids.length === 0) return;
    if (!user_val && !window.confirm(`¿Retirar ${ids.length} ticket(s) de su operador?`)) return;
    const op = operators.find(o => o.user_id === user_val || o.email === user_val) || {};
    const payload = {
      operator_id: user_val || "", operator_name: op.name || op.email || "",
      assigned_to: user_val || "", assigned_to_name: op.name || op.email || "",
    };
    let ok = 0, fail = 0;
    for (const id of ids) {
      try { const res = await putter(`/pick-tickets/${id}/assign`, payload); res.ok ? ok++ : fail++; }
      catch { fail++; }
    }
    setSelectedWorkload([]);
    loadTickets(); loadStats();
    if (ok) toast.success(`${ok} ticket(s) ${user_val ? 'reasignado(s)' : 'retirado(s)'}`);
    if (fail) toast.error(`${fail} ticket(s) fallaron`);
  };

  const handlePrint = (ticket) => {
    const pw = window.open('', '_blank');
    if (!pw) { toast.error(t('allow_popups')); return; }
    // Render the barcode locally (no external CDN) so labels print even when the
    // warehouse PC is offline. Serialize an off-DOM <svg> into the popup markup.
    let barcodeMarkup = '';
    try {
      const svgEl = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      JsBarcode(svgEl, ticket.ticket_id, { width: 1.5, height: 35, displayValue: false, margin: 0 });
      barcodeMarkup = new XMLSerializer().serializeToString(svgEl);
    } catch (e) { barcodeMarkup = ''; }
    const sizes = ticket.sizes || {};
    const sizeLocs = ticket.size_locations || {};
    const pickedSizes = ticket.picked_sizes || {};
    // Reprint shows the FULL order (every requested size). Already-picked sizes are
    // marked as SURTIDO; partials show how much is left vs required, so the picker
    // sees the whole ticket and what's still pending, not only the remainder.
    const pickedFor = (sz) => {
      const v = pickedSizes[sz];
      if (v == null) return 0;
      return parseInt(typeof v === 'object' ? v.total : v) || 0;
    };
    const reqFor = (sz) => parseInt(sizes[sz]) || 0;
    const pendingFor = (sz) => Math.max(0, reqFor(sz) - pickedFor(sz));
    const totalQty = ALL_SIZES.reduce((s, sz) => s + reqFor(sz), 0);
    const totalPicked = ALL_SIZES.reduce((s, sz) => s + Math.min(pickedFor(sz), reqFor(sz)), 0);
    const totalPending = ALL_SIZES.reduce((s, sz) => s + pendingFor(sz), 0);
    const isPartial = totalPicked > 0 && totalPending > 0;
    const gridRows = ALL_SIZES.filter(sz => reqFor(sz) > 0).map(sz => {
      const req = reqFor(sz), picked = pickedFor(sz), pend = pendingFor(sz);
      const done = pend === 0;             // size fully picked
      const started = picked > 0 && !done; // size partially picked
      const rowBg = done ? 'background:#dcfce7' : (started ? 'background:#fef9c3' : '');
      let qtyCell;
      if (done) {
        qtyCell = `<span style="color:#15803d">&#10003; ${req}</span><div style="font-size:9px;color:#15803d;font-weight:normal">SURTIDO</div>`;
      } else if (started) {
        qtyCell = `${pend} <span style="font-size:10px;color:#888;font-weight:normal">/ ${req}</span><div style="font-size:9px;color:#b45309;font-weight:normal">surtido ${picked}</div>`;
      } else {
        qtyCell = `${req}`;
      }
      const locs = (sizeLocs[sz]?.locations || sizeLocs[sz] || []).slice(0, 3);
      const locStr = locs.map(l => {
        let s = `${l.location} (${l.available})`;
        if (l.country_of_origin) s += ` [${l.country_of_origin}]`;
        if (l.percentage !== undefined) s += ` ${l.percentage}%`;
        return s;
      }).join(', ') || '-';
      return `<tr style="${rowBg}"><td style="border:1px solid #000;padding:4px 8px;font-weight:bold;text-align:center;font-size:16px">${sz}</td><td style="border:1px solid #000;padding:4px 8px;text-align:center;font-size:20px;font-weight:bold">${qtyCell}</td><td style="border:1px solid #000;padding:4px 8px;font-size:11px;font-family:monospace">${locStr}</td></tr>`;
    }).join('');
    const partialBanner = isPartial
      ? `<div style="text-align:center;font-size:11px;font-weight:bold;color:#b45309;border:1px dashed #b45309;border-radius:4px;padding:2px 4px;margin:4px 0">SURTIDO PARCIAL · ${totalPicked} de ${totalQty} · FALTAN ${totalPending}</div>`
      : '';
    // Orden #: se imprime grande arriba (recuadro) y se repite en la columna
    // derecha para que el equipo NO tenga que escribirlo con pluma. El ticket_id
    // sigue en fuente chica abajo del recuadro derecho porque es el codigo que
    // se escanea desde el PDA.
    const orderNo = ticket.order_number || '—';
    // Comodin: 2% extra del total para reponer defectos / cortes malos.
    // Se redondea hacia arriba para no dejar al equipo corto.
    const comodinPct = 0.02;
    const comodinQty = Math.ceil(totalQty * comodinPct);
    const comodinTotal = totalQty + comodinQty;
    pw.document.write(`<html><head><title>Pick Ticket - ${ticket.ticket_id}</title><style>@page{size:4in 6in;margin:6mm}body{font-family:Arial,sans-serif;margin:0;padding:10px;width:3.6in}@media print{body{padding:0}}</style></head><body><div style="text-align:center;font-size:16px;font-weight:bold;margin-bottom:2px">${ticket.customer || ''}</div><div style="text-align:center;font-size:26px;font-weight:900;margin:8px 0 14px;letter-spacing:1px;line-height:1.1">ORDEN #${orderNo}</div><div style="text-align:center;margin:0 0 6px">${barcodeMarkup}</div>${partialBanner}<div style="display:flex;justify-content:space-between;margin-bottom:4px"><div><div style="font-size:13px;font-weight:bold">${ticket.customer || ''}</div><div style="font-size:12px;font-weight:bold">${ticket.manufacturer || ''}</div><div style="font-size:12px;font-weight:bold">${ticket.color || ''}</div></div><div style="text-align:right;line-height:1.4"><div style="font-size:9px;color:#666">Style</div><div style="font-size:20px;font-weight:900;line-height:1.1">${ticket.style || ''}</div><div style="font-size:9px;color:#666;margin-top:3px">Total</div><div style="font-size:16px;font-weight:bold;line-height:1.1">${totalQty}</div><div style="font-size:7px;color:#888;font-family:monospace;margin-top:4px">${ticket.ticket_id}</div></div></div><table style="width:100%;border-collapse:collapse;margin:6px 0"><thead><tr style="background:#eee"><th style="border:1px solid #000;padding:3px;font-size:10px">${t('size')}</th><th style="border:1px solid #000;padding:3px;font-size:10px">${t('qty')}</th><th style="border:1px solid #000;padding:3px;font-size:10px">${t('location')}</th></tr></thead><tbody>${gridRows}</tbody><tfoot><tr style="font-weight:bold;background:#eee"><td style="border:1px solid #000;padding:4px;text-align:center">${t('total')}</td><td style="border:1px solid #000;padding:4px;text-align:center;font-size:18px">${totalQty}${isPartial ? ` <span style="font-size:11px;color:#b45309;font-weight:normal">(faltan ${totalPending})</span>` : ''}</td><td style="border:1px solid #000;padding:4px"></td></tr><tr style="background:#fef3c7"><td style="border:1px solid #000;padding:4px;text-align:center;font-size:10px;font-weight:bold;color:#92400e">COMODÍN 2%</td><td style="border:1px solid #000;padding:4px;text-align:center;font-size:16px;font-weight:900;color:#92400e">+${comodinQty}</td><td style="border:1px solid #000;padding:4px;font-size:9px;color:#92400e;font-weight:bold">Total a surtir: ${comodinTotal}</td></tr></tfoot></table><div style="margin-top:12px;display:flex;gap:20px;font-size:11px"><div>${t('picker')}: ___________________</div><div>${t('date')}: ___________________</div></div><script>setTimeout(function(){window.print()},300);<\/script></body></html>`);
    pw.document.close();
  };

  const filteredTickets = tickets.filter(t => {
    // Si el formulario de edicion esta abierto para este ticket, lo ocultamos de la lista
    // para evitar que el usuario se confunda pensando que esta duplicado.
    if (showForm && editingTicket && t.ticket_id === editingTicket.ticket_id) {
      return false;
    }
    // Busqueda orientada a lo que el usuario conoce: numero de orden (2123),
    // cliente (GOODIE...) o estilo (5000B). NO se matchea contra ticket_id
    // (pick_f42881fea8ef) porque es un ID hex interno que nadie tipea; si el
    // ticket_id impreso en la etiqueta se pega, el numero de orden basta.
    const term = search.trim().toLowerCase();
    if (!term) return true;
    return (
      (t.order_number || '').toString().toLowerCase().includes(term) ||
      (t.customer || '').toLowerCase().includes(term) ||
      (t.style || '').toLowerCase().includes(term) ||
      (t.color || '').toLowerCase().includes(term)
    );
  });

  const preTickets = filteredTickets.filter(t => t.is_virtual);
  const activeTickets = filteredTickets.filter(t => !t.is_virtual && t.status !== TicketStatus.CONFIRMED && t.picking_status !== PickingStatus.COMPLETED);

  // Workload grouped by operator (for the "Carga" tab): who has which active
  // tickets, so an admin can reassign or unassign by load.
  const UNASSIGNED_KEY = '__unassigned__';
  const workloadByOperator = (() => {
    const groups = {};
    for (const tk of activeTickets) {
      const id = (tk.assigned_to || '').trim() || UNASSIGNED_KEY;
      const name = id === UNASSIGNED_KEY ? 'Sin asignar' : (tk.assigned_to_name || tk.assigned_to || 'Operador');
      if (!groups[id]) groups[id] = { id, name, tickets: [], units: 0 };
      groups[id].tickets.push(tk);
      groups[id].units += Number(tk.total_pick_qty || 0);
    }
    // Surface operators with no load too, so you can see who's free.
    for (const op of operators) {
      if (op.user_id && !groups[op.user_id]) groups[op.user_id] = { id: op.user_id, name: op.name || op.email || op.user_id, tickets: [], units: 0 };
    }
    return Object.values(groups).sort((a, b) => {
      if (a.id === UNASSIGNED_KEY) return -1;
      if (b.id === UNASSIGNED_KEY) return 1;
      return b.tickets.length - a.tickets.length;
    });
  })();
  const unassignedCount = activeTickets.filter(t => !(t.assigned_to || '').trim()).length;
  const filteredCompleted = filterOp ? completedTickets.filter(t => t.assigned_to_name === filterOp) : completedTickets;

  // Case# 005: within active tickets, split those with picking progress
  // ("En avance" — includes partial-closed waiting on restock) from untouched
  // ones ("Sin iniciar"), so a partial pick never looks finished or lost.
  const ticketPicked = (t) => Object.values(t.picked_sizes || {})
    .reduce((s, v) => s + (parseInt(typeof v === 'object' && v ? v.total : v) || 0), 0);
  const hasProgress = (t) => ticketPicked(t) > 0 || t.picking_status === PickingStatus.IN_PROGRESS || t.partial_closed;
  const inProgressTickets = activeTickets.filter(hasProgress);
  const notStartedTickets = activeTickets.filter(t => !hasProgress(t));

  // New ticket card renderer (Premium Kanban style)
  const renderTicket = (ticket, showEdit = true) => {
    const sizes = ticket.sizes || {};
    const sizeLocs = ticket.size_locations || {};
    const hasSizes = Object.values(sizes).some(v => v > 0);
    const pickedSizes = ticket.picked_sizes || {};
    const totalReq = Object.values(sizes).reduce((s, v) => s + (parseInt(v) || 0), 0);
    const totalPkd = Object.values(pickedSizes).reduce((s, v) => {
      const val = typeof v === 'object' && v !== null ? v.total : v;
      return s + (parseInt(val) || 0);
    }, 0);
    const pct = totalReq > 0 ? Math.round((totalPkd / totalReq) * 100) : 0;

    const statusColors = {
      'pending': 'bg-blue-500/10 text-blue-400 border-blue-500/20',
      'in_progress': 'bg-yellow-500/10 text-yellow-400 border-yellow-500/20',
      'completed': 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20',
      'confirmed': 'bg-purple-500/10 text-purple-400 border-purple-500/20'
    };

    const currentStatus = ticket.picking_status === PickingStatus.COMPLETED ? PickingStatus.COMPLETED : ticket.picking_status || PickingStatus.PENDING;

    return (
      <div key={ticket.ticket_id} className={`group border border-border/40 rounded-xl transition-all relative shadow-sm flex flex-col md:flex-row md:items-center justify-between p-3 gap-4 ${ticket.is_virtual ? 'bg-secondary/20 border-dashed hover:bg-secondary/30' : 'bg-card/40 hover:bg-card'}`} data-testid={`pick-${ticket.ticket_id}`}>
        {/* Left Status Bar */}
        <div className={`absolute left-0 top-0 bottom-0 w-1 ${ticket.is_virtual ? 'bg-slate-400 opacity-30' : (currentStatus === PickingStatus.COMPLETED ? 'bg-emerald-500' : currentStatus === PickingStatus.IN_PROGRESS ? 'bg-yellow-500' : 'bg-blue-500')}`} />

        {/* Main Info */}
        <div className="flex-1 min-w-0 pl-2">
          <div className="flex items-center gap-2 mb-1">
            <span className="font-mono font-black text-primary text-sm uppercase tracking-tighter truncate max-w-[120px]" title={ticket.ticket_id}>
              {ticket.ticket_id.split('_')[1] || ticket.ticket_id}
            </span>
            <span className="text-[10px] font-black uppercase bg-secondary/80 px-2 py-0.5 rounded text-muted-foreground tracking-widest min-w-[50px] text-center">
              #{ticket.order_number}
            </span>
            {ticket.cancel_date && (() => {
              const di = deadlineInfo(ticket.cancel_date);
              return (
                <span className={`text-[9px] font-black uppercase px-1.5 py-0.5 rounded border flex items-center gap-1 ${di.cls}`} title="Fecha límite (cancel date)">
                  <Calendar className="w-2.5 h-2.5" /> {di.label}
                </span>
              );
            })()}
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
            {ticket.partial_closed && !ticket.is_virtual && (
              <span className="text-[9px] font-black uppercase bg-orange-500/20 px-2 py-0.5 rounded text-orange-400 tracking-widest border border-orange-500/30"
                title="Cerrado parcial — esperando más material. Reasigna el ticket cuando llegue stock.">
                Parcial · espera material
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
                onClick={() => openIncident(ticket)}
                className="p-1.5 text-red-400 hover:bg-red-500/10 rounded-xl transition-all"
                title={t('wms_report_incident') || 'Reportar Problema'}
              >
                <AlertTriangle className="w-4 h-4" />
              </button>
              <button onClick={() => handlePrint(ticket)} className="p-1.5 text-muted-foreground hover:text-primary hover:bg-primary/10 rounded-lg transition-all" title={t('print')}><Printer className="w-4 h-4" /></button>
              <button
                onClick={(e) => { e.stopPropagation(); handlePrioritize(ticket.ticket_id); }}
                className="p-1.5 text-red-400 hover:bg-red-500/10 rounded-lg transition-all group/hot"
                title="Marcar como HOT / RUSH"
              >
                <Zap className="w-4 h-4 group-hover/hot:scale-125 transition-transform" />
              </button>
            </>
          )}
          {ticket.is_virtual && isAdmin && (
            <button
              onClick={() => handleDismissPreticket(ticket.order_number)}
              className="p-1.5 text-red-400 hover:bg-red-500/10 rounded-xl transition-all mr-1"
              title="Eliminar Pre-Ticket (Admin)"
            >
              <Trash2 className="w-4 h-4" />
            </button>
          )}
          {showEdit && currentStatus !== PickingStatus.COMPLETED && (
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
          {ticket.status === TicketStatus.PENDING && !ticket.is_virtual && (
            <button onClick={() => handleConfirm(ticket)} className="px-2 py-1 bg-emerald-500 text-black text-[9px] font-black uppercase rounded hover:bg-emerald-400 transition-all shadow-sm ml-1">OK</button>
          )}
        </div>
      </div>
    );
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 bg-secondary/30 p-1 rounded-2xl border border-border/20">
          {[
            { id: 'pretickets', label: 'PRE-TICKETS', icon: ClipboardList, count: preTickets.length },
            { id: 'tickets', label: 'TICKETS (ACTIVOS)', icon: ClipboardCheck, count: activeTickets.length },
            { id: 'completed', label: t('wms_picking_completed'), icon: CheckCircle, count: completedLoaded ? completedTickets.length : undefined },
            { id: 'workload', label: 'CARGA', icon: Users, count: unassignedCount },
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
        <button
          onClick={() => {
            setEditingTicket(null);
            setForm(emptyForm);
            setSizeLocations({});
            setOptions(prev => ({ ...prev, manufacturers: [], styles: [], colors: [] }));
            setShowForm(true);
            setActiveTab('tickets');
          }}
          className="flex items-center gap-2 px-4 py-2.5 bg-primary text-black text-xs font-black uppercase tracking-wider rounded-xl hover:scale-105 transition-all shadow-lg shadow-primary/20 whitespace-nowrap"
        >
          <Plus className="w-4 h-4" />
          Nuevo Pick Ticket
        </button>
      </div>

      {/* Progressive load indicator */}
      {loadingMoreTickets && ticketsTotal > 0 && (
        <div className="flex items-center gap-3 text-[10px] font-black uppercase tracking-widest text-indigo-400 bg-indigo-500/5 border border-indigo-500/20 px-3 py-2 rounded-xl">
          <Loader2 className="w-3 h-3 animate-spin" />
          Cargando tickets {tickets.length.toLocaleString()} / {ticketsTotal.toLocaleString()}
          <div className="flex-1 h-1 bg-secondary/60 rounded-full overflow-hidden max-w-xs">
            <div className="h-full bg-indigo-400 transition-all" style={{ width: `${ticketsTotal > 0 ? (tickets.length / ticketsTotal) * 100 : 0}%` }} />
          </div>
        </div>
      )}
      {ticketsCapped && (
        <div className="text-[10px] font-black uppercase tracking-[0.15em] text-amber-500 bg-amber-500/5 border border-amber-500/20 px-3 py-2 rounded-xl">
          Mostrando los primeros {MAX_TICKETS.toLocaleString()} de {ticketsTotal.toLocaleString()} tickets — usa la búsqueda para acotar
        </div>
      )}

      {/* Search Bar */}
      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground opacity-50" />
        <input
          placeholder={t('wms_search_pick_hint') || "Buscar por N° de orden, cliente, estilo o color…"}
          value={search}
          onChange={e => setSearch(e.target.value)}
          className="w-full pl-10 pr-4 py-2.5 bg-card/40 border border-border/20 rounded-xl text-sm text-foreground focus:ring-2 focus:ring-primary/20 transition-all font-medium backdrop-blur-sm shadow-inner"
          data-testid="pick-search-input"
        />
        {search && (
          <button
            onClick={() => setSearch('')}
            className="absolute right-3 top-1/2 -translate-y-1/2 p-1 hover:bg-secondary rounded-full transition-colors"
          >
            <X className="w-3.5 h-3.5 text-muted-foreground" />
          </button>
        )}
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
              {!editingTicket && (
                <div className="text-[11px] text-muted-foreground mt-0.5">
                  {form.order_number && !orders.some(o => o.order_number === form.order_number)
                    ? <span className="text-amber-500 font-bold">⚠ Orden manual (no está en el sistema) — llena Customer / Style / tallas</span>
                    : '¿No aparece la orden? Escríbela y elige «Agregar …» para crear un ticket manual.'}
                </div>
              )}
            </div>
            <div>
              <label className="text-xs uppercase tracking-wider text-muted-foreground font-bold block mb-1">Customer</label>
              <SearchableSelect options={curated.customers.length ? curated.customers : (options.customers || [])} value={form.customer} onChange={handleCustomerChange} placeholder={t('wms_search_customer')} testId="pick-customer" allowCreate={false} />
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
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <div>
              <label className="text-xs uppercase tracking-wider text-muted-foreground font-bold block mb-1">{t('wms_qty_auto')}</label>
              <input type="number" value={form.quantity} onChange={e => setForm(p => ({ ...p, quantity: parseInt(e.target.value) || 0 }))} className="w-full px-3 py-2 bg-background border border-border rounded text-sm text-foreground" data-testid="pick-qty" />
            </div>
            <div>
              <label className="text-xs uppercase tracking-wider text-pink-500 font-black block mb-1">Destino</label>
              <select value={form.destination} onChange={e => setForm(p => ({ ...p, destination: e.target.value }))} className="w-full px-3 py-2 bg-pink-500/10 border border-pink-500/20 text-pink-500 rounded text-sm font-bold focus:ring-1 focus:ring-pink-500">
                <option value={PickDestination.PRODUCTION}>Producción Directa</option>
                <option value={PickDestination.NECK_CUTTING}>Corte de Neck</option>
              </select>
            </div>
            <div>
              <label className="text-xs uppercase tracking-wider text-indigo-400 font-black block mb-1">Estrategia de picking</label>
              <select
                value={form.strategy}
                onChange={e => setForm(p => ({ ...p, strategy: e.target.value }))}
                className="w-full px-3 py-2 bg-indigo-500/10 border border-indigo-500/20 text-indigo-400 rounded text-sm font-bold focus:ring-1 focus:ring-indigo-500"
                data-testid="pick-strategy"
                title="Cómo ordenar las ubicaciones que ve el operador"
              >
                <option value="default">Default (sistema)</option>
                <option value="proximity">Por cercanía (mismo pasillo)</option>
                <option value="origin">Por país de origen</option>
              </select>
            </div>
          </div>
          <div className="grid grid-cols-3 gap-3">
            <div>
              <label className="text-xs uppercase tracking-wider text-muted-foreground font-bold block mb-1">Manufacturer</label>
              <SearchableSelect options={options.manufacturers || []} value={form.manufacturer} onChange={handleManufacturerChange} placeholder={t('wms_search_manufacturer')} testId="pick-manufacturer" allowCreate={false} />
              {!form.customer && <div className="text-xs text-muted-foreground mt-0.5">{t('select_order_first')}</div>}
            </div>
            <div>
              <label className="text-xs uppercase tracking-wider text-muted-foreground font-bold block mb-1">Style</label>
              <SearchableSelect options={customerStyles} value={form.style} onChange={handleStyleChange} placeholder={form.customer && customerStyles.length === 0 ? 'Cliente sin catálogo curado' : t('wms_search_style')} testId="pick-style" allowCreate={false} disabled={!!form.customer && customerStyles.length === 0} />
            </div>
            <div>
              <label className="text-xs uppercase tracking-wider text-muted-foreground font-bold block mb-1">Color</label>
              <SearchableSelect options={curated.colors.length ? curated.colors : (options.colors || [])} value={form.color} onChange={handleColorChange} placeholder={t('wms_search_color')} testId="pick-color" allowCreate={false} />
              {form.style && !form.color && <div className="text-xs text-muted-foreground mt-0.5">{t('select_color_to_see_locs')}</div>}
            </div>
          </div>
          <div className="text-xs uppercase tracking-wider text-muted-foreground font-bold">{t('wms_size_locs')}</div>
          <div className="overflow-auto">
            <table className="w-full text-sm">
              <thead><tr className="text-xs uppercase text-muted-foreground"><th className="p-1 text-center w-16">{t('size')}</th><th className="p-1 text-center w-20">{t('qty')}</th><th className="p-1 text-left">{t('wms_loc_qty')}</th><th className="p-1 text-right w-20">{t('available')}</th></tr></thead>
              <tbody>
                {gridSizes.map(sz => (
                  <tr key={sz} className="border-b border-border/50">
                    <td className="p-1 text-center font-bold">{sz}</td>
                    <td className="p-1"><input type="number" min="0" value={form.sizes[sz]} onChange={e => updateSize(sz, e.target.value)} placeholder="0" className="w-full px-2 py-1.5 bg-background border border-border rounded text-center text-sm font-mono text-foreground" data-testid={`pick-size-${sz}`} /></td>
                    <td className="p-1">
                      {getSizeLocs(sz).length > 0 ? (
                        <div className="flex flex-wrap gap-2">
                          {getSizeLocs(sz).slice(0, 4).map((l, i) => (
                            <div key={i} className="flex flex-col bg-background border border-border/40 px-2 py-1 rounded-md shadow-sm" title={`${l.available} units · ${l.country_of_origin || ''} · ${l.percentage ?? 0}%`}>
                              <div className="flex items-center gap-2">
                                <span className="text-foreground font-bold text-xs">{l.location}</span>
                                <span className="text-emerald-500 font-black text-xs tabular-nums bg-emerald-500/10 px-1 rounded">{l.available}</span>
                              </div>
                              <div className="flex items-center justify-between mt-0.5 gap-2">
                                {l.country_of_origin && <span className="text-[9px] text-muted-foreground uppercase tracking-widest">{l.country_of_origin}</span>}
                                {l.percentage !== undefined && <span className="text-[9px] text-yellow-500 font-black">{l.percentage}%</span>}
                              </div>
                            </div>
                          ))}
                          {getSizeLocs(sz).length > 4 && <span className="text-xs text-muted-foreground">+{getSizeLocs(sz).length - 4}</span>}
                        </div>
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
      {activeTab === 'pretickets' && (
        <div className="space-y-4" data-testid="pick-pretickets-list">
          {preTickets.length > 0 && (() => {
            // Calendar view: the 12 months of the year on top; pick a month and
            // it shows ONLY that month's pre-tickets, split by week. No giant
            // list — you drill month → week.
            const parsed = preTickets.map(tk => {
              const d = tk.cancel_date ? new Date(tk.cancel_date) : null;
              const ok = d && !isNaN(d.getTime());
              return { tk, year: ok ? d.getFullYear() : null, month: ok ? d.getMonth() : null, day: ok ? d.getDate() : null };
            });
            const noDate = parsed.filter(p => p.year === null);
            const years = [...new Set(parsed.filter(p => p.year !== null).map(p => p.year))].sort();
            const monthCounts = PRETK_MONTHS.map((_, m) => parsed.filter(p => p.year === pretkYear && p.month === m).length);
            const inSel = pretkMonth === 'none' ? noDate : parsed.filter(p => p.year === pretkYear && p.month === pretkMonth);
            const weeks = {};
            for (const p of inSel) {
              const wk = p.day ? Math.floor((p.day - 1) / 7) + 1 : 0;
              (weeks[wk] = weeks[wk] || []).push(p);
            }
            const weekKeys = Object.keys(weeks).map(Number).sort((a, b) => a - b);
            return (
              <>
                <div className="flex flex-wrap items-center gap-1.5">
                  {years.length > 1 && (
                    <select value={pretkYear} onChange={e => setPretkYear(Number(e.target.value))}
                      className="text-xs font-black bg-secondary/40 border border-border/30 rounded-lg px-2 py-1.5 mr-1 cursor-pointer">
                      {years.map(y => <option key={y} value={y}>{y}</option>)}
                    </select>
                  )}
                  {PRETK_MONTHS.map((mn, m) => {
                    const c = monthCounts[m];
                    const active = pretkMonth === m;
                    return (
                      <button key={m} onClick={() => setPretkMonth(m)}
                        className={`flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-[11px] font-black uppercase tracking-wider transition-all
                          ${active ? 'bg-primary text-black shadow' : c ? 'bg-secondary/40 hover:bg-secondary/70' : 'bg-secondary/20 text-muted-foreground/50'}`}>
                        {mn}
                        {c > 0 && <span className={`px-1 rounded text-[9px] ${active ? 'bg-black/10' : 'bg-primary/20 text-primary'}`}>{c}</span>}
                      </button>
                    );
                  })}
                  {noDate.length > 0 && (
                    <button onClick={() => setPretkMonth('none')}
                      className={`flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-[11px] font-black uppercase tracking-wider transition-all ${pretkMonth === 'none' ? 'bg-primary text-black shadow' : 'bg-secondary/40 hover:bg-secondary/70'}`}>
                      Sin fecha <span className="px-1 rounded text-[9px] bg-primary/20 text-primary">{noDate.length}</span>
                    </button>
                  )}
                </div>

                {weekKeys.map(wk => {
                  const items = weeks[wk].sort((a, b) => (a.day || 0) - (b.day || 0)).map(p => p.tk);
                  return (
                    <div key={wk} className="space-y-2">
                      <div className="flex items-center gap-2 px-1">
                        <Calendar className="w-3.5 h-3.5 text-primary" />
                        <span className="text-xs font-black uppercase tracking-widest">
                          {wk === 0 ? 'Sin día' : `Semana ${wk}`}
                        </span>
                        {wk > 0 && <span className="text-[10px] text-muted-foreground">días {(wk - 1) * 7 + 1}–{wk * 7}</span>}
                        <span className="text-[10px] font-black text-muted-foreground bg-secondary/60 px-2 py-0.5 rounded-full">{items.length}</span>
                      </div>
                      <div className="flex flex-col gap-2">
                        {items.map(ticket => renderTicket(ticket))}
                      </div>
                    </div>
                  );
                })}
                {inSel.length === 0 && (
                  <div className="flex flex-col items-center justify-center py-16 bg-secondary/10 rounded-3xl border border-dashed border-border/40 text-muted-foreground opacity-60">
                    <Calendar className="w-12 h-12 mb-3 stroke-[1px]" />
                    <p className="font-bold uppercase tracking-widest text-sm italic">
                      Sin órdenes en {pretkMonth === 'none' ? 'esta categoría' : `${PRETK_MONTHS[pretkMonth]} ${pretkYear}`}
                    </p>
                  </div>
                )}
              </>
            );
          })()}
          {preTickets.length === 0 && (
            <div className="flex flex-col items-center justify-center py-20 bg-secondary/10 rounded-3xl border border-dashed border-border/40 text-muted-foreground opacity-50">
              <ClipboardList className="w-16 h-16 mb-4 stroke-[1px]" />
              <p className="font-bold uppercase tracking-widest text-sm italic">NO HAY PRE-TICKETS PENDIENTES</p>
              <p className="text-xs mt-1">Todas las órdenes en MOS ya tienen tickets generados.</p>
            </div>
          )}
        </div>
      )}

      {activeTab === 'tickets' && (
        <div className="space-y-6" data-testid="pick-tickets-list">
          {inProgressTickets.length > 0 && (
            <div className="space-y-2">
              <div className="flex items-center gap-2 px-1">
                <span className="w-2 h-2 rounded-full bg-yellow-500" />
                <span className="text-xs font-black uppercase tracking-widest text-yellow-500">En avance</span>
                <span className="text-[10px] font-black text-muted-foreground bg-secondary/60 px-2 py-0.5 rounded-full">{inProgressTickets.length}</span>
              </div>
              <div className="flex flex-col gap-2" data-testid="pick-inprogress-list">
                {inProgressTickets.map(ticket => renderTicket(ticket))}
              </div>
            </div>
          )}
          {notStartedTickets.length > 0 && (
            <div className="space-y-2">
              <div className="flex items-center gap-2 px-1">
                <span className="w-2 h-2 rounded-full bg-blue-500" />
                <span className="text-xs font-black uppercase tracking-widest text-blue-400">Sin iniciar</span>
                <span className="text-[10px] font-black text-muted-foreground bg-secondary/60 px-2 py-0.5 rounded-full">{notStartedTickets.length}</span>
              </div>
              <div className="flex flex-col gap-2" data-testid="pick-notstarted-list">
                {notStartedTickets.map(ticket => renderTicket(ticket))}
              </div>
            </div>
          )}
          {activeTickets.length === 0 && (
            <div className="flex flex-col items-center justify-center py-20 bg-secondary/10 rounded-3xl border border-dashed border-border/40 text-muted-foreground opacity-50">
              <ClipboardCheck className="w-16 h-16 mb-4 stroke-[1px]" />
              <p className="font-bold uppercase tracking-widest text-sm italic">NO HAY TICKETS ACTIVOS</p>
              <p className="text-xs mt-1">Inicia un Pre-Ticket para comenzar a trabajar.</p>
            </div>
          )}
        </div>
      )}
      {activeTab === 'completed' && (
        <div className="space-y-6">
          {!completedLoaded ? (
            <div className="flex flex-col items-center justify-center py-20 bg-secondary/10 rounded-3xl border border-dashed border-border/40 text-center">
              <CheckCircle className="w-14 h-14 mb-4 text-muted-foreground/40 stroke-[1px]" />
              <p className="text-sm font-bold text-muted-foreground mb-1">Las completadas no se cargan automáticamente</p>
              <p className="text-[11px] text-muted-foreground/70 mb-5 max-w-sm">Para ahorrar recursos en los equipos del almacén. Cárgalas solo cuando las necesites.</p>
              <button
                onClick={loadCompletedTickets}
                disabled={loadingCompleted}
                className="flex items-center gap-2 px-5 py-2.5 bg-primary text-black text-xs font-black uppercase tracking-wider rounded-xl hover:scale-105 transition-all shadow-lg shadow-primary/20 disabled:opacity-50"
              >
                {loadingCompleted ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle className="w-4 h-4" />}
                {loadingCompleted ? 'Cargando…' : 'Cargar completadas'}
              </button>
            </div>
          ) : (
            <>
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
                <button onClick={loadCompletedTickets} disabled={loadingCompleted} className="px-3 py-2 bg-secondary/50 rounded-xl text-xs font-black text-muted-foreground hover:text-foreground uppercase tracking-widest flex items-center gap-1.5 disabled:opacity-50" title="Refrescar completadas">
                  {loadingCompleted ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <History className="w-3.5 h-3.5" />} Refrescar
                </button>
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
            </>
          )}
        </div>
      )}
      {activeTab === 'workload' && (
        <div className="space-y-4" data-testid="pick-workload">
          <div className="flex items-center gap-2 px-1 text-[11px] text-muted-foreground">
            <Users className="w-4 h-4" />
            Carga de trabajo por operador — reasigna o retira tickets según la carga de cada uno.
          </div>
          {selectedWorkload.length > 0 && (
            <div className="sticky top-2 z-20 flex flex-wrap items-center gap-3 px-4 py-2.5 bg-primary/15 border border-primary/40 rounded-xl shadow-lg">
              <span className="text-xs font-black uppercase tracking-wider">{selectedWorkload.length} seleccionado(s)</span>
              <select
                value=""
                onChange={(e) => { if (e.target.value) handleBulkAssign(e.target.value); }}
                className="text-xs font-bold bg-background border border-border/40 rounded-lg px-2 py-1.5 cursor-pointer"
                title="Reasignar todos los seleccionados"
              >
                <option value="">Reasignar a…</option>
                {operators.map(o => <option key={o.user_id} value={o.user_id}>{o.name || o.email}</option>)}
              </select>
              <button
                onClick={() => handleBulkAssign("")}
                className="flex items-center gap-1 text-xs font-black uppercase text-red-400 hover:text-white hover:bg-red-500 border border-red-500/40 rounded-lg px-3 py-1.5 transition-all"
              >
                <UserMinus className="w-3.5 h-3.5" /> Retirar
              </button>
              <button onClick={() => setSelectedWorkload([])} className="text-xs font-bold text-muted-foreground hover:text-foreground ml-auto">Limpiar</button>
            </div>
          )}
          {workloadByOperator.map(group => (
            <div key={group.id} className="rounded-2xl border border-border/30 bg-card/20 overflow-hidden">
              <div className="flex items-center justify-between gap-3 px-4 py-2.5 bg-secondary/20 border-b border-border/30">
                <div className="flex items-center gap-2 min-w-0">
                  {group.tickets.length > 0 && (() => {
                    const groupIds = group.tickets.map(t => t.ticket_id);
                    const allSel = groupIds.every(id => selectedWorkload.includes(id));
                    return (
                      <input type="checkbox" checked={allSel}
                        onChange={() => toggleWorkloadGroup(groupIds, allSel)}
                        className="w-4 h-4 rounded border-border accent-primary cursor-pointer shrink-0"
                        title="Seleccionar todos de este operador" />
                    );
                  })()}
                  <span className={`w-2 h-2 rounded-full ${group.id === UNASSIGNED_KEY ? 'bg-red-500' : group.tickets.length === 0 ? 'bg-muted-foreground/40' : 'bg-emerald-500'}`} />
                  <span className="font-black uppercase tracking-wider text-sm truncate">{group.name}</span>
                </div>
                <div className="flex items-center gap-2 text-[10px] font-black">
                  <span className="px-2 py-0.5 rounded-full bg-secondary/60">{group.tickets.length} tickets</span>
                  <span className="px-2 py-0.5 rounded-full bg-secondary/60">{group.units.toLocaleString()} pzs</span>
                </div>
              </div>
              {group.tickets.length === 0 ? (
                <div className="px-4 py-3 text-[11px] text-muted-foreground italic">Sin tickets asignados — disponible.</div>
              ) : (
                <div className="divide-y divide-border/10">
                  {group.tickets.map(tk => (
                    <div key={tk.ticket_id} className={`flex items-center gap-2 px-4 py-2 hover:bg-secondary/40 transition-colors group/wrow ${selectedWorkload.includes(tk.ticket_id) ? 'bg-primary/10' : ''}`}>
                      <input type="checkbox" checked={selectedWorkload.includes(tk.ticket_id)}
                        onChange={() => toggleWorkloadSelect(tk.ticket_id)}
                        className="w-4 h-4 rounded border-border accent-primary cursor-pointer shrink-0"
                        title="Seleccionar ticket" />
                      <div className="min-w-0">
                        <div className="flex items-center gap-2 text-sm font-bold truncate">
                          <span className="font-mono">{tk.order_number}</span>
                          <span className="text-muted-foreground truncate font-normal">{tk.style} {tk.color}</span>
                        </div>
                        <div className="text-[10px] text-muted-foreground uppercase tracking-wider">{(tk.total_pick_qty || 0).toLocaleString()} pzs · {tk.picking_status}</div>
                      </div>
                      {/* Dotted leader line tying each ticket to its own controls
                          (the big empty gap made it easy to act on the wrong row).
                          Highlights on row hover so it's obvious which ticket. */}
                      <div className="flex-1 self-center border-b border-dotted border-border/40 group-hover/wrow:border-primary/70 min-w-[16px] transition-colors" />
                      <div className="flex items-center gap-2 shrink-0">
                        <select
                          value=""
                          onChange={(e) => { if (e.target.value) handleQuickAssign(tk.ticket_id, e.target.value); }}
                          className="text-[10px] font-bold bg-secondary/40 border border-border/30 rounded-lg px-2 py-1 cursor-pointer hover:border-border/60 transition-all"
                          title="Reasignar a otro operador"
                        >
                          <option value="">Reasignar…</option>
                          {operators.filter(o => o.user_id !== group.id).map(o => (
                            <option key={o.user_id} value={o.user_id}>{o.name || o.email}</option>
                          ))}
                        </select>
                        {group.id !== UNASSIGNED_KEY && (
                          <button
                            onClick={() => handleQuickAssign(tk.ticket_id, "")}
                            className="flex items-center gap-1 text-[10px] font-black uppercase text-red-400 hover:text-white hover:bg-red-500 border border-red-500/30 rounded-lg px-2 py-1 transition-all whitespace-nowrap"
                            title="Retirar del operador (queda sin asignar)"
                          >
                            <UserMinus className="w-3 h-3" /> Retirar
                          </button>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))}
          {workloadByOperator.length === 0 && (
            <div className="flex flex-col items-center justify-center py-20 bg-secondary/10 rounded-3xl border border-dashed border-border/40 text-muted-foreground opacity-50">
              <Users className="w-16 h-16 mb-4 stroke-[1px]" />
              <p className="font-bold uppercase tracking-widest text-sm italic">Sin operadores ni tickets activos</p>
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
                <div key={s.key} className="bg-card/60 backdrop-blur-sm border border-border/40 rounded-3xl p-6 shadow-xl relative overflow-hidden group">
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

            <div className="space-y-3">
              {/* SKU + Talla */}
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-[10px] font-black uppercase text-muted-foreground block mb-1">SKU / ITEM</label>
                  <select
                    value={incidentDraft.sku}
                    onChange={e => setIncidentDraft(p => ({ ...p, sku: e.target.value }))}
                    className="w-full bg-background border border-border rounded-xl p-2.5 text-sm font-bold focus:ring-2 focus:ring-red-500/20 transition-all"
                  >
                    <option value={incidentTicket.style}>{incidentTicket.style}</option>
                    {Object.keys(incidentTicket.sizes || {}).filter(sz => incidentTicket.sizes[sz] > 0).map(sz => (
                      <option key={sz} value={`${incidentTicket.style}-${sz}`}>{incidentTicket.style} ({sz})</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="text-[10px] font-black uppercase text-muted-foreground block mb-1">Talla</label>
                  <select
                    value={incidentDraft.size}
                    onChange={e => setIncidentDraft(p => ({ ...p, size: e.target.value }))}
                    className="w-full bg-background border border-border rounded-xl p-2.5 text-sm font-bold focus:ring-2 focus:ring-red-500/20 transition-all"
                  >
                    <option value="">— Todas —</option>
                    {Object.keys(incidentTicket.sizes || {}).filter(sz => incidentTicket.sizes[sz] > 0).map(sz => (
                      <option key={sz} value={sz}>{sz}</option>
                    ))}
                  </select>
                </div>
              </div>

              {/* Qty + Razón */}
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-[10px] font-black uppercase text-muted-foreground block mb-1">Cant. afectada</label>
                  <input
                    type="number" min="1"
                    value={incidentDraft.qty}
                    onChange={e => setIncidentDraft(p => ({ ...p, qty: e.target.value }))}
                    className="w-full bg-background border border-border rounded-xl p-2.5 text-sm font-bold"
                  />
                </div>
                <div>
                  <label className="text-[10px] font-black uppercase text-muted-foreground block mb-1">Razón</label>
                  <select
                    value={incidentDraft.reason}
                    onChange={e => setIncidentDraft(p => ({ ...p, reason: e.target.value }))}
                    className="w-full bg-background border border-border rounded-xl p-2.5 text-sm font-bold"
                  >
                    <option value="Dañado">Dañado</option>
                    <option value="Manchado">Manchado</option>
                    <option value="Incompleto">Incompleto</option>
                    <option value="Faltante">Faltante</option>
                    <option value="Talla incorrecta">Talla incorrecta</option>
                    <option value="Otro">Otro</option>
                  </select>
                </div>
              </div>

              {/* Reposición */}
              <div className="border-t border-border/30 pt-3 space-y-3">
                <p className="text-[10px] font-black uppercase tracking-widest text-red-400">Prendas a reponer por talla</p>

                {/* Size grid */}
                {(() => {
                  const ticketSizes = Object.keys(incidentTicket.sizes || {}).filter(sz => incidentTicket.sizes[sz] > 0);
                  const totalRep = Object.values(incidentDraft.replacement_sizes).reduce((s, v) => s + (parseInt(v) || 0), 0);
                  return (
                    <div>
                      <div className="grid gap-1" style={{ gridTemplateColumns: `repeat(${Math.min(ticketSizes.length, 6)}, minmax(0,1fr))` }}>
                        {ticketSizes.map(sz => (
                          <div key={sz} className="flex flex-col items-center gap-1">
                            <span className="text-[10px] font-black uppercase text-muted-foreground">{sz}</span>
                            <span className="text-[9px] text-muted-foreground/50">({incidentTicket.sizes[sz]})</span>
                            <input
                              type="number" min="0"
                              value={incidentDraft.replacement_sizes[sz] || ''}
                              onChange={e => setIncidentDraft(p => ({ ...p, replacement_sizes: { ...p.replacement_sizes, [sz]: e.target.value } }))}
                              placeholder="0"
                              className="w-full text-center bg-background border border-border rounded-lg p-1.5 text-sm font-bold text-red-400 focus:ring-2 focus:ring-red-500/20 focus:border-red-500/50 transition-all"
                            />
                          </div>
                        ))}
                      </div>
                      {totalRep > 0 && (
                        <div className="mt-2 text-right text-xs font-black text-red-400">
                          Total a reponer: <span className="text-foreground">{totalRep} prendas</span>
                        </div>
                      )}
                    </div>
                  );
                })()}

                <div>
                  <label className="text-[10px] font-black uppercase text-muted-foreground block mb-1">Descripción / Contenido a reponer</label>
                  <input
                    type="text"
                    value={incidentDraft.replacement_description}
                    onChange={e => setIncidentDraft(p => ({ ...p, replacement_description: e.target.value }))}
                    placeholder="Ej: Camiseta 5000 Blanca"
                    className="w-full bg-background border border-border rounded-xl p-2.5 text-sm"
                  />
                </div>
                <div>
                  <label className="text-[10px] font-black uppercase text-muted-foreground block mb-1">Notas</label>
                  <input
                    type="text"
                    value={incidentDraft.notes}
                    onChange={e => setIncidentDraft(p => ({ ...p, notes: e.target.value }))}
                    placeholder="Observaciones adicionales..."
                    className="w-full bg-background border border-border rounded-xl p-2.5 text-sm"
                  />
                </div>
              </div>
            </div>

            <div className="flex gap-2 pt-2">
              <button
                onClick={submitIncident}
                disabled={incidentSaving}
                className="flex-1 bg-red-500 hover:bg-red-600 text-white font-black uppercase tracking-widest text-xs py-3 rounded-xl transition-all shadow-lg shadow-red-500/20 disabled:opacity-50 flex items-center justify-center gap-2"
              >
                {incidentSaving && <Loader2 className="w-4 h-4 animate-spin" />}
                {t('confirm') || 'Confirmar'}
              </button>
              <button onClick={() => setIncidentTicket(null)} disabled={incidentSaving} className="flex-1 bg-secondary hover:bg-secondary/80 text-foreground font-black uppercase tracking-widest text-xs py-3 rounded-xl transition-all disabled:opacity-50">
                {t('cancel') || 'Cancelar'}
              </button>
            </div>
          </div>
        </div>
      )}

      {dupWarning && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm animate-in fade-in duration-200">
          <div className="bg-card border border-amber-500/50 rounded-2xl w-full max-w-md shadow-2xl p-6 space-y-4 animate-in zoom-in-95 duration-200">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2 text-amber-500">
                <AlertTriangle className="w-5 h-5" />
                <h3 className="font-black uppercase tracking-widest text-sm">Posible Duplicado</h3>
              </div>
              <button onClick={() => setDupWarning(null)} disabled={loading} className="p-1 hover:bg-secondary rounded-lg transition-all disabled:opacity-50"><X className="w-5 h-5" /></button>
            </div>

            <div className="bg-amber-500/10 border border-amber-500/20 rounded-xl p-4 text-sm text-foreground">
              <p className="mb-2 font-medium">{dupWarning.message}</p>
              {dupWarning.existing && Object.keys(dupWarning.existing).length > 0 && (
                <div className="space-y-1 text-xs text-muted-foreground bg-black/20 p-2 rounded-lg font-mono mt-3">
                  <div><span className="text-amber-400/70">Ticket:</span> {dupWarning.existing.ticket_id}</div>
                  <div><span className="text-amber-400/70">Status:</span> {dupWarning.existing.status} / {dupWarning.existing.picking_status}</div>
                  <div><span className="text-amber-400/70">Creado por:</span> {dupWarning.existing.created_by_name}</div>
                  <div><span className="text-amber-400/70">Fecha:</span> {new Date(dupWarning.existing.created_at).toLocaleString()}</div>
                  <div><span className="text-amber-400/70">Qty:</span> {dupWarning.existing.total_pick_qty} unid.</div>
                </div>
              )}
              <p className="mt-3 text-xs italic opacity-80">
                Si solo necesitas hacer un ajuste, deberías <strong>editar el ticket existente</strong>. ¿Estás seguro que quieres crear uno nuevo adicional para esta orden?
              </p>
            </div>

            <div className="flex gap-2 pt-2">
              <button
                onClick={handleForceDuplicate}
                disabled={loading}
                className="flex-1 bg-amber-500 hover:bg-amber-600 text-black font-black uppercase tracking-widest text-[10px] py-3 rounded-xl transition-all shadow-lg shadow-amber-500/20 disabled:opacity-50 flex items-center justify-center gap-2"
              >
                {loading && <Loader2 className="w-4 h-4 animate-spin" />}
                Crear de todos modos
              </button>
              <button onClick={() => setDupWarning(null)} disabled={loading} className="flex-1 bg-secondary hover:bg-secondary/80 text-foreground font-black uppercase tracking-widest text-xs py-3 rounded-xl transition-all disabled:opacity-50">
                Cancelar
              </button>
            </div>
          </div>
        </div>
      )}

      {confirmTicket && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm animate-in fade-in duration-200">
          <div className="bg-card border border-border/50 rounded-2xl w-full max-w-md shadow-2xl p-6 space-y-4 animate-in zoom-in-95 duration-200">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2 text-emerald-500">
                <CheckCircle className="w-5 h-5" />
                <h3 className="font-black uppercase tracking-widest text-sm">{t('confirm') || 'Confirmar'}</h3>
              </div>
              <button onClick={() => setConfirmTicket(null)} disabled={confirmSaving} className="p-1 hover:bg-secondary rounded-lg transition-all disabled:opacity-50"><X className="w-5 h-5" /></button>
            </div>

            <p className="text-sm text-muted-foreground">
              {t('confirm_ticket') || '¿Confirmar este pick ticket? Se descontará el inventario.'}
            </p>
            <div className="bg-secondary/40 rounded-xl p-3 border border-border/20 text-xs font-bold font-mono">
              <span className="text-primary">{confirmTicket.ticket_id}</span>
              <span className="text-muted-foreground"> · #{confirmTicket.order_number} · {confirmTicket.customer || ''} · {confirmTicket.style || ''}</span>
            </div>

            <div className="flex gap-2 pt-1">
              <button
                onClick={doConfirm}
                disabled={confirmSaving}
                className="flex-1 bg-emerald-500 hover:bg-emerald-600 text-white font-black uppercase tracking-widest text-xs py-3 rounded-xl transition-all shadow-lg shadow-emerald-500/20 disabled:opacity-50 flex items-center justify-center gap-2"
              >
                {confirmSaving ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle className="w-4 h-4" />}
                {t('confirm') || 'Confirmar'}
              </button>
              <button onClick={() => setConfirmTicket(null)} disabled={confirmSaving} className="flex-1 bg-secondary hover:bg-secondary/80 text-foreground font-black uppercase tracking-widest text-xs py-3 rounded-xl transition-all disabled:opacity-50">
                {t('cancel') || 'Cancelar'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
