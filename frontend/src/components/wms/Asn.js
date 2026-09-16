import { useState, useEffect, useCallback, useRef } from "react";
import { toast } from "sonner";
import { FileUp, Loader2, X, Package, Search, AlertTriangle, Trash2, Pencil, Plus, Check, CheckCircle2, RotateCcw, Lock, Columns3, Sparkles, Settings2, ChevronRight, Filter } from "lucide-react";
import * as XLSX from "xlsx";
import { saveAs } from "file-saver";
import { useLang } from "../../contexts/LanguageContext";
import { API, fetcher, deleter, putter, poster, logLoadError } from "./lib";
import { AsnStatus } from "./constants";
import { StatCard, Btn, EmptyState, ModuleToolbar } from "./ui";
import { AddColumnModal } from "../dashboard/AddColumnModal";
import { AsnConfigModal } from "./AsnConfigModal";
import { evalFormula, formatResult } from "../../lib/formula";

const STATUS_STYLES = {
  [AsnStatus.PENDING]:  { labelKey: "wms_asn_st_pending",  cls: "bg-blue-50 text-blue-700 border-blue-200 dark:bg-blue-500/10 dark:text-blue-300 dark:border-blue-500/25",             tabCls: "bg-card text-foreground shadow-sm",    dot: "bg-blue-500" },
  [AsnStatus.PARTIAL]:  { labelKey: "wms_asn_st_partial", cls: "bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-500/10 dark:text-amber-300 dark:border-amber-500/25",       tabCls: "bg-card text-foreground shadow-sm",   dot: "bg-amber-500" },
  [AsnStatus.RECEIVED]: { labelKey: "wms_asn_st_received", cls: "bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-500/10 dark:text-emerald-300 dark:border-emerald-500/25", tabCls: "bg-card text-foreground shadow-sm", dot: "bg-emerald-500" },
};

const TABS = [
  { id: 'all',                 labelKey: 'wms_asn_tab_all' },
  { id: AsnStatus.PENDING,     labelKey: 'wms_status_pending' },
  { id: AsnStatus.PARTIAL,     labelKey: 'wms_status_in_progress' },
  { id: AsnStatus.RECEIVED,    labelKey: 'wms_status_completed' },
];

// Tipo de discrepancia: el valor se guarda/compara tal cual; sólo se traduce al mostrar.
const DISC_TYPE_KEY = { SOBRANTE: 'wms_asn_disc_surplus', FALTANTE: 'wms_asn_disc_shortage' };

// ── Columnas personalizadas de las líneas (igual que el CRM) ─────────────────
// Los campos fijos se declaran como columnas para que una fórmula pueda
// referenciarlos: `[Cantidad] * 2`, `IF([Recibido] >= [Cantidad], "OK", "")`.
const ASN_FIXED_LINE_COLS = [
  { key: 'part_number', label: 'N.º parte', type: 'text' },
  { key: 'style', label: 'Estilo', type: 'text' },
  { key: 'garment', label: 'Prenda', type: 'text' },
  { key: 'gender', label: 'Género', type: 'text' },
  { key: 'unit', label: 'Unidad', type: 'text' },
  { key: 'import_type', label: 'Tipo', type: 'text' },
  { key: 'po', label: 'PO', type: 'text' },
  { key: 'description', label: 'Descripción', type: 'text' },
  { key: 'color', label: 'Color', type: 'text' },
  { key: 'size', label: 'Talla', type: 'text' },
  { key: 'country', label: 'País', type: 'text' },
  { key: 'brand', label: 'Marca', type: 'text' },
  { key: 'fabric', label: 'Fabric', type: 'text' },
  { key: 'qty_expected', label: 'Cantidad', type: 'number' },
  { key: 'qty_received', label: 'Recibido', type: 'number' },
];
const CELL_CLS = "w-full h-8 px-2 bg-card border border-input rounded-md text-xs focus:outline-none focus:border-primary";
// Celda de hoja: sin caja propia, llena el <td>; el foco se marca con un anillo
// interior para que la cuadrícula se vea como una hoja de cálculo.
const GRID_CLS = "w-full h-9 px-2 bg-transparent border-0 rounded-none text-xs focus:outline-none focus:ring-1 focus:ring-inset focus:ring-primary focus:bg-primary/10";

// Clave estable para la definición: sin acentos ni símbolos, para que el backend
// la acepte (^[a-z0-9_]+$) y una fórmula la pueda escribir sin corchetes.
const slugKey = (name) => String(name || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
  .toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40) || 'col';

// Anchos de la hoja de captura: TODAS las columnas arrancan iguales (como una
// hoja nueva de Excel) y el usuario las estira desde el borde del encabezado.
// Lo que estira se recuerda en este navegador; doble clic regresa al estándar.
const GRID_COL_W = 140;
const GRID_MIN_W = 60;
const GRID_ROWNUM_W = 40;
const GRID_TRASH_W = 40;
const GRID_W_KEY = 'mos_asn_grid_widths_v1';
const loadGridWidths = () => { try { return JSON.parse(localStorage.getItem(GRID_W_KEY) || '{}') || {}; } catch { return {}; } };
const saveGridWidths = (w) => { try { localStorage.setItem(GRID_W_KEY, JSON.stringify(w)); } catch { /* sin storage: solo esta sesión */ } };

// Orden de columnas de la hoja "PL RAW MATERIAL (Materia prima)" del packing
// list de aduana. Si se pega una fila COMPLETA de ese Excel (15+ celdas) se
// mapea por esta posición, sin importar el orden visible de la cuadrícula.
// null = columna que no se captura (NO*, part number manual, descripción EN).
const PL_RAW_LAYOUT = ['color', 'style', 'po', null, null, 'description', null, 'qty_expected', 'unit',
  'unit_cost', 'total_cost', 'net_weight', 'gross_weight', 'bundles', 'package_type', 'country', null, 'import_type'];
// Campos que el sistema PROPONE leyendo la descripción; si la persona los
// tocó a mano, la propuesta ya no los pisa.
const PROPOSED_FIELDS = ['garment', 'gender', 'fabric'];
const ADUANA_KEY = 'mos_asn_sheet_aduana_v1';

// Fila plana {campo fijo + extra} — es lo que ve el motor de fórmulas.
const lineRow = (it) => ({ ...(it || {}), ...((it && it.extra) || {}) });

// Una celda de columna personalizada, por tipo. readOnly = tabla de detalle.
function ExtraCell({ col, line, cols, onChange, readOnly = false, grid = false }) {
  const value = (line.extra || {})[col.key];
  const base = grid ? GRID_CLS : CELL_CLS;
  if (col.type === 'formula') {
    const v = formatResult(evalFormula(col.formula, lineRow(line), cols));
    return <span className={`text-xs tabular-nums text-muted-foreground ${grid ? 'block px-2 h-9 leading-9' : ''}`}>{v}</span>;
  }
  if (col.type === 'select') {
    const opt = (col.statusOptions || []).find(o => o.value === value);
    const badge = value
      ? <span className="inline-block px-2 py-0.5 rounded text-xs font-medium text-white" style={{ backgroundColor: opt?.color || '#64748b' }}>{value}</span>
      : <span className="text-xs text-muted-foreground">—</span>;
    if (readOnly) return badge;
    return (
      <select value={value || ''} onChange={e => onChange(e.target.value)} className={base}
        style={{ ...(grid ? {} : { minWidth: 110 }), ...(opt ? { backgroundColor: opt.color, color: '#fff' } : {}) }}>
        <option value="">—</option>
        {(col.statusOptions || []).map(o => <option key={o.value} value={o.value}>{o.value}</option>)}
      </select>
    );
  }
  if (col.type === 'checkbox') {
    return <input type="checkbox" checked={!!value} disabled={readOnly} onChange={e => onChange(e.target.checked)} className={`w-4 h-4 accent-primary ${grid ? 'block mx-auto my-2.5' : ''}`} />;
  }
  if (readOnly) {
    if (value === undefined || value === null || value === '') return <span className="text-xs text-muted-foreground">—</span>;
    if (col.type === 'link') return <a href={String(value)} target="_blank" rel="noreferrer" className="text-xs text-primary underline truncate block max-w-[200px]">{String(value)}</a>;
    if (col.type === 'number') return <span className="text-xs tabular-nums">{Number(value).toLocaleString()}</span>;
    return <span className="text-xs">{String(value)}</span>;
  }
  const inputType = col.type === 'number' ? 'number' : col.type === 'date' ? 'date' : col.type === 'link' ? 'url' : 'text';
  return <input type={inputType} value={value ?? ''} onChange={e => onChange(e.target.value)}
    className={`${base} ${col.type === 'number' ? 'text-right tabular-nums' : ''}`} style={grid ? undefined : { minWidth: col.type === 'date' ? 130 : 110 }} />;
}

// `initialDetail` = { id, n }: la búsqueda global de caja / LPN pide abrir el
// detalle de la entrada de esa caja (fase 3, búsqueda inversa). `n` cambia en
// cada petición para que abrir la misma entrada dos veces también dispare.
export const AsnModule = ({ currentUser, initialDetail }) => {
  const { t } = useLang();
  // Admin y Super Usuario pueden crear/editar/reabrir ASN.
  const isSupersu = ['admin', 'supersu'].includes(currentUser?.role);
  const [asns, setAsns] = useState([]);
  const [query, setQuery] = useState("");
  const [activeTab, setActiveTab] = useState('all'); // 'all' | pending | partial | received

  // Configuración del módulo (prefijos, prendas, fibras, países).
  const [showConfig, setShowConfig] = useState(false);

  // Detail modal
  const [detailFor, setDetailFor] = useState(null);   // asn_id
  const [detailData, setDetailData] = useState(null); // {asn, boxes}
  const [detailLoading, setDetailLoading] = useState(false);
  // Fase 3: detalle por número de parte. `expandedParts` = partes con el
  // desglose estilo/color/talla abierto; `partFilter` filtra la tabla de cajas
  // (null = todas; '' = cajas sin número de parte).
  const [expandedParts, setExpandedParts] = useState(() => new Set());
  const [partFilter, setPartFilter] = useState(null);

  // SKU → ASN trace (Fase 2)
  const [showTrace, setShowTrace] = useState(false);
  const [traceQuery, setTraceQuery] = useState("");
  const [traceResults, setTraceResults] = useState(null);
  const [traceLoading, setTraceLoading] = useState(false);

  // Captura MANUAL de una entrada (ASN o BPO) — tabla tipo Excel. Las columnas
  // están alineadas al formato de receiving (style/color/talla/país/fabric/cant.)
  // para que receiving reciba directo contra el número de entrada.
  // Formato ÚNICO de línea (packing list de aduana). Lo que se sabe antes de
  // que llegue el material: descripción, prenda, composición, país, cantidad.
  // Estilo/color/talla/PO son opcionales (a veces vienen, a veces no).
  // part_number NO se teclea: lo compone el servidor (services/part_number.py).
  const NEW_LINE = () => ({
    description: '', garment: '', gender: '', fabric: '', country: '', qty_expected: '', unit: 'PZA',
    import_type: 'Temporal', sample: false, part_number: '', style: '', color: '', size: '', po: '',
    unit_cost: '', total_cost: '', net_weight: '', gross_weight: '', bundles: '', package_type: '',
    extra: {}, _pn: null, _touched: {},
  });
  // Catálogos del número de parte (prefijos, prendas, géneros, fibras, países).
  const [pnCfg, setPnCfg] = useState(null);
  useEffect(() => {
    fetcher('/asn/part-number/config').then(setPnCfg).catch(logLoadError('part-number config'));
  }, []);
  const pnCustomers = Object.keys(pnCfg?.customers || {}).sort();
  const pnCountries = Array.from(new Set(Object.keys(pnCfg?.countries || {}).filter(k => k.length > 3))).sort();
  const [showAduana, setShowAduana] = useState(() => { try { return localStorage.getItem(ADUANA_KEY) === '1'; } catch { return false; } });
  const toggleAduana = () => setShowAduana(v => { try { localStorage.setItem(ADUANA_KEY, v ? '0' : '1'); } catch { /* sin storage */ } return !v; });

  // Columnas personalizadas (globales para todas las entradas). Se editan con el
  // mismo modal del CRM; los valores por línea viajan en items[].extra.
  const [asnCols, setAsnCols] = useState([]);
  const [showAddCol, setShowAddCol] = useState(false);
  const allLineCols = [...ASN_FIXED_LINE_COLS, ...asnCols];
  useEffect(() => {
    fetcher('/asn-columns').then(r => setAsnCols(r?.columns || [])).catch(logLoadError('asn columns'));
  }, []);
  const saveAsnCols = async (cols) => {
    const res = await putter('/asn-columns', { columns: cols });
    const r = await res.json().catch(() => ({}));
    if (!res.ok) { toast.error(r.detail || t('wms_asn_columns_err')); return false; }
    setAsnCols(r.columns || []);
    return true;
  };
  // colDef viene del AddColumnModal del CRM: {key,label,type,width,custom,formula?,statusOptions?,optionKey?}
  const addAsnColumn = (colDef) => {
    const key = slugKey(colDef.label || colDef.key);
    if (allLineCols.some(c => c.key === key)) { toast.error(t('col_exists')); return; }
    const col = { key, label: colDef.label, type: colDef.type, width: colDef.width || 150 };
    if (colDef.type === 'formula') col.formula = colDef.formula;
    if (colDef.type === 'select') col.statusOptions = colDef.statusOptions || [];
    saveAsnCols([...asnCols, col]);
  };
  const removeAsnColumn = (key) => {
    const col = asnCols.find(c => c.key === key);
    if (!col || !window.confirm(t('wms_remove_column_confirm', { name: col.label }))) return;
    saveAsnCols(asnCols.filter(c => c.key !== key));
  };
  // Cabecera de columna personalizada: etiqueta + quitar (admin/supersu).
  const ExtraTh = ({ col, cls }) => (
    <th className={cls} style={{ minWidth: col.width || 120 }}>
      <span className="inline-flex items-center gap-1">
        {col.label}
        {isSupersu && (
          <button onClick={() => removeAsnColumn(col.key)} className="p-0.5 rounded text-muted-foreground/60 hover:text-destructive hover:bg-destructive/10" title={t('wms_remove_column')}>
            <X className="w-3 h-3" />
          </button>
        )}
      </span>
    </th>
  );
  const [showCreate, setShowCreate] = useState(false);
  const [savingCreate, setSavingCreate] = useState(false);
  const [createDraft, setCreateDraft] = useState(null);
  const openCreate = () => { setCreateDraft({ asn_id: '', tipo: 'ASN', customer: '', vendor: '', po_number: '', expected_date: '', items: [NEW_LINE()] }); setShowCreate(true); };
  // Prenda/género/composición tecleados a mano quedan "tocados": la propuesta
  // del servidor ya no los pisa. Si la persona los vacía, vuelven a proponerse.
  const setCLine = (i, f, v) => setCreateDraft(d => ({ ...d, items: d.items.map((it, j) => {
    if (j !== i) return it;
    const touched = PROPOSED_FIELDS.includes(f) ? { ...(it._touched || {}), [f]: v !== '' && v !== null } : it._touched;
    return { ...it, [f]: v, _touched: touched };
  }) }));
  const addCLine = () => setCreateDraft(d => ({ ...d, items: [...d.items, NEW_LINE()] }));
  // Opciones del desplegable de composición: el catálogo + el valor actual si
  // no está en él (entradas viejas, texto pegado que el servidor no pudo
  // canonizar), marcado, para que nunca se pierda lo capturado.
  const inCatalog = (listKey, v) => !v || (pnCfg?.[listKey] || []).includes(v);
  const catalogOptions = (listKey, current) => {
    const opts = [{ value: '', label: '—' }, ...(pnCfg?.[listKey] || []).map(c => ({ value: c, label: c }))];
    if (current && !inCatalog(listKey, current)) opts.push({ value: current, label: `${current} ⚠ ${t('wms_asn_not_in_catalog')}` });
    return opts;
  };
  // Texto pegado que coincide con una entrada del catálogo salvo acentos,
  // mayúsculas o espacios se sustituye por la del catálogo (así cae en el
  // desplegable sin marca).
  const foldKey = (s) => String(s || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, ' ').trim().toUpperCase();
  const snapToCatalog = (listKey, v) => {
    if (!v) return v;
    const k = foldKey(v);
    return (pnCfg?.[listKey] || []).find(c => foldKey(c) === k) || v;
  };
  const CATALOG_OF = { description: 'descriptions', fabric: 'compositions' };
  const rmCLine = (i) => setCreateDraft(d => ({ ...d, items: d.items.filter((_, j) => j !== i) }));
  const setCLineExtra = (i, key, v) => setCreateDraft(d => ({ ...d, items: d.items.map((it, j) => j === i ? { ...it, extra: { ...(it.extra || {}), [key]: v } } : it) }));

  // ── Hoja de captura: se comporta como una hoja de cálculo ──────────────────
  // Orden de columnas de la cuadrícula (después de la columna "#"). Es el mismo
  // orden en que se pegan las celdas que vienen de Excel.
  const ADUANA_COLS = [
    { key: 'unit_cost', label: t('wms_asn_unit_cost'), num: true }, { key: 'total_cost', label: t('wms_asn_total_cost'), num: true },
    { key: 'net_weight', label: t('wms_asn_net_weight'), num: true }, { key: 'gross_weight', label: t('wms_asn_gross_weight'), num: true },
    { key: 'bundles', label: t('wms_asn_bundles'), num: true }, { key: 'package_type', label: t('wms_asn_package_type'), upper: true },
  ];
  const GRID_FIXED = [
    // Descripción y composición salen de catálogos (pnCfg.descriptions /
    // compositions), no de texto libre. Lo pegado del Excel se conserva y se
    // marca si no está en el catálogo; la composición además se canoniza.
    { key: 'description', label: t('description'), list: 'descriptions', required: true },
    { key: 'garment', label: t('wms_asn_garment'), select: 'garments' },
    { key: 'gender', label: t('wms_asn_gender'), select: 'genders' },
    // Composición: desplegable del catálogo (pnCfg.compositions, canónico), no
    // texto libre. Lo pegado del Excel se canoniza vía la propuesta del servidor.
    { key: 'fabric', label: t('wms_asn_composition'), list: 'compositions', required: true },
    { key: 'country', label: t('wms_country'), upper: true, required: true, datalist: 'asn-countries' },
    { key: 'qty_expected', label: t('quantity'), num: true, required: true },
    { key: 'unit', label: t('wms_asn_unit'), upper: true },
    { key: 'import_type', label: t('wms_asn_import_type'), select: 'import_types' },
    { key: 'sample', label: t('wms_asn_sample'), checkbox: true },
    { key: 'part_number', label: t('wms_asn_part_number'), readonly: true },
    { key: 'style', label: t('wms_style'), upper: true }, { key: 'color', label: t('wms_label_color'), upper: true },
    { key: 'size', label: t('wms_label_size'), upper: true }, { key: 'po', label: 'PO' },
    ...(showAduana ? ADUANA_COLS : []),
  ];
  const gridCols = [...GRID_FIXED, ...asnCols.map(c => ({ key: c.key, extra: true, type: c.type }))];
  // Etiquetas de encabezado de la hoja, en el mismo orden que gridCols.
  const gridHeaders = [
    ...GRID_FIXED.map(c => ({ key: c.key, label: c.label + (c.required ? ' *' : ''), auto: c.readonly })),
    ...asnCols.map(c => ({ key: c.key, label: c.label, custom: true })),
  ];
  const [gridW, setGridW] = useState(loadGridWidths);
  const colWidth = (key) => Math.max(GRID_MIN_W, Number(gridW[key]) || GRID_COL_W);
  const gridTotalW = GRID_ROWNUM_W + GRID_TRASH_W + gridHeaders.reduce((a, h) => a + colWidth(h.key), 0);
  const resizing = useRef(null); // {key, startX, startW}
  // Pointer events (no mouse): el mismo arrastre sirve con ratón, dedo o lápiz
  // en la tableta; `touch-none` en la manija evita que el gesto haga scroll.
  const startResize = (key) => (e) => {
    e.preventDefault(); e.stopPropagation();
    resizing.current = { key, startX: e.clientX, startW: colWidth(key) };
    const onMove = (ev) => {
      const r = resizing.current; if (!r) return;
      setGridW(w => ({ ...w, [r.key]: Math.max(GRID_MIN_W, r.startW + (ev.clientX - r.startX)) }));
    };
    const onUp = () => {
      resizing.current = null;
      window.removeEventListener('pointermove', onMove); window.removeEventListener('pointerup', onUp); window.removeEventListener('pointercancel', onUp);
      setGridW(w => { saveGridWidths(w); return w; });
    };
    window.addEventListener('pointermove', onMove); window.addEventListener('pointerup', onUp); window.addEventListener('pointercancel', onUp);
  };
  const resetWidth = (key) => setGridW(w => { const n = { ...w }; delete n[key]; saveGridWidths(n); return n; });
  const gridRef = useRef(null);
  const pendingFocus = useRef(null); // {r, c}: celda a enfocar cuando exista la fila nueva
  // Se localizan las filas con querySelectorAll y no con tBodies[0].rows: en dev
  // el editor visual envuelve cada <tr> en un <span display:contents> y las
  // colecciones nativas (rows, sectionRowIndex) dejan de verlas.
  const gridRows = () => Array.from(gridRef.current?.querySelectorAll('tbody tr') || []);
  const rowCells = (tr) => Array.from(tr?.querySelectorAll('td') || []);
  const focusCell = (r, c) => {
    const el = rowCells(gridRows()[r])[c]?.querySelector('input,select');
    if (el) { el.focus(); if (el.select) el.select(); }
    return !!el;
  };
  useEffect(() => {
    if (pendingFocus.current && focusCell(pendingFocus.current.r, pendingFocus.current.c)) pendingFocus.current = null;
  }, [createDraft?.items?.length]); // eslint-disable-line react-hooks/exhaustive-deps
  const cellPos = (target) => {
    const td = target?.closest?.('td'); const tr = td?.closest?.('tr');
    if (!td || !tr) return null;
    const r = gridRows().indexOf(tr);
    const c = rowCells(tr).indexOf(td);
    return r < 0 || c < 0 ? null : { r, c };
  };
  // Enter baja a la misma columna de la fila siguiente (y crea la fila si es la
  // última); Tab en la última celda de la última fila crea una fila nueva.
  const onGridKeyDown = (e) => {
    if (e.target.tagName === 'SELECT' && e.key !== 'Tab') return;
    const pos = cellPos(e.target); if (!pos) return;
    const last = createDraft.items.length - 1;
    if (e.key === 'Enter') {
      e.preventDefault();
      if (pos.r < last) focusCell(pos.r + 1, pos.c);
      else { pendingFocus.current = { r: pos.r + 1, c: pos.c }; addCLine(); }
    } else if (e.key === 'Tab' && !e.shiftKey && pos.r === last) {
      // Última celda EDITABLE de la última fila (una fórmula al final no cuenta).
      const tr = e.target.closest('tr');
      const hasEditableAfter = rowCells(tr).slice(pos.c + 1).some(td => td.querySelector('input,select'));
      if (!hasEditableAfter) { e.preventDefault(); pendingFocus.current = { r: pos.r + 1, c: 1 }; addCLine(); }
    }
  };
  // ── Número de parte automático ─────────────────────────────────────────────
  // Cada vez que cambia algo que lo determina (cliente, descripción, prenda,
  // género, composición, país, muestra) se pide al servidor la propuesta de
  // ESA fila (350 ms de debounce). El servidor es la verdad: al guardar vuelve
  // a componer con los mismos catálogos.
  const proposeTimer = useRef(null);
  const lastSig = useRef({});
  useEffect(() => {
    if (!createDraft || !pnCfg) return undefined;
    clearTimeout(proposeTimer.current);
    proposeTimer.current = setTimeout(async () => {
      const cust = createDraft.customer || '';
      const jobs = createDraft.items.map((it, i) => {
        const sig = JSON.stringify([cust, it.description, it.garment, it.gender, it.fabric, it.country, !!it.sample]);
        if (lastSig.current[i] === sig) return null;
        lastSig.current[i] = sig;
        if (!it.description && !it.fabric && !it.garment) return null;
        return { i, sig, body: { customer: cust, description: it.description, country: it.country, sample: !!it.sample,
          garment: it._touched?.garment ? it.garment : undefined, gender: it._touched?.gender ? it.gender : undefined,
          fabric: it._touched?.fabric ? it.fabric : undefined } };
      }).filter(Boolean);
      if (!jobs.length) return;
      const results = await Promise.all(jobs.map(async j => {
        try { const res = await poster('/asn/part-number/propose', j.body); return { ...j, r: res.ok ? await res.json() : null }; }
        catch { return { ...j, r: null }; }
      }));
      setCreateDraft(d => {
        if (!d) return d;
        const items = d.items.slice();
        results.forEach(({ i, r }) => {
          const it = items[i]; if (!it || !r) return;
          const next = { ...it, _pn: { ok: r.ok, errors: r.errors || [] }, part_number: r.part_number || '' };
          PROPOSED_FIELDS.forEach(f => { if (!it._touched?.[f] && r[f] !== undefined) next[f] = r[f]; });
          // Composición pegada del Excel ("100% COTTON"): se sustituye por la
          // canónica del servidor ("100% ALGODON") para que case con el
          // desplegable; si hubo fibra desconocida se deja tal cual (marcada).
          if (it._touched?.fabric && r.fabric && !(r.errors || []).some(e => String(e).startsWith('fibra no reconocida'))) next.fabric = r.fabric;
          items[i] = next;
        });
        return { ...d, items };
      });
    }, 350);
    return () => clearTimeout(proposeTimer.current);
  }, [createDraft, pnCfg]); // eslint-disable-line react-hooks/exhaustive-deps

  // Pegar un bloque de Excel (celdas separadas por tab, filas por salto de
  // línea) a partir de la celda con foco; agrega las filas que hagan falta.
  // Una fila COMPLETA del packing list (15+ celdas) se mapea por PL_RAW_LAYOUT.
  const onGridPaste = (e) => {
    const text = e.clipboardData?.getData('text/plain') || '';
    if (!/[\t\r\n]/.test(text.trim())) return; // un solo valor: pegado normal
    const pos = cellPos(e.target); if (!pos) return;
    e.preventDefault();
    const rows = text.replace(/\r/g, '').split('\n').filter((l, i, a) => l.length || i < a.length - 1).map(l => l.split('\t'));
    const c0 = pos.c - 1; // la columna 0 de la cuadrícula es "#"
    const truthy = (v) => /^(1|true|si|sí|x|yes|ok)$/i.test(String(v).trim());
    setCreateDraft(d => {
      const items = d.items.slice();
      rows.forEach((cells, ri) => {
        const r = pos.r + ri;
        while (items.length <= r) items.push(NEW_LINE());
        const it = { ...items[r], extra: { ...(items[r].extra || {}) } };
        if (cells.length >= 15) {
          // Fila completa del Excel de aduana: posición fija, no la celda con foco.
          cells.forEach((raw, ci) => {
            const key = PL_RAW_LAYOUT[ci]; if (!key) return;
            const v = String(raw).trim();
            it[key] = ['description', 'country', 'unit', 'package_type', 'style', 'color'].includes(key) ? v.toUpperCase() : v;
            if (CATALOG_OF[key]) it[key] = snapToCatalog(CATALOG_OF[key], it[key]);
          });
        } else {
          cells.forEach((raw, ci) => {
            const col = gridCols[c0 + ci]; if (!col) return;
            const v = String(raw).trim();
            if (col.extra) {
              if (col.type === 'formula') return;
              it.extra[col.key] = col.type === 'checkbox' ? truthy(v) : v;
            } else if (col.readonly) {
              return; // el número de parte no se pega: se compone
            } else if (col.checkbox) {
              it[col.key] = truthy(v);
            } else {
              it[col.key] = col.list ? snapToCatalog(col.list, v.toUpperCase()) : (col.upper ? v.toUpperCase() : v);
              if (PROPOSED_FIELDS.includes(col.key)) it._touched = { ...(it._touched || {}), [col.key]: !!v };
            }
          });
        }
        items[r] = it;
      });
      return { ...d, items };
    });
  };
  const lineToPayload = (it) => ({
    description: it.description, garment: it.garment, gender: it.gender, fabric: it.fabric, country: it.country,
    qty_expected: parseInt(it.qty_expected, 10) || 0, unit: it.unit, import_type: it.import_type, sample: !!it.sample,
    part_number: it.part_number, style: it.style, color: it.color, size: it.size, po: it.po,
    unit_cost: it.unit_cost, total_cost: it.total_cost, net_weight: it.net_weight, gross_weight: it.gross_weight,
    bundles: it.bundles, package_type: it.package_type, extra: it.extra || {},
  });
  const submitCreate = async () => {
    const d = createDraft;
    if (!d.asn_id.trim()) { toast.error(t('wms_asn_entry_num_req')); return; }
    if (!d.customer) { toast.error(t('wms_asn_customer_req')); return; }
    const live = d.items.filter(it => (it.description || '').trim() || (it.part_number || '').trim() || (it.style || '').trim());
    if (!live.length) { toast.error(t('wms_asn_line_needs_desc')); return; }
    const bad = live.findIndex(it => !(parseInt(it.qty_expected, 10) > 0) || !(it.country || '').trim() || !(it.fabric || '').trim());
    if (bad >= 0) { toast.error(t('wms_asn_line_incomplete', { n: d.items.indexOf(live[bad]) + 1 })); return; }
    const noPn = live.findIndex(it => !it.part_number);
    if (noPn >= 0) { toast.error(t('wms_asn_line_no_pn', { n: d.items.indexOf(live[noPn]) + 1, why: (live[noPn]._pn?.errors || [])[0] || '' })); return; }
    const items = live.map(it => ({ ...lineToPayload(it), brand: d.vendor }));
    setSavingCreate(true);
    try {
      const res = await poster('/asn', { asn_id: d.asn_id.trim(), tipo: d.tipo, customer: d.customer, vendor: d.vendor, po_number: d.po_number, expected_date: d.expected_date, items });
      const r = await res.json().catch(() => ({}));
      if (res.ok) { toast.success(t('wms_asn_entry_created', { id: d.asn_id })); setShowCreate(false); setCreateDraft(null); loadAsns(); }
      else toast.error(r.detail || t('wms_asn_entry_create_err'));
    } catch (err) { logLoadError('create entry')(err); toast.error(t('wms_conn_error')); }
    finally { setSavingCreate(false); }
  };

  const runTrace = async () => {
    const q = traceQuery.trim();
    if (!q) return;
    setTraceLoading(true); setTraceResults(null);
    try {
      const data = await fetcher(`/asn/trace-sku?q=${encodeURIComponent(q)}`);
      setTraceResults(data);
    } catch (err) {
      logLoadError('trace sku')(err);
      toast.error(t('wms_asn_trace_err'));
    } finally { setTraceLoading(false); }
  };

  // Edit mode (super-user only)
  const [editing, setEditing] = useState(false);
  const [editDraft, setEditDraft] = useState(null);   // { vendor, po_number, expected_date, items: [...] }
  const [savingEdit, setSavingEdit] = useState(false);

  const startEdit = () => {
    const a = detailData?.asn;
    if (!a) return;
    setEditDraft({
      vendor: a.vendor || '',
      po_number: a.po_number || '',
      expected_date: a.expected_date || '',
      items: (a.items || []).map(it => ({
        line_no: it.line_no,
        part_number: it.part_number || '',
        description: it.description || '',
        country: it.country || '',
        brand: it.brand || '',
        // color/size/fabric no tienen columna en esta tabla pero SÍ se mandan al
        // guardar: si no se cargan aquí, editar una entrada los borraba.
        color: it.color || '',
        size: it.size || '',
        fabric: it.fabric || '',
        qty_expected: it.qty_expected || 0,
        qty_received: it.qty_received || 0,
        extra: it.extra || {},
        // formato único (fase 1): el servidor recompone el número de parte al guardar
        garment: it.garment || '', gender: it.gender || '', sample: !!it.sample, unit: it.unit || 'PZA',
        import_type: it.import_type || '', po: it.po || '', style: it.style || '',
        unit_cost: it.unit_cost ?? '', total_cost: it.total_cost ?? '', net_weight: it.net_weight ?? '',
        gross_weight: it.gross_weight ?? '', bundles: it.bundles ?? '', package_type: it.package_type || '',
      })),
      customer: a.customer || '',
    });
    setEditing(true);
  };
  const cancelEdit = () => { setEditing(false); setEditDraft(null); };

  // Finish the receiving process (records discrepancies even if expected != received).
  const [closing, setClosing] = useState(false);
  const refreshDetail = async () => {
    const fresh = await fetcher(`/asn/${encodeURIComponent(detailFor)}`);
    setDetailData(fresh);
    loadAsns();
  };
  const closeReceiving = async () => {
    if (!window.confirm(t('wms_asn_close_confirm'))) return;
    const note = window.prompt(t('wms_asn_close_note_prompt'), "") ?? "";
    setClosing(true);
    try {
      const res = await poster(`/asn/${encodeURIComponent(detailFor)}/close`, { note });
      if (!res.ok) { const e = await res.json().catch(() => ({})); toast.error(e.detail || t('wms_asn_close_err')); return; }
      toast.success(t('wms_asn_closed_ok'));
      await refreshDetail();
    } catch (err) { logLoadError('close asn')(err); toast.error(t('wms_conn_error')); }
    finally { setClosing(false); }
  };
  const reopenReceiving = async () => {
    if (!window.confirm(t('wms_asn_reopen_confirm'))) return;
    setClosing(true);
    try {
      const res = await poster(`/asn/${encodeURIComponent(detailFor)}/reopen`, {});
      if (!res.ok) { const e = await res.json().catch(() => ({})); toast.error(e.detail || t('wms_asn_reopen_err')); return; }
      toast.success(t('wms_asn_reopened_ok'));
      await refreshDetail();
    } catch (err) { logLoadError('reopen asn')(err); toast.error(t('wms_conn_error')); }
    finally { setClosing(false); }
  };
  const setItem = (i, field, value) =>
    setEditDraft(d => ({ ...d, items: d.items.map((it, j) => j === i ? { ...it, [field]: value } : it) }));
  const setItemExtra = (i, key, v) =>
    setEditDraft(d => ({ ...d, items: d.items.map((it, j) => j === i ? { ...it, extra: { ...(it.extra || {}), [key]: v } } : it) }));
  const addItem = () =>
    setEditDraft(d => ({ ...d, items: [...d.items, { part_number: '', description: '', country: '', brand: '', color: '', size: '', fabric: '', qty_expected: 0, qty_received: 0, extra: {}, garment: '', gender: '', sample: false, unit: 'PZA', import_type: 'Temporal', po: '', style: '' }] }));
  const removeItem = (i) =>
    setEditDraft(d => ({ ...d, items: d.items.filter((_, j) => j !== i) }));

  const saveEdit = async () => {
    if (!editDraft) return;
    const items = editDraft.items
      .filter(it => (it.part_number || '').trim() || (it.description || '').trim())
      .map(it => ({
        line_no: it.line_no,
        part_number: it.part_number,
        description: it.description,
        country: it.country,
        brand: it.brand,
        color: it.color || '',
        size: it.size || '',
        fabric: it.fabric || '',
        qty_expected: parseInt(it.qty_expected, 10) || 0,
        extra: it.extra || {},
        garment: it.garment || '', gender: it.gender || '', sample: !!it.sample, unit: it.unit || 'PZA',
        import_type: it.import_type || '', po: it.po || '', style: it.style || '',
        unit_cost: it.unit_cost, total_cost: it.total_cost, net_weight: it.net_weight,
        gross_weight: it.gross_weight, bundles: it.bundles, package_type: it.package_type || '',
      }));
    if (items.length === 0) { toast.error(t('wms_asn_min_line_pn')); return; }
    setSavingEdit(true);
    try {
      const res = await putter(`/asn/${encodeURIComponent(detailFor)}`, {
        vendor: editDraft.vendor, po_number: editDraft.po_number, expected_date: editDraft.expected_date,
        tipo: editDraft.tipo, customer: editDraft.customer, items,
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        toast.error(err.detail || t('wms_asn_save_err'));
        return;
      }
      toast.success(t('wms_asn_updated'));
      setEditing(false); setEditDraft(null);
      const fresh = await fetcher(`/asn/${encodeURIComponent(detailFor)}`);
      setDetailData(fresh);
      loadAsns();
    } catch (err) {
      logLoadError('update ASN')(err);
      toast.error(t('wms_conn_error'));
    } finally { setSavingEdit(false); }
  };

  const loadAsns = useCallback(async () => {
    try {
      const data = await fetcher("/asn");
      setAsns(data || []);
    } catch (err) { logLoadError('ASNs')(err); }
  }, []);

  useEffect(() => { loadAsns(); }, [loadAsns]);

  // Render FastAPI's "detail" field as a string: it can be a plain string, a
  // single validation error object, or an array of validation errors. Passing
  // an object/array directly into <Toaster/> renders an object as a React
  // child → React error #31 → black screen. Always coerce to string.
  const errMsg = (detail, fallback) => {
    if (!detail) return fallback;
    if (typeof detail === "string") return detail;
    if (Array.isArray(detail)) {
      return detail.map(d => (d && d.msg) ? `${(d.loc || []).join('.')}: ${d.msg}` : String(d)).join(' · ');
    }
    if (detail && typeof detail === "object" && detail.msg) return detail.msg;
    try { return JSON.stringify(detail); } catch { return fallback; }
  };

  const handleDelete = async (asnId, opts = {}) => {
    const a = asns.find(x => x.asn_id === asnId);
    const totalRcv = (a?.items || []).reduce((s, i) => s + (i.qty_received || 0), 0);
    const msg = totalRcv > 0
      ? t('wms_asn_delete_confirm_received', { id: asnId, n: totalRcv.toLocaleString() })
      : t('wms_asn_delete_confirm', { id: asnId });
    if (!window.confirm(msg)) return;
    try {
      await deleter(`/asn/${encodeURIComponent(asnId)}`);
      toast.success(t('wms_asn_deleted', { id: asnId }));
      if (opts.closeDetail) { setDetailFor(null); setDetailData(null); }
      loadAsns();
    } catch (err) {
      toast.error(t('wms_asn_delete_err'));
    }
  };

  // Export the currently visible list (respects active tab + search) into a
  // 2-sheet xlsx: "ASNs" (one row per ASN, summary) + "Líneas" (one row per
  // packing-list item, with progress per line). Detail items are fetched on
  // demand since the /asn list endpoint already includes them.
  const handleExport = async () => {
    if (filteredAsns.length === 0) {
      toast.error(t('wms_asn_export_empty'));
      return;
    }
    try {
      const labelOf = (st) => (STATUS_STYLES[st] ? t(STATUS_STYLES[st].labelKey) : (st || "").toUpperCase());
      const asnRows = filteredAsns.map(a => {
        const items = a.items || [];
        const exp = items.reduce((s, i) => s + (Number(i.qty_expected) || 0), 0);
        const rcv = items.reduce((s, i) => s + (Number(i.qty_received) || 0), 0);
        const pct = exp > 0 ? Math.min(100, Math.round((rcv / exp) * 100)) : 0;
        return {
          ASN: a.asn_id || "",
          Vendor: a.vendor || "",
          PO: a.po_number || "",
          [t('status')]: labelOf(a.status),
          [t('wms_lines')]: items.length,
          [t('wms_expected')]: exp,
          [t('wms_received')]: rcv,
          [t('wms_asn_progress_pct')]: pct,
          [t('wms_asn_registered')]: a.created_at ? new Date(a.created_at).toLocaleString() : "",
          [t('wms_asn_source_sheet')]: a.source_sheet || "",
        };
      });
      const itemRows = filteredAsns.flatMap(a => (a.items || []).map(it => {
        const exp = Number(it.qty_expected) || 0;
        const rcv = Number(it.qty_received) || 0;
        const pct = exp > 0 ? Math.min(100, Math.round((rcv / exp) * 100)) : 0;
        return {
          ASN: a.asn_id || "",
          Vendor: a.vendor || "",
          PO: a.po_number || "",
          [t('wms_line')]: it.line_no || "",
          'Part Number': it.part_number || "",
          [t('description')]: it.description || "",
          [t('wms_country')]: it.country || "",
          [t('wms_brand')]: it.brand || "",
          [t('wms_expected')]: exp,
          [t('wms_received')]: rcv,
          [t('wms_asn_progress_pct')]: pct,
        };
      }));

      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(asnRows), 'ASNs');
      XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(itemRows), t('wms_lines'));
      const buf = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
      const blob = new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
      const tag = activeTab === 'all' ? t('wms_asn_tab_all').toLowerCase() : labelOf(activeTab).toLowerCase().replace(/\s+/g, '-');
      saveAs(blob, `asn_${tag}_${new Date().toISOString().split('T')[0]}.xlsx`);
      toast.success(t('wms_asn_exported', { a: asnRows.length, b: itemRows.length }));
    } catch (err) {
      console.error("[ASN export] error", err);
      toast.error(t('wms_export_err'));
    }
  };

  const openDetail = async (asnId) => {
    setDetailFor(asnId);
    setDetailLoading(true);
    setDetailData(null);
    setEditing(false); setEditDraft(null);
    setExpandedParts(new Set()); setPartFilter(null);
    try {
      const data = await fetcher(`/asn/${encodeURIComponent(asnId)}`);
      setDetailData(data);
    } catch (err) {
      logLoadError('ASN detail')(err);
      toast.error(t('wms_asn_load_err'));
      setDetailFor(null);
    } finally { setDetailLoading(false); }
  };

  useEffect(() => {
    if (initialDetail?.id) openDetail(initialDetail.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialDetail]);

  const togglePart = (key) => setExpandedParts(prev => {
    const next = new Set(prev);
    if (next.has(key)) next.delete(key); else next.add(key);
    return next;
  });
  // Llave estable de un grupo de by_part (el grupo "sin número de parte" trae null).
  const partKey = (p) => p.part_number ?? '';
  const visibleBoxes = (detailData?.boxes || []).filter(b => partFilter == null || (b.part_number_resolved || '') === partFilter);

  const searched = asns.filter(a => {
    if (!query) return true;
    const q = query.toLowerCase();
    return (a.asn_id || "").toLowerCase().includes(q)
        || (a.po_number || "").toLowerCase().includes(q)
        || (a.vendor || "").toLowerCase().includes(q);
  });

  // Counts per tab respect the search box but ignore the active tab itself.
  const tabCounts = {
    all: searched.length,
    [AsnStatus.PENDING]:  searched.filter(a => a.status === AsnStatus.PENDING).length,
    [AsnStatus.PARTIAL]:  searched.filter(a => a.status === AsnStatus.PARTIAL).length,
    [AsnStatus.RECEIVED]: searched.filter(a => a.status === AsnStatus.RECEIVED).length,
  };

  const filteredAsns = activeTab === 'all'
    ? searched
    : searched.filter(a => a.status === activeTab);

  return (
    <div className="space-y-6">
      <ModuleToolbar
        right={
          <>
            <div className="relative">
              <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground"
      />
              <input
                placeholder={t('wms_asn_search_ph')}
                value={query}
                onChange={e => setQuery(e.target.value)}
                className="pl-9 pr-3 py-2 bg-card border border-input rounded-md text-sm text-foreground w-64 placeholder:text-muted-foreground/60 focus:outline-none focus:ring-2 focus:ring-ring/25 focus:border-ring transition-colors"
              />
            </div>
            <Btn
              onClick={handleExport}
              disabled={filteredAsns.length === 0}
              title={t('wms_asn_export_title')}
              data-testid="asn-export"
            >
              <FileUp className="w-4 h-4" />
              {t('wms_export')}
            </Btn>
            <Btn
              onClick={() => { setShowTrace(true); setTraceResults(null); setTraceQuery(""); }}
              title={t('wms_asn_trace_title')}
            >
              <Search className="w-4 h-4" />
              {t('wms_asn_trace_btn')}
            </Btn>
            {isSupersu && (
              <Btn onClick={openCreate} title={t('wms_asn_new_title')} data-testid="asn-new">
                <Plus className="w-4 h-4" /> {t('wms_asn_new_btn')}
              </Btn>
            )}
            {isSupersu && (
              <Btn onClick={() => setShowConfig(true)} title={t('wms_asn_cfg_title')} data-testid="asn-config">
                <Settings2 className="w-4 h-4" /> {t('wms_asn_cfg_btn')}
              </Btn>
            )}
          </>
        }
      />

      {/* Nueva columna para las líneas: el mismo modal del CRM (Radix Dialog,
          overlay z-[900]) — queda por encima de los overlays z-[100] de este módulo. */}
      <AsnConfigModal open={showConfig} onClose={() => setShowConfig(false)} onSaved={(c) => setPnCfg(c)} />
      <AddColumnModal isOpen={showAddCol} onClose={() => setShowAddCol(false)} onAdd={addAsnColumn}
        existingColumns={allLineCols}
        sampleRow={lineRow((createDraft?.items || editDraft?.items || detailData?.asn?.items || [])[0])} />

      {/* Nueva entrada — hoja de captura EN LÍNEA (no un modal): ocupa el ancho
          del módulo y la cuadrícula se comporta como una hoja de cálculo
          (Tab/Enter para moverse, pegado directo desde Excel). Mientras está
          abierta reemplaza la lista para que la captura sea lo único en pantalla. */}
      {showCreate && createDraft ? (
        <div className="border border-border rounded-lg bg-card overflow-hidden" data-testid="asn-create-sheet">
          <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5 border-b border-border bg-muted/30">
            <h3 className="font-bold text-sm flex items-center gap-2"><Plus className="w-4 h-4" /> {t('wms_asn_new_modal_title')}</h3>
            <div className="flex items-center gap-2">
              <Btn onClick={toggleAduana} className={showAduana ? 'border-primary text-primary' : ''}>{t('wms_asn_customs_data')}</Btn>
              {isSupersu && <Btn onClick={() => setShowAddCol(true)}><Columns3 className="w-3.5 h-3.5" /> {t('wms_add_column')}</Btn>}
              <Btn onClick={addCLine}><Plus className="w-3.5 h-3.5" /> {t('wms_add_line')}</Btn>
              <button onClick={() => !savingCreate && setShowCreate(false)} className="px-3 py-1.5 text-sm rounded-md text-muted-foreground hover:text-foreground">{t('cancel')}</button>
              <button onClick={submitCreate} disabled={savingCreate} className="px-4 py-1.5 text-sm font-semibold rounded-md bg-primary text-primary-foreground hover:opacity-90 disabled:opacity-50 flex items-center gap-1.5" data-testid="asn-create-save">
                {savingCreate ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />} {t('wms_asn_save_entry')}
              </button>
            </div>
          </div>

          {/* Cabecera de la entrada: una sola franja, campos sin caja. */}
          <div className="grid grid-cols-2 md:grid-cols-6 divide-x divide-border border-b border-border">
            {[
              { label: `${t('wms_asn_entry_number')} *`, el: <input value={createDraft.asn_id} onChange={e => setCreateDraft(d => ({ ...d, asn_id: e.target.value }))} className={`${GRID_CLS} font-mono`} placeholder={t('wms_asn_entry_ph')} autoFocus data-testid="asn-create-id" /> },
              { label: `${t('wms_asn_customer')} *`, el: (
                <select value={createDraft.customer} onChange={e => setCreateDraft(d => ({ ...d, customer: e.target.value }))} className={GRID_CLS} data-testid="asn-create-customer">
                  <option value="">—</option>
                  {pnCustomers.map(c => <option key={c} value={c}>{c} · {pnCfg.customers[c]}</option>)}
                </select>) },
              { label: t('wms_type'), el: (
                <select value={createDraft.tipo} onChange={e => setCreateDraft(d => ({ ...d, tipo: e.target.value }))} className={GRID_CLS}>
                  <option value="ASN">ASN</option>
                  <option value="BPO">BPO</option>
                </select>) },
              { label: t('wms_asn_vendor'), el: <input value={createDraft.vendor} onChange={e => setCreateDraft(d => ({ ...d, vendor: e.target.value.toUpperCase() }))} className={GRID_CLS} /> },
              { label: 'PO #', el: <input value={createDraft.po_number} onChange={e => setCreateDraft(d => ({ ...d, po_number: e.target.value }))} className={GRID_CLS} /> },
              { label: t('wms_asn_eta'), el: <input type="date" value={createDraft.expected_date} onChange={e => setCreateDraft(d => ({ ...d, expected_date: e.target.value }))} className={GRID_CLS} /> },
            ].map((f, i) => (
              <label key={i} className="flex flex-col">
                <span className="px-2 pt-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">{f.label}</span>
                {f.el}
              </label>
            ))}
          </div>

          {/* Cuadrícula */}
          <div className="overflow-x-auto">
            <table ref={gridRef} onKeyDown={onGridKeyDown} onPaste={onGridPaste}
              style={{ tableLayout: 'fixed', width: gridTotalW, minWidth: '100%' }}
              className="text-sm border-collapse [&_th]:border [&_th]:border-border/70 [&_td]:border [&_td]:border-border/60 [&_td]:p-0 [&_td]:overflow-hidden">
              {/* Anchos reales de la cuadrícula: uniformes por default, cada uno
                  estirable. Con table-layout fixed el ancho lo manda el <col>,
                  no el contenido, igual que en una hoja de cálculo. */}
              <colgroup>
                <col style={{ width: GRID_ROWNUM_W }} />
                {gridHeaders.map(h => <col key={h.key} style={{ width: colWidth(h.key) }} />)}
                <col style={{ width: GRID_TRASH_W }} />
              </colgroup>
              <thead className="bg-muted/50 select-none">
                <tr>
                  <th className="px-2 py-2 text-center text-xs font-semibold text-muted-foreground">#</th>
                  {gridHeaders.map(h => (
                    <th key={h.key} className="relative px-2 py-2 text-xs font-semibold text-muted-foreground whitespace-nowrap overflow-hidden text-ellipsis text-center" title={h.label}>
                      <span className="inline-flex items-center justify-center gap-1 max-w-full">
                        {h.auto && <Sparkles className="w-3 h-3 text-primary flex-shrink-0" title={t('wms_asn_pn_auto_hint')} />}
                        <span className="truncate">{h.label}</span>
                        {h.custom && isSupersu && (
                          <button onClick={() => removeAsnColumn(h.key)} className="p-0.5 rounded text-muted-foreground/60 hover:text-destructive hover:bg-destructive/10 flex-shrink-0" title={t('wms_remove_column')}>
                            <X className="w-3 h-3" />
                          </button>
                        )}
                      </span>
                      {/* Manija de redimensionado: el borde derecho del encabezado. */}
                      <span onPointerDown={startResize(h.key)} onDoubleClick={() => resetWidth(h.key)}
                        className="absolute top-0 right-0 h-full w-2 cursor-col-resize touch-none hover:bg-primary/50 active:bg-primary"
                        title={t('wms_resize_column')} data-testid={`asn-col-resize-${h.key}`} />
                    </th>
                  ))}
                  <th />
                </tr>
              </thead>
              <tbody>
                {createDraft.items.map((it, i) => (
                  <tr key={i} className="hover:bg-muted/20">
                    <td className="text-center text-xs font-mono text-muted-foreground select-none">{i + 1}</td>
                    {GRID_FIXED.map(col => (
                      <td key={col.key}>
                        {col.readonly ? (
                          <div className={`h-9 px-2 flex items-center gap-1 text-xs font-mono ${it.part_number ? 'text-foreground' : 'text-muted-foreground'}`}
                            title={it.part_number ? t('wms_asn_pn_auto_hint') : (it._pn?.errors || []).join(' · ') || t('wms_asn_pn_pending')} data-testid={`asn-cell-pn-${i}`}>
                            {it.part_number || (it._pn?.errors?.length ? <AlertTriangle className="w-3.5 h-3.5 text-amber-500" /> : '…')}
                            {it.part_number ? '' : <span className="truncate">{(it._pn?.errors || [])[0] || ''}</span>}
                          </div>
                        ) : col.checkbox ? (
                          <input type="checkbox" checked={!!it[col.key]} onChange={e => setCLine(i, col.key, e.target.checked)} className="w-4 h-4 accent-primary block mx-auto my-2.5" />
                        ) : col.list ? (
                          <select value={it[col.key] ?? ''} onChange={e => setCLine(i, col.key, e.target.value)}
                            className={`${GRID_CLS} ${it[col.key] && !inCatalog(col.list, it[col.key]) ? '!text-amber-600 dark:!text-amber-400' : ''}`}
                            title={it[col.key] && !inCatalog(col.list, it[col.key]) ? t('wms_asn_not_in_catalog') : (it[col.key] || undefined)}
                            data-testid={`asn-cell-${col.key}-${i}`}>
                            {catalogOptions(col.list, it[col.key]).map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                          </select>
                        ) : col.select ? (
                          <select value={it[col.key] ?? ''} onChange={e => setCLine(i, col.key, e.target.value)} className={GRID_CLS} data-testid={`asn-cell-${col.key}-${i}`}>
                            {col.select === 'import_types'
                              ? (pnCfg?.import_types || ['Temporal']).map(v => <option key={v} value={v}>{v}</option>)
                              : [<option key="" value="">{col.select === 'genders' ? (pnCfg?.genders?.[0]?.label || '—') : '—'}</option>,
                                 ...(pnCfg?.[col.select] || []).filter(g => g.code !== '').map(g => <option key={g.code} value={g.code}>{g.code} · {g.label}</option>)]}
                          </select>
                        ) : (
                          <input type={col.num ? 'number' : 'text'} min={col.num ? '0' : undefined} list={col.datalist} value={it[col.key] ?? ''}
                            onChange={e => setCLine(i, col.key, col.upper ? e.target.value.toUpperCase() : e.target.value)}
                            className={`${GRID_CLS} ${col.num ? 'text-right tabular-nums' : ''} ${col.key === 'description' ? '' : ''}`} data-testid={`asn-cell-${col.key}-${i}`} />
                        )}
                      </td>
                    ))}
                    {asnCols.map(c => <td key={c.key}><ExtraCell col={c} line={it} cols={allLineCols} grid onChange={v => setCLineExtra(i, c.key, v)} /></td>)}
                    <td className="text-center"><button tabIndex={-1} onClick={() => rmCLine(i)} className="p-1.5 text-muted-foreground hover:text-destructive hover:bg-destructive/10 rounded" title={t('wms_remove_line')}><Trash2 className="w-3.5 h-3.5" /></button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <datalist id="asn-countries">{pnCountries.map(c => <option key={c} value={c} />)}</datalist>
          <div className="flex items-center justify-between px-4 py-2 border-t border-border text-xs text-muted-foreground">
            <span>{createDraft.items.length} {t('wms_lines_lc')}</span>
            <span>{t('wms_asn_sheet_hint')}</span>
          </div>
        </div>
      ) : (
        <>
      {/* Status tabs */}
      <div className="flex flex-wrap gap-1 p-1 bg-muted/50 rounded-lg w-fit border border-border">
        {TABS.map(tab => {
          const isActive = activeTab === tab.id;
          const sd = STATUS_STYLES[tab.id];
          const count = tabCounts[tab.id] ?? 0;
          const baseCls = isActive
            ? (sd?.tabCls || 'bg-card text-foreground shadow-sm')
            : 'text-muted-foreground hover:text-foreground hover:bg-muted';
          return (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`px-4 py-1.5 rounded-md text-sm font-medium transition-colors flex items-center gap-2 ${baseCls}`}
              data-testid={`asn-tab-${tab.id}`}
            >
              {sd && <span className={`w-1.5 h-1.5 rounded-full ${sd.dot}`} />}
              {t(tab.labelKey)}
              <span className={`text-xs tabular-nums ${isActive ? 'opacity-90' : 'opacity-60'}`}>{count}</span>
            </button>
          );
        })}
      </div>

      {/* List view */}
      <div className="border border-border rounded-lg bg-card overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 border-b border-border">
              <tr>
                <th className="px-3 py-2.5 text-left text-xs font-semibold text-muted-foreground">ASN</th>
                <th className="px-3 py-2.5 text-left text-xs font-semibold text-muted-foreground">Vendor</th>
                <th className="px-3 py-2.5 text-left text-xs font-semibold text-muted-foreground">PO</th>
                <th className="px-3 py-2.5 text-center text-xs font-semibold text-muted-foreground">{t('status')}</th>
                <th className="px-3 py-2.5 text-right text-xs font-semibold text-muted-foreground">{t('wms_lines')}</th>
                <th className="px-3 py-2.5 text-right text-xs font-semibold text-muted-foreground">{t('wms_asn_rcv_exp')}</th>
                <th className="px-3 py-2.5 text-left text-xs font-semibold text-muted-foreground w-40">{t('wms_asn_progress')}</th>
                <th className="px-3 py-2.5 text-left text-xs font-semibold text-muted-foreground">{t('wms_asn_registered')}</th>
                <th className="px-3 py-2.5 w-10"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border/60">
              {filteredAsns.length === 0 ? (
                <tr>
                  <td colSpan={9} className="py-16 text-center">
                    <p className="text-sm font-semibold text-foreground/80">
                      {asns.length === 0 ? t('wms_asn_none') : t('wms_asn_no_match_tab')}
                    </p>
                  </td>
                </tr>
              ) : (
                filteredAsns.map(a => {
                  const totalExp = (a.items || []).reduce((s, i) => s + (i.qty_expected || 0), 0);
                  const totalRcv = (a.items || []).reduce((s, i) => s + (i.qty_received || 0), 0);
                  const pct = totalExp > 0 ? Math.min(100, Math.round((totalRcv / totalExp) * 100)) : 0;
                  const sd = STATUS_STYLES[a.status] || STATUS_STYLES[AsnStatus.PENDING];
                  return (
                    <tr
                      key={a.asn_id}
                      onClick={() => openDetail(a.asn_id)}
                      className="hover:bg-muted/40 cursor-pointer transition-colors"
                      data-testid={`asn-row-${a.asn_id}`}
                    >
                      <td className="px-3 py-2.5 font-mono font-medium text-foreground text-xs">{a.asn_id}</td>
                      <td className="px-3 py-2.5 text-xs truncate max-w-[220px]" title={a.vendor}>{a.vendor || '—'}</td>
                      <td className="px-3 py-2.5 text-xs font-mono text-muted-foreground">{a.po_number || '—'}</td>
                      <td className="px-3 py-2.5 text-center">
                        <span className={`inline-flex items-center px-2 py-0.5 rounded-md text-xs font-medium whitespace-nowrap border ${sd.cls}`}>
                          {t(sd.labelKey)}
                        </span>
                      </td>
                      <td className="px-3 py-2.5 text-right tabular-nums text-xs font-medium">{a.items?.length || 0}</td>
                      <td className="px-3 py-2.5 text-right tabular-nums text-xs font-medium">
                        <span className={pct >= 100 ? 'text-emerald-600 dark:text-emerald-400' : totalRcv > 0 ? 'text-amber-600 dark:text-amber-400' : 'text-muted-foreground'}>
                          {totalRcv.toLocaleString()}
                        </span>
                        <span className="text-muted-foreground"> / {totalExp.toLocaleString()}</span>
                      </td>
                      <td className="px-3 py-2.5">
                        <div className="flex items-center gap-2">
                          <div className="flex-1 h-1.5 bg-muted rounded-full overflow-hidden min-w-[60px]">
                            <div className={`h-full transition-all ${pct >= 100 ? 'bg-emerald-500' : pct > 0 ? 'bg-amber-500' : 'bg-blue-500'}`} style={{ width: `${pct}%` }} />
                          </div>
                          <span className="text-xs font-mono font-medium tabular-nums w-9 text-right">{pct}%</span>
                        </div>
                      </td>
                      <td className="px-3 py-2.5 text-xs font-mono text-muted-foreground whitespace-nowrap">
                        {a.created_at ? new Date(a.created_at).toLocaleDateString() : '—'}
                      </td>
                      <td className="px-3 py-2.5">
                        <button
                          onClick={(e) => { e.stopPropagation(); handleDelete(a.asn_id); }}
                          className="p-1.5 rounded-md text-muted-foreground/40 hover:text-destructive hover:bg-destructive/10 transition-colors"
                          title={t('wms_asn_delete_btn')}
                          data-testid={`asn-delete-${a.asn_id}`}
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>

        </>
      )}

      {/* Detail modal */}
      {detailFor && (
        <div className="fixed inset-0 z-[70] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm animate-in fade-in duration-150">
          <div className="bg-card border border-border rounded-lg w-full max-w-5xl max-h-[85vh] flex flex-col shadow-xl animate-in zoom-in-95 duration-150">
            <div className="flex items-center justify-between p-5 border-b border-border/20">
              <div className="flex items-center gap-3 min-w-0">
                <div className="w-10 h-10 rounded-lg bg-muted flex items-center justify-center flex-shrink-0">
                  <Package className="w-5 h-5 text-muted-foreground" />
                </div>
                <div className="min-w-0">
                  <h3 className="font-semibold text-sm truncate flex items-center gap-2">
                    ASN {detailFor}
                    {detailData?.asn?.closed && (
                      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md border text-xs font-medium bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-500/10 dark:text-emerald-300 dark:border-emerald-500/25"><Lock className="w-3 h-3" /> {t('wms_asn_closed_badge')}</span>
                    )}
                  </h3>
                  {detailData?.asn && (
                    <p className="text-xs text-muted-foreground truncate">
                      <span className="text-foreground">{detailData.asn.vendor || '—'}</span>
                      {detailData.asn.po_number && <> · PO {detailData.asn.po_number}</>}
                      {detailData.asn.source_sheet && <> · {detailData.asn.source_sheet}</>}
                    </p>
                  )}
                </div>
              </div>
              <div className="flex items-center gap-1 flex-shrink-0">
                {isSupersu && !editing && detailData && (
                  <button
                    onClick={startEdit}
                    className="p-2 text-muted-foreground hover:text-primary hover:bg-primary/10 rounded-lg transition-all"
                    title={t('wms_asn_edit_title')}
                    data-testid="asn-detail-edit"
                  >
                    <Pencil className="w-5 h-5" />
                  </button>
                )}
                {editing && (
                  <>
                    <Btn
                      variant="primary"
                      onClick={saveEdit}
                      disabled={savingEdit}
                    >
                      {savingEdit ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />} {t('save')}
                    </Btn>
                    <Btn variant="ghost" onClick={cancelEdit}>
                      {t('cancel')}
                    </Btn>
                  </>
                )}
                {!editing && detailData && !detailData.asn?.closed && (
                  <Btn
                    variant="primary"
                    onClick={closeReceiving}
                    disabled={closing}
                    title={t('wms_asn_close_btn_title')}
                    data-testid="asn-close-receiving"
                  >
                    {closing ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle2 className="w-4 h-4" />} {t('wms_asn_close_btn')}
                  </Btn>
                )}
                {!editing && detailData?.asn?.closed && isSupersu && (
                  <Btn
                    onClick={reopenReceiving}
                    disabled={closing}
                    title={t('wms_asn_reopen_title')}
                  >
                    {closing ? <Loader2 className="w-4 h-4 animate-spin" /> : <RotateCcw className="w-4 h-4" />} {t('wms_asn_reopen_btn')}
                  </Btn>
                )}
                {!editing && (
                  <button
                    onClick={() => handleDelete(detailFor, { closeDetail: true })}
                    className="p-2 text-muted-foreground hover:text-destructive hover:bg-destructive/10 rounded-lg transition-all"
                    title={t('wms_asn_delete_btn')}
                    data-testid="asn-detail-delete"
                  >
                    <Trash2 className="w-5 h-5" />
                  </button>
                )}
                <button onClick={() => { setDetailFor(null); setDetailData(null); cancelEdit(); }} className="p-2 hover:bg-secondary rounded-lg transition-all">
                  <X className="w-5 h-5" />
                </button>
              </div>
            </div>

            <div className="flex-1 overflow-auto custom-scrollbar">
              {detailLoading ? (
                <div className="flex items-center justify-center py-20">
                  <Loader2 className="w-8 h-8 animate-spin text-muted-foreground" />
                </div>
              ) : detailData ? (
                <div className="p-5 space-y-6">
                  {/* Trazabilidad: summary cards + recepciones agregadas */}
                  {detailData.summary && (
                    <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                      <StatCard label={t('wms_received')} value={(detailData.summary.units_received ?? detailData.summary.total_units ?? 0).toLocaleString()} />
                      <StatCard label={t('wms_in_inventory')} value={(detailData.summary.units_in_stock || 0).toLocaleString()} sub={t('wms_boxes_count', { n: detailData.summary.boxes_in_stock || 0 })} />
                      <StatCard label={t('wms_asn_out_consumed')} value={(detailData.summary.units_out || 0).toLocaleString()} />
                      <StatCard label={t('wms_locations')} value={(detailData.summary.by_location || detailData.summary.distinct_locations || []).length} />
                      {detailData.summary.first_received_at && (
                        <div className="md:col-span-2 p-3 rounded-lg bg-card border border-border">
                          <div className="text-xs font-medium text-muted-foreground mb-0.5">{t('wms_asn_reception_period')}</div>
                          <div className="text-xs font-mono">
                            {new Date(detailData.summary.first_received_at).toLocaleString()}
                            {' → '}
                            {new Date(detailData.summary.last_received_at).toLocaleString()}
                          </div>
                        </div>
                      )}
                      {(detailData.summary.receivers || []).length > 0 && (
                        <div className="md:col-span-2 p-3 rounded-lg bg-card border border-border">
                          <div className="text-xs font-medium text-muted-foreground mb-0.5">{t('wms_asn_receivers')}</div>
                          <div className="text-xs flex flex-wrap gap-1.5">
                            {(detailData.summary.receivers || []).map(r => (
                              <span key={r} className="px-2 py-0.5 bg-muted border border-border rounded-md text-xs font-medium">
                                {r}
                              </span>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  )}

                  {/* Fase 3: lo esperado vs lo que llegó POR NÚMERO DE PARTE. Un
                      número de parte cubre varios estilos/colores/tallas, así que
                      cada fila se abre al desglose de lo que llegó contra ella. */}
                  {(detailData.summary?.by_part || []).length > 0 && (
                    <div data-testid="asn-by-part">
                      <h4 className="text-xs font-semibold text-muted-foreground mb-2">{t('wms_asn_by_part')}</h4>
                      <div className="border border-border rounded-lg overflow-x-auto">
                        <table className="w-full text-sm">
                          <thead className="bg-muted/50 border-b border-border">
                            <tr>
                              <th className="px-2 py-2.5 w-8"></th>
                              <th className="px-3 py-2.5 text-left text-xs font-semibold text-muted-foreground">{t('wms_asn_part_number')}</th>
                              <th className="px-3 py-2.5 text-left text-xs font-semibold text-muted-foreground">{t('description')}</th>
                              <th className="px-3 py-2.5 text-left text-xs font-semibold text-muted-foreground">{t('wms_asn_lines_n')}</th>
                              <th className="px-3 py-2.5 text-right text-xs font-semibold text-muted-foreground">{t('wms_expected')}</th>
                              <th className="px-3 py-2.5 text-right text-xs font-semibold text-muted-foreground">{t('wms_received')}</th>
                              <th className="px-3 py-2.5 text-right text-xs font-semibold text-muted-foreground">{t('wms_in_inventory')}</th>
                              <th className="px-3 py-2.5 text-right text-xs font-semibold text-muted-foreground">{t('wms_boxes')}</th>
                              <th className="px-3 py-2.5 text-left text-xs font-semibold text-muted-foreground w-32">{t('progress')}</th>
                              <th className="px-3 py-2.5 w-24"></th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-border/60">
                            {detailData.summary.by_part.map(p => {
                              const key = partKey(p);
                              const open = expandedParts.has(key);
                              const exp = p.qty_expected || 0;
                              const rcv = p.qty_received || 0;
                              const pct = exp > 0 ? Math.min(100, Math.round((rcv / exp) * 100)) : 0;
                              const done = exp > 0 && rcv >= exp;
                              const canOpen = (p.skus || []).length > 0;
                              return [
                                <tr key={key} onClick={() => canOpen && togglePart(key)} data-testid="asn-part-row"
                                  className={`${canOpen ? 'cursor-pointer' : ''} hover:bg-muted/40 ${p.unmatched ? 'bg-amber-500/5' : ''}`}>
                                  <td className="px-2 py-2.5 text-muted-foreground">
                                    {canOpen && <ChevronRight className={`w-4 h-4 transition-transform ${open ? 'rotate-90' : ''}`} />}
                                  </td>
                                  <td className="px-3 py-2.5 text-xs font-mono font-semibold whitespace-nowrap">
                                    {p.unmatched ? <span className="text-amber-600 dark:text-amber-400">{t('wms_asn_no_part')}</span> : p.part_number}
                                    {p.sample && <span className="ml-1.5 text-[10px] font-semibold px-1 py-0.5 rounded bg-muted text-muted-foreground">{t('wms_asn_sample')}</span>}
                                    {p.boxes_best_effort > 0 && (
                                      <span className="ml-1.5 text-[10px] font-semibold px-1 py-0.5 rounded bg-amber-500/15 text-amber-600 dark:text-amber-400" title={t('wms_asn_best_effort_hint', { n: p.boxes_best_effort })}>≈</span>
                                    )}
                                  </td>
                                  <td className="px-3 py-2.5 text-xs max-w-[260px] truncate" title={p.description}>{p.description || '—'}</td>
                                  <td className="px-3 py-2.5 text-xs font-mono text-muted-foreground">{(p.line_nos || []).join(', ') || '—'}</td>
                                  <td className="px-3 py-2.5 text-xs text-right tabular-nums font-bold">{exp.toLocaleString()}</td>
                                  <td className={`px-3 py-2.5 text-xs text-right tabular-nums font-medium ${done ? 'text-emerald-600 dark:text-emerald-400' : rcv > 0 ? 'text-amber-600 dark:text-amber-400' : 'text-muted-foreground'}`}>{rcv.toLocaleString()}</td>
                                  <td className="px-3 py-2.5 text-xs text-right tabular-nums font-medium">{(p.units_in_stock || 0).toLocaleString()}</td>
                                  <td className="px-3 py-2.5 text-xs text-right tabular-nums">{(p.boxes || 0).toLocaleString()}</td>
                                  <td className="px-3 py-2.5">
                                    {p.unmatched ? null : (
                                      <>
                                        <div className="h-1.5 bg-muted rounded-full overflow-hidden">
                                          <div className={`h-full ${done ? 'bg-emerald-500' : rcv > 0 ? 'bg-amber-500' : 'bg-blue-500/40'}`} style={{ width: `${pct}%` }} />
                                        </div>
                                        <div className="text-xs text-muted-foreground mt-0.5">{pct}%</div>
                                      </>
                                    )}
                                  </td>
                                  <td className="px-3 py-2.5 text-right">
                                    {p.boxes > 0 && (
                                      <button type="button" onClick={(e) => { e.stopPropagation(); setPartFilter(partFilter === key ? null : key); }}
                                        className={`inline-flex items-center gap-1 text-xs font-medium whitespace-nowrap ${partFilter === key ? 'text-primary' : 'text-muted-foreground hover:text-foreground'}`}>
                                        <Filter className="w-3 h-3" /> {t('wms_asn_show_boxes')}
                                      </button>
                                    )}
                                  </td>
                                </tr>,
                                open && (
                                  <tr key={`${key}__skus`} className="bg-muted/20">
                                    <td></td>
                                    <td colSpan={9} className="px-3 py-2">
                                      <table className="w-full text-xs" data-testid="asn-part-skus">
                                        <thead>
                                          <tr className="text-muted-foreground">
                                            <th className="px-2 py-1 text-left font-semibold">{t('wms_label_style')}</th>
                                            <th className="px-2 py-1 text-left font-semibold">{t('wms_label_color')}</th>
                                            <th className="px-2 py-1 text-left font-semibold">{t('wms_label_size')}</th>
                                            <th className="px-2 py-1 text-right font-semibold">{t('wms_asn_arrived')}</th>
                                            <th className="px-2 py-1 text-right font-semibold">{t('wms_in_inventory')}</th>
                                            <th className="px-2 py-1 text-right font-semibold">{t('wms_boxes')}</th>
                                            <th className="px-2 py-1 text-left font-semibold">{t('wms_locations')}</th>
                                          </tr>
                                        </thead>
                                        <tbody className="divide-y divide-border/40">
                                          {p.skus.map(sk => (
                                            <tr key={`${sk.style}|${sk.color}|${sk.size}`}>
                                              <td className="px-2 py-1 font-mono font-medium">{sk.style || '—'}</td>
                                              <td className="px-2 py-1">{sk.color || '—'}</td>
                                              <td className="px-2 py-1 font-mono">{sk.size || '—'}</td>
                                              <td className="px-2 py-1 text-right tabular-nums font-medium">{(sk.units_arrived || 0).toLocaleString()}</td>
                                              <td className="px-2 py-1 text-right tabular-nums">{(sk.units_in_stock || 0).toLocaleString()}</td>
                                              <td className="px-2 py-1 text-right tabular-nums text-muted-foreground">{sk.boxes_in_stock || 0}/{sk.boxes || 0}</td>
                                              <td className="px-2 py-1 font-mono text-muted-foreground">{(sk.locations || []).join(', ') || '—'}</td>
                                            </tr>
                                          ))}
                                        </tbody>
                                      </table>
                                    </td>
                                  </tr>
                                ),
                              ];
                            })}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  )}

                  {/* Inventario restante por ubicación (trazabilidad) */}
                  {(detailData.summary?.by_location || []).length > 0 && (
                    <div>
                      <h4 className="text-xs font-semibold text-muted-foreground mb-2">{t('wms_asn_remaining_by_loc')}</h4>
                      <div className="border border-border rounded-lg overflow-hidden">
                        <table className="w-full text-sm">
                          <thead className="bg-muted/50 border-b border-border">
                            <tr>
                              <th className="px-3 py-2.5 text-left text-xs font-semibold text-muted-foreground">{t('location')}</th>
                              <th className="px-3 py-2.5 text-right text-xs font-semibold text-muted-foreground">{t('wms_boxes')}</th>
                              <th className="px-3 py-2.5 text-right text-xs font-semibold text-muted-foreground">{t('wms_label_units')}</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-border/60">
                            {detailData.summary.by_location.map(l => (
                              <tr key={l.location} className="hover:bg-muted/40">
                                <td className="px-3 py-2.5 text-xs font-mono">{l.location}</td>
                                <td className="px-3 py-2.5 text-xs text-right tabular-nums">{(l.boxes || 0).toLocaleString()}</td>
                                <td className="px-3 py-2.5 text-xs text-right tabular-nums font-bold">{(l.units || 0).toLocaleString()}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  )}

                  {/* Eventos de recepción (1 row por receiving_id) */}
                  {detailData.receivings && detailData.receivings.length > 0 && (
                    <div>
                      <h4 className="text-xs font-semibold text-muted-foreground mb-2">
                        {t('wms_asn_receiving_events', { n: detailData.receivings.length })}
                      </h4>
                      <div className="border border-border rounded-lg overflow-hidden">
                        <table className="w-full text-sm">
                          <thead className="bg-muted/50 border-b border-border">
                            <tr>
                              <th className="px-3 py-2.5 text-left text-xs font-semibold text-muted-foreground">{t('date')}</th>
                              <th className="px-3 py-2.5 text-left text-xs font-semibold text-muted-foreground">Receiving ID</th>
                              <th className="px-3 py-2.5 text-left text-xs font-semibold text-muted-foreground">{t('wms_style_sku')}</th>
                              <th className="px-3 py-2.5 text-left text-xs font-semibold text-muted-foreground">{t('wms_asn_color_size')}</th>
                              <th className="px-3 py-2.5 text-left text-xs font-semibold text-muted-foreground">{t('wms_asn_lot')}</th>
                              <th className="px-3 py-2.5 text-left text-xs font-semibold text-muted-foreground">{t('location')}</th>
                              <th className="px-3 py-2.5 text-right text-xs font-semibold text-muted-foreground">{t('wms_boxes')}</th>
                              <th className="px-3 py-2.5 text-right text-xs font-semibold text-muted-foreground">{t('wms_label_units')}</th>
                              <th className="px-3 py-2.5 text-left text-xs font-semibold text-muted-foreground">{t('wms_asn_received_by')}</th>
                              <th className="px-3 py-2.5 w-10"></th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-border/60">
                            {detailData.receivings.map(r => (
                              <tr key={r.receiving_id} className="hover:bg-muted/40">
                                <td className="px-3 py-2.5 text-xs font-mono text-muted-foreground whitespace-nowrap">{r.created_at ? new Date(r.created_at).toLocaleString() : '—'}</td>
                                <td className="px-3 py-2.5 text-xs font-mono font-bold text-primary">{r.receiving_id}</td>
                                <td className="px-3 py-2.5 text-xs font-mono">{r.style || r.sku || '—'}</td>
                                <td className="px-3 py-2.5 text-xs">{r.color || '—'} · {r.size || '—'}</td>
                                <td className="px-3 py-2.5 text-xs font-mono text-muted-foreground">{r.lot_number || '—'}</td>
                                <td className="px-3 py-2.5 text-xs font-mono">{r.inv_location || '—'}</td>
                                <td className="px-3 py-2.5 text-right text-xs tabular-nums font-medium">{(r.boxes || []).length}</td>
                                <td className="px-3 py-2.5 text-right text-xs tabular-nums font-medium">{(r.total_units || 0).toLocaleString()}</td>
                                <td className="px-3 py-2.5 text-xs text-muted-foreground">{r.received_by_name || '—'}</td>
                                <td className="px-3 py-2.5 text-right">
                                  {isSupersu && !detailData?.asn?.closed && (
                                    <button
                                      onClick={async (e) => {
                                        e.stopPropagation();
                                        if (!window.confirm(t('wms_asn_delete_receipt_confirm', { id: r.receiving_id }))) return;
                                        try {
                                          await deleter(`/receiving/${encodeURIComponent(r.receiving_id)}`);
                                          toast.success(t('wms_asn_receipt_deleted'));
                                          refreshDetail();
                                        } catch (err) {
                                          toast.error(t('wms_asn_receipt_delete_err'));
                                        }
                                      }}
                                      className="p-1.5 rounded text-muted-foreground/40 hover:text-destructive hover:bg-destructive/10 transition-all"
                                      title={t('wms_asn_delete_receipt')}
                                    >
                                      <Trash2 className="w-4 h-4" />
                                    </button>
                                  )}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  )}

                  {/* Editable header fields (super-user edit mode) */}
                  {editing && editDraft && (
                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                      <div>
                        <label className="text-xs font-medium text-muted-foreground">{t('wms_asn_vendor')}</label>
                        <input value={editDraft.vendor} onChange={e => setEditDraft(d => ({ ...d, vendor: e.target.value }))}
                          className="w-full mt-1 h-9 px-3 bg-card border border-input rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-ring/25 focus:border-ring transition-colors" />
                      </div>
                      <div>
                        <label className="text-xs font-medium text-muted-foreground">PO #</label>
                        <input value={editDraft.po_number} onChange={e => setEditDraft(d => ({ ...d, po_number: e.target.value }))}
                          className="w-full mt-1 h-9 px-3 bg-card border border-input rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-ring/25 focus:border-ring transition-colors" />
                      </div>
                      <div>
                        <label className="text-xs font-medium text-muted-foreground">{t('wms_asn_expected_date')}</label>
                        <input value={editDraft.expected_date} onChange={e => setEditDraft(d => ({ ...d, expected_date: e.target.value }))}
                          className="w-full mt-1 h-9 px-3 bg-card border border-input rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-ring/25 focus:border-ring transition-colors" />
                      </div>
                    </div>
                  )}

                  {/* Discrepancy log */}
                  {!editing && (() => {
                    const asn = detailData.asn || {};
                    const disc = asn.closed
                      ? (asn.discrepancies || [])
                      : (asn.items || []).map(it => {
                          const exp = it.qty_expected || 0, rcv = it.qty_received || 0, d = rcv - exp;
                          return d !== 0 ? { line_no: it.line_no, part_number: it.part_number, qty_expected: exp, qty_received: rcv, difference: d, type: d > 0 ? 'SOBRANTE' : 'FALTANTE' } : null;
                        }).filter(Boolean);
                    return (
                      <div>
                        <div className="flex items-center justify-between mb-2">
                          <h4 className="text-xs font-semibold text-muted-foreground">
                            {t('wms_asn_disc_log')} {asn.closed ? '' : <span className="text-amber-600/80 dark:text-amber-400/80 font-normal">{t('wms_asn_live')}</span>}
                          </h4>
                          {disc.length > 0 && <span className="text-xs font-medium text-amber-600 dark:text-amber-400">{t('wms_asn_n_lines', { n: disc.length })}</span>}
                        </div>
                        {asn.closed && (
                          <div className="mb-2 text-xs text-muted-foreground bg-muted/40 border border-border rounded-lg p-3">
                            {t('wms_asn_closed_by')} <b className="text-foreground/80">{asn.closed_by_name || '—'}</b>
                            {asn.closed_at && <> · {new Date(asn.closed_at).toLocaleString()}</>}
                            {asn.closure_note && <div className="mt-1 italic">“{asn.closure_note}”</div>}
                          </div>
                        )}
                        {disc.length === 0 ? (
                          <div className="flex items-center gap-2 text-emerald-700 dark:text-emerald-300 bg-emerald-50 dark:bg-emerald-500/10 border border-emerald-200/70 dark:border-emerald-500/25 rounded-lg p-3">
                            <CheckCircle2 className="w-4 h-4" /><span className="text-xs font-medium">{t('wms_asn_no_disc')}</span>
                          </div>
                        ) : (
                          <div className="border border-border rounded-lg overflow-hidden">
                            <table className="w-full text-sm">
                              <thead className="bg-muted/50 border-b border-border">
                                <tr>
                                  <th className="px-3 py-2.5 text-left text-xs font-semibold text-muted-foreground">#</th>
                                  <th className="px-3 py-2.5 text-left text-xs font-semibold text-muted-foreground">Part Number</th>
                                  <th className="px-3 py-2.5 text-right text-xs font-semibold text-muted-foreground">{t('wms_expected')}</th>
                                  <th className="px-3 py-2.5 text-right text-xs font-semibold text-muted-foreground">{t('wms_received')}</th>
                                  <th className="px-3 py-2.5 text-right text-xs font-semibold text-muted-foreground">{t('wms_asn_difference')}</th>
                                  <th className="px-3 py-2.5 text-left text-xs font-semibold text-muted-foreground">{t('wms_type')}</th>
                                </tr>
                              </thead>
                              <tbody className="divide-y divide-border/60">
                                {disc.map((d, i) => (
                                  <tr key={i} className="hover:bg-muted/40">
                                    <td className="px-3 py-2.5 text-xs font-mono text-muted-foreground">{d.line_no}</td>
                                    <td className="px-3 py-2.5 text-xs font-mono font-medium">{d.part_number}</td>
                                    <td className="px-3 py-2.5 text-xs text-right tabular-nums">{(d.qty_expected || 0).toLocaleString()}</td>
                                    <td className="px-3 py-2.5 text-xs text-right tabular-nums">{(d.qty_received || 0).toLocaleString()}</td>
                                    <td className={`px-3 py-2.5 text-xs text-right tabular-nums font-medium ${d.difference > 0 ? 'text-amber-600 dark:text-amber-400' : 'text-red-600 dark:text-red-400'}`}>{d.difference > 0 ? '+' : ''}{d.difference.toLocaleString()}</td>
                                    <td className="px-3 py-2.5"><span className={`px-2 py-0.5 rounded-md border text-xs font-medium whitespace-nowrap ${d.difference > 0 ? 'bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-500/10 dark:text-amber-300 dark:border-amber-500/25' : 'bg-red-50 text-red-700 border-red-200 dark:bg-red-500/10 dark:text-red-300 dark:border-red-500/25'}`}>{DISC_TYPE_KEY[d.type] ? t(DISC_TYPE_KEY[d.type]) : d.type}</span></td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                        )}
                      </div>
                    );
                  })()}

                  {/* Expected vs received table */}
                  <div>
                    <div className="flex items-center justify-between mb-2">
                      <h4 className="text-xs font-semibold text-muted-foreground">{t('wms_asn_pl_lines')}</h4>
                      {editing && (
                        <div className="flex items-center gap-2">
                          {isSupersu && <Btn onClick={() => setShowAddCol(true)}><Columns3 className="w-3.5 h-3.5" /> {t('wms_add_column')}</Btn>}
                          <Btn onClick={addItem}>
                            <Plus className="w-3.5 h-3.5" /> {t('wms_add_line')}
                          </Btn>
                        </div>
                      )}
                    </div>
                    <div className="border border-border rounded-lg overflow-x-auto">
                      <table className="w-full text-sm">
                        <thead className="bg-muted/50 border-b border-border">
                          <tr>
                            <th className="px-3 py-2.5 text-left text-xs font-semibold text-muted-foreground">#</th>
                            <th className="px-3 py-2.5 text-left text-xs font-semibold text-muted-foreground">Part Number</th>
                            <th className="px-3 py-2.5 text-left text-xs font-semibold text-muted-foreground">{t('description')}</th>
                            <th className="px-3 py-2.5 text-left text-xs font-semibold text-muted-foreground">{t('wms_asn_garment')}</th>
                            <th className="px-3 py-2.5 text-left text-xs font-semibold text-muted-foreground">{t('wms_asn_composition')}</th>
                            <th className="px-3 py-2.5 text-center text-xs font-semibold text-muted-foreground">{t('wms_asn_sample')}</th>
                            <th className="px-3 py-2.5 text-left text-xs font-semibold text-muted-foreground">{t('wms_country')}</th>
                            <th className="px-3 py-2.5 text-left text-xs font-semibold text-muted-foreground">{t('wms_brand')}</th>
                            {asnCols.map(c => <ExtraTh key={c.key} col={c} cls="px-3 py-2.5 text-left text-xs font-semibold text-muted-foreground whitespace-nowrap" />)}
                            <th className="px-3 py-2.5 text-right text-xs font-semibold text-muted-foreground">{t('wms_expected')}</th>
                            <th className="px-3 py-2.5 text-right text-xs font-semibold text-muted-foreground">{t('wms_received')}</th>
                            {!editing && <th className="px-3 py-2.5 text-right text-xs font-semibold text-muted-foreground">{t('wms_in_inventory')}</th>}
                            <th className="px-3 py-2.5 text-left text-xs font-semibold text-muted-foreground w-32">{editing ? '' : t('progress')}</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-border/60">
                          {editing && editDraft ? (
                            editDraft.items.map((it, i) => (
                              <tr key={i} className="hover:bg-muted/40">
                                <td className="p-2 text-xs font-mono text-muted-foreground">{i + 1}</td>
                                <td className="p-2"><input value={it.part_number} onChange={e => setItem(i, 'part_number', e.target.value.toUpperCase())} className="w-full min-w-[150px] h-8 px-2 bg-card border border-input rounded-md text-xs font-mono focus:outline-none focus:border-primary" /></td>
                                <td className="p-2">
                                  <select value={it.description || ''} onChange={e => setItem(i, 'description', e.target.value)}
                                    className={`w-full min-w-[220px] max-w-[320px] h-8 px-1 bg-card border border-input rounded-md text-xs ${it.description && !inCatalog('descriptions', it.description) ? '!text-amber-600 dark:!text-amber-400' : ''}`}
                                    title={it.description && !inCatalog('descriptions', it.description) ? t('wms_asn_not_in_catalog') : (it.description || undefined)}>
                                    {catalogOptions('descriptions', it.description).map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                                  </select>
                                </td>
                                <td className="p-2">
                                  <div className="flex gap-1">
                                    <select value={it.gender || ''} onChange={e => setItem(i, 'gender', e.target.value)} className="h-8 px-1 bg-card border border-input rounded-md text-xs" title={t('wms_asn_gender')}>
                                      <option value="">—</option>
                                      {(pnCfg?.genders || []).filter(g => g.code).map(g => <option key={g.code} value={g.code}>{g.code}</option>)}
                                    </select>
                                    <select value={it.garment || ''} onChange={e => setItem(i, 'garment', e.target.value)} className="h-8 px-1 bg-card border border-input rounded-md text-xs min-w-[90px]">
                                      <option value="">—</option>
                                      {(pnCfg?.garments || []).map(g => <option key={g.code} value={g.code}>{g.code} · {g.label}</option>)}
                                    </select>
                                  </div>
                                </td>
                                <td className="p-2">
                                  <select value={it.fabric || ''} onChange={e => setItem(i, 'fabric', e.target.value)}
                                    className={`w-full min-w-[150px] h-8 px-1 bg-card border border-input rounded-md text-xs ${it.fabric && !inCatalog('compositions', it.fabric) ? '!text-amber-600 dark:!text-amber-400' : ''}`}
                                    title={it.fabric && !inCatalog('compositions', it.fabric) ? t('wms_asn_not_in_catalog') : undefined}>
                                    {catalogOptions('compositions', it.fabric).map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                                  </select>
                                </td>
                                <td className="p-2 text-center"><input type="checkbox" checked={!!it.sample} onChange={e => setItem(i, 'sample', e.target.checked)} className="w-4 h-4 accent-primary" /></td>
                                <td className="p-2"><input value={it.country} onChange={e => setItem(i, 'country', e.target.value.toUpperCase())} className="w-20 h-8 px-2 bg-card border border-input rounded-md text-xs font-mono focus:outline-none focus:border-primary" /></td>
                                <td className="p-2"><input value={it.brand} onChange={e => setItem(i, 'brand', e.target.value.toUpperCase())} className="w-24 h-8 px-2 bg-card border border-input rounded-md text-xs focus:outline-none focus:border-primary" /></td>
                                {asnCols.map(c => <td key={c.key} className="p-2"><ExtraCell col={c} line={it} cols={allLineCols} onChange={v => setItemExtra(i, c.key, v)} /></td>)}
                                <td className="p-2"><input type="number" min="0" value={it.qty_expected} onChange={e => setItem(i, 'qty_expected', e.target.value)} className="w-24 h-8 px-2 bg-card border border-input rounded-md text-xs text-right tabular-nums focus:outline-none focus:border-primary" /></td>
                                <td className="p-2 text-xs text-right tabular-nums text-muted-foreground">{(it.qty_received || 0).toLocaleString()}</td>
                                <td className="p-2 text-center">
                                  <button onClick={() => removeItem(i)} className="p-1.5 text-muted-foreground hover:text-destructive hover:bg-destructive/10 rounded" title={t('wms_remove_line')}><Trash2 className="w-3.5 h-3.5" /></button>
                                </td>
                              </tr>
                            ))
                          ) : (
                            (detailData.asn?.items || []).map(it => {
                              const exp = it.qty_expected || 0;
                              const rcv = it.qty_received || 0;
                              const pct = exp > 0 ? Math.min(100, Math.round((rcv / exp) * 100)) : 0;
                              const done = rcv >= exp;
                              return (
                                <tr key={it.line_no} className="hover:bg-muted/40">
                                  <td className="px-3 py-2.5 text-xs font-mono text-muted-foreground">{it.line_no}</td>
                                  <td className="px-3 py-2.5 text-xs font-mono font-medium">{it.part_number}</td>
                                  <td className="px-3 py-2.5 text-xs text-foreground max-w-[260px] truncate" title={it.description}>{it.description}</td>
                                  <td className="px-3 py-2.5 text-xs font-mono">{it.garment ? `${it.gender || ''}${it.garment}` : '—'}</td>
                                  <td className="px-3 py-2.5 text-xs">{it.fabric || '—'}</td>
                                  <td className="px-3 py-2.5 text-xs text-center">{it.sample ? <Check className="w-3.5 h-3.5 inline text-primary" /> : '—'}</td>
                                  <td className="px-3 py-2.5 text-xs font-mono">{it.country || '—'}</td>
                                  <td className="px-3 py-2.5 text-xs">{it.brand || '—'}</td>
                                  {asnCols.map(c => <td key={c.key} className="px-3 py-2.5"><ExtraCell col={c} line={it} cols={allLineCols} readOnly /></td>)}
                                  <td className="px-3 py-2.5 text-xs text-right tabular-nums font-bold">{exp.toLocaleString()}</td>
                                  <td className={`px-3 py-2.5 text-xs text-right tabular-nums font-medium ${done ? 'text-emerald-600 dark:text-emerald-400' : rcv > 0 ? 'text-amber-600 dark:text-amber-400' : 'text-muted-foreground'}`}>{rcv.toLocaleString()}</td>
                                  <td className="px-3 py-2.5 text-xs text-right tabular-nums font-medium">{((detailData.summary?.by_line || []).find(l => l.line_no === it.line_no)?.qty_in_stock ?? 0).toLocaleString()}</td>
                                  <td className="px-3 py-2.5">
                                    <div className="h-1.5 bg-muted rounded-full overflow-hidden">
                                      <div className={`h-full ${done ? 'bg-emerald-500' : rcv > 0 ? 'bg-amber-500' : 'bg-blue-500/40'}`} style={{ width: `${pct}%` }} />
                                    </div>
                                    <div className="text-xs text-muted-foreground mt-0.5">{pct}%</div>
                                  </td>
                                </tr>
                              );
                            })
                          )}
                        </tbody>
                      </table>
                    </div>
                    {editing && <p className="text-xs text-muted-foreground/60 mt-2 italic">{t('wms_asn_received_col_note')}</p>}
                  </div>

                  {/* Received boxes */}
                  <div>
                    <div className="flex items-center justify-between gap-3 mb-2">
                      <h4 className="text-xs font-semibold text-muted-foreground">
                        {t('wms_asn_boxes_received', { n: detailData.boxes?.length || 0 })}
                      </h4>
                      {(detailData.summary?.by_part || []).some(p => p.boxes > 0) && (
                        <select value={partFilter ?? '__all__'} onChange={e => { const v = e.target.value; setPartFilter(v === '__all__' ? null : v); }}
                          data-testid="asn-boxes-part-filter"
                          className="h-8 px-2 bg-card border border-input rounded-md text-xs font-mono focus:outline-none focus:border-primary">
                          <option value="__all__">{t('wms_asn_all_parts')}</option>
                          {detailData.summary.by_part.filter(p => p.boxes > 0).map(p => (
                            <option key={partKey(p)} value={partKey(p)}>{p.unmatched ? t('wms_asn_no_part') : p.part_number} ({p.boxes})</option>
                          ))}
                        </select>
                      )}
                    </div>
                    {(!detailData.boxes || detailData.boxes.length === 0) ? (
                      <div className="text-center py-10 text-sm text-muted-foreground">
                        {t('wms_asn_no_boxes_yet')}
                      </div>
                    ) : (
                      <div className="border border-border rounded-lg overflow-hidden">
                        <table className="w-full text-sm">
                          <thead className="bg-muted/50 border-b border-border">
                            <tr>
                              <th className="px-3 py-2.5 text-left text-xs font-semibold text-muted-foreground">Box ID</th>
                              <th className="px-3 py-2.5 text-left text-xs font-semibold text-muted-foreground">{t('wms_asn_part_number')}</th>
                              <th className="px-3 py-2.5 text-left text-xs font-semibold text-muted-foreground">{t('wms_style_sku')}</th>
                              <th className="px-3 py-2.5 text-left text-xs font-semibold text-muted-foreground">Color / Size</th>
                              <th className="px-3 py-2.5 text-left text-xs font-semibold text-muted-foreground">{t('location')}</th>
                              <th className="px-3 py-2.5 text-right text-xs font-semibold text-muted-foreground">{t('wms_label_units')}</th>
                              <th className="px-3 py-2.5 text-left text-xs font-semibold text-muted-foreground">{t('status')}</th>
                              <th className="px-3 py-2.5 text-left text-xs font-semibold text-muted-foreground">{t('date')}</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-border/60">
                            {visibleBoxes.map(b => (
                              <tr key={b.box_id} className="hover:bg-muted/40">
                                <td className="px-3 py-2.5 text-xs font-mono font-medium">{b.box_id}</td>
                                <td className="px-3 py-2.5 text-xs font-mono whitespace-nowrap">
                                  {b.part_number_resolved || <span className="text-muted-foreground">—</span>}
                                  {b.asn_match === 'best_effort' && <span className="ml-1 text-amber-600 dark:text-amber-400" title={t('wms_asn_best_effort_hint', { n: 1 })}>≈</span>}
                                  {b.asn_line_no_resolved != null && <span className="ml-1 text-muted-foreground">#{b.asn_line_no_resolved}</span>}
                                </td>
                                <td className="px-3 py-2.5 text-xs font-mono">{b.style || b.sku}</td>
                                <td className="px-3 py-2.5 text-xs">{b.color || '—'} / {b.size || '—'}</td>
                                <td className="px-3 py-2.5 text-xs font-mono">{b.location || '—'}</td>
                                <td className="px-3 py-2.5 text-xs text-right tabular-nums font-medium">{(b.units || 0).toLocaleString()}</td>
                                <td className="px-3 py-2.5 text-xs">{b.status || '—'}</td>
                                <td className="px-3 py-2.5 text-xs text-muted-foreground">{b.created_at ? new Date(b.created_at).toLocaleString() : '—'}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </div>
                </div>
              ) : null}
            </div>
          </div>
        </div>
      )}

      {/* SKU → ASN trace modal (Fase 2) */}
      {showTrace && (
        <div className="fixed inset-0 z-[70] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm animate-in fade-in duration-150">
          <div className="bg-card border border-border rounded-lg w-full max-w-3xl max-h-[85vh] flex flex-col shadow-xl animate-in zoom-in-95 duration-150">
            <div className="flex items-center justify-between p-5 border-b border-border/20">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-lg bg-muted flex items-center justify-center">
                  <Search className="w-5 h-5 text-muted-foreground" />
                </div>
                <div>
                  <h3 className="font-semibold text-sm">{t('wms_asn_trace_modal_title')}</h3>
                  <p className="text-xs text-muted-foreground">{t('wms_asn_trace_modal_sub')}</p>
                </div>
              </div>
              <button onClick={() => setShowTrace(false)} className="p-2 hover:bg-secondary rounded-lg transition-all"><X className="w-5 h-5" /></button>
            </div>

            <div className="p-5 border-b border-border/20 flex gap-2">
              <input
                autoFocus
                value={traceQuery}
                onChange={(e) => setTraceQuery(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') runTrace(); }}
                placeholder={t('wms_asn_trace_ph')}
                className="flex-1 h-10 px-3 bg-card border border-input rounded-md text-sm placeholder:text-muted-foreground/60 focus:outline-none focus:ring-2 focus:ring-ring/25 focus:border-ring transition-colors"
              />
              <Btn variant="primary" onClick={runTrace} disabled={traceLoading || !traceQuery.trim()} className="px-6 h-10">
                {traceLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Search className="w-4 h-4" />} {t('search')}
              </Btn>
            </div>

            <div className="flex-1 overflow-auto custom-scrollbar p-5">
              {traceLoading ? (
                <div className="flex items-center justify-center py-16"><Loader2 className="w-7 h-7 animate-spin text-muted-foreground" /></div>
              ) : !traceResults ? (
                <EmptyState art="scan" title={t('wms_asn_trace_empty_title')}
                  hint={t('wms_asn_trace_empty_hint')} />
              ) : traceResults.groups.length === 0 ? (
                <div className="text-center py-16 text-sm text-muted-foreground">{t('wms_asn_trace_no_match', { q: traceResults.query })}</div>
              ) : (
                <div className="space-y-3">
                  <div className="text-xs font-medium text-muted-foreground">{t('wms_asn_trace_found', { boxes: traceResults.total_boxes, groups: traceResults.groups.length })}</div>
                  {traceResults.groups.map(g => (
                    <div key={g.asn_reference} className="border border-border rounded-lg p-4">
                      <div className="flex items-center justify-between gap-3 flex-wrap">
                        <div className="flex items-center gap-2 min-w-0">
                          <span className="font-semibold text-sm">{g.asn_reference}</span>
                          {g.vendor && <span className="text-xs text-muted-foreground truncate">· {g.vendor}</span>}
                          {!g.exists && g.asn_reference !== '(SIN ASN)' && <span className="text-xs px-1.5 py-0.5 rounded-md font-medium bg-amber-50 text-amber-700 border border-amber-200 dark:bg-amber-500/10 dark:text-amber-300 dark:border-amber-500/25">{t('wms_asn_deleted_badge')}</span>}
                        </div>
                        <div className="flex items-center gap-4 text-right">
                          <div>
                            <div className="text-xs font-medium text-muted-foreground">{t('wms_in_inventory')}</div>
                            <div className="text-lg font-semibold tracking-tight tabular-nums">{(g.units_in_stock || 0).toLocaleString()}</div>
                          </div>
                          <div>
                            <div className="text-xs font-medium text-muted-foreground">{t('wms_asn_total_boxes')}</div>
                            <div className="text-lg font-semibold tracking-tight tabular-nums">{g.boxes_in_stock || 0}/{g.boxes || 0}</div>
                          </div>
                        </div>
                      </div>
                      {(g.locations || []).length > 0 && (
                        <div className="mt-2 flex flex-wrap gap-1.5">
                          {g.locations.map(l => (
                            <span key={l} className="px-2 py-0.5 bg-muted border border-border rounded-md text-xs font-mono">{l}</span>
                          ))}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
