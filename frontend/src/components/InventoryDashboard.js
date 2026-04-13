import React, { useState, useEffect, useCallback } from 'react';
import { 
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, 
  PieChart, Pie, Cell, LineChart, Line, Legend 
} from 'recharts';
import { 
  Package, Tag, CheckCircle, AlertTriangle, TrendingUp, 
  Layers, MapPin, Box, Loader2, ArrowUpRight
} from 'lucide-react';
import { toast } from 'sonner';

const COLORS = ['#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899', '#06b6d4', '#f97316'];

const StatCard = ({ title, value, icon: Icon, color, trend, subtitle }) => (
  <div className="bg-card/60 backdrop-blur-xl border border-border/40 rounded-3xl p-5 shadow-xl hover:shadow-primary/5 transition-all group overflow-hidden relative">
    <div className={`absolute top-0 right-0 w-24 h-24 ${color} opacity-[0.03] -mr-8 -mt-8 rounded-full transition-transform group-hover:scale-125`} />
    <div className="flex items-start justify-between">
      <div className="space-y-1">
        <p className="text-[10px] font-black uppercase tracking-widest text-muted-foreground opacity-60">
          {title}
        </p>
        <h3 className="text-3xl font-black italic tracking-tighter tabular-nums">
          {typeof value === 'number' ? value.toLocaleString() : value}
        </h3>
        {subtitle && <p className="text-[10px] font-bold text-muted-foreground">{subtitle}</p>}
      </div>
      <div className={`p-3 rounded-2xl bg-secondary/50 border border-border/20 ${color.replace('bg-', 'text-')}`}>
        <Icon className="w-6 h-6" />
      </div>
    </div>
    {trend && (
      <div className="mt-4 flex items-center gap-1.5">
        <span className={`text-[10px] font-black px-1.5 py-0.5 rounded-lg bg-emerald-500/10 text-emerald-400 flex items-center gap-0.5`}>
          <ArrowUpRight className="w-3 h-3" /> {trend}
        </span>
        <span className="text-[10px] font-bold text-muted-foreground opacity-40 uppercase tracking-tight">vs last month</span>
      </div>
    )}
  </div>
);

const InventoryDashboard = ({ customer = '', apiBase }) => {
  const [loading, setLoading] = useState(true);
  const [summary, setSummary] = useState(null);
  const [chartData, setChartData] = useState(null);

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const query = customer ? `?customer=${encodeURIComponent(customer)}` : '';
      const [summRes, chartRes] = await Promise.all([
        fetch(`${apiBase}/movements/summary${query}`, { credentials: 'include' }),
        fetch(`${apiBase}/inventory/chart-data${query}`, { credentials: 'include' })
      ]);
      
      if (summRes.ok && chartRes.ok) {
        setSummary(await summRes.json());
        setChartData(await chartRes.json());
      } else {
        toast.error('Error al cargar datos del dashboard');
      }
    } catch (error) {
      console.error('Dashboard error:', error);
      toast.error('Error de conexión con el servidor');
    } finally {
      setLoading(false);
    }
  }, [customer, apiBase]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center py-20 animate-pulse">
        <Loader2 className="w-12 h-12 text-primary animate-spin mb-4" />
        <p className="text-sm font-black uppercase tracking-widest text-muted-foreground italic">Cargando Inteligencia de Inventario...</p>
      </div>
    );
  }

  return (
    <div className="space-y-6 animate-in fade-in zoom-in-95 duration-500">
      {/* KPI Section */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard 
          title="Total Unidades" 
          value={summary?.total_available || 0} 
          icon={Package} 
          color="bg-blue-500"
          subtitle={`${summary?.total_boxes || 0} cajas en stock`}
        />
        <StatCard 
          title="SKUs Activos" 
          value={summary?.total_skus || 0} 
          icon={Tag} 
          color="bg-purple-500" 
        />
        <StatCard 
          title="Ubicaciones" 
          value={summary?.total_locations || 0} 
          icon={MapPin} 
          color="bg-emerald-500" 
        />
        <StatCard 
          title="Alertas Críticas" 
          value={summary?.low_stock_items || 0} 
          icon={AlertTriangle} 
          color="bg-amber-500"
          subtitle="Stock menor a 10"
        />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Top SKUs Chart */}
        <div className="bg-card/40 backdrop-blur-md border border-border/20 rounded-[2.5rem] p-8 shadow-2xl relative overflow-hidden group">
          <div className="absolute top-0 left-0 w-full h-1 bg-gradient-to-r from-transparent via-blue-500/50 to-transparent opacity-0 group-hover:opacity-100 transition-opacity" />
          <div className="flex items-center justify-between mb-8">
            <div>
              <h3 className="text-xl font-black italic uppercase tracking-tighter flex items-center gap-2">
                <TrendingUp className="w-5 h-5 text-blue-500" />
                Top 10 Existencias
              </h3>
              <p className="text-[10px] font-bold text-muted-foreground uppercase tracking-widest opacity-60">Unidades disponibles por SKU</p>
            </div>
          </div>
          <div className="h-[350px] w-full">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={chartData?.top_skus || []} layout="vertical" margin={{ left: 30, right: 30 }}>
                <CartesianGrid strokeDasharray="3 3" horizontal={false} stroke="rgba(255,255,255,0.05)" />
                <XAxis type="number" hide />
                <YAxis 
                  dataKey="name" 
                  type="category" 
                  axisLine={false} 
                  tickLine={false} 
                  width={100} 
                  tick={{ fontSize: 10, fontWeight: 900, fill: 'currentColor', opacity: 0.6 }}
                />
                <Tooltip 
                  cursor={{ fill: 'rgba(255,255,255,0.05)' }} 
                  contentStyle={{ backgroundColor: '#18181b', borderColor: '#27272a', borderRadius: '1rem', border: '1px solid rgba(255,255,255,0.1)' }}
                  itemStyle={{ color: '#fff' }}
                />
                <Bar dataKey="value" radius={[0, 8, 8, 0]} barSize={20}>
                  {chartData?.top_skus?.map((entry, index) => (
                    <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>

        {/* Category Distribution Chart */}
        <div className="bg-card/40 backdrop-blur-md border border-border/20 rounded-[2.5rem] p-8 shadow-2xl group">
          <div className="flex items-center justify-between mb-8">
            <div>
              <h3 className="text-xl font-black italic uppercase tracking-tighter flex items-center gap-2">
                <Layers className="w-5 h-5 text-purple-500" />
                Distribución por {customer ? 'Estado' : 'Fabricante'}
              </h3>
              <p className="text-[10px] font-bold text-muted-foreground uppercase tracking-widest opacity-60">Balance general del inventario</p>
            </div>
          </div>
          <div className="h-[350px] w-full">
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie
                  data={customer ? chartData?.by_state : chartData?.by_manufacturer}
                  cx="50%"
                  cy="50%"
                  innerRadius={80}
                  outerRadius={120}
                  paddingAngle={5}
                  dataKey="value"
                  label={({ name, percent }) => `${name} (${(percent * 100).toFixed(0)}%)`}
                >
                  {(customer ? chartData?.by_state : chartData?.by_manufacturer)?.map((entry, index) => (
                    <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} stroke="rgba(255,255,255,0.1)" strokeWidth={2} />
                  ))}
                </Pie>
                <Tooltip 
                  contentStyle={{ backgroundColor: '#18181b', borderColor: '#27272a', borderRadius: '1rem' }}
                />
                <Legend layout="horizontal" verticalAlign="bottom" align="center" iconType="circle" />
              </PieChart>
            </ResponsiveContainer>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Activity Timeline */}
        <div className="lg:col-span-2 bg-card/40 backdrop-blur-md border border-border/20 rounded-[2.5rem] p-8 shadow-2xl">
           <div className="flex items-center justify-between mb-8">
            <div>
              <h3 className="text-xl font-black italic uppercase tracking-tighter flex items-center gap-2">
                <TrendingUp className="w-5 h-5 text-emerald-500" />
                Tendencia de Movimientos
              </h3>
              <p className="text-[10px] font-bold text-muted-foreground uppercase tracking-widest opacity-60">Actividad operativa diaria (últimos 15 días)</p>
            </div>
          </div>
          <div className="h-[250px] w-full">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={chartData?.activity_history || []}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="rgba(255,255,255,0.05)" />
                <XAxis 
                  dataKey="date" 
                  axisLine={false} 
                  tickLine={false} 
                  tick={{ fontSize: 9, fontWeight: 700 }}
                  tickFormatter={(val) => val.split('-').slice(1).join('/')}
                />
                <YAxis axisLine={false} tickLine={false} tick={{ fontSize: 10, fontWeight: 700 }} />
                <Tooltip 
                  contentStyle={{ backgroundColor: '#18181b', borderColor: '#27272a', borderRadius: '1rem' }}
                />
                <Line 
                  type="monotone" 
                  dataKey="count" 
                  stroke="#10b981" 
                  strokeWidth={4} 
                  dot={{ r: 4, fill: '#10b981', strokeWidth: 2, stroke: '#fff' }}
                  activeDot={{ r: 6, strokeWidth: 0 }}
                />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </div>

        {/* Low Stock Watchlist */}
        <div className="bg-card/40 backdrop-blur-md border border-border/20 rounded-[2.5rem] p-8 shadow-2xl">
          <h3 className="text-xl font-black italic uppercase tracking-tighter flex items-center gap-2 mb-6">
            <AlertTriangle className="w-5 h-5 text-amber-500" />
            Stock Crítico
          </h3>
          <div className="space-y-3 overflow-y-auto max-h-[250px] custom-scrollbar pr-2">
            {summary?.low_stock?.map((item, idx) => (
              <div key={idx} className="flex items-center justify-between p-3 rounded-2xl bg-secondary/30 border border-border/10 hover:border-amber-500/20 transition-colors group">
                <div className="min-w-0">
                  <p className="text-xs font-black text-foreground truncate group-hover:text-amber-400 transition-colors">{item.style || item.sku}</p>
                  <p className="text-[10px] font-bold text-muted-foreground opacity-60 uppercase">{item.color} / {item.size}</p>
                </div>
                <div className="flex flex-col items-end">
                   <span className="text-sm font-black tabular-nums text-amber-400">{item.available}</span>
                   <span className="text-[8px] font-black uppercase text-muted-foreground">Units</span>
                </div>
              </div>
            ))}
            {(!summary?.low_stock || summary?.low_stock.length === 0) && (
              <div className="flex flex-col items-center justify-center py-8 opacity-30 italic">
                <CheckCircle className="w-10 h-10 mb-2" />
                <p className="text-xs font-bold uppercase tracking-widest">Sin alertas críticas</p>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

export default InventoryDashboard;
