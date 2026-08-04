import { useState, useRef, useMemo, useCallback } from "react";
import { Search, FunctionSquare, Columns3, CheckCircle2, AlertTriangle, Lightbulb } from "lucide-react";
import { validateFormula, evalFormula, formatResult, isFormulaError, FUNCTION_CATALOG } from "../../lib/formula";

/**
 * Editor de fórmulas con validación en vivo, vista previa sobre una fila real
 * e insertores de columnas y funciones.
 *
 * Todo el UI auxiliar (buscador, listas) es INLINE, sin portales: este editor
 * vive dentro de un Dialog y un dropdown en portal tendría que pelear con el
 * z-index del overlay. Un panel inline no tiene ese problema.
 */

// Ejemplos que resuelven necesidades reales del tablero, no demos abstractas.
const EJEMPLOS = [
  ['[quantity] - [produced]', 'Piezas que faltan'],
  ['ROUND([produced] / [quantity] * 100, 1) & "%"', 'Avance en porcentaje'],
  ['IF([produced] >= [quantity], "COMPLETO", "EN PROCESO")', 'Estado según avance'],
  ['[due_date] - TODAY()', 'Días que faltan para la entrega'],
  ['IF([due_date] - TODAY() < 0, "VENCIDA", IF([due_date] - TODAY() <= 3, "URGENTE", "OK"))', 'Semáforo de entrega'],
  ['CEILING([quantity] / 72, 1)', 'Cajas completas de 72 piezas'],
  ['SUM([sizes])', 'Total de todas las tallas'],
  ['IFERROR([produced] / [quantity], 0)', 'Evita #DIV/0! cuando no hay cantidad'],
];

// Fuera del componente A PROPÓSITO: definirlo dentro haría que React lo tratara
// como un tipo nuevo en cada render (una tecla en la fórmula = remontar los
// tres botones), perdiendo estado y foco sin razón.
const TabBtn = ({ id, icon: Icon, active, onSelect, children }) => (
  <button
    type="button"
    onClick={() => onSelect(id)}
    className={`flex items-center gap-1.5 px-2.5 py-1 rounded text-[11px] font-bold uppercase tracking-wide border transition-colors ${
      active
        ? 'bg-primary/15 border-primary/60 text-primary'
        : 'bg-secondary border-border text-muted-foreground hover:text-foreground'
    }`}
  >
    <Icon className="w-3.5 h-3.5" />{children}
  </button>
);

export const FormulaEditor = ({ value, onChange, columns = [], sampleRow = null }) => {
  const areaRef = useRef(null);
  const [tab, setTab] = useState(null);      // 'cols' | 'fns' | 'help' | null
  const [query, setQuery] = useState('');

  // Toda columna con `key` es referenciable — incluidas las de check
  // (`IF([screens], "SÍ", "NO")`) y las de fórmula, que se encadenan.
  const refColumns = useMemo(() => (columns || []).filter(c => c?.key), [columns]);

  const validation = useMemo(() => {
    if (!String(value || '').trim()) return { state: 'empty' };
    const v = validateFormula(value, columns);
    if (!v.ok) return { state: 'error', message: v.message };
    if (v.unknownRefs.length) return { state: 'warn', refs: v.unknownRefs };
    return { state: 'ok' };
  }, [value, columns]);

  const preview = useMemo(() => {
    if (validation.state === 'empty' || validation.state === 'error') return null;
    if (!sampleRow) return null;
    const raw = evalFormula(value, sampleRow, columns);
    return { text: formatResult(raw), isError: isFormulaError(raw), detail: isFormulaError(raw) ? raw.detail : '' };
  }, [value, columns, sampleRow, validation.state]);

  /** Inserta en la posición del cursor y deja el cursor listo para seguir. */
  const insert = useCallback((snippet, caretBack = 0) => {
    const el = areaRef.current;
    const cur = String(value || '');
    const start = el ? el.selectionStart : cur.length;
    const end = el ? el.selectionEnd : cur.length;
    const next = cur.slice(0, start) + snippet + cur.slice(end);
    onChange(next);
    requestAnimationFrame(() => {
      if (!el) return;
      const pos = start + snippet.length - caretBack;
      el.focus();
      el.setSelectionRange(pos, pos);
    });
  }, [value, onChange]);

  const filteredCols = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return refColumns;
    return refColumns.filter(c =>
      String(c.label || '').toLowerCase().includes(q) || String(c.key).toLowerCase().includes(q));
  }, [refColumns, query]);

  const filteredFns = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return FUNCTION_CATALOG;
    return FUNCTION_CATALOG
      .map(g => ({ ...g, items: g.items.filter(([n, , d]) =>
        n.toLowerCase().includes(q) || d.toLowerCase().includes(q)) }))
      .filter(g => g.items.length);
  }, [query]);

  const selectTab = useCallback((id) => {
    setTab(prev => (prev === id ? null : id));
    setQuery('');
  }, []);

  return (
    <div className="space-y-2">
      <textarea
        ref={areaRef}
        value={value || ''}
        onChange={(e) => onChange(e.target.value)}
        rows={3}
        spellCheck={false}
        placeholder={'= [quantity] - [produced]'}
        style={{ backgroundColor: 'hsl(var(--secondary))', color: 'hsl(var(--foreground))' }}
        className={`w-full border rounded px-3 py-2 text-sm font-mono resize-y leading-relaxed focus:outline-none focus:ring-1 ${
          validation.state === 'error'
            ? 'border-destructive focus:ring-destructive'
            : 'border-border focus:ring-primary'
        }`}
        data-testid="formula-input"
      />

      {/* Estado de la fórmula + resultado con la primera orden del tablero */}
      <div className="min-h-[20px] text-xs" data-testid="formula-status">
        {validation.state === 'error' && (
          <p className="flex items-start gap-1.5 text-destructive">
            <AlertTriangle className="w-3.5 h-3.5 mt-px flex-shrink-0" />
            <span>{validation.message}</span>
          </p>
        )}
        {validation.state === 'warn' && (
          <p className="flex items-start gap-1.5 text-amber-500">
            <AlertTriangle className="w-3.5 h-3.5 mt-px flex-shrink-0" />
            <span>
              No existe{validation.refs.length > 1 ? 'n' : ''} la columna
              {validation.refs.length > 1 ? 's' : ''}:{' '}
              <b className="font-mono">{validation.refs.join(', ')}</b> — dará #NAME?
            </span>
          </p>
        )}
        {validation.state === 'ok' && preview && (
          <p className={`flex items-center gap-1.5 ${preview.isError ? 'text-destructive' : 'text-emerald-500'}`}>
            {preview.isError
              ? <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0" />
              : <CheckCircle2 className="w-3.5 h-3.5 flex-shrink-0" />}
            <span>
              Vista previa:{' '}
              <b className="font-mono">{preview.text === '' ? '(vacío)' : preview.text}</b>
              {preview.detail && <span className="text-muted-foreground"> — {preview.detail}</span>}
            </span>
          </p>
        )}
        {validation.state === 'ok' && !preview && (
          <p className="flex items-center gap-1.5 text-emerald-500">
            <CheckCircle2 className="w-3.5 h-3.5 flex-shrink-0" />Sintaxis correcta
          </p>
        )}
      </div>

      <div className="flex flex-wrap gap-1.5">
        <TabBtn id="cols" icon={Columns3} active={tab === 'cols'} onSelect={selectTab}>Columnas</TabBtn>
        <TabBtn id="fns" icon={FunctionSquare} active={tab === 'fns'} onSelect={selectTab}>Funciones</TabBtn>
        <TabBtn id="help" icon={Lightbulb} active={tab === 'help'} onSelect={selectTab}>Ejemplos</TabBtn>
      </div>

      {tab && (
        <div className="border border-border rounded bg-secondary/30 p-2 space-y-2">
          {tab !== 'help' && (
            <div className="relative">
              <Search className="w-3.5 h-3.5 absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground" />
              <input
                autoFocus
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={tab === 'cols' ? 'Buscar columna…' : 'Buscar función…'}
                style={{ backgroundColor: 'hsl(var(--secondary))', color: 'hsl(var(--foreground))' }}
                className="w-full border border-border rounded pl-7 pr-2 py-1 text-xs"
              />
            </div>
          )}

          <div className="max-h-52 overflow-y-auto pr-1">
            {tab === 'cols' && (
              filteredCols.length === 0
                ? <p className="text-xs text-muted-foreground px-1 py-2">Sin columnas que coincidan.</p>
                : <div className="flex flex-wrap gap-1">
                    {filteredCols.map(c => (
                      <button
                        key={c.key}
                        type="button"
                        onClick={() => insert(`[${c.label || c.key}]`)}
                        title={`clave: ${c.key}${c.type === 'formula' ? ' · es una fórmula' : ''}`}
                        className="px-2 py-1 rounded border border-border bg-card hover:border-primary hover:text-primary text-[11px] font-mono transition-colors"
                      >
                        [{c.label || c.key}]
                        {c.type === 'formula' && <span className="ml-1 opacity-60">ƒ</span>}
                      </button>
                    ))}
                  </div>
            )}

            {tab === 'fns' && (
              filteredFns.length === 0
                ? <p className="text-xs text-muted-foreground px-1 py-2">Sin funciones que coincidan.</p>
                : filteredFns.map(g => (
                    <div key={g.group} className="mb-2 last:mb-0">
                      <p className="text-[10px] uppercase tracking-widest text-muted-foreground font-bold mb-1 px-1">{g.group}</p>
                      <div className="space-y-0.5">
                        {g.items.map(([name, sig, desc]) => (
                          <button
                            key={name}
                            type="button"
                            onClick={() => insert(`${name}()`, 1)}
                            className="w-full text-left px-2 py-1 rounded hover:bg-primary/10 group"
                          >
                            <span className="font-mono text-[11px] text-primary">{sig}</span>
                            <span className="block text-[10px] text-muted-foreground group-hover:text-foreground">{desc}</span>
                          </button>
                        ))}
                      </div>
                    </div>
                  ))
            )}

            {tab === 'help' && (
              <div className="space-y-1">
                <p className="text-[10px] text-muted-foreground px-1 pb-1 leading-relaxed">
                  Operadores: <b className="font-mono">+ - * / ^ %</b> · texto con{' '}
                  <b className="font-mono">&amp;</b> · comparación{' '}
                  <b className="font-mono">= &lt;&gt; &lt; &gt; &lt;= &gt;=</b>. Los argumentos se
                  separan con <b className="font-mono">,</b> o <b className="font-mono">;</b>.
                </p>
                {EJEMPLOS.map(([f, desc]) => (
                  <button
                    key={f}
                    type="button"
                    onClick={() => { onChange(f); setTab(null); }}
                    className="w-full text-left px-2 py-1.5 rounded hover:bg-primary/10 group"
                  >
                    <span className="font-mono text-[11px] text-primary break-all">{f}</span>
                    <span className="block text-[10px] text-muted-foreground group-hover:text-foreground">{desc}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
};

export default FormulaEditor;
