/* Hits (impresiones) vs piezas, con las mismas reglas que el backend
   (services/planner_engine.positions_of y services/production_kpis.measure):

   - Hits por pieza = hits_impresiones; si viene vacío o menor que las
     posiciones capturadas, cuenta una por posición; sin nada, 1.
   - Hits de la orden = piezas × hits por pieza.
   - Producido: cada captura es una pasada en una posición, así que la suma
     son HITS y las PIEZAS son la posición más grande
     (frente 500 + espalda 500 = 1,000 hits, 500 piezas). */

export const hitsPerPiece = (o) => {
  const hits = parseInt(o?.hits_impresiones, 10) || 0;
  const positions = (Array.isArray(o?.print_positions) ? o.print_positions : []).filter(Boolean).length;
  return Math.max(hits, positions) || 1;
};

export const orderHits = (o) => (parseInt(o?.quantity, 10) || 0) * hitsPerPiece(o);

// Piezas producidas a partir del resumen de producción de una orden
// ({total_produced, by_position}). Sin posiciones capturadas no se puede
// separar: se toma el total.
export const producedPieces = (summary) => {
  const byPos = Object.values(summary?.by_position || {}).map(Number).filter((n) => n > 0);
  return byPos.length ? Math.max(...byPos) : (Number(summary?.total_produced) || 0);
};
