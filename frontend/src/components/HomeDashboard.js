import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { 
  Factory, Warehouse, Zap, History, Users, 
  Database, Boxes, Layers, Tags, UserSquare, ArrowLeft, Columns, ClipboardList,
  LayoutDashboard, TrendingUp, Settings, BarChart3, ShieldCheck, Activity, Search, 
  CheckCircle2, Clock, PlayCircle, FileCheck, ChevronRight
} from 'lucide-react';
import { useAuth } from '../App';
import { API } from '../lib/constants';
import { GlobalColumnManager } from './dashboard/GlobalColumnManager';
import { FormFieldsManagerModal } from './dashboard/FormFieldsManagerModal';

const ICON_MAP = { 
  Warehouse, Boxes, Database, History, Zap, Users, Layers, Tags, 
  UserSquare, Factory, Columns, ClipboardList, LayoutDashboard, TrendingUp,
  Settings, BarChart3, ShieldCheck, Activity
};

const SECTIONS_DEFS = [
  {
    id: 'inventory',
    title: 'Gestión de Inventario',
    items: [
      { name: 'WMS Central', path: '/wms', desc: 'Gestión completa de almacén y ubicaciones.', icon: 'Warehouse' },
      { name: 'Stock de Tintas', path: '/wms?tab=tintas', desc: 'Control de inventario de insumos químicos.', icon: 'Boxes' },
      { name: 'Mantenimiento', path: '/wms?tab=logs', desc: 'Registro de movimientos y auditoría.', icon: 'Database' },
    ]
  },
  {
    id: 'config',
    title: 'Configuraciones & Logs',
    items: [
      { name: 'Activity Log', path: '/activity-log', desc: 'Historial detallado de cambios y acciones.', icon: 'History' },
      { name: 'Automatizaciones', path: '/automation-center', desc: 'Configuración de reglas inteligentes.', icon: 'Zap' },
      { name: 'Usuarios', path: '/users', desc: 'Gestión de permisos y accesos del equipo.', icon: 'Users' },
      { name: 'Centro de Respaldos', path: '/backups', desc: 'Descarga reportes PDF o respaldos JSON.', icon: 'ShieldCheck' },
      { name: 'Gestor Formulario', action: 'manageFormFields', desc: 'Configura campos del modal.', icon: 'ClipboardList' },
      { name: 'Columnas Globales', action: 'manageColumns', desc: 'Configura visibilidad global.', icon: 'Columns' },
    ]
  },
  {
    id: 'catalogs',
    title: 'Catálogos del Sistema',
    items: [
      { name: 'Opciones y Estados', path: '/catalog-center', desc: 'Administra clientes, brandings y estados.', icon: 'Tags' },
      { name: 'Operadores', path: '/operators-center', desc: 'Gestión de operadores para producción.', icon: 'UserSquare' },
      { name: 'Dashboard Ejecutivo', path: '/ceo-dashboard', desc: 'Vista consolidada de KPIs de planta.', icon: 'TrendingUp', roles: ['admin', 'ceo'] },
    ]
  }
];

const HomeDashboard = () => {
  const navigate = useNavigate();
  const { user } = useAuth();
  const [counts, setCounts] = useState({});
  const [showColumnManager, setShowColumnManager] = useState(false);
  const [showFormFieldsManager, setShowFormFieldsManager] = useState(false);
  const [search, setSearch] = useState('');

  useEffect(() => {
    fetch(`${API}/orders/board-counts`, { credentials: 'include' })
      .then(res => res.ok ? res.json() : {})
      .then(data => setCounts(data))
      .catch(() => {});
  }, []);

  const handleCardClick = (item) => {
    if (item.action === 'manageColumns') setShowColumnManager(true);
    else if (item.action === 'manageFormFields') setShowFormFieldsManager(true);
    else if (item.path) navigate(item.path);
  };

  const filteredSections = SECTIONS_DEFS.map(s => ({
    ...s,
    items: s.items.filter(item => {
      const hasRole = !item.roles || item.roles.includes(user?.role);
      const matchesSearch = !search || 
        item.name.toLowerCase().includes(search.toLowerCase()) || 
        item.desc.toLowerCase().includes(search.toLowerCase());
      return hasRole && matchesSearch;
    })
  })).filter(s => s.items.length > 0);

  const stats = [
    { label: 'SCHEDULING', value: counts['SCHEDULING'] || 0, icon: Clock, color: 'text-emerald-500', bg: 'bg-emerald-50' },
    { label: 'ART READY', value: counts['ART READY'] || 0, icon: FileCheck, color: 'text-blue-500', bg: 'bg-blue-50' },
    { label: 'PRODUCTION', value: counts['PRODUCTION'] || 0, icon: PlayCircle, color: 'text-orange-500', bg: 'bg-orange-50' },
    { label: 'COMPLETED', value: counts['COMPLETED'] || 0, icon: CheckCircle2, color: 'text-emerald-600', bg: 'bg-emerald-100' },
  ];

  return (
    <div className="min-h-screen bg-[#f8fafc] text-slate-900 font-barlow overflow-y-auto pb-20">
      {/* HEADER */}
      <header className="bg-white border-b border-slate-200 px-8 py-6 mb-8 shadow-sm sticky top-0 z-40">
        <div className="max-w-7xl mx-auto flex flex-col md:flex-row items-center justify-between gap-6">
           <div className="flex items-center gap-4">
              <div className="w-10 h-10 bg-emerald-500 rounded-xl flex items-center justify-center shadow-lg shadow-emerald-500/20">
                <Factory className="w-6 h-6 text-white" />
              </div>
              <div className="flex flex-col leading-none">
                <h1 className="text-2xl font-black uppercase tracking-tighter text-slate-900">
                  MOS <span className="text-emerald-500">HOME</span>
                </h1>
                <span className="text-[9px] font-bold uppercase tracking-[0.3em] text-slate-400 mt-1">Industrial Intelligence</span>
              </div>
           </div>

           <div className="flex items-center gap-4">
              <div className="relative w-64 md:w-80">
                <Search className="absolute left-4 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
                <input 
                  type="text"
                  placeholder="Filtrar herramientas..."
                  className="w-full bg-slate-100 border-none rounded-2xl py-2.5 pl-12 pr-4 text-xs text-slate-900 outline-none focus:ring-2 focus:ring-emerald-500/20 transition-all placeholder:text-slate-400"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
              </div>
              <button 
                onClick={() => navigate('/dashboard')}
                className="px-6 py-3 bg-slate-900 text-white rounded-2xl text-[10px] font-black uppercase tracking-widest hover:bg-emerald-600 transition-all shadow-lg">
                Volver al CRM
              </button>
           </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-8 space-y-12">
        
        {/* STATS ROW */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
           {stats.map((stat, idx) => (
             <div key={idx} className="bg-white border border-slate-200 rounded-[2rem] p-8 shadow-sm">
                <div className="flex justify-between items-start mb-4">
                   <div className={`p-3 ${stat.bg} rounded-2xl`}>
                      <stat.icon className={`w-6 h-6 ${stat.color}`} />
                   </div>
                </div>
                <div className="flex flex-col">
                   <span className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1">{stat.label}</span>
                   <span className="text-4xl font-black text-slate-900 tracking-tighter">{stat.value.toLocaleString()}</span>
                </div>
             </div>
           ))}
        </div>

        {/* ORIGINAL GRID LAYOUT WITH EXECUTIVE STYLE */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-10">
           {filteredSections.map(section => (
             <div key={section.id} className="space-y-6">
                <div className="flex items-center gap-3 ml-2">
                   <div className="w-1.5 h-6 bg-emerald-500 rounded-full" />
                   <h2 className="text-xl font-black uppercase tracking-tighter text-slate-900">{section.title}</h2>
                </div>

                <div className="space-y-4">
                   {section.items.map((item, idx) => {
                     const ItemIcon = ICON_MAP[item.icon] || Factory;
                     return (
                       <div 
                         key={idx}
                         onClick={() => handleCardClick(item)}
                         className="group bg-white border border-slate-200 hover:border-emerald-500/30 rounded-[1.75rem] p-6 flex items-center gap-5 cursor-pointer transition-all duration-300 hover:shadow-[0_15px_35px_rgba(16,185,129,0.08)] hover:-translate-y-1"
                       >
                         <div className="w-12 h-12 bg-slate-50 group-hover:bg-emerald-50 rounded-xl flex items-center justify-center border border-slate-100 group-hover:border-emerald-100 transition-all">
                            <ItemIcon className="w-6 h-6 text-slate-400 group-hover:text-emerald-500 transition-colors" />
                         </div>
                         
                         <div className="flex-1">
                            <h3 className="text-sm font-black text-slate-800 uppercase tracking-wide group-hover:text-emerald-600 transition-colors">{item.name}</h3>
                            <p className="text-[10px] font-medium text-slate-400 leading-tight line-clamp-1 italic">{item.desc}</p>
                         </div>

                         <div className="opacity-0 group-hover:opacity-100 transition-all translate-x-4 group-hover:translate-x-0">
                            <ChevronRight className="w-4 h-4 text-emerald-500" />
                         </div>
                       </div>
                     );
                   })}
                </div>
             </div>
           ))}
        </div>
      </main>

      <footer className="max-w-7xl mx-auto px-12 mt-16 border-t border-slate-200 pt-10 flex justify-between items-center text-[10px] font-black text-slate-400 uppercase tracking-[0.4em]">
         <div className="flex items-center gap-3">
            <Factory className="w-4 h-4 text-emerald-500/50" />
            <span>Industrial OS</span>
            <span>•</span>
            <span>v7.2.1</span>
         </div>
         <div>Prosper Manufacturing © 2026</div>
      </footer>

      <GlobalColumnManager isOpen={showColumnManager} onClose={() => setShowColumnManager(false)} />
      <FormFieldsManagerModal isOpen={showFormFieldsManager} onClose={() => setShowFormFieldsManager(false)} />
    </div>
  );
};

export default HomeDashboard;
