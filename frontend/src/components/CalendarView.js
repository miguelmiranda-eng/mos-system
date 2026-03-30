import { useState, useMemo, useCallback, useRef, useEffect } from "react";
import { format, startOfWeek, addDays, subDays, startOfMonth, endOfMonth, eachDayOfInterval, isSameMonth, isSameDay, addMonths, subMonths, parseISO, isAfter } from "date-fns";
import { es, enUS } from "date-fns/locale";
import { ChevronLeft, ChevronRight, MoveRight, Settings2, X, Check, AlertTriangle, CalendarClock, ChevronDown } from "lucide-react";
import { useLang } from "../contexts/LanguageContext";
import { toast } from "sonner";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "./ui/dropdown-menu";
import { BOARDS, STATUS_COLORS } from "../lib/constants";

const API = `${process.env.REACT_APP_BACKEND_URL}/api`;

const PRIORITY_COLORS = {
  'RUSH': '#990000', 'OVERSOLD': '#e69138', 'PRIORITY 1': '#cf0000',
  'PRIORITY 2': '#ff0000', 'EVENT': '#20124d', 'SPECIAL RUSH': '#674ea7'
};

const ALL_FIELDS = [
  { key: 'client', label: 'Cliente' },
  { key: 'quantity', label: 'QTY' },
  { key: 'blank_status', label: 'Blank Status' },
  { key: 'screens', label: 'Screens' },
  { key: 'production_status', label: 'Production Status' },
  { key: 'trim_status', label: 'Trim Status' },
  { key: 'artwork_status', label: 'Artwork Status' },
  { key: 'cancel_date', label: 'Cancel Date' },
  { key: 'priority', label: 'Priority' },
  { key: 'branding', label: 'Branding' },
  { key: 'sample', label: 'Sample' },
  { key: 'trim_box', label: 'Trim Box' },
  { key: 'due_date', label: 'Entrega' },
  { key: 'notes', label: 'Notas' },
  { key: 'blank_source', label: 'Blank Source' },
  { key: 'shipping', label: 'Shipping' },
];

const DEFAULT_VISIBLE = ['client', 'quantity', 'blank_status', 'screens', 'production_status', 'trim_status', 'artwork_status', 'cancel_date'];
const MOVE_BOARDS = BOARDS.filter(b => b !== 'MASTER');

const safeParseDate = (d) => { if (!d) return null; try { return d.length === 10 ? parseISO(d + 'T12:00:00') : parseISO(d); } catch { return null; } };

// Badge for status values
const Badge = ({ value, field }) => {
  if (!value) return <span className="text-muted-foreground/40">—</span>;
  const c = STATUS_COLORS[value];
  if (c) return <span className="px-2 py-0.5 rounded text-[10px] font-bold" style={{ backgroundColor: c.bg, color: c.text }}>{value}</span>;
  if (field === 'cancel_date') return <span className="text-xs font-mono text-yellow-500">{value}</span>;
  return <span className="text-xs">{String(value)}</span>;
};

// ─── Detail Modal ───
const OrderDetailModal = ({ order, visibleFields, isDark, onClose, onMoveBoard, boards }) => {
  const [showBoards, setShowBoards] = useState(false);
  const ref = useRef(null);
  const boardRef = useRef(null);
  const pastCancel = order.scheduled_date && order.cancel_date && isAfter(safeParseDate(order.scheduled_date), safeParseDate(order.cancel_date));

  useEffect(() => {
    const h = (e) => { if (ref.current && !ref.current.contains(e.target)) onClose(); };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, [onClose]);

  useEffect(() => {
    if (!showBoards) return;
    const h = (e) => { if (boardRef.current && !boardRef.current.contains(e.target)) setShowBoards(false); };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, [showBoards]);

  const priColor = PRIORITY_COLORS[order.priority];
  const clientColor = STATUS_COLORS[order.client];
  const accent = priColor || (clientColor ? clientColor.bg : 'hsl(217 91% 60%)');

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/40 backdrop-blur-sm" data-testid="order-detail-overlay">
      <div ref={ref} className={`w-full max-w-md rounded-xl shadow-2xl border overflow-hidden ${isDark ? 'bg-card border-border' : 'bg-white border-gray-200'}`} data-testid="order-detail-modal">
        {/* Header */}
        <div className="px-5 py-3 flex items-center justify-between" style={{ borderBottom: `3px solid ${accent}` }}>
          <div className="flex items-center gap-3">
            <span className="font-mono font-black text-xl text-primary" data-testid="modal-po">{order.order_number}</span>
            {pastCancel && (
              <span className="flex items-center gap-1 text-[10px] text-red-400 bg-red-500/10 px-2 py-0.5 rounded-full font-bold">
                <AlertTriangle className="w-3 h-3" /> Despues de Cancel
              </span>
            )}
          </div>
          <button onClick={onClose} className="p-1 hover:bg-secondary rounded" data-testid="modal-close"><X className="w-5 h-5" /></button>
        </div>

        {/* Scheduled info */}
        <div className={`px-5 py-2 text-[11px] flex items-center gap-4 ${isDark ? 'bg-secondary/30' : 'bg-gray-50'}`}>
          <span className="text-muted-foreground">Planificada: <strong className="text-foreground">{order.scheduled_date || 'Sin asignar'}</strong></span>
          <span className="text-muted-foreground">Cancel: <strong className="text-yellow-500">{order.cancel_date || '—'}</strong></span>
          <span className="text-muted-foreground">Tablero: <strong className="text-foreground">{order.board}</strong></span>
        </div>

        {/* Fields */}
        <div className="px-5 py-3 space-y-2 max-h-72 overflow-y-auto">
          {visibleFields.map(key => {
            const f = ALL_FIELDS.find(x => x.key === key);
            if (!f) return null;
            return (
              <div key={key} className="flex items-center justify-between py-1 border-b border-border/30" data-testid={`modal-field-${key}`}>
                <span className="text-xs text-muted-foreground font-medium">{f.label}</span>
                <Badge value={order[key]} field={key} />
              </div>
            );
          })}
        </div>

        {/* Actions */}
        <div className="px-5 py-3 border-t border-border flex items-center justify-between">
          <div className="relative">
            <button onClick={() => setShowBoards(!showBoards)}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-bold bg-secondary hover:bg-secondary/80 rounded transition-colors"
              data-testid="modal-move-btn">
              <MoveRight className="w-3.5 h-3.5" /> Mover a tablero
            </button>
            {showBoards && (
              <div ref={boardRef} className="absolute bottom-full mb-1 left-0 w-44 bg-popover border border-border rounded-lg shadow-xl max-h-52 overflow-y-auto z-50" data-testid="modal-board-menu">
                {boards.filter(b => b !== order.board).map(b => (
                  <button key={b} onClick={() => { onMoveBoard(order.order_id, b); setShowBoards(false); onClose(); }}
                    className="w-full text-left px-3 py-1.5 text-xs hover:bg-secondary/50 font-medium">{b}</button>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

// ─── Column Config ───
const ColumnConfig = ({ visibleFields, setVisibleFields, onClose }) => {
  const ref = useRef(null);
  useEffect(() => {
    const h = (e) => { if (ref.current && !ref.current.contains(e.target)) onClose(); };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, [onClose]);

  const toggle = (key) => {
    setVisibleFields(prev => {
      const next = prev.includes(key) ? prev.filter(k => k !== key) : [...prev, key];
      localStorage.setItem('cal_visible_fields', JSON.stringify(next));
      return next;
    });
  };

  return (
    <div ref={ref} className="absolute right-0 top-10 w-56 bg-popover border border-border rounded-lg shadow-xl z-50" data-testid="cal-column-config">
      <div className="px-3 py-2 border-b border-border flex items-center justify-between">
        <span className="text-xs font-bold uppercase tracking-wider">Campos del Modal</span>
        <button onClick={onClose} className="p-0.5 hover:bg-secondary rounded"><X className="w-3.5 h-3.5" /></button>
      </div>
      <div className="max-h-64 overflow-y-auto py-1">
        {ALL_FIELDS.map(f => (
          <button key={f.key} onClick={() => toggle(f.key)}
            className="w-full flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-secondary/50" data-testid={`cal-toggle-${f.key}`}>
            <div className={`w-4 h-4 rounded border flex items-center justify-center flex-shrink-0 ${visibleFields.includes(f.key) ? 'bg-primary border-primary' : 'border-border'}`}>
              {visibleFields.includes(f.key) && <Check className="w-3 h-3 text-primary-foreground" />}
            </div>
            <span className={visibleFields.includes(f.key) ? 'text-foreground font-medium' : 'text-muted-foreground'}>{f.label}</span>
          </button>
        ))}
      </div>
      <div className="px-3 py-2 border-t border-border">
        <button onClick={() => { setVisibleFields(DEFAULT_VISIBLE); localStorage.setItem('cal_visible_fields', JSON.stringify(DEFAULT_VISIBLE)); }}
          className="text-[10px] text-primary hover:underline" data-testid="cal-reset-fields">Restaurar predeterminados</button>
      </div>
    </div>
  );
};

// ─── Compact Order Block (single line) ───
const OrderBlock = ({ order, isDark, onDragStart, onClick }) => {
  const priColor = PRIORITY_COLORS[order.priority];
  const clientColor = STATUS_COLORS[order.client];
  const borderColor = priColor || (clientColor ? clientColor.bg : null);
  const hasNoScheduledDate = !order.scheduled_date;
  const pastCancel = order.scheduled_date && order.cancel_date && isAfter(safeParseDate(order.scheduled_date), safeParseDate(order.cancel_date));

  return (
    <div
      draggable
      onDragStart={(e) => onDragStart(order, e)}
      onClick={(e) => { e.stopPropagation(); onClick(order); }}
      className={`flex items-center gap-1 px-2 py-1 rounded cursor-grab active:cursor-grabbing transition-all text-[11px] font-mono font-bold truncate hover:shadow-md ${hasNoScheduledDate ? (isDark ? 'bg-yellow-500/10 border border-yellow-500/30 text-yellow-400' : 'bg-yellow-50 border border-yellow-300 text-yellow-700') : (isDark ? 'bg-secondary/60 border border-border hover:bg-secondary hover:border-primary/40' : 'bg-white border border-gray-200 hover:border-blue-300')} ${pastCancel ? 'ring-1 ring-red-500/40' : ''}`}
      style={borderColor ? { borderLeftWidth: 3, borderLeftColor: borderColor } : {}}
      data-testid={`cal-order-${order.order_id}`}
    >
      {pastCancel && <AlertTriangle className="w-3 h-3 text-red-400 flex-shrink-0" />}
      <span className="truncate">{order.order_number}</span>
      {order.client && <span className="text-[9px] text-muted-foreground font-normal truncate ml-auto pl-1">{order.client}</span>}
    </div>
  );
};

// ─── Main Calendar ───
const CalendarView = ({ orders, isDark, fetchOrders, label }) => {
  const { lang } = useLang();
  const [currentDate, setCurrentDate] = useState(new Date());
  const [viewMode, setViewMode] = useState('month');
  const [draggedOrder, setDraggedOrder] = useState(null);
  const [selectedOrder, setSelectedOrder] = useState(null);
  const [showConfig, setShowConfig] = useState(false);
  const [dateField, setDateField] = useState(() => localStorage.getItem('cal_date_field') || 'scheduled_date');
  const [visibleFields, setVisibleFields] = useState(() => {
    try { const s = localStorage.getItem('cal_visible_fields'); return s ? JSON.parse(s) : DEFAULT_VISIBLE; } catch { return DEFAULT_VISIBLE; }
  });
  const [dropTarget, setDropTarget] = useState(null);
  const locale = lang === 'es' ? es : enUS;
  const today = useMemo(() => new Date(), []);

  // Position by selected dateField. No date → today.
  const getOrderDay = useCallback((order) => {
    const val = order[dateField];
    if (val) return safeParseDate(val);
    return today; // unscheduled orders appear on today
  }, [today, dateField]);

  const calendarDays = useMemo(() => {
    if (viewMode === 'week') {
      const start = startOfWeek(currentDate, { weekStartsOn: 1 });
      return Array.from({ length: 7 }, (_, i) => addDays(start, i));
    }
    const ms = startOfMonth(currentDate);
    const me = endOfMonth(currentDate);
    const start = startOfWeek(ms, { weekStartsOn: 1 });
    const days = eachDayOfInterval({ start, end: addDays(startOfWeek(addDays(me, 6), { weekStartsOn: 1 }), -1) });
    return days.slice(0, 42);
  }, [currentDate, viewMode]);

  const getOrdersForDay = useCallback((day) => {
    return orders.filter(o => {
      const d = getOrderDay(o);
      return d && isSameDay(d, day);
    });
  }, [orders, getOrderDay]);

  const handleDragStart = (order, e) => {
    setDraggedOrder(order);
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', order.order_id);
  };

  const handleDrop = async (day, e) => {
    e.preventDefault();
    setDropTarget(null);
    if (!draggedOrder) return;
    const newDate = format(day, 'yyyy-MM-dd');
    const currentDay = getOrderDay(draggedOrder);
    if (currentDay && isSameDay(currentDay, day) && draggedOrder.scheduled_date) { setDraggedOrder(null); return; }
    try {
      await fetch(`${API}/orders/${draggedOrder.order_id}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        credentials: 'include', body: JSON.stringify({ scheduled_date: newDate })
      });
      const cancel = draggedOrder.cancel_date ? safeParseDate(draggedOrder.cancel_date) : null;
      const sched = safeParseDate(newDate);
      if (cancel && sched && isAfter(sched, cancel)) {
        toast.warning(`${draggedOrder.order_number} programada despues de Cancel Date (${draggedOrder.cancel_date})`);
      } else {
        toast.success(`${draggedOrder.order_number} → ${format(day, 'dd MMM', { locale })}`);
      }
      fetchOrders();
    } catch { toast.error('Error al programar'); }
    setDraggedOrder(null);
  };

  const handleMoveToBoard = async (orderId, board) => {
    try {
      await fetch(`${API}/orders/bulk-move`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        credentials: 'include', body: JSON.stringify({ order_ids: [orderId], board })
      });
      toast.success(`Orden movida a ${board}`);
      fetchOrders();
    } catch { toast.error('Error al mover'); }
  };

  const nav = (dir) => {
    if (viewMode === 'month') setCurrentDate(dir === 1 ? addMonths(currentDate, 1) : subMonths(currentDate, 1));
    else setCurrentDate(dir === 1 ? addDays(currentDate, 7) : subDays(currentDate, 7));
  };

  const dayNames = ['Lun', 'Mar', 'Mie', 'Jue', 'Vie', 'Sab', 'Dom'];
  const isWeek = viewMode === 'week';
  const unschedCount = orders.filter(o => !o.scheduled_date).length;

  return (
    <div className="flex-1 flex flex-col overflow-hidden" data-testid="calendar-view">
      {/* Toolbar */}
      <div className={`flex items-center justify-between px-4 py-2 border-b ${isDark ? 'border-border' : 'border-gray-200'}`}>
        <div className="flex items-center gap-2">
          {label && <span className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground border-r border-border pr-2 mr-1">{label}</span>}
          <button onClick={() => nav(-1)} className="p-1.5 rounded hover:bg-secondary" data-testid="cal-prev"><ChevronLeft className="w-5 h-5" /></button>
          <h2 className="font-barlow font-bold text-lg uppercase tracking-wide min-w-[220px] text-center" data-testid="cal-title">
            {viewMode === 'month'
              ? format(currentDate, 'MMMM yyyy', { locale })
              : `${format(startOfWeek(currentDate, { weekStartsOn: 1 }), 'dd MMM', { locale })} – ${format(addDays(startOfWeek(currentDate, { weekStartsOn: 1 }), 6), 'dd MMM yyyy', { locale })}`}
          </h2>
          <button onClick={() => nav(1)} className="p-1.5 rounded hover:bg-secondary" data-testid="cal-next"><ChevronRight className="w-5 h-5" /></button>
          <button onClick={() => setCurrentDate(new Date())} className="ml-2 px-3 py-1 text-xs bg-primary/20 text-primary rounded hover:bg-primary/30 font-bold" data-testid="cal-today">Hoy</button>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-2">
            <DropdownMenu>
              <DropdownMenuTrigger className="flex items-center gap-1.5 text-[10px] text-muted-foreground border border-border rounded px-2 py-1 font-bold bg-secondary/50 hover:bg-secondary">
                <CalendarClock className="w-3.5 h-3.5 text-primary" />
                <span>Fecha: <strong className="text-foreground">{dateField === 'scheduled_date' ? 'Planificacion' : 'Cancel Date'}</strong></span>
                <ChevronDown className="w-3 h-3 opacity-50" />
              </DropdownMenuTrigger>
              <DropdownMenuContent className="z-[300] bg-popover border-border min-w-[180px]">
                <DropdownMenuItem onClick={() => { setDateField('scheduled_date'); localStorage.setItem('cal_date_field', 'scheduled_date'); }} className="text-xs font-bold py-2">
                  Planificacion
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => { setDateField('cancel_date'); localStorage.setItem('cal_date_field', 'cancel_date'); }} className="text-xs font-bold py-2">
                  Cancel Date
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
          {unschedCount > 0 && (
            <span className="text-[10px] bg-yellow-500/15 text-yellow-500 px-2 py-1 rounded-full font-bold" data-testid="cal-unscheduled-count" title="Aparecen en el dia de hoy">
              {unschedCount} en Hoy
            </span>
          )}
          <div className="flex items-center gap-1 bg-secondary rounded-md p-0.5">
            <button onClick={() => setViewMode('week')} className={`px-3 py-1 text-xs rounded ${viewMode === 'week' ? 'bg-primary text-primary-foreground font-bold' : 'text-muted-foreground hover:text-foreground'}`} data-testid="view-week-btn">Semana</button>
            <button onClick={() => setViewMode('month')} className={`px-3 py-1 text-xs rounded ${viewMode === 'month' ? 'bg-primary text-primary-foreground font-bold' : 'text-muted-foreground hover:text-foreground'}`} data-testid="view-month-btn">Mes</button>
          </div>
          <div className="relative">
            <button onClick={() => setShowConfig(!showConfig)} className={`p-1.5 rounded hover:bg-secondary ${showConfig ? 'bg-secondary' : ''}`} title="Configurar campos del modal" data-testid="cal-config-btn">
              <Settings2 className="w-4 h-4" />
            </button>
            {showConfig && <ColumnConfig visibleFields={visibleFields} setVisibleFields={setVisibleFields} onClose={() => setShowConfig(false)} />}
          </div>
        </div>
      </div>

      {/* Grid */}
      <div className="flex-1 overflow-y-auto">
        <div className="grid grid-cols-7 border-b border-border sticky top-0 z-10">
          {dayNames.map(d => (
            <div key={d} className={`py-2 text-center text-xs font-bold uppercase tracking-wider ${isDark ? 'text-muted-foreground bg-card' : 'text-gray-500 bg-gray-50'}`}>{d}</div>
          ))}
        </div>
        <div className="grid grid-cols-7">
          {calendarDays.map((day, idx) => {
            const dayOrders = getOrdersForDay(day);
            const isToday = isSameDay(day, today);
            const isCurMonth = isSameMonth(day, currentDate);
            const dayKey = format(day, 'yyyy-MM-dd');
            const isDrop = dropTarget === dayKey && draggedOrder;

            return (
              <div key={idx}
                className={`border-r border-b transition-colors ${isWeek ? 'min-h-[calc(100vh-160px)]' : 'min-h-[110px]'} ${isDark ? 'border-border' : 'border-gray-200'} ${!isCurMonth && viewMode === 'month' ? 'opacity-25' : ''} ${isToday ? (isDark ? 'bg-primary/5' : 'bg-blue-50/60') : ''} ${isDrop ? (isDark ? 'bg-primary/10 ring-1 ring-inset ring-primary/30' : 'bg-blue-100/50 ring-1 ring-inset ring-blue-300') : ''}`}
                onDragOver={(e) => { e.preventDefault(); setDropTarget(dayKey); }}
                onDragLeave={() => setDropTarget(null)}
                onDrop={(e) => handleDrop(day, e)}
                data-testid={`calendar-day-${dayKey}`}>
                {/* Day number */}
                <div className="flex items-center justify-between px-1.5 py-1">
                  <span className={`text-xs font-bold ${isToday ? 'bg-primary text-primary-foreground w-6 h-6 rounded-full flex items-center justify-center' : 'text-muted-foreground'}`}>
                    {format(day, 'd')}
                  </span>
                  {dayOrders.length > 0 && <span className="text-[9px] text-muted-foreground font-mono">{dayOrders.length}</span>}
                </div>
                {/* Compact order blocks */}
                <div className="px-1 pb-1 space-y-0.5 overflow-y-auto" style={{ maxHeight: isWeek ? 'calc(100vh - 200px)' : '82px' }}>
                  {dayOrders.map(o => (
                    <OrderBlock key={o.order_id} order={o} isDark={isDark} onDragStart={handleDragStart} onClick={setSelectedOrder} />
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Detail modal */}
      {selectedOrder && (
        <OrderDetailModal
          order={selectedOrder}
          visibleFields={visibleFields}
          isDark={isDark}
          onClose={() => setSelectedOrder(null)}
          onMoveBoard={handleMoveToBoard}
          boards={MOVE_BOARDS}
        />
      )}
    </div>
  );
};

export default CalendarView;
