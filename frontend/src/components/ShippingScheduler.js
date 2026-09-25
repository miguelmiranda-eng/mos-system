import React, { useState, useEffect, useCallback, useMemo } from "react";
import {
  ChevronLeft, ChevronRight, Plus, Trash2, Copy, Download, RefreshCw, Loader2,
  ExternalLink, FileSpreadsheet, Wand2, Search,
} from "lucide-react";
import * as XLSX from "xlsx";
import { toast } from "sonner";
import { useLang } from "../contexts/LanguageContext";

// Programador de envíos con la estructura de la hoja "shipping miranda"
// (una pestaña por semana): semana Lunes→Viernes con FECHAS REALES; cada día
// tiene bloques de EXPORT (un camión que cruza) con su encabezado — EXPORT#,
// PL, transporte, semáforo, hora de corte y de salida — y debajo las órdenes
// que viajan en él, editables en línea como celdas de hoja de cálculo.
// Backend: routers/scheduled_shipments.py (/week, /exports, /lines).

const API = `${process.env.REACT_APP_BACKEND_URL}/api/scheduled-shipments`;

const DAYS = {
  es: ['LUNES', 'MARTES', 'MIÉRCOLES', 'JUEVES', 'VIERNES', 'SÁBADO', 'DOMINGO'],
  en: ['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY', 'SUNDAY'],
};
const DAYS_SHORT = {
  es: ['Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb', 'Dom'],
  en: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'],
};
const MONTHS = {
  es: ['ENE', 'FEB', 'MAR', 'ABR', 'MAY', 'JUN', 'JUL', 'AGO', 'SEP', 'OCT', 'NOV', 'DIC'],
  en: ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'],
};
const PRIORITY_LABEL = { 1: '1RA', 2: '2DA', 3: '3RA', 4: '4TA' };

// Color por status (fila y pill), como el verde de "READY TO SHIP" en la hoja.
// Van como CSS con selector por id (SCOPED_CSS): el tema global del sistema
// fuerza fondo/color de inputs, selects y zebra de tablas con !important, y
// las clases de Tailwind perdían contra eso.
const STATUS_COLORS = {
  'READY TO SHIP': { row: '#bbf7d0', pill: '#047857' },
  'PACKAGED READY': { row: '#ccfbf1', pill: '#0d9488' },
  'PRINTED': { row: '#e0f2fe', pill: '#0284c7' },
  'IN SETUP': { row: '#fef3c7', pill: '#d97706' },
  'SE MUEVE FECHA': { row: '#ffedd5', pill: '#ea580c' },
  'CANCELLED': { row: '#fee2e2', pill: '#dc2626' },
};
const ROOT_ID = 'shipping-scheduler';
const SCOPED_CSS = `
#${ROOT_ID} .sch-sheet { background:#fff !important; color:#1e293b !important; }
#${ROOT_ID} .sch-sheet thead tr, #${ROOT_ID} .sch-sheet thead th { background:#d9ead3 !important; color:#1e293b !important; }
#${ROOT_ID} .sch-sheet tbody tr[data-st] { background-color:#fff !important; }
${Object.entries(STATUS_COLORS).map(([k, c]) => `#${ROOT_ID} .sch-sheet tbody tr[data-st="${k}"] { background-color:${c.row} !important; }
#${ROOT_ID} select.sch-pill[data-st="${k}"] { background-color:${c.pill} !important; color:#fff !important; }`).join(' ')}
#${ROOT_ID} .sch-sheet tbody tr[data-st="CANCELLED"] td { color:#94a3b8 !important; text-decoration:line-through; }
#${ROOT_ID} select.sch-pill { background-color:#e2e8f0 !important; color:#475569 !important; border-radius:9999px; }
#${ROOT_ID} input.sch-cell, #${ROOT_ID} select.sch-cell { background-color:transparent !important; color:inherit !important; }
#${ROOT_ID} input.sch-cell:hover:not(:disabled) { background-color:rgba(255,255,255,.75) !important; }
#${ROOT_ID} input.sch-cell:focus { background-color:#fff !important; color:#0f172a !important; }
#${ROOT_ID} input.sch-field, #${ROOT_ID} select.sch-field { background-color:#fff !important; color:#0f172a !important; border:1px solid #cbd5e1; }
#${ROOT_ID} select.sch-light[data-light="VERDE"] { background-color:#059669 !important; color:#fff !important; }
#${ROOT_ID} select.sch-light[data-light="ROJO"] { background-color:#dc2626 !important; color:#fff !important; }
#${ROOT_ID} .sch-sheet input::placeholder { color:#cbd5e1 !important; }
#${ROOT_ID} .sch-sheet thead th.sch-crm { background:#e2e8f0 !important; color:#475569 !important; }
#${ROOT_ID} .sch-sheet td.sch-neg { color:#dc2626 !important; }
`;

// Código de cliente para el PL sugerido (PLGTS 09-26-0076 & PLSKT 09-26-0076).
const PL_CODES = { 'GTS': 'GTS', 'GOODIE TWO SLEEVES': 'GTS', 'SPEKTRUM': 'SKT' };

// ── Fechas locales (sin salto UTC) ──────────────────────────────────────────
const pad = (n, w = 2) => String(n).padStart(w, '0');
const isoOf = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parseIso = (s) => { const [y, m, d] = String(s).slice(0, 10).split('-').map(Number); return new Date(y, m - 1, d); };
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
const mondayOf = (d) => { const x = new Date(d.getFullYear(), d.getMonth(), d.getDate()); return addDays(x, -((x.getDay() + 6) % 7)); };
const to12h = (hhmm) => {
  if (!hhmm) return '';
  const [h, m] = hhmm.split(':').map(Number);
  return `${pad(((h + 11) % 12) + 1)}:${pad(m)} ${h < 12 ? 'AM' : 'PM'}`;
};
const fmtNum = (n) => (n === null || n === undefined || n === '' ? '' : Number(n).toLocaleString('en-US'));

// Celda editable estilo hoja: guarda al salir (blur) o con Enter si cambió.
const Cell = ({ value, onSave, type = 'text', list, placeholder, className = '', numeric = false, disabled = false, title, boxed = false }) => {
  const [v, setV] = useState(value ?? '');
  const [focused, setFocused] = useState(false);
  useEffect(() => { if (!focused) setV(value ?? ''); }, [value, focused]);
  const commit = () => {
    setFocused(false);
    const nv = typeof v === 'string' ? v.trim() : v;
    const norm = numeric && nv !== '' ? String(nv).replace(/,/g, '') : nv;
    if (String(norm ?? '') !== String(value ?? '')) onSave(norm === '' ? null : norm);
  };
  const shown = numeric && !focused ? fmtNum(v) : v;
  return (
    <input
      type={type}
      value={shown}
      list={list}
      title={title}
      disabled={disabled}
      placeholder={placeholder}
      inputMode={numeric ? 'numeric' : undefined}
      onFocus={() => setFocused(true)}
      onChange={(e) => setV(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur();
        if (e.key === 'Escape') setV(value ?? '');
      }}
      className={`${boxed ? 'sch-field' : 'sch-cell'} w-full min-w-0 px-1.5 py-1 rounded outline-none focus:ring-2 focus:ring-blue-400 ${numeric ? 'text-right tabular-nums' : ''} ${className}`}
    />
  );
};

const COLS = ['CUSTOMER', 'SHIPPING#', 'DELIVER TO', 'BRANDING', 'ORDER', 'CUSTOMER PO.', 'DESIGN #', 'PCS', 'STATUS', 'PRIORITY', 'NOTES', 'SHIPPING FROM', 'CARRIER'];
const COL_W = [110, 90, 120, 130, 110, 150, 150, 80, 150, 80, 190, 120, 120, 96];
// Columnas del programador anterior que vienen VIVAS de la orden (solo
// lectura): cancel date / Days Com., status de producción, pedido vs.
// embarcado (bitácora del WMS), PL de la orden y notas de la orden. Se pueden
// ocultar para ver únicamente lo que traía la hoja.
const CRM_COLS = ['CANCEL DATE', 'DAYS COM.', 'PROD. STATUS', 'QTY PED. / EMB.', 'PL', 'ORDER NOTES'];
const CRM_W = [100, 80, 130, 110, 140, 200];
const CRM_KEY = 'sch_show_crm';

const ShippingScheduler = () => {
  const { t, lang } = useLang();
  const L = lang === 'en' ? 'en' : 'es';
  const [weekStart, setWeekStart] = useState(() => mondayOf(new Date()));
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [showWeekend, setShowWeekend] = useState(false);
  const [addText, setAddText] = useState({});      // export_id → texto de captura
  const [showCrm, setShowCrm] = useState(() => {
    try { return localStorage.getItem(CRM_KEY) !== '0'; } catch { return true; }
  });
  const toggleCrm = (v) => { setShowCrm(v); try { localStorage.setItem(CRM_KEY, v ? '1' : '0'); } catch { /* sin storage */ } };
  // Panel "Buscar orden" (heredado del programador anterior): órdenes vivas
  // aún no programadas, con o sin packing, ordenadas por cancel date.
  const [showSearch, setShowSearch] = useState(false);
  const [avail, setAvail] = useState([]);
  const [availTotal, setAvailTotal] = useState(0);
  const [availSearch, setAvailSearch] = useState('');
  const [availLoading, setAvailLoading] = useState(false);
  const [targetExport, setTargetExport] = useState(null);

  const dayLabel = useCallback((iso) => {
    const d = parseIso(iso);
    return `${DAYS[L][(d.getDay() + 6) % 7]} · ${pad(d.getDate())} ${MONTHS[L][d.getMonth()]}`;
  }, [L]);
  const weekLabel = (ws) => {
    const we = addDays(ws, 4);
    return `${pad(ws.getDate())} ${MONTHS[L][ws.getMonth()]} - ${pad(we.getDate())} ${MONTHS[L][we.getMonth()]}`;
  };

  const loadWeek = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const res = await fetch(`${API}/week?start=${isoOf(weekStart)}`, { credentials: 'include' });
      if (res.ok) setData(await res.json());
      else if (!silent) toast.error(t('sch_load_err'));
    } catch { if (!silent) toast.error(t('ceo_err_connection')); }
    finally { if (!silent) setLoading(false); }
  }, [weekStart, t]);

  useEffect(() => { loadWeek(); }, [loadWeek]);
  // Estilos acotados al programador: se inyectan una vez en <head> (un
  // <style> dentro del árbol no llegaba a aplicarse en todos los navegadores).
  useEffect(() => {
    if (document.getElementById(`${ROOT_ID}-css`)) return;
    const el = document.createElement('style');
    el.id = `${ROOT_ID}-css`;
    el.textContent = SCOPED_CSS;
    document.head.appendChild(el);
  }, []);
  // Varias personas programan a la vez (como en la hoja): al volver a la
  // pestaña se refresca en silencio.
  useEffect(() => {
    const onFocus = () => loadWeek(true);
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [loadWeek]);

  const call = async (url, method, body) => {
    const res = await fetch(url, {
      method, credentials: 'include',
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    const d = await res.json().catch(() => ({}));
    if (!res.ok) { const e = new Error(d.detail || t('sch_err')); e.status = res.status; throw e; }
    return d;
  };

  const exportsList = useMemo(() => data?.exports || [], [data]);
  const lines = useMemo(() => data?.lines || [], [data]);
  const linesByExport = useMemo(() => {
    const m = {};
    lines.forEach((l) => { (m[l.export_id] = m[l.export_id] || []).push(l); });
    Object.values(m).forEach((arr) => arr.sort((a, b) => (a.position ?? 0) - (b.position ?? 0)));
    return m;
  }, [lines]);
  const sumPcs = (arr) => arr.reduce((s, l) => s + (l.status === 'CANCELLED' ? 0 : Number(l.pcs) || 0), 0);

  // ── Exports ────────────────────────────────────────────────────────────────
  const setExport = (exp) => setData((p) => ({ ...p, exports: p.exports.map((e) => (e.export_id === exp.export_id ? exp : e)) }));
  const addExport = async (iso) => {
    try {
      const exp = await call(`${API}/exports`, 'POST', { date: iso });
      setData((p) => ({ ...p, exports: [...p.exports, exp] }));
    } catch (e) { toast.error(e.message); }
  };
  const updateExport = async (exp, patch) => {
    try {
      const upd = await call(`${API}/exports/${exp.export_id}`, 'PUT', patch);
      if (patch.date) { loadWeek(true); toast.success(t('sch_export_moved', { day: dayLabel(patch.date) })); }
      else setExport(upd);
    } catch (e) { toast.error(e.message); }
  };
  const assignNumber = async (exp) => {
    try { setExport(await call(`${API}/exports/${exp.export_id}/assign-number`, 'POST')); loadWeek(true); }
    catch (e) { toast.error(e.message); }
  };
  const deleteExport = async (exp) => {
    const n = (linesByExport[exp.export_id] || []).length;
    const extra = n ? t('sch_confirm_delete_export_lines', { n }) : '';
    if (!window.confirm(t('sch_confirm_delete_export', { extra }))) return;
    try {
      await call(`${API}/exports/${exp.export_id}${n ? '?cascade=true' : ''}`, 'DELETE');
      setData((p) => ({
        ...p,
        exports: p.exports.filter((e) => e.export_id !== exp.export_id),
        lines: p.lines.filter((l) => l.export_id !== exp.export_id),
      }));
    } catch (e) { toast.error(e.message); }
  };
  const suggestPl = (exp) => {
    if (!exp.export_no) { toast.error(t('sch_pl_needs_no')); return; }
    const d = parseIso(exp.date);
    const codes = [];
    (linesByExport[exp.export_id] || []).forEach((l) => {
      const c = String(l.client || '').trim().toUpperCase();
      if (!c) return;
      const code = PL_CODES[c] || c.replace(/[^A-Z0-9]/g, '').slice(0, 3);
      if (code && !codes.includes(code)) codes.push(code);
    });
    if (!codes.length) { toast.error(t('sch_pl_needs_lines')); return; }
    const tail = `${pad(d.getMonth() + 1)}-${String(d.getFullYear()).slice(2)}-${pad(exp.export_no, 4)}`;
    updateExport(exp, { pl_numbers: codes.map((c) => `PL${c} ${tail}`).join(' & ') });
  };

  // ── Líneas ─────────────────────────────────────────────────────────────────
  const setLine = (row) => setData((p) => ({ ...p, lines: p.lines.map((l) => (l.shipment_id === row.shipment_id ? row : l)) }));
  const updateLine = async (line, patch) => {
    try {
      const row = await call(`${API}/${line.shipment_id}`, 'PUT', patch);
      if (patch.export_id || patch.move_to_date) {
        loadWeek(true);
        toast.success(t('sch_line_moved', { order: line.order_number, day: dayLabel(row.ship_date) }));
      } else setLine(row);
    } catch (e) { toast.error(e.message); }
  };
  const addLines = async (exp, raw, manual = false) => {
    const text = (raw ?? addText[exp.export_id] ?? '').trim();
    if (!text) return;
    try {
      const r = await call(`${API}/lines`, 'POST', { export_id: exp.export_id, order_numbers: text, manual });
      if (r.added.length) {
        setData((p) => ({ ...p, lines: [...p.lines, ...r.added] }));
        const addedNums = new Set(r.added.map((x) => x.order_number));
        setAvail((prev) => prev.filter((o) => !addedNums.has(o.order_number)));
        toast.success(t('sch_added', { n: r.added.length }));
      }
      if (r.duplicates.length) toast.info(t('sch_dups', { list: r.duplicates.join(', ') }));
      const also = Object.keys(r.also_in || {});
      if (also.length) toast.warning(t('sch_also_in', { list: also.map((o) => `#${o}`).join(', ') }));
      if (raw === undefined) setAddText((p) => ({ ...p, [exp.export_id]: '' }));
      if (r.not_found.length && window.confirm(t('sch_not_found_manual', { list: r.not_found.join(', ') }))) {
        addLines(exp, r.not_found.join(' '), true);
      }
    } catch (e) { toast.error(e.message); }
  };
  const duplicateLine = async (line) => {
    try { await call(`${API}/lines/${line.shipment_id}/duplicate`, 'POST'); loadWeek(true); }
    catch (e) { toast.error(e.message); }
  };
  const deleteLine = async (line) => {
    if (!window.confirm(t('sch_confirm_delete_line', { order: line.order_number }))) return;
    try {
      await call(`${API}/${line.shipment_id}`, 'DELETE');
      setData((p) => ({ ...p, lines: p.lines.filter((l) => l.shipment_id !== line.shipment_id) }));
    } catch (e) { toast.error(e.message); }
  };
  const moveLine = (line, value) => {
    if (!value) return;
    if (value === '__date') {
      const def = isoOf(addDays(parseIso(line.ship_date), 1));
      const d = window.prompt(t('sch_prompt_date'), def);
      if (d && /^\d{4}-\d{2}-\d{2}$/.test(d.trim())) updateLine(line, { move_to_date: d.trim() });
      else if (d) toast.error(t('sch_bad_date'));
      return;
    }
    updateLine(line, { export_id: value });
  };

  // Valores de las columnas del CRM (pantalla y Excel usan lo mismo).
  const crmValues = (l) => [
    l.ship_by ? `${l.cancel_date || '—'} (ship by ${l.ship_by})` : (l.cancel_date || ''),
    l.days_com ?? '',
    l.production_status || '',
    `${l.qty_ordered ?? l.quantity ?? '—'} / ${l.qty_shipped ?? 0}`,
    l.pl_number || '',
    l.notes || '',
  ];

  // ── Panel "Buscar orden" ───────────────────────────────────────────────────
  const loadAvailable = async (reset) => {
    const q = availSearch.trim();
    if (!q) { setAvail([]); setAvailTotal(0); return; }
    setAvailLoading(true);
    try {
      const skip = reset ? 0 : avail.length;
      const res = await fetch(`${process.env.REACT_APP_BACKEND_URL}/api/orders/available-to-ship?skip=${skip}&limit=50&search=${encodeURIComponent(q)}`, { credentials: 'include' });
      if (res.ok) {
        const d = await res.json();
        setAvailTotal(d.total || 0);
        setAvail((prev) => (reset ? (d.items || []) : [...prev, ...(d.items || [])]));
      } else toast.error(t('ship_load_available_err'));
    } catch { toast.error(t('ceo_err_connection')); }
    finally { setAvailLoading(false); }
  };

  // ── Excel con el mismo formato de bloques que la hoja ───────────────────────
  const blockAoa = (exp) => {
    const ls = linesByExport[exp.export_id] || [];
    const head = [];
    if (exp.export_no || exp.pl_numbers || exp.truck || exp.customs_light) {
      head.push([exp.export_no ? `EXPORT#${exp.export_no}` : 'EXPORT#', exp.pl_numbers || '', '', '', '', '', exp.truck || '', exp.customs_light || '']);
    }
    head.push([dayLabel(exp.date).replace(' · ', ' - '), `CORTE: ${to12h(exp.cutoff_time)}`, '', '', `EXPORT HR: ${to12h(exp.export_time)}`]);
    head.push(showCrm ? [...COLS, ...CRM_COLS] : COLS);
    const body = ls.map((l) => [
      l.client || '', l.shipping_no || '', l.delivery_to || '', l.branding || '',
      `${l.order_number}${l.late ? ' (LATE)' : ''}`, l.customer_po || '', l.design_num || '',
      l.pcs ?? '', l.status || '', l.priority ? `${PRIORITY_LABEL[l.priority]} PRIORIDAD` : '',
      l.ship_notes || '', l.ship_from || '', l.carrier || '',
      ...(showCrm ? crmValues(l) : []),
    ]);
    return [...head, ...body, ['', '', '', '', '', '', '', sumPcs(ls)], []];
  };
  const writeXlsx = (aoa, sheet, file) => {
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    ws['!cols'] = [...COL_W.slice(0, COLS.length), ...(showCrm ? CRM_W : [])].map((w) => ({ wch: Math.round(w / 7) }));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, sheet.slice(0, 31));
    XLSX.writeFile(wb, file);
  };
  const exportWeek = () => {
    if (!exportsList.length) { toast.error(t('sch_nothing_export')); return; }
    const aoa = exportsList.flatMap(blockAoa);
    const label = weekLabel(weekStart);
    writeXlsx(aoa, label, `envios_${isoOf(weekStart)}_${label.replace(/\s+/g, '')}.xlsx`);
  };
  const exportOne = (exp) => {
    writeXlsx(blockAoa(exp), `EXPORT ${exp.export_no || ''}`.trim(),
      `export_${exp.export_no || 'sin_no'}_${exp.date}.xlsx`);
  };

  // ── Derivados de la semana ─────────────────────────────────────────────────
  const todayIso = isoOf(new Date());
  const weekDays = Array.from({ length: 7 }, (_, i) => isoOf(addDays(weekStart, i)));
  const visibleDays = weekDays.filter((d, i) => i < 5 || showWeekend || exportsList.some((e) => e.date === d));
  const statusCounts = useMemo(() => {
    const c = {};
    lines.forEach((l) => { const k = l.status || '—'; c[k] = (c[k] || 0) + 1; });
    return c;
  }, [lines]);
  const statuses = data?.statuses || Object.keys(STATUS_COLORS);
  const suggest = data?.suggest || {};
  const weekStrip = [-2, -1, 0, 1, 2, 3].map((k) => addDays(mondayOf(new Date()), k * 7));

  const exportLabel = (e) => {
    const d = parseIso(e.date);
    const idx = exportsList.filter((x) => x.date === e.date).indexOf(e) + 1;
    return `${DAYS_SHORT[L][(d.getDay() + 6) % 7]} ${pad(d.getDate())} · ${e.export_no ? `EXP#${e.export_no}` : `${t('sch_block')} ${idx}`}`;
  };
  const moveOptions = (line) => exportsList
    .filter((e) => e.export_id !== line.export_id)
    .map((e) => ({ id: e.export_id, label: exportLabel(e) }));
  // Destino del panel "Buscar orden": el elegido, o el primer export desde hoy.
  const target = exportsList.find((e) => e.export_id === targetExport)
    || exportsList.find((e) => e.date >= todayIso) || exportsList[exportsList.length - 1] || null;
  const widths = [...COL_W.slice(0, COLS.length), ...(showCrm ? CRM_W : []), COL_W[COLS.length]];

  // ── Render ─────────────────────────────────────────────────────────────────
  const renderExport = (exp, idxInDay) => {
    const ls = linesByExport[exp.export_id] || [];
    const light = exp.customs_light;
    return (
      <div key={exp.export_id} className="sch-sheet rounded-xl border border-slate-300 overflow-hidden shadow-sm">
        {/* Encabezado del export: renglón EXPORT# / PL / transporte / semáforo */}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2 bg-slate-100 border-b border-slate-300">
          <div className="flex items-center gap-1">
            <span className="text-[11px] font-black text-slate-500 uppercase">EXPORT#</span>
            <div className="w-20"><Cell boxed value={exp.export_no} numeric placeholder={`${data?.next_export_no ?? ''}`}
              className="font-black text-slate-800 !text-left"
              onSave={(v) => updateExport(exp, { export_no: v })} /></div>
            {!exp.export_no && (
              <button onClick={() => assignNumber(exp)} title={t('sch_assign_hint')}
                className="px-2 py-1 rounded-md bg-blue-600 text-white text-[10px] font-black uppercase tracking-wider hover:bg-blue-700">
                {t('sch_assign_no', { n: data?.next_export_no ?? '' })}
              </button>
            )}
          </div>
          <div className="flex items-center gap-1 flex-1 min-w-[240px]">
            <span className="text-[11px] font-black text-slate-500 uppercase">PL</span>
            <Cell boxed value={exp.pl_numbers} placeholder={t('sch_pl_ph')} className="font-bold text-slate-700"
              onSave={(v) => updateExport(exp, { pl_numbers: v })} />
            <button onClick={() => suggestPl(exp)} title={t('sch_pl_auto')}
              className="p-1.5 rounded-md text-slate-400 hover:bg-white hover:text-blue-600"><Wand2 className="w-3.5 h-3.5" /></button>
          </div>
          <div className="w-52"><Cell boxed value={exp.truck} placeholder={t('sch_truck_ph')} className="font-bold text-slate-700"
            onSave={(v) => updateExport(exp, { truck: v })} /></div>
          <select value={light || ''} onChange={(e) => updateExport(exp, { customs_light: e.target.value || null })}
            title={t('sch_light')} data-light={light || ''}
            className="sch-field sch-light rounded-md px-2 py-1 text-[11px] font-black uppercase outline-none">
            <option value="">{t('sch_light')}</option>
            {(data?.customs_lights || ['VERDE', 'ROJO']).map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
          <div className="flex items-center gap-1 ml-auto">
            <button onClick={() => exportOne(exp)} disabled={!ls.length} title={t('sch_excel_export')}
              className="p-1.5 rounded-md text-emerald-700 hover:bg-emerald-50 disabled:opacity-30"><FileSpreadsheet className="w-4 h-4" /></button>
            <button onClick={() => deleteExport(exp)} title={t('sch_delete_export')}
              className="p-1.5 rounded-md text-slate-400 hover:bg-red-50 hover:text-red-600"><Trash2 className="w-4 h-4" /></button>
          </div>
        </div>
        {/* Renglón día / CORTE / EXPORT HR (verde claro como la hoja) */}
        <div className="flex flex-wrap items-center gap-x-5 gap-y-2 px-3 py-1.5 bg-emerald-50 border-b border-slate-300 text-[12px]">
          <span className="font-black text-slate-800">{dayLabel(exp.date)}{idxInDay > 0 ? ` · ${t('sch_block')} ${idxInDay + 1}` : ''}</span>
          <label className="flex items-center gap-1 font-black text-slate-600">{t('sch_cutoff')}:
            <span className="w-28"><Cell boxed type="time" value={exp.cutoff_time} className="font-bold !py-0.5"
              onSave={(v) => updateExport(exp, { cutoff_time: v })} /></span>
          </label>
          <label className="flex items-center gap-1 font-black text-slate-600">{t('sch_export_hr')}:
            <span className="w-28"><Cell boxed type="time" value={exp.export_time} className="font-bold !py-0.5"
              onSave={(v) => updateExport(exp, { export_time: v })} /></span>
          </label>
          <label className="flex items-center gap-1 font-black text-slate-600" title={t('sch_move_export_hint')}>{t('sch_date')}:
            {/* Guarda al salir del campo: con onChange, teclear el año movía el export a 0002. */}
            <span className="w-36"><Cell boxed type="date" value={exp.date} className="font-bold !py-0.5"
              onSave={(v) => v && /^\d{4}-\d{2}-\d{2}$/.test(v) && Number(v.slice(0, 4)) > 2000 && updateExport(exp, { date: v })} /></span>
          </label>
          <div className="flex-1 min-w-[160px]"><Cell boxed value={exp.notes} placeholder={t('sch_notes_ph')} className="text-slate-600"
            onSave={(v) => updateExport(exp, { notes: v })} /></div>
        </div>
        {/* Tabla de órdenes */}
        <div className="overflow-x-auto">
          <table className="border-collapse text-[12px]" style={{ minWidth: widths.reduce((a, b) => a + b, 0), width: '100%' }}>
            <colgroup>{widths.map((w, i) => <col key={i} style={{ width: w }} />)}</colgroup>
            <thead>
              <tr className="bg-emerald-50/60 text-[10px] font-black uppercase tracking-wider text-slate-700 border-b border-slate-300">
                {COLS.map((c, i) => (
                  <th key={c} className={`px-2 py-1.5 border-r border-slate-200 ${i === 7 ? 'text-right' : 'text-center'}`}>{c === 'PRIORITY' ? t('sch_priority') : c}</th>
                ))}
                {showCrm && CRM_COLS.map((c) => (
                  <th key={c} title={t('sch_crm_hint')} className="sch-crm px-2 py-1.5 border-r border-slate-200 text-center">{c}</th>
                ))}
                <th className="px-2 py-1.5" />
              </tr>
            </thead>
            <tbody>
              {ls.map((l) => {
                const man = l.manual;
                const saveManual = (k) => (v) => updateLine(l, { manual_fields: { [k]: v } });
                const ro = (v) => <span className="block px-1.5 py-1 truncate" title={v || ''}>{v || <span className="text-slate-300">—</span>}</span>;
                return (
                  <tr key={l.shipment_id} data-st={l.status || 'none'} className="border-b border-slate-200">
                    <td className="border-r border-slate-200 font-bold text-center">{man ? <Cell value={l.client} onSave={saveManual('client')} className="text-center" /> : ro(l.client)}</td>
                    <td className="border-r border-slate-200"><Cell value={l.shipping_no} className="text-center font-bold" onSave={(v) => updateLine(l, { shipping_no: v })} /></td>
                    <td className="border-r border-slate-200"><Cell value={l.delivery_to} list="sch-deliver" className="text-center" onSave={(v) => updateLine(l, { delivery_to: v })} /></td>
                    <td className="border-r border-slate-200 text-center">{man ? <Cell value={l.branding} onSave={saveManual('branding')} className="text-center" /> : ro(l.branding)}</td>
                    <td className="border-r border-slate-200 text-center">
                      <span className="inline-flex items-center gap-1 px-1 font-black text-slate-800 whitespace-nowrap">
                        {l.order_number}
                        {l.late && <span className="px-1 rounded bg-red-600 text-white text-[9px] no-underline" title={t('sch_late_hint', { d: l.ship_by || l.cancel_date || '' })}>LATE</span>}
                        {man && <span className="px-1 rounded bg-slate-500 text-white text-[9px]" title={t('sch_manual_hint')}>{t('sch_manual')}</span>}
                        {l.pl_url && <a href={l.pl_url} target="_blank" rel="noopener noreferrer" title={l.pl_number || t('sch_open_pl')} className="text-blue-600 hover:text-blue-800"><ExternalLink className="w-3 h-3" /></a>}
                      </span>
                    </td>
                    <td className="border-r border-slate-200 text-center">{man ? <Cell value={l.customer_po} onSave={saveManual('customer_po')} className="text-center" /> : ro(l.customer_po)}</td>
                    <td className="border-r border-slate-200 text-center">{man ? <Cell value={l.design_num} onSave={saveManual('design_num')} className="text-center" /> : ro(l.design_num)}</td>
                    <td className="border-r border-slate-200"><Cell value={l.pcs} numeric className="font-bold"
                      title={l.quantity != null ? t('sch_ordered_qty', { n: fmtNum(l.qty_ordered ?? l.quantity) }) : undefined}
                      onSave={(v) => updateLine(l, { pcs: v })} /></td>
                    <td className="border-r border-slate-200 px-1">
                      <select value={l.status || ''} onChange={(e) => updateLine(l, { status: e.target.value || null })}
                        data-st={l.status || ''} className="sch-pill w-full px-2 py-0.5 text-[10px] font-black uppercase outline-none">
                        <option value="">—</option>
                        {statuses.map((s) => <option key={s} value={s}>{s}</option>)}
                      </select>
                    </td>
                    <td className="border-r border-slate-200 px-1">
                      <select value={l.priority || ''} onChange={(e) => updateLine(l, { priority: e.target.value ? Number(e.target.value) : null })}
                        className="sch-cell w-full rounded px-1 py-0.5 text-[11px] font-bold outline-none focus:ring-2 focus:ring-blue-400">
                        <option value="">—</option>
                        {[1, 2, 3, 4].map((p) => <option key={p} value={p}>{PRIORITY_LABEL[p]}</option>)}
                      </select>
                    </td>
                    <td className="border-r border-slate-200"><Cell value={l.ship_notes} onSave={(v) => updateLine(l, { ship_notes: v })} /></td>
                    <td className="border-r border-slate-200"><Cell value={l.ship_from} list="sch-from" className="text-center" onSave={(v) => updateLine(l, { ship_from: v })} /></td>
                    <td className="border-r border-slate-200"><Cell value={l.carrier} list="sch-carrier" className="text-center" onSave={(v) => updateLine(l, { carrier: v })} /></td>
                    {showCrm && (() => {
                      const [cancel, days, prod, qty, pl, notes] = crmValues(l);
                      return (<>
                        <td className="border-r border-slate-200 text-center">{ro(cancel)}</td>
                        <td className={`border-r border-slate-200 text-right font-black tabular-nums px-1.5 ${typeof l.days_com === 'number' && l.days_com < 0 ? 'sch-neg' : ''}`}>{days === '' ? '—' : days}</td>
                        <td className="border-r border-slate-200 text-center">{ro(prod)}</td>
                        <td className="border-r border-slate-200 text-center tabular-nums" title={t('sch_qty_hint')}>{qty}</td>
                        <td className="border-r border-slate-200 text-center">
                          {l.pl_url ? <a href={l.pl_url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 px-1.5 text-blue-600 font-bold hover:underline truncate max-w-full"><ExternalLink className="w-3 h-3 flex-shrink-0" />{pl || 'PL'}</a> : ro(pl)}
                        </td>
                        <td className="border-r border-slate-200">{ro(notes)}</td>
                      </>);
                    })()}
                    <td className="px-1">
                      <div className="flex items-center gap-0.5 no-underline">
                        <select value="" onChange={(e) => moveLine(l, e.target.value)} title={t('sch_move')}
                          className="sch-cell w-7 text-[11px] font-black outline-none cursor-pointer">
                          <option value="">⇄</option>
                          {moveOptions(l).map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
                          <option value="__date">{t('sch_other_date')}</option>
                        </select>
                        <button onClick={() => duplicateLine(l)} title={t('sch_duplicate')} className="p-1 rounded text-slate-400 hover:text-blue-600"><Copy className="w-3.5 h-3.5" /></button>
                        <button onClick={() => deleteLine(l)} title={t('sch_delete_line')} className="p-1 rounded text-slate-400 hover:text-red-600"><Trash2 className="w-3.5 h-3.5" /></button>
                      </div>
                    </td>
                  </tr>
                );
              })}
              {/* Renglón de captura: pega una o varias órdenes y Enter */}
              <tr className="bg-slate-50/60">
                <td colSpan={7} className="px-2 py-1.5">
                  <div className="flex items-center gap-2">
                    <Plus className="w-4 h-4 text-blue-600 flex-shrink-0" />
                    <input value={addText[exp.export_id] || ''}
                      onChange={(e) => setAddText((p) => ({ ...p, [exp.export_id]: e.target.value }))}
                      onKeyDown={(e) => { if (e.key === 'Enter') addLines(exp); }}
                      placeholder={t('sch_add_orders_ph')}
                      className="sch-field flex-1 rounded-md px-2 py-1 text-[12px] font-bold outline-none focus:border-blue-400" />
                    <button onClick={() => addLines(exp)} disabled={!(addText[exp.export_id] || '').trim()}
                      className="px-3 py-1 rounded-md bg-blue-600 text-white text-[10px] font-black uppercase tracking-wider hover:bg-blue-700 disabled:opacity-40">
                      {t('sch_add')}
                    </button>
                  </div>
                </td>
                <td className="px-2 py-1.5 text-right">
                  <span className="inline-block px-2 py-0.5 rounded bg-yellow-300 font-black text-slate-900 tabular-nums">{fmtNum(sumPcs(ls))}</span>
                </td>
                <td colSpan={6 + (showCrm ? CRM_COLS.length : 0)} className="px-2 text-[10px] font-bold text-slate-400">{t('sch_lines', { n: ls.length })}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    );
  };

  const weekPcs = sumPcs(lines);

  return (
    <main id={ROOT_ID} className="w-full max-w-[1900px] mx-auto space-y-4">
      <datalist id="sch-deliver">{(suggest.delivery_to || []).map((v) => <option key={v} value={v} />)}</datalist>
      <datalist id="sch-from">{(suggest.ship_from || []).map((v) => <option key={v} value={v} />)}</datalist>
      <datalist id="sch-carrier">{(suggest.carrier || []).map((v) => <option key={v} value={v} />)}</datalist>

      {/* Barra de semana: navegación + "pestañas" de semanas como la hoja */}
      <div className="bg-white rounded-2xl px-4 py-3 shadow-sm border border-slate-200 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <button onClick={() => setWeekStart((w) => addDays(w, -7))} className="w-8 h-8 rounded-lg bg-slate-100 text-slate-600 hover:bg-slate-200 flex items-center justify-center"><ChevronLeft className="w-4 h-4" /></button>
            <span className="text-xl font-black text-slate-800 tabular-nums">{weekLabel(weekStart)} <span className="text-slate-400">{weekStart.getFullYear()}</span></span>
            <button onClick={() => setWeekStart((w) => addDays(w, 7))} className="w-8 h-8 rounded-lg bg-slate-100 text-slate-600 hover:bg-slate-200 flex items-center justify-center"><ChevronRight className="w-4 h-4" /></button>
            <button onClick={() => setWeekStart(mondayOf(new Date()))} className="px-3 py-1.5 rounded-lg bg-slate-100 text-slate-600 text-[10px] font-black uppercase tracking-widest hover:bg-slate-200">{t('sch_today')}</button>
            <input type="date" value={isoOf(weekStart)} onChange={(e) => e.target.value && setWeekStart(mondayOf(parseIso(e.target.value)))}
              title={t('sch_jump_week')}
              className="sch-field rounded-lg px-2 py-1 text-[12px] font-bold outline-none" />
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <span className="px-2.5 py-1 rounded-full bg-yellow-100 text-slate-800 text-[11px] font-black tabular-nums">{t('sch_week_pcs', { n: fmtNum(weekPcs) })}</span>
            <span className="px-2.5 py-1 rounded-full bg-blue-50 text-blue-700 text-[11px] font-black">{t('sch_week_counts', { e: exportsList.length, o: lines.length })}</span>
            <label className="flex items-center gap-1.5 text-[11px] font-bold text-slate-500 cursor-pointer select-none">
              <input type="checkbox" checked={showWeekend} onChange={(e) => setShowWeekend(e.target.checked)} /> {t('sch_weekend')}
            </label>
            <label className="flex items-center gap-1.5 text-[11px] font-bold text-slate-500 cursor-pointer select-none" title={t('sch_crm_hint')}>
              <input type="checkbox" checked={showCrm} onChange={(e) => toggleCrm(e.target.checked)} /> {t('sch_crm_cols')}
            </label>
            <button onClick={() => setShowSearch((v) => !v)}
              className={`flex items-center gap-1.5 px-3 py-2 rounded-xl font-black text-[10px] uppercase tracking-widest ${showSearch ? 'bg-blue-600 text-white' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'}`}>
              <Search className="w-3.5 h-3.5" /> {t('sch_search_btn')}
            </button>
            <button onClick={() => loadWeek()} disabled={loading}
              className="flex items-center gap-1.5 px-3 py-2 bg-slate-100 text-slate-600 rounded-xl font-black text-[10px] uppercase tracking-widest hover:bg-slate-200 disabled:opacity-50">
              <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} /> {t('ship_refresh')}
            </button>
            <button onClick={exportWeek} disabled={!exportsList.length}
              className="flex items-center gap-1.5 px-3 py-2 bg-emerald-600 text-white rounded-xl font-black text-[10px] uppercase tracking-widest hover:bg-emerald-700 disabled:opacity-50">
              <Download className="w-3.5 h-3.5" /> {t('sch_excel_week')}
            </button>
          </div>
        </div>
        <div className="flex items-center gap-1.5 flex-wrap">
          {weekStrip.map((w) => {
            const active = isoOf(w) === isoOf(weekStart);
            const current = isoOf(w) === isoOf(mondayOf(new Date()));
            return (
              <button key={isoOf(w)} onClick={() => setWeekStart(w)}
                className={`px-3 py-1.5 rounded-t-lg border-b-2 text-[11px] font-black uppercase tracking-wider transition-all ${active ? 'bg-blue-600 text-white border-blue-800' : current ? 'bg-blue-50 text-blue-700 border-blue-300 hover:bg-blue-100' : 'bg-slate-50 text-slate-500 border-slate-200 hover:bg-slate-100'}`}>
                {weekLabel(w)}
              </button>
            );
          })}
          {Object.keys(statusCounts).length > 0 && (
            <div className="flex items-center gap-1 flex-wrap ml-auto">
              {Object.entries(statusCounts).map(([s, n]) => (
                <span key={s} className="px-2 py-0.5 rounded-full text-[10px] font-black" style={{ background: (STATUS_COLORS[s] || {}).pill || '#e2e8f0', color: STATUS_COLORS[s] ? '#fff' : '#64748b' }}>{s} · {n}</span>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="flex gap-4 items-start">
      {showSearch && (
        <aside className="w-80 flex-shrink-0 bg-white rounded-2xl p-4 shadow-sm border border-slate-200 flex flex-col sticky top-4" style={{ maxHeight: 'calc(100vh - 2rem)' }}>
          <div className="flex items-center gap-2 mb-2">
            <Search className="w-4 h-4 text-blue-600" />
            <input value={availSearch} onChange={(e) => setAvailSearch(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') loadAvailable(true); }}
              placeholder={t('sch_search_ph')}
              className="sch-field flex-1 rounded-lg px-2 py-1.5 text-[12px] font-bold outline-none" />
          </div>
          <label className="flex items-center gap-1.5 text-[10px] font-black uppercase text-slate-500 mb-1">{t('sch_target')}
            <select value={target?.export_id || ''} onChange={(e) => setTargetExport(e.target.value)}
              className="sch-field flex-1 min-w-0 rounded-md px-1.5 py-1 text-[11px] font-bold outline-none">
              {exportsList.map((e) => <option key={e.export_id} value={e.export_id}>{exportLabel(e)}</option>)}
            </select>
          </label>
          {!target && <p className="text-[10px] font-bold text-amber-600 mb-1">{t('sch_no_target')}</p>}
          <p className="text-[10px] text-slate-400 mb-2">{t('sch_search_hint')}</p>
          <div className="flex-1 overflow-y-auto space-y-1.5 -mx-1 px-1">
            {availLoading && !avail.length ? (
              <div className="flex justify-center py-8"><Loader2 className="w-5 h-5 text-blue-400 animate-spin" /></div>
            ) : availSearch.trim() && !avail.length ? (
              <p className="text-center text-[11px] font-black uppercase text-slate-300 py-8">{t('sch_no_matches')}</p>
            ) : avail.map((o) => (
              <div key={o.order_number} className="flex items-center justify-between gap-2 p-2 rounded-lg border border-slate-100 hover:border-blue-200 hover:bg-blue-50/40">
                <div className="min-w-0">
                  <span className="px-1.5 py-0.5 bg-blue-600 text-white text-[10px] font-black rounded">#{o.order_number}</span>
                  <p className="text-[11px] font-bold text-slate-600 truncate mt-0.5">{o.client || '—'}{o.branding ? ` · ${o.branding}` : ''}</p>
                  <p className="text-[10px] text-slate-400">Cancel: {o.cancel_date || '—'} · Qty {o.quantity ?? '—'}{o.production_status ? ` · ${o.production_status}` : ''}</p>
                </div>
                <button onClick={() => target && addLines(target, o.order_number)} disabled={!target}
                  className="flex items-center gap-1 px-2 py-1 bg-blue-600 text-white rounded-md text-[10px] font-black uppercase hover:bg-blue-700 disabled:opacity-40 flex-shrink-0">
                  <Plus className="w-3 h-3" /> {t('sch_add')}
                </button>
              </div>
            ))}
            {avail.length > 0 && avail.length < availTotal && (
              <button onClick={() => loadAvailable(false)} disabled={availLoading}
                className="w-full py-2 text-[10px] font-black uppercase tracking-widest text-blue-600 hover:bg-blue-50 rounded-lg disabled:opacity-50">
                {t('sch_load_more', { a: avail.length, b: availTotal })}
              </button>
            )}
          </div>
        </aside>
      )}
      <div className="flex-1 min-w-0">
      {!data && loading ? (
        <div className="flex justify-center py-24"><Loader2 className="w-8 h-8 text-blue-400 animate-spin" /></div>
      ) : (
        <div className="space-y-5">
          {visibleDays.map((iso) => {
            const dayExports = exportsList.filter((e) => e.date === iso);
            const dayLines = dayExports.flatMap((e) => linesByExport[e.export_id] || []);
            const isToday = iso === todayIso;
            return (
              <section key={iso} className="space-y-2">
                <div className={`flex flex-wrap items-center justify-between gap-2 px-4 py-2 rounded-xl ${isToday ? 'bg-blue-700' : 'bg-slate-800'} text-white`}>
                  <div className="flex items-center gap-3">
                    <span className="text-sm font-black tracking-widest">{dayLabel(iso)}</span>
                    {isToday && <span className="px-2 py-0.5 rounded-full bg-white/20 text-[10px] font-black uppercase">{t('sch_today')}</span>}
                    <span className="text-[11px] font-bold text-white/60">
                      {t('sch_day_summary', { e: dayExports.length, o: dayLines.length, p: fmtNum(sumPcs(dayLines)) })}
                    </span>
                  </div>
                  <button onClick={() => addExport(iso)}
                    className="flex items-center gap-1 px-3 py-1.5 rounded-lg bg-white/15 hover:bg-white/25 text-[10px] font-black uppercase tracking-widest">
                    <Plus className="w-3.5 h-3.5" /> {t('sch_add_export')}
                  </button>
                </div>
                {dayExports.length === 0 ? (
                  <button onClick={() => addExport(iso)}
                    className="w-full py-4 rounded-xl border-2 border-dashed border-slate-200 text-[12px] font-bold text-slate-400 hover:border-blue-300 hover:text-blue-600 hover:bg-blue-50/40">
                    {t('sch_no_exports')}
                  </button>
                ) : dayExports.map((e, i) => renderExport(e, i))}
              </section>
            );
          })}
        </div>
      )}
      </div>
      </div>
    </main>
  );
};

export default ShippingScheduler;
