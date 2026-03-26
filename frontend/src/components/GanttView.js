import { useState, useEffect, useMemo, useCallback } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "./ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";
import { Loader2, ChevronLeft, ChevronRight, Calendar, Clock, Package } from "lucide-react";
import { useLang } from "../contexts/LanguageContext";
import { toast } from "sonner";

const BACKEND_URL = process.env.REACT_APP_BACKEND_URL;
const API = `${BACKEND_URL}/api`;

const MACHINES = Array.from({ length: 14 }, (_, i) => `MAQUINA${i + 1}`);

const ORDER_COLORS = [
  '#3b82f6', '#ef4444', '#22c55e', '#f59e0b', '#8b5cf6',
  '#ec4899', '#06b6d4', '#f97316', '#14b8a6', '#6366f1',
  '#84cc16', '#e11d48', '#0ea5e9', '#a855f7', '#10b981',
];

const getDateRange = (range) => {
  const now = new Date();
  const start = new Date(now);
  const end = new Date(now);

  switch (range) {
    case 'week':
      start.setDate(now.getDate() - now.getDay());
      end.setDate(start.getDate() + 6);
      break;
    case 'month':
      start.setDate(1);
      end.setMonth(end.getMonth() + 1, 0);
      break;
    case '2weeks':
      start.setDate(now.getDate() - 7);
      end.setDate(now.getDate() + 7);
      break;
    default:
      start.setDate(now.getDate() - 15);
      end.setDate(now.getDate() + 15);
      break;
  }
  return { start, end };
};

const formatDate = (d) => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;

const getDaysBetween = (start, end) => {
  const days = [];
  const d = new Date(start);
  while (d <= end) {
    days.push(new Date(d));
    d.setDate(d.getDate() + 1);
  }
  return days;
};

const GanttView = ({ isOpen, onClose, isDark }) => {
  const { t } = useLang();
  const [loading, setLoading] = useState(false);
  const [bars, setBars] = useState([]);
  const [pending, setPending] = useState([]);
  const [totalPiecesSystem, setTotalPiecesSystem] = useState(0);
  const [rangeType, setRangeType] = useState('month');
  const [customStart, setCustomStart] = useState('');
  const [customEnd, setCustomEnd] = useState('');

  const dateRange = useMemo(() => {
    if (rangeType === 'custom' && customStart && customEnd) {
      return { start: new Date(customStart), end: new Date(customEnd) };
    }
    return getDateRange(rangeType);
  }, [rangeType, customStart, customEnd]);

  const days = useMemo(() => getDaysBetween(dateRange.start, dateRange.end), [dateRange]);

  const shiftRange = (direction) => {
    const shift = rangeType === 'week' ? 7 : rangeType === '2weeks' ? 14 : 30;
    const newStart = new Date(dateRange.start);
    const newEnd = new Date(dateRange.end);
    newStart.setDate(newStart.getDate() + (direction * shift));
    newEnd.setDate(newEnd.getDate() + (direction * shift));
    setRangeType('custom');
    setCustomStart(formatDate(newStart));
    setCustomEnd(formatDate(newEnd));
  };

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (dateRange.start) params.append('start_date', dateRange.start.toISOString());
      if (dateRange.end) params.append('end_date', dateRange.end.toISOString());
      const res = await fetch(`${API}/gantt-data?${params}`, { credentials: 'include' });
      if (res.ok) {
        const data = await res.json();
        setBars(data.bars);
        setPending(data.pending);
        setTotalPiecesSystem(data.total_pieces_system || 0);
      }
    } catch (e) { toast.error(t('gantt_load_error')); }
    finally { setLoading(false); }
  }, [dateRange, t]);

  useEffect(() => { if (isOpen) fetchData(); }, [isOpen, fetchData]);

  const orderColorMap = useMemo(() => {
    const map = {};
    let idx = 0;
    bars.forEach(b => {
      if (!map[b.order_id]) { map[b.order_id] = ORDER_COLORS[idx % ORDER_COLORS.length]; idx++; }
    });
    return map;
  }, [bars]);

  const machineData = useMemo(() => {
    const result = {};
    MACHINES.forEach(m => { result[m] = []; });
    bars.forEach(bar => {
      if (result[bar.machine]) result[bar.machine].push(bar);
    });
    return result;
  }, [bars]);

  const getBarStyle = (bar) => {
    const barStart = new Date(bar.start_date);
    const barEnd = new Date(bar.end_date);
    const rangeStart = dateRange.start;
    const totalDays = days.length;
    if (totalDays === 0) return { display: 'none' };

    const startDay = Math.max(0, (barStart - rangeStart) / (1000*60*60*24));
    const endDay = Math.min(totalDays, (barEnd - rangeStart) / (1000*60*60*24) + 1);
    const left = (startDay / totalDays) * 100;
    const width = Math.max(((endDay - startDay) / totalDays) * 100, 2);

    return { left: `${left}%`, width: `${width}%` };
  };

  const today = formatDate(new Date());

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="max-w-[95vw] max-h-[90vh] bg-card border-border overflow-hidden flex flex-col" data-testid="gantt-modal">
        <DialogHeader>
          <DialogTitle className="font-barlow text-xl uppercase tracking-wide flex items-center gap-2">
            <Calendar className="w-5 h-5 text-primary" />
            {t('gantt_title')}
          </DialogTitle>
        </DialogHeader>

        {/* Controls */}
        <div className="flex items-center gap-3 pb-3 border-b border-border flex-wrap">
          <div className="flex items-center gap-1">
            <button onClick={() => shiftRange(-1)} className="p-1.5 rounded hover:bg-secondary" data-testid="gantt-prev"><ChevronLeft className="w-4 h-4" /></button>
            <Select value={rangeType} onValueChange={(v) => { setRangeType(v); setCustomStart(''); setCustomEnd(''); }}>
              <SelectTrigger className="w-32 h-8 text-xs bg-secondary border-border" data-testid="gantt-range-select">
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="bg-popover border-border z-[300]">
                <SelectItem value="week">{t('week')}</SelectItem>
                <SelectItem value="2weeks">{t('two_weeks')}</SelectItem>
                <SelectItem value="month">{t('month')}</SelectItem>
              </SelectContent>
            </Select>
            <button onClick={() => shiftRange(1)} className="p-1.5 rounded hover:bg-secondary" data-testid="gantt-next"><ChevronRight className="w-4 h-4" /></button>
          </div>

          <span className="text-xs text-muted-foreground">
            {dateRange.start.toLocaleDateString()} — {dateRange.end.toLocaleDateString()}
          </span>

          <button onClick={() => { setRangeType('month'); setCustomStart(''); setCustomEnd(''); }} className="text-xs text-primary hover:underline" data-testid="gantt-today-btn">{t('today')}</button>

          {/* Total pieces badge */}
          <div className="px-3 py-1 rounded-full bg-primary/10 border border-primary/20 text-xs font-bold text-primary" data-testid="gantt-total-pieces-system">
            {t('total_pieces_system')}: {totalPiecesSystem.toLocaleString()}
          </div>

          {/* Legend */}
          <div className="flex items-center gap-3 ml-auto text-xs text-muted-foreground">
            <span className="flex items-center gap-1"><span className="w-3 h-3 rounded bg-blue-500 opacity-90" /> {t('in_progress')}</span>
            <span className="flex items-center gap-1"><span className="w-3 h-3 rounded bg-green-500 opacity-90" /> {t('completed')}</span>
            <span className="flex items-center gap-1"><span className="w-3 h-3 rounded bg-muted-foreground/30 border border-dashed border-muted-foreground" /> {t('pending')} ({pending.length})</span>
          </div>
        </div>

        {/* Gantt Chart */}
        <div className="flex-1 overflow-auto" data-testid="gantt-chart">
          {loading ? (
            <div className="flex justify-center py-12"><Loader2 className="w-8 h-8 animate-spin" /></div>
          ) : (
            <div className="min-w-[800px]">
              {/* Day headers */}
              <div className="flex sticky top-0 z-10 bg-card">
                <div className="w-32 shrink-0 py-2 px-2 text-xs font-bold text-muted-foreground border-b border-r border-border">{t('machine')}</div>
                <div className="flex-1 flex border-b border-border">
                  {days.map((day, i) => {
                    const isToday = formatDate(day) === today;
                    const isWeekend = day.getDay() === 0 || day.getDay() === 6;
                    return (
                      <div
                        key={i}
                        className={`flex-1 text-center py-1 text-[10px] border-r border-border/30 ${isToday ? 'bg-primary/20 font-bold text-primary' : isWeekend ? 'bg-secondary/50 text-muted-foreground' : 'text-muted-foreground'}`}
                        style={{ minWidth: 28 }}
                      >
                        <div>{['D','L','M','X','J','V','S'][day.getDay()]}</div>
                        <div>{day.getDate()}</div>
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* Machine rows */}
              {MACHINES.map(machine => {
                const machineBars = machineData[machine] || [];
                return (
                  <div key={machine} className="flex border-b border-border/50 hover:bg-secondary/20" data-testid={`gantt-row-${machine}`}>
                    <div className="w-32 shrink-0 py-3 px-2 text-xs font-bold text-foreground border-r border-border flex items-center">
                      {machine}
                      {machineBars.length > 0 && <span className="ml-auto text-[10px] text-muted-foreground">{machineBars.length}</span>}
                    </div>
                    <div className="flex-1 relative" style={{ minHeight: 40 }}>
                      {/* Day grid */}
                      <div className="absolute inset-0 flex">
                        {days.map((day, i) => {
                          const isToday = formatDate(day) === today;
                          const isWeekend = day.getDay() === 0 || day.getDay() === 6;
                          return <div key={i} className={`flex-1 border-r border-border/10 ${isToday ? 'bg-primary/10' : isWeekend ? 'bg-secondary/30' : ''}`} style={{ minWidth: 28 }} />;
                        })}
                      </div>
                      {/* Bars */}
                      {machineBars.map((bar, idx) => {
                        const style = getBarStyle(bar);
                        const color = orderColorMap[bar.order_id] || '#6b7280';
                        const isComplete = bar.status === 'completed';
                        return (
                          <div
                            key={`${bar.order_id}-${idx}`}
                            className="absolute rounded-sm cursor-pointer transition-opacity hover:opacity-80 group"
                            style={{
                              ...style,
                              top: 4 + (idx * 14),
                              height: 12,
                              backgroundColor: isComplete ? '#22c55e' : color,
                              opacity: 0.85,
                              zIndex: 5
                            }}
                            title={`${bar.order_number} | ${bar.client} | ${bar.quantity_produced}/${bar.quantity_total} ${t('pieces')} | ${bar.log_count} ${t('records')}`}
                            data-testid={`gantt-bar-${bar.order_id}`}
                          >
                            <span className="absolute left-1 top-0 text-[9px] text-white font-bold truncate leading-3" style={{ maxWidth: 'calc(100% - 4px)' }}>
                              {bar.order_number}
                            </span>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Pending orders summary */}
        {pending.length > 0 && (
          <div className="border-t border-border pt-3 max-h-32 overflow-y-auto">
            <h4 className="text-xs font-bold uppercase text-muted-foreground mb-2 flex items-center gap-1">
              <Package className="w-3.5 h-3.5" /> {t('pending_orders')} ({pending.length})
            </h4>
            <div className="flex flex-wrap gap-2">
              {pending.slice(0, 20).map(p => (
                <span key={p.order_id} className="text-[11px] px-2 py-1 rounded bg-secondary border border-border" data-testid={`gantt-pending-${p.order_id}`}>
                  <strong>{p.order_number}</strong> — {p.remaining} {t('pieces')} {t('remaining_short')}
                </span>
              ))}
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
};

export default GanttView;
