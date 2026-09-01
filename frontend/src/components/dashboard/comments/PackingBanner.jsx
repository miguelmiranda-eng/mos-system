import { FileSpreadsheet, ExternalLink } from "lucide-react";

// Banner del packing list — SIEMPRE hasta arriba del modal. El enlace sembrado
// quedaba enterrado como comentario al fondo del hilo y "nunca se reflejaba";
// esto lo fija visible. La resolución de cuál packing gana vive en el modal
// (useMemo `packing`, que cruza los campos de la orden con el último comentario
// source=packing_link_seed).
export function PackingBanner({ packing }) {
  if (!packing) return null;
  return (
    <div
      className="mx-6 mt-3 p-3 rounded-lg border border-indigo-500/30 bg-indigo-500/10 flex items-center gap-3"
      data-testid="packing-link-banner"
    >
      <FileSpreadsheet className="w-5 h-5 text-indigo-400 shrink-0" />
      <div className="flex-1 min-w-0">
        <p className="text-[10px] uppercase tracking-wider font-bold text-indigo-300">Packing list</p>
        <p className="text-sm font-medium truncate" title={packing.label}>
          {packing.label}
        </p>
      </div>
      <a
        href={packing.url}
        target="_blank"
        rel="noopener noreferrer"
        className="px-3 py-1.5 bg-indigo-500 hover:bg-indigo-400 text-white text-xs font-bold rounded-lg flex items-center gap-1.5 shrink-0"
        data-testid="packing-link-open"
      >
        <ExternalLink className="w-3.5 h-3.5" /> Abrir
      </a>
    </div>
  );
}
