import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

// Filas "en ventana" para la rejilla del tablero: solo se montan las filas que
// caen en pantalla (+ un margen), no todas.
//
// Por qué así: la rejilla es CSS grid y cada fila son CELDAS sueltas (hijos
// directos del grid, sin elemento "fila"), todas de altura fija (ROW_H = h-11 =
// 44 px). El espacio de las filas no montadas se rellena con separadores de
// ancho completo y la barra de scroll queda idéntica. Medido 2026-10-02:
// FINAL BILL congelaba 0.5–0.7 s por cada lote de +200 filas y 1.8 s al borrar
// el filtro; BLANKS (agrupado) ~1.9 s al entrar con solo 185 órdenes.
//
// Dos modos:
//  - `items`: lista plana de órdenes (tableros sin agrupar).
//  - `entries`: encabezados de grupo + órdenes, en orden de pantalla
//    ({ h: <nodo>, key } | orden). Los encabezados se montan SIEMPRE (son
//    pocos y son sticky: deben existir para quedarse arriba al scrollear);
//    solo las filas entran en ventana. Los separadores cubren únicamente filas
//    omitidas (n × 44 px), así que el alto total es exacto aunque los
//    encabezados midan distinto; su altura real (medida en el DOM) solo se usa
//    para saber qué filas caen en pantalla.
//
// Vive en su propio componente para que el scroll re-renderice SOLO esto, no
// el Dashboard completo. La ventana se cuantiza para que un scroll normal no
// re-renderice en cada pixel.
const CHUNK = 10;          // filas (modo plano)
const OVERSCAN = 15;       // filas de margen arriba y abajo
const HEADER_GUESS = 40;   // px, hasta medir el encabezado real

const isHeader = (e) => e && e.h !== undefined;

export default function WindowedRows({ items, entries, renderRow, rowHeight, scrollRef }) {
  const mixed = Array.isArray(entries);
  const list = mixed ? entries : items;
  const anchorRef = useRef(null);
  const listRef = useRef(list);
  listRef.current = list;
  const headerH = useRef({});          // key -> alto medido
  const chunkPx = CHUNK * rowHeight;
  const marginPx = OVERSCAN * rowHeight;
  // Ventana en px relativos al inicio del cuerpo: [top, bottom).
  const [win, setWin] = useState({ top: 0, bottom: 60 * rowHeight });

  const compute = useCallback(() => {
    const sc = scrollRef.current;
    const an = anchorRef.current;
    let top = 0;
    let bottom = 60 * rowHeight;
    if (sc && an) {
      // Inicio del cuerpo dentro del contenido scrolleable (el ancla es el
      // primer hijo del cuerpo).
      const bodyTop = an.getBoundingClientRect().top - sc.getBoundingClientRect().top + sc.scrollTop;
      const y = sc.scrollTop - bodyTop;
      top = Math.max(0, Math.floor((y - marginPx) / chunkPx) * chunkPx);
      bottom = Math.ceil((y + sc.clientHeight + marginPx) / chunkPx) * chunkPx;
    }
    setWin(w => (w.top === top && w.bottom === bottom) ? w : { top, bottom });
  }, [scrollRef, rowHeight, chunkPx, marginPx]);

  // Recalcular cuando cambia la lista (filtro, cambio de tablero, plegar un
  // grupo, refetch).
  useLayoutEffect(() => { compute(); }, [list, compute]);

  // Medir los encabezados ya montados; si alguno cambió de alto, recalcular.
  useLayoutEffect(() => {
    if (!mixed) return;
    const sc = scrollRef.current;
    if (!sc) return;
    let changed = false;
    sc.querySelectorAll("[data-wh]").forEach(el => {
      const k = el.getAttribute("data-wh");
      const h = el.offsetHeight;
      if (h && headerH.current[k] !== h) { headerH.current[k] = h; changed = true; }
    });
    if (changed) compute();
  });

  useEffect(() => {
    const sc = scrollRef.current;
    if (!sc) return undefined;
    // Directo en el evento (sin requestAnimationFrame): el navegador ya limita
    // los eventos de scroll al ritmo de pintado, el cálculo es barato y setWin
    // solo re-renderiza al cambiar de bloque. Con rAF, una pestaña en segundo
    // plano dejaba la ventana vieja (zona en blanco al volver).
    sc.addEventListener("scroll", compute, { passive: true });
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(compute) : null;
    if (ro) ro.observe(sc);
    return () => {
      sc.removeEventListener("scroll", compute);
      if (ro) ro.disconnect();
    };
  }, [scrollRef, compute]);

  const out = [];
  out.push(
    <div key="__win_anchor" ref={anchorRef} data-grid-window-anchor="" aria-hidden="true"
      style={{ gridColumn: "1 / -1", height: 0 }} />
  );
  let skipped = 0;
  let spacerN = 0;
  const flush = () => {
    if (skipped > 0) {
      out.push(<div key={`__win_sp_${spacerN++}`} aria-hidden="true"
        style={{ gridColumn: "1 / -1", height: skipped * rowHeight }} />);
      skipped = 0;
    }
  };
  let y = 0;
  for (let i = 0; i < list.length; i++) {
    const e = list[i];
    if (mixed && isHeader(e)) {
      flush();
      out.push(e.h);
      y += headerH.current[e.key] || HEADER_GUESS;
      continue;
    }
    if (y + rowHeight > win.top && y < win.bottom) {
      flush();
      out.push(renderRow(e));
    } else {
      skipped++;
    }
    y += rowHeight;
  }
  flush();
  return <>{out}</>;
}

// Posición vertical (px desde el inicio del cuerpo) de la orden `orderId`
// dentro de una lista plana u `entries`. La usa el scroll a una orden
// resaltada cuando su fila todavía no está montada.
export function windowOffsetOf(list, orderId, rowHeight) {
  let y = 0;
  for (const e of list || []) {
    if (isHeader(e)) { y += HEADER_GUESS; continue; }
    if (e && e.order_id === orderId) return y;
    y += rowHeight;
  }
  return -1;
}
