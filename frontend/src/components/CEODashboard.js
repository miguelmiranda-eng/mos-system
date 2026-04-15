import React, { useState, useEffect, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { 
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer, 
  LineChart, Line, PieChart, Pie, Cell, AreaChart, Area
} from 'recharts';
import { 
  Factory, Timer, CheckCircle2, AlertCircle, TrendingUp, Calendar, 
  ArrowLeft, Download, RefreshCw, Layers, LayoutDashboard, Cpu, Users, MapPin, Clock, Sun, Moon, Languages
} from 'lucide-react';
import { toast } from 'sonner';
import { useLang } from '../contexts/LanguageContext';
import { useTheme } from '../contexts/ThemeContext';
import ThemeSwitch from './ThemeSwitch';
import { API } from '../lib/constants';

const CHART_COLORS_DARK = ['#3d85c6', '#e94560', '#38761d', '#f1c232', '#674ea7', '#e066cc', '#e69138'];
const CHART_COLORS_LIGHT = ['#10b981', '#3b82f6', '#f59e0b', '#8b5cf6', '#ef4444', '#ec4899', '#06b6d4'];

const StatCard = ({ title, value, subvalue, icon: Icon, color, description }) => {
  const { theme } = useTheme();
  const { t } = useLang();
  const isDark = theme === 'dark';
  
  return (
    <div className={`backdrop-blur-2xl border rounded-[32px] p-7 relative overflow-hidden group transition-all duration-500 hover:scale-[1.02] hover:shadow-[0_20px_50px_rgba(0,0,0,0.1)] ${
      isDark ? 'bg-gradient-to-br from-card/60 to-card/20 border-white/5 shadow-2xl' : 'bg-white/80 border-emerald-500/10 shadow-xl'
    }`}>
      <div className={`absolute -right-4 -top-4 w-24 h-24 blur-3xl group-hover:opacity-100 transition-all duration-500 ${
        isDark ? `bg-${color === 'emerald' ? 'emerald' : color}-500/10 opacity-70` : `bg-emerald-500/5 opacity-50`
      }`} />
      <div className="flex justify-between items-center mb-6">
        <div className={`p-4 rounded-2xl border transition-all ${
          isDark 
            ? `bg-${color === 'emerald' ? 'emerald' : color}-500/10 border-${color === 'emerald' ? 'emerald' : color}-500/20 group-hover:border-${color === 'emerald' ? 'emerald' : color}-500/40`
            : 'bg-emerald-500/5 border-emerald-500/10'
        }`}>
          <Icon className={`w-6 h-6 ${isDark ? `text-${color === 'emerald' ? 'emerald' : color}-500` : 'text-emerald-600'}`} />
        </div>
      <div className="flex flex-col items-end gap-2">
        {subvalue && (
          <span className={`text-[9px] font-black uppercase tracking-[0.2em] px-3 py-1.5 rounded-full border ${isDark ? 'text-muted-foreground bg-white/5 border-white/5' : 'text-emerald-700 bg-emerald-500/5 border-emerald-500/10'}`}>
            {subvalue}
          </span>
        )}
        {description && (
          <div className="group/info relative">
            <AlertCircle className={`w-3.5 h-3.5 transition-colors cursor-help ${isDark ? 'text-muted-foreground/30 hover:text-primary' : 'text-emerald-500/30 hover:text-emerald-600'}`} />
            <div className={`absolute right-0 top-6 w-48 p-3 backdrop-blur-xl border rounded-2xl text-[9px] font-medium leading-relaxed opacity-0 group-hover/info:opacity-100 transition-opacity pointer-events-none z-50 shadow-2xl ${
              isDark ? 'bg-black/90 border-white/10 text-white/70' : 'bg-white/95 border-emerald-500/20 text-emerald-950'
            }`}>
              <span className={`font-black block mb-1 uppercase tracking-widest ${isDark ? 'text-[#e94560]' : 'text-emerald-600'}`}>{t('ceo_data_source')}</span>
              {description}
            </div>
          </div>
        )}
      </div>
    </div>
    <div className="space-y-1">
      <h3 className={`text-[10px] font-black uppercase tracking-[0.3em] ${isDark ? 'text-muted-foreground/60' : 'text-emerald-800/40'}`}>{title}</h3>
      <div className={`text-4xl font-black tracking-tighter flex items-end gap-1 ${isDark ? 'text-foreground' : 'text-emerald-950'}`}>
        {value}
        {title.includes('Eficiencia') && <span className="text-sm font-medium text-muted-foreground ml-1 mb-1">%</span>}
      </div>
    </div>
    <div className={`absolute bottom-0 left-6 right-6 h-[2px] bg-gradient-to-r from-transparent via-${color === 'emerald' ? 'emerald' : color}-500/40 to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-700`} />
  </div>
  );
};

const CEODashboard = () => {
  const { theme } = useTheme();
  const isDark = theme === 'dark';
  const CHART_COLORS = isDark ? CHART_COLORS_DARK : CHART_COLORS_LIGHT;

  const navigate = useNavigate();
  const { t, toggleLang, lang } = useLang();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [period, setPeriod] = useState('week'); // today, week, month, custom
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');

  const fetchAnalytics = async (p = period) => {
    setLoading(true);
    try {
      let url = `${API}/production-analytics?preset=${p}`;
      if (p === 'custom' && dateFrom && dateTo) {
        url = `${API}/production-analytics?date_from=${dateFrom}&date_to=${dateTo}`;
      }
      const res = await fetch(url, { credentials: 'include' });
      if (res.ok) {
        const result = await res.json();
        setData(result);
      } else {
        toast.error(t('ceo_err_analytics'));
      }
    } catch {
      toast.error(t('ceo_err_connection'));
    } finally {
      setLoading(false);
    }
  };

  const handleExport = async (format) => {
    try {
      const filters = {};
      if (period === 'custom') {
        filters.date_from = dateFrom;
        filters.date_to = dateTo;
      } else {
        // Map presets to date ranges if needed, or backend handles it?
        // Actually the backend endpoint expects specific filter objects.
        // Let's pass the current preset if it's not custom, but the endpoint 
        // in production.py expects date_from/date_to in the filters body.
        const now = new Date();
        if (period === 'today') {
           filters.date_from = now.toISOString().split('T')[0];
           filters.date_to = now.toISOString().split('T')[0];
        } else if (period === 'week') {
           const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
           filters.date_from = weekAgo.toISOString().split('T')[0];
           filters.date_to = now.toISOString().split('T')[0];
        } else if (period === 'month') {
           const monthAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
           filters.date_from = monthAgo.toISOString().split('T')[0];
           filters.date_to = now.toISOString().split('T')[0];
        }
      }

      const res = await fetch(`${API}/production-report`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ 
          format, 
          preset: period === 'custom' ? undefined : period,
          filters: period === 'custom' ? { date_from: dateFrom, date_to: dateTo } : {}
        })
      });

      if (res.ok) {
        const { data, filename, content_type } = await res.json();
        const linkSource = `data:${content_type};base64,${data}`;
        const downloadLink = document.createElement("a");
        downloadLink.href = linkSource;
        downloadLink.download = filename;
        downloadLink.click();
        toast.success(t('ceo_report_gen').replace('{format}', format.toUpperCase()));
      } else {
        toast.error(t('ceo_err_report'));
      }
    } catch {
      toast.error(t('ceo_err_export'));
    }
  };

  useEffect(() => {
    fetchAnalytics();
  }, [period]);

  const stats = useMemo(() => {
    if (!data) return [];
    return [
      { 
        title: t('ceo_pieces_produced'), 
        value: data.total_produced.toLocaleString(), 
        subvalue: `${data.total_logs} ${t('ceo_records')}`, 
        icon: CheckCircle2, 
        color: 'emerald',
        description: t('ceo_desc_produced')
      },
      { 
        title: t('ceo_global_efficiency'), 
        value: `${data.efficiency}%`, 
        subvalue: t('ceo_vs_goal'), 
        icon: TrendingUp, 
        color: 'blue',
        description: t('ceo_desc_efficiency')
      },
      { 
        title: t('ceo_avg_setup'), 
        value: `${Math.round(data.avg_setup)} min`, 
        subvalue: t('ceo_per_labor'), 
        icon: Timer, 
        color: 'orange',
        description: t('ceo_desc_setup')
      },
      { 
        title: t('ceo_est_remaining'), 
        value: data.total_remaining.toLocaleString(), 
        subvalue: t('ceo_to_complete'), 
        icon: AlertCircle, 
        color: 'red',
        description: t('ceo_desc_remaining')
      }
    ];
  }, [data, t]);

  const trendChartData = useMemo(() => {
    if (!data?.trend_data) return [];
    return data.trend_data.map(h => {
      let label = h.label;
      if (data.granularity === 'hour') {
        // Extract hour from "YYYY-MM-DDTHH"
        label = h.label.split('T')[1] ? `${h.label.split('T')[1]}:00` : h.label;
      } else {
        // Use date "YYYY-MM-DD" but maybe format it
        label = h.label;
      }
      return {
        time: label,
        produced: h.produced
      };
    });
  }, [data]);

  if (loading && !data) {
    return (
      <div className="min-h-screen bg-background flex flex-col items-center justify-center gap-6">
        <Loader loading />
      </div>
    );
  }

  return (
    <div className={`min-h-screen font-barlow p-6 md:p-10 relative overflow-x-hidden transition-colors duration-500 custom-scrollbar ${
      isDark ? 'bg-[#050508]' : 'bg-[#f8fafc]'
    }`}>
      {/* Dynamic Background Effects */}
      <div className="fixed inset-0 overflow-hidden pointer-events-none z-0">
        <div className={`absolute top-[-10%] right-[-10%] w-[50%] h-[50%] blur-[150px] rounded-full animate-float-slow transition-all duration-1000 ${
          isDark ? 'bg-[#e94560]/10' : 'bg-emerald-400/10'
        }`} />
        <div className={`absolute bottom-[-5%] left-[-5%] w-[40%] h-[40%] blur-[120px] rounded-full animate-float-slower transition-all duration-1000 ${
          isDark ? 'bg-blue-600/10' : 'bg-emerald-300/5'
        }`} />
        <div className={`absolute inset-0 scanline opacity-[0.03] transition-opacity ${isDark ? '' : 'hidden'}`} />
      </div>

      <header className="mb-12 relative z-10">
        <div className="flex flex-col xl:flex-row xl:items-center justify-between gap-8">
          <div className="flex items-center gap-8">
            <button 
              onClick={() => navigate('/home')} 
              className={`p-4 rounded-2xl border transition-all group backdrop-blur-md ${
                isDark ? 'bg-white/5 hover:bg-white/10 border-white/10' : 'bg-white/60 hover:bg-white/80 border-emerald-500/10 shadow-sm'
              }`}
            >
              <ArrowLeft className={`w-6 h-6 transition-transform group-hover:-translate-x-1 ${isDark ? 'text-foreground' : 'text-emerald-900'}`} />
            </button>
            <div className="space-y-1">
              <div className="flex items-center gap-4">
                <div className={`p-2 rounded-lg ${isDark ? 'bg-[#e94560]/20' : 'bg-emerald-500/10'}`}>
                  <LayoutDashboard className={`w-5 h-5 ${isDark ? 'text-[#e94560]' : 'text-emerald-600'}`} />
                </div>
                <h1 className={`text-4xl font-black uppercase tracking-[-0.05em] ${isDark ? 'text-white' : 'text-emerald-950'}`}>
                  {t('ceo_exclusive_insights').split(' ')[0]} <span className={`text-transparent bg-clip-text bg-gradient-to-r ${isDark ? 'from-[#e94560] to-[#ff758c]' : 'from-emerald-600 to-emerald-400'}`}>{t('ceo_exclusive_insights').split(' ')[1]}</span>
                </h1>
              </div>
              <p className={`font-medium text-[11px] uppercase tracking-[0.3em] flex items-center gap-3 ${isDark ? 'text-muted-foreground/60' : 'text-emerald-800/40'}`}>
                {t('ceo_operations')} <span className={`w-1 h-1 rounded-full ${isDark ? 'bg-white/20' : 'bg-emerald-500/20'}`} /> 
                <span className={`font-black uppercase tracking-widest text-[9px] ${isDark ? 'text-[#e94560]/80' : 'text-emerald-600'}`}>{t('ceo_prosper_mfg')}</span> 
                <span className={`w-1 h-1 rounded-full ${isDark ? 'bg-white/20' : 'bg-emerald-500/20'}`} /> 
                <span className={`px-2 py-0.5 border rounded text-[9px] ${isDark ? 'border-[#e94560]/30 text-[#e94560]/80' : 'border-emerald-500/20 text-emerald-600'}`}>{t('ceo_read_only')}</span>
              </p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-6">
            <button
              onClick={toggleLang}
              className={`flex items-center gap-3 px-6 py-2.5 rounded-2xl border transition-all active:scale-95 group backdrop-blur-md ${
                isDark 
                  ? 'bg-white/5 hover:bg-white/10 border-white/10 text-white' 
                  : 'bg-white/60 hover:bg-white/80 border-emerald-500/10 text-emerald-900 shadow-sm'
              }`}
            >
              <div className={`p-1.5 rounded-lg transition-colors ${
                isDark ? 'group-hover:bg-[#e94560]/20' : 'group-hover:bg-emerald-500/10'
              }`}>
                <Languages className={`w-4 h-4 transition-transform group-hover:rotate-12 ${isDark ? 'text-[#e94560]' : 'text-emerald-600'}`} />
              </div>
              <span className="text-[10px] font-black uppercase tracking-widest">
                {lang === 'es' ? 'English' : 'Español'}
              </span>
            </button>
            <ThemeSwitch />
            <div className={`flex flex-wrap items-center gap-4 p-2 rounded-3xl border backdrop-blur-xl ${
              isDark ? 'bg-white/5 border-white/10' : 'bg-white/60 border-emerald-500/10 shadow-sm'
            }`}>
              <div className={`flex items-center gap-1 p-1 rounded-2xl border ${isDark ? 'bg-black/40 border-white/5' : 'bg-emerald-500/5 border-emerald-500/10'}`}>
                {['today', 'week', 'month'].map((p) => (
                  <button
                    key={p}
                    onClick={() => { setPeriod(p); setDateFrom(''); setDateTo(''); }}
                    className={`px-6 py-2.5 rounded-xl text-[10px] font-black uppercase tracking-[0.1em] transition-all duration-300 ${
                      period === p 
                        ? (isDark ? 'bg-[#e94560] text-white shadow-[0_10px_20px_-5px_rgba(233,69,96,0.4)]' : 'bg-emerald-500 text-white shadow-[0_10px_20px_-5px_rgba(16,185,129,0.3)]')
                        : (isDark ? 'text-muted-foreground hover:text-white' : 'text-emerald-700/60 hover:text-emerald-700')
                    }`}
                  >
                    {p === 'today' ? t('ceo_today') : p === 'week' ? t('ceo_week') : t('ceo_month')}
                  </button>
                ))}
              </div>
              
              <div className={`flex items-center gap-3 px-4 border-l ${isDark ? 'border-white/10' : 'border-emerald-500/10'}`}>
                <div className="flex items-center gap-2">
                  <input 
                    type="date" 
                    value={dateFrom} 
                    onChange={(e) => { setDateFrom(e.target.value); setPeriod('custom'); }}
                    className={`border rounded-xl px-3 py-2 text-[10px] uppercase outline-none transition-colors ${
                      isDark ? 'bg-white/5 border-white/10 text-white focus:border-[#e94560]/50' : 'bg-emerald-500/5 border-emerald-500/10 text-emerald-900 focus:border-emerald-500/40'
                    }`}
                  />
                  <span className="text-[10px] font-black opacity-30">{t('ceo_to')}</span>
                  <input 
                    type="date" 
                    value={dateTo} 
                    onChange={(e) => { setDateTo(e.target.value); setPeriod('custom'); }}
                    className={`border rounded-xl px-3 py-2 text-[10px] uppercase outline-none transition-colors ${
                      isDark ? 'bg-white/5 border-white/10 text-white focus:border-[#e94560]/50' : 'bg-emerald-500/5 border-emerald-500/10 text-emerald-900 focus:border-emerald-500/40'
                    }`}
                  />
                </div>
                {(dateFrom && dateTo) && (
                  <button 
                    onClick={() => fetchAnalytics('custom')}
                    className={`p-2.5 rounded-xl transition-all ${
                      isDark 
                        ? (period === 'custom' ? 'bg-[#e94560] text-white' : 'bg-[#e94560]/10 text-[#e94560] hover:bg-[#e94560]/20') 
                        : (period === 'custom' ? 'bg-emerald-500 text-white' : 'bg-emerald-500/10 text-emerald-600 hover:bg-emerald-500/20')
                    }`}
                  >
                    <Calendar className="w-4 h-4" />
                  </button>
                )}
              </div>

              <div className="flex items-center gap-2 border-l border-white/10 pl-4 pr-2">
                <button 
                  onClick={() => handleExport('excel')}
                  className={`flex items-center gap-2 px-4 py-2.5 border transition-all rounded-xl text-[10px] font-black uppercase tracking-[0.1em] ${
                    isDark ? 'bg-emerald-500/10 hover:bg-emerald-500/20 text-emerald-500 border-emerald-500/20' : 'bg-emerald-100 hover:bg-emerald-200 text-emerald-700 border-emerald-500/10'
                  }`}
                >
                  <Download className="w-3.5 h-3.5" /> {t('ceo_excel')}
                </button>
                <button 
                  onClick={() => handleExport('pdf')}
                  className={`flex items-center gap-2 px-4 py-2.5 border transition-all rounded-xl text-[10px] font-black uppercase tracking-[0.1em] ${
                    isDark ? 'bg-[#e94560]/10 hover:bg-[#e94560]/20 text-[#e94560] border-[#e94560]/20' : 'bg-emerald-700 hover:bg-emerald-800 text-white border-transparent'
                  }`}
                >
                  <Download className="w-3.5 h-3.5" /> {t('ceo_pdf')}
                </button>
              </div>
            </div>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <div className="relative z-10 space-y-8">
        {/* Stat Cards */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
          {stats.map((stat, i) => (
            <StatCard key={i} {...stat} />
          ))}
        </div>

        <div className="grid grid-cols-1 xl:grid-cols-12 gap-8">
          {/* Main Production Chart */}
          <div className={`xl:col-span-8 backdrop-blur-3xl border rounded-[40px] p-10 shadow-2xl relative overflow-hidden group transition-all duration-500 ${
            isDark ? 'bg-gradient-to-br from-card/80 to-card/40 border-white/5' : 'bg-white/90 border-emerald-500/10'
          }`}>
            <div className={`absolute top-0 left-0 w-full h-1 bg-gradient-to-r from-transparent via-${isDark ? '[#e94560]' : 'emerald-500'}/30 to-transparent`} />
            <div className="flex items-center justify-between mb-10">
              <div className="flex items-center gap-4">
                <div className={`w-1.5 h-10 rounded-full shadow-lg ${isDark ? 'bg-gradient-to-b from-[#e94560] to-[#ff758c] shadow-[#e94560]/50' : 'bg-gradient-to-b from-emerald-600 to-emerald-400 shadow-emerald-500/30'}`} />
                <div>
                  <h2 className={`text-2xl font-black uppercase tracking-[-0.02em] ${isDark ? 'text-white' : 'text-emerald-950'}`}>{t('ceo_production_trend')}</h2>
                  <p className={`text-[10px] font-black uppercase tracking-[0.4em] mt-1 ${isDark ? 'text-muted-foreground/40' : 'text-emerald-800/20'}`}>{t('ceo_industrial_engine')}</p>
                </div>
              </div>
              <div className={`flex items-center gap-2 text-[10px] font-black uppercase tracking-widest px-4 py-2 rounded-xl border ${
                isDark ? 'text-[#e94560] bg-[#e94560]/10 border-[#e94560]/20' : 'text-emerald-600 bg-emerald-500/5 border-emerald-500/10'
              }`}>
                <TrendingUp className="w-3 h-3" /> {data.granularity === 'hour' ? t('ceo_units_hour') : t('ceo_units_day')}
              </div>
            </div>
            
            <div className="h-[420px] w-full mt-4">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={trendChartData}>
                  <defs>
                    <linearGradient id="colorProd" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor={isDark ? '#e94560' : '#10b981'} stopOpacity={0.4}/>
                      <stop offset="95%" stopColor={isDark ? '#e94560' : '#10b981'} stopOpacity={0}/>
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke={isDark ? "#ffffff05" : "#00000005"} vertical={false} />
                  <XAxis 
                    dataKey="time" 
                    stroke={isDark ? "#ffffff20" : "#10b98120"} 
                    fontSize={10} 
                    axisLine={false} 
                    tickLine={false}
                    tick={{fill: isDark ? '#ffffff40' : '#064e3b60', fontWeight: 'bold'}}
                  />
                  <YAxis 
                    stroke={isDark ? "#ffffff20" : "#10b98120"} 
                    fontSize={10} 
                    axisLine={false} 
                    tickLine={false}
                    tick={{fill: isDark ? '#ffffff40' : '#064e3b60', fontWeight: 'bold'}}
                  />
                  <Tooltip 
                    contentStyle={{ 
                      backgroundColor: isDark ? 'rgba(5, 5, 8, 0.95)' : 'rgba(255, 255, 255, 0.95)', 
                      borderColor: isDark ? 'rgba(233, 69, 96, 0.3)' : 'rgba(16, 185, 129, 0.2)', 
                      borderRadius: '24px', 
                      fontSize: '12px',
                      backdropFilter: 'blur(20px)',
                      borderWidth: '1px',
                      boxShadow: '0 20px 40px rgba(0,0,0,0.1)'
                    }}
                    itemStyle={{ color: isDark ? '#e94560' : '#059669', fontWeight: 'bold' }}
                    labelStyle={{ color: isDark ? '#fff' : '#064e3b', marginBottom: '8px', opacity: 0.5, fontSize: '10px', textTransform: 'uppercase', letterSpacing: '1px' }}
                  />
                  <Area 
                    type="monotone" 
                    dataKey="produced" 
                    stroke={isDark ? "#e94560" : "#10b981"} 
                    strokeWidth={4} 
                    fillOpacity={1} 
                    fill="url(#colorProd)"
                    animationDuration={2000}
                  />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          </div>

          {/* Efficiency by Machine */}
          <div className={`xl:col-span-4 backdrop-blur-3xl border rounded-[40px] p-10 shadow-2xl relative overflow-hidden transition-all duration-500 ${
            isDark ? 'bg-gradient-to-br from-card/80 to-card/40 border-white/5' : 'bg-white/90 border-emerald-500/10'
          }`}>
             <div className="absolute top-0 right-0 p-4 opacity-5">
               <Cpu className={`w-32 h-32 ${isDark ? 'text-white' : 'text-emerald-900'}`} />
             </div>
            <div className="flex items-center gap-4 mb-10">
              <div className={`p-3 rounded-2xl border ${isDark ? 'bg-blue-500/10 border-blue-500/20' : 'bg-emerald-500/10 border-emerald-500/20'}`}>
                <Cpu className={`w-6 h-6 ${isDark ? 'text-blue-500 text-glow-blue' : 'text-emerald-600'}`} />
              </div>
              <div>
                <h2 className={`text-2xl font-black uppercase tracking-[-0.02em] ${isDark ? 'text-white' : 'text-emerald-950'}`}>{t('ceo_machine_load')}</h2>
                <p className={`text-[10px] font-black uppercase tracking-[0.4em] mt-1 ${isDark ? 'text-muted-foreground/40' : 'text-emerald-800/20'}`}>{t('ceo_plant_resource')}</p>
              </div>
            </div>
            
            <div className="space-y-8 max-h-[420px] overflow-y-auto pr-2 custom-scrollbar">
              {data?.by_machine.map((m, i) => (
                <div key={i} className="space-y-3 group/item">
                  <div className="flex justify-between text-[11px] font-black uppercase tracking-widest">
                    <span className={`${isDark ? 'text-white/60 group-hover/item:text-white' : 'text-emerald-900/60 group-hover/item:text-emerald-950'} transition-colors`}>{m.machine.replace(/MAQUINA/gi, t('ceo_machine_label'))}</span>
                    <span className={`${isDark ? 'text-blue-400' : 'text-emerald-600'} group-hover/item:scale-110 transition-transform`}>{m.produced.toLocaleString()} <span className="text-[9px] opacity-40 ml-0.5">{t('ceo_unit_short')}</span></span>
                  </div>
                  <div className={`h-2 w-full rounded-full overflow-hidden border p-[1px] ${isDark ? 'bg-white/5 border-white/5' : 'bg-emerald-500/5 border-emerald-500/10'}`}>
                    <div 
                      className={`h-full rounded-full transition-all duration-1000 relative ${
                        isDark ? 'bg-gradient-to-r from-blue-600 to-blue-400 shadow-[0_0_15px_rgba(59,130,246,0.3)]' : 'bg-gradient-to-r from-emerald-600 to-emerald-400 shadow-[0_0_15px_rgba(16,185,129,0.2)]'
                      }`}
                      style={{ width: `${Math.min(100, (m.produced / (data.total_produced / 3)) * 100)}%` }}
                    >
                       <div className="absolute inset-x-0 top-0 h-[30%] bg-white/20" />
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
          {/* Top Clients */}
          <div className={`backdrop-blur-3xl border rounded-[40px] p-10 shadow-2xl relative overflow-hidden group transition-all duration-500 ${
            isDark ? 'bg-gradient-to-br from-card/80 to-card/40 border-white/5' : 'bg-white/90 border-emerald-500/10'
          }`}>
            <div className="flex items-center gap-4 mb-10">
              <div className={`p-3 rounded-2xl border ${isDark ? 'bg-emerald-500/10 border-emerald-500/20' : 'bg-emerald-500/10 border-emerald-500/20'}`}>
                <Layers className={`w-6 h-6 ${isDark ? 'text-emerald-500 text-glow-emerald' : 'text-emerald-600'}`} />
              </div>
              <div>
                <h2 className={`text-2xl font-black uppercase tracking-[-0.02em] ${isDark ? 'text-white' : 'text-emerald-950'}`}>{t('ceo_top_clients')}</h2>
                <p className={`text-[10px] font-black uppercase tracking-[0.4em] mt-1 ${isDark ? 'text-muted-foreground/40' : 'text-emerald-800/20'}`}>{t('ceo_client_impact')}</p>
              </div>
            </div>
            <div className="h-[320px] w-full mt-4">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={data?.by_client.slice(0, 7)}>
                  <CartesianGrid strokeDasharray="3 3" stroke={isDark ? "#ffffff05" : "#00000005"} vertical={false} />
                  <XAxis 
                    dataKey="client" 
                    stroke={isDark ? "#ffffff20" : "#10b98120"} 
                    fontSize={9} 
                    axisLine={false} 
                    tickLine={false}
                    tick={{fill: isDark ? '#ffffff40' : '#064e3b60', fontWeight: 'bold'}}
                  />
                  <YAxis 
                    stroke={isDark ? "#ffffff20" : "#10b98120"} 
                    fontSize={9} 
                    axisLine={false} 
                    tickLine={false}
                    tick={{fill: isDark ? '#ffffff40' : '#064e3b60', fontWeight: 'bold'}}
                  />
                  <Tooltip 
                    cursor={{fill: isDark ? 'rgba(255,255,255,0.03)' : 'rgba(16,185,129,0.03)'}}
                    contentStyle={{ 
                      backgroundColor: isDark ? 'rgba(5, 5, 8, 0.95)' : 'rgba(255, 255, 255, 0.95)', 
                      borderColor: isDark ? 'rgba(233, 69, 96, 0.3)' : 'rgba(16, 185, 129, 0.2)', 
                      borderRadius: '20px', 
                      fontSize: '11px',
                      backdropFilter: 'blur(20px)',
                      boxShadow: '0 20px 40px rgba(0,0,0,0.1)'
                    }}
                    labelStyle={{ color: isDark ? '#fff' : '#064e3b', fontWeight: 'bold', marginBottom: '4px' }}
                  />
                  <Bar dataKey="produced" radius={[10, 10, 0, 0]} barSize={40}>
                    {data?.by_client.map((_, i) => (
                      <Cell key={i} fill={CHART_COLORS[i % CHART_COLORS.length]} fillOpacity={0.8} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>

          {/* Distribution by Shift */}
          <div className={`backdrop-blur-3xl border rounded-[40px] p-10 shadow-2xl relative overflow-hidden group transition-all duration-500 ${
            isDark ? 'bg-gradient-to-br from-card/80 to-card/40 border-white/5' : 'bg-white/90 border-emerald-500/10'
          }`}>
            <div className="flex items-center gap-4 mb-10">
              <div className={`p-3 rounded-2xl border ${isDark ? 'bg-orange-500/10 border-orange-500/20' : 'bg-emerald-500/10 border-emerald-500/20'}`}>
                <Calendar className={`w-6 h-6 ${isDark ? 'text-orange-500 text-glow-orange' : 'text-emerald-600'}`} />
              </div>
              <div>
                <h2 className={`text-2xl font-black uppercase tracking-[-0.02em] ${isDark ? 'text-white' : 'text-emerald-950'}`}>{t('ceo_shifts')}</h2>
                <p className={`text-[10px] font-black uppercase tracking-[0.4em] mt-1 ${isDark ? 'text-muted-foreground/40' : 'text-emerald-800/20'}`}>{t('ceo_shift_balance')}</p>
              </div>
            </div>
            <div className="h-[320px] w-full mt-4 flex items-center justify-center">
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie
                    data={data?.by_shift}
                    cx="50%"
                    cy="50%"
                    innerRadius={70}
                    outerRadius={100}
                    paddingAngle={8}
                    dataKey="produced"
                    stroke="none"
                  >
                    {data?.by_shift.map((_, index) => (
                      <Cell 
                        key={`cell-${index}`} 
                        fill={CHART_COLORS[index % CHART_COLORS.length]} 
                        className="hover:opacity-80 transition-opacity cursor-pointer"
                      />
                    ))}
                  </Pie>
                  <Tooltip 
                     contentStyle={{ 
                       backgroundColor: isDark ? 'rgba(5, 5, 8, 0.95)' : 'rgba(255, 255, 255, 0.95)', 
                       borderColor: isDark ? 'rgba(233, 69, 96, 0.3)' : 'rgba(16, 185, 129, 0.2)', 
                       borderRadius: '20px', 
                       fontSize: '11px',
                       backdropFilter: 'blur(20px)',
                       boxShadow: '0 20px 40px rgba(0,0,0,0.1)'
                     }}
                     labelStyle={{ display: 'none' }}
                  />
                  <Legend 
                    verticalAlign="bottom" 
                    height={36} 
                    iconType="circle"
                    formatter={(val) => {
                      const shiftKeys = {
                        'Mañana': 'ceo_shift_morning',
                        'Tarde': 'ceo_shift_afternoon',
                        'Noche': 'ceo_shift_night',
                        'Morning': 'ceo_shift_morning',
                        'Afternoon': 'ceo_shift_afternoon',
                        'Night': 'ceo_shift_night'
                      };
                      return <span className={`text-[10px] font-black uppercase tracking-wider ${isDark ? 'text-white/40' : 'text-emerald-800/40'}`}>{t(shiftKeys[val] || val)}</span>
                    }}
                  />
                </PieChart>
              </ResponsiveContainer>
            </div>
          </div>
        </div>
      </div>

      <footer className="mt-16 pt-8 border-t border-border/30 text-center relative z-10 transition-colors duration-500">
        <p className="text-[10px] font-black uppercase tracking-[0.5em] text-muted-foreground/30 italic">
          {t('ceo_footer')}
        </p>
      </footer>
    </div>
  );
};

const Loader = ({ loading }) => {
  const { theme } = useTheme();
  const { t } = useLang();
  const isDark = theme === 'dark';
  if (!loading) return null;
  
  return (
    <div className="flex flex-col items-center gap-8 translate-y-[-20%]">
      <div className="relative">
        <div className={`w-24 h-24 border-2 rounded-full ${isDark ? 'border-white/5' : 'border-emerald-500/10'}`} />
        <div className={`absolute inset-0 w-24 h-24 border-t-4 rounded-full animate-spin ${
          isDark ? 'border-[#e94560] shadow-[0_0_20px_rgba(233,69,96,0.5)]' : 'border-emerald-500 shadow-[0_0_20px_rgba(16,185,129,0.3)]'
        }`} />
        <Factory className={`absolute inset-0 m-auto w-8 h-8 animate-pulse ${isDark ? 'text-[#e94560]' : 'text-emerald-600'}`} />
      </div>
      <div className="space-y-2 text-center">
        <p className={`text-sm font-black uppercase tracking-[0.5em] animate-pulse ${isDark ? 'text-white' : 'text-emerald-950'}`}>
          {t('ceo_syncing')}
        </p>
      </div>
    </div>
  );
};

export default CEODashboard;
