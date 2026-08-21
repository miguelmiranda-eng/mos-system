import { useEffect } from 'react';
import { useWorkbook } from '../store/useWorkbook';

/**
 * Teclado y portapapeles de la hoja.
 *
 * Se escucha en `window` y no en la rejilla porque el usuario espera que Ctrl+Z
 * funcione tenga el foco donde tenga —la barra de formulas, una pestana— y
 * porque los eventos `copy`/`paste` del navegador solo llegan al documento.
 *
 * El editor de celda y la barra de formulas hacen stopPropagation en su
 * onKeyDown, asi que mientras se escribe estas teclas no llegan aqui.
 */
export function useKeyboard(activo = true) {
  useEffect(() => {
    if (!activo) return;

    const enCampoDeTexto = (t) => {
      const tag = t?.tagName;
      return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || t?.isContentEditable;
    };

    const onKeyDown = (e) => {
      const st = useWorkbook.getState();
      if (st.editing) return;                      // lo maneja el editor
      if (enCampoDeTexto(e.target)) return;        // no secuestrar otros campos

      const ctrl = e.ctrlKey || e.metaKey;

      if (ctrl) {
        switch (e.key.toLowerCase()) {
          case 'z':
            e.preventDefault();
            // Ctrl+Shift+Z tambien rehace: es lo que espera quien viene de
            // Google Sheets, y no cuesta nada soportarlo.
            if (e.shiftKey) st.redo(); else st.undo();
            return;
          case 'y': e.preventDefault(); st.redo(); return;
          case 'a': e.preventDefault(); st.seleccionarTodo(); return;
          case 'b': e.preventDefault(); st.alternarEstilo('bold'); return;
          case 'i': e.preventDefault(); st.alternarEstilo('italic'); return;
          case 'u': e.preventDefault(); st.alternarEstilo('underline'); return;
          default: break;
        }
        return;   // otros atajos del navegador siguen su curso
      }

      switch (e.key) {
        case 'ArrowUp':    e.preventDefault(); st.mover(-1, 0, e.shiftKey); return;
        case 'ArrowDown':  e.preventDefault(); st.mover(1, 0, e.shiftKey); return;
        case 'ArrowLeft':  e.preventDefault(); st.mover(0, -1, e.shiftKey); return;
        case 'ArrowRight': e.preventDefault(); st.mover(0, 1, e.shiftKey); return;
        case 'Tab':        e.preventDefault(); st.mover(0, e.shiftKey ? -1 : 1); return;
        case 'Enter':
          e.preventDefault();
          st.empezarEdicion(st.active.row, st.active.col);
          return;
        case 'F2':
          e.preventDefault();
          st.empezarEdicion(st.active.row, st.active.col);
          return;
        case 'Delete':
        case 'Backspace':
          e.preventDefault();
          st.borrarSeleccion();
          return;
        case 'Escape':
          st.cancelarEdicion();
          return;
        default: break;
      }

      // Escribir directamente reemplaza la celda, como en Excel. Se filtran las
      // teclas de control (F5, Shift, etc.) por longitud del nombre.
      if (e.key.length === 1 && !e.altKey) {
        st.empezarEdicion(st.active.row, st.active.col);
        // No se hace preventDefault: el caracter cae en el input recien montado.
      }
    };

    const onCopy = (e) => {
      const st = useWorkbook.getState();
      if (st.editing || enCampoDeTexto(e.target)) return;
      e.preventDefault();
      e.clipboardData.setData('text/plain', st.copiarTexto());
    };

    const onCut = (e) => {
      const st = useWorkbook.getState();
      if (st.editing || enCampoDeTexto(e.target)) return;
      e.preventDefault();
      e.clipboardData.setData('text/plain', st.cortar());
    };

    const onPaste = (e) => {
      const st = useWorkbook.getState();
      if (st.editing || enCampoDeTexto(e.target)) return;
      e.preventDefault();
      st.pegarTexto(e.clipboardData.getData('text/plain'));
    };

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('copy', onCopy);
    window.addEventListener('cut', onCut);
    window.addEventListener('paste', onPaste);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('copy', onCopy);
      window.removeEventListener('cut', onCut);
      window.removeEventListener('paste', onPaste);
    };
  }, [activo]);
}
