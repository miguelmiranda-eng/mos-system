import { useState, useRef, useEffect } from "react";
import { ChevronDown, X, Plus } from "lucide-react";

export default function SearchableSelect({ options = [], value, onChange, placeholder = "Seleccionar...", allowCreate = true, testId = "" }) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const ref = useRef(null);
  const inputRef = useRef(null);

  useEffect(() => {
    const handler = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  useEffect(() => { if (open && inputRef.current) inputRef.current.focus(); }, [open]);

  const filtered = search
    ? options.filter(o => o.toLowerCase().includes(search.toLowerCase()))
    : options;
  const showCreate = allowCreate && search.trim() && !options.some(o => o.toLowerCase() === search.trim().toLowerCase());

  const select = (val) => { onChange(val); setSearch(""); setOpen(false); };
  const clear = (e) => { e.stopPropagation(); onChange(""); setSearch(""); };

  return (
    <div ref={ref} className="relative" data-testid={testId}>
      <button type="button" onClick={() => setOpen(!open)}
        className="w-full flex items-center justify-between px-3 py-2 bg-background border border-border rounded text-sm text-foreground text-left hover:border-primary/50 transition-colors">
        <span className={value ? "text-foreground truncate" : "text-muted-foreground truncate"}>{value || placeholder}</span>
        <div className="flex items-center gap-1 flex-shrink-0">
          {value && <X className="w-3.5 h-3.5 text-muted-foreground hover:text-foreground cursor-pointer" onClick={clear} />}
          <ChevronDown className={`w-3.5 h-3.5 text-muted-foreground transition-transform ${open ? "rotate-180" : ""}`} />
        </div>
      </button>
      {open && (
        <div className="absolute z-50 w-full mt-1 bg-popover border border-border rounded-lg shadow-lg overflow-hidden">
          <div className="p-1.5 border-b border-border">
            <input ref={inputRef} type="text" value={search} onChange={e => setSearch(e.target.value)}
              placeholder="Buscar..." className="w-full px-2 py-1.5 bg-background border border-border rounded text-sm text-foreground focus:border-primary focus:ring-1 focus:ring-primary outline-none"
              data-testid={`${testId}-search`} />
          </div>
          <div className="max-h-48 overflow-y-auto">
            {filtered.length === 0 && !showCreate && (
              <div className="px-3 py-2 text-xs text-muted-foreground">Sin resultados</div>
            )}
            {showCreate && (
              <button type="button" onClick={() => select(search.trim())}
                className="w-full flex items-center gap-2 px-3 py-2 text-sm text-primary hover:bg-primary/10 text-left"
                data-testid={`${testId}-create`}>
                <Plus className="w-3.5 h-3.5" /> Agregar "{search.trim()}"
              </button>
            )}
            {filtered.map(opt => (
              <button type="button" key={opt} onClick={() => select(opt)}
                className={`w-full px-3 py-1.5 text-sm text-left hover:bg-secondary transition-colors ${opt === value ? "bg-primary/10 text-primary font-bold" : "text-foreground"}`}>
                {opt}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
