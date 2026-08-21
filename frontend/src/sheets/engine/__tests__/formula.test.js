import { computeSheet } from '../compute';
import { makeSheet, makeCell } from '../model';
import { cellKey } from '../address';

// Arma una hoja a partir de un mapa { 'A1': '5', 'B1': '=A1*2', ... }
function hoja(celdas) {
  const s = makeSheet('H');
  for (const [dir, txt] of Object.entries(celdas)) {
    const m = /^([A-Z]+)(\d+)$/.exec(dir);
    const col = m[1].split('').reduce((a, c) => a * 26 + (c.charCodeAt(0) - 64), 0) - 1;
    const row = +m[2] - 1;
    const t = String(txt);
    s.cells.set(cellKey(row, col), t.startsWith('=') ? makeCell({ formula: t.slice(1) }) : makeCell({ value: t }));
  }
  return s;
}
function val(celdas, dir) {
  const s = hoja(celdas);
  const c = computeSheet(s);
  const m = /^([A-Z]+)(\d+)$/.exec(dir);
  const col = m[1].split('').reduce((a, ch) => a * 26 + (ch.charCodeAt(0) - 64), 0) - 1;
  const row = +m[2] - 1;
  const v = c.get(cellKey(row, col));
  if (v && v.code) return v.code;                  // FormulaError -> su codigo
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE'; // como se muestra
  return v;
}

describe('aritmetica y referencias', () => {
  test('referencia simple y operadores', () => {
    expect(val({ A1: '5', A2: '=A1*2' }, 'A2')).toBe(10);
    expect(val({ A1: '5', A2: '3', A3: '=A1+A2' }, 'A3')).toBe(8);
    expect(val({ A1: '=2+3*4' }, 'A1')).toBe(14);       // precedencia
    expect(val({ A1: '=(2+3)*4' }, 'A1')).toBe(20);      // parentesis
    expect(val({ A1: '=2^3^2' }, 'A1')).toBe(512);       // ^ asociativa a la derecha
    expect(val({ A1: '=-5+3' }, 'A1')).toBe(-2);         // unario
  });

  test('cadena de referencias', () => {
    expect(val({ A1: '2', A2: '=A1*2', A3: '=A2*2', A4: '=A3+1' }, 'A4')).toBe(9);
  });

  test('division por cero', () => {
    expect(val({ A1: '=1/0' }, 'A1')).toBe('#DIV/0!');
  });

  test('concatenacion con &', () => {
    expect(val({ A1: 'Hola', A2: 'Mundo', A3: '=A1&" "&A2' }, 'A3')).toBe('Hola Mundo');
  });

  test('referencia a celda vacia vale 0', () => {
    expect(val({ A1: '=B1+5' }, 'A1')).toBe(5);
  });
});

describe('funciones de agregacion', () => {
  const datos = { A1: '10', A2: '20', A3: '30', A4: '', A5: 'texto' };
  test('SUM de rango', () => {
    expect(val({ ...datos, B1: '=SUM(A1:A5)' }, 'B1')).toBe(60);
  });
  test('AVERAGE ignora vacias y texto', () => {
    expect(val({ ...datos, B1: '=AVERAGE(A1:A5)' }, 'B1')).toBe(20);
  });
  test('MIN y MAX', () => {
    expect(val({ ...datos, B1: '=MIN(A1:A3)' }, 'B1')).toBe(10);
    expect(val({ ...datos, B1: '=MAX(A1:A3)' }, 'B1')).toBe(30);
  });
  test('COUNT cuenta solo numeros, COUNTA cuenta no vacias', () => {
    expect(val({ ...datos, B1: '=COUNT(A1:A5)' }, 'B1')).toBe(3);
    expect(val({ ...datos, B1: '=COUNTA(A1:A5)' }, 'B1')).toBe(4);
  });
  test('SUM de argumentos sueltos', () => {
    expect(val({ A1: '=SUM(1,2,3,4)' }, 'A1')).toBe(10);
  });
});

describe('logica', () => {
  test('IF', () => {
    expect(val({ A1: '10', B1: '=IF(A1>5,"alto","bajo")' }, 'B1')).toBe('alto');
    expect(val({ A1: '3', B1: '=IF(A1>5,"alto","bajo")' }, 'B1')).toBe('bajo');
  });
  test('AND / OR', () => {
    expect(val({ A1: '=AND(TRUE,TRUE,FALSE)' }, 'A1')).toBe('FALSE');
    expect(val({ A1: '=OR(FALSE,TRUE)' }, 'A1')).toBe('TRUE');
  });
  test('comparaciones', () => {
    expect(val({ A1: '=5>3' }, 'A1')).toBe('TRUE');
    expect(val({ A1: '=5=5' }, 'A1')).toBe('TRUE');
    expect(val({ A1: '="a"="A"' }, 'A1')).toBe('TRUE');  // texto insensible a mayusculas
  });
  test('IFERROR atrapa el error', () => {
    expect(val({ A1: '=IFERROR(1/0,"ups")' }, 'A1')).toBe('ups');
  });
});

describe('texto', () => {
  test('CONCAT, LEN, UPPER, TRIM', () => {
    expect(val({ A1: '=CONCAT("a","b","c")' }, 'A1')).toBe('abc');
    expect(val({ A1: '=LEN("hola")' }, 'A1')).toBe(4);
    expect(val({ A1: '=UPPER("hola")' }, 'A1')).toBe('HOLA');
    expect(val({ A1: '=TRIM("  x  ")' }, 'A1')).toBe('x');
  });
});

describe('condicionales SUMIF / COUNTIF', () => {
  const datos = { A1: '5', A2: '15', A3: '25', A4: '8' };
  test('COUNTIF con comparador', () => {
    expect(val({ ...datos, B1: '=COUNTIF(A1:A4,">10")' }, 'B1')).toBe(2);
  });
  test('SUMIF con comparador', () => {
    expect(val({ ...datos, B1: '=SUMIF(A1:A4,">10")' }, 'B1')).toBe(40);
  });
  test('SUMIF con rango de suma separado', () => {
    const d = { A1: 'x', A2: 'y', A3: 'x', B1: '10', B2: '20', B3: '30' };
    expect(val({ ...d, C1: '=SUMIF(A1:A3,"x",B1:B3)' }, 'C1')).toBe(40);
  });
});

describe('errores', () => {
  test('funcion desconocida da #NAME?', () => {
    expect(val({ A1: '=NOEXISTE(1)' }, 'A1')).toBe('#NAME?');
  });
  test('referencia circular da #CYCLE!', () => {
    expect(val({ A1: '=B1', B1: '=A1' }, 'A1')).toBe('#CYCLE!');
  });
  test('auto-referencia da #CYCLE!', () => {
    expect(val({ A1: '=A1+1' }, 'A1')).toBe('#CYCLE!');
  });
  test('sintaxis rota da #VALUE!', () => {
    expect(val({ A1: '=1+' }, 'A1')).toBe('#VALUE!');
  });
});
