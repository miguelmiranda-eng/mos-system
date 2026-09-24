import { clsx } from "clsx";
import { twMerge } from "tailwind-merge"

export function cn(...inputs) {
  return twMerge(clsx(inputs));
}

// Etiqueta local de una fecha de calendario. `new Date("2026-10-01")` se
// interpreta como medianoche UTC y en México se pinta como 30/9: las órdenes
// del 1 de oct caían en el filtro/grupo del día anterior. Un "YYYY-MM-DD" se
// arma con componentes locales; cualquier otro formato sigue como antes.
export function localDateLabel(v) {
  if (!v) return '';
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(v));
  const d = m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : new Date(v);
  return isNaN(d) ? String(v) : d.toLocaleDateString();
}
