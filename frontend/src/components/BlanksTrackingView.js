import { useState, useMemo, useRef, useEffect, useCallback } from "react";
import { Settings2, X, Check, ChevronDown, Search } from "lucide-react";
import { toast } from "sonner";
import { STATUS_COLORS } from "../lib/constants";

const API = `${process.env.REACT_APP_BACKEND_URL}/api`;

const ALL_COLUMNS = [
  { key: 'order_number', label: 'PO', width: 100, fixed: true },
  { key: 'client', label: 'Cliente', width: 170, optionKey: 'clients' },
  { key: 'quantity', label: 'QTY', width: 90, type: 'number' },
  { key: 'blank_status', label: 'Blank Status', width: 180, optionKey: 'blank_statuses' },
  { key: 'screens', label: 'Screens', width: 160, optionKey: 'screens' },
  { key: 'production_status', label: 'Production Status', width: 200, optionKey: 'production_statuses' },
  { key: 'trim_status', label: 'Trim Status', width: 170, optionKey: 'trim_statuses' },
  { key: 'artwork_status', label: 'Artwork Status', width: 180, optionKey: 'artwork_statuses' },
  { key: 'cancel_date', label: 'Cancel Date', width: 130, type: 'date' },
  { key: 'priority', label: 'Priority', width: 150, optionKey: 'priorities' },
  { key: 'branding', label: 'Branding', width: 160, optionKey: 'brandings' },
  { key: 'sample', label: 'Sample', width: 170, optionKey: 'samples' },
  { key: 'trim_box', label: 'Trim Box', width: 140, optionKey: 'trim_boxes' },
  { key: 'blank_source', label: 'Blank Source', width: 160, optionKey: 'blank_sources' },
  { key: 'shipping', label: 'Shipping', width: 200, optionKey: 'shippings' },
  { key: 'notes', label: 'Notas', width: 250, type: 'text' },
  { key: 'due_date', label: 'Entrega', width: 130, type: 'date' },
  { key: 'customer_po', label: 'Customer PO', width: 150, type: 'text' },
  { key: 'store_po', label: 'Store PO', width: 150, type: 'text' },
];

const DEFAULT_COLS = ['order_number', 'client', 'quantity', 'blank_status', 'screens', 'production_status', 'trim_status', 'artwork_status', 'cancel_date'];

// Status cell with color badge
const StatusCell = ({ value, options, orderId, field, onUpdate }) => {
  const [editing, setEditing] = useState(false);
  const [search, setSearch] = useState('');
  const ref = useRef(null);

  useEffect(() => {
    if (!editing) return;
    const h = (e) => { if (ref.current && !ref.current.contains(e.target)) setEditing(false); };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, [editing]);

  const color = STATUS_COLORS[value];
  const filtered = options ? options.filter(o => o.toLowerCase().includes(search.toLowerCase())) : [];

  if (!options) {
    return <span className="text-xs">{value || '—'}</span>;
  }

  return (
    <div className="relative" ref={ref}>
      <button onClick={() => setEditing(!editing)}
        className="flex items-center gap-1 px-2 py-1 rounded text-[11px] font-bold transition-colors hover:opacity-80 w-full justify-between"
        style={color ? { backgroundColor: color.bg, color: color.text } : {}}
        data-testid={`blanks-cell-${field}-${orderId}`}>
        <span className="truncate">{value || '—'}</span>
        <ChevronDown className="w-3 h-3 flex-shrink-0 opacity-60" />
      </button>
      {editing && (
        <div className="absolute top-full left-0 mt-1 w-52 bg-popover border border-border rounded-lg shadow-xl z-50 overflow-hidden" data-testid={`blanks-dropdown-${field}`}>
          <div className="p-1.5 border-b border-border">
            <div className="flex items-center gap-1 bg-secondary rounded px-2">
              <Search className="w-3 h-3 text-muted-foreground" />
              <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Buscar..." className="bg-transparent text-xs py-1.5 w-full outline-none" autoFocus />
            </div>
          </div>
          <div className="max-h-48 overflow-y-auto">
            <button onClick={() => { onUpdate(orderId, field, null); setEditing(false); setSearch(''); }}
              className="w-full text-left px-3 py-1.5 text-xs text-muted-foreground hover:bg-secondary/50 italic">Limpiar</button>
            {filtered.map(opt => {
              const oc = STATUS_COLORS[opt];
              return (
                <button key={opt} onClick={() => { onUpdate(orderId, field, opt); setEditing(false); setSearch(''); }}
                  className="w-full text-left px-3 py-1.5 text-xs hover:bg-secondary/50 flex items-center gap-2 font-medium">
                  {oc && <span className="w-3 h-3 rounded-sm flex-shrink-0" style={{ backgroundColor: oc.bg }} />}
                  {opt}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
};

// Column config
const ColumnConfig = ({ visible, setVisible, onClose }) => {
  const ref = useRef(null);
  useEffect(() => {
    const h = (e) => { if (ref.current && !ref.current.contains(e.target)) onClose(); };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, [onClose]);

  const toggle = (key) => {
    if (key === 'order_number') return; // PO always visible
    setVisible(prev => {
      const next = prev.includes(key) ? prev.filter(k => k !== key) : [...prev, key];
      localStorage.setItem('blanks_tracking_cols', JSON.stringify(next));
      return next;
    });
  };

  return (
    <div ref={ref} className="absolute right-0 top-10 w-56 bg-popover border border-border rounded-lg shadow-xl z-50" data-testid="blanks-column-config">
      <div className="px-3 py-2 border-b border-border flex items-center justify-between">
        <span className="text-xs font-bold uppercase tracking-wider">Columnas</span>
        <button onClick={onClose} className="p-0.5 hover:bg-secondary rounded"><X className="w-3.5 h-3.5" /></button>
      </div>
      <div className="max-h-64 overflow-y-auto py-1">
        {ALL_COLUMNS.map(c => (
          <button key={c.key} onClick={() => toggle(c.key)}
            className={`w-full flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-secondary/50 ${c.fixed ? 'opacity-50 cursor-not-allowed' : ''}`}
            data-testid={`blanks-col-toggle-${c.key}`} disabled={c.fixed}>
            <div className={`w-4 h-4 rounded border flex items-center justify-center flex-shrink-0 ${visible.includes(c.key) ? 'bg-primary border-primary' : 'border-border'}`}>
              {visible.includes(c.key) && <Check className="w-3 h-3 text-primary-foreground" />}
            </div>
            <span className={visible.includes(c.key) ? 'text-foreground font-medium' : 'text-muted-foreground'}>{c.label}</span>
          </button>
        ))}
      </div>
      <div className="px-3 py-2 border-t border-border">
        <button onClick={() => { setVisible(DEFAULT_COLS); localStorage.setItem('blanks_tracking_cols', JSON.stringify(DEFAULT_COLS)); }}
          className="text-[10px] text-primary hover:underline" data-testid="blanks-reset-cols">Restaurar predeterminados</button>
      </div>
    </div>
  );
};

const BlanksTrackingView = ({ orders, isDark, fetchOrders, options, readOnly }) => {
  const [visibleCols, setVisibleCols] = useState(() => {
    try { const s = localStorage.getItem('blanks_tracking_cols'); return s ? JSON.parse(s) : DEFAULT_COLS; } catch { return DEFAULT_COLS; }
  });
  const [showConfig, setShowConfig] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const [sortKey, setSortKey] = useState(null);
  const [sortDir, setSortDir] = useState('asc');

  const handleSort = (key) => {
    if (sortKey === key) setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    else { setSortKey(key); setSortDir('asc'); }
  };

  const handleUpdate = useCallback(async (orderId, field, value) => {
    try {
      await fetch(`${API}/orders/${orderId}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        credentials: 'include', body: JSON.stringify({ [field]: value })
      });
      toast.success(`${field.replace('_', ' ')} actualizado`);
      fetchOrders();
    } catch { toast.error('Error al actualizar'); }
  }, [fetchOrders]);

  const columns = useMemo(() => {
    return visibleCols.map(k => ALL_COLUMNS.find(c => c.key === k)).filter(Boolean);
  }, [visibleCols]);

  const filteredOrders = useMemo(() => {
    let result = [...orders];
    if (searchTerm) {
      const q = searchTerm.toLowerCase();
      result = result.filter(o =>
        String(o.order_number || '').toLowerCase().includes(q) ||
        String(o.client || '').toLowerCase().includes(q)
      );
    }
    if (sortKey) {
      result.sort((a, b) => {
        const av = a[sortKey] ?? '', bv = b[sortKey] ?? '';
        const cmp = String(av).localeCompare(String(bv), undefined, { numeric: true });
        return sortDir === 'asc' ? cmp : -cmp;
      });
    }
    return result;
  }, [orders, searchTerm, sortKey, sortDir]);

  const renderCell = (order, col) => {
    if (col.key === 'order_number') {
      const color = STATUS_COLORS[order.priority] || STATUS_COLORS[order.client];
      return (
        <span className="font-mono font-black text-primary text-sm" data-testid={`blanks-po-${order.order_id}`}
          style={color ? { borderLeft: `3px solid ${color.bg}`, paddingLeft: 6 } : {}}>
          {order.order_number}
        </span>
      );
    }
    if (col.key === 'quantity') return <span className="font-mono text-sm font-bold">{order.quantity || 0}</span>;
    if (col.type === 'date') return <span className="font-mono text-xs text-muted-foreground">{order[col.key] || '—'}</span>;
    if (col.type === 'text') return <span className="text-xs truncate max-w-[200px] inline-block">{order[col.key] || '—'}</span>;
    if (col.type === 'number') return <span className="font-mono text-sm">{order[col.key] || '—'}</span>;
    // Status fields
    if (col.optionKey) {
      const value = order[col.key];
      const color = STATUS_COLORS[value];
      if (readOnly || !options?.[col.optionKey]?.length) {
        return (
          <span className="px-2 py-1 rounded text-[11px] font-bold inline-block"
            style={color ? { backgroundColor: color.bg, color: color.text } : {}}
            data-testid={`blanks-cell-${col.key}-${order.order_id}`}>
            {value || '—'}
          </span>
        );
      }
      return <StatusCell value={value} options={options[col.optionKey]} orderId={order.order_id} field={col.key} onUpdate={handleUpdate} />;
    }
    return <span className="text-xs">{order[col.key] || '—'}</span>;
  };

  return (
    <div className="flex-1 flex flex-col overflow-hidden" data-testid="blanks-tracking-view">
      {/* Toolbar */}
      <div className={`flex items-center justify-between px-4 py-2.5 border-b ${isDark ? 'border-border' : 'border-gray-200'}`}>
        <div className="flex items-center gap-3">
          <h2 className="font-barlow font-bold text-sm uppercase tracking-wider text-muted-foreground" data-testid="blanks-tracking-title">
            Seguimiento de Blanks
          </h2>
          <span className="text-[11px] bg-primary/15 text-primary px-2.5 py-0.5 rounded-full font-bold" data-testid="blanks-count">
            {filteredOrders.length} ordenes
          </span>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-1 bg-secondary rounded px-2">
            <Search className="w-3.5 h-3.5 text-muted-foreground" />
            <input value={searchTerm} onChange={e => setSearchTerm(e.target.value)}
              placeholder="Buscar PO o cliente..." className="bg-transparent text-xs py-1.5 w-40 outline-none" data-testid="blanks-search" />
          </div>
          <div className="relative">
            <button onClick={() => setShowConfig(!showConfig)}
              className={`p-1.5 rounded hover:bg-secondary ${showConfig ? 'bg-secondary' : ''}`} title="Configurar columnas"
              data-testid="blanks-config-btn">
              <Settings2 className="w-4 h-4" />
            </button>
            {showConfig && <ColumnConfig visible={visibleCols} setVisible={setVisibleCols} onClose={() => setShowConfig(false)} />}
          </div>
        </div>
      </div>

      {/* Table */}
      <div className="flex-1 overflow-auto">
        <table className="w-full text-sm border-collapse" data-testid="blanks-table">
          <thead className="sticky top-0 z-10">
            <tr className={isDark ? 'bg-card border-b border-border' : 'bg-gray-100 border-b border-gray-200'}>
              {columns.map(col => (
                <th key={col.key} onClick={() => handleSort(col.key)}
                  className={`py-2.5 px-3 text-left text-[10px] font-bold uppercase tracking-wider cursor-pointer select-none hover:text-primary transition-colors ${sortKey === col.key ? 'text-primary' : 'text-muted-foreground'} ${col.fixed ? `sticky left-0 z-20 ${isDark ? 'bg-card' : 'bg-gray-100'}` : ''}`}
                  style={{ minWidth: col.width }}
                  data-testid={`blanks-th-${col.key}`}>
                  <div className="flex items-center gap-1">
                    {col.label}
                    {sortKey === col.key && <span className="text-primary">{sortDir === 'asc' ? '↑' : '↓'}</span>}
                  </div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {filteredOrders.length === 0 ? (
              <tr><td colSpan={columns.length} className="py-16 text-center text-muted-foreground text-sm">No hay ordenes en Blanks</td></tr>
            ) : (
              filteredOrders.map((order, idx) => (
                <tr key={order.order_id}
                  className={`border-b transition-colors ${isDark ? 'border-border/50 hover:bg-secondary/30' : 'border-gray-100 hover:bg-blue-50/30'} ${idx % 2 === 0 ? '' : (isDark ? 'bg-secondary/10' : 'bg-gray-50/50')}`}
                  data-testid={`blanks-row-${order.order_id}`}>
                  {columns.map(col => (
                    <td key={col.key} className={`py-2 px-3 ${col.fixed ? `sticky left-0 z-10 ${isDark ? (idx % 2 === 0 ? 'bg-card' : 'bg-card') : (idx % 2 === 0 ? 'bg-white' : 'bg-gray-50')}` : ''}`}>
                      {renderCell(order, col)}
                    </td>
                  ))}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
};

export default BlanksTrackingView;
