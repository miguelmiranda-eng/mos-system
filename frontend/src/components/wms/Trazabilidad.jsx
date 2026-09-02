import { useState, useEffect, useCallback, useRef } from "react";
import { RefreshCw, Loader2, X, Boxes, Cog, ChevronLeft, ChevronRight, Download } from "lucide-react";
import { toast } from "sonner";
import * as XLSX from "xlsx";
import { saveAs } from "file-saver";
import { fetcher } from "./lib";
import { Card } from "./ui";
import { SurtidoTable } from "../dashboard/comments/SurtidoTable";

// SURTIDO (recién en piso, sin production_status) en índigo; el resto son
// production_status reales, en azul.
const stageMeta = (st) =>
  st === "SURTIDO"
    ? { icon: Boxes, cls: "text-indigo-400 bg-indigo-500/10 border-indigo-500/40" }
    : { icon: Cog, cls: "text-blue-400 bg-blue-500/10 border-blue-500/40" };

// Detalle: etapa + piezas en piso + desglose de surtido (talla × país).
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
            {detail?.cliente && (
              <p className="text-xs text-muted-foreground">{detail.cliente}{detail.descripcion ? ` · ${detail.descripcion}` : ""}</p>
            )}
          </div>
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-secondary text-muted-foreground hover:text-foreground">
            <X className="w-5 h-5" />
          </button>
        </div>
        <div className="p-5 space-y-4">
          <div className="flex flex-wrap gap-3">
            <div className="rounded-lg border border-blue-500/40 bg-blue-500/10 px-4 py-2">
              <p className="text-[10px] uppercase tracking-wider font-bold text-blue-400">Etapa</p>
              <p className="text-sm font-bold text-foreground">{detail?.stage || "—"}</p>
            </div>
            <div className="rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-4 py-2">
              <p className="text-[10px] uppercase tracking-wider font-bold text-emerald-400">Piezas en piso</p>
              <p className="text-sm font-bold text-foreground">{(detail?.piezas ?? 0).toLocaleString()}</p>
            </div>
          </div>
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
  const orders = data?.orders || [];
  const byStage = (st) => orders.filter((o) => o.stage === st);
  const totalPiezas = orders.reduce((s, o) => s + (o.piezas || 0), 0);

  const exportXlsx = () => {
    if (!orders.length) { toast.error("No hay nada que exportar"); return; }
    const rows = orders.map((o) => ({
      "Orden": o.order_number,
      "Cliente": o.cliente || "",
      "Descripción": o.descripcion || "",
      "Etapa": o.stage || "",
      "Piezas en piso": o.piezas || 0,
    }));
    const ws = XLSX.utils.json_to_sheet(rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Material en piso");
    const buf = XLSX.write(wb, { bookType: "xlsx", type: "array" });
    saveAs(new Blob([buf], { type: "application/octet-stream" }), "material_en_piso.xlsx");
    toast.success("Excel exportado");
  };

  return (
    <div className="p-4 md:p-6 space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <h2 className="text-xl font-bold text-foreground flex items-center gap-2">
            <Boxes className="w-5 h-5" /> Trazabilidad de material
          </h2>
          <p className="text-sm text-muted-foreground">
            Material ya surtido (salió del almacén) y aún en planta —{" "}
            <span className="font-bold text-foreground">{totalPiezas.toLocaleString()} piezas</span> en {orders.length} órdenes.
          </p>
        </div>
        <div className="flex items-center gap-3 shrink-0">
          <button onClick={exportXlsx} disabled={!orders.length}
            className="flex items-center gap-1.5 text-sm px-3 py-1.5 rounded-lg bg-emerald-500/15 text-emerald-500 hover:bg-emerald-500/25 disabled:opacity-40 font-semibold">
            <Download className="w-4 h-4" /> Exportar Excel
          </button>
          <button onClick={load} disabled={loading}
            className="flex items-center gap-1.5 text-sm text-primary hover:underline disabled:opacity-50">
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
          No hay material en piso. Aquí aparece lo ya surtido que sigue en planta (aún sin enviar).
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
                const m = stageMeta(st);
                const Icon = m.icon;
                const piezas = items.reduce((s, o) => s + (o.piezas || 0), 0);
                return (
                  <div key={st} className="shrink-0 w-60 flex flex-col">
                    <div className={`flex items-center gap-2 px-3 py-2 rounded-t-lg border-b-2 shrink-0 ${m.cls}`}>
                      <Icon className="w-4 h-4" />
                      <span className="text-[11px] font-black uppercase tracking-wide truncate" title={st}>{st}</span>
                      <span className="ml-auto text-[10px] font-mono font-bold whitespace-nowrap">{piezas.toLocaleString()} pz</span>
                    </div>
                    <div className="space-y-2 p-2 bg-secondary/10 rounded-b-lg min-h-[60px] overflow-y-auto max-h-[calc(100vh-19rem)]">
                      {items.map((o) => (
                        <button key={o.order_number} onClick={() => setSelected(o.order_number)}
                          className="w-full text-left rounded-lg border border-border bg-card hover:border-primary/50 transition-colors p-2.5">
                          <div className="flex items-center justify-between">
                            <span className="font-bold text-sm text-foreground">{o.order_number}</span>
                            <span className="text-[11px] font-mono font-bold text-emerald-500">{(o.piezas || 0).toLocaleString()} pz</span>
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
