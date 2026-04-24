import { useState, useRef, useEffect } from "react";
import { ChevronDown, X, Plus, Search } from "lucide-react";
import { useLang } from "../contexts/LanguageContext";
import * as Popover from "@radix-ui/react-popover";

export default function SearchableSelect({ options = [], value, onChange, placeholder, allowCreate = true, testId = "" }) {
  const { t } = useLang();
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const inputRef = useRef(null);

  const filtered = search
    ? options.filter(o => o?.toLowerCase().includes(search.toLowerCase()))
    : options;
  
  const showCreate = allowCreate && search.trim() && !options.some(o => o?.toLowerCase() === search.trim().toLowerCase());

  const select = (val) => { 
    onChange(val); 
    setSearch(""); 
    setOpen(false); 
  };

  const clear = (e) => { 
    e.stopPropagation(); 
    onChange(""); 
    setSearch(""); 
  };

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button 
          type="button"
          className="w-full flex items-center justify-between px-3 py-2 bg-secondary/50 border border-border rounded-lg text-sm text-foreground text-left hover:border-primary/50 transition-all outline-none focus:ring-2 focus:ring-primary/20"
          data-testid={testId}
        >
          <span className={value ? "text-foreground truncate font-medium" : "text-muted-foreground truncate"}>
            {value || placeholder || t('select_placeholder')}
          </span>
          <div className="flex items-center gap-1 flex-shrink-0">
            {value && (
              <div 
                onClick={clear}
                className="p-1 hover:bg-muted rounded-md transition-colors cursor-pointer"
              >
                <X className="w-3.5 h-3.5 text-muted-foreground hover:text-foreground" />
              </div>
            )}
            <ChevronDown className={`w-4 h-4 text-muted-foreground transition-transform duration-200 ${open ? "rotate-180" : ""}`} />
          </div>
        </button>
      </Popover.Trigger>

      <Popover.Portal>
        <Popover.Content 
          className="z-[1000] w-[var(--radix-popover-trigger-width)] bg-popover border border-border rounded-xl shadow-2xl overflow-hidden animate-in fade-in zoom-in-95 duration-200"
          sideOffset={5}
          onOpenAutoFocus={(e) => {
            e.preventDefault();
            inputRef.current?.focus();
          }}
        >
          <div className="p-2 border-b border-border bg-muted/30">
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
              <input 
                ref={inputRef}
                type="text" 
                value={search} 
                onChange={e => setSearch(e.target.value)}
                placeholder={`${t('search')}...`} 
                className="w-full pl-9 pr-3 py-2 bg-background border border-border rounded-lg text-sm text-foreground focus:border-primary focus:ring-2 focus:ring-primary/20 outline-none transition-all"
                data-testid={`${testId}-search`} 
              />
            </div>
          </div>
          
          <div className="max-h-60 overflow-y-auto p-1 custom-scrollbar">
            {filtered.length === 0 && !showCreate && (
              <div className="px-3 py-8 text-center">
                <p className="text-xs text-muted-foreground italic">{t('no_results')}</p>
              </div>
            )}
            
            {showCreate && (
              <button 
                type="button" 
                onClick={() => select(search.trim())}
                className="w-full flex items-center gap-3 px-3 py-2.5 text-sm text-primary hover:bg-primary/10 rounded-lg text-left transition-colors group"
                data-testid={`${testId}-create`}
              >
                <div className="w-6 h-6 rounded-md bg-primary/20 flex items-center justify-center group-hover:scale-110 transition-transform">
                  <Plus className="w-4 h-4" />
                </div>
                <div className="flex flex-col">
                  <span className="font-bold tracking-tight">{t('add')} "{search.trim()}"</span>
                  <span className="text-[10px] opacity-60 uppercase font-black">Crear nueva opción</span>
                </div>
              </button>
            )}

            {filtered.map(opt => (
              <button 
                type="button" 
                key={opt} 
                onClick={() => select(opt)}
                className={`w-full px-3 py-2 text-sm text-left rounded-lg transition-all ${
                  opt === value 
                    ? "bg-primary text-primary-foreground font-bold shadow-lg shadow-primary/20" 
                    : "text-foreground hover:bg-secondary"
                }`}
              >
                {opt}
              </button>
            ))}
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
