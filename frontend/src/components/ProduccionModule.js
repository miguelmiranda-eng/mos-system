import { useState, useEffect, useCallback, useMemo, useRef, cloneElement } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import {
  ArrowLeft, RefreshCw, Loader2, Gauge, Cog, Package, ClipboardList, Users,
  TrendingUp, Target, Clock, Boxes, Activity, Zap, CheckCircle2, AlertTriangle, Tv, X,
} from "lucide-react";
import {
  AreaChart, Area, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Cell,
} from "recharts";
import { API } from "../lib/constants";
import { useTheme } from "../contexts/ThemeContext";

// ── Producción — tablero muy visual de la nave. Toda la data sale de endpoints
// que ya existen: /production-analytics (por hora/turno/máquina/PO, meta y
// eficiencia), /capacity-plan (carga por máquina) y /orders/board-counts (WIP
// por etapa). Se refresca solo cada 60s. Estilo token-based: se adapta a claro/
// oscuro sin ramas manuales salvo en los ejes/tooltip de recharts.
//
// Layout fit-to-screen (pedido 2026-08-12): la página mide exactamente la
// altura del viewport y cada pestaña reparte ese espacio con flex/grid — las
// gráficas se estiran/encogen (ResponsiveContainer) en vez de tener altura
// fija, para ver TODO el tablero sin scroll. En pantallas muy chicas cada
// pestaña conserva un min-h y <main> hace scroll como salvavidas.

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
  { id: "horas", label: "Hora x Hora", icon: Clock },
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
  const [tvMode, setTvMode] = useState(false);
  const [tvViewport, setTvViewport] = useState(null); // {w, h} en px físicos

  // Viewport real en modo TV: se mide en px (innerWidth/innerHeight) y se
  // divide entre la escala para que el layout fit-to-screen siga midiendo
  // exactamente una pantalla ya escalado.
  useEffect(() => {
    if (!tvMode) return;
    const measure = () => setTvViewport({ w: window.innerWidth, h: window.innerHeight });
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [tvMode]);

  // Escala del modo TV con fit GARANTIZADO (pedido 2026-08-14): son pantallas
  // informativas sin teclado ni mouse — el scroll no es opción. La escala fija
  // de 1.3 asumía ~1080px de alto real, pero una TV 1080p con Windows al 150%
  // reporta 720px CSS y el contenido ya no cabía. Ahora se calcula para que la
  // pestaña más alta (min-h 540 + padding del main) siempre quepa: en
  // pantallas grandes topa en 1.3 (igual que antes, para leerse a distancia)
  // y en pantallas cortas baja lo justo — la altura lógica nunca queda por
  // debajo de TV_DESIGN_H, así que los min-h jamás disparan scroll.
  //
  // Se usa transform:scale y NO zoom: con zoom, el Chrome actual reporta
  // getBoundingClientRect/ResizeObserver en px ya escalados y el
  // ResponsiveContainer de recharts dibuja el SVG un 30% más ancho que su
  // contenedor (verificado: contenedor 974px de layout, gBCR 1209). El
  // transform no toca el layout, así que recharts mide px reales.
  const TV_DESIGN_H = 580;
  const TV_MAX_ZOOM = 1.3;
  const tvZoom = tvViewport ? Math.min(TV_MAX_ZOOM, tvViewport.h / TV_DESIGN_H) : TV_MAX_ZOOM;

  // ── Modo TV: fullscreen + escala grande + rotación automática de pestañas.
  const enterTv = async () => {
    setTvMode(true);
    try { await document.documentElement.requestFullscreen?.(); } catch { /* iOS/permiso */ }
  };
  const exitTv = useCallback(async () => {
    setTvMode(false);
    try { if (document.fullscreenElement) await document.exitFullscreen(); } catch { /* noop */ }
  }, []);

  // Esc (o salir de fullscreen por cualquier vía) apaga el modo TV.
  useEffect(() => {
    const onFs = () => { if (!document.fullscreenElement) setTvMode(false); };
    document.addEventListener("fullscreenchange", onFs);
    return () => document.removeEventListener("fullscreenchange", onFs);
  }, []);

  // Fallback: si requestFullscreen falló (permiso/navegador), Esc sigue
  // sacando del modo TV aunque no haya fullscreen que abandonar.
  useEffect(() => {
    if (!tvMode) return;
    const onKey = (e) => { if (e.key === "Escape") exitTv(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [tvMode, exitTv]);

  // Sin rotación automática (pedido del usuario 2026-08-11): la pestaña se
  // cambia manualmente desde los iconos del overlay flotante del modo TV.

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
    // Modo TV: el wrapper exterior recorta al viewport; el interior se
    // dimensiona en px lógicos (viewport/escala) y se escala con transform
    // para leerse a distancia — visualmente llena la pantalla EXACTA, sin
    // scroll. En modo normal el interior simplemente llena el wrapper.
    <div className="h-screen w-full overflow-hidden bg-background text-foreground">
    <div
      className="h-full flex flex-col overflow-hidden bg-background text-foreground"
      style={tvMode && tvViewport ? {
        width: Math.round(tvViewport.w / tvZoom),
        height: Math.round(tvViewport.h / tvZoom),
        transform: `scale(${tvZoom})`,
        transformOrigin: "top left",
      } : undefined}
    >
      {/* Header — se oculta COMPLETO en modo TV: en el televisor solo vive el
          dashboard; la orientación y la salida las da el overlay flotante. */}
      {!tvMode && (
      <header className="flex-none z-30 bg-background/95 border-b border-border">
        <div className="max-w-7xl mx-auto px-4 md:px-6 py-2 flex items-center gap-3 flex-wrap">
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
            <button onClick={tvMode ? exitTv : enterTv}
              title={tvMode ? "Salir del modo TV (Esc)" : "Modo TV — pantalla completa, rotación de pestañas cada 20s"}
              data-testid="produccion-tv-toggle"
              className={`p-2 rounded-md transition-colors ${tvMode ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground hover:bg-muted"}`}>
              <Tv className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Tabs */}
        <div className="max-w-7xl mx-auto px-2 md:px-6 flex gap-1 overflow-x-auto">
          {TABS.map(t => {
            const Icon = t.icon;
            return (
              <button key={t.id} onClick={() => setTab(t.id)}
                className={`flex items-center gap-2 px-3 md:px-4 py-2 text-sm font-medium border-b-2 whitespace-nowrap transition-colors ${tab === t.id ? "border-primary text-primary" : "border-transparent text-muted-foreground hover:text-foreground"}`}>
                <Icon className="w-4 h-4" /> {t.label}
              </button>
            );
          })}
        </div>
      </header>
      )}

      {/* Overlay del modo TV: navegación manual de pestañas (iconos) +
          etiqueta de la actual + salida. Esc también sale. */}
      {tvMode && (
        <div className="fixed top-3 right-3 z-50 flex items-center gap-1 px-2 py-1.5 rounded-lg bg-background/85 border border-border shadow-sm">
          {TABS.map(t => {
            const Icon = t.icon;
            return (
              <button key={t.id} onClick={() => setTab(t.id)} title={t.label}
                className={`p-1.5 rounded-md transition-colors ${tab === t.id ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground hover:bg-muted"}`}>
                <Icon className="w-4 h-4" />
              </button>
            );
          })}
          <span className="mx-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground whitespace-nowrap">
            {TABS.find(t => t.id === tab)?.label}
          </span>
          <button onClick={exitTv} title="Salir del modo TV (Esc)"
            className="p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted transition-colors">
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* overflow-auto = salvavidas en modo normal: en laptops chicas los
          min-h de cada pestaña activan scroll en vez de aplastar las gráficas.
          En modo TV el fit es garantizado por el zoom calculado y se recorta
          (overflow-hidden): una pantalla informativa jamás debe scrollear.
          El key con el zoom re-monta el contenido al entrar/salir del modo TV:
          el ResponsiveContainer de recharts no se re-mide bajo zoom (se queda
          con el ancho previo y desbordaba en pantallas cortas); al re-montar
          mide ya con la escala final. */}
      <main
        key={tvMode ? `tv-${tvZoom.toFixed(3)}` : "normal"}
        className={`flex-1 min-h-0 w-full max-w-7xl mx-auto p-3 md:p-4 ${tvMode ? "overflow-hidden" : "overflow-auto"}`}>
        {loading && !analytics ? (
          <div className="h-full flex items-center justify-center"><Loader2 className="w-8 h-8 animate-spin text-primary" /></div>
        ) : (
          <>
            {tab === "general" && <GeneralTab a={analytics} trend={trend} period={period} chart={chartProps} />}
            {tab === "maquinas" && <MaquinasTab a={analytics} cap={capacity} chart={chartProps} />}
            {tab === "horas" && <HoraPorHoraTab a={analytics} period={period} chart={chartProps} />}
            {tab === "empaque" && <EmpaqueTab a={analytics} boards={boards} />}
            {tab === "ordenes" && <OrdenesTab a={analytics} />}
            {tab === "operadores" && <OperadoresTab a={analytics} />}
          </>
        )}
      </main>
    </div>
    </div>
  );
}

/* ── Primitivas visuales ─────────────────────────────────────────────────── */

// Reemplazo de ResponsiveContainer: recharts mide con getBoundingClientRect,
// que devuelve px VISUALES — bajo el transform:scale del modo TV dibujaba el
// SVG ~30% más grande que su contenedor y desbordaba la pantalla. offsetWidth/
// offsetHeight son px de LAYOUT (inmunes a zoom y transform), así que aquí se
// mide el hueco real y se le pasa el tamaño exacto a la gráfica.
function FitChart({ children }) {
  const ref = useRef(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  useEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const update = () => {
      const w = el.offsetWidth, h = el.offsetHeight;
      setSize(prev => (prev.w === w && prev.h === h ? prev : { w, h }));
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return (
    <div ref={ref} className="w-full h-full overflow-hidden">
      {size.w > 0 && size.h > 0 ? cloneElement(children, { width: size.w, height: size.h }) : null}
    </div>
  );
}

// Hermano de FitChart para contenido arbitrario (la matriz hora×máquina, las
// cuadrículas de tarjetas): mide el tamaño NATURAL del contenido con
// offsetWidth/offsetHeight (px de layout, inmunes a transforms) y el hueco del
// panel, y lo escala para que quepa COMPLETO, centrado. En pantalla informativa
// el scroll interno tampoco es opción: lo que no cabe se encoge, no se corta.
function FitBox({ children, maxScale = 1.25 }) {
  const outerRef = useRef(null);
  const innerRef = useRef(null);
  const [fit, setFit] = useState({ scale: 1, dx: 0, dy: 0 });
  useEffect(() => {
    const outer = outerRef.current, inner = innerRef.current;
    if (!outer || !inner) return undefined;
    const update = () => {
      const aw = outer.clientWidth, ah = outer.clientHeight;
      const nw = inner.offsetWidth, nh = inner.offsetHeight;
      if (!aw || !ah || !nw || !nh) return;
      const scale = Math.min(maxScale, aw / nw, ah / nh);
      const dx = Math.max(0, Math.round((aw - nw * scale) / 2));
      const dy = Math.max(0, Math.round((ah - nh * scale) / 2));
      setFit(prev => (prev.scale === scale && prev.dx === dx && prev.dy === dy ? prev : { scale, dx, dy }));
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(outer);
    ro.observe(inner);
    return () => ro.disconnect();
  }, [maxScale]);
  return (
    <div ref={outerRef} className="relative w-full h-full overflow-hidden">
      <div
        ref={innerRef}
        className="absolute top-0 left-0 w-max"
        style={{ transform: `translate(${fit.dx}px, ${fit.dy}px) scale(${fit.scale})`, transformOrigin: "top left" }}
      >
        {children}
      </div>
    </div>
  );
}

function Kpi({ icon: Icon, label, value, sub, accent = "text-primary" }) {
  return (
    <div className="bg-card border border-border rounded-lg px-3 py-2.5">
      <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
        <Icon className={`w-4 h-4 ${accent}`} /> {label}
      </div>
      <div className="mt-1.5 text-xl md:text-2xl font-semibold tabular-nums leading-none">{value}</div>
      {sub && <div className="mt-1 text-[11px] text-muted-foreground truncate">{sub}</div>}
    </div>
  );
}

// Panel flexible: como flex-col con min-h-0 puede estirarse (className="flex-1")
// y su cuerpo hace scroll interno (bodyClassName="overflow-auto") sin empujar
// la página — clave del layout sin scroll global.
function Panel({ title, icon: Icon, right, children, className = "", bodyClassName = "" }) {
  return (
    <div className={`bg-card border border-border rounded-lg flex flex-col min-h-0 ${className}`}>
      <div className="flex-none px-4 py-2 border-b border-border flex items-center gap-2">
        {Icon && <Icon className="w-4 h-4 text-muted-foreground" />}
        <span className="text-sm font-semibold">{title}</span>
        {right && <div className="ml-auto">{right}</div>}
      </div>
      <div className={`flex-1 min-h-0 p-3 ${bodyClassName}`}>{children}</div>
    </div>
  );
}

// Ranking horizontal sin recharts: etiqueta + barra proporcional + valor.
function RankBars({ rows, colorAt }) {
  const max = Math.max(1, ...rows.map(r => r.value));
  return (
    <div className="space-y-2">
      {rows.length === 0 && <div className="text-sm text-muted-foreground py-2">Sin datos en el periodo.</div>}
      {rows.map((r, i) => (
        <div key={r.label + i} className="flex items-center gap-3">
          <div className="w-28 shrink-0 text-xs font-medium truncate" title={r.label}>{r.label}</div>
          <div className="flex-1 h-5 rounded-md bg-muted/50 overflow-hidden">
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
      <div className="relative w-28 h-28">
        <svg viewBox="0 0 120 120" className="w-28 h-28 -rotate-90">
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
      {sub && <div className="mt-1.5 text-xs text-muted-foreground text-center">{sub}</div>}
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
    <div className="h-full min-h-[520px] flex flex-col gap-3">
      {/* KPIs */}
      <div className="flex-none grid grid-cols-2 lg:grid-cols-4 gap-3">
        <Kpi icon={TrendingUp} label="Producido" value={fmtInt(a.total_produced)} sub={`${fmtInt(a.total_logs)} registros`} accent="text-emerald-500" />
        <Kpi icon={Target} label="Meta (órdenes)" value={fmtInt(a.total_target)} sub={`Restan ${fmtInt(a.total_remaining)}`} accent="text-blue-500" />
        <Kpi icon={Zap} label="Eficiencia" value={`${a.efficiency ?? 0}%`} sub="producido vs meta" accent="text-violet-500" />
        <Kpi icon={Clock} label="Setup prom." value={`${fmtInt(a.avg_setup)} min`} sub="por registro" accent="text-amber-500" />
      </div>

      <div className="flex-1 min-h-0 grid grid-cols-1 xl:grid-cols-3 gap-3">
        <div className="xl:col-span-2 min-h-0 flex flex-col gap-3">
          {/* Trend — la gráfica absorbe el alto sobrante de la pantalla */}
          <Panel className="flex-1" title={period === "today" ? "Producción por hora" : "Producción por día"} icon={Activity}>
            <div className="h-full min-h-[180px]">
              <FitChart>
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
              </FitChart>
            </div>
          </Panel>

          {/* Por turno: pocos renglones (T1/T2), vive bajo el trend */}
          <Panel className="flex-none" title="Producción por turno" icon={Clock}>
            <RankBars rows={shifts} />
          </Panel>
        </div>

        {/* Eficiencia + meta */}
        <Panel title="Avance vs meta" icon={Target} bodyClassName="overflow-auto">
          <Ring pct={a.efficiency} label="Eficiencia" sub={`${fmtInt(a.total_produced)} de ${fmtInt(a.total_target)} u`} />
          <div className="mt-3 space-y-3">
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
    </div>
  );
}

function MaquinasTab({ a, cap, chart }) {
  const byMachine = (a?.by_machine || [])
    .filter(m => (m._id || m.machine) && (m._id || m.machine) !== "?")
    .map(m => ({ label: (m._id || m.machine).replace("MAQUINA", "M"), produced: m.produced, count: m.count }))
    .sort((x, y) => y.produced - x.produced);
  const machines = cap?.machines || [];

  // Tarjeta de carga de una máquina — se renderiza igual en la variante
  // FitBox (≥lg, cuadrícula 7×N escalada a caber) y en la scrolleable (<lg).
  const cargaCard = (m) => {
    const tone = LOAD_TONE[m.load_status] || LOAD_TONE.idle;
    const pct = Math.min(100, Math.round((m.estimated_days / 10) * 100));
    return (
      <div key={m.machine} className="rounded-lg border border-border p-2 bg-card">
        <div className="flex items-center justify-between gap-1">
          <span className="text-xs font-semibold truncate">{m.machine.replace("MAQUINA", "M")}</span>
          <span className={`px-1.5 py-0.5 rounded border text-[9px] font-medium whitespace-nowrap ${tone.chip}`}>{tone.label}</span>
        </div>
        <div className="mt-1.5 flex items-end justify-between">
          <div>
            <div className="text-lg font-semibold tabular-nums leading-none">{fmtInt(m.remaining_pieces)}</div>
            <div className="text-[9px] uppercase tracking-wide text-muted-foreground mt-0.5">u restantes</div>
          </div>
          <div className="text-right">
            <div className="text-xs font-semibold tabular-nums">{m.estimated_days || 0} d</div>
            <div className="text-[9px] text-muted-foreground">{m.order_count} ord.</div>
          </div>
        </div>
        <div className="mt-1.5 h-1 rounded-full bg-muted overflow-hidden">
          <div className={`h-full rounded-full ${tone.bar}`} style={{ width: `${pct}%` }} />
        </div>
        <div className="mt-0.5 text-[9px] text-muted-foreground truncate">
          Prom. {m.avg_daily_production || 0} u/día · máx {fmtInt(m.max_daily_production)}
        </div>
      </div>
    );
  };

  return (
    <div className="h-full min-h-[540px] flex flex-col gap-3">
      <div className="flex-none grid grid-cols-2 lg:grid-cols-4 gap-3">
        <Kpi icon={Boxes} label="En producción" value={fmtInt(cap?.in_production)} sub="unidades en máquinas" accent="text-blue-500" />
        <Kpi icon={CheckCircle2} label="Completado" value={fmtInt(cap?.total_completed)} sub="board COMPLETOS" accent="text-emerald-500" />
        <Kpi icon={Cog} label="Máquinas activas" value={fmtInt(machines.filter(m => m.order_count > 0).length)} sub={`de ${machines.length}`} accent="text-violet-500" />
        <Kpi icon={AlertTriangle} label="Saturadas" value={fmtInt(machines.filter(m => m.load_status === "red").length)} sub="> 7 días de carga" accent="text-red-500" />
      </div>

      <Panel className="flex-1" title="Producción por máquina (periodo)" icon={Activity}>
        <div className="h-full min-h-[120px]">
          <FitChart>
            <BarChart data={byMachine} margin={{ top: 8, right: 8, left: -12, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke={chart.grid} vertical={false} />
              <XAxis dataKey="label" tick={{ fontSize: 11, fill: chart.axis }} axisLine={false} tickLine={false} />
              <YAxis tick={{ fontSize: 11, fill: chart.axis }} axisLine={false} tickLine={false} width={44} />
              <Tooltip contentStyle={chart.tooltipStyle} cursor={{ fill: chart.grid, opacity: 0.4 }} />
              <Bar dataKey="produced" name="Producido" radius={[4, 4, 0, 0]}>
                {byMachine.map((_, i) => <Cell key={i} fill={PALETTE[i % PALETTE.length]} />)}
              </Bar>
            </BarChart>
          </FitChart>
        </div>
      </Panel>

      {/* Tarjetas de carga: en ≥lg la cuadrícula fija de 7 columnas vive en un
          FitBox que la escala a caber COMPLETA (en pantalla informativa el
          scroll interno tampoco es opción — con Windows al 150% el breakpoint
          2xl nunca aplicaba y el panel recortaba una fila entera). En <lg se
          conserva la cuadrícula scrolleable de siempre. */}
      <Panel className="flex-none h-[38%] min-h-[150px]" title="Carga por máquina" icon={Cog}
        right={<span className="text-xs text-muted-foreground">restante · días estimados</span>}
        bodyClassName="p-2">
        <div className="hidden lg:block h-full">
          <FitBox>
            <div className="grid gap-2" style={{ gridTemplateColumns: "repeat(7, 150px)" }}>
              {machines.map(cargaCard)}
            </div>
          </FitBox>
        </div>
        <div className="lg:hidden h-full overflow-auto">
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
            {machines.map(cargaCard)}
          </div>
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
    <div className="h-full min-h-[480px] flex flex-col gap-3">
      <div className="flex-none rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2 flex items-start gap-2 text-[11px] text-amber-700 dark:text-amber-300">
        <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
        <span>El sistema aún no captura piezas empacadas por hora; el empaque se mide por <b>estado de la orden</b> y por el WIP de cada etapa. Si más adelante se registran conteos de empaque, aquí entra la serie por hora.</span>
      </div>

      <div className="flex-none grid grid-cols-2 lg:grid-cols-4 gap-3">
        <Kpi icon={Package} label="En empaque" value={fmtInt(totalEmpaqueU)} sub={`${fmtInt(totalEmpaqueO)} órdenes`} accent="text-blue-500" />
        <Kpi icon={CheckCircle2} label="Completos" value={fmtInt(completos)} sub="órdenes en COMPLETOS" accent="text-emerald-500" />
        <Kpi icon={ClipboardList} label="En control de calidad" value={fmtInt(qc)} sub="órdenes en QC" accent="text-violet-500" />
        <Kpi icon={Boxes} label="Etapas con WIP" value={fmtInt(Object.values(boards).filter(v => v > 0).length)} sub="boards con órdenes" accent="text-amber-500" />
      </div>

      <div className="flex-1 min-h-0 grid grid-cols-1 lg:grid-cols-2 gap-3">
        <Panel title="Órdenes por etapa de empaque / salida" icon={Package} bodyClassName="overflow-auto">
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

        <Panel title="Distribución por estado de producción (unidades)" icon={Activity} bodyClassName="overflow-auto">
          <RankBars rows={rows.slice(0, 8)} />
        </Panel>
      </div>
    </div>
  );
}

function OrdenesTab({ a }) {
  const pos = (a?.by_po || []).slice().sort((x, y) => (y.produced) - (x.produced)).slice(0, 20);
  return (
    <div className="h-full min-h-[440px] flex flex-col gap-3">
      <div className="flex-none grid grid-cols-2 lg:grid-cols-4 gap-3">
        <Kpi icon={ClipboardList} label="Órdenes con avance" value={fmtInt((a?.by_po || []).length)} sub="en el periodo" accent="text-blue-500" />
        <Kpi icon={TrendingUp} label="Producido" value={fmtInt(a?.total_produced)} accent="text-emerald-500" />
        <Kpi icon={Target} label="Meta" value={fmtInt(a?.total_target)} accent="text-violet-500" />
        <Kpi icon={Zap} label="Eficiencia" value={`${a?.efficiency ?? 0}%`} accent="text-amber-500" />
      </div>

      {/* Top 20 en dos columnas (≥lg): 10 renglones por lado caben completos
          en pantalla; el overflow-auto queda de respaldo. */}
      <Panel className="flex-1" title="Avance por orden (top 20 del periodo)" icon={ClipboardList} bodyClassName="overflow-auto">
        {pos.length === 0 && <div className="text-sm text-muted-foreground">Sin producción registrada en el periodo.</div>}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-x-8 gap-y-2.5">
          {pos.map((p, i) => (
            <ProgressRow key={(p.order_number || "?") + i} label={`#${p.order_number || "?"}`} produced={p.produced} target={p.target} />
          ))}
        </div>
      </Panel>
    </div>
  );
}

// Matriz hora × máquina ordenada POR TURNO: T1 = 7:00→19:00 y T2 = 19:00→7:00
// (las horas 00-06 son la madrugada — el cierre del T2 que arrancó la noche
// anterior — y van al FINAL, no al inicio). Las horas ya vienen convertidas a
// America/Tijuana desde el backend; se verificó contra los timestamps crudos
// (UTC con offset) y contra el campo `shift` de cada captura — no hay desfase,
// lo que parecía corrido era el turno nocturno ordenado por hora numérica.
const T1_HOURS = [7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18];
const T2_HOURS = [19, 20, 21, 22, 23, 0, 1, 2, 3, 4, 5, 6];
const isT1 = (h) => h >= 7 && h <= 18;

function HoraPorHoraTab({ a, period, chart }) {
  const [modo, setModo] = useState("grafica");
  const matrix = useMemo(() => {
    const rows = (a?.by_machine_hour || []).filter(r => r.machine && r.machine !== "?");
    const cells = {}, rowTotals = {}, colTotals = {}, t1Totals = {}, t2Totals = {};
    let grandTotal = 0, maxCell = 0, t1Grand = 0, t2Grand = 0;
    const machineSet = new Set();
    rows.forEach(r => {
      machineSet.add(r.machine);
      const k = `${r.machine}|${r.hour}`;
      cells[k] = (cells[k] || 0) + r.produced;
      rowTotals[r.machine] = (rowTotals[r.machine] || 0) + r.produced;
      colTotals[r.hour] = (colTotals[r.hour] || 0) + r.produced;
      if (isT1(r.hour)) { t1Totals[r.machine] = (t1Totals[r.machine] || 0) + r.produced; t1Grand += r.produced; }
      else { t2Totals[r.machine] = (t2Totals[r.machine] || 0) + r.produced; t2Grand += r.produced; }
      grandTotal += r.produced;
      maxCell = Math.max(maxCell, cells[k]);
    });
    const machines = [...machineSet].sort((x, y) =>
      (parseInt(x.replace(/\D/g, ""), 10) || 0) - (parseInt(y.replace(/\D/g, ""), 10) || 0));
    return { machines, cells, rowTotals, colTotals, t1Totals, t2Totals, t1Grand, t2Grand, grandTotal, maxCell };
  }, [a]);

  const { machines, cells, rowTotals, colTotals, t1Totals, t2Totals, t1Grand, t2Grand, grandTotal, maxCell } = matrix;
  const multiDay = period === "week" || period === "month";
  const hh = (h) => `${String(h).padStart(2, "0")}h`;
  const allHours = [...T1_HOURS, ...T2_HOURS];
  const bestHour = allHours.reduce((best, h) => (colTotals[h] || 0) > (colTotals[best] || 0) ? h : best, allHours[0]);
  // Serie global por hora en orden de turno, para la gráfica de ritmo.
  const hourSeries = allHours.map(h => ({ label: hh(h), produced: colTotals[h] || 0, t1: isT1(h) }));

  if (machines.length === 0) {
    return <div className="text-sm text-muted-foreground py-16 text-center">Sin capturas de producción en el periodo.</div>;
  }

  // Tarjeta por máquina (total, split T1/T2 y sparkline de 24h) — misma en la
  // variante FitBox (≥lg) y en la scrolleable (<lg).
  const horaCard = (m) => {
    const mMax = Math.max(1, ...allHours.map(h => cells[`${m}|${h}`] || 0));
    return (
      <div key={m} className="rounded-lg border border-border bg-card p-2">
        <div className="flex items-baseline justify-between">
          <span className="text-xs font-semibold">{m.replace("MAQUINA", "M")}</span>
          <span className="text-base font-semibold tabular-nums">{fmtInt(rowTotals[m])}</span>
        </div>
        <div className="mt-0.5 flex items-center gap-2.5 text-[9px] text-muted-foreground">
          <span><span className="inline-block w-2 h-2 rounded-sm bg-blue-500 mr-1 align-middle" />T1 {fmtInt(t1Totals[m] || 0)}</span>
          <span><span className="inline-block w-2 h-2 rounded-sm bg-violet-500 mr-1 align-middle" />T2 {fmtInt(t2Totals[m] || 0)}</span>
        </div>
        <div className="mt-1.5 flex items-end gap-[2px] h-10">
          {allHours.map(h => {
            const v = cells[`${m}|${h}`] || 0;
            return (
              <div key={h} title={`${hh(h)} · ${fmtInt(v)} pz`}
                className={`flex-1 rounded-sm ${v ? (isT1(h) ? "bg-blue-500" : "bg-violet-500") : "bg-muted"}`}
                style={{ height: v ? `${Math.max(8, Math.round((v / mMax) * 100))}%` : "3px" }} />
            );
          })}
        </div>
        <div className="mt-0.5 flex justify-between text-[9px] text-muted-foreground font-mono">
          <span>07h</span><span>19h</span><span>06h</span>
        </div>
      </div>
    );
  };

  return (
    <div className="h-full min-h-[540px] flex flex-col gap-3">
      <div className="flex-none grid grid-cols-2 lg:grid-cols-4 gap-3">
        <Kpi icon={TrendingUp} label="Producido" value={fmtInt(grandTotal)} sub="en el periodo" accent="text-emerald-500" />
        <Kpi icon={Clock} label="Turno 1 · 7am–7pm" value={fmtInt(t1Grand)} sub={grandTotal ? `${Math.round(t1Grand / grandTotal * 100)}% del total` : ""} accent="text-blue-500" />
        <Kpi icon={Clock} label="Turno 2 · 7pm–7am" value={fmtInt(t2Grand)} sub={grandTotal ? `${Math.round(t2Grand / grandTotal * 100)}% del total` : ""} accent="text-violet-500" />
        <Kpi icon={Zap} label="Mejor hora" value={colTotals[bestHour] ? hh(bestHour) : "—"} sub={colTotals[bestHour] ? `${fmtInt(colTotals[bestHour])} pz` : ""} accent="text-amber-500" />
      </div>

      {/* Switch Gráfica / Tabla — la tabla detallada no se pierde, solo deja
          de ser la cara principal. */}
      <div className="flex-none flex items-center justify-between flex-wrap gap-2">
        <span className="text-xs text-muted-foreground">
          {multiDay ? "Suma por hora del día en el periodo · hora local Tijuana" : "Hora local Tijuana · 00–06h = madrugada del T2"}
        </span>
        <div className="flex items-center gap-1 p-1 rounded-lg bg-muted/60 border border-border">
          <button onClick={() => setModo("grafica")}
            className={`px-3 py-1 rounded-md text-xs font-medium transition-colors ${modo === "grafica" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"}`}>
            Gráfica
          </button>
          <button onClick={() => setModo("tabla")}
            className={`px-3 py-1 rounded-md text-xs font-medium transition-colors ${modo === "tabla" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"}`}>
            Tabla
          </button>
        </div>
      </div>

      {modo === "grafica" && (
        <>
          <Panel className="flex-1" title="Ritmo del día — todas las máquinas" icon={Activity}
            right={
              <span className="flex items-center gap-3 text-[10px] text-muted-foreground">
                <span><span className="inline-block w-2.5 h-2.5 rounded-sm bg-blue-500 mr-1 align-middle" />T1 · 7am–7pm</span>
                <span><span className="inline-block w-2.5 h-2.5 rounded-sm bg-violet-500 mr-1 align-middle" />T2 · 7pm–7am</span>
              </span>
            }>
            <div className="h-full min-h-[120px]">
              <FitChart>
                <BarChart data={hourSeries} margin={{ top: 8, right: 8, left: -12, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke={chart.grid} vertical={false} />
                  <XAxis dataKey="label" tick={{ fontSize: 10, fill: chart.axis }} axisLine={false} tickLine={false} />
                  <YAxis tick={{ fontSize: 11, fill: chart.axis }} axisLine={false} tickLine={false} width={44} />
                  <Tooltip contentStyle={chart.tooltipStyle} cursor={{ fill: chart.grid, opacity: 0.4 }} formatter={(v) => [fmtInt(v), "Piezas"]} />
                  <Bar dataKey="produced" name="Piezas" radius={[3, 3, 0, 0]}>
                    {hourSeries.map((e, i) => <Cell key={i} fill={e.t1 ? "#3b82f6" : "#8b5cf6"} />)}
                  </Bar>
                </BarChart>
              </FitChart>
            </div>
          </Panel>

          {/* Tarjetas por máquina: total, split T1/T2 y las 24 horas como
              mini-barras (altura relativa al pico de ESA máquina — muestra su
              patrón; el volumen lo dice el número). En ≥lg la cuadrícula 7×N
              va en FitBox y se escala a caber completa; en <lg scrollea. */}
          <div className="flex-none h-[36%] min-h-[140px]">
            <div className="hidden lg:block h-full">
              <FitBox>
                <div className="grid gap-2" style={{ gridTemplateColumns: "repeat(7, 150px)" }}>
                  {machines.map(horaCard)}
                </div>
              </FitBox>
            </div>
            <div className="lg:hidden h-full overflow-auto">
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                {machines.map(horaCard)}
              </div>
            </div>
          </div>
        </>
      )}

      {modo === "tabla" && (
      <Panel className="flex-1" title="Hora por hora por máquina" icon={Clock}
        right={<span className="text-xs text-muted-foreground">{multiDay ? "suma por hora del día en el periodo · hora local Tijuana" : "hora local Tijuana · 00–06h = madrugada del T2"}</span>}
        bodyClassName="p-1">
        {/* La matriz completa (28 columnas × ~14 máquinas) va en FitBox: se
            escala para caber ENTERA en el hueco del panel — era la vista que
            seguía scrolleando en las TVs. El volumen manda: en pantallas muy
            angostas se ve chica pero completa (la cara móvil es "Gráfica"). */}
        <FitBox>
          <table className="text-xs border-collapse">
            <thead>
              <tr>
                <th rowSpan={2} className="sticky left-0 bg-card text-left text-[10px] uppercase tracking-wider text-muted-foreground font-medium px-3 py-2 border-b border-border whitespace-nowrap align-bottom">Máquina</th>
                <th colSpan={13} className="text-center text-[10px] uppercase tracking-widest font-semibold px-2 pt-2 pb-1 text-blue-600 dark:text-blue-400 border-l border-border/60">Turno 1 · 7:00 – 19:00</th>
                <th colSpan={13} className="text-center text-[10px] uppercase tracking-widest font-semibold px-2 pt-2 pb-1 text-violet-600 dark:text-violet-400 border-l border-border/60">Turno 2 · 19:00 – 7:00</th>
                <th rowSpan={2} className="text-right text-[10px] uppercase tracking-wider text-muted-foreground font-medium px-3 py-2 border-b border-border border-l border-border/60 align-bottom">Total</th>
              </tr>
              <tr>
                {T1_HOURS.map(h => (
                  <th key={h} className={`text-right text-[10px] uppercase tracking-wider text-muted-foreground font-medium px-2 py-1.5 border-b border-border tabular-nums ${h === 7 ? "border-l border-border/60" : ""}`}>{hh(h)}</th>
                ))}
                <th className="text-right text-[10px] uppercase tracking-wider font-semibold px-2 py-1.5 border-b border-border bg-muted/30 text-blue-600 dark:text-blue-400">T1</th>
                {T2_HOURS.map(h => (
                  <th key={h} className={`text-right text-[10px] uppercase tracking-wider text-muted-foreground font-medium px-2 py-1.5 border-b border-border tabular-nums ${h === 19 ? "border-l border-border/60" : ""}`}>{hh(h)}</th>
                ))}
                <th className="text-right text-[10px] uppercase tracking-wider font-semibold px-2 py-1.5 border-b border-border bg-muted/30 text-violet-600 dark:text-violet-400">T2</th>
              </tr>
            </thead>
            <tbody>
              {machines.map(m => (
                <tr key={m} className="border-b border-border/40">
                  <td className="sticky left-0 bg-card px-2 py-1.5 text-[11px] font-semibold whitespace-nowrap">{m.replace("MAQUINA", "M")}</td>
                  {T1_HOURS.map(h => {
                    const v = cells[`${m}|${h}`] || 0;
                    return (
                      <td key={h} className={`px-2 py-1.5 text-right tabular-nums ${h === 7 ? "border-l border-border/60" : ""}`}
                        style={v ? { background: `rgba(59,130,246,${(0.06 + 0.24 * (v / maxCell)).toFixed(3)})` } : undefined}>
                        {v ? fmtInt(v) : <span className="text-muted-foreground/30">·</span>}
                      </td>
                    );
                  })}
                  <td className="px-2 py-1.5 text-right font-semibold tabular-nums bg-muted/30">{t1Totals[m] ? fmtInt(t1Totals[m]) : <span className="text-muted-foreground/30">·</span>}</td>
                  {T2_HOURS.map(h => {
                    const v = cells[`${m}|${h}`] || 0;
                    return (
                      <td key={h} className={`px-2 py-1.5 text-right tabular-nums ${h === 19 ? "border-l border-border/60" : ""}`}
                        style={v ? { background: `rgba(139,92,246,${(0.06 + 0.24 * (v / maxCell)).toFixed(3)})` } : undefined}>
                        {v ? fmtInt(v) : <span className="text-muted-foreground/30">·</span>}
                      </td>
                    );
                  })}
                  <td className="px-2 py-1.5 text-right font-semibold tabular-nums bg-muted/30">{t2Totals[m] ? fmtInt(t2Totals[m]) : <span className="text-muted-foreground/30">·</span>}</td>
                  <td className="px-3 py-1.5 text-right font-semibold tabular-nums border-l border-border/60">{fmtInt(rowTotals[m])}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t border-border">
                <td className="sticky left-0 bg-card px-3 py-2 text-[10px] uppercase tracking-wider text-muted-foreground">Total</td>
                {T1_HOURS.map(h => (
                  <td key={h} className={`px-2 py-2 text-right font-semibold tabular-nums ${h === 7 ? "border-l border-border/60" : ""}`}>{colTotals[h] ? fmtInt(colTotals[h]) : ""}</td>
                ))}
                <td className="px-2 py-2 text-right font-bold tabular-nums bg-muted/30 text-blue-600 dark:text-blue-400">{fmtInt(t1Grand)}</td>
                {T2_HOURS.map(h => (
                  <td key={h} className={`px-2 py-2 text-right font-semibold tabular-nums ${h === 19 ? "border-l border-border/60" : ""}`}>{colTotals[h] ? fmtInt(colTotals[h]) : ""}</td>
                ))}
                <td className="px-2 py-2 text-right font-bold tabular-nums bg-muted/30 text-violet-600 dark:text-violet-400">{fmtInt(t2Grand)}</td>
                <td className="px-3 py-2 text-right font-bold tabular-nums border-l border-border/60">{fmtInt(grandTotal)}</td>
              </tr>
            </tfoot>
          </table>
        </FitBox>
      </Panel>
      )}
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
    <div className="h-full min-h-[440px] grid grid-cols-1 lg:grid-cols-2 gap-3">
      <Panel title="Producción por operador (top 15)" icon={Users} bodyClassName="overflow-auto">
        <RankBars rows={ops} colorAt={() => "#3b82f6"} />
      </Panel>
      <Panel title="Producción por cliente (top 12)" icon={Boxes} bodyClassName="overflow-auto">
        <RankBars rows={clients} colorAt={(i) => PALETTE[i % PALETTE.length]} />
      </Panel>
    </div>
  );
}
