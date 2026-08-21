import { parseFormula, evaluar, esError, FormulaError } from './formula';
import { getCell, isNumeric } from './model';
import { cellKey } from './address';

/**
 * Calcula los valores de una hoja con formulas.
 *
 * Devuelve un Map `key -> valor calculado`. Se construye UNA vez por edicion
 * (la hoja es inmutable: misma referencia mientras no se edita), asi que
 * desplazarse por la hoja no recalcula nada — el Grid memoiza por `sheet`.
 *
 * Evaluacion perezosa con memoizacion y corte de ciclos: cada celda se calcula
 * la primera vez que alguien la pide y se guarda; una referencia circular
 * devuelve #CYCLE! en vez de colgar el navegador.
 *
 * El AST de cada formula se cachea aparte por texto: editar una celda no obliga
 * a re-parsear las formulas que no cambiaron.
 */

const astCache = new Map();
function ast(formula) {
  let a = astCache.get(formula);
  if (a === undefined) {
    try { a = parseFormula(formula); }
    catch (e) { a = e instanceof FormulaError ? e : new FormulaError('#VALUE!'); }
    if (astCache.size > 5000) astCache.clear(); // techo simple, evita fuga
    astCache.set(formula, a);
  }
  return a;
}

/** Valor "crudo" de una celda sin formula, tipado (numero si lo parece). */
function valorCrudo(cell) {
  if (!cell || cell.value == null) return null;
  if (isNumeric(cell.value)) return Number(cell.value);
  return cell.value;
}

export function computeSheet(sheet) {
  const cache = new Map();     // key -> valor calculado
  const visitando = new Set(); // para detectar ciclos

  const ctx = {
    celda(row, col) {
      if (row < 0 || col < 0) return new FormulaError('#REF!');
      return calcular(row, col);
    },
    rango(r1, c1, r2, c2) {
      const out = [];
      for (let r = r1; r <= r2; r++) {
        for (let c = c1; c <= c2; c++) out.push(calcular(r, c));
      }
      return out;
    },
  };

  function calcular(row, col) {
    const k = cellKey(row, col);
    if (cache.has(k)) return cache.get(k);

    const cell = getCell(sheet, row, col);
    if (!cell || cell.formula == null) {
      const v = valorCrudo(cell);
      cache.set(k, v);
      return v;
    }

    if (visitando.has(k)) return new FormulaError('#CYCLE!');
    visitando.add(k);

    const a = ast(cell.formula);
    let v;
    if (esError(a)) v = a;
    else {
      try { v = evaluar(a, ctx); }
      catch (e) { v = e instanceof FormulaError ? e : new FormulaError('#VALUE!'); }
    }
    visitando.delete(k);
    cache.set(k, v);
    return v;
  }

  // Se calculan de golpe todas las celdas con formula; sus dependencias entran
  // solas por el resolvedor perezoso.
  for (const [k, cell] of sheet.cells) {
    if (cell.formula != null && !cache.has(k)) {
      const i = k.indexOf(':');
      calcular(+k.slice(0, i), +k.slice(i + 1));
    }
  }

  return cache;
}

/**
 * Texto a mostrar de una celda, ya con la formula resuelta.
 * `computed` es el Map de computeSheet. Para celdas sin formula, delega al
 * formateo normal del modelo (que el llamador pasa como `formatSimple`).
 */
export function textoCalculado(cell, computed, key, formatSimple) {
  if (!cell) return '';
  if (cell.formula == null) return formatSimple(cell);
  const v = computed.get(key);
  if (v == null) return '';
  if (esError(v)) return v.code;
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  // Un resultado numerico respeta el formato de la celda (moneda, %, etc.).
  return formatSimple({ ...cell, value: v, formula: null });
}
