import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { 
  Factory, Warehouse, Zap, History, Users, 
  Database, Boxes, Layers, Tags, UserSquare, ArrowLeft, Columns, ClipboardList,
  LayoutDashboard, TrendingUp, Settings, BarChart3, ShieldCheck, Activity, Search, 
  CheckCircle2, Clock, PlayCircle, FileCheck
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
    title: 'Operaciones & WMS',
    category: 'Logística de Planta',
    items: [
      { name: 'WMS Central', path: '/wms', desc: 'Gestión de almacén y ubicaciones.', icon: 'Warehouse' },
      { name: 'Stock de Tintas', path: '/wms?tab=tintas', desc: 'Inventario de insumos químicos.', icon: 'Boxes' },
      { name: 'Mantenimiento', path: '/wms?tab=logs', desc: 'Registro de movimientos y auditoría.', icon: 'Database' },
    ]
  },
  {
    id: 'config',
    title: 'Administración del Sistema',
    category: 'Configuración',
    items: [
      { name: 'Activity Log', path: '/activity-log', desc: 'Historial detallado de acciones.', icon: 'Activity' },
      { name: 'Automatizaciones', path: '/automation-center', desc: 'Reglas inteligentes de flujo.', icon: 'Zap' },
      { name: 'Usuarios', path: '/users', desc: 'Gestión de permisos y accesos.', icon: 'Users' },
      { name: 'Centro de Respaldos', path: '/backups', desc: 'Reportes PDF y respaldos JSON.', icon: 'ShieldCheck' },
      { name: 'Gestor Formulario', action: 'manageFormFields', desc: 'Configura campos del modal.', icon: 'ClipboardList' },
      { name: 'Columnas Globales', action: 'manageColumns', desc: 'Configura visibilidad global.', icon: 'Columns' },
    ]
  },
  {
    id: 'catalogs',
    title: 'Catálogos Maestros',
    category: 'Base de Datos',
    items: [
      { name: 'Opciones y Estados', path: '/catalog-center', desc: 'Clientes, brandings y estados.', icon: 'Tags' },
      { name: 'Operadores', path: '/operators-center', desc: 'Gestión de equipo de producción.', icon: 'UserSquare' },
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

  const filteredSections = SECTIONS_DEFS
    .filter(s => !s.roles || s.roles.includes(user?.role))
    .map(s => ({
      ...s,
      items: s.items.filter(item => 
        !search || 
        item.name.toLowerCase().includes(search.toLowerCase()) || 
        item.desc.toLowerCase().includes(search.toLowerCase())
      )
    }))
    .filter(s => s.items.length > 0);

  const stats = [
    { label: 'SCHEDULING', value: counts['SCHEDULING'] || 0, icon: Clock, color: 'text-emerald-500', bg: 'bg-emerald-50' },
    { label: 'ART READY', value: counts['ART READY'] || 0, icon: FileCheck, color: 'text-blue-500', bg: 'bg-blue-50' },
    { label: 'PRODUCTION', value: counts['PRODUCTION'] || 0, icon: PlayCircle, color: 'text-orange-500', bg: 'bg-orange-50' },
    { label: 'COMPLETED', value: counts['COMPLETED'] || 0, icon: CheckCircle2, color: 'text-emerald-600', bg: 'bg-emerald-100' },
  ];

  return (
    <div className="min-h-screen bg-[#f8fafc] text-slate-900 font-barlow overflow-y-auto">
      {/* EXECUTIVE HEADER */}
      <header className="bg-white border-b border-slate-200 px-8 py-6 sticky top-0 z-30 shadow-sm">
        <div className="max-w-7xl mx-auto flex flex-col md:flex-row items-center justify-between gap-6">
           <div className="flex items-center gap-4">
              <div className="w-10 h-10 bg-emerald-500 rounded-xl flex items-center justify-center shadow-lg shadow-emerald-500/20">
                <Factory className="w-6 h-6 text-white" />
              </div>
              <div className="flex flex-col leading-none">
                <h1 className="text-2xl font-black uppercase tracking-tighter text-slate-900">
                  EXECUTIVE <span className="text-emerald-500">INSIGHTS</span>
                </h1>
                <div className="flex items-center gap-2 mt-1">
                   <span className="text-[9px] font-bold uppercase tracking-[0.2em] text-slate-400">OPERATIONS</span>
                   <div className="w-1 h-1 bg-slate-300 rounded-full" />
                   <span className="text-[9px] font-bold uppercase tracking-[0.2em] text-slate-400">PROSPER MANUFACTURING</span>
                </div>
              </div>
           </div>

           <div className="flex items-center gap-4">
              <div className="relative w-64 md:w-80">
                <Search className="absolute left-4 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
                <input 
                  type="text"
                  placeholder="Buscar herramienta o módulo..."
                  className="w-full bg-slate-100 border-none rounded-2xl py-3 pl-12 pr-4 text-xs text-slate-900 outline-none focus:ring-2 focus:ring-emerald-500/20 transition-all placeholder:text-slate-400"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
              </div>
              <button 
                onClick={() => navigate('/dashboard')}
                className="px-6 py-3 bg-slate-900 text-white rounded-2xl text-[10px] font-black uppercase tracking-widest hover:bg-emerald-600 transition-all shadow-lg shadow-slate-900/10">
                Volver al CRM
              </button>
           </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto p-8 space-y-10">
        
        {/* STATS ROW (Replicating the 4 boxes from the image) */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
           {stats.map((stat, idx) => (
             <div key={idx} className="bg-white border border-slate-200 rounded-[2rem] p-8 shadow-sm hover:shadow-md transition-all group">
                <div className="flex justify-between items-start mb-4">
                   <div className={`p-3 ${stat.bg} rounded-2xl group-hover:scale-110 transition-transform`}>
                      <stat.icon className={`w-6 h-6 ${stat.color}`} />
                   </div>
                   <div className="text-[10px] font-black text-slate-300 uppercase tracking-widest">REAL TIME</div>
                </div>
                <div className="flex flex-col">
                   <span className="text-[11px] font-black text-slate-400 uppercase tracking-widest mb-1">{stat.label}</span>
                   <span className="text-4xl font-black text-slate-900 tracking-tighter">{stat.value.toLocaleString()}</span>
                </div>
             </div>
           ))}
        </div>

        {/* CONTENT GRID */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-10">
           {/* Main sections take 2 columns */}
           <div className="lg:col-span-2 space-y-10">
              {filteredSections.map(section => (
                <div key={section.id} className="bg-white border border-slate-200 rounded-[2.5rem] p-10 shadow-sm overflow-hidden relative">
                   <div className="absolute top-0 left-0 w-2 h-full bg-emerald-500/10" />
                   
                   <div className="flex items-center justify-between mb-8">
                      <div className="flex flex-col">
                        <span className="text-[10px] font-black text-emerald-500 uppercase tracking-[0.3em] mb-2">{section.category}</span>
                        <h2 className="text-2xl font-black uppercase tracking-tighter text-slate-900">{section.title}</h2>
                      </div>
                      <div className="px-4 py-1.5 bg-slate-100 rounded-full text-[9px] font-black text-slate-500 uppercase tracking-widest">
                        {section.items.length} HERRAMIENTAS
                      </div>
                   </div>

                   <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      {section.items.map((item, i) => {
                        const ItemIcon = ICON_MAP[item.icon] || Factory;
                        return (
                          <div 
                            key={i}
                            onClick={() => handleCardClick(item)}
                            className="group flex items-center gap-5 p-5 rounded-3xl hover:bg-emerald-50 border border-transparent hover:border-emerald-100 transition-all cursor-pointer"
                          >
                            <div className="w-12 h-12 bg-slate-50 group-hover:bg-white rounded-2xl flex items-center justify-center border border-slate-100 group-hover:border-emerald-200 transition-all">
                               <ItemIcon className="w-6 h-6 text-slate-400 group-hover:text-emerald-500 transition-colors" />
                            </div>
                            <div className="flex flex-col">
                               <span className="text-sm font-black text-slate-800 uppercase tracking-wide group-hover:text-emerald-600 transition-colors">{item.name}</span>
                               <span className="text-[10px] font-medium text-slate-400 line-clamp-1 italic">{item.desc}</span>
                            </div>
                          </div>
                        );
                      })}
                   </div>
                </div>
              ))}
           </div>

           {/* Side Actions / Quick Info */}
           <div className="space-y-8">
              <div className="bg-emerald-500 rounded-[2.5rem] p-10 text-white shadow-xl shadow-emerald-500/20 relative overflow-hidden group">
                 <div className="absolute -right-10 -bottom-10 w-40 h-40 bg-white/10 rounded-full blur-3xl group-hover:scale-150 transition-transform duration-1000" />
                 <TrendingUp className="w-12 h-12 mb-6 opacity-50" />
                 <h2 className="text-2xl font-black uppercase tracking-tighter mb-4 leading-tight">
                    Optimiza tu <br /> Flujo de Trabajo
                 </h2>
                 <p className="text-sm text-emerald-100 font-medium mb-8 leading-relaxed">
                    Usa las herramientas de automatización para reducir tiempos de entrega.
                 </p>
                 <button 
                   onClick={() => navigate('/dashboard')}
                   className="w-full py-4 bg-white text-emerald-600 rounded-2xl text-[10px] font-black uppercase tracking-widest hover:bg-emerald-50 transition-all shadow-lg">
                   Ver Dashboard Maestro
                 </button>
              </div>

              <div className="bg-white border border-slate-200 rounded-[2.5rem] p-10 shadow-sm">
                 <h3 className="text-[10px] font-black text-slate-400 uppercase tracking-[0.3em] mb-6">Estado del Sistema</h3>
                 <div className="space-y-6">
                    <div className="flex items-center justify-between">
                       <span className="text-xs font-bold text-slate-600">Base de Datos</span>
                       <div className="flex items-center gap-2">
                          <span className="text-[10px] font-black text-emerald-500 uppercase">ONLINE</span>
                          <div className="w-2 h-2 bg-emerald-500 rounded-full animate-pulse" />
                       </div>
                    </div>
                    <div className="flex items-center justify-between">
                       <span className="text-xs font-bold text-slate-600">Servidor de Fotos</span>
                       <div className="flex items-center gap-2">
                          <span className="text-[10px] font-black text-emerald-500 uppercase">ONLINE</span>
                          <div className="w-2 h-2 bg-emerald-500 rounded-full animate-pulse" />
                       </div>
                    </div>
                    <div className="flex items-center justify-between">
                       <span className="text-xs font-bold text-slate-600">Sincronización</span>
                       <span className="text-[10px] font-black text-slate-400 uppercase">A tiempo real</span>
                    </div>
                 </div>
              </div>
           </div>
        </div>
      </main>

      <footer className="max-w-7xl mx-auto p-12 border-t border-slate-200 flex flex-col md:flex-row justify-between items-center gap-6 text-[10px] font-black text-slate-400 uppercase tracking-[0.4em]">
         <div className="flex items-center gap-4">
            <Factory className="w-4 h-4" />
            <span>Industrial OS v7.0</span>
            <div className="w-1 h-1 bg-emerald-500 rounded-full" />
            <span>Prosper Manufacturing</span>
         </div>
         <div className="flex items-center gap-6">
            <span>Privacidad</span>
            <span>Seguridad</span>
            <span className="text-slate-900">© 2026</span>
         </div>
      </footer>

      <GlobalColumnManager isOpen={showColumnManager} onClose={() => setShowColumnManager(false)} />
      <FormFieldsManagerModal isOpen={showFormFieldsManager} onClose={() => setShowFormFieldsManager(false)} />
    </div>
  );
};

export default HomeDashboard;
