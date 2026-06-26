import React, { useState, useEffect, useCallback } from 'react';
import { 
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, 
  PieChart, Pie, Cell, Legend
} from 'recharts';
import {
  Package, Tag, CheckCircle, AlertTriangle, TrendingUp,
  Layers, MapPin, Box, Loader2, ArrowUpRight, Search
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

// Read-only inventory grid for the customer dashboard — mirrors the WMS
// Inventory module columns + per-column filters, locked to this customer.
const INV_COLS = [
  { key: 'sku', label: 'Style / SKU', filter: true },
  { key: 'color', label: 'Color', filter: true },
  { key: 'size', label: 'Size', filter: true },
  { key: 'description', label: 'Description', filter: true },
  { key: 'location', label: 'Location', filter: true },
  { key: 'country_of_origin', label: 'Country', filter: true },
  { key: 'fabric_content', label: 'Fabric', filter: true },
  { key: '_boxes', label: 'Boxes', filter: false, right: true },
  { key: '_onhand', label: 'On hand', filter: false, right: true },
  { key: '_avail', label: 'Available', filter: false, right: true },
];
const EMPTY_FILTERS = { sku: '', color: '', size: '', description: '', location: '', country_of_origin: '', fabric_content: '' };

const CustomerInventory = ({ customer, apiBase }) => {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(false);
  const [colFilters, setColFilters] = useState(EMPTY_FILTERS);
  const [debounced, setDebounced] = useState(EMPTY_FILTERS);
  const [total, setTotal] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const PAGE = 200;

  useEffect(() => { const t = setTimeout(() => setDebounced(colFilters), 300); return () => clearTimeout(t); }, [colFilters]);
  const setFilter = (k, v) => setColFilters(p => ({ ...p, [k]: v }));
  const hasFilters = Object.values(colFilters).some(v => (v || '').trim());

  const fetchPage = useCallback(async (skip, reset) => {
    setLoading(true);
    const p = new URLSearchParams({ paginated: 'true', limit: String(PAGE), skip: String(skip) });
    if (customer) p.set('customer', customer);
    Object.entries(debounced).forEach(([k, v]) => { const val = (v || '').trim(); if (val) p.set(k, val); });
    try {
      const res = await fetch(`${apiBase}/inventory?${p.toString()}`, { credentials: 'include' });
      const data = res.ok ? await res.json() : { items: [], total: 0, has_more: false };
      const items = data.items || [];
      setRows(prev => reset ? items : [...prev, ...items]);
      setTotal(data.total || 0);
      setHasMore(!!data.has_more);
    } catch { /* silencioso */ } finally { setLoading(false); }
  }, [customer, apiBase, debounced]);

  useEffect(() => { fetchPage(0, true); }, [fetchPage]);

  return (
    <div className="bg-card/40 backdrop-blur-md border border-border/20 rounded-[2.5rem] p-6 shadow-2xl">
      <div className="flex flex-wrap items-center justify-between gap-3 mb-5">
        <div>
          <h3 className="text-xl font-black italic uppercase tracking-tighter flex items-center gap-2">
            <Box className="w-5 h-5 text-blue-500" /> My Inventory
          </h3>
          <p className="text-[10px] font-bold text-muted-foreground uppercase tracking-widest opacity-60">
            Stock detail {total ? `· ${total.toLocaleString()} rows` : ''}
          </p>
        </div>
        {hasFilters && (
          <button
            onClick={() => setColFilters(EMPTY_FILTERS)}
            className="text-[10px] font-black uppercase tracking-widest text-muted-foreground hover:text-foreground border border-border/40 rounded-lg px-3 py-1.5"
          >
            Clear filters
          </button>
        )}
      </div>

      <div className="border border-border/30 rounded-2xl overflow-hidden">
        <div className="overflow-auto max-h-[560px] custom-scrollbar">
          <table className="w-full text-sm">
            <thead className="bg-secondary/60 backdrop-blur-md sticky top-0 z-10">
              <tr>
                {INV_COLS.map(c => (
                  <th key={c.key} className={`px-3 pt-3 text-[9px] font-black uppercase tracking-widest text-muted-foreground ${c.right ? 'text-right' : 'text-left'}`}>{c.label}</th>
                ))}
              </tr>
              <tr>
                {INV_COLS.map(c => (
                  <th key={c.key} className="px-2 pb-2 pt-1 align-top">
                    {c.filter && (
                      <div className="relative">
                        <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3 h-3 text-muted-foreground/50" />
                        <input
                          value={colFilters[c.key]}
                          onChange={e => setFilter(c.key, e.target.value)}
                          placeholder="Filter…"
                          className="w-full pl-6 pr-2 py-1 bg-background/70 border border-border/40 rounded-md text-[10px] font-bold focus:ring-2 focus:ring-primary/30 focus:outline-none"
                        />
                      </div>
                    )}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-border/10">
              {rows.map((it, i) => {
                const onHand = it.on_hand ?? it.units_on_hand ?? 0;
                const allocated = it.allocated ?? it.units_allocated ?? 0;
                const available = it.available ?? (onHand - allocated);
                return (
                  <tr key={it.inventory_id || `${it.sku}-${it.location}-${i}`} className="hover:bg-primary/5 transition-colors">
                    <td className="p-3 font-mono text-[11px] font-black text-primary truncate max-w-[200px]" title={it.style || it.sku}>{it.style || it.sku}</td>
                    <td className="p-3 text-[11px] font-bold">{it.color || '—'}</td>
                    <td className="p-3 text-[11px] font-bold text-primary">{it.size || '—'}</td>
                    <td className="p-3 text-[11px] text-muted-foreground truncate max-w-[200px]" title={it.description}>{it.description || '—'}</td>
                    <td className="p-3 font-mono text-[11px] text-emerald-500">{it.location || '—'}</td>
                    <td className="p-3 font-mono text-[10px] text-muted-foreground/80 truncate max-w-[110px]" title={it.country_of_origin}>{it.country_of_origin || '—'}</td>
                    <td className="p-3 text-[10px] text-muted-foreground truncate max-w-[140px]" title={it.fabric_content}>{it.fabric_content || '—'}</td>
                    <td className="p-3 text-right font-mono font-black text-[12px] tabular-nums">{(it.total_boxes || 0).toLocaleString()}</td>
                    <td className="p-3 text-right font-mono font-black text-[12px] tabular-nums text-emerald-500">{onHand.toLocaleString()}</td>
                    <td className="p-3 text-right font-mono font-black text-[12px] tabular-nums text-blue-400">{available.toLocaleString()}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {loading && (
            <div className="flex items-center justify-center py-6 gap-2 text-muted-foreground">
              <Loader2 className="w-4 h-4 animate-spin" />
              <span className="text-[10px] font-black uppercase tracking-widest">Loading…</span>
            </div>
          )}
          {!loading && rows.length === 0 && (
            <div className="text-center py-12 text-xs font-bold uppercase tracking-widest text-muted-foreground/40 italic">
              {hasFilters ? 'No results for those filters' : 'No inventory to show'}
            </div>
          )}
        </div>
      </div>

      {hasMore && (
        <div className="flex justify-center pt-4">
          <button
            onClick={() => fetchPage(rows.length, false)}
            disabled={loading}
            className="px-6 py-2.5 bg-primary/10 hover:bg-primary hover:text-black text-primary border border-primary/30 rounded-xl text-xs font-black uppercase tracking-widest transition-all disabled:opacity-50"
          >
            Load more ({(total - rows.length).toLocaleString()} remaining)
          </button>
        </div>
      )}
    </div>
  );
};

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
        <p className="text-sm font-black uppercase tracking-widest text-muted-foreground italic">Loading inventory intelligence...</p>
      </div>
    );
  }

  return (
    <div className="space-y-6 animate-in fade-in zoom-in-95 duration-500">
      {/* KPI Section */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard
          title="Total Units"
          value={summary?.total_available || 0}
          icon={Package}
          color="bg-blue-500"
          subtitle={`${summary?.total_boxes || 0} boxes in stock`}
        />
        <StatCard
          title="Active SKUs"
          value={summary?.total_skus || 0}
          icon={Tag}
          color="bg-purple-500"
        />
        <StatCard
          title="Locations"
          value={summary?.total_locations || 0}
          icon={MapPin}
          color="bg-emerald-500"
        />
        <StatCard
          title="Critical Alerts"
          value={summary?.low_stock_items || 0}
          icon={AlertTriangle}
          color="bg-amber-500"
          subtitle="Stock below 10"
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
                Top 10 Stock
              </h3>
              <p className="text-[10px] font-bold text-muted-foreground uppercase tracking-widest opacity-60">Available units per SKU</p>
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
                Distribution by {customer ? 'Status' : 'Manufacturer'}
              </h3>
              <p className="text-[10px] font-bold text-muted-foreground uppercase tracking-widest opacity-60">Overall inventory balance</p>
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
                Most Used Material
              </h3>
              <p className="text-[10px] font-bold text-muted-foreground uppercase tracking-widest opacity-60">Units picked per style · highest to lowest</p>
            </div>
          </div>
          <div className="h-[320px] w-full">
            {(chartData?.most_used?.length || 0) === 0 ? (
              <div className="h-full flex flex-col items-center justify-center text-muted-foreground/40 italic">
                <Box className="w-10 h-10 mb-2" />
                <p className="text-xs font-bold uppercase tracking-widest">No material picked yet</p>
              </div>
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={chartData?.most_used || []} layout="vertical" margin={{ left: 30, right: 30 }}>
                  <CartesianGrid strokeDasharray="3 3" horizontal={false} stroke="rgba(255,255,255,0.05)" />
                  <XAxis type="number" hide />
                  <YAxis
                    dataKey="name"
                    type="category"
                    axisLine={false}
                    tickLine={false}
                    width={120}
                    tick={{ fontSize: 10, fontWeight: 900, fill: 'currentColor', opacity: 0.6 }}
                  />
                  <Tooltip
                    cursor={{ fill: 'rgba(255,255,255,0.05)' }}
                    contentStyle={{ backgroundColor: '#18181b', borderColor: '#27272a', borderRadius: '1rem', border: '1px solid rgba(255,255,255,0.1)' }}
                    itemStyle={{ color: '#fff' }}
                    formatter={(v) => [`${Number(v).toLocaleString()} u`, 'Used']}
                  />
                  <Bar dataKey="value" radius={[0, 8, 8, 0]} barSize={18}>
                    {chartData?.most_used?.map((entry, index) => (
                      <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            )}
          </div>
        </div>

        {/* Low Stock Watchlist */}
        <div className="bg-card/40 backdrop-blur-md border border-border/20 rounded-[2.5rem] p-8 shadow-2xl">
          <h3 className="text-xl font-black italic uppercase tracking-tighter flex items-center gap-2 mb-6">
            <AlertTriangle className="w-5 h-5 text-amber-500" />
            Critical Stock
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
                <p className="text-xs font-bold uppercase tracking-widest">No critical alerts</p>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Detailed inventory (read-only) — what the customer has, same as the WMS module */}
      <CustomerInventory customer={customer} apiBase={apiBase} />
    </div>
  );
};

export default InventoryDashboard;
