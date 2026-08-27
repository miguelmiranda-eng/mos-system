import { esUrlGoogleSheets, idDeUrl, importarGoogleSheet, guardarEnGoogle, partirEnBloques, diferencias } from '../gsheets';
import { getCell, makeCell } from '../model';
import { cellKey } from '../address';

describe('deteccion de URLs de Google Sheets', () => {
  test('reconoce enlaces de Google Sheets', () => {
    expect(esUrlGoogleSheets('https://docs.google.com/spreadsheets/d/ABC123/edit#gid=0')).toBe(true);
    expect(esUrlGoogleSheets('https://docs.google.com/spreadsheets/d/ABC123/edit?usp=sharing')).toBe(true);
    expect(esUrlGoogleSheets('docs.google.com/spreadsheets/d/ABC/edit')).toBe(true);
  });

  test('rechaza lo que no es Google Sheets', () => {
    expect(esUrlGoogleSheets('https://drive.google.com/file/d/abc/view')).toBe(false);
    expect(esUrlGoogleSheets('https://prosper-mfg.printavo.com/work_orders/1')).toBe(false);
    expect(esUrlGoogleSheets('')).toBe(false);
    expect(esUrlGoogleSheets(null)).toBe(false);
  });

  test('extrae el id del spreadsheet de varias formas de URL', () => {
    expect(idDeUrl('https://docs.google.com/spreadsheets/d/1AbC_dEf-123/edit#gid=0')).toBe('1AbC_dEf-123');
    expect(idDeUrl('https://docs.google.com/spreadsheets/d/XYZ789/edit?usp=sharing')).toBe('XYZ789');
    expect(idDeUrl('https://ejemplo.com/otra')).toBeNull();
  });
});

// Respuesta como la arma el backend (routers/gsheets.py /read) con formato.
const RESPUESTA_READ = {
  name: 'PACKING 3003',
  googleId: 'GID123',
  googleUrl: 'https://docs.google.com/spreadsheets/d/GID123/edit',
  sheets: [{
    name: 'PACKING LIST',
    values: [
      ['VENDOR PO', '3003'],
      ['', ''],
      ['STORE PO', 'Garment Type'],
    ],
    formats: [
      { r: 0, c: 0, bold: true, fill: '#ffff00' },
      { r: 2, c: 1, align: 'center', color: '#ff0000', wrap: true },
      { r: 5, c: 3, fill: '#00ff00' },          // celda con estilo SIN valor
    ],
    merges: [{ r1: 0, c1: 0, r2: 0, c2: 3 }],
    colWidths: { 0: 140, 2: 60 },
  }],
};

describe('importarGoogleSheet aplica contenido y formato', () => {
  afterEach(() => { delete global.fetch; });

  test('valores, estilos, combinadas y anchos llegan al modelo', async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => RESPUESTA_READ });
    const wb = await importarGoogleSheet(RESPUESTA_READ.googleUrl);

    expect(wb.googleId).toBe('GID123');
    const hoja = wb.sheets[0];
    expect(hoja.name).toBe('PACKING LIST');

    // Valores.
    expect(getCell(hoja, 0, 0).value).toBe('VENDOR PO');
    expect(getCell(hoja, 0, 1).value).toBe('3003');

    // Estilo fusionado sobre celda con valor.
    expect(getCell(hoja, 0, 0).style).toEqual({ bold: true, fill: '#ffff00' });
    expect(getCell(hoja, 2, 1).style).toEqual({ align: 'center', color: '#ff0000', wrap: true });

    // Celda que SOLO tiene estilo (cabecera de color sin texto).
    expect(getCell(hoja, 5, 3).value).toBeNull();
    expect(getCell(hoja, 5, 3).style).toEqual({ fill: '#00ff00' });

    // Combinadas y anchos.
    expect(hoja.merges).toEqual([{ r1: 0, c1: 0, r2: 0, c2: 3 }]);
    expect(hoja.colWidths.get(0)).toBe(140);
    expect(hoja.colWidths.get(2)).toBe(60);

    // El diagnostico reporta cuantos estilos entraron.
    expect(wb._info.estilos).toBe(3);
    expect(wb._info.formatoError).toBeNull();
  });

  test('sin formats/merges/colWidths (backend viejo) abre igual solo con valores', async () => {
    const sinFormato = {
      ...RESPUESTA_READ,
      sheets: [{ name: 'PACKING LIST', values: [['A', 'B']] }],
    };
    global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => sinFormato });
    const wb = await importarGoogleSheet(RESPUESTA_READ.googleUrl);
    expect(getCell(wb.sheets[0], 0, 0).value).toBe('A');
    expect(wb.sheets[0].merges).toEqual([]);
  });
});

describe('guardarEnGoogle escribe SOLO las diferencias', () => {
  afterEach(() => { delete global.fetch; });

  test('una celda editada viaja como update con su rango A1; lo demas no se toca', async () => {
    global.fetch = jest.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => RESPUESTA_READ })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ ok: true, updatedCells: 1, skipped: [], spreadsheetTitle: 'PACKING 3003' }) });

    const wb = await importarGoogleSheet(RESPUESTA_READ.googleUrl);
    // El origen quedo guardado para el diff.
    expect(wb.origenGoogle['PACKING LIST'][0][0]).toBe('VENDOR PO');

    // El usuario edita UNA celda (E1) y guarda.
    wb.sheets[0].cells.set(cellKey(0, 4), makeCell({ value: 'hola mundo' }));
    const res = await guardarEnGoogle(wb);

    expect(res.ok).toBe(true);
    expect(res.updatedCells).toBe(1);
    const [urlWrite, opciones] = global.fetch.mock.calls[1];
    expect(String(urlWrite)).toMatch(/\/gsheets\/write$/);
    expect(opciones.method).toBe('POST');
    expect(opciones.credentials).toBe('include');

    const payload = JSON.parse(opciones.body);
    expect(payload.googleId).toBe('GID123');
    expect(payload.sheets).toEqual([{
      name: 'PACKING LIST',
      // Solo la celda cambiada: las protegidas de la plantilla no se tocan.
      updates: [{ a1: 'E1:E1', values: [['hola mundo']] }],
    }]);

    // El nuevo origen ya refleja el cambio: guardar de nuevo = sin cambios.
    expect(res.nuevoOrigen['PACKING LIST'][0][4]).toBe('hola mundo');
  });

  test('sin cambios no manda NINGUNA peticion y avisa sinCambios', async () => {
    global.fetch = jest.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => RESPUESTA_READ });
    const wb = await importarGoogleSheet(RESPUESTA_READ.googleUrl);
    const res = await guardarEnGoogle(wb);
    expect(res.ok).toBe(true);
    expect(res.sinCambios).toBe(true);
    expect(global.fetch).toHaveBeenCalledTimes(1);   // solo la lectura
  });

  test('un libro que no vino de Google no intenta escribir', async () => {
    const res = await guardarEnGoogle({ sheets: [] });
    expect(res.ok).toBe(false);
  });
});

describe('diferencias (diff de matrices en corridas A1)', () => {
  test('cambios contiguos en una fila salen como UNA corrida', () => {
    const base = [['a', 'b', 'c', 'd']];
    const cur = [['a', 'X', 'Y', 'd']];
    expect(diferencias(cur, base)).toEqual([
      { a1: 'B1:C1', values: [['X', 'Y']] },
    ]);
  });

  test('borrar una celda viaja como cadena vacia (limpia en Google)', () => {
    expect(diferencias([['a']], [['a', 'b']])).toEqual([
      { a1: 'B1:B1', values: [['']] },
    ]);
  });

  test('filas nuevas mas alla del origen tambien viajan', () => {
    expect(diferencias([[], ['x']], [])).toEqual([
      { a1: 'A2:A2', values: [['x']] },
    ]);
  });

  test('sin cambios -> sin updates', () => {
    expect(diferencias([['a', 'b']], [['a', 'b']])).toEqual([]);
  });
});

describe('partirEnBloques (el proxy corta los POST de ~1MB)', () => {
  const fila = (txt) => [txt, 'x'.repeat(30)];

  test('una matriz chica queda en un solo bloque desde la fila 0', () => {
    const m = [fila('a'), fila('b')];
    expect(partirEnBloques(m)).toEqual([{ startRow: 0, values: m }]);
  });

  test('una matriz grande se parte y los offsets rearman la matriz original', () => {
    const m = Array.from({ length: 50 }, (_, i) => fila(`r${i}`));
    const bloques = partirEnBloques(m, 200);   // limite artificialmente chico
    expect(bloques.length).toBeGreaterThan(1);

    // Cada bloque respeta el limite y arranca donde termino el anterior.
    let esperado = 0;
    const rearmada = [];
    for (const b of bloques) {
      expect(JSON.stringify(b.values).length).toBeLessThanOrEqual(200 + 80);
      expect(b.startRow).toBe(esperado);
      esperado += b.values.length;
      rearmada.push(...b.values);
    }
    expect(rearmada).toEqual(m);
  });

  test('una fila sola mas grande que el limite viaja igual (bloque de una fila)', () => {
    const m = [ ['y'.repeat(500)], fila('b') ];
    const bloques = partirEnBloques(m, 200);
    expect(bloques[0]).toEqual({ startRow: 0, values: [m[0]] });
    expect(bloques[1]).toEqual({ startRow: 1, values: [m[1]] });
  });
});
