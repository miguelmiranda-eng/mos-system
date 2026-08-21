import { fromA1, lettersToCol } from './address';

/**
 * Motor de formulas del grid (referencias A1).
 *
 * Es un evaluador propio, chico y enfocado: tokenizador + parser de precedencia
 * + evaluador. NO reusa lib/formula.js del CRM porque ese referencia columnas
 * dentro de una fila ([Nombre]), no celdas A1:B10 de una rejilla.
 *
 * Soporta lo que pidio el usuario y deja la puerta abierta a mas funciones:
 * el registro FN es un objeto; agregar una funcion es una linea.
 */

// ── Errores ──────────────────────────────────────────────────────────────────
export class FormulaError {
  constructor(code) { this.code = code; }
  toString() { return this.code; }
}
const ERR = {
  DIV0: () => new FormulaError('#DIV/0!'),
  VALUE: () => new FormulaError('#VALUE!'),
  NAME: () => new FormulaError('#NAME?'),
  NUM: () => new FormulaError('#NUM!'),
  REF: () => new FormulaError('#REF!'),
  NA: () => new FormulaError('#N/A'),
  CYCLE: () => new FormulaError('#CYCLE!'),
};
export const esError = (v) => v instanceof FormulaError;

// ── Tokenizador ──────────────────────────────────────────────────────────────
const OPS = ['<>', '<=', '>=', '=', '<', '>', '+', '-', '*', '/', '^', '&'];

function tokenizar(src) {
  const toks = [];
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') { i++; continue; }

    // Numero
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(src[i + 1]))) {
      let j = i + 1;
      while (j < n && /[0-9.eE+-]/.test(src[j])) {
        // el signo solo cuenta si sigue a e/E (notacion cientifica)
        if ((src[j] === '+' || src[j] === '-') && !/[eE]/.test(src[j - 1])) break;
        j++;
      }
      toks.push({ t: 'num', v: parseFloat(src.slice(i, j)) });
      i = j; continue;
    }

    // Texto entre comillas dobles
    if (c === '"') {
      let j = i + 1; let s = '';
      while (j < n) {
        if (src[j] === '"') { if (src[j + 1] === '"') { s += '"'; j += 2; continue; } break; }
        s += src[j]; j++;
      }
      toks.push({ t: 'str', v: s });
      i = j + 1; continue;
    }

    // Identificador: funcion, booleano, o referencia A1 / rango
    if (/[A-Za-z_$]/.test(c)) {
      let j = i;
      while (j < n && /[A-Za-z0-9_$.]/.test(src[j])) j++;
      let ident = src.slice(i, j);

      // Rango A1:B10
      if (src[j] === ':' && /[A-Za-z$]/.test(src[j + 1] || '')) {
        let k = j + 1;
        while (k < n && /[A-Za-z0-9$]/.test(src[k])) k++;
        const b = src.slice(j + 1, k);
        toks.push({ t: 'range', a: ident, b });
        i = k; continue;
      }

      const up = ident.toUpperCase();
      if (up === 'TRUE') { toks.push({ t: 'bool', v: true }); i = j; continue; }
      if (up === 'FALSE') { toks.push({ t: 'bool', v: false }); i = j; continue; }

      // Funcion si sigue un parentesis
      let k = j;
      while (k < n && (src[k] === ' ')) k++;
      if (src[k] === '(') { toks.push({ t: 'func', v: up }); i = j; continue; }

      // Referencia de celda
      toks.push({ t: 'ref', v: ident });
      i = j; continue;
    }

    // Operadores (dos caracteres primero)
    const dos = src.slice(i, i + 2);
    if (OPS.includes(dos)) { toks.push({ t: 'op', v: dos }); i += 2; continue; }
    if (OPS.includes(c)) { toks.push({ t: 'op', v: c }); i++; continue; }
    if (c === '(') { toks.push({ t: 'lp' }); i++; continue; }
    if (c === ')') { toks.push({ t: 'rp' }); i++; continue; }
    if (c === ',' || c === ';') { toks.push({ t: 'comma' }); i++; continue; }

    // Caracter no reconocido
    throw ERR.VALUE();
  }
  toks.push({ t: 'eof' });
  return toks;
}

// ── Parser (precedencia por escalada) ────────────────────────────────────────
const PREC = { '=': 1, '<>': 1, '<': 1, '>': 1, '<=': 1, '>=': 1, '&': 2, '+': 3, '-': 3, '*': 4, '/': 4, '^': 5 };

function parsear(toks) {
  let p = 0;
  const peek = () => toks[p];
  const next = () => toks[p++];

  function parseExpr(minPrec) {
    let izq = parseUnary();
    while (peek().t === 'op' && PREC[peek().v] >= minPrec) {
      const op = next().v;
      // ^ es asociativo a la derecha
      const siguiente = op === '^' ? PREC[op] : PREC[op] + 1;
      const der = parseExpr(siguiente);
      izq = { tipo: 'bin', op, izq, der };
    }
    return izq;
  }

  function parseUnary() {
    if (peek().t === 'op' && (peek().v === '-' || peek().v === '+')) {
      const op = next().v;
      return { tipo: 'un', op, arg: parseUnary() };
    }
    return parsePrimary();
  }

  function parsePrimary() {
    const tk = next();
    switch (tk.t) {
      case 'num': return { tipo: 'num', v: tk.v };
      case 'str': return { tipo: 'str', v: tk.v };
      case 'bool': return { tipo: 'bool', v: tk.v };
      case 'ref': return { tipo: 'ref', v: tk.v };
      case 'range': return { tipo: 'range', a: tk.a, b: tk.b };
      case 'func': {
        if (next().t !== 'lp') throw ERR.VALUE();
        const args = [];
        if (peek().t !== 'rp') {
          args.push(parseExpr(1));
          while (peek().t === 'comma') { next(); args.push(parseExpr(1)); }
        }
        if (next().t !== 'rp') throw ERR.VALUE();
        return { tipo: 'call', nombre: tk.v, args };
      }
      case 'lp': {
        const e = parseExpr(1);
        if (next().t !== 'rp') throw ERR.VALUE();
        return e;
      }
      default: throw ERR.VALUE();
    }
  }

  const ast = parseExpr(1);
  if (peek().t !== 'eof') throw ERR.VALUE();
  return ast;
}

/** Parsea una vez; devuelve AST o lanza FormulaError. Cacheable por el llamador. */
export function parseFormula(src) {
  return parsear(tokenizar(src));
}

// ── Coerciones ───────────────────────────────────────────────────────────────
const aNumero = (v) => {
  if (esError(v)) return v;
  if (v == null || v === '') return 0;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'number') return v;
  const s = String(v).trim();
  if (s === '') return 0;
  const n = Number(s);
  return Number.isNaN(n) ? ERR.VALUE() : n;
};
const aTexto = (v) => {
  if (esError(v)) return v;
  if (v == null) return '';
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  return String(v);
};
const aBool = (v) => {
  if (esError(v)) return v;
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  const s = String(v).trim().toUpperCase();
  if (s === 'TRUE') return true;
  if (s === 'FALSE' || s === '') return false;
  return !!s;
};

/** Aplana argumentos: rangos -> valores individuales; ignora errores propagados aparte. */
function aplanar(args, out) {
  for (const a of args) {
    if (Array.isArray(a)) aplanar(a, out);
    else out.push(a);
  }
  return out;
}
function numerosDe(args) {
  const vals = aplanar(args, []);
  const nums = [];
  for (const v of vals) {
    if (esError(v)) return v;
    if (v == null || v === '' || typeof v === 'boolean') continue; // se saltan, como Excel
    const n = Number(v);
    if (!Number.isNaN(n)) nums.push(n);
  }
  return nums;
}

// ── Funciones ────────────────────────────────────────────────────────────────
const FN = {};
const def = (nombre, fn) => { FN[nombre] = fn; };

const suma = (nums) => nums.reduce((a, b) => a + b, 0);

def('SUM', (a) => { const n = numerosDe(a); return esError(n) ? n : suma(n); });
def('AVERAGE', (a) => { const n = numerosDe(a); if (esError(n)) return n; return n.length ? suma(n) / n.length : ERR.DIV0(); });
def('MIN', (a) => { const n = numerosDe(a); if (esError(n)) return n; return n.length ? Math.min(...n) : 0; });
def('MAX', (a) => { const n = numerosDe(a); if (esError(n)) return n; return n.length ? Math.max(...n) : 0; });
def('COUNT', (a) => numerosDe(a).length ?? 0);
def('COUNTA', (a) => aplanar(a, []).filter(v => v != null && v !== '').length);
def('ROUND', (a) => {
  const x = aNumero(a[0]); if (esError(x)) return x;
  const d = a.length > 1 ? aNumero(a[1]) : 0; if (esError(d)) return d;
  const f = 10 ** Math.trunc(d); return Math.round(x * f) / f;
});
def('ABS', (a) => { const x = aNumero(a[0]); return esError(x) ? x : Math.abs(x); });
def('IF', (a) => {
  const cond = aBool(a[0]); if (esError(cond)) return cond;
  return cond ? (a[1] ?? true) : (a.length > 2 ? a[2] : false);
});
def('AND', (a) => { const v = aplanar(a, []); for (const x of v) { const b = aBool(x); if (esError(b)) return b; if (!b) return false; } return true; });
def('OR', (a) => { const v = aplanar(a, []); for (const x of v) { const b = aBool(x); if (esError(b)) return b; if (b) return true; } return false; });
def('NOT', (a) => { const b = aBool(a[0]); return esError(b) ? b : !b; });
def('CONCAT', (a) => { const v = aplanar(a, []); let s = ''; for (const x of v) { const t = aTexto(x); if (esError(t)) return t; s += t; } return s; });
FN.CONCATENATE = FN.CONCAT;
def('LEN', (a) => { const t = aTexto(a[0]); return esError(t) ? t : t.length; });
def('UPPER', (a) => { const t = aTexto(a[0]); return esError(t) ? t : t.toUpperCase(); });
def('LOWER', (a) => { const t = aTexto(a[0]); return esError(t) ? t : t.toLowerCase(); });
def('TRIM', (a) => { const t = aTexto(a[0]); return esError(t) ? t : t.trim(); });
def('IFERROR', (a) => (esError(a[0]) ? (a[1] ?? '') : a[0]));
def('SQRT', (a) => { const x = aNumero(a[0]); if (esError(x)) return x; return x < 0 ? ERR.NUM() : Math.sqrt(x); });
def('POWER', (a) => { const b = aNumero(a[0]); const e = aNumero(a[1]); if (esError(b)) return b; if (esError(e)) return e; return b ** e; });

// SUMIF / COUNTIF: rango, criterio [, rango_suma]
function coincide(valor, criterio) {
  const c = aTexto(criterio);
  const m = /^(<=|>=|<>|<|>|=)?(.*)$/.exec(c);
  const op = m[1] || '='; const objetivo = m[2];
  const numObj = Number(objetivo);
  const esNum = objetivo.trim() !== '' && !Number.isNaN(numObj) && typeof valor !== 'string';
  if (esNum || (typeof valor === 'number' && !Number.isNaN(Number(objetivo)))) {
    const v = Number(valor); const o = Number(objetivo);
    switch (op) { case '=': return v === o; case '<>': return v !== o; case '<': return v < o; case '>': return v > o; case '<=': return v <= o; case '>=': return v >= o; default: return false; }
  }
  const v = aTexto(valor).toUpperCase(); const o = objetivo.toUpperCase();
  switch (op) { case '=': return v === o; case '<>': return v !== o; default: return v === o; }
}
def('COUNTIF', (a) => {
  const rango = aplanar([a[0]], []);
  let n = 0; for (const v of rango) if (coincide(v, a[1])) n++;
  return n;
});
def('SUMIF', (a) => {
  const rango = aplanar([a[0]], []);
  const sumas = a.length > 2 ? aplanar([a[2]], []) : rango;
  let s = 0;
  for (let i = 0; i < rango.length; i++) if (coincide(rango[i], a[1])) { const x = Number(sumas[i]); if (!Number.isNaN(x)) s += x; }
  return s;
});

// ── Evaluador ────────────────────────────────────────────────────────────────
/**
 * Evalua un AST. `ctx` resuelve referencias:
 *   ctx.celda(row, col)      -> valor ya calculado de esa celda
 *   ctx.rango(r1,c1,r2,c2)   -> array plano de valores
 * Ambos pueden devolver FormulaError (p.ej. ciclo).
 */
export function evaluar(ast, ctx) {
  function ev(nodo) {
    switch (nodo.tipo) {
      case 'num': return nodo.v;
      case 'str': return nodo.v;
      case 'bool': return nodo.v;
      case 'ref': {
        const dir = fromA1(nodo.v);
        if (!dir) return ERR.REF();
        return ctx.celda(dir.row, dir.col);
      }
      case 'range': {
        const a = fromA1(nodo.a); const b = fromA1(nodo.b);
        if (!a || !b) return ERR.REF();
        return ctx.rango(
          Math.min(a.row, b.row), Math.min(a.col, b.col),
          Math.max(a.row, b.row), Math.max(a.col, b.col),
        );
      }
      case 'un': {
        const v = aNumero(ev(nodo.arg));
        if (esError(v)) return v;
        return nodo.op === '-' ? -v : v;
      }
      case 'bin': return evBin(nodo);
      case 'call': {
        const fn = FN[nodo.nombre];
        if (!fn) return ERR.NAME();
        const args = nodo.args.map(ev);
        return fn(args);
      }
      default: return ERR.VALUE();
    }
  }

  function evBin(nodo) {
    const op = nodo.op;
    const a = ev(nodo.izq);
    if (esError(a) && op !== '&') return a;
    const b = ev(nodo.der);
    if (esError(b) && op !== '&') return b;

    if (op === '&') {
      const ta = aTexto(a); if (esError(ta)) return ta;
      const tb = aTexto(b); if (esError(tb)) return tb;
      return ta + tb;
    }
    if (op === '=' || op === '<>' || op === '<' || op === '>' || op === '<=' || op === '>=') {
      return comparar(a, b, op);
    }
    const na = aNumero(a); if (esError(na)) return na;
    const nb = aNumero(b); if (esError(nb)) return nb;
    switch (op) {
      case '+': return na + nb;
      case '-': return na - nb;
      case '*': return na * nb;
      case '/': return nb === 0 ? ERR.DIV0() : na / nb;
      case '^': return na ** nb;
      default: return ERR.VALUE();
    }
  }

  return ev(ast);
}

function comparar(a, b, op) {
  let x = a; let y = b;
  const ambosNum = typeof a !== 'string' && typeof b !== 'string';
  if (ambosNum) { x = aNumero(a); y = aNumero(b); }
  else { x = aTexto(a).toUpperCase(); y = aTexto(b).toUpperCase(); }
  switch (op) {
    case '=': return x === y;
    case '<>': return x !== y;
    case '<': return x < y;
    case '>': return x > y;
    case '<=': return x <= y;
    case '>=': return x >= y;
    default: return ERR.VALUE();
  }
}

// Se re-exporta por si el compute quiere validar columnas.
export { lettersToCol };
