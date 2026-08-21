/**
 * Catálogo de funciones para la ayuda paso a paso (autocompletar + firma).
 *
 * Es la MISMA lista que evalúa engine/formula.js; aquí se le agrega la ayuda que
 * ve el usuario: sintaxis, resumen y descripción de cada argumento. Si mañana se
 * agrega una función al motor, se documenta aquí y aparece sola en el asistente.
 */

export const FUNCIONES = [
  {
    nombre: 'SUM', sintaxis: 'SUM(valor1, [valor2, ...])',
    resumen: 'Suma todos los números de un rango o lista.',
    args: [{ nombre: 'valor1', desc: 'Primer número o rango a sumar.' }, { nombre: 'valor2, …', desc: 'Números o rangos adicionales (opcional).' }],
    ejemplo: '=SUM(A1:A10)',
  },
  {
    nombre: 'AVERAGE', sintaxis: 'AVERAGE(valor1, [valor2, ...])',
    resumen: 'Promedio (media) de los números. Ignora texto y celdas vacías.',
    args: [{ nombre: 'valor1', desc: 'Primer número o rango.' }, { nombre: 'valor2, …', desc: 'Adicionales (opcional).' }],
    ejemplo: '=AVERAGE(B2:B20)',
  },
  {
    nombre: 'MIN', sintaxis: 'MIN(valor1, [valor2, ...])',
    resumen: 'El valor más pequeño del conjunto.',
    args: [{ nombre: 'valor1', desc: 'Número o rango.' }, { nombre: 'valor2, …', desc: 'Adicionales (opcional).' }],
    ejemplo: '=MIN(A1:A10)',
  },
  {
    nombre: 'MAX', sintaxis: 'MAX(valor1, [valor2, ...])',
    resumen: 'El valor más grande del conjunto.',
    args: [{ nombre: 'valor1', desc: 'Número o rango.' }, { nombre: 'valor2, …', desc: 'Adicionales (opcional).' }],
    ejemplo: '=MAX(A1:A10)',
  },
  {
    nombre: 'COUNT', sintaxis: 'COUNT(valor1, [valor2, ...])',
    resumen: 'Cuenta cuántas celdas contienen NÚMEROS.',
    args: [{ nombre: 'valor1', desc: 'Rango o valor.' }, { nombre: 'valor2, …', desc: 'Adicionales (opcional).' }],
    ejemplo: '=COUNT(A1:A100)',
  },
  {
    nombre: 'COUNTA', sintaxis: 'COUNTA(valor1, [valor2, ...])',
    resumen: 'Cuenta las celdas que NO están vacías (texto o número).',
    args: [{ nombre: 'valor1', desc: 'Rango o valor.' }, { nombre: 'valor2, …', desc: 'Adicionales (opcional).' }],
    ejemplo: '=COUNTA(A1:A100)',
  },
  {
    nombre: 'IF', sintaxis: 'IF(condición, valor_si_verdadero, [valor_si_falso])',
    resumen: 'Devuelve un valor si la condición se cumple y otro si no.',
    args: [
      { nombre: 'condición', desc: 'Prueba lógica, p. ej. A1>10.' },
      { nombre: 'valor_si_verdadero', desc: 'Qué devolver si se cumple.' },
      { nombre: 'valor_si_falso', desc: 'Qué devolver si no (opcional).' },
    ],
    ejemplo: '=IF(A1>=60, "Aprobado", "Reprobado")',
  },
  {
    nombre: 'SUMIF', sintaxis: 'SUMIF(rango, criterio, [rango_suma])',
    resumen: 'Suma las celdas que cumplen un criterio.',
    args: [
      { nombre: 'rango', desc: 'Rango donde se evalúa el criterio.' },
      { nombre: 'criterio', desc: 'Condición, p. ej. ">100" o "Ana".' },
      { nombre: 'rango_suma', desc: 'Rango a sumar si es distinto (opcional).' },
    ],
    ejemplo: '=SUMIF(B2:B20, ">100")',
  },
  {
    nombre: 'COUNTIF', sintaxis: 'COUNTIF(rango, criterio)',
    resumen: 'Cuenta las celdas que cumplen un criterio.',
    args: [
      { nombre: 'rango', desc: 'Rango a revisar.' },
      { nombre: 'criterio', desc: 'Condición, p. ej. ">=10" o "Sí".' },
    ],
    ejemplo: '=COUNTIF(C2:C50, "Pagado")',
  },
  {
    nombre: 'ROUND', sintaxis: 'ROUND(número, [decimales])',
    resumen: 'Redondea un número a los decimales indicados.',
    args: [{ nombre: 'número', desc: 'Valor a redondear.' }, { nombre: 'decimales', desc: 'Cuántos decimales (0 por defecto).' }],
    ejemplo: '=ROUND(A1, 2)',
  },
  {
    nombre: 'ABS', sintaxis: 'ABS(número)',
    resumen: 'Valor absoluto (sin signo) de un número.',
    args: [{ nombre: 'número', desc: 'Valor.' }],
    ejemplo: '=ABS(A1-B1)',
  },
  {
    nombre: 'AND', sintaxis: 'AND(lógico1, [lógico2, ...])',
    resumen: 'VERDADERO solo si TODAS las condiciones se cumplen.',
    args: [{ nombre: 'lógico1', desc: 'Primera condición.' }, { nombre: 'lógico2, …', desc: 'Más condiciones (opcional).' }],
    ejemplo: '=AND(A1>0, A1<100)',
  },
  {
    nombre: 'OR', sintaxis: 'OR(lógico1, [lógico2, ...])',
    resumen: 'VERDADERO si AL MENOS UNA condición se cumple.',
    args: [{ nombre: 'lógico1', desc: 'Primera condición.' }, { nombre: 'lógico2, …', desc: 'Más condiciones (opcional).' }],
    ejemplo: '=OR(A1="Sí", B1="Sí")',
  },
  {
    nombre: 'NOT', sintaxis: 'NOT(lógico)',
    resumen: 'Invierte un valor lógico.',
    args: [{ nombre: 'lógico', desc: 'Condición a invertir.' }],
    ejemplo: '=NOT(A1="")',
  },
  {
    nombre: 'IFERROR', sintaxis: 'IFERROR(valor, valor_si_error)',
    resumen: 'Devuelve un valor alterno si la fórmula da error.',
    args: [{ nombre: 'valor', desc: 'Fórmula que puede dar error.' }, { nombre: 'valor_si_error', desc: 'Qué mostrar si hay error.' }],
    ejemplo: '=IFERROR(A1/B1, 0)',
  },
  {
    nombre: 'CONCAT', sintaxis: 'CONCAT(texto1, [texto2, ...])',
    resumen: 'Une varios textos en uno solo.',
    args: [{ nombre: 'texto1', desc: 'Primer texto o celda.' }, { nombre: 'texto2, …', desc: 'Textos adicionales (opcional).' }],
    ejemplo: '=CONCAT(A1, " ", B1)',
  },
  {
    nombre: 'LEN', sintaxis: 'LEN(texto)',
    resumen: 'Cantidad de caracteres de un texto.',
    args: [{ nombre: 'texto', desc: 'Texto o celda.' }],
    ejemplo: '=LEN(A1)',
  },
  {
    nombre: 'UPPER', sintaxis: 'UPPER(texto)',
    resumen: 'Convierte el texto a MAYÚSCULAS.',
    args: [{ nombre: 'texto', desc: 'Texto o celda.' }],
    ejemplo: '=UPPER(A1)',
  },
  {
    nombre: 'LOWER', sintaxis: 'LOWER(texto)',
    resumen: 'Convierte el texto a minúsculas.',
    args: [{ nombre: 'texto', desc: 'Texto o celda.' }],
    ejemplo: '=LOWER(A1)',
  },
  {
    nombre: 'TRIM', sintaxis: 'TRIM(texto)',
    resumen: 'Quita los espacios sobrantes al inicio y al final.',
    args: [{ nombre: 'texto', desc: 'Texto o celda.' }],
    ejemplo: '=TRIM(A1)',
  },
  {
    nombre: 'SQRT', sintaxis: 'SQRT(número)',
    resumen: 'Raíz cuadrada de un número.',
    args: [{ nombre: 'número', desc: 'Valor (no negativo).' }],
    ejemplo: '=SQRT(A1)',
  },
  {
    nombre: 'POWER', sintaxis: 'POWER(base, exponente)',
    resumen: 'Eleva un número a una potencia.',
    args: [{ nombre: 'base', desc: 'Número base.' }, { nombre: 'exponente', desc: 'Potencia.' }],
    ejemplo: '=POWER(2, 10)',
  },
];

// Búsqueda por prefijo (para autocompletar). CONCATENATE es alias de CONCAT.
const POR_NOMBRE = new Map(FUNCIONES.map(f => [f.nombre, f]));
POR_NOMBRE.set('CONCATENATE', POR_NOMBRE.get('CONCAT'));

export function buscarFunciones(prefijo) {
  const p = String(prefijo || '').toUpperCase();
  if (!p) return [];
  return FUNCIONES.filter(f => f.nombre.startsWith(p));
}

export function funcionPorNombre(nombre) {
  return POR_NOMBRE.get(String(nombre || '').toUpperCase()) || null;
}

/**
 * Analiza el texto de la fórmula hasta el cursor y decide qué mostrar:
 *  - `prefijo`: función que se está tecleando (para el autocompletar).
 *  - `firma`: función que envuelve al cursor y el índice del argumento activo.
 */
export function analizarFormula(texto, caret) {
  if (!texto || texto[0] !== '=') return { prefijo: '', firma: null };
  const antes = texto.slice(0, caret);

  // Palabra de letras justo antes del cursor = función en construcción.
  const m = /([A-Za-z]+)$/.exec(antes);
  const prefijo = m ? m[1] : '';

  // Firma: caminar hacia atrás buscando el '(' que envuelve el cursor.
  let depth = 0;
  let firma = null;
  for (let i = antes.length - 1; i >= 0; i--) {
    const ch = antes[i];
    if (ch === ')') depth++;
    else if (ch === '(') {
      if (depth === 0) {
        const mm = /([A-Za-z]+)$/.exec(antes.slice(0, i));
        const fn = mm ? funcionPorNombre(mm[1]) : null;
        if (fn) {
          // Contar comas al nivel de esta función = argumento activo.
          let comas = 0; let d2 = 0;
          for (let j = i + 1; j < antes.length; j++) {
            const c = antes[j];
            if (c === '(') d2++;
            else if (c === ')') d2--;
            else if (c === ',' && d2 === 0) comas++;
          }
          firma = { fn, argActivo: comas };
        }
        break;
      }
      depth--;
    }
  }

  return { prefijo, firma };
}
