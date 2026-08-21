import {
  colToLetters, lettersToCol, toA1, fromA1, normalizeRange, rangeToA1,
} from '../address';
import {
  makeWorkbook, makeSheet, makeCell, getCell, setCell, setCells,
  insertRows, deleteRows, insertCols, deleteCols,
  parseInput, formatValue, isNumeric, getDisplayValue, FORMATS,
} from '../model';
import {
  applyCommand, revertCommand,
  setCellsCommand, clearRangeCommand, formatRangeCommand,
  deleteRowsCommand, deleteSheetCommand, duplicateSheetCommand,
} from '../commands';
import { rangeToTSV, parseTSV, buildPasteEntries } from '../clipboard';

// Casos limite sobre todo: son los que rompen las hojas de calculo de verdad.

describe('direcciones A1', () => {
  test('columnas base 26 biyectiva', () => {
    expect(colToLetters(0)).toBe('A');
    expect(colToLetters(25)).toBe('Z');
    expect(colToLetters(26)).toBe('AA');   // el salto que rompe la base 26 posicional
    expect(colToLetters(51)).toBe('AZ');
    expect(colToLetters(701)).toBe('ZZ');
    expect(colToLetters(702)).toBe('AAA');
  });

  test('ida y vuelta en todo el rango util', () => {
    for (let c = 0; c < 300; c++) expect(lettersToCol(colToLetters(c))).toBe(c);
  });

  test('A1 con y sin anclas', () => {
    expect(fromA1('A1')).toEqual({ row: 0, col: 0 });
    expect(fromA1('$B$10')).toEqual({ row: 9, col: 1 });
    expect(fromA1('AA100')).toEqual({ row: 99, col: 26 });
  });

  test('entradas invalidas dan null, no basura', () => {
    expect(fromA1('')).toBeNull();
    expect(fromA1('1A')).toBeNull();
    expect(fromA1('A0')).toBeNull();      // Excel no tiene fila 0
    expect(fromA1('hola')).toBeNull();
    expect(lettersToCol('A1')).toBe(-1);
  });

  test('rango normaliza esquinas invertidas', () => {
    const r = normalizeRange({ row: 9, col: 5 }, { row: 2, col: 1 });
    expect(r).toEqual({ r1: 2, c1: 1, r2: 9, c2: 5 });
    expect(rangeToA1(r)).toBe('B3:F10');
  });

  test('rango de una celda se muestra sin dos puntos', () => {
    expect(rangeToA1({ r1: 0, c1: 0, r2: 0, c2: 0 })).toBe('A1');
  });
});

describe('modelo de celdas', () => {
  test('el mapa disperso no guarda celdas vacias', () => {
    let s = makeSheet('H');
    s = setCell(s, 0, 0, makeCell({ value: 'x' }));
    expect(s.cells.size).toBe(1);
    s = setCell(s, 0, 0, null);
    expect(s.cells.size).toBe(0);
  });

  test('escribir cadena vacia equivale a borrar', () => {
    let s = makeSheet('H');
    s = setCell(s, 1, 1, makeCell({ value: 'a' }));
    s = setCell(s, 1, 1, makeCell(parseInput('') || {}));
    expect(getCell(s, 1, 1)).toBeNull();
  });

  test('las funciones son puras: no mutan la hoja que reciben', () => {
    const s1 = makeSheet('H');
    const s2 = setCell(s1, 0, 0, makeCell({ value: 'a' }));
    expect(s1.cells.size).toBe(0);   // si esto falla, el undo es mentira
    expect(s2.cells.size).toBe(1);
    expect(s1).not.toBe(s2);
  });

  test('parseInput distingue formula de texto', () => {
    expect(parseInput('=SUM(A1:A2)')).toEqual({ value: null, formula: 'SUM(A1:A2)' });
    expect(parseInput('hola')).toEqual({ value: 'hola', formula: null });
    expect(parseInput('')).toBeNull();
  });

  test('NO convierte codigos con ceros a la izquierda', () => {
    // Numeros de parte como "01234" se destruirian al volverse 1234.
    const p = parseInput('01234');
    expect(p.value).toBe('01234');
    expect(getDisplayValue(makeCell(p))).toBe('01234');
  });

  test('isNumeric acepta decimales y notacion cientifica, rechaza texto', () => {
    expect(isNumeric('12')).toBe(true);
    expect(isNumeric('-3.5')).toBe(true);
    expect(isNumeric('1e3')).toBe(true);
    expect(isNumeric('12abc')).toBe(false);
    expect(isNumeric('')).toBe(false);
    expect(isNumeric(null)).toBe(false);
  });

  test('formato no rompe cuando el valor no es numero', () => {
    expect(formatValue('abc', FORMATS.CURRENCY)).toBe('abc');
    expect(formatValue('', FORMATS.NUMBER)).toBe('');
    expect(formatValue(null, FORMATS.PERCENT)).toBe('');
  });
});

describe('insertar y eliminar filas / columnas', () => {
  test('insertar filas desplaza lo que estaba debajo', () => {
    let s = makeSheet('H');
    s = setCell(s, 5, 0, makeCell({ value: 'abajo' }));
    s = setCell(s, 1, 0, makeCell({ value: 'arriba' }));
    s = insertRows(s, 3, 2);
    expect(getCell(s, 1, 0).value).toBe('arriba');   // antes del corte: no se mueve
    expect(getCell(s, 7, 0).value).toBe('abajo');    // despues: baja 2
    expect(getCell(s, 5, 0)).toBeNull();
  });

  test('eliminar filas se lleva su contenido y sube el resto', () => {
    let s = makeSheet('H');
    s = setCell(s, 3, 0, makeCell({ value: 'muere' }));
    s = setCell(s, 6, 0, makeCell({ value: 'vive' }));
    s = deleteRows(s, 3, 1);
    expect(getCell(s, 5, 0).value).toBe('vive');   // la 6 sube una posicion
    expect(getCell(s, 3, 0)).toBeNull();
    expect(s.cells.size).toBe(1);
  });

  test('insertar y eliminar columnas mueve tambien los anchos', () => {
    let s = makeSheet('H');
    s = setCell(s, 0, 4, makeCell({ value: 'e' }));
    s.colWidths.set(4, 200);
    s = insertCols(s, 2, 1);
    expect(getCell(s, 0, 5).value).toBe('e');
    expect(s.colWidths.get(5)).toBe(200);
    s = deleteCols(s, 2, 1);
    expect(getCell(s, 0, 4).value).toBe('e');
    expect(s.colWidths.get(4)).toBe(200);
  });
});

describe('comandos y undo/redo', () => {
  const wb0 = () => makeWorkbook();

  test('editar y deshacer devuelve el estado exacto', () => {
    const wb = wb0();
    const id = wb.activeSheetId;
    const cmd = setCellsCommand.create(wb, id, [
      { row: 0, col: 0, cell: makeCell({ value: 'hola' }) },
    ]);
    const despues = applyCommand(wb, cmd);
    expect(getCell(despues.sheets[0], 0, 0).value).toBe('hola');

    const revertido = revertCommand(despues, cmd);
    expect(getCell(revertido.sheets[0], 0, 0)).toBeNull();
  });

  test('sobrescribir y deshacer recupera el valor anterior, no lo borra', () => {
    let wb = wb0();
    const id = wb.activeSheetId;
    wb = applyCommand(wb, setCellsCommand.create(wb, id, [
      { row: 0, col: 0, cell: makeCell({ value: 'viejo' }) },
    ]));
    const cmd2 = setCellsCommand.create(wb, id, [
      { row: 0, col: 0, cell: makeCell({ value: 'nuevo' }) },
    ]);
    wb = applyCommand(wb, cmd2);
    expect(getCell(wb.sheets[0], 0, 0).value).toBe('nuevo');
    wb = revertCommand(wb, cmd2);
    expect(getCell(wb.sheets[0], 0, 0).value).toBe('viejo');
  });

  test('borrar un rango vacio no genera comando', () => {
    const wb = wb0();
    const cmd = clearRangeCommand.create(wb, wb.activeSheetId, { r1: 0, c1: 0, r2: 5, c2: 5 });
    expect(cmd).toBeNull();   // no debe gastar un paso de historial
  });

  test('formatear con el mismo formato no genera comando', () => {
    const wb = wb0();
    const cmd = formatRangeCommand.create(
      wb, wb.activeSheetId, { r1: 0, c1: 0, r2: 1, c2: 1 }, FORMATS.GENERAL,
    );
    expect(cmd).toBeNull();
  });

  test('eliminar filas y deshacer restaura el contenido perdido', () => {
    let wb = wb0();
    const id = wb.activeSheetId;
    wb = applyCommand(wb, setCellsCommand.create(wb, id, [
      { row: 2, col: 0, cell: makeCell({ value: 'importante' }) },
      { row: 4, col: 1, cell: makeCell({ value: 'abajo' }) },
    ]));
    const cmd = deleteRowsCommand.create(wb, id, 2, 1);
    wb = applyCommand(wb, cmd);
    expect(getCell(wb.sheets[0], 2, 0)).toBeNull();
    expect(getCell(wb.sheets[0], 3, 1).value).toBe('abajo');

    wb = revertCommand(wb, cmd);
    expect(getCell(wb.sheets[0], 2, 0).value).toBe('importante');
    expect(getCell(wb.sheets[0], 4, 1).value).toBe('abajo');
  });

  test('no se puede eliminar la unica hoja', () => {
    const wb = wb0();
    expect(deleteSheetCommand.create(wb, wb.activeSheetId)).toBeNull();
  });

  test('duplicar hoja copia los datos sin compartir el mapa', () => {
    let wb = wb0();
    const id = wb.activeSheetId;
    wb = applyCommand(wb, setCellsCommand.create(wb, id, [
      { row: 0, col: 0, cell: makeCell({ value: 'original' }) },
    ]));
    wb = applyCommand(wb, duplicateSheetCommand.create(wb, id));
    expect(wb.sheets).toHaveLength(2);
    expect(getCell(wb.sheets[1], 0, 0).value).toBe('original');

    // Escribir en la copia no debe tocar la original.
    wb = applyCommand(wb, setCellsCommand.create(wb, wb.sheets[1].id, [
      { row: 0, col: 0, cell: makeCell({ value: 'cambiado' }) },
    ]));
    expect(getCell(wb.sheets[0], 0, 0).value).toBe('original');
  });

  test('una cadena larga de cambios se deshace hasta el principio', () => {
    let wb = wb0();
    const id = wb.activeSheetId;
    const cmds = [];
    for (let i = 0; i < 50; i++) {
      const c = setCellsCommand.create(wb, id, [
        { row: i, col: 0, cell: makeCell({ value: `v${i}` }) },
      ]);
      cmds.push(c);
      wb = applyCommand(wb, c);
    }
    expect(wb.sheets[0].cells.size).toBe(50);
    for (let i = cmds.length - 1; i >= 0; i--) wb = revertCommand(wb, cmds[i]);
    expect(wb.sheets[0].cells.size).toBe(0);
  });
});

describe('portapapeles TSV', () => {
  test('copiar un rango produce TSV con tabuladores y saltos', () => {
    let s = makeSheet('H');
    s = setCells(s, [
      { row: 0, col: 0, cell: makeCell({ value: 'a' }) },
      { row: 0, col: 1, cell: makeCell({ value: 'b' }) },
      { row: 1, col: 0, cell: makeCell({ value: 'c' }) },
    ]);
    expect(rangeToTSV(s, { r1: 0, c1: 0, r2: 1, c2: 1 })).toBe('a\tb\nc\t');
  });

  test('las formulas se copian con el signo igual', () => {
    let s = makeSheet('H');
    s = setCell(s, 0, 0, makeCell({ formula: 'SUM(A1:A2)' }));
    expect(rangeToTSV(s, { r1: 0, c1: 0, r2: 0, c2: 0 })).toBe('=SUM(A1:A2)');
  });

  test('un valor con tabulador se entrecomilla y se recupera igual', () => {
    let s = makeSheet('H');
    s = setCell(s, 0, 0, makeCell({ value: 'con\ttab' }));
    const tsv = rangeToTSV(s, { r1: 0, c1: 0, r2: 0, c2: 0 });
    expect(parseTSV(tsv)[0][0]).toBe('con\ttab');
  });

  test('parseTSV respeta saltos de linea dentro de comillas', () => {
    const filas = parseTSV('a\t"linea1\nlinea2"\tb');
    expect(filas).toHaveLength(1);
    expect(filas[0]).toEqual(['a', 'linea1\nlinea2', 'b']);
  });

  test('parseTSV con comillas escapadas', () => {
    expect(parseTSV('"dijo ""hola"""')[0][0]).toBe('dijo "hola"');
  });

  test('un TSV terminado en salto no crea fila fantasma', () => {
    expect(parseTSV('a\nb\n')).toHaveLength(2);
  });

  test('pegar recorta lo que se sale de la hoja en vez de crecer', () => {
    const matriz = [['1', '2'], ['3', '4']];
    const entradas = buildPasteEntries(
      matriz, { r1: 9, c1: 0, r2: 9, c2: 1 }, { rows: 10, cols: 10 },
    );
    // Solo cabe la primera fila: la segunda caeria en la fila 10, inexistente.
    expect(entradas).toHaveLength(2);
    expect(entradas.every(e => e.row < 10)).toBe(true);
  });

  test('pegar una celda en un rango multiplo la repite, como Excel', () => {
    const entradas = buildPasteEntries(
      [['x']], { r1: 0, c1: 0, r2: 3, c2: 1 }, { rows: 100, cols: 10 },
    );
    expect(entradas).toHaveLength(8);   // 4 filas x 2 columnas
    expect(entradas.every(e => e.cell.value === 'x')).toBe(true);
  });

  test('pegar celdas vacias las borra en vez de escribir cadena vacia', () => {
    const entradas = buildPasteEntries(
      [['', 'b']], { r1: 0, c1: 0, r2: 0, c2: 1 }, { rows: 10, cols: 10 },
    );
    expect(entradas[0].cell).toBeNull();
    expect(entradas[1].cell.value).toBe('b');
  });
});
