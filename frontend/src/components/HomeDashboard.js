import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { 
  Factory, Warehouse, Settings, Zap, History, Users, 
  LayoutDashboard, ClipboardList, Database, 
  TrendingUp, Monitor, Package, Gauge, ListCheck, Boxes
} from 'lucide-react';
import { API } from '../lib/constants';

const HomeDashboard = () => {
  const navigate = useNavigate();
  const [counts, setCounts] = useState({});
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch(`${API}/orders/board-counts`, { credentials: 'include' })
      .then(res => res.ok ? res.json() : {})
      .then(data => {
        setCounts(data);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

  const sections = [
    {
      title: 'Procesos de Producción',
      icon: <Factory className="w-6 h-6 text-primary" />,
      color: 'from-blue-500/20 to-cyan-500/20',
      items: [
        { name: 'MASTER', board: 'MASTER', desc: 'Vista global de todas las órdenes en el sistema.', icon: <LayoutDashboard /> },
        { name: 'SCHEDULING', board: 'SCHEDULING', desc: 'Planificación y asignación inicial de órdenes.', icon: <ClipboardList /> },
        { name: 'BLANKS', board: 'BLANKS', desc: 'Seguimiento de inventario de prendas base.', icon: <Package /> },
        { name: 'SCREENS', board: 'SCREENS', desc: 'Gestión de marcos y revelado para impresión.', icon: <Monitor /> },
        { name: 'NECK', board: 'NECK', desc: 'Control de etiquetas de cuello y acabados.', icon: <Gauge /> },
        { name: 'MAQUINAS', board: 'MAQUINA1', desc: 'Monitoreo de producción en prensas activas.', icon: <Settings /> },
        { name: 'EJEMPLOS', board: 'EJEMPLOS', desc: 'Gestión de muestras y aprobaciones de arte.', icon: <ListCheck /> },
        { name: 'FINAL BILL', board: 'FINAL BILL', desc: 'Órdenes listas para facturación y cierre.', icon: <TrendingUp /> }
      ]
    },
    {
      title: 'Gestión de Inventario',
      icon: <Warehouse className="w-6 h-6 text-primary" />,
      color: 'from-emerald-500/20 to-teal-500/20',
      items: [
        { name: 'WMS Central', path: '/wms', desc: 'Gestión completa de almacén y ubicaciones.', icon: <Warehouse /> },
        { name: 'Stock de Tintas', path: '/wms?tab=tintas', desc: 'Control de inventario de insumos químicos.', icon: <Boxes /> },
        { name: 'Mantenimiento', path: '/wms?tab=logs', desc: 'Registro de movimientos y auditoría.', icon: <Database /> }
      ]
    },
    {
      title: 'Configuraciones & Logs',
      icon: <Zap className="w-6 h-6 text-primary" />,
      color: 'from-purple-500/20 to-pink-500/20',
      items: [
        { name: 'Activity Log', path: '/activity-log', desc: 'Historial detallado de cambios y acciones.', icon: <History /> },
        { name: 'Automatizaciones', path: '/automation-center', desc: 'Configuración de reglas inteligentes.', icon: <Zap /> },
        { name: 'Usuarios', path: '/users', desc: 'Gestión de permisos y accesos del equipo.', icon: <Users /> }
      ]
    }
  ];

  const handleCardClick = (item) => {
    if (item.board) {
      navigate(`/dashboard?board=${item.board}`);
    } else if (item.path) {
      navigate(item.path);
    } else {
      // For actions that open modals, we navigate to dashboard and use URL params or state
      navigate(`/dashboard?action=${item.action}`);
    }
  };

  return (
    <div className="min-h-screen bg-background p-6 md:p-10 font-barlow relative overflow-hidden">
      {/* Background patterns */}
      <div className="absolute top-0 right-0 w-1/2 h-1/2 bg-primary/5 blur-[120px] rounded-full -translate-y-1/2 translate-x-1/2 pointer-events-none"></div>
      <div className="absolute bottom-0 left-0 w-1/3 h-1/3 bg-blue-500/5 blur-[100px] rounded-full translate-y-1/2 -translate-x-1/3 pointer-events-none"></div>

      <header className="mb-12 relative z-10">
        <div className="flex items-center gap-4 mb-2">
          <div className="w-10 h-10 bg-primary/20 rounded-lg flex items-center justify-center border border-primary/30">
            <Factory className="w-6 h-6 text-primary" />
          </div>
          <h1 className="text-3xl md:text-4xl font-black uppercase tracking-tighter text-foreground">
            MOS <span className="text-primary tracking-normal font-medium">HOME</span>
          </h1>
        </div>
        <p className="text-muted-foreground font-medium max-w-xl">
          Panel de control centralizado. Seleccione un módulo para comenzar la gestión industrial de órdenes e inventario.
        </p>
      </header>

      <div className="space-y-16 relative z-10">
        {sections.map((section, idx) => (
          <section key={idx} className="space-y-6">
            <div className="flex items-center gap-3 border-b border-border pb-4">
              {section.icon}
              <h2 className="text-xl font-bold uppercase tracking-widest text-foreground/80">{section.title}</h2>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-6">
              {section.items.map((item, i) => (
                <div
                  key={i}
                  onClick={() => handleCardClick(item)}
                  className={`group relative bg-card/40 backdrop-blur-xl border border-white/5 rounded-2xl p-6 cursor-pointer hover:border-primary/50 transition-all duration-300 hover:shadow-[0_10px_40px_rgba(0,0,0,0.3)] hover:-translate-y-1 overflow-hidden`}
                >
                   {/* Gradient hover background */}
                  <div className={`absolute inset-0 bg-gradient-to-br ${section.color} opacity-0 group-hover:opacity-100 transition-opacity duration-500`}></div>
                  
                  <div className="relative z-10">
                    <div className="flex justify-between items-start mb-6">
                      <div className="p-3 bg-secondary/50 rounded-xl group-hover:bg-primary/20 group-hover:scale-110 transition-all duration-300">
                        {React.cloneElement(item.icon, { className: "w-6 h-6 text-muted-foreground group-hover:text-primary transition-colors" })}
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
                      Entrar al proceso <Factory className="w-3 h-3 ml-2" />
                    </div>
                  </div>

                  {/* Tech decorative line */}
                  <div className="absolute bottom-0 left-0 h-1 w-0 bg-primary transition-all duration-500 group-hover:w-full"></div>
                </div>
              ))}
            </div>
          </section>
        ))}
      </div>

      <footer className="mt-20 pt-10 border-t border-border flex justify-between items-center text-[10px] font-bold text-muted-foreground/40 uppercase tracking-[0.3em]">
        <div>MOS SYSTEM v5.4.0</div>
        <div>Control Industrial de Alta Precisión</div>
      </footer>
    </div>
  );
};

export default HomeDashboard;
