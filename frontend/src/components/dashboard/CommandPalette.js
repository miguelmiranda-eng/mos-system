import React, { useState, useEffect } from 'react';
import { 
  Plus, 
  Search, 
  Command, 
  List, 
  Settings, 
  Zap, 
  BarChart3, 
  X,
  Keyboard
} from 'lucide-react';
import { cn } from '../../lib/utils';
import { BOARDS } from '../../lib/constants';

const CommandPalette = ({ 
  isOpen, 
  onClose, 
  onNewOrder, 
  onShowAutomations, 
  onShowAnalytics, 
  onNavigateBoard,
  t 
}) => {
  const [query, setQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);

  const actions = [
    { id: 'new-order', title: 'Nueva Orden', icon: <Plus size={18} />, shortcut: 'N', action: onNewOrder },
    { id: 'automations', title: 'Automatización', icon: <Zap size={18} />, shortcut: 'A', action: onShowAutomations },
    { id: 'analytics', title: 'Análisis de Datos', icon: <BarChart3 size={18} />, shortcut: 'D', action: onShowAnalytics },
    { id: 'settings', title: 'Configuración', icon: <Settings size={18} />, shortcut: 'S', action: () => {} },
  ];

  const boards = BOARDS.filter(b => b.toLowerCase().includes(query.toLowerCase())).map(b => ({
    id: `board-${b}`,
    title: `Ir a: ${b}`,
    icon: <List size={18} />,
    action: () => onNavigateBoard(b)
  }));

  const filteredItems = [...actions, ...boards].filter(item => 
    item.title.toLowerCase().includes(query.toLowerCase())
  );

  useEffect(() => {
    const handleKeyDown = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        isOpen ? onClose() : null; // This is handled in the parent usually
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  useEffect(() => {
    setSelectedIndex(0);
  }, [query]);

  const handleKeyDown = (e) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedIndex(prev => (prev + 1) % filteredItems.length);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedIndex(prev => (prev - 1 + filteredItems.length) % filteredItems.length);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (filteredItems[selectedIndex]) {
        filteredItems[selectedIndex].action();
        onClose();
      }
    } else if (e.key === 'Escape') {
      onClose();
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-[100] flex items-start justify-center pt-[15vh] px-4">
      <div className="fixed inset-0 bg-navy/60 backdrop-blur-sm" onClick={onClose} />
      
      <div className="relative w-full max-w-xl bg-card border border-white/10 shadow-2xl rounded-md overflow-hidden animate-in zoom-in-95 duration-200">
        <div className="flex items-center px-4 border-b border-border/50">
          <Command size={18} className="text-muted-foreground mr-3" />
          <input
            autoFocus
            type="text"
            placeholder="Escribe un comando o busca un tablero..."
            className="flex-1 h-14 bg-transparent border-none outline-none text-base placeholder:text-muted-foreground/50"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
          />
          <div className="flex items-center gap-1.5 px-2 py-1 bg-muted/50 rounded text-[10px] font-bold text-muted-foreground">
            <Keyboard size={12} />
            <span>ESC</span>
          </div>
        </div>

        <div className="max-h-[350px] overflow-y-auto p-2 custom-scrollbar">
          {filteredItems.length === 0 ? (
            <div className="p-8 text-center text-muted-foreground">
              <Search className="mx-auto mb-3 opacity-20" size={32} />
              <p className="text-sm">No se encontraron resultados para "{query}"</p>
            </div>
          ) : (
            <div className="space-y-1">
              {filteredItems.map((item, index) => (
                <button
                  key={item.id}
                  onClick={() => { item.action(); onClose(); }}
                  className={cn(
                    "w-full flex items-center justify-between p-3 rounded-sm transition-all text-left",
                    index === selectedIndex ? "bg-royal text-white" : "hover:bg-muted"
                  )}
                >
                  <div className="flex items-center gap-3">
                    <div className={cn("inline-flex items-center justify-center")}>
                      {item.icon}
                    </div>
                    <span className="text-sm font-bold">{item.title}</span>
                  </div>
                  {item.shortcut && (
                    <span className={cn(
                      "text-[10px] px-1.5 py-0.5 rounded font-bold",
                      index === selectedIndex ? "bg-white/20" : "bg-muted text-muted-foreground"
                    )}>
                      {item.shortcut}
                    </span>
                  )}
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="p-3 bg-muted/20 border-t border-border/50 flex items-center justify-between">
          <div className="flex items-center gap-4 text-[10px] font-bold text-muted-foreground">
            <div className="flex items-center gap-1">
              <span className="p-1 bg-card border border-border rounded shadow-sm">⏎</span>
              <span>Seleccionar</span>
            </div>
            <div className="flex items-center gap-1">
              <span className="p-1 bg-card border border-border rounded shadow-sm">↑↓</span>
              <span>Navegar</span>
            </div>
          </div>
          <span className="text-[10px] font-bold text-royal">Enterprise MOS Suite</span>
        </div>
      </div>
    </div>
  );
};

export default CommandPalette;
