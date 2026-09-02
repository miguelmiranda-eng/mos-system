import { useState, useEffect, useCallback, useMemo } from "react";
import { Scissors, Loader2, RefreshCw, Save, AlertTriangle, CheckCircle2 } from "lucide-react";
import { toast } from "sonner";
import { API } from "../../../lib/constants";

// Mismo criterio de tallas/países que la tabla de surtido.
const SIZE_ORDER = ["XS", "S", "M", "L", "XL", "2X", "3X", "4X", "5X"];
const sizeRank = (s) => {
  const i = SIZE_ORDER.indexOf(String(s).toUpperCase());
  return i === -1 ? 999 : i;
};
const COUNTRY_META = {
  HAITI: { flag: "🇭🇹", short: "Haití" },
  NICARAGUA: { flag: "🇳🇮", short: "Nicaragua" },
  "REPUBLICA DOMINICANA": { flag: "🇩🇴", short: "Rep. Dom." },
  HONDURAS: { flag: "🇭🇳", short: "Honduras" },
  MEXICO: { flag: "🇲🇽", short: "México" },
  GUATEMALA: { flag: "🇬🇹", short: "Guatemala" },
  "EL SALVADOR": { flag: "🇸🇻", short: "El Salvador" },
  CHINA: { flag: "🇨🇳", short: "China" },
  BANGLADESH: { flag: "🇧🇩", short: "Bangladesh" },
  VIETNAM: { flag: "🇻🇳", short: "Vietnam" },
  INDIA: { flag: "🇮🇳", short: "India" },
  "SIN PAIS": { flag: "", short: "Sin país" },
};
const cLabel = (c) => COUNTRY_META[c]?.short || c;
const cFlag = (c) => COUNTRY_META[c]?.flag || "";

// Un ticket: rejilla talla × país con inputs para que el operador CAPTURE el
// neck a mano (el sistema no lo mide). Al guardar compara contra lo surtido y
// marca/describe las discrepancias.
function TicketNeck({ ticket, orderNumber, onSaved }) {
  const surtidoBy = useMemo(() => {
    const m = {};
    ticket.rows.forEach((r) => { m[`${r.size}|${r.country}`] = r.surtido; });
    return m;
  }, [ticket]);

  const sizes = useMemo(
    () => [...new Set(ticket.rows.map((r) => r.size))].filter(Boolean)
      .sort((a, b) => sizeRank(a) - sizeRank(b) || String(a).localeCompare(String(b))),
    [ticket]
  );
  const countries = useMemo(
    () => [...new Set(ticket.rows.map((r) => r.country))].sort((a, b) => (a === "SIN PAIS" ? 1 : b === "SIN PAIS" ? -1 : a.localeCompare(b))),
    [ticket]
  );

  const [edits, setEdits] = useState(() => {
    const init = {};
    ticket.rows.forEach((r) => { if (r.neck != null) init[`${r.size}|${r.country}`] = String(r.neck); });
    return init;
  });
  const [saving, setSaving] = useState(false);
  const [compared, setCompared] = useState(!!ticket.counted_at);

  const setCell = (key, val) => setEdits((e) => ({ ...e, [key]: val.replace(/[^0-9]/g, "") }));

  const discrepancias = useMemo(() => {
    const d = [];
    for (const r of ticket.rows) {
      const key = `${r.size}|${r.country}`;
      const v = edits[key];
      if (v === undefined || v === "") continue; // no contado aún
      const neck = parseInt(v, 10);
      if (neck !== r.surtido) d.push({ size: r.size, country: r.country, neck, surtido: r.surtido, diff: neck - r.surtido });
    }
    return d;
  }, [ticket, edits]);

  const neckOf = (key) => (edits[key] === undefined || edits[key] === "" ? null : parseInt(edits[key], 10));

  const save = async () => {
    setSaving(true);
    const counts = {};
    Object.entries(edits).forEach(([k, v]) => { if (v !== "") counts[k] = parseInt(v, 10); });
    try {
      const res = await fetch(
        `${API}/wms/pick-tickets/by-order/${encodeURIComponent(orderNumber)}/neck`,
        { method: "POST", headers: { "Content-Type": "application/json" }, credentials: "include",
          body: JSON.stringify({ ticket_id: ticket.ticket_id, counts }) }
      );
      if (res.ok) { toast.success("Neck guardado"); setCompared(true); onSaved?.(); }
      else toast.error("Error al guardar");
    } catch { toast.error("Error de conexión"); }
    finally { setSaving(false); }
  };

  const rowTotal = (size) => countries.reduce((s, c) => s + (neckOf(`${size}|${c}`) || 0), 0);
  const grandNeck = sizes.reduce((s, sz) => s + rowTotal(sz), 0);

  return (
    <div className={`rounded-lg border overflow-hidden ${compared && discrepancias.length ? "border-amber-500/40" : "border-border/60"} bg-secondary/20`}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 border-b border-border/50 bg-secondary/30">
        <span className="font-bold text-sm text-foreground">{ticket.style} {ticket.color}</span>
        {ticket.fabric && <span className="text-[11px] text-muted-foreground uppercase">{ticket.fabric}</span>}
        {ticket.counted_by && <span className="text-[10px] text-muted-foreground">contó: {ticket.counted_by}</span>}
        <button onClick={save} disabled={saving}
          className="ml-auto flex items-center gap-1 text-[11px] font-bold px-2.5 py-1 rounded bg-pink-500/15 text-pink-400 hover:bg-pink-500/25 disabled:opacity-50">
          {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />} Guardar y comparar
        </button>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-xs border-collapse">
          <thead>
            <tr className="text-[10px] uppercase tracking-wider text-muted-foreground">
              <th className="text-left font-bold px-3 py-1">Talla</th>
              {countries.map((c) => (
                <th key={c} className="text-center font-bold px-2 py-1 whitespace-nowrap" title={c}>{cFlag(c)} {cLabel(c)}</th>
              ))}
              <th className="text-right font-bold px-3 py-1">Neck</th>
            </tr>
          </thead>
          <tbody>
            {sizes.map((size) => (
              <tr key={size} className="border-t border-border/30">
                <td className="px-3 py-1 font-bold text-foreground">{size}</td>
                {countries.map((c) => {
                  const key = `${size}|${c}`;
                  const has = surtidoBy[key] !== undefined; // solo hubo surtido de esta celda
                  const neck = neckOf(key);
                  const bad = compared && has && neck !== null && neck !== surtidoBy[key];
                  return (
                    <td key={c} className="text-center px-1.5 py-1">
                      {has ? (
                        <input
                          value={edits[key] ?? ""}
                          onChange={(e) => setCell(key, e.target.value)}
                          inputMode="numeric"
                          placeholder="—"
                          className={`w-16 text-center rounded border px-1 py-0.5 text-sm font-mono bg-secondary ${bad ? "border-amber-500 text-amber-500" : "border-border text-foreground"}`}
                          title={bad ? `Surtido: ${surtidoBy[key]} · dif ${neck - surtidoBy[key] > 0 ? "+" : ""}${neck - surtidoBy[key]}` : ""}
                        />
                      ) : (
                        <span className="text-muted-foreground/30">—</span>
                      )}
                    </td>
                  );
                })}
                <td className="text-right px-3 py-1 font-mono font-bold text-foreground">{rowTotal(size) || "—"}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="border-t-2 border-border/60 bg-secondary/30 font-bold">
              <td className="px-3 py-1 text-[10px] uppercase tracking-wider text-muted-foreground">Total neck</td>
              <td className="text-center px-2 py-1" colSpan={countries.length} />
              <td className="text-right px-3 py-1 font-mono text-foreground">{grandNeck}</td>
            </tr>
          </tfoot>
        </table>
      </div>

      {compared && (
        discrepancias.length ? (
          <div className="px-3 py-2 border-t border-amber-500/30 bg-amber-500/5 space-y-1">
            <div className="flex items-center gap-1.5 text-[11px] font-bold text-amber-500">
              <AlertTriangle className="w-3.5 h-3.5" /> Discrepancias contra lo surtido ({discrepancias.length})
            </div>
            {discrepancias.map((d, i) => (
              <p key={i} className="text-[11px] text-amber-600 dark:text-amber-400">
                <b>{d.size} · {cLabel(d.country)}</b>: contaste <b>{d.neck}</b>, surtido <b>{d.surtido}</b> → {d.diff > 0 ? `sobran ${d.diff}` : `faltan ${-d.diff}`}
              </p>
            ))}
          </div>
        ) : (
          <div className="px-3 py-2 border-t border-emerald-500/30 bg-emerald-500/5 flex items-center gap-1.5 text-[11px] font-bold text-emerald-500">
            <CheckCircle2 className="w-3.5 h-3.5" /> Neck cuadra con lo surtido
          </div>
        )
      )}
    </div>
  );
}

// Tabla de NECK (captura manual) del modal de comentarios. Jala la misma
// estructura que el surtido, pero para que el operador cuente y capture. Marca
// discrepancias contra lo surtido al guardar.
export function NeckTable({ order, isOpen }) {
  const [tickets, setTickets] = useState([]);
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const orderNumber = order?.order_number;

  const fetchNeck = useCallback(async () => {
    if (!orderNumber) return;
    setLoading(true);
    try {
      const res = await fetch(
        `${API}/wms/pick-tickets/by-order/${encodeURIComponent(orderNumber)}/neck`,
        { credentials: "include" }
      );
      if (res.ok) {
        const data = await res.json();
        setTickets((data.tickets || []).filter((t) => (t.rows || []).length > 0));
      }
    } catch (e) {
      console.error("Error fetching neck:", e);
    } finally {
      setLoading(false);
      setLoaded(true);
    }
  }, [orderNumber]);

  useEffect(() => {
    if (orderNumber && isOpen) { setLoaded(false); fetchNeck(); }
  }, [orderNumber, isOpen, fetchNeck]);

  if (!loaded && !loading) return null;

  return (
    <div className="mx-6 mt-3 space-y-2" data-testid="neck-table">
      <div className="flex items-center justify-between">
        <span className="text-xs uppercase tracking-wider font-bold text-muted-foreground flex items-center gap-1.5">
          <Scissors className="w-3.5 h-3.5" /> Neck (captura manual)
        </span>
        <button onClick={fetchNeck} disabled={loading}
          className="text-[11px] text-primary hover:underline flex items-center gap-1 disabled:opacity-50">
          {loading ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />} Refrescar
        </button>
      </div>
      {loading && tickets.length === 0 ? (
        <div className="flex items-center justify-center py-4 text-muted-foreground text-xs gap-2">
          <Loader2 className="w-4 h-4 animate-spin" /> Cargando…
        </div>
      ) : tickets.length === 0 ? (
        <p className="text-xs text-muted-foreground text-center py-3">
          No hay material surtido en el WMS para capturar neck. La estructura del neck se toma del surtido.
        </p>
      ) : (
        <div className="space-y-2">
          {tickets.map((t) => (
            <TicketNeck key={t.ticket_id} ticket={t} orderNumber={orderNumber} onSaved={fetchNeck} />
          ))}
        </div>
      )}
    </div>
  );
}
