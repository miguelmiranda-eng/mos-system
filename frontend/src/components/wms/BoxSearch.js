import { useState, useRef } from "react";
import { toast } from "sonner";
import { ScanLine, X, Loader2, MapPin, Package, History, AlertTriangle, Printer } from "lucide-react";
import { fetcher, cleanScan, API } from "./lib";
import { Chip } from "./ui";

// Friendly labels for the movement types a box's timeline can surface.
const MV_TYPE_LABELS = {
  receiving: "Recepción", receiving_update: "Recepción editada",
  putaway: "Ubicado (putaway)", putaway_bulk: "Ubicado en lote",
  box_edited: "Caja editada", box_deleted: "Caja eliminada",
  inventory_adjust_box: "Ajuste por caja", lpn_reconciled: "LPN reconciliado",
  bulk_relocation: "Reubicación masiva", transit_relocation: "Reubicación de tránsito",
  edit_finished_good: "Producto terminado editado", production_move: "Movido a producción",
  shipment: "Embarque", allocation: "Asignación", deallocate: "Desasignación",
  pick_ticket_created: "Pick ticket creado", pick_confirmed: "Surtido confirmado",
  pick_progress: "Avance de surtido", neck_cut_delivery: "Surtido a producción (neck)",
  manual_inventory_add: "Entrada manual", manual_inventory_remove: "Salida manual",
};

const summarize = (m) => {
  const d = m.details || {};
  const origin = d.from || (Array.isArray(d.from_sources) && d.from_sources.join(", "))
    || (Array.isArray(d.sources) && d.sources.join(", ")) || "";
  const dest = d.to || d.to_loc || "";
  const parts = [];
  if (origin || dest) parts.push(`${origin || "—"} → ${dest || "—"}`);
  else if (d.location) parts.push(d.location);
  if (d.old_units != null && d.new_units != null) parts.push(`${d.old_units} → ${d.new_units} u`);
  else if (d.box_units_received != null) parts.push(`${d.box_units_received} u`);
  else if (d.units != null) parts.push(`${d.units} u`);
  else if (d.units_moved != null) parts.push(`${d.units_moved} u`);
  if (d.reason) parts.push(`“${d.reason}”`);
  return parts.join(" · ");
};

// Always-on box / LPN search for the WMS header. Resolves a scanned box to its
// current location, customer, content and full movement timeline (Case# 003/004
// surfaced everywhere). Read-only; available in every module.
export function BoxSearchBar({ compact = false }) {
  const [code, setCode] = useState("");
  const [open, setOpen] = useState(false);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const inputRef = useRef(null);

  const search = async (e) => {
    e?.preventDefault();
    const q = cleanScan(code);
    if (!q) return;
    setOpen(true);
    setLoading(true);
    setData(null);
    try {
      const res = await fetcher(`/boxes/${encodeURIComponent(q)}/history`);
      setData(res);
    } catch {
      setData(null);
      toast.error("No se pudo obtener la caja");
    } finally {
      setLoading(false);
    }
  };

  const close = () => { setOpen(false); setData(null); setCode(""); };

  return (
    <>
      <form onSubmit={search} className={`relative ${compact ? "w-44" : "w-44 sm:w-64"}`}>
        <ScanLine className="w-4 h-4 text-muted-foreground absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none" />
        <input
          ref={inputRef}
          value={code}
          onChange={(e) => setCode(e.target.value.toUpperCase())}
          placeholder="Buscar caja / LPN…"
          data-testid="wms-global-box-search"
          className="w-full h-9 pl-8 pr-7 bg-card border border-input rounded-md text-sm font-mono font-medium focus:outline-none focus:ring-2 focus:ring-ring/25 focus:border-ring placeholder:font-sans placeholder:font-medium placeholder:text-muted-foreground/60"
        />
        {code && (
          <button type="button" onClick={() => setCode("")}
            className="absolute right-2 top-1/2 -translate-y-1/2 p-0.5 rounded text-muted-foreground hover:text-foreground">
            <X className="w-3.5 h-3.5" />
          </button>
        )}
      </form>

      {open && (
        <div className="fixed inset-0 z-[80] flex items-start justify-center p-4 pt-20 bg-black/60 backdrop-blur-sm animate-in fade-in duration-150"
          onClick={close}>
          <div onClick={(e) => e.stopPropagation()}
            className="bg-card border border-border rounded-lg w-full max-w-2xl max-h-[80vh] flex flex-col shadow-xl animate-in zoom-in-95 duration-150">
            <div className="flex items-center justify-between p-4 border-b border-border/20">
              <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
                <Package className="w-4 h-4 text-muted-foreground" /> Caja / LPN
              </div>
              <button onClick={close} className="p-1.5 hover:bg-secondary rounded-lg transition-all">
                <X className="w-5 h-5 text-muted-foreground" />
              </button>
            </div>

            <div className="flex-1 overflow-auto p-4">
              {loading ? (
                <div className="flex flex-col items-center justify-center py-16 gap-3 text-muted-foreground">
                  <Loader2 className="w-8 h-8 animate-spin text-muted-foreground" />
                  <span className="text-xs font-medium">Buscando…</span>
                </div>
              ) : !data ? (
                <div className="text-center py-12">
                  <p className="text-sm font-semibold text-foreground/80">Sin resultados</p>
                </div>
              ) : (
                <div className="space-y-4">
                  {/* Box summary */}
                  <div className="bg-muted/30 border border-border rounded-lg p-4">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="text-xs font-medium text-muted-foreground">Caja</div>
                        <div className="text-lg font-mono font-semibold truncate">{data.box_id}</div>
                        {data.found && (
                          <div className="text-sm font-medium mt-0.5 truncate">
                            {(data.box?.style || data.box?.sku)} · {data.box?.color} · {data.box?.size}
                          </div>
                        )}
                      </div>
                      {data.found && (
                        <div className="text-right flex-shrink-0">
                          <div className="text-2xl font-semibold tabular-nums leading-none">{data.box?.units ?? data.box?.qty ?? 0}</div>
                          <div className="text-xs text-muted-foreground">unidades</div>
                        </div>
                      )}
                    </div>
                    {data.found ? (
                      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 mt-3 pt-3 border-t border-border/60 text-xs">
                        <span className="inline-flex items-center gap-1 font-mono font-medium text-foreground">
                          <MapPin className="w-3.5 h-3.5 text-muted-foreground" /> {data.box?.location || "sin ubicación"}
                        </span>
                        {data.box?.customer && <span className="text-muted-foreground">Cliente: <b className="text-foreground">{data.box.customer}</b></span>}
                        {(data.box?.status || data.box?.state) && <span className="text-muted-foreground">Estado: <b className="text-foreground">{data.box.status || data.box.state}</b></span>}
                      </div>
                    ) : (
                      <div className="text-xs font-medium text-amber-600 dark:text-amber-400 mt-2 flex items-center gap-1">
                        <AlertTriangle className="w-3.5 h-3.5" /> La caja ya no existe (eliminada/embarcada). Mostrando su historial.
                      </div>
                    )}
                    {data.found && (
                      <button
                        onClick={() => window.open(`${API}/labels/box/${encodeURIComponent(data.box_id)}`, '_blank')}
                        className="mt-3 w-full inline-flex items-center justify-center gap-2 px-3 py-2 bg-primary text-primary-foreground rounded-md text-sm font-medium hover:opacity-90 active:scale-95 transition-all"
                        data-testid="box-reprint-label"
                      >
                        <Printer className="w-4 h-4" /> Reimprimir etiqueta
                      </button>
                    )}
                  </div>

                  {/* History */}
                  <div>
                    <div className="text-xs font-medium text-muted-foreground mb-2 flex items-center gap-2">
                      <History className="w-3.5 h-3.5" /> Movimientos ({data.box_event_count || 0})
                    </div>
                    {data.box_events?.length ? (
                      <div className="space-y-0">
                        {data.box_events.map((m, i) => (
                          <div key={m.movement_id || i} className="flex items-start gap-3 py-2.5 border-b border-border/60 last:border-0">
                            <div className="min-w-0 flex-1">
                              <div className="text-sm flex items-center gap-2 flex-wrap">
                                <Chip>{MV_TYPE_LABELS[m.type] || m.type?.replace(/_/g, " ")}</Chip>
                                {summarize(m) && <span className="text-xs text-muted-foreground font-mono">{summarize(m)}</span>}
                              </div>
                              <div className="text-xs text-muted-foreground mt-0.5">
                                {new Date(m.created_at).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })} · {m.user_name || m.user_id || "Sistema"}
                              </div>
                            </div>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <p className="text-sm text-muted-foreground italic py-3 text-center">Sin movimientos registrados.</p>
                    )}
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
