import React, { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { API } from "../lib/constants";
import {
  ArrowLeft, Zap, Clock, RefreshCw, Save, Loader2,
  CheckCircle2, AlertTriangle, Hash, Timer,
} from "lucide-react";
import { toast } from "sonner";

const DEFAULT_CONFIG = {
  enabled: false,
  poll_minutes: 5,
  fetch_size: 25,
  last_visual_id: null,
  last_run_at: null,
  last_error: null,
  created_count: 0,
  configured: false,
};

export default function PrintavoSync() {
  const navigate = useNavigate();
  const [config, setConfig] = useState(DEFAULT_CONFIG);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [syncing, setSyncing] = useState(false);

  useEffect(() => { fetchConfig(); }, []);

  const fetchConfig = async () => {
    setLoading(true);
    try {
      const res = await fetch(`${API}/printavo-sync`, { credentials: "include" });
      if (res.ok) {
        const data = await res.json();
        setConfig({ ...DEFAULT_CONFIG, ...data });
      } else {
        toast.error("No se pudo cargar la configuración");
      }
    } catch {
      toast.error("Error de conexión");
    } finally {
      setLoading(false);
    }
  };

  const patch = (changes) => setConfig((c) => ({ ...c, ...changes }));

  const handleSave = async () => {
    setSaving(true);
    try {
      const res = await fetch(`${API}/printavo-sync`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          enabled: config.enabled,
          poll_minutes: config.poll_minutes,
          fetch_size: config.fetch_size,
        }),
      });
      if (res.ok) {
        const data = await res.json();
        setConfig({ ...DEFAULT_CONFIG, ...data });
        toast.success("Configuración guardada");
      } else {
        const err = await res.json().catch(() => ({}));
        toast.error(err.detail || "Error al guardar");
      }
    } catch {
      toast.error("Error al guardar");
    } finally {
      setSaving(false);
    }
  };

  const handleSyncNow = async () => {
    setSyncing(true);
    try {
      const res = await fetch(`${API}/printavo-sync/run-now`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({}),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        if (data.initialized) {
          toast.success(`Marca inicial fijada (invoice #${data.watermark ?? "—"}). Los nuevos invoices desde aquí se importarán.`);
        } else {
          toast.success(`Sincronización lista: ${data.created || 0} orden(es) creada(s) de ${data.seen || 0} invoice(s) revisados`);
        }
        fetchConfig();
      } else {
        toast.error(data.detail || "Error al sincronizar");
      }
    } catch {
      toast.error("Error al sincronizar");
    } finally {
      setSyncing(false);
    }
  };

  const fmtDate = (iso) => {
    if (!iso) return "Nunca";
    try { return new Date(iso).toLocaleString(); } catch { return iso; }
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <Loader2 className="w-10 h-10 animate-spin text-primary" />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background text-foreground font-barlow flex flex-col relative overflow-hidden">
      <div className="absolute top-0 right-0 w-1/2 h-1/2 bg-primary/5 blur-[120px] rounded-full -translate-y-1/2 translate-x-1/2 pointer-events-none" />
      <div className="absolute bottom-0 left-0 w-1/3 h-1/3 bg-cyan-500/5 blur-[100px] rounded-full translate-y-1/2 -translate-x-1/3 pointer-events-none" />

      {/* Header */}
      <header className="sticky top-0 z-40 bg-background/80 backdrop-blur-xl border-b border-border h-16 flex items-center justify-between px-6 shadow-sm">
        <div className="flex items-center gap-4">
          <button
            onClick={() => navigate("/home")}
            className="w-10 h-10 flex flex-shrink-0 items-center justify-center rounded-xl bg-secondary/50 hover:bg-secondary border border-white/5 transition-all text-muted-foreground hover:text-foreground hover:shadow-lg hover:-translate-x-0.5"
            title="Volver a MOS Home"
          >
            <ArrowLeft className="w-5 h-5" />
          </button>
          <div>
            <h1 className="text-xl font-black uppercase tracking-widest text-foreground flex items-center gap-2">
              <Zap className="w-5 h-5 text-primary" />
              Sincronización Printavo
            </h1>
            <p className="text-xs text-muted-foreground font-mono leading-none mt-1">
              Crea órdenes en MOS automáticamente desde invoices de Printavo
            </p>
          </div>
        </div>

        <button
          onClick={handleSave}
          disabled={saving}
          className="px-6 py-2 bg-gradient-to-r from-primary to-orange-500 hover:from-primary/90 hover:to-orange-500/90 text-white rounded-lg font-black tracking-widest text-sm transition-all shadow-[0_4px_20px_rgba(255,193,7,0.3)] hover:shadow-[0_4px_25px_rgba(255,193,7,0.5)] flex items-center gap-2 disabled:opacity-50"
        >
          {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
          Guardar
        </button>
      </header>

      {/* Body */}
      <main className="flex-1 relative z-10 w-full max-w-3xl mx-auto px-4 md:px-6 py-8 space-y-6">

        {/* Credentials status banner */}
        {!config.configured && (
          <section className="bg-destructive/10 border border-destructive/30 rounded-2xl p-5 flex items-start gap-3">
            <AlertTriangle className="w-5 h-5 text-destructive shrink-0 mt-0.5" />
            <div>
              <h2 className="text-sm font-bold text-destructive">Credenciales de Printavo no configuradas</h2>
              <p className="text-sm text-muted-foreground mt-1">
                Agrega <code className="text-foreground font-mono">PRINTAVO_API_EMAIL</code> y{" "}
                <code className="text-foreground font-mono">PRINTAVO_API_TOKEN</code> en el archivo{" "}
                <code className="text-foreground font-mono">.env</code> del backend (genera el token en Printavo → My Account → API) y reinicia el backend.
              </p>
            </div>
          </section>
        )}

        {/* Master toggle */}
        <section className="bg-card/60 backdrop-blur-xl border border-border rounded-2xl p-6 flex items-center justify-between gap-4">
          <div>
            <h2 className="text-base font-bold text-foreground">Sincronización automática</h2>
            <p className="text-sm text-muted-foreground mt-1">
              Cuando está activa, MOS revisa Printavo cada pocos minutos y crea la orden de cada invoice nuevo en el tablero SCHEDULING.
            </p>
          </div>
          <button
            type="button"
            onClick={() => patch({ enabled: !config.enabled })}
            disabled={!config.configured}
            className={`relative inline-flex h-7 w-12 shrink-0 items-center rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-primary focus:ring-offset-2 focus:ring-offset-background disabled:opacity-40 ${config.enabled ? "bg-green-500" : "bg-secondary"}`}
            aria-pressed={config.enabled}
          >
            <span className={`inline-block h-5 w-5 transform rounded-full bg-white shadow transition-transform ${config.enabled ? "translate-x-6" : "translate-x-1"}`} />
          </button>
        </section>

        {/* Interval */}
        <section className="bg-card/60 backdrop-blur-xl border border-border rounded-2xl p-6 space-y-4">
          <h2 className="text-xs font-black uppercase tracking-widest text-muted-foreground flex items-center gap-2">
            <Clock className="w-4 h-4 text-primary" /> Frecuencia
          </h2>
          <div className="grid grid-cols-2 gap-4 max-w-sm">
            <div>
              <label className="text-xs text-muted-foreground mb-1 block">Intervalo (minutos)</label>
              <input
                type="number" min="1" max="1440"
                value={config.poll_minutes}
                onChange={(e) => patch({ poll_minutes: parseInt(e.target.value, 10) || 5 })}
                className="w-full bg-secondary/50 border border-border p-2.5 rounded-lg text-foreground"
              />
            </div>
            <div>
              <label className="text-xs text-muted-foreground mb-1 block">Invoices por revisión</label>
              <input
                type="number" min="1" max="100"
                value={config.fetch_size}
                onChange={(e) => patch({ fetch_size: parseInt(e.target.value, 10) || 25 })}
                className="w-full bg-secondary/50 border border-border p-2.5 rounded-lg text-foreground"
              />
            </div>
          </div>
          <p className="text-xs text-muted-foreground/70">
            El cambio de intervalo aplica al reiniciar el backend. Puedes forzar una revisión ahora con el botón de abajo.
          </p>
        </section>

        {/* Status */}
        <section className="bg-card/60 backdrop-blur-xl border border-border rounded-2xl p-6 space-y-4">
          <h2 className="text-xs font-black uppercase tracking-widest text-muted-foreground flex items-center gap-2">
            <Timer className="w-4 h-4 text-primary" /> Estado
          </h2>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div className="bg-secondary/40 rounded-xl p-4">
              <p className="text-[10px] uppercase tracking-widest text-muted-foreground/60 font-black flex items-center gap-1.5">
                <CheckCircle2 className="w-3.5 h-3.5" /> Órdenes creadas
              </p>
              <p className="text-2xl font-black text-primary mt-1 tabular-nums">{config.created_count || 0}</p>
            </div>
            <div className="bg-secondary/40 rounded-xl p-4">
              <p className="text-[10px] uppercase tracking-widest text-muted-foreground/60 font-black flex items-center gap-1.5">
                <Hash className="w-3.5 h-3.5" /> Último invoice
              </p>
              <p className="text-2xl font-black text-foreground mt-1 tabular-nums">{config.last_visual_id || "—"}</p>
            </div>
            <div className="bg-secondary/40 rounded-xl p-4">
              <p className="text-[10px] uppercase tracking-widest text-muted-foreground/60 font-black flex items-center gap-1.5">
                <Clock className="w-3.5 h-3.5" /> Última revisión
              </p>
              <p className="text-sm font-semibold text-foreground mt-2">{fmtDate(config.last_run_at)}</p>
            </div>
          </div>
          {config.last_error && (
            <div className="flex items-start gap-2 bg-destructive/10 border border-destructive/30 rounded-lg px-3 py-2">
              <AlertTriangle className="w-4 h-4 text-destructive shrink-0 mt-0.5" />
              <p className="text-xs text-destructive break-all">{config.last_error}</p>
            </div>
          )}
        </section>

        {/* Manual sync */}
        <section className="bg-card/60 backdrop-blur-xl border border-border rounded-2xl p-6 space-y-4">
          <h2 className="text-xs font-black uppercase tracking-widest text-muted-foreground flex items-center gap-2">
            <RefreshCw className="w-4 h-4 text-primary" /> Sincronizar ahora
          </h2>
          <p className="text-sm text-muted-foreground">
            Revisa Printavo de inmediato sin esperar el intervalo. En la primera vez solo fija la marca inicial (no importa el historial); a partir de ahí crea las órdenes de los invoices nuevos.
          </p>
          <button
            onClick={handleSyncNow}
            disabled={syncing || !config.configured}
            className="px-6 py-2.5 bg-gradient-to-r from-cyan-600 to-blue-600 hover:from-cyan-500 hover:to-blue-500 text-white rounded-lg font-bold text-sm transition-all shadow-[0_4px_20px_rgba(8,145,178,0.3)] flex items-center justify-center gap-2 disabled:opacity-50"
          >
            {syncing ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
            {syncing ? "Sincronizando..." : "Sincronizar ahora"}
          </button>
        </section>
      </main>
    </div>
  );
}
