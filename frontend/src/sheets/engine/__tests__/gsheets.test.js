import { esUrlGoogleSheets, idDeUrl } from '../gsheets';

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
