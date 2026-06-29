import React, { useState, useEffect, forwardRef } from "react";
import { Search } from "lucide-react";

// Isolated search input. The raw typed value lives in LOCAL state, so every
// keystroke re-renders ONLY this tiny component (instant echo on iPad Safari)
// instead of the whole Dashboard (~2.9k lines + up to ~1.4k grid rows). The
// value is pushed to the parent debounced (300ms) for board filtering, and
// `clearToken` lets the parent reset the box (e.g. after a global search).
const SearchBox = forwardRef(function SearchBox(
  { onDebouncedChange, onEnter, clearToken, placeholder, isMobile }, ref
) {
  const [value, setValue] = useState("");

  // Parent bumps clearToken to clear the box.
  useEffect(() => { setValue(""); }, [clearToken]);

  // Debounce the typed value up to the parent (filter runs on the pause, not
  // on every keystroke). onDebouncedChange must be stable (useCallback).
  useEffect(() => {
    const t = setTimeout(() => onDebouncedChange(value), 300);
    return () => clearTimeout(t);
  }, [value, onDebouncedChange]);

  return (
    <div className={`flex items-center gap-3 w-full px-4 py-1.5 rounded-full border border-border/60 bg-muted/20 hover:bg-muted/40 focus-within:bg-card focus-within:border-royal/60 focus-within:shadow-sm transition-all group ${isMobile ? 'max-w-[200px]' : 'max-w-md'}`}>
      <Search className="w-4 h-4 text-muted-foreground group-focus-within:text-royal transition-colors flex-shrink-0" />
      <input
        ref={ref}
        type="text"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') onEnter(value); }}
        placeholder={placeholder}
        className="w-full bg-transparent border-none text-sm outline-none focus:outline-none focus:ring-0 placeholder:text-muted-foreground/50 transition-all font-medium py-1"
      />
    </div>
  );
});

export default React.memo(SearchBox);
