import { useState, useEffect, useRef, useCallback } from 'react';

/*
 * Tour guiado del tablero de órdenes. 100% aditivo: es una capa (overlay) y un
 * botón flotante; NO toca ninguna función existente del Dashboard. Enseña lo
 * básico a quien llega nuevo (cambiar un estatus, mover una orden, abrir el
 * detalle, capturar).
 *
 * Ancla los pasos a elementos reales por selector CSS:
 *   - data-tour="sidebar" | "search"  (atributos añadidos en la UI)
 *   - data-testid="captura-trigger" | "select-all-checkbox"
 *   - data-testid="column-header-production_status" | "column-header-order_number"
 * Si un ancla no existe en pantalla (columna oculta, etc.), el paso se centra.
 *
 * Texto bilingüe propio (es/en) para no tocar los diccionarios globales.
 */

const Z = 2147483000;
const SEEN_KEY = 'mos_tour_dash_v1';

const STEPS = [
  {
    center: true,
    es: { title: 'Bienvenido al tablero de órdenes', body: 'En un minuto te enseño lo básico: cómo cambiar un estatus, cómo mover una orden y dónde ver el detalle.' },
    en: { title: 'Welcome to the orders board', body: "In a minute you'll learn the basics: how to change a status, how to move an order, and where to see the detail." },
  },
  {
    sel: '[data-tour="sidebar"]', place: 'right',
    es: { title: 'Tu estación', body: 'Cada tablero es una estación: Blanks, Screens, Neck, tu máquina, Empaque… Elige el tuyo aquí.' },
    en: { title: 'Your station', body: 'Each board is a station: Blanks, Screens, Neck, your machine, Packing… Pick yours here.' },
  },
  {
    sel: '[data-tour="search"]', place: 'bottom',
    es: { title: 'Buscar', body: 'Filtra este tablero al escribir. Con Enter, la búsqueda abarca todos los tableros.' },
    en: { title: 'Search', body: 'Filters this board as you type. Press Enter to search across every board.' },
  },
  {
    sel: '[data-testid="column-header-production_status"]', place: 'bottom',
    es: { title: 'Cambiar un estatus', body: 'Los estados se editan en su celda, directo en la tabla. Cada cambio queda guardado en el historial de la orden.' },
    en: { title: 'Change a status', body: 'Statuses are edited right in their cell, in the table. Every change is saved to the order history.' },
  },
  {
    sel: '[data-testid="select-all-checkbox"]', place: 'bottom',
    es: { title: 'Mover en lote', body: 'Marca varias órdenes con la casilla para moverlas de tablero en bloque. El candado de Control de Calidad bloquea lo que no te toca.' },
    en: { title: 'Move in bulk', body: 'Check several orders to move them between boards at once. The Quality Control lock stops what isn’t yours to move.' },
  },
  {
    sel: '[data-testid="column-header-order_number"]', place: 'right',
    es: { title: 'El detalle de la orden', body: 'Toca el número de orden para abrir su detalle: comentarios, surtido, neck y los enlaces de la orden.' },
    en: { title: 'The order detail', body: 'Tap the order number to open its detail: comments, picking, neck and the order links.' },
  },
  {
    sel: '[data-testid="captura-trigger"]', place: 'bottom',
    es: { title: 'Captura en piso', body: 'Desde aquí capturas producción o neck label del día: unidades por talla, máquina y turno.' },
    en: { title: 'Shop-floor capture', body: 'From here you capture production or neck label for the day: units by size, machine and shift.' },
  },
  {
    center: true,
    es: { title: '¡Listo!', body: 'Eso es lo básico. Puedes repetir el tutorial con el botón de la esquina inferior derecha.' },
    en: { title: 'That’s it!', body: 'That’s the basics. You can replay the tutorial anytime from the button in the bottom-right corner.' },
  },
];

export default function GuidedTour({ lang = 'es', isDark = false }) {
  const [open, setOpen] = useState(false);
  const [idx, setIdx] = useState(0);
  const [rect, setRect] = useState(null); // bounding rect del ancla, o null = centrado
  const holeRef = useRef(null);
  const cardRef = useRef(null);

  const L = (step) => (lang === 'en' ? step.en : step.es);

  // Auto-abre la primera vez (una sola vez por navegador).
  useEffect(() => {
    let seen = false;
    try { seen = !!localStorage.getItem(SEEN_KEY); } catch { /* storage bloqueado: lo tratamos como no visto */ }
    if (!seen) {
      const t = setTimeout(() => setOpen(true), 700);
      return () => clearTimeout(t);
    }
    return undefined;
  }, []);

  const start = useCallback(() => { setIdx(0); setOpen(true); }, []);
  const stop = useCallback(() => {
    setOpen(false);
    try { localStorage.setItem(SEEN_KEY, '1'); } catch { /* no crítico */ }
  }, []);
  const next = useCallback(() => setIdx((i) => (i < STEPS.length - 1 ? i + 1 : i)), []);
  const prev = useCallback(() => setIdx((i) => (i > 0 ? i - 1 : 0)), []);

  // Posiciona el spotlight sobre el ancla del paso actual.
  const reposition = useCallback(() => {
    const step = STEPS[idx];
    if (!step || step.center || !step.sel) { setRect(null); return; }
    const el = document.querySelector(step.sel);
    if (!el) { setRect(null); return; }
    try { el.scrollIntoView({ block: 'center', inline: 'center' }); } catch { el.scrollIntoView(); }
    const r = el.getBoundingClientRect();
    setRect({ top: r.top, left: r.left, width: r.width, height: r.height });
  }, [idx]);

  useEffect(() => {
    if (!open) return undefined;
    const id = window.setTimeout(reposition, 90);
    window.addEventListener('resize', reposition);
    return () => { window.clearTimeout(id); window.removeEventListener('resize', reposition); };
  }, [open, idx, reposition]);

  // Teclado: Esc cierra, flechas navegan.
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); stop(); }
      else if (e.key === 'ArrowRight') { e.preventDefault(); if (idx < STEPS.length - 1) next(); else stop(); }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); prev(); }
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [open, idx, next, prev, stop]);

  const step = STEPS[idx];
  const launchBtn = (
    <button
      type="button"
      onClick={start}
      aria-label={lang === 'en' ? 'Open the guided tutorial' : 'Abrir el tutorial guiado'}
      style={{
        position: 'fixed', right: 16, bottom: 16, zIndex: Z - 2, border: 0, cursor: 'pointer',
        display: 'inline-flex', alignItems: 'center', gap: 7, padding: '11px 15px', borderRadius: 999,
        font: '600 13px/1 system-ui,-apple-system,Segoe UI,Roboto,sans-serif', color: '#fff',
        background: '#2563eb', boxShadow: '0 6px 20px rgba(2,8,23,.28)',
      }}
    >
      🎓 {lang === 'en' ? 'Tutorial' : 'Tutorial'}
    </button>
  );

  if (!open) return launchBtn;

  // Colores del card según tema.
  const cardBg = isDark ? '#0f172a' : '#ffffff';
  const cardFg = isDark ? '#e5e7eb' : '#0f172a';
  const cardLine = isDark ? '#1e293b' : '#e5e7eb';
  const sub = isDark ? '#94a3b8' : '#64748b';

  // Posición del card.
  const CARD_W = 330;
  let cardStyle;
  if (!rect) {
    cardStyle = { left: '50%', top: '50%', transform: 'translate(-50%,-50%)' };
  } else {
    const gap = 12;
    const place = step.place || 'bottom';
    let left = rect.left;
    let top = rect.top + rect.height + gap;
    if (place === 'right') { left = rect.left + rect.width + gap; top = rect.top; }
    else if (place === 'top') { top = rect.top - gap; }
    if (place === 'bottom') top = rect.top + rect.height + gap;
    // clamp horizontal
    left = Math.max(8, Math.min(left, window.innerWidth - CARD_W - 8));
    top = Math.max(8, Math.min(top, window.innerHeight - 220));
    cardStyle = { left, top };
  }

  const content = L(step);
  const last = idx === STEPS.length - 1;

  return (
    <>
      {launchBtn}
      {/* captura de clics (bloquea la UI mientras el tour está activo) */}
      <div style={{ position: 'fixed', inset: 0, zIndex: Z, background: 'transparent' }} />
      {/* spotlight: un hueco con sombra enorme alrededor */}
      {rect && (
        <div
          ref={holeRef}
          style={{
            position: 'fixed', zIndex: Z + 1, pointerEvents: 'none', borderRadius: 9,
            left: rect.left - 6, top: rect.top - 6, width: rect.width + 12, height: rect.height + 12,
            boxShadow: '0 0 0 3px #2563eb, 0 0 0 9999px rgba(8,15,30,.60)',
            transition: 'all .2s ease',
          }}
        />
      )}
      {!rect && (
        <div style={{ position: 'fixed', inset: 0, zIndex: Z + 1, pointerEvents: 'none', background: 'rgba(8,15,30,.55)' }} />
      )}
      {/* tarjeta */}
      <div
        ref={cardRef}
        role="dialog"
        aria-live="polite"
        style={{
          position: 'fixed', zIndex: Z + 2, width: CARD_W, maxWidth: 'calc(100vw - 24px)',
          background: cardBg, color: cardFg, border: `1px solid ${cardLine}`, borderRadius: 14,
          boxShadow: '0 18px 48px rgba(2,8,23,.34)', padding: '16px 16px 13px',
          font: '14px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif', ...cardStyle,
        }}
      >
        <h4 style={{ margin: '0 0 6px', fontSize: 16, fontWeight: 700 }}>{content.title}</h4>
        <p style={{ margin: '0 0 10px' }}>{content.body}</p>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 12, color: sub, marginRight: 'auto' }}>{idx + 1} / {STEPS.length}</span>
          {idx > 0 && (
            <button type="button" onClick={prev} style={btn(false, cardFg, cardLine)}>
              {lang === 'en' ? '← Back' : '← Atrás'}
            </button>
          )}
          {!last && (
            <button type="button" onClick={stop} style={{ ...btn(false, sub, 'transparent'), border: 0 }}>
              {lang === 'en' ? 'Skip' : 'Saltar'}
            </button>
          )}
          <button type="button" onClick={() => (last ? stop() : next())} style={btn(true)}>
            {last ? (lang === 'en' ? 'Done' : 'Terminar') : (lang === 'en' ? 'Next →' : 'Siguiente →')}
          </button>
        </div>
      </div>
    </>
  );
}

function btn(primary, fg, line) {
  if (primary) {
    return {
      border: '1px solid #2563eb', background: '#2563eb', color: '#fff',
      borderRadius: 9, padding: '7px 12px', font: '600 13px system-ui', cursor: 'pointer',
    };
  }
  return {
    border: `1px solid ${line}`, background: 'transparent', color: fg,
    borderRadius: 9, padding: '7px 12px', font: '600 13px system-ui', cursor: 'pointer',
  };
}
