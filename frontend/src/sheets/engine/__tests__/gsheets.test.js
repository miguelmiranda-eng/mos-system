import { esUrlGoogleSheets, idDeUrl, importarGoogleSheet, guardarEnGoogle } from '../gsheets';
import { getCell } from '../model';

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

describe('guardarEnGoogle arma y manda el payload correcto', () => {
  afterEach(() => { delete global.fetch; });

  test('POST a /gsheets/write con nombre de pestaña y matriz de valores', async () => {
    global.fetch = jest.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => RESPUESTA_READ })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ ok: true, written: 1, skipped: [] }) });

    const wb = await importarGoogleSheet(RESPUESTA_READ.googleUrl);
    const res = await guardarEnGoogle(wb);

    expect(res.ok).toBe(true);
    const [urlWrite, opciones] = global.fetch.mock.calls[1];
    expect(String(urlWrite)).toMatch(/\/gsheets\/write$/);
    expect(opciones.method).toBe('POST');
    expect(opciones.credentials).toBe('include');

    const payload = JSON.parse(opciones.body);
    expect(payload.googleId).toBe('GID123');
    expect(payload.sheets[0].name).toBe('PACKING LIST');
    expect(payload.sheets[0].values[0][0]).toBe('VENDOR PO');
    expect(payload.sheets[0].values[2][1]).toBe('Garment Type');
    // La matriz llega hasta la ultima celda CON CONTENIDO (fila 2). La celda de
    // solo-estilo en (5,3) no la estira: estilo sin valor no viaja a Google.
    expect(payload.sheets[0].values.length).toBe(3);
  });

  test('un libro que no vino de Google no intenta escribir', async () => {
    const res = await guardarEnGoogle({ sheets: [] });
    expect(res.ok).toBe(false);
  });
});
