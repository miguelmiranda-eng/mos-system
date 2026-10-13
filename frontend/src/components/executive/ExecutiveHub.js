// Vista ejecutiva: menú de dashboards por etapa del proceso, sólo lectura,
// para rol ceo y supersu (el backend lo exige igual en /api/executive/*).
// Datos: /executive/pipeline (etapas + corte diario de "listo") y
// /executive/kpis (lo mismo que el Reporte Ejecutivo por correo). Ambos con
// caché en el servidor; aquí se refrescan cada 60 s mientras la pestaña está
// visible — sin escuchar el WebSocket, que en hora pico dispara cada ~20 s.
import React, { useCallback, useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  ArrowLeft, LayoutDashboard, PackageSearch, ListTodo, Factory, ShieldCheck, Package, Truck,
  CalendarRange, BarChart3, LineChart, RefreshCw, Languages, AlertTriangle,
} from 'lucide-react';
import { useLang } from '../../contexts/LanguageContext';
import ThemeSwitch from '../ThemeSwitch';
import { API } from '../../lib/constants';
import { apiFetch } from '../../lib/http';
import { fmt } from './parts';
import StageView from './StageView';
import SummaryView from './SummaryView';
import { PlanningView, ProductionView } from './PlantViews';
import ListoView from './ListoView';
import AnalyticsView from './AnalyticsView';

// Orden = orden del proceso. labelKey/descKey en es.js / en.js. 'listo' no es
// una etapa en proceso: tiene su propia vista (llegadas por periodo).
export const STAGE_META = [
  { key: 'blanks', labelKey: 'exe_stage_blanks', descKey: 'exe_desc_blanks', icon: PackageSearch },
  { key: 'por_producir', labelKey: 'exe_stage_por_producir', descKey: 'exe_desc_por_producir', icon: ListTodo },
  { key: 'produccion', labelKey: 'exe_stage_produccion', descKey: 'exe_desc_produccion', icon: Factory },
  { key: 'qc', labelKey: 'exe_stage_qc', descKey: 'exe_desc_qc', icon: ShieldCheck },
  { key: 'empaque', labelKey: 'exe_stage_empaque', descKey: 'exe_desc_empaque', icon: Package },
  { key: 'listo', labelKey: 'exe_stage_listo', descKey: 'exe_desc_listo', icon: Truck },
];

const PLANT = [
  { key: 'programacion', labelKey: 'exe_nav_planning', icon: CalendarRange },
  { key: 'produccion_kpi', labelKey: 'exe_nav_production', icon: BarChart3 },
  { key: 'analitica', labelKey: 'exe_nav_analytics', icon: LineChart },
];

const REFRESH_MS = 60000;

const ExecutiveHub = () => {
  const { t, lang, toggleLang } = useLang();
  const navigate = useNavigate();
  const { section = 'resumen' } = useParams();
  const [pipeline, setPipeline] = useState(null);
  const [kpis, setKpis] = useState(null);
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(false);
  const [updatedAt, setUpdatedAt] = useState(null);
  // Sube en cada recarga: las vistas que piden sus propios datos (listo,
  // analítica) se refrescan al mismo ritmo que el resto.
  const [refreshKey, setRefreshKey] = useState(0);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [p, k] = await Promise.all([
        apiFetch(`${API}/executive/pipeline`).then(r => (r.ok ? r.json() : null)),
        apiFetch(`${API}/executive/kpis`).then(r => (r.ok ? r.json() : null)).catch(() => null),
      ]);
      if (p) setPipeline(p);
      if (k) setKpis(k);
      setError(!p);
      setUpdatedAt(new Date());
      setRefreshKey(k => k + 1);
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    const id = setInterval(() => { if (document.visibilityState === 'visible') load(); }, REFRESH_MS);
    const onVis = () => { if (document.visibilityState === 'visible') load(); };
    document.addEventListener('visibilitychange', onVis);
    return () => { clearInterval(id); document.removeEventListener('visibilitychange', onVis); };
  }, [load]);

  const open = (key) => navigate(`/ejecutivo/${key}`);
  const stageByKey = Object.fromEntries((pipeline?.stages || []).map(s => [s.key, s]));
  const stageMeta = STAGE_META.find(m => m.key === section);
  const plant = PLANT.find(p => p.key === section);
  const title = section === 'resumen' ? t('exe_nav_summary') : t((stageMeta || plant)?.labelKey || 'exe_nav_summary');

  const NavItem = ({ k, labelKey, icon: Icon, count, late }) => {
    const active = section === k;
    return (
      <button type="button" onClick={() => open(k)}
        className={`shrink-0 lg:w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm transition-colors whitespace-nowrap ${active ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground hover:bg-muted'}`}>
        <Icon className="w-4 h-4 shrink-0" />
        <span className="truncate">{t(labelKey)}</span>
        {count != null && (
          <span className="ml-auto flex items-center gap-1.5 pl-2">
            {late > 0 && (
              <span title={t('exe_n_late', { n: late })}
                className={`inline-flex items-center gap-0.5 text-[11px] font-semibold ${active ? '' : 'text-destructive'}`}>
                <AlertTriangle className="w-3 h-3" />{late}
              </span>
            )}
            <span className={`text-[11px] tabular-nums px-1.5 rounded ${active ? 'bg-primary-foreground/20' : 'bg-muted'}`}>{fmt(count, lang)}</span>
          </span>
        )}
      </button>
    );
  };

  const GroupLabel = ({ children }) => (
    <div className="hidden lg:block px-3 pt-4 pb-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground/70">{children}</div>
  );

  let body;
  if (section === 'analitica') {
    body = <AnalyticsView refreshKey={refreshKey} />;
  } else if (section === 'listo') {
    body = pipeline ? <ListoView summary={pipeline.listo} refreshKey={refreshKey} />
      : <div className="py-24 text-center text-sm text-muted-foreground">{t('exe_load_error')}</div>;
  } else if (!pipeline && !kpis) {
    body = (
      <div className="py-24 text-center text-sm text-muted-foreground">
        {error ? t('exe_load_error') : <RefreshCw className="w-5 h-5 animate-spin mx-auto" />}
      </div>
    );
  } else if (section === 'resumen') {
    body = <SummaryView pipeline={pipeline} kpis={kpis} stageMeta={STAGE_META} onOpen={open} />;
  } else if (stageMeta) {
    body = stageByKey[section]
      ? <StageView stage={stageByKey[section]} meta={stageMeta} />
      : <div className="py-24 text-center text-sm text-muted-foreground">{t('exe_load_error')}</div>;
  } else if (section === 'programacion') {
    body = <PlanningView kpis={kpis} />;
  } else if (section === 'produccion_kpi') {
    body = <ProductionView kpis={kpis} />;
  } else {
    body = <SummaryView pipeline={pipeline} kpis={kpis} stageMeta={STAGE_META} onOpen={open} />;
  }

  return (
    <div className="min-h-screen bg-background text-foreground flex flex-col lg:flex-row">
      <aside className="lg:w-72 lg:shrink-0 lg:h-screen lg:sticky lg:top-0 border-b lg:border-b-0 lg:border-r border-border bg-card/60 flex flex-col">
        <div className="flex items-center gap-2 px-4 py-3 lg:py-4">
          <button type="button" onClick={() => navigate('/home')} title={t('exe_back')}
            className="p-1.5 -ml-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted">
            <ArrowLeft className="w-5 h-5" />
          </button>
          <div className="min-w-0">
            <div className="text-sm font-bold leading-tight">{t('exe_title')}</div>
            <div className="text-[11px] text-muted-foreground">{t('exe_subtitle')}</div>
          </div>
        </div>
        <nav className="flex lg:flex-col gap-1 px-3 pb-3 overflow-x-auto lg:overflow-y-auto lg:flex-1">
          <NavItem k="resumen" labelKey="exe_nav_summary" icon={LayoutDashboard} />
          <GroupLabel>{t('exe_group_process')}</GroupLabel>
          {STAGE_META.map(m => (
            <NavItem key={m.key} k={m.key} labelKey={m.labelKey} icon={m.icon}
              count={m.key === 'listo' ? pipeline?.listo?.today?.count : stageByKey[m.key]?.count}
              late={stageByKey[m.key]?.late} />
          ))}
          <GroupLabel>{t('exe_group_plant')}</GroupLabel>
          {PLANT.map(p => <NavItem key={p.key} k={p.key} labelKey={p.labelKey} icon={p.icon} />)}
        </nav>
      </aside>

      <main className="flex-1 min-w-0">
        <header className="sticky top-0 z-20 bg-background/95 backdrop-blur border-b border-border">
          <div className="px-4 md:px-6 py-3 flex items-center gap-3 flex-wrap">
            <h1 className="text-lg md:text-xl font-bold tracking-tight">{title}</h1>
            <div className="ml-auto flex items-center gap-2">
              {updatedAt && (
                <span className="text-xs text-muted-foreground tabular-nums hidden sm:inline">
                  {t('exe_updated', { h: updatedAt.toLocaleTimeString(lang === 'en' ? 'en-US' : 'es-MX', { hour: '2-digit', minute: '2-digit' }) })}
                </span>
              )}
              <button type="button" onClick={load} title={t('exe_refresh')}
                className="p-2 rounded-md border border-border text-muted-foreground hover:text-foreground hover:bg-muted">
                <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
              </button>
              <button type="button" onClick={toggleLang}
                className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-md border border-border text-xs font-semibold text-muted-foreground hover:text-foreground hover:bg-muted">
                <Languages className="w-4 h-4" />{lang === 'es' ? 'EN' : 'ES'}
              </button>
              <ThemeSwitch />
            </div>
          </div>
        </header>
        <div className="px-4 md:px-6 py-5 max-w-[1500px]">{body}</div>
      </main>
    </div>
  );
};

export default ExecutiveHub;
