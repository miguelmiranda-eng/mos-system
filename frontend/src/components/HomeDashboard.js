import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Factory, Warehouse, Zap, History, Users,
  Database, Boxes, Tags, UserSquare, Columns, ClipboardList,
  LayoutDashboard, TrendingUp, ShieldCheck, Search,
  ArrowLeft, Palette, Beaker, Brush, Droplets,
} from 'lucide-react';
import { useAuth } from '../App';
import { GlobalColumnManager } from './dashboard/GlobalColumnManager';
import { FormFieldsManagerModal } from './dashboard/FormFieldsManagerModal';

const ICON_MAP = {
  Warehouse, Boxes, Database, History, Zap, Users, Tags,
  UserSquare, Factory, Columns, ClipboardList, LayoutDashboard, TrendingUp,
  ShieldCheck, Palette, Beaker, Brush, Droplets,
};

// Acento visual por sección (clases literales: Tailwind no compila strings dinámicos)
const ACCENTS = {
  inventory:  { chip: 'bg-blue-50 text-blue-600',    bar: 'bg-blue-500' },
  production: { chip: 'bg-violet-50 text-violet-600', bar: 'bg-violet-500' },
  config:     { chip: 'bg-teal-50 text-teal-600',    bar: 'bg-teal-500' },
  catalogs:   { chip: 'bg-amber-50 text-amber-600',  bar: 'bg-amber-500' },
  quality:    { chip: 'bg-emerald-50 text-emerald-600', bar: 'bg-emerald-500' },
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
    id: 'production',
    title: 'Producción & Muestras',
    items: [
      { name: 'Calendario de Ejemplos', path: '/samples', desc: 'Programa muestras por día con recursos y operadores.', icon: 'Beaker' },
      { name: 'Depto. de Pinturas', path: '/paint', desc: 'Calendarización de mezcla de tinta.', icon: 'Brush' },
      { name: 'Calculadora de Blocker', path: '/blocker-tool', desc: 'Proyecta consumo por impresiones y cobertura del backlog.', icon: 'Droplets' },
      { name: 'Módulo de Final Bill', path: '/final-bill', desc: 'Órdenes listas para envío e inventario, y su revisión.', icon: 'ClipboardList' },
      { name: 'Componentes de Orden', path: '/order-components', desc: 'Qué le falta a cada orden y qué la está deteniendo.', icon: 'Boxes' },
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
      { name: 'Columnas Globales', action: 'manageColumns', desc: 'Configura visibilidad global.', icon: 'Columns', roles: ['supersu'] },
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
    <div className="min-h-screen bg-slate-50 text-slate-800 font-barlow overflow-y-auto pb-16">
      {/* HEADER */}
      {/* Fondo sólido en vez de bg-white/90 + backdrop-blur-lg: un header
          sticky con blur re-filtra el contenido en CADA frame de scroll — el
          costo continuo más caro de la página de inicio. Al 90% de opacidad
          la diferencia visual era imperceptible. */}
      <header className="sticky top-0 z-40 bg-white border-b border-slate-200">
        <div className="max-w-7xl mx-auto px-4 md:px-8 py-4 flex flex-col md:flex-row items-center justify-between gap-4">
          <div className="flex items-center gap-3 w-full md:w-auto">
            <div className="w-11 h-11 rounded-2xl bg-gradient-to-br from-blue-500 to-blue-700 flex items-center justify-center shadow-md shadow-blue-200 ring-1 ring-blue-100">
              <LayoutDashboard className="w-6 h-6 text-white" />
            </div>
            <div className="leading-none">
              <h1 className="text-xl font-black uppercase tracking-tight text-slate-900">
                MOS <span className="text-blue-600">HOME</span>
              </h1>
              <span className="block text-[9px] font-bold uppercase tracking-[0.35em] text-slate-400 mt-1.5">Industrial Intelligence</span>
            </div>
          </div>

          <div className="flex items-center gap-3 w-full md:w-auto">
            <div className="relative flex-1 md:w-80">
              <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
              <input
                type="text"
                placeholder="Filtrar herramientas..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="w-full h-11 pl-10 pr-4 bg-slate-100 border border-slate-200 rounded-xl text-sm text-slate-700 placeholder:text-slate-400 outline-none focus:border-blue-400 focus:bg-white focus:ring-2 focus:ring-blue-100 transition-all"
              />
            </div>
            <button
              onClick={() => navigate('/dashboard')}
              className="h-11 px-5 rounded-xl bg-white border border-slate-200 text-[11px] font-black uppercase tracking-widest text-slate-500 hover:text-blue-600 hover:border-blue-300 flex items-center gap-2 whitespace-nowrap transition-all"
            >
              <ArrowLeft className="w-4 h-4" /> Volver al CRM
            </button>
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-4 md:px-8 pt-10 space-y-12">
        {filteredSections.length === 0 ? (
          <div className="py-24 text-center text-slate-400 text-sm font-bold uppercase tracking-widest">
            Sin herramientas que coincidan con “{search}”
          </div>
        ) : (
          filteredSections.map(section => {
            const accent = ACCENTS[section.id] || ACCENTS.inventory;
            return (
              <section key={section.id}>
                <div className="flex items-center gap-3 mb-5">
                  <div className={`w-1.5 h-6 rounded-full ${accent.bar}`} />
                  <h2 className="text-base font-black uppercase tracking-[0.14em] text-slate-800">{section.title}</h2>
                  <span className="text-xs font-semibold text-slate-400">{section.items.length}</span>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-5">
                  {section.items.map((item, idx) => {
                    const ItemIcon = ICON_MAP[item.icon] || Factory;
                    return (
                      <button
                        key={idx}
                        onClick={() => handleCardClick(item)}
                        className="group flex flex-col items-start gap-4 p-6 rounded-2xl bg-white border border-slate-200 text-left shadow-sm hover:shadow-lg hover:border-blue-300 hover:-translate-y-0.5 transition-all duration-200"
                      >
                        <div className={`w-14 h-14 rounded-2xl flex items-center justify-center ${accent.chip}`}>
                          <ItemIcon className="w-7 h-7" />
                        </div>
                        <div className="min-w-0">
                          <div className="text-[15px] font-bold text-slate-900 leading-snug group-hover:text-blue-700 transition-colors">
                            {item.name}
                          </div>
                          <p className="mt-1.5 text-[12.5px] text-slate-500 leading-relaxed">
                            {item.desc}
                          </p>
                        </div>
                      </button>
                    );
                  })}
                </div>
              </section>
            );
          })
        )}
      </main>

      <footer className="max-w-7xl mx-auto px-4 md:px-8 mt-16 border-t border-slate-200 pt-6 flex flex-col md:flex-row justify-between items-center gap-3 text-[10px] font-black text-slate-400 uppercase tracking-[0.4em]">
        <div className="flex items-center gap-3">
          <Factory className="w-4 h-4 text-blue-400" />
          <span>Industrial OS</span>
          <span className="text-slate-300">•</span>
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
