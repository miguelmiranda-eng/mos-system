import React, { useState, useEffect, useCallback } from "react";
import { 
  Package, 
  Upload, 
  FileText, 
  FileSpreadsheet, 
  Image as ImageIcon, 
  Trash2, 
  CheckCircle2, 
  Clock,
  ExternalLink,
  ChevronRight,
  Search,
  Camera,
  Layers,
  Truck,
  Download,
  Loader2
} from "lucide-react";
import * as XLSX from "xlsx";
import { Toaster, toast } from "sonner";

const BACKEND_URL = process.env.REACT_APP_BACKEND_URL;
const API = `${BACKEND_URL}/api`;

// Calendario de envíos programados: cascada mes → semana del mes (1..5) → día
// de la semana → envío. El DÍA (1..7; 0/null = "Sin día") es propiedad del
// ENVÍO (envio_days en la config de la semana), no de cada orden: mover un
// envío de día arrastra todas sus órdenes.
const MONTHS = ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic'];
const MONTHS_FULL = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];
const WEEKS = [1, 2, 3, 4, 5];
const DAYS = ['Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb', 'Dom'];
const DAYS_FULL = ['Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado', 'Domingo'];
const dayLabel = (d, full = false) => (d ? (full ? DAYS_FULL : DAYS)[d - 1] : 'Sin día');

const ShippingModule = () => {
  const [orderNumbers, setOrderNumbers] = useState("");
  const [notes, setNotes] = useState("");
  const [files, setFiles] = useState([]);
  const [loading, setLoading] = useState(false);
  const [records, setRecords] = useState([]);
  const [fetchLoading, setFetchLoading] = useState(false);
  const [searchDate, setSearchDate] = useState(new Date().toISOString().split('T')[0]);
  const [selectedRecord, setSelectedRecord] = useState(null);

  // Pestaña "Con Packing": órdenes que ya tienen packing cargado (el camioncito).
  // Se traen de 50 en 50 (no todas de golpe) y se pueden exportar a Excel.
  const PAGE = 50;
  const [activeTab, setActiveTab] = useState('registro');
  const [shipped, setShipped] = useState([]);
  const [shippedTotal, setShippedTotal] = useState(0);
  const [shippedLoading, setShippedLoading] = useState(false);
  const [exporting, setExporting] = useState(false);

  // Pestaña "Envíos programados": programador con persistencia (scheduled_shipments).
  // Izquierda = órdenes disponibles (sin camioncito, no programadas). Derecha = tabla
  // de programadas con Export date / Delivery to editables y Days Com. calculado.
  const [scheduled, setScheduled] = useState([]);
  const [scheduledLoading, setScheduledLoading] = useState(false);
  const [available, setAvailable] = useState([]);
  const [availableTotal, setAvailableTotal] = useState(0);
  const [availableLoading, setAvailableLoading] = useState(false);
  const [availableSearch, setAvailableSearch] = useState('');
  const [schedExporting, setSchedExporting] = useState(false);
  // Calendario en cascada: año → mes abierto (null = grilla de meses) →
  // semana visible → día visible → envíos. Un solo nivel de cada cosa en
  // pantalla; las órdenes que se programan caen donde estás parado
  // (mes/semana visibles) en el envío marcado como destino.
  const [calYear, setCalYear] = useState(() => new Date().getFullYear());
  const [calMonth, setCalMonth] = useState(null);           // null | 1..12
  const [selWeek, setSelWeek] = useState(1);                // semana visible 1..5
  const [selDay, setSelDay] = useState(0);                  // día visible: 0 = "Sin día" | 1..7
  const [showAvailable, setShowAvailable] = useState(true);   // rail lateral de disponibles
  const [weekEnvios, setWeekEnvios] = useState([]);           // config por semana [{year,month,week,envios,envio_days}]
  const [targetEnvio, setTargetEnvio] = useState(1);          // envío destino al programar
  const [collapsedEnvios, setCollapsedEnvios] = useState(() => new Set());
  // Config de la semana y día del envío (envio_days["<n>"]; 0 = "Sin día").
  // Definidos aquí arriba porque scheduleOrder y el export los usan.
  const weekCfg = (year, m, w) =>
    weekEnvios.find((x) => x.scheduled_year === year && x.scheduled_month === m && x.scheduled_week === w);
  const envioDayFor = (year, m, w, env) => {
    const c = weekCfg(year, m, w);
    return (c && c.envio_days && c.envio_days[String(env)]) || 0;
  };

  // ── Envíos por semana (grupos Envío 1, Envío 2, …) ──────────────────────────
  // Nº de grupos = máx(configurado, mayor shipment_no presente, 1). Year-aware
  // para que los exports de otros años no calculen con el año visible.
  const enviosOfWeekYear = (year, m, w) => {
    let present = 0;
    for (const r of scheduled) {
      if (r.scheduled_year === year && r.scheduled_month === m && r.scheduled_week === w) {
        present = Math.max(present, r.shipment_no || 1);
      }
    }
    const c = weekCfg(year, m, w);
    return Math.max(1, c ? (c.envios || 0) : 0, present);
  };
  const enviosForWeek = (m, w) => enviosOfWeekYear(calYear, m, w);

  // Numeración VISIBLE por día (pedido 2026-08-14): el usuario piensa
  // "semana 1 → lunes → envío 1, martes → envío 1" — cada día arranca su
  // propia cuenta. Internamente shipment_no sigue siendo por semana (es la
  // llave de persistencia y de los datos ya programados); aquí solo se
  // traduce a la posición del envío dentro de su día para TODO lo visible
  // (headers, toasts, selects y Excel).
  const envioDayNum = (year, m, w, env) => {
    const day = envioDayFor(year, m, w, env);
    const same = Array.from({ length: enviosOfWeekYear(year, m, w) }, (_, i) => i + 1)
      .filter((e) => envioDayFor(year, m, w, e) === day);
    const i = same.indexOf(env);
    return { day, num: i >= 0 ? i + 1 : env };
  };
  // Etiqueta corta "Lun · Envío 2" (o "Sin día · Envío 1") de un envío interno.
  const envioLabel = (year, m, w, env, full = false) => {
    const { day, num } = envioDayNum(year, m, w, env);
    return `${dayLabel(day, full)} · Envío ${num}`;
  };

  // ── Navegación de la cascada semana → día ───────────────────────────────────
  const TAB_ORDER = [1, 2, 3, 4, 5, 6, 7, 0]; // Lun..Dom y "Sin día" al final
  const dayEnvsOf = (m, w, d) =>
    Array.from({ length: enviosForWeek(m, w) }, (_, i) => i + 1)
      .filter((env) => envioDayFor(calYear, m, w, env) === d);
  // El envío destino sigue SIEMPRE al día visible: al cambiar de día o semana
  // se re-marca el primer envío de esa vista, para que "Programar" y "+ Envío"
  // aterricen donde estás mirando y no en un día fuera de pantalla.
  const selectDay = (m, w, d) => {
    setSelDay(d);
    const envs = dayEnvsOf(m, w, d);
    if (envs.length) setTargetEnvio(envs[0]);
  };
  // Al entrar a una semana, abre el primer día (desde Lunes) con envíos; si
  // nada está distribuido aún, abre "Sin día" (donde nacen los envíos).
  const defaultDayFor = (m, w) => TAB_ORDER.find((d) => dayEnvsOf(m, w, d).length > 0) ?? 0;
  const openWeek = (m, w) => { setSelWeek(w); selectDay(m, w, defaultDayFor(m, w)); };
  const openMonth = (m) => {
    const first = WEEKS.find((w) => scheduled.some((r) =>
      r.scheduled_year === calYear && r.scheduled_month === m && r.scheduled_week === w)) || 1;
    setCalMonth(m);
    openWeek(m, first);
  };
  // Mueve el ENVÍO completo (con sus órdenes) a otro día de la semana.
  const moveEnvioDay = async (m, w, env, day) => {
    try {
      const res = await fetch(`${API}/scheduled-shipments/envio-day`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
        body: JSON.stringify({ scheduled_year: calYear, scheduled_month: m, scheduled_week: w, shipment_no: env, day: day || null }),
      });
      if (res.ok) {
        const d = await res.json();
        setWeekEnvios((prev) => [
          ...prev.filter((x) => !(x.scheduled_year === d.scheduled_year && x.scheduled_month === d.scheduled_month && x.scheduled_week === d.scheduled_week)),
          d,
        ]);
        toast.success(`Envío movido a ${dayLabel(day, true)} (la numeración del día se reacomoda)`);
      } else toast.error('No se pudo mover el envío de día');
    } catch { toast.error('Error de conexión'); }
  };
  // "+ Envío": el envío nuevo nace EN el día visible (no en "Sin día") y queda
  // marcado como destino, listo para programarle órdenes. Sin esto, el envío
  // nacía en "Sin día" y parecía que el botón no hacía nada.
  const addEnvio = async (m, w) => {
    const next = enviosForWeek(m, w) + 1;
    // Número VISIBLE que tendrá: siguiente posición dentro del día abierto.
    const visibleNum = dayEnvsOf(m, w, selDay).length + 1;
    try {
      const res = await fetch(`${API}/scheduled-shipments/week-config`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
        body: JSON.stringify({ scheduled_year: calYear, scheduled_month: m, scheduled_week: w, envios: next }),
      });
      if (!res.ok) { toast.error('No se pudo agregar el envío'); return; }
      let doc = await res.json();
      if (selDay > 0) {
        const res2 = await fetch(`${API}/scheduled-shipments/envio-day`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
          body: JSON.stringify({ scheduled_year: calYear, scheduled_month: m, scheduled_week: w, shipment_no: next, day: selDay }),
        });
        if (res2.ok) doc = await res2.json();
      }
      setWeekEnvios((prev) => [
        ...prev.filter((x) => !(x.scheduled_year === doc.scheduled_year && x.scheduled_month === doc.scheduled_month && x.scheduled_week === doc.scheduled_week)),
        doc,
      ]);
      setTargetEnvio(next);
      toast.success(`Envío ${visibleNum} agregado a ${dayLabel(selDay, true)} · Semana ${w}`);
    } catch { toast.error('Error de conexión'); }
  };
  const toggleEnvio = (key) => setCollapsedEnvios((prev) => {
    const n = new Set(prev);
    if (n.has(key)) n.delete(key); else n.add(key);
    return n;
  });

  // Lock the background page scroll while the detail modal is open so iPad/iOS
  // doesn't scroll the page behind the modal (scroll-chaining) when the user
  // drags inside the modal to reach the images.
  useEffect(() => {
    if (!selectedRecord) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = prev; };
  }, [selectedRecord]);

  const getFullUrl = (url) => {
    if (!url) return "";
    if (url.startsWith("http")) return url;
    const cleanBase = BACKEND_URL?.endsWith("/") ? BACKEND_URL.slice(0, -1) : BACKEND_URL;
    // The backend mounts shipping uploads at /api/shipping/static
    const fileName = url.split('/').pop(); 
    return `${cleanBase}/api/shipping/static/${fileName}`;
  };

  const fetchRecords = useCallback(async () => {
    setFetchLoading(true);
    try {
      const res = await fetch(`${API}/shipping?date=${searchDate}`, { credentials: "include" });
      if (res.ok) {
        const data = await res.json();
        setRecords(data);
      }
    } catch (err) {
      console.error("Error fetching shipping records:", err);
    } finally {
      setFetchLoading(false);
    }
  }, [searchDate]);

  useEffect(() => {
    fetchRecords();
  }, [fetchRecords]);

  // Carga una página de órdenes con packing. reset=true reinicia desde 0;
  // reset=false agrega los siguientes 50 (botón "Cargar más").
  const loadShipped = async (reset) => {
    setShippedLoading(true);
    try {
      const skip = reset ? 0 : shipped.length;
      const res = await fetch(`${API}/orders/shipped?skip=${skip}&limit=${PAGE}`, { credentials: 'include' });
      if (res.ok) {
        const data = await res.json();
        setShippedTotal(data.total || 0);
        setShipped(prev => reset ? (data.items || []) : [...prev, ...(data.items || [])]);
      } else {
        toast.error('No se pudo cargar la lista de envíos');
      }
    } catch {
      toast.error('Error de conexión');
    } finally {
      setShippedLoading(false);
    }
  };

  // Al entrar por primera vez a la pestaña, trae la primera página.
  useEffect(() => {
    if (activeTab === 'packing' && shipped.length === 0 && shippedTotal === 0) {
      loadShipped(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab]);

  // Exporta TODA la lista (no solo lo cargado) a Excel, trayéndola por bloques.
  const exportShipped = async () => {
    setExporting(true);
    try {
      const BIG = 5000;
      let all = [];
      let skip = 0;
      while (true) {
        const res = await fetch(`${API}/orders/shipped?skip=${skip}&limit=${BIG}`, { credentials: 'include' });
        if (!res.ok) throw new Error('fetch');
        const data = await res.json();
        all = all.concat(data.items || []);
        if (!(data.items || []).length || all.length >= (data.total || 0)) break;
        skip += BIG;
      }
      if (!all.length) { toast.error('No hay envíos para exportar'); return; }
      const rows = all.map(o => ({
        'Orden': o.order_number || '',
        'Cliente': o.client || '',
        'Customer PO': o.customer_po || '',
        'Style': o.style || '',
        'Color': o.color || '',
        'Cantidad': o.quantity ?? '',
        'Tablero': o.board || '',
        'Packing': o.packing_link_label || o.packing_link || '',
        'Fecha packing': o.packing_link_at ? new Date(o.packing_link_at).toLocaleString() : '',
        'Entrega': o.due_date || '',
      }));
      const ws = XLSX.utils.json_to_sheet(rows);
      ws['!cols'] = [{ wch: 10 }, { wch: 24 }, { wch: 16 }, { wch: 14 }, { wch: 14 },
                     { wch: 10 }, { wch: 16 }, { wch: 28 }, { wch: 20 }, { wch: 12 }];
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, 'Envios_con_packing');
      XLSX.writeFile(wb, `envios_con_packing_${new Date().toISOString().split('T')[0]}.xlsx`);
      toast.success(`${all.length} envío(s) exportado(s)`);
    } catch {
      toast.error('No se pudo exportar');
    } finally {
      setExporting(false);
    }
  };

  // ── Envíos programados ──────────────────────────────────────────────────────
  const loadScheduled = useCallback(async () => {
    setScheduledLoading(true);
    try {
      const res = await fetch(`${API}/scheduled-shipments`, { credentials: 'include' });
      if (res.ok) { const d = await res.json(); setScheduled(d.items || []); setWeekEnvios(d.weeks || []); }
      else toast.error('No se pudo cargar envíos programados');
    } catch { toast.error('Error de conexión'); }
    finally { setScheduledLoading(false); }
  }, []);

  const loadAvailable = useCallback(async (reset, term) => {
    setAvailableLoading(true);
    try {
      const skip = reset ? 0 : available.length;
      const s = term !== undefined ? term : availableSearch;
      const res = await fetch(`${API}/orders/available-to-ship?skip=${skip}&limit=50&search=${encodeURIComponent(s)}`, { credentials: 'include' });
      if (res.ok) {
        const d = await res.json();
        setAvailableTotal(d.total || 0);
        setAvailable(prev => reset ? (d.items || []) : [...prev, ...(d.items || [])]);
      } else toast.error('No se pudo cargar disponibles');
    } catch { toast.error('Error de conexión'); }
    finally { setAvailableLoading(false); }
  }, [available.length, availableSearch]);

  useEffect(() => {
    if (activeTab === 'programados') loadScheduled();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab]);

  // Programa la orden DONDE ESTÁS PARADO: mes/semana visibles + envío destino.
  const scheduleOrder = async (orderNumber) => {
    if (!calMonth) { toast.error('Abre un mes del calendario para programar'); return; }
    // El destino debe ser un envío del día que estás viendo — si cayera en un
    // envío de otro día, la orden aterrizaría fuera de pantalla y parecería
    // que el botón no hizo nada.
    if (!dayEnvsOf(calMonth, selWeek, selDay).includes(targetEnvio)) {
      toast.error(`Marca "programar aquí" en un envío de ${dayLabel(selDay, true)}, o créalo con + Envío`);
      return;
    }
    try {
      const res = await fetch(`${API}/scheduled-shipments`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
        body: JSON.stringify({
          order_number: orderNumber,
          scheduled_year: calYear,
          scheduled_month: calMonth,
          scheduled_week: selWeek,
          shipment_no: targetEnvio,
        }),
      });
      if (res.ok) {
        toast.success(`#${orderNumber} → ${MONTHS[calMonth - 1]} S${selWeek} · ${envioLabel(calYear, calMonth, selWeek, targetEnvio)}`);
        loadScheduled();
        if (availableSearch.trim()) loadAvailable(true);
      } else { const e = await res.json().catch(() => ({})); toast.error(e.detail || 'No se pudo programar'); }
    } catch { toast.error('Error de conexión'); }
  };

  const updateScheduled = async (shipmentId, patch) => {
    try {
      const res = await fetch(`${API}/scheduled-shipments/${shipmentId}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
        body: JSON.stringify(patch),
      });
      if (res.ok) { const row = await res.json(); setScheduled(prev => prev.map(r => r.shipment_id === shipmentId ? row : r)); }
      else toast.error('No se pudo actualizar');
    } catch { toast.error('Error de conexión'); }
  };

  const unschedule = async (shipmentId, orderNumber) => {
    if (!window.confirm(`¿Quitar #${orderNumber} de envíos programados?`)) return;
    try {
      const res = await fetch(`${API}/scheduled-shipments/${shipmentId}`, { method: 'DELETE', credentials: 'include' });
      if (res.ok) { toast.success(`#${orderNumber} desprogramado`); loadScheduled(); if (availableSearch.trim()) loadAvailable(true); }
      else toast.error('No se pudo desprogramar');
    } catch { toast.error('Error de conexión'); }
  };

  // Fila de Excel de una programación — compartida por el export global y el
  // export POR ENVÍO. 'Día'/'Envío' usan la numeración visible por día.
  const schedExcelRow = (r) => {
    const { day, num } = envioDayNum(r.scheduled_year, r.scheduled_month, r.scheduled_week, r.shipment_no || 1);
    return {
      'Orden': r.order_number || '',
      'Cust. PO': r.customer_po || '',
      'Design #': r.design_num || '',
      'Cancel Date': r.cancel_date || '',
      'Cliente': r.client || '',
      'Branding': r.branding || '',
      'Qty': r.quantity ?? '',
      'Status': r.production_status || '',
      'Año': r.scheduled_year ?? '',
      'Mes': r.scheduled_month ? MONTHS_FULL[r.scheduled_month - 1] : '',
      'Semana': r.scheduled_week ? `Semana ${r.scheduled_week}` : '',
      'Día': day ? DAYS_FULL[day - 1] : 'Sin día',
      'Envío': `Envío ${num}`,
      'PL - Export': r.pl_number || '',
      'Export date': r.scheduled_export_date || '',
      'Delivery to': r.delivery_to || '',
      'Days Com.': r.days_com ?? '',
      'NOTES': r.notes || '',
    };
  };

  const exportScheduled = () => {
    if (!scheduled.length) { toast.error('No hay envíos programados'); return; }
    setSchedExporting(true);
    try {
      const ws = XLSX.utils.json_to_sheet(scheduled.map(schedExcelRow));
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, 'Envios_programados');
      XLSX.writeFile(wb, `envios_programados_${new Date().toISOString().split('T')[0]}.xlsx`);
      toast.success(`${scheduled.length} programado(s) exportado(s)`);
    } catch { toast.error('No se pudo exportar'); }
    finally { setSchedExporting(false); }
  };

  // Excel de UN envío (pedido 2026-08-14): exporta solo las órdenes del envío
  // con nombre de archivo que dice exactamente qué es (mes, semana, día y
  // número visible del envío en su día).
  const exportEnvio = (m, w, env, glist) => {
    if (!glist.length) { toast.error('Este envío no tiene órdenes'); return; }
    try {
      const { day, num } = envioDayNum(calYear, m, w, env);
      const ws = XLSX.utils.json_to_sheet(glist.map(schedExcelRow));
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, `Envio ${num}`);
      const dia = day ? DAYS_FULL[day - 1] : 'SinDia';
      XLSX.writeFile(wb, `envio_${calYear}_${MONTHS[m - 1]}_S${w}_${dia}_E${num}.xlsx`);
      toast.success(`Envío ${num} (${dayLabel(day, true)}) exportado · ${glist.length} orden(es)`);
    } catch { toast.error('No se pudo exportar el envío'); }
  };

  // Tabla de órdenes de un grupo (envío). `w` = semana, para las opciones de reprogramar.
  const renderOrderTable = (glist, w) => (
    <div className="overflow-x-auto">
      <table className="w-full text-left border-collapse">
        <thead>
          <tr className="text-[10px] font-black uppercase tracking-widest text-slate-400 bg-slate-50/60 border-b border-slate-200">
            <th className="py-2.5 px-3">Orden</th>
            <th className="py-2.5 px-3">Cust. PO</th>
            <th className="py-2.5 px-3">Design #</th>
            <th className="py-2.5 px-3">Cancel Date</th>
            <th className="py-2.5 px-3">Cliente</th>
            <th className="py-2.5 px-3">Branding</th>
            <th className="py-2.5 px-3 text-right">Qty</th>
            <th className="py-2.5 px-3">Status</th>
            <th className="py-2.5 px-3">PL - Export</th>
            <th className="py-2.5 px-3">Export date</th>
            <th className="py-2.5 px-3">Delivery to</th>
            <th className="py-2.5 px-3 text-right">Days Com.</th>
            <th className="py-2.5 px-3">Notes</th>
            <th className="py-2.5 px-3">Reprogramar</th>
            <th className="py-2.5 px-3"></th>
          </tr>
        </thead>
        <tbody>
          {glist.map((r, idx) => (
            <tr key={r.shipment_id} className={`border-b border-slate-100 hover:bg-blue-50/30 ${idx % 2 ? 'bg-slate-50/40' : ''}`}>
              <td className="py-2.5 px-3"><span className="px-2 py-0.5 bg-blue-600 text-white text-[11px] font-black rounded-md whitespace-nowrap">#{r.order_number}</span></td>
              <td className="py-2.5 px-3 text-sm text-slate-600 whitespace-nowrap">{r.customer_po || '—'}</td>
              <td className="py-2.5 px-3 text-sm text-slate-600 whitespace-nowrap">{r.design_num || '—'}</td>
              <td className="py-2.5 px-3 text-sm text-slate-500 whitespace-nowrap">{r.cancel_date || '—'}</td>
              <td className="py-2.5 px-3 text-sm font-bold text-slate-700 whitespace-nowrap">{r.client || '—'}</td>
              <td className="py-2.5 px-3 text-sm text-slate-600 whitespace-nowrap">{r.branding || '—'}</td>
              <td className="py-2.5 px-3 text-sm font-bold text-slate-700 text-right tabular-nums">{r.quantity ?? '—'}</td>
              <td className="py-2.5 px-3 text-sm text-slate-600 whitespace-nowrap">{r.production_status || '—'}</td>
              <td className="py-2.5 px-3 text-sm">
                {r.pl_url ? (
                  <a href={r.pl_url} target="_blank" rel="noopener noreferrer"
                    className="text-blue-600 font-bold hover:underline inline-flex items-center gap-1 whitespace-nowrap"
                    title={r.pl_number || 'Packing list'}>
                    <ExternalLink className="w-3 h-3" /> {r.pl_number || 'PL'}
                  </a>
                ) : r.pl_number ? (
                  <span className="text-slate-600 whitespace-nowrap">{r.pl_number}</span>
                ) : (
                  <span className="text-slate-300">—</span>
                )}
              </td>
              <td className="py-2.5 px-3">
                <input type="date" defaultValue={r.scheduled_export_date || ''}
                  onChange={(e) => updateScheduled(r.shipment_id, { scheduled_export_date: e.target.value })}
                  className="bg-white border border-slate-200 rounded-lg px-2 py-1.5 text-sm text-slate-700 focus:border-blue-400 outline-none" />
              </td>
              <td className="py-2.5 px-3">
                <input defaultValue={r.delivery_to || ''} placeholder="Destino"
                  onBlur={(e) => { const v = e.target.value.trim(); if (v !== (r.delivery_to || '')) updateScheduled(r.shipment_id, { delivery_to: v }); }}
                  className="w-32 bg-white border border-slate-200 rounded-lg px-2 py-1.5 text-sm text-slate-700 focus:border-blue-400 outline-none" />
              </td>
              <td className={`py-2.5 px-3 text-sm font-black text-right whitespace-nowrap tabular-nums ${typeof r.days_com === 'number' && r.days_com < 0 ? 'text-red-500' : 'text-slate-600'}`}>{r.days_com ?? '—'}</td>
              <td className="py-2.5 px-3 text-sm text-slate-500 max-w-[220px] truncate" title={r.notes || ''}>{r.notes || '—'}</td>
              <td className="py-2.5 px-3">
                <div className="flex items-center gap-1">
                  <select value={r.scheduled_month || calMonth}
                    onChange={(e) => updateScheduled(r.shipment_id, { scheduled_month: Number(e.target.value) })}
                    title="Mover a mes"
                    className="bg-white border border-slate-200 rounded-lg px-1.5 py-1.5 text-xs font-bold text-slate-700 focus:border-blue-400 outline-none">
                    {MONTHS.map((mn, i) => <option key={i} value={i + 1}>{mn}</option>)}
                  </select>
                  <select value={r.scheduled_week || 1}
                    onChange={(e) => updateScheduled(r.shipment_id, { scheduled_week: Number(e.target.value) })}
                    title="Mover a semana"
                    className="bg-white border border-slate-200 rounded-lg px-1.5 py-1.5 text-xs font-bold text-slate-700 focus:border-blue-400 outline-none">
                    {WEEKS.map((wk) => <option key={wk} value={wk}>S{wk}</option>)}
                  </select>
                  {/* Mover a otro envío de la semana: las opciones se nombran
                      por su día + número visible (Lun·E1, Mar·E2…), no por el
                      número interno de semana. */}
                  <select value={r.shipment_no || 1}
                    onChange={(e) => updateScheduled(r.shipment_id, { shipment_no: Number(e.target.value) })}
                    title="Mover a otro envío (día · número)"
                    className="bg-white border border-slate-200 rounded-lg px-1.5 py-1.5 text-xs font-bold text-slate-700 focus:border-blue-400 outline-none">
                    {Array.from({ length: Math.max(enviosForWeek(calMonth, w), r.shipment_no || 1) }, (_, i) => i + 1).map((n) => {
                      const { day, num } = envioDayNum(calYear, calMonth, w, n);
                      return <option key={n} value={n}>{dayLabel(day)} · E{num}</option>;
                    })}
                  </select>
                </div>
              </td>
              <td className="py-2.5 px-3">
                <button onClick={() => unschedule(r.shipment_id, r.order_number)} title="Quitar"
                  className="p-1.5 rounded-lg text-slate-300 hover:bg-red-50 hover:text-red-500 transition-colors">
                  <Trash2 className="w-4 h-4" />
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );

  const handleFileChange = (e) => {
    const selectedFiles = Array.from(e.target.files);
    setFiles(prev => [...prev, ...selectedFiles]);
  };

  const removeFile = (index) => {
    setFiles(prev => prev.filter((_, i) => i !== index));
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!orderNumbers.trim()) return toast.error("Ingresa al menos un número de orden");

    setLoading(true);
    const formData = new FormData();
    formData.append("order_numbers", orderNumbers);
    formData.append("notes", notes);
    files.forEach(file => {
      formData.append("files", file);
    });

    try {
      const res = await fetch(`${API}/shipping`, {
        method: "POST",
        credentials: "include",
        body: formData
      });

      if (res.ok) {
        toast.success("Envío registrado exitosamente");
        setOrderNumbers("");
        setNotes("");
        setFiles([]);
        fetchRecords();
      } else {
        const err = await res.json();
        toast.error(err.detail || "Error al registrar envío");
      }
    } catch (err) {
      toast.error("Error de conexión");
    } finally {
      setLoading(false);
    }
  };

  const getFileIcon = (type) => {
    if (["jpg", "jpeg", "png"].includes(type)) return <ImageIcon className="w-5 h-5 text-blue-500" />;
    if (type === "pdf") return <FileText className="w-5 h-5 text-red-500" />;
    if (["xlsx", "xls", "csv"].includes(type)) return <FileSpreadsheet className="w-5 h-5 text-green-600" />;
    return <FileText className="w-5 h-5 text-slate-400" />;
  };

  return (
    <div className="min-h-screen bg-[#f1f5f9] p-4 md:p-8 space-y-8 font-barlow animate-in fade-in duration-700">
      {/* Esta página nunca montó un <Toaster>: TODOS sus toasts (programar,
          mover, exportar…) se disparaban al vacío. El resto de páginas montan
          el suyo (Dashboard, BackupCenter, App). */}
      <Toaster position="bottom-right" richColors />

      {/* Header Container */}
      <header className="max-w-7xl mx-auto flex flex-col md:flex-row items-start md:items-center justify-between gap-6 bg-white p-6 rounded-[2rem] shadow-sm border border-slate-200">
        <div className="flex items-center gap-5">
          <div className="w-14 h-14 bg-blue-600 rounded-2xl flex items-center justify-center shadow-lg shadow-blue-200 rotate-3 group-hover:rotate-0 transition-transform">
            <Package className="w-8 h-8 text-white" />
          </div>
          <div>
            <h1 className="text-2xl md:text-3xl font-black text-slate-800 tracking-tight leading-none mb-1">
              REGISTRO DE <span className="text-blue-600">ENVÍOS</span>
            </h1>
            <p className="text-slate-500 font-semibold text-sm">PROSPER MANUFACTURING SYSTEM</p>
          </div>
        </div>

        {activeTab === 'registro' && (
          <div className="flex items-center gap-3 bg-slate-50 px-4 py-3 rounded-2xl border border-slate-200 w-full md:w-auto">
            <Search className="w-5 h-5 text-blue-600" />
            <input
              type="date"
              value={searchDate}
              onChange={(e) => setSearchDate(e.target.value)}
              className="bg-transparent border-none text-slate-800 font-bold text-sm focus:ring-0 cursor-pointer w-full"
            />
          </div>
        )}
      </header>

      {/* Pestañas */}
      <div className="max-w-7xl mx-auto flex gap-2">
        <button
          onClick={() => setActiveTab('registro')}
          className={`flex items-center gap-2 px-5 py-3 rounded-2xl font-black uppercase tracking-widest text-xs transition-all ${
            activeTab === 'registro'
              ? 'bg-blue-600 text-white shadow-lg shadow-blue-200'
              : 'bg-white text-slate-500 border border-slate-200 hover:text-blue-600'
          }`}
        >
          <Package className="w-4 h-4" /> Registro de envíos
        </button>
        <button
          onClick={() => setActiveTab('packing')}
          className={`flex items-center gap-2 px-5 py-3 rounded-2xl font-black uppercase tracking-widest text-xs transition-all ${
            activeTab === 'packing'
              ? 'bg-blue-600 text-white shadow-lg shadow-blue-200'
              : 'bg-white text-slate-500 border border-slate-200 hover:text-blue-600'
          }`}
        >
          <Truck className="w-4 h-4" /> Con packing cargado
        </button>
        <button
          onClick={() => setActiveTab('programados')}
          className={`flex items-center gap-2 px-5 py-3 rounded-2xl font-black uppercase tracking-widest text-xs transition-all ${
            activeTab === 'programados'
              ? 'bg-blue-600 text-white shadow-lg shadow-blue-200'
              : 'bg-white text-slate-500 border border-slate-200 hover:text-blue-600'
          }`}
        >
          <Clock className="w-4 h-4" /> Envíos programados
        </button>
      </div>

      {activeTab === 'registro' && (
      <main className="max-w-7xl mx-auto grid grid-cols-1 lg:grid-cols-12 gap-8 items-start">

        {/* Left Column: Form */}
        <div className="lg:col-span-5">
          <form onSubmit={handleSubmit} className="bg-white rounded-[2.5rem] p-8 shadow-xl shadow-slate-200/50 border border-slate-100 space-y-8">
            
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <label className="text-[11px] font-black uppercase tracking-[0.2em] text-blue-600 flex items-center gap-2">
                  <Layers className="w-4 h-4" />
                  Números de Órdenes
                </label>
                <span className="text-[10px] font-bold text-slate-400 bg-slate-100 px-2 py-1 rounded-md">
                  Separar por espacio
                </span>
              </div>
              <textarea 
                placeholder="Ej: 505050 505051"
                value={orderNumbers}
                onChange={(e) => setOrderNumbers(e.target.value)}
                className="w-full h-36 bg-slate-50 border-2 border-slate-100 rounded-[1.5rem] p-5 text-slate-900 text-lg placeholder:text-slate-300 focus:border-blue-600 focus:ring-4 focus:ring-blue-100 transition-all resize-none font-mono font-bold leading-relaxed"
              />
            </div>

            <div className="space-y-4">
              <label className="text-[11px] font-black uppercase tracking-[0.2em] text-blue-600">Notas Adicionales</label>
              <input 
                type="text"
                placeholder="Detalles del transportista, etc."
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                className="w-full bg-slate-50 border-2 border-slate-100 rounded-2xl p-4 text-slate-900 text-sm font-bold placeholder:text-slate-300 focus:border-blue-600 focus:ring-4 focus:ring-blue-100 transition-all"
              />
            </div>

            <div className="space-y-4">
              <label className="text-[11px] font-black uppercase tracking-[0.2em] text-blue-600">Adjuntar Evidencia</label>
              
              <div className="grid grid-cols-2 gap-4">
                <div className="relative group h-28">
                  <input type="file" multiple onChange={handleFileChange} className="absolute inset-0 w-full h-full opacity-0 cursor-pointer z-10" />
                  <div className="h-full border-2 border-dashed border-slate-200 rounded-2xl flex flex-col items-center justify-center gap-2 group-hover:border-blue-600 group-hover:bg-blue-50 transition-all">
                    <Upload className="w-6 h-6 text-blue-600" />
                    <span className="text-[10px] font-black text-slate-500 uppercase">Documentos</span>
                  </div>
                </div>

                <div className="relative group h-28">
                  <input type="file" accept="image/*" capture="environment" onChange={handleFileChange} className="absolute inset-0 w-full h-full opacity-0 cursor-pointer z-10" />
                  <div className="h-full border-2 border-dashed border-blue-200 bg-blue-50/50 rounded-2xl flex flex-col items-center justify-center gap-2 group-hover:border-blue-600 group-hover:bg-blue-100 transition-all">
                    <Camera className="w-6 h-6 text-blue-600 animate-pulse" />
                    <span className="text-[10px] font-black text-blue-700 uppercase">Tomar Foto</span>
                  </div>
                </div>
              </div>

              {/* Selected Files Preview */}
              {files.length > 0 && (
                <div className="space-y-2 mt-4 max-h-40 overflow-y-auto pr-2 custom-scrollbar">
                  {files.map((file, i) => (
                    <div key={i} className="flex items-center justify-between bg-slate-50 p-3 rounded-xl border border-slate-200 animate-in slide-in-from-bottom-2 duration-300">
                      <div className="flex items-center gap-3">
                        {file.type.includes('image') ? <ImageIcon className="w-4 h-4 text-blue-600" /> : <FileText className="w-4 h-4 text-slate-600" />}
                        <span className="text-xs text-slate-800 font-bold truncate max-w-[140px]">{file.name}</span>
                      </div>
                      <button type="button" onClick={() => removeFile(i)} className="p-1.5 text-slate-400 hover:text-red-600 hover:bg-red-50 rounded-lg transition-all">
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <button 
              type="submit"
              disabled={loading}
              className="w-full py-5 bg-blue-600 text-white rounded-[1.5rem] font-black uppercase tracking-[0.2em] text-sm shadow-xl shadow-blue-200 hover:bg-blue-700 hover:-translate-y-1 active:scale-95 transition-all disabled:opacity-50 disabled:translate-y-0 flex items-center justify-center gap-3"
            >
              {loading ? (
                <div className="w-6 h-6 border-3 border-white/30 border-t-white rounded-full animate-spin" />
              ) : (
                <>
                  <CheckCircle2 className="w-6 h-6" />
                  GUARDAR ENVÍO
                </>
              )}
            </button>
          </form>
        </div>

        {/* Right Column: History */}
        <div className="lg:col-span-7">
          <div className="bg-white rounded-[2.5rem] p-8 shadow-xl shadow-slate-200/50 border border-slate-100 min-h-[700px] flex flex-col">
            <div className="flex items-center justify-between mb-8">
              <h3 className="text-xl font-black text-slate-800 flex items-center gap-3">
                <Clock className="w-6 h-6 text-blue-600" />
                SALIDAS DEL DÍA
              </h3>
              <div className="px-3 py-1 bg-blue-50 text-blue-700 text-[10px] font-black rounded-full uppercase">
                {records.length} Registros
              </div>
            </div>

            {fetchLoading ? (
              <div className="flex-1 flex items-center justify-center">
                <div className="w-12 h-12 border-4 border-blue-100 border-t-blue-600 rounded-full animate-spin" />
              </div>
            ) : records.length === 0 ? (
              <div className="flex-1 flex flex-col items-center justify-center text-slate-300">
                <Package className="w-24 h-24 mb-4 opacity-20" />
                <p className="font-black uppercase tracking-widest text-slate-400">Sin movimientos</p>
              </div>
            ) : (
              <div className="space-y-6 overflow-y-auto pr-2 custom-scrollbar flex-1">
                {records.map((rec) => (
                  <div key={rec.shipping_id} className="bg-slate-50 border border-slate-100 rounded-3xl p-4 hover:border-blue-200 transition-all group">
                    <div className="flex justify-between items-center mb-3">
                      <div className="flex flex-wrap gap-1.5">
                        {rec.order_numbers.map(ono => (
                          <span key={ono} className="px-2 py-0.5 bg-blue-600 text-white text-[9px] font-black rounded-md shadow-sm">
                            #{ono}
                          </span>
                        ))}
                      </div>
                      <span className="text-[10px] text-blue-700 font-black uppercase">
                        {new Date(rec.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                      </span>
                    </div>

                    <div className="flex gap-4 items-center">
                      <p className="flex-1 text-sm text-slate-700 font-bold line-clamp-1">{rec.notes || "Envío sin notas"}</p>
                      
                      {rec.evidence?.length > 0 && (
                        <div className="flex -space-x-2">
                          {rec.evidence.slice(0, 3).map((ev) => (
                            <div key={ev.id} className="w-8 h-8 rounded-lg border-2 border-white shadow-sm overflow-hidden bg-white">
                              {["jpg", "jpeg", "png"].includes(ev.type) ? (
                                <img 
                                  src={getFullUrl(ev.url)} 
                                  alt="" 
                                  className="w-full h-full object-cover"
                                  onError={(e) => { e.target.src = ""; e.target.className = "hidden"; }} 
                                />
                              ) : (
                                <div className="w-full h-full flex items-center justify-center">
                                  {getFileIcon(ev.type)}
                                </div>
                              )}
                            </div>
                          ))}
                          {rec.evidence.length > 3 && (
                            <div className="w-8 h-8 rounded-lg border-2 border-white bg-slate-200 flex items-center justify-center text-[8px] font-black text-slate-500 shadow-sm">
                              +{rec.evidence.length - 3}
                            </div>
                          )}
                        </div>
                      )}
                    </div>

                    <div className="flex items-center justify-between pt-3 border-t border-slate-200/50">
                      <div className="flex items-center gap-2">
                        <div className="w-6 h-6 rounded-lg bg-blue-100 flex items-center justify-center text-[10px] font-black text-blue-700">
                          {rec.created_by_name?.charAt(0).toUpperCase()}
                        </div>
                        <span className="text-[10px] text-slate-500 font-bold">{rec.created_by_name}</span>
                      </div>
                      <button 
                        onClick={() => setSelectedRecord(rec)}
                        className="flex items-center gap-1 text-[10px] font-black text-blue-600 hover:text-blue-700 transition-colors uppercase tracking-widest"
                      >
                        Detalles <ChevronRight className="w-3 h-3" />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </main>
      )}

      {/* Pestaña: órdenes con packing cargado (camioncito) */}
      {activeTab === 'packing' && (
        <main className="max-w-7xl mx-auto">
          <div className="bg-white rounded-[2.5rem] p-6 md:p-8 shadow-xl shadow-slate-200/50 border border-slate-100 min-h-[700px] flex flex-col">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-6">
              <h3 className="text-xl font-black text-slate-800 flex items-center gap-3">
                <Truck className="w-6 h-6 text-blue-600" />
                ENVÍOS CON PACKING
                <span className="px-3 py-1 bg-blue-50 text-blue-700 text-[10px] font-black rounded-full uppercase">
                  {shipped.length} de {shippedTotal}
                </span>
              </h3>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => loadShipped(true)}
                  disabled={shippedLoading}
                  className="flex items-center gap-2 px-4 py-2.5 bg-slate-100 text-slate-600 rounded-xl font-black text-[11px] uppercase tracking-widest hover:bg-slate-200 transition-all disabled:opacity-50"
                >
                  <Search className="w-4 h-4" /> Refrescar
                </button>
                <button
                  onClick={exportShipped}
                  disabled={exporting || shippedTotal === 0}
                  className="flex items-center gap-2 px-4 py-2.5 bg-emerald-600 text-white rounded-xl font-black text-[11px] uppercase tracking-widest hover:bg-emerald-700 transition-all disabled:opacity-50"
                >
                  {exporting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />}
                  Exportar Excel
                </button>
              </div>
            </div>

            {shipped.length === 0 && shippedLoading ? (
              <div className="flex-1 flex items-center justify-center">
                <div className="w-12 h-12 border-4 border-blue-100 border-t-blue-600 rounded-full animate-spin" />
              </div>
            ) : shipped.length === 0 ? (
              <div className="flex-1 flex flex-col items-center justify-center text-slate-300">
                <Truck className="w-24 h-24 mb-4 opacity-20" />
                <p className="font-black uppercase tracking-widest text-slate-400">Sin envíos con packing</p>
              </div>
            ) : (
              <>
                <div className="overflow-x-auto flex-1">
                  <table className="w-full text-left border-collapse">
                    <thead>
                      <tr className="text-[10px] font-black uppercase tracking-widest text-slate-400 border-b border-slate-200">
                        <th className="py-3 px-3">Orden</th>
                        <th className="py-3 px-3">Cliente</th>
                        <th className="py-3 px-3">Style</th>
                        <th className="py-3 px-3 text-right">Cant.</th>
                        <th className="py-3 px-3">Packing</th>
                        <th className="py-3 px-3">Fecha</th>
                        <th className="py-3 px-3">Tablero</th>
                      </tr>
                    </thead>
                    <tbody>
                      {shipped.map((o, i) => (
                        <tr key={`${o.order_number}-${i}`} className="border-b border-slate-100 hover:bg-slate-50 transition-colors">
                          <td className="py-3 px-3">
                            <span className="px-2 py-0.5 bg-blue-600 text-white text-[10px] font-black rounded-md">#{o.order_number}</span>
                          </td>
                          <td className="py-3 px-3 text-sm font-bold text-slate-700">{o.client || '—'}</td>
                          <td className="py-3 px-3 text-sm font-semibold text-slate-600">{o.style || '—'}</td>
                          <td className="py-3 px-3 text-sm font-bold text-slate-700 text-right">{o.quantity ?? '—'}</td>
                          <td className="py-3 px-3 text-sm text-slate-600 max-w-[220px] truncate">
                            {o.packing_link ? (
                              <a href={o.packing_link} target="_blank" rel="noopener noreferrer"
                                 className="text-blue-600 font-bold hover:underline inline-flex items-center gap-1">
                                <ExternalLink className="w-3 h-3" /> {o.packing_link_label || 'Packing'}
                              </a>
                            ) : '—'}
                          </td>
                          <td className="py-3 px-3 text-xs font-semibold text-slate-500">
                            {o.packing_link_at ? new Date(o.packing_link_at).toLocaleDateString() : '—'}
                          </td>
                          <td className="py-3 px-3">
                            <span className="text-[10px] font-black uppercase tracking-wider text-slate-500">{o.board || '—'}</span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                {shipped.length < shippedTotal && (
                  <div className="pt-6 flex justify-center">
                    <button
                      onClick={() => loadShipped(false)}
                      disabled={shippedLoading}
                      className="flex items-center gap-2 px-8 py-3 bg-blue-600 text-white rounded-2xl font-black text-xs uppercase tracking-widest hover:bg-blue-700 transition-all disabled:opacity-50"
                    >
                      {shippedLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <ChevronRight className="w-4 h-4" />}
                      Cargar 50 más ({shipped.length}/{shippedTotal})
                    </button>
                  </div>
                )}
              </>
            )}
          </div>
        </main>
      )}

      {activeTab === 'programados' && (
        <main className="w-full max-w-[1700px] mx-auto space-y-5">
          {/* Barra de control */}
          <div className="bg-white rounded-2xl px-5 py-3.5 shadow-sm border border-slate-200 flex flex-wrap items-center justify-between gap-4">
            <div className="flex items-center gap-3 flex-wrap">
              {calMonth && (
                <button onClick={() => setCalMonth(null)}
                  className="flex items-center gap-1 px-3 py-2 bg-slate-100 text-slate-600 rounded-xl font-black text-[10px] uppercase tracking-widest hover:bg-slate-200">
                  ‹ Meses
                </button>
              )}
              <div className="flex items-center gap-1">
                <button onClick={() => setCalYear((y) => y - 1)} className="w-8 h-8 rounded-lg bg-slate-100 text-slate-600 font-black hover:bg-slate-200">‹</button>
                <span className="text-xl font-black text-slate-800 tabular-nums px-1.5">{calYear}</span>
                <button onClick={() => setCalYear((y) => y + 1)} className="w-8 h-8 rounded-lg bg-slate-100 text-slate-600 font-black hover:bg-slate-200">›</button>
              </div>
              {calMonth && <span className="text-xl font-black text-blue-600">{MONTHS_FULL[calMonth - 1]}</span>}
              <span className="px-2.5 py-1 bg-blue-50 text-blue-700 text-[10px] font-black rounded-full uppercase tracking-widest">
                {scheduled.filter((r) => r.scheduled_year === calYear).length} programadas
              </span>
            </div>
            <div className="flex items-center gap-2 flex-wrap">
              <button onClick={() => setShowAvailable((v) => !v)}
                className={`flex items-center gap-1.5 px-3 py-2 rounded-xl font-black text-[10px] uppercase tracking-widest transition-all ${showAvailable ? 'bg-blue-600 text-white' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'}`}>
                <Search className="w-3.5 h-3.5" /> Buscar orden
              </button>
              <button onClick={loadScheduled} disabled={scheduledLoading}
                className="flex items-center gap-1.5 px-3 py-2 bg-slate-100 text-slate-600 rounded-xl font-black text-[10px] uppercase tracking-widest hover:bg-slate-200 disabled:opacity-50">
                <Search className="w-3.5 h-3.5" /> Refrescar
              </button>
              <button onClick={exportScheduled} disabled={schedExporting || !scheduled.length}
                className="flex items-center gap-1.5 px-3 py-2 bg-emerald-600 text-white rounded-xl font-black text-[10px] uppercase tracking-widest hover:bg-emerald-700 disabled:opacity-50">
                {schedExporting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Download className="w-3.5 h-3.5" />} Excel
              </button>
            </div>
          </div>

          {/* Cuerpo: rail de disponibles (opcional) + calendario */}
          <div className="flex gap-5 items-start">
            {showAvailable && (
              <aside className="w-80 flex-shrink-0 bg-white rounded-2xl p-4 shadow-sm border border-slate-200 flex flex-col sticky top-4" style={{ maxHeight: 'calc(100vh - 2rem)' }}>
                <h3 className="text-sm font-black text-slate-800 flex items-center gap-2 mb-3 uppercase tracking-wide">
                  <Search className="w-4 h-4 text-blue-600" /> Buscar orden
                </h3>
                <div className="flex items-center gap-2 bg-slate-50 px-3 py-2 rounded-xl border border-slate-200 mb-2">
                  <Search className="w-4 h-4 text-slate-400" />
                  <input
                    value={availableSearch}
                    onChange={(e) => setAvailableSearch(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') loadAvailable(true, availableSearch); }}
                    placeholder="# orden, cliente o PO + Enter"
                    className="bg-transparent text-sm w-full outline-none text-slate-700"
                  />
                </div>
                {calMonth ? (
                  <p className="text-[10px] font-bold text-slate-400 mb-3">Caen en <span className="text-blue-600 font-black">{MONTHS[calMonth - 1]} · Semana {selWeek} · {envioLabel(calYear, calMonth, selWeek, targetEnvio)} · {calYear}</span></p>
                ) : (
                  <p className="text-[10px] font-bold text-slate-400 mb-3">Abre un mes del calendario para elegir dónde caen.</p>
                )}
                <div className="flex-1 overflow-y-auto -mx-1 px-1 space-y-2">
                  {!availableSearch.trim() ? (
                    <div className="h-full flex items-center justify-center px-2">
                      <p className="text-center text-xs text-slate-400 font-semibold leading-relaxed">
                        Escribe un <span className="font-black text-slate-500"># de orden</span>, cliente o PO y presiona <span className="font-black text-slate-500">Enter</span> para encontrarla y programarla.
                      </p>
                    </div>
                  ) : availableLoading ? (
                    <div className="flex justify-center py-10"><Loader2 className="w-6 h-6 text-blue-400 animate-spin" /></div>
                  ) : available.length === 0 ? (
                    <p className="text-center text-slate-300 font-black uppercase text-xs tracking-widest py-10">Sin coincidencias</p>
                  ) : (
                    <>
                      {available.map((o) => (
                        <div key={o.order_number} className="flex items-center justify-between gap-2 p-2.5 rounded-xl border border-slate-100 hover:border-blue-200 hover:bg-blue-50/40 transition-colors">
                          <div className="min-w-0">
                            <span className="px-2 py-0.5 bg-blue-600 text-white text-[10px] font-black rounded-md">#{o.order_number}</span>
                            <p className="text-xs font-bold text-slate-600 truncate mt-1">{o.client || '—'}</p>
                            <p className="text-[10px] text-slate-400">Cancel: {o.cancel_date || '—'}</p>
                          </div>
                          <button
                            onClick={() => scheduleOrder(o.order_number)}
                            className="flex items-center gap-1 px-3 py-1.5 bg-blue-600 text-white rounded-lg font-black text-[10px] uppercase tracking-wider hover:bg-blue-700 transition-all flex-shrink-0"
                          >
                            <ChevronRight className="w-3.5 h-3.5" /> Programar
                          </button>
                        </div>
                      ))}
                      {available.length < availableTotal && (
                        <button
                          onClick={() => loadAvailable(false)}
                          disabled={availableLoading}
                          className="w-full py-2 text-xs font-black uppercase tracking-widest text-blue-600 hover:bg-blue-50 rounded-xl disabled:opacity-50"
                        >
                          {availableLoading ? 'Cargando...' : `Cargar más (${available.length}/${availableTotal})`}
                        </button>
                      )}
                    </>
                  )}
                </div>
              </aside>
            )}

            <section className="flex-1 min-w-0 bg-white rounded-2xl p-5 shadow-sm border border-slate-200 min-h-[600px]">
              {!calMonth ? (
                /* Grilla de 12 meses con conteo por mes del año visible */
                <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6 gap-4">
                  {MONTHS.map((mn, i) => {
                    const m = i + 1;
                    const c = scheduled.filter((r) => r.scheduled_year === calYear && r.scheduled_month === m).length;
                    return (
                      <button key={m} onClick={() => openMonth(m)}
                        className={`flex flex-col items-start p-5 rounded-2xl border transition-all ${c ? 'border-blue-200 bg-blue-50/50 hover:bg-blue-50 hover:shadow-md' : 'border-slate-100 hover:border-slate-300'}`}>
                        <span className="text-sm font-black text-slate-700 uppercase tracking-wide">{MONTHS_FULL[i]}</span>
                        <span className={`mt-3 text-3xl font-black ${c ? 'text-blue-600' : 'text-slate-200'}`}>{c}</span>
                        <span className="text-[10px] font-bold uppercase tracking-widest text-slate-400 mt-0.5">órdenes</span>
                      </button>
                    );
                  })}
                </div>
              ) : (() => {
                /* Cascada limpia: un solo nivel de cada cosa en pantalla.
                   Nivel 1 = semanas del mes · Nivel 2 = días (Lun..Dom, "Sin
                   día" al final) · Nivel 3 = envíos del día elegido. El día es
                   del ENVÍO: moverlo de día arrastra sus órdenes. */
                const weekList = scheduled.filter((r) => r.scheduled_year === calYear && r.scheduled_month === calMonth && r.scheduled_week === selWeek);
                const ordersOfDay = (d) => weekList.filter((r) => dayEnvsOf(calMonth, selWeek, d).includes(r.shipment_no || 1)).length;
                const dayEnvs = dayEnvsOf(calMonth, selWeek, selDay);
                return (
                  <div className="space-y-5">
                    {/* Nivel 1: semanas */}
                    <div className="flex items-center gap-2 flex-wrap">
                      {WEEKS.map((w) => {
                        const n = scheduled.filter((r) => r.scheduled_year === calYear && r.scheduled_month === calMonth && r.scheduled_week === w).length;
                        const active = selWeek === w;
                        return (
                          <button key={w} onClick={() => openWeek(calMonth, w)}
                            className={`px-4 py-2 rounded-xl text-xs font-black uppercase tracking-widest transition-all ${
                              active ? 'bg-blue-600 text-white shadow-sm'
                                : n ? 'bg-blue-50 text-blue-700 hover:bg-blue-100'
                                  : 'bg-slate-50 text-slate-400 hover:bg-slate-100'}`}>
                            Semana {w}{n ? ` · ${n}` : ''}
                          </button>
                        );
                      })}
                    </div>
                    {/* Nivel 2: días de la semana activa */}
                    <div className="flex items-center gap-1.5 flex-wrap border-b border-slate-200 pb-4">
                      {TAB_ORDER.map((d) => {
                        const nE = dayEnvsOf(calMonth, selWeek, d).length;
                        const nO = ordersOfDay(d);
                        const active = selDay === d;
                        return (
                          <button key={d} onClick={() => selectDay(calMonth, selWeek, d)}
                            title={`${dayLabel(d, true)}: ${nE} envío(s) · ${nO} órdenes`}
                            className={`px-3 py-1.5 rounded-lg text-[11px] font-black uppercase tracking-wider transition-all ${
                              active ? 'bg-blue-600 text-white shadow-sm'
                                : nE ? 'bg-blue-50 text-blue-700 hover:bg-blue-100'
                                  : 'bg-white text-slate-400 border border-slate-200 hover:bg-slate-100'}`}>
                            {dayLabel(d)}{nO ? ` · ${nO}` : ''}
                          </button>
                        );
                      })}
                    </div>
                    {/* Nivel 3: envíos del día elegido */}
                    <div className="flex items-center justify-between gap-3 flex-wrap">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-black uppercase tracking-widest text-slate-700">{dayLabel(selDay, true)}</span>
                        <span className="text-[11px] font-bold text-slate-400">Semana {selWeek} · {dayEnvs.length} envío(s) · {ordersOfDay(selDay)} órdenes</span>
                      </div>
                      <button onClick={() => addEnvio(calMonth, selWeek)}
                        className="flex items-center gap-1 px-2.5 py-1.5 bg-blue-600 text-white rounded-lg text-[10px] font-black uppercase tracking-widest hover:bg-blue-700">
                        + Envío
                      </button>
                    </div>
                    <div className="space-y-3">
                      {dayEnvs.length === 0 && (
                        <p className="text-[12px] text-slate-300 font-bold italic px-1 py-4">
                          Sin envíos en {dayLabel(selDay, true)} — mueve uno aquí con su selector de día, o créalo con "+ Envío".
                        </p>
                      )}
                      {dayEnvs.map((env, envIdx) => {
                        const gkey = `${calYear}-${calMonth}-${selWeek}-${env}`;
                        const glist = weekList.filter((r) => (r.shipment_no || 1) === env);
                        const collapsed = collapsedEnvios.has(gkey);
                        const isEnvTarget = targetEnvio === env;
                        // envIdx + 1 = número VISIBLE del envío dentro de su día
                        return (
                          <div key={env} className={`rounded-xl border overflow-hidden ${isEnvTarget ? 'border-blue-300' : 'border-slate-200'}`}>
                            <div className="flex items-center justify-between gap-2 px-3 py-2 bg-slate-50/70 border-b border-slate-200">
                              <button onClick={() => toggleEnvio(gkey)} className="flex items-center gap-2 flex-1 text-left">
                                <ChevronRight className={`w-4 h-4 text-slate-400 transition-transform ${collapsed ? '' : 'rotate-90'}`} />
                                <span className="text-xs font-black uppercase tracking-widest text-slate-600">Envío {envIdx + 1}</span>
                                <span className="text-[10px] font-bold text-slate-400">({glist.length} órdenes)</span>
                              </button>
                              <div className="flex items-center gap-1.5">
                                {/* Excel de SOLO este envío */}
                                <button onClick={() => exportEnvio(calMonth, selWeek, env, glist)}
                                  disabled={!glist.length}
                                  title={glist.length ? `Descargar Excel del Envío ${envIdx + 1} (${glist.length} órdenes)` : 'Sin órdenes que exportar'}
                                  className="flex items-center gap-1 px-2 py-1 bg-emerald-600 text-white rounded-lg text-[9px] font-black uppercase tracking-widest hover:bg-emerald-700 disabled:opacity-40 disabled:cursor-not-allowed">
                                  <FileSpreadsheet className="w-3 h-3" /> Excel
                                </button>
                                {/* Mover el envío COMPLETO (con sus órdenes) a otro día */}
                                <select value={selDay} onChange={(e) => moveEnvioDay(calMonth, selWeek, env, Number(e.target.value))}
                                  title="Mover envío a otro día"
                                  className="bg-white border border-slate-200 rounded-lg px-1.5 py-1 text-[10px] font-black uppercase tracking-wider text-slate-600 focus:border-blue-400 outline-none">
                                  <option value={0}>Sin día</option>
                                  {DAYS.map((dn, i) => <option key={i} value={i + 1}>{dn}</option>)}
                                </select>
                                <button onClick={() => setTargetEnvio(env)}
                                  title="Las órdenes del buscador caen en este envío"
                                  className={`text-[9px] font-black uppercase tracking-widest px-2 py-0.5 rounded-full ${isEnvTarget ? 'bg-blue-600 text-white' : 'bg-slate-200 text-slate-500 hover:bg-slate-300'}`}>
                                  {isEnvTarget ? 'destino' : 'programar aquí'}
                                </button>
                              </div>
                            </div>
                            {!collapsed && (
                              glist.length === 0
                                ? <p className="text-[12px] text-slate-300 font-bold italic px-3 py-3">Sin órdenes en este envío — márcalo "programar aquí" y usa el buscador</p>
                                : renderOrderTable(glist, selWeek)
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                );
              })()}
            </section>
          </div>
        </main>
      )}

      {/* Modal de Detalles */}
      {selectedRecord && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 animate-in fade-in duration-300">
          <div className="absolute inset-0 bg-slate-900/60 backdrop-blur-sm" onClick={() => setSelectedRecord(null)}></div>
          <div className="relative bg-white w-full max-w-2xl rounded-[2.5rem] shadow-2xl overflow-y-auto overscroll-contain max-h-[90vh] animate-in zoom-in-95 duration-300" style={{ WebkitOverflowScrolling: 'touch' }}>
            <div className="p-8 space-y-6">
              <div className="flex justify-between items-start">
                <div>
                  <h2 className="text-2xl font-black text-slate-800 flex items-center gap-3">
                    <Package className="w-6 h-6 text-blue-600" />
                    DETALLES DEL ENVÍO
                  </h2>
                  <p className="text-slate-400 font-bold text-xs uppercase tracking-widest mt-1">
                    {new Date(selectedRecord.created_at).toLocaleString()}
                  </p>
                </div>
                <button 
                  onClick={() => setSelectedRecord(null)}
                  className="w-10 h-10 rounded-full bg-slate-100 flex items-center justify-center text-slate-500 hover:bg-red-50 hover:text-red-500 transition-all"
                >
                  <Trash2 className="w-5 h-5 rotate-45" /> {/* Usando Trash rotado como X rápida */}
                </button>
              </div>

              <div className="space-y-4">
                <div className="bg-slate-50 p-4 rounded-2xl">
                  <span className="text-[10px] font-black text-blue-600 uppercase tracking-widest block mb-2">Órdenes Asociadas</span>
                  <div className="flex flex-wrap gap-2">
                    {selectedRecord.order_numbers.map(ono => (
                      <span key={ono} className="px-4 py-1.5 bg-blue-600 text-white text-xs font-black rounded-xl shadow-md">
                        #{ono}
                      </span>
                    ))}
                  </div>
                </div>

                <div className="bg-slate-50 p-4 rounded-2xl">
                  <span className="text-[10px] font-black text-blue-600 uppercase tracking-widest block mb-2">Notas</span>
                  <p className="text-slate-800 font-bold leading-relaxed">
                    {selectedRecord.notes || "No se ingresaron notas para este envío."}
                  </p>
                </div>

                {selectedRecord.evidence?.length > 0 && (
                  <div className="space-y-2">
                    <span className="text-[10px] font-black text-blue-600 uppercase tracking-widest block px-1">Evidencia Multimedia</span>
                    <div className="grid grid-cols-2 gap-4">
                      {selectedRecord.evidence.map((ev) => (
                        <a 
                          key={ev.id}
                          href={getFullUrl(ev.url)}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="relative aspect-video rounded-2xl overflow-hidden bg-slate-100 border-2 border-slate-100 hover:border-blue-600 transition-all group/modal-ev"
                        >
                          {["jpg", "jpeg", "png"].includes(ev.type) ? (
                            <img 
                              src={getFullUrl(ev.url)} 
                              alt="" 
                              className="w-full h-full object-cover" 
                              onError={(e) => { e.target.style.display = 'none'; }}
                            />
                          ) : (
                            <div className="w-full h-full flex flex-col items-center justify-center gap-2">
                              {getFileIcon(ev.type)}
                              <span className="text-xs font-black text-slate-500 uppercase">{ev.type}</span>
                            </div>
                          )}
                          <div className="absolute inset-0 bg-blue-600/20 opacity-0 group-hover/modal-ev:opacity-100 transition-opacity flex items-center justify-center">
                            <ExternalLink className="w-8 h-8 text-white" />
                          </div>
                        </a>
                      ))}
                    </div>
                  </div>
                )}
              </div>

              <div className="pt-6 border-t border-slate-100 flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-2xl bg-blue-100 flex items-center justify-center text-sm font-black text-blue-700">
                    {selectedRecord.created_by_name?.charAt(0).toUpperCase()}
                  </div>
                  <div className="flex flex-col">
                     <span className="text-[10px] text-slate-400 font-black uppercase leading-none">Registrado por</span>
                     <span className="text-sm text-slate-800 font-black">{selectedRecord.created_by_name}</span>
                  </div>
                </div>
                <button 
                  onClick={() => setSelectedRecord(null)}
                  className="px-8 py-3 bg-slate-900 text-white rounded-xl font-black text-xs uppercase tracking-widest hover:bg-slate-800 transition-all"
                >
                  Cerrar
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default ShippingModule;
