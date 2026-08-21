import {
  makeWorkbook, makeCell, getCell, findMerge, isMergedCovered, showAllCols,
  setRowHeight, getRowHeight, getColWidth, toggleColHidden,
} from '../model';
import {
  applyCommand, revertCommand,
  mergeCommand, unmergeCommand, sortRangeCommand, resizeRowCommand,
  resizeColsCommand, resizeRowsCommand,
  showAllColsCommand, styleRangeCommand, setCellsCommand,
} from '../commands';

const wb0 = () => makeWorkbook();

describe('combinar celdas', () => {
  test('combinar conserva la esquina y borra el resto', () => {
    let wb = wb0();
    const id = wb.activeSheetId;
    wb = applyCommand(wb, setCellsCommand.create(wb, id, [
      { row: 0, col: 0, cell: makeCell({ value: 'titulo' }) },
      { row: 0, col: 1, cell: makeCell({ value: 'se borra' }) },
    ]));
    const cmd = mergeCommand.create(wb, id, { r1: 0, c1: 0, r2: 0, c2: 2 });
    wb = applyCommand(wb, cmd);

    expect(getCell(wb.sheets[0], 0, 0).value).toBe('titulo');
    expect(getCell(wb.sheets[0], 0, 1)).toBeNull();
    expect(findMerge(wb.sheets[0], 0, 2)).toBeTruthy();
    expect(isMergedCovered(wb.sheets[0], 0, 1)).toBe(true);
    expect(isMergedCovered(wb.sheets[0], 0, 0)).toBe(false);   // el anclaje no
  });

  test('deshacer combinar restaura celdas y quita la combinacion', () => {
    let wb = wb0();
    const id = wb.activeSheetId;
    wb = applyCommand(wb, setCellsCommand.create(wb, id, [
      { row: 0, col: 1, cell: makeCell({ value: 'vuelve' }) },
    ]));
    const cmd = mergeCommand.create(wb, id, { r1: 0, c1: 0, r2: 0, c2: 2 });
    wb = applyCommand(wb, cmd);
    wb = revertCommand(wb, cmd);
    expect(getCell(wb.sheets[0], 0, 1).value).toBe('vuelve');
    expect(wb.sheets[0].merges).toHaveLength(0);
  });

  test('combinar una sola celda no hace nada', () => {
    const wb = wb0();
    expect(mergeCommand.create(wb, wb.activeSheetId, { r1: 1, c1: 1, r2: 1, c2: 1 })).toBeNull();
  });

  test('separar quita la combinacion del rango', () => {
    let wb = wb0();
    const id = wb.activeSheetId;
    wb = applyCommand(wb, mergeCommand.create(wb, id, { r1: 0, c1: 0, r2: 1, c2: 1 }));
    const cmd = unmergeCommand.create(wb, id, { r1: 0, c1: 0, r2: 1, c2: 1 });
    wb = applyCommand(wb, cmd);
    expect(wb.sheets[0].merges).toHaveLength(0);
  });

  test('combinaciones que se cruzan no se acumulan', () => {
    let wb = wb0();
    const id = wb.activeSheetId;
    wb = applyCommand(wb, mergeCommand.create(wb, id, { r1: 0, c1: 0, r2: 1, c2: 1 }));
    // Una segunda que solapa reemplaza la anterior, no queda ambiguo.
    wb = applyCommand(wb, mergeCommand.create(wb, id, { r1: 0, c1: 0, r2: 0, c2: 2 }));
    expect(wb.sheets[0].merges).toHaveLength(1);
  });
});

describe('ordenar', () => {
  const conValores = (valores) => {
    let wb = wb0();
    const id = wb.activeSheetId;
    const entradas = valores.map((v, i) => ({ row: i, col: 0, cell: makeCell({ value: v }) }));
    wb = applyCommand(wb, setCellsCommand.create(wb, id, entradas));
    return { wb, id };
  };

  test('ascendente numerico ordena de menor a mayor', () => {
    const { wb, id } = conValores(['30', '10', '20']);
    const cmd = sortRangeCommand.create(wb, id, { r1: 0, c1: 0, r2: 2, c2: 0 }, true);
    const res = applyCommand(wb, cmd);
    expect([0, 1, 2].map(r => getCell(res.sheets[0], r, 0).value)).toEqual(['10', '20', '30']);
  });

  test('descendente invierte el orden', () => {
    const { wb, id } = conValores(['a', 'c', 'b']);
    const cmd = sortRangeCommand.create(wb, id, { r1: 0, c1: 0, r2: 2, c2: 0 }, false);
    const res = applyCommand(wb, cmd);
    expect([0, 1, 2].map(r => getCell(res.sheets[0], r, 0).value)).toEqual(['c', 'b', 'a']);
  });

  test('las celdas vacias van al final', () => {
    const { wb, id } = conValores(['b', '', 'a']);
    const cmd = sortRangeCommand.create(wb, id, { r1: 0, c1: 0, r2: 2, c2: 0 }, true);
    const res = applyCommand(wb, cmd);
    expect(getCell(res.sheets[0], 0, 0).value).toBe('a');
    expect(getCell(res.sheets[0], 1, 0).value).toBe('b');
    // La vacia queda al final; sigue siendo una celda, con valor vacio.
    expect(getCell(res.sheets[0], 2, 0)?.value ?? '').toBe('');
  });

  test('ordenar arrastra las columnas vecinas de la misma fila', () => {
    let wb = wb0();
    const id = wb.activeSheetId;
    wb = applyCommand(wb, setCellsCommand.create(wb, id, [
      { row: 0, col: 0, cell: makeCell({ value: '2' }) },
      { row: 0, col: 1, cell: makeCell({ value: 'dos' }) },
      { row: 1, col: 0, cell: makeCell({ value: '1' }) },
      { row: 1, col: 1, cell: makeCell({ value: 'uno' }) },
    ]));
    const cmd = sortRangeCommand.create(wb, id, { r1: 0, c1: 0, r2: 1, c2: 1 }, true);
    const res = applyCommand(wb, cmd);
    expect(getCell(res.sheets[0], 0, 0).value).toBe('1');
    expect(getCell(res.sheets[0], 0, 1).value).toBe('uno');   // la vecina viajo con su fila
  });

  test('ordenar y deshacer restaura el orden original', () => {
    const { wb, id } = conValores(['3', '1', '2']);
    const cmd = sortRangeCommand.create(wb, id, { r1: 0, c1: 0, r2: 2, c2: 0 }, true);
    let res = applyCommand(wb, cmd);
    res = revertCommand(res, cmd);
    expect([0, 1, 2].map(r => getCell(res.sheets[0], r, 0).value)).toEqual(['3', '1', '2']);
  });
});

describe('estilos ricos', () => {
  test('color, relleno, fuente y tamano se guardan juntos', () => {
    let wb = wb0();
    const id = wb.activeSheetId;
    const range = { r1: 0, c1: 0, r2: 0, c2: 0 };
    wb = applyCommand(wb, styleRangeCommand.create(wb, id, range, { color: '#ff0000' }));
    wb = applyCommand(wb, styleRangeCommand.create(wb, id, range, { fill: '#00ff00' }));
    wb = applyCommand(wb, styleRangeCommand.create(wb, id, range, { fontSize: 18 }));
    const st = getCell(wb.sheets[0], 0, 0).style;
    expect(st).toMatchObject({ color: '#ff0000', fill: '#00ff00', fontSize: 18 });
  });

  test('quitar un estilo (null) lo elimina sin borrar los demas', () => {
    let wb = wb0();
    const id = wb.activeSheetId;
    const range = { r1: 0, c1: 0, r2: 0, c2: 0 };
    wb = applyCommand(wb, styleRangeCommand.create(wb, id, range, { color: '#f00', bold: true }));
    wb = applyCommand(wb, styleRangeCommand.create(wb, id, range, { color: null }));
    const st = getCell(wb.sheets[0], 0, 0).style;
    expect(st.color).toBeFalsy();
    expect(st.bold).toBe(true);
  });
});

describe('redimensionar varias columnas / filas a la vez', () => {
  test('varias columnas quedan con el mismo ancho y se deshace', () => {
    let wb = wb0();
    const id = wb.activeSheetId;
    const cmd = resizeColsCommand.create(wb, id, [1, 2, 3], 150);
    wb = applyCommand(wb, cmd);
    expect(getColWidth(wb.sheets[0], 1)).toBe(150);
    expect(getColWidth(wb.sheets[0], 2)).toBe(150);
    expect(getColWidth(wb.sheets[0], 3)).toBe(150);
    wb = revertCommand(wb, cmd);
    expect(getColWidth(wb.sheets[0], 1)).toBe(104);   // vuelve al ancho por defecto
    expect(getColWidth(wb.sheets[0], 2)).toBe(104);
  });

  test('varias filas al mismo alto, respetando el previo al deshacer', () => {
    let wb = wb0();
    const id = wb.activeSheetId;
    // La fila 5 ya tenia un alto propio: al deshacer debe volver a ese, no al default.
    wb = applyCommand(wb, resizeRowCommand.create(wb, id, 5, 40));
    const cmd = resizeRowsCommand.create(wb, id, [4, 5, 6], 80);
    wb = applyCommand(wb, cmd);
    expect(getRowHeight(wb.sheets[0], 4)).toBe(80);
    expect(getRowHeight(wb.sheets[0], 5)).toBe(80);
    wb = revertCommand(wb, cmd);
    expect(getRowHeight(wb.sheets[0], 4)).toBe(26);   // no tenia -> default
    expect(getRowHeight(wb.sheets[0], 5)).toBe(40);   // tenia 40 -> vuelve a 40
  });
});

describe('alto de fila y mostrar columnas', () => {
  test('ajustar alto y deshacer', () => {
    let wb = wb0();
    const id = wb.activeSheetId;
    const cmd = resizeRowCommand.create(wb, id, 3, 60);
    wb = applyCommand(wb, cmd);
    expect(getRowHeight(wb.sheets[0], 3)).toBe(60);
    wb = revertCommand(wb, cmd);
    expect(getRowHeight(wb.sheets[0], 3)).toBe(26);   // vuelve al valor por defecto
  });

  test('mostrar columnas revela todas las ocultas y se deshace', () => {
    let wb = wb0();
    const id = wb.activeSheetId;
    // Ocultar dos columnas directamente en el modelo para preparar el estado.
    wb = { ...wb, sheets: [toggleColHidden(toggleColHidden(wb.sheets[0], 2, true), 5, true)] };
    const cmd = showAllColsCommand.create(wb, id);
    wb = applyCommand(wb, cmd);
    expect(wb.sheets[0].hiddenCols.size).toBe(0);
    wb = revertCommand(wb, cmd);
    expect(wb.sheets[0].hiddenCols.has(2)).toBe(true);
    expect(wb.sheets[0].hiddenCols.has(5)).toBe(true);
  });

  test('mostrar columnas sin ninguna oculta no genera comando', () => {
    const wb = wb0();
    expect(showAllColsCommand.create(wb, wb.activeSheetId)).toBeNull();
  });
});
