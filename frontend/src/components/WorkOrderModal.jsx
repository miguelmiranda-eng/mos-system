import { useEffect } from 'react';
import { X } from 'lucide-react';

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
  ['SCHEDULING', 'Programación'], ['BLANKS', 'Blancos'], ['SCREENS', 'Mallas'],
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

function Field({ label, children, mono, full }) {
  return (
    <div className={full ? 'col-span-full' : ''}>
      <div className="text-[9px] font-bold uppercase tracking-[0.15em] text-slate-400">{label}</div>
      <div className={`text-[13px] mt-0.5 break-words ${mono ? 'font-mono' : ''}`}>{children || '—'}</div>
    </div>
  );
}

export default function WorkOrderModal({ order, isOpen, onClose, isDark = false }) {
  useEffect(() => {
    if (!isOpen) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [isOpen, onClose]);

  if (!isOpen || !order) return null;

  const o = order;
  const sizes = (o.sizes && typeof o.sizes === 'object') ? o.sizes : {};
  const sizeKeys = Object.keys(sizes);
  const sizeSum = sizeKeys.reduce((a, k) => a + (Number(sizes[k]) || 0), 0);
  const qty = Number(o.quantity) || 0;
  const cuadra = sizeSum === qty;
  const wo = (o.work_order && typeof o.work_order === 'object') ? o.work_order : {};
  const woLines = Array.isArray(wo.lines) ? wo.lines : [];
  const st = stageOf(o);
  const dueIn = daysTo(o.due_date);
  const storePo = o['store_po#'] || o.store_po || '';
  const design = o['design_#'] || o.design_num || '';
  const pos = Array.isArray(o.print_positions) ? o.print_positions.join(' · ') : (o.print_positions || '');
  const woLink = (o.job_title_a && typeof o.job_title_a === 'object') ? o.job_title_a : null;

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
      <div className={`relative mx-auto my-6 w-[min(1180px,96vw)] rounded-2xl shadow-2xl ${panel}`}>
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
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-slate-500/10" aria-label="Cerrar la work order"><X className="w-5 h-5" /></button>
        </div>

        {/* Tres columnas */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 p-5">
          {/* Columna A: dónde se imprime */}
          <div className="space-y-4">
            <div>
              <h3 className="text-[10px] font-bold uppercase tracking-[0.15em] text-slate-400 mb-2">Dónde se imprime{pos ? ` · ${pos}` : ''}</h3>
              <div className="space-y-1.5">
                {check(o.art_sep_status, 'Separaciones listas')}
                {check(o.screens, 'Mallas listas')}
                {check(o.art_neck_status, 'Neck label listo')}
                {check(!!o.packing_link, 'Packing list importado')}
                {check(o.is_preorder, 'Preorden')}
              </div>
            </div>
            {woLink && woLink.url && (
              <div className={`rounded-lg border p-3 ${card}`}>
                <div className="text-[9px] font-bold uppercase tracking-[0.15em] text-slate-400 mb-1">Work order link</div>
                <a href={woLink.url} target="_blank" rel="noreferrer" className="text-[12px] text-blue-500 underline break-all">{woLink.desc || woLink.url}</a>
              </div>
            )}
          </div>

          {/* Columna B: tallas, estados, notas */}
          <div className="space-y-4">
            <div>
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

            <div>
              <h3 className="text-[10px] font-bold uppercase tracking-[0.15em] text-slate-400 mb-2">Estados</h3>
              <div className="flex flex-wrap gap-1.5">
                {estados.map(([lbl, val]) => (
                  <span key={lbl} className={`text-[11px] px-2 py-1 rounded ${card} border`}>
                    <b className="text-slate-400 font-bold mr-1">{lbl}</b>{val || '—'}
                  </span>
                ))}
              </div>
            </div>

            {o.notes && (
              <div>
                <h3 className="text-[10px] font-bold uppercase tracking-[0.15em] text-slate-400 mb-1">Notas de la orden</h3>
                <p className="text-[12.5px] whitespace-pre-wrap">{o.notes}</p>
              </div>
            )}
          </div>

          {/* Columna C: invoice + empaque */}
          <div className="space-y-4">
            <div>
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
                <Field label="Sample física">{o.sample_printavo}</Field>
                <Field label="Gemela" mono>{o.twin_order_number}</Field>
                <Field label="Nickname" mono full>{woLink ? woLink.desc : ''}</Field>
              </div>
            </div>

            <div>
              <h3 className="text-[10px] font-bold uppercase tracking-[0.15em] text-slate-400 mb-2">Instrucciones de empaque</h3>
              {woLines.length > 0 ? (
                <div className="space-y-1">
                  {woLines.map((line, idx) => (
                    <div key={idx} className={`flex gap-2 text-[12.5px] rounded px-2 py-1 ${card} border`}>
                      <span className="text-slate-400 font-mono w-5 shrink-0">{idx + 1}</span>
                      <span className="break-words">{line}</span>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-[12px] text-slate-400">Aún sin datos del work order. Se poblará con el sync (órdenes nuevas) y el backfill (históricas).</p>
              )}
              {wo.customer_note && (
                <div className="mt-3">
                  <div className="text-[9px] font-bold uppercase tracking-[0.15em] text-slate-400 mb-1">Special notes</div>
                  <p className="text-[12.5px] whitespace-pre-wrap">{wo.customer_note}</p>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
