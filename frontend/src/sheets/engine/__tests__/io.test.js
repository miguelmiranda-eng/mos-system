import * as XLSX from 'xlsx';
import { importarArchivo } from '../io';
import { makeWorkbook, makeCell, getCell } from '../model';
import { cellKey } from '../address';

/**
 * Import/export sobre datos reales en memoria. No se toca el disco: se arma un
 * XLSX con SheetJS, se envuelve en un File falso y se pasa por el importador.
 */

// File.arrayBuffer no existe en jsdom viejo; se aporta uno minimo.
function fakeFile(buf, name) {
  return {
    name,
    arrayBuffer: async () => buf,
  };
}

function construirXLSX(aoa, nombreHoja = 'Datos') {
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  XLSX.utils.book_append_sheet(wb, ws, nombreHoja);
  return XLSX.write(wb, { type: 'array', bookType: 'xlsx' });
}

describe('importar', () => {
  test('lee valores, tipos y nombre de hoja', async () => {
    const buf = construirXLSX([
      ['Producto', 'Cantidad'],
      ['Playera', 25],
      ['Gorra', 10],
    ], 'Inventario');
    const { sheets, errors } = await importarArchivo(fakeFile(buf, 'inv.xlsx'));

    expect(errors).toHaveLength(0);
    expect(sheets).toHaveLength(1);
    expect(sheets[0].name).toBe('Inventario');
    expect(getCell(sheets[0], 0, 0).value).toBe('Producto');
    expect(getCell(sheets[0], 1, 1).value).toBe(25);   // numero como numero
  });

  test('conserva las formulas del archivo', async () => {
    const wb = XLSX.utils.book_new();
    // SheetJS solo conserva la formula al escribir si la celda trae su valor.
    const ws = { A1: { t: 'n', v: 1 }, A2: { t: 'n', v: 2 },
      A3: { t: 'n', v: 3, f: 'SUM(A1:A2)' }, '!ref': 'A1:A3' };
    XLSX.utils.book_append_sheet(wb, ws, 'H');
    const buf = XLSX.write(wb, { type: 'array', bookType: 'xlsx' });

    const { sheets } = await importarArchivo(fakeFile(buf, 'f.xlsx'));
    expect(getCell(sheets[0], 2, 0).formula).toBe('SUM(A1:A2)');
  });

  test('un archivo corrupto no lanza excepcion (se maneja)', async () => {
    // SheetJS es muy tolerante: no revienta con basura, la interpreta como
    // puede. Lo que importamos verifica es que NO se propaga una excepcion.
    const basura = new Uint8Array([1, 2, 3, 4]).buffer;
    const res = await importarArchivo(fakeFile(basura, 'roto.xlsx'));
    expect(res).toHaveProperty('sheets');
    expect(res).toHaveProperty('errors');
    expect(Array.isArray(res.errors)).toBe(true);
  });

  test('varias hojas se importan todas', async () => {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['a']]), 'Uno');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['b']]), 'Dos');
    const buf = XLSX.write(wb, { type: 'array', bookType: 'xlsx' });
    const { sheets } = await importarArchivo(fakeFile(buf, 'multi.xlsx'));
    expect(sheets.map(s => s.name)).toEqual(['Uno', 'Dos']);
  });
});

describe('exportar (round-trip)', () => {
  // El exportador arma un workbook de SheetJS internamente; aqui se replica esa
  // conversion y se vuelve a leer, para probar que los datos sobreviven el viaje.
  test('valores y numeros sobreviven exportar -> importar', async () => {
    let modelo = makeWorkbook();
    const hoja = modelo.sheets[0];
    hoja.cells.set(cellKey(0, 0), makeCell({ value: 'Nombre' }));
    hoja.cells.set(cellKey(0, 1), makeCell({ value: 'Total' }));
    hoja.cells.set(cellKey(1, 0), makeCell({ value: 'Pedido A' }));
    hoja.cells.set(cellKey(1, 1), makeCell({ value: '1500' }));

    // Reconstruir con la misma logica del exportador (via SheetJS).
    const wb = XLSX.utils.book_new();
    const ws = {};
    for (const [k, cell] of hoja.cells) {
      const i = k.indexOf(':');
      const dir = XLSX.utils.encode_cell({ r: +k.slice(0, i), c: +k.slice(i + 1) });
      const n = Number(cell.value);
      ws[dir] = Number.isFinite(n) && String(cell.value).trim() !== ''
        ? { t: 'n', v: n } : { t: 's', v: String(cell.value) };
    }
    ws['!ref'] = 'A1:B2';
    XLSX.utils.book_append_sheet(wb, ws, 'Export');
    const buf = XLSX.write(wb, { type: 'array', bookType: 'xlsx' });

    const { sheets } = await importarArchivo({ name: 'x.xlsx', arrayBuffer: async () => buf });
    expect(getCell(sheets[0], 0, 0).value).toBe('Nombre');
    expect(getCell(sheets[0], 1, 1).value).toBe(1500);
  });
});
