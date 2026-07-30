import { useState, useEffect, useCallback, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import {
  ArrowLeft, RefreshCw, Loader2, Gauge, Cog, Package, ClipboardList, Users,
  TrendingUp, Target, Clock, Boxes, Activity, Zap, CheckCircle2, AlertTriangle,
} from "lucide-react";
import {
  AreaChart, Area, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, Cell,
} from "recharts";
import { API } from "../lib/constants";
import { useTheme } from "../contexts/ThemeContext";

// ── Producción — tablero muy visual de la nave. Toda la data sale de endpoints
// que ya existen: /production-analytics (por hora/turno/máquina/PO, meta y
// eficiencia), /capacity-plan (carga por máquina) y /orders/board-counts (WIP
// por etapa). Se refresca solo cada 60s. Estilo token-based: se adapta a claro/
// oscuro sin ramas manuales salvo en los ejes/tooltip de recharts.

const PALETTE = ["#3b82f6", "#22c55e", "#eab308", "#8b5cf6", "#06b6d4", "#f97316", "#ec4899", "#14b8a6"];
const fmtInt = (n) => (Number(n) || 0).toLocaleString("es-MX");

const PERIODS = [
  { id: "today", label: "Hoy" },
  { id: "yesterday", label: "Ayer" },
  { id: "week", label: "7 días" },
  { id: "month", label: "30 días" },
];

const TABS = [
  { id: "general", label: "General", icon: Gauge },
  { id: "maquinas", label: "Máquinas", icon: Cog },
  { id: "empaque", label: "Empaque", icon: Package },
  { id: "ordenes", label: "Órdenes", icon: ClipboardList },
  { id: "operadores", label: "Operadores", icon: Users },
];

// Estados del flujo relacionados con empaque / salida.
const EMPAQUE_STATUSES = ["NECESITA EMPACAR", "EN PROCESO DE EMPAQUE", "LISTO PARA FULFILLMENT", "LISTO PARA ENVIO"];
const LOAD_TONE = {
  idle: { chip: "bg-muted text-muted-foreground border-border", bar: "bg-muted-foreground/40", label: "Libre" },
  green: { chip: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/25", bar: "bg-emerald-500", label: "En ritmo" },
  yellow: { chip: "bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/25", bar: "bg-amber-500", label: "Cargada" },
  red: { chip: "bg-red-500/10 text-red-600 dark:text-red-400 border-red-500/25", bar: "bg-red-500", label: "Saturada" },
};

export default function ProduccionModule() {
  const navigate = useNavigate();
  const { theme } = useTheme();
  const isDark = theme === "dark";

  const [period, setPeriod] = useState("today");
  const [tab, setTab] = useState("general");
  const [analytics, setAnalytics] = useState(null);
  const [capacity, setCapacity] = useState(null);
  const [boards, setBoards] = useState({});
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async (silent) => {
    silent ? setRefreshing(true) : setLoading(true);
    try {
      const [a, c, b] = await Promise.all([
        fetch(`${API}/production-analytics?preset=${period}`, { credentials: "include" }).then(r => r.ok ? r.json() : null),
        fetch(`${API}/capacity-plan`, { credentials: "include" }).then(r => r.ok ? r.json() : null),
        fetch(`${API}/orders/board-counts`, { credentials: "include" }).then(r => r.ok ? r.json() : null),
      ]);
      if (a) setAnalytics(a);
      if (c) setCapacity(c);
      if (b) setBoards(b.counts || b || {});
    } catch { toast.error("Error al cargar producción"); }
    finally { setLoading(false); setRefreshing(false); }
  }, [period]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { const id = setInterval(() => load(true), 60000); return () => clearInterval(id); }, [load]);

  // Serie de tendencia: por hora en "Hoy", por día en el resto.
  const trend = useMemo(() => {
    if (!analytics) return [];
    if (period === "today") {
      return (analytics.hourly_trend || []).map(h => ({ label: String(h.hour).slice(11, 16), produced: h.produced }));
    }
    return (analytics.by_day || []).map(d => ({ label: String(d.date).slice(5), produced: d.produced }));
  }, [analytics, period]);

  const axis = isDark ? "#64748b" : "#94a3b8";
  const grid = isDark ? "#1f2937" : "#e5e7eb";
  const tooltipStyle = {
    background: isDark ? "#0f172a" : "#ffffff",
    border: `1px solid ${isDark ? "#1f2937" : "#e5e7eb"}`,
    borderRadius: 8, fontSize: 12, color: isDark ? "#e2e8f0" : "#0f172a",
  };
  const chartProps = { axis, grid, tooltipStyle };

  return (
    <div className="min-h-screen bg-background text-foreground">
      {/* Header */}
      <header className="sticky top-0 z-30 bg-background/95 backdrop-blur border-b border-border">
        <div className="max-w-7xl mx-auto px-4 md:px-6 py-3 flex items-center gap-3 flex-wrap">
          <button onClick={() => navigate("/dashboard")}
            className="p-2 -ml-1 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted transition-colors">
            <ArrowLeft className="w-5 h-5" />
          </button>
          <div className="w-9 h-9 rounded-lg bg-primary/10 border border-primary/20 flex items-center justify-center">
            <Activity className="w-5 h-5 text-primary" />
          </div>
          <div className="min-w-0">
            <h1 className="text-lg font-bold tracking-tight leading-none">Producción</h1>
            <p className="text-xs text-muted-foreground mt-0.5">Tablero de la nave en tiempo casi real</p>
          </div>

          <div className="ml-auto flex items-center gap-2">
            <div className="flex items-center gap-1 p-1 rounded-lg bg-muted/60 border border-border">
              {PERIODS.map(p => (
                <button key={p.id} onClick={() => setPeriod(p.id)}
                  className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${period === p.id ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"}`}>
                  {p.label}
                </button>
              ))}
            </div>
            <button onClick={() => load(true)} title="Actualizar"
              className="p-2 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted transition-colors">
              <RefreshCw className={`w-5 h-5 ${refreshing ? "animate-spin" : ""}`} />
            </button>
          </div>
        </div>

        {/* Tabs */}
        <div className="max-w-7xl mx-auto px-2 md:px-6 flex gap-1 overflow-x-auto">
          {TABS.map(t => {
            const Icon = t.icon;
            return (
              <button key={t.id} onClick={() => setTab(t.id)}
                className={`flex items-center gap-2 px-3 md:px-4 py-2.5 text-sm font-medium border-b-2 whitespace-nowrap transition-colors ${tab === t.id ? "border-primary text-primary" : "border-transparent text-muted-foreground hover:text-foreground"}`}>
                <Icon className="w-4 h-4" /> {t.label}
              </button>
            );
          })}
        </div>
      </header>

      <main className="max-w-7xl mx-auto p-4 md:p-6">
        {loading && !analytics ? (
          <div className="flex items-center justify-center py-32"><Loader2 className="w-8 h-8 animate-spin text-primary" /></div>
        ) : (
          <>
            {tab === "general" && <GeneralTab a={analytics} trend={trend} period={period} chart={chartProps} />}
            {tab === "maquinas" && <MaquinasTab a={analytics} cap={capacity} chart={chartProps} />}
            {tab === "empaque" && <EmpaqueTab a={analytics} boards={boards} />}
            {tab === "ordenes" && <OrdenesTab a={analytics} />}
            {tab === "operadores" && <OperadoresTab a={analytics} />}
          </>
        )}
      </main>
    </div>
  );
}

/* ── Primitivas visuales ─────────────────────────────────────────────────── */

function Kpi({ icon: Icon, label, value, sub, accent = "text-primary" }) {
  return (
    <div className="bg-card border border-border rounded-lg p-4">
      <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
        <Icon className={`w-4 h-4 ${accent}`} /> {label}
      </div>
      <div className="mt-2 text-3xl font-semibold tabular-nums leading-none">{value}</div>
      {sub && <div className="mt-1 text-xs text-muted-foreground">{sub}</div>}
    </div>
  );
}

function Panel({ title, icon: Icon, right, children, className = "" }) {
  return (
    <div className={`bg-card border border-border rounded-lg ${className}`}>
      <div className="px-4 py-3 border-b border-border flex items-center gap-2">
        {Icon && <Icon className="w-4 h-4 text-muted-foreground" />}
        <span className="text-sm font-semibold">{title}</span>
        {right && <div className="ml-auto">{right}</div>}
      </div>
      <div className="p-4">{children}</div>
    </div>
  );
}

// Ranking horizontal sin recharts: etiqueta + barra proporcional + valor.
function RankBars({ rows, colorAt }) {
  const max = Math.max(1, ...rows.map(r => r.value));
  return (
    <div className="space-y-2.5">
      {rows.length === 0 && <div className="text-sm text-muted-foreground py-2">Sin datos en el periodo.</div>}
      {rows.map((r, i) => (
        <div key={r.label + i} className="flex items-center gap-3">
          <div className="w-28 shrink-0 text-xs font-medium truncate" title={r.label}>{r.label}</div>
          <div className="flex-1 h-6 rounded-md bg-muted/50 overflow-hidden">
            <div className="h-full rounded-md transition-all" style={{ width: `${(r.value / max) * 100}%`, background: colorAt ? colorAt(i) : PALETTE[i % PALETTE.length] }} />
          </div>
          <div className="w-16 shrink-0 text-right text-sm font-semibold tabular-nums">{fmtInt(r.value)}</div>
        </div>
      ))}
    </div>
  );
}

// Anillo de progreso (eficiencia). SVG puro para que se vea fuerte.
function Ring({ pct, label, sub }) {
  const p = Math.max(0, Math.min(100, Number(pct) || 0));
  const r = 46, c = 2 * Math.PI * r, off = c * (1 - p / 100);
  const stroke = p >= 90 ? "#22c55e" : p >= 60 ? "#3b82f6" : p >= 30 ? "#eab308" : "#ef4444";
  return (
    <div className="flex flex-col items-center justify-center">
      <div className="relative w-32 h-32">
        <svg viewBox="0 0 120 120" className="w-32 h-32 -rotate-90">
          <circle cx="60" cy="60" r={r} fill="none" strokeWidth="12" className="stroke-muted" />
          <circle cx="60" cy="60" r={r} fill="none" strokeWidth="12" stroke={stroke}
            strokeDasharray={c} strokeDashoffset={off} strokeLinecap="round"
            style={{ transition: "stroke-dashoffset .6s ease" }} />
        </svg>
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          <div className="text-2xl font-semibold tabular-nums">{p}%</div>
          <div className="text-[10px] uppercase tracking-widest text-muted-foreground">{label}</div>
        </div>
      </div>
      {sub && <div className="mt-2 text-xs text-muted-foreground text-center">{sub}</div>}
    </div>
  );
}

function ProgressRow({ label, produced, target }) {
  const pct = target > 0 ? Math.min(100, Math.round((produced / target) * 100)) : 0;
  const done = target > 0 && produced >= target;
  return (
    <div>
      <div className="flex items-center justify-between text-xs mb-1">
        <span className="font-medium truncate">{label}</span>
        <span className="tabular-nums text-muted-foreground">{fmtInt(produced)} / {fmtInt(target)} · {pct}%</span>
      </div>
      <div className="h-2 rounded-full bg-muted overflow-hidden">
        <div className={`h-full rounded-full ${done ? "bg-emerald-500" : "bg-primary"}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

/* ── Pestañas ────────────────────────────────────────────────────────────── */

function GeneralTab({ a, trend, period, chart }) {
  if (!a) return null;
  const shifts = (a.by_shift || []).map(s => ({ label: s._id || s.shift || "?", value: s.produced }));
  return (
    <div className="space-y-5">
      {/* KPIs */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <Kpi icon={TrendingUp} label="Producido" value={fmtInt(a.total_produced)} sub={`${fmtInt(a.total_logs)} registros`} accent="text-emerald-500" />
        <Kpi icon={Target} label="Meta (órdenes)" value={fmtInt(a.total_target)} sub={`Restan ${fmtInt(a.total_remaining)}`} accent="text-blue-500" />
        <Kpi icon={Zap} label="Eficiencia" value={`${a.efficiency ?? 0}%`} sub="producido vs meta" accent="text-violet-500" />
        <Kpi icon={Clock} label="Setup prom." value={`${fmtInt(a.avg_setup)} min`} sub="por registro" accent="text-amber-500" />
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-3 gap-5">
        {/* Trend */}
        <Panel className="xl:col-span-2" title={period === "today" ? "Producción por hora" : "Producción por día"} icon={Activity}>
          <div className="h-72">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={trend} margin={{ top: 8, right: 8, left: -12, bottom: 0 }}>
                <defs>
                  <linearGradient id="prodFill" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#3b82f6" stopOpacity={0.35} />
                    <stop offset="100%" stopColor="#3b82f6" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke={chart.grid} vertical={false} />
                <XAxis dataKey="label" tick={{ fontSize: 11, fill: chart.axis }} axisLine={false} tickLine={false} />
                <YAxis tick={{ fontSize: 11, fill: chart.axis }} axisLine={false} tickLine={false} width={44} />
                <Tooltip contentStyle={chart.tooltipStyle} cursor={{ stroke: chart.axis, strokeWidth: 1 }} />
                <Area type="monotone" dataKey="produced" name="Producido" stroke="#3b82f6" strokeWidth={2} fill="url(#prodFill)" />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </Panel>

        {/* Eficiencia + meta */}
        <Panel title="Avance vs meta" icon={Target}>
          <Ring pct={a.efficiency} label="Eficiencia" sub={`${fmtInt(a.total_produced)} de ${fmtInt(a.total_target)} u`} />
          <div className="mt-4 space-y-3">
            <ProgressRow label="Avance global" produced={a.total_produced} target={a.total_target} />
            <div className="grid grid-cols-2 gap-2 pt-1">
              <div className="rounded-md border border-border p-2 text-center">
                <div className="text-lg font-semibold tabular-nums text-emerald-500">{fmtInt(a.total_produced)}</div>
                <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Producido</div>
              </div>
              <div className="rounded-md border border-border p-2 text-center">
                <div className="text-lg font-semibold tabular-nums text-amber-500">{fmtInt(a.total_remaining)}</div>
                <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Restante</div>
              </div>
            </div>
          </div>
        </Panel>
      </div>

      {/* Por turno */}
      <Panel title="Producción por turno" icon={Clock}>
        <RankBars rows={shifts} />
      </Panel>
    </div>
  );
}

function MaquinasTab({ a, cap, chart }) {
  const byMachine = (a?.by_machine || [])
    .filter(m => (m._id || m.machine) && (m._id || m.machine) !== "?")
    .map(m => ({ label: (m._id || m.machine).replace("MAQUINA", "M"), produced: m.produced, count: m.count }))
    .sort((x, y) => y.produced - x.produced);
  const machines = cap?.machines || [];

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <Kpi icon={Boxes} label="En producción" value={fmtInt(cap?.in_production)} sub="unidades en máquinas" accent="text-blue-500" />
        <Kpi icon={CheckCircle2} label="Completado" value={fmtInt(cap?.total_completed)} sub="board COMPLETOS" accent="text-emerald-500" />
        <Kpi icon={Cog} label="Máquinas activas" value={fmtInt(machines.filter(m => m.order_count > 0).length)} sub={`de ${machines.length}`} accent="text-violet-500" />
        <Kpi icon={AlertTriangle} label="Saturadas" value={fmtInt(machines.filter(m => m.load_status === "red").length)} sub="> 7 días de carga" accent="text-red-500" />
      </div>

      <Panel title="Producción por máquina (periodo)" icon={Activity}>
        <div className="h-72">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={byMachine} margin={{ top: 8, right: 8, left: -12, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke={chart.grid} vertical={false} />
              <XAxis dataKey="label" tick={{ fontSize: 11, fill: chart.axis }} axisLine={false} tickLine={false} />
              <YAxis tick={{ fontSize: 11, fill: chart.axis }} axisLine={false} tickLine={false} width={44} />
              <Tooltip contentStyle={chart.tooltipStyle} cursor={{ fill: chart.grid, opacity: 0.4 }} />
              <Bar dataKey="produced" name="Producido" radius={[4, 4, 0, 0]}>
                {byMachine.map((_, i) => <Cell key={i} fill={PALETTE[i % PALETTE.length]} />)}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      </Panel>

      <Panel title="Carga por máquina" icon={Cog}
        right={<span className="text-xs text-muted-foreground">restante · días estimados</span>}>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {machines.map(m => {
            const tone = LOAD_TONE[m.load_status] || LOAD_TONE.idle;
            const pct = Math.min(100, Math.round((m.estimated_days / 10) * 100));
            return (
              <div key={m.machine} className="rounded-lg border border-border p-3">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-semibold">{m.machine.replace("MAQUINA", "Máquina ")}</span>
                  <span className={`px-2 py-0.5 rounded-md border text-[10px] font-medium ${tone.chip}`}>{tone.label}</span>
                </div>
                <div className="mt-2 flex items-end justify-between">
                  <div>
                    <div className="text-2xl font-semibold tabular-nums leading-none">{fmtInt(m.remaining_pieces)}</div>
                    <div className="text-[10px] uppercase tracking-wide text-muted-foreground mt-0.5">u restantes</div>
                  </div>
                  <div className="text-right">
                    <div className="text-sm font-semibold tabular-nums">{m.estimated_days || 0} d</div>
                    <div className="text-[10px] text-muted-foreground">{m.order_count} orden(es)</div>
                  </div>
                </div>
                <div className="mt-2 h-1.5 rounded-full bg-muted overflow-hidden">
                  <div className={`h-full rounded-full ${tone.bar}`} style={{ width: `${pct}%` }} />
                </div>
                <div className="mt-1 text-[10px] text-muted-foreground">
                  Prom. {m.avg_daily_production || 0} u/día · máx {fmtInt(m.max_daily_production)}
                </div>
              </div>
            );
          })}
        </div>
      </Panel>
    </div>
  );
}

function EmpaqueTab({ a, boards }) {
  const statuses = a?.by_production_status || [];
  const empaque = statuses.filter(s => EMPAQUE_STATUSES.includes(s.status));
  const totalEmpaqueU = empaque.reduce((s, x) => s + (x.quantity || 0), 0);
  const totalEmpaqueO = empaque.reduce((s, x) => s + (x.count || 0), 0);
  const completos = boards["COMPLETOS"] || 0;
  const qc = boards["CONTROL DE CALIDAD"] || 0;
  const rows = statuses.map(s => ({ label: s.status, value: s.quantity }));

  return (
    <div className="space-y-5">
      <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 px-4 py-3 flex items-start gap-2 text-xs text-amber-700 dark:text-amber-300">
        <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
        <span>El sistema aún no captura piezas empacadas por hora; el empaque se mide por <b>estado de la orden</b> y por el WIP de cada etapa. Si más adelante se registran conteos de empaque, aquí entra la serie por hora.</span>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <Kpi icon={Package} label="En empaque" value={fmtInt(totalEmpaqueU)} sub={`${fmtInt(totalEmpaqueO)} órdenes`} accent="text-blue-500" />
        <Kpi icon={CheckCircle2} label="Completos" value={fmtInt(completos)} sub="órdenes en COMPLETOS" accent="text-emerald-500" />
        <Kpi icon={ClipboardList} label="En control de calidad" value={fmtInt(qc)} sub="órdenes en QC" accent="text-violet-500" />
        <Kpi icon={Boxes} label="Etapas con WIP" value={fmtInt(Object.values(boards).filter(v => v > 0).length)} sub="boards con órdenes" accent="text-amber-500" />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
        <Panel title="Órdenes por etapa de empaque / salida" icon={Package}>
          <div className="space-y-2">
            {empaque.length === 0 && <div className="text-sm text-muted-foreground">Sin órdenes en etapas de empaque.</div>}
            {empaque.map((s, i) => (
              <div key={s.status} className="flex items-center justify-between rounded-md border border-border px-3 py-2">
                <span className="text-sm font-medium">{s.status}</span>
                <div className="text-right">
                  <div className="text-sm font-semibold tabular-nums">{fmtInt(s.quantity)} u</div>
                  <div className="text-[10px] text-muted-foreground">{fmtInt(s.count)} órdenes</div>
                </div>
              </div>
            ))}
          </div>
        </Panel>

        <Panel title="Distribución por estado de producción (unidades)" icon={Activity}>
          <RankBars rows={rows.slice(0, 8)} />
        </Panel>
      </div>
    </div>
  );
}

function OrdenesTab({ a }) {
  const pos = (a?.by_po || []).slice().sort((x, y) => (y.produced) - (x.produced)).slice(0, 20);
  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <Kpi icon={ClipboardList} label="Órdenes con avance" value={fmtInt((a?.by_po || []).length)} sub="en el periodo" accent="text-blue-500" />
        <Kpi icon={TrendingUp} label="Producido" value={fmtInt(a?.total_produced)} accent="text-emerald-500" />
        <Kpi icon={Target} label="Meta" value={fmtInt(a?.total_target)} accent="text-violet-500" />
        <Kpi icon={Zap} label="Eficiencia" value={`${a?.efficiency ?? 0}%`} accent="text-amber-500" />
      </div>

      <Panel title="Avance por orden (top 20 del periodo)" icon={ClipboardList}>
        <div className="space-y-3">
          {pos.length === 0 && <div className="text-sm text-muted-foreground">Sin producción registrada en el periodo.</div>}
          {pos.map((p, i) => (
            <ProgressRow key={(p.order_number || "?") + i} label={`#${p.order_number || "?"}`} produced={p.produced} target={p.target} />
          ))}
        </div>
      </Panel>
    </div>
  );
}

function OperadoresTab({ a }) {
  const ops = (a?.by_operator || [])
    .filter(o => (o._id || o.operator) && (o._id || o.operator) !== "?")
    .map(o => ({ label: o._id || o.operator, value: o.produced, count: o.count }))
    .slice(0, 15);
  const clients = (a?.by_client || [])
    .filter(c => (c._id || c.client) && (c._id || c.client) !== "Sin cliente")
    .map(c => ({ label: c._id || c.client, value: c.produced }))
    .slice(0, 12);

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
      <Panel title="Producción por operador (top 15)" icon={Users}>
        <RankBars rows={ops} colorAt={() => "#3b82f6"} />
      </Panel>
      <Panel title="Producción por cliente (top 12)" icon={Boxes}>
        <RankBars rows={clients} colorAt={(i) => PALETTE[i % PALETTE.length]} />
      </Panel>
    </div>
  );
}
