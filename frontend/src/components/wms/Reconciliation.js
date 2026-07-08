import { useState, useEffect, useCallback } from "react";
import {
  ClipboardCheck, Loader2, RefreshCw, Trash2, MapPin, PackageX, PackagePlus,
  Unlock, CheckCircle2, ListChecks,
} from "lucide-react";
import { toast } from "sonner";
import { fetcher, poster } from "./lib";

// Panel PC de conciliación (admin): cajas faltantes + creadas para resolver, y
// el registro de ubicaciones ya conciliadas (con opción de reabrir).

const TABS = [
  { id: "pending", label: "Por resolver", icon: PackageX },
  { id: "log", label: "Ubicaciones conciliadas", icon: ListChecks },
];

const fmt = (iso) => {
  if (!iso) return "-";
  const d = new Date(iso);
  return isNaN(d) ? String(iso).slice(0, 16) : d.toLocaleString("es-MX", { day: "2-digit", month: "2-digit", year: "2-digit", hour: "2-digit", minute: "2-digit" });
};

const Th = ({ children, right }) => <th className={`p-2 text-[10px] font-black uppercase tracking-widest text-muted-foreground ${right ? "text-right" : "text-left"}`}>{children}</th>;

export const ReconciliationModule = () => {
  const [tab, setTab] = useState("pending");
  const [pending, setPending] = useState(null);
  const [log, setLog] = useState(null);
  const [loading, setLoading] = useState(false);

  const loadPending = useCallback(async () => {
    setLoading(true);
    try { setPending(await fetcher("/recon/pending")); }
    catch { toast.error("Error al cargar (¿permiso admin?)"); }
    finally { setLoading(false); }
  }, []);
  const loadLog = useCallback(async () => {
    setLoading(true);
    try { setLog(await fetcher("/recon/log")); }
    catch { toast.error("Error al cargar el registro"); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { if (tab === "pending" && !pending) loadPending(); if (tab === "log" && !log) loadLog(); }, [tab, pending, log, loadPending, loadLog]);

  const resolve = async (box_id, action) => {
    let location;
    if (action === "assign") {
      location = window.prompt(`¿A qué ubicación asignar ${box_id}?`);
      if (!location) return;
    } else if (action === "delete") {
      if (!window.confirm(`¿Borrar la caja ${box_id} del sistema?`)) return;
    }
    try {
      const res = await poster("/recon/resolve", { box_id, action, location });
      if (res.ok) { toast.success(action === "delete" ? "Caja borrada" : "Caja asignada"); loadPending(); }
      else { const e = await res.json().catch(() => ({})); toast.error(e.detail || "Error"); }
    } catch { toast.error("Error de conexión"); }
  };

  const reopen = async (location) => {
    if (!window.confirm(`¿Reabrir ${location} para volver a conciliarla?`)) return;
    try {
      const res = await poster("/recon/reopen", { location });
      if (res.ok) { toast.success(`${location} reabierta`); loadLog(); }
      else { const e = await res.json().catch(() => ({})); toast.error(e.detail || "Error"); }
    } catch { toast.error("Error de conexión"); }
  };

  return (
    <div className="space-y-5">
      <div className="flex items-center gap-3">
        <div className="p-2 rounded-xl bg-emerald-500/15 border border-emerald-500/30">
          <ClipboardCheck className="w-6 h-6 text-emerald-400" />
        </div>
        <div className="flex-1">
          <h2 className="text-xl font-black uppercase tracking-wide">Conciliación</h2>
          <p className="text-[11px] text-muted-foreground">Cajas por resolver y registro de ubicaciones conciliadas</p>
        </div>
        <button onClick={() => tab === "pending" ? loadPending() : loadLog()}
          className="p-2 rounded-xl text-muted-foreground hover:text-foreground hover:bg-secondary/40">
          <RefreshCw className={`w-5 h-5 ${loading ? "animate-spin" : ""}`} />
        </button>
      </div>

      <div className="flex gap-1 border-b border-border">
        {TABS.map(t => {
          const Icon = t.icon;
          const badge = t.id === "pending" && pending ? (pending.faltantes_count + pending.creadas_count)
            : t.id === "log" && log ? log.count : null;
          return (
            <button key={t.id} onClick={() => setTab(t.id)}
              className={`flex items-center gap-2 px-4 py-2.5 text-xs font-black uppercase tracking-wider border-b-2 transition-colors
                ${tab === t.id ? "border-primary text-primary" : "border-transparent text-muted-foreground hover:text-foreground"}`}>
              <Icon className="w-4 h-4" /> {t.label}
              {badge != null && <span className="px-1.5 py-0.5 rounded-full bg-secondary text-[10px]">{badge}</span>}
            </button>
          );
        })}
      </div>

      {/* ── Por resolver ── */}
      {tab === "pending" && pending && (
        <div className="space-y-5">
          <section className="border border-red-500/30 rounded-xl overflow-hidden">
            <div className="px-3 py-2 bg-red-500/10 text-[11px] font-black uppercase tracking-widest text-red-300 flex items-center gap-2">
              <PackageX className="w-4 h-4" /> Faltantes ({pending.faltantes_count}) — esperadas y no encontradas
            </div>
            <div className="overflow-x-auto max-h-96 overflow-y-auto">
              <table className="w-full">
                <thead className="sticky top-0 bg-card"><tr>
                  <Th>Caja</Th><Th>Style</Th><Th>Color</Th><Th>Talla</Th><Th right>Unid.</Th>
                  <Th>Esperada en</Th><Th>Marcada por</Th><Th right>Acción</Th>
                </tr></thead>
                <tbody>
                  {pending.faltantes.map((b, i) => (
                    <tr key={i} className="border-t border-border/40 text-xs">
                      <td className="p-2 font-mono">{b.box_id}</td>
                      <td className="p-2">{b.style}</td><td className="p-2">{b.color}</td><td className="p-2">{b.size}</td>
                      <td className="p-2 text-right">{b.units}</td>
                      <td className="p-2 font-mono">{b.recon_missing_from}</td>
                      <td className="p-2">{b.recon_flagged_by}</td>
                      <td className="p-2 text-right whitespace-nowrap">
                        <button onClick={() => resolve(b.box_id, "assign")} title="Asignar a ubicación" className="p-1.5 rounded-lg text-sky-400 hover:bg-sky-500/10"><MapPin className="w-4 h-4" /></button>
                        <button onClick={() => resolve(b.box_id, "delete")} title="Borrar (perdida)" className="p-1.5 rounded-lg text-red-400 hover:bg-red-500/10"><Trash2 className="w-4 h-4" /></button>
                      </td>
                    </tr>
                  ))}
                  {pending.faltantes_count === 0 && <tr><td colSpan={8} className="p-3 text-xs text-muted-foreground">Sin faltantes.</td></tr>}
                </tbody>
              </table>
            </div>
          </section>

          <section className="border border-amber-500/30 rounded-xl overflow-hidden">
            <div className="px-3 py-2 bg-amber-500/10 text-[11px] font-black uppercase tracking-widest text-amber-300 flex items-center gap-2">
              <PackagePlus className="w-4 h-4" /> Creadas en conciliación ({pending.creadas_count}) — escaneadas sin existir
            </div>
            <div className="overflow-x-auto max-h-80 overflow-y-auto">
              <table className="w-full">
                <thead className="sticky top-0 bg-card"><tr>
                  <Th>Caja</Th><Th>Ubicación</Th><Th right>Unid.</Th><Th>Creada por</Th><Th>Fecha</Th><Th right>Acción</Th>
                </tr></thead>
                <tbody>
                  {pending.creadas.map((b, i) => (
                    <tr key={i} className="border-t border-border/40 text-xs">
                      <td className="p-2 font-mono">{b.box_id}</td>
                      <td className="p-2 font-mono">{b.location}</td>
                      <td className="p-2 text-right">{b.units}</td>
                      <td className="p-2">{b.recon_counted_by}</td>
                      <td className="p-2">{fmt(b.recon_counted_at)}</td>
                      <td className="p-2 text-right">
                        <button onClick={() => resolve(b.box_id, "delete")} title="Borrar" className="p-1.5 rounded-lg text-red-400 hover:bg-red-500/10"><Trash2 className="w-4 h-4" /></button>
                      </td>
                    </tr>
                  ))}
                  {pending.creadas_count === 0 && <tr><td colSpan={6} className="p-3 text-xs text-muted-foreground">Sin cajas creadas.</td></tr>}
                </tbody>
              </table>
            </div>
          </section>
        </div>
      )}

      {/* ── Registro ── */}
      {tab === "log" && log && (
        <div className="border border-border rounded-xl overflow-hidden">
          <div className="px-3 py-2 bg-secondary/40 text-[11px] font-black uppercase tracking-widest flex items-center gap-2">
            <CheckCircle2 className="w-4 h-4 text-emerald-400" /> {log.count} ubicaciones conciliadas
          </div>
          <div className="overflow-x-auto max-h-[32rem] overflow-y-auto">
            <table className="w-full">
              <thead className="sticky top-0 bg-card"><tr>
                <Th>Ubicación</Th><Th>Conciliada por</Th><Th>Fecha</Th>
                <Th right>Confirm.</Th><Th right>Movidas</Th><Th right>Creadas</Th><Th right>Faltantes</Th><Th right>Acción</Th>
              </tr></thead>
              <tbody>
                {log.locations.map((l, i) => (
                  <tr key={i} className="border-t border-border/40 text-xs">
                    <td className="p-2 font-mono font-bold">{l.location}</td>
                    <td className="p-2">{l.reconciled_by_name}</td>
                    <td className="p-2">{fmt(l.reconciled_at)}</td>
                    <td className="p-2 text-right">{l.counts?.confirmadas ?? "-"}</td>
                    <td className="p-2 text-right">{l.counts?.movidas ?? "-"}</td>
                    <td className="p-2 text-right text-amber-400">{l.counts?.creadas ?? "-"}</td>
                    <td className="p-2 text-right text-red-400">{l.counts?.faltantes ?? "-"}</td>
                    <td className="p-2 text-right">
                      <button onClick={() => reopen(l.location)} title="Reabrir" className="p-1.5 rounded-lg text-amber-400 hover:bg-amber-500/10 inline-flex items-center gap-1">
                        <Unlock className="w-4 h-4" /> <span className="text-[10px] font-black uppercase">Reabrir</span>
                      </button>
                    </td>
                  </tr>
                ))}
                {log.count === 0 && <tr><td colSpan={8} className="p-3 text-xs text-muted-foreground">Aún no se ha conciliado ninguna ubicación.</td></tr>}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
};
