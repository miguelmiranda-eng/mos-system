import React, { useState } from 'react';
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
} from 'lucide-react';
import { cn } from '../../lib/utils';
import { BOARD_COLORS } from '../../lib/constants';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../ui/collapsible";

const toTitle = (str) => str.toLowerCase().replace(/\b\w/g, c => c.toUpperCase());

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

  const navItem = (isActive) => cn(
    "w-full flex items-center gap-2.5 px-3 py-[5px] transition-colors duration-100 text-[12.5px] font-medium rounded-sm",
    isActive
      ? isDark ? "text-white" : "text-royal font-semibold"
      : isDark ? "text-white/45 hover:text-white/80" : "text-neutral-500 hover:text-neutral-800"
  );

  const iconCls = (isActive) => cn(
    "flex-shrink-0 transition-colors",
    isActive
      ? isDark ? "text-white/80" : "text-royal"
      : isDark ? "text-white/25" : "text-neutral-400"
  );

  const sectionLabel = cn(
    "text-[10px] font-bold uppercase tracking-[0.15em] px-3 pt-3 pb-1",
    isDark ? "text-white/25" : "text-neutral-400"
  );

  return (
    <aside
      className={cn(
        "flex flex-col transition-all duration-300 border-r z-50 flex-shrink-0",
        isCollapsed ? "w-12" : "w-48",
        isDark
          ? "bg-[hsl(222,28%,10%)] border-white/6"
          : "bg-[#f7f8fa] border-neutral-200"
      )}
    >
      {/* Header */}
      <div className={cn(
        "h-11 flex items-center justify-between px-3 border-b flex-shrink-0",
        isDark ? "border-white/6" : "border-neutral-200"
      )}>
        {!isCollapsed && (
          <button
            onClick={() => navigate('/home')}
            className="text-left hover:opacity-70 transition-opacity leading-none"
          >
            <span className={cn("text-[13px] font-bold tracking-tight block", isDark ? "text-white" : "text-navy")}>
              MOS <span className="text-royal">System</span>
            </span>
            <span className={cn("text-[10px] font-medium", isDark ? "text-white/35" : "text-neutral-400")}>
              Prosper Mfg.
            </span>
          </button>
        )}
        <button
          onClick={() => setIsCollapsed(!isCollapsed)}
          className={cn("p-1 rounded transition-colors flex-shrink-0 ml-auto", isDark ? "text-white/20 hover:text-white/50" : "text-neutral-400 hover:text-neutral-600")}
        >
          {isCollapsed ? <ChevronRight size={13} /> : <ChevronLeft size={13} />}
        </button>
      </div>

      {/* Nav */}
      <div className="flex-1 overflow-y-auto custom-scrollbar pb-4">

        {/* Boards */}
        {!isCollapsed && <p className={sectionLabel}>General</p>}
        <nav className="px-1.5">
          {regularBoards.map((board) => (
            <button
              key={board}
              onClick={() => setCurrentBoard(board)}
              className={navItem(currentBoard === board)}
              title={isCollapsed ? board : ""}
            >
              <div
                className={cn("w-1.5 h-1.5 rounded-full flex-shrink-0", currentBoard === board ? "opacity-100" : "opacity-40")}
                style={{ backgroundColor: BOARD_COLORS[board]?.accent || (isDark ? '#555' : '#aaa') }}
              />
              {!isCollapsed && <span className="truncate">{toTitle(board)}</span>}
            </button>
          ))}

          {/* Machines collapsible */}
          {!isCollapsed && machineBoards.length > 0 && (
            <Collapsible open={isMachinesOpen} onOpenChange={setIsMachinesOpen} className="w-full">
              <CollapsibleTrigger asChild>
                <button className={navItem(isAnyMachineActive)}>
                  <Cpu size={13} className={iconCls(isAnyMachineActive)} />
                  <span className="flex-1 text-left">máquinas</span>
                  <ChevronDown size={11} className={cn("flex-shrink-0 transition-transform duration-150", isDark ? "text-white/20" : "text-neutral-400", isMachinesOpen && "rotate-180")} />
                </button>
              </CollapsibleTrigger>
              <CollapsibleContent className="ml-4 pl-2 border-l border-neutral-200/60 dark:border-white/8">
                {machineBoards.map((board) => (
                  <button
                    key={board}
                    onClick={() => setCurrentBoard(board)}
                    className={navItem(currentBoard === board)}
                  >
                    <div className="w-1.5 h-1.5 rounded-full flex-shrink-0 opacity-50" style={{ backgroundColor: BOARD_COLORS[board]?.accent || '#aaa' }} />
                    <span className="truncate">{toTitle(board)}</span>
                  </button>
                ))}
              </CollapsibleContent>
            </Collapsible>
          )}

          {isCollapsed && machineBoards.length > 0 && (
            <button
              onClick={() => { setIsCollapsed(false); setIsMachinesOpen(true); }}
              className={navItem(isAnyMachineActive)}
              title="Máquinas"
            >
              <Cpu size={13} className={iconCls(isAnyMachineActive)} />
            </button>
          )}
        </nav>

        {/* Tools */}
        {!isCollapsed && <p className={sectionLabel}>Herramientas</p>}
        <nav className="px-1.5">
          <button onClick={() => navigate('/qc')} className={navItem(false)} title={isCollapsed ? "Control de Calidad" : ""}>
            <ShieldCheck size={13} className={iconCls(false)} />
            {!isCollapsed && <span>Control de Calidad</span>}
          </button>
          <button onClick={onShowAnalytics} className={navItem(false)} title={isCollapsed ? "Análisis" : ""}>
            <BarChart3 size={13} className={iconCls(false)} />
            {!isCollapsed && <span>Análisis</span>}
          </button>
          <button onClick={onShowTrash} className={navItem(false)} title={isCollapsed ? "Papelera" : ""}>
            <div className="relative flex-shrink-0">
              <Trash2 size={13} className={iconCls(false)} />
              {trashCount > 0 && <span className="absolute -top-0.5 -right-0.5 w-1.5 h-1.5 bg-royal rounded-full" />}
            </div>
            {!isCollapsed && <span className="flex-1 text-left">Papelera</span>}
            {!isCollapsed && trashCount > 0 && (
              <span className={cn("text-[9px] px-1 py-0.5 rounded font-bold tabular-nums", isDark ? "bg-royal/20 text-royal" : "bg-royal/10 text-royal/80")}>
                {trashCount}
              </span>
            )}
          </button>
        </nav>

        {/* Admin */}
        {isAdmin && (
          <>
            {!isCollapsed && <p className={sectionLabel}>Admin</p>}
            <nav className="px-1.5">
              <button onClick={() => navigate('/users')} className={navItem(false)} title={isCollapsed ? "Usuarios" : ""}>
                <Users size={13} className={iconCls(false)} />
                {!isCollapsed && <span>Usuarios</span>}
              </button>
              <button onClick={() => navigate('/activity-log')} className={navItem(false)} title={isCollapsed ? "Log Actividad" : ""}>
                <History size={13} className={iconCls(false)} />
                {!isCollapsed && <span>Log Actividad</span>}
              </button>
              <button onClick={() => navigate('/catalog-center')} className={navItem(false)} title={isCollapsed ? "Catálogos" : ""}>
                <Box size={13} className={iconCls(false)} />
                {!isCollapsed && <span>Catálogos</span>}
              </button>
            </nav>
          </>
        )}
      </div>

      {/* Footer */}
      {!isCollapsed && (
        <div className={cn("px-3 py-2.5 border-t text-[10px]", isDark ? "border-white/6 text-white/20" : "border-neutral-200 text-neutral-400")}>
          MOS <span className={isDark ? "text-royal/60" : "text-royal/70"}>System</span> · Prosper Mfg.
        </div>
      )}
    </aside>
  );
};

export default Sidebar;
