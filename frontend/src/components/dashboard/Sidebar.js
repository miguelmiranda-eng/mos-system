import React, { useState, useEffect } from 'react';
import {
  ChevronRight,
  ChevronLeft,
  Users,
  History,
  BarChart3,
  Trash2,
  Box,
  Cpu,
  ChevronDown,
  ShieldCheck,
  Sparkles,
  Palette,
  CalendarDays,
  Truck,
  LayoutTemplate,
  Shirt,
  Layers,
  Beaker,
  CheckCircle,
  Receipt,
  Globe,
  Folder,
  Wrench,
  ClipboardList,
  CalendarClock,
  Zap,
} from 'lucide-react';
import { cn } from '../../lib/utils';
import { BOARD_COLORS } from '../../lib/constants';
import { BUILD_TAG } from '../../buildInfo';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../ui/collapsible";

const toTitle = (str) => str.toLowerCase().replace(/\b\w/g, c => c.toUpperCase());

const getBoardIcon = (board) => {
  const b = board.toUpperCase();
  if (b.includes('MASTER')) return LayoutTemplate;
  if (b.includes('SCHEDULING') || b.includes('READY')) return CalendarDays;
  if (b.includes('BLANKS') || b.includes('NECK')) return Shirt;
  if (b.includes('SCREENS')) return Layers;
  if (b.includes('EJEMPLOS')) return Beaker;
  if (b.includes('COMPLETOS')) return CheckCircle;
  if (b.includes('BILL')) return Receipt;
  if (b.includes('CALIDAD')) return ShieldCheck;
  if (b.includes('EDI')) return Globe;
  if (b.includes('MAQUINA')) return Cpu;
  return Folder;
};

const Sidebar = ({
  isCollapsed,
  setIsCollapsed,
  currentBoard,
  setCurrentBoard,
  boards,
  trashCount,
  onShowTrash,
  onShowAnalytics,
  isAdmin,
  userRole,
  navigate,
  isDark,
  isMobile,
  isOpen,
  onClose,
  showTrash = false,
  showAnalytics = false
}) => {
  const isPicker = userRole === 'picker';
  const machineBoards = boards.filter(b => b.startsWith('MAQUINA'));
  const regularBoards = boards.filter(b => !b.startsWith('MAQUINA'));
  const isAnyMachineActive = machineBoards.includes(currentBoard);
  const [isMachinesOpen, setIsMachinesOpen] = useState(isAnyMachineActive);
  const [isToolsOpen, setIsToolsOpen] = useState(showTrash || showAnalytics);

  useEffect(() => {
    if (showTrash || showAnalytics) {
      setIsToolsOpen(true);
    }
  }, [showTrash, showAnalytics]);

  const navItem = (isActive) => cn(
    "w-full flex items-center gap-3 px-3 py-[7px] transition-colors duration-100 text-[14px] font-medium rounded-sm",
    isActive
      ? isDark ? "text-foreground bg-white/5" : "text-royal font-semibold bg-royal/5"
      : isDark ? "text-muted-foreground hover:text-foreground hover:bg-white/5" : "text-muted-foreground hover:text-foreground hover:bg-black/5"
  );

  const iconCls = (isActive) => cn(
    "flex-shrink-0 transition-colors",
    isActive
      ? isDark ? "text-foreground" : "text-royal"
      : isDark ? "text-muted-foreground/70" : "text-muted-foreground/70"
  );

  const sectionLabel = cn(
    "text-[11px] font-bold uppercase tracking-[0.15em] px-3 pt-4 pb-1 text-muted-foreground/70"
  );

  const isTablet = typeof window !== 'undefined' && window.innerWidth < 1024;

  return (
    <>
      {/* Backdrop for mobile/tablet — solid (no backdrop-blur: it corrupts the
          GPU layer on Android Chrome and paints garbage/noise over the drawer). */}
      {(isMobile || isTablet) && isOpen && (
        <div
          className="fixed inset-0 bg-black/50 z-[100] transition-opacity duration-300"
          onClick={onClose}
        />
      )}

      <aside
        className={cn(
          "flex flex-col transition-all duration-300 flex-shrink-0 overflow-hidden bg-card transform-gpu",
          (isMobile || isTablet)
            ? cn("fixed inset-y-0 left-0 z-[101] w-72 shadow-[20px_0_50px_rgba(0,0,0,0.15)] transform", isOpen ? "translate-x-0" : "-translate-x-full")
            : cn("relative z-50", isCollapsed ? "w-14" : "w-64"),
          "border-r border-border"
        )}
        style={{ backfaceVisibility: 'hidden', WebkitBackfaceVisibility: 'hidden' }}
      >
        {/* Header */}
        <div className={cn(
          "h-14 flex items-center justify-between px-4 border-b flex-shrink-0",
          isDark ? "border-white/6" : "border-neutral-200"
        )}>
          {(isOpen || !isCollapsed) && (
          <button
            onClick={() => navigate('/home')}
            className="text-left hover:opacity-70 transition-opacity leading-none"
          >
            <span className={cn("text-[15px] font-bold tracking-tight block text-foreground")}>
              MOS <span className="text-royal">System</span>
            </span>
            <span className={cn("text-[11px] font-medium text-muted-foreground")}>
              Prosper Mfg.
            </span>
          </button>
        )}
        {!isMobile && (
          <button
            onClick={() => setIsCollapsed(!isCollapsed)}
            className={cn("p-1 rounded transition-colors flex-shrink-0 ml-auto", isDark ? "text-white/20 hover:text-white/50" : "text-neutral-400 hover:text-neutral-600")}
          >
            {isCollapsed ? <ChevronRight size={15} /> : <ChevronLeft size={15} />}
          </button>
        )}
      </div>

      {/* Nav — opaque background so the scroll area never composites into a
          transparent GPU layer (that painted random noise over the top boards
          on Android Chrome). No forced transform-gpu here for the same reason. */}
      <div className="flex-1 overflow-y-auto custom-scrollbar pb-4 bg-card">

        {/* Picker Specific View */}
        {isPicker ? (
          <nav className="px-2 pt-4">
             <button onClick={() => { navigate('/operator'); if (isMobile) onClose(); }} className={navItem(true)} title="Vista de Surtido">
                <Box size={15} className={iconCls(true)} />
                {(isOpen || !isCollapsed) && <span>Vista de Surtido</span>}
             </button>
          </nav>
        ) : (
          <>
            {/* Boards */}
            {(isOpen || !isCollapsed) && <p className={sectionLabel}>General</p>}
            <nav className="px-2">
              {regularBoards.map((board) => {
                const IconComponent = getBoardIcon(board);
                const isActive = currentBoard === board;
                return (
                <button
                  key={board}
                  onClick={() => {
                    setCurrentBoard(board);
                    if (isMobile) onClose();
                  }}
                  className={navItem(isActive)}
                  title={isCollapsed && !isMobile ? board : ""}
                >
                  <IconComponent 
                    size={15} 
                    className={cn("flex-shrink-0 transition-transform", isActive ? "scale-110 opacity-100" : "opacity-60")}
                    style={{ color: BOARD_COLORS[board]?.accent || (isDark ? '#888' : '#aaa') }}
                  />
                  {(isOpen || !isCollapsed) && <span className="truncate">{toTitle(board)}</span>}
                </button>
              )})}

              {/* Machines collapsible */}
              {(isOpen || !isCollapsed) && machineBoards.length > 0 && (
                <Collapsible open={isMachinesOpen} onOpenChange={setIsMachinesOpen} className="w-full">
                  <CollapsibleTrigger asChild>
                    <button className={navItem(isAnyMachineActive)}>
                      <Cpu size={15} className={iconCls(isAnyMachineActive)} />
                      <span className="flex-1 text-left">máquinas</span>
                      <ChevronDown size={13} className={cn("flex-shrink-0 transition-transform duration-150", isDark ? "text-white/20" : "text-neutral-400", isMachinesOpen && "rotate-180")} />
                    </button>
                  </CollapsibleTrigger>
                  <CollapsibleContent className="ml-4 pl-2 border-l border-neutral-200/60 dark:border-white/8">
                    {machineBoards.map((board) => {
                      const IconComponent = getBoardIcon(board);
                      const isActive = currentBoard === board;
                      return (
                      <button
                        key={board}
                        onClick={() => {
                          setCurrentBoard(board);
                          if (isMobile) onClose();
                        }}
                        className={navItem(isActive)}
                      >
                        <IconComponent 
                          size={15} 
                          className={cn("flex-shrink-0 transition-transform", isActive ? "scale-110 opacity-100" : "opacity-60")}
                          style={{ color: BOARD_COLORS[board]?.accent || (isDark ? '#888' : '#aaa') }}
                        />
                        <span className="truncate">{toTitle(board)}</span>
                      </button>
                    )})}
                  </CollapsibleContent>
                </Collapsible>
              )}

              {isCollapsed && !isMobile && machineBoards.length > 0 && (
                <button
                  onClick={() => { setIsCollapsed(false); setIsMachinesOpen(true); }}
                  className={navItem(isAnyMachineActive)}
                  title="Máquinas"
                >
                  <Cpu size={15} className={iconCls(isAnyMachineActive)} />
                </button>
              )}
            </nav>

            {/* Tools Collapsible */}
            {isCollapsed && !isMobile && (
              <nav className="px-2 mt-4 border-t border-neutral-200/50 dark:border-white/5 pt-4">
                <button
                  onClick={() => { setIsCollapsed(false); setIsToolsOpen(true); }}
                  className={navItem(showTrash || showAnalytics)}
                  title="Herramientas"
                >
                  <Wrench size={15} className={iconCls(showTrash || showAnalytics)} />
                </button>
              </nav>
            )}

            {(isOpen || !isCollapsed) && (
              <nav className="px-2 mt-4 border-t border-neutral-200/50 dark:border-white/5 pt-4">
                <Collapsible open={isToolsOpen} onOpenChange={setIsToolsOpen} className="w-full">
                  <CollapsibleTrigger asChild>
                    <button className={navItem(showTrash || showAnalytics)}>
                      <Wrench size={15} className={iconCls(showTrash || showAnalytics)} />
                      <span className="flex-1 text-left">Herramientas</span>
                      <ChevronDown size={13} className={cn("flex-shrink-0 transition-transform duration-150", isDark ? "text-white/20" : "text-neutral-400", isToolsOpen && "rotate-180")} />
                    </button>
                  </CollapsibleTrigger>
                  <CollapsibleContent className="ml-4 pl-2 border-l border-neutral-200/60 dark:border-white/8 space-y-0.5 mt-0.5">
                    <button onClick={() => { navigate('/qc'); if (isMobile) onClose(); }} className={navItem(false)} title="Control de Calidad">
                      <ShieldCheck size={15} className={iconCls(false)} />
                      <span>Control de Calidad</span>
                    </button>
                    <button onClick={() => { navigate('/art'); if (isMobile) onClose(); }} className={navItem(false)} title="Módulo de Arte">
                      <Palette size={15} className={iconCls(false)} />
                      <span>Módulo de Arte</span>
                    </button>
                    <button onClick={() => { navigate('/insights'); if (isMobile) onClose(); }} className={navItem(false)} title="Insights">
                      <Sparkles size={15} className={iconCls(false)} />
                      <span>Insights</span>
                    </button>
                    <button onClick={() => { navigate('/shipping'); if (isMobile) onClose(); }} className={navItem(false)} title="Envíos">
                      <Truck size={15} className={iconCls(false)} />
                      <span>Envíos</span>
                    </button>
                    <button onClick={() => { navigate('/packing'); if (isMobile) onClose(); }} className={navItem(false)} title="Packing List">
                      <Box size={15} className={iconCls(false)} />
                      <span>Packing List</span>
                    </button>
                    <button onClick={() => { navigate('/registros'); if (isMobile) onClose(); }} className={navItem(false)} title="Registros (Producción / Neck)">
                      <ClipboardList size={15} className={iconCls(false)} />
                      <span>Registros</span>
                    </button>
                    <button onClick={() => { onShowTrash(); if (isMobile) onClose(); }} className={navItem(showTrash)} title="Papelera">
                      <div className="relative flex-shrink-0">
                        <Trash2 size={15} className={iconCls(showTrash)} />
                        {trashCount > 0 && <span className="absolute -top-0.5 -right-0.5 w-1.5 h-1.5 bg-royal rounded-full" />}
                      </div>
                      <span className="flex-1 text-left">Papelera</span>
                      {trashCount > 0 && (
                        <span className={cn("text-[10px] px-1.5 py-0.5 rounded font-bold tabular-nums", isDark ? "bg-royal/20 text-royal" : "bg-royal/10 text-royal/80")}>
                          {trashCount}
                        </span>
                      )}
                    </button>
                  </CollapsibleContent>
                </Collapsible>
              </nav>
            )}

            {/* Admin */}
            {isAdmin && (
              <>
                {(isOpen || !isCollapsed) && <p className={sectionLabel}>Admin</p>}
                <nav className="px-2">
                  <button onClick={() => { navigate('/users'); if (isMobile) onClose(); }} className={navItem(false)} title={isCollapsed && !isMobile ? "Usuarios" : ""}>
                    <Users size={15} className={iconCls(false)} />
                    {(isOpen || !isCollapsed) && <span>Usuarios</span>}
                  </button>
                  <button onClick={() => { navigate('/activity-log'); if (isMobile) onClose(); }} className={navItem(false)} title={isCollapsed && !isMobile ? "Log Actividad" : ""}>
                    <History size={15} className={iconCls(false)} />
                    {(isOpen || !isCollapsed) && <span>Log Actividad</span>}
                  </button>
                  <button onClick={() => { navigate('/catalog-center'); if (isMobile) onClose(); }} className={navItem(false)} title={isCollapsed && !isMobile ? "Catálogos" : ""}>
                    <Box size={15} className={iconCls(false)} />
                    {(isOpen || !isCollapsed) && <span>Catálogos</span>}
                  </button>
                  <button onClick={() => { navigate('/reportes-programados'); if (isMobile) onClose(); }} className={navItem(false)} title={isCollapsed && !isMobile ? "Reportes Programados" : ""}>
                    <CalendarClock size={15} className={iconCls(false)} />
                    {(isOpen || !isCollapsed) && <span>Reportes Programados</span>}
                  </button>
                  <button onClick={() => { navigate('/printavo-sync'); if (isMobile) onClose(); }} className={navItem(false)} title={isCollapsed && !isMobile ? "Sync Printavo" : ""}>
                    <Zap size={15} className={iconCls(false)} />
                    {(isOpen || !isCollapsed) && <span>Sync Printavo</span>}
                  </button>
                </nav>
              </>
            )}
          </>
        )}
      </div>

      {/* Footer */}
      {(isOpen || !isCollapsed) && (
        <div className={cn("px-4 py-3 border-t text-[11px]", isDark ? "border-white/6 text-white/20" : "border-neutral-200 text-neutral-400")}>
          MOS <span className={isDark ? "text-royal/60" : "text-royal/70"}>System</span> · Prosper Mfg.
          <span className="ml-1 font-bold text-royal/70">· {BUILD_TAG}</span>
        </div>
      )}
    </aside>
    </>
  );
};

export default Sidebar;
