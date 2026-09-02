import { useState, useEffect, useCallback, useRef } from "react";
import { RefreshCw, Loader2, X, Boxes, Package, Cog, Download, ChevronLeft, ChevronRight } from "lucide-react";
import { toast } from "sonner";
import * as XLSX from "xlsx";
import { saveAs } from "file-saver";
import { fetcher } from "./lib";
import { Card } from "./ui";
import { SurtidoTable } from "../dashboard/comments/SurtidoTable";

// Tono por FASE: blank (antes de surtir) vs producción (después). Los estatus
// concretos vienen del catálogo real de la orden, no de una lista fija.
const PHASE = {
  blank:      { icon: Package, head: "text-amber-400 bg-amber-500/10 border-amber-500/40", dot: "bg-amber-400" },
  produccion: { icon: Cog,     head: "text-blue-400 bg-blue-500/10 border-blue-500/40",   dot: "bg-blue-400" },
};

// Detalle SOLO LECTURA: los dos estatus reales de la orden + qué se surtió.
function DetailModal({ orderNumber, onClose }) {
  const [detail, setDetail] = useState(null);

  useEffect(() => {
    let alive = true;
    fetcher(`/trace/${encodeURIComponent(orderNumber)}`)
      .then((d) => { if (alive) setDetail(d); })
      .catch(() => toast.error("Error al cargar el detalle"));
    return () => { alive = false; };
  }, [orderNumber]);

  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/50 backdrop-blur-sm p-4" onClick={onClose}>
      <div className="w-full max-w-3xl max-h-[90vh] overflow-y-auto rounded-2xl border border-border bg-card shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-4 border-b border-border sticky top-0 bg-card z-10">
          <div>
            <h3 className="font-bold text-lg text-foreground">Orden {orderNumber}</h3>
            {detail?.cliente && <p className="text-xs text-muted-foreground">{detail.cliente}{detail.descripcion ? ` · ${detail.descripcion}` : ""}</p>}
          </div>
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-secondary text-muted-foreground hover:text-foreground">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-5 space-y-5">
          {/* Los dos estatus reales, con el relevo (blank -> producción) */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className={`rounded-lg border p-3 ${PHASE.blank.head} ${detail?.phase === "blank" ? "ring-2 ring-amber-400/40" : "opacity-70"}`}>
              <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider font-bold">
                <Package className="w-3.5 h-3.5" /> Blank status
              </div>
              <p className="text-sm font-bold mt-1">{detail?.blank_status || "—"}</p>
              <p className="text-[10px] opacity-70">antes del surtido</p>
            </div>
            <div className={`rounded-lg border p-3 ${PHASE.produccion.head} ${detail?.phase === "produccion" ? "ring-2 ring-blue-400/40" : "opacity-70"}`}>
              <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider font-bold">
                <Cog className="w-3.5 h-3.5" /> Production status
              </div>
              <p className="text-sm font-bold mt-1">{detail?.production_status || "—"}</p>
              <p className="text-[10px] opacity-70">después del surtido</p>
            </div>
          </div>
          {detail && (
            <p className="text-[11px] text-muted-foreground -mt-2">
              Etapa actual: <span className="font-bold text-foreground">{detail.stage}</span>
              {detail.phase === "produccion" ? " (producción)" : " (blanks)"}
            </p>
          )}

          {/* Qué se surtió */}
          <SurtidoTable order={{ order_number: orderNumber }} isOpen={true} />
        </div>
      </div>
    </div>
  );
}

export function TrazabilidadModule() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState(null);
  const scrollRef = useRef(null);
  const scrollBy = (dx) => scrollRef.current?.scrollBy({ left: dx, behavior: "smooth" });

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(await fetcher("/trace"));
    } catch {
      toast.error("Error al cargar la trazabilidad");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const stages = data?.stages || [];
  const blankSet = new Set(data?.blank_stages || []);
  const orders = data?.orders || [];
  const byStage = (st) => orders.filter((o) => o.stage === st);
  const phaseOf = (st) => (blankSet.has(st) ? "blank" : "produccion");

  const exportXlsx = () => {
    if (!orders.length) { toast.error("No hay nada que exportar"); return; }
    const rows = orders.map((o) => ({
      "Orden": o.order_number,
      "Cliente": o.cliente || "",
      "Descripción": o.descripcion || "",
      "Etapa actual": o.stage || "",
      "Fase": o.phase === "produccion" ? "Producción" : "Blanks",
      "Blank Status": o.blank_status || "",
      "Production Status": o.production_status || "",
    }));
    const ws = XLSX.utils.json_to_sheet(rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Trazabilidad");
    const buf = XLSX.write(wb, { bookType: "xlsx", type: "array" });
    saveAs(new Blob([buf], { type: "application/octet-stream" }), "trazabilidad_material.xlsx");
    toast.success("Excel exportado");
  };

  return (
    <div className="p-4 md:p-6 space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-bold text-foreground flex items-center gap-2">
            <Boxes className="w-5 h-5" /> Trazabilidad de material
          </h2>
          <p className="text-sm text-muted-foreground">
            Estado real de cada orden: <span className="text-amber-400 font-semibold">blank status</span> antes de surtir,
            {" "}<span className="text-blue-400 font-semibold">production status</span> después.
          </p>
        </div>
        <div className="flex items-center gap-3 shrink-0">
          <button onClick={exportXlsx} disabled={!orders.length} className="flex items-center gap-1.5 text-sm px-3 py-1.5 rounded-lg bg-emerald-500/15 text-emerald-500 hover:bg-emerald-500/25 disabled:opacity-40 font-semibold">
            <Download className="w-4 h-4" /> Exportar Excel
          </button>
          <button onClick={load} disabled={loading} className="flex items-center gap-1.5 text-sm text-primary hover:underline disabled:opacity-50">
            {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />} Refrescar
          </button>
        </div>
      </div>

      {loading && !data ? (
        <div className="flex items-center justify-center py-16 text-muted-foreground gap-2">
          <Loader2 className="w-5 h-5 animate-spin" /> Cargando…
        </div>
      ) : orders.length === 0 ? (
        <Card className="p-8 text-center text-muted-foreground">
          No hay órdenes con blank status ni production status.
        </Card>
      ) : (
        <div className="relative">
          <button onClick={() => scrollBy(-360)} aria-label="Desplazar a la izquierda"
            className="absolute left-0 top-1/2 -translate-y-1/2 z-20 w-9 h-9 rounded-full bg-card border border-border shadow-lg flex items-center justify-center text-foreground hover:bg-secondary">
            <ChevronLeft className="w-5 h-5" />
          </button>
          <button onClick={() => scrollBy(360)} aria-label="Desplazar a la derecha"
            className="absolute right-0 top-1/2 -translate-y-1/2 z-20 w-9 h-9 rounded-full bg-card border border-border shadow-lg flex items-center justify-center text-foreground hover:bg-secondary">
            <ChevronRight className="w-5 h-5" />
          </button>
          <div ref={scrollRef} className="w-full overflow-x-auto pb-2" style={{ scrollbarWidth: "thin" }}>
            <div className="flex gap-3 w-max px-11">
          {stages.map((st) => {
            const items = byStage(st);
            const ph = PHASE[phaseOf(st)];
            const Icon = ph.icon;
            return (
              <div key={st} className="shrink-0 w-60 flex flex-col">
                <div className={`flex items-center gap-2 px-3 py-2 rounded-t-lg border-b-2 shrink-0 ${ph.head}`}>
                  <Icon className="w-4 h-4" />
                  <span className="text-[11px] font-black uppercase tracking-wide truncate" title={st}>{st}</span>
                  <span className="ml-auto text-xs font-mono font-bold">{items.length}</span>
                </div>
                <div className="space-y-2 p-2 bg-secondary/10 rounded-b-lg min-h-[60px] overflow-y-auto max-h-[calc(100vh-19rem)]">
                  {items.map((o) => (
                    <button
                      key={o.order_number}
                      onClick={() => setSelected(o.order_number)}
                      className="w-full text-left rounded-lg border border-border bg-card hover:border-primary/50 transition-colors p-2.5"
                    >
                      <div className="flex items-center gap-2">
                        <span className={`w-1.5 h-1.5 rounded-full ${ph.dot}`} />
                        <span className="font-bold text-sm text-foreground">{o.order_number}</span>
                      </div>
                      {o.cliente && <p className="text-[11px] text-muted-foreground truncate mt-0.5">{o.cliente}</p>}
                      {o.descripcion && <p className="text-[10px] text-muted-foreground truncate">{o.descripcion}</p>}
                    </button>
                  ))}
                </div>
              </div>
            );
          })}
            </div>
          </div>
        </div>
      )}

      {selected && <DetailModal orderNumber={selected} onClose={() => setSelected(null)} />}
    </div>
  );
}
