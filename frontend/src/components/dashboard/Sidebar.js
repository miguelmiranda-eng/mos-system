import React, { useState } from 'react';
import {
  ChevronRight,
  ChevronLeft,
  Settings,
  Users,
  History,
  BarChart3,
  Trash2,
  Box,
  Cpu,
  ChevronDown,
  ShieldCheck
} from 'lucide-react';
import { cn } from '../../lib/utils';
import { BOARD_COLORS } from '../../lib/constants';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../ui/collapsible";

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
  navigate,
  isDark
}) => {
  const machineBoards = boards.filter(b => b.startsWith('MAQUINA'));
  const regularBoards = boards.filter(b => !b.startsWith('MAQUINA'));
  const isAnyMachineActive = machineBoards.includes(currentBoard);
  const [isMachinesOpen, setIsMachinesOpen] = useState(isAnyMachineActive);

  return (
    <aside
      className={cn(
        "flex flex-col transition-all duration-300 border-r z-50",
        isCollapsed ? "w-16" : "w-64",
        isDark ? "bg-navy-dark border-white/5 text-white" : "bg-white border-royal/10 text-foreground shadow-xl"
      )}
    >
      {/* Sidebar Header — blue-tinted in light mode */}
      <div className={cn(
        "h-16 flex items-center justify-between px-4 border-b",
        isDark ? "border-white/5" : "bg-royal/5 border-royal/15"
      )}>
        {!isCollapsed && (
          <button
            onClick={() => navigate('/home')}
            className="text-left hover:opacity-80 transition-opacity flex flex-col leading-tight"
          >
            <span className={cn("font-barlow-semi font-bold text-xl tracking-tighter", isDark ? "text-white" : "text-navy")}>
              MOS <span className="text-royal">SYSTEM</span>
            </span>
            <span className={cn("text-[13px] font-bold uppercase tracking-[0.12em]", isDark ? "text-white/60" : "text-navy/60")}>
              by <span className={cn("font-black text-base", isDark ? "text-royal" : "text-royal")}>Prosper Mfg.</span>
            </span>
          </button>
        )}
        <button
          onClick={() => setIsCollapsed(!isCollapsed)}
          className={cn("p-1.5 rounded transition-colors", isDark ? "hover:bg-white/10 text-white/60" : "hover:bg-royal/10 text-royal/60 hover:text-royal")}
        >
          {isCollapsed ? <ChevronRight size={18} /> : <ChevronLeft size={18} />}
        </button>
      </div>

      {/* Primary Navigation */}
      <div className="flex-1 py-4 overflow-y-auto custom-scrollbar">
        <div className="px-3 mb-2">
          {!isCollapsed && <p className={cn("text-[10px] font-bold uppercase tracking-widest px-3 mb-2", isDark ? "text-white/40" : "text-royal/60")}>Tableros</p>}
          <nav className="space-y-1">
            {regularBoards.map((board) => (
              <button
                key={board}
                onClick={() => setCurrentBoard(board)}
                className={cn(
                  "w-full flex items-center gap-3 px-3 py-2 rounded-lg transition-all text-sm font-semibold",
                  currentBoard === board
                    ? "bg-royal text-white shadow-lg shadow-royal/25"
                    : isDark
                      ? "text-white/70 hover:bg-royal/10 hover:text-white"
                      : "text-foreground/70 hover:bg-royal/8 hover:text-royal"
                )}
                title={isCollapsed ? board : ""}
              >
                <div
                  className="w-2 h-2 rounded-full flex-shrink-0"
                  style={{ backgroundColor: currentBoard === board ? 'rgba(255,255,255,0.8)' : (BOARD_COLORS[board]?.accent || '#666') }}
                />
                {!isCollapsed && <span className="truncate">{board}</span>}
              </button>
            ))}

            {!isCollapsed && machineBoards.length > 0 && (
              <Collapsible open={isMachinesOpen} onOpenChange={setIsMachinesOpen} className="w-full">
                <CollapsibleTrigger asChild>
                  <button className={cn(
                    "w-full flex items-center gap-3 px-3 py-2 rounded-lg transition-all text-sm font-semibold group mt-2",
                    isAnyMachineActive && !isMachinesOpen
                      ? "bg-royal/10 text-royal"
                      : isDark ? "text-white/70 hover:bg-royal/10 hover:text-white" : "text-foreground/70 hover:bg-royal/8 hover:text-royal"
                  )}>
                    <Cpu size={18} className={cn(isAnyMachineActive ? "text-royal" : "text-muted-foreground")} />
                    <span className="flex-1 text-left font-barlow-semi font-bold tracking-wide">MÁQUINAS</span>
                    <ChevronDown size={14} className={cn("transition-transform duration-200", isMachinesOpen && "rotate-180")} />
                  </button>
                </CollapsibleTrigger>
                <CollapsibleContent className="space-y-1 mt-1 ml-4 pl-2 border-l border-royal/20">
                  {machineBoards.map((board) => (
                    <button
                      key={board}
                      onClick={() => setCurrentBoard(board)}
                      className={cn(
                        "w-full flex items-center gap-3 px-3 py-1.5 rounded-lg transition-all text-xs font-semibold",
                        currentBoard === board
                          ? "bg-royal text-white"
                          : isDark ? "text-white/50 hover:bg-royal/10 hover:text-white" : "text-foreground/50 hover:bg-royal/8 hover:text-royal"
                      )}
                    >
                      <div className="w-1.5 h-1.5 rounded-full flex-shrink-0" style={{ backgroundColor: BOARD_COLORS[board]?.accent || '#666' }} />
                      <span className="truncate">{board}</span>
                    </button>
                  ))}
                </CollapsibleContent>
              </Collapsible>
            )}

            {isCollapsed && machineBoards.length > 0 && (
              <button
                onClick={() => { setIsCollapsed(false); setIsMachinesOpen(true); }}
                className={cn(
                  "w-full flex justify-center py-2 rounded-lg transition-all mt-2",
                  isAnyMachineActive ? "text-royal bg-royal/10" : isDark ? "text-white/40 hover:bg-royal/10" : "text-foreground/40 hover:bg-royal/8"
                )}
                title="MÁQUINAS"
              >
                <Cpu size={18} />
              </button>
            )}
          </nav>
        </div>

        <div className="px-3 mt-6">
          {!isCollapsed && <p className={cn("text-[10px] font-bold uppercase tracking-widest px-3 mb-2", isDark ? "text-white/40" : "text-royal/60")}>Herramientas</p>}
          <nav className="space-y-1">
            <button
              onClick={() => navigate('/qc')}
              className={cn("w-full flex items-center gap-3 px-3 py-2 rounded-lg transition-all text-sm font-semibold", isDark ? "text-white/70 hover:bg-royal/10 hover:text-white" : "text-foreground/70 hover:bg-royal/8 hover:text-royal")}
            >
              <ShieldCheck size={18} />
              {!isCollapsed && <span>Control de Calidad</span>}
            </button>
            <button
              onClick={onShowAnalytics}
              className={cn("w-full flex items-center gap-3 px-3 py-2 rounded-lg transition-all text-sm font-semibold", isDark ? "text-white/70 hover:bg-royal/10 hover:text-white" : "text-foreground/70 hover:bg-royal/8 hover:text-royal")}
            >
              <BarChart3 size={18} />
              {!isCollapsed && <span>Análisis</span>}
            </button>
            <button
              onClick={onShowTrash}
              className={cn(
                "w-full flex items-center gap-3 px-3 py-2 rounded-lg transition-all text-sm font-semibold",
                isDark ? "text-white/70 hover:bg-royal/10 hover:text-white" : "text-foreground/70 hover:bg-royal/8 hover:text-royal"
              )}
            >
              <div className="relative">
                <Trash2 size={18} />
                {trashCount > 0 && <span className="absolute -top-1 -right-1 w-2 h-2 bg-royal rounded-full animate-pulse" />}
              </div>
              {!isCollapsed && <span className="flex-1 text-left">Papelera</span>}
              {!isCollapsed && trashCount > 0 && <span className={cn("text-[10px] px-1.5 rounded", isDark ? "bg-royal/20 text-royal" : "bg-royal/10 text-royal")}>{trashCount}</span>}
            </button>
          </nav>
        </div>

        {isAdmin && (
          <div className="px-3 mt-6">
            {!isCollapsed && <p className={cn("text-[10px] font-bold uppercase tracking-widest px-3 mb-2", isDark ? "text-white/40" : "text-royal/60")}>Admin</p>}
            <nav className="space-y-1">
              <button onClick={() => navigate('/users')} className={cn("w-full flex items-center gap-3 px-3 py-2 rounded-lg transition-all text-sm font-semibold", isDark ? "text-white/70 hover:bg-royal/10 hover:text-white" : "text-foreground/70 hover:bg-royal/8 hover:text-royal")}>
                <Users size={18} />
                {!isCollapsed && <span>Usuarios</span>}
              </button>
              <button onClick={() => navigate('/activity-log')} className={cn("w-full flex items-center gap-3 px-3 py-2 rounded-lg transition-all text-sm font-semibold", isDark ? "text-white/70 hover:bg-royal/10 hover:text-white" : "text-foreground/70 hover:bg-royal/8 hover:text-royal")}>
                <History size={18} />
                {!isCollapsed && <span>Log Actividad</span>}
              </button>
              <button onClick={() => navigate('/catalog-center')} className={cn("w-full flex items-center gap-3 px-3 py-2 rounded-lg transition-all text-sm font-semibold", isDark ? "text-white/70 hover:bg-royal/10 hover:text-white" : "text-foreground/70 hover:bg-royal/8 hover:text-royal")}>
                <Box size={18} />
                {!isCollapsed && <span>Catálogos</span>}
              </button>
            </nav>
          </div>
        )}
      </div>

      {/* Sidebar Footer removed per user request */}
    </aside>
  );
};

export default Sidebar;
