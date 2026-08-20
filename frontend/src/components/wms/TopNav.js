/* Barra superior del WMS — cinco menús agrupados en lugar del sidebar.

   FASE 1 del rediseño: esta barra convive con el sidebar detrás de la bandera
   `mos_wms_nav` (ver WMS.js). Sólo navega; el encabezado de módulo, la
   búsqueda global de caja y el reloj siguen donde estaban — eso se toca en la
   fase 3.

   Nada de mecánica: los permisos ya vienen resueltos en `groups`, que llega
   filtrado por `filterModules`. Aquí no se decide quién ve qué. */

import { useEffect, useRef, useState } from "react";
import { ArrowLeft, X } from "lucide-react";
import { badgeOf, groupBadge } from "./modules";
import { ProsperMark } from "../ProsperMark";

/* Rótulo de la barra: la marca de Prosper + el nombre del sistema. Sin
   itálica ni Barlow — hereda Blinker, la tipografía del sitio. */
const Wordmark = () => (
  <span className="text-lg font-extrabold tracking-tight flex items-center gap-2 whitespace-nowrap">
    <ProsperMark className="w-[22px] h-[22px] text-primary shrink-0" />
    MOS <span className="text-primary ml-0.5">WMS</span>
  </span>
);

/* Insignia de contador. `soft` la usa el grupo, para que el número del módulo
   dentro del menú sea el que resalte. */
const Badge = ({ n, soft = false }) => n > 0 ? (
  <span className={`text-[10px] font-semibold tabular-nums rounded-full min-w-[18px] h-[18px] px-1.5
    inline-flex items-center justify-center
    ${soft ? 'bg-muted text-muted-foreground' : 'bg-primary text-primary-foreground'}`}>
    {n}
  </span>
) : null;

/* Un renglón del menú: icono, rótulo, descripción y contador. La descripción
   es la misma que hoy se desperdicia en el encabezado del módulo; aquí sirve
   para decidir antes de entrar. */
const ModuleItem = ({ m, badges, isActive, onSelect }) => {
  const Icon = m.icon;
  return (
    <button
      type="button"
      data-testid={`wms-nav-${m.id}`}
      onClick={() => onSelect(m.id)}
      className={`w-full flex items-center gap-3 px-2.5 py-2 rounded-md text-left transition-colors
        ${isActive ? 'bg-muted' : 'hover:bg-muted/70'}`}
    >
      <span className={`w-7 h-7 rounded-md flex items-center justify-center shrink-0
        ${isActive ? 'bg-primary/15' : 'bg-muted'}`}>
        <Icon className={`w-4 h-4 ${isActive ? 'text-primary' : 'text-muted-foreground'}`} />
      </span>
      <span className="flex flex-col min-w-0 flex-1">
        <span className="text-sm font-medium leading-tight">{m.label}</span>
        <span className="text-xs text-muted-foreground leading-tight mt-0.5 truncate">{m.desc}</span>
      </span>
      <Badge n={badgeOf(m, badges)} />
      {(m.supersuOnly || m.adminOnly) && (
        <span className="text-[9px] uppercase tracking-wide font-mono text-muted-foreground border border-border rounded px-1 py-px">
          {m.supersuOnly ? 'supersu' : 'admin'}
        </span>
      )}
    </button>
  );
};

export function TopNav({
  groups,
  activeId,
  onSelect,
  badges,
  onBack,
  backTitle,
  mobileOpen,
  onMobileClose,
  right,
}) {
  const [open, setOpen] = useState(null);   // id del grupo abierto
  const barRef = useRef(null);

  // Cerrar al hacer clic fuera o con Escape. El listener sólo vive mientras
  // hay un menú abierto para no colgar handlers en cada render.
  useEffect(() => {
    if (!open) return;
    const onDocClick = (e) => {
      if (!barRef.current?.contains(e.target)) setOpen(null);
    };
    const onKey = (e) => { if (e.key === 'Escape') setOpen(null); };
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const pick = (id) => { setOpen(null); onMobileClose?.(); onSelect(id); };
  const activeGroup = groups.find(g => g.items.some(m => m.id === activeId));

  return (
    <>
      <header
        ref={barRef}
        className="h-[52px] shrink-0 flex items-center gap-1 px-3 bg-card border-b border-border relative z-30"
        data-testid="wms-topnav"
      >
        <button
          onClick={onBack}
          title={backTitle}
          className="p-1.5 rounded-lg bg-secondary/50 hover:bg-primary/20 text-muted-foreground hover:text-primary transition-all group shrink-0"
        >
          <ArrowLeft className="w-5 h-5 group-hover:-translate-x-0.5 transition-transform" />
        </button>

        <span className="pl-2 pr-3 mr-1 border-r border-border">
          <Wordmark />
        </span>

        {/* Grupos — ocultos en pantallas angostas, donde manda la hoja */}
        <nav className="hidden lg:flex items-center gap-0.5" aria-label="Módulos del WMS">
          {groups.map(g => {
            const isOpen = open === g.id;
            const isCurrent = activeGroup?.id === g.id;
            return (
              <div key={g.id} className="relative">
                <button
                  type="button"
                  data-testid={`wms-group-${g.id}`}
                  aria-expanded={isOpen}
                  onClick={() => setOpen(isOpen ? null : g.id)}
                  onMouseEnter={() => { if (open) setOpen(g.id); }}
                  className={`flex items-center gap-2 px-3 py-2 rounded-md text-sm font-semibold transition-colors
                    ${isOpen || isCurrent
                      ? 'bg-muted text-foreground'
                      : 'text-muted-foreground hover:bg-muted/70 hover:text-foreground'}`}
                >
                  {g.label}
                  <Badge n={groupBadge(g, badges)} />
                  {isCurrent && (
                    <span className="absolute left-3 right-3 -bottom-[9px] h-0.5 rounded-full bg-primary" />
                  )}
                </button>

                {isOpen && (
                  <div className="absolute left-0 top-full mt-2 w-[350px] max-w-[calc(100vw-2rem)] p-1.5
                                  bg-popover border border-border rounded-lg shadow-2xl z-40">
                    <div className="flex items-baseline justify-between px-2.5 pt-1.5 pb-2">
                      <span className="text-[11px] font-semibold uppercase tracking-widest text-muted-foreground">
                        {g.label}
                      </span>
                      <span className="text-xs text-muted-foreground">{g.hint}</span>
                    </div>
                    {g.items.map(m => (
                      <ModuleItem key={m.id} m={m} badges={badges}
                        isActive={m.id === activeId} onSelect={pick} />
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </nav>

        <div className="ml-auto flex items-center gap-2">{right}</div>
      </header>

      {/* Hoja de módulos — tabletas angostas y PDAs. Los grupos se vuelven
          encabezados de sección en vez de menús. */}
      {mobileOpen && (
        <div className="fixed inset-0 z-50 bg-background overflow-y-auto p-4" data-testid="wms-nav-sheet">
          <div className="flex items-center mb-2">
            <Wordmark />
            <button onClick={onMobileClose} title="Cerrar"
              className="ml-auto p-2 rounded-md border border-border text-muted-foreground active:bg-muted">
              <X className="w-5 h-5" />
            </button>
          </div>
          {groups.map(g => (
            <div key={g.id}>
              <div className="text-xs font-bold uppercase tracking-widest text-primary pt-5 pb-1.5 px-1 border-b border-border mb-1">
                {g.label}
              </div>
              {g.items.map(m => (
                <ModuleItem key={m.id} m={m} badges={badges}
                  isActive={m.id === activeId} onSelect={pick} />
              ))}
            </div>
          ))}
        </div>
      )}
    </>
  );
}

export default TopNav;
