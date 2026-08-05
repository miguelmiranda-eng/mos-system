import { useMemo } from "react";

/**
 * Celda de posiciones de impresión: tres casillas F / E / M por orden.
 *
 * POR QUÉ EXISTE ESTA COLUMNA
 * ───────────────────────────
 * El sistema nunca supo cuántas posiciones lleva una orden, y sin ese dato no se
 * puede saber si una talla está terminada: 216 frentes de 216 pedidas es "listo"
 * si la orden solo lleva frente, y "a la mitad" si lleva frente y espalda. Por
 * eso el modal de producción reporta como terminadas 214 órdenes que no lo están.
 *
 * DEDUCIDO vs CONFIRMADO
 * ──────────────────────
 * El backfill dedujo las posiciones de la producción ya registrada (1,097
 * órdenes). Eso es un PISO, no la verdad: una orden que lleva frente y espalda
 * pero a la que solo se le registró el frente se dedujo como "solo frente". Esas
 * se pintan con un punto ámbar. En cuanto alguien toca la celda, el backend borra
 * la marca (ver routers/orders.py) y el punto desaparece: ya es un dato
 * capturado, no una suposición.
 */

// Mismo conjunto cerrado que DESIGN_POSITIONS en el backend y DESIGN_TYPES en el
// modal de producción. Si aquí se agrega una, hay que agregarla en los tres.
const POSICIONES = [
  { valor: 'FRENTE', letra: 'F' },
  { valor: 'ESPALDA', letra: 'E' },
  { valor: 'MANGA', letra: 'M' },
];

const VACIO = Object.freeze([]);

/** Normaliza a las posiciones válidas, en orden canónico. */
export const normalizarPosiciones = (value) => {
  if (!Array.isArray(value)) return VACIO;
  const s = new Set(value.map(v => String(v || '').trim().toUpperCase()));
  return POSICIONES.filter(p => s.has(p.valor)).map(p => p.valor);
};

/**
 * Las tres casillas, sin saber nada de órdenes ni de guardado.
 *
 * Se usa en dos lados: la celda del tablero (PositionsCell, abajo) y el
 * formulario de nueva orden, donde data entry las marca al capturar. Una sola
 * definición del control para que las dos pantallas no puedan divergir en qué
 * posiciones existen ni en qué orden se guardan.
 */
export const PositionsPicker = ({ value, onChange, readOnly = false, tamano = 'sm' }) => {
  const activas = useMemo(() => normalizarPosiciones(value), [value]);
  const alternar = (valor) => {
    if (readOnly) return;
    const set = new Set(activas);
    if (set.has(valor)) set.delete(valor); else set.add(valor);
    onChange(POSICIONES.filter(p => set.has(p.valor)).map(p => p.valor));
  };
  const dim = tamano === 'lg' ? 'w-9 h-8 text-[11px]' : 'w-6 h-6 text-[10px]';
  return (
    <>
      {POSICIONES.map(({ valor, letra }) => {
        const on = activas.includes(valor);
        return (
          <button
            key={valor}
            type="button"
            disabled={readOnly}
            onClick={() => alternar(valor)}
            aria-pressed={on}
            title={valor}
            data-testid={`position-${letra}`}
            className={`${dim} rounded font-black border transition-colors ${
              on
                ? 'bg-primary/20 border-primary text-primary'
                : 'bg-secondary/40 border-border text-muted-foreground/40 hover:text-muted-foreground'
            } ${readOnly ? 'cursor-default opacity-70' : ''}`}
          >
            {letra}
          </button>
        );
      })}
    </>
  );
};

export const PositionsCell = ({ value, orderId, inferred = false, onUpdate, readOnly = false }) => {
  const activas = useMemo(() => normalizarPosiciones(value), [value]);
  const sinCapturar = activas.length === 0;
  const titulo = sinCapturar
    ? 'Sin posiciones capturadas — el avance por talla no se puede calcular'
    : `${activas.join(' + ')}${inferred ? '  (deducido de la producción registrada, sin confirmar)' : ''}`;

  return (
    <div className="flex items-center gap-1 min-h-[32px] px-1" title={titulo}
         data-testid={`positions-cell-${orderId}`}>
      <PositionsPicker
        value={activas}
        readOnly={readOnly}
        onChange={(pos) => onUpdate(orderId, 'print_positions', pos)}
      />
      {/* Punto ámbar = lo dedujo el sistema, nadie lo confirmó. */}
      {inferred && !sinCapturar && (
        <span className="w-1.5 h-1.5 rounded-full bg-amber-500 flex-shrink-0"
              title="Deducido de la producción registrada — confírmalo tocando las casillas" />
      )}
    </div>
  );
};

export default PositionsCell;
