import { useState, useEffect, useCallback, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import {
  Loader2, Search, Factory, Scissors, ArrowLeft, Download, ChevronLeft, ChevronRight,
  X, Trash2, ClipboardList, Filter,
} from "lucide-react";
import * as XLSX from "xlsx";
import { saveAs } from "file-saver";
import { API } from "../lib/constants";
import { useAuth } from "../App";

const PAGE_SIZE = 100;
const SHIFTS = ['', 'TURNO 1', 'TURNO 2'];
const MACHINES = ['', ...Array.from({ length: 14 }, (_, i) => `MAQUINA${i + 1}`)];

// Centralized log viewer — two tabs (Producción / Neck), shared filter bar,
// paginated table and Excel export. Replaces the per-order-only history that
// used to live inside ProductionModal / NeckCaptureModal.
const LogsCenter = () => {
  const navigate = useNavigate();
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin';

  const [tab, setTab] = useState('production'); // 'production' | 'neck'
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [operator, setOperator] = useState('');
  const [shift, setShift] = useState('');
  const [machine, setMachine] = useState(''); // production only
  const [orderNumber, setOrderNumber] = useState('');
  const [skip, setSkip] = useState(0);
  const [logs, setLogs] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [operatorsList, setOperatorsList] = useState([]);

  // Load operators list for the typeahead.
  useEffect(() => {
    fetch(`${API}/operators`, { credentials: 'include' })
      .then(r => r.ok ? r.json() : [])
      .then(data => setOperatorsList(data.filter(op => op.active)))
      .catch(() => {});
  }, []);

  // Reset pagination when filters or tab change.
  useEffect(() => { setSkip(0); }, [tab, dateFrom, dateTo, operator, shift, machine, orderNumber]);

  const fetchLogs = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (dateFrom) params.set('date_from', dateFrom);
      if (dateTo) params.set('date_to', dateTo);
      if (operator) params.set('operator', operator);
      if (shift) params.set('shift', shift);
      if (tab === 'production' && machine) params.set('machine', machine);
      if (orderNumber) params.set('order_number', orderNumber);
      params.set('skip', String(skip));
      params.set('limit', String(PAGE_SIZE));
      const endpoint = tab === 'production' ? '/production-logs' : '/neck-logs';
      const res = await fetch(`${API}${endpoint}?${params.toString()}`, { credentials: 'include' });
      if (res.ok) {
        const data = await res.json();
        setLogs(data.logs || []);
        setTotal(data.total || 0);
      } else {
        toast.error('Error al cargar registros');
      }
    } catch {
      toast.error('Error de conexión');
    } finally { setLoading(false); }
  }, [tab, dateFrom, dateTo, operator, shift, machine, orderNumber, skip]);

  useEffect(() => { fetchLogs(); }, [fetchLogs]);

  const clearFilters = () => {
    setDateFrom(''); setDateTo(''); setOperator(''); setShift('');
    setMachine(''); setOrderNumber('');
  };

  const handleDelete = async (logId) => {
    if (!isAdmin) return;
    if (!window.confirm('¿Eliminar este registro?')) return;
    const endpoint = tab === 'production' ? `/production-logs/${logId}` : `/neck-logs/${logId}`;
    try {
      const res = await fetch(`${API}${endpoint}`, { method: 'DELETE', credentials: 'include' });
      if (res.ok) { toast.success('Registro eliminado'); fetchLogs(); }
      else toast.error('Error al eliminar');
    } catch { toast.error('Error de conexión'); }
  };

  const handleExport = async () => {
    // Pull ALL matching rows (cap at 5,000) so the xlsx reflects the filter,
    // not just the current page.
    const params = new URLSearchParams();
    if (dateFrom) params.set('date_from', dateFrom);
    if (dateTo) params.set('date_to', dateTo);
    if (operator) params.set('operator', operator);
    if (shift) params.set('shift', shift);
    if (tab === 'production' && machine) params.set('machine', machine);
    if (orderNumber) params.set('order_number', orderNumber);
    params.set('skip', '0');
    params.set('limit', '1000');
    const endpoint = tab === 'production' ? '/production-logs' : '/neck-logs';

    try {
      const all = [];
      for (let off = 0; off < Math.min(total, 5000); off += 1000) {
        params.set('skip', String(off));
        const res = await fetch(`${API}${endpoint}?${params.toString()}`, { credentials: 'include' });
        if (!res.ok) throw new Error('export failed');
        const data = await res.json();
        all.push(...(data.logs || []));
      }
      const rows = all.map(l => {
        if (tab === 'production') {
          return {
            Fecha: new Date(l.created_at).toLocaleString(),
            Orden: l.order_number || '',
            Cliente: l.client || '',
            Operador: l.operator || l.user_name || '',
            Cantidad: l.quantity_produced || 0,
            Maquina: l.machine || '',
            Turno: l.shift || '',
            Diseno: l.design_type || '',
            Setup: l.setup || 0,
            'Causa Paro': l.stop_cause || '',
            Supervisor: l.supervisor || '',
          };
        }
        return {
          Fecha: new Date(l.created_at).toLocaleString(),
          Orden: l.order_number || '',
          Cliente: l.client || '',
          Operador: l.operator || l.user_name || '',
          Cantidad: l.quantity_neck_cut || 0,
          Turno: l.shift || '',
          Estacion: l.station || '',
        };
      });
      const ws = XLSX.utils.json_to_sheet(rows);
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, tab === 'production' ? 'Producción' : 'Neck');
      const buf = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
      const blob = new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
      const tag = tab === 'production' ? 'produccion' : 'neck';
      saveAs(blob, `registros_${tag}_${new Date().toISOString().split('T')[0]}.xlsx`);
      toast.success(`${rows.length} registros exportados`);
    } catch {
      toast.error('Error al exportar');
    }
  };

  const totalQty = useMemo(() => {
    const key = tab === 'production' ? 'quantity_produced' : 'quantity_neck_cut';
    return logs.reduce((s, l) => s + (Number(l[key]) || 0), 0);
  }, [logs, tab]);

  const page = Math.floor(skip / PAGE_SIZE) + 1;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const hasFilters = !!(dateFrom || dateTo || operator || shift || machine || orderNumber);

  return (
    <div className="min-h-screen bg-background text-foreground p-6">
      <div className="max-w-[1400px] mx-auto space-y-4">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <button
              onClick={() => navigate('/dashboard')}
              className="p-2 rounded-lg hover:bg-secondary/60 transition-all"
              title="Volver al tablero"
            >
              <ArrowLeft className="w-5 h-5" />
            </button>
            <div>
              <h1 className="text-2xl font-black uppercase tracking-tighter flex items-center gap-2">
                <ClipboardList className="w-6 h-6 text-primary" /> Registros
              </h1>
              <p className="text-xs text-muted-foreground font-bold uppercase tracking-widest opacity-60">
                Historial de capturas de producción y neck
              </p>
            </div>
          </div>
          <button
            onClick={handleExport}
            disabled={loading || logs.length === 0}
            className="flex items-center gap-2 px-4 py-2 bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg font-bold text-xs uppercase tracking-widest disabled:opacity-50 transition-all"
            data-testid="logs-export"
          >
            <Download className="w-4 h-4" /> Exportar
          </button>
        </div>

        {/* Tabs */}
        <div className="flex gap-2 p-1 bg-secondary/20 rounded-2xl w-fit border border-border/40">
          <button
            onClick={() => setTab('production')}
            className={`px-6 py-2 rounded-xl text-xs font-black uppercase tracking-widest transition-all flex items-center gap-2 ${tab === 'production' ? 'bg-emerald-500 text-white shadow-lg shadow-emerald-500/20' : 'text-muted-foreground hover:text-foreground hover:bg-secondary/40'}`}
            data-testid="logs-tab-production"
          >
            <Factory className="w-3.5 h-3.5" /> Producción
          </button>
          <button
            onClick={() => setTab('neck')}
            className={`px-6 py-2 rounded-xl text-xs font-black uppercase tracking-widest transition-all flex items-center gap-2 ${tab === 'neck' ? 'bg-pink-500 text-white shadow-lg shadow-pink-500/20' : 'text-muted-foreground hover:text-foreground hover:bg-secondary/40'}`}
            data-testid="logs-tab-neck"
          >
            <Scissors className="w-3.5 h-3.5" /> Neck
          </button>
        </div>

        {/* Filters */}
        <div className="p-4 bg-card/40 border border-border/40 rounded-2xl">
          <div className="flex items-center gap-2 mb-3">
            <Filter className="w-4 h-4 text-muted-foreground" />
            <span className="text-[10px] font-black uppercase tracking-widest text-muted-foreground">Filtros</span>
            {hasFilters && (
              <button onClick={clearFilters} className="ml-auto text-[10px] font-bold text-destructive hover:underline uppercase">
                Limpiar
              </button>
            )}
          </div>
          <div className={`grid grid-cols-2 ${tab === 'production' ? 'md:grid-cols-6' : 'md:grid-cols-5'} gap-3`}>
            <div>
              <label className="text-[10px] uppercase tracking-wider font-bold text-muted-foreground block mb-1">Desde</label>
              <input
                type="date"
                value={dateFrom}
                onChange={e => setDateFrom(e.target.value)}
                className="w-full h-8 px-2 text-xs bg-secondary border border-border rounded"
              />
            </div>
            <div>
              <label className="text-[10px] uppercase tracking-wider font-bold text-muted-foreground block mb-1">Hasta</label>
              <input
                type="date"
                value={dateTo}
                onChange={e => setDateTo(e.target.value)}
                className="w-full h-8 px-2 text-xs bg-secondary border border-border rounded"
              />
            </div>
            <div>
              <label className="text-[10px] uppercase tracking-wider font-bold text-muted-foreground block mb-1">Orden</label>
              <input
                type="text"
                value={orderNumber}
                onChange={e => setOrderNumber(e.target.value)}
                placeholder="Ej. 1620"
                className="w-full h-8 px-2 text-xs bg-secondary border border-border rounded"
              />
            </div>
            <div>
              <label className="text-[10px] uppercase tracking-wider font-bold text-muted-foreground block mb-1">Operador</label>
              {operatorsList.length > 0 ? (
                <select
                  value={operator}
                  onChange={e => setOperator(e.target.value)}
                  className="w-full h-8 px-2 text-xs bg-secondary border border-border rounded"
                >
                  <option value="">Todos</option>
                  {operatorsList.map(op => <option key={op.operator_id} value={op.name}>{op.name}</option>)}
                </select>
              ) : (
                <input
                  type="text"
                  value={operator}
                  onChange={e => setOperator(e.target.value)}
                  placeholder="Nombre"
                  className="w-full h-8 px-2 text-xs bg-secondary border border-border rounded"
                />
              )}
            </div>
            <div>
              <label className="text-[10px] uppercase tracking-wider font-bold text-muted-foreground block mb-1">Turno</label>
              <select
                value={shift}
                onChange={e => setShift(e.target.value)}
                className="w-full h-8 px-2 text-xs bg-secondary border border-border rounded"
              >
                {SHIFTS.map(s => <option key={s} value={s}>{s || 'Todos'}</option>)}
              </select>
            </div>
            {tab === 'production' && (
              <div>
                <label className="text-[10px] uppercase tracking-wider font-bold text-muted-foreground block mb-1">Máquina</label>
                <select
                  value={machine}
                  onChange={e => setMachine(e.target.value)}
                  className="w-full h-8 px-2 text-xs bg-secondary border border-border rounded"
                >
                  {MACHINES.map(m => <option key={m} value={m}>{m || 'Todas'}</option>)}
                </select>
              </div>
            )}
          </div>
        </div>

        {/* Summary chip */}
        <div className="flex items-center gap-3 text-[11px] font-mono font-bold text-muted-foreground">
          <span>{total.toLocaleString()} registros</span>
          <span className="opacity-30">·</span>
          <span>{totalQty.toLocaleString()} pz (esta página)</span>
        </div>

        {/* Table */}
        <div className="border border-border/40 rounded-2xl bg-card/40 overflow-hidden">
          <div className="overflow-x-auto max-h-[60vh]">
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-secondary/80 backdrop-blur-md border-b border-border/40">
                <tr>
                  <th className="p-3 text-left text-[10px] font-black uppercase tracking-widest text-muted-foreground">Fecha</th>
                  <th className="p-3 text-left text-[10px] font-black uppercase tracking-widest text-muted-foreground">Orden</th>
                  <th className="p-3 text-left text-[10px] font-black uppercase tracking-widest text-muted-foreground">Cliente</th>
                  <th className="p-3 text-left text-[10px] font-black uppercase tracking-widest text-muted-foreground">Operador</th>
                  <th className="p-3 text-right text-[10px] font-black uppercase tracking-widest text-muted-foreground">Cant.</th>
                  {tab === 'production' && <th className="p-3 text-left text-[10px] font-black uppercase tracking-widest text-muted-foreground">Máquina</th>}
                  <th className="p-3 text-left text-[10px] font-black uppercase tracking-widest text-muted-foreground">Turno</th>
                  {tab === 'production' && <th className="p-3 text-left text-[10px] font-black uppercase tracking-widest text-muted-foreground">Diseño</th>}
                  {tab === 'production' && <th className="p-3 text-right text-[10px] font-black uppercase tracking-widest text-muted-foreground">Setup</th>}
                  {isAdmin && <th className="p-3 w-10"></th>}
                </tr>
              </thead>
              <tbody>
                {loading ? (
                  <tr><td colSpan={tab === 'production' ? 10 : 7} className="py-16 text-center">
                    <Loader2 className="w-6 h-6 animate-spin mx-auto" />
                  </td></tr>
                ) : logs.length === 0 ? (
                  <tr><td colSpan={tab === 'production' ? 10 : 7} className="py-20 text-center">
                    {tab === 'production'
                      ? <Factory className="w-12 h-12 mx-auto opacity-20 mb-2 text-emerald-500" />
                      : <Scissors className="w-12 h-12 mx-auto opacity-20 mb-2 text-pink-500" />}
                    <p className="text-sm font-bold uppercase tracking-widest text-muted-foreground">
                      Sin registros {hasFilters ? 'con esos filtros' : ''}
                    </p>
                  </td></tr>
                ) : (
                  logs.map(log => (
                    <tr key={log.log_id} className="border-b border-border/10 hover:bg-primary/5">
                      <td className="p-3 font-mono text-[11px] text-muted-foreground whitespace-nowrap">
                        {new Date(log.created_at).toLocaleString()}
                      </td>
                      <td className="p-3 font-mono font-bold text-primary text-[11px]">{log.order_number || '—'}</td>
                      <td className="p-3 text-[11px] font-bold truncate max-w-[180px]" title={log.client}>
                        {log.client || '—'}
                      </td>
                      <td className="p-3 text-[11px] text-foreground">{log.operator || log.user_name || '—'}</td>
                      <td className={`p-3 text-right font-mono font-black ${tab === 'production' ? 'text-emerald-500' : 'text-pink-500'}`}>
                        {tab === 'production' ? log.quantity_produced : log.quantity_neck_cut}
                      </td>
                      {tab === 'production' && (
                        <td className="p-3 text-[11px]">
                          <span className="px-1.5 py-0.5 bg-primary/20 text-primary rounded text-[9px] font-bold font-mono">
                            {log.machine || '—'}
                          </span>
                        </td>
                      )}
                      <td className="p-3 text-[11px] text-muted-foreground">{log.shift || '—'}</td>
                      {tab === 'production' && (
                        <td className="p-3 text-[11px] text-muted-foreground">{log.design_type || '—'}</td>
                      )}
                      {tab === 'production' && (
                        <td className="p-3 text-[11px] text-right text-muted-foreground">{log.setup || 0}</td>
                      )}
                      {isAdmin && (
                        <td className="p-3">
                          <button
                            onClick={() => handleDelete(log.log_id)}
                            className="p-1 rounded hover:bg-destructive/20"
                            title="Eliminar"
                          >
                            <Trash2 className="w-3.5 h-3.5 text-destructive" />
                          </button>
                        </td>
                      )}
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>

        {/* Pagination */}
        {total > PAGE_SIZE && (
          <div className="flex items-center justify-between text-[11px] font-bold uppercase tracking-widest text-muted-foreground">
            <div>Página {page} de {totalPages}</div>
            <div className="flex gap-2">
              <button
                onClick={() => setSkip(Math.max(0, skip - PAGE_SIZE))}
                disabled={skip === 0 || loading}
                className="px-3 py-1.5 bg-secondary border border-border rounded-lg hover:bg-secondary/60 disabled:opacity-40 flex items-center gap-1"
              >
                <ChevronLeft className="w-3.5 h-3.5" /> Anterior
              </button>
              <button
                onClick={() => setSkip(skip + PAGE_SIZE)}
                disabled={skip + PAGE_SIZE >= total || loading}
                className="px-3 py-1.5 bg-secondary border border-border rounded-lg hover:bg-secondary/60 disabled:opacity-40 flex items-center gap-1"
              >
                Siguiente <ChevronRight className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default LogsCenter;
