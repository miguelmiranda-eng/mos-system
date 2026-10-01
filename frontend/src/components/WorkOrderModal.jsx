import { useEffect, useState, useRef } from 'react';
import { X, Image as ImageIcon } from 'lucide-react';
import { toast } from 'sonner';
import { API } from '../lib/constants';

/*
 * Ficha de WORK ORDER a pantalla completa (solo lectura). Aditiva: es un modal
 * nuevo que se abre desde un botón en la fila; NO toca la tabla ni las funciones
 * existentes. Replica el layout de la maqueta aprobada y lee el objeto `order`
 * real + `order.work_order` (líneas no-prenda + customer_note que el sync ahora
 * guarda; ver printavo_sync._work_order_content).
 *
 * v1: las instrucciones de empaque se muestran EN CRUDO (líneas tal cual). El
 * parseo en secciones (pack refs, approval, shortage) llega cuando se vea data
 * real en producción. La galería de mocks y el avance por captura necesitan
 * fetch aparte y quedan para una iteración siguiente.
 */

const STAGES = [
  ['SCHEDULING', 'Programación'], ['BLANKS', 'Blanks'], ['SCREENS', 'Screens'],
  ['LABEL', 'Neck'], ['PRODUCTION', 'Producción'], ['PACKING', 'Empaque'], ['SHIPPED', 'Enviada'],
];
const RANK = Object.fromEntries(STAGES.map((s, i) => [s[0], i]));
const SLABEL = Object.fromEntries(STAGES);
const BOARD_STAGE = {
  BLANKS: 'BLANKS', SCREENS: 'SCREENS', NECK: 'LABEL',
  'CONTROL DE CALIDAD': 'PACKING', COMPLETOS: 'PACKING', 'FINAL BILL': 'PACKING',
};
const FALLBACK_BOARD_STAGE = {
  SCHEDULING: 'SCHEDULING', 'READY TO SCHEDULED': 'SCHEDULING', MASTER: 'SCHEDULING', EDI: 'SCHEDULING',
};
const STATUS_STAGE = {
  'NECESITA LABEL': 'LABEL', 'PROCESO DE NECK LABEL': 'LABEL', 'PROCESO DE LABEL': 'LABEL', 'LABEL LISTO': 'LABEL',
  'EN PRODUCCION': 'PRODUCTION',
  'NECESITA EMPACAR': 'PACKING', 'EN PROCESO DE EMPAQUE': 'PACKING', 'NECESITA QC': 'PACKING',
  'CORRECIÓN DE QC': 'PACKING', 'LISTO PARA FULFILLMENT': 'PACKING',
  'EJEMPLO APROBADO': 'SCHEDULING', 'ESPERA DE APROBAC': 'SCHEDULING', 'EN ESPERA': 'SCHEDULING',
};

// Deduce la etapa como la maqueta/OrderComponentsBoard: el tablero manda; si el
// status va más adelante, se marca como "señalado" (adelantado). No es historia.
function stageOf(order) {
  const board = String(order.board || '').trim().toUpperCase();
  const status = String(order.production_status || '').trim().toUpperCase();
  let porTablero = BOARD_STAGE[board] || null;
  if (board.indexOf('MAQUINA') === 0) porTablero = 'PRODUCTION';
  const porStatus = STATUS_STAGE[status] || null;
  const respaldo = FALLBACK_BOARD_STAGE[board] || null;
  const key = porTablero || porStatus || respaldo;
  const adelantado = !!(porTablero && porStatus && RANK[porStatus] > RANK[porTablero]);
  return {
    key,
    ahead: adelantado ? porStatus : null,
    tableroLabel: porTablero ? SLABEL[porTablero] : null,
    aheadLabel: adelantado ? SLABEL[porStatus] : null,
  };
}

function Lifeline({ actual, ahead }) {
  const i = STAGES.findIndex((e) => e[0] === actual);
  const iAhead = ahead ? STAGES.findIndex((e) => e[0] === ahead) : -1;
  return (
    <div className="flex items-start select-none w-full max-w-[560px]">
      {STAGES.map((e, idx) => {
        const pasado = i >= 0 && idx < i;
        const aqui = idx === i;
        const senalado = idx === iAhead;
        return (
          <div key={e[0]} className="flex-1 flex flex-col items-center relative min-w-0">
            {idx > 0 && (
              <span className={`absolute top-[7px] right-1/2 w-full h-0.5 ${idx <= i ? 'bg-blue-500' : 'bg-slate-300/40'}`} />
            )}
            <span className={`relative z-10 rounded-full transition-all ${
              aqui ? 'w-4 h-4 bg-blue-600 ring-4 ring-blue-500/20'
                : pasado ? 'w-3.5 h-3.5 bg-blue-500'
                  : senalado ? 'w-3.5 h-3.5 bg-white border-2 border-amber-400'
                    : 'w-3.5 h-3.5 bg-white border-2 border-slate-300/50'}`} />
            <span className={`mt-1.5 text-[10px] leading-tight text-center px-0.5 truncate w-full ${
              aqui ? 'font-black text-blue-500'
                : pasado ? 'font-bold text-slate-400'
                  : senalado ? 'font-bold text-amber-500'
                    : 'text-slate-400/60'}`}>{e[1]}</span>
          </div>
        );
      })}
    </div>
  );
}

const fmtDate = (s) => {
  const m = String(s || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return s || '—';
  const MESES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
  return `${m[3]} ${MESES[+m[2] - 1]} ${m[1]}`;
};
const daysTo = (s) => {
  const m = String(s || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  return Math.round((new Date(`${m[1]}-${m[2]}-${m[3]}`) - new Date(new Date().toISOString().slice(0, 10))) / 86400000);
};
// Secciones de la ficha que supersu puede mostrar/ocultar (configurador Diseño).
const WO_FIELDS = [
  ['mock', 'Mock del diseño'],
  ['print_where', 'Dónde se imprime'],
  ['front', 'Front print / finishing'],
  ['wolink', 'Work order link'],
  ['sizes', 'Corrida de tallas'],
  ['avance', 'Avance de producción'],
  ['estados', 'Estados'],
  ['notas', 'Notas de la orden'],
  ['invoice', 'Invoice de Printavo'],
  ['empaque', 'Instrucciones de empaque'],
];

const stripHtml = (s) => String(s || '').replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, ' ').replace(/\s+\n/g, '\n').replace(/[ \t]+/g, ' ').trim();
const firstUrl = (s) => { const m = String(s || '').match(/https?:\/\/[^\s"'<>]+/); return m ? m[0] : ''; };

// Parsea las lineas crudas del work order (Printavo) en secciones, como la
// maqueta. El formato es consistente: bloques etiquetados SAMPLES / APPROVAL
// METHOD: / ALLOWED SHORTAGE: / FRONT PRINT... / SPECIAL NOTES:, el PACK con
// "INCLUDES REFERENCES TO:", instrucciones numeradas "1) ...", NEW BOXES /
// BULK PACK, y lineas de servicio (fees). Si algo no encaja, cae en fees.
function parseWorkOrder(lines) {
  const wo = { samples: '', front: '', approval: '', shortage: '', specialNotes: '', packHeader: '', packRefs: [], steps: [], boxes: '', fees: [] };
  const strip = (s, label) => s.replace(new RegExp(`^${label}\\s*:?\\s*`, 'i'), '').trim();
  (lines || []).forEach((raw) => {
    const line = String(raw || '').replace(/\r/g, '').trim();
    if (!line) return;
    const head = (line.split('\n')[0] || '').trim();
    const U = head.toUpperCase();
    if (/\(DO NOT EDIT\)/i.test(line) && /DEPARTMENT/i.test(U)) return;
    if (/^SAMPLES\b/i.test(U)) { wo.samples = strip(line, 'SAMPLES'); return; }
    if (/^APPROVAL METHOD/i.test(U)) { wo.approval = strip(line, 'APPROVAL METHOD'); return; }
    if (/^ALLOWED SHORTAGE/i.test(U)) { wo.shortage = strip(line, 'ALLOWED SHORTAGE'); return; }
    if (/^FRONT PRINT/i.test(U)) { wo.front = line; return; }
    if (/^SPECIAL NOTES/i.test(U)) { const v = strip(line, 'SPECIAL NOTES'); if (v) wo.specialNotes = v; return; }
    if (/INCLUDES REFERENCES TO/i.test(line)) {
      const parts = line.split(/INCLUDES REFERENCES TO:?/i);
      wo.packHeader = (parts[0] || '').trim();
      wo.packRefs = (parts[1] || '').split('\n').map((s) => s.trim()).filter(Boolean);
      return;
    }
    if (/^\d+\)/.test(head)) { wo.steps.push(line.replace(/\s+/g, ' ').trim()); return; }
    if (/^(NEW BOXES|BULK PACK)/i.test(U)) { wo.boxes = line; return; }
    wo.fees.push(line.replace(/\s+/g, ' ').trim());
  });
  return wo;
}

const MESES_ABBR = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
const fmtWhen = (s) => {
  const d = new Date(s);
  if (!s || Number.isNaN(d.getTime())) return '';
  const hm = d.toTimeString().slice(0, 5);
  const iso = d.toISOString().slice(0, 10);
  const today = new Date().toISOString().slice(0, 10);
  return iso === today ? `hoy ${hm}` : `${d.getDate()} ${MESES_ABBR[d.getMonth()]} ${hm}`;
};

function Field({ label, children, mono, full }) {
  return (
    <div className={full ? 'col-span-full' : ''}>
      <div className="text-[9px] font-bold uppercase tracking-[0.15em] text-slate-400">{label}</div>
      <div className={`text-[13px] mt-0.5 break-words ${mono ? 'font-mono' : ''}`}>{children || '—'}</div>
    </div>
  );
}

// Playeras FRENTE/ESPALDA con las zonas de impresion (porteadas de la maqueta).
const GARMENT_HEX = {
  'VINTAGE WHITE': '#f3efe6', WHITE: '#fbfbfb', IVORY: '#f2ead8', 'HEATHER DUST': '#ded2c4',
  'SPORT GREY': '#b9bcbe', BLACK: '#2a2a2c', 'MIDNIGHT NAVY': '#232f45', 'TRUE RED': '#b8232d',
};
const TEE_PATH = 'M42,10 C48,22 72,22 78,10 L90,14 L112,36 L96,54 L92,46 L92,132 L28,132 L28,46 L24,54 L8,36 L30,14 Z';
const zoneStyle = (on) => (on
  ? { fill: '#2563eb22', stroke: '#2563eb', strokeWidth: 2 }
  : { fill: 'none', stroke: '#cbd5e1', strokeWidth: 1.5, strokeDasharray: '3 2' });
const zoneText = (on) => (on ? '#2563eb' : '#94a3b8');

function Tee({ front, zones, hex }) {
  return (
    <figure className="m-0 flex flex-col items-center">
      <svg viewBox="0 0 120 142" width="76" role="img" aria-label={front ? 'Frente' : 'Espalda'}>
        <path d={TEE_PATH} fill={hex} stroke="#e2e8f0" strokeWidth="1.5" />
        <path d="M30,14 L34,26 M90,14 L86,26" stroke="#cbd5e1" strokeWidth="1" fill="none" />
        {front ? (
          <>
            <path d="M42,10 C48,22 72,22 78,10" stroke="#cbd5e1" strokeWidth="1" fill="none" />
            <rect x="41" y="46" width="38" height="36" rx="2" {...zoneStyle(zones.frente)} />
            <text x="60" y="68" textAnchor="middle" fontSize="7" fontWeight="700" fill={zoneText(zones.frente)}>FRENTE</text>
            <rect x="15" y="28" width="15" height="12" rx="2" {...zoneStyle(zones.manga)} />
            <text x="22" y="48" textAnchor="middle" fontSize="5" fontWeight="700" fill={zoneText(zones.manga)}>MANGA</text>
          </>
        ) : (
          <>
            <path d="M43,11 C49,18 71,18 77,11" stroke="#cbd5e1" strokeWidth="1" fill="none" />
            <rect x="41" y="42" width="38" height="46" rx="2" {...zoneStyle(zones.espalda)} />
            <text x="60" y="68" textAnchor="middle" fontSize="7" fontWeight="700" fill={zoneText(zones.espalda)}>ESPALDA</text>
            <rect x="50" y="20" width="20" height="9" rx="1.5" {...zoneStyle(zones.cuello)} />
            <text x="60" y="36" textAnchor="middle" fontSize="4.5" fontWeight="700" fill={zoneText(zones.cuello)}>CUELLO</text>
          </>
        )}
      </svg>
      <figcaption className="text-[10px] text-slate-400 mt-1">{front ? 'Frente' : 'Espalda'}</figcaption>
    </figure>
  );
}

function Tees({ pos, color }) {
  const p = String(pos || '').toLowerCase();
  const zones = {
    frente: /frente|front/.test(p),
    espalda: /espalda|back/.test(p),
    manga: /manga|sleeve/.test(p),
    cuello: /cuello|neck/.test(p),
  };
  const hex = GARMENT_HEX[String(color || '').toUpperCase()] || '#fbfbfb';
  return (
    <div className="flex gap-3 shrink-0">
      <Tee front zones={zones} hex={hex} />
      <Tee front={false} zones={zones} hex={hex} />
    </div>
  );
}

export default function WorkOrderModal({ order, isOpen, onClose, isDark = false, canDesign = false }) {
  useEffect(() => {
    if (!isOpen) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [isOpen, onClose]);

  // Capturas de producción de la orden (barra de avance + lista).
  const [logs, setLogs] = useState([]);
  useEffect(() => {
    if (!isOpen || !order?.order_id) { setLogs([]); return undefined; }
    let alive = true;
    fetch(`${API}/production-logs/${order.order_id}`, { credentials: 'include' })
      .then((r) => (r.ok ? r.json() : { logs: [] }))
      .then((d) => { if (alive) setLogs(Array.isArray(d.logs) ? d.logs : []); })
      .catch(() => { if (alive) setLogs([]); });
    return () => { alive = false; };
  }, [isOpen, order]);

  // Mocks del diseño: reusa el endpoint existente POST /orders/{id}/images
  // (guarda a disco + order.images) y los muestra como galería.
  const [mocks, setMocks] = useState([]);
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef(null);
  useEffect(() => { setMocks(Array.isArray(order?.images) ? order.images : []); }, [order]);

  const toBase64 = (file) => new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = reject;
    r.readAsDataURL(file);
  });
  const subirMocks = async (fileList) => {
    if (!order?.order_id || !fileList || !fileList.length) return;
    setUploading(true);
    try {
      for (const file of Array.from(fileList)) {
        if (!file.type.startsWith('image/')) continue;
        const data = await toBase64(file); // eslint-disable-line no-await-in-loop
        const res = await fetch(`${API}/orders/${order.order_id}/images`, { // eslint-disable-line no-await-in-loop
          method: 'POST', credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ image_data: data, filename: file.name }),
        });
        if (res.ok) {
          const d = await res.json(); // eslint-disable-line no-await-in-loop
          setMocks((m) => [...m, { filename: d.filename, url: d.url }]);
        } else {
          toast.error(`No se pudo subir ${file.name}`);
        }
      }
      toast.success('Mock(s) subido(s)');
    } catch {
      toast.error('Error al subir el mock');
    } finally {
      setUploading(false);
    }
  };

  // Layout de la ficha (configurador Diseño, global): qué secciones se ocultan.
  const [hidden, setHidden] = useState([]);
  const [designOpen, setDesignOpen] = useState(false);
  useEffect(() => {
    if (!isOpen) return undefined;
    let alive = true;
    fetch(`${API}/config/wo-layout`, { credentials: 'include' })
      .then((r) => (r.ok ? r.json() : {}))
      .then((d) => { if (alive) setHidden(Array.isArray(d.hidden) ? d.hidden : []); })
      .catch(() => {});
    return () => { alive = false; };
  }, [isOpen]);

  if (!isOpen || !order) return null;

  const show = (k) => !hidden.includes(k);
  const toggleField = async (k) => {
    const next = hidden.includes(k) ? hidden.filter((x) => x !== k) : [...hidden, k];
    setHidden(next);
    try {
      const r = await fetch(`${API}/config/wo-layout`, {
        method: 'PUT', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ hidden: next }),
      });
      if (!r.ok) throw new Error('bad');
    } catch { toast.error('No se pudo guardar el diseño'); }
  };

  const o = order;
  const sizes = (o.sizes && typeof o.sizes === 'object') ? o.sizes : {};
  const sizeKeys = Object.keys(sizes);
  const sizeSum = sizeKeys.reduce((a, k) => a + (Number(sizes[k]) || 0), 0);
  const qty = Number(o.quantity) || 0;
  const cuadra = sizeSum === qty;
  const wo = (o.work_order && typeof o.work_order === 'object') ? o.work_order : {};
  const woLines = Array.isArray(wo.lines) ? wo.lines : [];
  const wop = parseWorkOrder(woLines);
  const hasWO = woLines.length > 0;
  const noteText = stripHtml(wo.customer_note || '');
  const noteUrl = firstUrl(wo.customer_note || '');
  const st = stageOf(o);
  const dueIn = daysTo(o.due_date);
  const storePo = o['store_po#'] || o.store_po || '';
  const design = o['design_#'] || o.design_num || '';
  const pos = Array.isArray(o.print_positions) ? o.print_positions.join(' · ') : (o.print_positions || '');
  const woLink = (o.job_title_a && typeof o.job_title_a === 'object') ? o.job_title_a : null;
  const totalProduced = logs.reduce((a, l) => a + (Number(l.quantity_produced) || 0), 0);
  const pct = qty ? Math.min(100, Math.round((totalProduced * 100) / qty)) : 0;

  const check = (on, label) => (
    <div className="flex items-center gap-2 text-[12.5px]">
      <span className={`inline-flex items-center justify-center w-4 h-4 rounded ${on ? 'bg-emerald-500 text-white' : 'border border-slate-300/50 text-transparent'}`}>✓</span>
      <span className={on ? '' : 'text-slate-400'}>{label}</span>
    </div>
  );

  const estados = [
    ['Blank', o.blank_status], ['Producción', o.production_status], ['Trim', o.trim_status],
    ['Artwork', o.artwork_status], ['Sample', o.sample], ['Betty', o.betty_column], ['Shipping', o.shipping],
  ];

  const panel = isDark ? 'bg-[hsl(220,30%,11%)] text-slate-100' : 'bg-white text-slate-800';
  const card = isDark ? 'bg-[hsl(220,30%,9%)] border-white/5' : 'bg-gray-50/70 border-gray-100';

  return (
    <div className="fixed inset-0 z-[200] overflow-y-auto" role="dialog" aria-modal="true" aria-label={`Work order ${o.order_number}`}>
      <div className="absolute inset-0 bg-black/60" onClick={onClose} />
      <div className={`relative w-full min-h-screen ${panel}`}>
        {/* Encabezado */}
        <div className={`flex items-start gap-4 px-6 py-4 border-b ${isDark ? 'border-white/10' : 'border-gray-200'}`}>
          <div className="min-w-0">
            <div className="text-[10px] font-bold uppercase tracking-[0.2em] text-slate-400">Work order · invoice #{o.printavo_invoice_id ? o.order_number : o.order_number}</div>
            <div className="text-[30px] font-black leading-none tracking-tight">{o.order_number}</div>
            <div className="text-sm font-semibold mt-1">{o.client || '—'}</div>
            <div className="text-[11px] text-slate-400 mt-0.5">PO {o.customer_po || '—'} · {o.branding || '—'}</div>
          </div>
          <div className="flex-1 flex flex-col items-center gap-1 pt-1">
            <Lifeline actual={st.key} ahead={st.ahead} />
            {st.ahead && (
              <div className="text-[11px] text-amber-600 bg-amber-400/10 border border-amber-400/30 rounded px-2 py-0.5 mt-1">
                El tablero dice {st.tableroLabel?.toLowerCase()} y el status dice {st.aheadLabel?.toLowerCase()}. Alguien avanzó una sin mover la otra.
              </div>
            )}
          </div>
          <div className="text-right whitespace-nowrap">
            <div className="text-[10px] uppercase tracking-wide text-slate-400">Entrega</div>
            <div className={`text-lg font-bold ${dueIn !== null && dueIn <= 7 ? 'text-rose-500' : ''}`}>{fmtDate(o.due_date)}</div>
            <div className="text-[11px] text-slate-400">{dueIn !== null ? `en ${dueIn} días · ` : ''}cancel {fmtDate(o.cancel_date)}</div>
            {o.priority && <div className="text-[11px] text-slate-400">Prioridad {String(o.priority).toLowerCase()}</div>}
          </div>
          {canDesign && (
            <button onClick={() => setDesignOpen((v) => !v)} className={`px-2.5 py-1 rounded-lg border text-[11px] font-bold ${designOpen ? 'bg-blue-600 text-white border-blue-600' : (isDark ? 'border-white/15 hover:bg-white/5' : 'border-gray-300 hover:bg-gray-50')}`} title="Diseño: qué secciones aparecen en la ficha (solo supersu, aplica a todos)">Diseño</button>
          )}
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-slate-500/10" aria-label="Cerrar la work order"><X className="w-5 h-5" /></button>
        </div>
        {designOpen && canDesign && (
          <div className={`fixed top-16 right-6 z-[210] w-64 rounded-xl border shadow-2xl p-3 ${isDark ? 'bg-[hsl(220,30%,11%)] border-white/10 text-slate-100' : 'bg-white border-gray-200 text-slate-800'}`}>
            <div className="text-[11px] font-bold uppercase tracking-[0.12em] text-slate-400 mb-1">Diseño de la ficha</div>
            <p className="text-[10px] text-slate-400 mb-2">Qué secciones se muestran. Aplica a todos.</p>
            {WO_FIELDS.map(([k, label]) => (
              <label key={k} className="flex items-center gap-2 py-1 text-[12px] cursor-pointer">
                <input type="checkbox" checked={show(k)} onChange={() => toggleField(k)} className="w-3.5 h-3.5" />
                <span>{label}</span>
              </label>
            ))}
          </div>
        )}

        {/* Tres columnas */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 p-5">
          {/* Columna A: mock + dónde se imprime */}
          <div className="space-y-4">
            <div className={show('mock') ? undefined : 'hidden'}>
              <h3 className="text-[10px] font-bold uppercase tracking-[0.15em] text-slate-400 mb-2">Mock del diseño</h3>
              <div
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => { e.preventDefault(); subirMocks(e.dataTransfer.files); }}
                className={`rounded-xl border-2 border-dashed ${isDark ? 'border-white/10' : 'border-gray-200'} p-4`}
              >
                {mocks.length > 0 ? (
                  <div className="grid grid-cols-3 gap-2 mb-3">
                    {mocks.map((m, i) => (
                      <a key={m.url || i} href={m.url} target="_blank" rel="noreferrer" className={`block aspect-square rounded-lg overflow-hidden border ${isDark ? 'border-white/10' : 'border-gray-200'}`}>
                        <img src={m.url} alt={m.filename || 'mock'} className="w-full h-full object-cover" />
                      </a>
                    ))}
                  </div>
                ) : (
                  <div className="flex flex-col items-center text-center gap-2 py-4">
                    <ImageIcon className="w-10 h-10 text-slate-300" strokeWidth={1.5} />
                    <p className="text-[13px] text-slate-400">Sin mocks para <b className="text-slate-500">{design || 'este diseño'}</b>.</p>
                    <p className="text-[12px] text-slate-400 max-w-[280px]">Arrastra una o varias imágenes aquí, súbelas, o tráelas del invoice de Printavo.</p>
                  </div>
                )}
                <div className="flex gap-2 justify-center">
                  <button type="button" onClick={() => fileRef.current && fileRef.current.click()} disabled={uploading} className="px-3 py-1.5 rounded-lg bg-blue-600 text-white text-[12px] font-bold hover:bg-blue-500 disabled:opacity-60">{uploading ? 'Subiendo…' : 'Subir imágenes'}</button>
                  <button type="button" onClick={() => toast('Traer de Printavo: próximamente')} className={`px-3 py-1.5 rounded-lg border text-[12px] font-bold ${isDark ? 'border-white/15 hover:bg-white/5' : 'border-gray-300 hover:bg-gray-50'}`}>Traer de Printavo</button>
                </div>
                <input ref={fileRef} type="file" accept="image/*" multiple hidden onChange={(e) => { subirMocks(e.target.files); e.target.value = ''; }} />
              </div>
              <p className="text-[11px] text-slate-400 mt-2">El mock llega por carga manual o desde Printavo.</p>
            </div>
            <div className={show('print_where') ? undefined : 'hidden'}>
              <h3 className="text-[10px] font-bold uppercase tracking-[0.15em] text-slate-400 mb-2">Dónde se imprime{pos ? ` · ${pos}` : ''}</h3>
              <div className="flex gap-4 items-start">
                <Tees pos={pos} color={o.color} />
                <div className="space-y-1.5">
                  {check(o.art_sep_status, 'Separaciones listas')}
                  {check(o.screens, 'Mallas listas')}
                  {check(o.art_neck_status, 'Neck label listo')}
                  {check(!!o.packing_link, 'Packing list importado')}
                  {check(o.is_preorder, 'Preorden')}
                </div>
              </div>
              {wop.front && show('front') && (
                <pre className={`mt-3 text-[12px] font-mono whitespace-pre-wrap rounded-lg border p-2.5 ${card}`}>{wop.front}</pre>
              )}
            </div>
            {woLink && woLink.url && show('wolink') && (
              <div className={`rounded-lg border p-3 ${card}`}>
                <div className="text-[9px] font-bold uppercase tracking-[0.15em] text-slate-400 mb-1">Work order link</div>
                <a href={woLink.url} target="_blank" rel="noreferrer" className="text-[12px] text-blue-500 underline break-all">{woLink.desc || woLink.url}</a>
              </div>
            )}
          </div>

          {/* Columna B: tallas, estados, notas */}
          <div className="space-y-4">
            <div className={show('sizes') ? undefined : 'hidden'}>
              <div className="flex items-center justify-between mb-2">
                <h3 className="text-[10px] font-bold uppercase tracking-[0.15em] text-slate-400">Corrida de tallas</h3>
                <span className="text-[11px]">{sizeSum} de {qty} <span className={cuadra ? 'text-emerald-500 font-bold' : 'text-rose-500 font-bold'}>{cuadra ? 'cuadra' : `descuadre de ${Math.abs(qty - sizeSum)}`}</span></span>
              </div>
              {sizeKeys.length > 0 ? (
                <div className="grid gap-1" style={{ gridTemplateColumns: `repeat(${Math.min(sizeKeys.length + 1, 9)},minmax(0,1fr))` }}>
                  {sizeKeys.map((k) => (
                    <div key={k} className={`rounded border text-center py-1 ${card}`}>
                      <div className="text-[9px] font-bold text-slate-400">{k}</div>
                      <div className="text-[13px] font-mono">{sizes[k]}</div>
                    </div>
                  ))}
                  <div className="rounded border text-center py-1 bg-slate-800 text-white border-slate-800">
                    <div className="text-[9px] font-bold opacity-70">TOTAL</div>
                    <div className="text-[13px] font-mono">{sizeSum}</div>
                  </div>
                </div>
              ) : <div className="text-[12px] text-slate-400">Sin desglose de tallas.</div>}
            </div>

            <div className={show('avance') ? undefined : 'hidden'}>
              <div className="flex items-center justify-between mb-1.5">
                <h3 className="text-[10px] font-bold uppercase tracking-[0.15em] text-slate-400">Avance de producción</h3>
                <span className="text-[11px]">{pct}% impreso · <span className="text-slate-400">{totalProduced} de {qty}</span></span>
              </div>
              <div className={`h-2 rounded-full overflow-hidden ${isDark ? 'bg-white/10' : 'bg-gray-200'}`}>
                <div className={`h-full rounded-full ${pct >= 100 ? 'bg-emerald-500' : 'bg-blue-500'}`} style={{ width: `${pct}%` }} />
              </div>
              {logs.length > 0 ? (
                <div className="mt-2 space-y-1 max-h-40 overflow-y-auto">
                  {logs.map((l, idx) => (
                    <div key={idx} className={`flex items-center gap-2 text-[11.5px] rounded px-2 py-1 ${card} border`}>
                      <span className="font-mono font-bold w-10 shrink-0 text-right">{l.quantity_produced}</span>
                      <span className="truncate">{[l.size, l.design_type, l.machine, l.user_name].filter(Boolean).join(' · ')}</span>
                      <span className="ml-auto text-slate-400 shrink-0">{fmtWhen(l.created_at)}</span>
                    </div>
                  ))}
                </div>
              ) : <p className="text-[12px] text-slate-400 mt-1.5">Sin capturas de producción todavía.</p>}
            </div>

            <div className={show('estados') ? undefined : 'hidden'}>
              <h3 className="text-[10px] font-bold uppercase tracking-[0.15em] text-slate-400 mb-2">Estados</h3>
              <div className="flex flex-wrap gap-1.5">
                {estados.map(([lbl, val]) => (
                  <span key={lbl} className={`text-[11px] px-2 py-1 rounded ${card} border`}>
                    <b className="text-slate-400 font-bold mr-1">{lbl}</b>{val || '—'}
                  </span>
                ))}
              </div>
            </div>

            {o.notes && show('notas') && (
              <div>
                <h3 className="text-[10px] font-bold uppercase tracking-[0.15em] text-slate-400 mb-1">Notas de la orden</h3>
                <p className="text-[12.5px] whitespace-pre-wrap">{o.notes}</p>
              </div>
            )}
          </div>

          {/* Columna C: invoice + empaque */}
          <div className="space-y-4">
            <div className={show('invoice') ? undefined : 'hidden'}>
              <h3 className="text-[10px] font-bold uppercase tracking-[0.15em] text-slate-400 mb-2">Invoice de Printavo · #{o.order_number}</h3>
              <div className="grid grid-cols-2 gap-x-4 gap-y-2.5">
                <Field label="Customer PO" mono>{o.customer_po}</Field>
                <Field label="Store PO" mono>{storePo}</Field>
                <Field label="Design" mono>{design}</Field>
                <Field label="Blank style">{o.style}</Field>
                <Field label="Blank color">{o.color}</Field>
                <Field label="Units total" mono>{qty}</Field>
                <Field label="Tablero">{o.board}</Field>
                <Field label="Trim box">{o.trim_box}</Field>
                <Field label="Final bill">{fmtDate(o.final_bill)}</Field>
                <Field label="Allowed shortage" mono>{wop.shortage}</Field>
                <Field label="Samples">{wop.samples}</Field>
                <Field label="Sample física">{o.sample_printavo}</Field>
                <Field label="Gemela" mono>{o.twin_order_number}</Field>
                <Field label="Nickname" mono full>{woLink ? woLink.desc : ''}</Field>
                {wop.approval && <Field label="Approval method" full>{wop.approval}</Field>}
              </div>
            </div>

            <div className={show('empaque') ? undefined : 'hidden'}>
              <h3 className="text-[10px] font-bold uppercase tracking-[0.15em] text-slate-400 mb-2">Instrucciones de empaque</h3>
              {!hasWO ? (
                <p className="text-[12px] text-slate-400">Aún sin datos del work order. Se poblará con el sync (órdenes nuevas) y el backfill (históricas).</p>
              ) : (
                <div className="space-y-3">
                  {(wop.packHeader || wop.steps.length > 0) && (
                    <div>
                      {wop.packHeader && <pre className={`text-[12px] font-mono whitespace-pre-wrap rounded-lg border p-2.5 ${card}`}>{wop.packHeader}</pre>}
                      {wop.steps.length > 0 && (
                        <div className="space-y-1 mt-1">
                          {wop.steps.map((s, i) => (
                            <div key={i} className={`flex gap-2 text-[12.5px] rounded px-2 py-1 ${card} border`}>
                              <span className="text-slate-400 font-mono w-5 shrink-0">{i + 1}</span>
                              <span className="break-words">{s.replace(/^\d+\)\s*/, '')}</span>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                  {wop.packRefs.length > 0 && (
                    <div>
                      <p className="text-[9px] font-bold uppercase tracking-[0.15em] text-slate-400 mb-1">{o.branding || 'PO'} · includes references to</p>
                      <div className="grid grid-cols-2 gap-1">
                        {wop.packRefs.map((r, i) => (
                          <div key={i} className={`text-[11.5px] rounded px-2 py-1 ${card} border`}>{r}</div>
                        ))}
                      </div>
                    </div>
                  )}
                  {wop.boxes && (
                    <div>
                      <p className="text-[9px] font-bold uppercase tracking-[0.15em] text-slate-400 mb-1">New boxes</p>
                      <pre className="text-[12px] whitespace-pre-wrap">{wop.boxes}</pre>
                    </div>
                  )}
                  {wop.specialNotes && (
                    <div>
                      <p className="text-[9px] font-bold uppercase tracking-[0.15em] text-slate-400 mb-1">Special notes</p>
                      <pre className="text-[12.5px] whitespace-pre-wrap">{wop.specialNotes}</pre>
                    </div>
                  )}
                  {noteUrl && (
                    <div>
                      <p className="text-[9px] font-bold uppercase tracking-[0.15em] text-slate-400 mb-1">Packing list</p>
                      <a href={noteUrl} target="_blank" rel="noreferrer" className="text-[12px] text-blue-500 underline break-all">{noteText || noteUrl}</a>
                    </div>
                  )}
                  {wop.fees.length > 0 && (
                    <div>
                      <p className="text-[9px] font-bold uppercase tracking-[0.15em] text-slate-400 mb-1">Servicios / cargos</p>
                      <ul className="text-[11.5px] text-slate-400 list-disc pl-4 space-y-0.5">
                        {wop.fees.map((f, i) => <li key={i}>{f}</li>)}
                      </ul>
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
