import { useState, useRef, useMemo } from "react";

export const PrefixLocationInput = ({ locations = [], value, onChange }) => {
  const [query, setQuery] = useState(value || '');
  const [open, setOpen] = useState(false);
  const inputRef = useRef(null);

  // Extract unique prefixes: take characters up to the first delimiter (-)
  const uniquePrefixes = useMemo(() => {
    const prefixSet = new Set();
    locations.forEach(loc => {
      const dashIdx = loc.indexOf('-');
      const prefix = dashIdx !== -1 ? loc.slice(0, dashIdx) : loc;
      prefixSet.add(prefix.toUpperCase());
    });
    return Array.from(prefixSet).sort();
  }, [locations]);

  // Filter suggestions based on what user typed
  const suggestions = useMemo(() => {
    if (!query.trim()) return uniquePrefixes.slice(0, 15);
    const q = query.toUpperCase();
    return uniquePrefixes.filter(p => p.startsWith(q)).slice(0, 10);
  }, [query, uniquePrefixes]);

  const handleInput = (val) => {
    setQuery(val);
    onChange(val);
    setOpen(true);
  };

  const handleSelect = (prefix) => {
    setQuery(prefix);
    onChange(prefix);
    setOpen(false);
  };

  // Count matching locations for the current prefix
  const matchCount = useMemo(() => {
    if (!query.trim()) return 0;
    const q = query.toUpperCase();
    return locations.filter(l => l.toUpperCase().startsWith(q)).length;
  }, [query, locations]);

  return (
    <div className="relative" data-testid="cc-loc-prefix">
      <div className="relative">
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={e => handleInput(e.target.value)}
          onFocus={() => setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 150)}
          placeholder="Ej: RP03, RP10..."
          className="w-full px-3 py-2 bg-background border border-border rounded text-sm text-foreground font-mono font-bold uppercase placeholder:font-normal placeholder:normal-case"
          autoComplete="off"
        />
        {query && matchCount > 0 && (
          <span className="absolute right-2 top-1/2 -translate-y-1/2 text-[10px] bg-primary/20 text-primary px-1.5 py-0.5 rounded font-black">
            {matchCount} ubic.
          </span>
        )}
      </div>
      {open && suggestions.length > 0 && (
        <div className="absolute z-50 mt-1 w-full bg-card border border-border rounded-lg shadow-xl overflow-hidden max-h-48 overflow-y-auto">
          <div className="px-2 py-1.5 text-[10px] font-black uppercase tracking-widest text-muted-foreground border-b border-border bg-secondary/30">
            Prefijos disponibles
          </div>
          {suggestions.map(prefix => {
            const cnt = locations.filter(l => l.toUpperCase().startsWith(prefix)).length;
            return (
              <button
                key={prefix}
                onMouseDown={() => handleSelect(prefix)}
                className="w-full flex items-center justify-between px-3 py-2 text-sm hover:bg-primary/10 hover:text-primary transition-colors text-left"
              >
                <span className="font-mono font-black">{prefix}</span>
                <span className="text-[10px] text-muted-foreground">{cnt} ubicaciones</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
};
