import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Factory, Warehouse, Zap, History, Users,
  Database, Boxes, Tags, UserSquare, Columns, ClipboardList,
  LayoutDashboard, TrendingUp, ShieldCheck, Search,
  ChevronRight, Palette, ArrowLeft,
} from 'lucide-react';
import { useAuth } from '../App';
import { GlobalColumnManager } from './dashboard/GlobalColumnManager';
import { FormFieldsManagerModal } from './dashboard/FormFieldsManagerModal';

const ICON_MAP = {
  Warehouse, Boxes, Database, History, Zap, Users, Tags,
  UserSquare, Factory, Columns, ClipboardList, LayoutDashboard, TrendingUp,
  ShieldCheck, Palette,
};

const SECTIONS_DEFS = [
  {
    id: 'inventory',
    title: 'Gestión de Inventario',
    items: [
      { name: 'WMS Central', path: '/wms', desc: 'Gestión completa de almacén y ubicaciones.', icon: 'Warehouse' },
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
      { name: 'Operadores', path: '/operators-center', desc: 'Gestión de operadores para producción.', icon: 'UserSquare' },
      { name: 'Mos-atlas', path: '/ceo-dashboard', desc: 'Seguimiento de órdenes y facturación.', icon: 'TrendingUp', roles: ['admin'] },
    ]
  },
  {
    id: 'quality',
    title: 'Calidad (QC)',
    items: [
      { name: 'Puntos de Inspección QC', path: '/qc-settings', desc: 'Checklist de auditoría: foto, sí/no, pass/fail, lista.', icon: 'ShieldCheck' },
    ]
  }
];

const HomeDashboard = () => {
  const navigate = useNavigate();
  const { user } = useAuth();
  const [showColumnManager, setShowColumnManager] = useState(false);
  const [showFormFieldsManager, setShowFormFieldsManager] = useState(false);
  const [search, setSearch] = useState('');

  const handleCardClick = (item) => {
    if (item.action === 'manageColumns') setShowColumnManager(true);
    else if (item.action === 'manageFormFields') setShowFormFieldsManager(true);
    else if (item.path) navigate(item.path);
  };

  const filteredSections = SECTIONS_DEFS.map(s => ({
    ...s,
    items: s.items.filter(item => {
      const hasRole = !item.roles || item.roles.includes(user?.role) || user?.role === 'supersu';
      const matchesSearch = !search ||
        item.name.toLowerCase().includes(search.toLowerCase()) ||
        item.desc.toLowerCase().includes(search.toLowerCase());
      return hasRole && matchesSearch;
    })
  })).filter(s => s.items.length > 0);

  return (
    <div className="relative min-h-screen bg-[#070d1a] text-slate-200 font-barlow overflow-y-auto pb-20">
      {/* Ambient navy glow */}
      <div className="pointer-events-none fixed inset-0 bg-[radial-gradient(ellipse_900px_500px_at_top,rgba(37,99,235,0.14),transparent_60%)]" />
      <div className="pointer-events-none fixed inset-x-0 bottom-0 h-1/2 bg-[radial-gradient(ellipse_700px_400px_at_bottom_left,rgba(30,58,138,0.18),transparent_60%)]" />

      {/* HEADER */}
      <header className="sticky top-0 z-40 backdrop-blur-xl bg-[#070d1a]/80 border-b border-white/[0.06]">
        <div className="max-w-7xl mx-auto px-4 md:px-8 py-4 flex flex-col md:flex-row items-center justify-between gap-4">
          <div className="flex items-center gap-3 w-full md:w-auto">
            <div className="w-11 h-11 rounded-2xl bg-gradient-to-br from-blue-500 to-blue-800 flex items-center justify-center shadow-lg shadow-blue-950/60 ring-1 ring-white/10">
              <LayoutDashboard className="w-6 h-6 text-white" />
            </div>
            <div className="leading-none">
              <h1 className="text-xl font-black uppercase tracking-tight text-white">
                MOS <span className="text-blue-400">HOME</span>
              </h1>
              <span className="block text-[9px] font-bold uppercase tracking-[0.35em] text-slate-500 mt-1.5">Industrial Intelligence</span>
            </div>
          </div>

          <div className="flex items-center gap-3 w-full md:w-auto">
            <div className="relative flex-1 md:w-80">
              <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500" />
              <input
                type="text"
                placeholder="Filtrar herramientas..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="w-full h-11 pl-10 pr-4 bg-white/[0.04] border border-white/[0.08] rounded-xl text-sm text-slate-200 placeholder:text-slate-500 outline-none focus:border-blue-400/50 focus:bg-white/[0.06] transition-all"
              />
            </div>
            <button
              onClick={() => navigate('/dashboard')}
              className="h-11 px-5 rounded-xl bg-white/[0.04] border border-white/[0.08] text-[11px] font-black uppercase tracking-widest text-slate-300 hover:text-white hover:border-blue-400/40 hover:bg-white/[0.07] flex items-center gap-2 whitespace-nowrap transition-all"
            >
              <ArrowLeft className="w-4 h-4" /> Volver al CRM
            </button>
          </div>
        </div>
      </header>

      <main className="relative max-w-7xl mx-auto px-4 md:px-8 pt-8 space-y-10">
        {/* SECTIONS */}
        {filteredSections.length === 0 ? (
          <div className="py-24 text-center text-slate-500 text-sm font-bold uppercase tracking-widest">
            Sin herramientas que coincidan con “{search}”
          </div>
        ) : (
          <div className="space-y-9">
            {filteredSections.map(section => (
              <section key={section.id}>
                <div className="flex items-center gap-3 mb-4">
                  <div className="w-1 h-5 rounded-full bg-gradient-to-b from-blue-400 to-blue-700" />
                  <h2 className="text-sm font-black uppercase tracking-[0.18em] text-slate-200">{section.title}</h2>
                  <span className="text-[10px] font-mono text-slate-600">{String(section.items.length).padStart(2, '0')}</span>
                  <div className="flex-1 h-px bg-gradient-to-r from-white/10 to-transparent" />
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
                  {section.items.map((item, idx) => {
                    const ItemIcon = ICON_MAP[item.icon] || Factory;
                    return (
                      <button
                        key={idx}
                        onClick={() => handleCardClick(item)}
                        className="group relative flex items-center gap-3.5 p-3.5 rounded-xl bg-white/[0.03] border border-white/[0.07] hover:border-blue-400/40 hover:bg-white/[0.06] text-left transition-all duration-200 hover:shadow-[0_8px_30px_rgba(37,99,235,0.12)]"
                      >
                        <div className="w-10 h-10 rounded-lg bg-blue-500/[0.08] border border-blue-400/15 flex items-center justify-center flex-shrink-0 group-hover:bg-blue-500/20 group-hover:border-blue-400/30 transition-all">
                          <ItemIcon className="w-5 h-5 text-blue-300/70 group-hover:text-blue-200 transition-colors" />
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="text-[13px] font-bold uppercase tracking-wide text-slate-100 truncate group-hover:text-white transition-colors">{item.name}</div>
                          <div className="text-[10px] text-slate-500 truncate italic">{item.desc}</div>
                        </div>
                        <ChevronRight className="w-4 h-4 text-slate-700 group-hover:text-blue-300 group-hover:translate-x-0.5 transition-all flex-shrink-0" />
                      </button>
                    );
                  })}
                </div>
              </section>
            ))}
          </div>
        )}
      </main>

      <footer className="relative max-w-7xl mx-auto px-4 md:px-8 mt-14 border-t border-white/[0.06] pt-6 flex flex-col md:flex-row justify-between items-center gap-3 text-[10px] font-black text-slate-600 uppercase tracking-[0.4em]">
        <div className="flex items-center gap-3">
          <Factory className="w-4 h-4 text-blue-500/40" />
          <span>Industrial OS</span>
          <span className="text-slate-700">•</span>
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
