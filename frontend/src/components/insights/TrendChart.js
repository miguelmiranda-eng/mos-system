import React from 'react';
import { 
  BarChart, 
  Bar, 
  XAxis, 
  YAxis, 
  CartesianGrid, 
  Tooltip, 
  ResponsiveContainer,
  Cell
} from 'recharts';

/**
 * TrendChart component using Recharts.
 * Displays a clean, modern bar chart for weekly production.
 */
const TrendChart = ({ data }) => {
  const COLORS = ['#818cf8', '#6366f1', '#4f46e5', '#4338ca'];

  return (
    <div className="h-80 w-full bg-white/80 backdrop-blur-md p-6 rounded-3xl shadow-lg border border-slate-100">
      <h3 className="text-lg font-bold text-slate-800 mb-6 flex items-center">
        <span className="w-2 h-2 bg-indigo-500 rounded-full mr-2"></span>
        Tendencia de Producción Semanal
      </h3>
      <ResponsiveContainer width="100%" height="90%">
        <BarChart data={data}>
          <defs>
            <linearGradient id="barGradient" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#6366f1" stopOpacity={0.8}/>
              <stop offset="100%" stopColor="#4f46e5" stopOpacity={1}/>
            </linearGradient>
          </defs>
          <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#e2e8f0" />
          <XAxis 
            dataKey="week" 
            axisLine={false} 
            tickLine={false} 
            stroke="#64748b" 
            fontSize={12}
            dy={10}
          />
          <YAxis 
            axisLine={false} 
            tickLine={false} 
            stroke="#64748b" 
            fontSize={12}
          />
          <Tooltip 
            cursor={{ fill: '#f8fafc', radius: 10 }}
            contentStyle={{ 
              borderRadius: '16px', 
              border: 'none', 
              boxShadow: '0 10px 15px -3px rgb(0 0 0 / 0.1)',
              padding: '12px'
            }}
          />
          <Bar 
            dataKey="units" 
            fill="url(#barGradient)" 
            radius={[10, 10, 0, 0]} 
            barSize={40}
          >
            {data.map((entry, index) => (
              <Cell key={`cell-${index}`} fillOpacity={0.8 + (index * 0.05)} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
};

export default TrendChart;
