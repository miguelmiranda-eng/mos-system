import React, { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ArrowLeft, Droplets, RefreshCw, Calculator, PackageSearch,
  AlertTriangle, CheckCircle2, Settings2, CalendarDays, ChevronLeft, ChevronRight,
} from 'lucide-react';

const BACKEND_URL = process.env.REACT_APP_BACKEND_URL;
const API = `${BACKEND_URL}/api`;

const ML_PER_BUCKET = 5 * 3785.41; // cubeta de 5 galones
const fmt = (n, d = 0) => (n === null || n === undefined || isNaN(n))
  ? '—'
  : Number(n).toLocaleString('en-US', { maximumFractionDigits: d, minimumFractionDigits: 0 });

// ── Bitácora diaria ─────────────────────────────────────────────────────────
// El estado de un día se decide por severidad, no por promedio: quedarse en
// CERO manda sobre estar bajo mínimo, y estar bajo mínimo manda sobre no
// alcanzar para el backlog. Un día sin foto NO es un día bueno — se pinta
// aparte, porque antes de que existiera esta bitácora el sistema no guardaba
// absolutamente nada y sería mentira pintarlo en verde.
const DAY_STATES = {
  empty:    { label: 'Se quedó en cero',    dot: 'bg-red-600',     cell: 'bg-red-600 text-white border-red-700' },
  below:    { label: 'Bajo el mínimo',      dot: 'bg-red-400',     cell: 'bg-red-100 text-red-700 border-red-200' },
  short:    { label: 'No cubre el backlog', dot: 'bg-amber-400',   cell: 'bg-amber-100 text-amber-700 border-amber-200' },
  ok:       { label: 'Con inventario sano', dot: 'bg-emerald-500', cell: 'bg-emerald-100 text-emerald-700 border-emerald-200' },
  nodata:   { label: 'Sin registro',        dot: 'bg-slate-300',   cell: 'bg-white text-slate-300 border-dashed border-slate-200' },
};

const dayState = (snap) => {
  if (!snap) return 'nodata';
  const low = snap.stock_low !== null && snap.stock_low !== undefined ? snap.stock_low : snap.stock_buckets;
  if (low === null || low === undefined) return 'nodata';
  if (low <= 0) return 'empty';
  if (snap.stock_min !== null && snap.stock_min !== undefined && low < snap.stock_min) return 'below';
  if (snap.coverage_pct !== null && snap.coverage_pct !== undefined && snap.coverage_pct < 100) return 'short';
  return 'ok';
};

// YYYY-MM-DD armado con los getters LOCALES: toISOString() convierte a UTC y en
// Tijuana (UTC-7) recorre el día un día hacia atrás toda la tarde.
const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const MONTHS = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio',
  'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];

const Card = ({ children, className = '' }) => (
  <div className={`bg-white border border-slate-200 rounded-2xl shadow-sm ${className}`}>{children}</div>
);

const Metric = ({ label, value, unit, tone = 'text-slate-900' }) => (
  <div className="flex-1 min-w-[130px] px-4 py-3">
    <p className="text-[9px] font-bold uppercase tracking-[0.2em] text-slate-400">{label}</p>
    <p className={`mt-1 text-2xl font-black ${tone}`}>
      {value} <span className="text-xs font-bold text-slate-400">{unit}</span>
    </p>
  </div>
);

const BlockerTool = () => {
  const navigate = useNavigate();

  // ----- parámetros compartidos (recalibrados con la regla de algodón, ago 2026)
  const [mlPerHit, setMlPerHit] = useState(2.24);
  const [blockerShare, setBlockerShare] = useState(22); // % de hits que llevan blocker (mezcla actual)

  // ----- calculadora de proyección
  const [projHits, setProjHits] = useState('');

  // ----- backlog
  const [forecast, setForecast] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const fetchForecast = useCallback(async () => {
    // Devuelve promesa (el .then de arriba encadena la bitácora).
    try {
      setLoading(true);
      setError(null);
      const res = await fetch(`${API}/tools/blocker-forecast?ml_per_hit=${mlPerHit}`, { credentials: 'include' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setForecast(await res.json());
    } catch (e) {
      setError('No se pudo cargar el pronóstico. Verifica tu sesión o el servidor.');
    } finally {
      setLoading(false);
    }
  }, [mlPerHit]);

  // ----- bitácora diaria
  const [history, setHistory] = useState(null);
  const [histMonth, setHistMonth] = useState(() => { const d = new Date(); d.setDate(1); return d; });
  const [pickedDay, setPickedDay] = useState(null);

  const fetchHistory = useCallback(async () => {
    try {
      const res = await fetch(`${API}/tools/blocker-history?days=365`, { credentials: 'include' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setHistory(await res.json());
    } catch { /* la bitácora es complementaria: si falla, la calculadora sigue */ }
  }, []);

  // El historial se recarga DESPUÉS del pronóstico: abrir la pantalla archiva la
  // foto del día, así que pedirlo antes lo traería sin el registro de hoy.
  useEffect(() => { fetchForecast().then(fetchHistory); }, [fetchForecast, fetchHistory]);

  // proyección: hits proyectados x % con blocker x factor
  const hitsNum = parseFloat(projHits) || 0;
  const projMl = hitsNum * (blockerShare / 100) * mlPerHit;
  const projBuckets = projMl / ML_PER_BUCKET;

  const snapByDate = {};
  for (const sn of (history?.snapshots || [])) snapByDate[sn.date] = sn;
  const firstDate = history?.first_date || null;

  // Celdas del mes visible: lunes primero, con los huecos del arranque de mes.
  const monthCells = (() => {
    const y = histMonth.getFullYear();
    const m = histMonth.getMonth();
    const first = new Date(y, m, 1);
    const lead = (first.getDay() + 6) % 7; // getDay: 0=domingo → 0=lunes
    const total = new Date(y, m + 1, 0).getDate();
    const cells = Array.from({ length: lead }, () => null);
    for (let d = 1; d <= total; d++) cells.push(new Date(y, m, d));
    return cells;
  })();

  const monthSnaps = monthCells.filter(Boolean).map(d => snapByDate[ymd(d)]).filter(Boolean);
  const diasEnCero = monthSnaps.filter(sn => dayState(sn) === 'empty').length;
  const diasBajoMin = monthSnaps.filter(sn => dayState(sn) === 'below').length;

  // Aviso que faltaba: MaintOps SÍ trae el mínimo y la pantalla nunca lo miraba.
  const stockNow = forecast?.stock?.buckets;
  const minNow = forecast?.stock?.min;
  const belowMinNow = stockNow !== null && stockNow !== undefined
    && minNow !== null && minNow !== undefined && stockNow < minNow;

  const cov = forecast?.stock?.coverage_pct;
  const covTone = cov === null || cov === undefined ? 'text-slate-400'
    : cov >= 100 ? 'text-emerald-600' : cov >= 50 ? 'text-amber-600' : 'text-red-600';
  const covBar = cov === null || cov === undefined ? 'bg-slate-300'
    : cov >= 100 ? 'bg-emerald-500' : cov >= 50 ? 'bg-amber-500' : 'bg-red-500';

  return (
    <div className="min-h-screen bg-slate-50 text-slate-800 font-barlow overflow-y-auto pb-16">
      {/* HEADER */}
      <header className="sticky top-0 z-40 bg-white/90 backdrop-blur-lg border-b border-slate-200">
        <div className="max-w-6xl mx-auto px-4 md:px-8 py-4 flex items-center gap-3">
          <button
            onClick={() => navigate('/home')}
            className="p-2 rounded-xl bg-white border border-slate-200 text-slate-500 hover:text-blue-600 hover:border-blue-300 transition-colors"
            title="Volver"
            data-testid="blocker-back"
          >
            <ArrowLeft className="w-4 h-4" />
          </button>
          <div className="w-10 h-10 rounded-2xl bg-violet-50 flex items-center justify-center">
            <Droplets className="w-5 h-5 text-violet-600" />
          </div>
          <div className="leading-none">
            <h1 className="text-lg font-black uppercase tracking-tight text-slate-900">Calculadora de Blocker</h1>
            <span className="block text-[9px] font-bold uppercase tracking-[0.3em] text-slate-400 mt-1">
              Velocity blocker grey · 2.24 mL por hit con blocker · algodón 70%+ (100, 90/10, 80/20) no lleva
            </span>
          </div>
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-4 md:px-8 pt-8 space-y-8">

        {/* AVISO DE MÍNIMO — MaintOps define un stock mínimo por artículo y esta
            pantalla lo ignoraba: mostraba "4 cubetas" sin decir que el mínimo
            son 6. */}
        {belowMinNow && (
          <div
            className={`flex items-start gap-3 p-4 rounded-2xl border ${stockNow <= 0
              ? 'bg-red-600 border-red-700 text-white'
              : 'bg-red-50 border-red-200 text-red-800'}`}
            data-testid="blocker-below-min"
          >
            <AlertTriangle className="w-5 h-5 mt-0.5 shrink-0" />
            <div className="text-sm leading-relaxed">
              <b className="uppercase tracking-wide">
                {stockNow <= 0 ? 'Sin blocker en almacén' : 'Stock por debajo del mínimo'}
              </b>
              <div className="mt-0.5">
                Hay <b>{fmt(stockNow)} cubetas</b> y el mínimo de MaintOps es <b>{fmt(minNow)}</b>.
                El backlog pendiente pide <b>{fmt(forecast?.totals?.buckets, 1)}</b> cubetas.
              </div>
            </div>
          </div>
        )}

        {/* PARÁMETROS */}
        <Card className="p-4 flex flex-wrap items-end gap-5">
          <div className="flex items-center gap-2 text-slate-500">
            <Settings2 className="w-4 h-4" />
            <span className="text-[10px] font-bold uppercase tracking-[0.2em]">Parámetros</span>
          </div>
          <label className="block">
            <span className="text-[9px] font-bold uppercase tracking-[0.2em] text-slate-400">Factor mL por hit</span>
            <input
              type="number" step="0.01" min="0" value={mlPerHit}
              onChange={(e) => setMlPerHit(parseFloat(e.target.value) || 0)}
              className="mt-1 block w-28 h-9 px-3 bg-slate-50 border border-slate-200 rounded-lg text-sm text-slate-900 outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-100"
              data-testid="blocker-ml-per-hit"
            />
          </label>
          <label className="block">
            <span className="text-[9px] font-bold uppercase tracking-[0.2em] text-slate-400">% de hits con blocker (proyección)</span>
            <input
              type="number" step="1" min="0" max="100" value={blockerShare}
              onChange={(e) => setBlockerShare(parseFloat(e.target.value) || 0)}
              className="mt-1 block w-28 h-9 px-3 bg-slate-50 border border-slate-200 rounded-lg text-sm text-slate-900 outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-100"
              data-testid="blocker-share"
            />
          </label>
          <p className="text-[10px] text-slate-400 max-w-xs leading-relaxed">
            22% = mezcla actual: solo prenda DE MEZCLA oscura o clara con diseño de 5+ colores
            lleva blocker; la 100% algodón no lleva. Si tu proyección es solo de hits que llevan
            blocker, usa 100%.
          </p>
        </Card>

        {/* CALCULADORA */}
        <section>
          <div className="flex items-center gap-2 mb-3">
            <Calculator className="w-4 h-4 text-blue-600" />
            <h2 className="text-sm font-black uppercase tracking-[0.2em] text-slate-800">Proyección de consumo</h2>
          </div>
          <Card className="p-5">
            <label className="block max-w-sm">
              <span className="text-[9px] font-bold uppercase tracking-[0.2em] text-slate-400">Impresiones (hits) proyectadas</span>
              <input
                type="number" min="0" placeholder="p. ej. 250000" value={projHits}
                onChange={(e) => setProjHits(e.target.value)}
                className="mt-1 block w-full h-11 px-4 bg-slate-50 border border-slate-200 rounded-xl text-lg font-bold text-slate-900 outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-100"
                data-testid="blocker-proj-hits"
              />
            </label>
            <div className="mt-4 flex flex-wrap divide-x divide-slate-200 rounded-xl bg-slate-50 border border-slate-200">
              <Metric label="Blocker necesario" value={fmt(projMl / 1000, 1)} unit="L" />
              <Metric label="Galones" value={fmt(projMl / 3785.41, 1)} unit="gal" />
              <Metric label="Cubetas de 5 gal" value={fmt(projBuckets, 2)} unit="cubetas" tone="text-blue-600" />
              <Metric label="Comprar (redondeo)" value={hitsNum > 0 ? fmt(Math.ceil(projBuckets)) : '—'} unit="cubetas" />
            </div>
          </Card>
        </section>

        {/* BACKLOG */}
        <section>
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <PackageSearch className="w-4 h-4 text-blue-600" />
              <h2 className="text-sm font-black uppercase tracking-[0.2em] text-slate-800">Backlog sin imprimir</h2>
              <span className="text-[9px] font-bold uppercase tracking-[0.2em] text-slate-400">
                Órdenes en SCHEDULING · BLANKS · SCREENS · NECK
              </span>
            </div>
            <button
              onClick={fetchForecast}
              className="flex items-center gap-2 px-3 h-8 rounded-lg bg-white border border-slate-200 text-[10px] font-bold uppercase tracking-widest text-slate-500 hover:text-blue-600 hover:border-blue-300 transition-colors"
              data-testid="blocker-refresh"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} /> Actualizar
            </button>
          </div>

          {error && (
            <Card className="p-4 text-sm text-red-600 flex items-center gap-2">
              <AlertTriangle className="w-4 h-4" /> {error}
            </Card>
          )}

          {forecast && !error && (
            <div className="space-y-4">
              {/* Totales + cobertura */}
              <Card className="p-5">
                <div className="flex flex-wrap divide-x divide-slate-200 rounded-xl bg-slate-50 border border-slate-200">
                  <Metric label="Órdenes pendientes" value={fmt(forecast.totals.orders)} unit="órdenes" />
                  <Metric label="Hits por imprimir" value={fmt(forecast.totals.pending_hits)} unit="hits" />
                  <Metric label="Blocker requerido" value={fmt(forecast.totals.buckets, 1)} unit="cubetas" tone="text-blue-600" />
                  <Metric label="Stock actual (MaintOps)" value={forecast.stock ? fmt(forecast.stock.buckets) : '—'} unit="cubetas" />
                </div>

                {/* Barra de cobertura */}
                <div className="mt-5">
                  <div className="flex items-center justify-between mb-1.5">
                    <span className="text-[10px] font-bold uppercase tracking-[0.2em] text-slate-400">
                      Cobertura del backlog con el stock actual
                    </span>
                    <span className={`text-sm font-black ${covTone}`}>
                      {cov === null || cov === undefined ? 'sin datos de almacén' : `${fmt(Math.min(cov, 999), 0)}%`}
                    </span>
                  </div>
                  <div className="w-full h-2.5 rounded-full bg-slate-200 overflow-hidden">
                    <div
                      className={`h-full rounded-full transition-all duration-700 ${covBar}`}
                      style={{ width: `${Math.min(cov || 0, 100)}%` }}
                    />
                  </div>
                  <div className="mt-2 flex items-center gap-2 text-[11px] text-slate-500">
                    {cov !== null && cov !== undefined && (cov >= 100 ? (
                      <><CheckCircle2 className="w-3.5 h-3.5 text-emerald-600" />
                        El stock alcanza para todo el backlog pendiente.</>
                    ) : (
                      <><AlertTriangle className="w-3.5 h-3.5 text-amber-500" />
                        Faltan ~{fmt(Math.max(0, forecast.totals.buckets - (forecast.stock?.buckets || 0)), 1)} cubetas
                        para cubrir el backlog completo.</>
                    ))}
                  </div>
                </div>
              </Card>

              {/* Desglose por tablero */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <Card className="p-4">
                  <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-slate-400 mb-3">Por tablero</p>
                  <table className="w-full text-sm">
                    <tbody>
                      {forecast.by_board.map((b) => (
                        <tr key={b.board} className="border-b border-slate-100 last:border-0">
                          <td className="py-1.5 font-bold text-slate-700">{b.board}</td>
                          <td className="py-1.5 text-right text-slate-500">{fmt(b.orders)} órd.</td>
                          <td className="py-1.5 text-right text-slate-500">{fmt(b.pending_hits)} hits</td>
                          <td className="py-1.5 text-right font-bold text-blue-600">{fmt(b.ml / ML_PER_BUCKET, 2)} cub.</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </Card>

                {/* Top órdenes */}
                <Card className="p-4">
                  <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-slate-400 mb-3">
                    Órdenes que más blocker necesitan
                  </p>
                  <div className="max-h-64 overflow-y-auto pr-1">
                    <table className="w-full text-xs">
                      <tbody>
                        {forecast.top_orders.map((o) => (
                          <tr key={`${o.order_number}-${o.board}`} className="border-b border-slate-100 last:border-0">
                            <td className="py-1.5 font-bold text-slate-900">#{o.order_number}</td>
                            <td className="py-1.5 text-slate-500 truncate max-w-[110px]">{o.client || '—'}</td>
                            <td className="py-1.5">
                              <span className={`px-1.5 py-0.5 rounded text-[9px] font-bold uppercase ${o.is_dark ? 'bg-blue-50 text-blue-700' : 'bg-slate-100 text-slate-500'}`}>
                                {o.color || 'S/C'}
                              </span>
                              <span className={`ml-1 px-1.5 py-0.5 rounded text-[9px] font-bold uppercase ${o.fabric === 'ALGODON' ? 'bg-emerald-50 text-emerald-700' : o.fabric === 'MEZCLA' ? 'bg-violet-50 text-violet-700' : 'bg-slate-100 text-slate-400'}`}>
                                {o.fabric === 'SIN DATO' ? 'S/T' : o.fabric}
                              </span>
                            </td>
                            <td className="py-1.5 text-right text-slate-500">{fmt(o.pending_hits)} hits</td>
                            <td className="py-1.5 text-right font-bold text-slate-900">{fmt(o.ml / 1000, 1)} L</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </Card>
              </div>

              <p className="text-[10px] text-slate-400 leading-relaxed">
                Hits pendientes = piezas de la orden × posiciones de impresión − hits ya registrados en producción.
                La prenda con {Math.round(forecast.params.cotton_no_blocker_pct)}%+ de algodón (100%, 90/10, 80/20) no lleva blocker (tela resuelta vía pick tickets del WMS);
                MEZCLA oscura cuenta al 100% y mezcla clara al {Math.round((forecast.params.light_factor) * 100)}% (diseños de 5+ colores).
                Sin dato de tela se aplica el % de algodón medido en producción ({Math.round(forecast.params.dark_cotton_share * 100)}% oscuras / {Math.round(forecast.params.light_cotton_share * 100)}% claras).
                Stock consultado en vivo del almacén de mantenimiento (MaintOps).
              </p>
            </div>
          )}
        </section>

        {/* ── BITÁCORA DIARIA ──────────────────────────────────────────────
            Antes de esto la pantalla no guardaba nada: no había forma de saber
            si el stock ya venía bajo desde días antes de quedarse en cero. */}
        <section className="space-y-3 pb-8">
          <div className="flex items-center justify-between flex-wrap gap-3">
            <div className="flex items-center gap-2">
              <CalendarDays className="w-4 h-4 text-blue-600" />
              <h2 className="text-sm font-black uppercase tracking-[0.2em] text-slate-900">Bitácora de blocker</h2>
              <span className="text-[9px] font-bold uppercase tracking-[0.2em] text-slate-400">
                Una foto por día · stock vs mínimo vs backlog
              </span>
            </div>
            <div className="flex items-center gap-1">
              <button
                onClick={() => setHistMonth(m => new Date(m.getFullYear(), m.getMonth() - 1, 1))}
                className="p-1.5 rounded-lg bg-white border border-slate-200 text-slate-500 hover:text-blue-600 hover:border-blue-300"
                title="Mes anterior"
                data-testid="blocker-hist-prev"
              ><ChevronLeft className="w-4 h-4" /></button>
              <span className="px-3 text-xs font-bold uppercase tracking-widest text-slate-600 min-w-[150px] text-center">
                {MONTHS[histMonth.getMonth()]} {histMonth.getFullYear()}
              </span>
              <button
                onClick={() => setHistMonth(m => new Date(m.getFullYear(), m.getMonth() + 1, 1))}
                className="p-1.5 rounded-lg bg-white border border-slate-200 text-slate-500 hover:text-blue-600 hover:border-blue-300"
                title="Mes siguiente"
                data-testid="blocker-hist-next"
              ><ChevronRight className="w-4 h-4" /></button>
            </div>
          </div>

          <Card className="p-5">
            <div className="grid grid-cols-7 gap-1.5 mb-1.5">
              {['L', 'M', 'M', 'J', 'V', 'S', 'D'].map((d, i) => (
                <div key={i} className="text-center text-[9px] font-bold uppercase tracking-widest text-slate-400 py-1">{d}</div>
              ))}
            </div>
            <div className="grid grid-cols-7 gap-1.5" data-testid="blocker-calendar">
              {monthCells.map((d, i) => {
                if (!d) return <div key={`x${i}`} />;
                const key = ymd(d);
                const snap = snapByDate[key];
                const st = DAY_STATES[dayState(snap)];
                const isToday = key === (history?.today || ymd(new Date()));
                const isFuture = key > (history?.today || ymd(new Date()));
                return (
                  <button
                    key={key}
                    type="button"
                    disabled={!snap}
                    onClick={() => setPickedDay(snap ? { ...snap, key } : null)}
                    title={snap ? `${key} · ${st.label}` : `${key} · sin registro`}
                    className={`relative aspect-square rounded-lg border text-xs font-bold flex flex-col items-center justify-center transition-transform
                      ${isFuture ? 'bg-slate-50 text-slate-200 border-slate-100' : st.cell}
                      ${snap ? 'hover:scale-105 cursor-pointer' : 'cursor-default'}
                      ${pickedDay?.key === key ? 'ring-2 ring-blue-500 ring-offset-1' : ''}
                      ${isToday ? 'outline outline-2 outline-blue-400' : ''}`}
                    data-testid={`blocker-day-${key}`}
                  >
                    {d.getDate()}
                    {snap && (
                      <span className="text-[8px] font-black opacity-80">
                        {fmt(snap.stock_low !== null && snap.stock_low !== undefined ? snap.stock_low : snap.stock_buckets)}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>

            {/* Leyenda */}
            <div className="mt-4 flex flex-wrap gap-x-4 gap-y-1.5">
              {Object.entries(DAY_STATES).map(([k, v]) => (
                <span key={k} className="flex items-center gap-1.5 text-[10px] text-slate-500">
                  <span className={`w-2.5 h-2.5 rounded-full ${v.dot}`} /> {v.label}
                </span>
              ))}
            </div>

            {(diasEnCero > 0 || diasBajoMin > 0) && (
              <div className="mt-3 text-[11px] text-slate-600 flex items-center gap-1.5">
                <AlertTriangle className="w-3.5 h-3.5 text-amber-500" />
                En {MONTHS[histMonth.getMonth()]}: <b>{diasEnCero}</b> día(s) en cero y <b>{diasBajoMin}</b> bajo el mínimo.
              </div>
            )}

            {/* Detalle del día elegido */}
            {pickedDay && (
              <div className="mt-4 p-4 rounded-xl bg-slate-50 border border-slate-200" data-testid="blocker-day-detail">
                <div className="flex items-center justify-between mb-3">
                  <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-slate-500">{pickedDay.key}</p>
                  <button onClick={() => setPickedDay(null)} className="text-[10px] font-bold uppercase tracking-widest text-slate-400 hover:text-slate-700">Cerrar</button>
                </div>
                <div className="flex flex-wrap divide-x divide-slate-200 rounded-lg bg-white border border-slate-200">
                  <Metric label="Stock al cierre" value={fmt(pickedDay.stock_buckets)} unit="cubetas" />
                  <Metric label="Mínimo del día" value={fmt(pickedDay.stock_low)} unit="cubetas"
                    tone={dayState(pickedDay) === 'ok' ? 'text-slate-900' : 'text-red-600'} />
                  <Metric label="Mínimo MaintOps" value={fmt(pickedDay.stock_min)} unit="cubetas" />
                  <Metric label="Backlog pedía" value={fmt(pickedDay.required_buckets, 1)} unit="cubetas" tone="text-blue-600" />
                  <Metric label="Cobertura" value={pickedDay.coverage_pct === null || pickedDay.coverage_pct === undefined ? '—' : fmt(pickedDay.coverage_pct)} unit="%" />
                </div>
                <p className="mt-2 text-[10px] text-slate-400">
                  {fmt(pickedDay.orders)} órdenes · {fmt(pickedDay.pending_hits)} hits pendientes ·
                  {' '}{fmt(pickedDay.samples)} lectura(s) ese día · última {pickedDay.captured_at ? new Date(pickedDay.captured_at).toLocaleString() : '—'}
                </p>
              </div>
            )}

            <p className="mt-4 text-[10px] text-slate-400 leading-relaxed">
              {firstDate
                ? <>La bitácora arranca el <b>{firstDate}</b>: antes de esa fecha el sistema no guardaba
                    ningún registro de blocker, así que esos días salen como “sin registro” — no como días buenos.</>
                : <>Todavía no hay ningún día archivado. Se guarda una foto automática cada mañana y otra
                    cada vez que alguien abre esta pantalla.</>}
              {' '}El “mínimo del día” es el valor más bajo que se vio: si el almacén cae a cero a media jornada
              y en la tarde entra una compra, el día igual queda marcado en rojo.
            </p>
          </Card>
        </section>
      </main>
    </div>
  );
};

export default BlockerTool;
