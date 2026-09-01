import { useState, useEffect, useCallback } from "react";
import {
  RefreshCw, Loader2, MapPin, X, Boxes, Cog, Scissors,
  CheckCircle2, PackageCheck, Truck, ArrowRight,
} from "lucide-react";
import { toast } from "sonner";
import { fetcher, poster } from "./lib";
import { Card } from "./ui";
import { SurtidoTable } from "../dashboard/comments/SurtidoTable";

// Etapa -> icono + tono de color. Sigue el recorrido físico del material.
const STAGE_META = {
  surtido:    { icon: Boxes,        cls: "text-indigo-400 bg-indigo-500/10 border-indigo-500/30" },
  produccion: { icon: Cog,          cls: "text-blue-400 bg-blue-500/10 border-blue-500/30" },
  corte:      { icon: Scissors,     cls: "text-pink-400 bg-pink-500/10 border-pink-500/30" },
  terminado:  { icon: CheckCircle2, cls: "text-cyan-400 bg-cyan-500/10 border-cyan-500/30" },
  staging:    { icon: PackageCheck, cls: "text-amber-400 bg-amber-500/10 border-amber-500/30" },
  embarcado:  { icon: Truck,        cls: "text-emerald-400 bg-emerald-500/10 border-emerald-500/30" },
};

function StageIcon({ stage, className = "w-4 h-4" }) {
  const Icon = STAGE_META[stage]?.icon || Boxes;
  return <Icon className={className} />;
}

// Panel de detalle: stepper de etapas + avanzar (con ubicación/nota) + surtido.
function DetailModal({ orderNumber, labels, onClose, onChanged }) {
  const [detail, setDetail] = useState(null);
  const [location, setLocation] = useState("");
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    try {
      const d = await fetcher(`/trace/${encodeURIComponent(orderNumber)}`);
      setDetail(d);
      setLocation(d.location || "");
    } catch {
      toast.error("Error al cargar el detalle");
    }
  }, [orderNumber]);

  useEffect(() => { load(); }, [load]);

  const advance = async (stage) => {
    setSaving(true);
    try {
      const res = await poster(`/trace/${encodeURIComponent(orderNumber)}`, { stage, location, note });
      const r = await res.json().catch(() => ({}));
      if (res.ok) {
        toast.success(`Material movido a ${r.stage_label}`);
        setNote("");
        await load();
        onChanged?.();
      } else {
        toast.error(r.detail || "No se pudo avanzar la etapa");
      }
    } catch {
      toast.error("Error de conexión");
    } finally {
      setSaving(false);
    }
  };

  const stages = detail?.stages || Object.keys(STAGE_META);
  const currentIdx = stages.indexOf(detail?.stage);

  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/50 backdrop-blur-sm p-4" onClick={onClose}>
      <div className="w-full max-w-3xl max-h-[90vh] overflow-y-auto rounded-2xl border border-border bg-card shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-4 border-b border-border sticky top-0 bg-card z-10">
          <div>
            <h3 className="font-bold text-lg text-foreground">Orden {orderNumber}</h3>
            {detail?.cliente && <p className="text-xs text-muted-foreground">{detail.cliente}</p>}
          </div>
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-secondary text-muted-foreground hover:text-foreground">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-5 space-y-5">
          {/* Stepper de etapas */}
          <div>
            <p className="text-[10px] uppercase tracking-wider font-bold text-muted-foreground mb-2">Etapa del material</p>
            <div className="flex items-center gap-1 overflow-x-auto pb-1">
              {stages.map((st, i) => {
                const meta = STAGE_META[st] || {};
                const done = i <= currentIdx;
                return (
                  <div key={st} className="flex items-center shrink-0">
                    <div className={`flex flex-col items-center gap-1 px-2 py-1.5 rounded-lg border ${done ? meta.cls : "border-border/40 text-muted-foreground/40"}`}>
                      <StageIcon stage={st} />
                      <span className="text-[10px] font-bold whitespace-nowrap">{labels?.[st] || st}</span>
                    </div>
                    {i < stages.length - 1 && <ArrowRight className={`w-3 h-3 mx-0.5 ${i < currentIdx ? "text-foreground/40" : "text-border"}`} />}
                  </div>
                );
              })}
            </div>
            {detail && (
              <p className="text-[11px] text-muted-foreground mt-1">
                Actual: <span className="font-bold text-foreground">{detail.stage_label}</span>
                {detail.location && <> · <MapPin className="w-3 h-3 inline" /> {detail.location}</>}
                {!detail.manual && <span className="italic"> (derivada del estado del ticket)</span>}
              </p>
            )}
          </div>

          {/* Avanzar */}
          <div className="rounded-lg border border-border bg-secondary/20 p-3 space-y-2">
            <p className="text-[10px] uppercase tracking-wider font-bold text-muted-foreground">Mover material a…</p>
            <div className="flex flex-wrap gap-2">
              {stages.map((st) => (
                <button
                  key={st}
                  disabled={saving || st === detail?.stage}
                  onClick={() => advance(st)}
                  className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border text-xs font-bold transition-all disabled:opacity-40 disabled:cursor-not-allowed ${STAGE_META[st]?.cls || "border-border"}`}
                >
                  <StageIcon stage={st} className="w-3.5 h-3.5" /> {labels?.[st] || st}
                </button>
              ))}
            </div>
            <div className="flex flex-col sm:flex-row gap-2 pt-1">
              <input
                value={location}
                onChange={(e) => setLocation(e.target.value)}
                placeholder="Ubicación / área (opcional)"
                style={{ backgroundColor: "hsl(var(--secondary))", color: "hsl(var(--foreground))" }}
                className="flex-1 border border-border rounded px-3 py-1.5 text-sm"
              />
              <input
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="Nota (opcional)"
                style={{ backgroundColor: "hsl(var(--secondary))", color: "hsl(var(--foreground))" }}
                className="flex-1 border border-border rounded px-3 py-1.5 text-sm"
              />
            </div>
            {saving && <p className="text-xs text-muted-foreground flex items-center gap-1"><Loader2 className="w-3 h-3 animate-spin" /> Guardando…</p>}
          </div>

          {/* Qué se surtió (reusa la tabla del modal de comentarios) */}
          <div>
            <SurtidoTable order={{ order_number: orderNumber }} isOpen={true} />
          </div>

          {/* Historial */}
          {detail?.history?.length > 0 && (
            <div>
              <p className="text-[10px] uppercase tracking-wider font-bold text-muted-foreground mb-2">Historial</p>
              <div className="space-y-1">
                {[...detail.history].reverse().map((h, i) => (
                  <div key={i} className="flex items-center gap-2 text-xs text-muted-foreground">
                    <StageIcon stage={h.stage} className="w-3.5 h-3.5" />
                    <span className="font-bold text-foreground">{labels?.[h.stage] || h.stage}</span>
                    {h.location && <span>· {h.location}</span>}
                    {h.note && <span className="italic">· {h.note}</span>}
                    <span className="ml-auto">{h.by} · {new Date(h.at).toLocaleString()}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export function TrazabilidadModule() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState(null);

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

  const stages = data?.stages || Object.keys(STAGE_META);
  const labels = data?.labels || {};
  const orders = data?.orders || [];
  const byStage = (st) => orders.filter((o) => o.stage === st);

  return (
    <div className="p-4 md:p-6 space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-bold text-foreground flex items-center gap-2">
            <Boxes className="w-5 h-5" /> Trazabilidad de material
          </h2>
          <p className="text-sm text-muted-foreground">Dónde va el material ya surtido de cada orden, del surtido al embarque.</p>
        </div>
        <button onClick={load} disabled={loading} className="flex items-center gap-1.5 text-sm text-primary hover:underline disabled:opacity-50">
          {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />} Refrescar
        </button>
      </div>

      {loading && !data ? (
        <div className="flex items-center justify-center py-16 text-muted-foreground gap-2">
          <Loader2 className="w-5 h-5 animate-spin" /> Cargando…
        </div>
      ) : orders.length === 0 ? (
        <Card className="p-8 text-center text-muted-foreground">
          No hay material en proceso. Aquí aparecen las órdenes cuyo material ya se surtió y aún no se ha embarcado.
        </Card>
      ) : (
        <div className="flex gap-3 overflow-x-auto pb-2">
          {stages.map((st) => {
            const items = byStage(st);
            const meta = STAGE_META[st] || {};
            return (
              <div key={st} className="shrink-0 w-64">
                <div className={`flex items-center gap-2 px-3 py-2 rounded-t-lg border-b-2 ${meta.cls}`}>
                  <StageIcon stage={st} />
                  <span className="text-xs font-black uppercase tracking-wide">{labels[st] || st}</span>
                  <span className="ml-auto text-xs font-mono font-bold">{items.length}</span>
                </div>
                <div className="space-y-2 p-2 bg-secondary/10 rounded-b-lg min-h-[60px]">
                  {items.map((o) => (
                    <button
                      key={o.order_number}
                      onClick={() => setSelected(o.order_number)}
                      className="w-full text-left rounded-lg border border-border bg-card hover:border-primary/50 transition-colors p-2.5"
                    >
                      <div className="flex items-center justify-between">
                        <span className="font-bold text-sm text-foreground">{o.order_number}</span>
                        <span className="text-[10px] font-mono text-muted-foreground">{o.piezas} pz</span>
                      </div>
                      {o.cliente && <p className="text-[11px] text-muted-foreground truncate">{o.cliente}</p>}
                      {o.estilos?.length > 0 && (
                        <p className="text-[10px] text-muted-foreground truncate mt-0.5">{o.estilos.join(" · ")}</p>
                      )}
                      <div className="flex items-center gap-2 mt-1">
                        {o.location && (
                          <span className="text-[10px] text-amber-500 flex items-center gap-0.5"><MapPin className="w-3 h-3" />{o.location}</span>
                        )}
                        {!o.manual && <span className="text-[9px] text-muted-foreground/60 italic ml-auto">auto</span>}
                      </div>
                    </button>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {selected && (
        <DetailModal
          orderNumber={selected}
          labels={labels}
          onClose={() => setSelected(null)}
          onChanged={load}
        />
      )}
    </div>
  );
}
