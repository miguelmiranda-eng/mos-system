import { cumple, filasOcultasPorFiltro, valoresDistintos } from '../filter';
import { computeSheet } from '../compute';
import { makeSheet, makeCell, regionActual } from '../model';
import { cellKey } from '../address';

function hoja(columna) {
  // columna = array de valores para la columna A, fila 0 = encabezado
  const s = makeSheet('H');
  columna.forEach((v, r) => { if (v !== null) s.cells.set(cellKey(r, 0), makeCell({ value: String(v) })); });
  return s;
}

describe('cumple (matching de criterios)', () => {
  test('valores permitidos', () => {
    const c = { tipo: 'valores', permitidos: ['A', 'B'] };
    expect(cumple('A', c)).toBe(true);
    expect(cumple('C', c)).toBe(false);
  });
  test('condiciones de texto', () => {
    expect(cumple('Hola Mundo', { tipo: 'condicion', op: 'contiene', a: 'mundo' })).toBe(true);
    expect(cumple('Hola', { tipo: 'condicion', op: 'no_contiene', a: 'xyz' })).toBe(true);
    expect(cumple('Prosper', { tipo: 'condicion', op: 'empieza', a: 'Pro' })).toBe(true);
    expect(cumple('archivo.xlsx', { tipo: 'condicion', op: 'termina', a: '.xlsx' })).toBe(true);
    expect(cumple('', { tipo: 'condicion', op: 'vacio' })).toBe(true);
    expect(cumple('x', { tipo: 'condicion', op: 'no_vacio' })).toBe(true);
  });
  test('condiciones numericas', () => {
    expect(cumple('15', { tipo: 'condicion', op: 'mayor', a: '10' })).toBe(true);
    expect(cumple('5', { tipo: 'condicion', op: 'menor', a: '10' })).toBe(true);
    expect(cumple('10', { tipo: 'condicion', op: 'mayor_igual', a: '10' })).toBe(true);
    expect(cumple('7', { tipo: 'condicion', op: 'entre', a: '5', b: '10' })).toBe(true);
    expect(cumple('12', { tipo: 'condicion', op: 'entre', a: '5', b: '10' })).toBe(false);
  });
});

describe('filasOcultasPorFiltro', () => {
  test('oculta las filas que no cumplen el criterio de valores', () => {
    const s = hoja(['Cliente', 'Ana', 'Beto', 'Ana', 'Carla']);
    s.filter = { r1: 0, c1: 0, r2: 4, c2: 0, criterios: { 0: { tipo: 'valores', permitidos: ['Ana'] } } };
    const computed = computeSheet(s);
    const ocultas = filasOcultasPorFiltro(s, computed);
    // Filas 2 (Beto) y 4 (Carla) se ocultan; 1 y 3 (Ana) quedan.
    expect(ocultas.has(1)).toBe(false);
    expect(ocultas.has(2)).toBe(true);
    expect(ocultas.has(3)).toBe(false);
    expect(ocultas.has(4)).toBe(true);
    expect(ocultas.has(0)).toBe(false); // el encabezado nunca se oculta
  });

  test('condicion numerica oculta lo que no pasa', () => {
    const s = hoja(['Monto', '100', '50', '200', '25']);
    s.filter = { r1: 0, c1: 0, r2: 4, c2: 0, criterios: { 0: { tipo: 'condicion', op: 'mayor', a: '60' } } };
    const ocultas = filasOcultasPorFiltro(s, computeSheet(s));
    expect(ocultas.has(1)).toBe(false); // 100 > 60
    expect(ocultas.has(2)).toBe(true);  // 50
    expect(ocultas.has(3)).toBe(false); // 200
    expect(ocultas.has(4)).toBe(true);  // 25
  });

  test('sin criterios no oculta nada', () => {
    const s = hoja(['H', 'a', 'b']);
    s.filter = { r1: 0, c1: 0, r2: 2, c2: 0, criterios: {} };
    expect(filasOcultasPorFiltro(s, computeSheet(s)).size).toBe(0);
  });
});

describe('regionActual (detección de tabla contigua)', () => {
  test('desde una celda interior agarra toda la tabla contigua', () => {
    const s = makeSheet('H');
    // Tabla A1:C3 con datos; el resto vacio.
    const datos = { '0:0': 'H1', '0:1': 'H2', '0:2': 'H3', '1:0': 'a', '1:1': 'b', '1:2': 'c', '2:0': 'd', '2:1': 'e', '2:2': 'f' };
    for (const [k, v] of Object.entries(datos)) s.cells.set(k, makeCell({ value: v }));
    const reg = regionActual(s, 1, 1); // celda interior B2
    expect(reg).toEqual({ r1: 0, c1: 0, r2: 2, c2: 2 });
  });

  test('se detiene en la fila/columna vacía', () => {
    const s = makeSheet('H');
    // Tabla A1:B2, y un dato aislado en D5 (separado por vacios).
    for (const [k, v] of Object.entries({ '0:0': 'a', '0:1': 'b', '1:0': 'c', '1:1': 'd' })) s.cells.set(k, makeCell({ value: v }));
    s.cells.set('4:3', makeCell({ value: 'lejos' }));
    const reg = regionActual(s, 0, 0);
    expect(reg).toEqual({ r1: 0, c1: 0, r2: 1, c2: 1 }); // no alcanza D5
  });
});

describe('valoresDistintos', () => {
  test('devuelve valores unicos ordenados, sin el encabezado', () => {
    const s = hoja(['Producto', 'Gorra', 'Playera', 'Gorra', 'Sudadera']);
    const v = valoresDistintos(s, computeSheet(s), 0, 0, 4);
    expect(v).toEqual(['Gorra', 'Playera', 'Sudadera']);
  });
  test('numeros se ordenan como numeros', () => {
    const s = hoja(['N', '100', '20', '3']);
    const v = valoresDistintos(s, computeSheet(s), 0, 0, 3);
    expect(v).toEqual(['3', '20', '100']);
  });
});
