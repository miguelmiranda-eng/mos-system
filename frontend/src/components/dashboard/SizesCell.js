import { useState, useMemo, useEffect } from "react";
import * as Popover from "@radix-ui/react-popover";
import { Check, X, AlertTriangle } from "lucide-react";
import { useWmsSizes } from "../wms/lib";

/**
 * Celda de tallas del tablero: mini-tabla legible de un vistazo, editable al clic.
 *
 * VISTA — sólo las tallas con cantidad. Una orden real trae 4 o 5 de las nueve
 * posibles (medido: L/XL/M/S/2X cubren casi todo; 4X aparece en 1 orden de 400),
 * así que pintar las nueve siempre desperdiciaría el ancho de la columna en
 * ceros. Las vacías aparecen al editar, que es cuando importan.
 *
 * TOTAL EN ROJO — el total se calcula de las tallas y se compara contra `Qty`.
 * El 8% de las órdenes con tallas no cuadran (31 de 400 medidas). No se corrige
 * nada solo: se marca para que producción lo vea. Ver routers/orders.py, donde
 * `quantity` se recalcula ÚNICAMENTE cuando alguien edita las tallas.
 *
 * TALLAS FUERA DE CATÁLOGO — hay órdenes con '2XL'/'3XL'/'4XL' en vez de la
 * notación canónica '2X'/'3X'/'4X'. El editor añade al final cualquier talla que
 * la orden ya tenga y el catálogo no contemple, porque una grilla de columnas
 * fijas las habría hecho invisibles (y editables a ciegas: guardar habría
 * borrado la cantidad que nadie vio).
 */

const num = (v) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
};

// Identidad estable para las órdenes sin tallas. Un `{}` literal sería un objeto
// nuevo en cada render y haría recalcular los useMemo de abajo siempre; el
// tablero pinta miles de celdas y EditableCell está memoizado justo por eso.
const SIN_TALLAS = Object.freeze({});

export const sumaTallas = (sizes) =>
  (sizes && typeof sizes === "object")
    ? Object.values(sizes).reduce((s, v) => s + num(v), 0)
    : 0;

/**
 * Avance de una talla, contra las posiciones que la orden realmente lleva.
 *
 * `positions` son las que la orden requiere (["FRENTE","ESPALDA"]) y `producido`
 * es {FRENTE: n, ESPALDA: n} de esa talla. Se toma la posición MENOS avanzada,
 * no la suma: una prenda no está lista hasta que todas sus posiciones están
 * impresas, así que 216 frentes y 0 espaldas de 216 pedidas es 0% terminado,
 * no 50%. Sumar daría "listo" cuando falta la mitad del trabajo — exactamente
 * el error que hoy comete el Producido/Restante del modal.
 *
 * Devuelve null cuando no se puede afirmar nada: sin posiciones capturadas no
 * hay contra qué medir, y una barra inventada es peor que ninguna barra.
 */
const avanceDeTalla = (pedidas, posiciones, producido) => {
  if (!pedidas || !Array.isArray(posiciones) || posiciones.length === 0) return null;
  const porPosicion = posiciones.map(p => ({ p, n: Math.max(0, parseInt(producido?.[p], 10) || 0) }));
  const menor = Math.min(...porPosicion.map(x => x.n));
  return {
    porPosicion,
    hechas: menor,                                        // prendas realmente listas
    pct: Math.min(100, Math.round((menor / pedidas) * 100)),
    completa: menor >= pedidas,
  };
};

export const SizesCell = ({ value, orderId, quantity, positions, produced, onUpdate, readOnly = false }) => {
  const { adult: CATALOGO } = useWmsSizes();
  const [abierto, setAbierto] = useState(false);
  const [borrador, setBorrador] = useState({});

  const sizes = (value && typeof value === "object") ? value : SIN_TALLAS;

  // Catálogo + lo que la orden traiga y el catálogo no contemple.
  const columnas = useMemo(() => {
    const extras = Object.keys(sizes).filter(k => !CATALOGO.includes(k));
    return [...CATALOGO, ...extras];
  }, [CATALOGO, sizes]);

  const conValor = useMemo(
    () => columnas.filter(sz => num(sizes[sz]) > 0),
    [columnas, sizes]
  );

  const total = sumaTallas(sizes);
  const qty = Number(quantity) || 0;
  const descuadra = total > 0 && qty > 0 && total !== qty;

  useEffect(() => {
    if (abierto) {
      const b = {};
      columnas.forEach(sz => { b[sz] = num(sizes[sz]) ? String(num(sizes[sz])) : ""; });
      setBorrador(b);
    }
  }, [abierto]);   // eslint-disable-line react-hooks/exhaustive-deps

  const totalBorrador = Object.values(borrador).reduce((s, v) => s + num(v), 0);

  const guardar = () => {
    // Se guardan sólo las tallas con cantidad — así están hoy los datos
    // ({S:41, M:42, …} sin ceros) y así se quedan.
    const limpio = {};
    columnas.forEach(sz => { if (num(borrador[sz]) > 0) limpio[sz] = num(borrador[sz]); });
    onUpdate(orderId, "sizes", limpio);
    setAbierto(false);
  };

  // Cuántas tallas caben antes de exprimir el total fuera de la celda. Medido
  // contra los datos reales: el 89% de las órdenes trae 5 tallas o menos, un 10%
  // trae 6-7, y hay 3 órdenes con 8-10 (la peor: 10 tallas con cifras de 4
  // dígitos). A partir de 6 se aprieta la tipografía; pasando de MAX_VISIBLES se
  // recorta con un "+N" — el desglose completo sigue en el tooltip y en el
  // editor, así que no se pierde nada, sólo deja de caber.
  const MAX_VISIBLES = 7;
  const apretado = conValor.length >= 6;
  const visibles = conValor.slice(0, MAX_VISIBLES);
  const ocultas = conValor.length - visibles.length;

  // Avance por talla. Se calcula para TODAS (no solo las visibles) porque el
  // tooltip las lista completas.
  const avances = useMemo(() => {
    const out = {};
    conValor.forEach(sz => {
      out[sz] = avanceDeTalla(num(sizes[sz]), positions, produced?.[sz]);
    });
    return out;
  }, [conValor, sizes, positions, produced]);

  const hayAvance = Object.values(avances).some(a => a && a.hechas > 0);

  const desglose = conValor.map(sz => {
    const a = avances[sz];
    if (!a) return `${sz}: ${num(sizes[sz])} pedidas`;
    const detalle = a.porPosicion.map(x => `${x.p} ${x.n}`).join(" · ");
    return `${sz}: ${num(sizes[sz])} pedidas — ${detalle}${a.completa ? "  ✓ lista" : ""}`;
  }).join("\n");

  const nota = !positions || positions.length === 0
    ? "\nSin posiciones de impresión capturadas: no se puede calcular el avance."
    : "";

  const tituloCelda = conValor.length === 0
    ? undefined
    : (descuadra
        ? `${desglose}\n\nSuma ${total} — no coincide con Qty ${qty}`
        : `${desglose}\n\nTotal ${total}`) + nota;

  const Resumen = (
    <div
      className="flex items-center gap-1.5 min-h-[32px] px-1 w-full"
      data-testid={`sizes-cell-${orderId}`}
      title={tituloCelda}
    >
      {conValor.length === 0 ? (
        <span className="text-xs text-muted-foreground/50 italic">
          {readOnly ? "—" : "sin tallas"}
        </span>
      ) : (
        <>
          {/* min-w-0 + overflow-hidden: sin esto el ancho natural de la tabla
              gana (min-width:auto de flex) y empuja el total fuera de la celda.
              Con 7 tallas de 4 cifras eso dejaba el total invisible — que es
              justo el dato que no puede faltar, porque es el que avisa del
              descuadre. */}
          <div className="min-w-0 overflow-hidden">
            <table className={`tabular-nums border-separate ${apretado ? "border-spacing-x-0.5" : "border-spacing-x-1"}`}>
              <tbody>
                <tr>
                  {visibles.map(sz => (
                    <td key={sz} className="text-[8px] font-black uppercase tracking-wider text-muted-foreground/70 text-center px-0.5 leading-tight">
                      {sz}
                    </td>
                  ))}
                </tr>
                <tr>
                  {visibles.map(sz => (
                    <td key={sz} className={`${apretado ? "text-[10px]" : "text-[11px]"} font-mono font-bold text-foreground text-center px-0.5 leading-tight`}>
                      {num(sizes[sz])}
                    </td>
                  ))}
                </tr>
                {/* Franja de avance: 3px bajo cada cantidad. Solo se dibuja si
                    hay algo producido en alguna talla — una fila de barras
                    vacías en cada renglón del tablero sería puro ruido. */}
                {hayAvance && (
                  <tr>
                    {visibles.map(sz => {
                      const a = avances[sz];
                      return (
                        <td key={sz} className="px-0.5 pt-0.5">
                          <div className="h-[3px] w-full bg-muted/40 rounded-full overflow-hidden">
                            {a && (
                              <div
                                className={`h-full rounded-full ${a.completa ? "bg-green-500" : "bg-primary"}`}
                                style={{ width: `${a.pct}%` }}
                              />
                            )}
                          </div>
                        </td>
                      );
                    })}
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          {ocultas > 0 && (
            <span className="text-[9px] font-bold text-muted-foreground/70 flex-shrink-0">
              +{ocultas}
            </span>
          )}

          <span
            className={`ml-auto text-[10px] font-black tabular-nums flex items-center gap-0.5 flex-shrink-0 ${
              descuadra ? "text-destructive" : "text-primary/70"
            }`}
          >
            {descuadra && <AlertTriangle className="w-3 h-3" />}
            {total}
          </span>
        </>
      )}
    </div>
  );

  if (readOnly) return Resumen;

  return (
    <Popover.Root open={abierto} onOpenChange={setAbierto}>
      <Popover.Trigger asChild>
        <button
          type="button"
          className="w-full text-left hover:bg-primary/5 rounded transition-colors"
          title="Clic para editar las tallas"
        >
          {Resumen}
        </button>
      </Popover.Trigger>

      <Popover.Portal>
        {/* z-[1000] igual que SearchableSelect: por encima de la tabla y también
            del overlay de un Dialog (z-900), por si la celda se abre desde un
            modal. Ojo — NO bajar este número: tailwind-merge deja ganar al
            último z-*, y por debajo de 900 el panel se pinta detrás del overlay. */}
        {/* SIN clases de animación, a propósito. Con Radix Popover 1.1.15 +
            React 19.2.4 (las versiones de este proyecto), un Popover.Content
            animado NO se desmonta al cerrarse: el estado pasa a
            data-state="closed" pero el nodo se queda en el DOM, visible y
            capturando clics. Reproducido tanto en el dev server como en el
            build de producción, y también con SearchableSelect —que ya usa ese
            patrón— así que no es de este componente.
            Sin animación, Presence desmonta de inmediato. Si algún día se
            actualiza Radix, se pueden devolver emparejadas al data-state
            (ver ui/dialog.jsx) y RE-VERIFICAR que cierre. */}
        <Popover.Content
          className="z-[1000] bg-popover border border-border rounded-xl shadow-2xl p-3"
          sideOffset={6}
          align="start"
          data-testid="sizes-editor"
        >
          <div className="flex items-center justify-between mb-2 gap-6">
            <span className="text-[10px] font-black uppercase tracking-widest text-muted-foreground">
              Tallas
            </span>
            <span className="text-[10px] text-muted-foreground">
              Total{" "}
              <b className={`tabular-nums text-sm ${totalBorrador !== qty && qty > 0 ? "text-destructive" : "text-primary"}`}>
                {totalBorrador}
              </b>
            </span>
          </div>

          <div className="flex gap-1">
            {columnas.map(sz => {
              const fueraDeCatalogo = !CATALOGO.includes(sz);
              return (
                <div key={sz} className="flex flex-col items-center gap-1">
                  <label
                    className={`text-[9px] font-black uppercase tracking-wider ${
                      fueraDeCatalogo ? "text-amber-500" : "text-muted-foreground/70"
                    }`}
                    title={fueraDeCatalogo ? `"${sz}" no está en el catálogo de tallas — la notación del sistema es 2X/3X/4X` : undefined}
                  >
                    {sz}
                  </label>
                  <input
                    type="number"
                    min="0"
                    placeholder="0"
                    value={borrador[sz] ?? ""}
                    onChange={(e) => setBorrador(p => ({ ...p, [sz]: e.target.value }))}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") guardar();
                      if (e.key === "Escape") setAbierto(false);
                    }}
                    style={{ backgroundColor: "hsl(var(--secondary))", color: "hsl(var(--foreground))" }}
                    className="w-11 border border-border rounded px-1 py-1 text-xs font-mono text-center focus:border-primary focus:ring-1 focus:ring-primary outline-none"
                    data-testid={`sizes-input-${sz}`}
                  />
                </div>
              );
            })}
          </div>

          {qty > 0 && totalBorrador !== qty && (
            <p className="mt-2 text-[10px] text-destructive flex items-start gap-1">
              <AlertTriangle className="w-3 h-3 mt-px flex-shrink-0" />
              <span>Qty quedará en <b>{totalBorrador}</b> (hoy dice {qty}).</span>
            </p>
          )}

          <div className="flex justify-end gap-1.5 mt-3">
            <button
              type="button"
              onClick={() => setAbierto(false)}
              className="px-2.5 py-1 rounded text-[10px] font-bold uppercase tracking-wide text-muted-foreground hover:bg-secondary flex items-center gap-1"
            >
              <X className="w-3 h-3" />Cancelar
            </button>
            <button
              type="button"
              onClick={guardar}
              className="px-3 py-1 rounded bg-primary text-primary-foreground text-[10px] font-black uppercase tracking-wide hover:bg-primary/90 flex items-center gap-1"
              data-testid="sizes-save"
            >
              <Check className="w-3 h-3" />Guardar
            </button>
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
};

export default SizesCell;
