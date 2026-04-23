import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { 
  Factory, Warehouse, Zap, History, Users, 
  Database, Boxes, Layers, Tags, UserSquare, ArrowLeft, GripVertical, Columns, ClipboardList,
  LayoutDashboard, TrendingUp, Settings, BarChart3, ShieldCheck, Activity, Search
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
    category: 'Logística',
    icon: 'Warehouse',
    items: [
      { name: 'WMS Central', path: '/wms', desc: 'Gestión de almacén y ubicaciones.', icon: 'Warehouse' },
      { name: 'Stock de Tintas', path: '/wms?tab=tintas', desc: 'Inventario de insumos químicos.', icon: 'Boxes' },
      { name: 'Mantenimiento', path: '/wms?tab=logs', desc: 'Registro de movimientos y auditoría.', icon: 'Database' },
    ]
  },
  {
    id: 'config',
    title: 'Sistema & Logs',
    category: 'Administración',
    icon: 'Settings',
    items: [
      { name: 'Activity Log', path: '/activity-log', desc: 'Historial detallado de acciones.', icon: 'Activity' },
      { name: 'Automatizaciones', path: '/automation-center', desc: 'Configuración de reglas inteligentes.', icon: 'Zap' },
      { name: 'Usuarios', path: '/users', desc: 'Gestión de permisos y accesos.', icon: 'Users' },
      { name: 'Centro de Respaldos', path: '/backups', desc: 'Reportes PDF y respaldos JSON.', icon: 'ShieldCheck' },
      { name: 'Gestor Formulario', action: 'manageFormFields', desc: 'Configura campos del modal.', icon: 'ClipboardList' },
      { name: 'Columnas Globales', action: 'manageColumns', desc: 'Configura visibilidad global.', icon: 'Columns' },
    ]
  },
  {
    id: 'catalogs',
    title: 'Catálogos Base',
    category: 'Datos',
    icon: 'Layers',
    items: [
      { name: 'Opciones y Estados', path: '/catalog-center', desc: 'Clientes, brandings y estados.', icon: 'Tags' },
      { name: 'Operadores', path: '/operators-center', desc: 'Gestión de equipo de producción.', icon: 'UserSquare' },
    ]
  },
  {
    id: 'insights',
    title: 'Business Intelligence',
    category: 'Reportes',
    icon: 'BarChart3',
    roles: ['admin', 'ceo'],
    items: [
      { name: 'CEO Dashboard', path: '/ceo-dashboard', desc: 'KPIs de producción de la planta.', icon: 'TrendingUp' },
    ]
  }
];

const HomeDashboard = () => {
  const navigate = useNavigate();
  const { user } = useAuth();
  const [counts, setCounts] = useState({});
  const [activeCategory, setActiveCategory] = useState('Todas');
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
    <div className="min-h-screen bg-[#020617] text-slate-300 font-barlow flex overflow-hidden">
      {/* SIDEBAR NAVIGATION */}
      <aside className="w-64 bg-[#0a0f1e] border-r border-slate-800 flex flex-col z-20">
        <div className="p-8">
           <div className="flex items-center gap-3 mb-10">
              <div className="w-10 h-10 bg-royal/20 rounded-xl flex items-center justify-center border border-royal/30">
                <Factory className="w-6 h-6 text-royal" />
              </div>
              <div className="flex flex-col">
                <h1 className="text-xl font-black uppercase tracking-tighter text-white">MOS <span className="font-medium text-royal">HOME</span></h1>
                <span className="text-[8px] font-bold uppercase tracking-[0.2em] text-slate-500">CONTROL CENTER</span>
              </div>
           </div>

           <nav className="space-y-1.5">
             {categories.map(cat => (
               <button
                 key={cat}
                 onClick={() => setActiveCategory(cat)}
                 className={`w-full flex items-center justify-between px-4 py-3 rounded-xl text-[10px] font-black uppercase tracking-[0.15em] transition-all ${activeCategory === cat ? 'bg-royal text-white shadow-[0_0_20px_rgba(30,64,175,0.3)]' : 'hover:bg-slate-800 text-slate-500 hover:text-slate-300'}`}
               >
                 {cat}
                 {activeCategory === cat && <div className="w-1.5 h-1.5 bg-white rounded-full animate-pulse" />}
               </button>
             ))}
           </nav>
        </div>

        <div className="mt-auto p-6 border-t border-slate-800">
           <button 
             onClick={() => navigate('/dashboard')}
             className="w-full flex items-center justify-center gap-2 px-4 py-4 bg-slate-800/50 hover:bg-slate-700/50 rounded-2xl text-[10px] font-black uppercase tracking-widest transition-all">
             <ArrowLeft className="w-4 h-4" /> Ir al CRM
           </button>
        </div>
      </aside>

      {/* MAIN CONTENT AREA */}
      <main className="flex-1 flex flex-col relative overflow-y-auto">
        {/* Background Gradients */}
        <div className="absolute top-0 right-0 w-[800px] h-[800px] bg-royal/5 blur-[150px] rounded-full -translate-y-1/2 translate-x-1/2 pointer-events-none" />
        
        {/* HEADER BAR */}
        <header className="sticky top-0 z-30 bg-[#020617]/80 backdrop-blur-md border-b border-slate-800 px-10 py-6 flex items-center justify-between">
           <div className="flex items-center gap-8">
              <div className="relative w-64">
                <Search className="absolute left-4 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500" />
                <input 
                  type="text"
                  placeholder="Buscar herramienta..."
                  className="w-full bg-slate-900/50 border border-slate-800 rounded-xl py-2.5 pl-11 pr-4 text-xs text-white outline-none focus:border-royal/50 transition-all"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
              </div>

              <div className="flex gap-4 items-center">
                 <div className="flex flex-col">
                    <span className="text-[9px] font-bold text-slate-500 uppercase tracking-widest">WMS Status</span>
                    <div className="flex items-center gap-2">
                       <div className="w-2 h-2 bg-emerald-500 rounded-full animate-pulse" />
                       <span className="text-xs font-bold text-white uppercase">Sincronizado</span>
                    </div>
                 </div>
                 <div className="w-px h-8 bg-slate-800" />
                 <div className="flex flex-col">
                    <span className="text-[9px] font-bold text-slate-500 uppercase tracking-widest">Active User</span>
                    <span className="text-xs font-bold text-royal uppercase">{user?.name}</span>
                 </div>
              </div>
           </div>

           <div className="flex gap-3">
              {['SCHEDULING', 'ART READY', 'PRODUCTION', 'COMPLETED'].map(board => (
                <div key={board} className="bg-slate-900/40 border border-slate-800 rounded-lg px-3 py-1.5 flex items-center gap-2">
                   <span className="text-[9px] font-black text-slate-500 uppercase tracking-widest">{board.split(' ')[0]}</span>
                   <span className="text-xs font-black text-white">{counts[board] || 0}</span>
                </div>
              ))}
           </div>
        </header>

        {/* TOOL GRID */}
        <div className="p-10 space-y-12 pb-24">
           {filteredSections.map(section => (
             <div key={section.id} className="space-y-6">
                <div className="flex items-center gap-4">
                   <h2 className="text-[11px] font-black uppercase tracking-[0.4em] text-slate-600">{section.title}</h2>
                   <div className="h-px bg-slate-800/50 flex-1" />
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
                   {section.items.map((item, idx) => {
                     const ItemIcon = ICON_MAP[item.icon] || Factory;
                     return (
                       <div 
                         key={idx}
                         onClick={() => handleCardClick(item)}
                         className="group bg-slate-900/30 hover:bg-[#0a0f1e] border border-slate-800 hover:border-royal/40 rounded-2xl p-5 flex items-center gap-5 cursor-pointer transition-all duration-300 relative overflow-hidden shadow-sm hover:shadow-royal/5"
                       >
                         {/* Decorative side bar */}
                         <div className="absolute left-0 top-0 bottom-0 w-1 bg-royal opacity-0 group-hover:opacity-100 transition-opacity" />
                         
                         <div className="w-12 h-12 bg-slate-800/50 group-hover:bg-royal/10 rounded-xl flex items-center justify-center border border-slate-700/50 group-hover:border-royal/20 transition-all">
                           <ItemIcon className="w-6 h-6 text-slate-500 group-hover:text-royal transition-colors" />
                         </div>

                         <div className="flex-1">
                            <h3 className="text-sm font-black text-white uppercase tracking-wider group-hover:text-royal transition-colors">{item.name}</h3>
                            <p className="text-[10px] font-medium text-slate-500 leading-tight line-clamp-1">{item.desc}</p>
                         </div>

                         <div className="opacity-0 group-hover:opacity-100 transition-all translate-x-4 group-hover:translate-x-0">
                            <Zap className="w-4 h-4 text-royal" />
                         </div>
                       </div>
                     );
                   })}
                </div>
             </div>
           ))}
        </div>

        <footer className="mt-auto p-10 border-t border-slate-800 flex justify-between items-center text-[9px] font-bold text-slate-600 uppercase tracking-[0.3em]">
           <div className="flex items-center gap-4">
              <span>MOS SYSTEM v6.0.2</span>
              <span>•</span>
              <span>Industrial Precision Control</span>
           </div>
           <div>LICENSED TO PROSPER MANUFACTURING</div>
        </footer>
      </main>

      {/* MODALS */}
      <GlobalColumnManager 
        isOpen={showColumnManager} 
        onClose={() => setShowColumnManager(false)} 
      />
      <FormFieldsManagerModal
        isOpen={showFormFieldsManager}
        onClose={() => setShowFormFieldsManager(false)}
      />
    </div>
  );
};

export default HomeDashboard;
