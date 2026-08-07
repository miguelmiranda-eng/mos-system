import React, { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ArrowLeft, Droplets, RefreshCw, Calculator, PackageSearch,
  AlertTriangle, CheckCircle2, Settings2,
} from 'lucide-react';

const BACKEND_URL = process.env.REACT_APP_BACKEND_URL;
const API = `${BACKEND_URL}/api`;

const ML_PER_BUCKET = 5 * 3785.41; // cubeta de 5 galones
const fmt = (n, d = 0) => (n === null || n === undefined || isNaN(n))
  ? '—'
  : Number(n).toLocaleString('en-US', { maximumFractionDigits: d, minimumFractionDigits: 0 });

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

  // ----- parámetros compartidos (medidos en el análisis jul-ago 2026)
  const [mlPerHit, setMlPerHit] = useState(0.80);
  const [blockerShare, setBlockerShare] = useState(63); // % de hits que llevan blocker (mezcla actual)

  // ----- calculadora de proyección
  const [projHits, setProjHits] = useState('');

  // ----- backlog
  const [forecast, setForecast] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const fetchForecast = useCallback(async () => {
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

  useEffect(() => { fetchForecast(); }, [fetchForecast]);

  // proyección: hits proyectados x % con blocker x factor
  const hitsNum = parseFloat(projHits) || 0;
  const projMl = hitsNum * (blockerShare / 100) * mlPerHit;
  const projBuckets = projMl / ML_PER_BUCKET;

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
              Velocity blocker grey · 0.80 mL por hit (medido jul-ago 2026)
            </span>
          </div>
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-4 md:px-8 pt-8 space-y-8">

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
            63% = mezcla actual (prenda oscura + diseños claros de 5+ colores). Si tu proyección
            es solo de hits que llevan blocker, usa 100%.
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
                Prenda oscura cuenta al 100%; prenda clara al {Math.round((forecast.params.light_factor) * 100)}% (diseños de 5+ colores).
                Stock consultado en vivo del almacén de mantenimiento (MaintOps).
              </p>
            </div>
          )}
        </section>
      </main>
    </div>
  );
};

export default BlockerTool;
