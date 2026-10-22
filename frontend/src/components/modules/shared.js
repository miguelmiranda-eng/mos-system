import React, { useEffect, useRef, useState } from 'react';
import { ExternalLink, MessageSquare } from 'lucide-react';
import { API } from '../../lib/constants';
import { CommentsModal } from '../dashboard/CommentsModal';

// Piezas compartidas de los MÓDULOS que reemplazan tableros (Cuadros, Blanks…):
// llamada al API, fechas, avisos en vivo, mini tabla de
// componentes y enlace a Printavo. Backend: services/order_modules.py.

export const WS_URL = `${process.env.REACT_APP_BACKEND_URL || 'http://localhost:8000'}`.replace(/^http/, 'ws') + '/api/ws';
export const REFRESH_MS = 2 * 60 * 1000;

// Pestaña Programados: lo que el plan arranca en los próximos N días.
export const WINDOW_OPTIONS = [1, 2, 3, 5, 7];
export const readWindow = (key) => {
  try { const v = Number(localStorage.getItem(key)); return WINDOW_OPTIONS.includes(v) ? v : 3; } catch { return 3; }
};
export const saveWindow = (key, d) => {
  try { localStorage.setItem(key, String(d)); } catch { /* sin storage */ }
};

export function WindowSelect({ days, onChange, t }) {
  return (
    <label className="ml-auto inline-flex items-center gap-2 text-xs text-muted-foreground">
      {t('mod_window')}
      <select value={days} onChange={(e) => onChange(Number(e.target.value))}
        className="rounded-lg border border-border bg-card px-2 py-1.5 text-xs font-bold text-foreground">
        {WINDOW_OPTIONS.map((d) => <option key={d} value={d}>{t('mod_window_days', { n: d })}</option>)}
      </select>
    </label>
  );
}

export const call = async (path, opts = {}) => {
  const res = await fetch(`${API}${path}`, {
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    ...opts,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.detail || `HTTP ${res.status}`);
  return data;
};

export const fmtDay = (iso) => (iso ? new Date(iso.length > 10 ? iso : `${iso}T00:00:00`)
  .toLocaleDateString('es-MX', { weekday: 'short', day: '2-digit', month: 'short' }) : '—');
export const fmtTime = (iso) => (iso && iso.length > 10 ? iso.slice(11, 16) : '');
export const isOverdue = (iso) => iso && iso < new Date().toISOString().slice(0, 10);

// Un cambio de orden en cualquier pantalla → recarga (juntando ráfagas).
export function useOrderChangeReload(reloadRef) {
  const ref = useRef(reloadRef);
  ref.current = reloadRef;
  useEffect(() => {
    let ws; let timer; let retry; let disposed = false;
    const connect = () => {
      try {
        ws = new WebSocket(WS_URL);
        ws.onmessage = (e) => {
          try {
            const msg = JSON.parse(e.data);
            if (msg.type !== 'order_change') return;
            clearTimeout(timer);
            timer = setTimeout(() => ref.current.current?.(), 3000 + Math.random() * 4000);
          } catch { /* mensaje ajeno */ }
        };
        ws.onclose = () => { if (!disposed) retry = setTimeout(connect, 10000); };
      } catch {
        if (!disposed) retry = setTimeout(connect, 10000);
      }
    };
    connect();
    return () => { disposed = true; clearTimeout(timer); clearTimeout(retry); try { ws?.close(); } catch { /* */ } };
  }, []);
}

// Mini tabla de componentes (sólo lectura, los mismos campos del CRM).
// ok = ya no detiene la impresión; info = dato de la orden (Production Status).
const COMP_STYLE = {
  ok: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
  pending: 'border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-400',
  empty: 'border-border bg-secondary/50 text-muted-foreground',
  info: 'border-sky-500/40 bg-sky-500/10 text-sky-700 dark:text-sky-300',
};
const COMP_DOT = { ok: 'bg-emerald-500', pending: 'bg-amber-500', empty: 'bg-muted-foreground/40', info: 'bg-sky-500' };

// Una fila pareja: cada recuadro del mismo ancho, título y valor en UN renglón
// (el texto completo sale al pasar el cursor). Antes se apretaban y partían
// "PRODUCTION STATUS / sin dato" en tres renglones.
const COMP_COLS = { 4: 'sm:grid-cols-4', 5: 'sm:grid-cols-5', 6: 'sm:grid-cols-3 xl:grid-cols-6' };

export function Components({ items, t }) {
  if (!items?.length) return null;
  return (
    <div className={`mt-3 grid grid-cols-2 ${COMP_COLS[items.length] || 'sm:grid-cols-4'} gap-1.5`}>
      {items.map((c) => (
        <div key={c.key} className={`min-w-0 rounded-md border px-2 py-1.5 ${COMP_STYLE[c.state] || COMP_STYLE.empty}`}
          title={`${t(`scr_comp_${c.key}`)}: ${c.value || t('scr_comp_none')}`}>
          <div className="flex items-center gap-1.5 text-[10px] font-black uppercase tracking-wide min-w-0">
            <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${COMP_DOT[c.state] || COMP_DOT.empty}`} />
            <span className="truncate">{t(`scr_comp_${c.key}`)}</span>
          </div>
          <div className="text-xs font-bold leading-tight truncate mt-0.5">{c.value || t('scr_comp_none')}</div>
        </div>
      ))}
    </div>
  );
}

// ── Comentarios ─────────────────────────────────────────────────────────────
// Los comentarios viven pegados a la ORDEN (no al tablero): desde un módulo se
// leen y escriben los mismos que en el maestro, QC y máquina. El backend manda
// `comments` (cuántos) y `last_comment` en cada tarjeta (om.with_comments).

export function CommentsButton({ count, onClick, t, big }) {
  const has = count > 0;
  return (
    <button type="button" onClick={onClick} title={t('comments')}
      className={`inline-flex items-center gap-1 rounded-md border font-bold transition-colors
        ${big ? 'px-3 py-2 text-sm' : 'px-1.5 py-0.5 text-[11px]'}
        ${has ? 'border-sky-500/50 bg-sky-500/10 text-sky-700 dark:text-sky-300' : 'border-border text-muted-foreground hover:bg-secondary'}`}>
      <MessageSquare size={big ? 16 : 12} /> {has ? count : ''}
    </button>
  );
}

// [abrir(orden), ventana]: la ventana de comentarios de siempre (CommentsModal).
export function useComments(onClosed) {
  const [order, setOrder] = useState(null);
  const [user, setUser] = useState(null);
  useEffect(() => { call('/auth/me').then(setUser).catch(() => {}); }, []);
  const modal = (
    <CommentsModal order={order} isOpen={!!order} currentUser={user}
      onClose={() => { setOrder(null); onClosed?.(); }} />
  );
  return [setOrder, modal];
}

export function PrintavoLink({ url, t }) {
  if (!url) return null;
  return (
    <a href={url} target="_blank" rel="noopener noreferrer"
      className="inline-flex items-center gap-1 text-[11px] font-bold text-primary hover:underline"
      title={t('scr_printavo')}>
      <ExternalLink size={12} /> Printavo
    </a>
  );
}
