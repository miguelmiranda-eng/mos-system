import { useState, useEffect, useMemo, useCallback } from "react";
import { Boxes, RefreshCw, Loader2, User, AlertTriangle } from "lucide-react";
import { API } from "../../../lib/constants";

// Orden canónico de tallas (mismo que el WMS: components/wms/lib.js). Se inlinea
// para no acoplar el modal de comentarios al módulo WMS.
const SIZE_ORDER = ["XS", "S", "M", "L", "XL", "2X", "3X", "4X", "5X"];
const sizeRank = (s) => {
  const i = SIZE_ORDER.indexOf(String(s).toUpperCase());
  return i === -1 ? 999 : i;
};

// País de origen -> bandera + etiqueta corta. Los nombres llegan en MAYÚSCULAS
// (canon_coo del backend). Fallback: sin bandera, nombre tal cual.
const COUNTRY_META = {
  HAITI: { flag: "🇭🇹", short: "Haití" },
  NICARAGUA: { flag: "🇳🇮", short: "Nicaragua" },
  "REPUBLICA DOMINICANA": { flag: "🇩🇴", short: "Rep. Dom." },
  HONDURAS: { flag: "🇭🇳", short: "Honduras" },
  MEXICO: { flag: "🇲🇽", short: "México" },
  GUATEMALA: { flag: "🇬🇹", short: "Guatemala" },
  "EL SALVADOR": { flag: "🇸🇻", short: "El Salvador" },
  "ESTADOS UNIDOS": { flag: "🇺🇸", short: "USA" },
  USA: { flag: "🇺🇸", short: "USA" },
  CHINA: { flag: "🇨🇳", short: "China" },
  BANGLADESH: { flag: "🇧🇩", short: "Bangladesh" },
  VIETNAM: { flag: "🇻🇳", short: "Vietnam" },
  INDIA: { flag: "🇮🇳", short: "India" },
  "SIN PAIS": { flag: "", short: "Sin país" },
};
const countryLabel = (c) => COUNTRY_META[c]?.short || c;
const countryFlag = (c) => COUNTRY_META[c]?.flag || "";

const STATUS_META = {
  unassigned: { label: "Sin asignar", cls: "bg-secondary/60 text-muted-foreground" },
  pending: { label: "Pendiente", cls: "bg-amber-500/15 text-amber-500" },
  in_progress: { label: "Surtiendo", cls: "bg-blue-500/15 text-blue-400" },
  completed: { label: "Completado", cls: "bg-emerald-500/15 text-emerald-500" },
};

// Pivote talla × país de un ticket, con pedido/surtido/extra por talla.
function buildPivot(ticket) {
  const picked = ticket.picked || [];
  const ordered = ticket.sizes_ordered || {};

  const sizes = [...new Set([...Object.keys(ordered), ...picked.map((p) => p.size)])]
    .filter(Boolean)
    .sort((a, b) => sizeRank(a) - sizeRank(b) || String(a).localeCompare(String(b)));

  const cell = {}; // `${size}|${country}` -> qty
  const colTotal = {}; // country -> qty
  picked.forEach((p) => {
    const k = `${p.size}|${p.country}`;
    cell[k] = (cell[k] || 0) + p.qty;
    colTotal[p.country] = (colTotal[p.country] || 0) + p.qty;
  });

  // Columnas ordenadas por total surtido desc; "SIN PAIS" siempre al final.
  const countries = [...new Set(picked.map((p) => p.country))].sort((a, b) => {
    if (a === "SIN PAIS") return 1;
    if (b === "SIN PAIS") return -1;
    return (colTotal[b] || 0) - (colTotal[a] || 0);
  });

  const rows = sizes
    .map((size) => {
      const ord = Number(ordered[size] || 0);
      const sur = countries.reduce((s, c) => s + (cell[`${size}|${c}`] || 0), 0);
      return {
        size,
        ordered: ord,
        picked: sur,
        extra: Math.max(0, sur - ord),
        byCountry: countries.map((c) => cell[`${size}|${c}`] || 0),
      };
    })
    // Solo tallas con algo (pedido o surtido). El ticket trae TODAS las tallas
    // configuradas con 0, y renderizarlas hacia una tabla gigante que tapaba el
    // modal y mataba el scroll.
    .filter((r) => r.ordered > 0 || r.picked > 0);

  const totalOrdered = rows.reduce((s, r) => s + r.ordered, 0);
  const totalPicked = rows.reduce((s, r) => s + r.picked, 0);
  return { sizes, countries, rows, colTotal, totalOrdered, totalPicked };
}

function TicketBlock({ ticket }) {
  const pivot = useMemo(() => buildPivot(ticket), [ticket]);
  const status = STATUS_META[ticket.picking_status] || STATUS_META.unassigned;
  const pct = pivot.totalOrdered ? Math.round((pivot.totalPicked / pivot.totalOrdered) * 100) : 0;
  const hasExtras = pivot.rows.some((r) => r.extra > 0);
  const noSurtido = pivot.totalPicked === 0; // 0 surtido en el WMS = nunca se pickeó aquí

  if (pivot.rows.length === 0) return null;

  return (
    <div className={`rounded-lg border overflow-hidden ${noSurtido ? "border-amber-500/40 bg-amber-500/5" : "border-border/60 bg-secondary/20"}`}>
      {/* Encabezado del ticket */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 border-b border-border/50 bg-secondary/30">
        <span className="font-bold text-sm text-foreground">
          {ticket.style} {ticket.color}
        </span>
        {ticket.fabric && <span className="text-[11px] text-muted-foreground uppercase">{ticket.fabric}</span>}
        <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${status.cls}`}>{status.label}</span>
        {noSurtido && (
          <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-amber-500/25 text-amber-500 flex items-center gap-1">
            <AlertTriangle className="w-3 h-3" /> SIN SURTIR EN WMS
          </span>
        )}
        {ticket.assigned_to_name && (
          <span className="text-[10px] text-muted-foreground flex items-center gap-1">
            <User className="w-3 h-3" /> {ticket.assigned_to_name}
          </span>
        )}
        <span className="ml-auto text-[11px] font-mono font-bold text-foreground">
          {pivot.totalPicked}/{pivot.totalOrdered}
          <span className="text-muted-foreground font-normal"> ({pct}%)</span>
        </span>
      </div>

      {noSurtido ? (
        <div className="px-3 py-3 text-xs text-amber-600 dark:text-amber-400 flex items-start gap-2">
          <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
          <span>
            Este material <b>no se ha surtido en el WMS</b> (0 de {pivot.totalOrdered} pz pedidas). Por eso
            no aparece país ni contenido: el sistema no tiene registro de surtido. Si ya se surtió
            físicamente en el piso, falta capturarlo en el WMS.
          </span>
        </div>
      ) : (
      <>
      {/* Pivote */}
      <div className="overflow-x-auto">
        <table className="w-full text-xs border-collapse">
          <thead>
            <tr className="text-[10px] uppercase tracking-wider text-muted-foreground">
              <th className="text-left font-bold px-3 py-1">Talla</th>
              {pivot.countries.map((c) => (
                <th key={c} className="text-right font-bold px-2 py-1 whitespace-nowrap" title={c}>
                  {countryFlag(c)} {countryLabel(c)}
                </th>
              ))}
              <th className="text-right font-bold px-2 py-1">Pedido</th>
              <th className="text-right font-bold px-3 py-1">Surtido</th>
            </tr>
          </thead>
          <tbody>
            {pivot.rows.map((r) => (
              <tr key={r.size} className="border-t border-border/30">
                <td className="px-3 py-1 font-bold text-foreground">{r.size}</td>
                {r.byCountry.map((q, i) => (
                  <td key={i} className={`text-right px-2 py-1 font-mono ${q ? "text-foreground" : "text-muted-foreground/40"}`}>
                    {q || "—"}
                  </td>
                ))}
                <td className="text-right px-2 py-1 font-mono text-muted-foreground">{r.ordered || "—"}</td>
                <td className="text-right px-3 py-1 font-mono font-bold text-foreground">
                  {r.picked || "—"}
                  {r.extra > 0 && (
                    <span className="ml-1 text-[10px] text-amber-500 font-bold" title="Sobrepick (surtido de más)">
                      +{r.extra}
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="border-t-2 border-border/60 bg-secondary/30 font-bold">
              <td className="px-3 py-1 text-[10px] uppercase tracking-wider text-muted-foreground">Total</td>
              {pivot.countries.map((c) => (
                <td key={c} className="text-right px-2 py-1 font-mono text-foreground">
                  {pivot.colTotal[c] || "—"}
                </td>
              ))}
              <td className="text-right px-2 py-1 font-mono text-muted-foreground">{pivot.totalOrdered}</td>
              <td className="text-right px-3 py-1 font-mono text-foreground">{pivot.totalPicked}</td>
            </tr>
          </tfoot>
        </table>
      </div>

      {hasExtras && (
        <div className="px-3 py-1 text-[10px] text-amber-500/90 border-t border-border/30 flex items-center gap-1">
          <span className="font-bold">+N</span> = piezas extras (se surtió más de lo pedido en esa talla)
        </div>
      )}
      </>
      )}
    </div>
  );
}

// Tabla de surtido del WMS dentro del modal de comentarios. Reemplaza el
// comentario manual del picker por un desglose talla × país que refleja lo que
// el WMS ya sabe que se surtió para la orden. Carga al abrir; botón para
// refrescar. Si la orden no tiene tickets de picking, no renderiza nada.
export function SurtidoTable({ order, isOpen }) {
  const [tickets, setTickets] = useState([]);
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const orderNumber = order?.order_number;

  const fetchSurtido = useCallback(async () => {
    if (!orderNumber) return;
    setLoading(true);
    try {
      const res = await fetch(
        `${API}/wms/pick-tickets/by-order/${encodeURIComponent(orderNumber)}/surtido`,
        { credentials: "include" }
      );
      if (res.ok) {
        const data = await res.json();
        setTickets(data.tickets || []);
      }
    } catch (e) {
      console.error("Error fetching surtido:", e);
    } finally {
      setLoading(false);
      setLoaded(true);
    }
  }, [orderNumber]);

  useEffect(() => {
    if (orderNumber && isOpen) {
      setLoaded(false);
      fetchSurtido();
    }
  }, [orderNumber, isOpen, fetchSurtido]);

  // Sin tickets y ya cargado: no ensuciar el modal para órdenes fuera del WMS.
  if (loaded && tickets.length === 0) return null;
  if (!loaded && !loading) return null;

  return (
    <div className="mx-6 mt-3 space-y-2" data-testid="surtido-table">
      <div className="flex items-center justify-between">
        <span className="text-xs uppercase tracking-wider font-bold text-muted-foreground flex items-center gap-1.5">
          <Boxes className="w-3.5 h-3.5" /> Surtido (WMS)
        </span>
        <button
          onClick={fetchSurtido}
          disabled={loading}
          className="text-[11px] text-primary hover:underline flex items-center gap-1 disabled:opacity-50"
          title="Refrescar surtido"
        >
          {loading ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />} Refrescar
        </button>
      </div>
      {loading && tickets.length === 0 ? (
        <div className="flex items-center justify-center py-4 text-muted-foreground text-xs gap-2">
          <Loader2 className="w-4 h-4 animate-spin" /> Cargando surtido…
        </div>
      ) : (
        <div className="space-y-2 max-h-[32vh] overflow-y-auto pr-1">
          {tickets.map((t) => (
            <TicketBlock key={t.ticket_id} ticket={t} />
          ))}
        </div>
      )}
    </div>
  );
}
