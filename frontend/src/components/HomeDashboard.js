import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { 
  Factory, Warehouse, Zap, History, Users, 
  Database, Boxes, Layers, Tags, UserSquare, ArrowLeft, GripVertical, Columns, ClipboardList,
  LayoutDashboard, TrendingUp
} from 'lucide-react';
import { useAuth } from '../App';
import { API } from '../lib/constants';
import { GlobalColumnManager } from './dashboard/GlobalColumnManager';
import { FormFieldsManagerModal } from './dashboard/FormFieldsManagerModal';

const ICON_MAP = { 
  Warehouse, Boxes, Database, History, Zap, Users, Layers, Tags, 
  UserSquare, Factory, Columns, ClipboardList, LayoutDashboard, TrendingUp 
};

// Stable section definitions (by id, used for ordering)
const SECTIONS_DEFS = [
  {
    id: 'inventory',
    title: 'Gestión de Inventario',
    icon: 'Warehouse',
    color: 'from-emerald-500/20 to-teal-500/20',
    items: [
      { name: 'WMS Central', path: '/wms', desc: 'Gestión completa de almacén y ubicaciones.', icon: 'Warehouse' },
      { name: 'Stock de Tintas', path: '/wms?tab=tintas', desc: 'Control de inventario de insumos químicos.', icon: 'Boxes' },
      { name: 'Mantenimiento', path: '/wms?tab=logs', desc: 'Registro de movimientos y auditoría.', icon: 'Database' },
    ]
  },
  {
    id: 'config',
    title: 'Configuraciones & Logs',
    icon: 'Zap',
    color: 'from-purple-500/20 to-pink-500/20',
    items: [
      { name: 'Activity Log', path: '/activity-log', desc: 'Historial detallado de cambios y acciones.', icon: 'History' },
      { name: 'Automatizaciones', path: '/automation-center', desc: 'Configuración de reglas inteligentes.', icon: 'Zap' },
      { name: 'Usuarios', path: '/users', desc: 'Gestión de permisos y accesos del equipo.', icon: 'Users' },
      { name: 'Gestor de Formulario', action: 'manageFormFields', desc: 'Configura el orden y visibilidad de los campos en el modal de nueva orden.', icon: 'ClipboardList' },
    ]
  },
  {
    id: 'catalogs',
    title: 'Catálogos del Sistema',
    icon: 'Layers',
    color: 'from-orange-500/20 to-amber-500/20',
    items: [
      { name: 'Opciones y Estados', path: '/catalog-center', desc: 'Administra clientes, brandings, colores y estados (dropdowns).', icon: 'Tags' },
      { name: 'Operadores', path: '/operators-center', desc: 'Gestión de operadores para progreso de producción.', icon: 'UserSquare' },
    ]
  },
  {
    id: 'insights',
    title: 'Insights & Reportes',
    icon: 'LayoutDashboard',
    color: 'from-blue-500/20 to-indigo-500/20',
    roles: ['admin', 'ceo'],
    items: [
      { name: 'Dashboard Ejecutivo', path: '/ceo-dashboard', desc: 'Vista consolidada de KPIs de producción de la planta.', icon: 'TrendingUp' },
    ]
  }
];

const DEFAULT_ORDER = SECTIONS_DEFS.map(s => s.id);

const HomeDashboard = () => {
  const navigate = useNavigate();
  const { user } = useAuth();
  const [counts, setCounts] = useState({});
  const [order, setOrder] = useState(DEFAULT_ORDER);
  const [saving, setSaving] = useState(false);
  const [showColumnManager, setShowColumnManager] = useState(false);
  const [showFormFieldsManager, setShowFormFieldsManager] = useState(false);

  // Drag state refs (avoid re-renders mid-drag)
  const dragIdx = useRef(null);
  const [dragOverIdx, setDragOverIdx] = useState(null);

  // Load board counts
  useEffect(() => {
    fetch(`${API}/orders/board-counts`, { credentials: 'include' })
      .then(res => res.ok ? res.json() : {})
      .then(data => setCounts(data))
      .catch(() => {});
  }, []);

  // Load saved layout
  useEffect(() => {
    fetch(`${API}/config/home-layout`, { credentials: 'include' })
      .then(res => res.ok ? res.json() : null)
      .then(data => {
        if (data?.layout?.length === SECTIONS_DEFS.length) {
          // Validate that all ids are present
          const valid = data.layout.every(id => DEFAULT_ORDER.includes(id));
          if (valid) setOrder(data.layout);
        }
      })
      .catch(() => {});
  }, []);

  const saveLayout = useCallback(async (newOrder) => {
    setSaving(true);
    try {
      await fetch(`${API}/config/home-layout`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ layout: newOrder }),
      });
    } catch { /* silent */ } finally {
      setSaving(false);
    }
  }, []);

  // ── Drag & Drop handlers ──
  const handleDragStart = (e, idx) => {
    dragIdx.current = idx;
    e.dataTransfer.effectAllowed = 'move';
    // Delay to allow drag image to render first
    setTimeout(() => {
      const el = document.getElementById(`home-section-${idx}`);
      if (el) el.style.opacity = '0.35';
    }, 0);
  };

  const handleDragEnd = (e, idx) => {
    const el = document.getElementById(`home-section-${idx}`);
    if (el) el.style.opacity = '1';
    dragIdx.current = null;
    setDragOverIdx(null);
  };

  const handleDragOver = (e, idx) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    if (dragIdx.current !== null && dragIdx.current !== idx) {
      setDragOverIdx(idx);
    }
  };

  const handleDragLeave = () => setDragOverIdx(null);

  const handleDrop = (e, dropIdx) => {
    e.preventDefault();
    if (dragIdx.current === null || dragIdx.current === dropIdx) return;

    const newOrder = [...order];
    const [moved] = newOrder.splice(dragIdx.current, 1);
    newOrder.splice(dropIdx, 0, moved);

    setOrder(newOrder);
    setDragOverIdx(null);
    dragIdx.current = null;

    saveLayout(newOrder);
  };

  const handleCardClick = (item) => {
    if (item.board) navigate(`/dashboard?board=${item.board}`);
    else if (item.action === 'manageColumns') setShowColumnManager(true);
    else if (item.action === 'manageFormFields') setShowFormFieldsManager(true);
    else if (item.path) navigate(item.path);
    else navigate(`/dashboard?action=${item.action}`);
  };

  const orderedSections = order
    .map(id => SECTIONS_DEFS.find(s => s.id === id))
    .filter(Boolean)
    .filter(s => !s.roles || s.roles.includes(user?.role));

  return (
    <div className="min-h-screen bg-background p-6 md:p-10 font-barlow relative overflow-hidden">
      {/* Background glows */}
      <div className="absolute top-0 right-0 w-1/2 h-1/2 bg-primary/5 blur-[120px] rounded-full -translate-y-1/2 translate-x-1/2 pointer-events-none" />
      <div className="absolute bottom-0 left-0 w-1/3 h-1/3 bg-blue-500/5 blur-[100px] rounded-full translate-y-1/2 -translate-x-1/3 pointer-events-none" />

      <header className="mb-12 relative z-10 flex flex-col md:flex-row md:items-center justify-between gap-6">
        <div>
          <div className="flex items-center gap-4 mb-2">
            <div className="w-10 h-10 bg-primary/20 rounded-lg flex items-center justify-center border border-primary/30">
              <Factory className="w-6 h-6 text-primary" />
            </div>
            <h1 className="text-3xl md:text-4xl font-black uppercase tracking-tighter text-foreground">
              MOS <span className="text-primary tracking-normal font-medium">HOME</span>
            </h1>
          </div>
          <p className="text-muted-foreground font-medium max-w-xl">
            Panel de control centralizado.{' '}
            <span className="text-muted-foreground/50 text-xs font-mono">
              {saving ? '⟳ Guardando layout…' : '⠿ Arrastra las columnas para reorganizar'}
            </span>
          </p>
        </div>

        <button
          onClick={() => navigate('/dashboard')}
          className="flex items-center gap-2 px-5 py-2.5 bg-secondary hover:bg-white/10 text-foreground font-bold text-sm tracking-wider uppercase rounded-xl border border-border shadow-sm transition-all hover:-translate-y-0.5"
        >
          <ArrowLeft className="w-4 h-4" /> Volver al CRM
        </button>
      </header>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-10 relative z-10">
        {orderedSections.map((section, idx) => {
          const SectionIcon = ICON_MAP[section.icon] || Factory;
          const isDragTarget = dragOverIdx === idx;

          return (
            <section
              key={section.id}
              id={`home-section-${idx}`}
              draggable
              onDragStart={e => handleDragStart(e, idx)}
              onDragEnd={e => handleDragEnd(e, idx)}
              onDragOver={e => handleDragOver(e, idx)}
              onDragLeave={handleDragLeave}
              onDrop={e => handleDrop(e, idx)}
              className={`flex flex-col gap-6 rounded-2xl transition-all duration-200 ${
                isDragTarget
                  ? 'ring-2 ring-primary ring-offset-2 ring-offset-background shadow-[0_0_30px_rgba(255,193,7,0.15)] scale-[0.99]'
                  : ''
              }`}
            >
              {/* Column Header with drag handle */}
              <div className="flex items-center gap-3 border-b border-border pb-4 w-full group/header cursor-grab active:cursor-grabbing">
                <SectionIcon className="w-6 h-6 text-primary flex-shrink-0" />
                <h2 className="text-xl font-bold uppercase tracking-widest text-foreground/80 flex-1">{section.title}</h2>
                <GripVertical className="w-4 h-4 text-muted-foreground/30 group-hover/header:text-primary/60 transition-colors flex-shrink-0" />
              </div>

              <div className="flex flex-col gap-5">
                {section.items.map((item, i) => {
                  const ItemIcon = ICON_MAP[item.icon] || Factory;
                  return (
                    <div
                      key={i}
                      onClick={() => handleCardClick(item)}
                      className="group relative bg-card/40 backdrop-blur-xl border border-white/5 rounded-2xl p-6 cursor-pointer hover:border-primary/50 transition-all duration-300 hover:shadow-[0_10px_40px_rgba(0,0,0,0.3)] hover:-translate-y-1 overflow-hidden"
                    >
                      {/* Prevent drag from triggering on card clicks */}
                      <div className={`absolute inset-0 bg-gradient-to-br ${section.color} opacity-0 group-hover:opacity-100 transition-opacity duration-500`} />

                      <div className="relative z-10">
                        <div className="flex justify-between items-start mb-6">
                          <div className="p-3 bg-secondary/50 rounded-xl group-hover:bg-primary/20 group-hover:scale-110 transition-all duration-300">
                            <ItemIcon className="w-6 h-6 text-muted-foreground group-hover:text-primary transition-colors" />
                          </div>
                          {item.board && (
                            <div className="bg-primary/10 border border-primary/20 px-3 py-1 rounded-full animate-pulse shadow-[0_0_15px_rgba(255,193,7,0.2)]">
                              <span className="text-[10px] font-black text-primary uppercase tracking-widest">
                                {counts[item.board] || 0} ORDS
                              </span>
                            </div>
                          )}
                        </div>

                        <h3 className="text-xl font-black text-foreground mb-2 uppercase tracking-wide group-hover:text-primary transition-colors">
                          {item.name}
                        </h3>
                        <p className="text-sm text-muted-foreground leading-relaxed font-medium line-clamp-2 italic">
                          {item.desc}
                        </p>

                        <div className="mt-6 flex items-center text-[10px] font-black text-primary uppercase tracking-[0.2em] opacity-0 group-hover:opacity-100 translate-y-2 group-hover:translate-y-0 transition-all duration-300">
                          Entrar al módulo <Factory className="w-3 h-3 ml-2" />
                        </div>
                      </div>

                      {/* Tech decorative line */}
                      <div className="absolute bottom-0 left-0 h-1 w-0 bg-primary transition-all duration-500 group-hover:w-full" />
                    </div>
                  );
                })}
              </div>
            </section>
          );
        })}
      </div>

      <footer className="mt-20 pt-10 border-t border-border flex justify-between items-center text-[10px] font-bold text-muted-foreground/40 uppercase tracking-[0.3em]">
        <div>MOS SYSTEM v5.4.0</div>
        <div>Control Industrial de Alta Precisión</div>
      </footer>

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
