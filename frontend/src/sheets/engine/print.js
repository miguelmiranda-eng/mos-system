import { computeSheet, textoCalculado } from './compute';
import { getCell, getDisplayValue, findMerge, isMergedCovered } from './model';

/**
 * Imprime una hoja abriendo una ventana con una tabla HTML completa.
 *
 * La rejilla en pantalla esta VIRTUALIZADA (solo existen las celdas visibles),
 * asi que window.print() sobre ella imprimiria media hoja. Aqui se arma la tabla
 * entera —solo hasta la ultima celda con datos— con los valores de formula ya
 * resueltos, y se manda a imprimir esa.
 */
export function imprimirHoja(sheet, tituloLibro) {
  const computed = computeSheet(sheet);

  // Limite real: ultima fila/columna con algo escrito.
  let maxR = -1; let maxC = -1;
  for (const k of sheet.cells.keys()) {
    const i = k.indexOf(':');
    maxR = Math.max(maxR, +k.slice(0, i));
    maxC = Math.max(maxC, +k.slice(i + 1));
  }
  for (const m of sheet.merges || []) { maxR = Math.max(maxR, m.r2); maxC = Math.max(maxC, m.c2); }
  if (maxR < 0) { maxR = 0; maxC = 0; }

  const esc = (s) => String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  let filas = '';
  for (let r = 0; r <= maxR; r++) {
    let celdas = '';
    for (let c = 0; c <= maxC; c++) {
      if (isMergedCovered(sheet, r, c)) continue; // la tapa el anclaje
      const cell = getCell(sheet, r, c);
      const merge = findMerge(sheet, r, c);
      const rowspan = merge ? merge.r2 - merge.r1 + 1 : 1;
      const colspan = merge ? merge.c2 - merge.c1 + 1 : 1;
      const texto = cell ? esc(textoCalculado(cell, computed, `${r}:${c}`, getDisplayValue)) : '';
      const st = cell?.style || {};
      const estilos = [
        st.bold ? 'font-weight:bold' : '',
        st.italic ? 'font-style:italic' : '',
        st.underline ? 'text-decoration:underline' : '',
        st.align ? `text-align:${st.align}` : '',
        st.color ? `color:${st.color}` : '',
        st.fill ? `background:${st.fill}` : '',
      ].filter(Boolean).join(';');
      const span = (rowspan > 1 ? ` rowspan="${rowspan}"` : '') + (colspan > 1 ? ` colspan="${colspan}"` : '');
      celdas += `<td${span} style="${estilos}">${texto}</td>`;
    }
    filas += `<tr>${celdas}</tr>`;
  }

  const html = `<!doctype html><html><head><meta charset="utf-8">
    <title>${esc(tituloLibro || 'Hoja')} — ${esc(sheet.name)}</title>
    <style>
      body { font-family: Arial, sans-serif; font-size: 12px; margin: 16px; }
      h1 { font-size: 15px; margin: 0 0 12px; }
      table { border-collapse: collapse; }
      td { border: 1px solid #bbb; padding: 3px 6px; min-width: 40px; max-width: 240px;
           overflow: hidden; white-space: nowrap; }
      @media print { body { margin: 0; } }
    </style></head><body>
    <h1>${esc(tituloLibro || 'Hoja')} — ${esc(sheet.name)}</h1>
    <table>${filas}</table>
    <script>window.onload = function(){ window.print(); };</script>
    </body></html>`;

  const w = window.open('', '_blank');
  if (!w) return false;   // bloqueado por el navegador
  w.document.write(html);
  w.document.close();
  return true;
}
