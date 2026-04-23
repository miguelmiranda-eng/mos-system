import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { 
  Factory, Warehouse, Zap, History, Users, 
  Database, Boxes, Layers, Tags, UserSquare, ArrowLeft, Columns, ClipboardList,
  LayoutDashboard, TrendingUp, Settings, BarChart3, ShieldCheck, Activity, Search, ChevronRight
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
    title: 'Operaciones de Planta',
    category: 'Producción',
    color: 'from-blue-500/10 to-indigo-500/5',
    accent: 'bg-blue-500',
    items: [
      { name: 'WMS Central', path: '/wms', desc: 'Gestión de almacén y ubicaciones.', icon: 'Warehouse' },
      { name: 'Stock de Tintas', path: '/wms?tab=tintas', desc: 'Inventario de insumos químicos.', icon: 'Boxes' },
      { name: 'Mantenimiento', path: '/wms?tab=logs', desc: 'Registro de movimientos y auditoría.', icon: 'Database' },
    ]
  },
  {
    id: 'config',
    title: 'Administración Global',
    category: 'Sistema',
    color: 'from-purple-500/10 to-royal/5',
    accent: 'bg-royal',
    items: [
      { name: 'Activity Log', path: '/activity-log', desc: 'Historial detallado de acciones.', icon: 'Activity' },
      { name: 'Automatizaciones', path: '/automation-center', desc: 'Reglas inteligentes de flujo.', icon: 'Zap' },
      { name: 'Usuarios', path: '/users', desc: 'Permisos y accesos del equipo.', icon: 'Users' },
      { name: 'Centro de Respaldos', path: '/backups', desc: 'PDFs y archivos llave JSON.', icon: 'ShieldCheck' },
      { name: 'Gestor Formulario', action: 'manageFormFields', desc: 'Configura campos del modal.', icon: 'ClipboardList' },
      { name: 'Columnas Globales', action: 'manageColumns', desc: 'Configura visibilidad global.', icon: 'Columns' },
    ]
  },
  {
    id: 'catalogs',
    title: 'Base de Conocimiento',
    category: 'Catálogos',
    color: 'from-slate-500/10 to-slate-800/5',
    accent: 'bg-slate-400',
    items: [
      { name: 'Opciones y Estados', path: '/catalog-center', desc: 'Clientes y estados maestros.', icon: 'Tags' },
      { name: 'Operadores', path: '/operators-center', desc: 'Equipo humano de producción.', icon: 'UserSquare' },
    ]
  },
  {
    id: 'insights',
    title: 'Inteligencia de Datos',
    category: 'Reportes',
    color: 'from-emerald-500/10 to-teal-500/5',
    accent: 'bg-emerald-500',
    roles: ['admin', 'ceo'],
    items: [
      { name: 'CEO Dashboard', path: '/ceo-dashboard', desc: 'KPIs de alta gerencia.', icon: 'TrendingUp' },
    ]
  }
];

const HomeDashboard = () => {
  const navigate = useNavigate();
  const { user } = useAuth();
  const [activeCategory, setActiveCategory] = useState('Todas');
  const [showColumnManager, setShowColumnManager] = useState(false);
  const [showFormFieldsManager, setShowFormFieldsManager] = useState(false);
  const [search, setSearch] = useState('');

  const handleCardClick = (item) => {
    if (item.action === 'manageColumns') setShowColumnManager(true);
    else if (item.action === 'manageFormFields') setShowFormFieldsManager(true);
    else if (item.path) navigate(item.path);
  };

  const categories = ['Todas', ...new Set(SECTIONS_DEFS.map(s => s.category))];

  const filteredSections = SECTIONS_DEFS
    .filter(s => !s.roles || s.roles.includes(user?.role))
    .filter(s => activeCategory === 'Todas' || s.category === activeCategory)
    .map(s => ({
      ...s,
      items: s.items.filter(item => 
        !search || 
        item.name.toLowerCase().includes(search.toLowerCase()) || 
        item.desc.toLowerCase().includes(search.toLowerCase())
      )
    }))
    .filter(s => s.items.length > 0);

  return (
    <div className="min-h-screen bg-[#080c14] text-slate-300 font-barlow flex overflow-hidden">
      {/* SIDEBAR - GRADIENT LOOK */}
      <aside className="w-72 bg-gradient-to-b from-[#0d1321] to-[#080c14] border-r border-white/5 flex flex-col z-20">
        <div className="p-10">
           <div className="flex items-center gap-4 mb-14">
              <div className="w-12 h-12 bg-royal/10 rounded-2xl flex items-center justify-center border border-royal/20 shadow-[0_0_20px_rgba(30,64,175,0.2)]">
                <Factory className="w-6 h-6 text-royal" />
              </div>
              <div className="flex flex-col">
                <h1 className="text-2xl font-black uppercase tracking-tighter text-white">MOS <span className="font-light text-royal">HOME</span></h1>
                <span className="text-[9px] font-bold uppercase tracking-[0.3em] text-slate-500">Sistema Central</span>
              </div>
           </div>

           <nav className="space-y-2">
             {categories.map(cat => (
               <button
                 key={cat}
                 onClick={() => setActiveCategory(cat)}
                 className={`w-full flex items-center justify-between px-5 py-3.5 rounded-2xl text-[10px] font-black uppercase tracking-[0.2em] transition-all duration-500 ${activeCategory === cat ? 'bg-royal/10 text-white border border-royal/20 shadow-lg' : 'text-slate-600 hover:text-slate-300 hover:bg-white/5'}`}
               >
                 {cat}
                 {activeCategory === cat && <div className="w-1.5 h-1.5 bg-royal rounded-full shadow-[0_0_10px_#1e40af]" />}
               </button>
             ))}
           </nav>
        </div>

        <div className="mt-auto p-8">
           <button 
             onClick={() => navigate('/dashboard')}
             className="w-full flex items-center justify-center gap-3 px-4 py-4 bg-white/5 hover:bg-white/10 border border-white/5 rounded-2xl text-[10px] font-black uppercase tracking-widest transition-all">
             <ArrowLeft className="w-4 h-4 text-slate-500" /> Volver al CRM
           </button>
        </div>
      </aside>

      {/* CONTENT AREA */}
      <main className="flex-1 flex flex-col relative overflow-y-auto">
        {/* Soft Background Glows */}
        <div className="absolute top-0 right-0 w-[1000px] h-[1000px] bg-royal/5 blur-[180px] rounded-full -translate-y-1/2 translate-x-1/2 pointer-events-none" />
        <div className="absolute bottom-0 left-0 w-[600px] h-[600px] bg-purple-500/5 blur-[150px] rounded-full translate-y-1/2 -translate-x-1/2 pointer-events-none" />
        
        {/* HEADER - CLEAN & MINIMAL */}
        <header className="sticky top-0 z-30 px-12 py-8 flex items-center justify-between bg-[#080c14]/40 backdrop-blur-xl border-b border-white/5">
           <div className="relative w-80">
              <Search className="absolute left-4 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-600" />
              <input 
                type="text"
                placeholder="Buscar en el panel..."
                className="w-full bg-white/5 border border-white/5 rounded-2xl py-3 pl-12 pr-4 text-xs text-white outline-none focus:border-royal/30 focus:bg-white/10 transition-all placeholder:text-slate-700"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
           </div>

           <div className="flex items-center gap-6">
              <div className="flex flex-col text-right">
                 <span className="text-[10px] font-black text-slate-600 uppercase tracking-widest">Estación de Trabajo</span>
                 <span className="text-sm font-bold text-white uppercase tracking-tighter">{user?.name}</span>
              </div>
              <div className="w-10 h-10 bg-royal/20 rounded-full border border-royal/30 flex items-center justify-center text-royal font-black text-xs">
                {user?.name?.[0]}
              </div>
           </div>
        </header>

        {/* TOOL GRID - HARMONIZED */}
        <div className="p-12 space-y-16 pb-32">
           {filteredSections.map(section => (
             <div key={section.id} className="space-y-8 animate-fadeIn">
                <div className="flex items-center gap-6">
                   <h2 className="text-[11px] font-black uppercase tracking-[0.5em] text-slate-700">{section.title}</h2>
                   <div className="h-[1px] bg-gradient-to-r from-slate-800 to-transparent flex-1" />
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-6">
                   {section.items.map((item, idx) => {
                     const ItemIcon = ICON_MAP[item.icon] || Factory;
                     return (
                       <div 
                         key={idx}
                         onClick={() => handleCardClick(item)}
                         className={`group relative bg-gradient-to-br ${section.color} backdrop-blur-sm border border-white/5 hover:border-white/10 rounded-[2rem] p-7 flex items-center gap-6 cursor-pointer transition-all duration-500 hover:shadow-[0_20px_50px_rgba(0,0,0,0.3)] hover:-translate-y-1.5 overflow-hidden`}
                       >
                         {/* Ambient Glow */}
                         <div className={`absolute -right-4 -top-4 w-24 h-24 ${section.accent} opacity-0 group-hover:opacity-10 blur-3xl transition-opacity duration-500`} />
                         
                         <div className="w-16 h-16 bg-white/5 group-hover:bg-white/10 rounded-[1.25rem] flex items-center justify-center border border-white/5 transition-all duration-500 group-hover:scale-110 shadow-inner">
                           <ItemIcon className="w-7 h-7 text-slate-400 group-hover:text-white transition-colors duration-500" />
                         </div>

                         <div className="flex-1 space-y-1">
                            <h3 className="text-md font-black text-slate-200 uppercase tracking-wide group-hover:text-white transition-colors">{item.name}</h3>
                            <p className="text-[11px] font-medium text-slate-500 leading-tight line-clamp-1 italic">{item.desc}</p>
                         </div>

                         <div className="opacity-0 group-hover:opacity-100 transition-all duration-500 -translate-x-4 group-hover:translate-x-0">
                            <ChevronRight className="w-5 h-5 text-royal" />
                         </div>
                       </div>
                     );
                   })}
                </div>
             </div>
           ))}
        </div>

        <footer className="mt-auto p-12 border-t border-white/5 flex justify-between items-center text-[9px] font-bold text-slate-700 uppercase tracking-[0.4em]">
           <div className="flex items-center gap-6">
              <span>MOS CORE v6.5</span>
              <div className="w-1 h-1 bg-royal rounded-full" />
              <span>Prosper Industrial Intelligence</span>
           </div>
           <div className="flex items-center gap-2">
              <ShieldCheck className="w-3 h-3 text-emerald-500/50" /> Secure Terminal Session
           </div>
        </footer>
      </main>

      <GlobalColumnManager isOpen={showColumnManager} onClose={() => setShowColumnManager(false)} />
      <FormFieldsManagerModal isOpen={showFormFieldsManager} onClose={() => setShowFormFieldsManager(false)} />
    </div>
  );
};

export default HomeDashboard;
