import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ArrowLeft, ClipboardList, Package, DollarSign, Search, Filter, Download,
  Columns as ColumnsIcon, RefreshCw, ChevronsLeft, ChevronLeft, ChevronRight,
  ChevronsRight, ChevronsUpDown, Check, Undo2, Loader2, ShieldCheck, CalendarDays,
} from 'lucide-react';
import { toast } from 'sonner';
import * as XLSX from 'xlsx';
import { useAuth } from '../App';

const BACKEND_URL = process.env.REACT_APP_BACKEND_URL;
const API = `${BACKEND_URL}/api`;

// Las tres bandejas del módulo. Las dos primeras son los estados de producción
// que le tocan a Final Bill; la tercera es el archivo de lo que el encargado ya
// selló — vive de la bandera `final_bill_review`, no de un status.
const TABS = [
  { key: 'envio', label: 'Listo para envío' },
  { key: 'inventario', label: 'Listo para inventario' },
  { key: 'revisadas', label: 'Revisadas' },
];

// key = llave que entiende el backend para ordenar (NO el campo de Mongo).
const COLUMNS = [
  { key: 'order_number', label: 'Order#', sortable: true },
  { key: 'customer_po', label: 'Customer PO', sortable: true },
  { key: 'cancel_date', label: 'Cancel Date', sortable: true },
  { key: 'final_bill', label: 'Final Bill', sortable: true },
  { key: 'status_at', label: 'Fecha de estatus', sortable: true },
  { key: 'design', label: 'Design', sortable: true },
  { key: 'client', label: 'Client', sortable: true },
  { key: 'branding', label: 'Branding', sortable: true },
  { key: 'qty', label: 'Final Unido Qty', sortable: true, align: 'right' },
  { key: 'total_amount', label: 'Total Amount', sortable: true, align: 'right' },
];

const fmt = (n, d = 0) => (n === null || n === undefined || isNaN(n))
  ? '—'
  : Number(n).toLocaleString('en-US', { maximumFractionDigits: d });

// El total facturado. Sin fuente (null/undefined) es "—" y CERO es "$0.00":
// una factura de cero dólares es un dato real y distinto de "aún no se factura",
// así que no se colapsan en el mismo guión.
const fmtMoney = (n) => (n === null || n === undefined || isNaN(n))
  ? '—'
  : Number(n).toLocaleString('en-US', { style: 'currency', currency: 'USD' });

// Las fechas llegan como texto YYYY-MM-DD. Se formatean a mano en vez de con
// new Date(): el constructor las lee como UTC y en Tijuana las pinta un día
// antes, que es exactamente el bug que haría dudar de un Cancel Date.
const fmtDate = (s) => {
  if (!s) return '—';
  const m = String(s).match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : String(s);
};

// Vencida = la fecha de cancelación ya pasó. Se compara en texto contra el hoy
// LOCAL, sin zonas horarias de por medio.
const todayStr = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

const fmtStamp = (iso) => {
  if (!iso) return '—';
  const d = new Date(iso);
  return isNaN(d.getTime()) ? '—' : d.toLocaleDateString('es-MX');
};

// Celda de fecha editable, con el MISMO comportamiento que la columna de
// calendario del tablero (dashboard/EditableCell, type='date'): un clic abre el
// <input type="date"> nativo y al salir (blur o Enter) guarda. Escape descarta.
//
// Guarda por PUT /api/orders/{id}, el mismo endpoint que usa el tablero, en vez
// de abrir un endpoint propio: ese camino ya deja bitácora, corre las
// automatizaciones y hace el broadcast que limpia la caché de /api/orders. Un
// segundo escritor sobre la misma orden se saltaría las tres cosas y el tablero
// seguiría mostrando la fecha vieja.
const DateCell = ({ value, onSave, disabled }) => {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value || '');
  const ref = useRef(null);

  useEffect(() => { setDraft(value || ''); }, [value]);
  useEffect(() => { if (editing && ref.current) ref.current.focus(); }, [editing]);

  if (disabled) return <span className="text-slate-600">{fmtDate(value)}</span>;

  if (editing) {
    const commit = () => {
      setEditing(false);
      if ((draft || '') !== (value || '')) onSave(draft || '');
    };
    return (
      <input
        ref={ref}
        type="date"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit();
          if (e.key === 'Escape') { setDraft(value || ''); setEditing(false); }
        }}
        className="h-8 w-[140px] px-2 rounded-lg border border-blue-400 bg-white text-sm text-slate-800 outline-none"
        data-testid="fb-date-input"
      />
    );
  }

  return (
    <button
      type="button"
      onClick={() => setEditing(true)}
      title="Clic para editar la fecha de Final Bill"
      className={`h-8 px-2 -mx-2 rounded-lg text-left inline-flex items-center gap-1.5 hover:bg-blue-50 hover:text-blue-700 transition-colors ${
        value ? 'text-slate-600' : 'text-slate-300'
      }`}
    >
      {fmtDate(value)}
      <CalendarDays className="w-3.5 h-3.5 opacity-0 group-hover:opacity-60" />
    </button>
  );
};

const Card = ({ children, className = '' }) => (
  <div className={`bg-white border border-slate-200 rounded-2xl shadow-sm ${className}`}>{children}</div>
);

const StatCard = ({ icon: Icon, chip, label, value, sub }) => (
  <Card className="p-5 flex items-center gap-4 flex-1 min-w-[220px]">
    <div className={`w-14 h-14 rounded-2xl flex items-center justify-center shrink-0 ${chip}`}>
      <Icon className="w-6 h-6" />
    </div>
    <div className="min-w-0">
      <p className="text-[11px] font-semibold text-slate-500">{label}</p>
      <p className="text-2xl font-black text-slate-900 leading-tight">{value}</p>
      <p className="text-[11px] text-slate-400">{sub}</p>
    </div>
  </Card>
);

const FinalBillModule = () => {
  const navigate = useNavigate();
  const { user } = useAuth();
  // Solo el encargado (admin/supersu) sella. El backend lo vuelve a exigir: esto
  // es para no mostrar botones que van a rebotar con 403.
  const canReview = user?.role === 'admin' || user?.role === 'supersu';

  const [tab, setTab] = useState('envio');
  const [data, setData] = useState(null);
  const [options, setOptions] = useState({ clients: [], designs: [], brandings: [] });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [acting, setActing] = useState(false);

  const [filters, setFilters] = useState({
    search: '', cancel_date: '', final_bill: '', client: '', design: '', branding: '',
  });
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const [sort, setSort] = useState({ by: 'cancel_date', dir: 'asc' });
  const [selected, setSelected] = useState(new Set());
  const [hidden, setHidden] = useState(() => {
    try { return new Set(JSON.parse(localStorage.getItem('final_bill_hidden_cols') || '[]')); }
    catch { return new Set(); }
  });
  const [showCols, setShowCols] = useState(false);


  const visibleColumns = useMemo(() => COLUMNS.filter(c => !hidden.has(c.key)), [hidden]);

  const toggleColumn = (key) => {
    setHidden(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      localStorage.setItem('final_bill_hidden_cols', JSON.stringify([...next]));
      return next;
    });
  };

  const fetchRows = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const qs = new URLSearchParams({
        tab,
        page: String(page),
        page_size: String(pageSize),
        sort_by: sort.by,
        sort_dir: sort.dir,
        ...Object.fromEntries(Object.entries(filters).filter(([, v]) => v)),
      });
      const res = await fetch(`${API}/final-bill?${qs}`, { credentials: 'include' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setData(await res.json());
      setSelected(new Set());
    } catch {
      setError('No se pudieron cargar las órdenes. Verifica tu sesión o el servidor.');
    } finally {
      setLoading(false);
    }
  }, [tab, page, pageSize, sort, filters]);

  useEffect(() => { fetchRows(); }, [fetchRows]);

  useEffect(() => {
    fetch(`${API}/final-bill/options`, { credentials: 'include' })
      .then(r => r.ok ? r.json() : null)
      .then(d => d && setOptions(d))
      .catch(() => { /* los selects se quedan vacíos; la tabla sigue sirviendo */ });
  }, []);

  // Cualquier cambio de filtro/pestaña regresa a la página 1: quedarse en la 12
  // de un filtro que ahora tiene 3 resultados muestra una tabla vacía y parece
  // que no hay nada.
  const setFilter = (key, val) => { setFilters(f => ({ ...f, [key]: val })); setPage(1); };
  const clearFilters = () => {
    setFilters({ search: '', cancel_date: '', final_bill: '', client: '', design: '', branding: '' });
    setPage(1);
  };
  const changeTab = (k) => { setTab(k); setPage(1); setSelected(new Set()); };

  const toggleSort = (key) => {
    setSort(s => ({ by: key, dir: s.by === key && s.dir === 'asc' ? 'desc' : 'asc' }));
    setPage(1);
  };

  const rows = data?.rows || [];
  const counts = data?.tab_counts || {};
  const hasFilters = Object.values(filters).some(Boolean);

  const toggleRow = (id) => setSelected(prev => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  const toggleAll = () => setSelected(prev =>
    prev.size === rows.length ? new Set() : new Set(rows.map(r => r.order_id)));

  const review = async (orderIds, reviewed) => {
    if (!canReview || !orderIds.length) return;
    setActing(true);
    try {
      const res = orderIds.length === 1
        ? await fetch(`${API}/final-bill/${orderIds[0]}/review`, {
            method: 'POST', credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ reviewed }),
          })
        : await fetch(`${API}/final-bill/review-bulk`, {
            method: 'POST', credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ order_ids: orderIds, reviewed }),
          });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      toast.success(reviewed
        ? `${orderIds.length} orden(es) marcadas como revisadas`
        : `${orderIds.length} orden(es) devueltas a su bandeja`);
      fetchRows();
    } catch {
      toast.error('No se pudo guardar la revisión');
    } finally {
      setActing(false);
    }
  };

  // Guarda la fecha de Final Bill de un renglón. Optimista: pinta el valor nuevo
  // de inmediato y lo revierte si el PUT falla, porque volver a pedir la página
  // completa por cambiar una fecha reordena la tabla debajo del cursor.
  //
  // La excepción es cuando el filtro de Final Bill está puesto: ahí la fecha
  // nueva puede sacar al renglón del filtro, y dejarlo pintado sería mentir
  // sobre lo que se está viendo. En ese caso sí se recarga.
  const saveFinalBill = async (orderId, value) => {
    const before = rows.find(r => r.order_id === orderId)?.final_bill ?? '';
    const paint = (val) => setData(d => d && ({
      ...d, rows: d.rows.map(r => (r.order_id === orderId ? { ...r, final_bill: val } : r)),
    }));
    paint(value);
    try {
      const res = await fetch(`${API}/orders/${orderId}`, {
        method: 'PUT',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ final_bill: value || '' }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      toast.success(value ? `Final Bill: ${fmtDate(value)}` : 'Final Bill vaciado');
      if (filters.final_bill) fetchRows();
    } catch {
      paint(before);
      toast.error('No se pudo guardar la fecha de Final Bill');
    }
  };

  // El Excel exporta LO QUE SE ESTÁ VIENDO (pestaña + filtros), pero todas las
  // páginas, no solo la actual: exportar 10 de 218 renglones sería una trampa.
  const exportExcel = async () => {
    try {
      const qs = new URLSearchParams({
        tab, page: '1', page_size: '5000', sort_by: sort.by, sort_dir: sort.dir,
        ...Object.fromEntries(Object.entries(filters).filter(([, v]) => v)),
      });
      const res = await fetch(`${API}/final-bill?${qs}`, { credentials: 'include' });
      if (!res.ok) throw new Error();
      const all = await res.json();
      const sheet = (all.rows || []).map(r => ({
        'Order#': r.order_number,
        'Customer PO': r.customer_po,
        'Cancel Date': r.cancel_date,
        'Final Bill': r.final_bill,
        'Fecha de estatus': r.status_at ? new Date(r.status_at).toLocaleString() : '',
        'Design': r.design,
        'Client': r.client,
        'Branding': r.branding,
        'Final Unido Qty': r.qty,
        // Se exporta el número crudo, no "$1,234.00": en Excel el texto no suma.
        'Total Amount': (r.total_amount === null || r.total_amount === undefined) ? '' : r.total_amount,
        'Production Status': r.production_status,
        'Revisada por': r.reviewed_by_name,
        'Revisada el': r.reviewed_at ? new Date(r.reviewed_at).toLocaleString() : '',
      }));
      const wb = XLSX.utils.book_new();
      const ws = XLSX.utils.json_to_sheet(sheet);
      ws['!cols'] = [12, 16, 13, 13, 18, 12, 26, 18, 15, 14, 22, 20, 20].map(wch => ({ wch }));
      XLSX.utils.book_append_sheet(wb, ws, 'Final Bill');
      XLSX.writeFile(wb, `Final_Bill_${tab}_${todayStr()}.xlsx`);
      toast.success(`${sheet.length} renglones exportados`);
    } catch {
      toast.error('No se pudo generar el Excel');
    }
  };

  const from = data ? (data.total === 0 ? 0 : (data.page - 1) * data.page_size + 1) : 0;
  const to = data ? Math.min(data.page * data.page_size, data.total) : 0;
  const pages = data?.pages || 1;

  // Ventana de paginación: primeras/últimas y las vecinas de la actual, con
  // elipsis. Con 22 páginas, pintarlas todas revienta el renglón.
  const pageButtons = useMemo(() => {
    const out = [];
    for (let i = 1; i <= pages; i++) {
      if (i === 1 || i === pages || Math.abs(i - page) <= 1) out.push(i);
      else if (out[out.length - 1] !== '…') out.push('…');
    }
    return out;
  }, [pages, page]);

  return (
    <div className="min-h-screen bg-slate-50 text-slate-800 overflow-y-auto pb-16">
      {/* HEADER */}
      <header className="sticky top-0 z-40 bg-white/90 backdrop-blur-lg border-b border-slate-200">
        <div className="max-w-[1400px] mx-auto px-4 md:px-8 py-4 flex items-center gap-3 flex-wrap">
          <button
            onClick={() => navigate('/home')}
            className="p-2 rounded-xl bg-white border border-slate-200 text-slate-500 hover:text-blue-600 hover:border-blue-300 transition-colors"
            title="Volver"
            data-testid="fb-back"
          >
            <ArrowLeft className="w-4 h-4" />
          </button>
          <div className="leading-none mr-auto">
            <h1 className="text-2xl font-black tracking-tight text-slate-900">Módulo de Final Bill</h1>
            <span className="block text-xs text-slate-500 mt-1">Consulta y administración de órdenes</span>
          </div>

          {canReview && selected.size > 0 && (
            <button
              onClick={() => review([...selected], tab !== 'revisadas')}
              disabled={acting}
              className="h-10 px-4 rounded-xl bg-blue-600 text-white text-sm font-bold flex items-center gap-2 hover:bg-blue-700 disabled:opacity-60 transition-colors"
              data-testid="fb-bulk-review"
            >
              {acting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
              {tab === 'revisadas'
                ? `Devolver ${selected.size}`
                : `Marcar ${selected.size} revisada(s)`}
            </button>
          )}

          <button
            onClick={exportExcel}
            className="h-10 px-4 rounded-xl bg-white border border-slate-200 text-sm font-bold text-slate-600 flex items-center gap-2 hover:border-blue-300 hover:text-blue-600 transition-colors"
            data-testid="fb-export"
          >
            <Download className="w-4 h-4" /> Exportar
          </button>

          <div className="relative">
            <button
              onClick={() => setShowCols(v => !v)}
              className="h-10 px-4 rounded-xl bg-white border border-slate-200 text-sm font-bold text-slate-600 flex items-center gap-2 hover:border-blue-300 hover:text-blue-600 transition-colors"
              data-testid="fb-columns"
            >
              <ColumnsIcon className="w-4 h-4" /> Columnas
            </button>
            {showCols && (
              <div className="absolute right-0 mt-2 w-56 bg-white border border-slate-200 rounded-xl shadow-lg p-2 z-50">
                {COLUMNS.map(c => (
                  <label key={c.key} className="flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-slate-50 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={!hidden.has(c.key)}
                      onChange={() => toggleColumn(c.key)}
                      className="w-4 h-4 rounded border-slate-300 text-blue-600"
                    />
                    <span className="text-sm text-slate-700">{c.label}</span>
                  </label>
                ))}
              </div>
            )}
          </div>
        </div>
      </header>

      <main className="max-w-[1400px] mx-auto px-4 md:px-8 pt-6 space-y-5">

        {/* FILTROS */}
        <Card className="p-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-6 gap-4 items-end">
            <div className="lg:col-span-2">
              <label className="text-xs font-semibold text-slate-500 block mb-1">Buscar</label>
              <div className="relative">
                <input
                  value={filters.search}
                  onChange={(e) => setFilter('search', e.target.value)}
                  placeholder="Buscar por Order#, Customer PO o Cliente..."
                  className="w-full h-10 pl-3 pr-9 bg-white border border-slate-200 rounded-lg text-sm outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-100"
                  data-testid="fb-search"
                />
                <Search className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
              </div>
            </div>
            <div>
              <label className="text-xs font-semibold text-slate-500 block mb-1">Cancel Date</label>
              <input
                type="date" value={filters.cancel_date}
                onChange={(e) => setFilter('cancel_date', e.target.value)}
                className="w-full h-10 px-3 bg-white border border-slate-200 rounded-lg text-sm outline-none focus:border-blue-400"
                data-testid="fb-cancel-date"
              />
            </div>
            <div>
              <label className="text-xs font-semibold text-slate-500 block mb-1">Final Bill</label>
              <input
                type="date" value={filters.final_bill}
                onChange={(e) => setFilter('final_bill', e.target.value)}
                className="w-full h-10 px-3 bg-white border border-slate-200 rounded-lg text-sm outline-none focus:border-blue-400"
                data-testid="fb-final-bill"
              />
            </div>
            {[
              { key: 'client', label: 'Client', list: options.clients },
              { key: 'design', label: 'Design', list: options.designs },
              { key: 'branding', label: 'Branding', list: options.brandings },
            ].map(f => (
              <div key={f.key}>
                <label className="text-xs font-semibold text-slate-500 block mb-1">{f.label}</label>
                <select
                  value={filters[f.key]}
                  onChange={(e) => setFilter(f.key, e.target.value)}
                  className="w-full h-10 px-2 bg-white border border-slate-200 rounded-lg text-sm outline-none focus:border-blue-400"
                  data-testid={`fb-${f.key}`}
                >
                  <option value="">Todos</option>
                  {(f.list || []).map(v => <option key={v} value={v}>{v}</option>)}
                </select>
              </div>
            ))}
            <div>
              <button
                onClick={clearFilters}
                disabled={!hasFilters}
                className="h-10 w-full px-3 rounded-lg bg-white border border-slate-200 text-sm font-semibold text-slate-500 flex items-center justify-center gap-2 hover:border-blue-300 hover:text-blue-600 disabled:opacity-40 transition-colors"
                data-testid="fb-clear"
              >
                <Filter className="w-4 h-4" /> Limpiar filtros
              </button>
            </div>
          </div>
        </Card>

        {/* TARJETAS */}
        <div className="flex flex-wrap gap-5">
          <StatCard
            icon={ClipboardList} chip="bg-blue-50 text-blue-600"
            label="Órdenes Totales" value={fmt(data?.totals?.orders)}
            sub={TABS.find(t => t.key === tab)?.label}
          />
          <StatCard
            icon={Package} chip="bg-emerald-50 text-emerald-600"
            label="Final Unido Qty" value={fmt(data?.totals?.units)}
            sub="Total de unidades"
          />
          <StatCard
            icon={DollarSign} chip="bg-violet-50 text-violet-600"
            label="Total Amount" value={fmtMoney(data?.totals?.amount)}
            sub={data?.totals?.amount_orders
              ? `De ${fmt(data.totals.amount_orders)} de ${fmt(data?.totals?.orders)} órdenes facturadas`
              : 'Ninguna orden del filtro tiene factura aplicada'}
          />
        </div>

        {/* PESTAÑAS */}
        <div className="flex items-center gap-2 flex-wrap">
          {TABS.map(t => (
            <button
              key={t.key}
              onClick={() => changeTab(t.key)}
              className={`h-10 px-4 rounded-xl text-sm font-bold flex items-center gap-2 border transition-colors ${
                tab === t.key
                  ? 'bg-blue-600 text-white border-blue-600'
                  : 'bg-white text-slate-600 border-slate-200 hover:border-blue-300 hover:text-blue-600'
              }`}
              data-testid={`fb-tab-${t.key}`}
            >
              {t.key === 'revisadas' && <ShieldCheck className="w-4 h-4" />}
              {t.label}
              <span className={`px-1.5 py-0.5 rounded text-[11px] font-black ${
                tab === t.key ? 'bg-white/20' : 'bg-slate-100 text-slate-500'
              }`}>
                {counts[t.key] === undefined ? '—' : fmt(counts[t.key])}
              </span>
            </button>
          ))}
        </div>

        {/* TABLA */}
        <Card className="overflow-hidden">
          <div className="px-5 py-4 flex items-center justify-between border-b border-slate-200">
            <p className="text-sm font-bold text-slate-800">
              {TABS.find(t => t.key === tab)?.label} ({fmt(data?.total)})
            </p>
            <button
              onClick={fetchRows}
              className="p-2 rounded-lg bg-white border border-slate-200 text-slate-500 hover:text-blue-600 hover:border-blue-300 transition-colors"
              title="Actualizar"
              data-testid="fb-refresh"
            >
              <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
            </button>
          </div>

          {error ? (
            <div className="p-8 text-center text-sm text-red-600">{error}</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-slate-200 bg-slate-50">
                    {canReview && (
                      <th className="w-10 px-4 py-3">
                        <input
                          type="checkbox"
                          checked={rows.length > 0 && selected.size === rows.length}
                          onChange={toggleAll}
                          className="w-4 h-4 rounded border-slate-300 text-blue-600"
                          data-testid="fb-select-all"
                        />
                      </th>
                    )}
                    {visibleColumns.map(c => (
                      <th
                        key={c.key}
                        onClick={() => c.sortable && toggleSort(c.key)}
                        className={`px-4 py-3 text-xs font-bold text-slate-500 whitespace-nowrap ${
                          c.align === 'right' ? 'text-right' : 'text-left'
                        } ${c.sortable ? 'cursor-pointer select-none hover:text-blue-600' : ''}`}
                      >
                        <span className="inline-flex items-center gap-1">
                          {c.label}
                          {c.sortable && (
                            <ChevronsUpDown className={`w-3 h-3 ${sort.by === c.key ? 'text-blue-600' : 'text-slate-300'}`} />
                          )}
                        </span>
                      </th>
                    ))}
                    <th className="sticky right-0 z-20 bg-slate-50 border-l border-slate-200 px-4 py-3 text-xs font-bold text-slate-500 text-right">
                      Acciones
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {loading && rows.length === 0 && (
                    <tr><td colSpan={visibleColumns.length + 2} className="px-4 py-12 text-center text-slate-400">
                      <Loader2 className="w-5 h-5 animate-spin inline" />
                    </td></tr>
                  )}
                  {!loading && rows.length === 0 && (
                    <tr><td colSpan={visibleColumns.length + 2} className="px-4 py-12 text-center text-sm text-slate-400">
                      {hasFilters ? 'Ninguna orden coincide con los filtros.' : 'No hay órdenes en esta bandeja.'}
                    </td></tr>
                  )}
                  {rows.map(r => {
                    const vencida = r.cancel_date && r.cancel_date < todayStr();
                    return (
                      <tr key={r.order_id} className="group border-b border-slate-100 last:border-0 hover:bg-slate-50">
                        {canReview && (
                          <td className="px-4 py-3">
                            <input
                              type="checkbox"
                              checked={selected.has(r.order_id)}
                              onChange={() => toggleRow(r.order_id)}
                              className="w-4 h-4 rounded border-slate-300 text-blue-600"
                              data-testid={`fb-check-${r.order_number}`}
                            />
                          </td>
                        )}
                        {visibleColumns.map(c => {
                          let content;
                          if (c.key === 'order_number') content = <span className="font-bold text-slate-900">{r.order_number}</span>;
                          else if (c.key === 'cancel_date') content = (
                            <span className={vencida ? 'text-red-600 font-semibold' : 'text-slate-600'}>{fmtDate(r.cancel_date)}</span>
                          );
                          else if (c.key === 'final_bill') content = (
                            <DateCell
                              value={r.final_bill}
                              onSave={(v) => saveFinalBill(r.order_id, v)}
                            />
                          );
                          else if (c.key === 'status_at') content = (
                            <span
                              className={r.status_at ? 'text-slate-600' : 'text-slate-300'}
                              title={r.status_at
                                ? `Pasó a ${r.production_status} el ${new Date(r.status_at).toLocaleString()}`
                                : 'Sin evento registrado del cambio de estatus'}
                            >{fmtStamp(r.status_at)}</span>
                          );
                          else if (c.key === 'qty') content = <span className="font-semibold text-slate-800">{fmt(r.qty)}</span>;
                          else if (c.key === 'total_amount') content = (
                            <span
                              className={r.total_amount === null || r.total_amount === undefined
                                ? 'text-slate-300'
                                : 'font-semibold text-slate-800 tabular-nums'}
                              title={r.total_amount === null || r.total_amount === undefined
                                ? 'La orden todavía no tiene factura aplicada desde Printavo'
                                : 'Total facturado (Printavo)'}
                            >{fmtMoney(r.total_amount)}</span>
                          );
                          else content = <span className="text-slate-600">{r[c.key] || '—'}</span>;
                          return (
                            <td key={c.key} className={`px-4 py-3 whitespace-nowrap ${c.align === 'right' ? 'text-right' : ''}`}>
                              {content}
                            </td>
                          );
                        })}
                        <td className="sticky right-0 z-10 bg-white group-hover:bg-slate-50 border-l border-slate-200 px-4 py-3 text-right">
                          {canReview ? (
                            r.reviewed ? (
                              <button
                                onClick={() => review([r.order_id], false)}
                                disabled={acting}
                                title={`Revisada por ${r.reviewed_by_name || '—'}${r.reviewed_at ? ' el ' + new Date(r.reviewed_at).toLocaleString() : ''}`}
                                className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-slate-100 text-slate-600 text-xs font-bold hover:bg-slate-200 disabled:opacity-50"
                                data-testid={`fb-undo-${r.order_number}`}
                              >
                                <Undo2 className="w-3.5 h-3.5" /> Devolver
                              </button>
                            ) : (
                              <button
                                onClick={() => review([r.order_id], true)}
                                disabled={acting}
                                className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-emerald-50 text-emerald-700 text-xs font-bold hover:bg-emerald-100 disabled:opacity-50"
                                data-testid={`fb-review-${r.order_number}`}
                              >
                                <Check className="w-3.5 h-3.5" /> Revisada
                              </button>
                            )
                          ) : (
                            <span className="text-xs text-slate-400">
                              {r.reviewed ? (r.reviewed_by_name || 'revisada') : '—'}
                            </span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          {/* PAGINACIÓN */}
          <div className="px-5 py-4 border-t border-slate-200 flex items-center justify-between flex-wrap gap-3">
            <span className="text-xs text-slate-500">
              Mostrando {fmt(from)} a {fmt(to)} de {fmt(data?.total)} registros
            </span>
            <div className="flex items-center gap-1">
              <button onClick={() => setPage(1)} disabled={page <= 1}
                className="p-1.5 rounded-lg border border-slate-200 text-slate-500 disabled:opacity-30 hover:border-blue-300">
                <ChevronsLeft className="w-4 h-4" />
              </button>
              <button onClick={() => setPage(p => Math.max(1, p - 1))} disabled={page <= 1}
                className="p-1.5 rounded-lg border border-slate-200 text-slate-500 disabled:opacity-30 hover:border-blue-300">
                <ChevronLeft className="w-4 h-4" />
              </button>
              {pageButtons.map((p, i) => p === '…' ? (
                <span key={`e${i}`} className="px-2 text-slate-400">…</span>
              ) : (
                <button
                  key={p}
                  onClick={() => setPage(p)}
                  className={`min-w-[32px] h-8 px-2 rounded-lg text-xs font-bold border transition-colors ${
                    p === page ? 'bg-blue-600 text-white border-blue-600' : 'bg-white text-slate-600 border-slate-200 hover:border-blue-300'
                  }`}
                >{p}</button>
              ))}
              <button onClick={() => setPage(p => Math.min(pages, p + 1))} disabled={page >= pages}
                className="p-1.5 rounded-lg border border-slate-200 text-slate-500 disabled:opacity-30 hover:border-blue-300">
                <ChevronRight className="w-4 h-4" />
              </button>
              <button onClick={() => setPage(pages)} disabled={page >= pages}
                className="p-1.5 rounded-lg border border-slate-200 text-slate-500 disabled:opacity-30 hover:border-blue-300">
                <ChevronsRight className="w-4 h-4" />
              </button>
            </div>
            <div className="flex items-center gap-2 text-xs text-slate-500">
              Mostrar
              <select
                value={pageSize}
                onChange={(e) => { setPageSize(parseInt(e.target.value, 10)); setPage(1); }}
                className="h-8 px-2 bg-white border border-slate-200 rounded-lg text-xs outline-none focus:border-blue-400"
                data-testid="fb-page-size"
              >
                {[10, 25, 50, 100].map(n => <option key={n} value={n}>{n}</option>)}
              </select>
              por página
            </div>
          </div>
        </Card>

        <p className="text-[11px] text-slate-400 leading-relaxed">
          Solo entran órdenes con production status <b>LISTO PARA ENVIO</b> o <b>LISTO PARA INVENTARIO</b>.
          Marcar una orden como revisada la mueve a la pestaña <b>Revisadas</b> y la saca de las otras dos,
          pero <b>no cambia su production status ni su tablero</b>: sigue igual para producción, envíos y WMS.
          Se puede devolver con el botón <b>Devolver</b>.
          {' '}La columna <b>Final Bill</b> se edita con un clic, igual que la columna de calendario del tablero,
          y guarda sobre la misma orden. <b>Total Amount</b> es el total facturado que la sincronización de
          Printavo copia sobre la orden; sale <b>—</b> en las que todavía no tienen factura aplicada.
        </p>
      </main>
    </div>
  );
};

export default FinalBillModule;
