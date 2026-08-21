import React, { useState, useCallback, useRef, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { analizarFormula, buscarFunciones } from '../engine/functions';
import { toA1, normalizeRange, rangeToA1 } from '../engine/address';
import { useWorkbook } from '../store/useWorkbook';
import { cn } from '../../lib/utils';

/**
 * Asistente de fórmulas paso a paso, estilo Google Sheets, para un <input>.
 *
 * Da dos ayudas mientras se escribe una fórmula (texto que empieza con "="):
 *  1. Autocompletar: al teclear el nombre de una función muestra las que
 *     empiezan igual, con su resumen; con flechas se elige y con Tab/Enter se
 *     inserta "NOMBRE(" y el cursor queda listo para el primer argumento.
 *  2. Ayuda de sintaxis: dentro de los paréntesis muestra la firma de la
 *     función con el argumento ACTUAL resaltado y su descripción.
 *
 * El componente que use el input debe:
 *  - llamar `asist.onInput()` cuando cambie el texto o el cursor,
 *  - en su onKeyDown, llamar `asist.onKeyDown(e)` PRIMERO y salir si devuelve
 *    true (así el asistente se queda con las flechas/Enter/Tab/Escape),
 *  - renderizar `asist.overlay`.
 *
 * Uso el atributo data-formula-assist en el overlay para que el editor de celda
 * no confirme al hacer clic en una sugerencia (ese clic es "dentro" del asistente).
 */
export function useFormulaAssist(inputRef) {
  const [st, setSt] = useState({ sugerencias: [], activo: 0, firma: null, prefijo: '', rect: null });

  // ── Modo apuntar (point mode): construir referencias haciendo clic en celdas ──
  // spanRef = tramo [inicio,fin) del texto que ocupa la ultima referencia
  // insertada al hacer clic (la "referencia viva"). refAncla = celda donde
  // empezo el arrastre. nosotros = bandera para no borrar la ref viva cuando el
  // cambio de texto lo hicimos NOSOTROS (no el usuario tecleando).
  const spanRef = useRef(null);
  const refAncla = useRef(null);
  const nosotros = useRef(false);

  const escribir = useCallback((valor, caret) => {
    const el = inputRef.current;
    nosotros.current = true;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(el, valor);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.setSelectionRange(caret, caret);
    el.focus();
  }, [inputRef]);

  const onInput = useCallback(() => {
    const el = inputRef.current;
    if (!el) return;
    // Si el cambio vino del usuario (no de nosotros), la referencia viva ya no
    // se debe reemplazar al siguiente clic: se da por confirmada, y se apaga el
    // sombreado del rango referenciado.
    if (nosotros.current) nosotros.current = false;
    else {
      spanRef.current = null; refAncla.current = null;
      if (useWorkbook.getState().refHighlight) useWorkbook.setState({ refHighlight: null });
    }
    const val = el.value;
    const caret = el.selectionStart ?? val.length;
    const { prefijo, firma } = analizarFormula(val, caret);
    const sugerencias = prefijo ? buscarFunciones(prefijo) : [];
    setSt(prev => ({
      sugerencias, firma, prefijo,
      activo: prev.prefijo === prefijo ? Math.min(prev.activo, Math.max(0, sugerencias.length - 1)) : 0,
      rect: el.getBoundingClientRect(),
    }));
  }, [inputRef]);

  const insertar = useCallback((fn) => {
    const el = inputRef.current;
    if (!el) return;
    const val = el.value;
    const caret = el.selectionStart ?? val.length;
    const antes = val.slice(0, caret);
    const m = /([A-Za-z]+)$/.exec(antes);
    const inicio = m ? caret - m[1].length : caret;
    const nuevo = val.slice(0, inicio) + fn.nombre + '(' + val.slice(caret);
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(el, nuevo);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    const pos = inicio + fn.nombre.length + 1;
    el.setSelectionRange(pos, pos);
    el.focus();
    setTimeout(onInput, 0);   // recalcular para mostrar ya la firma
  }, [inputRef, onInput]);

  const onKeyDown = useCallback((e) => {
    if (st.sugerencias.length > 0) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setSt(s => ({ ...s, activo: (s.activo + 1) % s.sugerencias.length })); return true; }
      if (e.key === 'ArrowUp') { e.preventDefault(); setSt(s => ({ ...s, activo: (s.activo - 1 + s.sugerencias.length) % s.sugerencias.length })); return true; }
      if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); insertar(st.sugerencias[st.activo]); return true; }
      if (e.key === 'Escape') { e.preventDefault(); setSt(s => ({ ...s, sugerencias: [] })); return true; }
    }
    return false;
  }, [st, insertar]);

  const cerrar = useCallback(() => setSt(s => ({ ...s, sugerencias: [], firma: null })), []);

  // Insertor de referencias que la rejilla usa en modo apuntar. Estable (ref).
  const insertorRef = useRef(null);
  if (!insertorRef.current) {
    insertorRef.current = {
      // ¿El cursor está en un punto donde tiene sentido meter una referencia?
      enModoPunto() {
        const el = inputRef.current;
        if (!el) return false;
        const val = el.value;
        if (val[0] !== '=') return false;
        if (spanRef.current) return true; // hay referencia viva -> reemplazable
        const caret = el.selectionStart ?? val.length;
        const antes = val.slice(0, caret).replace(/\s+$/, '');
        if (antes === '=') return true;
        return '=(,+-*/^&<>:'.includes(antes[antes.length - 1]);
      },
      // Primer clic: inserta (o reemplaza la referencia viva) con una sola celda.
      puntoInicio(row, col) {
        const el = inputRef.current;
        const val = el.value;
        const a1 = toA1(row, col);
        refAncla.current = { row, col };
        if (spanRef.current) {
          const { inicio, fin } = spanRef.current;
          spanRef.current = { inicio, fin: inicio + a1.length };
          escribir(val.slice(0, inicio) + a1 + val.slice(fin), inicio + a1.length);
        } else {
          const caret = el.selectionStart ?? val.length;
          spanRef.current = { inicio: caret, fin: caret + a1.length };
          escribir(val.slice(0, caret) + a1 + val.slice(caret), caret + a1.length);
        }
        useWorkbook.setState({ refHighlight: { r1: row, c1: col, r2: row, c2: col } });
      },
      // Arrastre: extiende la referencia viva a un rango A1:B5.
      puntoExtiende(row, col) {
        if (!refAncla.current || !spanRef.current) return;
        const el = inputRef.current;
        const val = el.value;
        const rango = normalizeRange(refAncla.current, { row, col });
        const texto = rangeToA1(rango);
        const { inicio, fin } = spanRef.current;
        spanRef.current = { inicio, fin: inicio + texto.length };
        escribir(val.slice(0, inicio) + texto + val.slice(fin), inicio + texto.length);
        useWorkbook.setState({ refHighlight: rango });
      },
    };
  }

  // Registrar el insertor mientras el input tenga el foco. Solo el input
  // enfocado es el objetivo del modo apuntar.
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    const ins = insertorRef.current;
    const registrar = () => useWorkbook.setState({ refInsertor: ins });
    const quitar = () => useWorkbook.setState(s => (s.refInsertor === ins ? { refInsertor: null, refHighlight: null } : {}));
    el.addEventListener('focus', registrar);
    el.addEventListener('blur', quitar);
    if (document.activeElement === el) registrar();
    return () => { el.removeEventListener('focus', registrar); el.removeEventListener('blur', quitar); quitar(); };
  }, [inputRef]);

  const abierto = (st.sugerencias.length > 0 || st.firma) && st.rect;
  const overlay = abierto ? createPortal(
    <div
      data-formula-assist=""
      className="fixed z-[300]"
      style={{ left: st.rect.left, top: st.rect.bottom + 2, width: 320, maxWidth: '90vw' }}
    >
      {st.firma && <AyudaFirma firma={st.firma} />}
      {st.sugerencias.length > 0 && (
        <Sugerencias
          lista={st.sugerencias} activo={st.activo}
          onElegir={insertar}
          onHover={(i) => setSt(s => ({ ...s, activo: i }))}
        />
      )}
    </div>,
    document.body,
  ) : null;

  return { onInput, onKeyDown, overlay, cerrar };
}

/** Firma de la función con el argumento activo resaltado. */
function AyudaFirma({ firma }) {
  const { fn, argActivo } = firma;
  const argInfo = fn.args[Math.min(argActivo, fn.args.length - 1)];
  return (
    <div className="rounded-md border border-border bg-card shadow-lg p-2.5 mb-1 text-[12.5px]">
      <div className="font-mono text-foreground">
        {fn.nombre}(
        {fn.args.map((a, i) => (
          <React.Fragment key={i}>
            {i > 0 && ', '}
            <span className={cn(i === argActivo && 'bg-royal/20 text-royal font-semibold rounded px-0.5')}>
              {a.nombre}
            </span>
          </React.Fragment>
        ))}
        )
      </div>
      <div className="text-muted-foreground mt-1">{fn.resumen}</div>
      {argInfo && (
        <div className="mt-1.5 pt-1.5 border-t border-border">
          <span className="font-semibold text-foreground">{argInfo.nombre}:</span>{' '}
          <span className="text-muted-foreground">{argInfo.desc}</span>
        </div>
      )}
    </div>
  );
}

/** Lista de funciones que empiezan con lo tecleado. */
function Sugerencias({ lista, activo, onElegir, onHover }) {
  return (
    <div className="rounded-md border border-border bg-card shadow-lg overflow-hidden max-h-72 overflow-y-auto">
      {lista.map((fn, i) => (
        <button
          key={fn.nombre}
          // preventDefault en mousedown: el input no pierde el foco al hacer clic.
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => onElegir(fn)}
          onMouseEnter={() => onHover(i)}
          className={cn(
            'w-full text-left px-2.5 py-1.5 border-b border-border/50 last:border-0',
            i === activo ? 'bg-royal/15' : 'hover:bg-black/5 dark:hover:bg-white/5',
          )}
        >
          <div className="font-mono text-[12.5px] font-semibold text-foreground">{fn.nombre}</div>
          <div className="text-[11.5px] text-muted-foreground truncate">{fn.resumen}</div>
        </button>
      ))}
    </div>
  );
}
