import { useState, useEffect, useMemo, useCallback } from "react";
import { Boxes, RefreshCw, Loader2, User, AlertTriangle, RotateCcw } from "lucide-react";
import { toast } from "sonner";
import { API } from "../../../lib/constants";
import { useLang } from "../../../contexts/LanguageContext";
import { canRevertSurtido } from "./roles";

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

// `key` es la clave i18n de la etiqueta; se resuelve con t() en el componente.
const STATUS_META = {
  unassigned: { key: "unassigned", cls: "bg-secondary/60 text-muted-foreground" },
  pending: { key: "pending", cls: "bg-amber-500/15 text-amber-500" },
  in_progress: { key: "comment_picking_in_progress", cls: "bg-blue-500/15 text-blue-400" },
  completed: { key: "completed", cls: "bg-emerald-500/15 text-emerald-500" },
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

function TicketBlock({ ticket, currentUser, onReverted }) {
  const { t } = useLang();
  const pivot = useMemo(() => buildPivot(ticket), [ticket]);
  const status = STATUS_META[ticket.picking_status] || STATUS_META.unassigned;
  const pct = pivot.totalOrdered ? Math.round((pivot.totalPicked / pivot.totalOrdered) * 100) : 0;
  const hasExtras = pivot.rows.some((r) => r.extra > 0);
  const noSurtido = pivot.totalPicked === 0; // 0 surtido en el WMS = nunca se pickeó aquí
  const [reverting, setReverting] = useState(false);
  const [panelOpen, setPanelOpen] = useState(false);
  const [dest, setDest] = useState("");
  const [reason, setReason] = useState("");
  const [locs, setLocs] = useState(null); // null = aún sin cargar
  const canRevert = canRevertSurtido(currentUser);

  // Al abrir el panel, carga los nombres de ubicación para el selector (una vez).
  const openPanel = useCallback(async () => {
    setPanelOpen(true);
    if (locs !== null) return;
    try {
      const res = await fetch(`${API}/wms/locations/names`, { credentials: "include" });
      const data = res.ok ? await res.json() : [];
      setLocs((Array.isArray(data) ? data : []).map((l) => l.name).filter(Boolean));
    } catch {
      setLocs([]);
    }
  }, [locs]);

  // Revertir: el supervisor ELIGE a qué ubicación regresa el material. El backend
  // crea las cajas ahí (conservando país/composición) y limpia el surtido.
  const submitRevert = useCallback(async () => {
    if (reverting) return;
    const destination_location = dest.trim();
    if (!destination_location) {
      toast.error(t('comment_revert_need_dest'));
      return;
    }
    setReverting(true);
    try {
      const res = await fetch(
        `${API}/wms/pick-tickets/${encodeURIComponent(ticket.ticket_id)}/revert`,
        { method: "POST", credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ reason: reason.trim(), destination_location }) }
      );
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        toast.success(t('comment_revert_ok', { n: data.returned_units ?? pivot.totalPicked, loc: data.destination || destination_location }));
        setPanelOpen(false);
        setDest(""); setReason("");
        onReverted?.();
      } else {
        toast.error(data.detail || t('comment_revert_err'));
      }
    } catch {
      toast.error(t('comment_revert_err'));
    } finally {
      setReverting(false);
    }
  }, [reverting, dest, reason, ticket.ticket_id, pivot.totalPicked, onReverted, t]);

  if (pivot.rows.length === 0) return null;

  return (
    <div className={`rounded-lg border overflow-hidden ${noSurtido ? "border-amber-500/40 bg-amber-500/5" : "border-border/60 bg-secondary/20"}`}>
      {/* Encabezado del ticket */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 border-b border-border/50 bg-secondary/30">
        <span className="font-bold text-sm text-foreground">
          {ticket.style} {ticket.color}
        </span>
        {ticket.fabric && <span className="text-[11px] text-muted-foreground uppercase">{ticket.fabric}</span>}
        <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${status.cls}`}>{t(status.key)}</span>
        {noSurtido && (
          <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-amber-500/25 text-amber-500 flex items-center gap-1">
            <AlertTriangle className="w-3 h-3" /> {t('comment_not_picked_wms')}
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
        {canRevert && !noSurtido && (
          <button
            onClick={() => (panelOpen ? setPanelOpen(false) : openPanel())}
            disabled={reverting}
            data-testid={`revert-surtido-${ticket.ticket_id}`}
            title={t('comment_revert_title')}
            className={`text-[10px] font-bold px-2 py-0.5 rounded flex items-center gap-1 border disabled:opacity-50 ${panelOpen ? "border-red-500 bg-red-500/10 text-red-500" : "border-red-500/40 text-red-500 hover:bg-red-500/10"}`}
          >
            <RotateCcw className="w-3 h-3" />
            {t('comment_revert_btn')}
          </button>
        )}
      </div>

      {/* Panel de reversa: el supervisor elige a dónde regresa el material. */}
      {canRevert && !noSurtido && panelOpen && (
        <div className="px-3 py-2.5 border-b border-red-500/30 bg-red-500/5 space-y-2" data-testid={`revert-panel-${ticket.ticket_id}`}>
          <p className="text-[11px] text-foreground/80">
            {t('comment_revert_confirm', { n: pivot.totalPicked })}
          </p>
          <div className="flex flex-wrap items-end gap-2">
            <label className="flex flex-col gap-0.5">
              <span className="text-[10px] uppercase tracking-wider font-bold text-muted-foreground">{t('comment_revert_dest')}</span>
              <input
                list={`revert-locs-${ticket.ticket_id}`}
                value={dest}
                onChange={(e) => setDest(e.target.value.toUpperCase())}
                placeholder={locs === null ? t('comment_loading_picking') : t('comment_revert_dest_ph')}
                className="w-48 px-2 py-1 text-xs rounded border border-input bg-card text-foreground focus:outline-none focus:ring-2 focus:ring-ring/25"
                data-testid={`revert-dest-${ticket.ticket_id}`}
              />
              <datalist id={`revert-locs-${ticket.ticket_id}`}>
                {(locs || []).map((n) => <option key={n} value={n} />)}
              </datalist>
            </label>
            <label className="flex flex-col gap-0.5 flex-1 min-w-[10rem]">
              <span className="text-[10px] uppercase tracking-wider font-bold text-muted-foreground">{t('comment_revert_reason_label')}</span>
              <input
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder={t('comment_revert_reason_ph')}
                className="w-full px-2 py-1 text-xs rounded border border-input bg-card text-foreground focus:outline-none focus:ring-2 focus:ring-ring/25"
              />
            </label>
            <button
              onClick={submitRevert}
              disabled={reverting || !dest.trim()}
              className="text-[11px] font-bold px-3 py-1 rounded flex items-center gap-1 bg-red-600 text-white hover:bg-red-700 disabled:opacity-50"
              data-testid={`revert-confirm-${ticket.ticket_id}`}
            >
              {reverting ? <Loader2 className="w-3 h-3 animate-spin" /> : <RotateCcw className="w-3 h-3" />}
              {t('comment_revert_do')}
            </button>
            <button
              onClick={() => setPanelOpen(false)}
              disabled={reverting}
              className="text-[11px] font-medium px-3 py-1 rounded border border-border text-muted-foreground hover:bg-secondary disabled:opacity-50"
            >
              {t('cancel')}
            </button>
          </div>
        </div>
      )}

      {noSurtido ? (
        <div className="px-3 py-3 text-xs text-amber-600 dark:text-amber-400 flex items-start gap-2">
          <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
          <span>
            {t('comment_not_picked_1')} <b>{t('comment_not_picked_b')}</b> {t('comment_not_picked_2', { n: pivot.totalOrdered })}
          </span>
        </div>
      ) : (
      <>
      {/* Pivote */}
      <div className="overflow-x-auto">
        <table className="w-full text-xs border-collapse">
          <thead>
            <tr className="text-[10px] uppercase tracking-wider text-muted-foreground">
              <th className="text-left font-bold px-3 py-1">{t('wms_label_size')}</th>
              {pivot.countries.map((c) => (
                <th key={c} className="text-right font-bold px-2 py-1 whitespace-nowrap" title={c}>
                  {countryFlag(c)} {countryLabel(c)}
                </th>
              ))}
              <th className="text-right font-bold px-2 py-1">{t('comment_ordered_col')}</th>
              <th className="text-right font-bold px-3 py-1">{t('comment_picked_col')}</th>
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
                    <span className="ml-1 text-[10px] text-amber-500 font-bold" title={t('comment_overpick_title')}>
                      +{r.extra}
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="border-t-2 border-border/60 bg-secondary/30 font-bold">
              <td className="px-3 py-1 text-[10px] uppercase tracking-wider text-muted-foreground">{t('total')}</td>
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
          <span className="font-bold">+N</span> {t('comment_extras_note')}
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
export function SurtidoTable({ order, isOpen, currentUser }) {
  const { t } = useLang();
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
          <Boxes className="w-3.5 h-3.5" /> {t('comment_picking_wms_paren')}
        </span>
        <button
          onClick={fetchSurtido}
          disabled={loading}
          className="text-[11px] text-primary hover:underline flex items-center gap-1 disabled:opacity-50"
          title={t('comment_refresh_picking')}
        >
          {loading ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />} {t('comment_refresh')}
        </button>
      </div>
      {loading && tickets.length === 0 ? (
        <div className="flex items-center justify-center py-4 text-muted-foreground text-xs gap-2">
          <Loader2 className="w-4 h-4 animate-spin" /> {t('comment_loading_picking')}
        </div>
      ) : (
        <div className="space-y-2 max-h-[32vh] overflow-y-auto pr-1">
          {tickets.map((t) => (
            <TicketBlock key={t.ticket_id} ticket={t} currentUser={currentUser} onReverted={fetchSurtido} />
          ))}
        </div>
      )}
    </div>
  );
}
