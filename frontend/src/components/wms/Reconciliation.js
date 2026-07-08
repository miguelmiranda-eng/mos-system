import { useState, useEffect, useCallback } from "react";
import {
  ClipboardCheck, Loader2, RefreshCw, Trash2, MapPin, PackageX, PackagePlus,
  Unlock, CheckCircle2, ListChecks, Download, Ban, History, PackageCheck,
} from "lucide-react";
import * as XLSX from "xlsx";
import { toast } from "sonner";
import { fetcher, poster } from "./lib";

// Panel PC de conciliación (admin): cajas faltantes + creadas para resolver, y
// el registro de ubicaciones ya conciliadas (con opción de reabrir).

const TABS = [
  { id: "pending", label: "Por resolver", icon: PackageX },
  { id: "log", label: "Ubicaciones conciliadas", icon: ListChecks },
  { id: "adjustments", label: "Ajustes de cajas", icon: History },
  { id: "lpn", label: "Bloqueadas por LPN", icon: Ban },
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
  const [lpn, setLpn] = useState(null);
  const [adj, setAdj] = useState(null);
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

  const loadLpn = useCallback(async () => {
    setLoading(true);
    try { setLpn(await fetcher("/recon/lpn-locations")); }
    catch { toast.error("Error al cargar ubicaciones LPN"); }
    finally { setLoading(false); }
  }, []);

  const loadAdj = useCallback(async () => {
    setLoading(true);
    try { setAdj(await fetcher("/recon/adjustments")); }
    catch { toast.error("Error al cargar ajustes"); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => {
    if (tab === "pending" && !pending) loadPending();
    if (tab === "log" && !log) loadLog();
    if (tab === "lpn" && !lpn) loadLpn();
    if (tab === "adjustments" && !adj) loadAdj();
  }, [tab, pending, log, lpn, adj, loadPending, loadLog, loadLpn, loadAdj]);

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

  const [exporting, setExporting] = useState(false);
  const exportExcel = async () => {
    setExporting(true);
    try {
      // Trae datos frescos para que el export sea completo, sin importar la pestaña.
      const [pen, lg, lp] = await Promise.all([
        fetcher("/recon/pending"), fetcher("/recon/log"), fetcher("/recon/lpn-locations"),
      ]);
      const wb = XLSX.utils.book_new();

      const conciliadas = (lg.locations || []).map(l => ({
        Ubicacion: l.location, "Conciliada por": l.reconciled_by_name || "",
        Fecha: l.reconciled_at ? fmt(l.reconciled_at) : "",
        Confirmadas: l.counts?.confirmadas ?? "", Movidas: l.counts?.movidas ?? "",
        Creadas: l.counts?.creadas ?? "", Faltantes: l.counts?.faltantes ?? "",
        Escaneadas: l.counts?.escaneadas ?? "",
      }));
      XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(conciliadas.length ? conciliadas : [{}]), "Conciliadas");

      const faltantes = (pen.faltantes || []).map(b => ({
        Caja: b.box_id, Style: b.style, Color: b.color, Talla: b.size, Unidades: b.units,
        "Esperada en": b.recon_missing_from, "Marcada por": b.recon_flagged_by,
        Fecha: b.recon_flagged_at ? fmt(b.recon_flagged_at) : "",
      }));
      XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(faltantes.length ? faltantes : [{}]), "Faltantes");

      const creadas = (pen.creadas || []).map(b => ({
        Caja: b.box_id, Ubicacion: b.location, Unidades: b.units,
        "Creada por": b.recon_counted_by, Fecha: b.recon_counted_at ? fmt(b.recon_counted_at) : "",
      }));
      XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(creadas.length ? creadas : [{}]), "Creadas");

      const bloqueadas = (lp.locations || []).map(l => ({
        Ubicacion: l.location, "Cajas LPN": l.cajas, Unidades: l.unidades,
      }));
      XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(bloqueadas.length ? bloqueadas : [{}]), "Bloqueadas LPN");

      const stamp = new Date().toISOString().slice(0, 10);
      XLSX.writeFile(wb, `conciliacion_${stamp}.xlsx`);
      toast.success("Exportado a Excel");
    } catch { toast.error("Error al exportar"); }
    finally { setExporting(false); }
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
        <button onClick={exportExcel} disabled={exporting}
          className="flex items-center gap-2 px-3 py-2 rounded-xl bg-emerald-500/15 text-emerald-300 hover:bg-emerald-500/25 border border-emerald-500/30 disabled:opacity-50 text-xs font-black uppercase tracking-wider">
          {exporting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />} Exportar Excel
        </button>
        <button onClick={() => tab === "pending" ? loadPending() : tab === "log" ? loadLog() : tab === "adjustments" ? loadAdj() : loadLpn()}
          className="p-2 rounded-xl text-muted-foreground hover:text-foreground hover:bg-secondary/40">
          <RefreshCw className={`w-5 h-5 ${loading ? "animate-spin" : ""}`} />
        </button>
      </div>

      <div className="flex gap-1 border-b border-border">
        {TABS.map(t => {
          const Icon = t.icon;
          const badge = t.id === "pending" && pending ? (pending.faltantes_count + pending.creadas_count)
            : t.id === "log" && log ? log.count
            : t.id === "adjustments" && adj ? adj.count
            : t.id === "lpn" && lpn ? lpn.count : null;
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

      {/* ── Ajustes de cajas ── */}
      {tab === "adjustments" && (
        loading && !adj ? <div className="flex justify-center py-10"><Loader2 className="w-6 h-6 animate-spin text-muted-foreground" /></div>
        : adj && (
          adj.count === 0 ? <p className="text-center text-muted-foreground py-10">Sin ajustes de cajas registrados.</p>
          : <div className="space-y-4">
            {adj.adjustments.map((a, i) => (
              <div key={i} className="border border-sky-500/30 rounded-xl overflow-hidden">
                <div className="px-3 py-2 bg-sky-500/10 flex items-center justify-between gap-3">
                  <div className="flex items-center gap-2 text-sky-300 text-[11px] font-black uppercase tracking-widest">
                    <PackageCheck className="w-4 h-4" /> {a.type === "lpn_recon_restore" ? "Restauración de cajas LPN" : a.type}
                  </div>
                  <div className="text-xs text-muted-foreground">{fmt(a.created_at)} · {a.created_by}</div>
                </div>
                <div className="px-3 py-2 text-xs text-muted-foreground border-b border-border">
                  <b className="text-foreground">{a.count}</b> cajas · <b className="text-foreground">{(a.units || 0).toLocaleString()}</b> u · {a.reason}
                </div>
                <div className="px-3 py-2 flex flex-wrap gap-2 border-b border-border">
                  {(a.locations || []).map((l, j) => (
                    <span key={j} className="px-2 py-1 rounded-lg bg-secondary/60 text-xs font-mono">
                      {l.location}: {l.cajas}c / {l.unidades}u
                    </span>
                  ))}
                </div>
                <div className="overflow-x-auto max-h-72 overflow-y-auto">
                  <table className="w-full">
                    <thead className="sticky top-0 bg-card"><tr>
                      <Th>Caja (LPN)</Th><Th>Ubicación</Th><Th>Style</Th><Th>Color</Th><Th>Talla</Th><Th right>Unid.</Th>
                    </tr></thead>
                    <tbody>
                      {(a.boxes || []).map((b, k) => (
                        <tr key={k} className="border-t border-border/40 text-xs">
                          <td className="p-2 font-mono">{b.box_id}</td>
                          <td className="p-2 font-mono">{b.location}</td>
                          <td className="p-2">{b.style}</td><td className="p-2">{b.color}</td>
                          <td className="p-2">{b.size}</td><td className="p-2 text-right">{b.units}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            ))}
          </div>
        )
      )}

      {/* ── Bloqueadas por LPN ── */}
      {tab === "lpn" && (
        loading && !lpn ? <div className="flex justify-center py-10"><Loader2 className="w-6 h-6 animate-spin text-muted-foreground" /></div>
        : lpn && (
          <div className="border border-amber-500/30 rounded-xl overflow-hidden">
            <div className="px-3 py-2 bg-amber-500/10 text-[11px] font-black uppercase tracking-widest text-amber-300 flex items-center gap-2">
              <Ban className="w-4 h-4" /> {lpn.count.toLocaleString()} ubicaciones con cajas LPN — NO se pueden conciliar en el PDA
            </div>
            <div className="px-3 py-2 text-xs text-muted-foreground border-b border-border">
              Estas ubicaciones tienen cajas con licencia física (LPN, sin prefijo BOX). Avísale a los contadores que las omitan.
            </div>
            <div className="overflow-x-auto max-h-[32rem] overflow-y-auto">
              <table className="w-full">
                <thead className="sticky top-0 bg-card"><tr><Th>Ubicación</Th><Th right>Cajas LPN</Th><Th right>Unidades</Th></tr></thead>
                <tbody>
                  {lpn.locations.map((l, i) => (
                    <tr key={i} className="border-t border-border/40 text-xs">
                      <td className="p-2 font-mono font-bold">{l.location}</td>
                      <td className="p-2 text-right">{l.cajas.toLocaleString()}</td>
                      <td className="p-2 text-right">{(l.unidades || 0).toLocaleString()}</td>
                    </tr>
                  ))}
                  {lpn.count === 0 && <tr><td colSpan={3} className="p-3 text-xs text-muted-foreground">Ninguna ubicación tiene cajas LPN.</td></tr>}
                </tbody>
              </table>
            </div>
          </div>
        )
      )}
    </div>
  );
};
