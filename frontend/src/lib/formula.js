/**
 * Motor de fórmulas estilo Excel para las columnas calculadas del tablero.
 *
 * POR QUÉ EXISTE
 * ──────────────
 * La implementación anterior (lib/constants.js::evaluateFormula) hacía tres
 * cosas incompatibles entre sí:
 *   · sustituía cada identificador por su valor con `String.replace`,
 *   · evaluaba con `Function()` la condición de un IF SIN sanitizar, y
 *   · sanitizaba el resultado con /[^0-9+\-*\/().%\s]/g — que BORRA toda letra
 *     y comilla, así que cualquier fórmula con texto devolvía vacío. El propio
 *     placeholder de la UI (`IF(quantity > 100, 'Alto', 'Bajo')`) no funcionaba.
 * Además `AND`/`OR`/`SUM`/`ABS` estaban listadas como palabras reservadas pero
 * nunca se implementaron, un campo inexistente se volvía 0 en silencio, y solo
 * se admitía UN IF sin anidar.
 *
 * Esto es un tokenizador + parser de Pratt + evaluador. No hay `eval` ni
 * `Function()` en ninguna parte: una fórmula no puede ejecutar código, solo
 * producir un valor. Un identificador desconocido es #NAME?, no 0.
 *
 * COMPATIBILIDAD CON EXCEL
 * ────────────────────────
 * · Precedencia y asociatividad reales de Excel (la comparación es la MÁS BAJA,
 *   `^` asocia a la derecha, `%` es sufijo, `&` concatena).
 * · Valores de error propagables: #DIV/0!, #VALUE!, #NAME?, #NUM!, #REF!, #N/A.
 * · Comparación de texto insensible a mayúsculas, como Excel.
 * · Las fechas son seriales de Excel (días desde 1899-12-30), así que
 *   `[due_date] - TODAY()` da los días que faltan, igual que en una hoja.
 * · Separador de argumentos `,` o `;` — los teclados/locales en es-MX usan `;`.
 * · Comillas dobles (Excel) y simples (las que ya usaba el placeholder viejo).
 *
 * REFERENCIAS A COLUMNAS
 * ──────────────────────
 * `[Nombre de la columna]` (estilo tabla de Excel: admite espacios y acentos) y
 * `nombre_pelado` (retrocompatible con lo que ya hubiera guardado). Se resuelve
 * contra la clave de la columna, su etiqueta, y por último contra el campo crudo
 * de la orden — así `order_number` funciona aunque la columna esté oculta.
 *
 * Una columna de fórmula puede referenciar OTRA columna de fórmula; los ciclos
 * se cortan con #REF! en vez de colgar el navegador.
 */

// ── Valores de error ─────────────────────────────────────────────────────────
export class FormulaError {
  constructor(code, detail = '') { this.code = code; this.detail = detail; }
  toString() { return this.code; }
}
const ERR = {
  DIV0: () => new FormulaError('#DIV/0!'),
  VALUE: (d) => new FormulaError('#VALUE!', d),
  NAME: (d) => new FormulaError('#NAME?', d),
  NUM: (d) => new FormulaError('#NUM!', d),
  REF: (d) => new FormulaError('#REF!', d),
  NA: (d) => new FormulaError('#N/A', d),
};
const isErr = (v) => v instanceof FormulaError;

/** Error de sintaxis: lo lanza el parser, lo atrapa parseFormula(). */
export class FormulaSyntaxError extends Error {
  constructor(message, pos = 0) { super(message); this.pos = pos; }
}

// ── Tokenizador ──────────────────────────────────────────────────────────────
const OPERATORS = ['<>', '<=', '>=', '=', '<', '>', '+', '-', '*', '/', '^', '&', '%'];
// Letras con acento y ñ cuentan como parte de un identificador: los nombres de
// columna reales son "Cantidad", "Diseño", "Tamaño"…
const IDENT_START = /[A-Za-z_À-ɏ]/;
const IDENT_PART = /[A-Za-z0-9_.À-ɏ]/;

function tokenize(src) {
  const s = String(src == null ? '' : src);
  const out = [];
  let i = 0;
  // Excel deja escribir la fórmula con o sin '=' inicial.
  while (i < s.length && /\s/.test(s[i])) i++;
  if (s[i] === '=') i++;

  while (i < s.length) {
    const c = s[i];
    if (/\s/.test(c)) { i++; continue; }

    // Número (admite .5 y 1.5)
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(s[i + 1] || ''))) {
      const start = i;
      while (i < s.length && /[0-9]/.test(s[i])) i++;
      if (s[i] === '.') { i++; while (i < s.length && /[0-9]/.test(s[i])) i++; }
      out.push({ t: 'num', v: parseFloat(s.slice(start, i)), pos: start });
      continue;
    }

    // Texto: "..." o '...'; la comilla se duplica para escaparla (como Excel).
    if (c === '"' || c === "'") {
      const quote = c, start = i;
      i++;
      let buf = '';
      for (;;) {
        if (i >= s.length) throw new FormulaSyntaxError('Falta cerrar la comilla', start);
        if (s[i] === quote) {
          if (s[i + 1] === quote) { buf += quote; i += 2; continue; }
          i++; break;
        }
        buf += s[i++];
      }
      out.push({ t: 'str', v: buf, pos: start });
      continue;
    }

    // Referencia entre corchetes: [Nombre de columna]
    if (c === '[') {
      const start = i;
      const end = s.indexOf(']', i + 1);
      if (end === -1) throw new FormulaSyntaxError('Falta cerrar el corchete "]"', start);
      const name = s.slice(i + 1, end).trim();
      if (!name) throw new FormulaSyntaxError('Referencia vacía: []', start);
      out.push({ t: 'ref', v: name, pos: start });
      i = end + 1;
      continue;
    }

    // Identificador: función si le sigue "(", si no una referencia pelada.
    if (IDENT_START.test(c)) {
      const start = i;
      while (i < s.length && IDENT_PART.test(s[i])) i++;
      const word = s.slice(start, i);
      let j = i;
      while (j < s.length && /\s/.test(s[j])) j++;
      out.push({ t: s[j] === '(' ? 'func' : 'ident', v: word, pos: start });
      continue;
    }

    if (c === '(' || c === ')') { out.push({ t: c, pos: i++ }); continue; }
    // Excel en locales es-* usa ';' como separador de argumentos.
    if (c === ',' || c === ';') { out.push({ t: 'sep', pos: i++ }); continue; }

    const op = OPERATORS.find(o => s.startsWith(o, i));
    if (op) { out.push({ t: 'op', v: op, pos: i }); i += op.length; continue; }

    throw new FormulaSyntaxError(`Carácter no válido: "${c}"`, i);
  }
  out.push({ t: 'end', pos: s.length });
  return out;
}

// ── Parser de Pratt ──────────────────────────────────────────────────────────
// Precedencia REAL de Excel: la comparación es la más baja y `^` asocia a la
// derecha. Con la típica precedencia de C, `a & b = c` se agruparía mal.
const INFIX_BP = {
  '=': 10, '<>': 10, '<': 10, '>': 10, '<=': 10, '>=': 10,
  '&': 20,
  '+': 30, '-': 30,
  '*': 40, '/': 40,
  '^': 50,
};
// OJO — Excel NO es la convención matemática aquí: `^` asocia a la IZQUIERDA.
// `=2^3^2` da 64 ((2^3)^2), no 512 (2^(3^2)) como en notación matemática o en
// lenguajes como Python. Excel resuelve los operadores de igual precedencia de
// izquierda a derecha, sin excepción. Este Set queda vacío a propósito: si
// alguien "corrige" esto metiendo '^', deja de ser compatible con Excel.
const RIGHT_ASSOC = new Set();
const UNARY_BP = 60;
const PERCENT_BP = 70;

function parseTokens(tokens) {
  let p = 0;
  const peek = () => tokens[p];
  const next = () => tokens[p++];

  function parseExpr(minBp = 0) {
    let left = parsePrefix();
    for (;;) {
      const tk = peek();
      if (tk.t === 'op' && tk.v === '%' && PERCENT_BP > minBp) {
        next();
        left = { k: 'pct', a: left };
        continue;
      }
      if (tk.t !== 'op') break;
      const bp = INFIX_BP[tk.v];
      if (bp === undefined || bp <= minBp) break;
      next();
      const right = parseExpr(RIGHT_ASSOC.has(tk.v) ? bp - 1 : bp);
      left = { k: 'bin', op: tk.v, a: left, b: right };
    }
    return left;
  }

  function parsePrefix() {
    const tk = next();
    switch (tk.t) {
      case 'num': return { k: 'num', v: tk.v };
      case 'str': return { k: 'str', v: tk.v };
      case 'ref': return { k: 'ref', name: tk.v, pos: tk.pos };
      case 'ident': {
        const upper = tk.v.toUpperCase();
        if (upper === 'TRUE') return { k: 'bool', v: true };
        if (upper === 'FALSE') return { k: 'bool', v: false };
        return { k: 'ref', name: tk.v, pos: tk.pos };
      }
      case 'func': {
        const name = tk.v.toUpperCase();
        next(); // '('
        const args = [];
        if (peek().t !== ')') {
          for (;;) {
            args.push(parseExpr(0));
            if (peek().t === 'sep') { next(); continue; }
            break;
          }
        }
        if (peek().t !== ')') {
          throw new FormulaSyntaxError(`Falta cerrar el paréntesis de ${name}()`, peek().pos);
        }
        next();
        return { k: 'call', name, args, pos: tk.pos };
      }
      case '(': {
        const inner = parseExpr(0);
        if (peek().t !== ')') throw new FormulaSyntaxError('Falta cerrar el paréntesis ")"', peek().pos);
        next();
        return inner;
      }
      case 'op':
        if (tk.v === '-') return { k: 'neg', a: parseExpr(UNARY_BP) };
        if (tk.v === '+') return parseExpr(UNARY_BP);
        throw new FormulaSyntaxError(`Operador inesperado "${tk.v}"`, tk.pos);
      case 'end':
        throw new FormulaSyntaxError('La fórmula está incompleta', tk.pos);
      default:
        throw new FormulaSyntaxError('Se esperaba un valor', tk.pos);
    }
  }

  const ast = parseExpr(0);
  if (peek().t !== 'end') {
    throw new FormulaSyntaxError('Sobra texto al final de la fórmula', peek().pos);
  }
  return ast;
}

/** Compila el texto a AST. Devuelve { ast } o { error: {message, pos} }. */
export function parseFormula(src) {
  try {
    if (!String(src ?? '').trim()) return { error: { message: 'La fórmula está vacía', pos: 0 } };
    return { ast: parseTokens(tokenize(src)) };
  } catch (e) {
    if (e instanceof FormulaSyntaxError) return { error: { message: e.message, pos: e.pos } };
    return { error: { message: 'No se pudo interpretar la fórmula', pos: 0 } };
  }
}

// ── Fechas como seriales de Excel ────────────────────────────────────────────
// Excel cuenta días desde 1899-12-30 (su bug del año bisiesto 1900 incluido).
// Trabajar en seriales hace que `[due_date] - TODAY()` dé días, como en la hoja.
const EPOCH = Date.UTC(1899, 11, 30);
const DAY_MS = 86400000;
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})(?:[T ]|$)/;
const DMY_DATE = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/;

function toSerial(date) { return (date.getTime() - EPOCH) / DAY_MS; }
function fromSerial(n) { return new Date(EPOCH + Math.round(n) * DAY_MS); }

function parseDateish(v) {
  if (v instanceof Date) return isNaN(v) ? null : v;
  if (typeof v !== 'string') return null;
  const s = v.trim();
  let m = ISO_DATE.exec(s);
  if (m) return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  m = DMY_DATE.exec(s);
  // Ambiguo por naturaleza; el sistema guarda ISO, así que esto es solo para lo
  // que un usuario teclee a mano. Se asume dd/mm/yyyy (convención local).
  if (m) return new Date(Date.UTC(+m[3], +m[2] - 1, +m[1]));
  return null;
}

// ── Coerciones ───────────────────────────────────────────────────────────────
const BLANK = null;

function toNumber(v) {
  if (isErr(v)) return v;
  if (v === BLANK || v === undefined || v === '') return 0;
  if (typeof v === 'number') return Number.isFinite(v) ? v : ERR.NUM();
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (v instanceof Date) return toSerial(v);
  if (typeof v === 'string') {
    const s = v.trim();
    if (!s) return 0;
    // Porcentaje escrito: "35%"
    if (/^-?[\d.,]+%$/.test(s)) {
      const n = parseFloat(s.replace(/,/g, '').replace('%', ''));
      if (Number.isFinite(n)) return n / 100;
    }
    // Miles con coma: "1,234.5"
    const plain = /^-?\d{1,3}(,\d{3})+(\.\d+)?$/.test(s) ? s.replace(/,/g, '') : s;
    if (/^-?(\d+\.?\d*|\.\d+)$/.test(plain)) return parseFloat(plain);
    const d = parseDateish(s);
    if (d) return toSerial(d);
    return ERR.VALUE(`"${v}" no es un número`);
  }
  return ERR.VALUE('valor no numérico');
}

function toText(v) {
  if (isErr(v)) return v;
  if (v === BLANK || v === undefined) return '';
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === 'number') return formatNumberPlain(v);
  return String(v);
}

function toBool(v) {
  if (isErr(v)) return v;
  if (v === BLANK || v === undefined || v === '') return false;
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  const s = String(v).trim().toUpperCase();
  if (s === 'TRUE' || s === 'VERDADERO') return true;
  if (s === 'FALSE' || s === 'FALSO') return false;
  const n = toNumber(v);
  if (isErr(n)) return ERR.VALUE(`"${v}" no es lógico`);
  return n !== 0;
}

/** Como Excel: no imprime ceros de relleno ni notación científica innecesaria. */
function formatNumberPlain(n) {
  if (!Number.isFinite(n)) return '#NUM!';
  if (Number.isInteger(n)) return String(n);
  return String(parseFloat(n.toFixed(10)));
}

/**
 * Aplana un argumento para funciones de agregación. El campo `sizes` de una
 * orden es un objeto {S: 10, M: 20}; en SUM/AVERAGE/MIN/MAX/COUNT aporta sus
 * valores numéricos, que es lo que un capturista espera de `SUM([sizes])`.
 * En contexto escalar un objeto sigue siendo #VALUE!.
 */
function flatten(v, out) {
  if (Array.isArray(v)) { for (const x of v) flatten(x, out); return out; }
  if (v && typeof v === 'object' && !(v instanceof Date) && !isErr(v)) {
    for (const x of Object.values(v)) flatten(x, out);
    return out;
  }
  out.push(v);
  return out;
}

/** Números de un conjunto de argumentos, ignorando texto/vacíos (como Excel). */
function numericArgs(args) {
  const flat = flatten(args, []);
  const nums = [];
  for (const v of flat) {
    if (isErr(v)) return v;
    if (v === BLANK || v === undefined || v === '') continue;
    if (typeof v === 'boolean') { nums.push(v ? 1 : 0); continue; }
    if (typeof v === 'number') { nums.push(v); continue; }
    if (v instanceof Date) { nums.push(toSerial(v)); continue; }
    const n = toNumber(v);
    if (!isErr(n)) nums.push(n);   // el texto no numérico se ignora, como Excel
  }
  return nums;
}

// ── Comparación (Excel: texto insensible a mayúsculas) ───────────────────────
function compare(a, b) {
  if (isErr(a)) return a;
  if (isErr(b)) return b;
  const aBlank = a === BLANK || a === undefined || a === '';
  const bBlank = b === BLANK || b === undefined || b === '';
  if (aBlank && bBlank) return 0;
  const an = typeof a === 'number' ? a : (typeof a === 'string' && !isErr(toNumber(a)) ? toNumber(a) : null);
  const bn = typeof b === 'number' ? b : (typeof b === 'string' && !isErr(toNumber(b)) ? toNumber(b) : null);
  if (an !== null && bn !== null) return an < bn ? -1 : an > bn ? 1 : 0;
  if (typeof a === 'boolean' || typeof b === 'boolean') {
    const ab = toBool(a), bb = toBool(b);
    if (isErr(ab) || isErr(bb)) return ERR.VALUE();
    return ab === bb ? 0 : (ab ? 1 : -1);
  }
  const as = String(toText(a)).toUpperCase();
  const bs = String(toText(b)).toUpperCase();
  return as < bs ? -1 : as > bs ? 1 : 0;
}

// ── Formato de TEXT() ────────────────────────────────────────────────────────
function applyTextFormat(value, fmt) {
  const f = String(fmt || '');
  if (/[ymdhs]/i.test(f) && !/[#0]/.test(f)) {
    const n = toNumber(value);
    if (isErr(n)) return n;
    const d = fromSerial(n);
    const pad = (x, w = 2) => String(x).padStart(w, '0');
    return f
      .replace(/yyyy/gi, d.getUTCFullYear())
      .replace(/yy/gi, pad(d.getUTCFullYear() % 100))
      .replace(/mm/g, pad(d.getUTCMonth() + 1))
      .replace(/dd/gi, pad(d.getUTCDate()))
      .replace(/hh/gi, pad(d.getUTCHours()))
      .replace(/ss/gi, pad(d.getUTCSeconds()));
  }
  const n = toNumber(value);
  if (isErr(n)) return n;
  const isPct = f.includes('%');
  const x = isPct ? n * 100 : n;
  const decMatch = /\.(0+)/.exec(f);
  const decimals = decMatch ? decMatch[1].length : 0;
  const grouped = f.includes('#,##') || f.includes(',');
  let s = x.toFixed(decimals);
  if (grouped) {
    const [int, dec] = s.split('.');
    s = int.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + (dec ? `.${dec}` : '');
  }
  return isPct ? `${s}%` : s;
}

// ── Biblioteca de funciones ──────────────────────────────────────────────────
// `raw: true` = la función recibe los nodos SIN evaluar (necesario para que IF
// no evalúe la rama descartada y para que IFERROR pueda atrapar el error).
const FN = {};
const def = (name, arity, fn, opts = {}) => { FN[name] = { name, arity, fn, ...opts }; };
const arityOk = (a, n) => (Array.isArray(a) ? n >= a[0] && (a[1] == null || n <= a[1]) : n === a);

// —— Lógica ——
def('IF', [2, 3], (args, ev) => {
  const c = toBool(ev(args[0]));
  if (isErr(c)) return c;
  if (c) return ev(args[1]);
  return args.length > 2 ? ev(args[2]) : false;
}, { raw: true });
def('IFS', [2, null], (args, ev) => {
  if (args.length % 2 !== 0) return ERR.VALUE('IFS espera pares condición/valor');
  for (let i = 0; i < args.length; i += 2) {
    const c = toBool(ev(args[i]));
    if (isErr(c)) return c;
    if (c) return ev(args[i + 1]);
  }
  return ERR.NA();
}, { raw: true });
def('IFERROR', 2, (args, ev) => {
  const v = ev(args[0]);
  return isErr(v) ? ev(args[1]) : v;
}, { raw: true });
def('IFBLANK', 2, (args, ev) => {
  const v = ev(args[0]);
  return (v === BLANK || v === undefined || v === '') ? ev(args[1]) : v;
}, { raw: true });
def('SWITCH', [3, null], (args, ev) => {
  const subject = ev(args[0]);
  if (isErr(subject)) return subject;
  let i = 1;
  for (; i + 1 < args.length; i += 2) {
    const c = compare(subject, ev(args[i]));
    if (isErr(c)) return c;
    if (c === 0) return ev(args[i + 1]);
  }
  return i < args.length ? ev(args[i]) : ERR.NA();
}, { raw: true });
def('AND', [1, null], (a) => {
  for (const v of flatten(a, [])) { const b = toBool(v); if (isErr(b)) return b; if (!b) return false; }
  return true;
});
def('OR', [1, null], (a) => {
  for (const v of flatten(a, [])) { const b = toBool(v); if (isErr(b)) return b; if (b) return true; }
  return false;
});
def('NOT', 1, (a) => { const b = toBool(a[0]); return isErr(b) ? b : !b; });

// —— Matemáticas ——
const agg = (name, reduce, empty) => def(name, [1, null], (a) => {
  const nums = numericArgs(a);
  if (isErr(nums)) return nums;
  if (!nums.length) return empty;
  return reduce(nums);
});
agg('SUM', (n) => n.reduce((x, y) => x + y, 0), 0);
agg('PRODUCT', (n) => n.reduce((x, y) => x * y, 1), 0);
agg('AVERAGE', (n) => n.reduce((x, y) => x + y, 0) / n.length, ERR.DIV0());
agg('MIN', (n) => Math.min(...n), 0);
agg('MAX', (n) => Math.max(...n), 0);
def('COUNT', [1, null], (a) => { const n = numericArgs(a); return isErr(n) ? n : n.length; });
def('COUNTA', [1, null], (a) =>
  flatten(a, []).filter(v => !(v === BLANK || v === undefined || v === '')).length);

const num1 = (name, fn) => def(name, 1, (a) => { const n = toNumber(a[0]); return isErr(n) ? n : fn(n); });
num1('ABS', Math.abs);
num1('INT', Math.floor);
num1('SIGN', Math.sign);
num1('SQRT', (n) => (n < 0 ? ERR.NUM('SQRT de un negativo') : Math.sqrt(n)));
def('ROUND', [1, 2], (a) => {
  const n = toNumber(a[0]); if (isErr(n)) return n;
  const d = a.length > 1 ? toNumber(a[1]) : 0; if (isErr(d)) return d;
  const f = 10 ** Math.trunc(d);
  // Excel redondea medio-arriba en magnitud; JS Math.round sesga los negativos.
  return Math.sign(n) * Math.round(Math.abs(n) * f) / f;
});
def('ROUNDUP', [1, 2], (a) => {
  const n = toNumber(a[0]); if (isErr(n)) return n;
  const d = a.length > 1 ? toNumber(a[1]) : 0; if (isErr(d)) return d;
  const f = 10 ** Math.trunc(d);
  return Math.sign(n) * Math.ceil(Math.abs(n) * f) / f;
});
def('ROUNDDOWN', [1, 2], (a) => {
  const n = toNumber(a[0]); if (isErr(n)) return n;
  const d = a.length > 1 ? toNumber(a[1]) : 0; if (isErr(d)) return d;
  const f = 10 ** Math.trunc(d);
  return Math.sign(n) * Math.floor(Math.abs(n) * f) / f;
});
def('CEILING', [1, 2], (a) => {
  const n = toNumber(a[0]); if (isErr(n)) return n;
  const step = a.length > 1 ? toNumber(a[1]) : 1; if (isErr(step)) return step;
  if (!step) return 0;
  return Math.ceil(n / step) * step;
});
def('FLOOR', [1, 2], (a) => {
  const n = toNumber(a[0]); if (isErr(n)) return n;
  const step = a.length > 1 ? toNumber(a[1]) : 1; if (isErr(step)) return step;
  if (!step) return ERR.DIV0();
  return Math.floor(n / step) * step;
});
def('MOD', 2, (a) => {
  const n = toNumber(a[0]), d = toNumber(a[1]);
  if (isErr(n)) return n; if (isErr(d)) return d;
  if (!d) return ERR.DIV0();
  return n - d * Math.floor(n / d);   // signo del divisor, como Excel
});
def('POWER', 2, (a) => {
  const b = toNumber(a[0]), e = toNumber(a[1]);
  if (isErr(b)) return b; if (isErr(e)) return e;
  const r = b ** e;
  return Number.isFinite(r) ? r : ERR.NUM();
});

// —— Texto ——
def('CONCAT', [1, null], (a) => {
  let out = '';
  for (const v of flatten(a, [])) { const s = toText(v); if (isErr(s)) return s; out += s; }
  return out;
});
FN.CONCATENATE = { ...FN.CONCAT, name: 'CONCATENATE' };
const txt1 = (name, fn) => def(name, 1, (a) => { const s = toText(a[0]); return isErr(s) ? s : fn(s); });
txt1('LEN', (s) => s.length);
txt1('UPPER', (s) => s.toUpperCase());
txt1('LOWER', (s) => s.toLowerCase());
txt1('TRIM', (s) => s.trim().replace(/\s+/g, ' '));
txt1('PROPER', (s) => s.toLowerCase().replace(/(^|\s)(\p{L})/gu, (m, sp, ch) => sp + ch.toUpperCase()));
def('LEFT', [1, 2], (a) => {
  const s = toText(a[0]); if (isErr(s)) return s;
  const n = a.length > 1 ? toNumber(a[1]) : 1; if (isErr(n)) return n;
  return n < 0 ? ERR.VALUE() : s.slice(0, Math.trunc(n));
});
def('RIGHT', [1, 2], (a) => {
  const s = toText(a[0]); if (isErr(s)) return s;
  const n = a.length > 1 ? toNumber(a[1]) : 1; if (isErr(n)) return n;
  if (n < 0) return ERR.VALUE();
  return Math.trunc(n) === 0 ? '' : s.slice(-Math.trunc(n));
});
def('MID', 3, (a) => {
  const s = toText(a[0]); if (isErr(s)) return s;
  const start = toNumber(a[1]), len = toNumber(a[2]);
  if (isErr(start)) return start; if (isErr(len)) return len;
  if (start < 1 || len < 0) return ERR.VALUE();
  return s.substr(Math.trunc(start) - 1, Math.trunc(len));
});
def('SUBSTITUTE', 3, (a) => {
  const s = toText(a[0]), find = toText(a[1]), rep = toText(a[2]);
  if (isErr(s)) return s; if (isErr(find)) return find; if (isErr(rep)) return rep;
  return find === '' ? s : s.split(find).join(rep);
});
def('FIND', [2, 3], (a) => {   // sensible a mayúsculas, como Excel
  const find = toText(a[0]), s = toText(a[1]);
  if (isErr(find)) return find; if (isErr(s)) return s;
  const from = a.length > 2 ? toNumber(a[2]) : 1; if (isErr(from)) return from;
  const idx = s.indexOf(find, Math.max(0, Math.trunc(from) - 1));
  return idx === -1 ? ERR.VALUE(`no se encontró "${find}"`) : idx + 1;
});
def('SEARCH', [2, 3], (a) => {  // insensible a mayúsculas, como Excel
  const find = toText(a[0]).toUpperCase(), s = toText(a[1]).toUpperCase();
  if (isErr(find)) return find; if (isErr(s)) return s;
  const from = a.length > 2 ? toNumber(a[2]) : 1; if (isErr(from)) return from;
  const idx = s.indexOf(find, Math.max(0, Math.trunc(from) - 1));
  return idx === -1 ? ERR.VALUE(`no se encontró "${find}"`) : idx + 1;
});
def('TEXT', 2, (a) => applyTextFormat(a[0], toText(a[1])));
def('VALUE', 1, (a) => toNumber(a[0]));
def('REPT', 2, (a) => {
  const s = toText(a[0]); if (isErr(s)) return s;
  const n = toNumber(a[1]); if (isErr(n)) return n;
  if (n < 0) return ERR.VALUE();
  const times = Math.trunc(n);
  if (s.length * times > 5000) return ERR.NUM('texto demasiado largo');
  return s.repeat(times);
});

// —— Información ——
def('ISBLANK', 1, (a) => a[0] === BLANK || a[0] === undefined || a[0] === '');
def('ISNUMBER', 1, (a) => typeof a[0] === 'number' || a[0] instanceof Date);
def('ISTEXT', 1, (a) => typeof a[0] === 'string' && a[0] !== '');
def('ISERROR', 1, (a) => isErr(a[0]), { passErrors: true });
def('N', 1, (a) => { const n = toNumber(a[0]); return isErr(n) ? 0 : n; });

// —— Fechas ——
def('TODAY', 0, () => {
  const now = new Date();
  return toSerial(new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate())));
});
def('NOW', 0, () => toSerial(new Date()));
const datePart = (name, get) => def(name, 1, (a) => {
  const n = toNumber(a[0]); if (isErr(n)) return n;
  return get(fromSerial(n));
});
datePart('YEAR', (d) => d.getUTCFullYear());
datePart('MONTH', (d) => d.getUTCMonth() + 1);
datePart('DAY', (d) => d.getUTCDate());
datePart('WEEKDAY', (d) => d.getUTCDay() + 1);   // 1 = domingo, como Excel
def('DAYS', 2, (a) => {
  const end = toNumber(a[0]), start = toNumber(a[1]);
  if (isErr(end)) return end; if (isErr(start)) return start;
  return Math.round(end - start);
});
def('DATEDIF', 3, (a) => {
  const s = toNumber(a[0]), e = toNumber(a[1]);
  if (isErr(s)) return s; if (isErr(e)) return e;
  const unit = String(toText(a[2])).toUpperCase();
  if (e < s) return ERR.NUM('la fecha final es anterior a la inicial');
  const d1 = fromSerial(s), d2 = fromSerial(e);
  if (unit === 'D') return Math.round(e - s);
  let months = (d2.getUTCFullYear() - d1.getUTCFullYear()) * 12 + (d2.getUTCMonth() - d1.getUTCMonth());
  if (d2.getUTCDate() < d1.getUTCDate()) months--;
  if (unit === 'M') return months;
  if (unit === 'Y') return Math.floor(months / 12);
  return ERR.NUM('unidad válida: "D", "M" o "Y"');
});

/** Catálogo para la UI: firma + ayuda, agrupado por familia. */
export const FUNCTION_CATALOG = [
  { group: 'Lógica', items: [
    ['IF', 'IF(condición, si_verdadero, [si_falso])', 'Devuelve un valor u otro según la condición.'],
    ['IFS', 'IFS(cond1, val1, cond2, val2, …)', 'Primera condición verdadera que encuentre.'],
    ['IFERROR', 'IFERROR(valor, si_error)', 'Sustituye el error por un valor propio.'],
    ['IFBLANK', 'IFBLANK(valor, si_vacío)', 'Sustituye un valor vacío.'],
    ['SWITCH', 'SWITCH(valor, caso1, res1, …, [defecto])', 'Compara contra una lista de casos.'],
    ['AND', 'AND(a, b, …)', 'Verdadero si TODAS se cumplen.'],
    ['OR', 'OR(a, b, …)', 'Verdadero si ALGUNA se cumple.'],
    ['NOT', 'NOT(a)', 'Invierte el valor lógico.'],
  ]},
  { group: 'Números', items: [
    ['SUM', 'SUM(a, b, …)', 'Suma. SUM([sizes]) suma todas las tallas.'],
    ['AVERAGE', 'AVERAGE(a, b, …)', 'Promedio.'],
    ['MIN', 'MIN(a, b, …)', 'El menor.'],
    ['MAX', 'MAX(a, b, …)', 'El mayor.'],
    ['COUNT', 'COUNT(a, b, …)', 'Cuántos son números.'],
    ['COUNTA', 'COUNTA(a, b, …)', 'Cuántos no están vacíos.'],
    ['ROUND', 'ROUND(número, [decimales])', 'Redondea.'],
    ['ROUNDUP', 'ROUNDUP(número, [decimales])', 'Redondea hacia arriba.'],
    ['ROUNDDOWN', 'ROUNDDOWN(número, [decimales])', 'Redondea hacia abajo.'],
    ['CEILING', 'CEILING(número, [múltiplo])', 'Sube al múltiplo (ej. cajas completas).'],
    ['FLOOR', 'FLOOR(número, [múltiplo])', 'Baja al múltiplo.'],
    ['INT', 'INT(número)', 'Parte entera.'],
    ['ABS', 'ABS(número)', 'Valor absoluto.'],
    ['MOD', 'MOD(número, divisor)', 'Resto de la división.'],
    ['POWER', 'POWER(base, exponente)', 'Potencia (igual que ^).'],
    ['SQRT', 'SQRT(número)', 'Raíz cuadrada.'],
    ['PRODUCT', 'PRODUCT(a, b, …)', 'Multiplica todo.'],
    ['SIGN', 'SIGN(número)', '-1, 0 o 1.'],
  ]},
  { group: 'Texto', items: [
    ['CONCAT', 'CONCAT(a, b, …)', 'Une textos (igual que &).'],
    ['TEXT', 'TEXT(valor, "0.00")', 'Da formato: "0.00", "#,##0", "0%", "yyyy-mm-dd".'],
    ['LEFT', 'LEFT(texto, [n])', 'Primeros n caracteres.'],
    ['RIGHT', 'RIGHT(texto, [n])', 'Últimos n caracteres.'],
    ['MID', 'MID(texto, inicio, largo)', 'Trozo del texto (inicio en 1).'],
    ['LEN', 'LEN(texto)', 'Cuántos caracteres.'],
    ['UPPER', 'UPPER(texto)', 'MAYÚSCULAS.'],
    ['LOWER', 'LOWER(texto)', 'minúsculas.'],
    ['PROPER', 'PROPER(texto)', 'Primera Letra De Cada Palabra.'],
    ['TRIM', 'TRIM(texto)', 'Quita espacios sobrantes.'],
    ['SUBSTITUTE', 'SUBSTITUTE(texto, buscar, poner)', 'Reemplaza texto.'],
    ['FIND', 'FIND(buscar, texto, [desde])', 'Posición (distingue mayúsculas).'],
    ['SEARCH', 'SEARCH(buscar, texto, [desde])', 'Posición (no distingue mayúsculas).'],
    ['REPT', 'REPT(texto, veces)', 'Repite el texto.'],
    ['VALUE', 'VALUE(texto)', 'Convierte texto a número.'],
  ]},
  { group: 'Fechas', items: [
    ['TODAY', 'TODAY()', 'Hoy. `[due_date] - TODAY()` da los días que faltan.'],
    ['NOW', 'NOW()', 'Ahora, con hora.'],
    ['YEAR', 'YEAR(fecha)', 'Año.'],
    ['MONTH', 'MONTH(fecha)', 'Mes (1-12).'],
    ['DAY', 'DAY(fecha)', 'Día del mes.'],
    ['WEEKDAY', 'WEEKDAY(fecha)', 'Día de la semana (1 = domingo).'],
    ['DAYS', 'DAYS(final, inicial)', 'Días entre dos fechas.'],
    ['DATEDIF', 'DATEDIF(inicial, final, "D"|"M"|"Y")', 'Diferencia en días, meses o años.'],
  ]},
  { group: 'Info', items: [
    ['ISBLANK', 'ISBLANK(valor)', '¿Está vacío?'],
    ['ISNUMBER', 'ISNUMBER(valor)', '¿Es número?'],
    ['ISTEXT', 'ISTEXT(valor)', '¿Es texto?'],
    ['ISERROR', 'ISERROR(valor)', '¿Dio error?'],
    ['N', 'N(valor)', 'Número, o 0 si no lo es.'],
  ]},
];

// ── Evaluador ────────────────────────────────────────────────────────────────
function evalNode(node, ctx) {
  switch (node.k) {
    case 'num': return node.v;
    case 'str': return node.v;
    case 'bool': return node.v;
    case 'ref': return ctx.resolve(node.name);

    case 'neg': {
      const n = toNumber(evalNode(node.a, ctx));
      return isErr(n) ? n : -n;
    }
    case 'pct': {
      const n = toNumber(evalNode(node.a, ctx));
      return isErr(n) ? n : n / 100;
    }

    case 'bin': {
      const op = node.op;
      const a = evalNode(node.a, ctx);
      if (isErr(a)) return a;
      const b = evalNode(node.b, ctx);
      if (isErr(b)) return b;

      if (op === '&') {
        const sa = toText(a), sb = toText(b);
        if (isErr(sa)) return sa; if (isErr(sb)) return sb;
        return sa + sb;
      }
      if (INFIX_BP[op] === 10) {
        const c = compare(a, b);
        if (isErr(c)) return c;
        switch (op) {
          case '=': return c === 0;
          case '<>': return c !== 0;
          case '<': return c < 0;
          case '>': return c > 0;
          case '<=': return c <= 0;
          default: return c >= 0;    // '>='
        }
      }
      const na = toNumber(a); if (isErr(na)) return na;
      const nb = toNumber(b); if (isErr(nb)) return nb;
      switch (op) {
        case '+': return na + nb;
        case '-': return na - nb;
        case '*': return na * nb;
        case '/': return nb === 0 ? ERR.DIV0() : na / nb;
        default: {                    // '^'
          const r = na ** nb;
          return Number.isFinite(r) ? r : ERR.NUM();
        }
      }
    }

    case 'call': {
      const spec = FN[node.name];
      if (!spec) return ERR.NAME(`No existe la función ${node.name}()`);
      if (!arityOk(spec.arity, node.args.length)) {
        const a = spec.arity;
        const esperado = Array.isArray(a)
          ? `${a[0]}${a[1] == null ? ' o más' : `-${a[1]}`}`
          : String(a);
        return ERR.VALUE(`${node.name}() espera ${esperado} argumento(s), recibió ${node.args.length}`);
      }
      if (spec.raw) return spec.fn(node.args, (n) => evalNode(n, ctx));
      const args = node.args.map(n => evalNode(n, ctx));
      if (!spec.passErrors) {
        const bad = args.find(isErr);
        if (bad) return bad;
      }
      return spec.fn(args, (n) => evalNode(n, ctx));
    }

    default:
      return ERR.VALUE('nodo desconocido');
  }
}

// ── Resolución de referencias ────────────────────────────────────────────────
const normKey = (s) => String(s ?? '').trim().toLowerCase().replace(/\s+/g, '_');

/**
 * Construye el resolvedor de una fila. Orden de búsqueda de `nombre`:
 *   1. columna por `key`      2. columna por `label`      3. campo crudo de la fila
 * Una columna de tipo fórmula se evalúa en cascada, con corte de ciclos (#REF!).
 * Lo que no se encuentra es #NAME? — NUNCA 0 en silencio, que era justo el
 * modo de fallo del motor anterior.
 */
function makeResolver(row, cols, stack) {
  const byKey = new Map();
  const byLabel = new Map();
  for (const c of cols || []) {
    if (c?.key) byKey.set(normKey(c.key), c);
    if (c?.label) byLabel.set(normKey(c.label), c);
  }
  const rowKeys = new Map();
  for (const k of Object.keys(row || {})) rowKeys.set(normKey(k), k);

  return function resolve(name) {
    const n = normKey(name);
    const col = byKey.get(n) || byLabel.get(n);

    if (col && col.type === 'formula') {
      if (stack.has(col.key)) return ERR.REF(`Referencia circular en [${col.label || col.key}]`);
      if (stack.size > 24) return ERR.REF('Demasiadas fórmulas encadenadas');
      const parsed = parseFormula(col.formula);
      if (parsed.error) return ERR.NAME(`[${col.label || col.key}] tiene una fórmula inválida`);
      stack.add(col.key);
      try {
        return evalNode(parsed.ast, { resolve: makeResolver(row, cols, stack) });
      } finally {
        stack.delete(col.key);
      }
    }

    const key = col?.key ?? rowKeys.get(n);
    if (key === undefined) return ERR.NAME(`No existe la columna "${name}"`);

    const raw = (row || {})[key];
    if (raw === undefined || raw === null || raw === '') return BLANK;
    if (typeof raw === 'boolean' || typeof raw === 'number') return raw;
    if (typeof raw === 'object') return raw;   // p.ej. `sizes` → útil en SUM()
    // Un texto que en realidad es fecha se deja como texto: toNumber() ya lo
    // convierte a serial cuando hace falta, y toText() lo muestra tal cual.
    return String(raw);
  };
}

// ── API pública ──────────────────────────────────────────────────────────────

/** Valor crudo (número | texto | booleano | FormulaError). */
export function evalFormula(src, row, cols) {
  const parsed = parseFormula(src);
  if (parsed.error) return ERR.NAME(parsed.error.message);
  try {
    return evalNode(parsed.ast, { resolve: makeResolver(row, cols, new Set()) });
  } catch {
    return ERR.VALUE('No se pudo calcular');
  }
}

/** Cómo se muestra en una celda o se escribe en el Excel exportado. */
export function formatResult(v) {
  if (isErr(v)) return v.code;
  if (v === BLANK || v === undefined) return '';
  if (typeof v === 'boolean') return v ? 'VERDADERO' : 'FALSO';
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) return '#NUM!';
    return Number.isInteger(v) ? String(v) : String(parseFloat(v.toFixed(2)));
  }
  return String(v);
}

/**
 * Firma histórica, para no tocar los llamadores existentes:
 * evaluateFormula(field, order, allCols) -> string listo para pintar.
 */
export function evaluateFormula(field, order, allCols) {
  const col = allCols?.find(c => c.key === field);
  if (!col?.formula) return '';
  return formatResult(evalFormula(col.formula, order, allCols));
}

/** Igual que evaluateFormula pero conservando el tipo (para exportar a Excel). */
export function evaluateFormulaValue(field, order, allCols) {
  const col = allCols?.find(c => c.key === field);
  if (!col?.formula) return '';
  const v = evalFormula(col.formula, order, allCols);
  if (isErr(v)) return v.code;
  if (v === BLANK || v === undefined) return '';
  if (typeof v === 'boolean') return v ? 'VERDADERO' : 'FALSO';
  if (typeof v === 'number') return Number.isFinite(v) ? v : '#NUM!';
  return String(v);
}

/**
 * Valida una fórmula para la UI del editor.
 * -> { ok, message, unknownRefs[] }  (unknownRefs = columnas que no existen)
 */
export function validateFormula(src, cols) {
  const parsed = parseFormula(src);
  if (parsed.error) return { ok: false, message: parsed.error.message, unknownRefs: [] };

  const known = new Set();
  for (const c of cols || []) {
    if (c?.key) known.add(normKey(c.key));
    if (c?.label) known.add(normKey(c.label));
  }
  const unknown = new Set();
  (function walk(n) {
    if (!n || typeof n !== 'object') return;
    if (n.k === 'ref' && !known.has(normKey(n.name))) unknown.add(n.name);
    for (const child of [n.a, n.b, ...(n.args || [])]) walk(child);
  })(parsed.ast);

  return { ok: true, message: '', unknownRefs: [...unknown] };
}

export const isFormulaError = isErr;
