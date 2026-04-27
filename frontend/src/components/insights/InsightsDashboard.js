import React, { useState, useEffect } from 'react';
import BallNumber from './BallNumber';
import TrendChart from './TrendChart';
import { Upload, Filter, Calendar, Users, Database } from 'lucide-react';

const InsightsDashboard = () => {
  const [user, setUser] = useState(null);
  const [data, setData] = useState(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    // Check role from session/local storage
    const storedUser = JSON.parse(localStorage.getItem('user') || '{"role": "yamil", "name": "Yamil Miranda"}');
    setUser(storedUser);

    // Simulate API fetch based on role
    const fetchData = async () => {
      setIsLoading(true);
      try {
        // In reality: const res = await axios.get(storedUser.role === 'yamil' ? '/api/v1/insights/yamil-dashboard' : '/api/v1/insights/angel-dashboard');
        // setData(res.data);
        
        // Mocking for the demonstration
        if (storedUser.role === 'yamil') {
          setData({
            ball_number: "652,000",
            weekly_trend: [
              { week: 'Sem 12', units: 155000 },
              { week: 'Sem 13', units: 162000 },
              { week: 'Sem 14', units: 148000 },
              { week: 'Sem 15', units: 187000 },
            ]
          });
        } else {
          setData([
            { date: '2026-04-20', customer: 'LOVE IN FAITH', total_units: 12500, total_amount: 43750, source: 'manual_excel' },
            { date: '2026-04-19', customer: 'Tractor Supply', total_units: 8200, total_amount: 28700, source: 'printavo' },
          ]);
        }
      } catch (err) {
        console.error("Error fetching insights:", err);
      } finally {
        setIsLoading(false);
      }
    };

    fetchData();
  }, []);

  if (isLoading) return (
    <div className="flex items-center justify-center h-screen bg-slate-50">
      <div className="animate-spin rounded-full h-12 w-12 border-t-2 border-b-2 border-indigo-600"></div>
    </div>
  );

  return (
    <div className="min-h-screen bg-slate-50 p-8">
      <div className="max-w-7xl mx-auto">
        <header className="mb-12 flex justify-between items-end">
          <div>
            <h1 className="text-4xl font-black text-slate-900 tracking-tight">Insights de Producción</h1>
            <p className="text-slate-500 mt-2 font-medium flex items-center">
              <span className={`w-2 h-2 rounded-full mr-2 ${user.role === 'yamil' ? 'bg-amber-500' : 'bg-emerald-500'}`}></span>
              Sesión activa: <span className="text-slate-800 ml-1 capitalize">{user.role} Dashboard</span>
            </p>
          </div>
          {user.role === 'angel' && (
            <button className="flex items-center bg-indigo-600 hover:bg-indigo-700 text-white px-6 py-3 rounded-2xl font-bold shadow-lg shadow-indigo-200 transition-all active:scale-95">
              <Upload size={20} className="mr-2" />
              Subir Correcciones
            </button>
          )}
        </header>

        {user.role === 'yamil' && data && (
          <div className="space-y-10 animate-in fade-in slide-in-from-bottom-4 duration-700">
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
              <div className="lg:col-span-1">
                <BallNumber value={data.ball_number} />
              </div>
              <div className="lg:col-span-2">
                <TrendChart data={data.weekly_trend} />
              </div>
            </div>
            
            <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
              <div className="bg-white p-6 rounded-3xl shadow-sm border border-slate-100 flex items-center">
                <div className="w-12 h-12 bg-amber-100 text-amber-600 rounded-2xl flex items-center justify-center mr-4">
                  <Database size={24} />
                </div>
                <div>
                  <p className="text-sm font-bold text-slate-500 uppercase tracking-wider">Total Acumulado</p>
                  <p className="text-2xl font-black text-slate-800">1.2M Units</p>
                </div>
              </div>
              <div className="bg-white p-6 rounded-3xl shadow-sm border border-slate-100 flex items-center">
                <div className="w-12 h-12 bg-blue-100 text-blue-600 rounded-2xl flex items-center justify-center mr-4">
                  <Users size={24} />
                </div>
                <div>
                  <p className="text-sm font-bold text-slate-500 uppercase tracking-wider">Eficiencia Promedio</p>
                  <p className="text-2xl font-black text-slate-800">94.2%</p>
                </div>
              </div>
              <div className="bg-white p-6 rounded-3xl shadow-sm border border-slate-100 flex items-center">
                <div className="w-12 h-12 bg-emerald-100 text-emerald-600 rounded-2xl flex items-center justify-center mr-4">
                  <Calendar size={24} />
                </div>
                <div>
                  <p className="text-sm font-bold text-slate-500 uppercase tracking-wider">Días Operativos</p>
                  <p className="text-2xl font-black text-slate-800">224 Días</p>
                </div>
              </div>
            </div>
          </div>
        )}

        {user.role === 'angel' && data && (
          <div className="bg-white rounded-[32px] shadow-xl shadow-slate-200/60 overflow-hidden border border-slate-100 animate-in fade-in duration-500">
            <div className="p-8 border-b border-slate-50 flex justify-between items-center bg-slate-50/50">
              <h2 className="text-2xl font-black text-slate-800">Correcciones de Producción</h2>
              <div className="flex space-x-3">
                <button className="p-3 bg-white rounded-xl shadow-sm border border-slate-200 text-slate-600 hover:text-indigo-600 transition-colors">
                  <Filter size={20} />
                </button>
              </div>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="text-slate-400 uppercase text-[11px] font-black tracking-[0.2em]">
                    <th className="px-8 py-6">Fecha</th>
                    <th className="px-8 py-6">Cliente</th>
                    <th className="px-8 py-6 text-right">Unidades</th>
                    <th className="px-8 py-6 text-right">Monto Total</th>
                    <th className="px-8 py-6 text-center">Origen</th>
                  </tr>
                </thead>
                <tbody className="text-slate-600 font-medium">
                  {data.map((row, i) => (
                    <tr key={i} className="group hover:bg-slate-50/80 transition-colors border-t border-slate-50">
                      <td className="px-8 py-6 text-slate-900 font-bold">{row.date}</td>
                      <td className="px-8 py-6">
                        <span className="bg-slate-100 px-3 py-1 rounded-lg text-xs font-bold text-slate-600 uppercase">
                          {row.customer}
                        </span>
                      </td>
                      <td className="px-8 py-6 text-right font-black text-slate-800">{row.total_units.toLocaleString()}</td>
                      <td className="px-8 py-6 text-right font-black text-indigo-600">${row.total_amount.toLocaleString()}</td>
                      <td className="px-8 py-6 text-center">
                        <span className={`px-4 py-1.5 rounded-full text-[10px] font-black uppercase tracking-widest ${
                          row.source === 'manual_excel' 
                            ? 'bg-amber-100 text-amber-600' 
                            : 'bg-emerald-100 text-emerald-600'
                        }`}>
                          {row.source.replace('_', ' ')}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default InsightsDashboard;
