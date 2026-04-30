import { useState, useEffect, useCallback } from "react";
import { useLang } from "../contexts/LanguageContext";
import { X, Loader2, Download, FileText, Filter, RefreshCw, Factory, TrendingUp, Clock, Users, BarChart3, Target, Package, ListChecks } from "lucide-react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";
import { toast } from "sonner";
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, PieChart, Pie, Cell, LineChart, Line, Legend } from "recharts";

const BACKEND_URL = process.env.REACT_APP_BACKEND_URL;
const API = `${BACKEND_URL}/api`;
const COLORS = ['#8b5cf6', '#06b6d4', '#f59e0b', '#ef4444', '#10b981', '#ec4899', '#3b82f6', '#f97316', '#14b8a6', '#a855f7', '#84cc16', '#e11d48', '#0ea5e9', '#d946ef'];
const PRESETS = [
  { value: 'today', label: 'Hoy' }, { value: 'yesterday', label: 'Ayer' },
  { value: 'week', label: 'Ultima semana' }, { value: 'month', label: 'Ultimo mes' },
  { value: 'custom', label: 'Rango personalizado' }
];

const ProductionScreen = ({ onClose, isDark = true }) => {
  const { t, lang } = useLang();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [preset, setPreset] = useState('today');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [filterMachine, setFilterMachine] = useState('');
  const [filterOperator, setFilterOperator] = useState('');
  const [filterClient, setFilterClient] = useState('');
  const [filterOrder, setFilterOrder] = useState('');
  const [activeChart, setActiveChart] = useState('machine');
  const [reportDate, setReportDate] = useState('');
  const [reportShift, setReportShift] = useState('');
  const [reportSupervisor, setReportSupervisor] = useState('');
  const [reportLoading, setReportLoading] = useState(false);

  const fetchAnalytics = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (preset !== 'custom') params.set('preset', preset);
      else { if (dateFrom) params.set('date_from', dateFrom); if (dateTo) params.set('date_to', dateTo); }
      if (filterMachine) params.set('machine', filterMachine);
      if (filterOperator) params.set('operator', filterOperator);
      if (filterClient) params.set('client', filterClient);
      if (filterOrder) params.set('order_number', filterOrder);
      const res = await fetch(`${API}/production-analytics?${params}`, { credentials: 'include' });
      if (res.ok) setData(await res.json());
    } catch { toast.error('Error cargando analytics'); } finally { setLoading(false); }
  }, [preset, dateFrom, dateTo, filterMachine, filterOperator, filterClient, filterOrder]);

  useEffect(() => { fetchAnalytics(); }, [fetchAnalytics]);

  const generateReport = async (format) => {
    setReportLoading(true);
    try {
      const filters = {};
      let backendPreset = undefined;
      if (reportDate) { filters.date_from = reportDate; filters.date_to = reportDate; }
      else if (preset !== 'custom') {
        backendPreset = preset; // let backend apply timezone-correct day boundaries
      } else { if (dateFrom) filters.date_from = dateFrom; if (dateTo) filters.date_to = dateTo; }
      if (reportShift) filters.shift = reportShift;
      if (reportSupervisor) filters.supervisor = reportSupervisor;
      if (filterMachine) filters.machine = filterMachine;
      const res = await fetch(`${API}/production-report`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include', body: JSON.stringify({ format, preset: backendPreset, filters }) });
      if (res.ok) {
        const result = await res.json();
        const byteChars = atob(result.data);
        const byteArray = new Uint8Array(byteChars.length);
        for (let i = 0; i < byteChars.length; i++) byteArray[i] = byteChars.charCodeAt(i);
        const blob = new Blob([byteArray], { type: result.content_type });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = result.filename;
        a.style.display = 'none';
        document.body.appendChild(a);
        a.click();
        setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(url); }, 100);
        toast.success(`Reporte ${format.toUpperCase()} descargado`);
      } else {
        const err = await res.json().catch(() => ({}));
        toast.error(err.detail || 'Error generando reporte');
      }
    } catch (e) { toast.error('Error generando reporte: ' + (e.message || '')); } finally { setReportLoading(false); }
  };

  const chartData = {
    machine: (data?.by_machine || []).map(m => ({ name: m.machine.replace('MAQUINA', 'M'), produced: m.produced, setup: m.avg_setup })),
    operator: (data?.by_operator || []).slice(0, 12).map(o => ({ name: o.operator.split(' ')[0] || '?', produced: o.produced, count: o.count })),
    shift: (data?.by_shift || []).map(s => ({ name: s.shift || 'N/A', produced: s.produced, count: s.count })),
    client: (data?.by_client || []).slice(0, 10).map(c => ({ name: (c.client || '?').substring(0, 12), produced: c.produced })),
    po: (data?.by_po || []).slice(0, 12).map(p => ({ name: p.order_number || '?', produced: p.produced, target: p.target })),
    hourly: (data?.hourly_trend || []).map(h => ({ name: h.hour.slice(11, 16) || h.hour.slice(5), produced: h.produced })),
    setup: (data?.by_machine || []).map(m => ({ name: m.machine.replace('MAQUINA', 'M'), setup: m.avg_setup }))
  };

  const charts = [
    { key: 'machine', label: 'Por Maquina', icon: Factory },
    { key: 'operator', label: 'Por Operador', icon: Users },
    { key: 'shift', label: 'Por Turno', icon: Clock },
    { key: 'client', label: 'Por Cliente', icon: BarChart3 },
    { key: 'po', label: 'Por PO', icon: Target },
    { key: 'hourly', label: 'Tendencia Horaria', icon: TrendingUp },
    { key: 'setup', label: 'Setup por Maquina', icon: Clock }
  ];

  return (
    <div className={`fixed inset-0 z-50 flex flex-col ${isDark ? 'bg-[#0a0a14] text-white' : 'bg-gray-50 text-gray-900'}`}>
      {/* Header */}
      <div className={`px-4 py-3 border-b flex items-center justify-between ${isDark ? 'border-zinc-800 bg-[#12121e]' : 'border-gray-200 bg-white'}`}>
        <div className="flex items-center gap-3">
          <Factory className="w-5 h-5 text-primary" />
          <span className="font-barlow font-black text-lg uppercase tracking-wider">Production Monitor</span>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={fetchAnalytics} className="p-1.5 rounded hover:bg-secondary" data-testid="refresh-analytics"><RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} /></button>
          <button onClick={onClose} className="p-1.5 rounded hover:bg-secondary"><X className="w-4 h-4" /></button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {/* Filters */}
        <div className={`rounded-lg border p-3 ${isDark ? 'bg-zinc-900/50 border-zinc-800' : 'bg-white border-gray-200'}`} data-testid="analytics-filters">
          <div className="flex items-center gap-2 mb-2"><Filter className="w-4 h-4 text-primary" /><span className="text-xs uppercase tracking-wider font-bold text-muted-foreground">Filtros</span></div>
          <div className="grid grid-cols-6 gap-2">
            <Select value={preset} onValueChange={setPreset}>
              <SelectTrigger className="h-8 text-xs bg-secondary border-border" data-testid="preset-select"><SelectValue /></SelectTrigger>
              <SelectContent className="bg-popover border-border z-[1001]">{PRESETS.map(p => <SelectItem key={p.value} value={p.value}>{p.label}</SelectItem>)}</SelectContent>
            </Select>
            {preset === 'custom' && <>
              <input type="date" value={dateFrom} onChange={e => setDateFrom(e.target.value)} className="h-8 text-xs px-2 bg-secondary border border-border rounded text-foreground" data-testid="date-from" />
              <input type="date" value={dateTo} onChange={e => setDateTo(e.target.value)} className="h-8 text-xs px-2 bg-secondary border border-border rounded text-foreground" data-testid="date-to" />
            </>}
            <Select value={filterMachine || 'all'} onValueChange={v => setFilterMachine(v === 'all' ? '' : v)}>
              <SelectTrigger className="h-8 text-xs bg-secondary border-border" data-testid="filter-machine"><SelectValue placeholder="Maquina" /></SelectTrigger>
              <SelectContent className="bg-popover border-border z-[1001]"><SelectItem value="all">Todas</SelectItem>{(data?.filters?.machines || []).map(m => <SelectItem key={m} value={m}>{m}</SelectItem>)}</SelectContent>
            </Select>
            <input type="text" value={filterOperator} onChange={e => setFilterOperator(e.target.value)} placeholder="Operador" className="h-8 text-xs px-2 bg-secondary border border-border rounded text-foreground" data-testid="filter-operator" />
            <input type="text" value={filterOrder} onChange={e => setFilterOrder(e.target.value)} placeholder="Orden" className="h-8 text-xs px-2 bg-secondary border border-border rounded text-foreground" data-testid="filter-order" />
          </div>
        </div>

        {/* Metrics */}
        <div className="grid grid-cols-6 gap-3">
          {[
            { label: 'Total Producido', value: data?.total_produced || 0, color: 'text-primary', bg: 'bg-primary/10 border-primary/20' },
            { label: 'Meta Total', value: data?.total_target || 0, color: 'text-foreground', bg: 'bg-secondary/50 border-border' },
            { label: 'Restantes', value: data?.total_remaining || 0, color: (data?.total_remaining || 0) > 0 ? 'text-orange-400' : 'text-green-400', bg: 'bg-orange-500/10 border-orange-500/20' },
            { label: 'Eficiencia', value: `${data?.efficiency || 0}%`, color: (data?.efficiency || 0) >= 80 ? 'text-green-400' : 'text-yellow-400', bg: 'bg-secondary/50 border-border' },
            { label: 'Setup Promedio', value: data?.avg_setup || 0, color: 'text-foreground', bg: 'bg-secondary/50 border-border' },
            { label: 'Registros', value: data?.total_logs || 0, color: 'text-foreground', bg: 'bg-secondary/50 border-border' }
          ].map((m, i) => (
            <div key={i} className={`rounded-lg border p-3 text-center ${m.bg}`} data-testid={`metric-${i}`}>
              <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-bold">{m.label}</p>
              <p className={`text-2xl font-bold font-mono ${m.color}`}>{typeof m.value === 'number' ? m.value.toLocaleString() : m.value}</p>
            </div>
          ))}
        </div>

        {/* Production Status Breakdown */}
        {(data?.by_production_status || []).length > 0 && (
          <div className={`rounded-lg border ${isDark ? 'bg-zinc-900/50 border-zinc-800' : 'bg-white border-gray-200'}`} data-testid="production-status-breakdown">
            <div className="p-3 border-b border-border flex items-center gap-2">
              <ListChecks className="w-4 h-4 text-primary" />
              <span className="text-xs uppercase tracking-wider font-bold text-muted-foreground">Piezas por Estado de Produccion</span>
            </div>
            <div className="p-3 grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2">
              {(data?.by_production_status || []).map((ps, i) => (
                <div key={ps.status} className="flex items-center justify-between gap-2 px-3 py-2 rounded-lg border border-border/50 bg-secondary/20" data-testid={`prod-status-${i}`}>
                  <div className="flex items-center gap-2 min-w-0">
                    <div className="w-2 h-2 rounded-full flex-shrink-0" style={{ backgroundColor: COLORS[i % COLORS.length] }}></div>
                    <span className="text-sm text-foreground truncate">{ps.status}</span>
                  </div>
                  <div className="flex flex-col items-end flex-shrink-0">
                    <span className="text-sm font-bold font-mono text-foreground">{ps.quantity.toLocaleString()}</span>
                    <span className="text-[10px] text-muted-foreground">{ps.count} ordenes</span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Chart tabs + chart */}
        <div className={`rounded-lg border ${isDark ? 'bg-zinc-900/50 border-zinc-800' : 'bg-white border-gray-200'}`}>
          <div className="flex items-center gap-1 p-2 border-b border-border overflow-x-auto">
            {charts.map(c => (
              <button key={c.key} onClick={() => setActiveChart(c.key)}
                className={`flex items-center gap-1 px-3 py-1.5 rounded text-xs font-medium whitespace-nowrap transition-colors ${activeChart === c.key ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-secondary'}`}
                data-testid={`chart-tab-${c.key}`}>
                <c.icon className="w-3.5 h-3.5" /> {c.label}
              </button>
            ))}
          </div>
          <div className="p-4 h-80" data-testid="chart-container">
            {loading ? <div className="flex items-center justify-center h-full"><Loader2 className="w-6 h-6 animate-spin text-primary" /></div> :
              chartData[activeChart]?.length > 0 ? (
                activeChart === 'hourly' ? (
                  <ResponsiveContainer width="100%" height="100%" minWidth={0}>
                    <LineChart data={chartData.hourly}><CartesianGrid strokeDasharray="3 3" stroke={isDark ? '#333' : '#eee'} /><XAxis dataKey="name" tick={{ fontSize: 10, fill: isDark ? '#999' : '#666' }} /><YAxis tick={{ fontSize: 10, fill: isDark ? '#999' : '#666' }} /><Tooltip contentStyle={{ background: isDark ? '#1a1a2e' : '#fff', border: '1px solid #333', borderRadius: 8 }} /><Line type="monotone" dataKey="produced" stroke="#8b5cf6" strokeWidth={2} dot={{ fill: '#8b5cf6' }} /></LineChart>
                  </ResponsiveContainer>
                ) : activeChart === 'shift' ? (
                  <ResponsiveContainer width="100%" height="100%" minWidth={0}>
                    <PieChart><Pie data={chartData.shift} dataKey="produced" nameKey="name" cx="50%" cy="50%" outerRadius={100} label={({ name, produced }) => `${name}: ${produced}`}>{chartData.shift.map((_, i) => <Cell key={i} fill={COLORS[i % COLORS.length]} />)}</Pie><Tooltip /><Legend /></PieChart>
                  </ResponsiveContainer>
                ) : activeChart === 'po' ? (
                  <ResponsiveContainer width="100%" height="100%" minWidth={0}>
                    <BarChart data={chartData.po} layout="vertical"><CartesianGrid strokeDasharray="3 3" stroke={isDark ? '#333' : '#eee'} /><XAxis type="number" tick={{ fontSize: 10, fill: isDark ? '#999' : '#666' }} /><YAxis dataKey="name" type="category" width={80} tick={{ fontSize: 9, fill: isDark ? '#999' : '#666' }} /><Tooltip contentStyle={{ background: isDark ? '#1a1a2e' : '#fff', border: '1px solid #333', borderRadius: 8 }} /><Bar dataKey="produced" fill="#8b5cf6" radius={[0, 4, 4, 0]} /><Bar dataKey="target" fill="#333" radius={[0, 4, 4, 0]} opacity={0.3} /></BarChart>
                  </ResponsiveContainer>
                ) : (
                  <ResponsiveContainer width="100%" height="100%" minWidth={0}>
                    <BarChart data={chartData[activeChart]}><CartesianGrid strokeDasharray="3 3" stroke={isDark ? '#333' : '#eee'} /><XAxis dataKey="name" tick={{ fontSize: 10, fill: isDark ? '#999' : '#666' }} /><YAxis tick={{ fontSize: 10, fill: isDark ? '#999' : '#666' }} /><Tooltip contentStyle={{ background: isDark ? '#1a1a2e' : '#fff', border: '1px solid #333', borderRadius: 8 }} />{activeChart === 'setup' ? <Bar dataKey="setup" fill="#f59e0b" radius={[4, 4, 0, 0]} /> : <Bar dataKey="produced" fill="#8b5cf6" radius={[4, 4, 0, 0]} />}{activeChart === 'machine' && <Bar dataKey="setup" fill="#f59e0b" radius={[4, 4, 0, 0]} />}</BarChart>
                  </ResponsiveContainer>
                )
              ) : <div className="flex items-center justify-center h-full text-muted-foreground text-sm">Sin datos para mostrar</div>
            }
          </div>
        </div>

        {/* Reports Section */}
        <div className={`rounded-lg border p-4 ${isDark ? 'bg-zinc-900/50 border-zinc-800' : 'bg-white border-gray-200'}`} data-testid="reports-section">
          <h3 className="text-xs uppercase tracking-wider font-bold text-muted-foreground mb-3 flex items-center gap-1"><FileText className="w-4 h-4" /> Generar Reporte</h3>
          <div className="grid grid-cols-5 gap-2 mb-3">
            <input type="date" value={reportDate} onChange={e => setReportDate(e.target.value)} className="h-8 text-xs px-2 bg-secondary border border-border rounded text-foreground" placeholder="Fecha" data-testid="report-date" />
            <Select value={reportShift || 'all'} onValueChange={v => setReportShift(v === 'all' ? '' : v)}>
              <SelectTrigger className="h-8 text-xs bg-secondary border-border" data-testid="report-shift"><SelectValue placeholder="Turno" /></SelectTrigger>
              <SelectContent className="bg-popover border-border z-[1001]"><SelectItem value="all">Todos los turnos</SelectItem><SelectItem value="TURNO 1">TURNO 1</SelectItem><SelectItem value="TURNO 2">TURNO 2</SelectItem><SelectItem value="TURNO 3">TURNO 3</SelectItem></SelectContent>
            </Select>
            <input type="text" value={reportSupervisor} onChange={e => setReportSupervisor(e.target.value)} placeholder="Supervisor" className="h-8 text-xs px-2 bg-secondary border border-border rounded text-foreground" data-testid="report-supervisor" />
            <button onClick={() => generateReport('excel')} disabled={reportLoading} className="h-8 px-3 text-xs bg-green-600 text-white rounded hover:bg-green-700 disabled:opacity-50 flex items-center justify-center gap-1" data-testid="report-excel-btn">
              {reportLoading ? <Loader2 className="w-3 h-3 animate-spin" /> : <Download className="w-3 h-3" />} Excel
            </button>
            <button onClick={() => generateReport('pdf')} disabled={reportLoading} className="h-8 px-3 text-xs bg-red-600 text-white rounded hover:bg-red-700 disabled:opacity-50 flex items-center justify-center gap-1" data-testid="report-pdf-btn">
              {reportLoading ? <Loader2 className="w-3 h-3 animate-spin" /> : <FileText className="w-3 h-3" />} PDF
            </button>
          </div>
          <p className="text-[10px] text-muted-foreground">Si no seleccionas fecha, se usa el filtro activo. Reporte parcial: usa "Hoy" para el turno actual.</p>
        </div>

        {/* Recent Logs Table */}
        <div className={`rounded-lg border ${isDark ? 'bg-zinc-900/50 border-zinc-800' : 'bg-white border-gray-200'}`} data-testid="logs-table">
          <div className="p-3 border-b border-border"><span className="text-xs uppercase tracking-wider font-bold text-muted-foreground">Ultimos registros ({data?.logs?.length || 0})</span></div>
          <div className="max-h-64 overflow-y-auto">
            <table className="w-full text-xs">
              <thead className="sticky top-0 bg-card z-10"><tr className="border-b border-border">
                {['Fecha', 'Orden', 'Cliente', 'Maquina', 'Operador', 'Turno', 'Diseno', 'Cant.', 'Setup', 'Parada'].map(h => (
                  <th key={h} className="text-left py-1.5 px-2 text-[9px] uppercase text-muted-foreground font-bold">{h}</th>
                ))}
              </tr></thead>
              <tbody>{(data?.logs || []).slice(0, 100).map((l, i) => (
                <tr key={l.log_id || i} className="border-b border-border/30 hover:bg-secondary/20">
                  <td className="py-1 px-2 text-muted-foreground">{(l.created_at || '').slice(0, 16).replace('T', ' ')}</td>
                  <td className="py-1 px-2 font-mono text-primary">{l.order_number}</td>
                  <td className="py-1 px-2">{(l.client || '').substring(0, 15)}</td>
                  <td className="py-1 px-2"><span className="px-1 py-0.5 bg-primary/15 text-primary rounded text-[9px] font-bold">{l.machine}</span></td>
                  <td className="py-1 px-2">{l.operator || l.user_name}</td>
                  <td className="py-1 px-2 text-muted-foreground">{l.shift || '-'}</td>
                  <td className="py-1 px-2 text-muted-foreground">{l.design_type || '-'}</td>
                  <td className="py-1 px-2 font-mono font-bold text-right">{l.quantity_produced}</td>
                  <td className="py-1 px-2 text-right text-muted-foreground">{l.setup || 0}</td>
                  <td className="py-1 px-2 text-muted-foreground">{(l.stop_cause || '').substring(0, 15) || '-'}</td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
};

export default ProductionScreen;
